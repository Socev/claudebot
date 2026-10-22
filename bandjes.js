'use strict';
// Bandjes (wv739, 22-10-2026; bouwplan "01_Ontwikkeling/Bandjes - mini-app voor telefoonbandjes (bouwplan 22-10-2026).md").
// Het register van de telefoonbandjes van Tolgaarde en Groenhouten staat in de vault (één markdownpagina per praktijk, door David in
// Obsidian leesbaar en bewerkbaar). Deze module leest en schrijft die pagina's; server.js koppelt de routes /app/bandjes/* en
// /smal/bandjes/* (rij B) en geeft het inspreken door aan studio.js. Alles hier is synchroon (fs.*Sync): lezen-toetsen-schrijven loopt
// zonder await ertussen, dus twee verzoeken kunnen elkaar niet halverwege raken.
//
// Regels uit de Fable-review vooraf (bouwplan § 9):
// - lezer tolerant, schrijver strikt (#3): kop met —, – of -, veldnamen zonder hoofdlettergevoel, lege regel in het citaat telt mee;
//   dubbel id of verkeerd voorvoegsel = pagina alleen-lezen met reden, nooit "de eerste pakken".
// - versie én tekst_hash bij elke schrijfactie (#2): David hoogt in Obsidian de versie niet op.
// - de vault synct met rclone bisync (--conflict-resolve newer): een journaal buiten de vault ziet een teruggezette versie, een
//   Bandjes.md.conflict* naast de pagina zet schrijven dicht (#1).
// - tijdelijk bestand buiten de vault, rename op dezelfde schijf, rechten 0644 (#4).
// Geen patiëntgegevens: een bandje gaat over de praktijk. Teksten ≤ 1.500 tekens, zonder stuurtekens.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SPREEK = require('./spreektekst.js');   // wv803

const PRAKTIJKEN = {
  tolgaarde: { naam: 'Tolgaarde', pad: '10_Zakelijk/Tolgaarde/Telefoon/Bandjes.md', voorvoegsel: 'tg' },
  groenhouten: { naam: 'Groenhouten', pad: '10_Zakelijk/Groenhouten/Telefoon/Bandjes.md', voorvoegsel: 'gh' },
};
const GRENS = { tekst: 1500, naam: 60, veld: 160, reden: 300 };
const ONBEKEND = '(onbekend — wacht op het huidige bandje)';
const KOP_RE = /^##\s+([a-z0-9][a-z0-9-]*[a-z0-9])\s+[—–-]\s+(.+?)\s*$/i;
const ID_RE = /^(tg|gh)-[a-z0-9-]{2,30}$/;
const VELD_RE = /^-\s+([^:]{1,40}):\s?(.*)$/;
const TEKST_RE = /^\*\*Tekst\*\*\s*$/i;
const VOORSTEL_RE = /^\*\*Voorstel van Socev\*\*\s*(.*)$/i;
// wv803: eigen spreektekst van David (wat de stem zegt), gebonden aan de tekst_hash van de geschreven tekst waar hij bij hoort
const SPREEK_RE = /^\*\*Spreektekst\*\*\s*(.*)$/i;
const SPREEK_MAX = SPREEK.MAX;   // uitgeschreven nummers maken de spreektekst ± 2× zo lang als de tekst

function schoon(t, max) {
  return String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, max);
}
function eenRegel(t, max) { return schoon(t, max * 2).replace(/\s*\n\s*/g, ' ').trim().slice(0, max); }
// Genormaliseerde tekst (Fable #2): CRLF → LF, spaties aan het regeleinde weg, lege regels aan begin en eind weg.
function normTekst(t) {
  return String(t == null ? '' : t).replace(/\r\n?/g, '\n').split('\n').map(function (r) { return r.replace(/\s+$/, ''); })
    .join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
}
function tekstHash(t) { return crypto.createHash('sha256').update(normTekst(t), 'utf8').digest('hex').slice(0, 16); }
function vandaag(klok) { const d = new Date(klok ? klok() : Date.now()); return d.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', year: 'numeric' }).replace(/\//g, '-'); }
function vandaagIso(klok) { return new Date(klok ? klok() : Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }

// ── lezen ──
// Geeft { instellingen, bandjes: [{ id, naam, velden, tekst, onbekend, versie, voorstel, van, tot }], fouten, regels }.
// van/tot = regelnummers van de sectie (tot exclusief), voor de schrijver.
function parse(md, voorvoegsel) {
  const regels = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (regels[0] === '---') { i = 1; while (i < regels.length && regels[i] !== '---') i++; i++; }
  const uit = { instellingen: {}, bandjes: [], fouten: [], regels: regels, frontmatterTot: i };
  let huidig = null, sectie = null, modus = null, blok = null;
  const sluit = function (eind) {
    if (huidig) {
      huidig.tot = eind;
      afrondBandje(huidig);
      uit.bandjes.push(huidig);
    }
    huidig = null; modus = null; blok = null;
  };
  for (; i < regels.length; i++) {
    const r = regels[i];
    if (/^##\s/.test(r)) {
      sluit(i);
      const m = KOP_RE.exec(r);
      if (m && /^(tg|gh)-/i.test(m[1])) {
        huidig = { id: m[1].toLowerCase(), naam: m[2], velden: {}, tekstRegels: null, voorstelRegels: null, voorstelKop: '', spreekRegels: null, spreekKop: '', van: i, tot: null };
        sectie = 'bandje';
      } else sectie = /^##\s+praktijkinstellingen\s*$/i.test(r) ? 'instellingen' : 'overig';
      continue;
    }
    if (sectie === 'instellingen') {
      const v = VELD_RE.exec(r);
      if (v) uit.instellingen[v[1].trim().toLowerCase()] = v[2].trim();
      continue;
    }
    if (!huidig) continue;
    if (TEKST_RE.test(r)) { modus = 'tekst'; blok = huidig.tekstRegels = []; continue; }
    const vm = VOORSTEL_RE.exec(r);
    if (vm) { modus = 'voorstel'; blok = huidig.voorstelRegels = []; huidig.voorstelKop = vm[1].trim(); continue; }
    const sm = SPREEK_RE.exec(r);
    if (sm) { modus = 'spreek'; blok = huidig.spreekRegels = []; huidig.spreekKop = sm[1].trim(); continue; }
    if (modus) {
      if (/^>/.test(r)) { blok.push(r.replace(/^>\s?/, '')); continue; }
      if (r.trim() === '') { blok.push(''); continue; }
      modus = null; blok = null;   // ander proza na het citaat: einde blok, regel blijft staan
      continue;
    }
    const v = VELD_RE.exec(r);
    if (v) { const k = v[1].trim().toLowerCase(); if (!(k in huidig.velden)) huidig.velden[k] = v[2].trim(); }
  }
  sluit(regels.length);
  // fouten: dubbel id, verkeerd voorvoegsel, ongeldig id
  const gezien = {};
  uit.bandjes.forEach(function (b) {
    if (!ID_RE.test(b.id)) uit.fouten.push('ongeldig id "' + b.id + '"');
    else if (voorvoegsel && b.id.indexOf(voorvoegsel + '-') !== 0) uit.fouten.push('id "' + b.id + '" hoort niet bij deze praktijk (verwacht ' + voorvoegsel + '-…)');
    if (gezien[b.id]) uit.fouten.push('id "' + b.id + '" staat er twee keer');
    gezien[b.id] = true;
  });
  return uit;
}
function afrondBandje(b) {
  const tekst = b.tekstRegels ? normTekst(b.tekstRegels.join('\n')) : '';
  b.onbekend = !tekst || /^\(onbekend\b/i.test(tekst);
  b.tekst = b.onbekend ? '' : tekst;
  b.hash = tekstHash(b.tekst);
  const v = parseInt(b.velden.versie, 10);
  b.versie = Number.isFinite(v) && v >= 0 ? v : 0;
  const vt = b.voorstelRegels ? normTekst(b.voorstelRegels.join('\n')) : '';
  b.voorstel = vt ? { tekst: vt, kop: b.voorstelKop } : null;
  const st = b.spreekRegels ? normTekst(b.spreekRegels.join('\n')) : '';
  const bij = /\b([a-f0-9]{16})\b/.exec(b.spreekKop || '');
  b.spreek = st ? { tekst: st, bij: bij ? bij[1] : null } : null;
  delete b.tekstRegels; delete b.voorstelRegels; delete b.voorstelKop; delete b.spreekRegels; delete b.spreekKop;
}
// Voor de app: zonder regelnummers.
function bandjeUit(b) {
  const v = b.velden;
  return { id: b.id, naam: b.naam, menu: v.menu || '', wanneer: v.wanneer || '', tijdvensters: v.tijdvensters || '', stem: v.stem || 'praktijkstem',
    versie: b.versie, tekst: b.tekst, onbekend: b.onbekend, tekst_hash: b.hash, status: v.status || '', laatste_bestand: v['laatste bestand'] || '',
    in_centrale: v['in centrale'] || '', bron: v.bron || '', aandachtspunt: v.aandachtspunt || '', voorstel: b.voorstel, spreek_eigen: b.spreek || null };
}

// ── schrijven (strikt) ──
function citaat(tekst) { return normTekst(tekst).split('\n').map(function (r) { return r ? '> ' + r : '>'; }); }
function zoek(p, id) { return p.bandjes.find(function (b) { return b.id === id; }); }
// Past de sectie van b ter plekke aan (Fable #3: de rest blijft byte-voor-byte staan): veldwaarden op hun eigen regel, nieuwe velden
// onder het laatste veld, het citaat onder **Tekst** en het blok **Voorstel van Socev** (weg bij null, nieuw direct onder de tekst).
function blokEind(r, start) {   // index ná de laatste citaatregel vanaf start (lege regels tellen alleen mee als er nog citaat volgt)
  let eind = start, k = start;
  while (k < r.length && (/^>/.test(r[k]) || r[k].trim() === '') && !/^##\s/.test(r[k])) { if (/^>/.test(r[k])) eind = k + 1; k++; }
  return eind;
}
function herschrijfSectie(p, b, w) {
  let r = p.regels.slice(b.van, b.tot);
  // velden
  let laatsteVeld = 0;
  const vast = {};
  for (let k = 1; k < r.length; k++) {
    if (TEKST_RE.test(r[k]) || VOORSTEL_RE.test(r[k]) || SPREEK_RE.test(r[k])) break;
    const m = VELD_RE.exec(r[k]);
    if (!m) continue;
    laatsteVeld = k;
    const sleutel = m[1].trim().toLowerCase();
    if (w.velden && sleutel in w.velden && !vast[sleutel]) { r[k] = '- ' + m[1].trim() + ': ' + eenRegel(w.velden[sleutel], GRENS.veld); vast[sleutel] = true; }
  }
  const erbij = Object.keys(w.velden || {}).filter(function (k) { return !vast[k]; }).map(function (k) { return '- ' + k + ': ' + eenRegel(w.velden[k], GRENS.veld); });
  if (erbij.length) { const at = laatsteVeld || 0; r = r.slice(0, at + 1).concat(erbij, r.slice(at + 1)); }
  // tekst
  if (w.tekst !== undefined) {
    const nieuw = w.tekst ? citaat(w.tekst) : ['> ' + ONBEKEND];
    let m = r.findIndex(function (x) { return TEKST_RE.test(x); });
    if (m < 0) {
      let at = r.length; while (at > 1 && r[at - 1].trim() === '') at--;
      r = r.slice(0, at).concat(['', '**Tekst**'], nieuw, r.slice(at));
    } else {
      // wv803 (Fable #1): even tolerant als de lezer — elk aantal lege regels tussen kop en citaat (anders blijft het citaat als wees
      // staan en leest de lezer het als deel van het blok erboven, bv. een oude spreektekst als bandjestekst)
      let s = m + 1; while (s < r.length && r[s].trim() === '') s++;
      const e = /^>/.test(r[s] || '') ? blokEind(r, s) : m + 1;
      r = r.slice(0, m + 1).concat(nieuw, r.slice(e));
    }
  }
  // voorstel
  if (w.voorstel !== undefined) {
    const m = r.findIndex(function (x) { return VOORSTEL_RE.test(x); });
    if (m >= 0) {
      let s = m + 1; while (s < r.length && r[s].trim() === '') s++;
      const e = /^>/.test(r[s] || '') ? blokEind(r, s) : m + 1;
      let begin = m; if (begin > 0 && r[begin - 1].trim() === '') begin--;
      r = r.slice(0, begin).concat(r.slice(e));
    }
    if (w.voorstel) {
      const blok = ['', '**Voorstel van Socev**' + (w.voorstel.kop ? ' ' + eenRegel(w.voorstel.kop, GRENS.reden + 40) : '')].concat(citaat(w.voorstel.tekst));
      const tm = r.findIndex(function (x) { return TEKST_RE.test(x); });
      let at;
      if (tm >= 0) { let s = tm + 1; while (s < r.length && r[s].trim() === '') s++; at = /^>/.test(r[s] || '') ? blokEind(r, s) : tm + 1; }
      else { at = r.length; while (at > 1 && r[at - 1].trim() === '') at--; }
      r = r.slice(0, at).concat(blok, r.slice(at));
    }
  }
  // spreektekst (wv803): zelfde vorm als het voorstel; nieuw direct onder de tekst
  if (w.spreek !== undefined) {
    const m = r.findIndex(function (x) { return SPREEK_RE.test(x); });
    if (m >= 0) {
      let s = m + 1; while (s < r.length && r[s].trim() === '') s++;
      const e = /^>/.test(r[s] || '') ? blokEind(r, s) : m + 1;
      let begin = m; if (begin > 0 && r[begin - 1].trim() === '') begin--;
      r = r.slice(0, begin).concat(r.slice(e));
    }
    if (w.spreek) {
      const blok = ['', '**Spreektekst** ' + eenRegel(w.spreek.kop, 120)].concat(citaat(w.spreek.tekst));
      const tm = r.findIndex(function (x) { return TEKST_RE.test(x); });
      let at;
      if (tm >= 0) { let s = tm + 1; while (s < r.length && r[s].trim() === '') s++; at = /^>/.test(r[s] || '') ? blokEind(r, s) : tm + 1; }
      else { at = r.length; while (at > 1 && r[at - 1].trim() === '') at--; }
      r = r.slice(0, at).concat(blok, r.slice(at));
    }
  }
  return r;
}
function vervangSectie(p, b, nieuw) {
  const regels = p.regels.slice(0, b.van).concat(nieuw, p.regels.slice(b.tot));
  return regels;
}
function zetUpdated(regels, klok) {
  if (regels[0] !== '---') return regels;
  for (let i = 1; i < regels.length && regels[i] !== '---'; i++) if (/^updated:\s/.test(regels[i])) { regels[i] = 'updated: ' + vandaagIso(klok); break; }
  return regels;
}
function voegGeschiedenisToe(regels, regelsNieuw) {
  let i = regels.findIndex(function (r) { return /^##\s+versiegeschiedenis\s*$/i.test(r); });
  if (i < 0) { while (regels.length && regels[regels.length - 1] === '') regels.pop(); regels.push('', '## Versiegeschiedenis', ''); i = regels.length - 2; }
  let eind = i + 1; while (eind < regels.length && !/^##\s/.test(regels[eind])) eind++;
  const binnen = regels.slice(i + 1, eind).filter(function (r) { return !/^\(nog geen versies\)\s*$/.test(r); });
  while (binnen.length && binnen[binnen.length - 1] === '') binnen.pop();
  while (binnen.length && binnen[0] === '') binnen.shift();
  const blok = [''].concat(binnen.length ? binnen.concat(['']) : [], regelsNieuw, ['']);
  return regels.slice(0, i + 1).concat(blok, regels.slice(eind));
}
function klaar(regels) { let t = regels.join('\n'); if (!/\n$/.test(t)) t += '\n'; return t; }
function toetsTekst(t) {
  const n = normTekst(schoon(t, GRENS.tekst + 1));
  if (!n.trim()) return { fout: 'de tekst is leeg' };
  if (n.length > GRENS.tekst) return { fout: 'de tekst is langer dan ' + GRENS.tekst + ' tekens' };
  // de lezer leest "(onbekend…" als "tekst nog niet bekend" (Fable wv743 #6): zo'n tekst zou stil leeg teruggelezen worden
  if (/^\(onbekend\b/i.test(n.trim())) return { fout: 'begin de tekst niet met "(onbekend"' };
  return { tekst: n };
}

// Nieuwe tekst bewaren (Bewaar in de app). o: { tekst, versie, tekst_hash, stem?, voorstel_weg? }. Geeft { md, bandje } of { fout, status }.
function zetTekst(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (Number(o.versie) !== b.versie || String(o.tekst_hash || '') !== b.hash) return { status: 409, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true };
  const t = toetsTekst(o.tekst);
  if (t.fout) return { status: 400, fout: t.fout };
  // wv743: alleen een andere stem = geen nieuwe versie (de versie volgt de tekst); voorstel_weg zonder tekstwijziging = alleen het blok weg
  const stem = o.stem ? eenRegel(o.stem, 80) : null;
  const stemWijzigt = !!stem && stem !== (b.velden.stem || 'praktijkstem');
  const tekstWijzigt = t.tekst !== b.tekst;
  const voorstelWeg = !!o.voorstel_weg && !!b.voorstel;
  if (!tekstWijzigt && !stemWijzigt && !voorstelWeg) return { status: 200, md: md, bandje: bandjeUit(b), ongewijzigd: true };
  const velden = {};
  if (tekstWijzigt) { velden.versie = String(b.versie + 1); velden.status = 'concept (v' + (b.versie + 1) + ')'; }
  if (stemWijzigt) velden.stem = stem;
  let regels = vervangSectie(p, b, herschrijfSectie(p, b, { velden: velden, tekst: tekstWijzigt ? t.tekst : undefined, voorstel: voorstelWeg ? null : undefined }));
  if (!b.onbekend && tekstWijzigt) regels = voegGeschiedenisToe(regels, ['### ' + b.id + ' v' + b.versie + ' — vervangen ' + vandaag(klok)].concat(citaat(b.tekst)));
  regels = zetUpdated(regels, klok);
  const uit = klaar(regels);
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
// Voorstel van Socev zetten (via /smal, rij B). Overschrijft een open voorstel; de tekst blijft ongemoeid.
function zetVoorstel(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  const t = toetsTekst(o.tekst);
  if (t.fout) return { status: 400, fout: t.fout };
  const kop = '(' + vandaag(klok) + (o.reden ? ', reden: ' + eenRegel(o.reden, GRENS.reden) : '') + ')';
  let regels = vervangSectie(p, b, herschrijfSectie(p, b, { voorstel: { tekst: t.tekst, kop: kop } }));
  const uit = klaar(zetUpdated(regels, klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
function haalVoorstelWeg(md, voorvoegsel, id, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (!b.voorstel) return { status: 200, md: md, bandje: bandjeUit(b), ongewijzigd: true };
  const uit = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { voorstel: null })), klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
// Eigen spreektekst bewaren (wv803). o: { versie, tekst_hash, spreektekst (string, of null = terug naar automatisch) }. De spreektekst
// hoort bij de tekst van dát moment (kop "(bij v<N>, tekst <hash>)"); wijzigt de tekst later, dan geldt hij als verouderd en maakt de
// pod weer de automatische (routes). Geen nieuwe versie: de versie volgt de geschreven tekst.
function zetSpreektekst(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (Number(o.versie) !== b.versie || String(o.tekst_hash || '') !== b.hash) return { status: 409, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true };
  if (b.onbekend || !b.tekst) return { status: 400, fout: 'bewaar eerst een tekst' };
  if (o.spreektekst === null) {
    if (!b.spreek) return { status: 200, md: md, bandje: bandjeUit(b), ongewijzigd: true };
    const uit0 = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { spreek: null })), klok));
    return { status: 200, md: uit0, bandje: bandjeUit(zoek(parse(uit0, voorvoegsel), id)) };
  }
  const n = normTekst(schoon(o.spreektekst, SPREEK_MAX + 1)).replace(/\n{2,}/g, '\n');
  if (!n.trim()) return { status: 400, fout: 'de spreektekst is leeg' };
  if (n.length > SPREEK_MAX) return { status: 400, fout: 'de spreektekst is langer dan ' + SPREEK_MAX + ' tekens' };
  if (b.spreek && b.spreek.tekst === n && b.spreek.bij === b.hash) return { status: 200, md: md, bandje: bandjeUit(b), ongewijzigd: true };
  const kop = '(bij v' + b.versie + ', tekst ' + b.hash + ', ' + vandaag(klok) + ')';
  const uit = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { spreek: { tekst: n, kop: kop } })), klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
// Losse velden (laatste bestand, in centrale, status) — alleen deze sleutels.
const VRIJE_VELDEN = ['laatste bestand', 'in centrale', 'status', 'stem'];
function zetVelden(md, voorvoegsel, id, velden, verwacht, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (verwacht && (Number(verwacht.versie) !== b.versie || (verwacht.tekst_hash && verwacht.tekst_hash !== b.hash))) return { status: 409, fout: 'dit bandje is intussen gewijzigd', gewijzigd: true };
  const v = {};
  Object.keys(velden || {}).forEach(function (k) { if (VRIJE_VELDEN.indexOf(k) >= 0) v[k] = velden[k]; });
  const uit = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { velden: v })), klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
function slug(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
}
// Nieuw bandje: id = voorvoegsel + slug van de naam, uniek gemaakt (-2, -3 …); vóór "## Historie…" of "## Versiegeschiedenis".
function nieuwBandje(md, voorvoegsel, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const naam = eenRegel(o.naam, GRENS.naam);
  if (!naam) return { status: 400, fout: 'geef het bandje een naam' };
  let basis = voorvoegsel + '-' + (slug(naam) || 'bandje');
  if (basis.length < 5) basis += '-bandje';
  let id = basis, n = 2;
  while (zoek(p, id)) id = basis + '-' + (n++);
  let tekst = null;
  if (o.tekst && String(o.tekst).trim()) { const t = toetsTekst(o.tekst); if (t.fout) return { status: 400, fout: t.fout }; tekst = t.tekst; }
  const sectie = ['## ' + id + ' — ' + naam, '- menu: ' + eenRegel(o.menu || '', GRENS.veld), '- wanneer: ' + eenRegel(o.wanneer || '', GRENS.veld),
    '- stem: praktijkstem', '- versie: ' + (tekst ? '1' : '0'), '- laatste bestand: —', '- status: ' + (tekst ? 'concept (v1)' : 'tekst onbekend'),
    '- bron: ' + (o.bron ? eenRegel(o.bron, 80) + ' ' : 'aangemaakt in de app ') + vandaag(klok), '', '**Tekst**'].concat(tekst ? citaat(tekst) : ['> ' + ONBEKEND], ['']);
  let at = p.regels.findIndex(function (r) { return /^##\s+(historie|versiegeschiedenis)\b/i.test(r); });
  if (at < 0) at = p.regels.length;
  const regels = zetUpdated(p.regels.slice(0, at).concat(sectie, p.regels.slice(at)), klok);
  const uit = klaar(regels);
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}

// Praktijkinstelling (praktijkstem, stemmen, model) in het blok "## Praktijkinstellingen"; ontbreekt het blok, dan vóór het eerste
// bandje (wv743). `stemmen` (wv757) is de lijst waaruit David per bandje kiest: items gescheiden door ';', elk 'naam (motor:id)', een
// kaal id zonder motor is ElevenLabs (afspraak met de mini-app, wv744). De schrijver is strikt: elk item moet zo te lezen zijn.
const INSTELLINGEN = ['praktijkstem', 'stemmen', 'model', 'uitspraak'];
const INSTELLING_MAX = { stemmen: 600, uitspraak: 1500 };   // wv803: uitspraaklijst ('woord = uitspraak; …', zie spreektekst.js)
const STEMITEM_RE = /^([^();:]{1,40}?)\s*\(\s*([A-Za-z0-9_.:\/-]{1,100})\s*\)$/;
function stemmenLijst(w) {
  return String(w || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean).map(function (x) {
    const m = STEMITEM_RE.exec(x);
    if (!m) return null;
    const id = m[2].indexOf(':') < 0 ? 'elevenlabs:' + m[2] : m[2];
    return STEM_RE.test(id) ? { naam: m[1].trim(), id: id } : null;
  });
}
function zetInstelling(md, voorvoegsel, sleutel, waarde, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  if (INSTELLINGEN.indexOf(sleutel) < 0) return { status: 400, fout: 'onbekende instelling' };
  let w = eenRegel(waarde, INSTELLING_MAX[sleutel] || 100);
  if (sleutel === 'stemmen') {
    const l = stemmenLijst(w);
    if (!l.length || l.indexOf(null) >= 0) return { status: 400, fout: "stemmen: elk item 'naam (motor:id)', gescheiden door ;" };
  }
  if (sleutel === 'uitspraak') {
    // vóór eenRegel toetsen (nieuwe regels zijn hier scheidingstekens) en dan als één regel met '; ' schrijven
    const ruw = schoon(waarde, INSTELLING_MAX.uitspraak + 200);
    const f = SPREEK.lijstFout(ruw);
    if (f) return { status: 400, fout: 'uitspraaklijst: ' + f };
    w = SPREEK.lijstNaarRegel(ruw) || '—';
    if (w.length > INSTELLING_MAX.uitspraak) return { status: 400, fout: 'uitspraaklijst: hooguit ' + INSTELLING_MAX.uitspraak + ' tekens' };
  }
  let regels = p.regels.slice();
  const kop = regels.findIndex(function (r, i) { return i >= p.frontmatterTot && /^##\s+praktijkinstellingen\s*$/i.test(r); });
  if (kop < 0) {
    let at = p.bandjes.length ? p.bandjes[0].van : regels.length;
    regels = regels.slice(0, at).concat(['## Praktijkinstellingen', '- ' + sleutel + ': ' + w, ''], regels.slice(at));
  } else {
    let eind = kop + 1; while (eind < regels.length && !/^##\s/.test(regels[eind])) eind++;
    let laatste = kop, gezet = false;
    for (let k = kop + 1; k < eind; k++) {
      const m = VELD_RE.exec(regels[k]);
      if (!m) continue;
      laatste = k;
      if (!gezet && m[1].trim().toLowerCase() === sleutel) { regels[k] = '- ' + m[1].trim() + ': ' + w; gezet = true; }
    }
    if (!gezet) regels = regels.slice(0, laatste + 1).concat(['- ' + sleutel + ': ' + w], regels.slice(laatste + 1));
  }
  const uit = klaar(zetUpdated(regels, klok));
  return { status: 200, md: uit, instellingen: parse(uit, voorvoegsel).instellingen };
}

// ── opslag: vault + journaal buiten de vault ──
function maak(deps) {
  const VAULT = deps.vault;
  const DIR = deps.dir;                     // /opt/data/bandjes (buiten de vault, zelfde schijf)
  const klok = deps.klok || Date.now;
  const fout = deps.fout || function () {};
  const JOURNAAL = path.join(DIR, 'journaal.jsonl');
  const cache = {};                         // praktijk → { mtime, grootte, p }
  function mkdir(d, mode) { fs.mkdirSync(d, { recursive: true, mode: mode || 0o700 }); }
  function pad(pr) { return path.join(VAULT, PRAKTIJKEN[pr].pad); }
  // laatste versie per praktijk/bandje die de pod zelf schreef
  let journaalCache = null;   // { mtime, grootte, st } (wv743: /health leest elke keer)
  function journaalStand() {
    const st = {};
    let t = '', s = null;
    try { s = fs.statSync(JOURNAAL); } catch (e) { return st; }
    if (journaalCache && journaalCache.mtime === s.mtimeMs && journaalCache.grootte === s.size) return journaalCache.st;
    try { t = fs.readFileSync(JOURNAAL, 'utf8'); } catch (e) { return st; }
    journaalCache = { mtime: s.mtimeMs, grootte: s.size, st: st };
    t.split('\n').forEach(function (r) {
      if (!r) return;
      try { const j = JSON.parse(r); if (!j.bandje) return; const k = j.praktijk + '/' + j.bandje; if (!st[k] || j.versie >= st[k].versie) st[k] = j; } catch (e) {}
    });
    return st;
  }
  function conflicten(pr) {
    const f = pad(pr);
    try { return fs.readdirSync(path.dirname(f)).filter(function (n) { return n.indexOf(path.basename(f) + '.conflict') === 0; }); } catch (e) { return []; }
  }
  // Leest één praktijk. dicht = reden waarom schrijven nu niet mag (null = open).
  function lees(pr) {
    if (!PRAKTIJKEN[pr]) return { status: 404, fout: 'onbekende praktijk' };
    const f = pad(pr);
    let st;
    try { st = fs.statSync(f); } catch (e) { return { status: 200, praktijk: pr, ontbreekt: true, bandjes: [], instellingen: {}, fouten: [], dicht: 'de registerpagina ontbreekt' }; }
    let c = cache[pr];
    if (!c || c.mtime !== st.mtimeMs || c.grootte !== st.size) {   // gelijkheid, niet "nieuwer": een teruggezette kopie is ouder (Fable #2)
      c = cache[pr] = { mtime: st.mtimeMs, grootte: st.size, p: parse(fs.readFileSync(f, 'utf8'), PRAKTIJKEN[pr].voorvoegsel) };
    }
    const p = c.p;
    const redenen = [];
    if (p.fouten.length) redenen.push('de pagina is niet in orde: ' + p.fouten.join('; '));
    const conf = conflicten(pr);
    if (conf.length) redenen.push('er staat een conflictkopie naast de pagina (' + conf.join(', ') + '); los die eerst op');
    const js = journaalStand();
    const teruggezet = [];
    p.bandjes.forEach(function (b) {
      const j = js[pr + '/' + b.id];
      if (j && b.versie < j.versie) teruggezet.push(b.id + ' (v' + b.versie + ' terwijl v' + j.versie + ' bewaard was)');
    });
    if (teruggezet.length) redenen.push('teruggezet door de synchronisatie: ' + teruggezet.join(', '));
    return { status: 200, praktijk: pr, naam: PRAKTIJKEN[pr].naam, instellingen: p.instellingen, bandjes: p.bandjes.map(bandjeUit),
      fouten: p.fouten, conflicten: conf, teruggezet: teruggezet, dicht: redenen.length ? redenen.join(' · ') : null };
  }
  function schrijfAtomair(f, inhoud) {
    const tmpDir = path.join(DIR, 'tmp');
    mkdir(tmpDir);
    const tmp = path.join(tmpDir, path.basename(f) + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex'));
    fs.writeFileSync(tmp, inhoud, { mode: 0o644 });
    try { fs.chmodSync(tmp, 0o644); } catch (e) {}
    try { fs.renameSync(tmp, f); }          // zelfde schijf als de vault (gemeten 22-10, device 64514): atomair
    catch (e) {
      if (!e || e.code !== 'EXDEV') { try { fs.unlinkSync(tmp); } catch (x) {} throw e; }
      // andere schijf (alleen in een proefopstelling): tijdelijk bestand naast de pagina, dan rename (kort zichtbaar voor bisync)
      try { fs.unlinkSync(tmp); } catch (x) {}
      const naast = path.join(path.dirname(f), '.' + path.basename(f) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
      fs.writeFileSync(naast, inhoud, { mode: 0o644 });
      fs.renameSync(naast, f);
      fout('bandjes-exdev', new Error('tmp op een andere schijf dan de vault; naast de pagina geschreven'));
    }
  }
  // Voert een mutatie uit: lezen, toetsen, schrijven, journaal — allemaal synchroon.
  function muteer(pr, actie, fn) {
    const l = lees(pr);
    if (l.status !== 200) return l;
    if (l.dicht) return { status: 409, fout: l.dicht, dicht: true };
    const f = pad(pr);
    const md = fs.readFileSync(f, 'utf8');
    const r = fn(md, PRAKTIJKEN[pr].voorvoegsel);
    if (r.status !== 200 || r.ongewijzigd) return r;
    schrijfAtomair(f, r.md);
    delete cache[pr];
    try {
      mkdir(DIR);
      fs.appendFileSync(JOURNAAL, JSON.stringify(r.bandje ? { tijd: new Date(klok()).toISOString(), praktijk: pr, bandje: r.bandje.id, actie: actie,
        versie: r.bandje.versie, tekst_hash: r.bandje.tekst_hash, tekst: r.bandje.tekst } : { tijd: new Date(klok()).toISOString(), praktijk: pr, actie: actie,
        instellingen: r.instellingen || null }) + '\n', { mode: 0o600 });
    } catch (e) { fout('bandjes-journaal', e); }
    return r.bandje ? { status: 200, bandje: r.bandje } : { status: 200, instellingen: r.instellingen };
  }
  return {
    lees: lees,
    alles: function () { return { praktijken: Object.keys(PRAKTIJKEN).map(lees) }; },
    zetTekst: function (pr, id, o) { return muteer(pr, 'tekst', function (md, vv) { return zetTekst(md, vv, id, o, klok); }); },
    zetVoorstel: function (pr, id, o) { return muteer(pr, 'voorstel', function (md, vv) { return zetVoorstel(md, vv, id, o, klok); }); },
    haalVoorstelWeg: function (pr, id) { return muteer(pr, 'voorstel-weg', function (md, vv) { return haalVoorstelWeg(md, vv, id, klok); }); },
    zetVelden: function (pr, id, v, verwacht) { return muteer(pr, 'velden', function (md, vv) { return zetVelden(md, vv, id, v, verwacht, klok); }); },
    nieuw: function (pr, o) { return muteer(pr, 'nieuw', function (md, vv) { return nieuwBandje(md, vv, o, klok); }); },
    zetSpreektekst: function (pr, id, o) { return muteer(pr, 'spreektekst', function (md, vv) { return zetSpreektekst(md, vv, id, o, klok); }); },
    zetInstelling: function (pr, k, w) { return muteer(pr, 'instellingen', function (md, vv) { return zetInstelling(md, vv, k, w, klok); }); },
    mkdir: function () { mkdir(DIR); mkdir(path.join(DIR, 'tmp')); try { fs.chmodSync(DIR, 0o700); fs.chmodSync(path.join(DIR, 'tmp'), 0o700); } catch (e) {} },
    journaalPad: JOURNAAL,
  };
}

// ── routes (rij B, wv743; bouwplan § 5.2) ──
// server.js doet de poort (Access, apparaat, sessie, slot), het BSN-masker op een vaste plek en bouwt de ctx (versOk/versVerbruik uit
// de sessie, precies zoals appStudio). Deze laag bouwt nooit zelf een ctx en schrijft alleen via de opslag hierboven.
const STEM_STANDAARD = 'piper:nl_NL-ronnie-medium';
const STEM_RE = /^[a-z0-9]{2,20}:[A-Za-z0-9_.\/-]{1,80}$/;
const BEURT_RE = /^[A-Za-z0-9-]{8,64}$/;
const APP_LINK = 'https://app.socev.dev/';
const SMAL_NIEUW_OPEN = 3;   // zoveel nieuwe bandjes zonder tekst mag de skill per praktijk open hebben
// Stemmen uit de Studio-flows met de vlag bandje (Fable #8). wv782: staat er een ElevenLabs-flow met de vlag bandje (bandje-elevenlabs),
// dan wordt elke ElevenLabs-stem uit de registers (praktijkstem en `stemmen`, beide praktijken) een eigen stem op die flow, betaald,
// met de modellen en tarieven van Studio. Zonder die flow (oude release of flow weg) blijft ElevenLabs grijs zoals in wv743.
const ELEVEN_ID_RE = /^elevenlabs:([A-Za-z0-9]{8,40})$/;
function stemmenUit(flows, regStemmen) {
  const uit = [];
  const el = (flows || []).find(function (f) { return f && f.bandje === true && f.motor === 'elevenlabs'; });
  if (el) {
    (regStemmen || []).forEach(function (r) {
      if (!r || !ELEVEN_ID_RE.test(r.id) || uit.some(function (x) { return x.id === r.id; })) return;
      uit.push({ id: r.id, flow: el.id, naam: r.naam || 'ElevenLabs-stem', motor: 'elevenlabs', betaald: true, beschikbaar: el.klaar === true,
        reden: el.klaar ? null : (el.reden || 'niet beschikbaar'), prijs: el.prijs || null, vers_per_keer: true, prijs_tabel: el.prijs_tabel || null,
        modellen: (el.velden || []).filter(function (v) { return v.naam === 'model'; }).map(function (v) { return v.opties || []; })[0] || [],
        model_standaard: ((el.velden || []).find(function (v) { return v.naam === 'model'; }) || {}).standaard || null });
    });
  }
  (flows || []).forEach(function (f) {
    if (!f || f.bandje !== true || !f.stem || f.motor === 'elevenlabs') return;
    if (uit.some(function (x) { return x.id === f.stem; })) return;
    uit.push({ id: f.stem, flow: f.id, naam: f.titel, motor: f.motor, betaald: false, beschikbaar: f.klaar === true, reden: f.klaar ? null : (f.reden || 'niet beschikbaar'),
      prijs: f.prijs || 'gratis', vers_per_keer: f.vers_per_keer === true });
  });
  if (!el) uit.push({ id: 'elevenlabs', flow: null, naam: 'ElevenLabs (betaald)', motor: 'elevenlabs', betaald: true, beschikbaar: false,
    reden: 'nog niet beschikbaar — komt met Studio fase 2', prijs: null, vers_per_keer: true });
  return uit;
}
// wv803: spreektekst en stemgevoel. Standaard en grenzen gemeten 22-10 (voortgang-2.md): ElevenLabs speed 0,7–1,2 (1,25 = 400),
// stability 0–1; pauze in seconden voor een kale [pauze] (v2/flash: break-tag van precies die duur; v3/v4: [pause] vanaf 0,5 s, [long pause]
// vanaf 1,4 s, daaronder alleen de punt ± 0,37 s).
const SPREEK_STD = { snelheid: 0.95, stabiliteit: 0.5, pauze: 0.8 };
const SPREEK_GRENS = { snelheid: [0.7, 1.2], stabiliteit: [0, 1], pauze: [0, 2] };
// De spreektekst van een bandje (uit bandjeUit): de eigen van David als die bij deze tekst hoort, anders automatisch uit tekst + uitspraaklijst.
function spreekVan(b, inst) {
  const eigen = b && b.spreek_eigen;
  const geldig = !!(eigen && eigen.bij && eigen.bij === b.tekst_hash);
  const tekst = !b || b.onbekend || !b.tekst ? '' : geldig ? eigen.tekst : SPREEK.afleiden(b.tekst, inst && inst.uitspraak);
  // hash (Fable wv803 #3): wat David zag; maak/proef eisen hem, zodat een intussen gewijzigde eigen spreektekst of uitspraaklijst niet
  // stil een andere tekst (en prijs) inspreekt dan hij bevestigde. ongekoppeld = eigen blok zonder hash (zelf in Obsidian geschreven).
  return { tekst: tekst, hash: tekstHash(tekst), eigen: geldig, verouderd: !!eigen && !geldig, ongekoppeld: !!eigen && !eigen.bij,
    eigen_oud: eigen && !geldig ? eigen.tekst : null, zinnen: SPREEK.zinnen(tekst) };
}
function knoppenVan(d) {
  const uit = {};
  for (const k of Object.keys(SPREEK_STD)) {
    const ruw = d ? d[k] : null;
    const v = ruw == null || ruw === '' ? SPREEK_STD[k] : Number(ruw);
    if (!Number.isFinite(v) || v < SPREEK_GRENS[k][0] || v > SPREEK_GRENS[k][1]) return { fout: k + ' moet tussen ' + SPREEK_GRENS[k][0] + ' en ' + SPREEK_GRENS[k][1] + ' liggen' };
    uit[k] = Math.round(v * 100) / 100;
  }
  return { waarden: uit };
}
function link(pr, id, voorstel) {
  return APP_LINK + '?mini=bandjes&praktijk=' + encodeURIComponent(pr) + (id ? '&bandje=' + encodeURIComponent(id) : '') + (voorstel ? '&voorstel=1' : '');
}
function routes(deps) {
  const S = deps.opslag;
  const klok = deps.klok || Date.now;
  const log = deps.log || function () {};
  const fout = deps.fout || function () {};
  const primair = deps.primair || function () { return true; };
  const BOX_STAND = path.join(deps.dir, 'box.json');
  // ── box-rij bij teruggezet of een conflictkopie: hooguit één per praktijk per soort per dag (ook over een herstart) ──
  function boxMeld(l) {
    if (!deps.boxPad || !l || l.status !== 200) return;
    const soorten = [];
    if (l.teruggezet && l.teruggezet.length) soorten.push(['teruggezet', 'teruggezet door de synchronisatie: ' + l.teruggezet.join(', ')]);
    if (l.conflicten && l.conflicten.length) soorten.push(['conflict', 'conflictkopie naast de registerpagina: ' + l.conflicten.join(', ')]);
    if (l.fouten && l.fouten.length) soorten.push(['pagina', 'registerpagina niet in orde: ' + l.fouten.join('; ')]);
    if (!soorten.length) return;
    const dag = vandaagIso(klok);
    let st = {};
    try { st = JSON.parse(fs.readFileSync(BOX_STAND, 'utf8')) || {}; } catch (e) { st = {}; }
    let veranderd = false;
    soorten.forEach(function (s) {
      const k = l.praktijk + '/' + s[0];
      if (st[k] === dag) return;
      if (schrijfBoxRij(l, s[0], s[1])) { st[k] = dag; veranderd = true; }
    });
    if (veranderd) {
      try { fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 }); const tmp = BOX_STAND + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(tmp, BOX_STAND); }
      catch (e) { fout('bandjes-box-stand', e); }
    }
  }
  function schrijfBoxRij(l, soort, gemeten) {
    try {
      const t = fs.readFileSync(deps.boxPad, 'utf8');
      const anker = eersteRij(t);   // eerste echte rij, niet een kop in een codeblok erboven
      if (anker < 0) return false;
      const tijd = new Date(klok()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
      const pagina = PRAKTIJKEN[l.praktijk].pad;
      const rij = '\n## [direct] ' + tijd + ' — Bandjes ' + PRAKTIJKEN[l.praktijk].naam + ': ' + (soort === 'teruggezet' ? 'bewaarde tekst teruggezet door de synchronisatie'
        : soort === 'conflict' ? 'conflictkopie naast het register' : 'registerpagina niet in orde') + ' (pod, automatisch)\n' +
        '- status: open\n- van: pod bandjes.js (mini-app Bandjes; hooguit 1×/dag per praktijk en soort)\n' +
        '- gemeten: ' + eenRegel(gemeten, 300) + '\n' +
        '- gevolg als er niets gebeurt: Bewaar en Maak voor ' + PRAKTIJKEN[l.praktijk].naam + ' staan dicht in de mini-app (lezen werkt).\n' +
        '- voorstel: ' + (soort === 'teruggezet' ? 'de laatst bewaarde tekst staat in `' + path.join(deps.dir, 'journaal.jsonl') + '`; zet hem terug in `' + pagina + '` met een versie ≥ die uit het journaal (of hoog de versie op als de pagina zo goed is). Daarna gaat de mini-app vanzelf weer open.'
          : soort === 'conflict' ? 'vergelijk de conflictkopie met `' + pagina + '`, neem wat ontbreekt over en verwijder de kopie; daarna gaat de mini-app vanzelf weer open.'
          : 'dubbel of verkeerd id in `' + pagina + '` rechtzetten (ids zijn onveranderlijk; hernoem de dubbele).') + '\n';
      // tmp buiten de vault (zelfde schijf; niet zichtbaar voor bisync) met de modus van het origineel (umask 077 in run.sh; Fable wv743 #5)
      const modus = fs.statSync(deps.boxPad).mode & 0o777;
      const tmpDir = path.join(deps.dir, 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      const tmp = path.join(tmpDir, 'machinekamer.md.' + crypto.randomBytes(4).toString('hex'));
      fs.writeFileSync(tmp, t.slice(0, anker) + rij + t.slice(anker), { mode: modus });
      fs.chmodSync(tmp, modus);
      try { fs.renameSync(tmp, deps.boxPad); }
      catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} if (e && e.code === 'EXDEV') { fs.writeFileSync(deps.boxPad, t.slice(0, anker) + rij + t.slice(anker)); } else throw e; }
      log('bandjes box-rij praktijk=' + l.praktijk + ' soort=' + soort);
      return true;
    } catch (e) { fout('bandjes-box', e); return false; }
  }
  // Index van de "\n" vóór de eerste rij "## [soort] JJJJ-MM-DD" buiten een ```-blok (het formaatvoorbeeld staat in zo'n blok).
  function eersteRij(t) {
    let i = 0, blok = false;
    while (i < t.length) {
      const e = t.indexOf('\n', i), r = t.slice(i, e < 0 ? t.length : e);
      if (/^```/.test(r)) blok = !blok;
      else if (!blok && i > 0 && /^## \[[a-z]{2,10}\] \d{4}-\d{2}-\d{2}/.test(r)) return i - 1;
      if (e < 0) break;
      i = e + 1;
    }
    return -1;
  }
  function lees(pr) { const l = S.lees(pr); boxMeld(l); return l; }
  // De praktijkstem uit het register; staat er (nog) geen geldige stem-id, dan de gratis proefstem.
  function praktijkstem(inst) { const w = String(inst && inst.praktijkstem || ''); return STEM_RE.test(w) ? w : STEM_STANDAARD; }
  function praktijkUit(l) {
    return { id: l.praktijk, naam: l.naam || (PRAKTIJKEN[l.praktijk] && PRAKTIJKEN[l.praktijk].naam), instellingen: l.instellingen || {},
      praktijkstem: praktijkstem(l.instellingen),
      bandjes: (l.bandjes || []).map(function (b) { return Object.assign({}, b, { spreektekst: spreekVan(b, l.instellingen) }); }),   // wv803
      dicht: l.dicht || null, fouten: l.fouten || [], conflicten: l.conflicten || [], teruggezet: l.teruggezet || [], ontbreekt: l.ontbreekt === true };
  }
  // wv782: de ElevenLabs-stemmen komen uit de registers (praktijkstem eerst, dan `stemmen`); een praktijkstem zonder naam in `stemmen`
  // heet "ElevenLabs-stem"
  function registerStemmen() {
    const uit = [];
    Object.keys(PRAKTIJKEN).forEach(function (pr) {
      let l; try { l = S.lees(pr); } catch (e) { return; }
      const inst = l && l.instellingen || {};
      const lijst = stemmenLijst(inst.stemmen).filter(Boolean);
      const ps = String(inst.praktijkstem || '');
      if (STEM_RE.test(ps)) { const n = lijst.find(function (x) { return x.id === ps; }); uit.push({ id: ps, naam: n ? n.naam : null }); }
      lijst.forEach(function (x) { uit.push(x); });
    });
    return uit;
  }
  async function stemmen() {
    let flows = [];
    try { flows = deps.studio ? (await deps.studio.flows({ verborgen: true })).flows : []; } catch (e) { fout('bandjes-stemmen', e); }
    return stemmenUit(flows, registerStemmen());
  }
  // wv782: het model van een ElevenLabs-bandje: uit de invoer, anders de praktijkinstelling `model`, anders de standaard van Studio
  function modelVoor(s, gevraagd, inst) {
    const ok = function (m) { return (s.modellen || []).some(function (o) { return o.waarde === m; }); };
    if (gevraagd && ok(String(gevraagd))) return String(gevraagd);
    const pm = String(inst && inst.model || '');
    if (ok(pm)) return pm;
    return s.model_standaard || null;
  }
  const fouts = function (r) { return { status: r.status, j: Object.assign({ ok: false, fout: r.fout }, r.gewijzigd ? { gewijzigd: true } : {}, r.dicht ? { dicht: true } : {}, r.vers_nodig ? { vers_nodig: true } : {}, r.plafond ? { plafond: true } : {}) }; };
  const goedOf = function (r, extra) { return r.status === 200 ? { status: 200, j: Object.assign({ ok: true }, extra || {}, r.bandje ? { bandje: r.bandje } : {}, r.ongewijzigd ? { ongewijzigd: true } : {}) } : fouts(r); };
  function praktijk(d) { const pr = String(d && d.praktijk || ''); return Object.hasOwn(PRAKTIJKEN, pr) ? pr : null; }
  function stemOk(w, lijst) { return w === 'praktijkstem' || (STEM_RE.test(w) && lijst.some(function (x) { return x.id === w; })); }

  // app: route = "GET /app/bandjes" of "POST /app/bandjes/<actie>"; d = body (al gemaskeerd); ctx van appStudio. Geeft { status, j }.
  async function app(route, d, ctx) {
    d = d && typeof d === 'object' ? d : {};
    if (route === 'GET /app/bandjes') {
      const pr = Object.keys(PRAKTIJKEN).map(lees).map(praktijkUit);
      let kosten = null;
      try { const t = deps.studio && deps.studio.teller ? deps.studio.teller() : null; kosten = t && t.plafond ? t.plafond.elevenlabs || null : null; } catch (e) { kosten = null; }
      return { status: 200, j: { ok: true, praktijken: pr, stemmen: await stemmen(), schrijven: !!primair(), stem_standaard: STEM_STANDAARD, grens: GRENS, kosten: kosten,
        spreek: { standaard: SPREEK_STD, grenzen: SPREEK_GRENS, max: SPREEK.MAX } } };
    }
    const m = /^POST \/app\/bandjes\/(tekst|nieuw|voorstel|instellingen|maak|status|spreektekst|proef)$/.exec(route);
    if (!m) return { status: 404, j: { ok: false, fout: 'onbekend' } };
    if (!primair()) return { status: 409, j: { ok: false, fout: 'deze kant van Socev is nu passief; bandjes bewaren en maken kan alleen op de actieve kant' } };
    const pr = praktijk(d);
    if (!pr) return { status: 400, j: { ok: false, fout: 'onbekende praktijk' } };
    const id = String(d.bandje || '');
    const actie = m[1];
    // wv803: een bandje in een antwoord draagt altijd zijn spreektekst (zoals in GET), anders valt die in de app weg tot het herladen
    const goed = function (r) {
      if (r && r.status === 200 && r.bandje) {
        let inst = {}; try { inst = S.lees(pr).instellingen || {}; } catch (e) { inst = {}; }
        r = Object.assign({}, r, { bandje: Object.assign({}, r.bandje, { spreektekst: spreekVan(r.bandje, inst) }) });
      }
      return goedOf(r);
    };
    if (actie === 'nieuw') {
      const r = S.nieuw(pr, { naam: d.naam, menu: d.menu, wanneer: d.wanneer, tekst: d.tekst });
      return goed(r);
    }
    if (actie === 'instellingen') {
      // wv803: de uitspraaklijst (één instelling per verzoek)
      if (typeof d.uitspraak === 'string') {
        const r = S.zetInstelling(pr, 'uitspraak', d.uitspraak);
        return r.status === 200 ? { status: 200, j: { ok: true, instellingen: r.instellingen } } : fouts(r);
      }
      const w = String(d.praktijkstem || '');
      if (!stemOk(w, await stemmen()) || w === 'praktijkstem') return { status: 400, j: { ok: false, fout: 'onbekende stem' } };
      const r = S.zetInstelling(pr, 'praktijkstem', w);
      return r.status === 200 ? { status: 200, j: { ok: true, instellingen: r.instellingen } } : fouts(r);
    }
    if (!ID_RE.test(id)) return { status: 400, j: { ok: false, fout: 'onbekend bandje' } };
    if (actie === 'tekst') {
      if (d.stem != null && d.stem !== '' && !stemOk(String(d.stem), await stemmen())) return { status: 400, j: { ok: false, fout: 'onbekende stem' } };
      const r = S.zetTekst(pr, id, { tekst: d.tekst, versie: d.versie, tekst_hash: d.tekst_hash, stem: d.stem ? String(d.stem) : null, voorstel_weg: d.voorstel_weg === true });
      return goed(r);
    }
    if (actie === 'voorstel') {
      // alleen "laten liggen": overnemen bestaat alleen in de app (zet de tekst in het vak); pas Bewaar schrijft (Fable #11)
      if (d.keuze !== 'laat') return { status: 400, j: { ok: false, fout: 'alleen laten liggen kan hier; overnemen gaat via Bewaar' } };
      return goed(S.haalVoorstelWeg(pr, id));
    }
    if (actie === 'spreektekst') {
      // wv803: eigen spreektekst bewaren (string) of terug naar automatisch (null); versie + hash zoals Bewaar
      if (d.spreektekst !== null && typeof d.spreektekst !== 'string') return { status: 400, j: { ok: false, fout: 'spreektekst ontbreekt' } };
      return goed(S.zetSpreektekst(pr, id, { versie: d.versie, tekst_hash: d.tekst_hash, spreektekst: d.spreektekst }));
    }
    if (actie === 'status') {
      // versie én hash (Fable wv743 #2): anders zegt het label "in centrale (vN)" bij een tekst die David intussen in Obsidian wijzigde
      const v = Number(d.versie);
      if (!Number.isInteger(v) || v < 1 || !/^[a-f0-9]{16}$/.test(String(d.tekst_hash || ''))) return { status: 400, j: { ok: false, fout: 'versie of tekst_hash ontbreekt' } };
      const r = S.zetVelden(pr, id, { 'in centrale': 'v' + v + ', ' + vandaag(klok), status: 'in centrale (v' + v + ')' },
        { versie: v, tekst_hash: String(d.tekst_hash) });
      return goed(r);
    }
    // maak (en proef, wv803): de tekst komt UIT HET REGISTER, nooit uit de invoer; versie + hash moeten kloppen met wat de app las.
    // Wat naar de stem gaat is de spreektekst (eigen of automatisch, zie spreekVan), per model vertaald; proef = één zin daaruit (index).
    const beurt = String(d.beurt_id || '');
    if (!BEURT_RE.test(beurt)) return { status: 400, j: { ok: false, fout: 'beurt_id ontbreekt' } };
    if (!deps.studio) return { status: 503, j: { ok: false, fout: 'Studio zit niet in deze versie van de pod' } };
    const lijst = await stemmen();   // vóór het lezen (Fable wv743 #7): tussen lezen/toetsen en studio.maak geen extra await
    const l = lees(pr);
    if (l.status !== 200) return fouts(l);
    if (l.dicht) return { status: 409, j: { ok: false, fout: l.dicht, dicht: true } };
    const b = l.bandjes.find(function (x) { return x.id === id; });
    if (!b) return { status: 404, j: { ok: false, fout: 'dit bandje staat niet in het register' } };
    if (Number(d.versie) !== b.versie || String(d.tekst_hash || '') !== b.tekst_hash) return { status: 409, j: { ok: false, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true } };
    if (b.onbekend || !b.tekst) return { status: 400, j: { ok: false, fout: 'bewaar eerst een tekst' } };
    const kn = knoppenVan(d);
    if (kn.fout) return { status: 400, j: { ok: false, fout: kn.fout } };
    const sp = spreekVan(b, l.instellingen);
    if (d.spreek_hash != null && d.spreek_hash !== '' && String(d.spreek_hash) !== sp.hash)
      return { status: 409, j: { ok: false, fout: 'de spreektekst is intussen gewijzigd (eigen versie of uitspraaklijst); herlaad', gewijzigd: true } };
    let spreek = sp.tekst;
    const proef = actie === 'proef';
    if (proef) {
      const z = Number(d.zin);
      if (!Number.isInteger(z) || z < 0 || z >= sp.zinnen.length) return { status: 400, j: { ok: false, fout: 'kies een zin uit de spreektekst' } };
      spreek = sp.zinnen[z];
    }
    if (!spreek.trim()) return { status: 400, j: { ok: false, fout: 'de spreektekst is leeg' } };
    // een expliciete keuze "praktijkstem" gaat vóór de bewaarde stem van het bandje (Fable wv782 #1: anders een betaalde stem die David niet koos)
    const stem = d.stem ? (d.stem === 'praktijkstem' ? praktijkstem(l.instellingen) : String(d.stem)) : (b.stem && b.stem !== 'praktijkstem' ? b.stem : praktijkstem(l.instellingen));
    const s = lijst.find(function (x) { return x.id === stem; });
    if (!s) return { status: 400, j: { ok: false, fout: 'onbekende stem' } };
    if (!s.beschikbaar || !s.flow) return { status: 409, j: { ok: false, fout: 'deze stem kan nu niet: ' + (s.reden || 'niet beschikbaar') } };
    const velden = { tekst: SPREEK.naarModel(spreek, null) };   // Piper: zonder pauzemarkering
    let model = null;
    if (s.motor === 'elevenlabs') {
      // wv782: voice-id uit de stem-id; model uit de witte lijst van Studio (die toetst het nogmaals)
      // een opgegeven maar onbekend model = 400, geen stille terugval (Fable wv782 #4: de app toonde dan een andere prijs)
      if (d.model != null && d.model !== '' && !(s.modellen || []).some(function (o) { return o.waarde === String(d.model); })) return { status: 400, j: { ok: false, fout: 'onbekend model' } };
      model = modelVoor(s, d.model, l.instellingen);
      if (!model) return { status: 400, j: { ok: false, fout: 'onbekend model' } };
      velden.stem = ELEVEN_ID_RE.exec(stem)[1];
      velden.model = model;
      velden.tekst = SPREEK.naarModel(spreek, model, { pauze: kn.waarden.pauze });
      velden.snelheid = kn.waarden.snelheid;
      velden.stabiliteit = kn.waarden.stabiliteit;
    }
    // Fable wv803 #4: een leesbare fout als de spreektekst (met pauzes) te lang is, vóór Studio en vóór de vingerafdruk
    if (velden.tekst.length > SPREEK.MAX) return { status: 400, j: { ok: false, fout: 'de spreektekst is met de pauzes te lang voor de stem (' + velden.tekst.length + ' van ' + SPREEK.MAX + ' tekens); kort hem in of kies minder pauze' } };
    const r = await deps.studio.maak({ flow: s.flow, velden: velden, beurt_id: beurt }, ctx,
      { bron: Object.assign({ soort: 'bandje', praktijk: pr, bandje: id, versie: b.versie, tekst_hash: b.tekst_hash, stem: stem }, model ? { model: model } : {}, proef ? { proef: true } : {}) });
    if (r.status !== 200) return fouts(r);
    return { status: 200, j: { ok: true, taak: r.taak, al: r.al === true } };
  }

  // POST /smal/bandjes/voorstel (API-geheim; de skill van Socev). d: { praktijk, bandje | nieuw: { naam, menu, wanneer }, tekst, reden }.
  // Eén schrijver (Fable #5): de skill schrijft nooit zelf in de pagina. Geeft { status, j } met de link die de mini-app opent.
  function smal(actie, d) {
    if (actie !== 'voorstel') return { status: 404, j: { ok: false, fout: 'onbekende smalle route' } };
    if (!primair()) return { status: 409, j: { ok: false, fout: 'deze kant van Socev is nu passief' } };
    d = d && typeof d === 'object' ? d : {};
    const pr = praktijk(d);
    if (!pr) return { status: 400, j: { ok: false, fout: 'onbekende praktijk (tolgaarde of groenhouten)' } };
    let id = String(d.bandje || '');
    if (!id && d.nieuw && typeof d.nieuw === 'object') {
      // eerst de tekst toetsen (anders staat er een leeg bandje zonder voorstel) en hooguit SMAL_NIEUW_OPEN bandjes van Socev die nog
      // geen tekst hebben: een voorstel is gegeven, geen opdracht, en een geïnjecteerd verzoek mag het register niet vullen (Fable wv743 #3)
      const t = toetsTekst(d.tekst);
      if (t.fout) return { status: 400, j: { ok: false, fout: t.fout } };
      const l = S.lees(pr);
      if (l.status !== 200) return fouts(l);
      const open = (l.bandjes || []).filter(function (x) { return x.onbekend && /^voorstel van Socev\b/.test(x.bron || ''); }).length;
      if (open >= SMAL_NIEUW_OPEN) return { status: 409, j: { ok: false, fout: 'er staan al ' + open + ' nieuwe bandjes van Socev zonder tekst; David moet die eerst bewaren of weghalen' } };
      const n = S.nieuw(pr, { naam: d.nieuw.naam, menu: d.nieuw.menu, wanneer: d.nieuw.wanneer, bron: 'voorstel van Socev' });
      if (n.status !== 200) return fouts(n);
      id = n.bandje.id;
    }
    if (!ID_RE.test(id)) return { status: 400, j: { ok: false, fout: 'bandje ontbreekt (id uit het register, of nieuw: { naam })' } };
    const r = S.zetVoorstel(pr, id, { tekst: d.tekst, reden: d.reden });
    if (r.status !== 200) return fouts(r);
    log('bandjes voorstel praktijk=' + pr + ' bandje=' + id + ' tekens=' + r.bandje.voorstel.tekst.length);
    return { status: 200, j: { ok: true, bandje: r.bandje, link: link(pr, id, true) } };
  }

  // Na een Studio-taak met bron bandje (deps.naKlaar van studio.js): "laatste bestand" en status "gemaakt (vN)" alleen als versie + hash
  // nog kloppen. Mislukt de taak of is het bandje intussen gewijzigd, dan blijft het register zoals het was (logregel).
  function naKlaar(taak) {
    const b = taak && taak.bron;
    if (!b || b.soort !== 'bandje' || !Object.hasOwn(PRAKTIJKEN, b.praktijk)) return;
    if (b.proef) { log('bandjes naklaar taak=' + taak.id + ' proefzin ' + b.praktijk + '/' + b.bandje + ' (register ongemoeid)'); return; }   // wv803
    if (taak.status !== 'klaar') { log('bandjes naklaar taak=' + taak.id + ' uitkomst=' + taak.status + ' (register ongemoeid)'); return; }
    const bs = taak.bestanden || [];
    const hoofd = bs.find(function (x) { return !/-telefoon-(pcm|ulaw)\.wav$/i.test(x.naam); }) || bs[0];
    const tel = bs.filter(function (x) { return /-telefoon-(pcm|ulaw)\.wav$/i.test(x.naam); }).length;
    const waarde = vandaag(klok) + ' · v' + b.versie + ' · ' + b.stem + (b.model ? ' · ' + b.model : '') + ' · ' + taak.id + '/' + (hoofd ? hoofd.naam : '?') +
      (tel === 2 ? ' (+ telefoonversies PCM en µ-law)' : ' (zonder telefoonversie)');
    const r = S.zetVelden(b.praktijk, b.bandje, { 'laatste bestand': waarde, status: 'gemaakt (v' + b.versie + ')' }, { versie: b.versie, tekst_hash: b.tekst_hash });
    if (r.status !== 200) { log('bandjes naklaar taak=' + taak.id + ' register niet bijgewerkt: ' + String(r.fout || '').slice(0, 120)); boxMeld(S.lees(b.praktijk)); }
    else log('bandjes naklaar taak=' + taak.id + ' ' + b.praktijk + '/' + b.bandje + ' v' + b.versie + ' gemaakt');
  }

  // /health: zonder inhoud
  function health() {
    const uit = { aan: true };
    Object.keys(PRAKTIJKEN).forEach(function (pr) { try { uit['dicht_' + pr] = !!S.lees(pr).dicht; } catch (e) { uit['dicht_' + pr] = null; } });
    return uit;
  }
  return { app: app, smal: smal, naKlaar: naKlaar, health: health, stemmen: stemmen };
}

module.exports = { PRAKTIJKEN, GRENS, STEM_STANDAARD, normTekst, tekstHash, parse, bandjeUit, zetTekst, zetVoorstel, haalVoorstelWeg, zetVelden, nieuwBandje,
  zetInstelling, zetSpreektekst, stemmenLijst, stemmenUit, maak, routes };
