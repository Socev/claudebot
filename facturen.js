'use strict';
/*
 * facturen.js — de App-kant van de Facturen-app: routes /app/facturen/* (wv833, fase F2, 22-10-2026). Bouwplan: vault
 * "01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md" § 4.1–4.4 en § 7; ontwerp v2 (mk-scripts/facturen/overdracht-2210/
 * bouwplan.md) § 3 (schermen), § 4.4 (status en betaalspoor), § 4.6 (bankcontrole en signalen).
 *
 * WAAROM. De App praat met de pod; hier zitten de rechten (eigenaar = Davids app-sessie, praktijkmanager in het model voor F6), de
 * één-klik-Bevestigen met terugdraaien, Nagebeld, de uploads en de bankcontrole. De beslissingen zelf staan in facturen-kern.js en
 * facturen-bank.js (puur); de database dwingt in facturen-db.js af wat nooit mag. Dit bestand verbindt ze, in één transactie per handeling.
 *
 * VORM. Geen HTTP: server.js geeft per verzoek { methode, pad, d, rol, primair, versOk, versVerbruik, uploadNeem, nu } en krijgt
 * { status, j, reden } terug (patroon bandjes.js). Zo toetst test/facturen-routes.sh alles op een wegwerpdatabase zonder server.
 *
 * NIET ONDERHANDELBAAR (bouwplan § 1). Niets hier betaalt of verstuurt: Bevestigen zet een opdracht klaar die de koerier (F4) pas na
 * verstuur_na oppakt en die tot dan terug kan. Privé krijgt nooit een opdracht (kern + database). Nieuw IBAN blokkeert Bevestigen tot
 * Nagebeld (verse vingerafdruk). Regels van Privé-rekeningen worden niet opgeslagen; een onbekende rekening weigert het hele bestand.
 * Geen factuurtekst: een PDF-upload wacht op de koerier (te_lezen), een UBL wordt direct verwerkt; behalve het stuk zelf (de bijlage voor
 * de boekhouder) blijven alleen velden en besluitrijen over.
 * Elke query filtert op rol en entiteit; schrijven kan alleen op de primaire kant (anders 409). Foutmeldingen noemen nooit een bedrag,
 * naam, IBAN of omschrijving uit een stuk of bankbestand.
 *
 * Geen netwerk- of procesmodule (CI-poort in .github/workflows/build.yml): versturen doet de koerier (F4).
 */
const fs = require('fs');
const K = require('./facturen-kern.js');
const B = require('./facturen-bank.js');
const V = require('./facturen-validatie.js');
const D = require('./facturen-db.js');
const S = require('./facturen-sepa.js');
const SP = require('./facturen-specificatie.js');
// wv2043: creditcard (ICS) als bron; ontbreekt het bestand in een release, dan alleen geen opdracht creditcard (de rest van Facturen blijft)
let CC = null;
try { CC = require('./facturen-creditcard.js'); } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND' && /facturen-creditcard/.test(e.message))) throw e; CC = null; }
// wv2056: PayPal zakelijk als bron; ontbreekt het bestand in een release, dan alleen geen opdracht paypal
let FP = null;
try { FP = require('./facturen-paypal.js'); } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND' && /facturen-paypal/.test(e.message))) throw e; FP = null; }
// wv2060: maandspecificatie PayPal en creditcard; ontbreekt het bestand in een release, dan alleen geen maandspecificatie
let MS = null;
try { MS = require('./facturen-maandspec.js'); } catch (e) { if (!(e && e.code === 'MODULE_NOT_FOUND' && /facturen-maandspec/.test(e.message))) throw e; MS = null; }

const ID_RE = /^[0-9a-f]{16}$/;
const BEURT_RE = /^[a-z0-9-]{8,64}$/;
const PREFIX = '/app/facturen';
const DOC_PER_UUR = 120;            // eigen teller documentinzage (precedent APP_BESTAND_PER_UUR), los van de gedeelde app-teller
const LIJST_MAX = 500;
const BANK_DAGEN = 400;             // bankcontrole en bankluis kijken zo ver terug
const ONDERWEG = ['in_wachtrij', 'wordt_verstuurd', 'concept_klaar', 'verstuurd', 'verzending_mislukt'];
const BETAAL_STATUS = ONDERWEG.concat(['prive_archief']);
const STAPPEN = { beoordelen: ['te_beoordelen'], wachtrij: ['in_wachtrij', 'wordt_verstuurd'], prive: ['prive_archief'], geen: ['geen_factuur'],
  dubbel: ['dubbel'], mislukt: ['verzending_mislukt'], verstuurd: ['concept_klaar', 'verstuurd'] };
// Alle routes (de toets controleert ze tegen APP_ROUTE_RE van server.js en de doorgeef-Function: [a-z0-9/-]{1,64}).
const ROUTES = {
  GET: ['', 'lijst/<stap>', 'factuur/<id>', 'document/<id>', 'kandidaten/<id>', 'betalen', 'bank', 'bank/oranje/<week>', 'uploads', 'leveranciers', 'instellingen', 'validatie', 'regels',
    'afzender-voorstellen', 'maand-specificatie'],
  POST: ['bevestig', 'terugdraaien', 'nagebeld', 'geen-factuur', 'toch-factuur', 'wijzig', 'ingevoerd', 'ingevoerd-ongedaan', 'opnieuw',
    'terug-naar-beoordelen', 'signaal', 'voorstel', 'feit', 'koppel', 'upload', 'leverancier', 'bankluis', 'validatie',
    'instellingen/adres', 'instellingen/modus', 'instellingen/verzendmoment', 'instellingen/rekening', 'instellingen/uitzondering',
    'betaaldatum', 'sepa-batch', 'sepa-bestand', 'sepa-specificatie', 'regel', 'regel-weg', 'afzender-voorstel', 'maand-specificatie', 'bank-keuze'],
};
// Routes die server.js in APP_BEHEER_ROUTES zet (nooit vanaf een vaste plek) én die hier een verse vingerafdruk vragen.
const BEHEER = ['POST /app/facturen/instellingen/adres', 'POST /app/facturen/instellingen/modus'];

class RouteFout extends Error {
  constructor(status, fout, extra) { super(fout); this.status = status; this.fout = fout; this.extra = extra || null; }
}
const weiger = (status, fout, extra) => { throw new RouteFout(status, fout, extra); };

// ───────────────────────────── tijd en kleine hulpjes ─────────────────────────────

function nuIso(nu) { return new Date(nu).toISOString(); }
function dagAmsterdam(nu) { return new Date(nu).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function eind4(iban) { return iban ? '…' + String(iban).slice(-4) : null; }
function json(v, standaard) { if (typeof v !== 'string') return v == null ? standaard : v; try { return JSON.parse(v); } catch (e) { return standaard; } }
function int(v) { return Number.isSafeInteger(v) ? v : null; }
function kort(s, n) { return s == null ? null : String(s).slice(0, n); }
function vraagId(d, k) { const v = String(d && d[k] || ''); if (!ID_RE.test(v)) weiger(400, k + ' ontbreekt of is ongeldig'); return v; }

// ───────────────────────────── rollen en entiteitfilter ─────────────────────────────

/*
 * Rol bij een ingang. 'app' = Davids app-sessie (bestaande app-poort: Access + apparaat + vingerafdruk) = eigenaar, alle entiteiten.
 * 'fac' = de smalle ingang van F6 (bouwplan § 4.3; facturen-ingang.js): de gebruiker uit de tabel (actief), entiteiten uit
 * gebruiker_entiteit. Via 'fac' altijd praktijkmanager (wv856: die ingang kent geen passkey; de database weigert sinds migratie 3 ook een
 * fac-rij met een andere rol) en nooit Privé, ook als de tabel iets anders zou zeggen. Onbekend → null (403).
 */
function rolVoor(fdb, o) {
  o = o || {};
  if (o.ingang === 'app') return { soort: 'eigenaar', wie: kort(o.wie || 'david', 100), entiteiten: null, ingang: 'app' };
  if (o.ingang !== 'fac' || !o.email) return null;
  const g = fdb.db.prepare("SELECT id, rol, actief, mag_bevestigen FROM gebruiker WHERE email = ? AND ingang = 'fac'").get(String(o.email).trim().toLowerCase());
  if (!g || g.actief !== 1) return null;
  const ents = fdb.db.prepare('SELECT entiteit FROM gebruiker_entiteit WHERE gebruiker = ?').all(g.id).map((r) => r.entiteit);
  return { soort: 'praktijkmanager', wie: kort(String(o.email).trim().toLowerCase(), 100), id: g.id, entiteiten: ents.filter((e) => e !== 'prive'), ingang: 'fac',
    mag_bevestigen: g.mag_bevestigen === 1 };
}
const isEig = (r) => r.soort === 'eigenaar';
function eisEigenaar(r) { if (!isEig(r)) weiger(403, 'alleen de eigenaar'); }
// SQL-filter op entiteit: [fragment, params]. Eigenaar alles; praktijkmanager alleen zijn entiteiten en nooit Privé.
function entIn(r, kol) {
  if (isEig(r)) return ['1=1', []];
  const ents = (r.entiteiten || []).filter((e) => e !== 'prive');
  if (!ents.length) return ['0=1', []];
  return [kol + " IN (" + ents.map(() => '?').join(',') + ") AND " + kol + " <> 'prive'", ents];
}
// Facturen: praktijkmanager ziet geen Privé, geen patiëntkenmerk, niets alleen-eigenaar en niets zonder entiteit (kan Privé zijn).
function factuurFilter(r, a) {
  if (isEig(r)) return ['1=1', []];
  const [s, p] = entIn(r, a + '.entiteit');
  return [s + ' AND ' + a + '.patientkenmerk = 0 AND ' + a + '.alleen_eigenaar = 0', p];
}
// Bankregels, signalen, voorstellen, koppelingen: alles met alleen_eigenaar (POT-rekening, patiëntkenmerk) alleen voor de eigenaar.
function eigenaarFilter(r, a, entKol) {
  if (isEig(r)) return ['1=1', []];
  const [s, p] = entIn(r, entKol || a + '.entiteit');
  return [s + ' AND ' + a + '.alleen_eigenaar = 0', p];
}
function magFactuur(r, f) {
  if (!f) return false;
  if (isEig(r)) return true;
  return K.zichtbaarVoor('praktijkmanager', { entiteit: f.entiteit, patientkenmerk: !!f.patientkenmerk, alleen_eigenaar: !!f.alleen_eigenaar }) &&
    (r.entiteiten || []).includes(f.entiteit);
}
function magEntiteit(r, e) { return isEig(r) || (e && e !== 'prive' && (r.entiteiten || []).includes(e)); }
// Leverancier: een praktijkmanager alleen als de standaard-entiteit een van de zijne is (niet leeg, niet Privé). Anders zou hij via een
// leverancier Davids Privé-stroom kunnen omleiden (leren, wijzigen) of zien (diffreview wv833 #2).
function magLeverancier(r, l) { return !!l && (isEig(r) || (!!l.standaard_entiteit && magEntiteit(r, l.standaard_entiteit))); }
function magTransactie(r, t) { return !!t && (isEig(r) || (!t.alleen_eigenaar && magEntiteit(r, t.entiteit))); }
function magSignaal(r, s) { return !!s && (isEig(r) || (!s.alleen_eigenaar && !!s.entiteit && magEntiteit(r, s.entiteit))); }

// ───────────────────────────── gegevens in de vorm van de kern ─────────────────────────────

function entiteitenRijen(fdb) { return fdb.db.prepare('SELECT * FROM entiteit ORDER BY sleutel').all().map(D.leesJson); }
function kernCtx(fdb, nu) {
  const ibans = {};
  for (const r of fdb.db.prepare('SELECT entiteit, iban FROM rekening').all()) (ibans[r.entiteit] = ibans[r.entiteit] || []).push(r.iban);
  const drempel = Number(D.metaLees(fdb, 'drempel_centen'));
  return {
    vandaag: dagAmsterdam(nu),
    entiteiten: entiteitenRijen(fdb).map((e) => ({ sleutel: e.sleutel, naam: e.naam, naam_kort: e.naam_kort, aliassen: e.aliassen || [], kvk: e.kvk,
      actief: e.actief === 1, boekhoud_doel: e.boekhoud_doel, ibans: ibans[e.sleutel] || [] })),
    drempelCenten: Number.isSafeInteger(drempel) && drempel > 0 ? drempel : undefined,
  };
}
function leverancierLijst(fdb) {
  const ibans = {}, namen = {}, naamtoets = {};
  for (const r of fdb.db.prepare('SELECT leverancier, iban, bron FROM leverancier_iban').all()) {
    (ibans[r.leverancier] = ibans[r.leverancier] || []).push(r.iban);
    if (r.bron === 'bankhistorie') (naamtoets[r.leverancier] = naamtoets[r.leverancier] || []).push(r.iban);
  }
  // wv1360: de namen waaronder we een rekening van deze leverancier betaalden (uit het feit), voor de naamtoets bij herkennen op IBAN
  for (const f of fdb.db.prepare("SELECT leverancier, naam, bewijs FROM feit WHERE status = 'bevestigd' AND leverancier IS NOT NULL").all()) {
    const n = namen[f.leverancier] = namen[f.leverancier] || [];
    if (f.naam) n.push(f.naam);
    const b = json(f.bewijs, {}) || {};
    for (const x of Array.isArray(b.namen) ? b.namen : []) { const t = typeof x === 'string' ? x : x && x.naam; if (t) n.push(String(t)); }
  }
  return fdb.db.prepare('SELECT * FROM leverancier').all().map((r) => {
    const l = D.leesJson(r);
    l.ibans = ibans[l.id] || [];
    l.namen = Array.from(new Set(namen[l.id] || [])).slice(0, 12);
    l.ibans_naamtoets = naamtoets[l.id] || [];
    return l;
  });
}
function leverancierKern(fdb, id) {
  if (!id) return null;
  const r = fdb.db.prepare('SELECT * FROM leverancier WHERE id = ?').get(id);
  if (!r) return null;
  const l = D.leesJson(r);
  l.ibans = fdb.db.prepare('SELECT iban FROM leverancier_iban WHERE leverancier = ?').all(id).map((x) => x.iban);
  return l;
}
function factuurOf404(fdb, r, id) {
  const f = D.factuurVoorKern(fdb, id);
  if (!f || !magFactuur(r, f)) weiger(404, 'factuur niet gevonden');
  return f;
}
function poortVoor(fdb, f, ctx) { return { leverancier: leverancierKern(fdb, f.leverancier_id), ctx }; }
function verstuurInstelling(fdb) { return json(D.metaLees(fdb, 'verstuur_instelling'), { soort: 'uur' }) || { soort: 'uur' }; }
function bestemming(e) {
  if (e.sleutel === 'prive') return 'Privé — nooit naar de boekhouder';
  if (!e.boekhoud_doel) return 'geen boekhoudadres (eerst instellen)';
  return '→ Acta (' + (e.boekhoud_route === 'mail' ? 'mail' : 'Exact') + ')';
}
function besluitRij(fdb, factuurId, b, wie, wanneer) {
  fdb.db.prepare('INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wie, wanneer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(factuurId, kort(b.stap, 60), b.veld == null ? null : kort(b.veld, 60), b.waarde == null ? null : kort(typeof b.waarde === 'string' ? b.waarde : JSON.stringify(b.waarde), 500),
      b.bron, b.toelichting == null ? null : kort(b.toelichting, 500), wie || null, wanneer);
}

// ───────────────────────────── weergave (wat de App ziet) ─────────────────────────────

function factuurKort(f, levNaam) {
  const controles = json(f.controles, []) || [];
  return { id: f.id, status: f.status, soort: f.soort, leverancier: f.leverancier, leverancier_naam: levNaam || f.leverancier_naam, nummer: f.nummer,
    factuurdatum: f.factuurdatum, vervaldatum: f.vervaldatum, incl: f.incl, valuta: f.valuta, entiteit: f.entiteit, betaalwijze: f.betaalwijze,
    betaalspoor: f.betaalspoor, iban_nieuw: !!f.iban_nieuw, nagebeld: !!f.nagebeld_op, patientkenmerk: !!f.patientkenmerk, intern: !!f.intern,
    waarschuwingen: controles.filter((c) => c && !c.ok && c.ernst !== 'info').length, versie: f.versie };
}
function txKort(t) {
  return { id: t.id, boekdatum: t.boekdatum, bedrag_centen: t.bedrag_centen, valuta: t.valuta, tegenpartij_naam: t.tegenpartij_naam, tegenpartij_iban: t.tegenpartij_iban,
    omschrijving: t.omschrijving, kenmerk: t.kenmerk, entiteit: t.entiteit, rekening: eind4(t.eigen_iban), is_incasso: !!t.is_incasso, categorie: t.categorie,
    formaat: t.formaat };
}
function signaalKort(s) {
  const d = json(s.details, {}) || {};
  const knoppen = B.SIGNALEN[s.soort] ? Object.entries(B.SIGNALEN[s.soort].knoppen).map(([k, v]) => ({ knop: k, label: v.label, vereist: v.vereist })) : [];
  return { id: s.id, soort: s.soort, titel: s.titel, entiteit: s.entiteit, leverancier: s.leverancier, naam: d.naam || null, transacties: json(s.transacties, []),
    facturen: json(s.facturen, []), bedrag_centen: s.bedrag_centen, status: s.status, afhandeling: s.afhandeling, les: s.les, wie: s.wie, wanneer: s.wanneer,
    sluimer_tot: s.sluimer_tot, aangemaakt_op: s.aangemaakt_op, knoppen,
    uitleg: B.signaalUitleg({ soort: s.soort, bedrag_centen: s.bedrag_centen, details: d }) || undefined };   // wv1326: de band in gewone taal
}

// ───────────────────────────── GET-routes ─────────────────────────────

function overzicht(fdb, r, nu) {
  const [ff, fp] = factuurFilter(r, 'f');
  const tel = (where, p) => Number(fdb.db.prepare('SELECT count(*) AS n FROM factuur f WHERE ' + where + ' AND ' + ff).get(...p, ...fp).n);
  const vandaag = dagAmsterdam(nu);
  const [sf, sp] = eigenaarFilter(r, 's');
  const signalen = Number(fdb.db.prepare("SELECT count(*) AS n FROM signaal s WHERE s.status = 'open' AND (s.sluimer_tot IS NULL OR s.sluimer_tot <= ?) AND " + sf).get(vandaag, ...sp).n);
  const [vf, vp] = eigenaarFilter(r, 'v', 't.entiteit');
  const voorstellen = Number(fdb.db.prepare("SELECT count(*) AS n FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.status = 'open' AND t.verwijderd_op IS NULL AND " + vf).get(...vp).n);
  const feiten = feitKaarten(fdb, r, nu).length;
  return {
    rol: r.soort, verzendmodus: D.metaLees(fdb, 'verzendmodus'), verstuur_instelling: verstuurInstelling(fdb),
    tellers: {
      beoordelen: tel("f.status = 'te_beoordelen'", []),
      wachtrij: tel("f.status IN ('in_wachtrij','wordt_verstuurd')", []),
      betalen: tel("f.betaalspoor = 'te_betalen' AND f.status IN (" + BETAAL_STATUS.map(() => '?').join(',') + ')', BETAAL_STATUS),
      bankcontrole: signalen + voorstellen + feiten, signalen, voorstellen, feiten,
      mislukt: tel("f.status = 'verzending_mislukt'", []),
      // concept in Gmail dat na 3 dagen nog niet verstuurd is (David gooide het weg of vergat het; Fable F4 #4): zichtbaar, geen signaal
      concept_oud: tel("f.status = 'concept_klaar' AND f.bijgewerkt_op < ?", [nuIso(nu - 3 * 86400000)]),
    },
    gezondheid: gezondheid(fdb, r, nu),
    // wv856 (Fable #9b): de namen van de eigen entiteiten, want Instellingen (waar de eigenaar ze vandaan haalt) is alleen voor de eigenaar
    entiteiten: isEig(r) ? undefined : entiteitenRijen(fdb).filter((e) => e.actief === 1 && magEntiteit(r, e.sleutel))
      .map((e) => ({ sleutel: e.sleutel, naam: e.naam, naam_kort: e.naam_kort || null })),
  };
}
// Bovenbalk rechts: bron zonder ronde in > 26 u = rood; per rekening dagen sinds de laatste upload of bankluis-ronde (oranje/rood).
function gezondheid(fdb, r, nu) {
  const bronnen = fdb.db.prepare('SELECT b.id, b.soort, b.naam, b.actief, (SELECT max(start) FROM bron_ronde WHERE bron = b.id) AS laatst, ' +
    '(SELECT ok FROM bron_ronde WHERE bron = b.id ORDER BY start DESC LIMIT 1) AS ok FROM bron b ORDER BY b.soort').all().map((b) => {
    const uur = b.laatst ? (nu - Date.parse(b.laatst)) / 3600000 : null;
    return { soort: b.soort, naam: b.naam, actief: b.actief === 1, laatste_ronde: b.laatst, ok: b.ok == null ? null : b.ok === 1,
      kleur: !b.actief ? 'grijs' : uur == null || uur > 26 || b.ok === 0 ? 'rood' : 'groen' };
  });
  const [rf, rp] = eigenaarFilter(r, 'k');
  const rekeningen = fdb.db.prepare('SELECT k.* FROM rekening k WHERE k.controle = 1 AND ' + rf + ' ORDER BY k.entiteit').all(...rp).map((k) => {
    const dagen = k.laatste_invoer_op ? Math.floor((nu - Date.parse(k.laatste_invoer_op)) / 86400000) : null;
    return { id: k.id, entiteit: k.entiteit, iban: eind4(k.iban), bank_formaat: k.bank_formaat, laatste_invoer_op: k.laatste_invoer_op, dagen,
      kleur: dagen == null || dagen >= k.rood_na_dagen ? 'rood' : dagen >= k.waarschuw_na_dagen ? 'oranje' : 'groen' };
  });
  // de koerier (F4): laatste ronde; geen ronde in > 3 uur of de laatste mislukt = rood (storingen zichtbaar)
  const kr = json(D.metaLees(fdb, 'koerier_ronde'), null);
  const kUur = kr && kr.op ? (nu - Date.parse(kr.op)) / 3600000 : null;
  const koerier = { laatste_ronde: kr ? kr.op : null, ok: kr ? !!kr.ok : null, fout: kr && kr.fout ? kort(kr.fout, 80) : null,
    kleur: kUur == null || kUur > 3 || (kr && !kr.ok) ? 'rood' : 'groen' };
  return { bronnen, rekeningen, koerier };
}
function lijst(fdb, r, stap) {
  const st = STAPPEN[stap];
  if (!st) weiger(404, 'onbekende stap');
  if (stap === 'prive') eisEigenaar(r);
  const [ff, fp] = factuurFilter(r, 'f');
  const volgorde = stap === 'beoordelen' ? 'f.aangemaakt_op, f.id' : 'f.bijgewerkt_op DESC, f.id';
  const rijen = fdb.db.prepare('SELECT f.*, l.naam AS lev_naam FROM factuur f LEFT JOIN leverancier l ON l.id = f.leverancier WHERE f.status IN (' +
    st.map(() => '?').join(',') + ') AND ' + ff + ' ORDER BY ' + volgorde + ' LIMIT ' + LIJST_MAX).all(...st, ...fp);
  const op = fdb.db.prepare('SELECT id, status, verstuur_na, poging, fout, modus FROM opdracht WHERE factuur = ? ORDER BY aangemaakt_op DESC LIMIT 1');
  return { stap, facturen: rijen.map((f) => Object.assign(factuurKort(f, f.lev_naam), stap === 'beoordelen' ? {} : { opdracht: op.get(f.id) || null })) };
}
function detail(fdb, r, id, nu) {
  const f = factuurOf404(fdb, r, id);
  const ctx = kernCtx(fdb, nu);
  const poort = poortVoor(fdb, f, ctx);
  const ip = K.ibanPoort(f, poort.leverancier, ctx);
  const doc = (did) => {
    if (!did) return null;
    const d = fdb.db.prepare('SELECT id, naam, mime, bytes, soort FROM document WHERE id = ?').get(did);
    return d ? { id: d.id, naam: d.naam, mime: d.mime, bytes: d.bytes, soort: d.soort } : null;
  };
  const lev = magLeverancier(r, poort.leverancier) ? poort.leverancier : null;
  const ents = entiteitenRijen(fdb).filter((e) => e.actief === 1 && magEntiteit(r, e.sleutel))
    .map((e) => ({ sleutel: e.sleutel, naam: e.naam_kort || e.naam, bestemming: bestemming(e) }));
  const [kf0, kp] = eigenaarFilter(r, 'k', 't.entiteit');
  const kf = isEig(r) ? kf0 : kf0 + ' AND t.alleen_eigenaar = 0';
  return {
    factuur: Object.assign(factuurKort(Object.assign({}, f, { controles: f.controles }), lev ? lev.naam : null), {
      excl: f.excl, btw: f.btw, incl_eur: f.incl_eur, iban: f.iban, ibans_betaal: f.ibans_betaal, ibans_onbekend: ip.onbekend, kenmerk: f.kenmerk,
      redenen: f.redenen, controles: f.controles, bevestigd_door: f.bevestigd_door, bevestigd_op: f.bevestigd_op, ingevoerd_door: f.ingevoerd_door,
      ingevoerd_op: f.ingevoerd_op, betaald_gezien_op: f.betaald_gezien_op, nagebeld_door: f.nagebeld_door, nagebeld_op: f.nagebeld_op,
      nagebeld_ibans: f.nagebeld_ibans, dubbel_van: f.dubbel_van, aangemaakt_op: f.aangemaakt_op }),
    iban_poort: { iban_nieuw: ip.iban_nieuw, reden: ip.reden },
    bevestigen: K.magBevestigen(f, poort),
    leverancier: lev ? { id: lev.id, naam: lev.naam, standaard_entiteit: lev.standaard_entiteit, standaard_betaalwijze: lev.standaard_betaalwijze,
      ibans: lev.ibans, alleen_portaal: !!lev.alleen_portaal, mediaan: lev.mediaan } : null,
    documenten: { document: doc(f.document_id), ubl: doc(f.ubl_document_id) },
    besluiten: fdb.db.prepare('SELECT stap, veld, waarde, bron, toelichting, wie, wanneer FROM besluit WHERE factuur = ? ORDER BY id').all(f.id),
    opdrachten: fdb.db.prepare('SELECT id, status, verstuur_na, poging, fout, modus, aangemaakt_op, opgehaald_op FROM opdracht WHERE factuur = ? ORDER BY aangemaakt_op DESC').all(f.id),
    koppelingen: fdb.db.prepare('SELECT k.bron, k.methode, k.zekerheid, k.volledig, k.wanneer, t.* FROM koppeling k JOIN bank_transactie t ON t.id = k.transactie WHERE k.factuur = ? AND ' + kf)
      .all(f.id, ...kp).map((k) => Object.assign(txKort(k), { koppeling: { bron: k.bron, methode: k.methode, zekerheid: k.zekerheid, volledig: k.volledig } })),
    entiteiten: ents,
    verzendmodus: D.metaLees(fdb, 'verzendmodus'),
    bedragpatroon: bedragpatroonVoor(fdb, r, f, ctx.vandaag),
    afzender: isEig(r) ? afzenderVan(fdb, f) : undefined,   // wv1917: voor "Onthoud voor deze afzender"
    // wv1323: een feitkaart voor een rekening op deze factuur (alleen de eigenaar; de factuur moet nagebeld worden)
    feiten: ip.iban_nieuw && f.status === 'te_beoordelen' ? feitKaarten(fdb, r, nu).filter((k) => k.facturen.some((x) => x.id === f.id)) : [],
  };
}
// wv1317: gebruikelijke bandbreedte van de betalingen aan het IBAN van deze factuur (laatste 12 maanden, eigen entiteit), met het oordeel
// over het factuurbedrag. Alleen over bankregels die deze rol mag zien; zonder IBAN of met < 3 betalingen: null.
function bedragpatroonVoor(fdb, r, f, vandaag) {
  const iban = K.ibanNorm(f.iban);
  if (!iban || !f.entiteit || !Number.isSafeInteger(f.incl) || f.incl <= 0) return null;
  const [tf, tp] = eigenaarFilter(r, 't');
  const lijst = fdb.db.prepare('SELECT id, boekdatum, bedrag_centen FROM bank_transactie t WHERE t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.entiteit = ? AND t.tegenpartij_iban = ? ' +
    'AND t.boekdatum >= ? AND ' + tf).all(f.entiteit, iban, K.plusDagen(vandaag, -365), ...tp);
  const p = V.bedragPatroon(lijst, vandaag, f.incl);
  return p ? Object.assign({ rekening: eind4(iban) }, p) : null;
}
// Documentinzage: JSON met base64 (de App tekent met pdf.js); rolcontrole via de factuur of het POT-afschrift; elke inzage een auditrij.
function document(fdb, r, id, o) {
  const d = fdb.db.prepare('SELECT * FROM document WHERE id = ?').get(id);
  if (!d) weiger(404, 'document niet gevonden');
  const f = fdb.db.prepare('SELECT id, entiteit, patientkenmerk, alleen_eigenaar FROM factuur WHERE document = ? OR ubl_document = ?').get(id, id);
  let entiteit = null;
  if (f) { if (!magFactuur(r, f)) weiger(404, 'document niet gevonden'); entiteit = f.entiteit; }
  else if (fdb.db.prepare('SELECT 1 FROM pot_afschrift WHERE mt940_document = ? OR pdf_document = ?').get(id, id)) { if (!isEig(r)) weiger(404, 'document niet gevonden'); entiteit = 'pot'; }
  else if (!isEig(r) && d.geupload_door !== r.wie) weiger(404, 'document niet gevonden');   // nog te lezen upload: eigenaar of wie hem uploadde
  if (!o.teller()) weiger(429, 'te veel stukken bekeken dit uur (max ' + o.docPerUur + ')');
  const inhoud = D.stukLees(fdb, d.sha256);
  D.audit(fdb, { wie: r.wie, wat: 'document_inzage', object_soort: 'document', object_id: d.id, entiteit, na: { factuur: f ? f.id : null, bytes: inhoud.length }, wanneer: nuIso(o.nu) });
  return { naam: d.naam, type: d.mime || (d.soort === 'pdf' ? 'application/pdf' : 'application/octet-stream'), soort: d.soort, grootte: inhoud.length, sha256: d.sha256,
    inhoud: inhoud.toString('base64') };
}
/*
 * Kandidaat-bankposten voor een signaal waarvan een knop een transactie vraagt (te_betalen_niet_betaald › Is al betaald,
 * ingevoerd_niet_gezien › Koppelen; overdracht F3 #2): afschrijvingen van de entiteit van het signaal in de laatste 60 dagen met een
 * bedrag binnen ± 5 % van het signaal, rol- en POT-filter (eigenaarFilter), hooguit 20, dichtstbijzijnde bedrag eerst.
 */
const KANDIDAAT_SOORTEN = ['te_betalen_niet_betaald', 'ingevoerd_niet_gezien'];
function kandidaten(fdb, r, id, nu) {
  const s = fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(id);
  if (!magSignaal(r, s)) weiger(404, 'signaal niet gevonden');
  if (!KANDIDAAT_SOORTEN.includes(s.soort)) weiger(409, 'bij dit signaal hoort geen bankpost om te kiezen');
  if (!s.entiteit || !Number.isSafeInteger(s.bedrag_centen) || s.bedrag_centen <= 0) return { signaal: s.id, kandidaten: [] };
  const doel = s.bedrag_centen, marge = Math.max(1, Math.round(doel * 0.05));
  const [tf, tp] = eigenaarFilter(r, 't');
  const rijen = fdb.db.prepare('SELECT t.*, (SELECT count(*) FROM koppeling k WHERE k.transactie = t.id) AS kop FROM bank_transactie t WHERE t.verwijderd_op IS NULL AND t.entiteit = ? ' +
    'AND t.bedrag_centen < 0 AND -t.bedrag_centen BETWEEN ? AND ? AND t.boekdatum >= ? AND ' + tf + ' ORDER BY abs(-t.bedrag_centen - ?), t.boekdatum DESC LIMIT 20')
    .all(s.entiteit, doel - marge, doel + marge, K.plusDagen(dagAmsterdam(nu), -60), ...tp, doel);
  return { signaal: s.id, kandidaten: rijen.map((t) => Object.assign(txKort(t), { gekoppeld: t.kop > 0 })) };
}
function betalen(fdb, r, nu) {
  const [ff, fp] = factuurFilter(r, 'f');
  const ctx = kernCtx(fdb, nu), vandaag = ctx.vandaag;
  const st = BETAAL_STATUS.map(() => '?').join(',');
  const rijen = fdb.db.prepare("SELECT f.id FROM factuur f WHERE f.betaalspoor IN ('te_betalen','ingevoerd') AND f.status IN (" + st + ') AND ' + ff +
    ' ORDER BY f.vervaldatum IS NULL, f.vervaldatum, f.id LIMIT ' + LIJST_MAX).all(...BETAAL_STATUS, ...fp);
  const teBetalen = [], ingevoerd = [], geblokkeerd = [];
  let verw = null;   // wv2057: bankdekking en batches, alleen als er iets ingevoerd is
  for (const { id } of rijen) {
    const f = D.factuurVoorKern(fdb, id);
    const lev = leverancierKern(fdb, f.leverancier_id);
    const rij = { id: f.id, entiteit: f.entiteit, leverancier_naam: lev ? lev.naam : f.leverancier_naam, iban: f.iban, vervaldatum: f.vervaldatum,
      dringend: !!(f.vervaldatum && K.dagenTussen(vandaag, f.vervaldatum) <= 3), omschrijving: [f.nummer, f.kenmerk].filter(Boolean).join(' ') || null,
      incl: f.incl, valuta: f.valuta, ingevoerd_door: f.ingevoerd_door, ingevoerd_op: f.ingevoerd_op, zegt_betaald: zegtBetaald(fdb, f.id) };
    // wv1405: uitvoerdatum en of hij in een SEPA-batch kan (alleen de eigenaar maakt batches; de praktijkmanager ziet de lijst zoals voorheen)
    if (isEig(r)) Object.assign(rij, sepaBetaalInfo(fdb, f, lev, ctx, vandaag), f.betaalspoor === 'ingevoerd' ? { uitvoer_op: f.uitvoer_op || null } : {});
    if (f.betaalspoor === 'ingevoerd') rij.in_batch = !!f.uitvoer_op;   // ook de praktijkmanager: geen Ongedaan op een batchregel (MOET 2)
    // wv2057: wanneer had hij op de bank moeten staan, en is de bank van die rekening al zo ver? (stand wacht / niet_gezien / bank_achter)
    if (f.betaalspoor === 'ingevoerd') {
      if (!verw) verw = { dekking: bankDekking(fdb), actief: bankActief(fdb, vandaag), sepa: sepaVoorControle(fdb, nuIso(Date.parse(K.plusDagen(vandaag, -BANK_DAGEN) + 'T00:00:00Z'))),
        rekeningen: fdb.db.prepare('SELECT iban, entiteit, controle FROM rekening').all(), vandaag };
      // alleen voor een entiteit waarvan de app een bank ziet (Privé en POT zonder bankluis: geen stand, dan zou "upload een export" misleiden)
      const v = verw.rekeningen.some((k) => k.entiteit === f.entiteit && k.controle === 1) ? B.betaalVerwachting(f, verw) : null;
      if (v) rij.bank = { verwacht: v.verwacht, termijn_tot: v.termijn_tot, bijgewerkt_tot: v.dekking, stand: v.stand };
      // diffreview KAN 8: staat er een betaling met ons kenmerk maar een ander bedrag (open voorstel), dan zegt de lijst dat, niet "niet gezien"
      if (rij.bank && fdb.db.prepare("SELECT 1 FROM voorstel v WHERE v.status = 'open' AND json_extract(v.details, '$.reden') IN ('bedrag wijkt af','kenmerk klopt, bedrag niet') " +
        'AND EXISTS (SELECT 1 FROM json_each(v.facturen) j WHERE j.value = ?)').get(f.id)) rij.bank.stand = 'afwijkend';
    }
    // een factuur met een openstaande IBAN-blokkade staat er niet op (ontwerp v2 § 3), met een verwijzing naar Beoordelen
    if (K.isCreditnota(f)) continue;   // een creditnota hoort nooit op de betaallijst (wv855; staat er een oude op te_betalen, dan niet tonen)
    if (K.magBevestigen(Object.assign({}, f, { status: 'te_beoordelen' }), { leverancier: lev, ctx }).redenen.some((x) => /IBAN/.test(x))) { geblokkeerd.push({ id: f.id, reden: 'IBAN nog niet nagebeld' }); continue; }
    (f.betaalspoor === 'ingevoerd' ? ingevoerd : teBetalen).push(rij);
  }
  return Object.assign({ te_betalen: teBetalen, ingevoerd_niet_gezien: ingevoerd, geblokkeerd }, isEig(r) ? { sepa: sepaOverzicht(fdb, nu) } : {});
}
function bank(fdb, r, nu) {
  const vandaag = dagAmsterdam(nu), maand = vandaag.slice(0, 7);
  const [sf, sp] = eigenaarFilter(r, 's');
  const open = fdb.db.prepare("SELECT s.* FROM signaal s WHERE s.status = 'open' AND (s.sluimer_tot IS NULL OR s.sluimer_tot <= ?) AND " + sf + ' ORDER BY s.aangemaakt_op DESC LIMIT ' + LIJST_MAX).all(vandaag, ...sp);
  const geleerd = fdb.db.prepare("SELECT s.* FROM signaal s WHERE s.status = 'afgehandeld' AND substr(s.wanneer, 1, 7) = ? AND " + sf + ' ORDER BY s.wanneer DESC LIMIT 200').all(maand, ...sp);
  const [vf, vp] = eigenaarFilter(r, 'v', 't.entiteit');
  const tx = fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ?');
  const [ff, fp] = factuurFilter(r, 'f');
  const fq = fdb.db.prepare('SELECT f.* FROM factuur f WHERE f.id = ? AND ' + ff);
  const [tf0, tp0] = eigenaarFilter(r, 't');
  const zelfde = fdb.db.prepare('SELECT id, boekdatum, bedrag_centen FROM bank_transactie t WHERE t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.entiteit = ? AND t.tegenpartij_iban = ? ' +
    'AND t.boekdatum >= ? AND ' + tf0);
  const levNaam = fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?');
  const kortMetNaam = (f) => { const l = f.leverancier ? levNaam.get(f.leverancier) : null; return factuurKort(f, l ? l.naam : null); };
  const voorstellen = fdb.db.prepare("SELECT v.* FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.status = 'open' AND t.verwijderd_op IS NULL AND " + vf + ' ORDER BY v.id LIMIT ' + LIJST_MAX)
    .all(...vp).map((v) => {
      const t = tx.get(v.transactie), det = json(v.details, {}) || {};
      const fs = (json(v.facturen, []) || []).map((id) => fq.get(id, ...fp)).filter(Boolean);
      const alt = (det.alternatieven || []).map((id) => fq.get(id, ...fp)).filter(Boolean);
      // wv1317: bandbreedte van de betalingen aan deze rekening (laatste 12 maanden, zonder deze regel), alleen over regels die deze rol mag zien
      const patroon = t.tegenpartij_iban && t.bedrag_centen < 0
        ? V.bedragPatroon(zelfde.all(t.entiteit, t.tegenpartij_iban, K.plusDagen(vandaag, -365), ...tp0), vandaag, -t.bedrag_centen, { zonder: t.id }) : null;
      const uitleg = B.voorstelUitleg({ methode: v.methode, zekerheid: v.zekerheid, tegenpartij_geborgd: !!det.tegenpartij_geborgd, verschil_centen: det.verschil_centen,
        creditnota: det.creditnota, reden: det.reden }, t, fs.map((f) => Object.assign(kortMetNaam(f), { iban: f.iban })), alt.map(kortMetNaam), patroon);
      return { id: v.id, methode: v.methode, zekerheid: v.zekerheid, transactie: txKort(t), facturen: fs.map(kortMetNaam), alternatieven: alt.map(kortMetNaam), uitleg, patroon };
    });
  // balk per week (laatste 8 weken, afschrijvingen): bij een factuur / bekende uitzondering / te bekijken
  const [tf, tp] = eigenaarFilter(r, 't');
  const start = startdatumVan(fdb), van56 = K.plusDagen(vandaag, -56);
  const van = start && start > van56 ? start : van56;   // wv944: historie telt niet als 'te bekijken' (Fable #5)
  const weken = {};
  for (const t of fdb.db.prepare('SELECT t.id, t.boekdatum, t.categorie, (SELECT count(*) FROM koppeling k WHERE k.transactie = t.id) AS k FROM bank_transactie t ' +
    'WHERE t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.boekdatum >= ? AND ' + tf).all(van, ...tp)) {
    const w = isoWeek(t.boekdatum);
    const x = weken[w] = weken[w] || { week: w, factuur: 0, uitzondering: 0, te_bekijken: 0 };
    if (t.k > 0) x.factuur++; else if (t.categorie) x.uitzondering++; else x.te_bekijken++;
  }
  // wv1317: "wat we deze maand leerden" gegroepeerd en in gewone taal (ook de koppelvoorstellen die vervielen), nooit een interne code
  // per entiteit, zodat de App op een vaste plek (spreekkamer) Privé en POT kan weglaten zoals bij de signalen
  const groepen = fdb.db.prepare("SELECT s.entiteit, s.soort, s.titel, s.afhandeling, s.les, count(*) AS aantal, max(s.wanneer) AS laatst FROM signaal s WHERE s.status = 'afgehandeld' AND " +
    'substr(s.wanneer, 1, 7) = ? AND ' + sf + ' GROUP BY s.entiteit, s.soort, s.titel, s.afhandeling, s.les ORDER BY laatst DESC LIMIT 100').all(maand, ...sp);
  const geleerd_regels = groepen.map((g) => ({ tekst: B.leerRegel(g), aantal: g.aantal, soort: g.soort, entiteit: g.entiteit || null }));
  const verval = new Map();
  for (const v of fdb.db.prepare("SELECT v.details, t.entiteit FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.status = 'vervallen' AND substr(v.afgehandeld_op, 1, 7) = ? AND " + vf)
    .all(maand, ...vp)) { const k = t2(v.entiteit, (json(v.details, {}) || {}).vervallen_reden || 'geen_match'); verval.set(k, (verval.get(k) || 0) + 1); }
  for (const [k, n] of verval) { const [ent, rd] = JSON.parse(k); geleerd_regels.push({ tekst: B.vervalRegel(rd, n), aantal: n, soort: 'voorstel_vervallen', entiteit: ent }); }
  for (const g of fdb.db.prepare("SELECT t.entiteit, v.status, count(*) AS n FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.status IN ('bevestigd','afgewezen') AND " +
    'substr(v.afgehandeld_op, 1, 7) = ? AND ' + vf + ' GROUP BY t.entiteit, v.status').all(maand, ...vp)) {
    geleerd_regels.push({ tekst: g.status === 'bevestigd' ? g.n + (g.n === 1 ? ' koppeling' : ' koppelingen') + ' bevestigd.' :
      g.n + (g.n === 1 ? ' koppelvoorstel' : ' koppelvoorstellen') + ' afgewezen; dezelfde koppeling wordt niet opnieuw voorgesteld.', aantal: g.n, soort: 'voorstel_' + g.status, entiteit: g.entiteit || null });
  }
  // wv2061: regels uit "te bekijken" (bank-keuze), per categorie; zonder signaal verschenen ze anders nergens
  if (isEig(r)) for (const g of fdb.db.prepare("SELECT categorie, count(DISTINCT coalesce(tegenpartij, '') || '|' || coalesce(omschrijving, '')) AS n FROM uitzondering " +
    "WHERE toelichting = 'uit de bankcontrole (te bekijken)' AND actief = 1 AND substr(aangemaakt_op, 1, 7) = ? GROUP BY categorie").all(maand)) {
    geleerd_regels.push({ tekst: g.n + (g.n === 1 ? ' tegenpartij' : ' tegenpartijen') + ' voortaan als ' + g.categorie.replace(/_/g, ' ') + ' (geen factuur nodig); komt niet meer bij te bekijken.',
      aantal: g.n, soort: 'uitzondering_regel', entiteit: null });
  }
  // wv1323: feiten die David bevestigde of afwees, in gewone taal (zonder rekeningnummer)
  const feitGroep = fdb.db.prepare("SELECT status, count(*) AS n FROM feit WHERE substr(wanneer, 1, 7) = ? GROUP BY status").all(maand);
  if (isEig(r)) for (const g of feitGroep) geleerd_regels.push({ tekst: g.status === 'bevestigd' ? g.n + (g.n === 1 ? ' rekening' : ' rekeningen') + ' vastgelegd als rekening van een leverancier (uit de bankhistorie).'
    : g.n + (g.n === 1 ? ' rekeningkaart' : ' rekeningkaarten') + ' afgewezen; nabellen blijft nodig en de kaart komt niet terug.', aantal: g.n, soort: 'feit_' + g.status, entiteit: null });
  return { signalen: open.map(signaalKort), geleerd: geleerd.slice(0, 50).map(signaalKort), geleerd_regels, voorstellen, feiten: feitKaarten(fdb, r, nu),
    weken: Object.values(weken).sort((a, b) => (a.week < b.week ? -1 : 1)) };
}
function t2(a, b) { return JSON.stringify([a || null, b]); }
/*
 * wv2061 (David 30-10-2026 22:50): het oranje deel van een week ("te bekijken") op klik, per tegenpartij gegroepeerd, met per groep een
 * voorstel: een bekende uitzondering met categorie (facturen-bank.categorieVoorstel; Davids eerdere keuze op hetzelfde patroon gaat voor)
 * of een open factuur van dezelfde entiteit als kandidaat (IBAN van de factuur eerst, dan het bedrag dat het dichtst bij ligt). Te bekijken
 * = zoals de weekbalk van bank(): afschrijving vanaf de startdatum (hooguit 56 dagen terug), geen categorie, geen koppeling.
 * Review wv2061: een regel maakt alleen de eigenaar (ZOU 8); niet bij een open fraudesignaal (ZOU 9); kwamen er van die rekening eerder
 * facturen binnen (app of FV2-archief), dan een waarschuwing en alleen met een uitdrukkelijk "toch" (MOET 1: anders koppelt een later
 * geüploade factuur nooit en ziet niemand een dubbele betaling).
 */
const ORANJE_GROEPEN_MAX = 60, ORANJE_KANDIDATEN = 5, ORANJE_REGEL_TEKST = 'uit de bankcontrole (te bekijken)';
const OPEN_FACTUUR_SQL = "f.soort = 'factuur' AND f.status NOT IN ('geen_factuur','dubbel') AND coalesce(f.incl, 0) > 0 " +
  "AND (f.betaalspoor IS NULL OR f.betaalspoor IN ('te_betalen','ingevoerd','incasso_verwacht'))";
function oranjeTx(fdb, r, nu) {
  const vandaag = dagAmsterdam(nu), start = startdatumVan(fdb), van56 = K.plusDagen(vandaag, -56);
  const van = start && start > van56 ? start : van56;
  const [tf, tp] = eigenaarFilter(r, 't');
  return fdb.db.prepare('SELECT t.* FROM bank_transactie t WHERE t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.boekdatum >= ? AND t.categorie IS NULL ' +
    'AND NOT EXISTS (SELECT 1 FROM koppeling k WHERE k.transactie = t.id) AND ' + tf + ' ORDER BY t.boekdatum, t.id').all(van, ...tp);
}
function eerdereKeuze(fdb, r, p) {
  if (!p) return null;
  const x = p.patroon;
  const u = fdb.db.prepare('SELECT categorie FROM uitzondering WHERE actief = 1 AND coalesce(tegenpartij, \'\') = ? AND coalesce(omschrijving, \'\') = ? AND coalesce(transactietype, \'\') = ? ' +
    (isEig(r) ? '' : 'AND alleen_eigenaar = 0 ') + 'ORDER BY aangemaakt_op DESC LIMIT 1').get(x.tegenpartij || '', x.omschrijving || '', x.transactietype || '');
  return u ? u.categorie : null;
}
// facturen (app en FV2-archief) op het IBAN van de tegenpartij
function facturenEerder(fdb, iban) {
  if (!iban) return 0;
  return Number(fdb.db.prepare("SELECT (SELECT count(*) FROM factuur WHERE iban = ?1 AND status <> 'geen_factuur') + (SELECT count(*) FROM factuur_archief WHERE iban = ?1) AS n").get(iban).n);
}
const fraudeOpen = (fdb, txId) => !!fdb.db.prepare("SELECT 1 FROM signaal s WHERE s.status = 'open' AND s.soort = 'onbekend_iban' AND EXISTS (SELECT 1 FROM json_each(s.transacties) j WHERE j.value = ?)").get(txId);
function bankOranje(fdb, r, week, nu) {
  const [ff, fp] = factuurFilter(r, 'f');
  const open = fdb.db.prepare('SELECT f.* FROM factuur f WHERE f.entiteit = ? AND ' + OPEN_FACTUUR_SQL + ' AND ' + ff + ' ORDER BY f.factuurdatum DESC LIMIT 300');
  const netto = fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j');
  const levNaam = fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?');
  const vOpen = fdb.db.prepare("SELECT 1 FROM voorstel WHERE transactie = ? AND status = 'open'");
  const perEnt = new Map();
  const openVan = (ent) => {
    if (!perEnt.has(ent)) perEnt.set(ent, open.all(ent, ...fp).filter((f) => netto.get(f.id).j !== 1));
    return perEnt.get(ent);
  };
  const groepen = new Map();
  for (const t of oranjeTx(fdb, r, nu)) {
    if (isoWeek(t.boekdatum) !== week) continue;
    const p = B.oranjePatroon(t), sl = p ? p.sleutel : 'los:' + t.id;
    let g = groepen.get(sl);
    if (!g) {
      const eerder = eerdereKeuze(fdb, r, p);
      g = { sleutel: sl, soort: p ? p.soort : 'los', naam: p ? p.naam : (t.tegenpartij_naam || kort(t.omschrijving, 60) || 'Onbekende tegenpartij'), regel_kan: !!p && isEig(r),
        geen_regel: !p ? 'Bij deze afschrijving is geen rekeningnummer of vaste omschrijving om een regel op te maken.' : !isEig(r) ? 'Een regel maakt alleen David.' : null,
        facturen_eerder: p && p.patroon.tegenpartij ? facturenEerder(fdb, p.patroon.tegenpartij) : 0,
        voorstel: B.categorieVoorstel(t, p, eerder), aantal: 0, totaal_centen: 0, entiteiten: [], transacties: [] };
      groepen.set(sl, g);
    }
    const kand = openVan(t.entiteit).map((f) => ({ f, iban: !!t.tegenpartij_iban && K.ibanNorm(f.iban) === K.ibanNorm(t.tegenpartij_iban), d: Math.abs(f.incl + t.bedrag_centen) }))
      .sort((a, b) => (a.iban !== b.iban ? (a.iban ? -1 : 1) : a.d - b.d)).slice(0, ORANJE_KANDIDATEN)
      .map((k) => { const l = k.f.leverancier ? levNaam.get(k.f.leverancier) : null; return Object.assign(factuurKort(k.f, l ? l.naam : null), { zelfde_iban: k.iban, verschil_centen: k.d }); });
    const fraude = fraudeOpen(fdb, t.id);
    if (fraude && g.regel_kan) { g.regel_kan = false; g.geen_regel = 'Er staat een fraudesignaal open (betaald aan een rekeningnummer dat niet bij de leverancier hoort); zoek dat eerst uit bij Signalen.'; }
    g.aantal++; g.totaal_centen += t.bedrag_centen;
    if (!g.entiteiten.includes(t.entiteit)) g.entiteiten.push(t.entiteit);
    g.transacties.push(Object.assign(txKort(t), { kandidaten: kand, voorstel_open: !!vOpen.get(t.id), fraude }));
  }
  const lijst = [...groepen.values()].sort((a, b) => b.aantal - a.aantal || a.totaal_centen - b.totaal_centen);
  return { week, aantal: lijst.reduce((s, g) => s + g.aantal, 0), afgekapt: lijst.length > ORANJE_GROEPEN_MAX, groepen: lijst.slice(0, ORANJE_GROEPEN_MAX) };
}
// Davids keuze op een groep wordt een regel: { keuze: 'uitzondering', transacties, categorie [, toch] } maakt per eigen rekening één uitzondering
// op het patroon van die tegenpartij (de pod leidt het patroon zelf af, nooit uit de vraag), zet elke nog te bekijken afschrijving op die rekening
// die erop past meteen op die categorie (de volgende bankcontrole doet hetzelfde, ook over de historie van 400 dagen), sluit hun open signaal
// "afschrijving zonder factuur" en hun open koppelvoorstel. { keuze: 'ongedaan', regels } zet zo'n regel uit en de afschrijvingen terug.
// { keuze: 'factuur', transactie, factuur [, volledig] } koppelt (koppelIntern) en sluit dat signaal. Alles of niets in één transactie.
const ORANJE_KEUZE_MAX = 100;
function bankKeuze(fdb, r, d, nu) {
  const keuze = d.keuze;
  if (keuze === 'factuur') {
    const txId = vraagId(d, 'transactie'), fId = vraagId(d, 'factuur');
    return D.transactie(fdb, function () {
      const t = fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ? AND verwijderd_op IS NULL').get(txId);
      if (!magTransactie(r, t)) weiger(404, 'bankregel niet gevonden');
      if (!(t.bedrag_centen < 0)) weiger(400, 'alleen een afschrijving');
      if (t.categorie) weiger(409, 'deze afschrijving staat al als uitzondering; ververs de lijst');
      // review wv2061 MOET 3: niet naast een koppeling die intussen ontstond, en alleen een factuur die nog open is
      if (fdb.db.prepare('SELECT 1 FROM koppeling WHERE transactie = ?').get(t.id)) weiger(409, 'deze afschrijving is intussen al gekoppeld; ververs de lijst');
      const [ff, fp] = factuurFilter(r, 'f');
      const f = fdb.db.prepare('SELECT f.id, f.nummer FROM factuur f WHERE f.id = ? AND ' + OPEN_FACTUUR_SQL + ' AND ' + ff).get(fId, ...fp);
      if (!f) weiger(409, 'die factuur staat niet meer open; ververs de lijst');
      if (fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j').get(f.id).j === 1) weiger(409, 'die factuur is intussen al betaald gezien; ververs de lijst');
      const k = koppelIntern(fdb, r, txId, fId, d.volledig !== false, nu);
      const les = 'Afschrijving aan ' + String(t.tegenpartij_naam || 'de tegenpartij').slice(0, 80) + ' hoort bij factuur ' + String(f.nummer || '').slice(0, 40) + '; met de hand gekoppeld.';
      const dicht = oranjeSignalenDicht(fdb, r, [t.id], 'factuur_gekoppeld', les, nuIso(nu));
      return Object.assign({ les, signalen_dicht: dicht }, k);
    });
  }
  if (keuze === 'ongedaan') return oranjeOngedaan(fdb, r, d, nu);
  if (keuze !== 'uitzondering') weiger(400, 'keuze is uitzondering, ongedaan of factuur');
  eisEigenaar(r);
  if (!B.CATEGORIEEN.includes(d.categorie)) weiger(400, 'onbekende categorie');
  const ids = Array.isArray(d.transacties) ? [...new Set(d.transacties.map(String))] : [];
  if (!ids.length || ids.length > ORANJE_KEUZE_MAX || !ids.every((x) => ID_RE.test(x))) weiger(400, 'transacties: 1 tot ' + ORANJE_KEUZE_MAX + ' id\'s');
  return D.transactie(fdb, function () {
    const wanneer = nuIso(nu), vandaag = dagAmsterdam(nu);
    const tx = ids.map((id) => fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ? AND verwijderd_op IS NULL').get(id));
    if (!tx.every((t) => magTransactie(r, t))) weiger(404, 'bankregel niet gevonden');
    const gekoppeld = fdb.db.prepare('SELECT 1 FROM koppeling WHERE transactie = ?');
    if (tx.some((t) => !(t.bedrag_centen < 0) || t.categorie || gekoppeld.get(t.id))) weiger(409, 'een van deze afschrijvingen is intussen al bekeken; ververs de lijst');
    const p = B.oranjePatroon(tx[0]);
    if (!p) weiger(409, 'bij deze afschrijving staat geen rekeningnummer of vaste omschrijving om een regel op te maken; kies een factuur of upload hem');
    if (tx.some((t) => { const q = B.oranjePatroon(t); return !q || q.sleutel !== p.sleutel; })) weiger(400, 'deze afschrijvingen horen niet bij dezelfde tegenpartij');
    if (tx.some((t) => fraudeOpen(fdb, t.id))) weiger(409, 'er staat een fraudesignaal open bij deze afschrijving; zoek dat eerst uit');
    const eerder = p.patroon.tegenpartij ? facturenEerder(fdb, p.patroon.tegenpartij) : 0;
    if (eerder && d.toch !== true) weiger(409, 'van deze rekening kwamen eerder facturen binnen; kies de factuur, of kies uitdrukkelijk "toch een uitzondering"');
    const perRek = new Map();
    for (const t of tx) perRek.set(t.eigen_iban, (perRek.get(t.eigen_iban) || false) || !!t.alleen_eigenaar);
    const regels = [];
    let gezet = 0;
    const kandidaten = fdb.db.prepare('SELECT t.* FROM bank_transactie t WHERE t.eigen_iban = ? AND t.verwijderd_op IS NULL AND t.categorie IS NULL AND t.bedrag_centen < 0 AND t.boekdatum >= ? ' +
      'AND NOT EXISTS (SELECT 1 FROM koppeling k WHERE k.transactie = t.id)');
    const zet = fdb.db.prepare('UPDATE bank_transactie SET categorie = ?, uitzondering = ? WHERE id = ? AND categorie IS NULL');
    const geraakt = new Set();
    for (const [rek, alleenEig] of perRek) {
      const id = D.nieuwId();
      const u = { id, richting: 'af', rekening: rek, tegenpartij: p.patroon.tegenpartij || null, omschrijving: p.patroon.omschrijving || null,
        transactietype: p.patroon.transactietype || null, bedrag_centen: p.patroon.bedrag_centen === undefined ? null : p.patroon.bedrag_centen,
        tolerantie_centen: p.patroon.tolerantie_centen === undefined ? null : p.patroon.tolerantie_centen, categorie: d.categorie, toelichting: ORANJE_REGEL_TEKST,
        alleen_eigenaar: alleenEig ? 1 : 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer };
      D.voegToe(fdb, 'uitzondering', u);
      for (const t of kandidaten.all(rek, K.plusDagen(vandaag, -BANK_DAGEN))) if (B.uitzonderingPast(u, t) && !fraudeOpen(fdb, t.id)) { gezet += zet.run(d.categorie, id, t.id).changes; geraakt.add(t.id); }
      D.audit(fdb, { wie: r.wie, wat: 'uitzondering_maken', object_soort: 'uitzondering', object_id: id, entiteit: tx.find((t) => t.eigen_iban === rek).entiteit,
        na: { categorie: d.categorie, bron: 'bankcontrole_te_bekijken', soort: p.soort, toch: eerder ? true : undefined }, wanneer });
      regels.push(id);
    }
    // review wv2061 KAN 13: een regel die niet eens op de gekozen afschrijvingen past, is fout → alles terug
    if (tx.some((t) => !geraakt.has(t.id))) weiger(409, 'de regel past niet op deze afschrijvingen; er is niets vastgelegd');
    // review wv2061 ZOU 9: open koppelvoorstellen van deze afschrijvingen dicht (anders kreeg een afschrijving straks categorie én koppeling)
    const vDicht = fdb.db.prepare("UPDATE voorstel SET status = 'afgewezen', afgehandeld_door = ?, afgehandeld_op = ? WHERE status = 'open' AND transactie = ?");
    let voorstellen = 0;
    for (const id of geraakt) voorstellen += vDicht.run(r.wie, wanneer, id).changes;
    const les = B.SIGNALEN.geen_factuur.knoppen.is_uitzondering.les({ naam: p.naam }, { categorie: d.categorie });
    const dicht = oranjeSignalenDicht(fdb, r, [...geraakt], 'is_uitzondering', les, wanneer);
    return { les, regels: regels.length, regel_ids: regels, afschrijvingen: gezet, signalen_dicht: dicht, voorstellen_dicht: voorstellen };
  });
}
// review wv2061 ZOU 5: een regel uit "te bekijken" terugdraaien = regel uit en zijn afschrijvingen weer zonder categorie (komen terug bij te
// bekijken). Gesloten signalen en afgewezen voorstellen blijven dicht. Alleen regels die deze route maakte; alleen de eigenaar.
function oranjeOngedaan(fdb, r, d, nu) {
  eisEigenaar(r);
  const ids = Array.isArray(d.regels) ? [...new Set(d.regels.map(String))] : [];
  if (!ids.length || ids.length > 20 || !ids.every((x) => ID_RE.test(x))) weiger(400, 'regels: 1 tot 20 id\'s');
  return D.transactie(fdb, function () {
    const wanneer = nuIso(nu);
    let terug = 0;
    for (const id of ids) {
      const u = fdb.db.prepare('SELECT * FROM uitzondering WHERE id = ?').get(id);
      if (!u || u.toelichting !== ORANJE_REGEL_TEKST) weiger(404, 'regel niet gevonden');
      if (!u.actief) weiger(409, 'deze regel staat al uit');
      fdb.db.prepare('UPDATE uitzondering SET actief = 0 WHERE id = ?').run(id);
      const n = fdb.db.prepare('UPDATE bank_transactie SET categorie = NULL, uitzondering = NULL WHERE uitzondering = ?').run(id).changes;
      terug += n;
      D.audit(fdb, { wie: r.wie, wat: 'uitzondering_ongedaan', object_soort: 'uitzondering', object_id: id, na: { afschrijvingen: n }, wanneer });
    }
    return { les: 'Ongedaan: de regel staat uit en ' + terug + (terug === 1 ? ' afschrijving staat' : ' afschrijvingen staan') + ' weer bij te bekijken.', afschrijvingen: terug };
  });
}
// Open signaal "afschrijving zonder factuur" van deze bankregels dicht (zoals de knop in de signalenlijst), met les en auditrij.
function oranjeSignalenDicht(fdb, r, txIds, afhandeling, les, wanneer) {
  let n = 0;
  const q = fdb.db.prepare("SELECT s.* FROM signaal s WHERE s.status = 'open' AND s.soort = 'geen_factuur' AND EXISTS (SELECT 1 FROM json_each(s.transacties) j WHERE j.value = ?)");
  const up = fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = ?, les = ?, wie = ?, wanneer = ?, sluimer_tot = NULL WHERE id = ? AND status = 'open'");
  for (const id of txIds) for (const s of q.all(id)) {
    if (!up.run(afhandeling, kort(les, 300), r.wie, wanneer, s.id).changes) continue;
    n++;
    D.audit(fdb, { wie: r.wie, wat: 'signaal_afgehandeld', object_soort: 'signaal', object_id: s.id, entiteit: s.entiteit, voor: { status: 'open' }, na: { status: 'afgehandeld', knop: afhandeling }, wanneer });
  }
  return n;
}
function isoWeek(d) {
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  const dag = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dag + 3);
  const jaar = t.getUTCFullYear(), eerste = new Date(Date.UTC(jaar, 0, 4));
  return jaar + '-W' + String(1 + Math.round(((t - eerste) / 86400000 - 3 + ((eerste.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0');
}
function uploads(fdb, r, nu) {
  const bestanden = fdb.db.prepare('SELECT id, formaat, naam, aantal, prive_weggegooid, per_rekening, geupload_door, geupload_op FROM bank_bestand ' +
    (isEig(r) ? '' : 'WHERE geupload_door = ? ') + 'ORDER BY geupload_op DESC LIMIT 30').all(...(isEig(r) ? [] : [r.wie])).map((b) => ({
    id: b.id, formaat: b.formaat, naam: b.naam, aantal: b.aantal, prive_weggegooid: b.prive_weggegooid, geupload_door: b.geupload_door, geupload_op: b.geupload_op,
    rekeningen: Object.entries(json(b.per_rekening, {}) || {}).map(([iban, n]) => ({ rekening: eind4(iban), aantal: n })) }));
  const docs = fdb.db.prepare('SELECT d.id, d.naam, d.soort, d.te_lezen, d.geupload_door, d.aangemaakt_op, f.id AS factuur, f.status, f.entiteit, f.patientkenmerk, f.alleen_eigenaar ' +
    'FROM document d LEFT JOIN factuur f ON f.document = d.id OR f.ubl_document = d.id WHERE d.geupload_door IS NOT NULL ORDER BY d.aangemaakt_op DESC LIMIT 60').all()
    .filter((d) => (d.factuur ? magFactuur(r, d) : isEig(r) || d.geupload_door === r.wie))
    .slice(0, 30).map((d) => ({ id: d.id, naam: d.naam, soort: d.soort, te_lezen: !!d.te_lezen, factuur: d.factuur, status: d.status, geupload_op: d.aangemaakt_op }));
  // wv959: met de stand van de laatste opdracht (wacht · opgehaald · gelukt · mislukt · geweigerd), zodat stap 4 laat zien waar het afschrift is
  const pot = isEig(r) ? fdb.db.prepare('SELECT a.id, a.periode, a.status, a.bijgewerkt_op, o.status AS opdracht_status, o.modus AS opdracht_modus, o.verstuur_na ' +
    'FROM pot_afschrift a LEFT JOIN opdracht o ON o.id = (SELECT id FROM opdracht WHERE afschrift = a.id ORDER BY aangemaakt_op DESC, rowid DESC LIMIT 1) ORDER BY a.periode DESC LIMIT 6').all() : undefined;
  return { bankbestanden: bestanden, stukken: docs, rekeningen: gezondheid(fdb, r, nu).rekeningen, pot };
}
function leveranciers(fdb, r) {
  const lijst = leverancierLijst(fdb).filter((l) => magLeverancier(r, l));
  return { leveranciers: lijst.sort((a, b) => a.naam.localeCompare(b.naam, 'nl')).slice(0, 2000).map((l) => ({ id: l.id, naam: l.naam, kvk: l.kvk,
    standaard_entiteit: l.standaard_entiteit, standaard_betaalwijze: l.standaard_betaalwijze, ibans: l.ibans, mediaan: l.mediaan, alleen_portaal: !!l.alleen_portaal,
    incasso_tolerantie_pct: l.incasso_tolerantie_pct })) };
}
function instellingen(fdb, r) {
  eisEigenaar(r);
  const ge = {};
  for (const x of fdb.db.prepare('SELECT gebruiker, entiteit FROM gebruiker_entiteit').all()) (ge[x.gebruiker] = ge[x.gebruiker] || []).push(x.entiteit);
  return {
    entiteiten: entiteitenRijen(fdb).map((e) => Object.assign(e, { bestemming: bestemming(e) })),
    rekeningen: fdb.db.prepare('SELECT * FROM rekening ORDER BY entiteit, iban').all(),
    gebruikers: fdb.db.prepare('SELECT id, email, naam, ingang, rol, mag_bevestigen, actief FROM gebruiker ORDER BY rol, email').all().map((g) => Object.assign(g, { entiteiten: ge[g.id] || [] })),
    uitzonderingen: fdb.db.prepare('SELECT * FROM uitzondering ORDER BY categorie, aangemaakt_op').all(),
    verzendmodus: D.metaLees(fdb, 'verzendmodus'), versturen_vrijgegeven: D.metaLees(fdb, 'versturen_vrijgegeven') === '1',
    verstuur_instelling: verstuurInstelling(fdb), drempel_centen: kernCtx(fdb, Date.now()).drempelCenten || 250000,
  };
}

// ───────────────────────────── Bevestigen, terugdraaien, nagebeld, wijzigen ─────────────────────────────

/*
 * Bevestigen in één BEGIN IMMEDIATE (bouwplan § 4.4): factuur bijwerken (entiteit, betaalwijze, status, betaalspoor, wie/wanneer),
 * leveranciersstandaard bijwerken bij een wijziging (kern leerUitBevestiging), opdracht met verstuur_na + vingerafdruk (kern maakOpdracht,
 * met de verse IBAN-poort) — Privé → privé-archief zonder opdracht. versie (optioneel) = de versie die de App toonde: is de factuur intussen
 * veranderd, dan 409 en niets gebeurt.
 */
function bevestig(fdb, r, d, nu) {
  const id = vraagId(d, 'id');
  if (r.mag_bevestigen === false) weiger(403, 'bevestigen staat voor jou uit; vraag het David');   // wv856: gebruiker.mag_bevestigen
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (d.versie !== undefined && d.versie !== f.versie) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw', { versie: f.versie });
    if (f.status !== 'te_beoordelen') weiger(409, 'status is ' + f.status);
    const entiteit = d.entiteit === undefined ? f.entiteit : d.entiteit;
    const betaalwijze = d.betaalwijze === undefined ? f.betaalwijze : d.betaalwijze;
    const e = entiteit ? fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(String(entiteit)) : null;
    if (!e) weiger(400, 'kies een entiteit');
    if (!magEntiteit(r, e.sleutel)) weiger(403, 'deze entiteit mag je niet kiezen');
    if (e.actief !== 1) weiger(409, 'entiteit staat niet actief');
    if (!['zelf', 'incasso', 'betaald'].includes(betaalwijze)) weiger(400, 'kies een betaalwijze');
    const ctx = kernCtx(fdb, nu);
    const poort = poortVoor(fdb, f, ctx);
    const nieuw = Object.assign({}, f, { entiteit: e.sleutel, betaalwijze });
    const va = K.valideer(nieuw, ctx, { leverancier: poort.leverancier });
    const ip = K.ibanPoort(nieuw, poort.leverancier, ctx);
    Object.assign(nieuw, { controles: va.controles, intern: !!va.intern, iban_nieuw: ip.iban_nieuw, ibans_onbekend: ip.onbekend });
    const ov = K.statusOvergang('te_beoordelen', 'bevestigen', Object.assign({}, nieuw, { poort }));
    if (!ov.ok) weiger(409, 'bevestigen kan niet: ' + ov.reden, { redenen: K.magBevestigen(nieuw, poort).redenen });
    if (ov.naar === 'in_wachtrij' && !Number.isSafeInteger(nieuw.incl)) weiger(409, 'vul eerst het totaalbedrag in');
    const wanneer = nuIso(nu);
    // een eerder "ingevoerd in bank" of "betaald gezien" blijft staan na terugdraaien en opnieuw bevestigen (facturen-db terugdraaien)
    let spoor = K.betaalspoorBegin(betaalwijze, nieuw);   // creditnota → betaald_vooraf (niets te betalen; wv855)
    if (f.betaalspoor === 'betaald_gezien' || (f.betaalspoor === 'ingevoerd' && betaalwijze === 'zelf' && !K.isCreditnota(nieuw))) spoor = f.betaalspoor;
    const u = fdb.db.prepare('UPDATE factuur SET entiteit = ?, betaalwijze = ?, status = ?, betaalspoor = ?, bevestigd_door = ?, bevestigd_op = ?, controles = ?, intern = ?, ' +
      'iban_nieuw = ?, ibans_onbekend = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND status = ? AND versie = ?')
      .run(e.sleutel, betaalwijze, ov.naar, spoor, r.wie, wanneer, JSON.stringify(va.controles), va.intern ? 1 : 0, ip.iban_nieuw ? 1 : 0, JSON.stringify(ip.onbekend),
        wanneer, f.id, 'te_beoordelen', f.versie);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw');
    // leren: wijzigt een mens de entiteit of betaalwijze, dan wordt dat de standaard van de leverancier
    // leren alleen als de bevestiger de leverancier mag beheren (een praktijkmanager nooit voor een Privé-leverancier; diffreview wv833 #2)
    const leer = K.leerUitBevestiging({ entiteit: f.entiteit, betaalwijze: f.betaalwijze }, { entiteit: e.sleutel, betaalwijze }, magLeverancier(r, poort.leverancier) ? poort.leverancier : null);
    for (const w of leer.wijzigingen) {
      fdb.db.prepare('UPDATE leverancier SET ' + (w.veld === 'standaard_entiteit' ? 'standaard_entiteit' : 'standaard_betaalwijze') + ' = ?, bijgewerkt_op = ? WHERE id = ?').run(w.naar, wanneer, poort.leverancier.id);
      D.audit(fdb, { wie: r.wie, wat: 'leverancier_geleerd', object_soort: 'leverancier', object_id: poort.leverancier.id, entiteit: e.sleutel, voor: { [w.veld]: w.van }, na: { [w.veld]: w.naar }, wanneer });
    }
    for (const b of leer.besluiten) besluitRij(fdb, f.id, b, r.wie, wanneer);
    let opdracht = null;
    if (ov.naar === 'in_wachtrij') {
      const bijlagen = bijlagenVan(fdb, f);
      const op = K.maakOpdracht(Object.assign({}, nieuw, { status: 'te_beoordelen' }), e, { id: D.nieuwId(), bijlagen, verstuur_na: K.verstuurNa(nu, verstuurInstelling(fdb)), poort });
      D.voegToe(fdb, 'opdracht', { id: op.id, soort: op.soort, factuur: f.id, entiteit: op.entiteit, doeladres: op.doeladres, bijlagen: op.bijlagen, vingerafdruk: op.vingerafdruk,
        verstuur_na: op.verstuur_na, idempotentiesleutel: op.idempotentiesleutel, status: 'wacht', poging: 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer, bijgewerkt_op: wanneer });
      opdracht = { id: op.id, verstuur_na: op.verstuur_na };
    }
    besluitRij(fdb, f.id, K.besluit('bevestigen', 'status', ov.naar, 'mens', (f.entiteit !== e.sleutel ? 'entiteit ' + (f.entiteit || '—') + ' → ' + e.sleutel + '; ' : '') +
      (f.betaalwijze !== betaalwijze ? 'betaalwijze ' + f.betaalwijze + ' → ' + betaalwijze : 'voorstel overgenomen')), r.wie, wanneer);
    D.audit(fdb, { wie: r.wie, wat: 'bevestigen', object_soort: 'factuur', object_id: f.id, entiteit: e.sleutel,
      voor: { status: f.status, entiteit: f.entiteit, betaalwijze: f.betaalwijze }, na: { status: ov.naar, entiteit: e.sleutel, betaalwijze, betaalspoor: spoor, opdracht: opdracht && opdracht.id }, wanneer });
    return { status: ov.naar, betaalspoor: spoor, opdracht, melding: leer.melding };
  });
}
function bijlagenVan(fdb, f) {
  const docs = [f.document_id, f.ubl_document_id].filter(Boolean).map((id) => fdb.db.prepare('SELECT naam, mime, sha256 FROM document WHERE id = ?').get(id));
  return docs.map((x) => ({ naam: x.naam || 'factuur', mime: x.mime || null, sha256: x.sha256 }));
}
function terugdraaien(fdb, r, d, nu) {
  const id = vraagId(d, 'id');
  const f = factuurOf404(fdb, r, id);
  if (f.status === 'prive_archief') eisEigenaar(r);
  if (['wordt_verstuurd', 'concept_klaar', 'verstuurd'].includes(f.status)) weiger(409, 'de koerier heeft de opdracht al opgehaald; terugdraaien kan niet meer', { code: 'al_opgehaald' });
  const u = D.terugdraaien(fdb, id, { wie: r.wie, wanneer: nuIso(nu) });
  if (!u.ok) weiger(409, u.fout === 'al_opgehaald' ? u.reden : 'terugdraaien kan niet: ' + (u.reden || u.fout), { code: u.fout });
  return { status: 'te_beoordelen', opdracht: u.opdracht };
}
// Nagebeld: verse vingerafdruk (bouwplan § 3), één vingerafdruk = één handeling; het IBAN gaat naar leverancier_iban (kern nagebeld).
function nagebeld(fdb, r, d, nu, o) {
  const id = vraagId(d, 'id');
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (f.status !== 'te_beoordelen') weiger(409, 'status is ' + f.status);
    const ctx = kernCtx(fdb, nu);
    const poort = poortVoor(fdb, f, ctx);
    const ip = K.ibanPoort(f, poort.leverancier, ctx);
    if (!ip.iban_nieuw) weiger(409, 'deze factuur heeft geen nieuw IBAN');
    // wv856: de fraudepoort vraagt een verse vingerafdruk; de smalle ingang heeft die niet, dus nabellen bevestigt David in zijn app
    if (r.ingang === 'fac') weiger(403, 'een nieuw rekeningnummer zet David na het nabellen vrij, in zijn eigen app', { alleen_david: true });
    if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
    o.versVerbruik();
    const wanneer = nuIso(nu);
    const n = K.nagebeld(Object.assign({}, f, { iban_nieuw: true, ibans_onbekend: ip.onbekend }), r.wie, wanneer);
    const u = fdb.db.prepare('UPDATE factuur SET iban_nieuw = 1, ibans_onbekend = ?, nagebeld_door = ?, nagebeld_op = ?, nagebeld_ibans = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND versie = ?')
      .run(JSON.stringify(ip.onbekend), n.factuur.nagebeld_door, n.factuur.nagebeld_op, JSON.stringify(n.factuur.nagebeld_ibans), wanneer, f.id, f.versie);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw');
    let bekend = 0;
    // bekend maken bij de leverancier alleen als de beller die leverancier mag beheren (natoets wv833: praktijkmanager en Privé-leverancier)
    if (poort.leverancier && magLeverancier(r, poort.leverancier)) for (const li of n.leverancier_iban) {
      bekend += fdb.db.prepare('INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(poort.leverancier.id, li.iban, li.toegevoegd_door, li.toegevoegd_op).changes;
    }
    besluitRij(fdb, f.id, n.besluit, r.wie, wanneer);
    D.audit(fdb, { wie: r.wie, wat: 'nagebeld', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit,
      na: { ibans: n.factuur.nagebeld_ibans.map(eind4), leverancier: poort.leverancier ? poort.leverancier.id : null, bekend_gemaakt: bekend }, wanneer });
    const na = D.factuurVoorKern(fdb, f.id);
    return { nagebeld: true, leverancier_bekend: bekend, bevestigen: K.magBevestigen(na, poortVoor(fdb, na, ctx)) };
  });
}
// Velden wijzigen in Beoordelen (alleen te_beoordelen). Na elke wijziging opnieuw valideren en de IBAN-poort opnieuw uitrekenen (kern).
const WIJZIG = {
  entiteit: (v, fdb, r) => { if (v === null) return null; const e = fdb.db.prepare('SELECT sleutel FROM entiteit WHERE sleutel = ?').get(String(v)); if (!e) weiger(400, 'onbekende entiteit'); if (!magEntiteit(r, e.sleutel)) weiger(403, 'deze entiteit mag je niet kiezen'); return e.sleutel; },
  betaalwijze: (v) => { if (!['zelf', 'incasso', 'betaald', 'onbekend'].includes(v)) weiger(400, 'onbekende betaalwijze'); return v; },
  iban: (v) => { if (v === null || v === '') return null; const i = K.ibanNorm(v); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(i)) weiger(400, 'IBAN heeft niet de goede vorm'); return i; },
  nummer: (v) => (v === null || v === '' ? null : kort(String(v).trim(), 100)),
  kenmerk: (v) => (v === null || v === '' ? null : kort(String(v).trim(), 100)),
  factuurdatum: (v) => { if (v === null) return null; if (!K.isIsoDatum(v)) weiger(400, 'datum als JJJJ-MM-DD'); return v; },
  vervaldatum: (v) => { if (v === null) return null; if (!K.isIsoDatum(v)) weiger(400, 'datum als JJJJ-MM-DD'); return v; },
  excl: (v) => { if (v === null) return null; if (int(v) === null) weiger(400, 'bedrag in centen (geheel getal)'); return v; },
  btw: (v) => { if (v === null) return null; if (int(v) === null) weiger(400, 'bedrag in centen (geheel getal)'); return v; },
  incl: (v) => { if (v === null) return null; if (int(v) === null) weiger(400, 'bedrag in centen (geheel getal)'); return v; },
  soort: (v) => { if (!['factuur', 'creditnota'].includes(v)) weiger(400, 'soort is factuur of creditnota'); return v; },
  leverancier: (v, fdb, r) => {
    if (v === null) return null;
    const l = ID_RE.test(String(v)) ? fdb.db.prepare('SELECT id, standaard_entiteit FROM leverancier WHERE id = ?').get(v) : null;
    if (!l || !magLeverancier(r, l)) weiger(400, 'onbekende leverancier');
    return v;
  },
};
function wijzig(fdb, r, d, nu) {
  const id = vraagId(d, 'id');
  const velden = d.velden;
  if (!velden || typeof velden !== 'object' || Array.isArray(velden) || !Object.keys(velden).length) weiger(400, 'velden ontbreken');
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (d.versie !== undefined && d.versie !== f.versie) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw', { versie: f.versie });
    if (f.status !== 'te_beoordelen') weiger(409, 'alleen in Beoordelen te wijzigen (status ' + f.status + ')');
    const nieuw = Object.assign({}, f), voor = {}, na = {};
    const wanneer0 = nuIso(nu);
    // wv1917: de leveranciersnaam met de hand. De eigenaar koppelt zo een leverancier (bestaand op naam, anders nieuw); een praktijkmanager
    // zet alleen de naam op de factuur. Een nieuw IBAN blijft nabellen, tenzij precies dat IBAN op deze factuur al nagebeld is.
    let levNieuw = null;
    if (Object.hasOwn(velden, 'leverancier_naam')) {
      const naam = String(velden.leverancier_naam == null ? '' : velden.leverancier_naam).replace(/\s+/g, ' ').trim();
      if (naam.length < 2 || naam.length > 200) weiger(400, 'leveranciersnaam: 2 tot 200 tekens');
      if (Object.hasOwn(velden, 'leverancier')) weiger(400, 'leverancier en leveranciersnaam niet tegelijk');
      if (naam !== (f.leverancier_naam || '')) { voor.leverancier_naam = f.leverancier_naam || null; na.leverancier_naam = naam; nieuw.leverancier_naam = naam; }
      if (isEig(r)) {
        levNieuw = leverancierOpNaam(fdb, naam, r, wanneer0);
        if (levNieuw.id !== f.leverancier_id) { voor.leverancier = f.leverancier_id; na.leverancier = levNieuw.id; nieuw.leverancier_id = levNieuw.id; nieuw.leverancier_naam = levNieuw.naam; }
      }
    }
    for (const k of Object.keys(velden)) {
      if (k === 'leverancier_naam') continue;
      if (!WIJZIG[k]) weiger(400, 'veld ' + kort(k, 30) + ' is niet te wijzigen');
      const v = WIJZIG[k](velden[k], fdb, r);
      const huidig = k === 'leverancier' ? f.leverancier_id : f[k];
      if (v === huidig) continue;
      voor[k] = huidig; na[k] = v;
      if (k === 'leverancier') nieuw.leverancier_id = v; else nieuw[k] = v;
    }
    if (!Object.keys(na).length) return { gewijzigd: false };
    const ctx = kernCtx(fdb, nu);
    // wv1917: was het IBAN van deze factuur al nagebeld toen hij nog geen leverancier had, dan wordt het bekend bij de leverancier die nu met
    // die naam NIEUW ontstaat (zoals Nagebeld had gedaan als de leverancier bekend was). Nooit bij een bestaande leverancier en nooit bij een
    // wissel van leverancier (diffreview MOET 1): daar loopt een nieuw IBAN gewoon weer langs "Nagebeld" met de vingerafdruk.
    let bekend = [];
    if (levNieuw && levNieuw.nieuw && na.leverancier && !f.leverancier_id && f.nagebeld_op && f.nagebeld_door) {
      for (const iban of (Array.isArray(f.nagebeld_ibans) ? f.nagebeld_ibans : json(f.nagebeld_ibans, []) || [])) {
        if (fdb.db.prepare('INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
          .run(levNieuw.id, iban, f.nagebeld_door, f.nagebeld_op).changes) bekend.push(iban);
      }
      if (bekend.length) D.audit(fdb, { wie: r.wie, wat: 'nagebeld_meegenomen', object_soort: 'leverancier', object_id: levNieuw.id, entiteit: f.entiteit,
        na: { factuur: f.id, ibans: bekend.map(eind4), nagebeld_door: f.nagebeld_door }, wanneer: wanneer0 });
    }
    const lev = leverancierKern(fdb, nieuw.leverancier_id);
    const va = K.valideer(nieuw, ctx, { leverancier: lev });
    const ip = K.ibanPoort(nieuw, lev, ctx);
    const wanneer = nuIso(nu);
    const u = fdb.db.prepare('UPDATE factuur SET entiteit = ?, betaalwijze = ?, iban = ?, nummer = ?, kenmerk = ?, factuurdatum = ?, vervaldatum = ?, excl = ?, btw = ?, incl = ?, ' +
      'soort = ?, leverancier = ?, leverancier_naam = ?, controles = ?, intern = ?, iban_nieuw = ?, ibans_onbekend = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND versie = ? AND status = ?')
      .run(nieuw.entiteit || null, nieuw.betaalwijze, nieuw.iban || null, nieuw.nummer || null, nieuw.kenmerk || null, nieuw.factuurdatum || null, nieuw.vervaldatum || null,
        nieuw.excl, nieuw.btw, nieuw.incl, nieuw.soort, nieuw.leverancier_id || null, kort(nieuw.leverancier_naam, 200) || null, JSON.stringify(va.controles), va.intern ? 1 : 0, ip.iban_nieuw ? 1 : 0,
        JSON.stringify(ip.onbekend), wanneer, f.id, f.versie, 'te_beoordelen');
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw');
    for (const k of Object.keys(na)) besluitRij(fdb, f.id, K.besluit('wijzigen', k, na[k] == null ? null : (k === 'iban' ? eind4(na[k]) : na[k]), 'mens', 'met de hand gewijzigd'), r.wie, wanneer);
    // alleen de namen van de velden: bedrag, nummer of kenmerk uit een stuk horen niet in de audit (de waarden staan in de besluitrijen; diffreview wv833 #1)
    D.audit(fdb, { wie: r.wie, wat: 'factuur_wijzigen', object_soort: 'factuur', object_id: f.id, entiteit: nieuw.entiteit || f.entiteit,
      na: { velden: Object.keys(na) }, wanneer });
    const nu2 = D.factuurVoorKern(fdb, f.id);
    return { gewijzigd: true, iban_poort: { iban_nieuw: ip.iban_nieuw, reden: ip.reden }, bevestigen: K.magBevestigen(nu2, { leverancier: lev, ctx }), versie: nu2.versie,
      leverancier_bekend: bekend.length };
  });
}

// ───────────────────────────── wv1917: leverancier op naam, regels per afzender ─────────────────────────────

// Bestaande leverancier met dezelfde genormaliseerde naam (de oudste), anders een nieuwe. Alleen de eigenaar (wijzig controleert dat).
function leverancierOpNaam(fdb, naam, r, wanneer) {
  const norm = K.normNaam(naam);
  if (!norm) weiger(400, 'leveranciersnaam zonder letters of cijfers');
  const b = fdb.db.prepare('SELECT id, naam FROM leverancier WHERE genormaliseerd = ? ORDER BY aangemaakt_op, id LIMIT 1').get(norm);
  if (b) return { id: b.id, naam: b.naam, nieuw: false };
  const id = D.nieuwId();
  D.voegToe(fdb, 'leverancier', { id, naam, genormaliseerd: norm, aangemaakt_op: wanneer });
  D.audit(fdb, { wie: r.wie, wat: 'leverancier_nieuw', object_soort: 'leverancier', object_id: id, na: { naam }, wanneer });
  return { id, naam, nieuw: true };
}
function afzenderRegels(fdb) {
  return fdb.db.prepare('SELECT soort, patroon, leverancier AS leverancier_id, entiteit, betaalwijze FROM afzender_regel').all();
}
// Algemene mailaanbieders: daar is een domeinregel nooit goed (iedereen mailt vanaf gmail.com); een regel op het precieze adres mag wel.
const ALGEMEEN_DOMEIN = /^(?:gmail\.com|googlemail\.com|hotmail\.[a-z.]+|outlook\.[a-z.]+|live\.[a-z.]+|msn\.com|icloud\.com|me\.com|mac\.com|yahoo\.[a-z.]+|ziggo\.nl|kpnmail\.nl|kpnplanet\.nl|planet\.nl|xs4all\.nl|home\.nl|hetnet\.nl|chello\.nl|caiway\.nl|proton\.me|protonmail\.com|gmx\.[a-z.]+)$/;
function afzenderVan(fdb, f) {
  const b = f.bericht;
  const rij = b ? fdb.db.prepare('SELECT afzender FROM bericht WHERE id = ?').get(b) : null;
  const adres = rij ? K.adresVanAfzender(rij.afzender) : null;
  if (!adres) return null;
  const domein = adres.slice(adres.indexOf('@') + 1);
  const regel = K.regelVoorAfzender({ afzender: adres }, { afzenderRegels: fdb.db.prepare('SELECT id, soort, patroon, leverancier AS leverancier_id, entiteit, betaalwijze FROM afzender_regel').all() });
  return { adres, domein, domein_mag: !ALGEMEEN_DOMEIN.test(domein), regel: regel ? { id: regel.id, soort: regel.soort, patroon: regel.patroon, entiteit: regel.entiteit, betaalwijze: regel.betaalwijze } : null };
}
function regelsLijst(fdb, r) {
  eisEigenaar(r);
  return { regels: fdb.db.prepare('SELECT a.id, a.soort, a.patroon, a.leverancier, l.naam AS leverancier_naam, a.entiteit, a.betaalwijze, a.aangemaakt_door, a.aangemaakt_op ' +
    'FROM afzender_regel a JOIN leverancier l ON l.id = a.leverancier ORDER BY a.patroon').all() };
}
// "Onthoud voor deze afzender": afzender van de factuur (adres of heel het domein) → leverancier van de factuur + entiteit + betaalwijze.
// Een bestaande regel op hetzelfde patroon wordt bijgewerkt. Alleen de eigenaar; de leverancier moet op de factuur staan (eerst de naam).
function regelRoute(fdb, r, d, nu) {
  eisEigenaar(r);
  const id = vraagId(d, 'factuur');
  if (!['adres', 'domein'].includes(d.soort)) weiger(400, 'kies adres of domein');
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (!f.leverancier_id) weiger(409, 'vul eerst de leveranciersnaam in (Velden verbeteren)');
    const af = afzenderVan(fdb, f);
    if (!af) weiger(409, 'deze factuur kwam niet per mail binnen: er is geen afzender om te onthouden');
    if (d.soort === 'domein' && !af.domein_mag) weiger(400, af.domein + ' is een algemene mailaanbieder; onthoud alleen dit adres');
    const entiteit = d.entiteit == null || d.entiteit === '' ? null : String(d.entiteit);
    if (entiteit) { const e = fdb.db.prepare('SELECT sleutel, actief FROM entiteit WHERE sleutel = ?').get(entiteit); if (!e) weiger(400, 'onbekende entiteit'); if (e.actief !== 1) weiger(409, 'entiteit staat niet actief'); }
    const betaalwijze = d.betaalwijze == null || d.betaalwijze === '' ? null : d.betaalwijze;
    if (betaalwijze !== null && !['zelf', 'incasso', 'betaald'].includes(betaalwijze)) weiger(400, 'onbekende betaalwijze');
    const patroon = d.soort === 'adres' ? af.adres : af.domein;
    const wanneer = nuIso(nu);
    const oud = fdb.db.prepare('SELECT * FROM afzender_regel WHERE patroon = ?').get(patroon);
    if (oud) fdb.db.prepare('UPDATE afzender_regel SET soort = ?, leverancier = ?, entiteit = ?, betaalwijze = ?, aangemaakt_door = ?, aangemaakt_op = ? WHERE id = ?')
      .run(d.soort, f.leverancier_id, entiteit, betaalwijze, r.wie, wanneer, oud.id);
    else fdb.db.prepare('INSERT INTO afzender_regel (soort, patroon, leverancier, entiteit, betaalwijze, aangemaakt_door, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.soort, patroon, f.leverancier_id, entiteit, betaalwijze, r.wie, wanneer);
    const rij = fdb.db.prepare('SELECT id FROM afzender_regel WHERE patroon = ?').get(patroon);
    D.audit(fdb, { wie: r.wie, wat: oud ? 'regel_bijwerken' : 'regel_nieuw', object_soort: 'afzender_regel', object_id: String(rij.id), entiteit,
      voor: oud ? { leverancier: oud.leverancier, entiteit: oud.entiteit, betaalwijze: oud.betaalwijze } : null,
      na: { soort: d.soort, patroon, leverancier: f.leverancier_id, entiteit, betaalwijze, factuur: f.id }, wanneer });
    besluitRij(fdb, f.id, K.besluit('regel', 'afzender', patroon, 'mens', 'onthouden voor volgende stukken: ' + [entiteit, betaalwijze].filter(Boolean).join(', ')), r.wie, wanneer);
    return { regel: { id: rij.id, soort: d.soort, patroon, entiteit, betaalwijze }, bijgewerkt: !!oud };
  });
}
function regelWeg(fdb, r, d, nu) {
  eisEigenaar(r);
  const id = Number(d.id);
  if (!Number.isSafeInteger(id) || id < 1) weiger(400, 'id ontbreekt');
  return D.transactie(fdb, function () {
    const oud = fdb.db.prepare('SELECT * FROM afzender_regel WHERE id = ?').get(id);
    if (!oud) weiger(404, 'regel niet gevonden');
    fdb.db.prepare('DELETE FROM afzender_regel WHERE id = ?').run(id);
    D.audit(fdb, { wie: r.wie, wat: 'regel_weg', object_soort: 'afzender_regel', object_id: String(id), entiteit: oud.entiteit,
      voor: { soort: oud.soort, patroon: oud.patroon, leverancier: oud.leverancier, entiteit: oud.entiteit, betaalwijze: oud.betaalwijze }, wanneer: nuIso(nu) });
    return { weg: id };
  });
}

/*
 * wv2006 (David 29-10-2026 22:47: "Ik mail álle facturen in Gmail naar het juiste inkoopadres, en mail degenen die voor betaling door moeten
 * naar 'nogbetalen@…'"): voorstellen voor regels per afzender, afgeleid door de machinekamer uit Davids eigen doorsturingen (12 maanden).
 * Ze staan als JSON in meta 'afzender_voorstellen' { gemeten, venster, items: [{ patroon, soort, naam, aantal, entiteit, entiteiten,
 * nogbetalen, betaalwijze, voorbeeld, laatst, status }] } en doen NIETS met de stroom tot David er een bevestigt: pas dan wordt het een
 * gewone afzender_regel (leverancier op naam, zoals Velden verbeteren). Afwijzen = status afgewezen, geen regel. Alleen de eigenaar.
 */
const VOORSTEL_SLEUTEL = 'afzender_voorstellen';
function voorstellenLees(fdb) {
  let v = null;
  try { v = JSON.parse(D.metaLees(fdb, VOORSTEL_SLEUTEL) || 'null'); } catch (e) { v = null; }
  return v && Array.isArray(v.items) ? v : { gemeten: null, venster: null, items: [] };
}
function afzenderVoorstellen(fdb, r) {
  eisEigenaar(r);
  const v = voorstellenLees(fdb);
  const bestaand = new Map(fdb.db.prepare('SELECT a.patroon, a.entiteit, a.betaalwijze, l.naam AS leverancier_naam FROM afzender_regel a JOIN leverancier l ON l.id = a.leverancier').all()
    .map((x) => [x.patroon, x]));
  return { gemeten: v.gemeten || null, venster: v.venster || null,
    voorstellen: v.items.map((x) => Object.assign({}, x, { regel: bestaand.get(x.patroon) || null })) };
}
function afzenderVoorstel(fdb, r, d, nu) {
  eisEigenaar(r);
  const patroon = String(d.patroon || '').toLowerCase();
  if (!['bevestig', 'afwijs', 'terug'].includes(d.keuze)) weiger(400, 'kies bevestig, afwijs of terug');
  return D.transactie(fdb, function () {
    const v = voorstellenLees(fdb);
    const x = v.items.find((i) => i.patroon === patroon);
    if (!x) weiger(404, 'voorstel niet gevonden');
    const wanneer = nuIso(nu);
    if (d.keuze === 'terug') {
      if (x.status !== 'afgewezen') weiger(409, 'alleen een afgewezen voorstel kan terug');
      x.status = 'voorstel'; x.besloten_door = null; x.besloten_op = null;
    } else if (d.keuze === 'afwijs') {
      if (x.status !== 'voorstel') weiger(409, 'dit voorstel is al ' + x.status);
      x.status = 'afgewezen'; x.besloten_door = r.wie; x.besloten_op = wanneer;
    } else {
      if (x.status !== 'voorstel') weiger(409, 'dit voorstel is al ' + x.status);
      if (!['adres', 'domein'].includes(x.soort)) weiger(409, 'voorstel zonder soort');
      if (x.soort === 'domein' && ALGEMEEN_DOMEIN.test(patroon)) weiger(400, patroon + ' is een algemene mailaanbieder; alleen een adres kan');
      // David kan entiteit en betaalwijze op de kaart nog aanpassen; leeg = geen
      const entiteit = d.entiteit !== undefined ? (d.entiteit == null || d.entiteit === '' ? null : String(d.entiteit)) : (x.entiteit || null);
      if (entiteit) { const e = fdb.db.prepare('SELECT actief FROM entiteit WHERE sleutel = ?').get(entiteit); if (!e) weiger(400, 'onbekende entiteit'); if (e.actief !== 1) weiger(409, 'entiteit staat niet actief'); }
      const betaalwijze = d.betaalwijze !== undefined ? (d.betaalwijze == null || d.betaalwijze === '' ? null : d.betaalwijze) : (x.betaalwijze || null);
      if (betaalwijze !== null && !['zelf', 'incasso', 'betaald'].includes(betaalwijze)) weiger(400, 'onbekende betaalwijze');
      const naam = kort(String(d.naam || x.naam || patroon), 200).trim();
      const lev = leverancierOpNaam(fdb, naam, r, wanneer);
      const oud = fdb.db.prepare('SELECT * FROM afzender_regel WHERE patroon = ?').get(patroon);
      if (oud) fdb.db.prepare('UPDATE afzender_regel SET soort = ?, leverancier = ?, entiteit = ?, betaalwijze = ?, aangemaakt_door = ?, aangemaakt_op = ? WHERE id = ?')
        .run(x.soort, lev.id, entiteit, betaalwijze, r.wie, wanneer, oud.id);
      else fdb.db.prepare('INSERT INTO afzender_regel (soort, patroon, leverancier, entiteit, betaalwijze, aangemaakt_door, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(x.soort, patroon, lev.id, entiteit, betaalwijze, r.wie, wanneer);
      const rij = fdb.db.prepare('SELECT id FROM afzender_regel WHERE patroon = ?').get(patroon);
      D.audit(fdb, { wie: r.wie, wat: oud ? 'regel_bijwerken' : 'regel_nieuw', object_soort: 'afzender_regel', object_id: String(rij.id), entiteit,
        voor: oud ? { leverancier: oud.leverancier, entiteit: oud.entiteit, betaalwijze: oud.betaalwijze } : null,
        na: { soort: x.soort, patroon, leverancier: lev.id, entiteit, betaalwijze, bron: 'voorstel uit verzonden mail' }, wanneer });
      x.status = 'bevestigd'; x.besloten_door = r.wie; x.besloten_op = wanneer; x.regel_id = rij.id;
    }
    D.metaZet(fdb, VOORSTEL_SLEUTEL, JSON.stringify(v));
    return { patroon, status: x.status, regel_id: x.regel_id || null };
  });
}

// Statusgebeurtenis zonder opdracht of met een nieuwe opdracht (Opnieuw proberen). Gedeeld door de routes en de signaalknoppen.
function factuurGebeurtenis(fdb, r, f, gebeurtenis, nu) {
  const wanneer = nuIso(nu);
  if (gebeurtenis === 'opnieuw_proberen') {
    const ctx = kernCtx(fdb, nu);
    const poort = poortVoor(fdb, f, ctx);
    const ov = K.statusOvergang(f.status, 'opnieuw_proberen', { entiteit: f.entiteit });
    if (!ov.ok) weiger(409, 'opnieuw proberen kan niet: ' + ov.reden);
    const e = fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(f.entiteit);
    const op = K.maakOpdracht(f, e, { id: D.nieuwId(), bijlagen: bijlagenVan(fdb, f), verstuur_na: K.verstuurNa(nu, verstuurInstelling(fdb)), poort });
    const u = fdb.db.prepare("UPDATE factuur SET status = 'in_wachtrij', bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND status = 'verzending_mislukt'").run(wanneer, f.id);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd');
    D.voegToe(fdb, 'opdracht', { id: op.id, soort: op.soort, factuur: f.id, entiteit: op.entiteit, doeladres: op.doeladres, bijlagen: op.bijlagen, vingerafdruk: op.vingerafdruk,
      verstuur_na: op.verstuur_na, idempotentiesleutel: op.idempotentiesleutel, status: 'wacht', poging: 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer, bijgewerkt_op: wanneer });
    D.audit(fdb, { wie: r.wie, wat: 'opnieuw_proberen', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { status: f.status }, na: { status: 'in_wachtrij', opdracht: op.id }, wanneer });
    return { status: 'in_wachtrij', opdracht: { id: op.id, verstuur_na: op.verstuur_na } };
  }
  const ov = K.statusOvergang(f.status, gebeurtenis, { entiteit: f.entiteit });
  if (!ov.ok) weiger(409, 'kan niet: ' + ov.reden);
  const wis = ov.naar === 'te_beoordelen' ? ', bevestigd_door = NULL, bevestigd_op = NULL' + (gebeurtenis === 'toch_factuur' ? ', dubbel_van = NULL' : '') : '';
  const u = fdb.db.prepare('UPDATE factuur SET status = ?' + wis + ', bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND status = ?').run(ov.naar, wanneer, f.id, f.status);
  if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd');
  besluitRij(fdb, f.id, K.besluit('status', 'status', ov.naar, 'mens', gebeurtenis.replace(/_/g, ' ')), r.wie, wanneer);
  D.audit(fdb, { wie: r.wie, wat: gebeurtenis, object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { status: f.status }, na: { status: ov.naar }, wanneer });
  return { status: ov.naar };
}
// Route-variant: sluit ook een open signaal dat precies hierover gaat (dubbele factuur, verzending mislukt), met zijn les.
function gebeurtenisRoute(fdb, r, d, gebeurtenis, nu) {
  const id = vraagId(d, 'id');
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    const soort = { toch_factuur: 'dubbele_factuur', opnieuw_proberen: 'verzending_mislukt', terug_naar_beoordelen: 'verzending_mislukt' }[gebeurtenis];
    const s = soort ? fdb.db.prepare("SELECT s.* FROM signaal s WHERE s.status = 'open' AND s.soort = ? AND EXISTS (SELECT 1 FROM json_each(s.facturen) j WHERE j.value = ?) " +
      'ORDER BY s.aangemaakt_op DESC LIMIT 1').get(soort, f.id) : null;
    if (s && magSignaal(r, s)) {
      const knop = gebeurtenis;
      if (B.SIGNALEN[s.soort].knoppen[knop] && (soort !== 'dubbele_factuur' || json(s.facturen, [])[0] === f.id)) return signaalAfhandelen(fdb, r, s, knop, {}, nu).factuur || {};
    }
    return factuurGebeurtenis(fdb, r, f, gebeurtenis, nu);
  });
}
function ingevoerd(fdb, r, d, nu, ongedaan) {
  const id = vraagId(d, 'id');
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (!BETAAL_STATUS.includes(f.status)) weiger(409, 'de factuur is nog niet bevestigd');
    // wv1405 (diffreview MOET 2): een betaling in een SEPA-batch terugzetten kan alleen David in zijn app, en pas als hij zegt dat hij hem
    // uit de batch in de bank haalde (of dat de batch niet is geüpload); anders voert de bank hem later toch uit en wordt hij dubbel betaald
    if (ongedaan && f.betaalspoor === 'ingevoerd' && f.uitvoer_op) {
      const eerder = sepaEerder(fdb, f.id);
      if (!isEig(r) || r.ingang !== 'app') weiger(403, 'deze betaling staat in een SEPA-batch van David; alleen hij kan hem terugzetten', { code: 'in_batch' });
      if (d.uit_bank !== true) weiger(409, 'deze betaling staat in een SEPA-batch: haal hem eerst uit de batch in de bank (of kijk na dat die batch niet is geüpload) en bevestig dan',
        { code: 'in_batch', in_batch: eerder ? { msg_id: eerder.msg_id, wanneer: eerder.wanneer, uitvoerdatum: eerder.uitvoerdatum } : null });
    }
    const ov = K.betaalspoorOvergang(f.betaalspoor, ongedaan ? 'ongedaan' : 'ingevoerd_in_bank');
    if (!ov.ok) weiger(409, 'kan niet: ' + ov.reden);
    const wanneer = nuIso(nu);
    // wv1405: Ongedaan wist ook de uitvoerdatum van de batch (de bankcontrole telt dan weer vanaf de vervaldatum); de batch zelf blijft staan
    const u = fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, ingevoerd_door = ?, ingevoerd_op = ?, uitvoer_op = CASE WHEN ? THEN NULL ELSE uitvoer_op END, bijgewerkt_op = ?, ' +
      'versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
      .run(ov.naar, ongedaan ? null : r.wie, ongedaan ? null : wanneer, ongedaan ? 1 : 0, wanneer, f.id, f.betaalspoor);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd');
    D.audit(fdb, { wie: r.wie, wat: ongedaan ? 'ingevoerd_ongedaan' : 'ingevoerd_in_bank', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit,
      voor: { betaalspoor: f.betaalspoor }, na: { betaalspoor: ov.naar }, wanneer });
    const eerder = ongedaan ? sepaEerder(fdb, f.id) : null;
    return Object.assign({ betaalspoor: ov.naar }, eerder ? { in_batch: { msg_id: eerder.msg_id, wanneer: eerder.wanneer, uitvoerdatum: eerder.uitvoerdatum,
      let_op: 'deze betaling zat in een batch; haal hem ook uit de bank (of controleer dat de batch niet is uitgevoerd)' } } : {});
  });
}

// ───────────────────────────── SEPA-batch (wv1405) ─────────────────────────────

/*
 * SEPA-batch uit de betaallijst (wv1405, David 27-10-2026; bouwplan "Facturen-app - SEPA-batch (bouwplan 27-10-2026)"). Per eigen rekening één
 * pain.001.001.09-bestand (facturen-sepa.js) dat David in de bank uploadt en daar zelf ondertekent: hier betaalt niets. Alleen de eigenaar via
 * zijn app. Eerst een voorbeeld (geen vingerafdruk) met een vingerafdruk van de inhoud (sleutel); de download vraagt een verse vingerafdruk en
 * dezelfde sleutel (anders 409: er veranderde iets), en doet in één BEGIN IMMEDIATE: alles opnieuw toetsen, sepa_batch + sepa_regel,
 * facturen op 'ingevoerd' (WHERE betaalspoor = 'te_betalen', elk precies één rij) en de audit. Alles of niets. Het bestand gaat alleen naar
 * de browser; uit sepa_batch/sepa_regel is hetzelfde bestand opnieuw te maken (zelfde MsgId: de bank herkent een dubbele upload).
 * Nooit in een batch: POT, Privé, creditnota, geen euro, bedrag ≤ 0, geen of fout IBAN, IBAN buiten de EER, IBAN nog niet nagebeld, geen
 * begunstigde, al een bankbetaling of open koppelvoorstel, uitvoerdatum te ver. Alleen met een uitdrukkelijke keuze (`bewust`): al eerder
 * in een batch, mogelijk al betaald (afschrijving naar dat IBAN met dat bedrag sinds de factuurdatum), kenmerk van 16 cijfers dat de
 * elfproef niet haalt. Redenen noemen nooit een bedrag of naam.
 */
const SEPA_OPNIEUW_DAGEN = 30;
// wv1415: een factuur heeft "netto" een bankbetaling als er meer betalingen dan terugboekingen (methode sepa_terug) aan gekoppeld zijn; zo
// facturen-bank.js (netto): elke terugboeking heft één betaling op.
const NETTO_GEKOPPELD = "(SELECT count(*) FROM koppeling k WHERE k.factuur = ?1 AND coalesce(k.methode, '') <> 'sepa_terug') > " +
  "(SELECT count(*) FROM koppeling k WHERE k.factuur = ?1 AND k.methode = 'sepa_terug')";
// Een regel "loopt" nog in zijn batch: de factuur staat op ingevoerd met de uitvoerdatum van deze regel, en dit is zijn laatste batch
// (diffreview wv1405 MOET 1: na Ongedaan of een nieuwe batch is het oude bestand niet meer opnieuw te geven).
const SEPA_LOPEND = "f.betaalspoor = 'ingevoerd' AND f.uitvoer_op = r.uitvoerdatum AND r.id = (SELECT max(r2.id) FROM sepa_regel r2 WHERE r2.factuur = r.factuur)";
const ONDERWEG_BETAAL = ONDERWEG;   // Privé (prive_archief) staat op de betaallijst maar kan nooit in een batch
const SEPA_WAARSCHUWING = {
  eerder_in_batch: 'zat al in een batch; alleen opnieuw als je zeker weet dat die batch niet is uitgevoerd',
  mogelijk_betaald: 'er staat al een afschrijving naar dit rekeningnummer met dit bedrag; misschien al betaald',
  zegt_betaald: 'het stuk zegt dat hij al betaald is (niet gevonden in de bank); alleen betalen als je zeker weet dat het niet al gebeurd is',
  kenmerk_fout: 'het betalingskenmerk (16 cijfers) klopt niet volgens de controle; gaat als vrije tekst mee',
};
function sepaRekeningen(fdb) {
  return fdb.db.prepare("SELECT k.* FROM rekening k JOIN entiteit e ON e.sleutel = k.entiteit WHERE k.controle = 1 AND k.bank_formaat <> 'bankluis' AND k.entiteit NOT IN ('prive','pot') " +
    "AND k.bank IN ('ABN','ING','TRIODOS') AND e.actief = 1 ORDER BY k.entiteit, k.iban").all().filter((k) => K.ibanMod97(k.iban));
}
function lokaalTijd(nu) { return new Date(nu).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23' }).replace(' ', 'T').slice(0, 19); }
// De naam waaronder dit IBAN eerder betaald is (bankhistorie, de naam die de bank bij de rekening kent: minder "naam komt niet overeen" bij de
// naam-nummercheck; review wv1405 #7), anders de leveranciersnaam van de factuur.
function sepaNaam(fdb, iban, levNaam) {
  const b = iban ? fdb.db.prepare("SELECT tegenpartij_naam AS n FROM bank_transactie WHERE tegenpartij_iban = ? AND bedrag_centen < 0 AND verwijderd_op IS NULL AND " +
    "tegenpartij_naam IS NOT NULL AND trim(tegenpartij_naam) <> '' ORDER BY boekdatum DESC, id LIMIT 1").get(iban) : null;
  const n = S.tekst(b ? b.n : levNaam, 70);
  return n || S.tekst(levNaam, 70) || null;
}
function sepaEerder(fdb, id) {
  return fdb.db.prepare('SELECT b.id, b.msg_id, b.wanneer, r.uitvoerdatum, r.pmtinf_id FROM sepa_regel r JOIN sepa_batch b ON b.id = r.batch WHERE r.factuur = ? ORDER BY b.wanneer DESC, r.id DESC LIMIT 1').get(id) || null;
}
/*
 * Beoordeel één factuur voor een batch. → { reden (null = kan mee), waarschuwingen: [code], regel?: { factuur, datum, centen, iban, naam, rmt },
 * uitvoer, eerder }. rek = de gekozen rekening (of null: dan alleen de factuur zelf beoordelen, voor de betaallijst).
 */
function sepaBeoordeel(fdb, f, lev, ctx, vandaag, rek) {
  const uitvoer = S.uitvoerVoor(Object.assign({}, f, { lev_naam: lev ? lev.naam : null }), vandaag);   // lev_naam: Belastingdienst herkennen
  const eerder = sepaEerder(fdb, f.id);
  const uit = { reden: null, waarschuwingen: [], uitvoer, eerder };
  const nee = (r) => { uit.reden = r; return uit; };
  if (K.isCreditnota(f)) return nee('creditnota: niets te betalen');
  if (f.entiteit === 'prive' || f.entiteit === 'pot') return nee('POT en Privé kunnen geen batch (met de hand)');
  if (!ONDERWEG_BETAAL.includes(f.status)) return nee('nog niet bevestigd');
  if (f.betaalspoor !== 'te_betalen') return nee(f.betaalspoor === 'ingevoerd' ? 'al ingevoerd in de bank' : 'staat niet op te betalen');
  if (rek && f.entiteit !== rek.entiteit) return nee('hoort bij een andere entiteit dan deze rekening');
  if (f.valuta !== 'EUR') return nee('andere valuta dan euro: met de hand');
  if (!Number.isSafeInteger(f.incl) || f.incl <= 0) return nee('bedrag ontbreekt of is niet positief');
  const iban = K.ibanNorm(f.iban);
  if (!iban || !K.ibanMod97(iban)) return nee('rekeningnummer ontbreekt of klopt niet');
  if (!S.isEer(iban)) return nee('rekening buiten de EER: met de hand (adres en BIC nodig)');
  if (K.magBevestigen(Object.assign({}, f, { status: 'te_beoordelen' }), { leverancier: lev, ctx }).redenen.some((x) => /IBAN/.test(x))) return nee('rekeningnummer nog niet nagebeld');
  if (fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j').get(f.id).j) return nee('er is al een bankbetaling aan gekoppeld');
  if (fdb.db.prepare("SELECT 1 FROM voorstel v WHERE v.status = 'open' AND EXISTS (SELECT 1 FROM json_each(v.facturen) j WHERE j.value = ?) LIMIT 1").get(f.id))
    return nee('er staat een koppelvoorstel open (Bankcontrole)');
  if (uitvoer.te_ver) return nee('uitvoerdatum ligt meer dan 364 dagen vooruit; kies een datum');
  const naam = sepaNaam(fdb, iban, lev ? lev.naam : f.leverancier_naam);
  if (!naam) return nee('begunstigde ontbreekt');
  const rmt = S.omschrijving(f);
  if (eerder) uit.waarschuwingen.push('eerder_in_batch');
  if (zegtBetaald(fdb, f.id)) uit.waarschuwingen.push('zegt_betaald');   // wv1917 (diffreview MOET 2)
  if (rmt.waarschuwing) uit.waarschuwingen.push(rmt.waarschuwing);
  if (fdb.db.prepare('SELECT 1 FROM bank_transactie t WHERE t.tegenpartij_iban = ? AND t.bedrag_centen = ? AND t.verwijderd_op IS NULL AND t.boekdatum >= ? ' +
    'AND NOT EXISTS (SELECT 1 FROM koppeling k WHERE k.transactie = t.id) LIMIT 1').get(iban, -f.incl, f.factuurdatum && K.isIsoDatum(f.factuurdatum) ? f.factuurdatum : K.plusDagen(vandaag, -60)))
    uit.waarschuwingen.push('mogelijk_betaald');
  uit.regel = { factuur: f.id, datum: uitvoer.datum, centen: f.incl, iban, naam, rmt: rmt.strd ? { strd: rmt.strd } : rmt.ustrd ? { ustrd: rmt.ustrd } : null };
  return uit;
}
// wv1917: zei het stuk "al betaald" zonder dat de bank het liet zien (kern ZEGT_BETAALD/ZEGT_BETAALD_UBL in de besluitrij van de betaalwijze)?
function zegtBetaald(fdb, id) {
  return !!fdb.db.prepare("SELECT 1 FROM besluit WHERE factuur = ? AND stap = 'betaalwijze' AND toelichting LIKE '%al betaald, niet gevonden in de bank' LIMIT 1").get(id);
}
function sepaBetaalInfo(fdb, f, lev, ctx, vandaag) {
  const b = sepaBeoordeel(fdb, f, lev, ctx, vandaag, null);
  return { betaal_op: f.betaal_op || null, uitvoer: b.uitvoer.datum, uitvoer_bron: b.uitvoer.bron, batch_reden: b.reden,
    waarschuwingen: b.waarschuwingen.map((c) => ({ code: c, tekst: SEPA_WAARSCHUWING[c] })), sepa_naam: b.regel ? b.regel.naam : null,
    sepa_omschrijving: b.regel && b.regel.rmt ? (b.regel.rmt.strd ? b.regel.rmt.strd.ref : b.regel.rmt.ustrd) : null,
    eerder_in_batch: b.eerder ? { msg_id: b.eerder.msg_id, wanneer: b.eerder.wanneer, uitvoerdatum: b.eerder.uitvoerdatum } : null };
}
function sepaOverzicht(fdb, nu) {
  const g = S.grenzen(dagAmsterdam(nu));
  const rek = sepaRekeningen(fdb).map((k) => ({ id: k.id, entiteit: k.entiteit, rekening: eind4(k.iban), bank: k.bank }));
  const batches = fdb.db.prepare('SELECT b.*, (SELECT count(*) FROM sepa_regel r JOIN factuur f ON f.id = r.factuur WHERE r.batch = b.id AND ' + SEPA_LOPEND + ') AS nog, ' +
    '(SELECT min(uitvoerdatum) FROM sepa_regel r WHERE r.batch = b.id) AS van, (SELECT max(uitvoerdatum) FROM sepa_regel r WHERE r.batch = b.id) AS tot FROM sepa_batch b ' +
    'WHERE b.wanneer >= ? ORDER BY b.wanneer DESC LIMIT 10').all(nuIso(nu - 60 * 86400000)).map((b) => ({ id: b.id, msg_id: b.msg_id, entiteit: b.entiteit, rekening: eind4(b.dbtr_iban),
    aantal: b.aantal, totaal_centen: b.totaal_centen, wanneer: b.wanneer, van: b.van, tot: b.tot, nog_ingevoerd: b.nog,
    opnieuw_kan: nu - Date.parse(b.wanneer) <= SEPA_OPNIEUW_DAGEN * 86400000 && b.nog === b.aantal, specificatie: specStand(fdb, b.id, nu) }));
  return { formaat: S.FORMAAT, vroegst: g.vroegst, uiterst: g.uiterst, rekeningen: rek, batches };
}
// POST betaaldatum { id, datum | null }: de uitvoerdatum voor de batch (null = terug naar de standaard). Alleen de eigenaar (review wv1405 #11).
function betaaldatum(fdb, r, d, nu) {
  eisEigenaar(r);
  const id = vraagId(d, 'id');
  const datum = d.datum === null || d.datum === '' || d.datum === undefined ? null : String(d.datum);
  const vandaag = dagAmsterdam(nu);
  if (datum) { const fout = S.datumFout(datum, vandaag); if (fout) weiger(400, fout); }
  return D.transactie(fdb, function () {
    const f = factuurOf404(fdb, r, id);
    if (!BETAAL_STATUS.includes(f.status) || f.betaalspoor !== 'te_betalen') weiger(409, 'alleen voor een factuur die nog betaald moet worden');
    const lev = leverancierKern(fdb, f.leverancier_id), fl = Object.assign({}, f, { lev_naam: lev ? lev.naam : null });
    if ((f.betaal_op || null) === datum) return { betaal_op: datum, uitvoer: S.uitvoerVoor(fl, vandaag) };
    const wanneer = nuIso(nu);
    const u = fdb.db.prepare("UPDATE factuur SET betaal_op = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = 'te_betalen'").run(datum, wanneer, f.id);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd');
    D.audit(fdb, { wie: r.wie, wat: 'betaaldatum', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { betaal_op: f.betaal_op || null }, na: { betaal_op: datum }, wanneer });
    return { betaal_op: datum, uitvoer: S.uitvoerVoor(Object.assign(fl, { betaal_op: datum }), vandaag) };
  });
}
function sepaSamenstellen(fdb, r, d, nu) {
  const rekId = vraagId(d, 'rekening');
  const rek = sepaRekeningen(fdb).find((k) => k.id === rekId);
  if (!rek) weiger(409, 'met deze rekening kan geen batch (POT, Privé, bankluis of geen controle)');
  const lijst = Array.isArray(d.facturen) ? d.facturen.map(String) : null;
  if (!lijst || !lijst.length) weiger(400, 'kies minstens één factuur');
  if (lijst.length > S.MAX_REGELS) weiger(400, 'hooguit ' + S.MAX_REGELS + ' facturen per batch');
  if (lijst.some((x) => !ID_RE.test(x))) weiger(400, 'factuur-id ongeldig');
  if (new Set(lijst).size !== lijst.length) weiger(400, 'een factuur staat er twee keer in');
  // bewust per factuur én waarschuwing ("<id>:<code>"; diffreview ZOU 3): een akkoord op het ene dekt geen ander dat er later bij kwam
  const bewust = new Set(Array.isArray(d.bewust) ? d.bewust.map(String).filter((x) => /^[0-9a-f]{16}:[a-z_]{3,30}$/.test(x)) : []);
  const vandaag = dagAmsterdam(nu), ctx = kernCtx(fdb, nu);
  const e = fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(rek.entiteit);
  const regels = [], geweigerd = [];
  for (const id of lijst) {
    const f = D.factuurVoorKern(fdb, id);
    if (!f || !magFactuur(r, f)) { geweigerd.push({ id, reden: 'factuur niet gevonden' }); continue; }
    const b = sepaBeoordeel(fdb, f, leverancierKern(fdb, f.leverancier_id), ctx, vandaag, rek);
    if (b.reden) { geweigerd.push({ id, reden: b.reden }); continue; }
    const open = b.waarschuwingen.filter((c) => !bewust.has(id + ':' + c));
    if (open.length) { geweigerd.push({ id, reden: 'vraagt een uitdrukkelijke keuze: ' + open.map((c) => SEPA_WAARSCHUWING[c]).join('; '), bewust_nodig: open }); continue; }
    regels.push(Object.assign({ waarschuwingen: b.waarschuwingen.slice().sort() }, b.regel));
  }
  regels.sort((a, b) => (a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : 0) || a.naam.localeCompare(b.naam, 'nl') || a.factuur.localeCompare(b.factuur));
  const naam = S.tekst(e.naam, 70) || S.tekst(e.naam_kort, 70) || e.sleutel;
  const kop = { initg_naam: naam, dbtr_naam: naam, dbtr_iban: K.ibanNorm(rek.iban), dbtr_bic: S.bicVoor(rek.iban) };
  const kaal = regels.map((x) => ({ factuur: x.factuur, datum: x.datum, centen: x.centen, iban: x.iban, naam: x.naam, rmt: x.rmt }));
  const per = new Map();
  for (const x of kaal) { const p = per.get(x.datum) || { datum: x.datum, aantal: 0, totaal_centen: 0 }; p.aantal++; p.totaal_centen += x.centen; per.set(x.datum, p); }
  const sleutel = regels.length ? S.sha256(S.inhoudSleutel(kop, kaal) + '|' + JSON.stringify(regels.map((x) => [x.factuur, x.waarschuwingen]))) : null;
  return { rek, e, kop, regels: kaal, geweigerd, sleutel,
    overzicht: { rekening: eind4(rek.iban), bank: rek.bank, entiteit: rek.entiteit, aantal: kaal.length, totaal_centen: kaal.reduce((s, x) => s + x.centen, 0),
      vroegste: kaal.length ? kaal[0].datum : null, laatste: kaal.length ? kaal[kaal.length - 1].datum : null, per_datum: [...per.values()],
      regels: regels.map((x) => ({ id: x.factuur, naam: x.naam, rekening: eind4(x.iban), centen: x.centen, datum: x.datum,
        omschrijving: x.rmt ? (x.rmt.strd ? x.rmt.strd.ref + ' (betalingskenmerk)' : x.rmt.ustrd) : null, waarschuwingen: x.waarschuwingen })) } };
}
function sepaBestandNaam(e, vandaag, msgId) { return 'SEPA ' + (S.tekst(e.naam_kort || e.sleutel, 30) || 'batch') + ' ' + vandaag + ' ' + msgId.slice(-8) + '.xml'; }
function sepaBatch(fdb, r, d, nu, o) {
  eisEigenaar(r);
  if (r.ingang !== 'app') weiger(403, 'een batch maakt David in zijn eigen app');
  if (d.voorbeeld === true) {
    const s = sepaSamenstellen(fdb, r, d, nu);
    return Object.assign({ voorbeeld: true, sleutel: s.sleutel, geweigerd: s.geweigerd }, s.overzicht);
  }
  if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
  o.versVerbruik();
  return D.transactie(fdb, function () {
    const s = sepaSamenstellen(fdb, r, d, nu);
    if (s.geweigerd.length) weiger(409, 'niet alles kan mee; maak het voorbeeld opnieuw', { geweigerd: s.geweigerd });
    if (!s.sleutel || String(d.sleutel || '') !== s.sleutel) weiger(409, 'de batch is intussen veranderd; maak het voorbeeld opnieuw', { code: 'veranderd' });
    const vandaag = dagAmsterdam(nu), wanneer = nuIso(nu);
    let msgId;
    for (let i = 0; i < 5 && (!msgId || fdb.db.prepare('SELECT 1 FROM sepa_batch WHERE msg_id = ?').get(msgId)); i++) msgId = S.nieuwMsgId(vandaag, D.nieuwId().slice(0, 8));
    const kop = Object.assign({ msg_id: msgId, cre_dt_tm: lokaalTijd(nu) }, s.kop);
    const x = S.xml(kop, s.regels);
    const sha = S.sha256(x.tekst);
    const batchId = D.nieuwId();
    D.voegToe(fdb, 'sepa_batch', { id: batchId, rekening: s.rek.id, entiteit: s.rek.entiteit, formaat: S.FORMAAT, msg_id: msgId, cre_dt_tm: kop.cre_dt_tm,
      initg_naam: kop.initg_naam, dbtr_naam: kop.dbtr_naam, dbtr_iban: kop.dbtr_iban, dbtr_bic: kop.dbtr_bic, aantal: s.regels.length,
      totaal_centen: s.overzicht.totaal_centen, sha256: sha, wie: r.wie, wanneer });
    let positie = 0;
    for (const b of x.blokken) for (const t of b.regels) {
      positie++;
      D.voegToe(fdb, 'sepa_regel', { batch: batchId, factuur: t.factuur, pmtinf_id: b.pmtinf_id, volgnr: b.volgnr, positie, uitvoerdatum: t.datum, centen: t.centen,
        iban: t.iban, naam: S.tekst(t.naam, 70), rmt: t.rmt });
      const u = fdb.db.prepare("UPDATE factuur SET betaalspoor = 'ingevoerd', ingevoerd_door = ?, ingevoerd_op = ?, uitvoer_op = ?, bijgewerkt_op = ?, versie = versie + 1 " +
        "WHERE id = ? AND betaalspoor = 'te_betalen'").run(r.wie, wanneer, t.datum, wanneer, t.factuur);
      if (u.changes !== 1) weiger(409, 'een factuur is intussen gewijzigd; maak het voorbeeld opnieuw', { code: 'veranderd' });
      D.audit(fdb, { wie: r.wie, wat: 'sepa_batch_regel', object_soort: 'factuur', object_id: t.factuur, entiteit: s.rek.entiteit,
        voor: { betaalspoor: 'te_betalen' }, na: { betaalspoor: 'ingevoerd', batch: batchId, uitvoerdatum: t.datum }, wanneer });
    }
    D.audit(fdb, { wie: r.wie, wat: 'sepa_batch', object_soort: 'sepa_batch', object_id: batchId, entiteit: s.rek.entiteit,
      na: { msg_id: msgId, rekening: s.rek.id, rekening_eind: eind4(s.rek.iban), formaat: S.FORMAAT, aantal: s.regels.length,
        per_datum: s.overzicht.per_datum.map((p) => [p.datum, p.aantal]), facturen: s.regels.map((t) => t.factuur), sha256: sha, bewust: Array.isArray(d.bewust) ? d.bewust.length : 0 }, wanneer });
    return { batch: batchId, msg_id: msgId, bestand: { naam: sepaBestandNaam(s.e, vandaag, msgId), type: 'application/xml', inhoud: x.tekst, sha256: sha }, overzicht: s.overzicht };
  });
}
// POST sepa-bestand { batch }: hetzelfde bestand opnieuw (zelfde MsgId en inhoud, byte voor byte; anders 409), binnen 30 dagen. Voor een
// download die misging: upload het niet als de bank hem al heeft (de bank weigert dezelfde MsgId of herkent het bestand). Review wv1405 #2.
function sepaBestand(fdb, r, d, nu, o) {
  eisEigenaar(r);
  if (r.ingang !== 'app') weiger(403, 'een batch maakt David in zijn eigen app');
  const id = vraagId(d, 'batch');
  const b = fdb.db.prepare('SELECT * FROM sepa_batch WHERE id = ?').get(id);
  if (!b) weiger(404, 'batch niet gevonden');
  if (nu - Date.parse(b.wanneer) > SEPA_OPNIEUW_DAGEN * 86400000) weiger(409, 'deze batch is ouder dan ' + SEPA_OPNIEUW_DAGEN + ' dagen');
  const lopend = Number(fdb.db.prepare('SELECT count(*) AS n FROM sepa_regel r JOIN factuur f ON f.id = r.factuur WHERE r.batch = ? AND ' + SEPA_LOPEND).get(b.id).n);
  if (lopend !== b.aantal) weiger(409, 'niet meer hetzelfde: een betaling uit deze batch is intussen ongedaan gemaakt, in een nieuwe batch gezet of al op de bank gezien; ' +
    'kijk in de bank wat er met deze batch is gebeurd', { code: 'veranderd' });
  if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
  o.versVerbruik();
  const regels = fdb.db.prepare('SELECT * FROM sepa_regel WHERE batch = ? ORDER BY positie').all(b.id)
    .map((x) => ({ factuur: x.factuur, datum: x.uitvoerdatum, centen: x.centen, iban: x.iban, naam: x.naam, rmt: json(x.rmt, null) }));
  const x = S.xml({ msg_id: b.msg_id, cre_dt_tm: b.cre_dt_tm, initg_naam: b.initg_naam, dbtr_naam: b.dbtr_naam, dbtr_iban: b.dbtr_iban, dbtr_bic: b.dbtr_bic }, regels);
  const sha = S.sha256(x.tekst);
  if (sha !== b.sha256) weiger(409, 'het bestand is niet exact opnieuw te maken; maak geen nieuwe batch voordat je in de bank hebt gekeken');
  const e = fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(b.entiteit) || { sleutel: b.entiteit };
  return D.transactie(fdb, function () {
    D.audit(fdb, { wie: r.wie, wat: 'sepa_bestand_opnieuw', object_soort: 'sepa_batch', object_id: b.id, entiteit: b.entiteit, na: { msg_id: b.msg_id, sha256: sha }, wanneer: nuIso(nu) });
    return { batch: b.id, msg_id: b.msg_id, bestand: { naam: sepaBestandNaam(e, b.wanneer.slice(0, 10), b.msg_id), type: 'application/xml', inhoud: x.tekst, sha256: sha } };
  });
}
// ─────────────────────── specificatie per batch voor de boekhouder (wv2025) ───────────────────────

/*
 * wv2025 (David 30-10-2026: "Als we een batch-betaling doen, ziet hij dit als 1 bedrag in Exact Online ... graag een mail met omschrijving
 * welke facturen er in die batch zitten"). Per batch een PDF-specificatie (facturen-specificatie.js: per uitvoerdatum = per afschrijving
 * leverancier, factuurnummer, bedrag en subtotaal; geen btw, geen IBAN van een leverancier) en een Gmail-concept aan de boekhouder. Alleen
 * lezen uit sepa_batch/sepa_regel/factuur (sepa_batch is onveranderlijk); het spoor (aangevraagd, klaar, mislukt, download) staat in de audit
 * (object_soort sepa_batch). Hier geen netwerk: server.js zet het concept klaar via het mailluik en meldt de uitkomst terug. Ontvanger: het
 * afschriftadres van de entiteit, anders het ene afschriftadres dat Facturen kent (de boekhouder); geen of meer dan één = geen concept.
 */
const SPEC_BEZIG_MS = 3 * 60000;   // aangevraagd zonder uitkomst: zo lang "wordt klaargezet", daarna "onbekend: kijk in Gmail"
const SPEC_WAT = ['sepa_specificatie_aangevraagd', 'sepa_specificatie_klaar', 'sepa_specificatie_mislukt'];
function specStand(fdb, id, nu) {
  const a = fdb.db.prepare("SELECT wat, na, wanneer FROM audit WHERE object_soort = 'sepa_batch' AND object_id = ? AND wat IN ('" + SPEC_WAT.join("', '") + "') ORDER BY id DESC LIMIT 1").get(id);
  if (!a) return { status: 'geen' };
  if (a.wat === 'sepa_specificatie_klaar') return { status: 'klaar', op: a.wanneer };
  const na = json(a.na, {}) || {};
  // onzeker = het luik gaf geen bevestiging (time-out, verbroken): misschien staat het concept er toch, dus als "onbekend"
  if (a.wat === 'sepa_specificatie_mislukt') return { status: na.onzeker ? 'onbekend' : 'mislukt', op: a.wanneer, reden: na.reden || null };
  return { status: nu - Date.parse(a.wanneer) < SPEC_BEZIG_MS ? 'bezig' : 'onbekend', op: a.wanneer };
}
function specAan(fdb, entiteit) {
  const e = fdb.db.prepare('SELECT afschrift_doel FROM entiteit WHERE sleutel = ?').get(entiteit);
  if (e && e.afschrift_doel) return e.afschrift_doel;
  const alle = fdb.db.prepare("SELECT DISTINCT afschrift_doel AS a FROM entiteit WHERE afschrift_doel IS NOT NULL AND actief = 1 AND sleutel <> 'prive'").all();
  return alle.length === 1 ? alle[0].a : null;
}
// → { b (sepa_batch + entiteitnaam), s (facturen-specificatie.js maak: g, pdf, sha256, naam, mail) }
function specMaak(fdb, id, nu, stijlVoor) {
  const b = fdb.db.prepare('SELECT b.*, e.naam AS e_naam, e.naam_kort AS e_kort FROM sepa_batch b JOIN entiteit e ON e.sleutel = b.entiteit WHERE b.id = ?').get(id);
  if (!b) weiger(404, 'batch niet gevonden');
  const regels = fdb.db.prepare('SELECT r.positie, r.uitvoerdatum, r.centen, r.naam AS sepa_naam, f.nummer, f.leverancier_naam, l.naam AS lev_naam FROM sepa_regel r ' +
    'JOIN factuur f ON f.id = r.factuur LEFT JOIN leverancier l ON l.id = f.leverancier WHERE r.batch = ? ORDER BY r.positie').all(b.id)
    .map((x) => ({ positie: x.positie, uitvoerdatum: x.uitvoerdatum, centen: x.centen, nummer: x.nummer, leverancier: x.lev_naam || x.leverancier_naam || x.sepa_naam }));
  let stijl = null;
  try { stijl = typeof stijlVoor === 'function' ? stijlVoor(b.entiteit) || null : null; } catch (e) { stijl = null; }   // geen huisstijl = sober
  try {
    return { b, s: SP.maak({ id: b.id, msg_id: b.msg_id, wanneer: b.wanneer, dag: dagAmsterdam(Date.parse(b.wanneer)), entiteit: b.entiteit, entiteit_naam: b.e_naam,
      entiteit_kort: b.e_kort || b.e_naam, rekening_eind: String(b.dbtr_iban).slice(-4), aantal: b.aantal, totaal_centen: b.totaal_centen }, regels,
    { stijl, gemaakt: nuIso(nu), gemaakt_dag: dagAmsterdam(nu) }) };
  } catch (e) { if (e instanceof SP.SpecFout) weiger(409, 'de specificatie klopt niet met de batch (' + e.message + ')', { code: 'spec_klopt_niet' }); throw e; }
}
// POST sepa-specificatie { batch }: de PDF als download (ook voor oudere batches; base64). Het concept zet server.js klaar (specificatieConcept).
function sepaSpecificatie(fdb, r, d, nu, stijlVoor) {
  eisEigenaar(r);
  if (r.ingang !== 'app') weiger(403, 'een batch maakt David in zijn eigen app');
  const id = vraagId(d, 'batch');
  const { b, s } = specMaak(fdb, id, nu, stijlVoor);
  return D.transactie(fdb, function () {
    D.audit(fdb, { wie: r.wie, wat: 'sepa_specificatie_download', object_soort: 'sepa_batch', object_id: b.id, entiteit: b.entiteit, na: { sha256: s.sha256 }, wanneer: nuIso(nu) });
    return { batch: b.id, bestand: { naam: s.naam, type: 'application/pdf', codering: 'base64', inhoud: s.pdf.toString('base64'), sha256: s.sha256 }, specificatie: specStand(fdb, b.id, nu) };
  });
}
/*
 * Voor server.js: het concept voorbereiden. o = { nu, nogmaals, aanleiding: 'batch' | 'knop' }. Niet twee keer tegelijk (bezig), niet nog eens
 * als er al een staat of misschien al staat, tenzij nogmaals. Geen ontvanger: spoor "mislukt" en { klaar: false, reden }. Anders spoor
 * "aangevraagd" en { aan, onderwerp, bericht, bijlage: { naam, mime, inhoud_base64, sha256 } } (alleen voor de pod, nooit naar de app).
 */
function specificatieConcept(fdb, r, id, o) {
  eisEigenaar(r);
  if (r.ingang !== 'app') weiger(403, 'een batch maakt David in zijn eigen app');
  id = vraagId({ batch: id }, 'batch');
  const nu = o.nu;
  let m;
  try { m = specMaak(fdb, id, nu, o.stijlVoor); }
  catch (e) {
    // review wv2025 ZOU 1: een specificatie die niet klopt met de batch wordt een zichtbaar "niet klaargezet", geen stille weigering
    if (!(e instanceof RouteFout) || !e.extra || e.extra.code !== 'spec_klopt_niet') throw e;
    const bb = fdb.db.prepare('SELECT id, entiteit FROM sepa_batch WHERE id = ?').get(id);
    D.transactie(fdb, () => D.audit(fdb, { wie: r.wie, wat: 'sepa_specificatie_mislukt', object_soort: 'sepa_batch', object_id: bb.id, entiteit: bb.entiteit,
      na: { aanleiding: o.aanleiding || null, reden: 'de specificatie klopt niet met de batch' }, wanneer: nuIso(nu) }));
    return { klaar: false, reden: 'de specificatie klopt niet met de batch' };
  }
  const { b, s } = m;
  const aan = specAan(fdb, b.entiteit);
  return D.transactie(fdb, function () {
    const st = specStand(fdb, b.id, nu);
    if (st.status === 'bezig') weiger(409, 'de specificatie wordt al klaargezet; kijk zo in Gmail bij Concepten', { code: 'bezig' });
    if (!o.nogmaals && st.status === 'klaar') weiger(409, 'er staat al een concept met de specificatie in Gmail', { code: 'al_klaar', op: st.op });
    if (!o.nogmaals && st.status === 'onbekend') weiger(409, 'er is al een concept aangevraagd, maar de bevestiging kwam niet terug; kijk eerst in Gmail bij Concepten', { code: 'misschien_al', op: st.op });
    const wanneer = nuIso(nu);
    if (!aan) {
      D.audit(fdb, { wie: r.wie, wat: 'sepa_specificatie_mislukt', object_soort: 'sepa_batch', object_id: b.id, entiteit: b.entiteit,
        na: { aanleiding: o.aanleiding || null, reden: 'geen adres van de boekhouder in Facturen' }, wanneer });
      return { klaar: false, reden: 'geen adres van de boekhouder in Facturen' };
    }
    D.audit(fdb, { wie: r.wie, wat: 'sepa_specificatie_aangevraagd', object_soort: 'sepa_batch', object_id: b.id, entiteit: b.entiteit,
      na: { aanleiding: o.aanleiding || null, sha256: s.sha256, nogmaals: !!o.nogmaals }, wanneer });
    return { batch: b.id, aan, onderwerp: s.mail.onderwerp, bericht: s.mail.bericht, bijlage: { naam: s.naam, mime: 'application/pdf', inhoud_base64: s.pdf.toString('base64'), sha256: s.sha256 } };
  });
}
// Voor server.js: de uitkomst van het mailluik. u = { ok, concept_id?, reden? } → het spoor + de stand.
function specificatieUitkomst(fdb, r, id, u, nu) {
  id = vraagId({ batch: id }, 'batch');
  const b = fdb.db.prepare('SELECT id, entiteit FROM sepa_batch WHERE id = ?').get(id);
  if (!b) weiger(404, 'batch niet gevonden');
  return D.transactie(fdb, function () {
    D.audit(fdb, { wie: r.wie, wat: u.ok ? 'sepa_specificatie_klaar' : 'sepa_specificatie_mislukt', object_soort: 'sepa_batch', object_id: b.id, entiteit: b.entiteit,
      na: u.ok ? { concept_id: kort(u.concept_id, 60) } : Object.assign({ reden: kort(u.reden || 'het mailluik nam het concept niet aan', 160) }, u.onzeker ? { onzeker: true } : {}), wanneer: nuIso(nu) });
    return { specificatie: specStand(fdb, b.id, nu) };
  });
}
// ─────────────────────── maandspecificatie PayPal en creditcard voor de boekhouder (wv2060) ───────────────────────

/*
 * wv2060 (David 30-10-2026 ± 23:15: "de zakelijke paypalbetalingen gespecificeerd op 1 PDF ... elke maand, en hij wilt ook de creditcard
 * afschrijvingen. Fijn als jij me herinnert die uploads te doen naar jou"). Per maand één PDF (facturen-maandspec.js): de PayPal-posten op de
 * bank met de betaling erachter, en per kaart het ICS-rekeningoverzicht van die maand. Alleen lezen uit paypal_regel, kaart_regel,
 * kaart_incasso, bank_transactie en factuur(_archief); het spoor (aangevraagd, klaar, mislukt, download) staat in de audit (object_soort
 * maandspec, object_id JJJJ-MM). Hier geen netwerk: server.js zet het concept klaar via het mailluik (zoals de SEPA-specificatie), houdt de
 * maandronde en de Voor jou-kaart "ICS — transacties uploaden" bij. Een ICS-overzicht kan David in de app uploaden (Uploads; zie upload()).
 */
const MS_WAT = ['maandspec_aangevraagd', 'maandspec_klaar', 'maandspec_mislukt'];
const MS_KAART_NA_DAGEN = 3;   // de herinnering om te uploaden: zoveel dagen na de ICS-incasso van het overzicht
function msMaandOk(m) { if (!MS || !MS.MAAND_RE.test(String(m || ''))) weiger(400, 'maand ontbreekt of is ongeldig (JJJJ-MM)'); return String(m); }
function msStand(fdb, maand, nu) {
  const a = fdb.db.prepare("SELECT wat, na, wanneer FROM audit WHERE object_soort = 'maandspec' AND object_id = ? AND wat IN ('" + MS_WAT.join("', '") + "') ORDER BY id DESC LIMIT 1").get(maand);
  if (!a) return { status: 'geen' };
  const na = json(a.na, {}) || {};
  if (a.wat === 'maandspec_klaar') return { status: 'klaar', op: a.wanneer, ics_ontbrak: !!na.ics_ontbrak, nagekomen: !!na.nagekomen };
  if (a.wat === 'maandspec_mislukt') {
    const v = fdb.db.prepare("SELECT na FROM audit WHERE object_soort = 'maandspec' AND object_id = ? AND wat = 'maandspec_aangevraagd' ORDER BY id DESC LIMIT 1").get(maand);
    return { status: na.onzeker ? 'onbekend' : 'mislukt', op: a.wanneer, reden: na.reden || null, was_nagekomen: !!(v && (json(v.na, {}) || {}).nagekomen) };
  }
  return { status: nu - Date.parse(a.wanneer) < SPEC_BEZIG_MS ? 'bezig' : 'onbekend', op: a.wanneer };
}
function msFactuurNummer(fdb) {
  const f = fdb.db.prepare('SELECT nummer FROM factuur WHERE id = ?'), a = fdb.db.prepare('SELECT nummer FROM factuur_archief WHERE id = ?');
  // id = factuur, arch = factuur_archief (PayPal geeft één id dat in een van beide staat: beide gelijk)
  return (id, arch) => { const x = (id && f.get(id)) || (arch && a.get(arch)) || null; return x && x.nummer ? x.nummer : (id || arch ? 'gekoppeld' : ''); };
}
/*
 * Het ICS-rekeningoverzicht `maand` van een kaart. → { regels, bank: [{ id, datum, bedrag_centen }], incasso_eerste, ingelezen_tot, binnen,
 * status }. bank = de incassoregels op de rekening van de kaart voor dit overzicht (kaart_incasso, plus wat de omschrijving zelf zegt, zodat
 * een nieuwe bankpost ook zonder koppelronde meetelt). binnen = het overzicht staat compleet in Facturen: er zijn al regels van een later
 * overzicht (ICS sloot dit overzicht), of de transacties zijn gelijk aan de incasso op de cent.
 */
function icsMaand(fdb, kaart, maand) {
  const regels = fdb.db.prepare("SELECT transactiedatum, omschrijving, handelaar, valuta_orig, bedrag_orig_centen, bedrag_centen, factuur, factuur_archief FROM kaart_regel WHERE kaart = ? AND soort = 'transactie' AND overzicht = ? ORDER BY transactiedatum, id").all(kaart.id, maand);
  const bank = new Map();
  for (const t of fdb.db.prepare('SELECT t.id, t.boekdatum, t.bedrag_centen FROM kaart_incasso k JOIN bank_transactie t ON t.id = k.transactie WHERE k.kaart = ? AND k.overzicht = ? AND t.verwijderd_op IS NULL').all(kaart.id, maand)) bank.set(t.id, t);
  for (const t of fdb.db.prepare('SELECT id, boekdatum, bedrag_centen, omschrijving FROM bank_transactie WHERE rekening = ? AND verwijderd_op IS NULL AND instr(omschrijving, ?) > 0 AND boekdatum >= ?')
    .all(kaart.rekening, 'ICS-klantnummer ' + kaart.klantnummer, MS.vorigeMaand(maand) + '-01')) {
    if (!bank.has(t.id) && !fdb.db.prepare('SELECT 1 FROM kaart_incasso WHERE transactie = ?').get(t.id) && CC.incassoOverzicht(t.omschrijving, kaart.klantnummer) === maand) bank.set(t.id, t);
  }
  const b = [...bank.values()].map((t) => ({ id: t.id, datum: t.boekdatum, bedrag_centen: t.bedrag_centen })).sort((x, y) => (x.datum < y.datum ? -1 : x.datum > y.datum ? 1 : 0));
  const later = !!fdb.db.prepare("SELECT 1 FROM kaart_regel WHERE kaart = ? AND soort <> 'autorisatie' AND overzicht > ? LIMIT 1").get(kaart.id, maand);
  const tot = fdb.db.prepare('SELECT max(periode_tot) AS t FROM kaart_bestand WHERE kaart = ?').get(kaart.id).t || null;
  const som = regels.reduce((s, r) => s + r.bedrag_centen, 0), bankNetto = -b.reduce((s, x) => s + x.bedrag_centen, 0);
  const binnen = later || (regels.length > 0 && b.length > 0 && som === bankNetto);
  // geen regels en geen incasso: ICS boekte dit overzicht niets af (review wv2060 ZOU 2), ook als er (nog) geen later overzicht is
  const status = regels.length ? (binnen ? 'sluit' : b.length ? 'niet_aangeleverd' : 'nog_niet_geincasseerd') : !b.length ? 'geen' : 'niet_aangeleverd';
  return { regels, bank: b, incasso_eerste: b.length ? b[0].datum : null, ingelezen_tot: tot, binnen, status };
}
// De invoer voor facturen-maandspec.js opbouw (alleen lezen).
function msGegevens(fdb, maand) {
  const nummer = msFactuurNummer(fdb);
  const entNaam = new Map(fdb.db.prepare('SELECT sleutel, naam FROM entiteit').all().map((e) => [e.sleutel, e.naam]));
  let paypal = null;
  if (FP && fdb.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paypal_regel'").get()) {
    let laatste = null;
    try { laatste = JSON.parse(D.metaLees(fdb, 'paypal_laatste') || 'null'); } catch (e) { laatste = null; }
    const bijgewerkt = laatste ? String(laatste.ververst || laatste.op || '') : '';
    const posten = FP.aansluiting(fdb, { maand }).posten;
    const rek = fdb.db.prepare('SELECT t.rekening, r.iban FROM bank_transactie t JOIN rekening r ON r.id = t.rekening WHERE t.id = ?');
    const per = new Map();
    for (const p of posten) {
      const rk = rek.get(p.bank) || {};
      const k = p.entiteit + '|' + (rk.rekening || '');
      if (!per.has(k)) per.set(k, { entiteit: p.entiteit, entiteit_naam: entNaam.get(p.entiteit) || p.entiteit, rekening_eind: String(rk.iban || '').slice(-4), posten: [] });
      const w = p.betaling || null;
      const fac = w && w.factuur ? nummer(w.factuur, w.factuur) : '';
      per.get(k).posten.push({ datum: p.boekdatum, bank_centen: p.bank_centen, status: p.status, tegenpartij: w ? w.tegenpartij || w.leverancier : null, onderwerp: w ? w.onderwerp : null,
        valuta: w ? w.valuta : null, bedrag_centen: w ? w.bedrag_centen : null, factuur: fac });
    }
    paypal = { bijgewerkt: /^\d{4}-\d{2}-\d{2}T/.test(bijgewerkt) ? dagAmsterdam(Date.parse(bijgewerkt)) : null, rekeningen: [...per.values()] };
  }
  const kaarten = [];
  const ics = {};
  if (CC && fdb.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kaart'").get()) {
    for (const k of fdb.db.prepare('SELECT k.*, r.iban FROM kaart k JOIN rekening r ON r.id = k.rekening ORDER BY k.laatste4').all()) {
      const m = icsMaand(fdb, k, maand);
      ics[k.laatste4] = m;
      kaarten.push({ laatste4: k.laatste4, entiteit: k.entiteit, entiteit_naam: entNaam.get(k.entiteit) || k.entiteit, rekening_eind: String(k.iban).slice(-4), status: m.status,
        ingelezen_tot: m.ingelezen_tot, bank: m.bank, regels: m.status === 'niet_aangeleverd' ? [] : m.regels.map((r) => ({ datum: r.transactiedatum, omschrijving: r.omschrijving,
          valuta: r.valuta_orig, bedrag_orig_centen: r.bedrag_orig_centen, bedrag_centen: r.bedrag_centen, factuur: nummer(r.factuur, r.factuur_archief) })) });
    }
  }
  return { x: { maand, paypal, kaarten }, ics };
}
function msMaak(fdb, maand, nu, stijlVoor, o) {
  const { x, ics } = msGegevens(fdb, maand);
  let g0;
  try { g0 = MS.opbouw(x); } catch (e) { if (e instanceof MS.MaandFout) weiger(409, 'de specificatie is niet te maken (' + e.message + ')', { code: 'spec_klopt_niet' }); throw e; }
  let stijl = null;
  try { stijl = g0.entiteiten.length === 1 && typeof stijlVoor === 'function' ? stijlVoor(g0.entiteiten[0]) || null : null; } catch (e) { stijl = null; }
  const s = MS.maak(x, { stijl, gemaakt: nuIso(nu), gemaakt_dag: dagAmsterdam(nu), nagekomen: !!(o && o.nagekomen) });
  return { s, ics };
}
// GET maand-specificatie: de laatste zes maanden met de stand (spoor, PayPal-posten, creditcard binnen of niet).
function maandSpecOverzicht(fdb, r, nu) {
  eisEigenaar(r);
  if (!MS) weiger(404, 'de maandspecificatie zit niet in deze versie van de pod');
  let m = MS.vorigeMaand(dagAmsterdam(nu).slice(0, 7));
  const maanden = [];
  for (let i = 0; i < 6; i++, m = MS.vorigeMaand(m)) {
    const { x } = msGegevens(fdb, m);
    maanden.push({ maand: m, naam: MS.maandNaam(m), specificatie: msStand(fdb, m, nu),
      paypal_posten: x.paypal ? x.paypal.rekeningen.reduce((s, k) => s + k.posten.length, 0) : null,
      creditcard: x.kaarten.map((k) => ({ kaart: '…' + k.laatste4, status: k.status, transacties: k.regels.length })) });
  }
  return { maanden, aan: specAan(fdb, 'tolgaarde') ? true : false };
}
// POST maand-specificatie { maand }: de PDF als download (base64). Het concept zet server.js klaar (maandspec.concept, d.concept = true).
function maandSpecificatie(fdb, r, d, nu, stijlVoor) {
  eisEigenaar(r);
  if (r.ingang !== 'app') weiger(403, 'de maandspecificatie maakt David in zijn eigen app');
  if (!MS) weiger(404, 'de maandspecificatie zit niet in deze versie van de pod');
  const maand = msMaandOk(d.maand);
  const { s } = msMaak(fdb, maand, nu, stijlVoor);
  return D.transactie(fdb, function () {
    D.audit(fdb, { wie: r.wie, wat: 'maandspec_download', object_soort: 'maandspec', object_id: maand, entiteit: s.g.entiteiten.length === 1 ? s.g.entiteiten[0] : null, na: { sha256: s.sha256 }, wanneer: nuIso(nu) });
    return { maand, bestand: { naam: s.naam, type: 'application/pdf', codering: 'base64', inhoud: s.pdf.toString('base64'), sha256: s.sha256 }, specificatie: msStand(fdb, maand, nu) };
  });
}
/*
 * Voor server.js: het concept voorbereiden. o = { nu, nogmaals, nagekomen, aanleiding: 'ronde' | 'knop' | 'machinekamer' }. Zelfde regels
 * als de SEPA-specificatie: niet twee keer tegelijk, niet nog eens als er al een (misschien) staat, tenzij nogmaals of nagekomen (de
 * creditcard kwam na het eerste concept binnen). → { klaar: false, reden } of { maand, aan, onderwerp, bericht, bijlage } (alleen voor de pod).
 */
function maandSpecConcept(fdb, r, maand, o) {
  eisEigenaar(r);
  if (!MS) weiger(404, 'de maandspecificatie zit niet in deze versie van de pod');
  maand = msMaandOk(maand);
  const nu = o.nu;
  let m;
  try { m = msMaak(fdb, maand, nu, o.stijlVoor, { nagekomen: o.nagekomen }); }
  catch (e) {
    if (!(e instanceof RouteFout) || !e.extra || e.extra.code !== 'spec_klopt_niet') throw e;
    D.transactie(fdb, () => D.audit(fdb, { wie: r.wie, wat: 'maandspec_mislukt', object_soort: 'maandspec', object_id: maand, na: { aanleiding: o.aanleiding || null, reden: e.fout }, wanneer: nuIso(nu) }));
    return { klaar: false, reden: e.fout };
  }
  const { s } = m;
  if (o.nagekomen && s.g.ics_ontbreekt) weiger(409, 'geen aanvulling: de creditcard is nog niet compleet binnen', { code: 'geen_aanvulling' });
  const aan = specAan(fdb, s.g.entiteiten.length === 1 ? s.g.entiteiten[0] : 'tolgaarde');
  return D.transactie(fdb, function () {
    const st = msStand(fdb, maand, nu);
    if (st.status === 'bezig') weiger(409, 'de specificatie wordt al klaargezet; kijk zo in Gmail bij Concepten', { code: 'bezig' });
    // review wv2060 ZOU 1: de ronde beslist op een stand van even ervoor; is die intussen veranderd (David drukte net), dan niets
    if (o.verwacht && st.status !== o.verwacht) weiger(409, 'de stand van de maandspecificatie veranderde net', { code: 'stand_veranderd' });
    if (o.nagekomen && !(st.status === 'klaar' && st.ics_ontbrak && !st.nagekomen)) weiger(409, 'geen aanvulling nodig (er ging geen concept zonder creditcard, of de aanvulling staat er al)', { code: 'geen_aanvulling' });
    if (!o.nogmaals && !o.nagekomen && st.status === 'klaar') weiger(409, 'er staat al een concept met de maandspecificatie in Gmail', { code: 'al_klaar', op: st.op });
    if (!o.nogmaals && st.status === 'onbekend') weiger(409, 'er is al een concept aangevraagd, maar de bevestiging kwam niet terug; kijk eerst in Gmail bij Concepten', { code: 'misschien_al', op: st.op });
    const wanneer = nuIso(nu);
    if (!aan) {
      D.audit(fdb, { wie: r.wie, wat: 'maandspec_mislukt', object_soort: 'maandspec', object_id: maand, na: { aanleiding: o.aanleiding || null, reden: 'geen adres van de boekhouder in Facturen' }, wanneer });
      return { klaar: false, reden: 'geen adres van de boekhouder in Facturen' };
    }
    D.audit(fdb, { wie: r.wie, wat: 'maandspec_aangevraagd', object_soort: 'maandspec', object_id: maand, entiteit: s.g.entiteiten.length === 1 ? s.g.entiteiten[0] : null,
      na: { aanleiding: o.aanleiding || null, aan, sha256: s.sha256, nogmaals: !!o.nogmaals, nagekomen: !!o.nagekomen, ics_ontbrak: s.g.ics_ontbreekt,
        paypal_posten: s.g.paypal ? s.g.paypal.aantal : null, kaartregels: s.g.kaarten.reduce((t, k) => t + k.aantal, 0) }, wanneer });
    return { maand, aan, onderwerp: s.mail.onderwerp, bericht: s.mail.bericht, ics_ontbrak: s.g.ics_ontbreekt,
      bijlage: { naam: s.naam, mime: 'application/pdf', inhoud_base64: s.pdf.toString('base64'), sha256: s.sha256 } };
  });
}
// Voor server.js: de uitkomst van het mailluik → het spoor (bij klaar: of de creditcard ontbrak, uit de aanvraag) + de stand.
function maandSpecUitkomst(fdb, r, maand, u, nu) {
  maand = msMaandOk(maand);
  return D.transactie(fdb, function () {
    const a = fdb.db.prepare("SELECT na FROM audit WHERE object_soort = 'maandspec' AND object_id = ? AND wat = 'maandspec_aangevraagd' ORDER BY id DESC LIMIT 1").get(maand);
    const aanv = a ? json(a.na, {}) || {} : {};
    D.audit(fdb, { wie: r.wie, wat: u.ok ? 'maandspec_klaar' : 'maandspec_mislukt', object_soort: 'maandspec', object_id: maand,
      na: u.ok ? { concept_id: kort(u.concept_id, 60), ics_ontbrak: !!aanv.ics_ontbrak, nagekomen: !!aanv.nagekomen }
        : Object.assign({ reden: kort(u.reden || 'het mailluik nam het concept niet aan', 160) }, u.onzeker ? { onzeker: true } : {}), wanneer: nuIso(nu) });
    return { specificatie: msStand(fdb, maand, nu) };
  });
}
/*
 * Voor de maandronde van server.js (alleen lezen). vanaf = de eerste maand die de ronde zelf maakt. → { vorige: { maand, stand, binnen
 * (creditcard van die maand compleet), nagekomen_kan }, kaarten: [{ sleutel, laatste4, maand, incasso_eerste, binnen, open_vanaf }] }.
 * De herinnering hoort bij het overzicht van deze maand (incasso in deze maand) en bij de vorige maand zolang die nog niet binnen is.
 */
function maandSpecPlan(fdb, nu, vanaf) {
  if (!MS) return null;
  const vandaag = dagAmsterdam(nu), deze = vandaag.slice(0, 7), vorige = MS.vorigeMaand(deze), twee = MS.vorigeMaand(vorige), drie = MS.vorigeMaand(twee);
  const kaarten = [];
  const lijst = CC && fdb.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kaart'").get() ? fdb.db.prepare('SELECT * FROM kaart ORDER BY laatste4').all() : [];
  const binnen = {};   // maand → alle kaarten compleet (of geen kaartgebruik)
  // review wv2060 ZOU 3: drie maanden terug, zodat een late upload de kaart nog sluit en een aanvulling nog kan
  for (const m of [drie, twee, vorige, deze]) {
    if (vanaf && m < vanaf) continue;
    binnen[m] = true;
    for (const k of lijst) {
      const x = icsMaand(fdb, k, m);
      const ok = x.binnen || x.status === 'geen';
      if (!ok) binnen[m] = false;
      kaarten.push({ sleutel: 'ics-upload-' + k.laatste4 + '-' + m, laatste4: k.laatste4, maand: m, incasso_eerste: x.incasso_eerste, binnen: ok,
        open_vanaf: x.incasso_eerste ? K.plusDagen(x.incasso_eerste, MS_KAART_NA_DAGEN) : null });
    }
  }
  // PayPal ingelezen tot in deze maand (dus de vorige maand compleet)? Zonder PayPal-tabel of -module: niets om op te wachten.
  let paypalKlaar = true;
  if (FP && fdb.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'paypal_regel'").get()) {
    let l = null;
    try { l = JSON.parse(D.metaLees(fdb, 'paypal_laatste') || 'null'); } catch (e) { l = null; }
    const t = l ? Date.parse(String(l.ververst || l.op || '')) : NaN;
    paypalKlaar = Number.isFinite(t) && dagAmsterdam(t) >= deze + '-01';
  }
  const st = msStand(fdb, vorige, nu);
  const nagekomen = [vorige, twee, drie].filter((m) => (!vanaf || m >= vanaf) && binnen[m]).filter((m) => { const s = msStand(fdb, m, nu); return s.status === 'klaar' && s.ics_ontbrak && !s.nagekomen; });
  return { vandaag, vorige: { maand: vorige, stand: st, binnen: binnen[vorige] !== false, paypal_klaar: paypalKlaar, nagekomen_kan: nagekomen.includes(vorige) }, nagekomen, kaarten };
}
// Voor de bankcontrole: per PmtInf de eigen rekening, uitvoerdatum, totaal en regels (batches van de laatste 400 dagen).
function sepaVoorControle(fdb, van) {
  const per = new Map();
  for (const x of fdb.db.prepare('SELECT r.pmtinf_id, r.factuur, r.centen, r.iban, r.uitvoerdatum, b.dbtr_iban, b.entiteit FROM sepa_regel r JOIN sepa_batch b ON b.id = r.batch ' +
    'WHERE b.wanneer >= ? ORDER BY r.batch, r.positie').all(van)) {
    const p = per.get(x.pmtinf_id) || { pmtinf_id: x.pmtinf_id, eigen_iban: x.dbtr_iban, entiteit: x.entiteit, datum: x.uitvoerdatum, centen: 0, regels: [] };
    p.centen += x.centen; p.regels.push({ factuur: x.factuur, centen: x.centen, iban: x.iban }); per.set(x.pmtinf_id, p);
  }
  return [...per.values()];
}

// ───────────────────────────── signalen, voorstellen, koppelen ─────────────────────────────

// Signaal in de vorm van facturen-bank.js (naam, IBAN's, datum uit details of de eerste bankregel; leveranciersnaam als die er is).
function signaalVoorKern(fdb, s) {
  const d = json(s.details, {}) || {};
  const tx = (json(s.transacties, []) || []).map((id) => fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ?').get(id)).filter(Boolean);
  const lev = s.leverancier ? fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?').get(s.leverancier) : null;
  const t0 = tx[0] || {};
  return { soort: s.soort, status: s.status, sleutel: s.sleutel, transacties: json(s.transacties, []), facturen: json(s.facturen, []), entiteit: s.entiteit,
    leverancier: s.leverancier, bedrag_centen: s.bedrag_centen, details: d, naam: d.naam || (lev && lev.naam) || t0.tegenpartij_naam || null,
    eigen_iban: d.eigen_iban || t0.eigen_iban || null, tegenpartij_iban: d.tegenpartij_iban || t0.tegenpartij_iban || null, datum: d.datum || t0.boekdatum || null,
    alleen_eigenaar: !!s.alleen_eigenaar };
}
/*
 * Een signaal afhandelen met één van zijn knoppen (ontwerp v2 § 4.6): de kern (afhandelSignaal) geeft het afgehandelde signaal met les en
 * de gevolgen; die voeren we hier uit in dezelfde transactie als het afsluiten. Elk gevolg toetst zelf de rechten.
 */
function signaalAfhandelen(fdb, r, s, knop, opties, nu) {
  const wanneer = nuIso(nu);
  const kern = signaalVoorKern(fdb, s);
  if (opties.leverancier !== undefined && !(ID_RE.test(String(opties.leverancier)) && fdb.db.prepare('SELECT 1 FROM leverancier WHERE id = ?').get(opties.leverancier))) weiger(400, 'onbekende leverancier');
  const uitkomst = B.afhandelSignaal(kern, knop, Object.assign({}, opties, { wie: r.wie, nu: wanneer }));
  if (!uitkomst.ok) weiger(uitkomst.fout === 'niet_open' ? 409 : 400, 'signaal: ' + uitkomst.fout + (uitkomst.reden ? ' (' + kort(uitkomst.reden, 200) + ')' : ''));
  const uit = { gevolgen: [] };
  for (const g of uitkomst.gevolgen) uit.gevolgen.push(voerGevolgUit(fdb, r, s, g, nu, uit));
  const af = uitkomst.signaal;
  const u = fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = ?, les = ?, wie = ?, wanneer = ?, sluimer_tot = ? WHERE id = ? AND status = 'open'")
    .run(knop, kort(af.les, 300), r.wie, wanneer, af.sluimer_tot || null, s.id);
  if (u.changes !== 1) weiger(409, 'het signaal is intussen al afgehandeld');
  D.audit(fdb, { wie: r.wie, wat: 'signaal_afgehandeld', object_soort: 'signaal', object_id: s.id, entiteit: s.entiteit, voor: { status: 'open' },
    na: { status: 'afgehandeld', knop, gevolgen: uitkomst.gevolgen.map((g) => g.actie) }, wanneer });
  uit.les = af.les; uit.sluimer_tot = af.sluimer_tot || null;
  return uit;
}
// wv1415: teruggeboekt → weer te betalen; wie/wanneer ingevoerd, betaald gezien en de uitvoerdatum van de batch gaan weg (zoals Ongedaan; de
// batch zelf blijft staan, dus "al eerder in een batch" blijft een uitdrukkelijke keuze). → aantal gewijzigde rijen (0 of 1).
function terugZet(fdb, f, wanneer) {
  return fdb.db.prepare("UPDATE factuur SET betaalspoor = 'te_betalen', betaald_gezien_op = NULL, ingevoerd_door = NULL, ingevoerd_op = NULL, uitvoer_op = NULL, bijgewerkt_op = ?, " +
    "versie = versie + 1 WHERE id = ? AND betaalspoor = ? AND betaalspoor IN ('betaald_gezien','ingevoerd')").run(wanneer, f.id, f.betaalspoor).changes;
}
function voerGevolgUit(fdb, r, s, g, nu, uit) {
  const wanneer = nuIso(nu);
  switch (g.actie) {
    case 'upload_openen': return { actie: g.actie, transactie: g.transactie };
    case 'tekst_tonen': uit.tekst = g.tekst; return { actie: g.actie };
    case 'uitzondering_maken': {
      const u = g.uitzondering, id = D.nieuwId();
      if (!u.tegenpartij) weiger(409, 'deze afschrijving heeft geen tegenpartij om een uitzondering op te maken');
      D.voegToe(fdb, 'uitzondering', { id, richting: u.richting || 'af', rekening: u.rekening || null, tegenpartij: kort(u.tegenpartij, 200), categorie: u.categorie,
        toelichting: 'uit signaal ' + s.soort, alleen_eigenaar: s.alleen_eigenaar ? 1 : 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer });
      for (const t of json(s.transacties, []) || []) fdb.db.prepare('UPDATE bank_transactie SET categorie = ?, uitzondering = ? WHERE id = ? AND uitzondering IS NULL').run(u.categorie, id, t);
      D.audit(fdb, { wie: r.wie, wat: 'uitzondering_maken', object_soort: 'uitzondering', object_id: id, entiteit: s.entiteit, na: { categorie: u.categorie }, wanneer });
      return { actie: g.actie, uitzondering: id };
    }
    case 'leverancier_bijwerken': {
      if (!['alleen_portaal', 'standaard_betaalwijze'].includes(g.veld)) weiger(400, 'dit veld van de leverancier is niet te wijzigen');
      const l = g.leverancier ? fdb.db.prepare('SELECT id, standaard_entiteit, ' + g.veld + ' AS oud FROM leverancier WHERE id = ?').get(g.leverancier) : null;
      if (!l) weiger(409, 'bij dit signaal hoort geen bekende leverancier');
      if (!magLeverancier(r, l)) weiger(403, 'deze leverancier mag je niet wijzigen');
      fdb.db.prepare('UPDATE leverancier SET ' + g.veld + ' = ?, bijgewerkt_op = ? WHERE id = ?').run(g.waarde, wanneer, l.id);
      D.audit(fdb, { wie: r.wie, wat: 'leverancier_bijwerken', object_soort: 'leverancier', object_id: l.id, voor: { [g.veld]: l.oud }, na: { [g.veld]: g.waarde }, wanneer });
      return { actie: g.actie, leverancier: l.id };
    }
    case 'factuur_status': {
      const f = D.factuurVoorKern(fdb, g.factuur);
      if (!f || !magFactuur(r, f)) weiger(404, 'factuur niet gevonden');
      uit.factuur = factuurGebeurtenis(fdb, r, f, g.gebeurtenis, nu);
      return { actie: g.actie, factuur: f.id, status: uit.factuur.status };
    }
    case 'betaalspoor': {
      const f = D.factuurVoorKern(fdb, g.factuur);
      if (!f || !magFactuur(r, f)) weiger(404, 'factuur niet gevonden');
      if (f.betaalspoor === 'betaald_gezien' && g.gebeurtenis === 'bankmatch') return { actie: g.actie, factuur: f.id, betaalspoor: f.betaalspoor };
      // wv1415 (diffreview MOET 2/3): de knop bij een terugboeking verandert het spoor alleen als de factuur netto niet gedekt is (geen
      // nieuwe, geziene betaling) en nog op de teruggeboekte batch staat; anders laat hij het spoor zoals het is.
      const gedekt = () => fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j').get(f.id).j === 1;
      if (g.gebeurtenis === 'teruggeboekt') {
        const nogDeze = f.betaalspoor === 'ingevoerd' && g.batch && (() => { const e = sepaEerder(fdb, f.id); return !!e && e.pmtinf_id === g.batch && f.uitvoer_op === e.uitvoerdatum; })();
        if (gedekt() || !(f.betaalspoor === 'betaald_gezien' || nogDeze)) return { actie: g.actie, factuur: f.id, betaalspoor: f.betaalspoor };
      }
      if (g.gebeurtenis === 'toch_incasso') {
        if (f.betaalspoor === 'ingevoerd') weiger(409, 'deze betaling staat alweer ingevoerd (of in een nieuwe batch); zet die eerst terug');
        if (gedekt() || f.betaalspoor === 'incasso_verwacht') return { actie: g.actie, factuur: f.id, betaalspoor: f.betaalspoor };
      }
      const ov = K.betaalspoorOvergang(f.betaalspoor, g.gebeurtenis);
      if (!ov.ok) weiger(409, 'betaalspoor: ' + ov.reden);
      if (g.gebeurtenis === 'teruggeboekt') terugZet(fdb, f, wanneer);
      else fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, betaald_gezien_op = CASE WHEN ? = \'betaald_gezien\' THEN ? ELSE betaald_gezien_op END, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
        .run(ov.naar, ov.naar, dagAmsterdam(nu), wanneer, f.id, f.betaalspoor);
      D.audit(fdb, { wie: r.wie, wat: 'betaalspoor_' + g.gebeurtenis, object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { betaalspoor: f.betaalspoor }, na: { betaalspoor: ov.naar }, wanneer });
      return { actie: g.actie, factuur: f.id, betaalspoor: ov.naar };
    }
    case 'betaallijst': return { actie: g.actie, factuur: g.factuur };
    case 'koppelen': return Object.assign({ actie: g.actie }, koppelIntern(fdb, r, String(g.transactie || ''), g.factuur, true, nu));
    case 'terug_koppelen': {
      // wv1415: de bijschrijving van een terugboeking aan zijn factuur (heft één betaling op); bestaat hij al (automatisch), dan niets
      const t = fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ? AND verwijderd_op IS NULL').get(String(g.transactie || ''));
      if (!magTransactie(r, t)) weiger(404, 'bankregel niet gevonden');
      const f = D.factuurVoorKern(fdb, g.factuur);
      if (!f || !magFactuur(r, f)) weiger(404, 'factuur niet gevonden');
      if (f.entiteit !== t.entiteit || !(t.bedrag_centen > 0)) weiger(409, 'deze bankregel is geen terugboeking van deze factuur');
      if (fdb.db.prepare('SELECT 1 FROM koppeling WHERE transactie = ? AND factuur <> ?').get(t.id, f.id)) weiger(409, 'deze bankregel is al aan iets anders gekoppeld');
      const n = fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'mens', 'sepa_terug', 1, 0, ?, ?, ?) ON CONFLICT DO NOTHING")
        .run(t.id, f.id, t.alleen_eigenaar || f.alleen_eigenaar || f.patientkenmerk ? 1 : 0, r.wie, wanneer).changes;
      if (n) D.audit(fdb, { wie: r.wie, wat: 'terug_koppelen', object_soort: 'koppeling', object_id: t.id + ':' + f.id, entiteit: f.entiteit, wanneer });
      return { actie: g.actie, nieuw: n === 1 };
    }
    case 'transactie_verwijderen': return Object.assign({ actie: g.actie }, transactieWeg(fdb, r, g.transactie, nu));
    default: weiger(500, 'onbekend gevolg');
  }
}
function koppelIntern(fdb, r, txId, fId, volledig, nu) {
  if (!ID_RE.test(txId) || !ID_RE.test(String(fId || ''))) weiger(400, 'transactie en factuur nodig');
  const t = fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ? AND verwijderd_op IS NULL').get(txId);
  if (!magTransactie(r, t)) weiger(404, 'bankregel niet gevonden');
  const f = D.factuurVoorKern(fdb, fId);
  if (!f || !magFactuur(r, f)) weiger(404, 'factuur niet gevonden');
  if (f.entiteit !== t.entiteit) weiger(409, 'bankregel en factuur horen bij een andere entiteit');
  const wanneer = nuIso(nu);
  const n = fdb.db.prepare("INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) VALUES (?, ?, 'mens', 'handmatig', 1, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(t.id, f.id, volledig ? 1 : 0, t.alleen_eigenaar || f.alleen_eigenaar || f.patientkenmerk ? 1 : 0, r.wie, wanneer).changes;
  let spoor = f.betaalspoor;
  // wv1415 (diffreview MOET 4): niet als een terugboeking deze betaling opheft (bv. "Ja, koppel" op een batchvoorstel na een terugboeking)
  if (volledig && f.betaalspoor && f.betaalspoor !== 'betaald_gezien' && fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j').get(f.id).j === 1) {
    const ov = K.betaalspoorOvergang(f.betaalspoor, 'bankmatch');
    if (ov.ok) { fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, betaald_gezien_op = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?').run(ov.naar, t.boekdatum, wanneer, f.id, f.betaalspoor); spoor = ov.naar; }
  }
  if (n) D.audit(fdb, { wie: r.wie, wat: 'koppelen', object_soort: 'koppeling', object_id: t.id + ':' + f.id, entiteit: f.entiteit, na: { volledig: !!volledig, betaalspoor: spoor }, wanneer });
  return { nieuw: n === 1, betaalspoor: spoor };
}
// Bankregel weghalen (Is hetzelfde bij mogelijk dubbel geüpload): nooit een gekoppelde; sluit ook de open signalen en voorstellen van die post.
function transactieWeg(fdb, r, txId, nu) {
  const t = fdb.db.prepare('SELECT * FROM bank_transactie WHERE id = ? AND verwijderd_op IS NULL').get(String(txId || ''));
  if (!magTransactie(r, t)) weiger(404, 'bankregel niet gevonden');
  if (fdb.db.prepare('SELECT 1 FROM koppeling WHERE transactie = ?').get(t.id)) weiger(409, 'deze bankregel is gekoppeld; ontkoppel hem eerst');
  const wanneer = nuIso(nu);
  fdb.db.prepare('UPDATE bank_transactie SET verwijderd_op = ?, verwijderd_door = ? WHERE id = ? AND verwijderd_op IS NULL').run(wanneer, r.wie, t.id);
  sluitVanTransactie(fdb, t.id, r.wie, wanneer);
  D.audit(fdb, { wie: r.wie, wat: 'transactie_verwijderen', object_soort: 'bank_transactie', object_id: t.id, entiteit: t.entiteit, wanneer });
  return { transactie: t.id };
}
function sluitVanTransactie(fdb, txId, wie, wanneer) {
  fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = 'transactie_verwijderd', wie = ?, wanneer = ? WHERE status = 'open' AND soort <> 'mogelijk_dubbel_geupload' " +
    'AND EXISTS (SELECT 1 FROM json_each(signaal.transacties) j WHERE j.value = ?)').run(wie, wanneer, txId);
  fdb.db.prepare("UPDATE voorstel SET status = 'afgewezen', afgehandeld_door = ?, afgehandeld_op = ? WHERE status = 'open' AND transactie = ?").run(wie, wanneer, txId);
}
function signaalRoute(fdb, r, d, nu) {
  const id = vraagId(d, 'id');
  const knop = String(d.knop || '');
  return D.transactie(fdb, function () {
    const s = fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(id);
    if (!magSignaal(r, s)) weiger(404, 'signaal niet gevonden');
    const opties = {};
    for (const k of ['categorie', 'leverancier', 'transactie', 'toelichting']) if (d[k] !== undefined && d[k] !== null && d[k] !== '') opties[k] = typeof d[k] === 'string' ? kort(d[k], 300) : d[k];
    return signaalAfhandelen(fdb, r, s, knop, opties, nu);
  });
}
function voorstelRoute(fdb, r, d, nu) {
  const id = Number(d.id);
  if (!Number.isSafeInteger(id) || id <= 0) weiger(400, 'id ontbreekt of is ongeldig');
  const keuze = d.keuze;
  if (!['bevestig', 'afwijs'].includes(keuze)) weiger(400, 'keuze is bevestig of afwijs');
  return D.transactie(fdb, function () {
    const v = fdb.db.prepare('SELECT v.*, t.entiteit FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.id = ?').get(id);
    if (!v || (!isEig(r) && (v.alleen_eigenaar || !magEntiteit(r, v.entiteit)))) weiger(404, 'voorstel niet gevonden');
    if (v.status === 'vervallen') weiger(409, 'dit voorstel verviel: ' + (B.VERVAL_TEKST[(json(v.details, {}) || {}).vervallen_reden] || B.VERVAL_TEKST.geen_match) + '; ververs de lijst');
    if (v.status !== 'open') weiger(409, 'het voorstel is al afgehandeld');
    const wanneer = nuIso(nu);
    const uit = { koppelingen: [] };
    if (keuze === 'bevestig') for (const fid of json(v.facturen, []) || []) uit.koppelingen.push(koppelIntern(fdb, r, v.transactie, fid, true, nu));
    fdb.db.prepare("UPDATE voorstel SET status = ?, afgehandeld_door = ?, afgehandeld_op = ? WHERE id = ? AND status = 'open'").run(keuze === 'bevestig' ? 'bevestigd' : 'afgewezen', r.wie, wanneer, v.id);
    D.audit(fdb, { wie: r.wie, wat: 'voorstel_' + keuze, object_soort: 'voorstel', object_id: String(v.id), entiteit: v.entiteit, wanneer });
    return uit;
  });
}

// ───────────────────────────── feitkaarten (wv1323) ─────────────────────────────

/*
 * David 26-10-2026 11:39: "Als ik ja geef op een koppeling, moet heel duidelijk zijn wat ik akkordeer … 'Dit IBAN is van bedrijf Z' (wat een
 * 100% koppeling oplevert qua entiteit, want uniek)"; 12:31 Ja (verse vingerafdruk) op "mag een vaak betaald rekeningnummer na jouw Ja het
 * nabellen vervangen?". Een kaart "Rekening …1234 is van <naam>" staat er alleen als:
 *   - een factuur in Beoordelen dat IBAN noemt en het nu nagebeld moet worden (verse IBAN-poort), het geen eigen rekening is en het IBAN nog
 *     bij geen enkele leverancier hoort (dan beslist de leverancier, niet een kaart);
 *   - de bankhistorie het draagt (facturen-validatie.ibanHistorie: ≥ 3 betalingen over ≥ 60 dagen, steeds dezelfde naam);
 *   - de naam op elke factuur met dat IBAN (of zijn leverancier) bij die banknaam past; noemt één factuur een andere naam ("Team Salaris"
 *     met de rekening van de Belastingdienst), dan geen kaart: nabellen (gemeten 26-10 op het FV2-archief: 33 van de 70 vreemde factuur-IBAN's
 *     krijgen een kaart, 6 vallen af op de naam);
 *   - David er nog niet over besliste (feit.sleutel; een afgewezen kaart komt niet terug).
 * De kaart wordt elke keer vers berekend; alleen Davids besluit wordt vastgelegd. Alleen de eigenaar ziet en beslist (de IBAN-poort is van hem).
 */
const FEIT_FACTUREN_MAX = 200;
function feitKaarten(fdb, r, nu) {
  if (!isEig(r)) return [];
  const ctx = kernCtx(fdb, nu);
  const eigen = new Set();
  for (const e of ctx.entiteiten) for (const i of e.ibans) eigen.add(K.ibanNorm(i));
  const entNamen = new Map(ctx.entiteiten.map((e) => [e.sleutel, e.naam_kort || e.naam]));
  const besloten = fdb.db.prepare('SELECT 1 FROM feit WHERE sleutel = ?');
  const bekend = fdb.db.prepare('SELECT 1 FROM leverancier_iban WHERE iban = ? LIMIT 1');
  // alleen historie die niet uit een upload van de smalle ingang komt: de bankluis, of een bestand van David of de machinekamer (diffreview
  // wv1323 MOET 1: anders kon een praktijkmanager met een verzonnen export zelf de historie maken en zo het nabellen omzeilen)
  const hist = fdb.db.prepare('SELECT t.boekdatum, t.bedrag_centen, t.tegenpartij_naam, t.entiteit FROM bank_transactie t LEFT JOIN bank_bestand b ON b.id = t.bestand ' +
    "WHERE t.tegenpartij_iban = ? AND t.bedrag_centen < 0 AND t.verwijderd_op IS NULL AND (t.bestand IS NULL OR (b.geupload_door NOT LIKE '%@%' " +
    "AND NOT EXISTS (SELECT 1 FROM gebruiker g WHERE g.ingang = 'fac' AND g.email = b.geupload_door)))");
  const levOpNaam = fdb.db.prepare('SELECT id, naam FROM leverancier WHERE genormaliseerd = ? ORDER BY aangemaakt_op, id LIMIT 2');
  const perIban = new Map();
  for (const x of fdb.db.prepare("SELECT id FROM factuur WHERE status = 'te_beoordelen' ORDER BY aangemaakt_op, id LIMIT " + FEIT_FACTUREN_MAX).all()) {
    const f = D.factuurVoorKern(fdb, x.id);
    if (!f) continue;
    const lev = leverancierKern(fdb, f.leverancier_id);
    // alleen als nabellen Bevestigen nu echt tegenhoudt (een al nagebelde factuur zonder leverancier niet; diffreview KAN 8)
    if (!K.magBevestigen(Object.assign({}, f, { status: 'te_beoordelen' }), { leverancier: lev, ctx }).redenen.some((x) => /nabellen/.test(x))) continue;
    const onbekend = K.ibanPoort(f, lev, ctx).onbekend;
    for (const iban of onbekend) {
      if (eigen.has(iban)) continue;
      if (!perIban.has(iban)) {
        let k = null;
        if (!besloten.get('iban:' + iban) && !bekend.get(iban)) {
          const h = V.ibanHistorie(hist.all(iban));
          if (h.ok) k = { iban, h, facturen: [], levs: new Map(), botsing: false };
        }
        perIban.set(iban, k);
      }
      const k = perIban.get(iban);
      if (!k) continue;
      const naam = lev ? lev.naam : f.leverancier_naam;
      // geen naam op de factuur en geen leverancier: niets in de gegevens verbindt de afzender met de rekeninghouder (diffreview ZOU 3). Wel
      // een kaart (Davids eigen voorbeeld, de huurfactuur, heeft geen herkende naam; geld naar een rekening met deze historie levert een
      // vervalser niets op), maar de kaart zegt het hardop: kijk op het stuk, Ja maakt deze naam de leverancier van deze factuur.
      if (!naam) k.zonderNaam = true;
      else if (!V.naamVerwant(naam, k.h.naam)) k.botsing = true;
      if (lev) k.levs.set(lev.id, lev.naam);
      k.facturen.push(f);
      if (onbekend.length > 1) k.meer = true;
    }
  }
  const uit = [];
  for (const k of perIban.values()) {
    // twee verschillende leveranciers voor één rekening, of een factuur met een andere naam: geen kaart, nabellen
    if (!k || k.botsing || k.levs.size > 1 || !k.facturen.length) continue;
    let leverancier = k.levs.size ? { id: [...k.levs.keys()][0], naam: [...k.levs.values()][0] } : null;
    const naam = leverancier ? leverancier.naam : kort(V.vollereNaam((k.facturen.find((f) => f.leverancier_naam) || {}).leverancier_naam, k.h.naam), 200);
    if (!leverancier) {
      const l = levOpNaam.all(K.normNaam(naam));
      if (l.length > 1) continue;   // twee leveranciers met dezelfde naam: niet raden
      if (l.length === 1) leverancier = { id: l[0].id, naam: l[0].naam };
    }
    const facturen = k.facturen.map((f) => ({ id: f.id, nummer: f.nummer, leverancier_naam: f.leverancier_naam, incl: f.incl, valuta: f.valuta, entiteit: f.entiteit }));
    const kaart = { iban: k.iban, naam: leverancier ? leverancier.naam : naam, bank_naam: k.h.naam, namen: k.h.namen, aantal: k.h.aantal, eerste: k.h.eerste,
      laatste: k.h.laatste, entiteiten: k.h.entiteiten.map((e) => entNamen.get(e) || e), facturen, leverancier_bestaat: !!leverancier, nog_onbekend: !!k.meer, zonder_naam: !!k.zonderNaam };
    // wat David akkordeert, vast: naam, leverancier en de facturen die vrijkomen; Ja geldt alleen voor precies deze kaart (diffreview MOET 2)
    const versie = D.sha256(Buffer.from(JSON.stringify([k.iban, kaart.naam, leverancier ? leverancier.id : null, k.h.naam, facturen.map((f) => f.id).sort()]), 'utf8')).slice(0, 16);
    uit.push({ sleutel: 'iban:' + k.iban, versie, soort: 'iban', rekening: eind4(k.iban), naam: kaart.naam, bank_naam: kaart.bank_naam, aantal: k.h.aantal, eerste: k.h.eerste,
      laatste: k.h.laatste, dagen: k.h.dagen, namen: k.h.namen, entiteiten: k.h.entiteiten, facturen, leverancier, uitleg: B.feitUitleg(kaart) });
  }
  return uit;
}
// Ja / Nee op een feitkaart. Ja vraagt een verse vingerafdruk (zelfde gewicht als Nagebeld: het vervangt het nabellen); Nee niet (dan blijft
// het nabellen, het veilige pad). Beide alleen als de kaart er nu nog precies zo staat (vers berekend in deze transactie).
function feitRoute(fdb, r, d, nu, o) {
  eisEigenaar(r);
  if (r.ingang === 'fac') weiger(403, 'een rekeningnummer zet David vrij, in zijn eigen app', { alleen_david: true });
  const sleutel = String(d.sleutel || '');
  if (!/^iban:[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(sleutel)) weiger(400, 'sleutel ontbreekt of is ongeldig');
  const keuze = d.keuze;
  if (!['bevestig', 'afwijs'].includes(keuze)) weiger(400, 'keuze is bevestig of afwijs');
  if (!/^[0-9a-f]{16}$/.test(String(d.versie || ''))) weiger(400, 'versie van de kaart ontbreekt');
  return D.transactie(fdb, function () {
    const k = feitKaarten(fdb, r, nu).find((x) => x.sleutel === sleutel);
    if (!k) {
      const b = fdb.db.prepare('SELECT status FROM feit WHERE sleutel = ?').get(sleutel);
      weiger(409, b ? 'over deze rekening besliste je al (' + (b.status === 'bevestigd' ? 'ja' : 'nee') + ')' : 'deze kaart geldt niet meer; ververs de lijst');
    }
    if (k.versie !== d.versie) weiger(409, 'de kaart is intussen veranderd (naam of facturen); bekijk hem opnieuw', { kaart_veranderd: true });
    if (keuze === 'bevestig') {
      if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
      o.versVerbruik();
    }
    const wanneer = nuIso(nu), iban = sleutel.slice('iban:'.length);
    const bewijs = { aantal: k.aantal, eerste: k.eerste, laatste: k.laatste, dagen: k.dagen, namen: k.namen, entiteiten: k.entiteiten, facturen: k.facturen.map((f) => f.id) };
    if (keuze === 'afwijs') {
      const id = D.voegToe(fdb, 'feit', { soort: 'iban', sleutel, iban: iban, factuur: k.facturen[0].id, naam: k.naam, bewijs, status: 'afgewezen', wie: r.wie, wanneer });
      D.audit(fdb, { wie: r.wie, wat: 'feit_afgewezen', object_soort: 'feit', object_id: String(id), na: { rekening: k.rekening, naam: k.naam }, wanneer });
      return { feit: 'afgewezen' };
    }
    let lev = k.leverancier, nieuw = false;
    if (!lev) {
      lev = { id: D.nieuwId(), naam: k.naam };
      D.voegToe(fdb, 'leverancier', { id: lev.id, naam: lev.naam, genormaliseerd: K.normNaam(lev.naam), aangemaakt_op: wanneer });
      nieuw = true;
    }
    const feitId = D.voegToe(fdb, 'feit', { soort: 'iban', sleutel, iban: iban, leverancier: lev.id, factuur: k.facturen[0].id, naam: k.naam, bewijs, status: 'bevestigd', wie: r.wie, wanneer });
    fdb.db.prepare("INSERT INTO leverancier_iban (leverancier, iban, toegevoegd_door, toegevoegd_op, bron, feit) VALUES (?, ?, ?, ?, 'bankhistorie', ?)").run(lev.id, iban, r.wie, wanneer, feitId);
    // de facturen die het nabellen tegenhield: leverancier zetten (als die nog leeg is), IBAN-poort opnieuw, besluitrij
    const ctx = kernCtx(fdb, nu), levKern = leverancierKern(fdb, lev.id);
    const facturen = [];
    for (const fk of k.facturen) {
      const f = D.factuurVoorKern(fdb, fk.id);
      if (!f || f.status !== 'te_beoordelen') continue;
      const levId = f.leverancier_id || lev.id;
      const lk = levId === lev.id ? levKern : leverancierKern(fdb, levId);
      const nieuwF = Object.assign({}, f, { leverancier_id: levId });
      // controles opnieuw zoals bij wijzig (een bestaande leverancier brengt bv. zijn mediaan mee; diffreview ZOU 7)
      const va = K.valideer(nieuwF, ctx, { leverancier: lk });
      const ip = K.ibanPoort(nieuwF, lk, ctx);
      const u = fdb.db.prepare('UPDATE factuur SET leverancier = ?, controles = ?, intern = ?, iban_nieuw = ?, ibans_onbekend = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND versie = ? AND status = \'te_beoordelen\'')
        .run(levId, JSON.stringify(va.controles), va.intern ? 1 : 0, ip.iban_nieuw ? 1 : 0, JSON.stringify(ip.onbekend), wanneer, f.id, f.versie);
      if (u.changes !== 1) weiger(409, 'een factuur is intussen gewijzigd; ververs de lijst');
      besluitRij(fdb, f.id, K.besluit('iban', 'bankhistorie', iban, 'mens', 'rekening ' + eind4(iban) + ' is van ' + lev.naam + ' (' + k.aantal + ' betalingen sinds ' + k.eerste +
        '); bevestigd in Bankcontrole' + (f.leverancier_id ? '' : '; leverancier gezet')), r.wie, wanneer);
      const na = D.factuurVoorKern(fdb, f.id);
      facturen.push({ id: f.id, bevestigen: K.magBevestigen(na, poortVoor(fdb, na, ctx)) });
    }
    D.audit(fdb, { wie: r.wie, wat: 'feit_bevestigd', object_soort: 'feit', object_id: String(feitId), na: { rekening: k.rekening, leverancier: lev.id, nieuwe_leverancier: nieuw,
      facturen: facturen.map((f) => f.id), aantal: k.aantal, eerste: k.eerste }, wanneer });
    return { feit: 'bevestigd', leverancier: { id: lev.id, naam: lev.naam, nieuw }, facturen };
  });
}

// ───────────────────────────── bankcontrole toepassen ─────────────────────────────

// wv1360 (diffreview MOET 2): rekeningen van betaaldiensten en derdengelden, alleen op naam ("X via Mollie", PayPal, Amazon Payments …): per
// rekening het aantal afschrijvingen met zo'n naam. De bankcontrole telt de post zelf niet mee, zodat één getypte naam een rekening niet
// tot verzamelrekening maakt. Niet op "verschillende namen": dat is juist het fraudepatroon (bekende naam op andermans rekening).
const VERZAMEL_EXTRA = /\b(amazon payments|alipay|unzer|ppro|nuvei|paysera|riverty|afterpay|worldpay|globalcollect|global collect|gc re|pay-nxt|unifiedpost|cm\.com|betaalverzoek|ticketingpayments)\b/i;
function verzamelNaam(n) { const t = String(n || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); return V.VERZAMEL_RE.test(t) || VERZAMEL_EXTRA.test(t); }
function verzamelTellingen(fdb) {
  const uit = {};
  for (const r of fdb.db.prepare('SELECT tegenpartij_iban AS iban, tegenpartij_naam AS naam, count(*) AS n FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0 ' +
    "AND tegenpartij_iban IS NOT NULL AND tegenpartij_naam IS NOT NULL AND tegenpartij_naam <> '' GROUP BY tegenpartij_iban, tegenpartij_naam").all()) {
    if (verzamelNaam(r.naam)) uit[r.iban] = (uit[r.iban] || 0) + r.n;
  }
  return uit;
}
/*
 * De bankcontrole (facturen-bank.js, puur) over de stand van de laatste 400 dagen, en de uitkomst toepassen in de lopende transactie:
 * automatische koppelingen, voorstellen, uitzonderingen, betaalspoor, nieuwe signalen en heropende gesluimerde signalen. Nooit twee keer
 * hetzelfde signaal (sleutel uniek).
 */
function bankcontroleToepassen(fdb, nu) {
  const vandaag = dagAmsterdam(nu), van = K.plusDagen(vandaag, -BANK_DAGEN), wanneer = nuIso(nu);
  const transacties = fdb.db.prepare('SELECT * FROM bank_transactie WHERE verwijderd_op IS NULL AND boekdatum >= ?').all(van).map((t) => Object.assign({}, t, {
    alleen_eigenaar: !!t.alleen_eigenaar, is_incasso: !!t.is_incasso }));
  const facturen = fdb.db.prepare("SELECT * FROM factuur WHERE status NOT IN ('geen_factuur') AND (factuurdatum IS NULL OR factuurdatum >= ? OR betaalspoor IN ('te_betalen','ingevoerd','incasso_verwacht'))")
    .all(K.plusDagen(van, -60)).map((f) => Object.assign({}, f, { patientkenmerk: !!f.patientkenmerk, alleen_eigenaar: !!f.alleen_eigenaar }));
  const ibans = {};
  for (const k of fdb.db.prepare('SELECT entiteit, iban FROM rekening').all()) (ibans[k.entiteit] = ibans[k.entiteit] || []).push(k.iban);
  const inv = {
    vandaag, transacties, facturen, leveranciers: leverancierLijst(fdb),
    uitzonderingen: fdb.db.prepare('SELECT * FROM uitzondering WHERE actief = 1').all(),
    entiteiten: entiteitenRijen(fdb).map((e) => ({ sleutel: e.sleutel, ibans: ibans[e.sleutel] || [] })),
    rekeningen: fdb.db.prepare('SELECT iban, entiteit, controle, bank_formaat, alleen_eigenaar FROM rekening').all(),
    koppelingen: fdb.db.prepare('SELECT transactie, factuur, bron, methode, volledig FROM koppeling').all().map((k) => ({ transactie: k.transactie, factuur: k.factuur, bron: k.bron,
      methode: k.methode, volledig: k.volledig === 1 ? true : k.volledig === 0 ? false : undefined })),
    opdrachten: fdb.db.prepare('SELECT id, factuur, entiteit, status, poging FROM opdracht WHERE factuur IS NOT NULL').all(),
    bestaandeSignalen: fdb.db.prepare('SELECT sleutel, status, sluimer_tot FROM signaal').all(),
    afgewezenVoorstellen: fdb.db.prepare("SELECT sleutel FROM voorstel WHERE status = 'afgewezen'").all().map((v) => v.sleutel),
    verzamelTel: verzamelTellingen(fdb), verzamelNaam,
    sepa: sepaVoorControle(fdb, nuIso(Date.parse(van + 'T00:00:00Z'))),   // wv1405: eigen batches (PmtInfId + totaal)
    afwijkend: afwijkendVoorControle(fdb, vandaag),   // wv1326: incasso's ruim boven hun gebruikelijke band (alleen na de startdatum)
  };
  const uit = B.bankcontrole(inv);
  const tel = { koppelingen: 0, voorstellen: 0, uitzonderingen: 0, betaald_gezien: 0, signalen: 0, heropend: 0 };
  const txMap = new Map(transacties.map((t) => [t.id, t]));
  for (const k of uit.koppelingen) tel.koppelingen += fdb.db.prepare('INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, alleen_eigenaar, wanneer) VALUES (?, ?, \'auto\', ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(k.transactie, k.factuur, k.methode || null, k.zekerheid == null ? null : Math.min(1, Math.max(0, k.zekerheid)), k.alleen_eigenaar ? 1 : 0, wanneer).changes;
  for (const v of uit.voorstellen) {
    const n = fdb.db.prepare('INSERT INTO voorstel (sleutel, transactie, facturen, methode, zekerheid, details, alleen_eigenaar, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sleutel) DO NOTHING')
      .run(v.sleutel, v.transactie, JSON.stringify(v.facturen), v.methode || null, v.zekerheid == null ? null : v.zekerheid,
        JSON.stringify({ alternatieven: v.alternatieven || [], tegenpartij_geborgd: !!v.tegenpartij_geborgd, verschil_centen: v.verschil_centen, creditnota: v.creditnota, reden: v.reden }),
        v.alleen_eigenaar ? 1 : 0, wanneer).changes;
    tel.voorstellen += n;
    // wv1317: een open voorstel krijgt de verse methode, zekerheid en details (alternatieven kunnen wegvallen); een vervallen voorstel dat de
    // controle weer precies zo voorstelt, gaat weer open (de stand veranderde terug), zonder de oude vervalreden (diffreview MOET 2)
    if (!n) {
      const vers = JSON.stringify({ alternatieven: v.alternatieven || [], tegenpartij_geborgd: !!v.tegenpartij_geborgd, verschil_centen: v.verschil_centen, creditnota: v.creditnota, reden: v.reden });
      fdb.db.prepare("UPDATE voorstel SET methode = ?, zekerheid = ?, details = ? WHERE sleutel = ? AND status = 'open'").run(v.methode || null, v.zekerheid == null ? null : v.zekerheid, vers, v.sleutel);
      const oud = fdb.db.prepare("SELECT id FROM voorstel WHERE sleutel = ? AND status = 'vervallen'").get(v.sleutel);
      if (oud && fdb.db.prepare("UPDATE voorstel SET status = 'open', afgehandeld_door = NULL, afgehandeld_op = NULL, methode = ?, zekerheid = ?, details = ? WHERE id = ? AND status = 'vervallen'")
        .run(v.methode || null, v.zekerheid == null ? null : v.zekerheid, vers, oud.id).changes) {
        tel.voorstellen_heropend = (tel.voorstellen_heropend || 0) + 1;
        D.audit(fdb, { wie: 'bankcontrole', wat: 'voorstel_heropend', object_soort: 'voorstel', object_id: String(oud.id), voor: { status: 'vervallen' }, na: { status: 'open' }, wanneer });
      }
    }
  }
  tel.voorstellen_vervallen = voorstellenHerbeoordelen(fdb, uit, txMap, facturen, wanneer);
  for (const u of uit.uitzonderingen) tel.uitzonderingen += fdb.db.prepare('UPDATE bank_transactie SET categorie = ?, uitzondering = ? WHERE id = ? AND categorie IS NULL')
    .run(u.categorie, u.uitzondering || null, u.transactie).changes;
  for (const b of uit.betaalspoor) {
    if (b.gebeurtenis === 'teruggeboekt') {
      const n = terugZet(fdb, { id: b.factuur, betaalspoor: b.van }, wanneer);
      if (n) D.audit(fdb, { wie: 'bankcontrole', wat: 'betaalspoor_teruggeboekt', object_soort: 'factuur', object_id: b.factuur, voor: { betaalspoor: b.van }, na: { betaalspoor: 'te_betalen' }, wanneer });
      tel.teruggeboekt = (tel.teruggeboekt || 0) + n;
      continue;
    }
    // de laatst geboekte afschrijving onder de nieuwe koppelingen (niet een terugboeking; diffreview wv1415 KLEIN 1)
    const tx = uit.koppelingen.filter((k) => k.factuur === b.factuur && k.methode !== 'sepa_terug').map((k) => txMap.get(k.transactie)).filter((t) => t && t.bedrag_centen < 0)
      .sort((x, y) => (x.boekdatum < y.boekdatum ? 1 : x.boekdatum > y.boekdatum ? -1 : 0))[0];
    tel.betaald_gezien += fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, betaald_gezien_op = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
      .run(b.naar, tx ? tx.boekdatum : vandaag, wanneer, b.factuur, b.van).changes;
  }
  // wv944: geen signaal over historie. Een signaal mét bankregels die allemaal vóór de startdatum liggen valt weg (archief, wel doorzoekbaar);
  // signalen zonder bankregels (factuursignalen) blijven altijd (Fable wv944 #1). Zonder startdatum: ongewijzigd.
  const start = startdatumVan(fdb);
  const historie = (s) => !!start && Array.isArray(s.transacties) && s.transacties.length > 0 &&
    s.transacties.every((id) => { const t = txMap.get(id); return !!t && t.boekdatum < start; });
  for (const s of uit.signalen) { if (historie(s)) { tel.historie_stil = (tel.historie_stil || 0) + 1; continue; } tel.signalen += signaalInvoegen(fdb, s, wanneer); }
  for (const h of uit.heropenen) tel.heropend += fdb.db.prepare("UPDATE signaal SET status = 'open', sluimer_tot = NULL WHERE sleutel = ? AND status = 'afgehandeld'").run(h.sleutel).changes;
  // wv2057: een factuursignaal (niet gezien / niet betaald / incasso niet gezien) waarvan de betaling alsnog binnenkwam en gekoppeld is, gaat
  // vanzelf dicht (afhandeling vanzelf_gezien, auditrij); anders bleef "ingevoerd, niet gezien" open staan naast een betaalde factuur.
  const netto = fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j');
  // Ook: "ingevoerd, niet gezien" van een factuur die niet meer op ingevoerd staat (Ongedaan, teruggeboekt) vervalt (afhandeling
  // niet_meer_ingevoerd); opnieuw invoeren is dan een nieuwe gebeurtenis met een eigen signaal (diffreview ZOU 4).
  const spoor = fdb.db.prepare('SELECT * FROM factuur WHERE id = ?');
  let verw = null;
  // natoets ZOU 1: Ongedaan en opnieuw ingevoerd tussen twee controles: de factuur staat weer op ingevoerd, maar met een andere verwachte datum
  const andereDatum = (s, fids) => {
    if (s.soort !== 'ingevoerd_niet_gezien' || fids.length !== 1) return false;
    const f = spoor.get(fids[0]), d = json(s.details, {}) || {};
    if (!f || f.betaalspoor !== 'ingevoerd' || !d.verwacht) return false;
    if (!verw) verw = { dekking: bankDekking(fdb), actief: bankActief(fdb, vandaag), sepa: inv.sepa, rekeningen: inv.rekeningen, vandaag };
    const v = B.betaalVerwachting(f, verw);
    return !!v && v.verwacht !== d.verwacht;
  };
  for (const s of fdb.db.prepare("SELECT id, facturen, entiteit, soort, details FROM signaal WHERE status = 'open' AND soort IN ('ingevoerd_niet_gezien','te_betalen_niet_betaald','incasso_niet_gezien')").all()) {
    const fids = json(s.facturen, []) || [];
    if (!fids.length) continue;
    const af = fids.every((id) => netto.get(id).j === 1) ? 'vanzelf_gezien'
      : s.soort === 'ingevoerd_niet_gezien' && (fids.every((id) => { const x = spoor.get(id); return !x || (x.betaalspoor !== 'ingevoerd' && x.betaalspoor !== 'betaald_gezien'); }) ||
        andereDatum(s, fids)) ? 'niet_meer_ingevoerd' : null;
    if (!af) continue;
    if (!fdb.db.prepare("UPDATE signaal SET status = 'afgehandeld', afhandeling = ?, wie = 'bankcontrole', wanneer = ? WHERE id = ? AND status = 'open'").run(af, wanneer, s.id).changes) continue;
    tel[af] = (tel[af] || 0) + 1;
    D.audit(fdb, { wie: 'bankcontrole', wat: 'signaal_' + af, object_soort: 'signaal', object_id: s.id, entiteit: s.entiteit || null, voor: { status: 'open' },
      na: { status: 'afgehandeld', soort: s.soort }, wanneer });
  }
  return tel;
}

/*
 * wv2057 (David 30-10-2026: "Zo ben jij de failsafe: heb ik de SEPA wel goed ingeladen? Heb ik een foutje gemaakt?"). Per eigen rekening de
 * laatste boekdatum die binnen is (facturen-bank.betaalVerwachting meet daarmee of de bank al voorbij de termijn is).
 */
function bankActief(fdb, vandaag) {
  return new Set(fdb.db.prepare('SELECT DISTINCT eigen_iban FROM bank_transactie WHERE verwijderd_op IS NULL AND bedrag_centen < 0 AND boekdatum >= ?')
    .all(K.plusDagen(vandaag, -BANK_DAGEN)).map((r) => K.ibanNorm(r.eigen_iban)).filter(Boolean));
}
function bankDekking(fdb) {
  const m = new Map();
  for (const r of fdb.db.prepare('SELECT eigen_iban, max(boekdatum) AS tot FROM bank_transactie WHERE verwijderd_op IS NULL GROUP BY eigen_iban').all()) {
    const i = K.ibanNorm(r.eigen_iban);
    if (i && r.tot && (!m.has(i) || r.tot > m.get(i))) m.set(i, r.tot);
  }
  return m;
}
/*
 * wv2057: het bericht aan David (de pod stuurt het in de app; server.js facturenBetaalMelding, alleen 07:00–23:00). Twee soorten, elk
 * één keer (grondwet 10; gemeld staat in meta BETAALMELDING_SLEUTEL, sleutel = signaal- of voorstelsleutel):
 *  - open signaal "ingevoerd, niet gezien" (de bank is voorbij de termijn en de betaling staat er niet), alleen als de factuur nog op
 *    ingevoerd staat; een hele SEPA-batch die ontbreekt wordt één regel;
 *  - open koppelvoorstel waarbij de bank het kenmerk of factuurnummer noemt maar het bedrag afwijkt (reden 'bedrag wijkt af' of 'kenmerk
 *    klopt, bedrag niet'), voor een factuur die David zelf betaalt (ingevoerd of te betalen).
 * Alleen wat de afgelopen BETAALMELDING_DAGEN speelde (geen oude historie bij de eerste ronde). Puur lezen; gemeld zetten doet
 * betaalMeldingGemeld nadat het bericht bezorgd is. → null of { tekst, sleutels, sleutel (alle sleutels samen; server.js hasht hem voor de dubbelcontrole van /bericht), aantal }.
 */
const BETAALMELDING_SLEUTEL = 'betaalmelding_gemeld', BETAALMELDING_DAGEN = 45, BETAALMELDING_BEWAAR = 400, BETAAL_ACHTER_WERKDAGEN = 5;
function betaalMeldingGemeldLees(fdb) { const g = json(D.metaLees(fdb, BETAALMELDING_SLEUTEL), {}); return g && typeof g === 'object' && !Array.isArray(g) ? g : {}; }
function betaalMeldingen(fdb, nu) {
  const vandaag = dagAmsterdam(nu), van = K.plusDagen(vandaag, -BETAALMELDING_DAGEN);
  const gemeld = betaalMeldingGemeldLees(fdb);
  const entNaam = new Map(entiteitenRijen(fdb).map((e) => [e.sleutel, e.naam_kort || e.naam || e.sleutel]));
  const levNaam = (f) => { const l = f.leverancier ? fdb.db.prepare('SELECT naam FROM leverancier WHERE id = ?').get(f.leverancier) : null; return (l && l.naam) || f.leverancier_naam || null; };
  const fq = fdb.db.prepare('SELECT * FROM factuur WHERE id = ?');
  const items = [];
  for (const s of fdb.db.prepare("SELECT * FROM signaal WHERE status = 'open' AND soort = 'ingevoerd_niet_gezien' ORDER BY aangemaakt_op").all()) {
    if (gemeld['sig:' + s.sleutel]) continue;
    const d = json(s.details, {}) || {}, fid = (json(s.facturen, []) || [])[0], f = fid ? fq.get(fid) : null;
    if (!f || f.betaalspoor !== 'ingevoerd' || !K.isIsoDatum(d.verwacht) || d.verwacht < van) continue;
    items.push({ sleutel: 'sig:' + s.sleutel, soort: 'niet_gezien', factuur: f.id, verwacht: d.verwacht, dekking: d.dekking || null, batch: d.batch || null,
      batch_regels: Number(d.batch_regels) || 0, centen: f.incl, leverancier: levNaam(f), entiteit: entNaam.get(f.entiteit) || f.entiteit, nummer: f.nummer || null });
  }
  const levIban = fdb.db.prepare('SELECT 1 FROM leverancier_iban WHERE leverancier = ? AND iban = ?');
  for (const v of fdb.db.prepare("SELECT v.*, t.boekdatum, t.bedrag_centen, t.tegenpartij_naam, t.tegenpartij_iban FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie " +
    "WHERE v.status = 'open' AND t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.boekdatum >= ? ORDER BY v.id").all(van)) {
    const det = json(v.details, {}) || {};
    if (gemeld['vs:' + v.sleutel] || !['bedrag wijkt af', 'kenmerk klopt, bedrag niet'].includes(det.reden)) continue;
    const fs = (json(v.facturen, []) || []).map((id) => fq.get(id)).filter(Boolean);
    if (!fs.length || !fs.some((f) => ['ingevoerd', 'te_betalen'].includes(f.betaalspoor))) continue;
    // diffreview ZOU 6: een factuurnummer alleen bewijst niet dat het geld naar deze leverancier ging (nummers komen bij meer leveranciers
    // voor); 'kenmerk klopt, bedrag niet' alleen melden als de rekening van de post die van de factuur is of bij de leverancier hoort
    const tegen = K.ibanNorm(v.tegenpartij_iban);
    if (det.reden !== 'bedrag wijkt af' && !(tegen && fs.some((f) => K.ibanNorm(f.iban) === tegen || (f.leverancier && levIban.get(f.leverancier, tegen))))) continue;
    const som = fs.reduce((x, f) => x + (Number(f.incl) || 0), 0);
    if (som === -v.bedrag_centen) continue;
    items.push({ sleutel: 'vs:' + v.sleutel, soort: 'afwijkend', facturen: fs.map((f) => f.id), boekdatum: v.boekdatum, betaald: -v.bedrag_centen, centen: som,
      tegenpartij: v.tegenpartij_naam ? String(v.tegenpartij_naam).slice(0, 80) : null,
      leverancier: levNaam(fs[0]), entiteit: entNaam.get(fs[0].entiteit) || fs[0].entiteit, nummer: fs.length === 1 ? fs[0].nummer || null : null, aantal: fs.length });
  }
  // diffreview ZOU 7: loopt de bank van een rekening een week na de termijn nog achter, dan kan de failsafe niets zien. Eén keer per betaling
  // melden dat hij niet te controleren is (per entiteit samengevoegd), met de vraag een nieuwe export te uploaden.
  const st = BETAAL_STATUS.map(() => '?').join(',');
  const inv = fdb.db.prepare("SELECT * FROM factuur WHERE betaalspoor = 'ingevoerd' AND entiteit <> 'prive' AND status IN (" + st + ')').all(...BETAAL_STATUS);
  if (inv.length) {
    const verw = { dekking: bankDekking(fdb), actief: bankActief(fdb, vandaag), sepa: sepaVoorControle(fdb, nuIso(Date.parse(K.plusDagen(vandaag, -BANK_DAGEN) + 'T00:00:00Z'))),
      rekeningen: fdb.db.prepare('SELECT iban, entiteit, controle FROM rekening').all(), vandaag };
    const zichtbaar = new Set(verw.rekeningen.filter((r) => r.controle === 1).map((r) => r.entiteit));
    for (const f of inv) {
      if (!zichtbaar.has(f.entiteit)) continue;
      const v = B.betaalVerwachting(f, verw);
      if (!v || v.stand !== 'bank_achter' || v.verwacht < van || B.werkdagenTussen(v.termijn_tot, vandaag) < BETAAL_ACHTER_WERKDAGEN) continue;
      const k = 'achter:' + f.id + '|' + v.verwacht;
      if (gemeld[k]) continue;
      items.push({ sleutel: k, soort: 'achter', factuur: f.id, verwacht: v.verwacht, dekking: v.dekking, centen: f.incl, entiteit: entNaam.get(f.entiteit) || f.entiteit });
    }
  }
  if (!items.length) return null;
  const tekst = B.betaalMeldingTekst(items, vandaag);
  const sleutels = items.map((x) => x.sleutel);
  return { tekst, sleutels, aantal: items.length, sleutel: sleutels.slice().sort().join('|') };   // server.js maakt er een hash van (geen crypto hier: CI-poort)
}
// Vóór het versturen: de sleutels als gemeld vastleggen (diffreview ZOU 5: liever één keer gemist dan twee keer gemeld; server.js zet ze
// terug met betaalMeldingTerug als de pod het bericht duidelijk weigerde). Wat ouder is dan BETAALMELDING_BEWAAR dagen gaat eruit.
function betaalMeldingGemeld(fdb, m, nu) {
  if (!m || !Array.isArray(m.sleutels) || !m.sleutels.length) return 0;
  const vandaag = dagAmsterdam(nu), grens = K.plusDagen(vandaag, -BETAALMELDING_BEWAAR);
  return D.transactie(fdb, function () {
    const g = betaalMeldingGemeldLees(fdb);
    for (const k of Object.keys(g)) if (!(typeof g[k] === 'string' && g[k] >= grens)) delete g[k];
    for (const k of m.sleutels) g[k] = vandaag;
    D.metaZet(fdb, BETAALMELDING_SLEUTEL, JSON.stringify(g));
    D.audit(fdb, { wie: 'bankcontrole', wat: 'betaalmelding', object_soort: 'meta', object_id: BETAALMELDING_SLEUTEL, na: { aantal: m.sleutels.length }, wanneer: nuIso(nu) });
    return m.sleutels.length;
  });
}
function betaalMeldingTerug(fdb, m) {
  if (!m || !Array.isArray(m.sleutels) || !m.sleutels.length) return 0;
  return D.transactie(fdb, function () {
    const g = betaalMeldingGemeldLees(fdb);
    let n = 0;
    for (const k of m.sleutels) if (g[k]) { delete g[k]; n++; }
    D.metaZet(fdb, BETAALMELDING_SLEUTEL, JSON.stringify(g));
    return n;
  });
}
/*
 * wv1326: kandidaten voor het signaal afwijkend_bedrag (facturen-validatie.afwijkendeIncassos). Eigen lezing, los van het venster van 400
 * dagen: de incasso's vanaf een jaar vóór de startdatum (een incasso ná de start krijgt zo altijd zijn hele jaar als band, ook bij een late
 * upload). Zonder startdatum niets (historie geeft nooit een signaal). Eigen rekeningen = alle rekeningen in Facturen; eigen namen = de
 * entiteiten met hun korte naam en aliassen (ook Privé). Bedragen waarvan David bij "Uitzoeken" zei dat ze niet klopten, tellen niet mee.
 */
function afwijkendVoorControle(fdb, vandaag) {
  const start = startdatumVan(fdb);
  if (!start) return [];
  // beoordeeld worden de incasso's van het venster van de bankcontrole (400 dagen), nooit van vóór de start (diffreview wv1326 KLEIN 6)
  const van = K.plusDagen(vandaag, -BANK_DAGEN), vanaf = start > van ? start : van;
  const txs = fdb.db.prepare('SELECT * FROM bank_transactie WHERE verwijderd_op IS NULL AND is_incasso = 1 AND bedrag_centen < 0 AND boekdatum >= ?')
    .all(K.plusDagen(vanaf, -366)).map((t) => Object.assign({}, t, { alleen_eigenaar: !!t.alleen_eigenaar, is_incasso: !!t.is_incasso }));
  const eigenNamen = [];
  for (const e of fdb.db.prepare('SELECT naam, naam_kort, aliassen FROM entiteit').all())
    eigenNamen.push(e.naam, e.naam_kort, ...((json(e.aliassen, []) || []).map((a) => (typeof a === 'string' ? a : a && a.tekst))));
  // al gemeld (elke status): die bankregel nooit opnieuw, ook niet als zijn groep later verandert (aanvullen van de incassant; diffreview KLEIN 7)
  const nietMeetellen = [], gemeld = new Set();
  for (const s of fdb.db.prepare("SELECT transacties, status, afhandeling FROM signaal WHERE soort = 'afwijkend_bedrag'").all()) {
    const ids = json(s.transacties, []) || [];
    ids.forEach((id) => gemeld.add(id));
    if (s.status === 'afgehandeld' && s.afhandeling === 'uitzoeken') nietMeetellen.push(...ids);
  }
  return V.afwijkendeIncassos(txs, { vanaf, vandaag, eigenIbans: fdb.db.prepare('SELECT iban FROM rekening').all().map((r) => r.iban),
    eigenNamen: eigenNamen.filter(Boolean), nietMeetellen }).filter((a) => !gemeld.has(a.tx.id));
}
/*
 * wv1317 (David 26-10-2026): elk open voorstel dat de controle nu niet meer zo voorstelt, gaat op 'vervallen' met de reden in details en een
 * auditrij — nooit stil weg, nooit 'afgewezen' (dat zei David niet). Alleen open voorstellen waar nog niemand op drukte; de UPDATE eist
 * status = 'open', dus een gelijktijdige klik van David wint of verliest netjes (409 "al afgehandeld").
 */
function voorstellenHerbeoordelen(fdb, uit, txMap, facturen, wanneer) {
  const nu = new Set(uit.voorstellen.map((v) => v.sleutel));
  const fMap = new Map(facturen.map((f) => [f.id, f]));
  const elders = new Set();
  for (const v of uit.voorstellen) for (const fid of v.facturen) elders.add(fid);
  const gekoppeld = { get: (id) => fdb.db.prepare('SELECT ' + NETTO_GEKOPPELD + ' AS j').get(id).j === 1 };   // wv1415: netto
  let n = 0;
  for (const v of fdb.db.prepare("SELECT v.*, t.entiteit FROM voorstel v LEFT JOIN bank_transactie t ON t.id = v.transactie WHERE v.status = 'open'").all()) {
    if (nu.has(v.sleutel)) continue;
    const tx = txMap.get(v.transactie);
    const fids = json(v.facturen, []) || [];
    const fs = fids.map((id) => fMap.get(id) || D.factuurVoorKern(fdb, id)).filter(Boolean);
    const redenen = [];
    if (!tx || fs.length !== fids.length) {
      const t = tx ? null : fdb.db.prepare('SELECT verwijderd_op FROM bank_transactie WHERE id = ?').get(v.transactie);
      // bankregel bestaat nog maar valt buiten het venster van de controle (400 dagen): niets over te zeggen, voorstel blijft open (ZOU 3)
      if (!tx && t && !t.verwijderd_op && fs.length === fids.length) continue;
      redenen.push('weg');
    }
    else {
      const ref = B.referentieStukken(tx);
      if (fs.some((f) => B.vooruitBetaald(tx, f))) redenen.push('vooruit');
      if (fs.some((f) => B.andereFactuurGenoemd(tx, f, ref))) redenen.push('ander_nummer');
      if (fids.some((id) => gekoppeld.get(id))) redenen.push('al_betaald');
      if (fids.some((id) => elders.has(id))) redenen.push('andere_betaling');
    }
    if (!redenen.length) redenen.push('geen_match');
    const details = Object.assign({}, json(v.details, {}) || {}, { vervallen_reden: redenen[0], vervallen_redenen: redenen });
    const u = fdb.db.prepare("UPDATE voorstel SET status = 'vervallen', afgehandeld_door = 'bankcontrole', afgehandeld_op = ?, details = ? WHERE id = ? AND status = 'open'")
      .run(wanneer, JSON.stringify(details), v.id);
    if (!u.changes) continue;
    n++;
    D.audit(fdb, { wie: 'bankcontrole', wat: 'voorstel_vervallen', object_soort: 'voorstel', object_id: String(v.id), entiteit: v.entiteit || null,
      voor: { status: 'open' }, na: { status: 'vervallen', redenen }, wanneer });
  }
  return n;
}
function signaalInvoegen(fdb, s, wanneer) {
  const lev = s.leverancier && fdb.db.prepare('SELECT 1 FROM leverancier WHERE id = ?').get(s.leverancier) ? s.leverancier : null;
  const details = Object.assign({}, s.details || {});
  for (const k of ['naam', 'eigen_iban', 'tegenpartij_iban', 'datum']) if (s[k] != null && details[k] === undefined) details[k] = k === 'naam' ? kort(s[k], 200) : s[k];
  return fdb.db.prepare('INSERT INTO signaal (id, sleutel, soort, titel, entiteit, leverancier, transacties, facturen, bedrag_centen, details, alleen_eigenaar, aangemaakt_op) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sleutel) DO NOTHING')
    .run(D.nieuwId(), s.sleutel, s.soort, s.titel, s.entiteit || null, lev, JSON.stringify(s.transacties || []), JSON.stringify(s.facturen || []),
      s.bedrag_centen == null ? null : s.bedrag_centen, JSON.stringify(details), s.alleen_eigenaar ? 1 : 0, wanneer).changes;
}
const TX_KOLOMMEN = ['id', 'bestand', 'rekening', 'entiteit', 'eigen_iban', 'boekdatum', 'bedrag_centen', 'valuta', 'tegenpartij_naam', 'tegenpartij_iban', 'omschrijving', 'kenmerk',
  'transactietype', 'is_incasso', 'incassant_id', 'machtiging', 'entry_ref', 'formaat', 'bankluis_sleutel', 'bestand_op', 'alleen_eigenaar', 'aangemaakt_op'];
function transactieInvoegen(fdb, t) {
  return fdb.db.prepare('INSERT INTO bank_transactie (' + TX_KOLOMMEN.join(', ') + ') VALUES (' + TX_KOLOMMEN.map(() => '?').join(', ') + ') ON CONFLICT (entry_ref) DO NOTHING')
    .run(...TX_KOLOMMEN.map((k) => (t[k] === undefined ? null : t[k] === true ? 1 : t[k] === false ? 0 : t[k]))).changes;
}

// ───────────────────────────── uploads ─────────────────────────────

/*
 * Bankbestand: herkennen en lezen (facturen-bank.js), Privé-regels weg zonder opslag, onbekende rekening of verkeerd formaat → het hele
 * bestand geweigerd (422, niets opgeslagen). Hetzelfde bestand nog eens (sha256) of dezelfde regels in een ander bestand (entry_ref uniek)
 * stapelen niets. Daarna de bankcontrole.
 *
 * wv944 (David 23-10-2026: bankexports "definitief" erin, voor validatie). Sinds deze stap:
 * - het ruwe bestand wordt bewaard als bron (bankbron/, alleen na een geslaagde lezing; ook bij een herhaalde upload), nooit via een route;
 * - een regel vóór meta.startdatum is archief: alleen-eigenaar, geen signaal (bankcontroleToepassen), wel doorzoekbaar en in de validatie;
 * - salaris- en personeelsregels op een zakelijke rekening zijn gewone regels, zichtbaar zoals elke boeking (David 23-10-2026 16:37, wv945:
 *   "Salarisbetalingen mogen gewoon ingezien, Cynthia boekt ze notabene in"); de POT-rekening en Privé blijven alleen-eigenaar via de rekening;
 * - een regel die er al is (FV2-archief, eerdere upload) krijgt alleen lege velden aangevuld (incassant, machtiging), nooit overschreven;
 * - saldocontrole en periode per bestand in bank_bestand; modus 'historisch' (machinekamer, tools/facturen-historie.js) eist een startdatum;
 * - droogloop tegen dubbel inlezen (Fable wv944 #2/#3): regels vóór de start die "mogelijk al binnen" zijn onder een andere entry_ref
 *   (zelfde rekening, dag, bedrag, tegenpartij) en entry_ref-bases met een ander aantal -n dan in de database. Boven de drempel geweigerd
 *   (409) tot de machinekamer het nagerekend heeft (opties.forceer). Na de start doet het signaal mogelijk_dubbel_geupload dat werk al.
 * opties: { modus: 'upload'|'historisch', herkomst, forceer, droog, koppel (wv951: zie historieKoppeling) }.
 */
function startdatumVan(fdb) { const v = D.metaLees(fdb, 'startdatum'); return v && K.isIsoDatum(v) ? v : null; }
const DUBBEL_DREMPEL = (n) => Math.max(2, Math.ceil(n * 0.02));
// zelfde tegenpartij: IBAN als beide er een hebben, anders de naam (wv951: een ABN-incasso heeft in de TAB-export geen IBAN, in FV2 wel)
function zelfdeTegenpartij(x, t) {
  const a = K.ibanNorm(x.tegenpartij_iban), b = K.ibanNorm(t.tegenpartij_iban);
  if (a && b) return a === b;
  const na = K.normNaam(x.tegenpartij_naam), nb = K.normNaam(t.tegenpartij_naam);
  return na ? na === nb : !a && !b && !nb;
}
function historieCheck(fdb, transacties, start) {
  const bestaat = fdb.db.prepare('SELECT 1 FROM bank_transactie WHERE entry_ref = ?');
  const perBasis = new Map();
  let al = 0;
  const nieuw = [];
  for (const t of transacties) {
    perBasis.set(t.ref_basis, (perBasis.get(t.ref_basis) || 0) + 1);
    if (bestaat.get(t.entry_ref)) al++; else nieuw.push(t);
  }
  const telBasis = fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE entry_ref = ? OR entry_ref GLOB ?");
  let suffix = 0;
  for (const [b, n] of perBasis) { const d = Number(telBasis.get(b, b + '-*').n); if (d > 0 && d !== n) suffix++; }
  const zelfde = fdb.db.prepare('SELECT entry_ref, tegenpartij_iban, tegenpartij_naam FROM bank_transactie WHERE eigen_iban = ? AND boekdatum = ? AND bedrag_centen = ? AND verwijderd_op IS NULL');
  let dubbel = 0;
  for (const t of nieuw) {
    // alleen historie (vóór de start): na de start doet het signaal mogelijk_dubbel_geupload dit werk, en zonder startdatum blijft het
    // gedrag van vóór wv944 (Fable diffreview wv944 #2)
    if (!start || t.boekdatum >= start) continue;
    if (zelfde.all(t.eigen_iban, t.boekdatum, t.bedrag_centen).some((x) => x.entry_ref !== t.entry_ref && zelfdeTegenpartij(x, t))) dubbel++;
  }
  return { regels: transacties.length, al_bekend: al, nieuw: nieuw.length, mogelijk_dubbel: dubbel, suffix_verschil: suffix,
    drempel: DUBBEL_DREMPEL(nieuw.length), boven_drempel: dubbel > DUBBEL_DREMPEL(nieuw.length) };
}
// wv951: een historieregel die al binnen is onder een andere entry_ref (FV2 las de ABN-rekeningen vanaf april 2026 uit een ander formaat)
// één-op-één koppelen aan een bestaande regel met dezelfde rekening, boekdatum, bedrag en tegenpartij, waarvan de eigen sleutel niet in dit
// bestand staat (anders is die regel al door een andere regel van dit bestand gedekt). Alleen vóór de start. Een gekoppelde regel wordt niet
// ingevoegd: de bestaande regel krijgt de sleutel van het bestand (dan is een latere export van dezelfde periode gewoon "al bekend") en
// hooguit incassant-id en machtiging erbij. Meer dan één kandidaat: eerst op gelijk kenmerk; blijft het onbeslist, dan wel koppelen
// (anders dubbel) maar niet aanvullen (review wv951: geen kruislingse machtiging). → Map(entry_ref uit het bestand → { ref, aanvul })
function historieKoppeling(fdb, transacties, start) {
  const uit = new Map();
  if (!start) return uit;
  const inBestand = new Set(transacties.map((t) => t.entry_ref));
  const bestaat = fdb.db.prepare('SELECT 1 FROM bank_transactie WHERE entry_ref = ?');
  const zelfde = fdb.db.prepare('SELECT entry_ref, tegenpartij_iban, tegenpartij_naam, kenmerk FROM bank_transactie WHERE eigen_iban = ? AND boekdatum = ? AND bedrag_centen = ? AND verwijderd_op IS NULL ORDER BY entry_ref');
  const gebruikt = new Set();
  for (const t of transacties) {
    if (t.boekdatum >= start || bestaat.get(t.entry_ref)) continue;
    const alle = zelfde.all(t.eigen_iban, t.boekdatum, t.bedrag_centen)
      .filter((y) => y.entry_ref !== t.entry_ref && !inBestand.has(y.entry_ref) && zelfdeTegenpartij(y, t));
    const vrij = alle.filter((y) => !gebruikt.has(y.entry_ref));
    if (!vrij.length) continue;
    let x = vrij[0], aanvul = alle.length === 1;
    if (!aanvul && t.kenmerk) {
      const km = vrij.filter((y) => y.kenmerk === t.kenmerk);
      if (km.length === 1 && alle.filter((y) => y.kenmerk === t.kenmerk).length === 1) { x = km[0]; aanvul = true; }
    }
    gebruikt.add(x.entry_ref);
    uit.set(t.entry_ref, { ref: x.entry_ref, aanvul });
  }
  return uit;
}
/*
 * wv1329: de ABN-historie (overzetting van de PDF-afschriften, modus historisch) overlapt met regels die al binnen zijn onder een andere
 * sleutel (ABN-TAB vanaf april 2025, FV2-archief vanaf januari 2025). Die regels blijven zoals ze zijn, met hun eigen sleutel: een latere
 * TAB-export van dezelfde dagen moet "al bekend" blijven (koppelen à la wv951 zou de TAB-sleutel vervangen en de volgende upload laten
 * stapelen). Afdekken = één-op-één op rekening, boekdatum en bedrag; eerst met dezelfde tegenpartij, dan zonder (de tegenpartij staat in
 * de TAB soms niet als IBAN of naam, bij een betaalautomaat). Gemeten 26-10-2026: per rekening vallen alle bestaande regels in het venster
 * van het bestand samen met evenveel regels van het bestand. Wat overblijft wordt nagekeken: een bestaande regel binnen de periode van het
 * bestand zonder tegenhanger, of een nieuwe regel op of na de eerste bestaande dag van die rekening, betekent dat bestand en database niet
 * hetzelfde zeggen → weigeren (behalve met --forceer). → { dek: Map(entry_ref bestand → bestaande entry_ref), in_venster, bestaand_rest }
 */
function historieDekking(fdb, transacties) {
  const dek = new Map();
  const perRek = new Map();
  for (const t of transacties) { if (!perRek.has(t.eigen_iban)) perRek.set(t.eigen_iban, []); perRek.get(t.eigen_iban).push(t); }
  let in_venster = 0, bestaand_rest = 0;
  const bestaat = fdb.db.prepare('SELECT 1 FROM bank_transactie WHERE entry_ref = ?');
  for (const [iban, lijst] of perRek) {
    const nieuw = lijst.filter((t) => !bestaat.get(t.entry_ref));
    const datums = lijst.map((t) => t.boekdatum).sort();
    const van = datums[0], tot = datums[datums.length - 1];
    const eigen = new Set(lijst.map((t) => t.entry_ref));
    const best = fdb.db.prepare('SELECT entry_ref, boekdatum, bedrag_centen, tegenpartij_iban, tegenpartij_naam FROM bank_transactie WHERE eigen_iban = ? AND boekdatum >= ? AND boekdatum <= ? AND verwijderd_op IS NULL ORDER BY boekdatum, entry_ref')
      .all(iban, van, tot).filter((x) => !eigen.has(x.entry_ref));
    const vrij = new Map();
    for (const x of best) { const k = x.boekdatum + '|' + x.bedrag_centen; if (!vrij.has(k)) vrij.set(k, []); vrij.get(k).push(x); }
    for (const strikt of [true, false]) {
      for (const t of nieuw) {
        if (dek.has(t.entry_ref)) continue;
        const k = t.boekdatum + '|' + t.bedrag_centen, l = vrij.get(k);
        if (!l || !l.length) continue;
        const i = strikt ? l.findIndex((x) => zelfdeTegenpartij(x, t)) : 0;
        if (i < 0) continue;
        dek.set(t.entry_ref, l[i].entry_ref);
        l.splice(i, 1);
      }
    }
    for (const l of vrij.values()) bestaand_rest += l.length;
    const eerste = fdb.db.prepare('SELECT min(boekdatum) AS d FROM bank_transactie WHERE eigen_iban = ? AND verwijderd_op IS NULL').get(iban).d;
    if (eerste) in_venster += nieuw.filter((t) => !dek.has(t.entry_ref) && t.boekdatum >= eerste).length;
  }
  return { dek, in_venster, bestaand_rest };
}
function bankVan(formaat) { return formaat === 'ing_csv' ? 'ING' : formaat === 'triodos_csv' ? 'TRIODOS' : 'ABN'; }
function saldoKort(saldo) {
  const uit = {};
  for (const [iban, x] of Object.entries(saldo || {})) uit[eind4(iban)] = x;
  return uit;
}
function verwerkBankbestand(fdb, r, bytes, naam, nu, opties) {
  opties = opties || {};
  const modus = opties.modus === 'historisch' ? 'historisch' : 'upload';
  const start = startdatumVan(fdb);
  if (modus === 'historisch' && !start) weiger(409, 'zet eerst de startdatum van Facturen (historie zonder startdatum zou duizenden signalen geven)');
  if (modus === 'historisch') eisEigenaar(r);
  const sha = D.sha256(bytes);
  const rekeningen = fdb.db.prepare('SELECT id, iban, entiteit, bank_formaat, controle, alleen_eigenaar FROM rekening').all();
  const lees = B.leesBankbestand(new Uint8Array(bytes), { rekeningen });
  if (!lees.ok) weiger(422, lees.uitleg, { code: lees.fout });
  // wv1329: de ABN-historie is geen bankexport maar een overzetting van afschriften; alleen de machinekamer leest hem in
  if (B.HISTORIE_FORMATEN[lees.formaat] && modus !== 'historisch') weiger(422, 'dit historiebestand leest alleen de machinekamer in', { code: 'alleen_historisch' });
  if (!isEig(r) && lees.transacties.some((t) => t.alleen_eigenaar || !magEntiteit(r, t.entiteit))) weiger(403, 'dit bestand bevat een rekening die alleen de eigenaar mag inlezen');
  // het ruwe bestand als bron (idempotent; ook als het bestand al bekend is: dan ontbrak de bron misschien nog). Alleen voor de eigenaar:
  // een upload via de smalle ingang (F6) houdt de belofte van F2 dat het ruwe bestand niet bewaard wordt (Fable diffreview wv944 #13).
  const bron = opties.droog || !isEig(r) ? null : D.bronSchrijf(fdb, Buffer.from(bytes));
  try { return verwerkBankbestandTx(fdb, r, lees, sha, bron, naam, nu, opties, modus, start, rekeningen); }
  catch (e) {
    // geweigerd of mislukt: een net geschreven bron zonder bank_bestand weer weg (geen wees offsite; diffreview #3)
    if (bron && bron.nieuw && !fdb.db.prepare('SELECT 1 FROM bank_bestand WHERE sha256 = ?').get(sha)) { try { fs.unlinkSync(D.bronPad(fdb, sha)); } catch (e2) {} }
    throw e;
  }
}
function verwerkBankbestandTx(fdb, r, lees, sha, bron, naam, nu, opties, modus, start, rekeningen) {
  return D.transactie(fdb, function () {
    const bekend = fdb.db.prepare('SELECT id FROM bank_bestand WHERE sha256 = ?').get(sha);
    if (bekend) {
      if (bron) fdb.db.prepare('UPDATE bank_bestand SET bron_bewaard = 1 WHERE id = ? AND bron_bewaard = 0').run(bekend.id);
      return { soort: 'bank', al_bekend: true, nieuw: 0, bestand: bekend.id };
    }
    const check = historieCheck(fdb, lees.transacties, start);
    // --koppel (wv951, alleen historisch): gekoppelde regels tellen niet meer als mogelijk dubbel; de rest moet onder de drempel blijven
    // wv1329: de ABN-historie dekt af in plaats van te koppelen (bestaande sleutels blijven); --koppel doet daar niets extra
    const hist = !!B.HISTORIE_FORMATEN[lees.formaat];
    const dekking = hist ? historieDekking(fdb, lees.transacties) : null;
    const koppel = !hist && opties.koppel && modus === 'historisch' ? historieKoppeling(fdb, lees.transacties, start) : null;
    if (dekking) {
      check.te_dekken = dekking.dek.size;
      check.in_venster = dekking.in_venster;
      check.bestaand_rest = dekking.bestaand_rest;
      check.drempel = 0;
      check.boven_drempel = dekking.in_venster + dekking.bestaand_rest > 0;
    }
    if (koppel) {
      check.te_koppelen = koppel.size;
      check.onbeslist = [...koppel.values()].filter((x) => !x.aanvul).length;
      check.drempel = DUBBEL_DREMPEL(check.nieuw - koppel.size);
      check.boven_drempel = check.mogelijk_dubbel - koppel.size > check.drempel;
    }
    const kort_ = { soort: 'bank', formaat: lees.formaat, modus, periode: lees.periode, saldo: saldoKort(lees.saldo), check,
      rekeningen: Object.entries(lees.per_rekening).map(([iban, n]) => ({ rekening: eind4(iban), aantal: n })), prive_weggegooid: lees.prive_weggegooid };
    if (opties.droog) return Object.assign({ droog: true }, kort_);
    // wv1329 (review #3): bij een overzetting uit PDF's is de saldoketen de bewaking tegen een verkeerd gelezen bedrag; breekt hij, niet inlezen
    if (hist && !opties.forceer && Object.values(lees.saldo || {}).some((x) => !x.gecontroleerd || !x.sluit)) {
      weiger(409, 'de saldoketen van dit historiebestand sluit niet; de machinekamer rekent het na', { code: 'saldo_sluit_niet', saldo: saldoKort(lees.saldo) });
    }
    if (check.boven_drempel && !opties.forceer) {
      // review wv1329 #6: regels na de laatste bestaande dag horen niet geforceerd binnen (een latere TAB zou ze opnieuw geven): bestand inkorten
      if (dekking) weiger(409, 'bestand en database sluiten niet op elkaar aan (' + dekking.in_venster + ' nieuwe regels binnen de bestaande periode, ' + dekking.bestaand_rest + ' bestaande regels zonder tegenhanger); de machinekamer rekent het na (regels na de laatste bestaande dag: bestand daar inkorten, niet forceren)', { code: 'dekking_sluit_niet', check });
      weiger(409, 'dit bestand lijkt voor een deel al binnen te zijn onder een andere sleutel (' + check.mogelijk_dubbel + ' regels); de machinekamer rekent het na',
        { code: 'mogelijk_dubbel', check });
    }
    const wanneer = nuIso(nu), bid = D.nieuwId();
    const perId = new Map(rekeningen.map((k) => [K.ibanNorm(k.iban), k]));
    D.voegToe(fdb, 'bank_bestand', { id: bid, sha256: sha, formaat: lees.opslag_formaat || lees.formaat, naam: kort(naam, 255), aantal: lees.transacties.length, prive_weggegooid: lees.prive_weggegooid,
      per_rekening: lees.per_rekening, geupload_door: r.wie, geupload_op: wanneer, modus, bank: bankVan(lees.formaat),
      periode_van: lees.periode ? lees.periode.van : null, periode_tot: lees.periode ? lees.periode.tot : null, saldo: lees.saldo || null,
      bron_bewaard: bron ? 1 : 0, herkomst: kort(opties.herkomst || (modus === 'historisch' ? 'machinekamer' : 'app-upload'), 300) });
    const aanvul = fdb.db.prepare('UPDATE bank_transactie SET incassant_id = coalesce(incassant_id, ?), machtiging = coalesce(machtiging, ?) WHERE entry_ref = ? AND (incassant_id IS NULL OR machtiging IS NULL)');
    const herkey = fdb.db.prepare('UPDATE bank_transactie SET entry_ref = ? WHERE entry_ref = ?');
    const sleutels = [];
    let nieuw = 0, aangevuld = 0, archief = 0, gekoppeld = 0, gedekt = 0;
    for (const t of lees.transacties) {
      if (dekking && dekking.dek.has(t.entry_ref)) { gedekt++; continue; }   // al binnen onder een andere sleutel: niets aan veranderen
      if (koppel && koppel.has(t.entry_ref)) {
        const x = koppel.get(t.entry_ref);
        if (herkey.run(t.entry_ref, x.ref).changes !== 1) throw new Error('koppelen: bestaande regel niet gevonden');
        sleutels.push([x.ref, t.entry_ref]);
        gekoppeld++;
        if (x.aanvul && (t.incassant_id || t.machtiging)) aangevuld += aanvul.run(t.incassant_id || null, t.machtiging || null, t.entry_ref).changes;
        continue;
      }
      const k = perId.get(t.eigen_iban);
      const hist = !!start && t.boekdatum < start;
      const rij = Object.assign({}, t, { id: D.nieuwId(), bestand: bid, rekening: k.id, bankluis_sleutel: null, bestand_op: wanneer, aangemaakt_op: wanneer,
        alleen_eigenaar: !!(t.alleen_eigenaar || hist) });
      const n = transactieInvoegen(fdb, rij);
      nieuw += n;
      if (n) { if (hist) archief++; }
      else if (t.incassant_id || t.machtiging) aangevuld += aanvul.run(t.incassant_id || null, t.machtiging || null, t.entry_ref).changes;
    }
    for (const iban of Object.keys(lees.per_rekening)) fdb.db.prepare('UPDATE rekening SET laatste_invoer_op = ? WHERE iban = ?').run(wanneer, iban);
    const controle = bankcontroleToepassen(fdb, nu);
    D.audit(fdb, { wie: r.wie, wat: modus === 'historisch' ? 'bankbestand_historisch' : 'bankbestand_upload', object_soort: 'bank_bestand', object_id: bid,
      na: { formaat: lees.formaat, aantal: lees.transacties.length, nieuw, archief, aangevuld, prive_weggegooid: lees.prive_weggegooid,
        mogelijk_dubbel: check.mogelijk_dubbel, suffix_verschil: check.suffix_verschil, geforceerd: !!(check.boven_drempel && opties.forceer), gekoppeld, gedekt: dekking ? gedekt : undefined,
        sleutels: sleutels.length ? sleutels : undefined }, wanneer });
    return Object.assign(kort_, { bestand: bid, aantal: lees.transacties.length, nieuw, al_bekend_regels: lees.transacties.length - nieuw - gekoppeld - gedekt, gekoppeld, gedekt, aangevuld, archief,
      bron_bewaard: !!bron, controle });
  });
}

/*
 * FV2-archief (wv944): de zakelijke bankregels en facturen uit Supabase facturen.* (FV2, juli–augustus 2026, bankregels vanaf januari 2025)
 * als archief in Facturen. Eén bank_bestand per entiteit (modus archief_fv2, sha256 over de canonieke regels, formaat van de rekening,
 * bestand_op = het FV2-moment, zodat bij "Is hetzelfde" een latere upload weggaat en de archiefrij blijft; Fable #11). entry_ref van FV2
 * blijft (zelfde algoritme als de parsers). Alles alleen-eigenaar en vóór de startdatum: geen signalen. Privé en de POT (bankluis) nooit.
 * inv = { entiteit, regels: [{ entry_ref, boekdatum, bedrag (euro), tegenpartij_iban, tegenpartij_naam, omschrijving, betalingskenmerk,
 * transactietype, is_incasso }], facturen: [{ extern_id, leverancier_naam, factuurnummer, factuurdatum, vervaldatum, bedrag_incl (euro), valuta,
 * iban_begunstigde, betalingskenmerk, betaalwijze, status }], herkomst, bestand_op }
 */
function archiefInvoeren(fdb, r, inv, nu) {
  eisEigenaar(r);
  const start = startdatumVan(fdb);
  if (!start) weiger(409, 'zet eerst de startdatum van Facturen');
  const ent = String(inv && inv.entiteit || '');
  if (!ent || ent === 'prive') weiger(400, 'archief alleen voor zakelijke entiteiten');
  if (!fdb.db.prepare('SELECT 1 FROM entiteit WHERE sleutel = ?').get(ent)) weiger(400, 'onbekende entiteit');
  // bankregels alleen voor een rekening met bankexport; de POT (bankluis) krijgt alleen zijn facturen (de bankluis is daar de bron)
  const metRegels = (inv.regels || []).length > 0;
  const rk = fdb.db.prepare("SELECT * FROM rekening WHERE entiteit = ? AND controle = 1 AND bank_formaat <> 'bankluis'").all(ent);
  if (metRegels && rk.length !== 1) weiger(400, 'archiefregels alleen voor een entiteit met precies één rekening met bankexport (niet de bankkoppeling)');
  const k = rk[0] || null, wanneer = nuIso(nu);
  const ct = (e) => { const v = Number(e); if (!Number.isFinite(v)) return null; const c = Math.round(v * 100); return Object.is(c, -0) ? 0 : c; };
  const regels = (inv.regels || []).map((x) => ({
    entry_ref: String(x.entry_ref || ''), boekdatum: String(x.boekdatum || '').slice(0, 10), bedrag_centen: ct(x.bedrag),
    tegenpartij_iban: K.ibanNorm(x.tegenpartij_iban) || null, tegenpartij_naam: kort(x.tegenpartij_naam, 200) || null, omschrijving: kort(x.omschrijving, 200) || null,
    kenmerk: kort(x.betalingskenmerk, 200) || null, transactietype: kort(x.transactietype, 60) || null, is_incasso: !!x.is_incasso,
  })).filter((x) => /^[0-9a-f]{20}(-\d+)?$/.test(x.entry_ref) && K.isIsoDatum(x.boekdatum) && x.bedrag_centen !== null)
    .sort((a, b) => (a.entry_ref < b.entry_ref ? -1 : 1));
  const weg = (inv.regels || []).length - regels.length;
  const facturen = (inv.facturen || []).filter((f) => f && f.extern_id);
  const sha = D.sha256(Buffer.from(JSON.stringify({ entiteit: ent, regels, facturen: facturen.map((f) => f.extern_id).sort() })));
  return D.transactie(fdb, function () {
    if (metRegels && fdb.db.prepare('SELECT 1 FROM bank_bestand WHERE sha256 = ?').get(sha)) return { entiteit: ent, al_bekend: true, nieuw: 0 };
    let bid = null, nieuw = 0, na_start = 0, check = null;
    if (metRegels) {
    const datums = regels.map((x) => x.boekdatum).sort();
    bid = D.nieuwId();
    check = historieCheck(fdb, regels.map((x) => Object.assign({ eigen_iban: K.ibanNorm(k.iban), ref_basis: B.refBasis(x.entry_ref) }, x)), start);
    D.voegToe(fdb, 'bank_bestand', { id: bid, sha256: sha, formaat: k.bank_formaat, naam: kort('FV2-archief ' + ent, 255), aantal: regels.length, prive_weggegooid: 0,
      per_rekening: { [K.ibanNorm(k.iban)]: regels.length }, geupload_door: r.wie, geupload_op: wanneer, modus: 'archief_fv2', bank: k.bank || bankVan(k.bank_formaat),
      periode_van: datums[0] || null, periode_tot: datums[datums.length - 1] || null, saldo: null, bron_bewaard: 0,
      herkomst: kort(inv.herkomst || 'FV2 Supabase facturen.bank_transactions', 300) });
    const op = inv.bestand_op && /^\d{4}-\d\d-\d\dT/.test(inv.bestand_op) ? inv.bestand_op : wanneer;
    for (const x of regels) {
      if (x.boekdatum >= start) na_start++;
      nieuw += transactieInvoegen(fdb, Object.assign({}, x, { id: D.nieuwId(), bestand: bid, rekening: k.id, entiteit: ent, eigen_iban: K.ibanNorm(k.iban), valuta: 'EUR',
        incassant_id: null, machtiging: null, formaat: k.bank_formaat, bankluis_sleutel: null, bestand_op: op, alleen_eigenaar: true, aangemaakt_op: wanneer }));
    }
    }
    let fnieuw = 0;
    const fins = fdb.db.prepare('INSERT INTO factuur_archief (id, herkomst, extern_id, entiteit, leverancier_naam, nummer, factuurdatum, vervaldatum, incl, valuta, iban, kenmerk, betaalwijze, status, alleen_eigenaar, aangemaakt_op) ' +
      "VALUES (?, 'fv2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (herkomst, extern_id) DO NOTHING");
    for (const f of facturen) {
      const iban = K.ibanNorm(f.iban_begunstigde);
      fnieuw += fins.run(D.nieuwId(), kort(f.extern_id, 64), ent, kort(f.leverancier_naam, 200), kort(f.factuurnummer, 100), K.isIsoDatum(f.factuurdatum) ? f.factuurdatum : null,
        K.isIsoDatum(f.vervaldatum) ? f.vervaldatum : null, ct(f.bedrag_incl), /^[A-Z]{3}$/.test(f.valuta || '') ? f.valuta : 'EUR',
        iban && /^[A-Z0-9]{15,34}$/.test(iban) ? iban : null, kort(f.betalingskenmerk, 100), kort(f.betaalwijze, 30), kort(f.status, 40), wanneer).changes;
    }
    const controle = bankcontroleToepassen(fdb, nu);
    D.audit(fdb, { wie: r.wie, wat: 'archief_fv2', object_soort: bid ? 'bank_bestand' : 'factuur_archief', object_id: bid || ent, entiteit: ent,
      na: { regels: regels.length, nieuw, overgeslagen: weg, facturen: fnieuw, na_start, mogelijk_dubbel: check ? check.mogelijk_dubbel : 0 }, wanneer });
    return { entiteit: ent, bestand: bid, regels: regels.length, nieuw, overgeslagen: weg, na_start, facturen: fnieuw, check, controle };
  });
}

// ───────────────────────────── validatie en zoeken (wv944) ─────────────────────────────

/*
 * Factuurvalidatie op de bankhistorie (facturen-validatie.js, puur), op aanvraag. Rol en entiteitfilter zoals overal: een praktijkmanager
 * ziet geen alleen-eigenaar-regels (POT, historie) en geen archieffacturen. Salarisregels op een zakelijke rekening zijn gewone regels (wv945).
 */
function validatieInvoer(fdb, r) {
  const [tf, tp] = eigenaarFilter(r, 't');
  let txs = fdb.db.prepare('SELECT t.id, t.entiteit, t.eigen_iban, t.boekdatum, t.bedrag_centen, t.tegenpartij_naam, t.tegenpartij_iban, t.omschrijving, t.kenmerk, t.transactietype, ' +
    't.is_incasso, t.incassant_id, t.machtiging, t.categorie, t.alleen_eigenaar, t.bestand, t.formaat FROM bank_transactie t WHERE t.verwijderd_op IS NULL AND ' + tf).all(...tp)
    .map((t) => Object.assign(t, { is_incasso: t.is_incasso === 1, alleen_eigenaar: t.alleen_eigenaar === 1 }));
  const [ff, fp] = factuurFilter(r, 'f');
  const lev = new Map(fdb.db.prepare('SELECT id, incassant_ids FROM leverancier').all().map((l) => [l.id, json(l.incassant_ids, []) || []]));
  const kop = new Map(), uitgesloten = new Map();
  const bedragVan = new Map(fdb.db.prepare('SELECT id, bedrag_centen FROM bank_transactie').all().map((t) => [t.id, t.bedrag_centen]));
  for (const k of fdb.db.prepare('SELECT factuur, transactie, methode FROM koppeling ORDER BY id').all()) { if (!kop.has(k.factuur)) kop.set(k.factuur, []); kop.get(k.factuur).push(k); }
  // wv1415 (diffreview ZOU 4): netto — een terugboeking (sepa_terug) heft één afschrijving op (bij voorkeur een SEPA-koppeling); beide
  // tellen dan niet als betaling, ook niet via de factuurnummer-herkenning
  for (const [fid, ks] of kop) {
    let n = ks.filter((k) => k.methode === 'sepa_terug').length;
    const weg = new Set(ks.filter((k) => k.methode === 'sepa_terug').map((k) => k.transactie));
    const af = ks.filter((k) => k.methode !== 'sepa_terug' && bedragVan.get(k.transactie) < 0);
    for (const k of af.filter((x) => /^sepa_/.test(String(x.methode || ''))).concat(af)) { if (!n) break; if (!weg.has(k.transactie)) { weg.add(k.transactie); n--; } }
    kop.set(fid, ks.map((k) => k.transactie).filter((id) => !weg.has(id)));
    if (weg.size) uitgesloten.set(fid, [...weg]);
  }
  const facturen = fdb.db.prepare("SELECT f.id, f.entiteit, f.leverancier, f.leverancier_naam, f.nummer, f.kenmerk, f.incl, f.iban, f.factuurdatum, f.vervaldatum, f.betaalspoor, f.status, f.alleen_eigenaar " +
    "FROM factuur f WHERE f.entiteit IS NOT NULL AND f.entiteit <> 'prive' AND " + ff).all(...fp)
    .map((f) => Object.assign(f, { herkomst: 'facturen', incassant_ids: lev.get(f.leverancier) || [], koppelingen: kop.get(f.id) || [], uitgesloten: uitgesloten.get(f.id) || [] }));
  const archief = isEig(r) ? fdb.db.prepare('SELECT id, entiteit, leverancier_naam, nummer, kenmerk, incl, iban, factuurdatum, vervaldatum, status, alleen_eigenaar FROM factuur_archief').all()
    .map((f) => Object.assign(f, { herkomst: 'fv2', incassant_ids: [], koppelingen: [] })) : [];
  return { txs, facturen: facturen.concat(archief), start: startdatumVan(fdb) };
}
function txUit(t) {
  return { id: t.id, entiteit: t.entiteit, datum: t.boekdatum, bedrag_centen: t.bedrag_centen, naam: t.tegenpartij_naam, iban: t.tegenpartij_iban,
    omschrijving: t.omschrijving, kenmerk: t.kenmerk, betaalwijze: V.betaalwijzeVan(t), incassant_id: t.incassant_id, alleen_eigenaar: !!t.alleen_eigenaar };
}
function profielUit(p) {
  return Object.assign({}, p, { ibans: p.ibans.slice(0, 5), incassant_ids: p.incassant_ids.slice(0, 5) });
}
function validatie(fdb, r, d, nu) {
  const vandaag = dagAmsterdam(nu);
  const soort = String(d && d.soort || 'overzicht');
  const inv = validatieInvoer(fdb, r);
  const tekst = kort(String(d && d.tekst || '').trim(), 100);
  const datum = (x) => (x && K.isIsoDatum(String(x)) ? String(x) : null);
  if (soort === 'zoek') {
    const z = V.zoek(inv.txs, { tekst, sinds: datum(d.sinds), tot: datum(d.tot), entiteit: d.entiteit ? String(d.entiteit) : null, richting: d.richting, max: d.max });
    return { soort, tekst, aantal: z.aantal, afgekapt: z.afgekapt, totaal_af_centen: z.totaal_af_centen, totaal_bij_centen: z.totaal_bij_centen, per_jaar: z.per_jaar,
      regels: z.regels.map(txUit) };
  }
  if (soort === 'tegenpartij' || soort === 'hoe') {
    if (tekst.length < 2) weiger(400, 'zoektekst ontbreekt');
    const z = V.zoek(inv.txs, { tekst, richting: 'af', max: 500, entiteit: d.entiteit ? String(d.entiteit) : null });
    const alle = inv.txs.filter((t) => t.bedrag_centen < 0);
    const sleutels = new Set(z.regels.map(V.tegenpartijSleutel).filter(Boolean));
    const ps = Array.from(V.profielen(alle.filter((t) => sleutels.has(V.tegenpartijSleutel(t)))).values()).sort((a, b) => b.totaal_centen - a.totaal_centen).slice(0, 10);
    return { soort: 'tegenpartij', tekst, profielen: ps.map(profielUit) };
  }
  if (soort === 'factuur') {
    const id = String(d && d.id || '');
    const f = inv.facturen.find((x) => x.id === id);
    if (!f) weiger(404, 'factuur niet gevonden');
    const b = V.betalingVan(f, inv.txs, { koppelingen: f.koppelingen, uitgesloten: f.uitgesloten });
    return { soort, factuur: { id: f.id, herkomst: f.herkomst, entiteit: f.entiteit, leverancier: f.leverancier_naam, nummer: f.nummer, incl_centen: f.incl,
      factuurdatum: f.factuurdatum, vervaldatum: f.vervaldatum }, betaling: Object.assign({}, b, { regels: inv.txs.filter((t) => b.transacties.includes(t.id)).map(txUit) }) };
  }
  if (soort !== 'overzicht') weiger(400, 'soort is overzicht, zoek, tegenpartij of factuur');
  const perEnt = new Map();   // betalingVan kijkt alleen binnen de entiteit: één keer groeperen (diffreview wv944 #1)
  for (const t of inv.txs) { if (!perEnt.has(t.entiteit)) perEnt.set(t.entiteit, []); perEnt.get(t.entiteit).push(t); }
  for (const f of inv.facturen) f.betaling = V.betalingVan(f, perEnt.get(f.entiteit) || [], { koppelingen: f.koppelingen, uitgesloten: f.uitgesloten });
  const dekking = inv.start ? [{ van: inv.start, tot: null }] : [];
  if (d && d.dekking_fv2 === true) {
    const fv = inv.facturen.filter((f) => f.herkomst === 'fv2' && f.factuurdatum).map((f) => f.factuurdatum).sort();
    if (fv.length) dekking.push({ van: fv[0], tot: fv[fv.length - 1] });
  }
  const c = V.controles({ vandaag, transacties: inv.txs, facturen: inv.facturen, dekking, venster_dagen: Number(d && d.venster_dagen) > 0 ? Math.min(730, Number(d.venster_dagen)) : 120 });
  const jaar = K.plusDagen(vandaag, -365);
  const top = Array.from(V.profielen(inv.txs.filter((t) => t.boekdatum >= jaar)).values()).sort((a, b) => b.totaal_centen - a.totaal_centen).slice(0, 25).map(profielUit);
  const datums = inv.txs.map((t) => t.boekdatum).sort();
  const betaald = inv.facturen.filter((f) => f.betaling && f.betaling.betaald).length;
  return { soort, vandaag, startdatum: inv.start, dekking, bank: { regels: inv.txs.length, van: datums[0] || null, tot: datums[datums.length - 1] || null },
    facturen: { totaal: inv.facturen.length, betaald_gevonden: betaald, archief: inv.facturen.filter((f) => f.herkomst === 'fv2').length },
    controles: { incasso_zonder_factuur: c.incasso_zonder_factuur.slice(0, 50), facturen_zonder_betaling: c.facturen_zonder_betaling.slice(0, 100),
      dubbele_betalingen: c.dubbele_betalingen.slice(0, 50), afwijkend_bedrag: c.afwijkend_bedrag.slice(0, 50), nieuwe_iban: isEig(r) ? c.nieuwe_iban.slice(0, 50) : [] },
    tellingen: { incasso_zonder_factuur: c.incasso_zonder_factuur.length, facturen_zonder_betaling: c.facturen_zonder_betaling.length,
      dubbele_betalingen: c.dubbele_betalingen.length, afwijkend_bedrag: c.afwijkend_bedrag.length, nieuwe_iban: isEig(r) ? c.nieuwe_iban.length : 0 },
    top_tegenpartijen: top };
}
// Socev-leesroute (/smal/facturen in server.js): alleen lezen, rol eigenaar met wie 'socev'; salarisregels gewoon mee (wv945).
const LEES_OPDRACHTEN = { zoek: 'zoek', hoe: 'tegenpartij', tegenpartij: 'tegenpartij', factuur: 'factuur', controles: 'overzicht', overzicht: 'overzicht' };
function lees(fdb, d, opties) {
  opties = opties || {};
  try {
    if (!fdb) weiger(409, 'Facturen draait alleen op de primaire kant');
    if (String(d && d.opdracht || '') === 'creditcard') {
      // wv2043: creditcardregels (ICS) en de aansluiting per rekeningoverzicht op de incasso; alleen lezen
      if (!CC) weiger(404, 'creditcard zit niet in deze versie van de pod');
      try { return { status: 200, j: Object.assign({ ok: true }, CC.lees(fdb, d)) }; } catch (e) { if (e instanceof CC.KaartFout) weiger(400, e.uitleg); throw e; }
    }
    if (String(d && d.opdracht || '') === 'paypal') {
      // wv2056: betalingen van de zakelijke PayPal-rekening en de aansluiting op de "PayPal Europe"-posten; alleen lezen
      if (!FP) weiger(404, 'paypal zit niet in deze versie van de pod');
      try { return { status: 200, j: Object.assign({ ok: true }, FP.lees(fdb, d)) }; } catch (e) { if (e instanceof FP.PaypalFout) weiger(400, e.uitleg); throw e; }
    }
    const op = LEES_OPDRACHTEN[String(d && d.opdracht || '')];
    if (!op) weiger(400, 'opdracht is zoek, hoe, factuur, controles, creditcard of paypal');
    const r = { soort: 'eigenaar', wie: kort(opties.wie || 'socev', 40), entiteiten: null, ingang: 'smal' };
    const nu = Number.isFinite(opties.nu) ? opties.nu : Date.now();
    const uit = validatie(fdb, r, Object.assign({}, d, { soort: op, max: Math.min(Number(d && d.max) || 50, 200) }), nu);
    return { status: 200, j: Object.assign({ ok: true }, uit) };
  } catch (e) { return alsFout(e, opties.fout); }
}

function soortVan(bytes, naam) {
  const kop = bytes.subarray(0, 8);
  if (kop.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if ((kop[0] === 0xff && kop[1] === 0xd8) || kop.subarray(0, 4).toString('latin1') === '\x89PNG') return 'afbeelding';
  const begin = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (begin.charAt(0) === '<' && /<(?:\w+:)?(Invoice|CreditNote)\b/.test(begin) && !/<BkToCstmrStmt\b/.test(begin)) return 'ubl';
  // alleen een echte PDF (kop iets verderop) telt via de naam; een bankexport met de naam .pdf wordt nooit als stuk bewaard (diffreview wv833 #3)
  if (/\.(pdf)$/i.test(naam) && bytes.subarray(0, 1024).toString('latin1').indexOf('%PDF-') >= 0) return 'pdf';
  return 'bank';
}
/*
 * Een document (PDF, UBL, afbeelding) opnemen. PDF: alleen opslaan met te_lezen (de koerier leest de tekst vluchtig in F4). UBL en
 * afbeelding: direct door het besliskader (verwerkBericht). Zelfde bestand al bekend → al_bekend, niets dubbel.
 */
function verwerkDocument(fdb, r, bytes, naam, soort, nu) {
  const st = D.stukSchrijf(fdb, bytes);
  const wanneer = nuIso(nu);
  return D.transactie(fdb, function () {
    const bestaand = fdb.db.prepare('SELECT id FROM document WHERE sha256 = ?').get(st.sha256);
    if (bestaand) return { soort, al_bekend: true, document: isEig(r) ? bestaand.id : undefined };
    const mime = soort === 'pdf' ? 'application/pdf' : soort === 'ubl' ? 'application/xml' : /\.png$/i.test(naam) ? 'image/png' : 'image/jpeg';
    if (soort === 'pdf') {
      const id = D.nieuwId();
      D.voegToe(fdb, 'document', { id, sha256: st.sha256, naam: kort(naam, 255), mime, bytes: st.bytes, soort: 'pdf', te_lezen: 1, geupload_door: r.wie, aangemaakt_op: wanneer });
      D.audit(fdb, { wie: r.wie, wat: 'document_upload', object_soort: 'document', object_id: id, na: { soort: 'pdf', te_lezen: true }, wanneer });
      return { soort, document: id, te_lezen: true };
    }
    const v = verwerkBericht(fdb, { bericht: null, documenten: [{ sha256: st.sha256, naam: kort(naam, 255), mime, bytes: st.bytes,
      ubl_xml: soort === 'ubl' ? bytes.toString('utf8') : undefined, tekstlaag: soort === 'ubl' ? undefined : false }] }, { wie: r.wie, nu, geupload_door: r.wie });
    return { soort, documenten: v.documenten.map((d) => ({ uitkomst: d.uitkomst })), facturen: v.facturen.filter((f) => isEig(r) || magFactuur(r, f)).map((f) => ({ id: f.id, status: f.status })) };
  });
}
/*
 * Eén bericht (of losse upload) door het besliskader en opslaan: documenten, facturen met besluitrijen, signaal bij een dubbele factuur.
 * Gedeeld met de koerier (F4): die geeft per document `tekst` (pdftotext, vluchtig) mee; die tekst wordt nergens opgeslagen.
 * invoer = { bericht: { id } | null, documenten: [{ sha256, naam, mime, bytes, tekst?, tekstlaag?, ubl_xml?, patientkenmerk_koerier? }] }.
 * Bestaat een document al als te_lezen zonder factuur, dan wordt het nu gelezen (te_lezen → 0); een al verwerkt document → dubbel.
 */
function verwerkBericht(fdb, invoer, o) {
  const nu = o.nu, wanneer = nuIso(nu), wie = o.wie || 'koerier';
  return D.transactie(fdb, function () {
    const ctx = Object.assign(kernCtx(fdb, nu), {
      leveranciers: leverancierLijst(fdb),
      tekstankers: fdb.db.prepare('SELECT tekst, entiteit FROM tekstanker WHERE actief = 1').all(),
      afzenderRegels: afzenderRegels(fdb),   // wv1917: gaat vóór tekstankers (kern beslisBericht)
      geenFactuur: fdb.db.prepare('SELECT patroon, leverancier AS leverancier_id FROM geen_factuur WHERE actief = 1').all(),
      bekendeSha256: [],
      bestaandeFacturen: fdb.db.prepare("SELECT id, leverancier AS leverancier_id, leverancier_kvk, leverancier_naam, nummer, incl FROM factuur WHERE status <> 'geen_factuur'").all(),
    });
    const docId = {};
    for (const d of invoer.documenten || []) {
      const b = fdb.db.prepare('SELECT d.id, d.te_lezen, (SELECT count(*) FROM factuur f WHERE f.document = d.id OR f.ubl_document = d.id) AS n FROM document d WHERE d.sha256 = ?').get(d.sha256);
      if (b && (b.n > 0 || !b.te_lezen)) ctx.bekendeSha256.push(d.sha256);
      else if (b) docId[d.sha256] = b.id;
    }
    const uit = K.beslisBericht({ bericht: invoer.bericht ? { message_id: invoer.bericht.message_id, afzender: invoer.bericht.afzender, onderwerp: invoer.bericht.onderwerp } : null,
      documenten: invoer.documenten }, ctx);
    const meta = new Map((invoer.documenten || []).map((d) => [d.sha256, d]));
    for (const d of uit.documenten) {
      if (d.uitkomst === 'dubbel' && d.reden === 'zelfde bestand al bekend') continue;
      const m = meta.get(d.sha256) || {};
      const soortDoc = m.ubl_xml != null ? 'ubl' : /pdf/.test(String(m.mime || '')) ? 'pdf' : /^image\//.test(String(m.mime || '')) ? 'afbeelding' : 'overig';
      if (docId[d.sha256]) fdb.db.prepare('UPDATE document SET te_lezen = 0, tekstlaag = ? WHERE id = ?').run(soortDoc === 'pdf' ? (m.tekstlaag === false ? 0 : 1) : null, docId[d.sha256]);
      else {
        docId[d.sha256] = D.nieuwId();
        D.voegToe(fdb, 'document', { id: docId[d.sha256], sha256: d.sha256, bericht: invoer.bericht && invoer.bericht.id || null, naam: kort(m.naam, 255), mime: kort(m.mime, 100),
          bytes: Number.isSafeInteger(m.bytes) ? m.bytes : null, soort: soortDoc, tekstlaag: soortDoc === 'pdf' ? (m.tekstlaag === false ? 0 : 1) : null,
          patientkenmerk: 0, te_lezen: 0, geupload_door: o.geupload_door || null, aangemaakt_op: wanneer });
      }
    }
    const facturen = [];
    for (const f of uit.facturen) {
      const id = D.nieuwId();
      const dubbel = uit.signalen.find((s) => s.soort === 'dubbele_factuur' && s.factuur_document === f.document);
      D.voegToe(fdb, 'factuur', { id, document: docId[f.document], ubl_document: f.ubl_document ? docId[f.ubl_document] : null, bericht: invoer.bericht && invoer.bericht.id || null,
        soort: f.soort || 'factuur', leverancier: f.leverancier_id || null, leverancier_naam: kort(f.leverancier_naam, 200), leverancier_kvk: f.leverancier_kvk || null,
        nummer: kort(f.nummer, 100), factuurdatum: f.factuurdatum || null, vervaldatum: f.vervaldatum || null, excl: f.excl, btw: f.btw, incl: f.incl, valuta: f.valuta || 'EUR',
        incl_eur: f.valuta === 'EUR' ? f.incl : null, iban: f.iban || null, ibans_betaal: f.ibans_betaal || [], iban_nieuw: f.iban_nieuw ? 1 : 0, ibans_onbekend: f.ibans_onbekend || [],
        kenmerk: kort(f.kenmerk, 100), betaalwijze: f.betaalwijze || 'onbekend', entiteit: f.entiteit || null, intern: f.intern ? 1 : 0, status: f.status,
        redenen: (f.redenen || []).map((x) => kort(x, 300)), controles: f.controles || [], patientkenmerk: f.patientkenmerk ? 1 : 0, alleen_eigenaar: f.alleen_eigenaar ? 1 : 0,
        dubbel_van: dubbel && dubbel.van ? dubbel.van : null, aangemaakt_op: wanneer, bijgewerkt_op: wanneer });
      for (const b of f.besluiten || []) besluitRij(fdb, id, b, null, wanneer);
      if (f.patientkenmerk) fdb.db.prepare('UPDATE document SET patientkenmerk = 1 WHERE id IN (?, ?)').run(docId[f.document], f.ubl_document ? docId[f.ubl_document] : docId[f.document]);
      if (f.status === 'dubbel' && dubbel && dubbel.van) {
        const van = fdb.db.prepare('SELECT alleen_eigenaar, patientkenmerk, entiteit FROM factuur WHERE id = ?').get(dubbel.van) || {};
        signaalInvoegen(fdb, B.maakSignaal('dubbele_factuur', { facturen: [id, dubbel.van], entiteit: f.entiteit || null, leverancier: f.leverancier_id || null, naam: f.leverancier_naam || null,
          bedrag_centen: f.incl, alleen_eigenaar: !!(f.alleen_eigenaar || f.patientkenmerk || f.entiteit === 'prive' || van.alleen_eigenaar || van.patientkenmerk || van.entiteit === 'prive') }), wanneer);
      }
      D.audit(fdb, { wie, wat: 'document_verwerkt', object_soort: 'factuur', object_id: id, entiteit: f.entiteit || null, na: { status: f.status }, wanneer });
      facturen.push({ id, status: f.status, entiteit: f.entiteit || null, patientkenmerk: !!f.patientkenmerk, alleen_eigenaar: !!f.alleen_eigenaar });
    }
    return { documenten: uit.documenten.map((d) => ({ sha256: d.sha256, uitkomst: d.uitkomst })), facturen };
  });
}
// wv2060: een ICS-transactieoverzicht (CSV) herkennen aan de eerste drie kolomkoppen (de lezer toetst daarna de hele kop).
function isIcsCsv(bytes) {
  const eerste = bytes.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  return eerste.replace(/"/g, '').split(';').slice(0, 3).join(';') === CC.ICS_KOPPEN.slice(0, 3).join(';');
}
// Inlezen voor de kaart (facturen-creditcard.js: hele bestand of niets, idempotent op regel, kaartnummer geweigerd); alleen de eigenaar.
function verwerkIcs(fdb, r, bytes, naam, nu) {
  eisEigenaar(r);
  let x, l4 = null;
  try {
    // de kaart uit het bestand zelf (laatste 4 van de eerste regel met een kaart; review wv2060 KAN 5: bij een tweede kaart niet weigeren)
    l4 = (CC.leesIcsCsv(bytes).regels.find((g) => g.laatste4) || {}).laatste4 || null;
    x = CC.inlezen(fdb, l4, bytes, { wie: r.wie, herkomst: 'app-upload: ' + kort(naam || 'ics.csv', 200), naam: naam || null, nu });
  } catch (e) { if (e instanceof CC.KaartFout) weiger(e.code === 'kaartnummer' ? 422 : 415, 'ICS-overzicht geweigerd: ' + kort(e.uitleg, 160), { code: 'creditcard_' + e.code }); throw e; }
  const k = l4 ? { laatste4: l4 } : fdb.db.prepare('SELECT laatste4 FROM kaart LIMIT 1').get();
  return { soort: 'creditcard', al_bekend: !!x.al_bekend, kaart: k ? '…' + k.laatste4 : null, periode: x.periode, regels: x.regels, nieuw: x.nieuw, al_bekend_regels: x.al_bekend_regels };
}
function upload(fdb, r, d, nu, o) {
  const beurt = String(d.beurt || ''), n = Number(d.n), soort = d.soort === undefined ? 'auto' : d.soort;
  if (!BEURT_RE.test(beurt) || !Number.isInteger(n) || n < 1 || n > 10) weiger(400, 'beurt en n ontbreken of zijn ongeldig');
  if (typeof o.uploadNeem !== 'function') weiger(503, 'uploads zijn hier niet ingericht');
  const st = o.uploadNeem(beurt, n);
  if (!st) weiger(404, 'het bestand staat niet (meer) klaar; upload het opnieuw');
  try {
    if (!['auto', 'bank', 'factuur'].includes(soort)) weiger(400, 'soort is auto, bank of factuur');
    const bytes = Buffer.isBuffer(st.bytes) ? st.bytes : Buffer.from(st.bytes);
    if (!bytes.length) weiger(400, 'leeg bestand');
    if (bytes.length > D.MAX_STUK) weiger(413, 'bestand groter dan 20 MB');
    if (CC && isIcsCsv(bytes)) {   // wv2060: het ICS-overzicht van de creditcard (CSV) hoort bij de kaart, niet bij de bank of de stukken
      if (soort === 'factuur') weiger(415, 'geen PDF, UBL of afbeelding');
      return verwerkIcs(fdb, r, bytes, st.naam, nu);
    }
    const herkend = soortVan(bytes, st.naam || '');
    if (soort === 'bank' && herkend !== 'bank') weiger(415, 'dit is geen bankexport (MT940, TAB of CSV)');
    if (soort === 'factuur' && herkend === 'bank') weiger(415, 'geen PDF, UBL of afbeelding');
    return herkend === 'bank' ? verwerkBankbestand(fdb, r, bytes, st.naam, nu) : verwerkDocument(fdb, r, bytes, st.naam, herkend, nu);
  } finally { if (typeof st.weg === 'function') st.weg(); }   // ook een geweigerd bestand blijft niet klaarstaan (er kan Privé in staan)
}

// ───────────────────────────── bankluis (read-only) ─────────────────────────────

/*
 * Rekeningen die al via Enable Banking binnenkomen (bank_formaat bankluis) direct uit /opt/data/bank/transacties.sqlite lezen: een APARTE
 * read-only verbinding (readOnly + query_only), alleen status 'booked' en niet vervangen (normaliseerBankluis). Elke ronde: is een al
 * ingelezen post intussen vervangen of niet meer geboekt, dan weg (verwijderd_op) en de koppeling naar de opvolger; zonder opvolger blijft
 * hij gekoppeld en staat het in de ronde (storingen zichtbaar). Hartslag in bron_ronde. Daarna de bankcontrole.
 */
function bankluisRonde(fdb, o) {
  const nu = o.nu, wanneer = nuIso(nu), vandaag = dagAmsterdam(nu), van = K.plusDagen(vandaag, -BANK_DAGEN);
  const rekeningen = fdb.db.prepare("SELECT * FROM rekening WHERE bank_formaat = 'bankluis' AND controle = 1").all();
  if (!rekeningen.length) return { ok: true, rekeningen: 0, nieuw: 0, reden: 'geen bankluis-rekening' };
  const posten = {}, fouten = [];
  if (!o.pad || !fs.existsSync(o.pad)) fouten.push({ wat: 'bankluis', melding: 'transactiedatabase niet gevonden' });
  else {
    const { DatabaseSync } = require('node:sqlite');
    let db = null;
    try {
      db = new DatabaseSync(o.pad, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
      const q = db.prepare('SELECT nr, rek, sleutel, status, datum, bedrag, valuta, tegenpartij, tegen_iban, omschrijving, ruwe_json, vervangen_door FROM transacties WHERE rek = ? AND datum >= ?');
      const opNr = db.prepare('SELECT nr, rek, sleutel, status, datum, bedrag, valuta, tegenpartij, tegen_iban, omschrijving, ruwe_json, vervangen_door FROM transacties WHERE nr = ?');
      for (const k of rekeningen) {
        const lijst = q.all(k.bankluis_rek, van);
        const perNr = new Map(lijst.map((p) => [p.nr, p]));
        // een opvolger kan buiten het venster vallen: los ophalen
        for (const p of lijst) if (p.vervangen_door != null && !perNr.has(p.vervangen_door)) { const x = opNr.get(p.vervangen_door); if (x && x.rek === k.bankluis_rek) perNr.set(x.nr, x); }
        posten[k.id] = { lijst, perNr };
      }
    } catch (e) { fouten.push({ wat: 'bankluis', melding: 'lezen mislukt (' + kort(e && e.code || e && e.name || 'fout', 40) + ')' }); }
    finally { if (db) try { db.close(); } catch (e) {} }
  }
  const uit = D.transactie(fdb, function () {
    let bron = fdb.db.prepare("SELECT id FROM bron WHERE soort = 'bankluis' ORDER BY id LIMIT 1").get();
    if (!bron) { bron = { id: D.nieuwId() }; D.voegToe(fdb, 'bron', { id: bron.id, soort: 'bankluis', naam: 'bankluis', actief: 1 }); }
    const tel = { rekeningen: 0, gelezen: 0, nieuw: 0, vervangen: 0, verplaatst: 0 };
    for (const k of rekeningen) {
      const p = posten[k.id];
      if (!p) continue;
      tel.rekeningen++;
      const rk = { rek: k.bankluis_rek, iban: k.iban, entiteit: k.entiteit, bank_formaat: 'bankluis', controle: k.controle, alleen_eigenaar: k.alleen_eigenaar };
      const viaRef = (post) => 'bankluis:' + k.bankluis_rek + '|' + post.sleutel;
      for (const post of p.perNr.values()) {
        const n = B.normaliseerBankluis(post, rk);
        if (!n.ok) continue;
        tel.gelezen++;
        const nw = transactieInvoegen(fdb, Object.assign({}, n.transactie, { id: D.nieuwId(), bestand: null, rekening: k.id, bankluis_sleutel: post.sleutel, aangemaakt_op: wanneer }));
        tel.nieuw += nw;
        // een post die de bankluis-ronde eerder weghaalde en die weer geboekt staat: terugzetten (diffreview wv833 #4)
        if (!nw) tel.terug = (tel.terug || 0) + fdb.db.prepare("UPDATE bank_transactie SET verwijderd_op = NULL, verwijderd_door = NULL WHERE entry_ref = ? AND verwijderd_door = 'bankluis'").run(n.transactie.entry_ref).changes;
      }
      // geen enkele post in het venster terwijl er wel regels zijn: verkeerde koppeling of een lege/herbouwde bankluis — niets weghalen, wel melden
      const binnen = Number(fdb.db.prepare("SELECT count(*) AS n FROM bank_transactie WHERE rekening = ? AND formaat = 'bankluis' AND verwijderd_op IS NULL AND boekdatum >= ?").get(k.id, van).n);
      if (!p.lijst.length && binnen > 0) { fouten.push({ wat: 'bankluis', melding: 'geen posten voor rekening ' + eind4(k.iban) + ' in de bankluis; niets weggehaald' }); continue; }
      // vervangen_door-controle over wat al binnen is (alleen binnen het venster: oudere posten worden niet opnieuw gelezen)
      const perSleutel = new Map([...p.perNr.values()].map((x) => [x.sleutel, x]));
      for (const t of fdb.db.prepare("SELECT id, bankluis_sleutel FROM bank_transactie WHERE rekening = ? AND formaat = 'bankluis' AND verwijderd_op IS NULL AND boekdatum >= ?").all(k.id, van)) {
        const post = perSleutel.get(t.bankluis_sleutel);
        if (post && post.status === 'booked' && post.vervangen_door == null) continue;
        fdb.db.prepare("UPDATE bank_transactie SET verwijderd_op = ?, verwijderd_door = 'bankluis' WHERE id = ?").run(wanneer, t.id);
        tel.vervangen++;
        const opv = post && post.vervangen_door != null ? p.perNr.get(post.vervangen_door) : null;
        const nieuw = opv ? fdb.db.prepare('SELECT id FROM bank_transactie WHERE entry_ref = ? AND verwijderd_op IS NULL').get(viaRef(opv)) : null;
        const kop = fdb.db.prepare('SELECT factuur FROM koppeling WHERE transactie = ?').all(t.id);
        if (nieuw) {
          for (const x of kop) {
            fdb.db.prepare('INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, wanneer) SELECT ?, factuur, bron, methode, zekerheid, volledig, alleen_eigenaar, wie, ? FROM koppeling WHERE transactie = ? AND factuur = ? ON CONFLICT DO NOTHING')
              .run(nieuw.id, wanneer, t.id, x.factuur);
            fdb.db.prepare('DELETE FROM koppeling WHERE transactie = ? AND factuur = ?').run(t.id, x.factuur);
            tel.verplaatst++;
          }
        } else if (kop.length) fouten.push({ wat: 'vervangen', melding: 'een gekoppelde post is vervangen zonder opvolger; koppeling blijft staan' });
        sluitVanTransactie(fdb, t.id, 'bankluis', wanneer);
      }
      fdb.db.prepare('UPDATE rekening SET laatste_invoer_op = ? WHERE id = ?').run(wanneer, k.id);
    }
    const controle = tel.rekeningen ? bankcontroleToepassen(fdb, nu) : null;
    D.voegToe(fdb, 'bron_ronde', { bron: bron.id, start: wanneer, eind: nuIso(Date.now() > nu ? Date.now() : nu), ok: fouten.length ? 0 : 1, aantallen: Object.assign({}, tel, controle ? { controle } : {}), fouten });
    return Object.assign({ ok: !fouten.length, fouten }, tel, { controle });
  });
  return uit;
}

// ───────────────────────────── instellingen ─────────────────────────────

function adres(fdb, r, d, nu, o) {
  eisEigenaar(r);
  const e = fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(String(d.entiteit || ''));
  if (!e) weiger(400, 'onbekende entiteit');
  if (e.sleutel === 'prive') weiger(409, 'Privé heeft nooit een boekhoudadres');
  const nieuw = {};
  for (const k of ['boekhoud_doel', 'afschrift_doel']) if (d[k] !== undefined) {
    const v = d[k] === null || d[k] === '' ? null : String(d[k]).trim().toLowerCase();
    if (v !== null && !/^[^\s@,;<>]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) weiger(400, k + ' is geen geldig mailadres');
    nieuw[k] = v;
  }
  if (d.boekhoud_route !== undefined) { if (![null, 'exact', 'mail'].includes(d.boekhoud_route)) weiger(400, 'route is exact of mail'); nieuw.boekhoud_route = d.boekhoud_route; }
  if (!Object.keys(nieuw).length) weiger(400, 'niets te wijzigen');
  if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
  o.versVerbruik();
  return D.transactie(fdb, function () {
    const wanneer = nuIso(nu);
    const zet = Object.keys(nieuw);
    fdb.db.prepare('UPDATE entiteit SET ' + zet.map((k) => k + ' = ?').join(', ') + ' WHERE sleutel = ?').run(...zet.map((k) => nieuw[k]), e.sleutel);
    // wachtende opdrachten met het oude adres worden bij het claimen geweigerd (signaal); dat zeggen we er meteen bij
    const wachtend = Number(fdb.db.prepare("SELECT count(*) AS n FROM opdracht WHERE entiteit = ? AND status IN ('wacht','opgehaald','mislukt') AND doeladres IS NOT (CASE soort WHEN 'boekhouder_factuur' THEN ? ELSE ? END)")
      .get(e.sleutel, nieuw.boekhoud_doel !== undefined ? nieuw.boekhoud_doel : e.boekhoud_doel, nieuw.afschrift_doel !== undefined ? nieuw.afschrift_doel : e.afschrift_doel).n);
    D.audit(fdb, { wie: r.wie, wat: 'adres_wijzigen', object_soort: 'entiteit', object_id: e.sleutel, entiteit: e.sleutel,
      voor: Object.fromEntries(zet.map((k) => [k, e[k]])), na: nieuw, wanneer });
    return { entiteit: e.sleutel, wachtende_opdrachten_met_oud_adres: wachtend };
  });
}
function modus(fdb, r, d, nu, o) {
  eisEigenaar(r);
  if (!['concept', 'versturen'].includes(d.modus)) weiger(400, 'modus is concept of versturen');
  // zelf versturen pas na Davids Ja na de schaduwweek (F5): de machinekamer zet dan versturen_vrijgegeven
  if (d.modus === 'versturen' && D.metaLees(fdb, 'versturen_vrijgegeven') !== '1') weiger(409, 'zelf versturen kan pas na de schaduwweek (fase F5); tot dan maakt de koerier alleen concepten');
  if (!o.versOk()) weiger(403, 'bevestig met je vingerafdruk', { vers_nodig: true });
  o.versVerbruik();
  return D.transactie(fdb, function () {
    const oud = D.metaLees(fdb, 'verzendmodus');
    D.metaZet(fdb, 'verzendmodus', d.modus);
    D.audit(fdb, { wie: r.wie, wat: 'verzendmodus', object_soort: 'instelling', object_id: 'verzendmodus', voor: { modus: oud }, na: { modus: d.modus }, wanneer: nuIso(nu) });
    return { verzendmodus: d.modus };
  });
}
function verzendmoment(fdb, r, d, nu) {
  eisEigenaar(r);
  const ins = d.soort === 'dagelijks' ? { soort: 'dagelijks', uur: d.uur } : d.soort === 'uur' ? { soort: 'uur' } : null;
  if (!ins) weiger(400, 'soort is uur of dagelijks');
  try { K.verstuurNa(nu, ins); } catch (e) { weiger(400, 'uur is 0–23'); }
  return D.transactie(fdb, function () {
    const oud = verstuurInstelling(fdb);
    D.metaZet(fdb, 'verstuur_instelling', JSON.stringify(ins));
    D.audit(fdb, { wie: r.wie, wat: 'verzendmoment', object_soort: 'instelling', object_id: 'verstuur_instelling', voor: oud, na: ins, wanneer: nuIso(nu) });
    return { verstuur_instelling: ins, voorbeeld: K.verstuurNa(nu, ins) };
  });
}
const REK_VELDEN = ['entiteit', 'bank', 'bank_formaat', 'bankluis_rek', 'controle', 'alleen_eigenaar', 'afschrift_doorsturen', 'waarschuw_na_dagen', 'rood_na_dagen'];
function rekening(fdb, r, d, nu) {
  eisEigenaar(r);
  return D.transactie(fdb, function () {
    const wanneer = nuIso(nu);
    const velden = {};
    for (const k of REK_VELDEN) if (d[k] !== undefined) velden[k] = d[k] === true ? 1 : d[k] === false ? 0 : d[k];
    // de POT-rekening is altijd alleen voor de eigenaar (salarisregels = personeelsgegevens; bouwplan § 4.2; diffreview wv833 #5)
    const potEis = (ent, eig) => { if (ent === 'pot' && Number(eig) !== 1) weiger(409, 'de POT-rekening is altijd alleen voor de eigenaar'); };
    if (d.id !== undefined) {
      const id = vraagId(d, 'id');
      const oud = fdb.db.prepare('SELECT * FROM rekening WHERE id = ?').get(id);
      if (!oud) weiger(404, 'rekening niet gevonden');
      potEis(velden.entiteit !== undefined ? velden.entiteit : oud.entiteit, velden.alleen_eigenaar !== undefined ? velden.alleen_eigenaar : oud.alleen_eigenaar);
      const zet = Object.keys(velden);
      if (!zet.length) weiger(400, 'niets te wijzigen');
      fdb.db.prepare('UPDATE rekening SET ' + zet.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?').run(...zet.map((k) => velden[k]), id);
      D.audit(fdb, { wie: r.wie, wat: 'rekening_wijzigen', object_soort: 'rekening', object_id: id, entiteit: velden.entiteit || oud.entiteit,
        voor: Object.fromEntries(zet.map((k) => [k, oud[k]])), na: velden, wanneer });
      return { id };
    }
    const iban = K.ibanNorm(d.iban);
    if (!iban || !K.ibanMod97(iban)) weiger(400, 'geen geldig IBAN');
    if (!velden.entiteit || !velden.bank_formaat || velden.controle === undefined) weiger(400, 'entiteit, bank_formaat en controle zijn nodig');
    if (velden.entiteit === 'pot' && velden.alleen_eigenaar === undefined) velden.alleen_eigenaar = 1;
    potEis(velden.entiteit, velden.alleen_eigenaar === undefined ? 0 : velden.alleen_eigenaar);
    const id = D.nieuwId();
    D.voegToe(fdb, 'rekening', Object.assign({ id, iban }, velden));
    D.audit(fdb, { wie: r.wie, wat: 'rekening_toevoegen', object_soort: 'rekening', object_id: id, entiteit: velden.entiteit, na: Object.assign({ iban: eind4(iban) }, velden), wanneer });
    return { id };
  });
}
function uitzondering(fdb, r, d, nu) {
  eisEigenaar(r);
  return D.transactie(fdb, function () {
    const wanneer = nuIso(nu);
    if (d.id !== undefined) {
      const id = vraagId(d, 'id');
      if (d.actief !== 0 && d.actief !== 1 && d.actief !== true && d.actief !== false) weiger(400, 'actief is 0 of 1');
      const u = fdb.db.prepare('UPDATE uitzondering SET actief = ? WHERE id = ?').run(d.actief ? 1 : 0, id);
      if (u.changes !== 1) weiger(404, 'uitzondering niet gevonden');
      D.audit(fdb, { wie: r.wie, wat: 'uitzondering_' + (d.actief ? 'aan' : 'uit'), object_soort: 'uitzondering', object_id: id, wanneer });
      return { id };
    }
    if (!B.CATEGORIEEN.includes(d.categorie)) weiger(400, 'onbekende categorie');
    const id = D.nieuwId();
    D.voegToe(fdb, 'uitzondering', { id, richting: ['af', 'bij', 'beide'].includes(d.richting) ? d.richting : 'af', rekening: d.rekening ? K.ibanNorm(d.rekening) : null,
      tegenpartij: kort(d.tegenpartij || null, 200), omschrijving: kort(d.omschrijving || null, 200), transactietype: kort(d.transactietype || null, 60),
      bedrag_centen: int(d.bedrag_centen), tolerantie_centen: int(d.tolerantie_centen), categorie: d.categorie, toelichting: kort(d.toelichting || null, 300),
      alleen_eigenaar: d.alleen_eigenaar ? 1 : 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer });
    D.audit(fdb, { wie: r.wie, wat: 'uitzondering_maken', object_soort: 'uitzondering', object_id: id, na: { categorie: d.categorie }, wanneer });
    return { id };
  });
}
function leverancierRoute(fdb, r, d, nu) {
  const id = vraagId(d, 'id');
  return D.transactie(fdb, function () {
    const l = fdb.db.prepare('SELECT * FROM leverancier WHERE id = ?').get(id);
    if (!magLeverancier(r, l)) weiger(404, 'leverancier niet gevonden');
    const zet = {};
    if (d.standaard_entiteit !== undefined) {
      if (d.standaard_entiteit !== null && !fdb.db.prepare('SELECT 1 FROM entiteit WHERE sleutel = ?').get(String(d.standaard_entiteit))) weiger(400, 'onbekende entiteit');
      if (d.standaard_entiteit !== null && !magEntiteit(r, d.standaard_entiteit)) weiger(403, 'deze entiteit mag je niet kiezen');
      zet.standaard_entiteit = d.standaard_entiteit;
    }
    if (d.standaard_betaalwijze !== undefined) { if (![null, 'zelf', 'incasso', 'betaald'].includes(d.standaard_betaalwijze)) weiger(400, 'onbekende betaalwijze'); zet.standaard_betaalwijze = d.standaard_betaalwijze; }
    if (d.alleen_portaal !== undefined) zet.alleen_portaal = d.alleen_portaal ? 1 : 0;
    if (d.incasso_tolerantie_pct !== undefined) { const p = d.incasso_tolerantie_pct; if (p !== null && !(Number.isFinite(p) && p >= 0 && p <= 100)) weiger(400, 'tolerantie 0–100'); zet.incasso_tolerantie_pct = p; }
    const k = Object.keys(zet);
    if (!k.length) weiger(400, 'niets te wijzigen');
    const wanneer = nuIso(nu);
    fdb.db.prepare('UPDATE leverancier SET ' + k.map((x) => x + ' = ?').join(', ') + ', bijgewerkt_op = ? WHERE id = ?').run(...k.map((x) => zet[x]), wanneer, id);
    D.audit(fdb, { wie: r.wie, wat: 'leverancier_bijwerken', object_soort: 'leverancier', object_id: id, voor: Object.fromEntries(k.map((x) => [x, l[x]])), na: zet, wanneer });
    return { id };
  });
}

// ───────────────────────────── ronde (n8n-tik) ─────────────────────────────

// Back-up nodig? De eerste ronde na 02:00 (Nederlandse tijd) op een dag zonder back-up (F4: de tik loopt elk uur; wv855).
function backupNodig(fdb, nu) {
  const uur = Number(new Date(nu).toLocaleString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }));
  if (!(uur >= 2)) return false;
  const lb = json(D.metaLees(fdb, 'laatste_backup'), null);
  return !lb || lb.dag !== dagAmsterdam(nu);
}
/*
 * POT-afschrift in de verzendwachtrij (bouwplan § 4.4 en § 5; F4): de twee gemaakte bestanden van de afschriftmaker (wv787, MT940 + PDF)
 * als stukken opslaan (nooit als bankbestand inlezen), pot_afschrift → in_wachtrij en een opdracht boekhouder_afschrift naar het
 * afschriftadres van de entiteit van de rekening (de database dwingt adres en entiteit af). Alleen de eigenaar; wie = Davids klik.
 * Sinds wv959 (F5) roept de knop van de POT-App (server.js appPotConcept) dit aan via maak().afschrift; het mailconcept-pad is daar de terugval.
 * invoer = { rekening (id), periode (JJJJ-MM), mt940: { naam, bytes }, pdf: { naam, bytes } }.
 */
function afschriftKlaarzetten(fdb, r, invoer, o) {
  eisEigenaar(r);
  const nu = o.nu, wanneer = nuIso(nu);
  const rek = fdb.db.prepare('SELECT * FROM rekening WHERE id = ?').get(String(invoer.rekening || ''));
  if (!rek) weiger(404, 'rekening niet gevonden');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(invoer.periode || ''))) weiger(400, 'periode als JJJJ-MM');
  for (const [x, soort] of [[invoer.mt940, 'mt940'], [invoer.pdf, 'pdf']]) if (!x || !x.bytes || !x.bytes.length) weiger(400, soort + ' ontbreekt');
  if (Buffer.from(invoer.pdf.bytes).subarray(0, 5).toString('latin1') !== '%PDF-') weiger(400, 'de PDF is geen PDF');
  const stuk = (x, soort) => {
    const st = D.stukSchrijf(fdb, Buffer.isBuffer(x.bytes) ? x.bytes : Buffer.from(x.bytes));
    return { st, naam: kort(x.naam || (soort === 'mt940' ? 'afschrift.940' : 'afschrift.pdf'), 120), soort };
  };
  const e0 = fdb.db.prepare('SELECT afschrift_doel FROM entiteit WHERE sleutel = ?').get(rek.entiteit);
  if (!e0 || !e0.afschrift_doel) weiger(409, 'deze entiteit heeft geen afschriftadres (eerst instellen)');   // vóór het wegschrijven: geen losse stukken
  const delen = [stuk(invoer.mt940, 'mt940'), stuk(invoer.pdf, 'pdf')];
  return D.transactie(fdb, function () {
    const e = fdb.db.prepare('SELECT * FROM entiteit WHERE sleutel = ?').get(rek.entiteit);
    if (!e || !e.afschrift_doel) weiger(409, 'deze entiteit heeft geen afschriftadres (eerst instellen)');
    const ids = delen.map((d) => {
      const b = fdb.db.prepare('SELECT id FROM document WHERE sha256 = ?').get(d.st.sha256);
      if (b) return { id: b.id, sha256: d.st.sha256, naam: d.naam, soort: d.soort };
      const id = D.nieuwId();
      D.voegToe(fdb, 'document', { id, sha256: d.st.sha256, naam: d.naam, mime: d.soort === 'pdf' ? 'application/pdf' : 'application/octet-stream', bytes: d.st.bytes,
        soort: d.soort, te_lezen: 0, geupload_door: r.wie, aangemaakt_op: wanneer });
      return { id, sha256: d.st.sha256, naam: d.naam, soort: d.soort };
    });
    let a = fdb.db.prepare('SELECT * FROM pot_afschrift WHERE rekening = ? AND periode = ?').get(rek.id, invoer.periode);
    // een verstuurd afschrift krijgt nooit een tweede opdracht (de database houdt één levende opdracht per afschrift)
    if (a && ['in_wachtrij', 'verstuurd'].includes(a.status)) weiger(409, 'dit afschrift staat al in de wachtrij of is verstuurd');
    if (!a) { a = { id: D.nieuwId() }; D.voegToe(fdb, 'pot_afschrift', { id: a.id, rekening: rek.id, periode: invoer.periode, mt940_document: ids[0].id, pdf_document: ids[1].id, status: 'in_wachtrij', aangemaakt_op: wanneer, bijgewerkt_op: wanneer }); }
    else fdb.db.prepare("UPDATE pot_afschrift SET mt940_document = ?, pdf_document = ?, status = 'in_wachtrij', bijgewerkt_op = ? WHERE id = ?").run(ids[0].id, ids[1].id, wanneer, a.id);
    const opId = D.nieuwId();
    // naam en mime uit de documentrij (bij een hergebruikt stuk de oude naam), zoals de consistentiecontrole ze opnieuw opbouwt (diffreview wv855 #5)
    const bijlagen = ids.map((x) => { const d = fdb.db.prepare('SELECT naam, mime, sha256 FROM document WHERE id = ?').get(x.id); return { naam: d.naam, mime: d.mime, sha256: d.sha256 }; });
    const op = { id: opId, soort: 'boekhouder_afschrift', doeladres: e.afschrift_doel,
      regel: { afschrift_id: a.id, entiteit: e.sleutel, periode: invoer.periode, doeladres: e.afschrift_doel }, bijlagen };
    const vingerafdruk = K.vingerafdruk(op);
    const verstuurNa = K.verstuurNa(nu, verstuurInstelling(fdb));
    D.voegToe(fdb, 'opdracht', { id: opId, soort: op.soort, afschrift: a.id, entiteit: e.sleutel, doeladres: e.afschrift_doel, bijlagen, vingerafdruk,
      verstuur_na: verstuurNa, idempotentiesleutel: 'afschrift:' + a.id + ':' + opId, status: 'wacht', poging: 0, aangemaakt_door: r.wie, aangemaakt_op: wanneer, bijgewerkt_op: wanneer });
    D.audit(fdb, { wie: r.wie, wat: 'afschrift_klaarzetten', object_soort: 'pot_afschrift', object_id: a.id, entiteit: e.sleutel, na: { periode: invoer.periode, opdracht: opId }, wanneer });
    return { afschrift: a.id, opdracht: { id: opId, verstuur_na: verstuurNa } };
  });
}
// POST /facturen-ronde: de back-up (VACUUM INTO, 14 dagen); de koerier (facturen-koerier.js) roept dit aan als backupNodig.
// Na een wijziging in de koppelregels (facturen-bank.js) beoordeelt de eerstvolgende back-upronde (de eerste tik na 02:00) de stand één
// keer opnieuw, ná de back-up: zo vervallen voorstellen die onder de oude regels ontstonden, ook zonder nieuwe bankupload (elke upload en
// bankluis-ronde doet hetzelfde al via bankcontroleToepassen). Mislukt het: ok = false (de koerier meldt 'herbeoordeling') en de volgende
// back-upronde probeert het opnieuw; de meta-sleutel wordt pas gezet na een geslaagde transactie (wv1317).
const BANK_REGELS = 'wv1317';
function ronde(fdb, o) {
  const nu = o.nu || Date.now();
  const uit = { ok: true };
  try { const b = D.backup(fdb, { nu }); uit.backup = { ok: true, dag: b.dag, bytes: b.bytes, verwijderd: b.verwijderd.length }; }
  catch (e) { uit.ok = false; uit.backup = { ok: false, fout: kort(e && e.code || 'fout', 60) }; }
  if (uit.backup.ok && D.metaLees(fdb, 'bank_regels') !== BANK_REGELS) {
    try {
      uit.herbeoordeling = D.transactie(fdb, function () {
        const c = bankcontroleToepassen(fdb, nu);
        D.metaZet(fdb, 'bank_regels', BANK_REGELS);
        D.audit(fdb, { wie: 'bankcontrole', wat: 'herbeoordeling', object_soort: 'meta', object_id: 'bank_regels', na: Object.assign({ regels: BANK_REGELS }, c), wanneer: nuIso(nu) });
        return Object.assign({ ok: true, regels: BANK_REGELS }, c);
      });
    } catch (e) { uit.ok = false; uit.herbeoordeling = { ok: false, fout: kort(e && (e.code || e.message) || 'fout', 80) }; }
  }
  return uit;
}

// ───────────────────────────── de router ─────────────────────────────

/*
 * maak({ docPerUur, fout }) → { app(fdb, verzoek), ronde, bankluisRonde, verwerkBericht, rolVoor, ROUTES, BEHEER }.
 * verzoek = { methode, pad, d, rol, primair, versOk(), versVerbruik(), uploadNeem(beurt, n) → { naam, bytes, weg() } | null, nu, bankluisPad }.
 * → { status, j, reden }. Elke fout wordt een nette status; een onverwachte fout 500 zonder inhoud (de melding gaat naar `fout`).
 */
function maak(opties) {
  opties = opties || {};
  const docPerUur = Number.isInteger(opties.docPerUur) && opties.docPerUur > 0 ? opties.docPerUur : DOC_PER_UUR;
  const docTeller = [];
  const stijlVoor = typeof opties.huisstijl === 'function' ? opties.huisstijl : null;   // wv2025: briefhoofd van de entiteit (server.js, omzet-huisstijl.js)
  const teller = () => { const n = Date.now(); while (docTeller.length && n - docTeller[0] >= 3600000) docTeller.shift(); if (docTeller.length >= docPerUur) return false; docTeller.push(n); return true; };
  function app(fdb, v) {
    const nu = Number.isFinite(v.nu) ? v.nu : Date.now();
    const r = v.rol;
    try {
      if (!r || !r.soort) weiger(403, 'geen rol');
      if (!fdb) weiger(v.primair === false ? 409 : 503, v.primair === false ? 'Facturen draait alleen op de primaire kant' : 'de facturendatabase is nu niet te openen');
      if (v.pad !== PREFIX && v.pad.indexOf(PREFIX + '/') !== 0) weiger(404, 'onbekend');
      const rest = v.pad.slice(PREFIX.length + 1);
      const d = v.d && typeof v.d === 'object' ? v.d : {};
      if (v.methode === 'GET') {
        if (rest === '') return ok(overzicht(fdb, r, nu));
        let m;
        if ((m = /^lijst\/([a-z]{3,12})$/.exec(rest))) return ok(lijst(fdb, r, m[1]));
        if ((m = /^factuur\/([0-9a-f]{16})$/.exec(rest))) return ok(detail(fdb, r, m[1], nu));
        if ((m = /^document\/([0-9a-f]{16})$/.exec(rest))) {
          if (v.primair === false) weiger(409, 'Facturen draait alleen op de primaire kant');   // inzage schrijft een auditrij
          return ok(document(fdb, r, m[1], { nu, teller, docPerUur }), 'document ' + m[1]);
        }
        if ((m = /^kandidaten\/([0-9a-f]{16})$/.exec(rest))) return ok(kandidaten(fdb, r, m[1], nu));
        if (rest === 'betalen') return ok(betalen(fdb, r, nu));
        if (rest === 'bank') return ok(bank(fdb, r, nu));
        if ((m = /^bank\/oranje\/(\d{4})-w(\d{2})$/.exec(rest))) return ok(bankOranje(fdb, r, m[1] + '-W' + m[2], nu));
        if (rest === 'uploads') return ok(uploads(fdb, r, nu));
        if (rest === 'leveranciers') return ok(leveranciers(fdb, r));
        if (rest === 'instellingen') return ok(instellingen(fdb, r));
        if (rest === 'validatie') return ok(validatie(fdb, r, { soort: 'overzicht' }, nu));
        if (rest === 'regels') return ok(regelsLijst(fdb, r));
        if (rest === 'afzender-voorstellen') return ok(afzenderVoorstellen(fdb, r));
        if (rest === 'maand-specificatie') return ok(maandSpecOverzicht(fdb, r, nu));   // wv2060
        weiger(404, 'onbekend');
      }
      if (v.methode !== 'POST') weiger(404, 'onbekend');
      if (!ROUTES.POST.includes(rest)) weiger(404, 'onbekend');
      // schrijven alleen op de primaire kant (bouwplan § 8: netheid, de borging is dat de VPS geen database heeft)
      if (v.primair !== true) weiger(409, 'Facturen draait alleen op de primaire kant');
      const vo = { versOk: typeof v.versOk === 'function' ? v.versOk : () => false, versVerbruik: typeof v.versVerbruik === 'function' ? v.versVerbruik : () => {}, uploadNeem: v.uploadNeem };
      switch (rest) {
        case 'bevestig': return ok(bevestig(fdb, r, d, nu), 'bevestig ' + kort(d.id, 16));
        case 'terugdraaien': return ok(terugdraaien(fdb, r, d, nu), 'terugdraaien ' + kort(d.id, 16));
        case 'nagebeld': return ok(nagebeld(fdb, r, d, nu, vo), 'nagebeld ' + kort(d.id, 16));
        case 'geen-factuur': return ok(gebeurtenisRoute(fdb, r, d, 'geen_factuur', nu));
        case 'toch-factuur': return ok(gebeurtenisRoute(fdb, r, d, 'toch_factuur', nu));
        case 'opnieuw': return ok(gebeurtenisRoute(fdb, r, d, 'opnieuw_proberen', nu));
        case 'terug-naar-beoordelen': return ok(gebeurtenisRoute(fdb, r, d, 'terug_naar_beoordelen', nu));
        case 'wijzig': return ok(wijzig(fdb, r, d, nu));
        case 'ingevoerd': return ok(ingevoerd(fdb, r, d, nu, false));
        case 'ingevoerd-ongedaan': return ok(ingevoerd(fdb, r, d, nu, true));
        case 'betaaldatum': return ok(betaaldatum(fdb, r, d, nu));
        case 'sepa-batch': { const j = sepaBatch(fdb, r, d, nu, vo); return ok(j, 'sepa-batch ' + (j.voorbeeld ? 'voorbeeld ' : '') + (j.aantal != null ? j.aantal : j.overzicht ? j.overzicht.aantal : '')); }
        case 'sepa-bestand': return ok(sepaBestand(fdb, r, d, nu, vo), 'sepa-bestand opnieuw');
        case 'sepa-specificatie': return ok(sepaSpecificatie(fdb, r, d, nu, stijlVoor), 'sepa-specificatie');
        case 'maand-specificatie': return ok(maandSpecificatie(fdb, r, d, nu, stijlVoor), 'maand-specificatie ' + kort(d.maand, 7));   // wv2060
        case 'signaal': return ok(signaalRoute(fdb, r, d, nu), 'signaal ' + kort(d.knop, 30));
        case 'voorstel': return ok(voorstelRoute(fdb, r, d, nu));
        case 'feit': return ok(feitRoute(fdb, r, d, nu, vo), 'feit ' + kort(d.keuze, 10));
        case 'koppel': return ok(D.transactie(fdb, () => koppelIntern(fdb, r, String(d.transactie || ''), d.factuur, d.volledig !== false, nu)));
        case 'bank-keuze': return ok(bankKeuze(fdb, r, d, nu), 'bank-keuze ' + kort(d.keuze, 12));
        case 'upload': return ok(upload(fdb, r, d, nu, vo), 'upload');
        case 'leverancier': return ok(leverancierRoute(fdb, r, d, nu));
        case 'regel': return ok(regelRoute(fdb, r, d, nu), 'regel ' + kort(d.soort, 6));
        case 'regel-weg': return ok(regelWeg(fdb, r, d, nu), 'regel weg');
        case 'afzender-voorstel': return ok(afzenderVoorstel(fdb, r, d, nu), 'afzender-voorstel ' + kort(d.keuze, 10));
        case 'bankluis': eisEigenaar(r); return ok(bankluisRonde(fdb, { nu, pad: v.bankluisPad }), 'bankluis');
        case 'validatie': return ok(validatie(fdb, r, d, nu), 'validatie ' + kort(d.soort, 20));
        case 'instellingen/adres': return ok(adres(fdb, r, d, nu, vo), 'adres ' + kort(d.entiteit, 20));
        case 'instellingen/modus': return ok(modus(fdb, r, d, nu, vo), 'modus ' + kort(d.modus, 10));
        case 'instellingen/verzendmoment': return ok(verzendmoment(fdb, r, d, nu));
        case 'instellingen/rekening': return ok(rekening(fdb, r, d, nu));
        case 'instellingen/uitzondering': return ok(uitzondering(fdb, r, d, nu));
      }
      weiger(404, 'onbekend');
    } catch (e) { return alsFout(e, opties.fout); }
  }
  // wv959: het POT-afschrift in de wachtrij (afschriftKlaarzetten) met dezelfde foutvertaling als de routes; + de verzendmodus voor de melding
  const afschrift = (fdb, r, invoer, o) => {
    try { return ok(Object.assign(afschriftKlaarzetten(fdb, r, invoer, o || {}), { verzendmodus: D.metaLees(fdb, 'verzendmodus') }), 'afschrift ' + kort(invoer && invoer.periode, 7)); }
    catch (e) { return alsFout(e, opties.fout); }
  };
  // wv2025: het concept met de specificatie (server.js doet het mailluik); alleen op de primaire kant, met dezelfde foutvertaling als de routes
  const specificatie = {
    concept: (fdb, r, id, o) => {
      try { if (!fdb || (o && o.primair) !== true) weiger(409, 'Facturen draait alleen op de primaire kant'); return ok(specificatieConcept(fdb, r, id, Object.assign({ stijlVoor }, o)), 'specificatie concept'); }
      catch (e) { return alsFout(e, opties.fout); }
    },
    uitkomst: (fdb, r, id, u, o) => {
      try { if (!fdb || (o && o.primair) !== true) weiger(409, 'Facturen draait alleen op de primaire kant'); return ok(specificatieUitkomst(fdb, r, id, u || {}, o.nu), 'specificatie ' + (u && u.ok ? 'klaar' : 'mislukt')); }
      catch (e) { return alsFout(e, opties.fout); }
    },
  };
  // wv2060: de maandspecificatie PayPal en creditcard (server.js doet het mailluik, de maandronde en de Voor jou-kaart)
  const maandspec = {
    concept: (fdb, r, maand, o) => {
      try { if (!fdb || (o && o.primair) !== true) weiger(409, 'Facturen draait alleen op de primaire kant'); return ok(maandSpecConcept(fdb, r, maand, Object.assign({ stijlVoor }, o)), 'maandspec concept ' + kort(maand, 7)); }
      catch (e) { return alsFout(e, opties.fout); }
    },
    uitkomst: (fdb, r, maand, u, o) => {
      try { if (!fdb || (o && o.primair) !== true) weiger(409, 'Facturen draait alleen op de primaire kant'); return ok(maandSpecUitkomst(fdb, r, maand, u || {}, o.nu), 'maandspec ' + (u && u.ok ? 'klaar' : 'mislukt')); }
      catch (e) { return alsFout(e, opties.fout); }
    },
    plan: (fdb, nu, vanaf) => { try { return fdb ? maandSpecPlan(fdb, nu, vanaf) : null; } catch (e) { if (typeof opties.fout === 'function') opties.fout('facturen-maandspec', e); return null; } },
    naam: (m) => (MS ? MS.maandNaam(m) : String(m)),
    kaart: (x) => MS.kaartIcs(x),
    aan: !!MS,
  };
  return { app, ronde, bankluisRonde, verwerkBericht, rolVoor, afschrift, specificatie, maandspec, betaalMeldingen, betaalMeldingGemeld, betaalMeldingTerug, ROUTES, BEHEER, lees: (fdb, d, o) => lees(fdb, d, Object.assign({ fout: opties.fout }, o || {})) };
}
function ok(j, reden) { return { status: 200, j: Object.assign({ ok: true }, j), reden: reden || null }; }
// Fouten naar een status. Triggers van facturen-db.js geven vaste teksten ("opdracht_prive: …"): die mogen door. Een CHECK of UNIQUE noemt
// alleen de regel, nooit een waarde. Iets anders: 500 zonder melding naar buiten.
function alsFout(e, log) {
  if (e instanceof RouteFout) return { status: e.status, j: Object.assign({ ok: false, fout: e.fout }, e.extra || {}), reden: kort(e.fout, 80) };
  if (e instanceof K.KernFout) return { status: 409, j: { ok: false, fout: kort(e.message, 200), code: e.code }, reden: 'kern ' + e.code };
  if (e instanceof D.DbFout) return { status: 409, j: { ok: false, fout: kort(e.uitleg, 200), code: e.code }, reden: 'db ' + e.code };
  const m = String(e && e.message || '');
  const t = /^([a-z_]{3,40}): ([^\n]{1,200})$/.exec(m);
  if (t) return { status: 409, j: { ok: false, fout: m.slice(0, 240), code: t[1] }, reden: 'trigger ' + t[1] };
  if (/CHECK constraint failed/.test(m)) return { status: 400, j: { ok: false, fout: 'ongeldige waarde (de database weigert hem)' }, reden: 'check' };
  if (/UNIQUE constraint failed/.test(m)) return { status: 409, j: { ok: false, fout: 'bestaat al' }, reden: 'uniek' };
  if (/FOREIGN KEY constraint failed/.test(m)) return { status: 400, j: { ok: false, fout: 'verwijzing naar iets dat niet bestaat' }, reden: 'fk' };
  if (/database is locked|SQLITE_BUSY/i.test(m)) return { status: 503, j: { ok: false, fout: 'de database is even bezet; probeer het zo opnieuw' }, reden: 'bezet' };
  if (typeof log === 'function') { try { log('facturen', e); } catch (e2) {} }
  return { status: 500, j: { ok: false, fout: 'fout op de pod' }, reden: 'uitzondering' };
}

/*
 * wv2036 (statuslabels, Davids Ja 30-10-2026 16:30): de factuurstap per Gmail-bericht uit het verzamelpostvak (Davids privé-Gmail), voor
 * MailMan, die het label doorschuift FACTUUR → FACTUUR/In_SEPA → FACTUUR/Is_betaald. Per bericht telt de laagste stap van zijn facturen;
 * geen_factuur, dubbel en creditnota's tellen niet mee (review wv2036 ZOU 6: een creditnota is 'niets te betalen' en zou de mail anders
 * tegenhouden). Een factuur telt pas als hij bevestigd is (status in_wachtrij, wordt_verstuurd, concept_klaar, verstuurd of prive_archief,
 * zoals MailMans archiefregel; review MOET 1: anders kan de stap FACTUUR weghalen vóór het archiveren). Dan: betaald_gezien (bankmatch, ook een
 * gezien incasso) = is_betaald; ingevoerd (SEPA-batch of 'ingevoerd in bank') of betaald_vooraf (bevestigd als al betaald) = in_sepa; al het
 * andere (te betalen, incasso verwacht) = nog geen stap. Alleen berichten met een stap. UNION ALL over factuur.bericht en document.bericht
 * (review ZOU 4: geen gecorreleerde subquery per factuur). Alleen lezen. → [{ gmail_id, stap }]
 */
const STAP_STATUS = "('in_wachtrij','wordt_verstuurd','concept_klaar','verstuurd','prive_archief')";
function mailStappen(fdb, max) {
  const RANG = `CASE WHEN f.status NOT IN ${STAP_STATUS} THEN 0 WHEN f.betaalspoor = 'betaald_gezien' THEN 2 WHEN f.betaalspoor IN ('ingevoerd','betaald_vooraf') THEN 1 ELSE 0 END`;
  const ECHT = "f.status NOT IN ('geen_factuur','dubbel') AND f.soort = 'factuur' AND COALESCE(f.incl, 0) >= 0";
  return fdb.db.prepare(`SELECT b.message_id AS gmail_id, min(x.rang) AS rang FROM (
      SELECT f.bericht AS ber, ${RANG} AS rang FROM factuur f WHERE f.bericht IS NOT NULL AND ${ECHT}
      UNION ALL
      SELECT d.bericht AS ber, ${RANG} AS rang FROM factuur f JOIN document d ON d.id = f.document WHERE d.bericht IS NOT NULL AND ${ECHT}
    ) x JOIN bericht b ON b.id = x.ber JOIN bron r ON r.id = b.bron
    WHERE r.soort = 'verzamelpostvak' GROUP BY b.id HAVING min(x.rang) >= 1 ORDER BY b.ontvangen_op DESC LIMIT ?`).all(max || 2000)
    .filter((x) => /^[0-9a-f]{12,24}$/.test(String(x.gmail_id)))
    .map((x) => ({ gmail_id: String(x.gmail_id), stap: Number(x.rang) >= 2 ? 'is_betaald' : 'in_sepa' }));
}

module.exports = { betaalMeldingen, betaalMeldingGemeld, betaalMeldingTerug, bankDekking, mailStappen, maak, rolVoor, verwerkBericht, bankluisRonde, bankcontroleToepassen, verwerkBankbestand, archiefInvoeren, validatie, lees, startdatumVan, ronde, backupNodig, afschriftKlaarzetten, bijlagenVan, ROUTES, BEHEER, PREFIX, STAPPEN, RouteFout, soortVan, isoWeek };
