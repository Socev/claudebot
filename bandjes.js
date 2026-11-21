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
const VV = require('./vault-veilig.js');   // wv900: vault lezen en schrijven zonder een symlink te volgen
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

// ── wv3768 (besluitenpagina nr 191 = 2C91 b+d, David Ja 21-11-2026 13:18; Fable-review "Een 9 - bandjes" idee 6 en 12) ──
// (b) "gevraagd door: Naam <adres>": wie om het bandje vroeg (David in de app, of de skill bandjes via /smal). Bij "Staat in de centrale"
// zet de pod een Gmail-CONCEPT aan die persoon (nooit versturen; David verstuurt). (d) "aangeleverd: <datum> · [[bron]]": het huidige
// geluid dat David in de app aanleverde; de pod bewaart het in de Bronnen-map van de praktijk en zet het uitschrift als VOORSTEL.
const MAIL_RE = /^[^@\s<>(),;:"'\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/i;
// "Naam <adres>" of een kaal adres → { naam, mail } of null ("—" of leeg = niemand)
function vragerVan(w) {
  const t = String(w || '').trim();
  if (!t || /^[—–-]$/.test(t)) return null;
  const m = /^(.*?)\s*<([^<>\s]+)>\s*$/.exec(t);
  const mail = (m ? m[2] : t).trim(), naam = (m ? m[1] : '').replace(/["']/g, '').trim();
  return mail.length <= 120 && MAIL_RE.test(mail) ? { naam: naam.slice(0, GRENS.naam), mail: mail.toLowerCase() } : null;
}
// Schrijver (strikt): naam ≤ 60 tekens zonder <>", adres verplicht en geldig; allebei leeg = wissen ("—").
function vragerRegel(naam, mail) {
  const n = eenRegel(naam, GRENS.naam * 2).replace(/[<>"';]/g, '').trim().slice(0, GRENS.naam), a = eenRegel(mail, 200).toLowerCase();
  if (!n && !a) return { waarde: '—' };
  if (!a || a.length > 120 || !MAIL_RE.test(a)) return { fout: 'vul een geldig mailadres in (naam mag erbij)' };
  return { waarde: n ? n + ' <' + a + '>' : '<' + a + '>' };
}
// Het conceptantwoord aan de vrager (collega: "Hoi …", "Groet, David"; skill mijn-mailstem § collega). Alleen praktijktekst, geen patiënten.
function terugmeldMail(prNaam, b, vrager, klok) {
  const voornaam = String(vrager && vrager.naam || '').split(/\s+/)[0] || '';
  return { onderwerp: 'Bandje ' + b.naam + ' (' + prNaam + ') staat in de centrale',
    bericht: (voornaam ? 'Hoi ' + voornaam + ',' : 'Hoi,') + '\n\n' +
      'Het bandje "' + b.naam + '" van ' + prNaam + ' is aangepast: de nieuwe versie staat sinds ' + vandaag(klok) + ' in de telefooncentrale.\n\n' +
      'Dit is de tekst:\n\n' + normTekst(b.tekst) + '\n\n' +
      'Hoor je iets wat niet klopt, laat het me weten.\n\nGroet,\nDavid' };
}
// Geluid herkennen op de eerste bytes (niet op naam of type van de browser). Gemeten 21-11 (wv3768): Whisper via Cloudflare verstaat WAV
// PCM 16 kHz, PCM 8 kHz en µ-law 8 kHz (de telefoonversie) even goed; MPEG4/AAC, 3GPP en MP3 slikt hij ook (wv172, 9-10).
function audioSoort(b) {
  if (!Buffer.isBuffer(b) || b.length < 64) return null;
  const a = function (i, n) { return b.toString('latin1', i, i + n); };
  if (a(0, 4) === 'RIFF' && a(8, 4) === 'WAVE') return { ext: 'wav', type: 'audio/wav' };
  if (a(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3', type: 'audio/mpeg' };
  if (a(4, 4) === 'ftyp') return /^3g/.test(a(8, 3)) ? { ext: '3gp', type: 'audio/3gpp' } : { ext: 'm4a', type: 'audio/mp4' };
  if (a(0, 4) === 'OggS') return { ext: 'ogg', type: 'audio/ogg' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', type: 'audio/webm' };
  return null;
}
const AANLEVER_MAX = 15 * 1024 * 1024;   // een bandje is hooguit een paar minuten; ruim onder de uploadgrens (20 MB) en de grens van Whisper
const AANLEVER_PER_UUR = 10;
const UITSCHRIJF_HINT = 'Tolgaarde, Groenhouten, huisartsenpraktijk, huisartsenpost, doktersassistente, spoedlijn, receptenlijn, keuzemenu';

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

// ── versiemodel (wv830, David 22-10-2026) ──
// Per bandje hooguit twee versies: vN staat in de centrale (veld "in centrale: vN …"; geen veld = v0, nog nooit in de centrale) en
// hooguit één werkversie v(N+1). Een tekstwijziging (eigen of een overgenomen voorstel) en elke nieuwe generatie horen bij die
// werkversie: opnieuw genereren of de tekst nog eens wijzigen overschrijft v(N+1), het nummer loopt niet op. "Staat in centrale" kan
// zodra de werkversie een gemaakt bandje heeft; dan is v(N+1) de actuele en begint een volgende poging als v(N+2).
function centraleVersie(velden) { const m = /^\s*v(\d+)\b/.exec(String(velden && velden['in centrale'] || '')); return m ? Number(m[1]) : 0; }
function werkNummer(b) { const n = centraleVersie(b.velden); return b.versie > n ? b.versie : n + 1; }
// "22-10-2026 · v2 · stem · model · 0123456789abcdef/bandje.wav (+ …) · tekst <hash>" → { versie, job, hash } (hash pas sinds wv830)
function laatsteVan(w) {
  w = String(w || '');
  const v = /·\s*v(\d+)\s*·/.exec(w), j = /\b([a-f0-9]{16})\/[^\s]+/.exec(w), h = /·\s*tekst ([a-f0-9]{16})\b/.exec(w);
  return v && j ? { versie: Number(v[1]), job: j[1], hash: h ? h[1] : null } : null;
}
// Kan dit bandje nu als "staat in de centrale" gemarkeerd worden? Werkversie bestaat, is gemaakt (status én laatste bestand op deze
// versie) en het gemaakte geluid hoort bij de tekst van nu (hash in het veld; oudere velden zonder hash toetst de route aan de taak).
function kanCentrale(b) {
  const n = centraleVersie(b.velden), lb = laatsteVan(b.velden['laatste bestand']);
  return !b.onbekend && !!b.tekst && b.versie > n && /^gemaakt\b/i.test(b.velden.status || '') && !!lb && lb.versie === b.versie && (!lb.hash || lb.hash === b.hash);
}

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
    in_centrale: v['in centrale'] || '', gehoord: v.gehoord || '', bron: v.bron || '', aandachtspunt: v.aandachtspunt || '', voorstel: b.voorstel, spreek_eigen: b.spreek || null,
    vrager: vragerVan(v['gevraagd door']), aangeleverd: /^[—–-]?$/.test(String(v.aangeleverd || '').trim()) ? '' : v.aangeleverd,   // wv3768
    // wv830: versiemodel (zie werkNummer); werkversie = null als de tekst die van de centrale is
    centrale_versie: centraleVersie(v), werkversie: b.versie > centraleVersie(v) ? b.versie : null, volgende_versie: werkNummer(b), kan_centrale: kanCentrale(b) };
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
  // wv830: een tekstwijziging hoort bij de werkversie v(N+1); bestaat die al, dan wordt hij overschreven (nummer blijft)
  const nieuwV = werkNummer(b);
  if (tekstWijzigt) {
    velden.versie = String(nieuwV);
    // terug naar precies de tekst van het gemaakte bandje van deze versie (Fable wv830 #9): weer "gemaakt", geen nieuwe generatie nodig
    const lb = laatsteVan(b.velden['laatste bestand']);
    velden.status = lb && lb.hash && lb.hash === tekstHash(t.tekst) && lb.versie === nieuwV ? 'gemaakt (v' + nieuwV + ')' : 'concept (v' + nieuwV + ')';
  }
  if (stemWijzigt) velden.stem = stem;
  let regels = vervangSectie(p, b, herschrijfSectie(p, b, { velden: velden, tekst: tekstWijzigt ? t.tekst : undefined, voorstel: voorstelWeg ? null : undefined }));
  // de versiegeschiedenis bewaart de tekst die in de centrale stond (vN), niet elk concept (die staan in het journaal). De eerste
  // tekstwijziging na vN vervangt altijd de tekst van vN: ook als een nieuwe generatie het nummer al naar v(N+1) zette (tekst gelijk)
  const n = centraleVersie(b.velden);
  const histV = b.versie <= n ? b.versie : n;
  const alGehad = new RegExp('^### ' + b.id + ' v' + histV + ' — ', 'm').test(md);
  if (!b.onbekend && tekstWijzigt && histV >= 1 && !alGehad) regels = voegGeschiedenisToe(regels, ['### ' + b.id + ' v' + histV + ' — vervangen ' + vandaag(klok)].concat(citaat(b.tekst)));
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
// wv3723 (2C91a, David Ja 21-11 13:18): de tekst gelijktrekken met wat al is ingesproken, zonder opnieuw te maken. Kan alleen als het
// gemaakte bandje bij de tekst van nu hoort (kanCentrale), er een voorstel ligt, en dat voorstel precies de spreektekst oplevert waarmee
// het geluid gemaakt is: de automatische spreektekst van het voorstel (met de uitspraaklijst) = de spreektekst die Maak nu zou gebruiken
// (eigen of automatisch). Dan zegt het geluid al wat het voorstel schrijft. o: { versie, tekst_hash, spreek_na_maak } (spreek_na_maak = het
// journaal zag een spreektekstwijziging na het laatste maken: dan weten we niet meer wat de stem zei, dus nee). Het voorstel wordt de
// tekst; versie en status blijven (geen nieuw geluid), "laatste bestand" en de eigen spreektekst krijgen de nieuwe tekst-hash, zodat de
// koppeling tekst ↔ geluid (kanCentrale, de knop Staat in de centrale) blijft kloppen. De tekst van de centrale gaat zoals bij Bewaar
// naar de versiegeschiedenis.
// De woorden die de stem zegt, zonder pauzes of tags (spreektekst met [pauze], of de modeltekst met [pause]/<break> uit de Studio-taak)
function kaal(t) { return SPREEK.naarModel(String(t || '').replace(/\[\s*(?:long\s+)?pause\s*\]/gi, ' ').replace(/<break\b[^>]{0,80}>/gi, ' '), null).replace(/\s+/g, ' ').trim(); }
// gezegd = de tekst die werkelijk naar de stem ging (velden.tekst van de Studio-taak van het laatste bestand). Zonder die taak: nee
// (Codex MOET 1, wv3723: het journaal is geen bewijs; ook 'velden' zoals gehoord telt daar als schrijven).
// u = een bandje zoals bandjeUit het geeft (ook zo in GET /app/bandjes)
function gelijkFout(u, inst, spreekNaMaak, gezegd) {
  if (!u.voorstel) return 'er ligt geen voorstel';
  if (u.voorstel.tekst === u.tekst) return 'het voorstel is gelijk aan de tekst';
  if (!u.kan_centrale) return 'dit kan alleen bij een gemaakt bandje dat nog niet in de centrale staat';
  const nieuw = kaal(SPREEK.afleiden(u.voorstel.tekst, inst && inst.uitspraak));
  // Codex MOET 1: alleen met de opname zelf als bewijs (de Studio-taak); zonder taak is niet na te gaan wat de stem zei
  if (typeof gezegd !== 'string') return 'niet na te gaan wat de stem bij het maken zei; neem het voorstel over en druk op Maak';
  if (!nieuw || kaal(gezegd) !== nieuw) return 'het voorstel klinkt anders dan het gemaakte bandje; neem het over en druk op Maak';
  return null;
}
function gelijkTrekken(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (Number(o.versie) !== b.versie || String(o.tekst_hash || '') !== b.hash) return { status: 409, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true };
  const f = gelijkFout(bandjeUit(b), p.instellingen, !!o.spreek_na_maak, typeof o.gezegd === 'string' ? o.gezegd : undefined);
  if (f) return { status: 409, fout: f };
  const t = toetsTekst(b.voorstel.tekst);
  if (t.fout) return { status: 400, fout: t.fout };
  const nieuweHash = tekstHash(t.tekst);
  const lbOud = String(b.velden['laatste bestand'] || '');
  const lbNieuw = lbOud.replace('tekst ' + b.hash, 'tekst ' + nieuweHash);
  if (lbNieuw === lbOud) return { status: 409, fout: 'het laatste bestand noemt de tekst niet; maak het opnieuw' };
  const w = { velden: { 'laatste bestand': lbNieuw }, tekst: t.tekst, voorstel: null };
  if (b.spreek && b.spreek.bij === b.hash) w.spreek = { tekst: b.spreek.tekst, kop: '(bij v' + b.versie + ', tekst ' + nieuweHash + ', ' + vandaag(klok) + ', gelijkgetrokken met het gemaakte bandje)' };
  let regels = vervangSectie(p, b, herschrijfSectie(p, b, w));
  const n = centraleVersie(b.velden);
  const alGehad = new RegExp('^### ' + b.id + ' v' + n + ' — ', 'm').test(md);
  if (n >= 1 && !alGehad && !b.onbekend) regels = voegGeschiedenisToe(regels, ['### ' + b.id + ' v' + n + ' — vervangen ' + vandaag(klok)].concat(citaat(b.tekst)));
  const uit = klaar(zetUpdated(regels, klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)), oude_hash: b.hash };
}
// Losse velden (laatste bestand, in centrale, status) — alleen deze sleutels.
const VRIJE_VELDEN = ['laatste bestand', 'in centrale', 'status', 'stem', 'gehoord', 'gevraagd door', 'aangeleverd'];   // wv3723: gehoord (belkaart); wv3768: vrager, aanlevering
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
// Na een geslaagde generatie (wv830): het register naar de werkversie. o: { basis, versie, tekst_hash, waarde }. basis = de versie die de
// app las toen hij op Maak drukte; versie = het doel (werkNummer op dat moment). Klopt basis, hash of doel niet meer (intussen
// gewijzigd of al gemarkeerd), dan 409 en blijft het register zoals het is.
function zetGemaakt(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (Number(o.basis) !== b.versie || String(o.tekst_hash || '') !== b.hash) return { status: 409, fout: 'dit bandje is intussen gewijzigd', gewijzigd: true };
  // doel null (taak van vóór wv830, zonder basis; Fable wv830 #11): de werkversie van nu
  const doel = o.versie == null ? werkNummer(b) : Number(o.versie);
  if (doel !== werkNummer(b)) return { status: 409, fout: 'de versie klopt niet meer (intussen in de centrale gezet?)', gewijzigd: true };
  const waarde = typeof o.waarde === 'function' ? o.waarde(doel) : o.waarde;
  const uit = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { velden: { versie: String(doel), 'laatste bestand': waarde, status: 'gemaakt (v' + doel + ')' } })), klok));
  return { status: 200, md: uit, bandje: bandjeUit(zoek(parse(uit, voorvoegsel), id)) };
}
// "Staat in centrale" (wv830): de werkversie wordt de actuele. o: { versie, tekst_hash, waarde } (waarde = "vN sinds <datum>, [[archief]]").
function zetInCentrale(md, voorvoegsel, id, o, klok) {
  const p = parse(md, voorvoegsel);
  if (p.fouten.length) return { status: 409, fout: 'de registerpagina is niet in orde: ' + p.fouten.join('; ') };
  const b = zoek(p, id);
  if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
  if (Number(o.versie) !== b.versie || String(o.tekst_hash || '') !== b.hash) return { status: 409, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true };
  if (!kanCentrale(b)) return { status: 409, fout: b.versie <= centraleVersie(b.velden) ? 'deze versie staat al in de centrale' : 'maak eerst het bandje van deze versie', gewijzigd: true };
  const uit = klaar(zetUpdated(vervangSectie(p, b, herschrijfSectie(p, b, { velden: { 'in centrale': o.waarde, status: 'in centrale (v' + b.versie + ')' } })), klok));
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
    '- stem: praktijkstem', '- versie: ' + (tekst ? '1' : '0'), '- laatste bestand: —', '- in centrale: —', '- status: ' + (tekst ? 'concept (v1)' : 'tekst onbekend'),
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
    // wv830: de werkversie wordt overschreven zonder nieuw nummer; daarom ook de hashes die de pod eerder op dezelfde versie schreef
    // (eerder): staat zo'n oudere hash weer in de pagina, dan zette de synchronisatie een oudere kopie terug
    t.split('\n').forEach(function (r) {
      if (!r) return;
      try {
        const j = JSON.parse(r); if (!j.bandje) return; const k = j.praktijk + '/' + j.bandje;
        const vorig = st[k];
        if (!vorig || j.versie >= vorig.versie) {
          const eerder = vorig && vorig.versie === j.versie ? Object.assign({}, vorig.eerder) : {};
          if (vorig && vorig.versie === j.versie && vorig.tekst_hash && vorig.tekst_hash !== j.tekst_hash) eerder[vorig.tekst_hash] = true;
          delete eerder[j.tekst_hash];
          st[k] = Object.assign({}, j, { eerder: eerder, centrale: Math.max(typeof j.centrale === 'number' ? j.centrale : 0, vorig && typeof vorig.centrale === 'number' ? vorig.centrale : 0) });
        }
      } catch (e) {}
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
    try { st = fs.lstatSync(f); } catch (e) { return { status: 200, praktijk: pr, ontbreekt: true, bandjes: [], instellingen: {}, fouten: [], dicht: 'de registerpagina ontbreekt' }; }
    let c = cache[pr];
    // wv900 (Fable #7): een symlink of iets anders dan een gewoon bestand op de registerplek = dicht (met box-rij), niet een 500
    const nietGewoon = { status: 200, praktijk: pr, bandjes: [], instellingen: {}, fouten: ['de registerpagina is een symlink of geen gewoon bestand'],
      dicht: 'de registerpagina is een symlink of geen gewoon bestand' };
    if (!st.isFile()) return nietGewoon;
    if (!c || c.mtime !== st.mtimeMs || c.grootte !== st.size) {   // gelijkheid, niet "nieuwer": een teruggezette kopie is ouder (Fable #2)
      let md;
      try { md = VV.lees(f); } catch (e) { if (e && /^(ELOOP|ESYMLINK|ENOTREG)$/.test(e.code)) return nietGewoon; throw e; }
      c = cache[pr] = { mtime: st.mtimeMs, grootte: st.size, p: parse(md, PRAKTIJKEN[pr].voorvoegsel) };
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
      else if (j && b.versie === j.versie && b.hash !== j.tekst_hash && j.eerder && j.eerder[b.hash]) teruggezet.push(b.id + ' (een eerdere tekst van v' + b.versie + ' staat weer in de pagina)');
      // "in centrale" bepaalt sinds wv830 de nummering: een kopie met een lagere centrale-versie dan de pod schreef is teruggezet (Fable #5)
      else if (j && typeof j.centrale === 'number' && centraleVersie(b.velden) < j.centrale) teruggezet.push(b.id + ' (in centrale v' + centraleVersie(b.velden) + ' terwijl v' + j.centrale + ' bewaard was)');
    });
    if (teruggezet.length) redenen.push('teruggezet door de synchronisatie: ' + teruggezet.join(', '));
    return { status: 200, praktijk: pr, naam: PRAKTIJKEN[pr].naam, instellingen: p.instellingen, bandjes: p.bandjes.map(bandjeUit),
      fouten: p.fouten, conflicten: conf, teruggezet: teruggezet, dicht: redenen.length ? redenen.join(' · ') : null };
  }
  // wv900: eigen tmp met O_EXCL in de getoetste vaultmap + rename (vault-veilig.js). Vroeger een tmp buiten de vault + rename:
  // dat volgde een map die socev door een symlink verving (rename naar een map naar keuze).
  function schrijfAtomair(f, inhoud) { VV.schrijf(f, inhoud, { modus: 0o644 }); }

  // Voert een mutatie uit: lezen, toetsen, schrijven, journaal — allemaal synchroon.
  function muteer(pr, actie, fn) {
    const l = lees(pr);
    if (l.status !== 200) return l;
    if (l.dicht) return { status: 409, fout: l.dicht, dicht: true };
    const f = pad(pr);
    const md = VV.lees(f);
    const r = fn(md, PRAKTIJKEN[pr].voorvoegsel);
    if (r.status !== 200 || r.ongewijzigd) return r;
    schrijfAtomair(f, r.md);
    delete cache[pr];
    try {
      mkdir(DIR);
      fs.appendFileSync(JOURNAAL, JSON.stringify(r.bandje ? { tijd: new Date(klok()).toISOString(), praktijk: pr, bandje: r.bandje.id, actie: actie,
        versie: r.bandje.versie, tekst_hash: r.bandje.tekst_hash, centrale: r.bandje.centrale_versie, tekst: r.bandje.tekst } : { tijd: new Date(klok()).toISOString(), praktijk: pr, actie: actie,
        instellingen: r.instellingen || null }) + '\n', { mode: 0o600 });
    } catch (e) { fout('bandjes-journaal', e); }
    return r.bandje ? { status: 200, bandje: r.bandje } : { status: 200, instellingen: r.instellingen };
  }
  // ── archief (wv830): bij "Staat in centrale" de bestanden + tekst naar 10_Zakelijk/<Praktijk>/Telefoon/Archief/ ──
  // a: { versie, tekst_hash, bestanden: [{ naam, pad }], spreektekst, stem, model, job }. Eerst alle toetsen (zelfde als zetInCentrale),
  // dan de bestanden (nooit overschrijven: bestaat de naam al, dan -2, -3 …), dan het register. Mislukt het register daarna, dan blijft
  // het archief staan (gedateerd, onschadelijk) en meldt de route de fout.
  const ARCHIEF_BESTANDEN = [['bandje-telefoon-ulaw.wav', '-telefoon-ulaw.wav', 'telefoon, WAV 8 kHz µ-law'], ['bandje-telefoon-pcm.wav', '-telefoon-pcm.wav', 'telefoon, WAV 8 kHz PCM'], ['bandje.wav', '-luister.wav', 'luisterversie, goede kwaliteit']];
  // Schrijft het archief van één versie: de bestanden (kopie, 0644, nooit overschrijven: naam bezet = -2, -3 …) en een .md met tekst,
  // spreektekst en links. a: { bestanden: [{ naam, pad }], spreektekst, stem, model, job, origineel?: vaultpad, toelichting? }.
  // origineel = het geluid staat al in de vault (de aangeleverde opname): dan alleen de .md met een link ernaar. Geeft
  // { basis, vaultBasis } of { fout }. Half geschreven = alles weer weg.
  function schrijfArchief(pr, b, a, klokIso) {
    const f = pad(pr);
    const lijst = ARCHIEF_BESTANDEN.map(function (x) { const g = (a.bestanden || []).find(function (y) { return y && y.naam === x[0]; }); return g ? { bron: g.pad, achter: x[1], uitleg: x[2] } : null; }).filter(Boolean);
    if (!lijst.length && !a.origineel) return { status: 409, fout: 'de bestanden van dit bandje staan niet meer in Bestanden (30 dagen); maak het opnieuw en zet het dan in de centrale' };
    const map = path.join(path.dirname(f), 'Archief');
    const iso = klokIso || vandaagIso(klok);
    let basis = b.id + '-v' + b.versie + '-' + iso, n = 2;
    const bezet = function (bs) { return fs.existsSync(path.join(map, bs + '.md')) || ARCHIEF_BESTANDEN.some(function (x) { return fs.existsSync(path.join(map, bs + x[1])); }); };
    while (bezet(basis)) basis = b.id + '-v' + b.versie + '-' + iso + '-' + (n++);
    const vaultMap = path.posix.join(path.posix.dirname(PRAKTIJKEN[pr].pad), 'Archief');
    const geschreven = [];
    try {
      fs.mkdirSync(map, { recursive: true, mode: 0o755 });
      mkdir(path.join(DIR, 'tmp'));
      lijst.forEach(function (x) {
        const doel = path.join(map, basis + x.achter);
        VV.schrijf(doel, fs.readFileSync(x.bron), { modus: 0o644 });   // wv900: bron = Bestanden op de pod; doel in de getoetste vaultmap
        geschreven.push(doel);
      });
      const v = b.velden;
      const regels = ['---', 'type: bandje-archief', 'praktijk: ' + PRAKTIJKEN[pr].naam, 'bandje: ' + b.id, 'versie: ' + b.versie,
        'in centrale sinds: ' + iso, 'stem: ' + eenRegel(a.stem || v.stem || '', 100), 'model: ' + eenRegel(a.model || '—', 60), 'job: ' + eenRegel(a.job || '—', 20),
        'tekst_hash: ' + b.hash, 'updated: ' + iso, '---', '', '# ' + b.id + ' v' + b.versie + ' — ' + b.naam, '',
        (a.toelichting ? eenRegel(a.toelichting, 400) : 'In de centrale gezet op ' + vandaag(klok) + ' (gemarkeerd in de App Bandjes).') + ' Register: [[' + PRAKTIJKEN[pr].pad.replace(/\.md$/, '') + ']].', '',
        '- menu: ' + eenRegel(v.menu || '', GRENS.veld), '- wanneer: ' + eenRegel(v.wanneer || '', GRENS.veld)].concat(
        lijst.map(function (x) { return '- ' + x.uitleg + ': ![[' + vaultMap + '/' + basis + x.achter + ']]'; }),
        a.origineel ? ['- opname zoals die in de centrale stond: ![[' + eenRegel(a.origineel, 300) + ']]'] : [],
        ['', '**Tekst**'], citaat(b.tekst), a.spreektekst ? ['', '**Spreektekst** (wat de stem zei)'].concat(citaat(String(a.spreektekst).slice(0, 4000))) : [], ['']);
      const doelMd = path.join(map, basis + '.md');
      schrijfAtomair(doelMd, regels.join('\n'));
      geschreven.push(doelMd);
    } catch (e) {
      geschreven.forEach(function (g) { try { fs.unlinkSync(g); } catch (x) {} });
      fout('bandjes-archief', e);
      return { status: 500, fout: 'het archief kon niet geschreven worden; er is niets gemarkeerd' };
    }
    return { status: 200, basis: basis, vaultBasis: vaultMap + '/' + basis };
  }
  // ── geluid van de werkversie (wv3064, David 14-11-2026 via het advies van Fable) ──
  // Het geluid van een gemaakt bandje staat in Bestanden (30 dagen). Staat de werkversie dan nog niet in de centrale, dan was het weg
  // (opnieuw maken = credits). Daarom een eigen kopie per bandje in DIR/werkversies/<praktijk>/<id>/ (meta.json + b/<n>, 0700/0600):
  // één versie per bandje (een nieuwere Maak vervangt hem), weg zodra die versie (of een latere) in de centrale staat. De 30-dagenregel
  // van Bestanden blijft zoals hij is. Bij twijfel (register dicht, onleesbaar) raakt de ronde niets aan.
  const WERK = path.join(DIR, 'werkversies');
  const WERK_NAMEN = new Set(ARCHIEF_BESTANDEN.map(function (x) { return x[0]; }));
  const WERK_RESTEN_MS = 3600 * 1000;
  function werkMap(pr, id) { return Object.hasOwn(PRAKTIJKEN, pr) && ID_RE.test(String(id)) ? path.join(WERK, pr, String(id)) : null; }
  // { job, versie, tekst_hash, bewaard_op, bestanden: [{ n, naam, grootte, pad }] } of null (geen map, geen leesbare meta, geen geluid)
  function werkversie(pr, id) {
    const d = werkMap(pr, id);
    if (!d) return null;
    let m;
    try {
      if (!fs.lstatSync(d).isDirectory() || !fs.lstatSync(path.join(d, 'meta.json')).isFile()) return null;
      m = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8'));
    } catch (e) { return null; }
    if (!m || !/^[a-f0-9]{16}$/.test(String(m.job)) || !Array.isArray(m.bestanden)) return null;
    const best = [];
    m.bestanden.forEach(function (x) {
      if (!x || !Number.isInteger(x.n) || x.n < 1 || x.n > 999 || !WERK_NAMEN.has(String(x.naam))) return;
      const p = path.join(d, 'b', String(x.n));
      try { const st = fs.lstatSync(p); if (st.isFile()) best.push({ n: x.n, naam: String(x.naam), grootte: st.size, pad: p }); } catch (e) {}
    });
    if (!best.length) return null;
    return { job: String(m.job), versie: Number.isInteger(m.versie) ? m.versie : 0, tekst_hash: /^[a-f0-9]{16}$/.test(String(m.tekst_hash)) ? String(m.tekst_hash) : null,
      bewaard_op: typeof m.bewaard_op === 'string' ? m.bewaard_op : null, bestanden: best };
  }
  // o: { job, versie, tekst_hash, bestanden: [{ n, naam, pad }] }. Eerst volledig in een nieuwe map, dan pas de oude vervangen.
  function bewaarWerkversie(pr, id, o) {
    const d = werkMap(pr, id);
    if (!d || !/^[a-f0-9]{16}$/.test(String(o && o.job))) return { status: 400, fout: 'onbekend bandje of job' };
    const lijst = (o.bestanden || []).filter(function (x) { return x && Number.isInteger(x.n) && x.n >= 1 && x.n <= 999 && WERK_NAMEN.has(String(x.naam)) && x.pad; });
    if (!lijst.length) return { status: 409, fout: 'geen geluid om te bewaren' };
    const stempel = process.pid + '-' + klok();
    const tmp = d + '.nieuw-' + stempel, oud = d + '.oud-' + stempel;
    try {
      mkdir(WERK); mkdir(path.join(WERK, pr));
      fs.mkdirSync(path.join(tmp, 'b'), { recursive: true, mode: 0o700 });
      const best = lijst.map(function (x) {
        if (!fs.lstatSync(x.pad).isFile()) throw new Error('bron is geen gewoon bestand');
        const doel = path.join(tmp, 'b', String(x.n));
        fs.copyFileSync(x.pad, doel, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(doel, 0o600);
        return { n: x.n, naam: String(x.naam), grootte: fs.statSync(doel).size };
      });
      fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ praktijk: pr, bandje: id, job: String(o.job), versie: Number(o.versie) || 0,
        tekst_hash: o.tekst_hash || null, bewaard_op: new Date(klok()).toISOString(), bestanden: best }), { mode: 0o600, flag: 'wx' });
      let had = false;
      try { fs.renameSync(d, oud); had = true; } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      try { fs.renameSync(tmp, d); } catch (e) { if (had) { try { fs.renameSync(oud, d); } catch (x) {} } throw e; }
      if (had) fs.rmSync(oud, { recursive: true, force: true });
      return { status: 200, bestanden: best.length };
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (x) {}
      fout('bandjes-werkversie', e);
      return { status: 500, fout: 'het geluid kon niet bewaard worden' };
    }
  }
  function ruimWerkversie(pr, id) {
    const d = werkMap(pr, id);
    if (!d) return false;
    const weg = d + '.weg-' + process.pid + '-' + klok();
    try { fs.renameSync(d, weg); } catch (e) { if (e && e.code !== 'ENOENT') fout('bandjes-werkversie-weg', e); return false; }
    try { fs.rmSync(weg, { recursive: true, force: true }); } catch (e) { fout('bandjes-werkversie-weg', e); }
    return true;
  }
  // Het bestand n van job (voor GET /app/bestand als Bestanden het na 30 dagen niet meer heeft): { naam, pad } of null.
  function werkBestand(job, n) {
    if (!/^[a-f0-9]{16}$/.test(String(job)) || !Number.isInteger(n)) return null;
    for (const pr of Object.keys(PRAKTIJKEN)) {
      let ids = [];
      try { ids = fs.readdirSync(path.join(WERK, pr)).filter(function (x) { return ID_RE.test(x); }); } catch (e) { continue; }
      for (const id of ids) {
        const w = werkversie(pr, id);
        if (!w || w.job !== job) continue;
        const b = w.bestanden.find(function (x) { return x.n === n; });
        return b ? { naam: b.naam, pad: b.pad } : null;
      }
    }
    return null;
  }
  // ── geluid van wat in de centrale staat (wv3544, Fable-review 2B57) ──
  // Na "Staat in centrale" ruimt de bewaarplek op en na 30 dagen is Bestanden leeg; het geluid staat dan alleen nog in het archief.
  // Zonder deze terugval zei de app "niet meer bewaard, maak opnieuw (kost credits)". Alleen het archief waar het register naar wijst
  // ("in centrale: vN sinds …, [[…/Archief/<id>-vN-<datum>]]"), en alleen als de .md dezelfde versie en een job heeft. De nummering is
  // die van Bestanden (op naam gesorteerd, zoals appBewaar), zodat job/n hetzelfde bestand blijft, ook in een nog open scherm.
  // { job, versie, tekst_hash, bestanden: [{ n, naam, grootte, pad }] } of null
  function archiefVan(pr, b) {
    if (!b || !Object.hasOwn(PRAKTIJKEN, pr) || !ID_RE.test(String(b.id))) return null;
    const v = Number(b.centrale_versie);
    if (!Number.isInteger(v) || v < 1) return null;
    const vaultMap = path.posix.join(path.posix.dirname(PRAKTIJKEN[pr].pad), 'Archief');
    const m = /\[\[([^\]|#]+)\]\]/.exec(String(b.in_centrale || ''));
    if (!m || path.posix.dirname(m[1]) !== vaultMap) return null;
    const basis = path.posix.basename(m[1]);
    const bm = new RegExp('^' + String(b.id) + '-v(\\d+)-\\d{4}-\\d{2}-\\d{2}(-\\d+)?$').exec(basis);
    if (!bm || Number(bm[1]) !== v) return null;
    const map = path.join(path.dirname(pad(pr)), 'Archief');
    let md;
    try { md = VV.lees(path.join(map, basis + '.md'), 'utf8', { max: 256 * 1024 }); } catch (e) { return null; }
    const fm = /^---\n([\s\S]*?)\n---/.exec(md);
    const veld = function (k) { const x = fm && new RegExp('^' + k + ': *(.*)$', 'm').exec(fm[1]); return x ? x[1].trim() : ''; };
    if (!fm || veld('type') !== 'bandje-archief' || veld('bandje') !== String(b.id) || Number(veld('versie')) !== v) return null;
    const job = veld('job');
    if (!/^[a-f0-9]{16}$/.test(job)) return null;   // migratie zonder job (v1 van 22-10): geen geluid om te koppelen
    // Codex MOET 1: de nummering moet die van Bestanden blijven. Daarom precies de bestanden die de .md noemt (zoveel als er bij het archiveren
    // waren); ontbreekt er één of is het geen gewoon bestand (symlink), dan niets koppelen in plaats van de nummers te laten verschuiven.
    const best = [];
    let heel = true;
    ARCHIEF_BESTANDEN.forEach(function (x) {
      if (md.indexOf('![[' + vaultMap + '/' + basis + x[1] + ']]') < 0) return;
      const p = path.join(map, basis + x[1]);
      try { const st = fs.lstatSync(p); if (st.isFile()) best.push({ naam: x[0], grootte: st.size, pad: p }); else heel = false; } catch (e) { heel = false; }
    });
    if (!heel || !best.length) return null;
    best.sort(function (a, c) { return a.naam < c.naam ? -1 : a.naam > c.naam ? 1 : 0; });
    best.forEach(function (x, i) { x.n = i + 1; });
    const th = veld('tekst_hash');
    return { job: job, versie: v, tekst_hash: /^[a-f0-9]{16}$/.test(th) ? th : null, bestanden: best };
  }
  // Het bestand n van job uit het archief van wat nu in de centrale staat: { naam, pad } of null.
  function archiefBestand(job, n) {
    if (!/^[a-f0-9]{16}$/.test(String(job)) || !Number.isInteger(n)) return null;
    for (const pr of Object.keys(PRAKTIJKEN)) {
      let l;
      try { l = lees(pr); } catch (e) { continue; }
      for (const b of (l && l.bandjes) || []) {
        if (String(b.in_centrale || '').indexOf('[[') < 0) continue;
        const a = archiefVan(pr, b);
        if (!a || a.job !== job) continue;
        const x = a.bestanden.find(function (y) { return y.n === n; });
        return x ? { naam: x.naam, pad: x.pad } : null;
      }
    }
    return null;
  }
  // Brak een vervanging af tussen de twee renames (proces gestopt), dan ontbreekt de map zelf maar staat er een …nieuw- (volledig: meta.json
  // wordt als laatste geschreven) of een …oud-. Zet de jongste volledige …nieuw- terug, anders de jongste …oud-. Brak hij af vóór de eerste
  // rename (map = vorige job, …nieuw- = de job uit het register), dan wisselt de …nieuw- alsnog in (Codex ronde 2).
  function herstelWerk(pr, uit, laatsteJob) {
    let namen = [];
    try { namen = fs.readdirSync(path.join(WERK, pr)); } catch (e) { return; }
    const rest = {};
    namen.forEach(function (x) {
      const m = /^(.+)\.(nieuw|oud)-\d+-(\d+)$/.exec(x);
      if (m && ID_RE.test(m[1])) (rest[m[1]] = rest[m[1]] || []).push({ naam: x, soort: m[2], t: Number(m[3]) });
    });
    Object.keys(rest).forEach(function (id) {
      const d = werkMap(pr, id);
      const jobVan = function (naam) { try { const p = path.join(WERK, pr, naam); return fs.lstatSync(path.join(p, 'meta.json')).isFile() ? String(JSON.parse(fs.readFileSync(path.join(p, 'meta.json'), 'utf8')).job || '') : ''; } catch (e) { return ''; } };
      const heel = function (x) { return !!jobVan(x.naam); };
      let bestaat = true;
      try { fs.lstatSync(d); } catch (e) { if (!e || e.code !== 'ENOENT') return; bestaat = false; }
      if (bestaat) {
        const doel = laatsteJob && laatsteJob[id], nu = werkversie(pr, id);
        const nieuw = doel && (!nu || nu.job !== doel) ? rest[id].filter(function (x) { return x.soort === 'nieuw' && jobVan(x.naam) === doel; }).sort(function (a, b) { return b.t - a.t; })[0] : null;
        if (!nieuw) return;
        try {
          fs.renameSync(d, d + '.oud-' + process.pid + '-' + klok());
          fs.renameSync(path.join(WERK, pr, nieuw.naam), d);
          if (uit) uit.hersteld = (uit.hersteld || 0) + 1;
        } catch (e) { fout('bandjes-werkversie-herstel', e); }
        return;
      }
      const kies = rest[id].filter(heel).sort(function (a, b) { return (a.soort === b.soort ? b.t - a.t : a.soort === 'nieuw' ? -1 : 1); })[0];
      if (!kies) return;
      try { fs.renameSync(path.join(WERK, pr, kies.naam), d); if (uit) uit.hersteld = (uit.hersteld || 0) + 1; } catch (e) { fout('bandjes-werkversie-herstel', e); }
    });
  }
  // Per bandje: staat de bewaarde versie (of een latere) in de centrale → weg; is er een nieuwere gemaakte werkversie waarvan Bestanden
  // het geluid (met telefoonversie) nog heeft → die bewaren (vervangt de vorige). bestandVan(job) = [{ n, naam, pad }] of null.
  function werkRonde(bestandVan) {
    const uit = { bewaard: 0, opgeruimd: 0, fouten: 0, overgeslagen: 0, hersteld: 0 };
    Object.keys(PRAKTIJKEN).forEach(function (pr) {
      let l;
      try { l = lees(pr); } catch (e) { uit.fouten++; return; }
      if (l.status !== 200 || l.dicht || l.ontbreekt) { uit.overgeslagen++; return; }
      const laatsteJob = {};
      l.bandjes.forEach(function (b) { const lb = laatsteVan(b.laatste_bestand); if (lb && lb.versie > b.centrale_versie) laatsteJob[b.id] = lb.job; });
      herstelWerk(pr, uit, laatsteJob);   // Codex MOET 1: eerst een onderbroken vervanging terugzetten, pas daarna resten opruimen
      l.bandjes.forEach(function (b) {
        let w = werkversie(pr, b.id);
        // Codex MOET 2: na het opruimen doorgaan; er kan al een nieuwere gemaakte werkversie zijn die bewaard moet worden
        if (w && w.versie <= b.centrale_versie) { if (ruimWerkversie(pr, b.id)) uit.opgeruimd++; w = null; }
        const lb = laatsteVan(b.laatste_bestand);
        if (!lb || lb.versie <= b.centrale_versie || (w && w.job === lb.job)) return;
        let bs = null;
        try { bs = bestandVan ? bestandVan(lb.job) : null; } catch (e) { bs = null; }
        if (!bs || !bs.some(function (x) { return x && /^bandje-telefoon-(ulaw|pcm)\.wav$/.test(x.naam); })) return;
        const r = bewaarWerkversie(pr, b.id, { job: lb.job, versie: lb.versie, tekst_hash: lb.hash, bestanden: bs });
        if (r.status === 200) uit.bewaard++; else uit.fouten++;
      });
      // resten (…nieuw-/…oud-/…weg-) na een uur weg, maar alleen als het bandje zelf een leesbare kopie heeft (of het een …weg- is)
      try {
        fs.readdirSync(path.join(WERK, pr)).forEach(function (x) {
          const m = /^(.+)\.(nieuw|oud|weg)-\d+-\d+$/.exec(x);
          if (!m) return;
          if (m[2] !== 'weg' && !werkversie(pr, m[1])) return;
          const p = path.join(WERK, pr, x);
          try { if (klok() - fs.lstatSync(p).mtimeMs > WERK_RESTEN_MS) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
        });
      } catch (e) {}
    });
    return uit;
  }
  // wv3723: wijzigde de pod de spreektekst van dit bandje ná het laatste maken (journaal: spreektekst na gemaakt/velden)? Geen enkel
  // maakspoor in het journaal maar wel een spreektekstwijziging = ook ja (niet na te gaan wat de stem zei).
  function spreekNaMaak(pr, id) {
    let t = '';
    try { t = fs.readFileSync(JOURNAAL, 'utf8'); } catch (e) { return false; }
    let gemaakt = '', spreek = '';
    t.split('\n').forEach(function (r) {
      if (!r) return;
      try { const j = JSON.parse(r); if (j.praktijk !== pr || j.bandje !== id) return; if (j.actie === 'gemaakt' || j.actie === 'velden') gemaakt = j.tijd > gemaakt ? j.tijd : gemaakt; else if (j.actie === 'spreektekst') spreek = j.tijd > spreek ? j.tijd : spreek; } catch (e) {}
    });
    return !!spreek && !(gemaakt && spreek < gemaakt);
  }
  // wv3723: de bewaarde werkversie hoort na het gelijktrekken bij de nieuwe tekst-hash (meta.json, zelfde job)
  function werkHash(pr, id, oud, nieuw) {
    const d = werkMap(pr, id);
    if (!d) return false;
    try {
      const f = path.join(d, 'meta.json');
      if (!fs.lstatSync(f).isFile()) return false;
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!m || m.tekst_hash !== oud) return false;
      m.tekst_hash = nieuw;
      const tmp = f + '.' + process.pid + '-' + klok();
      fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, f);
      return true;
    } catch (e) { if (!e || e.code !== 'ENOENT') fout('bandjes-werkversie-hash', e); return false; }
  }
  function inCentrale(pr, id, a) {
    const l = lees(pr);
    if (l.status !== 200) return l;
    if (l.dicht) return { status: 409, fout: l.dicht, dicht: true };
    const md = VV.lees(pad(pr));
    const vv = PRAKTIJKEN[pr].voorvoegsel;
    const b = zoek(parse(md, vv), id);
    if (!b) return { status: 404, fout: 'dit bandje staat niet in het register' };
    // proefronde: dezelfde toetsen als het schrijven, met een tijdelijke waarde (eerst toetsen, dan pas het archief)
    const proef = zetInCentrale(md, vv, id, { versie: a.versie, tekst_hash: a.tekst_hash, waarde: 'v' + b.versie }, klok);
    if (proef.status !== 200) return proef;
    const ar = schrijfArchief(pr, b, a);
    if (ar.status !== 200) return ar;
    const waarde = 'v' + b.versie + ' sinds ' + vandaag(klok) + ', [[' + ar.vaultBasis + ']]';
    // mislukt het register nu nog (in de tussentijd gewijzigd), dan blijft het archief staan: gedateerd en onschadelijk
    const r = muteer(pr, 'in-centrale', function (md2, vv2) { return zetInCentrale(md2, vv2, id, { versie: a.versie, tekst_hash: a.tekst_hash, waarde: waarde }, klok); });
    if (r.status === 200) r.archief = ar.vaultBasis + '.md';
    return r;
  }
  // wv3768 (d): het aangeleverde geluid in de Bronnen-map van de praktijk (zoals de opnames van 22-10), nooit overschrijven (bezet = -2,
  // -3 …), 0644. Geeft { vaultPad, naam } of { fout }. Naam kort gehouden: het veld "aangeleverd" (hooguit 160 tekens) linkt ernaar.
  function bewaarAanlevering(pr, b, bytes, ext) {
    if (!Object.hasOwn(PRAKTIJKEN, pr) || !/^(wav|mp3|m4a|3gp|ogg|webm)$/.test(String(ext))) return { fout: 'onbekend formaat' };
    const vaultMap = path.posix.join(path.posix.dirname(path.posix.dirname(PRAKTIJKEN[pr].pad)), 'Bronnen');
    const map = path.join(VAULT, vaultMap);
    const kortNaam = String(b.naam || b.id).normalize('NFC').replace(/[\\/:*?"<>|#^\[\]\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30).trim() || b.id;
    const basis = PRAKTIJKEN[pr].naam + ' - ' + vandaagIso(klok) + ' - Telefoonbandje ' + kortNaam + ' (aangeleverd';
    let naam = basis + ').' + ext, n = 2;
    try {
      fs.mkdirSync(map, { recursive: true, mode: 0o755 });
      while (fs.existsSync(path.join(map, naam))) { naam = basis + ' ' + (n++) + ').' + ext; if (n > 50) return { fout: 'te veel aanleveringen op één dag' }; }
      VV.schrijf(path.join(map, naam), bytes, { modus: 0o644 });   // wv900: getoetste vaultmap, eigen tmp + rename
    } catch (e) { fout('bandjes-aanlever', e); return { fout: 'het geluid kon niet in de Second Brain bewaard worden' }; }
    return { vaultPad: vaultMap + '/' + naam, naam: naam };
  }
  return {
    lees: lees,
    bewaarAanlevering: bewaarAanlevering,   // wv3768
    alles: function () { return { praktijken: Object.keys(PRAKTIJKEN).map(lees) }; },
    zetTekst: function (pr, id, o) { return muteer(pr, 'tekst', function (md, vv) { return zetTekst(md, vv, id, o, klok); }); },
    zetVoorstel: function (pr, id, o) { return muteer(pr, 'voorstel', function (md, vv) { return zetVoorstel(md, vv, id, o, klok); }); },
    haalVoorstelWeg: function (pr, id) { return muteer(pr, 'voorstel-weg', function (md, vv) { return haalVoorstelWeg(md, vv, id, klok); }); },
    zetVelden: function (pr, id, v, verwacht) { return muteer(pr, 'velden', function (md, vv) { return zetVelden(md, vv, id, v, verwacht, klok); }); },
    zetGemaakt: function (pr, id, o) { return muteer(pr, 'gemaakt', function (md, vv) { return zetGemaakt(md, vv, id, o, klok); }); },
    inCentrale: inCentrale,
    schrijfArchief: schrijfArchief,   // ook voor de eenmalige migratie (wv830)
    werkversie: werkversie, bewaarWerkversie: bewaarWerkversie, ruimWerkversie: ruimWerkversie, werkBestand: werkBestand, werkRonde: werkRonde,   // wv3064
    archiefVan: archiefVan, archiefBestand: archiefBestand,   // wv3544
    werkPad: WERK,
    pad: pad,
    archiefMap: function (pr) { return PRAKTIJKEN[pr] ? path.join(path.dirname(pad(pr)), 'Archief') : null; },
    nieuw: function (pr, o) { return muteer(pr, 'nieuw', function (md, vv) { return nieuwBandje(md, vv, o, klok); }); },
    zetSpreektekst: function (pr, id, o) { return muteer(pr, 'spreektekst', function (md, vv) { return zetSpreektekst(md, vv, id, o, klok); }); },
    spreekNaMaak: spreekNaMaak,   // wv3723
    gelijk: function (pr, id, o) {   // wv3723: tekst gelijktrekken met het gemaakte geluid; daarna de hash in de bewaarde werkversie mee
      const na = spreekNaMaak(pr, id);
      let oud = null;
      const r = muteer(pr, 'gelijk', function (md, vv) { const x = gelijkTrekken(md, vv, id, Object.assign({}, o, { spreek_na_maak: na }), klok); oud = x.oude_hash || null; return x; });
      if (r.status === 200 && oud) werkHash(pr, id, oud, r.bandje.tekst_hash);
      return r;
    },
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
        reden: el.klaar ? null : (el.reden || 'niet beschikbaar'), prijs: el.prijs || null, vers_per_keer: true, credits_tabel: el.credits_tabel || null,
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
  if (!el) uit.push({ id: 'elevenlabs', flow: null, naam: 'ElevenLabs (credits)', motor: 'elevenlabs', betaald: true, beschikbaar: false,
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
      const tijd = new Date(klok()).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
      const pagina = PRAKTIJKEN[l.praktijk].pad;
      const rij = '\n## [direct] ' + tijd + ' — Bandjes ' + PRAKTIJKEN[l.praktijk].naam + ': ' + (soort === 'teruggezet' ? 'bewaarde tekst teruggezet door de synchronisatie'
        : soort === 'conflict' ? 'conflictkopie naast het register' : 'registerpagina niet in orde') + ' (pod, automatisch)\n' +
        '- status: open\n- van: pod bandjes.js (mini-app Bandjes; hooguit 1×/dag per praktijk en soort)\n' +
        '- gemeten: ' + eenRegel(gemeten, 300) + '\n' +
        '- gevolg als er niets gebeurt: Bewaar en Maak voor ' + PRAKTIJKEN[l.praktijk].naam + ' staan dicht in de mini-app (lezen werkt).\n' +
        '- voorstel: ' + (soort === 'teruggezet' ? 'de laatst bewaarde tekst en velden staan in `' + path.join(deps.dir, 'journaal.jsonl') + '`; zet ze terug in `' + pagina + '` met een versie ≥ die uit het journaal (of hoog de versie met 1 op als de pagina zo goed is; bij "eerdere tekst van vN" of "in centrale" staan de versies al gelijk: dan versie ophogen of de tekst/het veld in centrale rechtzetten). Daarna gaat de mini-app vanzelf weer open.'
          : soort === 'conflict' ? 'vergelijk de conflictkopie met `' + pagina + '`, neem wat ontbreekt over en verwijder de kopie; daarna gaat de mini-app vanzelf weer open.'
          : 'dubbel of verkeerd id in `' + pagina + '` rechtzetten (ids zijn onveranderlijk; hernoem de dubbele).') + '\n';
      // wv900: modus van het origineel, eigen tmp met O_EXCL, geen link volgen; wv1944 R3: wijzig onder de mapgrendel
      const ok = VV.wijzig(deps.boxPad, function (t) {
        const anker = eersteRij(t);   // eerste echte rij, niet een kop in een codeblok erboven
        return anker < 0 ? null : t.slice(0, anker) + rij + t.slice(anker);
      }, { grendel: 5, geenGrendel: function () { fout('bandjes-box-grendel', new Error('mapgrendel niet binnen 5 s: zonder grendel geschreven')); } });   // wv1944 R3: eerst de mapgrendel van vault_veilig.wijzig
      if (!ok) return false;
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
  // wv3723: de tekst die bij het maken werkelijk naar de stem ging (Studio-taak van het laatste bestand), of undefined als die taak er niet
  // (meer) is of niet bij dit bandje hoort
  function gezegdVan(pr, id, job) {
    let t = null;
    try { t = deps.studio && deps.studio.taak && /^[a-f0-9]{16}$/.test(String(job)) ? deps.studio.taak(job) : null; } catch (e) { t = null; }
    const b = t && t.bron;
    if (!b || b.soort !== 'bandje' || b.praktijk !== pr || b.bandje !== id || b.proef || t.status !== 'klaar') return undefined;
    return t.velden && typeof t.velden.tekst === 'string' ? t.velden.tekst : undefined;
  }
  function gelijkKan(pr, b, inst) {
    if (!b.voorstel || !b.kan_centrale) return false;
    try {
      const lb = laatsteVan(b.laatste_bestand);
      const gezegd = lb ? gezegdVan(pr, b.id, lb.job) : undefined;
      return !gelijkFout(b, inst, false, gezegd);
    } catch (e) { return false; }
  }
  function praktijkUit(l) {
    return { id: l.praktijk, naam: l.naam || (PRAKTIJKEN[l.praktijk] && PRAKTIJKEN[l.praktijk].naam), instellingen: l.instellingen || {},
      praktijkstem: praktijkstem(l.instellingen),
      bandjes: (l.bandjes || []).map(function (b) { return Object.assign({}, b, { spreektekst: spreekVan(b, l.instellingen), bewaard: bewaardUit(l.praktijk, b), gelijk_kan: gelijkKan(l.praktijk, b, l.instellingen), terugmelding: terugVan(l.praktijk, b) }); }),   // wv3768 terugmelding   // wv3723 gelijk_kan   // wv803; wv3064 bewaard; wv3544 of uit het archief
      dicht: l.dicht || null, fouten: l.fouten || [], conflicten: l.conflicten || [], teruggezet: l.teruggezet || [], ontbreekt: l.ontbreekt === true };
  }
  // wv3064: het bewaarde geluid van de werkversie (zonder paden) of null. wv3544: geen werkversie bewaard, dan het geluid van wat in de
  // centrale staat uit het archief (bron 'archief'); de app speelt en downloadt dat via dezelfde job/n als in Bestanden.
  function bewaardUit(pr, b) {
    let w = null;
    try { w = S.werkversie ? S.werkversie(pr, b.id) : null; } catch (e) { w = null; }
    if (!w) { try { const a = S.archiefVan ? S.archiefVan(pr, b) : null; if (a) w = Object.assign({ bewaard_op: null, bron: 'archief' }, a); } catch (e) { w = null; } }
    return w ? { job: w.job, versie: w.versie, tekst_hash: w.tekst_hash, bewaard_op: w.bewaard_op, bron: w.bron || 'werkversie',
      bestanden: w.bestanden.map(function (x) { return { n: x.n, naam: x.naam, grootte: x.grootte }; }) } : null;
  }
  // wv3064: eerst Bestanden (30 dagen), dan de eigen bewaarplek van die job
  function bestandenVan(pr, id, job) {
    let bs = null;
    try { bs = deps.bestandVan ? deps.bestandVan(job) : null; } catch (e) { fout('bandjes-bestand', e); bs = null; }
    if (bs && bs.length) return bs;
    let w = null;
    try { w = S.werkversie ? S.werkversie(pr, id) : null; } catch (e) { w = null; }
    return w && w.job === job ? w.bestanden.map(function (x) { return { n: x.n, naam: x.naam, pad: x.pad }; }) : bs;
  }
  function ronde() { return S.werkRonde ? S.werkRonde(deps.bestandVan) : null; }

  // ── wv3768 (b): terugmelden aan wie om het bandje vroeg ──
  // Stand per praktijk/bandje/versie in <dir>/terugmeld.json (0600): { aangevraagd } zolang het mailluik niet bevestigde, daarna
  // { concept_op, aan }. Geen tweede concept door een dubbele druk of een verloren antwoord (zoals het POT-afschrift, Fable wv787 #14).
  const TERUG_STAND = path.join(deps.dir, 'terugmeld.json');
  const TERUG_ONZEKER_MS = 24 * 3600 * 1000;
  function terugLees() { try { const j = JSON.parse(fs.readFileSync(TERUG_STAND, 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; } }
  function terugZet(k, w) {
    const st = terugLees();
    if (w === null) delete st[k]; else st[k] = w;
    const sleutels = Object.keys(st);
    if (sleutels.length > 300) sleutels.sort(function (a, b) { return String(st[a].concept_op || st[a].aangevraagd || '').localeCompare(String(st[b].concept_op || st[b].aangevraagd || '')); }).slice(0, sleutels.length - 300).forEach(function (x) { delete st[x]; });
    const tmp = TERUG_STAND + '.' + process.pid;
    try { fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(tmp, TERUG_STAND); return true; }
    catch (e) { fout('bandjes-terugmeld-stand', e); try { fs.unlinkSync(tmp); } catch (e2) {} return false; }
  }
  function terugSleutel(pr, b) { return pr + '/' + b.id + '/v' + b.centrale_versie; }
  // Voor de app: de stand bij de versie die nu in de centrale staat (zonder concept-id)
  // Codex MOET 2: alleen de stand van de vrager van nu (een andere vrager = nog geen concept aan die persoon)
  function terugVan(pr, b) {
    if (!(b.centrale_versie >= 1)) return null;
    const s = terugLees()[terugSleutel(pr, b)];
    return s && b.vrager && s.aan === b.vrager.mail ? { versie: b.centrale_versie, status: s.concept_op ? 'klaar' : 'aangevraagd', op: s.concept_op || s.aangevraagd || null, aan: s.aan || null } : null;
  }
  // b = het bandje zoals het nu in het register staat (bandjeUit), net in de centrale (versie = centrale_versie). → { status: geen | klaar |
  // mislukt | onzeker, naam, reden?, al? }. Nooit versturen: het mailluik maakt alleen een concept in Davids Gmail.
  async function terugmeld(pr, prNaam, b, o) {
    const vr = b.vrager;
    if (!vr) return { status: 'geen' };
    const naam = vr.naam || vr.mail;
    if (!(b.centrale_versie >= 1) || b.versie !== b.centrale_versie || !b.tekst) return { status: 'mislukt', naam: naam, reden: 'het conceptantwoord hoort bij de versie in de centrale; er is intussen een nieuwe tekst' };
    if (typeof deps.mailConcept !== 'function') return { status: 'mislukt', naam: naam, reden: 'het mailluik zit niet in deze versie van de pod' };
    const k = terugSleutel(pr, b);
    const st0 = terugLees()[k];
    const st = st0 && st0.aan === vr.mail ? st0 : null;   // Codex MOET 2: de stand geldt per ontvanger
    if (st && st.concept_op && !(o && o.nogmaals)) return { status: 'klaar', al: true, naam: naam, op: st.concept_op };
    if (st && st.aangevraagd && !st.concept_op && !(o && o.nogmaals) && klok() - Date.parse(st.aangevraagd) < TERUG_ONZEKER_MS)
      return { status: 'onzeker', naam: naam, op: st.aangevraagd, reden: 'er is al een conceptantwoord aangevraagd, maar Gmail bevestigde het niet; kijk eerst bij Concepten' };
    // Codex MOET 1: eerst de aanvraag duurzaam vastleggen; lukt dat niet, dan geen concept (anders bij een volle schijf een dubbel concept)
    if (!terugZet(k, { aangevraagd: new Date(klok()).toISOString(), aan: vr.mail })) return { status: 'mislukt', naam: naam, reden: 'de pod kon de aanvraag niet vastleggen; probeer het straks opnieuw' };
    const m = terugmeldMail(prNaam, b, vr, klok);
    let r;
    try { r = await deps.mailConcept({ aan: vr.mail, onderwerp: m.onderwerp, bericht: m.bericht }); } catch (e) { fout('bandjes-terugmeld', e); r = { ok: false, zeker: false, reden: 'geen antwoord van het mailluik' }; }
    if (r && r.ok === true) {
      terugZet(k, { concept_op: new Date(klok()).toISOString(), aan: vr.mail });
      log('bandjes terugmeld concept ' + pr + '/' + b.id + ' v' + b.centrale_versie);   // geen adres of tekst in het log
      return { status: 'klaar', naam: naam, op: new Date(klok()).toISOString() };
    }
    if (r && r.zeker) { terugZet(k, null); return { status: 'mislukt', naam: naam, reden: String(r.reden || 'het mailluik nam het concept niet aan').slice(0, 160) }; }
    return { status: 'onzeker', naam: naam, reden: 'geen bevestiging van Gmail; misschien staat het concept er toch. Kijk eerst bij Concepten' };
  }
  const aanleverTel = [];
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
      try { const t = deps.studio && deps.studio.teller ? deps.studio.teller() : null; kosten = t && t.elevenlabs ? t.elevenlabs : null; } catch (e) { kosten = null; }   // wv2751: credits van de ElevenLabs-bundel
      return { status: 200, j: { ok: true, praktijken: pr, stemmen: await stemmen(), schrijven: !!primair(), stem_standaard: STEM_STANDAARD, grens: GRENS, kosten: kosten,
        spreek: { standaard: SPREEK_STD, grenzen: SPREEK_GRENS, max: SPREEK.MAX } } };
    }
    const m = /^POST \/app\/bandjes\/(tekst|nieuw|voorstel|instellingen|maak|status|spreektekst|proef|gelijk|vrager|terugmeld|aanlever)$/.exec(route);   // wv3768: vrager, terugmeld, aanlever
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
    if (actie === 'gelijk') {
      // wv3723 (2C91a): het voorstel wordt de tekst zonder opnieuw te maken, alleen als het gemaakte geluid dat al zegt (gelijkFout)
      const l0 = lees(pr);
      const b0 = l0.status === 200 ? (l0.bandjes || []).find(function (x) { return x.id === id; }) : null;
      const lb0 = b0 ? laatsteVan(b0.laatste_bestand) : null;
      const r = S.gelijk(pr, id, { versie: d.versie, tekst_hash: d.tekst_hash, gezegd: lb0 ? gezegdVan(pr, id, lb0.job) : undefined });
      if (r.status === 200) log('bandjes gelijkgetrokken ' + pr + '/' + id + ' v' + r.bandje.versie);
      return goed(r);
    }
    if (actie === 'vrager') {
      // wv3768 (b): wie om dit bandje vroeg (naam + mailadres; allebei leeg = wissen). Een veld, geen tekst: versie en hash blijven
      const v = vragerRegel(d.naam, d.mail);
      if (v.fout) return { status: 400, j: { ok: false, fout: v.fout } };
      const r = goed(S.zetVelden(pr, id, { 'gevraagd door': v.waarde }, null));
      if (r.status === 200 && r.j.bandje) r.j.bandje.terugmelding = terugVan(pr, r.j.bandje);
      return r;
    }
    if (actie === 'terugmeld') {
      // wv3768 (b): het conceptantwoord (opnieuw) klaarzetten voor de versie die in de centrale staat; nogmaals = ook als er al een is
      const l = lees(pr);
      if (l.status !== 200) return fouts(l);
      const b = (l.bandjes || []).find(function (x) { return x.id === id; });
      if (!b) return { status: 404, j: { ok: false, fout: 'dit bandje staat niet in het register' } };
      if (!(b.centrale_versie >= 1)) return { status: 409, j: { ok: false, fout: 'dit bandje staat nog niet in de centrale' } };
      if (!b.vrager) return { status: 409, j: { ok: false, fout: 'vul eerst in wie om dit bandje vroeg' } };
      const u = await terugmeld(pr, l.naam || PRAKTIJKEN[pr].naam, b, { nogmaals: d.nogmaals === true });
      return { status: 200, j: { ok: true, terugmelding: u, bandje: Object.assign({}, b, { terugmelding: terugVan(pr, b) }) } };
    }
    if (actie === 'aanlever') {
      // wv3768 (d): het huidige geluid van een bandje zonder tekst. Upload van dit apparaat (ctx.neemUpload, zoals Studio) → eerst in de
      // Bronnen-map van de praktijk (het geluid gaat nooit verloren), dan uitschrijven (Whisper) → VOORSTEL, nooit de tekst zelf.
      if (typeof deps.uitschrijf !== 'function') return { status: 503, j: { ok: false, fout: 'uitschrijven zit niet in deze versie van de pod' } };
      if (!ctx || typeof ctx.neemUpload !== 'function') return { status: 503, j: { ok: false, fout: 'aanleveren kan nu niet (geen upload op de pod)' } };
      const beurt = String(d.beurt_id || ''), n = Number(d.n == null ? 1 : d.n);
      if (!BEURT_RE.test(beurt) || !Number.isInteger(n) || n < 1) return { status: 400, j: { ok: false, fout: 'beurt_id ontbreekt' } };
      const l = lees(pr);
      if (l.status !== 200) return fouts(l);
      if (l.dicht) return { status: 409, j: { ok: false, fout: l.dicht, dicht: true } };
      const b = l.bandjes.find(function (x) { return x.id === id; });
      if (!b) return { status: 404, j: { ok: false, fout: 'dit bandje staat niet in het register' } };
      if (Number(d.versie) !== b.versie || String(d.tekst_hash || '') !== b.tekst_hash) return { status: 409, j: { ok: false, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true } };
      if (!b.onbekend) return { status: 409, j: { ok: false, fout: 'dit bandje heeft al een tekst; aanleveren is voor een bandje waarvan de tekst nog onbekend is' } };
      const voorstelVoor = JSON.stringify(b.voorstel || null);
      const nu = klok();
      while (aanleverTel.length && nu - aanleverTel[0] > 3600 * 1000) aanleverTel.shift();
      if (aanleverTel.length >= AANLEVER_PER_UUR) return { status: 429, j: { ok: false, fout: 'hooguit ' + AANLEVER_PER_UUR + ' keer per uur; probeer het straks opnieuw' } };
      let up = null;
      try { up = ctx.neemUpload(beurt, n); } catch (e) { up = null; }
      if (!up || !Buffer.isBuffer(up.bytes)) return { status: 400, j: { ok: false, fout: 'het bestand staat niet (meer) op de pod; kies het opnieuw' } };
      if (up.bytes.length > AANLEVER_MAX) return { status: 400, j: { ok: false, fout: 'het bestand is te groot (hooguit ' + Math.round(AANLEVER_MAX / 1048576) + ' MB)' } };
      const soort = audioSoort(up.bytes);
      if (!soort) return { status: 400, j: { ok: false, fout: 'dit is geen geluidsbestand dat Socev kan uitschrijven (wav, mp3, m4a, ogg of webm)' } };
      aanleverTel.push(nu);
      const bw = S.bewaarAanlevering(pr, b, up.bytes, soort.ext);
      if (bw.fout) return { status: 500, j: { ok: false, fout: bw.fout } };
      try { if (typeof up.weg === 'function') up.weg(); } catch (e) {}
      const veld = S.zetVelden(pr, id, { aangeleverd: vandaag(klok) + ' · [[' + bw.vaultPad + ']]' }, { versie: b.versie, tekst_hash: b.tekst_hash });
      if (veld.status !== 200) fout('bandjes-aanlever-veld', new Error(String(veld.fout || veld.status).slice(0, 100)));
      log('bandjes aanlever ' + pr + '/' + id + ' ' + soort.ext + ' ' + up.bytes.length + ' bytes');
      let tekst = '';
      try { tekst = String(await deps.uitschrijf(up.bytes, UITSCHRIJF_HINT) || ''); }
      catch (e) { fout('bandjes-uitschrijf', e); return { status: 502, j: { ok: false, bewaard: bw.naam, fout: 'het uitschrijven lukte nu niet; het geluid is wel bewaard in de Second Brain (Bronnen). Socev kan het later uitschrijven' } }; }
      tekst = normTekst(schoon(tekst, GRENS.tekst * 2)).replace(/[ \t]+/g, ' ').trim();
      if (!tekst) return { status: 422, j: { ok: false, bewaard: bw.naam, fout: 'Socev verstond niets in dit geluid; het is wel bewaard in de Second Brain (Bronnen)' } };
      let ingekort = false;
      if (tekst.length > GRENS.tekst) { tekst = tekst.slice(0, GRENS.tekst).replace(/\s+\S*$/, '') + '…'; ingekort = true; }
      if (/^\(onbekend\b/i.test(tekst)) tekst = tekst.replace(/^\(/, '');
      // Codex MOET 3: tijdens het uitschrijven (await) kan de tekst of het voorstel veranderd zijn (skill, ander apparaat): dan niets
      // overschrijven. Toets en schrijven hieronder lopen zonder await ertussen (muteer is synchroon).
      let b2 = null;
      try { const l2 = S.lees(pr); b2 = l2 && l2.status === 200 && !l2.dicht ? (l2.bandjes || []).find(function (x) { return x.id === id; }) : null; } catch (e) { b2 = null; }
      if (!b2 || b2.versie !== b.versie || b2.tekst_hash !== b.tekst_hash || !b2.onbekend || JSON.stringify(b2.voorstel || null) !== voorstelVoor)
        return { status: 409, j: { ok: false, gewijzigd: true, bewaard: bw.naam, fout: 'dit bandje is tijdens het uitschrijven gewijzigd; het geluid is wel bewaard in de Second Brain (Bronnen), het voorstel is niet gezet. Herlaad en lever het zo nodig opnieuw aan' } };
      const r = S.zetVoorstel(pr, id, { tekst: tekst, reden: 'uitgeschreven uit het geluid dat je op ' + vandaag(klok) + ' aanleverde' + (ingekort ? ' (ingekort tot ' + GRENS.tekst + ' tekens)' : '') +
        '; de uitschrijver kan woorden verkeerd verstaan, lees het na' });
      if (r.status !== 200) return { status: r.status, j: { ok: false, bewaard: bw.naam, fout: 'uitgeschreven, maar het voorstel kon niet bewaard worden: ' + String(r.fout || '').slice(0, 120) } };
      const g = goed(r);
      g.j.bewaard = bw.naam;
      return g;
    }
    if (actie === 'spreektekst') {
      // wv803: eigen spreektekst bewaren (string) of terug naar automatisch (null); versie + hash zoals Bewaar
      if (d.spreektekst !== null && typeof d.spreektekst !== 'string') return { status: 400, j: { ok: false, fout: 'spreektekst ontbreekt' } };
      return goed(S.zetSpreektekst(pr, id, { versie: d.versie, tekst_hash: d.tekst_hash, spreektekst: d.spreektekst }));
    }
    if (actie === 'status') {
      // versie én hash (Fable wv743 #2): anders zegt het label "in centrale (vN)" bij een tekst die David intussen in Obsidian wijzigde.
      // wv830: alleen de werkversie met een gemaakt bandje; de bestanden van dat bandje (uit Bestanden) + tekst gaan naar het archief.
      const v = Number(d.versie);
      if (!Number.isInteger(v) || v < 1 || !/^[a-f0-9]{16}$/.test(String(d.tekst_hash || ''))) return { status: 400, j: { ok: false, fout: 'versie of tekst_hash ontbreekt' } };
      const l = lees(pr);
      if (l.status !== 200) return fouts(l);
      if (l.dicht) return { status: 409, j: { ok: false, fout: l.dicht, dicht: true } };
      const b = l.bandjes.find(function (x) { return x.id === id; });
      if (!b) return { status: 404, j: { ok: false, fout: 'dit bandje staat niet in het register' } };
      if (v !== b.versie || String(d.tekst_hash) !== b.tekst_hash) return { status: 409, j: { ok: false, fout: 'dit bandje is intussen gewijzigd; herlaad', gewijzigd: true } };
      if (!b.kan_centrale) return { status: 409, j: { ok: false, fout: b.werkversie === null ? 'deze versie staat al in de centrale' : 'maak eerst het bandje van deze versie' } };
      const lb = laatsteVan(b.laatste_bestand);
      if (d.job != null && d.job !== '' && String(d.job) !== lb.job) return { status: 409, j: { ok: false, fout: 'dit is niet het laatst gemaakte bandje van deze versie; herlaad', gewijzigd: true } };
      // het geluid moet bij de tekst van nu horen: de hash in "laatste bestand", anders (velden van vóór wv830) die van de Studio-taak
      let taak = null;
      try { taak = deps.studio && deps.studio.taak ? deps.studio.taak(lb.job) : null; } catch (e) { taak = null; }
      const tb = taak && taak.bron && taak.bron.soort === 'bandje' && taak.bron.praktijk === pr && taak.bron.bandje === id && !taak.bron.proef ? taak.bron : null;
      if (taak && !tb) return { status: 409, j: { ok: false, fout: 'het laatste bestand hoort niet bij dit bandje; maak het opnieuw' } };
      const hash = lb.hash || (tb && tb.tekst_hash) || null;
      if (hash !== b.tekst_hash) return { status: 409, j: { ok: false, fout: hash ? 'het gemaakte bandje hoort bij een eerdere tekst; druk op Maak' : 'niet na te gaan bij welke tekst het gemaakte bandje hoort; maak het opnieuw' } };
      // loopt er nog een Maak voor dit bandje, dan eerst die afwachten: anders valt die (betaalde) generatie na het markeren weg (Fable wv830 #4)
      let lopend = [];
      try { lopend = deps.studio && deps.studio.lopend ? deps.studio.lopend().taken || [] : []; } catch (e) { lopend = []; }
      if (lopend.some(function (x) { return x && x.bron && x.bron.soort === 'bandje' && x.bron.praktijk === pr && x.bron.bandje === id && !x.bron.proef; }))
        return { status: 409, j: { ok: false, fout: 'er wordt nog een bandje gemaakt; wacht tot dat klaar is' } };
      const bestanden = bestandenVan(pr, id, lb.job);   // wv3064: ook na 30 dagen, uit de eigen bewaarplek
      // zonder telefoonversie geen archief van wat in de centrale gaat (Fable wv830 #10)
      if (bestanden && bestanden.length && !bestanden.some(function (x) { return /^bandje-telefoon-(ulaw|pcm)\.wav$/.test(x.naam); }))
        return { status: 409, j: { ok: false, fout: 'bij dit bandje ontbreken de telefoonversies; maak het opnieuw' } };
      if (!bestanden || !bestanden.length) return { status: 409, j: { ok: false, fout: 'de bestanden van dit bandje staan niet meer in Bestanden (30 dagen); maak het opnieuw en zet het dan in de centrale' } };
      const r = S.inCentrale(pr, id, { versie: v, tekst_hash: String(d.tekst_hash), bestanden: bestanden, job: lb.job,
        stem: tb ? tb.stem : b.stem, model: tb && tb.model ? tb.model : null, spreektekst: taak && taak.velden && typeof taak.velden.tekst === 'string' ? taak.velden.tekst : spreekVan(b, l.instellingen).tekst });
      if (r.status === 200) log('bandjes in centrale ' + pr + '/' + id + ' v' + v + ' archief=' + r.archief);
      if (r.status === 200 && S.ruimWerkversie) { try { S.ruimWerkversie(pr, id); } catch (e) { fout('bandjes-werkversie-weg', e); } }   // wv3064: staat nu in het archief
      if (r.status !== 200) return fouts(r);
      const g = goed(r);
      g.j.archief = r.archief;
      // wv3768 (b): vroeg iemand om dit bandje, dan een Gmail-concept aan die persoon (nooit versturen); mislukt dat, dan staat het bandje
      // toch in de centrale en kan David het concept met POST …/terugmeld opnieuw laten klaarzetten
      try { g.j.terugmelding = await terugmeld(pr, l.naam || PRAKTIJKEN[pr].naam, r.bandje, {}); } catch (e) { fout('bandjes-terugmeld', e); g.j.terugmelding = { status: 'mislukt', reden: 'fout op de pod' }; }
      g.j.bandje.terugmelding = terugVan(pr, r.bandje);
      return g;
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
    // wv830: de generatie hoort bij de werkversie (volgende_versie): staat de tekst al in de centrale (vN), dan wordt dit v(N+1);
    // basis = de versie die het register nu heeft (naKlaar toetst daarop)
    const r = await deps.studio.maak({ flow: s.flow, velden: velden, beurt_id: beurt }, ctx,
      { bron: Object.assign({ soort: 'bandje', praktijk: pr, bandje: id, versie: b.volgende_versie, basis: b.versie, tekst_hash: b.tekst_hash, stem: stem }, model ? { model: model } : {}, proef ? { proef: true } : {}) });
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
    // wv3768 (b): de skill mag meegeven wie erom vroeg ({ naam, mail }); eerst toetsen, dan pas schrijven
    let vrager = null;
    if (d.gevraagd_door != null) {
      const g = d.gevraagd_door && typeof d.gevraagd_door === 'object' ? vragerRegel(d.gevraagd_door.naam, d.gevraagd_door.mail) : { fout: 'gevraagd_door: { naam, mail }' };
      if (g.fout || g.waarde === '—') return { status: 400, j: { ok: false, fout: 'gevraagd_door: ' + (g.fout || 'mailadres ontbreekt') } };
      vrager = g.waarde;
    }
    const r = S.zetVoorstel(pr, id, { tekst: d.tekst, reden: d.reden });
    if (r.status !== 200) return fouts(r);
    if (vrager) {
      const rv = S.zetVelden(pr, id, { 'gevraagd door': vrager }, null);
      if (rv.status === 200) r.bandje = rv.bandje; else fout('bandjes-smal-vrager', new Error(String(rv.fout || rv.status).slice(0, 100)));
    }
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
    // wv830: met de tekst-hash erin (de knop "Staat in centrale" toetst daarop) en naar de werkversie (zetGemaakt)
    // versie, tekst-hash en job vóór stem en model: het veld is hooguit 160 tekens en een lange stem-id mag die niet afkappen (Fable wv830 #2)
    const waarde = function (v) { return vandaag(klok) + ' · v' + v + ' · tekst ' + b.tekst_hash + ' · ' + taak.id + '/' + (hoofd ? hoofd.naam : '?') + ' · ' + b.stem + (b.model ? ' · ' + b.model : '') +
      (tel === 2 ? ' (+ telefoon PCM en µ-law)' : ' (zonder telefoonversie)'); };
    // taken van vóór wv830 hebben geen basis: dan de registerversie en de werkversie van nu (Fable wv830 #11)
    const heeftBasis = Number.isInteger(b.basis);
    const r = S.zetGemaakt(b.praktijk, b.bandje, { basis: heeftBasis ? b.basis : b.versie, versie: heeftBasis ? b.versie : null, tekst_hash: b.tekst_hash, waarde: waarde });
    if (r.status !== 200) { log('bandjes naklaar taak=' + taak.id + ' register niet bijgewerkt: ' + String(r.fout || '').slice(0, 120)); boxMeld(S.lees(b.praktijk)); }
    else {
      log('bandjes naklaar taak=' + taak.id + ' ' + b.praktijk + '/' + b.bandje + ' v' + b.versie + ' gemaakt');
      try { const u = ronde(); if (u && (u.bewaard || u.opgeruimd || u.fouten)) log('bandjes werkversies ' + JSON.stringify(u)); } catch (e) { fout('bandjes-werkronde', e); }   // wv3064
    }
  }

  // /health: zonder inhoud
  function health() {
    const uit = { aan: true };
    Object.keys(PRAKTIJKEN).forEach(function (pr) { try { uit['dicht_' + pr] = !!S.lees(pr).dicht; } catch (e) { uit['dicht_' + pr] = null; } });
    // wv3064: hoeveel bandjes hun werkversie-geluid op de eigen bewaarplek hebben (alleen een telling)
    try { uit.werkversies_bewaard = Object.keys(PRAKTIJKEN).reduce(function (n, pr) { let ids = []; try { ids = fs.readdirSync(path.join(S.werkPad, pr)).filter(function (x) { return ID_RE.test(x); }); } catch (e) {} return n + ids.filter(function (id) { return !!S.werkversie(pr, id); }).length; }, 0); } catch (e) { uit.werkversies_bewaard = null; }
    return uit;
  }
  // wv3064: GET /app/bestand/<job>/<n> als Bestanden de job niet meer heeft
  function bewaardBestand(job, n) {
    let x = null;
    try { x = S.werkBestand ? S.werkBestand(job, n) : null; } catch (e) { x = null; }
    if (!x) { try { x = S.archiefBestand ? S.archiefBestand(job, n) : null; } catch (e) { x = null; } }   // wv3544
    return x;
  }
  // wv3723: de stand voor de kaartronde (bandjes-kaart.js); ok = gelezen en aanwezig, dicht = niets aan de kaarten veranderen
  function kaartStand() {
    return Object.keys(PRAKTIJKEN).map(function (pr) {
      let l;
      try { l = lees(pr); } catch (e) { return { id: pr, naam: PRAKTIJKEN[pr].naam, ok: false, dicht: 'onleesbaar', bandjes: [] }; }
      return { id: pr, naam: l.naam || PRAKTIJKEN[pr].naam, ok: l.status === 200 && !l.ontbreekt, dicht: l.dicht || null,
        bandjes: (l.bandjes || []).map(function (b) { return Object.assign({}, b, { gelijk_kan: gelijkKan(pr, b, l.instellingen), terugmelding: terugVan(pr, b) }); }) };   // wv3768 terugmelding (belkaart)
    });
  }
  // wv3723: David zette de belkaart op gedaan → "gehoord: vN op <datum>" in het register, alleen als vN nog in de centrale staat
  function zetGehoord(pr, id, versie) {
    if (!Object.hasOwn(PRAKTIJKEN, pr) || !ID_RE.test(String(id)) || !primair()) return { status: 409, fout: 'niet nu' };
    const l = S.lees(pr);
    const b = l && l.status === 200 && !l.dicht ? (l.bandjes || []).find(function (x) { return x.id === id; }) : null;
    if (!b || b.centrale_versie !== versie) return { status: 409, fout: 'staat niet (meer) zo in de centrale' };
    return S.zetVelden(pr, id, { gehoord: 'v' + versie + ' op ' + vandaag(klok) + ' (David belde na)' }, { versie: b.versie, tekst_hash: b.tekst_hash });
  }
  return { app: app, smal: smal, naKlaar: naKlaar, health: health, stemmen: stemmen, ronde: ronde, bewaardBestand: bewaardBestand, kaartStand: kaartStand, zetGehoord: zetGehoord };
}

module.exports = { PRAKTIJKEN, GRENS, STEM_STANDAARD, normTekst, tekstHash, parse, bandjeUit, zetTekst, zetVoorstel, haalVoorstelWeg, zetVelden, nieuwBandje,
  centraleVersie, werkNummer, laatsteVan, kanCentrale, zetGemaakt, zetInCentrale,
  zetInstelling, zetSpreektekst, stemmenLijst, stemmenUit, maak, routes, gelijkTrekken, gelijkFout, kaal,
  vragerVan, vragerRegel, terugmeldMail, audioSoort };   // wv3768
