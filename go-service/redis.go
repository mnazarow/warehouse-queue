package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Minimal Redis (RESP) client — no external dependencies. Enough for
// GET / SET (EX) / DEL / KEYS, which is all the cache layer needs.

type redisConn struct {
	mu   sync.Mutex
	conn net.Conn
	r    *bufio.Reader
	addr string
	pass string
	dbn  int
}

var (
	rdsMu sync.Mutex
	rds   *redisConn
)

func cacheEnabled() bool { return db.getSetting("redis_enabled", "0") == "1" }

func redisAddr() string {
	host := db.getSetting("redis_host", "127.0.0.1")
	port := db.getSetting("redis_port", "6379")
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "6379"
	}
	return net.JoinHostPort(host, port)
}

// getRedis returns a live connection, reconnecting if config changed or the
// socket died. Returns nil if Redis is unreachable (caller degrades to no cache).
func getRedis() *redisConn {
	rdsMu.Lock()
	defer rdsMu.Unlock()
	addr := redisAddr()
	pass := db.getSetting("redis_password", "")
	dbn := atoiDef(db.getSetting("redis_db", "0"), 0)
	if rds != nil && rds.conn != nil && rds.addr == addr && rds.pass == pass && rds.dbn == dbn {
		return rds
	}
	if rds != nil && rds.conn != nil {
		rds.conn.Close()
	}
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		rds = nil
		return nil
	}
	rc := &redisConn{conn: c, r: bufio.NewReader(c), addr: addr, pass: pass, dbn: dbn}
	if pass != "" {
		if _, err := rc.do("AUTH", pass); err != nil {
			c.Close()
			rds = nil
			return nil
		}
	}
	if dbn != 0 {
		rc.do("SELECT", strconv.Itoa(dbn))
	}
	rds = rc
	return rc
}

func (rc *redisConn) do(args ...string) (any, error) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.conn == nil {
		return nil, fmt.Errorf("redis: not connected")
	}
	rc.conn.SetDeadline(time.Now().Add(2 * time.Second))
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	if _, err := rc.conn.Write([]byte(b.String())); err != nil {
		rc.conn.Close()
		rc.conn = nil
		return nil, err
	}
	v, err := readReply(rc.r)
	if err != nil {
		rc.conn.Close()
		rc.conn = nil
	}
	return v, err
}

func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if line == "" {
		return nil, fmt.Errorf("redis: empty reply")
	}
	switch line[0] {
	case '+', ':':
		return line[1:], nil
	case '-':
		return nil, fmt.Errorf("redis: %s", line[1:])
	case '$':
		n, _ := strconv.Atoi(line[1:])
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, _ := strconv.Atoi(line[1:])
		if n < 0 {
			return nil, nil
		}
		arr := make([]any, n)
		for i := 0; i < n; i++ {
			arr[i], err = readReply(r)
			if err != nil {
				return nil, err
			}
		}
		return arr, nil
	}
	return line, nil
}

// ---- cache helpers ----

func cacheGet(key string) (string, bool) {
	if !cacheEnabled() {
		return "", false
	}
	rc := getRedis()
	if rc == nil {
		return "", false
	}
	v, err := rc.do("GET", key)
	if err != nil || v == nil {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func cacheSet(key, val string, ttl int) {
	if !cacheEnabled() {
		return
	}
	rc := getRedis()
	if rc == nil {
		return
	}
	if ttl > 0 {
		rc.do("SET", key, val, "EX", strconv.Itoa(ttl))
	} else {
		rc.do("SET", key, val)
	}
}

func cacheDelPattern(pattern string) {
	if !cacheEnabled() {
		return
	}
	rc := getRedis()
	if rc == nil {
		return
	}
	v, err := rc.do("KEYS", pattern)
	if err != nil {
		return
	}
	if arr, ok := v.([]any); ok {
		for _, k := range arr {
			if ks, ok := k.(string); ok {
				rc.do("DEL", ks)
			}
		}
	}
}

// ttlFor returns the configured TTL (seconds) for a cache category.
func ttlFor(cat string) int {
	for _, c := range ttlCats {
		if c.key == cat {
			if s := db.getSetting("ttl_"+c.key, ""); s != "" {
				return atoiDef(s, c.def)
			}
			return c.def
		}
	}
	return 30
}
