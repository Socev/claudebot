'use strict';
// Brain › Entiteiten & Personen (wv1734, OVIS M5; ontwerplijnen § 7, Intake-bouwplan § 4). Alleen lezen.
// Eén lijst uit het OVIS-register (secondbrain.knoop + knoop_handvat via de bestaande RPC public.ovis_register_lees, de compiler is de
// schrijver), per regel de stampagina (de markdown uit de vault) en het blok "Wat OVIS weet": herkenningskenmerken met hun status,
// facturen uit de Facturen-app (alleen telling en de laatste, nooit alleen-eigenaar-regels) en deadlines van een eigen entiteit.
// Privacygrens (ontwerplijnen § 7, Fable #7 MOET):
//   - geen privépersonen: een persoonsknoop onder 20_Prive komt er nooit in; medewerkers alleen met hun stamregel (geen pagina);
//   - nooit een rekeningnummer: het register-iban-veld gaat niet mee, het gegenereerde blok uit de pagina wordt weggehaald (dat draagt de
//     geaccepteerde rekeningnummers, wv1360) en elk IBAN-achtig stuk tekst op de pagina van een derde wordt gemaskeerd;
//   - geen HR, gezin of gezondheid in Wat OVIS weet: deadlines met personeelswoorden (hr) gaan niet mee;
//   - vaste plek (praktijk-pc): alleen organisaties aan de zakelijke kant (geen 20_Prive, geen PRIVE, geen personen) en zonder facturen.
const path = require('path');
const crypto = require('crypto');

const CACHE_MS = 60000;
const PAGINA_RE = /^(10_Zakelijk|20_Prive)\/(?:[^/\0]+\/)*[^/\0]+\.md$/;
const IBAN_IN_TEKST = /\b[A-Z]{2}[0-9]{2}(?:[\s.\-\u00a0]?[A-Z0-9]{4}){2,7}(?:[\s.\-\u00a0]?[A-Z0-9]{1,4})?\b/gi;   // diffreview ZOU 6: ook kleine letters, punt, streep
const BLOK_RE = /<!-- ovis:blok begin[^>]*-->[\s\S]*?<!-- ovis:blok eind -->\n?/g;
const MAX_TEKST = 60000;

// rol → groep in het filter (ontwerplijnen § 7: eigen · leverancier · instantie · praktijk · persoon)
const GROEP = { eigen: 'eigen', leverancier: 'leverancier', instantie: 'instantie', bank: 'instantie', verzekeraar: 'instantie',
  praktijk: 'praktijk', zorgpartner: 'praktijk', afzender: 'afzender', persoon: 'persoon' };
const ROL_WOORD = { eigen: 'eigen entiteit', leverancier: 'leverancier', instantie: 'instantie', bank: 'bank', verzekeraar: 'verzekeraar',
  praktijk: 'praktijk', zorgpartner: 'zorgpartner', afzender: 'afzender', persoon: 'persoon' };
const HANDVAT_WOORD = { kvk: 'KvK', domein: 'domein', mail: 'mailadres', kenmerkpatroon: 'kenmerkpatroon', alias: 'ook bekend als',
  'niet-dezelfde-als': 'niet dezelfde als', telefoon: 'telefoonnummer', whatsapp: 'WhatsApp', signal: 'Signal', google: 'Google-contact' };   // wv1011
const STATUS_WOORD = { actief: 'actief', voorgesteld: 'wacht op je Ja', vervallen: 'vervallen' };

// Sleutel voor de detailroute: de pod staat alleen /app/[a-z0-9/-]{1,64} toe en een knoop-id draagt hoofdletters en ':' (tot 57 tekens)
function sleutelVan(id) { return crypto.createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 12); }
function isPersoon(k) { return k.soort === 'persoon' || /^per:/.test(String(k.id)); }
function isEigen(k) { return k.rol === 'eigen' || k.soort === 'entiteit'; }
// Privékant: pagina of vault_pad onder 20_Prive, de entiteit PRIVE zelf, of alleen voor PRIVE (diffreview ZOU 7)
function priveKant(k) {
  const voor = Array.isArray(k.voor) ? k.voor : [];
  return String(k.vault_pagina || '').indexOf('20_Prive/') === 0 || String(k.vault_pad || '').indexOf('20_Prive/') === 0 || k.id === 'PRIVE' ||
    (voor.length > 0 && voor.every(function (c) { return c === 'PRIVE'; }));
}
// Medewerker (of ander personeel): alleen de stamregel (diffreview MOET 3)
function medewerker(k) { return /\/(Medewerkers|Personeel|Personen)\//.test(String(k.vault_pagina || '') + ' ' + String(k.vault_pad || '')); }
// Wie er nooit in komt, ook niet op de telefoon: elke persoon die niet aantoonbaar zakelijk is. Witte lijst (diffreview MOET 2): een
// persoonsknoop alleen met een pagina onder 10_Zakelijk/ en niet aan de privékant.
function nooit(k) { return isPersoon(k) && (String(k.vault_pagina || '').indexOf('10_Zakelijk/') !== 0 || priveKant(k)); }
// Op een vaste plek alleen organisaties aan de zakelijke kant
function zichtbaar(k, vast) {
  if (!k || k.actief === false || nooit(k)) return false;
  if (vast && (isPersoon(k) || priveKant(k))) return false;
  return true;
}
function groepVan(k) { return isPersoon(k) ? 'persoon' : (GROEP[k.rol] || (isEigen(k) ? 'eigen' : 'leverancier')); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function ibanNorm(x) { return String(x || '').replace(/[\s.\-\u00a0]/g, '').toUpperCase(); }
// eigen: het eigen rekeningnummer van een eigen entiteit blijft staan, elk ander wordt gemaskeerd (diffreview ZOU 5)
function maskeerIban(t, eigen) {
  return String(t).replace(IBAN_IN_TEKST, function (m) {
    const n = ibanNorm(m);
    if (!/\d{6}/.test(n)) return m;
    return eigen && ibanNorm(eigen) === n ? m : '[rekeningnummer]';
  });
}

// Stampagina: frontmatter eraf (de stamgegevens komen uit het register), het gegenereerde blok eraf (rekeningnummers; Wat OVIS weet
// komt hier vers uit de databank), wikilinks als gewone tekst, elk IBAN gemaskeerd behalve het eigen nummer van een eigen entiteit
// (eigenIban: k.iban van een knoop met rol eigen, anders null).
function paginaTekst(ruw, eigenIban) {
  let t = String(ruw).replace(/\r\n?/g, '\n');
  if (t.indexOf('---\n') === 0) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1 || t.length); }
  t = t.replace(BLOK_RE, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, function (m, p) { return String(p).split('/').pop().replace(/\.md$/, ''); });
  t = maskeerIban(t, eigenIban || null);
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEKST ? t.slice(0, MAX_TEKST) + '\n\n…' : t;
}

function leesSqlite(pad, sql, args) {
  const fs = require('fs');
  if (!pad || !fs.existsSync(pad)) return null;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(pad, { readOnly: true });
  try { db.exec('PRAGMA busy_timeout = 2000;'); return db.prepare(sql).all(...(args || [])); }
  finally { try { db.close(); } catch (e) { /* al dicht */ } }
}

function maak(o) {
  const rpc = o.rpc, lees = o.lees, vault = o.vault, facturenPad = o.facturenPad || null;
  const deadlines = typeof o.deadlines === 'function' ? o.deadlines : function () { return null; };
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  let cache = null;

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
  // naam/alias-match (zelfde regel als rekeningenPerDoel in ovis-register.js); een eigen entiteit telt de facturen op haar naam. Alleen
  // telling, datum, bedrag (in centen, zoals in de Facturen-app) en status: geen leveranciersnaam (bij een eigen entiteit kan dat een persoon zijn), geen regels met een
  // patiëntkenmerk. Alleen-eigenaar-regels tellen mee: de app is van David (de eigenaar); op een vaste plek komt dit blok er niet.
  function facturenVan(k, reg) {
    const ENT = { TG: 'tolgaarde', GH: 'groenhouten', HOLD: 'holding', KM: 'kostenmaatschap', POT: 'pot', PHBV: 'praktijkhouders_bv', PRIVE: 'prive', SLOEL: 'sloel',
      HAGRO: 'hagro', SEL: 'sel', DBH: 'dbh', GHAWA: 'ghawa' };
    let rijen = [];
    try {
      if (isEigen(k)) {
        const e = ENT[String(k.id).toUpperCase()];
        if (!e) return { aantal: 0, laatste: [] };
        const a = leesSqlite(facturenPad, 'select factuurdatum, incl_eur as bedrag, status from factuur where lower(entiteit) = ? and coalesce(patientkenmerk,0) = 0 and coalesce(intern,0) = 0', [e]);
        if (a === null) return null;
        rijen = a.concat(leesSqlite(facturenPad, 'select factuurdatum, incl as bedrag, status from factuur_archief where lower(entiteit) = ?', [e]) || []);
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
        if (ids.length) rijen = leesSqlite(facturenPad, 'select factuurdatum, incl_eur as bedrag, status from factuur where leverancier in (' + ids.map(function () { return '?'; }).join(',') + ') and coalesce(patientkenmerk,0) = 0', ids) || [];
        const arch = leesSqlite(facturenPad, 'select leverancier_naam, factuurdatum, incl as bedrag, status from factuur_archief', []) || [];
        rijen = rijen.concat(arch.filter(function (f) { return hoort(f.leverancier_naam); }));
      }
    } catch (e) { return null; }
    rijen.sort(function (x, y) { return String(y.factuurdatum || '').localeCompare(String(x.factuurdatum || '')); });
    return { aantal: rijen.length, laatste: rijen.slice(0, 5).map(function (f) {
      return { datum: f.factuurdatum || null, bedrag_cent: typeof f.bedrag === 'number' ? Math.round(f.bedrag) : null, status: f.status || null };
    }) };
  }

  function deadlinesVan(k) {
    if (!isEigen(k) || priveKant(k)) return null;   // diffreview MOET 1: privé (gezin, familie) nooit in Wat OVIS weet
    let d;
    try { d = deadlines(); } catch (e) { return null; }
    if (!Array.isArray(d)) return null;
    return d.filter(function (x) { return !x.hr && Array.isArray(x.ents) && x.ents.indexOf(String(k.id)) >= 0 && x.dagen >= -7 && x.dagen <= 400; })
      .sort(function (a, b) { return a.dagen - b.dagen; }).slice(0, 8)
      .map(function (x) { return { datum: x.datum, dagen: x.dagen, titel: String(x.titel || '').slice(0, 160) }; });
  }

  async function lijst(vast) {
    const reg = await register();
    const uit = reg.knopen.filter(function (k) { return zichtbaar(k, vast); }).map(function (k) {
      return { id: k.id, sleutel: sleutelVan(k.id), naam: k.naam, groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.filter(function (c) { return !(vast && c === 'PRIVE'); }) : [],
        aliassen: (k.aliassen || []).slice(0, 5), prive: priveKant(k), pagina: !!k.vault_pagina, handvatten: (reg.handvatten[k.id] || []).length };
    }).sort(function (a, b) { return (a.groep === 'eigen' ? 0 : 1) - (b.groep === 'eigen' ? 0 : 1) || a.naam.localeCompare(b.naam, 'nl'); });
    const groepen = {};
    uit.forEach(function (k) { groepen[k.groep] = (groepen[k.groep] || 0) + 1; });
    return { ok: true, vaste_plek: !!vast, knopen: uit, groepen: groepen, totaal: uit.length, gemeten_op: new Date(nu()).toISOString() };
  }

  // detail op knoop-id of op de sleutel uit de lijst (12 hex)
  async function detail(id, vast) {
    const reg = await register();
    const k = reg.knopen.find(function (x) { return x.id === id; }) || (/^[0-9a-f]{12}$/.test(String(id)) ? reg.knopen.find(function (x) { return sleutelVan(x.id) === id; }) : undefined);
    if (!k || !zichtbaar(k, vast)) return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
    const eigen = isEigen(k), stam = isPersoon(k) && medewerker(k);
    let tekst = null, paginaFout = null;
    const rel = String(k.vault_pagina || '');
    if (stam) paginaFout = 'Van medewerkers staat hier alleen de stamregel.';
    else if (!PAGINA_RE.test(rel) || rel.split('/').indexOf('..') >= 0) paginaFout = 'Geen stampagina in het register.';
    else {
      try { tekst = paginaTekst(lees(path.join(vault, rel)), eigen ? k.iban : null); }
      catch (e) { paginaFout = 'De pagina is nu niet te lezen.'; }
    }
    const h = stam ? [] : (reg.handvatten[k.id] || []).map(function (x) {
      return { soort: HANDVAT_WOORD[x.soort] || x.soort, waarde: maskeerIban(String(x.waarde)).slice(0, x.soort === 'kenmerkpatroon' ? 60 : 120),
        status: STATUS_WOORD[x.status] || x.status, intrekking: !!x.intrekking };
    });
    const weet = { handvatten: h,
      kvk: stam ? null : (k.kvk || null), agb: eigen ? (k.agb || null) : null,
      facturen: vast || stam ? null : facturenVan(k, reg),
      deadlines: vast || stam ? null : deadlinesVan(k),
      stukken: null,   // komt met OVIS Intake (stap 2); nu nog geen logboek per partij
      register: { concept: !!k.concept, compilatie: k.compilatienummer || null, gecompileerd_op: k.gecompileerd_op || null } };
    return { status: 200, j: { ok: true, vaste_plek: !!vast,
      knoop: { id: k.id, naam: k.naam, groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.filter(function (c) { return !(vast && c === 'PRIVE'); }) : [], aliassen: k.aliassen || [], prive: priveKant(k),
        pagina_pad: paginaFout ? null : rel, opmerking: !stam && k.opmerking ? maskeerIban(String(k.opmerking)).slice(0, 400) : null },
      tekst: tekst, pagina_fout: paginaFout, weet: weet } };
  }

  return { lijst: lijst, detail: detail, vergeet: function () { cache = null; } };
}

module.exports = { maak: maak, sleutelVan: sleutelVan, paginaTekst: paginaTekst, maskeerIban: maskeerIban, zichtbaar: zichtbaar, groepVan: groepVan, nooit: nooit };
