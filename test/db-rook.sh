#!/usr/bin/env bash
# test/db-rook.sh <image> (wv3180) — rooktest van de eigen databank IN het gebouwde image (CI, na de build):
# db-wacht.sh als root → postgres als pg + init-SQL; sb-sql als claude (rol postgres, geen superuser, 5 extensies, kluis-schema);
# socev en 127.0.0.1 geweigerd; PostgREST + db-luik met een wegwerpsleutel: /health ok, zonder sleutel 401, met sleutel 200.
set -u
IMAGE="$1"; C=rooktest-db
rood=0; ok(){ if [ "$1" = 0 ]; then echo "  OK    $2"; else echo "  ROOD  $2"; rood=$((rood+1)); fi; }
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --name $C --entrypoint /bin/bash "$IMAGE" -c 'mkdir -p /opt/data/bin && chown claude:claude /opt/data /opt/data/bin && /app/db/db-wacht.sh & exec sleep 600' >/dev/null
for i in $(seq 1 60); do docker exec $C grep -q "init-SQL toegepast" /opt/data/pg/db-wacht.log 2>/dev/null && break; sleep 1; done
docker exec $C cat /opt/data/pg/db-wacht.log 2>/dev/null | tail -5
docker exec $C grep -q "init-SQL toegepast" /opt/data/pg/db-wacht.log; ok $? "db-wacht: initdb, postgres op, init-SQL toegepast"
U=$(docker exec -u claude $C sh -c "echo \"select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as su, (select count(*) from pg_extension where extname in ('vector','pg_trgm','pgcrypto','uuid-ossp','pg_stat_statements'))::int as ext, (select count(*) from pg_proc where pronamespace = 'vault'::regnamespace)::int as kluis, (select usename from pg_stat_activity where pid = pg_backend_pid()) as via\" | /app/sb-sql" 2>&1)
echo "  sb-sql: $U"
[ "$U" = '[{"u":"postgres","su":false,"ext":5,"kluis":3,"via":"postgres"}]' ]; ok $? "sb-sql als claude: rol postgres, geen superuser, 5 extensies, 3 kluisfuncties"
docker exec -u socev $C /usr/lib/postgresql/17/bin/psql -X -h /run/pg -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "socev kan niet inloggen (socket)"
docker exec -u socev $C /usr/lib/postgresql/17/bin/psql -X -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "socev kan niet inloggen (127.0.0.1)"
docker exec -u claude $C /usr/lib/postgresql/17/bin/psql -X -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "ook claude niet via 127.0.0.1 (alleen socket-peer)"
docker exec -u claude $C /usr/lib/postgresql/17/bin/psql -X -h /run/pg -U pgbaas -d postgres -c 'select 1' >/dev/null 2>&1; [ $? != 0 ]; ok $? "claude kan geen superuser pgbaas worden"
P=$(docker exec $C stat -c '%U:%G %a' /run/pg /opt/data/pg/17/data | tr '\n' ' ')
[ "$P" = "pg:pgsock 750 pg:pg 700 " ]; ok $? "rechten socketmap en datamap ($P)"
docker exec -u claude $C sh -c 'umask 077; mkdir -p /opt/data/.pg && head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > /opt/data/.pg/jwt.key && K=sb_secret_rooktest_$(head -c 8 /dev/urandom | od -An -tx1 | tr -d " \n") && printf "%s" "$K" > /tmp/k && H=$(printf "%s" "$K" | sha256sum | cut -c1-64) && printf "{\"sleutels\":[{\"naam\":\"rook\",\"rol\":\"service_role\",\"sha256\":\"%s\"}]}" "$H" > /opt/data/.pg/luik-sleutels.json && (nohup /usr/local/bin/postgrest /app/db/postgrest.conf > /tmp/pgrst.log 2>&1 &) && (nohup node /app/db/db-luik.js > /tmp/luik.log 2>&1 &)'
for i in $(seq 1 30); do docker exec $C curl -fsS -m 2 http://127.0.0.1:8091/health >/dev/null 2>&1 && break; sleep 1; done
docker exec $C curl -fsS -m 3 http://127.0.0.1:8091/health; echo
docker exec $C curl -fsS -m 3 http://127.0.0.1:8091/health >/dev/null 2>&1; ok $? "luik /health: postgres + PostgREST op"
S=$(docker exec $C curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:8091/rest/v1/); [ "$S" = 401 ]; ok $? "zonder sleutel 401 ($S)"
S=$(docker exec -u claude $C sh -c 'curl -s -o /dev/null -w "%{http_code}" -m 5 -H "apikey: $(cat /tmp/k)" http://127.0.0.1:8091/rest/v1/'); [ "$S" = 200 ]; ok $? "met sleutel 200 via PostgREST ($S)"
[ $rood -gt 0 ] && { echo "-- pgrst.log"; docker exec $C tail -20 /tmp/pgrst.log; echo "-- db-wacht.log"; docker exec $C tail -30 /opt/data/pg/db-wacht.log; }
docker rm -f $C >/dev/null 2>&1 || true
echo "db-rook: $rood rood"; [ $rood = 0 ]
