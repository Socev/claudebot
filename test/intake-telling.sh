#!/usr/bin/env bash
# Toetst intake-telling.js en de koppeling GET /app/intake in server.js (wv1244, OVIS M1d: Intake-plek met tellingen; ontwerplijnen
# § 2.1 rij Intake, Fable #19). Toetst: tellingen per bron en entiteit, vandaag en deze week (maandag, Amsterdam), raw_input wachtend,
# facturen-postvak met entiteit van de factuur, nieuwe aanleverweg; nooit een onderwerp, afzender, bestandsnaam of id in de uitvoer;
# vaste plek zonder privé (ook niet in de totalen); maillog onbereikbaar = die bron niet ok, de rest wel; uitrol.sh en Dockerfile.
# Gebruik: bash test/intake-telling.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 800) + ']' : '')); }
const T = require('./intake-telling.js');
const { DatabaseSync } = require('node:sqlite');
const GEHEIM = 'ZZgeheimZZ';

toets('1 maandag van de week', T.maandagVan('2026-10-28') === '2026-10-26' && T.maandagVan('2026-10-26') === '2026-10-26' && T.maandagVan('2026-11-01') === '2026-10-26');
toets('1b entiteitcodes gelijkgetrokken', T.entiteitCode('Praktijkhouders_BV') === 'phbv' && T.entiteitCode('GHAWA-ECG') === 'ghawa' && T.entiteitCode(null) === 'onbekend' && T.entiteitCode('a b') === 'onbekend' && T.entiteitCode('Tolgaarde') === 'tolgaarde');
toets('1c alleen vaste codes: een los woord (achternaam) wordt onbekend', T.entiteitCode('jansen') === 'onbekend' && T.entiteitCode('prive') === 'prive' && T.entiteitCode('_Gedeeld') === 'gedeeld');
// zomertijdwissel 25-10-2026 (02:00 CEST → 01:00 CET): 22:59Z = zondag 25-10, 23:00Z = maandag 26-10 (review #9)
toets('1d dag- en weekgrens rond de zomertijdwissel', T.dagVan(Date.parse('2026-10-25T22:59:00Z')) === '2026-10-25' && T.maandagVan(T.dagVan(Date.parse('2026-10-25T22:59:00Z'))) === '2026-10-19' &&
  T.dagVan(Date.parse('2026-10-25T23:00:00Z')) === '2026-10-26' && T.maandagVan(T.dagVan(Date.parse('2026-10-25T23:00:00Z'))) === '2026-10-26' && T.dagVan(Date.parse('2026-03-29T21:59:00Z')) === '2026-03-29' && T.dagVan(Date.parse('2026-03-29T22:00:00Z')) === '2026-03-30');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv1244-'));
const vault = path.join(tmp, 'vault');
for (const d of ['_INBOX', '20_Prive/raw_input', '10_Zakelijk/Tolgaarde/raw_input/sub', '10_Zakelijk/Praktijkhouders_BV/raw_input', '10_Zakelijk/Projecten/X/raw_input', '10_Zakelijk/Tolgaarde/Bronnen'])
  fs.mkdirSync(path.join(vault, d), { recursive: true });
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/raw_input', GEHEIM + '.pdf'), 'x');
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/raw_input/sub/b.md'), 'x');
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/raw_input/.verborgen'), 'x');
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/oud.md'), 'x');   // Bronnen telt niet
fs.writeFileSync(path.join(vault, '20_Prive/raw_input/p.md'), 'x');
fs.writeFileSync(path.join(vault, '10_Zakelijk/Praktijkhouders_BV/raw_input/q.md'), 'x');
fs.writeFileSync(path.join(vault, '_INBOX/i.md'), 'x');
const oud = path.join(vault, '10_Zakelijk/Projecten/X/raw_input/oud.md');
fs.writeFileSync(oud, 'x');

// facturen-postvak
const fpad = path.join(tmp, 'facturen.sqlite');
let db = new DatabaseSync(fpad);
db.exec(`CREATE TABLE bron (id TEXT PRIMARY KEY, soort TEXT, naam TEXT, actief INTEGER);
  CREATE TABLE bericht (id TEXT PRIMARY KEY, bron TEXT, message_id TEXT, afzender TEXT, onderwerp TEXT, ontvangen_op TEXT);
  CREATE TABLE factuur (id TEXT PRIMARY KEY, bericht TEXT, entiteit TEXT);
  INSERT INTO bron VALUES ('b1','verzamelpostvak','verzamelpostvak',1),('b2','upload','upload',1);`);
const NU = Date.parse('2026-10-28T10:00:00Z');   // woensdag
const iso = (ms) => new Date(ms).toISOString();
const ins = db.prepare('INSERT INTO bericht VALUES (?,?,?,?,?,?)');
ins.run('m1', 'b1', GEHEIM + 'id', GEHEIM + '@x.nl', 'Factuur ' + GEHEIM, iso(NU - 3600000));          // vandaag
ins.run('m2', 'b1', 'id2', 'a@b', 'x', iso(NU - 2 * 86400000));                                         // maandag
ins.run('m3', 'b1', 'id3', 'a@b', 'x', iso(NU - 4 * 86400000));                                         // vorige week
ins.run('m4', 'b2', 'id4', 'a@b', 'x', iso(NU - 3600000));                                              // upload: telt niet
db.exec("INSERT INTO factuur VALUES ('f1','m1','praktijkhouders_bv'),('f2','m2',NULL)");
db.close();

// nieuwe aanleverweg
const ipad = path.join(tmp, 'intake.sqlite');
db = new DatabaseSync(ipad);
db.exec('CREATE TABLE stuk (stuk_id TEXT, bron TEXT, versie INTEGER, meta TEXT, aangemaakt TEXT, bestandsnaam TEXT)');
const si = db.prepare('INSERT INTO stuk VALUES (?,?,?,?,?,?)');
si.run('s1', 'scanner:scansnap', 1, JSON.stringify({ afzender: GEHEIM, onderwerp: GEHEIM }), iso(NU - 60000), GEHEIM + '.pdf');
si.run('s2', 'gmail:david', 1, JSON.stringify({ entiteit: 'prive', van: GEHEIM }), iso(NU - 60000), null);
si.run('s3', 'gmail:david', 1, JSON.stringify({ entiteit: 'tolgaarde' }), iso(NU - 86400000), null);
si.run('s3', 'gmail:david', 2, JSON.stringify({ entiteit: 'tolgaarde' }), iso(NU - 60000), null);          // tweede versie: telt niet nog eens
si.run('s4', 'whatsapp:nl', 1, JSON.stringify({ entiteit: GEHEIM.toLowerCase() }), iso(NU - 60000), null);   // vrije tekst als entiteit
si.run('s5', 'raar bron ' + GEHEIM, 1, '{}', iso(NU - 60000), null);
db.close();

const rpcRijen = [
  { bron: 'nieuw', account: 'david', entiteit: 'tolgaarde', dag: '2026-10-28', aantal: 3 },
  { bron: 'nieuw', account: 'david', entiteit: 'prive', dag: '2026-10-28', aantal: 2 },
  { bron: 'nieuw', account: 'david', entiteit: 'tolgaarde', dag: '2026-10-26', aantal: 4 },
  { bron: 'nieuw', account: 'david', entiteit: 'tolgaarde', dag: '2026-10-25', aantal: 9 },   // vorige week (zondag)
  { bron: 'nieuw', account: 'groenhouten', entiteit: 'groenhouten', dag: '2026-10-27', aantal: 1 },
  { bron: 'outlook', account: 'outlook', entiteit: 'Inbox', dag: '2026-10-28', aantal: 5 },
  { bron: 'nieuw', account: GEHEIM, entiteit: 'Jansen', dag: '2026-10-28', aantal: 1 },   // onbekend account en een naam als entiteit
];
let rpcVraag = null;
const goedeRpc = async (fn, body) => { rpcVraag = { fn, body }; return rpcRijen; };

(async () => {
  // bestandstijden: geboortetijd is niet te zetten; zonder geboortetijd telt de wijzigingstijd. Daarom de klok op "nu" van het bestand
  // voor raw_input apart: hier toetsen we de pod-klok op NU voor de databanken en kijken we bij raw_input alleen naar wachtend.
  const t = T.maak({ vault, facturenPad: fpad, intakePad: ipad, rpc: goedeRpc, nu: () => NU });
  const uit = await t.telling(false);
  const tekst = JSON.stringify(uit);
  const b = (id) => uit.bronnen.find((x) => x.id === id);
  const e = (id, ent) => (b(id) && b(id).entiteiten.find((x) => x.entiteit === ent)) || null;
  toets('2 rpc ovis_intake_telling met p_van (ISO, ± 8 dagen)', rpcVraag && rpcVraag.fn === 'ovis_intake_telling' && Math.abs(Date.parse(rpcVraag.body.p_van) - (NU - 8 * 86400000)) < 1000, rpcVraag);
  toets('3 dag en week (maandag)', uit.vandaag === '2026-10-28' && uit.week_van === '2026-10-26', uit);
  toets('4 Gmail privé: vandaag 5, week 9 (zondag ervoor telt niet)', b('gmail:david').vandaag === 5 && b('gmail:david').week === 9, b('gmail:david'));
  toets('4b per entiteit: tolgaarde 3/7, prive 2/2', e('gmail:david', 'tolgaarde').vandaag === 3 && e('gmail:david', 'tolgaarde').week === 7 && e('gmail:david', 'prive').week === 2);
  toets('4c Gmail Groenhouten en Outlook (Inbox → inbox)', b('gmail:groenhouten').week === 1 && b('gmail:groenhouten').vandaag === 0 && e('outlook', 'inbox').vandaag === 5, uit.bronnen.map((x) => x.id));
  toets('5 facturen-postvak: vandaag 1, week 2, alleen verzamelpostvak', b('facturen-postvak').vandaag === 1 && b('facturen-postvak').week === 2, b('facturen-postvak'));
  toets('5b entiteit van de factuur (praktijkhouders_bv → phbv), anders onbekend', e('facturen-postvak', 'phbv').vandaag === 1 && e('facturen-postvak', 'onbekend').week === 1, b('facturen-postvak').entiteiten);
  toets('6 raw_input wachtend per entiteit (submap telt, verborgen en Bronnen niet)', e('raw_input', 'tolgaarde').wachtend === 2 && e('raw_input', 'phbv').wachtend === 1 && e('raw_input', 'inbox').wachtend === 1 && e('raw_input', 'projecten').wachtend === 1 && b('raw_input').wachtend === 6, b('raw_input'));
  toets('7b tweede versie telt niet, onbekende bron = overig, vrije-tekstentiteit = onbekend', b('intake:gmail:david').vandaag === 1 && !!b('intake:overig') && e('intake:whatsapp:nl', 'onbekend').vandaag === 1 &&
    b('gmail:overig') && e('gmail:overig', 'onbekend').vandaag === 1, uit.bronnen.map((x) => x.id));
  toets('7 nieuwe aanleverweg per bron, entiteit uit meta', b('intake:scanner:scansnap').vandaag === 1 && e('intake:scanner:scansnap', 'onbekend') && b('intake:gmail:david').vandaag === 1 && b('intake:gmail:david').week === 2, uit.bronnen.filter((x) => x.groep === 'ingang'));
  toets('8 geen onderwerp, afzender, bestandsnaam of id in de uitvoer', tekst.indexOf(GEHEIM) < 0 && !/onderwerp|afzender|bestandsnaam|message_id|"van"/.test(tekst));
  toets('8b alleen vaste velden per entiteitregel', b('raw_input').entiteiten.every((r) => Object.keys(r).every((k) => ['entiteit', 'vandaag', 'week', 'wachtend'].indexOf(k) >= 0)) &&
    uit.bronnen.every((x) => x.entiteiten.every((r) => typeof r.entiteit === 'string' && /^[a-z0-9_-]+$/.test(r.entiteit))));

  const vast = await t.telling(true);
  const vb = (id) => vast.bronnen.find((x) => x.id === id);
  toets('9 vaste plek: geen privé, ook niet in de totalen', vast.vaste_plek === true && JSON.stringify(vast).indexOf('"prive"') < 0 && vb('gmail:david').vandaag === 3 && vb('gmail:david').week === 7 && vb('raw_input').wachtend === 5 && vb('intake:gmail:david').vandaag === 0, vb('gmail:david'));
  toets('9b vaste plek: geen schaduwtelling van WhatsApp of Signal', !vb('intake:whatsapp:nl') && !!b('intake:whatsapp:nl'));

  // cache: binnen 60 s geen tweede meting
  let n = 0;
  const t2 = T.maak({ vault, facturenPad: fpad, intakePad: ipad, rpc: async () => { n++; return []; }, nu: () => NU });
  await Promise.all([t2.telling(false), t2.telling(true)]); await t2.telling(false);
  toets('10 cache: één meting voor twee gelijktijdige vragen en een derde erna', n === 1, n);

  // maillog onbereikbaar, geen facturen- of intakedatabank
  const t3 = T.maak({ vault, facturenPad: path.join(tmp, 'weg.sqlite'), intakePad: path.join(tmp, 'weg2.sqlite'), rpc: async () => { throw new Error('http 500'); }, nu: () => NU });
  const u3 = await t3.telling(false);
  const b3 = (id) => u3.bronnen.find((x) => x.id === id);
  toets('11 maillog stuk: Gmail en Outlook niet ok met melding, raw_input wel', b3('gmail:david').ok === false && b3('outlook').ok === false && /maillog/.test(b3('gmail:david').fout) && b3('raw_input').ok === true && b3('raw_input').wachtend === 6, u3.bronnen);
  toets('11b geen facturendatabank: niet ok, geen crash', b3('facturen-postvak').ok === false, b3('facturen-postvak'));
  const t4 = T.maak({ vault, facturenPad: fpad, intakePad: ipad, rpc: null, nu: () => NU });
  toets('11c zonder Supabase: mail niet ok', (await t4.telling(false)).bronnen.find((x) => x.id === 'outlook').ok === false);

  // raw_input vandaag/week: echte klok (bestanden zijn net gemaakt)
  const t5 = T.maak({ vault, facturenPad: fpad, intakePad: ipad, rpc: goedeRpc });
  const u5 = await t5.telling(false);
  const r5 = u5.bronnen.find((x) => x.id === 'raw_input');
  toets('12 raw_input: net aangekomen = vandaag en deze week', r5.vandaag === 6 && r5.week === 6, r5);

  // server.js, uitrol, Dockerfile
  const srv = fs.readFileSync('server.js', 'utf8');
  toets('13 route GET /app/intake in server.js', /route === 'GET \/app\/intake'\) return typeof appIntakeTelling === 'function'/.test(srv));
  toets('13b vaste plek doorgegeven, stil, grens', /T\.telling\(appAfscherm\(a\)\)/.test(srv) && /appTeller\('intake', 600, 3600000\)/.test(srv));
  toets('13c zonder module 404', /intake-telling ontbreekt/.test(srv));
  toets('14 uitrol.sh: intake-telling.js optioneel in de release', /^RELEASE_OPTIONEEL="[^"]*\bintake-telling\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  toets('15 Dockerfile: intake-telling.js in release-bootstrap', /COPY intake-telling\.js \/app\/release-bootstrap\/intake-telling\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
