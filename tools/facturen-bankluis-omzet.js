#!/usr/bin/env node
'use strict';
/*
 * facturen-bankluis-omzet.js — zet een zakelijke rekening in Facturen om van upload (abn_tab) naar de bankkoppeling (bankluis), wv2392
 * (4-11-2026). Ontwerp: vault 01_Ontwikkeling/Zakelijke rekeningen via Enable Banking naar Facturen (ontwerp 4-11-2026).md.
 *
 * WAAROM. Na Davids business-koppeling bij Enable Banking staan de posten van de zakelijke ABN-rekeningen in BANK_DIR/zakelijk.sqlite.
 * Facturen leest ze pas als de rekening bank_formaat 'bankluis' heeft met de bankluis-sleutel. Dat omzetten is een bewuste stap van de
 * machinekamer, eerst droog: op een kopie van Facturen draait de echte bankluis-ronde (met de naad tegen de uploads) en telt het hulpje
 * nieuw, afgedekt en mogelijke dubbelen (een ingelezen bankpost met een vrije upload-tegenhanger: zelfde bedrag, rentedatum 0–3 dagen
 * ervóór). Pas met --echt (en alleen als de droge run 0 mogelijke dubbelen gaf) wordt de echte rekening omgezet, met een auditregel.
 *
 *   node tools/facturen-bankluis-omzet.js [--echt] [--iban NL..] [--facturen-dir /opt/data/facturen] [--bank-dir /opt/data/bank]
 *
 * Alleen rekeningen met controle 1, niet Privé, niet de POT, formaat abn_tab, abn_mt940, ing_csv of triodos_csv (wv2404), waarvan het IBAN
 * in stand.json bij een zakelijke (business-)rekening staat die in zakelijk.sqlite voorkomt, en waarvan de bank in Facturen (ABN, ING,
 * TRIODOS) past bij de bank van de koppeling. De naad en de telling van mogelijke dubbelen gebruiken hetzelfde dagvenster per formaat
 * (facturen.js naadVenster: ABN 0..3 dagen, ING en Triodos −3..3). Uitvoer: JSON met aantallen per rekening (laatste 4 cijfers),
 * geen namen of bedragen. Schrijft in de echte Facturen-database alleen met --echt (eigen verbinding, BEGIN IMMEDIATE, nooit migreren).
 */
const fs = require('fs'), path = require('path'), os = require('os');
const { DatabaseSync, backup } = require('node:sqlite');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ECHT = process.argv.includes('--echt');
const FDIR = arg('facturen-dir', process.env.FACTUREN_DIR || '/opt/data/facturen');
const BDIR = arg('bank-dir', process.env.BANK_DIR || '/opt/data/bank');
const ALLEEN = arg('iban', null);
const ibanNorm = (i) => i ? String(i).replace(/\s+/g, '').toUpperCase() : null;
const eind4 = (i) => '…' + String(i || '').slice(-4);
const FORMATEN = ['abn_tab', 'abn_mt940', 'ing_csv', 'triodos_csv'];
const BANK_KOPPELING = { ABN: /\bABN\b/i, ING: /\bING\b/i, TRIODOS: /\bTRIODOS\b/i };   // Facturen rekening.bank → naam van de bank in stand.json
const uit = (o, code) => { process.stdout.write(JSON.stringify(o, null, 1) + '\n'); process.exit(code || 0); };

async function hoofd() {
  const stand = JSON.parse(fs.readFileSync(path.join(BDIR, 'stand.json'), 'utf8'));
  const zakPad = path.join(BDIR, 'zakelijk.sqlite');
  if (!fs.existsSync(zakPad)) uit({ ok: false, fout: 'zakelijk.sqlite bestaat nog niet (geen business-koppeling opgehaald)' }, 1);
  const zdb = new DatabaseSync(zakPad, { readOnly: true });
  const inZak = zdb.prepare('SELECT count(*) AS n, min(datum) AS van, max(datum) AS tot FROM transacties WHERE rek = ?');
  const zak = Object.keys(stand.rekeningen || {}).filter((h) => stand.rekeningen[h].zakelijk && stand.rekeningen[h].iban)
    .map((h) => ({ rek: h, iban: ibanNorm(stand.rekeningen[h].iban), bank: stand.rekeningen[h].bank || '' })).filter((z) => !ALLEEN || z.iban === ibanNorm(ALLEEN));
  const echtDb = new DatabaseSync(path.join(FDIR, 'facturen.sqlite'), { readOnly: true });
  const kandidaten = [];
  for (const z of zak) {
    const k = echtDb.prepare('SELECT * FROM rekening WHERE iban = ?').get(z.iban);
    const st = inZak.get(z.rek);
    const r = { rekening: eind4(z.iban), zakelijk_posten: st.n, zakelijk_van: st.van, zakelijk_tot: st.tot };
    if (!k) { r.overgeslagen = 'niet in Facturen'; kandidaten.push(r); continue; }
    r.entiteit = k.entiteit; r.id = k.id; r.formaat_nu = k.bank_formaat;
    if (k.bank_formaat === 'bankluis') r.overgeslagen = k.bankluis_rek === z.rek ? 'al omgezet' : 'al bankluis met een andere sleutel';
    else if (k.entiteit === 'prive' || k.entiteit === 'pot' || k.controle !== 1) r.overgeslagen = 'Privé, POT of zonder controle: niet omzetten';
    else if (FORMATEN.indexOf(k.bank_formaat) < 0) r.overgeslagen = 'formaat ' + k.bank_formaat + ': niet in deze stap';
    else if (!BANK_KOPPELING[k.bank] || !BANK_KOPPELING[k.bank].test(z.bank)) r.overgeslagen = 'bank in Facturen (' + k.bank + ') past niet bij de koppeling';
    else if (!st.n) r.overgeslagen = 'nog geen posten in zakelijk.sqlite';
    else r._rek = z.rek;
    kandidaten.push(r);
  }
  echtDb.close();
  const om = kandidaten.filter((r) => r._rek);
  if (!om.length) uit({ ok: true, droog: !ECHT, rekeningen: kandidaten, let_op: 'niets om te zetten' });

  // ── droog: kopie van Facturen, omzetten, echte bankluis-ronde, tellen ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fac-omzet-'));
  let droog;
  try {
    fs.chmodSync(tmp, 0o700);
    await backup(new DatabaseSync(path.join(FDIR, 'facturen.sqlite'), { readOnly: true }), path.join(tmp, 'facturen.sqlite'));
    if (fs.existsSync(path.join(FDIR, 'stukken'))) fs.symlinkSync(path.join(FDIR, 'stukken'), path.join(tmp, 'stukken'));
    const D = require(path.join(__dirname, '..', 'facturen-db.js'));
    const F = require(path.join(__dirname, '..', 'facturen.js'));
    const fdb = D.open(tmp);
    const voor = {};
    for (const r of om) {
      voor[r.id] = fdb.db.prepare('SELECT count(*) AS n FROM bank_transactie WHERE rekening = ? AND verwijderd_op IS NULL').get(r.id).n;
      fdb.db.prepare("UPDATE rekening SET bank_formaat = 'bankluis', bankluis_rek = ? WHERE id = ?").run(r._rek, r.id);
    }
    const ronde = F.bankluisRonde(fdb, { nu: Date.now(), pad: path.join(BDIR, 'transacties.sqlite'), padZakelijk: zakPad });
    for (const r of om) {
      const bl = fdb.db.prepare("SELECT id, boekdatum, bedrag_centen FROM bank_transactie WHERE rekening = ? AND formaat = 'bankluis' AND verwijderd_op IS NULL ORDER BY boekdatum, id").all(r.id);
      const up = fdb.db.prepare("SELECT id, boekdatum, bedrag_centen FROM bank_transactie WHERE rekening = ? AND formaat <> 'bankluis' AND verwijderd_op IS NULL").all(r.id);
      const L = up.reduce((m, u) => (!m || u.boekdatum > m ? u.boekdatum : m), null);
      // mogelijke dubbelen: een ingelezen bankpost waarvoor nog een vrije upload-regel bestaat (zelfde bedrag, binnen het naadvenster van het formaat)
      const [onder, boven] = F.naadVenster(r.formaat_nu);
      const vrij = new Map(); for (const u of up) { const k = u.bedrag_centen; if (!vrij.has(k)) vrij.set(k, []); vrij.get(k).push(u); }
      let dubbel = 0; const dubbelDagen = [];
      for (const b of bl) {
        const l = vrij.get(b.bedrag_centen) || [];
        const i = l.findIndex((u) => { const d = Math.round((Date.parse(b.boekdatum) - Date.parse(u.boekdatum)) / 864e5); return d >= onder && d <= boven; });
        if (i >= 0) { dubbel++; if (dubbelDagen.length < 10) dubbelDagen.push(b.boekdatum); l.splice(i, 1); }
      }
      Object.assign(r, { laatste_upload: L, regels_voor: voor[r.id], bankluis_ingelezen: bl.length, eerste_bankluis: bl.length ? bl[0].boekdatum : null,
        regels_na: voor[r.id] + bl.length, mogelijke_dubbelen: dubbel, dubbel_dagen: dubbelDagen.length ? dubbelDagen : undefined });
    }
    droog = { ok: ronde.ok, gelezen: ronde.gelezen, nieuw: ronde.nieuw, afgedekt: ronde.afgedekt || 0, voor_naad: ronde.voor_naad || 0, fouten: ronde.fouten,
      signalen: ronde.controle ? ronde.controle.signalen : undefined };
    try { fdb.db.close(); } catch (e) {}
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }   // kopie met echte gegevens meteen weg

  const dubbel = om.reduce((s, r) => s + r.mogelijke_dubbelen, 0);
  if (!ECHT) uit({ ok: true, droog: true, ronde_op_kopie: droog, rekeningen: kandidaten.map((r) => Object.assign({}, r, { _rek: undefined })) });
  if (dubbel || !droog.ok) uit({ ok: false, fout: 'droge run gaf ' + dubbel + ' mogelijke dubbelen of fouten; niet omgezet', ronde_op_kopie: droog,
    rekeningen: kandidaten.map((r) => Object.assign({}, r, { _rek: undefined })) }, 1);

  // ── echt: eigen verbinding, nooit migreren; versie-check in de WHERE; auditregel ──
  const db = new DatabaseSync(path.join(FDIR, 'facturen.sqlite'));
  db.exec('PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;');
  const nu = new Date().toISOString(), gedaan = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of om) {
      const c = db.prepare("UPDATE rekening SET bank_formaat = 'bankluis', bankluis_rek = ? WHERE id = ? AND bank_formaat = ? AND controle = 1 AND entiteit NOT IN ('prive', 'pot')")
        .run(r._rek, r.id, r.formaat_nu).changes;
      if (c !== 1) throw new Error('rekening ' + r.rekening + ' veranderde intussen; niets omgezet');
      db.prepare('INSERT INTO audit (wie, wat, object_soort, object_id, entiteit, voor, na, wanneer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('machinekamer (wv2392)', 'rekening_wijzigen', 'rekening', r.id, r.entiteit, JSON.stringify({ bank_formaat: r.formaat_nu, bankluis_rek: null }),
          JSON.stringify({ bank_formaat: 'bankluis', bankluis_rek: '(zakelijk.sqlite)' }), nu);
      gedaan.push(r.rekening);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); uit({ ok: false, fout: String(e.message || e).slice(0, 200) }, 1); }
  uit({ ok: true, omgezet: gedaan, ronde_op_kopie: droog, rekeningen: kandidaten.map((r) => Object.assign({}, r, { _rek: undefined })),
    vervolg: 'de bankluis-ronde van Facturen (na de bank-ronde 07:00/18:00) leest de posten in' });
}
hoofd().catch((e) => uit({ ok: false, fout: 'interne fout: ' + String(e && e.message || e).slice(0, 200) }, 1));
