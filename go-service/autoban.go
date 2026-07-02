package main

import (
	"strings"
	"sync"
	"time"
)

// Автоблокировки IP: записи в banned_ips с префиксом autoBanPrefix истекают
// через autoBanHours часов (проверяется по created_at). Ручные баны — бессрочные.
const autoBanPrefix = "Автоблокировка"
const autoBanHours = 24

var (
	captchaFails = map[string]int{}
	cfMu         sync.Mutex
)

func incCaptchaFail(ip string) int {
	cfMu.Lock()
	defer cfMu.Unlock()
	captchaFails[ip]++
	return captchaFails[ip]
}

func resetCaptchaFail(ip string) {
	cfMu.Lock()
	defer cfMu.Unlock()
	delete(captchaFails, ip)
}

func scalarInt(q string, args ...any) int {
	var n int
	db.row(q, args...).Scan(&n)
	return n
}

// ipBanActive — активен ли бан IP (с учётом истечения авто-банов).
func ipBanActive(ip string) bool {
	if ip == "" {
		return false
	}
	var reason, created string
	if err := db.row("SELECT reason, created_at FROM banned_ips WHERE ip=? ORDER BY id DESC LIMIT 1", ip).Scan(&reason, &created); err != nil {
		return false
	}
	if strings.HasPrefix(reason, autoBanPrefix) {
		if t, e := time.ParseInLocation("2006-01-02 15:04:05", created, time.Local); e == nil {
			if time.Since(t) >= autoBanHours*time.Hour {
				db.ex("DELETE FROM banned_ips WHERE ip=?", ip)
				return false
			}
		}
	}
	return true
}

// ipInAllowedNetworks — входит ли IP хотя бы в одну из разрешённых сетей
// (пустой список = не входит).
func ipInAllowedNetworks(ip string) bool {
	rows, _ := queryMaps("SELECT network FROM allowed_networks")
	for _, m := range rows {
		if n, ok := m["network"].(string); ok && ipMatch(ip, n) {
			return true
		}
	}
	return false
}

func autoBanIP(ip, reason string) {
	if ip == "" {
		return
	}
	if scalarInt("SELECT COUNT(*) FROM banned_ips WHERE ip=?", ip) == 0 {
		db.ex("INSERT INTO banned_ips (ip, reason, created_at) VALUES (?, ?, ?)", ip, reason, nowTS())
	}
}

func isLoopback(ip string) bool {
	return ip == "" || ip == "127.0.0.1" || ip == "::1"
}
