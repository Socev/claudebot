'use strict';
// Intake-plek: tellingen per bron en entiteit (wv1244, OVIS M1d; ontwerplijnen § 2.1 rij Intake, Fable #19).
// Tot OVIS Intake echt draait toont de plek Intake alleen HOEVEEL er binnenkwam, vandaag en deze week, uit de logs die er al zijn:
//   - secondbrain.mail_verwerkt (Gmail en Outlook, via de RPC public.ovis_intake_telling: alleen bron/account/entiteit/dag/aantal);
//   - het facturen-postvak (facturen.sqlite, tabel bericht; entiteit van de factuur als die er is);
//   - raw_input in de vault (bestanden die nu wachten, en wat daarvan vandaag of deze week binnenkwam, op aankomsttijd op de pod);
//   - de nieuwe aanleverweg (intake.sqlite, stuk; schaduw: telt dubbel met de bronnen hierboven).
// Nooit een onderwerp, afzender, bestandsnaam of id: de SQL selecteert die kolommen niet en de uitvoer heeft er geen veld voor.
// Op een apparaat met een vaste plek valt de entiteit privé weg (ook uit de totalen).
const fs = require('fs');
const path = require('path');

const TZ = 'Europe/Amsterdam';
const CACHE_MS = 60000;
const MAX_BESTANDEN = 5000;   // per raw_input-map; daarboven telt hij niet verder (vlag afgekapt)

function dagVan(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
// maandag van de week (Amsterdam) als JJJJ-MM-DD; rekent op de kalenderdatum, dus zomertijd speelt niet mee
function maandagVan(dag) {
  const d = new Date(dag + 'T12:00:00Z');
  const wd = (d.getUTCDay() + 6) % 7;   // ma = 0
  return new Date(d.getTime() - wd * 86400000).toISOString().slice(0, 10);
}

// één vaste set codes, zodat Gmail, facturen en de vault dezelfde entiteit dezelfde naam geven
const ENTITEIT_ALIAS = { praktijkhouders_bv: 'phbv', 'praktijkhouders bv': 'phbv', 'ghawa-ecg': 'ghawa', pot_poh_ggz: 'pot', _inbox: 'inbox', '': 'onbekend' };
function entiteitCode(x) {
  const s = String(x == null ? '' : x).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ENTITEIT_ALIAS, s)) return ENTITEIT_ALIAS[s];
  return /^[a-z0-9_-]{1,40}$/.test(s) ? s : 'onbekend';
}

// raw_input-mappen → entiteit (alleen de mapnaam, nooit wat erin staat)
function rawMappen(vault) {
  const uit = [];
  const voeg = (rel, ent) => { const p = path.join(vault, rel); try { if (fs.statSync(p).isDirectory()) uit.push({ pad: p, entiteit: ent }); } catch (e) { /* bestaat niet */ } };
  voeg('_INBOX', 'inbox');
  voeg(path.join('20_Prive', 'raw_input'), 'prive');
  for (const top of ['10_Zakelijk']) {
    let namen = [];
    try { namen = fs.readdirSync(path.join(vault, top), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch (e) { continue; }
    for (const n of namen) {
      if (n === 'Projecten' || n === '_Gedeeld') {
        let sub = [];
        try { sub = fs.readdirSync(path.join(vault, top, n), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch (e) { /* leeg */ }
        for (const s of sub) voeg(path.join(top, n, s, 'raw_input'), n === 'Projecten' ? 'projecten' : 'gedeeld');
      } else voeg(path.join(top, n, 'raw_input'), entiteitCode(n));
    }
  }
  return uit;
}
function telMap(dir, rij, vandaag, weekVan) {
  const stapel = [dir];
  let n = 0;
  while (stapel.length) {
    const d = stapel.pop();
    let lijst = [];
    try { lijst = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of lijst) {
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stapel.push(p); continue; }
      if (!e.isFile()) continue;
      if (++n > MAX_BESTANDEN) { rij.afgekapt = true; return; }
      rij.wachtend++;
      let st;
      try { st = fs.statSync(p); } catch (x) { continue; }
      const dag = dagVan(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs);   // aankomst op de pod; zonder geboortetijd de wijzigingstijd
      if (dag === vandaag) rij.vandaag++;
      if (dag >= weekVan) rij.week++;
    }
  }
}

function leesSqlite(pad, sql, args) {
  if (!pad || !fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 2000;'); return db.prepare(sql).all(...(args || [])); }
  finally { try { db.close(); } catch (e) { /* al dicht */ } }
}

const BRON_NAAM = { 'gmail:david': 'Gmail (privé)', 'gmail:groenhouten': 'Gmail (Groenhouten)', outlook: 'Outlook Tolgaarde',
  'facturen-postvak': 'Facturen-postvak', raw_input: 'raw_input (wacht op verwerking)' };
function bronNaam(id) {
  if (BRON_NAAM[id]) return BRON_NAAM[id];
  if (id.indexOf('gmail:') === 0) return 'Gmail (' + id.slice(6) + ')';
  if (id.indexOf('intake:') === 0) return 'Nieuwe ingang · ' + id.slice(7);
  return id;
}

function maak(o) {
  const vault = o.vault, facturenPad = o.facturenPad || null, intakePad = o.intakePad || null;
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const rpc = o.rpc;   // async (fn, body) → rijen; null = geen Supabase
  let cache = null;

  async function meet() {
    const t = nu();
    const vandaag = dagVan(t), weekVan = maandagVan(vandaag);
    const vanIso = new Date(t - 8 * 86400000).toISOString();   // ruim: de dagen zelf (Amsterdam) beslissen
    const bronnen = new Map();   // id → { id, naam, groep, ok, fout, ent: Map(entiteit → {vandaag, week, wachtend}) }
    const bron = (id, groep) => { if (!bronnen.has(id)) bronnen.set(id, { id, naam: bronNaam(id), groep, ok: true, fout: null, ent: new Map(), afgekapt: false }); return bronnen.get(id); };
    const tel = (b, ent, dag, n) => {
      const e = entiteitCode(ent);
      if (!b.ent.has(e)) b.ent.set(e, { vandaag: 0, week: 0, wachtend: 0 });
      const r = b.ent.get(e);
      if (dag === vandaag) r.vandaag += n;
      if (dag >= weekVan) r.week += n;
    };

    // 1 mail (Gmail en Outlook)
    bron('gmail:david', 'mail'); bron('outlook', 'mail');
    if (!rpc) { bron('gmail:david', 'mail').ok = false; bron('gmail:david', 'mail').fout = 'geen databank'; bron('outlook', 'mail').ok = false; bron('outlook', 'mail').fout = 'geen databank'; }
    else {
      try {
        const rijen = await rpc('ovis_intake_telling', { p_van: vanIso });
        if (!Array.isArray(rijen)) throw new Error('geen lijst');
        for (const r of rijen) {
          const id = r.bron === 'outlook' ? 'outlook' : 'gmail:' + entiteitCode(r.account);
          tel(bron(id, 'mail'), r.entiteit, String(r.dag || '').slice(0, 10), Number(r.aantal) || 0);
        }
      } catch (e) {
        for (const id of ['gmail:david', 'outlook']) { const b = bron(id, 'mail'); b.ok = false; b.fout = 'maillog niet te lezen'; }
      }
    }

    // 2 facturen-postvak
    const fb = bron('facturen-postvak', 'postvak');
    try {
      const rijen = leesSqlite(facturenPad, `SELECT m.ontvangen_op AS op, (SELECT f.entiteit FROM factuur f WHERE f.bericht = m.id AND f.entiteit IS NOT NULL LIMIT 1) AS ent
        FROM bericht m JOIN bron b ON b.id = m.bron WHERE b.soort = 'verzamelpostvak' AND m.ontvangen_op >= ?`, [vanIso]);
      if (rijen === null) { fb.ok = false; fb.fout = 'geen facturendatabank'; }
      else for (const r of rijen) { const ms = Date.parse(r.op); if (ms) tel(fb, r.ent, dagVan(ms), 1); }
      const aan = leesSqlite(facturenPad, "SELECT max(actief) AS a FROM bron WHERE soort = 'verzamelpostvak'");
      fb.uit = !!(aan && aan[0] && !aan[0].a);
    } catch (e) { fb.ok = false; fb.fout = 'facturendatabank niet te lezen'; }

    // 3 raw_input
    const rb = bron('raw_input', 'vault');
    try {
      for (const m of rawMappen(vault)) {
        if (!rb.ent.has(m.entiteit)) rb.ent.set(m.entiteit, { vandaag: 0, week: 0, wachtend: 0 });
        const rij = rb.ent.get(m.entiteit);
        telMap(m.pad, rij, vandaag, weekVan);
        if (rij.afgekapt) { rb.afgekapt = true; delete rij.afgekapt; }
      }
    } catch (e) { rb.ok = false; rb.fout = 'vault niet te lezen'; }

    // 4 nieuwe aanleverweg (schaduw)
    try {
      const rijen = leesSqlite(intakePad, "SELECT bron, json_extract(meta, '$.entiteit') AS ent, aangemaakt AS op FROM stuk WHERE aangemaakt >= ?", [vanIso]);
      if (rijen) for (const r of rijen) {
        const id = 'intake:' + String(r.bron || '').toLowerCase().replace(/[^a-z0-9:_-]/g, '').slice(0, 40);
        const ms = Date.parse(r.op);
        if (ms) tel(bron(id, 'ingang'), r.ent, dagVan(ms), 1);
      }
    } catch (e) { const b = bron('intake:?', 'ingang'); b.ok = false; b.fout = 'ingang niet te lezen'; }

    return { t, vandaag, week_van: weekVan, bronnen: [...bronnen.values()] };
  }

  function vorm(m, vastePlek) {
    const bronnen = m.bronnen.map((b) => {
      const entiteiten = [...b.ent.entries()].filter(([e]) => !(vastePlek && e === 'prive'))
        .map(([entiteit, r]) => ({ entiteit, vandaag: r.vandaag, week: r.week, ...(b.id === 'raw_input' ? { wachtend: r.wachtend } : {}) }))
        .filter((r) => r.week > 0 || r.vandaag > 0 || r.wachtend > 0)
        .sort((x, y) => y.week - x.week || (y.wachtend || 0) - (x.wachtend || 0) || x.entiteit.localeCompare(y.entiteit));
      const som = (k) => entiteiten.reduce((s, r) => s + (r[k] || 0), 0);
      const uit = { id: b.id, naam: b.naam, groep: b.groep, ok: b.ok, vandaag: som('vandaag'), week: som('week'), entiteiten };
      if (b.id === 'raw_input') uit.wachtend = som('wachtend');
      if (b.fout) uit.fout = b.fout;
      if (b.uit) uit.uit = true;
      if (b.afgekapt) uit.afgekapt = true;
      return uit;
    });
    return { ok: true, gemeten_op: new Date(m.t).toISOString(), vandaag: m.vandaag, week_van: m.week_van, vaste_plek: !!vastePlek, bronnen };
  }

  async function telling(vastePlek) {
    if (!cache || nu() - cache.t > CACHE_MS) cache = { t: nu(), m: await meet() };
    return vorm(cache.m, vastePlek);
  }
  return { telling, _meet: meet, _vorm: vorm };
}

module.exports = { maak, entiteitCode, maandagVan, dagVan, rawMappen };
