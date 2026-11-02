#!/usr/bin/env bash
# Toetst OVIS Shopper S3 (wv2264, 2-11-2026; favorieten wv2267 § 6): shopper.js (alleen type: shopper-zoektocht direct in de vaste Shopper-mappen, entiteit uit de map,
# geen symlink volgen, id = hash van het pad en nooit een pad uit de vraag, koop-link alleen https, totaal/advies uit de opties) en het
# server.js-blok (routes, audit zonder wens, Niet meer nodig = de enige schrijfactie, gekocht niet via de App, /health alleen aantallen + tijdstip,
# uitrol-lijst). Alleen verzonnen pagina's; raakt de echte vault niet. Gebruik: bash test/shopper.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" shopper.js; then echo "ROOD  shopper.js logt naar de console of gebruikt eval"; exit 1; fi
node - <<'JS'
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const S = require('./shopper.js'), VV = require('./vault-veilig.js');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'shopper-')), V = path.join(W, 'vault');
  const GH = path.join(V, '10_Zakelijk/Groenhouten/Shopper'), PR = path.join(V, '20_Prive/Shopper');
  fs.mkdirSync(GH, { recursive: true }); fs.mkdirSync(PR, { recursive: true });
  const pagina = (fm, lijf) => '---\n' + fm.join('\n') + '\n---\n' + (lijf || '');
  const opt = (id, x) => '  - {id: ' + id + ', winkel: "' + (x.w || 'Proefwinkel') + '", verkoper: "Verkoper, met komma", product: "Proefkast 180x90, 5 planken", koop_eenheid: "1 stuk", koop_aantal: ' + (x.n || 1)
    + ', prijs_eur: ' + x.p + ', verzending_eur: ' + x.v + ', totaal_eur: ' + x.t + ', levertijd: "morgen", voorraad: "op voorraad", url: "' + x.u + '", gelezen: "2026-11-02T10:00+01:00"}';
  fs.writeFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), pagina(['type: shopper-zoektocht', 'wens: "Twee proefkasten # geen commentaar"', 'entiteit: tolgaarde   # klopt niet met de map',
    'status: open            # open | gekocht | vervallen', 'gezocht: 2026-11-01T09:00+01:00', 'aantal: 2', 'eisen: ["180 cm, hoog", "metaal"]', 'aannames: ["bezorgen"]', 'opties:',
    opt('o1', { p: 46.95, v: 0, t: 46.95, u: 'https://www.proefwinkel.nl/p/kast/123/' }),
    opt('o2', { w: 'Bouwmarkt Nep', n: 2, p: 69.00, v: 'null', t: 'null', u: 'http://www.bouwmarktnep.nl/p/1' }),
    opt('o3', { p: 10, v: 5, t: 15, u: 'javascript:alert(1)' }),
    opt('o4', { p: 'ongeveer 20', v: 0, t: 20, u: 'https://gebruiker:geheim@nep.nl/p' }),
    opt('x9', { p: 1, v: 0, t: 1, u: 'https://ok.nl/p' }),
    'advies: o1'], '# Shopper — proefkasten\n\nAdvies: **o1**, op voorraad.\n\n| # | Winkel |\n|---|---|\n| o1 | Proefwinkel |\n\n## Waarom dit advies\nGoedkoopst met voorraad.\n\n## Aannames\nGeen maten.\n\n## Niet te lezen\n- Nepwinkel: 403.\n\n## Gerelateerd\n- x\n'));
  fs.writeFileSync(path.join(GH, 'Shopper - 2026-10-20 - Oud gekocht.md'), pagina(['type: shopper-zoektocht', 'wens: Oud gekocht', 'status: gekocht', 'gezocht: 2026-10-20T09:00+01:00', 'opties:', opt('o1', { p: 5, v: 0, t: 5, u: 'https://a.nl/p' }), 'advies: o1']));
  fs.writeFileSync(path.join(PR, 'Shopper - 2026-11-02 - Prive lamp.md'), pagina(['type: shopper-zoektocht', 'wens: "Proeflamp"', 'status: open', 'gezocht: 2026-11-02T08:00+01:00', 'aantal: 1', 'advies: o7']));
  fs.writeFileSync(path.join(PR, 'Shopper - 2026-10-01 - Vervallen.md'), pagina(['type: shopper-zoektocht', 'wens: "Vervallen ding"', 'status: vervallen', 'gezocht: 2026-10-01T08:00+01:00']));
  fs.writeFileSync(path.join(PR, 'Index.md'), pagina(['type: index', 'wens: "Geen zoektocht"']));
  fs.writeFileSync(path.join(PR, '.verborgen.md'), pagina(['type: shopper-zoektocht', 'wens: "Verborgen"']));
  fs.mkdirSync(path.join(PR, 'Sub')); fs.writeFileSync(path.join(PR, 'Sub', 'Diep.md'), pagina(['type: shopper-zoektocht', 'wens: "Diep"']));
  fs.mkdirSync(path.join(V, '10_Zakelijk/Geheim'), { recursive: true });
  fs.writeFileSync(path.join(V, '10_Zakelijk/Geheim/geheim.md'), pagina(['type: shopper-zoektocht', 'wens: "Zakelijk geheim"', 'status: open'], 'Vertrouwelijk.\n'));
  fs.symlinkSync(path.join(V, '10_Zakelijk/Geheim/geheim.md'), path.join(GH, 'Shopper - 2026-11-02 - Koppeling.md'));
  fs.mkdirSync(path.join(V, '10_Zakelijk/Onbekend/Shopper'), { recursive: true });
  fs.writeFileSync(path.join(V, '10_Zakelijk/Onbekend/Shopper/x.md'), pagina(['type: shopper-zoektocht', 'wens: "Buiten de vaste mappen"']));

  const m = S.maak({ vault: V, vv: VV });
  const L = m.lijst(), z = L.body.zoektochten, op = (w) => z.find((x) => x.wens === w);
  // ── 1. welke pagina's ──
  toets('1a alleen type: shopper-zoektocht direct in de vaste mappen (geen Index, verborgen, submap of andere map)', L.status === 200 && z.length === 4
    && !op('Diep') && !op('Verborgen') && !op('Geen zoektocht') && !op('Buiten de vaste mappen'), z.map((x) => x.wens));
  toets('1b symlink niet gevolgd: niet in de lijst, onleesbaar geteld, geen tekst van buiten', !JSON.stringify(L).includes('Zakelijk geheim') && m.info().onleesbaar === 1, m.info());
  toets('1c volgorde: open eerst (Groenhouten vóór Privé), dan afgerond (Groenhouten vóór Privé)', JSON.stringify(z.map((x) => x.wens)) === JSON.stringify(['Twee proefkasten # geen commentaar', 'Proeflamp', 'Oud gekocht', 'Vervallen ding']), z.map((x) => x.wens));
  const k = op('Twee proefkasten # geen commentaar');
  toets('1d entiteit uit de map (niet uit de pagina); status zonder commentaar; # binnen aanhalingstekens blijft', k && k.entiteit === 'groenhouten' && k.entiteit_naam === 'Groenhouten' && k.status === 'open', k);
  toets('1e lijst: advies-totaal, winkel, aantal opties (o1..o4; x9 geen geldige id), geen opties of pad in de lijst', k.advies === 'o1' && k.advies_totaal === 46.95 && k.advies_winkel === 'Proefwinkel' && k.opties_aantal === 4
    && !('opties' in k) && !('_opties' in k) && !('pad' in k) && !JSON.stringify(L).includes('10_Zakelijk/'), k);
  toets('1f advies naar een optie die niet bestaat = geen advies', op('Proeflamp').advies === null && op('Proeflamp').advies_totaal === null && op('Proeflamp').entiteit === 'prive');
  toets('1g entiteitenlijst in vaste volgorde', JSON.stringify(L.body.entiteiten.map((e) => e.id)) === JSON.stringify(['groenhouten', 'tolgaarde', 'pot', 'holding', 'praktijkhouders', 'prive']));
  // ── 2. één zoektocht ──
  const d = m.zoektocht(k.id), zt = d.body.zoektocht;
  toets('2a zoektocht op id: opties, eisen (komma binnen aanhalingstekens), aannames, inleiding, waarom, niet te lezen, pad', d.status === 200 && zt.opties.length === 4
    && JSON.stringify(zt.eisen) === JSON.stringify(['180 cm, hoog', 'metaal']) && zt.aannames[0] === 'bezorgen' && /Advies: \*\*o1\*\*/.test(zt.inleiding) && !/\|/.test(zt.inleiding)
    && zt.waarom === 'Goedkoopst met voorraad.' && /Nepwinkel: 403/.test(zt.niet_te_lezen) && !/Gerelateerd/.test(zt.niet_te_lezen) && zt.pad === '10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-01 - Proefkasten.md', zt);
  const o = (id) => zt.opties.find((x) => x.id === id);
  toets('2b https-link blijft (knop)', o('o1').url === 'https://www.proefwinkel.nl/p/kast/123/' && o('o1').url_geweigerd === false);
  toets('2c http-, javascript- en link met inloggegevens = url null (geen knop), url_geweigerd', o('o2').url === null && o('o3').url === null && o('o4').url === null && o('o2').url_geweigerd && o('o3').url_geweigerd && o('o4').url_geweigerd);
  toets('2d bedragen: null = null, geen getal = null; komma in de verkoper blijft', o('o2').totaal_eur === null && o('o2').verzending_eur === null && o('o2').prijs_eur === 69 && o('o2').koop_aantal === 2
    && o('o4').prijs_eur === null && o('o1').verkoper === 'Verkoper, met komma', [o('o2'), o('o4')]);
  toets('2e koopUrl los', S.koopUrl('https://bol.com/nl/p/x/') === 'https://bol.com/nl/p/x/' && S.koopUrl('https://localhost/x') === null && S.koopUrl('https://a.nl/x y') === null && S.koopUrl('data:text/html,x') === null && S.koopUrl('') === null);
  const slecht = ['../10_Zakelijk/Geheim/geheim.md', zt.pad, k.id + '0', k.id.toUpperCase(), '', null, { id: k.id }];
  toets('2f pad-achtige of verkeerde id = 400', slecht.every((x) => m.zoektocht(x).status === 400), slecht.map((x) => m.zoektocht(x).status));
  toets('2g onbekende id = 404; symlink-pagina en niet-zoektocht op id = 404', m.zoektocht('0123456789ab').status === 404 && m.zoektocht(S.idVan('10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-02 - Koppeling.md')).status === 404
    && m.zoektocht(S.idVan('20_Prive/Shopper/Index.md')).status === 404);
  toets('2h id = 12 hex van sha256(pad)', k.id === S.idVan(zt.pad) && /^[0-9a-f]{12}$/.test(k.id));
  // ── 3. Niet meer nodig ──
  const voor = fs.readFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8');
  toets('3a alleen {status: "vervallen"}; gekocht, open of extra velden = 400, niets geschreven', [{ status: 'gekocht' }, { status: 'open' }, {}, null, { status: 'vervallen', x: 1 }].every((x) => m.status(k.id, x).status === 400)
    && fs.readFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8') === voor);
  toets('3b gekocht → vervallen geweigerd (409), pagina ongemoeid', m.status(op('Oud gekocht').id, { status: 'vervallen' }).status === 409 && /status: gekocht/.test(fs.readFileSync(path.join(GH, 'Shopper - 2026-10-20 - Oud gekocht.md'), 'utf8')));
  const r3 = m.status(k.id, { status: 'vervallen' }), na = fs.readFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8');
  toets('3c open → vervallen: 200, alleen de statusregel anders (rest byte-gelijk)', r3.status === 200 && na === voor.replace('status: open            # open | gekocht | vervallen', 'status: vervallen'), [r3, na.slice(0, 200)]);
  toets('3d nog eens = 200 al, niets geschreven; lijst toont vervallen', m.status(k.id, { status: 'vervallen' }).body.al === true && fs.readFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8') === na
    && m.lijst().body.zoektochten.find((x) => x.id === k.id).status === 'vervallen');
  toets('3e status op een symlink-pagina of pad = 404/400', m.status(S.idVan('10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-02 - Koppeling.md'), { status: 'vervallen' }).status === 404
    && m.status('../x', { status: 'vervallen' }).status === 400 && /status: open/.test(fs.readFileSync(path.join(V, '10_Zakelijk/Geheim/geheim.md'), 'utf8')));
  toets('3f pagina zonder statusregel krijgt er een', (function () { const id = S.idVan('20_Prive/Shopper/Shopper - 2026-11-02 - Prive lamp.md'); fs.writeFileSync(path.join(PR, 'Shopper - 2026-11-02 - Prive lamp.md'), pagina(['type: shopper-zoektocht', 'wens: "Proeflamp"']));
    return m.status(id, { status: 'vervallen' }).status === 200 && /\nstatus: vervallen\n---/.test(fs.readFileSync(path.join(PR, 'Shopper - 2026-11-02 - Prive lamp.md'), 'utf8')); })());
  const i = m.info();
  toets('4 info: alleen aantallen en tijdstip (geen wens of pad)', i.aan === true && i.zoektochten === 4 && Object.keys(i).sort().join() === 'aan,favorieten,onleesbaar,op,open,zoektochten' && i.favorieten === 0, i);

  // ── 6. favorieten (wv2267) ──
  const FV = path.join(V, '00_Systeem'); fs.mkdirSync(FV, { recursive: true });
  const favPad = path.join(V, S.FAVORIETEN);
  const favPagina = (regels, type) => '---\ntype: ' + (type || 'shopper-favorieten') + '\n# commentaar bovenaan\nwinkels:\n' + regels.join('\n') + '\nupdated: 2026-11-02\n---\n# lijf\n';
  fs.writeFileSync(favPad, favPagina(['  - {domein: proefwinkel.nl, naam: "Proef, winkel", aan: true}', '  # voorstel', '  - {domein: "https://www.bouwmarktnep.nl/", aan: true}',
    '  - {domein: ok.nl, aan: false}', '  - {domein: "kapot domein", aan: true}', '  - {domein: a.nl, aan: "true"}', '  -', '    domein: nep.nl', '    aan: true']));
  const fv = S.favorietenVan(fs.readFileSync(favPad, 'utf8'));
  toets('6a favorietenVan: alleen aan, www/https/pad weg, kapot domein weg, blokvorm telt', JSON.stringify(fv) === JSON.stringify(['proefwinkel.nl', 'bouwmarktnep.nl', 'a.nl', 'nep.nl']), fv);
  toets('6b isFavoriet: zelfde host of subdomein; geen look-alike, geen null', S.isFavoriet('https://www.proefwinkel.nl/p/1', fv) && S.isFavoriet('https://proefwinkel.nl/x', fv)
    && !S.isFavoriet('https://proefwinkel.nl.evil.com/x', fv) && !S.isFavoriet('https://nepproefwinkel.nl/x', fv) && !S.isFavoriet(null, fv) && !S.isFavoriet('https://ok.nl/p', fv));
  const GH3 = path.join(V, '10_Zakelijk/Tolgaarde/Shopper'); fs.mkdirSync(GH3, { recursive: true });
  fs.writeFileSync(path.join(GH3, 'Shopper - 2026-11-02 - Fav.md'), pagina(['type: shopper-zoektocht', 'wens: "Favproef"', 'status: open', 'gezocht: 2026-11-02T08:00+01:00', 'opties:',
    opt('o1', { p: 10, v: 0, t: 10, u: 'https://www.proefwinkel.nl/p/1' }), opt('o2', { w: 'Andere', p: 9, v: 0, t: 9, u: 'https://ok.nl/p' }),
    opt('o3', { p: 8, v: 0, t: 8, u: 'http://www.bouwmarktnep.nl/p' }), 'advies: o1']));
  const m6 = S.maak({ vault: V, vv: VV }), l6 = m6.lijst().body.zoektochten.find((x) => x.wens === 'Favproef');
  const z6 = m6.zoektocht(l6.id).body.zoektocht, o6 = (id) => z6.opties.find((x) => x.id === id);
  toets('6c optie op een favoriet domein = favoriet; ander domein of geweigerde (http) link = niet', o6('o1').favoriet === true && o6('o2').favoriet === false && o6('o3').favoriet === false, z6.opties);
  toets('6d lijst: advies_favoriet en favorieten_aantal; info telt de favorieten', l6.advies_favoriet === true && l6.favorieten_aantal === 1 && m6.info().favorieten === 4, [l6, m6.info()]);
  fs.writeFileSync(favPad, favPagina(['  - {domein: proefwinkel.nl, aan: true}'], 'index'));
  toets('6e verkeerd type = geen favorieten', S.maak({ vault: V, vv: VV }).zoektocht(l6.id).body.zoektocht.opties.every((x) => x.favoriet === false));
  fs.rmSync(favPad); fs.writeFileSync(path.join(V, '10_Zakelijk/Geheim/fav.md'), favPagina(['  - {domein: proefwinkel.nl, aan: true}'])); fs.symlinkSync(path.join(V, '10_Zakelijk/Geheim/fav.md'), favPad);
  const m7 = S.maak({ vault: V, vv: VV });
  toets('6f favorietenpagina als symlink: niet gevolgd, geen favorieten, geen fout', m7.zoektocht(l6.id).body.zoektocht.opties.every((x) => x.favoriet === false) && m7.lijst().status === 200 && m7.info().favorieten === 0);
  fs.rmSync(favPad);
  toets('6g geen favorietenpagina = niets favoriet, lijst werkt', S.maak({ vault: V, vv: VV }).lijst().body.zoektochten.every((x) => x.favorieten_aantal === 0));

  // ── 5. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('5a dispatch /app/shopper achter de app-sessie (naast Tripper)', src.indexOf("if (route === 'GET /app/shopper' || route.indexOf('GET /app/shopper/') === 0 || route.indexOf('POST /app/shopper/') === 0) return typeof appShopper === 'function' ? appShopper(req, res, a, route, d) : appWeiger(res, 404, 'onbekend', 'shopper');") > src.indexOf("appTripper(req, res, a, route) : appWeiger"));
  toets('5b /health.shopper', /shopper: typeof shopperInfo === 'function' \? shopperInfo\(\) : \{ aan: false \}/.test(src));
  toets('5c uitrol-lijst: shopper.js én reizen.js optioneel', /RELEASE_OPTIONEEL="[^"]*\bshopper\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /RELEASE_OPTIONEEL="[^"]*\breizen\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  const hb = src.indexOf('// ── OVIS Shopper (wv2264'), he = src.indexOf('// ── einde OVIS Shopper ──');
  toets('5d blokmarkers', hb > 0 && he > hb);
  // nieuwe vault voor de routes (de proefpagina is in § 3 al vervallen)
  const V2 = path.join(W, 'vault2'), GH2 = path.join(V2, '10_Zakelijk/Groenhouten/Shopper');
  fs.mkdirSync(GH2, { recursive: true });
  fs.writeFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), voor);
  const gestuurd = [], fl = [];
  const ctx = vm.createContext({ require, __dirname: process.cwd(), path, fs, VAULT: V2, VV: () => VV, appStaat: { tellers: {} },
    logError: (l, e) => fl.push(l + ' ' + (e && e.message)), appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__sh = { appShopper, shopperInfo, shopper };', ctx, { filename: 'server.js#shopper' });
  const vraag = async (route, d) => { const res = { _app: {} }; const n = gestuurd.length; await ctx.__sh.appShopper({}, res, { soort: 'meereizend' }, route, d); return Object.assign({ app: res._app }, gestuurd[n]); };
  let r = await vraag('GET /app/shopper');
  const id2 = r.j && r.j.zoektochten[0] && r.j.zoektochten[0].id;
  toets('5e lijst 200, stil', r.s === 200 && r.j.zoektochten.length === 1 && r.app.stil === true, [r.s, r.app]);
  r = await vraag('GET /app/shopper/' + id2);
  toets('5f zoektocht 200, reden met id zonder wens of pad', r.s === 200 && r.app.reden === 'shopper zoektocht ' + id2 + ' 200' && r.j.zoektocht.opties.length === 4, r.app);
  r = await vraag('GET /app/shopper/..%2F10_Zakelijk%2Fgeheim.md');
  toets('5g pad als id: 400, reden "ongeldig"', r.s === 400 && r.app.reden === 'shopper zoektocht ongeldig 400', r.app);
  r = await vraag('POST /app/shopper/' + id2 + '/status', { status: 'gekocht' });
  toets('5h POST gekocht = 400 (niet via de App)', r.s === 400 && /status: open/.test(fs.readFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8')), r);
  r = await vraag('POST /app/shopper/' + id2 + '/status', { status: 'vervallen' });
  toets('5i POST vervallen = 200, pagina op vervallen, reden "shopper status <id> 200"', r.s === 200 && r.app.reden === 'shopper status ' + id2 + ' 200' && /\nstatus: vervallen\n/.test(fs.readFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8')), r);
  r = await vraag('POST /app/shopper/' + id2 + '/gekocht', { status: 'gekocht' });
  r = Object.assign(r, {});
  toets('5j andere POST onder /app/shopper/ (gekocht) = 404', r.s === 404 && r.app.reden === 'shopper onbekend 404', r.app);
  r = await vraag('GET /app/shopper/' + id2 + '/meer');
  toets('5k andere GET = 404', r.s === 404, r.app);
  toets('5l shopperInfo: aantallen, geen fouten gelogd', ctx.__sh.shopperInfo().zoektochten === 1 && fl.length === 0, [ctx.__sh.shopperInfo(), fl]);
  const ctx2 = vm.createContext({ require, __dirname: path.join(W, 'zonder'), path, fs, VAULT: V2, VV: () => VV, appStaat: { tellers: {} }, logError: () => {}, appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__sh = { appShopper, shopperInfo };', ctx2, { filename: 'server.js#shopper2' });
  const n2 = gestuurd.length; await ctx2.__sh.appShopper({}, { _app: {} }, {}, 'GET /app/shopper');
  toets('5m zonder shopper.js in de release: 404 en aan=false', gestuurd[n2].s === 404 && ctx2.__sh.shopperInfo().aan === false);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
