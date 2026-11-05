// Facturen-verzender — Toetsen (wv855, F4, 23-10-2026; bouwplan Facturen-app § 4.4; wv921 23-10-2026: bron pot). DIT IS DE TWEEDE GRENS
// BUITEN DE POD: alleen I/O-regels, geen beslissing over facturen. Wat de pod ook vraagt, hier kan alleen dit:
//
// Bron facturen (standaard, Facturen-app):
//  1. WITTE LIJST: het doeladres moet exact op AAN_TOEGESTAAN staan (testalias + boekhoudadressen, F5 wv912 na Davids Ja). Eén adres;
//     geen cc, bcc, afzender of draad.
//  2. Modus concept: elk adres van AAN_TOEGESTAAN. Modus versturen (wv2480, David Ja 5-11-2026 14:31 met verse vingerafdruk; grondwet 1,
//     aanvulling 5-11-2026: per leverancier direct naar de boekhouding): ALLEEN met het eigen verzendgeheim, alleen naar AAN_DIRECT (de
//     boekhoudadressen, zonder testalias), schakelaar VERSTUREN_FACTUREN, en hooguit FACTUREN_PER_DAG per Amsterdamse dag (elke geslaagde
//     toets telt; de 16e → 409 direct_plafond, de pod maakt dan een concept). Afzender POT_VAN; verder dezelfde regels als concept.
//  2b. Bron facturen_proef (wv2480): dezelfde vorm als bron facturen + versturen, maar alleen naar AAN_PROEF (de testalias), hooguit
//     PROEF_PER_DAG per dag. Zo wordt het directe pad (concept → drafts.send) bewezen zonder de boekhouding te raken.
//  3. PLAFOND: hooguit PER_UUR aangemaakte concepten per uur (static data; best effort, de pod telt ook).
//  4. Bijlagen: 1–3 bestanden (multipart), alleen pdf/xml/940/sta/mt940, samen ≤ 20 MB, een .pdf begint met %PDF; onderwerp eindigt op
//     [ref FV|FA + 16 hex] en dat token = het veld token.
//
// Bron pot (wv921, David Ja 23-10-2026 op het ontwerp "POT-nota's automatisch versturen op datum"; grondwet 1, uitzondering):
//  5. ALLEEN MET HET EIGEN VERZENDGEHEIM (kluis n8n_verzender_versturen_secret, alleen in de pod, niet in een Socev-beurt). Modus
//     versturen met een ander geheim → 401, ook voor bron facturen. Het eigen geheim opent niets anders (→ 403).
//  6. AAN_POT: de zes bevestigde factuuradressen van de acht SLOEL-praktijken (Davids SLOEL-mails van 21-9) + Davids eigen testalias.
//     Elk adres in aan én in cc moet erop staan (Fable #9). Geen bcc, draad of antwoordadres. Afzender alleen POT_VAN.
//  7. VERSTUREN_POT: schakelaar (false = 409). Plafond POT_PER_DAG verstuurde mails per 24 uur (de pod houdt 12 per verzenddag aan).
//     Alleen op een werkdag (geen weekend, geen NL-feestdag) tussen 09:00 en 12:00 Amsterdam (409 buiten_venster): ook wie het geheim
//     zou bemachtigen, kan buiten dat venster niets versturen (diffreview wv921 #1).
//  8. Precies één PDF (%PDF, ≤ 1 MB); onderwerp ≤ 150 zonder regeleinde; bericht ≤ 3000; ref = POT + nummer van de verzending.
//
// Bron boekstuk (wv2316, David Ja 3-11-2026 met verse vingerafdruk; grondwet 1, aanvulling 3-11-2026): het maandelijkse interne boekstuk
// Google Home Premium Advanced van Tolgaarde naar André.
//  9. Zelfde eigen verzendgeheim als bron pot (geen nieuw geheim); alleen modus versturen. AAN_BOEKSTUK: precies één adres (Andrés
//     afschriftadres; Davids testalias voor de proef). Geen cc, bcc, draad of antwoordadres; afzender alleen POT_VAN.
// 10. VERSTUREN_BOEKSTUK: schakelaar (false = 409). Plafond BOEKSTUK_PER_30D per 30 dagen (elke geslaagde toets telt, ook als Gmail
//     daarna faalt); zelfde venster als pot (werkdag 09:00–12:00). Precies één PDF ≤ 250 KB; onderwerp begint met
//     "Boekstuk Google Home Premium Advanced"; bericht ≤ 1000; ref = BS of BSP + JJJJMM.
//
// Bron sepa (wv2465, David Ja 5-11-2026 12:21 met verse vingerafdruk; grondwet 1, aanvulling 5-11-2026): een SEPA-batch van Tolgaarde die
// David zelf in de Facturen-app maakte, meteen naar nogbetalen@ (Cynthia voert de betalingen daar uit).
// 11. Zelfde eigen verzendgeheim als bron pot (geen nieuw geheim); alleen modus versturen. AAN_SEPA: precies dat ene adres. Geen cc, bcc,
//     draad of antwoordadres; afzender alleen POT_VAN. ref = MsgId van de batch (SOCEV-JJJJMMDD-8 hex); onderwerp begint met
//     "SEPA-batch Tolgaarde <ref>"; bericht ≤ 2000.
// 12. VERSTUREN_SEPA: schakelaar (false = 409). Plafond SEPA_PER_DAG per 24 uur (elke geslaagde toets telt) en het gedeelde dagplafond;
//     elke dag 07:00–23:00 Amsterdam (409 buiten_venster). Precies twee bestanden: één .xml (begint met <?xml, pain.001, met
//     <MsgId>ref</MsgId>, ≤ 1 MB) en één .pdf (%PDF, ≤ 1 MB).
// Haalt nooit iets op. Fout → { toets: { fout, code, status } } zonder binaire data; de workflow antwoordt dan met die status.
// De pod vergelijkt vóór elke batch de sha256 van déze code met de waarde in zijn image (Fable #10): wie hier iets wijzigt, zet de
// automatische verzending stil tot het image mee is gewijzigd.
// Welk geheim: de taakomgeving van deze n8n staat require('crypto') niet toe (gemeten 23-10). Daarom vergelijkt de IF *Verzendgeheim?*
// de sha256 met een expressie, en zet de Code-knoop *Merk verzendgeheim* alleen op die tak json.verzendgeheim = true — buiten body,
// dus een beller kan die vlag niet zelf meesturen (de webhook levert alleen headers/params/query/body).
const AAN_TOEGESTAAN = ['d.schaap+facturentest@gmail.com', '453248tt@inkoop.exactonline.nl', '61j3j624@inkoop.exactonline.nl', 't17475m7@inkoop.exactonline.nl', '1435h6s3@inkoop.exactonline.nl', 'f13x@inkoop.exactonline.nl', 'a.schaap@actasynergia.nl', 'a8r1@inkoop.exactonline.nl']; // F5 (wv912, 23-10-2026, Davids Ja): testalias + boekhoudadressen uit de stamgegevens
const AAN_DIRECT = AAN_TOEGESTAAN.filter((a) => a !== 'd.schaap+facturentest@gmail.com');   // wv2480: nooit de testalias als echte bestemming
const VERSTUREN_FACTUREN = true;
const FACTUREN_PER_DAG = 15;
const AAN_PROEF = ['d.schaap+facturentest@gmail.com'];
const PROEF_PER_DAG = 3;
const PER_UUR = 30;
const MAX_AANTAL = 3, MAX_BYTES = 20 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', xml: 'application/xml', '940': 'application/octet-stream', sta: 'application/octet-stream', mt940: 'application/octet-stream' };
const AAN_POT = ['praktijkmanager@huisartskortegeer.nl', 'praktijkmanager@vanmeeterenvandop.nl', 'facturen@hapleusden.nl', 'r.vreekamp@hpleusdenzuid.nl',
  'facturen@huisartsentolgaarde.nl', 'm.schoonman@gmail.com', 'd.schaap+facturentest@gmail.com'];   // wv921: Korte Geer (P01–P03), Biezenkamp, Groenhouten, Sante, Tolgaarde, Lepelaar + testalias
const VERSTUREN_POT = true;
const POT_PER_DAG = 24;
const POT_VAN = ['"David Schaap" <dokterschaap@gmail.com>'];
const POT_PDF_MAX = 1024 * 1024;
const AAN_BOEKSTUK = ['a.schaap@actasynergia.nl', 'd.schaap+facturentest@gmail.com'];   // wv2316: André (afschriftadres in Facturen) + testalias
const VERSTUREN_BOEKSTUK = true;
const BOEKSTUK_PER_30D = 2;
const BOEKSTUK_PDF_MAX = 250 * 1024;
const AAN_SEPA = ['nogbetalen@huisartsentolgaarde.nl'];   // wv2465: alleen het betaalpostvak van Tolgaarde
const VERSTUREN_SEPA = true;
const SEPA_PER_DAG = 6;
const SEPA_MAX = 1024 * 1024;

function zichtbaar(ch) {
  const c = ch.codePointAt(0);
  return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) || c === 0xfeff || '<>:"|?*'.includes(ch));
}
function saneer(n) {
  let s = String(n ?? '').normalize('NFC');
  s = s.split(/[\\/]/).pop();
  s = Array.from(s).filter(zichtbaar).join('').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length > 120) { const i = s.lastIndexOf('.'); const ext = i > 0 ? s.slice(i) : ''; s = s.slice(0, 120 - ext.length).trim() + ext; }
  return s;
}
function venster(ms) {   // werkdag 09:00–12:00 Europe/Amsterdam; zelfde feestdagen als de pod (pot-verzend.js)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`, uur = Number(p.hour), j = Number(p.year);
  const plus = (s, d) => new Date(Date.parse(s + 'T12:00:00Z') + d * 864e5).toISOString().slice(0, 10);
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const pasen = `${j}-${String(Math.floor((h + l - 7 * m + 114) / 31)).padStart(2, '0')}-${String(((h + l - 7 * m + 114) % 31) + 1).padStart(2, '0')}`;
  const kd = new Date(Date.UTC(j, 3, 27)).getUTCDay() === 0 ? '04-26' : '04-27';
  const feest = ['01-01', kd, '05-05', '12-25', '12-26'].includes(ymd.slice(5)) || [-2, 0, 1, 39, 49, 50].some((x) => plus(pasen, x) === ymd);
  const wd = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return wd !== 0 && wd !== 6 && !feest && uur >= 9 && uur < 12;
}
function dagAms(ms) { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
function vensterSepa(ms) {   // elke dag 07:00–23:00 Europe/Amsterdam (stille uren)
  const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));
  return uur >= 7 && uur < 23;
}
const adressen = (x) => String(x ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);

const nu = Date.now();
const item = $input.first();
const { secret, ...body } = (item.json && item.json.body) || {};             // het secret gaat niet verder de workflow in
const versturenGeheim = item.json.verzendgeheim === true;   // alleen gezet door *Merk verzendgeheim* (IF op sha256 = die van n8n_verzender_versturen_secret)
const bestanden = item.binary ? Object.keys(item.binary) : [];
const binary = {}, meta = [], namen = new Set();
let fout = null, code = null, status = 400, totaal = 0;
const zet = (f, c, st) => { if (!fout) { fout = f; code = c; status = st; } };

const bron = String(body.bron ?? 'facturen');
const modus = String(body.modus ?? '');
const onderwerp = String(body.onderwerp ?? '');
let aan = String(body.aan ?? '').trim().toLowerCase(), cc = '', van = '', ref = '', token = '';
if (!['concept', 'versturen'].includes(modus)) zet('modus is concept of versturen', 'modus', 400);
// 5. geheimen: versturen alleen met het eigen geheim; het eigen geheim alleen voor versturen (pot, boekstuk, sepa, facturen, facturen_proef)
const eigen = bron === 'pot' || bron === 'boekstuk' || bron === 'sepa';
const direct = (bron === 'facturen' || bron === 'facturen_proef') && modus === 'versturen';   // wv2480
if (modus === 'versturen' && !versturenGeheim) zet('versturen kan alleen met het eigen verzendgeheim', 'secret', 401);
if (versturenGeheim && !((eigen || direct) && modus === 'versturen')) zet('dit geheim opent alleen versturen voor bron pot, boekstuk, sepa, facturen en facturen_proef', 'secret', 403);

if (bron === 'pot') {
  if (modus !== 'versturen') zet('bron pot kent alleen versturen', 'modus', 400);
  if (!versturenGeheim) zet('versturen kan alleen met het eigen verzendgeheim', 'secret', 401);
  const lijst = adressen(body.aan), ccLijst = adressen(body.cc);
  if (!lijst.length || lijst.length > 3 || ccLijst.length > 3) zet('één tot drie adressen in aan, hooguit drie in cc', 'aan', 400);
  if (lijst.some((a) => !AAN_POT.includes(a)) || ccLijst.some((a) => !AAN_POT.includes(a))) zet('adres staat niet op de witte lijst van de verzender (pot)', 'witte_lijst', 403);
  if (!VERSTUREN_POT) zet('versturen staat uit voor bron pot', 'versturen_uit', 409);
  if (!venster(nu)) zet('bron pot verstuurt alleen op werkdagen tussen 09:00 en 12:00', 'buiten_venster', 409);
  for (const k of ['bcc', 'thread_id', 'antwoord_aan', 'token']) if (body[k] !== undefined && body[k] !== '') zet('veld ' + k + ' is hier niet toegestaan', 'veld', 400);
  van = String(body.van ?? '');
  if (!POT_VAN.includes(van)) zet('afzender niet toegestaan', 'van', 400);
  ref = String(body.ref ?? '');
  if (!/^POT\d{1,9}$/.test(ref)) zet('ref ontbreekt of is ongeldig', 'ref', 400);
  if (!onderwerp || onderwerp.length > 150 || /[\r\n]/.test(onderwerp)) zet('onderwerp ontbreekt, is te lang of heeft een regeleinde', 'onderwerp', 400);
  if (typeof body.bericht !== 'string' || !body.bericht || body.bericht.length > 3000) zet('bericht ontbreekt of is te lang', 'bericht', 400);
  if (body.bijlagen !== undefined && body.bijlagen !== '') zet('bijlagen alleen als bestanden (multipart)', 'bijlagen', 400);
  if (bestanden.length !== 1) zet('precies één PDF', 'bijlagen', 400);
  aan = lijst.join(', '); cc = ccLijst.join(', ');
} else if (bron === 'boekstuk') {
  if (modus !== 'versturen') zet('bron boekstuk kent alleen versturen', 'modus', 400);
  if (!versturenGeheim) zet('versturen kan alleen met het eigen verzendgeheim', 'secret', 401);
  const lijst = adressen(body.aan);
  if (lijst.length !== 1) zet('precies één adres in aan', 'aan', 400);
  if (lijst.some((a) => !AAN_BOEKSTUK.includes(a))) zet('adres staat niet op de witte lijst van de verzender (boekstuk)', 'witte_lijst', 403);
  if (!VERSTUREN_BOEKSTUK) zet('versturen staat uit voor bron boekstuk', 'versturen_uit', 409);
  if (!venster(nu)) zet('bron boekstuk verstuurt alleen op werkdagen tussen 09:00 en 12:00', 'buiten_venster', 409);
  for (const k of ['cc', 'bcc', 'thread_id', 'antwoord_aan', 'token']) if (body[k] !== undefined && body[k] !== '') zet('veld ' + k + ' is hier niet toegestaan', 'veld', 400);
  van = String(body.van ?? '');
  if (!POT_VAN.includes(van)) zet('afzender niet toegestaan', 'van', 400);
  ref = String(body.ref ?? '');
  if (!/^BSP?20\d\d(0[1-9]|1[0-2])$/.test(ref)) zet('ref ontbreekt of is ongeldig', 'ref', 400);
  if (onderwerp.indexOf('Boekstuk Google Home Premium Advanced') !== 0 || onderwerp.length > 150 || /[\r\n]/.test(onderwerp)) zet('onderwerp past niet bij het boekstuk', 'onderwerp', 400);
  if (typeof body.bericht !== 'string' || !body.bericht || body.bericht.length > 1000) zet('bericht ontbreekt of is te lang', 'bericht', 400);
  if (body.bijlagen !== undefined && body.bijlagen !== '') zet('bijlagen alleen als bestanden (multipart)', 'bijlagen', 400);
  if (bestanden.length !== 1) zet('precies één PDF', 'bijlagen', 400);
  aan = lijst.join(', ');
} else if (bron === 'sepa') {
  if (modus !== 'versturen') zet('bron sepa kent alleen versturen', 'modus', 400);
  if (!versturenGeheim) zet('versturen kan alleen met het eigen verzendgeheim', 'secret', 401);
  const lijst = adressen(body.aan);
  if (lijst.length !== 1) zet('precies één adres in aan', 'aan', 400);
  if (lijst.some((a) => !AAN_SEPA.includes(a))) zet('adres staat niet op de witte lijst van de verzender (sepa)', 'witte_lijst', 403);
  if (!VERSTUREN_SEPA) zet('versturen staat uit voor bron sepa', 'versturen_uit', 409);
  if (!vensterSepa(nu)) zet('bron sepa verstuurt alleen tussen 07:00 en 23:00', 'buiten_venster', 409);
  for (const k of ['cc', 'bcc', 'thread_id', 'antwoord_aan', 'token']) if (body[k] !== undefined && body[k] !== '') zet('veld ' + k + ' is hier niet toegestaan', 'veld', 400);
  van = String(body.van ?? '');
  if (!POT_VAN.includes(van)) zet('afzender niet toegestaan', 'van', 400);
  ref = String(body.ref ?? '');
  if (!/^SOCEV-20\d{6}-[0-9a-f]{8}$/.test(ref)) zet('ref ontbreekt of is ongeldig', 'ref', 400);
  if (onderwerp.indexOf('SEPA-batch Tolgaarde ' + ref) !== 0 || onderwerp.length > 150 || /[\r\n]/.test(onderwerp)) zet('onderwerp past niet bij de batch', 'onderwerp', 400);
  if (typeof body.bericht !== 'string' || !body.bericht || body.bericht.length > 2000) zet('bericht ontbreekt of is te lang', 'bericht', 400);
  if (body.bijlagen !== undefined && body.bijlagen !== '') zet('bijlagen alleen als bestanden (multipart)', 'bijlagen', 400);
  if (bestanden.length !== 2) zet('precies twee bestanden: de batch (xml) en de specificatie (pdf)', 'bijlagen', 400);
  aan = lijst.join(', ');
} else if (bron === 'facturen' || bron === 'facturen_proef') {
  token = String(body.token ?? '');
  if (bron === 'facturen_proef' && modus !== 'versturen') zet('bron facturen_proef kent alleen versturen', 'modus', 400);
  if (direct && !VERSTUREN_FACTUREN) zet('direct versturen staat uit in de verzender', 'versturen_uit', 403);
  if (!(bron === 'facturen_proef' ? AAN_PROEF : direct ? AAN_DIRECT : AAN_TOEGESTAAN).includes(aan)) zet('adres staat niet op de witte lijst van de verzender' + (direct ? ' (direct)' : ''), 'witte_lijst', 403);
  if (direct) van = POT_VAN[0];
  for (const k of ['cc', 'bcc', 'van', 'thread_id', 'antwoord_aan', 'ref']) if (body[k] !== undefined && body[k] !== '') zet('veld ' + k + ' is hier niet toegestaan', 'veld', 400);
  if (!/^F[VA][0-9a-f]{16}$/.test(token)) zet('token ontbreekt of is ongeldig', 'token', 400);
  const m = /\[ref (F[VA][0-9a-f]{16})\]\s*$/.exec(onderwerp);
  if (!m || m[1] !== token || onderwerp.length > 250 || /[\r\n]/.test(onderwerp)) zet('onderwerp moet eindigen op [ref <token>]', 'onderwerp', 400);
  if (typeof body.bericht !== 'string' || !body.bericht || body.bericht.length > 2000) zet('bericht ontbreekt of is te lang', 'bericht', 400);
  if (body.bijlagen !== undefined && body.bijlagen !== '') zet('bijlagen alleen als bestanden (multipart)', 'bijlagen', 400);
  if (!bestanden.length) zet('geen bijlage', 'bijlagen', 400);
  if (bestanden.length > MAX_AANTAL) zet('hooguit ' + MAX_AANTAL + ' bijlagen', 'bijlagen', 400);
} else zet('onbekende bron', 'bron', 400);

for (let i = 0; !fout && i < bestanden.length; i++) {
  const k = bestanden[i], nr = 'bijlage ' + (i + 1);
  let naam = saneer(item.binary[k].fileName);
  const p = naam.lastIndexOf('.'), ext = p > 0 ? naam.slice(p + 1).toLowerCase() : '';
  if (!naam || !TYPES[ext] || (eigen && bron !== 'sepa' && ext !== 'pdf') || ((bron === 'sepa' || direct) && ext !== 'pdf' && ext !== 'xml')) {
    zet(nr + ': alleen ' + (bron === 'sepa' || direct ? 'xml en pdf' : eigen ? 'pdf' : 'pdf, xml of MT940'), 'bijlagen', 400); break;
  }
  if (bron === 'sepa' && meta.some((x) => x.ext === ext)) { zet(nr + ': precies één xml en één pdf', 'bijlagen', 400); break; }
  const buf = await this.helpers.getBinaryDataBuffer(0, k);
  if (!buf || !buf.length) { zet(nr + ': leeg bestand', 'bijlagen', 400); break; }
  totaal += buf.length;
  if (totaal > (bron === 'pot' ? POT_PDF_MAX : bron === 'boekstuk' ? BOEKSTUK_PDF_MAX : bron === 'sepa' ? 2 * SEPA_MAX : MAX_BYTES) || (bron === 'sepa' && buf.length > SEPA_MAX)) { zet('bijlagen te groot', 'bijlagen', 400); break; }
  if (bron === 'sepa' && ext === 'xml') {
    const kop = buf.slice(0, 4096).toString('utf8');
    if (kop.indexOf('<?xml') !== 0 || kop.indexOf('pain.001') < 0 || kop.indexOf('<MsgId>' + ref + '</MsgId>') < 0) { zet(nr + ': geen SEPA-batch met dit kenmerk', 'bijlagen', 400); break; }
  }
  if (ext === 'pdf' && !(buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) { zet(nr + ': inhoud past niet bij .pdf', 'bijlagen', 400); break; }
  if (namen.has(naam.toLowerCase())) { const stam = naam.slice(0, p); let n = 2; while (namen.has((stam + ' (' + n + ').' + ext).toLowerCase())) n++; naam = stam + ' (' + n + ').' + ext; }
  namen.add(naam.toLowerCase());
  binary['bijlage_' + i] = { ...item.binary[k], mimeType: TYPES[ext], fileName: naam, fileExtension: ext };
  meta.push({ naam: naam, bytes: buf.length, ext: ext });
}

// plafond (alleen als de rest klopt): concepten per uur (facturen), verstuurde mails per 24 uur (pot en boekstuk samen), boekstuk per 30 dagen
const sd = $getWorkflowStaticData('global');
sd.gemaakt = (Array.isArray(sd.gemaakt) ? sd.gemaakt : []).filter((t) => nu - t < 3600000);
sd.pot = (Array.isArray(sd.pot) ? sd.pot : []).filter((t) => nu - t < 86400000);
sd.boekstuk = (Array.isArray(sd.boekstuk) ? sd.boekstuk : []).filter((t) => nu - t < 30 * 86400000);
sd.sepa = (Array.isArray(sd.sepa) ? sd.sepa : []).filter((t) => nu - t < 86400000);
sd.direct = (Array.isArray(sd.direct) ? sd.direct : []).filter((t) => nu - t < 2 * 86400000);   // wv2480: per Amsterdamse dag geteld
sd.proef = (Array.isArray(sd.proef) ? sd.proef : []).filter((t) => nu - t < 2 * 86400000);
const vandaag = dagAms(nu);
if (!fout && bron === 'facturen' && direct && sd.direct.filter((t) => dagAms(t) === vandaag).length >= FACTUREN_PER_DAG) zet('plafond van ' + FACTUREN_PER_DAG + ' directe verzendingen per dag bereikt', 'direct_plafond', 409);
if (!fout && bron === 'facturen' && direct) sd.direct.push(nu);
if (!fout && bron === 'facturen_proef' && sd.proef.filter((t) => dagAms(t) === vandaag).length >= PROEF_PER_DAG) zet('plafond van ' + PROEF_PER_DAG + ' proeven per dag bereikt', 'direct_plafond', 409);
if (!fout && bron === 'facturen_proef') sd.proef.push(nu);
if (!fout && !eigen && !direct && sd.gemaakt.length >= PER_UUR) zet('plafond van ' + PER_UUR + ' per uur bereikt', 'plafond', 429);
if (!fout && eigen && sd.pot.length >= POT_PER_DAG) zet('plafond van ' + POT_PER_DAG + ' verstuurde nota\'s per 24 uur bereikt', 'plafond', 429);
if (!fout && bron === 'boekstuk' && sd.boekstuk.length >= BOEKSTUK_PER_30D) zet('plafond van ' + BOEKSTUK_PER_30D + ' boekstukken per 30 dagen bereikt', 'plafond', 429);
if (!fout && bron === 'boekstuk') sd.boekstuk.push(nu);
if (!fout && bron === 'sepa' && sd.sepa.length >= SEPA_PER_DAG) zet('plafond van ' + SEPA_PER_DAG + ' SEPA-batches per 24 uur bereikt', 'plafond', 429);
if (!fout && bron === 'sepa') sd.sepa.push(nu);

const uit = { bron: bron, aan: aan, cc: cc, van: van, modus: modus, token: token, ref: ref, onderwerp: onderwerp, bericht: fout ? '' : body.bericht,
  toets: { fout: fout, code: code, status: fout ? status : 200, pad: !fout && (eigen || direct) && modus === 'versturen' && versturenGeheim ? 'pot' : 'facturen', aantal: fout ? 0 : meta.length, props: fout ? '' : Object.keys(binary).join(',') } };
return [fout ? { json: uit } : { json: uit, binary: binary }];
