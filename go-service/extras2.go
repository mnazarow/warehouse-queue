package main

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// extras2Router handles the remaining Settings-tab endpoints and 1C/data tabs.
func extras2Router(w http.ResponseWriter, r *http.Request, p, m string, seg []string) bool {
	switch {
	// ---- 1C settings ----
	case p == "/api/manager/settings/1c" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{
			"token":                          db.getSetting("1c_api_token", ""),
			"serverUrl":                      db.getSetting("1c_server_url", ""),
			"username":                       db.getSetting("1c_username", ""),
			"password":                       db.getSetting("1c_password", ""),
			"orderValidationUrl":             db.getSetting("1c_order_validation_url", ""),
			"paymentCheckUrl":                db.getSetting("1c_payment_check_url", ""),
			"notes":                          db.getSetting("1c_notes", ""),
			"allowBookingWithoutAccount":     db.getSetting("allow_booking_without_account", "1"),
			"allowBookingWithInvalidAccount": db.getSetting("allow_booking_with_invalid_account", "0"),
			"warnMissingAccountAtBooking":    db.getSetting("warn_missing_account_at_booking", "0"),
		})
	case p == "/api/manager/settings/1c" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		b := body(r)
		save := func(key, bkey string) {
			if v, ok := b[bkey]; ok {
				db.setSetting(key, valStr(v))
			}
		}
		save("1c_api_token", "token")
		save("1c_server_url", "serverUrl")
		save("1c_username", "username")
		save("1c_password", "password")
		save("1c_order_validation_url", "orderValidationUrl")
		save("1c_payment_check_url", "paymentCheckUrl")
		save("1c_notes", "notes")
		ok200(w)
	case p == "/api/manager/settings/1c/password" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		db.setSetting("1c_password", bstr(body(r), "password"))
		ok200(w)

	// ---- часовой пояс склада ----
	case p == "/api/manager/settings/timezone" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{"offsetHours": appTzOffsetHours()})
	case p == "/api/manager/settings/timezone" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		h := atoiDef(bstr(body(r), "offsetHours"), 3)
		if h < -12 || h > 14 {
			writeJSON(w, 400, map[string]any{"error": "Недопустимое смещение (от -12 до 14)"})
			return true
		}
		db.setSetting("tz_offset_hours", strconv.Itoa(h))
		ok200(w)

	// ---- за сколько дней можно записаться ----
	case p == "/api/manager/settings/booking-days" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{"days": bookingMaxDays()})
	case p == "/api/manager/settings/booking-days" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		n := atoiDef(bstr(body(r), "days"), 14)
		if n < 1 || n > 365 {
			writeJSON(w, 400, map[string]any{"error": "Недопустимое число дней (от 1 до 365)"})
			return true
		}
		db.setSetting("booking_max_days", strconv.Itoa(n))
		ok200(w)
	case p == "/api/manager/settings/1c/allow-booking-without-account" && m == "POST":
		saveBoolSetting(w, r, "allow_booking_without_account", "allow")
	case p == "/api/manager/settings/1c/allow-booking-with-invalid-account" && m == "POST":
		saveBoolSetting(w, r, "allow_booking_with_invalid_account", "allow")
	case p == "/api/manager/settings/1c/warn-missing-account-at-booking" && m == "POST":
		saveBoolSetting(w, r, "warn_missing_account_at_booking", "warn")

	// ---- SMS settings ----
	case p == "/api/manager/settings/smsru" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{"apiKey": db.getSetting("smsru_api_key", "")})
	case p == "/api/manager/settings/smsru" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		db.setSetting("smsru_api_key", bstr(body(r), "apiKey"))
		ok200(w)

	// ---- Redis settings (config stored; status via TCP ping; caching not active) ----
	case p == "/api/manager/settings/redis" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, redisCfg())
	case p == "/api/manager/settings/redis" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		b := body(r)
		db.setSetting("redis_host", bstr(b, "host"))
		db.setSetting("redis_port", bstr(b, "port"))
		db.setSetting("redis_password", bstr(b, "password"))
		db.setSetting("redis_db", bstr(b, "db"))
		en := "0"
		if tb(b["enabled"]) {
			en = "1"
		}
		db.setSetting("redis_enabled", en)
		writeJSON(w, 200, map[string]any{"success": true, "status": redisStatus()})
	case p == "/api/manager/settings/redis/test" && m == "POST":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		b := body(r)
		host := bstr(b, "host")
		port := bstr(b, "port")
		if port == "" {
			port = "6379"
		}
		writeJSON(w, 200, map[string]any{"success": tcpPing(host, port)})

	// ---- PostgreSQL settings (stored; runtime switch not supported in Go variant) ----
	case p == "/api/manager/settings/pgsql" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{
			"host": db.getSetting("pgsql_host", "127.0.0.1"), "port": db.getSetting("pgsql_port", "5432"),
			"database": db.getSetting("pgsql_database", "warehouse"), "user": db.getSetting("pgsql_user", "warehouse"),
			"password": db.getSetting("pgsql_password", ""),
		})
	case p == "/api/manager/settings/pgsql" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		b := body(r)
		for _, kv := range [][2]string{{"pgsql_host", "host"}, {"pgsql_port", "port"}, {"pgsql_database", "database"}, {"pgsql_user", "user"}, {"pgsql_password", "password"}} {
			db.setSetting(kv[0], bstr(b, kv[1]))
		}
		ok200(w)

	// ---- cache TTL settings ----
	case p == "/api/manager/settings/cache-ttl" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{"ttl": ttlItems()})
	case p == "/api/manager/settings/cache-ttl" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		b := body(r)
		if t, ok := b["ttl"].(map[string]any); ok {
			for _, c := range ttlCats {
				if v, ok := t[c.key]; ok {
					db.setSetting("ttl_"+c.key, valStr(v))
				}
			}
		}
		ok200(w)

	// ---- logos ----
	case p == "/api/manager/settings/logos" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		out := map[string]any{}
		for _, th := range logoThemes {
			v := db.getSetting("logo_"+th, "")
			if v == "" {
				out[th] = nil
			} else {
				out[th] = v
			}
		}
		writeJSON(w, 200, out)
	case p == "/api/manager/settings/logos" && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		b := body(r)
		theme := bstr(b, "theme")
		if theme == "" {
			theme = "light"
		}
		db.setSetting("logo_"+theme, valStr(b["dataUrl"]))
		ok200(w)

	// ---- migration ----
	case p == "/api/manager/migration/status" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		writeJSON(w, 200, map[string]any{
			"current": db.backend,
			"sqlite":  map[string]any{"connected": db.backend == "sqlite"},
			"pgsql":   map[string]any{"connected": db.backend == "postgres"},
		})
	case (p == "/api/manager/migrate/to-pgsql" || p == "/api/manager/migrate/to-sqlite") && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		target := "sqlite"
		if strings.HasSuffix(p, "to-pgsql") {
			target = "postgres"
		}
		n, err := doMigrate(target)
		if err != nil {
			writeJSON(w, 200, map[string]any{"success": false, "error": err.Error()})
			return true
		}
		cacheDelPattern("slots:public:*")
		writeJSON(w, 200, map[string]any{"success": true, "rows": n, "backend": db.backend})
	case (p == "/api/manager/switch/to-pgsql" || p == "/api/manager/switch/to-sqlite") && m == "POST":
		if _, ok := requireAdmin(w, r); !ok {
			return true
		}
		target := "sqlite"
		if strings.HasSuffix(p, "to-pgsql") {
			target = "postgres"
		}
		if err := doSwitch(target); err != nil {
			writeJSON(w, 200, map[string]any{"success": false, "error": err.Error()})
			return true
		}
		cacheDelPattern("slots:public:*")
		writeJSON(w, 200, map[string]any{"success": true, "backend": db.backend})

	// ---- 1C / data tabs (read-only lists) ----
	case p == "/api/manager/check-logs" && m == "GET":
		listKey(w, r, "logs", "SELECT * FROM check_logs ORDER BY id DESC LIMIT 200")
	case p == "/api/manager/messages" && m == "GET":
		listKey(w, r, "messages", "SELECT m.*, s.date AS slot_date, s.time_start AS slot_time, s.customer_name FROM messages m LEFT JOIN slots s ON s.id=m.slot_id ORDER BY m.id DESC LIMIT 200")
	case p == "/api/manager/nomenclature" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		items, _ := queryMaps("SELECT * FROM nomenclature ORDER BY name")
		cats, _ := queryMaps("SELECT * FROM categories ORDER BY name")
		writeJSON(w, 200, map[string]any{"items": items, "categories": cats})
	case p == "/api/manager/orders-1c" && m == "GET":
		listKey(w, r, "orders", "SELECT * FROM orders_1c ORDER BY id DESC LIMIT 500")
	case p == "/api/manager/c1-orders" && m == "GET":
		listKey(w, r, "orders", "SELECT s.*, w.name AS warehouse_name, w.address AS warehouse_address FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE s.is_booked=1 ORDER BY s.date DESC, s.time_start")
	case p == "/api/manager/managers-1c" && m == "GET":
		listKey(w, r, "managers", "SELECT * FROM managers_1c ORDER BY lastSeen DESC, orderCount DESC")
	case p == "/api/manager/engineers-1c" && m == "GET":
		listKey(w, r, "engineers", "SELECT * FROM engineers_1c ORDER BY lastSeen DESC, orderCount DESC")
	case p == "/api/manager/drivers" && m == "GET":
		if _, ok := requireManager(w, r); !ok {
			return true
		}
		drivers, err := queryMaps("SELECT customer_name AS name, customer_phone AS phone, COUNT(*) AS trips, MAX(date) AS last_date FROM slots WHERE is_booked=1 AND customer_phone IS NOT NULL AND customer_phone <> '' GROUP BY customer_phone, customer_name ORDER BY trips DESC, last_date DESC")
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return true
		}
		writeJSON(w, 200, map[string]any{"drivers": drivers})

	default:
		return false
	}
	return true
}

func listKey(w http.ResponseWriter, r *http.Request, key, q string) {
	if _, ok := requireManager(w, r); !ok {
		return
	}
	l, err := queryMaps(q)
	if err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{key: l})
}

func saveBoolSetting(w http.ResponseWriter, r *http.Request, key, bkey string) {
	if _, ok := requireAdmin(w, r); !ok {
		return
	}
	v := "0"
	if tb(body(r)[bkey]) {
		v = "1"
	}
	db.setSetting(key, v)
	ok200(w)
}

func valStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

func atoiDef(s string, d int) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return n
}

func tb(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x == "1" || x == "true"
	case float64:
		return x != 0
	}
	return false
}

// Redis config/status (config stored; the Go variant does not cache yet).
func redisCfg() map[string]any {
	return map[string]any{
		"host":     db.getSetting("redis_host", "127.0.0.1"),
		"port":     atoiDef(db.getSetting("redis_port", "6379"), 6379),
		"password": db.getSetting("redis_password", ""),
		"db":       atoiDef(db.getSetting("redis_db", "0"), 0),
		"enabled":  db.getSetting("redis_enabled", "0") == "1",
		"status":   redisStatus(),
	}
}
func redisStatus() string {
	if db.getSetting("redis_enabled", "0") != "1" {
		return "disabled"
	}
	if tcpPing(db.getSetting("redis_host", "127.0.0.1"), db.getSetting("redis_port", "6379")) {
		return "connected"
	}
	return "error"
}
func tcpPing(host, port string) bool {
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "6379"
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 2*time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// logoThemes are the themes that can carry a custom logo (stored as data URL).
var logoThemes = []string{"light", "dark", "cyberpunk", "fantasy", "summer", "autumn", "winter", "spring"}

// cache TTL categories (mirror of the Node version; now backed by redis.go).
type ttlCat struct {
	key   string
	label string
	def   int
}

var ttlCats = []ttlCat{
	{"slots_public", "Свободные слоты (страница записи)", 30},
	{"slots_cabinet", "Слоты в кабинете менеджера", 10},
	{"directories", "Справочники", 300},
	{"c1_data", "Данные 1С", 60},
	{"messages", "Сообщения", 30},
	{"stats", "Статистика", 30},
	{"drivers", "Водители", 30},
	{"manager_profile", "Профиль менеджера", 300},
}

func ttlItems() []map[string]any {
	out := []map[string]any{}
	for _, c := range ttlCats {
		v := c.def
		if s := db.getSetting("ttl_"+c.key, ""); s != "" {
			v = atoiDef(s, c.def)
		}
		out = append(out, map[string]any{"key": c.key, "label": c.label, "def": c.def, "value": v})
	}
	return out
}
