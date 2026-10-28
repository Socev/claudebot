'use strict';
/*
 * fin-toewijzing.js — de toewijzingskern van de aansluiting bank ↔ inkoopfacturen (wv1864, Second Brain 2.0 fase 4a, 28-10-2026).
 *
 * WAAROM. Een betaalstatus die exact oogt maar op een onvolledige bank of een te losse koppeling rust, is fout ("ontbrekend is geen nul";
 * een vals "betaald" onderdrukt later een terechte aanmaning, een vals "open" kan tot dubbel betalen leiden). Deze module beslist per
 * factuur welke bankregel(s) erbij horen en welke status dat geeft, met vaste regels en zonder AI. Ontwerp: vault 01_Ontwikkeling/Second
 * Brain 2.0 - fase 4 financiële pilot Tolgaarde (ontwerp 28-10-2026).md § 3.4–3.5 (met de verwerkte Opus-review § 9).
 *
 * PUUR: geen bestand, netwerk, proces of klok (alleen facturen-kern.js voor datum-, IBAN- en naamhulpen en facturen-bank.js voor
 * andereFactuurGenoemd, beide puur). Dekking komt als functie van de
 * beller (fin-reconcile.js rekent die uit de bronbestanden). Vaste volgorde: facturen op (factuurdatum, ref), bankregels op (boekdatum,
 * entry_ref), vergeleken als tekst (geen localeCompare). Dezelfde invoer geeft dezelfde uitvoer, tot op de volgorde van de lijsten.
 *
 * Regels (kort):
 *  - voorbewerking: afschrijving + bijschrijving van hetzelfde bedrag van dezelfde tegenrekening binnen 10 dagen erna (storno) vallen
 *    samen weg; een bijschrijving met een koppeling sepa_terug ook, en die factuur kan hooguit 'kandidaat' worden.
 *  - laag 0: besluit ja (reken.sqlite) of koppeling bron mens (Facturen-app); besluit nee verbiedt dat paar in elke laag.
 *  - laag 1: kenmerk/factuurnummer (≥ 5 tekens, met een cijfer) als heel stuk in omschrijving/kenmerk, en de sleutel is uniek: bij geen
 *    andere factuur in de set en bij geen andere afschrijving in de hele historie. Uitzondering: alle afschrijvingen met die sleutel zijn
 *    gelijk (bedrag, tegenrekening, binnen 10 dagen) → de eerste telt, de rest is 'mogelijk_dubbel_betaald'. Twee facturen met een
 *    unieke sleutel in dezelfde afschrijving → beide 'kandidaat' (verzamelbetaling; een som telt niet). Ander bedrag én een andere
 *    tegenpartij (IBAN en naam passen niet) → 'kandidaat' (een kort nummer komt ook bij een andere leverancier voor).
 *  - laag 2: tegenrekening = IBAN op de factuur en bedrag gelijk, venster −7/+120 dagen (−45 alleen met een genoemde sleutel, zie inVenster),
 *    en de betaling noemt geen ánder factuurnummer (facturen-bank.js andereFactuurGenoemd; geldt ook voor de kandidaten van laag 3). Per samenhangende groep (facturen en
 *    bankregels die elkaar kunnen bedienen): evenveel facturen als regels en de volgorde past → op volgorde; anders 'meerduidig'.
 *  - laag 3 (telt nooit): sleutel niet uniek, sleutel als deel van een langer stuk + bedrag, naam + bedrag, exact bedrag ± 3 dagen
 *    rond de factuurdatum, som van 2–3 regels (termijnen), of een onverklaarde afschrijving naar
 *    dezelfde IBAN/naam in het venster → 'kandidaat' met de reden.
 *  - status in voorrang § 3.5; 'open' vraagt dekking van factuurdatum − 7 t/m vervaldatum + 14 (zonder vervaldatum factuurdatum + 44);
 *    "gat" = een niet-gedekte dag vóór de laatste gedekte dag (→ onbepaald_dekking), "toekomst" = alleen
 *    niet-gedekte dagen ná de laatste gedekte dag (→ nog_niet_te_beoordelen).
 */
const K = require('./facturen-kern.js');
const B = require('./facturen-bank.js');

const VENSTER_VOOR = 45, VENSTER_NA = 120, VOORUIT_ZONDER_SLEUTEL = 7, STORNO_DAGEN = 10, DUBBEL_DAGEN = 10, OPEN_MARGE = 14, ZONDER_VERVAL = 44, MIN_SLEUTEL = 5;
const ROND_DAGEN = 3;   // kandidaat 'bedrag_rond_factuurdatum'
const TERMIJN_MAX_REGELS = 12;   // termijnen: hooguit zoveel kandidaatregels per factuur doorzoeken (2–3 regels per som)
const LEEG_SLEUTEL = new Set(['NOTPROVIDED', 'NOTAVAILABLE', 'NONREF', 'NONE', 'ONBEKEND']);
const STATUSSEN = ['onbepaald_gegevens', 'betaald', 'deels', 'overbetaald', 'kandidaat', 'elders_voldaan', 'onbepaald_dekking', 'nog_niet_te_beoordelen', 'open'];
const MEEGETELD = new Set(['betaald', 'deels', 'overbetaald', 'elders_voldaan', 'open']);   // § 3.5: totalen alleen over status 2, 4 en 7
const DAG_STATUSSEN = ['gedekt', 'alleen_databank', 'afwijkend', 'ontbreekt'];

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function txVolg(a, b) { return cmp(a.boekdatum, b.boekdatum) || cmp(a.entry_ref, b.entry_ref); }
function fVolg(a, b) { return cmp(a.factuurdatum || '', b.factuurdatum || '') || cmp(a.ref, b.ref); }

// Sleutel van een factuur: alleen letters en cijfers, hoofdletters, ≥ 5 tekens, met minstens één cijfer, geen SEPA-vulsel.
function sleutelVan(s) {
  const n = K.normNummer(s);
  return n && n.length >= MIN_SLEUTEL && /\d/.test(n) && !LEEG_SLEUTEL.has(n) ? n : null;
}
// Stukken van omschrijving + kenmerk (zoals facturen-bank.js referentieStukken): een sleutel moet een heel stuk zijn, of het hele kenmerk;
// een lange cijferreeks (≥ 12, betalingskenmerk) mag met spaties ertussen staan.
function stukkenVan(tx) {
  const t = [tx.omschrijving, tx.kenmerk].filter(Boolean).join(' ');
  const stukken = new Set(t.split(/[\s,;:/()]+/).map(K.normNummer).filter(Boolean));
  const km = K.normNummer(tx.kenmerk);
  if (km) stukken.add(km);
  return { stukken, plat: K.normNummer(t) || '' };
}
function noemt(st, sleutel) { return st.stukken.has(sleutel) || (sleutel.length >= 12 && /^\d+$/.test(sleutel) && st.plat.indexOf(sleutel) >= 0); }
function tegenSleutel(tx) {
  const i = K.ibanNorm(tx.tegenpartij_iban);
  if (i) return 'iban:' + i;
  const n = K.normNaam(tx.tegenpartij_naam || '');
  return n ? 'naam:' + n : null;
}
function naamPast(levNaam, txNaam) {
  const a = K.normNaam(levNaam || ''), b = K.normNaam(txNaam || '');
  if (a.length < 4 || b.length < 4) return false;
  return a === b || (' ' + b + ' ').indexOf(' ' + a + ' ') >= 0 || (' ' + a + ' ').indexOf(' ' + b + ' ') >= 0;
}
// Venster −45/+120 rond de factuurdatum als de betaling de sleutel noemt (laag 1, sleutel-kandidaten); zonder genoemde sleutel (laag 2 en de
// overige kandidaten) begint het 7 dagen vóór de factuurdatum. Waarom: wv1317 mat op 153 zekere paren uit het FV2-archief 0 betalingen meer
// dan 7 dagen vóór de factuurdatum, en de eerste proefrun (28-10) zette zo de huur van oktober op de factuur van november (vals "betaald").
function partijPast(f, tx) {
  const i = K.ibanNorm(tx.tegenpartij_iban);
  return (!!i && (f.ibans || []).some((x) => K.ibanNorm(x) === i)) || naamPast(f.leverancier, tx.tegenpartij_naam);
}
function inVenster(f, tx) {
  return tx.boekdatum >= K.plusDagen(f.factuurdatum, -VENSTER_VOOR) && tx.boekdatum <= K.plusDagen(f.factuurdatum, VENSTER_NA);
}
// Noemt de betaling een ánder factuurnummer (facturen-bank.js, wv1317-regel)? Dan is hij zonder genoemde sleutel geen betaling van deze factuur.
function anderNummer(f, tx) { return B.andereFactuurGenoemd(tx, { nummer: f.nummer, kenmerk: f.kenmerk }); }
function inBetaalVenster(f, tx) {
  return tx.boekdatum >= K.plusDagen(f.factuurdatum, -VOORUIT_ZONDER_SLEUTEL) && tx.boekdatum <= K.plusDagen(f.factuurdatum, VENSTER_NA);
}

/*
 * Storno-voorbewerking. transacties: alle regels van de rekening (niet verwijderd). koppelingen: [{ entry_ref, factuur_ref, methode }].
 * → { weg: Set(entry_ref), paren: [[af, bij]], terug: Set(factuur_ref) }
 */
function stornoVoorbewerking(transacties, koppelingen) {
  const af = transacties.filter((t) => t.bedrag_centen < 0).sort(txVolg);
  const bij = transacties.filter((t) => t.bedrag_centen > 0).sort(txVolg);
  const weg = new Set(), paren = [], terug = new Set();
  // Een terugboeking (koppeling sepa_terug, Facturen-app) heft één afschrijving van die factuur op (review wv1864 MOET 3): bij voorkeur een
  // gekoppelde afschrijving van dezelfde factuur met hetzelfde bedrag, anders de laatste eerdere afschrijving van dezelfde tegenpartij en bedrag.
  const byRef = new Map(transacties.map((t) => [t.entry_ref, t]));
  const ks = (koppelingen || []).slice().sort((a, b) => cmp(a.entry_ref, b.entry_ref) || cmp(a.factuur_ref, b.factuur_ref));
  for (const k of ks.filter((x) => x.methode === 'sepa_terug')) {
    const c = byRef.get(k.entry_ref);
    weg.add(k.entry_ref); terug.add(k.factuur_ref);
    if (!c || c.bedrag_centen <= 0) continue;
    const gekoppeld = ks.filter((x) => x.factuur_ref === k.factuur_ref && x.methode !== 'sepa_terug').map((x) => byRef.get(x.entry_ref))
      .filter((t) => t && !weg.has(t.entry_ref) && t.bedrag_centen === -c.bedrag_centen).sort(txVolg);
    const s = tegenSleutel(c);
    const zelfde = af.filter((t) => !weg.has(t.entry_ref) && t.bedrag_centen === -c.bedrag_centen && t.boekdatum <= c.boekdatum && s && tegenSleutel(t) === s);
    const a = gekoppeld[0] || zelfde[zelfde.length - 1];
    if (a) { weg.add(a.entry_ref); paren.push([a.entry_ref, c.entry_ref]); }
  }
  const bijPer = new Map();
  for (const b of bij) {
    if (weg.has(b.entry_ref)) continue;
    const s = tegenSleutel(b);
    if (!s) continue;
    const k = s + '|' + b.bedrag_centen;
    if (!bijPer.has(k)) bijPer.set(k, []);
    bijPer.get(k).push(b);
  }
  for (const a of af) {
    if (weg.has(a.entry_ref)) continue;
    const s = tegenSleutel(a);
    if (!s) continue;
    const lijst = bijPer.get(s + '|' + (-a.bedrag_centen));
    if (!lijst) continue;
    const tot = K.plusDagen(a.boekdatum, STORNO_DAGEN);
    const b = lijst.find((x) => !weg.has(x.entry_ref) && x.boekdatum >= a.boekdatum && x.boekdatum <= tot);
    if (!b) continue;
    weg.add(a.entry_ref); weg.add(b.entry_ref);
    paren.push([a.entry_ref, b.entry_ref]);
  }
  return { weg, paren, terug };
}

// Dagen van a t/m b (beide JJJJ-MM-DD), begrensd op 400 (een factuur heeft hooguit vervaldatum + 14; daarboven klopt de invoer niet).
function dagenVan(a, b) {
  const uit = [];
  for (let d = a, i = 0; d <= b && i < 400; d = K.plusDagen(d, 1), i++) uit.push(d);
  return uit;
}
/*
 * Zijn de dagen a t/m b gedekt? dekking = { status(dag) → 'gedekt'|…|null, laatst_gedekt }. → 'ok' | 'gat' | 'toekomst'.
 * 'gat': een niet-gedekte dag op of vóór de laatste gedekte dag; 'toekomst': alleen niet-gedekte dagen erna (de bank loopt nog niet zo ver).
 */
function dagenGedekt(dekking, a, b) {
  let toekomst = false;
  for (const d of dagenVan(a, b)) {
    if (dekking.status(d) === 'gedekt') continue;
    if (dekking.laatst_gedekt && d <= dekking.laatst_gedekt) return 'gat';
    toekomst = true;
  }
  return toekomst ? 'toekomst' : 'ok';
}

/*
 * De aansluiting. invoer = {
 *   facturen: [{ ref, leverancier, nummer, kenmerk, factuurdatum, vervaldatum, bedrag_centen, ibans: [..], soort, fv2_betaalwijze }],
 *   transacties: [{ entry_ref, boekdatum, bedrag_centen, tegenpartij_iban, tegenpartij_naam, omschrijving, kenmerk, categorie }] (hele
 *     historie van de rekening, zonder verwijderde regels),
 *   besluiten: [{ factuur_ref, entry_refs: [..], oordeel: 'ja'|'nee' }] (reken.sqlite + koppeling bron mens als 'ja'),
 *   koppelingen: [{ entry_ref, factuur_ref, methode }] (voor sepa_terug),
 *   dekking: { status(dag), laatst_gedekt, bank_tm },
 *   aanname: { van, tot } (facturenaanname, § 3.4: onverklaard pas vanaf eerste factuurdatum + 45 t/m de laatste),
 *   scope: { van, tot } (dagen van de dekking; onverklaard 'mogelijk_dubbel_betaald' telt hierbinnen) }
 * → { regels: [{ ref, status, reden, laag, factuurbedrag_centen, betaald_centen, rest_centen, entry_refs, betaaldatum, kandidaat_refs }],
 *     onverklaard: [{ entry_ref, boekdatum, bedrag_centen, reden }], storno: [[af, bij]], telling, totalen, uitkomst, code, aannames }
 */
function sluitAan(invoer) {
  const facturen = (invoer.facturen || []).slice().sort(fVolg);
  const txAlle = (invoer.transacties || []).slice().sort(txVolg);
  const dekking = invoer.dekking;
  const st = stornoVoorbewerking(txAlle, invoer.koppelingen);
  const txByRef = new Map(txAlle.map((t) => [t.entry_ref, t]));
  const af = txAlle.filter((t) => t.bedrag_centen < 0 && !st.weg.has(t.entry_ref));
  const stukken = new Map(af.map((t) => [t.entry_ref, stukkenVan(t)]));
  const gebruikt = new Map();   // entry_ref → ref (laag 0–2)
  const gereserveerd = new Set();   // verzamelbetaling: telt voor niemand
  const verboden = new Set();   // ref|entry_ref (besluit nee)
  const uit = new Map();   // ref → regel in opbouw
  const dubbel = new Map();   // entry_ref → ref (gelijke extra afschrijving bij een factuur)
  const aannames = new Set();
  const nieuw = (f) => ({ ref: f.ref, status: null, reden: null, laag: null, factuurbedrag_centen: Number.isSafeInteger(f.bedrag_centen) ? f.bedrag_centen : null,
    betaald_centen: null, rest_centen: null, entry_refs: [], betaaldatum: null, kandidaat_refs: [] });
  for (const f of facturen) uit.set(f.ref, nieuw(f));
  const geldig = (f) => isIsoGeldig(f.factuurdatum) && Number.isSafeInteger(f.bedrag_centen) && f.bedrag_centen > 0 && f.soort !== 'creditnota';
  const kand = (f, reden, refs) => { const r = uit.get(f.ref); if (!r.status) { r.status = 'kandidaat'; r.reden = reden; r.kandidaat_refs = (refs || []).slice().sort(); } };
  const koppel = (f, laag, refs, reden) => {
    const r = uit.get(f.ref);
    r.laag = laag; r.entry_refs = refs.slice().sort(); r.reden = reden;
    for (const e of refs) gebruikt.set(e, f.ref);
  };

  // ── laag 0: besluiten ──
  // Per paar (factuur, regel) telt het laatste besluit in de volgorde van de invoer (koppelingen uit de app eerst, dan reken.sqlite op id):
  // een later 'nee' heft een eerder 'ja' op (review wv1864 MOET 4).
  const oordeel = new Map();
  for (const b of invoer.besluiten || []) for (const e of b.entry_refs || []) oordeel.set(b.factuur_ref + '|' + e, b.oordeel);
  const jaPer = new Map();
  for (const [k, o] of oordeel) {
    const i = k.lastIndexOf('|'), ref = k.slice(0, i), e = k.slice(i + 1);
    if (o === 'nee') { verboden.add(k); continue; }
    if (o !== 'ja') continue;
    if (!jaPer.has(ref)) jaPer.set(ref, new Set());
    jaPer.get(ref).add(e);
  }
  const jaClaims = new Map();
  for (const [ref, set] of jaPer) for (const e of set) { if (!jaClaims.has(e)) jaClaims.set(e, new Set()); jaClaims.get(e).add(ref); }
  for (const f of facturen) {
    if (!geldig(f) || !jaPer.has(f.ref)) continue;
    const alle = [...jaPer.get(f.ref)].filter((e) => txByRef.has(e) && txByRef.get(e).bedrag_centen < 0).sort();
    const refs = alle.filter((e) => !st.weg.has(e));   // een teruggeboekte (storno/sepa_terug) afschrijving is geen betaling, ook niet met een ja
    if (!refs.length) { kand(f, alle.length ? 'besluit_teruggeboekt' : 'besluit_zonder_regel', alle); continue; }
    if (refs.some((e) => jaClaims.get(e).size > 1)) { kand(f, 'besluit_conflict', refs); continue; }
    koppel(f, 0, refs, 'besluit');
  }
  for (const f of facturen) if (st.terug.has(f.ref) && uit.get(f.ref).laag === null) kand(f, 'teruggeboekt', []);

  // ── laag 1: unieke sleutel ──
  const sleutelsVan = new Map(facturen.map((f) => [f.ref, [...new Set([sleutelVan(f.kenmerk), sleutelVan(f.nummer)].filter(Boolean))].sort()]));
  const factPerSleutel = new Map();
  for (const f of facturen) for (const s of sleutelsVan.get(f.ref)) { if (!factPerSleutel.has(s)) factPerSleutel.set(s, []); factPerSleutel.get(s).push(f.ref); }
  // "hele historie": alle afschrijvingen van de rekening behalve de storno-paren (een teruggeboekte afschrijving is geen betaling; anders
  // maakte elke storno + nieuwe betaling met hetzelfde kenmerk de sleutel niet-uniek)
  const regelsPerSleutel = new Map();
  for (const s of factPerSleutel.keys()) regelsPerSleutel.set(s, af.filter((t) => noemt(stukken.get(t.entry_ref), s)));
  const laag1 = new Map();   // ref → { primair, extra } | { kandidaat: reden, refs }
  const nietUniek = new Map();   // ref → [entry_refs] (sleutel niet uniek; laag 3)
  for (const f of facturen) {
    const r = uit.get(f.ref);
    if (!geldig(f) || r.status || r.laag === 0) continue;
    const primairen = new Map();   // entry_ref → extra's
    const anderePartij = [];
    let buiten = false;
    for (const s of sleutelsVan.get(f.ref)) {
      const ds = regelsPerSleutel.get(s);
      if (!ds.length) continue;
      if (factPerSleutel.get(s).length > 1) { nietUniek.set(f.ref, (nietUniek.get(f.ref) || []).concat(ds.map((t) => t.entry_ref))); continue; }
      const eerste = ds[0];
      const gelijk = ds.every((t) => t.bedrag_centen === eerste.bedrag_centen && tegenSleutel(t) === tegenSleutel(eerste) && t.boekdatum <= K.plusDagen(eerste.boekdatum, DUBBEL_DAGEN));
      if (!gelijk) { nietUniek.set(f.ref, (nietUniek.get(f.ref) || []).concat(ds.map((t) => t.entry_ref))); continue; }
      if (!inVenster(f, eerste)) { buiten = true; continue; }
      if (verboden.has(f.ref + '|' + eerste.entry_ref) || gebruikt.has(eerste.entry_ref)) continue;
      // een kort nummer kan bij een andere leverancier ook voorkomen ("2026-17"): ander bedrag én andere tegenpartij → geen bewijs
      if (-eerste.bedrag_centen !== f.bedrag_centen && !partijPast(f, eerste)) { anderePartij.push(eerste.entry_ref); continue; }
      primairen.set(eerste.entry_ref, ds.slice(1).map((t) => t.entry_ref));
    }
    if (primairen.size > 1) laag1.set(f.ref, { kandidaat: 'meerduidig', refs: [...primairen.keys()] });
    else if (primairen.size === 1) { const [p, extra] = [...primairen.entries()][0]; laag1.set(f.ref, { primair: p, extra }); }
    else if (anderePartij.length) laag1.set(f.ref, { kandidaat: 'sleutel_andere_partij', refs: anderePartij });
    else if (buiten && !nietUniek.has(f.ref)) laag1.set(f.ref, { buiten: true });
  }
  // een regel die door twee facturen wordt opgeëist (ook via een meerduidige factuur) is een verzamelbetaling: telt voor geen van beide
  const claimsL1 = new Map();
  const claim = (e, ref) => { if (!claimsL1.has(e)) claimsL1.set(e, []); claimsL1.get(e).push(ref); };
  for (const [ref, v] of laag1) { if (v.primair) claim(v.primair, ref); if (v.kandidaat) for (const e of v.refs) claim(e, ref); }
  for (const f of facturen) {
    const v = laag1.get(f.ref);
    if (!v) continue;
    if (v.kandidaat) { kand(f, v.kandidaat, v.refs); for (const e of v.refs) gereserveerd.add(e); continue; }
    if (v.buiten) continue;   // sleutel alleen buiten het venster: laag 2 mag nog, anders laag 3
    if (claimsL1.get(v.primair).length > 1) { kand(f, 'verzamelbetaling', [v.primair]); gereserveerd.add(v.primair); continue; }
    koppel(f, 1, [v.primair], 'sleutel');
    // sleutel + bedrag, maar de tegenpartij past niet (betaaldienst, andere handelsnaam): telt, als aanname vastgelegd (review wv1864)
    if (!partijPast(f, txByRef.get(v.primair))) aannames.add('sleutel_en_bedrag_bij_andere_tegenpartij');
    for (const e of v.extra) if (!gebruikt.has(e)) dubbel.set(e, f.ref);
  }

  // ── laag 2: IBAN + bedrag, per samenhangende groep ──
  const vrij = (f, t) => !gebruikt.has(t.entry_ref) && !gereserveerd.has(t.entry_ref) && !dubbel.has(t.entry_ref) && !verboden.has(f.ref + '|' + t.entry_ref);
  const open2 = facturen.filter((f) => geldig(f) && !uit.get(f.ref).status && uit.get(f.ref).laag === null && (f.ibans || []).length);
  const randen = new Map();   // ref → [entry_ref]
  const perIbanBedrag = new Map();
  for (const t of af) {
    const i = K.ibanNorm(t.tegenpartij_iban);
    if (!i) continue;
    const k = i + '|' + (-t.bedrag_centen);
    if (!perIbanBedrag.has(k)) perIbanBedrag.set(k, []);
    perIbanBedrag.get(k).push(t);
  }
  for (const f of open2) {
    const set = new Set();
    for (const i of f.ibans.map(K.ibanNorm).filter(Boolean)) for (const t of perIbanBedrag.get(i + '|' + f.bedrag_centen) || []) if (vrij(f, t) && inBetaalVenster(f, t) && !anderNummer(f, t)) set.add(t.entry_ref);
    if (set.size) randen.set(f.ref, [...set].sort());
  }
  // samenhangende groepen (union-find over facturen en regels)
  const ouder = new Map();
  const vind = (x) => { while (ouder.get(x) !== x) { ouder.set(x, ouder.get(ouder.get(x))); x = ouder.get(x); } return x; };
  const unie = (a, b) => { const ra = vind(a), rb = vind(b); if (ra !== rb) { if (ra < rb) ouder.set(rb, ra); else ouder.set(ra, rb); } };
  for (const [ref, es] of randen) { const fa = 'f:' + ref; if (!ouder.has(fa)) ouder.set(fa, fa); for (const e of es) { const ta = 't:' + e; if (!ouder.has(ta)) ouder.set(ta, ta); unie(fa, ta); } }
  const groepen = new Map();
  for (const x of ouder.keys()) { const w = vind(x); if (!groepen.has(w)) groepen.set(w, { f: [], t: [] }); (x[0] === 'f' ? groepen.get(w).f : groepen.get(w).t).push(x.slice(2)); }
  const fByRef = new Map(facturen.map((f) => [f.ref, f]));
  for (const w of [...groepen.keys()].sort()) {
    const g = groepen.get(w);
    const fs = g.f.map((r) => fByRef.get(r)).sort(fVolg), ts = g.t.map((e) => txByRef.get(e)).sort(txVolg);
    const past = fs.length === ts.length && fs.every((f, i) => randen.get(f.ref).indexOf(ts[i].entry_ref) >= 0);
    if (!past) { for (const f of fs) kand(f, 'meerduidig', randen.get(f.ref)); continue; }
    // Komt hetzelfde IBAN + bedrag in de historie vaker voor dan deze groep regels heeft (vaste opdracht, maandhuur), dan kan een betaling van
    // een factuur buiten de set (de volgende maand) deze factuur "betalen" en schuift alles een maand op (review wv1864 MOET 2) → kandidaat.
    // Grens: een gloednieuwe leverancier met precies evenveel regels als facturen in de set is zo niet te herkennen (zelfde vorm als proef 3f).
    const vaker = fs.some((f) => f.ibans.map(K.ibanNorm).filter(Boolean).some((i) => (perIbanBedrag.get(i + '|' + f.bedrag_centen) || []).filter((t) => !st.weg.has(t.entry_ref)).length > ts.length));
    if (vaker) { for (const f of fs) kand(f, 'terugkerend_bedrag', randen.get(f.ref)); continue; }
    if (fs.length > 1) aannames.add('gelijke_facturen_op_volgorde');
    fs.forEach((f, i) => koppel(f, 2, [ts[i].entry_ref], fs.length > 1 ? 'iban_bedrag_volgorde' : 'iban_bedrag'));
  }

  // ── dubbel: een gelijke, ongebruikte afschrijving naast een gekoppelde betaling ──
  const scope = invoer.scope || {}, aanname = invoer.aanname || {};
  const inScope = (t) => (!scope.van || t.boekdatum >= scope.van) && (!scope.tot || t.boekdatum <= scope.tot);
  for (const t of af) {
    if (!inScope(t) || gebruikt.has(t.entry_ref) || dubbel.has(t.entry_ref) || gereserveerd.has(t.entry_ref)) continue;
    const s = tegenSleutel(t);
    if (!s) continue;
    const van = K.plusDagen(t.boekdatum, -DUBBEL_DAGEN), tot = K.plusDagen(t.boekdatum, DUBBEL_DAGEN);
    const hit = af.find((u) => u !== t && gebruikt.has(u.entry_ref) && u.bedrag_centen === t.bedrag_centen && tegenSleutel(u) === s && u.boekdatum >= van && u.boekdatum <= tot);
    if (hit) dubbel.set(t.entry_ref, gebruikt.get(hit.entry_ref));
  }

  // ── laag 3: kandidaten (tellen niet) ──
  const onverklaardKan = (t) => !gebruikt.has(t.entry_ref) && !t.categorie;
  for (const f of facturen) {
    const r = uit.get(f.ref);
    if (!geldig(f) || r.status || r.laag !== null) continue;
    const v1 = laag1.get(f.ref);
    if (v1 && v1.buiten) { kand(f, 'sleutel_buiten_venster', []); continue; }   // de unieke sleutel staat alleen in een regel buiten −45/+120
    const breed = af.filter((t) => inVenster(f, t) && !gebruikt.has(t.entry_ref) && !verboden.has(f.ref + '|' + t.entry_ref));
    const nu = (nietUniek.get(f.ref) || []).filter((e) => breed.some((t) => t.entry_ref === e));
    if (nu.length) { kand(f, 'sleutel_niet_uniek', [...new Set(nu)]); continue; }
    // de sleutel staat er wel, maar niet als heel stuk (bv. als staart van een ordernummer "7012X445566"), met precies het bedrag
    const deel = breed.filter((t) => -t.bedrag_centen === f.bedrag_centen && sleutelsVan.get(f.ref).some((k) => stukken.get(t.entry_ref).plat.indexOf(k) >= 0));
    if (deel.length) { kand(f, 'sleutel_deel_bedrag', deel.map((t) => t.entry_ref)); continue; }
    const ibans = new Set((f.ibans || []).map(K.ibanNorm).filter(Boolean));
    const betaal = breed.filter((t) => inBetaalVenster(f, t));
    const venster = betaal.filter((t) => !anderNummer(f, t));
    const naamBedrag = venster.filter((t) => -t.bedrag_centen === f.bedrag_centen && naamPast(f.leverancier, t.tegenpartij_naam));
    if (naamBedrag.length) { kand(f, 'naam_bedrag', naamBedrag.map((t) => t.entry_ref)); continue; }
    const zelfde = venster.filter((t) => (ibans.size && ibans.has(K.ibanNorm(t.tegenpartij_iban))) || naamPast(f.leverancier, t.tegenpartij_naam));
    const som = termijnen(zelfde.filter((t) => -t.bedrag_centen < f.bedrag_centen).slice(0, TERMIJN_MAX_REGELS), f.bedrag_centen);
    if (som) { kand(f, 'termijnen', som); continue; }
    const verzamel = zelfde.filter(onverklaardKan);
    if (verzamel.length) { kand(f, 'mogelijke_verzamelbetaling', verzamel.map((t) => t.entry_ref)); continue; }
    // precies het bedrag, binnen 3 dagen rond de factuurdatum, onder een andere naam (webshop via een betaaldienst; steekproef 28-10)
    const rond = venster.filter((t) => -t.bedrag_centen === f.bedrag_centen && Math.abs(K.dagenTussen(f.factuurdatum, t.boekdatum)) <= ROND_DAGEN && !t.categorie);
    if (rond.length) { kand(f, 'bedrag_rond_factuurdatum', rond.map((t) => t.entry_ref)); continue; }
    // een afschrijving naar dezelfde IBAN/naam die een ánder factuurnummer noemt: waarschijnlijk een andere factuur, maar niet uitgesloten
    // (verschrijving, verzamelbetaling) → kandidaat, nooit 'open' (review wv1864 MOET 1; ontwerp § 3.5 status 3)
    const ander = betaal.filter((t) => anderNummer(f, t) && onverklaardKan(t) && ((ibans.size && ibans.has(K.ibanNorm(t.tegenpartij_iban))) || naamPast(f.leverancier, t.tegenpartij_naam)));
    if (ander.length) { kand(f, 'noemt_ander_nummer', ander.map((t) => t.entry_ref)); continue; }
  }

  // ── status per factuur (§ 3.5, voorrang) ──
  for (const f of facturen) {
    const r = uit.get(f.ref);
    if (!geldig(f)) {
      r.status = 'onbepaald_gegevens'; r.laag = null; r.entry_refs = []; r.kandidaat_refs = [];
      r.reden = f.soort === 'creditnota' || (Number.isSafeInteger(f.bedrag_centen) && f.bedrag_centen < 0) ? 'creditnota_buiten_pilot'
        : !isIsoGeldig(f.factuurdatum) ? 'geen_factuurdatum' : 'geen_bedrag';
      continue;
    }
    if (r.laag !== null) {
      const ts = r.entry_refs.map((e) => txByRef.get(e));
      const som = ts.reduce((a, t) => a + -t.bedrag_centen, 0);
      r.betaald_centen = som;
      r.betaaldatum = ts.map((t) => t.boekdatum).sort().pop();
      let dek = 'ok';
      for (const t of ts) {
        const d = dagenGedekt(dekking, t.boekdatum, K.plusDagen(t.boekdatum, STORNO_DAGEN));
        if (d === 'gat') { dek = 'gat'; break; }
        if (d === 'toekomst') dek = 'toekomst';
      }
      if (dek === 'gat') { r.status = 'onbepaald_dekking'; r.reden = 'betaaldag_niet_gedekt'; continue; }
      if (dek === 'toekomst') { r.status = 'nog_niet_te_beoordelen'; r.reden = 'storno_termijn_na_bank_tm'; continue; }
      if (som === f.bedrag_centen) { r.status = 'betaald'; r.rest_centen = 0; }
      else if (som > f.bedrag_centen) { r.status = 'overbetaald'; r.rest_centen = f.bedrag_centen - som; }
      else { r.status = 'deels'; r.rest_centen = f.bedrag_centen - som; }
      continue;
    }
    if (r.status === 'kandidaat') continue;
    if (f.fv2_betaalwijze === 'reeds_voldaan') { r.status = 'elders_voldaan'; r.reden = 'fv2_reeds_voldaan'; continue; }
    const eind = isIsoGeldig(f.vervaldatum) && f.vervaldatum >= f.factuurdatum ? K.plusDagen(f.vervaldatum, OPEN_MARGE) : K.plusDagen(f.factuurdatum, ZONDER_VERVAL);
    // vanaf 7 dagen vóór de factuurdatum: een betaling zonder genoemde sleutel kan zo vroeg vallen (inBetaalVenster)
    const d = dagenGedekt(dekking, K.plusDagen(f.factuurdatum, -VOORUIT_ZONDER_SLEUTEL), eind);
    if (d === 'gat') { r.status = 'onbepaald_dekking'; r.reden = 'dag_niet_gedekt'; continue; }
    if (d === 'toekomst') { r.status = 'nog_niet_te_beoordelen'; r.reden = isIsoGeldig(f.vervaldatum) ? 'vervaldatum_14_na_bank_tm' : 'factuurdatum_44_na_bank_tm'; continue; }
    // een late betaling (tot +120, zoals laag 2 zoekt) in een gat ná de vervaldatum zou 'open' vals maken (review wv1864 ZOU 5)
    const laat = K.plusDagen(f.factuurdatum, VENSTER_NA);
    const tot = dekking.laatst_gedekt && dekking.laatst_gedekt < laat ? dekking.laatst_gedekt : laat;
    if (tot > eind && dagenGedekt(dekking, K.plusDagen(eind, 1), tot) === 'gat') { r.status = 'onbepaald_dekking'; r.reden = 'gat_na_vervaldatum'; continue; }
    r.status = 'open'; r.reden = 'geen_betaling_van_deze_rekening';
  }

  // ── onverklaarde afschrijvingen ──
  const kandidaatVan = new Map();
  for (const r of uit.values()) if (r.status === 'kandidaat') for (const e of r.kandidaat_refs) if (!kandidaatVan.has(e)) kandidaatVan.set(e, r.ref);
  const onverklaard = [];
  for (const t of af) {
    if (gebruikt.has(t.entry_ref) || t.categorie) continue;
    const inAanname = aanname.van && aanname.tot && t.boekdatum >= aanname.van && t.boekdatum <= aanname.tot;
    let reden = null;
    if (dubbel.has(t.entry_ref) && inScope(t)) reden = 'mogelijk_dubbel_betaald';
    else if (inAanname) reden = kandidaatVan.has(t.entry_ref) || gereserveerd.has(t.entry_ref) ? 'kandidaat' : 'geen_factuur';
    if (reden) onverklaard.push({ entry_ref: t.entry_ref, boekdatum: t.boekdatum, bedrag_centen: t.bedrag_centen, reden, factuur_ref: dubbel.get(t.entry_ref) || kandidaatVan.get(t.entry_ref) || null });
  }

  // ── telling, totalen, uitkomst ──
  const regels = facturen.map((f) => uit.get(f.ref));
  const telling = {};
  for (const s of STATUSSEN) telling[s] = 0;
  for (const r of regels) telling[r.status]++;
  const onvolledig = telling.onbepaald_dekking > 0;
  let totalen = null;
  if (!onvolledig) {
    totalen = { facturen: 0, factuurbedrag_centen: 0, betaald_centen: 0, open_centen: 0, elders_centen: 0, overbetaald_centen: 0 };
    for (const r of regels) {
      if (!MEEGETELD.has(r.status)) continue;
      totalen.facturen++;
      totalen.factuurbedrag_centen += r.factuurbedrag_centen;
      if (r.status === 'open') totalen.open_centen += r.factuurbedrag_centen;
      else if (r.status === 'elders_voldaan') totalen.elders_centen += r.factuurbedrag_centen;
      else {
        totalen.betaald_centen += r.betaald_centen;
        if (r.status === 'deels') totalen.open_centen += r.rest_centen;
        if (r.status === 'overbetaald') totalen.overbetaald_centen += -r.rest_centen;
      }
    }
  }
  return {
    regels, onverklaard, storno: st.paren.slice().sort((a, b) => cmp(a[0], b[0])), telling, totalen,
    uitkomst: onvolledig ? 'onvolledig' : 'antwoord', code: onvolledig ? 'INCOMPLETE_COVERAGE' : null, aannames: [...aannames].sort(),
  };
}
function isIsoGeldig(d) { return typeof d === 'string' && K.isIsoDatum(d); }

// Som van 2 of 3 regels die precies het bedrag geeft (eerste in vaste volgorde) → [entry_ref] of null.
function termijnen(lijst, doel) {
  const l = lijst.slice().sort(txVolg), n = l.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const s2 = -l[i].bedrag_centen - l[j].bedrag_centen;
    if (s2 === doel) return [l[i].entry_ref, l[j].entry_ref];
    for (let k = j + 1; k < n; k++) if (s2 - l[k].bedrag_centen === doel) return [l[i].entry_ref, l[j].entry_ref, l[k].entry_ref];
  }
  return null;
}

module.exports = {
  VENSTER_VOOR, VENSTER_NA, VOORUIT_ZONDER_SLEUTEL, STORNO_DAGEN, DUBBEL_DAGEN, OPEN_MARGE, ZONDER_VERVAL, MIN_SLEUTEL, STATUSSEN, DAG_STATUSSEN, MEEGETELD,
  sleutelVan, stukkenVan, noemt, tegenSleutel, naamPast, partijPast, stornoVoorbewerking, dagenGedekt, dagenVan, termijnen, sluitAan, cmp, txVolg, fVolg,
};
