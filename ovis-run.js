#!/usr/bin/env node
'use strict';
// ovis-run.js — één ingang op de opdrachtregel voor ovis-register.js (wv979, 24-10-2026; ontwerp mk-scripts/wv979/ontwerp.md).
// Voor de nachtronde onder de bisync-grendel (server.js start: flock -w 300 <vault.lock> node ovis-run.js nacht) en voor de
// machinekamer (proef in een vaultkopie met VAULT_DIR=<proefmap>, export van register.json).
//
//   node ovis-run.js dag|afroep            compileren: alleen pagina's waarvan de vingerafdruk afwijkt; alleen de databank
//   node ovis-run.js nacht [--buiten-venster]   alles compileren + gegenereerd blok in de pagina's; alleen 01:00-02:00 (Amsterdam) en
//                                          alleen als de grendel al vastgehouden wordt (anders weigert hij)
//   node ovis-run.js bibliothecaris [--afroep]  BB1-BB7; --afroep: geen hartslagstempel (en de aanroeper geen box-rij)
//   node ovis-run.js export <register.json>     knopen uit de databank in register.json (sleutels/vertaling blijven); alleen bij verschil
//   node ovis-run.js voorjou [--schrijf]   wv1009 plek 5: Voor jou ⇄ Open vragen aan David vergelijken (zelfde regels als de Bibliothecaris);
//                                          --schrijf (Voor jou-ronde, voor-jou.py koppel --schrijf): wat zeker is in het register zetten
//                                          (Status-cel van een open rij waarvan David de kaart sloot; registerrij voor een open kaart met
//                                          registerplicht). Raakt nooit een kaart.
//   node ovis-run.js zegel <pad> [--droog]   wv1011 plek 7: zegel van het ovis-blok op een zakelijke persoonspagina zetten na een bewuste
//                                          wijziging door de machinekamer of Socev (nooit voor iets uit een gelezen stuk). Weigert bij een
//                                          ander gebrek; schrijft alleen die ene regel (vault-veilig).
//   --droog: niets schrijven (databank noch vault)
// Omgeving: VAULT_DIR (standaard de vault), OVIS_ZEGEL_SLEUTEL (wv1011: pad naar de zegelsleutel, standaard /opt/data/ovis/zegel.sleutel), SUPABASE_URL + SUPABASE_SERVICE_ROLE (nooit als argument), CLOUDFLARE_API_TOKEN (wv981: D1 fin
// alleen lezen voor plek 4 en (wv1012) plek 8; ontbreekt hij, dan "niet gemeten"), CF_ACCOUNT_ID/APP_FIN_DB/APP_KNIE_DB (zoals server.js; wv1774), BANK_DIR (wv1010: plek 6,
// <BANK_DIR>/transacties.sqlite alleen lezen; standaard /opt/data/bank), OVIS_LOCK (standaard
// /opt/data/bin/.vault.lock). Uitvoer: één JSON-regel; uitgang 0 = gelukt, 1 = fout, 2 = gebruik.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./ovis-register.js');
const VV = require('./vault-veilig.js');

const VAULT = process.env.VAULT_DIR || '/opt/data/AI_SecondBrain';
const ECHTE_VAULT = '/opt/data/AI_SecondBrain';
const LOCK = process.env.OVIS_LOCK || '/opt/data/bin/.vault.lock';
const arg = process.argv.slice(2), modus = arg[0], droog = arg.indexOf('--droog') >= 0;

function stop(code, j) { process.stdout.write(JSON.stringify(j) + '\n'); process.exit(code); }
async function sbRpc(fn, body) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SERVICE_ROLE || '';
  if (!url || !key) throw new Error('supabase-omgeving ontbreekt');
  const r = await fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
  const t = await r.text();
  if (!r.ok) { let m = ''; try { m = JSON.parse(t).message || ''; } catch (e) {} throw new Error('rpc ' + fn + ' http ' + r.status + (m ? ': ' + String(m).slice(0, 200) : '')); }
  return t ? JSON.parse(t) : null;
}
// wv1360: geaccepteerde rekeningnummers uit de Facturen-database (alleen lezen) voor het gegenereerde blok. Per rekening: de herkomst die bij
// het vastleggen in feit.bewijs kwam (ook POT-historie uit de bankluis en Triodos) plus wat de bank daarna nog aan betalingen liet zien.
// Geen database (uitwijkkant, terugrol) → null: de compiler laat bestaande nummers dan staan.
function rekeningen() {
  const pad = path.join(process.env.FACTUREN_DIR || '/opt/data/facturen', 'facturen.sqlite');
  if (!fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const eigen = new Set(db.prepare('SELECT iban FROM rekening').all().map(function (r) { return r.iban; }));
    const alle = db.prepare('SELECT count(*) AS n, min(boekdatum) AS eerste, max(boekdatum) AS laatste FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL');
    const na = db.prepare('SELECT count(*) AS n, max(boekdatum) AS laatste FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL AND boekdatum > ?');
    const uit = [];
    for (const r of db.prepare('SELECT li.iban, l.naam, f.bewijs FROM leverancier_iban li JOIN leverancier l ON l.id = li.leverancier LEFT JOIN feit f ON f.id = li.feit ORDER BY li.iban').all()) {
      if (eigen.has(r.iban)) continue;
      let b = null; try { b = r.bewijs ? JSON.parse(r.bewijs) : null; } catch (e) { b = null; }
      const a = alle.get(r.iban);
      let aantal = a.n, eerste = a.eerste, laatste = a.laatste;
      if (b && Number.isInteger(b.aantal) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.eerste)) && /^\d{4}-\d{2}-\d{2}$/.test(String(b.laatste))) {
        const n = na.get(r.iban, b.laatste);
        aantal = Math.max(a.n, b.aantal + n.n); eerste = a.eerste && a.eerste < b.eerste ? a.eerste : b.eerste; laatste = n.laatste || b.laatste;
      }
      uit.push({ iban: r.iban, naam: r.naam, doel: b && typeof b.doel === 'string' ? b.doel : null, aantal: aantal, eerste: eerste, laatste: laatste });
    }
    return uit;
  } finally { db.close(); }
}
// wv981: plek 4 (POT-factuuradres). D1 fin alleen lezen (elk statement moet een SELECT zijn, Fable #4) en de dossierpagina's met de parser
// van de verzender zelf (pot-verzend.ontvangers), zodat de Bibliothecaris hetzelfde leest als wat er verstuurd wordt.
// wv1012: dezelfde D1-lezer ook voor plek 8 (entiteit, medewerker, kerncijfers); alleen SELECT. Geen token → null (niet gemeten).
function finD1() {
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!tok) return null;
  const acc = process.env.CF_ACCOUNT_ID || '23df9b0607bb70f6d7f15a63ec843d6d', db = process.env.APP_FIN_DB || 'ffcb09ad-fc50-4c83-aa7b-ad6409b44e03';
  return async function (batch) {
    if (batch.some(function (q) { return !/^\s*select\b/i.test(q.sql); })) throw new Error('alleen lezen');
    const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + acc + '/d1/database/' + db + '/query', { method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: batch }), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.success !== true || !Array.isArray(j.result) || j.result.length !== batch.length || !j.result.every(function (x) { return x && x.success !== false; })) throw new Error('D1 http ' + r.status);
    return j.result.map(function (x) { return { results: Array.isArray(x.results) ? x.results : [] }; });
  };
}
function potLezer() {
  let PV = null; try { PV = require('./pot-verzend.js'); } catch (e) { PV = null; }
  const d1 = finD1();
  if (!d1 || !PV) return null;
  return {
    d1: d1,
    dossier: function () {
      const map = path.join('10_Zakelijk', 'HAGRO', 'Praktijken');
      const paden = fs.readdirSync(path.join(VAULT, map)).filter(function (n) { return /\.md$/.test(n); }).map(function (n) { return path.join(map, n); })
        .concat([path.join('10_Zakelijk', 'Groenhouten', 'index.md'), path.join('10_Zakelijk', 'Tolgaarde', 'index.md')]);
      const pg = [];
      paden.forEach(function (rel) { try { pg.push({ pad: rel, tekst: VV.lees(path.join(VAULT, rel), 'utf8').slice(0, 20000) }); } catch (e) { /* zoals potVzVault */ } });
      return PV.ontvangers(pg);
    },
  };
}
// wv1013: plek 9 (R2 fin-bronnen ⇄ D1 fin.bron), alleen lezen: D1 alleen SELECT, R2 alleen de objectlijst. Geen sleutel: niet gemeten.
// wv1774: plek 13 (kn: D1 knie, alleen SELECT, zelfde sleutel) en 14 (hp: health-pod via hp.py, alleen de vaste GET-paden; hp.py leest
// zelf de leessleutel, dus ook zonder Cloudflare-sleutel). Zoals server.js.
function restLezer() {
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  let P; try { P = require('./ovis-plekken.js'); } catch (e) { return null; }
  const acc = process.env.CF_ACCOUNT_ID || '23df9b0607bb70f6d7f15a63ec843d6d', db = process.env.APP_FIN_DB || 'ffcb09ad-fc50-4c83-aa7b-ad6409b44e03';
  const knie = process.env.APP_KNIE_DB || 'a5fe9515-a341-4f7a-a319-f49803f569b5';
  function d1Van(id, naam) {
    return async function (batch) {
      if (batch.some(function (q) { return !/^\s*select\b/i.test(q.sql) || /;/.test(q.sql); })) throw new Error('alleen lezen');
      const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + acc + '/d1/database/' + id + '/query', { method: 'POST',
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ batch: batch }), signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(function () { return null; });
      if (!r.ok || !j || j.success !== true || !Array.isArray(j.result) || j.result.length !== batch.length || !j.result.every(function (x) { return x && x.success !== false; })) throw new Error(naam + ' http ' + r.status);
      return j.result.map(function (x) { return { results: Array.isArray(x.results) ? x.results : [] }; });
    };
  }
  const hp = function (pad) {
    if (!P.HP_PAD_RE || !P.HP_PAD_RE.test(String(pad))) return Promise.reject(new Error('health-pod: pad niet toegestaan'));
    const env = {}; ['HOME', 'PATH', 'TZ', 'LANG', 'LC_ALL'].forEach(function (k) { if (process.env[k] != null) env[k] = process.env[k]; });
    const bin = path.join(VAULT, '.claude', 'skills', 'health-pod', 'hp.py');
    return new Promise(function (klaar, faal) {
      require('child_process').execFile('python3', ['-I', bin, 'GET', String(pad)], { env: env, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
        function (err, stdout) {
          const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
          try { klaar(P.hpUitslag({ code: code, signaal: err && err.signal || undefined, stdout: String(stdout || '') }, String(pad))); } catch (e) { faal(e); }
        });
    });
  };
  if (!tok) return { hp: hp };
  return { d1: d1Van(db, 'D1'), r2: function () { return P.r2Lijst(fetch, tok, acc, 'fin-bronnen'); }, kn: d1Van(knie, 'D1 knie'), hp: hp };
}
// wv1013: plek 10 — na de nachtronde register.json verversen (de Woordenlijst van de Data Manager bouwt daaruit). Alleen in de echte vault
// en alleen als het bestand er al is; mislukt = de nachtronde blijft geslaagd (melding in de uitvoer).
const REGISTER_JSON = process.env.OVIS_REGISTER_JSON || '/opt/data/mk-scripts/datamanager/knoop/register.json';
// waakt (diffreview wv1013 #4): sleutels/vertaling zijn handwerk → vlak voor het vervangen opnieuw vergelijken met wat gelezen werd; een
// register dat ineens > 10 % kleiner is of een eigen entiteit kwijt is, is een halve lezing en wordt niet geëxporteerd (opties.nacht).
async function exporteer(reg, doel, droog, opties) {
  const oudTekst = fs.readFileSync(doel, 'utf8'), huidig = JSON.parse(oudTekst);
  const r = await reg.register();
  const velden = ['id', 'soort', 'naam', 'vault_pad', 'vault_pagina', 'aliassen', 'kvk', 'agb', 'iban', 'opmerking', 'rol', 'concept'];
  const knopen = r.knopen.map(function (k) { const x = {}; velden.forEach(function (v) { x[v] = k[v] === undefined ? null : k[v]; }); return x; });
  if (!knopen.length) throw new Error('register leeg; register.json ongemoeid');
  if (opties && opties.nacht) {
    const oud = Array.isArray(huidig.knopen) ? huidig.knopen : [], ids = new Set(knopen.map(function (k) { return k.id; }));
    const weg = oud.filter(function (k) { return k && k.concept === false && !ids.has(k.id); }).map(function (k) { return k.id; });
    if (weg.length) throw new Error('eigen entiteit(en) niet meer in het register (' + weg.slice(0, 3).join(', ') + '); register.json ongemoeid');
    if (oud.length && knopen.length < oud.length * 0.9) throw new Error('register ' + Math.round(100 - 100 * knopen.length / oud.length) + ' % kleiner; register.json ongemoeid');
  }
  const tekst = JSON.stringify(Object.assign({}, huidig, { knopen: knopen }), null, 1) + '\n';
  if (oudTekst === tekst) return { gewijzigd: false, knopen: knopen.length };
  if (!droog) {
    const tmp = doel + '.' + process.pid + '.nieuw';
    fs.writeFileSync(tmp, tekst, { mode: 0o600, flag: 'wx' });
    if (fs.readFileSync(doel, 'utf8') !== oudTekst) { fs.unlinkSync(tmp); throw new Error('register.json veranderde tijdens de export; volgende nacht opnieuw'); }
    fs.renameSync(tmp, doel);
  }
  return { gewijzigd: true, knopen: knopen.length, droog: droog };
}
// wv1009: plek 5 — Voor jou-punten (alleen lezen) en het register (VV, geen symlink volgen)
const VJ_REGISTER = path.join(VAULT, '00_Systeem', 'Open vragen aan David.md');
const vjLezer = { punten: function () { return sbRpc('mk_voor_jou_lijst', { p_alles: true }); }, register: function () { return VV.lees(VJ_REGISTER, 'utf8'); },
  wv: function () { return sbRpc('mk_werkvoorraad_stand', {}); } };
function uurAmsterdam() { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date())); }
// Houdt de ouder de grendel vast? Een eigen `flock -n` op hetzelfde bestand moet dan falen (andere open file description).
function grendelVast() {
  if (fs.realpathSync(VAULT) !== fs.realpathSync(ECHTE_VAULT)) return true;   // proefmap: geen bisync (diffreview #7: beide via realpath)
  const r = spawnSync('flock', ['-n', LOCK, 'true'], { timeout: 5000 });
  return r.status === 1;
}

(async function () {
  if (['dag', 'afroep', 'nacht', 'bibliothecaris', 'export', 'voorjou', 'zegel'].indexOf(modus) < 0) stop(2, { ok: false, fout: 'gebruik: dag|afroep|nacht|bibliothecaris|export <pad>|voorjou [--schrijf]|zegel <pad>' });
  if (modus === 'zegel') {   // wv1011: geen databank nodig; alleen claude kan de zegelsleutel lezen; schrijven alleen onder de vault-grendel
    const rel = String(arg[1] || '');
    if (!/^10_Zakelijk\/[^\0]+\.md$/.test(rel) || rel.split('/').indexOf('..') >= 0 || rel.indexOf('\\') >= 0) stop(2, { ok: false, fout: 'zegel: pad onder 10_Zakelijk/ naar een .md' });
    if (!droog && !grendelVast()) stop(1, { ok: false, fout: 'zegel: alleen onder de vault-grendel (flock -w 300 ' + LOCK + ' node ovis-run.js zegel …)' });
    try {
      const sleutel = R.zegelSleutelLees(process.env.OVIS_ZEGEL_SLEUTEL || undefined);
      const vol = path.join(VAULT, rel);
      const z = R.persoonMetZegel(rel, VV.lees(vol, 'utf8'), sleutel);
      if (z.fout) stop(1, { ok: false, fout: z.fout });
      if (droog) stop(0, { ok: true, droog: true, zegel: z.zegel });
      let fout = null, ongewijzigd = false;
      const gelukt = VV.wijzig(vol, function (t) { const y = R.persoonMetZegel(rel, t, sleutel); if (y.fout) { fout = y.fout; return null; } if (y.tekst === t) { ongewijzigd = true; return null; } return y.tekst; });
      if (fout) stop(1, { ok: false, fout: fout });
      if (!gelukt && !ongewijzigd) stop(1, { ok: false, fout: 'zegel: niet geschreven (pagina veranderde steeds tijdens het schrijven)' });   // diffreview KAN 8
      stop(0, { ok: true, zegel: z.zegel, ongewijzigd: ongewijzigd });
    } catch (e) { stop(1, { ok: false, fout: String(e && e.message || e).slice(0, 200) }); }
  }
  const reg = R.maak({ vault: VAULT, sbRpc: sbRpc, lees: function (p) { return VV.lees(p, 'utf8'); },
    zegelSleutel: function () { return R.zegelSleutelLees(process.env.OVIS_ZEGEL_SLEUTEL || undefined); },   // wv1011
    schrijf: function (p, t) { VV.schrijf(p, t); }, log: function () {}, rekeningen: rekeningen, pot: potLezer(), vj: vjLezer,
    bank: R.bankLezer(path.join(process.env.BANK_DIR || '/opt/data/bank', 'transacties.sqlite')),   // wv1010: plek 6, alleen lezen
    fin: finD1() ? { d1: finD1() } : null,   // wv1012: plek 8, alleen lezen
    rest: restLezer() });   // wv1013: plek 9, alleen lezen; wv1774: plek 13–14
  try {
    if (modus === 'nacht') {
      if (arg.indexOf('--buiten-venster') < 0 && uurAmsterdam() !== 1) stop(1, { ok: false, fout: 'nachtronde alleen 01:00-02:00 (Amsterdam); --buiten-venster om af te wijken' });
      if (!grendelVast()) stop(1, { ok: false, fout: 'grendel ' + LOCK + ' niet vastgehouden: start met flock -w 300 ' + LOCK + ' node ovis-run.js nacht' });
      const c = await reg.compileer('nacht', { droog: droog, grendel: true });
      if (fs.realpathSync(VAULT) === fs.realpathSync(ECHTE_VAULT) && fs.existsSync(REGISTER_JSON)) {   // wv1013: plek 10
        try { c.register_json = await exporteer(reg, REGISTER_JSON, droog, { nacht: true }); } catch (e) { c.register_json = { fout: String(e && e.message || e).slice(0, 120) }; c.fouten.push({ pad: 'register.json', fout: c.register_json.fout }); }
      }
      stop(0, Object.assign({ ok: true }, c));
    }
    if (modus === 'dag' || modus === 'afroep') stop(0, Object.assign({ ok: true }, await reg.compileer(modus, { droog: droog })));
    if (modus === 'bibliothecaris') {
      const b = await reg.bibliothecaris({ droog: droog, afroep: arg.indexOf('--afroep') >= 0 });
      const potTel = { gemeten: b.pot.gemeten, reden: b.pot.reden || null, verschillen: b.pot.verschillen.length };   // geen adressen op stdout
      // wv1010: paden van bankbevindingen alleen hier (machinekamer), nooit in de databank of de box
      const bankTel = { gemeten: b.bank.gemeten, reden: b.bank.reden || null, paden: b.bank.paden || {} };
      // wv1012: paden van fin-bevindingen alleen hier; rekeningnummerverschillen alleen met de laatste 4 cijfers
      const finTel = b.fin ? { gemeten: b.fin.gemeten, reden: b.fin.reden || null, verschillen: b.fin.verschillen || [], paden: b.fin.paden || {} } : null;
      stop(0, Object.assign({ ok: true }, b, { pot: potTel, bank: bankTel, fin: finTel, bevindingen: b.bevindingen.map(function (x) { return { id: x.bevinding_id, check: x.check_id, ernst: x.ernst, samenvatting: x.samenvatting }; }) }));
    }
    if (modus === 'voorjou') {
      // databankklok (op van mk_voor_jou_lijst), niet de podklok (die liep eerder dagen mis)
      const m = await R.vjMeting(vjLezer);
      let okaarten = [];
      try { okaarten = (await reg.register()).kaarten || []; } catch (e) { okaarten = []; }   // alleen voor de OVIS-uitkomst in de Status-tekst
      const k = R.vjKoppel(m, okaarten, R.vjNu(m, Date.now()));
      const uit = { ok: true, gemeten: k.gemeten, reden: k.reden || null, tel: k.tel,
        bevindingen: k.bevindingen.map(function (x) { return { id: x.bevinding_id, samenvatting: x.samenvatting, voorstel: String(x.detail).replace(/^.*Voorstel: /, '') }; }),
        acties: k.acties.map(function (a) { return { soort: a.soort, gesteld: a.gesteld, kaart: a.kaart, nieuw: a.soort === 'status' ? a.nieuw : 'nieuwe registerrij' }; }) };
      if (arg.indexOf('--schrijf') >= 0 && !droog && k.gemeten && k.acties.length) {
        let s = null;
        // opnieuw toepassen op de verse tekst onder het slot van vault-veilig (compare-and-set per rij in vjSchrijf)
        const gelukt = VV.wijzig(VJ_REGISTER, function (t) { s = R.vjSchrijf(t, k.acties); return s.tekst; });
        if (s && s.tekst && !gelukt) uit.geschreven = { gedaan: [], overgeslagen: [{ reden: 'register veranderde drie keer tijdens het schrijven; volgende ronde opnieuw' }] };
        else uit.geschreven = s ? { gedaan: s.gedaan, overgeslagen: s.overgeslagen } : { gedaan: [], overgeslagen: [{ reden: 'register niet te lezen' }] };
      }
      stop(k.gemeten ? 0 : 1, uit);
    }
    if (modus === 'export') {
      const doel = arg[1];
      if (!doel || !/register\.json$/.test(doel)) stop(2, { ok: false, fout: 'export <pad naar register.json>' });
      stop(0, Object.assign({ ok: true }, await exporteer(reg, doel, droog)));
    }
  } catch (e) { stop(1, { ok: false, fout: String(e && e.message || e).slice(0, 300) }); }
})();
