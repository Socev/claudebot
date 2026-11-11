#!/usr/bin/env bash
# Toetst OVIS Shopper S3 (wv2264, 2-11-2026; favorieten wv2267 § 6): shopper.js (alleen type: shopper-zoektocht direct in de vaste Shopper-mappen, entiteit uit de map,
# geen symlink volgen, id = hash van het pad en nooit een pad uit de vraag, koop-link alleen https, totaal/advies uit de opties) en het
# server.js-blok (routes, audit zonder wens, Niet meer nodig = de enige schrijfactie, gekocht niet via de App, /health alleen aantallen + tijdstip,
# uitrol-lijst; § 12 Snel vergelijken wv2934 met nep-zoekhulp en nep-winkels; § 7 S5 Facturen-koppeling wv2276 met een verzonnen facturendatabase; § 8 de knop Gekocht en Toch niet gekocht, wv2275). Alleen verzonnen pagina's; raakt de echte vault niet. Gebruik: bash test/shopper.sh
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
  // wv2833: optieveld btw ("incl" of "omgerekend 21%/9%", anders null)
  toets('2e2 btwVeld: incl en omgerekend 21%/9% blijven; al het andere null', S.btwVeld('incl') === 'incl' && S.btwVeld('omgerekend 21%') === 'omgerekend 21%' && S.btwVeld('omgerekend 9%') === 'omgerekend 9%'
    && [null, undefined, '', 'excl', 'omgerekend 6%', 'omgerekend 21', ' incl x', 'INCL', 'omgerekend 21%<b>', 'null', 7].every((x) => S.btwVeld(x) === null));
  {
    const bt = (b) => '---\ntype: shopper-zoektocht\nopties:\n  - {id: o1, winkel: "A", prijs_eur: 10, verzending_eur: 0, totaal_eur: 10, ' + b + 'url: "https://a.nl/p"}\n---\n';
    const ob = (b) => S.optiesVan(bt(b), [])[0].btw;
    toets('2e3 optiesVan geeft btw door: "incl", omgerekend 21%, kaal incl; ontbreekt of onzin = null', ob('btw: "incl", ') === 'incl' && ob('btw: "omgerekend 21%", ') === 'omgerekend 21%' && ob('btw: incl, ') === 'incl'
      && ob('') === null && ob('btw: "excl", ') === null && ob('btw: null, ') === null, [ob('btw: "incl", '), ob('btw: "omgerekend 21%", '), ob('btw: incl, ')]);
  }
  toets('2e4 optie zonder btw-veld (oude pagina) = btw null', o('o1').btw === null && 'btw' in o('o1'));
  const slecht = ['../10_Zakelijk/Geheim/geheim.md', zt.pad, k.id + '0', k.id.toUpperCase(), '', null, { id: k.id }];
  toets('2f pad-achtige of verkeerde id = 400', slecht.every((x) => m.zoektocht(x).status === 400), slecht.map((x) => m.zoektocht(x).status));
  toets('2g onbekende id = 404; symlink-pagina en niet-zoektocht op id = 404', m.zoektocht('0123456789ab').status === 404 && m.zoektocht(S.idVan('10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-02 - Koppeling.md')).status === 404
    && m.zoektocht(S.idVan('20_Prive/Shopper/Index.md')).status === 404);
  toets('2h id = 12 hex van sha256(pad)', k.id === S.idVan(zt.pad) && /^[0-9a-f]{12}$/.test(k.id));
  // ── 3. Niet meer nodig ──
  const voor = fs.readFileSync(path.join(GH, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8');
  toets('3a alleen {status: "vervallen"}; gekocht, open of extra velden = 400, niets geschreven', [{ status: 'gekocht' }, { status: 'open', x: 1 }, {}, null, { status: 'vervallen', x: 1 }].every((x) => m.status(k.id, x).status === 400)
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
  toets('5j POST gekocht met een onbekend veld = 400, reden "shopper gekocht <id> 400", niets geschreven', r.s === 400 && r.app.reden === 'shopper gekocht ' + id2 + ' 400'
    && /\nstatus: vervallen\n/.test(fs.readFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8')), r);
  r = await vraag('POST /app/shopper/' + id2 + '/gekocht', { optie: 'o1', bedrag_eur: 46.95, opmerking: 'Geheime opmerking' });
  const pg5 = fs.readFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8');
  toets('5n POST gekocht (vervallen → gekocht) = 200, reden zonder winkel/bedrag/opmerking', r.s === 200 && r.app.reden === 'shopper gekocht ' + id2 + ' 200' && !/Proefwinkel|46|Geheim/.test(JSON.stringify(r.app))
    && /\nstatus: gekocht\ngekocht: \{optie: o1, winkel: "Proefwinkel", bedrag_eur: 46.95, datum: "\d{4}-\d{2}-\d{2}", opmerking: "Geheime opmerking", via: app\}\n/.test(pg5), [r, pg5.slice(0, 400)]);
  r = await vraag('POST /app/shopper/' + id2 + '/status', { status: 'open' });
  toets('5o POST status open (Toch niet gekocht) = 200, gekocht-regel weg', r.s === 200 && r.app.reden === 'shopper status ' + id2 + ' 200'
    && !/gekocht/.test(fs.readFileSync(path.join(GH2, 'Shopper - 2026-11-01 - Proefkasten.md'), 'utf8').split('\n---')[0].replace('# open | gekocht | vervallen', '')), r);
  r = await vraag('POST /app/shopper/' + id2 + '/anders', {});
  toets('5j2 andere POST onder /app/shopper/ = 404', r.s === 404 && r.app.reden === 'shopper onbekend 404', r.app);
  r = await vraag('GET /app/shopper/' + id2 + '/meer');
  toets('5k andere GET = 404', r.s === 404, r.app);
  toets('5l shopperInfo: aantallen, geen fouten gelogd', ctx.__sh.shopperInfo().zoektochten === 1 && fl.length === 0, [ctx.__sh.shopperInfo(), fl]);
  const ctx2 = vm.createContext({ require, __dirname: path.join(W, 'zonder'), path, fs, VAULT: V2, VV: () => VV, appStaat: { tellers: {} }, logError: () => {}, appTeller: () => true,
    appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String });
  vm.runInContext(src.slice(hb, he) + ';globalThis.__sh = { appShopper, shopperInfo };', ctx2, { filename: 'server.js#shopper2' });
  const n2 = gestuurd.length; await ctx2.__sh.appShopper({}, { _app: {} }, {}, 'GET /app/shopper');
  toets('5m zonder shopper.js in de release: 404 en aan=false', gestuurd[n2].s === 404 && ctx2.__sh.shopperInfo().aan === false);

  // ── 7. S5 Facturen-koppeling (wv2276): verzonnen facturendatabase, alleen lezen ──
  {
    const F = require('./facturen-db.js'), FD = path.join(W, 'facturen'), fdb = F.open(FD), db = fdb.db, nu = '2026-11-02T10:00:00.000Z';
    for (const e of ['groenhouten', 'tolgaarde', 'praktijkhouders_bv', 'prive']) db.prepare('INSERT INTO entiteit (sleutel, naam) VALUES (?, ?)').run(e, 'Proef ' + e);
    const lev = (id, naam) => db.prepare('INSERT INTO leverancier (id, naam, genormaliseerd, aangemaakt_op) VALUES (?, ?, ?, ?)').run(id, naam, naam.toLowerCase(), nu);
    lev('a000000000000001', 'Bouwmarkt Proef B.V.'); lev('a000000000000002', 'Bolwerk Proefhandel'); lev('a000000000000003', 'Proefbol.com B.V.'); lev('a000000000000004', 'Nepwinkel Nederland B.V.');
    let nr = 0;
    const fac = (x) => { nr++; const h = String(nr).padStart(15, '0'); db.prepare('INSERT INTO document (id, sha256, soort, aangemaakt_op) VALUES (?, ?, ?, ?)').run('d' + h, String(nr).padStart(64, '0'), 'pdf', nu);
      db.prepare('INSERT INTO factuur (id, document, soort, leverancier, leverancier_naam, factuurdatum, incl, incl_eur, valuta, entiteit, status, aangemaakt_op, bijgewerkt_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('f' + h, 'd' + h, x.soort || 'factuur', x.lev || null, x.naam || null, x.datum === undefined ? '2026-11-03' : x.datum, x.c, x.c, 'EUR', x.ent === undefined ? 'groenhouten' : x.ent, x.st || 'te_beoordelen', x.aan || nu, nu); return 'f' + h; };
    const fHoog = fac({ lev: 'a000000000000001', c: 5194 });                         // gelijk bedrag
    const fMid = fac({ lev: 'a000000000000001', c: 5194 + 695, datum: '2026-11-10' });   // + verzending
    fac({ lev: 'a000000000000001', c: 9999 });                                           // bedrag te ver
    fac({ lev: 'a000000000000001', c: 5194, ent: 'tolgaarde' });                         // andere entiteit
    fac({ lev: 'a000000000000001', c: 5194, ent: null });                                // geen entiteit
    fac({ lev: 'a000000000000001', c: 5194, datum: '2026-10-15' });                      // te vroeg (> 14 d vóór)
    fac({ lev: 'a000000000000001', c: 5194, datum: '2026-12-05' });                      // te laat (> 30 d na)
    fac({ lev: 'a000000000000001', c: 5194, soort: 'creditnota' });                      // creditnota telt niet
    fac({ lev: 'a000000000000001', c: 5194, st: 'geen_factuur' });                       // geen factuur telt niet
    fac({ lev: 'a000000000000002', c: 5194 });                                           // Bolwerk ≠ bol (heel woord)
    fac({ lev: 'a000000000000003', c: 5194 });                                           // Proefbol ≠ bol
    const fZonderDatum = fac({ naam: 'Nepwinkel Nederland B.V.', c: 1250, datum: null, aan: '2026-11-04T09:00:00.000Z' });   // leverancier_naam + aangemaakt_op
    const fPh = fac({ lev: 'a000000000000004', c: 1250, ent: 'praktijkhouders_bv' });
    const fPr = fac({ lev: 'a000000000000004', c: 1250, ent: 'prive' });
    F.sluit ? F.sluit(fdb) : db.close();
    const FP = path.join(FD, 'facturen.sqlite'), hashVan = () => require('crypto').createHash('sha256').update(fs.readFileSync(FP)).digest('hex') + ':' + fs.statSync(FP).mtimeMs;
    const voorHash = hashVan();
    const V3 = path.join(W, 'vault3');
    for (const m of S.MAPPEN) fs.mkdirSync(path.join(V3, m[2]), { recursive: true });
    const gk = (map, naam, g, opties, st) => fs.writeFileSync(path.join(V3, map, naam + '.md'), pagina(['type: shopper-zoektocht', 'wens: "' + naam + '"', 'status: ' + (st || 'gekocht'),
      ...(g ? ['gekocht: ' + g] : []), 'gezocht: 2026-11-01T09:00+01:00', 'opties:', ...(opties || [opt('o1', { w: 'Bouwmarkt Proef', p: 51.94, v: 0, t: 51.94, u: 'https://www.bouwmarktproef.nl/p/1' })]), 'advies: o1']));
    gk('10_Zakelijk/Groenhouten/Shopper', 'Met bedrag', '{optie: o1, winkel: "Bouwmarkt Proef", bedrag_eur: 51.94, datum: "2026-11-02", toelichting: "1+1 # gratis"}');
    gk('10_Zakelijk/Groenhouten/Shopper', 'Zonder bedrag', '{optie: o1, winkel: "Bouwmarkt Proef", bedrag_eur: null, datum: "2026-11-02"}');
    gk('10_Zakelijk/Groenhouten/Shopper', 'Bol via host', '{optie: o1, winkel: "bol", bedrag_eur: 51.94, datum: "2026-11-02"}', [opt('o1', { w: 'bol', p: 51.94, v: 0, t: 51.94, u: 'https://www.bol.com/nl/nl/p/x/1/' })]);
    gk('10_Zakelijk/Groenhouten/Shopper', 'Open met gekocht-regel', '{optie: o1, winkel: "Bouwmarkt Proef", bedrag_eur: 51.94, datum: "2026-11-02"}', null, 'open');
    gk('10_Zakelijk/Groenhouten/Shopper', 'Zonder datum', '{optie: o1, winkel: "Bouwmarkt Proef", bedrag_eur: 51.94}');
    gk('10_Zakelijk/Groenhouten/Shopper', 'Host als sleutel', '{optie: o2, winkel: "Iets Anders", bedrag_eur: 12.50, datum: "2026-11-02"}',
      [opt('o2', { w: 'Iets Anders', p: 12.5, v: 0, t: 12.5, u: 'https://nepwinkel.nl/p/9' })]);
    gk('10_Zakelijk/Praktijkhouders_BV/Shopper', 'Praktijkhouders', '{optie: o1, winkel: "Nepwinkel", bedrag_eur: 12.50, datum: "2026-11-02"}');
    gk('20_Prive/Shopper', 'Prive', '{winkel: "Nepwinkel", bedrag_eur: 12.50, datum: "2026-11-02"}');
    const m3 = S.maak({ vault: V3, vv: VV, facturenPad: () => FP });
    const L3 = m3.lijst().body.zoektochten, z3 = (w) => L3.find((x) => x.wens === w), det = (w) => m3.zoektocht(z3(w).id).body.zoektocht;
    const a = det('Met bedrag');
    toets('7a gekocht-blok gelezen (winkel, bedrag, datum, opmerking met # binnen aanhalingstekens)', a.gekocht && a.gekocht.winkel === 'Bouwmarkt Proef' && a.gekocht.bedrag_eur === 51.94
      && a.gekocht.datum === '2026-11-02' && a.gekocht.opmerking === '1+1 # gratis' && a.gekocht.optie === 'o1', a.gekocht);
    toets('7b met bedrag: gelijk = hoog, + verzending = middel; verkeerde entiteit/zonder entiteit/te vroeg/te laat/te ver/creditnota/geen_factuur/Bolwerk tellen niet',
      Array.isArray(a.facturen) && a.facturen.length === 2 && a.facturen[0].id === fHoog && a.facturen[0].zekerheid === 'hoog' && a.facturen[0].bedrag_eur === 51.94
      && a.facturen[0].leverancier === 'Bouwmarkt Proef B.V.' && a.facturen[0].factuurdatum === '2026-11-03' && a.facturen[1].id === fMid && a.facturen[1].zekerheid === 'middel', a.facturen);
    const b = det('Zonder bedrag');
    toets('7c bedrag onbekend: alle passende (winkel + entiteit + datum) op laag, hooguit 3, dichtst bij de datum eerst', b.facturen.length === 3 && b.facturen.every((x) => x.zekerheid === 'laag')
      && b.facturen[0].factuurdatum === '2026-11-03' && !b.facturen.some((x) => x.id === fMid) === false, b.facturen);
    toets('7d bol via de hostnaam: Bolwerk en Proefbol tellen niet (heel woord)', det('Bol via host').facturen.length === 0, det('Bol via host').facturen);
    toets('7e open zoektocht (ook met een gekocht-regel): geen facturen-veld, geen gekocht-blok', det('Open met gekocht-regel').facturen === undefined && det('Open met gekocht-regel').gekocht === null);
    toets('7f gekocht zonder datum: lege lijst', Array.isArray(det('Zonder datum').facturen) && det('Zonder datum').facturen.length === 0);
    const h = det('Host als sleutel');
    toets('7g winkelnaam past niet, hostnaam wel; factuur zonder leverancier-id (leverancier_naam) en zonder factuurdatum (aangemaakt_op)', h.facturen.length === 1 && h.facturen[0].id === fZonderDatum
      && h.facturen[0].factuurdatum === '2026-11-04' && h.facturen[0].zekerheid === 'hoog', h.facturen);
    toets('7h praktijkhouders → praktijkhouders_bv; privé alleen privé', det('Praktijkhouders').facturen.map((x) => x.id).join() === fPh && det('Prive').facturen.map((x) => x.id).join() === fPr,
      [det('Praktijkhouders').facturen, det('Prive').facturen]);
    toets('7i lijst: factuur_gevonden alleen bij gekocht (aantal), gekocht-blok alleen winkel en datum (wv2593: Pakjes); open zonder veld', z3('Met bedrag').factuur_gevonden === 2 && z3('Zonder bedrag').factuur_gevonden === 3
      && JSON.stringify(z3('Met bedrag').gekocht) === JSON.stringify({ winkel: 'Bouwmarkt Proef', datum: '2026-11-02' }) && !('factuur_gevonden' in z3('Open met gekocht-regel')), z3('Met bedrag'));
    toets('7j de facturendatabase is na alle vragen byte-gelijk (niets geschreven)', hashVan() === voorHash);
    const m4 = S.maak({ vault: V3, vv: VV, facturenPad: () => { throw new Error('kapot'); } }), m5 = S.maak({ vault: V3, vv: VV, facturenPad: () => null }), m6 = S.maak({ vault: V3, vv: VV });
    const id = z3('Met bedrag').id;
    toets('7k facturenPad gooit / null / ontbreekt: facturen null, zoektocht gewoon 200', [m4, m5, m6].every((x) => { const r = x.zoektocht(id); return r.status === 200 && r.body.zoektocht.facturen === null; })
      && m4.lijst().body.zoektochten.find((x) => x.wens === 'Met bedrag').factuur_gevonden === null);
    // schrijven via een handle zoals metFacturen hem opent faalt
    const { DatabaseSync } = require('node:sqlite'), ro = new DatabaseSync(FP, { readOnly: true }); ro.exec('PRAGMA query_only = ON');
    let geweigerd = false; try { ro.exec("UPDATE factuur SET status = 'verstuurd'"); } catch (e) { geweigerd = true; } ro.close();
    toets('7l een readOnly + query_only-handle kan niet schrijven', geweigerd && hashVan() === voorHash);
    const bron = fs.readFileSync('shopper.js', 'utf8');
    toets('7m shopper.js: alleen SELECT op facturen, readOnly + query_only, geen gedeelde handle', !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|ATTACH)\b/.test(bron) && /readOnly: true/.test(bron) && /query_only = ON/.test(bron) && !/facturenOpen/.test(bron));
    const srv = fs.readFileSync('server.js', 'utf8');
    toets('7n server.js geeft shopper alleen een pad (primaire kant), geen facturenOpen()', /maak\(\{ vault: VAULT, vv: VV\(\), facturenPad: facturenPad, lezer: lezer, todoistTaak: todoistTaak,/.test(srv) && !/facturenOpen/.test(srv.slice(srv.indexOf('const shopper = (function'), srv.indexOf('function shopperInfo'))) && /facturenMagOpenen\(\) \? path\.join\(FACTUREN_DIR, 'facturen\.sqlite'\) : null/.test(srv));
  }

  // ── 8. de knop Gekocht (wv2275, bouwplan "OVIS Shopper - knop Gekocht (ontwerp 2-11-2026)" § 3.2 en § 7) ──
  {
    const V4 = path.join(W, 'vault4'), M4 = path.join(V4, '10_Zakelijk/Groenhouten/Shopper'); fs.mkdirSync(M4, { recursive: true });
    const NAAM = 'Shopper - 2026-11-01 - Kast.md', P4 = path.join(M4, NAAM), id = S.idVan('10_Zakelijk/Groenhouten/Shopper/' + NAAM);
    const bron = pagina(['type: shopper-zoektocht', 'wens: "Proefkast"', 'status: open   # open | gekocht | vervallen', 'gezocht: 2026-11-01T09:00+01:00', 'opties:',
      opt('o1', { w: 'Bouwmarkt Proef', p: 25.97, v: 0, t: 51.94, n: 2, u: 'https://www.bouwmarktproef.nl/p/1' }),
      '  - {id: o2, winkel: "Andere \\"Winkel\\"", product: "x", prijs_eur: 9, totaal_eur: 9, url: "https://andere.nl/p"}', 'advies: o1', 'updated: 2026-11-01'], '# Kast\n\ntekst\n');
    const zet = (t) => fs.writeFileSync(P4, t), leesP = () => fs.readFileSync(P4, 'utf8');
    const nu = () => new Date('2026-11-02T11:00:00Z');
    const m8 = S.maak({ vault: V4, vv: VV, nu });
    zet(bron);
    let r8 = m8.gekocht(id, { optie: 'o1', bedrag_eur: 51.94, datum: '2026-11-02', opmerking: '1+1 gratis' });
    const regel = 'gekocht: {optie: o1, winkel: "Bouwmarkt Proef", bedrag_eur: 51.94, datum: "2026-11-02", opmerking: "1+1 gratis", via: app}';
    toets('8a gekocht per optie: 200, statusregel gekocht + gekocht-regel direct eronder, rest byte-gelijk', r8.status === 200 && leesP() === bron.replace('status: open   # open | gekocht | vervallen', 'status: gekocht\n' + regel), [r8, leesP().slice(0, 300)]);
    const g8 = m8.zoektocht(id).body.zoektocht;
    toets('8b GET geeft het gekocht-blok terug (via app), de lijst alleen winkel en datum (wv2593)', g8.status === 'gekocht' && JSON.stringify(g8.gekocht) === JSON.stringify({ optie: 'o1', winkel: 'Bouwmarkt Proef', bedrag_eur: 51.94, datum: '2026-11-02', opmerking: '1+1 gratis', via: 'app' })
      && JSON.stringify(m8.lijst().body.zoektochten[0].gekocht) === JSON.stringify({ winkel: 'Bouwmarkt Proef', datum: '2026-11-02' }), g8.gekocht);
    const ervoor = leesP();
    r8 = m8.gekocht(id, { optie: 'o1', bedrag_eur: '51.94', datum: '2026-11-02', opmerking: '1+1 gratis' });
    toets('8c nog eens met dezelfde gegevens = 200 al, niets geschreven', r8.status === 200 && r8.body.al === true && leesP() === ervoor, r8);
    r8 = m8.gekocht(id, { optie: 'o1', bedrag_eur: 40, datum: '2026-11-02' });
    toets('8d al gekocht met andere gegevens = 409, niets geschreven', r8.status === 409 && leesP() === ervoor, r8);
    toets('8e gekocht → vervallen blijft 409', m8.status(id, { status: 'vervallen' }).status === 409 && leesP() === ervoor);
    r8 = m8.status(id, { status: 'open' });
    toets('8f Toch niet gekocht: gekocht → open, gekocht-regel weg, pagina weer byte-gelijk aan het begin (op de statusregel na)', r8.status === 200 && leesP() === bron.replace('status: open   # open | gekocht | vervallen', 'status: open'), [r8, leesP().slice(0, 200)]);
    toets('8g open → open = 200 al', m8.status(id, { status: 'open' }).body.al === true);
    zet(bron);
    r8 = m8.gekocht(id, { optie: 'o2' });
    toets('8h winkel komt uit de pagina (aanhalingstekens veilig), bedrag nooit uit de optie (null), datum leeg = vandaag', r8.status === 200
      && leesP().includes('gekocht: {optie: o2, winkel: "Andere \'Winkel\'", bedrag_eur: null, datum: "2026-11-02", opmerking: null, via: app}')
      && m8.zoektocht(id).body.zoektocht.gekocht.bedrag_eur === null && m8.zoektocht(id).body.zoektocht.gekocht.winkel === "Andere 'Winkel'", [r8, leesP().slice(0, 400)]);
    zet(bron);
    const slecht8 = [null, [], 'o1', {}, { optie: 'o1', winkel: 'Gamma' }, { optie: 'o9' }, { optie: 'x1' }, { optie: 1 }, { optie: 'o1', status: 'gekocht' }, { optie: 'o1', via: 'socev' },
      { optie: 'o1', bedrag_eur: '12,50' }, { optie: 'o1', bedrag_eur: -1 }, { optie: 'o1', bedrag_eur: 1.234 }, { optie: 'o1', bedrag_eur: 'abc' }, { optie: 'o1', bedrag_eur: 1e10 }, { optie: 'o1', bedrag_eur: true },
      { optie: 'o1', datum: '2026-11-03' }, { optie: 'o1', datum: '2026-02-30' }, { optie: 'o1', datum: '2026-09-30' }, { optie: 'o1', datum: '2-11-2026' }, { optie: 'o1', datum: 20261102 },
      { optie: 'o1', opmerking: 'x'.repeat(121) }, { optie: 'o1', opmerking: 5 }, { winkel: 'w'.repeat(81) }, { winkel: '   ' }, { winkel: 3 }];
    const st8 = slecht8.map((x) => m8.gekocht(id, x).status);
    toets('8i ongeldig (optie/winkel beide of geen, onbekende optie, extra veld, bedrag, datum toekomst/ongeldig/te vroeg, te lange tekst) = 400, niets geschreven', st8.every((x) => x === 400) && leesP() === bron, st8);
    toets('8j onbekende of pad-achtige id = 404/400', m8.gekocht('0123456789ab', { optie: 'o1' }).status === 404 && m8.gekocht('../x', { optie: 'o1' }).status === 400);
    r8 = m8.gekocht(id, { optie: 'o1', opmerking: 'regel1\nregel2 "aanh" \\ back, komma: #hekje } {acc}\u2028zz\r\t\u0085' });
    const t8 = leesP(), fm8 = t8.split('\n---')[0], g8b = m8.zoektocht(id).body.zoektocht;
    toets('8k opmerking met regeleinde, aanhalingstekens, backslash, komma, #, accolades, U+2028: één regel, terug te lezen, frontmatter heel', r8.status === 200
      && fm8.split('\n').length === bron.split('\n---')[0].split('\n').length + 1 && g8b.gekocht.opmerking === "regel1 regel2 'aanh' / back, komma: #hekje } {acc} zz"
      && g8b.opties.length === 2 && g8b.advies === 'o1' && t8.endsWith('\n---\n# Kast\n\ntekst\n'), [g8b.gekocht, fm8]);
    zet(bron.replace('status: open   # open | gekocht | vervallen', 'status: vervallen'));
    r8 = m8.gekocht(id, { winkel: 'Kringloop "De Ruil"\n', bedrag_eur: 12.5, datum: '2026-10-05', opmerking: '' });
    const g8c = m8.zoektocht(id).body.zoektocht.gekocht;
    toets('8l vervallen → gekocht; ergens anders gekocht: optie null, winkel uit de vraag (veilig), datum binnen 30 d vóór de zoektocht mag', r8.status === 200
      && leesP().includes('\nstatus: gekocht\ngekocht: {optie: null, winkel: "Kringloop \'De Ruil\'", bedrag_eur: 12.5, datum: "2026-10-05", opmerking: null, via: app}\n')
      && g8c.optie === null && g8c.winkel === "Kringloop 'De Ruil'" && g8c.bedrag_eur === 12.5, [r8, g8c]);
    // gelijktijdige wijziging: tussen het lezen en het schrijven verandert de pagina
    const vvRace = (fn) => Object.assign({}, VV, { wijzig: (p, f) => { fn(); return VV.wijzig(p, f); } });
    zet(bron);
    const mR = S.maak({ vault: V4, vv: vvRace(() => zet(bron.replace('status: open   # open | gekocht | vervallen', 'status: vervallen'))), nu });
    r8 = mR.gekocht(id, { optie: 'o1' });
    toets('8m gelijktijdige wijziging (status veranderd) = 409, alleen de andere wijziging staat er', r8.status === 409 && leesP() === bron.replace('status: open   # open | gekocht | vervallen', 'status: vervallen'), r8);
    zet(bron);
    const zonderO1 = bron.replace(/\n  - \{id: o1[^\n]*/, '');
    r8 = S.maak({ vault: V4, vv: vvRace(() => zet(zonderO1)), nu }).gekocht(id, { optie: 'o1' });
    toets('8n gelijktijdige wijziging (optie weg) = 409, niets bijgeschreven', r8.status === 409 && leesP() === zonderO1, r8);
    zet(bron);
    const laterGezocht = bron.replace('gezocht: 2026-11-01T09:00+01:00', 'gezocht: 2026-11-02T09:00+01:00');
    r8 = S.maak({ vault: V4, vv: vvRace(() => zet(laterGezocht)), nu }).gekocht(id, { optie: 'o1', datum: '2026-10-02' });
    toets('8n2 gelijktijdige wijziging van gezocht: datum onder het slot opnieuw getoetst (te vroeg = 409, niets geschreven)', r8.status === 409 && leesP() === laterGezocht, r8);
    zet(bron);
    r8 = S.maak({ vault: V4, vv: vvRace(() => { m8.gekocht(id, { optie: 'o1', datum: '2026-11-02' }); }), nu }).gekocht(id, { optie: 'o1', datum: '2026-11-02' });
    toets('8o gelijktijdig dezelfde tik = 200 al (één gekocht-regel)', r8.status === 200 && r8.body.al === true && leesP().split('\ngekocht:').length === 2, [r8, leesP().slice(0, 300)]);
    // de nederlandse dag: 23:30 UTC op 2 nov = 3 nov in Nederland
    zet(bron);
    r8 = S.maak({ vault: V4, vv: VV, nu: () => new Date('2026-11-02T23:30:00Z') }).gekocht(id, { optie: 'o1' });
    toets('8p datum leeg = vandaag in Nederland (niet UTC); 3 nov mag dan', r8.status === 200 && r8.body.gekocht.datum === '2026-11-03', r8);
    // de handmatige regel (Stellingkast-vorm: toelichting, zonder via) en een blokvorm
    zet(bron.replace('status: open   # open | gekocht | vervallen', 'status: gekocht\ngekocht: {optie: o1, winkel: "Gamma", bedrag_eur: null, datum: "2026-11-02", toelichting: "1+1 gratis (opgave David)"}'));
    const g8d = m8.zoektocht(id).body.zoektocht.gekocht;
    toets('8q handmatige gekocht-regel zonder via blijft leesbaar (opmerking uit toelichting, via null)', m8.zoektocht(id).status === 200 && g8d.winkel === 'Gamma' && g8d.opmerking === '1+1 gratis (opgave David)' && g8d.via === null && g8d.bedrag_eur === null, g8d);
    toets('8r daarop Gekocht met andere gegevens = 409; Toch niet gekocht haalt de handmatige regel weg', m8.gekocht(id, { optie: 'o1', bedrag_eur: 51.94 }).status === 409
      && m8.status(id, { status: 'open' }).status === 200 && leesP() === bron.replace('status: open   # open | gekocht | vervallen', 'status: open'), leesP().slice(0, 300));
    zet(bron.replace('status: open   # open | gekocht | vervallen', 'status: gekocht\ngekocht:\n  optie: o1\n  winkel: Gamma'));
    toets('8s Toch niet gekocht haalt ook een gekocht-blok in blokvorm helemaal weg', m8.status(id, { status: 'open' }).status === 200 && leesP() === bron.replace('status: open   # open | gekocht | vervallen', 'status: open'), leesP().slice(0, 300));
    zet(bron.replace('status: open   # open | gekocht | vervallen', 'status: vervallen'));
    toets('8t vervallen → open via status = 409 (alleen gekocht kan terug naar open)', m8.status(id, { status: 'open' }).status === 409);
    zet(bron.replace('status: open   # open | gekocht | vervallen\n', '').replace('opties:', 'gekocht: {optie: o2, winkel: "Oud"}\nopties:'));
    r8 = m8.gekocht(id, { optie: 'o1' });
    toets('8u zonder statusregel en met een oude gekocht-regel elders: oude regel weg, status + regel onderaan de frontmatter', r8.status === 200 && !leesP().includes('"Oud"')
      && /\nupdated: 2026-11-01\nstatus: gekocht\ngekocht: \{optie: o1,[^\n]*\}\n---\n/.test(leesP()), leesP().slice(0, 700));
    const bronSh = fs.readFileSync('shopper.js', 'utf8'), gk = bronSh.slice(bronSh.indexOf('  function gekocht(id, d)'), bronSh.indexOf('  function info()'));
    toets('8v gekocht() leest geen prijs of totaal uit de optie (bedrag alleen uit de vraag)', gk.length > 500 && !/totaal_eur|prijs_eur|verzending_eur/.test(gk));
  }

  // ── 9. Nu nalezen en de Todoist-taak (wv2454) ──
  {
    const V9 = path.join(W, 'vault9'), GH9 = path.join(V9, '10_Zakelijk/Groenhouten/Shopper'), ST9 = path.join(W, 'nalezen.json');
    fs.mkdirSync(GH9, { recursive: true });
    const P9 = path.join(GH9, 'Shopper - 2026-11-03 - Proefrekken.md');
    const bron9 = pagina(['type: shopper-zoektocht', 'wens: "Proefrekken"', 'todoist_id: "ProefTaak123"', 'status: open', 'gezocht: 2026-11-03T09:00+01:00', 'aantal: 2', 'opties:',
      opt('o1', { p: 46.95, v: 0, t: 46.95, u: 'https://www.proefwinkel.nl/p/rek/1/' }),
      opt('o2', { w: 'Nepmarkt', n: 2, p: 10, v: 'null', t: 'null', u: 'https://www.nepmarkt.nl/p/rek/2/' }),
      opt('o3', { p: 5, v: 0, t: 5, u: 'http://www.onveilig.nl/p/3' }),
      opt('o4', { p: 20, v: 0, t: 20, u: 'https://www.stilwinkel.nl/p/4' }),
      'advies: o1'], '# Shopper — proefrekken\n');
    fs.writeFileSync(P9, bron9);
    const P9b = path.join(GH9, 'Shopper - 2026-11-03 - Gekocht rek.md');
    fs.writeFileSync(P9b, bron9.replace('wens: "Proefrekken"', 'wens: "Gekocht rek"').replace('todoist_id: "ProefTaak123"\n', 'todoist_id: "../../geheim"\n').replace('status: open', 'status: gekocht'));
    let klok = new Date('2026-11-05T10:00:00Z'), gelezen = [], antwoord = {}, taakAntwoord = null, taakVragen = 0;
    const lezer = async (url) => { gelezen.push(url); const a = antwoord[url]; if (a instanceof Error) throw a; return a === undefined ? null : a; };
    const m9 = S.maak({ vault: V9, vv: VV, nu: () => klok, nalezenPad: ST9, lezer,
      todoistTaak: async (tid) => { taakVragen++; if (taakAntwoord instanceof Error) throw taakAntwoord; return taakAntwoord; } });
    const l9 = m9.lijst().body.zoektochten, id9 = l9.find((x) => x.wens === 'Proefrekken').id, id9b = l9.find((x) => x.wens === 'Gekocht rek').id;
    antwoord = {
      'https://www.proefwinkel.nl/p/rek/1/': { url: 'https://www.proefwinkel.nl/p/rek/1/', prijs_eur: 39.99, verzending_eur: 0, voorraad: 'op voorraad', levertijd: 'morgen in huis', verkoper: 'Proefwinkel', blokkade: null, opmerkingen: ['variantenpagina: 3 varianten'] },
      'https://www.nepmarkt.nl/p/rek/2/': { url: 'https://www.nepmarkt.nl/p/rek/2/', prijs_eur: 12, verzending_eur: 5, voorraad: 'x'.repeat(300), levertijd: null, verkoper: null, blokkade: null, opmerkingen: [] },
      'https://www.stilwinkel.nl/p/4': { url: 'https://ANDERS.nl/p/4', prijs_eur: 1, verzending_eur: 0 },
    };
    let r9 = await m9.nalezen(id9);
    const n9 = r9.body.nu, no = (id) => n9 && n9.opties.find((x) => x.id === id);
    toets('9a nalezen: 200, alleen de https-links van de pagina gelezen (o3 http niet), in volgorde', r9.status === 200 && JSON.stringify(gelezen) === JSON.stringify(['https://www.proefwinkel.nl/p/rek/1/', 'https://www.nepmarkt.nl/p/rek/2/', 'https://www.stilwinkel.nl/p/4']), [r9, gelezen]);
    toets('9b nu-prijs lager dan op de pagina, totaal = koop_aantal × prijs + verzending, variantenpagina gemarkeerd', no('o1').prijs_eur === 39.99 && no('o1').verschil === 'lager' && no('o1').totaal_eur === 39.99 && no('o1').varianten === true
      && no('o2').totaal_eur === 29 && no('o2').verschil === 'hoger' && no('o2').voorraad.length === 120, n9);
    toets('9c lezer-uitkomst voor een andere link telt niet (blokkade, geen bedragen); samenvatting telt', no('o4').prijs_eur === null && /niet te lezen/.test(no('o4').blokkade)
      && JSON.stringify(n9.samenvatting) === JSON.stringify({ lager: 1, hoger: 1, gelijk: 0, niet: 1 }) && !JSON.stringify(n9).includes('https://'), n9);
    toets('9d de zoektochtpagina blijft byte-gelijk; staatbestand 0600 met de uitkomst', fs.readFileSync(P9, 'utf8') === bron9 && (fs.statSync(ST9).mode & 0o777) === 0o600
      && JSON.parse(fs.readFileSync(ST9, 'utf8'))[id9].opties.length === 3);
    const z9 = m9.zoektocht(id9).body.zoektocht;
    toets('9e zoektocht geeft de nalezing (zonder links) en de Todoist-link', z9.nu && z9.nu.t === n9.t && z9.nu.opties.length === 3 && !JSON.stringify(z9.nu).includes('http')
      && z9.todoist_url === 'https://app.todoist.com/app/task/ProefTaak123' && z9.todoist_id === 'ProefTaak123', z9.nu);
    gelezen = []; klok = new Date('2026-11-05T10:05:00Z');
    r9 = await m9.nalezen(id9);
    toets('9f binnen 10 minuten opnieuw: de bewaarde uitkomst (al), niets gelezen', r9.status === 200 && r9.body.al === true && gelezen.length === 0, r9);
    klok = new Date('2026-11-05T10:11:00Z'); antwoord['https://www.proefwinkel.nl/p/rek/1/'] = new Error('stuk');
    r9 = await m9.nalezen(id9);
    toets('9g na 10 minuten opnieuw gelezen; een falende lezing = alleen die optie niet te lezen', r9.status === 200 && !r9.body.al && gelezen.length === 3 && r9.body.nu.opties[0].prijs_eur === null && r9.body.nu.opties[1].prijs_eur === 12, r9.body);
    gelezen = []; klok = new Date('2026-11-05T10:30:00Z');
    let los; const wacht = new Promise((k) => { los = k; });
    const traag = S.maak({ vault: V9, vv: VV, nu: () => klok, nalezenPad: path.join(W, 'n2.json'), lezer: async () => { await wacht; return null; } });
    const eerst = traag.nalezen(id9), tweede = await traag.nalezen(id9);
    los(); await eerst;
    toets('9h tegelijk twee keer nalezen: de tweede = 409 (loopt al)', tweede.status === 409, tweede);
    // review ZOU 1: over alle zoektochten heen hooguit 4 leesprocessen tegelijk
    {
      const Vg = path.join(W, 'vault9g'), GHg = path.join(Vg, '10_Zakelijk/Groenhouten/Shopper');
      fs.mkdirSync(GHg, { recursive: true });
      const zes = (w) => pagina(['type: shopper-zoektocht', 'wens: "' + w + '"', 'status: open', 'gezocht: 2026-11-03T09:00+01:00', 'opties:']
        .concat([1, 2, 3, 4, 5, 6].map((i) => opt('o' + i, { p: 10, v: 0, t: 10, u: 'https://www.proefwinkel.nl/p/' + w + '/' + i + '/' }))));
      fs.writeFileSync(path.join(GHg, 'Shopper - 2026-11-03 - A.md'), zes('a'));
      fs.writeFileSync(path.join(GHg, 'Shopper - 2026-11-03 - B.md'), zes('b'));
      let nuActief = 0, hoogste = 0, totaal = 0;
      const mg = S.maak({ vault: Vg, vv: VV, nu: () => klok, nalezenPad: path.join(W, 'ng.json'),
        lezer: async (url) => { nuActief++; totaal++; hoogste = Math.max(hoogste, nuActief); await new Promise((k) => setTimeout(k, 15)); nuActief--; return { url, prijs_eur: 9 }; } });
      const ids = mg.lijst().body.zoektochten.map((x) => x.id);
      const rs = await Promise.all(ids.map((x) => mg.nalezen(x)));
      toets('9h2 twee zoektochten met elk 6 links tegelijk: alle 12 gelezen, nooit meer dan 4 tegelijk', rs.every((x) => x.status === 200 && x.body.nu.samenvatting.lager === 6) && totaal === 12 && hoogste === 4, [hoogste, totaal]);
    }
    gelezen = [];
    r9 = await m9.nalezen(id9b);
    toets('9i gekochte zoektocht nalezen = 409, niets gelezen; ongeldige id = 400', r9.status === 409 && gelezen.length === 0 && (await m9.nalezen('../x')).status === 400, r9);
    toets('9j een gekochte zoektocht toont geen nalezing; ongeldige todoist_id op de pagina = geen link', m9.zoektocht(id9b).body.zoektocht.nu === null && m9.zoektocht(id9b).body.zoektocht.todoist_url === null);
    fs.writeFileSync(P9, bron9.replace('https://www.nepmarkt.nl/p/rek/2/', 'https://www.nepmarkt.nl/p/rek/2b/'));
    const z9c = m9.zoektocht(id9).body.zoektocht;
    toets('9k link op de pagina veranderd: die optie valt uit de bewaarde nalezing', z9c.nu && z9c.nu.opties.length === 2 && !z9c.nu.opties.some((x) => x.id === 'o2'), z9c.nu);
    klok = new Date('2026-11-13T10:00:00Z');
    toets('9l ouder dan 7 dagen: geen nalezing meer getoond', m9.zoektocht(id9).body.zoektocht.nu === null);
    fs.writeFileSync(P9, bron9);
    const zonder = S.maak({ vault: V9, vv: VV, nu: () => klok });
    toets('9m zonder lezer (oude server.js) = 404; zonder staatbestand werkt zoektocht gewoon', (await zonder.nalezen(id9)).status === 404 && zonder.zoektocht(id9).body.zoektocht.nu === null);
    // Todoist-taak
    taakAntwoord = { status: 200, taak: { checked: false, is_deleted: false, content: 'Twee proefrekken kopen' } };
    let t9 = await m9.taak(id9);
    toets('9n taak open: stand, titel en link', t9.status === 200 && t9.body.taak.stand === 'open' && t9.body.taak.titel === 'Twee proefrekken kopen' && t9.body.taak.url === 'https://app.todoist.com/app/task/ProefTaak123', t9);
    taakAntwoord = { status: 200, taak: { checked: true, is_deleted: false, content: 'Twee proefrekken kopen' } };
    const v0 = taakVragen; t9 = await m9.taak(id9);
    toets('9o binnen 5 minuten onthouden (geen nieuwe vraag aan Todoist)', taakVragen === v0 && t9.body.taak.stand === 'open');
    klok = new Date(klok.getTime() + 6 * 60000); t9 = await m9.taak(id9);
    toets('9p daarna opnieuw gevraagd: afgevinkt', taakVragen === v0 + 1 && t9.body.taak.stand === 'afgevinkt', t9);
    const m9t = (ant) => S.maak({ vault: V9, vv: VV, nu: () => klok, todoistTaak: async () => { if (ant instanceof Error) throw ant; return ant; } });
    toets('9q verwijderd of 404 = weg; fout of geen sleutel = onbekend', (await m9t({ status: 200, taak: { checked: false, is_deleted: true } }).taak(id9)).body.taak.stand === 'weg'
      && (await m9t({ status: 404, taak: null }).taak(id9)).body.taak.stand === 'weg' && (await m9t(new Error('net')).taak(id9)).body.taak.stand === 'onbekend'
      && (await m9t(null).taak(id9)).body.taak.stand === 'onbekend');
    toets('9r zoektocht zonder (geldige) todoist_id: taak null, Todoist niet gevraagd', (await m9.taak(id9b)).body.taak === null);
    // server.js: routes en de kale omgeving van het leesscript
    const blok = src.slice(hb, he);
    toets('9s server.js: leesscript met kale omgeving (geen process.env-kopie), één link per proces, timeout', /env: \{ PATH: process\.env\.PATH \|\| '\/usr\/bin:\/bin', LANG: 'C\.UTF-8', HOME: '\/tmp' \}/.test(blok)
      && /execFile\('python3', \['-I', lezerScript, url\]/.test(blok) && !/Object\.assign\(\{\}, process\.env/.test(blok.slice(blok.indexOf('const lezerScript'), blok.indexOf('const todoistTaak'))));
    toets('9t server.js: tellers nalezen 20/uur en taak 120/uur; uitrol-lijst heeft winkel-lezen.py', /appTeller\('shopper_nalezen', 20, 3600000\)/.test(blok) && /appTeller\('shopper_taak', 120, 3600000\)/.test(blok)
      && /RELEASE_OPTIONEEL="[^"]*\bwinkel-lezen\.py\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
    const Vr = path.join(W, 'vault9r'), GHr = path.join(Vr, '10_Zakelijk/Groenhouten/Shopper');
    fs.mkdirSync(GHr, { recursive: true });
    fs.writeFileSync(path.join(GHr, 'Shopper - 2026-11-03 - Gekocht rek.md'), bron9.replace('status: open', 'status: gekocht').replace('todoist_id: "ProefTaak123"\n', ''));
    const ctx9 = vm.createContext({ require, __dirname: process.cwd(), path, fs, VAULT: Vr, VV: () => VV, appStaat: { tellers: {} }, logError: () => {}, appTeller: () => true,
      appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String, Promise });
    vm.runInContext(blok + ';globalThis.__sh = { appShopper };', ctx9, { filename: 'server.js#shopper9' });
    const idr = S.idVan('10_Zakelijk/Groenhouten/Shopper/Shopper - 2026-11-03 - Gekocht rek.md');
    const vr = async (route) => { const res = { _app: {} }; const n = gestuurd.length; await ctx9.__sh.appShopper({}, res, {}, route, {}); return Object.assign({ app: res._app }, gestuurd[n]); };
    let rr = await vr('POST /app/shopper/' + idr + '/nalezen');
    toets('9u route nalezen op een gekochte zoektocht = 409, reden "shopper nalezen <id> 409"', rr.s === 409 && rr.app.reden === 'shopper nalezen ' + idr + ' 409', rr);
    rr = await vr('GET /app/shopper/' + idr + '/taak');
    toets('9v route taak zonder todoist_id = 200 taak null, reden zonder titel', rr.s === 200 && rr.j.taak === null && rr.app.reden === 'shopper taak ' + idr + ' 200', rr);
  }

  // ── 10. wv2561: Eisen aanpassen en Opnieuw zoeken ──
  {
    const V10 = path.join(W, 'vault10'), PR10 = path.join(V10, '20_Prive/Shopper');
    fs.mkdirSync(PR10, { recursive: true });
    const P10 = path.join(PR10, 'Shopper - 2026-11-02 - Proefgordijnen.md');
    const fm10 = ['type: shopper-zoektocht', 'wens: "Proefgordijnen keuken"', 'entiteit: prive', 'todoist_id: "ProefTaak77"', 'status: open', 'gezocht: 2026-11-02T17:36+01:00', 'aantal: 2',
      'eisen: ["gordijn keuken", "gordijn slaapkamer"]', 'aannames: ["geen maten"]', 'opties:', opt('o1', { p: 44.99, v: 0, t: 44.99, u: 'https://www.proefwinkel.nl/p/g/1/' }), 'advies: o1'];
    const lijf10 = '# Shopper — proefgordijnen\n\nAdvies: o1.\n\n## Waarom dit advies\nGoed.\n\n## Eerdere opties\n### Ronde van 1 nov\n| # | Winkel |\n|---|---|\n| o0 | Oud |\n\n## Gerelateerd\n- x\n';
    const bron10 = pagina(fm10, lijf10);
    fs.writeFileSync(P10, bron10);
    let klok = new Date('2026-11-06T09:00:00Z'), starts = [], startAntwoord = { ok: true, job_id: 'abcdef0123456789' }, stand = 'loopt';
    const GW = 'GRONDWET-KERN v1 — proefblok';
    const PP = require('./intake/patientpoort.js'), POORT = (t) => PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) });   // wv2850: de echte patiëntpoort
    const m10 = S.maak({ vault: V10, vv: VV, nu: () => klok, opnieuwPad: path.join(W, 'opnieuw.json'), grondwet: () => GW, poort: POORT,
      agentStart: async (pr) => { starts.push(pr); if (startAntwoord instanceof Error) throw startAntwoord; return startAntwoord; }, agentStand: () => stand });
    const id10 = m10.lijst().body.zoektochten[0].id;
    let r = m10.eisen(id10, { wens: 'Duette-gordijnen keuken en slaapkamer', eisen: ['Duette (honingraat)', '', 'keuken lichtdoorlatend', 'slaapkamer "verduisterend"'] });
    const na = fs.readFileSync(P10, 'utf8');
    toets('10a eisen opslaan: 200, lege regel weg, " wordt \'', r.status === 200 && JSON.stringify(r.body.eisen) === JSON.stringify(['Duette (honingraat)', 'keuken lichtdoorlatend', "slaapkamer 'verduisterend'"]) && r.body.aangepast === '2026-11-06 door David', r);
    const verwacht = bron10.replace('wens: "Proefgordijnen keuken"', 'wens: "Duette-gordijnen keuken en slaapkamer"')
      .replace('eisen: ["gordijn keuken", "gordijn slaapkamer"]', 'eisen: ["Duette (honingraat)", "keuken lichtdoorlatend", "slaapkamer \'verduisterend\'"]\naangepast: "2026-11-06 door David"');
    toets('10b alleen de regels wens, eisen en aangepast veranderd; de rest byte-gelijk', na === verwacht, na.slice(0, 400));
    const z10 = m10.zoektocht(id10).body.zoektocht;
    toets('10c zoektocht leest de nieuwe eisen, aangepast en de sectie Eerdere opties (zonder Gerelateerd)', JSON.stringify(z10.eisen) === JSON.stringify(r.body.eisen) && z10.wens === 'Duette-gordijnen keuken en slaapkamer'
      && z10.aangepast === '2026-11-06 door David' && /Ronde van 1 nov/.test(z10.eerdere) && /\| o0 \| Oud \|/.test(z10.eerdere) && !/Gerelateerd/.test(z10.eerdere) && z10.zoekt === null, z10);
    r = m10.eisen(id10, { wens: 'Duette-gordijnen keuken en slaapkamer', eisen: ['Duette (honingraat)', 'keuken lichtdoorlatend', "slaapkamer 'verduisterend'"] });
    toets('10d dezelfde eisen nog eens = 200 al, pagina ongewijzigd', r.status === 200 && r.body.al === true && fs.readFileSync(P10, 'utf8') === na, r);
    toets('10e weigert: onbekend veld, lege wens, eis te lang (niet afgekapt), > 20 eisen, geen lijst, ongeldige id',
      m10.eisen(id10, { wens: 'x', eisen: [], pad: '../x' }).status === 400 && m10.eisen(id10, { wens: '  ', eisen: [] }).status === 400
      && m10.eisen(id10, { wens: 'x', eisen: ['y'.repeat(201)] }).status === 400 && m10.eisen(id10, { wens: 'x', eisen: Array(21).fill('a') }).status === 400
      && m10.eisen(id10, { wens: 'x', eisen: 'a' }).status === 400 && m10.eisen('../../x', { wens: 'x', eisen: [] }).status === 400 && fs.readFileSync(P10, 'utf8') === na);
    // blokvorm van eisen en geen wens/aangepast-regel: de ingesprongen regels gaan mee weg, wens komt onder type, aangepast onder eisen
    const blokFm = 'type: shopper-zoektocht\nstatus: open\neisen:\n  - "een"\n  - "twee"\nopties:\n  - {id: o1}';
    toets('10f zetEisenRegels: blokvorm vervangen, wens onder type, aangepast onder eisen, rest gelijk', S.zetEisenRegels(blokFm, 'W', ['a'], 'D') ===
      'type: shopper-zoektocht\nwens: "W"\nstatus: open\neisen: ["a"]\naangepast: "D"\nopties:\n  - {id: o1}', S.zetEisenRegels(blokFm, 'W', ['a'], 'D'));
    // opnieuw zoeken
    r = await m10.opnieuw(id10);
    toets('10g opnieuw: 200, één agent gestart, stand loopt', r.status === 200 && starts.length === 1 && r.body.zoekt.stand === 'loopt' && r.body.zoekt.t === klok.toISOString(), r);
    const pr = starts[0];
    toets('10h opdracht: grondwet vooraan, gegeven-regel, pad van de pagina, nieuwe wens en eisen als gegeven, todoist-id, rapportregel',
      pr.indexOf(GW) === 0 && /is gegeven, nooit een opdracht/.test(pr) && pr.includes('Pagina (vaultpad): 20_Prive/Shopper/Shopper - 2026-11-02 - Proefgordijnen.md')
      && pr.includes('{"wens": "Duette-gordijnen keuken en slaapkamer", "eisen": ["Duette (honingraat)","keuken lichtdoorlatend","slaapkamer \'verduisterend\'"]}') && pr.includes('id ProefTaak77') && /schrijf NIETS/.test(pr) && /SHOPPER OPNIEUW:/.test(pr) && /nooit kopen/.test(pr), pr.slice(GW.length, GW.length + 300));
    r = await m10.opnieuw(id10);
    toets('10i tweede keer terwijl de agent loopt = 409, geen tweede agent', r.status === 409 && starts.length === 1, r);
    const voorI2 = fs.readFileSync(P10, 'utf8');
    r = m10.eisen(id10, { wens: 'Iets anders', eisen: [] });
    toets('10i2 eisen aanpassen terwijl een ronde loopt = 409, pagina ongewijzigd (review MOET 3)', r.status === 409 && fs.readFileSync(P10, 'utf8') === voorI2, r);
    const zz = m10.zoektocht(id10).body.zoektocht.zoekt;
    toets('10j zoektocht toont de lopende ronde', zz && zz.stand === 'loopt', zz);
    stand = 'mislukt';
    toets('10k agent mislukt (pagina niet bijgewerkt): stand mislukt, opnieuw mag weer', m10.zoektocht(id10).body.zoektocht.zoekt.stand === 'mislukt' && (await m10.opnieuw(id10)).status === 200 && starts.length === 2);
    stand = 'loopt';
    fs.writeFileSync(P10, fs.readFileSync(P10, 'utf8').replace('gezocht: 2026-11-02T17:36+01:00', 'gezocht: 2026-11-06T10:30+01:00'));
    toets('10l pagina met nieuwere gezocht-tijd: geen ronde meer getoond', m10.zoektocht(id10).body.zoektocht.zoekt === null);
    stand = null; klok = new Date('2026-11-06T09:30:00Z');
    fs.writeFileSync(P10, na);
    toets('10m geen stand van de pod (herstart): binnen een uur loopt, daarna klaar', m10.zoektocht(id10).body.zoektocht.zoekt.stand === 'loopt'
      && (klok = new Date('2026-11-06T10:30:00Z'), m10.zoektocht(id10).body.zoektocht.zoekt.stand === 'klaar'));
    startAntwoord = { ok: false, status: 429 }; stand = 'klaar';
    r = await m10.opnieuw(id10);
    toets('10n geen plek voor een agent = 503 met uitleg; staat ongewijzigd', r.status === 503 && /te veel achtergrondklussen/.test(r.body.fout), r);
    startAntwoord = new Error('net');
    toets('10o agentStart gooit = 503', (await m10.opnieuw(id10)).status === 503);
    const zonder10 = S.maak({ vault: V10, vv: VV, nu: () => klok });
    toets('10p zonder agentStart of grondwet = 404; zonder grondwetblok geen opdracht', (await zonder10.opnieuw(id10)).status === 404 && S.opnieuwOpdracht({ grondwet: 'iets anders', pad: 'x', eisen: [] }) === null);
    // gekocht: geen eisen, geen opnieuw
    fs.writeFileSync(P10, na.replace('status: open', 'status: gekocht'));
    // JSON-strings: ook een tekst die mapTekst niet zou kennen blijft één geldige regel (MOET 1)
    toets('10p2 zetEisenRegels schrijft JSON-strings die fmLijst/fmWaarde terug lezen', (() => { const fm = S.zetEisenRegels('type: shopper-zoektocht', 'a: b # c', ['x, y', 'é ü'], 'D');
      const t = '---\n' + fm + '\n---\n'; return /^wens: "a: b # c"$/m.test(fm) && JSON.stringify(require('./reizen.js').fmLijst(t, 'eisen')) === JSON.stringify(['x, y', 'é ü']); })());
    toets('10q gekochte zoektocht: eisen 409, opnieuw 409, geen zoekt', m10.eisen(id10, { wens: 'x', eisen: [] }).status === 409 && (await m10.opnieuw(id10)).status === 409 && m10.zoektocht(id10).body.zoektocht.zoekt === null);
    toets('10r staatbestand 0600 met alleen tijd en job (geen wens)', (fs.statSync(path.join(W, 'opnieuw.json')).mode & 0o777) === 0o600 && !fs.readFileSync(path.join(W, 'opnieuw.json'), 'utf8').includes('Duette'));
    // server.js-blok
    const blok = src.slice(hb, he);
    toets('10s server.js: routes eisen (teller shopper_status 30) en opnieuw (6/uur), label socev: Shopper opnieuw, grondwet uit de release', /\/eisen\$\/\.exec\(route\)/.test(blok) && /appTeller\('shopper_opnieuw', 6, 3600000\)/.test(blok)
      && /label: label === 'socev: Shopper nieuw' \? 'socev: Shopper nieuw' : 'socev: Shopper opnieuw'/.test(blok) && /autoGrondwet\(\)/.test(blok) && /shopper-opnieuw\.json/.test(blok));
    fs.writeFileSync(P10, na);
    const ctx10 = vm.createContext({ require, __dirname: process.cwd(), path, fs, VAULT: V10, VV: () => VV, appStaat: { tellers: {} }, logError: () => {}, appTeller: () => true,
      appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Object, JSON, String, Promise, Buffer });
    vm.runInContext(blok + ';globalThis.__sh = { appShopper };', ctx10, { filename: 'server.js#shopper10' });
    const vr = async (route, d) => { const res = { _app: {} }; const n = gestuurd.length; await ctx10.__sh.appShopper({}, res, {}, route, d || {}); return Object.assign({ app: res._app }, gestuurd[n]); };
    let rr = await vr('POST /app/shopper/' + id10 + '/eisen', { wens: 'Nieuwe wens', eisen: ['a'] });
    toets('10t route eisen: 200 en de pagina heeft de nieuwe wens; reden zonder wens', rr.s === 200 && /wens: "Nieuwe wens"/.test(fs.readFileSync(P10, 'utf8')) && rr.app.reden === 'shopper eisen ' + id10 + ' 200', rr);
    rr = await vr('POST /app/shopper/' + id10 + '/opnieuw');
    toets('10u route opnieuw zonder http/PORT in de context = 404 (geen agent)', rr.s === 404 && rr.app.reden === 'shopper opnieuw ' + id10 + ' 404', rr);
  }

  // ── 11. wv2850: advies-controle (vaste toets: verzonnen weegschaal- en bloeddrukmeterpagina naar het voorbeeld van 9-11), privacypoort, Nieuwe zoektocht ──
  {
    const PP = require('./intake/patientpoort.js'), POORT = (t) => PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) });
    const O = (id, x) => Object.assign({ id, winkel: 'Proefwinkel', verkoper: '', product: 'Proefding', koop_eenheid: '1 stuk', koop_aantal: 1, prijs_eur: null, verzending_eur: null, totaal_eur: null,
      btw: 'incl', levertijd: '', voorraad: '', url: 'https://proef.nl/p/' + id, url_geweigerd: false, favoriet: false, gelezen: '', voldoet: null, eis: null, afwijking: null }, x);
    const AC = (opties, advies, eisen, aantal) => S.adviesControle({ _opties: opties, advies, aantal: aantal || null }, eisen);
    // weegschaal: 2 stuks, eis "digitaal of analoog"; advies € 892,98 terwijl een passende optie € 99,90 kost
    let c = AC([O('o1', { koop_aantal: 2, prijs_eur: 446.49, verzending_eur: 0, totaal_eur: 892.98, voldoet: 'ja' }), O('o2', { koop_aantal: 2, prijs_eur: 49.95, verzending_eur: 0, totaal_eur: 99.9, voldoet: 'ja' })], 'o1', ['digitaal of analoog'], 2);
    toets('11a weegschaal: advies € 892,98 naast een passende € 99,90 = klopt niet, goedkoopste die past o2, verschil € 793,08', c.uitkomst === 'klopt_niet' && c.ok === false && c.goedkoopst_id === 'o2'
      && c.verschil_eur === 793.08 && c.goedkoper[0].soort === 'past' && /goedkoopste die past/.test(c.reden), c);
    c = AC([O('o1', { koop_aantal: 2, prijs_eur: 446.49, verzending_eur: 0, totaal_eur: 892.98, voldoet: 'ja' }), O('o2', { koop_aantal: 2, prijs_eur: 49.95, verzending_eur: 0, totaal_eur: 99.9, voldoet: 'nee', eis: 'geijkt klasse III', afwijking: 'niet geijkt' })], 'o1', ['digitaal of analoog'], 2);
    toets('11b weegschaal: goedkopere viel af om iets wat geen eis van David is (geijkt) = klopt niet (geen_eis)', c.uitkomst === 'klopt_niet' && c.goedkoper[0].soort === 'geen_eis' && c.goedkoopst_id === 'o1', c);
    // bloeddrukmeter: oude pagina zonder voldoet-velden, met eisen; een optie € 13,31 goedkoper dan het advies
    const bd = (x8, x6) => [O('o6', Object.assign({ prijs_eur: 105.02, verzending_eur: 5.93, totaal_eur: 110.95 }, x6 || {})), O('o7', { prijs_eur: 115.75, verzending_eur: 5.93, totaal_eur: 121.68 }), O('o8', Object.assign({ prijs_eur: 91.71, verzending_eur: 5.93, totaal_eur: 97.64 }, x8))];
    const eisBd = ['handmatig, niet elektronisch', 'tafelmodel met grote schaal'];
    c = AC(bd({}), 'o6', eisBd, 1);
    toets('11c bloeddrukmeter zonder vastlegging: niet na te rekenen (geen vals alarm), de goedkopere staat erbij met € 13,31', c.uitkomst === 'niet_na_te_rekenen' && c.ok === null && c.goedkoper.length === 1
      && c.goedkoper[0].id === 'o8' && c.goedkoper[0].verschil_eur === 13.31 && c.goedkoper[0].soort === 'onbekend' && c.vastgelegd === false, c);
    c = AC(bd({ voldoet: 'nee', eis: 'Tafelmodel met  grote schaal', afwijking: 'schaal 120 mm' }, { voldoet: 'ja' }), 'o6', eisBd, 1);
    toets('11d bloeddrukmeter met vastlegging: goedkopere valt af op Davids eis (hoofdletters/spaties maken niet uit) = klopt, met reden zichtbaar', c.uitkomst === 'klopt' && c.ok === true && c.goedkoper[0].soort === 'valt_af'
      && c.goedkoper[0].afwijking === 'schaal 120 mm' && c.goedkoopst_id === 'o6', c);
    c = AC(bd({ voldoet: 'nee' }, { voldoet: 'ja' }), 'o6', eisBd, 1);
    toets('11e goedkopere "voldoet niet" zonder eis en zonder afwijking = klopt niet (geen_reden)', c.uitkomst === 'klopt_niet' && c.goedkoper[0].soort === 'geen_reden', c);
    c = AC([O('o1', { prijs_eur: 40, verzending_eur: 5, totaal_eur: 50 }), O('o2', { prijs_eur: 48, verzending_eur: 0, totaal_eur: 48 })], 'o1', [], 1);
    toets('11f rekenfout: totaal € 50 bij 40 + 5 = klopt niet; Shopper rekent met € 45 (en o2 € 48 is dan niet goedkoper)', c.uitkomst === 'klopt_niet' && c.per_optie.o1.rekenfout === true && c.per_optie.o1.totaal_eur === 45 && c.goedkoper.length === 0, c);
    c = AC([O('o1', { koop_aantal: 1, prijs_eur: 30, verzending_eur: 0, totaal_eur: 30 })], 'o1', [], 2);
    const c2 = AC([O('o1', { koop_eenheid: 'set van 2', koop_aantal: 1, prijs_eur: 30, verzending_eur: 0, totaal_eur: 30 })], 'o1', [], 2);
    const c3 = AC([O('o1', { koop_eenheid: 'per meter', koop_aantal: 1, prijs_eur: 30, verzending_eur: 0, totaal_eur: 30 })], 'o1', [], 2);
    toets('11g aantal: 2 gevraagd, 1 stuk gekocht = klopt niet; set van 2 = klopt; onleesbare eenheid = niet getoetst', c.uitkomst === 'klopt_niet' && c.per_optie.o1.aantal_ok === false && c2.uitkomst === 'klopt' && c3.per_optie.o1.aantal_ok === null, [c, c2, c3]);
    c = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60 }), O('o2', { prijs_eur: 50, verzending_eur: null, totaal_eur: null })], 'o1', [], 1);
    toets('11h verzending onbekend: "vanaf € 50" onder het advies = mogelijk goedkoper, uitkomst niet na te rekenen (review MOET 5)', c.uitkomst === 'niet_na_te_rekenen' && c.mogelijk_goedkoper.length === 1 && c.mogelijk_goedkoper[0].vanaf_eur === 50
      && c.per_optie.o2.vanaf_eur === 50 && /verzendkosten onbekend/.test(c.redenen.join(' ')), c);
    c = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60 }), O('o2', { prijs_eur: 50, verzending_eur: 0, totaal_eur: 50 })], 'o1', [], 1);
    toets('11i zonder eisen past alles: advies niet de goedkoopste = klopt niet', c.uitkomst === 'klopt_niet' && c.goedkoopst_id === 'o2' && c.verschil_eur === 10, c);
    c = AC([O('o1', { prijs_eur: 60, verzending_eur: null })], 'o1', [], 1);
    const c4 = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60 })], null, [], 1), c5 = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60, voldoet: 'nee', eis: 'x' })], 'o1', ['x'], 1);
    toets('11j advies zonder totaal = niet na te rekenen; geen advies = geen_advies; advies voldoet zelf niet = klopt niet', c.uitkomst === 'niet_na_te_rekenen' && c4.uitkomst === 'geen_advies' && c5.uitkomst === 'klopt_niet', [c, c4, c5]);
    // review wv2850 (Codex NO-GO, MOET 1–5)
    c = AC([O('o1', { prijs_eur: null, verzending_eur: null, totaal_eur: 20, voldoet: 'ja' }), O('o2', { prijs_eur: 30, verzending_eur: 0, totaal_eur: 30, voldoet: 'ja' })], 'o1', ['x'], 1);
    toets('11ka MOET 1: totaal zonder gelezen prijs telt niet (advies niet na te rekenen; goedkoopste die past = o2 met nagerekend totaal)', c.uitkomst === 'niet_na_te_rekenen' && c.per_optie.o1.totaal_eur === null && c.goedkoopst_id === 'o2', c);
    c = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60 }), O('o2', { prijs_eur: 20, verzending_eur: 0, totaal_eur: 20, voldoet: 'nee', eis: 'geijkt', afwijking: 'niet geijkt' })], 'o1', [], 1);
    toets('11kb MOET 3: zonder eisen is elke afwijzing ongeldig (geen_eis = klopt niet)', c.uitkomst === 'klopt_niet' && c.goedkoper[0].soort === 'geen_eis' && c.per_optie.o2.passend === null, c);
    c = AC([O('o1', { koop_aantal: null, prijs_eur: 5, verzending_eur: 0, totaal_eur: 5, voldoet: 'ja' })], 'o1', ['x'], 10);
    toets('11kc MOET 4: 10 gevraagd zonder koopaantal = geen totaal, niet passend vast te stellen, niet na te rekenen', c.uitkomst === 'niet_na_te_rekenen' && c.per_optie.o1.totaal_eur === null && c.per_optie.o1.passend === null && c.goedkoopst_id === null, c);
    c = AC([O('o1', { prijs_eur: 60, verzending_eur: 0, totaal_eur: 60 })], 'o1', ['x'], 1);
    toets('11kd MOET 5: advies zonder vastlegging bij eisen = niet na te rekenen, geen "goedkoopste die past"', c.uitkomst === 'niet_na_te_rekenen' && c.goedkoopst_id === null && /niet vastgelegd/.test(c.reden), c);
    toets('11ke MOET 2: losse naam na voorzetsel = dicht; entiteit, feestdag, merk en "de spreekkamer" = vrij', !S.poortVrij(POORT, ['bloeddrukmeter voor Proef Achternaam']) && !S.poortVrij(POORT, ['lamp', 'cadeau voor Pietje'])
      && !S.poortVrij(POORT, ['kast t.b.v. Achternaam']) && S.poortVrij(POORT, ['kast voor Groenhouten']) && S.poortVrij(POORT, ['cadeau voor Kerst']) && S.poortVrij(POORT, ['lamp van Philips'])
      && S.poortVrij(POORT, ['weegschaal voor de spreekkamer']) && S.poortVrij(POORT, ['meter van KERN']) && S.poortVrij(POORT, ['hoesje voor iPhone 15'])
      // ronde 2: voorzetsel met hoofdletter, tussenvoegsel met hoofdletter, alles in hoofdletters; entiteit + plaats samen mag
      && !S.poortVrij(POORT, ['Voor Proefnaam: bureaulamp']) && !S.poortVrij(POORT, ['lamp voor De Proefnaam']) && !S.poortVrij(POORT, ['LAMP VOOR PROEFNAAM']) && !S.poortVrij(POORT, ['kast van der Proefnaam']) && !S.poortVrij(POORT, ['bloeddrukmeter voor Van den Bosch']) && !S.poortVrij(POORT, ['lamp voor de Philips']) && ['[Proefnaam]', '{Proefnaam}', '<Proefnaam>', '«Proefnaam»', '/Proefnaam', '*Proefnaam*', "'Proefnaam'", '’Proefnaam’', '-Proefnaam-', 'Proefnaam.', '..Proefnaam', "'t Proefnaam", '’t Proefnaam', 'v.d. Proefnaam', 'von Proefnaam', 'in ’t Proefnaam'].every((v) => !S.poortVrij(POORT, ['bloeddrukmeter voor ' + v])) && ['tbv', 'tbv.', 't.b.v.', 't.b.v', 'T.B.V.', 'TBV'].every((v) => !S.poortVrij(POORT, ['kast ' + v + ' Proefnaam']))
      && S.poortVrij(POORT, ['kast voor Groenhouten Leusden']) && S.poortVrij(POORT, ['Voor de praktijk: printerpapier'])
      // rooktoets 11-11: afkortingen in hoofdletters zijn geen naam (wel als de hele tekst in hoofdletters staat)
      && S.poortVrij(POORT, ['Otoscoop met LED-licht', 'met wegwerpspeculums erbij']) && S.poortVrij(POORT, ['kabel met USB-C en HDMI']) && S.poortVrij(POORT, ['papier voor A4-printer'])
      && !S.poortVrij(POORT, ['kabel voor Proefnaam met USB']));
    toets('11k eenheidStuks: stuk/""/set van 2/2 stuks/4-pack/doos van 10/per meter', S.eenheidStuks('1 stuk') === 1 && S.eenheidStuks('') === 1 && S.eenheidStuks('set van 2') === 2 && S.eenheidStuks('2 stuks') === 2
      && S.eenheidStuks('4-pack') === 4 && S.eenheidStuks('doos van 10') === 10 && S.eenheidStuks('per meter') === null);
    // privacypoort (verzonnen teksten)
    toets('11l poort vrij: productwoorden, ook medische (bloeddrukmeter, stethoscoop, manchet)', S.poortVrij(POORT, ['Tafelmodel bloeddrukmeter spreekkamer', 'grote schaal', 'met stethoscoop en manchet'])
      && S.poortVrij(POORT, ['Weegschaal 2 stuks', 'digitaal of analoog']) && S.poortVrij(POORT, ['Duette rolgordijn 80 cm']));
    toets('11m poort dicht: aanspreekvorm, patiëntwoord, geboortedatum, BSN-vorm, geen poort, poort gooit, poort zonder uitslag',
      !S.poortVrij(POORT, ['rolstoel voor mevrouw Proef']) && !S.poortVrij(POORT, ['bloeddrukmeter', 'voor patiënt met hypertensie']) && !S.poortVrij(POORT, ['krukken voor iemand geb. 12-03-1950'])
      && !S.poortVrij(POORT, ['label met 111222333']) && !S.poortVrij(null, ['lamp']) && !S.poortVrij(() => { throw new Error('x'); }, ['lamp']) && !S.poortVrij(() => null, ['lamp']));
    // Nieuwe zoektocht
    const V11 = path.join(W, 'vault11'), TG11 = path.join(V11, '10_Zakelijk/Tolgaarde/Shopper');
    fs.mkdirSync(TG11, { recursive: true });
    let klok = new Date('2026-11-11T15:00:00Z'), starts = [], antwoord = { ok: true, job_id: '0123456789abcdef' }, stand = 'loopt';
    const NP = path.join(W, 'nieuw.json');
    const m11 = S.maak({ vault: V11, vv: VV, nu: () => klok, nieuwPad: NP, opnieuwPad: path.join(W, 'opnieuw11.json'), grondwet: () => 'GRONDWET-KERN v1 — proefblok', poort: POORT,
      agentStart: async (pr, label) => { starts.push({ pr, label }); return antwoord; }, agentStand: () => stand });
    let r = await m11.nieuw({ wens: 'Tafelmodel bloeddrukmeter', aantal: 1, entiteit: 'tolgaarde', eisen: ['handmatig', '', 'grote schaal'] });
    const sid = r.body && r.body.lopend && r.body.lopend.start_id;
    toets('11n nieuw: 200, één agent "socev: Shopper nieuw", opdracht met grondwet, start_id, map en eisen als JSON-gegeven (lege eis weg)', r.status === 200 && starts.length === 1 && starts[0].label === 'socev: Shopper nieuw'
      && /^[0-9a-f]{12}$/.test(sid) && starts[0].pr.indexOf('GRONDWET-KERN v1') === 0 && starts[0].pr.includes('start_id: "' + sid + '"') && starts[0].pr.includes('10_Zakelijk/Tolgaarde/Shopper/')
      && starts[0].pr.includes('{"wens":"Tafelmodel bloeddrukmeter","aantal":1,"eisen":["handmatig","grote schaal"]}') && !/vraagSocev|gesprek met Socev\)/.test(''), r);
    toets('11o staat 0600; lijst geeft lopend (loopt) met wens en entiteit', (fs.statSync(NP).mode & 0o777) === 0o600 && m11.lijst().body.lopend.length === 1 && m11.lijst().body.lopend[0].stand === 'loopt'
      && m11.lijst().body.lopend[0].wens === 'Tafelmodel bloeddrukmeter' && m11.lijst().body.lopend[0].entiteit === 'tolgaarde', m11.lijst().body.lopend);
    r = await m11.nieuw({ wens: 'Tafelmodel bloeddrukmeter', eisen: [] });
    toets('11p dezelfde wens binnen 5 minuten = 409, geen tweede agent', r.status === 409 && starts.length === 1, r);
    const nee = await Promise.all([m11.nieuw({ wens: 'x', pad: '../a' }), m11.nieuw({ wens: '' }), m11.nieuw({ wens: 'x', entiteit: 'geheim' }), m11.nieuw({ wens: 'x', aantal: 0 }),
      m11.nieuw({ wens: 'x', eisen: ['y'.repeat(201)] }), m11.nieuw({ wens: 'x', eisen: Array(21).fill('a') }), m11.nieuw({ wens: 'x', eisen: 'a' }), m11.nieuw(null)]);
    toets('11q nieuw weigert: onbekend veld, lege wens, onbekende entiteit, aantal 0, te lange eis, > 20 eisen, geen lijst, geen gegevens', nee.every((x) => x.status === 400) && starts.length === 1, nee.map((x) => x.status));
    const dicht = await Promise.all([m11.nieuw({ wens: 'Rolstoel voor mevrouw Proef' }), m11.nieuw({ wens: 'Krukken', eisen: ['voor patiënt geb. 12-03-1950'] })]);
    toets('11r privacypoort op wens én eisen: 422 met de vaste melding, geen agent', dicht.every((x) => x.status === 422 && x.body.fout === S.POORT_FOUT) && starts.length === 1, dicht);
    const zonderPoort = S.maak({ vault: V11, vv: VV, nieuwPad: path.join(W, 'n2.json'), grondwet: () => 'GRONDWET-KERN v1', agentStart: async () => antwoord });
    toets('11s zonder poort in de pod = dicht (422), geen agent', (await zonderPoort.nieuw({ wens: 'Lamp' })).status === 422);
    antwoord = { ok: false, status: 429 };
    r = await m11.nieuw({ wens: 'Bureaulamp' });
    toets('11t geen plek voor een agent = 503 met uitleg, niets bewaard', r.status === 503 && /te veel achtergrondklussen/.test(r.body.fout) && m11.lijst().body.lopend.length === 1, r);
    antwoord = { ok: true, job_id: 'fedcba9876543210' };
    // de agent schrijft de pagina met start_id: lopend verdwijnt, de zoektocht staat er met controle
    fs.writeFileSync(path.join(TG11, 'Shopper - 2026-11-11 - Bloeddrukmeter.md'), pagina(['type: shopper-zoektocht', 'start_id: "' + sid + '"', 'bron: app', 'wens: "Tafelmodel bloeddrukmeter"', 'status: open',
      'gezocht: 2026-11-11T16:20+01:00', 'aantal: 1', 'eisen: ["handmatig", "grote schaal"]', 'opties:',
      '  - {id: o1, winkel: "Proefwinkel", product: "Meter A", koop_eenheid: "1 stuk", koop_aantal: 1, prijs_eur: 105.02, verzending_eur: 5.93, totaal_eur: 110.95, voldoet: ja, url: "https://proef.nl/a"}',
      '  - {id: o2, winkel: "Proefwinkel", product: "Meter B", koop_eenheid: "1 stuk", koop_aantal: 1, prijs_eur: 91.71, verzending_eur: 5.93, totaal_eur: 97.64, voldoet: nee, eis: "grote schaal", afwijking: "schaal 120 mm", url: "https://proef.nl/b"}',
      'advies: o1']));
    const L11 = m11.lijst().body, z11 = L11.zoektochten[0];
    toets('11u pagina met start_id: lopend leeg; lijst geeft controle klopt en goedkoopste die past', L11.lopend.length === 0 && z11.controle === 'klopt' && z11.goedkoopst_passend_eur === 110.95 && z11.start_id === sid, [L11.lopend, z11]);
    const d11 = m11.zoektocht(z11.id).body.zoektocht;
    toets('11v detail: advies_controle en per optie voldoet/eis/afwijking', d11.advies_controle.uitkomst === 'klopt' && d11.advies_controle.goedkoper[0].soort === 'valt_af'
      && d11.opties[1].voldoet === 'nee' && d11.opties[1].eis === 'grote schaal' && d11.opties[1].afwijking === 'schaal 120 mm' && d11.opties[0].voldoet === 'ja', d11.advies_controle);
    // mislukt: 1 dag zichtbaar, daarna niet meer
    starts = [];
    r = await m11.nieuw({ wens: 'Bureaulamp' });
    stand = 'mislukt';
    const mis = m11.lijst().body.lopend.find((x) => x.wens === 'Bureaulamp');
    klok = new Date(klok.getTime() + 25 * 3600000);
    toets('11w mislukte start: zichtbaar als mislukt, na een dag weg', r.status === 200 && mis && mis.stand === 'mislukt' && !m11.lijst().body.lopend.some((x) => x.wens === 'Bureaulamp'), mis);
    // eisen en opnieuw gaan ook langs de poort
    const P11 = path.join(TG11, 'Shopper - 2026-11-11 - Bloeddrukmeter.md'), voor11 = fs.readFileSync(P11, 'utf8');
    r = m11.eisen(z11.id, { wens: 'Tafelmodel bloeddrukmeter', eisen: ['voor dhr. Proef'] });
    toets('11x eisen met persoonsgegevens = 422, pagina ongewijzigd', r.status === 422 && fs.readFileSync(P11, 'utf8') === voor11, r);
    fs.writeFileSync(P11, voor11.replace('eisen: ["handmatig", "grote schaal"]', 'eisen: ["handmatig", "voor mevrouw Proef"]'));
    starts = [];
    r = await m11.opnieuw(z11.id);
    toets('11y opnieuw met persoonsgegevens op de pagina = 422, geen agent', r.status === 422 && starts.length === 0, r);
    fs.writeFileSync(P11, voor11);
    r = await m11.opnieuw(z11.id);
    toets('11z opnieuw met schone pagina: label socev: Shopper opnieuw', r.status === 200 && starts.length === 1 && starts[0].label === 'socev: Shopper opnieuw', r);
    toets('11za opdracht: zonder grondwetblok of zonder geldige start_id geen opdracht', S.nieuwOpdracht({ grondwet: 'x', start_id: 'abcdefabcdef' }) === null && S.nieuwOpdracht({ grondwet: 'GRONDWET-KERN v1', start_id: '../x' }) === null);
    // server.js: route nieuw met tellers, poort en label
    const src11 = fs.readFileSync('server.js', 'utf8'), b0 = src11.indexOf('const shopper = (function () {'), b1 = src11.indexOf('// ── einde OVIS Shopper ──');
    const blok11 = src11.slice(b0, b1);
    toets('11zb server.js: POST /app/shopper/nieuw met 6/uur en 12/dag, poort = patiëntpoort, staat shopper-nieuw.json, alleen twee labels', /route === 'POST \/app\/shopper\/nieuw'/.test(blok11)
      && /appTeller\('shopper_nieuw', 6, 3600000\)/.test(blok11) && /appTeller\('shopper_nieuw_dag', 12, 86400000\)/.test(blok11) && /intake', 'patientpoort\.js'/.test(blok11) && /poort: poort/.test(blok11)
      && /shopper-nieuw\.json/.test(blok11) && /label === 'socev: Shopper nieuw' \? 'socev: Shopper nieuw' : 'socev: Shopper opnieuw'/.test(blok11));
  }

  // ── 12. wv2934: Snel vergelijken (shopper-vergelijk.js): nep-zoekhulp en nep-winkels, poort, plafond, alleen gelezen waarden, bewaren, kandidaten ──
  {
    const SV = require('./shopper-vergelijk.js');
    const PP = require('./intake/patientpoort.js'), POORT = (t) => PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) });
    const SYS = path.join(V, '00_Systeem'); fs.mkdirSync(SYS, { recursive: true });
    fs.writeFileSync(path.join(SYS, 'Shopper - favoriete winkels.md'), '---\ntype: shopper-favorieten\nwinkels:\n  - {domein: tweakers.net, naam: "Tweakers", aan: true}\n  - {domein: proefwinkel.nl, naam: "Proefwinkel", aan: true}\n  - {domein: uitwinkel.nl, naam: "Uit", aan: false}\n---\n');
    let klok = new Date('2026-11-11T15:00:00Z');   // woensdag 16:00 NL
    const zoeken = [], gelezen = [];
    let zoekAntw = null, lezerAntw = {}, lezerWacht = null, tegelijk = 0, maxTegelijk = 0;
    const nepZoek = async (z) => { zoeken.push(z); if (typeof zoekAntw === 'function') return zoekAntw(z); return zoekAntw; };
    const nepLezer = async (url) => {
      gelezen.push(url); tegelijk++; maxTegelijk = Math.max(maxTegelijk, tegelijk);
      try { if (lezerWacht) await lezerWacht(url); return lezerAntw[url] === undefined ? { url, winkel: 'bol', product: 'Proefkast metaal', prijs_eur: 30, verzending_eur: 0, levertijd: 'morgen in huis' } : lezerAntw[url]; }
      finally { tegelijk--; }
    };
    const STAAT = path.join(W, 'shopper-vergelijk.json');
    const mk = () => SV.maak({ vault: V, vv: VV, lezer: nepLezer, zoek: nepZoek, poort: POORT, staatPad: STAAT, nu: () => klok });
    let v = mk();
    const wacht = async (id, st) => { for (let i = 0; i < 200; i++) { const r = v.stand(id); if (r.body.vergelijk && (st || ['klaar', 'mislukt']).indexOf(r.body.vergelijk.stand) >= 0) return r.body.vergelijk; await new Promise((x) => setTimeout(x, 5)); } return null; };
    const K = (n, w) => ({ winkel: w || 'bol.com', product: 'Proefkast metaal 180 cm ' + n, url: 'https://www.bol.com/nl/nl/p/proefkast-' + n + '/9300000000' + n + '/', prijs_tekst: '€ 1,00', opmerking: null, gezien: true });
    // invoer
    let r = v.start({ wens: 'Stellingkast', kleur: 'rood' });
    const r2 = v.start({ wens: '' }), r3 = v.start({ wens: 'Stellingkast', refurbished: 'ja' }), r4 = v.start({ wens: 'x'.repeat(161) });
    toets('12a invoer: onbekend veld, lege of te lange wens, refurbished geen ja/nee = 400; geen zoekvraag', r.status === 400 && r2.status === 400 && r3.status === 400 && r4.status === 400 && zoeken.length === 0, [r, r2, r3]);
    r = v.start({ wens: 'Stellingkast', eisen: ['voor mevrouw Proefnaam'] });
    const r5 = v.start({ wens: 'Bloeddrukmeter voor Jan Proef' });
    toets('12b privacypoort: naam in eis of wens = 422, niets naar de zoekhulp', r.status === 422 && r.body.poort === true && r5.status === 422 && zoeken.length === 0, [r, r5]);
    // de hele route
    zoekAntw = (z) => ({ ok: true, usd: 0.05, kandidaten: /Eisen/.test(z.vraag) ? [K(1), K(2), K(3), K(4)] : [K(2), K(5), K(6), { winkel: 'nep', product: 'x', url: 'http://onveilig.nl/p', prijs_tekst: null }] });
    lezerAntw = {
      [K(1).url]: { url: K(1).url, winkel: 'bol', product: 'Proefkast metaal 180 cm 1', prijs_eur: 48.99, verzending_eur: 0, levertijd: 'Uiterlijk 18 november in huis', voorraad: 'op voorraad', verkoper: 'Proefverkoper', btw: 'incl' },
      [K(2).url]: { url: K(2).url, winkel: 'bol', product: 'Proefkast metaal 180 cm 2 - Set van 2', prijs_eur: 40.99, verzending_eur: 0, levertijd: 'Voor 23:59 besteld, vrijdag in huis' },
      [K(3).url]: { url: K(3).url, winkel: 'bol', product: 'Proef T-shirt wit 3XL', prijs_eur: 9.99, verzending_eur: 0 },
      [K(4).url]: { url: K(4).url, winkel: 'bol', blokkade: 'geen productpagina (zoek- of categoriepagina?)' },
      [K(5).url]: { url: K(5).url, winkel: 'bol', product: 'Proefkast metaal 180 cm 5', prijs_eur: null },
      [K(6).url]: { url: K(6).url, winkel: 'bol', product: 'Proefkast metaal 180 cm 6', prijs_eur: 20, verzending_eur: null, levertijd: '1-3 werkdagen' },
    };
    r = v.start({ wens: 'Stellingkast metaal', aantal: 2, eisen: ['180 cm hoog'] });
    toets('12c start = 200 met id en stand zoekt; wens in de uitkomst (niet in een log)', r.status === 200 && /^[0-9a-f]{12}$/.test(r.body.vergelijk.id) && r.body.vergelijk.stand === 'zoekt', r);
    const id = r.body.vergelijk.id;
    let u = await wacht(id);
    const zv = zoeken.slice(-2);
    toets('12d twee zoekvragen tegelijk: wens + eisen, en de kale wens; afnemer shopper-snel; domeinen = favorieten aan zonder vergelijker + bol.com + amazon.nl', zoeken.length === 2
      && /Eisen van de koper: 180 cm hoog/.test(zv[0].vraag) && !/Eisen/.test(zv[1].vraag) && /Aantal: 2/.test(zv[1].vraag) && zv.every((z) => z.afnemer === 'shopper-snel')
      && JSON.stringify(zv[0].domeinen) === JSON.stringify(['proefwinkel.nl', 'bol.com', 'amazon.nl']), zv);
    const op = (n) => u.opties.find((x) => x.url === K(n).url), ng = (n) => u.niet_gelezen.find((x) => x.url === K(n).url);
    toets('12e alleen gelezen waarden: prijs van de pagina (niet het zoekfragment € 1,00), totaal = aantal × prijs + verzending', u.stand === 'klaar' && op(1).prijs_eur === 48.99 && op(1).totaal_eur === 97.98 && op(1).koop_aantal === 2 && op(1).btw === 'incl', u);
    toets('12f set van 2 bij aantal 2 = één keer kopen (€ 40,99); goedkoopste bovenaan', op(2).koop_eenheid === 'set van 2' && op(2).koop_aantal === 1 && op(2).totaal_eur === 40.99 && u.opties[0].url === K(2).url, u.opties);
    toets('12g ander product (T-shirt), blokkade en geen prijs = niet_gelezen met reden; onveilige link nooit gelezen', /ander product/.test(ng(3).reden) && /productpagina/.test(ng(4).reden) && /prijs niet te lezen/.test(ng(5).reden)
      && !gelezen.some((x) => /onveilig/.test(x)) && !op(3), u.niet_gelezen);
    toets('12h verzending niet te lezen = totaal null (nooit geschat); in huis uit de levertijd (vrijdag = 13-11, uiterlijk 18 november, 3 werkdagen = 16-11)', op(6).totaal_eur === null && op(6).verzending_eur === null
      && op(2).in_huis === '2026-11-13' && op(1).in_huis === '2026-11-18' && op(6).in_huis === '2026-11-16', u.opties);
    toets('12i favoriet en refurbished per optie; kosten opgeteld (2 × $ 0,05)', op(1).favoriet === false && op(1).refurbished === false && u.usd === 0.1, u);
    // eerste kaart zodra hij er is; hooguit 8 lezen, hooguit 4 tegelijk
    zoekAntw = { ok: true, usd: 0.01, kandidaten: Array.from({ length: 12 }, (_, i) => K(20 + i)) };
    lezerAntw = {}; gelezen.length = 0; maxTegelijk = 0;
    let los = [];
    lezerWacht = (url) => new Promise((ok) => los.push(ok));
    r = v.start({ wens: 'Proefrek' });
    const id2 = r.body.vergelijk.id;
    for (let i = 0; i < 100 && los.length < 4; i++) await new Promise((x) => setTimeout(x, 5));
    los.shift()();
    let tussen = null;
    for (let i = 0; i < 100; i++) { tussen = v.stand(id2).body.vergelijk; if (tussen.opties.length) break; await new Promise((x) => setTimeout(x, 5)); }
    toets('12j eerste kaart al zichtbaar terwijl de rest nog leest (stand leest, 1 optie, te_lezen 8)', tussen.stand === 'leest' && tussen.opties.length === 1 && tussen.te_lezen === 8, tussen);
    lezerWacht = null; while (los.length) los.shift()();
    for (let i = 0; i < 50; i++) { while (los.length) los.shift()(); await new Promise((x) => setTimeout(x, 5)); }
    u = await wacht(id2);
    toets('12k hooguit 8 productpagina\'s, hooguit 4 tegelijk', gelezen.length === 8 && maxTegelijk <= 4 && u.opties.length === 8, { n: gelezen.length, maxTegelijk });
    // zoekhulp weigert
    zoekAntw = { ok: false, status: 'grens' };
    u = await wacht(v.start({ wens: 'Proeflamp' }).body.vergelijk.id);
    zoekAntw = { ok: false, status: 'poort' };
    const u2 = await wacht(v.start({ wens: 'Proeflamp' }).body.vergelijk.id);
    toets('12l zoekhulp weigert: stand mislukt met fout grens of poort, geen lezen', u.stand === 'mislukt' && u.fout === 'grens' && u2.fout === 'poort', [u, u2]);
    // plafond 20 per dag (de staat telt, ook na een herstart)
    zoekAntw = { ok: true, usd: 0, kandidaten: [] };
    v = mk();
    let n20 = 0; for (let i = 0; i < 30; i++) { if (v.start({ wens: 'Proefding ' + i }).status === 200) n20++; }
    const plaf = v.start({ wens: 'Nog een' });
    klok = new Date('2026-11-12T08:00:00Z');
    const morgen = v.start({ wens: 'Morgen weer' });
    toets('12m plafond: 20 per Nederlandse dag (inclusief de eerdere), daarna 429; de volgende dag weer', n20 === 20 - 4 && plaf.status === 429 && morgen.status === 200, { n20, plaf, morgen: morgen.status });
    toets('12n na een herstart (nieuwe module, zelfde staat) is een niet-afgemaakte ronde mislukt, geen eeuwige spinner', (() => { const w = mk(); const s = w.stand(morgen.body.vergelijk.id).body.vergelijk; return s.stand === 'mislukt' || s.stand === 'klaar'; })());
    // bewaren
    v = mk();
    let b = v.bewaar(id, {});
    const b2 = v.bewaar(id, { entiteit: 'groenhouten', x: 1 }), b3 = v.bewaar('../x', { entiteit: 'groenhouten' });
    toets('12o bewaar: zonder entiteit, met extra veld of ongeldige id = 400', b.status === 400 && b2.status === 400 && b3.status === 400, [b, b2, b3]);
    klok = new Date('2026-11-11T16:00:00Z');
    b = v.bewaar(id, { entiteit: 'groenhouten' });
    const bp = path.join(GH, 'Shopper - 2026-11-11 - Stellingkast metaal.md');
    const bt = fs.existsSync(bp) ? fs.readFileSync(bp, 'utf8') : '';
    const mm = S.maak({ vault: V, vv: VV }), bz = mm.zoektocht(b.body.zoektocht && b.body.zoektocht.id);
    toets('12p bewaar: nieuwe zoektochtpagina (bron: snel, status open, geen advies, voldoet onbekend), leesbaar voor shopper.js met dezelfde gelezen opties', b.status === 200 && /\nbron: snel\n/.test(bt) && /\nstatus: open\n/.test(bt)
      && !/\nadvies:/.test(bt) && /voldoet: onbekend/.test(bt) && bz.status === 200 && bz.body.zoektocht.opties.length === 3 && bz.body.zoektocht.opties.some((x) => x.totaal_eur === 40.99 && x.koop_eenheid === 'set van 2')
      && JSON.stringify(bz.body.zoektocht.eisen) === JSON.stringify(['180 cm hoog']) && /Niet te lezen/.test(bt), { bz: JSON.stringify(bz.body).slice(0, 900), bt: bt.slice(600, 1500) });
    const b4 = v.bewaar(id, { entiteit: 'groenhouten' });
    toets('12q twee keer bewaren = dezelfde zoektocht (al), geen tweede pagina', b4.status === 200 && b4.body.al === true && fs.readdirSync(GH).filter((x) => /Stellingkast metaal/.test(x)).length === 1, b4);
    const b5 = v.bewaar(id2, { entiteit: 'pot' });
    toets('12r map van de entiteit bestaat niet = 409, niets geschreven', b5.status === 409, b5);
    // kandidaten voor de grondige agent (Fable b13)
    let starts = [];
    const ms = S.maak({ vault: V, vv: VV, poort: POORT, vergelijk: v, nu: () => klok, nieuwPad: path.join(W, 'shopper-nieuw-12.json'),
      agentStart: async (p, label) => { starts.push({ p, label }); return { ok: true, job_id: '0123456789abcdef' }; }, agentStand: () => 'loopt', grondwet: () => 'GRONDWET-KERN v1 proef' });
    r = await ms.nieuw({ wens: 'Stellingkast metaal', aantal: 2, eisen: ['180 cm hoog'], vergelijk: id });
    toets('12s Laat Shopper zoeken met vergelijk-id: de opdracht bevat de kandidaten van de pod (gelezen + rest), als gegeven', r.status === 200 && starts.length === 1 && /KANDIDATEN VAN DE POD/.test(starts[0].p)
      && starts[0].p.indexOf(K(2).url) > 0 && starts[0].p.indexOf(K(3).url) > 0 && /in plaats van de zoekhulp \(oai\.py\)/.test(starts[0].p), r);
    zoekAntw = { ok: true, usd: 0.01, kandidaten: [K(40)] }; const voor = zoeken.length;
    r = await ms.nieuw({ wens: 'Proefbureau', eisen: [] });
    toets('12t zonder vergelijk-id zoekt de pod de kandidaten eerst zelf (één vraag zonder eisen) en geeft ze mee', r.status === 200 && zoeken.length === voor + 1 && starts[1].p.indexOf(K(40).url) > 0, r);
    zoekAntw = { ok: false, status: 'grens' };
    r = await ms.nieuw({ wens: 'Proefkastje' });
    toets('12u zoekhulp weigert: de agent start toch, zonder kandidatenblok', r.status === 200 && starts.length === 3 && !/KANDIDATEN VAN DE POD/.test(starts[2].p), r);
    r = await ms.nieuw({ wens: 'Proefkastje 2', vergelijk: '../x' });
    toets('12v vergelijk-id ongeldig = 400', r.status === 400, r);
    toets('12w kandidatenBlok: geen https = weg; leeg = geen blok', S.kandidatenBlok({ gelezen: [], rest: [{ url: 'javascript:x' }] }) === '' && S.kandidatenBlok(null) === '');
    toets('12x verlopen na 24 uur: stand 404', (() => { klok = new Date(klok.getTime() + 25 * 3600000); return v.stand(id).status === 404; })());
    {   // review ronde 1 MOET 1: opruimen zonder nieuwe vraag (geheugen en schijf); ZOU 1: staat niet te schrijven = geen betaalde zoekvraag
      const w = SV.maak({ vault: V, vv: VV, lezer: nepLezer, zoek: nepZoek, poort: POORT, staatPad: STAAT, nu: () => klok, opruimTik: false });
      zoekAntw = { ok: true, usd: 0, kandidaten: [] };
      const id9 = w.start({ wens: 'Opruimproef' }).body.vergelijk.id;
      for (let i = 0; i < 100 && ['klaar', 'mislukt'].indexOf(w.stand(id9).body.vergelijk.stand) < 0; i++) await new Promise((x) => setTimeout(x, 5));
      const voor9 = fs.readFileSync(STAAT, 'utf8').includes('Opruimproef');
      klok = new Date(klok.getTime() + 25 * 3600000);
      w.opruimen();
      toets('12xa na 24 uur weg uit staatbestand en geheugen, ook zonder nieuwe vraag', voor9 && !fs.readFileSync(STAAT, 'utf8').includes('Opruimproef') && w.stand(id9).status === 404);
      const kapot = SV.maak({ vault: V, vv: VV, lezer: nepLezer, zoek: nepZoek, poort: POORT, staatPad: path.join(W, 'bestaat-niet', 'x.json'), nu: () => klok, opruimTik: false });
      const n0 = zoeken.length, rk = kapot.start({ wens: 'Proefkast' });
      await new Promise((x) => setTimeout(x, 30));
      toets('12xb staat niet te schrijven = 503 en geen zoekvraag (de dagteller blijft kloppen)', rk.status === 503 && zoeken.length === n0, rk);
    }
    // server.js en uitrol
    const src = fs.readFileSync('server.js', 'utf8'), s0 = src.indexOf('const shopper = (function () {'), s1 = src.indexOf('// ── einde OVIS Shopper ──'), bl = src.slice(s0, s1);
    toets('12y server.js: POST vergelijk 10/uur, GET stand stil in het app-log, bewaar via shopper_status, staat shopper-vergelijk.json, zoek via openaiHulp.zoek; reden zonder wens',
      /route === 'POST \/app\/shopper\/vergelijk'/.test(bl) && /appTeller\('shopper_vergelijk', 10, 3600000\)/.test(bl) && /soort === 'vergelijk-stand'\) && u\.status === 200\) res\._app\.stil = true/.test(bl)
      && /shopper-vergelijk\.json/.test(bl) && /openaiHulp\.zoek\(z\)/.test(bl) && /res\._app\.reden = 'shopper ' \+ soort \+ \(m \? ' ' \+ \(\/\^\[0-9a-f\]\{12\}\$\/\.test\(m\[1\]\)/.test(bl)
      && /RELEASE_OPTIONEEL="[^"]*\bshopper-vergelijk\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
    toets('12z module logt niets en kent geen sleutel', !/console\.|process\.env|eval\(/.test(fs.readFileSync('shopper-vergelijk.js', 'utf8')));
  }

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
