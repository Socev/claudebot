-- init-reserve.sql (wv3187) — replicatierol `reserve` en fysiek replicatieslot `r230` voor de warme reserve op de R230
-- (ontwerp databank § 5). Draait als superuser pgbaas na init-cluster/init-db, bij elke start van db-wacht.sh, idempotent.
-- Het wachtwoord staat in $PG_RESERVE_PW (0400 pg; db-wacht.sh kopieert het uit /opt/data/.pg/reserve.wachtwoord). Zonder dat
-- bestand gebeurt er niets: geen rol, geen slot (het slot houdt WAL vast; max_slot_wal_keep_size 4GB begrenst dat).
-- De rol mag alleen repliceren: pg_hba.conf laat hem alleen toe als `host replication reserve 127.0.0.1/32 scram-sha-256`
-- (de tunnel vanaf de R230 komt binnen op 127.0.0.1). Het wachtwoord komt nooit in een log (log_statement none).
set client_min_messages = warning;
\set ON_ERROR_STOP on
\set heeft_pw `f="${PG_RESERVE_PW:-/opt/data/pg/reserve.pw}"; if [ -s "$f" ]; then echo true; else echo false; fi`
\if :heeft_pw
  \set pw `cat "${PG_RESERVE_PW:-/opt/data/pg/reserve.pw}"`
  select 'create role reserve' where not exists (select 1 from pg_roles where rolname = 'reserve') \gexec
  alter role reserve login replication nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 3 password :'pw';
  \unset pw
  -- \gexec: een functie in FROM zou ook bij een bestaand slot draaien (filter komt pas erna)
  select 'select slot_name as slot_aangemaakt from pg_create_physical_replication_slot(''r230'', true)'
   where not exists (select 1 from pg_replication_slots where slot_name = 'r230') \gexec
\endif
