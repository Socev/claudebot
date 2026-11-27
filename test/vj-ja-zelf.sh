#!/usr/bin/env bash
# Toetst wv4196 (besluitenpagina nr 372 = 3C72): een gewone Ja (zonder vingerafdruk) op een Voor jou-besluitkaart in de machinekamer met
# precies één wachtende klus geeft die klus zelf vrij (mk_voor_jou_ja_vrijgeven), zonder [KNOP]-beurt. Het echte appVjJaZelfKan +
# appVjJaZelf in een vm met verzonnen kaart en vragenregister:
# (A) wanneer wel/niet (gevoelig, gekoppelde chatvraag, kanaal hoofd, geen wv, wegen, grondwet, todoist/module/regels/briefing, doorbouw-stop, schakelaar);
# (B) geslaagd: 200 {vrijgegeven}, antwoord gestart, bewijs in precies de vorm die de kaartlijst en de registerronde lezen;
#     databank weigert: geen antwoord, antwoord terug op open; fout dan gelukt: één herhaling (Codex MOET 1); twee fouten: terug;
#     al beantwoord: niets gedaan;
# (C) bron: alleen bij Ja, vóór de gewone appKnop-route, na de moduleknoppen; databankfunctie bestaat in de migratie niet in deze repo
#     (mk-scripts/wv4196/migratie.sql), dus alleen de naam.
# Raakt niets echts. Gebruik: bash test/vj-ja-zelf.sh   (SRC=<pad> voor een kruisproef op oude bron)
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), vm = require('vm'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const src = fs.readFileSync(process.env.SRC || 'server.js', 'utf8');
const ovr = fs.readFileSync('ovis-register.js', 'utf8');
const b1 = src.indexOf('// ── wv4196 (besluitenpagina nr 372'), b2 = src.indexOf('// ── einde wv4196 ──');
toets('0 blok wv4196 gevonden', b1 > 0 && b2 > b1);
if (!(b1 > 0 && b2 > b1)) { console.log('\n' + goed + ' groen, ' + fouten + ' rood'); process.exit(1); }
(async function () {
  let vragen = {}, rpc = [], gedrag = [], uitBestaat = false, logs = [];
  const c = vm.createContext({ console, Date, JSON, crypto, Promise, process: { env: {} },
    fs: { existsSync: function () { return uitBestaat; } }, appStaat: {},
    logError: function (k, e) { logs.push(k + ': ' + (e && e.message)); }, schrijfLog: function (t) { logs.push(t); }, nu: function () { return 'T'; },
    velden: function (o) { return JSON.stringify(o); }, appEenRegel: function (t, n) { return String(t).replace(/\s+/g, ' ').slice(0, n); },
    appKort: function (t, n) { return String(t).slice(0, n); }, appVjDag: function () { return '27-11'; }, appYmd: function () { return '2026-11-27'; },
    appKlok: function () { return '16:45'; },
    appVragen: function () { return JSON.parse(JSON.stringify(vragen)); }, appVragenSchrijf: function (v) { vragen = JSON.parse(JSON.stringify(v)); },
    appAntwoord: function (r) { return r && r.antwoord ? r.antwoord : null; },
    appStuur: function (res, status, j) { res.status = status; res.j = j; },
    appSbRpc: async function (naam, body) { rpc.push({ naam, body }); const g = gedrag.shift(); if (g instanceof Error) throw g; return g; },
    doorbouwStopSleutel: function (sl) { return /^doorbouw-\d+$/.test(String(sl)); } });
  vm.runInContext(src.slice(b1, b2) + ';globalThis.__r = { appVjJaZelfKan, appVjJaZelf };', c);
  const R = c.__r;
  const kaart = function (h, extra) { return Object.assign({ id: 5, sleutel: 'wv9901', soort: 'besluit', status: 'open', titel: 'Proef — mag de kop korter?', herkomst: Object.assign({ wv: [9901], auto: 'wv' }, h || {}) }, extra || {}); };
  const K = function (x) { return Object.assign({ gevoelig: false, gek: null, waaromNiet: null, beantwoord: null, elders: null, kanaal: 'machinekamer' }, x || {}); };
  // (A)
  toets('A1 gewone kaart, machinekamer, één wv: wel', R.appVjJaZelfKan(kaart(), K()) === true);
  toets('A2 gevoelig (vingerafdruk): niet', R.appVjJaZelfKan(kaart(), K({ gevoelig: true })) === false);
  toets('A3 gekoppelde chatvraag: niet', R.appVjJaZelfKan(kaart(), K({ gek: 'aaaaaaaaaaaaaaaa:12345678' })) === false);
  toets('A4 hoofdkanaal: niet', R.appVjJaZelfKan(kaart(), K({ kanaal: 'hoofd' })) === false);
  toets('A5 geen wv / lege wv: niet', R.appVjJaZelfKan(kaart({ wv: undefined }), K()) === false && R.appVjJaZelfKan(kaart({ wv: [] }), K()) === false);
  toets('A6 wegen of grondwet: niet', R.appVjJaZelfKan(kaart({ wegen: true }), K()) === false && R.appVjJaZelfKan(kaart({ grondwet: true }), K()) === false);
  toets('A7 todoist / module / regels / briefing / ovis / vraag: niet', ['todoist', 'module', 'regels', 'briefing', 'ovis', 'vraag'].every(function (x) { const h = {}; h[x] = x === 'module' ? 'facturen' : x === 'briefing' || x === 'ovis' ? { a: 1 } : ['1']; return R.appVjJaZelfKan(kaart(h), K()) === false; }));
  toets('A8 lege todoist-lijst telt niet als bron: wel', R.appVjJaZelfKan(kaart({ todoist: [] }), K()) === true);
  toets('A9 geen besluit / doorbouw-mededeling / beantwoord / waaromNiet: niet', R.appVjJaZelfKan(kaart({}, { soort: 'doen' }), K()) === false &&
    R.appVjJaZelfKan(kaart({}, { sleutel: 'doorbouw-12' }), K()) === false && R.appVjJaZelfKan(kaart(), K({ beantwoord: { keuze: 'ja' } })) === false && R.appVjJaZelfKan(kaart(), K({ waaromNiet: 'x' })) === false);
  uitBestaat = true;
  toets('A10 schakelaarbestand bestaat: niet', R.appVjJaZelfKan(kaart(), K()) === false);
  uitBestaat = false;
  // (B)
  const SL = 'aaaaaaaaaaaaaaaa:12345678', a = { id: 'pixel' };
  const leeg = function () { vragen = {}; vragen[SL] = { kanaal: 'machinekamer', t: new Date().toISOString(), antwoord: null, gevoelig: false, soort: 'voorjou' }; rpc = []; logs = []; };
  const doe = async function (s) { const res = { _app: {} }; const u = await R.appVjJaZelf(res, a, s || {}, kaart(), K(), 'aaaaaaaaaaaaaaaa', '12345678', 'b'.repeat(64), 'Proef — mag de kop korter?'); return { res, u }; };
  leeg(); gedrag = [{ ok: true, wv: 9901 }];
  let x = await doe();
  const bew = rpc[0] && rpc[0].body.p_bewijs;
  const reKaart = new RegExp(src.match(/const APP_VJ_KNOP_BEWIJS_RE = \/(.*)\/;/)[1]);
  const reReg = /app (\d{1,2}-\d{1,2} \d{1,2}:\d{2}): David drukte (Ja|Nee|Anders) (?:op de kaart|in het gesprek)(?: \(vraag-id ([0-9a-f]{6,16})\))?/;
  toets('B1 geslaagd: 200 {ok, vrijgegeven}, klaar, één aanroep mk_voor_jou_ja_vrijgeven', x.u.klaar === true && x.res.status === 200 && x.res.j.vrijgegeven === true && x.res.j.beantwoord.keuze === 'ja' && rpc.length === 1 && rpc[0].naam === 'mk_voor_jou_ja_vrijgeven', { u: x.u, res: x.res, rpc });
  toets('B2 bewijs = "app 27-11 16:45: David drukte Ja op de kaart (vraag-id 12345678)"; kaartlijst en registerronde lezen het', bew === 'app 27-11 16:45: David drukte Ja op de kaart (vraag-id 12345678)' && reKaart.test(bew) && reReg.exec(bew)[2] === 'Ja', bew);
  toets('B3 opdracht erbij: "David: Ja (27-11 16:45" + geen machinekamerbeurt, ≤ 1500', /^\[Pod, wv4196\] David: Ja \(27-11 16:45, knop op de Voor jou-kaart "Proef — mag de kop korter\?", vraag-id 12345678, zonder vingerafdruk\)/.test(rpc[0].body.p_erbij) && /geen machinekamerbeurt/.test(rpc[0].body.p_erbij) && rpc[0].body.p_erbij.length <= 1500, rpc[0].body.p_erbij);
  toets('B4 vragenregister: antwoord ja, gestart, zelf, kaart_hash', vragen[SL].antwoord && vragen[SL].antwoord.keuze === 'ja' && vragen[SL].antwoord.gestart === true && vragen[SL].antwoord.zelf === true && vragen[SL].antwoord.kaart_hash === 'b'.repeat(64), vragen[SL]);
  toets('B5 reden in de audit: "-> pod gaf wv9901 zelf vrij (geen beurt)"', /pod gaf wv9901 zelf vrij \(geen beurt\)/.test(x.res._app.reden), x.res._app.reden);
  leeg(); gedrag = [{ ok: false, reden: '2 klussen wachten op David' }];
  x = await doe();
  toets('B6 databank weigert: niets gestuurd, waarom mee, antwoord terug op open (gewone route kan)', !x.u.klaar && /2 klussen/.test(x.u.waarom) && x.res.status === undefined && vragen[SL].antwoord === null, { u: x.u, v: vragen[SL] });
  leeg(); gedrag = [new Error('verbinding weg'), { ok: true, al: true, wv: 9901 }];
  x = await doe();
  toets('B7 fout, dan herhaling {al}: één keer opnieuw, geslaagd (Codex MOET 1)', x.u.klaar === true && rpc.length === 2 && rpc[1].body.p_bewijs === rpc[0].body.p_bewijs && /herhaling/.test(x.res._app.reden), { rpc: rpc.length, r: x.res._app.reden });
  leeg(); gedrag = [new Error('weg'), new Error('weg')];
  x = await doe();
  toets('B8 twee fouten: gewone route, antwoord terug op open', !x.u.klaar && x.u.waarom === 'databank' && rpc.length === 2 && vragen[SL].antwoord === null, { u: x.u, v: vragen[SL] });
  leeg(); vragen[SL].antwoord = { keuze: 'nee', t: new Date().toISOString(), job: 'cccccccccccccccc', gestart: true }; gedrag = [{ ok: true }];
  x = await doe();
  toets('B9 al beantwoord: niets aangeroepen, gewone route (die geeft de 409)', !x.u.klaar && rpc.length === 0 && vragen[SL].antwoord.keuze === 'nee', { u: x.u, rpc });
  leeg(); gedrag = [{ ok: true, wv: 9901 }];
  x = await doe({ onderweg: 'tel1' });
  toets('B10 via Onderweg: antwoord via onderweg, ", in Onderweg" in de opdracht', x.u.klaar === true && x.res.j.beantwoord.via === 'onderweg' && /, in Onderweg\)/.test(rpc[0].body.p_erbij));
  // (C) bron
  const f1 = src.indexOf('async function appVoorJouKnop('), f2 = src.indexOf('\n}\n', f1);
  const body = src.slice(f1, f2);
  const iZelf = body.indexOf('appVjJaZelfKan(p, k)'), iGewoon = body.indexOf('const knopRes = appKnop('), iDb = body.indexOf('if (dbRij || stopRij)');
  toets('C1 in appVoorJouKnop: na de doorbouw-tak, vóór de gewone appKnop', iZelf > iDb && iDb > 0 && iZelf < iGewoon);
  toets('C2 alleen bij keuze ja en zonder pot/bs/aw/ib/ov', /if \(keuze === 'ja' && !pot && !bs && !aw && !ib && !ov && appVjJaZelfKan\(p, k\)\)/.test(body));
  toets('C3 ovis-register leest het kaartbewijs voor de registerrij (beantwoord: JA)', /David drukte \(Ja\|Nee\|Anders\) \(\?:op de kaart\|in het gesprek\)/.test(ovr));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('CRASH ' + (e && e.stack)); process.exit(1); });
JS
