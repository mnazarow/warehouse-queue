package main

import (
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	mrand "math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	db        *DB
	startTime = time.Now()
	staticDir = env("STATIC_DIR", "../public")
)

// ---- sessions (in-memory) -------------------------------------------------

type session struct {
	managerID int
	captcha   int
	hasCap    bool
}

var (
	sessions = map[string]*session{}
	sessMu   sync.Mutex
)

func newToken() string {
	b := make([]byte, 24)
	crand.Read(b)
	return hex.EncodeToString(b)
}

func getSession(w http.ResponseWriter, r *http.Request) *session {
	if c, err := r.Cookie("wq_sess"); err == nil {
		sessMu.Lock()
		s := sessions[c.Value]
		sessMu.Unlock()
		if s != nil {
			return s
		}
	}
	tok := newToken()
	s := &session{}
	sessMu.Lock()
	sessions[tok] = s
	sessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "wq_sess", Value: tok, Path: "/", HttpOnly: true, MaxAge: 86400, SameSite: http.SameSiteLaxMode})
	return s
}

// ---- helpers --------------------------------------------------------------

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func sha256hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func getIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	return host
}

func needsIPGate(p string) bool {
	return p == "/manager.html" || strings.HasPrefix(p, "/api/manager") || p == "/storekeeper" || strings.HasPrefix(p, "/api/storekeeper")
}

func allowedIP(r *http.Request) bool {
	ip := getIP(r)
	if ip == "" || ip == "127.0.0.1" || ip == "::1" {
		return true
	}
	rows, _ := queryMaps("SELECT network FROM allowed_networks")
	if len(rows) == 0 {
		return true
	}
	for _, m := range rows {
		if ipMatch(ip, fmt.Sprintf("%v", m["network"])) {
			return true
		}
	}
	return false
}

func ipMatch(ip, network string) bool {
	if strings.Contains(network, "/") {
		_, cidr, err := net.ParseCIDR(network)
		if err != nil {
			return false
		}
		pip := net.ParseIP(ip)
		return pip != nil && cidr.Contains(pip)
	}
	return ip == network
}

func isAdmin(managerID int) bool {
	if managerID == 0 {
		return false
	}
	var a int
	db.row("SELECT is_admin FROM managers WHERE id = ?", managerID).Scan(&a)
	return a == 1
}

// ---- slot generation ------------------------------------------------------

type slotTime struct{ start, end string }

func genSlots(typ string) []slotTime {
	dur := 15
	if typ == "bulk" {
		dur = 30
	}
	out := []slotTime{}
	for m := 10 * 60; m < 17*60+30; m += dur {
		e := m + dur
		out = append(out, slotTime{
			fmt.Sprintf("%02d:%02d", m/60, m%60),
			fmt.Sprintf("%02d:%02d", e/60, e%60),
		})
	}
	return out
}

func isWeekday(date string) bool {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return false
	}
	wd := t.Weekday()
	return wd >= time.Monday && wd <= time.Friday
}

func worksOnWeekends() bool { return db.getSetting("work_on_weekends", "0") == "1" }

// ensureSlots fills the canonical set of time-slots for a date/type for every
// warehouse (and the legacy null warehouse). Idempotent.
func ensureSlots(date, typ string) {
	want := genSlots(typ)
	var whIDs []any
	rows, err := db.qu("SELECT id FROM warehouses")
	if err == nil {
		for rows.Next() {
			var id int
			rows.Scan(&id)
			whIDs = append(whIDs, id)
		}
		rows.Close()
	}
	targets := append([]any{}, whIDs...)
	targets = append(targets, nil) // legacy null warehouse

	for _, wh := range targets {
		existing := map[string]bool{}
		var q string
		var args []any
		if wh == nil {
			q = "SELECT time_start FROM slots WHERE date = ? AND type = ? AND warehouse_id IS NULL"
			args = []any{date, typ}
		} else {
			q = "SELECT time_start FROM slots WHERE date = ? AND type = ? AND warehouse_id = ?"
			args = []any{date, typ, wh}
		}
		rs, err := db.qu(q, args...)
		if err == nil {
			for rs.Next() {
				var ts string
				rs.Scan(&ts)
				existing[ts] = true
			}
			rs.Close()
		}
		for _, s := range want {
			if existing[s.start] {
				continue
			}
			db.ex("INSERT INTO slots (date, type, time_start, time_end, warehouse_id) VALUES (?, ?, ?, ?, ?)",
				date, typ, s.start, s.end, wh)
		}
	}
}

// ---- main -----------------------------------------------------------------

func main() {
	backend := env("DB_BACKEND", "sqlite")
	dsn := env("DB_DSN", "")
	if dsn == "" {
		if backend == "postgres" {
			dsn = "postgres://warehouse:warehouse@127.0.0.1:5432/warehouse?sslmode=disable"
		} else {
			dsn = "warehouse.db"
		}
	}
	var err error
	db, err = openDB(backend, dsn)
	if err != nil {
		log.Fatalf("DB open (%s): %v", backend, err)
	}
	if err := db.initSchema(); err != nil {
		log.Fatal(err)
	}
	if err := db.seed(); err != nil {
		log.Fatal(err)
	}

	go autobackupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/", apiRouter)
	mux.HandleFunc("/storekeeper", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(env("PRIVATE_DIR", "../private"), "storekeeper.html"))
	})
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))

	// IP allowlist gate for manager/storekeeper areas (loopback and empty list allowed).
	gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if needsIPGate(r.URL.Path) && !allowedIP(r) {
			http.Error(w, "Access denied from this IP", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})

	port := env("PORT", "3000")
	log.Printf("warehouse-queue-go (%s) on http://0.0.0.0:%s", db.backend, port)
	log.Fatal(http.ListenAndServe(":"+port, gated))
}

// math/rand seeding for captcha
func init() { mrand.Seed(time.Now().UnixNano()) }
