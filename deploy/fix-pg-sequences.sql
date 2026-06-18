-- One-off fix for an already-migrated PostgreSQL database:
-- resync every SERIAL `id` sequence to MAX(id) so new INSERTs don't collide
-- with rows copied (with their ids) during migration.
--
-- Run once:
--   PGPASSWORD=<pass> psql -h 127.0.0.1 -U <user> -d <db> -f deploy/fix-pg-sequences.sql
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name AS t,
           pg_get_serial_sequence(quote_ident(c.table_name), 'id') AS seq
    FROM information_schema.columns c
    WHERE c.column_name = 'id'
      AND c.table_schema = 'public'
  LOOP
    IF r.seq IS NOT NULL THEN
      EXECUTE format(
        'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1), EXISTS(SELECT 1 FROM %I))',
        r.seq, r.t, r.t);
    END IF;
  END LOOP;
END $$;
