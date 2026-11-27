#!/usr/bin/env bash
# Toets wv4129 (27-11-2026, nr 334 = 3C34 en nr 414 = 3C114): blok meld-waarom in server.js, puur met neps (server.js nooit requiren).
#   1 stromen: laatste aanvoer gelijk aan stilte_state; haperingen uit stiltelog (stil→hersteld, dubbel stil = één, buiten 14 d weg, nog stil)
#   2 Waarom?: zelfde kaart binnen 10 min = zelfde beurt_id; daarna nieuw; andere kaart = ander
#   3 bericht bevat de kaartgegevens (titel, automatisering, stap/fout/run, tijd, storingsdienst, gevolg, ingehaald)
#   4 route: onbekende kaart 404 zonder beurt; twee tikken = twee keer hetzelfde beurt_id naar appBeurt (machinekamer), concept blijft
#   5 aansluiting: route, glijdende sessie, GET /app/meldingen geeft waarom
# Kruisproef: WAAROM_KRUIS=1 haalt het hergebruik van het beurt_id weg → 2a en 4b moeten rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/t.js" <<'EINDE'
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const HIER = process.argv[2];
let ok = 0, fout = 0;
function toets(n, w) { if (w) { ok++; console.log('ok   ' + n); } else { fout++; console.log('FOUT ' + n); } }
const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
let blok = /\/\* meld-waarom:begin \*\/([\s\S]*?)\/\* meld-waarom:einde \*\//.exec(src)[1];
if (process.env.WAAROM_KRUIS) blok = blok.replace('if (k[ref]) return { bid: k[ref].bid, al: true };', '');
const beurten = [];
const box = { appStaat: {}, logError: function () {}, appSha: function (s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); },
  appWfNaam: function (n) { return String(n || '').replace(/^AI\s*-\s*/, ''); }, appMeldRef: function (x) { return String(x.kaart || x.id); },
  appMeldMetSeintjes: function (l) { return l; },
  appWeiger: function (res, st, f) { res.st = st; res.f = f; },
  appBeurt: function (req, res, reg, a, s, d, opt) { beurten.push({ d: d, opt: opt }); res.st = 200; },
  appMeldingen: function () { return Promise.resolve(box.M); }, console: console };
vm.createContext(box);
vm.runInContext(blok + '\nthis.f = { appMeldStromen, appMeldWaaromBeurtId, appMeldWaaromTekst, appMeldingenWaarom, appMeldWaaromOp };', box);
const F = box.f;
// 1 stromen
const nu = Date.parse('2026-11-27T14:00:00Z'), grens = nu - 14 * 86400000;
const bewaakt = [
  { pijplijn_id: 'wfOutlook', naam: 'AI - Outlook meelezen', status: 'gezond', laatste_executie: '2026-11-27T10:29:57.325Z', drempel_uren: 24, raakt_david: 'ja' },
  { pijplijn_id: 'hartslag-locatie', naam: 'Locatie van je telefoon', status: 'gezond', laatste_executie: '2026-11-27T13:40:02.193Z', drempel_uren: 1, raakt_david: 'nee' },
  { pijplijn_id: 'wfParro', naam: 'AI - Parro meelezen', status: 'stil', laatste_executie: '2026-11-26T08:00:00Z', drempel_uren: 30, raakt_david: 'ja' },
];
const L = function (id, g, t) { return { pijplijn_id: id, gebeurtenis: g, tijdstip: t, createdAt: t }; };
const log = [
  L('wfOutlook', 'stil', '2026-10-20T10:00:00Z'), L('wfOutlook', 'hersteld', '2026-10-21T10:00:00Z'),   // buiten 14 d
  Object.assign(L('wfOutlook', 'stil', '2026-11-20T08:00:00Z'), { effectieve_uren: 24.5 }), L('wfOutlook', 'hersteld', '2026-11-20T12:00:00Z'),
  L('hartslag-locatie', 'stil', '2026-11-20T15:34:13.443Z'), L('hartslag-locatie', 'stil', '2026-11-20T15:34:13.637Z'), L('hartslag-locatie', 'stil', '2026-11-20T15:34:13.799Z'),
  L('hartslag-locatie', 'hersteld', '2026-11-20T15:35:29.405Z'),
  L('hartslag-locatie', 'stil', '2026-11-23T20:05:00Z'), L('hartslag-locatie', 'hersteld', '2026-11-23T20:20:00Z'),
  L('wfParro', 'stil', '2026-11-27T12:00:00Z'),
  L('wfAnders', 'stil', '2026-11-25T12:00:00Z'),
];
const st = F.appMeldStromen(bewaakt, log.slice().reverse(), grens, nu);
const by = function (n) { return st.find(function (s) { return s.naam.indexOf(n) >= 0; }); };
toets('1a alle bewaakte stromen, stil bovenaan', st.length === 3 && st[0].status === 'stil');
toets('1b laatste aanvoer gelijk aan stilte_state', by('Outlook').laatste === '2026-11-27T10:29:57.325Z' && by('Locatie').laatste === '2026-11-27T13:40:02.193Z');
toets('1c Outlook: alleen de hapering binnen 14 dagen, met terug-tijd', by('Outlook').haperingen.length === 1 && by('Outlook').haperingen[0].van === '2026-11-20T08:00:00.000Z' && by('Outlook').haperingen[0].tot === '2026-11-20T12:00:00.000Z' && by('Outlook').haperingen[0].uren === 24.5);
toets('1d drie keer stil na elkaar = één hapering; nieuwste eerst', by('Locatie').haperingen.length === 2 && by('Locatie').haperingen[0].van === '2026-11-23T20:05:00.000Z' && by('Locatie').haperingen[1].van === '2026-11-20T15:34:13.443Z');
toets('1e nog stil: tot null', by('Parro').haperingen.length === 1 && by('Parro').haperingen[0].tot === null);
toets('1f geen logboek: lege haperingen, tijden blijven', F.appMeldStromen(bewaakt, null, grens, nu).every(function (s) { return Array.isArray(s.haperingen) && !s.haperingen.length && s.laatste; }));
// 2 beurt_id
const t0 = nu;
const a1 = F.appMeldWaaromBeurtId('kabc123', t0), a2 = F.appMeldWaaromBeurtId('kabc123', t0 + 9 * 60000), a3 = F.appMeldWaaromBeurtId('kabc123', t0 + 11 * 60000);
toets('2a binnen 10 min: zelfde beurt_id, al gevraagd', a1.bid === a2.bid && !a1.al && a2.al);
toets('2b na 10 min: nieuw beurt_id', a3.bid !== a1.bid && !a3.al);
toets('2c andere kaart: ander beurt_id', F.appMeldWaaromBeurtId('kxyz999', t0 + 11 * 60000).bid !== a3.bid);
toets('2d beurt_id past in /app/beurt (8-64, a-z0-9-)', /^[a-z0-9-]{8,64}$/.test(a1.bid));
toets('2e waarom-tijd in de lijst binnen het venster', F.appMeldWaaromOp('kabc123', t0 + 12 * 60000) !== null && F.appMeldWaaromOp('kabc123', t0 + 22 * 60000) === null);
// 3 bericht
const kaart = { id: 'f101', kaart: 'k1a2b3c4d5e6f', soort: 'storing', titel: 'Agenda-Wachter liep vast', uitleg: 'Een andere dienst antwoordde niet op tijd.',
  wanneer: '2026-11-27T03:05:00Z', eerste: '2026-11-26T03:05:00Z', aantal: 2, techniek: 'stap: Haal agenda · fout: timeout · executie 98765, 98700',
  herstel: { stand: 'onbekend', tekst: 'Sindsdien niet meer gedraaid.' }, gevolg: { tekst: 'De nachtcontrole van je agenda ontbrak.', bron: 'vast' },
  ingehaald: { stand: 'nee', tekst: 'Nee — volgende nacht weer.' }, onderzoek: { oorzaak: 'De pod herstartte om 03:04.', gevolg: 'x', afloop: 'y', stand: 'klaar' }, voorval: 'v1' };
const tk = F.appMeldWaaromTekst(kaart, 'workflow AbCdEf123456', { van: '2026-11-27T03:00:00Z', tot: '2026-11-27T03:30:00Z', verschillend: 3, oorzaak: 'Uitrol.' });
toets('3a vraag oorzaak/gevolg/ingehaald bovenaan', /^Waarom\?/.test(tk) && /oorzaak/.test(tk) && /merk/.test(tk) && /ingehaald/.test(tk));
toets('3b kaartgegevens: titel, automatisering, stap, run, tijd, aantal', /Agenda-Wachter liep vast/.test(tk) && /workflow AbCdEf123456/.test(tk) && /Haal agenda/.test(tk) && /98765/.test(tk) && /27-11-2026 04:05/.test(tk) && /2× gemeld/.test(tk));
toets('3c wat de storingsdienst al vond, gevolg en ingehaald, voorval', /Storingsdienst: oorzaak: De pod herstartte/.test(tk) && /Gevolg voor jou \(kaart\): De nachtcontrole/.test(tk) && /Ingehaald \(kaart\): Nee/.test(tk) && /Voorval: .*3 storingen; oorzaak: Uitrol/.test(tk));
const stil = F.appMeldWaaromTekst({ id: 'n1', soort: 'stil', titel: 'Parro meelezen leverde niets meer aan', wanneer: '2026-11-27T12:00:00Z', aantal: 1, herstel: { tekst: 'Nog steeds stil.' } }, null, null);
toets('3d stilgevallen stroom: geen storingsdienst-regel, wel soort', /aanvoer stilgevallen/.test(stil) && !/Storingsdienst/.test(stil));
// 4 route
(async function () {
  box.appStaat.meldWaarom = {};
  box.M = { items: [kaart], voorvallen: [{ id: 'v1', van: '2026-11-27T03:00:00Z', tot: '2026-11-27T03:30:00Z', verschillend: 3, oorzaak: 'Uitrol.' }], herkomst: { k1a2b3c4d5e6f: 'workflow AbCdEf123456' } };
  const res0 = { _app: {} };
  await F.appMeldingenWaarom({}, res0, null, { id: 'a' }, null, { ref: 'kbestaatniet' });
  toets('4a onbekende kaart: 404, geen beurt', res0.st === 404 && beurten.length === 0);
  const r1 = { _app: {} }, r2 = { _app: {} };
  await Promise.all([F.appMeldingenWaarom({}, r1, null, { id: 'a' }, null, { ref: 'k1a2b3c4d5e6f' }), F.appMeldingenWaarom({}, r2, null, { id: 'b' }, null, { ref: 'k1a2b3c4d5e6f' })]);
  toets('4b twee tikken (twee apparaten): beide naar machinekamer met hetzelfde beurt_id', beurten.length === 2 && beurten[0].d.kanaal === 'machinekamer' && beurten[0].d.beurt_id === beurten[1].d.beurt_id && /al gevraagd/.test(r2._app.reden));
  toets('4c bericht met kaartgegevens en herkomst; concept blijft', /workflow AbCdEf123456/.test(beurten[0].d.tekst) && beurten[0].opt && beurten[0].opt.conceptHouden === true);
  const r3 = { _app: {} };
  await F.appMeldingenWaarom({}, r3, null, { id: 'a' }, null, { ref: 'K!' });
  toets('4d ongeldige ref: 400', r3.st === 400);
  // 5 aansluiting
  toets('5a route en glijdende sessie', /route === 'POST \/app\/meldingen\/waarom'\) return appMeldingenWaarom/.test(src) && /APP_GLIJD_ROUTES = new Set\(\[[^\]]*'POST \/app\/meldingen\/waarom'/.test(src));
  toets('5b niet slot-vrij (start een beurt)', !/APP_SLOT_VRIJ = new Set\(\[[^\]]*meldingen\/waarom/.test(src));
  toets('5c GET /app/meldingen: waarom per kaart, stromen in aanvoer', /y\.waarom = appMeldWaaromOp/.test(src) && /aanvoer\.stromen = appMeldStromen/.test(src));
  console.log(ok + ' goed, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})();
EINDE
node "$T/t.js" "$HIER"
