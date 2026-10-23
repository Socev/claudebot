'use strict';
// Ringkaart van Socev (wv888, 23-10-2026; bouwplan "01_Ontwikkeling/Ringkaart van Socev - tandwielweergave (bouwplan 23-10-2026).md").
// David: "een soort tandwielachtige weergave … helemaal centraal zijn main agent, daaromheen ondersteunende agents". De app tekent de
// ringen; deze module levert alleen de onderdelen die niet al via een bestaande route komen: de wachters (hartslagtabel, via de RPC
// mk_hartslag_stand die server.js aanroept), de skills (.claude/skills/*/SKILL.md in de vault) en de kanalen (tabel "## Kanaal" in
// 00_Systeem/Capaciteiten.md, alleen namen). Alles alleen lezen; geen netwerk, geen sleutels in dit bestand.
// Vaste plek (Fable wv888 #4): geen beschrijving van skills of wachters, alleen de kale naam (de omschrijvingen noemen o.a. gezondheid,
// bank en locatie).
const fs = require('fs');
const path = require('path');

const SKILL_BUF_MS = 10 * 60000, KOP_MAX = 8192, ZIN_MAX = 160, NAAM_MAX = 48;

// Eerste zin van een tekst, hooguit ZIN_MAX tekens (op een woordgrens).
function eersteZin(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  let z = m ? m[1] : s;
  if (z.length > ZIN_MAX) z = z.slice(0, ZIN_MAX).replace(/\s+\S*$/, '') + ' …';
  return z;
}

// Kleine frontmatter-lezer (Fable wv888 #8): name en description, ook gevouwen (>- / |) en tussen quotes.
function leesKop(tekst) {
  const t = String(tekst || '').replace(/^﻿/, '');
  if (!/^---\r?\n/.test(t)) return {};
  const eind = t.indexOf('\n---', 3);
  const regels = t.slice(t.indexOf('\n') + 1, eind < 0 ? t.length : eind).split(/\r?\n/);
  const uit = {};
  for (let i = 0; i < regels.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(regels[i]);
    if (!m) continue;
    let w = m[2].trim();
    if (/^[>|][+-]?$/.test(w)) {
      const stuk = [];
      while (i + 1 < regels.length && (/^\s/.test(regels[i + 1]) || regels[i + 1] === '')) stuk.push(regels[++i].trim());
      w = stuk.join(' ').trim();
    } else if (/^"/.test(w)) {
      try { w = JSON.parse(w); } catch (e) { w = w.replace(/^"|"$/g, '').replace(/\\"/g, '"'); }
    } else if (/^'/.test(w)) {
      w = w.replace(/^'|'$/g, '').replace(/''/g, "'");
    }
    uit[m[1]] = String(w);
  }
  return uit;
}

// Skills uit <vault>/.claude/skills/*/SKILL.md: [{n, zin, uit}], gesorteerd op naam. uit = vervallen of uitgezet.
function leesSkills(dir) {
  let mappen;
  try { mappen = fs.readdirSync(dir, { withFileTypes: true }).filter(function (e) { return e.isDirectory() && !e.name.startsWith('.'); }); }
  catch (e) { return null; }
  const uit = [];
  mappen.forEach(function (e) {
    const p = path.join(dir, e.name, 'SKILL.md');
    let kop = '';
    try {
      const fd = fs.openSync(p, 'r');
      try { const b = Buffer.alloc(KOP_MAX); const n = fs.readSync(fd, b, 0, KOP_MAX, 0); kop = b.slice(0, n).toString('utf8'); }
      finally { fs.closeSync(fd); }
    } catch (x) { return; }
    const k = leesKop(kop);
    const beschrijving = String(k.description || '').trim();
    uit.push({ n: e.name, zin: beschrijving ? eersteZin(beschrijving) : null, uit: /^(VERVALLEN|UIT)\b/.test(beschrijving) });
  });
  return uit.sort(function (a, b) { return a.n.localeCompare(b.n); });
}

// Kanalen uit de tabel onder "## Kanaal" in het capaciteitenregister: de kolom Capaciteit tot " — " of " (", ontdubbeld.
function leesKanalen(tekst) {
  const regels = String(tekst || '').split(/\r?\n/);
  const start = regels.findIndex(function (r) { return /^##\s+Kanaal\b/.test(r); });
  if (start < 0) return null;
  const uit = [];
  for (let i = start + 1; i < regels.length && !/^##\s/.test(regels[i]); i++) {
    const r = regels[i];
    if (!/^\|/.test(r) || /^\|\s*-/.test(r) || /^\|\s*Sleutel\s*\|/.test(r)) continue;
    const kol = r.split('|').map(function (x) { return x.trim(); });
    const naam = String(kol[2] || '').split(/\s+—\s+|\s+\(/)[0].replace(/[*_`]/g, '').trim();
    if (naam && uit.indexOf(naam) < 0) uit.push(naam.slice(0, NAAM_MAX));
  }
  return uit;
}

// Leesbare naam van een wachter uit de omschrijving: zonder "AI - ", tot de eerste "," of ":" (niet binnen haakjes), zonder
// haakjesgroep met een id (Fable wv888 #7: groep tussen haakjes blijft, want "Voorwerk (acties)" ≠ "Voorwerk (ochtendblok)").
function wachterNaam(omschrijving, component) {
  let s = String(omschrijving || '').replace(/^\s*AI\s*-\s*/, '');
  let diep = 0, cut = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') diep++;
    else if (c === ')') diep = Math.max(0, diep - 1);
    else if (diep === 0 && (c === ',' || c === ':' || (c === ' ' && s[i + 1] === '-' && s[i + 2] === '>'))) { cut = i; break; }
  }
  s = s.slice(0, cut);
  // haakjesgroep die een workflow noemt ("(AI - Locatie (Tasker))"), ook genest, helemaal weg
  for (let i = s.indexOf('('); i >= 0; i = s.indexOf('(', i + 1)) {
    if (!/^\(\s*AI\s*-/.test(s.slice(i))) continue;
    let d = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === '(') d++; else if (s[j] === ')' && --d === 0) break; }
    s = s.slice(0, i) + s.slice(j + 1);
    i = Math.max(-1, i - 2);
  }
  s = s
    .replace(/\s*\(([^()]*)\)/g, function (m, binnen) { return /[A-Za-z0-9]{12,}/.test(binnen) && /\d/.test(binnen) && /[A-Za-z]/.test(binnen) ? '' : m; })
    .replace(/\s+/g, ' ').trim();
  if (!s) s = String(component || '?');
  // te lang: eerst de haakjesgroep weg ("Teams meelezen op de praktijk-pc (Taakplanner elke 15 min)"), dan pas afkappen
  if (s.length > NAAM_MAX && s.indexOf(' (') > 0) s = s.slice(0, s.indexOf(' ('));
  if (s.length > NAAM_MAX) s = s.slice(0, NAAM_MAX).replace(/\s+\S*$/, '') + ' …';
  return s;
}

// Rijen van mk_hartslag_stand → [{c, naam, oordeel, min, drempel, laatst}]. Proefrijen weg. Dubbele naam → component erachter.
function wachters(rijen, vast) {
  const l = (Array.isArray(rijen) ? rijen : []).filter(function (r) { return r && r.component && !/proef/i.test(r.component); }).map(function (r) {
    return { c: String(r.component).slice(0, 60), naam: vast ? String(r.component).slice(0, 60) : wachterNaam(r.omschrijving, r.component),
      oordeel: ['vers', 'te_laat', 'nooit', 'onbeoordeelbaar'].indexOf(r.oordeel) >= 0 ? r.oordeel : 'onbeoordeelbaar',
      min: typeof r.minuten_sinds === 'number' ? r.minuten_sinds : null, drempel: typeof r.drempel_min === 'number' ? r.drempel_min : null,
      laatst: r.laatste_ronde ? new Date(r.laatste_ronde).toISOString() : null };
  });
  const tel = {};
  l.forEach(function (w) { tel[w.naam] = (tel[w.naam] || 0) + 1; });
  l.forEach(function (w) { if (tel[w.naam] > 1) w.naam = (w.naam + ' · ' + w.c).slice(0, NAAM_MAX + 20); });
  return l.sort(function (a, b) { return a.c.localeCompare(b.c); });
}

function maak(opt) {
  const vault = opt.vault;
  const skillDir = path.join(vault, '.claude', 'skills'), capPad = path.join(vault, '00_Systeem', 'Capaciteiten.md');
  let skillBuf = null, kanaalBuf = null;
  function skills() {
    const nu = Date.now();
    if (skillBuf && nu - skillBuf.t < SKILL_BUF_MS) return skillBuf.l;
    const l = leesSkills(skillDir);
    skillBuf = { t: nu, l: l };
    return l;
  }
  function kanalen() {
    let m;
    try { m = fs.statSync(capPad).mtimeMs; } catch (e) { return null; }
    if (kanaalBuf && kanaalBuf.m === m) return kanaalBuf.l;
    let l = null;
    try { l = leesKanalen(fs.readFileSync(capPad, 'utf8')); } catch (e) { l = null; }
    kanaalBuf = { m: m, l: l };
    return l;
  }
  // rijen: uitkomst van mk_hartslag_stand (of null bij een fout); vast: vaste plek
  function stand(rijen, vast) {
    const s = skills(), k = kanalen();
    const fout = {};
    if (!s) fout.skills = 'de skills zijn nu niet te lezen';
    if (!k) fout.kanalen = 'het capaciteitenregister is nu niet te lezen';
    if (!rijen) fout.wachters = 'de hartslag van de wachters is nu niet te lezen';
    return { ok: true, vaste_plek: !!vast,
      wachters: rijen ? wachters(rijen, vast) : [],
      skills: (s || []).map(function (x) { return { n: x.n, zin: vast ? null : x.zin, uit: x.uit }; }),
      kanalen: k || [], fout: Object.keys(fout).length ? fout : null };
  }
  return { stand: stand, skills: skills, kanalen: kanalen };
}

module.exports = { maak: maak, leesKop: leesKop, leesSkills: leesSkills, leesKanalen: leesKanalen, wachterNaam: wachterNaam, wachters: wachters, eersteZin: eersteZin };
