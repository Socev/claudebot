'use strict';
/*
 * pot-antwoord.js — OVIS POT: antwoorden op de decembermail ("patiëntenaantal per 1 januari <jaar>") vangen als voorstel per praktijk
 * (wv3677, besluitenpagina nr 134 / 2C34; David Ja 21-11-2026 12:40 met verse vingerafdruk).
 *
 * WAAROM. De decembermail gaat 1-12 uit; negen praktijken mailen hun aantal verspreid terug terwijl David spreekuur doet. Invullen kon
 * alleen op de pc (scherm Patiënten). Nu: de pod leest de antwoorden via het lees-luik (alleen lezen) en zet per praktijk een besluitkaart
 * "Praktijk X geeft N door (mail van d-m). Overnemen?" met oud → nieuw. Ja schrijft het aantal met de mail als bron via precies de API van
 * de app (bundel ovis-pot/api.mjs, route 'stand', logboek oud → nieuw). Nee of niets: er verandert niets.
 *
 * REGELS.
 *   - Nooit stil overschrijven: een tweede mail van dezelfde praktijk geeft een NIEUWE kaart (de oude vervalt); een Ja schrijft alleen als
 *     het aantal in de app nog precies is wat de kaart als "nu" toonde, anders niets en een verse kaart.
 *   - Een getal kiezen is voorzichtig: jaartallen, data, tijden, postcodes, telefoonnummers, bedragen en procenten tellen niet; alleen
 *     tussen GRENS.min en GRENS.max. Twijfel (geen, of meer dan één kandidaat) = een doe-kaart zonder Ja ("kijk zelf"), nooit een gok.
 *   - Afzender = het praktijkadres uit D1 pot.praktijk (of een eigen, niet-algemeen maildomein dat bij precies één adres hoort). Delen
 *     meer praktijken één adres (Korte Geer), dan alleen een voorstel per praktijk als haar naam en precies één getal op dezelfde regel staan.
 *   - Eigen praktijken: het aantal per 1-1 uit de Promedico-export in OVIS PMA (inschrijftarieven tot 65, 65–75, 75–85, 85+ op de peildatum),
 *     zodra David een export inleest die 1-1 dekt. Gemeten 21-11: Tolgaarde 1-1-2026 = 5.767 (POT-stand 5.787); Groenhouten staat niet in PMA.
 *   - Niets naar buiten: alleen lees-luik (lezen), D1 pot (lezen; schrijven alleen na Davids Ja), Voor jou-kaarten en de eigen staat.
 *
 * PUUR. Geen netwerk of bestand: alles via io (zie ronde() en ja()).
 */
const crypto = require('crypto');

const GRENS = { min: 500, max: 20000, lezenPerTik: 15, zoekMax: 25, fragment: 90, zoekDagen: 14 };
const ALGEMEEN = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.nl', 'outlook.com', 'outlook.nl', 'live.nl', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'kpnmail.nl', 'ziggo.nl', 'planet.nl', 'xs4all.nl', 'home.nl', 'hetnet.nl', 'casema.nl', 'zonnet.nl', 'quicknet.nl', 'telfort.nl', 'chello.nl', 'online.nl', 'protonmail.com', 'proton.me']);
const EIGEN_ADRESSEN = ['dokterschaap@gmail.com'];   // Davids eigen afzender (pot-maand VAN); zijn eigen mail is nooit een antwoord
const PMA_CODES = ['11115', '11116', '11117', '11118'];   // inschrijving tot 65 / 65–75 / 75–85 / 85+ (11119 = opslag, telt dubbel)
const MND = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const SLEUTEL_RE = /^pot-aantal-[a-z0-9]{2,4}-[0-9a-f]{8}$/;
const VRAAG_RE = /^pot-aantal-vraag-[0-9a-f]{8}$/;

// ── kleine hulpen ────────────────────────────────────────────────────────────
const h8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const kap = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const plat = (s) => String(s || '').replace(/[   ]/g, ' ').replace(/[ \t]+/g, ' ').trim();
const vouw = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmt = (n) => String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const dm = (ymd) => { const [, m, d] = String(ymd).slice(0, 10).split('-'); return `${Number(d)}-${Number(m)}`; };
function amsterdam(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  return { ymd: p.slice(0, 10), hm: p.slice(11, 16) };
}
function ymdPlus(ymd, n) { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const gmailDag = (ymd) => ymd.replace(/-/g, '/');

// Instellingen per jaar: de peildatum is 1-1 van het jaar; zoeken vanaf eind november ervoor tot half februari.
function instellingen(jaar) {
  const j = Number(jaar);
  return { jaar: j, peildatum: `${j}-01-01`, vorigePeil: `${j - 1}-01-01`, vanaf: `${j - 1}-11-25`, tot: `${j}-02-15`, deadline: `${j}-01-15`,
    onderwerp: `1 januari ${j}` };
}

// "Naam" <adres> → adres (kleine letters) of null
function adresVan(van) {
  const s = String(van || '');
  const m = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/.exec(s) || /([^\s<>"',;:@]+@[^\s<>"',;:@]+\.[a-z]{2,})/i.exec(s);
  return m ? m[1].toLowerCase().replace(/^mailto:/, '') : null;
}
const domein = (a) => String(a || '').split('@')[1] || '';

// ── de antwoordtekst ─────────────────────────────────────────────────────────
// Alleen wat de praktijk zelf schreef: geciteerde regels (>) eruit en alles vanaf de kop van het geciteerde bericht weg.
const CITAAT_KOP = [
  /^\s*op\s.{3,200}(schreef|geschreven)\b.*$/i,
  /^\s*on\s.{3,200}\bwrote:?\s*$/i,
  /^\s*-{2,}\s*(oorspronkelijk bericht|original message|doorgestuurd bericht|forwarded message)\s*-{0,}\s*$/i,
  /^\s*(van|from)\s*:\s*\S.*$/i,
  /^\s*_{5,}\s*$/,
];
function antwoordDeel(tekst) {
  const regels = String(tekst || '').replace(/\r\n?/g, '\n').split('\n');
  const uit = [];
  for (const r of regels) {
    if (CITAAT_KOP.some((re) => re.test(r))) break;
    if (/^\s*>/.test(r)) continue;
    uit.push(r);
  }
  return uit.join('\n');
}

// Alles wat op een getal lijkt maar geen aantal is, wordt weggepoetst (vervangen door spaties, zodat posities blijven).
const MAANDEN_RE = '(?:jan(?:uari)?|feb(?:ruari)?|mrt|maart|apr(?:il)?|mei|jun(?:i)?|jul(?:i)?|aug(?:ustus)?|sep(?:t(?:ember)?)?|okt(?:ober)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEG = [
  /\b(?:nl\d{2}\s?[a-z]{4}(?:\s?\d){10})\b/gi,                                   // IBAN
  /(?:\+|00)\d{2}[\s\-().]*\d(?:[\s\-().]*\d){7,}/g,                            // internationaal telefoonnummer
  /\b0\d(?:[\s\-().\/]*\d){8}\b/g,                                              // 06-12345678, 033 - 494 12 34, (033) 4941234
  /\b\d{4}\s?[a-z]{2}\b/gi,                                                     // postcode 3831 AB
  /\b\d{1,2}\s*[-\/.]\s*\d{1,2}\s*[-\/.]\s*\d{2,4}\b/g,                         // 1-1-2027, 01/01/27, 1.1.2027
  /\b\d{4}\s*[-\/]\s*\d{1,2}\s*[-\/]\s*\d{1,2}\b/g,                             // 2027-01-01
  new RegExp('\\b\\d{1,2}(?:e|ste|de)?\\s+' + MAANDEN_RE + '\\.?(?:\\s+\\d{2,4})?\\b', 'gi'),   // 1 januari 2027, 6 jan
  new RegExp('\\b' + MAANDEN_RE + '\\.?\\s+\\d{2,4}\\b', 'gi'),                  // januari 2027
  /\b\d{1,2}[:.]\d{2}\s*(?:uur|u)?\b/gi,                                       // 10:30, 9.15 uur
  /(?:€|eur\b|euro\b)\s*-?\s*\d[\d.,]*/gi,                                     // € 1.234,56
  /\d[\d.,]*\s*(?:€|euro|eur)\b/gi,                                            // 1.234 euro
  /\d[\d.,]*\s*(?:%|procent\b)/gi,                                             // 3,5 %
  /\b(?:kvk|agb|btw|iban|bic|tel|telefoon|fax|mobiel|postbus|nr|nummer|kenmerk|factuur|nota)\.?\s*(?:nr\.?|nummer)?\s*:?\s*[\d\s.\-]+/gi,
  /\b(?:19|20)\d{2}\b(?![.,]\d{3})/g,                                          // een los jaartal (2026, 2027); "2.027" blijft
  /\b\d+(?:[.,]\d+)?\s*(?:uur|u|min|minuten|fte|dagen|dag|weken|jaar|km|kg|mg|ml|cm|m2|m²|x)\b/gi,  // eenheden
  /\b\d{1,2}e\b/gi,
];
function poets(t) {
  let s = String(t || '');
  for (const re of WEG) s = s.replace(re, (m) => ' '.repeat(m.length));
  return s;
}
// Getallen in (gepoetste) tekst: 3412, 3.412, 3,412, 3 412 (spatie of smalle spatie als duizendtal). Decimalen ("3,5") = geen aantal.
function getallen(t) {
  const s = poets(t), uit = [];
  const re = /(?<![\d.,])(\d{1,3}(?:[.,   ]\d{3})+|\d+)(?:[.,]\d+)?(?![\d])/g;
  let m;
  while ((m = re.exec(s))) {
    const heel = m[0], kern = m[1];
    if (heel.length !== kern.length) continue;                       // 3,5 of 1.234,56: geen heel aantal
    const n = Number(kern.replace(/[.,   ]/g, ''));
    if (!Number.isFinite(n)) continue;
    uit.push({ n, index: m.index, ruw: kern });
  }
  return uit;
}
const plausibel = (n) => Number.isInteger(n) && n >= GRENS.min && n <= GRENS.max;
function regelVan(tekst, index) {
  const a = tekst.lastIndexOf('\n', index - 1) + 1, b = tekst.indexOf('\n', index);
  return { regel: tekst.slice(a, b < 0 ? tekst.length : b), start: a };
}
function fragmentRond(tekst, index) {
  const { regel, start } = regelVan(tekst, index);
  const r = plat(regel);
  if (r.length <= GRENS.fragment) return r;
  const pos = Math.max(0, index - start - 40);
  return kap((pos > 0 ? '…' : '') + plat(regel.slice(pos)), GRENS.fragment);
}

// Eén praktijk per afzender: welk aantal noemt de tekst? → { aantal, fragment, andere: [n] } | { probleem: 'geen'|'meerdere', getallen }
function kiesAantal(tekst, vorig) {
  const t = String(tekst || '');
  const k = getallen(t).filter((g) => plausibel(g.n));
  const uniek = [...new Set(k.map((g) => g.n))];
  if (!uniek.length) return { probleem: 'geen', getallen: [] };
  if (uniek.length === 1) { const g = k[0]; return { aantal: g.n, fragment: fragmentRond(t, g.index), andere: [] }; }
  // meer dan één: alleen als precies één getal in de buurt van het aantal van vorig jaar ligt (± 25 %) én woorden als "patiënten"/"ingeschreven" op die regel staan
  if (vorig > 0) {
    const dicht = k.filter((g) => Math.abs(g.n - vorig) / vorig <= 0.25 && /patient|ingeschrev|aantal/.test(vouw(regelVan(t, g.index).regel)));
    const du = [...new Set(dicht.map((g) => g.n))];
    if (du.length === 1) { const g = dicht[0]; return { aantal: g.n, fragment: fragmentRond(t, g.index), andere: uniek.filter((n) => n !== g.n).slice(0, 4) }; }
  }
  return { probleem: 'meerdere', getallen: uniek.slice(0, 6) };
}

// Sleutelwoorden om een praktijk in een tekst te herkennen (bij een gedeeld adres): het laatste woord van naam en eigenaar, ≥ 4 letters
function naamWoorden(p) {
  const w = new Set();
  for (const bron of [p.naam, p.eigenaar]) {
    const delen = vouw(bron).replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).filter((x) => x.length >= 4 && !['praktijk', 'huisartsenpraktijk', 'huisarts', 'huisartsen', 'maatschap', 'leusden'].includes(x));
    if (delen.length) w.add(delen[delen.length - 1]);
  }
  return [...w];
}
// Gedeeld adres: per praktijk het getal op de regel met haar naam (precies één naam en één getal op die regel)
function kiesPerNaam(tekst, groep) {
  const regels = String(tekst || '').split('\n'), uit = {};
  const woorden = groep.map((p) => ({ id: p.id, w: naamWoorden(p) }));
  for (const r of regels) {
    const v = vouw(r);
    const wie = woorden.filter((x) => x.w.some((w) => new RegExp('\\b' + w + '\\b').test(v)));
    if (wie.length !== 1) continue;
    const g = [...new Set(getallen(r).filter((x) => plausibel(x.n)).map((x) => x.n))];
    if (g.length !== 1) continue;
    const id = wie[0].id;
    if (uit[id] && uit[id].aantal !== g[0]) uit[id] = { dubbel: true };
    else if (!uit[id]) uit[id] = { aantal: g[0], fragment: kap(plat(r), GRENS.fragment), andere: [] };
  }
  Object.keys(uit).forEach((id) => { if (uit[id].dubbel) delete uit[id]; });
  return uit;
}

// Gaat deze mail over het patiëntenaantal? Onderwerp met "1 januari <jaar>" of patiënt + aantal/ingeschreven in de eigen tekst.
function overAantal(onderwerp, eigen, cfg) {
  const o = vouw(onderwerp), t = vouw(eigen);
  if (o.includes(vouw(cfg.onderwerp)) || /patientenaantal|patienten aantal|aantal patienten/.test(o)) return true;
  return /patient/.test(t) && /(aantal|ingeschrev|per 1[- ]1|1 januari|peildatum)/.test(t);
}

// Welke praktijk(en) horen bij deze afzender? Exact adres; anders een eigen maildomein dat bij één praktijkadres hoort.
function praktijkenVan(adres, praktijken) {
  if (!adres) return [];
  const exact = praktijken.filter((p) => String(p.email || '').toLowerCase() === adres);
  if (exact.length) return exact;
  const d = domein(adres);
  if (!d || ALGEMEEN.has(d)) return [];
  const adr = [...new Set(praktijken.filter((p) => domein(String(p.email || '').toLowerCase()) === d).map((p) => String(p.email).toLowerCase()))];
  return adr.length === 1 ? praktijken.filter((p) => String(p.email || '').toLowerCase() === adr[0]) : [];
}

// ── kaarten ──────────────────────────────────────────────────────────────────
const DOEL = { module: 'pot', doel: { scherm: 'pot' } };
function standTekst(s) {
  if (!s || s.aantal == null) return 'leeg';
  return fmt(s.aantal) + (s.status === 'voorlopig' ? ' (voorlopig)' : '');
}
function verschilTekst(nieuw, vorig) {
  if (!(vorig > 0)) return '';
  const pct = Math.round(((nieuw - vorig) / vorig) * 1000) / 10;
  const d = `${pct > 0 ? '+' : ''}${String(pct).replace('.', ',')} %`;
  return Math.abs(pct) >= 10 ? ` (${d}: let op, ongewoon groot)` : ` (${d})`;
}
// v = { praktijk: {id, naam}, aantal, status, oud, vorig, bron: 'mail'|'pma', mail: {id, adres, ymd, hm}, fragment, andere, pma: {exportdatum} }
function kaartVoorstel(v, cfg) {
  const p = v.praktijk;
  const sleutel = `pot-aantal-${p.id.toLowerCase()}-${h8([v.bron, v.mail ? v.mail.id : (v.pma && v.pma.exportdatum), p.id, v.aantal, v.status, v.oud ? v.oud.aantal : '', v.poging || 0].join('|'))}`;
  const naam = kap(p.naam, 28);
  let titel = v.bron === 'pma'
    ? `${naam}: ${fmt(v.aantal)} patiënten per ${dm(cfg.peildatum)}-${cfg.jaar} volgens Promedico. Overnemen?`
    : `${naam} geeft ${fmt(v.aantal)} patiënten door (mail van ${dm(v.mail.ymd)}). Overnemen?`;
  if (titel.length > 90) titel = `${naam}: ${fmt(v.aantal)} patiënten per 1-1. Overnemen?`;
  const herkomstTekst = v.bron === 'pma'
    ? `Uit de Promedico-export van ${dm(v.pma.exportdatum)} in OVIS PMA: ingeschreven patiënten op ${dm(cfg.peildatum)} (inschrijftarieven alle leeftijden).`
    : `Uit de mail van ${v.mail.adres} van ${dm(v.mail.ymd)} ${v.mail.hm}.`;
  const waarom = kap(`Patiëntenaantal per 1-1-${cfg.jaar} in OVIS POT: nu ${standTekst(v.oud)}, wordt ${fmt(v.aantal)}${v.status === 'voorlopig' ? ' (voorlopig: gemaild vóór 1 januari)' : ''}. ` +
    `Vorig jaar ${v.vorig > 0 ? fmt(v.vorig) : 'onbekend'}${verschilTekst(v.aantal, v.vorig)}. ${herkomstTekst} Ja zet het aantal in de app met deze bron; Nee laat het zoals het is.`, 400);
  const stappen = [];
  if (v.andere && v.andere.length) stappen.push(`Er staan meer getallen in de mail (${v.andere.map(fmt).join(', ')}); ik koos het getal bij "patiënten" dat het dichtst bij vorig jaar ligt.`);
  stappen.push('Een latere mail van deze praktijk geeft een nieuwe kaart; er wordt nooit stil iets overschreven.');
  return { sleutel, soort: 'besluit', volgorde: 21, waar: 'overal', prive: true, duur_min: 1, deadline: cfg.deadline, titel, waarom, stappen,
    herkomst: Object.assign({ handmatig: 'pot-antwoord', soort: 'aantal', praktijk_id: p.id, jaar: cfg.jaar }, DOEL) };
}
// Twijfel: een doe-kaart zonder Ja (Anders gaat naar de machinekamer, prive false). x = { wie, mail: {id, adres, ymd}, probleem, getallen }
function kaartVraag(x, cfg) {
  const sleutel = `pot-aantal-vraag-${h8([x.mail.id, x.probleem, (x.getallen || []).join(',')].join('|'))}`;
  const wie = kap(x.wie, 30);
  const titel = kap(`Patiëntenaantal ${wie} (mail ${dm(x.mail.ymd)}): kijk zelf even`, 90);
  const reden = x.probleem === 'onbekend' ? `de afzender ${x.mail.adres} hoort bij geen praktijk in de app`
    : x.probleem === 'geen' ? 'ik vond geen aantal in de tekst (misschien staat het in een bijlage)'
      : x.probleem === 'groep' ? 'dit adres hoort bij meer praktijken en ik kon de getallen niet per huisarts aan een naam koppelen'
        : 'er staan meer getallen in en ik weet niet zeker welke het aantal is';
  const waarom = kap(`Antwoord op de decembermail (patiëntenaantal per 1-1-${cfg.jaar}) van ${x.mail.adres} op ${dm(x.mail.ymd)}, maar ${reden}.` +
    (x.getallen && x.getallen.length ? ` Getallen in de mail: ${x.getallen.map(fmt).join(', ')}.` : '') +
    ' Ik neem niets over zonder jou.', 400);
  return { sleutel, soort: 'doen', volgorde: 22, waar: 'overal', prive: false, duur_min: 2, deadline: cfg.deadline, titel, waarom,
    stappen: ['Lees de mail in Gmail (zoek op het adres hierboven).',
      'Tik Anders en typ per praktijk het aantal, bijvoorbeeld: "Lepelaar 3.120". De machinekamer zet het dan in OVIS POT, met de mail als bron.',
      'Of vul het op de pc in bij Patiënten in OVIS POT.'],
    herkomst: Object.assign({ handmatig: 'pot-antwoord', soort: 'vraag', jaar: cfg.jaar }, DOEL) };
}

// ── de ronde ─────────────────────────────────────────────────────────────────
/*
 * io = {
 *   d1(batch) → [{ results }]                         D1 pot, alleen select in de ronde
 *   zoek(query) → { mails: [{ id, datum, van, onderwerp }], melding }      lees-luik mail_zoeken (hooguit 25)
 *   lees(id) → { id, datum, van, onderwerp, tekst } | { fout }               lees-luik mail_lezen
 *   pma(naam, peildatum) → { aantal, exportdatum } | null                    OVIS PMA (eigen praktijken), alleen lezen
 *   kaartZet(k) → { sleutel }                                                mk_voor_jou_zet
 *   kaartLijst() → [{ sleutel, status }]                                     mk_voor_jou_lijst
 *   kaartVervalt(sleutel, van, reden)                                       mk_voor_jou_status → vervallen
 *   staat → object (wordt hier bijgewerkt), bewaar() → schrijft de staat weg
 * }
 * o = { jaar } (standaard: het jaar van de eerstvolgende 1 januari na de D1-klok in december, anders het lopende jaar)
 */
async function lezen(io, cfg) {
  const r = await io.d1([
    { sql: "select strftime('%Y-%m-%dT%H:%M:%SZ','now') as nu", params: [] },
    { sql: 'select id, naam, naam_brief, email, eigenaar from praktijk order by id', params: [] },
    { sql: 'select praktijk_id, peildatum, aantal, status from praktijk_patienten where peildatum in (?, ?)', params: [cfg.peildatum, cfg.vorigePeil] },
    { sql: "select distinct praktijk_id from deelname where entiteit in ('POT','KM') and (geldig_van is null or geldig_van <= ?) and (geldig_tot is null or geldig_tot >= ?)", params: [`${cfg.jaar}-12-31`, cfg.peildatum] },
  ]);
  const deelnemers = new Set(r[3].results.map((x) => x.praktijk_id));
  const praktijken = r[1].results.filter((p) => deelnemers.has(p.id));
  const stand = {}, vorig = {};
  for (const s of r[2].results) { if (s.peildatum === cfg.peildatum) stand[s.praktijk_id] = { aantal: s.aantal, status: s.status }; else vorig[s.praktijk_id] = Number(s.aantal) || 0; }
  return { nu: r[0].results[0].nu, praktijken, stand, vorig };
}
function jaarVoor(nuIso) {
  const a = amsterdam(nuIso);
  const j = Number(a.ymd.slice(0, 4)), m = Number(a.ymd.slice(5, 7));
  return m >= 11 ? j + 1 : j;
}

const queryTekst = (q) => (q.adressen ? `from:(${q.adressen.join(' OR ')}) -in:sent -in:draft` : q.tekst);
async function zoekAlles(io, queries, van, tot, uit) {
  for (const q of queries) {
    let s = van;
    while (s < tot) {
      let e = ymdPlus(s, 7); if (e > tot) e = tot;
      await zoekVenster(io, q, s, e, uit, 0);
      s = e;
    }
  }
}
async function zoekVenster(io, q, van, tot, uit, diepte) {
  const j = await io.zoek(`${queryTekst(q)} after:${gmailDag(ymdPlus(van, -1))} before:${gmailDag(ymdPlus(tot, 1))}`);
  if (!j || !Array.isArray(j.mails)) { uit.fout = true; return; }
  if (j.melding) uit.fout = true;
  const dagen = Math.round((Date.parse(tot) - Date.parse(van)) / 864e5);
  if (j.mails.length >= GRENS.zoekMax && dagen > 1 && diepte < 6) {
    const midden = ymdPlus(van, Math.floor(dagen / 2));
    await zoekVenster(io, q, van, midden, uit, diepte + 1);
    await zoekVenster(io, q, midden, tot, uit, diepte + 1);
    return;
  }
  if (j.mails.length >= GRENS.zoekMax && q.adressen && q.adressen.length > 1 && diepte < 12) {   // vol dagvenster: per helft van de adressen
    const h = Math.ceil(q.adressen.length / 2);
    await zoekVenster(io, { adressen: q.adressen.slice(0, h) }, van, tot, uit, diepte + 1);
    await zoekVenster(io, { adressen: q.adressen.slice(h) }, van, tot, uit, diepte + 1);
    return;
  }
  if (j.mails.length >= GRENS.zoekMax) uit.afgekapt = true;
  for (const m of j.mails) if (m && typeof m.id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(m.id)) uit.mails.set(m.id, m);
}

function staatVoor(io, cfg) {
  const s = io.staat;
  if (!s.jaren) s.jaren = {};
  if (!s.jaren[cfg.jaar]) s.jaren[cfg.jaar] = { mails: {}, kaarten: {}, pma: {}, gezocht_tot: null };
  return s.jaren[cfg.jaar];
}

async function ronde(io, o) {
  o = o || {};
  const uit = { gelezen: 0, voorstellen: 0, vragen: 0, gelijk: 0, niet_relevant: 0, vervallen: 0, fouten: [] };
  const eerst = await io.d1([{ sql: "select strftime('%Y-%m-%dT%H:%M:%SZ','now') as nu", params: [] }]);
  const cfg = instellingen(o.jaar || jaarVoor(eerst[0].results[0].nu));
  uit.jaar = cfg.jaar;
  const L = await lezen(io, cfg);
  const vandaag = amsterdam(L.nu).ymd;
  if (vandaag < cfg.vanaf || vandaag > cfg.tot) { uit.buiten = true; return uit; }
  const st = staatVoor(io, cfg);
  const kaartStand = {};
  try { for (const p of await io.kaartLijst()) kaartStand[p.sleutel] = p.status; } catch (e) { uit.fouten.push('kaarten'); return uit; }
  // Davids knop is verwerkt (gedaan) of de kaart verdween: bijwerken; open kaarten per praktijk
  const openPer = {};
  // 'gedaan' laten we staan: dat is (meestal) Davids knop, en die handelt knopVoor/ja af (geen race met een lopende Ja)
  for (const [sl, k] of Object.entries(st.kaarten)) {
    if (k.stand !== 'open') continue;
    const ks = kaartStand[sl];
    if (ks === 'open' || ks === 'later') { if (k.praktijk_id) openPer[k.praktijk_id] = { sl, ks }; }
    else if (ks !== 'gedaan') k.stand = 'dicht_' + (ks || 'weg');
  }

  // 1. zoeken (vanaf de laatste geslaagde zoektocht − 2 dagen; de eerste keer vanaf cfg.vanaf)
  // Bewust exacte adressen, niet het hele praktijkdomein: dan kwam al het interne verkeer van de eigen praktijken mee. Een collega-adres op
  // het praktijkdomein wordt via de tweede zoekvraag (jaarzin in het onderwerp of de tekst) gevonden en door praktijkenVan gekoppeld.
  const adressen = [...new Set(L.praktijken.map((p) => String(p.email || '').toLowerCase()).filter((a) => /^[^\s@()"]+@[^\s@()"]+\.[a-z]{2,}$/.test(a)))];
  const queries = [];
  if (adressen.length) queries.push({ adressen });
  queries.push({ tekst: `"${cfg.onderwerp}" -from:me -in:sent -in:draft` });
  const van = st.gezocht_tot && st.gezocht_tot > cfg.vanaf ? ymdPlus(st.gezocht_tot, -2) : cfg.vanaf;
  const zoek = { mails: new Map(), fout: false, afgekapt: false };
  try { await zoekAlles(io, queries, van, vandaag, zoek); } catch (e) { zoek.fout = true; }
  if (zoek.fout) uit.fouten.push('luik');
  if (zoek.afgekapt) uit.fouten.push('afgekapt');

  // 2. nieuwe mails lezen en beoordelen (oudste eerst, zodat de jongste mail van een praktijk de laatste kaart geeft)
  const nieuw = [...zoek.mails.values()].filter((m) => !st.mails[m.id]).sort((a, b) => String(a.datum).localeCompare(String(b.datum))).slice(0, GRENS.lezenPerTik);
  let onvolledig = zoek.fout || zoek.afgekapt || nieuw.length < [...zoek.mails.values()].filter((m) => !st.mails[m.id]).length;
  const voorstellen = [];   // { praktijk, aantal, status, mail, fragment, andere } of { vraag }; later in de lijst = nieuwer
  // 1b. een Ja die bleef hangen (pod herstart tijdens het schrijven): de databank beslist of hij gelukt is
  for (const k of Object.values(st.kaarten)) {
    if (k.stand !== 'bezig' || Date.parse(L.nu) - Date.parse(k.bezig_op || 0) < 10 * 60e3) continue;
    const s = L.stand[k.praktijk_id];
    k.stand = s && Number(s.aantal) === k.aantal && s.status === k.status ? 'ja' : 'opnieuw';
  }
  // 1c. een kaart die niet doorging (de stand veranderde vóór de Ja, of schrijven mislukte): opnieuw voorstellen met de stand van nu.
  // Vóór de nieuwe mails in de lijst, zodat een nieuwer antwoord van dezelfde praktijk altijd wint.
  for (const k of Object.values(st.kaarten)) {
    if (k.stand !== 'opnieuw') continue;
    k.stand = 'vervangen';
    const p = L.praktijken.find((x) => x.id === k.praktijk_id);
    if (p) voorstellen.push({ praktijk: p, aantal: k.aantal, status: k.status, bron: k.bron, mail: k.mail, andere: k.andere || [], pma: k.pma, poging: (k.poging || 0) + 1, herhaal: true });
  }
  for (const m of nieuw) {
    let vol;
    try { vol = await io.lees(m.id); } catch (e) { vol = null; }
    if (!vol || vol.fout || typeof vol.tekst !== 'string' || String(vol.id || m.id) !== m.id) { onvolledig = true; uit.fouten.push('lezen'); continue; }
    uit.gelezen++;
    const adres = adresVan(vol.van || m.van);
    const tijd = amsterdam(vol.datum || m.datum) || { ymd: vandaag, hm: '' };
    const iso = Number.isFinite(Date.parse(vol.datum || m.datum)) ? new Date(Date.parse(vol.datum || m.datum)).toISOString() : L.nu;
    const mail = { id: m.id, adres: adres || 'onbekend adres', ymd: tijd.ymd, hm: tijd.hm, iso };
    const eigen = antwoordDeel(vol.tekst);
    const registreer = (uitkomst, extra) => { st.mails[m.id] = Object.assign({ op: L.nu, ymd: mail.ymd, adres: mail.adres, uitkomst }, extra || {}); };
    if (!adres || EIGEN_ADRESSEN.includes(adres)) { registreer('eigen'); continue; }
    if (!overAantal(vol.onderwerp || m.onderwerp, eigen, cfg)) { registreer('niet_relevant'); uit.niet_relevant++; continue; }
    const groep = praktijkenVan(adres, L.praktijken);
    const status = mail.ymd < cfg.peildatum ? 'voorlopig' : 'definitief';
    if (!groep.length) { voorstellen.push({ vraag: { wie: adres, mail, probleem: 'onbekend', getallen: [...new Set(getallen(eigen).filter((g) => plausibel(g.n)).map((g) => g.n))].slice(0, 6) } }); registreer('onbekend'); continue; }
    if (groep.length === 1) {
      const p = groep[0];
      const k = kiesAantal(eigen, L.vorig[p.id]);
      if (k.probleem) { voorstellen.push({ vraag: { wie: p.naam, mail, probleem: k.probleem, getallen: k.getallen, praktijk_ids: [p.id] } }); registreer(k.probleem, { praktijk_id: p.id }); continue; }
      voorstellen.push({ praktijk: p, aantal: k.aantal, status, mail, andere: k.andere });
      registreer('voorstel', { praktijk_id: p.id, aantal: k.aantal });
      continue;
    }
    const per = kiesPerNaam(eigen, groep);
    const ids = Object.keys(per);
    if (!ids.length) {
      const g = [...new Set(getallen(eigen).filter((x) => plausibel(x.n)).map((x) => x.n))].slice(0, 6);
      voorstellen.push({ vraag: { wie: groep.map((p) => p.naam_brief || p.naam)[0], mail, probleem: g.length ? 'groep' : 'geen', getallen: g, praktijk_ids: groep.map((p) => p.id) } });
      registreer(g.length ? 'groep' : 'geen');
      continue;
    }
    for (const id of ids) { const p = groep.find((x) => x.id === id); voorstellen.push({ praktijk: p, aantal: per[id].aantal, status, mail, andere: [] }); }
    registreer('voorstel', { praktijk_id: ids.join(','), aantal: ids.map((id) => per[id].aantal).join(',') });
  }

  // 3. eigen praktijken uit OVIS PMA (zodra een export 1-1 dekt)
  for (const p of L.praktijken) {
    let x = null;
    try { x = io.pma ? io.pma(p.naam, cfg.peildatum) : null; } catch (e) { x = null; uit.fouten.push('pma'); }
    if (!x || !plausibel(x.aantal)) continue;
    const vorigePma = st.pma[p.id];
    if (vorigePma && vorigePma.aantal === x.aantal && vorigePma.exportdatum === x.exportdatum) continue;
    st.pma[p.id] = { aantal: x.aantal, exportdatum: x.exportdatum };
    voorstellen.push({ praktijk: p, aantal: x.aantal, status: 'definitief', bron: 'pma', pma: { exportdatum: x.exportdatum } });
  }

  // 5. kaarten zetten: per praktijk alleen het laatste voorstel van deze ronde; gelijk aan de stand = geen kaart
  // per praktijk wint het nieuwste antwoord (mailtijd); een antwoord ouder dan het nieuwste dat al verwerkt is (bv. een mail die eerder
  // niet te lezen was) vervangt dat nooit. PMA en herhaalvoorstellen hebben geen mailtijd van een nieuw antwoord: die tellen als "nu".
  if (!st.nieuwste) st.nieuwste = {};
  const tijdVan = (v) => (v.vraag ? v.vraag.mail.iso : v.mail && !v.herhaal ? v.mail.iso : null);
  const pidsVan = (v) => (v.praktijk ? [v.praktijk.id] : v.vraag.praktijk_ids || []);
  const laatste = new Map();
  for (const v of voorstellen) {
    const t = tijdVan(v);
    for (const pid of pidsVan(v)) {
      if (t && st.nieuwste[pid] && t < st.nieuwste[pid]) { v.ouder = true; continue; }
      const nu = laatste.get(pid), tn = nu ? tijdVan(nu) : null;
      if (!nu || !t || !tn || t >= tn) laatste.set(pid, v);
    }
  }
  // een open voorstelkaart van een praktijk met een nieuwer antwoord vervalt, ook als dat antwoord zelf geen kaart geeft (gelijk of twijfel)
  const vervalOud = async (pid, behalve) => {
    const eerder = openPer[pid];
    if (!eerder || eerder.sl === behalve) return;
    try { await io.kaartVervalt(eerder.sl, eerder.ks, 'nieuwer antwoord van deze praktijk'); st.kaarten[eerder.sl].stand = 'vervangen'; delete openPer[pid]; uit.vervallen++; }
    catch (e) { uit.fouten.push('vervallen'); }
  };
  for (const v of voorstellen) {
    if (v.vraag) {
      const k = kaartVraag(v.vraag, cfg);
      if (st.kaarten[k.sleutel]) continue;
      try { await io.kaartZet(k); st.kaarten[k.sleutel] = { stand: 'open', soort: 'vraag', mail: v.vraag.mail, op: L.nu }; uit.vragen++; }
      catch (e) { uit.fouten.push('kaart'); delete st.mails[v.vraag.mail.id]; onvolledig = true; continue; }
      for (const pid of v.vraag.praktijk_ids || []) if (laatste.get(pid) === v) { await vervalOud(pid, null); st.nieuwste[pid] = v.vraag.mail.iso; }
      continue;
    }
    if (laatste.get(v.praktijk.id) !== v) { if (v.ouder) uit.ouder = (uit.ouder || 0) + 1; continue; }
    const tv = tijdVan(v);
    if (tv && (!st.nieuwste[v.praktijk.id] || tv > st.nieuwste[v.praktijk.id])) st.nieuwste[v.praktijk.id] = tv;
    const oud = L.stand[v.praktijk.id] || null;
    if (oud && Number(oud.aantal) === v.aantal && oud.status === v.status) { uit.gelijk++; await vervalOud(v.praktijk.id, null); continue; }
    const vv = Object.assign({ bron: 'mail', vorig: L.vorig[v.praktijk.id] || 0, oud }, v);
    const k = kaartVoorstel(vv, cfg);
    if (st.kaarten[k.sleutel] && st.kaarten[k.sleutel].stand === 'open') continue;
    try {
      await io.kaartZet(k);
      st.kaarten[k.sleutel] = { stand: 'open', soort: 'aantal', praktijk_id: v.praktijk.id, aantal: v.aantal, status: v.status, bron: vv.bron,
        oud: oud ? { aantal: Number(oud.aantal), status: oud.status } : null, mail: v.mail || null, andere: v.andere || [], pma: v.pma || null,
        poging: v.poging || 0, op: L.nu };
      uit.voorstellen++;
      await vervalOud(v.praktijk.id, k.sleutel);
      openPer[v.praktijk.id] = { sl: k.sleutel, ks: 'open' };
    } catch (e) {
      uit.fouten.push('kaart'); onvolledig = true;
      if (v.mail && st.mails[v.mail.id]) delete st.mails[v.mail.id];   // volgende ronde opnieuw
      if (v.bron === 'pma') delete st.pma[v.praktijk.id];
    }
  }
  if (!onvolledig) st.gezocht_tot = vandaag;   // anders niet verder schuiven: de volgende ronde zoekt hetzelfde venster opnieuw
  await io.bewaar();
  return uit;
}

// ── Davids knop ──────────────────────────────────────────────────────────────
// knopVoor: vóór de druk (async: leest de stand van nu). → null (geen kaart van ons) of { context, uitvoeren(keuze) → Promise<{ ok, reden }> }
async function knopVoor(io, sleutel, keuze) {
  if (!SLEUTEL_RE.test(String(sleutel || '')) || VRAAG_RE.test(String(sleutel))) return null;
  const s = io.staat && io.staat.jaren ? io.staat.jaren : {};
  let k = null, jaar = null;
  for (const j of Object.keys(s)) if (s[j].kaarten && s[j].kaarten[sleutel]) { k = s[j].kaarten[sleutel]; jaar = Number(j); }
  if (!k || k.soort !== 'aantal') return null;
  const cfg = instellingen(jaar);
  const wat = `${fmt(k.aantal)} patiënten per 1-1-${cfg.jaar}`;
  if (k.stand !== 'open') return { context: ` (POT-aantal: deze kaart is al afgehandeld (${k.stand}); de pod doet niets. Zeg dat in één zin; jij schrijft niets in OVIS POT.)`, uitvoeren: async () => ({ ok: false, reden: 'al afgehandeld' }) };
  if (keuze === 'nee') return { context: ` (POT-aantal: Nee. De pod neemt ${wat} NIET over; het aantal in OVIS POT blijft zoals het was. Zeg dat in één zin; jij doet niets.)`,
    uitvoeren: async () => { k.stand = 'nee'; await io.bewaar(); return { ok: true }; } };
  if (keuze !== 'ja') return { context: ` (POT-aantal: Anders. De pod neemt niets over. Noemt David in zijn toelichting een ander aantal voor deze praktijk, stel dan de doorgeefluikvraag met #mk-werklijst zodat de machinekamer dat aantal met zijn woorden als bron in OVIS POT zet; anders zeg je in één zin dat er niets veranderd is. Jij schrijft zelf niets in OVIS POT.)`,
    uitvoeren: async () => { k.stand = 'anders'; await io.bewaar(); if (io.box) io.box(sleutel, k); return { ok: true }; } };
  let nu;
  try { nu = await huidig(io, k.praktijk_id, cfg.peildatum); } catch (e) { return { context: ' (POT-aantal: de POT-databank was niet te lezen; de pod nam NIETS over. Zeg David dat hij het straks nog eens probeert of het op de pc invult; jij schrijft niets.)', uitvoeren: async () => ({ ok: false, reden: 'databank' }) }; }
  if (!zelfde(nu, k.oud)) {
    return { context: ` (POT-aantal: NIET overgenomen. Het aantal in OVIS POT veranderde sinds de kaart (nu ${standTekst(nu)}, de kaart ging uit van ${standTekst(k.oud)}). De pod zet zo een nieuwe kaart met de stand van nu. Zeg dat in één zin; jij schrijft niets.)`,
      uitvoeren: async () => { k.stand = 'opnieuw'; await io.bewaar(); return { ok: false, reden: 'stand veranderd' }; } };
  }
  return { context: ` (POT-aantal: Ja. De pod zet nu zelf ${wat} voor ${k.praktijk_id} in OVIS POT (${k.status}), met de ${k.bron === 'pma' ? 'Promedico-export' : 'mail'} als bron, en meldt het als dat niet lukt. Jij schrijft niets in OVIS POT; bevestig het David in één zin.)`,
    uitvoeren: () => ja(io, sleutel) };
}
async function huidig(io, praktijkId, peildatum) {
  const r = await io.d1([{ sql: 'select aantal, status from praktijk_patienten where praktijk_id=? and peildatum=?', params: [praktijkId, peildatum] }]);
  const x = r[0].results[0];
  return x ? { aantal: x.aantal == null ? null : Number(x.aantal), status: x.status } : null;
}
function zelfde(a, b) {
  const leeg = (x) => !x || x.aantal == null;
  if (leeg(a) || leeg(b)) return leeg(a) && leeg(b);
  return Number(a.aantal) === Number(b.aantal) && String(a.status || '') === String(b.status || '');
}
// Na de start van Davids Ja: opnieuw de stand toetsen, dan via de API van de app schrijven (logboek oud → nieuw).
async function ja(io, sleutel) {
  const s = io.staat.jaren || {};
  let k = null, jaar = null;
  for (const j of Object.keys(s)) if (s[j].kaarten && s[j].kaarten[sleutel]) { k = s[j].kaarten[sleutel]; jaar = Number(j); }
  if (!k || k.stand !== 'open') return { ok: false, reden: 'kaart niet open' };
  const cfg = instellingen(jaar);
  k.stand = 'bezig'; k.bezig_op = new Date().toISOString(); await io.bewaar();
  try {
    const nu = await huidig(io, k.praktijk_id, cfg.peildatum);
    if (!zelfde(nu, k.oud)) { k.stand = 'opnieuw'; await io.bewaar(); return { ok: false, reden: 'het aantal in de app veranderde intussen' }; }
    const bron = k.bron === 'pma'
      ? `Promedico-export ${dm(k.pma.exportdatum)}-${k.pma.exportdatum.slice(0, 4)} (OVIS PMA, inschrijftarieven op ${cfg.peildatum}); overgenomen met Davids Ja op de Socev-kaart`
      : `mail van ${k.mail.adres} op ${dm(k.mail.ymd)}-${k.mail.ymd.slice(0, 4)} ${k.mail.hm} (Gmail ${k.mail.id}); overgenomen met Davids Ja op de Socev-kaart`;
    await io.schrijfStand({ praktijk_id: k.praktijk_id, peildatum: cfg.peildatum, aantal: k.aantal, status: k.status,
      opgegeven_door: kap(k.bron === 'pma' ? 'Promedico (OVIS PMA)' : k.mail.adres, 120), bron_tekst: kap(bron, 300) });
    k.stand = 'ja'; k.geschreven_op = new Date().toISOString(); await io.bewaar();
    return { ok: true };
  } catch (e) {
    k.stand = 'opnieuw'; k.fout = kap(e && e.message, 160); await io.bewaar();
    return { ok: false, reden: 'schrijven mislukte: ' + kap(e && e.message, 120) };
  }
}

module.exports = { GRENS, PMA_CODES, SLEUTEL_RE, VRAAG_RE, instellingen, jaarVoor, adresVan, antwoordDeel, poets, getallen, kiesAantal, kiesPerNaam, naamWoorden,
  overAantal, praktijkenVan, kaartVoorstel, kaartVraag, ronde, knopVoor, ja, zelfde, amsterdam };
