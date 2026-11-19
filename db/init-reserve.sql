-- init-reserve.sql (wv3187) — replicatierol `reserve` en fysiek replicatieslot `r230` voor de warme reserve op de R230
-- (ontwerp databank § 5). Draait als superuser pgbaas na init-cluster/init-db, bij elke start van db-wacht.sh, idempotent.
-- Het wachtwoord staat in $PG_RESERVE_PW (0400 pg; db-wacht.sh kopieert het uit /opt/data/.pg/reserve.wachtwoord). Zonder dat
-- bestand gebeurt er niets: geen rol, geen slot (het slot houdt WAL vast; max_slot_wal_keep_size 64GB begrenst dat).
-- De rol mag alleen repliceren: pg_hba.conf laat hem alleen toe als `host replication reserve 127.0.0.1/32 scram-sha-256`
-- (de tunnel vanaf de R230 komt binnen op 127.0.0.1). Het wachtwoord komt nooit in een log (log_statement none).
set client_min_messages = warning;
\set ON_ERROR_STOP on
\set heeft_pw `f="${PG_RESERVE_PW:-/opt/data/pg/reserve.pw}"; if [ -s "$f" ]; then echo true; else echo false; fi`
-- wv3389 (A09, actieplan 19-11): het ALTER ROLE hieronder bevat het wachtwoord letterlijk. pg_stat_statements (track_utility
-- staat cluster-breed aan) bewaarde die opdracht met wachtwoord en al, ook in zijn tekstbestand in de datamap. Daarom hier, alleen
-- voor deze sessie van superuser pgbaas, het bijhouden van utility-opdrachten uit. Geen rotatie: het wachtwoord blijft hetzelfde.
set pg_stat_statements.track_utility = off;
\if :heeft_pw
  \set pw `cat "${PG_RESERVE_PW:-/opt/data/pg/reserve.pw}"`
  select 'create role reserve' where not exists (select 1 from pg_roles where rolname = 'reserve') \gexec
  alter role reserve login replication nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 3 password :'pw';
  \unset pw
  -- \gexec: een functie in FROM zou ook bij een bestaand slot draaien (filter komt pas erna)
  select 'select slot_name as slot_aangemaakt from pg_create_physical_replication_slot(''r230'', true)'
   where not exists (select 1 from pg_replication_slots where slot_name = 'r230') \gexec
\endif
-- wv3389 (A09): een rij die een oudere versie van dit script (of een oude kopie van de datamap) achterliet, gaat weg. Volledige reset,
-- want een gerichte reset laat de tekst in het pgss-tekstbestand (pg_stat_tmp) staan tot een herstart; dit gebeurt alleen als er
-- zo'n rij is (normaal 0: dan blijft de statistiek staan). Zonder de extensie in deze databank: niets.
-- (altijd precies één rij: \gset zonder rij is een fout en zou met ON_ERROR_STOP het script laten falen)
select coalesce(max(n.nspname), '') as pgss_schema, count(*) > 0 as heeft_pgss
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements' \gset
\if :heeft_pgss
  select format($f$select %1$I.pg_stat_statements_reset() as pgss_reset_wegens_reservewachtwoord
                   where exists (select 1 from %1$I.pg_stat_statements where query ~* 'alter\s+role\s+reserve')$f$, :'pgss_schema') \gexec
\endif
