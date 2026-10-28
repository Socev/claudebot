#!/usr/bin/env bash
# Toetst brain-entiteiten.js en de koppeling GET /app/brain/entiteiten(/…) in server.js (wv1734, OVIS M5: Brain › Entiteiten & Personen;
# ontwerplijnen § 7). Toetst: elke zichtbare knoop heeft een regel; privépersonen nooit; vaste plek alleen organisaties aan de zakelijke
# kant en zonder facturen of deadlines; geen rekeningnummer (blok weg, IBAN gemaskeerd, iban-veld niet mee); frontmatter weg; HR-deadlines
# niet mee; facturen op naam/alias en knoop_id, zonder patiëntkenmerk; medewerker alleen stamregel; uitrol.sh, Dockerfile en CI.
# wv1771: contactgegevens uit Google alleen bij een persoon met een ACTIEVE Google-koppeling, nooit voor een medewerker of op een vaste plek.
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
zet('10_Zakelijk/Voorbeeld/Medewerkers/Piet Verzonnen.md', '# Piet Verzonnen\n\nContract en verzuim.\n');
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
  { id: 'per:notaris-verzonnen', soort: 'persoon', rol: 'afzender', naam: 'Notaris Verzonnen', vault_pagina: '10_Zakelijk/_Gedeeld/Relaties/Notaris Verzonnen.md', actief: true },
  { id: 'org:kapot', soort: 'organisatie', rol: 'bank', naam: 'Kapotte Pagina', vault_pagina: '../buiten.md', actief: true },
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
  { ents: ['VB'], dagen: -30, datum: '2026-09-27', titel: 'Lang verlopen', hr: false },
];
const T = B.maak({ rpc, vault, lees: (p) => fs.readFileSync(p, 'utf8'), facturenPad: fpad, deadlines, nu: () => Date.parse('2026-10-27T12:00:00Z') });

(async () => {
  const l = await T.lijst(false), v = await T.lijst(true);
  const ids = l.knopen.map((k) => k.id), vids = v.knopen.map((k) => k.id);
  toets('1 elke actieve knoop (behalve privépersoon) heeft een regel', ['VB', 'PRIVE', 'org:voorbeeld-energie', 'org:voorbeeld-streaming', 'per:piet-verzonnen', 'per:notaris-verzonnen', 'org:kapot'].every((i) => ids.includes(i)) && l.totaal === 7, ids);
  toets('2b persoon zonder zakelijke pagina (vault_pad privé, of alleen voor PRIVE): nooit (witte lijst)', !ids.includes('per:kind-verzonnen') && !ids.includes('per:vriend-verzonnen') && (await T.detail('per:kind-verzonnen', false)).status === 404);
  toets('2 privépersoon nooit, ook niet op de telefoon', !ids.includes('per:jan-verzonnen') && !JSON.stringify(l).includes('Jan Verzonnen'));
  toets('3 inactieve knoop niet', !ids.includes('org:weg'));
  toets('4 vaste plek: alleen organisaties aan de zakelijke kant', JSON.stringify(vids.sort()) === JSON.stringify(['VB', 'org:kapot', 'org:voorbeeld-energie'].sort()) && v.vaste_plek === true, vids);
  toets('4b vaste plek: PRIVE niet in voor', v.knopen.find((k) => k.id === 'org:voorbeeld-energie').voor.join() === 'VB');
  toets('5 eigen entiteiten bovenaan, groepen geteld', l.knopen[0].groep === 'eigen' && l.groepen.persoon === 2 && l.groepen.eigen === 2 && l.groepen.instantie === 1, l.groepen);
  toets('6 lijst draagt geen rekeningnummer', !/NL00/.test(JSON.stringify(l)) && !('iban' in l.knopen[0]));
  toets('6b register één keer gelezen (cache)', rpcAanroepen === 1, rpcAanroepen);

  const d = await T.detail('org:voorbeeld-energie', false);
  const dj = JSON.stringify(d.j);
  toets('7 detail: stampagina zonder frontmatter, blok weg, tekst na het blok blijft', d.status === 200 && !/type: entiteit|0300-000000/.test(d.j.tekst) && !/ovis:blok|Wat OVIS van deze/.test(d.j.tekst) && /Na het blok\./.test(d.j.tekst), d.j.tekst);
  toets('8 detail: geen rekeningnummer (gemaskeerd, ook met spaties)', !/NL00 ?TEST/.test(dj) && /\[rekeningnummer\]/.test(d.j.tekst), d.j.tekst);
  toets('9 wikilink als tekst', /of de ander\./.test(d.j.tekst));
  toets('10 kenmerken: vervallen eruit, status in woorden', d.j.weet.handvatten.length === 2 && d.j.weet.handvatten.some((h) => h.status === 'wacht op je Ja') && !dj.includes('oud@'), d.j.weet.handvatten);
  const f = d.j.weet.facturen;
  toets('11 facturen: alias + knoop_id + archief op alias, zonder patiëntkenmerk, niet op andermans naam', f && f.aantal === 3 && f.laatste[0].datum === '2026-10-05' && f.laatste[0].bedrag_cent === 500 && !f.laatste.some((x) => x.bedrag_cent === 999 || x.bedrag_cent === 1), f);
  toets('11b facturen zonder leveranciersnaam', !/Levering|Iets Anders|Niemand/.test(JSON.stringify(f)));

  const e = await T.detail('VB', false);
  toets('12 eigen entiteit: eigen rekening niet gemaskeerd, die van een derde (kleine letters, spaties) wel; iban-veld niet mee', e.status === 200 && e.j.tekst.includes(IBAN) && !/nl11/i.test(e.j.tekst) && /Huur naar \[rekeningnummer\]/.test(e.j.tekst) && !('iban' in e.j.knoop) && !('iban' in e.j.weet), e.j.tekst);
  toets('12b PRIVE: geen deadlines (gezin, familie)', (await T.detail('PRIVE', false)).j.weet.deadlines === null);
  toets('13 deadlines: geen HR, niet lang verlopen', e.j.weet.deadlines.length === 1 && e.j.weet.deadlines[0].titel === 'Aangifte omzetbelasting', e.j.weet.deadlines);
  toets('13b facturen van een eigen entiteit zonder code-afbeelding: 0', e.j.weet.facturen && e.j.weet.facturen.aantal === 0, e.j.weet.facturen);

  const vd = await T.detail('org:voorbeeld-energie', true);
  toets('14 vaste plek: geen facturen, geen deadlines', vd.status === 200 && vd.j.weet.facturen === null && vd.j.weet.deadlines === null);
  toets('15 vaste plek: privékant en personen 404', (await T.detail('org:voorbeeld-streaming', true)).status === 404 && (await T.detail('PRIVE', true)).status === 404 && (await T.detail('per:notaris-verzonnen', true)).status === 404);
  toets('16 privépersoon 404, ook op de telefoon', (await T.detail('per:jan-verzonnen', false)).status === 404);
  const m = await T.detail('per:piet-verzonnen', false);
  toets('17 medewerker: alleen stamregel — geen pagina, opmerking, kenmerken, KvK of facturen', m.status === 200 && m.j.tekst === null && !/Contract en verzuim|ziek|contract tot|piet@|99999999/.test(JSON.stringify(m.j)) && m.j.weet.facturen === null && m.j.weet.handvatten.length === 0, m.j);
  toets('17c medewerker: geen Google-gegevens en geen Google-vraag', m.j.weet.contact === null && !googleVraag.some((x) => x.includes('people/c111')) && !/0600000009/.test(JSON.stringify(m.j)), googleVraag);
  const n = await T.detail('per:notaris-verzonnen', false);
  toets('17d persoon met actieve Google-koppeling: mailadressen en telefoons uit Google (genormaliseerd, uniek, ongeldig eruit)', n.status === 200 && n.j.weet.contact &&
    n.j.weet.contact.bron === 'Google' && JSON.stringify(n.j.weet.contact.mailadressen) === '["notaris@verzonnen.nl"]' &&
    JSON.stringify(n.j.weet.contact.telefoons) === '["0600000001","002207000000"]' && JSON.stringify(googleVraag) === '[["people/c222"]]', n.j.weet.contact);
  toets('17e organisatie: geen contact uit Google', d.j.weet.contact === null && e.j.weet.contact === null);
  const h0 = handvatten.find((h) => h.soort === 'google' && h.knoop === 'per:notaris-verzonnen');
  h0.status = 'voorgesteld'; T.vergeet();
  toets('17f Google-koppeling die nog op Davids Ja wacht: geen contactgegevens', (await T.detail('per:notaris-verzonnen', false)).j.weet.contact === null);
  h0.status = 'actief'; T.vergeet(); googleFout = true;
  const nf = await T.detail('per:notaris-verzonnen', false);
  toets('17g Google niet te lezen: melding, rest van het detail blijft', nf.status === 200 && nf.j.weet.contact && nf.j.weet.contact.fout && !nf.j.weet.contact.telefoons && nf.j.tekst !== null, nf.j.weet.contact);
  googleFout = false; h0.waarde_norm = 'people/c333'; T.vergeet();
  const nw = await T.detail('per:notaris-verzonnen', false);
  toets('17h gekoppeld contact bestaat niet meer: melding, geen gegevens van een ander contact', nw.j.weet.contact && /bestaat niet meer/.test(nw.j.weet.contact.fout) && !/0600000001/.test(JSON.stringify(nw.j.weet.contact)), nw.j.weet.contact);
  h0.waarde_norm = 'people/c222'; T.vergeet();
  const vn = await T.detail('per:notaris-verzonnen', true);
  toets('17i vaste plek: persoon 404 (dus ook geen Google-gegevens)', vn.status === 404 && !JSON.stringify(vn.j).includes('0600000001'));
  toets('17j telNl', B.telNl('+31 (0)6-1234 5678') === '0612345678' && B.telNl('0031 6 1234 5678') === '0612345678' && B.telNl('+220 712 3456') === '002207123456');
  const k = await T.detail('org:kapot', false);
  toets('17b kenmerkpatroon met een rekeningnummer: gemaskeerd', !/NL00TEST/.test(JSON.stringify((await T.detail('org:kapot', false)).j)));
  toets('18 pagina buiten de vault: niet gelezen', k.status === 200 && k.j.tekst === null && k.j.knoop.pagina_pad === null);
  toets('19 onbekende id 404', (await T.detail('org:bestaat-niet', false)).status === 404);
  T.vergeet(); rpcFout = true;
  let gooit = false; try { await T.lijst(false); } catch (x) { gooit = true; }
  toets('20 register weg: fout (route geeft 503), geen oude lijst', gooit);
  rpcFout = false;
  const sl = l.knopen.find((k) => k.id === 'org:voorbeeld-energie').sleutel;
  toets('20b detail op de sleutel uit de lijst (12 hex), past in APP_ROUTE_RE', /^[0-9a-f]{12}$/.test(sl) && (await T.detail(sl, false)).j.knoop.id === 'org:voorbeeld-energie' && /^\/app\/[a-z0-9/-]{1,64}$/.test('/app/brain/entiteit/' + sl));
  T.vergeet(); rpcFout = false;
  toets('20c privépersoon ook niet via zijn sleutel', (await T.detail(B.sleutelVan('per:jan-verzonnen'), false)).status === 404);
  toets('21 maskeerIban laat gewone woorden staan', B.maskeerIban('KvK 12345678 en AB12 CDEF') === 'KvK 12345678 en AB12 CDEF');

  const srv = fs.readFileSync('server.js', 'utf8');
  toets('22 server.js: routes en vaste plek uit het apparaat', /route === 'GET \/app\/brain\/entiteiten' \|\| route\.indexOf\('GET \/app\/brain\/entiteit\/'\) === 0/.test(srv) && /B\.detail\(id, vast\)/.test(srv) && /const vast = !!\(a && a\.soort === 'vast'\)/.test(srv));
  toets('23 uitrol.sh, Dockerfile en CI kennen brain-entiteiten', /RELEASE_OPTIONEEL="[^"]*\bbrain-entiteiten\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')) &&
    /COPY brain-entiteiten\.js \/app\/release-bootstrap\/brain-entiteiten\.js/.test(fs.readFileSync('Dockerfile', 'utf8')) && /test\/brain-entiteiten\.sh/.test(fs.readFileSync('.github/workflows/build.yml', 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('FOUT', e); process.exit(1); });
JS
