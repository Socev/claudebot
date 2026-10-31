'use strict';
// Brain › Entiteiten & Personen (wv1734, OVIS M5; ontwerplijnen § 7, Intake-bouwplan § 4). Alleen lezen.
// Eén lijst uit het OVIS-register (secondbrain.knoop + knoop_handvat via de bestaande RPC public.ovis_register_lees, de compiler is de
// schrijver), per regel de pagina (de markdown uit de vault) en het blok "Wat OVIS weet": herkenningskenmerken met hun status, facturen
// uit de Facturen-app (alleen telling en de laatste), deadlines en per persoon het Dossier (bestanden die bij die persoon horen).
// wv1930 (bouwplan "Geen afscherming naar David", 29-10-2026, stap A; David 28-10 18:02 "Je moet NIETS voor mij afschermen. Ik ben de
// enige gebruiker hier."): alles voor David, niets naar derden. Dus: medewerkers met hun hele pagina, kenmerken, deadlines (ook HR) en
// Dossier; privépersonen uit 20_Prive (Familie, Gambia/Personen, Shizzle, Relaties) rechtstreeks uit de vault in de groep "prive", zonder
// registerwijziging; de stamboom (± 1080 pagina's) alleen als zoekresultaat; rekeningnummers onverkort en het gegenereerde blok op de
// pagina; Wat OVIS weet ook aan de privékant. Wat blijft: het sleutelmasker (grondwet 2) op alle tekst, en de schakelaar voor een vaste
// plek (APP_VAST_AFSCHERMEN, wv1901): staat die aan, dan op dat apparaat alleen organisaties aan de zakelijke kant, rekeningnummers van
// derden gemaskeerd, zonder facturen, deadlines en Dossier.
// wv1771 (OVIS plek 7 fase B): bij een persoon met een Google-koppeling de mailadressen en telefoonnummers uit dat Google-contact
// (RPC public.ovis_personen_lees). wv1948 (stap C, E6): ook adressen en verjaardag (migratie knoop/0006), en ook bij een koppeling die nog
// op Davids Ja wacht — met voorgesteld: true, zodat de app het zo labelt. Dat is tonen aan David, geen kenmerk: de mailrouter gebruikt
// de koppeling pas na zijn Ja.
const path = require('path');
const crypto = require('crypto');

const CACHE_MS = 60000;
const PAGINA_RE = /^(10_Zakelijk|20_Prive)\/(?:[^/\0]+\/)*[^/\0]+\.md$/;
const IBAN_IN_TEKST = /\b[A-Z]{2}[0-9]{2}(?:[\s.\-\u00a0]?[A-Z0-9]{4}){2,7}(?:[\s.\-\u00a0]?[A-Z0-9]{1,4})?\b/gi;   // diffreview ZOU 6: ook kleine letters, punt, streep
const BLOK_RE = /<!-- ovis:blok begin[^>]*-->[\s\S]*?<!-- ovis:blok eind -->\n?/g;
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
// wv1930: elke actieve knoop is zichtbaar. Alleen met de schakelaar voor een vaste plek aan (wv1901) daar alleen organisaties aan de
// zakelijke kant.
function zichtbaar(k, vast) {
  if (!k || k.actief === false) return false;
  if (vast && (isPersoon(k) || priveKant(k))) return false;
  return true;
}
function groepVan(k) { return isPersoon(k) ? 'persoon' : (GROEP[k.rol] || (isEigen(k) ? 'eigen' : 'leverancier')); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
// Woorden voor naamvergelijking: zonder accenten, kleine letters, alles wat geen letter of cijfer is een spatie ("K. Verzonnen" → "k verzonnen")
function woorden(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function ibanNorm(x) { return String(x || '').replace(/[\s.\- ]/g, '').toUpperCase(); }
// Alleen met de vaste-plekschakelaar aan: het eigen rekeningnummer van een eigen entiteit blijft staan, elk ander wordt gemaskeerd
function maskeerIban(t, eigen) {
  return String(t).replace(IBAN_IN_TEKST, function (m) {
    const n = ibanNorm(m);
    if (!/\d{6}/.test(n)) return m;
    return eigen && ibanNorm(eigen) === n ? m : '[rekeningnummer]';
  });
}
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
// wv1930), wikilinks als gewone tekst, het sleutelmasker erover. Alleen met de vaste-plekschakelaar aan: het blok helemaal weg en elk
// IBAN gemaskeerd behalve het eigen nummer van een eigen entiteit (opties.eigenIban).
function paginaTekst(ruw, opties) {
  const o = opties && typeof opties === 'object' ? opties : { vast: true, eigenIban: opties || null };   // oude aanroep (ruw, eigenIban)
  const masker = typeof o.masker === 'function' ? o.masker : geenMasker;
  let t = String(ruw).replace(/\r\n?/g, '\n');
  if (t.indexOf('---\n') === 0) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1 || t.length); }
  t = o.vast ? t.replace(BLOK_RE, '') : t.replace(/<!-- ovis:blok (?:begin|eind)[^>]*-->\n?/g, '');
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, function (m, p) { return String(p).split('/').pop().replace(/\.md$/, ''); });
  if (o.vast) t = maskeerIban(t, o.eigenIban || null);
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

function maak(o) {
  const rpc = o.rpc, lees = o.lees, vault = o.vault, facturenPad = o.facturenPad || null;
  const deadlines = typeof o.deadlines === 'function' ? o.deadlines : function () { return null; };
  const nu = typeof o.nu === 'function' ? o.nu : Date.now;
  const masker = typeof o.masker === 'function' ? o.masker : geenMasker;   // sleutelmasker (grondwet 2), op alle tekst
  const kaart = typeof o.kaart === 'function' ? o.kaart : function () { return null; };   // [{p, s, m}] uit de Second Brain-kaart
  let cache = null, priveCache = null;

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
      .map(function (x) { return { datum: x.datum, dagen: x.dagen, titel: masker(String(x.titel || '').slice(0, 160)), hr: !!x.hr }; });
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

  async function lijst(vast) {
    const reg = await register();
    const uit = reg.knopen.filter(function (k) { return zichtbaar(k, vast); }).map(function (k) {
      return { id: k.id, sleutel: sleutelVan(k.id), naam: masker(k.naam), groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.filter(function (c) { return !(vast && c === 'PRIVE'); }) : [],
        aliassen: (k.aliassen || []).slice(0, 5).map(masker), prive: priveKant(k), pagina: !!k.vault_pagina, handvatten: (reg.handvatten[k.id] || []).length, register: true };
    });
    let stamboom = 0, priveFout = null;
    if (!vast) {
      const pv = prive();
      const metKnoop = new Set(reg.knopen.filter(function (k) { return k.actief !== false; }).map(function (k) { return String(k.vault_pagina || ''); }));   // review ZOU 7
      pv.personen.forEach(function (x) { if (!metKnoop.has(x.pad)) uit.push(priveRegel(x)); });
      stamboom = pv.stamboom.length; priveFout = pv.fout;
    }
    uit.sort(function (a, b) { return (a.groep === 'eigen' ? 0 : 1) - (b.groep === 'eigen' ? 0 : 1) || a.naam.localeCompare(b.naam, 'nl'); });
    const groepen = {};
    uit.forEach(function (k) { groepen[k.groep] = (groepen[k.groep] || 0) + 1; });
    return { ok: true, vaste_plek: !!vast, knopen: uit, groepen: groepen, totaal: uit.length, stamboom: stamboom, prive_fout: priveFout, gemeten_op: new Date(nu()).toISOString() };
  }

  // Zoeken in de stamboom (wv1930): q = woorden zonder accenten (de app stuurt a-z, 0-9 en -), ten minste 2 tekens; treffers op naam
  async function zoek(q, vast) {
    const w = woorden(String(q || '').replace(/-/g, ' '));
    if (vast || w.replace(/ /g, '').length < 2) return { ok: true, q: w, knopen: [], totaal: 0 };
    const pv = prive();
    const hit = pv.stamboom.filter(function (x) { return woorden(x.naam).indexOf(w) >= 0 || norm(x.naam).indexOf(w.replace(/ /g, '')) >= 0; })
      .sort(function (a, b) { return a.naam.localeCompare(b.naam, 'nl'); });
    return { ok: true, q: w, knopen: hit.slice(0, ZOEK_MAX).map(priveRegel), totaal: hit.length };
  }

  // wv2077 (David 31-10: "als ik een naam of entiteit zoek, moet de Entiteitspagina bovenaan staan"): voor Brain › Zoeken de partijen
  // waarvan de naam, een alias (register, handvat of pagina) of de paginanaam past, met hun vaultpad. Alleen hele woorden of het begin van
  // een woord ("Abel" past niet in "Allekabels"). sterk: 0 = precies de naam, 1 = alle woorden als heel woord, 2 = begin van een woord.
  // Zelfde grens als de lijst (zichtbaar, privé alleen zonder vaste plek); secondbrain.js toetst elk pad daarna nog aan de kaart.
  async function naamTreffers(q, vast) {
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
      if (k.actief === false || !zichtbaar(k, vast) || !PAGINA_RE.test(rel) || rel.split('/').indexOf('..') >= 0) return;
      const namen = [k.naam, stam(rel)].concat(k.aliassen || []).concat((reg.handvatten[k.id] || []).filter(function (h) { return h.soort === 'alias'; }).map(function (h) { return h.waarde; }));
      const s = sterkVan(namen);
      if (s < 9) uit.push({ pad: rel, naam: masker(k.naam), soort: ROL_WOORD[k.rol] || (isPersoon(k) ? 'persoon' : null), sleutel: sleutelVan(k.id), sterk: s, r: isEigen(k) ? 0 : 1 });
    });
    if (!vast) {
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
  function priveDetail(x) {
    let tekst = null, paginaFout = null, ruw = '';
    try { ruw = lees(path.join(vault, x.pad)); tekst = paginaTekst(ruw, { masker: masker }); }
    catch (e) { paginaFout = 'De pagina is nu niet te lezen.'; }
    const fm = frontmatter(ruw);
    const aliassen = x.aliassen.length ? x.aliassen : fmAliassen(fm);
    const pat = naamPatronen([x.naam, stamVan(x.pad), fmVeld(fm, 'onderwerp')].concat(aliassen));
    const r = priveRegel(Object.assign({}, x, { aliassen: aliassen }));
    return { status: 200, j: { ok: true, vaste_plek: false,
      knoop: { id: r.id, naam: r.naam, groep: 'prive', rol: x.rol, concept: false, voor: ['PRIVE'], aliassen: aliassen.map(masker), prive: true,
        pagina_pad: paginaFout ? null : x.pad, opmerking: null, register: false },
      tekst: tekst, pagina_fout: paginaFout,
      weet: { handvatten: [], kvk: null, agb: null, iban: null, facturen: null, deadlines: deadlinesVan(null, { pagina: x.pad, patronen: pat }),
        contact: null, stukken: null, register: LEEG_REGISTER, in_register: false },
      dossier: dossierVan(x.pad, pat) } };
  }

  // detail op knoop-id, op de sleutel uit de lijst (12 hex) of op de sleutel van een privépersoon
  async function detail(id, vast) {
    const reg = await register();
    const isSl = /^[0-9a-f]{12}$/.test(String(id));
    const k = reg.knopen.find(function (x) { return x.id === id; }) || (isSl ? reg.knopen.find(function (x) { return sleutelVan(x.id) === id; }) : undefined);
    if (!k) {
      if (!vast && isSl) {
        const pv = prive();
        const x = pv.personen.concat(pv.stamboom).find(function (y) { return sleutelVan(y.pad) === id; });
        if (x) return priveDetail(x);
      }
      return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
    }
    if (!zichtbaar(k, vast)) return { status: 404, j: { ok: false, fout: 'niet gevonden' } };
    const eigen = isEigen(k), persoon = isPersoon(k);
    let tekst = null, paginaFout = null, ruw = '';
    const rel = String(k.vault_pagina || '');
    if (!PAGINA_RE.test(rel) || rel.split('/').indexOf('..') >= 0) paginaFout = 'Geen pagina in het register.';
    else {
      try { ruw = lees(path.join(vault, rel)); tekst = paginaTekst(ruw, { vast: vast, eigenIban: eigen ? k.iban : null, masker: masker }); }
      catch (e) { paginaFout = 'De pagina is nu niet te lezen.'; }
    }
    const ib = vast ? maskeerIban : geenMasker;
    const h = (reg.handvatten[k.id] || []).map(function (x) {
      return { soort: HANDVAT_WOORD[x.soort] || x.soort, waarde: masker(ib(String(x.waarde))).slice(0, x.soort === 'kenmerkpatroon' ? 60 : 120),
        status: STATUS_WOORD[x.status] || x.status, intrekking: !!x.intrekking };
    });
    const fm = frontmatter(ruw);
    const aliassen = (k.aliassen || []).concat(fmAliassen(fm)).concat((reg.handvatten[k.id] || []).filter(function (x) { return x.soort === 'alias'; }).map(function (x) { return x.waarde; }));
    const pat = persoon ? naamPatronen([k.naam, rel ? stamVan(rel) : ''].concat(aliassen)) : [];
    const weet = { handvatten: h,
      kvk: k.kvk ? masker(String(k.kvk)) : null, agb: k.agb ? masker(String(k.agb)) : null,
      iban: vast || !k.iban ? null : masker(String(k.iban)),
      facturen: vast ? null : facturenVan(k, reg),
      deadlines: vast ? null : deadlinesVan(k, persoon ? { pagina: rel, patronen: pat } : null),
      contact: vast || !persoon ? null : await googleVan(k, reg),   // wv1771
      stukken: null,   // komt met OVIS Intake (stap 2); nu nog geen logboek per partij
      register: { concept: !!k.concept, compilatie: k.compilatienummer || null, gecompileerd_op: k.gecompileerd_op || null }, in_register: true };
    return { status: 200, j: { ok: true, vaste_plek: !!vast,
      knoop: { id: k.id, naam: masker(k.naam), groep: groepVan(k), rol: ROL_WOORD[k.rol] || k.rol || null, concept: !!k.concept,
        voor: Array.isArray(k.voor) ? k.voor.filter(function (c) { return !(vast && c === 'PRIVE'); }) : [], aliassen: (k.aliassen || []).map(masker), prive: priveKant(k),
        pagina_pad: paginaFout ? null : rel, opmerking: k.opmerking ? masker(ib(String(k.opmerking))).slice(0, 400) : null, register: true },
      tekst: tekst, pagina_fout: paginaFout, weet: weet,
      dossier: vast || !persoon ? null : dossierVan(rel, pat, (Array.isArray(k.voor) ? k.voor : []).map(function (c) {
        const e = reg.knopen.find(function (x) { return x.id === c && isEigen(x); });
        return e ? wortelVan(e.vault_pagina) : null;
      })) } };
  }

  return { lijst: lijst, zoek: zoek, detail: detail, naamTreffers: naamTreffers, vergeet: function () { cache = null; priveCache = null; } };
}

module.exports = { telNl: telNl, maak: maak, sleutelVan: sleutelVan, paginaTekst: paginaTekst, maskeerIban: maskeerIban, zichtbaar: zichtbaar, groepVan: groepVan,
  naamPatronen: naamPatronen, bevatNaam: bevatNaam, fmAliassen: fmAliassen };
