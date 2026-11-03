'use strict';
/*
 * facturen-boekstuk.js — het maandelijkse interne boekstuk voor Google Home Premium Advanced van Tolgaarde (wv2316, David 3-11-2026 15:51:
 * "Beter nog: Die mag maandelijks direct naar mijn vader verzonden"; Ja met verse vingerafdruk 16:22 op het ontwerp, grondwet 1 aanvulling
 * 3-11-2026). Google Play levert voor dit abonnement (€ 7,99 per maand, PayPal vanaf de ABN-rekening van Tolgaarde) geen factuur; André
 * (boekhouder) krijgt elke maand dit boekstuk. Ontwerp: vault 01_Ontwikkeling/Boekstuk Google Home - maandelijks zelf naar André
 * (ontwerp 3-11-2026).md.
 *
 * Puur: geen taalmodel, geen netwerk, geen klok (de beller geeft de tijd mee), alleen crypto en de PDF-bouwstenen van
 * facturen-specificatie.js. Twee leesfuncties met vaste regels (Google Play-bevestiging, PayPal-bewijs NL/EN), de voorcontrole, de PDF, de
 * vaste mailtekst, de eenmalige vrijgavekaart en de ronde; alle I/O (lees-luik, eigen staat in facturen.sqlite, verzender, mailluik,
 * app-bericht) krijgt de ronde van server.js mee (io).
 *
 * De grens tegen dubbel versturen is de reservering 'verzenden' in boekstuk_verzending (vastgelegd vóór de aanroep, één rij per
 * abonnement en termijn; een rij die eenmaal bestaat gaat nooit terug naar "nog niets"). Geen antwoord van de verzender = 'onzeker':
 * nooit opnieuw, na 24 uur terugzoeken in Verzonden, anders één regel aan David. Alles wat niet automatisch kan (geen vrijgave, andere
 * prijs of product, reeks klopt niet, na 12:00, schakelaar op concept) wordt een Gmail-concept aan André met één regel in de app.
 */
const crypto = require('crypto');
const SP = require('./facturen-specificatie.js');
const { breedte, pas, hex, getal, kleur, schoon, isoDag, pdfBestand } = SP.pdf;
const { eur, datumNl } = SP;

// Het abonnement zoals David het vrijgaf. Een andere waarde (prijs, product, reeks, rekening) = geen automatische verzending.
const ABO = {
  sleutel: 'google-home',
  naam: 'Google Home Premium Advanced',
  product: 'Google Home Premium Advanced Add On (Google One)',
  door: 'Google LLC',
  leverancier: 'Google Commerce Limited',
  leverancier_adres: 'Gordon House, Barrow Street, Dublin 4, Ierland',
  play_van: 'googleplay-noreply@google.com',
  paypal_van: ['service@paypal.nl', 'service@paypal.com'],
  paypal_aan: 'Google Payment Irel',          // PayPal kapt de naam af: "Google Payment Irela..."
  // sha256 van de bestelreeks (zonder het volgnummer); de reeks zelf staat niet in de (openbare) code (review wv2316 MOET 1)
  reeks_sha256: '71c270b56d1ad3d6a991ecf922e15aa47df55bb13a0d4e9161a7c9adc3e080b7',
  anker: { termijn: '2026-11', n: 6 },        // gemeten 3-11-2026: oktober ..5, november ..6
  totaal_centen: 799, btw_centen: 139,
  // de rekening waarvan PayPal afschrijft moet een rekening van Tolgaarde in Facturen zijn (io.rekeningen; laatste 4 cijfers, niet in de code)
  entiteit: 'tolgaarde', entiteit_naam: 'Huisartsenpraktijk Tolgaarde B.V.',
};
const VANAF_DAG = 3, GEEN_MAIL_DAG = 6, VAN_UUR = 9, TOT_UUR = 12, ONZEKER_UUR = 24, VERZENDEN_MIN = 15;
const STATUSSEN = ['verzenden', 'verstuurd', 'onzeker', 'onzeker_gemeld', 'concept_bezig', 'concept', 'concept_mislukt', 'concept_onzeker', 'door_david', 'niet_gemaakt'];
const BEVESTIGING = 'knop-ja-vers-kaart';     // server.js appKnopBevestiging: Ja met verse vingerafdruk, telefoon of meereizend, op een kaart
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const MND_NL = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
const MND_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TERMIJN_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const p2 = (n) => String(n).padStart(2, '0');
function maandNaam(t) { const m = TERMIJN_RE.exec(String(t || '')); return m ? MAANDEN[Number(m[2]) - 1] + ' ' + m[1] : String(t || ''); }
function maandVerschil(a, b) { return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)); }
function verwachtN(termijn) { return ABO.anker.n + maandVerschil(ABO.anker.termijn, termijn); }
function centen(s) { const m = /^(\d{1,5}),(\d\d)$/.exec(String(s || '')); return m ? Number(m[1]) * 100 + Number(m[2]) : null; }
function adresVan(van) { const s = String(van || ''); const m = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s); return (m ? m[1] : s.trim()).toLowerCase(); }
function regels(t) { return String(t || '').slice(0, 30000).replace(/\r\n?/g, '\n').split('\n').map((s) => s.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim()); }
const ymdPlus = (ymd, d) => new Date(Date.parse(ymd + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
const dagVerschil = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const gmailDag = (ymd) => ymd.replace(/-/g, '/');

// Tijd in Amsterdam van een tijdstip in ms (de beller levert de klok).
function amsterdam(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, uur: Number(p.hour), min: Number(p.minute) };
}
// Zelfde feestdagen als pot-verzend.js en de verzender (ook Goede Vrijdag en 5 mei: dan gaat er niets automatisch de deur uit).
function pasen(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return `${j}-${p2(Math.floor((h + l - 7 * m + 114) / 31))}-${p2(((h + l - 7 * m + 114) % 31) + 1)}`;
}
function feestdag(ymd) {
  const j = Number(ymd.slice(0, 4)), md = ymd.slice(5), p = pasen(j);
  const kd = new Date(Date.UTC(j, 3, 27)).getUTCDay() === 0 ? '04-26' : '04-27';
  return ['01-01', kd, '05-05', '12-25', '12-26'].includes(md) || [-2, 0, 1, 39, 49, 50].some((x) => ymdPlus(p, x) === ymd);
}
const werkdag = (ymd) => { const w = new Date(ymd + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !feestdag(ymd); };

// ── lezen (vaste regels, begrensd) ───────────────────────────────────────────────────────────────────────────────────────────────
/*
 * Google Play-bevestiging (gemeten 3-11-2026, mail_lezen van het lees-luik, platte tekst):
 *   Bestelnummer: SOP.<reeks>..6 / Besteldatum: 2 nov 2026 20:05:42 CET / <product> (door <maker>) € 7,99 per maand /
 *   Totaal: € 7,99 per maand / (Inclusief € 1,39 Btw) / Betaalmethode: / PayPal: <adres>
 * → { id, mail_datum, bestelnummer, n, reeks, dag, tijd, zone, product, door, prijs_centen, per_maand, totaal_centen, btw_centen, betaal } of { fout }
 */
function leesPlay(m) {
  if (!m || typeof m !== 'object') return { fout: 'geen mail' };
  if (adresVan(m.van) !== ABO.play_van) return { fout: 'afzender is niet Google Play' };
  if (!/^De bevestiging van je Google Play-bestelling\b/.test(String(m.onderwerp || ''))) return { fout: 'onderwerp is geen Google Play-bevestiging' };
  const r = regels(m.tekst);
  const een = (re) => { const t = r.map((x) => re.exec(x)).filter(Boolean); return t.length === 1 ? t[0] : null; };
  const bn = een(/^Bestelnummer: ((SOP\.\d{4}-\d{4}-\d{4}-\d{5}\.\.)(\d{1,4}))$/);
  if (!bn) return { fout: 'bestelnummer niet te lezen' };
  const bd = een(/^Besteldatum: (\d{1,2}) ([a-z]{3})\.? (\d{4}) (\d\d:\d\d:\d\d) (CET|CEST)$/);
  if (!bd || !MND_NL[bd[2]]) return { fout: 'besteldatum niet te lezen' };
  const dag = `${bd[3]}-${p2(MND_NL[bd[2]])}-${p2(Number(bd[1]))}`;
  if (!isoDag(dag) || isNaN(Date.parse(dag + 'T12:00:00Z'))) return { fout: 'besteldatum ongeldig' };
  const items = r.map((x) => /^(.{3,200}) \(door ([^()]{2,80})\) € (\d{1,5},\d\d)( per maand)?$/.exec(x)).filter(Boolean);
  if (items.length !== 1) return { fout: items.length ? 'meer dan één item op de bestelling' : 'item niet te lezen' };
  const tot = een(/^Totaal: € (\d{1,5},\d\d)( per maand)?$/), btw = een(/^\(Inclusief € (\d{1,5},\d\d) Btw\)$/);
  if (!tot || !btw) return { fout: 'totaal of btw niet te lezen' };
  const bi = r.indexOf('Betaalmethode:');
  const betaal = bi >= 0 && /^PayPal: \S+@\S+$/.test(r[bi + 1] || '') ? 'paypal' : 'anders';
  return { id: String(m.id || ''), mail_datum: String(m.datum || ''), bestelnummer: bn[1], reeks: bn[2], n: Number(bn[3]), dag, tijd: bd[4], zone: bd[5],
    product: items[0][1], door: items[0][2], prijs_centen: centen(items[0][3]), per_maand: !!items[0][4] && !!tot[2], totaal_centen: centen(tot[1]), btw_centen: centen(btw[1]), betaal };
}
/*
 * PayPal-bewijs (gemeten 3-11-2026; Engels voor Google, Nederlands voor andere winkels):
 *   EN: "You paid € 7,99 EUR to Google Payment Irela..." / "Transaction ID" ⏎ "<17 tekens> Transaction date" ⏎ "2 Nov 2026 Merchant" /
 *       "Invoice ID" ⏎ "<nummer>" / "Checking ••<laatste 4>"
 *   NL: "U hebt € 3,99 EUR betaald aan …" / "Transactiereferentie" ⏎ "<17> Transactiedatum" ⏎ "2 nov 2026 Webwinkel" / "Factuurreferentie" ⏎ … /
 *       "Betaalrekening ••3868"
 * → { id, mail_datum, bedrag_centen, aan, transactie_id, invoice_id, dag, rekening_eind } of { fout }
 */
function leesPaypal(m) {
  if (!m || typeof m !== 'object') return { fout: 'geen mail' };
  if (!ABO.paypal_van.includes(adresVan(m.van))) return { fout: 'afzender is niet PayPal' };
  const r = regels(m.tekst).filter((x) => x && !/^\[?https?:\/\//.test(x));
  const een = (re) => { const t = r.map((x) => re.exec(x)).filter(Boolean); return t.length === 1 ? t[0] : null; };
  const bet = een(/^(?:You paid|U hebt) € (\d{1,5},\d\d) EUR (?:to|betaald aan) (.{3,80})$/);
  if (!bet) return { fout: 'bedrag niet te lezen' };
  const na = (kop, re) => { const i = r.indexOf(kop); return i >= 0 ? re.exec(r[i + 1] || '') : null; };
  const tx = na('Transaction ID', /^([0-9A-Z]{17})(?: Transaction date)?$/) || na('Transactiereferentie', /^([0-9A-Z]{17})(?: Transactiedatum)?$/);
  const dt = (() => {
    const i = r.findIndex((x) => /(?:^| )(?:Transaction date|Transactiedatum)$/.test(x));
    const d = i >= 0 ? /^(\d{1,2}) ([A-Za-z]{3})[a-z]*\.? (\d{4})\b/.exec(r[i + 1] || '') : null;
    if (!d) return null;
    const mn = MND_EN[d[2].toLowerCase()] || MND_NL[d[2].toLowerCase()];
    return mn ? `${d[3]}-${p2(mn)}-${p2(Number(d[1]))}` : null;
  })();
  const inv = (() => { const i = r.findIndex((x) => /(?:^| )(?:Invoice ID|Factuurreferentie)$/.test(x)); const v = i >= 0 ? /^([0-9A-Za-z-]{6,40})$/.exec(r[i + 1] || '') : null; return v ? v[1] : null; })();
  const rek = [...new Set(r.map((x) => /••(\d{4})\b/.exec(x)).filter(Boolean).map((x) => x[1]))];
  if (!tx || !dt) return { fout: 'transactie of datum niet te lezen' };
  return { id: String(m.id || ''), mail_datum: String(m.datum || ''), bedrag_centen: centen(bet[1]), aan: bet[2].replace(/\.{3}$/, ''), transactie_id: tx[1], invoice_id: inv,
    dag: dt, rekening_eind: rek.length === 1 ? rek[0] : null };
}

// ── voorcontrole ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const reeksOk = (p) => !!p && sha(p.reeks) === ABO.reeks_sha256;
// x = { termijn, play, paypal, eerder_n: [N die al verstuurd of gereserveerd zijn], rekeningen: [laatste 4 cijfers van de Tolgaarde-rekeningen] }
// → { ok, redenen: [gewone taal], verwacht_n }
function controle(x) {
  const red = [], p = x.play, q = x.paypal, n = verwachtN(x.termijn);
  if (!p) red.push('de Google Play-bevestiging ontbreekt');
  else {
    if (p.product !== ABO.product || p.door !== ABO.door) red.push('ander product op de bestelling: ' + schoon(p.product, 80));
    if (p.prijs_centen !== ABO.totaal_centen || p.totaal_centen !== ABO.totaal_centen || p.btw_centen !== ABO.btw_centen)
      red.push('andere prijs: ' + eur(p.totaal_centen || 0) + ' (btw ' + eur(p.btw_centen || 0) + ') in plaats van ' + eur(ABO.totaal_centen) + ' (btw ' + eur(ABO.btw_centen) + ')');
    if (!p.per_maand) red.push('geen maandabonnement');
    if (p.betaal !== 'paypal') red.push('niet met PayPal betaald');
    if (!reeksOk(p)) red.push('bestelnummer hoort niet bij het abonnement');
    else if (p.n !== n) red.push('bestelnummer ..' + p.n + ', verwacht ..' + n);
    if ((x.eerder_n || []).includes(p.n)) red.push('bestelnummer ..' + p.n + ' ging al eerder');
    if (p.dag.slice(0, 7) !== x.termijn) red.push('de bestelling is niet van ' + maandNaam(x.termijn));
  }
  if (!q) red.push('het PayPal-bewijs ontbreekt');
  else {
    if (q.bedrag_centen !== ABO.totaal_centen) red.push('PayPal-bedrag ' + eur(q.bedrag_centen || 0) + ' in plaats van ' + eur(ABO.totaal_centen));
    if (String(q.aan).indexOf(ABO.paypal_aan) !== 0) red.push('PayPal-betaling niet aan Google Payment Ireland');
    if (!q.rekening_eind || !(x.rekeningen || []).includes(q.rekening_eind)) red.push('betaald van een andere rekening' + (q.rekening_eind ? ' (…' + q.rekening_eind + ')' : '') + ' dan die van Tolgaarde');
    if (p && Math.abs(dagVerschil(p.dag, q.dag)) > 1) red.push('PayPal-datum ligt meer dan een dag van de besteldatum');
  }
  return { ok: red.length === 0, redenen: red, verwacht_n: n };
}

// ── het boekstuk ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function gegevens(termijn, play, paypal) {
  return { termijn, maand_naam: maandNaam(termijn), play, paypal, excl_centen: play.totaal_centen - play.btw_centen,
    entiteit_naam: ABO.entiteit_naam, leverancier: ABO.leverancier, leverancier_adres: ABO.leverancier_adres };
}
function bestandsnaam(g) { return 'Boekstuk-Google-Home-' + g.termijn + '.pdf'; }
// wijze 'auto' = de pod verstuurt (vaste tekst uit het ontwerp § 1); 'concept' = David verstuurt zelf
function mail(g, o) {
  const auto = !o || o.wijze !== 'concept';
  const onderwerp = 'Boekstuk ' + ABO.naam + ' ' + g.maand_naam + ' — Tolgaarde';
  const r = ['Beste pa,', '', 'Hierbij het boekstuk voor ' + ABO.naam + ' van ' + g.maand_naam + ' (' + eur(g.play.totaal_centen) + ', Tolgaarde). Google levert hiervoor geen factuur.', ''];
  if (auto) r.push('Dit bericht is automatisch verstuurd namens David.');
  else r.push('Groet,', 'David');
  return { onderwerp, bericht: r.join('\n') };
}
/*
 * maakPdf(g, o) → Buffer. o = { gemaakt: ISO (UTC), gemaakt_dag: Amsterdamse datum, wijze: 'auto' | 'concept', vrijgegeven_dag, proef }.
 * Zelfde opbouw als het boekstuk van oktober (Socev, 3-11): kop, kerngegevens, bedragen, betaling, de letterlijke kerngegevens uit beide
 * mails, verantwoording. Eén pagina.
 */
function maakPdf(g, o) {
  o = o || {};
  const W = 595.28, H = 841.89, M = 56, BREED = W - 2 * M;
  const kTitel = kleur(null, [0.17, 0.17, 0.17]), kCaps = kleur(null, [0.36, 0.4, 0.44]), kLijn = kleur(null, [0.6, 0.65, 0.68]);
  const o2 = [];
  let y = H - M;
  const txt = (f, pt, x, yy, s, rechts, k) => {
    const w = rechts ? breedte(f, pt, s) : 0;
    o2.push((k ? k + ' rg ' : '') + 'BT /' + f + ' ' + getal(pt) + ' Tf ' + getal(x - w) + ' ' + getal(yy) + ' Td ' + hex(s) + ' Tj ET' + (k ? ' 0 g' : ''));
  };
  const lijn = (yy, k, dik) => o2.push(k + ' RG ' + getal(dik || 0.5) + ' w ' + getal(M) + ' ' + getal(yy) + ' m ' + getal(W - M) + ' ' + getal(yy) + ' l S 0 G');
  const p = g.play, q = g.paypal;
  // regels afbreken op woorden binnen de breedte (de verantwoording en de bronregels zijn langer dan één regel)
  const afbreken = (f, pt, s, max) => {
    const uit = []; let r = '';
    for (const w of String(s).split(' ')) { const t = r ? r + ' ' + w : w; if (r && breedte(f, pt, t) > max) { uit.push(r); r = w; } else r = t; }
    if (r) uit.push(r);
    return uit.map((x) => pas(f, pt, x, max));
  };
  txt('F2', 15, M, y - 14, pas('F2', 15, g.entiteit_naam, BREED), false, kTitel); y -= 22;
  lijn(y, kTitel, 1.2); y -= 26;
  txt('F2', 13, M, y, 'Aankoopverantwoording — intern boekstuk'); y -= 16;
  txt('F1', 9, M, y, pas('F1', 9, 'Google levert voor dit abonnement geen factuur; dit boekstuk legt de aankoop vast voor de administratie.', BREED), false, kCaps); y -= 24;
  const kv = (rij) => { for (const [k, v] of rij) { txt('F1', 9.5, M, y, k); txt('F2', 9.5, M + 150, y, pas('F2', 9.5, v, BREED - 150)); y -= 14; } y -= 8; };
  const kop = (t) => { txt('F2', 10.5, M, y, t, false, kTitel); y -= 5; lijn(y, kLijn, 0.5); y -= 15; };
  kop('Aankoop');
  kv([['Entiteit', g.entiteit_naam], ['Leverancier', g.leverancier + ', ' + g.leverancier_adres], ['Product', p.product], ['Periode', 'maandabonnement ' + g.maand_naam],
    ['Bestelnummer', p.bestelnummer], ['Besteldatum', datumNl(p.dag) + ' ' + p.tijd.slice(0, 5)]]);
  kop('Bedragen');
  kv([['Bedrag exclusief btw', eur(g.excl_centen)], ['Btw', eur(p.btw_centen)], ['Totaal', eur(p.totaal_centen)]]);
  kop('Betaling');
  kv([['Betaald via', 'PayPal, ' + datumNl(q.dag)], ['PayPal-transactie', q.transactie_id], ['PayPal invoice-ID', q.invoice_id || '(niet vermeld)'],
    ['Afgeschreven van', 'ABN AMRO …' + (q.rekening_eind || '')]]);
  kop('Bron (letterlijk uit de bevestigingen)');
  const bron = ['Google Play: Bestelnummer: ' + p.bestelnummer, 'Google Play: Besteldatum: ' + datumNl(p.dag) + ' ' + p.tijd + ' ' + p.zone,
    'Google Play: ' + p.product + ' (door ' + p.door + ') ' + eur(p.prijs_centen) + ' per maand', 'Google Play: Totaal ' + eur(p.totaal_centen) + ' (inclusief ' + eur(p.btw_centen) + ' btw), betaalmethode PayPal',
    'PayPal: betaald ' + eur(q.bedrag_centen) + ' EUR aan ' + (q.aan.indexOf(ABO.paypal_aan) === 0 ? 'Google Payment Ireland' : q.aan) + ', transactie ' + q.transactie_id + (q.invoice_id ? ', invoice ' + q.invoice_id : '') + ', ' + datumNl(q.dag)];
  for (const b of bron) for (const regel of afbreken('F1', 8.5, b, BREED)) { txt('F1', 8.5, M, y, regel); y -= 12; }
  y -= 16;
  kop('Verantwoording');
  const akkoord = o.proef ? 'PROEF — dit is een voorbeeld; het echte boekstuk gaat naar de boekhouder.'
    : o.wijze === 'concept' ? 'Opgemaakt door Socev voor D. Schaap, directeur; verzonden door D. Schaap.'
      : 'Opgemaakt en verzonden door Socev in opdracht van D. Schaap, directeur (staande opdracht 3-11-2026' + (isoDag(o.vrijgegeven_dag) ? ', vrijgegeven ' + datumNl(o.vrijgegeven_dag) : '') + ').';
  for (const regel of afbreken('F1', 9.5, akkoord, BREED)) { txt('F1', 9.5, M, y, regel); y -= 14; }
  lijn(M + 20, kLijn, 0.4);
  txt('F1', 6.5, M, M + 8, pas('F1', 6.5, 'Gemaakt door Socev op ' + datumNl(isoDag(o.gemaakt_dag) ? o.gemaakt_dag : '') + ' uit de Google Play-bevestiging en het PayPal-bewijs.', BREED), false, kCaps);
  return pdfBestand([o2], { titel: 'Boekstuk Google Home Premium Advanced ' + g.termijn, gemaakt: o.gemaakt, W, H });
}
function maak(g, o) {
  const pdf = maakPdf(g, o);
  return { pdf, sha256: crypto.createHash('sha256').update(pdf).digest('hex'), naam: bestandsnaam(g), mail: mail(g, o) };
}

// ── vrijgave (eenmalig, Ja met verse vingerafdruk; knoproute in server.js zoals pot-verzend) ───────────────────────────────────────
// Het abonnement zoals vrijgegeven: verandert prijs, product, reeks, rekening of adres, dan telt de vrijgave niet meer.
function aboHash(aan) { return sha(JSON.stringify([ABO.sleutel, ABO.product, ABO.door, ABO.totaal_centen, ABO.btw_centen, ABO.reeks_sha256, String(aan || '').toLowerCase()])); }
const kaartHash = (p) => sha(JSON.stringify([String(p && p.titel || ''), String(p && p.waarom || ''), (p && Array.isArray(p.stappen) ? p.stappen : []).map(String)]));
const kap = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n - 1) + '…'; };
// x = { id, aan, voorbeeld: 'proef' | 'gmail' }
function kaartVrijgave(x) {
  const m = mail({ maand_naam: '<maand>', play: { totaal_centen: ABO.totaal_centen } });
  return { sleutel: 'boekstuk-vrijgave-' + x.id, soort: 'besluit', volgorde: 22, waar: 'overal', prive: true, duur_min: 2,
    titel: 'Google Home-boekstuk — elke maand zelf naar je vader versturen?',
    herkomst: { handmatig: 'facturen-boekstuk', soort: 'vrijgave', vrijgave_id: x.id, doel: { scherm: 'facturen' } },
    waarom: kap('Je vroeg op 3-11 of het maandelijkse boekstuk voor Google Home Premium Advanced (' + eur(ABO.totaal_centen) + ', Tolgaarde) direct naar je vader mag. Met Ja (vingerafdruk op je telefoon) stuurt de pod het vanaf de 3e van elke maand op een werkdag tussen 09:00 en 12:00 zelf, als één mail met de PDF, alleen naar ' + x.aan + '. Nee of niets: elke maand een concept in Gmail, zoals nu.', 400),
    stappen: [
      x.voorbeeld === 'proef' ? 'Het voorbeeld (november) kreeg je net op je eigen testadres: zo ziet de mail aan je vader eruit.' : 'Het voorbeeld van november staat als concept in Gmail.',
      'Onderwerp: ' + m.onderwerp.replace('<maand>', '<maand jaar>'),
      'Tekst: ' + m.bericht.replace(/\n+/g, ' ').replace('<maand>', '<maand jaar>'),
      'Alleen als alles klopt: dit product, ' + eur(ABO.totaal_centen) + ' met ' + eur(ABO.btw_centen) + ' btw, het volgende bestelnummer, PayPal vanaf de ABN-rekening van Tolgaarde, nog niet verstuurd.',
      'Klopt iets niet (andere prijs, ander product, twijfel), dan wordt het een concept en hoor je waarom.',
      'Een Ja vanaf een vaste plek (praktijk-pc) telt niet.',
      'Stoppen kan altijd: zeg het Socev, dan wordt het weer een concept.'] };
}
// p = verse kaartrij, v = boekstuk_vrijgave-rij met kaart_sleutel = p.sleutel. → null (mag) of een reden in gewone taal.
function vrijgaveToets(p, v, aan) {
  if (!p || !/^boekstuk-vrijgave-\d{1,9}$/.test(String(p.sleutel || ''))) return 'geen vrijgavekaart';
  if (!v || 'boekstuk-vrijgave-' + v.id !== p.sleutel) return 'de vrijgave hoort niet bij deze kaart';
  if (!v.kaart_tekst_hash || kaartHash(p) !== v.kaart_tekst_hash) return 'de kaart is niet meer de kaart die de pod maakte';
  if (v.ingetrokken_op) return 'de vrijgave is ingetrokken';
  if (v.vraag_id) return 'het boekstuk is al vrijgegeven';
  if (!aan || v.abo_hash !== aboHash(aan)) return 'het abonnement of het adres van je vader veranderde sinds de kaart';
  return null;
}
// Geldt de vrijgave nu? v = de laatste niet-ingetrokken vrijgave met vraag_id.
function vrijgaveGeldig(v, aan) { return !!(v && v.vraag_id && v.bevestiging === BEVESTIGING && !v.ingetrokken_op && aan && v.abo_hash === aboHash(aan)); }

// ── de ronde ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/*
 * io = {
 *   zoek(query) → { mails: [{ id, datum, van, onderwerp }], melding }      lees-luik mail_zoeken (hooguit 25; melding = deels of niet gelukt)
 *   lees(id) → { id, datum, van, onderwerp, tekst } | { fout }               lees-luik mail_lezen
 *   staat: { lees(termijn) → rij | null, eerderN() → [n], reserveer(rij) → bool (INSERT; false = bestond al), zet(termijn, van, velden) → bool,
 *            vrijgave() → rij | null }
 *   aan() → adres van de boekhouder (afschriftadres Tolgaarde) | null
 *   verzenderOk() → bool (Toetsen-hash met bron boekstuk, actief)
 *   verstuur({ bron, modus, ref, aan, onderwerp, bericht, van, bijlage: { naam, bytes } }) → { status, j }; gooit met zekerNietVerstuurd vóór de aanroep
 *   concept({ aan, onderwerp, bericht, bijlage: { naam, mime, inhoud_base64 } }) → { concept_id }; gooit (e.zeker = zeker geen concept)
 *   bericht(tekst) → één regel in de app (hoofdkanaal)
 * }
 * o = { nu: ms, modus: 'auto' | 'concept', vanaf: 'JJJJ-MM', van: afzender }
 * → { termijn, stap, status?, reden?, fouten: [] }
 */
async function ronde(io, o) {
  const A = amsterdam(o.nu), termijn = A.ymd.slice(0, 7), dag = Number(A.ymd.slice(8, 10));
  const uit = { termijn, stap: 'niets', fouten: [] };
  if (o.vanaf && termijn < o.vanaf) return uit;
  const iso = new Date(o.nu).toISOString();
  let st = io.staat.lees(termijn);

  // 1. onzeker of blijven hangen: nooit opnieuw versturen; na 24 uur terugzoeken in Verzonden
  if (st && (st.status === 'verzenden' || st.status === 'concept_bezig') && o.nu - Date.parse(st.bijgewerkt_op) > VERZENDEN_MIN * 60e3) {
    const wasConcept = st.status === 'concept_bezig';
    if (io.staat.zet(termijn, st.status, { status: wasConcept ? 'concept_onzeker' : 'onzeker', reden: 'geen uitkomst vastgelegd (pod herstart tijdens het ' + (wasConcept ? 'klaarzetten' : 'versturen') + '?)' }) && wasConcept) {
      // review wv2316 MOET 2: niet stil; het concept kan er wel of niet staan, David kijkt
      await io.bericht('Boekstuk Google Home ' + maandNaam(termijn) + ': het klaarzetten van het concept voor je vader werd onderbroken. Kijk bij Concepten in Gmail of het er staat; zo niet, vraag Socev het opnieuw te maken.').catch(() => uit.fouten.push('bericht'));
      uit.stap = 'concept_onzeker'; return uit;
    }
    st = io.staat.lees(termijn);
  }
  if (st && st.status === 'onzeker' && o.nu - Date.parse(st.bijgewerkt_op) > ONZEKER_UUR * 3600e3) {
    const v = await zoekVerzonden(io, termijn, st.aangemaakt_op.slice(0, 10), st.aan);
    if (v.fout) { uit.fouten.push('luik'); return uit; }
    if (v.gevonden) { io.staat.zet(termijn, 'onzeker', { status: 'verstuurd', reden: 'teruggevonden in Verzonden' }); uit.stap = 'onzeker_gevonden'; return uit; }
    if (io.staat.zet(termijn, 'onzeker', { status: 'onzeker_gemeld' })) {
      await io.bericht('Het boekstuk Google Home van ' + maandNaam(termijn) + ' voor je vader: de verzender gaf geen bevestiging en ik vind het niet in Verzonden. Stuur het even zelf (het concept-PDF kan ik opnieuw maken als je dat vraagt).').catch(() => uit.fouten.push('bericht'));
    }
    uit.stap = 'onzeker_gemeld'; return uit;
  }
  if (st) { uit.stap = 'al'; uit.status = st.status; return uit; }

  // 2. alleen vanaf de 3e, op een werkdag, vanaf 09:00 (concept én versturen; een ronde buiten het venster doet niets)
  if (dag < VANAF_DAG || !werkdag(A.ymd) || A.uur < VAN_UUR) return uit;
  const na12 = A.uur >= TOT_UUR;

  // 3. de mails van deze maand
  const vanafDag = termijn + '-01';
  const zp = await io.zoek(`from:${ABO.play_van} subject:"Google Play-bestelling" after:${gmailDag(ymdPlus(vanafDag, -1))}`);
  if (!zp || zp.melding || !Array.isArray(zp.mails)) { uit.fouten.push('luik'); return uit; }
  const plays = [];
  for (const k of zp.mails.slice(0, 8)) {
    const m = await io.lees(k.id);
    if (!m || m.fout) { uit.fouten.push('luik'); return uit; }
    const p = leesPlay(m);
    if (!p.fout && (reeksOk(p) || p.product === ABO.product) && p.dag.slice(0, 7) === termijn) plays.push(p);
  }
  if (plays.length > 1) return await terugval(io, o, uit, termijn, null, null, ['er zijn deze maand ' + plays.length + ' Google Play-bevestigingen voor Google Home'], iso);
  const play = plays[0] || null;
  if (!play) {
    if (dag < GEEN_MAIL_DAG) { uit.stap = 'wacht'; uit.reden = 'Google Play-bevestiging nog niet binnen'; return uit; }
    if (io.staat.reserveer({ termijn, status: 'niet_gemaakt', reden: 'geen Google Play-bevestiging', aangemaakt_op: iso, bijgewerkt_op: iso })) {
      await io.bericht('Boekstuk Google Home ' + maandNaam(termijn) + ': de bevestiging van Google Play is er niet (of in een andere vorm). Ik maak het niet; loopt het abonnement nog?').catch(() => uit.fouten.push('bericht'));
    }
    uit.stap = 'niet_gemaakt'; return uit;
  }
  const zq = await io.zoek(`{from:service@paypal.nl from:service@paypal.com} "Google Payment" after:${gmailDag(ymdPlus(play.dag, -1))} before:${gmailDag(ymdPlus(play.dag, 3))}`);
  if (!zq || zq.melding || !Array.isArray(zq.mails)) { uit.fouten.push('luik'); return uit; }
  let pps = [];
  for (const k of zq.mails.slice(0, 8)) {
    const m = await io.lees(k.id);
    if (!m || m.fout) { uit.fouten.push('luik'); return uit; }
    const q = leesPaypal(m);
    if (!q.fout && String(q.aan).indexOf(ABO.paypal_aan) === 0 && Math.abs(dagVerschil(play.dag, q.dag)) <= 1) pps.push(q);
  }
  // meer dan één: de PayPal-mail die binnen 15 minuten na de Google-mail kwam (gemeten: 6 s)
  if (pps.length > 1) pps = pps.filter((q) => Math.abs(Date.parse(q.mail_datum) - Date.parse(play.mail_datum)) <= 15 * 60e3);
  const paypal = pps.length === 1 ? pps[0] : null;
  if (!paypal && pps.length === 0 && dag < GEEN_MAIL_DAG) { uit.stap = 'wacht'; uit.reden = 'PayPal-bewijs nog niet binnen'; return uit; }
  if (!paypal) {
    if (io.staat.reserveer({ termijn, status: 'niet_gemaakt', n: null, reden: pps.length ? 'meer dan één PayPal-betaling aan Google' : 'geen PayPal-bewijs', play_id: play.id, aangemaakt_op: iso, bijgewerkt_op: iso })) {
      await io.bericht('Boekstuk Google Home ' + maandNaam(termijn) + ': ' + (pps.length ? 'ik vind meer dan één PayPal-betaling aan Google en weet niet welke het is' : 'het PayPal-bewijs ontbreekt') + '. Ik maak het niet; wil je even kijken?').catch(() => uit.fouten.push('bericht'));
    }
    uit.stap = 'niet_gemaakt'; return uit;
  }

  // 4. voorcontrole + al in Verzonden (David kan hem zelf gestuurd hebben)
  const c = controle({ termijn, play, paypal, eerder_n: io.staat.eerderN(), rekeningen: io.rekeningen() });
  const aan = io.aan();
  const vz = await zoekVerzonden(io, termijn, vanafDag, aan);
  if (vz.fout) { uit.fouten.push('luik'); return uit; }
  if (vz.gevonden) {
    io.staat.reserveer({ termijn, status: 'door_david', n: play.n, reden: 'stond al in Verzonden', play_id: play.id, paypal_id: paypal.id, aangemaakt_op: iso, bijgewerkt_op: iso });
    uit.stap = 'door_david'; return uit;
  }
  if (vz.twijfel) c.redenen.push('er staat deze maand al een mail over Google Home aan je vader in Verzonden');
  if (!aan) c.redenen.push('geen adres van de boekhouder in Facturen');
  const v = io.staat.vrijgave();
  const auto = o.modus === 'auto' && vrijgaveGeldig(v, aan);
  const redenen = c.redenen.slice();
  if (!redenen.length && !auto) redenen.push(o.modus !== 'auto' ? 'automatisch versturen staat uit op de pod' : !v || !v.vraag_id ? 'nog niet door jou vrijgegeven' : 'de vrijgave geldt niet meer (abonnement of adres veranderde)');
  if (redenen.length) return await terugval(io, o, uit, termijn, play, paypal, redenen, iso, aan);
  if (na12) return await terugval(io, o, uit, termijn, play, paypal, ['het lukte niet vóór 12:00'], iso, aan);

  // 5. verzender gezond? (anders wachten tot 12:00, dan concept)
  let ok = false;
  try { ok = await io.verzenderOk(); } catch (e) { ok = false; }
  if (!ok) { uit.fouten.push('toetsen'); uit.stap = 'wacht'; uit.reden = 'verzender niet in orde'; return uit; }

  // 6. reserveren (de enige grens tegen dubbel), dan versturen
  const g = gegevens(termijn, play, paypal);
  const s = maak(g, { gemaakt: iso, gemaakt_dag: A.ymd, wijze: 'auto', vrijgegeven_dag: String(v.bevestigd_op || '').slice(0, 10) });
  if (!io.staat.reserveer({ termijn, status: 'verzenden', n: play.n, aan, pdf_sha256: s.sha256, play_id: play.id, paypal_id: paypal.id, aangemaakt_op: iso, bijgewerkt_op: iso })) { uit.stap = 'al'; return uit; }
  let r;
  try {
    r = await io.verstuur({ bron: 'boekstuk', modus: 'versturen', ref: 'BS' + termijn.replace('-', ''), aan, onderwerp: s.mail.onderwerp, bericht: s.mail.bericht, van: o.van, bijlage: { naam: s.naam, bytes: s.pdf } });
  } catch (e) {
    if (e && e.zekerNietVerstuurd) {
      io.staat.zet(termijn, 'verzenden', { status: 'concept_bezig', reden: 'verzender niet bereikt: ' + String(e.message || e).slice(0, 80) });
      return await conceptNu(io, uit, termijn, g, s, aan, ['de verzender was niet te bereiken'], iso, A.ymd);
    }
    io.staat.zet(termijn, 'verzenden', { status: 'onzeker', reden: 'geen antwoord van de verzender' });
    uit.stap = 'onzeker'; return uit;
  }
  if (r && r.status === 200 && r.j && r.j.ok === true && typeof r.j.message_id === 'string' && r.j.message_id) {
    io.staat.zet(termijn, 'verzenden', { status: 'verstuurd', verzonden_op: new Date(o.nu).toISOString(), message_id: r.j.message_id.slice(0, 80) });
    uit.stap = 'verstuurd';
    await io.bericht('Boekstuk Google Home ' + g.maand_naam + ' aan je vader gestuurd.').catch(() => uit.fouten.push('bericht'));
    return uit;
  }
  // een weigering van de verzender (4xx met ok:false, zoals pot-verzend) = zeker niet verstuurd → concept; al het andere = onzeker
  const zeker = r && r.status >= 400 && r.status < 500 && r.j && r.j.ok === false;
  if (zeker) {
    const code = String(r.j.code || r.status);
    io.staat.zet(termijn, 'verzenden', { status: 'concept_bezig', reden: 'verzender weigerde (' + code.slice(0, 30) + ')' });
    return await conceptNu(io, uit, termijn, g, s, aan, ['de verzender weigerde (' + code.slice(0, 30) + ')'], iso, A.ymd);
  }
  io.staat.zet(termijn, 'verzenden', { status: 'onzeker', reden: 'verzender gaf HTTP ' + (r && r.status) });
  uit.stap = 'onzeker'; return uit;
}
// Verzonden van deze maand aan de boekhouder: filename = zeker (ook als het concept van de pod verstuurd is); "Google Home" met de maandnaam in het onderwerp =
// zeker; "Google Home" zonder maandnaam = twijfel (dan concept, nooit versturen).
async function zoekVerzonden(io, termijn, vanaf, aan) {
  const naam = bestandsnaam({ termijn }), mn = MAANDEN[Number(termijn.slice(5, 7)) - 1];
  const j = await io.zoek(`in:sent${aan ? ' to:' + aan : ''} after:${gmailDag(ymdPlus(vanaf, -1))} {filename:"${naam}" "Google Home"}`);
  if (!j || j.melding || !Array.isArray(j.mails)) return { fout: true };
  let gevonden = false, twijfel = false;
  for (const m of j.mails) {
    const o = String(m.onderwerp || '').toLowerCase();
    if (!/google home/.test(o)) { twijfel = true; continue; }
    if (o.indexOf(mn) >= 0) gevonden = true; else twijfel = true;
  }
  return { gevonden, twijfel: !gevonden && twijfel };
}
// Terugval: een Gmail-concept aan André (als het boekstuk te maken is) met één regel in de app; anders alleen de regel.
async function terugval(io, o, uit, termijn, play, paypal, redenen, iso, aan) {
  const A = amsterdam(o.nu);
  if (!play || !paypal || !aan) {
    if (io.staat.reserveer({ termijn, status: 'niet_gemaakt', n: play ? play.n : null, reden: redenen.join('; ').slice(0, 300), play_id: play && play.id, paypal_id: paypal && paypal.id, aangemaakt_op: iso, bijgewerkt_op: iso })) {
      await io.bericht('Boekstuk Google Home ' + maandNaam(termijn) + ': niet gemaakt, want ' + redenen.join('; ') + '.').catch(() => uit.fouten.push('bericht'));
    }
    uit.stap = 'niet_gemaakt'; uit.reden = redenen.join('; '); return uit;
  }
  const g = gegevens(termijn, play, paypal);
  const s = maak(g, { gemaakt: iso, gemaakt_dag: A.ymd, wijze: 'concept' });
  if (!io.staat.reserveer({ termijn, status: 'concept_bezig', n: play.n, aan, pdf_sha256: s.sha256, reden: redenen.join('; ').slice(0, 300), play_id: play.id, paypal_id: paypal.id, aangemaakt_op: iso, bijgewerkt_op: iso })) { uit.stap = 'al'; return uit; }
  return conceptNu(io, uit, termijn, g, s, aan, redenen, iso, A.ymd);
}
async function conceptNu(io, uit, termijn, g, s, aan, redenen, iso, dagA) {
  // het concept krijgt de concepttekst (David verstuurt zelf), ook als de PDF eerst voor automatisch was gemaakt
  const sc = s.mail.bericht.indexOf('automatisch') >= 0 ? maak(g, { gemaakt: iso, gemaakt_dag: dagA, wijze: 'concept' }) : s;
  const waarom = redenen.join('; ');
  try {
    const a = await io.concept({ aan, onderwerp: sc.mail.onderwerp, bericht: sc.mail.bericht, bijlage: { naam: sc.naam, mime: 'application/pdf', inhoud_base64: sc.pdf.toString('base64') } });
    io.staat.zet(termijn, 'concept_bezig', { status: 'concept', pdf_sha256: sc.sha256, message_id: a && a.concept_id ? String(a.concept_id).slice(0, 80) : null });
    uit.stap = 'concept';
    await io.bericht('Boekstuk Google Home ' + g.maand_naam + ' staat als concept voor je vader in Gmail (' + waarom + '). Versturen doe je zelf.').catch(() => uit.fouten.push('bericht'));
  } catch (e) {
    const zeker = !!(e && e.zeker);
    io.staat.zet(termijn, 'concept_bezig', { status: zeker ? 'concept_mislukt' : 'concept_onzeker', reden: (waarom + '; concept: ' + String(e && (e.reden || e.message) || e)).slice(0, 300) });
    uit.stap = zeker ? 'concept_mislukt' : 'concept_onzeker'; uit.fouten.push('concept');
    await io.bericht('Boekstuk Google Home ' + g.maand_naam + ': ' + (zeker ? 'het concept kon ik niet klaarzetten' : 'het mailluik gaf geen bevestiging; kijk bij Concepten of het er staat') + ' (' + waarom + ').').catch(() => uit.fouten.push('bericht'));
  }
  uit.reden = waarom;
  return uit;
}

// Proef (machinekamer, eenmalig vóór de vrijgave): het boekstuk van een termijn uit de echte mails naar Davids testalias, via de verzender
// met bron boekstuk. Geen staat; de beller legt het spoor in de audit. → { ok, status, code, termijn, sha256 } of { ok: false, reden }
async function proef(io, o) {
  const termijn = o.termijn;
  if (!TERMIJN_RE.test(String(termijn || ''))) return { ok: false, reden: 'termijn ongeldig' };
  const zp = await io.zoek(`from:${ABO.play_van} subject:"Google Play-bestelling" after:${gmailDag(ymdPlus(termijn + '-01', -1))} before:${gmailDag(ymdPlus(termijn + '-01', 32))}`);
  if (!zp || zp.melding || !Array.isArray(zp.mails)) return { ok: false, reden: 'lees-luik' };
  let play = null;
  for (const k of zp.mails.slice(0, 10)) { const p = leesPlay(await io.lees(k.id)); if (!p.fout && reeksOk(p) && p.dag.slice(0, 7) === termijn) { play = p; break; } }
  if (!play) return { ok: false, reden: 'geen Google Play-bevestiging' };
  const zq = await io.zoek(`{from:service@paypal.nl from:service@paypal.com} "Google Payment" after:${gmailDag(ymdPlus(play.dag, -1))} before:${gmailDag(ymdPlus(play.dag, 3))}`);
  if (!zq || zq.melding || !Array.isArray(zq.mails)) return { ok: false, reden: 'lees-luik' };
  let paypal = null;
  for (const k of zq.mails.slice(0, 8)) { const q = leesPaypal(await io.lees(k.id)); if (!q.fout && Math.abs(Date.parse(q.mail_datum) - Date.parse(play.mail_datum)) <= 15 * 60e3) { paypal = q; break; } }
  if (!paypal) return { ok: false, reden: 'geen PayPal-bewijs' };
  const c = controle({ termijn, play, paypal, eerder_n: [], rekeningen: io.rekeningen() });
  if (!c.ok) return { ok: false, reden: c.redenen.join('; ') };
  const A = amsterdam(o.nu), g = gegevens(termijn, play, paypal);
  const s = maak(g, { gemaakt: new Date(o.nu).toISOString(), gemaakt_dag: A.ymd, wijze: 'auto', proef: true });
  const r = await io.verstuur({ bron: 'boekstuk', modus: 'versturen', ref: 'BSP' + termijn.replace('-', ''), aan: o.aan, onderwerp: s.mail.onderwerp, bericht: s.mail.bericht, van: o.van, bijlage: { naam: s.naam, bytes: s.pdf } });
  return { ok: !!(r && r.status === 200 && r.j && r.j.ok === true && r.j.message_id), status: r && r.status, code: r && r.j ? r.j.code || null : null, termijn, sha256: s.sha256 };
}

module.exports = { ABO, STATUSSEN, BEVESTIGING, VANAF_DAG, GEEN_MAIL_DAG, VAN_UUR, TOT_UUR, maandNaam, verwachtN, amsterdam, werkdag, feestdag, leesPlay, leesPaypal, controle,
  gegevens, mail, maakPdf, maak, bestandsnaam, aboHash, kaartHash, kaartVrijgave, vrijgaveToets, vrijgaveGeldig, ronde, proef, zoekVerzonden };
