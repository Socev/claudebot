'use strict';
/*
 * facturen-validatie.js — factuurvalidatie op de bankhistorie (wv944, 23-10-2026). Bouwplan: vault "01_Ontwikkeling/Facturen-app - bouwplan
 * (App, 22-10-2026).md" § 11 (bankhistorie en validatie); ontwerp en Fable-review in /opt/data/mk-scripts/wv944/.
 *
 * WAAROM (David, 23-10-2026 16:33): "Ik wil juist de bankexports er definitief in hebben … zodat jij er juist meerdere dingen mee kunt doen,
 * denk aan Validatie van facturen. Je kunt historische facturen opzoeken, verifiëren hoe ze betaald zijn (automatische incasso),
 * frequentie, etc etc: validatie!"
 *
 * PUUR (zelfde CI-poort als facturen-kern.js en facturen-bank.js): geen bestand-, netwerk- of procesmodule, geen klok. `vandaag` komt van de
 * beller. Alles wordt op aanvraag berekend uit de bankregels (Facturen-database) en de facturen (Facturen + het FV2-archief); er komt geen
 * signaal of melding uit voort. Rollen filtert facturen.js vóór de aanroep (alleen-eigenaar-regels gaan nooit naar een praktijkmanager).
 *
 * Bedragen in centen; afschrijvingen zijn negatief in de bankregels, in de uitkomst positief ("betaald").
 */
const { ibanNorm, normNaam, dagenTussen, plusDagen, isIsoDatum } = require('./facturen-kern.js');

// Salaris- en personeelsregels zijn hier gewone regels (wv945, David 23-10-2026: "Salarisbetalingen mogen gewoon ingezien").

// ───────────────────────────── tegenpartij ─────────────────────────────

// Sleutel van een tegenpartij: IBAN, anders incassant-id, anders de genormaliseerde naam.
function tegenpartijSleutel(t) {
  const iban = ibanNorm(t && t.tegenpartij_iban);
  if (iban) return 'iban:' + iban;
  if (t && t.incassant_id) return 'inc:' + String(t.incassant_id).trim().toUpperCase();
  const n = normNaam(t && t.tegenpartij_naam);
  return n ? 'naam:' + n : null;
}
function betaalwijzeVan(t) {
  if (t.is_incasso) return 'incasso';
  const ty = String(t.transactietype || '');
  if (/BEA|Betaalautomaat|Betaalpas|Apple Pay|Google Pay|GEA|Geldautomaat/i.test(ty)) return 'kaart';
  if (/iDEAL|Wero/i.test(ty)) return 'ideal';
  if (/Periodieke/i.test(ty)) return 'periodieke_overboeking';
  if (/creditcard|ICS\b|American Express/i.test(ty + ' ' + (t.tegenpartij_naam || ''))) return 'creditcard';
  return 'overboeking';
}
function mediaan(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
// Frequentie uit de mediaan van de tussenpozen (dagen) tussen betaaldagen.
function frequentieVan(datums) {
  const d = Array.from(new Set(datums)).sort();
  if (d.length < 3) return { soort: d.length <= 1 ? 'eenmalig' : 'onbekend', interval_dagen: d.length === 2 ? dagenTussen(d[0], d[1]) : null };
  const gaps = [];
  for (let i = 1; i < d.length; i++) gaps.push(dagenTussen(d[i - 1], d[i]));
  const m = mediaan(gaps);
  const soort = m <= 10 ? 'week' : m <= 20 ? 'twee_weken' : m <= 45 ? 'maand' : m <= 75 ? 'twee_maanden' : m <= 120 ? 'kwartaal' : m <= 220 ? 'halfjaar' : m <= 420 ? 'jaar' : 'onregelmatig';
  // regelmatig = ≥ 70 % van de tussenpozen binnen 35 % van de mediaan
  const binnen = gaps.filter((g) => Math.abs(g - m) <= Math.max(4, m * 0.35)).length;
  return { soort: binnen / gaps.length >= 0.7 ? soort : 'onregelmatig', interval_dagen: m, regelmaat: Math.round((binnen / gaps.length) * 100) / 100 };
}

/*
 * Profielen per tegenpartij over de afschrijvingen. transacties: bankregels (bedrag_centen negatief = af). opties: { richting: 'af'|'bij'|'beide' }.
 * → Map sleutel → profiel { sleutel, namen, ibans, incassant_ids, entiteiten, aantal, totaal_centen, betaalwijze, betaalwijzen,
 *   frequentie, gebruikelijk_centen, min_centen, max_centen, eerste, laatste, per_jaar, laatste_bedrag_centen, alleen_eigenaar }
 */
function profielen(transacties, opties) {
  const richting = (opties && opties.richting) || 'af';
  const groepen = new Map();
  for (const t of transacties || []) {
    if (t.verwijderd_op) continue;
    const af = t.bedrag_centen < 0;
    if ((richting === 'af' && !af) || (richting === 'bij' && af)) continue;
    const k = tegenpartijSleutel(t);
    if (!k) continue;
    if (!groepen.has(k)) groepen.set(k, []);
    groepen.get(k).push(t);
  }
  const uit = new Map();
  for (const [k, lijst] of groepen) uit.set(k, profielVan(k, lijst));
  return uit;
}
function profielVan(k, lijst) {
  lijst = lijst.slice().sort((a, b) => (a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : 0));
  const bedragen = lijst.map((t) => Math.abs(t.bedrag_centen));
  const wijzen = {};
  for (const t of lijst) { const w = betaalwijzeVan(t); wijzen[w] = (wijzen[w] || 0) + 1; }
  const top = Object.entries(wijzen).sort((a, b) => b[1] - a[1])[0];
  const perJaar = {};
  for (const t of lijst) { const j = t.boekdatum.slice(0, 4); const x = perJaar[j] = perJaar[j] || { aantal: 0, totaal_centen: 0 }; x.aantal++; x.totaal_centen += Math.abs(t.bedrag_centen); }
  const tel = (f) => Array.from(new Set(lijst.map(f).filter(Boolean)));
  return {
    sleutel: k, namen: tel((t) => t.tegenpartij_naam).slice(0, 5), ibans: tel((t) => ibanNorm(t.tegenpartij_iban)), incassant_ids: tel((t) => t.incassant_id),
    entiteiten: tel((t) => t.entiteit), aantal: lijst.length, totaal_centen: bedragen.reduce((a, b) => a + b, 0),
    betaalwijze: top ? top[0] : null, betaalwijze_aandeel: top ? Math.round((top[1] / lijst.length) * 100) / 100 : null, betaalwijzen: wijzen,
    frequentie: frequentieVan(lijst.map((t) => t.boekdatum)), gebruikelijk_centen: mediaan(bedragen),
    min_centen: Math.min(...bedragen), max_centen: Math.max(...bedragen), eerste: lijst[0].boekdatum, laatste: lijst[lijst.length - 1].boekdatum,
    laatste_bedrag_centen: bedragen[bedragen.length - 1], per_jaar: perJaar, alleen_eigenaar: lijst.some((t) => !!t.alleen_eigenaar),
  };
}

// ───────────────────────────── bedragpatroon (wv1317) ─────────────────────────────

/*
 * Gebruikelijke bandbreedte van de betalingen aan één tegenpartij (David 26-10-2026: "Wat is de gebruikelijke range, en waarbuiten is het
 * afwijkend?"). lijst = afschrijvingen aan die tegenpartij (alle data mag mee; alleen de laatste 12 maanden tellen), vandaag = JJJJ-MM-DD,
 * bedrag = het te beoordelen bedrag in centen (positief, mag ontbreken), opties.zonder = id van de regel zelf (telt niet mee).
 * Band: 10e tot 90e percentiel (een losse uitschieter valt erbuiten), opgerekt tot de laatste drie betalingen (een indexatie of nieuwe
 * maandprijs hoort er meteen bij); afwijkend = buiten de band met een marge van max(€ 5, 3 % van de mediaan). Minder dan drie betalingen:
 * geen patroon (null). → { aantal, laag_centen, hoog_centen, mediaan_centen, marge_centen, frequentie, sinds, oordeel ('binnen'|'boven'|'onder'|null) }
 */
function bedragPatroon(lijst, vandaag, bedrag, opties) {
  if (!isIsoDatum(vandaag)) return null;
  const zonder = opties && opties.zonder;
  const van = plusDagen(vandaag, -365);
  const l = (lijst || []).filter((t) => !t.verwijderd_op && t.bedrag_centen < 0 && t.id !== zonder && isIsoDatum(t.boekdatum) && t.boekdatum >= van && t.boekdatum <= vandaag)
    .sort((a, b) => (a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : 0));
  if (l.length < 3) return null;
  const b = l.map((t) => -t.bedrag_centen), s = b.slice().sort((x, y) => x - y);
  const pct = (p) => s[Math.floor(p * (s.length - 1))];
  const laatste = b.slice(-3);
  const laag = Math.min(pct(0.1), ...laatste), hoog = Math.max(pct(0.9), ...laatste);
  const med = mediaan(b), marge = Math.max(500, Math.round(med * 0.03));
  const x = Number.isSafeInteger(bedrag) ? Math.abs(bedrag) : null;
  return { aantal: l.length, laag_centen: laag, hoog_centen: hoog, mediaan_centen: med, marge_centen: marge, frequentie: frequentieVan(l.map((t) => t.boekdatum)).soort,
    sinds: l[0].boekdatum, oordeel: x === null ? null : x > hoog + marge ? 'boven' : x < laag - marge ? 'onder' : 'binnen' };
}

// ───────────────────────────── rekening uit de bankhistorie (wv1323) ─────────────────────────────
/*
 * David 26-10-2026: "'Dit IBAN is van bedrijf Z' (wat een 100% koppeling oplevert qua entiteit, want uniek)"; 12:31 Ja: een vaak betaald
 * rekeningnummer mag na zijn Ja het nabellen vervangen, een echt nieuw nummer blijft nabellen. De eis: ≥ 3 afschrijvingen met een naam, de
 * eerste en de laatste ≥ 60 dagen uit elkaar, en steeds dezelfde naam. "Dezelfde naam" = elke gespelde naam is verwant aan de meest
 * gebruikte: zonder rechtsvorm, leestekens en spaties staat de een in de ander (gemeten 26-10 op de echte bankregels: "Mediq Nederland B.V." /
 * "Mediq", "A.M.C. Roskott" / "AMC Roskott", "LvN" / "LvN Huisartswaarneming" tellen als één naam; "Xebia" / "G-company" en een
 * salarisbureau onder twee bedrijfsnamen niet — die blijven nabellen). Verwant is bewust streng: een twijfelgeval kost een telefoontje.
 */
const FEIT_MIN_BETALINGEN = 3, FEIT_MIN_DAGEN = 60, FEIT_MIN_NAAM = 3;
function compactNaam(s) { return normNaam(s).replace(/ /g, ''); }
// Voorletters + achternaam ("M. den Uijl") tegen een voluit geschreven naam ("Marijke den Uijl", "Mattijs Volman Waarnemend Huisarts"): de
// rest na de voorletters (≥ 4 tekens) staat erin en de eerste letter klopt (gemeten 26-10: zo spellen bank en waarnemersfactuur dezelfde persoon).
function voorletterVerwant(kort, lang) {
  const w = normNaam(kort).split(' ').filter(Boolean);
  let i = 0;
  while (i < w.length - 1 && w[i].length === 1) i++;
  if (i === 0) return false;
  const rest = w.slice(i).join(''), l = compactNaam(lang);
  return rest.length >= 4 && l.indexOf(rest) > 0 && l[0] === w[0];
}
function naamVerwant(a, b) {
  const x = compactNaam(a), y = compactNaam(b);
  if (x.length < FEIT_MIN_NAAM || y.length < FEIT_MIN_NAAM) return false;
  return x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0 || voorletterVerwant(a, b) || voorletterVerwant(b, a);
}
/*
 * lijst = bankregels met tegenpartij_iban = dit IBAN (alle entiteiten; de beller filtert verwijderde regels en de richting niet: dat doet
 * deze functie). → { aantal, eerste, laatste, dagen, naam (meest gebruikte spelling), namen: [{ naam, aantal }] (≤ 4), entiteiten, ok, reden }
 */
function ibanHistorie(lijst) {
  const l = (lijst || []).filter((t) => !t.verwijderd_op && t.bedrag_centen < 0 && isIsoDatum(t.boekdatum) && compactNaam(t.tegenpartij_naam).length >= FEIT_MIN_NAAM)
    .sort((a, b) => (a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : 0));
  if (!l.length) return { aantal: 0, ok: false, reden: 'geen betalingen met een naam' };
  const tel = new Map();
  for (const t of l) { const n = String(t.tegenpartij_naam).trim(); tel.set(n, (tel.get(n) || 0) + 1); }
  // meest gebruikt; bij gelijkspel de langste (meestal de volledige naam), dan alfabetisch (vaste uitkomst)
  const namen = Array.from(tel, ([naam, aantal]) => ({ naam, aantal })).sort((a, b) => b.aantal - a.aantal || b.naam.length - a.naam.length || (a.naam < b.naam ? -1 : 1));
  const hoofd = namen[0].naam;
  const eerste = l[0].boekdatum, laatste = l[l.length - 1].boekdatum, dagen = dagenTussen(eerste, laatste);
  const uit = { aantal: l.length, eerste, laatste, dagen, naam: hoofd, namen: namen.slice(0, 4), aantal_namen: namen.length,
    entiteiten: Array.from(new Set(l.map((t) => t.entiteit).filter(Boolean))).sort(), ok: false, reden: null };
  if (l.length < FEIT_MIN_BETALINGEN) uit.reden = 'minder dan ' + FEIT_MIN_BETALINGEN + ' betalingen';
  else if (dagen < FEIT_MIN_DAGEN) uit.reden = 'korter dan ' + FEIT_MIN_DAGEN + ' dagen';
  else if (namen.some((n) => !naamVerwant(n.naam, hoofd))) uit.reden = 'verschillende namen';
  else uit.ok = true;
  return uit;
}

// ───────────────────────────── betaling van een factuur ─────────────────────────────

function genormKenmerk(s) { return String(s || '').replace(/[\s.\-/]/g, '').toUpperCase(); }
// Kenmerken die niets zeggen (SEPA-vulsel)
const LEEG_KENMERK = new Set(['NOTPROVIDED', 'NOTAVAILABLE', 'NONREF', 'NONE', 'ONBEKEND']);
function echtKenmerk(s) { const k = genormKenmerk(s); return k.length >= 5 && !LEEG_KENMERK.has(k) ? k : null; }
/*
 * Is deze factuur betaald, wanneer, hoe en met welk bedrag? factuur: { id, entiteit, nummer, kenmerk, incl (centen), iban, factuurdatum,
 * vervaldatum, leverancier_naam?, incassant_ids? }. transacties: bankregels van die entiteit. opties: { koppelingen: [transactie-id] }
 * (uit de Facturen-koppelingen, dan staat het vast).
 * → { betaald, zekerheid ('vast'|'hoog'|'middel'|null), wanneer, hoe, bedrag_centen, transacties: [id], reden }
 */
function betalingVan(f, transacties, opties) {
  opties = opties || {};
  const txs = (transacties || []).filter((t) => !t.verwijderd_op && t.bedrag_centen < 0 && (!f.entiteit || t.entiteit === f.entiteit));
  const uit = (lijst, zekerheid, reden) => ({
    betaald: true, zekerheid, reden, wanneer: lijst.map((t) => t.boekdatum).sort().pop(), hoe: betaalwijzeVan(lijst[0]),
    bedrag_centen: lijst.reduce((a, t) => a + Math.abs(t.bedrag_centen), 0), transacties: lijst.map((t) => t.id),
  });
  const gekoppeld = new Set(opties.koppelingen || []);
  if (gekoppeld.size) { const l = txs.filter((t) => gekoppeld.has(t.id)); if (l.length) return uit(l, 'vast', 'gekoppeld in Facturen'); }
  const incl = Number.isSafeInteger(f.incl) ? Math.abs(f.incl) : null;
  const datum = isIsoDatum(f.factuurdatum) ? f.factuurdatum : null;
  // grenzen één keer berekenen en als tekst vergelijken (JJJJ-MM-DD): O(T) per factuur zonder datumobjecten (Fable diffreview wv944 #1)
  const vVan = datum ? plusDagen(datum, -45) : null, vTot = datum ? plusDagen(datum, 120) : null;
  const venster = (t) => !datum || (t.boekdatum >= vVan && t.boekdatum <= vTot);
  // 1. kenmerk of factuurnummer in kenmerk/omschrijving (≥ 5 tekens, anders te toevallig)
  const sleutels = [echtKenmerk(f.kenmerk), echtKenmerk(f.nummer)].filter(Boolean);
  if (sleutels.length) {
    const l = txs.filter((t) => venster(t) && sleutels.some((s) => genormKenmerk(t.kenmerk) === s || genormKenmerk(t.omschrijving).includes(s)));
    if (l.length) return uit(l, incl === null || l.reduce((a, t) => a + Math.abs(t.bedrag_centen), 0) === incl ? 'hoog' : 'middel', 'kenmerk of factuurnummer in de betaling');
  }
  if (incl === null) return { betaald: false, zekerheid: null, reden: 'geen bedrag op de factuur', transacties: [] };
  // 2. IBAN + bedrag, of incasso van deze leverancier met hetzelfde bedrag
  const iban = ibanNorm(f.iban);
  const inc = new Set((f.incassant_ids || []).map((x) => String(x).trim().toUpperCase()));
  const kand = txs.filter((t) => venster(t) && Math.abs(t.bedrag_centen) === incl &&
    ((iban && ibanNorm(t.tegenpartij_iban) === iban) || (t.is_incasso && t.incassant_id && inc.has(String(t.incassant_id).trim().toUpperCase()))));
  if (kand.length) {
    // dichtst bij de factuurdatum
    kand.sort((a, b) => Math.abs(dagenTussen(datum || a.boekdatum, a.boekdatum)) - Math.abs(dagenTussen(datum || b.boekdatum, b.boekdatum)));
    return uit([kand[0]], kand.length === 1 ? 'hoog' : 'middel', kand[0].is_incasso ? 'incasso van deze leverancier, zelfde bedrag' : 'zelfde IBAN en bedrag');
  }
  // 3. zelfde naam en bedrag (zwakker)
  const naam = normNaam(f.leverancier_naam);
  if (naam && naam.length >= 4) {
    const l = txs.filter((t) => venster(t) && Math.abs(t.bedrag_centen) === incl && normNaam(t.tegenpartij_naam).includes(naam));
    if (l.length) return uit([l[0]], 'middel', 'zelfde naam en bedrag');
  }
  return { betaald: false, zekerheid: null, reden: 'geen betaling gevonden', transacties: [] };
}

// ───────────────────────────── controles ─────────────────────────────

/*
 * Controles over de stand (op aanvraag, geen signalen). inv = { vandaag, transacties, facturen (Facturen + archief, met betaling al
 * berekend of niet), dekking: [{ van, tot }] (perioden waarin facturen volledig zouden moeten zijn: FV2-periode en vanaf de startdatum),
 * venster_dagen (voor "nieuwe IBAN" en "afwijkend bedrag", standaard 120) }.
 * → { incasso_zonder_factuur, facturen_zonder_betaling, dubbele_betalingen, afwijkend_bedrag, nieuwe_iban }
 */
function controles(inv) {
  const vandaag = inv.vandaag, venster = inv.venster_dagen || 120;
  const sinds = plusDagen(vandaag, -venster);
  const txs = (inv.transacties || []).filter((t) => !t.verwijderd_op);
  const af = txs.filter((t) => t.bedrag_centen < 0).sort((a, b) => (a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : 0));
  const facturen = inv.facturen || [];
  const gedekt = (d) => (inv.dekking || []).some((p) => (!p.van || d >= p.van) && (!p.tot || d <= p.tot));
  // welke bankregels horen al bij een factuur
  const bijFactuur = new Set();
  for (const f of facturen) for (const id of (f.betaling && f.betaling.transacties) || []) bijFactuur.add(id);

  // 1. incasso's zonder factuur, alleen in perioden met facturendekking; per tegenpartij gebundeld
  const zonder = new Map();
  for (const t of af) {
    if (!t.is_incasso || bijFactuur.has(t.id) || !gedekt(t.boekdatum) || t.categorie) continue;
    const k = tegenpartijSleutel(t) || t.id;
    const x = zonder.get(k) || { sleutel: k, naam: t.tegenpartij_naam || null, entiteit: t.entiteit, aantal: 0, totaal_centen: 0, laatste: null, transacties: [], alleen_eigenaar: false };
    x.aantal++; x.totaal_centen += Math.abs(t.bedrag_centen); x.laatste = t.boekdatum; x.transacties.push(t.id); x.alleen_eigenaar = x.alleen_eigenaar || !!t.alleen_eigenaar;
    zonder.set(k, x);
  }
  // 2. facturen zonder betaling: vervaldatum (of factuurdatum + 30) + 14 dagen voorbij, en de bank dekt die dagen
  const laatsteBank = {};
  for (const t of txs) if (!laatsteBank[t.entiteit] || t.boekdatum > laatsteBank[t.entiteit]) laatsteBank[t.entiteit] = t.boekdatum;
  const zonderBetaling = [];
  for (const f of facturen) {
    if (!f.betaling || f.betaling.betaald || f.incl == null || f.incl <= 0) continue;
    if (['betaald_vooraf'].includes(f.betaalspoor) || f.status === 'geen_factuur' || f.status === 'dubbel' || f.entiteit === 'prive') continue;
    const verval = isIsoDatum(f.vervaldatum) ? f.vervaldatum : isIsoDatum(f.factuurdatum) ? plusDagen(f.factuurdatum, 30) : null;
    if (!verval || dagenTussen(plusDagen(verval, 14), vandaag) <= 0) continue;
    if (!laatsteBank[f.entiteit] || laatsteBank[f.entiteit] < plusDagen(verval, 14)) continue;   // bank nog niet zo ver: geen oordeel
    zonderBetaling.push({ factuur: f.id, herkomst: f.herkomst || 'facturen', entiteit: f.entiteit, leverancier: f.leverancier_naam || null, nummer: f.nummer || null,
      incl_centen: f.incl, vervaldatum: verval, alleen_eigenaar: !!f.alleen_eigenaar });
  }
  // 3. dubbele betalingen: zelfde tegenpartij en bedrag binnen 10 dagen (twee verschillende regels), of hetzelfde kenmerk twee keer
  const dubbel = [];
  const perTp = new Map();
  // per entiteit én tegenpartij: twee praktijken die dezelfde leverancier hetzelfde bedrag betalen is geen dubbele betaling
  for (const t of af) { const k = tegenpartijSleutel(t); if (!k) continue; const ek = t.entiteit + '|' + k; if (!perTp.has(ek)) perTp.set(ek, []); perTp.get(ek).push(t); }
  const gezienPaar = new Set();
  for (const lijst of perTp.values()) {
    for (let i = 0; i < lijst.length; i++) for (let j = i + 1; j < lijst.length; j++) {
      const a = lijst[i], b = lijst[j];
      if (dagenTussen(a.boekdatum, b.boekdatum) > 10) break;
      const zelfdeKenmerk = !!echtKenmerk(a.kenmerk) && echtKenmerk(a.kenmerk) === echtKenmerk(b.kenmerk);
      if (a.bedrag_centen !== b.bedrag_centen && !zelfdeKenmerk) continue;
      // terugkerende vaste bedragen op dezelfde dag (bv. twee abonnementen bij één leverancier) zijn geen dubbele betaling als ze elk maand terugkomen
      if (a.bedrag_centen === b.bedrag_centen && !zelfdeKenmerk && a.is_incasso && b.is_incasso && a.machtiging && b.machtiging && a.machtiging !== b.machtiging) continue;
      if (!zelfdeKenmerk && a.boekdatum < sinds) continue;
      const sl = [a.id, b.id].sort().join('|');
      if (gezienPaar.has(sl)) continue;
      gezienPaar.add(sl);
      dubbel.push({ naam: a.tegenpartij_naam || b.tegenpartij_naam || null, entiteit: a.entiteit, bedrag_centen: Math.abs(a.bedrag_centen), datums: [a.boekdatum, b.boekdatum],
        transacties: [a.id, b.id], reden: zelfdeKenmerk ? 'zelfde kenmerk' : 'zelfde bedrag binnen 10 dagen', alleen_eigenaar: !!(a.alleen_eigenaar || b.alleen_eigenaar) });
    }
  }
  // 4. afwijkend bedrag: terugkerende tegenpartij (≥ 4 eerdere betalingen, regelmatig), laatste betaling in het venster wijkt > max(20 %, € 5) af
  const afwijkend = [];
  for (const [k, lijst] of perTp) {
    if (lijst.length < 5) continue;
    const laatste = lijst[lijst.length - 1];
    if (laatste.boekdatum < sinds) continue;
    const eerder = lijst.slice(0, -1);
    const p = profielVan(k.slice(k.indexOf('|') + 1), eerder);
    if (!p.frequentie || ['onregelmatig', 'onbekend', 'eenmalig'].includes(p.frequentie.soort)) continue;
    const m = p.gebruikelijk_centen, b = Math.abs(laatste.bedrag_centen);
    if (Math.abs(b - m) > Math.max(500, Math.round(m * 0.2))) {
      afwijkend.push({ naam: laatste.tegenpartij_naam || null, entiteit: laatste.entiteit, datum: laatste.boekdatum, bedrag_centen: b, gebruikelijk_centen: m,
        verschil_pct: m ? Math.round(((b - m) / m) * 100) : null, frequentie: p.frequentie.soort, transactie: laatste.id, alleen_eigenaar: !!laatste.alleen_eigenaar });
    }
  }
  // 5. nieuwe IBAN bij een bekende tegenpartij (naam of incassant eerder gezien met een ander IBAN); altijd alleen voor David
  const nieuweIban = [];
  const bekendIban = new Map();   // naam/incassant → Set(iban) vóór de regel
  for (const t of af) {
    const iban = ibanNorm(t.tegenpartij_iban);
    if (!iban) continue;
    const ids = [t.incassant_id ? 'inc:' + String(t.incassant_id).trim().toUpperCase() : null, normNaam(t.tegenpartij_naam) ? 'naam:' + normNaam(t.tegenpartij_naam) : null].filter(Boolean);
    for (const id of ids) {
      const s = bekendIban.get(id);
      if (s && s.size && !s.has(iban) && t.boekdatum >= sinds) {
        nieuweIban.push({ naam: t.tegenpartij_naam || null, entiteit: t.entiteit, datum: t.boekdatum, iban_nieuw: iban, ibans_bekend: Array.from(s).slice(0, 3),
          bedrag_centen: Math.abs(t.bedrag_centen), transactie: t.id, op: id.slice(0, id.indexOf(':')), alleen_eigenaar: true });
        break;
      }
    }
    for (const id of ids) { if (!bekendIban.has(id)) bekendIban.set(id, new Set()); bekendIban.get(id).add(iban); }
  }
  return {
    incasso_zonder_factuur: Array.from(zonder.values()).sort((a, b) => b.totaal_centen - a.totaal_centen),
    facturen_zonder_betaling: zonderBetaling, dubbele_betalingen: dubbel, afwijkend_bedrag: afwijkend, nieuwe_iban: nieuweIban,
  };
}

// ───────────────────────────── zoeken ─────────────────────────────

/*
 * "Wat betaalden we aan X sinds Y": regels waarvan naam, IBAN, omschrijving of kenmerk de zoektekst bevat. vraag = { tekst, sinds, tot,
 * entiteit, richting ('af'|'bij'|'beide'), max }. → { regels (nieuwste eerst, ≤ max), aantal, totaal_af_centen, totaal_bij_centen, per_jaar }
 */
function zoek(transacties, vraag) {
  vraag = vraag || {};
  const tekst = normNaam(vraag.tekst || '');
  const iban = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(ibanNorm(vraag.tekst || '') || '') ? ibanNorm(vraag.tekst) : null;
  const max = Math.min(Math.max(1, Number(vraag.max) || 100), 500);
  const richting = vraag.richting || 'beide';
  const hit = (t) => {
    if (t.verwijderd_op) return false;
    if (vraag.sinds && t.boekdatum < vraag.sinds) return false;
    if (vraag.tot && t.boekdatum > vraag.tot) return false;
    if (vraag.entiteit && t.entiteit !== vraag.entiteit) return false;
    if (richting === 'af' && t.bedrag_centen >= 0) return false;
    if (richting === 'bij' && t.bedrag_centen < 0) return false;
    if (!tekst && !iban) return true;
    if (iban && ibanNorm(t.tegenpartij_iban) === iban) return true;
    return !!tekst && [t.tegenpartij_naam, t.omschrijving, t.kenmerk, t.incassant_id].some((v) => normNaam(v || '').includes(tekst));
  };
  const l = (transacties || []).filter(hit).sort((a, b) => (a.boekdatum < b.boekdatum ? 1 : a.boekdatum > b.boekdatum ? -1 : 0));
  const perJaar = {};
  let af = 0, bij = 0;
  for (const t of l) {
    if (t.bedrag_centen < 0) af += -t.bedrag_centen; else bij += t.bedrag_centen;
    const j = t.boekdatum.slice(0, 4); const x = perJaar[j] = perJaar[j] || { aantal: 0, af_centen: 0, bij_centen: 0 };
    x.aantal++; if (t.bedrag_centen < 0) x.af_centen -= t.bedrag_centen; else x.bij_centen += t.bedrag_centen;
  }
  return { regels: l.slice(0, max), aantal: l.length, afgekapt: l.length > max, totaal_af_centen: af, totaal_bij_centen: bij, per_jaar: perJaar };
}

module.exports = {
  tegenpartijSleutel, betaalwijzeVan, mediaan, frequentieVan, profielen, profielVan, bedragPatroon,
  naamVerwant, ibanHistorie, FEIT_MIN_BETALINGEN, FEIT_MIN_DAGEN,
  genormKenmerk, echtKenmerk, betalingVan, controles, zoek,
};
