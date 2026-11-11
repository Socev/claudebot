'use strict';
/**
 * voorwerk-lees.js — het leesluik van OVIS Mail voorwerk-2 (wv2916, 11-11-2026). Twee rollen in één bestand:
 * 1. maakLuik(io, o) — in server.js: één luik per onderzoeksrun. Elke tool-aanroep komt hier langs: grenzen per stuk en per run,
 *    verboden vaultmappen, patiëntpoort op ELK antwoord (tegenhouden of een fout in de poort = het stuk komt niet terug, nooit
 *    gedeeltelijk; review 1 MOET 2), run-log (soort + verwijzing, geen tekst) en de teksten in het geheugen voor het bronbewijs
 *    (voorwerk-poort.js). Na de run gooit server.js het luik weg.
 * 2. Als hoofdprogramma (node voorwerk-lees.js): de stdio-MCP-server die claude -p start. Hij kent alleen de toolnamen en stuurt
 *    elke aanroep door naar de pod op 127.0.0.1 met een kort levend runtoken (VOORWERK_LUIK_URL/-TOKEN in zijn mcp-config). Geen
 *    sleutels, geen vault, geen netwerk buiten die ene URL.
 * Ontwerp: vault "01_Ontwikkeling/Mail-laag stap 4b - voorwerk-2, uitgezocht antwoord (ontwerp 11-11-2026).md" § Gereedschap.
 * Gemeten 11-11 (claude 2.1.322): --restricted --strict-mcp-config --mcp-config <dit> --tools "" --allowedTools mcp__voorwerk geeft het
 * model alleen deze tools; zonder --allowedTools worden ze geweigerd (permission_denials).
 */

// 30_Conversaties: WhatsApp/Signal/Teams van derden niet in versie 1 (ontwerp; review Fable ZOU 3)
const VERBODEN = ['20_Prive/Gezondheid', '20_Prive/Gambia', '20_Prive/Relaties', '50_Onderzoek', '00_Systeem/Meldingen', '30_Conversaties'];
const STUK_MAX = 40000, STUKKEN_MAX = 25, LIJSTEN_MAX = 15, AANROEPEN_MAX = 40, ZOEK_MAX = 20, MAIL_MAX = 10, MAIL_DAGEN = 90;
const EXT = /\.(md|txt|docx|pdf)$/i;

const TOOLS = [
  { name: 'vault_zoek', description: 'Zoek in Davids Second Brain (vault) op een term (naam, onderwerp). Geeft een lijst paden; lees een stuk daarna met vault_lees.',
    inputSchema: { type: 'object', properties: { term: { type: 'string', description: 'zoekterm, 3-80 tekens' } }, required: ['term'], additionalProperties: false } },
  { name: 'vault_lees', description: 'Lees één stuk uit de vault (md, txt, docx of pdf als tekst) op het pad uit vault_zoek.',
    inputSchema: { type: 'object', properties: { pad: { type: 'string' } }, required: ['pad'], additionalProperties: false } },
  { name: 'mail_afzender', description: 'Lijst van eerdere mails van en aan de afzender van deze mail (hooguit 90 dagen). Lees er één met mail_lees.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mail_zoek', description: 'Zoek in Davids eigen mail (ook verzonden, hooguit 90 dagen) op een term. Lees er één met mail_lees.',
    inputSchema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'], additionalProperties: false } },
  { name: 'mail_lees', description: 'Lees één mail uit een lijst van mail_afzender of mail_zoek (id uit die lijst).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'agenda', description: 'Afspraken in Davids agenda\'s tussen twee datums (JJJJ-MM-DD, hooguit 31 dagen).',
    inputSchema: { type: 'object', properties: { van: { type: 'string' }, tot: { type: 'string' } }, required: ['van', 'tot'], additionalProperties: false } },
  { name: 'contact', description: 'Zoek een persoon of organisatie in Davids contacten (naam, telefoon, mail).',
    inputSchema: { type: 'object', properties: { naam: { type: 'string' } }, required: ['naam'], additionalProperties: false } },
  { name: 'facturen', description: 'Zakelijke betaalhistorie met een tegenpartij (hoe en hoeveel er betaald wordt).',
    inputSchema: { type: 'object', properties: { tegenpartij: { type: 'string' } }, required: ['tegenpartij'], additionalProperties: false } },
  { name: 'nmbrs', description: 'Medewerker in de salarisadministratie (Nmbrs): functie, uren, schaal/trede, contract- en ingangsdata. Nooit bedragen.',
    inputSchema: { type: 'object', properties: { naam: { type: 'string' } }, required: ['naam'], additionalProperties: false } }
];

function s(x) { return typeof x === 'string' ? x : x == null ? '' : String(x); }
function schoon(x, n) { return s(x).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, n); }
function term(x) { return s(x).replace(/["'():{}\[\]<>\\]/g, ' ').replace(/\s+/g, ' ').trim(); }
function ymd(x) { return /^\d{4}-\d{2}-\d{2}$/.test(s(x)) && Number.isFinite(Date.parse(x + 'T00:00:00Z')) ? s(x) : null; }

// Mag dit vaultpad? → genormaliseerd relatief pad of null. Geen absoluut pad, geen .., geen verborgen map, niet in een verboden map.
function vaultPadOk(p) {
  let r = s(p).trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!r || r.length > 400 || r[0] === '/' || /\u0000/.test(r)) return null;
  const delen = r.split('/');
  if (delen.some(function (d) { return d === '' || d === '.' || d === '..' || d[0] === '.'; })) return null;
  r = delen.join('/');
  if (VERBODEN.some(function (v) { return r === v || r.indexOf(v + '/') === 0; })) return null;
  if (!EXT.test(r)) return null;
  return r;
}
// Persoonsgebonden? Dossierpagina (…/Medewerkers/<naam> - <functie>.md) of een contract met de naam in de bestandsnaam.
function vaultBinding(rel) {
  const naam = rel.split('/').pop().replace(EXT, '');
  const contract = /contract|overeenkomst/i.test(naam);
  const mw = /(^|\/)Medewerkers\/[^/]+$/.test(rel);
  const datum = (/(\d{4}-\d{2}-\d{2})/.exec(naam) || [])[1] || null;
  if (mw) return { soort: contract ? 'contract' : 'dossier', gebonden: contract ? naam : naam.split(' - ')[0].trim(), datum: datum };
  if (contract) return { soort: 'contract', gebonden: naam, datum: datum };
  return { soort: 'vault', gebonden: null, datum: datum };
}

/*
 * io (server.js): vaultZoek(term) → [relpad], vaultLees(relpad) → tekst, mailZoek(query, max) → [{id, van, aan, onderwerp, datum}],
 * mailLees(id) → {van, aan, onderwerp, datum, tekst}, mailSlot(id) → bool, agenda(van, tot) → [{titel, start, einde, agenda}],
 * contact(naam) → [..], facturen(tegenpartij) → obj, nmbrs(naam) → obj, poort(stuk) → { tegenhouden }, nu() → ms.
 * o: { afzender } (adres van de mail waar het voorwerk over gaat)
 */
function maakLuik(io, o) {
  o = o && typeof o === 'object' ? o : {};
  const nu = typeof io.nu === 'function' ? io.nu : Date.now;
  const stukken = new Map(), log = [], mailIds = new Set();
  const tel = { aanroepen: 0, stukken: 0, lijsten: 0, tegengehouden: 0, geweigerd: 0 };
  function poortOk(tekst, label) {
    try { const p = io.poort({ teksten: [tekst], onderwerp: label || '', afzender: '' }); return !!p && p.tegenhouden === false; } catch (e) { return false; }
  }
  // Eén stuk vastleggen en als tekst voor het model teruggeven (of een weigering)
  function stuk(soort, label, tekst, ref, extra) {
    extra = extra || {};
    const lijst = soort === 'lijst';
    if (lijst ? tel.lijsten >= LIJSTEN_MAX : tel.stukken >= STUKKEN_MAX) { tel.geweigerd++; return 'grens: hooguit ' + (lijst ? LIJSTEN_MAX + ' zoeklijsten' : STUKKEN_MAX + ' stukken') + ' per run; ga verder met wat je hebt.'; }
    let t = schoon(tekst, STUK_MAX + 1);
    const afgekapt = t.length > STUK_MAX;
    if (afgekapt) t = t.slice(0, STUK_MAX);
    if (!t.trim()) return 'leeg: ' + label;
    if (!poortOk(t, label)) { tel.tegengehouden++; log.push({ id: null, soort: soort, ref: s(ref).slice(0, 300), tegengehouden: true }); return 'overgeslagen: mogelijk patiëntgegevens (' + label + ')'; }
    if (lijst) tel.lijsten++; else tel.stukken++;
    const id = 'S' + (stukken.size + 1);
    stukken.set(id, { id: id, soort: soort, label: s(label).slice(0, 200), tekst: t, gebonden: extra.gebonden || null, datum: extra.datum || null });
    log.push({ id: id, soort: soort, ref: s(ref).slice(0, 300), gebonden: !!extra.gebonden, tekens: t.length });
    return '[STUK ' + id + ' | soort: ' + soort + ' | vindplaats: ' + label + (extra.gebonden ? ' | persoonsgebonden: ' + extra.gebonden : '') +
      (extra.datum ? ' | datum: ' + extra.datum : '') + (afgekapt ? ' | afgekapt na ' + STUK_MAX + ' tekens' : '') + ']\n[BRONTEKST]\n' + t + '\n[EINDE BRONTEKST]';
  }
  function mailRegels(lijst) {
    // review Fable MOET 5: een slotmail (patiëntmarker, zorgmail, Jev-injectie) komt niet eens met onderwerp in de lijst
    return (Array.isArray(lijst) ? lijst : []).slice(0, MAIL_MAX).filter(function (m) { if (!m || m.id == null) return false; try { return !io.mailSlot(s(m.id).slice(0, 40)); } catch (e) { return false; } }).map(function (m) {
      const id = s(m.id).slice(0, 40);
      mailIds.add(id);
      return '- id ' + id + ' · ' + schoon(m.datum_lokaal || m.datum, 40) + ' · van ' + schoon(m.van, 120) + ' · aan ' + schoon(m.aan, 160) + ' · ' + schoon(m.onderwerp, 160);
    }).join('\n');
  }
  const ACTIES = {
    vault_zoek: async function (a) {
      const t = term(a.term);
      if (t.length < 3 || t.length > 80) return 'term: 3-80 tekens';
      const paden = (await io.vaultZoek(t) || []).map(vaultPadOk).filter(Boolean);
      const uniek = Array.from(new Set(paden)).slice(0, ZOEK_MAX);
      if (!uniek.length) return 'niets gevonden voor "' + t + '"';
      return stuk('lijst', 'zoeklijst vault "' + t + '"', uniek.join('\n'), 'vault_zoek:' + t);
    },
    vault_lees: async function (a) {
      const rel = vaultPadOk(a.pad);
      if (!rel) { tel.geweigerd++; return 'geweigerd: dit pad mag het luik niet lezen'; }
      let tekst;
      try { tekst = await io.vaultLees(rel); } catch (e) { return 'niet te lezen: ' + rel; }
      const b = vaultBinding(rel);
      return stuk(b.soort, rel, tekst, rel, b);
    },
    mail_afzender: async function () {
      const adr = s(o.afzender).trim().toLowerCase();
      if (!/^[^@\s<>",;:()]+@[^@\s<>",;:()]+$/.test(adr)) return 'geen afzender bekend';
      const l = await io.mailZoek('(from:' + adr + ' OR to:' + adr + ') newer_than:' + MAIL_DAGEN + 'd', MAIL_MAX);
      const r = mailRegels(l);
      return r ? stuk('lijst', 'mails van en aan de afzender', r, 'mail_afzender') : 'geen eerdere mails met deze afzender';
    },
    mail_zoek: async function (a) {
      const t = term(a.term).replace(/[-:]/g, ' ').trim();
      if (t.length < 3 || t.length > 80) return 'term: 3-80 tekens';
      const r = mailRegels(await io.mailZoek(t + ' newer_than:' + MAIL_DAGEN + 'd', MAIL_MAX));
      return r ? stuk('lijst', 'mail-zoeklijst "' + t + '"', r, 'mail_zoek:' + t) : 'niets gevonden voor "' + t + '"';
    },
    mail_lees: async function (a) {
      const id = s(a.id).trim();
      if (!mailIds.has(id)) { tel.geweigerd++; return 'geweigerd: alleen een id uit mail_afzender of mail_zoek van deze run'; }
      if (io.mailSlot(id)) { tel.tegengehouden++; log.push({ id: null, soort: 'mail', ref: 'mail:' + id, tegengehouden: true }); return 'overgeslagen: mogelijk patiëntgegevens (slotje)'; }
      const m = await io.mailLees(id);
      if (!m || typeof m.tekst !== 'string') return 'niet te lezen';
      const datum = schoon(m.datum, 40);
      return stuk('mail', 'mail ' + datum + ' · ' + schoon(m.onderwerp, 80), 'Van: ' + schoon(m.van, 200) + '\nAan: ' + schoon(m.aan, 300) + '\nOnderwerp: ' + schoon(m.onderwerp, 300) + '\nDatum: ' + datum + '\n\n' + m.tekst, 'mail:' + id, { datum: datum });
    },
    agenda: async function (a) {
      const van = ymd(a.van), tot = ymd(a.tot);
      if (!van || !tot) return 'van en tot als JJJJ-MM-DD';
      const dv = Date.parse(van + 'T00:00:00Z'), dt = Date.parse(tot + 'T00:00:00Z');
      if (dt < dv || dt - dv > 31 * 86400000 || Math.abs(dv - nu()) > 400 * 86400000) return 'hooguit 31 dagen, binnen ruim een jaar van vandaag';
      const l = await io.agenda(van, tot);
      const r = (Array.isArray(l) ? l : []).slice(0, 80).map(function (e) { return '- ' + schoon(e.start, 30) + ' – ' + schoon(e.einde, 30) + ' · ' + schoon(e.titel, 160) + (e.agenda ? ' (' + schoon(e.agenda, 40) + ')' : ''); }).join('\n');
      return r ? stuk('agenda', 'agenda ' + van + ' t/m ' + tot, r, 'agenda:' + van + '/' + tot) : 'geen afspraken';
    },
    contact: async function (a) {
      const t = term(a.naam);
      if (t.length < 3 || t.length > 80) return 'naam: 3-80 tekens';
      const l = await io.contact(t);
      const r = (Array.isArray(l) ? l : []).slice(0, 10).map(function (c) { return '- ' + schoon(JSON.stringify(c), 600); }).join('\n');
      return r ? stuk('contact', 'contacten "' + t + '"', r, 'contact:' + t) : 'niet in de contacten';
    },
    facturen: async function (a) {
      const t = term(a.tegenpartij);
      if (t.length < 3 || t.length > 80) return 'tegenpartij: 3-80 tekens';
      const j = await io.facturen(t);
      return j ? stuk('facturen', 'Facturen "' + t + '"', JSON.stringify(j, null, 1), 'facturen:' + t) : 'niets in Facturen';
    },
    nmbrs: async function (a) {
      const t = term(a.naam);
      if (t.length < 3 || t.length > 80) return 'naam: 3-80 tekens';
      const j = await io.nmbrs(t);
      if (!j || j.ok === false) return 'Nmbrs gaf geen antwoord';
      if (Array.isArray(j.meerdere)) return stuk('lijst', 'Nmbrs: meerdere treffers "' + t + '"', j.meerdere.map(function (m) { return '- ' + schoon(m.naam, 80) + ' · ' + schoon(m.bedrijf, 80); }).join('\n'), 'nmbrs:' + t);
      const tr = Array.isArray(j.treffers) ? j.treffers : [];
      if (tr.length !== 1) return 'niet gevonden in Nmbrs';
      const m = tr[0];
      // vaste velden, nooit een bedrag, BSN, IBAN, adres of verzuim (nmbrs-data.js geeft die al niet; hier nog eens alleen de lijst)
      const v = { naam: m.naam, bedrijf: m.bedrijf, entiteit: m.entiteit, in_dienst: m.in_dienst, functie: m.functie, in_dienst_sinds: m.in_dienst_sinds, contract: m.contract,
        parttime_pct: m.parttime_pct, salaristabel: m.salaristabel, schaal: m.schaal, trede: m.trede, ingangsdatum_salaris: m.ingangsdatum_salaris };
      const tekst = Object.keys(v).map(function (k) { return k + ': ' + (v[k] && typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k] == null ? '—' : v[k]); }).join('\n');
      return stuk('nmbrs', 'Nmbrs (' + schoon(m.bedrijf || 'salarisadministratie', 60) + ')', tekst, 'nmbrs:' + t, { gebonden: s(m.naam), datum: m.ingangsdatum_salaris || (m.contract && m.contract.begin) || null });
    }
  };
  async function roep(naam, args) {
    if (!Object.prototype.hasOwnProperty.call(ACTIES, naam)) return { fout: true, tekst: 'onbekende tool' };
    if (tel.aanroepen >= AANROEPEN_MAX) return { fout: true, tekst: 'grens: hooguit ' + AANROEPEN_MAX + ' aanroepen per run' };
    tel.aanroepen++;
    try { return { tekst: await ACTIES[naam](args && typeof args === 'object' ? args : {}) }; } catch (e) { return { fout: true, tekst: 'niet gelukt (' + naam + ')' }; }
  }
  return { roep: roep, stukken: stukken, log: log, tel: tel };
}

// ── rol 2: stdio-MCP-server (alleen doorgeven) ──
function relay() {
  const url = process.env.VOORWERK_LUIK_URL || '', token = process.env.VOORWERK_LUIK_TOKEN || '';
  const stuur = function (x) { process.stdout.write(JSON.stringify(x) + '\n'); };
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', async function (l) {
    let m; try { m = JSON.parse(l); } catch (e) { return; }
    if (!m || typeof m !== 'object' || m.id == null) return;   // meldingen: niets terug
    if (m.method === 'initialize') return stuur({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'voorwerk-lees', version: '1' } } });
    if (m.method === 'ping') return stuur({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'tools/list') return stuur({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') {
      const p = m.params || {};
      let j = null;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voorwerk-token': token }, body: JSON.stringify({ tool: s(p.name), args: p.arguments || {} }), signal: AbortSignal.timeout(90000) });
        j = await r.json();
      } catch (e) { j = { fout: true, tekst: 'luik niet bereikbaar' }; }
      return stuur({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: s(j && j.tekst) || 'leeg' }], isError: !!(j && j.fout) } });
    }
    stuur({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'onbekend' } });
  });
}
if (require.main === module) relay();

module.exports = { maakLuik, vaultPadOk, vaultBinding, TOOLS, VERBODEN, _grenzen: { STUK_MAX, STUKKEN_MAX, LIJSTEN_MAX, AANROEPEN_MAX, MAIL_MAX, MAIL_DAGEN } };
