'use strict';
// OVIS GHAWA fase 4 — Stichting (wv2886, 10-11-2026; plan vault "01_Ontwikkeling/OVIS GHAWA - plan naar een 8 (Fable 5.2, 10-11-2026)"
// § 2.2 groep Stichting, § 2.3 punt 7 "Bestuur vindbaar", § 3 tabellen besluit/overleg/actiepunt/mijlpaal).
// Leest de vault (10_Zakelijk/GHAWA-ECG) en de werkkopie van de site (alleen lezen, via ghawa-site.js) en maakt vier schermen:
//   doelen     doel volgens de statuten (art. 2), donatiedoelen zoals op ghawa.org, mijlpalen tot de eerste patiënt
//   stichting  statuten en ANBI: basisgegevens, stukken (wat er is, wat ontbreekt), bestuur GHAWA en ECG
//   overleg    vergaderingen, besluiten, actiepunten per persoon; stand uit de Actie-Bewaker (alleen lezen)
//   mensen     organisaties en mensen met hun rol (alleen naam + rol + of er een pagina is; nooit tekst van een persoonspagina)
// De vault is de bron; de databank houdt een afgeleide kopie (tabellen overleg, besluit, actiepunt, mijlpaal; herkomst 'vault') die
// bij elke wijziging van de bronnen in één transactie opnieuw wordt opgebouwd, zodat fase 5 (delen) uit één plek leest.
// Nooit in een antwoord: rekeningnummers, bedragen per donateur, tekst uit persoonspagina's.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GH = path.join('10_Zakelijk', 'GHAWA-ECG');
const BRONNEN = {
  ghawa: path.join(GH, 'GHAWA.md'),
  ecg: path.join(GH, 'ECG Foundation.md'),
  project: path.join(GH, 'Project Sukuta Health Center.md'),
  overdracht: path.join(GH, 'Bronnen', 'Overdracht financien ECG 2026-10-06', 'ECG finance handover.md'),
  notulen: path.join(GH, 'Notulen'),
  personen: path.join('20_Prive', 'Gambia', 'Personen'),
  anbi: path.join(GH, 'Bronnen', 'Stichting GHAWA - ANBI-stukken van ghawa.org'),
};
const MAANDEN = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };
const IBAN = /\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d){6,}\b/g;

// ── kleine markdownhulpen ──
const schoon = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 400);
function ontlink(s) {   // [[pad|tekst]] → tekst, [[pad]] → laatste deel; **, *, ` weg; rekeningnummers gemaskeerd
  return schoon(String(s || '').replace(/\\\|/g, '|')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, (m, p) => p.split('/').pop())
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(IBAN, '(rekeningnummer)'), 600);
}
function links(s) {
  const uit = []; const re = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]+))?\]\]/g; let m;
  while ((m = re.exec(String(s || '')))) uit.push({ pad: m[1].trim(), tekst: (m[2] || m[1].split('/').pop()).trim() });
  return uit;
}
function frontmatter(t) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t); const fm = {};
  if (!m) return { fm, body: t };
  for (const r of m[1].split('\n')) { const x = /^([a-z_]+):\s*(.*)$/i.exec(r); if (x) fm[x[1]] = x[2].replace(/^["']|["']$/g, ''); }
  return { fm, body: t.slice(m[0].length) };
}
function sectie(md, re) {   // tekst onder de eerste kop die op re past, tot de volgende kop van hetzelfde of een hoger niveau
  const r = md.split('\n'); let i = r.findIndex((x) => /^#{1,6}\s/.test(x) && re.test(x.replace(/^#+\s+/, '')));
  if (i < 0) return null;
  const niv = /^(#+)/.exec(r[i])[1].length; const uit = [];
  for (let j = i + 1; j < r.length; j++) { const k = /^(#+)\s/.exec(r[j]); if (k && k[1].length <= niv) break; uit.push(r[j]); }
  return { kop: r[i].replace(/^#+\s+/, ''), tekst: uit.join('\n') };
}
function tabellen(tekst) {   // markdowntabellen → [{kop: [..], rijen: [[..]]}]
  const uit = []; let t = null;
  for (const r of String(tekst || '').split('\n')) {
    if (!/^\s*\|.*\|\s*$/.test(r)) { t = null; continue; }
    const veilig = r.replace(/\[\[[^\]]*\]\]/g, (m) => m.replace(/\\?\|/g, '\u0001')).replace(/\\\|/g, '\u0001');   // | in een wikilink of \| is geen celgrens
    const cel = veilig.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.replace(/\u0001/g, '|').trim());
    if (cel.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!t) { t = { kop: cel.map((c) => ontlink(c).toLowerCase()), rijen: [] }; uit.push(t); } else t.rijen.push(cel);
  }
  return uit;
}
const kolom = (t, re) => t.kop.findIndex((k) => re.test(k));
function isoDatum(s) {   // '7-10-2026', '12-1-2026', '7 oktober 2026', '2026-10-07' → '2026-10-07'; anders null
  const t = String(s || '').toLowerCase();
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(t); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(t); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = /\b(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})\b/.exec(t);
  if (m) return m[3] + '-' + String(MAANDEN[m[2]]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
const sleutel = (...d) => crypto.createHash('sha256').update(d.join('\u0001')).digest('hex').slice(0, 12);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
function lees(vault, rel) { try { const p = path.join(vault, rel); const st = fs.lstatSync(p); return st.isFile() ? fs.readFileSync(p, 'utf8') : null; } catch (e) { return null; } }
function personen(vault, eigen) {   // eigen: 'Naam' → vaultpad van een persoonspagina (alleen het pad; de inhoud lezen we niet)
  const kaart = new Map();
  for (const map of [BRONNEN.personen, path.join('10_Zakelijk', 'HAGRO', 'Praktijkhouders')]) {
    let l = []; try { l = fs.readdirSync(path.join(vault, map), { withFileTypes: true }); } catch (e) { continue; }
    for (const e of l) if (e.isFile() && e.name.endsWith('.md') && !/ - /.test(e.name)) { const n = norm(e.name.slice(0, -3)); if (!kaart.has(n)) kaart.set(n, path.join(map, e.name.slice(0, -3))); }
  }
  return function (naam, pad) {
    if (pad && lees(vault, pad + '.md') != null) return pad;
    const n = norm(String(naam || '').replace(/^(dr|mr|ms|mrs)\.?\s+/i, '').replace(/\([^)]*\)/g, ''));
    if (kaart.has(n)) return kaart.get(n);
    for (const [k, v] of kaart) if (k.length >= 8 && (n.startsWith(k) || k.startsWith(n))) return v;
    return null;
  };
}

// ── 1. doelen ──
function statutenDoel(ghawaMd) {
  const s = sectie(ghawaMd || '', /^Doelstelling volgens de statuten/i);
  if (!s) return [];
  const uit = [];
  for (const r of s.tekst.split('\n')) {
    const m = /^-\s+\*\*(\d+\.\d+)\*\*\s*(.*)$/.exec(r);
    if (m) uit.push({ nr: m[1], tekst: m[2] });
    else if (uit.length && /^\s{2,}\S/.test(r)) uit[uit.length - 1].tekst += ' ' + r.trim();
    else if (uit.length && /^\S/.test(r)) break;
  }
  return uit.map((x) => ({ nr: x.nr, tekst: ontlink(x.tekst) }));
}
const platte = (s) => schoon(String(s || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' '), 1200);
const getal = (s) => { const t = String(s || '').replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.'); return t ? Number(t) : null; };
function donatiedoelen(astro) {
  if (!astro) return null;
  const intro = /<section class="doelen-intro">\s*<p>([\s\S]*?)<\/p>/.exec(astro);
  const doelen = [];
  const re = /<div class="doel-kaart">[\s\S]*?<h2>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/g; let m;
  while ((m = re.exec(astro))) doelen.push({ titel: platte(m[1]), tekst: platte(m[2]) });
  const fases = []; let totaal = null;
  const tab = /<table class="totaal-tabel">([\s\S]*?)<\/table>/.exec(astro);
  if (tab) {
    for (const rij of tab[1].split(/<tr[^>]*>/).slice(1)) {
      const cel = [...rij.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => platte(x[1]));
      if (cel.length === 4) fases.push({ fase: cel[0], wat: cel[1], gmd: getal(cel[2]), eur: getal(cel[3]) });
      else if (cel.length === 3) totaal = { gmd: getal(cel[1]), eur: getal(cel[2]) };
    }
  }
  const jr = /<section class="jaarlijks-sectie">([\s\S]*?)<\/section>/.exec(astro);
  let jaarlijks = null;
  if (jr) { const t = /<tr class="totaal-rij">([\s\S]*?)<\/tr>/.exec(jr[1]); if (t) { const c = [...t[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => platte(x[1])); jaarlijks = { gmd: getal(c[1]), eur: getal(c[2]) }; } }
  const koers = /Wisselkoers circa GMD (\d+)/.exec(astro);
  return { intro: intro ? platte(intro[1]) : null, doelen, fases, totaal, jaarlijks, koers: koers ? Number(koers[1]) : null };
}
function mijlpalen(projectMd) {
  const s = sectie(projectMd || '', /^Mijlpalen tot de eerste pati/i);
  if (!s) return [];
  const t = tabellen(s.tekst)[0]; if (!t) return [];
  const iw = kolom(t, /wanneer|datum/), im = kolom(t, /mijlpaal/), is = kolom(t, /stand|status/), ib = kolom(t, /bron/);
  return t.rijen.map((r, i) => ({ volgorde: i + 1, wanneer: ontlink(r[iw]), tekst: ontlink(r[im]), stand: (ontlink(r[is]) || 'gepland').toLowerCase(), bron: ib >= 0 ? ontlink(r[ib]) : null }))
    .filter((x) => x.tekst);
}

// ── 3. overleg, besluiten, actiepunten ──
function eigenaren(s) {
  const t = ontlink(s).replace(/\.$/, '');
  if (!t || /^(niet benoemd|onbekend|—|-)$/i.test(t)) return ['niet benoemd'];
  return t.split(/\s+en\s+|\s+and\s+|\s*,\s*|\s*\/\s*|\s*&\s*/i).map((x) => x.trim()).filter(Boolean);
}
function uitSectie(tekst, ov, bron, uit) {   // actiepunten (tabel + "Actie X: …") en besluiten ("Besluit: …") uit één overlegtekst
  for (const t of tabellen(tekst)) {
    const ia = kolom(t, /^actie/), ie = kolom(t, /eigenaar|wie|owner/), it = kolom(t, /termijn|wanneer|deadline/);
    if (ia < 0) continue;
    for (const r of t.rijen) { const tk = ontlink(r[ia]); if (tk) uit.actiepunten.push({ overleg: ov, tekst: tk, eigenaar: ie >= 0 ? eigenaren(r[ie]).join(', ') : 'niet benoemd', termijn: it >= 0 ? ontlink(r[it]) || null : null, bron }); }
  }
  for (const r of tekst.split('\n')) {
    const a = /^\s*[-*]\s+(?:\*\*)?Actie\s+([A-Z][\w .'-]{1,40}?):(?:\*\*)?\s*(.+)$/.exec(r);
    if (a) uit.actiepunten.push({ overleg: ov, tekst: ontlink(a[2]), eigenaar: eigenaren(a[1]).join(', '), termijn: null, bron });
    const b = /^\s*[-*]\s+(?:\*\*)?Besluit:\s*(.+)$/i.exec(r);
    if (b) {
      const vol = b[1]; const w = /\*\*\s*(?:Reden|Omdat|Want):?\s*(.+)$/i.exec(vol) || /\.\s*(?:Reden|Omdat):\s*(.+)$/i.exec(vol);
      const kern = ontlink(w ? vol.slice(0, w.index) : vol).replace(/\s*Reden:.*$/i, '');
      uit.besluiten.push({ overleg: ov, datum: null, tekst: kern, waarom: w ? ontlink(w[1]) : null, bron });
    }
  }
}
function overleggen(vault) {
  const uit = { overleggen: [], besluiten: [], actiepunten: [] };
  // a. de map Notulen: één bestand per overleg
  let l = []; try { l = fs.readdirSync(path.join(vault, BRONNEN.notulen), { withFileTypes: true }); } catch (e) { l = []; }
  for (const e of l.filter((x) => x.isFile() && x.name.endsWith('.md')).sort((x, y) => x.name.localeCompare(y.name))) {
    const rel = path.join(BRONNEN.notulen, e.name); const t = lees(vault, rel); if (t == null) continue;
    const { fm, body } = frontmatter(t);
    const datum = isoDatum(fm.datum) || isoDatum(e.name);
    const titel = ontlink((/^#\s+(.+)$/m.exec(body) || [])[1] || fm.onderwerp || e.name.slice(0, -3));
    const wie = /\*\*Aanwezig:\*\*\s*([\s\S]+?)(?:\n\s*\n|\n\*\*)/.exec(body);
    const ov = sleutel('notulen', rel);
    uit.overleggen.push({ sleutel: ov, datum, titel, wie: wie ? ontlink(wie[1]).replace(/;?\s*$/, '') : null, bron: rel.replace(/\.md$/, ''),
      stukken: links(fm.bronnen || '').map((x) => ontlink('[[' + x.pad + '|' + x.tekst + ']]')).slice(0, 4) });
    uitSectie(body, ov, rel.replace(/\.md$/, ''), uit);
  }
  // b. overleggen die (nog) alleen als kop of vette regel op de projectpagina staan; een datum die al in Notulen staat telt niet dubbel
  const pr = lees(vault, BRONNEN.project) || '';
  const r = pr.split('\n');
  const al = new Set(uit.overleggen.map((o) => o.datum));
  for (let i = 0; i < r.length; i++) {
    const k = /^(#{2,4})\s+Overleg GHAWA-ECG\s+(.+)$/.exec(r[i]); const v = !k && /^\*\*Overleg GHAWA-ECG\s+([^*]+)\*\*(.*)$/.exec(r[i]);
    if (!k && !v) continue;
    const kopTekst = k ? k[2] : v[1]; const datum = isoDatum(kopTekst);
    if (!datum || al.has(datum)) continue;
    const blok = [v ? v[2] : ''];
    for (let j = i + 1; j < r.length; j++) { if (k ? (/^(#+)\s/.exec(r[j]) && /^(#+)/.exec(r[j])[1].length <= k[1].length) : (/^#/.test(r[j]) || /^\*\*\S/.test(r[j]))) break; blok.push(r[j]); }
    const tekst = blok.join('\n');
    const ov = sleutel('project', datum);
    const wie = /\(aanwezig\s+([^;)]+)/i.exec(tekst);
    uit.overleggen.push({ sleutel: ov, datum, titel: 'Overleg GHAWA-ECG ' + ontlink(kopTekst).replace(/\s+—.*$/, ''), wie: wie ? ontlink(wie[1]) : null,
      bron: BRONNEN.project.replace(/\.md$/, ''), stukken: links(tekst).filter((x) => /notulen|minutes|verslag|plaud/i.test(x.tekst + x.pad)).map((x) => ontlink('[[' + x.pad + '|' + x.tekst + ']]')).slice(0, 4) });
    al.add(datum);
    uitSectie(tekst, ov, BRONNEN.project.replace(/\.md$/, ''), uit);
  }
  for (const b of uit.besluiten) { const o = uit.overleggen.find((x) => x.sleutel === b.overleg); b.datum = o ? o.datum : null; }
  // c. de besluitenlijst van de overdracht (§ 13 Decisions log, Engels zoals ECG hem kent)
  const od = lees(vault, BRONNEN.overdracht);
  const s = od && sectie(od, /Decisions log/i);
  if (s) {
    const t = tabellen(s.tekst)[0];
    if (t) {
      const id = kolom(t, /date/), ib = kolom(t, /decision/), iw = kolom(t, /why/);
      for (const x of t.rijen) uit.besluiten.push({ overleg: null, datum: isoDatum(x[id]), tekst: ontlink(x[ib]), waarom: iw >= 0 ? ontlink(x[iw]) : null, bron: BRONNEN.overdracht.replace(/\.md$/, ''), orgaan: 'overdracht financiën ECG' });
    }
  }
  uit.overleggen.sort((a, b) => String(b.datum).localeCompare(String(a.datum)));
  uit.besluiten.forEach((b) => { b.sleutel = sleutel('besluit', b.bron, b.datum || '', b.tekst); });
  uit.actiepunten.forEach((a) => { a.sleutel = sleutel('actie', a.bron, a.overleg || '', a.tekst); });
  return uit;
}
// Actie-Bewaker (n8n-tabel actie_state, alleen lezen; alleen entiteit GHAWA-ECG, nooit Prive/Gambia) koppelen aan de actiepunten
const BEWAKER_STAND = { open: 'open', gemeld: 'gemeld aan jou', afgerond: 'afgerond', genegeerd: 'genegeerd' };
function bewakerKoppel(acties, rijen) {
  const r = (Array.isArray(rijen) ? rijen : []).filter((x) => x && /ghawa/i.test(String(x.entiteit || '')) && !/priv/i.test(String(x.entiteit || '')));
  const gebruikt = new Set();
  for (const a of acties) {
    const n = norm(a.tekst), bestand = norm(path.basename(String(a.bron || '')));
    const m = r.find((x) => !gebruikt.has(x.actie_id) && norm(x.bron).includes(bestand) && (norm(x.actie) === n || (n.length >= 20 && (norm(x.actie).startsWith(n.slice(0, 30)) || n.startsWith(norm(x.actie).slice(0, 30))))));
    if (m) { gebruikt.add(m.actie_id); a.bewaker = { stand: BEWAKER_STAND[m.status] || schoon(m.status, 20), gecheckt: schoon(m.laatst_gecheckt, 30) || null }; }
  }
  const los = r.filter((x) => !gebruikt.has(x.actie_id)).map((x) => ({ sleutel: sleutel('bewaker', String(x.actie_id)), tekst: ontlink(x.actie).slice(0, 300), eigenaar: eigenaren(x.eigenaar).join(', '),
    termijn: /^\d{4}-\d{2}-\d{2}$/.test(String(x.deadline || '')) ? x.deadline : null, bron: ontlink(String(x.bron || '').split(/[,(]/)[0]).slice(0, 160),
    bewaker: { stand: BEWAKER_STAND[x.status] || schoon(x.status, 20), gecheckt: schoon(x.laatst_gecheckt, 30) || null }, herkomst: 'actie-bewaker' }));
  return { los, gezien: r.length };
}

// ── 4. mensen en bestuur ──
function bestuurGhawa(ghawaMd, pagina) {
  const s = sectie(ghawaMd || '', /^Basisgegevens/i); const uit = [];
  if (!s) return uit;
  for (const r of s.tekst.split('\n')) {
    const m = /^-\s+(Voorzitter|Penningmeester|Secretaris|Boekhouding en jaarverslag):\s*(.+)$/i.exec(r); if (!m) continue;
    const l = links(m[2])[0];
    const naam = l ? l.tekst : ontlink(m[2]).replace(/\s*\(.*$/, '');
    uit.push({ naam, rol: m[1].toLowerCase(), organisatie: 'GHAWA', pagina: pagina(naam, l && l.pad) });
  }
  return uit;
}
function bestuurEcg(ecgMd, pagina) {
  const uit = [];
  for (const [re, soort] of [[/\*\*Board of Directors:\*\*\s*([\s\S]+?)(?:\n-\s|\n\n)/, 'bestuur'], [/\*\*Executive members:\*\*\s*([\s\S]+?)(?:\n\n|\n[^ ])/, 'uitvoerend']]) {
    const m = re.exec(ecgMd || ''); if (!m) continue;
    for (const d of m[1].replace(/\s+/g, ' ').replace(/\.\s*$/, '').split(/\),\s*/)) {
      const i = d.lastIndexOf('('); if (i < 1) continue;
      const ruw = ontlink(d.slice(0, i)), rol = ontlink(d.slice(i + 1)).replace(/\)$/, '').toLowerCase();
      const naam = ruw.replace(/\s*\([^)]*\)/g, '').trim();
      const alt = ruw.replace(/(\S+)\s*\(([^)]+)\)/, '$2');   // "Kalifa (Khalifa) Bojang" → ook "Khalifa Bojang"
      uit.push({ naam: ruw, rol, organisatie: soort === 'bestuur' ? 'ECG Foundation' : 'ECG Foundation (uitvoerend)', pagina: pagina(naam) || pagina(alt) });
    }
  }
  return uit;
}
function basisGhawa(ghawaMd) {
  const s = sectie(ghawaMd || '', /^Basisgegevens/i); const u = {};
  if (!s) return u;
  for (const r of s.tekst.split('\n')) {
    const m = /^-\s+(Naam|Opgericht|Status|Website|Land):\s*(.+)$/.exec(r);
    if (m) u[m[1].toLowerCase()] = ontlink(m[2]);
  }
  return u;   // bewust niet: bankrekening, spaarrekening, postadres, mailadressen
}

// ── 2. statuten en ANBI: stukken ──
function anbiStukken(site, vault) {
  const best = new Map((site && site.anbiBestanden) || []);   // 'public/anbi/x.pdf' → blob
  const er = (n) => best.has('public/anbi/' + n);
  const inVault = (n) => { const p = path.join(BRONNEN.anbi, n); try { return fs.lstatSync(path.join(vault, p)).isFile() ? p : null; } catch (e) { return null; } };
  const url = (n) => 'https://www.ghawa.org/anbi/' + n;
  const meta = (pag) => { const m = /<p class="document-meta">([\s\S]*?)<\/p>/.exec((site && site.anbi && site.anbi[pag]) || ''); return m ? platte(m[1]) : ''; };
  const stukken = [];
  const zet = (soort, titel, n, extra) => stukken.push(Object.assign({ soort, titel, status: n && er(n) ? 'er' : 'ontbreekt', url: n && er(n) ? url(n) : null, vault: n ? inVault(n) : null,
    tekst: n ? (inVault(n.replace(/\.pdf$/, '.md')) || '').replace(/\.md$/, '') || null : null }, extra || {}));
  zet('statuten', 'Statuten', 'statuten.pdf', { toelichting: (meta('statuten') || '') + (er('statuten.pdf') ? ' · Word-versie op ghawa.org; de getekende akte van de notaris staat niet in de Second Brain' : '') });
  zet('beleidsplan', 'Beleidsplan', 'beleidsplan.pdf', { toelichting: (meta('beleidsplan') || '') });
  const bp = stukken[stukken.length - 1];
  if (bp.status === 'er' && /2023/.test(bp.toelichting)) { bp.status = 'verouderd'; bp.toelichting += ' · het beleidsplan is van 2023; een actueel plan staat niet in de Second Brain'; }
  const jaren = [...best.keys()].map((k) => /^public\/anbi\/pubplicht-(\d{4})\.pdf$/.exec(k)).filter(Boolean).map((m) => Number(m[1])).sort();
  for (const j of jaren) {
    const n = 'pubplicht-' + j + '.pdf', vorig = 'public/anbi/pubplicht-' + (j - 1) + '.pdf';
    const zelfde = best.has(vorig) && best.get(vorig) === best.get('public/anbi/' + n);
    zet('publicatieplicht', 'Publicatieplicht ' + j, n, zelfde ? { status: 'twijfel', toelichting: 'hetzelfde bestand als ' + (j - 1) + ' (byte voor byte); het formulier over ' + j + ' lijkt nog niet geplaatst' } : { toelichting: 'standaardformulier ANBI over ' + j });
  }
  zet('jaarverslag', 'Jaarverslag 2025', null, { toelichting: 'concept van André (maart 2026) staat alleen als mail in de Second Brain; of het op 25-3-2026 is vastgesteld is niet vast te stellen' });
  return stukken;
}

// ── de databank: afgeleide kopie, in één keer opnieuw ──
const SCHEMA = `
CREATE TABLE IF NOT EXISTS overleg (sleutel TEXT PRIMARY KEY, datum TEXT, titel TEXT NOT NULL, wie TEXT, bron TEXT, stukken TEXT, herkomst TEXT NOT NULL DEFAULT 'vault');
CREATE TABLE IF NOT EXISTS besluit (sleutel TEXT PRIMARY KEY, datum TEXT, tekst TEXT NOT NULL, waarom TEXT, overleg TEXT, orgaan TEXT, bron TEXT, herkomst TEXT NOT NULL DEFAULT 'vault');
CREATE TABLE IF NOT EXISTS actiepunt (sleutel TEXT PRIMARY KEY, overleg TEXT, tekst TEXT NOT NULL, eigenaar TEXT, termijn TEXT, bron TEXT, herkomst TEXT NOT NULL DEFAULT 'vault');
CREATE TABLE IF NOT EXISTS mijlpaal (sleutel TEXT PRIMARY KEY, volgorde INTEGER NOT NULL, wanneer TEXT, tekst TEXT NOT NULL, stand TEXT, bron TEXT, herkomst TEXT NOT NULL DEFAULT 'vault');
`;
function bewaar(db, d, nu) {   // alleen rijen met herkomst 'vault' (fase 6 krijgt eigen herkomst); hash gelijk = niets doen
  db.exec(SCHEMA);
  const h = sleutel(JSON.stringify([d.overleggen, d.besluiten, d.actiepunten, d.mijlpalen]));
  const oud = db.prepare("SELECT waarde FROM meta WHERE sleutel = 'stichting:hash'").get();
  if (oud && oud.waarde === h) return { gewijzigd: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const t of ['overleg', 'besluit', 'actiepunt', 'mijlpaal']) db.prepare('DELETE FROM ' + t + " WHERE herkomst = 'vault'").run();
    const o = db.prepare('INSERT OR REPLACE INTO overleg (sleutel, datum, titel, wie, bron, stukken) VALUES (?,?,?,?,?,?)');
    for (const x of d.overleggen) o.run(x.sleutel, x.datum, x.titel, x.wie, x.bron, JSON.stringify(x.stukken || []));
    const b = db.prepare('INSERT OR REPLACE INTO besluit (sleutel, datum, tekst, waarom, overleg, orgaan, bron) VALUES (?,?,?,?,?,?,?)');
    for (const x of d.besluiten) b.run(x.sleutel, x.datum, x.tekst, x.waarom, x.overleg, x.orgaan || null, x.bron);
    const a = db.prepare('INSERT OR REPLACE INTO actiepunt (sleutel, overleg, tekst, eigenaar, termijn, bron) VALUES (?,?,?,?,?,?)');
    for (const x of d.actiepunten) a.run(x.sleutel, x.overleg, x.tekst, x.eigenaar, x.termijn, x.bron);
    const m = db.prepare('INSERT OR REPLACE INTO mijlpaal (sleutel, volgorde, wanneer, tekst, stand, bron) VALUES (?,?,?,?,?,?)');
    for (const x of d.mijlpalen) m.run(sleutel('mijlpaal', x.wanneer, x.tekst), x.volgorde, x.wanneer, x.tekst, x.stand, x.bron);
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('stichting:hash', h);
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('stichting:op', nu);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { gewijzigd: true };
}
function leesDb(db) {
  const heeft = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mijlpaal'").get();
  if (!heeft) return null;
  return {
    overleggen: db.prepare('SELECT sleutel, datum, titel, wie, bron, stukken FROM overleg ORDER BY datum DESC, titel').all().map((x) => Object.assign({}, x, { stukken: JSON.parse(x.stukken || '[]') })),
    besluiten: db.prepare('SELECT sleutel, datum, tekst, waarom, overleg, orgaan, bron FROM besluit ORDER BY datum DESC, rowid').all().map((x) => Object.assign({}, x)),
    actiepunten: db.prepare('SELECT sleutel, overleg, tekst, eigenaar, termijn, bron FROM actiepunt ORDER BY rowid').all().map((x) => Object.assign({}, x)),
    mijlpalen: db.prepare('SELECT volgorde, wanneer, tekst, stand, bron FROM mijlpaal ORDER BY volgorde').all().map((x) => Object.assign({}, x)),
  };
}

// Alles uit de vault in één keer (alleen lezen)
function leesVault(vault) {
  const ghawaMd = lees(vault, BRONNEN.ghawa) || '', ecgMd = lees(vault, BRONNEN.ecg) || '', pr = lees(vault, BRONNEN.project) || '';
  const pagina = personen(vault);
  const o = overleggen(vault);
  return { statuten: statutenDoel(ghawaMd), basis: basisGhawa(ghawaMd), ghawaBestuur: bestuurGhawa(ghawaMd, pagina), ecgBestuur: bestuurEcg(ecgMd, pagina),
    mijlpalen: mijlpalen(pr), overleggen: o.overleggen, besluiten: o.besluiten, actiepunten: o.actiepunten,
    bronnen: { ghawa: lees(vault, BRONNEN.ghawa) != null, ecg: lees(vault, BRONNEN.ecg) != null, project: pr !== '', overdracht: lees(vault, BRONNEN.overdracht) != null } };
}
function kvkRsin(site) {
  const t = platte((site && site.anbi && site.anbi.statuten) || '');
  const k = /Koophandel onder nummer\s*(\d{8})/.exec(t), r = /RSIN\s*(\d{9})/.exec(t);
  return { kvk: k ? k[1] : null, rsin: r ? r[1] : null };
}

// ── de vier schermen ──
function route(scherm, v) {
  const d = v.data, site = v.site || null;
  const pad = (p) => (p ? String(p).replace(/\.md$/, '') : null);
  if (scherm === 'doelen') {
    const dd = site ? donatiedoelen(site.donatiedoelen) : null;
    return { statuten: d.statuten, statuten_bron: pad(BRONNEN.ghawa), donatiedoelen: dd, site_gelezen: !!site, app_bouw_gmd: v.totalen ? v.totalen.bouw_gmd : null, app_koers: v.totalen ? v.totalen.koers : null,
      mijlpalen: d.mijlpalen, mijlpalen_bron: pad(BRONNEN.project) };
  }
  if (scherm === 'stichting') {
    const stukken = anbiStukken(site, v.vault);
    return { basis: Object.assign({}, d.basis, kvkRsin(site)), stukken, site_gelezen: !!site,
      ontbreekt: stukken.filter((s) => s.status !== 'er').length,
      bestuur: { ghawa: d.ghawaBestuur.filter((p) => /^(voorzitter|penningmeester|secretaris)$/.test(p.rol)), ecg: d.ecgBestuur.filter((p) => p.organisatie === 'ECG Foundation'), ecg_uitvoerend: d.ecgBestuur.filter((p) => p.organisatie !== 'ECG Foundation') },
      bron: { ghawa: pad(BRONNEN.ghawa), ecg: pad(BRONNEN.ecg) } };
  }
  if (scherm === 'overleg') {
    const acties = d.actiepunten.map((a) => Object.assign({ herkomst: 'notulen' }, a, { bewaker: null }));
    const bw = v.bewaker && v.bewaker.rijen ? bewakerKoppel(acties, v.bewaker.rijen) : null;
    const alle = acties.concat(bw ? bw.los : []);
    const per = new Map();
    for (const a of alle) for (const p of String(a.eigenaar || 'niet benoemd').split(', ')) { if (!per.has(p)) per.set(p, []); per.get(p).push(a.sleutel); }
    const ovNaam = new Map(d.overleggen.map((o) => [o.sleutel, (o.datum || '') + ' ' + o.titel]));
    return { overleggen: d.overleggen.map((o) => Object.assign({}, o, { besluiten: d.besluiten.filter((b) => b.overleg === o.sleutel).length, acties: acties.filter((a) => a.overleg === o.sleutel).length })),
      besluiten: d.besluiten.map((b) => Object.assign({}, b, { overleg_naam: b.overleg ? ovNaam.get(b.overleg) || null : b.orgaan || null })),
      actiepunten: alle.map((a) => Object.assign({}, a, { overleg_naam: a.overleg ? ovNaam.get(a.overleg) || null : null })),
      per_persoon: [...per.entries()].map(([naam, l]) => ({ naam, acties: l })).sort((a, b) => (a.naam === 'niet benoemd') - (b.naam === 'niet benoemd') || b.acties.length - a.acties.length || a.naam.localeCompare(b.naam)),
      bewaker: v.bewaker ? { gelezen: !!v.bewaker.rijen, op: v.bewaker.op || null, gekoppeld: bw ? alle.filter((a) => a.bewaker && a.herkomst !== 'actie-bewaker').length : 0, los: bw ? bw.los.length : 0, fout: v.bewaker.fout || null } : null };
  }
  if (scherm === 'mensen') {
    const mensen = d.ghawaBestuur.concat(d.ecgBestuur);
    const orgs = [
      { naam: 'Stichting GHAWA', soort: 'stichting (NL, ANBI)', rol: 'fondsenwerving en verantwoording; voorzitter David', pagina: pad(BRONNEN.ghawa), mensen: d.ghawaBestuur.length },
      { naam: 'ECG Foundation', soort: 'NGO (Gambia)', rol: 'eigenaar en uitvoerder van het project in Sukuta', pagina: pad(BRONNEN.ecg), mensen: d.ecgBestuur.length },
    ];
    // fondsen als organisatie: alleen echte gevers (Grant/Sponsor), naam zonder deel- of projectstaart; eigen geld en giften zijn geen organisatie
    const SOORT_NL = { grant: 'subsidie', sponsor: 'sponsor' };
    for (const f of (v.fondsen || [])) {
      if (!/^(grant|sponsor)$/i.test(String(f.soort || '')) || /ghawa/i.test(f.gever || '')) continue;
      const naam = schoon(f.gever, 80).replace(/\s+-\s+(1st part|rest|\d.*)$/i, '').replace(/\s*\((project|own share)[^)]*\)\s*$/i, '');
      if (!orgs.some((o) => norm(o.naam) === norm(naam))) orgs.push({ naam, soort: 'fonds', rol: SOORT_NL[String(f.soort).toLowerCase()] || 'fonds', pagina: null, mensen: 0, scherm: 'fondsen' });
    }
    if (fs.existsSync(path.join(v.vault || '', GH, 'VSG - Verenigde Stichtingen Gambia.md'))) orgs.push({ naam: 'VSG — Verenigde Stichtingen Gambia', soort: 'netwerk', rol: 'netwerk van Gambia-stichtingen; GHAWA is lid', pagina: path.join(GH, 'VSG - Verenigde Stichtingen Gambia'), mensen: 0 });
    return { organisaties: orgs, mensen, regel: 'Alleen naam, rol en of er een pagina is. Wat er op een persoonspagina staat, toont de app niet.' };
  }
  return null;
}

module.exports = { leesVault, route, bewaar, leesDb, SCHEMA, BRONNEN, isoDatum, tabellen, sectie, ontlink, eigenaren, donatiedoelen, statutenDoel, mijlpalen, bewakerKoppel, anbiStukken, bestuurEcg, bestuurGhawa };
