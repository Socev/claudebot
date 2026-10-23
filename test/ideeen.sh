#!/usr/bin/env bash
# Toetst ideeen.js (wv761, App Ideeën van buitenaf; bouwplan "01_Ontwikkeling/Ideeënbeurs met Albert van der Veer (ontwerp 22-10-2026).md")
# en de koppeling in server.js, tegen een nagebootst forum. Toetst: alleen forum ideeen (een draad die intussen in agents staat telt niet
# mee, een reactie naar een agents-draad wordt geweigerd vóór het posten), kaartvorm en draad zonder kaart, groepen ons/buiten, teller
# nieuw sinds gezien, gezien alleen vooruit, reactie (leeg, > 800, gesloten, als david), plaatje alleen uit een ideeen-draad, Naar de
# Ideeënbus op een kopie van de echte bus (rest byte-gelijk, genre geparkeerd, dubbel = 409, idee van ons = 409, conflictkopie = 409,
# tekst van buiten zonder tabel-/linktekens), forum onbereikbaar = 502, en server.js (dispatch, glijdroutes, health, reservekant,
# BSN-masker op een vaste plek, de forumaanroep met de sleutel in de kop). Raakt de echte vault en het echte forum niet.
# Gebruik: bash test/ideeen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const I = require('./ideeen.js'), H = require('./harvester.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ideeen-toets-'));
const VAULT = path.join(W, 'vault'), DIR = path.join(W, 'staat');
fs.mkdirSync(path.join(VAULT, '01_Ontwikkeling'), { recursive: true });
const ECHTE_BUS = '/opt/data/AI_SecondBrain/' + I.BUS_PAD;
const busTekst = fs.existsSync(ECHTE_BUS) ? fs.readFileSync(ECHTE_BUS, 'utf8') : '# Bus\n\n| # | Idee | Genre | % | Kort | Stand |\n|---|---|---|---|---|---|\n| 1 | Eerste | x | 10 | k | s |\n';
const BUS = path.join(VAULT, I.BUS_PAD);
fs.writeFileSync(BUS, busTekst);

// ── nagebootst forum (zoals de API van fase 1 het de podsleutel geeft: ruwe auteur + van) ──
const F = { draden: {}, aanroepen: [], weg: false };
let bid = 100;
function draad(id, forum, van, kaart, extra = {}) {
  F.draden[id] = { draad: { id, forum, titel: kaart ? kaart.titel : 'losse titel', gemaakt_door: van, gemaakt_op: '2026-10-23T08:00:00Z', laatste_op: '2026-10-23T0' + (id % 10) + ':00:00Z', kaart, gesloten: 0, ...extra },
    berichten: [{ id: ++bid, auteur: van, van, soort: 'bot', tekst: kaart ? kaart.wat + '\n\nWil je meer weten? Vraag het hieronder.' : 'eerste [img]/api/afbeelding/9[/img] tekst', gemaakt_op: '2026-10-23T08:00:00Z' }] };
}
const K = (titel, x = {}) => ({ titel, wat: 'Het doet iets. Zo simpel.', waarom: 'Scheelt tijd.', status: 'in gebruik', ...x });
draad(1, 'ideeen', 'socev', K('Ja / Nee / Anders'));
draad(2, 'ideeen', 'appie', K('Ochtendbriefing | met [[link]] en `code`', { plaatje: 7, wat: 'Leest de agenda https://boos.example voor. Klaar.' }));
draad(3, 'ideeen', 'albert@voorbeeld.nl', null);
F.draden[3].berichten[0].van = 'albert';
draad(4, 'agents', 'socev', K('Stiekem agents'));
F.draden[2].berichten.push({ id: ++bid, auteur: 'albert@voorbeeld.nl', van: 'albert', soort: 'mens', tekst: 'Vraag van Albert [img]/api/afbeelding/8[/img]', gemaakt_op: '2026-10-23T09:00:00Z' });
F.draden[2].berichten.push({ id: ++bid, auteur: 'appie', van: 'appie', soort: 'bot', tekst: 'weg', gemaakt_op: '2026-10-23T09:10:00Z', gewist: 1 });
async function forum(m, pad, body) {
  F.aanroepen.push([m, pad, body]);
  if (F.weg) throw new Error('ECONNREFUSED');
  let x;
  if (m === 'GET' && (x = /^draden\?forum=(\w+)$/.exec(pad))) {
    // de echte API filtert op forum; hier zit er bewust een agents-draad tussen om de eigen controle van ideeen.js te toetsen
    const l = Object.values(F.draden).filter((d) => d.draad.forum === x[1] || d.draad.id === 4).map((d) => ({ ...d.draad, n: d.berichten.length, laatste_bericht_id: d.berichten.at(-1).id }));
    return { status: 200, j: { ok: true, draden: l } };
  }
  if (m === 'GET' && (x = /^draad\/(\d+)\?stil=1$/.exec(pad))) { const d = F.draden[x[1]]; return d ? { status: 200, j: { ok: true, ...JSON.parse(JSON.stringify(d)) } } : { status: 404, j: { ok: false } }; }
  if (m === 'POST' && (x = /^draad\/(\d+)\/bericht$/.exec(pad))) {
    const d = F.draden[x[1]]; if (!d) return { status: 404, j: { ok: false } };
    if (body.tekst.length > 800) return { status: 422, j: { ok: false, fout: 'reactie: hooguit 800 tekens' } };
    const id = ++bid; d.berichten.push({ id, auteur: body.als || 'pod', van: body.als || 'pod', tekst: body.tekst, gemaakt_op: new Date().toISOString(), via: 'pod' });
    return { status: 200, j: { ok: true, id } };
  }
  if (m === 'GET' && (x = /^afbeelding\/(\d+)\?forum=ideeen$/.exec(pad))) return { status: 200, bin: Buffer.from('PNGDATA' + x[1]), type: 'image/png' };
  if (m === 'POST' && pad === 'draad') {
    // wv861: kaart plaatsen (zoals de forum-API van fase 1: kaartvorm in ideeen, 422 bij een te lange wat)
    if (F.plaatsFout === 'weg') throw new Error('ETIMEDOUT');
    if (F.plaatsFout === 422 || body.kaart.wat.length > 300) return { status: 422, j: { ok: false, fout: 'wat: te lang', veld: 'wat' } };
    const id = 200 + Object.keys(F.draden).length;
    draad(id, body.forum, body.als || 'pod', body.kaart);
    return { status: 200, j: { ok: true, id, forum: body.forum, kaart: body.kaart } };
  }
  return { status: 404, j: { ok: false, fout: 'onbekend' } };
}
let nu = Date.parse('2026-10-23T10:00:00Z');
const M = I.maak({ vault: VAULT, dir: DIR, forum, klok: () => nu, harvester: H });
M.mkdir();

(async function () {
  // ── 1. lezen ──
  let r = await M.app('GET /app/ideeen');
  const k = (id) => r.j.kaarten.find((x) => x.id === id);
  toets('1 GET 200 met drie kaarten uit ideeen (agents-draad die het forum toch meestuurt telt niet)', r.status === 200 && r.j.kaarten.length === 3 && !k(4), r.j.kaarten && r.j.kaarten.map((x) => x.id));
  toets('1 groepen: socev = ons, appie en albert = buiten', k(1).groep === 'ons' && k(2).groep === 'buiten' && k(3).groep === 'buiten' && k(3).van === 'albert', r.j.kaarten.map((x) => [x.id, x.groep, x.van]));
  toets('1 kaartvelden en plaatje; draad zonder kaart: wat uit de eerste tekst, kaartvorm false', k(2).kaartvorm && k(2).plaatje === 7 && k(2).status === 'in gebruik' && !k(3).kaartvorm && k(3).wat === 'eerste tekst', [k(2), k(3)]);
  toets('1 reacties: plaatje eruit als nummer, gewist leeg', k(2).reacties[0].tekst === 'Vraag van Albert' && k(2).reacties[0].plaatjes[0] === 8 && k(2).reacties[1].gewist && k(2).reacties[1].tekst === '', k(2).reacties);
  toets('1 teller nieuw: buiten-berichten na gezien (0) = kaart 2 (1 + reactie Albert), kaart 3 (1); gewist telt niet', r.j.nieuw === 3 && k(2).nieuw === 2 && k(3).nieuw === 1 && k(1).nieuw === 0, r.j.kaarten.map((x) => [x.id, x.nieuw]));
  toets('1 zonder catalogus: concepten leeg, catalogus false met reden', Array.isArray(r.j.concepten) && r.j.concepten.length === 0 && r.j.catalogus === false && /staat er \(nog\) niet/.test(r.j.catalogus_fout), r.j);
  const n0 = F.aanroepen.length;
  await M.app('GET /app/ideeen');
  toets('1 cache: tweede GET binnen 20 s leest het forum niet opnieuw', F.aanroepen.length === n0, F.aanroepen.length - n0);
  nu += 30000;
  await M.app('GET /app/ideeen');
  toets('1 na 20 s: alleen de lijst, ongewijzigde draden uit de cache', F.aanroepen.length === n0 + 1, F.aanroepen.slice(n0));
  // ── 2. gezien ──
  let g = await M.app('POST /app/ideeen/gezien', { tot: r.j.max_id });
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('2 gezien tot max: teller 0', g.status === 200 && r.j.nieuw === 0, r.j.nieuw);
  g = await M.app('POST /app/ideeen/gezien', { tot: 1 });
  toets('2 gezien gaat niet terug', g.j.gezien_tot === r.j.max_id, g.j);
  toets('2 gezien zonder getal = 400', (await M.app('POST /app/ideeen/gezien', { tot: 'x' })).status === 400);
  toets('2 staat 0600 in een map 0700', (fs.statSync(path.join(DIR, 'staat.json')).mode & 0o777) === 0o600 && (fs.statSync(DIR).mode & 0o777) === 0o700);
  // ── 3. reactie ──
  r = await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: '  Leuk!\r\nHoe lang bouwen?  ' });
  toets('3 reactie 200, als david, regels behouden, getrimd', r.status === 200 && F.aanroepen.some((a) => a[0] === 'POST' && a[1] === 'draad/2/bericht' && a[2].als === 'david' && a[2].tekst === 'Leuk!\nHoe lang bouwen?'), F.aanroepen.at(-1));
  nu += 1000; r = await M.app('GET /app/ideeen');
  toets('3 na reageren meteen vers gelezen; eigen reactie van david telt niet als nieuw', k(2).reacties.some((x) => x.van === 'david' && !x.nieuw) && r.j.nieuw === 0, k(2).reacties);
  let na = F.aanroepen.length;
  r = await M.app('POST /app/ideeen/reactie', { draad: 4, tekst: 'via de app naar agents?' });
  toets('3 reactie naar een agents-draad = 404 en niets gepost', r.status === 404 && !F.aanroepen.slice(na).some((a) => a[0] === 'POST'), F.aanroepen.slice(na));
  toets('3 lege reactie = 400', (await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: '   ' })).status === 400);
  toets('3 801 tekens = 422 zonder forumaanroep', (await M.app('POST /app/ideeen/reactie', { draad: 2, tekst: 'a'.repeat(801) })).status === 422);
  toets('3 onbekende draad = 404', (await M.app('POST /app/ideeen/reactie', { draad: 99, tekst: 'x' })).status === 404 && (await M.app('POST /app/ideeen/reactie', { draad: 'x', tekst: 'x' })).status === 404);
  F.draden[1].draad.gesloten = 1;
  toets('3 gesloten draad = 409', (await M.app('POST /app/ideeen/reactie', { draad: 1, tekst: 'x' })).status === 409);
  F.draden[1].draad.gesloten = 0;
  // ── 4. plaatje ──
  r = await M.app('GET /app/ideeen/plaatje/7');
  toets('4 plaatje van een kaart: 200 base64 png', r.status === 200 && r.j.type === 'image/png' && Buffer.from(r.j.inhoud, 'base64').toString() === 'PNGDATA7', r);
  toets('4 plaatje uit een reactie: 200', (await M.app('GET /app/ideeen/plaatje/8')).status === 200);
  toets('4 plaatje dat nergens in ideeen staat (bv. uit intern) = 404', (await M.app('GET /app/ideeen/plaatje/3')).status === 404 && !F.aanroepen.some((a) => a[1] === 'afbeelding/3'));
  // ── 5. naar de Ideeënbus ──
  const voor = fs.readFileSync(BUS, 'utf8');
  r = await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 });
  const na5 = fs.readFileSync(BUS, 'utf8');
  const bus = H.leesBus(na5), oud = H.leesBus(voor);
  const nieuwIdee = bus.ideeen.find((i) => i.nr === r.j.idee_nr);
  toets('5 naar de bus: 200, nieuw nummer, genre geparkeerd', r.status === 200 && nieuwIdee && nieuwIdee.genre === I.GENRE && r.j.idee_nr === Math.max(...oud.ideeen.map((i) => i.nr)) + 1, { r, nieuwIdee });
  toets('5 titel zonder | [ ] ` en zonder link', nieuwIdee && !/[|\[\]`]/.test(nieuwIdee.titel) && !/https?:/.test(na5.slice(voor.length - 10)), nieuwIdee);
  toets('5 herkomst Appie/Albert in het blok', /Herkomst: Appie \(assistent van Albert van der Veer\), via de Ideeënbeurs/.test(na5));
  const zonder = na5.split('\n').filter((l, i, a) => true);
  toets('5 rest van de bus byte-gelijk (alleen één rij erbij en een blok onderaan)', (() => { const v = voor.split('\n'), n = na5.split('\n'); const rij = n.findIndex((l, i) => l !== v[i]); const n2 = n.slice(0, rij).concat(n.slice(rij + 1)); return n2.slice(0, v.length).join('\n').replace(/\s*$/, '') === voor.replace(/\s*$/, ''); })());
  toets('5 tweede keer = 409 (staat er al)', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 })).status === 409);
  toets('5 idee van ons = 409', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 1 })).status === 409);
  toets('5 agents-draad = 404', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 4 })).status === 404);
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('5 GET: kaart 2 op de bus met nummer', k(2).idee_nr > 0 && k(2).op_bus === true, k(2));
  fs.writeFileSync(BUS + '.conflict1', 'x');
  toets('5 conflictkopie naast de bus = 409', (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 3 })).status === 409);
  fs.unlinkSync(BUS + '.conflict1');
  fs.writeFileSync(BUS, voor);   // bus teruggezet: kaart 2 mag dan opnieuw
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('5 bus teruggezet: op_bus false, opnieuw kan', k(2).op_bus === false && (await M.app('POST /app/ideeen/naar-ideeenbus', { draad: 2 })).status === 200, k(2));
  // ── 6. forum weg ──
  F.weg = true; nu += 30000;
  r = await M.app('GET /app/ideeen');
  toets('6 forum onbereikbaar: 502 met gewone taal, health fout', r.status === 502 && /niet te lezen/.test(r.j.fout) && M.health().fout, r);
  F.weg = false;

  // ── 8. fase 2 (wv861): catalogus, vaste toets, Deel/Niet, plaatsen na de Ja ──
  const CAT = path.join(VAULT, I.CATALOGUS);
  const blok = (id, titel, wat, x = {}) => '### ' + id + ' · ' + titel + '\n- titel: ' + titel + '\n- wat: ' + wat + '\n- waarom: ' + (x.waarom || 'Scheelt tijd.') + '\n- status: ' + (x.status || 'in gebruik') + '\n- bron: wv1 intern\n- deelbaar: ' + (x.deelbaar || 'concept') + '\n- gedeeld op:\n- draad:\n';
  const catTekst = '# Catalogus\n\n' + [blok('K01', 'Knoppen onder elke vraag', 'Drie knoppen onder elke vraag.'), blok('K02', 'Voorlezen', 'Een knop leest het antwoord voor.'),
    blok('K03', 'Iets met de praktijk', 'Op Tolgaarde werkt dit al.'), blok('K04', 'Geheim', 'Niet delen.', { deelbaar: 'privé' }),
    blok('K05', 'Te lang', 'x'.repeat(301)), blok('K06', 'Derde', 'Nog een kaart.')].join('\n');
  fs.writeFileSync(CAT, catTekst);
  const naamToets = { toets: (t) => /Jorien/.test(t) ? [{ soort: 'naam', treffer: 'Jorien' }] : [] };
  nu += 30000; r = await M.app('GET /app/ideeen');
  const ck = (id) => r.j.concepten.find((x) => x.id === id);
  toets('8 catalogus gelezen: concepten zonder privé, bron gaat niet mee', r.j.catalogus === true && r.j.concepten.length === 5 && !ck('k04') && !('bron' in ck('k01')), r.j.concepten && r.j.concepten.map((x) => x.id));
  toets('8 vaste toets live: praktijknaam = treffer, kan niet delen', ck('k03').treffers.some((t) => /praktijk/.test(t.soort)) && ck('k03').kan_delen === false && ck('k01').kan_delen === true, ck('k03'));
  toets('8 vormfout (wat > 300) = kan niet delen', ck('k05').vormfout.length > 0 && ck('k05').kan_delen === false, ck('k05'));
  toets('8 geen bundel: bundel.open false, aangevinkt 0', r.j.bundel && r.j.bundel.open === false && r.j.bundel.aangevinkt === 0, r.j.bundel);
  let kz = await M.app('POST /app/ideeen/kaart/k01/deel', { __apparaat: 'tel1' });
  toets('8 Deel op een schone kaart: 200, in het journaal (0600, met hash en apparaat)', kz.status === 200 && (fs.statSync(path.join(DIR, 'journaal.jsonl')).mode & 0o777) === 0o600 && /"soort":"keuze","id":"k01","keuze":"deel","hash":"[a-f0-9]{16}","apparaat":"tel1"/.test(fs.readFileSync(path.join(DIR, 'journaal.jsonl'), 'utf8')), kz);
  toets('8 Deel op een kaart met treffer = 409 met reden; Niet mag wel', (await M.app('POST /app/ideeen/kaart/k03/deel')).status === 409 && (await M.app('POST /app/ideeen/kaart/k03/niet')).status === 200);
  toets('8 Deel op privé of onbekend = 404', (await M.app('POST /app/ideeen/kaart/k04/deel')).status === 404 && (await M.app('POST /app/ideeen/kaart/k99/deel')).status === 404);
  await M.app('POST /app/ideeen/kaart/k02/deel'); await M.app('POST /app/ideeen/kaart/k06/deel'); await M.app('POST /app/ideeen/kaart/k06/niet');
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 keuzes zichtbaar: k01 deel, k02 deel, k03 niet, k06 niet (laatste wint); aangevinkt 2', ck('k01').keuze === 'deel' && ck('k02').keuze === 'deel' && ck('k03').keuze === 'niet' && ck('k06').keuze === 'niet' && r.j.bundel.aangevinkt === 2, r.j.concepten.map((x) => [x.id, x.keuze]));
  // tekst van k02 verandert na de Deel: keuze vervalt (gewijzigd), telt niet meer mee
  fs.writeFileSync(CAT, catTekst.replace('Een knop leest het antwoord voor.', 'Een knop leest elk antwoord voor.'));
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 tekst gewijzigd na Deel: keuze vervalt (gewijzigd true), aangevinkt 1', ck('k02').keuze === null && ck('k02').gewijzigd === true && r.j.bundel.aangevinkt === 1, ck('k02'));
  await M.app('POST /app/ideeen/kaart/k02/deel');
  // plaatsen
  toets('8 bundelVoor zonder bundel.json = null', M.bundelVoor('wv950') === null);
  fs.writeFileSync(path.join(DIR, 'bundel.json'), JSON.stringify({ kaart: 'wv950', gemaakt: '2026-10-23' }));
  toets('8 bundelVoor: andere kaart = null, eigen kaart = aangevinkt 2', M.bundelVoor('wv951') === null && M.bundelVoor('wv950').aangevinkt === 2, M.bundelVoor('wv950'));
  const voorPlaats = F.aanroepen.filter((a) => a[0] === 'POST' && a[1] === 'draad').length;
  toets('8 zonder verse vingerafdruk (knop-ja-kaart, knop-ja-vers-vast-kaart) niets geplaatst, bundel blijft open',
    (await M.plaatsBundel({ kaart: 'wv950', bevestiging: 'knop-ja-kaart' })).ok === false && (await M.plaatsBundel({ kaart: 'wv950', bevestiging: 'knop-ja-vers-vast-kaart' })).ok === false &&
    F.aanroepen.filter((a) => a[0] === 'POST' && a[1] === 'draad').length === voorPlaats && M.bundelVoor('wv950') !== null);
  toets('8 andere kaart dan de bundel: niets', (await M.plaatsBundel({ kaart: 'wv951', bevestiging: I.BEVESTIGING_PLAATSEN })).ok === false);
  // k01 krijgt intussen een naam erin via de toets? nee: k01 blijft schoon; k02 en k01 gaan, k03/k05/k06 niet
  let u = await M.plaatsBundel({ kaart: 'wv950', bevestiging: I.BEVESTIGING_PLAATSEN, vraagId: 'abcd1234' });
  const geplaatst = F.aanroepen.filter((a) => a[0] === 'POST' && a[1] === 'draad').slice(voorPlaats);
  toets('8 Ja met verse vingerafdruk: precies k01 en k02 geplaatst, als socev in ideeen, alleen kaartvelden (geen bron)', u.geplaatst.map((x) => x.id).join() === 'k01,k02' && geplaatst.length === 2 &&
    geplaatst.every((a) => a[2].forum === 'ideeen' && a[2].als === 'socev' && Object.keys(a[2].kaart).join() === 'titel,wat,waarom,status'), { u, geplaatst });
  toets('8 bundel afgehandeld: tweede Ja plaatst niets', (await M.plaatsBundel({ kaart: 'wv950', bevestiging: I.BEVESTIGING_PLAATSEN })).ok === false && !!M.bundelVoor('wv950').afgehandeld && M.isBundel('wv950') && !M.isBundel('wv951'), M.bundelVoor('wv950'));
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 na plaatsen: k01/k02 niet meer in concepten, wel als kaart van ons; plaatsing in GET en health', !ck('k01') && !ck('k02') && r.j.kaarten.filter((x) => x.groep === 'ons' && /Knoppen|Voorlezen/.test(x.titel)).length === 2 &&
    r.j.plaatsing.geplaatst === 2 && M.health().plaatsing.geplaatst === 2 && M.health().catalogus.concepten === 3, { p: r.j.plaatsing, h: M.health() });
  toets('8 Deel op een al gedeelde kaart = 404 (niet meer concept-in-de-tab) of 409', [404, 409].includes((await M.app('POST /app/ideeen/kaart/k01/deel')).status));
  // forum weigert (422) = plaats-fout, zeker niet geplaatst; forum weg = onzeker, nooit vanzelf opnieuw
  fs.writeFileSync(CAT, catTekst + '\n' + blok('K07', 'Zevende', 'Kaart zeven.') + '\n' + blok('K08', 'Achtste', 'Kaart acht.'));
  await M.app('POST /app/ideeen/kaart/k07/deel'); await M.app('POST /app/ideeen/kaart/k08/deel');
  fs.writeFileSync(path.join(DIR, 'bundel.json'), JSON.stringify({ kaart: 'wv952' }));
  F.plaatsFout = 422;
  u = await M.plaatsBundel({ kaart: 'wv952', bevestiging: I.BEVESTIGING_PLAATSEN });
  toets('8 forum 422: plaats-fout, niets geplaatst', u.geplaatst.length === 0 && u.fouten.length === 2, u);
  fs.writeFileSync(path.join(DIR, 'bundel.json'), JSON.stringify({ kaart: 'wv953' }));
  F.plaatsFout = 'weg';
  u = await M.plaatsBundel({ kaart: 'wv953', bevestiging: I.BEVESTIGING_PLAATSEN });
  toets('8 forum weg: onzeker gemeld', u.geplaatst.length === 0 && u.fouten.every((x) => /onzeker/.test(x.reden)), u);
  F.plaatsFout = null;
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 onzeker = bezig: kan niet delen en Deel/Niet geweigerd', ck('k07').bezig === true && ck('k07').kan_delen === false && (await M.app('POST /app/ideeen/kaart/k07/niet')).status === 409, ck('k07'));
  fs.writeFileSync(path.join(DIR, 'bundel.json'), JSON.stringify({ kaart: 'wv954' }));
  u = await M.plaatsBundel({ kaart: 'wv954', bevestiging: I.BEVESTIGING_PLAATSEN });
  toets('8 volgende bundel: onzekere kaart overgeslagen, nooit dubbel geplaatst', u.geplaatst.length === 0 && u.overgeslagen.some((x) => /onzeker/.test(x.reden)), u);
  // nakijk (Fable #6): k07/k08 hangen op bezig; zet er één draad van socev met de titel van k07 neer, k08 niet
  draad(250, 'ideeen', 'socev', K('Zevende'));
  const nk = await M.nakijk();
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 nakijk: k07 op het forum gevonden = gedeeld (uit de concepten), k08 niet = plaats-fout, weer te kiezen', nk.ok && nk.nagekeken === 2 && nk.uit.find((x) => x.id === 'k07').draad === 250 && !ck('k07') && ck('k08') && ck('k08').bezig === false && /niet op het forum gevonden/.test(ck('k08').fout || '') && (await M.app('POST /app/ideeen/kaart/k08/niet')).status === 200, { nk, k08: ck('k08') });
  toets('8 nakijk zonder hangende kaarten: niets te doen, geen forumaanroep', (await M.nakijk()).nagekeken === 0);
  // catalogus onleesbaar ná de Ja (Fable #10): bundel blijft open
  fs.writeFileSync(path.join(DIR, 'bundel.json'), JSON.stringify({ kaart: 'wv955' }));
  fs.writeFileSync(CAT.replace(/\.md$/, '.conflict2.md'), 'x');
  u = await M.plaatsBundel({ kaart: 'wv955', bevestiging: I.BEVESTIGING_PLAATSEN });
  toets('8 catalogus dicht bij plaatsen: niets geplaatst en bundel niet verbruikt', u.geplaatst.length === 0 && u.fouten.length === 1 && M.bundelVoor('wv955') && !M.bundelVoor('wv955').afgehandeld, { u, b: M.bundelVoor('wv955') });
  fs.unlinkSync(CAT.replace(/\.md$/, '.conflict2.md'));
  // meer dan bundel_max (Fable #12): overgeslagen gemeld
  const veel = Array.from({ length: I.GRENS.bundel_max + 2 }, (_, i) => blok('K' + (110 + i), 'Veel ' + i, 'Kaart nummer veel.')).join('\n');
  fs.writeFileSync(CAT, catTekst + '\n' + veel);
  for (let i = 0; i < I.GRENS.bundel_max + 2; i++) await M.app('POST /app/ideeen/kaart/k' + (110 + i) + '/deel');
  u = await M.plaatsBundel({ kaart: 'wv955', bevestiging: I.BEVESTIGING_PLAATSEN });
  toets('8 boven ' + I.GRENS.bundel_max + ' in één bundel: rest overgeslagen met reden', u.geplaatst.length === I.GRENS.bundel_max && u.overgeslagen.filter((x) => /meer dan/.test(x.reden)).length === 2, { g: u.geplaatst.length, o: u.overgeslagen });
  fs.writeFileSync(CAT, catTekst);
  // vaste toets als waarschuwing
  const M2 = I.maak({ vault: VAULT, dir: path.join(W, 'staat2'), forum, klok: () => nu, harvester: H, filter: naamToets });
  let tz = await M2.app('POST /app/ideeen/toets', { tekst: 'Groet aan Jorien' });
  toets('8 toets: treffers terug, status 200 (nooit blokkeren)', tz.status === 200 && tz.j.treffers.length === 1 && tz.j.toets === true, tz);
  toets('8 toets: schone tekst geen treffers', (await M2.app('POST /app/ideeen/toets', { tekst: 'Leuk idee!' })).j.treffers.length === 0);
  toets('8 reactie met een naam wordt gewoon geplaatst (waarschuwing is alleen in de app)', (await M2.app('POST /app/ideeen/reactie', { draad: 2, tekst: 'Groet aan Jorien' })).status === 200);
  // catalogus met conflictkopie: dicht
  fs.writeFileSync(CAT.replace(/\.md$/, '.conflict1.md'), 'x');
  nu += 30000; r = await M.app('GET /app/ideeen');
  toets('8 conflictkopie naast de catalogus: catalogus false met reden, Deel = 503', r.j.catalogus === false && /conflictkopie/.test(r.j.catalogus_fout) && (await M.app('POST /app/ideeen/kaart/k08/niet')).status === 503, r.j.catalogus_fout);
  fs.unlinkSync(CAT.replace(/\.md$/, '.conflict1.md'));

  // ── 7. server.js-koppeling (vm) ──
  const src = fs.readFileSync('server.js', 'utf8');
  const s1 = src.indexOf('// ── Ideeënbeurs (wv761'), s2 = src.indexOf('// ── einde ideeënbeurs ──');
  toets('7 server.js: blok gevonden', s1 > 0 && s2 > s1);
  toets('7 server.js: dispatch, glijdroutes, health', /route === 'GET \/app\/ideeen' \|\| route\.indexOf\('GET \/app\/ideeen\/plaatje\/'\) === 0 \|\| route === 'POST \/app\/ideeen\/reactie' \|\| route === 'POST \/app\/ideeen\/gezien' \|\| route === 'POST \/app\/ideeen\/naar-ideeenbus' \|\|\n\s+\/\^POST \\\/app\\\/ideeen\\\/kaart\\\/k\\d\{2,3\}\\\/\(deel\|niet\)\$\/\.test\(route\) \|\| route === 'POST \/app\/ideeen\/toets'\)/.test(src) &&
    /\['POST \/app\/ideeen\/reactie', 'POST \/app\/ideeen\/naar-ideeenbus'\]\.forEach\(function \(r\) \{ APP_GLIJD_ROUTES\.add\(r\); \}\)/.test(src) && /ideeen: typeof ideeenInfo === 'function' \? ideeenInfo\(\)/.test(src));
  toets('7 uitrol.sh neemt ideeen-filter.js mee (wv861), Dockerfile ook', /^RELEASE_OPTIONEEL="[^"]*\bideeen-filter\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY ideeen-filter\.js \/app\/release-bootstrap\/ideeen-filter\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  toets('7 toets is slotvrij (lezen), Deel/Niet en toets in de dispatch, teller ideeen-toets', /APP_SLOT_VRIJ\.add\('POST \/app\/ideeen\/toets'\)/.test(src) && /'ideeen-toets'\]\.forEach/.test(src));
  toets('7 appKnop: haak naStart pas na een geslaagde start, met de bevestiging van appKnopBevestiging', /if \(!st\.job_id\) \{[\s\S]{0,400}return appStartFout\(res, st\);\n  \}\n[^\n]*\n  \/\/ wv921[^\n]*\n  if \(kaart && kaart\.naStart\) \{ try \{ kaart\.naStart\(keuze, gevoeligJa, a, appKnopBevestiging\(keuze, gevoeligJa, a, true\), hash\)/.test(src));
  toets('7 appVoorJouKnop: bundelkaart via ideeen.bundelVoor, plaatsen alleen bij ja via plaatsBundel met de bevestiging', /ib = typeof ideeen !== 'undefined' && ideeen && typeof ideeen\.bundelVoor === 'function' \? ideeen\.bundelVoor\(p\.sleutel\)/.test(src) && /if \(kz !== 'ja'\) return;\n\s+ideeen\.plaatsBundel\(\{ kaart: ib\.kaart, bevestiging: bevestiging, vraagId: vraagId \}\)/.test(src));
  toets('7 uitrol.sh en Dockerfile nemen ideeen.js mee', /^RELEASE_OPTIONEEL="[^"]*\bideeen\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY ideeen\.js \/app\/release-bootstrap\/ideeen\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  const gevraagd = [];
  const nepFetch = async (u, o) => { gevraagd.push([u, o]); return { status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, draden: [] }) }; };
  const appStaat = { tellers: {} };
  const ctx = vm.createContext({ require, process: Object.assign({}, process, { env: Object.assign({}, process.env, { WERKKAMER_SLEUTEL_POD: 'wk_pod_proef', IDEEEN_FORUM_BASIS: 'https://forum.proef/api/' }) }),
    fs, path, Buffer, console, JSON, Date, Promise, AbortSignal, fetch: nepFetch, appStaat,
    __dirname: process.cwd(), VAULT, serverPad: (n) => path.join(W, 'srv-' + n), serverProefDeel: (d) => d, logError: () => {},
    appWeiger: (res, st, f, r) => ({ st, f, r }), appStuur: (res, st, j) => ({ st, j }), appRolOk: async () => ctx.__primair,
    appTeller: (k) => { if (!appStaat.tellers[k]) throw new Error('teller ' + k + ' bestaat niet'); return true; },
    appBsnAchtig: (x) => /\d{9}/.test(x), appBsnMasker: (x) => x.replace(/\d{9}/g, '[BSN-achtig getal weggelaten]') });
  ctx.__primair = true;
  vm.runInContext(src.slice(s1, s2) + '\n;globalThis.__h = { ideeen, appIdeeen, ideeenInfo, ideeenForum };', ctx, { filename: 'server.js#ideeen' });
  const S = ctx.__h;
  toets('7 module geladen, tellers bestaan, health aan', S.ideeen && S.ideeenInfo().aan === true && appStaat.tellers.ideeen && appStaat.tellers['ideeen-reactie'] && appStaat.tellers['ideeen-plaatje'], S.ideeenInfo());
  const rs = { _app: {} };
  const gg = await S.appIdeeen({}, rs, { soort: 'mee' }, {}, 'GET /app/ideeen');
  toets('7 GET via server.js: 200 en stil', gg.st === 200 && rs._app.stil === true, gg);
  toets('7 forumaanroep: sleutel in de kop, adres forum/api/draden?forum=ideeen, nooit in de url', gevraagd[0][0] === 'https://forum.proef/api/draden?forum=ideeen' && gevraagd[0][1].headers['X-Werkkamer-Sleutel'] === 'wk_pod_proef' && !/wk_pod/.test(gevraagd[0][0]), gevraagd[0]);
  ctx.__primair = false;
  toets('7 POST op de reservekant = 409', (await S.appIdeeen({}, { _app: {} }, { soort: 'mee' }, { draad: 2, tekst: 'x' }, 'POST /app/ideeen/reactie')).st === 409);
  ctx.__primair = true;
  const rsb = { _app: {} }, dd = { draad: 2, tekst: 'mijn bsn 123456789' };
  await S.appIdeeen({}, rsb, { soort: 'vast' }, dd, 'POST /app/ideeen/reactie');
  toets('7 vaste plek: BSN-achtig getal gemaskeerd, niet geweigerd', rsb._app.bsnWeg === true && !/123456789/.test(dd.tekst), dd);
  const rs2 = { _app: {} }, dd2 = { draad: 2, tekst: 'mijn bsn 123456789' };
  await S.appIdeeen({}, rs2, { soort: 'mee' }, dd2, 'POST /app/ideeen/reactie');
  toets('7 meereizend: niets gemaskeerd (Davids eigen woorden)', !rs2._app.bsnWeg && /123456789/.test(dd2.tekst));
  const tv = await S.appIdeeen({}, { _app: {} }, { soort: 'vast' }, { tekst: 'Op Tolgaarde en in Leusden' }, 'POST /app/ideeen/toets');
  const tm = await S.appIdeeen({}, { _app: {} }, { soort: 'mee' }, { tekst: 'Op Tolgaarde en in Leusden' }, 'POST /app/ideeen/toets');
  toets('7 toets op een vaste plek: alleen de soort (één keer), geen treffertekst; meereizend wel de woorden (Fable #14)', tv.st === 200 && tv.j.treffers.length === 1 && tv.j.treffers[0].treffer === '' && tm.j.treffers.length === 2 && tm.j.treffers.some((x) => x.treffer === 'Tolgaarde'), [tv.j, tm.j]);
  ctx.__primair = false;
  toets('7 toets ook op de reservekant (lezen)', (await S.appIdeeen({}, { _app: {} }, { soort: 'mee' }, { tekst: 'x' }, 'POST /app/ideeen/toets')).st === 200);
  ctx.__primair = true;

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('UITZONDERING', e); process.exit(2); });
JS
