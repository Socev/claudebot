#!/usr/bin/env bash
# test/db-rook.sh <image> (wv3180) — rooktest van de eigen databank IN het gebouwde image (CI, na de build):
# db-wacht.sh als root → postgres als pg + init-SQL; sb-sql als claude (rol postgres, geen superuser, 5 extensies, kluis-schema);
# socev en 127.0.0.1 geweigerd; PostgREST + db-luik met een wegwerpsleutel: /health ok, zonder sleutel 401, met sleutel 200.
set -u
IMAGE="$1"; C=rooktest-db
rood=0; ok(){ if [ "$1" = 0 ]; then echo "  OK    $2"; else echo "  ROOD  $2"; rood=$((rood+1)); fi; }
docker rm -f $C >/dev/null 2>&1 || true
# wv3187: met een (wegwerp)replicatiewachtwoord, zodat init-reserve.sql de rol reserve en het slot r230 aanmaakt
RW="rookreserve$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker run -d --name $C -e RW="$RW" --entrypoint /bin/bash "$IMAGE" -c 'mkdir -p /opt/data/bin /opt/data/.pg && printf "%s" "$RW" > /opt/data/.pg/reserve.wachtwoord && chmod 600 /opt/data/.pg/reserve.wachtwoord && chown -R claude:claude /opt/data/.pg && chown claude:claude /opt/data /opt/data/bin && mkdir -p /opt/data/pg/wal-archief && printf oud | zstd -q > /opt/data/pg/wal-archief/0000000100000000000000AA.zst && chown pg:pg /opt/data/pg/wal-archief/0000000100000000000000AA.zst && chmod 0640 /opt/data/pg/wal-archief/0000000100000000000000AA.zst && /app/db/db-wacht.sh & exec sleep 600' >/dev/null
for i in $(seq 1 60); do docker exec $C grep -q "init-SQL toegepast" /opt/data/pg/db-wacht.log 2>/dev/null && break; sleep 1; done
docker exec $C cat /opt/data/pg/db-wacht.log 2>/dev/null | tail -5
docker exec $C grep -q "init-SQL toegepast" /opt/data/pg/db-wacht.log; ok $? "db-wacht: initdb, postgres op, init-SQL toegepast"
# B103 (Codex MOET 1): de stand van db-wacht (root schrijft de eerste, pg de rest) is leesbaar voor claude via groep pgsock
for i in $(seq 1 20); do docker exec -u claude $C grep -q '"stand":"draait"' /run/pgstand/stand 2>/dev/null && break; sleep 1; done
docker exec -u claude $C grep -q '"stand":"draait"' /run/pgstand/stand; ok $? "db-wacht-stand draait, leesbaar als claude (groep pgsock)"
U=$(docker exec -u claude $C sh -c "echo \"select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su, (select count(*) from pg_extension where extname in ('vector','pg_trgm','pgcrypto','uuid-ossp','pg_stat_statements'))::int as ext, (select count(*) from pg_proc where pronamespace = 'vault'::regnamespace)::int as kluis, (select usename from pg_stat_activity where pid = pg_backend_pid()) as via\" | /app/sb-sql" 2>&1)
echo "  sb-sql: $U"
[ "$U" = '[{"u":"postgres","su":false,"ext":5,"kluis":3,"via":"postgres"}]' ]; ok $? "sb-sql als claude: rol postgres, geen superuser, 5 extensies, 3 kluisfuncties"
# wv3202: rol postgres is eigenaar van de databank (zoals bij Supabase) → CREATE op databank en public; de kluis blijft dicht voor service_role
E=$(docker exec -u claude $C sh -c "echo \"select (select datdba::regrole::text from pg_database where datname = current_database()) as eig, has_database_privilege('postgres','postgres','CREATE') as db, has_schema_privilege('postgres','public','CREATE') as pub, has_table_privilege('service_role','vault.decrypted_secrets','SELECT') as sr_kluis, (select nspowner::regrole::text from pg_namespace where nspname = 'vault') as vault_eig, (select relowner::regrole::text from pg_class where oid = 'vault.decrypted_secrets'::regclass) as view_eig\" | /app/sb-sql" 2>&1)
echo "  eigenaar: $E"
[ "$E" = '[{"eig":"postgres","db":true,"pub":true,"sr_kluis":false,"vault_eig":"kluis_eigenaar","view_eig":"kluis_eigenaar"}]' ]; ok $? "wv3202: postgres eigenaar databank, CREATE op databank + public; service_role niet in vault.decrypted_secrets; kluis van kluis_eigenaar"
F=$(docker exec -u claude $C sh -c "echo \"create function public.rook_ddl() returns int language sql as 'select 1'; drop function public.rook_ddl(); select 'ok' as r\" | /app/sb-sql" 2>&1)
[ "$F" = '[{"r":"ok"}]' ]; ok $? "wv3202: sb-sql (rol postgres) mag een functie in public maken en weghalen ($F)"
docker exec -u socev $C /usr/lib/postgresql/17/bin/psql -X -h /run/pg -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "socev kan niet inloggen (socket)"
docker exec -u socev $C /usr/lib/postgresql/17/bin/psql -X -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "socev kan niet inloggen (127.0.0.1)"
docker exec -u claude $C /usr/lib/postgresql/17/bin/psql -X -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "ook claude niet via 127.0.0.1 (alleen socket-peer)"
docker exec -u claude $C /usr/lib/postgresql/17/bin/psql -X -h /run/pg -U pgbaas -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "claude kan geen superuser pgbaas worden"
# wv3187: reserve — rol alleen REPLICATION, slot r230, replicatie via 127.0.0.1 met wachtwoord ja, gewone verbinding als reserve nee,
# wachtwoord nergens in de log
docker exec $C grep -q "reserve-SQL toegepast" /opt/data/pg/db-wacht.log; ok $? "init-reserve.sql toegepast"
R=$(docker exec -u claude $C sh -c "echo \"select (select rolreplication::text||rolsuper::text||rolcanlogin::text from pg_roles where rolname='reserve') as r, (select count(*) from pg_replication_slots where slot_name='r230' and slot_type='physical')::int as s\" | /app/sb-sql" 2>&1)
[ "$R" = '[{"r":"truefalsetrue","s":1}]' ]; ok $? "rol reserve (replication, geen superuser) + slot r230 ($R)"
# wv3408 (B01): slotruimte voor dagen R230-uitval (64GB) en geen geforceerde segmentwissel per minuut (300 s)
W=$(docker exec -u claude $C sh -c "echo \"select (select setting from pg_settings where name='max_slot_wal_keep_size') as keep, (select setting from pg_settings where name='archive_timeout') as at\" | /app/sb-sql" 2>&1)
[ "$W" = '[{"keep":"65536","at":"300"}]' ]; ok $? "wv3408: max_slot_wal_keep_size 64GB, archive_timeout 300 s ($W)"
docker exec -e PGPASSWORD="$RW" $C /usr/lib/postgresql/17/bin/psql -X -At "host=127.0.0.1 user=reserve replication=true dbname=postgres" -c IDENTIFY_SYSTEM >/dev/null 2>&1; ok $? "replicatie als reserve via 127.0.0.1 met wachtwoord"
docker exec -e PGPASSWORD="$RW" $C /usr/lib/postgresql/17/bin/psql -X -At "host=127.0.0.1 user=reserve dbname=postgres" -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "reserve kan geen gewone databankverbinding openen"
docker exec -e PGPASSWORD=fout $C /usr/lib/postgresql/17/bin/psql -X -At "host=127.0.0.1 user=reserve replication=true dbname=postgres" -c IDENTIFY_SYSTEM >/dev/null 2>&1; [ $? != 0 ]; ok $? "fout wachtwoord geweigerd"
docker exec $C sh -c "cat /opt/data/pg/db-wacht.log /opt/data/pg/log/* 2>/dev/null" | grep -qF "$RW"; [ $? != 0 ]; ok $? "wachtwoord niet in db-wacht.log of de postgres-log"
# wv3389 (A09): het ALTER ROLE met het wachtwoord komt niet in pg_stat_statements (ook niet in zijn tekstbestand in de datamap)
N=$(docker exec -u pg $C /usr/lib/postgresql/17/bin/psql -X -At -h /run/pg -U pgbaas -d postgres -c "select count(*) from extensions.pg_stat_statements where query ~* 'alter\s+role\s+reserve' or strpos(query, '$RW') > 0" 2>&1)
[ "$N" = 0 ]; ok $? "wv3389: geen 'alter role reserve' of wachtwoord in pg_stat_statements ($N)"
docker exec $C sh -c "grep -rqaF '$RW' /opt/data/pg/17/data/pg_stat_tmp /opt/data/pg/17/data/pg_stat 2>/dev/null"; [ $? != 0 ]; ok $? "wv3389: wachtwoord niet in pg_stat_tmp/pg_stat"
P=$(docker exec $C stat -c '%U:%G %a' /run/pg /opt/data/pg/17/data | tr '\n' ' ')
[ "$P" = "pg:pgsock 750 pg:pg 700 " ]; ok $? "rechten socketmap en datamap ($P)"
P=$(docker exec $C stat -c '%U:%G %a' /opt/data/pg/terug /run/pgstop | tr '\n' ' ')
[ "$P" = "claude:pgsock 2750 claude:claude 711 " ]; ok $? "wv3241: ontvangstmap terug (claude schrijft, pg leest) en verzoekmap ($P)"
docker exec -u claude $C sh -c 'umask 077; mkdir -p /opt/data/.pg && head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > /opt/data/.pg/jwt.key && K=sb_secret_rooktest_$(head -c 8 /dev/urandom | od -An -tx1 | tr -d " \n") && printf "%s" "$K" > /tmp/k && H=$(printf "%s" "$K" | sha256sum | cut -c1-64) && printf "{\"sleutels\":[{\"naam\":\"rook\",\"rol\":\"service_role\",\"sha256\":\"%s\"}]}" "$H" > /opt/data/.pg/luik-sleutels.json && (nohup /usr/local/bin/postgrest /app/db/postgrest.conf > /tmp/pgrst.log 2>&1 &) && (nohup node /app/db/db-luik.js > /tmp/luik.log 2>&1 &)'
for i in $(seq 1 30); do docker exec $C curl -fsS -m 2 http://127.0.0.1:8091/health >/dev/null 2>&1 && break; sleep 1; done
docker exec $C curl -fsS -m 3 http://127.0.0.1:8091/health; echo
docker exec $C curl -fsS -m 3 http://127.0.0.1:8091/health >/dev/null 2>&1; ok $? "luik /health: postgres + PostgREST op"
S=$(docker exec $C curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8091/rest/v1/); [ "$S" = 401 ]; ok $? "zonder sleutel 401 ($S)"
S=$(docker exec -u claude $C sh -c 'curl -s -o /dev/null -w "%{http_code}" -m 5 -H "apikey: $(cat /tmp/k)" http://127.0.0.1:8091/rest/v1/'); [ "$S" = 200 ]; ok $? "met sleutel 200 via PostgREST ($S)"
# wv3869: WAL-archief leesbaar voor claude (groep pgsock): een oud pg:pg-bestand krijgt bij de start groep pgsock (root-deel
# db-wacht), en een vers gearchiveerd segment (pg_switch_wal als pgbaas) staat er niet leeg, 0640 pg:pgsock en leesbaar als claude
P=$(docker exec $C stat -c '%U:%G %a' /opt/data/pg/wal-archief/0000000100000000000000AA.zst)
[ "$P" = "pg:pgsock 640" ]; ok $? "wv3869: oud archiefbestand na de start pg:pgsock 640 ($P)"
docker exec -u pg $C /usr/lib/postgresql/17/bin/psql -X -At -h /run/pg -U pgbaas -d postgres -c "create table rook_wal(x int); insert into rook_wal values (1); select pg_switch_wal(); drop table rook_wal" >/dev/null 2>&1
for i in $(seq 1 30); do [ -n "$(docker exec $C find /opt/data/pg/wal-archief -maxdepth 1 -name '0*.zst' ! -name '*AA.zst' -size +0 2>/dev/null)" ] && break; sleep 1; done
P=$(docker exec -u claude $C sh -c 'for f in $(find /opt/data/pg/wal-archief -maxdepth 1 -name "0*.zst" ! -name "*AA.zst"); do printf "%s " "$(stat -c "%U:%G %a" "$f")"; zstd -q -t "$f" && printf "leesbaar "; done')
echo "  archief: $P"
case "$P" in "pg:pgsock 640 leesbaar"*) r=0;; *) r=1;; esac; ok $r "wv3869: vers WAL-segment 0640 pg:pgsock, als claude leesbaar"
docker run --rm -u claude -v "$PWD:/src:ro" --entrypoint bash "$IMAGE" /src/test/wal-archief.sh /app/db/wal-archief.sh; ok $? "wv3869: test/wal-archief.sh in het image als claude"
[ $rood -gt 0 ] && { echo "-- pgrst.log"; docker exec $C tail -20 /tmp/pgrst.log; echo "-- db-wacht.log"; docker exec $C tail -30 /opt/data/pg/db-wacht.log; }
docker rm -f $C >/dev/null 2>&1 || true
echo "db-rook: $rood rood"; [ $rood = 0 ]
