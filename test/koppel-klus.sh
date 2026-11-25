#!/usr/bin/env bash
# wv4038 (nr 363 = 3C63, David Ja 21-11 13:09): één tik Gedaan sluit dezelfde klus overal. Toetst koppel-klus.js en de sluiters in server.js
# op verzonnen data (geen echte tabel, geen echte Todoist):
#   1. leesKoppel: alleen geldige sleutels; registerKoppels alleen uit ## Actueel; met de echte lezer blijven titel en sleutel gelijk
#   2. leesKoppelJson / teSluiten: alleen Gedaan, na de ↩️-rust, niet twee keer, niet na koppel_klaar, te grote groep = niets
#   3. maak().verwerk: alle gekoppelde plekken dicht; een verkeerde sleutel sluit niets; tijdelijke fout = later opnieuw, hooguit 3×
#   4. sluiters uit server.js (geknipt, met nep-n8n en nep-Todoist): actiepunt open → afgerond (filter op gelezen status), al dicht = niets,
#      bestaat niet = niets; Todoist: herhaaltaak, taak van een ander en gedeeld project niet; open taak → close
#   5. deadline via de sluitroute van deadline-lijstje.js: regel naar Afgehandeld met "via de gekoppelde klus"; telling voor = na;
#      een lijkende regel zonder sleutel blijft staan
# Gebruik: bash test/koppel-klus.sh
set -u
cd "$(dirname "$0")/.." || exit 1
TMPV=$(mktemp -d); trap 'rm -rf "$TMPV"' EXIT
mkdir -p "$TMPV/00_Systeem"
TMPV="$TMPV" node - <<'JS'
const fs = require('fs'), path = require('path'), cp = require('child_process'), vm = require('vm');
const KK = require('./koppel-klus.js'), DL = require('./deadline-lijstje.js');
let fout = 0;
const toets = (naam, ok, extra) => { console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); if (!ok) fout++; };
(async () => {
// ── 1. leesKoppel ──
let k = KK.leesKoppel('[jij] David: formulier invullen (koppel: actie proef-2030-01-01-formulier; todoist 6abcDEF123) ⏱ ± 1 u');
toets('1a actie + todoist uit de cel', k.actie.join() === 'proef-2030-01-01-formulier' && k.todoist.join() === '6abcDEF123', k);
k = KK.leesKoppel('koppel: actie a b c; todoist !!; dl:123; todoist 12345');
toets('1b ongeldige stukken tellen niet (spatie in id, tekens, korte dl, te kort Todoist-id)', !k.actie.length && !k.todoist.length && !k.dl.length, k);
k = KK.leesKoppel('Bel de leverancier.\nkoppel: actie proef-x-1\nkoppel: dl:' + 'a'.repeat(40));
toets('1c Todoist-beschrijving: koppel-regels met actie en dl', k.actie.join() === 'proef-x-1' && k.dl.join() === 'dl:' + 'a'.repeat(40), k);
toets('1d geen koppeling = leeg', JSON.stringify(KK.leesKoppel('[jij] David: iets met actie en todoist in de tekst')) === JSON.stringify({ actie: [], todoist: [], dl: [] }));

const REG0 = [
  '---', 'type: register', '---', '', '# Deadlines — proef', '', '## Actueel', '',
  '| Datum | Entiteit | Wat | Actie | Signaleer | Bron |', '|---|---|---|---|---|---|',
  '| 2030-03-10 | Proefpraktijk | **Proefklus jaaropgave versturen** (verzonnen) | [jij] David: jaaropgave nakijken en versturen | 7 | [[10_Zakelijk/Proef\\|proef]] |',
  '| 2030-03-10 | Proefpraktijk | **Proefklus jaaropgave versturen naar de boekhouder** (lijkt, verzonnen) | [jij] David: idem | 7 | - |',
  '| 2030-03-12 | Privé | **Proefklus zwemles opgeven** | [jij] David: aanmelden (koppel: todoist 9zzzZZZ999) | 3 | - |',
  '', '## Kandidaten (datum nog te achterhalen)', '', '| 2030-04-01 | X | **Kandidaat met koppeling** | [jij] (koppel: actie proef-kandidaat) | 7 | - |', '', '## Afgehandeld', '',
  '| Datum | Wat | Status |', '|---|---|---|', '| 2029-01-01 | oud | AFGEHANDELD |', '', '## Meetlog', '', '- M01: proef', '',
].join('\n');
const REG = REG0.replace('[jij] David: jaaropgave nakijken en versturen |', '[jij] David: jaaropgave nakijken en versturen (koppel: actie proef-2030-03-01-jaaropgave; todoist 6abcDEF123) |');
const PY = process.env.DL_KALENDER_PY || '/opt/data/scripts/huidig/packages/sb2/src/socev_sb2/kalender_deadlines.py';
const pad = path.join(process.env.TMPV, '00_Systeem', 'Deadlines.md');
const metPy = fs.existsSync(PY);
const droog = (tekst) => { fs.writeFileSync(pad, tekst); return JSON.parse(cp.execFileSync('python3', ['-I', PY, '--droog', '--vault', process.env.TMPV]).toString()).items; };
if (!metPy) { console.log('ROOD  echte lezer ontbreekt: ' + PY); process.exit(1); }
const i0 = droog(REG0), i1 = droog(REG);
const ts = (it) => it.map((i) => i.sleutel + '|' + i.titel + '|' + i.datum).sort().join('\n');
toets('1e echte lezer: koppeling in Actie laat titel, datum en sleutel van alle regels gelijk', ts(i0) === ts(i1) && i1.length >= 3, [i0.length, i1.length]);
let rk = KK.registerKoppels(i1, REG, DL.cellen);
const jaar = i1.find((i) => /jaaropgave versturen$/.test(i.titel) || i.titel === 'Proefklus jaaropgave versturen');
toets('1f registerKoppels: twee regels uit Actueel, niet de kandidaat; juiste sleutel', rk.length === 2 && jaar && rk.some((x) => x.sleutel === jaar.sleutel && x.actie[0] === 'proef-2030-03-01-jaaropgave' && x.todoist[0] === '6abcDEF123') && !rk.some((x) => (x.actie || []).indexOf('proef-kandidaat') >= 0), rk);

// ── 2. teSluiten ──
const nu = Date.parse('2030-03-10T10:00:00Z');
const rij = (o) => Object.assign({ nonce: 'n' + Math.random().toString(16).slice(2, 10), datum: '2030-03-10', bron: 'actie_state', sleutel: 'proef-2030-03-01-jaaropgave', status: 'afgehandeld', keuze: 'gedaan',
  getikt_op: '2030-03-10T09:50:00Z', koppel_json: JSON.stringify([{ bron: 'deadline', sleutel: jaar.sleutel }, { bron: 'todoist', sleutel: '6abcDEF123' }]) }, o);
let l = KK.teSluiten([rij()], nu, new Set(), '2030-03-10');
toets('2a Gedaan met koppel_json na de rust: één taak met twee doelen', l.length === 1 && l[0].doel.length === 2 && l[0].vandaag === '2030-03-10', l);
toets('2b binnen de ↩️-rust (60 s) nog niet', KK.teSluiten([rij({ getikt_op: '2030-03-10T09:59:00Z' })], nu, new Set(), '2030-03-10').length === 0);
toets('2c later / laten vallen / open niet', KK.teSluiten([rij({ keuze: 'later' }), rij({ keuze: 'laten_vallen' }), rij({ status: 'open', keuze: '' })], nu, new Set(), '2030-03-10').length === 0);
toets('2d koppel_klaar gezet = niet nog eens', KK.teSluiten([rij({ koppel_klaar: '2030-03-10T10:00 …' })], nu, new Set(), '2030-03-10').length === 0);
toets('2e geen koppel_json / [] / onzin = niets', KK.teSluiten([rij({ koppel_json: '' }), rij({ koppel_json: '[]' }), rij({ koppel_json: '{x' }), rij({ koppel_json: '[{"bron":"mail","sleutel":"x"}]' })], nu, new Set(), '2030-03-10').length === 0);
const groot = JSON.stringify([1, 2, 3, 4, 5, 6].map((n) => ({ bron: 'todoist', sleutel: 'proef00' + n })));
toets('2f groep van ' + KK.GROEP_MAX + ' of meer = niets', KK.teSluiten([rij({ koppel_json: groot })], nu, new Set(), '2030-03-10').length === 0);
toets('2g zichzelf in koppel_json telt niet', KK.leesKoppelJson(rij({ koppel_json: JSON.stringify([{ bron: 'actie_state', sleutel: 'proef-2030-03-01-jaaropgave' }]) })).length === 0);
toets('2h oude rij (> 4 dagen) niet', KK.teSluiten([rij({ datum: '2030-03-01' })], nu, new Set(), '2030-03-10').length === 0);

// ── 3. verwerk met nep-sluiters ──
const open = { 'actie_state:proef-2030-03-01-jaaropgave': 'open', ['deadline:' + jaar.sleutel]: 'open', 'todoist:6abcDEF123': 'open', 'todoist:7lijktOpZelfde': 'open' };
const gelogd = [], gemerkt = [];
let storing = 0;
const nepSluit = (bron) => async (s) => {
  if (storing > 0) { storing--; throw new Error('nep: tijdelijk weg'); }
  const sl = bron + ':' + s;
  if (!(sl in open)) return { uitkomst: 'bestaat_niet' };
  if (open[sl] !== 'open') return { uitkomst: 'al_dicht' };
  open[sl] = 'dicht'; return { uitkomst: 'gesloten' };
};
let rijen = [rij({ nonce: 'proefnonce1' })];
const r = KK.maak({ mag: () => true, rijen: async () => rijen, sluit: { actie_state: nepSluit('actie_state'), todoist: nepSluit('todoist'), deadline: nepSluit('deadline') },
  markeer: async (n, t) => { gemerkt.push([n, t]); rijen.forEach((x) => { if (x.nonce === n) x.koppel_klaar = t; }); }, log: (s) => gelogd.push(s), vandaag: () => '2030-03-10' });
const echtNu = Date.now; Date.now = () => nu;
let u = await r.verwerk();
toets('3a één tik: deadline en Todoist dicht', u.gesloten === 2 && open['deadline:' + jaar.sleutel] === 'dicht' && open['todoist:6abcDEF123'] === 'dicht', u);
toets('3b lijkende taak zonder sleutel blijft open', open['todoist:7lijktOpZelfde'] === 'open');
toets('3c portierij gemarkeerd (koppel_klaar)', gemerkt.length === 1 && gemerkt[0][0] === 'proefnonce1' && /gesloten/.test(gemerkt[0][1]), gemerkt);
u = await r.verwerk();
toets('3d tweede ronde doet niets', u.gesloten === 0 && u.niets === 0 && gemerkt.length === 1, u);
rijen = [rij({ nonce: 'proefnonce2', bron: 'todoist', sleutel: '8andereTaak1', koppel_json: JSON.stringify([{ bron: 'actie_state', sleutel: 'bestaat-niet-proef' }, { bron: 'todoist', sleutel: 'bestaatNiet99' }]) })];
const voorStand = JSON.stringify(open);
u = await r.verwerk();
toets('3e verkeerde sleutels (bestaan niet) sluiten niets, rij toch gemarkeerd', JSON.stringify(open) === voorStand && u.gesloten === 0 && gemerkt.length === 2, u);
open['todoist:storingProef1'] = 'open';
rijen = [rij({ nonce: 'proefnonce3', koppel_json: JSON.stringify([{ bron: 'todoist', sleutel: 'storingProef1' }]) })];
storing = 1;
u = await r.verwerk();
toets('3f tijdelijke fout: niet gemarkeerd, later opnieuw', u.later === 1 && gemerkt.length === 2 && open['todoist:storingProef1'] === 'open', u);
u = await r.verwerk();
toets('3g volgende ronde: alsnog dicht en gemarkeerd', u.gesloten === 1 && gemerkt.length === 3 && open['todoist:storingProef1'] === 'dicht', u);
open['todoist:altijdWeg01'] = 'open';
rijen = [rij({ nonce: 'proefnonce4', koppel_json: JSON.stringify([{ bron: 'todoist', sleutel: 'altijdWeg01' }]) })];
storing = 99;
await r.verwerk(); await r.verwerk(); await r.verwerk(); u = await r.verwerk();
toets('3h na 3 mislukte rondes opgegeven (gemarkeerd met fout), daarna niets meer', gemerkt.length === 4 && /fout/.test(gemerkt[3][1]) && u.later === 0 && u.niets === 0, [gemerkt.length, u]);
storing = 0;
const passief = KK.maak({ mag: () => false, rijen: async () => [rij({ nonce: 'proefnonce5' })], sluit: { actie_state: () => { throw new Error('mag niet'); }, todoist: () => { throw new Error('mag niet'); }, deadline: () => { throw new Error('mag niet'); } },
  markeer: async () => { throw new Error('mag niet'); }, log: () => {}, vandaag: () => '2030-03-10' });
u = await passief.verwerk();
toets('3i passieve pod sluit niets', u.gesloten === 0 && u.niets === 0);
Date.now = echtNu;

// ── 4. sluiters uit server.js (geknipt) ──
const src = fs.readFileSync('server.js', 'utf8');
const knip = (naam) => { const i = src.indexOf('async function ' + naam + '('); if (i < 0) throw new Error('niet gevonden: ' + naam); let d = 0, j = src.indexOf('{', i); for (let x = j; x < src.length; x++) { if (src[x] === '{') d++; else if (src[x] === '}') { d--; if (d === 0) return src.slice(i, x + 1); } } };
const kkDm = /function kkDm\([^]*?\n/.exec(src)[0];
const tabel = [];
const ctx = { process: { env: { TODOIST_MCP_TOKEN: 'nep' } }, KK_ACTIE_TABEL: 'nepTabel', KK_DAVID_TODOIST: '58247764', AbortSignal: { timeout: () => null }, String, Array, JSON, encodeURIComponent, Error, gepatcht: [], gesloten: [],
  appN8nRijen: async (t, f) => tabel.filter((x) => x.actie_id === f.filters[0].value).map((x) => Object.assign({}, x)),
  appN8nZend: async (m, p, b) => { ctx.gepatcht.push(b); const fs2 = b.filter.filters; const hit = tabel.filter((x) => fs2.every((c) => String(x[c.columnName]) === String(c.value))); hit.forEach((x) => Object.assign(x, b.data)); return hit; },
  taken: {}, projecten: {},
  appTodoistTaak: async (id) => ctx.taken[id] || null,
  fetch: async (url, o) => { const m = /projects\/(.+)$/.exec(url); if (m) return { ok: true, json: async () => ctx.projecten[decodeURIComponent(m[1])] || { is_shared: true } };
    const c = /tasks\/(.+)\/close$/.exec(url); if (c && o.method === 'POST') { ctx.gesloten.push(decodeURIComponent(c[1])); return { ok: true, status: 204 }; } return { ok: false, status: 500 }; } };
vm.createContext(ctx);
vm.runInContext(kkDm + knip('kkSluitActie') + '\n' + knip('kkSluitTodoist') + '\nthis.A = kkSluitActie; this.T = kkSluitTodoist;', ctx);
tabel.push({ actie_id: 'proef-open', status: 'open', bevinding: 'AANGELEGD proef', volgende_check: '2030-03-12' }, { actie_id: 'proef-dicht', status: 'afgerond', bevinding: '' }, { actie_id: 'proef-gemeld', status: 'gemeld', bevinding: 'x' });
let a = await ctx.A('proef-open', '2030-03-10');
toets('4a actiepunt open → afgerond, één regel achter de bevinding, volgende_check leeg', a.uitkomst === 'gesloten' && tabel[0].status === 'afgerond' && /AANGELEGD proef ‖ AFGEROND 10-3 via de gekoppelde klus/.test(tabel[0].bevinding) && tabel[0].volgende_check === '' && tabel[0].laatst_gecheckt === '2030-03-10', [a, tabel[0]]);
toets('4b PATCH filtert op sleutel, gelezen status én gelezen bevinding (Codex MOET 3)', ctx.gepatcht[0].filter.filters.length === 3 && ctx.gepatcht[0].filter.filters[1].value === 'open' && ctx.gepatcht[0].filter.filters[2].value === 'AANGELEGD proef', ctx.gepatcht[0]);
// Codex MOET 3: bevinding veranderde tussen lezen en schrijven → niets overschreven, tijdelijk (volgende ronde opnieuw)
{ const zend = ctx.appN8nZend; tabel.push({ actie_id: 'proef-race', status: 'open', bevinding: 'oud' });
  ctx.appN8nZend = async (m, p, b) => { tabel[tabel.length - 1].bevinding = 'nieuw van de wachter'; return zend(m, p, b); };
  const ra = await ctx.A('proef-race', '2030-03-10'); ctx.appN8nZend = zend;
  toets('4b2 bevinding intussen gewijzigd: niets overschreven, tijdelijk', ra.uitkomst === 'tijdelijk' && tabel[tabel.length - 1].status === 'open' && tabel[tabel.length - 1].bevinding === 'nieuw van de wachter', [ra, tabel[tabel.length - 1]]); }
const np = ctx.gepatcht.length;
a = await ctx.A('proef-dicht', '2030-03-10');
toets('4c actiepunt al afgerond = al_dicht, niets geschreven', a.uitkomst === 'al_dicht' && ctx.gepatcht.length === np, a);
a = await ctx.A('proef-bestaat-niet', '2030-03-10');
toets('4d actiepunt bestaat niet = niets', a.uitkomst === 'bestaat_niet' && ctx.gepatcht.length === np, a);
a = await ctx.A('proef-gemeld', '2030-03-10');
toets('4e gemeld → afgerond', a.uitkomst === 'gesloten' && tabel[2].status === 'afgerond', a);
ctx.taken = { t1open: { id: 't1open', project_id: 'p1', checked: false }, t2herh: { id: 't2herh', project_id: 'p1', due: { is_recurring: true } }, t3ander: { id: 't3ander', project_id: 'p1', responsible_uid: '111' },
  t4gedeeld: { id: 't4gedeeld', project_id: 'p2' }, t5dicht: { id: 't5dicht', project_id: 'p1', checked: true }, t6van: { id: 't6van', project_id: 'p1', responsible_uid: '58247764' } };
ctx.projecten = { p1: { is_shared: false }, p2: { is_shared: true } };
const T = {};
for (const id of ['t1open', 't2herh', 't3ander', 't4gedeeld', 't5dicht', 't6van', 'tBestaatNiet']) T[id] = (await ctx.T(id)).uitkomst;
toets('4f Todoist: open en van David dicht; herhaal, ander, gedeeld overgeslagen; dicht = al_dicht; onbekend = bestaat_niet',
  T.t1open === 'gesloten' && T.t6van === 'gesloten' && T.t2herh === 'overgeslagen' && T.t3ander === 'overgeslagen' && T.t4gedeeld === 'overgeslagen' && T.t5dicht === 'al_dicht' && T.tBestaatNiet === 'bestaat_niet' && ctx.gesloten.join() === 't1open,t6van', [T, ctx.gesloten]);

// ── 5. deadline via de sluitroute ──
let tekst = REG;
const telRegels = (s) => s.split('\n').filter((x) => /^\| \d{4}-/.test(x)).length;
const voor = telRegels(tekst);
const o = { droog: () => ({ items: droog(tekst) }), lees: () => tekst, wijzig: (f) => { const n = f(tekst); if (n === null) return false; tekst = n; return true; }, mag: () => true };
const s1 = await DL.schrijf(o, { sleutel: jaar.sleutel, datum: jaar.datum, titel: jaar.titel, keuze: 'gedaan', vandaag: '2030-03-10', gekoppeld: true });
const af = tekst.split('\n').find((x) => x.indexOf('Proefklus jaaropgave versturen** (verzonnen)') >= 0);
const secAf = tekst.indexOf('## Afgehandeld') < tekst.indexOf(af);
toets('5a deadline naar Afgehandeld met "via de gekoppelde klus"', s1.ok && secAf && /AFGEHANDELD 10-3-2030 \(Gedaan in je actielijstje, via de gekoppelde klus\)/.test(af), [s1.u && s1.u.niets, af]);
toets('5b telling regels voor = na', telRegels(tekst) === voor, [voor, telRegels(tekst)]);
const lijk = tekst.split('\n').find((x) => x.indexOf('naar de boekhouder') >= 0);
toets('5c lijkende regel zonder sleutel blijft in Actueel', lijk && tekst.indexOf(lijk) < tekst.indexOf('## Kandidaten'));

console.log(fout ? fout + ' ROOD' : 'alles groen');
process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
