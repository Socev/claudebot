#!/usr/bin/env node
/*
 * db-vergelijk.js (wv3180) — vergelijkt twee databanken na een dump/herstel (ontwerp § 4). Elk verschil = stop.
 *
 *   node db-vergelijk.js manifest <uit.json> [verbinding] [--snapshot-export <bestand>]
 *   node db-vergelijk.js vergelijk <bron.json> <doel.json>
 *
 * Verbinding: --socket <map> --db <naam> --rol <rol> (lokaal, peer), of --host/--port/--user/--db met PGPASSWORD uit de omgeving
 * en --ssl (zoals sslmode=require). --snapshot-export: opent een REPEATABLE READ-transactie, schrijft pg_export_snapshot() naar het
 * bestand, wacht tot <bestand>.klaar bestaat (pg_dump --snapshot is dan klaar) en meet in DEZELFDE momentopname.
 *
 * Manifest (alleen namen, tellingen en md5's; nooit rij-inhoud): per tabel aantal rijen + rijhash (md5 over de gesorteerde md5's
 * van rij::text, vaste sessie-instellingen), kolommen, eigenaar, RLS-vlaggen, policies, indexen, triggers, constraints, grants
 * (aclexplode, genormaliseerd), per functie md5(pg_get_functiondef) + eigenaar + grants, views, sequences (last_value), schema-grants,
 * default-ACL's, extensies. Objecten die bij een extensie horen tellen niet mee (extensies apart; versieverschil = melding, geen stop
 * als het in --toegestaan staat).
 * Uitvoer vergelijk: JSON {verschillen: n, ...}; exit 0 alleen bij 0 verschillen.
 */
'use strict';
const fs = require('fs');
const pg = require('pg');

const SCHEMAS = ['public', 'secondbrain', 'machinekamer', 'facturen', 'zorgdata', 'sb2_proef', 'supabase_migrations'];

function arg(argv, n, std) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : std; }
function slaap(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function manifest(argv) {
  const uit = argv[1];
  const cfg = { application_name: 'db-vergelijk', options: '-c TimeZone=UTC -c statement_timeout=0' };
  if (arg(argv, '--socket')) { cfg.host = arg(argv, '--socket'); cfg.port = parseInt(arg(argv, '--port', '5432'), 10); }
  else { cfg.host = arg(argv, '--host'); cfg.port = parseInt(arg(argv, '--port', '5432'), 10); }
  cfg.database = arg(argv, '--db', 'postgres');
  cfg.user = arg(argv, '--rol') || arg(argv, '--user');
  if (argv.includes('--ssl')) cfg.ssl = { rejectUnauthorized: false };
  // de Supabase-pooler cachet rollen: de eerste aanmelding na een nieuwe rol kan falen ("invalid role OID"); drie pogingen
  let c = null, laatste = null;
  for (let i = 0; i < 3 && !c; i++) {
    const k = new pg.Client(cfg);
    try { await k.connect(); c = k; } catch (e) { laatste = e; try { await k.end(); } catch (x) {} await slaap(3000); }
  }
  if (!c) throw laatste;
  const q = async function (sql, p) { return (await c.query(sql, p || [])).rows; };
  await q("set extra_float_digits = 1; set datestyle = 'ISO, MDY'; set intervalstyle = 'postgres'; set bytea_output = 'hex'; set row_security = off");
  await q('begin isolation level repeatable read read only');
  const exp = arg(argv, '--snapshot-export');
  if (exp) {
    const s = (await q('select pg_export_snapshot() as s'))[0].s;
    fs.writeFileSync(exp, s);
    for (let i = 0; i < 1200 && !fs.existsSync(exp + '.klaar'); i++) await slaap(500);
    if (!fs.existsSync(exp + '.klaar')) throw new Error('geen .klaar binnen 10 min');
  }
  const m = { gemaakt: new Date().toISOString(), tabellen: {}, functies: {}, views: {}, sequences: {}, schemas: {}, default_acl: {}, extensies: {} };
  const ext = "not exists (select 1 from pg_depend d where d.classid = $C::regclass and d.objid = $O and d.deptype = 'e')";
  const extRel = ext.replace('$C', "'pg_class'").replace('$O', 'c.oid');
  const extFn = ext.replace('$C', "'pg_proc'").replace('$O', 'p.oid');
  // NULL-ACL = standaardrechten van de eigenaar (acldefault); pg_dump laat een expliciete eigenaar-ACL weg, dus vergelijk genormaliseerd
  const acl = function (kol, soort, eig) {
    const bron = soort ? 'coalesce(' + kol + ', acldefault(' + soort + ', ' + eig + '))' : kol;
    return "coalesce((select string_agg(x, ',' order by x) from (select pg_get_userbyid(a.grantor) || '>' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type || (case when a.is_grantable then '*' else '' end) as x from aclexplode(" + bron + ") a) s), '-')";
  };
  const tab = await q("select c.oid, n.nspname || '.' || c.relname as naam, c.relkind, pg_get_userbyid(c.relowner) as eig, c.relrowsecurity as rls, c.relforcerowsecurity as frls, " + acl('c.relacl', "case when c.relkind = 'S' then 's'::\"char\" else 'r'::\"char\" end", 'c.relowner') + " as acl " +
    "from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = any($1) and c.relkind in ('r','p','v','m','S','f') and " + extRel + " order by 2", [SCHEMAS]);
  for (const t of tab) {
    const kol = await q("select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || case when attnotnull then ' nn' else '' end || coalesce(' d=' || pg_get_expr(d.adbin, d.adrelid), '') || case when attgenerated <> '' then ' g' else '' end || case when attidentity <> '' then ' i' || attidentity::text else '' end, '|' order by attnum) as k from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped", [t.oid]);
    const basis = { soort: t.relkind, eigenaar: t.eig, acl: t.acl, kolommen: kol[0].k };
    if (t.relkind === 'r' || t.relkind === 'p') {
      const qn = t.naam.split('.').map(function (x) { return '"' + x.replace(/"/g, '""') + '"'; }).join('.');
      const r = (await q('select count(*)::bigint as n, md5(coalesce(string_agg(h, \'\' order by h), \'\')) as h from (select md5(t::text) as h from ' + qn + ' t) x'))[0];
      const pol = await q("select string_agg(polname || ':' || polcmd::text || ':' || polpermissive::text || ':' || coalesce(array_to_string(array(select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r) end from unnest(polroles) r order by 1), ','), '') || ':' || coalesce(pg_get_expr(polqual, polrelid), '') || ':' || coalesce(pg_get_expr(polwithcheck, polrelid), ''), '|' order by polname) as p from pg_policy where polrelid = $1", [t.oid]);
      const idx = await q("select string_agg(pg_get_indexdef(indexrelid), '|' order by pg_get_indexdef(indexrelid)) as i from pg_index where indrelid = $1", [t.oid]);
      const trg = await q("select string_agg(pg_get_triggerdef(oid), '|' order by pg_get_triggerdef(oid)) as t from pg_trigger where tgrelid = $1 and not tgisinternal", [t.oid]);
      const con = await q("select string_agg(conname || ' ' || case when contype = 'c' then regexp_replace(pg_get_constraintdef(oid), '[()[:space:]]', '', 'g') else pg_get_constraintdef(oid) end, '|' order by conname) as c from pg_constraint where conrelid = $1", [t.oid]);
      Object.assign(basis, { rijen: String(r.n), rijhash: r.h, rls: t.rls, force_rls: t.frls, policies: pol[0].p || '', indexen: idx[0].i || '', triggers: trg[0].t || '', constraints: con[0].c || '' });
      m.tabellen[t.naam] = basis;
    } else if (t.relkind === 'v' || t.relkind === 'm') {
      const v = await q('select pg_get_viewdef($1::oid) as d', [t.oid]);
      basis.def = v[0].d; m.views[t.naam] = basis;
    } else if (t.relkind === 'S') {
      const qn = t.naam.split('.').map(function (x) { return '"' + x.replace(/"/g, '""') + '"'; }).join('.');
      const s = (await q('select last_value::text as l, is_called from ' + qn))[0];
      m.sequences[t.naam] = { eigenaar: t.eig, acl: t.acl, last_value: s.l, is_called: s.is_called };
    } else { m.tabellen[t.naam] = basis; }
  }
  const fn = await q("select p.oid::regprocedure::text as naam, pg_get_userbyid(p.proowner) as eig, p.prosecdef as sd, " + acl('p.proacl', "'f'::\"char\"", 'p.proowner') + " as acl, md5(pg_get_functiondef(p.oid)) as h " +
    "from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any($1) and p.prokind in ('f','p') and " + extFn + " order by 1", [SCHEMAS]);
  fn.forEach(function (f) { m.functies[f.naam] = { eigenaar: f.eig, security_definer: f.sd, acl: f.acl, def_md5: f.h }; });
  const sch = await q("select nspname as n, pg_get_userbyid(nspowner) as eig, " + acl('nspacl', "'n'::\"char\"", 'nspowner') + " as acl from pg_namespace where nspname = any($1) order by 1", [SCHEMAS]);
  sch.forEach(function (s) { m.schemas[s.n] = { eigenaar: s.eig, acl: s.acl }; });
  const da = await q("select pg_get_userbyid(defaclrole) || '/' || coalesce(defaclnamespace::regnamespace::text, '*') || '/' || defaclobjtype::text as k, " + acl('defaclacl') + " as acl from pg_default_acl where defaclnamespace = 0 or defaclnamespace::regnamespace::text = any($1) order by 1", [SCHEMAS]);
  da.forEach(function (d) { m.default_acl[d.k] = d.acl; });
  const ex = await q("select e.extname as n, e.extversion as v, n.nspname as s from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('vector','pg_trgm','pgcrypto','uuid-ossp','pg_stat_statements') order by 1");
  ex.forEach(function (e) { m.extensies[e.n] = { versie: e.v, schema: e.s }; });
  await q('commit');
  await c.end();
  fs.writeFileSync(uit, JSON.stringify(m), { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, tabellen: Object.keys(m.tabellen).length, functies: Object.keys(m.functies).length, views: Object.keys(m.views).length,
    sequences: Object.keys(m.sequences).length, rijen: Object.values(m.tabellen).reduce(function (a, t) { return a + (t.rijen ? Number(t.rijen) : 0); }, 0) }));
}

function vergelijk(argv) {
  const a = JSON.parse(fs.readFileSync(argv[1], 'utf8'));
  const b = JSON.parse(fs.readFileSync(argv[2], 'utf8'));
  const toegestaan = String(arg(argv, '--toegestaan', '') || '').split(',').filter(Boolean);   // bv. ext:vector
  const uit = { verschillen: 0, per_soort: {}, voorbeelden: [], toegestane_verschillen: [] };
  const telVerschil = function (soort, naam, veld) {
    uit.verschillen++; uit.per_soort[soort] = (uit.per_soort[soort] || 0) + 1;
    if (uit.voorbeelden.length < 40) uit.voorbeelden.push(soort + ' ' + naam + (veld ? ' [' + veld + ']' : ''));
  };
  ['tabellen', 'functies', 'views', 'sequences', 'schemas', 'default_acl'].forEach(function (soort) {
    const x = a[soort] || {}, y = b[soort] || {};
    new Set(Object.keys(x).concat(Object.keys(y))).forEach(function (k) {
      if (!(k in x)) return telVerschil(soort, k, 'alleen in doel');
      if (!(k in y)) return telVerschil(soort, k, 'alleen in bron');
      const vx = x[k], vy = y[k];
      if (typeof vx !== 'object' || vx === null) { if (JSON.stringify(vx) !== JSON.stringify(vy)) telVerschil(soort, k); return; }
      Object.keys(Object.assign({}, vx, vy)).forEach(function (veld) {
        if (soort === 'sequences' && veld === 'last_value') { if (BigInt(vy.last_value) < BigInt(vx.last_value)) telVerschil(soort, k, 'last_value lager'); return; }
        if (JSON.stringify(vx[veld]) !== JSON.stringify(vy[veld])) telVerschil(soort, k, veld);
      });
    });
  });
  Object.keys(Object.assign({}, a.extensies, b.extensies)).forEach(function (e) {
    const x = (a.extensies || {})[e], y = (b.extensies || {})[e];
    if (!x || !y || x.schema !== y.schema) return telVerschil('extensies', e, 'ontbreekt of ander schema');
    if (x.versie !== y.versie) {
      if (toegestaan.includes('ext:' + e)) uit.toegestane_verschillen.push(e + ' ' + x.versie + ' → ' + y.versie);
      else telVerschil('extensies', e, 'versie ' + x.versie + ' → ' + y.versie);
    }
  });
  uit.tabellen = Object.keys(a.tabellen || {}).length;
  uit.rijen_bron = Object.values(a.tabellen || {}).reduce(function (s, t) { return s + (t.rijen ? Number(t.rijen) : 0); }, 0);
  uit.rijen_doel = Object.values(b.tabellen || {}).reduce(function (s, t) { return s + (t.rijen ? Number(t.rijen) : 0); }, 0);
  console.log(JSON.stringify(uit, null, 1));
  process.exit(uit.verschillen === 0 ? 0 : 1);
}

(async function () {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'manifest' && argv[1]) await manifest(argv);
    else if (argv[0] === 'vergelijk' && argv[2]) vergelijk(argv);
    else { console.error('gebruik: manifest <uit.json> [--socket … --db … --rol …] | vergelijk <bron.json> <doel.json> [--toegestaan ext:vector]'); process.exit(2); }
  } catch (e) { console.error(JSON.stringify({ fout: String(e && e.message || e).slice(0, 500) })); process.exit(1); }
})();
