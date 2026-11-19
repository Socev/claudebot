#!/usr/bin/env bash
# Toetst geheimen.js (wv3405, actieplan Fable-reviews 19-11-2026 A32 deel 1): één gedeelde patroonlijst in twee standen.
# - de gaten uit register-zoek § 1, imagine § O1 en vault-rag § P1/P2 als vaste gevallen (verzonnen waarden, tijdens de toets opgebouwd zodat
#   er geen sleutelvormige tekst in de repo staat): elk geval wordt in de strenge stand tegengehouden, ook via openai-hulp (weigeren en
#   maskeren) en secondbrain.masker(…, true) (Zoek snel en Docs › Delen);
# - valse-treffergevallen (verwijzing, plaatshouder, proza, UUID, wikilink) blijven staan;
# - de weergave (zonder streng) is ongewijzigd voor de gevallen die het oude masker al had, en laat de nieuwe strenge gevallen staan;
# - maskeren is idempotent (na maskeren geen treffer meer, ook met de openai-markering), en UTF-16 wordt gedecodeerd of als treffer gemeld.
# Kruisproef: GEHEIMEN_SRC=<map met oude openai-hulp.js/secondbrain.js + deze geheimen.js> laat de koppelgevallen rood zien.
# Gebruik: bash test/geheimen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
SRC="${GEHEIMEN_SRC:-$PWD}" node --no-warnings - <<'JS'
const path = require('path');
const SRC = process.env.SRC;
const G = require(path.join(SRC, 'geheimen.js'));
const H = require(path.join(SRC, 'openai-hulp.js'))._intern;
const S = require(path.join(SRC, 'secondbrain.js'));
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 300) + ']' : '')); }
// verzonnen, deterministische tekenreeksen
function rnd(n, abc) { abc = abc || 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; let s = ''; for (let i = 0; i < n; i++) s += abc[(i * 7919 + 13 * i * i + 5) % abc.length]; return s; }
const HEX = '0123456789abcdef';
const ww = ['wacht', 'woord'].join(''), pwE = ['pass', 'word'].join('');

const GATEN = [
  ['kort wachtwoord na dubbele punt (register-zoek)', ww + ': Welkom2026!', 'Welkom2026'],
  ['password = met teken, 15 tekens (register-zoek)', pwE + ' = Zomer-Tolg@2026', 'Zomer-Tolg'],
  ['tabelcel | Wachtwoord | … | (register-zoek, imagine)', '| Wachtwoord | Xk9#mP2$abc |', 'Xk9#mP2'],
  ['token direct na een / (register-zoek)', 'zie https://example.org/hook/' + rnd(32), rnd(32)],
  ['wachtwoord van 5 tekens (imagine)', ww + ': Ab3!x', 'Ab3!x'],
  ['"het wachtwoord is …" (imagine)', 'het ' + ww + ' is Ab3!x9', 'Ab3!x9'],
  ['client_secret= (imagine)', 'client_' + 'secret=' + rnd(24), rnd(24)],
  ['api_key= korter dan 16 (imagine)', 'api_' + 'key=k3Jd9sLq2', 'k3Jd9sLq2'],
  ['hex van 64 tekens (imagine)', 'sleutel ' + rnd(64, HEX), rnd(64, HEX)],
  ['AWS-vorm (imagine, vault-rag)', 'AKI' + 'A' + rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), rnd(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')],
  ['kaal token van 40 tekens (imagine, vault-rag)', 'cf ' + rnd(40), rnd(40)],
  ['URL met inlog (imagine, vault-rag)', 'https://gebruiker:Gehe1m2026@host.example/x', 'Gehe1m2026'],
  ['postgres-URL met inlog (vault-rag)', 'postgres://user:ww12x@db.example:5432/d', 'ww12x'],
  ['JSON-sleutel "password": (vault-rag)', '{"' + pwE + '": "Verzonnen2026!"}', 'Verzonnen2026'],
  ['vet label **Wachtwoord:** (vault-rag)', '**Wachtwoord:** Verzonnen26', 'Verzonnen26'],
  ['pw: (vault-rag)', 'pw: Tolg2026x', 'Tolg2026x'],
  ['ww: (vault-rag)', 'ww: Tolg2026y', 'Tolg2026y'],
  ['pass: (vault-rag)', 'pass: Tolg2026z', 'Tolg2026z'],
  ['sb_secret_ (vault-rag)', 'sb_' + 'secret_' + rnd(30), rnd(30)],
  ['GOCSPX- (vault-rag)', 'GOC' + 'SPX-' + rnd(28), rnd(28)],
  ['Authorization: Basic (vault-rag)', 'Authorization: Basic ' + Buffer.from('jan:Gehe1m99').toString('base64'), Buffer.from('jan:Gehe1m99').toString('base64')],
  ['kaal Bearer (vault-rag)', 'Bear' + 'er ' + rnd(30), rnd(30)],
  ['*_KEY= (vault-rag)', 'MY_SERVICE_' + 'KEY=' + rnd(20), rnd(20)],
  ['PGP-privésleutel', '-----BEGIN PGP PRIVATE ' + 'KEY BLOCK-----\nverzonnen\n-----END PGP PRIVATE KEY BLOCK-----', 'verzonnen'],
  ['wachtwoord van alleen letters vanaf 6 tekens', pwE + ': zomervakantie', 'zomervakantie'],
];
const VALS = [
  ww + ': zie kluis', 'Het ' + ww + ' is verlopen.', ww + ': ${DB_PASSWORD}', pwE + ': process.env.PW', ww + ': <jouw wachtwoord>',
  'Wachtwoord: in Bitwarden', 'pin: 4 cijfers', 'id f47ac10b-58cc-4372-a567-0e02b2c3d479', 'WW-uitkering: 1200 euro', 'token: 5 stuks', 'author: David2',
  '[[00_Systeem/Pagina]]', 'De sleutel: ligt bij Jan', 'Wachtwoord wijzigen: ga naar instellingen', pwE + ' reset link', 'sleutel: kluisrij github_pat_claudebot',
  ww + ': OPENAI_API_KEY', 'het ' + ww + ' is gewijzigd op 3-11', 'Een gewone zin over facturen van oktober.',
];

for (const [naam, t, waarde] of GATEN) {
  const s = G.maskeer(t, { streng: true });
  toets('streng houdt tegen: ' + naam, s.n > 0 && s.tekst.indexOf(waarde) < 0, s);
  toets('openai-hulp weigert: ' + naam, H.geheimIn(t) === true);
  const m = H.maskeer(t);
  toets('openai-hulp maskeert en is daarna schoon: ' + naam, m.n > 0 && m.tekst.indexOf(waarde) < 0 && !H.geheimIn(m.tekst), m);
  const z = S.masker(t, false, null, true);
  toets('secondbrain.masker streng (Zoek snel, Docs): ' + naam, z.indexOf(waarde) < 0, z);
}
for (const t of VALS) {
  const s = G.maskeer(t, { streng: true });
  toets('geen valse treffer: ' + JSON.stringify(t), s.n === 0 && s.tekst === t, s);
}
// weergave: het oude masker vóór wv3405 (alleen ≥ 16 tekens, geen / -token) blijft zoals het was
toets('weergave: kort wachtwoord blijft staan (app toont zoals eerst)', S.masker(ww + ': Welkom2026!') === ww + ': Welkom2026!');
toets('weergave: token na een / blijft staan', S.masker('https://example.org/hook/' + rnd(32)).indexOf(rnd(32)) > 0);
toets('weergave: lange api_key wordt gemaskeerd (zoals eerst)', S.masker('api_key: ' + rnd(22)) === 'api_key: [sleutel weggelaten]');
toets('weergave: kaal token gemaskeerd (zoals eerst)', S.masker('x ' + rnd(40)) === 'x [sleutel weggelaten]');
// idempotent: tweede ronde verandert niets meer
const alles = GATEN.map((g) => g[1]).join('\n');
const een = G.maskeer(alles, { streng: true }).tekst;
toets('idempotent: maskeren van gemaskeerde tekst geeft 0 treffers', G.maskeer(een, { streng: true }).n === 0, G.maskeer(een, { streng: true }));
const eenO = G.maskeer(alles, { streng: true, vervang: '[geheim-gemaskeerd]' }).tekst;
toets('idempotent met openai-markering', G.maskeer(eenO, { streng: true }).n === 0 && G.maskeer(eenO).n === 0);
// Fable-review wv3405 MOET 1: markering midden in een waarde (voorvoegsel vóór de sleutel) → na maskeren met de openai-markering geen treffer meer
for (const t of ['TOKEN_URL=http://127.0.0.1:8080/cb?jwt=eyJ' + rnd(20) + '.eyJ' + rnd(12) + '.' + rnd(10), "const sleutel = 'v2:eyJ" + rnd(20) + '.eyJ' + rnd(12) + "'",
  'webhook_secret: https://n8n2.example/hook?k=sk-' + rnd(30)]) {
  const m = H.maskeer(t);
  toets('idempotent met voorvoegsel vóór de sleutel: ' + t.slice(0, 22), m.n > 0 && !H.geheimIn(m.tekst), m);
}
// ZOU 1: tabel met het wachtwoord als kolomkop (markdown en de poortvorm van Docs › Delen)
const tabel = '| Dienst | Wachtwoord |\n|---|---|\n| Mail | Qw3r!x |\n| Bank | zie kluis |';
toets('kolomkop Wachtwoord: de cel eronder weg, verwijzing blijft', (function () { const m = G.maskeer(tabel, { streng: true }); return m.tekst.indexOf('Qw3r!x') < 0 && m.tekst.indexOf('zie kluis') > 0; })(), G.maskeer(tabel, { streng: true }));
toets('kolomkop Wachtwoord in de poortvorm (cellen met | zonder voorloop)', G.heeft('Mail | Wachtwoord | \nMail | Qw3r!x | \n', { streng: true }));
toets('kolomkop: openai-hulp weigert', H.geheimIn(tabel) === true);
toets('tabel zonder wachtwoordkolom blijft staan', !G.heeft('| Dienst | Kenteken |\n|---|---|\n| Mail | AB-12-CD |', { streng: true }));
// ZOU 2: URL met inlog zonder gebruikersnaam
toets('URL met inlog zonder gebruikersnaam', G.maskeer('redis://:Gehe1m26@host.example:6379', { streng: true }).tekst.indexOf('Gehe1m26') < 0);
// MOET 2: geen kwadratische/kubische tijd op lange invoer (alles ≤ 1,5 s; was 2–8 s)
const factor = Math.max(1, Number(process.env.TOETS_TIJDFACTOR) || 1);
for (const [naam, t] of [['50.000 woordtekens zonder spatie', rnd(50000, 'abcdef0123456789-_.')], ['wachtwoord: + 2.000 spaties + |', ww + ':' + ' '.repeat(2000) + '|'],
  ['wachtwoord: + 2.000 regels + |', ww + ':' + '\n'.repeat(2000) + '|'], ['authorization: + 2.000 spaties + x', 'authorization:' + ' '.repeat(2000) + 'x'],
  ['token 10.000 keer aaneen', 'token'.repeat(10000) + '=x'], ['400.000 tekens gewone tekst', 'Een gewone zin over facturen. '.repeat(13000)],
  ['20.000 tabelregels', '| Dienst | Wachtwoord |\n' + '| a | b |\n'.repeat(20000)]]) {
  const t0 = Date.now(); G.maskeer(t, { streng: true }); G.maskeer(t); const ms = Date.now() - t0;
  toets('snel genoeg: ' + naam + ' (' + ms + ' ms)', ms < 1500 * factor, ms);
}
// UTF-16
const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ww + ' = Welkom2026!', 'utf16le')]);
toets('UTF-16 (BOM) wordt gedecodeerd en dan herkend', G.heeft(G.tekstVan(u16), { streng: true }) && G.tekstVan(u16).indexOf(ww) === 0);
const u16kaal = Buffer.from(ww + ' = Welkom2026!', 'utf16le');
toets('UTF-16 zonder BOM wordt gedecodeerd en herkend', G.heeft(G.tekstVan(u16kaal), { streng: true }));
const alsUtf8 = u16kaal.toString('utf8');
toets('UTF-16 als UTF-8 gelezen (NUL-tekens): treffer in de strenge stand, waarde weg', (function () { const m = G.maskeer(alsUtf8, { streng: true }); return m.n > 0 && m.tekst.indexOf('Welkom2026') < 0; })());
toets('openai-hulp weigert UTF-16-tekst met NUL-tekens', H.geheimIn(alsUtf8) === true);
// grote invoer: geen stack-fout (200.000 trefferregels)
const groot = Array.from({ length: 200000 }, (_, i) => 'token=' + rnd(24) + i).join('\n');
let ok = false, n = 0; try { n = G.maskeer(groot, { streng: true }).n; ok = n >= 200000; } catch (e) { ok = false; }
toets('200.000 trefferregels: geen stack-fout, alle geteld', ok, n);
// koppelingen in de bron (zonder die regels valt de route terug op de oude stand)
const fs = require('fs');
const lees = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
// wv3438 (afspraak David 19-11: niet filteren): Zoek snel is Davids eigen zoeken en gebruikt weer het gewone masker (zoals vóór 19-11)
toets('zoek-snel.js gebruikt NIET de strenge stand en laat geen regel met een wachtwoordwoord weg', !/maskerBasis\(t, v, b, true\)/.test(lees('zoek-snel.js')) && !/WACHTWOORDWOORD/.test(lees('zoek-snel.js')));
toets('docs-delen.js poort in de strenge stand, ook op de tabelrijen', /opt\.masker\(proef, false, null, true\)/.test(lees('docs-delen.js')) && /r\.rijen/.test(lees('docs-delen.js')));
toets('uitrol.sh en Dockerfile nemen geheimen.js mee', /RELEASE_OPTIONEEL="[^"]*\bgeheimen\.js\b/.test(lees('uitrol.sh')) && /COPY geheimen\.js \/app\/release-bootstrap\/geheimen\.js/.test(lees('Dockerfile')));
console.log(goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
