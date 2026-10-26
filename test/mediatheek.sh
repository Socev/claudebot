#!/usr/bin/env bash
# Toetst mediatheek.js (wv1269, App Mediatheek; opdracht David 24-10-2026) en de koppeling in server.js. Toetst: lezen van de pagina
# (frontmatter, onderwerpen, items met vervolgregels, titel zonder quotes, wie + datum in twee vormen, omschrijving zonder "Bestand [[…]]",
# "Nog geen bestand", paginalinks, uitleg), padcontrole (alleen links van de pagina, alleen onder 20_Prive, '..', absoluut, punt-map,
# .md/.html niet als bestand, symlink, map, te groot, ontbreekt, id niet op de pagina, onbekend id), bestand (base64, type), /health
# zonder inhoud, en server.js (dispatch, privé-module dicht op een vaste plek, tellers vooraf, stil bij 200, reden zonder pad, /health,
# uitrol-lijst, Dockerfile). Raakt de echte vault niet. Gebruik: bash test/mediatheek.sh
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

  // ── 2. lijst met padcontrole ──
  const m = M.maak({ vault: V });
  const st = m.stand();
  toets('2a stand 200 zonder interne velden', st.status === 200 && !('_perId' in st.j) && st.j.pagina === '20_Prive/Mediatheek.md', st.status);
  const it = (o, i) => st.j.onderwerpen[o].items[i];
  toets('2b bestand met id, soort audio, grootte', it(0, 0).bestanden.length === 1 && /^[a-f0-9]{16}$/.test(it(0, 0).bestanden[0].id) && it(0, 0).bestanden[0].soort === 'audio' && it(0, 0).bestanden[0].grootte === MP3.length && !('pad' in it(0, 0).bestanden[0]), it(0, 0).bestanden);
  toets('2c pdf = soort bestand (alleen downloaden)', it(0, 2).bestanden[1].soort === 'bestand', it(0, 2).bestanden);
  toets('2d links buiten 20_Prive, .., absoluut, punt-map: bestaan niet voor de App', it(2, 0).bestanden.length === 0, it(2, 0).bestanden);
  toets('2e .md en .html zijn geen bestand', it(2, 1).bestanden.length === 0, it(2, 1).bestanden);
  const raar = it(2, 2).bestanden;
  toets('2f symlink, map en ontbrekend = ontbreekt; %20 = zelfde bestand als Lied B', raar.length === 5 && raar.slice(0, 3).every((b) => b.ontbreekt) && !raar[3].ontbreekt && !raar[4].ontbreekt && raar[4].naam === 'Lied B.mp3', raar);
  toets('2g paginalink buiten 20_Prive valt weg', it(1, 0).paginas.length === 1, it(1, 0).paginas);
  toets('2h tellers', st.j.tel.items === 8 && st.j.tel.ontbreekt === 3, st.j.tel);

  // ── 3. bestand ──
  const id = it(0, 0).bestanden[0].id;
  const b = m.bestand(id);
  toets('3a bestand: base64, type, naam', b.status === 200 && Buffer.from(b.j.inhoud, 'base64').equals(MP3) && b.j.type === 'audio/mpeg' && b.j.naam === 'Lied A (Sven).mp3', b.status);
  toets('3b id van een niet-gelinkt bestand (zelfde hash-vorm) = 404', m.bestand(M.idVan('20_Prive/Niet gelinkt.mp3')).status === 404);
  toets('3c id van een gesprek buiten 20_Prive (wel op de pagina) = 404', m.bestand(M.idVan('10_Zakelijk/Tolgaarde/Medewerkers/gesprek.mp3')).status === 404);
  toets('3d id van de symlink = 404', m.bestand(M.idVan('20_Prive/Link.mp3')).status === 404);
  toets('3e geen id-vorm = 404', ['', 'x', '../../etc/passwd', 'A'.repeat(16), null].every((x) => m.bestand(x).status === 404));
  // te groot: grens tijdelijk omlaag via een kopie van de module met een kleinere grens
  const bron = fs.readFileSync('./mediatheek.js', 'utf8').replace('const MAX_BESTAND = 20 * 1024 * 1024;', 'const MAX_BESTAND = 5;');
  const kp = path.join(W, 'mt-klein.js'); fs.writeFileSync(kp, bron);
  const mk = require(kp).maak({ vault: V });
  const kl = mk.stand().j.onderwerpen[2].items[2].bestanden[3];
  toets('3f te groot: in de lijst gemarkeerd, bestand 413', kl.te_groot === true && mk.bestand(kl.id).status === 413, kl);
  // bestand van de pagina gehaald = meteen weg (pagina wordt elke keer gelezen)
  zet('20_Prive/Mediatheek.md', pagina.replace('[[20_Prive/Bronnen/Shizzle/Lied A (Sven).mp3|mp3]]', ''));
  toets('3g link van de pagina weg = 404', m.bestand(id).status === 404);
  zet('20_Prive/Mediatheek.md', pagina);
  // realpath-controle: 20_Prive zelf mag geen symlink naar buiten zijn
  const V2 = path.join(W, 'vault2'); fs.mkdirSync(V2);
  fs.mkdirSync(path.join(V2, '10_Zakelijk')); fs.writeFileSync(path.join(V2, '10_Zakelijk', 'Mediatheek.md'), '## A\n- **X** — Y, 1-1-2026. Bestand [[20_Prive/g.mp3|mp3]].\n'); fs.writeFileSync(path.join(V2, '10_Zakelijk', 'g.mp3'), MP3);
  fs.symlinkSync(path.join(V2, '10_Zakelijk'), path.join(V2, '20_Prive'));
  const m2 = M.maak({ vault: V2 });
  const s2 = m2.stand();
  toets('3h 20_Prive als koppeling naar een andere map: bestand onbereikbaar', s2.status === 200 && s2.j.tel.bestanden === 0 && m2.bestand(M.idVan('20_Prive/g.mp3')).status === 404, s2.j && s2.j.tel);
  toets('3i zonder pagina: 503 met uitleg', M.maak({ vault: path.join(W, 'leeg') }).stand().status === 503);

  // ── 4. health ──
  const h = m.health();
  toets('4 /health: alleen aantallen', h.aan && h.pagina && h.items === 8 && h.bestanden >= 3 && Object.keys(h).length === 5, h);

  // ── 5. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('5a dispatch lijst en bestand/<16 hex>', src.indexOf("if (route === 'GET /app/mediatheek' || /^GET \\/app\\/mediatheek\\/bestand\\/[a-f0-9]{16}$/.test(route)) return typeof appMediatheek === 'function'") > 0);
  toets('5b privé-module (vaste plek dicht)', /const APP_PRIVE_MODULES = \[[^\]]*'mediatheek'/.test(src));
  toets('5c tellers vooraf in appStaat', /tellers: \{[^}]*mediatheek: \[\], 'mediatheek-bestand': \[\]/.test(src));
  toets('5d /health.mediatheek', /mediatheek: typeof mediatheekInfo === 'function' \? mediatheekInfo\(\) : \{ aan: false \}/.test(src));
  toets('5e uitrol-lijst en Dockerfile', /RELEASE_OPTIONEEL="[^"]*\bmediatheek\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY mediatheek\.js \/app\/release-bootstrap\/mediatheek\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  const vm = require('vm');
  const hb = src.indexOf('// ── Mediatheek (wv1269'), he = src.indexOf('// ── einde mediatheek ──');
  toets('5f blokmarkers', hb > 0 && he > hb);
  const gestuurd = [];
  const ctx = vm.createContext({ require, process: { env: { APP_VAULT_DIR: V } }, __dirname: process.cwd(), path, fs, console, VAULT: '/bestaat/niet',
    logError: () => {}, appTeller: () => true, appPriveDicht: (a, id) => a.soort === 'vast' && id === 'mediatheek',
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__mt = { appMediatheek, mediatheekInfo };', ctx, { filename: 'server.js#mediatheek' });
  const r1 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r1, { soort: 'meereizend' }, 'GET /app/mediatheek');
  toets('5g lijst 200, stil, vaste_plek false, APP_VAULT_DIR gebruikt', gestuurd[0].s === 200 && gestuurd[0].j.vaste_plek === false && gestuurd[0].j.onderwerpen.length === 3 && r1._app.stil === true, gestuurd[0].s);
  const r2 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r2, { soort: 'meereizend' }, 'GET /app/mediatheek/bestand/' + id);
  toets('5h bestand 200, reden met id en extensie, geen pad', gestuurd[1].s === 200 && r2._app.reden === 'mediatheek bestand ' + id + ' mp3' && !/Lied|Prive/.test(r2._app.reden), r2._app.reden);
  const r3 = { _app: {} };
  await ctx.__mt.appMediatheek({}, r3, { soort: 'vast' }, 'GET /app/mediatheek');
  toets('5i vaste plek: lijst zegt waarom, zonder onderwerpen', gestuurd[2].s === 200 && gestuurd[2].j.vaste_plek === true && !gestuurd[2].j.onderwerpen, gestuurd[2]);
  await ctx.__mt.appMediatheek({}, { _app: {} }, { soort: 'vast' }, 'GET /app/mediatheek/bestand/' + id);
  toets('5j vaste plek: bestand 403', gestuurd[3].s === 403, gestuurd[3]);
  toets('5k info', ctx.__mt.mediatheekInfo().items === 8);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
