'use strict';
// Besluitenpagina (wv3588, 21-11-2026). Bouwplan vault "01_Ontwikkeling/Besluitenpagina reviews (bouwplan 21-11-2026).md".
// WAAROM. David 20-11-2026 23:57: "Er is echt een hele hoop gepasseerd gister en vandaag aan reviews. Ik zou graag 1x stap voor stap alle
// voorstellen overzichtelijk willen hebben en beantwoorden - desnoods ... op een aparte webpagina, waar ik ze allemaal van een
// ja/nee/toelichting kan voorzien." De ± 240 voorstellen uit de Fable-reviews van 19–21 november stonden verspreid over twee actieplannen en
// besluitenbestanden; alleen 2 × 10 stonden als kaart in Voor jou. Dit is de App Besluiten: één voorstel per scherm met Ja / Nee / Toelichting.
// HOE. De machinekamer vult DIR/voorstellen.json (mk-scripts/besluiten/maak.py, opnieuw te draaien; de pod leest het alleen). Davids antwoorden
// staan in DIR/antwoorden.json (atomair, herstart-vast) en elke wijziging ook als regel in DIR/antwoorden.jsonl (journaal). Een Ja op een
// gevoelig voorstel (geld, versturen, verwijderen) eist in server.js een verse vingerafdruk. Elk kwartier biedt ronde() de antwoorden die
// minstens RUST_MS oud zijn en nog niet (of gewijzigd sinds) aangeboden, als één werkvoorraadrij aan de machinekamer aan (hooguit BUNDEL_MAX per
// rij); die zet Ja om in uitvoerrijen (met review vóór de uitrol), markeert Nee in het actieplan en vraagt bij een toelichting zo nodig terug.
// Grenzen: de pod voert zelf niets uit; een antwoord is geen opdracht aan de pod. Wat David typt gaat letterlijk (tussen markeringen, als zijn
// antwoord op dat ene voorstel) naar de machinekamer; nooit gefilterd (afspraak David 19-11).
const fs = require('fs');
const path = require('path');

const KEUZES = ['ja', 'nee', 'anders'];
const GRENS = { toelichting: 2000, eerder: 10, voorstellen_bytes: 4 * 1024 * 1024 };
const RUST_MS = 10 * 60000;    // een antwoord pas aanbieden als het 10 min niet meer veranderde (David tikt door de lijst)
const BUNDEL_MAX = 40;         // per werkvoorraadrij; de rest volgt in de volgende ronde

function plat(t, max) {
  return String(t == null ? '' : t).normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\r\n?/g, '\n').trim().slice(0, max);
}
function isoOk(t) { return typeof t === 'string' && Number.isFinite(Date.parse(t)); }

// Alleen ENOENT telt als leeg; een andere leesfout of een kapot bestand gooit (code KAPOT): dan schrijft niemand terug.
function leesStreng(p, leeg) {
  let t;
  try { t = fs.readFileSync(p, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return leeg; throw Object.assign(new Error(path.basename(p) + ' is onleesbaar (' + (e.code || 'fout') + ')'), { code: 'KAPOT' }); }
  let j; try { j = JSON.parse(t); } catch (e) { j = null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw Object.assign(new Error(path.basename(p) + ' is geen geldig bestand; er is niets overschreven'), { code: 'KAPOT' });
  return j;
}
function schrijfAtomair(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = p + '.nieuw.' + process.pid + '.' + Date.now();
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(data, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}

function leesVoorstellen(dir) {
  const p = path.join(dir, 'voorstellen.json');
  const st = fs.statSync(p);   // ENOENT gooit: zonder databestand geen scherm
  if (st.size > GRENS.voorstellen_bytes) throw Object.assign(new Error('voorstellen.json is te groot'), { code: 'KAPOT' });
  const j = leesStreng(p, null);
  if (!j || !Array.isArray(j.voorstellen)) throw Object.assign(new Error('voorstellen.json heeft geen lijst'), { code: 'KAPOT' });
  return j;
}
function leesAntwoorden(dir) {
  const j = leesStreng(path.join(dir, 'antwoorden.json'), { versie: 1, antwoorden: {} });
  if (!j.antwoorden || typeof j.antwoorden !== 'object' || Array.isArray(j.antwoorden)) throw Object.assign(new Error('antwoorden.json is kapot'), { code: 'KAPOT' });
  return j;
}
function journaal(dir, regel) {
  try { fs.appendFileSync(path.join(dir, 'antwoorden.jsonl'), JSON.stringify(regel) + '\n', { mode: 0o600 }); } catch (e) { /* het journaal is een vangnet, geen voorwaarde */ }
}

// Een voorstel telt als "open" (te beantwoorden) als het niet vervallen of elders al beantwoord is.
function isOpen(v) { return !v.vervallen && !v.al_beantwoord; }
function nrSleutel(nr) { const n = Number(nr); return Number.isInteger(n) && n > 0 && n < 100000 ? String(n) : null; }

// Het scherm: alle voorstellen met Davids antwoord erbij, plus de telling. Puur lezen.
function scherm(dir) {
  const v = leesVoorstellen(dir), a = leesAntwoorden(dir).antwoorden;
  const lijst = v.voorstellen.map(function (x) {
    const ant = a[String(x.nr)];
    const uit = Object.assign({}, x);
    if (ant && KEUZES.indexOf(ant.keuze) >= 0) uit.antwoord = { keuze: ant.keuze, toelichting: ant.toelichting || '', op: ant.op,
      aangeboden: !!(ant.aangeboden && ant.aangeboden.voor === ant.op), eerder: Array.isArray(ant.eerder) ? ant.eerder.length : 0 };
    return uit;
  });
  const open = lijst.filter(isOpen);
  const beantwoord = open.filter(function (x) { return x.antwoord; });
  const tel = { totaal: open.length, beantwoord: beantwoord.length, ja: 0, nee: 0, anders: 0, review: 0, een9: 0, niet_open: lijst.length - open.length };
  beantwoord.forEach(function (x) { tel[x.antwoord.keuze]++; });
  open.forEach(function (x) { if (x.soort === 'een9') tel.een9++; else tel.review++; });
  return { ok: true, gemaakt: isoOk(v.gemaakt) ? v.gemaakt : null, telling: tel, voorstellen: lijst };
}

// Eén antwoord zetten, wijzigen of wissen (keuze 'wis'). → { ok, voorstel, antwoord } of { ok:false, status, fout }.
// gevoeligOk(): server.js zegt of de verse vingerafdruk er is (alleen gevraagd bij Ja op een gevoelig voorstel).
function antwoord(dir, inv, nuIso, apparaat) {
  const k = nrSleutel(inv && inv.nr);
  if (!k) return { ok: false, status: 400, fout: 'onbekend nummer' };
  const keuze = String(inv.keuze || '');
  if (keuze !== 'wis' && KEUZES.indexOf(keuze) < 0) return { ok: false, status: 400, fout: 'kies ja, nee of anders' };
  const toel = plat(inv.toelichting, GRENS.toelichting + 1);
  if (toel.length > GRENS.toelichting) return { ok: false, status: 413, fout: 'toelichting is langer dan ' + GRENS.toelichting + ' tekens' };
  if (keuze === 'anders' && !toel) return { ok: false, status: 400, fout: 'schrijf je toelichting' };
  const vs = leesVoorstellen(dir);
  const v = vs.voorstellen.find(function (x) { return String(x.nr) === k; });
  if (!v) return { ok: false, status: 404, fout: 'dit voorstel staat niet (meer) in de lijst' };
  if (!isOpen(v)) return { ok: false, status: 409, fout: 'dit voorstel is niet meer open' };
  // lezen, wijzigen en schrijven zonder await ertussen (één thread): ronde() en een antwoord overschrijven elkaar niet
  const st = leesAntwoorden(dir);
  const oud = st.antwoorden[k] || null;
  const verwacht = inv.vorige == null ? undefined : String(inv.vorige);   // optimistisch: de app stuurt de 'op' die hij zag
  if (verwacht !== undefined && (oud && oud.keuze ? oud.op : '') !== verwacht) return { ok: false, status: 409, fout: 'dit antwoord is intussen elders gewijzigd; ververs eerst', huidig: oud ? { keuze: oud.keuze, toelichting: oud.toelichting, op: oud.op } : null };
  const eerder = oud ? (oud.eerder || []).concat(oud.keuze ? [{ keuze: oud.keuze, toelichting: oud.toelichting || '', op: oud.op }] : []).slice(-GRENS.eerder) : [];
  let nieuw;
  if (keuze === 'wis') {
    if (!oud || !oud.keuze) return { ok: true, voorstel: k, antwoord: null };
    // nooit aangeboden: gewoon weg; wel aangeboden of net onderweg (ronde wacht op de werkvoorraad): blijft staan als "ingetrokken"
    // zodat de machinekamer het hoort (Codex wv3588 MOET 1)
    nieuw = oud.aangeboden || oud.onderweg ? { keuze: null, toelichting: '', op: nuIso, apparaat: apparaat, eerder: eerder, aangeboden: oud.aangeboden || oud.onderweg } : null;
  } else {
    nieuw = { keuze: keuze, toelichting: toel, op: nuIso, apparaat: apparaat, eerder: eerder, aangeboden: oud && (oud.aangeboden || oud.onderweg) || null };
  }
  if (nieuw) st.antwoorden[k] = nieuw; else delete st.antwoorden[k];
  schrijfAtomair(path.join(dir, 'antwoorden.json'), st);
  journaal(dir, { t: nuIso, nr: Number(k), keuze: keuze, toelichting: toel, apparaat: apparaat });
  return { ok: true, voorstel: k, antwoord: nieuw && nieuw.keuze ? { keuze: nieuw.keuze, toelichting: nieuw.toelichting, op: nieuw.op, aangeboden: false } : null };
}
function vraagtVingerafdruk(dir, nr, keuze) {
  if (keuze !== 'ja') return false;
  const k = nrSleutel(nr); if (!k) return false;
  const v = leesVoorstellen(dir).voorstellen.find(function (x) { return String(x.nr) === k; });
  return !!(v && v.gevoelig);
}

// Welke antwoorden zijn klaar om aan te bieden: gewijzigd sinds de vorige aanbieding en RUST_MS stil.
function teAanbieden(st, nuMs) {
  return Object.keys(st.antwoorden).filter(function (k) {
    const x = st.antwoorden[k];
    if (!x || !isoOk(x.op) || nuMs - Date.parse(x.op) < RUST_MS) return false;
    if (x.aangeboden && x.aangeboden.voor === x.op) return false;
    return !!x.keuze || !!x.aangeboden;   // ingetrokken telt alleen als het eerder werd aangeboden
  }).sort(function (a, b) { return Number(a) - Number(b); }).slice(0, BUNDEL_MAX);
}

const OPDRACHT_KOP = [
  '# Besluitenpagina: Davids antwoorden verwerken (bundel)',
  '',
  '## Waarom',
  'David beantwoordt in de Socev-app (Apps › Besluiten, wv3588) de voorstellen uit de Fable-reviews van 19–21 november met Ja / Nee / toelichting.',
  'De pod biedt zijn antwoorden per kwartier gebundeld aan. Deze rij zet ze om, zoals de besluitenrijen wv3428/wv3562 dat zouden doen.',
  '',
  '## Wat (per antwoord hieronder)',
  '- Ja: kijk eerst met werkvoorraad.py lijst of er al een rij voor dit voorstel is. Zo niet: zet een uitvoerrij (zonder --ouder-job, --herkomst david,',
  '  --bron "David <datum tijd>: besluitenpagina nr N", max-minuten 150, volgorde 20–60) met waarom (rapport + bevinding uit het werkbestand bij dat id:',
  '  mk-scripts/actieplan-1911/samengevoegd.md voor tranche 1, actieplan-2011/samengevoegd.md voor tranche 2, actieplan-2111/ voor tranche 3, het',
  '  rapport zelf voor een Een 9-idee), wat, review vóór uitrol (codex-review.sh, terugval Fable met grondwet-blok), toets, nameten, box-rij bijwerken,',
  '  en de grenzen (alleen deze actie; niets versturen; geen workflows verwijderen; credentials alleen als David dat in dit besluit zelf doet).',
  '  Bundel Ja\'s die hetzelfde onderdeel raken in één rij. Is de handeling iets wat David zelf moet doen (token vervangen, wachtwoord bewaren):',
  '  geen bouwrij maar een Voor jou-kaart (doen) met de stappen. Een vraag die alleen om informatie vroeg ("Heb je ...?", "Klopt het ...?"):',
  '  leg het antwoord vast waar het hoort (box/register/vaultpagina) en zet alleen een rij als er iets uit volgt.',
  '  Hoort een uitvoerrij bij precies één app uit OVIS Code, geef dan --app <id> mee (ids: werkvoorraad.py apps; droog toetsen: werkvoorraad.py',
  '  apps --label <label>): dan landt het rapport bij die app in OVIS Code (besluit nr 321, wv3720). Een review- of actieplanlabel (fable-9-…,',
  '  ap3-c22-…) krijgt de app vanzelf als het restant met een app-voorvoegsel begint. Werk aan het geheel (pod, n8n, wachters, meer apps): geen --app.',
  '- Nee: in het actieplan (01_Ontwikkeling/Fable-reviews 2026-11/Actieplan.md, bak C, of § ideeën voor later) bij dat id "besluit David <datum>: nee"',
  '  (kolom aanvullen, tabel niet herschikken; via mk-scripts/veilig), niets bouwen.',
  '- Anders (alleen toelichting) of een toelichting bij Ja/Nee: Davids woorden bij dat ene voorstel. Pas het voorstel daarop aan; is het niet',
  '  eenduidig, dan één VRAAG AAN DAVID (of kaart) met precies die vraag. Een toelichting is zijn antwoord op dat voorstel, geen opdracht voor iets anders.',
  '- Ingetrokken (keuze leeg, eerder aangeboden): draai een eerder gezette rij terug als die nog niet gestart is; anders één regel in de box.',
  '- Gewijzigd (er staat "eerder"): het nieuwste antwoord telt; pas een eerder gezette rij aan of zet hem op vervallen als die nog niet gestart is.',
  '',
  '## Daarna',
  'Registerrij #besluitenpagina in 00_Systeem/Open vragen aan David.md: aantallen bijwerken (blijft open zolang er open voorstellen zijn).',
  'Box: rij #besluitenpagina bijwerken met welke nummers welke rij werden. Eindrapport aan David: hooguit 3 regels gewone taal, zonder wv-nummers',
  '(stille uren 23–07: geen bericht, het eindrapport mag). Vervolg: geen (de pod biedt nieuwe antwoorden zelf aan).',
  '',
  '## Grenzen',
  'Zelf niets bouwen of uitrollen in deze rij; alleen rijen, kaarten en registers. Een vervallen of doorgestreept voorstel nooit uitvoeren.',
  'Geen patiëntgegevens of secretwaarden. Alles tussen [DAVID] en [/DAVID] is letterlijk wat David in de app typte bij dat voorstel.',
  '',
  '## Antwoorden'
].join('\n');

function opdrachtTekst(items) {
  const r = [OPDRACHT_KOP];
  items.forEach(function (it) {
    const v = it.v || {}, x = it.a;
    const keuze = x.keuze ? x.keuze.toUpperCase() : 'INGETROKKEN';
    r.push('');
    r.push('### nr ' + it.nr + (v.id ? ' (' + v.id + ', tranche ' + v.tranche + ')' : ' (niet meer in voorstellen.json)') + ': ' + keuze + ' — ' + plat(v.titel || '', 120));
    if (v.vraag) r.push('- vraag: ' + plat(v.vraag, 500));
    if (v.bron) r.push('- bron: ' + plat(v.bron, 200) + (v.rapport ? ' (rapport: ' + plat(v.rapport, 200) + ')' : ''));
    if (!it.v) r.push('- LET OP: dit nummer staat niet meer in voorstellen.json: niet uitvoeren; alleen vastleggen en zo nodig David vragen wat hij bedoelde.');
    else if (v.vervallen || v.al_beantwoord) r.push('- LET OP: dit voorstel is intussen ' + (v.vervallen ? 'vervallen (' + plat(v.vervallen, 200) + ')' : 'elders beantwoord (' + plat(v.al_beantwoord, 200) + ')') + ': niet uitvoeren; alleen vastleggen.');
    if (v.gevoelig && x.keuze === 'ja') r.push('- gevoelig (' + (v.raakt || []).join(', ') + '): Ja gegeven met verse vingerafdruk');
    r.push('- beantwoord: ' + x.op);
    if (x.toelichting) r.push('- toelichting: [DAVID] ' + x.toelichting.replace(/\[\/?DAVID\]/g, '') + ' [/DAVID]');
    const e = (x.eerder || []).slice(-3);
    if (e.length) r.push('- eerder: ' + e.map(function (q) { return (q.keuze || 'leeg') + ' (' + q.op + ')'; }).join(', '));
  });
  return r.join('\n');
}

// Eén ronde: hooguit één werkvoorraadrij. deps: { dir, nu() -> ms, zet({label, prompt, samenvatting}) -> Promise<{id, bestond}>, box(t), fout(e) }
// Codex wv3588 MOET 1 + 3: de bundel (label + nummers + versie) staat vóór de verzending in antwoorden.json (veld onderweg). Mislukt de
// verzending of het opslaan daarna, dan stuurt de volgende ronde precies die bundel opnieuw met hetzelfde label (de RPC geeft dan bestond);
// een wissen tijdens de verzending blijft een intrekking die later wordt aangeboden.
async function ronde(deps) {
  const nuMs = deps.nu();
  const st0 = leesAntwoorden(deps.dir);
  const vs = leesVoorstellen(deps.dir);   // Codex ronde 2: onleesbaar of weg = deze ronde niets versturen of markeren (gooit; de pod meldt het)
  const zoek = function (k) { return vs.voorstellen.find(function (x) { return String(x.nr) === k; }); };
  // 1. een onderbroken verzending eerst afmaken (alleen de nummers die sindsdien niet veranderden)
  let label = null, nrs = [];
  Object.keys(st0.antwoorden).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (k) {
    const x = st0.antwoorden[k];
    if (!x || !x.onderweg || x.onderweg.voor !== x.op) return;
    if (!label) label = x.onderweg.label;
    if (x.onderweg.label === label) nrs.push(k);
  });
  if (!label) {
    nrs = teAanbieden(st0, nuMs);
    if (!nrs.length) return { ok: true, aangeboden: 0 };
    const laatst = nrs.reduce(function (m, k) { return st0.antwoorden[k].op > m ? st0.antwoorden[k].op : m; }, '');
    label = 'machinekamer:besluiten-' + laatst.replace(/\D/g, '').slice(0, 14) + '-' + nrs.length + '-' + nrs[0];
    nrs.forEach(function (k) { st0.antwoorden[k].onderweg = { voor: st0.antwoorden[k].op, label: label, sinds: new Date(nuMs).toISOString() }; });
    schrijfAtomair(path.join(deps.dir, 'antwoorden.json'), st0);   // faalt dit, dan gaat er niets weg
  }
  const items = nrs.map(function (k) { return { nr: k, a: st0.antwoorden[k], v: zoek(k) }; });
  const tel = { ja: 0, nee: 0, anders: 0, ingetrokken: 0 };
  items.forEach(function (it) { tel[it.a.keuze || 'ingetrokken']++; });
  const samenvatting = 'Besluitenpagina: ' + nrs.length + ' antwoord' + (nrs.length === 1 ? '' : 'en') + ' van David verwerken (' +
    ['ja', 'nee', 'anders', 'ingetrokken'].filter(function (k) { return tel[k]; }).map(function (k) { return tel[k] + ' ' + k; }).join(', ') + ')';
  const z = await deps.zet({ label: label, prompt: opdrachtTekst(items), samenvatting: samenvatting });
  // opnieuw lezen na de await; alleen markeren wat in deze bundel zat en sindsdien niet veranderde
  const st = leesAntwoorden(deps.dir);
  let gemarkeerd = 0;
  Object.keys(st.antwoorden).forEach(function (k) {
    const x = st.antwoorden[k];
    if (!x || !x.onderweg || x.onderweg.label !== label) return;
    if (x.op === x.onderweg.voor) { x.aangeboden = { voor: x.op, op: new Date(nuMs).toISOString(), label: label, rij: z && z.id || null }; gemarkeerd++; }
    else if (!x.aangeboden) x.aangeboden = { voor: x.onderweg.voor, op: new Date(nuMs).toISOString(), label: label, rij: z && z.id || null };   // gewijzigd tijdens het zetten: de oude stand ging mee
    delete x.onderweg;
  });
  schrijfAtomair(path.join(deps.dir, 'antwoorden.json'), st);
  return { ok: true, aangeboden: gemarkeerd, rij: z && z.id || null, bestond: !!(z && z.bestond), label: label };
}

// ── wv3714 (besluitenpagina nr 463 = 3C163, David Ja 21-11-2026 13:08): rapportboek per app in OVIS Code ──
// WAAROM. David wil per app in OVIS Code het cijfer, de voorstellen en hun stand zien en daar meteen Ja of Nee geven. Het antwoord gaat via
// dezelfde route en opslag als de Besluitenpagina (antwoord() hierboven); hier staat alleen de STAND per voorstel. Ontwerp + Codex-review:
// mk-scripts/wv3714/ontwerp.md (GO-MET-WIJZIGINGEN; MOET 1 = koppeling ook buiten paginabezoeken bijwerken en eenmalig uit de volledige
// historie vullen: besluitenTik werkt hem elk kwartier bij, mk-scripts/wv3714/zaai.py vulde hem bij de bouw).
// Koppeling voorstel → werkvoorraadrij: het veld bron van de rij noemt het nummer ("besluitenpagina nr 122, 191", "besluitenpagina 324/426").
// mk_werkvoorraad_stand geeft alleen open rijen en die van de laatste 3 dagen; daarom onthoudt de pod elke gekoppelde rij in DIR/koppeling.json
// (alleen de pod schrijft, atomair, 0600): een klare rij blijft klaar, ook als hij uit het venster valt. Heuristiek: een rij zonder nummer in
// bron ziet de pod niet (stand blijft te laag, nooit te hoog).
const BRON_RE = /besluit(?:en)?(?:pagina)?\s*(?:nr\.?\s*)?((?:\d{1,3}(?![\w-])(?:\s*(?:,|\/|\+|&|en\b)\s*)?)+)/gi;
const BUNDEL_LABEL_RE = /^machinekamer:besluiten-\d/;
const MEET_RE = /nacontrole|nameting|natoets|nameten/i;
const STANDEN = ['wacht_op_jou', 'nee', 'bij_machinekamer', 'in_de_rij', 'wordt_gebouwd', 'live', 'nagemeten', 'verwerkt', 'vervallen'];

function nrsUitBron(bron, bekend) {
  const uit = [];
  String(bron || '').replace(BRON_RE, function (m, reeks) {
    String(reeks).split(/[^\d]+/).forEach(function (t) { const n = Number(t); if (Number.isInteger(n) && n > 0 && (!bekend || bekend[String(n)]) && uit.indexOf(n) < 0) uit.push(n); });
    return m;
  });
  return uit;
}
function rijKort(w, nrs, nuIso) {
  return { nrs: nrs, status: String(w.status || ''), soort: w.soort ? String(w.soort) : null, label: String(w.label || '').slice(0, 120),
    bundel: BUNDEL_LABEL_RE.test(String(w.label || '')), op: nuIso };
}
function leesKoppeling(dir) {
  try { const j = leesStreng(path.join(dir, 'koppeling.json'), { versie: 1, rijen: {} }); return j.rijen && typeof j.rijen === 'object' && !Array.isArray(j.rijen) ? j : { versie: 1, rijen: {} }; }
  catch (e) { return { versie: 1, rijen: {}, kapot: true }; }   // kapot = opnieuw opbouwen uit het venster (server.js meldt het)
}
// Werk het geheugen bij met de rijen uit de werkvoorraad (items van mk_werkvoorraad_stand). Schrijft alleen als er iets veranderde.
// → { koppeling, gewijzigd, kapot }
function koppelBij(dir, items, nuIso, voorstellen) {
  const k = leesKoppeling(dir), kapot = !!k.kapot;
  delete k.kapot;
  const bekend = {};
  (voorstellen || []).forEach(function (v) { bekend[String(v.nr)] = true; });
  let gewijzigd = kapot;
  (Array.isArray(items) ? items : []).forEach(function (w) {
    if (!w || w.id == null) return;
    const bundel = BUNDEL_LABEL_RE.test(String(w.label || ''));
    const nrs = bundel ? [] : nrsUitBron(w.bron, bekend);
    if (!bundel && !nrs.length) return;
    const oud = k.rijen[String(w.id)];
    if (oud && oud.status === String(w.status || '') && JSON.stringify(oud.nrs) === JSON.stringify(nrs) && oud.soort === (w.soort ? String(w.soort) : null)) return;
    k.rijen[String(w.id)] = rijKort(w, nrs, nuIso);
    gewijzigd = true;
  });
  if (gewijzigd) schrijfAtomair(path.join(dir, 'koppeling.json'), k);
  return { koppeling: k, gewijzigd: gewijzigd, kapot: kapot };
}

// Stand van één voorstel. rijen = koppeling.rijen; per nr de uitvoerrijen (bundel telt niet).
function standVan(v, ant, perNr, rijen) {
  const r = (perNr[String(v.nr)] || []).map(function (id) { return Object.assign({ wv: Number(id) }, rijen[id]); });
  const kort = r.map(function (x) { return { wv: x.wv, status: x.status, meet: !!(x.soort === 'nacontrole' || MEET_RE.test(x.label)) }; });
  if (!isOpen(v)) return { stand: 'vervallen', rijen: kort };
  if (!ant || !ant.keuze) return { stand: 'wacht_op_jou', rijen: kort };
  if (ant.keuze === 'nee') return { stand: 'nee', rijen: kort };
  const levend = kort.filter(function (x) { return x.status !== 'vervallen'; });
  let bouw = levend.filter(function (x) { return !x.meet; });
  const meet = levend.filter(function (x) { return x.meet; });
  if (!bouw.length) bouw = meet;
  if (bouw.some(function (x) { return x.status === 'gestart' || x.status === 'starten'; })) return { stand: 'wordt_gebouwd', rijen: kort };
  if (bouw.some(function (x) { return x.status === 'open' || x.status === 'geblokkeerd'; })) return { stand: 'in_de_rij', rijen: kort };
  if (bouw.length && bouw.every(function (x) { return x.status === 'klaar'; })) {
    return { stand: meet.some(function (x) { return x.status === 'klaar'; }) && bouw !== meet ? 'nagemeten' : 'live', rijen: kort };
  }
  // geen eigen klus (of alleen vervallen rijen): hangt af van de kwartierbundel waarin het antwoord zat
  const b = ant.aangeboden && ant.aangeboden.voor === ant.op && ant.aangeboden.rij != null ? rijen[String(ant.aangeboden.rij)] : null;
  if (b && (b.status === 'klaar' || b.status === 'vervallen')) return { stand: 'verwerkt', rijen: kort };
  return { stand: 'bij_machinekamer', rijen: kort };
}
// Het scherm (zoals scherm()) met per voorstel stand + rijen, gefilterd op één app (OVIS Code-id) als app gegeven is; plus de cijfers en de
// telling voor het rapportboek. koppeling = uitkomst van koppelBij (of leesKoppeling).
function schermMetStand(dir, koppeling, app) {
  const s = scherm(dir);
  const v = leesVoorstellen(dir);
  const ruw = leesAntwoorden(dir).antwoorden;
  const rijen = (koppeling && koppeling.rijen) || {};
  const perNr = {};
  Object.keys(rijen).forEach(function (id) { const x = rijen[id]; if (!x || x.bundel) return; (x.nrs || []).forEach(function (n) { (perNr[String(n)] = perNr[String(n)] || []).push(id); }); });
  s.voorstellen.forEach(function (x) { const st = standVan(x, ruw[String(x.nr)], perNr, rijen); x.stand = st.stand; x.rijen = st.rijen; });
  if (!app) return s;
  const lijst = s.voorstellen.filter(function (x) { return x.app === app; });
  const open = lijst.filter(isOpen);
  const tel = { totaal: open.length, beantwoord: 0, ja: 0, nee: 0, anders: 0, wacht: 0, gebouwd: 0, te_bouwen: 0, niet_open: lijst.length - open.length };
  open.forEach(function (x) {
    if (x.antwoord) { tel.beantwoord++; tel[x.antwoord.keuze]++; } else tel.wacht++;
    if (x.antwoord && x.antwoord.keuze !== 'nee') tel.te_bouwen++;
    if (x.stand === 'live' || x.stand === 'nagemeten') tel.gebouwd++;
  });
  const cijfers = v.cijfers && typeof v.cijfers === 'object' && Array.isArray(v.cijfers[app]) ? v.cijfers[app] : [];
  return { ok: true, app: app, gemaakt: s.gemaakt, telling: tel, cijfers: cijfers, voorstellen: lijst };
}

module.exports = { scherm, schermMetStand, koppelBij, leesKoppeling, nrsUitBron, standVan, STANDEN, antwoord, vraagtVingerafdruk, ronde, teAanbieden, opdrachtTekst, RUST_MS, BUNDEL_MAX, GRENS, KEUZES };
