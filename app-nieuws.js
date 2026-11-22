'use strict';
// app-nieuws.js — redactie-loket "nieuws uit je Apps" (wv3689, besluitenpagina nr 159 = 2C59; ontwerp mk-scripts/wv3689/ontwerp-redactie-loket.md,
// Codex GO-MET-WIJZIGINGEN 21-11, MOET 1 en 2 verwerkt). Puur: geen bestanden, geen klok; server.js geeft staat en tijd en bewaart.
// Een App meldt per onderwerp één regel (sleutel app/onderwerp). Bijwerken in plaats van herhalen; vanzelf weg door vervaldatum, aantal 0
// of (voor geziene regels zonder vervaldatum) 30 dagen na zien. Drie lanen: editie (ochtend/avond), teller (getal op de tegel), kaart
// (bundeling in Voor jou, fase 2). Het loket laat nooit zelf iets weg op inhoud en kort nooit in: ongeldige invoer is een harde fout.

const LANEN = ['editie', 'teller', 'kaart'];
const EDITIES = ['ochtend', 'avond', 'eerstvolgende'];
const APP_RE = /^[a-z0-9-]{2,30}$/;
const ONDERWERP_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const DAG_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCHERM_RE = /^[a-z0-9-]{2,40}$/;
const BRON_RE = /^[a-z0-9_-]{2,40}$/;
const MAX_TEKST = 4000;
const MAX_ONGEZIEN = 2000;
const BEWAAR_VERVALLEN_MS = 14 * 86400000;
const BEWAAR_GEZIEN_MS = 30 * 86400000;
const INHOUD = ['laan', 'tekst', 'aantal', 'datum'];
const META = ['editie', 'vervalt', 'doel', 'taalmodel', 'buffer'];

function leeg() { return { versie: 1, regels: {}, instel: {}, schaduw: {}, edities: {} }; }
function normaal(s) {
  const x = s && typeof s === 'object' && !Array.isArray(s) ? s : leeg();
  if (!x.regels || typeof x.regels !== 'object' || Array.isArray(x.regels)) x.regels = {};
  if (!x.instel || typeof x.instel !== 'object' || Array.isArray(x.instel)) x.instel = {};
  if (!x.schaduw || typeof x.schaduw !== 'object' || Array.isArray(x.schaduw)) x.schaduw = {};
  if (!x.edities || typeof x.edities !== 'object' || Array.isArray(x.edities)) x.edities = {};   // fase 2 (wv3815)
  if (!x.edities.verschenen || typeof x.edities.verschenen !== 'object' || Array.isArray(x.edities.verschenen)) x.edities.verschenen = {};
  x.versie = 1;
  return x;
}
function fout(m) { const e = new Error(m); e.loket = true; return e; }
function iso(ms) { return new Date(ms).toISOString(); }
// einde van de dag ná `dag` in Amsterdam (23:59:59), als ISO; de editie van dag D blijft zo tot en met D+1 zichtbaar
function eindeDagErna(dag) {
  const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  const ymd = d.toISOString().slice(0, 10);
  // UTC-verschuiving van Amsterdam op die dag (rond de middag; de wissel valt om 02:00/03:00, dus 23:59 heeft dezelfde verschuiving)
  const naam = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Amsterdam', timeZoneName: 'longOffset' }).formatToParts(d)
    .filter(function (x) { return x.type === 'timeZoneName'; })[0].value;   // "GMT+01:00"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(naam);
  const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 60;
  return iso(Date.parse(ymd + 'T23:59:59.000Z') - off * 60000);
}
function sleutelVan(app, onderwerp) { return app + '/' + onderwerp; }
function gelijkVeld(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

// Controleert en normaliseert een aanmelding; gooit bij elke fout (nooit stil inkorten).
function invoer(m, nu) {
  if (!m || typeof m !== 'object') throw fout('geen aanmelding');
  const app = String(m.app || ''), onderwerp = String(m.onderwerp || '');
  if (!APP_RE.test(app)) throw fout('ongeldige app');
  if (!ONDERWERP_RE.test(onderwerp)) throw fout('ongeldig onderwerp');
  const laan = m.laan === undefined ? 'editie' : String(m.laan);
  if (LANEN.indexOf(laan) < 0) throw fout('onbekende laan');
  if (m.tekst !== undefined && m.tekst !== null && typeof m.tekst !== 'string') throw fout('tekst geen tekst');
  const tekst = m.tekst == null ? '' : m.tekst;
  if (tekst.length > MAX_TEKST) throw fout('tekst te lang (' + tekst.length + ' > ' + MAX_TEKST + ')');
  if (laan !== 'teller' && !tekst.trim()) throw fout('lege tekst');
  let aantal = null;
  if (laan === 'teller') {
    if (!Number.isInteger(m.aantal) || m.aantal < 0 || m.aantal > 1e6) throw fout('teller vraagt een geheel aantal ≥ 0');
    aantal = m.aantal;
  } else if (m.aantal !== undefined && m.aantal !== null) throw fout('aantal alleen bij laan teller');
  let datum = null;
  if (m.datum !== undefined && m.datum !== null) { if (!DAG_RE.test(String(m.datum))) throw fout('ongeldige datum'); datum = String(m.datum); }
  if (laan === 'editie' && !datum) throw fout('editie vraagt een datum');
  let editie = null;
  if (laan === 'editie') { editie = m.editie === undefined || m.editie === null ? 'eerstvolgende' : String(m.editie); if (EDITIES.indexOf(editie) < 0) throw fout('onbekende editie'); }
  else if (m.editie !== undefined && m.editie !== null) throw fout('editie alleen bij laan editie');
  let vervalt = null;
  if (m.vervalt !== undefined && m.vervalt !== null) {
    const t = Date.parse(String(m.vervalt));
    if (!Number.isFinite(t)) throw fout('ongeldige vervaldatum');
    vervalt = iso(t);
  } else if (laan === 'editie') vervalt = eindeDagErna(datum);
  let doel = null;
  if (m.doel !== undefined && m.doel !== null) {
    if (typeof m.doel !== 'object' || Array.isArray(m.doel) || !SCHERM_RE.test(String(m.doel.scherm || ''))) throw fout('ongeldig doel');
    doel = { scherm: String(m.doel.scherm) };
    if (m.doel.focus !== undefined && m.doel.focus !== null) { const f = String(m.doel.focus); if (f.length > 120 || /[\u0000-\u001f]/.test(f)) throw fout('ongeldige focus'); doel.focus = f; }
  }
  if (m.taalmodel !== undefined && typeof m.taalmodel !== 'boolean') throw fout('taalmodel is ja/nee');
  let buffer = null;
  if (m.buffer !== undefined && m.buffer !== null) { if (laan !== 'editie' || !BRON_RE.test(String(m.buffer))) throw fout('ongeldige buffer-bron'); buffer = String(m.buffer); }
  void nu;
  return { app: app, onderwerp: onderwerp, laan: laan, tekst: tekst, aantal: aantal, datum: datum, editie: editie, vervalt: vervalt, doel: doel,
    taalmodel: m.taalmodel === true, buffer: buffer };
}

function levend(r, nu) { return !(r.vervalt && Date.parse(r.vervalt) <= nu); }
function telOngezien(s, nu) { let n = 0; Object.keys(s.regels).forEach(function (k) { const r = s.regels[k]; if (r && !r.gezien_op && levend(r, nu)) n++; }); return n; }

// meld(staat, aanmelding, nu) → { staat, uitkomst: nieuw|bijgewerkt|gelijk|weg|geen, sleutel, versie }
function meld(staat, m, nu) {
  const s = normaal(staat);
  const x = invoer(m, nu);
  const k = sleutelVan(x.app, x.onderwerp);
  const oud = s.regels[k] || null;
  if (x.laan === 'teller' && x.aantal === 0) {
    if (oud) { delete s.regels[k]; return { staat: s, uitkomst: 'weg', sleutel: k, versie: null }; }
    return { staat: s, uitkomst: 'geen', sleutel: k, versie: null };
  }
  if (oud && levend(oud, nu)) {
    const inhoudAnders = INHOUD.some(function (v) { return !gelijkVeld(oud[v], x[v]); });
    const metaAnders = META.some(function (v) { return !gelijkVeld(oud[v], x[v]); });
    if (!inhoudAnders && !metaAnders) return { staat: s, uitkomst: 'gelijk', sleutel: k, versie: oud.versie };
    const r = Object.assign({}, oud, x, { bijgewerkt: iso(nu), versie: (oud.versie || 1) + 1 });
    if (inhoudAnders) r.gezien_op = null;   // nieuwe inhoud komt opnieuw onder de aandacht; alleen meta anders: David zag dit al (MOET 1)
    if (inhoudAnders && oud.gezien_op && telOngezien(s, nu) >= MAX_ONGEZIEN) throw fout('loket vol (' + MAX_ONGEZIEN + ' ongeziene regels)');
    s.regels[k] = r;
    return { staat: s, uitkomst: 'bijgewerkt', sleutel: k, versie: r.versie };
  }
  if (telOngezien(s, nu) >= MAX_ONGEZIEN) throw fout('loket vol (' + MAX_ONGEZIEN + ' ongeziene regels)');
  const r = Object.assign({}, x, { gemaakt: iso(nu), bijgewerkt: iso(nu), versie: oud ? (oud.versie || 1) + 1 : 1, gezien_op: null });
  s.regels[k] = r;
  return { staat: s, uitkomst: 'nieuw', sleutel: k, versie: r.versie };
}

function schuif(s, app, laan) { const i = s.instel[app]; return !(i && i[laan] === false); }
// levende regels, nieuwste eerst; filter op laan/app/ongezien (alleen wat de vrager kiest; het loket kiest niets op inhoud)
function lijst(staat, f, nu) {
  const s = normaal(staat), o = f || {};
  return Object.keys(s.regels).map(function (k) { return Object.assign({ sleutel: k }, s.regels[k]); })
    .filter(function (r) { return levend(r, nu) && (!o.laan || r.laan === o.laan) && (!o.app || r.app === o.app) && (!o.ongezien || !r.gezien_op); })
    .sort(function (a, b) { return a.bijgewerkt < b.bijgewerkt ? 1 : a.bijgewerkt > b.bijgewerkt ? -1 : (a.sleutel < b.sleutel ? -1 : 1); });
}
// per App de som van aantal over levende teller-regels (schuif teller uit = geen getal)
function tellers(staat, nu) {
  const s = normaal(staat), uit = {};
  lijst(s, { laan: 'teller' }, nu).forEach(function (r) { if (!schuif(s, r.app, 'teller')) return; uit[r.app] = (uit[r.app] || 0) + (r.aantal || 0); });
  return uit;
}
// gezien: [{sleutel, versie}] — alleen bestaande sleutels met precies die versie (een tik op een oude versie zet een nieuwere niet weg)
function gezien(staat, lijstIn, nu) {
  const s = normaal(staat);
  if (!Array.isArray(lijstIn) || !lijstIn.length || lijstIn.length > 100) throw fout('1 tot 100 sleutels');
  let n = 0;
  lijstIn.forEach(function (g) {
    if (!g || typeof g.sleutel !== 'string' || !Number.isInteger(g.versie)) throw fout('ongeldige sleutel');
    const r = s.regels[g.sleutel];
    if (r && r.versie === g.versie && !r.gezien_op) { r.gezien_op = iso(nu); n++; }
  });
  return { staat: s, gezet: n };
}
// opruimen: vervallen regels 14 dagen na vervallen, geziene zonder vervaldatum 30 dagen na zien; ongeziene levende nooit. Schaduw 14 dagen.
function opruim(staat, nu) {
  const s = normaal(staat);
  let weg = 0;
  Object.keys(s.regels).forEach(function (k) {
    const r = s.regels[k];
    const v = r && r.vervalt ? Date.parse(r.vervalt) : null, g = r && r.gezien_op ? Date.parse(r.gezien_op) : null;
    if (!r || (v !== null && v + BEWAAR_VERVALLEN_MS <= nu) || (v === null && g !== null && g + BEWAAR_GEZIEN_MS <= nu)) { delete s.regels[k]; weg++; }
  });
  Object.keys(s.edities.verschenen).forEach(function (k) { if (!s.regels[k]) delete s.edities.verschenen[k]; });   // fase 2: alleen bestaande regels
  const grens = iso(nu - BEWAAR_VERVALLEN_MS).slice(0, 10);
  Object.keys(s.schaduw).forEach(function (d) { if (d < grens) delete s.schaduw[d]; });
  return { staat: s, weg: weg };
}
// schaduwtelling (fase 1): per dag per App hoe vaak het oude en het loketgetal gelijk waren
function schaduwTel(staat, dag, app, oud, nieuw, nu) {
  const s = normaal(staat);
  if (!DAG_RE.test(dag) || !APP_RE.test(app) || !Number.isInteger(oud) || !Number.isInteger(nieuw) || oud < 0 || nieuw < 0) throw fout('ongeldige schaduwtelling');
  const d = s.schaduw[dag] = s.schaduw[dag] || {};
  const a = d[app] = d[app] || { gelijk: 0, verschil: 0, laatst: null };
  if (oud === nieuw) a.gelijk++; else { a.verschil++; a.laatst = { oud: oud, nieuw: nieuw, op: iso(nu) }; }
  return { staat: s, gelijk: oud === nieuw };
}

// De oude bufferbronnen (fase 1 schaduw): welke App, en mocht n8n hem vandaag al aan het taalmodel geven (restcategorie/promptblok)?
const BUFFER_BRONNEN = {
  mail: { app: 'mail', taalmodel: true },
  weer: { app: 'socev', taalmodel: false },
  contactringen: { app: 'socev', taalmodel: true },
  promedico: { app: 'kalender', taalmodel: true },
  geld: { app: 'financien', taalmodel: false },
  briefing_correctie: { app: 'socev', taalmodel: true },
};
function schaduwAanmelding(bron, datum, tekst) {
  const b = Object.hasOwn(BUFFER_BRONNEN, bron) ? BUFFER_BRONNEN[bron] : null;
  if (!b) throw fout('onbekende bufferbron');
  return { app: b.app, onderwerp: bron, laan: 'editie', datum: datum, tekst: tekst, editie: 'ochtend', taalmodel: b.taalmodel, buffer: bron };
}
// De ene schrijver naar n8n-tabel ochtend_buffer (fase 2 vervangt hiermee de zes kopieën). zend(methode, pad, body) = appN8nZend.
// Precies de 8 regels die mailSluitOchtend/weerRijZet/crRijZet/promedicoRijZet/geldRijZet/appBriefingCorrectieRij elk hebben: upsert op
// bron, bij een fout na 2 s nog één keer, dan teruglezen (limit 5, filter op bron) en eisen dat de rij met deze datum en tekst er staat.
async function bufferZet(zend, tabel, bron, datum, tekst, wacht) {
  if (!BRON_RE.test(String(bron)) || !DAG_RE.test(String(datum)) || typeof tekst !== 'string') throw fout('ongeldige bufferrij');
  const filter = { type: 'and', filters: [{ columnName: 'bron', condition: 'eq', value: bron }] };
  const body = { filter: filter, data: { bron: bron, datum: datum, tekst: tekst }, returnData: true };
  const poging = function () { return zend('POST', '/data-tables/' + tabel + '/rows/upsert', body); };
  const w = wacht || function (ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); };
  await poging().catch(function () { return w(2000).then(poging); });
  const j = await zend('GET', '/data-tables/' + tabel + '/rows?limit=5&filter=' + encodeURIComponent(JSON.stringify(filter)));
  const l = (Array.isArray(j && j.data) ? j.data : []).filter(function (r) { return r && r.bron === bron && r.datum === datum && String(r.tekst || '') === tekst; });
  if (!l.length) throw new Error('rij na het schrijven niet teruggelezen');
}

// Pakjes-teller: zelfde regel als vandaagTeller in de app (src/pakjes.ts): lopend, niet verborgen, stand vandaag of afhaalpunt.
function pakjesVandaag(l) { return ((l && Array.isArray(l.lopend)) ? l.lopend : []).filter(function (p) { return p && !p.verborgen && (p.stand === 'vandaag' || p.stand === 'afhaalpunt'); }).length; }

// ── Fase 2 (wv3815): ochtend- en avondeditie, schuif per App ──
// Welke regels gaan in een editie? Levend, ongezien, laan editie, de schuif editie van die App aan, datum ≤ de editiedag, de editie past
// (ochtend: ochtend|eerstvolgende; avond: avond|eerstvolgende), en deze versie stond nog niet in een editie (edities.verschenen). Regels met
// een buffer-bron (de oude ochtendschrijvers: weer, mail, geld …) nooit: die staan al met hun eigen rij in het ochtendbericht (geen dubbeling).
// Het loket kiest niets op inhoud; wat niet past in de lengte schuift door naar de volgende editie en staat intussen in het paneel.
const APP_NAMEN = { facturen: 'Facturen', pakjes: 'Pakjes', beleggen: 'Beleggen', mail: 'Mail', kalender: 'Kalender', financien: 'Financiën',
  socev: 'Socev', pot: 'POT', docplan: 'DocPlan', gezondheid: 'Gezondheid', harvester: 'Harvester', mediatheek: 'Mediatheek', bandjes: 'Bandjes',
  pma: 'PMA', vastgoed: 'Vastgoed', imagine: 'Imagine', 'ovis-nza': 'NZa', personeelsscherm: 'Personeelsscherm', ghawa: 'GHAWA', proef: 'Proef' };
function appNaam(id) { return Object.hasOwn(APP_NAMEN, id) ? APP_NAMEN[id] : String(id).charAt(0).toUpperCase() + String(id).slice(1); }
const EDITIE_MAX = 3500;   // ochtend_buffer-rij en bericht; Opmaak kort niets in
function editieRegels(staat, soort, dag, nu) {
  if (soort !== 'ochtend' && soort !== 'avond') throw fout('onbekende editie');
  if (!DAG_RE.test(String(dag))) throw fout('ongeldige dag');
  const s = normaal(staat);
  return lijst(s, { laan: 'editie', ongezien: true }, nu).filter(function (r) {
    return !r.buffer && schuif(s, r.app, 'editie') && r.datum && r.datum <= dag && (r.editie === soort || r.editie === 'eerstvolgende') &&
      s.edities.verschenen[r.sleutel] !== r.versie;
  }).sort(function (a, b) { return a.app < b.app ? -1 : a.app > b.app ? 1 : (a.bijgewerkt < b.bijgewerkt ? -1 : a.bijgewerkt > b.bijgewerkt ? 1 : 0); });
}
// tekst: per regel "• App: tekst" (één regel); past niet alles, dan een slotregel met het aantal dat in het paneel staat (en de volgende keer komt)
function editieTekst(regels, max) {
  const m = max || EDITIE_MAX, uit = [], mee = [];
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    const regel = '• ' + appNaam(r.app) + ': ' + String(r.tekst).replace(/\s+/g, ' ').trim();
    const rest = regels.length - i - 1;
    const slot = rest > 0 ? 80 : 0;   // ruimte voor de slotregel
    if (uit.join('\n').length + regel.length + 1 + slot > m && uit.length) break;
    if (regel.length > m - slot) { uit.push(regel.slice(0, m - slot - 1) + '…'); mee.push(r); break; }   // één te lange regel: het begin, de rest in het paneel
    uit.push(regel); mee.push(r);
  }
  const over = regels.length - mee.length;
  if (over > 0) uit.push('• en nog ' + over + ' in Overzicht › Nieuw in je Apps');
  return { tekst: uit.join('\n'), mee: mee, over: over };
}
// na een gelukte editie: welke versies stonden erin (zodat de volgende editie ze niet herhaalt; "gezien" blijft van David)
function editieMarkeer(staat, soort, dag, regels, nu) {
  const s = normaal(staat);
  (regels || []).forEach(function (r) { if (r && r.sleutel && s.regels[r.sleutel] && s.regels[r.sleutel].versie === r.versie) s.edities.verschenen[r.sleutel] = r.versie; });
  s.edities[soort] = { dag: dag, op: iso(nu), n: (regels || []).length };
  return { staat: s };
}
// avond: 20:30–22:29 Amsterdamse tijd, één keer per dag (ook een avond zonder nieuws telt als gedaan, zodat hij niet blijft proberen)
function avondMoment(klok, dag, staat) {
  const m = /^(\d{2}):(\d{2})/.exec(String(klok || ''));
  if (!m) return false;
  const min = Number(m[1]) * 60 + Number(m[2]);
  if (min < 20 * 60 + 30 || min >= 22 * 60 + 30) return false;
  const a = normaal(staat).edities.avond;
  return !(a && a.dag === dag);
}
// schuif per App: { editie?, teller?, bundel? } (true/false); ontbreekt = aan. Alleen Davids eigen instelling.
function instelZet(staat, app, w) {
  const s = normaal(staat);
  if (!APP_RE.test(String(app || ''))) throw fout('ongeldige app');
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw fout('geen instelling');
  const i = Object.assign({}, s.instel[app] || {});
  let n = 0;
  ['editie', 'teller', 'bundel'].forEach(function (v) { if (w[v] === undefined) return; if (typeof w[v] !== 'boolean') throw fout(v + ' is aan/uit'); i[v] = w[v]; n++; });
  if (!n) throw fout('geen instelling');
  s.instel[app] = i;
  return { staat: s, instel: i };
}

module.exports = { leeg, normaal, meld, lijst, tellers, gezien, opruim, schaduwTel, schaduwAanmelding, bufferZet, pakjesVandaag, eindeDagErna,
  BUFFER_BRONNEN, MAX_ONGEZIEN, MAX_TEKST, editieRegels, editieTekst, editieMarkeer, avondMoment, instelZet, appNaam, EDITIE_MAX };
