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
// wv1011 (OVIS plek 7, koppelregel personen; ontwerp + Fable vooraf mk-scripts/wv1011/ontwerp.md). Een zakelijke persoonspagina (de bestaande
// pagina, geen aparte stampagina) is de bron van knoop per:<slug>; alles wat OVIS van de persoon bijhoudt staat in één ovis:-blok in de
// frontmatter, met een zegel. Nachtskills bewerken de rest van de pagina; wie het blok buiten Socev om verandert breekt het zegel: dan
// stuurt de compiler niets (niets vervalt) en meldt de Bibliothecaris het (BB6). Privépersonen worden nooit een knoop.
const PER_TYPES = ['persoon', 'praktijkhouder', 'medewerker'];
const PER_ID_RE = /^per:[a-z0-9]+(-[a-z0-9]+)*$/;
const PER_SLEUTEL_RE = /^supabase:secondbrain\/knoop#(per:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const GOOGLE_SLEUTEL_RE = /^supabase:secondbrain\/contacten#(people\/c[0-9]{1,30})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PER_OVIS_VELDEN = ['db', 'status', 'zegel', 'mailadressen', 'telefoons', 'whatsapp', 'signal', 'niet_dezelfde_als', 'zaad'];
const PER_PLEK_RE = /^10_Zakelijk\/(?!_Gedeeld\/Relaties\/)(?:[^/]+\/){1,3}[^/]+\.md$/;
const PER_MAP_UIT = ['raw_input', 'Bronnen', 'Archief', 'Conversaties', 'Notulen', 'Relaties', 'Skills', 'Skills-broncode'];
const PER_BEVINDING_RE = /^BB\d-(?:.*-)?per:[a-z0-9]/;
// soorten die de databank vóór wv1011 kende; register zonder handvat_soorten (oude migratie) = deze lijst
const HANDVAT_SOORTEN_OUD = ['kvk', 'domein', 'mail', 'kenmerkpatroon', 'alias', 'niet-dezelfde-als'];
const HARDE_SOORTEN = ['kvk', 'domein', 'mail', 'telefoon', 'whatsapp', 'signal', 'google'];

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

// ── wv1011: persoonspagina (plek 7) ──
// "+31 (0)6-1234 5678" → "0612345678"; buitenland "+220 …" → "00220…" (zelfde regel als secondbrain.ovis_norm)
function normTel(w) {
  let s = String(w == null ? '' : w).split('(0)').join('').replace(/[^0-9+]/g, '');
  if (s.charAt(0) === '+') s = '00' + s.slice(1);
  if (s.indexOf('0031') === 0) s = '0' + s.slice(4);
  return s;
}
// Het zegel over het ovis-blok en het object_id (Fable wv1011 MOET 2): HMAC-SHA256 met een sleutel die alleen claude (pod, machinekamer)
// kan lezen (diffreview ZOU 2: een gewone hash kan elke skill namaken). Zonder sleutel geen zegel en geen controle (zie leesPersonen).
const ZEGEL_SLEUTEL_PAD = '/opt/data/ovis/zegel.sleutel';
function zegelSleutelLees(pad) {
  const t = fs.readFileSync(pad || ZEGEL_SLEUTEL_PAD, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error('zegelsleutel heeft niet de vorm van 64 hex');
  return t;
}
function persoonZegel(p, sleutel) {
  if (!sleutel) throw new Error('geen zegelsleutel');
  return crypto.createHmac('sha256', String(sleutel)).update(JSON.stringify(['ovis-per-1', p.object_id, p.db, p.status, p.mailadressen, p.telefoons, p.whatsapp,
    p.signal, p.niet_dezelfde_als, p.zaad]), 'utf8').digest('hex').slice(0, 16);
}
// Naam: het veld naam, anders de bestandsnaam vóór " - " ("Pim Voorbeeld - assistent.md" → "Pim Voorbeeld")
function persoonNaam(rel, v) {
  if (typeof v.naam === 'string' && v.naam.trim()) return v.naam.trim();
  return path.basename(String(rel), '.md').split(' - ')[0].trim();
}
// Vingerafdruk van een persoon: alleen wat OVIS stuurt (naam, object_id, entiteit_id, ovis-blok), niet de dossiertekst die de nachtskills
// bijwerken (Fable wv1011 MOET 2c: anders bij elke tekstwijziging hercompileren).
function persoonSha(p) {
  return crypto.createHash('sha256').update(JSON.stringify(['ovis-per-1', p.naam, p.object_id, p.entiteit, p.db, p.status, p.zegel, p.mailadressen,
    p.telefoons, p.whatsapp, p.signal, p.niet_dezelfde_als, p.zaad]), 'utf8').digest('hex');
}
// Leest een persoonspagina. Zonder ovis-blok met een per:-sleutel → null (geen OVIS-persoon; niets te melden).
function leesPersoon(rel, tekst, sleutel) {
  if (Buffer.byteLength(String(tekst)) > MAX_BYTES) return { pad: rel, persoon: true, fouten: ['pagina groter dan 256 kB'] };
  const fm = frontmatter(tekst);
  if (fm.fout) return /\novis:/.test(String(tekst).slice(0, 8000)) && /knoop#per:/.test(String(tekst).slice(0, 8000)) ? { pad: rel, persoon: true, fouten: [fm.fout] } : null;
  const v = fm.velden, ov = v.ovis && typeof v.ovis === 'object' && !Array.isArray(v.ovis) ? v.ovis : null;
  if (!ov) return null;
  const db = lijst(ov.db), ids = db.map(function (s) { const m = PER_SLEUTEL_RE.exec(s); return m ? m[1] : null; }).filter(Boolean);
  if (!ids.length && !db.some(function (s) { return /knoop#per:/.test(s); })) return null;
  const uit = { pad: rel, persoon: true, soort: 'persoon', fouten: [], db: db, id: ids.length === 1 ? ids[0] : (ids[0] || '') };
  const f = uit.fouten;
  uit.type = typeof v.type === 'string' ? v.type : '';
  uit.naam = persoonNaam(rel, v);
  uit.object_id = typeof v.object_id === 'string' ? v.object_id.trim().toLowerCase() : '';
  uit.entiteit = typeof v.entiteit_id === 'string' ? v.entiteit_id.trim() : '';
  uit.status = ov.status === 'concept' ? 'concept' : ov.status === 'vast' ? 'vast' : '';
  uit.zegel = typeof ov.zegel === 'string' ? ov.zegel : '';
  uit.mailadressen = lijst(ov.mailadressen).map(function (x) { return x.trim().toLowerCase(); });
  uit.telefoons = lijst(ov.telefoons).map(function (x) { return x.trim(); });
  uit.whatsapp = lijst(ov.whatsapp).map(function (x) { return x.trim().toLowerCase(); });
  uit.signal = lijst(ov.signal).map(function (x) { return x.trim(); });
  uit.niet_dezelfde_als = lijst(ov.niet_dezelfde_als).map(function (x) { return x.trim(); });
  uit.zaad = lijst(ov.zaad).filter(function (x) { return x.length <= 200; });
  uit.google = db.map(function (s) { const m = GOOGLE_SLEUTEL_RE.exec(s); return m ? m[1] : null; }).filter(Boolean);
  // velden die de rest van de module verwacht (een persoon heeft ze niet)
  uit.aliassen = []; uit.domeinen = []; uit.kenmerkpatronen = []; uit.contact = []; uit.kvk = ''; uit.agb = ''; uit.iban = ''; uit.betaalwijze = '';
  uit.voor = /^[A-Z][A-Z0-9_]{1,15}$/.test(uit.entiteit) ? [uit.entiteit] : [];
  uit.sha = persoonSha(uit);
  // validatie
  if (PER_TYPES.indexOf(uit.type) < 0) f.push('type is geen persoon, praktijkhouder of medewerker');
  if (!PER_PLEK_RE.test(rel) || rel.split('/').some(function (d) { return PER_MAP_UIT.indexOf(d) >= 0; })) f.push('persoonsknoop alleen voor een zakelijke persoonspagina onder 10_Zakelijk (geen privépersonen)');
  if (ids.length !== 1) f.push('ovis.db moet precies één sleutel supabase:secondbrain/knoop#per:<slug> noemen');
  else if (!PER_ID_RE.test(uit.id) || uit.id.length > 64) f.push('id van een persoon moet per:<slug> zijn');
  db.forEach(function (s) { if (!PER_SLEUTEL_RE.test(s) && !GOOGLE_SLEUTEL_RE.test(s)) f.push('onbekende sleutel in ovis.db'); });
  if (uit.google.length > 1) f.push('meer dan één Google-contact in ovis.db');
  Object.keys(ov).forEach(function (k) { if (PER_OVIS_VELDEN.indexOf(k) < 0) f.push('onbekend veld in het ovis-blok: ' + k); });
  if (v.contact !== undefined && v.contact !== '' && !(typeof v.contact === 'object' && !Array.isArray(v.contact) && !Object.keys(v.contact).length))
    f.push('contactgegevens van een persoon staan in Google, niet op de pagina');
  if (!UUID_RE.test(uit.object_id)) f.push('object_id ontbreekt of is geen uuid');
  if (!uit.status) f.push('ovis.status moet vast of concept zijn');
  if (!uit.naam || uit.naam.length > 200) f.push('naam leeg of te lang');
  uit.mailadressen.forEach(function (a) { if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(a)) f.push('mailadres ongeldig'); });
  uit.telefoons.forEach(function (t) { const n = normTel(t); if (!/^0[0-9]{9,15}$/.test(n)) f.push('telefoonnummer ongeldig'); });
  uit.whatsapp.forEach(function (w) { if (!/^[0-9]{8,20}@(c\.us|lid|s\.whatsapp\.net)$/.test(w)) f.push('WhatsApp-id ongeldig'); });
  uit.signal.forEach(function (s) { const x = s.replace(/\s+/g, '').toLowerCase(); if (!/^(\+?[0-9]{8,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(x)) f.push('Signal-id ongeldig'); });
  uit.niet_dezelfde_als.forEach(function (x) { if (x === uit.id) f.push('niet_dezelfde_als naar zichzelf'); else if (!/^(per|org):[a-z0-9]+(-[a-z0-9]+)*$/.test(x) && !/^[A-Z][A-Z0-9_]{1,15}$/.test(x)) f.push('niet_dezelfde_als noemt geen knoop'); });
  // het zegel als laatste: een ander gebrek gaat voor (dat is wat Socev eerst moet herstellen)
  if (!f.length && (!sleutel || uit.zegel !== persoonZegel(uit, sleutel))) { uit.zegelFout = true; f.push('ovis-blok buiten Socev om gewijzigd (zegel klopt niet)'); }
  return uit;
}

// Zet (of vervangt) `zegel:` in het ovis-blok van een persoonspagina → { tekst, zegel } of { fout }. Alleen voor de machinekamer en Socev
// (ovis-run.js zegel), na een bewuste wijziging; nooit vanuit een nachtskill. Andere gebreken eerst herstellen.
function persoonMetZegel(rel, tekst, sleutel) {
  const t = String(tekst), crlf = /\r\n/.test(t), n = t.replace(/\r\n?/g, '\n');
  if (!sleutel) return { fout: 'geen zegelsleutel (alleen de machinekamer zegelt)' };
  const p = leesPersoon(rel, n, sleutel);
  if (!p) return { fout: 'geen OVIS-persoonspagina (geen ovis-blok met een per:-sleutel)' };
  const andere = p.fouten.filter(function (x) { return !/zegel/.test(x); });
  if (andere.length) return { fout: andere.join('; ') };
  const z = persoonZegel(p, sleutel), r = n.split('\n');
  let eind = -1; for (let i = 1; i < r.length; i++) if (r[i] === '---') { eind = i; break; }
  let o = -1; for (let i = 1; i < eind; i++) if (/^ovis:\s*$/.test(r[i])) { o = i; break; }
  if (o < 0) return { fout: 'ovis-blok niet als blok geschreven (ovis: op een eigen regel)' };
  let j = o + 1, gezet = false;
  for (; j < eind && (/^\s+\S/.test(r[j]) || r[j].trim() === ''); j++) if (/^\s+zegel:/.test(r[j])) { r[j] = '  zegel: "' + z + '"'; gezet = true; }
  if (!gezet) r.splice(o + 1, 0, '  zegel: "' + z + '"');
  const uit = r.join('\n'), q = leesPersoon(rel, uit, sleutel);
  if (!q || q.fouten.length) return { fout: 'na het zegelen niet geldig: ' + (q ? q.fouten.join('; ') : 'geen persoon') };
  return { tekst: crlf ? uit.replace(/\n/g, '\r\n') : uit, zegel: z };
}

function handvattenVan(p) {
  const h = [];
  if (p.kvk) h.push({ soort: 'kvk', waarde: p.kvk });
  p.aliassen.forEach(function (w) { h.push({ soort: 'alias', waarde: w }); });
  p.domeinen.forEach(function (w) { h.push({ soort: 'domein', waarde: w }); });
  p.mailadressen.forEach(function (w) { h.push({ soort: 'mail', waarde: w }); });
  p.kenmerkpatronen.forEach(function (w) { h.push({ soort: 'kenmerkpatroon', waarde: w }); });
  (p.telefoons || []).forEach(function (w) { h.push({ soort: 'telefoon', waarde: w }); });   // wv1011: alleen personen
  (p.whatsapp || []).forEach(function (w) { h.push({ soort: 'whatsapp', waarde: w }); });
  (p.signal || []).forEach(function (w) { h.push({ soort: 'signal', waarde: w }); });
  (p.google || []).forEach(function (w) { h.push({ soort: 'google', waarde: w }); });
  p.niet_dezelfde_als.forEach(function (w) { h.push({ soort: 'niet-dezelfde-als', waarde: w }); });
  return h;
}
// wv1011: welke soorten de databank aanneemt (register.handvat_soorten); de rest wacht (fase B) en telt niet als verschil
function soortenVan(reg) { return reg && Array.isArray(reg.handvat_soorten) ? reg.handvat_soorten : HANDVAT_SOORTEN_OUD; }
function handvattenGestuurd(p, soorten) { return handvattenVan(p).filter(function (h) { return soorten.indexOf(h.soort) >= 0; }); }
function normHandvat(soort, w) {   // zelfde regels als secondbrain.ovis_norm
  w = String(w);
  if (soort === 'kvk') return w.replace(/[^0-9]/g, '');
  if (soort === 'domein') return normDomein(w);
  if (soort === 'mail') return w.trim().toLowerCase();
  if (soort === 'kenmerkpatroon' || soort === 'niet-dezelfde-als') return w.trim();
  if (soort === 'telefoon') return normTel(w);
  if (soort === 'whatsapp') return w.trim().toLowerCase();
  if (soort === 'signal') return w.trim().replace(/\s+/g, '').toLowerCase();
  if (soort === 'google') return w.trim();
  return w.trim().replace(/\s+/g, ' ').toLowerCase();
}
// opties (wv1011): { soorten, eigen: Set van eigen entiteitcodes } — zonder opties zoals vóór wv1011
function rpcInvoer(p, compilatie, opties) {
  const soorten = opties && opties.soorten ? opties.soorten : null;
  if (p.persoon) {
    const eigen = opties && opties.eigen ? opties.eigen : null;
    return { id: p.id, soort: 'persoon', rol: null, naam: p.naam, concept: p.status === 'concept', vault_pagina: p.pad, bron_sha: p.sha,
      compilatie: compilatie, agb: null, iban: null, betaalwijze: null, contact: [], object_id: p.object_id,
      access_context: p.type === 'medewerker' ? 'zakelijk_personeel' : 'zakelijk_intern',
      voor: p.voor.filter(function (x) { return !eigen || eigen.has(x); }), handvatten: handvattenGestuurd(p, soorten || HANDVAT_SOORTEN_OUD) };
  }
  return { id: p.id, soort: p.soort === 'eigen' ? 'entiteit' : 'organisatie', rol: p.soort, naam: p.naam, concept: p.status === 'concept',
    vault_pagina: p.pad, bron_sha: p.sha, compilatie: compilatie, agb: p.agb || null, iban: p.soort === 'eigen' ? (p.iban || null) : null,
    voor: p.voor, betaalwijze: p.betaalwijze || null, handvatten: soorten ? handvattenGestuurd(p, soorten) : handvattenVan(p), contact: p.contact };
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
function checks(paginas, reg, compileerFouten, pot, bank, personen) {
  const b = [], tel = { paginas: paginas.length, geldig: 0, verouderd: 0, niet_getoetst: 0, wacht_op_ja: 0 };
  const soorten = soortenVan(reg);   // wv1011: alleen soorten die de databank kent tellen in de vergelijking
  const knopen = {}; (reg.knopen || []).forEach(function (k) { knopen[k.id] = k; });
  const hv = {}; (reg.handvatten || []).forEach(function (h) { (hv[h.knoop] = hv[h.knoop] || []).push(h); });
  const ct = {}; (reg.contact || []).forEach(function (c) { (ct[c.knoop] = ct[c.knoop] || []).push(c); });
  const vert = {}; (reg.vertaling || []).forEach(function (v) { vert[v.bron + '=' + v.waarde] = v.knoop_ids || []; });
  function bev(check, sleutel, samenvatting, detail, ernst) {
    b.push({ bevinding_id: check + '-' + sleutel, check_id: check, samenvatting: schoon(samenvatting, 200), detail: schoon(detail, 600), ernst: ernst || 'warning' });
  }
  const perId = {}, perFout = new Set();
  paginas.forEach(function (p) {
    if (p.fouten.length) {
      const sid = (p.id && /^[A-Za-z0-9:_-]+$/.test(p.id) ? p.id : (p.persoon ? 'per:onbekend-' + kortHash(p.pad) : 'pagina'));
      if (p.persoon) {   // wv1011: plek 7
        if (p.id) perFout.add(p.id);
        if (p.zegelFout) bev('BB6', sid + '-zegel', 'ovis-blok van ' + sid + ' is buiten Socev om gewijzigd', p.pad + ': het zegel van het ovis-blok klopt niet meer; de compiler stuurt niets van deze persoon (er vervalt ook niets). Voorstel: Socev kijkt wat er veranderde, zet het blok terug of bevestigt het (ovis-run.js zegel).');
        else bev('BB6', sid + '-' + kortHash(p.pad), 'persoonspagina niet te lezen: ' + p.fouten[0], p.pad + ': ' + p.fouten.join('; ') + '. Voorstel: het ovis-blok herstellen (Socev) of van de pagina halen.');
        return;
      }
      bev('BB6', sid + '-' + kortHash(p.pad), 'entiteitpagina niet te lezen: ' + p.fouten[0], p.pad + ': ' + p.fouten.join('; ') + '. Voorstel: pagina herstellen (Socev) of uit de plek voor entiteiten halen.'); return;
    }
    (perId[p.id] = perId[p.id] || []).push(p);
  });
  // wv1011: één identiteit — twee persoonspagina's met hetzelfde object_id
  const perObj = {};
  paginas.forEach(function (p) { if (p.persoon && !p.fouten.length && p.object_id) (perObj[p.object_id] = perObj[p.object_id] || []).push(p); });
  Object.keys(perObj).forEach(function (o) {
    const ps = perObj[o]; if (ps.length < 2) return;
    const ids = Array.from(new Set(ps.map(function (p) { return p.id; }))).sort();
    bev('BB5', ids.join('-') + '-object', 'twee persoonspagina\'s met hetzelfde object_id (' + ids.join(', ') + ')', ps.map(function (p) { return p.pad; }).join(', ') + ' dragen hetzelfde object_id. Voorstel: Davids Ja op samenvoegen, of één pagina een eigen object_id (nooit vanzelf samenvoegen).');
  });
  const ent = {}; (personen && Array.isArray(personen.entity) ? personen.entity : []).forEach(function (e) { if (e && e.k) ent[e.k] = e; });
  const gc = {}; (personen && Array.isArray(personen.contacten) ? personen.contacten : []).forEach(function (c) { if (c && c.r) gc[c.r] = c; });
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
      m = GOOGLE_SLEUTEL_RE.exec(s);   // wv1011: plek 7, alleen als de personen gemeten zijn
      if (m && p.persoon && personen && Array.isArray(personen.contacten)) { if (!gc[m[1]]) bev('BB1', id + '-google', 'Google-contact op de pagina van ' + id + ' bestaat niet (meer)', p.pad + ': ovis.db noemt een Google-contact dat niet in de kopie van de contacten staat. Voorstel: de koppeling weghalen of het juiste contact zoeken (Google blijft de bron).'); return; }
      tel.niet_getoetst++;
    });
    // wv1011: de persoon-entity hoort bij dit object_id (één identiteit; de trigger nam hem over of maakte hem met dit object_id)
    if (p.persoon && personen && Array.isArray(personen.entity)) {
      const e = ent[id];
      if (!e || e.o !== p.object_id) bev('BB1', id + '-object', 'identiteit van ' + id + ' klopt niet met de pagina', p.pad + ': ' + (e ? 'de entity van deze knoop heeft een ander object_id' : 'geen entity bij deze knoop') + '. Voorstel: de machinekamer zoekt uit welke identiteit klopt; nooit vanzelf samenvoegen.');
    }
    if (k.bron_sha !== p.sha) return;   // verouderd: de vergelijking hieronder pas na de volgende compilatie
    // BB3 voorstellen volgens de veldkaart
    if (k.naam !== p.naam) bev('BB3', id + '-naam', 'naam van ' + id + ' verschilt tussen pagina en register', 'pagina: "' + p.naam + '", register: "' + k.naam + '". Voorstel: pagina wint na Davids Ja (naamwijziging van een bestaande entiteit).');
    if (p.soort === 'eigen' && p.iban && p.iban !== (k.iban || '')) bev('BB3', id + '-iban', 'rekeningnummer van ' + id + ' verschilt tussen pagina en register (kritiek)', 'veld iban op ' + p.pad + ' ≠ register. Voorstel: Davids Ja met verse vingerafdruk, of de pagina terugzetten.', 'serious');
    if ((p.agb || '') !== (k.agb || '')) bev('BB3', id + '-agb', 'AGB van ' + id + ' verschilt tussen pagina en register', 'pagina: ' + (p.agb || 'leeg') + ', register: ' + (k.agb || 'leeg') + '. Voorstel: pagina wint na Davids Ja.');
    const dbh = (hv[id] || []).filter(function (h) { return h.status !== 'vervallen'; });
    const pag = handvattenGestuurd(p, soorten).map(function (h) { return h.soort + '|' + normHandvat(h.soort, h.waarde); });
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
    // wv1011 (fase B): Google is de bron voor contactgegevens. Alleen bij een actieve koppeling: een telefoonnummer op de pagina dat niet
    // (meer) in het Google-contact staat. Andersom (Google heeft een nummer dat niet op de pagina staat) is geen bevinding: dat zou elke
    // nacht terugkomen als David een nummer bewust niet als kenmerk wil (Fable wv1011 #5).
    if (p.persoon) {
      tel.personen = (tel.personen || 0) + 1;
      const gk = dbh.find(function (h) { return h.soort === 'google' && h.status === 'actief'; });
      if (gk && personen && Array.isArray(personen.contacten)) {
        const c = gc[gk.waarde_norm];
        if (!c) bev('BB1', id + '-google-weg', 'het Google-contact van ' + id + ' bestaat niet meer', 'de vaste koppeling wijst naar een contact dat niet meer in de kopie staat. Voorstel: koppeling laten vervallen (Davids Ja) of het nieuwe contact koppelen.');
        else {
          const gt = (c.tel || []).map(normTel), los = p.telefoons.map(normTel).filter(function (t) { return gt.indexOf(t) < 0; });
          if (los.length) bev('BB3', id + '-google-tel', los.length + ' telefoonnummer(s) van ' + id + ' staan niet (meer) in Google', 'Google is de bron voor contactgegevens. Voorstel: het nummer van de pagina halen (intrekken telt pas na Davids Ja), of David zet het in Google.');
        }
      }
    }
  });
  // BB2 rij zonder pagina
  Object.keys(knopen).forEach(function (id) {
    const k = knopen[id];
    if (k.actief === false) return;
    if (anker[id]) return;
    if (k.soort === 'persoon' && (perFout.has(id) || (personen && personen.nietGelezen))) return;   // wv1011: pagina onleesbaar/ontzegeld (BB6) of niet gemeten
    const elders = (perId[id] || []).map(function (p) { return p.pad; });
    if (k.soort === 'persoon' && elders.length !== 1) {   // wv1011 (diffreview MOET 1): nooit "ik maak een conceptpagina" voor een persoon
      if (personen && personen.paden && personen.paden.has(k.vault_pagina)) bev('BB2', id + '-blok-weg', 'het ovis-blok op de pagina van ' + id + ' is weg of onleesbaar', k.vault_pagina + ' bestaat nog, maar zonder geldig ovis-blok met knoop#' + id + '. Voorstel: de machinekamer zet het blok terug (met zegel); nooit een tweede persoonspagina maken.');
      else bev('BB2', id + '-geen-pagina', 'register kent persoon ' + id + ' maar de pagina is weg', (k.vault_pagina || '(geen vault_pagina)') + ' bestaat niet meer. Voorstel: de machinekamer zoekt waar de pagina heen is en zet de verankering om; nooit een nieuwe persoonspagina (tweede identiteit).');
      return;
    }
    if (elders.length === 1) bev('BB2', id + '-verhuisd', 'pagina van ' + id + ' is verhuisd', 'register: ' + (k.vault_pagina || '(geen)') + ', pagina nu op ' + elders[0] + '. Voorstel: de machinekamer zet de verankering om (of de pagina terug).');
    else bev('BB2', id + '-geen-pagina', 'register kent ' + id + ' maar er is geen geldige pagina', (k.vault_pagina || '(geen vault_pagina)') + (elders.length ? '; wel pagina op ' + elders.join(', ') : '') + '. Voorstel: pagina aanmaken (concept) of de rij inactief zetten.');
  });
  // BB5 hetzelfde harde kenmerk bij twee knopen (Fable wv979 #5: niet bij een paar dat elkaar als niet-dezelfde-als noemt)
  const nda = {};
  (reg.handvatten || []).forEach(function (h) { if (h.soort === 'niet-dezelfde-als' && h.status !== 'vervallen') nda[h.knoop + '>' + h.waarde_norm] = true; });
  const harde = {};
  (reg.handvatten || []).forEach(function (h) {
    if (HARDE_SOORTEN.indexOf(h.soort) < 0 || h.status === 'vervallen') return;   // wv1011: ook telefoon, WhatsApp, Signal, Google-contact
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
    if (/^databank: /.test(cf.fout) && cf.persoon) { bev('BB6', cf.persoon + '-compileer', 'persoonspagina niet gecompileerd: ' + String(cf.fout).slice(10, 120), cf.pad + ': ' + cf.fout + '. Voorstel: de machinekamer kijkt waarom de databank weigert (object_id, pad).'); return; }   // wv1011 (diffreview ZOU 3)
    if (/^databank: /.test(cf.fout)) bev('BB6', 'compileer-' + kortHash(cf.pad), 'pagina niet gecompileerd: ' + String(cf.fout).slice(10, 120), cf.pad + ': ' + cf.fout + '. Voorstel: pagina herstellen (Socev) of de machinekamer laat de databankfunctie nalopen.');
  });
  const pc = potChecks(anker, pot, bev, tel);   // wv981
  let bc;   // wv1010; diffreview ZOU 2: een onverwachte vorm breekt de andere plekken niet
  try { bc = bankChecks(bank, reg, bev, tel); }
  catch (e) { for (let i = b.length - 1; i >= 0; i--) if (BANK_BEVINDING_RE.test(b[i].bevinding_id)) b.splice(i, 1); tel.bank = 'niet gemeten'; bc = { gemeten: false, reden: 'vergelijking faalde: ' + String(e && e.message || e).replace(/[A-Z]{2}\d{2}[A-Z0-9]{8,}/g, '…').slice(0, 80), paden: {} }; }
  const uniek = {}; b.forEach(function (x) { uniek[x.bevinding_id] = x; });
  tel.personen = tel.personen || 0;
  tel.per_verschil = Object.keys(uniek).filter(function (k) { return PER_BEVINDING_RE.test(k); }).length;   // wv1011: groen = 0
  if (bc.gemeten) tel.bank_verschil = Object.keys(uniek).filter(function (k) { return BANK_BEVINDING_RE.test(k); }).length;   // na het ontdubbelen (KAN 9)
  return { bevindingen: Object.keys(uniek).sort().map(function (k) { return uniek[k]; }), tel: tel, pot: pc, bank: bc, perFout: Array.from(perFout) };
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

// ── wv1009: koppelregel plek 5 (Voor jou ⇄ Open vragen aan David; architectuur § 4 rij 5; ontwerp mk-scripts/wv1009/ontwerp.md) ──
// Machinestaat: machinekamer.voor_jou is de projectie (wat David in de app ziet), het register 00_Systeem/Open vragen aan David.md het spoor van
// elke vraag. Koppeling per registerrij: de Kanaal-cel noemt "Voor jou-kaart [soort] <sleutel>" (de vorm die agents al schrijven) en/of de
// kaart noemt de rij in herkomst.register ("JJJJ-MM-DD UU:MM#kenmerk", zelfde regel als voor-jou.py register_match). Een rij die wvN noemt,
// hangt ook aan de opvolger wvN-2, -3 … en een samengevoegde kaart volgt samengevoegd_in. De status heeft geen enkele bron (knop/tik op de
// kaart → databank; getypt antwoord → register): elk verschil is een bevinding. Registerplicht voor een open kaart: auto-kaart van de
// werkvoorraad (slotregel), besluit met een wv/register-bron, en de Intake-bundelkaarten (herkomst.ovis.kaart; aanvulling wv1049/wv1253).
// Verzamel- en modulekaarten (facturen-, bank-, pot-, aix-, scansnap-, herinnering- …) hebben geen plicht; noemt een rij ze toch, dan geldt
// de statusregel wel. Alleen lezen; vjSchrijf (alleen voor `ovis-run.js voorjou --schrijf`, de Voor jou-ronde) zet wat zeker is in het
// register en raakt nooit een kaart (kaart_sha van Intake-kaarten, wv1253). Diffreview (Opus, 27-10) verwerkt: vervangingskaart en
// "rij noemt de tik al" zoals voor-jou.py (wv768/wv714), Gedaan op een kaart met werkvoorraadrij pas als die rij klaar is, alleen een
// meting als bewijs van de ronde, losse vermelding van een sleutel = twijfel (geen nieuwe rij), twee open rijen bij één kaart = niets schrijven.
const VJ_RUST_MS = 6 * 3600000, VJ_RIJ_RUST_MS = 48 * 3600000, VJ_ONDERWEG_MS = 3 * 86400000;
const VJ_BEVINDING_RE = /^BB\d-vj-/;
// "Voor jou-kaart doen wv12", "Voor jou wv12", "Voor jou-kaart doen, wv12", "Voor jou-kaart, #wv12" (sleutel met een cijfer: geen gewone woorden).
// voor-jou.py verzamel gebruikt dezelfde vorm (VJ_KAART) om zulke rijen niet als ongekoppeld te tonen; wijzig beide samen.
const VJ_KAART_RE = /voor jou(?:-kaart)?(?:[\s,:]+(?:besluit|doen|proef))?[\s,:]+#?((?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gi;
const VJ_SLEUTELWOORD_RE = /\bsleutel\s+(intake-[a-z0-9]+(?:-[a-z0-9]+)*)/gi;
const VJ_WOORD_RE = /(?<![\w-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w-])/gi;
const VJ_AUTO_BEWIJS = 'Socev wacht hier niet meer op jou';
// alleen een meting van de ronde of een agent (meet-recept of "<d-m uu:mm>: …") sluit een rij; de sync-zin en module-zinnen niet
const VJ_MEETBEWIJS_RE = /^(?:(?:Gemeten )?\d{1,2}-\d{1,2} \d{1,2}:\d{2}: |audit\.jsonl: \d+ x |app-log [a-z-]+: \d+ bericht)/;
function vjCellen(regel) { return regel.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(function (x) { return x.replace(/\\\|/g, '|').trim(); }); }
// Registerrijen zoals voor-jou.py register_rijen en server.js appVjRegister (\| in een wikilink is geen kolomgrens); i = regelnummer
function vjRegister(tekst) {
  const uit = [];
  String(tekst).replace(/\r\n/g, '\n').split('\n').forEach(function (r, i) {
    if (r.indexOf('| 20') !== 0) return;
    const k = vjCellen(r);
    if (k.length < 6) return;
    uit.push({ i: i, gesteld: k[0], kanaal: k[1], vraag: k[2], status: k[4].replace(/\*/g, ''), cellen: k.length });
  });
  return uit;
}
function vjRijOpen(r) { return /^(open|deels|wacht|uitgesteld)/i.test(String(r.status).trim()); }
function vjRijWacht(r) { return /^(open|deels)/i.test(String(r.status).trim()); }   // wacht/uitgesteld = bewust geparkeerd: geen kaart nodig
function vjRegMatch(rijen, sl) {
  const i = String(sl).indexOf('#'), g = i < 0 ? String(sl) : String(sl).slice(0, i), k = i < 0 ? '' : String(sl).slice(i + 1).toLowerCase();
  return rijen.filter(function (r) { return r.gesteld === g && (!k || (r.kanaal + ' ' + r.vraag).toLowerCase().indexOf(k) >= 0); });
}
function vjGenoemd(r) {   // kaartsleutels die de Kanaal-cel als kaart noemt
  const s = new Set(); let m;
  VJ_KAART_RE.lastIndex = 0; while ((m = VJ_KAART_RE.exec(r.kanaal))) s.add(m[1].toLowerCase());
  VJ_SLEUTELWOORD_RE.lastIndex = 0; while ((m = VJ_SLEUTELWOORD_RE.exec(r.kanaal))) s.add(m[1].toLowerCase());
  return Array.from(s);
}
function vjWoorden(t) { const s = new Set(); let m; VJ_WOORD_RE.lastIndex = 0; while ((m = VJ_WOORD_RE.exec(String(t)))) if (/\d/.test(m[1])) s.add(m[1].toLowerCase()); return s; }
function vjOpenK(p) { return !!p && (p.status === 'open' || p.status === 'later'); }
function vjWv(p) { const h = p && p.herkomst && typeof p.herkomst === 'object' ? p.herkomst : {}; return (Array.isArray(h.wv) ? h.wv : []).map(Number).filter(function (x) { return x > 0; }); }
function vjPlicht(p) {
  const h = p.herkomst && typeof p.herkomst === 'object' ? p.herkomst : {};
  if (h.auto === 'wv') return true;
  if (h.ovis && typeof h.ovis === 'object' && h.ovis.kaart) return true;
  return p.soort === 'besluit' && (vjWv(p).length > 0 || (Array.isArray(h.register) && h.register.length > 0));
}
function vjRijId(r) { return 'r' + String(r.gesteld).replace(/[^0-9]/g, '').slice(0, 12) + '-' + kortHash(r.kanaal).slice(0, 6); }
function vjTijd(iso) { const t = Date.parse(iso || ''); return isNaN(t) ? 0 : t; }
function vjAms(iso, vorm) {   // 'd-m uu:mm' of 'JJJJ-MM-DD UU:MM' in Nederlandse tijd
  const p = {}; const d = new Date(iso);
  if (isNaN(d)) return '?';
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return vorm === 'lang' ? p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute : Number(p.day) + '-' + Number(p.month) + ' ' + p.hour + ':' + p.minute;
}
function vjCel(s, n) { return kort(String(s == null ? '' : s).replace(/\|/g, '/').replace(/[\r\n]+/g, ' '), n); }
// Wat de Status-cel van een open rij wordt als de kaart dicht is. → { tekst } (schrijven), { onderweg } (de klus erachter loopt nog: geen
// bevinding binnen 3 dagen) of { reden } (alleen melden). Zelfde vormen als de skill voorschrijft. wv = { id: status } of null.
function vjStatusTekst(p, okaart, vandaag, rijStatus, wv) {
  const b = String(p.bewijs || '');
  if (p.status === 'gedaan') {
    let m = /app (\d{1,2}-\d{1,2} \d{1,2}:\d{2}): David drukte (Ja|Nee|Anders) (?:op de kaart|in het gesprek)(?: \(vraag-id ([0-9a-f]{6,16})\))?/.exec(b);
    if (m) return { tekst: 'beantwoord: ' + m[2].toUpperCase() + ' ' + m[1] + ' (app-kaart' + (m[3] ? ', vraag-id ' + m[3] : '') + (okaart && okaart.status && okaart.status !== 'open' ? '; OVIS-kaart: ' + okaart.status + (okaart.beslist_op ? ' ' + vjAms(okaart.beslist_op) : '') : '') + ')' };
    if (/David tikte (Al beantwoord|Elders al beantwoord)/.test(b)) return { reden: 'David tikte Al beantwoord, maar het antwoord staat niet in de rij' };
    m = /app (\d{1,2}-\d{1,2} \d{1,2}:\d{2}): David tikte Gedaan/.exec(b);
    if (m) {
      if (String(rijStatus).indexOf(m[1]) >= 0 && /tik/i.test(rijStatus)) return { reden: 'de rij noemt deze tik al (zoals voor-jou.py david_naloop, wv714)' };
      const ids = vjWv(p);
      // Gedaan op een kaart met een klus erachter: pas als die klus klaar is (de vervolgagent meet of het echt gedaan is; wv854)
      if (ids.length) {
        const st = ids.map(function (i) { return wv && wv[i] ? wv[i] : 'onbekend'; });
        if (st.some(function (s) { return s === 'vervallen'; })) return { reden: 'de werkvoorraadrij achter de kaart verviel' };
        if (!st.every(function (s) { return s === 'klaar'; })) return { onderweg: 'de werkvoorraadrij achter de kaart is nog niet klaar (' + st.join(', ') + ')' };
      }
      return { tekst: 'afgehandeld ' + vandaag + ' (Voor jou: David tikte Gedaan ' + m[1] + ')' };
    }
    if (VJ_MEETBEWIJS_RE.test(b)) return { tekst: 'afgehandeld ' + vandaag + ' (Voor jou: ' + vjCel(b, 140) + ')' };
    return { reden: 'de kaart ging dicht zonder antwoord van David en zonder meting' };
  }
  if (p.status === 'vervallen' && p.gesloten_door === 'david') {
    const m = /app (\d{1,2}-\d{1,2} \d{1,2}:\d{2}): David tikte Niet meer nodig/.exec(b);
    if (m) return { tekst: 'vervallen — David ' + m[1] + ' (app, Voor jou)' };   // zelfde vorm als voor-jou.py doorzet
  }
  if (p.status === 'vervallen') return { reden: 'alleen voor-jou.py wees sluit een rij van een vervallen kaart (als de werkvoorraadrij ook verviel); anders kijkt de machinekamer of de vraag nog moet' };
  return { reden: 'kaart ' + p.status + ' zonder open doelkaart' };
}
// io: { punten() → { punten, op }, register() → tekst, wv() → { items } (optioneel; mk_werkvoorraad_stand) } → meting of { fout }
async function vjMeting(io) {
  try {
    if (!io || typeof io.punten !== 'function' || typeof io.register !== 'function') return { fout: 'geen Voor jou-lezer' };
    const lijst = await io.punten();
    const punten = lijst && Array.isArray(lijst.punten) ? lijst.punten.filter(function (p) { return p && typeof p.sleutel === 'string' && p.sleutel; }) : null;
    if (!punten || !punten.length) return { fout: 'Voor jou gaf geen punten' };   // leeg is niet gemeten (zoals plek 4)
    const tekst = io.register();
    if (typeof tekst !== 'string' || tekst.indexOf('| Gesteld |') < 0) return { fout: 'register niet te lezen' };
    const rijen = vjRegister(tekst);
    if (!rijen.length) return { fout: 'register zonder rijen' };
    let wv = null, wvOuder = {};   // niet te lezen = onbekend: een Gedaan op een kaart met werkvoorraadrij wordt dan niet geschreven
    if (typeof io.wv === 'function') { try { const s = await io.wv(); if (s && Array.isArray(s.items)) { wv = {}; s.items.forEach(function (w) { if (w && w.id) { wv[w.id] = w.status; if (w.ouder_id) wvOuder[w.id] = Number(w.ouder_id); } }); } } catch (e) { wv = null; } }
    return { punten: punten, rijen: rijen, op: lijst.op || null, wv: wv, wvOuder: wvOuder };
  } catch (e) { return { fout: String(e && e.message || e).replace(/\d{6,}/g, '#').slice(0, 120) }; }
}
function vjNu(meting, terug) { const t = meting && meting.op ? Date.parse(meting.op) : NaN; return isNaN(t) ? terug : t; }   // databankklok wint
// Pure vergelijking. meting = vjMeting; ovisKaarten = reg.kaarten (secondbrain.ovis_kaart) of []; nuMs = databankklok.
// → { gemeten, reden, tel, bevindingen: [{ bevinding_id, check_id, samenvatting, detail, ernst }], acties: [{ soort: 'status'|'nieuw', … }], metActie: [bevinding_id] }
function vjKoppel(meting, ovisKaarten, nuMs) {
  if (!meting || meting.fout) return { gemeten: false, reden: meting ? meting.fout : 'geen Voor jou-lezer', tel: {}, bevindingen: [], acties: [], metActie: [] };
  const punten = meting.punten, rijen = meting.rijen, b = [], acties = [], metActie = [];
  const ps = {}; punten.forEach(function (p) { ps[p.sleutel] = p; });
  const ok = {}; (ovisKaarten || []).forEach(function (k) { ok[k.sleutel] = k; });
  const vandaag = vjAms(new Date(nuMs).toISOString()).split(' ')[0];
  function bev(check, id, sam, det, ernst) { const x = { bevinding_id: check + '-vj-' + id, check_id: check, samenvatting: schoon(sam, 200), detail: schoon(det, 600), ernst: ernst || 'warning' }; b.push(x); return x; }
  // opvolger: wvN → wvN-2, -3 … (nieuwste); samengevoegd → samengevoegd_in (hooguit 5 stappen)
  function volg(sl) {
    let p = ps[sl];
    const opv = punten.filter(function (q) { return q.sleutel.indexOf(sl + '-') === 0 && /^\d{1,2}$/.test(q.sleutel.slice(sl.length + 1)); })
      .sort(function (a, c) { return Number(c.sleutel.slice(sl.length + 1)) - Number(a.sleutel.slice(sl.length + 1)); });
    if (opv.length && (!p || !vjOpenK(p))) p = opv[0];
    for (let n = 0; p && p.status === 'samengevoegd' && p.samengevoegd_in && ps[p.samengevoegd_in] && n < 5; n++) p = ps[p.samengevoegd_in];
    return p || null;
  }
  const kaartRijen = {}, rijKaarten = new Map(), genoemdNiet = new Map();   // sleutel → [rij], rij → Set(sleutel)
  rijen.forEach(function (r) { rijKaarten.set(r, new Set()); });
  function koppel(r, p) { const l = kaartRijen[p.sleutel] = kaartRijen[p.sleutel] || []; if (l.indexOf(r) < 0) l.push(r); rijKaarten.get(r).add(p.sleutel); }
  rijen.forEach(function (r) {
    vjGenoemd(r).forEach(function (sl) { const p = volg(sl); if (p) koppel(r, p); else (genoemdNiet.get(r) || genoemdNiet.set(r, []).get(r)).push(sl); });
  });
  // losse vermelding (een sleutel als woord in Kanaal of Status, buiten de vaste vorm): twijfel — geen nieuwe rij en geen "zonder kaart"
  const los = new Map();   // sleutel → [rij]
  rijen.forEach(function (r) { vjWoorden(r.kanaal + ' ' + r.status).forEach(function (w) { if (ps[w]) (los.get(w) || los.set(w, []).get(w)).push(r); }); });
  punten.forEach(function (p) {
    const reg = p.herkomst && Array.isArray(p.herkomst.register) ? p.herkomst.register : [];
    reg.forEach(function (sl) {
      const m = vjRegMatch(rijen, sl);
      if (m.length === 1) { koppel(m[0], p); return; }
      if (!vjOpenK(p)) return;
      if (m.length > 1) bev('BB5', p.sleutel + '-reg-' + kortHash(sl).slice(0, 6), 'Voor jou-kaart ' + p.sleutel + ' wijst naar ' + m.length + ' registerrijen', 'herkomst.register ' + schoon(sl, 80) + ' past op ' + m.length + ' rijen; de app geeft dan geen knoppen. Voorstel: de Voor jou-ronde geeft de rij een #kenmerk (voor-jou.py zet).');
      else bev('BB1', p.sleutel + '-reg-' + kortHash(sl).slice(0, 6), 'Voor jou-kaart ' + p.sleutel + ' wijst naar een registerrij die er niet is', 'herkomst.register ' + schoon(sl, 80) + ' staat niet (meer) in het register. Voorstel: rij terugzetten of de sleutel op de kaart vervangen (voor-jou.py zet).');
    });
  });
  // vervangingskaart (zoals voor-jou.py register_wees, Fable wv768 MOET 1): een open kaart voor dezelfde handeling — zelfde werkvoorraadrij,
  // <sleutel>-n, dezelfde titel, een open kaart (of haar werkvoorraadrij) die Kanaal of Status van de rij noemt, of een open kaart van een
  // kindrij (ouder_id) van de werkvoorraadrij achter de dichte kaart: de klus ging verder in een vervolgrij (hertoets review #1)
  const wvOuder = meting.wvOuder || {};
  function vervanger(r, k) {
    const wvK = vjWv(k).map(String), woorden = vjWoorden(r.kanaal + ' ' + r.status);
    return punten.find(function (q) {
      if (q === k || !vjOpenK(q)) return false;
      const wvQ = vjWv(q).map(String);
      return wvQ.some(function (i) { return wvK.indexOf(i) >= 0; }) || q.sleutel.indexOf(k.sleutel + '-') === 0 || (q.titel && q.titel === k.titel)
        || woorden.has(q.sleutel) || wvQ.some(function (i) { return woorden.has('wv' + i) || (wvOuder[i] && wvK.indexOf(String(wvOuder[i])) >= 0); });
    }) || null;
  }
  const tel = { kaarten_open: 0, rijen_open: 0, gekoppeld: 0, zonder_kaart: 0, twijfel: 0, vervangen: 0, onderweg: 0, verschil: 0, acties: 0 };
  // eerst de vervangingskaarten: een open rij waarvan alle gekoppelde kaarten dicht zijn hangt aan de open vervanger (dan ook geen tweede rij
  // voor die vervanger; review #1)
  rijen.forEach(function (r) {
    if (!vjRijWacht(r)) return;
    const ks = Array.from(rijKaarten.get(r)).map(function (s) { return ps[s]; });
    if (!ks.length || ks.some(vjOpenK)) return;
    const v = ks.map(function (k) { return vervanger(r, k); }).find(Boolean);
    if (v) { koppel(r, v); tel.vervangen++; }
  });
  // kaart-kant
  punten.forEach(function (p) {
    if (!vjOpenK(p)) return;
    tel.kaarten_open++;
    const rs = kaartRijen[p.sleutel] || [];
    if (rs.length) tel.gekoppeld++;
    if (!rs.length) {
      if (!vjPlicht(p) || nuMs - vjTijd(p.aangemaakt) < VJ_RUST_MS) return;
      if (los.has(p.sleutel)) { tel.twijfel++; return; }   // een rij noemt de sleutel wel, maar niet in de vaste vorm: niet dubbel inschrijven
      const x = bev('BB2', p.sleutel, 'open Voor jou-kaart ' + p.sleutel + ' (' + p.soort + ') heeft geen registerrij', 'aangemaakt ' + vjAms(p.aangemaakt) + '. Voorstel: de Voor jou-ronde schrijft de rij in (voor-jou.py koppel --schrijf).');
      const h = p.herkomst || {}, intake = !!(h.ovis && h.ovis.kaart);
      acties.push({ soort: 'nieuw', kaart: p.sleutel, gesteld: vjAms(p.aangemaakt, 'lang'),
        kanaal: (intake ? 'hoofd' : 'machinekamer') + ' (Voor jou-kaart ' + p.soort + ' ' + p.sleutel + (intake ? ', gezet door de pod' : '') + '; ingeschreven door de Voor jou-ronde ' + vandaag + ')',
        vraag: vjCel(p.titel, 120) + (p.waarom ? ' — ' + vjCel(p.waarom, 420) : ''), aanname: 'zie de kaart in Voor jou', status: 'open',
        bewijs: 'machinekamer.voor_jou ' + p.sleutel + ' (' + vjAms(p.aangemaakt) + ')' });
      metActie.push(x.bevinding_id);
      return;
    }
    // een open doen/proef-kaart bij een beantwoorde vraag ("Ja, ik doe het") is gewoon (Fable M2): alleen een besluit telt
    if (p.soort !== 'besluit' || rs.some(vjRijOpen) || nuMs - vjTijd(p.bijgewerkt || p.aangemaakt) < VJ_RUST_MS) return;
    tel.verschil++;
    bev('BB3', p.sleutel + '-dicht', 'Voor jou-besluitkaart ' + p.sleutel + ' staat open, de vraag in het register is al afgehandeld', rs.map(function (r) { return r.gesteld + ': ' + vjCel(r.status, 60); }).join('; ') + '. Voorstel: de machinekamer kijkt of David al antwoordde (dan de kaart sluiten en de werkvoorraadrij vrijgeven) of de rij te vroeg dichtging.');
  });
  // rij-kant
  rijen.forEach(function (r) {
    if (!vjRijWacht(r)) return;
    tel.rijen_open++;
    const ks = Array.from(rijKaarten.get(r)).map(function (s) { return ps[s]; });
    const niet = genoemdNiet.get(r) || [];
    if (!ks.length) {
      if (niet.length) { tel.verschil++; bev('BB1', vjRijId(r), 'registerrij ' + r.gesteld + ' noemt een Voor jou-kaart die niet bestaat', 'Kanaal noemt ' + niet.slice(0, 3).join(', ') + '. Voorstel: de juiste kaartsleutel in Kanaal zetten, of de kaart (opnieuw) maken.'); return; }
      if (Array.from(vjWoorden(r.kanaal + ' ' + r.status)).some(function (w) { return ps[w]; })) { tel.twijfel++; return; }   // noemt wel een kaart, niet in de vaste vorm
      tel.zonder_kaart++;
      const g = Date.parse(String(r.gesteld).replace(' ', 'T') + ':00+01:00');
      if (!isNaN(g) && nuMs - g > VJ_RIJ_RUST_MS)
        bev('BB2', vjRijId(r), 'open registerrij ' + r.gesteld + ' heeft geen Voor jou-kaart', 'de vraag staat al meer dan twee dagen open zonder kaart in de app. Voorstel: de Voor jou-ronde maakt een kaart (stap 2), of de rij gaat op wacht met een reden.');
      return;
    }
    if (ks.some(vjOpenK)) return;
    const laatst = ks.slice().sort(function (a, c) { return vjTijd(c.gesloten_op || c.bijgewerkt) - vjTijd(a.gesloten_op || a.bijgewerkt); })[0];
    const dicht = vjTijd(laatst.gesloten_op || laatst.bijgewerkt);
    if (nuMs - dicht < VJ_RUST_MS) return;
    const okaart = laatst.herkomst && laatst.herkomst.ovis && laatst.herkomst.ovis.kaart ? ok[laatst.herkomst.ovis.kaart] : null;
    let st = r.cellen === 6 ? vjStatusTekst(laatst, okaart, vandaag, r.status, meting.wv) : { reden: 'rij heeft ' + r.cellen + ' cellen in plaats van 6' };
    if (st.onderweg && nuMs - dicht < VJ_ONDERWEG_MS) { tel.onderweg++; return; }
    if (st.onderweg) st = { reden: st.onderweg + ', al meer dan drie dagen' };
    // twee open rijen bij één besluitkaart: David zag alleen de vraag van herkomst.register[0]; alleen die rij, anders niets schrijven
    const open2 = (kaartRijen[laatst.sleutel] || []).filter(vjRijWacht);
    if (st.tekst && open2.length > 1) {
      const eerste = laatst.herkomst && Array.isArray(laatst.herkomst.register) && laatst.herkomst.register.length ? vjRegMatch(rijen, laatst.herkomst.register[0]) : [];
      if (!(eerste.length === 1 && eerste[0] === r)) {
        bev('BB5', laatst.sleutel + '-twee', 'Voor jou-kaart ' + laatst.sleutel + ' hangt aan ' + open2.length + ' open registerrijen', open2.map(function (x) { return x.gesteld; }).join(', ') + '. Voorstel: de machinekamer kijkt welke vraag David beantwoordde.');
        st = { reden: 'meer open rijen bij deze kaart' };
      }
    }
    tel.verschil++;
    const x = bev('BB3', vjRijId(r), 'registerrij ' + r.gesteld + ' staat open, de Voor jou-kaart is dicht', 'kaart ' + laatst.sleutel + ' ' + laatst.status + ' door ' + (laatst.gesloten_door || '?') + ' ' + vjAms(laatst.gesloten_op || laatst.bijgewerkt) + '. Voorstel: ' +
      (st.tekst ? 'de Voor jou-ronde zet de Status op "' + kort(st.tekst, 120) + '" (voor-jou.py koppel --schrijf).' : st.reden + '; de machinekamer zoekt uit waar het antwoord staat.'));
    if (st.tekst) { acties.push({ soort: 'status', gesteld: r.gesteld, kanaal: r.kanaal, oud: r.status, nieuw: st.tekst, kaart: laatst.sleutel }); metActie.push(x.bevinding_id); }
  });
  tel.acties = acties.length;
  const uniek = {}; b.forEach(function (x) { uniek[x.bevinding_id] = x; });
  return { gemeten: true, tel: tel, bevindingen: Object.keys(uniek).sort().map(function (k) { return uniek[k]; }), acties: acties, metActie: metActie };
}
// Voert de acties uit op de huidige registertekst (pure functie; compare-and-set per rij: zelfde Gesteld + Kanaal, precies één rij, Status
// nog gelijk aan wat gemeten is en nog open, precies 6 cellen). Nieuwe rijen bovenaan de tabel. → { tekst (null = niets), gedaan, overgeslagen }
function vjSchrijf(tekst, acties) {
  const nl = String(tekst).indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const regels = String(tekst).split(/\r?\n/), gedaan = [], overgeslagen = [];
  (acties || []).filter(function (a) { return a.soort === 'status'; }).forEach(function (a) {
    const hits = [];
    regels.forEach(function (r, i) { if (r.indexOf('| 20') !== 0) return; const c = vjCellen(r); if (c[0] === a.gesteld && c[1] === a.kanaal) hits.push(i); });
    if (hits.length !== 1) { overgeslagen.push({ gesteld: a.gesteld, reden: hits.length + ' passende rijen' }); return; }
    const delen = regels[hits[0]].split(/(?<!\\)\|/);
    if (delen.length !== 8) { overgeslagen.push({ gesteld: a.gesteld, reden: 'rij heeft ' + (delen.length - 2) + ' cellen in plaats van 6' }); return; }
    const oud = delen[5].trim();
    if (oud.replace(/\*/g, '') !== a.oud || !vjRijOpen({ status: oud.replace(/\*/g, '') })) { overgeslagen.push({ gesteld: a.gesteld, reden: 'Status veranderde intussen' }); return; }
    delen[5] = ' ' + vjCel(a.nieuw, 300) + ' — eerder: ' + oud + ' ';
    regels[hits[0]] = delen.join('|');
    gedaan.push({ soort: 'status', gesteld: a.gesteld, kaart: a.kaart });
  });
  const nieuw = (acties || []).filter(function (a) { return a.soort === 'nieuw'; }).filter(function (a) {
    // al ingeschreven of ergens genoemd (een eerdere ronde, of een agent schreef intussen een rij)? dan niet nog eens
    const al = regels.some(function (r) { if (r.indexOf('| 20') !== 0) return false; const c = vjCellen(r); return vjGenoemd({ kanaal: c[1] || '' }).indexOf(a.kaart) >= 0 || vjWoorden((c[1] || '') + ' ' + (c[4] || '')).has(a.kaart); });
    if (al) overgeslagen.push({ kaart: a.kaart, reden: 'rij staat er al' });
    return !al;
  });
  if (nieuw.length) {
    const kop = regels.findIndex(function (r) { return /^\| Gesteld \| Kanaal \|/.test(r); });
    if (kop < 0 || !/^\|---/.test(regels[kop + 1] || '')) nieuw.forEach(function (a) { overgeslagen.push({ kaart: a.kaart, reden: 'tabelkop niet gevonden' }); });
    else {
      regels.splice.apply(regels, [kop + 2, 0].concat(nieuw.map(function (a) {
        return '| ' + [a.gesteld, vjCel(a.kanaal, 200), vjCel(a.vraag, 600), vjCel(a.aanname, 120), a.status, vjCel(a.bewijs, 200)].join(' | ') + ' |';
      })));
      nieuw.forEach(function (a) { gedaan.push({ soort: 'nieuw', gesteld: a.gesteld, kaart: a.kaart }); });
    }
  }
  return { tekst: gedaan.length ? regels.join(nl) : null, gedaan: gedaan, overgeslagen: overgeslagen };
}

// ── wv1010: koppelregel plek 6 (bank; architectuur § 4 rij 6; ontwerp + Fable vooraf mk-scripts/wv1010/ontwerp.md) ──
// Per eigen rekening een kleine stampagina (type rekening: iban, entiteit_id PRIVE of POT, doel). De bankdatabank op de pod is de bron van
// al het andere (status, eigenaar, posten, abonnementen, regels) en wordt alleen gelezen (readOnly, alleen SELECT): de compiler zet het
// 's nachts in een gegenereerd blok op elke rekeningpagina en op de pagina Bankregels, de Bibliothecaris legt pagina's en bank naast elkaar.
// Eén vergelijking over de grens: entiteit_id op de pagina ⇄ eigenaar in de bank (POT → POT, de rest → PRIVE), plus het rekeningnummer
// op de entiteitpagina van PRIVE/POT (Fable #1). In bevindingen en kaarten nooit een volledig rekeningnummer, pad, rekeningnaam of
// regelpatroon (kinderen, derden, medewerkers op de POT-rekening; de Supabase-backup is onversleuteld, Fable #2): alleen "…1234".
// Bank leeg of niet te lezen = niet gemeten, nooit "opgelost" (Fable #4). Regels van de POT-rekening alleen als aantal (Fable #5).
const BANK_SLEUTEL_RE = /^pod:bank-transacties\/rekening#([A-Z]{2}[0-9]{2}[A-Z0-9]{11,30})$/, BANK_REGELS_SLEUTEL = 'pod:bank-transacties/regels';
const REK_RE = /^(20_Prive\/Financien\/Rekeningen|10_Zakelijk\/POT_POH_GGZ)\/Rekening - [^/]+\.md$/, REK_NAAM_RE = /^Rekening - .+\.md$/;
const REK_PRIVE_MAP = '20_Prive/Financien/Rekeningen', BANKREGELS_PAD = '20_Prive/Financien/Bankregels.md', FINANCIEN_MAP = '20_Prive/Financien';
const BANK_VERW_RE = /pod:bank-transacties\/(transactie|regel)#(\d{1,9})\b/g;
const BANK_BEVINDING_RE = /^BB\d-bank-/;
const BANK_DOOD_MS = 400 * 86400000;   // Fable #9: een regel voor een jaarpost raakt maar één keer per jaar
const BANK_REGEL_SOORT = ['extern', 'intern', 'tegen_iban', 'tegenpartij'];
const BANK_STIL = ['gezondheid', 'kinderen'];   // abonnementen in deze categorieën alleen tellen, nooit noemen (Fable #12)
const BANK_SQL = {
  rekeningen: 'SELECT rek, bron, iban, status, gezamenlijk, eigenaar, eigenaar_herkomst FROM rekeningen ORDER BY rek',
  posten: 'SELECT rek, count(*) AS n, min(datum) AS van, max(datum) AS tot FROM transacties WHERE vervangen_door IS NULL GROUP BY rek',
  regels: 'SELECT id, soort, patroon, rek, richting, type, categorie, subcategorie, eigenaar, herkomst, actief, aangemaakt, bron_nr FROM regels ORDER BY id',
  raakt: 'SELECT v.regel_id AS id, count(*) AS n, max(t.datum) AS laatst FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE v.regel_id IS NOT NULL GROUP BY v.regel_id',
  bron: 'SELECT r.id, t.rek FROM regels r JOIN transacties t ON t.nr = r.bron_nr',
  abonnementen: 'SELECT id, rek, naam, actief, categorie FROM abonnementen ORDER BY id',
};
// De lezer (server.js en ovis-run.js steken hem erin; Fable #3): readOnly, query_only, alleen SELECT, één open per meting.
function bankLezer(pad) {
  return { meet: function (batch) {
    if (!Array.isArray(batch) || batch.some(function (q) { return !q || !/^\s*select\b/i.test(q.sql); })) throw new Error('alleen lezen');
    if (!fs.existsSync(pad)) throw new Error('bankdatabank ontbreekt');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(pad, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000'); db.exec('PRAGMA query_only = 1');
      return batch.map(function (q) { const st = db.prepare(q.sql); return st.all.apply(st, q.params || []); });
    } finally { db.close(); }
  } };
}
// → { rekeningen, posten, regels, raakt, bron, abonnementen, nrs (Set van bestaande gevraagde posten) } of { fout }
function bankMeting(io, nrs) {
  try {
    if (!io || typeof io.meet !== 'function') return { fout: 'geen banklezer' };
    const namen = Object.keys(BANK_SQL), batch = namen.map(function (n) { return { sql: BANK_SQL[n], params: [] }; });
    const ns = Array.from(new Set((nrs || []).map(Number).filter(function (x) { return Number.isInteger(x) && x > 0; }))).slice(0, 500);
    if (ns.length) batch.push({ sql: 'SELECT nr FROM transacties WHERE nr IN (' + ns.map(function () { return '?'; }).join(',') + ')', params: ns });
    const r = io.meet(batch);
    if (!Array.isArray(r) || r.length !== batch.length || !r.every(Array.isArray)) return { fout: 'bank gaf geen resultaat' };
    const m = {}; namen.forEach(function (n, i) { m[n] = r[i]; });
    if (!m.rekeningen.length) return { fout: 'bank gaf geen rekeningen' };   // leeg is niet gemeten (Fable #4)
    m.nrs = new Set(ns.length ? r[namen.length].map(function (x) { return Number(x.nr); }) : []);
    return m;
  } catch (e) { return { fout: String(e && e.message || e).replace(/[A-Z]{2}\d{2}[A-Z0-9]{8,}/g, '…').replace(/\d{6,}/g, '#').slice(0, 120) }; }
}
function e4(iban) { return String(iban || '').slice(-4) || '?'; }
// Stabiel: van de rekening, niet van het pad (Fable #8). Kent de bank haar, dan de hash van het opake bank-id (diffreview ZOU 3: een hash van
// het rekeningnummer is met de laatste 4 cijfers terug te rekenen); alleen een pagina met een nummer dat de bank niet kent hasht het nummer.
function rekId(iban, rk) { return 'bank-rek-' + e4(iban) + '-' + kortHash(rk && rk.rek ? 'rek:' + rk.rek : iban).slice(0, 6); }
// Rekeningpagina → gegevens of fouten (zelfde vingerafdruk en parser als de entiteitpagina's)
function leesRekening(rel, tekst) {
  const uit = { pad: rel, fouten: [], tekst: tekst };
  if (Buffer.byteLength(String(tekst)) > MAX_BYTES) { uit.fouten.push('pagina groter dan 256 kB'); return uit; }
  const fm = frontmatter(tekst);
  if (fm.fout) { uit.fouten.push(fm.fout); return uit; }
  const va = vingerafdruk(tekst);
  if (va.fout) { uit.fouten.push(va.fout); return uit; }
  uit.sha = va.sha;
  const v = fm.velden, f = uit.fouten;
  if (v.type !== 'rekening') { f.push('type is niet rekening'); return uit; }
  uit.iban = typeof v.iban === 'string' ? v.iban.replace(/\s/g, '').toUpperCase() : '';
  uit.entiteit_id = typeof v.entiteit_id === 'string' ? v.entiteit_id : '';
  uit.doel = typeof v.doel === 'string' ? v.doel : '';
  const ov = v.ovis && typeof v.ovis === 'object' && !Array.isArray(v.ovis) ? v.ovis : {};
  uit.db = lijst(ov.db);
  if (!REK_RE.test(rel)) f.push('rekeningpagina staat niet op een vaste plek');
  if (!IBAN_VOL.test(uit.iban)) f.push('iban ontbreekt of is ongeldig');
  const sl = uit.db.map(function (s) { return BANK_SLEUTEL_RE.exec(s); }).filter(Boolean);
  if (sl.length !== 1 || sl[0][1] !== uit.iban) f.push('ovis.db noemt niet precies één bankrekening, gelijk aan iban');
  if (['PRIVE', 'POT'].indexOf(uit.entiteit_id) < 0) f.push('entiteit_id moet PRIVE of POT zijn');
  else if ((uit.entiteit_id === 'PRIVE') !== /^20_Prive\//.test(rel)) f.push('een privérekening hoort in de privémap, een POT-rekening bij de entiteit');
  if (uit.doel.length > 300) f.push('doel langer dan 300 tekens');
  if (['actueel', 'concept'].indexOf(v.status) < 0) f.push('status moet actueel of concept zijn');   // vaultstandaard (SB2-linter)
  return uit;
}
// Bankregels-pagina: de weergave; wat erboven of eronder met "- ?" staat is een voorstel
function leesBankregels(tekst) {
  const uit = { pad: BANKREGELS_PAD, fouten: [], tekst: tekst, voorstellen: [] };
  const fm = frontmatter(tekst);
  if (fm.fout) { uit.fouten.push(fm.fout); return uit; }
  const va = vingerafdruk(tekst);
  if (va.fout) { uit.fouten.push(va.fout); return uit; }
  uit.sha = va.sha;
  const ov = fm.velden.ovis && typeof fm.velden.ovis === 'object' && !Array.isArray(fm.velden.ovis) ? fm.velden.ovis : {};
  if (lijst(ov.db).indexOf(BANK_REGELS_SLEUTEL) < 0) uit.fouten.push('ovis.db noemt ' + BANK_REGELS_SLEUTEL + ' niet');
  const t = String(tekst).replace(/\r\n?/g, '\n'), pl = blokPlek(t);
  const buiten = pl.b !== undefined ? t.slice(0, pl.b) + t.slice(pl.e + BLOK_EIND.length) : t;
  uit.voorstellen = buiten.split('\n').slice(fm.eind + 1).filter(function (r) { return /^\s*[-*]\s*\?/.test(r); });
  return uit;
}
// Organisatie in het register op naam (naam, alias op de knoop, alias-kenmerk): precies één, anders niets. Alleen organisaties. Alleen
// voor weergave (een link in een gegenereerd blok; stuurt niets). Eerst exact, dan op de naamkern (rechtsvorm eraf) en dan op voorvoegsel:
// de bank kapt namen af ("Waterschap Amstel, Gooi") of zet er iets achter ("… Netherlands B.V."). Voorvoegsel alleen met een kern van
// ≥ 5 tekens (een afgekapte banknaam ≥ 10) en alleen als de langste kandidaat bij precies één organisatie hoort.
function orgOpNaam(reg) {
  function woorden(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b([bn])\.\s?v\b\.?/g, '$1v').split(/[^a-z0-9]+/).filter(Boolean); }
  function norm(s) { return woorden(s).join(''); }
  function kern(s) {
    const w = woorden(s);
    if (w.length > 1 && w[0] === 'nv') w.shift();
    if (w.length > 1 && ['bv', 'nv', 'bvba', 'gmbh', 'ltd', 'inc', 'ua', 'sa', 'ag'].indexOf(w[w.length - 1]) >= 0) w.pop();
    return w.join('');
  }
  const per = {}, perKern = {}, knopen = {};
  function zet(n, id) { const x = norm(n), k = kern(n); if (x.length >= 3) (per[x] = per[x] || new Set()).add(id); if (k.length >= 3) (perKern[k] = perKern[k] || new Set()).add(id); }
  (reg && reg.knopen || []).forEach(function (k) {
    if (k.rol === 'eigen' || k.soort !== 'organisatie' || k.actief === false || !k.vault_pagina) return;
    knopen[k.id] = k; zet(k.naam, k.id); (k.aliassen || []).forEach(function (a) { zet(a, k.id); });
  });
  (reg && reg.handvatten || []).forEach(function (h) { if (h.soort === 'alias' && h.status !== 'vervallen' && knopen[h.knoop]) zet(h.waarde, h.knoop); });
  const kernen = Object.keys(perKern);
  function een(s) { return s && s.size === 1 ? knopen[Array.from(s)[0]] : null; }
  return function (naam) {
    const s = per[norm(naam)];
    if (s) return een(s);
    const b = kern(naam);
    if (b.length < 3) return null;
    if (perKern[b]) return een(perKern[b]);
    const kand = kernen.filter(function (k) { return (k.length >= 5 && b.indexOf(k) === 0) || (b.length >= 10 && k.indexOf(b) === 0); })
      .sort(function (x, y) { return y.length - x.length; });
    if (!kand.length || (kand.length > 1 && kand[1].length === kand[0].length)) return null;
    return een(perKern[kand[0]]);
  };
}
function orgLink(k) { return '[[' + String(k.vault_pagina).replace(/\.md$/, '') + '|' + String(k.naam).replace(/[\[\]|\n]/g, ' ') + ']]'; }
function maandNl(d) { const m = /^(\d{4})-(\d{2})/.exec(String(d || '')); return m ? Number(m[2]) + '-' + m[1] : '?'; }
const BANK_STATUS = { ACTIVE: 'actief', FROZEN: 'bevroren', CANCELLED: 'opgeheven', BLOCKED: 'geblokkeerd', ontkoppeld: 'niet meer gekoppeld' };
const BANK_PAGINA_STATUS = ['ACTIVE', 'FROZEN'];   // alleen deze rekeningen vragen een pagina (paginas.py doet hetzelfde)
const BANK_HERKOMST = { systeem: 'ingedeeld door het systeem', machinekamer: 'gezet door de machinekamer', david: 'gezet via het gesprek met Socev' };   // Fable #10: 'david' is geen knop
function bankEntiteit(eigenaar) { return eigenaar === 'POT' ? 'POT' : 'PRIVE'; }
function bankBeperkt(rk) { return ['POT', 'kind', 'extern'].indexOf(rk && rk.eigenaar) >= 0; }   // daar alleen aantallen, geen namen
// Wat de regels raken: per regel de eigen rekening(en) waarop hij werkt (rek, patroon bij extern/intern, de rekening van de bronpost)
function regelRekeningen(m) {
  const bron = {}; (m.bron || []).forEach(function (x) { bron[x.id] = x.rek; });
  const bekend = new Set(m.rekeningen.map(function (r) { return r.rek; }));
  const per = {};
  (m.regels || []).forEach(function (g) {
    per[g.id] = [g.rek, ['extern', 'intern'].indexOf(g.soort) >= 0 ? g.patroon : null, bron[g.id]].filter(function (x) { return x && bekend.has(x); });
  });
  return per;
}
function bankPotRek(m) { return new Set(m.rekeningen.filter(function (r) { return r.eigenaar === 'POT'; }).map(function (r) { return r.rek; })); }
function bankRegelPot(m, perRegel, potRek) { return function (g) { return (perRegel[g.id] || []).some(function (x) { return potRek.has(x); }); }; }

// Het blok op een rekeningpagina (puur; geen datum of compilatienummer: alleen schrijven als er echt iets veranderde, Fable #11)
function bankBlokTekst(p, m, orgVan) {
  const rk = m.rekeningen.find(function (r) { return r.iban === p.iban; });
  if (!rk) return null;
  const po = (m.posten || []).find(function (x) { return x.rek === rk.rek; });
  const perRegel = regelRekeningen(m), potRek = bankPotRek(m);
  const regels = (m.regels || []).filter(function (g) { return Number(g.actief) === 1 && (perRegel[g.id] || []).indexOf(rk.rek) >= 0; });
  const r = ['## Wat de bank van deze rekening weet', '',
    '*Gegenereerd door de OVIS-compiler (nacht) uit de bankdatabank op de pod; niet met de hand bewerken. Bron is de bank; entiteit en doel hierboven schrijft Socev.*', '',
    '- Bij de bank: ' + (rk.bron === 'abn' ? 'ABN AMRO' : rk.bron === 'bunq' ? 'bunq' : schoon(rk.bron, 20)) + ' · ' + (BANK_STATUS[rk.status] || schoon(String(rk.status || 'onbekend').toLowerCase(), 20)) + ' · ' + (Number(rk.gezamenlijk) ? 'gezamenlijk' : 'niet gezamenlijk'),
    '- Eigenaar in de bank: ' + schoon(rk.eigenaar || 'onbekend', 30) + ' (' + (BANK_HERKOMST[rk.eigenaar_herkomst] || 'herkomst onbekend') + ')',
    '- Posten in de bank: ' + (po && po.n ? 'van ' + maandNl(po.van) + ' t/m ' + maandNl(po.tot) : 'nog geen') + ' (bedragen, saldo en tegenpartijen blijven in de bank)'];
  const ab = (m.abonnementen || []).filter(function (a) { return a.rek === rk.rek && Number(a.actief) === 1; });
  if (ab.length) {
    const links = [], gezien = new Set(), zonder = new Set();
    ab.forEach(function (a) {
      const k = !bankBeperkt(rk) && BANK_STIL.indexOf(a.categorie) < 0 ? orgVan(a.naam) : null;
      if (k && !gezien.has(k.id)) { gezien.add(k.id); links.push(orgLink(k)); } else if (!k) zonder.add(String(a.naam || a.id).toLowerCase());
    });
    const rest = zonder.size;   // unieke namen, niet elke machtiging apart
    links.sort();
    r.push('- Lopende vaste lasten en abonnementen: ' + (links.length ? links.join(' · ') + (rest ? ' · en ' + rest + ' zonder pagina in het register' : '') : rest + ' (geen met een pagina in het register)'));
  }
  r.push('- Bankregels voor deze rekening: ' + regels.length + (regels.length ? (potRek.has(rk.rek) ? ' (alleen geteld: posten en namen van deze rekening blijven in de bank)' : ' — zie [[' + BANKREGELS_PAD.replace(/\.md$/, '') + ']]') : ''));
  const binnen = '\n' + r.join('\n') + '\n';
  return '<!-- ovis:blok begin id="rek:' + rk.iban + '" content_hash="' + blokHash(binnen) + '" -->' + binnen + BLOK_EIND;
}
// Het blok op de pagina Bankregels (puur). Patronen nooit als tekst: een rekening als "…1234", een tegenpartij alleen als organisatie uit
// het register, anders "een tegenpartij"; regels van de POT-rekening alleen als aantal (Fable #2, #5).
function bankRegelsBlokTekst(m, rekPaginas, orgVan) {
  const opRek = {}; m.rekeningen.forEach(function (r) { opRek[r.rek] = r; });
  const pagIban = {}; (rekPaginas || []).forEach(function (p) { if (p.iban && !p.fouten.length) pagIban[p.iban] = p; });
  function rekTekst(rek) {
    const r = opRek[rek]; if (!r || !r.iban) return 'een eigen rekening';
    const p = pagIban[r.iban];
    return p ? '[[' + p.pad.replace(/\.md$/, '') + '|rekening …' + e4(r.iban) + ']]' : 'rekening …' + e4(r.iban);
  }
  const raakt = {}; (m.raakt || []).forEach(function (x) { raakt[x.id] = x; });
  const perRegel = regelRekeningen(m), potRek = bankPotRek(m), opPot = bankRegelPot(m, perRegel, potRek);
  const actief = (m.regels || []).filter(function (g) { return Number(g.actief) === 1; });
  const pot = actief.filter(opPot), zicht = actief.filter(function (g) { return !opPot(g); });
  const r = ['## Regels waarmee de bank posten indeelt', '',
    '*Gegenereerd door de OVIS-compiler (nacht) uit de bankdatabank op de pod; niet met de hand bewerken. Een regel ontstaat als Socev een correctie van David in de bank zet (in het gesprek) of als de machinekamer er een zet. Wil je een nieuwe regel, schrijf hem dan boven dit blok met "- ?" ervoor: dat is een voorstel dat Socev aan David voorlegt.*', ''];
  zicht.forEach(function (g) {
    const naar = g.richting === 'bij' ? 'van' : 'naar';
    let wat;
    if (g.soort === 'extern') wat = 'overboekingen ' + naar + ' ' + rekTekst(g.patroon);
    else if (g.soort === 'intern') wat = 'overboekingen met ' + rekTekst(g.patroon) + (g.rek ? ' vanaf ' + rekTekst(g.rek) : '');
    else if (g.soort === 'tegen_iban') wat = 'betalingen met een eigen rekening elders (…' + e4(g.patroon) + ')';
    else if (g.soort === 'tegenpartij') { const k = orgVan(g.patroon); wat = 'betalingen met ' + (k ? orgLink(k) : 'een tegenpartij (naam blijft in de bank)'); }
    else wat = 'regel van een onbekende soort';
    if (g.rek && ['intern'].indexOf(g.soort) < 0) wat += ' op ' + rekTekst(g.rek);
    const ind = [g.type ? 'soort ' + schoon(g.type, 20) : null, g.categorie ? 'categorie "' + schoon(g.categorie, 40) + '"' : null,
      g.subcategorie ? 'subcategorie "' + schoon(g.subcategorie, 40) + '"' : null, g.eigenaar ? 'eigenaar ' + schoon(g.eigenaar, 30) : null].filter(Boolean).join(', ');
    const x = raakt[g.id];
    r.push('- R' + g.id + ' · ' + wat + (g.richting === 'af' ? ' (uitgaand)' : g.richting === 'bij' ? ' (inkomend)' : '') + ' → ' + (ind || 'geen indeling') + ' · ' +
      (BANK_HERKOMST[g.herkomst] || 'herkomst onbekend') + ' · sinds ' + datumNl(g.aangemaakt) + ' · ' + (x && x.n ? 'raakte laatst een post in ' + maandNl(x.laatst) : 'raakte nog geen post'));   // geen aantal: dat zou elke nacht schrijven (diffreview KAN 6)
  });
  if (!zicht.length) r.push('- Nog geen regels buiten de POT-rekening.');
  r.push('- Op de POT-rekening: ' + pot.length + (pot.length === 1 ? ' regel' : ' regels') + ' (alleen geteld: posten en namen van de POT-rekening blijven in de bank)');
  r.push('- Ingetrokken regels (vervangen door een nieuwere): ' + ((m.regels || []).length - actief.length));
  const binnen = '\n' + r.join('\n') + '\n';
  return '<!-- ovis:blok begin id="bankregels" content_hash="' + blokHash(binnen) + '" -->' + binnen + BLOK_EIND;
}
// De checks (puur). bank = { meting, rek: [leesRekening], regels: leesBankregels|null, overig: [{ pad, tekst }] } of null.
// → { gemeten, reden?, paden: { bevinding_id: pad } (alleen voor de machinekamer op stdout, nooit naar de databank) }
function bankChecks(bank, reg, bev, tel) {
  if (!bank) { tel.bank = 'niet gemeten'; return { gemeten: false, reden: 'geen banklezer', paden: {} }; }
  const m = bank.meting, nu = bank.nu || Date.now();
  if (!m || m.fout) { tel.bank = 'niet gemeten'; return { gemeten: false, reden: m ? m.fout : 'geen meting', paden: {} }; }
  const paden = {};
  function metPad(pad) { return function (check, sleutel, samenvatting, detail, ernst) { if (pad) paden[check + '-' + sleutel] = pad; tel.bank_verschil++; bev(check, sleutel, samenvatting, detail, ernst); }; }
  tel.bank = 0; tel.bank_verschil = 0; tel.bank_verouderd = 0;
  const orgVan = orgOpNaam(reg);
  const opIban = {}; m.rekeningen.forEach(function (r) { if (r.iban) opIban[String(r.iban).toUpperCase()] = r; });
  const perIban = {};
  (bank.rek || []).forEach(function (p) {
    if (p.fouten.length) { metPad(p.pad)('BB6', 'bank-pagina-' + kortHash(p.pad).slice(0, 6), 'rekeningpagina niet te lezen: ' + p.fouten[0], 'een rekeningpagina in de Second Brain: ' + p.fouten.join('; ') + '. Pad: zie de machinekamer (ovis-run bibliothecaris --afroep --droog). Voorstel: pagina herstellen (Socev).'); return; }
    (perIban[p.iban] = perIban[p.iban] || []).push(p);
  });
  Object.keys(perIban).sort().forEach(function (iban) {
    const rk = opIban[iban], ps = perIban[iban], id = rekId(iban, rk);
    if (ps.length > 1) { metPad(ps.map(function (p) { return p.pad; }).join(' | '))('BB5', id + '-twee', 'twee pagina\'s voor rekening …' + e4(iban), ps.length + ' rekeningpagina\'s noemen hetzelfde rekeningnummer (…' + e4(iban) + '). Voorstel: samenvoegen tot één pagina.'); return; }
    const p = ps[0];
    if (!rk) { metPad(p.pad)('BB1', id + '-onbekend', 'rekeningpagina …' + e4(iban) + ' verwijst naar een rekening die de bank niet kent', 'de bank kent rekening …' + e4(iban) + ' niet (meer). Voorstel: nagaan of het nummer klopt; anders de pagina naar het archief.'); return; }
    tel.bank++;
    const ent = bankEntiteit(rk.eigenaar);
    if (p.entiteit_id !== ent) metPad(p.pad)('BB3', id + '-entiteit', 'rekening …' + e4(iban) + ': entiteit op de pagina past niet bij de eigenaar in de bank',
      'pagina zegt ' + p.entiteit_id + ', de bank zegt eigenaar "' + schoon(rk.eigenaar || 'onbekend', 20) + '" (= ' + ent + '). Voorstel: de bank is bron voor de eigenaar; pagina gelijkzetten, of David corrigeert de eigenaar in het gesprek.');
    if (p.tekst !== undefined && blokHandwerk(p.tekst)) metPad(p.pad)('BB8', id + '-blok', 'blok op rekeningpagina …' + e4(iban) + ' is met de hand gewijzigd', 'de tekst binnen het OVIS-blok is niet meer wat de compiler schreef; hij overschrijft het niet. Voorstel: wat erin getypt is naar de frontmatter (doel) zetten, daarna het blok laten vernieuwen.');
    else if (huidigBlok(p.tekst) !== bankBlokTekst(p, m, orgVan)) tel.bank_verouderd++;   // BB4: alleen telling; de nacht vernieuwt
  });
  m.rekeningen.forEach(function (r) {
    const iban = String(r.iban || '').toUpperCase();
    if (!IBAN_VOL.test(iban) || BANK_PAGINA_STATUS.indexOf(r.status) < 0 || perIban[iban]) return;   // diffreview ZOU 1: ook 'ontkoppeld' niet
    metPad(null)('BB2', rekId(iban, r) + '-geen-pagina', (r.bron === 'abn' ? 'ABN AMRO' : 'bunq') + '-rekening …' + e4(iban) + ' heeft geen pagina', 'de bank kent deze rekening (niet opgeheven), maar geen rekeningpagina noemt haar (of de pagina staat buiten de vaste plek). Voorstel: Socev maakt de pagina.');
  });
  // het rekeningnummer op de entiteitpagina van PRIVE en POT hoort bij een rekeningpagina van die entiteit (Fable #1)
  (reg && reg.knopen || []).forEach(function (k) {
    if (['PRIVE', 'POT'].indexOf(k.id) < 0 || !k.iban) return;
    const iban = String(k.iban).replace(/\s/g, '').toUpperCase(), ps = perIban[iban] || [];
    if (ps.length === 1 && ps[0].entiteit_id === k.id) return;
    metPad(null)('BB3', 'bank-ent-' + k.id + '-hoofdrekening', 'rekeningnummer op de entiteitpagina van ' + k.id + ' (…' + e4(iban) + ') hoort bij geen rekeningpagina van ' + k.id,
      (ps.length ? 'de rekeningpagina met dit nummer zegt een andere entiteit' : opIban[iban] ? 'de bank kent de rekening, maar er is geen rekeningpagina' : 'de bank kent dit nummer niet') + '. Voorstel: nagaan welke rekening de hoofdrekening is en de entiteitpagina of de rekeningpagina gelijkzetten.');
  });
  // Bankregels
  const regelIds = new Set((m.regels || []).map(function (g) { return Number(g.id); }));
  const actief = (m.regels || []).filter(function (g) { return Number(g.actief) === 1; });
  if (!bank.regels) { if (actief.length) metPad(BANKREGELS_PAD)('BB2', 'bank-regels-geen-pagina', 'de pagina met bankregels ontbreekt', actief.length + ' actieve regel(s) in de bank zonder weergave in de Second Brain. Voorstel: Socev maakt de pagina opnieuw.'); }
  else if (bank.regels.fouten.length) metPad(BANKREGELS_PAD)('BB6', 'bank-regels-pagina', 'pagina met bankregels niet te lezen: ' + bank.regels.fouten[0], bank.regels.fouten.join('; ') + '. Voorstel: pagina herstellen (Socev).');
  else {
    const prs = bankRegelsBlokTekst(m, bank.rek, orgVan);
    if (blokHandwerk(bank.regels.tekst)) metPad(BANKREGELS_PAD)('BB8', 'bank-regels-blok', 'blok op de pagina met bankregels is met de hand gewijzigd', 'de compiler overschrijft het niet. Voorstel: een gewenste regel boven het blok zetten met "- ?" ervoor, daarna het blok laten vernieuwen.');
    else if (huidigBlok(bank.regels.tekst) !== prs) tel.bank_verouderd++;
    bank.regels.voorstellen.forEach(function (x) {
      metPad(BANKREGELS_PAD)('BB6', 'bank-regel-voorstel-' + kortHash(x.trim()).slice(0, 6), 'voorstel voor een bankregel op de pagina met bankregels', 'er staat een regel met "- ?" (tekst niet in deze melding). Voorstel: Socev legt hem aan David voor; na zijn Ja zet Socev hem in de bank en haalt de regel van de pagina.');
    });
  }
  actief.forEach(function (g) {
    if (BANK_REGEL_SOORT.indexOf(g.soort) < 0) metPad(null)('BB6', 'bank-regel-' + g.id + '-onleesbaar', 'bankregel R' + g.id + ' heeft een onbekende soort', 'de weergave kan hem niet tonen. Voorstel: de machinekamer zoekt uit waar hij vandaan komt.');
    if (['david', 'machinekamer'].indexOf(g.herkomst) < 0) metPad(null)('BB7', 'bank-regel-' + g.id + '-herkomst', 'bankregel R' + g.id + ' heeft een onbekende herkomst', 'herkomst is niet David (gesprek) of de machinekamer. Voorstel: nagaan wie hem zette; zo nodig intrekken.', 'serious');
    const x = (m.raakt || []).find(function (y) { return Number(y.id) === Number(g.id); });
    const t0 = Date.parse(g.aangemaakt), tl = x && x.laatst ? Date.parse(x.laatst + 'T12:00:00Z') : NaN;
    if (!isNaN(t0) && nu - t0 > BANK_DOOD_MS && (isNaN(tl) || nu - tl > BANK_DOOD_MS)) metPad(null)('BB6', 'bank-regel-' + g.id + '-dood', 'bankregel R' + g.id + ' raakte al meer dan 400 dagen geen post', 'Voorstel: nakijken of hij nog nodig is (niet vanzelf intrekken).');
  });
  // verwijzingen naar posten en regels, en rekeningpagina's buiten de vaste plek (Fable #8)
  [].concat(bank.rek || [], bank.regels ? [bank.regels] : [], bank.overig || []).forEach(function (p) {
    const t = String(p.tekst || ''); let mm; const re = new RegExp(BANK_VERW_RE.source, 'g');
    while ((mm = re.exec(t)) !== null) {
      const n = Number(mm[2]);
      if (mm[1] === 'regel' ? !regelIds.has(n) : !m.nrs.has(n)) metPad(p.pad)('BB8', 'bank-verwijzing-' + kortHash(p.pad + '#' + mm[1] + n).slice(0, 8), 'verwijzing naar een bank' + (mm[1] === 'regel' ? 'regel' : 'post') + ' die niet (meer) bestaat',
        'een pagina in de privé-financiën noemt ' + mm[1] + ' ' + n + '; de bank kent die niet. Voorstel: verwijzing weghalen of goedzetten.');
    }
  });
  (bank.overig || []).forEach(function (p) {
    if (/^type:\s*rekening\s*$/m.test(String(p.tekst || '').split('\n---')[0]) || /pod:bank-transacties\/rekening#/.test(String(p.tekst || '')))
      metPad(p.pad)('BB6', 'bank-buiten-plek-' + kortHash(p.pad).slice(0, 6), 'rekeningpagina buiten de vaste plek', 'een pagina met een bankrekening-sleutel staat niet in de map Rekeningen (of bij de POT). Voorstel: terugzetten naar de vaste plek.');
  });
  return { gemeten: true, paden: paden };
}

// ── Kaarten in Overzicht (wv1253; ontwerp + Fable-review vooraf: mk-scripts/wv1253/ontwerp.md) ──
// Pure functies: wat er op een kaart moet (bundel per week, kritiek per veld, Bibliothecaris per week), de Anders-ontleding en de zin
// voor Socev na Davids druk. De databank (public.ovis_kaart_zet) controleert en bevriest de lijst; public.ovis_handvat_activeer voert
// Davids keuze uit. Kaarttekst in gewone taal, zonder pad of wv-nummer (machinekamer.voor_jou_verwijzing weigert die).
const KAART_STAPPEN = 12, KAART_TITEL = 90, KAART_WAAROM = 400, NEE_RUST_MS = 28 * 86400000;
const KENMERK_WOORD = { kvk: 'KvK', alias: 'naam', domein: 'website', mail: 'mailadres', kenmerkpatroon: 'nummerpatroon', 'niet-dezelfde-als': 'niet dezelfde als',
  telefoon: 'telefoonnummer', whatsapp: 'WhatsApp', signal: 'Signal', google: 'Google-contact' };   // wv1011
const KAART_PERSONEN_MAX = 6;   // wv1011 (Fable #6): personen hooguit de helft van de weekbundel, anders verdringt één drukke mailer de organisaties
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
// wv1011: een persoon is nooit voor een vaste plek (ontwerplijnen § 7: daar alleen organisaties)
function priveKnoop(k, p) { return k.id === 'PRIVE' || k.soort === 'persoon' || /^per:/.test(String(k.id)) || /^20_Prive\//.test(String(p && p.pad || k.vault_pagina || '')); }
function kenmerkTekst(h, p) {
  const z = zaadVan(p, h.soort, h.waarde_norm);
  const wat = h.soort === 'domein' ? 'mail van @' + h.waarde : h.soort === 'mail' ? 'mail van ' + h.waarde
    : h.soort === 'google' ? 'hoort bij een contact in je Google-contacten' : KENMERK_WOORD[h.soort] + ' ' + (h.soort === 'alias' ? '"' + h.waarde + '"' : h.waarde);
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
  (reg.handvatten || []).forEach(function (h) { if (HARDE_SOORTEN.indexOf(h.soort) >= 0 && h.status !== 'vervallen') { const s = h.soort + '|' + h.waarde_norm; (harde[s] = harde[s] || new Set()).add(h.knoop); } });
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
  // wv1011: personen hooguit KAART_PERSONEN_MAX stappen zolang er organisaties wachten; is er plek over, dan vullen personen aan
  const nOrg = ids.filter(function (id) { return knopen[id].soort !== 'persoon'; }).length;
  const perMax = Math.max(KAART_PERSONEN_MAX, KAART_STAPPEN - nOrg);
  const stappen = [], regels = []; let prive = false, kenmerken = 0, nPer = 0;
  for (const id of ids) {
    if (stappen.length >= KAART_STAPPEN) break;
    if (knopen[id].soort === 'persoon' && nPer >= perMax) continue;
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
    if (k.soort === 'persoon') nPer++;
    if (priveKnoop(k, p)) prive = true;
  }
  if (!stappen.length) return { reden: 'geen nieuwe kenmerken' };
  const restOrg = ids.length - stappen.length;
  // wv1011: "organisatie(s)", "persoon/personen" of "organisaties en personen"
  const nO = stappen.length - nPer;
  const wie = nPer && nO ? stappen.length + ' organisaties en personen' : nPer ? stappen.length + (nPer === 1 ? ' persoon' : ' personen') : stappen.length + (stappen.length === 1 ? ' organisatie' : ' organisaties');
  const titel = kenmerken === 1 ? '1 nieuw herkenningskenmerk bij ' + (nPer ? '1 persoon' : '1 organisatie') + ' — zo vastzetten?'
    : kenmerken + ' nieuwe herkenningskenmerken bij ' + wie + ' — zo vastzetten?';
  const waarom = 'Hiermee herkent Socev straks wie een mail, factuur of brief stuurde. Een kenmerk telt pas na jouw Ja; anders kan een mail zich als bekende afzender voordoen. '
    + 'Ja: alles hieronder vast. Nee: niets vast (komt over vier weken terug). Anders: typ welke nummers eruit moeten, bijvoorbeeld "zonder 3 en 7"; de rest wordt vast.'
    + (restOrg > 0 ? ' Nog ' + restOrg + (nOrg === ids.length ? (restOrg === 1 ? ' organisatie volgt' : ' organisaties volgen') : (restOrg === 1 ? ' volgt' : ' volgen')) + ' in de komende weken.' : '');
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
    if (VJ_BEVINDING_RE.test(b.bevinding_id)) return false;   // wv1009: plek 5 is machinestaat; de Voor jou-ronde en de machinekamer handelen het af
    if (b.check_id === 'BB3' && !/-handvatten$/.test(b.bevinding_id) && !/^BB3-bank-/.test(b.bevinding_id)) return false;   // naam/agb/intrekking: eigen kritiek-kaart; wv981: pot-cc wacht op fase 2; wv1010: bank wel
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
    if (BANK_BEVINDING_RE.test(b.bevinding_id)) return nr + '. ' + bankKaartZin(b);   // wv1010: plek 6
    if (/^BB6-per:.*-zegel$/.test(b.bevinding_id)) return nr + '. ' + nm + ': op de pagina is buiten mij om iets veranderd aan wat OVIS van deze persoon bijhoudt. Ik kijk wat het is en zet het goed; tot dan herkent Socev niets nieuws van deze persoon.';   // wv1011
    if (/^BB2-per:.*-blok-weg$/.test(b.bevinding_id)) return nr + '. ' + nm + ': het deel van de pagina waarmee OVIS deze persoon herkent is weg of onleesbaar. Ik zet het terug.';
    if (/^BB2-per:.*-geen-pagina$/.test(b.bevinding_id)) return nr + '. ' + nm + ': de pagina van deze persoon is weg of verplaatst. Ik zoek uit waar hij is; een nieuwe maak ik niet.';
    if (/^BB5-.*-object$/.test(b.bevinding_id)) return nr + '. Twee pagina\'s lijken over dezelfde persoon te gaan. Ik zoek het uit en leg het samenvoegen apart aan je voor.';
    if (/^BB1-per:.*-(object|google|google-weg)$/.test(b.bevinding_id)) return nr + '. ' + nm + ': de koppeling met ' + (/-object$/.test(b.bevinding_id) ? 'de identiteit in het register' : 'je Google-contacten') + ' klopt niet. Ik zoek uit welke de juiste is.';
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
    waarom: 'De Bibliothecaris vergelijkt elke nacht de pagina\'s over organisaties, personen en rekeningen met het register en de bank, en lost niets stil op. Ja: Socev lost ze op zoals hieronder. Nee: alles blijft zoals het is. Anders: typ welke nummers niet, bijvoorbeeld "zonder 2".',
    // wv1011: namen van personen nooit op een vaste plek
    stappen: stappen, prive: kandidaten.some(function (b) { return PER_BEVINDING_RE.test(b.bevinding_id); }), regels: kandidaten.map(function (b, i) { return { nr: i + 1, actie: 'biblio', tabel: 'structuur_state', id: b.bevinding_id }; }) } };
}

// wv1010: de zin op de weekkaart voor een bevinding van plek 6 (alleen "…1234" en regelnummers, nooit namen)
function bankKaartZin(b) {
  const id = b.bevinding_id, x = /-rek-([A-Z0-9]{4})-/.exec(id), rek = x ? '…' + x[1] : '', g = /-regel-(\d+)-/.exec(id), ent = /-ent-([A-Z]+)-/.exec(id);
  if (b.check_id === 'BB2') return /bank-regels/.test(id) ? 'De pagina met bankregels ontbreekt. Ik maak hem opnieuw.' : 'Bankrekening ' + rek + ' heeft nog geen pagina in de Second Brain. Ik maak er een.';
  if (b.check_id === 'BB1') return 'Een rekeningpagina (' + rek + ') verwijst naar een rekening die de bank niet kent. Ik zoek uit welke het is en zet het goed.';
  if (b.check_id === 'BB3') return ent ? 'Het rekeningnummer op de pagina van ' + ent[1] + ' hoort bij geen rekeningpagina van ' + ent[1] + '. Ik zoek uit welke rekening het is en zet ze gelijk.'
    : 'Rekening ' + rek + ': de pagina zegt over de eigenaar iets anders dan de bank. Ik zet de pagina gelijk aan de bank.';
  if (b.check_id === 'BB5') return 'Twee pagina\'s noemen rekening ' + rek + '. Ik voeg ze samen.';
  if (b.check_id === 'BB7') return 'Bankregel R' + (g ? g[1] : '?') + ' heeft een onbekende herkomst. Ik zoek uit wie hem zette.';
  if (b.check_id === 'BB8') return /-verwijzing-/.test(id) ? 'Een pagina in je financiën verwijst naar een bankpost of -regel die niet (meer) bestaat. Ik zet de verwijzing goed.'
    : 'Op ' + (/bank-regels/.test(id) ? 'de pagina met bankregels' : 'een rekeningpagina (' + rek + ')') + ' is in het automatische blok iets met de hand veranderd. Ik zet dat in de pagina zelf.';
  if (/-voorstel-/.test(id)) return 'Op de pagina met bankregels staat een voorstel voor een nieuwe regel. Ik leg het apart aan je voor.';
  if (/-dood$/.test(id)) return 'Bankregel R' + (g ? g[1] : '?') + ' deelt al meer dan een jaar niets meer in. Ik kijk of hij weg kan en vraag het je eerst.';
  if (/-onleesbaar$/.test(id)) return 'Bankregel R' + (g ? g[1] : '?') + ' is van een soort die ik niet kan tonen. Ik zoek uit waar hij vandaan komt.';
  if (/-buiten-plek-/.test(id)) return 'Een rekeningpagina staat op de verkeerde plek. Ik zet hem terug in de map Rekeningen.';
  return 'Een pagina over je rekeningen is niet te lezen. Ik herstel hem.';
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
  // wv1011: kandidaat-persoonspagina's — alle .md onder 10_Zakelijk/<map>/(…/){0,2} buiten bronnen, archief, notulen, relaties en skills
  function vindPersonen() {
    const uit = [];
    function lijstMap(rel) { try { return o.lijst(rel); } catch (e) { return []; } }
    (function loop(rel, diepte) {
      lijstMap(rel).forEach(function (x) {
        if (x.naam.startsWith('.') || uit.length >= MAX_PAGINAS) return;
        const r = rel + '/' + x.naam;
        if (x.map) { if (diepte < 3 && PER_MAP_UIT.indexOf(x.naam) < 0) loop(r, diepte + 1); return; }
        if (x.bestand && diepte >= 1 && x.naam.endsWith('.md') && !/^(Entiteit|Rekening) - /.test(x.naam) && x.naam.toLowerCase() !== 'index.md') uit.push(r);
      });
    })('10_Zakelijk', 0);
    return uit.sort();
  }
  // → { paginas, paden (alle kandidaat-paden), fout } — zonder zegelsleutel worden personen niet gelezen (niet gemeten; niets gestuurd,
  // niets opgelost, geen BB2): fail closed
  let perStand = { paden: new Set(), fout: null };
  function leesPersonen() {
    const uit = [], paden = vindPersonen();
    let sleutel = null;
    try { sleutel = typeof o.zegelSleutel === 'function' ? o.zegelSleutel() : zegelSleutelLees(); }
    catch (e) { perStand = { paden: new Set(paden), fout: 'zegelsleutel niet te lezen (' + String(e && e.code || e && e.message || e).slice(0, 40) + ')' }; return uit; }
    if (!sleutel) { perStand = { paden: new Set(paden), fout: 'zegelsleutel ontbreekt' }; return uit; }
    paden.forEach(function (rel) {
      let t;
      try { t = o.lees(path.join(vault, rel)); } catch (e) { return; }   // onleesbaar bestand zonder bewijs dat het een OVIS-persoon is: niets te melden
      if (t.indexOf('knoop#per:') < 0) return;   // goedkope voorselectie: zonder sleutel geen OVIS-persoon
      const p = leesPersoon(rel, t, sleutel);
      if (p) uit.push(p);
    });
    perStand = { paden: new Set(paden), fout: null };
    return uit;
  }
  function leesAlles() {
    return vind().map(function (rel) {
      let t;
      try { t = o.lees(path.join(vault, rel)); } catch (e) { return { pad: rel, fouten: ['niet te lezen (' + String(e && e.code || e && e.message || e).slice(0, 40) + ')'] }; }
      const p = leesPagina(rel, t); p.tekst = t; return p;
    }).concat(leesPersonen());   // wv1011: personen zonder tekst (geen blok, geen BB8 op hun pagina)
  }
  // wv1010: rekeningpagina's (vaste plekken), de pagina Bankregels en de rest van 20_Prive/Financien (alleen voor verwijzingen en pagina's
  // buiten de plek; tekst alleen bewaard als er iets bank-achtigs in staat)
  function leesBank() {
    const uit = { rek: [], regels: null, overig: [] };
    function lijstMap(rel) { try { return o.lijst(rel); } catch (e) { return []; } }
    function lees(rel) { try { return o.lees(path.join(vault, rel)); } catch (e) { return null; } }
    const rels = [];
    lijstMap(REK_PRIVE_MAP).forEach(function (x) { if (x.bestand && REK_NAAM_RE.test(x.naam)) rels.push(REK_PRIVE_MAP + '/' + x.naam); });
    lijstMap('10_Zakelijk').forEach(function (m) {
      if (!m.map || m.naam.startsWith('.') || m.naam === '_Gedeeld') return;
      lijstMap('10_Zakelijk/' + m.naam).forEach(function (x) { if (x.bestand && REK_NAAM_RE.test(x.naam)) rels.push('10_Zakelijk/' + m.naam + '/' + x.naam); });
    });
    rels.sort().slice(0, 200).forEach(function (rel) { const t = lees(rel); uit.rek.push(t === null ? { pad: rel, fouten: ['niet te lezen'] } : leesRekening(rel, t)); });
    const br = lees(BANKREGELS_PAD);
    if (br !== null) uit.regels = leesBankregels(br);
    const gezien = new Set(rels.concat([BANKREGELS_PAD])); let n = 0;
    (function loop(rel, diepte) {
      lijstMap(rel).forEach(function (x) {
        if (n > 400 || x.naam.startsWith('.')) return;
        const r = rel + '/' + x.naam;
        if (x.map && diepte < 3 && ['raw_input', 'Bronnen', 'Archief'].indexOf(x.naam) < 0 && r !== REK_PRIVE_MAP) return loop(r, diepte + 1);
        if (!x.bestand || !x.naam.endsWith('.md') || gezien.has(r)) return;
        n++;
        const t = lees(r);
        if (t !== null && t.indexOf('pod:bank-transacties') >= 0 || t !== null && /^type:\s*rekening\s*$/m.test(t.slice(0, 2000))) uit.overig.push({ pad: r, tekst: t.slice(0, MAX_BYTES) });
      });
    })(FINANCIEN_MAP, 0);
    return uit;
  }
  function bankVerwijzingen(lb) {
    const nrs = [];
    [].concat(lb.rek, lb.regels ? [lb.regels] : [], lb.overig).forEach(function (p) {
      const re = new RegExp(BANK_VERW_RE.source, 'g'); let m;
      while ((m = re.exec(String(p.tekst || ''))) !== null) if (m[1] === 'transactie') nrs.push(Number(m[2]));
    });
    return nrs;
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
    if (perStand.fout) uit.fouten.push({ pad: '(personen)', fout: perStand.fout });   // wv1011
    const perId = {};
    paginas.forEach(function (p) { if (!p.fouten.length) (perId[p.id] = perId[p.id] || []).push(p); else uit.fouten.push({ pad: p.pad, fout: p.fouten[0] }); });
    const te = [], soorten = soortenVan(reg), eigen = new Set(reg.knopen.filter(function (k) { return k.soort === 'entiteit'; }).map(function (k) { return k.id; }));
    const hvPer = {}; (reg.handvatten || []).forEach(function (h) { if (h.status !== 'vervallen') (hvPer[h.knoop] = hvPer[h.knoop] || new Set()).add(h.soort + '|' + h.waarde_norm); });
    uit.wacht_soort = 0;
    Object.keys(perId).forEach(function (id) {
      const ps = perId[id], k = knopen[id];
      const a = k ? ps.find(function (p) { return p.pad === k.vault_pagina; }) : (ps.length === 1 ? ps[0] : null);
      if (!a) { uit.overgeslagen += ps.length; return; }
      if (a.persoon) uit.wacht_soort += handvattenVan(a).length - handvattenGestuurd(a, soorten).length;
      if (k && k.bron_sha === a.sha) {
        // wv1011: een persoon ook opnieuw als de databank inmiddels een soort aanneemt die nog niet in het register staat (fase B), anders
        // blijft een telefoonnummer op een ongewijzigde pagina eeuwig buiten het register
        if (!a.persoon || handvattenGestuurd(a, soorten).every(function (h) { return (hvPer[id] || new Set()).has(h.soort + '|' + normHandvat(h.soort, h.waarde)); })) return;
      }
      te.push(a);
    });
    for (const p of te) {
      if (opties.droog) { uit.gestuurd++; continue; }
      try {
        const r = await o.sbRpc('ovis_pagina_zet', { p: rpcInvoer(p, comp, { soorten: soorten, eigen: eigen }) });
        uit.gestuurd++;
        if (r && r.nieuw) uit.nieuw++;
        uit.voorstellen += (r && r.voorstellen || []).length; uit.ingetrokken += (r && r.ingetrokken || []).length; uit.kritiek += (r && r.kritiek || []).length;
      } catch (e) { uit.fouten.push({ pad: p.pad, fout: 'databank: ' + String(e && e.message || e).slice(0, 160), persoon: p.persoon ? p.id : undefined }); }
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
        const k = k2[id]; if (!k || k.soort === 'persoon') continue;   // wv1011: geen gegenereerd blok op een persoonspagina
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
      // wv1010: blokken op de rekeningpagina's en de pagina Bankregels (bank één keer per ronde gelezen, Fable #13). Bank niet te lezen:
      // niets aanraken. Zelfde regels als hierboven: handwerk niet overschrijven, opnieuw lezen vlak voor het schrijven.
      if (o.bank) {
        uit.bankblokken = 0;
        const lb = leesBank(), bm = bankMeting(o.bank, []);
        if (bm.fout) uit.fouten.push({ pad: '(bank)', fout: 'bank niet te lezen: ' + bm.fout });
        else {
          const orgVan = orgOpNaam(reg2), telIban = {};
          lb.rek.forEach(function (p) { if (!p.fouten.length) telIban[p.iban] = (telIban[p.iban] || 0) + 1; });
          const doelen = lb.rek.filter(function (p) { return !p.fouten.length && telIban[p.iban] === 1; }).map(function (p) { return { p: p, blok: bankBlokTekst(p, bm, orgVan) }; });
          if (lb.regels && !lb.regels.fouten.length) doelen.push({ p: lb.regels, blok: bankRegelsBlokTekst(bm, lb.rek, orgVan) });
          for (const d of doelen) {
            if (!d.blok || huidigBlok(d.p.tekst) === d.blok) continue;
            if (blokHandwerk(d.p.tekst)) { uit.handwerk++; continue; }
            if (opties.droog) { uit.bankblokken++; continue; }
            try {
              const vol = path.join(vault, d.p.pad), vers = o.lees(vol);
              if (vingerafdruk(vers).sha !== d.p.sha) { uit.fouten.push({ pad: d.p.pad, fout: 'pagina veranderde tijdens de ronde; blok volgende nacht' }); continue; }
              if (blokHandwerk(vers)) { uit.handwerk++; continue; }
              o.schrijf(vol, zetBlok(vers, d.blok));
              uit.bankblokken++;
            } catch (e) { uit.fouten.push({ pad: d.p.pad, fout: 'bankblok: ' + String(e && e.code || e && e.message || e).slice(0, 80) }); }
          }
        }
      }
    }
    uit.ms = nu() - t0;
    log('ovis-compileer ' + JSON.stringify({ modus: modus, paginas: uit.paginas, gestuurd: uit.gestuurd, nieuw: uit.nieuw, fouten: uit.fouten.length, blokken: uit.blokken, handwerk: uit.handwerk, medewerkerblokken: uit.medewerkerblokken, bankblokken: uit.bankblokken }));
    return uit;
  }
  // Bibliothecaris: leest, vergelijkt, schrijft bevindingen (BB), stempelt (niet op afroep). opties.sinds = log sinds (ISO).
  async function bibliothecaris(opties) {
    opties = opties || {};
    const c = await compileer('afroep', { droog: !!opties.droog });   // diffreview #1: eerst bijwerken (alleen databank), fouten worden BB6
    const reg = await register(opties.sinds || new Date(nu() - 36 * 3600000).toISOString());
    const paginas = leesAlles();
    const pot = o.pot ? await potMeting(o.pot) : null;   // wv981: plek 4 (alleen lezen); o.pot = { d1(batch), dossier() }
    let bank = null;   // wv1010: plek 6 (alleen lezen); o.bank = bankLezer(pad)
    if (o.bank) { const lb = leesBank(); bank = Object.assign(lb, { meting: bankMeting(o.bank, bankVerwijzingen(lb)), nu: nu() }); }
    // wv1011: plek 7 — persoon-entities en de Google-contacten die een pagina noemt (alleen lezen). Niet te lezen → BB1-object/-google niet getoetst.
    let personen = null;
    if (perStand.fout) personen = { nietGelezen: true };
    else if (paginas.some(function (p) { return p.persoon; }) || (reg.knopen || []).some(function (k) { return k.soort === 'persoon'; })) {
      const rs = Array.from(new Set([].concat.apply([], paginas.filter(function (p) { return p.persoon && p.google; }).map(function (p) { return p.google; }))
        .concat((reg.handvatten || []).filter(function (h) { return h.soort === 'google'; }).map(function (h) { return h.waarde_norm; })))).slice(0, 500);
      try { personen = await o.sbRpc('ovis_personen_lees', { p_resource: rs }); if (!personen || !Array.isArray(personen.entity)) personen = null; }
      catch (e) { personen = null; log('ovis-personen niet gemeten: ' + String(e && e.message || e).slice(0, 120)); }
      if (personen) personen.paden = perStand.paden; else personen = { paden: perStand.paden };
    }
    const r = checks(paginas, reg, c.fouten, pot, bank, personen);
    r.tel.personen_gemeten = !!(personen && Array.isArray(personen.entity));
    r.tel.personen_gelezen = !(personen && personen.nietGelezen);
    // wv1009: plek 5 (Voor jou ⇄ register), alleen lezen; o.vj = { punten(), register() }
    // diffreview #8/#9: een onverwachte vorm breekt de nachtronde niet (dan "niet gemeten"); databankklok voor de rust
    try { const vm = o.vj ? await vjMeting(o.vj) : { fout: 'geen Voor jou-lezer' }; r.vj = vjKoppel(vm, reg.kaarten, vjNu(vm, nu())); }
    catch (e) { r.vj = { gemeten: false, reden: 'vergelijking faalde: ' + String(e && e.message || e).slice(0, 80), tel: {}, bevindingen: [], acties: [], metActie: [] }; }
    if (r.vj.gemeten) { const al = new Set(r.bevindingen.map(function (x) { return x.bevinding_id; })); r.vj.bevindingen.forEach(function (x) { if (!al.has(x.bevinding_id)) r.bevindingen.push(x); }); }
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
    // wv1009: idem voor plek 5 zonder Voor jou-meting; wv1010: idem voor plek 6 zonder bankmeting
    const opgelost = Object.keys(open).filter(function (id) { return !gezien.has(id) && !/^BB7-.*-spoor-\d{8}$/.test(id) && (r.pot.gemeten || !POT_BEVINDING_RE.test(id)) && (r.vj.gemeten || !VJ_BEVINDING_RE.test(id)) && (r.bank.gemeten || !BANK_BEVINDING_RE.test(id))
      && (r.tel.personen_gemeten || !/^BB1-per:.*-(object|google|google-weg)$|^BB3-per:.*-google-tel$/.test(id))
      && (r.tel.personen_gelezen || !PER_BEVINDING_RE.test(id))
      && !(r.perFout || []).some(function (pid) { return id.indexOf(pid + '-') >= 0 || id.slice(-pid.length - 1) === '-' + pid; }); });   // wv1011: niet gemeten ≠ opgelost (KAN 12: ook niet bij een ontzegelde pagina)
    opgelost.forEach(function (id) { rijen.push({ bevinding_id: id, status: 'opgelost', laatst_gezien: nu_, detail_erbij: ' | ' + nu_.slice(0, 10) + ': niet meer gezien door de Bibliothecaris' }); });
    if (!opties.droog) for (let i = 0; i < rijen.length; i += 100) await o.sbRpc('ovis_bibliothecaris_zet', { p_rijen: rijen.slice(i, i + 100) });
    const onverklaard = r.bevindingen.length;
    const zin = onverklaard ? onverklaard + ' verschil(len) tussen pagina\'s en register (' + nieuw.length + ' nieuw, ' + opgelost.length + ' opgelost)'
      : 'register en pagina\'s gelijk (' + r.tel.geldig + ' pagina\'s' + (r.tel.verouderd ? ', ' + r.tel.verouderd + ' nog niet gecompileerd' : '') + (r.tel.wacht_op_ja ? ', ' + r.tel.wacht_op_ja + (r.tel.wacht_op_ja === 1 ? ' kenmerk wacht' : ' kenmerken wachten') + ' op Davids Ja' : '') + ')';
    const potZin = r.pot.gemeten ? '; POT-factuuradressen: ' + r.tel.pot + ' praktijk(en) gemeten, ' + r.tel.pot_verschil + ' met een verschil' : '; POT-factuuradressen niet gemeten (' + schoon(r.pot.reden || '?', 80) + ')';
    const vjZin = r.vj.gemeten ? '; Voor jou ⇄ register: ' + r.vj.tel.kaarten_open + ' open kaart(en), ' + r.vj.tel.rijen_open + ' open vraag/vragen, ' + r.vj.bevindingen.length + ' verschil(len)' : '; Voor jou ⇄ register niet gemeten (' + schoon(r.vj.reden || '?', 80) + ')';
    const perZin = !r.tel.personen_gelezen ? '; personen niet gemeten (zegelsleutel)' : '; personen: ' + (r.tel.personen || 0) + ' gemeten, ' + (r.tel.per_verschil || 0) + ' verschil(len)';   // wv1011
    const bankZin = r.bank.gemeten ? '; bankrekeningen: ' + r.tel.bank + ' gemeten, ' + r.tel.bank_verschil + ' verschil(len)' : '; bankrekeningen niet gemeten (' + schoon(r.bank.reden || '?', 80) + ')';
    r.tel.vj = r.vj.gemeten ? r.vj.bevindingen.length : 'niet gemeten';
    // diffreview #7: wat de Voor jou-ronde om 07:15 zelf rechtzet, hoort niet in de box (nieuw_box/nieuwe zonder die bevindingen)
    const metActie = new Set(r.vj.metActie || []), nieuweBox = nieuw.filter(function (x) { return !metActie.has(x.bevinding_id); });
    const uit = { uitkomst: onverklaard ? 'bevindingen' : 'ok', zin: zin + potZin + vjZin + bankZin + perZin, tel: r.tel, pot: r.pot, bank: r.bank, vj: { gemeten: r.vj.gemeten, reden: r.vj.reden || null, tel: r.vj.tel }, open: onverklaard, nieuw: nieuw.length, nieuw_box: nieuweBox.length, opgelost: opgelost.length,
      per_check: r.bevindingen.reduce(function (a, x) { a[x.check_id] = (a[x.check_id] || 0) + 1; return a; }, {}), bevindingen: r.bevindingen, nieuwe: nieuweBox };
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
  return '\n## [bibliothecaris] ' + tijd + ' — ' + (b.nieuw_box != null ? b.nieuw_box : b.nieuw) + ' nieuwe verschil(len) in het OVIS-register (automatisch, wv979)\n' +
    '- status: open\n- van: pod (ovis-register.js, Bibliothecaris 02:30)\n' +
    '- gemeten: ' + b.zin + '. Nieuw: ' + b.nieuwe.slice(0, 6).map(function (x) { return x.check_id + ' ' + k(x.samenvatting); }).join('; ') + (b.nieuwe.length > 6 ? '; …' : '') + '\n' +
    '- gevolg als er niets gebeurt: de router (stap 2) herkent op een register dat niet gelijk is aan de pagina\'s; kritieke verschillen (rekening, contact) blijven staan.\n' +
    '- voorstel: per bevinding in secondbrain.structuur_state (BB…); de voorstelkaart voor David komt met vervolgrij A. Kritiek (ernst serious) dezelfde dag nalopen.\n' +
    (b.nieuwe.some(function (x) { return VJ_BEVINDING_RE.test(x.bevinding_id); }) ? '- plek 5 (Voor jou ⇄ Open vragen, BB…-vj-…): wat zeker is zet de Voor jou-ronde (07:15/17:15) recht met `voor-jou.py koppel --schrijf`; de rest is machinekamerwerk (geen kaart aan David).\n' : '');
}

function boxRijFout(fout, tijd) {
  return '\n## [bibliothecaris] ' + tijd + ' — Bibliothecaris niet gelukt (automatisch, wv979)\n- status: open\n- van: pod (ovis-register.js, 02:30)\n' +
    '- gemeten: ' + schoon(fout, 200) + '\n- gevolg als er niets gebeurt: geen stempel; de Stiltewachter meldt na 26 u. Herkansing elke 5 min tot 06:00.\n' +
    '- voorstel: `node /opt/data/app/current/ovis-run.js bibliothecaris --droog` in de machinekamer en de fout nalopen.\n';
}

module.exports = { maak: maak, boxRijFout: boxRijFout, leesPagina: leesPagina,
  leesPersoon: leesPersoon, persoonZegel: persoonZegel, zegelSleutelLees: zegelSleutelLees, ZEGEL_SLEUTEL_PAD: ZEGEL_SLEUTEL_PAD, persoonMetZegel: persoonMetZegel, persoonSha: persoonSha, normTel: normTel, PER_BEVINDING_RE: PER_BEVINDING_RE,
  frontmatter: frontmatter, vingerafdruk: vingerafdruk, checks: checks, blokTekst: blokTekst,
  blokHandwerk: blokHandwerk, blokHash: blokHash, blokPlek: blokPlek,
  rekeningRegel: rekeningRegel, rekeningenPerDoel: rekeningenPerDoel, mdwBlokTekst: mdwBlokTekst, REK_KOP: REK_KOP,
  zetBlok: zetBlok, huidigBlok: huidigBlok, rpcInvoer: rpcInvoer, handvattenVan: handvattenVan, normHandvat: normHandvat, boxRij: boxRij, slug: slug,
  BLOK_BEGIN: BLOK_BEGIN, BLOK_EIND: BLOK_EIND, SCHRIJVERS_OK: SCHRIJVERS_OK,
  potMeting: potMeting, potChecks: potChecks, kaartPot: kaartPot, POT_SQL: POT_SQL, POT_BEVINDING_RE: POT_BEVINDING_RE,
  vjMeting: vjMeting, vjNu: vjNu, vjKoppel: vjKoppel, vjSchrijf: vjSchrijf, vjRegister: vjRegister, vjGenoemd: vjGenoemd, VJ_BEVINDING_RE: VJ_BEVINDING_RE,
  bankLezer: bankLezer, bankMeting: bankMeting, bankChecks: bankChecks, leesRekening: leesRekening, leesBankregels: leesBankregels, bankBlokTekst: bankBlokTekst,
  bankRegelsBlokTekst: bankRegelsBlokTekst, bankKaartZin: bankKaartZin, orgOpNaam: orgOpNaam, BANK_SQL: BANK_SQL, BANK_BEVINDING_RE: BANK_BEVINDING_RE, BANKREGELS_PAD: BANKREGELS_PAD,
  plan: plan, kaartBundel: kaartBundel, kaartenKritiek: kaartenKritiek, kaartBiblio: kaartBiblio, eruitUit: eruitUit, uitkomstZin: uitkomstZin, isoWeek: isoWeek,
  KAART_SLEUTEL_RE: /^intake-(handvat|kritiek|biblio)-[a-z0-9]+(-[a-z0-9]+)*$/ };
