#!/usr/bin/env bash
# Toetst brain-entiteiten.js en de koppeling GET /app/brain/entiteiten(/…) in server.js (wv1734, OVIS M5: Brain › Entiteiten & Personen;
# ontwerplijnen § 7). wv1930 ("Geen afscherming naar David", stap A) keerde de privacygrens om: alles voor David. Toetst: elke actieve
# knoop heeft een regel, ook personen met een privépagina; privépersonen uit 20_Prive (Familie, Gambia, Shizzle, Relaties) in de groep
# prive, de stamboom alleen via zoeken; medewerker met hele pagina, kenmerken, deadlines (ook HR) en Dossier (Gesprekken, Contracten,
# Bronnen op naam of alias, nieuwste eerst); IBAN onverkort en het gegenereerde blok op de pagina; Wat OVIS weet ook voor PRIVE; het
# sleutelmasker blijft; met de vaste-plekschakelaar aan alleen organisaties aan de zakelijke kant, IBAN van derden gemaskeerd, zonder
# facturen, deadlines of Dossier; facturen op naam/alias en knoop_id, zonder patiëntkenmerk; uitrol.sh, Dockerfile en CI.
# wv1771: contactgegevens uit Google alleen bij een persoon met een ACTIEVE Google-koppeling, niet op een vaste plek.
# Alle namen en nummers hieronder zijn verzonnen (openbare repo).
# Gebruik: bash test/brain-entiteiten.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 800) + ']' : '')); }
const B = require('./brain-entiteiten.js');
const { DatabaseSync } = require('node:sqlite');
const IBAN = 'NL00TEST0123456789';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv1734-'));
const vault = path.join(tmp, 'vault');
const zet = (rel, t) => { fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true }); fs.writeFileSync(path.join(vault, rel), t); };
zet('10_Zakelijk/Voorbeeld/Entiteit - VB.md', '---\ntype: entiteit\nentiteit_id: VB\nkvk: "00000000"\n---\n# Voorbeeldpraktijk\n\nEigen rekening ' + IBAN + '. Huur naar nl11 test 0000 1111 22.\n');
zet('10_Zakelijk/_Gedeeld/Relaties/Voorbeeld Energie.md', '---\ntype: entiteit\ncontact:\n  telefoon: "0300-000000"\n---\n# Voorbeeld Energie\n\nBetaal naar NL00 TEST 0123 4567 89 of [[10_Zakelijk/_Gedeeld/Relaties/Ander|de ander]].\n\n' +
  '<!-- ovis:blok begin id="org:voorbeeld-energie" content_hash="0000000000000000" -->\n## Wat OVIS van deze partij weet\n- Rekeningnummers (geaccepteerd): ' + IBAN + '\n<!-- ovis:blok eind -->\n\nNa het blok.\n');
zet('20_Prive/Relaties/Voorbeeld Streaming.md', '# Voorbeeld Streaming\n');
zet('20_Prive/Relaties/Jan Verzonnen.md', '# Jan Verzonnen\n');
const SLEUTEL = 'sk' + '-' + 'Verzonnen0Proef'.repeat(2);   // vorm van een API-sleutel, in de toets opgebouwd (openbare repo)
zet('10_Zakelijk/Voorbeeld/Medewerkers/Piet Verzonnen.md', '---\ntype: medewerker\naliases: ["Piet", "P. Verzonnen", "Pieter Verzonnen"]\n---\n# Piet Verzonnen\n\nContract en verzuim. Loon naar ' + IBAN + '. Sleutel ' + SLEUTEL + '. Portaal wachtwoord: Verzonnen0Proef12345.\n');
zet('10_Zakelijk/Voorbeeld/Medewerkers/Gesprekken/Piet Verzonnen/2026-09-10 - Verslag jaargesprek.md', '# Verslag\n');
zet('10_Zakelijk/Voorbeeld/Medewerkers/Gesprekken/Piet Verzonnen/2026-10-07 - Vervolggesprek.docx', 'x');
zet('10_Zakelijk/Voorbeeld/Medewerkers/Gesprekken/Klaas Ander/2026-10-08 - Gesprek.md', '# Ander\n');
zet('10_Zakelijk/Voorbeeld/Medewerkers/Contracten/Voorbeeld - Arbeidsovereenkomst (P. Verzonnen) - per 2026-09-07.docx', 'x');
zet('10_Zakelijk/Voorbeeld/Medewerkers/Contracten/Voorbeeld - Arbeidsovereenkomst (K. Ander).docx', 'x');
zet('10_Zakelijk/Voorbeeld/Bronnen/Medewerkers/Voorbeeld - 2023 - Evaluatie Pieter Verzonnen.pdf', 'x');
zet('10_Zakelijk/Voorbeeld/Bronnen/Voorbeeld - 2026-01-02 - Pietje Puk.pdf', 'x');
zet('10_Zakelijk/Ander/Bronnen/Ander - 2026-01-03 - Piet Verzonnen elders.pdf', 'x');
zet('10_Zakelijk/Voorbeeld/Bronnen/Voorbeeld - 2026-02-02 - Akte Notaris Verzonnen.pdf', 'x');
zet('10_Zakelijk/Los Verzonnen.md', '# Los Verzonnen\n');
// privépersonen (wv1930)
zet('20_Prive/Shizzle/Bram Verzonnen (Vriend).md', '---\ntype: persoon\naliases: ["Bram Verzonnen", "Bram"]\n---\n# Bram Verzonnen\n\nRekening ' + IBAN + '.\n');
zet('20_Prive/Shizzle/Bram Verzonnen (Vriend) - verbonden pagina\'s.md', '---\ntype: gegenereerd\n---\n# lijst\n');
zet('20_Prive/Shizzle/Kroniek verzonnen.md', '---\ntype: kroniek\n---\n# Kroniek\n');
zet('20_Prive/Familie/Tante Verzonnen.md', '---\ntype: persoon\nnaam: "Tante Verzonnen"\naliases:\n  - Tantje\n  - T. Verzonnen\n---\n# Tante\n');
zet('20_Prive/Familie/Stamboom/Henk Oudverzonnen.md', '---\ntype: persoon\nnaam: "Henk Oudverzonnen"\n---\n# Henk\n');
zet('20_Prive/Familie/Stamboom/Geertje Oudverzonnen.md', '---\ntype: persoon\n---\n# Geertje\n');
zet('20_Prive/Gambia/Personen/Lamin Verzonnen.md', '---\ntype: persoon\n---\n# Lamin\n');
zet('20_Prive/Bronnen/Shizzle/Prive - 2026-10-19 - Lied (Bram).md', '# lied\n');
zet('20_Prive/Bronnen/Shizzle/Shizzle - 2019-07-09 - Steekwoorden Bram Verzonnen.docx', 'x');
zet('20_Prive/Bronnen/Shizzle/Shizzle - 2019 - Bramsma.md', '# niet hij\n');
zet('10_Zakelijk/_Gedeeld/Relaties/Notaris Verzonnen.md', '# Notaris Verzonnen\n\nTekst.\n');

const knopen = [
  { id: 'VB', soort: 'entiteit', rol: 'eigen', naam: 'Voorbeeldpraktijk', vault_pagina: '10_Zakelijk/Voorbeeld/Entiteit - VB.md', iban: IBAN, actief: true, concept: false, voor: [] },
  { id: 'PRIVE', soort: 'entiteit', rol: 'eigen', naam: 'Privé', vault_pagina: '20_Prive/Entiteit - PRIVE.md', actief: true, voor: [] },
  { id: 'org:voorbeeld-energie', soort: 'organisatie', rol: 'leverancier', naam: 'Voorbeeld Energie', aliassen: ['VE Zakelijk'], vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Voorbeeld Energie.md', actief: true, concept: true, voor: ['VB', 'PRIVE'] },
  { id: 'org:voorbeeld-streaming', soort: 'organisatie', rol: 'leverancier', naam: 'Voorbeeld Streaming', vault_pagina: '20_Prive/Relaties/Voorbeeld Streaming.md', actief: true, voor: ['PRIVE'] },
  { id: 'org:weg', soort: 'organisatie', rol: 'instantie', naam: 'Opgeheven', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Opgeheven.md', actief: false },
  { id: 'per:kind-verzonnen', soort: 'persoon', rol: 'persoon', naam: 'Kind Verzonnen', vault_pagina: null, vault_pad: '20_Prive/Familie/Kind Verzonnen', actief: true },
  { id: 'per:vriend-verzonnen', soort: 'persoon', rol: 'persoon', naam: 'Vriend Verzonnen', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Vriend Verzonnen.md', voor: ['PRIVE'], actief: true },
  { id: 'per:jan-verzonnen', soort: 'persoon', rol: 'persoon', naam: 'Jan Verzonnen', vault_pagina: '20_Prive/Relaties/Jan Verzonnen.md', actief: true },
  { id: 'per:piet-verzonnen', soort: 'persoon', rol: 'persoon', naam: 'Piet Verzonnen', vault_pagina: '10_Zakelijk/Voorbeeld/Medewerkers/Piet Verzonnen.md', actief: true, opmerking: 'contract tot later, ziek sinds gisteren', kvk: '99999999' },
  { id: 'per:notaris-verzonnen', soort: 'persoon', rol: 'afzender', naam: 'Notaris Verzonnen', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Notaris Verzonnen.md', actief: true, voor: ['VB'] },
  { id: 'org:kapot', soort: 'organisatie', rol: 'bank', naam: 'Kapotte Pagina', vault_pagina: '../buiten.md', actief: true },
  { id: 'per:oud-tante', soort: 'persoon', rol: 'persoon', naam: 'Tante (oude knoop)', vault_pagina: '20_Prive/Familie/Tante Verzonnen.md', actief: false },
  { id: 'per:los-verzonnen', soort: 'persoon', rol: 'persoon', naam: 'Los Verzonnen', vault_pagina: '10_Zakelijk/Los Verzonnen.md', actief: true },
];
const handvatten = [
  { knoop: 'org:voorbeeld-energie', soort: 'domein', waarde: 'voorbeeld-energie.nl', status: 'actief' },
  { knoop: 'org:voorbeeld-energie', soort: 'alias', waarde: 'Voorbeeld Energie Levering', status: 'voorgesteld' },
  { knoop: 'org:voorbeeld-energie', soort: 'mail', waarde: 'oud@voorbeeld-energie.nl', status: 'vervallen' },
  { knoop: 'org:kapot', soort: 'kenmerkpatroon', waarde: 'NL00TEST0123456789', status: 'voorgesteld' },
  { knoop: 'per:piet-verzonnen', soort: 'mail', waarde: 'piet@verzonnen.nl', status: 'actief' },
  { knoop: 'per:piet-verzonnen', soort: 'google', waarde: 'people/c111', waarde_norm: 'people/c111', status: 'actief' },
  { knoop: 'per:notaris-verzonnen', soort: 'google', waarde: 'people/c222', waarde_norm: 'people/c222', status: 'actief' },
  { knoop: 'per:notaris-verzonnen', soort: 'telefoon', waarde: '0600000001', waarde_norm: '0600000001', status: 'voorgesteld' },
];
const contacten = [
  { r: 'people/c111', mail: ['piet@verzonnen.nl'], tel: ['+31600000009'] },
  { r: 'people/c222', mail: ['Notaris@Verzonnen.nl', 'notaris@verzonnen.nl', 'geen-adres', 'x@verzonnen.nl?bcc=y@verzonnen.nl'], tel: ['+31 6 0000 0001', '+220 700 0000', '12'] },
];
let googleVraag = [], googleFout = false;
let rpcAanroepen = 0, rpcFout = false;
const rpc = async (fn, body) => {
  if (fn === 'ovis_personen_lees') { googleVraag.push(body.p_resource); if (googleFout) throw new Error('weg'); return { entity: [], contacten: contacten.filter((c) => body.p_resource.includes(c.r)) }; }
  rpcAanroepen++; if (rpcFout) throw new Error('weg'); if (fn !== 'ovis_register_lees') throw new Error('onverwacht ' + fn); return { knopen, handvatten, contact: [] };
};

// facturen
const fpad = path.join(tmp, 'facturen.sqlite');
const db = new DatabaseSync(fpad);
db.exec('CREATE TABLE leverancier (id INTEGER PRIMARY KEY, naam TEXT, knoop_id TEXT); CREATE TABLE factuur (id INTEGER PRIMARY KEY, leverancier INTEGER, entiteit TEXT, factuurdatum TEXT, incl_eur INTEGER, status TEXT, patientkenmerk INTEGER, intern INTEGER, alleen_eigenaar INTEGER); ' +
  'CREATE TABLE factuur_archief (id INTEGER PRIMARY KEY, leverancier_naam TEXT, entiteit TEXT, factuurdatum TEXT, incl INTEGER, status TEXT, alleen_eigenaar INTEGER);');
db.exec("INSERT INTO leverancier VALUES (1, 'Voorbeeld Energie Levering', NULL), (2, 'Iets Anders', 'org:voorbeeld-energie'), (3, 'Niemand', NULL), (4, 'Piet Verzonnen', 'per:piet-verzonnen')");
db.exec("INSERT INTO factuur VALUES (9, 4, 'tolgaarde', '2026-10-02', 300000, 'beslist', 0, 0, 0), (1, 1, 'tolgaarde', '2026-10-01', 12345, 'beslist', 0, 0, 0), (2, 2, 'tolgaarde', '2026-10-05', 500, 'beslist', 0, 0, 1), (3, 1, 'tolgaarde', '2026-10-06', 999, 'beslist', 1, 0, 0), (4, 3, 'tolgaarde', '2026-10-07', 1, 'beslist', 0, 0, 0)");
db.exec("INSERT INTO factuur_archief VALUES (1, 'VE Zakelijk', 'tolgaarde', '2026-05-01', 700, 'beslist', 1), (2, 'Niemand', 'tolgaarde', '2026-05-02', 1, 'beslist', 1)");
db.close();

const deadlines = () => [
  { ents: ['PRIVE'], dagen: 5, datum: '2026-11-01', titel: 'Verjaardag familielid (verzonnen)', hr: false },
  { ents: ['VB'], dagen: 10, datum: '2026-11-06', titel: 'Aangifte omzetbelasting', hr: false },
  { ents: ['VB'], dagen: 12, datum: '2026-11-08', titel: 'Aanzegging contract medewerker', hr: true },
  { ents: ['VB'], dagen: 20, datum: '2026-11-16', titel: 'Jaargesprek Piet Verzonnen', hr: true, bron: { pad: null } },
  { ents: ['PRIVE'], dagen: 30, datum: '2026-11-26', titel: 'Verjaardag', hr: true, bron: { pad: '20_Prive/Familie/Tante Verzonnen' } },
  { ents: ['VB'], dagen: -30, datum: '2026-09-27', titel: 'Lang verlopen', hr: false },
];
// de Second Brain-kaart: alle bestanden in de vault ({p, s, m})
const kaartLijst = [];
(function wandel(d) { for (const n of fs.readdirSync(path.join(vault, d))) { const r = d ? d + '/' + n : n, st = fs.statSync(path.join(vault, r)); if (st.isDirectory()) wandel(r); else kaartLijst.push({ p: r, s: (/\.([a-z0-9]+)$/i.exec(n) || [0, ''])[1].toLowerCase(), m: st.mtimeMs }); } })('');
let kaartWeg = false;
// het masker van productie: appSleutelMasker (geknipt uit server.js) over secondbrain.masker, precies zoals brainEntMaak het doorgeeft (review ZOU 3)
const srv0 = fs.readFileSync('server.js', 'utf8');
const knip = srv0.slice(srv0.indexOf('const APP_SLEUTEL_WEG'), srv0.indexOf('appStaat.tellers.voorjou = '));
const maskerRegel = /masker: (function \(t\) \{ return appSleutelMasker\(SB_MASKER \? SB_MASKER\(t, false\) : t\); \}),/.exec(srv0);
const vmctx = { SB_MASKER: require('./secondbrain.js').masker }; require('vm').createContext(vmctx);
require('vm').runInContext(knip + ';globalThis.__m = ' + (maskerRegel ? maskerRegel[1] : 'null') + ';', vmctx);
const masker = vmctx.__m;
const T = B.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), facturenPad: fpad, deadlines, masker, kaart: () => (kaartWeg ? null : kaartLijst), nu: () => Date.parse('2026-10-27T12:00:00Z') });

(async () => {
  const l = await T.lijst(false), v = await T.lijst(true);
  const ids = l.knopen.map((k) => k.id), vids = v.knopen.map((k) => k.id);
  const regIds = ['VB', 'PRIVE', 'org:voorbeeld-energie', 'org:voorbeeld-streaming', 'per:piet-verzonnen', 'per:notaris-verzonnen', 'org:kapot', 'per:kind-verzonnen', 'per:vriend-verzonnen', 'per:jan-verzonnen', 'per:los-verzonnen'];
  toets('1 elke actieve knoop heeft een regel, ook personen met een privépagina of alleen voor PRIVE', regIds.every((i) => ids.includes(i)), ids);
  const pv = l.knopen.filter((k) => k.groep === 'prive');
  toets('2 privépersonen uit 20_Prive in de groep prive (Familie, Gambia, Shizzle), geen gegenereerde of kroniekpagina', JSON.stringify(pv.map((k) => k.naam).sort()) === JSON.stringify(['Bram Verzonnen (Vriend)', 'Lamin Verzonnen', 'Tante Verzonnen']) && l.groepen.prive === 3, pv.map((k) => k.naam));
  toets('2b privépagina die al een knoop heeft niet dubbel (Jan Verzonnen alleen als knoop)', l.knopen.filter((k) => k.naam === 'Jan Verzonnen').length === 1 && l.totaal === regIds.length + 3, l.totaal);
  toets('2c stamboom niet in de standaardlijst, wel geteld', !JSON.stringify(l).includes('Oudverzonnen') && l.stamboom === 2, l.stamboom);
  const sv = pv.find((k) => k.naam.startsWith('Bram'));
  toets('2d privépersoon: eigen sleutel (12 hex van het pad), aliassen uit de frontmatter, voor PRIVE', sv.sleutel === B.sleutelVan('20_Prive/Shizzle/Bram Verzonnen (Vriend).md') && sv.aliassen.includes('Bram') && sv.voor.join() === 'PRIVE' && sv.prive === true && sv.register === false, sv);
  toets('2e aliassen als lijst met streepjes', pv.find((k) => k.naam === 'Tante Verzonnen').aliassen.join('|') === 'Tantje|T. Verzonnen');
  toets('3 inactieve knoop niet', !ids.includes('org:weg'));
  toets('4 vaste-plekschakelaar: alleen organisaties aan de zakelijke kant, geen privépersonen, geen stamboom', JSON.stringify(vids.sort()) === JSON.stringify(['VB', 'org:kapot', 'org:voorbeeld-energie'].sort()) && v.vaste_plek === true && v.stamboom === 0, vids);
  toets('4b vaste plek: PRIVE niet in voor', v.knopen.find((k) => k.id === 'org:voorbeeld-energie').voor.join() === 'VB');
  toets('5 eigen entiteiten bovenaan, groepen geteld', l.knopen[0].groep === 'eigen' && l.groepen.persoon === 6 && l.groepen.eigen === 2 && l.groepen.instantie === 1, l.groepen);
  toets('6 register één keer gelezen (cache)', rpcAanroepen === 1, rpcAanroepen);

  const z = await T.zoek('oudverzonnen', false), z1 = await T.zoek('henk-oud', false), z0 = await T.zoek('h', false), zv = await T.zoek('oudverzonnen', true);
  toets('6b stamboom via zoeken (≥ 2 tekens, ook met streepjes), niet op een vaste plek', z.totaal === 2 && z.knopen.every((k) => k.groep === 'prive' && k.rol === 'stamboom') && z1.totaal === 1 && z0.totaal === 0 && zv.totaal === 0, [z, z1]);
  const hd = await T.detail(z1.knopen[0].sleutel, false);
  toets('6c stamboompersoon openen op zijn sleutel: pagina zonder frontmatter', hd.status === 200 && /# Henk/.test(hd.j.tekst) && !/type: persoon/.test(hd.j.tekst) && hd.j.knoop.groep === 'prive', hd.j);

  const d = await T.detail('org:voorbeeld-energie', false);
  toets('7 detail: pagina zonder frontmatter, gegenereerd blok terug (zonder markeringen), tekst na het blok blijft', d.status === 200 && !/type: entiteit|0300-000000/.test(d.j.tekst) && /Wat OVIS van deze partij weet/.test(d.j.tekst) && !/ovis:blok/.test(d.j.tekst) && /Na het blok\./.test(d.j.tekst), d.j.tekst);
  toets('8 detail: rekeningnummer onverkort (ook met spaties), nergens gemaskeerd', /NL00 TEST 0123 4567 89/.test(d.j.tekst) && d.j.tekst.includes(IBAN) && !/\[rekeningnummer\]/.test(JSON.stringify(d.j)), d.j.tekst);
  toets('9 wikilink als tekst', /of de ander\./.test(d.j.tekst));
  toets('10 kenmerken: vervallen eruit, status in woorden', d.j.weet.handvatten.length === 2 && d.j.weet.handvatten.some((h) => h.status === 'wacht op je Ja') && !JSON.stringify(d.j).includes('oud@'), d.j.weet.handvatten);
  const f = d.j.weet.facturen;
  toets('11 facturen: alias + knoop_id + archief op alias, zonder patiëntkenmerk, niet op andermans naam', f && f.aantal === 3 && f.laatste[0].datum === '2026-10-05' && f.laatste[0].bedrag_cent === 500 && !f.laatste.some((x) => x.bedrag_cent === 999 || x.bedrag_cent === 1), f);
  toets('11b facturen zonder leveranciersnaam', !/Levering|Iets Anders|Niemand/.test(JSON.stringify(f)));
  toets('11c organisatie: geen Dossier', d.j.dossier === null);

  const e = await T.detail('VB', false);
  toets('12 eigen entiteit: alle rekeningnummers onverkort, iban uit het register in Wat OVIS weet', e.status === 200 && e.j.tekst.includes(IBAN) && /nl11 test 0000 1111 22/.test(e.j.tekst) && e.j.weet.iban === IBAN, e.j);
  const pr = await T.detail('PRIVE', false);
  toets('12b PRIVE: Wat OVIS weet met deadlines (ook HR)', Array.isArray(pr.j.weet.deadlines) && pr.j.weet.deadlines.length === 2 && pr.j.weet.deadlines[0].titel.includes('familielid') && pr.j.weet.deadlines[1].hr === true, pr.j.weet.deadlines);
  toets('13 deadlines: ook HR, niet lang verlopen', e.j.weet.deadlines.length === 3 && e.j.weet.deadlines.some((x) => x.hr && /Aanzegging/.test(x.titel)) && !e.j.weet.deadlines.some((x) => /Lang verlopen/.test(x.titel)), e.j.weet.deadlines);
  toets('13b facturen van een eigen entiteit zonder code-afbeelding: 0', e.j.weet.facturen && e.j.weet.facturen.aantal === 0, e.j.weet.facturen);

  const vd = await T.detail('org:voorbeeld-energie', true), ve = await T.detail('VB', true);
  toets('14 vaste plek: geen facturen, geen deadlines, blok weg, IBAN van een derde gemaskeerd, eigen IBAN niet', vd.status === 200 && vd.j.weet.facturen === null && vd.j.weet.deadlines === null && !/Wat OVIS van deze/.test(vd.j.tekst) && !/NL00 ?TEST/.test(vd.j.tekst) && ve.j.tekst.includes(IBAN) && /Huur naar \[rekeningnummer\]/.test(ve.j.tekst) && ve.j.weet.iban === null, [vd.j.tekst, ve.j.tekst]);
  toets('15 vaste plek: privékant, personen en privépersonen 404', (await T.detail('org:voorbeeld-streaming', true)).status === 404 && (await T.detail('PRIVE', true)).status === 404 && (await T.detail('per:notaris-verzonnen', true)).status === 404 && (await T.detail(sv.sleutel, true)).status === 404);
  toets('16 persoon met privépagina in het register: zichtbaar met pagina', (await T.detail('per:jan-verzonnen', false)).j.tekst === '# Jan Verzonnen');

  const m = await T.detail('per:piet-verzonnen', false), mj = JSON.stringify(m.j);
  toets('17 medewerker: hele pagina, opmerking, kenmerken, KvK — geen stamregel meer', m.status === 200 && /Contract en verzuim/.test(m.j.tekst) && m.j.knoop.opmerking === 'contract tot later, ziek sinds gisteren' && m.j.weet.kvk === '99999999' && m.j.weet.handvatten.length === 2 && !/stamregel/.test(mj), m.j);
  toets('17a medewerker: IBAN onverkort, sleutel en wachtwoord gemaskeerd (masker van productie)', typeof masker === 'function' && m.j.tekst.includes(IBAN) && !mj.includes(SLEUTEL) && !mj.includes('Verzonnen0Proef12345') && /\[sleutel weggelaten\]/.test(m.j.tekst), m.j.tekst);
  const ds = m.j.dossier;
  toets('17b Dossier: gesprekkenmap, contract en bron op naam of alias, nieuwste eerst; niet van een ander, niet Pietje, niet een andere entiteit', ds && ds.totaal === 4 &&
    JSON.stringify(ds.stukken.map((x) => x.soort)) === JSON.stringify(['gesprek', 'gesprek', 'contract', 'bron']) && ds.stukken[0].datum === '2026-10-07' && ds.stukken[0].ext === 'docx' &&
    ds.stukken[3].datum === '2023' && !/Klaas|Ander|Pietje|elders/.test(JSON.stringify(ds)), ds);
  toets('17c Dossier: pad en titel, de app opent het pad', ds.stukken.every((x) => x.pad.startsWith('10_Zakelijk/Voorbeeld/') && x.titel && !x.pad.includes('..')) && ds.stukken[2].titel === 'Voorbeeld - Arbeidsovereenkomst (P. Verzonnen) - per 2026-09-07', ds.stukken);
  toets('17d medewerker: deadlines met HR op zijn naam', Array.isArray(m.j.weet.deadlines) && m.j.weet.deadlines.length === 1 && m.j.weet.deadlines[0].titel === 'Jaargesprek Piet Verzonnen' && m.j.weet.deadlines[0].hr === true, m.j.weet.deadlines);
  toets('17e medewerker: Google-contact', m.j.weet.contact && JSON.stringify(m.j.weet.contact.telefoons) === '["0600000009"]' && googleVraag.some((x) => x.includes('people/c111')), m.j.weet.contact);
  toets('17f medewerker: facturen op knoop_id', m.j.weet.facturen && m.j.weet.facturen.aantal === 1 && m.j.weet.facturen.laatste[0].bedrag_cent === 300000, m.j.weet.facturen);

  const s = await T.detail(sv.sleutel, false);
  toets('18 privépersoon: hele pagina (IBAN onverkort), Dossier uit 20_Prive/Bronnen op naam en alias, niet "Bramsma"', s.status === 200 && s.j.tekst.includes(IBAN) && s.j.dossier.totaal === 2 &&
    s.j.dossier.stukken[0].titel === 'Prive - 2026-10-19 - Lied (Bram)' && !/Bramsma/.test(JSON.stringify(s.j.dossier)) && s.j.knoop.pagina_pad === '20_Prive/Shizzle/Bram Verzonnen (Vriend).md' && s.j.weet.in_register === false && s.j.weet.register && s.j.weet.handvatten.length === 0, s.j);
  const ta = await T.detail(B.sleutelVan('20_Prive/Familie/Tante Verzonnen.md'), false);
  toets('18c privépagina met een inactieve knoop: staat er toch (als privépersoon)', pv.some((k) => k.naam === 'Tante Verzonnen') && !ids.includes('per:oud-tante'));
  const nd = await T.detail('per:notaris-verzonnen', false), ld = await T.detail('per:los-verzonnen', false);
  toets('18d Dossier ook in de map van elke entiteit in voor; persoon zonder entiteitmap: melding', nd.j.dossier.totaal === 1 && /Akte Notaris/.test(nd.j.dossier.stukken[0].titel) && ld.j.dossier.fout && ld.j.dossier.totaal === 0, [nd.j.dossier, ld.j.dossier]);
  toets('18b privépersoon: deadline op de pagina als bron', ta.j.weet.deadlines.length === 1 && ta.j.weet.deadlines[0].titel === 'Verjaardag', ta.j.weet.deadlines);

  const n = await T.detail('per:notaris-verzonnen', false);
  toets('19 persoon met actieve Google-koppeling: mailadressen en telefoons uit Google (genormaliseerd, uniek, ongeldig eruit)', n.status === 200 && n.j.weet.contact &&
    n.j.weet.contact.bron === 'Google' && JSON.stringify(n.j.weet.contact.mailadressen) === '["notaris@verzonnen.nl"]' &&
    JSON.stringify(n.j.weet.contact.telefoons) === '["0600000001","002207000000"]', n.j.weet.contact);
  toets('19b organisatie: geen contact uit Google', d.j.weet.contact === null && e.j.weet.contact === null);
  const h0 = handvatten.find((h) => h.soort === 'google' && h.knoop === 'per:notaris-verzonnen');
  h0.status = 'voorgesteld'; T.vergeet();
  toets('19c Google-koppeling die nog op Davids Ja wacht: geen contactgegevens', (await T.detail('per:notaris-verzonnen', false)).j.weet.contact === null);
  h0.status = 'actief'; T.vergeet(); googleFout = true;
  const nf = await T.detail('per:notaris-verzonnen', false);
  toets('19d Google niet te lezen: melding, rest van het detail blijft', nf.status === 200 && nf.j.weet.contact && nf.j.weet.contact.fout && !nf.j.weet.contact.telefoons && nf.j.tekst !== null, nf.j.weet.contact);
  googleFout = false; h0.waarde_norm = 'people/c333'; T.vergeet();
  const nw = await T.detail('per:notaris-verzonnen', false);
  toets('19e gekoppeld contact bestaat niet meer: melding, geen gegevens van een ander contact', nw.j.weet.contact && /bestaat niet meer/.test(nw.j.weet.contact.fout) && !/0600000001/.test(JSON.stringify(nw.j.weet.contact)), nw.j.weet.contact);
  h0.waarde_norm = 'people/c222'; T.vergeet();
  toets('19f telNl', B.telNl('+31 (0)6-1234 5678') === '0612345678' && B.telNl('0031 6 1234 5678') === '0612345678' && B.telNl('+220 712 3456') === '002207123456');
  const k = await T.detail('org:kapot', false);
  toets('20 pagina buiten de vault: niet gelezen', k.status === 200 && k.j.tekst === null && k.j.knoop.pagina_pad === null);
  toets('20a onbekende id of sleutel 404', (await T.detail('org:bestaat-niet', false)).status === 404 && (await T.detail('0123456789ab', false)).status === 404);
  T.vergeet(); rpcFout = true;
  let gooit = false; try { await T.lijst(false); } catch (x) { gooit = true; }
  toets('20b register weg: fout (route geeft 503), geen oude lijst', gooit);
  rpcFout = false; T.vergeet(); kaartWeg = true;
  const lk = await T.lijst(false), mk = await T.detail('per:piet-verzonnen', false);
  toets('20c kaart weg: register-lijst blijft, melding; Dossier leeg met melding', lk.totaal === regIds.length && lk.prive_fout && mk.j.dossier.fout && mk.j.tekst !== null, [lk.prive_fout, mk.j.dossier]);
  kaartWeg = false; T.vergeet();
  const sl = l.knopen.find((k) => k.id === 'org:voorbeeld-energie').sleutel;
  toets('20d detail op de sleutel uit de lijst (12 hex), past in APP_ROUTE_RE', /^[0-9a-f]{12}$/.test(sl) && (await T.detail(sl, false)).j.knoop.id === 'org:voorbeeld-energie' && /^\/app\/[a-z0-9/-]{1,64}$/.test('/app/brain/entiteit/' + sl));
  toets('21 naamPatronen: één woord pas vanaf 4 letters, haakjes eraf', JSON.stringify(B.naamPatronen(['Bram Proefsen (Bijnaam)', 'Jo', 'K. Verzonnen', 'Kees']).sort()) === JSON.stringify(['bram proefsen', 'bram proefsen bijnaam', 'k verzonnen', 'kees']), B.naamPatronen(['Bram Proefsen (Bijnaam)', 'Jo', 'K. Verzonnen', 'Kees']));
  toets('21b bevatNaam: hele woorden, zonder accenten', B.bevatNaam('Voorbeeld - Jaargesprek Daniëlle van der Proef', ['danielle van der proef']) && !B.bevatNaam('Akeesje', ['kees']));

  const srv = fs.readFileSync('server.js', 'utf8');
  toets('22 server.js: routes (ook zoeken), vaste plek uit de schakelaar, sleutelmasker en kaart mee', /route === 'GET \/app\/brain\/entiteiten' \|\| route\.indexOf\('GET \/app\/brain\/entiteit\/'\) === 0 \|\| route\.indexOf\('GET \/app\/brain\/entiteiten\/zoek\/'\) === 0/.test(srv) && /B\.detail\(id, vast\)/.test(srv) && /B\.zoek\(q, vast\)/.test(srv) &&
    /const vast = appAfscherm\(a\);   \/\/ wv1901/.test(srv) && !!maskerRegel && /kaart: function \(\) \{ const k = secondbrain && secondbrain\.vers\(false\)/.test(srv));
  toets('23 uitrol.sh, Dockerfile en CI kennen brain-entiteiten', /RELEASE_OPTIONEEL="[^"]*\bbrain-entiteiten\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
    /COPY brain-entiteiten\.js \/app\/release-bootstrap\/brain-entiteiten\.js/.test(fs.readFileSync('Dockerfile', 'utf8')) && /test\/brain-entiteiten\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('FOUT', e); process.exit(1); });
JS
