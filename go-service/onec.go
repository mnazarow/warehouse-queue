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
	// 1С использует HTTP Basic (логин/пароль) и поле "invoce_number" (с опечаткой —
	// именно так названо поле в API 1С). Контракт совпадает с Node-вариантом.
	username := db.getSetting("1c_username", "")
	password := db.getSetting("1c_password", "")
	reqBody, _ := json.Marshal(map[string]any{"invoce_number": []string{account}})
	req, err := http.NewRequest("POST", url, bytes.NewReader(reqBody))
	if err != nil {
		logCheck(account, false, 0, "", err.Error(), url, string(reqBody))
		return true, "" // не блокируем бронь из-за ошибки формирования запроса
	}
	req.Header.Set("Content-Type", "application/json")
	if username != "" || password != "" {
		req.SetBasicAuth(username, password)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logCheck(account, false, 0, "", err.Error(), url, string(reqBody))
		return true, "" // 1С недоступна → fail-open (как в Node)
	}
	defer resp.Body.Close()
	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	respText := string(bodyBytes)

	var parsed map[string]any
	if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
		logCheck(account, false, resp.StatusCode, respText, "Parse error", url, string(reqBody))
		return true, "" // не разобрали ответ → не блокируем
	}
	results, ok := parsed["results"].(map[string]any)
	if !ok {
		logCheck(account, false, resp.StatusCode, respText, "No results field", url, string(reqBody))
		return true, "" // нет поля results → проверка пропущена
	}
	// Счёт валиден, если статус начинается с "found"/"найден" (без учёта регистра).
	allFound := true
	for _, v := range results {
		rm, _ := v.(map[string]any)
		st, _ := rm["status"].(string)
		s := strings.ToLower(strings.TrimSpace(st))
		if !strings.HasPrefix(s, "found") && !strings.HasPrefix(s, "найден") {
			allFound = false
		}
	}
	logCheck(account, allFound, resp.StatusCode, respText, "", url, string(reqBody))
	if allFound {
		return true, ""
	}
	return false, "счёт не найден в 1С"
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
