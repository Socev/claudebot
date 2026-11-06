#!/usr/bin/env node
/*
 * facturen-leverancier-na.js — bevestigde facturen zonder leverancier alsnog koppelen (wv2590, 6-11-2026).
 * Waarom: tot wv2590 maakte Bevestigen geen leverancier aan als de koerier er geen herkende; gemeten 6-11: 12 van de 35 facturen zonder
 * leverancier, dus niets onthouden (entiteit, betaalwijze, nagebeld rekeningnummer) en geen keuze "direct verzenden" mogelijk. Sinds wv2590
 * doet Bevestigen dat zelf (facturen.js leverancierBijBevestigen); dit hulpmiddel haalt de facturen van daarvoor in.
 *
 *   node tools/facturen-leverancier-na.js [--echt] [--db <map>] [--namen]   standaard droog (alleen tellen, niets schrijven); namen van
 *   leveranciers alleen met --namen (review wv2590 ZOU 1: een leverancier kan een persoon zijn)
 *
 * Per genormaliseerde naam (K.normNaam, dezelfde sleutel als Velden verbeteren en de koerier): de bestaande leverancier (de oudste), anders
 * een nieuwe met als standaard de entiteit en betaalwijze van de bevestigde facturen (alleen als die het allemaal eens zijn). Een nagebeld
 * IBAN gaat alleen mee naar een NIEUWE leverancier (regel van wv1917). Statussen: alles na Bevestigen behalve wordt_verstuurd (de
 * vingerafdruk van een opdracht bevat geen leverancier, dus de koerier merkt niets). Eén transactie; versie van de factuur omhoog;
 * besluit- en auditrijen. Uitvoer zonder bedragen of rekeningnummers.
 */
'use strict';
const path = require('path');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));
const K = require(path.join(__dirname, '..', 'facturen-kern.js'));

const STATUSSEN = ['in_wachtrij', 'prive_archief', 'concept_klaar', 'verstuurd', 'verzending_mislukt'];
const WIE = 'machinekamer wv2590 (David 6-11-2026 23:04, Broedstoof: Facturen verder af)';

function lijst(v) { if (Array.isArray(v)) return v; try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j : []; } catch (e) { return []; } }

function naKoppelen(fdb, o) {
  o = o || {};
  const wanneer = o.wanneer || new Date().toISOString();
  const st = STATUSSEN.map(() => '?').join(',');
  const rijen = fdb.db.prepare('SELECT id, leverancier_naam, entiteit, betaalwijze, intern, versie, nagebeld_op, nagebeld_door, nagebeld_ibans FROM factuur ' +
    'WHERE leverancier IS NULL AND bevestigd_op IS NOT NULL AND leverancier_naam IS NOT NULL AND status IN (' + st + ') ORDER BY bevestigd_op, id').all(...STATUSSEN);
  const groepen = new Map();
  for (const f of rijen) {
    const norm = K.normNaam(f.leverancier_naam || '');
    if (!norm) continue;
    if (!groepen.has(norm)) groepen.set(norm, []);
    groepen.get(norm).push(f);
  }
  const uit = { facturen: 0, leveranciers_nieuw: 0, leveranciers_bestaand: 0, ibans: 0, overgeslagen: rijen.length, namen: [] };
  uit.overgeslagen = rijen.length - [...groepen.values()].reduce((t, g) => t + g.length, 0);
  const doe = function () {
    for (const [norm, fs] of groepen) {
      const best = fdb.db.prepare('SELECT id, naam FROM leverancier WHERE genormaliseerd = ? ORDER BY aangemaakt_op, id LIMIT 1').get(norm);
      let lev;
      if (best) { lev = { id: best.id, naam: best.naam, nieuw: false }; uit.leveranciers_bestaand++; }
      else {
        // een interne factuur (eigen entiteit als leverancier) factureert aan meer entiteiten: dan geen vaste entiteit
        const ents = fs.some((f) => f.intern) ? [] : [...new Set(fs.map((f) => f.entiteit).filter(Boolean))], bws = [...new Set(fs.map((f) => f.betaalwijze).filter((b) => b && b !== 'onbekend'))];
        const naam = fs[fs.length - 1].leverancier_naam;
        lev = { id: D.nieuwId(), naam, nieuw: true };
        if (!o.droog) {
          D.voegToe(fdb, 'leverancier', { id: lev.id, naam, genormaliseerd: norm, standaard_entiteit: ents.length === 1 ? ents[0] : null,
            standaard_betaalwijze: bws.length === 1 ? bws[0] : null, aangemaakt_op: wanneer, bijgewerkt_op: wanneer });
          D.audit(fdb, { wie: WIE, wat: 'leverancier_nieuw', object_soort: 'leverancier', object_id: lev.id, na: { naam, standaard_entiteit: ents.length === 1 ? ents[0] : null,
            standaard_betaalwijze: bws.length === 1 ? bws[0] : null, uit: 'bevestigde facturen zonder leverancier' }, wanneer });
        }
        uit.leveranciers_nieuw++;
      }
      uit.namen.push(lev.naam + (lev.nieuw ? ' (nieuw)' : ' (bestond)') + ': ' + fs.length);
      for (const f of fs) {
        if (lev.nieuw && f.nagebeld_op && f.nagebeld_door) {
          for (const iban of lijst(f.nagebeld_ibans)) {
            if (o.droog) { uit.ibans++; continue; }
            if (fdb.db.prepare('INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
              .run(lev.id, iban, f.nagebeld_door, f.nagebeld_op).changes) {
              uit.ibans++;
              D.audit(fdb, { wie: WIE, wat: 'nagebeld_meegenomen', object_soort: 'leverancier', object_id: lev.id, entiteit: f.entiteit,
                na: { factuur: f.id, aantal: 1, nagebeld_door: f.nagebeld_door }, wanneer });
            }
          }
        }
        if (o.droog) { uit.facturen++; continue; }
        const u = fdb.db.prepare('UPDATE factuur SET leverancier = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND versie = ? AND leverancier IS NULL').run(lev.id, wanneer, f.id, f.versie);
        if (u.changes !== 1) continue;
        fdb.db.prepare('INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wie, wanneer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(f.id, 'leverancier', 'leverancier', lev.id, 'mens', (lev.nieuw ? 'nieuwe' : 'bestaande') + ' leverancier op naam, achteraf (wv2590)', WIE, wanneer);
        D.audit(fdb, { wie: WIE, wat: 'leverancier_gekoppeld', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, na: { leverancier: lev.id, nieuw: lev.nieuw, achteraf: true }, wanneer });
        uit.facturen++;
      }
    }
  };
  if (o.droog) doe(); else D.transactie(fdb, doe);
  return uit;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const echt = a.includes('--echt');
  const i = a.indexOf('--db');
  const dir = i >= 0 ? a[i + 1] : process.env.FACTUREN_DIR || '/opt/data/facturen';
  if (echt && String(process.env.SOCEV_KANT || 'olares') !== 'olares') { console.error('alleen op de Olares-kant (daar staat de facturendatabase)'); process.exit(2); }
  const fdb = D.open(dir);
  try {
    const uit = naKoppelen(fdb, { droog: !echt });
    if (!a.includes('--namen')) delete uit.namen;
    console.log(JSON.stringify(Object.assign({ droog: !echt }, uit), null, 1));
  }
  finally { try { fdb.db.close(); } catch (e) {} }
}
module.exports = { naKoppelen, STATUSSEN };
