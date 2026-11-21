#!/usr/bin/env bash
# wv3668: toetst sms-ingang.js (handtekening, tijd, kluis, herhaling, fase) en het sms-ingang-blok van server.js in een vm.
# Verzonnen toetsdata; raakt de pod, de kluis, n8n en sms-gate niet. Gebruik: bash test/sms-ingang.sh [module.js]
set -u
cd "$(dirname "$0")/.." || exit 1
MOD="${1:-sms-ingang.js}" node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto'), os = require('os');
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) + ']' : '')); }
const M = require(path.resolve(process.env.MOD));

const SLEUTEL = 'Proef123';
const lijfTekst = '{"deviceId":"proefapparaat","event":"sms:received","id":"p1","payload":{"messageId":"m1","message":"Proefbericht zonder betekenis","sender":"+31600000000","simNumber":1,"receivedAt":"2026-11-21T12:00:00.000+01:00"},"webhookId":"w1"}';
const lijf = Buffer.from(lijfTekst, 'utf8');
function teken(sl, bytes, ts) { return crypto.createHmac('sha256', sl).update(Buffer.concat([bytes, Buffer.from(ts)])).digest('hex'); }
let klok = Date.parse('2026-11-21T12:00:00Z');
const TS = String(Math.floor(klok / 1000));
let kluis = SLEUTEL, kluisFout = false, kluisAanroepen = 0, fase = 'meten', bewaard = null;
function maak(laad) {
  return M.maak({ kluisLees: async () => { kluisAanroepen++; if (kluisFout) throw new Error('weg'); return kluis; }, nu: () => klok,
    fase: () => fase, laad: () => laad || null, bewaar: (st) => { bewaard = JSON.parse(JSON.stringify(st)); } });
}
function verzoek(o) { return Object.assign({ lijf_b64: lijf.toString('base64'), x_signature: teken(SLEUTEL, lijf, TS), x_timestamp: TS }, o || {}); }

(async function () {
  // ── 1. module ──
  let I = maak();
  let r = await I.toets(verzoek());
  toets('1 goede handtekening over rauwe bytes = echt', r.status === 200 && r.j.echt === true && r.j.echtheid === 'echt' && r.j.bewaar === true, r);
  toets('1 via rauw genoteerd', bewaard && bewaard.laatste[0].via === 'rauw', bewaard);
  r = await I.toets(verzoek());
  toets('1 zelfde handtekening nogmaals = onjuist herhaald', r.j.echt === false && r.j.reden === 'herhaald', r);
  r = await I.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, TS).toUpperCase(), x_timestamp: String(Number(TS) + 1) }));
  toets('1 hoofdletters in hex + andere ts met oude handtekening = onjuist', r.j.echtheid === 'onjuist' && r.j.reden === 'handtekening onjuist', r);
  const ts2 = String(Number(TS) + 2);
  r = await I.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, ts2).toUpperCase(), x_timestamp: ts2 }));
  toets('1 hoofdletters in hex = echt', r.j.echt === true, r);
  // JSON-variant: n8n geeft opgemaakte bytes door, handtekening over compacte JSON
  const opgemaakt = Buffer.from(JSON.stringify(JSON.parse(lijfTekst), null, 2));
  const ts3 = String(Number(TS) + 3);
  r = await I.toets({ lijf_b64: opgemaakt.toString('base64'), x_signature: teken(SLEUTEL, lijf, ts3), x_timestamp: ts3 });
  toets('1 andere bytes, zelfde JSON = echt via json', r.j.echt === true && bewaard.laatste[0].via === 'json', bewaard && bewaard.laatste[0]);
  const ander = Buffer.from(lijfTekst.replace('Proefbericht', 'Nepbericht'));
  const ts4 = String(Number(TS) + 4);
  r = await I.toets({ lijf_b64: ander.toString('base64'), x_signature: teken(SLEUTEL, lijf, ts4), x_timestamp: ts4 });
  toets('1 gewijzigde inhoud met handtekening van het echte lijf (zelfde ts) = onjuist', r.j.echtheid === 'onjuist' && r.j.reden === 'handtekening onjuist', r);
  r = await I.toets({ lijf_b64: lijf.toString('base64'), x_signature: teken(SLEUTEL, lijf, ts4), x_timestamp: ts4 });
  toets('1 en het echte lijf met diezelfde handtekening = echt', r.j.echt === true, r);
  r = await I.toets(verzoek({ x_signature: teken('Andere1', lijf, TS) }));
  toets('1 verkeerde sleutel = onjuist', r.j.echtheid === 'onjuist' && r.j.reden === 'handtekening onjuist', r);
  r = await I.toets(verzoek({ x_signature: '' }));
  toets('1 zonder handtekening = onjuist', r.j.reden === 'geen handtekening' && r.j.bewaar === true, r);
  r = await I.toets(verzoek({ x_signature: 'zz'.repeat(32) }));
  toets('1 handtekening geen hex = onjuist', r.j.reden === 'handtekening vorm', r);
  r = await I.toets(verzoek({ x_timestamp: '' }));
  toets('1 zonder tijd = onjuist', r.j.reden === 'tijd vorm', r);
  r = await I.toets(verzoek({ x_timestamp: '2026-11-21T12:00:00Z' }));
  toets('1 tijd in ISO = onjuist', r.j.reden === 'tijd vorm', r);
  const oud = String(Number(TS) - 301);
  r = await I.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, oud), x_timestamp: oud }));
  toets('1 tijd 301 s oud = onjuist (ook met geldige handtekening)', r.j.reden === 'tijd buiten 5 min', r);
  const toek = String(Number(TS) + 301);
  r = await I.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, toek), x_timestamp: toek }));
  toets('1 tijd 301 s in de toekomst = onjuist', r.j.reden === 'tijd buiten 5 min', r);
  const randje = String(Number(TS) - 299);
  r = await I.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, randje), x_timestamp: randje }));
  toets('1 tijd 299 s oud = echt', r.j.echt === true, r);
  r = await I.toets(verzoek({ lijf_b64: '' }));
  toets('1 leeg lijf = onjuist', r.j.echtheid === 'onjuist', r);
  r = await I.toets(null);
  toets('1 geen object = onjuist, geen crash', r.status === 200 && r.j.echtheid === 'onjuist', r);
  r = await I.toets(verzoek({ lijf_b64: Buffer.alloc(70 * 1024, 97).toString('base64') }));
  toets('1 lijf > 64 kB = onjuist', r.j.reden === 'geen of te groot lijf', r);

  // kluis
  let J = maak(); kluis = '';
  r = await J.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, String(Number(TS) + 10)), x_timestamp: String(Number(TS) + 10) }));
  toets('1 kluis leeg = onbevestigd, bewaren', r.j.echtheid === 'onbevestigd' && r.j.reden === 'kluis leeg' && r.j.bewaar === true, r);
  J = maak(); kluis = SLEUTEL; kluisFout = true;
  r = await J.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, String(Number(TS) + 11)), x_timestamp: String(Number(TS) + 11) }));
  toets('1 kluis onbereikbaar = onbevestigd, bewaren', r.j.echtheid === 'onbevestigd' && r.j.reden === 'kluis onbereikbaar' && r.j.bewaar === true, r);
  kluisFout = false;
  r = await J.toets(verzoek({ x_signature: '', x_timestamp: String(Number(TS) + 12) }));
  toets('1 zonder handtekening blijft onjuist ook zonder kluis-aanroep', r.j.echtheid === 'onjuist', r);

  // sleutelcache + verversen
  const K = maak(); kluisAanroepen = 0;
  for (let i = 20; i < 23; i++) { const t = String(Number(TS) + i); await K.toets(verzoek({ x_signature: teken(SLEUTEL, lijf, t), x_timestamp: t })); }
  toets('1 sleutel gecachet (1 kluisaanroep voor 3 sms)', kluisAanroepen === 1, kluisAanroepen);
  kluis = 'Nieuw456'; klok += 61000; kluisAanroepen = 0;
  const tn = String(Math.floor(klok / 1000));
  r = await K.toets(verzoek({ x_signature: teken('Nieuw456', lijf, tn), x_timestamp: tn }));
  toets('1 nieuwe sleutel in de app werkt na > 60 s meteen (één verversing)', r.j.echt === true && kluisAanroepen === 1, { r, kluisAanroepen });
  kluisAanroepen = 0;
  const tn2 = String(Math.floor(klok / 1000) + 1);
  r = await K.toets(verzoek({ x_signature: teken('Fout789', lijf, tn2), x_timestamp: tn2 }));
  toets('1 foute handtekening < 5 s na verversen: geen kluisstorm', r.j.echtheid === 'onjuist' && kluisAanroepen === 0, kluisAanroepen);
  // MOET 1: sleutelwissel 10 s na de vorige kluisvraag: de echte sms moet toch echt zijn
  kluis = 'Wissel01'; klok += 10000; kluisAanroepen = 0;
  const tw = String(Math.floor(klok / 1000));
  r = await K.toets(verzoek({ x_signature: teken('Wissel01', lijf, tw), x_timestamp: tw }));
  toets('1 sleutelwissel 10 s na vorige kluisvraag: echte sms = echt (Codex MOET 1)', r.j.echt === true && kluisAanroepen === 1, { r, kluisAanroepen });
  // gelijktijdige verzoeken delen één kluisvraag
  const G = maak(); kluisAanroepen = 0;
  const tg = String(Math.floor(klok / 1000));
  await Promise.all([1, 2, 3].map((i) => G.toets(verzoek({ x_signature: teken('Wissel01', lijf, String(Number(tg) + i)), x_timestamp: String(Number(tg) + i) }))));
  toets('1 drie gelijktijdige verzoeken = één kluisvraag', kluisAanroepen === 1, kluisAanroepen);
  kluis = 'Nieuw456';

  // fase
  fase = 'dicht';
  const L = maak(); kluis = 'Nieuw456';
  const td = String(Math.floor(klok / 1000) + 2);
  r = await L.toets(verzoek({ x_signature: teken('Fout789', lijf, td), x_timestamp: td }));
  toets('1 fase dicht: onjuist niet bewaren', r.j.echtheid === 'onjuist' && r.j.bewaar === false && r.j.fase === 'dicht', r);
  r = await L.toets(verzoek({ x_signature: '', x_timestamp: td }));
  toets('1 fase dicht: zonder handtekening niet bewaren', r.j.bewaar === false, r);
  r = await L.toets(verzoek({ x_signature: teken('Nieuw456', lijf, td), x_timestamp: td }));
  toets('1 fase dicht: echt wel bewaren', r.j.echt === true && r.j.bewaar === true, r);
  kluis = '';
  const L2 = maak();
  r = await L2.toets(verzoek({ x_signature: teken('Nieuw456', lijf, td + ''), x_timestamp: td }));
  toets('1 fase dicht: kluis leeg = toch bewaren (onbevestigd)', r.j.echtheid === 'onbevestigd' && r.j.bewaar === true, r);
  fase = 'iets anders';
  r = await L2.toets(verzoek({ x_signature: '', x_timestamp: td }));
  toets('1 onbekende fase = meten (bewaren)', r.j.fase === 'meten' && r.j.bewaar === true, r);
  fase = 'meten'; kluis = SLEUTEL;

  // staat: geen inhoud, telling, laatste ≤ 20, laden
  const st = JSON.stringify(bewaard);
  toets('1 staat zonder inhoud/nummer/handtekening', !/Proefbericht|31600000000|proefapparaat/.test(st) && !st.includes(teken(SLEUTEL, lijf, TS)), st.slice(0, 200));
  toets('1 laatste hooguit 20', bewaard.laatste.length <= 20, bewaard.laatste.length);
  const H = maak({ tellers: { echt: 7 }, laatste: [{ t: 'x', uitslag: 'echt' }] }).health();
  toets('1 health: fase + tellers uit geladen staat', H.fase === 'meten' && H.tellers.echt === 7 && H.laatste.length === 1, H);
  toets('1 health met kapotte staat', maak({ tellers: 5, laatste: 'x' }).health().laatste.length === 0);

  // ── 2. server-blok ──
  const src = fs.readFileSync('server.js', 'utf8');
  const a = src.indexOf('// ── wv3668 (besluitenpagina nr 3, C06 deel 2)'), b = src.indexOf('// ── einde wv3668 ──');
  toets('2 blok gevonden', a > 0 && b > a);
  toets('2 route in BERICHT_RE en naUit en dispatch', /sms-pas\|sms-ingang\)\)\?\$\//.test(src) && src.includes("p === '/bericht/sms-ingang';") && src.includes("if (p === '/bericht/sms-ingang') return smsIngangRoute(res, d);"));
  toets('2 health-veld', src.includes('sms_ingang: smsIngang ? smsIngang.health() : null'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-ingang-'));
  const blok = src.slice(a, b);
  const ctx = { require, path, fs, process: { env: { SMS_INGANG_DIR: dir } }, console, Buffer, Promise, Date, JSON, Map, Error, String, Number, Object };
  ctx.__dirname = process.cwd();
  ctx.logs = [];
  ctx.logError = (w, e) => ctx.logs.push(w + ' ' + (e && e.message));
  ctx.kluisNaam = null;
  ctx.promedicoKluisLees = async (n) => { ctx.kluisNaam = n; return SLEUTEL; };
  ctx.berichtStuur = (res, s, o) => { res.s = s; res.o = o; };
  vm.createContext(ctx);
  vm.runInContext(blok + '\nthis.smsIngangRoute = smsIngangRoute; this.smsIngang = smsIngang;', ctx);
  toets('2 module geladen', !!ctx.smsIngang);
  const t0 = String(Math.floor(Date.now() / 1000));
  let res = {};
  await ctx.smsIngangRoute(res, { secret: 'x', lijf_b64: lijf.toString('base64'), x_signature: teken(SLEUTEL, lijf, t0), x_timestamp: t0 });
  toets('2 route: echt + kluisrij sms_gateway_signing_key', res.s === 200 && res.o.echt === true && ctx.kluisNaam === 'sms_gateway_signing_key', { res, n: ctx.kluisNaam });
  toets('2 route: log zonder inhoud', res._log && res._log.sms_ingang === 'echt', res._log);
  toets('2 staat 0600 op schijf', (fs.statSync(path.join(dir, 'staat.json')).mode & 0o777) === 0o600);
  res = {};
  await ctx.smsIngangRoute(res, { lijf_b64: lijf.toString('base64'), x_signature: teken('Fout789', lijf, t0), x_timestamp: t0 });
  toets('2 route: onjuist, fase meten bewaart', res.o.echtheid === 'onjuist' && res.o.bewaar === true && res._log.sms_ingang === 'onjuist handtekening onjuist', res);
  fs.writeFileSync(path.join(dir, 'fase'), 'dicht\n');
  res = {};
  await ctx.smsIngangRoute(res, { lijf_b64: lijf.toString('base64'), x_signature: teken('Fout789', lijf, t0), x_timestamp: t0 });
  toets('2 route: fasebestand dicht → niet bewaren', res.o.bewaar === false && res.o.fase === 'dicht', res.o);
  const st2 = fs.readFileSync(path.join(dir, 'staat.json'), 'utf8');
  toets('2 staat op schijf zonder inhoud', !/Proefbericht|31600000000/.test(st2));
  // zonder module (vm zonder require): 503
  const ctx2 = Object.assign({}, ctx, { require: undefined }); vm.createContext(ctx2);
  vm.runInContext(blok + '\nthis.smsIngangRoute = smsIngangRoute;', ctx2);
  res = {}; ctx2.smsIngangRoute(res, {});
  toets('2 zonder module: 503 (n8n bewaart dan als onbevestigd)', res.s === 503, res);
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  crash ' + (e && e.stack)); process.exit(1); });
JS
