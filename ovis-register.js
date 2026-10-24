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
const MAX_PAGINAS = 2000, MAX_BYTES = 256 * 1024;
const SCHRIJVERS_OK = ['compiler', 'migratie-0002', 'activeer'];
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

// Vingerafdruk zonder het gegenereerde blok en zonder `updated:` in de frontmatter (Fable wv979 #13).
function vingerafdruk(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n');
  const b = t.indexOf(BLOK_BEGIN), e = t.indexOf(BLOK_EIND);
  if ((b >= 0) !== (e >= 0) || (b >= 0 && e < b) || (b >= 0 && t.indexOf(BLOK_BEGIN, b + 1) >= 0)) return { fout: 'gegenereerd blok half of dubbel' };
  const zonder = b >= 0 ? t.slice(0, b).replace(/\n+$/, '\n') + t.slice(e + BLOK_EIND.length).replace(/^\n+/, '') : t;
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
  uit.aliassen = lijst(v.aliassen);
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
function blokTekst(knoop, handvatten, contact) {
  const h = handvatten.filter(function (x) { return x.status !== 'vervallen'; }).map(function (x) {
    return SOORT_WOORD[x.soort] + ' ' + (x.soort === 'alias' ? '"' + x.waarde + '"' : x.waarde) + ' (' + STATUS_WOORD[x.status] + (x.intrekking ? '; van de pagina gehaald, wacht op Davids Ja' : '') + ')';
  });
  const c = contact.filter(function (x) { return x.status !== 'vervallen'; }).map(function (x) {
    return x.veld + ' (' + STATUS_WOORD[x.status] + (x.intrekking ? '; van de pagina gehaald' : '') + ')';
  });
  return [BLOK_BEGIN, '## Wat OVIS van deze partij weet', '',
    '*Gegenereerd door de OVIS-compiler (nacht); niet met de hand bewerken. Bron is de frontmatter hierboven; een nieuw kenmerk of contactgegeven telt pas na Davids Ja.*', '',
    '- Herkenningskenmerken: ' + (h.length ? h.join(' · ') : 'geen'),
    '- Contactgegevens in het register: ' + (c.length ? c.join(' · ') : 'geen'),
    '- Register: ' + (knoop.concept ? 'concept · ' : '') + 'compilatie ' + (knoop.compilatienummer || '–') + ', laatst gewijzigd ' + (knoop.gecompileerd_op ? datumNl(knoop.gecompileerd_op) : '–'),
    BLOK_EIND].join('\n');
}
function zetBlok(tekst, blok) {
  const t = String(tekst).replace(/\r\n?/g, '\n');
  const b = t.indexOf(BLOK_BEGIN), e = t.indexOf(BLOK_EIND);
  if (b >= 0 && e > b) return t.slice(0, b) + blok + t.slice(e + BLOK_EIND.length);
  return t.replace(/\n*$/, '\n\n') + blok + '\n';
}
function huidigBlok(tekst) {
  const t = String(tekst).replace(/\r\n?/g, '\n');
  const b = t.indexOf(BLOK_BEGIN), e = t.indexOf(BLOK_EIND);
  return b >= 0 && e > b ? t.slice(b, e + BLOK_EIND.length) : null;
}

// ── Bibliothecaris: de checks (pure functie over pagina's en register) ──
function kortHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8); }
function schoon(s, n) { s = String(s == null ? '' : s).replace(/[\r\n`|]/g, ' ').slice(0, n || 300); return SLEUTEL_RE.test(s) ? '(weggelaten: leek op een sleutel)' : s; }
function checks(paginas, reg, compileerFouten) {
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
    if (!k) { tel.verouderd++; return; }   // nog niet gecompileerd (BB4: alleen telling)
    if (k.bron_sha !== p.sha) tel.verouderd++;
    // BB1 sleutels
    if (p.db.indexOf('supabase:secondbrain/knoop#' + id) < 0) bev('BB1', id + '-eigen-sleutel', 'pagina van ' + id + ' noemt zijn eigen databaserij niet', p.pad + ': ovis.db mist supabase:secondbrain/knoop#' + id + '. Voorstel: sleutel toevoegen.');
    p.db.forEach(function (s) {
      let m = /^supabase:secondbrain\/knoop#(.+)$/.exec(s);
      if (m) { if (!knopen[m[1]] || m[1] !== id) bev('BB1', id + '-' + kortHash(s), 'sleutel op de pagina van ' + id + ' wijst niet naar zijn rij', p.pad + ': ' + s + '. Voorstel: sleutel weghalen of rij aanmaken.'); return; }
      m = /^supabase:secondbrain\/knoop_vertaling#(.+)$/.exec(s);
      if (m) { const ids = vert[m[1]]; if (!ids || ids.indexOf(id) < 0) bev('BB1', id + '-' + kortHash(s), 'vertaalsleutel op de pagina van ' + id + ' bestaat niet', p.pad + ': ' + s + '. Voorstel: vertaling laden (laad.py) of sleutel weghalen.'); return; }
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
    else if (!hk.vraag_id && ['pagina', 'migratie-0002'].indexOf(hk.bron) < 0) bev('BB7', h.knoop + '-herkomst-' + h.id, 'kenmerk van ' + h.knoop + ' met onbekende herkomst', 'rij ' + h.id + '. Voorstel: nagaan wie schreef.');
  });
  // diffreview #1: een pagina die de databank blijvend weigert, mag niet stil als "verouderd" blijven staan
  (compileerFouten || []).forEach(function (cf) {
    if (/^databank: /.test(cf.fout)) bev('BB6', 'compileer-' + kortHash(cf.pad), 'pagina niet gecompileerd: ' + String(cf.fout).slice(10, 120), cf.pad + ': ' + cf.fout + '. Voorstel: pagina herstellen (Socev) of de machinekamer laat de databankfunctie nalopen.');
  });
  const uniek = {}; b.forEach(function (x) { uniek[x.bevinding_id] = x; });
  return { bevindingen: Object.keys(uniek).sort().map(function (k) { return uniek[k]; }), tel: tel };
}

// ── de module ──
// Map lezen zonder een symlink als map of bestand te zien (Dirent kijkt niet door een link).
function lijstMapVan(vault) {
  return function (rel) {
    return fs.readdirSync(path.join(vault, rel), { withFileTypes: true }).map(function (d) { return { naam: d.name, map: d.isDirectory(), bestand: d.isFile() }; });
  };
}
function maak(o) {
  const vault = o.vault, nu = o.nu || Date.now, log = o.log || function () {};
  o.lijst = o.lijst || lijstMapVan(vault);
  function vind() {
    const uit = [];
    function lijstMap(rel) { try { return o.lijst(rel); } catch (e) { return []; } }
    lijstMap('10_Zakelijk').forEach(function (m) {
      if (!m.map || m.naam.startsWith('.')) return;
      if (m.naam === '_Gedeeld') { lijstMap('10_Zakelijk/_Gedeeld/Relaties').forEach(function (x) { if (x.bestand && x.naam.endsWith('.md')) uit.push('10_Zakelijk/_Gedeeld/Relaties/' + x.naam); }); return; }
      lijstMap('10_Zakelijk/' + m.naam).forEach(function (x) { if (x.bestand && /^Entiteit - .+\.md$/.test(x.naam)) uit.push('10_Zakelijk/' + m.naam + '/' + x.naam); });
    });
    lijstMap('20_Prive').forEach(function (x) { if (x.bestand && /^Entiteit - .+\.md$/.test(x.naam)) uit.push('20_Prive/' + x.naam); });
    lijstMap('20_Prive/Relaties').forEach(function (x) { if (x.bestand && x.naam.endsWith('.md')) uit.push('20_Prive/Relaties/' + x.naam); });
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
    const paginas = leesAlles(), uit = { modus: modus, paginas: paginas.length, gestuurd: 0, nieuw: 0, fouten: [], voorstellen: 0, ingetrokken: 0, kritiek: 0, blokken: 0, overgeslagen: 0 };
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
      for (const id of Object.keys(perId)) {
        const k = k2[id]; if (!k) continue;
        const p = perId[id].find(function (x) { return x.pad === k.vault_pagina; });
        if (!p || k.bron_sha !== p.sha) continue;
        const blok = blokTekst(k, h2[id] || [], c2[id] || []);
        if (huidigBlok(p.tekst) === blok) continue;
        if (opties.droog) { uit.blokken++; continue; }
        try {
          // opnieuw lezen vlak voor het schrijven: alleen als de inhoud (zonder blok) niet veranderde
          const vers = o.lees(path.join(vault, p.pad));
          const va = vingerafdruk(vers);
          if (va.sha !== p.sha) { uit.fouten.push({ pad: p.pad, fout: 'pagina veranderde tijdens de ronde; blok volgende nacht' }); continue; }
          o.schrijf(path.join(vault, p.pad), zetBlok(vers, blok));
          uit.blokken++;
        } catch (e) { uit.fouten.push({ pad: p.pad, fout: 'blok schrijven: ' + String(e && e.code || e && e.message || e).slice(0, 80) }); }
      }
    }
    uit.ms = nu() - t0;
    log('ovis-compileer ' + JSON.stringify({ modus: modus, paginas: uit.paginas, gestuurd: uit.gestuurd, nieuw: uit.nieuw, fouten: uit.fouten.length, blokken: uit.blokken }));
    return uit;
  }
  // Bibliothecaris: leest, vergelijkt, schrijft bevindingen (BB), stempelt (niet op afroep). opties.sinds = log sinds (ISO).
  async function bibliothecaris(opties) {
    opties = opties || {};
    const c = await compileer('afroep', { droog: !!opties.droog });   // diffreview #1: eerst bijwerken (alleen databank), fouten worden BB6
    const reg = await register(opties.sinds || new Date(nu() - 36 * 3600000).toISOString());
    const paginas = leesAlles();
    const r = checks(paginas, reg, c.fouten);
    const open = {}; (reg.bevindingen || []).forEach(function (x) { open[x.bevinding_id] = x; });
    const nu_ = new Date(nu()).toISOString();
    const rijen = [], nieuw = [];
    r.bevindingen.forEach(function (x) {
      if (open[x.bevinding_id]) rijen.push({ bevinding_id: x.bevinding_id, laatst_gezien: nu_, samenvatting: x.samenvatting, detail: x.detail, ernst: x.ernst });
      else { rijen.push(Object.assign({ soort: 'bibliothecaris', laag: 'A', status: 'open', eerst_gezien: nu_, laatst_gezien: nu_ }, x)); nieuw.push(x); }
    });
    const gezien = new Set(r.bevindingen.map(function (x) { return x.bevinding_id; }));
    // BB7-spoor blijft open tot iemand hem afhandelt: het logvenster schuift door, de wijziging is niet weg (Fable wv979 #8)
    const opgelost = Object.keys(open).filter(function (id) { return !gezien.has(id) && !/^BB7-.*-spoor-\d{8}$/.test(id); });
    opgelost.forEach(function (id) { rijen.push({ bevinding_id: id, status: 'opgelost', laatst_gezien: nu_, detail_erbij: ' | ' + nu_.slice(0, 10) + ': niet meer gezien door de Bibliothecaris' }); });
    if (!opties.droog) for (let i = 0; i < rijen.length; i += 100) await o.sbRpc('ovis_bibliothecaris_zet', { p_rijen: rijen.slice(i, i + 100) });
    const onverklaard = r.bevindingen.length;
    const zin = onverklaard ? onverklaard + ' verschil(len) tussen pagina\'s en register (' + nieuw.length + ' nieuw, ' + opgelost.length + ' opgelost)'
      : 'register en pagina\'s gelijk (' + r.tel.geldig + ' pagina\'s' + (r.tel.verouderd ? ', ' + r.tel.verouderd + ' nog niet gecompileerd' : '') + (r.tel.wacht_op_ja ? ', ' + r.tel.wacht_op_ja + (r.tel.wacht_op_ja === 1 ? ' kenmerk wacht' : ' kenmerken wachten') + ' op Davids Ja' : '') + ')';
    const uit = { uitkomst: onverklaard ? 'bevindingen' : 'ok', zin: zin, tel: r.tel, open: onverklaard, nieuw: nieuw.length, opgelost: opgelost.length,
      per_check: r.bevindingen.reduce(function (a, x) { a[x.check_id] = (a[x.check_id] || 0) + 1; return a; }, {}), bevindingen: r.bevindingen, nieuwe: nieuw };
    if (!opties.droog && !opties.afroep) {
      await o.sbRpc('mk_hartslag_stempel', { p_component: 'bibliothecaris', p_gemeten_rijen: r.tel.paginas, p_bevindingen: onverklaard });
      uit.gestempeld = true;
    }
    log('ovis-bibliothecaris ' + JSON.stringify({ open: onverklaard, nieuw: nieuw.length, opgelost: opgelost.length, afroep: !!opties.afroep, droog: !!opties.droog }));
    return uit;
  }
  return { vind: vind, leesAlles: leesAlles, compileer: compileer, bibliothecaris: bibliothecaris, register: register };
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
  zetBlok: zetBlok, huidigBlok: huidigBlok, rpcInvoer: rpcInvoer, handvattenVan: handvattenVan, normHandvat: normHandvat, boxRij: boxRij, slug: slug,
  BLOK_BEGIN: BLOK_BEGIN, BLOK_EIND: BLOK_EIND, SCHRIJVERS_OK: SCHRIJVERS_OK };
