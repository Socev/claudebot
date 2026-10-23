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
const D = require('./facturen-db.js');

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
  GET: ['', 'lijst/<stap>', 'factuur/<id>', 'document/<id>', 'kandidaten/<id>', 'betalen', 'bank', 'uploads', 'leveranciers', 'instellingen'],
  POST: ['bevestig', 'terugdraaien', 'nagebeld', 'geen-factuur', 'toch-factuur', 'wijzig', 'ingevoerd', 'ingevoerd-ongedaan', 'opnieuw',
    'terug-naar-beoordelen', 'signaal', 'voorstel', 'koppel', 'upload', 'leverancier', 'bankluis',
    'instellingen/adres', 'instellingen/modus', 'instellingen/verzendmoment', 'instellingen/rekening', 'instellingen/uitzondering'],
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
 * 'fac' = de smalle ingang van F6 (bouwplan § 4.3): de gebruiker uit de tabel (actief), rol en entiteiten uit gebruiker_entiteit; een
 * praktijkmanager ziet nooit Privé (ook als de tabel iets anders zou zeggen). Onbekend → null (403).
 */
function rolVoor(fdb, o) {
  o = o || {};
  if (o.ingang === 'app') return { soort: 'eigenaar', wie: kort(o.wie || 'david', 100), entiteiten: null, ingang: 'app' };
  if (o.ingang !== 'fac' || !o.email) return null;
  const g = fdb.db.prepare("SELECT id, rol, actief FROM gebruiker WHERE email = ? AND ingang = 'fac'").get(String(o.email).toLowerCase());
  if (!g || g.actief !== 1) return null;
  const ents = fdb.db.prepare('SELECT entiteit FROM gebruiker_entiteit WHERE gebruiker = ?').all(g.id).map((r) => r.entiteit);
  if (g.rol === 'eigenaar') return { soort: 'eigenaar', wie: kort(o.email, 100), entiteiten: null, ingang: 'fac' };
  return { soort: 'praktijkmanager', wie: kort(o.email, 100), entiteiten: ents.filter((e) => e !== 'prive'), ingang: 'fac' };
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
  const ibans = {};
  for (const r of fdb.db.prepare('SELECT leverancier, iban FROM leverancier_iban').all()) (ibans[r.leverancier] = ibans[r.leverancier] || []).push(r.iban);
  return fdb.db.prepare('SELECT * FROM leverancier').all().map((r) => {
    const l = D.leesJson(r);
    l.ibans = ibans[l.id] || [];
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
    sluimer_tot: s.sluimer_tot, aangemaakt_op: s.aangemaakt_op, knoppen };
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
  return {
    rol: r.soort, verzendmodus: D.metaLees(fdb, 'verzendmodus'), verstuur_instelling: verstuurInstelling(fdb),
    tellers: {
      beoordelen: tel("f.status = 'te_beoordelen'", []),
      wachtrij: tel("f.status IN ('in_wachtrij','wordt_verstuurd')", []),
      betalen: tel("f.betaalspoor = 'te_betalen' AND f.status IN (" + BETAAL_STATUS.map(() => '?').join(',') + ')', BETAAL_STATUS),
      bankcontrole: signalen + voorstellen, signalen, voorstellen,
      mislukt: tel("f.status = 'verzending_mislukt'", []),
      // concept in Gmail dat na 3 dagen nog niet verstuurd is (David gooide het weg of vergat het; Fable F4 #4): zichtbaar, geen signaal
      concept_oud: tel("f.status = 'concept_klaar' AND f.bijgewerkt_op < ?", [nuIso(nu - 3 * 86400000)]),
    },
    gezondheid: gezondheid(fdb, r, nu),
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
  };
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
  for (const { id } of rijen) {
    const f = D.factuurVoorKern(fdb, id);
    const lev = leverancierKern(fdb, f.leverancier_id);
    const rij = { id: f.id, entiteit: f.entiteit, leverancier_naam: lev ? lev.naam : f.leverancier_naam, iban: f.iban, vervaldatum: f.vervaldatum,
      dringend: !!(f.vervaldatum && K.dagenTussen(vandaag, f.vervaldatum) <= 3), omschrijving: [f.nummer, f.kenmerk].filter(Boolean).join(' ') || null,
      incl: f.incl, valuta: f.valuta, ingevoerd_door: f.ingevoerd_door, ingevoerd_op: f.ingevoerd_op };
    // een factuur met een openstaande IBAN-blokkade staat er niet op (ontwerp v2 § 3), met een verwijzing naar Beoordelen
    if (K.isCreditnota(f)) continue;   // een creditnota hoort nooit op de betaallijst (wv855; staat er een oude op te_betalen, dan niet tonen)
    if (K.magBevestigen(Object.assign({}, f, { status: 'te_beoordelen' }), { leverancier: lev, ctx }).redenen.some((x) => /IBAN/.test(x))) { geblokkeerd.push({ id: f.id, reden: 'IBAN nog niet nagebeld' }); continue; }
    (f.betaalspoor === 'ingevoerd' ? ingevoerd : teBetalen).push(rij);
  }
  return { te_betalen: teBetalen, ingevoerd_niet_gezien: ingevoerd, geblokkeerd };
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
  const voorstellen = fdb.db.prepare("SELECT v.* FROM voorstel v JOIN bank_transactie t ON t.id = v.transactie WHERE v.status = 'open' AND t.verwijderd_op IS NULL AND " + vf + ' ORDER BY v.id LIMIT ' + LIJST_MAX)
    .all(...vp).map((v) => ({ id: v.id, methode: v.methode, zekerheid: v.zekerheid, transactie: txKort(tx.get(v.transactie)),
      facturen: (json(v.facturen, []) || []).map((id) => fq.get(id, ...fp)).filter(Boolean).map((f) => factuurKort(f)) }));
  // balk per week (laatste 8 weken, afschrijvingen): bij een factuur / bekende uitzondering / te bekijken
  const [tf, tp] = eigenaarFilter(r, 't');
  const van = K.plusDagen(vandaag, -56);
  const weken = {};
  for (const t of fdb.db.prepare('SELECT t.id, t.boekdatum, t.categorie, (SELECT count(*) FROM koppeling k WHERE k.transactie = t.id) AS k FROM bank_transactie t ' +
    'WHERE t.verwijderd_op IS NULL AND t.bedrag_centen < 0 AND t.boekdatum >= ? AND ' + tf).all(van, ...tp)) {
    const w = isoWeek(t.boekdatum);
    const x = weken[w] = weken[w] || { week: w, factuur: 0, uitzondering: 0, te_bekijken: 0 };
    if (t.k > 0) x.factuur++; else if (t.categorie) x.uitzondering++; else x.te_bekijken++;
  }
  return { signalen: open.map(signaalKort), geleerd: geleerd.map(signaalKort), voorstellen, weken: Object.values(weken).sort((a, b) => (a.week < b.week ? -1 : 1)) };
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
  const pot = isEig(r) ? fdb.db.prepare('SELECT a.id, a.periode, a.status, a.bijgewerkt_op FROM pot_afschrift a ORDER BY a.periode DESC LIMIT 6').all() : undefined;
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
    for (const k of Object.keys(velden)) {
      if (!WIJZIG[k]) weiger(400, 'veld ' + kort(k, 30) + ' is niet te wijzigen');
      const v = WIJZIG[k](velden[k], fdb, r);
      const huidig = k === 'leverancier' ? f.leverancier_id : f[k];
      if (v === huidig) continue;
      voor[k] = huidig; na[k] = v;
      if (k === 'leverancier') nieuw.leverancier_id = v; else nieuw[k] = v;
    }
    if (!Object.keys(na).length) return { gewijzigd: false };
    const ctx = kernCtx(fdb, nu);
    const lev = leverancierKern(fdb, nieuw.leverancier_id);
    const va = K.valideer(nieuw, ctx, { leverancier: lev });
    const ip = K.ibanPoort(nieuw, lev, ctx);
    const wanneer = nuIso(nu);
    const u = fdb.db.prepare('UPDATE factuur SET entiteit = ?, betaalwijze = ?, iban = ?, nummer = ?, kenmerk = ?, factuurdatum = ?, vervaldatum = ?, excl = ?, btw = ?, incl = ?, ' +
      'soort = ?, leverancier = ?, controles = ?, intern = ?, iban_nieuw = ?, ibans_onbekend = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND versie = ? AND status = ?')
      .run(nieuw.entiteit || null, nieuw.betaalwijze, nieuw.iban || null, nieuw.nummer || null, nieuw.kenmerk || null, nieuw.factuurdatum || null, nieuw.vervaldatum || null,
        nieuw.excl, nieuw.btw, nieuw.incl, nieuw.soort, nieuw.leverancier_id || null, JSON.stringify(va.controles), va.intern ? 1 : 0, ip.iban_nieuw ? 1 : 0,
        JSON.stringify(ip.onbekend), wanneer, f.id, f.versie, 'te_beoordelen');
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd; laad hem opnieuw');
    for (const k of Object.keys(na)) besluitRij(fdb, f.id, K.besluit('wijzigen', k, na[k] == null ? null : (k === 'iban' ? eind4(na[k]) : na[k]), 'mens', 'met de hand gewijzigd'), r.wie, wanneer);
    // alleen de namen van de velden: bedrag, nummer of kenmerk uit een stuk horen niet in de audit (de waarden staan in de besluitrijen; diffreview wv833 #1)
    D.audit(fdb, { wie: r.wie, wat: 'factuur_wijzigen', object_soort: 'factuur', object_id: f.id, entiteit: nieuw.entiteit || f.entiteit,
      na: { velden: Object.keys(na) }, wanneer });
    const nu2 = D.factuurVoorKern(fdb, f.id);
    return { gewijzigd: true, iban_poort: { iban_nieuw: ip.iban_nieuw, reden: ip.reden }, bevestigen: K.magBevestigen(nu2, { leverancier: lev, ctx }), versie: nu2.versie };
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
    const ov = K.betaalspoorOvergang(f.betaalspoor, ongedaan ? 'ongedaan' : 'ingevoerd_in_bank');
    if (!ov.ok) weiger(409, 'kan niet: ' + ov.reden);
    const wanneer = nuIso(nu);
    const u = fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, ingevoerd_door = ?, ingevoerd_op = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
      .run(ov.naar, ongedaan ? null : r.wie, ongedaan ? null : wanneer, wanneer, f.id, f.betaalspoor);
    if (u.changes !== 1) weiger(409, 'de factuur is intussen gewijzigd');
    D.audit(fdb, { wie: r.wie, wat: ongedaan ? 'ingevoerd_ongedaan' : 'ingevoerd_in_bank', object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit,
      voor: { betaalspoor: f.betaalspoor }, na: { betaalspoor: ov.naar }, wanneer });
    return { betaalspoor: ov.naar };
  });
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
      const ov = K.betaalspoorOvergang(f.betaalspoor, g.gebeurtenis);
      if (!ov.ok) weiger(409, 'betaalspoor: ' + ov.reden);
      fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, betaald_gezien_op = CASE WHEN ? = \'betaald_gezien\' THEN ? ELSE betaald_gezien_op END, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
        .run(ov.naar, ov.naar, dagAmsterdam(nu), wanneer, f.id, f.betaalspoor);
      D.audit(fdb, { wie: r.wie, wat: 'betaalspoor_' + g.gebeurtenis, object_soort: 'factuur', object_id: f.id, entiteit: f.entiteit, voor: { betaalspoor: f.betaalspoor }, na: { betaalspoor: ov.naar }, wanneer });
      return { actie: g.actie, factuur: f.id, betaalspoor: ov.naar };
    }
    case 'betaallijst': return { actie: g.actie, factuur: g.factuur };
    case 'koppelen': return Object.assign({ actie: g.actie }, koppelIntern(fdb, r, String(g.transactie || ''), g.factuur, true, nu));
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
  if (volledig && f.betaalspoor && f.betaalspoor !== 'betaald_gezien') {
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
    if (v.status !== 'open') weiger(409, 'het voorstel is al afgehandeld');
    const wanneer = nuIso(nu);
    const uit = { koppelingen: [] };
    if (keuze === 'bevestig') for (const fid of json(v.facturen, []) || []) uit.koppelingen.push(koppelIntern(fdb, r, v.transactie, fid, true, nu));
    fdb.db.prepare("UPDATE voorstel SET status = ?, afgehandeld_door = ?, afgehandeld_op = ? WHERE id = ? AND status = 'open'").run(keuze === 'bevestig' ? 'bevestigd' : 'afgewezen', r.wie, wanneer, v.id);
    D.audit(fdb, { wie: r.wie, wat: 'voorstel_' + keuze, object_soort: 'voorstel', object_id: String(v.id), entiteit: v.entiteit, wanneer });
    return uit;
  });
}

// ───────────────────────────── bankcontrole toepassen ─────────────────────────────

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
  };
  const uit = B.bankcontrole(inv);
  const tel = { koppelingen: 0, voorstellen: 0, uitzonderingen: 0, betaald_gezien: 0, signalen: 0, heropend: 0 };
  const txMap = new Map(transacties.map((t) => [t.id, t]));
  for (const k of uit.koppelingen) tel.koppelingen += fdb.db.prepare('INSERT INTO koppeling (transactie, factuur, bron, methode, zekerheid, alleen_eigenaar, wanneer) VALUES (?, ?, \'auto\', ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(k.transactie, k.factuur, k.methode || null, k.zekerheid == null ? null : Math.min(1, Math.max(0, k.zekerheid)), k.alleen_eigenaar ? 1 : 0, wanneer).changes;
  for (const v of uit.voorstellen) tel.voorstellen += fdb.db.prepare('INSERT INTO voorstel (sleutel, transactie, facturen, methode, zekerheid, details, alleen_eigenaar, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (sleutel) DO NOTHING')
    .run(v.sleutel, v.transactie, JSON.stringify(v.facturen), v.methode || null, v.zekerheid == null ? null : v.zekerheid,
      JSON.stringify({ alternatieven: v.alternatieven || [], tegenpartij_geborgd: !!v.tegenpartij_geborgd }), v.alleen_eigenaar ? 1 : 0, wanneer).changes;
  for (const u of uit.uitzonderingen) tel.uitzonderingen += fdb.db.prepare('UPDATE bank_transactie SET categorie = ?, uitzondering = ? WHERE id = ? AND categorie IS NULL')
    .run(u.categorie, u.uitzondering || null, u.transactie).changes;
  for (const b of uit.betaalspoor) {
    const tx = uit.koppelingen.filter((k) => k.factuur === b.factuur).map((k) => txMap.get(k.transactie)).filter(Boolean)[0];
    tel.betaald_gezien += fdb.db.prepare('UPDATE factuur SET betaalspoor = ?, betaald_gezien_op = ?, bijgewerkt_op = ?, versie = versie + 1 WHERE id = ? AND betaalspoor = ?')
      .run(b.naar, tx ? tx.boekdatum : vandaag, wanneer, b.factuur, b.van).changes;
  }
  for (const s of uit.signalen) tel.signalen += signaalInvoegen(fdb, s, wanneer);
  for (const h of uit.heropenen) tel.heropend += fdb.db.prepare("UPDATE signaal SET status = 'open', sluimer_tot = NULL WHERE sleutel = ? AND status = 'afgehandeld'").run(h.sleutel).changes;
  return tel;
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
 * stapelen niets. Het ruwe bestand wordt nooit bewaard (er kan Privé in staan); alleen de zakelijke regels. Daarna de bankcontrole.
 */
function verwerkBankbestand(fdb, r, bytes, naam, nu) {
  const sha = D.sha256(bytes);
  return D.transactie(fdb, function () {
    if (fdb.db.prepare('SELECT 1 FROM bank_bestand WHERE sha256 = ?').get(sha)) return { soort: 'bank', al_bekend: true, nieuw: 0 };
    const rekeningen = fdb.db.prepare('SELECT id, iban, entiteit, bank_formaat, controle, alleen_eigenaar FROM rekening').all();
    const lees = B.leesBankbestand(new Uint8Array(bytes), { rekeningen });
    if (!lees.ok) weiger(422, lees.uitleg, { code: lees.fout });
    if (!isEig(r) && lees.transacties.some((t) => t.alleen_eigenaar || !magEntiteit(r, t.entiteit))) weiger(403, 'dit bestand bevat een rekening die alleen de eigenaar mag inlezen');
    const wanneer = nuIso(nu), bid = D.nieuwId();
    const perId = new Map(rekeningen.map((k) => [K.ibanNorm(k.iban), k]));
    D.voegToe(fdb, 'bank_bestand', { id: bid, sha256: sha, formaat: lees.formaat, naam: kort(naam, 255), aantal: lees.transacties.length, prive_weggegooid: lees.prive_weggegooid,
      per_rekening: lees.per_rekening, geupload_door: r.wie, geupload_op: wanneer });
    let nieuw = 0;
    for (const t of lees.transacties) {
      const k = perId.get(t.eigen_iban);
      nieuw += transactieInvoegen(fdb, Object.assign({}, t, { id: D.nieuwId(), bestand: bid, rekening: k.id, bankluis_sleutel: null, bestand_op: wanneer, aangemaakt_op: wanneer }));
    }
    for (const iban of Object.keys(lees.per_rekening)) fdb.db.prepare('UPDATE rekening SET laatste_invoer_op = ? WHERE iban = ?').run(wanneer, iban);
    const controle = bankcontroleToepassen(fdb, nu);
    D.audit(fdb, { wie: r.wie, wat: 'bankbestand_upload', object_soort: 'bank_bestand', object_id: bid,
      na: { formaat: lees.formaat, aantal: lees.transacties.length, nieuw, prive_weggegooid: lees.prive_weggegooid }, wanneer });
    return { soort: 'bank', formaat: lees.formaat, bestand: bid, aantal: lees.transacties.length, nieuw, al_bekend_regels: lees.transacties.length - nieuw,
      prive_weggegooid: lees.prive_weggegooid, rekeningen: Object.entries(lees.per_rekening).map(([iban, n]) => ({ rekening: eind4(iban), aantal: n })), controle };
  });
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
 * Nog door niets aangeroepen: de POT-App gebruikt tot F5 het mailconcept-pad (de POT heeft nog geen afschriftadres; stamgegeven F5).
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
    const bijlagen = ids.map((x) => ({ naam: x.naam, mime: x.soort === 'pdf' ? 'application/pdf' : 'application/octet-stream', sha256: x.sha256 }));
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
function ronde(fdb, o) {
  const nu = o.nu || Date.now();
  const uit = { ok: true };
  try { const b = D.backup(fdb, { nu }); uit.backup = { ok: true, dag: b.dag, bytes: b.bytes, verwijderd: b.verwijderd.length }; }
  catch (e) { uit.ok = false; uit.backup = { ok: false, fout: kort(e && e.code || 'fout', 60) }; }
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
        if (rest === 'uploads') return ok(uploads(fdb, r, nu));
        if (rest === 'leveranciers') return ok(leveranciers(fdb, r));
        if (rest === 'instellingen') return ok(instellingen(fdb, r));
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
        case 'signaal': return ok(signaalRoute(fdb, r, d, nu), 'signaal ' + kort(d.knop, 30));
        case 'voorstel': return ok(voorstelRoute(fdb, r, d, nu));
        case 'koppel': return ok(D.transactie(fdb, () => koppelIntern(fdb, r, String(d.transactie || ''), d.factuur, d.volledig !== false, nu)));
        case 'upload': return ok(upload(fdb, r, d, nu, vo), 'upload');
        case 'leverancier': return ok(leverancierRoute(fdb, r, d, nu));
        case 'bankluis': eisEigenaar(r); return ok(bankluisRonde(fdb, { nu, pad: v.bankluisPad }), 'bankluis');
        case 'instellingen/adres': return ok(adres(fdb, r, d, nu, vo), 'adres ' + kort(d.entiteit, 20));
        case 'instellingen/modus': return ok(modus(fdb, r, d, nu, vo), 'modus ' + kort(d.modus, 10));
        case 'instellingen/verzendmoment': return ok(verzendmoment(fdb, r, d, nu));
        case 'instellingen/rekening': return ok(rekening(fdb, r, d, nu));
        case 'instellingen/uitzondering': return ok(uitzondering(fdb, r, d, nu));
      }
      weiger(404, 'onbekend');
    } catch (e) { return alsFout(e, opties.fout); }
  }
  return { app, ronde, bankluisRonde, verwerkBericht, rolVoor, ROUTES, BEHEER };
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

module.exports = { maak, rolVoor, verwerkBericht, bankluisRonde, bankcontroleToepassen, ronde, backupNodig, afschriftKlaarzetten, bijlagenVan, ROUTES, BEHEER, PREFIX, STAPPEN, RouteFout, soortVan, isoWeek };
