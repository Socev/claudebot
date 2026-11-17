#!/usr/bin/env bash
# Toetst de vaste ophaalroute (ophalen.js, wv3254, 17-11-2026). Geen externe site: een lokale proefserver met verzonnen pagina's en een
# zelfgemaakte pdf, via een verzonnen naam (proef.socev.test) die alleen de toets op 127.0.0.1 zet.
#  1. url-toets: alleen http(s) op de standaardpoort, geen ip-adres, interne naam of inlog
#  2. proxy los: ip-adres, intern adres (DNS), andere poort, upgrade → 403; openbaar adres door (nep-DNS)
#  3. kale omgeving in het kind (nep-kind geeft zijn omgeving terug)
#  4. met een echte Chromium (anders overgeslagen; EIS_BROWSER=1 maakt dat rood): pagina → markdown zonder script/menu + pdf-link
#     gedownload met tekst; url die zelf een pdf is; "pdf"-link die html geeft niet bewaard; doorsturen naar 127.0.0.1/localhost en een
#     intern plaatje komen nooit aan; cache (geen tweede bezoek); tempo per site; tijdsgrens (procesboom weg); slot bezet → druk
#  5. CLI: weigering met exit 1, --help exit 0
# Kruisproef: OPHALEN_JS=<kopie zonder adresgrens> bash test/ophalen.sh  → 2 en 4 rood.
set -u
cd "$(dirname "$0")/.." || exit 1
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
OPHALEN_JS="${OPHALEN_JS:-$PWD/ophalen.js}" T="$T" node - <<'JS'
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), { execFileSync, spawnSync } = require('child_process');
const M = require(process.env.OPHALEN_JS);
const T = process.env.T;
let goed = 0, fout = 0, over = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (ok || extra === undefined ? '' : '  [' + JSON.stringify(extra).slice(0, 400) + ']')); }
const slaap = (ms) => new Promise((k) => setTimeout(k, ms));

// minimale geldige pdf met één regel tekst (verzonnen)
function maakPdf(tekst) {
  const stroom = 'BT /F1 18 Tf 72 720 Td (' + tekst + ') Tj ET';
  const obj = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stroom.length + ' >>\nstream\n' + stroom + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let s = '%PDF-1.4\n'; const off = [];
  obj.forEach((o, i) => { off.push(s.length); s += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const x = s.length;
  s += 'xref\n0 ' + (obj.length + 1) + '\n0000000000 65535 f \n' + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  s += 'trailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
  return Buffer.from(s, 'latin1');
}

(async function () {
  // ── 1. url-toets ──
  for (const [u, ok, naam] of [['https://richtlijnen.proef-nhg.nl/x', true, 'https'], ['http://puc.proef.nl/nza', true, 'http'],
    ['ftp://proef.nl/a', false, 'ftp'], ['file:///etc/passwd', false, 'file'], ['https://127.0.0.1/', false, 'ip-adres'],
    ['http://2130706433/', false, 'ip als getal'], ['http://[::1]/', false, 'IPv6'], ['http://localhost/', false, 'localhost'],
    ['https://proef.nl:8443/', false, 'andere poort'], ['https://a:b@proef.nl/', false, 'inlog in url'], ['javascript:alert(1)', false, 'javascript'],
    ['https://metadata.google.internal/', true, 'interne naam met punt (DNS beslist)']]) {
    const r = M.toetsUrl(u);
    toets('1 url ' + naam + (ok ? ' mag' : ' geweigerd'), r.ok === ok, r);
  }

  // ── 2. proxy los ──
  const doel = http.createServer((q, s) => { s.end('GEHEIM-INTERN'); });
  await new Promise((k) => doel.listen(0, '127.0.0.1', k));
  const DP = doel.address().port;
  const nepDns = (h, k) => k(null, [{ address: h === 'openbaar.proef.nl' ? '93.184.216.34' : h === 'binnen.proef.nl' ? '10.1.2.3' : '127.0.0.1', family: 4 }]);
  const px = M.maakProxy({ opzoek: nepDns, proef: { 'lokaal.proef.test': { ip: '127.0.0.1', poort: DP } } });
  await new Promise((k) => px.srv.listen(0, '127.0.0.1', k));
  const PP = px.srv.address().port;
  function viaProxy(regel) {
    return new Promise((k) => {
      const s = net.connect(PP, '127.0.0.1', () => s.write(regel));
      let b = ''; s.on('data', (d) => { b += d; if (/\r\n\r\n/.test(b)) { s.destroy(); } }); s.on('close', () => k(b.split('\r\n')[0])); s.on('error', () => k('fout'));
      setTimeout(() => { s.destroy(); }, 3000);
    });
  }
  toets('2a http naar 127.0.0.1 (poort 80) → 403', /403/.test(await viaProxy('GET http://127.0.0.1/ HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2a2 http naar 127.0.0.1 op een andere poort → 403', /403/.test(await viaProxy('GET http://127.0.0.1:' + DP + '/ HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2b http naar localhost (DNS 127.0.0.1) → 403', /403/.test(await viaProxy('GET http://localhost.proef.nl/ HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2c http naar naam met intern adres (10.x) → 403', /403/.test(await viaProxy('GET http://binnen.proef.nl/ HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2d http andere poort → 403', /403/.test(await viaProxy('GET http://openbaar.proef.nl:8080/ HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2e CONNECT naar intern adres → 403', /403/.test(await viaProxy('CONNECT binnen.proef.nl:443 HTTP/1.1\r\nHost: binnen.proef.nl:443\r\n\r\n')));
  toets('2f CONNECT naar poort 22 → 403', /403/.test(await viaProxy('CONNECT openbaar.proef.nl:22 HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2g CONNECT naar ip-adres → 403', /403/.test(await viaProxy('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: x\r\n\r\n')));
  toets('2h websocket-upgrade over http → 403', /403/.test(await viaProxy('GET http://lokaal.proef.test/ HTTP/1.1\r\nHost: lokaal.proef.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')));
  toets('2i proefnaam (alleen toets) op poort 80 → door', /200/.test(await viaProxy('GET http://lokaal.proef.test/ HTTP/1.1\r\nHost: lokaal.proef.test\r\n\r\n')));
  px.srv.close(); doel.close();

  // ── 3. kale omgeving in het kind ──
  const nepKind = path.join(T, 'nep-kind.js');
  fs.writeFileSync(nepKind, "const fs=require('fs');fs.writeFileSync(process.argv[4],JSON.stringify({fout:'OMGEVING '+Object.keys(process.env).sort().join(',')}));\n");
  process.env.SOCEV_PROEF_GEHEIM = 'verzonnen-geheim';
  const kaal = await M.maak({ staat: path.join(T, 's3'), downloads: path.join(T, 'd3'), kindScript: nepKind, motor: '/bestaat-niet', exe: '/bin/true',
    proef: { 'kaal.proef.test': { ip: '127.0.0.1', poort: 9 } }, tempoMs: 0 }).haal('http://kaal.proef.test/', { geenCache: true });
  const sleutels = String(kaal.fout || '').replace('OMGEVING ', '').split(',');
  toets('3 kind: kale omgeving (geen geheim, alleen PATH/HOME/TMPDIR/LANG)', !sleutels.includes('SOCEV_PROEF_GEHEIM') && sleutels.every((k) => ['PATH', 'HOME', 'TMPDIR', 'LANG', 'BROWSER_HEADLESS'].includes(k)), kaal);

  // ── 4. echte Chromium ──
  const info = M.maak({ staat: path.join(T, 'si'), downloads: path.join(T, 'di') }).info();
  if (!info.aan) {
    if (process.env.EIS_BROWSER === '1') toets('4 browser aanwezig (EIS_BROWSER)', false, info);
    else { console.log('OVER  4 geen browsermotor/Chromium op deze machine'); over++; }
  } else {
    const PDF = maakPdf('Proefpdf tariefbeschikking 2027');
    const hits = {}; const tijden = {}; const groot = { bytes: 0, af: false };
    const srv = http.createServer((q, s) => {
      const p = q.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      hits[p] = (hits[p] || 0) + 1; (tijden[p] = tijden[p] || []).push(Date.now());
      if (p === '/pagina') { s.setHeader('content-type', 'text/html; charset=utf-8'); return s.end('<html><head><title>Proefrichtlijn Hoofdpijn</title><script>var x="GEHEIM_SCRIPT";</script></head><body>'
        + '<nav>MENU_RUIS</nav><main><h1>Proefrichtlijn Hoofdpijn</h1><p>Dit is verzonnen proeftekst voor de ophaalroute, lang genoeg om als hoofdtekst te tellen. '
        + 'Nog een zin met <strong>vet</strong> en een tweede alinea die het geheel ruim boven de tweehonderd tekens brengt zodat main gekozen wordt.</p>'
        + '<p><a href="/stuk.pdf">Download het stuk (pdf)</a> · <a href="/nep.pdf">kapotte pdf</a> · <a href="/andere">gewone link</a></p>'
        + '<img src="http://127.0.0.1:' + srv.address().port + '/geheim-img"></main><footer>VOET_RUIS</footer></body></html>'); }
      if (p === '/stuk.pdf') { s.setHeader('content-type', 'application/pdf'); return s.end(PDF); }
      if (p === '/nep.pdf') { s.setHeader('content-type', 'text/html'); return s.end('<html><body>geen pdf</body></html>'); }
      if (p === '/door1') { s.writeHead(302, { location: 'http://127.0.0.1:' + srv.address().port + '/geheim' }); return s.end(); }
      if (p === '/door2') { s.writeHead(302, { location: 'http://localhost:' + srv.address().port + '/geheim' }); return s.end(); }
      if (p === '/traag') return; // antwoordt nooit
      if (p === '/auto') { s.setHeader('content-type', 'text/html'); return s.end('<html><head><title>Auto</title></head><body><main><p>' + 'pagina die zelf een download start '.repeat(10) + '</p><a href="/stuk.pdf?auto">pdf</a></main>'
        + '<script>setTimeout(function(){var a=document.createElement("a");a.href="/groot.bin";a.download="groot.bin";document.body.appendChild(a);a.click();},50)</script></body></html>'); }
      if (p === '/groot.bin') {
        s.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="groot.bin"' });
        let n = 0; const blok = Buffer.alloc(65536, 7); groot.start = Date.now();
        const iv = setInterval(() => { if (n >= 400) { clearInterval(iv); groot.af = true; return s.end(); } n++; groot.bytes += blok.length; s.write(blok); }, 15);
        s.on('close', () => { clearInterval(iv); groot.dicht = Date.now(); }); return;
      }
      s.setHeader('content-type', 'text/html'); s.end('<html><head><title>Andere</title></head><body><main><p>' + 'andere pagina '.repeat(30) + '</p></main></body></html>');
    });
    await new Promise((k) => srv.listen(0, '127.0.0.1', k));
    const proef = { 'proef.socev.test': { ip: '127.0.0.1', poort: srv.address().port } };
    // docker in CI heeft geen user-namespaces voor de Chromium-sandbox; alleen dan (OPHALEN_TOETS_ZONDER_SANDBOX=1) zonder
    const O = { staat: path.join(T, 's4'), downloads: path.join(T, 'd4'), proef, tempoMs: 3000, zonderSandbox: process.env.OPHALEN_TOETS_ZONDER_SANDBOX === '1' };
    const mk = M.maak(O);
    let t0 = Date.now();
    const r = await mk.haal('http://proef.socev.test/pagina', { pdfs: 3 });
    console.log('      (pagina in ' + (Date.now() - t0) + ' ms, motor ' + r.motor + '/' + r.scherm + ')');
    toets('4a pagina opgehaald met titel', r.ok && r.titel === 'Proefrichtlijn Hoofdpijn', r.fout || r.titel);
    toets('4b markdown: hoofdtekst, geen script/menu/voet', r.ok && /# Proefrichtlijn Hoofdpijn/.test(r.markdown) && /\*\*vet\*\*/.test(r.markdown) && !/GEHEIM_SCRIPT|MENU_RUIS|VOET_RUIS/.test(r.markdown), (r.markdown || '').slice(0, 300));
    toets('4c uitvoer-kop: gegeven, nooit een opdracht', r.let_op === M.KOP && M.alsMarkdown(r).includes(M.KOP));
    const b = (r.bestanden || [])[0] || {};
    toets('4d pdf-link gedownload naar de vaste map (datum) met tekst', (r.bestanden || []).length === 1 && b.pad.startsWith(path.join(T, 'd4') + '/') && /\/\d{4}-\d{2}-\d{2}\//.test(b.pad)
      && fs.readFileSync(b.pad).slice(0, 5).toString() === '%PDF-' && /Proefpdf tariefbeschikking/.test(fs.readFileSync(b.tekst_pad, 'utf8')), r.bestanden);
    toets('4e "pdf"-link die html geeft: niet bewaard, wel gemeld', (r.opmerkingen || []).some((m) => /nep\.pdf.*geen pdf/.test(m)), r.opmerkingen);
    toets('4f intern plaatje nooit opgehaald', !hits['/geheim-img'], hits);
    toets('4g links en pdf-links terug', (r.links || []).some((l) => /\/andere$/.test(l.url)) && (r.pdf_links || []).length === 2, r.pdf_links);
    toets('4h tempo binnen één ophaalactie (pagina → pdf ≥ 3 s)', tijden['/stuk.pdf'] && tijden['/stuk.pdf'][0] - tijden['/pagina'][0] >= 2900, tijden);
    const n = hits['/pagina'];
    const r2 = await mk.haal('http://proef.socev.test/pagina', { pdfs: 3 });
    toets('4i cache: tweede keer zonder bezoek', r2.ok && r2.uit_cache === true && hits['/pagina'] === n, { n, nu: hits['/pagina'] });
    t0 = Date.now();
    const r3 = await mk.haal('http://proef.socev.test/stuk.pdf', { geenCache: true });
    toets('4j url die zelf een pdf is → bestand + tekst als markdown', r3.ok && r3.soort === 'pdf' && /Proefpdf tariefbeschikking/.test(r3.markdown) && r3.bestanden.length === 1, r3.fout || r3.soort);
    toets('4k tempo tussen twee ophaalacties (≥ 3 s na het vorige bezoek)', tijden['/stuk.pdf'][1] - tijden['/nep.pdf'][0] >= 2900, tijden);
    const r4 = await mk.haal('http://proef.socev.test/door1', { geenCache: true });
    const r5 = await mk.haal('http://proef.socev.test/door2', { geenCache: true });
    toets('4l doorsturen naar 127.0.0.1 en localhost komt nooit aan', !hits['/geheim'] && hits['/door1'] === 1 && hits['/door2'] === 1, { hits, r4: r4.fout || r4.markdown, r5: r5.fout || r5.markdown });
    const rA = await mk.haal('http://proef.socev.test/auto', { pdfs: 1, geenCache: true });
    await slaap(1500);
    const inD4 = (function tel(d) { let n = 0; try { for (const f of fs.readdirSync(d)) { const q = path.join(d, f); n += fs.statSync(q).isDirectory() ? tel(q) : (/groot/.test(f) ? 1 : 0); } } catch (e) { /* leeg */ } return n; })(path.join(T, 'd4'));
    toets('4q download die de pagina zelf start: binnen 1,5 s afgebroken, niets bewaard (wel de gevraagde pdf)', rA.ok && rA.bestanden.length === 1 && !groot.af && groot.dicht - groot.start < 1500 && inD4 === 0, { ok: rA.ok, fout: rA.fout, groot, inD4, hit: hits['/groot.bin'] });
    // tijdsgrens
    const mkT = M.maak(Object.assign({}, O, { staat: path.join(T, 's5'), kindMs: 4000, tempoMs: 0 }));
    t0 = Date.now();
    const r6 = await mkT.haal('http://proef.socev.test/traag', { pdfs: 0, geenCache: true });
    const duur = Date.now() - t0;
    await slaap(500);
    const wezen = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).filter((x) => { try { return fs.readFileSync('/proc/' + x + '/environ').includes('TMPDIR=' + require('os').tmpdir() + '/ophalen-') && fs.readFileSync('/proc/' + x + '/cmdline').includes('ophalen'); } catch (e) { return false; } });
    toets('4m tijdsgrens: fout binnen 4 s + 10 s marge, geen kind meer', !r6.ok && /op tijd|harde grens/.test(r6.fout) && duur < 16000 && wezen.length === 0, { fout: r6.fout, duur, wezen });
    // slot bezet → druk
    const sDruk = path.join(T, 's6');
    fs.mkdirSync(path.join(sDruk, 'slots', '0'), { recursive: true }); fs.writeFileSync(path.join(sDruk, 'slots', '0', 'pid'), String(process.pid));
    const r7 = await M.maak(Object.assign({}, O, { staat: sDruk, tegelijk: 1, wachtSlotMs: 600 })).haal('http://proef.socev.test/andere', { geenCache: true });
    toets('4n slot bezet → "druk", geen bezoek', !r7.ok && /druk/.test(r7.fout) && !hits['/andere'], r7);
    // PUC-site-regel: alleen op puc.overheid.nl de knop "Download PDF" (maak → downloadlink) — hier met een verzonnen nabootsing
    const puc = http.createServer((q, s2) => {
      const p = q.url.replace(/^https?:\/\/[^/]+/, '');
      hits['puc' + p.split('?')[0]] = (hits['puc' + p.split('?')[0]] || 0) + 1;
      if (p.startsWith('/nza/doc/')) { s2.setHeader('content-type', 'text/html'); return s2.end('<html><head><title>Proefbesluit</title><script>function DownloadManifestatie(i,k,s){setTimeout(function(){document.querySelector(".DownloadManifestatiepdf").setAttribute("href","/PUC/Handlers/ManifestatieService.ashx?actie=download&identifier="+i)},1500)}</script></head>'
        + '<body><main><p>' + 'verzonnen besluittekst '.repeat(20) + '</p><a class="DownloadManifestatiepdf" href="#" onclick="DownloadManifestatie(\'PUC_1_22_1\', \'nza\', \'pdf\');return false;">Download PDF</a></main></body></html>'); }
      if (p.startsWith('/PUC/Handlers/ManifestatieService.ashx?actie=download')) { s2.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="proef.pdf"' }); return s2.end(PDF); }
      s2.writeHead(404); s2.end();
    });
    await new Promise((k) => puc.listen(0, '127.0.0.1', k));
    const rP = await M.maak(Object.assign({}, O, { staat: path.join(T, 's7'), proef: { 'puc.overheid.nl': { ip: '127.0.0.1', poort: puc.address().port } }, tempoMs: 0 })).haal('http://puc.overheid.nl/nza/doc/PUC_1_22/1', { pdfs: 1 });
    toets('4o PUC: pdf-knop → downloadlink → pdf met tekst', rP.ok && rP.bestanden.length === 1 && /Proefpdf/.test(fs.readFileSync(rP.bestanden[0].tekst_pad, 'utf8')), rP.fout || rP.opmerkingen);
    const vorig = hits['puc/PUC/Handlers/ManifestatieService.ashx'] || 0;
    const rQ = await M.maak(Object.assign({}, O, { staat: path.join(T, 's8'), proef: { 'puc.overheid.nl': { ip: '127.0.0.1', poort: puc.address().port } }, tempoMs: 0 })).haal('http://puc.overheid.nl/nza/doc/PUC_1_22/1', { pdfs: 0, geenCache: true });
    toets('4p PUC met pdfs 0: knop niet ingedrukt', rQ.ok && rQ.bestanden.length === 0 && (hits['puc/PUC/Handlers/ManifestatieService.ashx'] || 0) === vorig, { b: rQ.bestanden, hits });
    puc.close();
    srv.close();
  }

  // ── 5. CLI ──
  const c1 = spawnSync(process.execPath, [process.env.OPHALEN_JS, 'file:///etc/passwd'], { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: T }) });
  toets('5a CLI weigert file:// met exit 1', c1.status === 1 && /alleen http/.test(c1.stderr + c1.stdout), { st: c1.status, e: c1.stderr });
  const c2 = spawnSync(process.execPath, [process.env.OPHALEN_JS, '--help'], { encoding: 'utf8' });
  toets('5b CLI --help exit 0', c2.status === 0 && /gebruik/.test(c2.stdout));

  console.log('\nophalen: ' + goed + ' groen, ' + fout + ' rood' + (over ? ', ' + over + ' overgeslagen' : ''));
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak af: ' + (e && e.stack || e)); process.exit(1); });
JS
