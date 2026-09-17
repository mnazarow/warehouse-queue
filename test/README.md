# Тесты

Запуск (npm-пакеты в песочнице недоступны, поэтому express/redis/better-sqlite3
заменены заглушками из `test/_stubs/node_modules`):

```bash
# 1. Тесты, которым не нужен сервер
node test/passwords.test.js     # хеширование паролей, совместимость со старыми хешами
node test/timezone.test.js      # часовые пояса складов и разбор отметок времени

# 2. Тесты по HTTP: сначала поднимаем сервер на заглушках
rm -f /tmp/sec_test.db*
NODE_PATH=test/_stubs/node_modules node test/_stubs/server_e2e.js &
sleep 5
node test/security.test.js      # 27 проверок безопасности
node test/permissions.test.js   # 29 проверок прав доступа и маскировки секретов
node test/orgtime.test.js       # 14 проверок организаций из 1С и времени отметок
node test/warehouse-categories.test.js   # 20 проверок категорий товаров у складов
node test/cache.test.js         # 15 проверок инвалидации кэша справочников
node test/regression.test.js    # 23 проверки рабочих сценариев
```

## 3. Прогон с включённым кэшем (Redis)

Заглушка Redis хранит данные по-настоящему, поэтому тот же набор тестов можно
прогнать «как в бою» — с включённым кэшем. Так ловятся ошибки инвалидации:
именно из-за одной такой добавленная категория не появлялась в справочнике ещё
5 минут, и казалось, что кнопка «+ Категория» не работает.

```bash
rm -f /tmp/cache_test.db*
DB_PATH=/tmp/cache_test.db PORT=4997 E2E_REDIS=1 \
  NODE_PATH=test/_stubs/node_modules node test/_stubs/server_e2e.js &
sleep 5
for t in security permissions orgtime warehouse-categories cache regression; do
  DB_PATH=/tmp/cache_test.db E2E_PORT=4997 node test/$t.test.js
done
```

Порт и путь к базе во всех тестах берутся из `E2E_PORT` и `DB_PATH`.

Порядок важен: `security.test.js` намеренно упирается в защиту от перебора
пароля, поэтому запускайте его на свежей базе.

На боевом сервере, где установлены настоящие express и better-sqlite3,
заглушки не нужны — достаточно поднять приложение и указать в тестах порт.
