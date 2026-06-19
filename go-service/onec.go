package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// validate1CAccount checks a customer account/order against the configured 1C
// endpoint. If no endpoint is configured it allows the booking (returns true).
// Every attempt is logged to check_logs, mirroring the Node service.
func validate1CAccount(account string) (bool, string) {
	url := db.getSetting("1c_order_validation_url", "")
	if url == "" {
		return true, "" // 1C not configured → do not block booking
	}
	token := db.getSetting("1c_api_token", "")
	reqBody, _ := json.Marshal(map[string]any{"account": account, "accounts": []string{account}})
	req, err := http.NewRequest("POST", url, bytes.NewReader(reqBody))
	if err != nil {
		logCheck(account, false, 0, "", err.Error(), url, string(reqBody))
		return false, "ошибка запроса"
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logCheck(account, false, 0, "", err.Error(), url, string(reqBody))
		// Network error talking to 1C: do not hard-block unless admin disallowed invalid.
		return false, "1С недоступна"
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	respText := string(bodyBytes)
	ok := resp.StatusCode == 200
	// Treat explicit negative payloads as failure even on HTTP 200.
	low := strings.ToLower(respText)
	if ok && (strings.Contains(low, `"valid":false`) || strings.Contains(low, `"found":false`) || strings.Contains(low, `"ready":false`)) {
		ok = false
	}
	logCheck(account, ok, resp.StatusCode, respText, "", url, string(reqBody))
	if ok {
		return true, ""
	}
	return false, "счёт не найден"
}

func logCheck(accounts string, success bool, status int, respBody, errStr, url, reqBody string) {
	s := 0
	if success {
		s = 1
	}
	db.ex("INSERT INTO check_logs (accounts, success, response_status, response_body, error, url, request_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		accounts, s, status, trunc(respBody, 4000), errStr, url, trunc(reqBody, 4000), nowTS())
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
