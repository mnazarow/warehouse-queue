# Быстрый запуск

## 1. Минимальный (разработка)

```bash
cd warehouse-queue
npm install
node server.js
```

Кабинет: `http://localhost:3000/manager.html`  
Логин: `admin`, пароль: `admin123`

---

## 2. Продакшн (через deploy.sh)

```bash
cd warehouse-queue
chmod +x deploy.sh

# Без домена — http://localhost
sudo ./deploy.sh --systemd

# С доменом — https://example.com
sudo ./deploy.sh --systemd --domain example.com
```

> DNS-запись A/AAAA для домена должна указывать на IP сервера **до** запуска скрипта.

---

## 3. Флаги deploy.sh

| Флаг | Что делает |
|------|-----------|
| `--systemd` | Установить как systemd-сервис (автозапуск) |
| `--domain foo.com` | Nginx + SSL-сертификат (Let's Encrypt) |
| `--staging` | Тестовый SSL-сертификат |
| `--port 8080` | Сменить внутренний порт (по умолч. 3000) |
| `--no-pg` | Пропустить проверку PostgreSQL |
| `--no-redis` | Пропустить проверку Redis |
| `--no-nginx` | Пропустить nginx/certbot |

---

## 4. Что куда нажимать

| Действие | Где |
|----------|-----|
| Сменить тему | ☀️ / 💀 / 🌙 в правом верхнем углу |
| Включить Redis | Настройки → Redis → чекбокс |
| Переключить БД | Настройки → PostgreSQL → Мигрировать → Переключиться |
| Изменить пароль | settings → ключ `admin_password` |
| Свои логотипы | `public/logos/{light,dark,cyberpunk}.png` |

---

## 5. Типовые команды

```bash
# Статус сервиса
sudo systemctl status warehouse-queue

# Логи
sudo journalctl -u warehouse-queue -f

# Рестарт
sudo systemctl restart warehouse-queue

# Остановка (без systemd)
screen -S warehouse -X quit
```
