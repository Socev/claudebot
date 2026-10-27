#!/usr/bin/env bash
# Toetst werkers.js (wv1707, OVIS M4a: Ploeg-register; ontwerplijnen § 6) en de koppeling in server.js. Toetst: het register zelf
# (geen dubbele id's of workflows, soort en model altijd ingevuld, managers bestaan in managers.js), rooster uit n8n-triggerknopen
# (alle vormen die n8n nu gebruikt, uitgeschakelde knoop telt niet), kaal(), hartslagoordeel, stand (uit in n8n, geen hartslag, ergste
# oordeel telt, vaste plek zonder sessie/skill/bron, meetfout), check (ontbreekt, niet actief, hartslag zonder werker, proefrij weg),
# Ploeg.md; in server.js: dispatch, 404 zonder module, /health, RELEASE_OPTIONEEL, Dockerfile, CI-stap.
# Toetsdata verzonnen (openbare repo). Raakt niets buiten een wegwerpmap. Gebruik: bash test/werkers.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs');
const W = require('./werkers.js');
const M = require('./managers.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

// 1 het register
const ids = W.WERKERS.map((w) => w.id), wfs = W.WERKERS.filter((w) => w.n8n).map((w) => w.n8n).concat(W.OVERIG.map((w) => w.n8n));
toets('1a geen dubbele werker-id', new Set(ids).size === ids.length);
toets('1b geen workflow dubbel (werker of overig)', new Set(wfs).size === wfs.length, wfs.length);
toets('1c soort altijd een van de vier', W.WERKERS.every((w) => W.SOORTEN.indexOf(w.soort) >= 0));
toets('1d model altijd ingevuld', W.WERKERS.every((w) => typeof w.model === 'string' && w.model.length > 0), W.WERKERS.filter((w) => !w.model).map((w) => w.id));
toets('1e trigger n8n of pod(-tijdklok) of tikker', W.WERKERS.every((w) => ['n8n', 'pod', 'pod-tijdklok', 'tikker'].indexOf(w.trigger) >= 0));
toets('1f werker buiten n8n draagt een roostertekst', W.WERKERS.filter((w) => !w.n8n).every((w) => w.rooster));
const mids = new Set(M.MANAGERS.map((m) => m.id));
toets('1g manager-verwijzing bestaat in managers.js', W.WERKERS.filter((w) => w.manager).every((w) => mids.has(w.manager)));
toets('1h elke manager uit managers.js staat in het register', M.MANAGERS.every((m) => W.WERKERS.some((w) => w.manager === m.id)));
toets('1i overig is kanaal, luik of jimmy', W.OVERIG.every((w) => ['kanaal', 'luik', 'jimmy'].indexOf(w.soort) >= 0));
toets('1j workflow-id 16 tekens', wfs.every((i) => /^[A-Za-z0-9]{16}$/.test(i)));
toets('1k hartslag altijd een lijst', W.WERKERS.every((w) => Array.isArray(w.hartslag)));

// 2 rooster
const iv = (x) => W.intervalTekst(x);
toets('2a dagelijks', iv({ field: 'days', daysInterval: 1, triggerAtHour: 7, triggerAtMinute: 15 }) === 'elke dag 07:15');
toets('2b zonder field = dagen', iv({ triggerAtHour: 7 }) === 'elke dag 07:00');
toets('2c weken', iv({ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 6, triggerAtMinute: 0 }) === 'ma 06:00');
toets('2d minuten', iv({ field: 'minutes', minutesInterval: 30 }) === 'elke 30 min');
toets('2e uren met minuut', iv({ field: 'hours', hoursInterval: 1, triggerAtMinute: 35 }) === 'elk uur op :35');
toets('2f uren zonder minuut', iv({ field: 'hours', hoursInterval: 3 }) === 'elke 3 uur');
toets('2g maand', iv({ field: 'months', triggerAtHour: 5, triggerAtMinute: 30 }) === 'dag 1 van de maand 05:30');
toets('2h cron dag', iv({ field: 'cronExpression', expression: '30 8 * * 6' }) === 'za 08:30');
toets('2i cron werkdagen', iv({ field: 'cronExpression', expression: '5 7 * * 1-5' }) === 'werkdagen 07:05');
toets('2j cron minuten elk uur', iv({ field: 'cronExpression', expression: '5,20,50 * * * *' }) === 'elk uur op :05/:20/:50');
toets('2k cron meerdere uren', iv({ field: 'cronExpression', expression: '30 5,11 * * *' }) === 'elke dag 05:30, 11:30');
toets('2l onbekende cron blijft cron', iv({ field: 'cronExpression', expression: '*/15 * * * *' }) === 'cron */15 * * * *');
const wf = { id: 'Aaaaaaaaaaaaaaa1', active: true, nodes: [
  { type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 3, triggerAtMinute: 40 }] } } },
  { type: 'n8n-nodes-base.scheduleTrigger', disabled: true, parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } } },
  { type: 'n8n-nodes-base.webhook', parameters: { path: 'x' } }, { type: 'n8n-nodes-base.webhook' }, { type: 'n8n-nodes-base.set' }] };
toets('2m rooster: uitgeschakelde knoop telt niet, webhook één keer', W.rooster(wf) === 'elke dag 03:40 · op afroep', W.rooster(wf));
const k = W.kaal(Object.assign({ name: 'Proef', isArchived: false }, wf));
toets('2n kaal houdt alleen triggerknopen', k.nodes.length === 4 && k.nodes.every((n) => n.type !== 'n8n-nodes-base.set') && W.rooster(k) === W.rooster(wf));
toets('2o kaal: webhook zonder parameters', k.nodes[2].parameters === undefined);

// 3 hartslagoordeel
const NU = Date.parse('2026-11-02T12:00:00Z');
toets('3a geen rij = nooit', W.oordeel(undefined, NU) === 'nooit');
toets('3b vers', W.oordeel({ laatste_ronde: '2026-11-02T11:00:00Z', drempel_min: 120 }, NU) === 'vers');
toets('3c te laat', W.oordeel({ laatste_ronde: '2026-11-02T08:00:00Z', drempel_min: 120 }, NU) === 'te_laat');
toets('3d oordeel van de RPC wint', W.oordeel({ oordeel: 'nooit', laatste_ronde: '2026-11-02T11:00:00Z' }, NU) === 'nooit');

// 4 stand en check (verzonnen: alle register-workflows actief met een rooster, behalve één; één vreemde erbij)
const n8nWerkers = W.WERKERS.filter((w) => w.n8n);
const uitW = n8nWerkers[0];
const live = n8nWerkers.filter((w) => w !== uitW).map((w) => ({ id: w.n8n, name: w.naam, active: true, nodes: wf.nodes }))
  .concat(W.OVERIG.map((w) => ({ id: w.n8n, name: w.naam, active: true, nodes: [] })))
  .concat([{ id: 'Zzzzzzzzzzzzzzz9', name: 'Proef - nieuwe stroom', active: true, nodes: [] }]);
const metHs = W.WERKERS.find((w) => w.hartslag.length >= 2 && w !== uitW);
const hs = [{ component: metHs.hartslag[0], laatste_ronde: '2026-11-02T11:00:00Z', drempel_min: 120 },
  { component: metHs.hartslag[1], laatste_ronde: '2026-11-01T01:00:00Z', drempel_min: 120 },
  { component: 'losse_component', laatste_ronde: '2026-11-02T11:00:00Z', drempel_min: 60 }, { component: 'iets-proef', laatste_ronde: null }];
const st = W.stand({ workflows: live, hartslag: hs, nu: NU });
const alle = [].concat(...W.SOORTEN.map((s) => st.groepen[s]));
toets('4a elke werker één kaart, per soort gegroepeerd', alle.length === W.WERKERS.length && W.SOORTEN.every((s) => st.groepen[s].every((x) => x.soort === s)));
const kUit = alle.find((x) => x.id === uitW.id);
toets('4b workflow niet actief = status uit', kUit.status === 'uit' && kUit.actief === false && kUit.rooster === 'staat uit in n8n', kUit);
const kHs = alle.find((x) => x.id === metHs.id);
toets('4c ergste hartslag telt (te laat)', kHs.status === 'te laat' && kHs.laatst === '2026-11-02T11:00:00.000Z', kHs);
const zonder = alle.find((x) => x.n8n && x.id !== uitW.id && !x.hartslag.length);
toets('4d zonder component = geen hartslag, rooster live', zonder.status === 'geen hartslag' && zonder.rooster === 'elke dag 03:40 · op afroep', zonder);
toets('4e component zonder rij = nog nooit', (function () { const w = alle.find((x) => x.hartslag.length && x.id !== metHs.id && x.actief); return w && w.status === 'nog nooit'; })());
toets('4f check: vreemde workflow ontbreekt', st.check.ontbreekt.length === 1 && st.check.ontbreekt[0].id === 'Zzzzzzzzzzzzzzz9', st.check.ontbreekt);
toets('4g check: werker niet actief', st.check.niet_actief.length === 1 && st.check.niet_actief[0].id === uitW.n8n);
toets('4h check: hartslag zonder werker, proefrij weg', JSON.stringify(st.check.hartslag_zonder_werker) === '["losse_component"]', st.check.hartslag_zonder_werker);
toets('4i check: telling actief', st.check.n8n_actief === live.length);
toets('4j sessie en skill buiten de vaste plek', alle.some((x) => x.sessie) && alle.some((x) => x.skill));
const sv = W.stand({ workflows: live, hartslag: hs, nu: NU, vast: true });
toets('4k vaste plek: geen sessie, skill of bron', [].concat(...W.SOORTEN.map((s) => sv.groepen[s])).every((x) => !('sessie' in x) && !('skill' in x) && !('bron' in x)));
const sf = W.stand({ workflows: null, hartslag: null, nu: NU });
const af = [].concat(...W.SOORTEN.map((s) => sf.groepen[s]));
toets('4l meetfout: rooster onleesbaar, actief onbekend, fout gemeld', af.filter((x) => x.n8n).every((x) => x.actief === null && x.rooster === 'n8n nu niet leesbaar') && sf.fout.n8n && sf.fout.hartslag);
toets('4m meetfout: hartslag onbekend, niet "nooit"', af.filter((x) => x.hartslag.length).every((x) => x.status === 'onbekend'));
toets('4n meetfout: check niet gemeten (null)', sf.check.ontbreekt === null && sf.check.hartslag_zonder_werker === null);
toets('4o overig geteld', st.overig.aantal === W.OVERIG.length);

// 5 Ploeg.md
const md = W.markdown(st, '2026-11-02');
toets('5a kop en vier groepen', /^---\n/.test(md) && W.SOORTEN.every((s) => md.indexOf('## ' + { agent: 'Agents', wachter: 'Wachters', manager: 'Managers', routine: 'Routines' }[s] + ' (') >= 0));
toets('5b ontbrekende workflow in een eigen kopje', md.indexOf('## Niet in het register') >= 0 && md.indexOf('Zzzzzzzzzzzzzzz9') >= 0);
toets('5c geen | in een cel breekt de tabel', md.split('\n').filter((r) => /^\| /.test(r) && !/^\|---/.test(r)).every((r) => r.split(' | ').length === 7));
toets('5d tijd in Nederlandse tijd', md.indexOf('2-11 12:00') >= 0 || md.indexOf('2-11, 12:00') >= 0, md.split('\n').find((r) => r.indexOf(kHs.naam) >= 0));

// 6 koppeling in server.js, image en CI
const s = fs.readFileSync('server.js', 'utf8');
toets('6a dispatch GET /app/werkers', /route === 'GET \/app\/werkers'\) return typeof appWerkers === 'function'/.test(s));
toets('6b 404 zonder module', /if \(!WERKERS_MOD\) return appWeiger\(res, 404/.test(s));
toets('6c /health werkers', /werkers: typeof werkersInfo === 'function'/.test(s));
toets('6d alleen actieve workflows, kaal in de buffer', s.indexOf("'/workflows?limit=100&active=true'") >= 0 && s.indexOf('WERKERS_MOD.kaal(w)') >= 0);
toets('6e vaste plek doorgegeven', /WERKERS_MOD\.stand\(\{ workflows: wf, hartslag: hs, vast: !!\(a && a\.soort === 'vast'\) \}\)/.test(s));
toets('6f stil in het auditlog', /appWerkers[\s\S]{0,1600}res\._app\.stil = true/.test(s));
const u = fs.readFileSync('uitrol.sh', 'utf8');
toets('6g RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bwerkers\.js\b/.test(u));
toets('6h Dockerfile', /COPY werkers\.js \/app\/release-bootstrap\/werkers\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
toets('6i CI-stap', /bash test\/werkers\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));

console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
