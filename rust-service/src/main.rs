#![allow(dead_code)]
// warehouse-queue — Rust variant.
// HTTP via tiny_http (blocking, single request loop). Storage via SQLite
// (rusqlite) or PostgreSQL (postgres) behind the `Db` enum in db.rs.
// Reuses the existing frontend from ../public and ../private.

mod db;

use chrono::{Datelike, Duration as CDur, FixedOffset, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc, Weekday};
use db::{to_i64, Db};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tiny_http::{Header, Method, Request, Response, Server};

static START: OnceLock<Instant> = OnceLock::new();
static STARTED: OnceLock<String> = OnceLock::new();

const TTL_CATS: &[(&str, &str, i64)] = &[
    ("slots_public", "Свободные слоты (страница записи)", 30),
    ("slots_cabinet", "Слоты в кабинете менеджера", 10),
    ("directories", "Справочники", 300),
    ("c1_data", "Данные 1С", 60),
    ("messages", "Сообщения", 30),
    ("stats", "Статистика", 30),
    ("drivers", "Водители", 30),
    ("manager_profile", "Профиль менеджера", 300),
];

const LOGO_THEMES: &[&str] = &[
    "light", "dark", "cyberpunk", "fantasy", "summer", "autumn", "winter", "spring",
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

pub fn sha256hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

fn env(k: &str, def: &str) -> String {
    match std::env::var(k) {
        Ok(v) if !v.is_empty() => v,
        _ => def.to_string(),
    }
}

fn now_ts() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}
fn now_rfc3339() -> String {
    Local::now().to_rfc3339()
}
fn uptime_secs() -> u64 {
    START.get().map(|s| s.elapsed().as_secs()).unwrap_or(0)
}
fn started() -> String {
    STARTED.get().cloned().unwrap_or_default()
}

fn new_token() -> String {
    let mut buf = [0u8; 24];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    } else {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let b = n.to_le_bytes();
        for i in 0..buf.len() {
            buf[i] = b[i % b.len()];
        }
    }
    hex::encode(buf)
}

fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{:02X}", b)),
        }
    }
    o
}

fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn urldec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
            out.push(b[i]);
            i += 1;
        } else if b[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_cookie(hdr: &str, name: &str) -> String {
    for part in hdr.split(';') {
        let p = part.trim();
        if let Some((k, v)) = p.split_once('=') {
            if k == name {
                return v.to_string();
            }
        }
    }
    String::new()
}

// JSON body accessors
fn bstr(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}
fn bbool(v: &Value, k: &str) -> bool {
    match v.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "1" || s == "true",
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        _ => false,
    }
}
fn bopt_i64(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64())
}
fn nz(s: &str) -> Value {
    if s.is_empty() {
        Value::Null
    } else {
        json!(s)
    }
}
fn opt_i64_json(v: Option<i64>) -> Value {
    match v {
        Some(n) => json!(n),
        None => Value::Null,
    }
}
fn idp(s: &str) -> Value {
    s.parse::<i64>().map(|n| json!(n)).unwrap_or(Value::Null)
}

// ---------------------------------------------------------------------------
// request context + response
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Session {
    manager_id: i64,
    captcha: i64,
    has_cap: bool,
}

struct Ctx {
    method: String,
    path: String,
    query: HashMap<String, String>,
    body: Value,
    ip: String,
    ua: String,
    token: String,
}

fn q(ctx: &Ctx, k: &str) -> String {
    ctx.query.get(k).cloned().unwrap_or_default()
}

struct Resp {
    code: u16,
    body: String,
    ctype: String,
    set_cookie: Option<String>,
}
impl Resp {
    fn json(code: u16, v: Value) -> Resp {
        Resp {
            code,
            body: v.to_string(),
            ctype: "application/json; charset=utf-8".to_string(),
            set_cookie: None,
        }
    }
    fn raw(code: u16, body: String, ctype: &str) -> Resp {
        Resp {
            code,
            body,
            ctype: ctype.to_string(),
            set_cookie: None,
        }
    }
    fn ok() -> Resp {
        Resp::json(200, json!({"success": true}))
    }
    fn err(code: u16, msg: &str) -> Resp {
        Resp::json(code, json!({ "error": msg }))
    }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

fn cur_mgr(sessions: &HashMap<String, Session>, token: &str) -> i64 {
    sessions.get(token).map(|s| s.manager_id).unwrap_or(0)
}
fn is_admin(db: &mut Db, mid: i64) -> bool {
    if mid == 0 {
        return false;
    }
    db.scalar_i64("SELECT is_admin AS c FROM managers WHERE id=?", "c", &[json!(mid)]) == 1
}

// ---------------------------------------------------------------------------
// slots
// ---------------------------------------------------------------------------

fn gen_slots(typ: &str) -> Vec<(String, String)> {
    let dur = if typ == "bulk" { 30 } else { 15 };
    let mut out = vec![];
    let mut m = 10 * 60;
    while m < 17 * 60 + 30 {
        let e = m + dur;
        out.push((
            format!("{:02}:{:02}", m / 60, m % 60),
            format!("{:02}:{:02}", e / 60, e % 60),
        ));
        m += dur;
    }
    out
}

fn is_weekday(date: &str) -> bool {
    match NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(d) => !matches!(d.weekday(), Weekday::Sat | Weekday::Sun),
        Err(_) => false,
    }
}

// Часовой пояс склада (по умолчанию UTC+3, Москва), не зависящий от таймзоны
// сервера. Настройка: TZ_OFFSET_HOURS.
// Приоритет: настройка в кабинете (tz_offset_hours) → TZ_OFFSET_HOURS → 3 (Москва).
fn app_offset_secs(db: &mut Db) -> i32 {
    db.get_setting("tz_offset_hours", &env("TZ_OFFSET_HOURS", "3"))
        .parse::<i32>()
        .unwrap_or(3)
        * 3600
}

// Слот задаётся как местное время склада; возвращаем абсолютный момент в UTC.
fn slot_dt(date: &str, time: &str, offset_secs: i32) -> Option<chrono::DateTime<Utc>> {
    let nd = NaiveDateTime::parse_from_str(&format!("{date} {time}"), "%Y-%m-%d %H:%M").ok()?;
    let off = FixedOffset::east_opt(offset_secs)?;
    Some(off.from_local_datetime(&nd).single()?.with_timezone(&Utc))
}

fn ensure_slots(db: &mut Db, date: &str, typ: &str) {
    let want = gen_slots(typ);
    let wh_rows = db.query_maps("SELECT id FROM warehouses", &[]);
    let mut targets: Vec<Option<i64>> = wh_rows
        .iter()
        .map(|m| Some(to_i64(m.get("id").unwrap_or(&Value::Null))))
        .collect();
    targets.push(None);
    for wh in targets {
        let existing = match wh {
            Some(id) => db.query_maps(
                "SELECT time_start FROM slots WHERE date=? AND type=? AND warehouse_id=?",
                &[json!(date), json!(typ), json!(id)],
            ),
            None => db.query_maps(
                "SELECT time_start FROM slots WHERE date=? AND type=? AND warehouse_id IS NULL",
                &[json!(date), json!(typ)],
            ),
        };
        let set: HashSet<String> = existing
            .iter()
            .filter_map(|m| m.get("time_start").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        for (ts, te) in &want {
            if set.contains(ts) {
                continue;
            }
            db.exec(
                "INSERT INTO slots (date,type,time_start,time_end,warehouse_id) VALUES (?,?,?,?,?)",
                &[json!(date), json!(typ), json!(ts), json!(te), opt_i64_json(wh)],
            );
        }
    }
}

// ---------------------------------------------------------------------------
// device detection
// ---------------------------------------------------------------------------

fn detect_device(ua: &str) -> String {
    let u = ua.to_lowercase();
    if u.is_empty() {
        return "unknown".into();
    }
    if u.contains("bot") || u.contains("crawl") || u.contains("spider") || u.contains("slurp") {
        return "bot".into();
    }
    if u.contains("ipad")
        || u.contains("tablet")
        || u.contains("playbook")
        || u.contains("silk")
        || (u.contains("android") && !u.contains("mobile"))
    {
        return "tablet".into();
    }
    if u.contains("mobi")
        || u.contains("iphone")
        || u.contains("ipod")
        || u.contains("android")
        || u.contains("windows phone")
        || u.contains("blackberry")
    {
        return "mobile".into();
    }
    "desktop".into()
}
fn detect_os(ua: &str) -> String {
    if ua.is_empty() {
        return String::new();
    }
    if ua.contains("Windows NT") {
        "Windows".into()
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") {
        "iOS".into()
    } else if ua.contains("Android") {
        "Android".into()
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS".into()
    } else if ua.contains("Linux") {
        "Linux".into()
    } else {
        "Прочее".into()
    }
}
fn detect_browser(ua: &str) -> String {
    if ua.is_empty() {
        return String::new();
    }
    if ua.contains("Edg") {
        "Edge".into()
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        "Opera".into()
    } else if ua.contains("YaBrowser") {
        "Yandex".into()
    } else if ua.contains("Firefox") {
        "Firefox".into()
    } else if ua.contains("Chrome") || ua.contains("CriOS") {
        "Chrome".into()
    } else if ua.contains("Safari") {
        "Safari".into()
    } else {
        "Прочее".into()
    }
}

// ---------------------------------------------------------------------------
// Redis (minimal RESP client, no extra crate)
// ---------------------------------------------------------------------------

enum RVal {
    Str(String),
    Int(i64),
    Nil,
    Arr(Vec<RVal>),
    Err(String),
}

fn send_cmd(s: &mut TcpStream, args: &[&str]) -> std::io::Result<()> {
    let mut buf = format!("*{}\r\n", args.len());
    for a in args {
        buf.push_str(&format!("${}\r\n{}\r\n", a.len(), a));
    }
    s.write_all(buf.as_bytes())
}

fn read_reply<R: BufRead>(r: &mut R) -> Option<RVal> {
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return None;
    }
    let (t, rest) = line.split_at(1);
    match t {
        "+" => Some(RVal::Str(rest.to_string())),
        "-" => Some(RVal::Err(rest.to_string())),
        ":" => Some(RVal::Int(rest.parse().ok()?)),
        "$" => {
            let n: i64 = rest.parse().ok()?;
            if n < 0 {
                return Some(RVal::Nil);
            }
            let mut buf = vec![0u8; (n as usize) + 2];
            r.read_exact(&mut buf).ok()?;
            buf.truncate(n as usize);
            Some(RVal::Str(String::from_utf8_lossy(&buf).to_string()))
        }
        "*" => {
            let n: i64 = rest.parse().ok()?;
            if n < 0 {
                return Some(RVal::Nil);
            }
            let mut v = vec![];
            for _ in 0..n {
                v.push(read_reply(r)?);
            }
            Some(RVal::Arr(v))
        }
        _ => None,
    }
}

fn redis_one(db: &mut Db, args: &[&str]) -> Option<RVal> {
    let mut host = db.get_setting("redis_host", "127.0.0.1");
    let mut port = db.get_setting("redis_port", "6379");
    let pass = db.get_setting("redis_password", "");
    let dbn = db.get_setting("redis_db", "0");
    if host.is_empty() {
        host = "127.0.0.1".into();
    }
    if port.is_empty() {
        port = "6379".into();
    }
    let sa = format!("{host}:{port}").to_socket_addrs().ok()?.next()?;
    let ws = TcpStream::connect_timeout(&sa, Duration::from_millis(800)).ok()?;
    ws.set_read_timeout(Some(Duration::from_millis(800))).ok();
    ws.set_write_timeout(Some(Duration::from_millis(800))).ok();
    let mut w = ws.try_clone().ok()?;
    let mut r = BufReader::new(ws);
    if !pass.is_empty() {
        send_cmd(&mut w, &["AUTH", pass.as_str()]).ok()?;
        read_reply(&mut r)?;
    }
    if dbn != "0" && !dbn.is_empty() {
        send_cmd(&mut w, &["SELECT", dbn.as_str()]).ok()?;
        read_reply(&mut r)?;
    }
    send_cmd(&mut w, args).ok()?;
    read_reply(&mut r)
}

fn cache_enabled(db: &mut Db) -> bool {
    db.get_setting("redis_enabled", "0") == "1"
}
fn cache_get(db: &mut Db, key: &str) -> Option<String> {
    if !cache_enabled(db) {
        return None;
    }
    match redis_one(db, &["GET", key])? {
        RVal::Str(s) => Some(s),
        _ => None,
    }
}
fn cache_set(db: &mut Db, key: &str, val: &str, ttl: i64) {
    if !cache_enabled(db) {
        return;
    }
    let t = ttl.to_string();
    redis_one(db, &["SET", key, val, "EX", t.as_str()]);
}
fn cache_del_pattern(db: &mut Db, pat: &str) {
    if !cache_enabled(db) {
        return;
    }
    if let Some(RVal::Arr(keys)) = redis_one(db, &["KEYS", pat]) {
        for k in keys {
            if let RVal::Str(s) = k {
                redis_one(db, &["DEL", s.as_str()]);
            }
        }
    }
}
fn tcp_ping(host: &str, port: &str) -> bool {
    let h = if host.is_empty() { "127.0.0.1" } else { host };
    let p = if port.is_empty() { "6379" } else { port };
    match format!("{h}:{p}").to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(sa) => TcpStream::connect_timeout(&sa, Duration::from_millis(800)).is_ok(),
            None => false,
        },
        Err(_) => false,
    }
}
fn redis_status(db: &mut Db) -> String {
    if db.get_setting("redis_enabled", "0") != "1" {
        return "disabled".into();
    }
    if tcp_ping(
        &db.get_setting("redis_host", "127.0.0.1"),
        &db.get_setting("redis_port", "6379"),
    ) {
        "connected".into()
    } else {
        "error".into()
    }
}

fn ttl_for(db: &mut Db, cat: &str) -> i64 {
    for (k, _l, d) in TTL_CATS {
        if *k == cat {
            let s = db.get_setting(&format!("ttl_{k}"), "");
            if !s.is_empty() {
                return s.parse().unwrap_or(*d);
            }
            return *d;
        }
    }
    30
}
fn ttl_items(db: &mut Db) -> Vec<Value> {
    TTL_CATS
        .iter()
        .map(|(k, l, d)| {
            let s = db.get_setting(&format!("ttl_{k}"), "");
            let v = if s.is_empty() { *d } else { s.parse().unwrap_or(*d) };
            json!({"key": k, "label": l, "def": d, "value": v})
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 1C + SMS (outbound HTTP via ureq)
// ---------------------------------------------------------------------------

fn trunc(s: &str, n: usize) -> String {
    if s.len() > n {
        s.chars().take(n).collect()
    } else {
        s.to_string()
    }
}

fn log_check(db: &mut Db, accounts: &str, success: bool, status: i64, resp: &str, err: &str, url: &str, reqbody: &str) {
    db.exec(
        "INSERT INTO check_logs (accounts,success,response_status,response_body,error,url,request_body,created_at) VALUES (?,?,?,?,?,?,?,?)",
        &[
            json!(accounts),
            json!(if success { 1 } else { 0 }),
            json!(status),
            json!(trunc(resp, 4000)),
            json!(err),
            json!(url),
            json!(trunc(reqbody, 4000)),
            json!(now_ts()),
        ],
    );
}

fn validate_1c(db: &mut Db, account: &str) -> (bool, String) {
    let url = db.get_setting("1c_order_validation_url", "");
    if url.is_empty() {
        return (true, String::new());
    }
    // 1С: HTTP Basic (логин/пароль) + поле "invoce_number" (именно так, с опечаткой,
    // названо поле в API 1С). Контракт совпадает с Node-вариантом.
    let username = db.get_setting("1c_username", "");
    let password = db.get_setting("1c_password", "");
    let reqbody = json!({ "invoce_number": [account] }).to_string();
    let mut req = ureq::post(&url)
        .timeout(Duration::from_secs(10))
        .set("Content-Type", "application/json");
    if !username.is_empty() || !password.is_empty() {
        let cred = base64_encode(format!("{username}:{password}").as_bytes());
        req = req.set("Authorization", &format!("Basic {cred}"));
    }
    // Берём тело ответа независимо от HTTP-кода (1С может вернуть results и при 200).
    let (status, text) = match req.send_string(&reqbody) {
        Ok(resp) => (resp.status() as i64, resp.into_string().unwrap_or_default()),
        Err(ureq::Error::Status(code, resp)) => {
            (code as i64, resp.into_string().unwrap_or_default())
        }
        Err(e) => {
            log_check(db, account, false, 0, "", &e.to_string(), &url, &reqbody);
            return (true, String::new()); // 1С недоступна → fail-open (как в Node)
        }
    };
    let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let results = match v.get("results").and_then(|r| r.as_object()) {
        Some(r) => r,
        None => {
            log_check(db, account, false, status, &text, "No results field", &url, &reqbody);
            return (true, String::new()); // нет поля results → проверка пропущена
        }
    };
    let all_found = results.values().all(|item| {
        let s = item
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        s.starts_with("found") || s.starts_with("найден")
    });
    log_check(db, account, all_found, status, &text, "", &url, &reqbody);
    if all_found {
        (true, String::new())
    } else {
        (false, "счёт не найден в 1С".into())
    }
}

// base64 (стандартный алфавит, с паддингом) — для заголовка HTTP Basic, без crate.
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn send_sms(db: &mut Db, phone: &str, msg: &str) {
    let key = db.get_setting("smsru_api_key", &env("SMSRU_API_KEY", ""));
    if key.is_empty() || phone.is_empty() {
        return;
    }
    let url = format!(
        "https://sms.ru/sms/send?api_id={}&to={}&msg={}&json=1",
        urlenc(&key),
        urlenc(phone),
        urlenc(msg)
    );
    let _ = ureq::get(&url).timeout(Duration::from_secs(10)).call();
}

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

fn backup_dir() -> String {
    let d = env("BACKUP_DIR", "backups");
    let _ = fs::create_dir_all(&d);
    d
}

fn build_backup(db: &mut Db) -> Value {
    let mut tables = Map::new();
    for t in db::ALL_TABLES {
        let rows = db.query_maps(&format!("SELECT * FROM {t}"), &[]);
        tables.insert(
            t.to_string(),
            Value::Array(rows.into_iter().map(Value::Object).collect()),
        );
    }
    json!({
        "app": "warehouse-queue-rs",
        "createdAt": now_rfc3339(),
        "dbType": db.backend(),
        "tables": tables,
    })
}

fn restore_from_dump(db: &mut Db, dump: &Value) -> Result<u64, String> {
    let tables = dump
        .get("tables")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "Некорректный файл резервной копии".to_string())?
        .clone();
    let mut count = 0u64;
    for t in db::ALL_TABLES {
        if let Some(Value::Array(rows)) = tables.get(*t) {
            db.exec(&format!("DELETE FROM {t}"), &[]);
            for r in rows {
                if let Value::Object(map) = r {
                    let mut cols = vec![];
                    let mut ph = vec![];
                    let mut params = vec![];
                    for (k, v) in map {
                        cols.push(k.clone());
                        ph.push("?");
                        params.push(v.clone());
                    }
                    if cols.is_empty() {
                        continue;
                    }
                    db.exec(
                        &format!("INSERT INTO {t} ({}) VALUES ({})", cols.join(","), ph.join(",")),
                        &params,
                    );
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}

fn write_auto_backup(db: &mut Db) -> Result<String, String> {
    let d = backup_dir();
    let name = format!("autobackup-{}.json", Local::now().format("%Y-%m-%d-%H-%M-%S"));
    let data = build_backup(db).to_string();
    fs::write(format!("{d}/{name}"), data).map_err(|e| e.to_string())?;
    prune_backups(db);
    Ok(name)
}

fn prune_backups(db: &mut Db) {
    let mut keep = db.get_setting("autobackup_keep", "24").parse::<usize>().unwrap_or(24);
    if keep == 0 {
        keep = 24;
    }
    let d = backup_dir();
    let mut files: Vec<String> = vec![];
    if let Ok(entries) = fs::read_dir(&d) {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("autobackup-") && n.ends_with(".json") {
                files.push(n);
            }
        }
    }
    files.sort();
    files.reverse();
    for f in files.iter().skip(keep) {
        let _ = fs::remove_file(format!("{d}/{f}"));
    }
}

fn safe_name(n: &str) -> bool {
    !n.is_empty() && !n.contains("..") && !n.contains('/') && n.ends_with(".json")
}

// ---------------------------------------------------------------------------
// git update
// ---------------------------------------------------------------------------

fn git_out(args: &[&str]) -> Result<String, String> {
    let out = Command::new("git").args(args).output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ---------------------------------------------------------------------------
// migration / switch
// ---------------------------------------------------------------------------

fn target_dsn(db: &mut Db, backend: &str) -> String {
    if backend == "postgres" {
        let host = db.get_setting("pgsql_host", &env("PG_HOST", "127.0.0.1"));
        let port = db.get_setting("pgsql_port", &env("PG_PORT", "5432"));
        let name = db.get_setting("pgsql_database", &env("PG_DB", "warehouse"));
        let user = db.get_setting("pgsql_user", &env("PG_USER", "warehouse"));
        let pass = db.get_setting("pgsql_password", &env("PG_PASSWORD", ""));
        format!("postgres://{user}:{pass}@{host}:{port}/{name}?sslmode=disable")
    } else {
        env("SQLITE_PATH", "warehouse.db")
    }
}

fn do_migrate(db: &mut Db, target: &str) -> Result<u64, String> {
    if db.backend() == target {
        return Err(format!("уже используется бэкенд {target}"));
    }
    let dsn = target_dsn(db, target);
    let mut newdb = Db::open(target, &dsn)?;
    db::init_schema(&mut newdb)?;
    db::seed(&mut newdb)?;
    let mut count = 0u64;
    for t in db::ALL_TABLES {
        let rows = db.query_maps(&format!("SELECT * FROM {t}"), &[]);
        newdb.exec(&format!("DELETE FROM {t}"), &[]);
        for row in rows {
            let mut cols = vec![];
            let mut ph = vec![];
            let mut params = vec![];
            for (k, v) in &row {
                cols.push(k.clone());
                ph.push("?");
                params.push(v.clone());
            }
            if cols.is_empty() {
                continue;
            }
            if newdb.exec(
                &format!("INSERT INTO {t} ({}) VALUES ({})", cols.join(","), ph.join(",")),
                &params,
            ) > 0
            {
                count += 1;
            }
        }
    }
    if newdb.is_pg() {
        for t in db::ALL_TABLES {
            if *t == "settings" {
                continue;
            }
            newdb.exec(
                &format!(
                    "SELECT setval(pg_get_serial_sequence('{t}','id'), COALESCE((SELECT MAX(id) FROM {t}),1))"
                ),
                &[],
            );
        }
    }
    *db = newdb;
    Ok(count)
}

fn do_switch(db: &mut Db, target: &str) -> Result<(), String> {
    if db.backend() == target {
        return Err(format!("уже используется бэкенд {target}"));
    }
    let dsn = target_dsn(db, target);
    let mut newdb = Db::open(target, &dsn)?;
    db::init_schema(&mut newdb)?;
    db::seed(&mut newdb)?;
    *db = newdb;
    Ok(())
}

// ---------------------------------------------------------------------------
// analytics
// ---------------------------------------------------------------------------

fn make_buckets(interval: &str) -> Vec<(chrono::DateTime<Local>, chrono::DateTime<Local>, String)> {
    let now = Local::now();
    let mut b = vec![];
    match interval {
        "minute" => {
            let base = now - CDur::seconds(now.second() as i64)
                - CDur::nanoseconds(now.timestamp_subsec_nanos() as i64);
            for i in (0..60i64).rev() {
                let s = base - CDur::minutes(i);
                b.push((s, s + CDur::minutes(1), format!("{:02}:{:02}", s.hour(), s.minute())));
            }
        }
        "hour" => {
            let base = now - CDur::minutes(now.minute() as i64) - CDur::seconds(now.second() as i64);
            for i in (0..24i64).rev() {
                let s = base - CDur::hours(i);
                b.push((s, s + CDur::hours(1), format!("{:02}:00", s.hour())));
            }
        }
        "week" => {
            let today = Local
                .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
                .single()
                .unwrap_or(now);
            let off = today.weekday().num_days_from_monday() as i64;
            let base = today - CDur::days(off);
            for i in (0..12i64).rev() {
                let s = base - CDur::days(i * 7);
                b.push((s, s + CDur::days(7), format!("{:02}.{:02}", s.day(), s.month())));
            }
        }
        "year" => {
            for i in (0..6i32).rev() {
                let y = now.year() - i;
                let s = Local.with_ymd_and_hms(y, 1, 1, 0, 0, 0).single().unwrap_or(now);
                let e = Local.with_ymd_and_hms(y + 1, 1, 1, 0, 0, 0).single().unwrap_or(now);
                b.push((s, e, y.to_string()));
            }
        }
        _ => {
            let today = Local
                .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
                .single()
                .unwrap_or(now);
            for i in (0..30i64).rev() {
                let s = today - CDur::days(i);
                b.push((s, s + CDur::days(1), format!("{:02}.{:02}", s.day(), s.month())));
            }
        }
    }
    b
}

fn parse_ts(s: &str) -> Option<chrono::DateTime<Local>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Local));
    }
    let s2 = s.replace('T', " ");
    if let Ok(nd) = NaiveDateTime::parse_from_str(&s2, "%Y-%m-%d %H:%M:%S") {
        return Local.from_local_datetime(&nd).single();
    }
    None
}

fn device_group(db: &mut Db, col: &str) -> Vec<Value> {
    let rows = db.query_maps(
        &format!("SELECT {col} AS k, COUNT(*) AS cnt FROM page_visits GROUP BY {col}"),
        &[],
    );
    let mut acc: Vec<(String, i64)> = vec![];
    for m in rows {
        let mut name = m.get("k").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            name = "Прочее".into();
        }
        let c = to_i64(m.get("cnt").unwrap_or(&Value::Null));
        if let Some(e) = acc.iter_mut().find(|(n, _)| *n == name) {
            e.1 += c;
        } else {
            acc.push((name, c));
        }
    }
    acc.sort_by(|a, b| b.1.cmp(&a.1));
    acc.into_iter().map(|(n, c)| json!({"name": n, "count": c})).collect()
}

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

fn content_type(path: &str) -> &'static str {
    let p = path.to_lowercase();
    if p.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if p.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if p.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if p.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else if p.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}

fn serve_static(request: Request, path: &str, static_dir: &str, private_dir: &str) {
    let full = if path == "/storekeeper" {
        format!("{private_dir}/storekeeper.html")
    } else {
        let rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
        if rel.contains("..") {
            let _ = request.respond(Response::from_string("bad path").with_status_code(400));
            return;
        }
        format!("{static_dir}/{rel}")
    };
    match fs::read(&full) {
        Ok(bytes) => {
            let mut resp = Response::from_data(bytes);
            if let Ok(h) = Header::from_bytes(b"Content-Type", content_type(&full).as_bytes()) {
                resp.add_header(h);
            }
            let _ = request.respond(resp);
        }
        Err(_) => {
            let _ = request.respond(Response::from_string("Not found").with_status_code(404));
        }
    }
}

// ---------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------

fn needs_ip_gate(p: &str) -> bool {
    p == "/manager.html"
        || p.starts_with("/api/manager")
        || p == "/storekeeper"
        || p.starts_with("/api/storekeeper")
}

fn ipv4_to_u32(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut r = 0u32;
    for p in parts {
        let n: u32 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        r = (r << 8) | n;
    }
    Some(r)
}

fn ip_in_cidr(ip: &str, cidr: &str) -> bool {
    let (net, bits) = match cidr.split_once('/') {
        Some((n, b)) => (n, b),
        None => return ip == cidr,
    };
    let prefix: u32 = match bits.parse() {
        Ok(x) => x,
        Err(_) => return false,
    };
    if prefix > 32 {
        return false;
    }
    match (ipv4_to_u32(ip), ipv4_to_u32(net)) {
        (Some(a), Some(b)) => {
            if prefix == 0 {
                true
            } else {
                let mask = u32::MAX << (32 - prefix);
                (a & mask) == (b & mask)
            }
        }
        _ => false,
    }
}

fn ip_allowed(db: &mut Db, ip: &str) -> bool {
    if ip.is_empty() || ip == "127.0.0.1" || ip == "::1" {
        return true;
    }
    let rows = db.query_maps("SELECT network FROM allowed_networks", &[]);
    if rows.is_empty() {
        return true;
    }
    for m in rows {
        if let Some(n) = m.get("network").and_then(|v| v.as_str()) {
            if ip_in_cidr(ip, n) {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// API routing
// ---------------------------------------------------------------------------

fn route_api(db: &mut Db, sessions: &mut HashMap<String, Session>, ctx: &Ctx) -> Resp {
    let p = ctx.path.as_str();
    let m = ctx.method.as_str();
    let seg: Vec<&str> = ctx.path.trim_matches('/').split('/').collect();
    let mid = cur_mgr(sessions, &ctx.token);

    // ---- public ----
    if p == "/api/warehouses" && m == "GET" {
        let rows = db.query_maps("SELECT id, name, is_default FROM warehouses ORDER BY is_default DESC, name", &[]);
        return Resp::json(200, json!({ "warehouses": rows }));
    }
    if p == "/api/captcha" && m == "GET" {
        let a = (pseudo_rand() % 20 + 1) as i64;
        let b = (pseudo_rand() % 20 + 1) as i64;
        let s = sessions.entry(ctx.token.clone()).or_default();
        s.captcha = a + b;
        s.has_cap = true;
        return Resp::json(200, json!({ "expression": format!("{a} + {b}") }));
    }
    if p == "/api/slots" && m == "GET" {
        return h_public_slots(db, ctx);
    }
    if seg.len() == 4 && seg[1] == "slots" && seg[3] == "book" && m == "POST" {
        return h_book(db, sessions, ctx, seg[2]);
    }
    if p == "/api/visit" && m == "POST" {
        db.exec(
            "INSERT INTO page_visits (visited_at, ip, device, os, browser) VALUES (?, ?, ?, ?, ?)",
            &[
                json!(chrono::Utc::now().to_rfc3339()),
                json!(ctx.ip),
                json!(detect_device(&ctx.ua)),
                json!(detect_os(&ctx.ua)),
                json!(detect_browser(&ctx.ua)),
            ],
        );
        return Resp::json(200, json!({ "ok": true }));
    }
    if p == "/api/public/settings/allow-booking-without-account" && m == "GET" {
        return Resp::json(200, json!({"allow": db.get_setting("allow_booking_without_account","1") != "0"}));
    }
    if p == "/api/public/settings/mascot" && m == "GET" {
        return Resp::json(200, json!({"enabled": db.get_setting("mascot_enabled","1") == "1"}));
    }
    if p == "/api/public/privacy-policy" && m == "GET" {
        return Resp::json(200, json!({"text": db.get_setting("privacy_policy_text","")}));
    }
    if p == "/api/public/cookie-policy" && m == "GET" {
        return Resp::json(200, json!({"text": db.get_setting("cookie_policy_text","")}));
    }
    if p == "/api/public/vehicle-classes" && m == "GET" {
        let rows = db.query_maps("SELECT id, name, description FROM vehicle_classes ORDER BY name", &[]);
        return Resp::json(200, json!({ "classes": rows }));
    }
    if p == "/api/public/load-types" && m == "GET" {
        let rows = db.query_maps("SELECT id, name, description FROM load_types ORDER BY name", &[]);
        return Resp::json(200, json!({ "types": rows }));
    }

    // ---- manager auth ----
    if p == "/api/manager/login" && m == "POST" {
        let un = bstr(&ctx.body, "username");
        let pw = bstr(&ctx.body, "password");
        let row = db.query_one(
            "SELECT id, first_name, last_name, is_admin FROM managers WHERE username=? AND password_hash=?",
            &[json!(un), json!(sha256hex(&pw))],
        );
        match row {
            Some(r) => {
                let id = to_i64(r.get("id").unwrap_or(&Value::Null));
                let s = sessions.entry(ctx.token.clone()).or_default();
                s.manager_id = id;
                return Resp::json(200, json!({
                    "success": true, "id": id, "username": un,
                    "firstName": r.get("first_name"), "lastName": r.get("last_name"),
                    "isAdmin": to_i64(r.get("is_admin").unwrap_or(&Value::Null)) == 1
                }));
            }
            None => return Resp::err(401, "Invalid credentials"),
        }
    }
    if p == "/api/manager/logout" && m == "POST" {
        sessions.remove(&ctx.token);
        return Resp::ok();
    }
    if p == "/api/manager/me" && m == "GET" {
        if mid == 0 {
            return Resp::err(401, "Unauthorized");
        }
        let r = db.query_one("SELECT username, first_name, last_name, warehouse_id, is_admin FROM managers WHERE id=?", &[json!(mid)]);
        return match r {
            Some(r) => Resp::json(200, json!({
                "id": mid, "username": r.get("username"),
                "firstName": r.get("first_name"), "lastName": r.get("last_name"),
                "warehouseId": r.get("warehouse_id"),
                "isAdmin": to_i64(r.get("is_admin").unwrap_or(&Value::Null)) == 1
            })),
            None => Resp::err(404, "not found"),
        };
    }

    // Everything below requires a logged-in manager.
    if p.starts_with("/api/manager/") && mid == 0 {
        return Resp::err(401, "Unauthorized");
    }

    if p == "/api/manager/about" && m == "GET" {
        return Resp::json(200, json!({
            "version": "1.0.0-rs",
            "serverTime": now_rfc3339(),
            "startedAt": started(),
            "uptimeSeconds": uptime_secs(),
            "dbBackend": db.backend(),
        }));
    }

    if p == "/api/manager/slots" && m == "GET" {
        return h_manager_slots(db, ctx);
    }
    if seg.len() == 5 && seg[1] == "manager" && seg[2] == "slots" && m == "POST" {
        return h_slot_action(db, ctx, seg[3], seg[4]);
    }

    // ---- toggles / text settings ----
    if p == "/api/manager/settings/logging" {
        return h_toggle(db, mid, ctx, "logging_enabled", false);
    }
    if p == "/api/manager/settings/work-on-weekends" {
        return h_toggle(db, mid, ctx, "work_on_weekends", false);
    }
    if p == "/api/manager/settings/mascot" {
        return h_toggle(db, mid, ctx, "mascot_enabled", true);
    }
    if p == "/api/manager/settings/privacy-policy" {
        return h_text(db, mid, ctx, "privacy_policy_text");
    }
    if p == "/api/manager/settings/cookie-policy" {
        return h_text(db, mid, ctx, "cookie_policy_text");
    }

    // ---- managers CRUD (admin) ----
    if p == "/api/manager/list" && m == "GET" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let rows = db.query_maps("SELECT m.id,m.username,m.first_name,m.last_name,m.warehouse_id,m.is_admin,w.name AS warehouse_name FROM managers m LEFT JOIN warehouses w ON w.id=m.warehouse_id ORDER BY m.id", &[]);
        return Resp::json(200, json!({ "managers": rows }));
    }
    if p == "/api/manager/create" && m == "POST" {
        return h_manager_create(db, mid, ctx);
    }
    if seg.len() == 3 && seg[1] == "manager" && m == "PUT" {
        return h_manager_update(db, mid, ctx, seg[2]);
    }
    if seg.len() == 3 && seg[1] == "manager" && m == "DELETE" {
        return h_manager_delete(db, mid, seg[2]);
    }

    // ---- reference data CRUD ----
    if p == "/api/manager/vehicle-classes" {
        return ref_name_desc(db, ctx, "vehicle_classes", "classes");
    }
    if p.starts_with("/api/manager/vehicle-classes/") {
        return ref_upd_del(db, ctx, "vehicle_classes", seg[seg.len() - 1], &["name", "description"]);
    }
    if p == "/api/manager/load-types" {
        return ref_name_desc(db, ctx, "load_types", "types");
    }
    if p.starts_with("/api/manager/load-types/") {
        return ref_upd_del(db, ctx, "load_types", seg[seg.len() - 1], &["name", "description"]);
    }
    if p == "/api/manager/categories" {
        if m == "GET" {
            let rows = db.query_maps("SELECT * FROM categories ORDER BY name", &[]);
            return Resp::json(200, json!({ "categories": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "name");
            if n.is_empty() {
                return Resp::err(400, "Name is required");
            }
            db.exec("INSERT INTO categories (name) VALUES (?)", &[json!(n)]);
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/categories/") && m == "DELETE" {
        db.exec("DELETE FROM categories WHERE id=?", &[idp(seg[seg.len() - 1])]);
        return Resp::ok();
    }
    if p == "/api/manager/counterparties" {
        if m == "GET" {
            let rows = db.query_maps("SELECT * FROM counterparties ORDER BY name", &[]);
            return Resp::json(200, json!({ "counterparties": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "name");
            if n.is_empty() {
                return Resp::err(400, "Название обязательно");
            }
            db.exec(
                "INSERT INTO counterparties (name, phone, inn, kpp, comment) VALUES (?, ?, ?, ?, ?)",
                &[json!(n), json!(bstr(&ctx.body, "phone")), json!(bstr(&ctx.body, "inn")), json!(bstr(&ctx.body, "kpp")), json!(bstr(&ctx.body, "comment"))],
            );
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/counterparties/") {
        return ref_upd_del(db, ctx, "counterparties", seg[seg.len() - 1], &["name", "phone", "inn", "kpp", "comment"]);
    }
    if p == "/api/manager/storekeepers" {
        if m == "GET" {
            let rows = db.query_maps("SELECT id, name, phone, created_at, CASE WHEN pin_code IS NOT NULL AND pin_code <> '' THEN 1 ELSE 0 END AS has_pin FROM storekeepers ORDER BY id", &[]);
            return Resp::json(200, json!({ "storekeepers": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "name");
            if n.is_empty() {
                return Resp::err(400, "Name is required");
            }
            db.exec("INSERT INTO storekeepers (name, phone, pin_code, created_at) VALUES (?, ?, ?, ?)", &[json!(n), json!(bstr(&ctx.body, "phone")), json!(bstr(&ctx.body, "pinCode")), json!(now_ts())]);
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/storekeepers/") {
        let id = seg[seg.len() - 1];
        if m == "PUT" {
            let pin = bstr(&ctx.body, "pinCode");
            if pin.is_empty() {
                db.exec("UPDATE storekeepers SET name=?, phone=? WHERE id=?", &[json!(bstr(&ctx.body, "name")), json!(bstr(&ctx.body, "phone")), idp(id)]);
            } else {
                db.exec("UPDATE storekeepers SET name=?, phone=?, pin_code=? WHERE id=?", &[json!(bstr(&ctx.body, "name")), json!(bstr(&ctx.body, "phone")), json!(pin), idp(id)]);
            }
            return Resp::ok();
        }
        if m == "DELETE" {
            db.exec("DELETE FROM storekeepers WHERE id=?", &[idp(id)]);
            return Resp::ok();
        }
    }
    if p == "/api/manager/networks" {
        if m == "GET" {
            let rows = db.query_maps("SELECT * FROM allowed_networks ORDER BY id", &[]);
            return Resp::json(200, json!({ "networks": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "network");
            if n.is_empty() {
                return Resp::err(400, "Network is required");
            }
            db.exec("INSERT INTO allowed_networks (network, description) VALUES (?, ?)", &[json!(n), json!(bstr(&ctx.body, "description"))]);
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/networks/") && m == "DELETE" {
        db.exec("DELETE FROM allowed_networks WHERE id=?", &[idp(seg[seg.len() - 1])]);
        return Resp::ok();
    }
    if p == "/api/manager/banned-phones" {
        if m == "GET" {
            let rows = db.query_maps("SELECT * FROM banned_phones ORDER BY created_at DESC", &[]);
            return Resp::json(200, json!({ "phones": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "phone");
            if n.is_empty() {
                return Resp::err(400, "Phone is required");
            }
            db.exec("INSERT INTO banned_phones (phone, reason, created_at) VALUES (?, ?, ?)", &[json!(n), json!(bstr(&ctx.body, "reason")), json!(now_ts())]);
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/banned-phones/") && m == "DELETE" {
        db.exec("DELETE FROM banned_phones WHERE id=?", &[idp(seg[seg.len() - 1])]);
        return Resp::ok();
    }
    if p == "/api/manager/banned-ips" {
        if m == "GET" {
            let rows = db.query_maps("SELECT * FROM banned_ips ORDER BY created_at DESC", &[]);
            return Resp::json(200, json!({ "ips": rows }));
        }
        if m == "POST" {
            let n = bstr(&ctx.body, "ip");
            if n.is_empty() {
                return Resp::err(400, "IP is required");
            }
            db.exec("INSERT INTO banned_ips (ip, reason, created_at) VALUES (?, ?, ?)", &[json!(n), json!(bstr(&ctx.body, "reason")), json!(now_ts())]);
            return Resp::ok();
        }
    }
    if p.starts_with("/api/manager/banned-ips/") && m == "DELETE" {
        db.exec("DELETE FROM banned_ips WHERE id=?", &[idp(seg[seg.len() - 1])]);
        return Resp::ok();
    }

    // ---- analytics ----
    if p == "/api/manager/stats/timeseries" && m == "GET" {
        return h_timeseries(db, ctx);
    }
    if p == "/api/manager/stats/devices" && m == "GET" {
        return h_devices(db);
    }
    if p == "/api/manager/drivers" && m == "GET" {
        let drivers = db.query_maps("SELECT customer_name AS name, customer_phone AS phone, COUNT(*) AS trips, MAX(date) AS last_date FROM slots WHERE is_booked=1 AND customer_phone IS NOT NULL AND customer_phone <> '' GROUP BY customer_phone, customer_name ORDER BY trips DESC, last_date DESC", &[]);
        return Resp::json(200, json!({ "drivers": drivers }));
    }

    // ---- backups (admin) ----
    if p == "/api/manager/backup" && m == "GET" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let mut r = Resp::json(200, build_backup(db));
        r.ctype = "application/json; charset=utf-8".into();
        return r;
    }
    if p == "/api/manager/restore" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        return match restore_from_dump(db, &ctx.body) {
            Ok(n) => Resp::json(200, json!({"success": true, "rows": n})),
            Err(e) => Resp::json(400, json!({ "error": e })),
        };
    }
    if p == "/api/manager/backups" && m == "GET" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let d = backup_dir();
        let mut list = vec![];
        if let Ok(entries) = fs::read_dir(&d) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if !(n.starts_with("autobackup-") && n.ends_with(".json")) {
                    continue;
                }
                let size_kb = e.metadata().map(|mt| mt.len() / 1024).unwrap_or(0);
                list.push(json!({ "name": n, "sizeKb": size_kb }));
            }
        }
        list.sort_by(|a, b| b["name"].as_str().unwrap_or("").cmp(a["name"].as_str().unwrap_or("")));
        return Resp::json(200, json!({ "backups": list }));
    }
    if p == "/api/manager/backups/run" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        return match write_auto_backup(db) {
            Ok(n) => Resp::json(200, json!({"success": true, "name": n})),
            Err(e) => Resp::json(500, json!({ "error": e })),
        };
    }
    if p.starts_with("/api/manager/backups/") && p.ends_with("/restore") && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let name = seg[seg.len() - 2];
        if !safe_name(name) {
            return Resp::err(400, "bad name");
        }
        let data = match fs::read_to_string(format!("{}/{}", backup_dir(), name)) {
            Ok(d) => d,
            Err(_) => return Resp::err(404, "not found"),
        };
        let dump: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        return match restore_from_dump(db, &dump) {
            Ok(n) => Resp::json(200, json!({"success": true, "rows": n})),
            Err(e) => Resp::json(500, json!({ "error": e })),
        };
    }
    if p.starts_with("/api/manager/backups/") && m == "GET" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let name = seg[seg.len() - 1];
        if !safe_name(name) {
            return Resp::err(400, "bad name");
        }
        return match fs::read_to_string(format!("{}/{}", backup_dir(), name)) {
            Ok(d) => Resp::raw(200, d, "application/json; charset=utf-8"),
            Err(_) => Resp::err(404, "not found"),
        };
    }

    // ---- update via git (admin) ----
    if p == "/api/manager/check-update" && m == "GET" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let cur = match git_out(&["rev-parse", "HEAD"]) {
            Ok(c) if !c.is_empty() => c,
            _ => return Resp::json(200, json!({"ok": false, "error": "не git-репозиторий"})),
        };
        let mut branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        if branch.is_empty() {
            branch = "main".into();
        }
        let ls = git_out(&["ls-remote", "origin", branch.as_str()]).unwrap_or_default();
        let latest = ls.split_whitespace().next().unwrap_or("").to_string();
        return Resp::json(200, json!({
            "ok": true, "branch": branch, "current": cur, "latest": latest,
            "upToDate": !latest.is_empty() && cur == latest,
            "updateAvailable": !latest.is_empty() && cur != latest
        }));
    }
    if p == "/api/manager/update" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let before = match git_out(&["rev-parse", "HEAD"]) {
            Ok(c) if !c.is_empty() => c,
            _ => return Resp::json(200, json!({"success": false, "error": "не git-репозиторий"})),
        };
        let mut branch = git_out(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
        if branch.is_empty() {
            branch = "main".into();
        }
        let _ = git_out(&["pull", "--ff-only", "origin", branch.as_str()]);
        let after = git_out(&["rev-parse", "HEAD"]).unwrap_or_default();
        if before == after {
            return Resp::json(200, json!({"success": true, "updated": false, "message": "Уже последняя версия"}));
        }
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(800));
            std::process::exit(0);
        });
        return Resp::json(200, json!({"success": true, "updated": true, "from": before, "to": after, "restarting": true}));
    }

    // ---- Settings tab: 1C / SMS / Redis / PG / cache-ttl / logos ----
    if p == "/api/manager/settings/1c" && m == "GET" {
        return Resp::json(200, json!({
            "token": db.get_setting("1c_api_token",""),
            "serverUrl": db.get_setting("1c_server_url",""),
            "username": db.get_setting("1c_username",""),
            "password": db.get_setting("1c_password",""),
            "orderValidationUrl": db.get_setting("1c_order_validation_url",""),
            "paymentCheckUrl": db.get_setting("1c_payment_check_url",""),
            "notes": db.get_setting("1c_notes",""),
            "allowBookingWithoutAccount": db.get_setting("allow_booking_without_account","1"),
            "allowBookingWithInvalidAccount": db.get_setting("allow_booking_with_invalid_account","0"),
            "warnMissingAccountAtBooking": db.get_setting("warn_missing_account_at_booking","0")
        }));
    }
    if p == "/api/manager/settings/1c" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        for (key, bk) in [
            ("1c_api_token", "token"),
            ("1c_server_url", "serverUrl"),
            ("1c_username", "username"),
            ("1c_password", "password"),
            ("1c_order_validation_url", "orderValidationUrl"),
            ("1c_payment_check_url", "paymentCheckUrl"),
            ("1c_notes", "notes"),
        ] {
            if ctx.body.get(bk).is_some() {
                db.set_setting(key, &bstr(&ctx.body, bk));
            }
        }
        return Resp::ok();
    }
    if p == "/api/manager/settings/1c/password" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        db.set_setting("1c_password", &bstr(&ctx.body, "password"));
        return Resp::ok();
    }
    if p == "/api/manager/settings/timezone" && m == "GET" {
        let h = db
            .get_setting("tz_offset_hours", &env("TZ_OFFSET_HOURS", "3"))
            .parse::<i64>()
            .unwrap_or(3);
        return Resp::json(200, json!({ "offsetHours": h }));
    }
    if p == "/api/manager/settings/timezone" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let h = ctx
            .body
            .get("offsetHours")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(3);
        if h < -12 || h > 14 {
            return Resp::err(400, "Недопустимое смещение (от -12 до 14)");
        }
        db.set_setting("tz_offset_hours", &h.to_string());
        return Resp::ok();
    }
    if p == "/api/manager/settings/1c/allow-booking-without-account" && m == "POST" {
        return save_bool(db, mid, ctx, "allow_booking_without_account", "allow");
    }
    if p == "/api/manager/settings/1c/allow-booking-with-invalid-account" && m == "POST" {
        return save_bool(db, mid, ctx, "allow_booking_with_invalid_account", "allow");
    }
    if p == "/api/manager/settings/1c/warn-missing-account-at-booking" && m == "POST" {
        return save_bool(db, mid, ctx, "warn_missing_account_at_booking", "warn");
    }
    if p == "/api/manager/settings/smsru" && m == "GET" {
        return Resp::json(200, json!({"apiKey": db.get_setting("smsru_api_key","")}));
    }
    if p == "/api/manager/settings/smsru" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        db.set_setting("smsru_api_key", &bstr(&ctx.body, "apiKey"));
        return Resp::ok();
    }
    if p == "/api/manager/settings/redis" && m == "GET" {
        return Resp::json(200, json!({
            "host": db.get_setting("redis_host","127.0.0.1"),
            "port": db.get_setting("redis_port","6379").parse::<i64>().unwrap_or(6379),
            "password": db.get_setting("redis_password",""),
            "db": db.get_setting("redis_db","0").parse::<i64>().unwrap_or(0),
            "enabled": db.get_setting("redis_enabled","0") == "1",
            "status": redis_status(db)
        }));
    }
    if p == "/api/manager/settings/redis" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        db.set_setting("redis_host", &bstr(&ctx.body, "host"));
        db.set_setting("redis_port", &bstr(&ctx.body, "port"));
        db.set_setting("redis_password", &bstr(&ctx.body, "password"));
        db.set_setting("redis_db", &bstr(&ctx.body, "db"));
        db.set_setting("redis_enabled", if bbool(&ctx.body, "enabled") { "1" } else { "0" });
        let st = redis_status(db);
        return Resp::json(200, json!({"success": true, "status": st}));
    }
    if p == "/api/manager/settings/redis/test" && m == "POST" {
        let host = bstr(&ctx.body, "host");
        let mut port = bstr(&ctx.body, "port");
        if port.is_empty() {
            port = "6379".into();
        }
        return Resp::json(200, json!({"success": tcp_ping(&host, &port)}));
    }
    if p == "/api/manager/settings/pgsql" && m == "GET" {
        return Resp::json(200, json!({
            "host": db.get_setting("pgsql_host","127.0.0.1"),
            "port": db.get_setting("pgsql_port","5432"),
            "database": db.get_setting("pgsql_database","warehouse"),
            "user": db.get_setting("pgsql_user","warehouse"),
            "password": db.get_setting("pgsql_password","")
        }));
    }
    if p == "/api/manager/settings/pgsql" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        for (key, bk) in [
            ("pgsql_host", "host"),
            ("pgsql_port", "port"),
            ("pgsql_database", "database"),
            ("pgsql_user", "user"),
            ("pgsql_password", "password"),
        ] {
            db.set_setting(key, &bstr(&ctx.body, bk));
        }
        return Resp::ok();
    }
    if p == "/api/manager/settings/cache-ttl" && m == "GET" {
        return Resp::json(200, json!({ "ttl": ttl_items(db) }));
    }
    if p == "/api/manager/settings/cache-ttl" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        if let Some(Value::Object(t)) = ctx.body.get("ttl") {
            for (k, _l, _d) in TTL_CATS {
                if let Some(v) = t.get(*k) {
                    let s = if v.is_string() {
                        v.as_str().unwrap_or("").to_string()
                    } else {
                        v.to_string()
                    };
                    db.set_setting(&format!("ttl_{k}"), &s);
                }
            }
        }
        return Resp::ok();
    }
    if p == "/api/manager/settings/logos" && m == "GET" {
        let mut out = Map::new();
        for th in LOGO_THEMES {
            let v = db.get_setting(&format!("logo_{th}"), "");
            out.insert(th.to_string(), if v.is_empty() { Value::Null } else { json!(v) });
        }
        return Resp::json(200, Value::Object(out));
    }
    if p == "/api/manager/settings/logos" && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let mut theme = bstr(&ctx.body, "theme");
        if theme.is_empty() {
            theme = "light".into();
        }
        db.set_setting(&format!("logo_{theme}"), &bstr(&ctx.body, "dataUrl"));
        return Resp::ok();
    }

    // ---- migration / switch ----
    if p == "/api/manager/migration/status" && m == "GET" {
        return Resp::json(200, json!({
            "current": db.backend(),
            "sqlite": {"connected": db.backend() == "sqlite"},
            "pgsql": {"connected": db.backend() == "postgres"}
        }));
    }
    if (p == "/api/manager/migrate/to-pgsql" || p == "/api/manager/migrate/to-sqlite") && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let target = if p.ends_with("to-pgsql") { "postgres" } else { "sqlite" };
        return match do_migrate(db, target) {
            Ok(n) => {
                cache_del_pattern(db, "slots:public:*");
                Resp::json(200, json!({"success": true, "rows": n, "backend": db.backend()}))
            }
            Err(e) => Resp::json(200, json!({"success": false, "error": e})),
        };
    }
    if (p == "/api/manager/switch/to-pgsql" || p == "/api/manager/switch/to-sqlite") && m == "POST" {
        if !is_admin(db, mid) {
            return Resp::err(403, "Доступ только для администраторов");
        }
        let target = if p.ends_with("to-pgsql") { "postgres" } else { "sqlite" };
        return match do_switch(db, target) {
            Ok(()) => {
                cache_del_pattern(db, "slots:public:*");
                Resp::json(200, json!({"success": true, "backend": db.backend()}))
            }
            Err(e) => Resp::json(200, json!({"success": false, "error": e})),
        };
    }

    // ---- data tabs ----
    if p == "/api/manager/check-logs" && m == "GET" {
        let rows = db.query_maps("SELECT * FROM check_logs ORDER BY id DESC LIMIT 200", &[]);
        return Resp::json(200, json!({ "logs": rows }));
    }
    if p == "/api/manager/messages" && m == "GET" {
        let rows = db.query_maps("SELECT m.*, s.date AS slot_date, s.time_start AS slot_time, s.customer_name FROM messages m LEFT JOIN slots s ON s.id=m.slot_id ORDER BY m.id DESC LIMIT 200", &[]);
        return Resp::json(200, json!({ "messages": rows }));
    }
    if p == "/api/manager/nomenclature" && m == "GET" {
        let items = db.query_maps("SELECT * FROM nomenclature ORDER BY name", &[]);
        let cats = db.query_maps("SELECT * FROM categories ORDER BY name", &[]);
        return Resp::json(200, json!({ "items": items, "categories": cats }));
    }
    if p == "/api/manager/c1-orders" && m == "GET" {
        let rows = db.query_maps("SELECT s.*, w.name AS warehouse_name, w.address AS warehouse_address FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE s.is_booked=1 ORDER BY s.date DESC, s.time_start", &[]);
        return Resp::json(200, json!({ "orders": rows }));
    }

    // ---- storekeeper ----
    if p == "/api/storekeeper/slots" && m == "GET" {
        let l = db.query_maps("SELECT s.id,s.date,s.time_start,s.time_end,s.type,s.customer_name,s.customer_phone,s.customer_account,s.customer_organization,s.in_progress,s.assembling,s.completed,s.customer_comment,s.storekeeper_name,w.name AS warehouse_name FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id WHERE (s.in_progress=1 OR s.assembling=1 OR s.completed=1) ORDER BY s.date DESC, s.time_start", &[]);
        let mut active = vec![];
        let mut done = vec![];
        for m2 in l {
            if to_i64(m2.get("completed").unwrap_or(&Value::Null)) == 1 {
                done.push(Value::Object(m2));
            } else {
                active.push(Value::Object(m2));
            }
        }
        return Resp::json(200, json!({ "active": active, "completed": done }));
    }
    if seg.len() == 5 && seg[1] == "storekeeper" && seg[2] == "slots" && m == "POST" {
        return h_storekeeper_action(db, ctx, seg[3], seg[4]);
    }

    Resp::err(404, "not found")
}

// ---- complex handlers ----

fn h_public_slots(db: &mut Db, ctx: &Ctx) -> Resp {
    let date = q(ctx, "date");
    let typ = q(ctx, "type");
    if date.is_empty() || typ.is_empty() {
        return Resp::err(400, "date and type are required");
    }
    if typ != "small" && typ != "bulk" {
        return Resp::err(400, "type must be small or bulk");
    }
    if !is_weekday(&date) && db.get_setting("work_on_weekends", "0") != "1" {
        return Resp::json(200, json!({"slots": [], "weekday": false}));
    }
    let wh = q(ctx, "warehouse_id");
    let cache_key = format!("slots:public:{date}:{typ}:{wh}");

    // В кэш кладём только сырые строки (статус брони). Доступность по времени
    // ("past") считаем заново на каждый запрос, чтобы порог "минимум за час" был
    // точным независимо от TTL кэша (как в Node-варианте).
    let raw: Vec<Map<String, Value>> = if let Some(s) = cache_get(db, &cache_key) {
        serde_json::from_str(&s).unwrap_or_default()
    } else {
        ensure_slots(db, &date, &typ);
        let wh_id: Option<i64> = if wh.is_empty() { None } else { wh.parse::<i64>().ok() };
        let rows = match wh_id {
            Some(id) => db.query_maps("SELECT id,date,type,time_start,time_end,is_booked,confirmed,in_progress,completed,assembling,warehouse_id FROM slots WHERE date=? AND type=? AND warehouse_id=? ORDER BY time_start", &[json!(date), json!(typ), json!(id)]),
            None => db.query_maps("SELECT id,date,type,time_start,time_end,is_booked,confirmed,in_progress,completed,assembling,warehouse_id FROM slots WHERE date=? AND type=? AND warehouse_id IS NULL ORDER BY time_start", &[json!(date), json!(typ)]),
        };
        if cache_enabled(db) {
            cache_set(db, &cache_key, &serde_json::to_string(&rows).unwrap_or_default(), ttl_for(db, "slots_public"));
        }
        rows
    };

    let offset = app_offset_secs(db);
    let now = Utc::now();
    let min_t = now + CDur::hours(1); // свободен только если старт >= чем через час
    let max_t = now + CDur::days(14); // и не дальше 2 недель
    let mut out = vec![];
    for m in &raw {
        let d = m.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let tss = m.get("time_start").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let past = match slot_dt(&d, &tss, offset) {
            Some(sd) => sd < min_t || sd > max_t,
            None => true,
        };
        let mut mm = m.clone();
        mm.insert("past".into(), json!(past));
        out.push(Value::Object(mm));
    }
    Resp::json(200, json!({"slots": out, "weekday": true}))
}

fn h_book(db: &mut Db, sessions: &mut HashMap<String, Session>, ctx: &Ctx, id_str: &str) -> Resp {
    let id: i64 = id_str.parse().unwrap_or(0);
    let name = bstr(&ctx.body, "name");
    let phone = bstr(&ctx.body, "phone");
    if name.is_empty() || phone.is_empty() {
        return Resp::err(400, "name and phone are required");
    }
    let ans = ctx
        .body
        .get("captchaAnswer")
        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(-1);
    {
        let s = sessions.entry(ctx.token.clone()).or_default();
        if !s.has_cap || ans != s.captcha {
            return Resp::err(400, "Invalid captcha answer");
        }
        s.has_cap = false;
    }
    let account = bstr(&ctx.body, "account");
    if db.get_setting("allow_booking_without_account", "1") == "0" && account.is_empty() {
        return Resp::err(400, "Укажите номер счёта");
    }
    if !account.is_empty() {
        let (okk, reason) = validate_1c(db, &account);
        if !okk && db.get_setting("allow_booking_with_invalid_account", "0") != "1" {
            return Resp::json(400, json!({ "error": format!("Счёт не подтверждён в 1С: {reason}") }));
        }
    }
    let row = match db.query_one("SELECT date, time_start, is_booked FROM slots WHERE id=?", &[json!(id)]) {
        Some(r) => r,
        None => return Resp::err(404, "Slot not found"),
    };
    let date = row.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ts = row.get("time_start").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if to_i64(row.get("is_booked").unwrap_or(&Value::Null)) == 1 {
        return Resp::err(409, "Slot already booked");
    }
    let offset = app_offset_secs(db);
    if let Some(sd) = slot_dt(&date, &ts, offset) {
        let now = Utc::now();
        if sd < now + CDur::hours(1) {
            return Resp::err(400, "Слот можно забронировать минимум за 1 час");
        }
        if sd > now + CDur::days(14) {
            return Resp::err(400, "Нельзя записаться на дату более 2 недель");
        }
    }
    let comment = bstr(&ctx.body, "comment");
    let org = bstr(&ctx.body, "organization");
    let vc = bopt_i64(&ctx.body, "vehicleClassId");
    let lt = bopt_i64(&ctx.body, "loadTypeId");
    let aff = db.exec(
        "UPDATE slots SET is_booked=1, customer_name=?, customer_phone=?, customer_account=?, customer_comment=?, customer_organization=?, booked_at=?, customer_ip=?, customer_user_agent=?, vehicle_class_id=?, load_type_id=? WHERE id=? AND is_booked=0",
        &[
            json!(name), json!(phone), nz(&account), nz(&comment), nz(&org),
            json!(now_ts()), json!(ctx.ip), json!(ctx.ua),
            opt_i64_json(vc), opt_i64_json(lt), json!(id),
        ],
    );
    if aff == 0 {
        return Resp::err(409, "Slot already booked");
    }
    cache_del_pattern(db, &format!("slots:public:{date}:*"));
    send_sms(db, &phone, &format!("Вы записаны на {date} {ts}"));
    Resp::ok()
}

fn h_manager_slots(db: &mut Db, ctx: &Ctx) -> Resp {
    let mut where_ = "WHERE 1=1".to_string();
    let mut params: Vec<Value> = vec![];
    let d = q(ctx, "date");
    if !d.is_empty() {
        where_.push_str(" AND s.date=?");
        params.push(json!(d));
    }
    let t = q(ctx, "type");
    if !t.is_empty() {
        where_.push_str(" AND s.type=?");
        params.push(json!(t));
    }
    let wh = q(ctx, "warehouse_id");
    if let Ok(id) = wh.parse::<i64>() {
        where_.push_str(" AND s.warehouse_id=?");
        params.push(json!(id));
    }
    let sql = format!("SELECT s.id,s.date,s.type,s.time_start,s.time_end,s.is_booked,s.confirmed,s.in_progress,s.assembling,s.completed,s.warehouse_id,s.customer_name,s.customer_phone,s.customer_account,s.customer_comment,s.customer_organization,s.storekeeper_name,w.name AS warehouse_name FROM slots s LEFT JOIN warehouses w ON w.id=s.warehouse_id {where_} ORDER BY s.date DESC, s.time_start");
    let rows = db.query_maps(&sql, &params);
    Resp::json(200, json!({ "slots": rows }))
}

fn h_slot_action(db: &mut Db, _ctx: &Ctx, id_str: &str, action: &str) -> Resp {
    let id = idp(id_str);
    let now = json!(now_ts());
    match action {
        "take" | "in-progress" => {
            db.exec("UPDATE slots SET in_progress=1, in_progress_at=? WHERE id=?", &[now, id]);
        }
        "confirm" => {
            db.exec("UPDATE slots SET confirmed=1, confirmed_at=? WHERE id=?", &[now, id]);
        }
        "assemble" => {
            db.exec("UPDATE slots SET assembling=1, assembling_at=? WHERE id=?", &[now, id]);
        }
        "complete" => {
            db.exec("UPDATE slots SET completed=1, completed_at=? WHERE id=?", &[now, id]);
        }
        "return-from-assembly" => {
            db.exec("UPDATE slots SET assembling=0, assembling_at=NULL WHERE id=?", &[id]);
        }
        "cancel" => {
            db.exec("UPDATE slots SET is_booked=0, confirmed=0, in_progress=0, assembling=0, completed=0, customer_name=NULL, customer_phone=NULL, customer_account=NULL, customer_comment=NULL, customer_organization=NULL WHERE id=?", &[id]);
            cache_del_pattern(db, "slots:public:*");
        }
        _ => return Resp::err(400, "unknown action"),
    }
    Resp::ok()
}

fn h_toggle(db: &mut Db, mid: i64, ctx: &Ctx, key: &str, default_on: bool) -> Resp {
    if ctx.method == "GET" {
        let def = if default_on { "1" } else { "0" };
        return Resp::json(200, json!({"enabled": db.get_setting(key, def) == "1"}));
    }
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    let v = if bbool(&ctx.body, "enabled") { "1" } else { "0" };
    db.set_setting(key, v);
    Resp::ok()
}

fn h_text(db: &mut Db, mid: i64, ctx: &Ctx, key: &str) -> Resp {
    if ctx.method == "GET" {
        return Resp::json(200, json!({"text": db.get_setting(key, "")}));
    }
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    db.set_setting(key, &bstr(&ctx.body, "text"));
    Resp::ok()
}

fn save_bool(db: &mut Db, mid: i64, ctx: &Ctx, key: &str, bkey: &str) -> Resp {
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    db.set_setting(key, if bbool(&ctx.body, bkey) { "1" } else { "0" });
    Resp::ok()
}

fn ref_name_desc(db: &mut Db, ctx: &Ctx, table: &str, key: &str) -> Resp {
    if ctx.method == "GET" {
        let rows = db.query_maps(&format!("SELECT * FROM {table} ORDER BY name"), &[]);
        return Resp::json(200, json!({ key: rows }));
    }
    if ctx.method == "POST" {
        let n = bstr(&ctx.body, "name");
        if n.is_empty() {
            return Resp::err(400, "Name is required");
        }
        db.exec(&format!("INSERT INTO {table} (name, description) VALUES (?, ?)"), &[json!(n), json!(bstr(&ctx.body, "description"))]);
        return Resp::ok();
    }
    Resp::err(405, "method not allowed")
}

fn ref_upd_del(db: &mut Db, ctx: &Ctx, table: &str, id: &str, cols: &[&str]) -> Resp {
    match ctx.method.as_str() {
        "PUT" => {
            let mut sets = vec![];
            let mut params: Vec<Value> = vec![];
            for c in cols {
                sets.push(format!("{c}=?"));
                params.push(json!(bstr(&ctx.body, c)));
            }
            params.push(idp(id));
            db.exec(&format!("UPDATE {table} SET {} WHERE id=?", sets.join(", ")), &params);
            Resp::ok()
        }
        "DELETE" => {
            db.exec(&format!("DELETE FROM {table} WHERE id=?"), &[idp(id)]);
            Resp::ok()
        }
        _ => Resp::err(405, "method not allowed"),
    }
}

fn h_manager_create(db: &mut Db, mid: i64, ctx: &Ctx) -> Resp {
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    let un = bstr(&ctx.body, "username");
    let pw = bstr(&ctx.body, "password");
    if un.is_empty() || pw.is_empty() {
        return Resp::err(400, "Username and password are required");
    }
    if db.scalar_i64("SELECT COUNT(*) AS c FROM managers WHERE username=?", "c", &[json!(un)]) > 0 {
        return Resp::err(409, "Username already exists");
    }
    let adm = if bbool(&ctx.body, "isAdmin") { 1 } else { 0 };
    db.exec(
        "INSERT INTO managers (username, password_hash, first_name, last_name, warehouse_id, is_admin) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            json!(un), json!(sha256hex(&pw)),
            json!(bstr(&ctx.body, "firstName")), json!(bstr(&ctx.body, "lastName")),
            opt_i64_json(bopt_i64(&ctx.body, "warehouseId")), json!(adm),
        ],
    );
    Resp::ok()
}

fn h_manager_update(db: &mut Db, mid: i64, ctx: &Ctx, id_str: &str) -> Resp {
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    let id: i64 = id_str.parse().unwrap_or(0);
    let un = bstr(&ctx.body, "username");
    if un.is_empty() {
        return Resp::err(400, "Username is required");
    }
    let cur = match db.query_one("SELECT username FROM managers WHERE id=?", &[json!(id)]) {
        Some(r) => r.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        None => return Resp::err(404, "Manager not found"),
    };
    let mut adm = if bbool(&ctx.body, "isAdmin") { 1 } else { 0 };
    if cur == "admin" {
        adm = 1;
    }
    let pw = bstr(&ctx.body, "password");
    if !pw.is_empty() {
        db.exec(
            "UPDATE managers SET username=?, password_hash=?, first_name=?, last_name=?, warehouse_id=?, is_admin=? WHERE id=?",
            &[json!(un), json!(sha256hex(&pw)), json!(bstr(&ctx.body, "firstName")), json!(bstr(&ctx.body, "lastName")), opt_i64_json(bopt_i64(&ctx.body, "warehouseId")), json!(adm), json!(id)],
        );
    } else {
        db.exec(
            "UPDATE managers SET username=?, first_name=?, last_name=?, warehouse_id=?, is_admin=? WHERE id=?",
            &[json!(un), json!(bstr(&ctx.body, "firstName")), json!(bstr(&ctx.body, "lastName")), opt_i64_json(bopt_i64(&ctx.body, "warehouseId")), json!(adm), json!(id)],
        );
    }
    Resp::ok()
}

fn h_manager_delete(db: &mut Db, mid: i64, id_str: &str) -> Resp {
    if !is_admin(db, mid) {
        return Resp::err(403, "Доступ только для администраторов");
    }
    let id: i64 = id_str.parse().unwrap_or(0);
    if id == mid {
        return Resp::err(400, "Cannot delete yourself");
    }
    let un = match db.query_one("SELECT username FROM managers WHERE id=?", &[json!(id)]) {
        Some(r) => r.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        None => return Resp::err(404, "Manager not found"),
    };
    if un == "admin" {
        return Resp::err(400, "Нельзя удалить главного администратора");
    }
    db.exec("DELETE FROM managers WHERE id=?", &[json!(id)]);
    Resp::ok()
}

fn h_timeseries(db: &mut Db, ctx: &Ctx) -> Resp {
    let interval = q(ctx, "interval");
    let metric = q(ctx, "metric");
    let buckets = make_buckets(&interval);
    let stamps: Vec<String> = if metric == "bookings" {
        db.query_maps("SELECT booked_at FROM slots WHERE booked_at IS NOT NULL", &[])
            .iter()
            .filter_map(|m| m.get("booked_at").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect()
    } else {
        db.query_maps("SELECT visited_at FROM page_visits", &[])
            .iter()
            .filter_map(|m| m.get("visited_at").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect()
    };
    let mut counts = vec![0i64; buckets.len()];
    if !buckets.is_empty() {
        let first = buckets[0].0;
        let last = buckets[buckets.len() - 1].1;
        for s in &stamps {
            if let Some(t) = parse_ts(s) {
                if t < first || t >= last {
                    continue;
                }
                for (i, bk) in buckets.iter().enumerate() {
                    if t >= bk.0 && t < bk.1 {
                        counts[i] += 1;
                        break;
                    }
                }
            }
        }
    }
    let labels: Vec<String> = buckets.iter().map(|b| b.2.clone()).collect();
    Resp::json(200, json!({"interval": interval, "metric": metric, "labels": labels, "counts": counts}))
}

fn h_devices(db: &mut Db) -> Resp {
    let mut counts: HashMap<String, i64> = HashMap::new();
    for k in ["desktop", "mobile", "tablet", "other"] {
        counts.insert(k.to_string(), 0);
    }
    for m in db.query_maps("SELECT device, COUNT(*) AS cnt FROM page_visits GROUP BY device", &[]) {
        let k = m.get("device").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let c = to_i64(m.get("cnt").unwrap_or(&Value::Null));
        if k == "desktop" || k == "mobile" || k == "tablet" {
            *counts.get_mut(&k).unwrap() += c;
        } else {
            *counts.get_mut("other").unwrap() += c;
        }
    }
    let total: i64 = counts.values().sum();
    let categories = json!({
        "desktop": counts["desktop"], "mobile": counts["mobile"],
        "tablet": counts["tablet"], "other": counts["other"]
    });
    let os = device_group(db, "os");
    let browser = device_group(db, "browser");
    Resp::json(200, json!({"total": total, "categories": categories, "os": os, "browser": browser}))
}

fn h_storekeeper_action(db: &mut Db, ctx: &Ctx, id_str: &str, action: &str) -> Resp {
    let pin = bstr(&ctx.body, "pinCode");
    if pin.is_empty() {
        return Resp::err(403, "Неверный PIN");
    }
    let sk = match db.query_one("SELECT name FROM storekeepers WHERE pin_code=?", &[json!(pin)]) {
        Some(r) => r.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        None => return Resp::err(403, "Неверный PIN"),
    };
    let id = idp(id_str);
    match action {
        "assemble" => {
            db.exec("UPDATE slots SET assembling=1, assembling_at=?, storekeeper_name=? WHERE id=?", &[json!(now_ts()), json!(sk), id]);
        }
        "complete" => {
            db.exec("UPDATE slots SET completed=1, completed_at=?, storekeeper_name=? WHERE id=?", &[json!(now_ts()), json!(sk), id]);
        }
        _ => return Resp::err(400, "unknown action"),
    }
    Resp::ok()
}

// pseudo-random for captcha (no rand crate); good enough for a math captcha.
fn pseudo_rand() -> u64 {
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(1) as u64;
    n.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) >> 17
}

// ---------------------------------------------------------------------------
// request handling + main
// ---------------------------------------------------------------------------

fn handle(mut request: Request, db: &mut Db, sessions: &mut HashMap<String, Session>, static_dir: &str, private_dir: &str) {
    let method = match request.method() {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Delete => "DELETE",
        Method::Head => "HEAD",
        Method::Options => "OPTIONS",
        _ => "OTHER",
    }
    .to_string();
    let raw_url = request.url().to_string();
    let (path, query_str) = match raw_url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (raw_url.clone(), String::new()),
    };
    let mut cookie_hdr = String::new();
    let mut ua = String::new();
    let mut xff = String::new();
    for h in request.headers() {
        let f = h.field.as_str().as_str().to_ascii_lowercase();
        match f.as_str() {
            "cookie" => cookie_hdr = h.value.as_str().to_string(),
            "user-agent" => ua = h.value.as_str().to_string(),
            "x-forwarded-for" => xff = h.value.as_str().to_string(),
            _ => {}
        }
    }
    let ip = if !xff.is_empty() {
        xff.split(',').next().unwrap_or("").trim().to_string()
    } else {
        request.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default()
    };

    if needs_ip_gate(&path) && !ip_allowed(db, &ip) {
        let _ = request.respond(Response::from_string("Access denied from this IP").with_status_code(403));
        return;
    }

    if method == "GET" && !path.starts_with("/api/") {
        serve_static(request, &path, static_dir, private_dir);
        return;
    }

    let mut raw_body = String::new();
    if method != "GET" {
        let _ = request.as_reader().read_to_string(&mut raw_body);
    }
    let body: Value = serde_json::from_str(&raw_body).unwrap_or(Value::Null);

    let mut query = HashMap::new();
    for kv in query_str.split('&') {
        if kv.is_empty() {
            continue;
        }
        let (k, v) = match kv.split_once('=') {
            Some(x) => x,
            None => (kv, ""),
        };
        query.insert(urldec(k), urldec(v));
    }

    let mut token = parse_cookie(&cookie_hdr, "wq_sess");
    let mut set_cookie = None;
    if token.is_empty() || !sessions.contains_key(&token) {
        let t = new_token();
        sessions.insert(t.clone(), Session::default());
        set_cookie = Some(format!("wq_sess={t}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax"));
        token = t;
    }

    let ctx = Ctx { method, path, query, body, ip, ua, token };
    let mut resp = route_api(db, sessions, &ctx);
    if resp.set_cookie.is_none() {
        resp.set_cookie = set_cookie;
    }

    let mut response = Response::from_string(resp.body).with_status_code(resp.code);
    if let Ok(h) = Header::from_bytes(b"Content-Type", resp.ctype.as_bytes()) {
        response.add_header(h);
    }
    if let Some(c) = resp.set_cookie {
        if let Ok(h) = Header::from_bytes(b"Set-Cookie", c.as_bytes()) {
            response.add_header(h);
        }
    }
    let _ = request.respond(response);
}

fn spawn_autobackup(backend: String, dsn: String) {
    std::thread::spawn(move || {
        let mut last = Instant::now() - Duration::from_secs(3600);
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let mut bdb = match Db::open(&backend, &dsn) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let iv = bdb.get_setting("autobackup_interval", "0").parse::<u64>().unwrap_or(0);
            if iv == 0 {
                continue;
            }
            if last.elapsed().as_secs() >= iv {
                if write_auto_backup(&mut bdb).is_ok() {
                    last = Instant::now();
                }
            }
        }
    });
}

fn main() {
    let _ = START.set(Instant::now());
    let _ = STARTED.set(now_rfc3339());

    let backend = env("DB_BACKEND", "sqlite");
    let dsn = {
        let d = env("DB_DSN", "");
        if !d.is_empty() {
            d
        } else if backend == "postgres" {
            "postgres://warehouse:warehouse@127.0.0.1:5432/warehouse?sslmode=disable".to_string()
        } else {
            "warehouse.db".to_string()
        }
    };

    let mut db = Db::open(&backend, &dsn).unwrap_or_else(|e| {
        eprintln!("DB open ({backend}): {e}");
        std::process::exit(1);
    });
    db::init_schema(&mut db).expect("schema");
    db::seed(&mut db).expect("seed");

    spawn_autobackup(backend.clone(), dsn.clone());

    let static_dir = env("STATIC_DIR", "../public");
    let private_dir = env("PRIVATE_DIR", "../private");
    let port = env("PORT", "3000");
    let mut sessions: HashMap<String, Session> = HashMap::new();

    let server = Server::http(format!("0.0.0.0:{port}")).unwrap_or_else(|e| {
        eprintln!("listen: {e}");
        std::process::exit(1);
    });
    println!("warehouse-queue-rs ({}) on http://0.0.0.0:{port}", db.backend());

    for request in server.incoming_requests() {
        handle(request, &mut db, &mut sessions, &static_dir, &private_dir);
    }
}
