package main

import (
	"database/sql"
	"fmt"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// DB wraps *sql.DB and remembers the backend so we can adapt SQL dialect.
type DB struct {
	*sql.DB
	backend string // "sqlite" or "postgres"
}

func openDB(backend, dsn string) (*DB, error) {
	var driver string
	switch backend {
	case "postgres", "pg", "postgresql":
		backend, driver = "postgres", "pgx"
	default:
		backend, driver = "sqlite", "sqlite"
	}
	sqldb, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	sqldb.SetMaxOpenConns(10)
	if err := sqldb.Ping(); err != nil {
		return nil, err
	}
	return &DB{DB: sqldb, backend: backend}, nil
}

// rebind converts "?" placeholders to "$1, $2, ..." for PostgreSQL.
func (d *DB) rebind(q string) string {
	if d.backend != "postgres" {
		return q
	}
	var b strings.Builder
	n := 0
	for i := 0; i < len(q); i++ {
		if q[i] == '?' {
			n++
			b.WriteString(fmt.Sprintf("$%d", n))
		} else {
			b.WriteByte(q[i])
		}
	}
	return b.String()
}

func (d *DB) ex(q string, args ...any) (sql.Result, error) { return d.Exec(d.rebind(q), args...) }
func (d *DB) qu(q string, args ...any) (*sql.Rows, error)  { return d.Query(d.rebind(q), args...) }
func (d *DB) row(q string, args ...any) *sql.Row           { return d.QueryRow(d.rebind(q), args...) }

// initSchema creates the tables used by the core service for the active backend.
func (d *DB) initSchema() error {
	pk := "INTEGER PRIMARY KEY AUTOINCREMENT"
	if d.backend == "postgres" {
		pk = "SERIAL PRIMARY KEY"
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS warehouses (
			id ` + pk + `,
			name TEXT NOT NULL,
			address TEXT DEFAULT '',
			is_default INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS slots (
			id ` + pk + `,
			date TEXT NOT NULL,
			type TEXT NOT NULL,
			time_start TEXT NOT NULL,
			time_end TEXT NOT NULL,
			is_booked INTEGER NOT NULL DEFAULT 0,
			confirmed INTEGER NOT NULL DEFAULT 0,
			in_progress INTEGER NOT NULL DEFAULT 0,
			assembling INTEGER NOT NULL DEFAULT 0,
			completed INTEGER NOT NULL DEFAULT 0,
			warehouse_id INTEGER,
			customer_name TEXT,
			customer_phone TEXT,
			customer_account TEXT,
			customer_comment TEXT,
			customer_organization TEXT,
			storekeeper_name TEXT,
			booked_at TEXT,
			confirmed_at TEXT,
			in_progress_at TEXT,
			assembling_at TEXT,
			completed_at TEXT,
			customer_ip TEXT,
			customer_user_agent TEXT,
			vehicle_class_id INTEGER,
			load_type_id INTEGER,
			storekeeper_id INTEGER,
			created_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS storekeepers (id ` + pk + `, name TEXT NOT NULL, phone TEXT DEFAULT '', pin_code TEXT DEFAULT '', created_at TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS vehicle_classes (id ` + pk + `, name TEXT NOT NULL, description TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS load_types (id ` + pk + `, name TEXT NOT NULL, description TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS categories (id ` + pk + `, name TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS counterparties (id ` + pk + `, name TEXT NOT NULL, phone TEXT DEFAULT '', inn TEXT DEFAULT '', kpp TEXT DEFAULT '', comment TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS allowed_networks (id ` + pk + `, network TEXT NOT NULL, description TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS banned_phones (id ` + pk + `, phone TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS banned_ips (id ` + pk + `, ip TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS user_logs (id ` + pk + `, user_type TEXT, user_name TEXT, action TEXT, details TEXT, slot_id INTEGER, ip TEXT, user_agent TEXT, created_at TEXT)`,
		`CREATE TABLE IF NOT EXISTS messages (id ` + pk + `, slot_id INTEGER, phone TEXT, message TEXT, status TEXT DEFAULT '', created_at TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS check_logs (id ` + pk + `, accounts TEXT, success INTEGER, response_status INTEGER, response_body TEXT, error TEXT, url TEXT, request_body TEXT, created_at TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS nomenclature (id ` + pk + `, name TEXT, article TEXT DEFAULT '', guid TEXT DEFAULT '', category TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS orders_1c (id ` + pk + `, orderNumber TEXT, orderDate TEXT DEFAULT '', customerName TEXT DEFAULT '', customerINN TEXT DEFAULT '', customerKPP TEXT DEFAULT '', accountNumber TEXT DEFAULT '', engineerName TEXT DEFAULT '', managerName TEXT DEFAULT '', comment TEXT DEFAULT '', readyStatus INTEGER DEFAULT 0, notReadyReason TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS order_items_1c (id ` + pk + `, orderNumber TEXT, guid TEXT, article TEXT, name TEXT, quantity REAL DEFAULT 0, status TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS managers_1c (id ` + pk + `, name TEXT, orderCount INTEGER DEFAULT 0, lastSeen TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS engineers_1c (id ` + pk + `, name TEXT, orderCount INTEGER DEFAULT 0, lastSeen TEXT DEFAULT '')`,
		`CREATE TABLE IF NOT EXISTS managers (
			id ` + pk + `,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			first_name TEXT DEFAULT '',
			last_name TEXT DEFAULT '',
			warehouse_id INTEGER,
			is_admin INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS page_visits (
			id ` + pk + `,
			visited_at TEXT NOT NULL,
			ip TEXT DEFAULT '',
			device TEXT DEFAULT '',
			os TEXT DEFAULT '',
			browser TEXT DEFAULT ''
		)`,
	}
	for _, s := range stmts {
		if _, err := d.Exec(s); err != nil {
			return fmt.Errorf("schema: %w", err)
		}
	}
	return nil
}

// getSetting returns a setting value or the provided default.
func (d *DB) getSetting(key, def string) string {
	var v string
	err := d.row("SELECT value FROM settings WHERE key = ?", key).Scan(&v)
	if err != nil {
		return def
	}
	return v
}

// setSetting upserts a setting (works on both backends).
func (d *DB) setSetting(key, value string) error {
	var q string
	if d.backend == "postgres" {
		q = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
	} else {
		q = "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
	}
	_, err := d.ex(q, key, value)
	return err
}

// seed inserts a default warehouse and the главный администратор if missing.
func (d *DB) seed() error {
	var cnt int
	d.row("SELECT COUNT(*) FROM warehouses").Scan(&cnt)
	if cnt == 0 {
		d.ex("INSERT INTO warehouses (name, address, is_default) VALUES (?, ?, 1)", "Основной склад", "")
	}
	d.row("SELECT COUNT(*) FROM managers").Scan(&cnt)
	if cnt == 0 {
		d.ex("INSERT INTO managers (username, password_hash, first_name, last_name, is_admin) VALUES (?, ?, ?, ?, 1)",
			"admin", sha256hex("admin123"), "Главный", "Администратор")
	}
	// Ensure the main admin always keeps admin rights.
	d.ex("UPDATE managers SET is_admin = 1 WHERE username = ?", "admin")
	// Seed default reference data so the booking form has options.
	d.row("SELECT COUNT(*) FROM vehicle_classes").Scan(&cnt)
	if cnt == 0 {
		for _, n := range []string{"Легковая", "Газель", "Фура"} {
			d.ex("INSERT INTO vehicle_classes (name, description) VALUES (?, '')", n)
		}
	}
	d.row("SELECT COUNT(*) FROM load_types").Scan(&cnt)
	if cnt == 0 {
		for _, n := range []string{"Боковая", "Задняя", "Верхняя"} {
			d.ex("INSERT INTO load_types (name, description) VALUES (?, '')", n)
		}
	}
	return nil
}
