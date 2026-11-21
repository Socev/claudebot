#!/usr/bin/env bash
# Toetst brain-tekst.js en de inhoudszoek van secondbrain.js (wv3734, besluitenpagina nr 404 = 3C104): pdf (tekstlaag via pdftotext) en docx
# (unzip) worden uitgelezen naar een cache buiten de vault, Brain › Zoeken vindt ze op een zin die alleen in het stuk staat, een gewijzigd stuk
# telt pas na de volgende ronde weer, een verdwenen stuk gaat uit de cache, een scan zonder tekst telt als zonder_tekst, de hele zin gaat vóór
# losse woorden. Plus de koppeling in server.js en zoek-snel.js (wv3734, nr 383 = 3C83: verouderd-sein). Verzonnen stukken; raakt de echte
# vault niet. Gebruik: bash test/brain-tekst.sh (heeft pdftotext en unzip nodig; zonder die twee: overgeslagen met exit 0).
set -u
cd "$(dirname "$0")/.." || exit 1
if ! command -v pdftotext >/dev/null || ! command -v unzip >/dev/null || ! command -v python3 >/dev/null; then echo "OVERGESLAGEN: pdftotext/unzip/python3 ontbreekt"; exit 0; fi
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
V="$W/vault"; mkdir -p "$V/10_Zakelijk/Polissen" "$V/20_Prive/Bronnen" "$V/20_Prive/Notities"
# verzonnen pdf met een tekstlaag, een "scan" zonder tekst, en een docx
python3 - "$V" <<'PY'
import sys, zipfile
V = sys.argv[1]
def pdf(pad, regels):
    inhoud = "BT /F1 12 Tf 72 720 Td " + " ".join("(%s) Tj 0 -16 Td" % r for r in regels) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            "<< /Length %d >>\nstream\n%s\nendstream" % (len(inhoud), inhoud), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    uit, plek = b"%PDF-1.4\n", []
    for i, o in enumerate(objs):
        plek.append(len(uit)); uit += ("%d 0 obj\n%s\nendobj\n" % (i + 1, o)).encode()
    x = len(uit)
    uit += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode() + b"".join(("%010d 00000 n \n" % p).encode() for p in plek)
    uit += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)).encode()
    open(pad, "wb").write(uit)
pdf(V + "/10_Zakelijk/Polissen/polisblad-2026.pdf", ["Verzekeraar Zonnebloem Verzekeringen", "Het eigen risico bedraagt driehonderdvijfenzeventig euro",
    "Dekking voor glasschade aan de veranda"])
pdf(V + "/20_Prive/Bronnen/scan.pdf", [])
with zipfile.ZipFile(V + "/20_Prive/Notities/huurcontract.docx", "w") as z:
    z.writestr("[Content_Types].xml", "<Types/>")
    z.writestr("word/document.xml", '<w:document><w:body><w:p><w:r><w:t>Huurovereenkomst voor de garagebox</w:t></w:r></w:p>'
               '<w:p><w:r><w:t xml:space="preserve">De opzegtermijn is twee </w:t></w:r><w:r><w:t>kalendermaanden &amp; schriftelijk</w:t></w:r></w:p></w:body></w:document>')
    z.writestr("word/footer1.xml", '<w:ftr><w:p><w:r><w:t>Paraaf verhuurder Kwartelkoning</w:t></w:r></w:p></w:ftr>')
PY
# pagina's die dezelfde losse woorden hebben (de hele zin moet vóór gaan)
for i in $(seq 1 5); do printf '# Notitie %s\nHet risico van een eigen verzekering is soms hoog; eigen keuze, risico bekend.\n' "$i" > "$V/20_Prive/Notities/n$i.md"; done
W="$W" V="$V" node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
const S = require('./secondbrain.js'), BT = require('./brain-tekst.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
(async function () {
  const W = process.env.W, V = process.env.V, D = path.join(W, 'inhoud');
  const bt = BT.maak({ vault: V, dir: D });
  const s = S.maak({ vault: V, dir: path.join(W, 'sb'), inhoud: bt }); s.mkdir();
  const zonder = S.maak({ vault: V, dir: path.join(W, 'sb0') }); zonder.mkdir();
  const kaart = () => s.vers(true).bestanden;
  const zoek = async (q, soorten, x) => (await (x || s).app('POST /app/secondbrain/zoek', { q: q, soorten: soorten || [] }, {})).j;

  toets('1 vóór de eerste ronde: pdf niet op inhoud', !(await zoek('glasschade aan de veranda')).treffers.some((t) => /polisblad/.test(t.pad)));
  const r1 = await bt.ronde(kaart());
  toets('2 ronde telt 3 stukken: 2 met tekst, 1 zonder (scan)', r1.stukken === 3 && r1.nieuw === 3 && r1.met_tekst === 2 && r1.zonder_tekst === 1 && !r1.afgekapt, r1);
  const st = fs.statSync(D), stT = fs.statSync(path.join(D, 't'));
  const txt = fs.readdirSync(path.join(D, 't'));
  toets('3 map 0700, bestanden 0600, naam = sha1 (geen pad)', (st.mode & 0o777) === 0o700 && (stT.mode & 0o777) === 0o700 && txt.length === 2 &&
    txt.every((f) => /^[0-9a-f]{40}\.txt$/.test(f) && (fs.statSync(path.join(D, 't', f)).mode & 0o777) === 0o600), txt);
  const j1 = await zoek('glasschade aan de veranda');
  const p1 = j1.treffers.find((t) => /polisblad/.test(t.pad));
  toets('4 zin uit de pdf vindt de pdf, waar = inhoud, met fragment', !!p1 && p1.waar === 'inhoud' && p1.groep === 'tekst' && /glasschade/i.test(p1.fragment), j1);
  const j2 = await zoek('opzegtermijn is twee kalendermaanden');
  toets('5 zin uit de docx (twee w:t-stukken) vindt de docx', j2.treffers.some((t) => /huurcontract\.docx$/.test(t.pad) && t.waar === 'inhoud'), j2);
  toets('6 voettekst van de docx doet mee', (await zoek('kwartelkoning')).treffers.some((t) => /huurcontract/.test(t.pad)));
  toets('7 &amp; in docx wordt &', /kalendermaanden & schriftelijk/.test(bt.tekst(kaart().find((b) => /huurcontract/.test(b.p)))));
  toets('8 chip PDF: alleen de pdf, op inhoud', (await zoek('glasschade', ['pdf'])).treffers.every((t) => /\.pdf$/.test(t.pad)) && (await zoek('glasschade', ['pdf'])).treffers.length === 1);
  toets('9 chip Pagina\'s: geen pdf op inhoud', !(await zoek('glasschade', ['paginas'])).treffers.length);
  toets('10 zonder opt.inhoud: oud gedrag (alleen op naam)', !(await zoek('glasschade aan de veranda', [], zonder)).treffers.length);
  const j3 = await zoek('het eigen risico');
  toets('11 de hele zin gaat vóór pagina\'s met dezelfde losse woorden', j3.treffers.length >= 6 && /polisblad/.test(j3.treffers[0].pad), j3.treffers.map((t) => t.pad));
  // gewijzigd stuk: pas na de volgende ronde weer op inhoud
  const pdfAbs = path.join(V, '10_Zakelijk/Polissen/polisblad-2026.pdf');
  fs.appendFileSync(pdfAbs, '\n'); const toek = new Date(Date.now() + 5000); fs.utimesSync(pdfAbs, toek, toek);
  kaart();   // de kaart ziet de wijziging (in de pod: na KAART_VERS_MS)
  toets('12 gewijzigd na de ronde: niet uit de oude cache', !(await zoek('glasschade aan de veranda')).treffers.some((t) => t.waar === 'inhoud'));
  const r2 = await bt.ronde(kaart());
  toets('13 tweede ronde leest alleen het gewijzigde stuk', r2.nieuw === 1 && r2.met_tekst === 2 && r2.zonder_tekst === 1, r2);
  toets('14 daarna weer gevonden', (await zoek('glasschade aan de veranda')).treffers.some((t) => /polisblad/.test(t.pad) && t.waar === 'inhoud'));
  fs.unlinkSync(path.join(V, '20_Prive/Notities/huurcontract.docx'));
  const r3 = await bt.ronde(kaart());
  toets('15 verdwenen stuk gaat uit cache en manifest', r3.weg === 1 && fs.readdirSync(path.join(D, 't')).length === 1 && !JSON.parse(fs.readFileSync(path.join(D, 'manifest.json'), 'utf8')).bestanden['20_Prive/Notities/huurcontract.docx'], r3);
  const i = bt.info();
  toets('16 info: aantallen, geen tekst', i.aan && i.stukken === 2 && i.laatste && i.laatste.met_tekst === 1 && !JSON.stringify(i).includes('glasschade'), i);
  toets('17 docxTekst: tab, regeleinde, entiteiten', BT.docxTekst('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b&#233;&lt;</w:t><w:br/><w:t>c</w:t></w:r></w:p>') === 'a\tbé<\nc\n');
  toets('18 soortVan: alleen pdf en docx', BT.soortVan('x/y.PDF') === 'pdf' && BT.soortVan('a.docx') === 'docx' && BT.soortVan('a.doc') === null && BT.soortVan('a.xlsx') === null);
  // tweede ronde tegelijk = bezig
  const t2 = new Date(Date.now() + 10000); fs.utimesSync(pdfAbs, t2, t2);
  const k2 = kaart();
  const [a, b] = await Promise.all([bt.ronde(k2), bt.ronde(k2)]);
  toets('19 twee rondes tegelijk: de tweede zegt bezig', !!(a.bezig || b.bezig) && !(a.bezig && b.bezig));

  // review MOET 1: een mislukte uitlezing wordt opnieuw geprobeerd (tot 3 keer per versie), niet als klaar onthouden
  const kapot = path.join(V, '10_Zakelijk/Polissen/kapot.docx'); fs.writeFileSync(kapot, 'geen zip');
  const f1 = await bt.ronde(kaart()), f2 = await bt.ronde(kaart()), f3 = await bt.ronde(kaart()), f4 = await bt.ronde(kaart());
  const mf = JSON.parse(fs.readFileSync(path.join(D, 'manifest.json'), 'utf8')).bestanden['10_Zakelijk/Polissen/kapot.docx'];
  toets('20a kapot stuk: 3 pogingen, daarna rust tot het wijzigt; telt als fout', f1.nieuw === 1 && f2.nieuw === 1 && f3.nieuw === 1 && f4.nieuw === 0 && f4.fout === 1 && mf.fout === 3 && mf.n === 0, [f1, f2, f3, f4, mf]);
  fs.writeFileSync(kapot, 'nog steeds geen zip, wel anders'); kaart();
  toets('20b gewijzigd kapot stuk: weer geprobeerd', (await bt.ronde(kaart())).nieuw === 1);

  // ── server.js en zoek-snel.js (koppeling) ──
  const src = fs.readFileSync('server.js', 'utf8'), zs = fs.readFileSync('zoek-snel.js', 'utf8'), ui = fs.readFileSync('uitrol.sh', 'utf8');
  toets('20 server: brainTekst vóór secondbrain, inhoud doorgegeven, uurronde, /health', src.indexOf('const brainTekst =') > 0 && src.indexOf('const brainTekst =') < src.indexOf('const secondbrain = (function')
    && /inhoud: brainTekst/.test(src) && /function brainTekstTik/.test(src) && /h\.inhoud = brainTekst\.info\(\)/.test(src));
  toets('21 uitrol.sh: brain-tekst.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bbrain-tekst\.js\b/.test(ui));
  toets('22 3C83: zoek-snel seint bij pagina nieuwer en verouderd', /reden === 'pagina nieuwer'\) verouderdSein\('feitenlijst'\)/.test(zs) && /verouderdSein\('tekstindex'\)/.test(zs) && /verouderd: function \(laag\) \{ if \(typeof zoekOverdagVraag === 'function'\) zoekOverdagVraag\(laag\)/.test(src));
  toets('23 3C83: overdag 07–23, zelfde argv als de nacht, zonder socev-run, begrensd', /ZOEK_OVERDAG_VAN = 7, ZOEK_OVERDAG_TOT = 23/.test(src) && /sb2ZoekKlok\('sb2-feitenlijst', \{ van: \[5, 0\], tot: \[5, 30\] \}, 5, SB2_FEITEN_ARGV\)/.test(src)
    && /zoekOverdagStap\(SB2_INDEX_ARGV/.test(src) && /ZOEK_OVERDAG_VRAAG_MS = 5 \* 60000/.test(src) && /nachtketenActief\(\)\) return false/.test(src));
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
