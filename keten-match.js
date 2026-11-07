'use strict';
/*
 * POSTKETEN (wv2684, 7-11-2026; ontwerp vault "01_Ontwikkeling/Postketen - herinnering en aanmaning naast de bank (ontwerp 7-11-2026).md" § 3).
 * Zuivere kern van de keten-lens van OVIS Intake: een herinnering, aanmaning, incasso- of deurwaardersbrief op kenmerk naast de bank leggen.
 * Geen databank, geen netwerk, geen klok (peil komt binnen): getoetst in test/keten-match.sh met verzonnen data.
 *   briefLees   → nummer, niveau, bedragen, datums, rekeningen en de oorspronkelijke afzender (ook uit een doorgestuurd blok)
 *   schuldeiser → leverancier (via een rekening uit het stuk) › maildomein › genormaliseerde naam
 *   dossier     → sleutel = schuldeiser + genormaliseerd nummer (gehasht: geen nummer, bedrag of IBAN in intake.sqlite)
 *   match       → sterkte per afschrijving (hoog / redelijk / zwak), storno eruit, betaald / deels / twee keer / vóór of na de brief, dekking
 *   kaart       → één Voor jou-kaart per dossier in gewone taal (titel ≤ 90, waarom ≤ 400)
 * Nooit "betaald" op een zwakke treffer (alleen kandidaat), nooit "open" als de bank niet bij is (niet vast te stellen).
 */
const crypto = require('crypto');

const MAX_TITEL = 90, MAX_WAAROM = 400;
const STORNO_DAGEN = 10;            // een bijschrijving van hetzelfde bedrag van dezelfde tegenpartij binnen 10 dagen: die afschrijving telt niet
const VOOR_WERKDAGEN = 2;           // betaald meer dan 2 werkdagen vóór de brief = "al betaald"
const ZWAK_MARGE = 0.02;            // naam lijkt + bedrag ± 2 %: alleen kandidaat
const VENSTER_ZONDER_DATUM = 180;   // geen factuurdatum in de brief: briefdatum − 180 dagen
const NUMMER_MIN = 4;

// betaaldiensten: een betaling "via Mollie" is geen andere tegenpartij (dossier C: Mollie en daarna de cateraar zelf, zelfde nummer)
const BETAALDIENST = /\b(mollie|adyen|buckaroo|stripe|paypal|multisafepay|pay\.?nl|ingenico|worldline|ccv|sisow|icepay|targetpay|tikkie|online\s*betaling|ideal|cm\.?com|payvision|klarna|sumup|mypos)\b/i;
const RECHTSVORM = /\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|c\.?v\.?|holding|stichting|stg|vereniging|bv|nv|vof|ltd|gmbh|inc|the|de|het|en|van|der|den|groep|group|nederland|nl)\b/g;

// ── kleine hulpjes ──
function norm(nummer) { return String(nummer == null ? '' : nummer).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function hash(s, n) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n || 16); }
function cel(t, n) { return String(t == null ? '' : t).replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 200); }
function dagMs(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
function isoDag(ms) { return new Date(ms).toISOString().slice(0, 10); }
function plusDagen(iso, n) { return isoDag(dagMs(iso) + n * 86400000); }
function minWerkdagen(iso, n) { let ms = dagMs(iso), k = 0; while (k < n) { ms -= 86400000; const w = new Date(ms).getUTCDay(); if (w !== 0 && w !== 6) k++; } return isoDag(ms); }
function nlDatum(iso) { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return x ? (+x[3]) + '-' + (+x[2]) + '-' + x[1] : '?'; }
function euro(c) {
  if (c == null || !isFinite(c)) return '?';
  const n = Math.abs(Math.round(c)), e = Math.floor(n / 100), ct = String(n % 100).padStart(2, '0');
  return '€ ' + String(e).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + ct;
}
// "1.234,56" · "1234,56" · "1,234.56" · "131.24" · "€ 131" → centen (of null)
function centen(t) {
  let s = String(t == null ? '' : t).replace(/[€\s]|EUR/gi, '');
  if (!/\d/.test(s)) return null;
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{2}$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(/[.,]-?$/, '');
  const v = Number(s);
  return isFinite(v) && v > 0 && v < 1e8 ? Math.round(v * 100) : null;
}
function datumIso(w) {
  const MAAND = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12 };
  const t = String(w || '').trim().toLowerCase();
  let j, m, d, x;
  if ((x = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) { j = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t))) { d = +x[1]; m = +x[2]; j = +x[3]; if (x[3].length === 2) j += 2000; }
  else if ((x = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(t)) && MAAND[x[2]]) { d = +x[1]; m = MAAND[x[2]]; j = +x[3]; }
  else return null;
  if (j < 2000 || j > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(j, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}
function domeinVan(adres) { const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(String(adres || '')); return m ? m[1].toLowerCase() : null; }
function orgDomein(d) {
  const p = String(d || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  return (/^(co|com|org|net|ac|gov)$/.test(p[p.length - 2]) ? p.slice(-3) : p.slice(-2)).join('.');
}
function naamNorm(n) { return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(RECHTSVORM, ' ').replace(/\s+/g, ' ').trim(); }

// ── niveau (§ 3.2 stap 2) ──
const NIVEAU_RE = [
  [4, /\b(incassobureau|incasso\s*bureau|deurwaarder|gerechtsdeurwaarder|dwangbevel)\b/i],
  [3, /\b(aanmaning|sommatie|ingebrekestelling|in\s+gebreke|laatste\s+waarschuwing|incassokosten)\b/i],
  [2, /\b(tweede|2e|derde|3e|laatste)\s+(betalings)?herinnering\b|\b(second|final)\s+(payment\s+)?reminder\b/i],
  [1, /\b(betalings)?herinnering\b|\breminder\b|\bincasso\b[^.\n]{0,60}\bniet\b|\bnog\s+niet\s+(volledig\s+)?(voldaan|ontvangen|betaald)\b|\bopenstaand(e)?\s+bedrag\b/i],
];
function niveau(kop) { const t = String(kop || ''); for (const [n, re] of NIVEAU_RE) if (re.test(t)) return n; return 1; }
const NIVEAU_NAAM = { 1: 'herinnering', 2: 'tweede herinnering', 3: 'aanmaning', 4: 'incassobureau of deurwaarder' };

// ── doorgestuurd blok: de oorspronkelijke afzender (Gmail, Outlook, Apple Mail; NL en EN) ──
const DOOR_KOP = /(-{2,}\s*(forwarded message|doorgestuurd bericht|oorspronkelijk bericht|original message)\s*-{2,}|begin\s+(doorgestuurd|forwarded)\s+(bericht|message)\s*:)/i;
const VAN_REGEL = /^\s*[>*\s]*(?:van|from|afzender)\s*:\s*(.+)$/im;
function oorspronkelijkeAfzender(tekst, eigenDomeinen) {
  const t = String(tekst || '');
  const eigen = new Set((eigenDomeinen || []).map(function (d) { return orgDomein(String(d).toLowerCase()); }));
  const kop = DOOR_KOP.exec(t);
  const blokken = [];
  if (kop) blokken.push(t.slice(kop.index));
  blokken.push(t);   // ook een antwoord ("Op … schreef X <a@b>:") of een blok zonder kopregel
  for (const b of blokken) {
    const re = new RegExp(VAN_REGEL.source, 'gim');
    let m;
    while ((m = re.exec(b))) {
      const d = domeinVan(m[1]);
      if (d && !eigen.has(orgDomein(d))) return { domein: orgDomein(d), naam: cel(m[1].replace(/<[^>]*>|\[mailto:[^\]]*\]/gi, '').replace(/["']/g, ''), 80) || null };
    }
    const sch = /\bop\s+.{4,60}?\s+schreef\s+(.{2,120}?)\s*:\s*$|\bon\s+.{4,60}?\s+wrote\s*:?/im.exec(b);
    const d2 = sch ? domeinVan(sch[0]) : null;
    if (d2 && !eigen.has(orgDomein(d2))) return { domein: orgDomein(d2), naam: null };
  }
  return null;
}

// het nummer uit het onderwerp (zelfde regel als kopNummer in intake-router.js): eerste blok met ≥ 4 cijfers dat geen datum of jaartal is
function kopNummer(onderwerp) {
  const re = /(?:^|[\s(#:\[])([A-Za-z]{0,4}-?\d[0-9A-Za-z\-/]{3,30})(?=$|[\s),.;:\]])/g;
  let m;
  while ((m = re.exec(String(onderwerp || '')))) {
    const w = m[1].replace(/[-/]+$/, '');
    if ((w.match(/\d/g) || []).length < 4 || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$|^\d{4}-\d{2}-\d{2}$|^(?:19|20)\d{2}$/.test(w)) continue;
    return w;
  }
  return null;
}
// "'Leverancier A' via Administratie" (Google-groep) → "Leverancier A"; "Info | Leverancier A" → "Leverancier A"
function naamSchoon(n) {
  let t = cel(n, 120).replace(/^["'\s]+|["'\s]+$/g, '').replace(/["']/g, '').replace(/\s+via\s+.*$/i, '').trim();
  if (/\|/.test(t)) t = t.split('|').map(function (x) { return x.trim(); }).filter(Boolean).pop() || t;
  return t ? t.slice(0, 80) : null;
}
// ── brief lezen (§ 3.2) ──
// x = { tekst (alles, ook bijlagen), kop (onderwerp + begin van elk deel), velden: [{ veld, waarde, letterlijk }], ibans: [geldig, zonder spaties],
//       van (adres), van_naam, doorgestuurd (bool), eigen_domeinen: [], datum (iso, ontvangen) }
const OPENSTAAND_RE = /\b(?:openstaand(?:e)?\s+(?:bedrag|saldo)|nog\s+(?:te\s+)?(?:betalen|open)(?:\s+bedrag)?|restbedrag|resterend(?:e)?\s+bedrag|open\s+bedrag|amount\s+(?:due|outstanding))\s*(?:van|is|:)?\s*(?:€|eur)?\s*([0-9][0-9.,]*\d)/i;
const TOTAAL_RE = /\b(?:factuurbedrag|totaal\s*(?:bedrag)?(?:\s*incl(?:\.|usief)?\s*(?:btw)?)?|te\s+betalen(?:\s+bedrag)?|bedrag\s+van|bedrag|total(?:\s+due)?)\s*(?:van|is|:)?\s*(?:€|eur)\s*([0-9][0-9.,]*\d)/i;
function briefLees(x) {
  const vs = (x && x.velden) || [];
  const tekst = String((x && x.tekst) || ''), kop = String((x && x.kop) || (String((x && x.onderwerp) || '') + '\n' + tekst.slice(0, 1500)));
  const veld = function (v) { const f = vs.find(function (y) { return y.veld === v && y.letterlijk !== false && norm(y.waarde).length >= NUMMER_MIN; }); return f ? String(f.waarde).trim() : null; };
  // nummer: factuurnummer › het nummer in het onderwerp › kenmerk › dossiernummer (§ 3.2 stap 4; het onderwerp: wv2684-terugtoets, 6 van 8 dossiers)
  let nummer = null, soort = null;
  const kn = kopNummer(x && x.onderwerp);
  for (const s of ['factuurnummer', 'onderwerp', 'kenmerk', 'dossiernummer']) {
    const w = s === 'onderwerp' ? kn : veld(s);
    if (w && /\d/.test(w) && norm(w).length >= NUMMER_MIN) { nummer = w; soort = s; break; }
  }
  const om = OPENSTAAND_RE.exec(tekst), tm = TOTAAL_RE.exec(tekst);
  let open = om ? centen(om[1]) : null, totaal = tm ? centen(tm[1]) : null;
  if (totaal == null) { const b = vs.find(function (y) { return y.veld === 'bedrag'; }); if (b) totaal = centen(b.waarde); }
  if (open != null && totaal != null && open === totaal) open = null;
  const fd = vs.find(function (y) { return y.veld === 'factuurdatum'; }), vd = vs.find(function (y) { return y.veld === 'vervaldatum'; });
  const af = x && x.doorgestuurd ? oorspronkelijkeAfzender(tekst, x.eigen_domeinen) : null;
  const vanDom = domeinVan(x && x.van);
  const eigen = new Set(((x && x.eigen_domeinen) || []).map(function (d) { return orgDomein(d); }));
  const domein = af ? af.domein : (vanDom && !eigen.has(orgDomein(vanDom)) ? orgDomein(vanDom) : null);
  return {
    nummer, nummer_norm: nummer ? norm(nummer) : null, nummer_soort: soort,
    niveau: niveau(kop), bedrag_centen: totaal, openstaand_centen: open,
    factuurdatum: fd ? datumIso(fd.waarde) : null, vervaldatum: vd ? datumIso(vd.waarde) : null,
    ibans: Array.from(new Set(((x && x.ibans) || []).map(function (i) { return String(i).replace(/\s/g, '').toUpperCase(); }))).slice(0, 10),
    domein, naam: naamSchoon((af && af.naam) || (x && x.van_naam)), doorgestuurd: !!(x && x.doorgestuurd), afzender_uit_blok: !!af,
    datum: String((x && x.datum) || '').slice(0, 10) || null,
  };
}

// ── schuldeiser en dossier (§ 3.2 stap 4) ──
// lev = { id, naam } (de leverancier in de Facturen-app via een rekening uit het stuk) | null
function schuldeiser(brief, lev) {
  if (lev && lev.id) return { soort: 'leverancier', waarde: String(lev.id), naam: lev.naam || brief.naam || null };
  if (brief.domein) return { soort: 'domein', waarde: brief.domein, naam: brief.naam || brief.domein };
  const n = naamNorm(brief.naam);
  return n ? { soort: 'naam', waarde: n, naam: brief.naam } : { soort: 'onbekend', waarde: '', naam: null };
}
function dossierSleutel(se, nummerNorm) { return 'intake-keten-' + hash(se.soort + ':' + se.waarde + '|' + nummerNorm, 16); }
function nummerHash(nummerNorm) { return hash('nummer|' + nummerNorm, 24); }
function schuldeiserHash(se) { return hash('se|' + se.soort + ':' + se.waarde, 24); }
// Hoort een stuk bij een bestaand dossier met hetzelfde nummer? Alleen apart als beide een (verschillende) leverancier uit de Facturen-app hebben:
// een doorgestuurde mail, een antwoord of een stuk zonder herkende afzender valt zo in hetzelfde dossier (één kaart per dossier).
function zelfdeDossier(d, se) { return !(d.schuldeiser_soort === 'leverancier' && se.soort === 'leverancier' && d.schuldeiser !== schuldeiserHash(se)); }

// ── nummer in een bankregel ──
function nummerIn(nummerNorm, rij) {
  if (!nummerNorm || nummerNorm.length < NUMMER_MIN) return false;
  const t = (String(rij.omschrijving || '') + ' ' + String(rij.kenmerk || '')).toUpperCase();
  const t1 = t.replace(/[-./_]/g, '');
  const grens = function (s) {
    let i = s.indexOf(nummerNorm);
    while (i >= 0) {
      const voor = s[i - 1] || ' ', na = s[i + nummerNorm.length] || ' ';
      const okV = !/\d/.test(nummerNorm[0]) || !/\d/.test(voor), okN = !/\d/.test(nummerNorm[nummerNorm.length - 1]) || !/\d/.test(na);
      if (okV && okN) return true;
      i = s.indexOf(nummerNorm, i + 1);
    }
    return false;
  };
  if (grens(t1)) return true;
  return /[A-Z]/.test(nummerNorm) && grens(t1.replace(/\s+/g, ''));   // "F 2974554" in de omschrijving; alleen bij een nummer met letters (geen bedragen)
}
function tegenpartij(r) { return { iban: r.tegenpartij_iban ? String(r.tegenpartij_iban).replace(/\s/g, '').toUpperCase() : null, naam: naamNorm(r.tegenpartij_naam), dienst: BETAALDIENST.test(String(r.tegenpartij_naam || '') + ' ' + String(r.omschrijving || '')) }; }
function zelfdePartij(a, b) {
  if (a.dienst || b.dienst) return true;
  if (a.iban && b.iban) return a.iban === b.iban;
  return !!a.naam && a.naam === b.naam;
}
function naamLijkt(tegen, namen) {
  const w = new Set(naamNorm(tegen).split(' ').filter(function (s) { return s.length >= 4; }));
  if (!w.size) return false;
  return namen.some(function (n) { return naamNorm(n).split(' ').some(function (s) { return s.length >= 4 && w.has(s); }); });
}

/*
 * match(brief, rijen, opt) — § 3.3. rijen = bankregels van de Facturen-app (alleen lezen): { id, rekening, boekdatum, bedrag_centen (< 0 =
 * afschrijving), tegenpartij_naam, tegenpartij_iban, omschrijving, kenmerk }. opt = { peil ('JJJJ-MM-DD': wat de bank op die dag wist; standaard
 * vandaag), bank_tot ('JJJJ-MM-DD' | null: dekking van de nagekeken rekeningen), prive (bool), leverancier_ibans: [], namen: [schuldeiser, leverancier] }.
 * → { uitkomst: al_betaald | betaald | deels | twee_keer | kandidaat | open | niet_vast, reden, betalingen: [{ datum, centen, sterkte, voor_brief }],
 *     bedrag_centen, rest_centen, kandidaat, bank_tot, iban_onbekend, venster }
 */
function match(brief, rijen, opt) {
  opt = opt || {};
  const peil = String(opt.peil || isoDag(Date.now())).slice(0, 10);
  const bdatum = brief.datum || peil;
  const bankTot = opt.bank_tot ? String(opt.bank_tot).slice(0, 10) : null;
  const bekend = new Set((opt.leverancier_ibans || []).map(function (i) { return String(i).replace(/\s/g, '').toUpperCase(); }));
  const ibanOnbekend = bekend.size > 0 && brief.ibans.some(function (i) { return !bekend.has(i); });
  const B = brief.bedrag_centen != null ? brief.bedrag_centen : brief.openstaand_centen;
  const basis = { bedrag_centen: B == null ? null : B, openstaand_centen: brief.openstaand_centen, bank_tot: bankTot, iban_onbekend: ibanOnbekend, betalingen: [], rest_centen: null, kandidaat: null };
  if (opt.prive) return Object.assign(basis, { uitkomst: 'niet_vast', reden: 'prive' });
  const van = brief.factuurdatum && brief.factuurdatum <= bdatum ? plusDagen(brief.factuurdatum, -7) : plusDagen(bdatum, -VENSTER_ZONDER_DATUM);
  basis.venster = { van, tot: peil };
  const binnen = (rijen || []).filter(function (r) { const d = String(r.boekdatum || '').slice(0, 10); return d >= van && d <= peil && Number.isFinite(Number(r.bedrag_centen)); })
    .map(function (r) { return Object.assign({}, r, { boekdatum: String(r.boekdatum).slice(0, 10), bedrag_centen: Number(r.bedrag_centen), _tp: tegenpartij(r) }); })
    .sort(function (a, b) { return a.boekdatum < b.boekdatum ? -1 : a.boekdatum > b.boekdatum ? 1 : 0; });
  // storno: een afschrijving met binnen 10 dagen een bijschrijving van hetzelfde bedrag van dezelfde tegenpartij telt niet (elke bijschrijving één keer)
  const af = binnen.filter(function (r) { return r.bedrag_centen < 0; }), bij = binnen.filter(function (r) { return r.bedrag_centen > 0; });
  const weg = new Set(), gebruikt = new Set();
  for (const a of af) for (const b of bij) {
    if (gebruikt.has(b) || b.bedrag_centen !== -a.bedrag_centen || b.boekdatum < a.boekdatum || b.boekdatum > plusDagen(a.boekdatum, STORNO_DAGEN)) continue;
    const ta = a._tp, tb = b._tp;
    if ((ta.iban && tb.iban && ta.iban === tb.iban) || (ta.naam && ta.naam === tb.naam)) { weg.add(a); gebruikt.add(b); break; }
  }
  const echt = af.filter(function (a) { return !weg.has(a); });
  // hoog: nummer in omschrijving/kenmerk en niet ook bij een afschrijving aan een andere tegenpartij (betaaldiensten tellen niet als andere)
  const metNummer = brief.nummer_norm && brief.nummer_norm.length >= NUMMER_MIN ? echt.filter(function (a) { return nummerIn(brief.nummer_norm, a); }) : [];
  const nummerUniek = metNummer.every(function (a) { return metNummer.every(function (b) { return zelfdePartij(a._tp, b._tp); }); });
  const ibansOk = new Set(brief.ibans.concat(Array.from(bekend)));
  const bedragen = [brief.bedrag_centen, brief.openstaand_centen].filter(function (c) { return c != null; });
  const namen = (opt.namen || []).concat([brief.naam, brief.domein ? brief.domein.split('.')[0] : null]).filter(Boolean);
  const treffers = [];
  for (const a of echt) {
    const c = -a.bedrag_centen;
    let st = null;
    if (nummerUniek && metNummer.indexOf(a) >= 0) st = 'hoog';
    else if (a._tp.iban && ibansOk.has(a._tp.iban) && bedragen.indexOf(c) >= 0) st = 'redelijk';
    else if (bedragen.some(function (x) { return Math.abs(c - x) <= x * ZWAK_MARGE; }) && naamLijkt(a.tegenpartij_naam, namen)) st = 'zwak';
    if (st) treffers.push({ datum: a.boekdatum, centen: c, sterkte: st, voor_brief: a.boekdatum < minWerkdagen(bdatum, VOOR_WERKDAGEN) });
  }
  const bet = treffers.filter(function (t) { return t.sterkte !== 'zwak'; });
  basis.betalingen = bet;
  const hoog = bet.filter(function (t) { return t.sterkte === 'hoog'; });
  const som = bet.reduce(function (s, t) { return s + t.centen; }, 0), somVoor = bet.filter(function (t) { return t.voor_brief; }).reduce(function (s, t) { return s + t.centen; }, 0);
  const dekkingOk = !!bankTot && bankTot >= minWerkdagen(bdatum, 1);
  if (hoog.length >= 2 && (B != null ? hoog.reduce(function (s, t) { return s + t.centen; }, 0) >= 2 * B - 1 : hoog.every(function (t) { return t.centen === hoog[0].centen; })))
    return Object.assign(basis, { uitkomst: 'twee_keer', reden: null });
  // de brief rekent al een ontvangen deel mee (openstaand < totaal, dossier A): betalingen vanaf de brief tellen tegen het openstaande bedrag;
  // alleen eerdere (al verrekende) betalingen = nog open
  const O = brief.openstaand_centen, T = brief.bedrag_centen;
  if (bet.length && O != null && T != null && O < T) {
    const na = bet.filter(function (t) { return !t.voor_brief; }), somNa = na.reduce(function (s, t) { return s + t.centen; }, 0);
    if (somVoor >= T - 1) return Object.assign(basis, { uitkomst: 'al_betaald', reden: null });
    basis.betalingen = na;
    if (somNa >= O - 1) return Object.assign(basis, { uitkomst: 'betaald', reden: 'deel_ontvangen' });
    if (somNa > 0) return Object.assign(basis, { uitkomst: 'deels', reden: dekkingOk ? 'deel_ontvangen' : 'bank_achter', rest_centen: O - somNa });
    if (!dekkingOk) return Object.assign(basis, { uitkomst: 'niet_vast', reden: bankTot ? 'bank_achter' : 'geen_bank' });
    return Object.assign(basis, { uitkomst: 'open', reden: 'deel_ontvangen' });
  }
  if (bet.length) {
    if (B == null) return Object.assign(basis, { uitkomst: somVoor > 0 ? 'al_betaald' : 'betaald', reden: 'bedrag_onbekend' });
    if (somVoor >= B - 1) return Object.assign(basis, { uitkomst: 'al_betaald', reden: null });
    if (som >= B - 1) return Object.assign(basis, { uitkomst: 'betaald', reden: null });
    return Object.assign(basis, { uitkomst: 'deels', reden: dekkingOk ? null : 'bank_achter', rest_centen: B - som });
  }
  const zwak = treffers.filter(function (t) { return t.sterkte === 'zwak'; });
  if (zwak.length) return Object.assign(basis, { uitkomst: 'kandidaat', reden: null, kandidaat: zwak[zwak.length - 1] });
  if (!dekkingOk) return Object.assign(basis, { uitkomst: 'niet_vast', reden: bankTot ? 'bank_achter' : 'geen_bank' });
  return Object.assign(basis, { uitkomst: 'open', reden: O != null && T != null && O < T ? 'deel_ontvangen' : null });
}

/*
 * kaart(d) — § 3.4, één per dossier. d = { sleutel, schuldeiser (naam), nummer, niveau, m (uitkomst van match), afzender_herkend (bool),
 * factuur_bekend (bool | null), vervaldatum, stuk_id }. → payload voor mk_voor_jou_zet, of null (betaald na de brief: geen kaart nodig).
 */
function sterkteTekst(s) { return s === 'hoog' ? 'op factuurnummer' : 'op rekening en bedrag'; }
function kaart(d) {
  const m = d.m, se = cel(d.schuldeiser || 'onbekende afzender', 40), nr = cel(d.nummer, 24);
  const soort = d.niveau >= 3 ? (d.niveau >= 4 ? 'Incassobrief' : 'Aanmaning') : 'Herinnering';
  const kop = soort + ' ' + se + ' ' + nr;
  // titel ≤ 90: de uitkomst gaat altijd mee, de naam (en daarna het nummer) wordt ingekort
  const kort = function (uit) {
    const vrij = MAX_TITEL - soort.length - uit.length - 4;
    const n2 = nr.length <= Math.max(8, vrij - 12) ? nr : nr.slice(0, Math.max(8, vrij - 12));
    const s2 = se.length <= vrij - n2.length ? se : se.slice(0, Math.max(6, vrij - n2.length - 1)).trim() + '…';
    return cel(soort + ' ' + s2 + ' ' + n2 + ': ' + uit, MAX_TITEL);
  };
  const bank = m.bank_tot ? 'bank bijgewerkt t/m ' + nlDatum(m.bank_tot) : 'bank niet bijgewerkt';
  const laatste = m.betalingen.length ? m.betalingen[m.betalingen.length - 1] : null;
  let titel, zin;
  if (m.uitkomst === 'al_betaald') {
    const b = m.betalingen.filter(function (t) { return t.voor_brief; }); const t = b[b.length - 1] || laatste;
    titel = kort('al betaald'); zin = 'al betaald op ' + nlDatum(t.datum) + ' (' + sterkteTekst(t.sterkte) + '). Niet opnieuw betalen.';
  } else if (m.uitkomst === 'betaald') {
    if (!laatste || laatste.sterkte === 'hoog') return null;
    titel = kort('lijkt betaald'); zin = 'lijkt betaald op ' + nlDatum(laatste.datum) + ' (' + sterkteTekst(laatste.sterkte) + '; het nummer staat niet bij de betaling). Klopt dat, zet de kaart dan op gedaan.';
  } else if (m.uitkomst === 'open') {
    titel = kort(m.reden === 'deel_ontvangen' ? 'rest nog niet betaald' : 'nog niet betaald');
    zin = (m.reden === 'deel_ontvangen' ? 'een deel is al betaald (de brief rekent het mee); de rest is nog niet betaald (' : 'nog niet betaald (') + bank + ').' + (m.bedrag_centen != null ? ' Bedrag ' + euro(m.openstaand_centen != null ? m.openstaand_centen : m.bedrag_centen) + (d.vervaldatum ? ', de brief vraagt betaling vóór ' + nlDatum(d.vervaldatum) : '') + '.' : (d.vervaldatum ? ' De brief vraagt betaling vóór ' + nlDatum(d.vervaldatum) + '.' : ''));
  } else if (m.uitkomst === 'deels') {
    titel = kort('deels betaald');
    zin = 'deels betaald: ' + euro(m.betalingen.reduce(function (s, t) { return s + t.centen; }, 0)) + ' op ' + m.betalingen.map(function (t) { return nlDatum(t.datum); }).join(' en ') + ', rest ' + euro(m.rest_centen) + ' (' + bank + ').';
  } else if (m.uitkomst === 'kandidaat') {
    titel = kort('mogelijk al betaald?');
    zin = 'mogelijk al betaald op ' + nlDatum(m.kandidaat.datum) + ' (' + euro(m.kandidaat.centen) + '; alleen naam en bedrag kloppen). Klopt dat?';
  } else if (m.uitkomst === 'twee_keer') {
    const h = m.betalingen.filter(function (t) { return t.sterkte === 'hoog'; });
    titel = kort('twee keer betaald?');
    zin = 'lijkt twee keer betaald (' + h.map(function (t) { return nlDatum(t.datum); }).join(' en ') + ', elk ' + euro(h[0].centen) + '). Terugvragen of verrekenen?';
  } else {
    titel = kort('niet na te gaan');
    zin = 'niet na te gaan: ' + (m.reden === 'prive' ? 'privérekening niet gekoppeld' : (m.bank_tot ? 'bank pas bij tot ' + nlDatum(m.bank_tot) : 'bank niet bijgewerkt')) + '.';
  }
  const extra = [];
  if (d.niveau >= 2) extra.push(d.niveau >= 4 ? 'Dit komt van een incassobureau of deurwaarder.' : 'Dit is een ' + NIVEAU_NAAM[d.niveau] + '.');
  if (!d.afzender_herkend) extra.push('Afzender niet herkend.');
  if (m.iban_onbekend) extra.push('Let op: ander rekeningnummer dan we van deze leverancier kennen.');
  if (d.factuur_bekend === false) extra.push('De oorspronkelijke factuur staat niet in Facturen.');
  // de kop staat al in de titel; waarschuwingen gaan vóór de slotzin, die alleen meekomt als hij past (nooit een waarschuwing afkappen)
  const kern = cel(nr + ' van ' + se + ': ' + zin + (extra.length ? ' ' + extra.join(' ') : ''), MAX_WAAROM);
  const slot = ' Socev keek alleen in de zakelijke bank; hij betaalt nooit zelf.';
  const waarom = kern.length + slot.length <= MAX_WAAROM ? kern + slot : kern;
  const besluit = m.uitkomst === 'kandidaat' || m.uitkomst === 'twee_keer';
  return { sleutel: d.sleutel, soort: besluit ? 'besluit' : 'doen', waar: 'overal', prive: true, duur_min: 5, volgorde: 25,
    titel, waarom,
    stappen: besluit
      ? (m.uitkomst === 'twee_keer' ? ['Ja = vraag het terug of laat verrekenen (Socev kan een conceptmail klaarzetten), Nee = het klopt zo.'] : ['Ja = het is betaald (kaart dicht), Nee = nog niet betaald: betaal het of neem contact op met de afzender.'])
      : (m.uitkomst === 'al_betaald' ? ['Niet opnieuw betalen; laat de afzender eventueel weten dat het al betaald is.', 'Klaar? Zet deze kaart op gedaan.']
        : ['Bekijk het stuk in de Socev-app onder Intake.', 'Betaal het of neem contact op met de afzender als het niet klopt.', 'Klaar? Zet deze kaart op gedaan; komt de betaling binnen, dan sluit Socev hem zelf.']),
    herkomst: { module: 'intake', handmatig: 'intake', keten: true, doel: { scherm: 'intake', focus: 'stuk:' + d.stuk_id } } };
}
// bewijs waarmee de pod de kaart zelf sluit (een hoge betaling na de brief); null = niet sluiten
function sluitBewijs(m) {
  if (m.uitkomst !== 'betaald') return null;
  const h = m.betalingen.filter(function (t) { return t.sterkte === 'hoog' && !t.voor_brief; });
  if (!h.length) return null;
  return 'Betaald op ' + h.map(function (t) { return nlDatum(t.datum); }).join(' en ') + ' (op factuurnummer, ' + euro(h.reduce(function (s, t) { return s + t.centen; }, 0)) + ').';
}

module.exports = { kopNummer, norm, hash, centen, datumIso, minWerkdagen, plusDagen, niveau, NIVEAU_NAAM, oorspronkelijkeAfzender, briefLees, schuldeiser, dossierSleutel,
  nummerHash, schuldeiserHash, zelfdeDossier, nummerIn, match, kaart, sluitBewijs, naamNorm, BETAALDIENST, MAX_TITEL, MAX_WAAROM };
