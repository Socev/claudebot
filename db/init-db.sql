-- init-db.sql (wv3180) — objecten per databank, idempotent; als pgbaas in elke databank die de pod gebruikt (postgres, proef: verhuis_proef).
set client_min_messages = warning;
-- Extensies in schema extensions (vector in public), stubs voor auth.role()/uid()/jwt(), de kluis (vervanger van supabase_vault, § 3)
-- en het herlaadsignaal voor PostgREST.
\set ON_ERROR_STOP on
create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension if not exists pgcrypto schema extensions;
create extension if not exists "uuid-ossp" schema extensions;
create extension if not exists pg_trgm schema extensions;
create extension if not exists pg_stat_statements schema extensions;
create extension if not exists vector schema public;
alter default privileges in schema extensions grant execute on functions to postgres, anon, authenticated, service_role;
grant execute on all functions in schema extensions to postgres, anon, authenticated, service_role;
grant usage on schema public to postgres, anon, authenticated, service_role;

-- auth: alleen de drie leesfuncties die PostgREST-aanroepen gebruiken (definitie als Supabase; wij hebben geen Auth-gebruikers)
create schema if not exists auth;
grant usage on schema auth to postgres, anon, authenticated, service_role;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant execute on function auth.role(), auth.uid(), auth.jwt() to postgres, anon, authenticated, service_role;

-- ── Kluis (§ 3): zelfde vorm als supabase_vault 0.3.1, versleuteld met pgp_sym_encrypt (aes256). De sleutel staat BUITEN de databank
-- (bestand uit GUC socev.kluis_pad, 64 hex); alleen vault._sleutel() (eigenaar kluis_lezer) leest hem. Dumps/WAL bevatten alleen cijfertekst.
create schema if not exists vault authorization kluis_eigenaar;
alter schema vault owner to kluis_eigenaar;
grant usage on schema vault to postgres, service_role;
-- Codex MOET 3: de SECURITY DEFINER-functies (eigenaar kluis_eigenaar) roepen pgp_sym_* in schema extensions aan
grant usage on schema extensions to kluis_eigenaar;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default current_timestamp,
  updated_at timestamptz not null default current_timestamp);
alter table vault.secrets owner to kluis_eigenaar;
create unique index if not exists secrets_name_idx on vault.secrets (name) where name is not null;

create or replace function vault._sleutel() returns text language plpgsql stable security definer set search_path = '' as $$
declare
  p text := current_setting('socev.kluis_pad', true);
  k text;
begin
  if p is null or p = '' then raise exception 'kluis: socev.kluis_pad is niet ingesteld'; end if;
  k := pg_catalog.btrim(pg_catalog.pg_read_file(p), E' \n\r\t');
  if k !~ '^[0-9a-f]{64}$' then raise exception 'kluis: sleutelbestand heeft een onverwachte vorm'; end if;
  return k;
end $$;
alter function vault._sleutel() owner to kluis_lezer;
revoke all on function vault._sleutel() from public;
grant execute on function pg_catalog.pg_read_file(text) to kluis_lezer;
grant execute on function vault._sleutel() to postgres, kluis_eigenaar;
grant execute on function extensions.pgp_sym_encrypt_bytea(bytea, text, text), extensions.pgp_sym_decrypt_bytea(bytea, text) to kluis_eigenaar;

create or replace view vault.decrypted_secrets with (security_barrier) as
  select s.id, s.name, s.description, s.secret,
         pg_catalog.convert_from(extensions.pgp_sym_decrypt_bytea(pg_catalog.decode(s.secret, 'base64'), vault._sleutel()), 'utf8') as decrypted_secret,
         s.key_id, s.nonce, s.created_at, s.updated_at
    from vault.secrets s;
alter view vault.decrypted_secrets owner to kluis_eigenaar;

create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  insert into vault.secrets (secret, name, description)
  values (pg_catalog.encode(extensions.pgp_sym_encrypt_bytea(pg_catalog.convert_to(new_secret, 'utf8'), vault._sleutel(), 'cipher-algo=aes256'), 'base64'),
          new_name, new_description)
  returning id into v;
  return v;
end $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null,
                                               new_key_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update vault.secrets s
     set secret = case when new_secret is null then s.secret
                       else pg_catalog.encode(extensions.pgp_sym_encrypt_bytea(pg_catalog.convert_to(new_secret, 'utf8'), vault._sleutel(), 'cipher-algo=aes256'), 'base64') end,
         name = coalesce(new_name, s.name),
         description = coalesce(new_description, s.description),
         updated_at = now()
   where s.id = secret_id;
end $$;
alter function vault.create_secret(text, text, text, uuid) owner to kluis_eigenaar;
alter function vault.update_secret(uuid, text, text, text, uuid) owner to kluis_eigenaar;
revoke all on function vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid) from public;
grant execute on function vault.create_secret(text, text, text, uuid), vault.update_secret(uuid, text, text, text, uuid) to postgres, service_role;
-- rechten zoals bij Supabase (postgres r/d/D/x, service_role r/d), behalve: de ontsleutelde view alleen voor postgres (service_role heeft geen
-- SQL-ingang; PostgREST toont vault niet)
revoke all on vault.secrets, vault.decrypted_secrets from public;
grant select, delete, truncate, references on vault.secrets to postgres;
grant select, delete on vault.secrets to service_role;
grant select, delete, truncate, references on vault.decrypted_secrets to postgres;

-- PostgREST herlaadt zijn schemacache na DDL (patroon uit de PostgREST-docs)
create or replace function extensions.pgrst_ddl_herlaad() returns event_trigger language plpgsql as $$
begin
  notify pgrst, 'reload schema';
end $$;
do $$ begin
  if not exists (select 1 from pg_event_trigger where evtname = 'pgrst_ddl_herlaad') then
    create event trigger pgrst_ddl_herlaad on ddl_command_end execute function extensions.pgrst_ddl_herlaad();
  end if;
  if not exists (select 1 from pg_event_trigger where evtname = 'pgrst_drop_herlaad') then
    create event trigger pgrst_drop_herlaad on sql_drop execute function extensions.pgrst_ddl_herlaad();
  end if;
end $$;

-- globale standaardrechten voor functies van postgres zoals bij Supabase (gemeten 16-11: EXECUTE alleen postgres + service_role,
-- niet PUBLIC); pg_dump -n neemt deze databank-brede regel niet mee
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to service_role;
