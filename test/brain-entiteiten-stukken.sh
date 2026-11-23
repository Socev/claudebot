#!/usr/bin/env bash
# Toetst wv3938 (besluitenpagina nr 322/345/350 = 3C22/3C45/3C50) in brain-entiteiten.js, server.js en app-vast.js:
# stukken uit Intake per partij (eigen entiteit op doel, andere partij op afzender tegen mail/domein; verwerkt stuk via het bronnenregister
# of Bronnen/Intake terug te vinden, anders geen pad), de hoofdpagina uit de frontmatter met tikbare verwijzingen (wikilink blijft [[vol pad|tekst]],
# partijlinks → sleutel), tegels van de eigen entiteiten (deadlines 0..30 dagen, stukken 7 dagen) en laatst bekeken; de teller kent
# 'entiteiten' en 'entiteit-kaart'. Alle namen, adressen en onderwerpen zijn verzonnen (openbare repo).
# Gebruik: bash test/brain-entiteiten-stukken.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 900) + ']' : '')); }
const B = require('./brain-entiteiten.js');
const { DatabaseSync } = require('node:sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv3938-'));
const vault = path.join(tmp, 'vault');
const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), t); };
zet('10_Zakelijk/Proef/Entiteit - PR.md', '---\ntype: entiteit\nentiteit_id: PR\nhoofdpagina: "[[10_Zakelijk/Proef/index]]"\n---\n# Proefpraktijk\n\nAlles staat op [[10_Zakelijk/Proef/index|de hoofdpagina]].\n');
zet('10_Zakelijk/Proef/index.md', '---\ntype: index\n---\n# Proefpraktijk\n\nLeverancier [[10_Zakelijk/_Gedeeld/Relaties/Verzonnen Telecom|Verzonnen Telecom]], pagina [[Huisvesting Proef]], kop [[10_Zakelijk/Proef/Huisvesting Proef#Huur|huur]], ' +
  'weg [[Bestaat Niet]], plaatje ![[logo.png]], dubbel [[Dubbel]].\n');
zet('10_Zakelijk/Proef/Huisvesting Proef.md', '# Huisvesting\n');
zet('10_Zakelijk/Proef/logo.png', 'x');
zet('10_Zakelijk/Proef/Dubbel.md', '# a\n');
zet('10_Zakelijk/Ander/Dubbel.md', '# b\n');
zet('10_Zakelijk/Ander/Entiteit - AN.md', '---\ntype: entiteit\nhoofdpagina: "[[10_Zakelijk/Ander/weg]]"\n---\n# Ander\n');
zet('10_Zakelijk/_Gedeeld/Relaties/Verzonnen Telecom.md', '# Verzonnen Telecom\n\nZie [[10_Zakelijk/Proef/Entiteit - PR|Proefpraktijk]].\n');
zet('10_Zakelijk/_Gedeeld/Relaties/Zonder Kenmerk.md', '# Zonder Kenmerk\n');
// Intake: verwerkte stukken staan in Bronnen (register of Bronnen/Intake), één staat nog in raw_input, één is nergens meer
zet('10_Zakelijk/Proef/raw_input/2026-11-20_0900_gmail_Nog-in-raw.md', '# raw\n');
zet('10_Zakelijk/Proef/raw_input/2026-10-09_0800_gmail_Weg__bijlage.pdf', 'x');
zet('10_Zakelijk/Proef/Bronnen/Intake/2026-11-19_1000_gmail_Via-intake-map.md', '# intake\n');
zet('10_Zakelijk/Proef/Bronnen/Proef - 2026-11-18 - Telecomfactuur (mail).md', '# archief\n');
zet('10_Zakelijk/Proef/Bronnen/Sub/Proef - 2026-11-10 - Scan.pdf', 'x');
zet('10_Zakelijk/Proef/Bronnen/_register.md', '---\ntype: bronnenregister\n---\n# Register\n\n| Archiefnaam | Bron | Verwerkt | Pagina | Status |\n|---|---|---|---|---|\n' +
  '| Proef - 2026-11-18 - Telecomfactuur (mail).md | `raw_input/2026-11-18_1144_gmail_Telecomfactuur.md` | 2026-11-19 | x | volledig |\n' +
  '| [[10_Zakelijk/Proef/Bronnen/Sub/Proef - 2026-11-10 - Scan.pdf]] | ovis_stuk stk_20261110_0000000a | 2026-11-11 | x | volledig |\n' +
  '| ../buiten.md | `raw_input/2026-11-01_0000_gmail_Buiten.md` | 2026-11-02 | x | volledig |\n');
const ipad = path.join(tmp, 'intake.sqlite');
const db = new DatabaseSync(ipad);
db.exec('CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT, ontvangen TEXT, meta TEXT, bestandsnaam TEXT); CREATE TABLE uitvoering (id INTEGER PRIMARY KEY, stuk_id TEXT, versie INTEGER, lens TEXT, doel TEXT, pad TEXT, uitkomst TEXT, tijd TEXT);');
const stuk = (id, bron, ontv, meta) => db.prepare('INSERT INTO stuk VALUES (?,?,?,?,NULL)').run(id, bron, ontv, JSON.stringify(meta));
const uit = (id, doel, pad, tijd) => db.prepare("INSERT INTO uitvoering (stuk_id, versie, lens, doel, pad, uitkomst, tijd) VALUES (?,1,'kennis',?,?,'nieuw',?)").run(id, doel, pad, tijd);
stuk('stk_20261120_00000001', 'gmail:david', '2026-11-20T09:00:00Z', { onderwerp: 'Nog in raw', van: 'Iemand <iemand@elders.example>' });
uit('stk_20261120_00000001', 'PR', '10_Zakelijk/Proef/raw_input/2026-11-20_0900_gmail_Nog-in-raw.md', '2026-11-20T09:05:00Z');
stuk('stk_20261119_00000002', 'outlook:proef', '2026-11-19T10:00:00Z', { onderwerp: 'Via intake-map', van: 'x@elders.example' });
uit('stk_20261119_00000002', 'PR', '10_Zakelijk/Proef/raw_input/2026-11-19_1000_gmail_Via-intake-map.md', '2026-11-19T10:05:00Z');
stuk('stk_20261118_00000003', 'gmail:david', '2026-11-18T11:44:00Z', { onderwerp: 'Telecomfactuur november', van: 'Verzonnen Telecom <factuur@mail.verzonnen-telecom.example>' });
uit('stk_20261118_00000003', 'PR', '10_Zakelijk/Proef/raw_input/2026-11-18_1144_gmail_Telecomfactuur.md', '2026-11-18T12:00:00Z');
uit('stk_20261118_00000003', 'PR', '10_Zakelijk/Proef/raw_input/2026-11-18_1144_gmail_Telecomfactuur__factuur.pdf', '2026-11-18T12:00:01Z');
stuk('stk_20261110_0000000a', 'scanner:scansnap', '2026-11-10T08:00:00Z', {});
uit('stk_20261110_0000000a', 'PR', '10_Zakelijk/Proef/raw_input/2026-11-10_0800_scan_Brief-verzonnen.pdf', '2026-11-10T08:10:00Z');
stuk('stk_20261009_00000007', 'gmail:david', '2026-10-09T08:00:00Z', { onderwerp: 'Alleen de bijlage staat er nog' });
uit('stk_20261009_00000007', 'PR', '10_Zakelijk/Proef/raw_input/2026-10-09_0800_gmail_Weg.md', '2026-10-09T08:10:00Z');
uit('stk_20261009_00000007', 'PR', '10_Zakelijk/Proef/raw_input/2026-10-09_0800_gmail_Weg__bijlage.pdf', '2026-10-09T08:10:01Z');
stuk('stk_20261001_00000004', 'whatsapp:nl', '2026-10-01T08:00:00Z', { onderwerp: 'Oud en weg' });
uit('stk_20261001_00000004', 'PR', '10_Zakelijk/Proef/raw_input/2026-10-01_0800_wa_Oud.md', '2026-10-01T08:10:00Z');
stuk('stk_20261121_00000005', 'gmail:david', '2026-11-21T08:00:00Z', { onderwerp: 'Ander doel', van: 'factuur@verzonnen-telecom.example' });
uit('stk_20261121_00000005', 'AN', '10_Zakelijk/Ander/raw_input/2026-11-21_0800_gmail_Ander.md', '2026-11-21T08:10:00Z');
stuk('stk_20261121_00000006', 'gmail:david', '2026-11-21T09:00:00Z', { onderwerp: 'Lijkt erop', van: 'a@nietverzonnen-telecom.example' });
uit('stk_20261121_00000006', null, null, '2026-11-21T09:10:00Z');
db.close();

const knopen = [
  { id: 'PR', soort: 'entiteit', rol: 'eigen', naam: 'Proefpraktijk', vault_pagina: '10_Zakelijk/Proef/Entiteit - PR.md', actief: true, voor: [] },
  { id: 'AN', soort: 'entiteit', rol: 'eigen', naam: 'Anderpraktijk', vault_pagina: '10_Zakelijk/Ander/Entiteit - AN.md', actief: true, voor: [] },
  { id: 'PRIVE', soort: 'entiteit', rol: 'eigen', naam: 'Privé', vault_pagina: '20_Prive/Entiteit - PRIVE.md', actief: true, voor: [] },
  { id: 'org:verzonnen-telecom', soort: 'organisatie', rol: 'leverancier', naam: 'Verzonnen Telecom', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Verzonnen Telecom.md', actief: true, voor: ['PR'] },
  { id: 'org:zonder', soort: 'organisatie', rol: 'leverancier', naam: 'Zonder Kenmerk', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Zonder Kenmerk.md', actief: true, voor: ['PR'] },
];
const handvatten = [{ knoop: 'org:verzonnen-telecom', soort: 'domein', waarde: 'verzonnen-telecom.example', status: 'actief' }];
const rpc = async (fn) => { if (fn !== 'ovis_register_lees') throw new Error('onverwacht ' + fn); return { knopen, handvatten }; };
const kaartLijst = [];
(function wandel(d) { for (const n of fs.readdirSync(path.join(vault, d))) { const r = d ? d + '/' + n : n, st = fs.statSync(path.join(vault, r)); if (st.isDirectory()) wandel(r); else kaartLijst.push({ p: r, s: '', m: st.mtimeMs }); } })('');
const deadlines = () => [
  { ents: ['PR'], dagen: 0, datum: '2026-11-22', titel: 'Vandaag' }, { ents: ['PR'], dagen: 30, datum: '2026-12-22', titel: 'Grens' },
  { ents: ['PR'], dagen: 31, datum: '2026-12-23', titel: 'Erna' }, { ents: ['PR'], dagen: -1, datum: '2026-11-21', titel: 'Gisteren' },
  { ents: ['AN', 'PR'], dagen: 5, datum: '2026-11-27', titel: 'Samen' },
];
let bk = [];
const T = B.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), deadlines, kaart: () => kaartLijst, intakePad: ipad, bekeken: () => bk, nu: () => Date.parse('2026-11-22T12:00:00Z') });
const zonder = B.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), deadlines, kaart: () => kaartLijst, nu: () => Date.parse('2026-11-22T12:00:00Z') });
const sl = B.sleutelVan;

(async () => {
  const d = (await T.detail(sl('PR'))).j;
  const st = d.weet.stukken;
  toets('1 eigen entiteit: alle stukken met haar doel, nieuwste eerst', st && st.totaal === 6 && st.stukken.map((x) => x.id).join() === 'stk_20261120_00000001,stk_20261119_00000002,stk_20261118_00000003,stk_20261110_0000000a,stk_20261009_00000007,stk_20261001_00000004', st);
  const p = Object.fromEntries(st.stukken.map((x) => [x.id, x.pad]));
  toets('2 pad: nog in raw_input / Bronnen/Intake / register op naam / register op stuk-id / nergens = null', p.stk_20261120_00000001 === '10_Zakelijk/Proef/raw_input/2026-11-20_0900_gmail_Nog-in-raw.md' &&
    p.stk_20261119_00000002 === '10_Zakelijk/Proef/Bronnen/Intake/2026-11-19_1000_gmail_Via-intake-map.md' && p.stk_20261118_00000003 === '10_Zakelijk/Proef/Bronnen/Proef - 2026-11-18 - Telecomfactuur (mail).md' &&
    p.stk_20261110_0000000a === '10_Zakelijk/Proef/Bronnen/Sub/Proef - 2026-11-10 - Scan.pdf' && p.stk_20261001_00000004 === null &&
    p.stk_20261009_00000007 === '10_Zakelijk/Proef/raw_input/2026-10-09_0800_gmail_Weg__bijlage.pdf', p);   // review ZOU 2: bijlage als terugval
  const f = st.stukken.find((x) => x.id === 'stk_20261118_00000003'), sc = st.stukken.find((x) => x.id === 'stk_20261110_0000000a');
  toets('3 regel: onderwerp, datum, bron, bijlagen, ext; zonder onderwerp de naam uit het pad', f.titel === 'Telecomfactuur november' && f.datum === '2026-11-18' && f.bron === 'mail' && f.bijlagen === 1 && f.ext === 'md' &&
    sc.titel === 'Brief verzonnen' && sc.bron === 'scan' && sc.ext === 'pdf', [f, sc]);
  toets('4 nieuw = laatste 7 dagen', st.nieuw === 3, st.nieuw);
  const t = (await T.detail(sl('org:verzonnen-telecom'))).j.weet.stukken;
  toets('5 andere partij: op afzenderdomein (ook subdomein), niet op een domein dat er alleen op lijkt', t.totaal === 2 && t.stukken.map((x) => x.id).join() === 'stk_20261121_00000005,stk_20261118_00000003' && t.kenmerken === true, t);
  const z = (await T.detail(sl('org:zonder'))).j.weet.stukken;
  toets('6 partij zonder mail/domein-kenmerk: leeg met kenmerken false (eerlijke lege regel)', z.totaal === 0 && z.kenmerken === false, z);
  toets('7 pod zonder intake.sqlite: stukken null (geen blok)', (await zonder.detail(sl('PR'))).j.weet.stukken === null);
  const kapot = B.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), kaart: () => kaartLijst, intakePad: vault, nu: () => 0 });
  toets('8 onleesbare intake.sqlite: fout, geen uitzondering', !!(await kapot.detail(sl('PR'))).j.weet.stukken.fout);

  const hp = d.hoofdpagina;
  toets('9 hoofdpagina uit de frontmatter: pad, tekst en regels', hp && hp.pad === '10_Zakelijk/Proef/index.md' && /# Proefpraktijk/.test(hp.tekst) && hp.regels === 7, hp);
  toets('10 verwijzingen blijven tikbaar: vol pad, korte naam opgelost, #kop weg; onbekend/dubbel/insluiting = tekst',
    hp.tekst.includes('[[10_Zakelijk/_Gedeeld/Relaties/Verzonnen Telecom.md|Verzonnen Telecom]]') && hp.tekst.includes('[[10_Zakelijk/Proef/Huisvesting Proef.md|Huisvesting Proef]]') &&
    hp.tekst.includes('[[10_Zakelijk/Proef/Huisvesting Proef.md|huur]]') && hp.tekst.includes('weg Bestaat Niet') && hp.tekst.includes('plaatje logo.png') && hp.tekst.includes('dubbel Dubbel.') && !/\[\[Bestaat|\[\[Dubbel|!\[\[/.test(hp.tekst), hp.tekst);
  toets('11 links: een verwijzing naar een partij geeft haar sleutel (ook op de registerpagina)', d.links['10_Zakelijk/_Gedeeld/Relaties/Verzonnen Telecom.md'] === sl('org:verzonnen-telecom') && !d.links['10_Zakelijk/Proef/Huisvesting Proef.md'] && /\[\[10_Zakelijk\/Proef\/index\.md\|de hoofdpagina\]\]/.test(d.tekst), d.links);
  const td = (await T.detail(sl('org:verzonnen-telecom'))).j;
  toets('12 partijpagina: link terug naar de eigen entiteit opent haar kaart; geen hoofdpagina-veld = undefined', td.links['10_Zakelijk/Proef/Entiteit - PR.md'] === sl('PR') && td.hoofdpagina === undefined, td.links);
  toets('13 hoofdpagina die niet bestaat: eerlijke fout, geen tekst', (await T.detail(sl('AN'))).j.hoofdpagina.fout && (await T.detail(sl('AN'))).j.hoofdpagina.tekst === null);
  toets('14b [[#Kop]] houdt de kopnaam (review ZOU 3), met en zonder link-optie', B.paginaTekst('zie [[#Contact]] en [[#Adres|hier]]') === 'zie Contact en hier' && B.paginaTekst('zie [[#Contact]]', { link: () => null }) === 'zie Contact');
  toets('14 paginaTekst zonder link-optie: wikilinks plat zoals vroeger', B.paginaTekst('a [[x/y|z]] b [[x/w]] c ![[p.png]]') === 'a z b w c p.png', B.paginaTekst('a [[x/y|z]] b [[x/w]] c ![[p.png]]'));

  bk = [{ s: sl('org:zonder'), t: '2026-11-22T11:00:00Z' }, { s: 'aaaaaaaaaaaa', t: '2026-11-22T10:00:00Z' }, { s: sl('PR'), t: '2026-11-22T09:00:00Z' }];
  const l = await T.lijst();
  const tg = Object.fromEntries(l.eigen_tegels.map((x) => [x.code, x]));
  toets('15 tegels: elke eigen entiteit, Privé achteraan', l.eigen_tegels.map((x) => x.code).join() === 'AN,PR,PRIVE', l.eigen_tegels);
  toets('16 tegel deadlines = register 0..30 dagen (zelfde bron als de kaart)', tg.PR.deadlines === 3 && tg.AN.deadlines === 1 && tg.PRIVE.deadlines === 0, tg);
  toets('17 tegel nieuwe stukken = laatste 7 dagen op doel', tg.PR.stukken_nieuw === 3 && tg.AN.stukken_nieuw === 1, tg);
  toets('18 laatst bekeken: alleen sleutels uit de lijst, volgorde gehouden', JSON.stringify(l.bekeken) === JSON.stringify([sl('org:zonder'), sl('PR')]), l.bekeken);
  const b1 = B.bekekenBij([{ s: 'bbbbbbbbbbbb', t: 'x' }, { s: 'cccccccccccc', t: 'y' }, { s: 'kapot' }], 'cccccccccccc', 'z');
  toets('19 bekekenBij: nieuwste eerst, geen dubbele, onzin eruit, hooguit 20', b1.map((x) => x.s).join() === 'cccccccccccc,bbbbbbbbbbbb' &&
    B.bekekenBij(Array.from({ length: 30 }, (_, i) => ({ s: String(i).padStart(12, '0') })), 'dddddddddddd', 'z').length === 20, b1);
  const ri = B.registerIndex('| ../buiten.md | `raw_input/a.md` |\n| x.md + y.pdf | `raw_input/b.md` |', 'W/');
  toets('20 registerIndex: ".." weg, "x.md + y.pdf" = x.md', !ri.has('bn:a.md') && ri.get('bn:b.md') === 'W/Bronnen/x.md', Array.from(ri));

  const srv = fs.readFileSync('server.js', 'utf8'), av = require('./app-vast.js');
  toets('21 server.js: intakePad en bekeken mee, opening vastgelegd en geteld; bekeken altijd, alleen de teller ontdubbelt (review ZOU 1)', /appSchrijfJson\(APP_ENT_BEKEKEN[^\n]*\n[^\n]*\n  if \(typeof v === 'number' && nuMs - v >= 0 && nuMs - v < 60000\) return;/.test(srv) && /intakePad: path\.join\(INTAKE_DIR, 'intake\.sqlite'\),   \/\/ wv3938/.test(srv) && /bekeken: appEntBekekenLees/.test(srv) &&
    /res\._app\.stil = true; appEntBekeken\(id\);/.test(srv) && /telOpen\(appAppsTelling\(L\), 'entiteit-kaart'/.test(srv));
  const t0 = av.tellingUitBestand(null), m = new Map();
  const a1 = av.telOpen(t0, 'entiteiten', '2026-11-22', 1, m), a2 = av.telOpen(a1.t, 'entiteit-kaart', '2026-11-22', 2, m);
  toets('22 teller kent entiteiten en entiteit-kaart; blijven staan na opnieuw inlezen', a1.ok && a2.ok && av.tellingUitBestand(JSON.parse(JSON.stringify(a2.t))).dagen['2026-11-22']['entiteit-kaart'] === 1 && !av.telOpen(t0, 'entiteit-iets', '2026-11-22', 3, m).ok);
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + e.stack); process.exit(1); });
JS
