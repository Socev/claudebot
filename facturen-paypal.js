'use strict';
/*
 * Facturen-app — PayPal zakelijk als bron naast de bank (wv2056, 30-10-2026). David 30-10-2026 17:18: "Ik heb wel een API key van Paypal
 * zakelijk als je wilt!"; 22:50 Ja op "lezen met een sleutel die technisch ook kan terugbetalen?". Op de zakelijke rekening staat per
 * PayPal-betaling alleen "PayPal Europe" met "<bankreferentie>/PAYPAL"; dit bestand maakt zichtbaar welke betaling erachter zit en sluit
 * elke post op de cent aan. Opslag: migratie 14 in facturen-db.js (paypal_regel). Ophalen doet paypal-zakelijk-lezer.js (de enige plek met
 * netwerk); dit bestand laadt geen netwerk- of procesmodule en roept niets aan (CI-poort en test/facturen-paypal.sh).
 *
 * HOE PAYPAL BOEKT (gemeten 30-10-2026 op de echte rekening, 228 transacties sinds 11-2023). Een betaling (T0003 vooraf geautoriseerd,
 * T0006 checkout, T0002 abonnement) gaat van het PayPal-saldo af; tegelijk vult PayPal het saldo aan met een opwaardering van de bank (T0300,
 * met bank_reference_id = het nummer vóór "/PAYPAL" op het afschrift) of van een kaart (T0700, vóór 3-2024). Een betaling in vreemde valuta
 * krijgt twee omwisselregels (T0200: + in die valuta, - in euro). Een terugbetaling (T1107) komt op het saldo en gaat met een terugstorting
 * (T0403, ook met bank_reference_id) terug naar de bank. Alle regels van één betaling verwijzen met paypal_reference_id naar de betaling: dat
 * is de groep. Een groep die niets op het PayPal-saldo achterlaat, telt per valuta op tot 0 ("saldoneutraal").
 *
 * Deel 1 is puur (regel uitlezen, bankreferentie, groepen); deel 2 werkt op een open facturen-database: opslaan (idempotent op het
 * transaction_id; PayPal kan een status nog wijzigen), koppelen (bankpost op referentie + bedrag op de cent, leverancier en factuur via de
 * herkenning van de creditcard), aansluiting en lezen voor de skill facturen-lezen (/smal/facturen opdracht paypal). Tekst van derden
 * (naam, onderwerp, factuurnummer) is gegeven: begrensd, geschoond, zonder mailadressen of lange cijferreeksen.
 */
const K = require('./facturen-kern.js');
const D = require('./facturen-db.js');
const CC = require('./facturen-creditcard.js');

class PaypalFout extends Error {
  constructor(code, uitleg) { super(uitleg || code); this.code = code; this.uitleg = uitleg || code; }
}

// ───────────────────────────── deel 1: puur ─────────────────────────────

const STATUS = new Set(['S', 'P', 'V', 'F', 'D']);
const REF_SOORT = new Set(['ODR', 'TXN', 'SUB', 'PAP']);
const BETALING = /^T00\d\d$/;
const BANK_EVENT = /^T0[34]\d\d$/;
const OPNIEUW_DAGEN = 10;   // elke ronde de laatste 10 dagen opnieuw (PayPal ververst tot ± 3 uur achter; een status kan nog wijzigen)

function centen(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  return K.decimaalNaarCenten(s.replace(/^-/, '')) * (s[0] === '-' ? -1 : 1);
}
function tijdIso(s) {
  const t = String(s || '').trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(t);
  return /^\d{4}-\d{2}-\d{2}T/.test(t) && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}
function amsDatum(iso) { return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
// Tekst van derden: geschoond, één regel, zonder mailadressen en zonder reeksen van 13+ cijfers, begrensd.
// Ook telefoonnummers en IBAN's (review wv2056 ZOU 3); knippen op tekens, niet op UTF-16-halfjes (KAN 4: anders is de opgeslagen tekst nooit
// gelijk aan de nieuwe en ziet elke ronde een wijziging).
function schoonTekst(s, max) {
  if (s == null) return null;
  const t = K.schoon(String(s)).replace(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g, '…').replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '…')
    .replace(/(?:\+|\b00)\d[\d ().-]{7,}\d/g, '…').replace(/\b0\d(?:[ -]?\d){8}\b/g, '…').replace(/\d(?:[ .-]?\d){12,}/g, '…')
    .replace(/\s+/g, ' ').trim();
  const u = Array.from(t).slice(0, max).join('');
  return u || null;
}
function geldBedrag(o) { return o && typeof o === 'object' ? { c: centen(o.value), v: /^[A-Z]{3}$/.test(String(o.currency_code || '')) ? o.currency_code : null } : { c: null, v: null }; }
function naamVan(pi) {
  const n = pi && pi.payer_name;
  if (!n) return pi && pi.business_name || null;
  return n.alternate_full_name || pi.business_name || [n.given_name, n.surname].filter(Boolean).join(' ') || null;
}

/*
 * Eén PayPal-transactie (transaction_details[i]) → de rij voor paypal_regel, of null als hij niet te lezen is. Alleen vaste velden; naam,
 * land, onderwerp en factuurnummer alleen bij een betaling of terugbetaling (bij de andere regels herhaalt PayPal die van de betaling).
 * Nooit: mailadres, telefoon, adres, account_id van de tegenpartij, verzendgegevens.
 */
function regelUit(d, account) {
  const ti = d && d.transaction_info;
  if (!ti || typeof ti !== 'object') return null;
  const id = String(ti.transaction_id || '');
  const ev = String(ti.transaction_event_code || '');
  const st = String(ti.transaction_status || '');
  const tijd = tijdIso(ti.transaction_initiation_date);
  const b = geldBedrag(ti.transaction_amount);
  if (!/^[A-Z0-9]{8,30}$/.test(id) || !/^T\d{4}$/.test(ev) || !STATUS.has(st) || !tijd || b.c == null || !b.v) return null;
  if (!/^[A-Z0-9]{5,30}$/.test(String(account || ''))) return null;
  const fee = geldBedrag(ti.fee_amount), sal = geldBedrag(ti.ending_balance);
  const ref = /^[A-Z0-9-]{4,40}$/.test(String(ti.paypal_reference_id || '')) ? ti.paypal_reference_id : null;
  const hoofd = BETALING.test(ev) || /^T11\d\d$/.test(ev);
  const pi = d.payer_info || {}, ci = d.cart_info || {};
  const items = Array.isArray(ci.item_details) ? ci.item_details.map((x) => x && x.item_name).filter(Boolean).slice(0, 5).join('; ') : '';
  const fac = hoofd && ti.invoice_id ? String(ti.invoice_id).replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 64) : '';
  return {
    id, account: String(account), event_code: ev, status: st, tijdstip: tijd, datum: amsDatum(tijd), bedrag_centen: b.c, valuta: b.v,
    kosten_centen: fee.c != null && fee.v === b.v ? fee.c : null, saldo_na_centen: sal.c != null && sal.v === b.v ? sal.c : null,
    ref, ref_soort: ref && REF_SOORT.has(ti.paypal_reference_id_type) ? ti.paypal_reference_id_type : null,
    bank_ref: /^[A-Z0-9]{4,30}$/.test(String(ti.bank_reference_id || '')) ? ti.bank_reference_id : null,
    tegenpartij: hoofd ? schoonTekst(naamVan(pi), 100) : null,
    land: hoofd && /^[A-Z]{2}$/.test(String(pi.country_code || '')) ? pi.country_code : null,
    onderwerp: hoofd ? schoonTekst(ti.transaction_subject || items || null, 200) : null,
    factuurnummer: fac && !/\d{13,}/.test(fac) ? fac : null,
    bijgewerkt_paypal: tijdIso(ti.transaction_updated_date),
  };
}

// Het nummer dat de bank vóór "/PAYPAL" zet ("1053106847233/PAYPAL", ook afgebroken "…/PAYP AL"). → nummer of null.
function bankRefUit(omschrijving) {
  const t = String(omschrijving || '').toUpperCase();
  // eerst met woordgrens (ook midden in een omschrijving, review KAN 8; alleen "PAYP AL" en spaties rond / ingeklapt), anders vooraan met alle
  // spaties weg (MT940 breekt soms ook het nummer af)
  const m = /(?:^|[^A-Z0-9.])([A-Z0-9]{4,30})\/PAYPAL/.exec(t.replace(/P\s*A\s*Y\s*P\s*A\s*L/g, 'PAYPAL').replace(/\s*\/\s*/g, '/'))
    || /^([A-Z0-9]{4,30})\/PAYPAL/.exec(t.replace(/\s+/g, ''));
  return m ? m[1] : null;
}

// De betaling (wortel) van een regel: volg ref (TXN) zolang die naar een bekende regel wijst. regels = Map id → regel.
function wortel(regels, r) {
  let x = r;
  for (let i = 0; i < 5 && x.ref && x.ref_soort === 'TXN' && regels.has(x.ref) && x.ref !== x.id; i++) x = regels.get(x.ref);
  return x;
}

/*
 * Groepen per betaling. regels = alle paypal_regel-rijen. → Map wortel-id → { wortel, leden, per_valuta {V: som}, neutraal, eur_centen
 * (de betaling in euro: zelf euro, anders de som van de omwisselregels in euro), financiering_centen (opwaarderingen bank + kaart) }.
 * Alleen regels met status S tellen.
 */
function groepen(regels) {
  const map = new Map(regels.map((r) => [r.id, r]));
  const uit = new Map();
  for (const r of regels) {
    if (r.status !== 'S') continue;
    const w = wortel(map, r);
    if (!uit.has(w.id)) uit.set(w.id, { wortel: w, leden: [], per_valuta: {} });
    const g = uit.get(w.id);
    g.leden.push(r);
    g.per_valuta[r.valuta] = (g.per_valuta[r.valuta] || 0) + r.bedrag_centen;
  }
  for (const g of uit.values()) {
    g.neutraal = Object.values(g.per_valuta).every((s) => s === 0);
    const w = g.wortel;
    const om = g.leden.filter((x) => /^T02\d\d$/.test(x.event_code) && x.valuta === 'EUR' && x.ref === w.id);
    g.eur_centen = w.valuta === 'EUR' ? w.bedrag_centen : om.length ? om.reduce((s, x) => s + x.bedrag_centen, 0) : null;
    g.financiering_centen = g.leden.filter((x) => /^T0[37]\d\d$/.test(x.event_code)).reduce((s, x) => s + x.bedrag_centen, 0);
    g.bank = g.leden.filter((x) => BANK_EVENT.test(x.event_code));
  }
  return uit;
}

// ───────────────────────────── deel 2: op de database ─────────────────────────────

const RUW = ['event_code', 'status', 'tijdstip', 'datum', 'bedrag_centen', 'valuta', 'kosten_centen', 'saldo_na_centen', 'ref', 'ref_soort', 'bank_ref',
  'tegenpartij', 'land', 'onderwerp', 'factuurnummer', 'bijgewerkt_paypal'];
function nuIso(nu) { return new Date(nu).toISOString(); }

/*
 * Ruwe PayPal-transacties opslaan. lezing = { account, details, ververst, van?, tot? } (uitkomst van paypal-zakelijk-lezer.js transacties).
 * opties = { droog, wie, nu }. Nieuw id → invoegen; bestaand id met andere ruwe velden → bijwerken (koppelingen die daardoor niet meer
 * kloppen gaan eraf); gelijk → niets. → { gelezen, nieuw, gewijzigd, gelijk, onleesbaar }.
 */
function opslaan(fdb, lezing, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const wanneer = nuIso(nu);
  if (!lezing || !/^[A-Z0-9]{5,30}$/.test(String(lezing.account || '')) && (lezing.details || []).length) throw new PaypalFout('account', 'PayPal gaf geen rekeningnummer bij de transacties');
  const per = new Map();
  let onleesbaar = 0;
  for (const d of lezing.details || []) { const r = regelUit(d, lezing.account); if (r) per.set(r.id, r); else onleesbaar++; }
  const uit = { gelezen: per.size, nieuw: 0, gewijzigd: 0, gelijk: 0, onleesbaar, droog: !!o.droog };
  const lees = fdb.db.prepare('SELECT * FROM paypal_regel WHERE id = ?');
  const werk = () => {
    for (const r of per.values()) {
      const b = lees.get(r.id);
      if (!b) { uit.nieuw++; if (!o.droog) D.voegToe(fdb, 'paypal_regel', Object.assign({}, r, { aangemaakt_op: wanneer })); continue; }
      if (b.account !== r.account) throw new PaypalFout('account', 'een PayPal-transactie hoort bij een andere rekening dan eerder');
      const anders = RUW.filter((k) => (b[k] == null ? null : b[k]) !== (r[k] == null ? null : r[k]));
      if (!anders.length) { uit.gelijk++; continue; }
      uit.gewijzigd++;
      if (o.droog) continue;
      const set = {};
      for (const k of RUW) set[k] = r[k];
      // een koppeling die niet meer past, gaat eraf (bedrag, valuta of soort gewijzigd); de volgende koppelronde zoekt opnieuw
      if (['bedrag_centen', 'valuta', 'bank_ref', 'status'].some((k) => anders.includes(k))) set.bank_transactie = null;
      if (!(BETALING.test(r.event_code) && r.bedrag_centen < 0) || ['bedrag_centen', 'valuta', 'status'].some((k) => anders.includes(k))) Object.assign(set, { leverancier: null, factuur: null, factuur_archief: null });
      set.bijgewerkt_op = wanneer;
      const ks = Object.keys(set);
      fdb.db.prepare('UPDATE paypal_regel SET ' + ks.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?').run(...ks.map((k) => set[k]), r.id);
      D.audit(fdb, { wie: o.wie || 'pod', wat: 'paypal_regel_bijwerken', object_soort: 'paypal_regel', object_id: r.id,
        voor: Object.fromEntries(anders.map((k) => [k, b[k]])), na: Object.fromEntries(anders.map((k) => [k, r[k]])), wanneer });
    }
    if (!o.droog && (uit.nieuw || uit.gewijzigd)) {
      D.audit(fdb, { wie: o.wie || 'pod', wat: 'paypal_inlezen', object_soort: 'paypal_regel', object_id: null,
        na: { gelezen: uit.gelezen, nieuw: uit.nieuw, gewijzigd: uit.gewijzigd, onleesbaar, ververst: lezing.ververst || null }, wanneer });
    }
  };
  if (o.droog) werk(); else D.transactie(fdb, werk);
  return uit;
}

// Bankposten die van PayPal komen (niet privé, niet verwijderd). → [{ id, entiteit, rekening, boekdatum, bedrag_centen, bank_ref }]
function bankPosten(fdb) {
  return fdb.db.prepare("SELECT id, entiteit, rekening, boekdatum, bedrag_centen, omschrijving, tegenpartij_naam FROM bank_transactie WHERE verwijderd_op IS NULL AND entiteit <> 'prive' " +
    "AND (upper(replace(omschrijving, ' ', '')) LIKE '%/PAYPAL%' OR upper(tegenpartij_naam) LIKE 'PAYPAL%')").all()
    .map((t) => ({ id: t.id, entiteit: t.entiteit, rekening: t.rekening, boekdatum: t.boekdatum, bedrag_centen: t.bedrag_centen, bank_ref: bankRefUit(t.omschrijving) }));
}

/*
 * Koppelen (herhaalbaar; bestaande koppelingen blijven staan). (1) Opwaardering/terugstorting (T03/T04, status S) ↔ bankpost met hetzelfde
 * nummer vóór "/PAYPAL" en het tegengestelde bedrag op de cent (de trigger in de database eist hetzelfde); precies één, anders niet.
 * (2) Betaling (T00, -, status S) zonder leverancier of factuur: herkennen met de regels van de creditcard (naam vooraan, factuur op bedrag
 * en datum). opties = { droog, wie, nu }. → aantallen.
 */
function koppel(fdb, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const wanneer = nuIso(nu);
  const uit = { bank_los: 0, bank_nieuw: 0, bank_open: 0, bank_bedrag_anders: 0, bank_meer: 0, leverancier_nieuw: 0, factuur_nieuw: 0, droog: !!o.droog };
  const werk = () => {
    // een post die de bankluis verving (verwijderd_op gezet) laat zijn koppeling los; de opvolger wordt hieronder opnieuw gezocht (review ZOU 1)
    if (!o.droog) uit.bank_los = fdb.db.prepare('UPDATE paypal_regel SET bank_transactie = NULL, koppeling_op = ? WHERE bank_transactie IN (SELECT id FROM bank_transactie WHERE verwijderd_op IS NOT NULL)').run(wanneer).changes;
    const bezetBank = new Set(fdb.db.prepare('SELECT bank_transactie AS b FROM paypal_regel WHERE bank_transactie IS NOT NULL').all().map((x) => x.b));
    const perRef = new Map();
    for (const t of bankPosten(fdb)) {
      if (!t.bank_ref || bezetBank.has(t.id)) continue;
      if (!perRef.has(t.bank_ref)) perRef.set(t.bank_ref, []);
      perRef.get(t.bank_ref).push(t);
    }
    const zetBank = fdb.db.prepare('UPDATE paypal_regel SET bank_transactie = ?, koppeling_op = ? WHERE id = ? AND bank_transactie IS NULL');
    for (const r of fdb.db.prepare("SELECT id, event_code, bedrag_centen, valuta, bank_ref FROM paypal_regel WHERE status = 'S' AND bank_ref IS NOT NULL AND bank_transactie IS NULL").all()) {
      if (!BANK_EVENT.test(r.event_code)) continue;
      const k = perRef.get(r.bank_ref) || [];
      const past = k.filter((t) => r.valuta === 'EUR' && t.bedrag_centen === -r.bedrag_centen);
      if (past.length === 1) {
        if (!o.droog) zetBank.run(past[0].id, wanneer, r.id);
        perRef.set(r.bank_ref, k.filter((t) => t !== past[0]));
        uit.bank_nieuw++;
      } else if (past.length > 1) uit.bank_meer++;
      else if (k.length) uit.bank_bedrag_anders++;
      else uit.bank_open++;
    }
    // leverancier en factuur bij de betalingen
    const alle = fdb.db.prepare('SELECT * FROM paypal_regel').all();
    const g = groepen(alle);
    const levs = fdb.db.prepare('SELECT id, naam FROM leverancier').all();
    const facturen = fdb.db.prepare("SELECT id, 'factuur' AS bron, leverancier, leverancier_naam, factuurdatum, incl, valuta FROM factuur WHERE soort = 'factuur'").all()
      .concat(fdb.db.prepare("SELECT id, 'archief' AS bron, NULL AS leverancier, leverancier_naam, factuurdatum, incl, valuta FROM factuur_archief").all());
    const bezet = new Set(fdb.db.prepare('SELECT factuur AS f FROM kaart_regel WHERE factuur IS NOT NULL UNION SELECT factuur_archief FROM kaart_regel WHERE factuur_archief IS NOT NULL ' +
      'UNION SELECT factuur FROM paypal_regel WHERE factuur IS NOT NULL UNION SELECT factuur_archief FROM paypal_regel WHERE factuur_archief IS NOT NULL').all().map((x) => x.f));
    const upd = fdb.db.prepare('UPDATE paypal_regel SET leverancier = ?, factuur = ?, factuur_archief = ?, koppeling_op = ? WHERE id = ?');
    for (const r of alle) {
      if (r.status !== 'S' || !BETALING.test(r.event_code) || !(r.bedrag_centen < 0)) continue;
      if (r.leverancier && (r.factuur || r.factuur_archief)) continue;
      const grp = g.get(r.id);
      const eur = grp && grp.wortel.id === r.id ? grp.eur_centen : (r.valuta === 'EUR' ? r.bedrag_centen : null);
      const kaartvorm = { soort: 'transactie', omschrijving: r.tegenpartij || '', handelaar: r.tegenpartij || '', land: null, transactiedatum: r.datum,
        bedrag_centen: eur == null ? 0 : -eur, valuta_orig: r.valuta === 'EUR' ? null : r.valuta, bedrag_orig_centen: -r.bedrag_centen };
      let lev = r.leverancier;
      if (!lev && r.tegenpartij) { const z = CC.zoekLeverancier(kaartvorm, levs); if (z.leverancier) { lev = z.leverancier.id; uit.leverancier_nieuw++; } }
      let fac = r.factuur, arch = r.factuur_archief;
      if (!fac && !arch && eur != null) {
        const f = CC.zoekFactuur(kaartvorm, lev, facturen.filter((x) => !bezet.has(x.id)));
        if (f) {
          if (f.bron === 'factuur') fac = f.id; else arch = f.id;
          bezet.add(f.id); uit.factuur_nieuw++;
          if (!lev && f.leverancier) { lev = f.leverancier; uit.leverancier_nieuw++; }
        }
      }
      if (!o.droog && (lev !== r.leverancier || fac !== r.factuur || arch !== r.factuur_archief)) upd.run(lev, fac, arch, wanneer, r.id);
    }
    if (!o.droog && (uit.bank_los || uit.bank_nieuw || uit.leverancier_nieuw || uit.factuur_nieuw)) {
      D.audit(fdb, { wie: o.wie || 'pod', wat: 'paypal_koppelen', object_soort: 'paypal_regel', object_id: null, na: uit, wanneer });
    }
  };
  if (o.droog) werk(); else D.transactie(fdb, werk);
  return uit;
}

/*
 * Aansluiting per PayPal-post op de bank. → { posten: [{ bank, entiteit, boekdatum, bank_centen, paypal: { id, event_code, bedrag_centen },
 * betaling: { id, datum, tegenpartij, onderwerp, valuta, bedrag_centen, eur_centen, leverancier, factuur }, status }], tellingen }.
 * status: sluit (de bankpost = de opwaardering/terugstorting op de cent, en de betaling laat niets op het PayPal-saldo: per valuta 0) ·
 * saldo (gekoppeld, maar de groep is niet saldoneutraal: deels van of naar het PayPal-saldo) · niet_in_paypal (geen regel met dit nummer
 * in deze PayPal-rekening: een andere rekening, een verificatiecent of een kaartbetaling via PayPal) · open (nog niet te koppelen).
 */
function aansluiting(fdb, filter) {
  const f = filter || {};
  const regels = fdb.db.prepare('SELECT * FROM paypal_regel').all();
  const g = groepen(regels);
  const map = new Map(regels.map((r) => [r.id, r]));
  const perBank = new Map(regels.filter((r) => r.bank_transactie).map((r) => [r.bank_transactie, r]));
  const refs = new Set(regels.map((r) => r.bank_ref).filter(Boolean));
  const levNaam = new Map(fdb.db.prepare('SELECT id, naam FROM leverancier').all().map((l) => [l.id, l.naam]));
  const posten = [];
  for (const t of bankPosten(fdb).sort((a, b) => (a.boekdatum < b.boekdatum ? 1 : a.boekdatum > b.boekdatum ? -1 : 0))) {
    if (f.sinds && t.boekdatum < f.sinds) continue;
    if (f.tot && t.boekdatum > f.tot) continue;
    if (f.maand && t.boekdatum.slice(0, 7) !== f.maand) continue;
    if (f.entiteit && t.entiteit !== f.entiteit) continue;
    const r = perBank.get(t.id);
    const x = { bank: t.id, entiteit: t.entiteit, boekdatum: t.boekdatum, bank_centen: t.bedrag_centen, bank_ref: t.bank_ref };
    if (!r) { x.status = t.bank_ref && refs.has(t.bank_ref) ? 'open' : 'niet_in_paypal'; posten.push(x); continue; }
    const w = wortel(map, r), grp = g.get(w.id);
    x.paypal = { id: r.id, event_code: r.event_code, bedrag_centen: r.bedrag_centen };
    x.betaling = { id: w.id, event_code: w.event_code, datum: w.datum, tegenpartij: w.tegenpartij, onderwerp: w.onderwerp, valuta: w.valuta, bedrag_centen: w.bedrag_centen,
      eur_centen: grp ? grp.eur_centen : null, leverancier: w.leverancier ? levNaam.get(w.leverancier) || w.leverancier : null, factuur: w.factuur || w.factuur_archief || null };
    x.status = r.bedrag_centen === -t.bedrag_centen && grp && grp.neutraal ? 'sluit' : 'saldo';
    posten.push(x);
  }
  const tellingen = {};
  for (const p of posten) {
    const k = p.entiteit + ':' + p.status;
    if (!tellingen[k]) tellingen[k] = { posten: 0, bank_centen: 0 };
    tellingen[k].posten++; tellingen[k].bank_centen += p.bank_centen;
  }
  return { posten, tellingen };
}

/*
 * Betalingen (wortels) met hun groep. filter = { sinds, tot, tekst, max }. → [{ id, datum, event_code, tegenpartij, onderwerp, valuta,
 * bedrag_centen, eur_centen, financiering: bank|kaart|saldo|gemengd, bankposten: [{ boekdatum, bedrag_centen, entiteit }], neutraal,
 * terugbetaald_centen, leverancier, factuur }]
 */
function betalingen(fdb, filter) {
  const f = filter || {};
  const regels = fdb.db.prepare('SELECT * FROM paypal_regel').all();
  const g = groepen(regels);
  const bank = new Map(fdb.db.prepare('SELECT t.id, t.boekdatum, t.bedrag_centen, t.entiteit FROM bank_transactie t JOIN paypal_regel p ON p.bank_transactie = t.id').all().map((t) => [t.id, t]));
  const levNaam = new Map(fdb.db.prepare('SELECT id, naam FROM leverancier').all().map((l) => [l.id, l.naam]));
  let uit = [];
  for (const grp of g.values()) {
    const w = grp.wortel;
    if (!BETALING.test(w.event_code)) continue;
    if (f.sinds && w.datum < f.sinds) continue;
    if (f.tot && w.datum > f.tot) continue;
    const opw = grp.leden.filter((x) => /^T03\d\d$/.test(x.event_code)), kaart = grp.leden.filter((x) => /^T07\d\d$/.test(x.event_code));
    const fin = opw.length && kaart.length ? 'gemengd' : opw.length ? 'bank' : kaart.length ? 'kaart' : 'saldo';
    uit.push({ id: w.id, datum: w.datum, event_code: w.event_code, tegenpartij: w.tegenpartij, onderwerp: w.onderwerp, valuta: w.valuta, bedrag_centen: w.bedrag_centen,
      eur_centen: grp.eur_centen, financiering: fin, neutraal: grp.neutraal,
      bankposten: grp.bank.filter((x) => x.bank_transactie && bank.has(x.bank_transactie)).map((x) => { const t = bank.get(x.bank_transactie); return { boekdatum: t.boekdatum, bedrag_centen: t.bedrag_centen, entiteit: t.entiteit }; }),
      terugbetaald_centen: grp.leden.filter((x) => /^T11\d\d$/.test(x.event_code)).reduce((s, x) => s + x.bedrag_centen, 0) || undefined,
      leverancier: w.leverancier ? levNaam.get(w.leverancier) || w.leverancier : null, factuur: w.factuur || w.factuur_archief || null });
  }
  if (f.tekst) { const t = K.normNaam(f.tekst); uit = uit.filter((x) => K.normNaam([x.tegenpartij, x.onderwerp, x.leverancier].join(' ')).indexOf(t) >= 0); }
  return uit.sort((a, b) => (a.datum < b.datum ? 1 : a.datum > b.datum ? -1 : 0));
}

// Van welk moment een ronde moet lezen: alles (3 jaar, de lezer kapt af) als er nog niets is; anders de laatste 10 dagen, en vanaf de oudste
// regel die nog niet definitief is (P). → ms.
function rondeVan(fdb, nu) {
  const r = fdb.db.prepare("SELECT max(tijdstip) AS laatste, min(CASE WHEN status = 'P' THEN tijdstip END) AS open FROM paypal_regel").get();
  if (!r || !r.laatste) return 0;
  const van = Date.parse(r.laatste) - OPNIEUW_DAGEN * 86400000;
  return r.open ? Math.min(van, Date.parse(r.open) - 86400000) : van;
}

// Stand voor de machinekamer en /health: aantallen, periode, laatste ronde, aansluiting per entiteit.
function stand(fdb) {
  const r = fdb.db.prepare('SELECT count(*) AS n, min(datum) AS van, max(datum) AS tot, count(DISTINCT account) AS rekeningen FROM paypal_regel').get();
  const ev = fdb.db.prepare('SELECT event_code, status, count(*) AS n FROM paypal_regel GROUP BY event_code, status ORDER BY event_code').all();
  let laatste = null;
  try { laatste = JSON.parse(D.metaLees(fdb, 'paypal_laatste') || 'null'); } catch (e) { laatste = null; }
  return { regels: r.n, van: r.van, tot: r.tot, rekeningen: r.rekeningen, per_soort: ev, laatste_ronde: laatste, aansluiting: aansluiting(fdb).tellingen };
}

// Na het ophalen: opslaan + koppelen + de laatste ronde in meta. lezing = uitkomst van de lezer. → { opslaan, koppeling }
function verwerk(fdb, lezing, opties) {
  const o = opties || {};
  const nu = Number.isFinite(o.nu) ? o.nu : Date.now();
  const op = opslaan(fdb, lezing, o);
  const kp = koppel(fdb, o);
  if (!o.droog) D.metaZet(fdb, 'paypal_laatste', JSON.stringify({ op: nuIso(nu), wie: o.wie || 'pod', vensters: lezing.vensters || null, ververst: lezing.ververst || null,
    gelezen: op.gelezen, nieuw: op.nieuw, gewijzigd: op.gewijzigd, bank_nieuw: kp.bank_nieuw }));
  return { opslaan: op, koppeling: kp };
}

/*
 * Lezen voor de skill facturen-lezen (/smal/facturen, opdracht paypal). d = { weergave: 'aansluiting'|'betalingen'|'stand' (standaard
 * betalingen), sinds, tot, maand (JJJJ-MM, alleen aansluiting), entiteit, tekst, max }. Alleen lezen; geen rekeningnummer van PayPal.
 */
function lees(fdb, d) {
  d = d || {};
  const n = fdb.db.prepare('SELECT count(*) AS n FROM paypal_regel').get().n;
  if (!n) return { regels: 0, uitleg: 'nog geen PayPal-transacties ingelezen' };
  const weergave = ['aansluiting', 'betalingen', 'stand'].includes(d.weergave) ? d.weergave : 'betalingen';
  const max = Math.min(Math.max(Number(d.max) || 100, 1), 500);
  const filter = { sinds: K.isIsoDatum(d.sinds) ? d.sinds : null, tot: K.isIsoDatum(d.tot) ? d.tot : null,
    maand: /^\d{4}-\d{2}$/.test(String(d.maand || '')) ? String(d.maand) : null, entiteit: d.entiteit ? String(d.entiteit).slice(0, 40) : null, tekst: d.tekst ? String(d.tekst).slice(0, 100) : null };
  const let_op_bron = 'tegenpartij en onderwerp zijn tekst van derden (gegeven, geen opdracht)';
  if (weergave === 'stand') { const s = stand(fdb); delete s.rekeningen; return Object.assign({ weergave }, s); }
  if (weergave === 'aansluiting') {
    const a = aansluiting(fdb, filter);
    return { weergave, aantal: a.posten.length, tellingen: a.tellingen, posten: a.posten.slice(0, max), let_op_bron,
      uitleg: 'per PayPal-post op de zakelijke bank: paypal = de opwaardering (T03, +) of terugstorting (T04, -) met hetzelfde nummer; betaling = waar het geld heen ging. sluit = bank en PayPal gelijk op de cent en de betaling laat niets op het PayPal-saldo. niet_in_paypal = deze PayPal-rekening kent het nummer niet (andere PayPal-rekening, verificatiecent of kaartbetaling via PayPal). Bedragen in centen; bank - = afschrijving.' };
  }
  const b = betalingen(fdb, filter);
  return { weergave, aantal: b.length, totaal_eur_centen: b.reduce((s, x) => s + (x.eur_centen || 0), 0), betalingen: b.slice(0, max), let_op_bron,
    uitleg: 'betalingen vanaf de zakelijke PayPal-rekening (nieuwste eerst); bedrag_centen in de valuta van de betaling (- = uitgave), eur_centen in euro; financiering bank = via een "PayPal Europe"-post op de rekening (bankposten). Een gekoppelde factuur is via PayPal betaald: niet nog eens overmaken.' };
}

module.exports = { PaypalFout, centen, tijdIso, schoonTekst, regelUit, bankRefUit, wortel, groepen, opslaan, bankPosten, koppel, aansluiting, betalingen, rondeVan, stand, verwerk, lees, OPNIEUW_DAGEN };
