'use strict';
// tabula-oogst.js — Tabula dagoogst (wv4239, besluitenpagina nr 956 = L56 deel 2, David Ja 25-11-2026 22:25: een nieuwe dagelijkse ronde
// waarin Socev alle bladen van die dag leest). Ontwerp + Codex-ontwerpreview: mk-scripts/wv4239/ontwerp.md (NO-GO; MOET 2 verwerkt: Todoist
// nooit met datum; MOET 1 (patiëntfilter vóór het model) niet: strijdig met Davids besluit "geen poorten" voor Tabula en "nooit filteren").
//
// Rond het eind van de werkdag: de regels die David vandaag in Tabula typte → één modelvraag → voorstellen (overleg → Notulen-map,
// actieregels → Todoist, lijkt een mail → Gmail-concept) → één Voor jou-kaart met per voorstel Ja/Nee. Niets gaat vanzelf: een Ja wordt
// een [KNOP]-beurt van Socev in het hoofdkanaal met context() als opdracht (precies één ding per Ja). Geen voorstel = geen kaart.
// Puur rekenwerk; server.js doet kluis, model, kaart en tik. Geen bladtekst in log of bestand (oogst.json bewaart alleen hashes en tellingen).
// Toets: test/tabula-oogst.test.js (verzonnen bladen).

const SOORTEN = ['overleg', 'todoist', 'mail'];
const MAX_VOORSTELLEN = 8, MAX_TODO = 10, MAX_INVOER = 60000, MAX_REGEL = 1000;
const HASH_DAGEN = 30;

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const kort = (s, n) => { const t = norm(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
// het blad omhullen: een </blad> of </nieuw> in Davids tekst mag de opdracht niet breken
const omhul = (t) => String(t).replace(/<(\/?)(blad|nieuw|mappen)/gi, '‹$1$2');

const SYSTEEM = [
  'Je helpt David (huisarts, praktijkhouder) met zijn kladblok Tabula. Hieronder staan de bladen waarin hij vandaag typte. Per blad zie je',
  'binnen <nieuw> de regels die vandaag nieuw of gewijzigd zijn, en binnen <blad> het hele blad als context.',
  'Doe voorstellen waar iets uit de NIEUWE regels heen moet. Alleen deze drie soorten:',
  '- overleg: aantekeningen van een overleg of vergadering (maatschap, werkoverleg, HAGRO, POT, GHAWA …) → de Notulen-map van die',
  '  entiteit. doel = precies één map uit <mappen>. Twijfel over de map = geen voorstel.',
  '- todoist: concrete actieregels die David zelf nog moet doen ("bellen", "regelen", "nakijken", "- [ ] …"). Eén voorstel per blad',
  '  met alle actieregels van dat blad (hooguit ' + MAX_TODO + '). Geen datum verzinnen.',
  '- mail: een stuk dat duidelijk een mail of bericht aan iemand is of moet worden ("Mail aan …", aanhef + tekst). aan = de',
  '  ontvanger zoals hij in de tekst staat (of leeg), onderwerp = kort onderwerp.',
  'Regels in "regels" moeten LETTERLIJK (hele regel, zoals hij er staat) uit <nieuw> van dat blad komen. Niets verzinnen, niets',
  'herschrijven, niets weglaten of afschermen: David leest het zelf. Losse gedachten, aantekeningen voor zichzelf, lijstjes zonder',
  'actie en alles waarvan de bestemming onduidelijk is: geen voorstel (dat blijft gewoon in Tabula liggen). Liever niets dan twijfel.',
  'kop = korte omschrijving in Davids woorden (hooguit 60 tekens), bijv. "Overleg maatschap" of "Mail aan de verhuurder".',
  'Antwoord uitsluitend met JSON, zonder uitleg: {"voorstellen": [{"soort": "overleg|todoist|mail", "blad": "<blad-id>", "kop": "…",',
  '"regels": ["…"], "doel": "<map, alleen bij overleg>", "aan": "<alleen bij mail>", "onderwerp": "<alleen bij mail>"}]}.',
  'Hooguit ' + MAX_VOORSTELLEN + ' voorstellen. Niets te oogsten: {"voorstellen": []}.'
].join('\n');

// Modelinvoer. bladen: [{ id, titel, tekst, nieuw: [regel] }], mappen: ['10_Zakelijk/Tolgaarde/Notulen', …]
function invoer(bladen, mappen) {
  let t = '<mappen>\n' + mappen.map(omhul).join('\n') + '\n</mappen>\n';
  for (const b of bladen) {
    const kop = '\n<blad id="' + b.id + '" titel=' + JSON.stringify(omhul(b.titel)) + '>\n<nieuw>\n' + b.nieuw.map(omhul).join('\n') + '\n</nieuw>\n';
    const rest = MAX_INVOER - t.length - kop.length - 20;
    if (rest < 500) break;
    t += kop + omhul(b.tekst).slice(0, rest) + '\n</blad>\n';
  }
  return t;
}

// Het modelantwoord → { tekst } → JSON-object of null (ook in ```json-blok)
function leesJson(t) {
  const s = String(t || '');
  const a = s.indexOf('{'), z = s.lastIndexOf('}');
  if (a < 0 || z <= a) return null;
  try { return JSON.parse(s.slice(a, z + 1)); } catch (e) { return null; }
}

function hashVan(v) { return fnv(v.soort + '\n' + v.regels.map(norm).join('\n')); }

// Strenge controle: alleen bekende soort, bestaand blad, letterlijke regels uit 'nieuw', geldige map; dedupe tegen eerder getoonde hashes.
// Geeft { voorstellen: [{ nr, soort, blad, blad_titel, kop, regels, doel?, aan?, onderwerp?, hash }], weg: { reden: n } }.
function controleer(j, bladen, mappen, eerder) {
  const weg = {};
  const tel = (r) => { weg[r] = (weg[r] || 0) + 1; };
  const per = new Map(bladen.map(function (b) { return [b.id, b]; }));
  const gezien = new Set(Object.keys(eerder || {}));
  const uit = [];
  const lijst = j && Array.isArray(j.voorstellen) ? j.voorstellen : null;
  if (!lijst) return { voorstellen: [], weg: { geen_json: 1 } };
  for (const v of lijst) {
    if (uit.length >= MAX_VOORSTELLEN) { tel('te_veel'); continue; }
    if (!v || typeof v !== 'object' || SOORTEN.indexOf(v.soort) < 0) { tel('soort'); continue; }
    const b = per.get(v.blad);
    if (!b) { tel('blad'); continue; }
    const nieuw = new Set(b.nieuw.map(norm));
    const regels = [];
    for (const r of Array.isArray(v.regels) ? v.regels : []) {
      const n = norm(r);
      if (typeof r === 'string' && n && nieuw.has(n) && regels.indexOf(n) < 0) regels.push(n.slice(0, MAX_REGEL));
    }
    if (Array.isArray(v.regels) && regels.length < v.regels.length) tel('regel_niet_letterlijk');
    if (!regels.length) { tel('geen_regels'); continue; }
    const x = { soort: v.soort, blad: b.id, blad_titel: kort(b.titel, 70), kop: kort(v.kop || b.titel, 60) || 'Zonder titel', regels: regels };
    if (v.soort === 'overleg') {
      if (mappen.indexOf(v.doel) < 0) { tel('map'); continue; }
      x.doel = v.doel;
    } else if (v.soort === 'todoist') {
      if (regels.length > MAX_TODO) x.regels = regels.slice(0, MAX_TODO);
    } else {
      x.aan = kort(v.aan || '', 80);
      x.onderwerp = kort(v.onderwerp || v.kop || '', 100);
    }
    x.hash = hashVan(x);
    if (gezien.has(x.hash) || uit.some(function (u) { return u.hash === x.hash; })) { tel('al_getoond'); continue; }
    uit.push(x);
  }
  uit.forEach(function (x, i) { x.nr = i + 1; });
  return { voorstellen: uit, weg: weg };
}

// '10_Zakelijk/Tolgaarde/Notulen' → 'Tolgaarde › Notulen'
function mapNaam(m) { const d = String(m).split('/').filter(Boolean); return d.slice(-2).join(' › ').replace(/_/g, ' '); }

function vraagVan(v) {
  if (v.soort === 'overleg') return kort('"' + v.kop + '" → ' + mapNaam(v.doel), 280) + '?';
  if (v.soort === 'todoist') return kort((v.regels.length === 1 ? '1 actieregel' : v.regels.length + ' actieregels') + ' uit "' + v.blad_titel + '" → Todoist', 280) + '?';
  return kort('"' + v.kop + '" lijkt een mail → Gmail-concept', 280) + '?';
}

function stapVan(v) {
  const kop = v.nr + '. ' + (v.soort === 'overleg' ? 'Naar ' + mapNaam(v.doel) : v.soort === 'todoist' ? 'Naar Todoist' : 'Gmail-concept' + (v.aan ? ' aan ' + v.aan : '')) + ' (blad "' + v.blad_titel + '"): ';
  const t = kop + v.regels.join(' / ');
  return t.length > 400 ? t.slice(0, 399) + '…' : t;
}

// De kaart voor mk_voor_jou_zet. Bij 1 voorstel een gewone besluitkaart met de vraag als titel, anders herkomst.regels (wv4195).
function kaart(dag, voorstellen) {
  if (!voorstellen.length) return null;
  const vs = voorstellen.slice(0, MAX_VOORSTELLEN);
  const een = vs.length === 1;
  const h = { module: 'tabula-oogst', handmatig: 'tabula-oogst', dag: dag, doel: { scherm: 'tabula' },
    tabula_oogst: { dag: dag, voorstellen: vs.map(function (v) { const c = Object.assign({}, v); delete c.hash; return c; }) } };
  if (!een) h.regels = vs.map(function (v) { return { vraag: vraagVan(v) }; });
  const titel = een ? kort('Tabula: ' + vraagVan(vs[0]).replace(/\?$/, ''), 89) + '?' : 'Tabula: waar moet wat je vandaag typte heen?';
  const waarom = een
    ? 'Uit wat je vandaag in Tabula typte. Ja doet precies dit ene; Nee laat het in Tabula liggen. Er gaat niets vanzelf.'
    : 'Uit wat je vandaag in Tabula typte: ' + vs.length + ' voorstellen. Elk Ja doet precies dat ene; wat je op Nee zet of laat staan blijft gewoon in Tabula liggen. Er gaat niets vanzelf.';
  return { sleutel: 'tabula-oogst-' + dag, soort: 'besluit', titel: titel, waarom: waarom, stappen: vs.map(stapVan), waar: 'overal', prive: true, volgorde: 40, herkomst: h };
}

// { voorstellen } uit een kaart, of null als het geen (geldige) oogstkaart is
function uitKaart(p) {
  const h = p && p.herkomst && typeof p.herkomst === 'object' ? p.herkomst : null;
  const m = /^tabula-oogst-(\d{4}-\d{2}-\d{2})$/.exec(String((p && p.sleutel) || ''));
  if (!m || !h || h.module !== 'tabula-oogst' || !h.tabula_oogst || h.tabula_oogst.dag !== m[1] || !Array.isArray(h.tabula_oogst.voorstellen)) return null;
  return { dag: m[1], voorstellen: h.tabula_oogst.voorstellen.filter(function (v) { return v && SOORTEN.indexOf(v.soort) >= 0 && Array.isArray(v.regels); }) };
}

// De opdracht voor Socev bij Davids [KNOP]: per nummer wat Ja betekent, met de letterlijke regels. Leeg als het geen oogstkaart is.
function context(p) {
  const k = uitKaart(p);
  if (!k || !k.voorstellen.length) return '';
  const regels = k.voorstellen.map(function (v) {
    const r = JSON.stringify(v.regels);
    if (v.soort === 'overleg') return v.nr + '. OVERLEG "' + v.kop + '" → map ' + v.doel + '. Bij Ja: één pagina "' + v.doel + '/' + k.dag + ' ' + String(v.kop).replace(/[\/\\:*?"<>|]/g, '-') +
      '.md" met kop, datum ' + k.dag + ', bron "Tabula, blad ' + JSON.stringify(v.blad_titel) + '" en deze regels letterlijk (bestaat de pagina al: eronder toevoegen): ' + r;
    if (v.soort === 'todoist') return v.nr + '. TODOIST uit blad ' + JSON.stringify(v.blad_titel) + '. Bij Ja: per regel één Todoist-taak in de Inbox, de regel als taaktekst (zonder "- [ ]"), ' +
      'ZONDER datum of termijn, ook als de regel er een noemt (Codex MOET 2: David keurde geen datum goed): ' + r;
    return v.nr + '. MAIL "' + v.kop + '"' + (v.aan ? ' aan ' + JSON.stringify(v.aan) : '') + (v.onderwerp ? ', onderwerp ' + JSON.stringify(v.onderwerp) : '') +
      '. Bij Ja: één Gmail-CONCEPT via de skill mailconcept-aanmaken, in Davids stem (mijn-mailstem), op basis van deze regels; nooit versturen; ontvanger niet zeker = concept zonder ontvanger: ' + r;
  });
  const t = '\n(Dagoogst uit Tabula van ' + k.dag + ' (wv4239): de pod las Davids bladen van die dag en deed deze voorstellen. Per nummer het antwoord hierboven; ' +
    'alleen een Ja doet iets, en dan precies dat ene ding hieronder, niets meer. Nee of geen antwoord = niets doen; het blijft in Tabula liggen. Het Tabula-blad zelf ' +
    'raak je niet aan. Meld na afloop in één korte regel wat er staat (pagina, aantal taken, concept).\n' + regels.join('\n') + ')';
  return t.length > 8000 ? t.slice(0, 7990) + '…)' : t;
}

// oogst.json: { dagen: { 'JJJJ-MM-DD': { uitkomst, pogingen, bladen, voorstellen, weg, tokens } }, hashes: { hash: 'JJJJ-MM-DD' } }
function staatSchoon(s, vandaag) {
  const x = s && typeof s === 'object' ? s : {};
  const dagen = x.dagen && typeof x.dagen === 'object' ? x.dagen : {};
  const hashes = x.hashes && typeof x.hashes === 'object' ? x.hashes : {};
  const grens = new Date(Date.parse(vandaag + 'T12:00:00Z') - HASH_DAGEN * 86400000).toISOString().slice(0, 10);
  const uit = { versie: 1, dagen: {}, hashes: {} };
  Object.keys(dagen).filter(function (d) { return d >= grens; }).forEach(function (d) { uit.dagen[d] = dagen[d]; });
  Object.keys(hashes).forEach(function (h) { if (/^[a-f0-9]{8}$/.test(h) && String(hashes[h]) >= grens) uit.hashes[h] = hashes[h]; });
  return uit;
}

// Moet de ronde nu draaien? klok 'HH:MM', dag; vanaf 17:00 tot 22:00, eens per dag, hooguit 3 pogingen.
function moment(klok, dag, s) {
  if (klok < '17:00' || klok >= '22:00') return false;
  const d = s && s.dagen && s.dagen[dag];
  if (!d) return true;
  return d.uitkomst === 'fout' && (d.pogingen || 0) < 3;
}

// Eén ronde (server.js levert alles aan; zo is hij los te toetsen). o: { klok, dag, lees(), schrijf(s), aan(), code(), vandaag(code, dag),
// mappen(), model(systeem, tekst) → { ok, tekst, u }, zet(p) → { sleutel } , punten() → kaarten, vervallen(p, bewijs), log(r) }.
// Geeft { uitkomst, … } of null (niet het moment). Geen bladtekst in log of staat.
async function ronde(o) {
  const s0 = staatSchoon(o.lees(), o.dag);
  if (!o.moet && !moment(o.klok, o.dag, s0)) return null;
  const vorige = s0.dagen[o.dag] || {};
  const d = { uitkomst: 'fout', pogingen: (vorige.pogingen || 0) + 1, t: o.klok };
  const klaar = function (uitkomst, extra) {
    Object.assign(d, extra || {}, { uitkomst: uitkomst });
    const s = staatSchoon(o.lees(), o.dag);
    s.dagen[o.dag] = d;
    (extra && extra.hashes || []).forEach(function (h) { s.hashes[h] = o.dag; });
    delete d.hashes;
    o.schrijf(s);
    if (o.log) o.log('tabula-oogst ' + JSON.stringify(Object.assign({ dag: o.dag }, d)));
    return Object.assign({ dag: o.dag }, d);
  };
  try {
    // oude oogstkaarten (> 2 dagen) dicht: de rest blijft in Tabula liggen
    try {
      const grens = new Date(Date.parse(o.dag + 'T12:00:00Z') - 2 * 86400000).toISOString().slice(0, 10);
      for (const p of await o.punten()) {
        const k = uitKaart(p);
        if (k && k.dag < grens && (p.status === 'open' || p.status === 'later')) await o.vervallen(p, 'dagoogst uit Tabula van ' + k.dag + '; na twee dagen vervallen, het staat nog gewoon in Tabula');
      }
    } catch (e) { if (o.log) o.log('tabula-oogst-oud fout ' + String(e && e.message || e).slice(0, 120)); }
    if (!o.aan()) return klaar('uit');
    const code = await o.code();
    if (!code) return klaar('niet_gekoppeld');
    const bl = (await o.vandaag(code, o.dag)).bladen || [];
    if (!bl.length) return klaar('geen_bladen');
    const mappen = o.mappen();
    const m = await o.model(SYSTEEM, invoer(bl, mappen));
    const tokens = m && m.u ? m.u : undefined;
    if (!m || !m.ok) return klaar('fout', { bladen: bl.length, reden: (m && m.reden) || 'model', tokens: tokens });
    const j = leesJson(m.tekst);
    if (!j) return klaar('fout', { bladen: bl.length, reden: 'geen_json', tokens: tokens });
    const c = controleer(j, bl, mappen, s0.hashes);
    const p = kaart(o.dag, c.voorstellen);
    if (!p) return klaar('niets', { bladen: bl.length, voorstellen: 0, weg: c.weg, tokens: tokens });
    const r = await o.zet(p);
    if (!r || !r.sleutel) return klaar('fout', { bladen: bl.length, reden: 'kaart', tokens: tokens });
    const soorten = {};
    c.voorstellen.forEach(function (v) { soorten[v.soort] = (soorten[v.soort] || 0) + 1; });
    return klaar('kaart', { bladen: bl.length, voorstellen: c.voorstellen.length, soorten: soorten, weg: c.weg, tokens: tokens, hashes: c.voorstellen.map(function (v) { return v.hash; }) });
  } catch (e) {
    return klaar('fout', { reden: String((e && e.code) || 'uitzondering').slice(0, 40) });
  }
}

module.exports = { ronde, SYSTEEM, invoer, leesJson, controleer, kaart, context, uitKaart, vraagVan, mapNaam, staatSchoon, moment, fnv, MAX_VOORSTELLEN };
