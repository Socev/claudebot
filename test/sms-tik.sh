#!/usr/bin/env bash
# wv3664: toetst sms-tik.js en het sms-blok van server.js (voorstel, ✅/❌, pas, claim) in een vm met nagebootste pod-hulpen.
# Raakt de pod, n8n en sms-gate niet. Gebruik: bash test/sms-tik.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 300) + ']' : '')); }
const S = require(path.resolve('sms-tik.js'));

// ── 1. module ──
toets('1 06-nummer -> +316', S.nummer('06-12 34 56 78') === '+31612345678');
toets('1 0031 -> +31', S.nummer('0031612345678') === '+31612345678');
toets('1 vast NL-nummer', S.nummer('033 123 45 67') === '+31331234567');
toets('1 buitenland blijft', S.nummer('+220 123 4567') === '+2201234567');
toets('1 onzin -> null', S.nummer('12345') === null && S.nummer('+31abc') === null && S.nummer(612345678) === null && S.nummer('06123') === null);
toets('1 valideer goed', JSON.stringify(S.valideer({ naar: '0612345678', tekst: 'Hoi\r\nTot zo  ', naam: 'Jan *vet*' })) === JSON.stringify({ naar: '+31612345678', tekst: 'Hoi\nTot zo', naam: 'Jan vet' }), S.valideer({ naar: '0612345678', tekst: 'Hoi\r\nTot zo  ', naam: 'Jan *vet*' }));
toets('1 valideer weigert leeg/lang/stuurteken/codeblok/OPEN', [
  { naar: '0612345678', tekst: '   ' }, { naar: '0612345678', tekst: 'x'.repeat(919) }, { naar: '0612345678', tekst: 'a\u0007b' },
  { naar: '0612345678', tekst: 'a‮b' }, { naar: '0612345678', tekst: 'a ``` b' }, { naar: '0612345678', tekst: 'x\n[OPEN scherm=bandjes]' },
  { naar: 'abc', tekst: 'x' }, { naar: '0612345678' }, { naar: '0612345678', tekst: 'x', naam: 5 }].every((d) => typeof S.valideer(d) === 'string'));
const bt = S.berichtTekst({ naar: '+31612345678', tekst: 'Regel 1\nRegel 2', naam: 'Jan' });
toets('1 berichttekst: nummer leesbaar, tekst letterlijk in codeblok', bt.includes('+31 6 12345678') && bt.includes('```\nRegel 1\nRegel 2\n```') && bt.includes('volgens Socev: Jan'), bt);
let klok = 1000;
const P = S.passen({ nu: () => klok, toeval: () => crypto.randomBytes(16).toString('hex') });
const v = { naar: '+31612345678', tekst: 'Hoi' };
let p1 = P.maak(v);
toets('1 pas goed', P.toets({ pas: p1, naar: v.naar, tekst: v.tekst }).j.ok === true);
toets('1 pas eenmalig', P.toets({ pas: p1, naar: v.naar, tekst: v.tekst }).j.ok === false);
p1 = P.maak(v);
toets('1 pas met andere tekst = nee en daarna op', P.toets({ pas: p1, naar: v.naar, tekst: 'Hoi!' }).j.ok === false && P.toets({ pas: p1, naar: v.naar, tekst: v.tekst }).j.ok === false);
p1 = P.maak(v); klok += 60001;
toets('1 pas verlopen na 60 s', P.toets({ pas: p1, naar: v.naar, tekst: v.tekst }).j.ok === false);
toets('1 pas zonder/onzin = nee', P.toets({}).j.ok === false && P.toets({ pas: 'x', naar: v.naar, tekst: v.tekst }).j.ok === false && P.toets(null).j.ok === false);
toets('1 uitkomst ok', S.uitkomst(null, 200, { status: 'ok', id: 'a' }, '+31612345678').pagina === 'uitgevoerd');
toets('1 uitkomst 403/502/time-out/vreemd = mislukt', ['mislukt', 'mislukt', 'mislukt', 'mislukt'].join() === [S.uitkomst(null, 403, { error: 'x' }), S.uitkomst(null, 502, { status: 'fout', fout: 'y' }),
  S.uitkomst(new Error('timeout'), undefined, null), S.uitkomst(null, 200, { status: 'iets' })].map((u) => u.pagina).join());
toets('1 sms-delen GSM-7/UCS-2', [S.delen('a'.repeat(160)), S.delen('a'.repeat(161)), S.delen('€'.repeat(80)), S.delen('中'.repeat(70)), S.delen('中'.repeat(71)), S.delen('Café')].join() === '1,2,1,1,2,1');
toets('1 valideer: 402 Chinese tekens mag (6 delen), 403 niet', typeof S.valideer({ naar: '0612345678', tekst: '中'.repeat(402) }) === 'object' && typeof S.valideer({ naar: '0612345678', tekst: '中'.repeat(403) }) === 'string');
toets('1 502 = onbekend, niet "niet verstuurd"', /onbekend/i.test(S.uitkomst(null, 502, { status: 'fout', fout: 'x' }).tekst) && !/Niet verstuurd/.test(S.uitkomst(null, 502, {}).tekst));
toets('1 time-out zegt onbekend, niet "niet verstuurd"', /onbekend/i.test(S.uitkomst(new Error('t')).tekst) && !/Niet verstuurd/.test(S.uitkomst(new Error('t')).tekst));

// ── 2. server-blok ──
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── wv3664 (besluitenpagina nr 3, C06)'), b = src.indexOf('// ── einde wv3664 ──');
toets('2 blok gevonden', a > 0 && b > a);
const blok = src.slice(a, b);
const ctx = { require, path, crypto, __dirname: process.cwd(), process, console, Buffer, AbortSignal, URL, Promise, Date, JSON, Map, Error, String, Number, Object, Array, RegExp, Math };
ctx.logs = []; ctx.fetches = []; ctx.knoppen = {}; ctx.bewaarOk = true;
ctx.logError = (w, e) => ctx.logs.push(w + ' ' + (e && e.message));
ctx.schrijfLog = (r) => ctx.logs.push(r);
ctx.velden = (o) => JSON.stringify(o);
ctx.nu = () => 'T';
ctx.PORT = 9999; ctx.SECRET = 'podgeheim';
ctx.appAgendaKnoppen = () => ctx.knoppen;
ctx.appAgendaKnop = (id, k) => (ctx.knoppen[id] && ctx.knoppen[id].knoppen[k]) || null;
ctx.appAgendaKnoppenBewaar = () => { ctx.bewaard = JSON.parse(JSON.stringify(ctx.knoppen)); return ctx.bewaarOk; };
ctx.appAgendaVorm = (e) => ({ knoppen: [{ knop: 'uitvoeren', uitkomst: e.knoppen.uitvoeren.uitkomst }] });
ctx.appWebhookUrl = async (wf, naam) => (wf === '9aiWD9tXz448nS7E' && naam === 'SMS Verzenden' ? 'https://n8n.test/webhook/sms-verzenden-x' : 'fout');
ctx.appStuur = (res, st, j) => { res.st = st; res.j = j; };
ctx.appWeiger = (res, st, f) => { res.st = st; res.j = { ok: false, fout: f }; };
ctx.berichtStuur = (res, st, j) => { res.st = st; res.j = j; };
ctx.antwoord = null;   // wat de nagebootste fetch teruggeeft
ctx.fetch = async (url, o) => {
  const body = JSON.parse(o.body); ctx.fetches.push({ url, body });
  if (url.endsWith('/bericht')) { ctx.wachtTijdensBericht = ctx.smsWacht.has(body.agenda.nonce); return { ok: true, status: 200, json: async () => ({ ok: true, id: 'abcdef0123456789' }) }; }
  const r = ctx.antwoord(body);
  if (r instanceof Error) throw r;
  return { ok: r.status === 200, status: r.status, json: async () => r.j, text: async () => '' };
};
vm.createContext(ctx);
vm.runInContext(blok + '\nthis.smsWacht = smsWacht; this.smsVoorstel = smsVoorstel; this.smsPasRoute = smsPasRoute; this.appSmsKnop = appSmsKnop; this.smsWachtNeem = smsWachtNeem;', ctx);
const res = () => ({ _app: {} });
(async () => {
  // voorstel
  let r = await ctx.smsVoorstel({ naar: '06 1234 5678', tekst: 'Ben er om 5 uur', naam: 'X' });
  const f0 = ctx.fetches[0];
  toets('2 voorstel 200 met bericht-id', r.status === 200 && r.j.ok && r.j.bericht === 'abcdef0123456789', r);
  toets('2 voorstel via eigen /bericht: hoofd, bron sms, ✅-knop, pod-geheim', f0 && f0.url === 'http://127.0.0.1:9999/bericht' && f0.body.kanaal === 'hoofd' && f0.body.bron === 'sms' && f0.body.secret === 'podgeheim'
    && f0.body.agenda.soort === 'uitvoeren' && /^[0-9a-f]{32}$/.test(f0.body.agenda.nonce) && f0.body.agenda.verloopt > Date.now() + 11 * 3600e3 && f0.body.tekst.includes('Ben er om 5 uur'), f0 && f0.body);
  toets('2 nummer en tekst niet in de /bericht-body buiten de berichttekst', !('naar' in f0.body) && !('sms' in f0.body));
  toets('2 smsWacht kent de nonce tijdens /bericht en is daarna leeg', ctx.wachtTijdensBericht === true && ctx.smsWacht.size === 0);
  toets('2 log zonder nummer of tekst', !ctx.logs.join('\n').includes('612345678') && !ctx.logs.join('\n').includes('5 uur'), ctx.logs);
  r = await ctx.smsVoorstel({ naar: 'nee', tekst: 'x' });
  toets('2 voorstel ongeldig nummer = 400 zonder fetch', r.status === 400 && ctx.fetches.length === 1);

  // knop: ❌
  const maakKnop = (id) => { ctx.knoppen[id] = { kanaal: 'hoofd', t: new Date().toISOString(), sms: { naar: '+31612345678', tekst: 'Ben er om 5 uur', naam: '' },
    knoppen: { uitvoeren: { nonce: 'n'.repeat(32), verloopt: Date.now() + 3600e3, stand: 'bezig', sinds: Date.now(), pagina: null, uitkomst: null } } }; };
  let teruggezet = 0; const terug = () => { teruggezet++; };
  maakKnop('k1'); let x = res(); const nF = ctx.fetches.length;
  await ctx.appSmsKnop(x, 'k1', 'uitvoeren', 'nee', terug);
  toets('2 ❌ = afgewezen, niets naar n8n', x.st === 200 && x.j.pagina === 'afgewezen' && ctx.fetches.length === nF && ctx.knoppen.k1.knoppen.uitvoeren.stand === 'klaar', x);

  // knop: ✅ goed → pas klopt precies één keer
  maakKnop('k2'); x = res();
  ctx.antwoord = (body) => { ctx.pasUit = ctx.smsPasRoute({}, ...[]) ; return { status: 200, j: { status: 'ok', id: 'm1', state: 'Pending' } }; };
  let pasRes = null;
  ctx.antwoord = (body) => { const rr = {}; ctx.smsPasRoute(rr, { pas: body.pas, naar: body.naar, tekst: body.tekst }); pasRes = rr; const rr2 = {}; ctx.smsPasRoute(rr2, { pas: body.pas, naar: body.naar, tekst: body.tekst }); ctx.pasTweede = rr2; return { status: 200, j: { status: 'ok', id: 'm1', state: 'Pending' } }; };
  await ctx.appSmsKnop(x, 'k2', 'uitvoeren', 'ja', terug);
  const fz = ctx.fetches[ctx.fetches.length - 1];
  toets('2 ✅ roept de verzendtak met pas + exact nummer en tekst', fz.url === 'https://n8n.test/webhook/sms-verzenden-x' && /^[0-9a-f]{32}$/.test(fz.body.pas) && fz.body.naar === '+31612345678' && fz.body.tekst === 'Ben er om 5 uur' && !('secret' in fz.body), fz.body);
  toets('2 n8n-terugtoets: pas ja, tweede keer nee', pasRes && pasRes.j.ok === true && ctx.pasTweede.j.ok === false, [pasRes, ctx.pasTweede]);
  toets('2 ✅ = uitgevoerd, claim op schijf', x.st === 200 && x.j.pagina === 'uitgevoerd' && !!ctx.bewaard.k2.sms.geclaimd && ctx.knoppen.k2.knoppen.uitvoeren.stand === 'klaar', x);
  toets('2 pas met andere tekst = nee', (() => { const p = ctx.smsPassen ? null : null; const rr = {}; ctx.smsPasRoute(rr, { pas: 'a'.repeat(32), naar: '+31612345678', tekst: 'x' }); return rr.j.ok === false; })());

  // geclaimd (herstart midden in de aanroep): nooit een tweede verzending
  maakKnop('k3'); ctx.knoppen.k3.sms.geclaimd = '2026-11-21T12:00:00Z'; x = res(); const nF3 = ctx.fetches.length;
  await ctx.appSmsKnop(x, 'k3', 'uitvoeren', 'ja', terug);
  toets('2 al geclaimd = 409, niets naar n8n', x.st === 409 && x.j.al_afgehandeld === true && ctx.fetches.length === nF3, x);

  // time-out: onbekend, knop dicht (geen tweede druk mogelijk)
  maakKnop('k4'); x = res(); ctx.antwoord = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await ctx.appSmsKnop(x, 'k4', 'uitvoeren', 'ja', terug);
  toets('2 time-out = mislukt/onbekend, knop klaar, claim staat', x.j.pagina === 'mislukt' && /onbekend/i.test(x.j.melding) && ctx.knoppen.k4.knoppen.uitvoeren.stand === 'klaar' && !!ctx.knoppen.k4.sms.geclaimd, x);

  // 403 van n8n
  maakKnop('k5'); x = res(); ctx.antwoord = () => ({ status: 403, j: { error: 'geen geldige pas' } });
  await ctx.appSmsKnop(x, 'k5', 'uitvoeren', 'ja', terug);
  toets('2 n8n 403 = mislukt "nam de pas niet aan"', x.j.pagina === 'mislukt' && /pas niet aan/.test(x.j.melding), x);

  // 404 eerst (pad gewijzigd) → één keer opnieuw met een nieuwe url-opzoeking
  maakKnop('k6'); x = res(); let n6 = 0; ctx.antwoord = () => (++n6 === 1 ? { status: 404, j: null } : { status: 200, j: { status: 'ok' } });
  await ctx.appSmsKnop(x, 'k6', 'uitvoeren', 'ja', terug);
  toets('2 404 dan 200 = uitgevoerd na één herhaling', n6 === 2 && x.j.pagina === 'uitgevoerd', [n6, x]);

  // opslaan van de claim mislukt → niets naar n8n, stand terug
  maakKnop('k7'); x = res(); ctx.bewaarOk = false; const nF7 = ctx.fetches.length; const t0 = teruggezet;
  await ctx.appSmsKnop(x, 'k7', 'uitvoeren', 'ja', terug);
  toets('2 claim niet op te slaan = 500, niets verstuurd, teruggezet', x.st === 500 && ctx.fetches.length === nF7 && teruggezet === t0 + 1 && !ctx.knoppen.k7.sms.geclaimd, x);
  ctx.bewaarOk = true;

  // onbekende knop / ongedaan
  x = res(); await ctx.appSmsKnop(x, 'bestaatniet', 'uitvoeren', 'ja', terug);
  toets('2 onbekende knop = 404', x.st === 404);

  // ── 3. server.js-koppelingen (tekst) ──
  toets('3 bron sms in BERICHT_BRONNEN', /'agenda', 'sms', 'actie-bewaker'/.test(src));
  toets('3 /bericht/sms-pas in BERICHT_RE en route', /naar-telegram\|sms-pas/.test(src) && src.includes("if (p === '/bericht/sms-pas') return smsPasRoute(res, d);"));
  toets('3 appAgendaRoute: sms-knop gaat nooit naar Agenda-knoppen', /if \(e\.sms\) \{[^}]*appSmsKnop[^]*?terug\(\); return appWeiger\(res, 503/.test(src));
  toets('3 berichtNieuw: bron sms alleen met smsWacht', src.includes("smsV = ag && typeof smsWachtNeem === 'function' ? smsWachtNeem(ag.nonce) : null;") && src.includes('if (smsV) agk[id].sms = smsV;'));
  toets('3 smal-grens sms/voorstel', /'sms\/voorstel': 20/.test(src));
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD uitzondering ' + (e && e.stack)); process.exit(1); });
JS
