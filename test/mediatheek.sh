#!/usr/bin/env bash
# Toetst mediatheek.js (wv1269, App Mediatheek; opdracht David 24-10-2026; sinds wv1397 één beschrijving per bestand) en de koppeling in
# server.js. Toetst: de oude paginavorm (alleen nog voor de overzetting), de kaft (koppen, uitleg, paginalinks; oude regels en het sjabloon
# tellen niet), beschrijvingen (velden, omschrijving, datum, favoriet, twee bestanden, categorie zonder kop achteraan, kaft weg = stukken
# blijven), één fout = één stuk (geen kop, veld dubbel, lijst, datum, geen categorie, andere map, buiten 20_Prive, soort, ontbreekt,
# zonder zusterbestand, niet genoemd, symlink, hardlink, FIFO), niet van ons (gewone bronnotitie, symlink-beschrijving, punt-map,
# koppelmap), NFD-naam, bestand (base64, type, 404 zonder geldige beschrijving, ook uit een warme lijst, 413), /health zonder inhoud,
# zonder ovis-register.js, en server.js (dispatch, privé-module dicht op een vaste plek, tellers vooraf, stil bij 200, reden zonder pad,
# /health, uitrol-lijst, Dockerfile). Raakt de echte vault niet. Gebruik: bash test/mediatheek.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const M = require('./mediatheek.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mt1269-'));
  const V = path.join(W, 'vault');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  const MP3 = Buffer.from('ID3\u0003\u0000proef-mp3-inhoud', 'binary');
  zet('20_Prive/Bronnen/Shizzle/Lied A (Sven).mp3', MP3);
  zet('20_Prive/Bronnen/Shizzle/Lied B.mp3', MP3);
  zet('20_Prive/Bronnen/Shizzle/Hoes.pdf', '%PDF-1.4');
  zet('20_Prive/Bronnen/Shizzle/Tekst.md', '# tekst\n');
  zet('20_Prive/Bronnen/Shizzle/Pagina.html', '<p>x</p>');
  zet('20_Prive/.verborgen/geheim.mp3', MP3);
  zet('10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3', MP3);
  zet('00_Systeem/x.mp3', MP3);
  zet('20_Prive/Niet gelinkt.mp3', MP3);
  zet('20_Prive/Groot.mp3', Buffer.alloc(10));
  fs.mkdirSync(path.join(V, '20_Prive/Map.mp3'), { recursive: true });
  fs.symlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3'), path.join(V, '20_Prive/Link.mp3'));
  fs.writeFileSync(path.join(W, 'buiten.mp3'), MP3);
  const pagina = [
    '---', 'type: index', 'updated: 2026-10-24', '---', '', '# Mediatheek', '', 'Uitleg voor Socev met [[20_Prive/Bronnen/Shizzle/Lied B.mp3|mp3]].', '',
    '## Shizzle', '',
    '- **"Lied A!"** — Sven, 19-10-2026; feestnummer met een couplet per lid. Bestand',
    '  [[20_Prive/Bronnen/Shizzle/Lied A (Sven).mp3|mp3]].',
    '- **"Single"** — Sven, 23-10-2026; de "single" met albumhoes.',
    '  *Nog geen bestand:* kwam als spraakbericht in de groep.',
    '- **Twee bestanden** — Stef, 2026-01-05. Bestanden [[20_Prive/Bronnen/Shizzle/Lied B.mp3|mp3]] en [hoes](20_Prive/Bronnen/Shizzle/Hoes.pdf).',
    '',
    'Meer over de liedjes: [[20_Prive/Shizzle/Index|Shizzle]] § Liedjes.',
    '',
    '## Gedichten',
    '',
    '- **Bundel** — Davids eigen bundel, ± 2000–2004: [[20_Prive/Gedichten/Index|Gedichten]] en [[10_Zakelijk/X|zakelijk]].',
    '',
    '## Proeven',
    '- **Buiten** — x, 1-2-2026. Bestand [[10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3|mp3]] [[00_Systeem/x.mp3|mp3]] [[../buiten.mp3|mp3]] [[/etc/passwd.mp3|x]] [[20_Prive/.verborgen/geheim.mp3|mp3]] [[20_Prive/../10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3|mp3]].',
    '- **Soorten** — x, 1-2-2026. Bestand [[20_Prive/Bronnen/Shizzle/Tekst.md|md]] [[20_Prive/Bronnen/Shizzle/Pagina.html|html]].',
    '- **Raar** — x, 1-2-2026. Bestand [[20_Prive/Link.mp3|mp3]] [[20_Prive/Map.mp3|mp3]] [[20_Prive/Weg.mp3|mp3]] [[20_Prive/Groot.mp3|mp3]] [[20_Prive/Bronnen/Shizzle/Lied%20B.mp3|mp3]].',
    '### Sub',
    '- **Onder sub** — Wie, 2026-02-03',
    '',
  ].join('\n');
  zet('20_Prive/Mediatheek.md', pagina);

  // ── 1. lezen ──
  const O = M.leesPagina(pagina);
  toets('1a drie onderwerpen, intro boven het eerste overgeslagen', JSON.stringify(O.map((o) => o.naam)) === '["Shizzle","Gedichten","Proeven"]', O.map((o) => o.naam));
  const a = O[0].items[0];
  toets('1b titel zonder quotes, wie, datum ISO', a.titel === 'Lied A!' && a.wie === 'Sven' && a.datum === '2026-10-19', a);
  toets('1c omschrijving zonder "Bestand [[…]]"', a.omschrijving === 'feestnummer met een couplet per lid.', a.omschrijving);
  toets('1d vervolgregel hoort bij het item (bestand gevonden)', a.bestanden.length === 1 && a.bestanden[0].pad === '20_Prive/Bronnen/Shizzle/Lied A (Sven).mp3', a.bestanden);
  const s = O[0].items[1];
  toets('1e "Nog geen bestand" = noot, niet in de omschrijving', s.noot === 'kwam als spraakbericht in de groep.' && s.omschrijving === 'de "single" met albumhoes.' && s.bestanden.length === 0, s);
  const t = O[0].items[2];
  toets('1f ISO-datum en twee bestanden (wikilink + md-link)', t.datum === '2026-01-05' && t.bestanden.length === 2 && t.bestanden[1].ext === 'pdf' && t.omschrijving === null, t);
  toets('1g uitleg van het onderwerp als platte tekst', O[0].uitleg[0] === 'Meer over de liedjes: Shizzle § Liedjes.', O[0].uitleg);
  const g = O[1].items[0];
  toets('1h zonder datum: wie leeg, omschrijving heel, paginalink', g.wie === null && g.datum === null && /^Davids eigen bundel, ± 2000–2004: Gedichten en zakelijk\.$/.test(g.omschrijving) && g.paginas[0].pad === '20_Prive/Gedichten/Index.md', g);
  toets('1i ### valt onder het lopende onderwerp', O[2].items.length === 4 && O[2].items[3].titel === 'Onder sub' && O[2].items[3].datum === '2026-02-03', O[2].items.map((i) => i.titel));
  toets('1j schoonDoel weigert .., absoluut, punt-map, schema, NUL', ['../a.mp3', '/etc/a.mp3', '20_Prive/.x/a.mp3', 'https://x/a.mp3', 'a\u0000.mp3', '20_Prive//a.mp3'].every((p) => M.schoonDoel(p) === null) && M.schoonDoel('20_Prive/a b.mp3#x|y') === '20_Prive/a b.mp3');

  // ── 2. wv1397: beschrijvingen naast het bestand ──
  const SH = '20_Prive/Bronnen/Shizzle', FL = '20_Prive/Bronnen/Archief/Muziek';
  const besch = (velden, romp) => ['---', 'type: bron', 'bron_soort: mediatheek', 'domein: Prive', 'access_context: strikt_prive', 'status: actueel']
    .concat(velden, ['---', '', romp === undefined ? 'Omschrijving van het stuk.' : romp, '', 'Meer: [[20_Prive/Shizzle/Index]].', '']).join('\n');
  const bl = (pad) => ['bestanden:', '  - "[[' + pad + ']]"'];
  zet(SH + '/Lied C.mp3', MP3);
  zet(SH + '/Lied C.md', besch(['categorie: Shizzle', 'titel: "Lied C: het vervolg"', 'wie: Sven', 'datum: 2026-10-23   # dag bekend', 'favoriet: true'].concat(bl(SH + '/Lied C.mp3')), '# Kop\n\nSpoken word in de toon\nvan een **rapport**.'));
  zet(SH + '/Lied D.m4a', MP3); zet(SH + '/Lied D.pdf', '%PDF-1.4');
  zet(SH + '/Lied D.md', besch(['categorie: shizzle', 'titel: Lied D', 'datum_tekst: oktober 2026', 'bestanden:', '  - "[[' + SH + '/Lied D.m4a]]"', '  - "[[Lied D.pdf]]"']));
  zet(FL + '/Track 1.mp3', MP3); zet(FL + '/Track 1.md', besch(['categorie: Eigen muziek', 'titel: Track 1', 'wie: David', 'datum: 11-3-2002'].concat(bl(FL + '/Track 1.mp3'))));
  zet(FL + '/Track zonder.mp3', MP3);   // geen beschrijving: telt bij zonder_beschrijving
  zet(FL + '/Project.flp', 'flp');     // geen geluid: telt niet
  zet('20_Prive/Bronnen/Overig/Ding.mp3', MP3); zet('20_Prive/Bronnen/Overig/Ding.md', besch(['categorie: Aardig', 'titel: Ding'].concat(bl('20_Prive/Bronnen/Overig/Ding.mp3'))));
  // kapot: elk raakt alleen zichzelf
  const K = '20_Prive/Bronnen/Kapot';
  zet(K + '/Geen kop.mp3', MP3); zet(K + '/Geen kop.md', 'bron_soort: mediatheek\ncategorie: Shizzle\n\nvergeten streepjes\n');
  zet(K + '/Dubbel.mp3', MP3); zet(K + '/Dubbel.md', besch(['categorie: Shizzle', 'categorie: Anders'].concat(bl(K + '/Dubbel.mp3'))));
  zet(K + '/Lijst.mp3', MP3); zet(K + '/Lijst.md', besch(['categorie: [Shizzle, Anders]'].concat(bl(K + '/Lijst.mp3'))));
  zet(K + '/Datum.mp3', MP3); zet(K + '/Datum.md', besch(['categorie: Shizzle', 'datum: 2026-13-45'].concat(bl(K + '/Datum.mp3'))));
  zet(K + '/Geen cat.mp3', MP3); zet(K + '/Geen cat.md', besch(bl(K + '/Geen cat.mp3')));
  zet(K + '/Andere map.mp3', MP3); zet(K + '/Andere map.md', besch(['categorie: Shizzle'].concat(bl(SH + '/Lied C.mp3'))));
  zet(K + '/Buiten.mp3', MP3); zet(K + '/Buiten.md', besch(['categorie: Shizzle', 'bestanden:', '  - "[[' + K + '/Buiten.mp3]]"', '  - "[[10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3]]"']));
  zet(K + '/Soort.mp3', MP3); zet(K + '/Soort.html', '<p>x</p>'); zet(K + '/Soort.md', besch(['categorie: Shizzle', 'bestanden:', '  - "[[' + K + '/Soort.mp3]]"', '  - "[[' + K + '/Soort.html]]"']));
  zet(K + '/Ontbreekt.mp3', MP3); zet(K + '/Ontbreekt.md', besch(['categorie: Shizzle', 'bestanden:', '  - "[[' + K + '/Ontbreekt.mp3]]"', '  - "[[' + K + '/Weg.flp]]"']));
  zet(K + '/Zonder zus.md', besch(['categorie: Shizzle'].concat(bl(K + '/Bestaat niet.mp3'))));   // losgeraakt: het mp3 is verhuisd
  zet(K + '/Niet genoemd.mp3', MP3); zet(K + '/Niet genoemd.md', besch(['categorie: Shizzle'].concat(bl(K + '/Dubbel.mp3'))));
  zet(K + '/Twee links.mp3', MP3); zet(K + '/Twee links.md', besch(['categorie: Shizzle', 'bestanden:', '  - "[[' + K + '/Twee links.mp3]] [[' + K + '/Dubbel.mp3]]"']));
  zet(K + '/Geen lijst.mp3', MP3); zet(K + '/Geen lijst.md', besch(['categorie: Shizzle']));
  zet(K + '/Pad.mp3', MP3); zet(K + '/Pad.md', besch(['categorie: Shizzle', 'bestanden:', '  - "[[' + K + '/Pad.mp3]]"', '  - "[[../../10_Zakelijk/x.mp3]]"']));
  // symlink- en hardlinkbestand
  fs.symlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3'), path.join(V, K, 'Link.mp3'));
  zet(K + '/Link.md', besch(['categorie: Shizzle'].concat(bl(K + '/Link.mp3'))));
  fs.linkSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3'), path.join(V, K, 'Hard.mp3'));
  zet(K + '/Hard.md', besch(['categorie: Shizzle'].concat(bl(K + '/Hard.mp3'))));
  // niet van ons: een gewone bronnotitie naast een pdf, een beschrijving die zelf een symlink is, een punt-map, een symlink-map
  zet('20_Prive/Bronnen/Brief.pdf', '%PDF'); zet('20_Prive/Bronnen/Brief.md', '---\ntype: bron\nbron_soort: pdf\n---\nkapot: [\n');
  zet('20_Prive/Bronnen/Kapotte notitie.pdf', '%PDF'); zet('20_Prive/Bronnen/Kapotte notitie.md', 'geen kop, gewone tekst\n');
  zet('10_Zakelijk/Besch.md', besch(['categorie: Shizzle'].concat(bl('10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3'))));
  zet('20_Prive/Bronnen/Gelinkt.mp3', MP3); fs.symlinkSync(path.join(V, '10_Zakelijk/Besch.md'), path.join(V, '20_Prive/Bronnen/Gelinkt.md'));
  zet('20_Prive/.verborgen/geheim.md', besch(['categorie: Shizzle'].concat(bl('20_Prive/.verborgen/geheim.mp3'))));
  zet('10_Zakelijk/Map/Opname.mp3', MP3); zet('10_Zakelijk/Map/Opname.md', besch(['categorie: Shizzle'].concat(bl('20_Prive/Koppelmap/Opname.mp3'))));
  fs.symlinkSync(path.join(V, '10_Zakelijk/Map'), path.join(V, '20_Prive/Koppelmap'));
  // NFD-naam op schijf, NFC in de beschrijving (Drive/macOS): zelfde bestand
  zet(SH + '/' + 'Köln.mp3'.normalize('NFD'), MP3); zet(SH + '/Köln.md', besch(['categorie: Shizzle', 'titel: Köln'].concat(bl(SH + '/Köln.mp3'))));
  // de kaft: koppen, uitleg, oude opsommingsregels en het sjabloon tellen niet
  const kaft = ['---', 'type: index', '---', '', '# Mediatheek', '', 'Zo werkt het:', '', '```markdown', '---', 'bron_soort: mediatheek', 'categorie: Shizzle', '## Geen kop', '---', '```', '',
    '## Eigen muziek (Fruityloops, 2001–2005)', '', 'Zelfgemaakt; zie [[20_Prive/Archief/Rommel|Rommel]] en [[10_Zakelijk/X|zakelijk]].', '',
    '## Shizzle', '', '- **"Oud"** — Sven, 19-10-2026; oude regel. Bestand', '  [[20_Prive/Bronnen/Shizzle/Lied A (Sven).mp3|mp3]].', '', 'Meer over de liedjes: [[20_Prive/Shizzle/Index|Shizzle]].', '',
    '## Gedichten van David', '', 'Davids bundel: [[20_Prive/Gedichten/Index|Gedichten]].', '', '## Leeg', '', '- alleen een oude regel', ''].join('\n');
  zet('20_Prive/Mediatheek.md', kaft);
  const K1 = M.leesKaft(kaft);
  toets('2a kaft: koppen in volgorde, sjabloon in code-blok telt niet', JSON.stringify(K1.map((k) => k.naam)) === '["Eigen muziek (Fruityloops, 2001–2005)","Shizzle","Gedichten van David","Leeg"]', K1.map((k) => k.naam));
  toets('2b kaft: oude opsommingsregel is geen uitleg, alinea wel', JSON.stringify(K1[1].uitleg) === '["Meer over de liedjes: Shizzle."]' && K1[3].uitleg.length === 0, K1[1].uitleg);
  toets('2c kaft: paginalinks uit de uitleg', K1[2].paginas[0].pad === '20_Prive/Gedichten/Index.md' && K1[0].paginas.length === 2, K1.map((k) => k.paginas));
  toets('2d catSleutel: haakjes, hoofdletters, accenten', M.catSleutel('Eigen muziek (Fruityloops, 2001–2005)') === 'eigen muziek' && M.catSleutel('SHÏZZLE') === 'shizzle');

  const m = M.maak({ vault: V, cacheMs: 0 });
  const st = m.stand();
  toets('2e stand 200 zonder interne velden', st.status === 200 && !('_perId' in st.j) && st.j.kaft === true, st.status);
  const O1 = st.j.onderwerpen;
  toets('2f volgorde: koppen van de kaft, categorie zonder kop achteraan, lege kop weg', JSON.stringify(O1.map((o) => o.naam)) === '["Eigen muziek (Fruityloops, 2001–2005)","Shizzle","Gedichten van David","Aardig"]', O1.map((o) => o.naam));
  const sz = O1[1].items;
  toets('2g Shizzle: drie stukken (C, Köln, D; categorie zonder hoofdletter telt mee), op datum, de oude regel niet', JSON.stringify(sz.map((i) => i.titel)) === '["Lied C: het vervolg","Köln","Lied D"]', sz.map((i) => i.titel));
  const c = sz[0];
  toets('2h velden: wie, datum, favoriet, omschrijving = eerste alinea zonder kop en opmaak', c.wie === 'Sven' && c.datum === '2026-10-23' && c.favoriet === true && c.omschrijving === 'Spoken word in de toon van een rapport.' && c.datum_tekst === null, c);
  toets('2i bestand-id = sha256 van het pad (zelfde sleutels als vóór wv1397), geen pad naar buiten', c.bestanden.length === 1 && c.bestanden[0].id === M.idVan(SH + '/Lied C.mp3') && c.bestanden[0].soort === 'audio' && c.bestanden[0].grootte === MP3.length && !('pad' in c.bestanden[0]), c.bestanden);
  const d = sz[2];
  toets('2j datum_tekst, twee bestanden (alleen-naam-link in dezelfde map), pdf = bestand', d.datum === null && d.datum_tekst === 'oktober 2026' && d.bestanden.length === 2 && d.bestanden[1].soort === 'bestand' && d.bestanden[1].id === M.idVan(SH + '/Lied D.pdf') && d.favoriet === false, d);
  toets('2k datum d-m-jjjj wordt ISO', O1[0].items[0].datum === '2002-03-11', O1[0].items[0]);
  toets('2l Gedichten: alleen uitleg en paginalink, geen stukken; paginalink buiten 20_Prive valt weg', O1[2].items.length === 0 && O1[2].paginas.length === 1 && O1[0].paginas.length === 1 && O1[0].paginas[0].pad === '20_Prive/Archief/Rommel.md', O1.map((o) => o.paginas));
  toets('2m NFD-naam op schijf, NFC in de beschrijving: zelfde bestand, speelbaar', sz[1].bestanden.length === 1 && sz[1].bestanden[0].id === M.idVan(SH + '/Köln.mp3') && m.bestand(sz[1].bestanden[0].id).status === 200);
  const TH = Object.fromEntries(st.j.te_herstellen.map((t) => [t.naam, t.reden]));
  const verwacht = { 'Geen kop.md': /frontmatter/, 'Dubbel.md': /twee keer/, 'Lijst.md': /één waarde/, 'Datum.md': /datum is onleesbaar/, 'Geen cat.md': /categorie ontbreekt/,
    'Andere map.md': /andere map/, 'Buiten.md': /andere map/, 'Soort.md': /soort bestand/, 'Ontbreekt.md': /Weg\.flp ontbreekt/, 'Zonder zus.md': /geen mediabestand met dezelfde naam/,
    'Niet genoemd.md': /staat niet bij bestanden/, 'Twee links.md': /meer dan één link/, 'Geen lijst.md': /bestanden ontbreekt/, 'Pad.md': /geen pad/, 'Link.md': /koppeling of map/, 'Hard.md': /hardlink/ };
  const mis = Object.keys(verwacht).filter((k) => !verwacht[k].test(TH[k] || ''));
  toets('2n elke kapotte beschrijving in te_herstellen met een reden in gewone taal', !mis.length, mis.map((k) => k + ': ' + TH[k]));
  toets('2o niet van ons: gewone bronnotitie, kapotte notitie zonder bron_soort, symlink-beschrijving, punt-map, symlink-map', Object.keys(TH).length === Object.keys(verwacht).length, Object.keys(TH));
  toets('2p tellers: 5 stukken, 6 bestanden, 1 ontbreekt, 16 te herstellen, 3 zonder beschrijving (Track zonder + Lied A en B uit deel 1; geluid naast een kapotte beschrijving telt bij te herstellen)', st.j.tel.items === 5 && st.j.tel.bestanden === 6 && st.j.tel.ontbreekt === 1 && st.j.tel.te_herstellen === 16 && st.j.tel.zonder_beschrijving === 3, st.j.tel);
  toets('2q de kaft telt niet als beschrijving (sjabloon in code-blok)', !TH['Mediatheek.md']);

  // ── 3. bestand ──
  const id = c.bestanden[0].id;
  const b = m.bestand(id);
  toets('3a bestand: base64, type, naam', b.status === 200 && Buffer.from(b.j.inhoud, 'base64').equals(MP3) && b.j.type === 'audio/mpeg' && b.j.naam === 'Lied C.mp3', b.status);
  toets('3b id van een bestand zonder beschrijving = 404', m.bestand(M.idVan(FL + '/Track zonder.mp3')).status === 404);
  toets('3c id van een gesprek buiten 20_Prive (in een kapotte beschrijving) = 404', m.bestand(M.idVan('10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3')).status === 404);
  toets('3d id van symlink, hardlink, punt-map, koppelmap = 404', [K + '/Link.mp3', K + '/Hard.mp3', '20_Prive/.verborgen/geheim.mp3', '20_Prive/Koppelmap/Opname.mp3', '20_Prive/Bronnen/Gelinkt.mp3', K + '/Buiten.mp3'].every((p) => m.bestand(M.idVan(p)).status === 404));
  toets('3e geen id-vorm = 404', ['', 'x', '../../etc/passwd', 'A'.repeat(16), null].every((x) => m.bestand(x).status === 404));
  const bron = fs.readFileSync('./mediatheek.js', 'utf8').replace('const MAX_BESTAND = 20 * 1024 * 1024;', 'const MAX_BESTAND = 5;');
  const kp = path.join(process.cwd(), '.mt-klein-' + process.pid + '.js'); fs.writeFileSync(kp, bron);
  let kl, mk;
  try { mk = require(kp).maak({ vault: V, cacheMs: 0 }); kl = mk.stand().j.onderwerpen[1].items[0].bestanden[0]; } finally { fs.unlinkSync(kp); }
  toets('3f te groot: in de lijst gemarkeerd, bestand 413', kl.te_groot === true && mk.bestand(kl.id).status === 413, kl);
  // de lijst mag een minuut oud zijn, de toegang niet: beschrijving weg = meteen 404, ook met een warme lijst
  const mc = M.maak({ vault: V, cacheMs: 600000 });
  toets('3g warme lijst: bestand 200', mc.bestand(id).status === 200);
  const cTekst = fs.readFileSync(path.join(V, SH, 'Lied C.md'), 'utf8');
  fs.unlinkSync(path.join(V, SH, 'Lied C.md'));
  toets('3h beschrijving weg = 404 (ook uit een warme lijst)', mc.bestand(id).status === 404);
  zet(SH + '/Lied C.md', cTekst.replace(SH + '/Lied C.mp3', K + '/Dubbel.mp3'));
  toets('3i beschrijving omgezet naar een bestand in een andere map = 404', mc.bestand(id).status === 404);
  zet(SH + '/Lied C.md', cTekst);
  toets('3j lijst blijft ± 1 minuut (geen nieuwe zoektocht)', mc.lijst() === mc.lijst());
  require('child_process').execFileSync('mkfifo', [path.join(V, K, 'Fifo.mp3')]);
  zet(K + '/Fifo.md', besch(['categorie: Shizzle'].concat(bl(K + '/Fifo.mp3'))));
  const t0 = Date.now();
  const sF = m.stand().j;
  toets('3k FIFO = te herstellen en 404, zonder te blokkeren', /koppeling of map/.test((sF.te_herstellen.find((t) => t.naam === 'Fifo.md') || {}).reden || '') && m.bestand(M.idVan(K + '/Fifo.mp3')).status === 404 && Date.now() - t0 < 2000, sF.te_herstellen);
  fs.unlinkSync(path.join(V, SH, 'Lied C.mp3')); fs.symlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3'), path.join(V, SH, 'Lied C.mp3'));
  toets('3l bestand vervangen door een symlink na de lijst = 404', mc.bestand(id).status === 404);
  fs.unlinkSync(path.join(V, SH, 'Lied C.mp3')); zet(SH + '/Lied C.mp3', MP3);
  // pagina weg = stukken blijven (zonder uitleg, categorieën op naam)
  fs.renameSync(path.join(V, '20_Prive/Mediatheek.md'), path.join(W, 'kaft.md'));
  const zk = m.stand();
  toets('3m kaft weg: stukken blijven, categorieën op naam, zonder uitleg', zk.status === 200 && zk.j.kaft === false && zk.j.tel.items === 5 && JSON.stringify(zk.j.onderwerpen.map((o) => o.naam)) === '["Aardig","Eigen muziek","Shizzle"]' && zk.j.onderwerpen.every((o) => !o.uitleg.length), zk.j.onderwerpen.map((o) => o.naam));
  fs.renameSync(path.join(W, 'kaft.md'), path.join(V, '20_Prive/Mediatheek.md'));
  // 20_Prive zelf een koppeling naar een andere map, of afwezig: 503
  const V2 = path.join(W, 'vault2'); fs.mkdirSync(path.join(V2, '10_Zakelijk'), { recursive: true });
  fs.writeFileSync(path.join(V2, '10_Zakelijk', 'g.mp3'), MP3); fs.writeFileSync(path.join(V2, '10_Zakelijk', 'g.md'), besch(['categorie: X'].concat(bl('20_Prive/g.mp3'))));
  fs.symlinkSync(path.join(V2, '10_Zakelijk'), path.join(V2, '20_Prive'));
  const m2 = M.maak({ vault: V2, cacheMs: 0 });
  toets('3n 20_Prive als koppeling: 503, bestand onbereikbaar', m2.stand().status === 503 && m2.bestand(M.idVan('20_Prive/g.mp3')).status === 503);
  toets('3o zonder 20_Prive: 503 met uitleg', M.maak({ vault: path.join(W, 'leeg') }).stand().status === 503);
  // zonder ovis-register.js (terugrol van één bestand): elke beschrijving te herstellen, de pod valt niet om
  const los = path.join(W, 'los'); fs.mkdirSync(los); fs.copyFileSync('./mediatheek.js', path.join(los, 'mediatheek.js'));
  const sl = require(path.join(los, 'mediatheek.js')).maak({ vault: V, cacheMs: 0 }).stand();
  toets('3p zonder frontmatter-lezer: 0 stukken, alles te herstellen met reden', sl.status === 200 && sl.j.tel.items === 0 && sl.j.te_herstellen.some((t) => /lezer/.test(t.reden)), sl.j.tel);
  // oude vorm (alleen nog voor de overzetting): leesPagina blijft werken
  toets('3q leesPagina (oude vorm) leest nog', M.leesPagina(pagina)[0].items[0].titel === 'Lied A!');

  // ── 3c. review wv1397: races tussen controle en open, de kaft als koppeling of FIFO, [[x]] zonder aanhalingstekens, afkappen ──
  const EV = fs.realpathSync(V);
  const RD = path.join(EV, '20_Prive/Bronnen/Race'), ZD = path.join(EV, '10_Zakelijk/Race');
  zet('20_Prive/Bronnen/Race/Race.mp3', MP3); zet('20_Prive/Bronnen/Race/Race.md', besch(['categorie: Shizzle'].concat(bl('20_Prive/Bronnen/Race/Race.mp3'))));
  const GEHEIM = Buffer.from('ID3 gesprek uit 10_Zakelijk');
  zet('10_Zakelijk/Race/Race.mp3', GEHEIM); zet('10_Zakelijk/Race/Race.md', fs.readFileSync(path.join(RD, 'Race.md')));
  const RT = path.join(RD, 'Race.mp3'), rid = M.idVan('20_Prive/Bronnen/Race/Race.mp3');
  const wissel = (koppeling) => {   // Race is een echte map of een koppeling naar 10_Zakelijk/Race
    const isK = fs.lstatSync(RD).isSymbolicLink();
    if (koppeling && !isK) { fs.renameSync(RD, RD + '-echt'); fs.symlinkSync(ZD, RD); }
    if (!koppeling && isK) { fs.unlinkSync(RD); fs.renameSync(RD + '-echt', RD); }
  };
  const echtFs = { openSync: fs.openSync, lstatSync: fs.lstatSync, realpathSync: fs.realpathSync };
  const haak = (f) => { fs.openSync = function (p, ...a) { f('open', p); return echtFs.openSync.call(fs, p, ...a); };
    fs.lstatSync = function (p, ...a) { f('lstat', p); return echtFs.lstatSync.call(fs, p, ...a); };
    fs.realpathSync = function (p, ...a) { f('realpath', p); return echtFs.realpathSync.call(fs, p, ...a); }; };
  const haakLos = () => Object.assign(fs, echtFs);
  const mr = M.maak({ vault: V, cacheMs: 600000 });
  toets('3r race-proef: zonder ingreep 200 met het eigen bestand', mr.bestand(rid).status === 200 && Buffer.from(mr.bestand(rid).j.inhoud, 'base64').equals(MP3));
  // lstat ziet de koppeling (inode van het gesprek), realpath de echte map, open weer de koppeling (review MOET 1)
  let r3s;
  haak((w, p) => { if (p !== RT) return; if (w === 'lstat' || w === 'open') wissel(true); if (w === 'realpath') wissel(false); });
  try { r3s = mr.bestand(rid); } finally { haakLos(); wissel(false); }
  toets('3s tussenmap wordt een koppeling tussen de controles: 404, geen inhoud uit 10_Zakelijk', r3s.status === 404 && !r3s.j.inhoud, r3s.status);
  // tussen controle en open een hardlink erbij, of een ander bestand op die naam
  haak((w, p) => { if (w === 'open' && p === RT) fs.linkSync(RT, RT + '.tweede'); });
  try { r3s = mr.bestand(rid); } finally { haakLos(); try { fs.unlinkSync(RT + '.tweede'); } catch (e) { /* weg */ } }
  toets('3t hardlink tussen controle en open: 404 (fstat nlink)', r3s.status === 404, r3s.status);
  haak((w, p) => { if (w === 'open' && p === RT) { fs.unlinkSync(RT); fs.writeFileSync(RT, GEHEIM); } });
  try { r3s = mr.bestand(rid); } finally { haakLos(); fs.writeFileSync(RT, MP3); }
  toets('3u ander bestand op dezelfde naam tussen controle en open: 404 (fstat inode)', r3s.status === 404, r3s.status);
  // de kaft als koppeling naar een pagina buiten 20_Prive: niet gelezen
  const KAFT = path.join(EV, '20_Prive/Mediatheek.md'), kaftTekst = fs.readFileSync(KAFT);
  zet('10_Zakelijk/Pers/gesprek.md', '## Geheime kop\n\nVertrouwelijke alinea.\n');
  fs.unlinkSync(KAFT); fs.symlinkSync(path.join(EV, '10_Zakelijk/Pers/gesprek.md'), KAFT);
  const sk = m.stand().j;
  toets('3v kaft als koppeling naar 10_Zakelijk: kaft false, geen kop of tekst van buiten', sk.kaft === false && !JSON.stringify(sk).includes('Geheim') && !JSON.stringify(sk).includes('Vertrouwelijk'), sk.onderwerpen.map((o) => o.naam));
  fs.unlinkSync(KAFT); require('child_process').execFileSync('mkfifo', [KAFT]);
  let t1 = Date.now();
  const sf = m.stand().j;
  toets('3w kaft is een FIFO: kaft false, zonder te blokkeren', sf.kaft === false && Date.now() - t1 < 2000);
  fs.unlinkSync(KAFT); fs.writeFileSync(KAFT, kaftTekst);
  haak((w, p) => { if (w === 'open' && p === KAFT) { fs.unlinkSync(KAFT); require('child_process').execFileSync('mkfifo', [KAFT]); } });
  t1 = Date.now();
  let sf2;
  try { sf2 = m.stand().j; } finally { haakLos(); fs.unlinkSync(KAFT); fs.writeFileSync(KAFT, kaftTekst); }
  toets('3x kaft wordt een FIFO vlak voor het openen: geen blokkade, kaft false, stukken blijven', sf2.kaft === false && sf2.tel.items === 6 && Date.now() - t1 < 2000, sf2.tel);
  // bestanden: [[x]] zonder aanhalingstekens (inline) en een beschrijving met lange frontmatter vóór bron_soort
  zet('20_Prive/Bronnen/Race/Inline.mp3', MP3);
  zet('20_Prive/Bronnen/Race/Inline.md', '---\nbron_soort: mediatheek\ncategorie: Shizzle\nbestanden: [[20_Prive/Bronnen/Race/Inline.mp3]]\n---\n');
  zet('20_Prive/Bronnen/Race/Lang.mp3', MP3);
  zet('20_Prive/Bronnen/Race/Lang.md', '---\nnotitie: "' + 'x'.repeat(6000) + '"\nbron_soort: mediatheek\ncategorie: Shizzle\nbestanden:\n  - "[[20_Prive/Bronnen/Race/Lang.mp3]]"\n---\n');
  const si = m.stand().j, tit = si.onderwerpen.find((o) => o.naam === 'Shizzle').items.map((i) => i.titel);
  toets('3y bestanden: [[x]] zonder aanhalingstekens en lange frontmatter vóór bron_soort worden herkend', tit.includes('Inline') && tit.includes('Lang'), [tit, si.te_herstellen.filter((t) => /Inline|Lang/.test(t.naam))]);
  // afkappen wordt gemeld
  const kb = fs.readFileSync('./mediatheek.js', 'utf8').replace('MAX_INGANGEN = 60000', 'MAX_INGANGEN = 20');
  const kpa = path.join(process.cwd(), '.mt-kap-' + process.pid + '.js'); fs.writeFileSync(kpa, kb);
  let ha;
  try { ha = require(kpa).maak({ vault: V, cacheMs: 0 }).health(); } finally { fs.unlinkSync(kpa); }
  toets('3z zoektocht afgekapt: afgekapt true in /health', ha.afgekapt === true && m.health().afgekapt === false, ha);
  for (const n of ['Race.md', 'Inline.md', 'Lang.md']) fs.unlinkSync(path.join(RD, n));

  // ── 4. health ──
  const h = m.health();
  toets('4 /health: alleen aantallen, met te_herstellen en zonder_beschrijving', h.aan && h.pagina === true && h.items === 5 && h.te_herstellen === 17 && h.zonder_beschrijving === 3 && h.afgekapt === false && Object.keys(h).length === 8, h);

  // ── 5. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('5a dispatch lijst en bestand/<16 hex>', src.indexOf("if (route === 'GET /app/mediatheek' || /^GET \\/app\\/mediatheek\\/bestand\\/[a-f0-9]{16}$/.test(route)) return typeof appMediatheek === 'function'") > 0);
  toets('5b privé-module (vaste plek dicht)', /const APP_PRIVE_MODULES = \[[^\]]*'mediatheek'/.test(src));
  toets('5c tellers vooraf in appStaat', /tellers: \{[^}]*mediatheek: \[\], 'mediatheek-bestand': \[\]/.test(src));
  toets('5d /health.mediatheek', /mediatheek: typeof mediatheekInfo === 'function' \? mediatheekInfo\(\) : \{ aan: false \}/.test(src));
  toets('5e uitrol-lijst en Dockerfile (ook ovis-register.js: de frontmatter-lezer)', /RELEASE_OPTIONEEL="[^"]*\bmediatheek\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /RELEASE_OPTIONEEL="[^"]*\bovis-register\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY mediatheek\.js \/app\/release-bootstrap\/mediatheek\.js/.test(fs.readFileSync('Dockerfile', 'utf8')) && /COPY ovis-register\.js \/app\/release-bootstrap\/ovis-register\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  const vm = require('vm');
  const hb = src.indexOf('// ── Mediatheek (wv1269'), he = src.indexOf('// ── einde mediatheek ──');
  toets('5f blokmarkers', hb > 0 && he > hb);
  const gestuurd = [];
  const ctx = vm.createContext({ require, process: { env: { APP_VAULT_DIR: V } }, __dirname: process.cwd(), path, fs, console, VAULT: '/bestaat/niet',
    logError: () => {}, appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  // wv1901: de echte privélijst, schakelaar, appAfscherm en appPriveDicht uit server.js (staan buiten dit blok)
  const prive = /^const APP_PRIVE_MODULES = [^\n]*\n/m.exec(src)[0] + /^const APP_VAST_AFSCHERMEN = [^\n]*\n/m.exec(src)[0] +
    /^function appAfscherm\(a\) \{[\s\S]*?\n\}\n/m.exec(src)[0] + /^function appPriveDicht\([^\n]*\n/m.exec(src)[0];
  vm.runInContext(prive + src.slice(hb, he) + ';globalThis.__mt = { appMediatheek, mediatheekInfo };', ctx, { filename: 'server.js#mediatheek' });
  const r1 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r1, { soort: 'meereizend' }, 'GET /app/mediatheek');
  toets('5g lijst 200, stil, vaste_plek false, APP_VAULT_DIR gebruikt', gestuurd[0].s === 200 && gestuurd[0].j.vaste_plek === false && gestuurd[0].j.onderwerpen.length === 4 && r1._app.stil === true, gestuurd[0].s);
  const r2 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r2, { soort: 'meereizend' }, 'GET /app/mediatheek/bestand/' + id);
  toets('5h bestand 200, reden met id en extensie, geen pad', gestuurd[1].s === 200 && r2._app.reden === 'mediatheek bestand ' + id + ' mp3' && !/Lied|Prive/.test(r2._app.reden), r2._app.reden);
  const r3 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r3, { soort: 'vast' }, 'GET /app/mediatheek');
  toets('5i wv1901: vaste plek: dezelfde lijst (David 28-10: op alle pc\'s alles)', gestuurd[2].s === 200 && gestuurd[2].j.vaste_plek === false && gestuurd[2].j.onderwerpen.length === 4, gestuurd[2].s);
  await ctx.__mt.appMediatheek({}, { _app: {} }, { soort: 'vast' }, 'GET /app/mediatheek/bestand/' + id);
  toets('5j wv1901: vaste plek: bestand 200', gestuurd[3].s === 200, gestuurd[3].s);
  toets('5k info', ctx.__mt.mediatheekInfo().items === 5);
  // review wv1269 ZOU 2: hooguit twee antwoorden tegelijk onderweg; de teller zakt pas bij 'close'
  const EE = require('events');
  const open = [new EE(), new EE()]; open.forEach((r) => { r._app = {}; });
  const idA = id;   // Lied C (in 3l even een symlink, daarna hersteld)
  for (const r of open) await ctx.__mt.appMediatheek({}, r, { soort: 'meereizend' }, 'GET /app/mediatheek/bestand/' + idA);
  const n0 = gestuurd.length;
  await ctx.__mt.appMediatheek({}, Object.assign(new EE(), { _app: {} }), { soort: 'meereizend' }, 'GET /app/mediatheek/bestand/' + idA);
  toets('5l derde tegelijk = 429', gestuurd[n0].s === 429, gestuurd[n0]);
  open[0].emit('close'); open[0].emit('close');
  await ctx.__mt.appMediatheek({}, Object.assign(new EE(), { _app: {} }), { soort: 'meereizend' }, 'GET /app/mediatheek/bestand/' + idA);
  toets('5m na close (één keer geteld) weer plek', gestuurd[n0 + 1].s === 200, gestuurd[n0 + 1] && gestuurd[n0 + 1].s);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
