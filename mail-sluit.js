'use strict';
/**
 * mail-sluit.js — OVIS Mail fase 2 (wv3091, 15-11-2026): de nachtelijke sluitcontrole en de lijst "Niet in je inbox gekomen".
 * Plan: vault "01_Ontwikkeling/OVIS Mail - opnieuw bekeken (Fable 5.2, 14-11-2026).md" § 3.2, § 3.3, § 5 (fase 2). David 14-11 19:03: "Er mag
 * geen mail gemist."
 *
 * WAT. Eén keer per nacht (na middernacht, pod-tik in server.js) sluit deze module de dag van gisteren en herziet de twee dagen ervoor (§ 3.3:
 * "de laatste drie dagen"). Het leesluik (n8n AI - Agenda-Wachter API, actie mail_dag, alleen lezen) geeft alle mail die Gmail die dag ontving
 * (ook spam en prullenbak; zonder eigen verzonden mail, concepten en chats) met de labels van NU, plus Davids Gmail-filters. Per bericht één
 * plek, per gesprek één uitkomst:
 *   inbox              staat nu in de inbox (jouw beurt)
 *   jij                door David afgehandeld: MailMans zaakregister zegt het, het stond bij MailMans eerste lezing in de inbox, het is
 *                      gelezen (geen filter markeerde het gelezen), of het ligt in de prullenbak zonder filter (geen automaat gooit mail weg;
 *                      gemeten 15-11: geen n8n-workflow verwijdert privémail)
 *   socev              door MailMan uit de inbox gehaald (verwerkte factuur, Ecobank …), met MailMans reden
 *   prullenbak_filter  Davids eigen filter gooide hem weg (bijvoorbeeld GitHub "Run failed")
 *   spam               spam van een onbekende afzender (alleen geteld)
 *   lijst              "Niet in je inbox gekomen": een filter hield hem buiten de inbox (§ 3.2), spam van een bekende (in de contacten of
 *                      eerder door David gemaild), MailMan zag hem nooit, of ongelezen buiten de inbox zonder aanwijsbare oorzaak
 * Elk gesprek op de lijst draagt een waarom en blijft staan tot David hem terugzet in de inbox (fase 1b, wijzig 'terug'), "Laat zo" kiest,
 * of hij 14 dagen oud is. Eén regel in het ochtendbericht alleen voor gesprekken die nieuw op de lijst kwamen (stilte is de default; nooit
 * twee keer dezelfde). MailMan zag een mail niet die ook niet in spam of prullenbak ligt = storing van de pod: één box-rij per dag.
 * GRENZEN. Niets versturen, niets verwijderen, niets in Gmail veranderen (alleen lezen; terugzetten is Davids tik via mail-app.js).
 * Bewaard (io.lees/io.schrijf, MAILMAN_DIR/sluit.json, 600): per dag tellingen en de lijst met afzender en onderwerp (zoals MailMans
 * besluit, 14 dagen), na de patiëntpoort: slaat die aan, dan geen onderwerp en "Open in Gmail". Geen mailtekst. In logs alleen tellingen.
 * PUUR waar het kan: filterPast, deel, draadUit, middernacht zijn los te toetsen. Alles naar buiten komt van server.js (io).
 */

const ID_RE = /^[0-9a-f]{10,24}$/;
const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;
const BEWAAR_DAGEN = 14, TERUG_DAGEN = 3, MAX_PAGINAS = 10, MAX_BEKEND = 25;
const VOLGORDE = ['inbox', 'lijst', 'socev', 'jij', 'prullenbak_filter', 'spam'];   // per gesprek wint de eerste
const LIJST_REDENEN = ['filter', 'spam_bekend', 'mailman_mist', 'onbekend'];

function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function str(x, n) { return typeof x === 'string' ? x.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, n) : ''; }

// ── tijd: Amsterdamse dag → UTC-ms van middernacht (zonder bibliotheek; zomer- en wintertijd) ──
function offsetMs(t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
function middernacht(dag) {
  const [y, m, d] = String(dag).split('-').map(Number);
  const basis = Date.UTC(y, m - 1, d);
  let t = basis;
  for (let i = 0; i < 3; i++) t = basis - offsetMs(t);
  return t;
}
function amsDag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function dagErbij(dag, n) { return amsDag(middernacht(dag) + n * 86400000 + 12 * 3600000); }

// ── Gmail-filters. Criteria van/aan/onderwerp lokaal nagebootst (Gmail: van/aan = deel van het adres of de naam; onderwerp = alle woorden);
// een filter met andere criteria (query, grootte, bijlage) is hier niet te beoordelen → null (onbekend), nooit een gok.
function tokens(s) {
  return String(s || '').toLowerCase().split(/\s+or\s+|[\s,;{}()|"]+/).map(function (t) { return t.trim(); }).filter(Boolean);
}
function woorden(s) { return String(s || '').toLowerCase().split(/[^0-9a-zà-ÿ]+/).filter(Boolean); }
function filterPast(f, m) {
  const c = isObj(f && f.criteria) ? f.criteria : {};
  const sleutels = Object.keys(c).filter(function (k) { return c[k] !== undefined && c[k] !== null && c[k] !== '' && c[k] !== false && k !== 'excludeChats'; });
  if (!sleutels.length) return null;
  for (const k of sleutels) {
    if (k === 'from') { const v = String(m.van || '').toLowerCase(); if (!tokens(c.from).some(function (t) { return v.includes(t); })) return false; }
    else if (k === 'to') { const v = [m.aan, m.cc, m.bezorgd].map(function (x) { return String(x || '').toLowerCase(); }).join(' '); if (!tokens(c.to).some(function (t) { return v.includes(t); })) return false; }
    else if (k === 'subject') { const w = new Set(woorden(m.onderwerp)); const nodig = woorden(c.subject); if (!nodig.length || !nodig.every(function (x) { return w.has(x); })) return false; }
    else return null;
  }
  return true;
}
// Korte, leesbare omschrijving van een filter voor de lijst (Davids eigen adres alleen als +achtervoegsel)
function filterTekst(f, namen) {
  const c = isObj(f && f.criteria) ? f.criteria : {}, a = isObj(f && f.action) ? f.action : {};
  const kort = function (s) { return String(s || '').replace(/[^\s,]*(\+[a-z0-9._-]+)@gmail\.com/gi, '$1').replace(/,\s*$/, '').slice(0, 80); };
  const wie = [c.from ? 'van ' + kort(c.from) : '', c.to ? 'aan ' + kort(c.to) : '', c.subject ? 'onderwerp "' + String(c.subject).slice(0, 60) + '"' : ''].filter(Boolean).join(', ');
  const erbij = (Array.isArray(a.addLabelIds) ? a.addLabelIds : []).map(function (id) { return id === 'TRASH' ? 'prullenbak' : (namen && namen.get(id)) || ''; }).filter(Boolean);
  return 'Je Gmail-filter (' + (wie || 'eigen zoekvraag') + ')' + (erbij.length ? ' zette hem bij ' + erbij.join(', ') : '') + ', buiten je inbox';
}

// ── één bericht → { soort, reden, filter? }. m = luikbericht (labels van nu); mm = MailMans kennis (mailSluitBron) of undefined;
// bekend = afzender in de contacten of eerder door David gemaild (alleen bij spam gevraagd).
function deel(m, mm, filters, bekend) {
  const lab = Array.isArray(m.labels) ? m.labels : [];
  const passend = (Array.isArray(filters) ? filters : []).filter(function (f) { return filterPast(f, m) === true; });
  const actie = function (f, kant, l) { const a = isObj(f.action) ? f.action : {}; return Array.isArray(a[kant]) && a[kant].includes(l); };
  if (lab.includes('SPAM')) return bekend ? { soort: 'lijst', reden: 'spam_bekend' } : { soort: 'spam', reden: 'spam' };
  if (lab.includes('TRASH')) {
    const f = passend.find(function (x) { return actie(x, 'addLabelIds', 'TRASH'); });
    return f ? { soort: 'prullenbak_filter', reden: 'filter', filter: f } : { soort: 'jij', reden: 'verwijderd' };
  }
  if (lab.includes('INBOX')) return { soort: 'inbox', reden: 'inbox' };
  if (mm && mm.socev) return { soort: 'socev', reden: mm.reden || 'socev' };
  if (mm && mm.jij) return { soort: 'jij', reden: 'jij' };
  if (mm && mm.eerst_inbox) return { soort: 'jij', reden: 'eerst_inbox' };
  const skip = passend.find(function (x) { return actie(x, 'removeLabelIds', 'INBOX'); });
  if (skip) return { soort: 'lijst', reden: 'filter', filter: skip };
  if (!mm || !mm.gezien) return { soort: 'lijst', reden: 'mailman_mist' };
  if (!lab.includes('UNREAD')) return { soort: 'jij', reden: 'gelezen' };
  return { soort: 'lijst', reden: 'onbekend' };
}
// berichten van één gesprek (met hun deel) → de uitkomst van het gesprek
function draadUit(delen) {
  let best = null;
  for (const d of delen) if (!best || VOLGORDE.indexOf(d.soort) < VOLGORDE.indexOf(best.soort)) best = d;
  return best;
}
const WAAROM_ALGEMEEN = { filter: 'Een Gmail-filter hield hem buiten je inbox', spam_bekend: 'Gmail zette hem bij spam, maar de afzender ken je',
  mailman_mist: 'Buiten je inbox en Socev zag hem niet langskomen', onbekend: 'Buiten je inbox, ongelezen; oorzaak niet te zien' };
function waaromTekst(d, namen) {
  if (d.reden === 'filter') return filterTekst(d.filter, namen);
  if (d.reden === 'spam_bekend') return 'Gmail zette hem bij spam, maar de afzender ken je (contacten of eerder gemaild)';
  if (d.reden === 'mailman_mist') return 'Buiten je inbox en Socev zag hem niet langskomen';
  return 'Buiten je inbox, ongelezen; geen filter en niet door Socev weggezet (oorzaak niet te zien)';
}

function maak(io) {
  const nu = io.nu || Date.now;
  const fout = io.fout || function () {};
  function staat() {
    let s = null;
    try { s = io.lees(); } catch (e) { s = null; }
    s = isObj(s) && s.versie === 1 ? s : { versie: 1, dagen: {}, klaar: {}, gemeld: {}, laatste: null, box: {} };
    for (const k of ['dagen', 'klaar', 'gemeld', 'box']) if (!isObj(s[k])) s[k] = {};
    return s;
  }
  function bewaar(s) {
    const grens = dagErbij(amsDag(nu()), -BEWAAR_DAGEN);
    for (const d of Object.keys(s.dagen)) if (!DAG_RE.test(d) || d < grens) delete s.dagen[d];
    const grensMs = nu() - BEWAAR_DAGEN * 86400000;
    for (const k of ['klaar', 'gemeld']) for (const t of Object.keys(s[k])) if (!(Date.parse(s[k][t]) >= grensMs) && !(isObj(s[k][t]) && Date.parse(s[k][t].op) >= grensMs)) delete s[k][t];
    for (const t of Object.keys(s.box)) if (!(Date.parse(s.box[t]) >= grensMs)) delete s.box[t];
    if (isObj(s.ochtend) && s.ochtend.dag !== amsDag(nu())) delete s.ochtend;
    io.schrijf(s);
  }
  // alle mail van één Amsterdamse dag uit het leesluik (alle pagina's); compleet = geen fout of melding onderweg
  async function haal(dag) {
    const van = middernacht(dag), tot = middernacht(dagErbij(dag, 1));
    const berichten = [];
    let filters = null, labels = [], pagina = '', compleet = true;
    for (let i = 0; i < MAX_PAGINAS; i++) {
      let j = null;
      try { j = await io.luik({ actie: 'mail_dag', van: Math.floor(van / 1000), tot: Math.floor(tot / 1000), pagina: pagina || undefined }); } catch (e) { fout('mail-sluit-luik', e); j = null; }
      if (!isObj(j) || !Array.isArray(j.berichten) || j.fout) return { ok: false };
      if (j.melding) compleet = false;
      if (filters === null) {
        if (!Array.isArray(j.filters)) return { ok: false };   // zonder filters is "waarom" niet te zeggen: liever geen uitkomst
        filters = j.filters.filter(isObj); labels = Array.isArray(j.labels) ? j.labels : [];
      }
      for (const b of j.berichten) {
        if (!isObj(b) || !ID_RE.test(String(b.id || '')) || !ID_RE.test(String(b.draad || ''))) { compleet = false; continue; }
        const t = Date.parse(b.datum || '');
        if (Number.isFinite(t) && (t < van || t >= tot)) continue;   // Gmails after/before rekent ruim; de dag zelf telt
        berichten.push({ id: String(b.id), draad: String(b.draad), labels: Array.isArray(b.labels) ? b.labels.map(String) : [], van: str(b.van, 400), aan: str(b.aan, 1000),
          cc: str(b.cc, 1000), bezorgd: str(b.bezorgd, 400), onderwerp: str(b.onderwerp, 300), datum: Number.isFinite(t) ? new Date(t).toISOString() : null });
      }
      pagina = typeof j.volgende === 'string' && /^[0-9A-Za-z_-]{1,200}$/.test(j.volgende) ? j.volgende : '';
      if (!pagina) break;
      if (i === MAX_PAGINAS - 1) compleet = false;
    }
    const namen = new Map(labels.filter(isObj).map(function (l) { return [String(l.id || ''), str(l.naam, 80)]; }));
    return { ok: true, berichten, filters, namen, compleet };
  }
  // één dag sluiten → { dag, op, compleet, tel, uit: {soort: {reden: n}}, lijst: [...] } (gesprekken)
  async function sluitDag(dag) {
    const h = await haal(dag);
    if (!h.ok) return null;
    let mm = {};
    try { mm = io.mailman.mailSluitBron(h.berichten.map(function (b) { return b.id; })) || {}; } catch (e) { fout('mail-sluit-mailman', e); return null; }
    const adres = function (v) { const x = /<([^<>\s]+@[^<>\s]+)>/.exec(v) || /([^\s<>"]+@[^\s<>"]+)/.exec(v); return x ? x[1].toLowerCase().slice(0, 200) : ''; };
    const bekendVan = {}, onzeker = new Set();   // review r4: een mislukte of overgeslagen contactencontrole is geen "onbekend"
    let gevraagd = 0;
    for (const b of h.berichten) {
      if (!b.labels.includes('SPAM')) continue;
      const a = adres(b.van);
      if (!a || Object.prototype.hasOwnProperty.call(bekendVan, a)) continue;
      if (gevraagd++ >= MAX_BEKEND) { bekendVan[a] = false; onzeker.add(a); h.compleet = false; continue; }
      try { bekendVan[a] = (await io.bekend(a)) === true; } catch (e) { fout('mail-sluit-bekend', e); bekendVan[a] = false; onzeker.add(a); h.compleet = false; }
    }
    const perDraad = new Map();
    const twijfel = new Set();   // gesprekken waarvan de plek door zo'n onzekere controle niet vaststaat: tellen als "niet gezien" bij samenvoegen
    for (const b of h.berichten) {
      if (b.labels.includes('SPAM') && onzeker.has(adres(b.van))) twijfel.add(b.draad);
      const d = Object.assign(deel(b, mm[b.id], h.filters, !!bekendVan[adres(b.van)]), { b });
      if (!perDraad.has(b.draad)) perDraad.set(b.draad, []);
      perDraad.get(b.draad).push(d);
    }
    const tel = { binnen: 0, inbox: 0, jij: 0, socev: 0, lijst: 0, prullenbak_filter: 0, spam: 0 }, uit = {}, lijst = [];
    let mist = 0;
    for (const [draad, delen] of perDraad) {
      const d = draadUit(delen);
      tel.binnen++; tel[d.soort]++;
      uit[d.soort] = uit[d.soort] || {}; uit[d.soort][d.reden] = (uit[d.soort][d.reden] || 0) + 1;
      if (d.reden === 'mailman_mist') mist++;
      if (d.soort !== 'lijst') continue;
      const b = d.b;
      // review wv3091 MOET 2: ook de waaromtekst (filtercriteria, labelnamen) gaat door de poort; bij een slot alleen een algemene reden
      const waarom = waaromTekst(d, h.namen);
      let slot = !!(mm[b.id] && mm[b.id].slot);
      if (!slot) {
        try { const p = io.poort({ teksten: [b.onderwerp, b.van, waarom].filter(Boolean), bijlagenamen: [], onderwerp: b.onderwerp, leesbaar: true }); slot = !p || p.tegenhouden !== false; }
        catch (e) { slot = true; }
      }
      lijst.push({ draad, id: b.id, dag, reden: d.reden, waarom: slot ? WAAROM_ALGEMEEN[d.reden] : waarom, van: slot ? '' : b.van.slice(0, 200), onderwerp: slot ? '' : b.onderwerp.slice(0, 200),
        datum: b.datum, slot, spam: d.reden === 'spam_bekend', ongelezen: b.labels.includes('UNREAD') });
    }
    lijst.sort(function (x, y) { return String(y.datum || '').localeCompare(String(x.datum || '')); });
    return { dag, op: new Date(nu()).toISOString(), compleet: h.compleet, berichten: h.berichten.length, tel, uit, mist, lijst, draden: Array.from(perDraad.keys()).filter(function (d) { return !twijfel.has(d); }) };
  }
  // De nachtronde: gisteren en de twee dagen ervoor opnieuw. Geeft { ok, dagen: [...], nieuw: [draden], ochtend: tekst|null, mist }.
  // ok = elke dag kwam terug EN was compleet (review wv3091 MOET 1: een onvolledige dag is geen geslaagde controle; de tik probeert opnieuw
  // en meldt na 3 pogingen). Per dag (review ronde 2 en 3): een complete uitkomst vervangt. Een onvolledige wordt bewaard als niet compleet,
  // mét de eerdere lijstgesprekken die deze poging helemaal niet zag (een gesprek dat hij nu wél zag, bijvoorbeeld terug in de inbox, krijgt
  // zijn nieuwe plek); aangevuld = hoeveel dat er bij deze uitkomst zijn (niet opgeteld). Zo verdwijnt geen gesprek stil, blijven nieuwe vondsten
  // staan, en zegt de App dat de som van die dag niet compleet is. Eerst al het Gmail-werk
  // (awaits), dan pas de staat lezen, samenvoegen en schrijven zonder await ertussen (MOET 3 ronde 1: een tik van David blijft staan).
  async function ronde() {
    const vandaag = amsDag(nu());
    const uitkomsten = [];
    for (let i = TERUG_DAGEN; i >= 1; i--) {
      const dag = dagErbij(vandaag, -i);
      let r = null;
      try { r = await sluitDag(dag); } catch (e) { fout('mail-sluit-dag', e); r = null; }
      uitkomsten.push({ dag, r });
    }
    const s = staat();
    const dagen = [];
    let ok = true;
    for (const u of uitkomsten) {
      if (!u.r) { ok = false; continue; }
      const oud = s.dagen[u.dag], zagNu = new Set(u.r.draden || []);
      delete u.r.draden;
      if (!u.r.compleet) {
        ok = false;
        const opNieuw = new Set(u.r.lijst.map(function (x) { return x.draad; }));   // review r5 ZOU 1: nooit dubbel
        const erbij = oud && Array.isArray(oud.lijst) ? oud.lijst.filter(function (x) { return !zagNu.has(x.draad) && !opNieuw.has(x.draad); }) : [];
        u.r.lijst = u.r.lijst.concat(erbij);
        u.r.aangevuld = erbij.length;
      }
      s.dagen[u.dag] = u.r; dagen.push(u.r);
    }
    const nieuw = [];
    for (const r of dagen) for (const x of r.lijst) if (!s.klaar[x.draad] && !s.gemeld[x.draad] && nieuw.indexOf(x.draad) < 0) nieuw.push(x.draad);
    const gisteren = s.dagen[dagErbij(vandaag, -1)];
    let ochtend = null;
    // MOET 4 (ronde 1) en MOET 2 (ronde 2): de regel van vannacht telt ALLE nieuwe gesprekken van deze nacht, ook als een herkansing er later
    // nog bij vindt; hij blijft open tot hij (opnieuw, met het totaal) in de buffer staat. Een regel van een vorige dag vervalt.
    if (nieuw.length && gisteren) {
      const o = isObj(s.ochtend) && s.ochtend.dag === vandaag ? s.ochtend : { dag: vandaag, draden: [] };
      const alle = o.draden.slice();
      for (const d of nieuw) if (alle.indexOf(d) < 0) alle.push(d);
      ochtend = (alle.length === 1 ? '1 mail van de afgelopen dagen kwam' : alle.length + ' mails van de afgelopen dagen kwamen')
        + ' niet in je inbox; in de App onder Mail › Niet in je inbox gekomen zie je welke en waarom.';
      s.ochtend = { dag: vandaag, tekst: ochtend, draden: alle, gezet: false };
    }
    s.laatste = { op: new Date(nu()).toISOString(), ok, dagen: dagen.map(function (r) { return r.dag; }), compleet: ok };
    bewaar(s);
    return { ok, dagen, nieuw, ochtend, mist: dagen.reduce(function (a, r) { return a + (r.mist || 0); }, 0) };
  }
  // De ochtendregel die nog bezorgd moet worden (alleen die van vandaag), en na een gelukte bezorging: weg, en deze gesprekken nooit nog eens
  function ochtendOpen() {
    const s = staat();
    return isObj(s.ochtend) && s.ochtend.dag === amsDag(nu()) && !s.ochtend.gezet && typeof s.ochtend.tekst === 'string' ? { dag: s.ochtend.dag, tekst: s.ochtend.tekst, draden: (s.ochtend.draden || []).slice() } : null;
  }
  function ochtendGezet() {
    const s = staat(), t = new Date(nu()).toISOString();
    if (isObj(s.ochtend)) { for (const d of Array.isArray(s.ochtend.draden) ? s.ochtend.draden : []) if (ID_RE.test(String(d))) s.gemeld[d] = t; s.ochtend.gezet = true; }
    bewaar(s);
  }
  // box-rij hooguit één keer per sleutel per 14 dagen
  function boxNieuw(sleutel) {
    const s = staat();
    if (s.box[sleutel]) return false;
    s.box[sleutel] = new Date(nu()).toISOString();
    bewaar(s);
    return true;
  }
  // De lijst voor de App: open gesprekken van de bewaarde dagen (nieuwste eerst, elk gesprek één keer), plus de som van gisteren
  function lijst() {
    const s = staat();
    const items = [], gezien = new Set();
    for (const dag of Object.keys(s.dagen).sort().reverse()) {
      for (const x of (s.dagen[dag].lijst || [])) {
        if (gezien.has(x.draad)) continue;
        gezien.add(x.draad);
        if (!s.klaar[x.draad]) items.push(x);
      }
    }
    const g = s.dagen[dagErbij(amsDag(nu()), -1)] || null;
    return { status: 200, j: { ok: true, items, gisteren: g ? { dag: g.dag, tel: g.tel, compleet: g.compleet, aangevuld: g.aangevuld || 0, uit: g.uit } : null, laatste: s.laatste } };
  }
  // Davids tik: 'gezien' (laat zo) of 'terug' (na een gelukte terugzetting in de inbox via mail-app.js wijzig)
  function klaar(d) {
    d = isObj(d) ? d : {};
    const draad = String(d.draad || ''), hoe = String(d.hoe || '');
    if (!ID_RE.test(draad) || (hoe !== 'gezien' && hoe !== 'terug')) return { status: 400, j: { ok: false, fout: 'onbekend' } };
    const s = staat();
    const bekend = Object.keys(s.dagen).some(function (k) { return (s.dagen[k].lijst || []).some(function (x) { return x.draad === draad; }); });
    if (!bekend) return { status: 404, j: { ok: false, fout: 'Dit gesprek staat niet op de lijst' } };
    s.klaar[draad] = { hoe, op: new Date(nu()).toISOString() };
    bewaar(s);
    return { status: 200, j: { ok: true, draad, hoe } };
  }
  function info() {
    const s = staat();
    const open = lijst().j.items.length;
    return { aan: true, laatste: s.laatste, dagen: Object.keys(s.dagen).length, open };
  }
  return { ronde, sluitDag, lijst, klaar, ochtendOpen, ochtendGezet, boxNieuw, info };
}

module.exports = { maak, deel, draadUit, filterPast, filterTekst, middernacht, amsDag, dagErbij, VOLGORDE, LIJST_REDENEN };
