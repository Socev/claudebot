#!/usr/bin/env bash
# Toetst OVIS Tripper (wv2136, 1-11-2026): reizen.js (soort uit trip_soort of de tags, gambia vóór vakantie; gezelschap uit de kop;
# komend bovenaan; id = hash van het pad, nooit een pad uit de vraag; geen symlink volgen), dezelfde reisInfo als MemoryLane had
# (oude functie letterlijk vergeleken), de vaste kop van T2 (wv2152: vervoer, verblijf, plekken, kosten alleen met bron), de kaart van T3 (wv2163: verblijf op plaatsnaam
# aan een plek, lijn, punt per reis), T4 (wv2172: nog te regelen bij een komende reis, geannuleerd), en het server.js-blok (routes, audit zonder titel, /health alleen aantallen, uitrol-lijst).
# Zonder sessie 401: test/socev-app-poort.sh § 21. Alleen verzonnen reizen en namen; raakt de echte vault niet. Gebruik: bash test/tripper.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" reizen.js; then echo "ROOD  reizen.js logt naar de console of gebruikt eval"; exit 1; fi
node - <<'JS'
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const R = require('./reizen.js'), VV = require('./vault-veilig.js');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'tripper-')), V = path.join(W, 'vault'), RM = path.join(V, R.REIS_MAP);
  fs.mkdirSync(RM, { recursive: true });
  const zet = (n, t) => fs.writeFileSync(path.join(RM, n), t);
  const reis = (fm, lijf) => '---\n' + fm.join('\n') + '\n---\n' + (lijf || '');
  zet('2023 - Proefland.md', reis(['type: reis', 'onderwerp: "Vakantie Proefland, april 2023"', 'tags: [privé, reizen, gambia, vakantie, 2023]', 'periode: "2023-04-19 – 2023-04-26"',
    'description: "Eerste gezinsreis naar Proefland."'], '# Vakantie Proefland\n\n## Kerngegevens\n\n- Hotel Verzonnen\n\n## Gezelschap (4)\n\n- Bram Proefsen\n- [[20_Prive/Familie/Kees Verzonnen|Kees]]\n- [[20_Prive/Familie/Anna Proef]]\n- ![[20_Prive/Beeld/foto.jpg]]\n- [[20_Prive/Familie/Kees Verzonnen|Kees nog eens]]\n\n### Kinderen\n\n- [[20_Prive/Familie/Pim Proef|Pim]]\n\n## Verloop\n\n- [[20_Prive/Plekken/Strand Nergens|Strand]]\n'));
  zet('2024 - Rally Nergens.md', reis(['type: reis', 'onderwerp: "Proefrally 2024"', 'tags:', '  - privé', '  - carbage-run', '  - roadtrip', 'periode: "2024-01-20 – 2024-01-28"'],
    '## Wie & hoe\n\n- **[[20_Prive/Vrienden/Joost Nep|Joost]]** rijdt mee, met [[Toos Nep]].\n\n## Programma\n\n- [[20_Prive/Vrienden/Niet Mee|Niet]]\n'));
  zet('2025 - Vriendenweekend.md', reis(['type: reis', 'onderwerp: Vriendenweekend Proefstad', 'tags: [privé, reizen, shizzle, vriendenweekend, stedentrip, 2025]', 'periode: "2025-06-27 – 2025-06-30"'], '## Verloop\n\nGeen gezelschapskop.\n'));
  zet('2026 - Eigen soort.md', reis(['type: reis', 'onderwerp: "Eigen soort"', 'trip_soort: festival', 'tags: [vakantie]', 'deelnemers: ["[[20_Prive/X/Lid Een|Lid]]", "[[20_Prive/X/Lid Twee]]"]', 'periode: "2026-08-21 – 2026-08-23"'], '## Gezelschap\n\n- [[20_Prive/X/Anders|Anders]]\n'));
  zet('2026 - Nu bezig.md', reis(['type: reis', 'onderwerp: "Nu bezig"', 'tags: [wandelen]', 'periode: "2026-10-30 – 2026-11-03"']));
  zet('2027 - Later.md', reis(['type: reis', 'onderwerp: "Later"', 'tags: [carbage-run]', 'periode: "2027-02-22 – 2027-02-26"']));
  zet('2026 - Eerder gepland.md', reis(['type: reis', 'onderwerp: "Eerder gepland"', 'tags: [weekend]', 'periode: "2026-12-05 – 2026-12-06"']));
  zet('2020 - Zonder tags.md', reis(['type: reis', 'periode: "2020-02-09 – 2020-02-15"']));
  zet('Index.md', reis(['type: index', 'onderwerp: Reizen']));
  zet('.verborgen.md', reis(['type: reis', 'onderwerp: "Verborgen"', 'periode: "2021-01-01 – 2021-01-02"']));
  fs.mkdirSync(path.join(RM, 'Submap')); fs.writeFileSync(path.join(RM, 'Submap', 'Diep.md'), reis(['type: reis', 'onderwerp: "Diep"', 'periode: "2021-01-01 – 2021-01-02"']));
  fs.mkdirSync(path.join(V, '10_Zakelijk'), { recursive: true });
  fs.writeFileSync(path.join(V, '10_Zakelijk', 'geheim.md'), reis(['type: reis', 'onderwerp: "Zakelijk geheim"', 'periode: "2021-01-01 – 2021-01-02"'], 'Vertrouwelijke alinea.\n'));
  fs.symlinkSync(path.join(V, '10_Zakelijk', 'geheim.md'), path.join(RM, '2021 - Koppeling.md'));

  const koppel = (rel) => (/Proefland/.test(rel) ? { hid: 'h0123456789abcdef', stukken: 2, album: { status: 'actief', aantal: 13 } } : null);
  const m = R.maak({ vault: V, vv: VV, vandaag: () => '2026-11-01', koppel });
  const L = m.lijst();
  const reizen = L.body.reizen, op = (t) => reizen.find((r) => r.titel === t);
  // ── 1. welke pagina's ──
  toets('1a alleen type: reis direct in de map (geen Index, geen verborgen, geen submap)', L.status === 200 && reizen.length === 8 && !op('Diep') && !op('Verborgen') && !op('Reizen'), reizen.map((r) => r.titel));
  toets('1b symlink naar 10_Zakelijk niet gevolgd: niet in de lijst, onleesbaar geteld, geen tekst van buiten',
    !JSON.stringify(L).includes('Zakelijk geheim') && !JSON.stringify(L).includes('Vertrouwelijk') && m.info().onleesbaar === 1, m.info());
  // ── 2. soort ──
  toets('2a Gambia met ook de tag vakantie = gambia', op('Vakantie Proefland, april 2023').soort === 'gambia');
  toets('2b tags als blok (- carbage-run) = carbage-run', op('Proefrally 2024').soort === 'carbage-run');
  toets('2c shizzle + stedentrip = vrienden (vrienden vóór weekend)', op('Vriendenweekend Proefstad').soort === 'vrienden');
  toets('2d trip_soort in de frontmatter wint van de tags', op('Eigen soort').soort === 'festival');
  toets('2e wandelen = actief, weekend = weekend, zonder tags = overig', op('Nu bezig').soort === 'actief' && op('Eerder gepland').soort === 'weekend' && op('2020 - Zonder tags').soort === 'overig');
  toets('2f titel zonder onderwerp = bestandsnaam', !!op('2020 - Zonder tags'));
  // ── 3. gezelschap ──
  const g = op('Vakantie Proefland, april 2023').deelnemers;
  toets('3a gezelschap uit de kop: alias, anders bestandsnaam; geen insluiting, geen dubbele, stopt niet bij ###, wel bij de volgende ##',
    JSON.stringify(g) === JSON.stringify(['Kees', 'Anna Proef', 'Pim']), g);
  toets('3b "## Wie & hoe" telt ook; [[x]] zonder map; niets uit de volgende kop', JSON.stringify(op('Proefrally 2024').deelnemers) === JSON.stringify(['Joost', 'Toos Nep']), op('Proefrally 2024').deelnemers);
  toets('3b2 [[pad#kop|naam]] en [[pad#kop]] (review ZOU 1: de anchor-regex klopt)', JSON.stringify(R.deelnemersVan('---\ntype: reis\n---\n## Gezelschap\n\n- [[20_Prive/X/Lid Een#Jeugd|Lid]]\n- [[20_Prive/X/Lid Twee#Kop]]\n')) === JSON.stringify(['Lid', 'Lid Twee']));
  toets('3c pagina zonder gezelschapskop: geen namen', op('Vriendenweekend Proefstad').deelnemers.length === 0);
  toets('3d deelnemers in de frontmatter winnen van de kop', JSON.stringify(op('Eigen soort').deelnemers) === JSON.stringify(['Lid', 'Lid Twee']), op('Eigen soort').deelnemers);
  // ── 4. volgorde en stand ──
  const t = reizen.map((r) => r.titel + ':' + r.stand);
  toets('4a komend bovenaan (nu, dan eerstvolgende gepland), daarna nieuwste eerst', JSON.stringify(t) === JSON.stringify(['Nu bezig:nu', 'Eerder gepland:gepland', 'Later:gepland',
    'Eigen soort:geweest', 'Vriendenweekend Proefstad:geweest', 'Proefrally 2024:geweest', 'Vakantie Proefland, april 2023:geweest', '2020 - Zonder tags:geweest']), t);
  const p = op('Vakantie Proefland, april 2023');
  toets('4b periode, van/tot, dagen (incl. beide), jaar, beschrijving', p.van === '2023-04-19' && p.tot === '2023-04-26' && p.dagen === 8 && p.jaar === '2023' && p.beschrijving === 'Eerste gezinsreis naar Proefland.', p);
  toets('4c lijst zonder paginatekst en zonder pad', !('tekst' in p) && !('pad' in p) && !JSON.stringify(L).includes('Hotel Verzonnen') && !JSON.stringify(L).includes('20_Prive/Reizen'));
  toets('4d MemoryLane-koppeling erbij (hid, stukken, album), anders null', p.memorylane && p.memorylane.hid === 'h0123456789abcdef' && p.memorylane.stukken === 2 && p.memorylane.album.aantal === 13 && op('Later').memorylane === null);
  // ── 5. één reis ──
  const d = m.reis(p.id);
  toets('5a reis op id: tekst zonder frontmatter, pad, kop, koppeling', d.status === 200 && /Hotel Verzonnen/.test(d.body.reis.tekst) && !/^---/.test(d.body.reis.tekst) && d.body.reis.pad === '20_Prive/Reizen/2023 - Proefland.md'
    && d.body.reis.soort === 'gambia' && d.body.reis.memorylane.hid === 'h0123456789abcdef', d.status);
  toets('5b id = 12 hex van sha256(pad)', p.id === R.idVan('20_Prive/Reizen/2023 - Proefland.md') && /^[0-9a-f]{12}$/.test(p.id));
  toets('5c onbekende id (goede vorm) = 404', m.reis('0123456789ab').status === 404);
  const slecht = ['../10_Zakelijk/geheim.md', '20_Prive/Reizen/2023 - Proefland.md', '..%2F10_Zakelijk', p.id + '0', p.id.toUpperCase(), '', p.id + '/x', null, { id: p.id }];
  toets('5d pad-achtige of verkeerde id = 400, nooit een bestand gelezen', slecht.every((x) => m.reis(x).status === 400), slecht.map((x) => m.reis(x).status));
  toets('5e de symlink-pagina op id: 404, geen tekst van buiten', m.reis(R.idVan('20_Prive/Reizen/2021 - Koppeling.md')).status === 404);
  toets('5f een niet-reis op id (Index): 404', m.reis(R.idVan('20_Prive/Reizen/Index.md')).status === 404);
  // ── 6. info ──
  const i = m.info();
  toets('6 info: alleen aantallen en tijd', i.aan === true && i.reizen === 8 && i.komend === 3 && i.onleesbaar === 1 && Object.keys(i).sort().join() === 'aan,komend,onleesbaar,op,reizen', i);
  toets('6b info vóór de eerste lijst: null-tellers', R.maak({ vault: V, vv: VV }).info().reizen === null);
  toets('6c zonder reizenmap: lege lijst, geen fout', R.maak({ vault: path.join(W, 'leeg'), vv: VV }).lijst().body.reizen.length === 0);

  // ── 7. MemoryLane: dezelfde reisInfo als vóór wv2136 (oude functie letterlijk) ──
  function fmVeldOud(t, veld) {
    const mm = /^---\n([\s\S]*?)\n---/.exec(t || '');
    if (!mm) return null;
    const r = new RegExp('^' + veld + ':\\s*(.*)$', 'm').exec(mm[1]);
    if (!r) return null;
    let v = r[1].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (e) { v = v.replace(/^"|"$/g, ''); } }
    return v;
  }
  function reisInfoOud(rel) {
    let tt;
    try { tt = VV.lees(path.join(V, rel), 'utf8', { max: 512 * 1024 }); } catch (e) { return null; }
    if (fmVeldOud(tt, 'type') !== 'reis') return null;
    const periode = fmVeldOud(tt, 'periode') || '';
    const data = periode.match(/\d{4}-\d{2}-\d{2}/g) || [];
    return { titel: (fmVeldOud(tt, 'onderwerp') || path.basename(rel, '.md')).slice(0, 120), periode, van: data[0] || null, tot: data[data.length - 1] || null };
  }
  zet('2019 - Lange titel.md', reis(['type: reis', 'onderwerp: "' + 'x'.repeat(200) + '"', 'periode: "2019-01-01"']));
  zet('2019 - Kapot.md', '---\ntype: reis\nonderwerp: "kapot\nperiode: 2019-05-05 – 2019-05-01\n---\n');
  const oudLijst = fs.readdirSync(RM).filter((n) => /\.md$/.test(n) && !n.startsWith('.')).sort().map((n) => path.join(R.REIS_MAP, n));
  toets('7a paden() = de oude readdir-lijst (gesorteerd)', JSON.stringify(m.paden()) === JSON.stringify(oudLijst), [m.paden(), oudLijst]);
  const verschil = oudLijst.filter((rel) => JSON.stringify(m.reisInfo(rel)) !== JSON.stringify(reisInfoOud(rel)));
  toets('7b reisInfo per pagina gelijk aan de oude (ook symlink, Index, lange titel, kapotte frontmatter)', verschil.length === 0 && oudLijst.length === 12, verschil);
  const mlSrc = fs.readFileSync('memorylane-delen.js', 'utf8');
  toets('7c memorylane-delen.js leest reizen via reizen.js (geen eigen readdir of eigen reisInfo meer)', /require\('\.\/reizen\.js'\)/.test(mlSrc) && /function reisInfo\(rel\) \{ return reizen\.reisInfo\(rel\); \}/.test(mlSrc)
    && /for \(const rel of reizen\.paden\(\)\)/.test(mlSrc) && !/REIS_MAP/.test(mlSrc));

  // ── 8. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('8a dispatch GET /app/tripper/ achter de app-sessie (naast MemoryLane)', src.indexOf("if (route.indexOf('GET /app/tripper/') === 0) return typeof appTripper === 'function' ? appTripper(req, res, a, route) : appWeiger(res, 404, 'onbekend', 'tripper');") > src.indexOf("return appMemorylane(req, res, a, s, route, d);   // wv2114"));
  toets('8b /health.tripper', /tripper: typeof tripperInfo === 'function' \? tripperInfo\(\) : \{ aan: false \}/.test(src));
  toets('8c uitrol-lijst: reizen.js optioneel', /RELEASE_OPTIONEEL="[^"]*\breizen\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  const hb = src.indexOf('// ── OVIS Tripper (wv2136'), he = src.indexOf('// ── einde OVIS Tripper ──');
  toets('8d blokmarkers', hb > 0 && he > hb);
  const gestuurd = [], fl = [];
  const mlNep = { reisKoppeling: koppel };
  const ctx = vm.createContext({ require, __dirname: process.cwd(), path, fs, VAULT: V, VV: () => VV, memorylaneDelen: mlNep, appStaat: { tellers: {} },
    logError: (l, e) => fl.push(l + ' ' + (e && e.message)), appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__tr = { appTripper, tripperInfo, tripper };', ctx, { filename: 'server.js#tripper' });
  const vraag = async (route, a) => { const res = { _app: {} }; const n = gestuurd.length; await ctx.__tr.appTripper({}, res, a || { soort: 'meereizend' }, route); return Object.assign({ app: res._app }, gestuurd[n]); };
  let r = await vraag('GET /app/tripper/lijst');
  toets('8e lijst 200, stil, met de MemoryLane-koppeling uit memorylaneDelen', r.s === 200 && r.j.reizen.length === 10 && r.app.stil === true && r.j.reizen.some((x) => x.memorylane && x.memorylane.stukken === 2), [r.s, r.app]);
  r = await vraag('GET /app/tripper/reis/' + p.id);
  toets('8f reis 200, reden met id, zonder titel of pad', r.s === 200 && r.app.reden === 'tripper reis ' + p.id + ' 200' && /Hotel Verzonnen/.test(r.j.reis.tekst), r.app);
  r = await vraag('GET /app/tripper/reis/..%2F10_Zakelijk%2Fgeheim.md');
  toets('8g pad als id: 400, reden "ongeldig" (het pad komt niet in de audit)', r.s === 400 && r.app.reden === 'tripper reis ongeldig 400', r.app);
  r = await vraag('GET /app/tripper/reis/0123456789ab');
  toets('8h onbekende id: 404', r.s === 404 && r.app.reden === 'tripper reis 0123456789ab 404', r.app);
  r = await vraag('GET /app/tripper/reis/' + p.id + '/meer');
  toets('8i andere route onder /app/tripper/: 404', r.s === 404 && r.app.reden === 'tripper onbekend 404', r.app);
  r = await vraag('GET /app/tripper/lijst', { soort: 'vast' });
  toets('8j vaste plek: dezelfde lijst (wv1901: op alle pc\'s alles)', r.s === 200 && r.j.reizen.length === 10);
  // wv2356: het server-blok rekent met de echte datum (geen vaste vandaag): "Nu bezig" (t/m 2026-11-03) telde tot 3-11 als komend, daarna
  // niet meer en de toets viel om. Verwacht = wat dezelfde lijst als gepland of nu toont (2 of 3), niet een vast getal.
  const komendLijst = r.j.reizen.filter((x) => x.stand === 'gepland' || x.stand === 'nu').length;
  toets('8k tripperInfo: aantallen', ctx.__tr.tripperInfo().reizen === 10 && ctx.__tr.tripperInfo().komend === komendLijst && komendLijst >= 2 && fl.length === 0, [ctx.__tr.tripperInfo(), komendLijst, fl]);
  const ctx2 = vm.createContext({ require, __dirname: path.join(W, 'zonder'), path, fs, VAULT: V, VV: () => VV, memorylaneDelen: null, appStaat: { tellers: {} }, logError: () => {}, appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__tr = { appTripper, tripperInfo };', ctx2, { filename: 'server.js#tripper2' });
  const n2 = gestuurd.length; await ctx2.__tr.appTripper({}, { _app: {} }, {}, 'GET /app/tripper/lijst');
  toets('8l zonder reizen.js in de release: 404 en aan=false', gestuurd[n2].s === 404 && ctx2.__tr.tripperInfo().aan === false);

  // ── 9. T2 (wv2152): vaste kop — vervoer, verblijf (lijst van maps), plekken, kosten alleen met bron ──
  zet('2025 - Vaste kop.md', reis(['type: reis', 'onderwerp: "Vaste kop"', 'periode: "2025-02-09 – 2025-02-15"', 'trip_soort: carbage-run',
    'deelnemers: ["[[20_Prive/Familie/Kees Verzonnen|Kees]]", "Los Zonderpagina", "[[20_Prive/Familie/Kees Verzonnen|Kees]]"]',
    'vervoer: [auto, ferry, raket, Auto]', 'verblijf:', '  - {plaats: "Proefstad", naam: "Hotel Komma, Dubbelepunt: ja", van: "2025-02-09", tot: "2025-02-10"}',
    "  - {plaats: 'Tweede', naam: \"Camping \\\"Aanhalings\\\"\", van: 2025-02-10, tot: 2025-02-12}", '  - plaats: Blokstad', '    naam: Blokhotel', '    van: "2025-02-12"', '    tot: "2025-02-11"',
    '  - {naam: "", plaats: ""}', '  - {plaats: "Kapotte datum", van: "12-02-2025", tot: "morgen"}',
    'plekken:', '  - {naam: "Start", rol: start, lat: 55.60, lon: 13.00}', '  - {naam: "Zonder coord", rol: finish}', '  - {naam: "Halve coord", lat: 55.6}', '  - {naam: "Buiten bereik", lat: 91, lon: 10}',
    '  - {rol: etappe, lat: 1, lon: 1}', 'kosten_totaal: 1928.90', 'kosten_bron: "volgens de pagina"', 'updated: 2026-11-01'], '## Gezelschap\n\n- [[20_Prive/X/Anders|Anders]]\n'));
  zet('2025 - Kosten zonder bron.md', reis(['type: reis', 'onderwerp: "Kosten zonder bron"', 'periode: "2025-03-01 – 2025-03-02"', 'kosten_totaal: 500', 'vervoer:', '  - trein', '  - te-voet']));
  zet('2025 - Per persoon.md', reis(['type: reis', 'onderwerp: "Per persoon"', 'periode: "2025-04-01 – 2025-04-02"', 'kosten_per_persoon: 305.13', 'kosten_bron: "Svens rapportage"', 'kosten_totaal: ongeveer 1500']));
  const m2 = R.maak({ vault: V, vv: VV, vandaag: () => '2026-11-01' });
  const L2 = m2.lijst().body.reizen, op2 = (t) => L2.find((r) => r.titel === t);
  const vk = op2('Vaste kop');
  toets('9a deelnemers: wikilink-naam én naam zonder pagina, dubbel één keer, frontmatter wint van de kop', JSON.stringify(vk.deelnemers) === JSON.stringify(['Kees', 'Los Zonderpagina']), vk.deelnemers);
  toets('9b vervoer in de lijst: alleen vaste woorden, kleine letters, geen dubbele', JSON.stringify(vk.vervoer) === JSON.stringify(['auto', 'ferry']) && JSON.stringify(op2('Kosten zonder bron').vervoer) === JSON.stringify(['trein', 'te-voet']), vk.vervoer);
  toets('9c lijst zonder verblijf, plekken of kosten (alleen in de reis)', !('verblijf' in vk) && !('plekken' in vk) && !('kosten' in vk));
  const dk = m2.reis(vk.id).body.reis;
  toets('9d verblijf: flow-maps met komma en dubbele punt in "…", \'…\', escape, kale datum, blokvorm; tot < van = null; leeg en kapotte datum',
    JSON.stringify(dk.verblijf) === JSON.stringify([{ plaats: 'Proefstad', naam: 'Hotel Komma, Dubbelepunt: ja', van: '2025-02-09', tot: '2025-02-10' },
      { plaats: 'Tweede', naam: 'Camping "Aanhalings"', van: '2025-02-10', tot: '2025-02-12' }, { plaats: 'Blokstad', naam: 'Blokhotel', van: '2025-02-12', tot: null },
      { plaats: 'Kapotte datum', naam: '', van: null, tot: null }]), dk.verblijf);
  toets('9e plekken: coördinaten alleen als beide geldig; zonder naam weg', JSON.stringify(dk.plekken) === JSON.stringify([{ naam: 'Start', rol: 'start', lat: 55.6, lon: 13 },
    { naam: 'Zonder coord', rol: 'finish', lat: null, lon: null }, { naam: 'Halve coord', rol: null, lat: null, lon: null }, { naam: 'Buiten bereik', rol: null, lat: null, lon: null }]), dk.plekken);
  toets('9f kosten met bron: totaal + bron', JSON.stringify(dk.kosten) === JSON.stringify({ totaal: 1928.9, per_persoon: null, bron: 'volgens de pagina' }), dk.kosten);
  toets('9g kosten zonder bron = weggelaten (null)', m2.reis(op2('Kosten zonder bron').id).body.reis.kosten === null);
  const pp = m2.reis(op2('Per persoon').id).body.reis.kosten;
  toets('9h per persoon met bron; een totaal dat geen getal is valt weg', JSON.stringify(pp) === JSON.stringify({ totaal: null, per_persoon: 305.13, bron: 'Svens rapportage' }), pp);
  toets('9i pagina zonder vaste kop: lege lijsten, kosten null', JSON.stringify([d.body.reis.verblijf, d.body.reis.plekken, d.body.reis.kosten, p.vervoer]) === JSON.stringify([[], [], null, []]), d.body.reis);
  const veel = ['type: reis', 'periode: "2025-01-01 – 2025-01-02"', 'verblijf:'].concat(Array.from({ length: 80 }, (_, k) => '  - {plaats: "P' + k + '"}'));
  toets('9j hooguit 60 verblijfsregels', R.verblijfVan(reis(veel)).length === 60);
  toets('9k een volgend veld stopt de lijst (geen items van verblijf in plekken)', R.plekkenVan(reis(['verblijf:', '  - {plaats: "A"}', 'plekken: []', 'x:', '  - {naam: "B"}'])).length === 0
    && R.verblijfVan(reis(['verblijf:', '  - {plaats: "A"}', 'plekken:', '  - {naam: "B"}'])).length === 1);

  // review wv2152: onmogelijke datums, commentaar achter een regel (het sjabloon heeft dat), losse "-" in blokvorm
  const sj = reis(['type: reis', 'periode: "2026-01-01 – 2026-01-02"', 'trip_soort: weekend          # vakantie | weekend', 'vervoer: [auto, trein]   # auto | vliegtuig',
    'deelnemers: ["[[20_Prive/X/Lid Een#Kop|Lid]]", "Los # geen commentaar binnen aanhalingstekens"]   # David niet',
    'verblijf:                     # per adres', '  - {plaats: "Plaats", naam: "Hotel #1", van: "2025-02-31", tot: "2025-13-01"}   # commentaar', '  # losse commentaarregel',
    '  -', '    plaats: Losstreep', '    van: "2024-02-29"   # schrikkeldag', 'plekken:', '  - {naam: "Plaats", rol: bestemming, lat: 52.09, lon: 5.12}   # coördinaten',
    'kosten_totaal: 1234.56        # alleen als de pagina', 'kosten_bron: "waar # het vandaan komt"   # zonder bron']);
  toets('10a commentaar achter de regels van het sjabloon: soort, vervoer, deelnemers, verblijf, plekken en kosten blijven leesbaar',
    R.soortVan(sj) === 'weekend' && JSON.stringify(R.vervoerVan(sj)) === JSON.stringify(['auto', 'trein']) && JSON.stringify(R.deelnemersVan(sj)) === JSON.stringify(['Lid', 'Los # geen commentaar binnen aanhalingstekens'])
    && R.plekkenVan(sj).length === 1 && R.plekkenVan(sj)[0].lat === 52.09 && JSON.stringify(R.kostenVan(sj)) === JSON.stringify({ totaal: 1234.56, per_persoon: null, bron: 'waar # het vandaan komt' }),
    [R.soortVan(sj), R.vervoerVan(sj), R.deelnemersVan(sj), R.plekkenVan(sj), R.kostenVan(sj)]);
  toets('10b onmogelijke datum (31 feb, maand 13) = null; schrikkeldag blijft; losse "-" met sleutels eronder telt',
    JSON.stringify(R.verblijfVan(sj)) === JSON.stringify([{ plaats: 'Plaats', naam: 'Hotel #1', van: null, tot: null }, { plaats: 'Losstreep', naam: '', van: '2024-02-29', tot: null }]), R.verblijfVan(sj));
  toets('10c MemoryLane-lezing (reisInfo/fmVeld) ongemoeid: tags met # in een wikilink en zonder commentaar gelijk', R.fmVeld(sj, 'periode') === '2026-01-01 – 2026-01-02');

  // ── 11. T3 (wv2163): kaart — verblijf op plaatsnaam aan een plek (geen geocoder), lijn in paginavolgorde, één punt per reis ──
  const pl = [{ naam: 'Proefstad', rol: 'start', lat: 50, lon: 5 }, { naam: 'Zion (Springdale)', rol: 'overnachting', lat: 37.2, lon: -113 },
    { naam: 'Lio Grando (Kustdorp)', rol: 'overnachting', lat: null, lon: null }, { naam: 'Punta Proef (Kustdorp)', rol: 'bestemming', lat: 45.4, lon: 12.4 },
    { naam: 'Zonder coord', rol: 'etappe', lat: null, lon: null }, { naam: 'Proefstad', rol: 'finish', lat: 50, lon: 5 }];
  const vb = [{ plaats: 'Zion', naam: 'Camping Rots', van: '2025-07-01', tot: '2025-07-02' }, { plaats: 'kustdorp', naam: 'Hotel Strand', van: null, tot: null },
    { plaats: 'Proefstad', naam: '', van: '2025-06-30', tot: '2025-07-01' }, { plaats: 'Nergensdorp', naam: 'Pension Weg', van: null, tot: null },
    { plaats: 'Zonder coord', naam: 'Hut', van: null, tot: null }, { plaats: '', naam: 'Alleen naam', van: null, tot: null }];
  const K = R.kaartVan(pl, vb);
  toets('11a alleen plekken met coördinaten; start = finish op dezelfde plek één punt met beide rollen',
    JSON.stringify(K.punten.map((p) => [p.naam, p.rollen])) === JSON.stringify([['Proefstad', ['start', 'finish']], ['Zion (Springdale)', ['overnachting']], ['Punta Proef (Kustdorp)', ['bestemming']]]), K.punten);
  toets('11b verblijf: "Zion" = "Zion (Springdale)", hoofdletters gelijk, tussen haakjes ("kustdorp") alleen een plek met coördinaten',
    JSON.stringify(K.punten.map((p) => p.verblijf.map((v) => v.naam))) === JSON.stringify([[''], ['Camping Rots'], ['Hotel Strand']]), K.punten.map((p) => p.verblijf));
  toets('11c zonder plek geteld: onbekende plaats, plek zonder coördinaten, alleen een naam', K.verblijf_zonder_plek === 3, K.verblijf_zonder_plek);
  toets('11d lijn in paginavolgorde, plekken zonder coördinaten overgeslagen; rondreis sluit', JSON.stringify(K.lijn) === JSON.stringify([[50, 5], [37.2, -113], [45.4, 12.4], [50, 5]]), K.lijn);
  toets('11e één punt of niets: geen lijn, leeg = leeg', R.kaartVan([pl[0]], []).lijn.length === 0 && R.kaartVan([pl[0], pl[5]], []).lijn.length === 0
    && JSON.stringify(R.kaartVan([], [])) === JSON.stringify({ punten: [], lijn: [], verblijf_zonder_plek: 0 }) && R.kaartVan(undefined, undefined).punten.length === 0);
  toets('11f punt van de reis: bestemming wint', JSON.stringify(R.kaartPunt(pl)) === JSON.stringify({ lat: 45.4, lon: 12.4 }));
  toets('11g zonder bestemming: het verste punt vanaf de eerste plek (keerpunt); zonder coördinaten null',
    JSON.stringify(R.kaartPunt([pl[0], { naam: 'Dichtbij', lat: 51, lon: 5 }, { naam: 'Ver', lat: 69, lon: 18 }, pl[5]])) === JSON.stringify({ lat: 69, lon: 18 })
    && R.kaartPunt([pl[2], pl[4]]) === null && R.kaartPunt([]) === null);
  const dk3 = m2.reis(op2('Vaste kop').id).body.reis;
  toets('11h de reis heeft kaart {punten, lijn, verblijf_zonder_plek} uit de vaste kop (Proefstad = start)', dk3.kaart && dk3.kaart.punten.length === 1 && dk3.kaart.punten[0].naam === 'Start'
    && dk3.kaart.verblijf_zonder_plek === 4 && dk3.kaart.lijn.length === 0, dk3.kaart);
  toets('11i lijst: punt per reis (of null), geen plekken of kaart in de lijst', op2('Vaste kop').punt && op2('Vaste kop').punt.lat === 55.6 && op2('Per persoon').punt === null
    && !('kaart' in op2('Vaste kop')) && !('plekken' in op2('Vaste kop')), op2('Vaste kop'));

  // ── 12. T4 (wv2172): nog te regelen en geannuleerd ──
  const V4 = path.join(W, 'vault4'), RM4 = path.join(V4, R.REIS_MAP);
  fs.mkdirSync(RM4, { recursive: true });
  const zet4 = (n, t) => fs.writeFileSync(path.join(RM4, n), t);
  zet4('2027 - Gepland.md', reis(['type: reis', 'onderwerp: "Gepland"', 'periode: "2027-03-01 – 2027-03-05"'],
    '# Gepland\n\n## Openbaar vervoer\n\nGeen kop voor regelen.\n\n## Nog te regelen\n\n- [ ] Verblijf boeken\n- [x] Vrij gevraagd\n  - [ ] sub telt mee\n* [ ] Hond naar oppas\n\n### Detail\n\nnog binnen\n\n## Verloop\n\nNiet meer.\n'));
  zet4('2026 - Geweest.md', reis(['type: reis', 'onderwerp: "Geweest"', 'periode: "2026-07-01 – 2026-07-05"'], '## Nog te regelen\n\n- [ ] Oud punt\n'));
  zet4('2027 - Open kop.md', reis(['type: reis', 'onderwerp: "Open kop"', 'periode: "2027-04-01 – 2027-04-02"'],
    '## Open / nog te verwerken\n\n- **Iets** geregeld.\n\n<!-- sb:generated id="verbonden" begin -->\nX\n'));
  zet4('2027 - Geannuleerd.md', reis(['type: reis', 'onderwerp: "Geannuleerd"', 'status: geannuleerd   # David', 'periode: "2027-05-01 – 2027-05-02"'], '## Nog te regelen\n\n- [ ] x\n'));
  zet4('2027 - Lang.md', reis(['type: reis', 'onderwerp: "Lang"', 'periode: "2027-06-01 – 2027-06-02"'], '## Te regelen\n\n' + '- [ ] punt met wat tekst erachter\n'.repeat(200)));
  const m4 = R.maak({ vault: V4, vv: VV, vandaag: () => '2026-11-01' }), L4 = m4.lijst().body.reizen, op4 = (t) => L4.find((r) => r.titel === t);
  const g4 = m4.reis(op4('Gepland').id).body.reis;
  toets('12a te_regelen: eerste passende kop (niet "Openbaar vervoer"), tot de volgende ##, ### hoort erbij; open/klaar geteld',
    g4.te_regelen && g4.te_regelen.kop === 'Nog te regelen' && /Hond naar oppas/.test(g4.te_regelen.tekst) && /nog binnen/.test(g4.te_regelen.tekst) && !/Niet meer/.test(g4.te_regelen.tekst)
    && !/Geen kop/.test(g4.te_regelen.tekst) && g4.te_regelen.open === 3 && g4.te_regelen.klaar === 1 && g4.te_regelen.afgekapt === false, g4.te_regelen);
  toets('12b lijst: te_regelen_open bij een komende reis, null bij een geweest reis, en geen tekst in de lijst',
    op4('Gepland').te_regelen_open === 3 && op4('Geweest').te_regelen_open === null && !JSON.stringify(L4).includes('Verblijf boeken'), L4.map((r) => [r.titel, r.te_regelen_open]));
  toets('12c geweest: geen te_regelen in de reis', m4.reis(op4('Geweest').id).body.reis.te_regelen === null);
  const o4 = m4.reis(op4('Open kop').id).body.reis.te_regelen;
  toets('12d "## Open / nog te verwerken" telt; stopt bij een gegenereerd blok; zonder takenlijst open 0', o4 && o4.kop === 'Open / nog te verwerken' && o4.open === 0 && !/sb:generated/.test(o4.tekst), o4);
  const l4 = m4.reis(op4('Lang').id).body.reis.te_regelen;
  toets('12e lange lijst afgekapt op een regel met …, hooguit 4000 tekens + …', l4.afgekapt && l4.tekst.length <= 4003 && /\n\n…$/.test(l4.tekst) && /erachter\n\n…$/.test(l4.tekst), [l4.tekst.length, l4.tekst.slice(-40)]);
  const a4 = op4('Geannuleerd');
  toets('12f status: geannuleerd (met commentaar) = stand geannuleerd, niet komend, geen te_regelen; info telt hem niet als komend',
    a4.stand === 'geannuleerd' && a4.te_regelen_open === null && m4.reis(a4.id).body.reis.te_regelen === null && m4.info().komend === 3, [a4.stand, m4.info()]);
  toets('12g geannuleerd: reisInfo null (MemoryLane maakt er geen herinnering van); een gewone reis wel',
    m4.reisInfo('20_Prive/Reizen/2027 - Geannuleerd.md') === null && m4.reisInfo('20_Prive/Reizen/2027 - Gepland.md').van === '2027-03-01');
  toets('12h geannuleerd() leest alleen het statusveld', R.geannuleerd('---\nstatus: "geannuleerd"\n---\n') && !R.geannuleerd('---\nstatus: actueel\n---\ngeannuleerd\n') && !R.geannuleerd('geen fm'));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
