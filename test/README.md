# Тесты

Запуск (npm-пакеты в песочнице недоступны, поэтому express/redis/better-sqlite3
заменены заглушками из `test/_stubs/node_modules`):

```bash
# 1. Тесты, которым не нужен сервер
node test/passwords.test.js     # хеширование паролей, совместимость со старыми хешами
node test/timezone.test.js      # часовые пояса складов

# 2. Тесты по HTTP: сначала поднимаем сервер на заглушках
rm -f /tmp/sec_test.db*
NODE_PATH=test/_stubs/node_modules node test/_stubs/server_e2e.js &
sleep 5
node test/security.test.js      # 27 проверок безопасности
node test/permissions.test.js   # 29 проверок прав доступа и маскировки секретов
node test/regression.test.js    # 23 проверки рабочих сценариев
```

Порядок важен: `security.test.js` намеренно упирается в защиту от перебора
пароля, поэтому запускайте его на свежей базе.

На боевом сервере, где установлены настоящие express и better-sqlite3,
заглушки не нужны — достаточно поднять приложение и указать в тестах порт.
