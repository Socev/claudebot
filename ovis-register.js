'use strict';
// ovis-register.js — OVIS-entiteitenregister: compiler (vault → database) en de Bibliothecaris (wv979, 24-10-2026).
// Ontwerp + Fable-review vooraf: /opt/data/mk-scripts/wv979/ontwerp.md; bouwplan "01_Ontwikkeling/OVIS Intake - één ingang en router
// (bouwplan 24-10-2026).md" § 4.
//
// WAAROM. David 23-10: "voor ALLE entiteiten een vermelding in onze Second Brain … als van een entiteit dan iets wijzigt, dan staat in
// de markdown vermeld welke database vermelding ook aangepast moet. En een bibliothecaris controleert of gegevens in de database ook
// nog hetzelfde in de gekoppelde markdown staan." De entiteitpagina (Entiteit - <code>.md, later Relaties/<naam>.md) is de bron; deze
// module leest de frontmatter, valideert en schrijft via public.ovis_pagina_zet (alles of niets per pagina). De databank beslist wat
// actief wordt: een handvat of contactveld van een pagina is altijd 'voorgesteld' tot Davids Ja; naam/iban/agb van een bestaande knoop
// en het intrekken van een actief handvat komen terug als voorstel. De Bibliothecaris vergelijkt pagina's en databank (BB1–BB7) en
// lost niets stil op.
//
// Drie lagen (ontwerplijnen § 4.4): dit is de logica. Geen netwerk en geen sleutels in dit bestand: sbRpc, lezen en schrijven worden
// erin gestoken (server.js: appSbRpc + vault-veilig; ovis-run.js: dezelfde, voor de machinekamer en de nachtronde onder de grendel).
// Wat de module aan tekst maakt is gegevenslaag-uitvoer (het gegenereerde blok in de pagina, de box-rij), nooit app-opmaak.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BLOK_BEGIN = '<!-- ovis:blok begin -->', BLOK_EIND = '<!-- ovis:blok eind -->';
// SB2 fase 1a (wv1271, bouwplan Second Brain 2.0 § 6 K2): het begin draagt id + content_hash (16 hex van sha256 over de tekst tussen begin
// en eind). Klopt de hash niet meer, dan heeft iemand binnen het blok getypt: de compiler overschrijft het dan NIET (eerder ging dat 's nachts
// stil verloren) en de Bibliothecaris meldt het als BB8. Een blok zonder hash (vóór 26-10-2026) is van de compiler en wordt één keer
// vervangen door de nieuwe vorm.
const BLOK_BEGIN_RE = /<!-- ovis:blok begin(?: id="([^"<>]{1,80})" content_hash="([0-9a-f]{16})")? -->/;
const MAX_PAGINAS = 2000, MAX_BYTES = 256 * 1024;
const SCHRIJVERS_OK = ['compiler', 'migratie-0002', 'activeer', 'kaart'];
const SOORTEN = ['eigen', 'leverancier', 'instantie', 'bank', 'verzekeraar', 'praktijk', 'zorgpartner', 'afzender'];
const CONTACT = ['adres', 'factuuradres', 'boekhoudadres', 'afschriftadres', 'telefoon', 'email', 'website', 'contactpersoon'];
const PUBLIEK_DOMEIN = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.nl', 'live.com', 'live.nl', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.nl', 'ziggo.nl', 'kpnmail.nl', 'kpnplanet.nl', 'hetnet.nl', 'planet.nl', 'home.nl',
  'chello.nl', 'casema.nl', 'quicknet.nl', 'upcmail.nl', 'tele2.nl', 'online.nl', 'xs4all.nl', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net',
  'aol.com', 'zonnet.nl', 'telfort.nl', 'versatel.nl']);
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}/i, BSN_RE = /(^|[^0-9])\d{9}([^0-9]|$)/;
const SLEUTEL_RE = /(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|\b[0-9a-f]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2})/;
// Vaste plekken (Fable wv979 #3): alleen hier telt een pagina; bestandsnaam moet bij entiteit_id passen.
const EIGEN_RE = /^(10_Zakelijk\/[^/]+|20_Prive)\/Entiteit - ([A-Z][A-Z0-9_]{1,15})\.md$/;
const ORG_RE = /^(10_Zakelijk\/_Gedeeld|20_Prive)\/Relaties\/[^/]+\.md$/;

// ── frontmatter (eigen parser: alles als tekst, nooit als YAML-getal; inline en blok-lijsten; één niveau genest) ──
function ontquote(s) {
  s = String(s).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
  const h = s.search(/\s#/);
  return (h >= 0 ? s.slice(0, h) : s).trim();
}
function splitInline(s) {   // "a, \"b, c\", 'd'" → [a, b, c, d]
  const uit = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { uit.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) uit.push(cur);
  return uit.map(ontquote).filter(function (x) { return x !== ''; });
}
function waardeVan(rauw) {
  const v = String(rauw).trim();
  if (v.startsWith('[') && v.endsWith(']')) return splitInline(v.slice(1, -1));
  if (v === '{}') return {};
  if (v.startsWith('{') && v.endsWith('}')) {
    const o = {};
    splitInline(v.slice(1, -1)).forEach(function (d) { const i = d.indexOf(':'); if (i > 0) o[d.slice(0, i).trim()] = ontquote(d.slice(i + 1)); });
    return o;
  }
  return ontquote(v);
}
// → { velden, fmEind (index van de regel na de slot-'---'), regels } of { fout }
function frontmatter(tekst) {
  const regels = String(tekst).replace(/\r\n?/g, '\n').split('\n');
  if (regels[0] !== '---') return { fout: 'geen frontmatter' };
  let eind = -1;
  for (let i = 1; i < regels.length; i++) if (regels[i] === '---') { eind = i; break; }
  if (eind < 0) return { fout: 'frontmatter niet afgesloten' };
  const velden = {};
  let i = 1;
  while (i < eind) {
    const r = regels[i];
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(r);
    if (!m) { if (r.trim() === '' || /^\s*#/.test(r)) { i++; continue; } return { fout: 'regel ' + (i + 1) + ' is geen veld' }; }
    const sleutel = m[1], rest = m[2];
    if (Object.prototype.hasOwnProperty.call(velden, sleutel)) return { fout: 'veld ' + sleutel + ' staat er twee keer' };
    i++;
    if (ontquote(rest) !== '' || /^\s*["']/.test(rest)) { velden[sleutel] = waardeVan(rest.replace(/^\s/, '')); continue; }
    // leeg na de dubbele punt: blok-lijst, geneste map of leeg
    const blok = [];
    while (i < eind && (/^\s+\S/.test(regels[i]) || regels[i].trim() === '')) { if (regels[i].trim() !== '') blok.push(regels[i]); i++; }
    if (!blok.length) { velden[sleutel] = ''; continue; }
    if (/^\s*-\s/.test(blok[0]) || /^\s*-$/.test(blok[0])) {
      velden[sleutel] = blok.map(function (b) { const x = /^\s*-\s?(.*)$/.exec(b); return x ? ontquote(x[1]) : null; });
      if (velden[sleutel].some(function (x) { return x === null; })) return { fout: 'lijst ' + sleutel + ' gemengd' };
      velden[sleutel] = velden[sleutel].filter(function (x) { return x !== ''; });
      continue;
    }
    const o = {}; let j = 0;
    while (j < blok.length) {
      const mm = /^\s+([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(blok[j]);
      if (!mm) return { fout: 'geneste regel in ' + sleutel + ' onleesbaar' };
      j++;
      if (ontquote(mm[2]) !== '' || /^\s*["']/.test(mm[2])) { o[mm[1]] = waardeVan(mm[2].replace(/^\s/, '')); continue; }
      const lijst = [];
      while (j < blok.length && /^\s+-(\s|$)/.test(blok[j])) { lijst.push(ontquote(/^\s*-\s?(.*)$/.exec(blok[j])[1])); j++; }
      o[mm[1]] = lijst.filter(function (x) { return x !== ''; });
    }
    velden[sleutel] = o;
  }
  return { velden: velden, eind: eind, regels: regels };
}

// Waar staat het blok? { geen } | { fout } | { b, bin (na het begin), e (begin van het eind), id, hash }. Zelfde regels als vóór wv1271:
// begin zonder eind (of omgekeerd), eind vóór begin of twee keer een begin = half of dubbel.
function blokPlek(tekst) {
  const t = String(tekst);
  const re = new RegExp(BLOK_BEGIN_RE.source, 'g'), ms = [];
  let m;
  while ((m = re.exec(t)) !== null) ms.push(m);
  const e = t.indexOf(BLOK_EIND);
  if (!ms.length && e < 0) return { geen: true };
  if (ms.length !== 1 || e < 0 || e < ms[0].index) return { fout: 'gegenereerd blok half of dubbel' };
  return { b: ms[0].index, bin: ms[0].index + ms[0][0].length, e: e, id: ms[0][1] || null, hash: ms[0][2] || null };
}
function blokHash(binnen) { return crypto.createHash('sha256').update(String(binnen), 'utf8').digest('hex').slice(0, 16); }
// true = er staat een blok mét hash en de tekst erbinnen is niet meer wat de compiler schreef (handwerk; K2).
function blokHandwerk(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n'), pl = blokPlek(t);
  return !!(pl.hash && blokHash(t.slice(pl.bin, pl.e)) !== pl.hash);
}

// Vingerafdruk zonder het gegenereerde blok en zonder `updated:` in de frontmatter (Fable wv979 #13).
function vingerafdruk(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n');
  const pl = blokPlek(t);
  if (pl.fout) return { fout: pl.fout };
  const zonder = !pl.geen ? t.slice(0, pl.b).replace(/\n+$/, '\n') + t.slice(pl.e + BLOK_EIND.length).replace(/^\n+/, '') : t;
  const regels = zonder.split('\n');
  let eind = -1;
  if (regels[0] === '---') for (let i = 1; i < regels.length; i++) if (regels[i] === '---') { eind = i; break; }
  const kern = regels.filter(function (r, i) { return !(eind > 0 && i > 0 && i < eind && /^updated:/.test(r)); }).join('\n').replace(/\n+$/, '');   // diffreview #8
  return { sha: crypto.createHash('sha256').update(kern, 'utf8').digest('hex') };
}

function lijst(v) { return Array.isArray(v) ? v.map(String) : v === undefined || v === null || v === '' ? [] : [String(v)]; }
function slug(s) { return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function normDomein(d) { return String(d).trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, ''); }

// Pagina-tekst → gegevens of fouten. rel = pad binnen de vault.
function leesPagina(rel, tekst) {
  const uit = { pad: rel, fouten: [] };
  if (Buffer.byteLength(String(tekst)) > MAX_BYTES) { uit.fouten.push('pagina groter dan 256 kB'); return uit; }
  const fm = frontmatter(tekst);
  if (fm.fout) { uit.fouten.push(fm.fout); return uit; }
  const va = vingerafdruk(tekst);
  if (va.fout) { uit.fouten.push(va.fout); return uit; }
  uit.sha = va.sha;
  const v = fm.velden, f = uit.fouten;
  if (v.type !== 'entiteit') { f.push('type is niet entiteit'); return uit; }
  uit.id = typeof v.entiteit_id === 'string' ? v.entiteit_id : '';
  uit.soort = typeof v.soort === 'string' ? v.soort : '';
  uit.status = v.status === 'concept' ? 'concept' : v.status === 'vast' ? 'vast' : '';
  uit.naam = typeof v.naam === 'string' ? v.naam : '';
  // SB2 fase 1a (wv1271): het veld heet voortaan `aliases` (zoals op de andere 1.236 pagina's en in Obsidian); `aliassen` blijft gelezen
  // tot alle entiteitpagina's om zijn. Allebei = fout: welke lijst telt, beslist niemand stil.
  if (v.aliases !== undefined && v.aliassen !== undefined) f.push('aliases en aliassen staan er allebei: hou alleen aliases');
  uit.aliassen = lijst(v.aliases !== undefined ? v.aliases : v.aliassen);
  uit.kvk = typeof v.kvk === 'string' ? v.kvk.replace(/\s/g, '') : '';
  uit.agb = typeof v.agb === 'string' ? v.agb.replace(/\s/g, '') : '';
  uit.iban = typeof v.iban === 'string' ? v.iban.replace(/\s/g, '').toUpperCase() : '';
  uit.domeinen = lijst(v.domeinen).map(normDomein);
  uit.mailadressen = lijst(v.mailadressen).map(function (x) { return x.trim().toLowerCase(); });
  uit.kenmerkpatronen = lijst(v.kenmerkpatronen);
  uit.niet_dezelfde_als = lijst(v.niet_dezelfde_als);
  uit.voor = lijst(v.voor);
  uit.betaalwijze = typeof v.betaalwijze === 'string' ? v.betaalwijze : '';
  uit.contact = [];
  const c = v.contact === '' || v.contact === undefined ? {} : v.contact;
  if (typeof c !== 'object' || Array.isArray(c)) f.push('contact is geen blok');
  else Object.keys(c).forEach(function (veld) {
    if (CONTACT.indexOf(veld) < 0) { f.push('onbekend contactveld ' + veld); return; }
    lijst(c[veld]).forEach(function (w) { if (w.trim()) uit.contact.push({ veld: veld, waarde: w.trim() }); });
  });
  // wv1253: waar elk kenmerk vandaan kwam ("domein leusden.nl: praktijkmail, 5 mails"), alleen voor de tekst op de kaart; stuurt niets
  uit.zaad = lijst(v.zaad).filter(function (x) { return x.length <= 200; });
  const ov = v.ovis && typeof v.ovis === 'object' && !Array.isArray(v.ovis) ? v.ovis : {};
  uit.db = lijst(ov.db);
  // validatie (ontwerp § 1; Fable wv979 #1, #3, #10)
  const m = EIGEN_RE.exec(rel), mo = ORG_RE.exec(rel);
  if (!m && !mo) f.push('pagina staat niet op een vaste plek voor entiteiten');
  if (uit.soort === 'eigen') {
    if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(uit.id)) f.push('eigen entiteit zonder code');
    if (!m || m[2] !== uit.id) f.push('bestandsnaam past niet bij entiteit_id (Entiteit - ' + uit.id + '.md)');
  } else {
    if (SOORTEN.indexOf(uit.soort) < 0) f.push('soort onbekend');
    if (!/^org:[a-z0-9]+(-[a-z0-9]+)*$/.test(uit.id) || uit.id.length > 64) f.push('entiteit_id van een organisatie moet org:<slug> zijn');
    if (!mo) f.push('organisatiepagina hoort in Relaties/');
    if (uit.iban) f.push('iban hoort niet op een organisatiepagina (rekeningnummers van derden blijven op de pod)');
  }
  if (!uit.status) f.push('status moet vast of concept zijn');
  if (uit.soort === 'eigen' && uit.status === 'concept') f.push('een eigen entiteit is nooit concept');   // diffreview #5
  uit.voor.forEach(function (x) { if (!/^[A-Z][A-Z0-9_]{1,15}$/.test(x)) f.push('voor noemt geen code van een eigen entiteit'); });   // diffreview #6
  if (!uit.naam || uit.naam.length > 200) f.push('naam leeg of te lang');
  if (uit.kvk && !/^[0-9]{8}$/.test(uit.kvk)) f.push('kvk is geen 8 cijfers');
  if (uit.agb && !/^[0-9]{8}$/.test(uit.agb)) f.push('agb is geen 8 cijfers');
  if (uit.iban && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(uit.iban)) f.push('iban ongeldig');
  if (uit.betaalwijze && ['zelf', 'incasso', 'betaald'].indexOf(uit.betaalwijze) < 0) f.push('betaalwijze onbekend');
  uit.aliassen.forEach(function (a) { if (a.length > 100) f.push('alias langer dan 100 tekens'); if (IBAN_RE.test(a) || BSN_RE.test(a)) f.push('alias lijkt op een rekening- of BSN-nummer'); });
  uit.domeinen.forEach(function (d) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) f.push('domein ongeldig');
    else if (PUBLIEK_DOMEIN.has(d)) f.push('publiek maildomein ' + d + ' is geen herkenningskenmerk');
  });
  uit.mailadressen.forEach(function (a) { if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(a)) f.push('mailadres ongeldig'); });
  uit.kenmerkpatronen.forEach(function (p) {
    if (p.length > 120) f.push('kenmerkpatroon te lang');
    else if (/\(\?<|\\[pPk][{<]/.test(p)) f.push('kenmerkpatroon gebruikt iets wat de databank niet kent (named group of \\p{})');   // diffreview #12
    else { try { new RegExp(p); } catch (e) { f.push('kenmerkpatroon is geen geldige regex'); } }
  });
  uit.niet_dezelfde_als.forEach(function (x) { if (x === uit.id) f.push('niet_dezelfde_als naar zichzelf'); });
  uit.contact.forEach(function (x) {
    if (x.waarde.length > 300) f.push('contactveld ' + x.veld + ' te lang');
    const bsn = x.veld === 'telefoon' ? x.waarde.replace(/[^0-9]/g, '').length === 9 : BSN_RE.test(x.waarde);
    if (IBAN_RE.test(x.waarde) || bsn) f.push('contactveld ' + x.veld + ' lijkt een rekening- of BSN-nummer te bevatten');
  });
  return uit;
}

function handvattenVan(p) {
  const h = [];
  if (p.kvk) h.push({ soort: 'kvk', waarde: p.kvk });
  p.aliassen.forEach(function (w) { h.push({ soort: 'alias', waarde: w }); });
  p.domeinen.forEach(function (w) { h.push({ soort: 'domein', waarde: w }); });
  p.mailadressen.forEach(function (w) { h.push({ soort: 'mail', waarde: w }); });
  p.kenmerkpatronen.forEach(function (w) { h.push({ soort: 'kenmerkpatroon', waarde: w }); });
  p.niet_dezelfde_als.forEach(function (w) { h.push({ soort: 'niet-dezelfde-als', waarde: w }); });
  return h;
}
function normHandvat(soort, w) {   // zelfde regels als secondbrain.ovis_norm
  w = String(w);
  if (soort === 'kvk') return w.replace(/[^0-9]/g, '');
  if (soort === 'domein') return normDomein(w);
  if (soort === 'mail') return w.trim().toLowerCase();
  if (soort === 'kenmerkpatroon' || soort === 'niet-dezelfde-als') return w.trim();
  return w.trim().replace(/\s+/g, ' ').toLowerCase();
}
function rpcInvoer(p, compilatie) {
  return { id: p.id, soort: p.soort === 'eigen' ? 'entiteit' : 'organisatie', rol: p.soort, naam: p.naam, concept: p.status === 'concept',
    vault_pagina: p.pad, bron_sha: p.sha, compilatie: compilatie, agb: p.agb || null, iban: p.soort === 'eigen' ? (p.iban || null) : null,
    voor: p.voor, betaalwijze: p.betaalwijze || null, handvatten: handvattenVan(p), contact: p.contact };
}

// ── het gegenereerde blok (pure functie; geen databank, Fable wv979 #15) ──
const SOORT_WOORD = { kvk: 'KvK', alias: 'alias', domein: 'domein', mail: 'mailadres', kenmerkpatroon: 'kenmerk', 'niet-dezelfde-als': 'niet dezelfde als' };
const STATUS_WOORD = { actief: 'vast', voorgesteld: 'voorgesteld, wacht op Davids Ja' };
function datumNl(iso) { const d = new Date(iso); if (isNaN(d)) return '?'; const x = d.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', year: 'numeric' }); return x.replace(/\//g, '-'); }
// wv1360 (David 26-10-2026 18:35, op "mag ik bij alle organisaties die we al vaker betaalden het rekeningnummer uit de bank vastleggen en op hun
// pagina tonen?"): "ELKE entiteit naar wie we al eens hebben betaald, mag beschouwd als correct gekoppeld. Dus ELK nummer wat al eens betaald
// is, is een geaccepteerd nummer" — ook van medewerkers. De nummers staan in de Facturen-database (leverancier_iban + feit, de IBAN-poort);
// de aanroeper geeft ze mee als o.rekeningen() → [{ iban, doel?, naam, aantal, eerste, laatste }] (doel = knoop-id of medewerkerpagina).
// Ze komen alleen in het gegenereerde blok, nooit in de frontmatter (leesPagina weigert iban op een organisatiepagina nog steeds).
const REK_KOP = '- Rekeningnummers (geaccepteerd: al eens betaald vanaf een eigen zakelijke rekening of nagebeld; nabellen niet nodig): ';
const MDW_RE = /^10_Zakelijk\/[^/]+\/Medewerkers\/[^/]+\.md$/;
const IBAN_VOL = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
function ibanLeesbaar(i) { return String(i).replace(/(.{4})/g, '$1 ').trim(); }
function rekeningTekst(r) {
  return ibanLeesbaar(r.iban) + (r.aantal > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(r.eerste)) ? ' (betaald sinds ' + datumNl(r.eerste + 'T12:00:00Z') + ', ' + r.aantal + ' keer)' : ' (nagebeld, nog niet betaald)');
}
function rekeningLijst(lijst) {
  return (lijst || []).filter(function (r) { return r && IBAN_VOL.test(String(r.iban)); })
    .sort(function (a, b) { return (b.aantal || 0) - (a.aantal || 0) || (a.iban < b.iban ? -1 : 1); });
}
function rekeningRegel(lijst) { const l = rekeningLijst(lijst); return l.length ? REK_KOP + l.map(rekeningTekst).join(' · ') : null; }
function mdwBlokTekst(pad, lijst) {
  const binnen = '\n' + ['## Rekeningnummers uit de bank', '',
    '*Gegenereerd door de OVIS-compiler (nacht) uit de Facturen-database; niet met de hand bewerken. Een rekeningnummer waar een eigen zakelijke rekening al eens naar betaalde, geldt als geaccepteerd (David 26-10-2026): nabellen is dan niet nodig.*', '']
    .concat(rekeningLijst(lijst).map(function (r) { return '- ' + rekeningTekst(r); })).join('\n') + '\n';
  const id = ('mdw:' + slug(path.basename(String(pad), '.md'))).slice(0, 80);
  return '<!-- ovis:blok begin id="' + id + '" content_hash="' + blokHash(binnen) + '" -->' + binnen + BLOK_EIND;
}
// Rekeningen zonder doel (bv. nagebeld in Beoordelen) horen bij een knoop als de leveranciersnaam precies één knoop noemt (naam, alias).
function rekeningenPerDoel(rek, knopen, handvatten) {
  const per = {}, opNaam = {};
  function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function zet(n, id) { const x = norm(n); if (x.length < 3) return; (opNaam[x] = opNaam[x] || new Set()).add(id); }
  (knopen || []).forEach(function (k) { if (k.rol === 'eigen' || k.soort === 'entiteit') return; zet(k.naam, k.id); (k.aliassen || []).forEach(function (a) { zet(a, k.id); }); });
  const org = new Set((knopen || []).filter(function (k) { return k.rol !== 'eigen' && k.soort !== 'entiteit'; }).map(function (k) { return k.id; }));
  (handvatten || []).forEach(function (h) { if (h.soort === 'alias' && h.status !== 'vervallen' && org.has(h.knoop)) zet(h.waarde, h.knoop); });
  (rek || []).forEach(function (r) {
    let doel = r && typeof r.doel === 'string' ? r.doel : null;
    if (!doel && r && r.naam) { const s = opNaam[norm(r.naam)]; if (s && s.size === 1) doel = Array.from(s)[0]; }
    if (doel) (per[doel] = per[doel] || []).push(r);
  });
  return per;
}
// Blok weghalen (alleen ons eigen medewerkerblok, wv1360 diffreview ZOU 4): de vingerafdruk van de pagina blijft gelijk.
function zonderBlok(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n'), pl = blokPlek(t);
  if (pl.b === undefined) return t;
  return t.slice(0, pl.b).replace(/\n+$/, '\n') + t.slice(pl.e + BLOK_EIND.length).replace(/^\n+/, '');
}
function blokTekst(knoop, handvatten, contact, rekeningen) {
  const h = handvatten.filter(function (x) { return x.status !== 'vervallen'; }).map(function (x) {
    return SOORT_WOORD[x.soort] + ' ' + (x.soort === 'alias' ? '"' + x.waarde + '"' : x.waarde) + ' (' + STATUS_WOORD[x.status] + (x.intrekking ? '; van de pagina gehaald, wacht op Davids Ja' : '') + ')';
  });
  const c = contact.filter(function (x) { return x.status !== 'vervallen'; }).map(function (x) {
    return x.veld + ' (' + STATUS_WOORD[x.status] + (x.intrekking ? '; van de pagina gehaald' : '') + ')';
  });
  // rekeningen: lijst (wv1360) of de bestaande regel als tekst (bron even niet te lezen: overnemen, rest van het blok wel vernieuwen)
  const rr = typeof rekeningen === 'string' ? (rekeningen.indexOf(REK_KOP) === 0 && rekeningen.indexOf('\n') < 0 ? rekeningen : null) : rekeningRegel(rekeningen);
  const binnen = '\n' + ['## Wat OVIS van deze partij weet', '',
    '*Gegenereerd door de OVIS-compiler (nacht); niet met de hand bewerken. Bron is de frontmatter hierboven; een nieuw kenmerk of contactgegeven telt pas na Davids Ja.*', '',
    '- Herkenningskenmerken: ' + (h.length ? h.join(' · ') : 'geen'),
    '- Contactgegevens in het register: ' + (c.length ? c.join(' · ') : 'geen')].concat(rr ? [rr] : []).concat([
    '- Register: ' + (knoop.concept ? 'concept · ' : '') + 'compilatie ' + (knoop.compilatienummer || '–') + ', laatst gewijzigd ' + (knoop.gecompileerd_op ? datumNl(knoop.gecompileerd_op) : '–')
  ]).join('\n') + '\n';
  const id = String(knoop.id || '').replace(/[^A-Za-z0-9:_.-]/g, '').slice(0, 80) || 'onbekend';
  return '<!-- ovis:blok begin id="' + id + '" content_hash="' + blokHash(binnen) + '" -->' + binnen + BLOK_EIND;
}
function zetBlok(tekst, blok) {
  const t = String(tekst).replace(/\r\n?/g, '\n'), pl = blokPlek(t);
  if (pl.b !== undefined) return t.slice(0, pl.b) + blok + t.slice(pl.e + BLOK_EIND.length);
  return t.replace(/\n*$/, '\n\n') + blok + '\n';
}
function huidigBlok(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n'), pl = blokPlek(t);
  return pl.b !== undefined ? t.slice(pl.b, pl.e + BLOK_EIND.length) : null;
}

// ── Bibliothecaris: de checks (pure functie over pagina's en register) ──
function kortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }
function schoon(s, n) { s = String(s == null ? '' : s).replace(/[\r\n`|]/g, ' ').slice(0, n || 300); return SLEUTEL_RE.test(s) ? '(weggelaten: leek op een sleutel)' : s; }
function checks(paginas, reg, compileerFouten, pot) {
  const b = [], tel = { paginas: paginas.length, geldig: 0, verouderd: 0, niet_getoetst: 0, wacht_op_ja: 0 };
  const knopen = {}; (reg.knopen || []).forEach(function (k) { knopen[k.id] = k; });
  const hv = {}; (reg.handvatten || []).forEach(function (h) { (hv[h.knoop] = hv[h.knoop] || []).push(h); });
  const ct = {}; (reg.contact || []).forEach(function (c) { (ct[c.knoop] = ct[c.knoop] || []).push(c); });
  const vert = {}; (reg.vertaling || []).forEach(function (v) { vert[v.bron + '=' + v.waarde] = v.knoop_ids || []; });
  function bev(check, sleutel, samenvatting, detail, ernst) {
    b.push({ bevinding_id: check + '-' + sleutel, check_id: check, samenvatting: schoon(samenvatting, 200), detail: schoon(detail, 600), ernst: ernst || 'warning' });
  }
  const perId = {};
  paginas.forEach(function (p) {
    if (p.fouten.length) { bev('BB6', (p.id && /^[A-Za-z0-9:_-]+$/.test(p.id) ? p.id : 'pagina') + '-' + kortHash(p.pad), 'entiteitpagina niet te lezen: ' + p.fouten[0], p.pad + ': ' + p.fouten.join('; ') + '. Voorstel: pagina herstellen (Socev) of uit de plek voor entiteiten halen.'); return; }
    (perId[p.id] = perId[p.id] || []).push(p);
  });
  const anker = {};   // id → pagina die telt
  Object.keys(perId).forEach(function (id) {
    const ps = perId[id], k = knopen[id];
    const a = k ? ps.find(function (p) { return p.pad === k.vault_pagina; }) : (ps.length === 1 ? ps[0] : null);
    if (a) anker[id] = a;
    if (!a && k && ps.length === 1) return;   // één pagina op een ander pad = verhuisd; BB2 hieronder zegt dat (diffreview #10)
    ps.filter(function (p) { return p !== a; }).forEach(function (p) {
      bev('BB5', id + '-pagina-' + kortHash(p.pad), 'tweede pagina voor ' + id, p.pad + ' noemt zich ' + id + ', maar ' + (k ? 'de knoop staat op ' + k.vault_pagina : 'er zijn meer pagina\'s met dit id') + '. Voorstel: deze pagina hernoemen of samenvoegen; verhuizen is een machinekamerstap.');
    });
  });
  Object.keys(anker).forEach(function (id) {
    const p = anker[id], k = knopen[id];
    tel.geldig++;
    // BB8 (wv1271, K2): iemand typte binnen het gegenereerde blok; de compiler laat het staan tot het is opgelost
    if (p.tekst !== undefined && blokHandwerk(p.tekst)) bev('BB8', id + '-blok', 'gegenereerd blok van ' + id + ' is met de hand gewijzigd', p.pad + ': de tekst binnen het OVIS-blok is niet meer wat de compiler schreef; hij overschrijft het niet. Voorstel: wat erin getypt is naar de frontmatter (de bron) zetten, daarna het blok laten vernieuwen.');
    if (!k) { tel.verouderd++; return; }   // nog niet gecompileerd (BB4: alleen telling)
    if (k.bron_sha !== p.sha) tel.verouderd++;
    // BB1 sleutels
    if (p.db.indexOf('supabase:secondbrain/knoop#' + id) < 0) bev('BB1', id + '-eigen-sleutel', 'pagina van ' + id + ' noemt zijn eigen databaserij niet', p.pad + ': ovis.db mist supabase:secondbrain/knoop#' + id + '. Voorstel: sleutel toevoegen.');
    p.db.forEach(function (s) {
      let m = /^supabase:secondbrain\/knoop#(.+)$/.exec(s);
      if (m) { if (!knopen[m[1]] || m[1] !== id) bev('BB1', id + '-' + kortHash(s), 'sleutel op de pagina van ' + id + ' wijst niet naar zijn rij', p.pad + ': ' + s + '. Voorstel: sleutel weghalen of rij aanmaken.'); return; }
      m = /^supabase:secondbrain\/knoop_vertaling#(.+)$/.exec(s);
      if (m) { const ids = vert[m[1]]; if (!ids || ids.indexOf(id) < 0) bev('BB1', id + '-' + kortHash(s), 'vertaalsleutel op de pagina van ' + id + ' bestaat niet', p.pad + ': ' + s + '. Voorstel: vertaling laden (laad.py) of sleutel weghalen.'); return; }
      if (POT_SLEUTEL_RE.test(s)) return;   // wv981: plek 4, getoetst in potChecks (ook op een pagina die nog niet gecompileerd is)
      tel.niet_getoetst++;
    });
    if (k.bron_sha !== p.sha) return;   // verouderd: de vergelijking hieronder pas na de volgende compilatie
    // BB3 voorstellen volgens de veldkaart
    if (k.naam !== p.naam) bev('BB3', id + '-naam', 'naam van ' + id + ' verschilt tussen pagina en register', 'pagina: "' + p.naam + '", register: "' + k.naam + '". Voorstel: pagina wint na Davids Ja (naamwijziging van een bestaande entiteit).');
    if (p.soort === 'eigen' && p.iban && p.iban !== (k.iban || '')) bev('BB3', id + '-iban', 'rekeningnummer van ' + id + ' verschilt tussen pagina en register (kritiek)', 'veld iban op ' + p.pad + ' ≠ register. Voorstel: Davids Ja met verse vingerafdruk, of de pagina terugzetten.', 'serious');
    if ((p.agb || '') !== (k.agb || '')) bev('BB3', id + '-agb', 'AGB van ' + id + ' verschilt tussen pagina en register', 'pagina: ' + (p.agb || 'leeg') + ', register: ' + (k.agb || 'leeg') + '. Voorstel: pagina wint na Davids Ja.');
    const dbh = (hv[id] || []).filter(function (h) { return h.status !== 'vervallen'; });
    const pag = handvattenVan(p).map(function (h) { return h.soort + '|' + normHandvat(h.soort, h.waarde); });
    const dbs = dbh.map(function (h) { return h.soort + '|' + h.waarde_norm; });
    const mist = pag.filter(function (x) { return dbs.indexOf(x) < 0; });
    const teveel = dbh.filter(function (h) { return pag.indexOf(h.soort + '|' + h.waarde_norm) < 0 && !h.intrekking; });
    if (mist.length || teveel.length) bev('BB3', id + '-handvatten', 'kenmerken van ' + id + ' verschillen tussen pagina en register', mist.length + ' alleen op de pagina, ' + teveel.length + ' alleen in het register (soorten: ' + mist.concat(teveel.map(function (h) { return h.soort; })).map(function (x) { return String(x).split('|')[0]; }).join(', ') + '). Voorstel: opnieuw compileren; blijft het, dan BB7 nalopen.');
    dbh.filter(function (h) { return h.intrekking; }).forEach(function (h) {
      bev('BB3', id + '-intrekking-' + h.id, h.soort + '-kenmerk van ' + id + ' is van de pagina gehaald', 'het kenmerk blijft vast tot Davids Ja (intrekken stuurt ook). Voorstel: Ja = laten vervallen, Nee = terug op de pagina.');
    });
    dbh.forEach(function (h) { if (h.status === 'voorgesteld') tel.wacht_op_ja++; });
    const dbc = (ct[id] || []).filter(function (c) { return c.status !== 'vervallen'; });
    CONTACT.forEach(function (veld) {
      const act = dbc.filter(function (c) { return c.veld === veld && c.status === 'actief'; });
      const vg = dbc.filter(function (c) { return c.veld === veld && c.status === 'voorgesteld'; });
      if (act.length && vg.length) bev('BB3', id + '-contact-' + veld, veld + ' van ' + id + ' heeft een nieuwe waarde naast de vaste (kritiek)', 'oud → nieuw staat in het register (waarde niet in deze melding). Voorstel: Davids Ja per veld' + (veld === 'factuuradres' ? ' met verse vingerafdruk' : '') + '.', 'serious');
      act.filter(function (c) { return c.intrekking; }).forEach(function (c) { bev('BB3', id + '-contact-intrekking-' + c.id, veld + ' van ' + id + ' is van de pagina gehaald (kritiek)', 'blijft vast tot Davids Ja. Voorstel: Ja = laten vervallen.', 'serious'); });
      tel.wacht_op_ja += vg.length;
    });
  });
  // BB2 rij zonder pagina
  Object.keys(knopen).forEach(function (id) {
    const k = knopen[id];
    if (k.actief === false || k.soort === 'persoon') return;
    if (anker[id]) return;
    const elders = (perId[id] || []).map(function (p) { return p.pad; });
    if (elders.length === 1) bev('BB2', id + '-verhuisd', 'pagina van ' + id + ' is verhuisd', 'register: ' + (k.vault_pagina || '(geen)') + ', pagina nu op ' + elders[0] + '. Voorstel: de machinekamer zet de verankering om (of de pagina terug).');
    else bev('BB2', id + '-geen-pagina', 'register kent ' + id + ' maar er is geen geldige pagina', (k.vault_pagina || '(geen vault_pagina)') + (elders.length ? '; wel pagina op ' + elders.join(', ') : '') + '. Voorstel: pagina aanmaken (concept) of de rij inactief zetten.');
  });
  // BB5 hetzelfde harde kenmerk bij twee knopen (Fable wv979 #5: niet bij een paar dat elkaar als niet-dezelfde-als noemt)
  const nda = {};
  (reg.handvatten || []).forEach(function (h) { if (h.soort === 'niet-dezelfde-als' && h.status !== 'vervallen') nda[h.knoop + '>' + h.waarde_norm] = true; });
  const harde = {};
  (reg.handvatten || []).forEach(function (h) {
    if (['kvk', 'domein', 'mail'].indexOf(h.soort) < 0 || h.status === 'vervallen') return;
    const s = h.soort + '|' + h.waarde_norm; (harde[s] = harde[s] || new Set()).add(h.knoop);
  });
  Object.keys(harde).forEach(function (s) {
    const ks = Array.from(harde[s]).sort();
    if (ks.length < 2) return;
    const paren = [];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (!nda[ks[i] + '>' + ks[j]] && !nda[ks[j] + '>' + ks[i]]) paren.push(ks[i] + '/' + ks[j]);
    paren.forEach(function (pr) { bev('BB5', pr.replace('/', '-') + '-' + kortHash(s), s.split('|')[0] + ' staat bij twee entiteiten (' + pr + ')', 'zelfde ' + s.split('|')[0] + ' bij ' + pr + '. Voorstel: kiezen bij welke het hoort, of "niet dezelfde als" op beide pagina\'s.'); });
  });
  // BB7 schrijver buiten de compiler
  Object.keys(knopen).forEach(function (id) {
    const k = knopen[id];
    if (k.laatst_door && SCHRIJVERS_OK.indexOf(k.laatst_door) < 0) bev('BB7', id + '-laatst-door', 'rij ' + id + ' is buiten de compiler gewijzigd', 'laatst_door = ' + k.laatst_door + ' (' + (k.bijgewerkt || '?') + '). Voorstel: terugzetten naar de pagina (opnieuw compileren) of de pagina bijwerken.');
  });
  const buiten = {};
  (reg.log || []).forEach(function (l) { if (SCHRIJVERS_OK.indexOf(l.wie) < 0) { const s = String(l.sleutel).split('#')[0]; (buiten[s] = buiten[s] || []).push(l); } });
  Object.keys(buiten).forEach(function (s) {
    const ls = buiten[s];
    bev('BB7', s + '-spoor-' + String(ls[0].wanneer || '').slice(0, 10).replace(/-/g, ''), ls.length + ' wijziging(en) aan ' + s + ' buiten de compiler', ls.slice(0, 5).map(function (l) { return l.tabel + ' ' + l.op + ' door ' + l.wie + ' ' + String(l.wanneer).slice(0, 16) + ' [' + (l.kolommen || []).join(',') + ']'; }).join('; ') + '. Voorstel: nagaan wie schreef; terugzetten of de pagina bijwerken.');
  });
  (reg.handvatten || []).concat(reg.contact || []).forEach(function (h) {
    const hk = h.herkomst || {};
    if (h.status === 'actief' && !hk.vraag_id && hk.bron !== 'migratie-0002') bev('BB7', h.knoop + '-actief-' + h.id, 'actief kenmerk van ' + h.knoop + ' zonder Ja', 'rij ' + h.id + ' (' + (h.soort || h.veld) + '). Voorstel: terug naar voorgesteld.', 'serious');
    // wv1253: een Ja hoort bij een kaart die met die vraag-id beslist is (de pod-haak); anders is hij buiten de knop om gezet
    else if (h.status === 'actief' && hk.vraag_id && hk.bron !== 'migratie-0002' && Array.isArray(reg.kaarten) && !reg.kaarten.some(function (k) { return k.sleutel === hk.kaart && k.beslist_vraag_id === hk.vraag_id; }))
      bev('BB7', h.knoop + '-actief-zonder-kaart-' + h.id, 'actief kenmerk van ' + h.knoop + ' zonder beslist kaart', 'rij ' + h.id + ' (' + (h.soort || h.veld) + ') noemt kaart ' + schoon(hk.kaart, 70) + '. Voorstel: nagaan wie activeerde; terug naar voorgesteld.', 'serious');
    else if (!hk.vraag_id && ['pagina', 'migratie-0002'].indexOf(hk.bron) < 0) bev('BB7', h.knoop + '-herkomst-' + h.id, 'kenmerk van ' + h.knoop + ' met onbekende herkomst', 'rij ' + h.id + '. Voorstel: nagaan wie schreef.');
  });
  // diffreview #1: een pagina die de databank blijvend weigert, mag niet stil als "verouderd" blijven staan
  (compileerFouten || []).forEach(function (cf) {
    if (/^databank: /.test(cf.fout)) bev('BB6', 'compileer-' + kortHash(cf.pad), 'pagina niet gecompileerd: ' + String(cf.fout).slice(10, 120), cf.pad + ': ' + cf.fout + '. Voorstel: pagina herstellen (Socev) of de machinekamer laat de databankfunctie nalopen.');
  });
  const pc = potChecks(anker, pot, bev, tel);   // wv981
  const uniek = {}; b.forEach(function (x) { uniek[x.bevinding_id] = x; });
  return { bevindingen: Object.keys(uniek).sort().map(function (k) { return uniek[k]; }), tel: tel, pot: pc };
}

// ── wv981: koppelregel plek 4 (POT in D1 fin; architectuur § 4 rij 4; ontwerp + Fable vooraf mk-scripts/wv981/ontwerp.md) ──
// De stampagina van de ontvangende praktijk is de bron van het factuuradres (contact.factuuradres, kritiek veld) en noemt haar POT-praktijk
// met ovis.db "cloudflare:d1-fin/praktijk#Pxx". De Bibliothecaris legt dat naast wat de POT-verzender gebruikt: het adres dat David in de
// POT-app bevestigde (praktijk.email), de dossierpagina die pot-verzend.js nu leest (facturen_aan, zelfde parser) en elke open nota met
// een adres. Alleen lezen: dit raakt de verzender niet, en niets hier maakt een adres actief of bevestigd. Een kant die niet te meten is,
// is "niet gemeten", nooit een verschil (Fable #1). P9x zijn proefpraktijken en tellen nergens mee.
const POT_SLEUTEL_RE = /^cloudflare:d1-fin\/praktijk#(P\d{2})$/, POT_PROEF_RE = /^P9\d$/;
const POT_OPEN = ['wacht_op_adres', 'concept', 'auto_gevraagd', 'auto_vrij', 'verzenden', 'onzeker'];
// Alleen deze twee SELECT's; potMeting weigert alles wat geen SELECT is (Fable #4: het D1-eindpunt kan ook schrijven)
const POT_SQL = [
  { sql: 'select id, naam, naam_brief, email from praktijk order by id', params: [] },
  { sql: 'select id, nummer, praktijk_id, status, aan, cc from nota_verzending where status in (' + POT_OPEN.map(function (x) { return "'" + x + "'"; }).join(',') + ') order by id', params: [] },
];
// io: { d1(batch) → [{ results }], dossier() → { per, problemen } (pot-verzend.ontvangers over de dossierpagina's) } → meting of { fout }
async function potMeting(io) {
  try {
    if (!io || typeof io.d1 !== 'function' || typeof io.dossier !== 'function') return { fout: 'geen POT-lezer' };
    if (POT_SQL.some(function (q) { return !/^\s*select\b/i.test(q.sql); })) return { fout: 'alleen lezen' };
    const r = await io.d1(POT_SQL.map(function (q) { return { sql: q.sql, params: q.params.slice() }; }));
    if (!Array.isArray(r) || r.length !== 2 || !r.every(function (x) { return x && Array.isArray(x.results); })) return { fout: 'D1 gaf geen resultaat' };
    if (!r[0].results.length) return { fout: 'D1 gaf geen praktijken' };   // diffreview #2: leeg is niet gemeten (anders alles BB1 en alles "opgelost")
    const d = io.dossier();
    if (!d || typeof d.per !== 'object' || typeof d.problemen !== 'object') return { fout: 'dossierpagina\'s niet te lezen' };
    return { praktijken: r[0].results, open: r[1].results, dossier: d };
  } catch (e) { return { fout: String(e && e.message || e).replace(/\d{6,}/g, '#').slice(0, 120) }; }
}
// zelfde normalisatie als pot-verzend.adresNorm (kleine letters, gesplitst op komma/puntkomma/spatie, volgorde blijft), zodat de
// Bibliothecaris en de verzender hetzelfde "gelijk" kennen (diffreview #5)
function potAdressen(x) {
  return (Array.isArray(x) ? x : [x]).join(',').split(/[,;\s]+/).map(function (a) { return a.trim().toLowerCase(); }).filter(Boolean);
}
function potGelijk(a, b) { return a.join(',') === b.join(','); }
// → { gemeten, verschillen: [{ knoop, naam, px, stam, app, dossier, nota: [{ nummer, status, aan }], wacht_op_adres }] } (adressen alleen
// hier, voor de kaart; nooit in bevinding of box, Fable wv979 #10)
function potChecks(anker, pot, bev, tel) {
  const claims = {};
  Object.keys(anker).forEach(function (id) {
    (anker[id].db || []).forEach(function (s) { const m = POT_SLEUTEL_RE.exec(s); if (m && !POT_PROEF_RE.test(m[1]) && (claims[m[1]] = claims[m[1]] || []).indexOf(id) < 0) claims[m[1]].push(id); });
  });
  if (!pot || pot.fout) { tel.pot = 'niet gemeten'; return { gemeten: false, reden: pot ? pot.fout : 'geen POT-lezer', verschillen: [] }; }
  const prak = {}; (pot.praktijken || []).forEach(function (r) { prak[r.id] = r; });
  const uit = { gemeten: true, verschillen: [] };
  tel.pot = 0; tel.pot_verschil = 0;
  Object.keys(claims).sort().forEach(function (px) {
    const ids = claims[px];
    if (ids.length > 1) { bev('BB5', 'pot-' + px + '-twee', 'POT-praktijk ' + px + ' staat op twee stampagina\'s', ids.join(' en ') + ' noemen allebei cloudflare:d1-fin/praktijk#' + px + '. Voorstel: de sleutel alleen laten staan op de pagina van de praktijk zelf.'); return; }
    const id = ids[0], p = anker[id];
    if (!prak[px]) { bev('BB1', id + '-pot-' + px, 'pagina van ' + id + ' verwijst naar een POT-praktijk die de POT-app niet kent', p.pad + ': cloudflare:d1-fin/praktijk#' + px + '. Voorstel: sleutel weghalen of de juiste praktijkcode zetten.'); return; }
    tel.pot++;
    const stam = potAdressen(p.contact.filter(function (c) { return c.veld === 'factuuradres'; }).map(function (c) { return c.waarde; }));
    const app = potAdressen(prak[px].email || '');
    const dd = pot.dossier.per[px], dp = pot.dossier.problemen[px];
    const dossier = dd ? potAdressen(dd.aan) : [];
    const nota = (pot.open || []).filter(function (r) { return r.praktijk_id === px; });
    const kanten = [];
    if (!potGelijk(stam, app)) kanten.push('het adres dat David in de POT-app bevestigde');
    if (dp && /onleesbaar|twee pagina/.test(dp)) kanten.push('de dossierpagina (' + (/twee/.test(dp) ? 'twee pagina\'s geven een ander adres' : 'adres onleesbaar') + ')');
    else if (!potGelijk(stam, dossier)) kanten.push('de dossierpagina die de verzender leest');
    const notaAnders = nota.filter(function (r) { return r.aan && !potGelijk(stam, potAdressen(r.aan)); });   // een rij zonder adres (geen_adres) vergelijkt niets
    if (notaAnders.length) kanten.push(notaAnders.length + ' open nota(\'s) (' + Array.from(new Set(notaAnders.map(function (r) { return r.status; }))).join(', ') + ')');
    const cc = (dd && dd.cc && dd.cc.length) || nota.some(function (r) { return potAdressen(r.cc || '').length; });
    if (cc) bev('BB3', id + '-pot-cc-' + px, 'cc op de factuur van ' + px + ' staat nog niet op de stampagina', 'de dossierpagina of een open nota gebruikt een cc; de stampagina kent (nog) geen cc-veld. Voorstel: laten staan tot fase 2 (verzender leest de stampagina), dan een cc-veld toevoegen.');
    if (!kanten.length) return;
    tel.pot_verschil++;
    bev('BB3', id + '-pot-factuuradres-' + px, 'factuuradres van ' + (p.naam || id) + ' (' + px + ') verschilt tussen stampagina en POT-verzender (kritiek)',
      p.pad + ': stampagina (bron, veldkaart plek 4) ≠ ' + kanten.join('; ') + (stam.length ? '' : '; de stampagina heeft geen factuuradres') + '. Adressen niet in deze melding. Voorstel: David zegt welk adres klopt; Socev zet de stampagina en de dossierpagina gelijk; de POT-app vraagt bij de volgende nota zelf om bevestiging.', 'serious');
    uit.verschillen.push({ knoop: id, naam: p.naam || id, px: px, stam: stam, app: app, dossier: dd ? dossier : null, dossier_probleem: dp || null,
      nota: notaAnders.map(function (r) { return { nummer: r.nummer, status: r.status, aan: potAdressen(r.aan) }; }),
      wacht_op_adres: nota.some(function (r) { return r.status === 'wacht_op_adres'; }) });
  });
  (pot.praktijken || []).forEach(function (r) {
    if (!POT_PROEF_RE.test(r.id) && !claims[r.id]) bev('BB2', 'pot-' + r.id + '-geen-pagina', 'POT-praktijk ' + r.id + ' heeft geen stampagina die naar hem verwijst', 'D1 fin.praktijk ' + r.id + ' (' + schoon(r.naam_brief || r.naam || '', 60) + '). Voorstel: de sleutel cloudflare:d1-fin/praktijk#' + r.id + ' op de stampagina van die praktijk zetten.');
  });
  return uit;
}
// Bevindingen van plek 4 (om ze niet "opgelost" te noemen als de POT-kant niet gemeten is, Fable #1)
const POT_BEVINDING_RE = /^BB\d-(pot-P\d{2}-|.+-pot-(factuuradres-|cc-)?P\d{2}$)/;

// De kaart bij een kritiek verschil (Fable #2, #3, #6, #9, #11): één Voor jou-kaart per stampagina, sleutel = stampagina + de adressen
// zelf (zelfde situatie = zelfde kaart, Davids "gedaan" blijft staan), geen kaart zolang pot-verzend voor die praktijk al een adreskaart
// heeft (nota in wacht_op_adres), dicht alleen als de POT-kant gemeten is en het verschil weg is. Buiten de ovis_kaart-machinerie:
// geen haak, geen knop die iets vastzet; herkomst handmatig bibliothecaris (nooit module intake of een sleutel die met pot- begint).
function potLijst(l) { return l && l.length ? l.join(', ') : 'leeg'; }
function kaartPot(meting, stand, nuKort) {
  const uit = { zet: [], dicht: [] };
  if (!meting || !meting.gemeten) return uit;
  const open = function (s) { return stand[s] === 'open' || stand[s] === 'later'; };
  const per = {};
  meting.verschillen.forEach(function (v) { (per[v.knoop] = per[v.knoop] || []).push(v); });
  const nodig = new Set(), overgenomen = new Set();
  Object.keys(per).sort().forEach(function (id) {
    const vv = per[id];
    if (vv.some(function (v) { return v.wacht_op_adres; })) { overgenomen.add(slugKort(id)); return; }   // pot-verzend heeft al een adreskaart (Fable #2)
    // diffreview #3: de nota's niet in de sleutel (een statusovergang is geen nieuwe situatie)
    const sleutel = 'ovis-pot-adres-' + slugKort(id) + '-' + fnv6(JSON.stringify(vv.map(function (v) { return [v.px, v.stam, v.app, v.dossier, v.dossier_probleem]; })));
    nodig.add(sleutel);
    if (stand[sleutel]) return;   // staat er al (open), of David zette hem dicht: niet opnieuw
    const naam = kort(vv[0].naam, 50), v0 = vv[0], pxs = vv.map(function (v) { return v.px; });
    // houdt de verzender deze praktijk nu al tegen? (pot-verzend eist praktijkpagina == POT-app == adres van de nota)
    const geblokkeerd = vv.some(function (v) { return !v.dossier || !v.app.length || !potGelijk(v.dossier, v.app); });
    const alleenNota = !geblokkeerd && vv.every(function (v) { return potGelijk(v.stam, v.app); });   // stamkaart = pagina = POT-app; alleen een open nota wijkt af
    const stappen = ['Zeg tegen Socev welk adres klopt, bijvoorbeeld: "factuuradres ' + kort(naam, 40) + ' is …". Socev zet de Second Brain dan op één adres.'];
    if (vv.some(function (v) { return !potGelijk(v.stam, v.app); })) stappen.push('Het adres in de POT-app hoef je nu niet aan te passen: bij de volgende nota vraagt de POT-app je het adres te bevestigen.');
    vv.forEach(function (v) { v.nota.forEach(function (n) {
      if (n.status === 'concept') stappen.push('Nota ' + n.nummer + ' staat als concept in Gmail met ' + potLijst(n.aan) + '. Klopt dat niet: gooi het concept weg en zet de nota in de POT-app opnieuw klaar.');
      else if (n.status === 'auto_gevraagd' || n.status === 'auto_vrij') stappen.push('Nota ' + n.nummer + ' staat klaar om vanzelf te gaan. Met een ander adres gaat hij niet vanzelf; op de verzenddag wordt het een concept dat je zelf nakijkt.');
      else stappen.push('Nota ' + n.nummer + ' (' + n.status + ') heeft ' + potLijst(n.aan) + '; kijk in de POT-app of dat klopt.');
    }); });
    stappen.push('Deze kaart gaat de ochtend nadat het overal gelijk is vanzelf dicht.');
    const meting_ = vv.map(function (v) { return v.px + ': Second Brain ' + potLijst(v.stam) + '; POT-app ' + potLijst(v.app) + (v.dossier_probleem && !v.dossier ? '; praktijkpagina ' + kort(v.dossier_probleem, 60) : v.dossier && !potGelijk(v.dossier, v.stam) ? '; praktijkpagina ' + potLijst(v.dossier) : ''); }).join(' · ');
    uit.zet.push({ sleutel: sleutel, soort: 'doen', volgorde: 22, waar: 'overal', prive: true, duur_min: 3,
      titel: kort(naam + ' — factuuradres gelijktrekken', KAART_TITEL),
      herkomst: { handmatig: 'bibliothecaris', soort: 'pot-adres', knoop: id, praktijken: pxs },
      waarom: kort('Het factuuradres van ' + naam + ' staat niet overal hetzelfde. Naar dat adres gaan de POT-nota\'s (SLOEL soms vanzelf). ' +
        (geblokkeerd ? 'Zolang de praktijkpagina en de POT-app verschillen, zet Socev voor deze praktijk geen nota klaar en gaat er niets vanzelf.'
          : alleenNota ? 'Een nota die al klaarstaat heeft nog een ander adres dan de Second Brain.'
            : 'Nota\'s gaan nu nog naar ' + potLijst(v0.app) + ' (praktijkpagina en POT-app); de stamkaart in de Second Brain zegt iets anders.') + ' De Second Brain is de bron.', KAART_WAAROM),
      stappen: stappen.slice(0, KAART_STAPPEN).map(function (x) { return kort(x, 400); }),
      meting: kort(nuKort + ': ' + meting_, 300) });
  });
  Object.keys(stand).forEach(function (s) {
    if (!/^ovis-pot-adres-/.test(s) || !open(s) || nodig.has(s)) return;
    const slug = s.replace(/^ovis-pot-adres-/, '').replace(/-[0-9a-f]{6}$/, '');   // diffreview #4: het bewijs zegt waarom hij dichtgaat
    const nieuwe = Array.from(nodig).some(function (n) { return n.indexOf('ovis-pot-adres-' + slug + '-') === 0; });
    uit.dicht.push({ sleutel: s, van: stand[s], bewijs: nuKort + ': ' + (overgenomen.has(slug) ? 'er wacht nu een nota op het adres; de kaart van de POT-app neemt het over.'
      : nieuwe ? 'de adressen zijn veranderd; er staat een nieuwe kaart.' : 'de Bibliothecaris ziet dit verschil niet meer (factuuradres overal gelijk).') });
  });
  return uit;
}

// ── Kaarten in Overzicht (wv1253; ontwerp + Fable-review vooraf: mk-scripts/wv1253/ontwerp.md) ──
// Pure functies: wat er op een kaart moet (bundel per week, kritiek per veld, Bibliothecaris per week), de Anders-ontleding en de zin
// voor Socev na Davids druk. De databank (public.ovis_kaart_zet) controleert en bevriest de lijst; public.ovis_handvat_activeer voert
// Davids keuze uit. Kaarttekst in gewone taal, zonder pad of wv-nummer (machinekamer.voor_jou_verwijzing weigert die).
const KAART_STAPPEN = 12, KAART_TITEL = 90, KAART_WAAROM = 400, NEE_RUST_MS = 28 * 86400000;
const KENMERK_WOORD = { kvk: 'KvK', alias: 'naam', domein: 'website', mail: 'mailadres', kenmerkpatroon: 'nummerpatroon', 'niet-dezelfde-als': 'niet dezelfde als' };
const VELD_WOORD = { adres: 'adres', factuuradres: 'factuuradres', boekhoudadres: 'boekhoudadres', afschriftadres: 'adres voor afschriften', telefoon: 'telefoonnummer',
  email: 'mailadres', website: 'website', contactpersoon: 'contactpersoon', naam: 'naam', agb: 'AGB-code', iban: 'rekeningnummer' };
function isoWeek(ms) {
  const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dag = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dag);
  const j = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(j, 0, 1)) / 86400000 + 1) / 7);
  return { jaar: j, week: w, tekst: j + '-' + String(w).padStart(2, '0') };
}
function kort(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
function fnv6(t) { return crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 6); }
// Anders → welke nummers eruit (Fable wv1253 #4): alleen met een uitsluitwoord en verder niets dan nummers en verbindingswoorden.
// "zonder 3 en 7", "3, 7 eruit", "niet 2-4", "regel 5 weg". Kale nummers of een ander woord ("alleen 3") → null (niets vastzetten).
function eruitUit(toelichting, n) {
  const t = String(toelichting || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[.!]+\s*$/, '').trim();
  if (!t || t.length > 120) return null;
  if (!/\b(zonder|niet|behalve|eruit|weg|uit)\b/.test(t)) return null;
  const woorden = t.replace(/(\d+)\s*(?:-|–|t\/m|tot en met)\s*(\d+)/g, ' $1-$2 ').split(/[\s,;:+&]+/).filter(Boolean);
  const uit = new Set();
  for (const w of woorden) {
    if (/^(zonder|niet|behalve|eruit|weg|uit|haal|halen|regel|regels|nummer|nummers|nr|nrs|en|ook|graag|de|het|ja|alles|a\.?u\.?b\.?)$/.test(w)) continue;
    let m = /^(\d{1,2})-(\d{1,2})$/.exec(w);
    if (m) { const a = Number(m[1]), b = Number(m[2]); if (a < 1 || b > n || a > b) return null; for (let i = a; i <= b; i++) uit.add(i); continue; }
    m = /^(\d{1,2})$/.exec(w);
    if (m) { const x = Number(m[1]); if (x < 1 || x > n) return null; uit.add(x); continue; }
    return null;
  }
  return uit.size ? Array.from(uit).sort(function (a, b) { return a - b; }) : null;
}
// zaad-regel van de pagina bij een kenmerk: "domein leusden.nl: praktijkmail, 5 mails" → "praktijkmail, 5 mails"
function zaadVan(p, soort, waardeNorm) {
  const z = (p && p.zaad || []).map(function (x) { const i = x.indexOf(':'); return i > 0 ? { sleutel: x.slice(0, i).trim().toLowerCase(), tekst: x.slice(i + 1).trim() } : null; }).filter(Boolean);
  const hit = z.find(function (x) { return x.sleutel === (soort + ' ' + waardeNorm).toLowerCase(); });
  return hit ? hit.tekst : null;
}
function gewichtVan(p) { return (p && p.zaad || []).reduce(function (a, x) { const m = /(\d+)\s*(×|x|keer|mails?|facturen|factuur)/i.exec(x); return a + (m ? Number(m[1]) : 0); }, 0); }
function priveKnoop(k, p) { return k.id === 'PRIVE' || /^20_Prive\//.test(String(p && p.pad || k.vault_pagina || '')); }
function kenmerkTekst(h, p) {
  const z = zaadVan(p, h.soort, h.waarde_norm);
  const wat = h.soort === 'domein' ? 'mail van @' + h.waarde : h.soort === 'mail' ? 'mail van ' + h.waarde : KENMERK_WOORD[h.soort] + ' ' + (h.soort === 'alias' ? '"' + h.waarde + '"' : h.waarde);
  return wat + ' (' + (z ? kort(z.replace(/[()]/g, ''), 60) : 'op de pagina gezet') + ')';
}
// Wat al op een kaart staat of (nog) niet terug mag (Fable wv1253 #7): open kaart = bezet; Nee = 28 dagen rust; eruit-regel = tot het
// kenmerk verandert (andere herkomst-sha); weg en Anders-zonder-nummers = mag weer.
function kaartGeheugen(reg, nu) {
  const open = new Set(), rust = new Set(), sleutels = new Set();
  (reg.kaarten || []).forEach(function (k) {
    sleutels.add(k.sleutel);
    (k.regels || []).forEach(function (r) {
      const sl = r.tabel + '#' + r.id, metSha = sl + '#' + (r.sha || '');
      if (k.status === 'open') open.add(sl);
      else if (k.status === 'nee' && Date.parse(k.beslist_op) > nu - NEE_RUST_MS) rust.add(metSha);
      else if ((k.status === 'anders' || k.status === 'ja') && Array.isArray(k.eruit) && k.eruit.indexOf(Number(r.nr)) >= 0) rust.add(metSha);
      else if (k.soort === 'biblio' && (k.status === 'ja' || k.status === 'anders') && Date.parse(k.beslist_op) > nu - NEE_RUST_MS) rust.add(metSha);   // diffreview #9
    });
  });
  return { open: open, rust: rust, sleutels: sleutels };
}
// Ankers: geldige, bijgewerkte pagina per knoop-id
function ankers(paginas, knopen) {
  const per = {}, a = {};
  paginas.forEach(function (p) { if (!p.fouten || !p.fouten.length) (per[p.id] = per[p.id] || []).push(p); });
  Object.keys(per).forEach(function (id) { const k = knopen[id]; if (!k) return; const p = per[id].find(function (x) { return x.pad === k.vault_pagina; }); if (p && k.bron_sha === p.sha) a[id] = p; });
  return a;
}

function kaartBundel(reg, paginas, o) {
  const nu = o.nu, knopen = {}; (reg.knopen || []).forEach(function (k) { knopen[k.id] = k; });
  const geh = kaartGeheugen(reg, nu), anker = ankers(paginas, knopen), wk = isoWeek(nu);
  const sleutel = 'intake-handvat-' + wk.jaar + '-' + String(wk.week).padStart(2, '0');
  if (geh.sleutels.has(sleutel)) return { reden: 'deze week al een bundel' };
  if ((reg.kaarten || []).some(function (k) { return k.soort === 'bundel' && k.status === 'open'; })) return { reden: 'er staat nog een bundel open' };
  const harde = {};
  (reg.handvatten || []).forEach(function (h) { if (['kvk', 'domein', 'mail'].indexOf(h.soort) >= 0 && h.status !== 'vervallen') { const s = h.soort + '|' + h.waarde_norm; (harde[s] = harde[s] || new Set()).add(h.knoop); } });
  const per = {};
  (reg.handvatten || []).forEach(function (h) {
    if (h.status !== 'voorgesteld' || !anker[h.knoop]) return;
    const sl = 'handvat#' + h.id;
    if (geh.open.has(sl) || geh.rust.has(sl + '#' + ((h.herkomst || {}).sha || ''))) return;
    if (harde[h.soort + '|' + h.waarde_norm] && harde[h.soort + '|' + h.waarde_norm].size > 1) return;   // BB5: eerst uitzoeken bij wie het hoort
    (per[h.knoop] = per[h.knoop] || []).push(h);
  });
  const ids = Object.keys(per).sort(function (a, b) {
    const ka = knopen[a], kb = knopen[b];
    if ((ka.soort === 'entiteit') !== (kb.soort === 'entiteit')) return ka.soort === 'entiteit' ? -1 : 1;
    return gewichtVan(anker[b]) - gewichtVan(anker[a]) || String(ka.naam).localeCompare(String(kb.naam), 'nl');
  });
  const stappen = [], regels = []; let prive = false, kenmerken = 0;
  for (const id of ids) {
    if (stappen.length >= KAART_STAPPEN) break;
    const k = knopen[id], p = anker[id], nr = stappen.length + 1;
    let tekst = nr + '. ' + kort(k.naam, 60) + ': ';
    const mee = [];
    for (const h of per[id].sort(function (a, b) { return a.id - b.id; })) {
      const t = kenmerkTekst(h, p);
      if ((tekst + mee.concat(t).join('; ')).length > 320 || regels.length >= 40) break;   // een kenmerk dat niet past komt volgende keer; nooit half getoond
      mee.push(t); regels.push({ nr: nr, actie: 'activeer', tabel: 'handvat', id: h.id, knoop: h.knoop, soort: h.soort, waarde_norm: h.waarde_norm });
    }
    if (!mee.length) continue;
    stappen.push(tekst + mee.join('; ')); kenmerken += mee.length;
    if (priveKnoop(k, p)) prive = true;
  }
  if (!stappen.length) return { reden: 'geen nieuwe kenmerken' };
  const restOrg = ids.length - stappen.length;
  const titel = kenmerken === 1 && stappen.length === 1 ? '1 nieuw herkenningskenmerk bij 1 organisatie — zo vastzetten?'
    : kenmerken + ' nieuwe herkenningskenmerken bij ' + stappen.length + (stappen.length === 1 ? ' organisatie' : ' organisaties') + ' — zo vastzetten?';
  const waarom = 'Hiermee herkent Socev straks wie een mail, factuur of brief stuurde. Een kenmerk telt pas na jouw Ja; anders kan een mail zich als bekende afzender voordoen. '
    + 'Ja: alles hieronder vast. Nee: niets vast (komt over vier weken terug). Anders: typ welke nummers eruit moeten, bijvoorbeeld "zonder 3 en 7"; de rest wordt vast.'
    + (restOrg > 0 ? ' Nog ' + restOrg + (restOrg === 1 ? ' organisatie volgt' : ' organisaties volgen') + ' in de komende weken.' : '');
  return { kaart: { sleutel: sleutel, soort: 'bundel', titel: titel, waarom: kort(waarom, KAART_WAAROM), stappen: stappen, prive: prive, regels: regels } };
}

function kaartenKritiek(reg, paginas, o) {
  const nu = o.nu, knopen = {}; (reg.knopen || []).forEach(function (k) { knopen[k.id] = k; });
  const geh = kaartGeheugen(reg, nu), anker = ankers(paginas, knopen), uit = [];
  function maak(k, p, veld, regels, stappen, titelWoord, uitleg) {
    if (!regels.length || regels.length > 6 || stappen.length > KAART_STAPPEN) return;   // diffreview #3: nooit een regel die David niet ziet
    if (regels.some(function (r) { return geh.open.has(r.tabel + '#' + (r.tabel === 'knoop' ? r.knoop + '#' + r.veld : r.id)); })) return;
    // zelfde voorstel (zelfde regels, waarden en herkomst) = zelfde basissleutel. Nee = niet opnieuw tot de pagina iets anders zegt; open = wacht;
    // eerder zonder uitkomst (weg, Anders, overgeslagen zonder vingerafdruk) = opnieuw met een volgnummer
    const slug = slugKort(k.id), basis = 'intake-kritiek-' + slug + '-' + veld.replace(/[^a-z]/g, '').slice(0, 12) + '-' + fnv6(JSON.stringify(regels));
    const eerder = (reg.kaarten || []).filter(function (x) { return x.sleutel === basis || x.sleutel.indexOf(basis + '-') === 0; });
    if (eerder.some(function (x) { return x.status === 'open' || x.status === 'nee'; })) return;
    let sleutel = basis;
    for (let i = 2; geh.sleutels.has(sleutel) && i < 10; i++) sleutel = basis + '-' + i;
    if (geh.sleutels.has(sleutel) || sleutel.length > 61) return;
    const titel = kort(kort(k.naam, 40) + ': ' + titelWoord + ' — zo vastzetten?', KAART_TITEL);
    const gev = regels.some(function (r) { return r.veld === 'iban' || ['factuuradres', 'boekhoudadres', 'afschriftadres'].indexOf(r.veld) >= 0; });
    const waarom = uitleg + ' Ja: zoals hieronder. Nee: alles blijft zoals het nu is.' + (gev ? ' De app vraagt je vingerafdruk.' : '');
    uit.push({ sleutel: sleutel, soort: 'kritiek', titel: titel, waarom: waarom, stappen: stappen, prive: priveKnoop(k, p), regels: regels.map(function (r) { const x = Object.assign({}, r); delete x.sha; return x; }) });
  }
  Object.keys(anker).forEach(function (id) {
    const k = knopen[id], p = anker[id];
    // contact: nieuwe waarde naast een vaste, of een vaste die van de pagina verdween
    const ct = (reg.contact || []).filter(function (c) { return c.knoop === id && c.status !== 'vervallen'; });
    CONTACT.forEach(function (veld) {
      const act = ct.filter(function (c) { return c.veld === veld && c.status === 'actief'; }), vg = ct.filter(function (c) { return c.veld === veld && c.status === 'voorgesteld'; });
      const weg = act.filter(function (c) { return c.intrekking; });
      if (!act.length || (!vg.length && !weg.length)) return;   // eerste gebruik: geen kaart (bouwplan § 4.4 punt 3)
      const regels = [], stappen = [];
      let nr = 0;
      act.filter(function (c) { return !c.intrekking; }).slice(0, 4).forEach(function (c) { stappen.push('Blijft: ' + kort(c.waarde, 300)); });
      weg.forEach(function (c) { nr++; regels.push({ nr: nr, actie: 'vervallen', tabel: 'contact', id: c.id, knoop: id, veld: veld, waarde: c.waarde, sha: '' }); stappen.push(nr + '. Oud, vervalt: ' + kort(c.waarde, 300)); });
      vg.forEach(function (c) { nr++; regels.push({ nr: nr, actie: 'activeer', tabel: 'contact', id: c.id, knoop: id, veld: veld, waarde: c.waarde, sha: (c.herkomst || {}).sha || '' }); stappen.push(nr + '. Nieuw: ' + kort(c.waarde, 300)); });
      maak(k, p, veld, regels, stappen, VELD_WOORD[veld] + (vg.length ? ' wijzigen' : ' laten vervallen'),
        'Dit gegeven gebruikt Socev om naartoe te schrijven, te bellen, te sturen of te betalen; daarom vraag ik elke wijziging per gegeven.');
    });
    // een vast kenmerk dat van de pagina verdween
    const ingetrokken = (reg.handvatten || []).filter(function (h) { return h.knoop === id && h.status === 'actief' && h.intrekking; });
    if (ingetrokken.length) {
      const r = ingetrokken.slice(0, 6).map(function (h, i) { return { nr: i + 1, actie: 'vervallen', tabel: 'handvat', id: h.id, knoop: id, soort: h.soort, waarde_norm: h.waarde_norm, sha: '' }; });
      maak(k, p, 'kenmerk', r, ingetrokken.slice(0, 6).map(function (h, i) { return (i + 1) + '. ' + KENMERK_WOORD[h.soort] + ' ' + h.waarde + ' vervalt (staat niet meer op de pagina)'; }), ingetrokken.length === 1 ? 'kenmerk laten vervallen' : ingetrokken.length + ' kenmerken laten vervallen',
        'Dit staat niet meer op de pagina. Tot jouw Ja herkent Socev de afzender er nog aan.');
    }
    // naam, AGB, rekeningnummer van een bestaande knoop
    [['naam', p.naam, k.naam], ['agb', p.agb, k.agb], ['iban', k.soort === 'entiteit' ? p.iban : '', k.iban]].forEach(function (x) {
      const veld = x[0], nieuw = x[1] || '', oud = x[2] || '';
      if (!nieuw || nieuw === oud) return;
      maak(k, p, veld, [{ nr: 1, actie: 'zet', tabel: 'knoop', knoop: id, veld: veld, oud: oud || null, nieuw: nieuw, sha: nieuw }],
        ['Nu: ' + (oud || '(leeg)'), 'Wordt: ' + nieuw], VELD_WOORD[veld] + ' wijzigen',
        veld === 'iban' ? 'Op de pagina staat een ander rekeningnummer dan in het register; naar dit nummer kan geld gaan.'
          : 'Op de pagina staat een andere ' + VELD_WOORD[veld] + ' dan in het register. Een vast gegeven van een bekende organisatie verander ik pas na jouw Ja.');
    });
  });
  return uit;
}
function slugKort(id) { return String(id).replace(/^org:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20).replace(/-+$/, '') || 'x'; }

// Bibliothecaris: open bevindingen met een voorstel in gewone taal (BB4 alleen log; kritiek BB3 heeft een eigen kaart)
function kaartBiblio(reg, o) {
  const nu = o.nu, geh = kaartGeheugen(reg, nu), wk = isoWeek(nu);
  const sleutel = 'intake-biblio-' + wk.jaar + '-' + String(wk.week).padStart(2, '0');
  if (geh.sleutels.has(sleutel)) return { reden: 'deze week al een Bibliothecariskaart' };
  if ((reg.kaarten || []).some(function (k) { return k.soort === 'biblio' && k.status === 'open'; })) return { reden: 'er staat nog een Bibliothecariskaart open' };
  const knopen = (reg.knopen || []).slice().sort(function (a, b) { return b.id.length - a.id.length; });
  function naamUit(bid) { const rest = bid.replace(/^BB\d-/, ''); const k = knopen.find(function (x) { return rest === x.id || rest.indexOf(x.id + '-') === 0; }); return k ? kort(k.naam, 50) : null; }
  const kandidaten = (reg.bevindingen || []).filter(function (b) {
    if (!/^BB[1235678]$/.test(b.check_id) || (b.check_id === 'BB3' && b.ernst === 'serious')) return false;
    if (b.check_id === 'BB3' && !/-handvatten$/.test(b.bevinding_id)) return false;   // naam/agb/intrekking: eigen kritiek-kaart; wv981: pot-cc wacht op fase 2
    return !geh.open.has('structuur_state#' + b.bevinding_id) && !geh.rust.has('structuur_state#' + b.bevinding_id + '#');
  }).slice(0, KAART_STAPPEN);
  if (!kandidaten.length) return { reden: 'geen open verschillen' };
  const stappen = kandidaten.map(function (b, i) {
    const nm = naamUit(b.bevinding_id) || 'een pagina in het register', nr = i + 1;
    const px = /pot-(P\d{2})/.exec(b.bevinding_id);
    if (px && POT_BEVINDING_RE.test(b.bevinding_id)) {   // wv981: plek 4
      if (b.check_id === 'BB2') return nr + '. POT-praktijk ' + px[1] + ' is nog aan geen pagina in het register gekoppeld. Ik zet de verwijzing op de pagina van die praktijk.';
      if (b.check_id === 'BB5') return nr + '. Twee pagina\'s noemen POT-praktijk ' + px[1] + '. Ik laat de verwijzing alleen staan op de pagina van de praktijk zelf.';
      if (b.check_id === 'BB1') return nr + '. ' + nm + ': verwijst naar een POT-praktijk (' + px[1] + ') die de POT-app niet kent. Ik haal de verwijzing weg.';
    }
    const z = { BB1: nm + ': de verwijzing naar het register op de pagina klopt niet. Ik zet hem goed.',
      BB2: /-verhuisd$/.test(b.bevinding_id) ? nm + ': de pagina is verplaatst. Ik zet het register op de nieuwe plek.' : nm + ': staat in het register maar heeft geen pagina. Ik maak een conceptpagina.',
      BB3: nm + ': pagina en register lopen uiteen. Ik werk het register bij en zoek uit waarom.',
      BB5: 'Een kenmerk staat bij twee organisaties (' + kort(String(b.samenvatting || '').replace(/^.*\(/, '').replace(/\).*$/, '').split('/').map(function (id) { const k = knopen.find(function (x) { return x.id === id; }); return k ? k.naam : id.replace(/^org:/, ''); }).join(' en '), 80) + '). Ik zoek uit bij wie het hoort en haal het bij de ander van de pagina.',
      BB6: nm + ': de pagina is niet te lezen. Ik herstel hem.',
      BB7: nm + ': is buiten de gewone weg gewijzigd. Ik zet het terug zoals de pagina zegt.',
      BB8: nm + ': in het automatische blok onderaan de pagina is met de hand iets veranderd. Ik zet dat in de pagina zelf; daarna maakt OVIS het blok opnieuw.' }[b.check_id];
    return nr + '. ' + z;
  });
  return { kaart: { sleutel: sleutel, soort: 'biblio', titel: kandidaten.length + (kandidaten.length === 1 ? ' verschil' : ' verschillen') + ' in het entiteitenregister — zo oplossen?',
    waarom: 'De Bibliothecaris vergelijkt elke nacht de pagina\'s over organisaties met het register en lost niets stil op. Ja: Socev lost ze op zoals hieronder. Nee: alles blijft zoals het is. Anders: typ welke nummers niet, bijvoorbeeld "zonder 2".',
    stappen: stappen, prive: false, regels: kandidaten.map(function (b, i) { return { nr: i + 1, actie: 'biblio', tabel: 'structuur_state', id: b.bevinding_id }; }) } };
}

// Wat Socev na de druk hoort (staart van de prompt; Fable wv1253 #1): de echte uitkomst van de databank, niet wat er zou gebeuren
function uitkomstZin(soort, keuze, r, vast) {
  if (!r) return '\n(OVIS: de pod kreeg nog geen antwoord van de databank. Zeg David alleen dat zijn keuze is ontvangen; zet zelf niets in de databank.)';
  if (r.fout_pod) return '\n(OVIS: NIET vastgelegd, de databank gaf een fout. Zeg David in één zin dat er niets is vastgezet en dat de punten op een volgende kaart terugkomen. Jij zet niets in de databank.)';
  if (r.ok === false && r.al) {
    const u = r.uitkomst || {};   // diffreview #6: een herkansing na een geslaagde eerste poging ziet zijn eigen beslissing
    if (u.actief || u.vervallen || u.gezet) return '\n(OVIS: vastgelegd (' + r.al + '): ' + [u.actief ? u.actief + ' vastgezet' : '', u.vervallen ? u.vervallen + ' vervallen' : '', u.gezet ? u.gezet + ' gewijzigd' : ''].filter(Boolean).join(', ') + '. Jij zet niets in de databank. Bevestig het David in één zin.)';
    return '\n(OVIS: deze kaart was al beslist (' + r.al + '); de pod heeft niets veranderd. Zeg dat kort.)';
  }
  if (r.ok === false) return '\n(OVIS: NIET vastgezet: ' + kort(r.fout, 120) + '. Zeg David in één zin dat er niets is vastgezet; de punten komen op een volgende kaart terug. Jij zet niets in de databank.)';
  if (r.status === 'nee') return '\n(OVIS: Nee — de pod heeft niets vastgezet' + (soort === 'bundel' ? '; deze kenmerken komen over vier weken weer op een kaart' : '') + '. Zeg dat kort.)';
  if (r.status === 'anders' && !r.eruit) return '\n(OVIS: Anders zonder nummers om eruit te halen, of op een kaart met een adres of rekeningnummer — de pod heeft niets vastgezet. ' + (soort === 'bundel' ? 'Vraag David kort wat hij bedoelt; de kenmerken komen volgende week op een nieuwe kaart, waar hij met Anders "zonder 3" kan antwoorden.' : 'Vraag David kort wat hij bedoelt.') + ' Jij kunt niets vastzetten.)';
  if (soort === 'biblio') return '\n(Bibliothecaris: David gaf ' + (r.eruit ? 'Ja behalve nummer(s) ' + r.eruit.join(', ') : 'Ja') + ' op de voorstellen. Voer ze uit in de machinekamer (bevindingen in secondbrain.structuur_state, prefix BB) en zet de rij in de box bij. Bevestig David in één zin.)';
  const over = (r.overgeslagen || []);
  const vf = over.filter(function (x) { return /vingerafdruk/.test(x.reden); }).length;
  const delen = [];
  if (r.actief) delen.push(r.actief + ' ' + (r.actief === 1 ? 'gegeven' : 'gegevens') + ' vastgezet');
  if (r.vervallen) delen.push(r.vervallen + ' laten vervallen');
  if (r.gezet) delen.push(r.gezet + ' gewijzigd');
  if (!delen.length) delen.push('niets vastgezet');
  return '\n(OVIS: de pod heeft ' + delen.join(', ') + (r.eruit ? ' (zonder nummer(s) ' + r.eruit.join(', ') + ')' : '') + '.' +
    (over.length ? ' Niet gelukt: ' + over.length + ' (' + Array.from(new Set(over.map(function (x) { return x.reden; }))).map(function (x) { return kort(x, 60); }).join('; ') + ')' +
      (vf && vast ? '; de Ja kwam van een vaste plek, daar telt een rekeningnummer of adres niet: de kaart komt terug, druk dan op je telefoon' : '') + '.' : '') +
    ' Jij zet niets in de databank. Bevestig het David in één zin.)';
}

// Alle kaarten die er nu bij moeten (pure functie): kritiek eerst (meteen), dan de weekbundel, dan de Bibliothecaris
function plan(reg, paginas, o) {
  const soorten = o.soorten || ['kritiek', 'bundel', 'biblio'], uit = { kaarten: [], redenen: {} };
  if (soorten.indexOf('kritiek') >= 0) kaartenKritiek(reg, paginas, o).forEach(function (k) { uit.kaarten.push(k); });
  if (soorten.indexOf('bundel') >= 0) { const b = kaartBundel(reg, paginas, o); if (b.kaart) uit.kaarten.push(b.kaart); else uit.redenen.bundel = b.reden; }
  if (soorten.indexOf('biblio') >= 0) { const b = kaartBiblio(reg, o); if (b.kaart) uit.kaarten.push(b.kaart); else uit.redenen.biblio = b.reden; }
  return uit;
}

// ── de module ──
// Map lezen zonder een symlink als map of bestand te zien (Dirent kijkt niet door een link).
function lijstMapVan(vault) {
  return function (rel) {
    return fs.readdirSync(path.join(vault, rel), { withFileTypes: true }).map(function (d) { return { naam: d.name, map: d.isDirectory(), bestand: d.isFile() }; });
  };
}
// wv1253: index.md in een Relaties-map is de inhoudsopgave, geen entiteitpagina
function relatiePagina(x) { return x.bestand && x.naam.endsWith('.md') && x.naam.toLowerCase() !== 'index.md'; }
function maak(o) {
  const vault = o.vault, nu = o.nu || Date.now, log = o.log || function () {};
  o.lijst = o.lijst || lijstMapVan(vault);
  function vind() {
    const uit = [];
    function lijstMap(rel) { try { return o.lijst(rel); } catch (e) { return []; } }
    lijstMap('10_Zakelijk').forEach(function (m) {
      if (!m.map || m.naam.startsWith('.')) return;
      if (m.naam === '_Gedeeld') { lijstMap('10_Zakelijk/_Gedeeld/Relaties').forEach(function (x) { if (relatiePagina(x)) uit.push('10_Zakelijk/_Gedeeld/Relaties/' + x.naam); }); return; }
      lijstMap('10_Zakelijk/' + m.naam).forEach(function (x) { if (x.bestand && /^Entiteit - .+\.md$/.test(x.naam)) uit.push('10_Zakelijk/' + m.naam + '/' + x.naam); });
    });
    lijstMap('20_Prive').forEach(function (x) { if (x.bestand && /^Entiteit - .+\.md$/.test(x.naam)) uit.push('20_Prive/' + x.naam); });
    lijstMap('20_Prive/Relaties').forEach(function (x) { if (relatiePagina(x)) uit.push('20_Prive/Relaties/' + x.naam); });
    return uit.sort().slice(0, MAX_PAGINAS);
  }
  function leesAlles() {
    return vind().map(function (rel) {
      let t;
      try { t = o.lees(path.join(vault, rel)); } catch (e) { return { pad: rel, fouten: ['niet te lezen (' + String(e && e.code || e && e.message || e).slice(0, 40) + ')'] }; }
      const p = leesPagina(rel, t); p.tekst = t; return p;
    });
  }
  async function register(logSinds) {
    const r = await o.sbRpc('ovis_register_lees', { p_log_sinds: logSinds || null });
    if (!r || !Array.isArray(r.knopen)) throw new Error('ovis_register_lees gaf geen register');
    return r;
  }
  // modus: dag | afroep | nacht. opties.droog: niets schrijven. Nacht schrijft ook het blok in de pagina's (alleen met grendel; de
  // aanroeper bewijst dat met opties.grendel === true).
  async function compileer(modus, opties) {
    opties = opties || {};
    const t0 = nu(), reg = await register(), knopen = {};
    reg.knopen.forEach(function (k) { knopen[k.id] = k; });
    const comp = reg.knopen.reduce(function (x, k) { return Math.max(x, Number(k.compilatienummer) || 0); }, 0) + 1;
    const paginas = leesAlles(), uit = { modus: modus, paginas: paginas.length, gestuurd: 0, nieuw: 0, fouten: [], voorstellen: 0, ingetrokken: 0, kritiek: 0, blokken: 0, overgeslagen: 0, handwerk: 0 };
    const perId = {};
    paginas.forEach(function (p) { if (!p.fouten.length) (perId[p.id] = perId[p.id] || []).push(p); else uit.fouten.push({ pad: p.pad, fout: p.fouten[0] }); });
    const te = [];
    Object.keys(perId).forEach(function (id) {
      const ps = perId[id], k = knopen[id];
      const a = k ? ps.find(function (p) { return p.pad === k.vault_pagina; }) : (ps.length === 1 ? ps[0] : null);
      if (!a) { uit.overgeslagen += ps.length; return; }
      if (k && k.bron_sha === a.sha) return;
      te.push(a);
    });
    for (const p of te) {
      if (opties.droog) { uit.gestuurd++; continue; }
      try {
        const r = await o.sbRpc('ovis_pagina_zet', { p: rpcInvoer(p, comp) });
        uit.gestuurd++;
        if (r && r.nieuw) uit.nieuw++;
        uit.voorstellen += (r && r.voorstellen || []).length; uit.ingetrokken += (r && r.ingetrokken || []).length; uit.kritiek += (r && r.kritiek || []).length;
      } catch (e) { uit.fouten.push({ pad: p.pad, fout: 'databank: ' + String(e && e.message || e).slice(0, 160) }); }
    }
    if (modus === 'nacht' && opties.grendel === true) {
      const reg2 = opties.droog ? reg : await register();
      const k2 = {}, h2 = {}, c2 = {};
      reg2.knopen.forEach(function (k) { k2[k.id] = k; });
      reg2.handvatten.forEach(function (h) { (h2[h.knoop] = h2[h.knoop] || []).push(h); });
      reg2.contact.forEach(function (c) { (c2[c.knoop] = c2[c.knoop] || []).push(c); });
      // wv1360: rekeningnummers uit Facturen. Niet te lezen → null: dan blijft een blok dat al nummers toont staan (niet stil weghalen).
      let rek = null;
      if (typeof o.rekeningen === 'function') {
        try { rek = o.rekeningen(); if (rek !== null && !Array.isArray(rek)) throw new Error('geen lijst'); }
        catch (e) { rek = null; uit.fouten.push({ pad: '(facturen)', fout: 'rekeningnummers niet te lezen: ' + String(e && e.message || e).slice(0, 80) }); }
      }
      const perDoel = rek ? rekeningenPerDoel(rek, reg2.knopen, reg2.handvatten) : {};
      uit.rekeningen = rek ? rek.length : null;
      for (const id of Object.keys(perId)) {
        const k = k2[id]; if (!k) continue;
        const p = perId[id].find(function (x) { return x.pad === k.vault_pagina; });
        if (!p || k.bron_sha !== p.sha) continue;
        const hb = huidigBlok(p.tekst);
        const oudeRegel = !rek && hb ? (hb.split('\n').find(function (r) { return r.indexOf(REK_KOP) === 0; }) || undefined) : undefined;
        const blok = blokTekst(k, h2[id] || [], c2[id] || [], rek ? (k.rol !== 'eigen' && k.soort !== 'entiteit' ? perDoel[id] : undefined) : oudeRegel);
        if (hb === blok) continue;
        if (blokHandwerk(p.tekst)) { uit.handwerk++; continue; }   // K2: niet overschrijven; de Bibliothecaris meldt het (BB8)
        if (opties.droog) { uit.blokken++; continue; }
        try {
          // opnieuw lezen vlak voor het schrijven: alleen als de inhoud (zonder blok) niet veranderde
          const vers = o.lees(path.join(vault, p.pad));
          const va = vingerafdruk(vers);
          if (va.sha !== p.sha) { uit.fouten.push({ pad: p.pad, fout: 'pagina veranderde tijdens de ronde; blok volgende nacht' }); continue; }
          if (blokHandwerk(vers)) { uit.handwerk++; continue; }
          o.schrijf(path.join(vault, p.pad), zetBlok(vers, blok));
          uit.blokken++;
        } catch (e) { uit.fouten.push({ pad: p.pad, fout: 'blok schrijven: ' + String(e && e.code || e && e.message || e).slice(0, 80) }); }
      }
      // wv1360: medewerkerpagina's (geen knoop; alleen dit blok). Zelfde regels: handwerk niet overschrijven, opnieuw lezen vlak voor het schrijven.
      uit.medewerkerblokken = 0;
      // alle medewerkerpagina's (vaste plek); een doel dat verhuisde wordt op bestandsnaam teruggevonden (diffreview ZOU 5)
      const mdw = {}, opNaam = {};
      if (rek) {
        let mappen = [];
        try { mappen = o.lijst('10_Zakelijk'); } catch (e) { mappen = []; }
        mappen.forEach(function (m) {
          if (!m.map || m.naam.startsWith('.')) return;
          let xs = [];
          try { xs = o.lijst('10_Zakelijk/' + m.naam + '/Medewerkers'); } catch (e) { xs = []; }
          xs.forEach(function (x) { if (x.bestand && x.naam.endsWith('.md')) { const rel = '10_Zakelijk/' + m.naam + '/Medewerkers/' + x.naam; mdw[rel] = []; (opNaam[x.naam] = opNaam[x.naam] || []).push(rel); } });
        });
        let zoek = 0;
        Object.keys(perDoel).filter(function (d) { return MDW_RE.test(d) && d.split('/').indexOf('..') < 0; }).forEach(function (d) {
          const naam = path.basename(d), echt = mdw[d] ? d : (opNaam[naam] && opNaam[naam].length === 1 ? opNaam[naam][0] : null);
          if (echt) mdw[echt] = mdw[echt].concat(perDoel[d]); else zoek++;
        });
        if (zoek) uit.fouten.push({ pad: '(medewerkerpagina\'s)', fout: zoek + ' rekening-doel(en) niet gevonden (verhuisd of weg)' });
      }
      for (const doel of Object.keys(mdw).sort()) {
        try {
          const vol = path.join(vault, doel);
          const t = o.lees(vol);
          const pl = blokPlek(t);
          const leeg = !mdw[doel].length;
          if (leeg && !(pl.id && /^mdw:/.test(pl.id))) continue;   // niets te tonen en geen blok van ons: niet aanraken
          const fm = frontmatter(t);
          if (fm.fout || !fm.velden || fm.velden.type !== 'medewerker') { if (!leeg) uit.fouten.push({ pad: doel, fout: 'geen medewerkerpagina (type)' }); continue; }
          if (pl.id && !/^mdw:/.test(pl.id)) { uit.fouten.push({ pad: doel, fout: 'er staat al een ander gegenereerd blok' }); continue; }
          const va = vingerafdruk(t);
          if (va.fout) { uit.fouten.push({ pad: doel, fout: va.fout }); continue; }
          const blok = leeg ? null : mdwBlokTekst(doel, mdw[doel]);
          if (!leeg && huidigBlok(t) === blok) continue;
          if (blokHandwerk(t)) { uit.handwerk++; continue; }
          if (opties.droog) { uit.medewerkerblokken++; continue; }
          const vers = o.lees(vol);
          if (vingerafdruk(vers).sha !== va.sha) { uit.fouten.push({ pad: doel, fout: 'pagina veranderde tijdens de ronde; blok volgende nacht' }); continue; }
          if (blokHandwerk(vers)) { uit.handwerk++; continue; }
          o.schrijf(vol, leeg ? zonderBlok(vers) : zetBlok(vers, blok));
          uit.medewerkerblokken++;
        } catch (e) { uit.fouten.push({ pad: doel, fout: 'medewerkerblok: ' + String(e && e.code || e && e.message || e).slice(0, 80) }); }
      }
    }
    uit.ms = nu() - t0;
    log('ovis-compileer ' + JSON.stringify({ modus: modus, paginas: uit.paginas, gestuurd: uit.gestuurd, nieuw: uit.nieuw, fouten: uit.fouten.length, blokken: uit.blokken, handwerk: uit.handwerk, medewerkerblokken: uit.medewerkerblokken }));
    return uit;
  }
  // Bibliothecaris: leest, vergelijkt, schrijft bevindingen (BB), stempelt (niet op afroep). opties.sinds = log sinds (ISO).
  async function bibliothecaris(opties) {
    opties = opties || {};
    const c = await compileer('afroep', { droog: !!opties.droog });   // diffreview #1: eerst bijwerken (alleen databank), fouten worden BB6
    const reg = await register(opties.sinds || new Date(nu() - 36 * 3600000).toISOString());
    const paginas = leesAlles();
    const pot = o.pot ? await potMeting(o.pot) : null;   // wv981: plek 4 (alleen lezen); o.pot = { d1(batch), dossier() }
    const r = checks(paginas, reg, c.fouten, pot);
    const open = {}; (reg.bevindingen || []).forEach(function (x) { open[x.bevinding_id] = x; });
    const nu_ = new Date(nu()).toISOString();
    const rijen = [], nieuw = [];
    r.bevindingen.forEach(function (x) {
      if (open[x.bevinding_id]) rijen.push({ bevinding_id: x.bevinding_id, laatst_gezien: nu_, samenvatting: x.samenvatting, detail: x.detail, ernst: x.ernst });
      else { rijen.push(Object.assign({ soort: 'bibliothecaris', laag: 'A', status: 'open', eerst_gezien: nu_, laatst_gezien: nu_ }, x)); nieuw.push(x); }
    });
    const gezien = new Set(r.bevindingen.map(function (x) { return x.bevinding_id; }));
    // BB7-spoor blijft open tot iemand hem afhandelt: het logvenster schuift door, de wijziging is niet weg (Fable wv979 #8)
    // wv981 (Fable #1): niet gemeten is niet opgelost — zonder POT-meting blijven de bevindingen van plek 4 open
    const opgelost = Object.keys(open).filter(function (id) { return !gezien.has(id) && !/^BB7-.*-spoor-\d{8}$/.test(id) && (r.pot.gemeten || !POT_BEVINDING_RE.test(id)); });
    opgelost.forEach(function (id) { rijen.push({ bevinding_id: id, status: 'opgelost', laatst_gezien: nu_, detail_erbij: ' | ' + nu_.slice(0, 10) + ': niet meer gezien door de Bibliothecaris' }); });
    if (!opties.droog) for (let i = 0; i < rijen.length; i += 100) await o.sbRpc('ovis_bibliothecaris_zet', { p_rijen: rijen.slice(i, i + 100) });
    const onverklaard = r.bevindingen.length;
    const zin = onverklaard ? onverklaard + ' verschil(len) tussen pagina\'s en register (' + nieuw.length + ' nieuw, ' + opgelost.length + ' opgelost)'
      : 'register en pagina\'s gelijk (' + r.tel.geldig + ' pagina\'s' + (r.tel.verouderd ? ', ' + r.tel.verouderd + ' nog niet gecompileerd' : '') + (r.tel.wacht_op_ja ? ', ' + r.tel.wacht_op_ja + (r.tel.wacht_op_ja === 1 ? ' kenmerk wacht' : ' kenmerken wachten') + ' op Davids Ja' : '') + ')';
    const potZin = r.pot.gemeten ? '; POT-factuuradressen: ' + r.tel.pot + ' praktijk(en) gemeten, ' + r.tel.pot_verschil + ' met een verschil' : '; POT-factuuradressen niet gemeten (' + schoon(r.pot.reden || '?', 80) + ')';
    const uit = { uitkomst: onverklaard ? 'bevindingen' : 'ok', zin: zin + potZin, tel: r.tel, pot: r.pot, open: onverklaard, nieuw: nieuw.length, opgelost: opgelost.length,
      per_check: r.bevindingen.reduce(function (a, x) { a[x.check_id] = (a[x.check_id] || 0) + 1; return a; }, {}), bevindingen: r.bevindingen, nieuwe: nieuw };
    if (!opties.droog && !opties.afroep) {
      await o.sbRpc('mk_hartslag_stempel', { p_component: 'bibliothecaris', p_gemeten_rijen: r.tel.paginas, p_bevindingen: onverklaard });
      uit.gestempeld = true;
    }
    log('ovis-bibliothecaris ' + JSON.stringify({ open: onverklaard, nieuw: nieuw.length, opgelost: opgelost.length, afroep: !!opties.afroep, droog: !!opties.droog }));
    return uit;
  }
  // wv1253: kaarten in Overzicht. Eerst open kaarten zonder uitkomst opruimen (de databank beslist of dat mag: weg, zonder druk gesloten
  // na 1 uur, 21 dagen open), dan zetten wat plan() geeft. opties: { soorten: ['kritiek','bundel','biblio'], vraagId(sleutel) → 8 hex, droog }.
  // Een fout bij één kaart stopt de andere niet.
  async function kaarten(opties) {
    opties = opties || {};
    const soorten = opties.soorten || ['kritiek', 'bundel', 'biblio'], uit = { gezet: [], fouten: [], weg: 0, redenen: {} };
    let reg = await register();
    const t = nu();
    for (const k of (reg.kaarten || []).filter(function (x) { return x.status === 'open' && Date.parse(x.aangemaakt) < t - 3600000; })) {
      if (opties.droog) continue;
      try {
        const r = await o.sbRpc('ovis_handvat_activeer', { p: { sleutel: k.sleutel, keuze: 'weg' } });
        if (r && r.ok) { uit.weg++; if (r.reden === 'druk niet verwerkt') (uit.verloren = uit.verloren || []).push(k.sleutel); }
      }
      catch (e) { uit.fouten.push({ sleutel: k.sleutel, fout: 'weg: ' + String(e && e.message || e).slice(0, 120) }); }
    }
    if (uit.weg) reg = await register();
    const p = plan(reg, leesAlles(), { nu: t, soorten: soorten });
    uit.redenen = p.redenen;
    for (const k of p.kaarten) {
      if (opties.droog) { uit.gezet.push(k.sleutel); continue; }
      try {
        const r = await o.sbRpc('ovis_kaart_zet', { p: Object.assign({}, k, { vraag_id: opties.vraagId(k.sleutel) }) });
        if (r && r.ok && r.nieuw) uit.gezet.push(k.sleutel);
      } catch (e) { uit.fouten.push({ sleutel: k.sleutel, fout: String(e && e.message || e).slice(0, 160) }); }
    }
    log('ovis-kaarten ' + JSON.stringify({ gezet: uit.gezet, weg: uit.weg, fouten: uit.fouten.length, droog: !!opties.droog }));
    return uit;
  }
  return { vind: vind, leesAlles: leesAlles, compileer: compileer, bibliothecaris: bibliothecaris, register: register, kaarten: kaarten };
}

// Box-rij bij nieuwe bevindingen (de aanroeper schrijft hem met vault-veilig; geen waarden van contactvelden, Fable wv979 #10)
function boxRij(b, tijd) {
  const k = function (x) { return schoon(x, 220); };
  return '\n## [bibliothecaris] ' + tijd + ' — ' + b.nieuw + ' nieuwe verschil(len) in het entiteitenregister (automatisch, wv979)\n' +
    '- status: open\n- van: pod (ovis-register.js, Bibliothecaris 02:30)\n' +
    '- gemeten: ' + b.zin + '. Nieuw: ' + b.nieuwe.slice(0, 6).map(function (x) { return x.check_id + ' ' + k(x.samenvatting); }).join('; ') + (b.nieuwe.length > 6 ? '; …' : '') + '\n' +
    '- gevolg als er niets gebeurt: de router (stap 2) herkent op een register dat niet gelijk is aan de pagina\'s; kritieke verschillen (rekening, contact) blijven staan.\n' +
    '- voorstel: per bevinding in secondbrain.structuur_state (BB…); de voorstelkaart voor David komt met vervolgrij A. Kritiek (ernst serious) dezelfde dag nalopen.\n';
}

function boxRijFout(fout, tijd) {
  return '\n## [bibliothecaris] ' + tijd + ' — Bibliothecaris niet gelukt (automatisch, wv979)\n- status: open\n- van: pod (ovis-register.js, 02:30)\n' +
    '- gemeten: ' + schoon(fout, 200) + '\n- gevolg als er niets gebeurt: geen stempel; de Stiltewachter meldt na 26 u. Herkansing elke 5 min tot 06:00.\n' +
    '- voorstel: `node /opt/data/app/current/ovis-run.js bibliothecaris --droog` in de machinekamer en de fout nalopen.\n';
}

module.exports = { maak: maak, boxRijFout: boxRijFout, leesPagina: leesPagina, frontmatter: frontmatter, vingerafdruk: vingerafdruk, checks: checks, blokTekst: blokTekst,
  blokHandwerk: blokHandwerk, blokHash: blokHash, blokPlek: blokPlek,
  rekeningRegel: rekeningRegel, rekeningenPerDoel: rekeningenPerDoel, mdwBlokTekst: mdwBlokTekst, REK_KOP: REK_KOP,
  zetBlok: zetBlok, huidigBlok: huidigBlok, rpcInvoer: rpcInvoer, handvattenVan: handvattenVan, normHandvat: normHandvat, boxRij: boxRij, slug: slug,
  BLOK_BEGIN: BLOK_BEGIN, BLOK_EIND: BLOK_EIND, SCHRIJVERS_OK: SCHRIJVERS_OK,
  potMeting: potMeting, potChecks: potChecks, kaartPot: kaartPot, POT_SQL: POT_SQL, POT_BEVINDING_RE: POT_BEVINDING_RE,
  plan: plan, kaartBundel: kaartBundel, kaartenKritiek: kaartenKritiek, kaartBiblio: kaartBiblio, eruitUit: eruitUit, uitkomstZin: uitkomstZin, isoWeek: isoWeek,
  KAART_SLEUTEL_RE: /^intake-(handvat|kritiek|biblio)-[a-z0-9]+(-[a-z0-9]+)*$/ };
