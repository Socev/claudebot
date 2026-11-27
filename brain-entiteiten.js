'use strict';
// Brain › Entiteiten & Personen (wv1734, OVIS M5; ontwerplijnen § 7, Intake-bouwplan § 4). Alleen lezen.
// Eén lijst uit het OVIS-register (secondbrain.knoop + knoop_handvat via de bestaande RPC public.ovis_register_lees, de compiler is de
// schrijver), per regel de pagina (de markdown uit de vault) en het blok "Wat OVIS weet": herkenningskenmerken met hun status, facturen
// uit de Facturen-app (alleen telling en de laatste), deadlines en per persoon het Dossier (bestanden die bij die persoon horen).
// wv1930 (bouwplan "Geen afscherming naar David", 29-10-2026, stap A; David 28-10 18:02 "Je moet NIETS voor mij afschermen. Ik ben de
// enige gebruiker hier."): alles voor David, niets naar derden. Dus: medewerkers met hun hele pagina, kenmerken, deadlines (ook HR) en
// Dossier; privépersonen uit 20_Prive (Familie, Gambia/Personen, Shizzle, Relaties) rechtstreeks uit de vault in de groep "prive", zonder
// registerwijziging; de stamboom (± 1080 pagina's) alleen als zoekresultaat; rekeningnummers onverkort en het gegenereerde blok op de
// pagina; Wat OVIS weet ook aan de privékant. Wat blijft: het sleutelmasker (grondwet 2) op alle tekst. De oude vaste-plekschakelaar
// (wv1901) en zijn takken zijn weg sinds wv3446: elk apparaat ziet hetzelfde.
// wv1771 (OVIS plek 7 fase B): bij een persoon met een Google-koppeling de mailadressen en telefoonnummers uit dat Google-contact
// (RPC public.ovis_personen_lees). wv1948 (stap C, E6): ook adressen en verjaardag (migratie knoop/0006), en ook bij een koppeling die nog
// op Davids Ja wacht — met voorgesteld: true, zodat de app het zo labelt. Dat is tonen aan David, geen kenmerk: de mailrouter gebruikt
// de koppeling pas na zijn Ja.
const path = require('path');
const crypto = require('crypto');

const CACHE_MS = 60000;
const PAGINA_RE = /^(10_Zakelijk|20_Prive)\/(?:[^/\0]+\/)*[^/\0]+\.md$/;
const MAX_TEKST = 60000;
const GOOGLE_RE = /^people\/c[0-9]{1,30}$/;
// "+31 6 1234 5678" → "0612345678"; buitenland "+220 …" → "00220…" (zelfde normaalvorm als het register)
function telNl(w) {
  let s = String(w == null ? '' : w).split('(0)').join('').replace(/[^0-9+]/g, '');
  if (s.charAt(0) === '+') s = '00' + s.slice(1);
  if (s.indexOf('0031') === 0) s = '0' + s.slice(4);
  return s;
}

// rol → groep in het filter (ontwerplijnen § 7: eigen · leverancier · instantie · praktijk · persoon)
const GROEP = { eigen: 'eigen', leverancier: 'leverancier', instantie: 'instantie', bank: 'instantie', verzekeraar: 'instantie',
  praktijk: 'praktijk', zorgpartner: 'praktijk', afzender: 'afzender', persoon: 'persoon' };
const ROL_WOORD = { eigen: 'eigen entiteit', leverancier: 'leverancier', instantie: 'instantie', bank: 'bank', verzekeraar: 'verzekeraar',
  praktijk: 'praktijk', zorgpartner: 'zorgpartner', afzender: 'afzender', persoon: 'persoon' };
const HANDVAT_WOORD = { kvk: 'KvK', domein: 'domein', mail: 'mailadres', kenmerkpatroon: 'kenmerkpatroon', alias: 'ook bekend als',
  'niet-dezelfde-als': 'niet dezelfde als', telefoon: 'telefoonnummer', whatsapp: 'WhatsApp', signal: 'Signal', google: 'Google-contact' };   // wv1011
const STATUS_WOORD = { actief: 'actief', voorgesteld: 'wacht op je Ja', vervallen: 'vervallen' };

// Sleutel voor de detailroute: de pod staat alleen /app/[a-z0-9/-]{1,64} toe en een knoop-id draagt hoofdletters en ':' (tot 57 tekens).
// Een privépersoon uit de vault (geen knoop) krijgt de sleutel van zijn pad: sleutelVan(pad).
function sleutelVan(id) { return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 12); }
function isPersoon(k) { return k.soort === 'persoon' || /^per:/.test(String(k.id)); }
function isEigen(k) { return k.rol === 'eigen' || k.soort === 'entiteit'; }
// Privékant: pagina of vault_pad onder 20_Prive, de entiteit PRIVE zelf, of alleen voor PRIVE (diffreview ZOU 7)
function priveKant(k) {
  const voor = Array.isArray(k.voor) ? k.voor : [];
  return String(k.vault_pagina || '').indexOf('20_Prive/') === 0 || String(k.vault_pad || '').indexOf('20_Prive/') === 0 || k.id === 'PRIVE' ||
    (voor.length > 0 && voor.every(function (c) { return c === 'PRIVE'; }));
}
// wv1930: elke actieve knoop is zichtbaar, op elk apparaat (de vaste-plektak van wv1901 is weg sinds wv3446).
function zichtbaar(k) {
  return !!k && k.actief !== false;
}
function groepVan(k) { return isPersoon(k) ? 'persoon' : (GROEP[k.rol] || (isEigen(k) ? 'eigen' : 'leverancier')); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
// Woorden voor naamvergelijking: zonder accenten, kleine letters, alles wat geen letter of cijfer is een spatie ("K. Verzonnen" → "k verzonnen")
function woorden(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function geenMasker(t) { return String(t == null ? '' : t); }

// Frontmatter: de ruwe tekst tussen de eerste twee ---regels ('' als die er niet is)
function frontmatter(ruw) {
  const t = String(ruw).replace(/\r\n?/g, '\n');
  if (t.indexOf('---\n') !== 0) return '';
  const e = t.indexOf('\n---', 4);
  return e > 0 ? t.slice(4, e + 1) : '';
}
function fmVeld(fm, veld) {
  const m = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm);
  return m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : '';
}
// aliases als ["a", "b"] of als lijst met - a
function fmAliassen(fm) {
  const m = /^aliases:[ \t]*(.*)$/m.exec(fm);
  if (!m) return [];
  let stukken = [];
  if (/^\[/.test(m[1].trim())) stukken = m[1].trim().replace(/^\[|\]$/g, '').split(',');
  else if (!m[1].trim()) {
    const na = fm.slice(m.index + m[0].length + 1).split('\n');
    for (const r of na) { const x = /^\s+-\s*(.*)$/.exec(r); if (!x) break; stukken.push(x[1]); }
  } else stukken = [m[1]];
  return stukken.map(function (x) { return String(x).trim().replace(/^["']|["']$/g, '').trim(); }).filter(function (x) { return x && x.length <= 80; }).slice(0, 20);
}

// Pagina: frontmatter eraf (de stamgegevens komen uit het register), de markeringen van het gegenereerde blok eraf (de inhoud blijft,
// wv1930), wikilinks als gewone tekst, het sleutelmasker erover. Geen IBAN-masker en geen weggelaten blok meer (vaste-plektak weg, wv3446).
function paginaTekst(ruw, opties) {
  const o = opties && typeof opties === 'object' ? opties : {};
  const masker = typeof o.masker === 'function' ? o.masker : geenMasker;
  let t = String(ruw).replace(/\r\n?/g, '\n');
  if (t.indexOf('---\n') === 0) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1 || t.length); }
  t = t.replace(/<!-- ovis:blok (?:begin|eind)[^>]*-->\n?/g, '');
  // wv3938 (3C50): met opties.link (doel → vol vaultpad of null) blijft een wikilink naar een bestaande pagina staan als [[vol pad|tekst]]
  // (de app maakt er een tikbare link van; een partij opent haar kaart); onbekend doel en ![[insluiting]] worden gewone tekst, zoals eerder.
  const link = typeof o.link === 'function' ? o.link : null;
  const plat = function (p) { const n = String(p).split('#')[0].split('/').pop().replace(/\.md$/, ''); return n || String(p).split('#').slice(1).join('#').trim(); };   // [[#Kop]] = de kopnaam (review ZOU 3)
  t = t.replace(/(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, function (m, uit, doel, tekst) {
    const lab = tekst != null ? tekst : plat(doel);
    if (uit || !link) return lab;
    const vol = link(doel);
    return vol ? '[[' + vol + '|' + String(lab).replace(/[|[\]]/g, ' ').trim() + ']]' : lab;
  });
  t = masker(t);
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEKST ? t.slice(0, MAX_TEKST) + '\n\n…' : t;
}

// ── Privépersonen en Dossier (wv1930) ──
// Persoonspagina's onder deze mappen (recursief, alleen type persoon/familie/vriend/contact); de stamboom apart, alleen bij zoeken
const PRIVE_MAPPEN = [['20_Prive/Familie/', 'familie'], ['20_Prive/Gambia/Personen/', 'Gambia'], ['20_Prive/Shizzle/', 'Shizzle'], ['20_Prive/Relaties/', 'relatie']];
const STAMBOOM = '20_Prive/Familie/Stamboom/';
const PRIVE_TYPE = /^(persoon|familie|vriend|contact)$/i;
const DOSSIER_MAX = 60;
const ZOEK_MAX = 50;
// Namen waarop een bestand bij een persoon hoort: naam, naam zonder "(…)", aliassen; één woord alleen vanaf 4 letters (een roepnaam als alias)
function naamPatronen(namen) {
  const uit = new Set();
  namen.forEach(function (n) {
    [n, String(n || '').replace(/\s*\([^)]*\)\s*/g, ' ')].forEach(function (x) {
      const w = woorden(x);
      if (!w) return;
      if (w.indexOf(' ') > 0 ? w.length >= 4 : w.length >= 4 && !/^[0-9]+$/.test(w)) uit.add(w);
    });
  });
  return Array.from(uit);
}
function bevatNaam(tekst, patronen) {
  const t = ' ' + woorden(tekst) + ' ';
  return patronen.some(function (p) { return t.indexOf(' ' + p + ' ') >= 0; });
}
function stamVan(p) { return String(p).split('/').pop().replace(/\.[^.\/]+$/, ''); }
// Datum van een dossierstuk: uit de bestandsnaam (JJJJ-MM-DD, anders JJJJ), anders de wijzigingsdatum
function stukDatum(b) {
  const n = stamVan(b.p);
  const d = /(?:^|[^0-9])((?:19|20)[0-9]{2}-[01][0-9]-[0-3][0-9])(?![0-9])/.exec(n);
  if (d) return d[1];
  const j = /(?:^|[^0-9])((?:19|20)[0-9]{2})(?![0-9-])/.exec(n);
  if (j) return j[1];
  return typeof b.m === 'number' && isFinite(b.m) ? new Date(b.m).toISOString().slice(0, 10) : null;
}
// Wortel van de entiteit van een pagina: 10_Zakelijk/<map> of 20_Prive
function wortelVan(pagina) {
  const d = String(pagina || '').split('/');
  if (d[0] === '10_Zakelijk' && d.length > 2) return d[0] + '/' + d[1] + '/';
  if (d[0] === '20_Prive') return '20_Prive/';
  return null;
}

function leesSqlite(pad, sql, args) {
  const fs = require('fs');
  if (!pad || !fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 2000;'); return db.prepare(sql).all(...(args || [])); }
  finally { try { db.close(); } catch (e) { /* al dicht */ } }
}

// wv3298 (idee 35 meetpunt 3): bankposten per partij uit bank-partij.js; ontbreekt die module (terugrol), dan geen blok Bank.
const BANK_PARTIJ = (function () { try { return require('./bank-partij.js'); } catch (e) { return null; } })();
const BANK_CACHE_MS = 300000;

// ── wv3938 (besluitenpagina nr 322/345/350 = 3C22/3C45/3C50, David Ja 22-11-2026 18:18): stukken uit Intake, hoofdpagina, tegels ──
// Stukken: intake.sqlite (alleen lezen) › uitvoering (wat Intake waar neerlegde; doel = de code van de eigen entiteit) + stuk (onderwerp,
// ontvangen, bron). Bij een eigen entiteit op doel, bij een andere partij op het afzenderadres tegen haar kenmerken mailadres/domein.
// Niet gefilterd (Davids eigen scherm, wv3675). Een verwerkt stuk staat niet meer in raw_input: het pad komt dan uit het bronnenregister
// (Bronnen/_register.md: archiefnaam naast raw_input/<naam> of het stuk-id) of uit Bronnen/Intake/<naam>; niet terug te vinden = geen tik.
const STUK_TOON = 60;              // zoveel stukken gaan mee naar de app (de app toont er 8, "Alle N" de rest)
const STUK_CACHE_MS = 60000;
const STUK_NIEUW_DAGEN = 7;        // "nieuw" op de tegel
const DEADLINE_TEGEL_DAGEN = 30;   // deadlines op de tegel: vandaag t/m 30 dagen
const BEKEKEN_MAX = 20, BEKEKEN_TOON = 5;
const BRON_WOORD = { gmail: 'mail', outlook: 'Outlook', whatsapp: 'WhatsApp', signal: 'Signal', teams: 'Teams', scanner: 'scan', app: 'app', web: 'web', contacten: 'contacten' };
function bronWoord(b) { const k = String(b || '').split(':')[0]; return BRON_WOORD[k] || k || null; }
function adresVan(van) {
  const v = String(van || '');
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(v) || /([^\s<>"',;[\]]+@[^\s<>"',;[\]]+)/.exec(v);
  return m ? m[1].toLowerCase() : null;
}
function metaVan(t) { try { const j = JSON.parse(String(t || '{}')); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
// Bronnenregister → Map: 'bn:<naam in raw_input>' en 'sid:<stuk-id>' → vaultpad van het archiefstuk (eerste cel; "x.md + y.pdf" = x.md)
function registerIndex(tekst, wortel) {
  const uit = new Map();
  String(tekst || '').split('\n').forEach(function (r) {
    if (r.charAt(0) !== '|') return;
    const cel = r.replace(/^\|/, '').split('|')[0].trim().replace(/^`|`$/g, '');
    if (!cel || /^[-: ]+$/.test(cel)) return;
    const wl = /^\[\[([^\]|\\]+)/.exec(cel);
    let doel = wl ? wl[1].trim() : wortel + 'Bronnen/' + cel.split(' + ')[0].trim();
    if (wl && !/\.[a-z0-9]{2,5}$/i.test(doel)) doel += '.md';
    if (doel.split('/').indexOf('..') >= 0) return;
    const bn = /raw_input\/([^`|]+?)`/.exec(r), sid = /(stk_[0-9]{8}_[0-9a-f]{8})/.exec(r);
    if (bn && !uit.has('bn:' + bn[1].trim())) uit.set('bn:' + bn[1].trim(), doel);
    if (sid && !uit.has('sid:' + sid[1])) uit.set('sid:' + sid[1], doel);
  });
  return uit;
}
// Laatst bekeken: nieuwste eerst, elke sleutel één keer, hooguit BEKEKEN_MAX
function bekekenBij(lijst, sleutel, iso) {
  const l = (Array.isArray(lijst) ? lijst : []).filter(function (x) { return x && /^[0-9a-f]{12}$/.test(String(x.s)) && x.s !== sleutel; });
  return [{ s: sleutel, t: iso }].concat(l).slice(0, BEKEKEN_MAX);
}

// ── wv3945 (besluitenpagina nr 397/398 = 3C97/3C98, David Ja 22-11-2026 18:18/18:19): "Wat er gezegd is" en "Mensen" ──
// Gesprekken: de bijgehouden WhatsApp-/Teams-pagina's (…/Conversaties/*.md, elke nacht bijgewerkt) met datum (updated) en het eerste lopende
// onderwerp; bij een eigen entiteit die in haar map plus de laatste drie notulen (…/Notulen/, zonder Index en Agenda), bij een persoon de
// gesprekspagina's met zijn naam. Mensen: de medewerkerspagina's (type medewerker) in <entiteit>/Medewerkers/ met functie, status (in/uit
// dienst uit het statusveld, de bestandsnaam en einddatum), contracteinde en de eerstvolgende datum (deadline of geplande gespreksleidraad).
// Alleen lezen, niets gefilterd (Davids eigen scherm); het sleutelmasker (grondwet 2) blijft op alle tekst.
const GESPREK_MAX = 40, NOTULEN_TOON = 3, GEZEGD_CACHE_MS = 60000;
const UIT_DIENST_RE = /uit[ _-]?dienst|\boud(?:-|\s+)(?:waarnemer|medewerker|collega)|^oud\b(?!er)|gestopt|vertrokken|be[eë]indigd|overleden|archief/i;   // review MOET 1: 'Ouderschapsverlof' is in dienst
function amsDag(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
function isoUitNl(s) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s || '').trim());
  return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : null;
}
// Eerste punt onder "## Lopende onderwerpen": het vetgedrukte kopje, anders de tekst tot " — "; zonder opmaak, hooguit 160 tekens
function eersteOnderwerp(ruw) {
  const t = String(ruw || '').replace(/\r\n?/g, '\n');
  const i = t.search(/^## Lopende onderwerpen[^\n]*$/m);
  if (i < 0) return null;
  const deel = t.slice(i).split('\n').slice(1);
  for (const r of deel) {
    if (/^## /.test(r)) break;
    const m = /^[-*]\s+(.*)$/.exec(r);
    if (!m) continue;
    const vet = /^\*\*(.+?)\*\*/.exec(m[1]);
    let s = vet ? vet[1] : m[1].split(' — ')[0];
    s = s.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    if (s) return s.length > 160 ? s.slice(0, 159).trimEnd() + '…' : s;
  }
  return null;
}
function gesprekNaam(p) { return stamVan(p).replace(/^(WhatsApp|Teams|Signal|Telegram)\s+-\s+/i, '').replace(/\s*\((?:actueel|1-op-1)\)/gi, '').trim(); }
function gesprekBron(p, fm) {
  const b = fmVeld(fm, 'bron').toLowerCase();
  if (b === 'whatsapp' || b === 'teams' || b === 'signal' || b === 'telegram') return BRON_WOORD[b] || b;
  const m = /^(WhatsApp|Teams|Signal|Telegram)\b/i.exec(stamVan(p));
  return m ? (BRON_WOORD[m[1].toLowerCase()] || m[1]) : null;
}
// Einde van het contract uit einddatum of het statusveld ("t/m 2027-06-30", "tot 1-3-2027")
function contractEinde(fm) {
  const e = fmVeld(fm, 'einddatum');
  if (/^\d{4}-\d{2}-\d{2}$/.test(e)) return e;
  const st = fmVeld(fm, 'status');
  const a = /(?:t\/m|tot)\s+(\d{4}-\d{2}-\d{2})/.exec(st);
  if (a) return a[1];
  const b = /(?:t\/m|tot)\s+(\d{1,2}-\d{1,2}-\d{4})/.exec(st);
  return b ? isoUitNl(b[1]) : null;
}
// Lijst uit het ovis-blok in de frontmatter ("  telefoons: [\"06…\"]"); de waarden komen uit Contacten (de compiler schrijft ze)
function fmOvisLijst(fm, veld) {
  const m = new RegExp('^\\s+' + veld + ':[ \\t]*\\[(.*)\\][ \\t]*$', 'm').exec(String(fm || ''));
  if (!m) return [];
  return m[1].split(',').map(function (x) { return x.trim().replace(/^["']|["']$/g, '').trim(); }).filter(Boolean).slice(0, 10);
}

// ── wv4009 (besluitenpagina nr 496 = 3C196, David Ja 22-11-2026 18:19): mailcontact per partij ──
// Bron 1: de mailkaarten (30_Conversaties/Mail/Mailkaarten: Organisaties/, Personen/ en de alfabetische registers voor wie minder mailde),
// momentopname van de Takeout van 24-10-2026. Bron 2: het lees-luik (mail_zoeken, privé-Gmail, alleen lezen) voor de periode NA de kaart.
// Koppeling: kaart.dossier = de pagina (of hoofdpagina) van de partij, 'mailkaart:' op die pagina, of een mailadres/domein uit haar kenmerken,
// haar Google-contact of de pagina tegen kaart.adressen/kaart.domein. Niet gefilterd (Davids eigen scherm). Alleen datum, richting en onderwerp.
const MAIL_PREFIX = '30_Conversaties/Mail/Mailkaarten/';
const MAIL_MAPPEN = ['Organisaties', 'Personen', 'Register organisaties', 'Register personen'];
const MAIL_TOON = 5;                 // laatste vijf wisselingen
const MAIL_LUIK_MS = 30 * 60000;     // luikantwoord per partij 30 min geldig
const MAIL_LUIK_CACHE_MAX = 100;
const MAIL_LUIK_UUR = 60;            // hooguit zoveel luikvragen per uur (alle partijen samen)
const MAIL_LUIK_DELEN = 4;           // vol (25) = venster halveren, hooguit zoveel vragen per partij
const MAIL_TERMEN_MAX = 12;          // adressen + domeinen in één zoekvraag
const MAIL_LUIK_MAX = 25;            // de grens van mail_zoeken
const MAIL_LUIK_BUDGET_MS = 7000;    // na zoveel ms geen nieuwe luikvraag meer (de app-proxy wacht 25 s; één vraag duurt tot ± 14 s)
// domeinen van gratis mail zijn geen partij (een kenmerk 'gmail.com' zou alles vangen)
const MAIL_VRIJ = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.nl', 'outlook.com', 'outlook.nl', 'live.nl', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.nl', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'planet.nl', 'home.nl', 'xs4all.nl', 'hetnet.nl',
  'casema.nl', 'chello.nl', 'upcmail.nl', 'tele2.nl', 'online.nl', 'quicknet.nl', 'telfort.nl', 'zeelandnet.nl', 'unknown.email', 'proton.me', 'protonmail.com']);
const ADRES_RE = /^[^@\s?&"<>(){}]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DOMEIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
function adresNorm(a) {
  const s = String(a || '').trim().toLowerCase().replace(/^mailto:/, '');
  const i = s.lastIndexOf('@');
  if (i < 1) return null;
  const v = s.slice(0, i).split('+')[0], d = s.slice(i + 1);
  const x = v + '@' + d;
  return ADRES_RE.test(x) && x.length <= 120 ? x : null;
}
function domeinNorm(d) { const s = String(d || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, ''); return DOMEIN_RE.test(s) && s.length <= 80 && !MAIL_VRIJ.has(s) ? s : null; }
function adressenUit(tekst) {
  const uit = [];
  String(tekst || '').split(/[,;]/).forEach(function (deel) { const a = adresNorm(adresVan(deel)); if (a && uit.indexOf(a) < 0) uit.push(a); });
  return uit;
}
// "[[30_Conversaties/Mail/Mailkaarten/Personen/X]]" of "[[pad|tekst]]" → "pad.md" (of null)
function linkPad(v) {
  const m = /\[\[([^\]|#]+)/.exec(String(v || ''));
  if (!m) return null;
  const p = m[1].trim();
  return p.split('/').indexOf('..') >= 0 ? null : (/\.md$/i.test(p) ? p : p + '.md');
}
// Kaartregel: "- 2026-10-19 · **Onderwerp** · 2× ⇄ · [[…|tekst]] · `gmail:1a15…` — snippet" (richting ⇄ heen en weer, ← ontvangen, → verstuurd)
const MAIL_REGEL_RE = /^- (\d{4}-\d{2}-\d{2}) · \*\*(.*?)\*\*\s+(?:·\s+(\d+)×\s+)?([⇄←→])\s.*?`gmail:([0-9a-f]{6,24})`/;
function mailRegel(r) {
  const m = MAIL_REGEL_RE.exec(r);
  return m ? { datum: m[1], onderwerp: m[2].slice(0, 200), n: m[3] ? Number(m[3]) : 1, richting: m[4], id: m[5] } : null;
}
function getal(v) { const n = Number(String(v || '').replace(/^"|"$/g, '')); return Number.isInteger(n) && n >= 0 ? n : 0; }
function dagVeld(v) { const s = String(v || '').replace(/^"|"$/g, '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
// Eén mailkaart → { pad, naam, soort, domein, adressen, dossier, mails, gesprekken, laatste, momentopname, regels[≤ 5], ids (Set) } | null
function mailKaartLees(ruw, pad) {
  const fm = frontmatter(ruw);
  if (fmVeld(fm, 'type') !== 'mailkaart') return null;
  const soort = fmVeld(fm, 'soort');
  if (soort !== 'organisatie' && soort !== 'persoon') return null;
  const regels = [], ids = new Set();
  String(ruw).split('\n').forEach(function (r) {
    if (r.charAt(0) !== '-') return;
    const x = mailRegel(r);
    if (!x) return;
    ids.add(x.id);
    if (regels.length < MAIL_TOON) regels.push(x);
  });
  const am = /^adressen:\s*\[(.*)\]\s*$/m.exec(fm);
  return { pad: pad, naam: fmVeld(fm, 'naam'), soort: soort, domein: domeinNorm(fmVeld(fm, 'domein')),
    adressen: am ? (am[1].match(/"([^"]+)"/g) || []).map(function (x) { return adresNorm(x.slice(1, -1)); }).filter(Boolean) : [],
    dossier: linkPad(fmVeld(fm, 'dossier')), mails: getal(fmVeld(fm, 'mails')), gesprekken: getal(fmVeld(fm, 'gesprekken')),
    laatste: dagVeld(fmVeld(fm, 'laatste')), momentopname: dagVeld(fmVeld(fm, 'updated')), regels: regels, ids: ids };
}
// Een register (Register organisaties/X.md, Register personen/X.md): elk kopje één partij; onder het kopje "N mails, M gesprekken · adres, domein"
function mailRegisterLees(ruw, pad) {
  const fm = frontmatter(ruw);
  if (fmVeld(fm, 'type') !== 'mailkaart' || !/^register/.test(fmVeld(fm, 'soort'))) return [];
  const mom = dagVeld(fmVeld(fm, 'updated'));
  const uit = [];
  let cur = null;
  String(ruw).split('\n').forEach(function (r) {
    if (/^## /.test(r)) {
      cur = { pad: pad, naam: r.slice(3).trim(), soort: /personen/.test(fmVeld(fm, 'soort')) ? 'persoon' : 'organisatie', domein: null, adressen: [], dossier: null,
        mails: 0, gesprekken: 0, laatste: null, momentopname: mom, regels: [], ids: new Set(), register: true };
      uit.push(cur);
      return;
    }
    if (!cur) return;
    const tm = /^(\d+) mails?, (\d+) gesprekk?e?n? · (.+)$/.exec(r.trim());
    if (tm && !cur.mails) {
      cur.mails = Number(tm[1]); cur.gesprekken = Number(tm[2]);
      tm[3].split(/,\s*/).forEach(function (w) {
        if (w.indexOf('@') >= 0) { const a = adresNorm(w); if (a && cur.adressen.indexOf(a) < 0) cur.adressen.push(a); }
        else if (!cur.domein) cur.domein = domeinNorm(w);
      });
      return;
    }
    if (r.charAt(0) === '-') {
      const x = mailRegel(r);
      if (!x) return;
      cur.ids.add(x.id);
      if (!cur.laatste || x.datum > cur.laatste) cur.laatste = x.datum;
      if (cur.regels.length < MAIL_TOON) cur.regels.push(x);
    }
  });
  return uit.filter(function (x) { return x.mails > 0 && (x.domein || x.adressen.length); });
}
// Davids eigen adressen (router.json eigen_adressen): ook met +achtervoegsel, en dezelfde naam vóór de @ bij een domein van een eigen adres
// (d.schaap@huisartsentolgaarde.nl naast dokterschaap@huisartsentolgaarde.nl)
function eigenToets(lijst) {
  const vol = new Set(), namen = new Set(), domeinen = new Set();
  (Array.isArray(lijst) ? lijst : []).forEach(function (a) {
    const x = adresNorm(a); if (!x) return;
    vol.add(x); const i = x.lastIndexOf('@'); namen.add(x.slice(0, i)); domeinen.add(x.slice(i + 1));
  });
  return function (a) {
    const x = adresNorm(a); if (!x) return false;
    if (vol.has(x)) return true;
    const i = x.lastIndexOf('@');
    return namen.has(x.slice(0, i)) && domeinen.has(x.slice(i + 1));
  };
}
// Zoekvraag voor het lees-luik: ontvangen van de partij of door David aan de partij verstuurd, na 'vanaf' (JJJJ-MM-DD) en vóór 'tot' (optioneel),
// zonder promoties/sociaal/forums (die staan ook niet op de kaarten)
function mailZoekvraag(adressen, domeinen, vanaf, tot) {
  const t = adressen.concat(domeinen);
  if (!t.length) return null;
  const of = function (pre) { return t.map(function (x) { return pre + x; }).join(' OR '); };
  return '(' + of('from:') + ' OR (from:me (' + of('to:') + '))) after:' + vanaf.replace(/-/g, '/') + (tot ? ' before:' + tot.replace(/-/g, '/') : '') +
    ' -category:promotions -category:social -category:forums';
}
// Luikmails → per gesprek { id, datum, richting, onderwerp, n } en het aantal mails; alleen mails strikt na 'vanaf' (de kaartdag zelf telt de kaart)
// waarin de partij echt voorkomt: als afzender (←) of, bij een mail van David, als ontvanger (→). Eigen adressen tellen nooit als partij.
function mailLuikTel(mails, ken, eigen, vanaf) {
  const hoort = function (a) {
    if (!a || eigen(a)) return false;
    if (ken.adressen.indexOf(a) >= 0) return true;
    const d = a.slice(a.lastIndexOf('@') + 1);
    return ken.domeinen.some(function (x) { return d === x || d.endsWith('.' + x); });
  };
  const draden = new Map(), gezien = new Set();
  let n = 0;
  (Array.isArray(mails) ? mails : []).forEach(function (m) {
    if (!m || typeof m !== 'object' || gezien.has(String(m.id))) return;
    const dag = /^\d{4}-\d{2}-\d{2}$/.test(String(m.dag_lokaal || '')) ? String(m.dag_lokaal) : String(m.datum || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dag) || dag <= vanaf) return;
    const van = adresNorm(adresVan(m.van));
    let r = null;
    if (hoort(van)) r = '←';
    else if ((eigen(van) || /SENT/.test(String(m.labels || ''))) && adressenUit(m.aan).some(hoort)) r = '→';
    if (!r) return;
    gezien.add(String(m.id)); n++;
    const tid = /^[0-9a-f]{6,24}$/.test(String(m.thread_id || '')) ? String(m.thread_id) : String(m.id);
    const d = draden.get(tid);
    if (!d) draden.set(tid, { id: tid, datum: dag, richting: r, onderwerp: String(m.onderwerp || '').slice(0, 200), n: 1 });
    else { d.n++; if (dag > d.datum) d.datum = dag; if (d.richting !== r) d.richting = '⇄'; }
  });
  return { mails: n, draden: draden };
}

// ── wv4236 (besluitenpagina nr 952 = L52, David Ja 25-11-2026 22:19): "Loopt nu" bovenaan een persoon of organisatie ──
// Koppelen alleen op een vaste sleutel, nooit op gelijkende tekst:
//  - kaarten: open punten in Voor jou met herkomst.knoop = het register-id (of herkomst.entiteit = de code van een eigen entiteit);
//  - afspraken: rijen van OVIS Calendar (sb_kalender_tijdlijn, vandaag t/m +14) waarvan een gekoppelde entiteit (event_entity) als pad de
//    pagina of hoofdpagina van de partij heeft, of haar object_id uit de frontmatter. Alleen soort 'afspraak' (echte agenda's); deadlines
//    staan al onder Deadlines, roosterdiensten tellen alleen bij een persoon (rol betreft) en worden één regel "ingeroosterd".
// Gemeten 27-11-2026: 0 van 22 open kaarten draagt zo'n sleutel; afspraken: HAGRO-agenda en Gezin hangen aan HAGRO/PRIVE, Davids eigen en
// Werk-agenda hebben nog geen koppeling; 25 roosterdiensten aan medewerkers.
const LOOPT_DAGEN = 14, LOOPT_AFSPRAAK_MAX = 6, LOOPT_KAART_MAX = 5, LOOPT_DIENST_MAX = 10;
const AGENDA_WOORD = { 'google-david': 'jouw agenda', 'google-werk': 'Werk', 'google-gezin': 'Gezin', 'google-hagro': 'HAGRO' };
function amsTijd(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return { dag: d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }), tijd: d.toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false }) };
}
// rijen: tijdlijnrijen (al op venster gevraagd); punten: Voor jou-lijst; o: { id, eigen, persoon, paden: [vaultpad], objectId, vandaag, tot, masker, nu }
// → { kaarten: [...] | null, afspraken: [...] | null, afspraken_totaal, diensten: { dagen, plek } | null }; null = die bron is nu niet te lezen
function looptUit(rijen, punten, o) {
  const masker = typeof o.masker === 'function' ? o.masker : geenMasker;
  const paden = new Set((o.paden || []).filter(Boolean).map(String));
  const oid = o.objectId ? String(o.objectId).toLowerCase() : null;
  const hoort = function (e) { return e && ((e.pad && paden.has(String(e.pad))) || (oid && String(e.object_id || '').toLowerCase() === oid)); };
  let kaarten = null;
  if (Array.isArray(punten)) {
    const nu = typeof o.nu === 'number' ? o.nu : Date.now();
    kaarten = punten.filter(function (p) {
      if (!p || p.status !== 'open' || !Number.isInteger(p.id) || p.id <= 0) return false;
      if (p.toon_vanaf && Date.parse(p.toon_vanaf) > nu) return false;   // wacht nog op zijn vaste moment (wv3967)
      const h = p.herkomst && typeof p.herkomst === 'object' && !Array.isArray(p.herkomst) ? p.herkomst : {};
      return (typeof h.knoop === 'string' && h.knoop === o.id) || (o.eigen && typeof h.entiteit === 'string' && h.entiteit === o.id);
    }).slice(0, LOOPT_KAART_MAX).map(function (p) {
      return { id: p.id, titel: masker(String(p.titel || '')).slice(0, 120), deadline: /^\d{4}-\d{2}-\d{2}/.test(String(p.deadline || '')) ? String(p.deadline).slice(0, 10) : null };
    });
  }
  let afspraken = null, totaal = 0, diensten = null;
  if (Array.isArray(rijen)) {
    const lijst = [], dagen = new Set(); let plek = null;
    rijen.forEach(function (r0) {
      const r = r0 && r0.sb_kalender_tijdlijn && !r0.event_id ? r0.sb_kalender_tijdlijn : r0;
      if (!r || typeof r !== 'object') return;
      const ents = Array.isArray(r.entiteiten) ? r.entiteiten : [];
      const mijn = ents.filter(hoort);
      if (!mijn.length) return;
      const t = r.hele_dag ? null : amsTijd(r.begin_tijd);
      const dag = t ? t.dag : (/^\d{4}-\d{2}-\d{2}$/.test(String(r.begin_datum || '')) ? String(r.begin_datum) : null);
      if (!dag || dag < o.vandaag || dag > o.tot) return;
      if (r.soort === 'afspraak') {
        lijst.push({ datum: dag, tijd: t ? t.tijd : null, titel: masker(String(r.titel || '').replace(/\s+/g, ' ').trim()).slice(0, 120) || 'afspraak',
          agenda: AGENDA_WOORD[r.feed] || null });
      } else if (r.soort === 'dienst' && o.persoon && mijn.some(function (e) { return e.rol === 'betreft'; })) {
        dagen.add(dag);
        const ctx = ents.find(function (e) { return e && e.rol === 'context' && !hoort(e) && e.naam; });
        if (ctx && !plek) plek = masker(String(ctx.naam)).slice(0, 60);
      }
    });
    lijst.sort(function (a, b) { return (a.datum + (a.tijd || '')).localeCompare(b.datum + (b.tijd || '')); });
    totaal = lijst.length; afspraken = lijst.slice(0, LOOPT_AFSPRAAK_MAX);
    if (dagen.size) diensten = { dagen: Array.from(dagen).sort().slice(0, LOOPT_DIENST_MAX), totaal: dagen.size, plek: plek };
  }
  return { kaarten: kaarten, afspraken: afspraken, afspraken_totaal: totaal, diensten: diensten };
}

function maak(o) {
  const rpc = o.rpc, lees = o.lees, vault = o.vault, facturenPad = o.facturenPad || null;
  const bankPad = o.bankPad || null;   // wv3298: privébank (bank-archief transacties.sqlite), alleen lezen
  const bankMod = o.bankPartij !== undefined ? o.bankPartij : BANK_PARTIJ;
  let bankCache = null;
  const deadlines = typeof o.deadlines === 'function' ? o.deadlines : function () { return null; };
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const entNu = typeof o.entNu === 'function' ? o.entNu : null;   // wv3715: "Nu" van vannacht per eigen entiteit (code → { datum, regels } | null)
  function nuVan(code) {
    if (!entNu) return undefined;
    let x; try { x = entNu(String(code)) || null; } catch (e) { return null; }
    if (!x) return null;
    return Object.assign({}, x, { regels: (x.regels || []).map(function (r) { return Object.assign({}, r, { tekst: masker(String(r.tekst || '')) }); }) });   // sleutelmasker (grondwet 2)
  }
  const masker = typeof o.masker === 'function' ? o.masker : geenMasker;   // sleutelmasker (grondwet 2), op alle tekst
  const kaart = typeof o.kaart === 'function' ? o.kaart : function () { return null; };   // [{p, s, m}] uit de Second Brain-kaart
  let cache = null, priveCache = null;
  const intakePad = o.intakePad || null;   // wv3938: intake.sqlite (alleen lezen)
  const bekeken = typeof o.bekeken === 'function' ? o.bekeken : function () { return []; };
  // wv4236 (L52): Loopt nu — tijdlijn(van, tot) → Promise<[rij]> (OVIS Calendar), voorJou() → Promise<[punt]>; ontbreekt = geen blok
  const tijdlijn = typeof o.tijdlijn === 'function' ? o.tijdlijn : null;
  const voorJou = typeof o.voorJou === 'function' ? o.voorJou : null;
  let tlCache = null;   // wv3938: [{ s: sleutel, t: iso }], nieuwste eerst
  let stukCache = null, kIdx = null;

  // Kaart als index: bestaat dit pad, en welk vol pad hoort bij [[naam]] (uniek op bestandsnaam, of op achtervoegsel bij map/naam)
  function kaartIndex() {
    const b = kaart();
    if (!Array.isArray(b)) return null;
    if (kIdx && kIdx.b === b) return kIdx;
    const paden = new Set(), opNaam = new Map();
    b.forEach(function (x) {
      if (!x || typeof x.p !== 'string') return;
      paden.add(x.p);
      const n = x.p.split('/').pop().toLowerCase();
      (opNaam.get(n) || opNaam.set(n, []).get(n)).push(x.p);
    });
    kIdx = { b: b, paden: paden, opNaam: opNaam };
    return kIdx;
  }
  function linkVan(doel) {
    const ki = kaartIndex();
    if (!ki) return null;
    let d = String(doel || '').split('#')[0].trim().replace(/^\/+/, '');
    if (!d || d.split('/').indexOf('..') >= 0) return null;
    if (!/\.[a-z0-9]{2,5}$/i.test(d)) d += '.md';
    if (ki.paden.has(d)) return d;
    let l = ki.opNaam.get(d.split('/').pop().toLowerCase()) || [];
    if (d.indexOf('/') >= 0) l = l.filter(function (p) { return p.toLowerCase().endsWith('/' + d.toLowerCase()); });
    return l.length === 1 ? l[0] : null;
  }
  // [[vol pad|…]] in een paginatekst die naar een partij wijst → { pad: sleutel } (de app opent dan de kaart in plaats van de pagina)
  function partijLinks(teksten, reg) {
    const opPad = new Map();
    reg.knopen.forEach(function (k) { if (zichtbaar(k) && k.vault_pagina) opPad.set(String(k.vault_pagina), sleutelVan(k.id)); });
    const pv = prive();
    pv.personen.concat(pv.stamboom).forEach(function (x) { if (!opPad.has(x.pad)) opPad.set(x.pad, sleutelVan(x.pad)); });
    const uit = {};
    teksten.forEach(function (t) {
      const re = /\[\[([^\]|\n]+)\|/g; let m;
      while ((m = re.exec(String(t || '')))) { const sl = opPad.get(m[1]); if (sl) uit[m[1]] = sl; }
    });
    return uit;
  }

  // Alle Intake-stukken, per stuk één regel (nieuwste eerst); null = geen intake.sqlite of niet te lezen
  function stukIndex() {
    if (!intakePad) return null;
    if (stukCache && nu() - stukCache.t < STUK_CACHE_MS) return stukCache.v;
    let v;
    try {
      const rijen = leesSqlite(intakePad, 'select u.stuk_id as id, u.doel as doel, u.pad as pad, u.tijd as tijd, s.bron as bron, s.ontvangen as ontvangen, ' +
        's.meta as meta, s.bestandsnaam as bestandsnaam from uitvoering u join stuk s on s.stuk_id = u.stuk_id order by u.id', []);
      if (!rijen) v = { fout: 'Intake is nu niet te lezen.' };
      else {
        const per = new Map();
        rijen.forEach(function (r) {
          let x = per.get(r.id);
          if (!x) {
            const m = metaVan(r.meta);
            x = { id: r.id, doelen: new Set(), paden: [], tijd: r.tijd || '', bron: r.bron, datum: String(r.ontvangen || r.tijd || '').slice(0, 10) || null,
              onderwerp: typeof m.onderwerp === 'string' ? m.onderwerp : (typeof m.titel === 'string' ? m.titel : ''), van: adresVan(m.van), bestandsnaam: r.bestandsnaam || '' };
            per.set(r.id, x);
          }
          if (r.doel) x.doelen.add(String(r.doel));
          if (r.pad && x.paden.indexOf(r.pad) < 0) x.paden.push(String(r.pad));
          if (String(r.tijd || '') > x.tijd) x.tijd = String(r.tijd);
        });
        const lijst = Array.from(per.values());
        lijst.sort(function (a, b) { return String(b.datum || '').localeCompare(String(a.datum || '')) || String(b.tijd).localeCompare(String(a.tijd)) || a.id.localeCompare(b.id); });
        v = { lijst: lijst, reg: new Map() };
      }
    } catch (e) { v = { fout: 'Intake is nu niet te lezen.' }; }
    stukCache = { t: nu(), v: v };
    return v;
  }
  // Waar staat het stuk nu: het oude pad, het bronnenregister van die map, of Bronnen/Intake/<naam>; anders null (geen tik)
  function stukPad(x, si) {
    const ki = kaartIndex();
    if (!ki) return null;
    // review ZOU 2: elk pad van het stuk proberen (eerst de hoofdtekst, dan de bijlagen), elk met zijn archiefplekken
    const hoofd = function (p) { return /\.md$/i.test(p) && p.indexOf('__') < 0; };
    const paden = x.paden.filter(hoofd).concat(x.paden.filter(function (p) { return !hoofd(p); }));
    for (const p of paden) {
      if (ki.paden.has(p)) return p;
      const i = p.indexOf('raw_input/');
      if (i < 0) continue;
      const wortel = p.slice(0, i), bn = p.slice(i + 'raw_input/'.length);
      if (!si.reg.has(wortel)) {
        let t = '';
        try { if (ki.paden.has(wortel + 'Bronnen/_register.md')) t = lees(path.join(vault, wortel + 'Bronnen/_register.md')); } catch (e) { t = ''; }
        si.reg.set(wortel, registerIndex(t, wortel));
      }
      const ri = si.reg.get(wortel);
      const kand = [ri.get('bn:' + bn), ri.get('sid:' + x.id), wortel + 'Bronnen/Intake/' + bn];
      for (const c of kand) if (c && ki.paden.has(c) && /^(10_Zakelijk|20_Prive)\//.test(c)) return c;
    }
    return null;
  }
  function stukRegel(x, si) {
    const pad = stukPad(x, si);
    const titel = x.onderwerp || x.bestandsnaam || (x.paden[0] ? stamVan(x.paden[0]).replace(/^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}_[a-z]+_/, '').replace(/-/g, ' ') : x.id);
    return { id: x.id, titel: masker(String(titel).slice(0, 200)), datum: x.datum, bron: bronWoord(x.bron), pad: pad,
      ext: pad ? (/\.([a-z0-9]+)$/i.exec(pad) || [0, ''])[1].toLowerCase() : null, bijlagen: Math.max(0, x.paden.length - 1) };
  }
  // Stukken van één partij: { totaal, nieuw, stukken[≤ STUK_TOON], kenmerken? } | { fout } | null (geen Intake in deze pod)
  function stukkenVan(k, reg) {
    const si = stukIndex();
    if (!si) return null;
    if (si.fout) return { totaal: 0, nieuw: 0, stukken: [], fout: si.fout };
    let hoort;
    if (isEigen(k)) hoort = function (x) { return x.doelen.has(String(k.id)); };
    else {
      const hv = (reg.handvatten[k.id] || []);
      const mails = hv.filter(function (h) { return h.soort === 'mail'; }).map(function (h) { return String(h.waarde_norm || h.waarde || '').trim().toLowerCase(); }).filter(Boolean);
      const domeinen = hv.filter(function (h) { return h.soort === 'domein'; }).map(function (h) { return String(h.waarde_norm || h.waarde || '').trim().toLowerCase().replace(/^@/, ''); }).filter(function (d) { return /\./.test(d); });
      if (!mails.length && !domeinen.length) return { totaal: 0, nieuw: 0, stukken: [], kenmerken: false };
      hoort = function (x) {
        if (!x.van) return false;
        const dom = x.van.split('@')[1] || '';
        return mails.indexOf(x.van) >= 0 || domeinen.some(function (d) { return dom === d || dom.endsWith('.' + d); });
      };
    }
    const l = si.lijst.filter(hoort);
    const grens = new Date(nu() - STUK_NIEUW_DAGEN * 86400000).toISOString().slice(0, 10);
    return { totaal: l.length, nieuw: l.filter(function (x) { return String(x.datum || '') >= grens; }).length,
      stukken: l.slice(0, STUK_TOON).map(function (x) { return stukRegel(x, si); }), kenmerken: isEigen(k) ? undefined : true };
  }
  // Tegels bovenaan de lijst: per eigen entiteit de deadlines binnen 30 dagen (zelfde register als de kaart) en de stukken van de laatste 7 dagen
  function eigenTegels(reg) {
    const d = deadlines();
    const dl = Array.isArray(d) ? d : null;
    const si = stukIndex();
    const grens = new Date(nu() - STUK_NIEUW_DAGEN * 86400000).toISOString().slice(0, 10);
    const tegels = reg.knopen.filter(function (k) { return zichtbaar(k) && isEigen(k); }).map(function (k) {
      const code = String(k.id);
      return { sleutel: sleutelVan(k.id), code: code, naam: masker(k.naam),
        deadlines: dl ? dl.filter(function (x) { return Array.isArray(x.ents) && x.ents.indexOf(code) >= 0 && x.dagen >= 0 && x.dagen <= DEADLINE_TEGEL_DAGEN; }).length : null,
        stukken_nieuw: si && !si.fout ? si.lijst.filter(function (x) { return x.doelen.has(code) && String(x.datum || '') >= grens; }).length : null };
    });
    tegels.sort(function (a, b) { return (a.code === 'PRIVE' ? 1 : 0) - (b.code === 'PRIVE' ? 1 : 0) || a.naam.localeCompare(b.naam, 'nl'); });
    return tegels;
  }

  async function register() {
    if (cache && nu() - cache.t < CACHE_MS) return cache.p;
    const p = (async function () {
      if (!rpc) throw new Error('geen Supabase');
      const r = await rpc('ovis_register_lees', { p_log_sinds: null });
      if (!r || !Array.isArray(r.knopen)) throw new Error('ovis_register_lees gaf geen register');
      const hv = {};
      (r.handvatten || []).forEach(function (h) { if (h && h.status !== 'vervallen') (hv[h.knoop] = hv[h.knoop] || []).push(h); });
      return { knopen: r.knopen, handvatten: hv };
    })();
    cache = { t: nu(), p: p };
    p.catch(function () { if (cache && cache.p === p) cache = null; });
    return p;
  }

  // Facturen per knoop, uit de Facturen-app (factuur) en het FV2-archief (factuur_archief): leverancier.knoop_id, anders een unieke
  // naam/alias-match (zelfde regel als rekeningenPerDoel in ovis-register.js); een eigen entiteit telt de facturen op haar naam. Regels met een
  // patiëntkenmerk tellen sinds wv3675 (2C12, David 21-11) gewoon mee. Alleen-eigenaar-regels tellen mee: de app is van David (de eigenaar).
  // wv3944 (besluitenpagina nr 357/390 = 3C57/3C90, David Ja 22-11-2026 18:18): ook de interne facturen van een eigen entiteit tellen mee (Davids
  // eigen scherm laat niets weg); per regel id, herkomst en nummer (tik = die factuur in Facturen); alle id's (ids/archief_ids, voor "Open Facturen"
  // gefilterd op deze partij) en per jaar het gefactureerde totaal. Facturen worden niet bij de bank opgeteld (geen dubbeltelling).
  const FAC_IDS_MAX = 1000;
  function facturenVan(k, reg) {
    const ENT = { TG: 'tolgaarde', GH: 'groenhouten', HOLD: 'holding', KM: 'kostenmaatschap', POT: 'pot', PHBV: 'praktijkhouders_bv', PRIVE: 'prive', SLOEL: 'sloel',
      HAGRO: 'hagro', SEL: 'sel', DBH: 'dbh', GHAWA: 'ghawa' };
    let rijen = [];
    const app = function (x) { return (x || []).map(function (f) { return Object.assign({ herkomst: 'app' }, f); }); };
    const arch = function (x) { return (x || []).map(function (f) { return Object.assign({ herkomst: 'archief' }, f); }); };
    try {
      if (isEigen(k)) {
        const e = ENT[String(k.id).toUpperCase()];
        if (!e) return { aantal: 0, laatste: [], ids: [], archief_ids: [], jaren: [], intern: 0 };
        const a = leesSqlite(facturenPad, 'select id, nummer, factuurdatum, incl_eur as bedrag, status, coalesce(intern,0) as intern from factuur where lower(entiteit) = ?', [e]);
        if (a === null) return null;
        rijen = app(a).concat(arch(leesSqlite(facturenPad, 'select id, nummer, factuurdatum, incl as bedrag, status from factuur_archief where lower(entiteit) = ?', [e])));
      } else {
        const lev = leesSqlite(facturenPad, 'select id, naam, knoop_id from leverancier', []);
        if (lev === null) return null;
        const opNaam = {};
        reg.knopen.forEach(function (x) {
          if (isEigen(x)) return;
          [x.naam].concat(x.aliassen || []).concat((reg.handvatten[x.id] || []).filter(function (h) { return h.soort === 'alias'; }).map(function (h) { return h.waarde; }))
            .forEach(function (n) { const s = norm(n); if (s.length >= 3) (opNaam[s] = opNaam[s] || new Set()).add(x.id); });
        });
        const hoort = function (naam) { const s = opNaam[norm(naam)]; return !!(s && s.size === 1 && s.has(k.id)); };
        const ids = lev.filter(function (l) { return l.knoop_id ? l.knoop_id === k.id : hoort(l.naam); }).map(function (l) { return l.id; });
        if (ids.length) rijen = app(leesSqlite(facturenPad, 'select id, nummer, factuurdatum, incl_eur as bedrag, status from factuur where leverancier in (' + ids.map(function () { return '?'; }).join(',') + ')', ids));
        const ar = leesSqlite(facturenPad, 'select id, nummer, leverancier_naam, factuurdatum, incl as bedrag, status from factuur_archief', []) || [];
        rijen = rijen.concat(arch(ar.filter(function (f) { return hoort(f.leverancier_naam); })));
      }
    } catch (e) { return null; }
    rijen.sort(function (x, y) { return String(y.factuurdatum || '').localeCompare(String(x.factuurdatum || '')) || String(x.id).localeCompare(String(y.id)); });
    const jr = new Map();
    rijen.forEach(function (f) {
      const j = /^\d{4}/.exec(String(f.factuurdatum || ''));
      const key = j ? j[0] : '';
      if (!jr.has(key)) jr.set(key, { n: 0, cent: 0 });
      const y = jr.get(key); y.n++; if (typeof f.bedrag === 'number') y.cent += Math.round(f.bedrag);
    });
    const idVan = function (h) { return rijen.filter(function (f) { return f.herkomst === h && /^[0-9a-f]{16}$/.test(String(f.id)); }).slice(0, FAC_IDS_MAX).map(function (f) { return String(f.id); }); };
    return { aantal: rijen.length, intern: rijen.filter(function (f) { return f.intern; }).length,
      laatste: rijen.slice(0, 5).map(function (f) {
        return { id: /^[0-9a-f]{16}$/.test(String(f.id)) ? String(f.id) : null, herkomst: f.herkomst, nummer: f.nummer ? masker(String(f.nummer)).slice(0, 40) : null,
          datum: f.factuurdatum || null, bedrag_cent: typeof f.bedrag === 'number' ? Math.round(f.bedrag) : null, status: f.status || null };
      }),
      ids: idVan('app'), archief_ids: idVan('archief'),
      jaren: Array.from(jr.entries()).filter(function (e) { return e[0]; }).sort(function (a, b) { return b[0].localeCompare(a[0]); })
        .map(function (e) { return { jaar: Number(e[0]), facturen: e[1].n, incl_cent: e[1].cent }; }),
      zonder_datum: jr.has('') ? jr.get('').n : 0 };
  }

  // wv3298: blok Bank — aantal posten, eerste en laatste datum en de schrijfwijzen per kant (zakelijk uit de Facturen-app, privé uit het
  // bank-archief), via naam/alias van precies één knoop plus de filiaalregel (bank-partij.js). Geen bedragen, geen IBAN. Eigen entiteiten
  // niet (dat zijn overboekingen tussen eigen rekeningen). Index over alle posten, 5 minuten bewaard.
  function bankVan(k, reg) {
    if (!bankMod || isEigen(k) || (!facturenPad && !bankPad)) return null;
    try {
      if (!bankCache || nu() - bankCache.t >= BANK_CACHE_MS) {
        bankCache = { t: nu(), idx: bankMod.index({ facturenPad: facturenPad, bankPad: bankPad, knopen: reg.knopen, handvatten: reg.handvatten, isEigen: isEigen, nu: nu() }) };
      }
      const b = bankMod.blokVoor(bankCache.idx, k.id);
      if (!b) return null;
      [b.zakelijk, b.prive].forEach(function (x) { if (x && x.schrijfwijzen) x.schrijfwijzen = x.schrijfwijzen.map(function (n) { return masker(n); }); });
      return b;
    } catch (e) { return null; }
  }

  // wv3944 (3C57): geld van een eigen entiteit — haar eigen bankposten per jaar, laatste post, gemiddelde en de vijf grootste tegenpartijen
  // (12 maanden), tegenpartij met precies één knoop = haar sleutel (tik = haar kaart). Niets weggelaten (Davids eigen scherm). 5 minuten bewaard.
  const EIGEN_BANK = { TG: 'tolgaarde', GH: 'groenhouten', HOLD: 'holding', KM: 'kostenmaatschap', POT: 'pot', PHBV: 'praktijkhouders_bv', PRIVE: 'prive', SLOEL: 'sloel',
    SEL: 'sel', GHAWA: 'ghawa' };
  let eigenCache = new Map();
  function eigenGeldVan(k, reg) {
    if (!bankMod || typeof bankMod.eigenGeld !== 'function' || !isEigen(k)) return undefined;
    const ent = EIGEN_BANK[String(k.id).toUpperCase()];
    if (!ent) return { bron: null, posten: 0, geld: null, leveranciers: [] };
    const c = eigenCache.get(ent);
    if (c && nu() - c.t < BANK_CACHE_MS) return c.x;
    let x;
    try {
      const live = bankMod.naamIndex(reg.knopen, reg.handvatten, isEigen);
      x = bankMod.eigenGeld({ facturenPad: facturenPad, bankPad: bankPad, entiteit: ent, live: live, nu: nu() });
      if (x) x.leveranciers = x.leveranciers.map(function (l) {
        const kn = l.knoop ? reg.knopen.find(function (y) { return y.id === l.knoop && zichtbaar(y); }) : null;
        return { naam: masker(String((kn && kn.naam) || l.naam || '')) || null, af_cent: l.af_cent, betalingen: l.betalingen, sleutel: kn ? sleutelVan(kn.id) : null };
      });
    } catch (e) { x = null; }
    eigenCache.set(ent, { t: nu(), x: x });
    return x;
  }

  // wv1771: contactgegevens uit Google voor een persoon met een Google-koppeling → null (geen koppeling) of { bron, voorgesteld, mailadressen,
  // telefoons, adressen, verjaardag, naam } of { bron, voorgesteld, fout }. Begrensd; het contact moet precies de gekoppelde sleutel hebben.
  // wv1948: een actieve koppeling gaat voor; anders de (enige) voorgestelde. Twee voorgestelde koppelingen = niet tonen (welke klopt?).
  async function googleVan(k, reg) {
    const gs = (reg.handvatten[k.id] || []).filter(function (h) { return h.soort === 'google' && GOOGLE_RE.test(String(h.waarde_norm || h.waarde || '')); });
    const act = gs.filter(function (h) { return h.status === 'actief'; }), vg = gs.filter(function (h) { return h.status === 'voorgesteld'; });
    const g = act.length ? act[0] : vg.length === 1 ? vg[0] : null;
    if (!g) return null;
    const voorgesteld = g.status !== 'actief';
    const sl = String(g.waarde_norm || g.waarde);
    let r;
    try { r = await rpc('ovis_personen_lees', { p_resource: [sl] }); } catch (e) { return { bron: 'Google', voorgesteld: voorgesteld, fout: 'Het Google-contact is nu niet te lezen.' }; }
    const c = r && Array.isArray(r.contacten) ? r.contacten.find(function (x) { return x && x.r === sl; }) : null;
    if (!c) return { bron: 'Google', voorgesteld: voorgesteld, fout: 'Het gekoppelde Google-contact bestaat niet meer.' };
    const uniek = function (a) { return Array.from(new Set(a)); };
    const kortTekst = function (x, n) { return typeof x === 'string' ? x.replace(/\s+/g, ' ').trim().slice(0, n) : ''; };
    return { bron: 'Google', voorgesteld: voorgesteld,
      naam: masker(kortTekst(c.naam, 120)) || null,   // wv1948 review ZOU 5: welk contact (vooral bij een voorgestelde koppeling)
      // wv1948 (E6): adres (label + één regel) en verjaardag; een oudere RPC zonder die velden geeft [] en null
      adressen: (Array.isArray(c.adres) ? c.adres : []).filter(function (a) { return a && typeof a === 'object' && kortTekst(a.tekst, 200); }).slice(0, 5)
        .map(function (a) { return { label: masker(kortTekst(a.label, 40)) || null, tekst: masker(kortTekst(a.tekst, 200)) }; }),
      verjaardag: typeof c.verjaardag === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.verjaardag) ? c.verjaardag : null,
      mailadressen: uniek((Array.isArray(c.mail) ? c.mail : []).map(function (x) { return String(x).trim().toLowerCase(); }).filter(function (x) { return /^[^@\s?&"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(x) && x.length <= 120; })).slice(0, 10),
      telefoons: uniek((Array.isArray(c.tel) ? c.tel : []).map(telNl).filter(function (x) { return /^0[0-9]{9,15}$/.test(x); })).slice(0, 10) };
  }

  // Deadlines: van een eigen entiteit (ook PRIVE, ook HR; wv1930) op de entiteitcode; van een persoon de regels met zijn pagina als
  // bron of zijn volledige naam (twee woorden of meer) in titel of actie.
  function deadlinesVan(k, persoon) {
    let d;
    try { d = deadlines(); } catch (e) { return null; }
    if (!Array.isArray(d)) return null;
    let hoort;
    if (persoon) {
      const pat = persoon.patronen.filter(function (x) { return x.indexOf(' ') > 0; });
      const pag = String(persoon.pagina || '').replace(/\.md$/, '');
      hoort = function (x) {
        const bp = x.bron && x.bron.pad ? String(x.bron.pad).replace(/\.md$/, '') : '';
        return (pag && bp && (bp === pag || pag.split('/').pop() === bp)) || (pat.length > 0 && bevatNaam(String(x.titel || '') + ' ' + String(x.actie || ''), pat));
      };
    } else if (k && isEigen(k)) hoort = function (x) { return Array.isArray(x.ents) && x.ents.indexOf(String(k.id)) >= 0; };
    else return null;
    return d.filter(function (x) { return hoort(x) && x.dagen >= -7 && x.dagen <= 400; })
      .sort(function (a, b) { return a.dagen - b.dagen; }).slice(0, 8)
      .map(function (x) { return { datum: x.datum, dagen: x.dagen, titel: masker(String(x.titel || '').slice(0, 160)), hr: !!x.hr,
        etiket: x.etiket === 'socev' || x.etiket === 'info' ? x.etiket : 'jij' }; });   // wv3706: jij / socev / info (ter info)
  }

  // Privépersonen uit de vault (wv1930): persoonspagina's onder PRIVE_MAPPEN, gelezen via VV (lees); de stamboom alleen op naam (bestandsnaam,
  // geen lezing). Cache 60 s, zoals het register. Pagina's die al een knoop hebben (vault_pagina) slaat lijst() over.
  function prive() {
    if (priveCache && nu() - priveCache.t < CACHE_MS) return priveCache.v;
    const b = kaart();
    const uit = { personen: [], stamboom: [], fout: null };
    if (!Array.isArray(b)) uit.fout = 'de kaart van de vault is nu niet te lezen';
    else {
      b.forEach(function (x) {
        const p = String(x && x.p || '');
        if (!/\.md$/i.test(p) || !PAGINA_RE.test(p) || p.split('/').indexOf('..') >= 0) return;
        if (p.indexOf(STAMBOOM) === 0) {
          uit.stamboom.push({ pad: p, naam: stamVan(p), aliassen: [], rol: 'stamboom', m: x.m });
          return;
        }
        const map = PRIVE_MAPPEN.find(function (m) { return p.indexOf(m[0]) === 0; });
        if (!map) return;
        let ruw;
        try { ruw = lees(path.join(vault, p)); } catch (e) { return; }
        const fm = frontmatter(ruw);
        if (!PRIVE_TYPE.test(fmVeld(fm, 'type'))) return;
        uit.personen.push({ pad: p, naam: fmVeld(fm, 'naam') || stamVan(p), aliassen: fmAliassen(fm), rol: map[1], m: x.m });
      });
    }
    priveCache = { t: nu(), v: uit };
    return uit;
  }
  function priveRegel(x) {
    return { id: 'prive:' + x.pad, sleutel: sleutelVan(x.pad), naam: masker(x.naam), groep: 'prive', rol: x.rol, concept: false, voor: ['PRIVE'],
      aliassen: x.aliassen.slice(0, 5).map(masker), prive: true, pagina: true, handvatten: 0, register: false };
  }

  // Dossier van een persoon (wv1930): bestanden in <entiteit>/…/Medewerkers/Gesprekken/<naam>/, en in Medewerkers/Contracten/ en elke
  // Bronnen-map onder de entiteit met de naam (of een alias) in de bestandsnaam. Pad, titel, soort en datum; nieuwste eerst, ten hoogste 60.
  // wortels: de entiteitmappen (wortelVan) waarin gezocht wordt — die van de pagina en, bij een register-persoon, die van elke entiteit in voor
  function dossierVan(pagina, patronen, wortels) {
    const ws = Array.from(new Set([wortelVan(pagina)].concat(wortels || []).filter(Boolean)));
    if (!ws.length) return { stukken: [], totaal: 0, fout: 'deze persoon hoort bij geen entiteitmap' };   // review ZOU 8
    if (!patronen.length) return { stukken: [], totaal: 0 };
    const b = kaart();
    if (!Array.isArray(b)) return { stukken: [], totaal: 0, fout: 'de kaart van de vault is nu niet te lezen' };
    const uit = [];
    b.forEach(function (x) {
      const p = String(x && x.p || '');
      const wortel = ws.find(function (w) { return p.indexOf(w) === 0; });
      if (p === pagina || !wortel || p.split('/').indexOf('..') >= 0) return;
      const d = p.slice(wortel.length).split('/');
      const naam = d[d.length - 1], mappen = d.slice(0, -1);
      let soort = null;
      const g = mappen.indexOf('Gesprekken');
      if (g > 0 && mappen[g - 1] === 'Medewerkers' && mappen[g + 1] && bevatNaam(mappen[g + 1], patronen)) soort = 'gesprek';
      else if (mappen.indexOf('Contracten') > 0 && mappen[mappen.indexOf('Contracten') - 1] === 'Medewerkers' && bevatNaam(stamVan(naam), patronen)) soort = 'contract';
      else if (mappen.indexOf('Bronnen') >= 0 && bevatNaam(stamVan(naam), patronen)) soort = 'bron';
      if (!soort) return;
      uit.push({ pad: p, titel: masker(stamVan(naam)), ext: (/\.([a-z0-9]+)$/i.exec(naam) || [null, ''])[1].toLowerCase(), soort: soort, datum: stukDatum(x), m: x.m || 0 });
    });
    uit.sort(function (a, z) { return String(z.datum || '').localeCompare(String(a.datum || '')) || (z.m - a.m) || a.pad.localeCompare(z.pad); });
    return { stukken: uit.slice(0, DOSSIER_MAX).map(function (x) { return { pad: x.pad, titel: x.titel, ext: x.ext, soort: x.soort, datum: x.datum }; }), totaal: uit.length };
  }

  // wv3945 (3C97): gesprekspagina's en notulen. Eén index over de kaart (60 s): per gesprekspagina pad, naam, bron, datum en eerste onderwerp.
  let gezegdCache = null;
  function gesprekIndex() {
    const b = kaart();
    if (!Array.isArray(b)) return null;
    if (gezegdCache && gezegdCache.b === b && nu() - gezegdCache.t < GEZEGD_CACHE_MS) return gezegdCache.v;
    const gesprekken = [], notulen = [];
    b.forEach(function (x) {
      const p = String(x && x.p || '');
      if (!/\.md$/i.test(p) || !PAGINA_RE.test(p) || p.split('/').indexOf('..') >= 0) return;
      const d = p.split('/');
      const map = d[d.length - 2];
      if (map === 'Conversaties') {
        let ruw = '';
        try { ruw = lees(path.join(vault, p)); } catch (e) { return; }
        const fm = frontmatter(ruw);
        const upd = fmVeld(fm, 'updated').slice(0, 10);
        gesprekken.push({ pad: p, naam: gesprekNaam(p), bron: gesprekBron(p, fm),
          datum: /^\d{4}-\d{2}-\d{2}$/.test(upd) ? upd : (typeof x.m === 'number' && isFinite(x.m) && x.m > 0 ? amsDag(x.m) : null),
          onderwerp: eersteOnderwerp(ruw) });
      } else if (d.indexOf('Notulen') >= 0 && d.indexOf('Notulen') < d.length - 1) {
        // alleen een vergadering met datum vooraan ("2026-10-14 - …", ook "2024-12 - …"); agenda en voorbereiding zijn geen notulen
        const naam = stamVan(p);
        const dm = /^(\d{4}-\d{2}(?:-\d{2})?)\s*-\s*(.+)$/.exec(naam);
        if (!dm || /^(?:Agenda|Concept-agenda|Voorbereiding)\b/i.test(dm[2])) return;
        notulen.push({ pad: p, titel: dm[2], datum: dm[1] });
      }
    });
    const nieuwst = function (a, z) { return String(z.datum || '').localeCompare(String(a.datum || '')) || a.pad.localeCompare(z.pad); };
    gesprekken.sort(nieuwst); notulen.sort(nieuwst);
    const v = { gesprekken: gesprekken, notulen: notulen };
    gezegdCache = { b: b, t: nu(), v: v };
    return v;
  }
  function gesprekRegel(g) {
    return { pad: g.pad, titel: masker(g.naam), bron: g.bron, datum: g.datum, onderwerp: g.onderwerp ? masker(g.onderwerp) : null };
  }
  // { gesprekken[≤ 40], totaal, notulen[≤ 3], notulen_totaal } | { fout } | undefined (geen blok: geen eigen entiteit en geen persoon)
  function gezegdVan(k, persoon) {
    const eigen = k && isEigen(k);
    if (!eigen && !persoon) return undefined;
    const gi = gesprekIndex();
    if (!gi) return { gesprekken: [], totaal: 0, notulen: [], notulen_totaal: 0, fout: 'De kaart van de vault is nu niet te lezen.' };
    let g, n = [];
    if (eigen) {
      const w = wortelVan(k.vault_pagina);
      if (!w) return undefined;
      g = gi.gesprekken.filter(function (x) { return x.pad.indexOf(w) === 0; });
      n = gi.notulen.filter(function (x) { return x.pad.indexOf(w) === 0; });
    } else {
      const pat = persoon.patronen.filter(function (x) { return x.indexOf(' ') > 0; });   // alleen volledige namen ("Anne" alleen is te los)
      g = pat.length ? gi.gesprekken.filter(function (x) { return bevatNaam(x.naam, pat); }) : [];
    }
    return { gesprekken: g.slice(0, GESPREK_MAX).map(gesprekRegel), totaal: g.length,
      notulen: n.slice(0, NOTULEN_TOON).map(function (x) { return { pad: x.pad, titel: masker(x.titel), datum: x.datum }; }), notulen_totaal: n.length };
  }

  // wv3945 (3C98): de mensen van een eigen entiteit uit <wortel>Medewerkers/*.md (type medewerker). undefined = geen medewerkerspagina's (geen blok).
  function mensenVan(k, reg) {
    if (!isEigen(k)) return undefined;
    const w = wortelVan(k.vault_pagina);
    const b = kaart();
    if (!w || w === '20_Prive/' || !Array.isArray(b)) return undefined;
    const vandaag = amsDag(nu());
    const pre = w + 'Medewerkers/';
    const opPagina = new Map();
    reg.knopen.forEach(function (x) { if (zichtbaar(x) && x.vault_pagina) opPagina.set(String(x.vault_pagina), sleutelVan(x.id)); });
    const gesprekPaden = b.map(function (x) { return String(x && x.p || ''); }).filter(function (p) { return p.indexOf(pre + 'Gesprekken/') === 0; });
    const uit = [];
    b.forEach(function (x) {
      const p = String(x && x.p || '');
      if (p.indexOf(pre) !== 0 || !/\.md$/i.test(p) || p.slice(pre.length).indexOf('/') >= 0 || p.split('/').indexOf('..') >= 0) return;
      let ruw; try { ruw = lees(path.join(vault, p)); } catch (e) { return; }
      const fm = frontmatter(ruw);
      if (fmVeld(fm, 'type') !== 'medewerker') return;
      const naam = fmVeld(fm, 'naam') || stamVan(p).split(' - ')[0];
      const status = fmVeld(fm, 'status');
      const eind = contractEinde(fm);
      const weg = UIT_DIENST_RE.test(status) || /\((?:uit dienst|oud)\b/i.test(stamVan(p)) || (!!eind && eind < vandaag);
      const pat = naamPatronen([naam, stamVan(p).split(' - ')[0]].concat(fmAliassen(fm)));
      // eerstvolgende datum: deadline van deze persoon (vandaag of later) of een geplande gespreksleidraad in Gesprekken/<naam>/
      let volgende = null;
      const dl = (deadlinesVan(null, { pagina: p, patronen: pat }) || []).filter(function (y) { return y.dagen >= 0; });
      if (dl.length) volgende = { soort: 'deadline', datum: dl[0].datum, dagen: dl[0].dagen, titel: dl[0].titel };
      const volPat = pat.filter(function (y) { return y.indexOf(' ') > 0; });
      gesprekPaden.forEach(function (gp) {
        const deel = gp.slice((pre + 'Gesprekken/').length).split('/');
        if (deel.length !== 2 || !volPat.length || !bevatNaam(deel[0], volPat)) return;
        const dm = /^(\d{4}-\d{2}-\d{2})\s*-\s*(.+)$/.exec(stamVan(gp));
        if (!dm || dm[1] < vandaag || !/leidraad|gepland|uitnodiging/i.test(dm[2])) return;
        if (!volgende || dm[1] < volgende.datum) volgende = { soort: 'gesprek', datum: dm[1], titel: masker(dm[2].slice(0, 160)), pad: gp };
      });
      uit.push({ naam: masker(naam), functie: masker(fmVeld(fm, 'functie').slice(0, 120)) || null, status: masker(status.slice(0, 200)) || null,
        start: /^\d{4}-\d{2}-\d{2}$/.test(fmVeld(fm, 'startdatum')) ? fmVeld(fm, 'startdatum') : null,
        contract_tot: eind && eind >= vandaag ? eind : null, in_dienst: !weg, pad: p, sleutel: opPagina.get(p) || null, volgende: volgende });
    });
    if (!uit.length) return undefined;
    uit.sort(function (a, z) { return a.naam.localeCompare(z.naam, 'nl'); });
    return { in_dienst: uit.filter(function (x) { return x.in_dienst; }), uit_dienst: uit.filter(function (x) { return !x.in_dienst; }), totaal: uit.length };
  }

  async function lijst() {
    const reg = await register();
    const uit = reg.knopen.filter(function (k) { return zichtbaar(k); }).map(function (k) {
      return { id: k.id, sleutel: sleutelVan(k.id), naam: masker(k.naam), groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.slice() : [],
        aliassen: (k.aliassen || []).slice(0, 5).map(masker), prive: priveKant(k), pagina: !!k.vault_pagina, handvatten: (reg.handvatten[k.id] || []).length, register: true };
    });
    const pv = prive();
    const metKnoop = new Set(reg.knopen.filter(function (k) { return k.actief !== false; }).map(function (k) { return String(k.vault_pagina || ''); }));   // review ZOU 7
    pv.personen.forEach(function (x) { if (!metKnoop.has(x.pad)) uit.push(priveRegel(x)); });
    const stamboom = pv.stamboom.length, priveFout = pv.fout;
    uit.sort(function (a, b) { return (a.groep === 'eigen' ? 0 : 1) - (b.groep === 'eigen' ? 0 : 1) || a.naam.localeCompare(b.naam, 'nl'); });
    const groepen = {};
    uit.forEach(function (k) { groepen[k.groep] = (groepen[k.groep] || 0) + 1; });
    // wv3938 (3C45): tegels van de eigen entiteiten en de laatst bekeken partijen (alleen sleutels die in de lijst staan)
    const inLijst = new Set(uit.map(function (k) { return k.sleutel; }));
    let bk = []; try { bk = bekeken() || []; } catch (e) { bk = []; }
    const laatst = []; bk.forEach(function (x) { if (x && inLijst.has(x.s) && laatst.indexOf(x.s) < 0 && laatst.length < BEKEKEN_TOON) laatst.push(x.s); });
    return { ok: true, vaste_plek: false, knopen: uit, groepen: groepen, totaal: uit.length, stamboom: stamboom, prive_fout: priveFout, gemeten_op: new Date(nu()).toISOString(),
      eigen_tegels: eigenTegels(reg), bekeken: laatst, tegel_dagen: { deadlines: DEADLINE_TEGEL_DAGEN, stukken: STUK_NIEUW_DAGEN } };
  }

  // Zoeken in de stamboom (wv1930): q = woorden zonder accenten (de app stuurt a-z, 0-9 en -), ten minste 2 tekens; treffers op naam
  async function zoek(q) {
    const w = woorden(String(q || '').replace(/-/g, ' '));
    if (w.replace(/ /g, '').length < 2) return { ok: true, q: w, knopen: [], totaal: 0 };
    const pv = prive();
    const hit = pv.stamboom.filter(function (x) { return woorden(x.naam).indexOf(w) >= 0 || norm(x.naam).indexOf(w.replace(/ /g, '')) >= 0; })
      .sort(function (a, b) { return a.naam.localeCompare(b.naam, 'nl'); });
    return { ok: true, q: w, knopen: hit.slice(0, ZOEK_MAX).map(priveRegel), totaal: hit.length };
  }

  // wv2077 (David 31-10: "als ik een naam of entiteit zoek, moet de Entiteitspagina bovenaan staan"): voor Brain › Zoeken de partijen
  // waarvan de naam, een alias (register, handvat of pagina) of de paginanaam past, met hun vaultpad. Alleen hele woorden of het begin van
  // een woord ("Abel" past niet in "Allekabels"). sterk: 0 = precies de naam, 1 = alle woorden als heel woord, 2 = begin van een woord.
  // Zelfde grens als de lijst (zichtbaar); secondbrain.js toetst elk pad daarna nog aan de kaart.
  async function naamTreffers(q) {
    const qw = woorden(q);
    const qs = qw ? qw.split(' ') : [];
    if (qw.replace(/ /g, '').length < 2) return [];
    const sterkVan = function (namen) {
      let best = 9;
      namen.forEach(function (n) {
        const w = woorden(n);
        if (!w) return;
        if (w === qw) { best = 0; return; }
        const ws = w.split(' ');
        if (qs.every(function (x) { return ws.indexOf(x) >= 0; })) best = Math.min(best, 1);
        else if (qs.every(function (x) { return ws.some(function (y) { return y.indexOf(x) === 0; }); })) best = Math.min(best, 2);
      });
      return best;
    };
    const stam = function (p) { return stamVan(p).replace(/^Entiteit - /, ''); };
    const uit = [];
    let reg = null;
    try { reg = await register(); } catch (e) { reg = null; }
    if (reg) reg.knopen.forEach(function (k) {
      const rel = String(k.vault_pagina || '');
      if (k.actief === false || !zichtbaar(k) || !PAGINA_RE.test(rel) || rel.split('/').indexOf('..') >= 0) return;
      const namen = [k.naam, stam(rel)].concat(k.aliassen || []).concat((reg.handvatten[k.id] || []).filter(function (h) { return h.soort === 'alias'; }).map(function (h) { return h.waarde; }));
      const s = sterkVan(namen);
      if (s < 9) uit.push({ pad: rel, naam: masker(k.naam), soort: ROL_WOORD[k.rol] || (isPersoon(k) ? 'persoon' : null), sleutel: sleutelVan(k.id), sterk: s, r: isEigen(k) ? 0 : 1 });
    });
    {
      const pv = prive();
      const gehad = new Set(uit.map(function (x) { return x.pad; }));
      pv.personen.concat(pv.stamboom).forEach(function (x) {
        if (gehad.has(x.pad)) return;
        const s = sterkVan([x.naam, stamVan(x.pad)].concat(x.aliassen || []));
        if (s < 9) uit.push({ pad: x.pad, naam: masker(x.naam), soort: x.rol === 'stamboom' ? 'stamboom' : 'privé', sleutel: sleutelVan(x.pad), sterk: s, r: x.rol === 'stamboom' ? 3 : 2 });
      });
    }
    uit.sort(function (a, b) { return a.sterk - b.sterk || a.r - b.r || a.naam.localeCompare(b.naam, 'nl'); });
    return uit.slice(0, 20).map(function (x) { return { pad: x.pad, naam: x.naam, soort: x.soort, sleutel: x.sleutel, sterk: x.sterk }; });
  }

  const LEEG_REGISTER = { concept: false, compilatie: null, gecompileerd_op: null };

  // Detail van een privépersoon uit de vault (geen knoop): hele pagina, deadlines en Dossier
  function priveDetail(x, reg) {
    let tekst = null, paginaFout = null, ruw = '';
    try { ruw = lees(path.join(vault, x.pad)); tekst = paginaTekst(ruw, { masker: masker, link: linkVan }); }
    catch (e) { paginaFout = 'De pagina is nu niet te lezen.'; }
    const fm = frontmatter(ruw);
    const aliassen = x.aliassen.length ? x.aliassen : fmAliassen(fm);
    const pat = naamPatronen([x.naam, stamVan(x.pad), fmVeld(fm, 'onderwerp')].concat(aliassen));
    const r = priveRegel(Object.assign({}, x, { aliassen: aliassen }));
    return { status: 200, j: { ok: true, vaste_plek: false,
      knoop: { id: r.id, naam: r.naam, groep: 'prive', rol: x.rol, concept: false, voor: ['PRIVE'], aliassen: aliassen.map(masker), prive: true,
        pagina_pad: paginaFout ? null : x.pad, opmerking: null, register: false },
      tekst: tekst, pagina_fout: paginaFout, links: reg ? partijLinks([tekst], reg) : {},
      weet: { handvatten: [], kvk: null, agb: null, iban: null, facturen: null, deadlines: deadlinesVan(null, { pagina: x.pad, patronen: pat }),
        contact: null, stukken: null, gezegd: gezegdVan(null, { patronen: pat }), register: LEEG_REGISTER, in_register: false },
      dossier: dossierVan(x.pad, pat) } };
  }

  // wv4236 (L52): één tijdlijnvraag per 5 minuten voor alle partijen (venster vandaag t/m +14); elke bron hooguit 4 s, mislukt = null
  function binnen(pr, ms) { return Promise.race([Promise.resolve(pr), new Promise(function (_, nee) { setTimeout(function () { nee(new Error('te traag')); }, ms); })]); }
  async function looptVan(k, paden, objectId) {
    if (!tijdlijn && !voorJou) return undefined;
    const vandaag = amsDag(nu()), tot = amsDag(nu() + LOOPT_DAGEN * 86400000);
    let rijen = null, punten = null;
    if (tijdlijn) {
      if (tlCache && tlCache.dag === vandaag && nu() - tlCache.op < 300000) rijen = tlCache.rijen;
      else {
        try { const r = await binnen(tijdlijn(vandaag, tot), 4000); if (Array.isArray(r)) { rijen = r; tlCache = { dag: vandaag, op: nu(), rijen: r }; } } catch (e) { rijen = null; }
      }
    }
    if (voorJou) { try { const p = await binnen(voorJou(), 4000); punten = Array.isArray(p) ? p : null; } catch (e) { punten = null; } }
    return looptUit(rijen, punten, { id: k.id, eigen: isEigen(k), persoon: isPersoon(k), paden: paden, objectId: objectId, vandaag: vandaag, tot: tot, masker: masker, nu: nu() });
  }

  // detail op knoop-id, op de sleutel uit de lijst (12 hex) of op de sleutel van een privépersoon
  async function detail(id) {
    const reg = await register();
    const isSl = /^[0-9a-f]{12}$/.test(String(id));
    const k = reg.knopen.find(function (x) { return x.id === id; }) || (isSl ? reg.knopen.find(function (x) { return sleutelVan(x.id) === id; }) : undefined);
    if (!k) {
      if (isSl) {
        const pv = prive();
        const x = pv.personen.concat(pv.stamboom).find(function (y) { return sleutelVan(y.pad) === id; });
        if (x) return priveDetail(x, reg);
      }
      return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
    }
    if (!zichtbaar(k)) return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
    const eigen = isEigen(k), persoon = isPersoon(k);
    let tekst = null, paginaFout = null, ruw = '';
    const rel = String(k.vault_pagina || '');
    if (!PAGINA_RE.test(rel) || rel.split('/').indexOf('..') >= 0) paginaFout = 'Geen pagina in het register.';
    else {
      try { ruw = lees(path.join(vault, rel)); tekst = paginaTekst(ruw, { masker: masker, link: linkVan }); }
      catch (e) { paginaFout = 'De pagina is nu niet te lezen.'; }
    }
    // wv3938 (3C50): de hoofdpagina uit de frontmatter (hoofdpagina: "[[10_Zakelijk/<map>/index]]") met tikbare verwijzingen
    let hoofdpagina;
    const hpVeld = fmVeld(frontmatter(ruw), 'hoofdpagina');
    if (hpVeld) {
      const hm = /\[\[([^\]|#]+)/.exec(hpVeld);
      const hpPad = hm ? linkVan(hm[1]) : null;
      if (!hpPad || !PAGINA_RE.test(hpPad) || hpPad === rel) hoofdpagina = { pad: null, tekst: null, fout: 'De hoofdpagina staat niet (meer) op die plek.' };
      else {
        try { const hr = lees(path.join(vault, hpPad)); hoofdpagina = { pad: hpPad, tekst: paginaTekst(hr, { masker: masker, link: linkVan }), regels: String(hr).split('\n').length }; }
        catch (e) { hoofdpagina = { pad: null, tekst: null, fout: 'De hoofdpagina is nu niet te lezen.' }; }
      }
    }
    const ib = geenMasker;
    const h = (reg.handvatten[k.id] || []).map(function (x) {
      return { soort: HANDVAT_WOORD[x.soort] || x.soort, waarde: masker(ib(String(x.waarde))).slice(0, x.soort === 'kenmerkpatroon' ? 60 : 120),
        status: STATUS_WOORD[x.status] || x.status, intrekking: !!x.intrekking };
    });
    const fm = frontmatter(ruw);
    const aliassen = (k.aliassen || []).concat(fmAliassen(fm)).concat((reg.handvatten[k.id] || []).filter(function (x) { return x.soort === 'alias'; }).map(function (x) { return x.waarde; }));
    const pat = persoon ? naamPatronen([k.naam, rel ? stamVan(rel) : ''].concat(aliassen)) : [];
    const weet = { handvatten: h,
      kvk: k.kvk ? masker(String(k.kvk)) : null, agb: k.agb ? masker(String(k.agb)) : null,
      iban: !k.iban ? null : masker(String(k.iban)),
      facturen: facturenVan(k, reg),
      bank: bankVan(k, reg),   // wv3298
      eigen_geld: eigenGeldVan(k, reg),   // wv3944 (3C57): alleen bij een eigen entiteit (undefined = andere partij of oude bank-partij.js)
      deadlines: deadlinesVan(k, persoon ? { pagina: rel, patronen: pat } : null),
      contact: !persoon ? null : await googleVan(k, reg),   // wv1771
      nu: eigen ? nuVan(k.id) : undefined,   // wv3715 (3C165): bovenaan de kaart; undefined = oude pod/geen module (geen blok)
      stukken: stukkenVan(k, reg),   // wv3938 (3C22): nieuwste stukken uit Intake (null = geen intake.sqlite in deze pod)
      gezegd: gezegdVan(k, persoon ? { patronen: pat } : null),   // wv3945 (3C97): gesprekspagina's (+ notulen bij een eigen entiteit)
      mensen: eigen ? mensenVan(k, reg) : undefined,   // wv3945 (3C98): medewerkers in en uit dienst
      loopt: await looptVan(k, [rel, hoofdpagina && hoofdpagina.pad].filter(Boolean), fmVeld(fm, 'object_id') || null),   // wv4236 (L52): undefined = geen bron in deze pod
      bereik: persoon ? { telefoons: fmOvisLijst(fm, 'telefoons').map(telNl).filter(function (x) { return /^0[0-9]{9,15}$/.test(x); }),
        mailadressen: fmOvisLijst(fm, 'mailadressen').map(function (x) { return x.toLowerCase(); }).filter(function (x) { return /^[^@\s?&"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(x) && x.length <= 120; }),
        whatsapp: fmOvisLijst(fm, 'whatsapp').map(telNl).filter(function (x) { return /^0[0-9]{9,15}$/.test(x); }) } : undefined,   // wv3945: uit de pagina (Contacten via de compiler), naast Google
      register: { concept: !!k.concept, compilatie: k.compilatienummer || null, gecompileerd_op: k.gecompileerd_op || null }, in_register: true };
    return { status: 200, j: { ok: true, vaste_plek: false,
      knoop: { id: k.id, naam: masker(k.naam), groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.slice() : [], aliassen: (k.aliassen || []).map(masker), prive: priveKant(k),
        pagina_pad: paginaFout ? null : rel, opmerking: k.opmerking ? masker(ib(String(k.opmerking))).slice(0, 400) : null, register: true },
      tekst: tekst, pagina_fout: paginaFout, weet: weet, hoofdpagina: hoofdpagina,
      links: partijLinks([tekst, hoofdpagina && hoofdpagina.tekst], reg),   // wv3938: [[pad|…]] die een partij is → haar sleutel
      dossier: !persoon ? null : dossierVan(rel, pat, (Array.isArray(k.voor) ? k.voor : []).map(function (c) {
        const e = reg.knopen.find(function (x) { return x.id === c && isEigen(x); });
        return e ? wortelVan(e.vault_pagina) : null;
      })) } };
  }

  // ── wv4009 (3C196): mail per partij — mailkaarten eerst, het lees-luik alleen na de jongste kaart (begrensd, 30 min cache) ──
  const luik = typeof o.luik === 'function' ? o.luik : null;   // body → json (actie mail_zoeken), alleen lezen
  const eigenAdressen = typeof o.eigenAdressen === 'function' ? o.eigenAdressen : function () { return []; };
  const mailMs = o.mailIndexMs > 0 ? o.mailIndexMs : 6 * 3600000;   // index hooguit eens per 6 uur opnieuw (of eerder als een map verandert)
  let mailIdx = null, mailIdxBezig = null;
  const luikCache = new Map(), luikBezig = new Map();
  let luikTik = [];
  function mailSig() {
    const fs = require('fs');
    return MAIL_MAPPEN.map(function (m) { try { const d = path.join(vault, MAIL_PREFIX + m); return fs.statSync(d).mtimeMs + ':' + fs.readdirSync(d).length; } catch (e) { return '-'; } }).join('|');
  }
  function mailIndex() {
    const sig = mailSig();
    if (mailIdx && mailIdx.sig === sig && nu() - mailIdx.t < mailMs) return mailIdx;
    const fs = require('fs');
    const kaarten = [];
    MAIL_MAPPEN.forEach(function (m) {
      let namen = [];
      try { namen = fs.readdirSync(path.join(vault, MAIL_PREFIX + m)).filter(function (n) { return /\.md$/i.test(n) && n.indexOf('/') < 0; }).sort(); } catch (e) { return; }
      namen.forEach(function (n) {
        const p = MAIL_PREFIX + m + '/' + n;
        let ruw; try { ruw = lees(path.join(vault, p)); } catch (e) { return; }
        if (/^Register /.test(m)) mailRegisterLees(ruw, p).forEach(function (x) { kaarten.push(x); });
        else { const x = mailKaartLees(ruw, p); if (x) kaarten.push(x); }
      });
    });
    const opDossier = new Map(), opPad = new Map(), opAdres = new Map(), opDomein = new Map();
    const bij = function (mp, s, x) { if (!s) return; const l = mp.get(s); if (l) { if (l.indexOf(x) < 0) l.push(x); } else mp.set(s, [x]); };
    let mom = null;
    kaarten.forEach(function (x) {
      bij(opDossier, x.dossier, x);
      if (!x.register) bij(opPad, x.pad, x);
      x.adressen.forEach(function (a) { bij(opAdres, a, x); });
      if (x.soort === 'organisatie') bij(opDomein, x.domein, x);
      if (x.momentopname && (!mom || x.momentopname > mom)) mom = x.momentopname;
    });
    mailIdx = { sig: sig, t: nu(), kaarten: kaarten.length, opDossier: opDossier, opPad: opPad, opAdres: opAdres, opDomein: opDomein, momentopname: mom };
    return mailIdx;
  }
  // middernacht (Nederlandse tijd) van een dag als epoch-ms
  function amsMiddernacht(ymd) {
    for (const off of ['+01:00', '+02:00']) { const t = Date.parse(ymd + 'T00:00:00' + off); if (amsDag(t) === ymd && amsDag(t - 1) !== ymd) return t; }
    return Date.parse(ymd + 'T00:00:00Z');
  }
  function dagNa(ymd) { return amsDag(amsMiddernacht(ymd) + 36 * 3600000); }
  // Lees-luik over [van, tot) (epoch-s); vol (25) = venster halveren, hooguit MAIL_LUIK_DELEN vragen. → { mails[], vol, vragen } | { fout }
  async function luikVenster(adressen, domeinen, vanS, totS) {
    const ramen = [[vanS, totS]], alle = [];
    let vragen = 0, vol = false;
    const start = nu();
    while (ramen.length) {
      if (vragen > 0 && nu() - start > MAIL_LUIK_BUDGET_MS) { vol = true; break; }   // de rest van het venster niet gelezen: "minstens"
      const r = ramen.shift();
      luikTik = luikTik.filter(function (t) { return nu() - t < 3600000; });
      if (luikTik.length >= MAIL_LUIK_UUR) return { fout: 'Gmail is dit uur al vaak gevraagd; de laatste weken komen er later bij.' };
      luikTik.push(nu()); vragen++;
      const q = mailZoekvraag(adressen, domeinen, String(r[0]), String(r[1]));
      let j;
      try { j = await luik({ actie: 'mail_zoeken', query: q, max: MAIL_LUIK_MAX }); } catch (e) { return { fout: 'Gmail is nu niet te lezen.' }; }
      if (!j || j.fout || j.melding || !Array.isArray(j.mails)) return { fout: 'Gmail gaf geen bruikbaar antwoord.' };
      j.mails.forEach(function (m) { alle.push(m); });
      if (j.mails.length >= MAIL_LUIK_MAX) {
        if (vragen + ramen.length + 2 <= MAIL_LUIK_DELEN && r[1] - r[0] > 3600) { const mid = Math.floor((r[0] + r[1]) / 2); ramen.push([r[0], mid + 60], [mid, r[1]]); }
        else vol = true;
      }
    }
    return { mails: alle, vol: vol, vragen: vragen };
  }
  // Kenmerken van een partij: pagina's (+ hoofdpagina), 'mailkaart:' op die pagina's, mailadressen en domeinen
  function mailKenmerken(paginas, extraAdressen, extraDomeinen) {
    const uit = { paginas: [], kaartlinks: [], adressen: [], domeinen: [] };
    const adres = function (a) { const x = adresNorm(a); if (x && uit.adressen.indexOf(x) < 0) uit.adressen.push(x); };
    const domein = function (d) { const x = domeinNorm(d); if (x && uit.domeinen.indexOf(x) < 0) uit.domeinen.push(x); };
    const rij = paginas.filter(Boolean);
    for (let i = 0; i < rij.length && i < 3; i++) {   // de pagina en (via 'hoofdpagina:') hooguit twee verder
      const p = rij[i];
      if (uit.paginas.indexOf(p) >= 0) continue;
      uit.paginas.push(p);
      let ruw = ''; try { ruw = lees(path.join(vault, p)); } catch (e) { continue; }
      const fm = frontmatter(ruw);
      const mk = linkPad(fmVeld(fm, 'mailkaart')); if (mk && uit.kaartlinks.indexOf(mk) < 0) uit.kaartlinks.push(mk);
      fmOvisLijst(fm, 'mailadressen').forEach(adres);
      const hp = fmVeld(fm, 'hoofdpagina');
      if (hp) { const hm = /\[\[([^\]|#]+)/.exec(hp); const hpPad = hm ? linkVan(hm[1]) : null; if (hpPad && PAGINA_RE.test(hpPad) && hpPad.split('/').indexOf('..') < 0) rij.push(hpPad); }
    }
    (extraAdressen || []).forEach(adres); (extraDomeinen || []).forEach(domein);
    return uit;
  }
  const RICHTING = { '⇄': 'beide', '←': 'ontvangen', '→': 'verstuurd' };
  // → { status, j: { ok, mail } }
  async function mail(id) {
    const reg = await register();
    const isSl = /^[0-9a-f]{12}$/.test(String(id));
    if (!isSl) return { status: 400, j: { ok: false, fout: 'geen geldige sleutel' } };
    const k = reg.knopen.find(function (x) { return sleutelVan(x.id) === id; });
    let ken, sleutelCache, persoon = !k;
    if (k) {
      persoon = isPersoon(k);
      if (!zichtbaar(k)) return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
      const hv = reg.handvatten[k.id] || [];
      const adr = hv.filter(function (h) { return h.soort === 'mail'; }).map(function (h) { return h.waarde_norm || h.waarde; });
      const dom = hv.filter(function (h) { return h.soort === 'domein'; }).map(function (h) { return h.waarde_norm || h.waarde; });
      if (isPersoon(k)) { const g = await googleVan(k, reg); if (g && Array.isArray(g.mailadressen)) g.mailadressen.forEach(function (a) { adr.push(a); }); }
      const rel = String(k.vault_pagina || '');
      ken = mailKenmerken(PAGINA_RE.test(rel) && rel.split('/').indexOf('..') < 0 ? [rel] : [], adr, dom);
      sleutelCache = k.id;
    } else {
      const pv = prive();
      const x = pv.personen.concat(pv.stamboom).find(function (y) { return sleutelVan(y.pad) === id; });
      if (!x) return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
      ken = mailKenmerken([x.pad], [], []);
      sleutelCache = 'prive:' + x.pad;
    }
    let idx;
    try { idx = mailIndex(); } catch (e) { idx = null; }
    // kaarten: via dossier/pagina, 'mailkaart:', exact mailadres, of (organisatie) domein
    const gekozen = [];
    const neem = function (l) { (l || []).forEach(function (x) { if (gekozen.indexOf(x) < 0) gekozen.push(x); }); };
    if (idx) {
      ken.paginas.forEach(function (p) { neem(idx.opDossier.get(p)); });
      ken.kaartlinks.forEach(function (p) { neem(idx.opPad.get(p)); });
      // review MOET 1: bij een persoon via adres/domein alleen persoonskaarten (een gedeeld adres mag niet de hele organisatie binnenhalen);
      // een organisatiekaart alleen via een uitdrukkelijke koppeling (dossier/'mailkaart:')
      const mag = function (l) { return persoon ? (l || []).filter(function (x) { return x.soort === 'persoon'; }) : l; };
      ken.adressen.forEach(function (a) { neem(mag(idx.opAdres.get(a))); });
      ken.domeinen.forEach(function (d) { neem(mag(idx.opDomein.get(d))); });
    }
    // een persoonskaart waarvan elk adres al onder een gekozen organisatiedomein valt, telt niet nog eens (die mails staan op de organisatiekaart)
    const orgDom = gekozen.filter(function (x) { return x.soort === 'organisatie' && x.domein; }).map(function (x) { return x.domein; });
    const kaarten = gekozen.filter(function (x) {
      return !(x.soort === 'persoon' && x.adressen.length && x.adressen.every(function (a) { const d = a.slice(a.lastIndexOf('@') + 1); return orgDom.some(function (od) { return d === od || d.endsWith('.' + od); }); }));
    });
    // kenmerken voor het luik: die van de partij plus de adressen/domeinen van haar kaarten (een kaart zonder kenmerk op de partij)
    const eigen = eigenToets(eigenAdressen());
    const adressen = ken.adressen.slice(), domeinen = persoon ? [] : ken.domeinen.slice();   // review MOET 1: een persoon nooit op een heel domein
    kaarten.forEach(function (x) {
      x.adressen.forEach(function (a) { if (adressen.indexOf(a) < 0) adressen.push(a); });
      if (!persoon && x.soort === 'organisatie' && x.domein && domeinen.indexOf(x.domein) < 0) domeinen.push(x.domein);   // review ronde 2 MOET 1
    });
    const adrL = adressen.filter(function (a) { return !eigen(a); });
    if (!kaarten.length && !adrL.length && !domeinen.length) {
      return { status: 200, j: { ok: true, mail: { kenmerken: false, aantal: 0, gesprekken: 0, laatste: null, wisselingen: [], kaarten: [], kaart: null, luik: null } } };
    }
    const kaartMails = kaarten.reduce(function (s, x) { return s + x.mails; }, 0);
    const kaartGespr = kaarten.reduce(function (s, x) { return s + x.gesprekken; }, 0);
    const kaartIds = new Set(); kaarten.forEach(function (x) { x.ids.forEach(function (i) { kaartIds.add(i); }); });
    const momentopname = kaarten.reduce(function (s, x) { return x.momentopname && (!s || x.momentopname > s) ? x.momentopname : s; }, null) || (idx && idx.momentopname) || null;
    const kaartLaatste = kaarten.reduce(function (s, x) { return x.laatste && (!s || x.laatste > s) ? x.laatste : s; }, null);
    // luik: vanaf de dag na de momentopname (geen kaarten in deze pod: de laatste 90 dagen) tot nu
    const vandaag = amsDag(nu());
    const vanaf = momentopname || amsDag(nu() - 90 * 86400000);
    let luikDeel = null;
    const termen = adrL.concat(domeinen);
    if (!luik) luikDeel = { vanaf: dagNa(vanaf), mails: 0, gesprekken: 0, vol: false, fout: 'Het lees-luik zit niet in deze pod.' };
    else if (vanaf >= vandaag) luikDeel = { vanaf: dagNa(vanaf), mails: 0, gesprekken: 0, vol: false, fout: null };
    else if (!termen.length) luikDeel = { vanaf: dagNa(vanaf), mails: 0, gesprekken: 0, vol: false, fout: 'Geen mailadres of domein bekend om in Gmail te zoeken.' };
    else {
      const tA = termen.slice(0, MAIL_TERMEN_MAX), afgekapt = termen.length > MAIL_TERMEN_MAX;
      const ad = tA.filter(function (x) { return x.indexOf('@') >= 0; }), dm = tA.filter(function (x) { return x.indexOf('@') < 0; });
      const sl = sleutelCache + '|' + tA.join(',') + '|' + vanaf;
      const c = luikCache.get(sl);
      if (c && nu() - c.t < MAIL_LUIK_MS) luikDeel = c.v;
      else {
        let p = luikBezig.get(sl);
        if (!p) {
          p = (async function () {
            const r = await luikVenster(ad, dm, Math.floor(amsMiddernacht(dagNa(vanaf)) / 1000), Math.floor(nu() / 1000) + 600);
            if (r.fout) return { v: { vanaf: dagNa(vanaf), mails: 0, gesprekken: 0, vol: false, fout: r.fout, afgekapt: afgekapt }, bewaar: false };
            const t = mailLuikTel(r.mails, { adressen: ad, domeinen: dm }, eigen, vanaf);
            const draden = Array.from(t.draden.values()).sort(function (a, b) { return b.datum.localeCompare(a.datum) || a.id.localeCompare(b.id); });
            return { v: { vanaf: dagNa(vanaf), mails: t.mails, gesprekken: draden.filter(function (d) { return !kaartIds.has(d.id); }).length, vol: r.vol, fout: null,
              afgekapt: afgekapt, draden: draden.slice(0, MAIL_TOON), laatste: draden.length ? draden[0].datum : null, gemeten_op: new Date(nu()).toISOString() }, bewaar: true };
          })();
          luikBezig.set(sl, p);
          p.then(function (x) {
            luikBezig.delete(sl);
            if (x.bewaar) { luikCache.set(sl, { t: nu(), v: x.v }); while (luikCache.size > MAIL_LUIK_CACHE_MAX) luikCache.delete(luikCache.keys().next().value); }
          }, function () { luikBezig.delete(sl); });
        }
        try { luikDeel = (await p).v; } catch (e) { luikDeel = { vanaf: dagNa(vanaf), mails: 0, gesprekken: 0, vol: false, fout: 'Gmail is nu niet te lezen.' }; }
      }
    }
    // wisselingen: luik eerst (nieuwer, en een doorlopend gesprek vervangt zijn kaartregel), dan de kaartregels; nieuwste eerst, vijf
    const wis = [], gehad = new Set();
    (luikDeel && luikDeel.draden || []).forEach(function (d) { gehad.add(d.id); wis.push({ datum: d.datum, richting: RICHTING[d.richting] || 'beide', onderwerp: masker(d.onderwerp), n: d.n, bron: 'luik' }); });
    const kr = [];
    kaarten.forEach(function (x) { x.regels.forEach(function (r) { kr.push(r); }); });
    kr.sort(function (a, b) { return b.datum.localeCompare(a.datum) || a.id.localeCompare(b.id); });
    kr.forEach(function (r) { if (gehad.has(r.id)) return; gehad.add(r.id); wis.push({ datum: r.datum, richting: RICHTING[r.richting] || 'beide', onderwerp: masker(r.onderwerp), n: r.n, bron: 'kaart' }); });
    wis.sort(function (a, b) { return b.datum.localeCompare(a.datum); });
    const lm = luikDeel ? luikDeel.mails : 0;
    const laatste = [kaartLaatste, luikDeel && luikDeel.laatste].filter(Boolean).sort().pop() || null;
    const luikUit = luikDeel ? { vanaf: luikDeel.vanaf, mails: luikDeel.mails, gesprekken: luikDeel.gesprekken, vol: !!luikDeel.vol, fout: luikDeel.fout || null,
      afgekapt: !!luikDeel.afgekapt, gemeten_op: luikDeel.gemeten_op || null } : null;
    return { status: 200, j: { ok: true, mail: { kenmerken: true, aantal: kaartMails + lm, gesprekken: kaartGespr + (luikDeel ? luikDeel.gesprekken : 0), laatste: laatste,
      wisselingen: wis.slice(0, MAIL_TOON),
      kaarten: kaarten.filter(function (x) { return !x.register; }).sort(function (a, b) { return b.mails - a.mails; }).slice(0, 5).map(function (x) { return { pad: x.pad, naam: masker(x.naam), mails: x.mails }; }),
      kaart: kaarten.length ? { mails: kaartMails, gesprekken: kaartGespr, laatste: kaartLaatste, momentopname: momentopname, aantal: kaarten.length } : null,
      luik: luikUit } } };
  }

  // wv3715 (3C165): tegels voor het Overzicht — per eigen entiteit (niet PRIVE) de eerste regel "Nu", de datum en het aantal regels
  async function nuTegels() {
    const reg = await register();
    const tegels = reg.knopen.filter(function (k) { return zichtbaar(k) && isEigen(k) && String(k.id) !== 'PRIVE'; }).map(function (k) {
      const n = nuVan(k.id);
      return { sleutel: sleutelVan(k.id), code: String(k.id), naam: masker(k.naam), datum: n ? n.datum : null, dagen_oud: n ? n.dagen_oud : null,
        regels: n ? n.regels.length : 0, eerste: n && n.regels[0] ? { soort: n.regels[0].soort, tekst: masker(n.regels[0].tekst) } : null };
    }).filter(function (t) { return t.datum; });
    tegels.sort(function (a, b) { return b.regels - a.regels || a.naam.localeCompare(b.naam, 'nl'); });
    return { ok: true, tegels: tegels, aan: !!entNu };
  }

  return { lijst: lijst, zoek: zoek, detail: detail, nuTegels: nuTegels, naamTreffers: naamTreffers, mail: mail, vergeet: function () { mailIdx = null; luikCache.clear(); cache = null; priveCache = null; bankCache = null; stukCache = null; kIdx = null; eigenCache = new Map(); gezegdCache = null; } };
}

module.exports = { telNl: telNl, maak: maak, sleutelVan: sleutelVan, paginaTekst: paginaTekst, zichtbaar: zichtbaar, groepVan: groepVan,
  naamPatronen: naamPatronen, bevatNaam: bevatNaam, fmAliassen: fmAliassen, registerIndex: registerIndex, bekekenBij: bekekenBij, adresVan: adresVan,
  eersteOnderwerp: eersteOnderwerp, contractEinde: contractEinde, fmOvisLijst: fmOvisLijst,
  mailKaartLees: mailKaartLees, mailRegisterLees: mailRegisterLees, mailZoekvraag: mailZoekvraag, mailLuikTel: mailLuikTel, looptUit: looptUit, eigenToets: eigenToets, adresNorm: adresNorm, domeinNorm: domeinNorm };
