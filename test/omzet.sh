#!/usr/bin/env bash
# Toetst Download als… (wv1854; bouwplan "01_Ontwikkeling/Download als - bouwplan (28-10-2026).md" § 5): omzet.js (PDF via Chromium met JS
# uit en netwerk dicht, Word via pandoc met reference-doc, Excel via xlsx-schrijver.js), de grenzen (2 MB → 413, tijdslimiet → 504, één
# tegelijk met een korte wachtrij → 503), de schoonmaak van de AST (beelden, ruwe HTML, niet-http(s)-links), tijdelijke mappen weg, en de
# koppeling in server.js/uitrol.sh/Dockerfile. Alle toetsdata verzonnen. Nodig: pandoc, pdftotext, pdfimages, unzip en de headless shell
# van Chromium uit het image. Gebruik: bash test/omzet.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const O = require('./omzet.js'), X = require('./xlsx-schrijver.js'), HS = require('./omzet-huisstijl.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'omzet1854-'));
const TMP = path.join(W, 'tmp'); fs.mkdirSync(TMP);
const sh = (c) => cp.execSync(c, { cwd: W, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const bewaar = (naam, r) => { const p = path.join(W, naam); fs.writeFileSync(p, Buffer.from(r.j.inhoud, 'base64')); return p; };
const unzipP = (p, deel) => cp.execFileSync('unzip', ['-p', p, deel], { encoding: 'utf8' });

const MD = [
  '---', 'geheim: frontmatterwaarde', '---', '# Werkplan proefpraktijk', '',
  'Een alinea met **vet**, een [link](https://example.org/pagina) en [[Map/Pagina|een wikilink]] en [[Losse pagina]].',
  'Een ![beeldtekst](https://example.org/x.png) en ![[embed.png]] en een [lokale verwijzing](file:///etc/passwd).', '',
  '%% intern commentaar %%', '<!-- html-commentaar -->', '',
  '> [!note] Let op', '> Callout-tekst.', '',
  '- punt een', '- punt twee', '', '```', 'codeblok <script>x</script>', '```', '',
  '## Kosten', '', '| Post | Bedrag | Notitie |', '|---|--:|---|',
  '| Huur | € 1.234,56 | jaar<br>twee regels |', '| Licenties | 12,5 | =SOM(A1:A3) |', '| Telefoon | 0612345678 | +31 |', '| Retour | -5 | @iemand |', '',
  '## Planning', '', '| Week | Taak |', '|---|---|', '| 1 | Opstart |', '',
].join('\n');
const LANG = '# Lange tabel\n\n| Nr | Omschrijving |\n|---|---|\n' + Array.from({ length: 140 }, (x, i) => '| ' + (i + 1) + ' | Proefregel ' + (i + 1) + ' |').join('\n') + '\n';
const HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Proef</title><link rel="stylesheet" href="https://example.org/s.css">' +
  '<meta http-equiv="refresh" content="0;url=https://example.org/">' +
  '</head><body><h1>Html-proef</h1><p id="p">Tekst voor het script.</p><script>document.getElementById("p").textContent="SCRIPT DRAAIDE"</script>' +
  '<img src="https://example.org/beeld.png" alt="extern"><img src="file://' + path.resolve('omzet-huisstijl.js') + '"><iframe src="file:///etc/hostname"></iframe>' +
  '<table><tr><th>Kolom</th></tr><tr><td>Waarde 42</td></tr></table></body></html>';

(async function () {
  const M = O.maak({ tmp: TMP, fout: function () {} });
  const h = M.health();
  toets('health: pandoc en chromium gevonden, 8 huisstijlen', h.aan && h.pandoc && h.chromium && h.huisstijlen === 8, h);
  toets('huisstijlen: Tolgaarde t/m OVIS met label', M.stijlen().map((x) => x.id).join(',') === 'tolgaarde,groenhouten,pot,holding,praktijkhouders,kostenmaatschap,sloel,ovis', M.stijlen());

  // ── PDF uit markdown ──
  let r = await M.omzet({ naam: 'Map/Werkplan.md', soort: 'md', tekst: MD, formaat: 'pdf' });
  toets('pdf md: 200 en een PDF', r.status === 200 && Buffer.from(r.j.inhoud, 'base64').slice(0, 5).toString() === '%PDF-' && r.j.naam === 'Werkplan.pdf', r.j.fout || r.j.naam);
  let p = bewaar('md.pdf', r);
  let t = sh('pdftotext ' + JSON.stringify(p) + ' -');
  toets('pdf md: alle tekst (kop, tabel, lijst, wikilinklabels, codeblok)', ['Werkplan proefpraktijk', 'Huur', '1.234,56', '=SOM(A1:A3)', 'punt twee', 'een wikilink', 'Losse pagina', 'codeblok <script>x</script>', 'Let op', 'Callout-tekst.', 'beeldtekst', 'lokale verwijzing'].every((x) => t.indexOf(x) >= 0), t.slice(0, 300));
  toets('pdf md: geen [[, geen frontmatter, geen %%- of html-commentaar', !/\[\[|frontmatterwaarde|intern commentaar|html-commentaar/.test(t));
  toets('pdf md: geen enkel netwerkverzoek (teller 0)', r.audit.pogingen === 0, r.audit);
  toets('pdf md: voet met paginanummer', /pagina 1 van 1/.test(t));
  toets('pdf md: geen beeld (extern noch lokaal)', sh('pdfimages -list ' + JSON.stringify(p)).split('\n').length <= 3);
  toets('audit zonder inhoud (alleen vaste velden)', Object.keys(r.audit).every((k) => ['formaat', 'soort', 'huisstijl', 'in_kb', 'ms', 'pogingen', 'uit_kb', 'status'].indexOf(k) >= 0), r.audit);

  // lange tabel over meer pagina's: kopregel herhaald
  r = await M.omzet({ naam: 'Lang.md', soort: 'md', tekst: LANG, formaat: 'pdf' });
  p = bewaar('lang.pdf', r);
  const pag = Number((/Pages:\s+(\d+)/.exec(sh('pdfinfo ' + JSON.stringify(p))) || [])[1]);
  const p2 = sh('pdftotext -f 2 -l 2 ' + JSON.stringify(p) + ' -');
  toets('pdf lange tabel: meer pagina\'s, kopregel ook op pagina 2', pag > 1 && /Omschrijving/.test(p2) && /Proefregel 140/.test(sh('pdftotext ' + JSON.stringify(p) + ' -')), { pag: pag });

  // ── PDF uit html: script draait niet, niets opgehaald ──
  r = await M.omzet({ naam: 'proef.html', soort: 'html', tekst: HTML, formaat: 'pdf' });
  p = bewaar('html.pdf', r);
  t = sh('pdftotext ' + JSON.stringify(p) + ' -');
  toets('pdf html: 200, script draaide niet', r.status === 200 && /Tekst voor het script/.test(t) && !/SCRIPT DRAAIDE/.test(t), t.slice(0, 200));
  toets('pdf html: externe en lokale bronnen geprobeerd maar geblokkeerd, geen beeld in de PDF', r.audit.pogingen >= 1 &&
    !sh('pdfimages -list ' + JSON.stringify(p)).split('\n').slice(2).some((l) => / image /.test(l) && Number(l.trim().split(/\s+/)[3]) > 20), r.audit);
  toets('pdf html: geen inhoud van een lokaal bestand', !/module\.exports|localhost/.test(t));

  // ── huisstijlen: elke stijl geeft een PDF met briefhoofd en voet; geen IBAN/KvK ──
  for (const s of Object.keys(HS.STIJLEN)) {
    r = await M.omzet({ naam: 'Brief.md', soort: 'md', tekst: '# Brief\n\nProeftekst.\n', formaat: 'pdf', huisstijl: s });
    p = bewaar('hs-' + s + '.pdf', r);
    t = sh('pdftotext ' + JSON.stringify(p) + ' -');
    const st = HS.STIJLEN[s];
    toets('pdf huisstijl ' + s + ': naam in de voet, paginanummer' + (st.logo ? ', logo' : ', naam in de kop'),
      r.status === 200 && t.indexOf(st.naam) >= 0 && /pagina 1 van 1/.test(t) && (st.logo ? sh('pdfimages -list ' + JSON.stringify(p)).split('\n').length > 3 : t.indexOf(st.briefhoofd.naam) >= 0) && r.j.naam === 'Brief (' + st.label + ').pdf', { s: r.status, n: r.j.naam });
  }
  const tekstvelden = JSON.stringify(Object.values(HS.STIJLEN).map((x) => Object.assign({}, x, { logo: '', docx: '' })));
  toets('huisstijlen zonder IBAN, KvK, btw of adres (alleen naam, website, kleuren, briefhoofd)', !/NL\d{2}\s?[A-Z]{4}|kvk|iban|btw|straat|postcode/i.test(tekstvelden) &&
    Object.values(HS.STIJLEN).every((x) => Object.keys(x).every((k) => ['label', 'naam', 'website', 'kleuren', 'briefhoofd', 'font', 'logo', 'logo_maat', 'docx'].indexOf(k) >= 0)), tekstvelden.slice(0, 300));

  // ── Word ──
  r = await M.omzet({ naam: 'Werkplan.md', soort: 'md', tekst: MD, formaat: 'docx', huisstijl: 'groenhouten' });
  p = bewaar('gh.docx', r);
  toets('docx: 200, zip in orde', r.status === 200 && /No errors detected/.test(sh('unzip -t ' + JSON.stringify(p))), r.j.fout);
  const doc = unzipP(p, 'word/document.xml');
  toets('docx: kop, tabel, lijst, tekst', /Heading1/.test(doc) && /<w:tbl>/.test(doc) && /<w:numPr>/.test(doc) && /Werkplan proefpraktijk/.test(doc) && /Callout-tekst/.test(doc));
  toets('docx: geen [[, geen commentaar, beeld → alt-tekst, file-link → tekst', !/\[\[|intern commentaar|frontmatterwaarde|etc\/passwd/.test(doc) && /beeldtekst/.test(doc) && /lokale verwijzing/.test(doc));
  const media = sh('unzip -l ' + JSON.stringify(p)).split('\n').filter((l) => /word\/media\//.test(l));
  toets('docx huisstijl: kop met logo, voet met naam en paginaveld, A4', media.length === 1 && /logo\.png/.test(media[0]) && /<w:drawing>/.test(unzipP(p, 'word/header1.xml')) &&
    /Huisartsenpraktijk Groenhouten/.test(unzipP(p, 'word/footer1.xml')) && /NUMPAGES/.test(unzipP(p, 'word/footer1.xml')) && /w:w="11906"/.test(doc), media);
  r = await M.omzet({ naam: 'Werkplan.md', soort: 'md', tekst: '## Alleen een tussenkop\n\nTekst.', formaat: 'docx' });
  p = bewaar('n.docx', r);
  toets('docx neutraal: titel uit de bestandsnaam erboven, geen kop, wel paginavoet', /Werkplan/.test(unzipP(p, 'word/document.xml')) && !/header1/.test(sh('unzip -l ' + JSON.stringify(p))) && /PAGE/.test(unzipP(p, 'word/footer1.xml')));
  r = await M.omzet({ naam: 'notitie.txt', soort: 'tekst', tekst: 'Regel een *geen nadruk*\nregel twee <b>geen tag</b>\n\nTweede alinea', formaat: 'docx' });
  p = bewaar('t.docx', r);
  toets('docx uit platte tekst: letterlijk (geen markdown, geen html)', r.status === 200 && /\*geen nadruk\*/.test(unzipP(p, 'word/document.xml')) && /&lt;b&gt;geen tag&lt;\/b&gt;/.test(unzipP(p, 'word/document.xml')));
  r = await M.omzet({ naam: 'proef.html', soort: 'html', tekst: HTML, formaat: 'docx' });
  p = bewaar('h.docx', r);
  toets('docx uit html: tekst ja, geen script, geen beeld', r.status === 200 && /Html-proef/.test(unzipP(p, 'word/document.xml')) && !/SCRIPT DRAAIDE|document\.getElementById/.test(unzipP(p, 'word/document.xml')) && !/word\/media/.test(sh('unzip -l ' + JSON.stringify(p))));

  // ── Excel ──
  r = await M.omzet({ naam: 'Werkplan.md', soort: 'md', tekst: MD, formaat: 'xlsx' });
  p = bewaar('x.xlsx', r);
  toets('xlsx: 200, zip in orde, naam', r.status === 200 && /No errors detected/.test(sh('unzip -t ' + JSON.stringify(p))) && r.j.naam === 'Werkplan.xlsx', r.j.fout);
  const wb = unzipP(p, 'xl/workbook.xml'), s1 = unzipP(p, 'xl/worksheets/sheet1.xml'), sst = unzipP(p, 'xl/sharedStrings.xml');
  toets('xlsx: blad per tabel, genoemd naar de kop', /name="Kosten"/.test(wb) && /name="Planning"/.test(wb) && (wb.match(/<sheet /g) || []).length === 2, wb);
  toets('xlsx: getallen als getal (NL-notatie, euro, negatief)', /<c r="B2" s="2"><v>1234\.56<\/v>/.test(s1) && /<c r="B3"><v>12\.5<\/v>/.test(s1) && /<c r="B5"><v>-5<\/v>/.test(s1), s1.slice(0, 600));
  toets('xlsx: =SOM blijft tekst (quotePrefix), voorloopnul tekst, nergens een formule', /<c r="C3" t="s" s="3">/.test(s1) && /=SOM\(A1:A3\)/.test(sst) && /<c r="B4" t="s">/.test(s1) && !/<f>|<f /.test(s1 + unzipP(p, 'xl/worksheets/sheet2.xml')));
  toets('xlsx: <br> in een cel → regelafbreking', /jaar\ntwee regels/.test(sst));
  r = await M.omzet({ naam: 'Lijst.csv', soort: 'csv', tekst: 'Naam;Aantal\nAppels;3\n', formaat: 'xlsx' });
  toets('xlsx uit csv (puntkomma)', r.status === 200 && /Appels/.test(unzipP(bewaar('c.xlsx', r), 'xl/sharedStrings.xml')), r.j.fout);
  r = await M.omzet({ naam: 'Lijst.csv', soort: 'csv', tekst: 'Naam,Aantal\nPeren,"1,5"\n', formaat: 'pdf' });
  toets('pdf uit csv', r.status === 200 && /Peren/.test(sh('pdftotext ' + JSON.stringify(bewaar('c.pdf', r)) + ' -')), r.j.fout);
  r = await M.omzet({ naam: 'proef.html', soort: 'html', tekst: HTML, formaat: 'xlsx' });
  toets('xlsx uit html-tabel', r.status === 200 && /Waarde 42/.test(unzipP(bewaar('h.xlsx', r), 'xl/sharedStrings.xml')), r.j.fout);
  r = await M.omzet({ naam: 'Geen.md', soort: 'md', tekst: '# Geen tabel\n\nTekst.', formaat: 'xlsx' });
  toets('xlsx zonder tabel → 422', r.status === 422 && /geen tabel/.test(r.j.fout), r);

  // ── xlsx-schrijver los ──
  const g = (x) => { const v = X.alsGetal(x); return v ? v.getal + (v.euro ? '€' : '') : null; };
  toets('alsGetal: NL/EN/euro/voorloopnul/tekst', g('1.234,56') === '1234.56' && g('1.234') === '1234' && g('3.5') === '3.5' && g('12,5') === '12.5' && g('€ 25,-') === '25€' &&
    g('-€ 3,10') === '-3.1€' && g('0612345678') === null && g('1234567890123456') === null && g('=1+1') === null && g('12%') === null && g('abc') === null && g('1,234.5') === '1234.5',
    ['1.234,56', '€ 25,-', '-€ 3,10', '0612345678'].map(g));
  toets('bladnamen: ongeldige tekens weg, ≤ 31, uniek, leeg → Tabel n', JSON.stringify(X.bladNamen(['a/b:c*', 'x'.repeat(40), 'Kosten', 'kosten', '', 'History'])) ===
    JSON.stringify(['a b c', 'x'.repeat(31), 'Kosten', 'kosten (2)', 'Tabel 5', 'Tabel 6']), X.bladNamen(['a/b:c*', 'x'.repeat(40), 'Kosten', 'kosten', '', 'History']));
  const xb = X.schrijf([{ naam: 'B', rijen: [['K'], ['<script>&"\u0001'], ['+cmd|x'], ['@SUM(1)']] }]);
  fs.writeFileSync(path.join(W, 'los.xlsx'), xb);
  const sst2 = unzipP(path.join(W, 'los.xlsx'), 'xl/sharedStrings.xml');
  toets('xlsx-schrijver: XML ontsnapt, stuurteken weg, + en @ met quotePrefix', /&lt;script&gt;&amp;&quot;<\/t>/.test(sst2) && (unzipP(path.join(W, 'los.xlsx'), 'xl/worksheets/sheet1.xml').match(/s="3"/g) || []).length === 2, sst2);

  // ── AST-schoonmaak ──
  const ast = O.schoon({ blocks: [{ t: 'Para', c: [{ t: 'Image', c: [['', [], []], [{ t: 'Str', c: 'alt' }], ['/etc/passwd', '']] }, { t: 'Link', c: [['', ['x'], []], [{ t: 'Str', c: 'l' }], ['javascript:alert(1)', '']] },
    { t: 'Link', c: [['', [], []], [{ t: 'Str', c: 'goed' }], ['https://example.org/', 't']] }, { t: 'RawInline', c: ['html', '<img src=x>'] }, { t: 'RawInline', c: ['html', '<br/>'] }] }, { t: 'RawBlock', c: ['html', '<script>x</script>'] }] });
  toets('schoon: beeld → alt, javascript-link → tekst, http-link blijft, ruwe html weg, <br> → LineBreak', JSON.stringify(ast) ===
    JSON.stringify({ blocks: [{ t: 'Para', c: [{ t: 'Str', c: 'alt' }, { t: 'Str', c: 'l' }, { t: 'Link', c: [['', [], []], [{ t: 'Str', c: 'goed' }], ['https://example.org/', '']] }, { t: 'LineBreak' }] }] }), ast);

  // ── grenzen ──
  r = await M.omzet({ naam: 'x.md', soort: 'md', tekst: 'a'.repeat(2 * 1024 * 1024 + 1), formaat: 'pdf' });
  toets('2 MB + 1 byte → 413 met uitleg', r.status === 413 && /hooguit 2 MB/.test(r.j.fout), r.j);
  r = await M.omzet({ naam: 'x.md', soort: 'md', tekst: 'é'.repeat(1024 * 1024 + 1), formaat: 'docx' });
  toets('2 MB telt in bytes (UTF-8), niet in tekens', r.status === 413, r.status);
  for (const [d, verwacht] of [[{ formaat: 'exe', tekst: 'x' }, 400], [{ formaat: 'pdf', soort: 'php', tekst: 'x' }, 400], [{ formaat: 'pdf' }, 400],
    [{ formaat: 'pdf', tekst: 'x', huisstijl: '../x' }, 400], [{ formaat: 'xlsx', tekst: '|a|\n|-|\n|1|', huisstijl: 'tolgaarde' }, 400]]) {
    r = await M.omzet(d);
    toets('ongeldig ' + JSON.stringify(d).slice(0, 60) + ' → ' + verwacht, r.status === verwacht, r);
  }
  toets('bestandsnaam: pad en vreemde tekens weg', M.invoer({ formaat: 'pdf', tekst: '', naam: '../../a<b>:c?.md' }).basis === 'abc' && M.invoer({ formaat: 'pdf', tekst: '', naam: '...' }).basis === 'document');
  const T = O.maak({ tmp: TMP, tijdMs: 30, fout: function () {} });
  r = await T.omzet({ naam: 'x.md', soort: 'md', tekst: LANG, formaat: 'pdf' });
  toets('tijdslimiet → 504 met nette fout', r.status === 504 && /duurde te lang/.test(r.j.fout), r.j);

  // één tegelijk: een trage pandoc die overlap opmerkt; 1 bezig + 3 wachtend, de vijfde krijgt 503
  const traag = path.join(W, 'traag-pandoc.sh'), slot = path.join(W, 'slot'), log = path.join(W, 'overlap.log');
  fs.writeFileSync(traag, '#!/bin/bash\nmkdir ' + JSON.stringify(slot) + ' 2>/dev/null || echo OVERLAP >> ' + JSON.stringify(log) + '\nsleep 0.4\n/usr/bin/pandoc "$@"; c=$?\nrmdir ' + JSON.stringify(slot) + ' 2>/dev/null\nexit $c\n', { mode: 0o700 });
  const Q = O.maak({ tmp: TMP, pandoc: traag, fout: function () {} });
  const vijf = await Promise.all([1, 2, 3, 4, 5].map((i) => Q.omzet({ naam: 'q' + i + '.md', soort: 'md', tekst: '# Q' + i + '\n\n|a|\n|-|\n|' + i + '|', formaat: i % 2 ? 'docx' : 'xlsx' })));
  toets('wachtrij: vier klaar, de vijfde 503 (druk)', vijf.filter((x) => x.status === 200).length === 4 && vijf.filter((x) => x.status === 503).length === 1, vijf.map((x) => x.status));
  toets('wachtrij: nooit twee tegelijk', !fs.existsSync(log), fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  toets('wachtrij leeg na afloop', Q._staat.bezig === false && Q._staat.rij.length === 0);
  toets('tijdelijke mappen weg', fs.readdirSync(TMP).length === 0, fs.readdirSync(TMP));

  // ── review 28-10: kindproces, bewaking, grenzen ──
  let t0 = Date.now();
  O.voorMd('\n'.repeat(400 * 1024) + '> [!note] x\n', require('./docs-delen.js').voorbewerk);
  toets('callout-regex lineair: 400 kB lege regels < 300 ms', Date.now() - t0 < 300, Date.now() - t0);
  r = await M.omzet({ naam: 'Groot.md', soort: 'md', tekst: '| a |\n|---|\n' + '| 1 |\n'.repeat(5001), formaat: 'pdf' });
  toets('PDF met > 5.000 tabelregels → 413 met advies Excel', r.status === 413 && /Kies Excel/.test(r.j.fout), r.j);
  r = await M.omzet({ naam: 'Groot.md', soort: 'md', tekst: '| a |\n|---|\n' + '| 1 |\n'.repeat(5001), formaat: 'xlsx' });
  toets('… als Excel gaat dezelfde tekst wel', r.status === 200, r.j.fout);
  toets('health: sandbox gemeten (waar of onwaar)', typeof M.health().sandbox === 'boolean', M.health());
  const G = O.maak({ tmp: TMP, maxRss: 1, pandoc: traag, fout: function () {} });
  r = await G.omzet({ naam: 'x.md', soort: 'md', tekst: '# x', formaat: 'docx' });
  toets('geheugenwachter: boven de grens → 413 en afgebroken=geheugen', r.status === 413 && r.audit.afgebroken === 'geheugen', r);
  const envLog = path.join(W, 'env.log'), envPandoc = path.join(W, 'env-pandoc.sh');
  fs.writeFileSync(envPandoc, '#!/bin/bash\nenv > ' + JSON.stringify(envLog) + '\nexec /usr/bin/pandoc "$@"\n', { mode: 0o700 });
  process.env.GEHEIM_PROEF_1854 = 'mag-niet-mee';
  r = await O.maak({ tmp: TMP, pandoc: envPandoc, fout: function () {} }).omzet({ naam: 'x.md', soort: 'md', tekst: '# x', formaat: 'docx' });
  const envT = fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8') : '';
  toets('kindproces en pandoc krijgen een kale omgeving (geen sleutels van de server)', r.status === 200 && envT.length > 0 && !/GEHEIM_PROEF_1854/.test(envT) && /TMPDIR=/.test(envT), envT.slice(0, 200));
  delete process.env.GEHEIM_PROEF_1854;
  const H = O.maak({ tmp: TMP, pandoc: traag, hardTotMs: 250, fout: function () {} });
  r = await H.omzet({ naam: 'h.md', soort: 'md', tekst: '# h', formaat: 'docx' });
  await new Promise((x) => setTimeout(x, 300));
  const rest = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((x) => { try { return fs.readFileSync('/proc/' + x + '/cmdline', 'utf8').indexOf(traag) >= 0; } catch (e) { return false; } });
  toets('harde tijdslimiet: 504 en de hele procesboom (ook pandoc) weg', r.status === 504 && r.audit.afgebroken === 'tijd' && rest.length === 0, { s: r.status, a: r.audit, rest: rest.length });
  r = await M.omzet({ naam: 'l.html', soort: 'html', tekst: '<p><a href="file:///etc/passwd">lokaal</a> <a href=\'javascript:x\'>js</a> <a href="https://example.org/ok">goed</a></p>', formaat: 'pdf' });
  const ruwPdf = Buffer.from(r.j.inhoud || '', 'base64').toString('latin1');
  toets('html → PDF: alleen http(s)-links blijven', r.status === 200 && /\/URI \(https:\/\/example\.org\/ok\)/.test(ruwPdf) && !/file:\/\/|javascript:/.test(ruwPdf));
  toets('xlsx: 10.30 en 14.00 blijven tekst', X.alsGetal('10.30') === null && X.alsGetal('14.00') === null && X.alsGetal('3.5').getal === 3.5);

  // ── opdrachtregel ──
  fs.writeFileSync(path.join(W, 'cli.md'), '# Cli\n\nProef.\n');
  sh('node ' + JSON.stringify(path.resolve('omzet.js')) + ' docx --huisstijl tolgaarde cli.md cli.docx');
  toets('opdrachtregel: node omzet.js docx --huisstijl … werkt', /No errors detected/.test(sh('unzip -t cli.docx')));

  // ── koppeling ──
  const srv = fs.readFileSync('server.js', 'utf8');
  toets('server.js: POST /app/omzet in APP_SLOT_VRIJ, grotere body alleen voor die route, 413 bij te groot',
    /const APP_SLOT_VRIJ = new Set\(\['POST \/app\/omzet'/.test(srv) && /p === '\/app\/omzet' \? APP_OMZET_MAX_BODY : APP_MAX_BODY/.test(srv) && /fout === 'groot' && p === '\/app\/omzet'\) return appWeiger\(res, 413/.test(srv));
  toets('server.js: route, teller, /health.omzet', /route === 'POST \/app\/omzet'\) return typeof appOmzet/.test(srv) && /appTeller\('omzet', 120, 3600000\)/.test(srv) && /omzet: omzetInfo\(\)/.test(srv));
  // 28-10: appTeller('omzet') gaf TypeError (geen tellers.omzet) → elke POST 500; de teller moet een nieuwe soort zelf aanmaken
  const tel = srv.slice(srv.indexOf('function appTeller('), srv.indexOf('function appCookieKop('));
  const telF = new Function('appStaat', tel + '; return appTeller;')({ tellers: {} });
  toets('server.js: appTeller maakt een onbekende soort zelf aan (geen TypeError)', (function () { try { return telF('nieuw', 2, 1000) === true && telF('nieuw', 2, 1000) === true && telF('nieuw', 2, 1000) === false; } catch (e) { return false; } })());
  toets('server.js: audit zonder inhoud (alleen audit-velden in de reden)', !/res\._app\.reden = [^\n]*(d\.tekst|d\.naam)/.test(srv.slice(srv.indexOf('async function appOmzet'), srv.indexOf('// ── einde download als'))));
  const uit = fs.readFileSync('uitrol.sh', 'utf8'), dock = fs.readFileSync('Dockerfile', 'utf8');
  toets('uitrol.sh en Dockerfile: omzet.js, omzet-huisstijl.js, xlsx-schrijver.js', ['omzet.js', 'omzet-huisstijl.js', 'xlsx-schrijver.js'].every((b) => new RegExp('RELEASE_OPTIONEEL="[^"]*\\b' + b.replace('.', '\\.') + '\\b').test(uit)) &&
    /COPY omzet\.js omzet-huisstijl\.js xlsx-schrijver\.js \/app\/release-bootstrap\//.test(dock));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('UITZONDERING', e); process.exit(1); });
JS
