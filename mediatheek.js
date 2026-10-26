'use strict';
// Mediatheek (wv1269, 26-10-2026; opdracht David 24-10 17:02, box-rij "Opdracht David: Mediatheek-app in de Socev-app").
// WAAROM. David (24-10): "Leuk die mediatheek, hebben we er al een app voor die het inzichtelijk maakt?" Hij wil liedjes en andere
// artistieke uitingen (eerst de Shizzle-liedjes) zelf terugvinden en afspelen, niet alleen via Socev op afroep; de tab Bestanden
// bewaart maar 30 dagen. Deze module leest de vaultpagina 20_Prive/Mediatheek.md (Socev schrijft die, "bewaar in de mediatheek") en
// geeft de App een lijst per onderwerp (titel, wie, datum, omschrijving) en, per link op die pagina, het bestand zelf.
//
// Padcontrole (opdracht: "geen bestand buiten de mediatheek-links bereikbaar"):
// - M1 alleen een bestand waar de pagina met een wikilink of markdown-link naar wijst; de App vraagt het op met een id (de
//   sha256 van het pad, 16 hex); een pad van buiten wordt nooit aangenomen.
// - M2 het doel ligt onder dezelfde bovenmap als de pagina (20_Prive): een link naar 10_Zakelijk (personeelsgesprekken, Plaud-opnames)
//   of 00_Systeem levert niets op, ook als iemand hem op de pagina zet. Geen punt-mappen, geen '..', geen absoluut pad.
// - M3 alleen de extensies hieronder (geluid om af te spelen, een paar soorten om te downloaden); geen md/html/svg/code.
// - M4 realpath binnen de vault én binnen die bovenmap, lstat: gewoon bestand, geen symlink; hooguit 20 MB (base64 in JSON).
// Alles alleen lezen; de module schrijft niets. Op een apparaat met een vaste plek gaat de App niet open (server.js, privé-module).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGINA = '20_Prive/Mediatheek.md';
const MAX_PAGINA = 1024 * 1024;
const MAX_BESTAND = 20 * 1024 * 1024;
const AUDIO = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg' };
// alleen downloaden (beeld en video krijgen later een eigen weergave; geparkeerd als beeldbank, Ideeënbus § 22)
const ANDERS = { pdf: 'application/pdf', flp: 'application/octet-stream', mid: 'audio/midi', midi: 'audio/midi',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };

const extVan = (p) => { const m = /\.([a-z0-9]{1,5})$/i.exec(p); return m ? m[1].toLowerCase() : ''; };
const idVan = (p) => crypto.createHash('sha256').update(p, 'utf8').digest('hex').slice(0, 16);

// Doel van een link → vaultpad of null (M2/M3 nog niet: dat doet zoekBestand). Obsidian: [[pad#kop|alias]], ook [[pad\|alias]] in tabellen.
function schoonDoel(t) {
  let p = String(t || '').split('|')[0].replace(/\\$/, '').split('#')[0].trim();
  try { if (/%[0-9a-f]{2}/i.test(p)) p = decodeURIComponent(p); } catch (e) { return null; }
  p = p.replace(/\\/g, '/').normalize('NFC');
  if (!p || p.length > 600 || p.indexOf('\u0000') >= 0 || p[0] === '/' || /^[a-z]+:/i.test(p)) return null;
  if (p.split('/').some((s) => s === '..' || s === '.' || s === '' || s[0] === '.')) return null;
  return p;
}

// Links in een stuk tekst: [[doel|alias]] en [alias](doel). Geeft { doel, naam, van, tot }.
function links(t) {
  const uit = [];
  const re = /\[\[([^\]\n]+?)\]\]|\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1] !== undefined) {
      const delen = m[1].split('|');
      uit.push({ doel: delen[0], naam: delen.length > 1 ? delen.slice(1).join('|').trim() : '', van: m.index, tot: re.lastIndex });
    } else uit.push({ doel: m[3].replace(/^<|>$/g, ''), naam: m[2].trim(), van: m.index, tot: re.lastIndex });
  }
  return uit;
}

// Markdown naar platte tekst voor de App (die toont alles als tekst): links → hun naam, *, _ en ` weg.
function plat(t) {
  return String(t)
    .replace(/\[\[([^\]\n]+?)\]\]/g, (_, x) => { const d = x.split('|'); return (d.length > 1 ? d.slice(1).join('|') : d[0].split('/').pop()).trim(); })
    .replace(/\[([^\]\n]*)\]\(([^)\n]+)\)/g, '$1')
    .replace(/\*\*|__|`/g, '').replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ').trim();
}

const MAANDEN = { jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12 };
function datumIso(s) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return m[0];
  m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}

// Eén opsommingsregel (met vervolgregels samengevoegd) → item. Vorm (Mediatheek.md): **"Titel"** — Wie, datum; omschrijving. Bestand [[…|mp3]].
function leesItem(ruw) {
  const t = ruw.replace(/\s+/g, ' ').trim();
  const kop = /^\*\*(.+?)\*\*\s*/.exec(t);
  let titel, rest;
  if (kop) { titel = kop[1]; rest = t.slice(kop[0].length); } else { titel = null; rest = t; }
  const ls = links(rest);
  const bestanden = [], paginas = [];
  for (const l of ls) {
    const p = schoonDoel(l.doel);
    if (!p) continue;
    const ext = extVan(p);
    if (AUDIO[ext] || ANDERS[ext]) bestanden.push({ pad: p, ext: ext, label: l.naam || ext });
    else if (!ext || ext === 'md') paginas.push({ pad: /\.md$/i.test(p) ? p : p + '.md', naam: plat(l.naam || p.split('/').pop()) });
  }
  // "Bestand [[…]]" / "Bestanden [[…]] en [[…]]" hoort niet in de omschrijving: de App toont de knoppen
  let tekst = rest.replace(/\s*\bBestand(en)?\b:?\s*((\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\))(\s*(,|en|of)\s*)?)+\.?/g, (x) => {
    return links(x).every((l) => { const p = schoonDoel(l.doel); const e = p ? extVan(p) : ''; return !!(AUDIO[e] || ANDERS[e]); }) ? '' : x;
  });
  let noot = null;
  const nm = /\*Nog geen bestand:?\*:?\s*(.*)$/i.exec(tekst);
  if (nm) { noot = plat(nm[1]) || null; tekst = tekst.slice(0, nm.index); }
  tekst = tekst.replace(/^[—–-]\s*/, '');
  let wie = null, datum = null, datumTekst = null;
  const wd = /^([^,;.]{1,60}?),\s*(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}-\d{4})\s*[.;:]?\s*/.exec(tekst);
  if (wd) { wie = plat(wd[1]); datumTekst = wd[2]; datum = datumIso(wd[2]); tekst = tekst.slice(wd[0].length); }
  const omschrijving = plat(tekst).replace(/[;,]\s*$/, '').replace(/^[;,.]\s*/, '');
  return {
    titel: plat(titel || '').replace(/^["“”„']+|["“”„']+$/g, '') || (bestanden[0] ? bestanden[0].pad.split('/').pop() : plat(t).slice(0, 80)),
    wie: wie, datum: datum, datum_tekst: datumTekst && !datum ? datumTekst : null,
    omschrijving: omschrijving || null, noot: noot, bestanden: bestanden, paginas: paginas,
  };
}

// Pagina → { onderwerpen: [{ naam, uitleg, items }], intro }. Alleen ## koppen; ### valt onder het lopende onderwerp.
function leesPagina(md) {
  let t = String(md).replace(/\r\n?/g, '\n');
  if (t.startsWith('---\n')) { const e = t.indexOf('\n---', 4); if (e > 0) t = t.slice(t.indexOf('\n', e + 1) + 1); }
  const onderwerpen = [];
  let huidig = null, item = null, para = [];
  const sluitItem = () => { if (item !== null && huidig) huidig.items.push(leesItem(item)); item = null; };
  const sluitPara = () => { if (para.length && huidig) { const p = plat(para.join(' ')); if (p) huidig.uitleg.push(p); } para = []; };
  for (const regel of t.split('\n')) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(regel);
    if (h && !/^###/.test(regel)) {
      sluitItem(); sluitPara();
      huidig = { naam: plat(h[1]), uitleg: [], items: [] };
      onderwerpen.push(huidig);
      continue;
    }
    if (!huidig) continue;   // kop en uitleg boven het eerste onderwerp zijn voor Socev
    const b = /^[-*+]\s+(.*)$/.exec(regel);
    if (b) { sluitPara(); sluitItem(); item = b[1]; continue; }
    if (item !== null && /^\s{2,}\S/.test(regel)) { item += ' ' + regel.trim(); continue; }
    if (!regel.trim()) { sluitItem(); sluitPara(); continue; }
    sluitItem();
    if (/^#{3,}\s/.test(regel)) { sluitPara(); continue; }
    para.push(regel.trim());
  }
  sluitItem(); sluitPara();
  return onderwerpen.filter((o) => o.items.length || o.uitleg.length);
}

function maak(opt) {
  const VAULT = opt.vault;
  const PAD = opt.pagina || PAGINA;
  const TOP = PAD.split('/')[0];
  const fout = opt.fout || function () {};
  let echteVault = null, echteTop = null;

  function echt() {
    if (!echteVault) echteVault = fs.realpathSync(VAULT);
    if (!echteTop) {
      const t = fs.realpathSync(path.join(VAULT, TOP));
      if (t !== path.join(echteVault, TOP)) throw new Error('bovenmap is een koppeling');   // 20_Prive zelf mag nergens anders heen wijzen
      echteTop = t;
    }
    return { vault: echteVault, top: echteTop };
  }

  // M2–M4: pad van een link → { abs, grootte } of { weg: reden }
  function zoekBestand(p) {
    if (p.split('/')[0] !== TOP || p.indexOf('/') < 0) return { weg: 'buiten' };
    const ext = extVan(p);
    if (!AUDIO[ext] && !ANDERS[ext]) return { weg: 'soort' };
    let abs = path.join(VAULT, p);
    try {
      let st;
      try { st = fs.lstatSync(abs); }
      catch (e) {
        // de schijf kan een naam in NFD hebben (macOS/Drive); probeer die vorm ook
        const nfd = path.join(VAULT, p.normalize('NFD'));
        st = fs.lstatSync(nfd); abs = nfd;
      }
      if (st.isSymbolicLink() || !st.isFile()) return { weg: 'geen bestand' };
      const e = echt();
      const r = fs.realpathSync(abs);
      if (r.indexOf(e.vault + path.sep) !== 0 || r.indexOf(e.top + path.sep) !== 0) return { weg: 'buiten' };
      return { abs: r, grootte: st.size, m: st.mtimeMs };
    } catch (e) { return { weg: 'ontbreekt' }; }
  }

  function lijst() {
    let md, st;
    try {
      st = fs.statSync(path.join(VAULT, PAD));
      if (!st.isFile() || st.size > MAX_PAGINA) return { ok: false, fout: 'de mediatheekpagina is niet te lezen' };
      md = fs.readFileSync(path.join(VAULT, PAD), 'utf8');
    } catch (e) { return { ok: false, fout: 'de mediatheekpagina staat niet op de verwachte plek' }; }
    const onderwerpen = leesPagina(md);
    const perId = new Map();
    let n = 0, nb = 0, nweg = 0;
    const uit = onderwerpen.map(function (o) {
      return { naam: o.naam, uitleg: o.uitleg, items: o.items.map(function (it) {
        n++;
        const bs = [];
        for (const b of it.bestanden) {
          const z = zoekBestand(b.pad);
          if (z.weg === 'buiten' || z.weg === 'soort') continue;   // M2/M3: bestaat voor de App niet
          const id = idVan(b.pad);
          const soort = AUDIO[b.ext] ? 'audio' : 'bestand';
          const rij = { id: id, naam: b.pad.split('/').pop(), ext: b.ext, soort: soort, label: plat(b.label),
            grootte: z.abs ? z.grootte : null, ontbreekt: !z.abs, te_groot: !!(z.abs && z.grootte > MAX_BESTAND) };
          if (z.abs) { perId.set(id, { pad: b.pad, abs: z.abs, ext: b.ext, grootte: z.grootte }); nb++; } else nweg++;
          if (!bs.some((x) => x.id === id)) bs.push(rij);
        }
        const ps = it.paginas.filter((p) => p.pad.split('/')[0] === TOP).map((p) => ({ pad: p.pad, naam: p.naam }));
        return { titel: it.titel, wie: it.wie, datum: it.datum, datum_tekst: it.datum_tekst, omschrijving: it.omschrijving, noot: it.noot,
          bestanden: bs, paginas: ps };
      }) };
    });
    return { ok: true, pagina: PAD, bijgewerkt: new Date(st.mtimeMs).toISOString(), onderwerpen: uit,
      tel: { items: n, bestanden: nb, ontbreekt: nweg }, _perId: perId };
  }

  // M1: alleen een id uit de lijst van dít moment (de pagina wordt elke keer opnieuw gelezen)
  function bestand(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id)) return { status: 404, j: { ok: false, fout: 'dit bestand is er niet (meer)' } };
    const l = lijst();
    if (!l.ok) return { status: 503, j: { ok: false, fout: l.fout } };
    const b = l._perId.get(id);
    if (!b) return { status: 404, j: { ok: false, fout: 'dit bestand staat niet (meer) in de mediatheek' } };
    if (b.grootte > MAX_BESTAND) return { status: 413, j: { ok: false, fout: 'te groot voor de app (meer dan 20 MB)' } };
    try {
      const buf = fs.readFileSync(b.abs);
      if (buf.length > MAX_BESTAND) return { status: 413, j: { ok: false, fout: 'te groot voor de app (meer dan 20 MB)' } };
      return { status: 200, ext: b.ext, j: { ok: true, naam: b.pad.split('/').pop(), type: AUDIO[b.ext] || ANDERS[b.ext], grootte: buf.length,
        inhoud: buf.toString('base64') } };
    } catch (e) { fout('mediatheek-bestand', e); return { status: 404, j: { ok: false, fout: 'niet te lezen' } }; }
  }

  function stand() {
    const l = lijst();
    if (!l.ok) return { status: 503, j: { ok: false, fout: l.fout } };
    const j = Object.assign({}, l);
    delete j._perId;
    return { status: 200, j: j };
  }

  function health() {
    const l = lijst();
    return l.ok ? { aan: true, pagina: true, items: l.tel.items, bestanden: l.tel.bestanden, ontbreekt: l.tel.ontbreekt } : { aan: true, pagina: false };
  }

  return { stand: stand, bestand: bestand, health: health, lijst: lijst };
}

module.exports = { maak: maak, leesPagina: leesPagina, leesItem: leesItem, schoonDoel: schoonDoel, plat: plat, idVan: idVan, AUDIO: AUDIO, ANDERS: ANDERS, MAX_BESTAND: MAX_BESTAND };
