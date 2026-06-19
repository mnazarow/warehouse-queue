// Database layer for the Rust variant of warehouse-queue.
//
// Both backends are driven through one `Db` enum. To avoid the type-matching
// pain of binding dynamic JSON values to two very different driver APIs, all
// parameters are inlined as properly-escaped SQL literals (the same idea the
// original Node service used when shelling out to psql). Every value passes
// through `lit()`, so user input is always escaped.

use postgres::{Client, NoTls};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub enum Db {
    Sqlite(Connection),
    Pg(Client),
}

impl Db {
    pub fn open(backend: &str, dsn: &str) -> Result<Db, String> {
        match backend {
            "postgres" | "pg" | "postgresql" => {
                let c = Client::connect(dsn, NoTls).map_err(|e| e.to_string())?;
                Ok(Db::Pg(c))
            }
            _ => {
                let c = Connection::open(dsn).map_err(|e| e.to_string())?;
                Ok(Db::Sqlite(c))
            }
        }
    }

    pub fn backend(&self) -> &'static str {
        match self {
            Db::Pg(_) => "postgres",
            Db::Sqlite(_) => "sqlite",
        }
    }

    pub fn is_pg(&self) -> bool {
        matches!(self, Db::Pg(_))
    }

    /// Execute a statement; returns the number of affected rows.
    pub fn exec(&mut self, sql: &str, params: &[Value]) -> u64 {
        let q = bind(sql, params);
        match self {
            Db::Sqlite(c) => c.execute(&q, []).unwrap_or(0) as u64,
            Db::Pg(c) => c.execute(q.as_str(), &[]).unwrap_or(0),
        }
    }

    /// Run several statements separated by ';' (schema creation).
    pub fn exec_batch(&mut self, sql: &str) -> Result<(), String> {
        match self {
            Db::Sqlite(c) => c.execute_batch(sql).map_err(|e| e.to_string()),
            Db::Pg(c) => c.batch_execute(sql).map_err(|e| e.to_string()),
        }
    }

    /// Query rows as a vector of column-name -> JSON value maps.
    pub fn query_maps(&mut self, sql: &str, params: &[Value]) -> Vec<Map<String, Value>> {
        let q = bind(sql, params);
        match self {
            Db::Sqlite(c) => {
                let mut stmt = match c.prepare(&q) {
                    Ok(s) => s,
                    Err(_) => return vec![],
                };
                let names: Vec<String> =
                    stmt.column_names().into_iter().map(|s| s.to_string()).collect();
                let mut rows = match stmt.query([]) {
                    Ok(r) => r,
                    Err(_) => return vec![],
                };
                let mut out = vec![];
                while let Ok(Some(row)) = rows.next() {
                    let mut m = Map::new();
                    for (i, name) in names.iter().enumerate() {
                        m.insert(name.clone(), sqlite_val(row, i));
                    }
                    out.push(m);
                }
                out
            }
            Db::Pg(c) => {
                let rows = match c.query(q.as_str(), &[]) {
                    Ok(r) => r,
                    Err(_) => return vec![],
                };
                let mut out = vec![];
                for row in &rows {
                    let mut m = Map::new();
                    for (i, col) in row.columns().iter().enumerate() {
                        m.insert(col.name().to_string(), pg_val(row, i, col.type_().name()));
                    }
                    out.push(m);
                }
                out
            }
        }
    }

    /// Convenience: first row as a map, if any.
    pub fn query_one(&mut self, sql: &str, params: &[Value]) -> Option<Map<String, Value>> {
        self.query_maps(sql, params).into_iter().next()
    }

    /// Convenience: integer scalar (column must be aliased, e.g. `COUNT(*) AS c`).
    pub fn scalar_i64(&mut self, sql: &str, col: &str, params: &[Value]) -> i64 {
        self.query_one(sql, params)
            .and_then(|m| m.get(col).map(to_i64))
            .unwrap_or(0)
    }

    pub fn get_setting(&mut self, key: &str, def: &str) -> String {
        self.query_one("SELECT value FROM settings WHERE key=?", &[json!(key)])
            .and_then(|m| m.get("value").and_then(|v| v.as_str().map(|s| s.to_string())))
            .unwrap_or_else(|| def.to_string())
    }

    pub fn set_setting(&mut self, key: &str, value: &str) {
        let sql = if self.is_pg() {
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
        } else {
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        };
        self.exec(sql, &[json!(key), json!(value)]);
    }
}

// ---- value conversion ----

fn sqlite_val(row: &rusqlite::Row, i: usize) -> Value {
    use rusqlite::types::ValueRef;
    match row.get_ref(i) {
        Ok(ValueRef::Null) => Value::Null,
        Ok(ValueRef::Integer(n)) => json!(n),
        Ok(ValueRef::Real(f)) => json!(f),
        Ok(ValueRef::Text(t)) => json!(String::from_utf8_lossy(t).to_string()),
        Ok(ValueRef::Blob(b)) => json!(String::from_utf8_lossy(b).to_string()),
        Err(_) => Value::Null,
    }
}

fn pg_val(row: &postgres::Row, i: usize, ty: &str) -> Value {
    match ty {
        "int2" => row
            .try_get::<_, Option<i16>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "int4" => row
            .try_get::<_, Option<i32>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "int8" => row
            .try_get::<_, Option<i64>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "float4" => row
            .try_get::<_, Option<f32>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "float8" => row
            .try_get::<_, Option<f64>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "bool" => row
            .try_get::<_, Option<bool>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<_, Option<String>>(i)
            .ok()
            .flatten()
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
    }
}

pub fn to_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Value::String(s) => s.parse::<i64>().unwrap_or(0),
        Value::Bool(b) => {
            if *b {
                1
            } else {
                0
            }
        }
        _ => 0,
    }
}

// ---- literal binding (replaces `?` with escaped literals) ----

fn lit(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => format!("'{}'", other.to_string().replace('\'', "''")),
    }
}

fn bind(sql: &str, params: &[Value]) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let mut it = params.iter();
    let mut in_str = false;
    for c in sql.chars() {
        match c {
            '\'' => {
                in_str = !in_str;
                out.push(c);
            }
            '?' if !in_str => {
                if let Some(v) = it.next() {
                    out.push_str(&lit(v));
                } else {
                    out.push('?');
                }
            }
            _ => out.push(c),
        }
    }
    out
}

// ---- schema + seed ----

pub fn init_schema(db: &mut Db) -> Result<(), String> {
    let pk = if db.is_pg() {
        "SERIAL PRIMARY KEY"
    } else {
        "INTEGER PRIMARY KEY AUTOINCREMENT"
    };
    let stmts = vec![
        format!("CREATE TABLE IF NOT EXISTS warehouses (id {pk}, name TEXT NOT NULL, address TEXT DEFAULT '', is_default INTEGER NOT NULL DEFAULT 0)"),
        format!("CREATE TABLE IF NOT EXISTS slots (id {pk}, date TEXT NOT NULL, type TEXT NOT NULL, time_start TEXT NOT NULL, time_end TEXT NOT NULL, is_booked INTEGER NOT NULL DEFAULT 0, confirmed INTEGER NOT NULL DEFAULT 0, in_progress INTEGER NOT NULL DEFAULT 0, assembling INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, warehouse_id INTEGER, customer_name TEXT, customer_phone TEXT, customer_account TEXT, customer_comment TEXT, customer_organization TEXT, storekeeper_name TEXT, booked_at TEXT, confirmed_at TEXT, in_progress_at TEXT, assembling_at TEXT, completed_at TEXT, customer_ip TEXT, customer_user_agent TEXT, vehicle_class_id INTEGER, load_type_id INTEGER, storekeeper_id INTEGER, created_at TEXT)"),
        format!("CREATE TABLE IF NOT EXISTS storekeepers (id {pk}, name TEXT NOT NULL, phone TEXT DEFAULT '', pin_code TEXT DEFAULT '', created_at TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS vehicle_classes (id {pk}, name TEXT NOT NULL, description TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS load_types (id {pk}, name TEXT NOT NULL, description TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS categories (id {pk}, name TEXT NOT NULL)"),
        format!("CREATE TABLE IF NOT EXISTS counterparties (id {pk}, name TEXT NOT NULL, phone TEXT DEFAULT '', inn TEXT DEFAULT '', kpp TEXT DEFAULT '', comment TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS allowed_networks (id {pk}, network TEXT NOT NULL, description TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS banned_phones (id {pk}, phone TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS banned_ips (id {pk}, ip TEXT NOT NULL, reason TEXT DEFAULT '', created_at TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS user_logs (id {pk}, user_type TEXT, user_name TEXT, action TEXT, details TEXT, slot_id INTEGER, ip TEXT, user_agent TEXT, created_at TEXT)"),
        format!("CREATE TABLE IF NOT EXISTS messages (id {pk}, slot_id INTEGER, phone TEXT, message TEXT, status TEXT DEFAULT '', created_at TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS check_logs (id {pk}, accounts TEXT, success INTEGER, response_status INTEGER, response_body TEXT, error TEXT, url TEXT, request_body TEXT, created_at TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS nomenclature (id {pk}, name TEXT, article TEXT DEFAULT '', guid TEXT DEFAULT '', category TEXT DEFAULT '')"),
        format!("CREATE TABLE IF NOT EXISTS managers (id {pk}, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', warehouse_id INTEGER, is_admin INTEGER NOT NULL DEFAULT 0)"),
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)".to_string(),
        format!("CREATE TABLE IF NOT EXISTS page_visits (id {pk}, visited_at TEXT NOT NULL, ip TEXT DEFAULT '', device TEXT DEFAULT '', os TEXT DEFAULT '', browser TEXT DEFAULT '')"),
    ];
    for s in stmts {
        db.exec_batch(&s)?;
    }
    Ok(())
}

pub fn seed(db: &mut Db) -> Result<(), String> {
    if db.scalar_i64("SELECT COUNT(*) AS c FROM warehouses", "c", &[]) == 0 {
        db.exec(
            "INSERT INTO warehouses (name, address, is_default) VALUES (?, ?, 1)",
            &[json!("Основной склад"), json!("")],
        );
    }
    if db.scalar_i64("SELECT COUNT(*) AS c FROM managers", "c", &[]) == 0 {
        let h = crate::sha256hex("admin123");
        db.exec(
            "INSERT INTO managers (username, password_hash, first_name, last_name, is_admin) VALUES (?, ?, ?, ?, 1)",
            &[json!("admin"), json!(h), json!("Главный"), json!("Администратор")],
        );
    }
    db.exec("UPDATE managers SET is_admin = 1 WHERE username = ?", &[json!("admin")]);
    if db.scalar_i64("SELECT COUNT(*) AS c FROM vehicle_classes", "c", &[]) == 0 {
        for n in ["Легковая", "Газель", "Фура"] {
            db.exec("INSERT INTO vehicle_classes (name, description) VALUES (?, '')", &[json!(n)]);
        }
    }
    if db.scalar_i64("SELECT COUNT(*) AS c FROM load_types", "c", &[]) == 0 {
        for n in ["Боковая", "Задняя", "Верхняя"] {
            db.exec("INSERT INTO load_types (name, description) VALUES (?, '')", &[json!(n)]);
        }
    }
    Ok(())
}

pub const ALL_TABLES: &[&str] = &[
    "warehouses",
    "slots",
    "managers",
    "settings",
    "page_visits",
    "storekeepers",
    "vehicle_classes",
    "load_types",
    "categories",
    "counterparties",
    "allowed_networks",
    "banned_phones",
    "banned_ips",
    "user_logs",
];
