package main

import (
	"strconv"
	"strings"
)

// splitIds разбирает CSV-строку id складов в срез положительных int.
func splitIds(csv string) []int {
	out := []int{}
	for _, p := range strings.Split(csv, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// mgrWarehouseIds нормализует список складов менеджера: возвращает CSV,
// «основной» склад (первый) и срез id.
func mgrWarehouseIds(ids []int, single *int) (string, *int, []int) {
	seen := map[int]bool{}
	out := []int{}
	for _, v := range ids {
		if v > 0 && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	if len(out) == 0 && single != nil && *single > 0 {
		out = []int{*single}
	}
	parts := make([]string, len(out))
	for i, v := range out {
		parts[i] = strconv.Itoa(v)
	}
	var primary *int
	if len(out) > 0 {
		p := out[0]
		primary = &p
	}
	return strings.Join(parts, ","), primary, out
}

func intersectInts(a, b []int) []int {
	m := map[int]bool{}
	for _, x := range b {
		m[x] = true
	}
	out := []int{}
	for _, x := range a {
		if m[x] {
			out = append(out, x)
		}
	}
	return out
}
