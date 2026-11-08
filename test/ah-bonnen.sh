#!/usr/bin/env bash
# Toetst ah-bonnen.js (wv2703: AH-kassabonnen in Financiën) tegen een nagebootste AH-backend op 127.0.0.1 met verzonnen bonnen:
# code uit de geplakte terugsprong, koppelen (token in de nepkluis, sha teruggelezen), ronde (pagina's, details, opslag, productsoort),
# rotatie van het refresh token, noodkopie bij een dichte kluis, geweigerde sleutel = dood (geen nieuwe pogingen), ontkoppelen wist
# kluis + noodkopie en stopt een lopende ronde (review MOET 1), achterstand bij de detailgrens loopt de volgende ronde door (MOET 2),
# unieke koppeling bon ↔ bank (MOET 3), netwerk alleen de witte lijst. Raakt pod, kluis en AH niet.
# Gebruik: bash test/ah-bonnen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
AH_TOETS_DIR="$D" node --no-warnings - <<'JS'
const http = require('http'), path = require('path'), fs = require('fs');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
// ── nep-AH ──
const N = 130;   // verzonnen bonnen, nieuwste eerst
const BON = [];
for (let i = 0; i < N; i++) { const d = new Date(Date.UTC(2026, 10, 7) - i * 86400000 * 2); BON.push({ id: 'proefbon-' + i, dateTime: d.toISOString().slice(0, 19), totalAmount: { amount: 10 + i } }); }
const nep = { codes: new Set(['proefcode-1234567890']), refresh: new Map([]), access: new Set(), roteer: true, verzoeken: [], kapot: false, detailVertraging: 0, naDetail: null };
let volg = 0;
function token(soort) { volg++; return soort + '-' + 'x'.repeat(20) + volg; }
const srv = http.createServer(function (q, r) {
  let b = ''; q.on('data', function (c) { b += c; }); q.on('end', async function () {
    nep.verzoeken.push(q.method + ' ' + q.url);
    const j = b ? JSON.parse(b) : {};
    const stuur = function (st, o) { r.writeHead(st, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.url === '/mobile-auth/v1/auth/token') {
      if (j.clientId !== 'appie' || !nep.codes.has(j.code)) return stuur(400, { error: 'invalid_grant' });
      nep.codes.delete(j.code); const a = token('acc'), rf = token('ref'); nep.access.add(a); nep.refresh.set(rf, true);
      return stuur(200, { access_token: a, refresh_token: rf, expires_in: 604798 });
    }
    if (q.url === '/mobile-auth/v1/auth/token/refresh') {
      if (!nep.refresh.get(j.refreshToken)) return stuur(400, { error: 'invalid_grant' });
      const a = token('acc'); nep.access.add(a);
      if (nep.roteer) { nep.refresh.set(j.refreshToken, false); const rf = token('ref'); nep.refresh.set(rf, true); return stuur(200, { access_token: a, refresh_token: rf }); }
      return stuur(200, { access_token: a });
    }
    if (q.url === '/graphql') {
      const tk = String(q.headers.authorization || '').replace('Bearer ', '');
      if (!nep.access.has(tk)) return stuur(401, {});
      if (/posReceiptsPage/.test(j.query)) { const o = j.variables.offset, l = j.variables.limit; return stuur(200, { data: { posReceiptsPage: { posReceipts: BON.slice(o, o + l) } } }); }
      if (/posReceiptDetails/.test(j.query)) {
        if (nep.detailVertraging) await new Promise(function (x) { setTimeout(x, nep.detailVertraging); });
        if (nep.naDetail) { const f = nep.naDetail; nep.naDetail = null; await f(); }
        const i = Number(String(j.variables.id).split('-')[1]);
        return stuur(200, { data: { posReceiptDetails: { id: j.variables.id, memberId: 'GEHEIM-KAART',
          products: [{ id: 1, name: 'AH HALFVOLLE MELK', quantity: 2, price: { amount: 1.5 }, amount: { amount: 3 } }, { id: 2, name: 'BANANEN', quantity: 1, price: { amount: 2 }, amount: { amount: 2 } },
            { id: 3, name: 'STATIEGELD', quantity: 1, price: { amount: 0.25 }, amount: { amount: 0.25 } }, { id: 4, name: 'HEINEKEN PILS 6X33', quantity: 1, price: { amount: 4.75 + i }, amount: { amount: 4.75 + i } }],
          discounts: [{ name: 'BONUS', type: 'bonus', amount: { amount: -1 } }], total: { amount: 10 + i }, payments: [{ method: 'PIN', amount: { amount: 10 + i } }] } } });
      }
    }
    stuur(404, {});
  });
});
srv.listen(0, '127.0.0.1', async function () {
  process.env.AH_BASIS = 'http://127.0.0.1:' + srv.address().port;
  process.env.AH_PAUZE_MS = '0';
  const A = require(path.resolve('ah-bonnen.js'));
  const dir = path.join(process.env.AH_TOETS_DIR, 'ah');
  const kluis = { w: '', dicht: false, zet: 0 };
  const deps = { dir: dir,
    kluisLees: async function () { if (kluis.dicht) throw new Error('dicht'); return { refresh: kluis.w }; },
    kluisZet: async function (v) { if (kluis.dicht) throw new Error('dicht'); kluis.w = v; kluis.zet++; return A.sha(v); },
    kluisLeeg: async function () { if (kluis.dicht) throw new Error('dicht'); kluis.w = ''; } };
  try {
    // code uit plaktekst
    toets('code uit de hele link', A.codeUit('appie://login-exit?code=abcDEF123456') === 'abcDEF123456');
    toets('code uit een consoleregel', A.codeUit("Failed to launch 'appie://login-exit?code=abc-DEF_1234.5~x' because the scheme does not have a registered handler.") === 'abc-DEF_1234.5~x');
    toets('losse code', A.codeUit('  abcdefgh12345 ') === 'abcdefgh12345');
    toets('geen code in rommel', A.codeUit('hallo daar <script>') === null && A.codeUit('') === null);
    toets('productsoort', A.soortVan('AH HALFVOLLE MELK') === 'zuivel en eieren' && A.soortVan('BANANEN') === 'groente en fruit' && A.soortVan('STATIEGELD') === 'statiegeld en tasjes' && A.soortVan('HEINEKEN PILS 6X33') === 'alcohol' && A.soortVan('XQZ') === 'overig');
    // wv2714: echte bonnamen zijn afgekort tot 12 tekens en vaak een merk (gemeten 8-11-2026 op 309 echte bonnen)
    const AFGEKORT = { 'OLD AMSTERDM': 'zuivel en eieren', 'PAGE TOILET': 'huishouden', 'LAVAZZA': 'drinken', 'TEXELS 0.0': 'drinken', 'HEINEKEN 0.0': 'drinken',
      'AVIKO FRITES': 'diepvries', 'FRITESSAUS': 'pasta, rijst en voorraad', 'CHIQUITA LOS': 'groente en fruit', 'UNOX KNAKS': 'vlees, vis en vega', 'LU MIKADO': 'snoep, koek en chips',
      'WITTE BOLLEN': 'brood en ontbijt', 'ELV NUT COND': 'verzorging', 'DESPERADOS V': 'alcohol', 'BERTOLLI': 'pasta, rijst en voorraad', 'TEFAL PAN': 'overig' };
    const misAfg = Object.keys(AFGEKORT).filter(function (n) { return A.soortVan(n) !== AFGEKORT[n]; }).map(function (n) { return n + '=' + A.soortVan(n); });
    toets('productsoort op afgekorte bonnamen (merken, 0.0 = drinken)', misAfg.length === 0, misAfg);
    // koppelen met verkeerde code
    let k = await A.koppel(deps, 'appie://login-exit?code=verkeerd-12345678');
    toets('verkeerde code: niet gekoppeld, gewone-taalreden', k.ok === false && k.reden === 'code' && /verlopen of al gebruikt/.test(k.fout) && kluis.w === '', k);
    k = await A.koppel(deps, "appie://login-exit?code=proefcode-1234567890");
    toets('koppelen: ok, token in de kluis, geen noodkopie', k.ok === true && /^ref-/.test(kluis.w) && !fs.existsSync(path.join(dir, 'refresh.nood')), k);
    toets('koppelen: map 700', (fs.statSync(dir).mode & 0o777) === 0o700);
    toets('koppelen: antwoord zonder token', JSON.stringify(k).indexOf('ref-') < 0 && JSON.stringify(k).indexOf('acc-') < 0);
    // eerste ronde met detailgrens 100 → achterstand (MOET 2)
    const r1 = await A.ronde(deps, { max_details: 100 });
    toets('ronde 1: 100 bonnen, achterstand', r1.ok === true && r1.bonnen_nieuw === 100 && r1.achterstand === true && r1.paginas === 3, r1);
    toets('ronde 1: refresh token geroteerd en in de kluis', r1.geroteerd === true && nep.refresh.get(kluis.w) === true);
    toets('sqlite 600', (fs.statSync(path.join(dir, 'ah.sqlite')).mode & 0o777) === 0o600);
    const r2 = await A.ronde(deps, { max_details: 100 });
    toets('ronde 2: de overige 30 erbij, geen achterstand meer', r2.ok === true && r2.bonnen_nieuw === 30 && r2.achterstand === false && r2.bonnen === 130, r2);
    // nieuwe bon bovenaan; achterstand weg → stopt na de eerste pagina
    BON.unshift({ id: 'proefbon-900', dateTime: '2026-11-08T10:00:00', totalAmount: { amount: 910 } });
    nep.verzoeken = [];
    const r3 = await A.ronde(deps, {});
    toets('ronde 3: alleen de nieuwe bon, stopt vroeg (2 lijstpagina\'s: nieuw, dan alles bekend)', r3.ok && r3.bonnen_nieuw === 1 && r3.paginas === 2, r3);
    // opslag: geen bonuskaart
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'ah.sqlite'), { readOnly: true });
    const dump = JSON.stringify(db.prepare('SELECT * FROM bon').all()) + JSON.stringify(db.prepare('SELECT * FROM regel').all());
    toets('geen bonuskaartnummer opgeslagen', dump.indexOf('GEHEIM-KAART') < 0);
    toets('regels met soort', db.prepare("SELECT count(*) n FROM regel WHERE soort = 'alcohol'").get().n === 131);
    db.close();
    // kluis dicht bij rotatie → noodkopie; volgende ronde zet hem eerst terug
    kluis.dicht = true;
    const r4 = await A.ronde(deps, {});
    toets('kluis dicht: ronde zonder kluis faalt netjes', r4.ok === false && r4.reden === 'kluis', r4);
    kluis.dicht = false;
    // maak de kluis-zet stuk bij rotatie
    const zet0 = deps.kluisZet; deps.kluisZet = async function () { throw new Error('stuk'); };
    const r5 = await A.ronde(deps, {});
    toets('rotatie met kapotte kluis: noodkopie 600, ronde ok', r5.ok === true && r5.nood === true && (fs.statSync(path.join(dir, 'refresh.nood')).mode & 0o777) === 0o600, r5);
    deps.kluisZet = zet0;
    const r6 = await A.ronde(deps, {});
    toets('volgende ronde: noodkopie in de kluis, weg van schijf', r6.ok === true && r6.nood_hersteld === true && !fs.existsSync(path.join(dir, 'refresh.nood')) && nep.refresh.get(kluis.w) === true, r6);
    // overzicht + unieke bankkoppeling
    const twaalf = []; for (let m = 0; m < 12; m++) { const d = new Date(Date.UTC(2025, 11 + m, 1)); twaalf.push(d.toISOString().slice(0, 7)); }
    const bank = [
      { nr: 1, datum: '2026-11-07', bedrag: -10 },              // proefbon-0, zelfde dag
      { nr: 2, datum: '2026-11-07', bedrag: -11 },              // proefbon-1 (5-11) 2 dagen later
      { nr: 3, datum: '2026-10-01', bedrag: -999 },             // geen bon
      { nr: 4, datum: '2026-11-03', bedrag: -12 }, { nr: 5, datum: '2026-11-04', bedrag: -12 }   // proefbon-2 (3-11): twee kandidaten → onbeslist
    ];
    // wv2714: een oud opgeslagen soort telt niet; het overzicht deelt opnieuw in met de huidige woordregels
    { const dbw = new DatabaseSync(path.join(dir, 'ah.sqlite')); dbw.exec("UPDATE regel SET soort = 'overig'"); dbw.close(); }
    const o = A.overzicht(dir, bank, { twaalf: twaalf });
    toets('overzicht: soort uit de huidige woordregels, niet uit de opgeslagen kolom', o.soorten.some(function (x) { return x.naam === 'alcohol' && x.som > 0; }) && o.duurst.every(function (p) { return p.soort === A.soortVan(p.naam); }), o.soorten.map(function (x) { return x.naam; }));
    toets('overzicht: gekoppeld, soorten, duurst/vaakst zonder statiegeld', o.gekoppeld === true && o.soorten.length >= 4 && o.duurst.every(function (p) { return p.soort !== 'statiegeld en tasjes'; }) && o.vaakst[0].keer > 1, { s: o.soorten.map(function (x) { return x.naam; }), v: o.vaakst[0] });
    toets('bank: 2 uniek gekoppeld, 1 onbeslist, dekking', o.bank.posten_met_bon === 2 && o.bank.onbeslist === 1 && o.bank.met_bon === 21 && o.bank.dekking === Math.round(100 * 21 / (10 + 11 + 999 + 24)), o.bank);
    toets('overzicht zonder bonnummers of token', JSON.stringify(o).indexOf('proefbon') < 0 && JSON.stringify(o).indexOf('ref-') < 0);
    const kb = A.koppelBank([{ id: 'a', tijd: '2026-01-01T10:00', totaal: 5, betalingen: [5] }, { id: 'b', tijd: '2026-01-01T12:00', totaal: 5, betalingen: [5] }], [{ nr: 9, datum: '2026-01-01', bedrag: -5 }]);
    toets('twee bonnen op één bankpost: geen paar (onbeslist)', kb.paar.size === 0 && kb.onbeslist === 2, { n: kb.paar.size, o: kb.onbeslist });
    // ontkoppelen tijdens een lopende ronde (MOET 1): na de eerste detail-aanroep ontkoppelen
    BON.unshift({ id: 'proefbon-901', dateTime: '2026-11-08T11:00:00', totalAmount: { amount: 911 } }, { id: 'proefbon-902', dateTime: '2026-11-08T12:00:00', totalAmount: { amount: 912 } });
    nep.naDetail = async function () { await A.ontkoppel(deps); };
    const r7 = await A.ronde(deps, {});
    toets('ontkoppelen midden in een ronde: ronde stopt, kluis leeg, geen noodkopie', r7.reden === 'ontkoppeld' && kluis.w === '' && !fs.existsSync(path.join(dir, 'refresh.nood')), { r7: r7, k: kluis.w });
    const r8 = await A.ronde(deps, {});
    toets('na ontkoppelen: ronde doet niets', r8.ok === false && r8.reden === 'niet-gekoppeld');
    toets('na ontkoppelen: bonnen blijven, overzicht niet gekoppeld', (function () { const x = A.overzicht(dir, [], { twaalf: twaalf }); return x.gekoppeld === false && x.bonnen === 131; })());
    // opnieuw koppelen, daarna geweigerde sleutel → dood, geen nieuwe pogingen
    nep.codes.add('proefcode-2222222222');
    k = await A.koppel(deps, 'proefcode-2222222222');
    toets('opnieuw koppelen werkt', k.ok === true && /^ref-/.test(kluis.w));
    nep.refresh.set(kluis.w, false);
    const r9 = await A.ronde(deps, {});
    const n0 = nep.verzoeken.length;
    const r10 = await A.ronde(deps, {});
    toets('geweigerde sleutel: dood, tweede ronde roept AH niet aan', r9.reden === 'grant' && r10.reden === 'dood' && nep.verzoeken.length === n0, { r9: r9, r10: r10 });
    // netwerk: witte lijst
    const src = fs.readFileSync('ah-bonnen.js', 'utf8');
    toets('één fetch in de module', (src.match(/\bfetch\(/g) || []).length === 1);
    toets('redirect: error en toetsbasis alleen 127.0.0.1', /redirect: 'error'/.test(src) && /127\\\.0\\\.0\\\.1/.test(src));
  } catch (e) { toets('geen uitzondering', false, String(e && e.stack || e)); }
  srv.close();
  console.log('KLAAR ' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
});
JS
