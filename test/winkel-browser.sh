#!/usr/bin/env bash
# Toetst de browserroute van OVIS Shopper (wv2949, 11-11-2026): winkel-lezen.py --mag/--html en winkel-browser.js. Zonder netwerk en zonder
# echte browser (een nep-kind schrijft de HTML); alleen verzonnen pagina's, producten en prijzen.
#  1. --mag: alleen een https-productpagina van Gamma, Karwei, Medische Vakhandel of Daxtrio; zoek-, winkelwagen- en accountpaden en
#     andere winkels geweigerd
#  2. het leesscript zelf weigert een browserwinkel (geen GET), --html leest met dezelfde regels: Gamma/Karwei verzending (drempel) en
#     levertijd, niet thuis bezorgd; Medische Vakhandel beschikbaarheid en gratis-drempel; Daxtrio excl. in de JSON-LD → incl. uit het
#     koopblok, twee koopblokken = geen prijs; --html op een andere winkel of een doorgestuurde andere host = geweigerd
#  3. winkel-browser.js: kale omgeving in het kind, cache (geen tweede kind), rij-grens (druk), harde tijdsgrens (kind weg), weigering
#     zonder kind, uitkomst met route browser
#  4. shopper-winkels.domeinenVoor: lezen: browser telt alleen mee met metBrowser
#  5. bewaak() met een echte Chromium: hoofdframe alleen de gevraagde url, ook niet na een 302; geen beelden (zonder Chromium overgeslagen)
# Gebruik: bash test/winkel-browser.sh
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
python3 -I -B - "$PWD/winkel-lezen.py" "$T" <<'PY'
import json, subprocess, sys, os
S, T = sys.argv[1], sys.argv[2]
goed = fout = 0
def toets(naam, ok, extra=None):
    global goed, fout
    if ok: goed += 1
    else: fout += 1
    print(("GROEN " if ok else "ROOD  ") + naam + ("" if ok or extra is None else "  [" + json.dumps(extra, ensure_ascii=False, default=str)[:400] + "]"))
def py(*a):
    p = subprocess.run([sys.executable, "-I", "-B", S] + list(a), capture_output=True, text=True, timeout=30)
    try: return json.loads(p.stdout.strip().split("\n")[0])
    except Exception: return {"_fout": p.stdout[:200] + p.stderr[:200]}
def html(naam, inhoud):
    p = os.path.join(T, naam + ".html"); open(p, "w", encoding="utf-8").write(inhoud); return p
ld = lambda d: '<script type="application/ld+json">' + json.dumps(d) + '</script>'

# ── 1. --mag ──
for url, ok, naam in [("https://www.gamma.nl/assortiment/proef-kast-wit/p/B123456", True, "Gamma productpagina"),
                      ("https://www.karwei.nl/assortiment/proefpomp/p/B999", True, "Karwei productpagina"),
                      ("https://medischevakhandel.nl/products/proef-manchet", True, "Medische Vakhandel productpagina"),
                      ("https://www.daxtrio.nl/p/proef-elektroden", True, "Daxtrio productpagina"),
                      ("https://www.gamma.nl/zoeken?text=kast", False, "Gamma zoeken (robots)"),
                      ("https://www.karwei.nl/my/bestellingen", False, "Karwei account"),
                      ("https://www.gamma.nl/assortiment/k/wonen", False, "Gamma categoriepagina"),
                      ("https://www.daxtrio.nl/search?q=x", False, "Daxtrio zoeken (robots)"),
                      ("https://www.daxtrio.nl/checkout", False, "Daxtrio afrekenen"),
                      ("https://medischevakhandel.nl/cart", False, "Medische Vakhandel winkelwagen"),
                      ("http://www.gamma.nl/assortiment/proef/p/B1", False, "http"),
                      ("https://www.bol.com/nl/nl/p/proef/9200000000001/", False, "andere winkel (bol)"),
                      ("https://tweakers.net/pricewatch/123/proef.html", False, "vergelijker (Tweakers)")]:
    m = py("--mag", url)
    toets("1 --mag " + naam + (" mag" if ok else " geweigerd"), m.get("ok") is ok and (ok or m.get("reden")), m)

# ── 2. leesscript ──
r = py("https://www.gamma.nl/assortiment/proef-kast-wit/p/B123456")
toets("2a leesscript weigert een browserwinkel zonder GET", r.get("status") is None and "alleen in een browser" in (r.get("blokkade") or ""), r)
KAR = "https://www.karwei.nl/assortiment/proefpomp/p/B999"
k1 = html("k1", "<html><body>" + ld({"@context": "https://schema.org", "@type": "Product", "name": "Proefpomp Blauw", "offers": {"@type": "Offer",
     "availability": "https://schema.org/InStock", "priceCurrency": "EUR", "price": "12.34"}}) +
     "<h1>Proefpomp Blauw</h1><p>Thuisbezorgd voor €4.95 en gratis vanaf €50</p><p>Vandaag besteld, dinsdag 3 maart in huis</p></body></html>")
r = py("--html", KAR, KAR, k1, "200")
toets("2b Karwei: prijs incl. btw uit de JSON-LD", r.get("prijs_eur") == 12.34 and r.get("btw") == "incl", r)
toets("2c Karwei: onder de drempel € 4,95 verzending", r.get("verzending_eur") == 4.95 and "gratis vanaf" in (r.get("verzending_tekst") or ""), r)
toets("2d Karwei: levertijd uit 'Vandaag besteld, … in huis'", r.get("levertijd") == "dinsdag 3 maart in huis", r)
toets("2e Karwei: voorraad uit de JSON-LD, bouwmarkt-opmerking", r.get("voorraad") == "op voorraad" and any("bouwmarkt" in x for x in r.get("opmerkingen", [])), r)
k2 = html("k2", open(k1, encoding="utf-8").read().replace('"12.34"', '"64.50"'))
r = py("--html", KAR, KAR, k2)
toets("2f Karwei: boven de drempel gratis", r.get("verzending_eur") == 0.0 and r.get("prijs_eur") == 64.5, r)
GAM = "https://www.gamma.nl/assortiment/proef-band/p/B777"
g1 = html("g1", "<html><body>" + ld({"@type": "Product", "name": "Proefband 28 inch", "offers": {"@type": "Offer", "availability": "https://schema.org/InStock", "price": "7.50"}}) +
     "<p>Dit product wordt niet thuis bezorgd</p><p>Thuisbezorgd voor €4.95 en gratis vanaf €50</p></body></html>")
r = py("--html", GAM, GAM, g1)
toets("2g Gamma: niet thuis bezorgd = geen verzendbedrag, wel uitleg", r.get("prijs_eur") == 7.5 and r.get("verzending_eur") is None
      and "niet thuis bezorgd" in (r.get("verzending_tekst") or ""), r)
MV = "https://medischevakhandel.nl/products/proef-manchet"
m1 = html("m1", "<html><body>" + ld({"@type": "Product", "name": "Proefmanchet groot", "offers": [{"@type": "Offer", "availability": "https://schema.org/InStock",
     "price": 145.20, "priceCurrency": "EUR", "seller": {"@type": "Organization", "name": "Medische Vakhandel"}}]}) +
     "<h1>Proefmanchet groot</h1><span>€120,00 excl. BTW</span><span>€145,20 incl. BTW</span><p>Beschikbaarheid Wordt voor u besteld</p>"
     "<p>Gratis verzending vanaf €100 excl. btw en €121 incl. btw (NL)</p></body></html>")
r = py("--html", MV, MV, m1)
toets("2h Medische Vakhandel: prijs incl. 21 % en excl. erbij", r.get("prijs_eur") == 145.2 and r.get("btw") == "incl" and r.get("prijs_excl_eur") == 120.0, r)
toets("2i Medische Vakhandel: beschikbaarheid van de pagina", r.get("voorraad") == "Wordt voor u besteld", r)
toets("2j Medische Vakhandel: boven € 121 gratis verzending", r.get("verzending_eur") == 0.0, r)
m2 = html("m2", open(m1, encoding="utf-8").read().replace("145.2", "60.5").replace("€120,00", "€50,00").replace("€145,20", "€60,50"))
r = py("--html", MV, MV, m2)
toets("2k Medische Vakhandel: onder de drempel geen verzendbedrag (tabel van de winkel)", r.get("prijs_eur") == 60.5 and r.get("verzending_eur") is None, r)
DX = "https://www.daxtrio.nl/p/proef-elektroden"
d1 = html("d1", "<html><body>" + ld({"@context": "https://schema.org", "@type": "Product", "name": "Proefelektroden volwassen", "offers": {"@type": "AggregateOffer",
     "offerCount": 1, "priceCurrency": "EUR", "highPrice": 200, "lowPrice": 200}}) +
     "<h1>Proefelektroden volwassen</h1><div>€ 200,00 excl. btw € 218,00 incl. btw In winkelwagen</div></body></html>")
r = py("--html", DX, DX, d1)
toets("2l Daxtrio: JSON-LD excl. → incl. uit het koopblok (9 %)", r.get("prijs_eur") == 218.0 and r.get("btw") == "incl" and r.get("btw_tarief") == 9, r)
d2 = html("d2", open(d1, encoding="utf-8").read().replace("</body>", "<div>€ 200,00 excl. btw € 242,00 incl. btw In winkelwagen</div></body>"))
r = py("--html", DX, DX, d2)
toets("2m Daxtrio: twee koopblokken bij dezelfde prijs = geen prijs", r.get("prijs_eur") is None, r)
d3 = html("d3", open(d1, encoding="utf-8").read().replace('"highPrice": 200', '"highPrice": 260'))
r = py("--html", DX, DX, d3)
toets("2n Daxtrio: AggregateOffer met prijsrange = geen prijs", r.get("prijs_eur") is None, r)
d4 = html("d4", open(d1, encoding="utf-8").read().replace("<h1>", ld({"@type": "Product", "name": "Aanbevolen proefartikel", "offers": {"@type": "AggregateOffer",
     "offerCount": 1, "highPrice": 50, "lowPrice": 50}}) + "<h1>"))
r = py("--html", DX, DX, d4)
toets("2n2 Daxtrio: twee producten in de JSON-LD = geen prijs (review ronde 3)", r.get("prijs_eur") is None, r)
d5 = html("d5", open(d1, encoding="utf-8").read().replace("<div>€ 200,00", "<div>€ 50,00 excl. btw € 54,50 incl. btw In winkelwagen</div><div>€ 200,00"))
r = py("--html", DX, DX, d5)
toets("2n3 Daxtrio: eerste koopblok hoort niet bij het hoofdproduct = geen prijs", r.get("prijs_eur") is None, r)
r = py("--html", "https://www.bol.com/nl/nl/p/proef/9200000000001/", "https://www.bol.com/nl/nl/p/proef/9200000000001/", k1)
toets("2o --html op een andere winkel geweigerd", r.get("prijs_eur") is None and "browserroute alleen" in (r.get("blokkade") or ""), r)
r = py("--html", KAR, "https://www.gamma.nl/assortiment/x/p/B1", k1)
toets("2p --html: doorgestuurd naar een andere winkel geweigerd", r.get("prijs_eur") is None and r.get("blokkade"), r)
r = py("--html", KAR, "https://www.karwei.nl/zoeken?q=x", k1)
toets("2q --html: doorgestuurd naar een zoekpagina geweigerd", r.get("prijs_eur") is None and r.get("blokkade"), r)
print("PY %d groen, %d rood" % (goed, fout))
sys.exit(1 if fout else 0)
PY
PYUIT=$?

# ── 3 en 4: winkel-browser.js met een nep-kind ──
cat > "$T/nepkind.js" <<'JS'
const fs = require('fs');
const [, , , invoer, uit] = process.argv;
const d = JSON.parse(fs.readFileSync(invoer, 'utf8'));
fs.appendFileSync(process.env.HOME + '/../teller', 'x');
const sleutels = Object.keys(process.env).filter((k) => !/^(PATH|HOME|TMPDIR|LANG)$/.test(k));
// review ZOU 1: een extra omgevingsvariabele (zoals een sleutel van de pod) = expliciet falen
if (sleutels.length) { fs.writeFileSync(uit, JSON.stringify({ fout: 'omgeving lekt: ' + sleutels.join(',') })); return; }
if (/traag/.test(d.url)) { setTimeout(() => {}, 60000); return; }
if (/wees/.test(d.url)) {   // een "Chromium" die het kind overleeft (naar init verhuisd) en dan stopt het kind zonder uitkomst
  require('child_process').spawn('sleep', ['297.13'], { detached: true, stdio: 'ignore', env: process.env }).unref();
  return;
}
fs.writeFileSync(d.html, '<html><body><script type="application/ld+json">{"@type":"Product","name":"Proefpomp Blauw","offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":"12.34"}}</script>'
  + '<p>Thuisbezorgd voor €4.95 en gratis vanaf €50</p><p>ENV:' + sleutels.join(',') + '</p></body></html>');
setTimeout(() => fs.writeFileSync(uit, JSON.stringify({ status: 200, eind: d.url, controle: false })), /rij/.test(d.url) ? 400 : 10);
JS
GEHEIM_PROEF=zou-niet-mee-mogen node - "$PWD/winkel-browser.js" "$PWD/shopper-winkels.js" "$T" <<'JS'
const fs = require('fs'), path = require('path');
const [, , mod, wmod, T] = process.argv;
let goed = 0, fout = 0;
const toets = (n, ok, x) => { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (ok || x === undefined ? '' : '  [' + JSON.stringify(x).slice(0, 300) + ']')); };
(async () => {
  const tmp = path.join(T, 'tmp'); fs.mkdirSync(tmp);
  const teller = () => { try { return fs.readFileSync(path.join(tmp, 'teller'), 'utf8').length; } catch (e) { return 0; } };
  const B = require(mod).maak({ chromium: '/bin/true', kindScript: path.join(T, 'nepkind.js'), tmp, kindMs: 1500, cachePad: path.join(T, 'cache.json') });
  const K = 'https://www.karwei.nl/assortiment/proefpomp/p/B999';
  let r = await B.lees(K);
  toets('3a browserroute leest prijs en verzending', r && r.prijs_eur === 12.34 && r.verzending_eur === 4.95 && r.route === 'browser', r);
  toets('3b kind krijgt een kale omgeving (geen geheim van de pod; nep-kind faalt anders)', r && r.prijs_eur === 12.34 && !/lekt/.test(r.blokkade || '') && teller() === 1, r);
  const html = fs.readdirSync(tmp).filter((x) => x.startsWith('winkel-browser-'));
  toets('3c tijdelijke map weer weg', html.length === 0, html);
  r = await B.lees(K);
  toets('3d tweede keer uit de cache, geen tweede kind', r && r.uit_cache === true && teller() === 1, { r, n: teller() });
  toets('3e cache op schijf (0600)', (fs.statSync(path.join(T, 'cache.json')).mode & 0o777) === 0o600 && !!JSON.parse(fs.readFileSync(path.join(T, 'cache.json'), 'utf8'))[K]);
  const voor = teller();
  r = await B.lees('https://www.gamma.nl/zoeken?text=kast');
  toets('3f zoekpad geweigerd zonder kind', r && r.prijs_eur === null && /geweigerd/.test(r.blokkade || '') && teller() === voor, r);
  r = await B.lees('https://www.bol.com/nl/nl/p/proef/9200000000001/');
  toets('3g andere winkel geweigerd zonder kind', r && /browserroute alleen voor/.test(r.blokkade || '') && teller() === voor, r);
  const t0 = Date.now();
  r = await B.lees('https://www.gamma.nl/assortiment/traag/p/B5');
  const pids = require('child_process').execSync('ps -eo args').toString().split('\n').filter((l) => l.includes('nepkind.js') && l.includes('--kind'));
  toets('3h harde tijdsgrens: uitkomst met blokkade, kind weg', r && /niet binnen/.test(r.blokkade || '') && Date.now() - t0 < 20000 && pids.length === 0, { r, pids });
  const rij = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => B.lees('https://www.gamma.nl/assortiment/rij-' + i + '/p/B' + i)));
  const druk = rij.filter((x) => /druk/.test(x.blokkade || '')).length, gel = rij.filter((x) => x.prijs_eur === 12.34).length;
  toets('3i één tegelijk, hooguit 4 wachtend: de rest "druk", niets kwijt', druk >= 1 && gel >= 4 && druk + gel === 6, rij.map((x) => x.blokkade || x.prijs_eur));
  r = await B.lees('https://www.gamma.nl/assortiment/wees/p/B7');
  await new Promise((k) => setTimeout(k, 300));
  const wees = require('child_process').execSync('ps -eo args').toString().split('\n').filter((l) => /^sleep 297\.13$/.test(l.trim()));
  toets('3l review MOET 3: een verhuisde browser van deze lezing gaat ook weg (omgeving), uitkomst eerlijk', wees.length === 0 && /zonder uitkomst/.test(r.blokkade || ''), { r, wees });
  // review MOET 1: de proxy laat alleen https naar het eigen domein op een openbaar IPv4-adres door
  const WB = require(mod);
  toets('3m hostMag: eigen domein en subdomein ja; ander domein, lijkt-op en ip nee',
    WB.hostMag('www.karwei.nl', 'karwei.nl') && WB.hostMag('static.karwei.nl', 'karwei.nl') && !WB.hostMag('karwei.nl.boos.nl', 'karwei.nl')
    && !WB.hostMag('nepkarwei.nl', 'karwei.nl') && !WB.hostMag('127.0.0.1', '0.1') && WB.basisDomein('www.karwei.nl') === 'karwei.nl');
  const nepDns = { 'www.karwei.nl': '93.184.216.34', 'intern.karwei.nl': '10.1.2.3', 'lus.karwei.nl': '127.0.0.1', 'meta.karwei.nl': '169.254.169.254', 'cgnat.karwei.nl': '100.64.0.9' };
  const px = WB.maakProxy('karwei.nl', (h, k) => (nepDns[h] ? k(null, [{ address: nepDns[h], family: 4 }]) : k(new Error('weg'))));
  await new Promise((k) => px.srv.listen(0, '127.0.0.1', k));
  const poort = px.srv.address().port, net = require('net');
  const connect = (doel) => new Promise((k) => { const c = net.connect(poort, '127.0.0.1', () => c.write('CONNECT ' + doel + ' HTTP/1.1\r\nHost: ' + doel + '\r\n\r\n'));
    let t = ''; c.on('data', (x) => { t += x; if (/\r\n\r\n/.test(t)) { c.destroy(); k(t.split('\r\n')[0]); } }); c.on('error', () => k('fout')); setTimeout(() => { c.destroy(); k(t.split('\r\n')[0] || 'stil'); }, 3000); });
  const uit = {};
  for (const d of ['intern.karwei.nl:443', 'lus.karwei.nl:443', 'meta.karwei.nl:443', 'cgnat.karwei.nl:443', 'www.karwei.nl:80', 'www.gamma.nl:443', '127.0.0.1:443', 'onbekend.karwei.nl:443']) uit[d] = await connect(d);
  toets('3n proxy weigert intern, loopback, metadata, CGNAT, andere poort, ander domein, ip en onopzoekbaar', Object.values(uit).every((x) => /403/.test(x)), uit);
  const gewoon = await new Promise((k) => require('http').get({ host: '127.0.0.1', port: poort, path: 'http://www.karwei.nl/' }, (res) => { res.resume(); k(res.statusCode); }).on('error', () => k(0)));
  toets('3o proxy weigert gewone http', gewoon === 403, gewoon);
  px.srv.close();
  const zonder = require(mod).maak({ chromium: null, tmp });
  r = await zonder.lees(K);
  toets('3j zonder Chromium: eerlijke blokkade', r && /Chromium ontbreekt/.test(r.blokkade || ''), r);
  const inf = B.info();
  toets('3k info alleen tellers (geen url of tekst)', JSON.stringify(Object.keys(inf)) === '["aan","bezig","rij","gelezen","mislukt","cache","geweigerd"]'
    && inf.rij === 0 && inf.bezig === false && inf.cache === 1 && inf.geweigerd === 2 && !/http/.test(JSON.stringify(inf)), inf);
  const kaal = require('child_process').execSync('ps -eo args').toString().split('\n').filter((l) => /^\S*node .*nepkind\.js --kind/.test(l));
  toets('3p geen nep-kind meer over', kaal.length === 0, kaal);
  // 4. domeinfilter
  const W = require(wmod);
  const ws = [{ domein: 'karwei.nl', aan: true, lezen: 'browser', categorie: ['bouw'] }, { domein: 'gamma.nl', aan: false, lezen: 'browser', categorie: ['bouw'] },
    { domein: 'hornbach.nl', aan: true, lezen: 'script', categorie: ['bouw'] }];
  toets('4a zonder browserroute alleen script-winkels', JSON.stringify(W.domeinenVoor(ws, 'bouw')) === '["hornbach.nl"]', W.domeinenVoor(ws, 'bouw'));
  toets('4b met browserroute ook browserwinkels die aan staan', JSON.stringify(W.domeinenVoor(ws, 'bouw', true)) === '["karwei.nl","hornbach.nl"]', W.domeinenVoor(ws, 'bouw', true));
  console.log('JS ' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
JS
JSUIT=$?

# ── 5. review ronde 2: bewaking met een echte Chromium (alleen als die er is; in CI zonder browser overgeslagen) ──
node - "$PWD/winkel-browser.js" <<'JS'
const http = require('http'), path = require('path');
const WB = require(process.argv[2]);
const exe = WB.chromiumPad();
let pw = null;
try { pw = require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core'); } catch (e) { pw = null; }
if (!exe || !pw) { console.log('OVERGESLAGEN 5 (geen Chromium of Playwright op deze machine)'); process.exit(0); }
let goed = 0, fout = 0;
const toets = (n, ok, x) => { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (ok || x === undefined ? '' : '  [' + JSON.stringify(x).slice(0, 300) + ']')); };
const zag = [];
const srv = http.createServer((q, r) => { zag.push(q.url);
  if (q.url === '/a') { r.writeHead(302, { Location: '/verboden' }); return r.end(); }
  if (q.url === '/p') return r.end('<html><head><title>Proef</title></head><body><img src="/beeld.png"><iframe src="/kader"></iframe><p>proef</p>'
    + '<script>try { window.open("/popup1"); } catch (e) {} setTimeout(function () { try { window.open("/popup2"); } catch (e) {} }, 50);</script></body></html>');
  r.end('x'); });
(async () => {
  await new Promise((k) => srv.listen(0, '127.0.0.1', k));
  const basis = 'http://127.0.0.1:' + srv.address().port;
  const b = await pw.chromium.launch({ executablePath: exe, headless: true });
  try {
    for (const [doel, naam] of [[basis + '/p', 'gevraagde pagina']]) {
      const ctx = await b.newContext(); const page = await ctx.newPage(); await WB.bewaak(ctx, page, doel);
      const r = await page.goto(doel).catch((e) => null);
      await page.waitForTimeout(800);
      toets('5a ' + naam + ' laadt, beeld niet opgehaald', r && r.status() === 200 && zag.indexOf('/beeld.png') < 0, zag);
      toets('5d review ronde 3: geen iframe en geen pop-up opgehaald', ['/kader', '/popup1', '/popup2'].every((u) => zag.indexOf(u) < 0), zag);
      const n = await page.goto(basis + '/ander').then(() => 'geladen', (e) => 'geweigerd');
      toets('5b andere pagina in het hoofdframe geweigerd', n === 'geweigerd' && zag.indexOf('/ander') < 0, { n, zag });
      await ctx.close();
    }
    const ctx = await b.newContext(); const page = await ctx.newPage(); await WB.bewaak(ctx, page, basis + '/a');
    const n = await page.goto(basis + '/a').then(() => 'geladen', (e) => 'geweigerd');
    toets('5c doorsturen (302) naar een ander pad op dezelfde host: niet opgehaald', n === 'geweigerd' && zag.indexOf('/a') >= 0 && zag.indexOf('/verboden') < 0, { n, zag });
    await ctx.close();
  } finally { await b.close(); srv.close(); }
  console.log('BROWSER ' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})();
JS
BRUIT=$?
[ "$PYUIT" = 0 ] && [ "$JSUIT" = 0 ] && [ "$BRUIT" = 0 ] && echo "winkel-browser: alles groen" || { echo "winkel-browser: ROOD"; exit 1; }
