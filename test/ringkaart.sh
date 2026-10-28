#!/usr/bin/env bash
# Toetst ringkaart.js (wv888, ringkaart van Socev; bouwplan "01_Ontwikkeling/Ringkaart van Socev - tandwielweergave (bouwplan
# 23-10-2026).md") en de koppeling in server.js. Toetst: frontmatter (gewoon, gevouwen >-, quotes, zonder description), eerste zin,
# vervallen skill, kanalen uit de tabel "## Kanaal" (ontdubbeld, tot " — " of " ("), wachternamen (AI - weg, id-haakjes weg,
# workflowgroep weg, dubbel → component erbij, proefrij weg, onbekend oordeel → onbeoordeelbaar), vaste plek zonder beschrijving,
# fout per bron los, buffers; in server.js: dispatch, 404 zonder module, teller, stil bij 200, /health, RELEASE_OPTIONEEL.
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/ringkaart.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const R = require('./ringkaart.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

// 1 frontmatter
toets('1a gewone description', R.leesKop('---\nname: a\ndescription: Doet iets. En meer.\n---\nx').description === 'Doet iets. En meer.');
toets('1b gevouwen >-', R.leesKop('---\nname: b\ndescription: >-\n  Regel een\n  regel twee.\nmetadata: x\n---\n').description === 'Regel een regel twee.');
toets('1c dubbele quotes', R.leesKop('---\ndescription: "Zegt \\"hoi\\". Klaar."\n---\n').description === 'Zegt "hoi". Klaar.');
toets('1d enkele quotes', R.leesKop("---\ndescription: 'Het is ''mooi''.'\n---\n").description === "Het is 'mooi'.");
toets('1e zonder frontmatter = leeg', Object.keys(R.leesKop('# kop\n')).length === 0);
toets('1f eerste zin', R.eersteZin('Eén zin. Twee zin.') === 'Eén zin.');
toets('1g lange zin afgekapt op een woord', R.eersteZin('woord '.repeat(60)).length <= 162 && / …$/.test(R.eersteZin('woord '.repeat(60))));

// 2 skills uit een map
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-'));
const sk = (n, t) => { fs.mkdirSync(path.join(V, '.claude', 'skills', n), { recursive: true }); fs.writeFileSync(path.join(V, '.claude', 'skills', n, 'SKILL.md'), t); };
sk('bank-lezen', '---\nname: bank-lezen\ndescription: Leest saldo van Davids rekeningen. Nooit betalen.\n---\n');
sk('oud', '---\nname: oud\ndescription: VERVALLEN sinds 22-10 — niet meer gebruiken.\n---\n');
sk('kaal', '---\nname: kaal\n---\n');
fs.mkdirSync(path.join(V, '.claude', 'skills', 'leeg'), { recursive: true });   // map zonder SKILL.md: overslaan
fs.mkdirSync(path.join(V, '00_Systeem'), { recursive: true });
fs.writeFileSync(path.join(V, '00_Systeem', 'Capaciteiten.md'), [
  '# Cap', '## Kanaal (3)', '', '| Sleutel | Capaciteit | Soort |', '|---|---|---|',
  '| `a` | Mail (Gmail privé en Outlook) | kanaal |', '| `b` | Telegram — meelezen | kanaal |', '| `c` | Telegram — praten | kanaal |', '| `d` | **Signal** — meelezen | kanaal |',
  '', '## Skill (1)', '| `s` | NietDit | skill |'].join('\n'));
const m = R.maak({ vault: V });
const s = m.skills();
toets('2a drie skills (map zonder SKILL.md overgeslagen), op naam', JSON.stringify(s.map((x) => x.n)) === '["bank-lezen","kaal","oud"]', s);
toets('2b eerste zin', s[0].zin === 'Leest saldo van Davids rekeningen.', s[0]);
toets('2c vervallen = uit', s[2].uit === true && s[0].uit === false);
toets('2d zonder description: zin null', s[1].zin === null);
toets('2e kanalen ontdubbeld en zonder opmaak, alleen sectie Kanaal', JSON.stringify(m.kanalen()) === '["Mail","Telegram","Signal"]', m.kanalen());

// 3 wachters
const rij = (c, om, o, extra) => Object.assign({ component: c, omschrijving: om, oordeel: o, minuten_sinds: 5, drempel_min: 60, laatste_ronde: '2026-10-23T08:00:00Z' }, extra || {});
const w = R.wachters([
  rij('bank-ronde', 'AI - Bank-ronde (J3JXCQYONcio5CtV), 07:00 en 18:00: pod /bank-ronde', 'vers'),
  rij('bank-ronde-proef', 'PROEF wv685', 'te_laat'),
  rij('voorwerk', 'AI - Voorwerk (vergaderbriefings), dagelijks 18:00', 'vers'),
  rij('voorwerk_x', 'AI - Voorwerk (vergaderbriefings), anders', 'vers'),
  rij('locatie', 'Locatie van Davids telefoon via Tasker (AI - Locatie (Tasker)), elke ~10 min', 'te_laat'),
  rij('raar', '', 'iets', { minuten_sinds: null, laatste_ronde: null }),
], false);
const naam = (c) => (w.find((x) => x.c === c) || {}).naam;
toets('3a proefrij weg', !w.some((x) => /proef/.test(x.c)));
toets('3b AI - en id-haakjes weg', naam('bank-ronde') === 'Bank-ronde', naam('bank-ronde'));
toets('3c workflowgroep tussen haakjes weg', naam('locatie') === 'Locatie van Davids telefoon via Tasker', naam('locatie'));
toets('3d dubbele naam krijgt de component', naam('voorwerk') === 'Voorwerk (vergaderbriefings) · voorwerk' && naam('voorwerk_x') === 'Voorwerk (vergaderbriefings) · voorwerk_x', [naam('voorwerk'), naam('voorwerk_x')]);
toets('3e lege omschrijving = component, onbekend oordeel = onbeoordeelbaar, null blijft null', naam('raar') === 'raar' && w.find((x) => x.c === 'raar').oordeel === 'onbeoordeelbaar' && w.find((x) => x.c === 'raar').min === null);
toets('3f geen omschrijving of regel in de uitvoer', !w.some((x) => 'omschrijving' in x || 'regel' in x));
const wv = R.wachters([rij('locatie', 'Locatie van Davids telefoon via Tasker', 'vers')], true);
toets('3g vaste plek: naam = component', wv[0].naam === 'locatie');
toets('3h te lang: haakjesgroep weg vóór afkappen', R.wachterNaam('Teams meelezen op de praktijk-pc (Taakplanner elke 15 min): berichten', 'teams') === 'Teams meelezen op de praktijk-pc', R.wachterNaam('Teams meelezen op de praktijk-pc (Taakplanner elke 15 min): berichten', 'teams'));

// 4 stand
const st = m.stand([rij('bank-ronde', 'AI - Bank-ronde', 'vers')], false);
toets('4a stand: wachters, skills met zin, kanalen, geen fout', st.ok && st.wachters.length === 1 && st.skills[0].zin && st.kanalen.length === 3 && st.fout === null && st.vaste_plek === false, st);
const sv = m.stand([rij('bank-ronde', 'AI - Bank-ronde', 'vers')], true);
toets('4b vaste plek: geen skillzin', sv.vaste_plek === true && sv.skills.every((x) => x.zin === null), sv.skills);
const sf = m.stand(null, false);
toets('4c hartslag niet leesbaar: alleen die fout, skills en kanalen er wel', sf.fout && sf.fout.wachters && !sf.fout.skills && sf.wachters.length === 0 && sf.skills.length === 3, sf.fout);
const m2 = R.maak({ vault: path.join(V, 'bestaat-niet') });
const s2 = m2.stand([], false);
toets('4d vault onleesbaar: fout skills en kanalen, geen uitzondering', s2.fout && s2.fout.skills && s2.fout.kanalen && s2.skills.length === 0, s2.fout);
// buffer kanalen op mtime: nieuwe inhoud met nieuwe mtime wordt gelezen
const cap = path.join(V, '00_Systeem', 'Capaciteiten.md');
fs.writeFileSync(cap, '## Kanaal\n| Sleutel | Capaciteit |\n|---|---|\n| `x` | WhatsApp Nederland |\n'); const t = new Date(Date.now() + 5000); fs.utimesSync(cap, t, t);
toets('4e kanalen volgen een gewijzigd register', JSON.stringify(m.kanalen()) === '["WhatsApp Nederland"]', m.kanalen());

// 5 koppeling in server.js
const src = fs.readFileSync('server.js', 'utf8');
toets('5a dispatch GET /app/ringkaart', /route === 'GET \/app\/ringkaart'\) return typeof appRingkaart === 'function'/.test(src));
const b = src.slice(src.indexOf('// ── Ringkaart (wv888'), src.indexOf('// ── einde ringkaart ──'));
toets('5b zonder module 404', /if \(!ringkaart\) return appWeiger\(res, 404/.test(b));
toets('5c teller ringkaart', /appTeller\('ringkaart', 600, 3600000\)/.test(b));
toets('5d stil alleen na geslaagd lezen (vlak voor 200)', /res\._app\.stil = true;\s*return appStuur\(res, 200, uit\)/.test(b));
toets('5e vaste plek via appAfscherm (wv1901)', /const vast = appAfscherm\(a\)/.test(b));
toets('5f RPC mk_hartslag_stand met buffer', /appSbRpc\('mk_hartslag_stand'/.test(b) && /RINGKAART_HARTSLAG_MS/.test(b));
toets('5g /health.ringkaart', /ringkaart: typeof ringkaart !== 'undefined' && !!ringkaart/.test(src));
toets('5h ringkaart.js in RELEASE_OPTIONEEL', /^RELEASE_OPTIONEEL="[^"]*\bringkaart\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
toets('5i GET /app/ringkaart is geen invoerroute (geen slot nodig)', !/GET \/app\/ringkaart/.test(src.slice(src.indexOf('function appInvoerRoute'), src.indexOf('function appInvoerRoute') + 1200)));

fs.rmSync(V, { recursive: true, force: true });
console.log((fouten ? 'ROOD' : 'GROEN') + ' ringkaart: ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
