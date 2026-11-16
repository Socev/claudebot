-- init-cluster.sql (wv3180) — rollen van de eigen databank, idempotent. Draait als superuser pgbaas (socket-peer van OS-gebruiker pg)
set client_min_messages = warning;
-- bij elke start van db-wacht.sh. Ontwerp: 01_Ontwikkeling/Databank naar Olares en R230 - ontwerp (16-11-2026).md § 1.
-- Rol postgres is GEEN superuser (zoals bij Supabase): SECURITY DEFINER-functies van postgres krijgen zo niet meer macht dan nu.
\set ON_ERROR_STOP on
do $$
declare r text;
begin
  foreach r in array array['postgres','anon','authenticated','service_role','authenticator','zd_lezer','kluis_lezer','kluis_eigenaar',
                           'supabase_admin','dashboard_user','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin',
                           'supabase_replication_admin','supabase_read_only_user','supabase_etl_admin','supabase_privileged_role','pgbouncer']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
end $$;
-- inloggen kan alleen postgres en authenticator, en alleen via de socket met peer claude (pg_hba.conf + pg_ident.conf)
alter role postgres      login nosuperuser createrole bypassrls nocreatedb noreplication inherit;
alter role authenticator login nosuperuser nocreaterole nobypassrls noinherit;
alter role anon          nologin nobypassrls inherit;
alter role authenticated nologin nobypassrls inherit;
alter role service_role  nologin bypassrls inherit;
alter role zd_lezer      nologin noinherit;
alter role kluis_lezer   nologin inherit;   -- inherit: anders telt pg_read_server_files niet (gemeten)
alter role kluis_eigenaar nologin noinherit;
-- plaatshouders: komen voor in grants/default-ACL's van de dump, kunnen niets
alter role supabase_admin nologin nosuperuser nocreaterole nobypassrls;
do $$
declare r text;
begin
  foreach r in array array['dashboard_user','supabase_auth_admin','supabase_storage_admin','supabase_realtime_admin','supabase_replication_admin',
                           'supabase_read_only_user','supabase_etl_admin','supabase_privileged_role','pgbouncer']
  loop execute format('alter role %I nologin nosuperuser nocreaterole nobypassrls noreplication', r); end loop;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role, authenticator to postgres with admin option;
grant zd_lezer to postgres;
grant pg_read_all_data, pg_monitor, pg_signal_backend to postgres;
grant pg_read_server_files to kluis_lezer with inherit true;
-- rolinstellingen zoals bij Supabase (gemeten 16-11 in pg_db_role_setting); safeupdate bestaat niet in PGDG: de luik weigert
-- PATCH/DELETE zonder filter (db-luik.js)
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
alter role authenticator set lock_timeout = '8s';
alter role postgres set search_path = "$user", public, extensions;
