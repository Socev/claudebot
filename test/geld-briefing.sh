#!/usr/bin/env bash
# Toetst "Geld deze maand" (wv777, idee 16 stap C; bouwplan Privé-financiën § 12): de pure functies van financien-app.js (briefingDag,
# werkdag/feestdag, briefingNieuw, briefingTekst) en geldBriefingRonde uit server.js (vm-context) met een nagebootste leesopdracht,
# n8n en Supabase. Toetst: alleen na de avondronde, de dag vóór de eerste werkdag na de 24e (feestdagen, weekend, december), inhaal
# op een latere werkdag in dezelfde maand, één keer per maand, de rij in ochtend_buffer (bron geld, datum = briefingdag), geheugen
# direct na de rij, eerste keer (jaarvergelijking telt als bekend), dedupe, kaarten met herkansing, podklok tegen n8n, poort op de
# vaste-lastenrekening, onleesbaar geheugen, één box-rij per maand per reden en geen bedragen in log of box.
# Raakt de banken, /opt/data/bank, n8n, Supabase en de echte vault niet. Gebruik: bash test/geld-briefing.sh
#
# Droge ronde op echte gegevens (machinekamer, VACUUM INTO-kopie): GB_DROOG_BANK_DIR=<map met transacties.sqlite> GB_DROOG_DATUM=2026-10-25 bash test/geld-briefing.sh
# Dan draait de echte leesopdracht (bank-lezer.js geld-briefing); n8n en Supabase blijven nagebootst en het geheugen komt in die map.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), vm = require('vm');
const { spawn } = require('child_process');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const F = require(path.resolve('financien-app.js'));

// ── briefingDag, werkdag, feestdag ──
toets('pasen 2026 = 5-4, 2027 = 28-3', F.pasen(2026) === '2026-04-05' && F.pasen(2027) === '2027-03-28');
const dag = { '2026-04': '2026-04-28', '2026-05': '2026-05-26', '2026-07': '2026-07-27', '2026-10': '2026-10-26', '2026-12': '2026-12-28', '2027-03': '2027-03-25', '2027-12': '2027-12-27', '2028-04': '2028-04-25' };
Object.keys(dag).forEach(function (m) { toets('briefingDag ' + m + ' = ' + dag[m], F.briefingDag(m) === dag[m], F.briefingDag(m)); });
toets('Koningsdag 2025 op zondag → 26-4 feestdag', F.feestdag('2025-04-26') && !F.feestdag('2025-04-27'));
toets('Pinkstermaandag 25-5-2026 geen werkdag, Goede Vrijdag wel', !F.werkdag('2026-05-25') && F.werkdag('2026-04-03'));

// ── briefingNieuw ──
const s1 = { soort: 'duurder', sleutel: 'bedrag|n:kpn|maand', niveau: 116, zin: 'KPN duurder (maand)', ernst: 'wacht' };
const j1 = { soort: 'duurder', sleutel: 'bedrag|n:nm|maand', niveau: 9.25, jaar: true, zin: 'NM duurder (jaar)', ernst: 'wacht' };
const d1 = { soort: 'dubbel', sleutel: 'dubbel|paypal 4.99', zin: '2 keer 4,99', ernst: 'wacht', kaart: 'dubbel' };
const b1 = { soort: 'buffer', sleutel: 'buffer', zin: 'buffer krap', ernst: 'wacht' };
let r = F.briefingNieuw({ peildatum: '2026-10-25', signalen: [s1, j1, d1], stand: {} }, {}, { eersteKeer: true });
toets('eerste keer: jaarvergelijking bekend, maand-op-maand en dubbel nieuw', r.nieuw.length === 2 && r.nieuw.indexOf(j1) < 0 && r.gemeld[j1.sleutel] && r.gemeld[j1.sleutel].niveau === 9.25, r);
let g = r.gemeld;
r = F.briefingNieuw({ peildatum: '2026-11-24', signalen: [j1, d1, Object.assign({}, j1, { sleutel: 'bedrag|n:x|maand', niveau: 50 })], stand: {} }, g);
toets('volgende maand: jaar op zelfde niveau en dubbel stil, nieuwe jaarvergelijking wel', r.nieuw.length === 1 && r.nieuw[0].sleutel === 'bedrag|n:x|maand', r.nieuw);
r = F.briefingNieuw({ peildatum: '2026-11-24', signalen: [Object.assign({}, j1, { niveau: 9.6 }), Object.assign({}, j1, { sleutel: 'bedrag|n:kpn|maand', niveau: 130 })], stand: {} }, g);
toets('jaar: kleine verschuiving stil, maand-op-maand na een jaarmelding toch nieuw', r.nieuw.length === 1 && r.nieuw[0].niveau === 130, r.nieuw);
r = F.briefingNieuw({ peildatum: '2026-10-25', signalen: [s1], stand: {} }, g);
toets('zelfde peildag nog eens: maand-op-maand niet dubbel', r.nieuw.length === 0, r.nieuw);
let gb = F.briefingNieuw({ peildatum: '2026-06-24', signalen: [b1], stand: { buffer_krap: true, buffer_ruim: false } }, {}).gemeld;
r = F.briefingNieuw({ peildatum: '2026-07-24', signalen: [b1], stand: { buffer_krap: true, buffer_ruim: false } }, gb);
toets('buffer: tweede maand krap stil', r.nieuw.length === 0);
gb = F.briefingNieuw({ peildatum: '2026-08-24', signalen: [], stand: { buffer_krap: false, buffer_ruim: false } }, r.gemeld).gemeld;
toets('buffer: niet krap maar ook niet ruim → geheugen blijft (geen flapperen)', !!gb.buffer);
gb = F.briefingNieuw({ peildatum: '2026-09-24', signalen: [], stand: { buffer_krap: false, buffer_ruim: true } }, gb).gemeld;
r = F.briefingNieuw({ peildatum: '2026-10-24', signalen: [b1], stand: { buffer_krap: true } }, gb);
toets('buffer: na ruim weer krap → opnieuw', r.nieuw.length === 1);
r = F.briefingNieuw({ peildatum: '2027-12-24', signalen: [], stand: {} }, g);
toets('geheugen: sleutels ouder dan 400 dagen weg', Object.keys(r.gemeld).length === 0, r.gemeld);
const veel = []; for (let i = 0; i < 9; i++) veel.push({ soort: 'nieuw', sleutel: 'nieuw|' + i, zin: 'Nieuw ' + i + '.', ernst: i === 8 ? 'fout' : 'info' });
r = F.briefingNieuw({ peildatum: '2026-10-25', signalen: veel, stand: {} }, {});
const tk = F.briefingTekst(r.nieuw);
toets('tekst: ernstigste eerst, hooguit 6 + "en nog 3", slotregel, geen VRAAG-regel', tk.split('\n')[0] === '• Nieuw 8.' && tk.split('\n').length === 8 && /en nog 3 kleinere/.test(tk) && /Socev zegt niets op en betaalt niets\.$/.test(tk) && !/VRAAG AAN DAVID/.test(tk), tk);
toets('tekst: kaart krijgt "(staat in Voor jou)"; leeg = leeg', /\(staat in Voor jou\)/.test(F.briefingTekst([d1])) && F.briefingTekst([]) === '');

// ── geldBriefingRonde in een vm-context ──
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'geld-briefing-'));
const droog = process.env.GB_DROOG_BANK_DIR ? { bank: process.env.GB_DROOG_BANK_DIR, datum: process.env.GB_DROOG_DATUM || '2026-10-25' } : null;
const BD = droog ? droog.bank : path.join(W, 'bank'); if (!droog) fs.mkdirSync(BD, { mode: 0o700 });
const VAULT = path.join(W, 'vault');
fs.mkdirSync(path.join(VAULT, '00_Systeem', 'Meldingen'), { recursive: true });
const BOX = path.join(VAULT, '00_Systeem', 'Meldingen', 'machinekamer.md');
fs.writeFileSync(BOX, '# box\n\n## [direct] 2026-10-20 10:00 — oude rij\n- status: open\n');
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── wv680: bankluis'), b = src.indexOf('// ── einde bankluis ──');
const k1 = src.indexOf('function smalKind('), k2 = src.indexOf('async function smalSbRpc(');
const logs = [], zend = [], rpc = [];
let zendFout = null, rpcFout = null;
const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD, N8N_API_KEY: 'k' };
const g2 = { require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, VAULT: VAULT, SECRET: 'x'.repeat(40),
  __dirname: process.cwd(), process: { env: env, execPath: process.execPath, pid: process.pid }, spawn: spawn, APP_MELD_TABEL: 'TABEL',
  appN8nBasis: () => 'http://n8n.test', appN8nZend: async function (m, p, body) { if (zendFout) throw new Error(zendFout); zend.push({ m, p, body }); return [Object.assign({ id: 1 }, body.data)]; },
  fetch: async function () { throw new Error('geen netwerk in deze toets'); },
  appSbRpc: async function (n, p) { if (rpcFout) throw new Error(rpcFout); rpc.push({ n, p }); return { ok: true }; },
  logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (x) => logs.push(x), nu: () => 'NU', velden: (o) => JSON.stringify(o),
  reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
const ctx = vm.createContext(g2);
vm.runInContext(src.slice(k1, k2) + '\n' + src.slice(a, b) + '\n;globalThis.__h = { geldBriefingRonde };', ctx, { filename: 'server.js#bank' });
const h = ctx.__h;
const STAAT = path.join(BD, 'geld-briefing.json');
const ms = (d, u) => Date.parse(d + 'T' + String(u).padStart(2, '0') + ':00:00+01:00');
const ronde = (d, u, extra) => h.geldBriefingRonde(Object.assign({ datum: d, uur: u, nuMs: ms(d, u), n8nMs: ms(d, u) }, extra || {}));
const boxRijen = () => (fs.readFileSync(BOX, 'utf8').match(/^## \[direct\]/gm) || []).length;

(async function () {
  if (droog) {
    const u = await ronde(droog.datum, 18);
    console.log(JSON.stringify(u));
    console.log('upsert: ' + JSON.stringify(zend.map((x) => ({ p: x.p, datum: x.body.data.datum, regels: String(x.body.data.tekst).split('\n').length }))));
    console.log('kaarten: ' + JSON.stringify(rpc.map((x) => x.p.p.titel)));
    toets('droog: ronde gedaan', u.gedaan === true, [u, logs]);
    toets('droog: geheugen in de kopie van BANK_DIR (600)', JSON.parse(fs.readFileSync(STAAT, 'utf8')).maand_klaar === droog.datum.slice(0, 7) && (fs.statSync(STAAT).mode & 0o777) === 0o600);
    toets('droog: geen bedragen of namen in api-log', !logs.some((x) => /€|\d+,\d\d/.test(x)), logs);
    console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(fouten ? 1 : 0);
  }
  let kind = null, kindArgs = [];
  ctx.bankKind = async function (args) { kindArgs.push(args); return kind ? kind(args) : { code: 0, j: { ok: false, fout: 'geen' } }; };
  const sig = { soort: 'duurder', sleutel: 'bedrag|n:kpn mobiel|maand', niveau: 116.32, naam: 'KPN - Mobiel', ernst: 'wacht', zin: 'KPN - Mobiel kost nu € 116,32 per maand; een maand eerder € 112,05 (+4%).' };
  const jaar = { soort: 'duurder', sleutel: 'bedrag|n:nm|maand', niveau: 9.25, jaar: true, naam: 'NM', ernst: 'wacht', zin: 'NM jaar' };
  const dub = { soort: 'dubbel', sleutel: 'dubbel|paypal 4.99', naam: 'PayPal', paypal: true, bedrag: 4.99, aantal: 2, ernst: 'wacht', kaart: 'dubbel', zin: '2 keer € 4,99 per maand via PayPal: 2 abonnementen of één dubbel?' };
  const dek = { soort: 'dekking', sleutel: 'dekking|2026-10', naam: 'Vaste-lastenrekening', ernst: 'fout', kaart: 'dekking', bedrag: 120, zin: 'Het saldo dekt het niet.' };
  const uitkomst = (signalen, extra) => (args) => ({ code: 0, j: Object.assign({ ok: true, peildatum: args[2], signalen: signalen, stand: {}, nieuwste_post: args[2], fouten: [] }, extra || {}) });

  toets('ochtendronde doet niets', (await ronde('2026-10-25', 7)).reden === 'alleen na de avondronde');
  toets('za 24-10: morgen zondag, vóór de briefingdag → niets', (await ronde('2026-10-24', 18)).reden === 'nog niet' && kindArgs.length === 0);
  toets('vr 23-10 → niets (morgen 24e)', (await ronde('2026-10-23', 18)).reden === 'nog niet');

  kind = uitkomst([sig, jaar, dub]);
  let u = await ronde('2026-10-25', 18);
  let st = JSON.parse(fs.readFileSync(STAAT, 'utf8'));
  toets('zo 25-10 18:00: blok voor ma 26-10', u.gedaan === true && u.blok === '2026-10-26' && zend.length === 1 && zend[0].p === '/data-tables/TABEL/rows/upsert', [u, zend]);
  toets('rij: bron geld, filter op bron, tekst met de signalen, jaarvergelijking niet (eerste keer)', zend[0].body.data.bron === 'geld' && zend[0].body.filter.filters[0].value === 'geld' &&
    /KPN - Mobiel/.test(zend[0].body.data.tekst) && /\(staat in Voor jou\)/.test(zend[0].body.data.tekst) && !/NM jaar/.test(zend[0].body.data.tekst), zend[0].body.data.tekst);
  toets('leesopdracht: --peil vandaag, geen --vorige de eerste keer', JSON.stringify(kindArgs[0]) === JSON.stringify(['geld-briefing', '--peil', '2026-10-25']), kindArgs);
  toets('kaart dubbel gezet: doen, privé, stappen, deadline, geen pad of wv', rpc.length === 1 && rpc[0].n === 'mk_voor_jou_zet' && rpc[0].p.p.soort === 'doen' && rpc[0].p.p.prive === true &&
    rpc[0].p.p.stappen.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(rpc[0].p.p.deadline) && !/wv\d|\/opt\/|\.md/.test(JSON.stringify(rpc[0].p.p)) && /^geld-[0-9a-f]{12}$/.test(rpc[0].p.p.sleutel), rpc[0] && rpc[0].p.p);
  toets('geheugen: maand klaar, laatste_peil, gemeld, kaarten_open leeg, rechten 600', st.maand_klaar === '2026-10' && st.laatste_peil === '2026-10-25' && st.gemeld['bedrag|n:nm|maand'] &&
    Array.isArray(st.kaarten_open) && st.kaarten_open.length === 0 && (fs.statSync(STAAT).mode & 0o777) === 0o600, st);
  u = await ronde('2026-10-26', 18);
  toets('dezelfde maand nog eens → al gedaan, geen tweede rij', u.reden === 'al gedaan' && zend.length === 1);

  // november: --vorige uit het geheugen; alleen staande signalen (jaar, dubbel) → geen rij, wel klaar
  kind = uitkomst([jaar, dub]); kindArgs = [];
  u = await ronde('2026-11-24', 18);
  toets('november: --vorige 2026-10-25 mee', JSON.stringify(kindArgs[0]) === JSON.stringify(['geld-briefing', '--peil', '2026-11-24', '--vorige', '2026-10-25']), kindArgs);
  toets('november: niets nieuw → geen rij, wel klaar', u.gedaan === true && u.regels === 0 && zend.length === 1 && JSON.parse(fs.readFileSync(STAAT, 'utf8')).maand_klaar === '2026-11', u);

  // december: zo 27-12 → ma 28-12; upsert faalt → geen klaar; ma 28-12 avond → inhaal voor di 29-12
  kind = uitkomst([Object.assign({}, sig, { niveau: 130, zin: 'KPN nog duurder.' }), dek]);
  zendFout = 'n8n http 500';
  const boxVoor = boxRijen();
  u = await ronde('2026-12-27', 18);
  toets('december: upsert faalt → fout, niet klaar, één box-rij', !!u.fout && JSON.parse(fs.readFileSync(STAAT, 'utf8')).maand_klaar === '2026-11' && boxRijen() === boxVoor + 1, [u, boxRijen()]);
  toets('box-rij: bron geld, geen bedragen', /geld deze maand 2026-12/.test(fs.readFileSync(BOX, 'utf8')) && !/€/.test(fs.readFileSync(BOX, 'utf8')));
  u = await ronde('2026-12-27', 19);
  toets('zelfde fout nog eens → geen tweede box-rij', boxRijen() === boxVoor + 1);
  zendFout = null; rpcFout = 'supabase weg';
  u = await ronde('2026-12-28', 18);
  st = JSON.parse(fs.readFileSync(STAAT, 'utf8'));
  toets('inhaal ma 28-12 avond: blok voor di 29-12', u.gedaan === true && u.blok === '2026-12-29' && zend[zend.length - 1].body.data.datum === '2026-12-29', [u, zend.length]);
  toets('kaart faalt → blijft in kaarten_open (dekking)', st.kaarten_open.length === 1 && st.kaarten_open[0].titel.indexOf('bijstorten') > 0 && st.maand_klaar === '2026-12', st.kaarten_open);
  rpcFout = null;
  u = await ronde('2026-12-29', 18);
  toets('volgende avond: kaart alsnog gezet, geen nieuwe rij', u.reden === 'al gedaan' && JSON.parse(fs.readFileSync(STAAT, 'utf8')).kaarten_open.length === 0 && rpc.some((x) => /bijstorten/.test(x.p.p.titel)));
  toets('do 31-12 (geen briefingdag-inhaal na de maand-klaar) en 1-1 → januari nog niet', (await ronde('2026-12-31', 18)).reden === 'nog niet');

  // podklok wijkt af; poort; onleesbaar geheugen
  u = await ronde('2027-01-24', 18, { n8nMs: ms('2027-01-24', 18) + 2 * 3600 * 1000 });
  toets('januari: podklok 2 uur naast n8n → fout, geen rij', /podklok/.test(u.fout || '') && zend.filter((x) => x.body.data.datum === '2027-01-25').length === 0, u);
  kind = uitkomst([sig], { nieuwste_post: '2027-01-15' });
  u = await ronde('2027-01-25', 18);
  toets('poort: vaste-lastenrekening niet recent gelezen → fout', /niet recent gelezen/.test(u.fout || ''), u);
  kind = uitkomst([sig], { fouten: ['buffer'] });
  u = await ronde('2027-01-26', 18);
  toets('een onderdeel faalde → fout, geen half blok', /onderdelen faalden/.test(u.fout || '') && zend.filter((x) => /^2027-01/.test(x.body.data.datum)).length === 0, u);
  fs.writeFileSync(STAAT, '{kapot', { mode: 0o600 });
  kind = uitkomst([sig]);
  u = await ronde('2027-01-27', 18);
  toets('onleesbaar geheugen → fout, geen rij (nooit als leeg behandelen)', /onleesbaar/.test(u.fout || '') && zend.filter((x) => /^2027-01/.test(x.body.data.datum)).length === 0, u);
  toets('geen bedragen in api-log', !logs.some((x) => /€|\d+,\d\d/.test(x)), logs.filter((x) => /€|\d+,\d\d/.test(x)));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
