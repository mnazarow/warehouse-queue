package main

import (
	"fmt"
	"strings"
)

// targetDSN builds a connection string for the given backend from the stored
// PostgreSQL settings (or env fallbacks).
func targetDSN(backend string) string {
	if backend == "postgres" {
		host := db.getSetting("pgsql_host", env("PG_HOST", "127.0.0.1"))
		port := db.getSetting("pgsql_port", env("PG_PORT", "5432"))
		name := db.getSetting("pgsql_database", env("PG_DB", "warehouse"))
		user := db.getSetting("pgsql_user", env("PG_USER", "warehouse"))
		pass := db.getSetting("pgsql_password", env("PG_PASSWORD", ""))
		return fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=disable", user, pass, host, port, name)
	}
	return env("SQLITE_PATH", "warehouse.db")
}

func openTarget(target string) (*DB, error) {
	ndb, err := openDB(target, targetDSN(target))
	if err != nil {
		return nil, err
	}
	if err := ndb.initSchema(); err != nil {
		ndb.Close()
		return nil, err
	}
	if err := ndb.seed(); err != nil {
		ndb.Close()
		return nil, err
	}
	return ndb, nil
}

// copyAllTo copies every core table from the active db into ndb, then resyncs
// PostgreSQL sequences so future inserts don't collide with copied ids.
func copyAllTo(ndb *DB) (int, error) {
	count := 0
	for _, t := range allTables {
		rows, err := queryMaps("SELECT * FROM " + t)
		if err != nil {
			continue
		}
		ndb.ex("DELETE FROM " + t)
		for _, row := range rows {
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
			if _, err := ndb.ex("INSERT INTO "+t+" ("+strings.Join(cols, ",")+") VALUES ("+strings.Join(ph, ",")+")", args...); err == nil {
				count++
			}
		}
	}
	if ndb.backend == "postgres" {
		for _, t := range allTables {
			if t == "settings" { // no SERIAL id column
				continue
			}
			ndb.ex(fmt.Sprintf("SELECT setval(pg_get_serial_sequence('%s','id'), COALESCE((SELECT MAX(id) FROM %s),1))", t, t))
		}
	}
	return count, nil
}

// doMigrate copies all data to the target backend and switches the active db.
func doMigrate(target string) (int, error) {
	if target == db.backend {
		return 0, fmt.Errorf("уже используется бэкенд %s", target)
	}
	ndb, err := openTarget(target)
	if err != nil {
		return 0, err
	}
	n, err := copyAllTo(ndb)
	if err != nil {
		ndb.Close()
		return 0, err
	}
	old := db
	db = ndb
	if old != nil {
		old.Close()
	}
	return n, nil
}

// doSwitch connects to the target backend and makes it active without copying.
func doSwitch(target string) error {
	if target == db.backend {
		return fmt.Errorf("уже используется бэкенд %s", target)
	}
	ndb, err := openTarget(target)
	if err != nil {
		return err
	}
	old := db
	db = ndb
	if old != nil {
		old.Close()
	}
	return nil
}
