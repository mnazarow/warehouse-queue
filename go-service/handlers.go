package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	mrand "math/rand"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const tsLayout = "2006-01-02 15:04:05"

func nowTS() string { return time.Now().Format(tsLayout) }

// appLoc — часовой пояс склада (по умолчанию UTC+3, Москва), не зависящий от
// таймзоны сервера. Слоты задаются как местное время; парсинг в этом поясе даёт
// корректный абсолютный момент для сравнения с time.Now(). Настройка: TZ_OFFSET_HOURS.
func appTzOffsetHours() int {
	return atoiDef(db.getSetting("tz_offset_hours", env("TZ_OFFSET_HOURS", "3")), 3)
}

func appLoc() *time.Location {
	return time.FixedZone("APP", appTzOffsetHours()*3600)
}

// bookingMaxDays — за сколько дней вперёд можно записаться (настройка → env → 14).
func bookingMaxDays() int {
	n := atoiDef(db.getSetting("booking_max_days", env("BOOKING_MAX_DAYS", "14")), 14)
	if n <= 0 {
		n = 14
	}
	return n
}

// apiRouter dispatches all /api/* requests.
func apiRouter(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	m := r.Method
	seg := strings.Split(strings.Trim(p, "/"), "/") // e.g. ["api","slots","5","book"]

	switch {
	// ---- public ----
	case p == "/api/warehouses" && m == "GET":
		hWarehouses(w, r)
	case p == "/api/captcha" && m == "GET":
		hCaptcha(w, r)
	case p == "/api/slots" && m == "GET":
		hPublicSlots(w, r)
	case len(seg) == 4 && seg[1] == "slots" && seg[3] == "book" && m == "POST":
		hBook(w, r, seg[2])
	case p == "/api/visit" && m == "POST":
		hVisit(w, r)
	case p == "/api/public/settings/allow-booking-without-account" && m == "GET":
		writeJSON(w, 200, map[string]any{"allow": db.getSetting("allow_booking_without_account", "1") != "0"})
	case p == "/api/public/settings/mascot" && m == "GET":
		writeJSON(w, 200, map[string]any{"enabled": db.getSetting("mascot_enabled", "1") == "1"})
	case p == "/api/public/privacy-policy" && m == "GET":
		writeJSON(w, 200, map[string]any{"text": db.getSetting("privacy_policy_text", "")})
	case p == "/api/public/cookie-policy" && m == "GET":
		writeJSON(w, 200, map[string]any{"text": db.getSetting("cookie_policy_text", "")})
	case p == "/api/public/booking-message" && m == "GET":
		writeJSON(w, 200, map[string]any{"text": db.getSetting("booking_page_message", "")})

	// ---- manager auth ----
	case p == "/api/manager/login" && m == "POST":
		hLogin(w, r)
	case p == "/api/manager/logout" && m == "POST":
		hLogout(w, r)
	case p == "/api/manager/me" && m == "GET":
		hMe(w, r)

	// ---- manager slots ----
	case p == "/api/manager/slots" && m == "GET":
		hManagerSlots(w, r)
	case len(seg) == 5 && seg[1] == "manager" && seg[2] == "slots" && seg[4] == "send-message" && m == "POST":
		hSendMessage(w, r, seg[3])
	case len(seg) == 5 && seg[1] == "manager" && seg[2] == "slots" && m == "POST":
		hSlotAction(w, r, seg[3], seg[4])

	// ---- manager settings (admin) ----
	case p == "/api/manager/settings/logging":
		hToggleSetting(w, r, "logging_enabled")
	case p == "/api/manager/settings/work-on-weekends":
		hToggleSetting(w, r, "work_on_weekends")
	case p == "/api/manager/settings/mascot":
		hToggleSetting(w, r, "mascot_enabled")
	case p == "/api/manager/settings/privacy-policy":
		hTextSetting(w, r, "privacy_policy_text")
	case p == "/api/manager/settings/cookie-policy":
		hTextSetting(w, r, "cookie_policy_text")
	case p == "/api/manager/settings/booking-message":
		hTextSetting(w, r, "booking_page_message")

	// ---- managers CRUD (admin) ----
	case p == "/api/manager/list" && m == "GET":
		hManagerList(w, r)
	case p == "/api/manager/create" && m == "POST":
		hManagerCreate(w, r)
	case len(seg) == 3 && seg[1] == "manager" && m == "PUT":
		hManagerUpdate(w, r, seg[2])
	case len(seg) == 3 && seg[1] == "manager" && m == "DELETE":
		hManagerDelete(w, r, seg[2])

	case p == "/api/manager/about" && m == "GET":
		hAbout(w, r)

	case extrasRouter(w, r, p, m, seg):
		// handled by extras (reference CRUD, analytics, backups, update, storekeeper)

	default:
		writeJSON(w, 404, map[string]any{"error": "not found"})
	}
}

// ---- auth helpers ----

func currentManager(r *http.Request) int {
	c, err := r.Cookie("wq_sess")
	if err != nil {
		return 0
	}
	sessMu.Lock()
	s := sessions[c.Value]
	sessMu.Unlock()
	if s == nil {
		return 0
	}
	return s.managerID
}

func requireManager(w http.ResponseWriter, r *http.Request) (int, bool) {
	id := currentManager(r)
	if id == 0 {
		writeJSON(w, 401, map[string]any{"error": "Unauthorized"})
		return 0, false
	}
	return id, true
}

func requireAdmin(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, ok := requireManager(w, r)
	if !ok {
		return 0, false
	}
	if !isAdmin(id) {
		writeJSON(w, 403, map[string]any{"error": "Доступ только для администраторов"})
		return 0, false
	}
	return id, true
}

// ---- public handlers ----

func hWarehouses(w http.ResponseWriter, r *http.Request) {
	rows, err := db.qu("SELECT id, name, is_default FROM warehouses ORDER BY is_default DESC, name")
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	list := []map[string]any{}
	for rows.Next() {
		var id, def int
		var name string
		rows.Scan(&id, &name, &def)
		list = append(list, map[string]any{"id": id, "name": name, "is_default": def})
	}
	writeJSON(w, 200, map[string]any{"warehouses": list})
}

func hCaptcha(w http.ResponseWriter, r *http.Request) {
	s := getSession(w, r)
	a := mrand.Intn(20) + 1
	b := mrand.Intn(20) + 1
	s.captcha = a + b
	s.hasCap = true
	writeJSON(w, 200, map[string]any{"expression": fmt.Sprintf("%d + %d", a, b)})
}

func hPublicSlots(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	date := q.Get("date")
	typ := q.Get("type")
	if date == "" || typ == "" {
		writeJSON(w, 400, map[string]any{"error": "date and type are required"})
		return
	}
	if typ != "small" && typ != "bulk" {
		writeJSON(w, 400, map[string]any{"error": "type must be small or bulk"})
		return
	}
	if !isWeekday(date) && !worksOnWeekends() {
		writeJSON(w, 200, map[string]any{"slots": []any{}, "weekday": false})
		return
	}
	whID := q.Get("warehouse_id")
	cacheKey := fmt.Sprintf("slots:public:%s:%s:%s", date, typ, whID)

	// В кэш кладём только сырые строки (статус брони). Доступность по времени
	// ("past") считаем заново на каждый запрос, чтобы порог "минимум за час"
	// был точным независимо от TTL кэша (как в Node-варианте).
	var raw []map[string]any
	if s, ok := cacheGet(cacheKey); ok {
		json.Unmarshal([]byte(s), &raw)
	} else {
		ensureSlots(date, typ)
		var rows *sql.Rows
		var err error
		if whID == "" {
			rows, err = db.qu("SELECT id,date,type,time_start,time_end,is_booked,confirmed,in_progress,completed,assembling,warehouse_id FROM slots WHERE date=? AND type=? AND warehouse_id IS NULL ORDER BY time_start", date, typ)
		} else {
			rows, err = db.qu("SELECT id,date,type,time_start,time_end,is_booked,confirmed,in_progress,completed,assembling,warehouse_id FROM slots WHERE date=? AND type=? AND warehouse_id=? ORDER BY time_start", date, typ, whID)
		}
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id int
			var d, t, tss, tse string
			var ib, cf, ip, cmp, asm int
			var wh *int
			rows.Scan(&id, &d, &t, &tss, &tse, &ib, &cf, &ip, &cmp, &asm, &wh)
			raw = append(raw, map[string]any{
				"id": id, "date": d, "type": t, "time_start": tss, "time_end": tse,
				"is_booked": ib, "confirmed": cf, "in_progress": ip, "completed": cmp, "assembling": asm,
				"warehouse_id": wh,
			})
		}
		if cacheEnabled() {
			if b, err := json.Marshal(raw); err == nil {
				cacheSet(cacheKey, string(b), ttlFor("slots_public"))
			}
		}
	}

	now := time.Now()
	minTime := now.Add(time.Hour)                                          // свободен только если старт >= чем через час
	maxTime := now.Add(time.Duration(bookingMaxDays()) * 24 * time.Hour)   // и не дальше настроенного числа дней
	out := []map[string]any{}
	for _, m := range raw {
		d := fmt.Sprintf("%v", m["date"])
		tss := fmt.Sprintf("%v", m["time_start"])
		past := true
		if sd, err := time.ParseInLocation("2006-01-02 15:04", d+" "+tss, appLoc()); err == nil {
			past = sd.Before(minTime) || sd.After(maxTime)
		}
		mm := map[string]any{}
		for k, v := range m {
			mm[k] = v
		}
		mm["past"] = past
		out = append(out, mm)
	}
	writeJSON(w, 200, map[string]any{"slots": out, "weekday": true})
}

func hBook(w http.ResponseWriter, r *http.Request, idStr string) {
	id, _ := strconv.Atoi(idStr)
	var body struct {
		Name, Phone, Account, Comment, Organization string
		CaptchaAnswer                                json.Number
		Force                                        bool
		VehicleClassId, LoadTypeId                   *int
	}
	json.NewDecoder(r.Body).Decode(&body)
	name := strings.TrimSpace(body.Name)
	phone := strings.TrimSpace(body.Phone)
	if name == "" || phone == "" {
		writeJSON(w, 400, map[string]any{"error": "name and phone are required"})
		return
	}
	s := getSession(w, r)
	ans, _ := body.CaptchaAnswer.Int64()
	if !s.hasCap || int(ans) != s.captcha {
		writeJSON(w, 400, map[string]any{"error": "Invalid captcha answer"})
		return
	}
	s.hasCap = false

	account := strings.TrimSpace(body.Account)
	if db.getSetting("allow_booking_without_account", "1") == "0" && account == "" {
		writeJSON(w, 400, map[string]any{"error": "Укажите номер счёта"})
		return
	}
	if account != "" {
		if okAcc, reason := validate1CAccount(account); !okAcc && db.getSetting("allow_booking_with_invalid_account", "0") != "1" {
			writeJSON(w, 400, map[string]any{"error": "Счёт не подтверждён в 1С: " + reason})
			return
		}
	}

	var date, ts string
	var booked int
	err := db.row("SELECT date, time_start, is_booked FROM slots WHERE id=?", id).Scan(&date, &ts, &booked)
	if err != nil {
		writeJSON(w, 404, map[string]any{"error": "Slot not found"})
		return
	}
	if booked == 1 {
		writeJSON(w, 409, map[string]any{"error": "Slot already booked"})
		return
	}
	sd, _ := time.ParseInLocation("2006-01-02 15:04", date+" "+ts, appLoc())
	if sd.Before(time.Now().Add(time.Hour)) {
		writeJSON(w, 400, map[string]any{"error": "Слот можно забронировать минимум за 1 час"})
		return
	}
	if sd.After(time.Now().Add(time.Duration(bookingMaxDays()) * 24 * time.Hour)) {
		writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("Нельзя записаться на дату дальше %d дн. от текущей", bookingMaxDays())})
		return
	}
	res, err := db.ex("UPDATE slots SET is_booked=1, customer_name=?, customer_phone=?, customer_account=?, customer_comment=?, customer_organization=?, booked_at=?, customer_ip=?, customer_user_agent=?, vehicle_class_id=?, load_type_id=? WHERE id=? AND is_booked=0",
		name, phone, nz(body.Account), nz(body.Comment), nz(body.Organization), nowTS(), getIP(r), r.UserAgent(), body.VehicleClassId, body.LoadTypeId, id)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, 409, map[string]any{"error": "Slot already booked"})
		return
	}
	cacheDelPattern("slots:public:" + date + ":*")
	sendSMS(phone, fmt.Sprintf("Вы записаны на %s %s", date, ts))
	writeJSON(w, 200, map[string]any{"success": true})
}

func cleanPhone(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c == '+' || (c >= '0' && c <= '9') {
			b.WriteRune(c)
		}
	}
	return b.String()
}

// hSendMessage отправляет SMS по заявке: на явно переданный номер (менеджер/инженер)
// либо на телефон клиента заявки.
func hSendMessage(w http.ResponseWriter, r *http.Request, idStr string) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	b := body(r)
	msg := strings.TrimSpace(bstr(b, "message"))
	if msg == "" {
		writeJSON(w, 400, map[string]any{"error": "Сообщение не может быть пустым"})
		return
	}
	id, _ := strconv.Atoi(idStr)
	var custPtr *string
	db.row("SELECT customer_phone FROM slots WHERE id=?", id).Scan(&custPtr)
	target := cleanPhone(bstr(b, "phone"))
	if target == "" && custPtr != nil {
		target = *custPtr
	}
	if target == "" {
		writeJSON(w, 400, map[string]any{"error": "Нет номера телефона для отправки"})
		return
	}
	sendSMS(target, msg)
	db.ex("INSERT INTO messages (slot_id, phone, message, created_at) VALUES (?, ?, ?, ?)", id, target, msg, nowTS())
	writeJSON(w, 200, map[string]any{"success": true, "phone": target})
}

func hVisit(w http.ResponseWriter, r *http.Request) {
	ua := r.UserAgent()
	db.ex("INSERT INTO page_visits (visited_at, ip, device, os, browser) VALUES (?, ?, ?, ?, ?)",
		time.Now().UTC().Format(time.RFC3339), getIP(r), detectDevice(ua), detectOS(ua), detectBrowser(ua))
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---- manager handlers ----

func hLogin(w http.ResponseWriter, r *http.Request) {
	var body struct{ Username, Password string }
	json.NewDecoder(r.Body).Decode(&body)
	var id, admin int
	var fn, ln string
	err := db.row("SELECT id, first_name, last_name, is_admin FROM managers WHERE username=? AND password_hash=?",
		body.Username, sha256hex(body.Password)).Scan(&id, &fn, &ln, &admin)
	if err != nil {
		writeJSON(w, 401, map[string]any{"error": "Invalid credentials"})
		return
	}
	s := getSession(w, r)
	s.managerID = id
	writeJSON(w, 200, map[string]any{"success": true, "id": id, "username": body.Username, "firstName": fn, "lastName": ln, "isAdmin": admin == 1})
}

func hLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("wq_sess"); err == nil {
		sessMu.Lock()
		delete(sessions, c.Value)
		sessMu.Unlock()
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func hMe(w http.ResponseWriter, r *http.Request) {
	id, ok := requireManager(w, r)
	if !ok {
		return
	}
	var username, fn, ln string
	var wh *int
	var admin int
	db.row("SELECT username, first_name, last_name, warehouse_id, is_admin FROM managers WHERE id=?", id).Scan(&username, &fn, &ln, &wh, &admin)
	writeJSON(w, 200, map[string]any{"id": id, "username": username, "firstName": fn, "lastName": ln, "warehouseId": wh, "isAdmin": admin == 1})
}

func hManagerSlots(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	q := r.URL.Query()
	where := "WHERE 1=1"
	args := []any{}
	if d := q.Get("date"); d != "" {
		where += " AND s.date=?"
		args = append(args, d)
	}
	if t := q.Get("type"); t != "" {
		where += " AND s.type=?"
		args = append(args, t)
	}
	if wh := q.Get("warehouse_id"); wh != "" {
		where += " AND s.warehouse_id=?"
		args = append(args, wh)
	}
	rows, err := db.qu("SELECT s.id,s.date,s.type,s.time_start,s.time_end,s.is_booked,s.confirmed,s.in_progress,s.assembling,s.completed,s.warehouse_id,s.customer_name,s.customer_phone,s.customer_account,s.customer_comment,s.customer_organization,s.storekeeper_name,w.name FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id "+where+" ORDER BY s.date DESC, s.time_start", args...)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int
		var date, typ, tss, tse string
		var ib, cf, ip, asm, cmp int
		var wh *int
		var cn, cp, ca, cc, co, sk, wn *string
		rows.Scan(&id, &date, &typ, &tss, &tse, &ib, &cf, &ip, &asm, &cmp, &wh, &cn, &cp, &ca, &cc, &co, &sk, &wn)
		out = append(out, map[string]any{
			"id": id, "date": date, "type": typ, "time_start": tss, "time_end": tse,
			"is_booked": ib, "confirmed": cf, "in_progress": ip, "assembling": asm, "completed": cmp,
			"warehouse_id": wh, "customer_name": ps(cn), "customer_phone": ps(cp), "customer_account": ps(ca),
			"customer_comment": ps(cc), "customer_organization": ps(co), "storekeeper_name": ps(sk), "warehouse_name": ps(wn),
		})
	}
	writeJSON(w, 200, map[string]any{"slots": out})
}

func hSlotAction(w http.ResponseWriter, r *http.Request, idStr, action string) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	id, _ := strconv.Atoi(idStr)
	var q string
	switch action {
	case "take", "in-progress":
		q = "UPDATE slots SET in_progress=1, in_progress_at=? WHERE id=?"
	case "confirm":
		q = "UPDATE slots SET confirmed=1, confirmed_at=? WHERE id=?"
	case "assemble":
		q = "UPDATE slots SET assembling=1, assembling_at=? WHERE id=?"
	case "complete":
		q = "UPDATE slots SET completed=1, completed_at=? WHERE id=?"
	case "return-from-assembly":
		q = "UPDATE slots SET assembling=0, assembling_at=NULL WHERE id=?"
	case "cancel":
		q = "UPDATE slots SET is_booked=0, confirmed=0, in_progress=0, assembling=0, completed=0, customer_name=NULL, customer_phone=NULL, customer_account=NULL, customer_comment=NULL, customer_organization=NULL WHERE id=?"
	default:
		writeJSON(w, 400, map[string]any{"error": "unknown action"})
		return
	}
	var err error
	if strings.Contains(q, "_at=?") {
		_, err = db.ex(q, nowTS(), id)
	} else {
		_, err = db.ex(q, id)
	}
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if action == "cancel" {
		cacheDelPattern("slots:public:*")
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func hToggleSetting(w http.ResponseWriter, r *http.Request, key string) {
	if r.Method == "GET" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		writeJSON(w, 200, map[string]any{"enabled": db.getSetting(key, boolDefault(key)) == "1"})
		return
	}
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var body struct{ Enabled bool }
	json.NewDecoder(r.Body).Decode(&body)
	v := "0"
	if body.Enabled {
		v = "1"
	}
	db.setSetting(key, v)
	writeJSON(w, 200, map[string]any{"success": true})
}

func hTextSetting(w http.ResponseWriter, r *http.Request, key string) {
	if r.Method == "GET" {
		if _, ok := requireManager(w, r); !ok {
			return
		}
		writeJSON(w, 200, map[string]any{"text": db.getSetting(key, "")})
		return
	}
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var body struct{ Text string }
	json.NewDecoder(r.Body).Decode(&body)
	db.setSetting(key, body.Text)
	writeJSON(w, 200, map[string]any{"success": true})
}

func hManagerList(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	rows, err := db.qu("SELECT m.id,m.username,m.first_name,m.last_name,m.warehouse_id,m.is_admin,w.name FROM managers m LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.id")
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, admin int
		var un, fn, ln string
		var wh *int
		var wn *string
		rows.Scan(&id, &un, &fn, &ln, &wh, &admin, &wn)
		out = append(out, map[string]any{"id": id, "username": un, "first_name": fn, "last_name": ln, "warehouse_id": wh, "is_admin": admin, "warehouse_name": ps(wn)})
	}
	writeJSON(w, 200, map[string]any{"managers": out})
}

func hManagerCreate(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	var body struct {
		Username, Password, FirstName, LastName string
		WarehouseId                             *int
		IsAdmin                                 bool
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Username == "" || body.Password == "" {
		writeJSON(w, 400, map[string]any{"error": "Username and password are required"})
		return
	}
	var exists int
	db.row("SELECT COUNT(*) FROM managers WHERE username=?", body.Username).Scan(&exists)
	if exists > 0 {
		writeJSON(w, 409, map[string]any{"error": "Username already exists"})
		return
	}
	adm := 0
	if body.IsAdmin {
		adm = 1
	}
	_, err := db.ex("INSERT INTO managers (username, password_hash, first_name, last_name, warehouse_id, is_admin) VALUES (?, ?, ?, ?, ?, ?)",
		body.Username, sha256hex(body.Password), body.FirstName, body.LastName, body.WarehouseId, adm)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func hManagerUpdate(w http.ResponseWriter, r *http.Request, idStr string) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	id, _ := strconv.Atoi(idStr)
	var body struct {
		Username, Password, FirstName, LastName string
		WarehouseId                             *int
		IsAdmin                                 bool
	}
	json.NewDecoder(r.Body).Decode(&body)
	if body.Username == "" {
		writeJSON(w, 400, map[string]any{"error": "Username is required"})
		return
	}
	var curUser string
	if err := db.row("SELECT username FROM managers WHERE id=?", id).Scan(&curUser); err != nil {
		writeJSON(w, 404, map[string]any{"error": "Manager not found"})
		return
	}
	adm := 0
	if body.IsAdmin {
		adm = 1
	}
	if curUser == "admin" {
		adm = 1 // главного администратора нельзя разжаловать
	}
	if body.Password != "" {
		db.ex("UPDATE managers SET username=?, password_hash=?, first_name=?, last_name=?, warehouse_id=?, is_admin=? WHERE id=?",
			body.Username, sha256hex(body.Password), body.FirstName, body.LastName, body.WarehouseId, adm, id)
	} else {
		db.ex("UPDATE managers SET username=?, first_name=?, last_name=?, warehouse_id=?, is_admin=? WHERE id=?",
			body.Username, body.FirstName, body.LastName, body.WarehouseId, adm, id)
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

func hManagerDelete(w http.ResponseWriter, r *http.Request, idStr string) {
	mid, ok := requireAdmin(w, r)
	if !ok {
		return
	}
	id, _ := strconv.Atoi(idStr)
	if id == mid {
		writeJSON(w, 400, map[string]any{"error": "Cannot delete yourself"})
		return
	}
	var un string
	if err := db.row("SELECT username FROM managers WHERE id=?", id).Scan(&un); err != nil {
		writeJSON(w, 404, map[string]any{"error": "Manager not found"})
		return
	}
	if un == "admin" {
		writeJSON(w, 400, map[string]any{"error": "Нельзя удалить главного администратора"})
		return
	}
	db.ex("DELETE FROM managers WHERE id=?", id)
	writeJSON(w, 200, map[string]any{"success": true})
}

func hAbout(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	writeJSON(w, 200, map[string]any{
		"version":       "1.0.0-go",
		"serverTime":    time.Now().Format(time.RFC3339),
		"startedAt":     startTime.Format(time.RFC3339),
		"uptimeSeconds": int(time.Since(startTime).Seconds()),
	})
}

// ---- small utils ----

func nz(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func ps(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
func boolDefault(key string) string {
	if key == "mascot_enabled" {
		return "1"
	}
	return "0"
}

func detectDevice(ua string) string {
	if ua == "" {
		return "unknown"
	}
	if regexp.MustCompile(`(?i)bot|crawl|spider|slurp`).MatchString(ua) {
		return "bot"
	}
	if regexp.MustCompile(`(?i)iPad|Tablet|PlayBook|Silk`).MatchString(ua) || (regexp.MustCompile(`(?i)Android`).MatchString(ua) && !regexp.MustCompile(`(?i)Mobile`).MatchString(ua)) {
		return "tablet"
	}
	if regexp.MustCompile(`(?i)Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry`).MatchString(ua) {
		return "mobile"
	}
	return "desktop"
}
func detectOS(ua string) string {
	switch {
	case ua == "":
		return ""
	case regexp.MustCompile(`(?i)Windows NT`).MatchString(ua):
		return "Windows"
	case regexp.MustCompile(`iPhone|iPad|iPod`).MatchString(ua):
		return "iOS"
	case regexp.MustCompile(`Android`).MatchString(ua):
		return "Android"
	case regexp.MustCompile(`Mac OS X|Macintosh`).MatchString(ua):
		return "macOS"
	case regexp.MustCompile(`Linux`).MatchString(ua):
		return "Linux"
	}
	return "Прочее"
}
func detectBrowser(ua string) string {
	switch {
	case ua == "":
		return ""
	case regexp.MustCompile(`Edg`).MatchString(ua):
		return "Edge"
	case regexp.MustCompile(`OPR/|Opera`).MatchString(ua):
		return "Opera"
	case regexp.MustCompile(`YaBrowser`).MatchString(ua):
		return "Yandex"
	case regexp.MustCompile(`Firefox`).MatchString(ua):
		return "Firefox"
	case regexp.MustCompile(`Chrome|CriOS`).MatchString(ua):
		return "Chrome"
	case regexp.MustCompile(`Safari`).MatchString(ua):
		return "Safari"
	}
	return "Прочее"
}
