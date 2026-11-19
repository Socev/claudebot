-- vaultzoek.sql (wv3295, 19-11-2026) — zoeken op betekenis in de vault: schema "vaultzoek" in de eigen Postgres van de pod.
--
-- WAAROM. Cloudflare AI Search (instantie vault) gaat 1-12-2026 factureren (schatting $225,83/mnd, vrijwel alles ingest: elke
-- gewijzigde file elke nacht helemaal opnieuw ingelezen; 0 zoekvragen in 2 weken). David JA 18-11 09:55 (vraag-id 548baeb0):
-- naar onze eigen databank. Ontwerp: vault 01_Ontwikkeling/Zoeken op betekenis in eigen databank (ontwerp 19-11-2026).md.
--
-- PLEK. Liefst een eigen databank (afgeleide data: niet elke nacht in pgdump-offsite.sh, die alleen -d postgres dumpt), maar rol
-- postgres mag geen databank aanmaken (nocreatedb, init-cluster.sql wv3180); dat kan alleen pgbaas via init-cluster.sql bij een
-- nieuwe image-release. Tot dan: schema vaultzoek in "postgres", en het mailarchief (± 75 % van de tekst) blijft buiten de index
-- (vaultzoek-index.py --zonder-mail), zodat de nachtdump hooguit ± 0,2 GB groeit. Verhuizen = \copy naar de nieuwe databank,
-- zonder opnieuw in te bedden (vervolgrij machinekamer:vaultzoek-eigen-databank).
--
-- Idempotent. Toepassen als OS-gebruiker claude (peer → postgres):
--   psql -X -v ON_ERROR_STOP=1 -h /run/pg -U postgres -d postgres -f db/vaultzoek.sql

set client_min_messages = warning;
create schema if not exists vaultzoek;
set search_path = vaultzoek, public;


-- één rij per geïndexeerd bestand; mtime_ns + grootte = "ongewijzigd, overslaan"
create table if not exists bestand (
  pad       text primary key,                 -- vault-relatief, bv. 00_Systeem/Grondwet-kern.md
  mtime_ns  bigint not null,
  grootte   bigint not null,
  brokken   int    not null default 0,
  sig       text,                             -- brokversie:mtime:grootte:poorttreffers; anders = opnieuw knippen
  gezien    timestamptz not null default now()
);

-- inhoud-adresseerbare vectoren: hash = sha256(model + embedtekst). Een ongewijzigd brok (ook als het verschuift of in een ander
-- bestand opduikt) wordt nooit opnieuw ingebed; dat is het hele verschil met AI Search (die las elk gewijzigd bestand helemaal opnieuw).
create table if not exists vector (
  hash      text primary key,
  embedding halfvec(1024) not null,           -- bge-m3, 1024 dims; halfvec = helft van de opslag, zelfde rangorde in de praktijk
  model     text not null,
  tokens    int,
  gemaakt   timestamptz not null default now()
);
create index if not exists vector_hnsw on vector using hnsw (embedding halfvec_cosine_ops);

create table if not exists brok (
  pad   text not null references bestand(pad) on delete cascade,
  nr    int  not null,
  kop   text not null default '',             -- kopregel(s) boven het brok, voor weergave en tekstzoeken
  tekst text not null,
  hash  text not null,
  zoek  tsvector generated always as (to_tsvector('dutch', kop || ' ' || tekst)) stored,
  primary key (pad, nr)
);
create index if not exists brok_hash on brok (hash);
create index if not exists brok_zoek on brok using gin (zoek);
alter table bestand add column if not exists sig text;

-- verbruik per UTC-dag (Cloudflare telt het gratis dagtegoed van 10.000 neurons per UTC-dag)
create table if not exists verbruik (
  dag     date primary key,
  neurons numeric not null default 0,
  tokens  bigint  not null default 0,
  brokken int     not null default 0
);

-- Zoeken: hybride (vector + Postgres-tekstzoeken op dezelfde brokken), gecombineerd met reciprocal rank fusion (k = 60).
-- p_vec = '[f1,…,f1024]' (tekst) of null (dan alleen tekst); p_vraag = de vraag; p_n = aantal brokken terug.
-- Alleen lezen (STABLE); score = cosinus-gelijkenis van het vectordeel (0 als het brok alleen via tekst binnenkwam).
create or replace function vaultzoek.zoek(p_vec text, p_vraag text, p_n int, p_tekstgewicht real default 0.25)
returns table (pad text, nr int, kop text, tekst text, score real, rrf real, via text)
language plpgsql stable
set search_path = vaultzoek, public, pg_catalog
set hnsw.ef_search = 100
as $f$
#variable_conflict use_column
declare
  tq tsquery;
  qv halfvec(1024);
begin
  begin
    -- woorden OF-en: een vraag in gewone taal bevat zelden álle woorden van het brok
    tq := nullif(replace(plainto_tsquery('dutch', coalesce(p_vraag, ''))::text, '&', '|'), '')::tsquery;
  exception when others then tq := null;
  end;
  if p_vec is not null then qv := p_vec::halfvec(1024); end if;
  return query
  with v as (
    select x.hash, (1 - (x.embedding <=> qv))::real as sim
    from vector x
    where qv is not null
    order by x.embedding <=> qv
    limit greatest(p_n * 4, 40)
  ), vb as (
    select b.pad, b.nr, v.sim, row_number() over (order by v.sim desc, b.pad, b.nr) as r
    from v join brok b on b.hash = v.hash
  ), t as (
    select b.pad, b.nr, row_number() over (order by ts_rank_cd(b.zoek, tq) desc, b.pad, b.nr) as r
    from brok b
    where tq is not null and b.zoek @@ tq
    order by ts_rank_cd(b.zoek, tq) desc
    limit greatest(p_n * 4, 40)
  ), samen as (
    select coalesce(vb.pad, t.pad) as pad, coalesce(vb.nr, t.nr) as nr, coalesce(vb.sim, 0)::real as sim,
           (coalesce(1.0 / (60 + vb.r), 0) + p_tekstgewicht * coalesce(1.0 / (60 + t.r), 0))::real as rrf,
           case when vb.pad is not null and t.pad is not null then 'beide' when vb.pad is not null then 'vector' else 'tekst' end as via
    from vb full join t on t.pad = vb.pad and t.nr = vb.nr
  )
  select s.pad, s.nr, b.kop, b.tekst, s.sim, s.rrf, s.via
  from samen s join brok b on b.pad = s.pad and b.nr = s.nr
  order by s.rrf desc, s.sim desc
  limit p_n;
end
$f$;

revoke all on schema vaultzoek from public;
revoke all on all tables in schema vaultzoek from public;
drop function if exists vaultzoek.zoek(text, text, int);
revoke all on function vaultzoek.zoek(text, text, int, real) from public;
