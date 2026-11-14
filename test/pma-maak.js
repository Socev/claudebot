'use strict';
// wv3037: VERZONNEN Promedico-exports (gegevensset "PMA") in de echte vorm, voor test/pma.test.js en de schermtoets in socev-app.
// Vorm (gemeten aan echte exports, 14-11-2026): ZIP met export_info.csv (geen aanhalingstekens, CRLF) en één …_PMA_VERRICHTING.csv
// (UTF-8 zonder BOM, ';', alle velden tussen aanhalingstekens, CRLF, tarief met punt, datum dd-mm-jjjj; ZIP-vlag 0x808 = UTF-8-namen +
// datadescriptor). Inschrijfgeld op de eerste dag van het kwartaal: 1 basis + 7 modules per patiënt, de jaar-module 31315 alleen in K1,
// opslagwijk 11119 bij een paar; verrichtingen met volledig gelijke regels, regels zonder factuurdatum, type O zonder code.
// ALLES verzonnen: patiëntnummers 9xxxxx, namen "A. Proefsen" e.d., tarieven rond.
const zlib = require('zlib');

function zip(bestanden) {   // [{ naam, data: Buffer }] → Buffer (deflate, vlag 0x808 met datadescriptor, zoals de echte export)
  const delen = [], centraal = []; let off = 0;
  for (const b of bestanden) {
    const naam = Buffer.from(b.naam, 'utf8'), comp = zlib.deflateRawSync(b.data), crc = zlib.crc32(b.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x808, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x5c21, 12); lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);
    lh.writeUInt16LE(naam.length, 26); lh.writeUInt16LE(0, 28);
    const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(b.data.length, 12);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x808, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x5c21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(b.data.length, 24);
    cd.writeUInt16LE(naam.length, 28); cd.writeUInt32LE(off, 42);
    delen.push(lh, naam, comp, dd); centraal.push(cd, naam);
    off += 30 + naam.length + comp.length + 16;
  }
  const cdBuf = Buffer.concat(centraal), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(bestanden.length, 8); eocd.writeUInt16LE(bestanden.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...delen, cdBuf, eocd]);
}

const KOP = 'id;patientnummer;Verrichting;Omschrijving;Type;Registreerder AGB;Registreerder;Soort;Tarief;Boekingsdatum;Factuurdatum';
const KOP_ZONDER = KOP.replace(';patientnummer', '');   // wv3045: Davids normale vorm sinds 14-11-2026 (e.zonderPnr)
const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
const nl = (iso) => iso.slice(8, 10) + '-' + iso.slice(5, 7) + '-' + iso.slice(0, 4);
const EIGEN_AGB = '01999999';   // verzonnen

// Een export: { agb, exportdatum, begin, eind (ISO), regels: [{ pnr, code, oms, type, agb?, reg, soort, tarief, dag, factuur? }] }
function maakExport(e) {
  const info = 'AGB;Export datum;Begin periode;Eind periode;Naam populatie;Naam gegevensset;Type\r\n' +
    [e.agb || '009870', nl(e.exportdatum), nl(e.begin), nl(e.eind), 'ExportEigenpatienten_' + nl(e.exportdatum).replace(/-/g, ''), e.set || 'PMA', 'Praktijk'].join(';');
  let id = 700000;
  const rijen = [e.kop || (e.zonderPnr ? KOP_ZONDER : KOP)].concat(e.regels.map((r) => [String(++id)].concat(e.zonderPnr ? [] : [r.pnr], [r.code || '', r.oms, r.type, r.agb === undefined ? EIGEN_AGB : r.agb, r.reg, r.soort || (r.type === 'I' ? 'INSCHRIJFGELD' : 'NORMAAL'),
    r.tarief, nl(r.dag), r.factuur === undefined ? (r.type === 'I' ? nl(r.dag) : '') : (r.factuur ? nl(r.factuur) : '')]).map(q).join(';')));
  const naam = 'export_ExportEigenpatienten_' + nl(e.exportdatum).replace(/-/g, '') + '_PMA_VERRICHTING.csv';
  return zip((e.extra || []).concat([{ naam: 'export_info.csv', data: Buffer.from(info, 'utf8') }, { naam, data: Buffer.from(rijen.join('\r\n') + '\r\n', 'utf8') }]));
}

const MODULES = [['11201', 'Opslag POH-GGZ', '3.50'], ['13050', 'Meer tijd voor de patiënt', '2.00'], ['30121', 'Resultaatbeloning service en bereikbaarheid', '1.00'],
  ['31080', 'POH-S', '3.00'], ['31174', 'Praktijkmanagement huisartsenzorg', '1.50'], ['31279', 'Toeslag spiegelen', '0.50'], ['31343', 'Zorgvernieuwing module POH-GGZ', '0.25']];
const BASIS = [['11115', 'Inschrijving verzekerden tot 65 jaar', '20.00'], ['11116', 'Inschrijving verzekerden vanaf 65 jaar tot 75 jaar', '25.00'],
  ['11117', 'Inschrijving verzekerden vanaf 75 jaar tot 85 jaar', '30.00'], ['11118', 'Inschrijving verzekerden vanaf 85 jaar', '35.00']];
const PRAKTIJKHOUDER = 'Z. Proefhouder';
function inschrijving(peildatum, patienten, jaarModule) {   // patienten: [{ pnr, klasse 0..3, opslag? }]
  const u = [];
  for (const p of patienten) {
    const b = BASIS[p.klasse];
    u.push({ pnr: p.pnr, code: b[0], oms: b[1], type: 'I', reg: PRAKTIJKHOUDER, tarief: b[2], dag: peildatum });
    for (const m of MODULES) u.push({ pnr: p.pnr, code: m[0], oms: m[1], type: 'I', reg: PRAKTIJKHOUDER, tarief: m[2], dag: peildatum });
    if (jaarModule) u.push({ pnr: p.pnr, code: '31315', oms: 'Toeslag afspraken tussen apothekers en huisartsen', type: 'I', reg: PRAKTIJKHOUDER, tarief: '0.75', dag: peildatum });
    if (p.opslag) u.push({ pnr: p.pnr, code: '11119', oms: 'Opslag inschrijving verzekerden woonachtig in een opslagwijk', type: 'I', reg: PRAKTIJKHOUDER, tarief: '1.25', dag: peildatum });
  }
  return u;
}
const C = { kort: ['12010', 'Consult regulier korter dan 5 minuten', '7.00'], middel: ['12011', 'Consult regulier vanaf 5 minuten tot 20 minuten', '14.00'],
  lang: ['12001', 'Consult regulier 20 minuten en langer', '28.00'], vk: ['12002', 'Visite regulier korter dan 20 minuten', '20.00'],
  vl: ['12003', 'Visite regulier 20 minuten en langer', '35.00'], ecg: ['13005', 'ECG-diagnostiek', '50.00'], chir: ['13012', 'Chirurgie', '80.00'],
  ggz: ['12111', 'Consult praktijkondersteuner GGZ 20 minuten en langer', '30.00'] };
const REG = ['A. Proefsen', 'B. Verzonnen', 'C. Testmans', 'Waarnemer Proefpraktijk'];
function zaad(n) { let s = n >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function eindVanMaand(iso) { const d = new Date(iso + 'T12:00:00Z'); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)).toISOString().slice(0, 10); }
function verrichtingen(van, tot, seed, voorlopigVanaf) {   // werkdagen van..tot; regels zonder factuurdatum vanaf voorlopigVanaf
  const r = zaad(seed), u = [];
  for (let d = van; d <= tot;) {
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd >= 1 && wd <= 5) {
      for (let i = 0; i < 6; i++) {
        const soort = ['kort', 'middel', 'middel', 'lang', 'vk', 'ecg'][Math.floor(r() * 6)], c = C[soort];
        const reg = REG[Math.floor(r() * REG.length)];
        u.push({ pnr: String(900001 + Math.floor(r() * 30)), code: c[0], oms: c[1], type: 'V', reg, tarief: c[2], dag: d, factuur: voorlopigVanaf && d >= voorlopigVanaf ? null : eindVanMaand(d) });
      }
    }
    const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10);
  }
  return u;
}
function patienten(n, start) { const u = []; for (let i = 0; i < n; i++) u.push({ pnr: String(start + i), klasse: i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : i % 10 < 9 ? 2 : 3, opslag: i % 17 === 3 }); return u; }

// Export A (januari): 40 patiënten op 1-1 met jaar-module; verrichtingen 2–31 jan, vanaf 26-1 nog niet gefactureerd; twee gelijke regels op 14-1; type O.
function exportA() {
  const pat = patienten(40, 900001);
  const v = verrichtingen('2026-01-02', '2026-01-30', 11, '2026-01-26');
  const dubbel = { pnr: '900007', code: C.kort[0], oms: C.kort[1], type: 'V', reg: 'A. Proefsen', tarief: C.kort[2], dag: '2026-01-14', factuur: '2026-01-31' };
  const regels = inschrijving('2026-01-01', pat, true).concat(v, [dubbel, Object.assign({}, dubbel)],
    [{ pnr: '900003', oms: 'Niet declareren', type: 'O', reg: 'B. Verzonnen', tarief: '0', dag: '2026-01-15', factuur: null },
      { pnr: '900004', oms: 'Philadelphia - Telefoon', type: 'O', agb: '', reg: 'C. Testmans', tarief: '0', dag: '2026-01-16', factuur: null },
      { pnr: '900005', code: '19999', oms: 'Verzonnen nieuwe prestatie', type: 'V', reg: 'A. Proefsen', tarief: '12.50', dag: '2026-01-21', factuur: '2026-01-31' }]);
  return { agb: '009870', exportdatum: '2026-02-03', begin: '2026-01-01', eind: '2026-01-31', regels, _pat: pat };
}
// Export B (overlap): 20–31 jan opnieuw (14 en 15 jan niet; 20-1 één regel erbij, 26–30 jan nu gefactureerd), februari t/m 1 april nieuw,
// 1 april inschrijfgeld zonder jaar-module: twee patiënten weg, drie erbij, één schuift door naar 65–75.
function exportB() {
  const a = exportA();
  const oud = a.regels.filter((r) => r.type !== 'I' && r.dag >= '2026-01-20').map((r) => Object.assign({}, r, r.type === 'V' ? { factuur: eindVanMaand(r.dag) } : {}));
  const erbij = { pnr: '900011', code: C.lang[0], oms: C.lang[1], type: 'V', reg: 'B. Verzonnen', tarief: C.lang[2], dag: '2026-01-20', factuur: '2026-01-31' };
  const pat = patienten(40, 900001).filter((p) => p.pnr !== '900002' && p.pnr !== '900013').concat(patienten(3, 900101));
  pat.find((p) => p.pnr === '900001').klasse = 1;
  const regels = oud.concat([erbij], verrichtingen('2026-02-02', '2026-03-31', 22, null), inschrijving('2026-04-01', pat, false),
    [{ pnr: '900020', code: C.ggz[0], oms: C.ggz[1], type: 'V', reg: 'D. Ggzproef', tarief: C.ggz[2], dag: '2026-02-10', factuur: '2026-02-28' },
      { pnr: '900021', code: C.chir[0], oms: C.chir[1], type: 'V', reg: 'A. Proefsen', tarief: C.chir[2], dag: '2026-03-05', factuur: '2026-03-31' }]);
  return { agb: '009870', exportdatum: '2026-04-08', begin: '2026-01-20', eind: '2026-04-01', regels };
}

// wv3047 (fase 2): personeel — een export sep–okt 2026 met vaste werkdagen en verzonnen Nmbrs/dossiers (test/pma-werkdag.test.js, socev-app test/pma-ui.cjs)
function reeks(van, tot) { const u = []; for (let d = van; d <= tot;) { u.push(d); const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); } return u; }
const wd = (d) => (new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7;
function exportPersoneel() {
  // september–oktober 2026: "A. Proefsen" (assistente, ma/di/do), "B. Verzonnen" (POH-GGZ via POT), "Waarnemer2 Proefpraktijk"
  // en "Q. Artsma" met AGB (arts). Plus inschrijfgeld op 1-10 op naam van de praktijkhouder (telt nooit als werkdag).
  const regels = inschrijving('2026-10-01', patienten(12, 900001), false);
  for (const d of reeks('2026-09-01', '2026-10-31')) {
    const w = wd(d);
    if ([0, 1, 3].includes(w)) for (let i = 0; i < 9; i++) regels.push({ pnr: String(900001 + i), code: C.middel[0], oms: C.middel[1], type: 'V', reg: 'A. Proefsen', agb: '', tarief: C.middel[2], dag: d, factuur: '2026-11-05' });
    if (w === 2) for (let i = 0; i < 6; i++) regels.push({ pnr: String(900001 + i), code: C.ggz[0], oms: C.ggz[1], type: 'V', reg: 'B. Verzonnen', agb: '', tarief: C.ggz[2], dag: d, factuur: '2026-11-05' });
    if (w < 5) for (let i = 0; i < 4; i++) regels.push({ pnr: String(900001 + i), code: C.lang[0], oms: C.lang[1], type: 'V', reg: 'Q. Artsma', agb: '01990001', tarief: C.lang[2], dag: d, factuur: '2026-11-05' });
    if (w === 4) regels.push({ pnr: '900009', code: C.kort[0], oms: C.kort[1], type: 'V', reg: 'Waarnemer2 Proefpraktijk', agb: '', tarief: C.kort[2], dag: d, factuur: '2026-11-05' });
  }
  return maakExport({ agb: '009870', exportdatum: '2026-11-02', begin: '2026-09-01', eind: '2026-10-31', regels, zonderPnr: true });
}
const NEP_PERSONEEL = {   // wv3047: verzonnen Nmbrs en dossiers
  peil: '2026-11-14',
  medewerkers: [
    { id: '11111111-1111-1111-1111-111111111111', naam: 'Anke Proefsen', voornaam: 'Anke', tussen: null, achternaam: 'Proefsen', entiteit: 'TG', dossier: '10_Zakelijk/Tolgaarde/Medewerkers/Anke Proefsen - doktersassistente.md',
      functies: [{ omschrijving: 'Doktersassistente', begin: '2024-03-01' }], dienst: [{ begin: '2024-03-01', eind: null }], contract: [{ begin: '2024-03-01', eind: null, uren: 24 }],
      rooster: [{ begin: '2024-03-01', uren: 24, dagen_per_week: 3, dagen1: null, dagen2: null }] },
    { id: '22222222-2222-2222-2222-222222222222', naam: 'Bram Verzonnen', voornaam: 'Bram', tussen: null, achternaam: 'Verzonnen', entiteit: 'POT', dossier: null,
      functies: [{ omschrijving: 'PO GGZ', begin: '2025-01-01' }], dienst: [{ begin: '2025-01-01', eind: null }], contract: [], rooster: [{ begin: '2025-01-01', uren: 8, dagen_per_week: 1 }] },
  ],
  dossiers: [{ pad: '10_Zakelijk/Tolgaarde/Medewerkers/Anke Proefsen - doktersassistente.md', naam: 'Anke Proefsen', rol: 'doktersassistente' },
    { pad: '10_Zakelijk/Tolgaarde/Medewerkers/Quinten Artsma - huisarts (praktijkhouder).md', naam: 'Quinten Artsma', rol: 'huisarts (praktijkhouder)' }],
};
module.exports = { exportPersoneel, NEP_PERSONEEL, zip, maakExport, KOP_ZONDER, exportA, exportB, inschrijving, verrichtingen, patienten, KOP, MODULES, BASIS, C, REG, nl };
