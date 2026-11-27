'use strict';
// wv4176 (besluitenpagina nr 450 = 3C150, David Ja 25-11-2026 22:23): de namenlijst voor het uitschrijven in het gesprek (POST /app/spraak).
// Whisper (Cloudflare Workers AI, whisper-large-v3-turbo) neemt een initial_prompt aan: woorden die erin staan, schrijft hij daarna goed
// (gemeten 27-11 met een proefopname: zonder lijst 4 van 6 eigennamen fout, met lijst 6 van 6 goed). MemoryLane deed dat al met de
// familienamen (wv2536); het gesprek kreeg alleen "Socev".
//
// Bronnen, in deze volgorde (wat bovenaan staat, valt het laatst weg als de lijst te lang wordt):
//   1. de eigen entiteiten uit het OVIS-register (rol eigen: praktijken, holding, stichtingen) met hun korte aliassen
//   2. de namen van de Apps in de app (vast hieronder: die namen zijn openbaar, ze staan ook in de app-code)
//   3. het gezin en de familie: dezelfde lijst als MemoryLane (persoonspagina's in de vault + Hoofdpersonen), via hint()
//   4. praktijken en zorgpartners uit het register (organisaties)
//   5. leveranciers uit het register (organisaties), de vaakst gefactureerde van het laatste jaar eerst (Facturen-app, alleen een telling)
//   6. de Woordenlijst (vault): de eerste naam van elke handmatige regel onder Zorggroep, Projecten en Instanties
// Bewust NIET: personen uit het register of de Woordenlijst (collega's, contacten) en namen uit facturen die niet als organisatie in het
// register staan: zo komt er nooit een patiëntnaam in de lijst. Nooit namen in code, logs of /health: alleen aantallen.
// Faalt een bron, dan gaat de lijst zonder die bron door (nooit het uitschrijven tegenhouden). Elke 10 minuten opnieuw samengesteld.

const MAX_TEKENS = 560;          // Whisper leest hooguit ± 224 tokens prompt; "Socev, " komt er nog voor (appWhisper)
const CACHE_MS = 600000;
const NAAM_MAX = 32;             // langere namen (statutaire namen) helpen de uitschrijver niet
// Per bron een plafond, zodat één grote bron (leveranciers) de rest niet wegdrukt
const PLAFOND = { eigen: 150, apps: 150, gezin: 100, partners: 70, leveranciers: 90, woorden: 60 };
// De Apps zoals ze in de app heten (socev-app src/modules.ts), alleen de namen die geen gewoon Nederlands woord zijn
const APPS = ['MemoryLane', 'Tripper', 'Shopper', 'Sleutelbos', 'Broedstoof', 'DocPlan', 'MailMan', 'Harvester', 'Mediatheek', 'Imagine',
  'OVIS', 'OVIS Code', 'Cijfer-Meester', 'The Flock', 'TokenCounter', 'GHAWA', 'Bandjes', 'Pakjes', 'Studio', 'Intake', 'Calendar', 'OSINT', 'PMA', 'NZa'];
const WOORD_SECTIES = /^###\s+(Zorggroep|Projecten|Beroepsorganisaties)/;
const RECHTSVORM = /[\s,]+(b\.?\s?v\.?|n\.?\s?v\.?|v\.?o\.?f\.?|inc\.?|ltd\.?|gmbh|pbc|bv|nv|vof)\.?$/i;
const ROLLEN_PARTNER = new Set(['praktijk', 'zorgpartner']);

function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
// "Pennenwinkel.nl - J. Pen en Zonen B.V." → "Pennenwinkel"; "Wolkdienst, Inc." → "Wolkdienst"; haakjes, rechtsvorm en .nl eraf
function kort(n) {
  let s = String(n == null ? '' : n).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').split(/\s+[-–—|]\s+/)[0];
  for (let i = 0; i < 2; i++) s = s.replace(RECHTSVORM, '');
  s = s.replace(/\.(nl|com|eu|be|de|io)$/i, '');   // ".nl" spreek je niet uit
  s = s.replace(/[\s,;:]+$/, '').replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > NAAM_MAX || !/\p{L}/u.test(s) || /[@/\\]|https?:/i.test(s)) return '';
  return s;
}
// De eerste naam van elke handmatige regel in de gekozen secties: "- **HE** · Huisartsen Eemland · … — uitleg" → HE, Huisartsen Eemland
function woordenUit(tekst) {
  const uit = [];
  let aan = false;
  for (const r of String(tekst || '').split('\n')) {
    if (/^#{1,3}\s/.test(r)) { aan = WOORD_SECTIES.test(r); continue; }
    if (!aan || !/^\s*-\s+(?!\?)/.test(r)) continue;
    const kop = r.replace(/^\s*-\s+/, '').split(/\s+—\s+/)[0];
    const delen = kop.split(/\s*·\s*/).map(function (x) { return x.replace(/\*\*|`|\[knoop:[^\]]*\]/g, '').trim(); }).filter(Boolean);
    // de code (vet, korte hoofdletters) en de eerste uitgeschreven naam
    const code = delen.find(function (x) { return /^[A-Z][A-Z0-9-]{1,7}$/.test(x); });
    const naam = delen.find(function (x) { return !/^[A-Z][A-Z0-9-]{1,7}$/.test(x) && /\s|\p{Ll}/u.test(x); });
    if (code) uit.push(code);
    if (naam) uit.push(naam);
  }
  return uit;
}

/*
 * maak(o):
 *   o.register()      → Promise<{ knopen: [{ id, soort, rol, naam, aliassen, actief }] }> (brain-entiteiten.register; mag gooien)
 *   o.gezin(max)      → string "Naam, Naam, …" (herinneringen-verhaal namen.hint; mag gooien)
 *   o.facturen()      → [{ knoop_id, naam, n }] gefactureerd laatste jaar per leverancier (mag gooien of null geven)
 *   o.lees(rel)       → vaulttekst (Woordenlijst; mag gooien)
 *   o.nu()            → ms (toetsen)
 * → { hint(): Promise<string>, info(): { … aantallen … }, _bouw(bronnen) }
 */
function maak(o) {
  const nu = o.nu || Date.now;
  let cache = null, laatst = null;

  // bronnen → lijst van groepen; elke groep een rij namen in volgorde
  function bouw(b) {
    const gezien = new Set(['socev']);
    const groepen = {};
    const zet = function (g, namen) {
      const l = [];
      let len = 0;
      for (const ruw of namen || []) {
        const n = kort(ruw), k = norm(n);
        if (!n || k.length < 2 || gezien.has(k)) continue;
        if (len + n.length + 2 > PLAFOND[g]) continue;   // te lang voor deze groep: de volgende (kortere) mag nog
        gezien.add(k); l.push(n); len += n.length + 2;
      }
      groepen[g] = l;
    };
    const knopen = (b.register && Array.isArray(b.register.knopen) ? b.register.knopen : []).filter(function (k) { return k && k.actief !== false; });   // concept telt mee: het gaat alleen om de schrijfwijze
    const org = function (k) { return k.soort === 'organisatie' || k.soort === 'entiteit'; };
    // 1. eigen entiteiten: eerst per entiteit de kortste naam (een alias van één woord gaat voor), daarna de tweede als er nog plek is;
    //    PRIVE (Davids eigen naam) niet
    const eerste = [], tweede = [];
    knopen.filter(function (k) { return (k.rol === 'eigen' || k.soort === 'entiteit') && String(k.id) !== 'PRIVE'; }).forEach(function (k) {
      const al = (k.aliassen || []).filter(function (a) { return typeof a === 'string' && kort(a) && a.split(/\s+/).length <= 3; })
        .sort(function (a, z) { return (a.split(/\s+/).length > 1) - (z.split(/\s+/).length > 1) || a.length - z.length; });
      const l = al.length ? al.slice(0, 2) : [k.naam];
      eerste.push(l[0]);
      if (l[1]) tweede.push(l[1]);
    });
    const eigen = eerste.concat(tweede);
    zet('eigen', eigen);
    zet('apps', APPS);
    zet('gezin', String(b.gezin || '').split(/\s*,\s*/));
    const naamVan = function (k) { return kort(k.naam) ? k.naam : ((k.aliassen || []).find(function (a) { return typeof a === 'string' && kort(a); }) || ''); };
    zet('partners', knopen.filter(function (k) { return org(k) && ROLLEN_PARTNER.has(k.rol); }).map(naamVan));
    // 5. leveranciers: alleen organisaties uit het register; volgorde = facturen van het laatste jaar (knoop_id, anders een unieke naammatch)
    const lev = knopen.filter(function (k) { return org(k) && k.rol === 'leverancier'; });
    const tel = {};
    if (Array.isArray(b.facturen)) {
      const opNaam = {};
      lev.forEach(function (k) { [k.naam].concat(k.aliassen || []).forEach(function (n) { const s = norm(n); if (s.length >= 3) (opNaam[s] = opNaam[s] || new Set()).add(k.id); }); });
      b.facturen.forEach(function (f) {
        let id = f && f.knoop_id;
        if (!id && f) { const s = opNaam[norm(f.naam)] || opNaam[norm(kort(f.naam))]; if (s && s.size === 1) id = Array.from(s)[0]; }
        if (id) tel[id] = (tel[id] || 0) + (Number(f.n) || 0);
      });
    }
    zet('leveranciers', lev.filter(function (k) { return tel[k.id] > 0; }).sort(function (a, z) { return tel[z.id] - tel[a.id]; }).map(naamVan));
    zet('woorden', woordenUit(b.woorden));
    // samen, binnen MAX_TEKENS (de groepen in volgorde; wat er niet meer bij past, valt weg)
    const namen = [];
    let len = 0;
    const tellen = {};
    ['eigen', 'apps', 'gezin', 'partners', 'leveranciers', 'woorden'].forEach(function (g) {
      tellen[g] = 0;
      for (const n of groepen[g] || []) { if (len + n.length + 2 > MAX_TEKENS) continue; namen.push(n); len += n.length + 2; tellen[g]++; }
    });
    return { tekst: namen.join(', '), tellen: tellen };
  }

  async function hint() {
    if (cache && nu() - cache.op < CACHE_MS) return cache.tekst;
    const b = { fouten: [] };
    const poging = async function (naam, f) { try { return await f(); } catch (e) { b.fouten.push(naam); return null; } };
    b.register = o.register ? await poging('register', o.register) : null;
    b.gezin = o.gezin ? await poging('gezin', function () { return o.gezin(PLAFOND.gezin); }) : '';
    b.facturen = o.facturen ? await poging('facturen', o.facturen) : null;
    b.woorden = o.lees ? await poging('woordenlijst', function () { return o.lees('00_Systeem/Woordenlijst.md'); }) : '';
    const u = bouw(b);
    // een bron die faalde: korter in de tussenopslag (1 min), dan probeert de volgende opname het opnieuw
    cache = { op: b.fouten.length ? nu() - CACHE_MS + 60000 : nu(), tekst: u.tekst };
    laatst = { op: new Date(nu()).toISOString(), tekens: u.tekst.length, tellen: u.tellen, fouten: b.fouten };
    return u.tekst;
  }
  function info() { return laatst ? JSON.parse(JSON.stringify(laatst)) : { op: null }; }
  return { hint: hint, info: info, _bouw: bouw };
}

// Whisper zegt op stilte of geruis soms (een stuk van) zijn prompt na. Bestaat de hele uitkomst uit drie of meer namen van de lijst, in de
// volgorde van de lijst, en verder niets, dan telt hij als niets verstaan (de app zegt dan "probeer het nog eens"). Alleen in het gesprek.
function nagepraat(t, prompt) {
  const n = function (x) { return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  const lijst = String(prompt || '').split(',').map(n).filter(Boolean);
  const stukken = String(t || '').split(/[,.;!?]+/).map(n).filter(Boolean);
  if (lijst.length < 3 || stukken.length < 3) return false;
  let i = 0;
  for (const x of stukken) { const j = lijst.indexOf(x, i); if (j < 0) return false; i = j + 1; }
  return true;
}

module.exports = { maak: maak, nagepraat: nagepraat, kort: kort, woordenUit: woordenUit, MAX_TEKENS: MAX_TEKENS, APPS: APPS };
