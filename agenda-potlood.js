'use strict';
/*
 * wv3741 (besluitenpagina nr 486 = 3C186, David Ja 21-11-2026 13:12): potloodlaag.
 * "Mag Socev in zijn eigen kalender in potlood zetten wat hij aan data, vertrektijden en voorbereiding vindt, zodat jij het in je
 * agenda ziet en met één ✅ overneemt?"
 *
 * Eén ronde (dagtik in server.js, 07:05–11:00, hooguit eens per uur tot het dagplafond bereikt is):
 *  1. lezen (fail-closed: lukt één lezing niet, dan doet de ronde niets): vondsten van de datumdetector (kalender-app.js gevonden(),
 *     wv3679) en de eigen potloden in de Socev-kalender (luik socev_lijst);
 *  2. opruimen per potlood uit het register: dag voorbij → verlopen; niet meer in de Socev-kalender → David haalde hem weg = klopt niet
 *     (vondsten op afgewezen, komt nooit terug); vondst lijkt nu in Davids agenda (spiegel, nu_in) → potlood weg (overgenomen);
 *  3. nieuw: vondsten met precisie dag of minuut, morgen t/m +45 dagen, niet "lijkt al in je agenda", met vindbaar stuk (bron verplicht), samengevoegd op dag|tijd|onderwerp,
 *     sleutel nog nooit in het register → potlood (socev_plaatsen) + één kaart "Bevestig in je agenda" (david_plaatsen, kaart: true):
 *     alleen Davids ✅ met vingerafdruk zet het in zijn agenda (bestaande route agenda-schrijven).
 * Grenzen: alleen de Socev-kalender (het luik kent alleen die calendarId voor socev_*); verwijderen alleen eigen event_ids uit het register
 * met de potloodmarkering in de titel; plafond per dag en per ronde (de luikrem is 10 mutaties per rollend uur, ook voor Socev zelf);
 * geen titels of zinnen in register, log of info.
 *
 * v2 (wv3813, vervolg op besluit nr 486 "data, vertrektijden en voorbereiding"; Codex-ontwerpreview NO-GO → MOET 1, 2 en ZOU 1 verwerkt):
 *  a. ❌ = klopt niet: het luik geeft bij een kaart het correlatie_id ("ag-" + execution-id van het voorstel) terug; dat bewaart het register
 *     (kc). Een ❌ (Niet doen) schrijft in n8n-tabel socev_agenda_log een rij david_afgewezen met datzelfde correlatie_id. De ronde zoekt
 *     gericht op de open kc's (alleen lezen, o.afwijzingen) en haalt het potlood dan weg + klopt_niet (komt nooit terug). Leesfout = overslaan.
 *  b. blokken zonder kaart (eigen toestemmingsrij agenda-socev-blokken; zonder die rij op aan doet dit deel niets, ook niet opruimen):
 *     "Vertrek naar <plaats>" vóór een afspraak met tijd in Davids eigen, Werk- of HAGRO-agenda op een bekende plaats (reistijd en plaatsen uit
 *     agenda-narekenen.js; vanaf de vorige afspraak ≤ 3 uur ervoor met bekende plaats, anders thuis); "Voorbereiden" als hele-dag-item op de
 *     werkdag vóór een HAGRO-afspraak, een afspraak met app-stuklink of een vergader-potlood met stuk onder 10_Zakelijk/. Werk/David-titels
 *     nooit in een blok (MOET 1). Lezen via het lees-luik (o.agenda), morgen t/m +14 d, fail-closed. Weggehaald = komt nooit terug; niet meer
 *     gewenst = weg (vervallen, mag later opnieuw). Zelfde plafond (5 nieuw per dag, 30 actief) en rem (4 schrijfacties per ronde).
 *
 * v3 (wv3978, David 23-11-2026 07:40 over de eerste ronde: "wat moet ik doen dan, wat is precies mijn afspraak?"; 2 van 2 vals: een werkrooster
 * "dinsdag, woensdag en donderdag, van 8 tot 17 uur" en een arbobrief aan een medewerker): een vondst wordt pas een potlood + kaart als David
 * ZELF de deelnemer is. Eerst harde regels (nietVoorDavid, puur): losse weekdag zonder datum (detectorregel rel.weekdag of treffer zonder
 * datum), rooster ("elke/iedere <dag>", "<dag>en/<dag>s"), stuk in een map Medewerkers/, of een stuk dat niet van David komt met een aanhef
 * aan een ander met naam ("Beste mevrouw X"; "Beste klant" of een voornaam beslist het model). Daarna één modelvraag per kandidaat (o.model: Sonnet via het abonnement, hooguit 6 per ronde; geen patiëntfilter,
 * Davids afspraak): { oordeel ja|nee|twijfel, wat, titel }. Fail-closed: alleen "ja" met een bruikbare wat-zin en titel wordt een potlood;
 * modelfout = deze ronde geen modelvragen meer (na 3 fouten op dezelfde vondst = nee). Nee wordt onthouden (s.oordeel, alleen code en dag, geen titels) en nooit opnieuw gevraagd.
 * Kaart en potlood dragen de titel van het model (zonder RE:/FW:) en de wat-zin ("Gesprek met X over Y, bij Z"); in de gedeelde HAGRO-agenda
 * alleen de titel (n8n staat daar alleen een HAGRO-stuklink toe).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TZ = 'Europe/Amsterdam';
const MARK = '✏️ ';
const PROEF = 'SOCEV PROEF ';
// mutatiesRonde 4: de luikrem (10 per rollend uur) geldt ook voor Davids eigen agendakaarten; zo houdt hij er altijd 6 over (gemeten 21-11:
// een proefreeks vulde de rem in 20 minuten)
const STANDAARD = { plafondDag: 5, mutatiesRonde: 4, maxActief: 30, dagen: 45, kaartPogingen: 2, blokDagen: 14, minReis: 15, vorigeMaxMin: 180, thuis: 'blaricum' };
const BLOK_KAL = ['David', 'Werk', 'HAGRO'];   // Gezin niet: kan voor een gezinslid zijn
const VERGADER = /(vergader|overleg|\balv\b|bestuur|hagro|beraad|\bmt\b|maatschap)/i;
const WD = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const CORR = /^ag-\d{1,15}$/;
// Grondwet, alinea TOESTEMMINGEN: alleen het register telt. Zonder rij agenda-socev-potlood op status aan doet de ronde niets
// (ook niet opruimen); onleesbaar = uit. Proefmodus (alleen SOCEV PROEF in de Socev-kalender, proefkaart) heeft de rij niet nodig.
const REGISTER_RIJ = 'agenda-socev-potlood';
const BLOK_RIJ = 'agenda-socev-blokken';   // wv3813: vertrek- en voorbereidblokken (eigen rij, eigen Ja)
function registerAan(pad, rij) {
  rij = rij || REGISTER_RIJ;
  try { const r = JSON.parse(fs.readFileSync(pad, 'utf8')); return !!(r && Array.isArray(r.rijen) && r.rijen.find((x) => x && x.id === rij && x.status === 'aan')); }
  catch (e) { return false; }
}
// reistijd en plaatsen: dezelfde rekenkern als het narekenen van een agendavoorstel (wv3704); geen tweede bron. Ontbreekt hij: geen blokken.
let N = null;
try { N = require(path.join(__dirname, 'agenda-narekenen.js')); } catch (e) { N = null; }

function dagAms(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ }); }
function plusDagen(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 24); }
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
function plusUur(dag, hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return null;
  const min = Number(m[1]) * 60 + Number(m[2]) + 60;
  if (min >= 24 * 60) return dag + 'T23:59';
  return dag + 'T' + String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
// app-link naar een vaultstuk zoals de app hem opent (skill agenda-schrijven § Omschrijving)
function stukLink(pad) {
  if (typeof pad !== 'string' || !/\.md$/.test(pad) || pad.startsWith('/') || pad.split('/').some((x) => !x || x === '..' || x.startsWith('.'))) return null;
  return 'https://app.socev.dev/' + pad.split('/').map(encodeURIComponent).join('/');
}
function isHagro(pad) { return typeof pad === 'string' && pad.indexOf('10_Zakelijk/HAGRO/') === 0; }

// ── wv3978: alleen afspraken waar David zelf bij moet zijn ───────────────────────────────────────────────────────────────────────
const DAGNAAM = '(?:maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)';
const WEEKDAG_RE = new RegExp('\\b' + DAGNAAM + '\\b', 'i');
const ROOSTER_RE = new RegExp('\\b(?:elke|iedere|alle)\\s+' + DAGNAAM + '|\\b' + DAGNAAM + '(?:en|s)\\b', 'i');
const DATUM_RE = /\b\d{1,2}\s*[-\/.]\s*\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mrt|maa|apr|mei|jun|jul|aug|sep|okt|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b/i;
const AANHEF_RE = /^[ \t>*_]*(?:beste|geachte|hoi|hallo|dag|lieve|goedemorgen|goedemiddag|goedenavond|hi|dear)\s+([^,\n!:]{1,60}?)\s*[,!:\n]/im;
const AANHEF_DAVID = /\b(?:david|schaap|socev)\b/i;
// alleen een aanhef met mevrouw/heer + naam is zeker aan een ander ("Beste mevrouw X"); "Beste klant", "Beste HCE-leden" of een voornaam beslist het model
const AANHEF_PERSOON = /^(?:mevrouw|mevr\.?|mw\.?|heer|meneer|dhr\.?|mr\.?|mrs\.?|ms\.?)\s+(?!\/|of\b)\S/i;
const VAN_DAVID = /david schaap|d\.schaap@/i;
const MODEL_RONDE = 6, MODEL_POGINGEN = 3;
// RE:/FW:/Fwd:/Antw:/Doorst: vooraan een mailonderwerp hoort niet in een agendatitel
function zonderRe(t) { let s = String(t == null ? '' : t).trim(), v; do { v = s; s = s.replace(/^(?:re|fw|fwd|aw|antw|doorst|wg)\s*(?:\[\d+\])?\s*:\s*/i, ''); } while (s !== v); return s; }
function kopVeld(tekst, veld) {
  if (typeof tekst !== 'string' || tekst.indexOf('---\n') !== 0) return '';
  const e = tekst.indexOf('\n---\n', 4);
  const kop = e > 0 ? tekst.slice(4, e) : '';
  const m = new RegExp('^' + veld + ':\\s*"?([^"\\n]*)"?\\s*$', 'm').exec(kop);
  return m ? m[1] : '';
}
function lijfVan(tekst) {
  if (typeof tekst !== 'string') return '';
  if (tekst.indexOf('---\n') !== 0) return tekst;
  const e = tekst.indexOf('\n---\n', 4);
  return e > 0 ? tekst.slice(e + 5) : tekst;
}
/*
 * nietVoorDavid(k, tekst) → reden-code | null — puur. k = kandidaat (bronregels, zin, stuk_pad); tekst = het stuk zoals op schijf (of null).
 * Alleen zekere gevallen; al het andere beslist de modelvraag.
 */
function nietVoorDavid(k, tekst) {
  k = k || {};
  if ((k.bronregels || []).some((x) => /^rel\.weekdag/.test(String(x)))) return 'weekdag';
  const z = k.zin && typeof k.zin === 'object' ? k.zin : null;
  if (z) {
    const tr = String(z.treffer || '');
    if (WEEKDAG_RE.test(tr) && !DATUM_RE.test(tr)) return 'weekdag';
    if (ROOSTER_RE.test(String(z.voor || '') + ' ' + tr + ' ' + String(z.na || ''))) return 'rooster';
  }
  if (/(^|\/)Medewerkers\//.test(String(k.stuk_pad || ''))) return 'medewerker';
  if (typeof tekst === 'string' && !VAN_DAVID.test(kopVeld(tekst, 'afzender'))) {
    const m = AANHEF_RE.exec(lijfVan(tekst).slice(0, 8000));
    if (m) {
      const naam = m[1].trim();
      if (naam && !AANHEF_DAVID.test(naam) && AANHEF_PERSOON.test(naam)) return 'aan_ander';
    }
  }
  return null;
}
const MODEL_SYSTEEM = [
  'Je beoordeelt voor David Schaap (huisarts; praktijkhouder en werkgever van de huisartsenpraktijken Tolgaarde en Groenhouten in Leusden; actief in de HAGRO)',
  'of een datum die een automatische detector in een stuk vond een afspraak is waar David ZELF bij moet zijn, of een deadline die David ZELF moet halen.',
  'Antwoord "nee" bij: een werkrooster of vaste werkdagen; een afspraak, spreekuur of gesprek van een medewerker, patiënt of ander (ook als David werkgever is,',
  'in cc staat of de brief doorkreeg); een brief of uitnodiging gericht aan iemand anders; openingstijden; een leverdatum of ingangsdatum zonder handeling van David;',
  'een datum die al voorbij is of alleen ter informatie genoemd wordt. Antwoord "twijfel" als het stuk het niet duidelijk maakt. Alleen "ja" als David zelf',
  'aanwezig moet zijn of zelf iets moet doen vóór die datum.',
  'wat: één gewone Nederlandse zin wat de afspraak is en met wie, bijvoorbeeld "Gesprek met <naam> over <onderwerp>, bij <plaats>" (bij nee of twijfel: kort waarom niet).',
  'titel: korte agendatitel (hooguit 60 tekens), zonder RE:, FW: of "Afspraak uit:". Gebruik alleen wat in het stuk staat; verzin niets.',
].join('\n');
const MODEL_SCHEMA = { type: 'object', additionalProperties: false, required: ['oordeel', 'wat', 'titel'],
  properties: { oordeel: { type: 'string', enum: ['ja', 'nee', 'twijfel'] }, wat: { type: 'string' }, titel: { type: 'string' } } };
function dagTekst(dag) { return wdLang(dag) + ' ' + Number(dag.slice(8, 10)) + '-' + Number(dag.slice(5, 7)) + '-' + dag.slice(0, 4); }
function wdLang(dag) { return ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'][new Date(dag + 'T12:00:00Z').getUTCDay()]; }
/* modelPrompt(k, tekst) → de vraag voor één kandidaat — puur. */
function modelPrompt(k, tekst) {
  const z = k.zin && typeof k.zin === 'object' ? k.zin : null;
  return ['Vondst: ' + (k.soort === 'deadline' ? 'deadline' : 'afspraak') + ' op ' + dagTekst(k.dag) + (k.begin ? ' om ' + k.begin + (k.eind ? '–' + k.eind : '') : ' (hele dag)') + '.',
    'Onderwerp volgens de detector: ' + kort(k.onderwerp, 200),
    z ? 'Zin in het stuk: ' + kort(String(z.voor || '') + '[' + String(z.treffer || '') + ']' + String(z.na || ''), 900) : 'Zin in het stuk: (niet terug te vinden)',
    'Stuk: ' + String(k.stuk_pad || ''), '', 'Begin van het stuk:', String(tekst || '').slice(0, 6000)].join('\n');
}
/* modelUit(antwoord) → { v: 'ja', wat, titel } | { v: 'nee' } | null (onbruikbaar = modelfout) — puur, fail-closed. */
function modelUit(a) {
  const d = a && a.ok === true && a.data && typeof a.data === 'object' ? a.data : null;
  if (!d || ['ja', 'nee', 'twijfel'].indexOf(d.oordeel) < 0) return null;
  if (d.oordeel !== 'ja') return { v: 'nee' };
  const wat = kort(String(d.wat || '').replace(/[\r\n]+/g, ' '), 240);
  const titel = kort(zonderRe(String(d.titel || '').replace(/[\r\n]+/g, ' ').replace(/^Afspraak uit:\s*/i, '')), 90);
  if (wat.length < 8 || titel.length < 3) return { v: 'nee' };   // ja zonder te zeggen wat het is: geen kaart
  return { v: 'ja', wat, titel };
}

/* kandidaten(regels, vandaag, o) → [{ sleutel, ids, dag, begin, eind, hele_dag, onderwerp, soort, stuk_pad }] — puur. */
function kandidaten(regels, vandaag, o) {
  o = Object.assign({}, STANDAARD, o || {});
  const van = plusDagen(vandaag, 1), tot = plusDagen(vandaag, o.dagen);
  const per = new Map();
  for (const r of Array.isArray(regels) ? regels : []) {
    if (!r || !Number.isSafeInteger(Number(r.id)) || typeof r.van !== 'string') continue;
    if (r.precisie !== 'dag' && r.precisie !== 'minuut') continue;
    if (r.van < van || r.van > tot) continue;
    if (r.nu_in) continue;                         // lijkt al in je agenda of Deadlines: geen potlood
    if (!stukLink(r.stuk_pad)) continue;           // review MOET 1: bron verplicht; zonder vindbaar stuk geen potlood
    const onderwerp = kort(r.onderwerp || r.titel, 120);
    if (!onderwerp) continue;
    const heleDag = r.hele_dag !== false || !/^\d{2}:\d{2}$/.test(r.begin || '');
    const begin = heleDag ? null : r.begin;
    const sleutel = sha(r.van + '|' + (begin || '') + '|' + onderwerp.toLowerCase());
    const x = per.get(sleutel);
    if (x) { x.ids.push(Number(r.id)); if (!x.stuk_pad && r.stuk_pad) x.stuk_pad = r.stuk_pad; if (r.regel) x.bronregels.push(String(r.regel)); if (!x.zin && r.zin) x.zin = r.zin; continue; }
    per.set(sleutel, { sleutel, ids: [Number(r.id)], dag: r.van, begin, eind: heleDag ? null : (/^\d{2}:\d{2}$/.test(r.eind || '') && r.eind > begin ? r.eind : null),
      hele_dag: heleDag, onderwerp, soort: r.soort === 'deadline' ? 'deadline' : 'afspraak', stuk_pad: r.stuk_pad || null,
      bronregels: r.regel ? [String(r.regel)] : [], zin: r.zin && typeof r.zin === 'object' ? r.zin : null });
  }
  return Array.from(per.values()).sort((a, b) => (a.dag < b.dag ? -1 : a.dag > b.dag ? 1 : 0) || String(a.begin || '').localeCompare(String(b.begin || '')));
}

/* verzoeken(k, proef, oo) → { potlood, kaart }: de twee luikaanroepen voor één kandidaat (zonder secret) — puur. oo = modeloordeel { titel, wat }. */
function verzoeken(k, proef, oo) {
  const start = k.hele_dag ? k.dag : k.dag + 'T' + k.begin;
  const eind = k.hele_dag ? plusDagen(k.dag, 1) : (k.eind ? k.dag + 'T' + k.eind : plusUur(k.dag, k.begin));
  const naam = (k.soort === 'deadline' ? 'Deadline: ' : '') + kort(zonderRe(oo && oo.titel ? oo.titel : k.onderwerp), 120);
  const wat = oo && oo.wat ? kort(oo.wat, 240) : '';
  const link = stukLink(k.stuk_pad);
  const hagro = isHagro(k.stuk_pad);
  const regels = (wat ? [wat] : []).concat(['Potlood van Socev: dit staat nog niet in je agenda.',
    'Overnemen: druk op ✅ op de kaart "Bevestig in je agenda" in de Socev-app.',
    'Klopt niet: haal deze afspraak hier weg; dan komt hij niet terug.']);
  if (!k.hele_dag && !k.eind) regels.push('Eindtijd stond er niet bij: 1 uur aangenomen.');
  if (link) regels.push('Stuk: ' + link);
  const potlood = { actie: 'socev_plaatsen', titel: kort((proef ? PROEF : '') + MARK + naam, 200), start, eind,
    omschrijving: regels.join('\n').slice(0, 800), aanleiding: 'potlood wv3741', sta_overlap_toe: true };
  const kaart = { actie: 'david_plaatsen', kaart: true, agenda: proef ? 'proef' : (hagro ? 'hagro' : 'hoofd'),
    titel: kort((proef ? PROEF : '') + naam, 200), start, eind, aanleiding: 'potlood wv3741 (Socev vond dit; jouw ✅ zet het in je agenda)' };
  if (proef) kaart.test = true;
  // HAGRO is gedeeld: alleen een link naar een HAGRO-stuk (n8n weigert al het andere); proef: omschrijving alleen in de proefagenda
  // wv3978: de wat-zin staat op de kaart (en in Davids afspraak); in de gedeelde HAGRO-agenda alleen de stuklink
  const om = (wat && !hagro ? [wat] : []).concat(link ? ['Stuk: ' + link] : []).join('\n');
  if (om) kaart.omschrijving = om.slice(0, 800);
  return { potlood, kaart };
}

// ── wv3813: blokken ──────────────────────────────────────────────────────────────────────────────────────────
function klokAms(ms) { return new Date(ms).toLocaleTimeString('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
function wd(dag) { return WD[new Date(dag + 'T12:00:00Z').getUTCDay()]; }
function vorigeWerkdag(dag) { let d = plusDagen(dag, -1); while (new Date(d + 'T12:00:00Z').getUTCDay() % 6 === 0) d = plusDagen(d, -1); return d; }
function hoofd(p) { return String(p).replace(/(^|\s)\S/g, (c) => c.toUpperCase()); }
// eerste app-stuklink in een omschrijving, alleen als hij weer een geldige stukLink oplevert (gecontroleerde verwijzing, MOET 1)
function linkUit(t) {
  const m = /https:\/\/app\.socev\.dev\/([^\s"'<>)\]]+)/.exec(String(t || ''));
  if (!m) return null;
  let pad;
  try { pad = m[1].split('/').map(decodeURIComponent).join('/'); } catch (e) { return null; }
  return stukLink(pad);
}

/* afspraken(events, van, tot, o) → [{ kal, a, b, dag, begin, plaats, link, titel }] — puur; alleen met tijd, David/Werk/HAGRO, geen eigen ✏️. */
function afspraken(events, van, tot, o) {
  const uit = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.status === 'cancelled' || BLOK_KAL.indexOf(e.kalender) < 0 || e.hele_dag === true) continue;
    if (typeof e.start !== 'string' || e.start.indexOf('T') < 0) continue;
    const t = String(e.titel || '');
    if (t.indexOf(MARK) >= 0) continue;
    const a = Date.parse(e.start), b = Date.parse(e.einde || e.start);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const dag = dagAms(a);
    if (dag < van || dag > tot) continue;
    uit.push({ kal: e.kalender, a, b: b > a ? b : a, dag, begin: klokAms(a), plaats: N ? N.plaatsVan(e.locatie || '') : null, link: linkUit(e.omschrijving), titel: kort(t, 80) });
  }
  return uit.sort((x, y) => x.a - y.a);
}

/*
 * blokken(afs, potloden, vandaag, o) → Map(sleutel → { t, dag, adag, start, eind, titel, omschrijving }) — puur.
 * potloden: kandidaten() van de actieve potloden (onderwerp, begin, stuk_pad, soort).
 */
function blokken(afs, potloden, vandaag, o) {
  o = Object.assign({}, STANDAARD, o || {});
  const pre = (o.proef ? PROEF : '') + MARK;
  const van = plusDagen(vandaag, 1), tot = plusDagen(vandaag, o.blokDagen);
  const uit = new Map();
  const weg = 'Klopt niet: haal dit blok hier weg; dan komt het niet terug.';
  // vertrek
  for (const x of N ? afs : []) {
    if (!x.plaats || x.dag < van || x.dag > tot) continue;
    const vorige = afs.filter((y) => y !== x && y.dag === x.dag && y.b <= x.a && x.a - y.b <= o.vorigeMaxMin * 60000 && y.plaats).sort((p, q) => q.b - p.b)[0];
    const vanaf = vorige ? vorige.plaats : o.thuis;
    if (!vanaf || vanaf === x.plaats) continue;
    const rm = N.reisMin(vanaf, x.plaats);
    if (!(rm >= o.minReis)) continue;
    const v = Math.floor((x.a - rm * 60000) / 300000) * 300000;
    if (dagAms(v) !== x.dag) continue;
    const sl = sha('v|' + x.dag + '|' + x.begin + '|' + x.plaats + '|' + vanaf + '|' + rm);
    uit.set(sl, { t: 'v', dag: x.dag, adag: x.dag, start: x.dag + 'T' + klokAms(v), eind: x.dag + 'T' + x.begin,
      titel: kort(pre + 'Vertrek naar ' + hoofd(x.plaats) + ' (± ' + rm + ' min)', 200),
      omschrijving: ['Potlood van Socev: vertrektijd voor je afspraak van ' + x.begin + ' in ' + hoofd(x.plaats) + '.',
        'Reistijd geschat (hemelsbreed, zonder verkeer) vanaf ' + (vorige ? 'je vorige afspraak in ' + hoofd(vanaf) : 'thuis (' + hoofd(vanaf) + ')') + '.', weg].join('\n') });
  }
  // voorbereiden: HAGRO-afspraak, afspraak met app-stuklink, of vergader-potlood met stuk onder 10_Zakelijk/
  const voor = [];
  for (const x of afs) {
    if (x.kal === 'HAGRO') voor.push({ adag: x.dag, begin: x.begin, titel: x.titel, link: x.link });
    else if (x.link) voor.push({ adag: x.dag, begin: x.begin, titel: null, link: x.link });   // MOET 1: geen David/Werk-titel in een blok
  }
  for (const k of Array.isArray(potloden) ? potloden : []) {
    if (!k || k.soort !== 'afspraak' || !k.begin || typeof k.stuk_pad !== 'string' || k.stuk_pad.indexOf('10_Zakelijk/') !== 0 || !VERGADER.test(k.onderwerp || '')) continue;
    voor.push({ adag: k.dag, begin: k.begin, titel: kort(k.onderwerp, 80), link: stukLink(k.stuk_pad) });
  }
  for (const x of voor) {
    if (x.adag < van || x.adag > tot) continue;
    const dag = vorigeWerkdag(x.adag);
    if (dag < vandaag) continue;
    const sl = sha('b|' + x.adag + '|' + x.begin);
    if (uit.has(sl)) { const y = uit.get(sl); if (!y.link && x.link) { y.link = x.link; } continue; }
    const wanneer = wd(x.adag) + ' ' + x.adag.slice(8, 10) + '-' + x.adag.slice(5, 7) + ' ' + x.begin;
    uit.set(sl, { t: 'b', dag, adag: x.adag, start: dag, eind: plusDagen(dag, 1), link: x.link,
      titel: kort(pre + 'Voorbereiden: ' + (x.titel ? x.titel + ' (' + wd(x.adag) + ' ' + x.begin + ')' : 'afspraak van ' + wanneer), 200), wanneer });
  }
  for (const y of uit.values()) {
    if (y.t !== 'b') continue;
    y.omschrijving = ['Potlood van Socev: voorbereiden voor je afspraak van ' + y.wanneer + '.'].concat(y.link ? ['Stuk: ' + y.link] : [], [weg]).join('\n');
    delete y.wanneer; delete y.link;
  }
  return uit;
}

/* afwijsFilters(ids) → n8n-filters (type or, ≤ 20 per filter) voor socev_agenda_log op correlatie_id (ZOU 1: gericht zoeken). */
function afwijsFilters(ids) {
  const u = Array.from(new Set((Array.isArray(ids) ? ids : []).filter((c) => CORR.test(String(c)))));
  const f = [];
  for (let i = 0; i < u.length; i += 20) f.push({ type: 'or', filters: u.slice(i, i + 20).map((c) => ({ columnName: 'correlatie_id', condition: 'eq', value: c })) });
  return f;
}

function leesStaat(p) {
  try { const s = JSON.parse(fs.readFileSync(p, 'utf8')); if (s && typeof s === 'object' && s.items && typeof s.items === 'object') return s; } catch (e) { /* nieuw */ }
  return { versie: 1, items: {}, dagen: {} };
}
function schrijfStaat(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

/*
 * maak({ gevonden(nu) → {ok, regels}, luik(body) → antwoord, oordeel(id, 'klopt_niet') → {status}, staatPad, proef, log, …STANDAARD })
 * → { ronde({nu}) → samenvatting, info() }
 */
function maak(o) {
  o = Object.assign({}, STANDAARD, o || {});
  const log = typeof o.log === 'function' ? o.log : function () {};
  const mark = (o.proef ? PROEF : '') + MARK;
  let laatste = null, bezig = false;

  async function ronde(arg) {
    if (bezig) return { ok: true, overgeslagen: 'bezig' };
    bezig = true;
    try { return await ronde2(arg); } finally { bezig = false; }
  }
  async function ronde2(arg) {
    const nu = arg && Number.isFinite(arg.nu) ? arg.nu : Date.now();
    const vandaag = dagAms(nu);
    if (!o.proef && !registerAan(o.registerPad || '/opt/data/mk-scripts/toestemmingen.json')) {
      laatste = { op: new Date(nu).toISOString(), ok: true, register: 'uit' };
      return laatste;
    }
    const s = leesStaat(o.staatPad);
    s.dagen = s.dagen && typeof s.dagen === 'object' ? s.dagen : {};
    for (const d of Object.keys(s.dagen)) if (d < plusDagen(vandaag, -14)) delete s.dagen[d];
    // wv3978: onthouden oordelen (alleen v/r/dag/p, geen titels); voorbij = weg
    s.oordeel = s.oordeel && typeof s.oordeel === 'object' ? s.oordeel : {};
    for (const [sl, x] of Object.entries(s.oordeel)) if (!x || typeof x !== 'object' || !(x.dag >= vandaag)) delete s.oordeel[sl];
    const tel = { nieuw: 0, weg: 0, overgenomen: 0, verlopen: 0, kaart: 0, kaart_fout: 0, fout: 0, mutaties: 0, afgewezen: 0, blok_nieuw: 0, blok_weg: 0, blok_vervallen: 0,
      niet_david: 0, model: 0, model_fout: 0 };
    const uit = (x) => { laatste = Object.assign({ op: new Date(nu).toISOString() }, x); log(laatste); return laatste; };

    // 1. lezen, fail-closed
    let g, lijst;
    try { g = await o.gevonden(nu); } catch (e) { return uit({ ok: false, fout: 'vondsten niet leesbaar' }); }
    if (!g || g.ok !== true || !Array.isArray(g.regels)) return uit({ ok: false, fout: 'vondsten niet leesbaar' });
    try { lijst = await o.luik({ actie: 'socev_lijst', van: vandaag, dagen: o.dagen + 15 }); } catch (e) { return uit({ ok: false, fout: 'socev-kalender niet leesbaar' }); }
    if (!lijst || lijst.ok !== true || !Array.isArray(lijst.events)) return uit({ ok: false, fout: 'socev-kalender niet leesbaar' });
    const inKal = new Map(lijst.events.map((e) => [String(e.event_id), e]));
    const perId = new Map(g.regels.map((r) => [Number(r.id), r]));
    const magMuteren = () => tel.mutaties < o.mutatiesRonde;
    const regPad = o.registerPad || '/opt/data/mk-scripts/toestemmingen.json';
    // wv3813: Davids agenda (alleen lezen) voor de blokken; fail-closed: zonder geslaagde lezing geen enkele blokactie
    let afs = null;
    const blokAan = !!(N && typeof o.agenda === 'function' && (o.proef || registerAan(regPad, BLOK_RIJ)));
    if (blokAan) {
      let a = null;
      try { a = await o.agenda({ actie: 'agenda', start: vandaag, end: plusDagen(vandaag, o.blokDagen + 1), met_hagro: true }); } catch (e) { a = null; }
      if (a && Array.isArray(a.events) && !a.fout && !(Array.isArray(a.fouten) && a.fouten.length)) afs = afspraken(a.events, plusDagen(vandaag, 1), plusDagen(vandaag, o.blokDagen), o);
      else tel.agenda_fout = 1;
    }

    // 1b. wv3813: ❌ op de kaart = klopt niet (gericht op de open correlatie-id's; leesfout = overslaan, geen conclusie)
    const open = Object.values(s.items).filter((it) => it.s === 'potlood' && Array.isArray(it.kc) && it.kc.length);
    if (open.length && typeof o.afwijzingen === 'function') {
      let set = null;
      try { set = await o.afwijzingen(afwijsFilters([].concat.apply([], open.map((it) => it.kc)))); } catch (e) { set = null; }
      if (!(set instanceof Set)) tel.afwijs_fout = 1;
      else for (const it of open) {
        if (!it.kc.some((c) => set.has(c))) continue;
        const ev = inKal.get(String(it.ev));
        if (!ev || String(ev.titel || '').indexOf(mark) !== 0) continue;   // niet meer in de kalender: het opruimen hieronder doet weg + klopt_niet
        if (!magMuteren()) break;
        tel.mutaties++;
        let a = null;
        try { a = await o.luik({ actie: 'socev_verwijderen', event_id: String(it.ev), aanleiding: 'potlood wv3813: David koos Niet doen (klopt niet)' }); } catch (e) { a = null; }
        if (!a || a.ok !== true) { tel.fout++; continue; }
        it.s = 'weg'; it.r = 'afgewezen'; it.op = vandaag; tel.afgewezen++;
        for (const id of it.ids || []) { try { await o.oordeel(id, 'klopt_niet'); } catch (e) { tel.fout++; } }
      }
    }

    // wv3978: is David zelf de deelnemer? Harde regels, dan één modelvraag; fail-closed. → { v: 'ja', wat, titel } | null (niet nu / nee)
    let modelStop = false;
    async function beoordeel(k) {
      const o0 = s.oordeel[k.sleutel];
      if (o0 && o0.v === 'nee') return null;
      let tekst = null;
      try { tekst = typeof o.lees === 'function' && k.stuk_pad ? o.lees(k.stuk_pad) : null; } catch (e) { tekst = null; }
      if (typeof tekst !== 'string' || !tekst) tekst = null;
      const hard = nietVoorDavid(k, tekst);
      if (hard) { s.oordeel[k.sleutel] = { v: 'nee', r: hard, dag: k.dag, op: vandaag }; tel.niet_david++; return null; }
      if (!tekst || typeof o.model !== 'function') { tel.model_fout++; return null; }
      // hooguit 6 vragen per ronde; na een modelfout (storing, abonnement vol) deze ronde geen vragen meer: zo wordt een storing nooit een rij nee's
      if (tel.model >= (o.modelRonde || MODEL_RONDE) || modelStop) return null;
      tel.model++;
      let a = null;
      try { a = await o.model(MODEL_SYSTEEM, modelPrompt(k, tekst), MODEL_SCHEMA); } catch (e) { a = null; }
      const u = modelUit(a);
      if (!u) {
        tel.model_fout++; modelStop = true;
        const p = ((o0 && o0.p) || 0) + 1;
        s.oordeel[k.sleutel] = p >= MODEL_POGINGEN ? { v: 'nee', r: 'model', dag: k.dag, op: vandaag } : { v: 'open', p, dag: k.dag, op: vandaag };
        return null;
      }
      if (u.v !== 'ja') { s.oordeel[k.sleutel] = { v: 'nee', r: 'model_nee', dag: k.dag, op: vandaag }; tel.niet_david++; return null; }
      delete s.oordeel[k.sleutel];
      return u;
    }

    // 2. opruimen
    for (const [sl, it] of Object.entries(s.items)) {
      if (it.s !== 'potlood') continue;
      if (it.dag < vandaag) { it.s = 'verlopen'; it.op = vandaag; tel.verlopen++; continue; }
      const ev = inKal.get(String(it.ev));
      if (!ev) {
        if (it.dag > plusDagen(vandaag, o.dagen + 15)) continue;   // buiten het leesvenster: niets concluderen
        it.s = 'weg'; it.op = vandaag; tel.weg++;
        for (const id of it.ids || []) {
          try { await o.oordeel(id, 'klopt_niet'); } catch (e) { tel.fout++; }
        }
        continue;
      }
      const rs = (it.ids || []).map((id) => perId.get(Number(id))).filter(Boolean);
      // review MOET 2: alleen weghalen als de afspraak nu echt in Davids agenda lijkt te staan (spiegel van vannacht, nu_in);
      // een vondst die uit de lijst verdween bewijst niets: dan blijft het potlood tot de dag voorbij is of David hem weghaalt
      const inAgenda = rs.length > 0 && rs.every((r) => r.nu_in === 'agenda');
      if (inAgenda && magMuteren() && String(ev.titel || '').indexOf(mark) === 0) {
        tel.mutaties++;
        let a = null;
        try { a = await o.luik({ actie: 'socev_verwijderen', event_id: String(it.ev), aanleiding: 'potlood wv3741: staat nu in je agenda' }); } catch (e) { a = null; }
        if (a && a.ok === true) { it.s = 'overgenomen'; it.op = vandaag; tel.overgenomen++; } else tel.fout++;
        continue;
      }
      // kaart nog niet gelukt: nog een poging met de gegevens van nu
      if (!it.kaart && (it.kp || 0) < o.kaartPogingen && rs.length && magMuteren()) {
        const k = kandidaten(rs.map((r) => Object.assign({}, r, { nu_in: null })), plusDagen(it.dag, -1), { dagen: 1 })[0];
        const oo = k ? await beoordeel(k) : null;   // wv3978: ook de herkansing alleen met een ja (en met de wat-zin)
        if (k && oo) {
          tel.mutaties++; it.kp = (it.kp || 0) + 1;
          let a = null;
          try { a = await o.luik(verzoeken(k, o.proef, oo).kaart); } catch (e) { a = null; }
          if (a && a.knop_verstuurd === true) { it.kaart = true; tel.kaart++; if (CORR.test(String(a.correlatie_id || ''))) it.kc = (it.kc || []).concat([String(a.correlatie_id)]); } else tel.kaart_fout++;
        }
      }
    }

    // 3. nieuw
    const actief = Object.values(s.items).filter((x) => x.s === 'potlood' || x.s === 'blok').length;
    let ruimte = Math.min(o.plafondDag - (s.dagen[vandaag] || 0), o.maxActief - actief);
    // wv4134: kandidaten waarvoor David op de Intake-kaart al koos (agenda, Deadlines of Nee) krijgen geen potlood; onleesbaar = geen nieuwe potloden
    let intakeGekozen = new Set();
    if (typeof o.overslaan === 'function') { try { intakeGekozen = o.overslaan(); } catch (e) { intakeGekozen = null; } }
    for (const k of intakeGekozen ? kandidaten(g.regels, vandaag, o) : []) {
      if (ruimte <= 0 || tel.mutaties + 2 > o.mutatiesRonde) break;
      if (s.items[k.sleutel]) continue;            // ooit gezet (ook weggehaald of verlopen): nooit opnieuw
      if ((k.ids || []).some((x) => intakeGekozen.has(Number(x)))) continue;
      const oo = await beoordeel(k);               // wv3978: alleen als David zelf de deelnemer is
      if (!oo) continue;
      const v = verzoeken(k, o.proef, oo);
      tel.mutaties++;
      let a = null;
      try { a = await o.luik(v.potlood); } catch (e) { a = null; }
      if (!a || a.ok !== true || !a.event_id) { tel.fout++; continue; }   // volgende ronde nog eens (sleutel niet vastgelegd)
      if (a.dubbel === true) { tel.fout++; continue; }                   // een gelijk event zonder registerregel: niet het onze maken
      s.items[k.sleutel] = { s: 'potlood', ev: String(a.event_id), ids: k.ids, dag: k.dag, kaart: false, kp: 1, op: vandaag };
      s.dagen[vandaag] = (s.dagen[vandaag] || 0) + 1;
      ruimte--; tel.nieuw++;
      schrijfStaat(o.staatPad, s);                 // na elke plaatsing: een crash maakt nooit een tweede potlood
      tel.mutaties++;
      let b = null;
      try { b = await o.luik(v.kaart); } catch (e) { b = null; }
      if (b && b.knop_verstuurd === true) {
        s.items[k.sleutel].kaart = true; tel.kaart++;
        if (CORR.test(String(b.correlatie_id || ''))) s.items[k.sleutel].kc = [String(b.correlatie_id)];   // wv3813: voor ❌ = klopt niet
      } else tel.kaart_fout++;
    }

    // 4. wv3813: blokken (alleen na een geslaagde agendalezing)
    if (afs) {
      const pot = [];
      for (const it of Object.values(s.items)) {
        if (it.s !== 'potlood') continue;
        const rs = (it.ids || []).map((id) => perId.get(Number(id))).filter(Boolean);
        const k = rs.length ? kandidaten(rs.map((r) => Object.assign({}, r, { nu_in: null })), plusDagen(it.dag, -1), { dagen: 1 })[0] : null;
        if (k) pot.push(k);
      }
      const gewenst = blokken(afs, pot, vandaag, o);
      for (const [sl, it] of Object.entries(s.items)) {
        if (it.s !== 'blok') continue;
        if (it.adag < vandaag || it.dag < vandaag) { it.s = 'verlopen'; it.op = vandaag; tel.verlopen++; continue; }
        if (it.adag === vandaag) continue;                         // buiten het venster van de wens: laten staan
        const ev = inKal.get(String(it.ev));
        if (!ev) { it.s = 'weg'; it.op = vandaag; tel.blok_weg++; continue; }   // David haalde het weg: komt nooit terug
        if (gewenst.has(sl) || !magMuteren() || String(ev.titel || '').indexOf(mark) !== 0) continue;
        tel.mutaties++;
        let a = null;
        try { a = await o.luik({ actie: 'socev_verwijderen', event_id: String(it.ev), aanleiding: 'potlood wv3813: afspraak weg of verplaatst' }); } catch (e) { a = null; }
        if (a && a.ok === true) { it.s = 'vervallen'; it.op = vandaag; tel.blok_vervallen++; } else tel.fout++;
      }
      const lijstB = Array.from(gewenst.entries()).sort((x, y) => (x[1].start < y[1].start ? -1 : x[1].start > y[1].start ? 1 : 0));
      const actiefB = Object.values(s.items).filter((x) => x.s === 'potlood' || x.s === 'blok').length;
      ruimte = Math.min(o.plafondDag - (s.dagen[vandaag] || 0), o.maxActief - actiefB);
      for (const [sl, b] of lijstB) {
        if (ruimte <= 0 || !magMuteren()) break;
        if (s.items[sl] && s.items[sl].s !== 'vervallen') continue;   // staat al, of weggehaald/verlopen: nooit opnieuw
        tel.mutaties++;
        let a = null;
        try { a = await o.luik({ actie: 'socev_plaatsen', titel: b.titel, start: b.start, eind: b.eind, omschrijving: b.omschrijving.slice(0, 800),
          aanleiding: 'potlood wv3813 (' + (b.t === 'v' ? 'vertrek' : 'voorbereiden') + ')', sta_overlap_toe: true }); } catch (e) { a = null; }
        if (!a || a.ok !== true || !a.event_id || a.dubbel === true) { tel.fout++; continue; }
        s.items[sl] = { s: 'blok', t: b.t, ev: String(a.event_id), dag: b.dag, adag: b.adag, op: vandaag };
        s.dagen[vandaag] = (s.dagen[vandaag] || 0) + 1;
        ruimte--; tel.blok_nieuw++;
        schrijfStaat(o.staatPad, s);
      }
    }
    s.laatste = { op: new Date(nu).toISOString(), tel };
    schrijfStaat(o.staatPad, s);
    const st = { potlood: 0, weg: 0, overgenomen: 0, verlopen: 0, blok: 0, vervallen: 0, afgewezen: 0 };
    for (const x of Object.values(s.items)) { if (st[x.s] !== undefined) st[x.s]++; if (x.r === 'afgewezen') st.afgewezen++; }
    return uit(Object.assign({ ok: tel.fout === 0, vandaag: s.dagen[vandaag] || 0, plafond: o.plafondDag }, tel, { stand: st }));
  }
  function vandaagVol(nu) {
    const s = leesStaat(o.staatPad);
    return ((s.dagen || {})[dagAms(nu)] || 0) >= o.plafondDag;
  }
  function info() { return Object.assign({ aan: true, proef: !!o.proef, blokken: !!(N && typeof o.agenda === 'function' && (o.proef || registerAan(o.registerPad || '/opt/data/mk-scripts/toestemmingen.json', BLOK_RIJ))) }, laatste ? { laatste } : {}); }
  return { ronde, info, vandaagVol };
}

module.exports = { maak, kandidaten, verzoeken, stukLink, registerAan, afspraken, blokken, afwijsFilters, linkUit, nietVoorDavid, modelPrompt, modelUit, zonderRe, MODEL_SYSTEEM, MODEL_SCHEMA,
  MARK, PROEF, STANDAARD, REGISTER_RIJ, BLOK_RIJ };
