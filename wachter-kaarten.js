'use strict';
/*
 * wachter-kaarten.js — elke nachtwachtermelding wordt een Voor jou-kaart met 2–3 passende knoppen (wv4124, besluitenpagina nr 370 = 3C70,
 * David Ja 25-11-2026 22:05; ontwerp + Codex-ontwerpreview r1/r2: /opt/data/mk-scripts/wv4124/ontwerp.md).
 *
 * WAAROM. Alleen acties en Davids eigen mailbeloftes hadden knoppen (actielijstje 07:05). Een mail die op antwoord van een ander wacht, een
 * personeelstraject of een agendamelding kon David alleen typend beantwoorden; 9 maildraden stonden op "gemeld", de oudste sinds 14-9.
 *
 * HOE.
 *  1. zet()      — de wachter (nachtrun, beurtpas; de wachter volgt uit de sessie, nooit uit de invoer) legt per melding die hij toch al doet
 *                  rij + vraag + waarom + 2–3 knoppen uit de VASTE catalogus hieronder (Codex r1 MOET 1: tekst en effect liggen hier vast;
 *                  het model kiest alleen welke en bij "rust" de dag) neer. Opslag: staat.json (één ingang per wachter + rij).
 *  2. kaartStap() — 06:52: per ingang van de laatste 2 dagen hercheck (rij nog open?); actie/belofte die vandaag al in het actielijstje staat =
 *                  geen kaart (die heeft al knoppen); hooguit 5 nieuwe kaarten per ochtend (uiterlijk eerst, dan oudste). Toon_vanaf zet
 *                  de invoegtrigger van Voor jou (07:15).
 *  3. tik()      — de knop in de app: effect op de wachtertabel (optimistisch filter), dan de kaart dicht. Duurzaam en hervatbaar (Codex r1
 *                  MOET 2): stap 'rij' → rij schrijven (merk [t:<id>] in de bevinding) → stap 'kaart' → kaart dicht → stap 'klaar'.
 *  4. ronde()    — elke 10 min: half afgemaakte tikken hervatten; een kaart die David met de algemene knoppen sloot (Gedaan / Later / Niet meer
 *                  nodig) na de ↩️-tijd doorgeven aan de wachter; een kaart waarvan de rij intussen dicht is (de wachter zag antwoord) sluiten.
 * Niets wordt verstuurd: "Ik stuur een herinnering" legt alleen vast dat David het doet; de kaart geeft de conceptzin om te kopiëren.
 * Puur waar het kan; alle tabellen, databank, klok en bestand via io (test/wachter-kaarten.sh draait het met nepdata).
 */
const crypto = require('crypto');
// wv4189 (3C160): voorwerk bij de eerste melding — toets, opdracht en uitvoercontrole in wachter-voorwerk.js; hier opslag, start en kaart
const VW = (function () { try { return require('./wachter-voorwerk.js'); } catch (e) { return null; } })();
const VW_PER_NACHT = 3;       // nieuwe voorwerk-opdrachten per nacht, alle wachters samen
const VW_LOPEND = 2;          // tegelijk lopende voorwerk-agents
const VW_START_TOT = '06:10'; // daarna start er niets meer (agent max 30 min, kaart 06:52)
const VW_POGINGEN = 40;       // mislukte starts (geen plek) vóór 'verlopen'
const VW_KWIJT_MS = 2 * 3600000;
const VW_BEWAAR_DAGEN = 400;  // één keer per klus: het register blijft ruim een jaar

const WACHTERS = ['actie', 'correspondentie', 'agenda', 'personeel'];
const NAAM = { actie: 'Actie-Bewaker', correspondentie: 'Mail', agenda: 'Agenda', personeel: 'Personeel' };
const OPEN = { actie: ['open', 'gemeld'], correspondentie: ['wacht', 'gemeld'], agenda: ['wacht', 'gemeld'], personeel: ['nieuw', 'wacht', 'gemeld'] };
const DICHT = { klaar: 'afgerond', vallen: 'genegeerd' };
// Catalogus: id → [tekst, effect, dagen]. 'tot' = de wachter geeft de dag; 'jaar' = 2 januari van volgend jaar.
const CATALOGUS = {
  correspondentie: { herinnering: ['Ik stuur een herinnering', 'rust', 5], bellen: ['Ik bel zelf', 'rust', 7], rust: ['Laat rusten tot', 'rust', 'tot'],
    binnen: ['Antwoord is al binnen', 'klaar'], vallen: ['Laat vallen', 'vallen'] },
  actie: { gedaan: ['Is gedaan', 'klaar'], week: ['Ik doe het deze week', 'rust', 7], ander: ['Ligt bij een ander', 'rust', 14],
    rust: ['Laat rusten tot', 'rust', 'tot'], vallen: ['Hoeft niet meer', 'vallen'] },
  agenda: { geregeld: ['Is geregeld', 'klaar'], klopt: ['Klopt zo', 'klaar'], zelf: ['Ik kijk er zelf naar', 'rust', 3], rust: ['Laat rusten tot', 'rust', 'tot'] },
  personeel: { geregeld: ['Is geregeld', 'klaar'], ditjaar: ['Pak ik dit jaar op', 'rust', 14], volgendjaar: ['Naar volgend jaar', 'rust', 'jaar'],
    rust: ['Laat rusten tot', 'rust', 'tot'], vallen: ['Hoeft niet meer', 'vallen'] }
};
const PER_NACHT = 8;          // per wachter per nacht
const PER_OCHTEND = 5;        // nieuwe kaarten per ochtend
const BEWAAR_DAGEN = 2;       // een ingang zonder kaart schuift hooguit 2 dagen door
const WIS_DAGEN = 30;
const KAART_UUR = '06:52';
const RONDE_MS = 10 * 60000;
const TERUG_MS = 2 * 60000;   // algemene knop pas doorgeven na de ↩️-minuut (+ marge)
const SLEUTEL_RE = /^wk-(actie|correspondentie|agenda|personeel)-[0-9a-f]{10}-\d{8}$/;
const VERBODEN_RE = /(https?:\/\/|\[\[|\]\]|\/opt\/|\/app\/|\bwv\d{2,}\b)/i;

// ── puur ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function schoon(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function dagNr(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null; }
function nrIso(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function plus(iso, d) { return nrIso(dagNr(iso) + d); }
function dm(iso) { const n = dagNr(iso); if (n === null) return '?'; const d = new Date(n * 86400000); return d.getUTCDate() + '-' + (d.getUTCMonth() + 1); }
function sleutelVoor(wachter, rij, dag) { return 'wk-' + wachter + '-' + crypto.createHash('sha256').update('wv4124|' + wachter + '|' + rij).digest('hex').slice(0, 10) + '-' + dag.replace(/-/g, ''); }
function sleutelVan(wachter, rij) { return wachter + '|' + rij; }

// De knop zoals David hem ziet en wat hij doet. tot = de dag die de wachter gaf (alleen bij 'tot').
function knopVan(wachter, k, vandaag) {
  const c = CATALOGUS[wachter] && Object.hasOwn(CATALOGUS[wachter], k.id) ? CATALOGUS[wachter][k.id] : null;
  if (!c) return { fout: 'knop ' + schoon(k.id, 20) + ' bestaat niet voor deze wachter (kies uit ' + Object.keys(CATALOGUS[wachter] || {}).join(', ') + ')' };
  const uit = { id: k.id, effect: c[1], tekst: c[0] };
  if (c[1] === 'rust') {
    let tot;
    if (c[2] === 'tot') {
      tot = String(k.tot || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(tot) || dagNr(tot) === null) return { fout: 'knop rust vraagt tot (JJJJ-MM-DD)' };
      if (!(tot > vandaag) || tot > plus(vandaag, 60)) return { fout: 'rust-dag moet na vandaag liggen en hooguit 60 dagen vooruit' };
      uit.tekst = c[0] + ' ' + dm(tot);
    } else if (c[2] === 'jaar') tot = (Number(vandaag.slice(0, 4)) + 1) + '-01-02';
    else tot = plus(vandaag, c[2]);
    uit.tot = tot;
  }
  return uit;
}

// Invoer van één wachter → { goed: [ingang], fouten: [{rij, fout}] }. Rijen worden later (io) op bestaan en open gecontroleerd.
function toets(wachter, items, vandaag) {
  const goed = [], fouten = [];
  if (WACHTERS.indexOf(wachter) < 0) return { goed: goed, fouten: [{ rij: null, fout: 'onbekende wachter' }] };
  if (!Array.isArray(items)) return { goed: goed, fouten: [{ rij: null, fout: 'verwacht een lijst' }] };
  const gezien = {};
  items.slice(0, 20).forEach(function (it) {
    const rij = it && typeof it.rij === 'string' ? it.rij.trim() : '';
    const f = function (t) { fouten.push({ rij: rij || null, fout: t }); };
    if (!rij || rij.length > 200 || /[\u0000-\u001f]/.test(rij)) return f('rij ontbreekt of is ongeldig');
    if (gezien[rij]) return f('dubbel in deze aanroep');
    const vraag = schoon(it.vraag, 200), waarom = schoon(it.waarom, 400), concept = it.concept == null ? '' : schoon(it.concept, 400);
    if (vraag.length < 10 || vraag.length > 90) return f('vraag moet 10–90 tekens zijn');
    if (waarom.length > 300) return f('waarom hooguit 300 tekens');
    if (concept.length > 300) return f('concept hooguit 300 tekens');
    if (concept && wachter !== 'correspondentie') return f('concept alleen bij de mailwachter');
    if (VERBODEN_RE.test(vraag + ' ' + waarom + ' ' + concept)) return f('geen link, vaultpad, podpad of klusnummer in vraag, waarom of concept');
    if (/`/.test(concept)) return f('concept zonder backticks');
    const ks = Array.isArray(it.knoppen) ? it.knoppen : [];
    if (ks.length < 2 || ks.length > 3) return f('2 of 3 knoppen');
    const knoppen = [];
    for (const k of ks) {
      const v = knopVan(wachter, typeof k === 'string' ? { id: k } : (k || {}), vandaag);
      if (v.fout) return f(v.fout);
      if (knoppen.some(function (x) { return x.id === v.id; })) return f('dezelfde knop twee keer');
      knoppen.push(v);
    }
    if (knoppen.every(function (x) { return x.effect === 'rust'; })) return f('minstens één knop die de zaak sluit (niet alleen rust)');
    gezien[rij] = true;
    const ing = { wachter: wachter, rij: rij, vraag: vraag, waarom: waarom, concept: concept || null, knoppen: knoppen, dag: vandaag };
    if (it.voorwerk != null) Object.defineProperty(ing, 'voorwerk_vraag', { value: it.voorwerk, enumerable: false });   // wv4189: niet in staat.json
    goed.push(ing);
  });
  if (goed.length > PER_NACHT) { goed.splice(PER_NACHT).forEach(function (g) { fouten.push({ rij: g.rij, fout: 'meer dan ' + PER_NACHT + ' per nacht' }); }); }
  return { goed: goed, fouten: fouten };
}

// Wat er in de wachterrij verandert. merk = '[t:<tik_id>]' (herkenning bij hervatten).
function rijData(wachter, rij, knop, vandaag, merk) {
  const regel = ' ‖ ' + dm(vandaag) + ' David (app): ' + knop.tekst + (knop.effect === 'rust' ? ' (wachter kijkt weer ' + dm(knop.tot) + ')' : '') + ' ' + merk;
  const d = { laatst_gecheckt: vandaag, bevinding: (String(rij.bevinding || '') + regel).slice(-4000) };
  if (knop.effect === 'rust') { d.volgende_check = knop.tot; d.geduld_tot = knop.tot; }
  else d.status = DICHT[knop.effect];
  return d;
}
function isOpen(wachter, rij) { return !!rij && OPEN[wachter].indexOf(String(rij.status || '')) >= 0; }

function kaartVoor(g, rij, dag, vw) {
  const stappen = [];
  if (vw && vw.status === 'klaar' && Array.isArray(vw.regels) && vw.regels.length) {   // wv4189: de eerste stap staat alvast klaar
    stappen.push('Alvast klaargezet: ' + vw.regels[0]);
    vw.regels.slice(1, 6).forEach(function (r) { stappen.push(r); });
  }
  if (g.concept) stappen.push(('Herinnering om te kopiëren: `' + g.concept + '`').slice(0, 400));
  if (g.wachter === 'correspondentie' && rij && /^[0-9a-f]{10,24}$/.test(String(rij.thread_id || '')) && !/doktersmaten/i.test(String(rij.bron || '')))
    stappen.push('De mailwisseling: https://mail.google.com/mail/u/0/#all/' + rij.thread_id);
  else if (g.wachter === 'correspondentie' && /doktersmaten/i.test(String(rij && rij.bron || ''))) stappen.push('De mailwisseling staat in het doktersmaten-postvak.');
  stappen.push('Kies hieronder wat je wilt; de ' + (g.wachter === 'actie' ? 'Actie-Bewaker' : NAAM[g.wachter].toLowerCase() + 'wachter') + ' neemt het vannacht mee.');
  const k = { sleutel: sleutelVoor(g.wachter, g.rij, dag), soort: 'doen', waar: 'overal', prive: false, duur_min: 2, volgorde: 45,
    titel: schoon(g.vraag, 90), waarom: schoon(g.waarom || ('Nachtwachter ' + NAAM[g.wachter] + ' vroeg dit vannacht.'), 400), stappen: stappen,
    herkomst: { module: 'wachter-kaarten', handmatig: 'wachter-kaarten', wachter: g.wachter } };
  const u = rij && /^\d{4}-\d{2}-\d{2}/.test(String(rij.uiterlijk || '')) ? String(rij.uiterlijk).slice(0, 10) : null;
  if (u && u >= dag) k.deadline = u;
  return k;
}
// volgorde voor de ochtend: uiterlijk eerst (geen uiterlijk achteraan), dan de oudste melding
function rangschik(lijst) {
  return lijst.slice().sort(function (a, b) {
    const ua = a.uiterlijk || '9999', ub = b.uiterlijk || '9999';
    return ua < ub ? -1 : ua > ub ? 1 : (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0);
  });
}

// ── met io ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/*
 * maak(io): io = {
 *   nu() → ms;  datum() → 'JJJJ-MM-DD' (Amsterdam);  klok() → 'UU:MM' (Amsterdam)
 *   lees() → staat-object | null;  schrijf(staat)                                     staat.json (atomair, 600)
 *   rij(wachter, sleutel) → rij | null                                                 wachtertabel lezen
 *   werk(wachter, sleutel, gelezen, data) → { n }                                       optimistisch: sleutel + gelezen status + bevinding
 *   inLijstje(wachter, sleutel, datum) → bool                                          voorwerk_portie van vandaag
 *   rpc(naam, args) → json                                                             mk_voor_jou_zet / _status / _lijst
 *   log(o)
 * }
 */
function maak(io) {
  function staat() {
    const s = io.lees(), t = s && typeof s === 'object' && s.ingangen && typeof s.ingangen === 'object' ? s : { ingangen: {}, kaartdag: null };
    if (!t.voorwerk || typeof t.voorwerk !== 'object') t.voorwerk = {};
    return t;
  }
  // wv4189: alle schrijvers van staat.json één voor één (zet via de route, de tik, de afloop van een agent): geen verloren schrijfactie
  let slot = Promise.resolve();
  function metSlot(fn) { const p = slot.then(fn, fn); slot = p.then(function () {}, function () {}); return p; }

  // wv4189: de voorwerkvraag bij een melding → { uitkomst: 'komt'|'al eerder'|'vol'|'te laat'|'uit' } of { fout }
  function voorwerkVraag(s, wachter, g, r, vv, vandaag) {
    if (!VW || !io.startAgent) return { uitkomst: 'uit' };
    const t = VW.toetsVraag(wachter, vv, r);
    if (t.fout) return { fout: t.fout };
    const k = sleutelVan(wachter, g.rij);
    if (s.voorwerk[k]) return { uitkomst: 'al eerder' };
    if (io.klok() >= VW_START_TOT) return { uitkomst: 'te laat' };
    if (Object.keys(s.voorwerk).filter(function (x) { return s.voorwerk[x].dag === vandaag; }).length >= VW_PER_NACHT) return { uitkomst: 'vol' };
    s.voorwerk[k] = { status: 'wacht', wachter: wachter, rij: g.rij, soort: t.soort, wat: t.wat, draad: t.draad, vraag: g.vraag, waarom: g.waarom,
      dag: vandaag, gezet_op: io.nu(), pogingen: 0 };
    return { uitkomst: 'komt', soort: t.soort };
  }

  async function zet(wachter, items) { return metSlot(function () { return zetBinnen(wachter, items); }); }
  async function zetBinnen(wachter, items) {
    const vandaag = io.datum();
    const t = toets(wachter, items, vandaag);
    const uit = { ok: true, gezet: [], al_kaart: [], fouten: t.fouten };
    const s = staat();
    for (const g of t.goed) {
      let r;
      try { r = await io.rij(wachter, g.rij); } catch (e) { uit.fouten.push({ rij: g.rij, fout: 'wachtertabel niet te lezen' }); continue; }
      if (!r) { uit.fouten.push({ rij: g.rij, fout: 'rij bestaat niet in de tabel van deze wachter' }); continue; }
      if (!isOpen(wachter, r)) { uit.fouten.push({ rij: g.rij, fout: 'rij staat niet open (status ' + schoon(r.status, 20) + ')' }); continue; }
      const k = sleutelVan(wachter, g.rij), oud = s.ingangen[k];
      if (oud && (oud.status === 'kaart' || (oud.tik && oud.tik.stap !== 'klaar'))) { uit.al_kaart.push(g.rij); continue; }
      const vv = g.voorwerk_vraag;
      s.ingangen[k] = Object.assign(g, { status: 'klaar', gezet_op: io.nu() });
      uit.gezet.push(g.rij);
      if (vv != null) (uit.voorwerk = uit.voorwerk || []).push(Object.assign({ rij: g.rij }, voorwerkVraag(s, wachter, g, r, vv, vandaag)));
    }
    io.schrijf(s);
    io.log({ stap: 'zet', wachter: wachter, gezet: uit.gezet.length, al_kaart: uit.al_kaart.length, fouten: uit.fouten.length });
    return uit;
  }

  async function kaartStap(dwing) { return metSlot(function () { return kaartStapBinnen(dwing); }); }
  async function kaartStapBinnen(dwing) {
    const vandaag = io.datum();
    const s = staat();
    if (!dwing && (s.kaartdag === vandaag || io.klok() < KAART_UUR)) return { al_gedaan: s.kaartdag === vandaag, te_vroeg: s.kaartdag !== vandaag };
    const uit = { datum: vandaag, kaarten: 0, door: 0, verlopen: 0, in_lijstje: 0, dicht: 0, fouten: 0 };
    const kand = [];
    for (const k of Object.keys(s.ingangen)) {
      const g = s.ingangen[k];
      if (g.status !== 'klaar') continue;
      if (dagNr(vandaag) - dagNr(g.dag) > BEWAAR_DAGEN) { g.status = 'verlopen'; uit.verlopen++; continue; }
      let r;
      try { r = await io.rij(g.wachter, g.rij); } catch (e) { uit.fouten++; continue; }
      if (!isOpen(g.wachter, r)) { g.status = 'overgeslagen'; g.reden = 'rij intussen dicht'; uit.dicht++; continue; }
      if ((g.wachter === 'actie' || g.wachter === 'correspondentie')) {
        let l = false;
        try { l = await io.inLijstje(g.wachter, g.rij, vandaag); } catch (e) { l = false; }
        const vk = s.voorwerk[k];
        if (l && !(vk && vk.status === 'klaar')) { g.status = 'overgeslagen'; g.reden = 'staat vandaag in het actielijstje (heeft daar knoppen)'; uit.in_lijstje++; continue; }
      }
      kand.push({ k: k, g: g, r: r, uiterlijk: r.uiterlijk ? String(r.uiterlijk).slice(0, 10) : null, dag: g.dag });
    }
    const keus = rangschik(kand);
    for (const c of keus.slice(0, PER_OCHTEND)) {
      const vk = s.voorwerk[c.k];
      const kaart = kaartVoor(c.g, c.r, vandaag, vk);
      if (vk && vk.status === 'loopt') io.log({ stap: 'voorwerk-te-laat', wachter: c.g.wachter, soort: vk.soort });
      try {
        const z = await io.rpc('mk_voor_jou_zet', { p: kaart });
        if (!z || !z.sleutel) throw new Error('geen sleutel terug');
        c.g.status = 'kaart'; c.g.kaart = kaart.sleutel; c.g.kaart_op = io.nu(); uit.kaarten++;
        if (vk && vk.status === 'klaar') { vk.op_kaart = kaart.sleutel; uit.met_voorwerk = (uit.met_voorwerk || 0) + 1; }
      } catch (e) { uit.fouten++; io.log({ stap: 'kaart-fout', wachter: c.g.wachter, fout: String(e && e.message || e).slice(0, 120) }); }
    }
    uit.door = Math.max(0, keus.length - PER_OCHTEND);
    // wissen na 30 dagen (alleen afgehandelde ingangen)
    const grens = io.nu() - WIS_DAGEN * 86400000;
    Object.keys(s.ingangen).forEach(function (k) { const g = s.ingangen[k]; if (g.status !== 'kaart' && g.status !== 'klaar' && (g.getikt_op || g.kaart_op || g.gezet_op || 0) < grens) delete s.ingangen[k]; });
    const vgrens = io.nu() - VW_BEWAAR_DAGEN * 86400000;
    Object.keys(s.voorwerk).forEach(function (k) { if ((s.voorwerk[k].gezet_op || 0) < vgrens) delete s.voorwerk[k]; });
    s.kaartdag = vandaag;
    io.schrijf(s);
    io.log(Object.assign({ stap: 'kaart' }, uit));
    return uit;
  }

  function ingangVoorKaart(s, sleutel) {
    if (!SLEUTEL_RE.test(String(sleutel || ''))) return null;
    for (const k of Object.keys(s.ingangen)) if (s.ingangen[k].kaart === sleutel) return { k: k, g: s.ingangen[k] };
    return null;
  }
  // Voor het detail in de app: de knoppen (zonder effect), of de keuze die al gemaakt is
  function detail(punt) {
    const s = staat(), f = punt && ingangVoorKaart(s, punt.sleutel);
    if (!f) return null;
    const g = f.g;
    return { wachter: NAAM[g.wachter], knoppen: g.knoppen.map(function (x) { return { id: x.id, tekst: x.tekst }; }),
      gekozen: g.tik ? (g.knoppen.find(function (x) { return x.id === g.tik.keuze; }) || {}).tekst || null : null, bezig: !!(g.tik && g.tik.stap !== 'klaar') };
  }

  // Eén stap verder met een tik; hervat waar hij bleef. Geeft { ok, melding } of { ok:false, fout, status }.
  async function voortzetten(s, f, punt, door) {
    const g = f.g, tk = g.tik, knop = g.knoppen.find(function (x) { return x.id === tk.keuze; });
    const vandaag = tk.dag, merk = '[t:' + tk.id + ']';
    if (tk.stap === 'rij') {
      let r;
      try { r = await io.rij(g.wachter, g.rij); } catch (e) { return { ok: false, status: 503, fout: 'de wachtertabel is nu niet te lezen; probeer het zo opnieuw' }; }
      if (r && String(r.bevinding || '').indexOf(merk) >= 0) tk.stap = 'kaart';   // al geschreven (vorige poging)
      else if (!isOpen(g.wachter, r)) tk.stap = 'kaart', tk.al_dicht = true;    // de wachter sloot hem intussen zelf
      else {
        let w;
        try { w = await io.werk(g.wachter, g.rij, r, rijData(g.wachter, r, knop, vandaag, merk)); } catch (e) { return { ok: false, status: 503, fout: 'opslaan bij de wachter lukte nu niet; probeer het zo opnieuw' }; }
        if (!w || !(w.n > 0)) return { ok: false, status: 409, fout: 'de wachter werkte deze zaak net bij; probeer het zo opnieuw' };
        tk.stap = 'kaart';
      }
      io.schrijf(s);
    }
    if (tk.stap === 'kaart') {
      if (punt && (punt.status === 'open' || punt.status === 'later')) {
        let z;
        try {
          z = await io.rpc('mk_voor_jou_status', { p_sleutel: g.kaart, p_van: punt.status, p_naar: tk.naar || 'gedaan', p_door: door || 'david', p_later_tot: null,
            p_bewijs: 'app ' + dm(vandaag) + ': David tikte "' + knop.tekst + '"', p_samengevoegd_in: null, p_reden: 'wachter-kaarten: knop ' + knop.id });
        } catch (e) { return { ok: false, status: 503, fout: 'vastgelegd bij de wachter; de kaart sluiten lukte nu niet en gebeurt vanzelf' }; }
        if (z && z.ok === false) return { ok: false, status: 409, fout: 'vastgelegd bij de wachter; de kaart veranderde intussen, ververs' };
      }
      tk.stap = 'klaar'; g.status = 'getikt'; g.getikt_op = io.nu();
      io.schrijf(s);
    }
    return { ok: true, melding: knop.effect === 'rust' ? 'Vastgelegd: ' + knop.tekst + '. De wachter kijkt weer op ' + dm(knop.tot) + '.'
      : 'Vastgelegd: ' + knop.tekst + '. De wachter sluit dit af' + (tk.al_dicht ? ' (had het zelf al gezien).' : '.') };
  }

  // tik vanuit de app: punt = de kaart zoals mk_voor_jou_lijst hem geeft
  async function tik(punt, keuze) { return metSlot(function () { return tikBinnen(punt, keuze); }); }
  async function tikBinnen(punt, keuze) {
    const s = staat(), f = punt && ingangVoorKaart(s, punt.sleutel);
    if (!f) return { ok: false, status: 404, fout: 'deze kaart heeft geen wachterknoppen (meer)' };
    const g = f.g;
    if (!g.knoppen.some(function (x) { return x.id === keuze; })) return { ok: false, status: 400, fout: 'onbekende knop' };
    if (g.tik && g.tik.keuze !== keuze) return { ok: false, status: 409, fout: g.tik.stap === 'klaar' ? 'je koos hier al: ' + (detail(punt) || {}).gekozen : 'je vorige keuze wordt nog verwerkt' };
    if (g.tik && g.tik.stap === 'klaar') return { ok: true, melding: 'Was al vastgelegd.' };
    if (!g.tik) {
      if (punt.status !== 'open' && punt.status !== 'later') return { ok: false, status: 409, fout: 'deze kaart is al dicht' };
      g.tik = { id: crypto.randomBytes(3).toString('hex'), keuze: keuze, stap: 'rij', dag: io.datum(), op: io.nu() };
      io.schrijf(s);
    }
    const u = await voortzetten(s, f, punt, 'david');
    io.log({ stap: 'tik', wachter: g.wachter, knop: keuze, ok: u.ok, tikstap: g.tik.stap });
    return u;
  }

  // elke 10 min: hervatten, algemene knoppen doorgeven, kaarten van dichte rijen sluiten
  async function ronde() { return metSlot(rondeBinnen); }
  async function rondeBinnen() {
    const s = staat();
    const open = Object.keys(s.ingangen).filter(function (k) { const g = s.ingangen[k]; return g.status === 'kaart' || (g.tik && g.tik.stap !== 'klaar'); });
    if (!open.length) return { niets: true };
    const lijst = await io.rpc('mk_voor_jou_lijst', { p_alles: true });
    if (!lijst || !Array.isArray(lijst.punten)) throw new Error('kaartenlijst onleesbaar');
    const per = {}; lijst.punten.forEach(function (p) { if (p && SLEUTEL_RE.test(String(p.sleutel))) per[p.sleutel] = p; });
    const uit = { hervat: 0, doorgegeven: 0, gesloten: 0, fouten: 0 };
    for (const k of open) {
      const g = s.ingangen[k], p = per[g.kaart], f = { k: k, g: g };
      try {
        if (g.tik && g.tik.stap !== 'klaar') { const u = await voortzetten(s, f, p, 'david'); if (u.ok) uit.hervat++; continue; }
        if (!p) { g.status = 'weg'; continue; }
        const laterAl = p.status === 'later' && g.later_doorgegeven === p.later_tot;   // al doorgegeven: dan alleen nog de rij-dicht-toets hieronder
        if ((p.status === 'gedaan' || p.status === 'vervallen' || (p.status === 'later' && !laterAl)) && p.gesloten_door !== 'agent' && Date.parse(p.bijgewerkt || p.gesloten_op || 0) < io.nu() - TERUG_MS) {
          // algemene knop van David → effect bij de wachter (geen kaart meer te sluiten)
          const vandaag = io.datum();
          const knop = p.status === 'gedaan' ? { id: 'kaart-gedaan', tekst: 'Gedaan (kaart)', effect: 'klaar' }
            : p.status === 'vervallen' ? { id: 'kaart-vervallen', tekst: 'Niet meer nodig (kaart)', effect: 'vallen' }
              : (p.later_tot && String(p.later_tot).slice(0, 10) > vandaag ? { id: 'kaart-later', tekst: 'Later (kaart)', effect: 'rust', tot: String(p.later_tot).slice(0, 10) } : null);
          if (!knop) continue;
          g.knoppen = g.knoppen.filter(function (x) { return x.id.indexOf('kaart-') !== 0; }).concat([knop]);
          g.tik = { id: crypto.randomBytes(3).toString('hex'), keuze: knop.id, stap: 'rij', dag: vandaag, op: io.nu() };
          io.schrijf(s);
          const u = await voortzetten(s, f, null, 'david');   // kaart is al dicht/later: alleen de rij
          if (u.ok) {
            uit.doorgegeven++;
            if (p.status === 'later') { g.later_doorgegeven = p.later_tot; g.status = 'kaart'; delete g.tik; io.schrijf(s); }
          }
          continue;
        }
        if (p.status === 'open' || p.status === 'later') {
          const r = await io.rij(g.wachter, g.rij);
          if (!isOpen(g.wachter, r)) {
            const z = await io.rpc('mk_voor_jou_status', { p_sleutel: g.kaart, p_van: p.status, p_naar: 'vervallen', p_door: 'agent', p_later_tot: null,
              p_bewijs: 'De ' + NAAM[g.wachter].toLowerCase() + 'wachter zag dat dit intussen rond is.', p_samengevoegd_in: null, p_reden: 'wachter-kaarten: rij dicht' });
            if (z && z.ok !== false) { g.status = 'rond'; g.getikt_op = io.nu(); uit.gesloten++; io.schrijf(s); }
          }
        } else if (p.gesloten_door === 'agent') { g.status = 'rond'; io.schrijf(s); }
      } catch (e) { uit.fouten++; io.log({ stap: 'ronde-fout', wachter: g.wachter, fout: String(e && e.message || e).slice(0, 120) }); }
    }
    io.schrijf(s);
    if (uit.hervat || uit.doorgegeven || uit.gesloten || uit.fouten) io.log(Object.assign({ stap: 'ronde' }, uit));
    return uit;
  }

  // wv4189: elke minuut (primaire kant): lopende agents nakijken, hooguit één wachtende opdracht starten
  async function voorwerkStap() { return metSlot(voorwerkStapBinnen); }
  async function voorwerkStapBinnen() {
    const s = staat(), vandaag = io.datum(), klok = io.klok(), uit = { gestart: 0, verlopen: 0, kwijt: 0 };
    const ks = Object.keys(s.voorwerk);
    let lopend = 0, veranderd = false;
    for (const k of ks) {
      const v = s.voorwerk[k];
      if (v.status !== 'loopt') continue;
      const st = io.agentStand ? io.agentStand(v.job) : null;
      if ((st === null || st === 'klaar' || st === 'mislukt') && io.nu() - (v.gestart_op || 0) > VW_KWIJT_MS) { v.status = 'mislukt'; v.reden = 'agent zonder afloop'; uit.kwijt++; veranderd = true; continue; }
      lopend++;
    }
    const wacht = ks.filter(function (k) { return s.voorwerk[k].status === 'wacht'; }).sort(function (a, b) { return s.voorwerk[a].gezet_op - s.voorwerk[b].gezet_op; });
    for (const k of wacht) {
      const v = s.voorwerk[k];
      if (v.dag !== vandaag || klok >= VW_START_TOT || v.pogingen >= VW_POGINGEN) { v.status = 'verlopen'; uit.verlopen++; veranderd = true; continue; }
      if (lopend >= VW_LOPEND || uit.gestart || !VW || !io.startAgent) continue;
      const gw = io.grondwet ? io.grondwet() : null;
      if (!gw) { v.pogingen++; veranderd = true; continue; }
      const ref = crypto.randomBytes(6).toString('hex');
      v.pogingen++; veranderd = true;
      let z = null;
      try { z = await io.startAgent(VW.opdracht(v, gw), ref); } catch (e) { z = null; }
      if (z && z.ok && z.job_id) { v.status = 'loopt'; v.ref = ref; v.job = z.job_id; v.gestart_op = io.nu(); uit.gestart++; lopend++; }
    }
    if (veranderd) io.schrijf(s);
    if (uit.gestart || uit.verlopen || uit.kwijt) io.log(Object.assign({ stap: 'voorwerk' }, uit));
    return uit;
  }
  // afloop van een voorwerk-agent (processAgent of de wees-afloop): ref uit het register, inhoud = voorwerk.json (of null)
  async function voorwerkAfloop(ref, a) {
    if (!/^[0-9a-f]{12}$/.test(String(ref || ''))) return { ok: false, reden: 'ref' };
    // de controle (winkelpagina's, agenda) buiten het slot; daarna opslaan onder het slot
    const s0 = staat(), k = Object.keys(s0.voorwerk).find(function (x) { return s0.voorwerk[x].ref === ref; });
    if (!k) return { ok: false, reden: 'onbekend' };
    const v0 = s0.voorwerk[k];
    if (v0.status !== 'loopt') return { ok: false, reden: 'al ' + v0.status };
    let u;
    try {
      u = await VW.uitkomst(Object.assign({}, v0, { gestart_iso: new Date(v0.gestart_op || io.nu()).toISOString() }), a && a.inhoud,
        { winkel: io.winkel, agenda: io.agenda, conceptNa: io.conceptNa, masker: io.masker, vandaag: io.datum() });
    } catch (e) { u = { status: 'mislukt', regels: [], reden: String(e && e.message || e).slice(0, 120) }; }
    return metSlot(function () {
      const s = staat(), v = s.voorwerk[k];
      if (!v || v.ref !== ref || v.status !== 'loopt') return { ok: false, reden: 'intussen ' + (v ? v.status : 'weg') };
      v.status = u.status; v.regels = u.regels; v.reden = u.reden || undefined; v.klaar_op = io.nu(); v.agent_ok = !!(a && a.ok);
      io.schrijf(s);
      io.log({ stap: 'voorwerk-afloop', wachter: v.wachter, soort: v.soort, status: v.status, regels: (v.regels || []).length, reden: v.reden ? String(v.reden).slice(0, 80) : undefined });
      return { ok: true, status: v.status, regels: (v.regels || []).length };
    });
  }

  function info() {
    const s = staat(), tel = {}, vw = {};
    Object.keys(s.ingangen).forEach(function (k) { const g = s.ingangen[k]; tel[g.status] = (tel[g.status] || 0) + 1; });
    Object.keys(s.voorwerk).forEach(function (k) { const v = s.voorwerk[k]; vw[v.status] = (vw[v.status] || 0) + 1; });
    return { aan: true, kaartdag: s.kaartdag || null, ingangen: tel, voorwerk: vw };
  }
  return { zet: zet, kaartStap: kaartStap, tik: tik, ronde: ronde, detail: detail, info: info, voorwerkStap: voorwerkStap, voorwerkAfloop: voorwerkAfloop };
}

module.exports = { maak: maak, toets: toets, knopVan: knopVan, rijData: rijData, kaartVoor: kaartVoor, rangschik: rangschik, sleutelVoor: sleutelVoor,
  CATALOGUS: CATALOGUS, WACHTERS: WACHTERS, SLEUTEL_RE: SLEUTEL_RE, RONDE_MS: RONDE_MS, KAART_UUR: KAART_UUR };
