'use strict';
/*
 * paypal-bewijs.js — de PayPal-laag van de bankluis (wv765, 22-10-2026). Bouwplan: vault 01_Ontwikkeling/Privé-financiën -
 * ontwerp levend overzicht (bouwplan 22-10-2026).md, § 9.
 *
 * WAAROM. Op het ABN-afschrift staat bij elke PayPal-incasso alleen "PayPal Europe"; welke dienst erachter zit (Netflix, Disney,
 * een webwinkel) zie je daar niet. David (22-10-2026): "lees mijn mail mee, Afzender "service@paypal.nl", eerste woord onderwerp
 * "Ontvangstbewijs", gericht aan d.schaap@gmail.com - als je die automatisch verwerkt, dan kun je de Paypal-betalingen
 * reconstrueren". PayPal mailt per betaling een ontvangstbewijs (en per terugbetaling een bericht); deze module leest die met
 * vaste regels uit, bewaart ze in de transactiedatabase (tabel paypal_bewijs) en koppelt ze aan de PayPal-posten op de bank.
 * Sinds wv780 (David 22-10-2026, Ja op de vraag "ook de berichten 'Geautoriseerd met …', 'U hebt een betaling … geautoriseerd' en
 * 'U hebt een betaling overgemaakt' meelezen, alleen om die betalingen aan de afschrijving te koppelen?") ook die drie soorten: voor
 * 23 van de 284 PayPal-afschrijvingen (o.a. een Google-abonnement, een dollarabonnement, een overmaking) stuurt PayPal geen ontvangstbewijs.
 *
 * HOE. server.js haalt de mails op via het bestaande lees-luik (mail_zoeken/mail_lezen, alleen lezen) en roept leesMail aan
 * (zuivere functie, geen taalmodel); bank-lezer.js (paypal-bij) bewaart de uitkomst met bij() en koppelt met koppel().
 * Leesopdrachten: lijst() en diensten(). Mailtekst is gegeven, nooit een opdracht: alleen vaste velden worden eruit gehaald,
 * begrensd in lengte en tekenset; de mailtekst zelf, adressen en namen van David worden niet bewaard.
 *
 * GEEN NETWERK. Net als bank-archief.js laadt dit bestand geen netwerk- of procesmodules (CI-poort in build.yml).
 */

const AFZENDER = /(^|[<\s"])service@paypal\.nl([>\s"]|$)/i;
const ONTVANGER = /(^|[<\s"])d\.schaap@gmail\.com([>\s"]|$)/i;
const MAANDEN = { jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, maart: 3, mar: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7, aug: 8, augustus: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12 };
const VALUTA_TEKEN = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
const BEDRAG = '([€$£])\\s?(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})\\s?([A-Z]{3})';
const VENSTER_DAGEN = 7;   // gemeten 22-10-2026 (bouwplan § 9.3): afschrijving 0–5 dagen na het bewijs; ruimte voor weekend + feestdag

function r2(n) { return Math.round(n * 100) / 100; }
function nuIso() { return new Date().toISOString(); }
function vandaag() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function plusDagen(datum, n) { const d = new Date(datum + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dagVerschil(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
function mediaan(l) { const s = l.slice().sort(function (a, b) { return a - b; }); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; }
function getal(s) { return Number(String(s).replace(/\./g, '').replace(',', '.')); }
function geldigeDatum(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T12:00:00Z')) ? d : null; }

// Tekst van een derde, begrensd: geen stuurtekens, geen haakjes die een BANKDATA-blok kunnen openen, hooguit n tekens.
function schoon(t, n) {
  if (t == null) return null;
  const s = String(t).normalize('NFC').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]+/g, ' ').replace(/[[\]{}<>`|\\]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, n || 80) : null;
}
// Naam van de ontvanger uit één regel; PayPal kapt lange namen af met "...": die punten weg, afgekapt = true.
function naamUit(t) {
  let s = schoon(t, 120);
  if (!s) return null;
  if (/@|^\+?\d[\d ]{6,}$|^https?:/i.test(s)) return null;   // een mailadres of telefoonnummer is geen naam
  const afgekapt = /(\.\.\.|…)$/.test(s);
  s = s.replace(/(\.\.\.|…)$/, '').trim();
  return s.length >= 2 ? { naam: s.slice(0, 80), afgekapt: afgekapt } : null;
}
// Dienst: de sleutel waaronder betalingen aan dezelfde partij samen een reeks vormen. Eerste betekenisvolle woord, zonder
// rechtsvorm en domein ("Netflix.com" → netflix, "Google Payment Ireland Ltd." → google, "HBO Nordic AB" → hbo).
const STOP = new Set(['the', 'walt', 'de', 'het', 'een', 'www', 'paypal', 'stichting', 'vereniging', 'fonds', 'b', 'v', 'bv', 'nv', 'ltd', 'limited', 'inc', 'gmbh', 'ab', 'sa', 'sarl', 'llc']);
function dienstSleutel(naam) {
  if (!naam) return null;
  const w = String(naam).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.(com|nl|net|org|io|eu|de|co\.uk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(function (x) { return x.length >= 2 && !STOP.has(x); });
  return w.length ? w[0].slice(0, 40) : null;
}
function datumUit(t) {
  if (!t) return null;
  let m = /(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})/i.exec(t);   // 10 feb 2026, 4 september 2026, 14 juli 2025
  if (m && MAANDEN[m[2].toLowerCase()]) return geldigeDatum(m[3] + '-' + String(MAANDEN[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0'));
  m = /([a-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})/i.exec(t);       // sep 04, 2026 06:54:06 CEST
  if (m && MAANDEN[m[1].toLowerCase()]) return geldigeDatum(m[3] + '-' + String(MAANDEN[m[1].toLowerCase()]).padStart(2, '0') + '-' + m[2].padStart(2, '0'));
  return null;
}
// Valutateken en -code moeten bij elkaar passen (€ … EUR); anders telt de code (een onbekend teken komt in de vormen niet voor).
function bedragUit(m) { return m ? { bedrag: getal(m[2]), valuta: m[3] } : null; }

/*
 * soortVanOnderwerp(onderwerp) — welke mail dit is, alleen op het onderwerp (server.js opent een mail pas als dit iets geeft).
 *  - "Ontvangstbewijs …"                                        → betaling
 *  - "U hebt een terugbetaling van …" / "Uw terugbetaling van …" → terugbetaling
 *  - "U hebt een betaling aan <ontvanger> geautoriseerd"         → betaling, vorm geautoriseerd (wv780)
 *  - "<ontvanger>: € 18,00 EUR" (tekst "Geautoriseerd met …")    → betaling, vorm geautoriseerd (wv780)
 *  - "U hebt een betaling overgemaakt"                           → betaling, vorm overgemaakt (wv780)
 * Andere PayPal-mails ("Uw betaling aan … is verwerkt", "U hebt een bestelling geplaatst bij …", claims, inlogberichten) niet: die
 * vallen buiten Davids afbakening (de eerste twee liepen gemeten 22-10 alleen via de creditcard en hebben al een ontvangstbewijs).
 */
function soortVanOnderwerp(o) {
  const ond = schoon(o, 200) || '';
  if (/^Ontvangstbewijs\b/i.test(ond)) return { soort: 'betaling', vorm: null };
  if (/^(U hebt een terugbetaling van|Uw terugbetaling van)\b/i.test(ond)) return { soort: 'terugbetaling', vorm: null };
  if (/^U hebt een betaling aan .{2,90} geautoriseerd$/i.test(ond)) return { soort: 'betaling', vorm: 'geautoriseerd' };
  if (/^[^:]{2,90}:\s?[€$£]\s?\d{1,3}(?:\.\d{3})*,\d{2}\s?[A-Z]{3}$/.test(ond)) return { soort: 'betaling', vorm: 'geautoriseerd' };
  if (/^U hebt een betaling overgemaakt$/i.test(ond)) return { soort: 'betaling', vorm: 'overgemaakt' };
  return null;
}

/*
 * leesMail(m) — één mail uit het lees-luik ({id, van, aan, onderwerp, snippet, tekst, dag_lokaal}) → bewijs of { fout }.
 * Twee soorten ontvangstbewijs ("… voor uw betaling aan <ontvanger>" en "… voor uw PayPal-betaling" met de ontvanger pas in
 * de tekst), twee soorten terugbetaling ("U hebt een terugbetaling van …", "Uw terugbetaling van … is onderweg") en sinds wv780
 * twee soorten autorisatie (status geautoriseerd) en de overmaking (zie soortVanOnderwerp).
 */
function leesMail(m) {
  if (!m || typeof m !== 'object') return { fout: 'geen mail' };
  const id = typeof m.id === 'string' && /^[0-9a-f]{6,40}$/i.test(m.id) ? m.id : null;
  if (!id) return { fout: 'mail-id ongeldig' };
  if (!AFZENDER.test(String(m.van || ''))) return { fout: 'afzender is niet service@paypal.nl', mail_id: id };
  if (!ONTVANGER.test(String(m.aan || ''))) return { fout: 'niet gericht aan d.schaap@gmail.com', mail_id: id };
  const ond = schoon(m.onderwerp, 200) || '';
  const sv = soortVanOnderwerp(ond);
  if (!sv) return { fout: 'onderwerp is geen ontvangstbewijs, autorisatie, overmaking of terugbetaling', mail_id: id };
  const soort = sv.soort;
  // Alleen de tekst, zonder links; de snippet als terugval (het lees-luik geeft altijd een snippet).
  const t = String(m.tekst || '').replace(/\[https?:\/\/[^\]]*\]/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[\u00a0\u202f]/g, ' ').slice(0, 20000);
  const s = String(m.snippet || '').replace(/[\u00a0\u202f]/g, ' ').slice(0, 1000);
  const plat = (t + '\n' + s);
  const ref = (/Transactiereferentie:?\s*\n?\s*([0-9A-Z]{17})\b/.exec(plat) || [])[1] || null;
  const b = { mail_id: id, soort: soort, ref: ref, datum: null, ontvanger: null, afgekapt: false, bedrag: null, valuta: null, bedrag_eur: null,
    bron: 'onbekend', bron_eind: null, status: null, afschrift_naam: null, vorm: null, origineel: null };
  const kandidaten = [];
  let x;
  if (soort === 'betaling' && sv.vorm) {
    // wv780: autorisatie ("U hebt een betaling van € 12,00 EUR aan <ontvanger> (adres) geautoriseerd" / "Je hebt € 18,00 EUR
    // geautoriseerd voor <ontvanger>") of overmaking ("U hebt € 25,00 EUR overgemaakt aan <ontvanger>")
    if (sv.vorm === 'geautoriseerd' && (x = new RegExp('U hebt een betaling van ' + BEDRAG + ' aan ([^\\n(]+?)\\s*(?:\\(|\\n|geautoriseerd|$)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]);
    } else if (sv.vorm === 'geautoriseerd' && (x = new RegExp('Je hebt ' + BEDRAG + ' geautoriseerd voor ([^\\n]+)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]);
    } else if (sv.vorm === 'overgemaakt' && (x = new RegExp('U hebt ' + BEDRAG + ' overgemaakt aan ([^\\n]+)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]);
    }
    if ((x = /(?:^|\n)Webwinkel\n([^\n]+)/.exec(t))) kandidaten.push(x[1]);
    if (!kandidaten.length && (x = /^U hebt een betaling aan (.+) geautoriseerd$/i.exec(ond))) kandidaten.push(x[1]);
    if (!kandidaten.length && (x = /^([^:]{2,90}):\s?[€$£]/.exec(ond))) kandidaten.push(x[1]);
    b.vorm = sv.vorm;
  }
  if (soort === 'betaling') {
    // bedrag en ontvanger
    if (sv.vorm) { /* hierboven */ }
    else if ((x = new RegExp('U hebt ' + BEDRAG + ' betaald aan ([^\\n]+?)(?:\\s+Transactiereferentie|\\n|$)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]); b.vorm = 'betaling-aan';
    } else if ((x = new RegExp('betaling van ' + BEDRAG + ' overgemaakt naar ([^\\n(]+)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]); b.vorm = 'overgemaakt-naar';
    } else if ((x = new RegExp('\\bBetaling ' + BEDRAG).exec(t))) {   // "Bedankt dat u met PayPal hebt betaald": Betaling € 5,00 USD
      Object.assign(b, bedragUit(x)); b.vorm = 'webwinkel';
    }
    if (!sv.vorm) {
      if ((x = /(?:^|\n)Betaling aan\n([^\n]+)/.exec(t))) kandidaten.unshift(x[1]);
      if ((x = /(?:^|\n)Webwinkel\n([^\n]+)/.exec(t))) kandidaten.push(x[1].replace(/\s+Factuurreferentie.*$/, ''));
      if ((x = /\n([^\n]{2,90}?) betaald met\b/.exec(t))) kandidaten.push(x[1]);
      if (!kandidaten.length && (x = /betaling aan (.+)$/i.exec(ond))) kandidaten.push(x[1]);
    }
    // EUR: wat er van de bron afging. Twee methoden (PayPal-saldo + bank, Fable wv765 #6): alleen het bankdeel komt op de bank.
    const blok = (/(?:betaald met|Betaald met:|Gebruikte betaalmethoden|Geautoriseerd met\n)([\s\S]{0,400}?)(?:Transactiereferentie|Betaling bekijken|Je betaling is verzonden|Problemen met|-{10}|$)/.exec(t) || [])[1] || '';
    const delen = [];
    blok.replace(new RegExp('([^€$£]{0,80}?)' + BEDRAG, 'g'), function (heel, wat, teken, bedrag, code) { delen.push({ wat: wat, bedrag: getal(bedrag), valuta: code }); return heel; });
    const bankDeel = delen.filter(function (d) { return /bank|rekening/i.test(d.wat) && d.valuta === 'EUR'; });
    if (delen.length >= 2 && bankDeel.length === 1 && delen.some(function (d) { return !/bank|rekening/i.test(d.wat); })) { b.bedrag_eur = bankDeel[0].bedrag; b.vorm = 'gemengd'; }
    else if ((x = new RegExp('betaald met\\s+[^€$£]{0,80}?' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    else if ((x = new RegExp('Gebruikte betaalmethoden[^€$£]{0,80}?' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    else if ((x = new RegExp('(?:Geautoriseerd met|Betaald met:)\\n[^€$£]{0,80}?' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);   // wv780
    else if ((x = new RegExp('Omgerekend van:\\s*' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    else if ((x = new RegExp('Overgemaakt bedrag\\s*' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    // bron van het geld
    const bron = (/betaald met\s+([\s\S]{0,80}?)[€$£]/.exec(t) || /Gebruikte betaalmethoden \(totaal\)\s+([\s\S]{0,80}?)[€$£]/.exec(t) ||
      /(?:Geautoriseerd met|Betaald met:)\n([\s\S]{0,80}?)[€$£]/.exec(t) || [])[1] || '';
    if (b.vorm === 'gemengd') b.bron = 'bank';
    else if (/creditcard|visa|mastercard|american express|amex/i.test(bron)) b.bron = 'kaart';
    else if (/PayPal-saldo|saldo/i.test(bron)) b.bron = 'saldo';
    else if (/bank|rekening/i.test(bron)) b.bron = 'bank';
    const eind = /(?:x-|••|\*\*)(\d{4})\b/.exec(bron);
    if (eind) b.bron_eind = eind[1];
    if ((x = /Transactiedatum:?\s*\n?\s*([^\n]{6,40})/.exec(t)) || (x = /(?:^|\n)Datum\n([^\n]{6,30})/.exec(t)) || (x = /Transactiedatum (\d{1,2} \w+\.? \d{4})/.exec(s))) b.datum = datumUit(x[1]);
    if ((x = /Betaalstatus\n([A-Z ]{3,30})\n/.exec(t))) b.status = schoon(x[1], 30).toLowerCase();
    if (sv.vorm === 'geautoriseerd') b.status = 'geautoriseerd';   // wv780: merkteken van een autorisatie (bij() voegt samen met het latere bewijs)
    if ((x = /afschrift te staan als\s*\n?\s*["'](PAYPAL\s*\n?\s*\*[^"'\n]{1,40}(?:\n[^"'\n]{0,20})?)["']/i.exec(t))) b.afschrift_naam = schoon(x[1], 40);
  } else {
    b.vorm = 'terugbetaling';
    if ((x = new RegExp('([^\\n]{2,90}?) heeft (?:een (?:gedeeltelijke )?terugbetaling van )?' + BEDRAG + ' (?:terugbetaald|aan u overgemaakt)').exec(plat))) {
      Object.assign(b, bedragUit({ 1: x[2], 2: x[3], 3: x[4] })); kandidaten.push(x[1].replace(/^Beste [^,]*,\s*/, ''));
    } else if ((x = new RegExp('Uw terugbetaling van ' + BEDRAG + ' van ([^\\n]+)').exec(plat))) {
      Object.assign(b, bedragUit(x)); kandidaten.push(x[4]);
    }
    if ((x = /Terugbetaling betaald door\n([^\n]+)/.exec(t))) kandidaten.unshift(x[1]);
    if (!kandidaten.length && (x = /terugbetaling van (.+?)( is onderweg)?$/i.exec(ond))) kandidaten.push(x[1]);
    const naar = (/Terugbetaling aan\s*\n?\s*([^\n€$£]{0,80})[€$£]/.exec(t) || /teruggestort op uw ([^\n.]{0,80})/.exec(t) || [])[1] || '';
    if ((x = new RegExp('Terugbetaling aan[^€$£\\n]{0,80}' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    else if ((x = new RegExp('Ontvangen bedrag\\s*' + BEDRAG).exec(t)) && x[3] === 'EUR') b.bedrag_eur = getal(x[2]);
    if (/visa|mastercard|creditcard|american express/i.test(naar)) b.bron = 'kaart';
    else if (/bank|rekening/i.test(naar)) b.bron = 'bank';
    else if (/PayPal-rekening|saldo/i.test(naar)) b.bron = 'saldo';
    const eind = /(?:x-|••|eindigend op )(\d{4})\b/.exec(naar);
    if (eind) b.bron_eind = eind[1];
    if ((x = /Transactiedatum\n([^\n]{6,40})/.exec(t))) b.datum = datumUit(x[1]);
    // oorspronkelijke aankoop: één terugbetaling kan als "onderweg" (zonder referentie) én als "U hebt een terugbetaling" komen
    if ((x = /voor uw aankoop op (\d{1,2} \w+ \d{4})/.exec(t.replace(/\s+/g, ' '))) || (x = /betaald op (\d{1,2} \w+ \d{4})/.exec(t.replace(/\s+/g, ' ')))) b.origineel = datumUit(x[1]);
  }
  if (b.valuta === 'EUR' && b.bedrag_eur == null && b.bedrag != null) b.bedrag_eur = b.bedrag;
  if (!b.datum) b.datum = geldigeDatum(String(m.dag_lokaal || '').slice(0, 10));
  // ontvanger: de eerste volledige naam, anders de langste afgekapte
  const namen = kandidaten.map(naamUit).filter(Boolean);
  const vol = namen.find(function (n) { return !n.afgekapt; });
  const best = vol || namen.sort(function (p, q) { return q.naam.length - p.naam.length; })[0];
  if (best) { b.ontvanger = best.naam; b.afgekapt = !vol; }
  if (b.bedrag == null || !(b.bedrag > 0) || b.bedrag > 100000) return { fout: 'geen bedrag gevonden', mail_id: id, soort: soort };
  if (!b.datum) return { fout: 'geen datum gevonden', mail_id: id, soort: soort };
  if (!b.ontvanger) return { fout: 'geen ontvanger gevonden', mail_id: id, soort: soort };
  if (!b.ref) b.ref = 'mail:' + id;   // "is onderweg" draagt geen transactiereferentie: dan de mail als sleutel
  b.dienst = dienstSleutel(b.ontvanger);
  b.bedrag = r2(b.bedrag); if (b.bedrag_eur != null) b.bedrag_eur = r2(b.bedrag_eur);
  return b;
}

// ── opslag (in de transactiedatabase van bank-archief.js; eigen tabel, eigen schemaversie) ──
const PP_SCHEMA = 1;
function schema(a) {
  a.db.exec('CREATE TABLE IF NOT EXISTS paypal_bewijs (ref TEXT PRIMARY KEY, soort TEXT NOT NULL, datum TEXT NOT NULL, ontvanger TEXT NOT NULL,' +
    ' afgekapt INTEGER NOT NULL DEFAULT 0, dienst TEXT, bedrag REAL NOT NULL, valuta TEXT NOT NULL, bedrag_eur REAL, bron TEXT NOT NULL, bron_eind TEXT,' +
    ' status TEXT, afschrift_naam TEXT, vorm TEXT, origineel TEXT, mail_ids TEXT NOT NULL, eerste_gezien TEXT NOT NULL, bijgewerkt TEXT NOT NULL,' +
    ' nr INTEGER, koppel_soort TEXT, koppel_dagen INTEGER, koppel_op TEXT);' +
    'CREATE INDEX IF NOT EXISTS pp_datum ON paypal_bewijs (datum);' +
    'CREATE INDEX IF NOT EXISTS pp_nr ON paypal_bewijs (nr);');
  const v = a.db.prepare("SELECT waarde FROM meta WHERE sleutel = 'paypal_schema'").get();
  if (!v) a.db.prepare("INSERT INTO meta (sleutel, waarde) VALUES ('paypal_schema', ?)").run(String(PP_SCHEMA));
  else if (Number(v.waarde) > PP_SCHEMA) throw new Error('paypal_bewijs heeft schema ' + v.waarde + ', deze code kent ' + PP_SCHEMA);
}
function metaZet(a, k, v) { a.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v == null ? null : String(v)); }
function metaLees(a, k) { const r = a.db.prepare('SELECT waarde FROM meta WHERE sleutel = ?').get(k); return r ? r.waarde : null; }

// Een bewijs zoals leesMail het gaf, opnieuw gecontroleerd (het komt via stdin uit server.js): alleen bekende velden en vormen.
function controleer(b) {
  if (!b || typeof b !== 'object') return null;
  const ok = typeof b.ref === 'string' && (/^[0-9A-Z]{17}$/.test(b.ref) || /^mail:[0-9a-f]{6,40}$/i.test(b.ref)) &&
    ['betaling', 'terugbetaling'].indexOf(b.soort) >= 0 && geldigeDatum(b.datum) && typeof b.mail_id === 'string' && /^[0-9a-f]{6,40}$/i.test(b.mail_id) &&
    typeof b.bedrag === 'number' && b.bedrag > 0 && b.bedrag < 100000 && typeof b.valuta === 'string' && /^[A-Z]{3}$/.test(b.valuta) &&
    (b.bedrag_eur == null || (typeof b.bedrag_eur === 'number' && b.bedrag_eur > 0 && b.bedrag_eur < 100000)) &&
    ['bank', 'kaart', 'saldo', 'onbekend'].indexOf(b.bron) >= 0 && (b.bron_eind == null || /^\d{4}$/.test(String(b.bron_eind))) && schoon(b.ontvanger, 80);
  if (!ok) return null;
  return { ref: b.ref, soort: b.soort, datum: b.datum, ontvanger: schoon(b.ontvanger, 80), afgekapt: b.afgekapt ? 1 : 0, dienst: dienstSleutel(b.ontvanger),
    bedrag: r2(b.bedrag), valuta: b.valuta, bedrag_eur: b.bedrag_eur == null ? null : r2(b.bedrag_eur), bron: b.bron, bron_eind: b.bron_eind == null ? null : String(b.bron_eind),
    status: schoon(b.status, 30), afschrift_naam: schoon(b.afschrift_naam, 40), vorm: schoon(b.vorm, 20), origineel: geldigeDatum(b.origineel), mail_id: b.mail_id };
}
/*
 * bij(a, lijst, fouten) — bewijzen bewaren. Idempotent op transactiereferentie: dezelfde betaling uit een tweede mail (PayPal
 * stuurt soms twee bewijzen) vult alleen lege velden aan en voegt het mail-id toe; een volledige naam wint van een afgekapte.
 * Autorisatie (status geautoriseerd, wv780) en ontvangstbewijs van dezelfde betaling worden één rij, het ontvangstbewijs wint:
 * op referentie, en anders op dienst + bedrag + valuta met het bewijs 0..AUT_DAGEN dagen na de autorisatie (1 dag ervóór mag,
 * Amerikaanse tijd). Een autorisatie met een ander bedrag dan het latere bewijs (deelbetaling) blijft apart staan.
 * fouten: [{mail_id, fout}] van leesMail, alleen geteld (en de laatste paar mail-id's bewaard om na te lopen).
 */
const AUT_DAGEN = 3;
function isAut(r) { return !!r && r.status === 'geautoriseerd'; }
function bij(a, lijst, fouten) {
  schema(a);
  const nu = nuIso(), uit = { aangeboden: (lijst || []).length, nieuw: 0, aangevuld: 0, ongewijzigd: 0, geweigerd: 0, niet_gelezen: (fouten || []).length };
  const lees = a.db.prepare('SELECT * FROM paypal_bewijs WHERE ref = ?');
  const zet = a.db.prepare('INSERT INTO paypal_bewijs (ref, soort, datum, ontvanger, afgekapt, dienst, bedrag, valuta, bedrag_eur, bron, bron_eind, status, afschrift_naam, vorm,' +
    ' origineel, mail_ids, eerste_gezien, bijgewerkt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Fable wv765 #5: dezelfde terugbetaling als "onderweg" (sleutel mail:…) én met referentie: zelfde dienst, bedrag en oorspronkelijke aankoop
  const tweeling = a.db.prepare("SELECT * FROM paypal_bewijs WHERE soort = 'terugbetaling' AND dienst = ? AND bedrag = ? AND valuta = ? AND origineel = ? AND ref != ?" +
    " AND ((ref LIKE 'mail:%') != (? LIKE 'mail:%'))");
  const weg = a.db.prepare('DELETE FROM paypal_bewijs WHERE ref = ?');
  const werk = a.db.prepare('UPDATE paypal_bewijs SET ontvanger = ?, afgekapt = ?, dienst = ?, bedrag_eur = ?, bron = ?, bron_eind = ?, status = ?, afschrift_naam = ?,' +
    ' mail_ids = ?, bijgewerkt = ? WHERE ref = ?');
  // wv780: autorisatie ↔ ontvangstbewijs van dezelfde betaling met een andere referentie (dichtstbijzijnde dag eerst)
  const autVan = a.db.prepare("SELECT * FROM paypal_bewijs WHERE soort = 'betaling' AND status = 'geautoriseerd' AND dienst = ? AND bedrag = ? AND valuta = ? AND datum BETWEEN ? AND ? AND ref != ?");
  const bewijsVan = a.db.prepare("SELECT * FROM paypal_bewijs WHERE soort = 'betaling' AND (status IS NULL OR status != 'geautoriseerd') AND dienst = ? AND bedrag = ? AND valuta = ? AND datum BETWEEN ? AND ? AND ref != ?");
  const dichtst = function (l, datum) { return l.sort(function (p, q) { return Math.abs(dagVerschil(p.datum, datum)) - Math.abs(dagVerschil(q.datum, datum)) || (p.ref < q.ref ? -1 : 1); })[0] || null; };
  const idsVan = function (r) { let l = []; try { l = JSON.parse(r.mail_ids) || []; } catch (e) { l = []; } return l; };
  const metId = function (l, id) { return l.indexOf(id) >= 0 ? l : l.concat([id]).slice(-5); };
  const doe = function () {
    (lijst || []).forEach(function (ruw) {
      const b = controleer(ruw);
      if (!b) { uit.geweigerd++; return; }
      const o = lees.get(b.ref);
      // autorisatie eerst bewaard, ontvangstbewijs met dezelfde referentie komt later: het bewijs vervangt de autorisatie
      if (o && isAut(o) && !isAut(b)) {
        weg.run(o.ref);
        zet.run(b.ref, b.soort, b.datum, b.ontvanger, b.afgekapt, b.dienst, b.bedrag, b.valuta, b.bedrag_eur, b.bron, b.bron_eind, b.status, b.afschrift_naam, b.vorm,
          b.origineel, JSON.stringify(metId(idsVan(o), b.mail_id)), o.eerste_gezien, nu);
        uit.samengevoegd = (uit.samengevoegd || 0) + 1; return;
      }
      if (o && !isAut(o) && isAut(b)) {   // bewijs staat er al: alleen het mail-id van de autorisatie erbij
        const ids = idsVan(o);
        if (ids.indexOf(b.mail_id) >= 0) { uit.ongewijzigd++; return; }
        a.db.prepare('UPDATE paypal_bewijs SET mail_ids = ?, bijgewerkt = ? WHERE ref = ?').run(JSON.stringify(metId(ids, b.mail_id)), nu, o.ref);
        uit.aangevuld++; return;
      }
      if (!o && b.soort === 'betaling' && b.dienst) {
        if (isAut(b)) {
          const bw = dichtst(bewijsVan.all(b.dienst, b.bedrag, b.valuta, plusDagen(b.datum, -1), plusDagen(b.datum, AUT_DAGEN), b.ref), b.datum);
          if (bw) {
            const ids = idsVan(bw);
            if (ids.indexOf(b.mail_id) < 0) a.db.prepare('UPDATE paypal_bewijs SET mail_ids = ?, bijgewerkt = ? WHERE ref = ?').run(JSON.stringify(metId(ids, b.mail_id)), nu, bw.ref);
            uit.aangevuld++; return;
          }
        } else {
          const au = dichtst(autVan.all(b.dienst, b.bedrag, b.valuta, plusDagen(b.datum, -AUT_DAGEN), plusDagen(b.datum, 1), b.ref), b.datum);
          if (au) {
            weg.run(au.ref);
            zet.run(b.ref, b.soort, b.datum, b.ontvanger, b.afgekapt, b.dienst, b.bedrag, b.valuta, b.bedrag_eur, b.bron, b.bron_eind, b.status, b.afschrift_naam, b.vorm,
              b.origineel, JSON.stringify(metId(idsVan(au), b.mail_id)), au.eerste_gezien, nu);
            uit.samengevoegd = (uit.samengevoegd || 0) + 1; return;
          }
        }
      }
      if (!o) {
        const tw = b.soort === 'terugbetaling' && b.origineel ? tweeling.get(b.dienst, b.bedrag, b.valuta, b.origineel, b.ref, b.ref) : null;
        let ids = [b.mail_id];
        if (tw) {
          let oud = []; try { oud = JSON.parse(tw.mail_ids) || []; } catch (e) { oud = []; }
          if (/^mail:/.test(b.ref)) {   // de definitieve staat er al: alleen het mail-id erbij
            if (oud.indexOf(b.mail_id) < 0) a.db.prepare('UPDATE paypal_bewijs SET mail_ids = ?, bijgewerkt = ? WHERE ref = ?').run(JSON.stringify(oud.concat([b.mail_id]).slice(-5)), nu, tw.ref);
            uit.aangevuld++; return;
          }
          weg.run(tw.ref); ids = oud.concat([b.mail_id]).slice(-5); uit.samengevoegd = (uit.samengevoegd || 0) + 1;
        }
        zet.run(b.ref, b.soort, b.datum, b.ontvanger, b.afgekapt, b.dienst, b.bedrag, b.valuta, b.bedrag_eur, b.bron, b.bron_eind, b.status, b.afschrift_naam, b.vorm,
          b.origineel, JSON.stringify(ids), nu, nu);
        uit.nieuw++; return;
      }
      let ids = []; try { ids = JSON.parse(o.mail_ids) || []; } catch (e) { ids = []; }
      const n = {
        ontvanger: o.afgekapt && !b.afgekapt ? b.ontvanger : o.ontvanger, afgekapt: o.afgekapt && !b.afgekapt ? 0 : o.afgekapt,
        bedrag_eur: o.bedrag_eur == null ? b.bedrag_eur : o.bedrag_eur, bron: o.bron === 'onbekend' ? b.bron : o.bron, bron_eind: o.bron_eind || b.bron_eind,
        status: o.status || b.status, afschrift_naam: o.afschrift_naam || b.afschrift_naam,
        mail_ids: ids.indexOf(b.mail_id) >= 0 ? ids : ids.concat([b.mail_id]).slice(-5) };
      n.dienst = dienstSleutel(n.ontvanger);
      const gewijzigd = n.ontvanger !== o.ontvanger || n.bedrag_eur !== o.bedrag_eur || n.bron !== o.bron || n.bron_eind !== o.bron_eind || n.status !== o.status ||
        n.afschrift_naam !== o.afschrift_naam || n.mail_ids.length !== ids.length;
      if (!gewijzigd) { uit.ongewijzigd++; return; }
      werk.run(n.ontvanger, n.afgekapt, n.dienst, n.bedrag_eur, n.bron, n.bron_eind, n.status, n.afschrift_naam, JSON.stringify(n.mail_ids), nu, b.ref);
      uit.aangevuld++;
    });
    if ((fouten || []).length) {
      let oud = []; try { oud = JSON.parse(metaLees(a, 'paypal_niet_gelezen') || '[]'); } catch (e) { oud = []; }
      const nieuw = fouten.filter(function (f) { return f && /^[0-9a-f]{6,40}$/i.test(String(f.mail_id || '')); })
        .map(function (f) { return { mail_id: f.mail_id, fout: schoon(f.fout, 60), op: nu.slice(0, 10) }; });
      const per = new Map(); oud.concat(nieuw).forEach(function (f) { per.set(f.mail_id, f); });
      metaZet(a, 'paypal_niet_gelezen', JSON.stringify(Array.from(per.values()).slice(-50)));
    }
    metaZet(a, 'paypal_bij_op', nu);
  };
  if (a._inTx) doe(); else { a.db.exec('BEGIN IMMEDIATE'); try { doe(); a.db.exec('COMMIT'); } catch (e) { try { a.db.exec('ROLLBACK'); } catch (e2) {} throw e; } }
  return uit;
}
// Welke mails al bewaard zijn (server.js leest dan alleen de nieuwe). Alleen mail-id's, sinds 'van'.
function bekend(a, van) {
  schema(a);
  const ids = new Set();
  a.db.prepare('SELECT mail_ids FROM paypal_bewijs WHERE datum >= ?').all(geldigeDatum(van) || '2000-01-01').forEach(function (r) {
    try { (JSON.parse(r.mail_ids) || []).forEach(function (i) { ids.add(i); }); } catch (e) {}
  });
  let ng = []; try { ng = JSON.parse(metaLees(a, 'paypal_niet_gelezen') || '[]'); } catch (e) { ng = []; }
  ng.forEach(function (f) { ids.add(f.mail_id); });   // onleesbare mail niet elke ronde opnieuw ophalen
  return Array.from(ids);
}

/*
 * koppel(a) — bewijzen aan PayPal-posten op de bank. Elke ronde opnieuw (deterministisch), behalve koppelingen die David zette.
 * Kandidaten: geboekte of wachtende posten met PayPal als tegenpartij; betaling ↔ afschrijving, terugbetaling ↔ bijschrijving;
 * alleen bewijzen met bron bank of onbekend (kaart en PayPal-saldo komen nooit op de bankrekening) en, als het bewijs de laatste
 * vier cijfers noemt, alleen de rekening met die vier cijfers. Venster: 0..VENSTER_DAGEN dagen na het bewijs (1 dag ervoor mag:
 * de transactiedatum van PayPal is Amerikaanse tijd).
 *  1. één op één: zelfde bedrag in euro's op de cent; paren op volgorde van dagverschil, dan datum (gulzig);
 *  2. twee bewijzen op één post: wat overblijft, twee bewijzen binnen het venster en hooguit 2 dagen uit elkaar die samen precies
 *     het bedrag zijn (meer of verder uit elkaar gaf toevalstreffers, Fable wv765 #3).
 */
function koppel(a) {
  schema(a);
  const nu = nuIso();
  const doe = function () {
    a.db.prepare("UPDATE paypal_bewijs SET nr = NULL, koppel_soort = NULL, koppel_dagen = NULL, koppel_op = NULL WHERE koppel_soort IS NULL OR koppel_soort != 'david'").run();
    const vast = new Set(a.db.prepare("SELECT nr FROM paypal_bewijs WHERE koppel_soort = 'david' AND nr IS NOT NULL").all().map(function (r) { return r.nr; }));
    const reks = new Map(a.db.prepare('SELECT rek, iban_eind, eigenaar FROM rekeningen').all().map(function (r) { return [r.rek, r]; }));
    const posten = a.db.prepare("SELECT nr, rek, datum, bedrag FROM transacties WHERE status IN ('booked', 'pending') AND lower(tegenpartij) LIKE '%paypal%' AND datum IS NOT NULL")
      .all().filter(function (t) { return !vast.has(t.nr) && ['extern', 'pot'].indexOf(String((reks.get(t.rek) || {}).eigenaar || '').toLowerCase()) < 0; });   // extern (wv709) en POT (wv786) niet
    const bewijzen = a.db.prepare("SELECT ref, soort, datum, dienst, bedrag_eur, bron, bron_eind FROM paypal_bewijs WHERE nr IS NULL AND bedrag_eur IS NOT NULL AND bron IN ('bank', 'onbekend')").all();
    const past = function (b, t) {
      if ((b.soort === 'betaling') !== (t.bedrag < 0)) return null;
      if (b.bron_eind && (reks.get(t.rek) || {}).iban_eind !== b.bron_eind) return null;
      const d = dagVerschil(b.datum, t.datum);
      return d >= -1 && d <= VENSTER_DAGEN ? d : null;
    };
    const centen = function (x) { return Math.round(Math.abs(x) * 100); };
    const zet = a.db.prepare('UPDATE paypal_bewijs SET nr = ?, koppel_soort = ?, koppel_dagen = ?, koppel_op = ? WHERE ref = ?');
    // 1. één op één
    const paren = [];
    const perBedrag = new Map();
    posten.forEach(function (t) { const k = centen(t.bedrag); if (!perBedrag.has(k)) perBedrag.set(k, []); perBedrag.get(k).push(t); });
    bewijzen.forEach(function (b) {
      (perBedrag.get(centen(b.bedrag_eur)) || []).forEach(function (t) { const d = past(b, t); if (d != null) paren.push({ b: b, t: t, d: d }); });
    });
    // Gulzig op kosten. Ronde A: kosten = dagverschil, een dag ervóór telt als 5 (komt zelden voor). Daaruit per dienst de
    // gebruikelijke vertraging (mediaan); ronde B: kosten = afstand tot die vertraging. Zo wint bij twee posten van hetzelfde bedrag
    // niet de dienst met het kleinste verschil maar de dienst die past (Fable wv765 #1: Google 11e/Disney 15e, posten 14e/17e).
    const gulzig = function (kosten) {
      const l = paren.map(function (p) { return { p: p, k: kosten(p) }; });
      l.sort(function (x, y) { return x.k - y.k || (x.p.b.datum < y.p.b.datum ? -1 : x.p.b.datum > y.p.b.datum ? 1 : 0) || x.p.t.nr - y.p.t.nr; });
      const bg = new Set(), tg = new Set(), uitP = [];
      l.forEach(function (x) { if (bg.has(x.p.b.ref) || tg.has(x.p.t.nr)) return; bg.add(x.p.b.ref); tg.add(x.p.t.nr); uitP.push(x.p); });
      return uitP;
    };
    const vooraf = gulzig(function (p) { return p.d < 0 ? 5 : p.d; });
    const lagPer = new Map();
    vooraf.forEach(function (p) { if (!lagPer.has(p.b.dienst)) lagPer.set(p.b.dienst, []); lagPer.get(p.b.dienst).push(p.d); });
    const lag = new Map(Array.from(lagPer.entries()).filter(function (e) { return e[1].length >= 3; }).map(function (e) { return [e[0], mediaan(e[1])]; }));
    const gekozen = gulzig(function (p) { const L = lag.has(p.b.dienst) ? lag.get(p.b.dienst) : 2; return Math.abs(p.d - L) + (p.d < 0 ? 1 : 0); });
    const bGebruikt = new Set(), tGebruikt = new Set();
    let een = 0, som = 0;
    gekozen.forEach(function (p) { bGebruikt.add(p.b.ref); tGebruikt.add(p.t.nr); zet.run(p.t.nr, '1op1', p.d, nu, p.b.ref); een++; });
    // 2. twee bewijzen op één post
    const restB = bewijzen.filter(function (b) { return !bGebruikt.has(b.ref); });
    posten.filter(function (t) { return !tGebruikt.has(t.nr); }).sort(function (p, q) { return p.datum < q.datum ? -1 : 1; }).forEach(function (t) {
      const kand = restB.filter(function (b) { return !bGebruikt.has(b.ref) && past(b, t) != null && centen(b.bedrag_eur) < centen(t.bedrag); }).slice(0, 12);
      const doel = centen(t.bedrag);
      let gevonden = null;
      const zoek = function (start, gekozen, totaal) {
        if (gevonden || gekozen.length > 2) return;
        if (totaal === doel && gekozen.length === 2 && Math.abs(dagVerschil(gekozen[0].datum, gekozen[1].datum)) <= 2) { gevonden = gekozen.slice(); return; }
        for (let i = start; i < kand.length && !gevonden; i++) {
          const c = centen(kand[i].bedrag_eur);
          if (totaal + c <= doel) { gekozen.push(kand[i]); zoek(i + 1, gekozen, totaal + c); gekozen.pop(); }
        }
      };
      zoek(0, [], 0);
      if (!gevonden) return;
      tGebruikt.add(t.nr);
      gevonden.forEach(function (b) { bGebruikt.add(b.ref); zet.run(t.nr, 'som', dagVerschil(b.datum, t.datum), nu, b.ref); });
      som++;
    });
    metaZet(a, 'paypal_koppel_op', nu);
    return { posten: posten.length, bewijzen_kandidaat: bewijzen.length, een_op_een: een, samengesteld: som };
  };
  if (a._inTx) return doe();
  a.db.exec('BEGIN IMMEDIATE');
  try { const r = doe(); a.db.exec('COMMIT'); return r; } catch (e) { try { a.db.exec('ROLLBACK'); } catch (e2) {} throw e; }
}

// Dienst per bankpost (nr → {dienst, naam}) voor de vaste-lastenherkenning (wv764): een PayPal-post krijgt de dienst van zijn
// bewijs; meer bewijzen op één post: de dienst als ze allemaal dezelfde zijn, anders 'meerdere'.
function dienstPerPost(a) {
  schema(a);
  const per = new Map();
  a.db.prepare('SELECT nr, dienst, ontvanger, datum FROM paypal_bewijs WHERE nr IS NOT NULL ORDER BY datum').all().forEach(function (r) {
    const o = per.get(r.nr);
    if (!o) per.set(r.nr, { dienst: r.dienst, naam: r.ontvanger });
    else if (o.dienst !== r.dienst) per.set(r.nr, { dienst: 'meerdere', naam: 'meerdere PayPal-betalingen' });
  });
  return per;
}

/*
 * reeksen(a) — vaste PayPal-diensten uit de bewijzen (alle bronnen: ook een abonnement op de creditcard is een vaste last).
 * Per dienst en bedragcluster (± 2%, of een prijsstap): ritme maand als er ≥ 3 posten zijn en in ≥ 80% van de maanden in de looptijd een post
 * staat (posten per maand = mediaan, zodat twee abonnementen van hetzelfde bedrag bij één dienst twee per maand geven), jaar
 * bij een gat van 350–380 dagen. Prijsstap: een cluster stopt en binnen 45 dagen begint bij dezelfde dienst een cluster met
 * hetzelfde ritme dat hooguit 50% afwijkt → één reeks met bedrag_vorig en gewijzigd_op. Actief: laatste post binnen 1,5 × ritme.
 */
function reeksen(a, o) {
  schema(a);
  o = o || {};
  const peil = geldigeDatum(o.peil) || vandaag();
  const rijen = a.db.prepare("SELECT ref, datum, dienst, ontvanger, bedrag, valuta, bedrag_eur, bron, nr FROM paypal_bewijs WHERE soort = 'betaling' AND dienst IS NOT NULL AND datum <= ? ORDER BY datum")
    .all(peil);
  const perDienst = new Map();
  rijen.forEach(function (r) { if (!perDienst.has(r.dienst)) perDienst.set(r.dienst, []); perDienst.get(r.dienst).push(r); });
  const uit = [];
  perDienst.forEach(function (l, dienst) {
    // clusters op bedrag (in de eigen valuta: een dollarabonnement schommelt in euro's)
    const cl = [];
    l.forEach(function (r) {
      const c = cl.find(function (x) { return x.valuta === r.valuta && Math.abs(r.bedrag - x.bedrag) <= 0.02 * x.bedrag + 0.005; });
      if (c) c.posten.push(r); else cl.push({ valuta: r.valuta, bedrag: r.bedrag, posten: [r] });
    });
    const kandidaat = cl.map(function (c) {
      const p = c.posten, eerste = p[0].datum, laatste = p[p.length - 1].datum;
      const maanden = new Map();
      p.forEach(function (r) { const m = r.datum.slice(0, 7); maanden.set(m, (maanden.get(m) || 0) + 1); });
      const span = (Number(laatste.slice(0, 4)) - Number(eerste.slice(0, 4))) * 12 + Number(laatste.slice(5, 7)) - Number(eerste.slice(5, 7)) + 1;
      let ritme = null, perMaand = null;
      // twee posten is nog geen abonnement (Fable wv765 #2)
      if (p.length >= 3 && span >= 3 && maanden.size >= 0.8 * span) { ritme = 'maand'; perMaand = Math.max(1, Math.round(mediaan(Array.from(maanden.values())))); }
      else if (p.length >= 2) {
        const gaten = []; for (let i = 1; i < p.length; i++) gaten.push(dagVerschil(p[i - 1].datum, p[i].datum));
        const mg = mediaan(gaten);
        if (mg >= 350 && mg <= 380) { ritme = 'jaar'; perMaand = 1 / 12; }
        else if (mg >= 80 && mg <= 100 && p.length >= 3) { ritme = 'kwartaal'; perMaand = 1 / 3; }   // twee posten drie maanden uit elkaar is nog geen ritme
      }
      return { c: c, eerste: eerste, laatste: laatste, ritme: ritme, perMaand: perMaand, aantal: p.length };
    }).filter(function (k) { return k.ritme; }).sort(function (p, q) { return p.eerste < q.eerste ? -1 : 1; });
    // prijsstappen samenvoegen
    const reeks = [];
    kandidaat.forEach(function (k) {
      const vorige = reeks.find(function (r) { return !r.opgevolgd && r.ritme === k.ritme && r.valuta === k.c.valuta && r.perMaand === k.perMaand &&
        dagVerschil(r.laatste, k.eerste) >= 0 && dagVerschil(r.laatste, k.eerste) <= 45 && Math.abs(k.c.bedrag - r.bedrag) <= 0.5 * r.bedrag; });
      if (vorige) {
        Object.assign(vorige, { bedrag_vorig: vorige.bedrag, gewijzigd_op: k.eerste, bedrag: k.c.bedrag, laatste: k.laatste, aantal: vorige.aantal + k.aantal,
          posten: vorige.posten.concat(k.c.posten) });
        return;
      }
      reeks.push({ dienst: dienst, ritme: k.ritme, perMaand: k.perMaand, valuta: k.c.valuta, bedrag: k.c.bedrag, bedrag_vorig: null, gewijzigd_op: null,
        eerste: k.eerste, laatste: k.laatste, aantal: k.aantal, posten: k.c.posten });
    });
    reeks.forEach(function (r) {
      const p = r.posten, laatstePost = p[p.length - 1];
      const termijn = r.ritme === 'maand' ? 31 : r.ritme === 'kwartaal' ? 92 : 366;
      const actief = dagVerschil(r.laatste, peil) <= Math.round(termijn * 1.5);
      const eur = p.filter(function (x) { return x.bedrag_eur != null; });
      const bedragEur = eur.length ? eur[eur.length - 1].bedrag_eur : null;
      const bronnen = Array.from(new Set(p.slice(-3).map(function (x) { return x.bron; })));
      const signalen = [];
      // nieuw: een reeks bestaat pas vanaf drie posten, dus 'nieuw' tot ± drie termijnen na de eerste post
      if (actief && dagVerschil(r.eerste, peil) <= Math.round(termijn * 3.3)) signalen.push('nieuw');
      if (actief && r.bedrag_vorig != null && r.bedrag > r.bedrag_vorig && dagVerschil(r.gewijzigd_op, peil) <= 92) signalen.push('duurder');
      if (actief && r.bedrag_vorig != null && r.bedrag < r.bedrag_vorig && dagVerschil(r.gewijzigd_op, peil) <= 92) signalen.push('goedkoper');
      if (!actief && dagVerschil(r.laatste, peil) <= Math.round(termijn * 1.5) + 92) signalen.push('weg');
      uit.push({ dienst: r.dienst, naam: laatstePost.ontvanger, ritme: r.ritme, per_maand_aantal: r.ritme === 'maand' ? r.perMaand : undefined,
        bedrag: r.bedrag, valuta: r.valuta !== 'EUR' ? r.valuta : undefined, bedrag_eur: r.valuta !== 'EUR' ? bedragEur : undefined,
        per_maand: r2((r.valuta === 'EUR' ? r.bedrag : (bedragEur || 0)) * r.perMaand), bedrag_vorig: r.bedrag_vorig != null ? r.bedrag_vorig : undefined,
        gewijzigd_op: r.gewijzigd_op || undefined, sinds: r.eerste, laatst: r.laatste, aantal: r.aantal, actief: actief,
        betaald_via: bronnen.length === 1 ? { bank: 'bankrekening', kaart: 'creditcard', saldo: 'PayPal-saldo', onbekend: 'onbekend' }[bronnen[0]] : 'wisselend',
        gekoppeld: p.filter(function (x) { return x.nr != null; }).length, signalen: signalen.length ? signalen : undefined });
    });
  });
  return uit.sort(function (p, q) { return (q.actief - p.actief) || q.per_maand - p.per_maand; });
}

// ── leesopdrachten ──
function bewijsUit(r, posten) {
  const t = r.nr != null ? posten.get(r.nr) : null;
  return { datum: r.datum, soort: r.soort === 'terugbetaling' ? 'terugbetaling' : undefined, ontvanger: r.ontvanger, dienst: r.dienst,
    bedrag: r.bedrag, valuta: r.valuta !== 'EUR' ? r.valuta : undefined, bedrag_eur: r.valuta !== 'EUR' ? r.bedrag_eur : undefined,
    betaald_via: { bank: 'bankrekening' + (r.bron_eind ? ' …' + r.bron_eind : ''), kaart: 'creditcard', saldo: 'PayPal-saldo', onbekend: 'onbekend' }[r.bron],
    status: r.status && r.status !== 'voltooid' ? r.status : undefined,
    bank: t ? { nr: t.nr, datum: t.datum, bedrag: t.bedrag, samen_met_andere: r.koppel_soort === 'som' ? true : undefined } :
      (r.bron === 'kaart' || r.bron === 'saldo' ? 'niet op de bank (' + (r.bron === 'kaart' ? 'creditcard' : 'PayPal-saldo') + ')' : 'nog niet gevonden') };
}
function lijst(a, o) {
  schema(a);
  o = o || {};
  const w = ['1 = 1'], p = [];
  if (geldigeDatum(o.van)) { w.push('datum >= ?'); p.push(o.van); }
  if (geldigeDatum(o.tot)) { w.push('datum <= ?'); p.push(o.tot); }
  const max = Math.min(Math.max(parseInt(o.max, 10) || 100, 1), 1000);
  let rijen = a.db.prepare('SELECT * FROM paypal_bewijs WHERE ' + w.join(' AND ') + ' ORDER BY datum DESC, ref').all(...p);
  const tekst = o.dienst ? String(o.dienst).toLowerCase().slice(0, 40) : '';
  if (tekst) rijen = rijen.filter(function (r) { return String(r.ontvanger).toLowerCase().indexOf(tekst) >= 0 || String(r.dienst).indexOf(tekst) >= 0; });
  const nrs = rijen.map(function (r) { return r.nr; }).filter(function (n) { return n != null; });
  const posten = new Map();
  if (nrs.length) a.db.prepare('SELECT nr, datum, bedrag FROM transacties WHERE nr IN (' + nrs.map(function () { return '?'; }).join(',') + ')').all(...nrs)
    .forEach(function (t) { posten.set(t.nr, t); });
  const som = function (l) { return r2(l.reduce(function (s, r) { return s + (r.bedrag_eur || 0); }, 0)); };
  const bet = rijen.filter(function (r) { return r.soort === 'betaling'; }), terug = rijen.filter(function (r) { return r.soort === 'terugbetaling'; });
  // bankposten zonder bewijs in dezelfde periode
  const bw = ["status IN ('booked', 'pending')", "lower(tegenpartij) LIKE '%paypal%'", 'nr NOT IN (SELECT nr FROM paypal_bewijs WHERE nr IS NOT NULL)',
    "rek NOT IN (SELECT rek FROM rekeningen WHERE lower(eigenaar) IN ('extern', 'pot'))"], bp = [];   // extern (wv709) en POT (wv786) niet
  if (geldigeDatum(o.van)) { bw.push('datum >= ?'); bp.push(o.van); }
  if (geldigeDatum(o.tot)) { bw.push('datum <= ?'); bp.push(o.tot); }
  const zonder = a.db.prepare('SELECT nr, datum, bedrag FROM transacties WHERE ' + bw.join(' AND ') + ' ORDER BY datum DESC').all(...bp);
  return { aantal: rijen.length, getoond: Math.min(rijen.length, max), betalingen: bet.length, betaald_eur: som(bet), terugbetalingen: terug.length || undefined,
    terugbetaald_eur: terug.length ? som(terug) : undefined, gekoppeld: rijen.filter(function (r) { return r.nr != null; }).length,
    niet_op_de_bank: rijen.filter(function (r) { return r.bron === 'kaart' || r.bron === 'saldo'; }).length,
    nog_niet_gevonden: rijen.filter(function (r) { return r.nr == null && r.bron !== 'kaart' && r.bron !== 'saldo'; }).length,
    bankposten_zonder_bewijs: { aantal: zonder.length, posten: zonder.slice(0, 20) },
    let_op: 'uit de PayPal-ontvangstbewijzen in Davids Gmail (d.schaap@gmail.com), sinds 22-10-2026 ook de autorisatie- en overmakingsberichten (status geautoriseerd = PayPal meldde alleen de autorisatie); betalingen via de creditcard of het PayPal-saldo staan niet op de bank',
    bewijzen: rijen.slice(0, max).map(function (r) { return bewijsUit(r, posten); }) };
}
function diensten(a, o) {
  const l = reeksen(a, o);
  const actief = l.filter(function (r) { return r.actief; });
  return { aantal: l.length, actief: actief.length, per_maand_totaal: r2(actief.reduce(function (s, r) { return s + r.per_maand; }, 0)),
    per_maand_bank: r2(actief.filter(function (r) { return r.betaald_via === 'bankrekening'; }).reduce(function (s, r) { return s + r.per_maand; }, 0)),
    let_op: 'vaste PayPal-diensten herkend aan ritme en bedrag in de ontvangstbewijzen; signalen: nieuw (eerste drie termijnen), duurder/goedkoper (prijsstap ≤ 3 maanden), weg (uitgebleven)',
    diensten: l };
}
function stand(a) {
  schema(a);
  const db = a.db, tel = function (q) { return db.prepare(q).all().reduce(function (o, r) { o[r.k == null ? 'leeg' : r.k] = r.n; return o; }, {}); };
  let ng = []; try { ng = JSON.parse(metaLees(a, 'paypal_niet_gelezen') || '[]'); } catch (e) { ng = []; }
  return { bewijzen: db.prepare('SELECT count(*) n FROM paypal_bewijs').get().n, per_soort: tel('SELECT soort k, count(*) n FROM paypal_bewijs GROUP BY soort'),
    per_bron: tel('SELECT bron k, count(*) n FROM paypal_bewijs GROUP BY bron'), per_koppeling: tel('SELECT koppel_soort k, count(*) n FROM paypal_bewijs GROUP BY koppel_soort'),
    vanaf: (db.prepare('SELECT min(datum) m FROM paypal_bewijs').get() || {}).m || null, tot: (db.prepare('SELECT max(datum) m FROM paypal_bewijs').get() || {}).m || null,
    niet_gelezen: ng.length, bij_op: metaLees(a, 'paypal_bij_op'), koppel_op: metaLees(a, 'paypal_koppel_op'), ronde_op: metaLees(a, 'paypal_ronde_op') };
}

module.exports = { leesMail, soortVanOnderwerp, dienstSleutel, datumUit, schema, bij, bekend, koppel, dienstPerPost, reeksen, lijst, diensten, stand, VENSTER_DAGEN, metaZet };
