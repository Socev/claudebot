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
        huidig = { id: m[1].toLowerCase(), naam: m[2], velden: {}, tekstRegels: null, voorstelRegels: null, voorstelKop: '', van: i, tot: null };
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
  delete b.tekstRegels; delete b.voorstelRegels; delete b.voorstelKop;
}
// Voor de app: zonder regelnummers.
function bandjeUit(b) {
  const v = b.velden;
  return { id: b.id, naam: b.naam, menu: v.menu || '', wanneer: v.wanneer || '', tijdvensters: v.tijdvensters || '', stem: v.stem || 'praktijkstem',
    versie: b.versie, tekst: b.tekst, onbekend: b.onbekend, tekst_hash: b.hash, status: v.status || '', laatste_bestand: v['laatste bestand'] || '',
    in_centrale: v['in centrale'] || '', bron: v.bron || '', aandachtspunt: v.aandachtspunt || '', voorstel: b.voorstel };
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
    if (TEKST_RE.test(r[k]) || VOORSTEL_RE.test(r[k])) break;
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
      let s = m + 1; while (s < r.length && r[s].trim() === '' && s < m + 2) s++;   // hooguit één lege regel tussen kop en citaat
      const e = /^>/.test(r[s] || '') ? blokEind(r, s) : m + 1;
      r = r.slice(0, m + 1).concat(nieuw, r.slice(e));
    }
  }
  // voorstel
  if (w.voorstel !== undefined) {
    const m = r.findIndex(function (x) { return VOORSTEL_RE.test(x); });
    if (m >= 0) {
      let s = m + 1; while (s < r.length && r[s].trim() === '' && s < m + 2) s++;
      const e = /^>/.test(r[s] || '') ? blokEind(r, s) : m + 1;
      let begin = m; if (begin > 0 && r[begin - 1].trim() === '') begin--;
      r = r.slice(0, begin).concat(r.slice(e));
    }
    if (w.voorstel) {
      const blok = ['', '**Voorstel van Socev**' + (w.voorstel.kop ? ' ' + eenRegel(w.voorstel.kop, GRENS.reden + 40) : '')].concat(citaat(w.voorstel.tekst));
      const tm = r.findIndex(function (x) { return TEKST_RE.test(x); });
      let at;
      if (tm >= 0) { let s = tm + 1; while (s < r.length && r[s].trim() === '' && s < tm + 2) s++; at = /^>/.test(r[s] || '') ? blokEind(r, s) : tm + 1; }
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
  if (t.tekst === b.tekst && !o.stem && !o.voorstel_weg) return { status: 200, md: md, bandje: bandjeUit(b), ongewijzigd: true };
  const nieuweVersie = b.versie + 1;
  const velden = { versie: String(nieuweVersie), status: 'concept (v' + nieuweVersie + ')' };
  if (o.stem) velden.stem = eenRegel(o.stem, 80);
  let regels = vervangSectie(p, b, herschrijfSectie(p, b, { velden: velden, tekst: t.tekst, voorstel: o.voorstel_weg ? null : undefined }));
  if (!b.onbekend && b.tekst !== t.tekst) regels = voegGeschiedenisToe(regels, ['### ' + b.id + ' v' + b.versie + ' — vervangen ' + vandaag(klok)].concat(citaat(b.tekst)));
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
    '- bron: aangemaakt in de app ' + vandaag(klok), '', '**Tekst**'].concat(tekst ? citaat(tekst) : ['> ' + ONBEKEND], ['']);
  let at = p.regels.findIndex(function (r) { return /^##\s+(historie|versiegeschiedenis)\b/i.test(r); });
  if (at < 0) at = p.regels.length;
  const regels = zetUpdated(p.regels.slice(0, at).concat(sectie, p.regels.slice(at)), klok);
  const uit = klaar(regels);
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
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
  function journaalStand() {
    const st = {};
    let t = '';
    try { t = fs.readFileSync(JOURNAAL, 'utf8'); } catch (e) { return st; }
    t.split('\n').forEach(function (r) {
      if (!r) return;
      try { const j = JSON.parse(r); const k = j.praktijk + '/' + j.bandje; if (!st[k] || j.versie >= st[k].versie) st[k] = j; } catch (e) {}
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
    fs.renameSync(tmp, f);                  // zelfde schijf als de vault (gemeten 22-10, device 64514): atomair
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
      fs.appendFileSync(JOURNAAL, JSON.stringify({ tijd: new Date(klok()).toISOString(), praktijk: pr, bandje: r.bandje.id, actie: actie,
        versie: r.bandje.versie, tekst_hash: r.bandje.tekst_hash, tekst: r.bandje.tekst }) + '\n', { mode: 0o600 });
    } catch (e) { fout('bandjes-journaal', e); }
    return { status: 200, bandje: r.bandje };
  }
  return {
    lees: lees,
    alles: function () { return { praktijken: Object.keys(PRAKTIJKEN).map(lees) }; },
    zetTekst: function (pr, id, o) { return muteer(pr, 'tekst', function (md, vv) { return zetTekst(md, vv, id, o, klok); }); },
    zetVoorstel: function (pr, id, o) { return muteer(pr, 'voorstel', function (md, vv) { return zetVoorstel(md, vv, id, o, klok); }); },
    haalVoorstelWeg: function (pr, id) { return muteer(pr, 'voorstel-weg', function (md, vv) { return haalVoorstelWeg(md, vv, id, klok); }); },
    zetVelden: function (pr, id, v, verwacht) { return muteer(pr, 'velden', function (md, vv) { return zetVelden(md, vv, id, v, verwacht, klok); }); },
    nieuw: function (pr, o) { return muteer(pr, 'nieuw', function (md, vv) { return nieuwBandje(md, vv, o, klok); }); },
  };
}

module.exports = { PRAKTIJKEN, GRENS, normTekst, tekstHash, parse, bandjeUit, zetTekst, zetVoorstel, haalVoorstelWeg, zetVelden, nieuwBandje, maak };
