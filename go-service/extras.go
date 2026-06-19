package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// queryMaps runs a query and returns rows as []map keyed by column name,
// which lets us mirror the Node "SELECT *" JSON shapes exactly.
func queryMaps(q string, args ...any) ([]map[string]any, error) {
	rows, err := db.qu(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, c := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
			} else {
				m[c] = vals[i]
			}
		}
		out = append(out, m)
	}
	return out, nil
}

func body(r *http.Request) map[string]any {
	m := map[string]any{}
	json.NewDecoder(r.Body).Decode(&m)
	return m
}
func bstr(m map[string]any, k string) string {
	if v, ok := m[k]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprintf("%v", v))
	}
	return ""
}
func ok200(w http.ResponseWriter) { writeJSON(w, 200, map[string]any{"success": true}) }

// extrasRouter handles everything beyond the core; returns true if it handled it.
func extrasRouter(w http.ResponseWriter, r *http.Request, p, m string, seg []string) bool {
	switch {
	case p == "/api/public/vehicle-classes" && m == "GET":
		l, _ := queryMaps("SELECT id, name, description FROM vehicle_classes ORDER BY name")
		writeJSON(w, 200, map[string]any{"classes": l})
	case p == "/api/public/load-types" && m == "GET":
		l, _ := queryMaps("SELECT id, name, description FROM load_types ORDER BY name")
		writeJSON(w, 200, map[string]any{"types": l})

	case p == "/api/manager/vehicle-classes":
		refList(w, r, "vehicle_classes", "classes", "SELECT * FROM vehicle_classes ORDER BY name", nameDescCreate("vehicle_classes"))
	case strings.HasPrefix(p, "/api/manager/vehicle-classes/"):
		refUpdDel(w, r, "vehicle_classes", seg[len(seg)-1], []string{"name", "description"})
	case p == "/api/manager/load-types":
		refList(w, r, "load_types", "types", "SELECT * FROM load_types ORDER BY name", nameDescCreate("load_types"))
	case strings.HasPrefix(p, "/api/manager/load-types/"):
		refUpdDel(w, r, "load_types", seg[len(seg)-1], []string{"name", "description"})
	case p == "/api/manager/categories":
		refList(w, r, "categories", "categories", "SELECT * FROM categories ORDER BY name", func(w http.ResponseWriter, r *http.Request) {
			n := bstr(body(r), "name")
			if n == "" {
				writeJSON(w, 400, map[string]any{"error": "Name is required"})
				return
			}
			db.ex("INSERT INTO categories (name) VALUES (?)", n)
			ok200(w)
		})
	case strings.HasPrefix(p, "/api/manager/categories/") && m == "DELETE":
		db.ex("DELETE FROM categories WHERE id=?", seg[len(seg)-1])
		ok200(w)
	case p == "/api/manager/counterparties":
		refList(w, r, "counterparties", "counterparties", "SELECT * FROM counterparties ORDER BY name", func(w http.ResponseWriter, r *http.Request) {
			b := body(r)
			n := bstr(b, "name")
			if n == "" {
				writeJSON(w, 400, map[string]any{"error": "Название обязательно"})
				return
			}
			db.ex("INSERT INTO counterparties (name, phone, inn, kpp, comment) VALUES (?, ?, ?, ?, ?)", n, bstr(b, "phone"), bstr(b, "inn"), bstr(b, "kpp"), bstr(b, "comment"))
			ok200(w)
		})
	case strings.HasPrefix(p, "/api/manager/counterparties/"):
		refUpdDel(w, r, "counterparties", seg[len(seg)-1], []string{"name", "phone", "inn", "kpp", "comment"})
	case p == "/api/manager/storekeepers":
		hStorekeepers(w, r)
	case strings.HasPrefix(p, "/api/manager/storekeepers/"):
		hStorekeeperUpdDel(w, r, seg[len(seg)-1])
	case p == "/api/manager/networks":
		refList(w, r, "allowed_networks", "networks", "SELECT * FROM allowed_networks ORDER BY id", func(w http.ResponseWriter, r *http.Request) {
			b := body(r)
			n := bstr(b, "network")
			if n == "" {
				writeJSON(w, 400, map[string]any{"error": "Network is required"})
				return
			}
			db.ex("INSERT INTO allowed_networks (network, description) VALUES (?, ?)", n, bstr(b, "description"))
			ok200(w)
		})
	case strings.HasPrefix(p, "/api/manager/networks/") && m == "DELETE":
		db.ex("DELETE FROM allowed_networks WHERE id=?", seg[len(seg)-1])
		ok200(w)
	case p == "/api/manager/banned-phones":
		refList(w, r, "banned_phones", "phones", "SELECT * FROM banned_phones ORDER BY created_at DESC", func(w http.ResponseWriter, r *http.Request) {
			b := body(r)
			n := bstr(b, "phone")
			if n == "" {
				writeJSON(w, 400, map[string]any{"error": "Phone is required"})
				return
			}
			db.ex("INSERT INTO banned_phones (phone, reason, created_at) VALUES (?, ?, ?)", n, bstr(b, "reason"), nowTS())
			ok200(w)
		})
	case strings.HasPrefix(p, "/api/manager/banned-phones/") && m == "DELETE":
		db.ex("DELETE FROM banned_phones WHERE id=?", seg[len(seg)-1])
		ok200(w)
	case p == "/api/manager/banned-ips":
		refList(w, r, "banned_ips", "ips", "SELECT * FROM banned_ips ORDER BY created_at DESC", func(w http.ResponseWriter, r *http.Request) {
			b := body(r)
			n := bstr(b, "ip")
			if n == "" {
				writeJSON(w, 400, map[string]any{"error": "IP is required"})
				return
			}
			db.ex("INSERT INTO banned_ips (ip, reason, created_at) VALUES (?, ?, ?)", n, bstr(b, "reason"), nowTS())
			ok200(w)
		})
	case strings.HasPrefix(p, "/api/manager/banned-ips/") && m == "DELETE":
		db.ex("DELETE FROM banned_ips WHERE id=?", seg[len(seg)-1])
		ok200(w)

	// ---- analytics ----
	case p == "/api/manager/stats/timeseries" && m == "GET":
		hTimeseries(w, r)
	case p == "/api/manager/stats/devices" && m == "GET":
		hDevices(w, r)

	// ---- backups ----
	case p == "/api/manager/backup" && m == "GET":
		hBackup(w, r)
	case p == "/api/manager/restore" && m == "POST":
		hRestore(w, r)
	case p == "/api/manager/backups" && m == "GET":
		hBackupsList(w, r)
	case p == "/api/manager/backups/run" && m == "POST":
		if _, ok := requireAdmin(w, r); ok {
			n, err := writeAutoBackup()
			if err != nil {
				writeJSON(w, 500, map[string]any{"error": err.Error()})
			} else {
				writeJSON(w, 200, map[string]any{"success": true, "name": n})
			}
		}
	case strings.HasPrefix(p, "/api/manager/backups/") && strings.HasSuffix(p, "/restore") && m == "POST":
		hBackupRestoreByName(w, r, seg[len(seg)-2])
	case strings.HasPrefix(p, "/api/manager/backups/") && m == "GET":
		hBackupDownload(w, r, seg[len(seg)-1])

	// ---- update ----
	case p == "/api/manager/check-update" && m == "GET":
		hCheckUpdate(w, r)
	case p == "/api/manager/update" && m == "POST":
		hUpdate(w, r)

	// ---- storekeeper ----
	case p == "/api/storekeeper/slots" && m == "GET":
		hStorekeeperSlots(w, r)
	case len(seg) == 5 && seg[1] == "storekeeper" && seg[2] == "slots" && m == "POST":
		hStorekeeperAction(w, r, seg[3], seg[4])

	default:
		return extras2Router(w, r, p, m, seg)
	}
	return true
}

// ---- generic reference helpers ----

func refList(w http.ResponseWriter, r *http.Request, table, key, listSQL string, create func(http.ResponseWriter, *http.Request)) {
	if r.Method == "GET" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		l, err := queryMaps(listSQL)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{key: l})
		return
	}
	if r.Method == "POST" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		create(w, r)
		return
	}
	writeJSON(w, 405, map[string]any{"error": "method not allowed"})
}

func nameDescCreate(table string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		b := body(r)
		n := bstr(b, "name")
		if n == "" {
			writeJSON(w, 400, map[string]any{"error": "Name is required"})
			return
		}
		db.ex("INSERT INTO "+table+" (name, description) VALUES (?, ?)", n, bstr(b, "description"))
		ok200(w)
	}
}

func refUpdDel(w http.ResponseWriter, r *http.Request, table, id string, cols []string) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	switch r.Method {
	case "PUT":
		b := body(r)
		sets := []string{}
		args := []any{}
		for _, c := range cols {
			sets = append(sets, c+"=?")
			args = append(args, bstr(b, camel(c)))
		}
		args = append(args, id)
		db.ex("UPDATE "+table+" SET "+strings.Join(sets, ", ")+" WHERE id=?", args...)
		ok200(w)
	case "DELETE":
		db.ex("DELETE FROM "+table+" WHERE id=?", id)
		ok200(w)
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

// camel maps a snake_case column to the JSON body key used by the frontend.
func camel(c string) string { return c } // frontend sends name/phone/inn/kpp/comment/description as-is

// ---- storekeepers ----

func hStorekeepers(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		l, _ := queryMaps("SELECT id, name, phone, created_at, CASE WHEN pin_code IS NOT NULL AND pin_code <> '' THEN 1 ELSE 0 END AS has_pin FROM storekeepers ORDER BY id")
		writeJSON(w, 200, map[string]any{"storekeepers": l})
		return
	}
	if r.Method == "POST" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		b := body(r)
		n := bstr(b, "name")
		if n == "" {
			writeJSON(w, 400, map[string]any{"error": "Name is required"})
			return
		}
		db.ex("INSERT INTO storekeepers (name, phone, pin_code, created_at) VALUES (?, ?, ?, ?)", n, bstr(b, "phone"), bstr(b, "pinCode"), nowTS())
		ok200(w)
	}
}

func hStorekeeperUpdDel(w http.ResponseWriter, r *http.Request, id string) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	switch r.Method {
	case "PUT":
		b := body(r)
		pin := bstr(b, "pinCode")
		if pin != "" {
			db.ex("UPDATE storekeepers SET name=?, phone=?, pin_code=? WHERE id=?", bstr(b, "name"), bstr(b, "phone"), pin, id)
		} else {
			db.ex("UPDATE storekeepers SET name=?, phone=? WHERE id=?", bstr(b, "name"), bstr(b, "phone"), id)
		}
		ok200(w)
	case "DELETE":
		db.ex("DELETE FROM storekeepers WHERE id=?", id)
		ok200(w)
	}
}

// ---- analytics ----

func parseTS(s string) (time.Time, bool) {
	for _, l := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	if t, err := time.Parse("2006-01-02 15:04:05", strings.Replace(s, "T", " ", 1)); err == nil {
		return t, true
	}
	return time.Time{}, false
}

type bucket struct {
	start, end time.Time
	label      string
	count      int
}

func makeBuckets(interval string) []bucket {
	now := time.Now()
	pad := func(n int) string { return fmt.Sprintf("%02d", n) }
	b := []bucket{}
	add := func(s, e time.Time, label string) { b = append(b, bucket{s, e, label, 0}) }
	switch interval {
	case "minute":
		base := now.Truncate(time.Minute)
		for i := 59; i >= 0; i-- {
			s := base.Add(time.Duration(-i) * time.Minute)
			add(s, s.Add(time.Minute), pad(s.Hour())+":"+pad(s.Minute()))
		}
	case "hour":
		base := now.Truncate(time.Hour)
		for i := 23; i >= 0; i-- {
			s := base.Add(time.Duration(-i) * time.Hour)
			add(s, s.Add(time.Hour), pad(s.Hour())+":00")
		}
	case "week":
		base := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		off := (int(base.Weekday()) + 6) % 7
		base = base.AddDate(0, 0, -off)
		for i := 11; i >= 0; i-- {
			s := base.AddDate(0, 0, -i*7)
			add(s, s.AddDate(0, 0, 7), pad(s.Day())+"."+pad(int(s.Month())))
		}
	case "year":
		for i := 5; i >= 0; i-- {
			s := time.Date(now.Year()-i, 1, 1, 0, 0, 0, 0, now.Location())
			add(s, s.AddDate(1, 0, 0), strconv.Itoa(now.Year()-i))
		}
	default: // day
		base := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		for i := 29; i >= 0; i-- {
			s := base.AddDate(0, 0, -i)
			add(s, s.AddDate(0, 0, 1), pad(s.Day())+"."+pad(int(s.Month())))
		}
	}
	return b
}

func hTimeseries(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	interval := r.URL.Query().Get("interval")
	metric := r.URL.Query().Get("metric")
	bs := makeBuckets(interval)
	var stamps []string
	if metric == "bookings" {
		rows, _ := queryMaps("SELECT booked_at FROM slots WHERE booked_at IS NOT NULL")
		for _, m := range rows {
			if v, ok := m["booked_at"]; ok && v != nil {
				stamps = append(stamps, fmt.Sprintf("%v", v))
			}
		}
	} else {
		rows, _ := queryMaps("SELECT visited_at FROM page_visits")
		for _, m := range rows {
			if v, ok := m["visited_at"]; ok && v != nil {
				stamps = append(stamps, fmt.Sprintf("%v", v))
			}
		}
	}
	if len(bs) > 0 {
		first, last := bs[0].start, bs[len(bs)-1].end
		for _, s := range stamps {
			t, okk := parseTS(s)
			if !okk || t.Before(first) || !t.Before(last) {
				continue
			}
			for i := range bs {
				if !t.Before(bs[i].start) && t.Before(bs[i].end) {
					bs[i].count++
					break
				}
			}
		}
	}
	labels := []string{}
	counts := []int{}
	for _, x := range bs {
		labels = append(labels, x.label)
		counts = append(counts, x.count)
	}
	writeJSON(w, 200, map[string]any{"interval": interval, "metric": metric, "labels": labels, "counts": counts})
}

func hDevices(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	cat := map[string]int{"desktop": 0, "mobile": 0, "tablet": 0, "other": 0}
	rows, _ := queryMaps("SELECT device, COUNT(*) AS cnt FROM page_visits GROUP BY device")
	for _, m := range rows {
		k := fmt.Sprintf("%v", m["device"])
		c := toInt(m["cnt"])
		if k == "desktop" || k == "mobile" || k == "tablet" {
			cat[k] += c
		} else {
			cat["other"] += c
		}
	}
	group := func(col string) []map[string]any {
		acc := map[string]int{}
		rs, _ := queryMaps("SELECT " + col + " AS k, COUNT(*) AS cnt FROM page_visits GROUP BY " + col)
		for _, m := range rs {
			name := strings.TrimSpace(fmt.Sprintf("%v", m["k"]))
			if name == "" || name == "<nil>" {
				name = "Прочее"
			}
			acc[name] += toInt(m["cnt"])
		}
		list := []map[string]any{}
		for k, v := range acc {
			list = append(list, map[string]any{"name": k, "count": v})
		}
		sort.Slice(list, func(i, j int) bool { return list[i]["count"].(int) > list[j]["count"].(int) })
		return list
	}
	total := cat["desktop"] + cat["mobile"] + cat["tablet"] + cat["other"]
	writeJSON(w, 200, map[string]any{"total": total, "categories": cat, "os": group("os"), "browser": group("browser")})
}

func toInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case int:
		return x
	case float64:
		return int(x)
	case []byte:
		n, _ := strconv.Atoi(string(x))
		return n
	case string:
		n, _ := strconv.Atoi(x)
		return n
	}
	return 0
}

// ---- backups ----

var allTables = []string{
	"warehouses", "slots", "managers", "settings", "page_visits", "storekeepers",
	"vehicle_classes", "load_types", "categories", "counterparties",
	"allowed_networks", "banned_phones", "banned_ips", "user_logs",
}

func buildBackup() map[string]any {
	tables := map[string]any{}
	for _, t := range allTables {
		rows, err := queryMaps("SELECT * FROM " + t)
		if err == nil {
			tables[t] = rows
		}
	}
	return map[string]any{"app": "warehouse-queue-go", "createdAt": time.Now().Format(time.RFC3339), "dbType": db.backend, "tables": tables}
}

func restoreFromDump(dump map[string]any) (int, error) {
	tablesAny, ok := dump["tables"].(map[string]any)
	if !ok {
		return 0, fmt.Errorf("Некорректный файл резервной копии")
	}
	count := 0
	for _, t := range allTables {
		rowsAny, ok := tablesAny[t].([]any)
		if !ok {
			continue
		}
		db.ex("DELETE FROM " + t)
		for _, rAny := range rowsAny {
			row, ok := rAny.(map[string]any)
			if !ok {
				continue
			}
			cols := []string{}
			ph := []string{}
			args := []any{}
			for k, v := range row {
				cols = append(cols, k)
				ph = append(ph, "?")
				args = append(args, v)
			}
			if len(cols) == 0 {
				continue
			}
			db.ex("INSERT INTO "+t+" ("+strings.Join(cols, ",")+") VALUES ("+strings.Join(ph, ",")+")", args...)
			count++
		}
	}
	return count, nil
}

func hBackup(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	dump := buildBackup()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\"warehouse-backup-"+time.Now().Format("2006-01-02-15-04-05")+".json\"")
	json.NewEncoder(w).Encode(dump)
}

func hRestore(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var dump map[string]any
	if err := json.NewDecoder(r.Body).Decode(&dump); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad json"})
		return
	}
	n, err := restoreFromDump(dump)
	if err != nil {
		writeJSON(w, 400, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "rows": n})
}

func backupDir() string {
	d := env("BACKUP_DIR", "backups")
	os.MkdirAll(d, 0o755)
	return d
}

func writeAutoBackup() (string, error) {
	d := backupDir()
	name := "autobackup-" + time.Now().Format("2006-01-02-15-04-05") + ".json"
	data, _ := json.Marshal(buildBackup())
	if err := os.WriteFile(filepath.Join(d, name), data, 0o644); err != nil {
		return "", err
	}
	pruneBackups()
	return name, nil
}

func pruneBackups() {
	keep := toInt(db.getSetting("autobackup_keep", "24"))
	if keep <= 0 {
		keep = 24
	}
	d := backupDir()
	entries, _ := os.ReadDir(d)
	files := []os.DirEntry{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "autobackup-") && strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() > files[j].Name() })
	for i := keep; i < len(files); i++ {
		os.Remove(filepath.Join(d, files[i].Name()))
	}
}

func hBackupsList(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	d := backupDir()
	entries, _ := os.ReadDir(d)
	list := []map[string]any{}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "autobackup-") || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, map[string]any{"name": e.Name(), "sizeKb": int(info.Size() / 1024), "createdAt": info.ModTime().Format(time.RFC3339)})
	}
	sort.Slice(list, func(i, j int) bool { return list[i]["name"].(string) > list[j]["name"].(string) })
	writeJSON(w, 200, map[string]any{"backups": list})
}

func safeName(n string) bool {
	return n != "" && !strings.Contains(n, "..") && !strings.Contains(n, "/") && strings.HasSuffix(n, ".json")
}

func hBackupDownload(w http.ResponseWriter, r *http.Request, name string) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	if !safeName(name) {
		writeJSON(w, 400, map[string]any{"error": "bad name"})
		return
	}
	http.ServeFile(w, r, filepath.Join(backupDir(), name))
}

func hBackupRestoreByName(w http.ResponseWriter, r *http.Request, name string) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	if !safeName(name) {
		writeJSON(w, 400, map[string]any{"error": "bad name"})
		return
	}
	data, err := os.ReadFile(filepath.Join(backupDir(), name))
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	var dump map[string]any
	json.Unmarshal(data, &dump)
	n, err := restoreFromDump(dump)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "rows": n})
}

// autobackupLoop is started from main as a goroutine.
func autobackupLoop() {
	var last time.Time
	for {
		time.Sleep(time.Minute)
		iv := toInt(db.getSetting("autobackup_interval", "0"))
		if iv <= 0 {
			continue
		}
		if time.Since(last) >= time.Duration(iv)*time.Second {
			if _, err := writeAutoBackup(); err == nil {
				last = time.Now()
			}
		}
	}
}

// ---- update via git ----

func gitOut(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func hCheckUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	cur, err := gitOut("rev-parse", "HEAD")
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "не git-репозиторий"})
		return
	}
	branch, _ := gitOut("rev-parse", "--abbrev-ref", "HEAD")
	if branch == "" {
		branch = "main"
	}
	ls, err := gitOut("ls-remote", "origin", branch)
	latest := ""
	if err == nil {
		latest = strings.Fields(ls)[0]
	}
	writeJSON(w, 200, map[string]any{"ok": true, "branch": branch, "current": cur, "latest": latest, "upToDate": latest != "" && cur == latest, "updateAvailable": latest != "" && cur != latest})
}

func hUpdate(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	before, err := gitOut("rev-parse", "HEAD")
	if err != nil {
		writeJSON(w, 200, map[string]any{"success": false, "error": "не git-репозиторий"})
		return
	}
	branch, _ := gitOut("rev-parse", "--abbrev-ref", "HEAD")
	if branch == "" {
		branch = "main"
	}
	gitOut("pull", "--ff-only", "origin", branch)
	after, _ := gitOut("rev-parse", "HEAD")
	if before == after {
		writeJSON(w, 200, map[string]any{"success": true, "updated": false, "message": "Уже последняя версия"})
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "updated": true, "from": before, "to": after, "restarting": true})
	go func() { time.Sleep(800 * time.Millisecond); os.Exit(0) }()
}

// ---- storekeeper ----

func hStorekeeperSlots(w http.ResponseWriter, r *http.Request) {
	l, _ := queryMaps("SELECT s.id,s.date,s.time_start,s.time_end,s.type,s.customer_name,s.customer_phone,s.customer_account,s.customer_organization,s.in_progress,s.assembling,s.completed,s.customer_comment,s.storekeeper_name,w.name AS warehouse_name FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE (s.in_progress=1 OR s.assembling=1 OR s.completed=1) ORDER BY s.date DESC, s.time_start")
	active := []map[string]any{}
	done := []map[string]any{}
	for _, m := range l {
		if toInt(m["completed"]) == 1 {
			done = append(done, m)
		} else {
			active = append(active, m)
		}
	}
	writeJSON(w, 200, map[string]any{"active": active, "completed": done})
}

func hStorekeeperAction(w http.ResponseWriter, r *http.Request, idStr, action string) {
	b := body(r)
	pin := bstr(b, "pinCode")
	var skName string
	if err := db.row("SELECT name FROM storekeepers WHERE pin_code=?", pin).Scan(&skName); err != nil || pin == "" {
		writeJSON(w, 403, map[string]any{"error": "Неверный PIN"})
		return
	}
	id, _ := strconv.Atoi(idStr)
	switch action {
	case "assemble":
		db.ex("UPDATE slots SET assembling=1, assembling_at=?, storekeeper_name=? WHERE id=?", nowTS(), skName, id)
	case "complete":
		db.ex("UPDATE slots SET completed=1, completed_at=?, storekeeper_name=? WHERE id=?", nowTS(), skName, id)
	default:
		writeJSON(w, 400, map[string]any{"error": "unknown action"})
		return
	}
	ok200(w)
}

// ---- SMS (sms.ru) ----

func sendSMS(phone, msg string) {
	apiKey := db.getSetting("smsru_api_key", os.Getenv("SMSRU_API_KEY"))
	if apiKey == "" || phone == "" {
		return
	}
	u := "https://sms.ru/sms/send?api_id=" + url.QueryEscape(apiKey) + "&to=" + url.QueryEscape(phone) + "&msg=" + url.QueryEscape(msg) + "&json=1"
	go func() {
		client := &http.Client{Timeout: 10 * time.Second}
		resp, err := client.Get(u)
		if err == nil {
			resp.Body.Close()
		}
	}()
}
