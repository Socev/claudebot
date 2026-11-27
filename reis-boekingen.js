'use strict';
/*
 * reis-boekingen.js — wv4334 (besluitenpagina nr 197 = 2C97, David Ja 25-11-2026 22:27; Fable "Een 9 - tripper" G1): een
 * boekingsbevestiging in Davids Gmail komt vanzelf als verwijzing bij de komende reis in OVIS Tripper. Ontwerp en meting:
 * /opt/data/mk-scripts/wv4334/ontwerp.md (Codex-review in dezelfde map).
 *
 * Waarom: gemeten 27-11-2026 kregen ± 15 bevestigingen bij een reis (vlucht, verblijf, ferry, inschrijving) in een jaar bijna nooit een
 * MailMan- of Intake-label; de bronnen op de reispagina's kwamen er achteraf met de hand op. Deze nachtstap zoekt ze (lees-luik, alleen
 * lezen), koppelt een mail aan precies één komende reis (datum met jaar binnen de reisperiode + een reissignaal) en zet één regel in het
 * eigen blok "## Boekingen (Socev)" van die reispagina: datum, soort, afzendernaam en gmail-id. Nooit onderwerp, boekingsnummer, bedrag,
 * adres of tekst uit de mail; nooit een voorbije of geannuleerde reis; nooit buiten het eigen blok; geen taalmodel; niets naar buiten.
 * Zonder de vlag {"schrijven": true} is het een droge run: alleen het rapport.
 */
const fs = require('fs'), path = require('path');
const R = require('./reizen.js');

const BLOK_KOP = '## Boekingen (Socev)';
const BLOK_KOP_RE = /^##[ \t]+Boekingen[ \t]+\(Socev\)[ \t]*$/m;
const MAX_LUIK = 40, STUK_DAGEN = 14, LUIK_GRENS = 25, MAX_PER_REIS = 5, MAX_PER_NACHT = 10, MAX_LEZEN = 60, VOORUIT_DAGEN = 400;
const MAX_GEZIEN = 5000;

const REIS_AFZENDERS = ['booking.com', 'airbnb.com', 'klm.com', 'klm.nl', 'transavia.com', 'brusselsairlines.com', 'riksjatravel.nl', 'weeztix.com',
  'stenaline.nl', 'stenaline.com', 'dfds.com', 'scandlines.com', 'sunweb.nl', 'tui.nl', 'corendon.nl', 'expedia.nl', 'expedia.com', 'hotels.com',
  'sixt.com', 'sixt.nl', 'hertz.com', 'europcar.com', 'avis.com', 'eurostar.com', 'flixbus.com', 'easyjet.com', 'ryanair.com', 'lufthansa.com',
  'vueling.com', 'aeromexico.com', 'cheaptickets.nl', 'vliegtickets.nl', 'rentalcars.com', 'villaforyou.nl', 'gustocamp.nl', 'carbagerun.nl'];

// ── puur ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function plusDagen(dag, n) { const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function luikDatum(dag) { return dag.replace(/-/g, '/'); }
// De zoekvraag voor [van, tot) (tot exclusief, zoals Gmails before:). Gemeten 27-11 (droge run): alleen algemene bevestigingswoorden in het
// onderwerp gaf 138 kandidaten in een jaar (bestellingen, afspraken, scholing) en volle vensters; daarom: reisafzender, of een duidelijk
// reisonderwerp, of een algemeen bevestigingswoord SAMEN met een reiswoord of een naamwoord van een komende reis ergens in de mail.
const REIS_ONDERWERP = ['verblijfsbevestiging', 'boekingsbevestiging', 'reisbevestiging', 'e-ticket', 'eticket', 'itinerary', 'reisdocumenten', '"booking confirmation"', 'geboekt', 'booked'];
const ALGEMEEN_ONDERWERP = ['bevestiging', 'bevestigd', 'confirmation', 'confirmed', 'reservering', 'reservation', 'inschrijving', 'geannuleerd', 'cancelled'];
const REISWOORDEN = ['vlucht', 'flight', 'hotel', 'camping', 'verblijf', 'accommodatie', 'ferry', 'veerboot', 'huurauto', '"car rental"', 'vakantiehuis', 'appartement', 'hostel'];
function zoekVraag(van, tot, namen) {
  const extra = (namen || []).filter((w) => /^[a-z]{4,30}$/.test(w)).slice(0, 20);
  return '-in:drafts -in:sent -category:promotions -category:social (from:(' + REIS_AFZENDERS.join(' OR ') + ') OR subject:(' + REIS_ONDERWERP.join(' OR ') +
    ') OR (subject:(' + ALGEMEEN_ONDERWERP.join(' OR ') + ') (' + REISWOORDEN.concat(extra).join(' OR ') + '))) after:' + luikDatum(van) + ' before:' + luikDatum(tot);
}
function stukken(van, tot, dagen) {
  const uit = [];
  for (let d = van; d < tot; d = plusDagen(d, dagen)) { const e = plusDagen(d, dagen); uit.push([d, e < tot ? e : tot]); }
  return uit;
}

const STERK = new Set(['vlucht', 'veerboot', 'huur', 'verblijf', 'reisbureau']);
const GEEN_KANDIDAAT = /\b(beoordeel|beoordeling|review|herinnering|reminder|check-?in|online check|instapkaart|boarding|upgrade|verificatiecode|verification code|wachtwoord|password|nieuwsbrief|newsletter|factuur|invoice|betaalbewijs|betaling gelukt|belasten je kaart|we belasten|aanbieding|korting|deal|uitnodiging|stickers?)\b/i;
const IS_BEVESTIGING = /(bevestig|confirm|geboekt|\bbooked\b|bedankt (dat je|voor je)|thank you for booking|reservering|reservation|inschrijving|e-?ticket|itinerary|reisdocumenten|geannuleerd|annulering|cancell?ed|gewijzigde boeking)/i;
function soortVan(onderwerp, van) {
  const s = (String(onderwerp || '') + ' ' + String(van || '')).toLowerCase();
  if (/(geannuleerd|annulering|cancell?ed)/.test(s)) return 'annulering';
  if (/(vlucht|flight|airline|airways|klm|transavia|brussels ?airlines|easyjet|ryanair|lufthansa|vueling|aeromexico|e-?ticket|vliegticket)/.test(s)) return 'vlucht';
  if (/(ferry|veerboot|scandlines|stena ?line|dfds|p&o)/.test(s)) return 'veerboot';
  if (/(huurauto|autohuur|car rental|rentalcars|sixt|hertz|europcar|avis\b)/.test(s)) return 'huur';
  if (/(hotel|camping|camp\b|airbnb|booking\.com|verblijf|accommodatie|villa|hostel|appartement|apartment|gustocamp|\bstay\b)/.test(s)) return 'verblijf';
  if (/(reisbureau|riksja|\btui\b|sunweb|corendon|reisbevestiging|reisdocumenten|itinerary)/.test(s)) return 'reisbureau';
  if (/(inschrijving|registration|ticket)/.test(s)) return 'inschrijving';
  return 'overig';
}
// { soort } als het onderwerp op een boekingsbevestiging lijkt EN er vóór het lezen al een reissignaal is (reisafzender, sterke soort, of een
// naamwoord van een komende reis in onderwerp/afzender); anders null. namen = Set van naamwoorden van de komende reizen.
function kandidaat(m, namen) {
  const o = String((m && m.onderwerp) || '');
  if (!o || GEEN_KANDIDAAT.test(o) || !IS_BEVESTIGING.test(o)) return null;
  const soort = soortVan(o, m.van);
  const dom = (/@([a-z0-9.-]+)/i.exec(String(m.van || '')) || [])[1] || '';
  const reisAfzender = REIS_AFZENDERS.some((d) => dom.toLowerCase() === d || dom.toLowerCase().endsWith('.' + d));
  const naam = namen && woorden(o + ' ' + String(m.van || '')).some((w) => namen.has(w));
  // inschrijving/annulering mogen gelezen worden: de zoekvraag eiste al een reiswoord of naamwoord in de mail, koppelen eist er straks een naamwoord bij
  if (!reisAfzender && !STERK.has(soort) && soort !== 'inschrijving' && soort !== 'annulering' && !naam) return null;
  return { soort };
}
const MAANDEN = { jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mrt: 3, maart: 3, mar: 3, march: 3, apr: 4, april: 4,
  mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, augustus: 8, august: 8, sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
const MAAND_RE = Object.keys(MAANDEN).sort((a, b) => b.length - a.length).join('|');
function geldig(j, m, d) {
  j = Number(j); m = Number(m); d = Number(d);
  if (j < 2000 || j > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const x = new Date(Date.UTC(j, m - 1, d));
  if (x.getUTCMonth() !== m - 1) return null;
  return x.toISOString().slice(0, 10);
}
// Alle datums MET jaar in een tekst, als 'JJJJ-MM-DD' (een datum zonder jaar telt niet: te veel gok). Review MOET 2: een datum met een
// betaal-, annulerings- of deadlinerol telt niet als reisdatum (woord in de 80 tekens ervoor op dezelfde regel), zodat "kosteloos annuleren
// tot 20 februari 2027" een maartboeking niet aan een februarireis koppelt.
const GEEN_REISDATUM = /(annul|cancel|betaal|betaling|payment|\bpay\b|aanbetaling|deposit|deadline|uiterlijk|restitutie|refund|kosteloos|free of charge|gratis|vervalt|expire|geldig tot|valid until|geboren|birth|besteld op|booked on|geboekt op|boekingsdatum|booking date|factuurdatum|invoice date|verzonden|sent on)/i;
function datumsUit(tekst) {
  const s = String(tekst || '').slice(0, 20000), uit = new Set();
  const voeg = (x, i) => {
    if (!x) return;
    const regelBegin = s.lastIndexOf('\n', i) + 1, ervoor = s.slice(Math.max(regelBegin, i - 80), i);
    if (GEEN_REISDATUM.test(ervoor)) return;
    uit.add(x);
  };
  let m;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) voeg(geldig(m[1], m[2], m[3]), m.index);
  const dmj = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  while ((m = dmj.exec(s))) voeg(geldig(m[3], m[2], m[1]), m.index);
  const dmaj = new RegExp('\\b(\\d{1,2})(?:e|ste|de|st|nd|rd|th)?\\.?\\s+(' + MAAND_RE + ')\\.?,?\\s+(\\d{4})\\b', 'gi');
  while ((m = dmaj.exec(s))) voeg(geldig(m[3], MAANDEN[m[2].toLowerCase()], m[1]), m.index);
  const mdj = new RegExp('\\b(' + MAAND_RE + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'gi');
  while ((m = mdj.exec(s))) voeg(geldig(m[3], MAANDEN[m[1].toLowerCase()], m[2]), m.index);
  return [...uit].sort();
}

const ALGEMEEN = new Set(['winter', 'zomer', 'zomervakantie', 'vakantie', 'editie', 'reis', 'reizen', 'trip', 'gepland', 'weekend', 'weekendje', 'citytrip',
  'roadtrip', 'met', 'naar', 'van', 'voor', 'en', 'het', 'de', 'een', 'and', 'the', 'via', 'bij', 'zevende', 'eerste', 'tweede', 'derde', 'actueel',
  'route', 'noorse', 'april', 'mei', 'juni', 'juli', 'augustus', 'februari', 'januari', 'maart', 'september', 'oktober', 'november', 'december', 'hotel',
  'camping', 'resort', 'beach', 'city', 'center', 'centre', 'garbage', 'carbagerun']);
function woorden(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/\d/.test(w) && !ALGEMEEN.has(w)); }
// Naamwoorden van een reis: titel, bestandsnaam, aliases, plekken en verblijfsnamen (geen jaartallen, geen algemene woorden)
function naamwoordenVan(t, rel) {
  const bron = [R.fmVeld(t, 'onderwerp') || '', path.basename(String(rel || ''), '.md')];
  try { (R.fmLijst(t, 'aliases') || []).forEach((x) => bron.push(String(x))); } catch (e) {}
  try { (R.plekkenVan(t) || []).forEach((p) => bron.push(String((p && p.naam) || ''))); } catch (e) {}
  try { (R.verblijfVan(t) || []).forEach((v) => { bron.push(String((v && v.naam) || '')); bron.push(String((v && v.plaats) || '')); }); } catch (e) {}
  return [...new Set(bron.flatMap(woorden))];
}
// De komende reizen waar deze mail bij past. reizen = [{ id, van, tot, woorden }]. Twee regels:
//  A. een datum MET jaar in [eerste dag − 1, laatste dag + 1] (geen betaal-/annuleringsdatum) EN een reissignaal: sterke soort (vlucht,
//     veerboot, huur, verblijf, reisbureau) of een naamwoord van de reis in de mail;
//  B. (gemeten 27-11: de Carbage Run-inschrijving noemt geen rallydatum, wel "Winter editie 2027 Arctic Circle") minstens twee verschillende
//     naamwoorden van de reis EN het jaartal van de reis als los woord in de mail.
function koppelReizen(mail, soort, reizen) {
  const tekst = String(mail.onderwerp || '') + '\n' + String(mail.tekst || '');
  const datums = datumsUit(tekst);
  const tw = new Set(woorden(tekst));
  return reizen.filter((r) => {
    if (!r.van) return false;
    const naamTel = new Set((r.woorden || []).filter((w) => tw.has(w))).size;
    const a = plusDagen(r.van, -1), b = plusDagen(r.tot || r.van, 1);
    if (datums.some((d) => d >= a && d <= b) && (STERK.has(soort) || naamTel >= 1)) return true;
    return naamTel >= 2 && new RegExp('(^|[^0-9])' + r.van.slice(0, 4) + '([^0-9]|$)').test(tekst);
  }).map((r) => r.id);
}

const SOORT_TEKST = { vlucht: 'Vlucht', veerboot: 'Veerboot', huur: 'Huurauto', verblijf: 'Verblijf', reisbureau: 'Reisbureau', inschrijving: 'Inschrijving', annulering: 'Annulering', overig: 'Bevestiging' };
// Review MOET 3: een naam uit de mail wordt letterlijke platte tekst. Alleen letters, spaties en - ' & , . blijven; een woord met een cijfer,
// @, of een punt midden in het woord (domein, url) valt weg, behalve een kale merknaam als Booking.com; geen markdown, links of html mogelijk.
function schoon(s) {
  return String(s || '').normalize('NFC').replace(/[^\p{L}\p{M} '&,.-]/gu, ' ').split(/\s+/)
    .map((w) => w.replace(/^[-'&,.]+|[-',&]+$/g, ''))
    .filter((w) => w && !/\d/.test(w) && (!/\p{L}\.\p{L}/u.test(w) || /^[A-Za-z]+\.(com|nl)$/.test(w)) && !/^(https?|www)$/i.test(w)).join(' ').trim();
}
// De weergavenaam van de afzender, zonder adres, zonder "via Booking.com", zonder woorden met cijfers; bij Booking.com zonder naam de
// verblijfsnaam uit "Je boeking bij X is bevestigd"
function afzenderNaam(van, onderwerp) {
  const v = String(van || '');
  let naam = '';
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(v);
  if (m) naam = m[1];
  naam = naam.replace(/\s+via\s+booking\.com\b.*$/i, '').trim();
  if (!naam) {
    const b = /je boeking bij (.{2,80}?) is bevestigd/i.exec(String(onderwerp || ''));
    if (b) naam = b[1];
    else { const d = /@([a-z0-9.-]+)/i.exec(v); naam = d ? d[1].replace(/^(mail|email|info|notification|notify|noreply|no-reply|e)\./i, '') : ''; }
  }
  return schoon(naam).slice(0, 60).trim() || 'onbekende afzender';
}
function nlDatum(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : 'onbekende datum'; }
function regelVoor(mail, soort) {
  if (!/^[0-9a-f]{8,24}$/.test(String(mail.id || ''))) return null;
  return '- ' + nlDatum(mail.datum_lokaal || mail.datum) + ' · ' + (SOORT_TEKST[soort] || 'Bevestiging') + ' · ' + afzenderNaam(mail.van, mail.onderwerp) + ' — mail gmail:' + mail.id;
}
function alOpPagina(t, mail) {
  const s = String(t || '').toLowerCase();
  return [mail.id, mail.thread_id].some((x) => /^[0-9a-f]{8,24}$/.test(String(x || '')) && s.indexOf('gmail:' + String(x).toLowerCase()) >= 0);
}

const kopTel = (t) => (String(t).match(/^#{1,2}[ \t]/gm) || []).length;
// Puur: de pagina met de nieuwe regels in het eigen blok (dat zo nodig ontstaat vóór ## Gerelateerd, anders vóór <!-- sb:generated, anders
// aan het eind). { tekst } of { niets: true }. Nacontrole: alles buiten de invoeging byte-gelijk, koppen +0 of +1 (nieuw blok).
function blokToepassen(t, regels) {
  t = String(t);
  const nieuweRegels = (regels || []).filter((r) => typeof r === 'string' && /^- .{5,300}$/.test(r) && !/\n/.test(r) && t.indexOf(r) < 0);
  if (!nieuweRegels.length) return { niets: true };
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(t), basis = fm ? fm[0].length : 0;
  const kop = BLOK_KOP_RE.exec(t.slice(basis));
  let p, inv, nieuwBlok = false;
  if (kop) {
    const begin = basis + kop.index + kop[0].length;
    const eind = /^(?:#{1,2}[ \t]|<!-- sb:generated)/m.exec(t.slice(begin));
    const einde = eind ? begin + eind.index : t.length;
    // na de laatste niet-lege regel van het blok
    const blok = t.slice(begin, einde), inhoud = blok.replace(/\s+$/, '');
    p = begin + inhoud.length;
    inv = (inhoud.trim() ? '\n' : '\n\n') + nieuweRegels.join('\n');
  } else {
    nieuwBlok = true;
    const rest = t.slice(basis);
    const g = /^##[ \t]+Gerelateerd\b.*$/m.exec(rest) || /^<!-- sb:generated/m.exec(rest);
    const tekstBlok = BLOK_KOP + '\n\n' + nieuweRegels.join('\n') + '\n';
    if (g) { p = basis + g.index; inv = tekstBlok + '\n'; }
    else { p = t.length; inv = (t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n') + tekstBlok; }
  }
  const nieuw = t.slice(0, p) + inv + t.slice(p);
  if (nieuw.slice(0, p) !== t.slice(0, p) || nieuw.slice(p + inv.length) !== t.slice(p)) throw new Error('nacontrole boekingen');
  if (kopTel(nieuw) !== kopTel(t) + (nieuwBlok ? 1 : 0)) throw new Error('nacontrole boekingen koppen');
  if (R.fmVeld(nieuw, 'type') !== R.fmVeld(t, 'type') || R.fmVeld(nieuw, 'periode') !== R.fmVeld(t, 'periode')) throw new Error('nacontrole boekingen frontmatter');
  return { tekst: nieuw, regels: nieuweRegels.length, nieuw_blok: nieuwBlok };
}

// ── io ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/*
 * maak(o) → { ronde(opts) }
 * o = { vault, vv (vault-veilig), luik: async (body) → json (het lees-luik), staatDir, vandaag?() → 'JJJJ-MM-DD' }
 * ronde({ droog }) → rapport { ok, droog, venster, luikvragen, kandidaten, gelezen, per_reis: { id: { titel, nieuw, al, regels[] } }, geen, twijfel, fouten[] }
 */
function maak(o) {
  const vandaag = typeof o.vandaag === 'function' ? o.vandaag : function () { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); };
  const staatPad = path.join(o.staatDir, 'staat.json'), rapportPad = path.join(o.staatDir, 'laatste.json'), vlagPad = path.join(o.staatDir, 'aan.json');
  function leesJson(p) { try { const st = fs.lstatSync(p); if (!st.isFile() || st.size > 2 * 1024 * 1024) return null; return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
  function schrijfJson(p, d) {
    fs.mkdirSync(o.staatDir, { recursive: true, mode: 0o700 });
    const tmp = p + '.' + process.pid + '.' + Date.now() + '.tmp';
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, JSON.stringify(d, null, 1)); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
  }
  // aan.json ontbreekt = de stap doet niets; {"schrijven": false} = droge run (alleen het rapport); {"schrijven": true} = schrijven
  function aan() { const v = leesJson(vlagPad); return !!(v && typeof v === 'object'); }
  function schrijvenAan() { const v = leesJson(vlagPad); return !!(v && v.schrijven === true); }
  function lees(rel) { try { return o.vv.lees(path.join(o.vault, rel), 'utf8', { max: R.MAX_PAGINA || 512 * 1024 }); } catch (e) { return null; } }
  function paden() {
    let n = [];
    try { n = fs.readdirSync(path.join(o.vault, R.REIS_MAP)).filter((x) => /\.md$/.test(x) && !x.startsWith('.')); } catch (e) { n = []; }
    return n.sort().map((x) => path.join(R.REIS_MAP, x));
  }
  function komendeReizen(v) {
    const grens = plusDagen(v, VOORUIT_DAGEN), uit = [];
    for (const rel of paden()) {
      const t = lees(rel);
      if (t == null) continue;
      const r = R.ontleed(t, rel, v);
      if (!r || (r.stand !== 'gepland' && r.stand !== 'nu') || !r.van || r.van > grens) continue;
      uit.push({ id: r.id, rel, titel: r.titel, van: r.van, tot: r.tot || r.van, woorden: naamwoordenVan(t, rel) });
    }
    return uit;
  }
  // Eén stuk opvragen; vol (25) = per dag opnieuw. Geeft { mails, fout_dag } (fout_dag = eerste dag die niet volledig te lezen was)
  async function haal(van, tot, tel) {
    if (tel.n >= MAX_LUIK) return { mails: [], fout_dag: van, reden: 'te veel luikvragen' };
    // gemeten 27-11: het luik hapert soms (time-out, "deels mislukt"); één keer opnieuw, daarna stopt de ronde op deze dag
    let j = null, reden = null;
    for (let poging = 0; poging < 2 && tel.n < MAX_LUIK; poging++) {
      tel.n++; reden = null;
      try { j = await o.luik({ actie: 'mail_zoeken', query: zoekVraag(van, tot, tel.namen), max: LUIK_GRENS }); } catch (e) { j = null; reden = 'luik: ' + String(e && e.message || e).slice(0, 80); continue; }
      if (!j || typeof j !== 'object' || !Array.isArray(j.mails)) { reden = 'luik gaf geen lijst'; continue; }
      if (j.melding) { reden = 'luik: ' + String(j.melding).slice(0, 80); continue; }
      break;
    }
    if (reden || !j) return { mails: [], fout_dag: van, reden: reden || 'te veel luikvragen' };
    if (j.mails.length < LUIK_GRENS) return { mails: j.mails };
    if (plusDagen(van, 1) >= tot) return { mails: [], fout_dag: van, reden: 'meer dan ' + LUIK_GRENS + ' treffers op één dag' };
    const uit = [];
    for (const [a, b] of stukken(van, tot, 1)) {
      const x = await haal(a, b, tel);
      uit.push(...x.mails);
      if (x.fout_dag) return { mails: uit, fout_dag: x.fout_dag, reden: x.reden };
    }
    return { mails: uit };
  }

  async function ronde(opts) {
    const v = vandaag(), droog = !!(opts && opts.droog) || !schrijvenAan();
    const staat = leesJson(staatPad) || {};
    const gezien = staat.gezien && typeof staat.gezien === 'object' ? staat.gezien : {};
    const rapport = { ok: true, op: new Date().toISOString(), droog, venster: null, luikvragen: 0, kandidaten: 0, gelezen: 0, per_reis: {}, geen: 0, twijfel: 0, al: 0, uitgesteld: 0, fouten: [] };
    const reizen = komendeReizen(v);
    rapport.reizen = reizen.length;
    if (!reizen.length) { schrijfJson(rapportPad, rapport); return rapport; }
    reizen.forEach((r) => { rapport.per_reis[r.id] = { titel: r.titel, nieuw: 0, al: 0, regels: [] }; });
    const van = /^\d{4}-\d{2}-\d{2}$/.test(String(staat.tot || '')) ? plusDagen(staat.tot, -2) : plusDagen(v, -365);
    const tot = plusDagen(v, 1);
    rapport.venster = [van, tot];
    const namen = new Set(reizen.flatMap((r) => r.woorden));
    const tel = { n: 0, namen: [...namen] };
    const mails = [];
    let tot_gedaan = tot;
    for (const [a, b] of stukken(van, tot, STUK_DAGEN)) {
      const x = await haal(a, b, tel);
      mails.push(...x.mails);
      if (x.fout_dag) { rapport.fouten.push(x.fout_dag + ': ' + x.reden); tot_gedaan = x.fout_dag; break; }
    }
    rapport.luikvragen = tel.n;
    // kandidaten, nieuwste laatst; dubbele id's één keer
    const per = new Map();
    mails.forEach((m) => { if (m && /^[0-9a-f]{8,24}$/.test(String(m.id || '')) && !per.has(m.id)) per.set(m.id, m); });
    const lijst = [...per.values()].sort((a, b) => String(a.datum || '').localeCompare(String(b.datum || '')));
    const teksten = new Map(reizen.map((r) => [r.id, null]));
    const regelsPerReis = new Map();
    let nacht = 0, gelezen = 0;
    for (const m of lijst) {
      const pg = /^poging:([12])$/.exec(String(gezien[m.id] || ''));
      if (gezien[m.id] && !pg) continue;
      const k = kandidaat(m, namen);
      if (!k) continue;
      rapport.kandidaten++;
      if (opts && typeof opts.spoor === 'function') opts.spoor(m, k);
      if (gelezen >= MAX_LEZEN || nacht >= MAX_PER_NACHT) { rapport.uitgesteld++; continue; }
      let volle;
      try { volle = await o.luik({ actie: 'mail_lezen', id: m.id }); } catch (e) { volle = null; }
      gelezen++;
      // een mail die drie nachten niet te lezen is, telt daarna als gezien (anders schuift het venster nooit meer op en meldt de keten elke nacht)
      if (!volle || typeof volle !== 'object' || volle.fout || typeof volle.tekst !== 'string') {
        const n = pg ? Number(pg[1]) + 1 : 1;
        gezien[m.id] = n >= 3 ? 'onleesbaar' : 'poging:' + n;
        rapport.fouten.push('mail niet te lezen'); if (n < 3) rapport.uitgesteld++; continue;
      }
      const ids = koppelReizen({ onderwerp: m.onderwerp, tekst: volle.tekst }, k.soort, reizen);
      if (opts && typeof opts.spoorUit === 'function') opts.spoorUit(m, ids);
      if (!ids.length) { gezien[m.id] = 'geen'; rapport.geen++; continue; }
      if (ids.length > 1) { gezien[m.id] = 'twijfel'; rapport.twijfel++; continue; }
      const r = reizen.find((x) => x.id === ids[0]);
      if (teksten.get(r.id) == null) teksten.set(r.id, lees(r.rel));
      const t = teksten.get(r.id);
      if (t == null) { rapport.fouten.push('reispagina niet te lezen'); rapport.uitgesteld++; continue; }
      if (alOpPagina(t, m)) { gezien[m.id] = 'al:' + r.id; rapport.al++; rapport.per_reis[r.id].al++; continue; }
      const rg = regelsPerReis.get(r.id) || [];
      if (rg.length >= MAX_PER_REIS) { rapport.uitgesteld++; continue; }
      const regel = regelVoor(Object.assign({}, m, { datum_lokaal: volle.datum_lokaal || m.datum }), k.soort);
      if (!regel) continue;
      rg.push({ id: m.id, regel }); regelsPerReis.set(r.id, rg); nacht++;
    }
    rapport.gelezen = gelezen;
    // schrijven (of alleen tonen)
    for (const [rid, rg] of regelsPerReis) {
      const r = reizen.find((x) => x.id === rid);
      rapport.per_reis[rid].regels = rg.map((x) => x.regel);
      if (droog) continue;
      let gelukt = false, fout = null;
      try {
        gelukt = o.vv.wijzig(path.join(o.vault, r.rel), function (t) {
          if (Buffer.byteLength(t) > (R.MAX_PAGINA || 512 * 1024)) { fout = 'pagina te groot'; return null; }
          const x = R.ontleed(t, r.rel, v);
          if (!x || (x.stand !== 'gepland' && x.stand !== 'nu')) { fout = 'geen komende reis meer'; return null; }
          const u = blokToepassen(t, rg.filter((y) => !alOpPagina(t, { id: y.id })).map((y) => y.regel));
          return u.niets ? null : u.tekst;
        }, { grendel: 5, krimpGrens: true });
      } catch (e) { fout = String(e && e.code || e && e.message || 'schrijven faalde').slice(0, 60); }
      if (fout) { rapport.fouten.push(rid + ': ' + fout); continue; }
      rg.forEach((x) => { gezien[x.id] = 'gezet:' + rid; });
      rapport.per_reis[rid].nieuw = gelukt ? rg.length : 0;
    }
    if (!droog) {
      // tot schuift alleen op tot de eerste dag die niet te lezen was; uitgestelde mails komen zo vanzelf terug (tot − 2 d en niet in gezien)
      const uitgesteld = rapport.uitgesteld > 0;
      // bij een fout nooit verder dan de foute dag, maar ook niet terug vóór de vorige stand (het overlap-stuk was al gelezen)
      const oud = /^\d{4}-\d{2}-\d{2}$/.test(String(staat.tot || '')) ? staat.tot : null;
      let nieuwTot = uitgesteld ? (oud && oud > van ? oud : van) : tot_gedaan;
      if (oud && nieuwTot < oud && rapport.fouten.length && !uitgesteld) nieuwTot = oud;
      const ids = Object.keys(gezien);
      const bewaar = ids.length > MAX_GEZIEN ? ids.slice(ids.length - MAX_GEZIEN) : ids;
      // de keten meldt pas na drie nachten op rij met een fout (het luik hapert soms; de volgende nacht haalt hij het in)
      rapport.fout_nachten = rapport.fouten.length ? (Number(staat.fout_nachten) || 0) + 1 : 0;
      schrijfJson(staatPad, { tot: nieuwTot, gezien: Object.fromEntries(bewaar.map((k2) => [k2, gezien[k2]])), fout_nachten: rapport.fout_nachten, op: rapport.op });
    } else rapport.fout_nachten = 0;
    rapport.ok = rapport.fouten.length === 0;
    schrijfJson(rapportPad, rapport);
    return rapport;
  }
  return { ronde, komendeReizen, schrijvenAan, aan };
}

module.exports = { maak, zoekVraag, stukken, kandidaat, soortVan, datumsUit, naamwoordenVan, koppelReizen, afzenderNaam, regelVoor, alOpPagina, blokToepassen,
  plusDagen, BLOK_KOP, MAX_PER_REIS, MAX_PER_NACHT, LUIK_GRENS };
