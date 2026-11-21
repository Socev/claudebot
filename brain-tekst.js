'use strict';
/*
 * brain-tekst.js — de tekst uit pdf- en Word-stukken (docx) van de vault, zodat Brain › Zoeken ze ook op inhoud vindt (wv3734, 21-11-2026).
 *
 * WAAROM. David Ja 21-11 13:19 (besluitenpagina nr 404 = 3C104): "Wil je dat contracten, polissen en brieven (pdf en Word) vindbaar worden
 * op wat erin staat?" Er staan ± 1.800 pdf's en 450 docx-bestanden in de vault die Brain › Zoeken tot nu toe alleen op bestandsnaam vond.
 *
 * WAT. ronde(): per pdf of docx uit de kaart van secondbrain.js (pad, mtime, grootte) de tekst lokaal uitlezen, alleen als het bestand
 * nieuw of gewijzigd is: pdf met pdftotext (tekstlaag; scans zonder tekstlaag geven geen tekst en worden "zonder tekst" geteld, OCR later),
 * docx met unzip (word/document.xml, plus kop- en voetteksten) en de XML-tags eraf. Elke tekst één bestand <dir>/t/<sha1 van het pad>.txt
 * (map 0700, bestand 0600) met een manifest {pad: {k, m, g, n}}; een bestand dat uit de kaart verdwijnt gaat ook hier weg. Alles blijft op
 * de pod (zelfde plek als de vault); er gaat niets naar buiten en er komt geen tekst in een log (alleen aantallen).
 * tekst(b): de opgeslagen tekst als de kaartregel b (p, m, g) nog precies klopt, anders null (gewijzigd = pas na de volgende ronde weer).
 * Gemeten 21-11: ± 30 ms per pdf, gemiddeld ± 17 kB tekst; de eerste ronde ± 1–2 min, daarna alleen nieuwe of gewijzigde stukken.
 *
 * GRENZEN. Per stuk 60 s en hooguit MAX_TEKST tekens; pdftotext hooguit MAX_PAGINAS pagina's; geen shell (execFile met een argumentlijst,
 * de pdf als pad na "--" kan niet: pdftotext kent dat niet, dus het pad begint altijd met de vaultmap = nooit met een streepje).
 * Oude .doc (binair Word), Excel en PowerPoint: nog alleen op naam.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_TEKST = 1024 * 1024, MAX_PAGINAS = 300, STUK_MS = 60000, MAX_UIT = 16 * 1024 * 1024, BEWAAR_ELKE = 100, MAX_POGING = 3;

function soortVan(p) {
  const e = (/\.([^.\/]+)$/.exec(p) || [])[1];
  const x = e ? e.toLowerCase() : '';
  return x === 'pdf' ? 'pdf' : x === 'docx' ? 'docx' : null;
}

// docx-XML → platte tekst: alinea's en regeleinden als nieuwe regel, tab als spatie, tags weg, entiteiten terug
function docxTekst(xml) {
  return String(xml)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, n) { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; })
    .replace(/&amp;/g, '&');
}

function maak(o) {
  const VAULT = o.vault, DIR = o.dir, TDIR = path.join(DIR, 't'), MANIFEST = path.join(DIR, 'manifest.json');
  const fout = o.fout || function () {};
  const nu = o.nu || Date.now;
  const pdftotext = o.pdftotext || '/usr/bin/pdftotext', unzip = o.unzip || '/usr/bin/unzip';
  let manifest = null, loopt = false, laatste = null;

  function laad() {
    if (manifest) return manifest;
    try {
      const j = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      manifest = j && typeof j === 'object' && j.bestanden && typeof j.bestanden === 'object' ? j.bestanden : {};
      if (j && j.laatste) laatste = j.laatste;
    } catch (e) { manifest = {}; }
    return manifest;
  }
  function bewaar() {
    const tmp = MANIFEST + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ versie: 1, laatste: laatste, bestanden: manifest }), { mode: 0o600 });
    fs.renameSync(tmp, MANIFEST);
  }
  const sleutel = function (p) { return crypto.createHash('sha1').update(String(p)).digest('hex'); };

  function draai(cmd, args) {
    return new Promise(function (klaar) {
      execFile(cmd, args, { timeout: STUK_MS, maxBuffer: MAX_UIT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' } },
        function (e, uit) { klaar(e && !uit ? null : String(uit || '')); });
    });
  }
  async function lees(abs, soort) {
    if (soort === 'pdf') return draai(pdftotext, ['-q', '-enc', 'UTF-8', '-l', String(MAX_PAGINAS), abs, '-']);
    const delen = [];
    for (const deel of ['word/document.xml', 'word/header*.xml', 'word/footer*.xml']) {
      const x = await draai(unzip, ['-p', '-qq', abs, deel]);
      if (x === null && deel === 'word/document.xml') return null;
      if (x) delen.push(docxTekst(x));
    }
    return delen.join('\n');
  }

  // bestanden: [{p, s, m, g}] uit de kaart. Geeft telling; nooit tekst of paden in de uitkomst.
  async function ronde(bestanden, opties) {
    if (loopt) return { bezig: true };
    loopt = true;
    const t0 = nu(), maxMs = opties && opties.maxMs || 20 * 60000;
    const tel = { stukken: 0, nieuw: 0, met_tekst: 0, zonder_tekst: 0, fout: 0, weg: 0, bytes: 0, afgekapt: false };
    try {
      fs.mkdirSync(TDIR, { recursive: true, mode: 0o700 });
      fs.chmodSync(DIR, 0o700); fs.chmodSync(TDIR, 0o700);
      const m = laad(), gezien = new Set();
      let sinds = 0;
      for (const b of bestanden || []) {
        const soort = b && typeof b.p === 'string' ? soortVan(b.p) : null;
        if (!soort) continue;
        tel.stukken++;
        gezien.add(b.p);
        const oud = m[b.p], zelfde = !!oud && oud.m === b.m && oud.g === b.g;
        // review wv3734 MOET 1: een mislukte uitlezing (time-out, kapot bestand) telt niet als klaar; dezelfde versie nog eens bij de
        // volgende ronde, tot MAX_POGING keer (daarna pas weer na een wijziging, zodat één kapot stuk niet elk uur 60 s kost)
        if (zelfde && !(oud.fout > 0 && oud.fout < MAX_POGING)) {
          if (oud.n > 0) { tel.met_tekst++; tel.bytes += oud.n; } else if (oud.fout) tel.fout++; else tel.zonder_tekst++;
          continue;
        }
        if (nu() - t0 > maxMs) { tel.afgekapt = true; continue; }
        const abs = path.join(VAULT, b.p);
        let st;
        try { st = fs.lstatSync(abs); } catch (e) { continue; }
        if (!st.isFile()) continue;
        let t = await lees(abs, soort);
        const k = sleutel(b.p);
        tel.nieuw++;
        if (t === null) {
          tel.fout++;
          try { fs.unlinkSync(path.join(TDIR, k + '.txt')); } catch (e) { /* er was er geen */ }
          m[b.p] = { k: k, m: b.m, g: b.g, n: 0, fout: (zelfde && oud.fout || 0) + 1 };
          if (++sinds >= BEWAAR_ELKE) { sinds = 0; bewaar(); }
          continue;
        }
        t = t.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEKST);
        const heeft = /[0-9A-Za-zÀ-ɏ]{3}/.test(t);
        if (heeft) {
          const tmp = path.join(TDIR, k + '.' + process.pid + '.tmp');
          fs.writeFileSync(tmp, t, { mode: 0o600 });
          fs.renameSync(tmp, path.join(TDIR, k + '.txt'));
          tel.met_tekst++; tel.bytes += t.length;
        } else {
          try { fs.unlinkSync(path.join(TDIR, k + '.txt')); } catch (e) { /* er was er geen */ }
          tel.zonder_tekst++;
        }
        m[b.p] = { k: k, m: b.m, g: b.g, n: heeft ? t.length : 0 };
        if (++sinds >= BEWAAR_ELKE) { sinds = 0; bewaar(); }
      }
      if (!tel.afgekapt) for (const p of Object.keys(m)) {
        if (gezien.has(p)) continue;
        try { fs.unlinkSync(path.join(TDIR, m[p].k + '.txt')); } catch (e) { /* al weg */ }
        delete m[p];
        tel.weg++;
      }
      tel.ms = nu() - t0;
      laatste = Object.assign({ op: new Date(nu()).toISOString() }, tel);
      bewaar();
      return tel;
    } catch (e) { fout('brain-tekst', e); tel.ms = nu() - t0; tel.mislukt = true; return tel; }
    finally { loopt = false; }
  }

  // De tekst van één kaartregel, alleen als mtime en grootte nog kloppen (anders kan de inhoud iets anders zeggen dan de cache)
  function tekst(b) {
    const m = laad(), x = b && m[b.p];
    if (!x || x.m !== b.m || x.g !== b.g || !(x.n > 0)) return null;
    try { return fs.readFileSync(path.join(TDIR, x.k + '.txt'), 'utf8'); } catch (e) { return null; }
  }
  function heeft(b) { const m = laad(), x = b && m[b.p]; return !!(x && x.m === b.m && x.g === b.g && x.n > 0); }
  function info() { laad(); return { aan: true, loopt: loopt, laatste: laatste, stukken: Object.keys(manifest).length }; }
  return { ronde: ronde, tekst: tekst, heeft: heeft, info: info, soortVan: soortVan };
}

module.exports = { maak: maak, docxTekst: docxTekst, soortVan: soortVan };
