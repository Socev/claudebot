#!/usr/bin/env node
/*
 * bank-historie.js — de ABN-historie van Privé en de POT in de transactiedatabase van de bankluis (wv1329, 26-10-2026). David 26-10-2026:
 * "ALLE bankhistorie van de rekeningen … vanaf rekeningstart" (via Claude Desktop uit de PDF-afschriften overgezet, één CSV per rekening).
 * De zakelijke rekeningen gaan naar Facturen (tools/facturen-historie.js); Privé en de POT horen hier: Enable Banking levert ze sinds april
 * 2025, dit vult de jaren ervoor (bank-archief.historieBij: afdekken wat de bank al gaf, de rest invoegen als herkomst 'abn-historie').
 *
 * Draait op de pod als 'claude', vanuit de machinekamer, tegen BANK_DIR (standaard /opt/data/bank). Eerst --droog, op een kopie.
 *   node tools/bank-historie.js [--droog] [--forceer] <bestand.csv> [<bestand.csv> …]
 * Weigert een bestand waarvan de saldoketen niet per regel sluit, of een rekening die de bankluis niet kent (de rekening moet gekoppeld
 * zijn). Na een geslaagde invoer gaat het bestand byte-gelijk naar BANK_DIR/historie-bron/<sha256>.csv (0600).
 * Uitvoer: alleen aantallen, periode en de laatste 4 van de rekening: geen bedragen, namen of omschrijvingen (POT = personeelsgegevens).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require(path.join(__dirname, '..', 'bank-archief.js'));
const B = require(path.join(__dirname, '..', 'facturen-bank.js'));

const DIR = process.env.BANK_DIR || '/opt/data/bank';

function cent(t) { const v = B.normBedrag(t); return v === null ? null : Math.round(v * 100); }   // saldo als tekst ("1234,56")
function hoofd(argv) {
  const vlag = (v) => { const i = argv.indexOf(v); if (i < 0) return false; argv.splice(i, 1); return true; };
  const droog = vlag('--droog'), forceer = vlag('--forceer');
  if (!argv.length) throw new Error('gebruik: [--droog] [--forceer] <bestand.csv> …');
  if (!fs.existsSync(path.join(DIR, 'transacties.sqlite'))) throw new Error('geen transactiedatabase in ' + DIR);
  const a = A.open(DIR);
  const uit = [];
  try {
    for (const p of argv) {
      const bytes = fs.readFileSync(p);
      const s = { bestand: path.basename(p) };
      let rijen;
      try { rijen = B.leesAbnHistorie(bytes.toString('utf8')); } catch (e) {
        if (e instanceof B.BankWeigering) { uit.push(Object.assign(s, { ok: false, fout: e.uitleg })); continue; }
        throw e;
      }
      if (!rijen.length) { uit.push(Object.assign(s, { ok: false, fout: 'geen regels' })); continue; }
      // saldoketen per regel (oudste eerst): saldo vorige + bedrag = saldo na mutatie
      let breuken = 0;
      for (let i = 1; i < rijen.length; i++) if (cent(rijen[i - 1].saldo_na) + Math.round(rijen[i].bedrag * 100) !== cent(rijen[i].saldo_na)) breuken++;
      const iban = rijen[0].rekening;
      s.rekening = '…' + iban.slice(-4);
      if (breuken) { uit.push(Object.assign(s, { ok: false, fout: 'saldoketen breekt op ' + breuken + ' regel(s)' })); continue; }
      const rk = a.db.prepare('SELECT rek FROM rekeningen WHERE iban = ?').all(iban);
      if (rk.length !== 1) { uit.push(Object.assign(s, { ok: false, fout: rk.length ? 'rekening staat dubbel in de bankluis' : 'rekening staat niet in de bankluis' })); continue; }
      const r = A.historieBij(a, rk[0].rek, rijen.map((h) => ({
        mutatie_id: h.mutatie_id, datum: h.boekdatum, valutadatum: h.rentedatum, bedrag: h.bedrag, tegenpartij: h.naam, tegen_iban: h.tegen_iban,
        // zelfde vorm als de ABN-omschrijving uit de bankluis ("<type> Naam: … Machtiging: … Omschrijving: …"): de herkenning van
        // machtiging en tegenpartij (abonnementen, vaste lasten) leest die labels
        omschrijving: (h.volledig || h.omschrijving || '').split(' | ').join(' ').slice(0, 500) || null, saldo_na: cent(h.saldo_na) / 100,
      })), { droog, forceer });
      Object.assign(s, { ok: !r.geweigerd, saldoketen: 'sluit' }, r);
      if (r.geweigerd) s.fout = 'bestand en bankluis sluiten niet op elkaar aan (zie in_venster, bestaand_rest); --forceer na narekenen';
      if (!droog && !r.geweigerd) {
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const map = path.join(DIR, 'historie-bron');
        fs.mkdirSync(map, { recursive: true, mode: 0o700 });
        const doel = path.join(map, sha + '.csv');
        if (!fs.existsSync(doel)) {
          const tmp = doel + '.' + process.pid + '.tmp';
          fs.writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
          fs.renameSync(tmp, doel);
        }
        s.bron_bewaard = crypto.createHash('sha256').update(fs.readFileSync(doel)).digest('hex') === sha;
      }
      uit.push(s);
    }
  } finally { try { a.db.close(); } catch (e) {} }
  return uit;
}

if (require.main === module) {
  try { console.log(JSON.stringify(hoofd(process.argv.slice(2)), null, 1)); }
  catch (e) { console.error('fout: ' + (e && e.message || e)); process.exit(1); }
}
module.exports = { hoofd };
