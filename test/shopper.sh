#!/usr/bin/env bash
# Toetst OVIS Shopper S3 (wv2264, 2-11-2026; favorieten wv2267 § 6): shopper.js (alleen type: shopper-zoektocht direct in de vaste Shopper-mappen, entiteit uit de map,
# geen symlink volgen, id = hash van het pad en nooit een pad uit de vraag, koop-link alleen https, totaal/advies uit de opties) en het
# server.js-blok (routes, audit zonder wens, Niet meer nodig = de enige schrijfactie, gekocht niet via de App, /health alleen aantallen + tijdstip,
# uitrol-lijst; § 12 Snel vergelijken wv2934 met nep-zoekhulp en nep-winkels; § 13 Winkels, categorieën, verzendtabel en winkelscore wv2935; § 14 prijshistorie (Kieskeurig) en aanwijsteller wv2946; § 15 Winkels: facturen per winkel uit Facturen wv2947; § 7 S5 Facturen-koppeling wv2276 met een verzonnen facturendatabase; § 8 de knop Gekocht en Toch niet gekocht, wv2275; § 18 winkel aan/uit, Zet in mijn winkels en ergens anders gekocht met link, wv4280). Alleen verzonnen pagina's; raakt de echte vault niet. Gebruik: bash test/shopper.sh
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
  toets('4 info: alleen aantallen en tijdstip (geen wens of pad)', i.aan === true && i.zoektochten === 4 && Object.keys(i).sort().join() === 'aan,aanwijzen_maand,favorieten,onleesbaar,op,open,zoektochten' && i.favorieten === 0 && i.aanwijzen_maand === 0, i);

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

    // wv4171 (2C96 g): bedrag uit de factuur — alleen bij gekocht zonder bedrag, alleen het bedrag van een passende factuur, nooit uit de vraag
    const mB = S.maak({ vault: V3, vv: VV, facturenPad: () => FP }), idZ = z3('Zonder bedrag').id, idM = z3('Met bedrag').id;
    const fZ = det('Zonder bedrag').facturen, kies = fZ.find((x) => x.bedrag_eur != null);
    const pZ = path.join(V3, '10_Zakelijk/Groenhouten/Shopper/Zonder bedrag.md'), voorZ = fs.readFileSync(pZ, 'utf8');
    toets('7o bedrag: extra veld / bedrag in de vraag / rare id = 400', mB.bedrag(idZ, { factuur: kies.id, bedrag_eur: 1 }).status === 400 && mB.bedrag(idZ, { factuur: 'x y' }).status === 400 && mB.bedrag(idZ, {}).status === 400);
    toets('7p bedrag: factuur die niet bij de aankoop hoort = 409, pagina gelijk', mB.bedrag(idZ, { factuur: 'fonbekend' }).status === 409 && fs.readFileSync(pZ, 'utf8') === voorZ);
    toets('7q bedrag: al een bedrag = 409', mB.bedrag(idM, { factuur: kies.id }).status === 409);
    const rB = mB.bedrag(idZ, { factuur: kies.id }), naZ = fs.readFileSync(pZ, 'utf8');
    toets('7r bedrag: 200, gekocht-regel krijgt het factuurbedrag, optie/winkel/datum gelijk, rest byte-gelijk', rB.status === 200 && rB.body.gekocht.bedrag_eur === kies.bedrag_eur
      && det('Zonder bedrag').gekocht.bedrag_eur === kies.bedrag_eur && det('Zonder bedrag').gekocht.datum === '2026-11-02' && det('Zonder bedrag').gekocht.optie === 'o1'
      && naZ.replace(/^gekocht: .*$/m, '') === voorZ.replace(/^gekocht: .*$/m, ''), [rB, naZ.slice(0, 300)]);
    toets('7s bedrag: tweede keer = 409 (staat er al); facturendatabase byte-gelijk', mB.bedrag(idZ, { factuur: kies.id }).status === 409 && hashVan() === voorHash);
    // review MOET 2: de gekocht-regel veranderde intussen (andere opmerking, zelfde winkel en datum) = 409, geen bedrag
    fs.writeFileSync(pZ, voorZ);
    const vvAnders = Object.assign({}, VV, { wijzig: (pad, fn) => { fs.writeFileSync(pad, fs.readFileSync(pad, 'utf8').replace(/^gekocht: \{(.*)\}$/m, (r, x) => 'gekocht: {' + x + ', opmerking: "intussen"}')); return VV.wijzig(pad, fn); } });
    const rA = S.maak({ vault: V3, vv: vvAnders, facturenPad: () => FP }).bedrag(idZ, { factuur: kies.id });
    toets('7u bedrag: gekocht-regel intussen anders (zelfde winkel en datum) = 409, geen bedrag geschreven', rA.status === 409 && /bedrag_eur: null/.test(fs.readFileSync(pZ, 'utf8')), [rA, fs.readFileSync(pZ, 'utf8').slice(0, 300)]);
    fs.writeFileSync(pZ, voorZ);
    toets('7t bedrag op een open zoektocht = 409', mB.bedrag(z3('Open met gekocht-regel').id, { factuur: kies.id }).status === 409);
    fs.writeFileSync(pZ, voorZ);
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
    toets('12d twee zoekvragen tegelijk: wens + eisen, en de kale wens; afnemer shopper-snel; domeinen = bol.com + amazon.nl eerst (wv2935), dan favorieten aan zonder vergelijker', zoeken.length === 2
      && /Eisen van de koper: 180 cm hoog/.test(zv[0].vraag) && !/Eisen/.test(zv[1].vraag) && /Aantal: 2/.test(zv[1].vraag) && zv.every((z) => z.afnemer === 'shopper-snel')
      && JSON.stringify(zv[0].domeinen) === JSON.stringify(['bol.com', 'amazon.nl', 'proefwinkel.nl']), zv);
    const op = (n) => u.opties.find((x) => x.url === K(n).url), ng = (n) => u.niet_gelezen.find((x) => x.url === K(n).url);
    toets('12e alleen gelezen waarden: prijs van de pagina (niet het zoekfragment € 1,00), totaal = aantal × prijs + verzending', u.stand === 'klaar' && op(1).prijs_eur === 48.99 && op(1).totaal_eur === 97.98 && op(1).koop_aantal === 2 && op(1).btw === 'incl', u);
    toets('12f set van 2 bij aantal 2 = één keer kopen (€ 40,99); goedkoopste bovenaan', op(2).koop_eenheid === 'set van 2' && op(2).koop_aantal === 1 && op(2).totaal_eur === 40.99 && u.opties[0].url === K(2).url, u.opties);
    toets('12g ander product (T-shirt), blokkade en geen prijs = niet_gelezen met reden; onveilige link nooit gelezen', /ander product/.test(ng(3).reden) && /productpagina/.test(ng(4).reden) && /prijs niet te lezen/.test(ng(5).reden)
      && !gelezen.some((x) => /onveilig/.test(x)) && !op(3), u.niet_gelezen);
    toets('12h verzending niet te lezen = totaal null (nooit geschat); in huis uit de levertijd (vrijdag = 13-11, uiterlijk 18 november, 3 werkdagen = 16-11)', op(6).totaal_eur === null && op(6).verzending_eur === null
      && op(2).in_huis === '2026-11-13' && op(1).in_huis === '2026-11-18' && op(6).in_huis === '2026-11-16', u.opties);
    const nu12 = new Date('2026-11-11T15:00:00Z');
    toets('12ha review ronde 3: "vandaag besteld, morgen in huis" = morgen; "voor vrijdag besteld, maandag in huis" = maandag; overmorgen ≠ morgen',
      SV.inHuis('Vandaag besteld, morgen in huis', nu12) === '2026-11-12' && SV.inHuis('Voor vrijdag besteld, maandag in huis', nu12) === '2026-11-16' && SV.inHuis('overmorgen in huis', nu12) === '2026-11-13' && SV.inHuis('vandaag verzonden', nu12) === null);
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
      fs.writeFileSync(STAAT + '.123.abcdef01.tmp', '{"x":{"wens":"Achtergebleven proefwens"}}');
      fs.writeFileSync(STAAT + '.niet-van-ons', 'blijft');
      SV.maak({ vault: V, vv: VV, lezer: nepLezer, zoek: nepZoek, poort: POORT, staatPad: STAAT, nu: () => klok, opruimTik: false });
      toets('12xc achtergebleven tijdelijk staatbestand (crash) weg bij het opstarten; andere bestanden blijven', !fs.existsSync(STAAT + '.123.abcdef01.tmp') && fs.existsSync(STAAT + '.niet-van-ons'));
    }
    {   // wv2940: tweedehands = een ronde extra op eBay en marktplaatsen (EU + VK); eBay niet lezen maar 'niet nagelezen'; alleen geziene itemlinks
      const zk = [], gl = [];
      const EB = (n, extra) => Object.assign({ winkel: 'eBay UK', product: 'Proefscanner model ' + n + ' (gebruikt)', url: 'https://www.ebay.co.uk/itm/10000000' + n, prijs_tekst: '£' + (100 + n) + '.00', opmerking: null, gezien: true }, extra || {});
      const MP = { winkel: 'Marktplaats', product: 'Proefscanner model 9', url: 'https://www.marktplaats.nl/v/zakelijke-goederen/m200000009-proefscanner', prijs_tekst: '€ 300,00', opmerking: null, gezien: true };
      const markt = [EB(1), EB(2, { gezien: false }), EB(3, { url: 'https://www.ebay.de/shop/proefscanner?_nkw=proefscanner' }), EB(4), EB(5), EB(6), MP,
        { winkel: 'Marktplaats', product: 'zoekpagina', url: 'https://www.marktplaats.nl/l/zakelijke-goederen/q/proefscanner/', prijs_tekst: null, opmerking: null, gezien: true }];
      const zoekT = async (z) => { zk.push(z); return z.domeinen.indexOf('ebay.co.uk') >= 0 ? { ok: true, usd: 0.03, kandidaten: markt } : { ok: true, usd: 0.05, kandidaten: [K(70)] }; };
      const lezerT = async (url) => { gl.push(url); return url === MP.url ? { url, winkel: 'anders', product: 'Proefscanner model 9', prijs_eur: 300, verzending_eur: null } : { url, winkel: 'bol', product: 'Proefkast metaal 180 cm 70', prijs_eur: 30, verzending_eur: 0 }; };
      const vt = SV.maak({ vault: V, vv: VV, lezer: lezerT, zoek: zoekT, poort: POORT, staatPad: path.join(W, 'shopper-vergelijk-2e.json'), nu: () => klok, opruimTik: false });
      const wachtT = async (id) => { for (let i = 0; i < 200; i++) { const x = vt.stand(id).body.vergelijk; if (x && ['klaar', 'mislukt'].indexOf(x.stand) >= 0) return x; await new Promise((y) => setTimeout(y, 5)); } return null; };
      const ut = await wachtT(vt.start({ wens: 'Proefscanner tweedehands', eisen: ['met probe'] }).body.vergelijk.id);
      const mr = zk.filter((z) => z.domeinen.indexOf('ebay.co.uk') >= 0);
      toets('12za tweedehands in de wens: drie zoekrondes, de derde alleen op eBay (VK/DE/NL/FR) en de marktplaatsen; afnemer shopper-snel', zk.length === 3 && mr.length === 1
        && JSON.stringify(mr[0].domeinen) === JSON.stringify(['ebay.co.uk', 'ebay.de', 'ebay.nl', 'ebay.fr', 'marktplaats.nl', '2dehands.be', 'kleinanzeigen.de'])
        && /ook uit het VK/.test(mr[0].vraag) && mr[0].afnemer === 'shopper-snel' && ut.usd === 0.13, { zk, usd: ut.usd });
      const urls = (ut.niet_gelezen || []).map((x) => x.url);
      toets('12zb eBay niet gelezen (403) maar als niet nagelezen, prijs onbekend (geen ongecontroleerde zoekprijs), hooguit 3; nooit een link die niet in de bronnen stond of een zoekpagina',
        !gl.some((x) => /ebay\./.test(x)) && urls.length === 3 && urls[0] === EB(1).url && /niet nagelezen, prijs onbekend/.test(ut.niet_gelezen[0].reden) && !JSON.stringify(ut).includes('£10')
        && !JSON.stringify(ut).includes(EB(2).url) && !JSON.stringify(ut).includes('/shop/proefscanner') && !JSON.stringify(ut).includes('/l/zakelijke-goederen'), ut.niet_gelezen);
      toets('12zc de advertentie op Marktplaats wordt gewoon gelezen (refurbished/tweedehands-optie)', gl.indexOf(MP.url) >= 0 && ut.opties.some((x) => x.url === MP.url && x.prijs_eur === 300), ut.opties);
      const kd = vt.kandidaten(ut.id), eb = kd.rest.find((x) => x.url === EB(1).url), eb6 = kd.rest.find((x) => x.url === EB(6).url);
      const blok = S.kandidatenBlok(kd);
      toets('12zd naar de grondige agent: eBay-kandidaten met niet_nagelezen (ook boven de 3), zonder zoekprijs; het blok zegt ze niet te laten vallen',
        eb && /403/.test(eb.niet_nagelezen) && eb.prijs_zoekresultaat === undefined && !blok.includes('£10') && eb6 && /403/.test(eb6.niet_nagelezen) && /niet_nagelezen kon de pod niet lezen: laat hem niet vallen/.test(blok)
        && /eBay en marktplaatsen in de EU en het VK/.test(blok) && blok.indexOf(EB(1).url) > 0, { kd, blok: blok.slice(0, 400) });
      zk.length = 0;
      await wachtT(vt.start({ wens: 'Proefkast metaal' }).body.vergelijk.id);
      const zk2 = zk.length; zk.length = 0;
      await wachtT(vt.start({ wens: 'Proefkast metaal', refurbished: true }).body.vergelijk.id);
      const zk3 = zk.length; zk.length = 0;
      const zkand = await vt.zoekKandidaten({ wens: 'Proefscanner 2e hands', eisen: [] });
      toets('12ze zonder tweedehandswens geen marktplaatsronde; vinkje refurbished of "2e hands" (ook Laat Shopper zoeken) wel', zk2 === 1 && zk3 === 2 && zk.length === 2
        && zkand.rest.some((x) => x.url === EB(1).url && /niet nagelezen/.test(x.niet_nagelezen)), { zk2, zk3, n: zk.length });
      toets('12zf hulpfuncties: tweedehands, onleesbaar en marktItem', SV.tweedehands({ wens: 'Bladderscan', eisen: ['mag gebruikt'] }) && SV.tweedehands({ wens: 'x', refurbished: true }) && !SV.tweedehands({ wens: 'Bladderscan', eisen: [] })
        && SV.onleesbaar('https://www.ebay.co.uk/itm/1') && !SV.onleesbaar('https://www.marktplaats.nl/v/a/m1-x') && !SV.onleesbaar('https://nepebay.nl/itm/1')
        && SV.marktItem('https://www.ebay.de/p/2326106066') && !SV.marktItem('https://www.ebay.co.uk/sch/i.html?_nkw=x') && SV.marktItem('https://www.kleinanzeigen.de/s-anzeige/x/1'));
    }
    // server.js en uitrol
    const src = fs.readFileSync('server.js', 'utf8'), s0 = src.indexOf('const shopper = (function () {'), s1 = src.indexOf('// ── einde OVIS Shopper ──'), bl = src.slice(s0, s1);
    toets('12y server.js: POST vergelijk 10/uur, GET stand stil in het app-log, bewaar via shopper_status, staat shopper-vergelijk.json, zoek via openaiHulp.zoek; reden zonder wens',
      /route === 'POST \/app\/shopper\/vergelijk'/.test(bl) && /appTeller\('shopper_vergelijk', 10, 3600000\)/.test(bl) && /soort === 'vergelijk-stand'[^)]*\) && u\.status === 200\) res\._app\.stil = true/.test(bl)
      && /shopper-vergelijk\.json/.test(bl) && /openaiHulp\.zoek\(z\)/.test(bl) && /res\._app\.reden = 'shopper ' \+ soort \+ \(m \? ' ' \+ \(\/\^\[0-9a-f\]\{12\}\$\/\.test\(m\[1\]\)/.test(bl)
      && /RELEASE_OPTIONEEL="[^"]*\bshopper-vergelijk\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
    toets('12z module logt niets en kent geen sleutel', !/console\.|process\.env|eval\(/.test(fs.readFileSync('shopper-vergelijk.js', 'utf8')));
  }

  // ── 13. wv2935: Winkels (shopper-winkels.js), scoreleesscript (winkel-score.py), categorie en verzendtabel in Snel vergelijken ──
  {
    const WM = require('./shopper-winkels.js'), SV = require('./shopper-vergelijk.js'), cp = require('child_process');
    const PP = require('./intake/patientpoort.js'), POORT = (t) => PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) });
    const F = path.join(W, 'w13'); fs.mkdirSync(F, { recursive: true });
    const ontleed = (soort, html, dom) => { fs.writeFileSync(path.join(F, 'p.html'), html); return JSON.parse(cp.execFileSync('python3', ['-I', 'winkel-score.py', '--ontleed', soort, path.join(F, 'p.html')].concat(dom ? [dom] : []), { encoding: 'utf8' })); };
    const KK = (n, c) => '<html><body><div>Gemiddelde beoordeling</div><p>Gebaseerd op ' + n + ' ervaringen met Proefwinkel.nl</p><b>' + c + '</b><script type="application/ld+json">{"@type":"LocalBusiness","aggregateRating":{"ratingValue":1,"reviewCount":99999}}</script></body></html>';
    let x = ontleed('kieskeurig', KK(744, '8.9'));
    toets('13a Kieskeurig: zichtbaar cijfer en aantal ervaringen (niet het grotere JSON-LD-aantal)', x.cijfer === 8.9 && x.aantal === 744, x);
    x = ontleed('kieskeurig', KK(0, '0'));
    const x2 = ontleed('kieskeurig', '<html>niets</html>');
    toets('13b Kieskeurig: 0 ervaringen = geen cijfer; geen regel = fout', x.cijfer === null && x.aantal === 0 && /geen beoordeling/.test(x2.fout), [x, x2]);
    x = ontleed('kiyoh', '<script type="application/ld+json">{"@graph":[{"@type":"Product","aggregateRating":{"ratingValue":2,"reviewCount":3,"bestRating":10}},{"@type":"Organization","aggregateRating":{"ratingValue":8.8,"reviewCount":107,"bestRating":10}}]}</script>');
    const x3 = ontleed('kiyoh', '<script type="application/ld+json">{"@type":"Organization","aggregateRating":{"ratingValue":4.5,"reviewCount":10,"bestRating":5}}</script>');
    toets('13c Kiyoh: cijfer van het bedrijf (niet van een product); andere schaal dan 10 = fout', x.cijfer === 8.8 && x.aantal === 107 && x3.fout, [x, x3]);
    const TW = (site) => '<html><p>Proefwinkel werd voor het eerst gecertificeerd</p><p>Website URL http://www.' + site + '</p><p>Lid sinds 31 mei 2009</p></html>';
    x = ontleed('thuiswinkel', TW('proefwinkel.nl'), 'proefwinkel.nl');
    const x4 = ontleed('thuiswinkel', TW('anderewinkel.nl'), 'proefwinkel.nl');
    toets('13d Thuiswinkel: lid sinds als datum, alleen als de website van de winkel is', x.sinds === '2009-05-31' && /andere website/.test(x4.fout), [x, x4]);
    const uit = JSON.parse(cp.execFileSync('python3', ['-I', 'winkel-score.py'], { input: JSON.stringify({ winkels: [{ domein: 'proef.nl', kieskeurig: '../x', kiyoh: 'https://evil.example/reviews/1/x/', thuiswinkel: 'A B' }, { domein: 'http://kapot' }] }), encoding: 'utf8', timeout: 20000 }));
    toets('13e scoreleesscript: ongeldige slug/kiyoh-adres/domein = geen vraag (alleen de drie vaste hosts)', uit.winkels['proef.nl'] && uit.winkels['proef.nl'].kieskeurig === null && uit.winkels['proef.nl'].kiyoh === null
      && uit.winkels['proef.nl'].thuiswinkel === null && Object.keys(uit.winkels).length === 1 && /^\d{4}-\d{2}-\d{2}T/.test(uit.op), uit);
    const pyB = fs.readFileSync('winkel-score.py', 'utf8');
    toets('13f scoreleesscript: haal() alleen https op de drie vaste hosts, doorsturen alleen binnen dezelfde host, eigen User-Agent, geen Trustpilot',
      /u\.hostname not in HOSTS\.values\(\)/.test(pyB) && /doorsturen naar een andere host geweigerd/.test(pyB) && /Socev-Shopper\/1\.0/.test(pyB) && !/trustpilot\.com/i.test(pyB.replace(/^\s*(#|""").*$/gm, '').replace(/"""[\s\S]*?"""/, '')));
    const FAV = ['---', 'type: shopper-favorieten', 'winkels:',
      '  - {domein: bol.com, naam: "bol", aan: true, categorie: "alles", lezen: script, kieskeurig: "bol.", thuiswinkel: bol}',
      '  - {domein: amazon.nl, naam: "Amazon.nl", aan: true, categorie: alles, lezen: script, kieskeurig: amazon}',
      '  - {domein: vosproef.nl, naam: "Vosproef", aan: true, categorie: "medisch", lezen: script, verzend_eur: 6.50, drempel_eur: 85, boven_drempel_eur: 0, verzend_gemeten: "2026-11-09", kiyoh: "https://www.kiyoh.com/reviews/1043906/vosproef_nl/"}',
      '  - {domein: inktproef.nl, naam: "Inktproef", aan: true, categorie: "kantoor huis onzin", lezen: script, verzend_eur: 5.95, drempel_eur: 50.01, boven_drempel_eur: 4.95, verzend_gemeten: "2026-11-02", kieskeurig: "inktproef.nl"}',
      '  - {domein: vakproef.nl, naam: "Vakproef", aan: false, categorie: medisch, lezen: browser, verzend_eur: "veel", kiyoh: "https://evil.example/x"}',
      '  - {domein: gammaproef.nl, naam: "Gammaproef", aan: false, categorie: bouw, lezen: niet}',
      '  - {domein: bouwproef.nl, naam: "Bouwproef", aan: true, categorie: bouw, lezen: script, verzend_tekst: "afhalen gratis"}',
      '  - {domein: "https://www.vosproef.nl/dubbel", naam: "Dubbel", aan: true}',
      '---', ''].join('\n');
    const ws = WM.winkelsVan(FAV);
    const vos = ws.find((w) => w.domein === 'vosproef.nl'), ink = ws.find((w) => w.domein === 'inktproef.nl'), vak = ws.find((w) => w.domein === 'vakproef.nl');
    toets('13g winkelsVan: categorieën (onbekende weg), lezen, verzendtabel, bronnen; ongeldig veld valt weg; dubbel domein telt één keer',
      ws.length === 7 && vos.categorie.join() === 'medisch' && ink.categorie.join() === 'kantoor,huis' && vos.verzend.eur === 6.5 && vos.verzend.gemeten === '2026-11-09'
      && vak.verzend === null && vak.bronnen.kiyoh === null && vak.lezen === 'browser' && vos.bronnen.kiyoh && WM.winkelsVan(FAV.replace('shopper-favorieten', 'iets')).length === 0, ws);
    toets('13h verzendUitTabel: onder de drempel het bedrag, vanaf de drempel het andere bedrag (gratis of lager), zonder tabel null',
      WM.verzendUitTabel(vos, 40).eur === 6.5 && WM.verzendUitTabel(vos, 85).eur === 0 && WM.verzendUitTabel(ink, 50).eur === 5.95 && WM.verzendUitTabel(ink, 60).eur === 4.95
      && WM.verzendUitTabel(vos, 40).gemeten === '2026-11-09' && WM.verzendUitTabel(ws.find((w) => w.domein === 'bouwproef.nl'), 40) === null && WM.verzendUitTabel(vos, 0) === null);
    toets('13i domeinenVoor: per categorie alleen wat aan staat en te lezen is (plus "alles"); zonder categorie alle leesbare die aan staan',
      WM.domeinenVoor(ws, 'medisch').join() === 'bol.com,amazon.nl,vosproef.nl' && WM.domeinenVoor(ws, 'bouw').join() === 'bol.com,amazon.nl,bouwproef.nl'
      && WM.domeinenVoor(ws, null).join() === 'bol.com,amazon.nl,vosproef.nl,inktproef.nl,bouwproef.nl', [WM.domeinenVoor(ws, 'medisch'), WM.domeinenVoor(ws, null)]);
    const SC = { op: '2026-11-11T16:00:00Z', winkels: { 'bol.com': { kieskeurig: { cijfer: 8.9, aantal: 744 }, kiyoh: null, thuiswinkel: { sinds: '2009-07-31' } },
      'amazon.nl': { kieskeurig: { cijfer: 1, aantal: 1 } }, 'vosproef.nl': { kiyoh: { cijfer: 8.8, aantal: 107 } }, 'inktproef.nl': { kieskeurig: { cijfer: 3.9, aantal: 11 } } } };
    const bolP = WM.scoreBij('https://www.bol.com/nl/nl/p/x/9300000001/', 'Raamdecoratie.com', ws, SC), bolE = WM.scoreBij('https://www.bol.com/nl/nl/p/x/9300000001/', 'bol', ws, SC);
    const bolO = WM.scoreBij('https://www.bol.com/nl/nl/p/x/9300000001/', null, ws, SC), amz = WM.scoreBij('https://www.amazon.nl/dp/B000000001', 'Amazon', ws, SC);
    toets('13j score bij de echte verkoper: bol-partner = partner (geen bol-score), bol zelf = bol-score + Thuiswinkel, verkoper onbekend = geen score',
      bolP.soort === 'partner' && bolP.verkoper === 'Raamdecoratie.com' && !bolP.bronnen && bolE.soort === 'score' && bolE.bronnen[0].cijfer === 8.9 && bolE.thuiswinkel_sinds === '2009-07-31'
      && bolO.soort === 'onbekend_verkoper', [bolP, bolE, bolO]);
    const vs = WM.scoreBij('https://shop.vosproef.nl/p/1', null, ws, SC), onb = WM.scoreBij('https://www.nergens.nl/p', null, ws, SC), gb = WM.scoreBij('https://bouwproef.nl/p', null, ws, SC);
    toets('13k Kieskeurig onder 10 ervaringen: geen cijfer (wel aantal, "weinig"); vakwinkel op subdomein = Kiyoh; winkel zonder score = geen; onbekende winkel = null',
      amz.soort === 'score' && amz.bronnen[0].cijfer === null && amz.bronnen[0].weinig === true && vs.bronnen[0].bron === 'Kiyoh' && vs.bronnen[0].cijfer === 8.8
      && gb.soort === 'geen' && onb === null && WM.scoreBij('https://www.inktproef.nl/p', null, ws, SC).bronnen[0].cijfer === 3.9, [amz, vs, gb]);
    const ak = WM.aankopen([{ winkel: 'Vosproef', url: null, datum: '2026-11-09' }, { winkel: 'Iets', url: 'https://www.vosproef.nl/p/2', datum: '2026-11-01' },
      { winkel: 'Gammaproef', datum: '2026-11-02' }, { winkel: 'eBay.co.uk (proefverkoper)', datum: '2026-11-11' }, { winkel: null }], ws);
    toets('13l eigen aankopen: koppeling op link of winkelnaam, aantal en laatste datum; de rest als "elders" (zonder verkopersnaam)',
      ak.per['vosproef.nl'].aantal === 2 && ak.per['vosproef.nl'].laatst === '2026-11-09' && ak.per['gammaproef.nl'].aantal === 1 && ak.elders.length === 1 && ak.elders[0].naam === 'eBay.co.uk', ak);
    // maak(): leesronde alleen bij openen en ouder dan 30 dagen, hooguit eens per 6 uur; bewaard 0600
    let klok13 = new Date('2026-11-11T16:00:00Z'), lezerRonden = [];
    const SP = path.join(F, 'shopper-winkelscore.json');
    const wm = WM.maak({ scorePad: SP, nu: () => klok13, scoreLezer: async (inv) => { lezerRonden.push(inv); return SC; } });
    let o = wm.overzicht(FAV, [{ winkel: 'Vosproef', datum: '2026-11-09' }]).body;
    await new Promise((r) => setTimeout(r, 20));
    const o2 = wm.overzicht(FAV, []).body;
    toets('13m eerste keer openen zonder scores: stand leest, één leesronde met alleen winkels met een bron; daarna bewaard (0600) en zichtbaar',
      o.score_stand === 'leest' && lezerRonden.length === 1 && lezerRonden[0].winkels.map((w) => w.domein).join() === 'bol.com,amazon.nl,vosproef.nl,inktproef.nl'
      && (fs.statSync(SP).mode & 0o777) === 0o600 && o2.score_stand === 'klaar' && o2.winkels.find((w) => w.domein === 'vosproef.nl').score.bronnen[0].cijfer === 8.8, [o.score_stand, lezerRonden.length, o2.score_stand]);
    const vo = o.winkels.find((w) => w.domein === 'vosproef.nl'), go = o.winkels.find((w) => w.domein === 'gammaproef.nl');
    toets('13n overzicht: hier kocht je eerder (aantal, laatst), onbekende winkel = geen aankoop en geen score; categorieën in de vaste volgorde',
      vo.gekocht.aantal === 1 && vo.onbekend === false && go.onbekend === true && o.categorieen.map((c) => c.id).join() === 'medisch,bouw,huis,elektronica,kantoor', [vo, go]);
    klok13 = new Date(klok13.getTime() + 31 * 86400000);
    wm.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
    const n1 = lezerRonden.length;
    fs.writeFileSync(SP, JSON.stringify({ op: '2020-01-01T00:00:00Z', winkels: {} }));
    klok13 = new Date(klok13.getTime() + 3600000); wm.overzicht(FAV, []);
    klok13 = new Date(klok13.getTime() + 6 * 3600000); wm.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
    toets('13o na 30 dagen opnieuw lezen; mislukt of oud: hooguit eens per 6 uur een nieuwe poging', n1 === 2 && lezerRonden.length === 3, [n1, lezerRonden.length]);
    const kap = WM.maak({ scorePad: SP, nu: () => klok13, scoreLezer: async () => ({ kapot: true }) });
    fs.writeFileSync(SP, JSON.stringify(SC));
    klok13 = new Date('2027-06-01T00:00:00Z'); kap.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
    toets('13p ongeldige uitkomst van het script: de oude scores blijven staan', JSON.parse(fs.readFileSync(SP, 'utf8')).op === SC.op);
    // shopper.js: route winkels en score per optie in een zoektocht
    const V13 = path.join(F, 'vault'), VT = path.join(V13, '10_Zakelijk/Tolgaarde/Shopper');
    fs.mkdirSync(VT, { recursive: true }); fs.mkdirSync(path.join(V13, '00_Systeem'), { recursive: true });
    fs.writeFileSync(path.join(V13, '00_Systeem/Shopper - favoriete winkels.md'), FAV);
    fs.writeFileSync(path.join(VT, 'Shopper - 2026-11-09 - Proefweegschaal.md'), ['---', 'type: shopper-zoektocht', 'wens: "Proefweegschaal"', 'status: gekocht',
      'gekocht: {optie: o2, winkel: "Vosproef", bedrag_eur: 99.9, datum: "2026-11-09", opmerking: null, via: app}', 'gezocht: 2026-11-09T09:00+01:00', 'aantal: 1', 'opties:',
      '  - {id: o1, winkel: "bol", verkoper: "Proefpartner", product: "Weegschaal", koop_aantal: 1, prijs_eur: 50, verzending_eur: 0, totaal_eur: 50, url: "https://www.bol.com/nl/nl/p/w/9300000002/"}',
      '  - {id: o2, winkel: "Vosproef", verkoper: "Vosproef", product: "Weegschaal", koop_aantal: 1, prijs_eur: 93.4, verzending_eur: 6.5, totaal_eur: 99.9, url: "https://www.vosproef.nl/p/w"}',
      'advies: o2', '---', ''].join('\n'));
    fs.writeFileSync(SP, JSON.stringify(SC));
    const m13 = S.maak({ vault: V13, vv: VV, scorePad: SP, scoreLezer: null });
    const wr = m13.winkels(), zid = m13.lijst().body.zoektochten[0].id, zd = m13.zoektocht(zid).body.zoektocht;
    toets('13q shopper.js winkels(): Gekocht in Shopper telt bij de winkel van de gekozen optie; zoektocht: score per optie bij de echte verkoper',
      wr.status === 200 && wr.body.winkels.find((w) => w.domein === 'vosproef.nl').gekocht.aantal === 1 && zd.opties[0].winkelscore.soort === 'partner'
      && zd.opties[1].winkelscore.bronnen[0].cijfer === 8.8 && zd.advies_controle, [wr.body.winkels && wr.body.winkels.map((w) => w.gekocht), zd.opties.map((q) => q.winkelscore)]);
    toets('13r lijst ongewijzigd: geen winkelscore in de lijst, wel in het detail', m13.lijst().body.zoektochten[0].winkelscore === undefined);
    // Snel vergelijken met categorie en verzendtabel
    const zv = [];
    const vg = SV.maak({ vault: V13, vv: VV, poort: POORT, staatPad: path.join(F, 'vg.json'), opruimTik: false,
      zoek: async (z) => { zv.push(z); return { ok: true, usd: 0.01, kandidaten: [{ winkel: 'Vosproef', product: 'Proefweegschaal digitaal', url: 'https://www.vosproef.nl/p/weeg' }] }; },
      lezer: async (url) => ({ url, winkel: 'anders', product: 'Proefweegschaal digitaal', prijs_eur: 40, verzending_eur: null, levertijd: '3 - 5 werkdagen' }) });
    const fout13 = vg.start({ wens: 'Proefweegschaal', categorie: 'snoep' });
    const ok13 = vg.start({ wens: 'Proefweegschaal', categorie: 'medisch', aantal: 2 });
    let sv = null;
    for (let i = 0; i < 200; i++) { sv = vg.stand(ok13.body.vergelijk.id).body.vergelijk; if (sv.stand === 'klaar' || sv.stand === 'mislukt') break; await new Promise((r) => setTimeout(r, 5)); }
    const op13 = sv.opties[0];
    toets('13s categorie: onbekend = 400; medisch = domeinfilter bol, Amazon + de leesbare medische winkels die aan staan',
      fout13.status === 400 && zv.length >= 1 && zv[0].domeinen.join() === 'bol.com,amazon.nl,vosproef.nl' && sv.categorie === 'medisch', [fout13, zv[0] && zv[0].domeinen]);
    toets('13t verzending niet op de pagina: uit de gemeten tabel (bron tabel, meetdatum), totaal = 2 × 40 + 0 (vanaf € 85 gratis… 80 < 85: € 6,50)',
      op13 && op13.verzending_eur === 6.5 && op13.verzending_bron === 'tabel' && op13.verzending_gemeten === '2026-11-09' && op13.totaal_eur === 86.5 && /verzendtabel van Vosproef/.test(op13.verzending_tekst), op13);
    const m13b = S.maak({ vault: V13, vv: VV, scorePad: SP, vergelijk: vg });
    const sv2 = m13b.vergelijk.stand(ok13.body.vergelijk.id).body.vergelijk;
    toets('13u Snel vergelijken via shopper.js: score per optie; de module zelf blijft zonder score', sv2.opties[0].winkelscore.bronnen[0].bron === 'Kiyoh' && sv.opties[0].winkelscore === undefined, sv2.opties[0]);
    const src13 = fs.readFileSync('server.js', 'utf8'), b0 = src13.indexOf('const shopper = (function () {'), b1 = src13.indexOf('// ── einde OVIS Shopper ──'), bl13 = src13.slice(b0, b1);
    toets('13v server.js: GET /app/shopper/winkels vóór de id-route, stil in het app-log, scorePad shopper-winkelscore.json, script kaal en begrensd; uitrol-lijst',
      bl13.indexOf("route === 'GET /app/shopper/winkels'") > 0 && bl13.indexOf("route === 'GET /app/shopper/winkels'") < bl13.indexOf("soort = 'zoektocht'") && /soort === 'winkels'( \|\| soort === 'aankopen')?\) && u\.status === 200\) res\._app\.stil = true/.test(bl13)
      && /shopper-winkelscore\.json/.test(bl13) && /'winkel-score\.py'/.test(bl13) && /timeout: 180000/.test(bl13) && /env: \{ PATH: process\.env\.PATH \|\| '\/usr\/bin:\/bin', LANG: 'C\.UTF-8', HOME: '\/tmp' \}/.test(bl13)
      && /RELEASE_OPTIONEEL="[^"]*\bshopper-winkels\.js (winkel-browser\.js )?winkel-score\.py\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
    toets('13w shopper-winkels.js logt niets en kent geen sleutel', !/console\.|process\.env|eval\(/.test(fs.readFileSync('shopper-winkels.js', 'utf8')));
    // review wv2935 ronde 1
    const dr = { verzend: { eur: 4.95, drempel_eur: 59.7, boven_drempel_eur: 0, tekst: null, gemeten: null } };
    toets('13x (MOET 1) drempel in hele centen: 3 × 19,90 = 59,70 haalt een drempel van 59,70 (gratis)', WM.verzendUitTabel(dr, 3 * 19.9).eur === 0 && WM.verzendUitTabel(dr, 59.69).eur === 4.95, 3 * 19.9);
    {
      const SPm = path.join(F, 'samen.json');
      fs.writeFileSync(SPm, JSON.stringify({ op: '2026-10-01T00:00:00Z', winkels: { 'vosproef.nl': { kiyoh: { cijfer: 8.8, aantal: 107 } } } }));
      let klokM = new Date('2026-11-11T16:00:00Z'), rondes = 0;
      const wmM = WM.maak({ scorePad: SPm, nu: () => klokM, scoreLezer: async () => { rondes++; return { op: klokM.toISOString(), winkels: { 'vosproef.nl': { kiyoh: { fout: 'niet te lezen (HTTP 503)' }, kieskeurig: null, thuiswinkel: null } } }; } });
      wmM.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
      const naM = JSON.parse(fs.readFileSync(SPm, 'utf8'));
      klokM = new Date(klokM.getTime() + 2 * 3600000); wmM.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
      const r1 = rondes;
      klokM = new Date(klokM.getTime() + 5 * 3600000); wmM.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
      toets('13y (ZOU 2) mislukte bron overschrijft de eerdere goede meting niet; met fouten na 6 uur (niet na 30 dagen) een nieuwe poging',
        naM.winkels['vosproef.nl'].kiyoh.cijfer === 8.8 && naM.fouten === 1 && r1 === 1 && rondes === 2, [naM, r1, rondes]);
    }
    {
      const ak2 = WM.aankopen([{ winkel: 'bol', url: 'https://www.bol.com/nl/nl/p/x/9300000003/', verkoper: 'Proefpartner', datum: '2026-11-10' },
        { winkel: 'bol', url: 'https://www.bol.com/nl/nl/p/x/9300000004/', verkoper: 'bol', datum: '2026-11-08' }], ws);
      toets('13za (ronde 2 ZOU 2) gekocht bij een bol-partner telt bij de partner (Ook gekocht bij), niet bij bol; bij bol zelf wel bij bol',
        ak2.per['bol.com'].aantal === 1 && ak2.elders.length === 1 && ak2.elders[0].naam === 'Proefpartner', ak2);
      const SPd = path.join(F, 'datum.json');
      fs.writeFileSync(SPd, JSON.stringify({ op: '2026-10-01T00:00:00Z', winkels: { 'vosproef.nl': { kiyoh: { cijfer: 8.8, aantal: 107 } }, 'bol.com': { kieskeurig: { cijfer: 8.9, aantal: 744 } } } }));
      const wmD = WM.maak({ scorePad: SPd, nu: () => new Date('2026-11-11T16:00:00Z'), scoreLezer: async () => ({ op: '2026-11-11T16:00:00Z', winkels: {
        'vosproef.nl': { kiyoh: { fout: 'niet te lezen (HTTP 503)' } }, 'bol.com': { kieskeurig: { cijfer: 9.0, aantal: 750 } } } }) });
      wmD.overzicht(FAV, []); await new Promise((r) => setTimeout(r, 20));
      const oD = wmD.overzicht(FAV, []).body, vD = oD.winkels.find((w) => w.domein === 'vosproef.nl'), bD = oD.winkels.find((w) => w.domein === 'bol.com');
      toets('13zb (ronde 2 ZOU 1) leesdatum per bron: de bewaarde oude Kiyoh-meting houdt 1-10, de nieuwe bol-meting 11-11; de app krijgt de oudste',
        vD.score.op === '2026-10-01T00:00:00Z' && bD.score.op === '2026-11-11T16:00:00Z' && oD.score_op === '2026-10-01T00:00:00Z' && bD.score.bronnen[0].cijfer === 9, [vD.score, bD.score, oD.score_op]);
    }
    toets('13z (ZOU 1) scoreleesscript: na 140 s geen nieuwe vraag meer (rest "tijd op"), ruim binnen de 180 s van de pod',
      /DEADLINE_S = 140/.test(pyB) && /time\.monotonic\(\) - t0 > DEADLINE_S/.test(pyB) && /niet gelezen \(tijd op\)/.test(pyB));
  }

  // ── 14. wv2946 fase 4: prijshistorie bij het advies (prijshistorie.py, verzonnen Kieskeurig-pagina's) en de aanwijsteller ──
  {
    const cp = require('child_process'), F = path.join(W, 'w14'); fs.mkdirSync(F, { recursive: true });
    const dag = (vandaag, n) => { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    // reeks: [[dagen terug, bedrag], …] → priceHistory zoals Kieskeurig hem in de astro-props zet ([0, waarde] / [1, lijst])
    const VD = '2026-11-11';
    const reeksVan = (r) => [1, r.map(([n, a]) => [0, { ean: [0, '8700000000001'], amount: [0, a], date: [0, dag(VD, n) + 'T00:00:00Z'], id: [0, '0'] }])];
    const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const PNAAM = 'Proefmerk 5000 series PR552/00 Airfryer - Dubbel - 9L - 2750W - Zwart';
    const prodPagina = (r, verborgen, naam) => '<html><script type="application/ld+json">' + JSON.stringify({ '@graph': [{ '@type': 'Product', name: naam || PNAAM, brand: { '@type': 'Brand', name: 'Proefmerk' } }] }) + '</script><astro-island uid="x" props="' + esc(JSON.stringify({ product: [0, { naam: [0, 'x'] }], hidePriceHistory: [0, !!verborgen], priceHistory: reeksVan(r) })) + '" ssr></astro-island></html>';
    const item = (naam, merk, nr) => ({ '@type': 'ListItem', url: 'https://www.kieskeurig.nl/airfryer/product/' + nr + '-proef', item: { '@type': 'Product', name: naam, brand: { '@type': 'Brand', name: merk }, url: 'https://www.kieskeurig.nl/airfryer/product/' + nr + '-proef' } });
    const zoekPagina = (items) => '<html><script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'ItemList', itemListElement: items }] }) + '</script></html>';
    const vol = (nu, min, minDag) => { const r = []; for (let n = 88; n >= 4; n -= 4) r.push([n, n === minDag ? min : 120]); r.push([0, nu]); return r; };
    const draai = (map, product) => JSON.parse(cp.execFileSync('python3', ['-I', 'prijshistorie.py', '--toets', map], { input: JSON.stringify({ product, vandaag: VD }), encoding: 'utf8', timeout: 20000 }));
    const geval = (naam, items, reeks, verborgen, pnaam) => { const m = path.join(F, naam); fs.mkdirSync(m); fs.writeFileSync(path.join(m, 'zoek.html'), zoekPagina(items)); if (reeks) fs.writeFileSync(path.join(m, '777.html'), prodPagina(reeks, verborgen, pnaam)); return m; };
    const GOED = [item('Proefmerk 5000 series PR552/00 Airfryer - Dubbel - 9L - 2750W - Zwart', 'Proefmerk', 777)];
    const ADVIES = 'Proefmerk PR552/00 Airfryer Dual Basket 9L zwart';
    let x = draai(geval('a', [item('Proefmerk 5000 series PR555/00 Airfryer - 9L - Zwart', 'Proefmerk', 778)].concat(GOED), vol(110, 110, -1)), ADVIES);
    toets('14a match (exact modelnummer, zelfde merk, 9L en zwart aan beide kanten; de eerste kandidaat met een ander model valt af): laagste in 90 dagen',
      x.zin === 'Kieskeurig: laagste prijs in 90 dagen (€ 110, gelezen 11-11)' && x.url === 'https://www.kieskeurig.nl/airfryer/product/777-proef', x);
    x = draai(geval('b', [item('Proefmerk 5000 series PR555/00 Airfryer - 9L - Zwart', 'Proefmerk', 777)], vol(110, 110, -1)), ADVIES);
    const xb2 = draai(geval('b2', [item('Proefmerk 5000 series PR552/00 Airfryer - Dubbel - 9L - 2750W', 'Proefmerk', 777)], vol(110, 110, -1)), ADVIES);
    const xb3 = draai(geval('b3', [item('Proefmerk 5000 series PR552/00 Airfryer - 7L - Zwart', 'Proefmerk', 777)], vol(110, 110, -1)), ADVIES);
    const xb4 = draai(geval('b4', [item('Anders PR552/00 Airfryer - 9L - Zwart', 'Anders', 777)], vol(110, 110, -1)), ADVIES);
    const xb5 = draai(geval('b5', GOED, vol(110, 110, -1)), 'Proefmerk Airfryer Dual Basket 9L zwart');
    toets('14b geen match: ander model (woordoverlap is niet genoeg), kleur maar aan één kant, andere inhoud, ander merk, advies zonder modelnummer = geen zin',
      x.zin === null && /niet hetzelfde product \(ander of geen modelnummer\)/.test(x.reden) && xb2.zin === null && /kleur/.test(xb2.reden) && xb3.zin === null && /inhoud/.test(xb3.reden)
      && xb4.zin === null && /ander merk/.test(xb4.reden) && xb5.zin === null && xb5.reden === 'geen modelnummer in het advies', [x, xb2, xb3, xb4, xb5]);
    // rekenregels rechtstreeks (punten_van + zin_van) met verzonnen reeksen; n = dagen terug of een eigen datumtekst
    const reken = (gevallen) => JSON.parse(cp.execFileSync('python3', ['-I', '-B', '-c', [
      'import importlib.util, json, sys', 'from datetime import date',
      's = importlib.util.spec_from_file_location("ph", "prijshistorie.py"); ph = importlib.util.module_from_spec(s); s.loader.exec_module(ph)',
      'uit = []', 'for g in json.loads(sys.stdin.read()):',
      '    uit.append(list(ph.zin_van(ph.punten_van(g), date.fromisoformat("' + VD + '"))))', 'print(json.dumps(uit, ensure_ascii=False))'].join('\n')],
      { input: JSON.stringify(gevallen.map((r) => r.map(([n, a]) => ({ amount: a, date: typeof n === 'string' ? n : dag(VD, n) + 'T00:00:00Z' })))), encoding: 'utf8' }));
    const elke = (van, stap, nu) => { const r = []; for (let n = van; n > 0; n -= stap) r.push([n, 120]); r.push([0, nu]); return r; };
    let R14 = reken([elke(85, 5, 100), elke(84, 4, 100), [[89, 120], [74, 120], [60, 120], [45, 120], [30, 120], [15, 120], [0, 100]],
      [[89, 120], [75, 120], [61, 120], [47, 120], [33, 120], [19, 120], [5, 120], [3, 100]], elke(88, 4, 120).map(([n, a]) => [n + 4, a])]);
    toets('14c dekking: oudste punt 85 dagen terug = zin, 84 = geen zin; gat van 15 dagen = geen zin, 14 = zin; nieuwste punt 4 dagen oud = geen zin',
      R14[0][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 100, gelezen 11-11)' && R14[1][0] === null && /te korte reeks \(oudste punt 84/.test(R14[1][1])
      && R14[2][0] === null && /gat van 15 dagen/.test(R14[2][1]) && R14[3][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 100, gelezen 8-11)'
      && R14[4][0] === null && /nieuwste punt te oud \(4 dagen\)/.test(R14[4][1]), R14);
    const met = (nu, punten) => { const r = elke(88, 4, nu).map(([n, x]) => [n, n === 0 ? x : nu + 50]); for (const [n, a] of punten) { const i = r.findIndex((y) => y[0] === n); if (i >= 0) r[i][1] = a; else r.push([n, a]); } return r; };
    R14 = reken([met(95, [[40, 95]]), met(100, [[40, 95], [20, 95]]), met(100, [[40, 95.01]]), met(200, [[60, 190]]), met(200, [[60, 190.01]]), met(99.5, [[8, 87.25]])]);
    toets('14d gelijkspel en drempel: nu = minimum = "laagste"; minimum op twee dagen = de laatste dag; € 5 en 5 % precies op de grens wel, een cent erboven niet',
      R14[0][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 95, gelezen 11-11)' && R14[1][0] === 'Kieskeurig: op 22-10 was het € 95 (nu € 100); laagste in 90 dagen'
      && R14[2][0] === null && R14[2][1] === 'geen duidelijk verschil' && R14[3][0] === 'Kieskeurig: op 12-9 was het € 190 (nu € 200); laagste in 90 dagen' && R14[4][0] === null
      && R14[5][0] === 'Kieskeurig: op 3-11 was het € 87,25 (nu € 99,50); laagste in 90 dagen', R14);
    R14 = reken([elke(88, 4, 120).concat([[84, 0], [80, -3], [76, 'x'], [72, true], ['2026-02-30T00:00:00Z', 1], ['kapot', 1], [44, 130]]),
      elke(88, 4, 120).concat([[0, 150], [-2, 10]]), elke(150, 4, 120).concat([[120, 1]])]);
    toets('14e alleen geldige punten (bedrag > 0, echte datum), per dag de laagste, niets uit de toekomst of van vóór het venster',
      R14[0][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 120, gelezen 11-11)' && R14[1][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 120, gelezen 11-11)'
      && R14[2][0] === 'Kieskeurig: laagste prijs in 90 dagen (€ 120, gelezen 11-11)', R14);
    x = draai(geval('f', GOED, vol(110, 110, -1), true), ADVIES);
    const xf2 = draai(geval('f2', GOED, null), ADVIES);
    toets('14f prijshistorie verborgen of productpagina weg = geen zin (en wel de reden)', x.zin === null && x.reden === 'prijshistorie verborgen' && xf2.zin === null && /HTTP 404/.test(xf2.reden), [x, xf2]);
    // diff-review wv2946: MOET 1 (typevoorvoegsel, alle typenummers gelijk), MOET 2 (doorsturen / ander product op de pagina), MOET 3 (begrensd uitpakken)
    const xg1 = draai(geval('m1', [item('Proefmerk Professional GSB 18V-55 Klopboormachine', 'Proefmerk', 777)], vol(110, 110, -1)), 'Proefmerk Professional GSR 18V-55 accuboormachine');
    const xg1b = draai(geval('m1c', [item('Proefmerk gsb 18V-55 Klopboormachine', 'Proefmerk', 777)], vol(110, 110, -1)), 'Proefmerk gsr 18V-55 accuboormachine');
    const xg5 = draai(geval('m3', [item('Proefmerk Stekkerdoos 3-voudig zwart 60x130 - 5 meter', 'Proefmerk', 777)], vol(110, 110, -1)), 'Proefmerk stekkerdoos 3-voudig zwart 60x130, 5 meter');
    const xg2 = draai(geval('m1b', [item('Proefmerk PR552/00 PR553/00 Airfryer - 9L - Zwart', 'Proefmerk', 777)], vol(110, 110, -1)), ADVIES);
    const mDoor = geval('m2', GOED, vol(110, 110, -1)); fs.writeFileSync(path.join(mDoor, '777.html.doorsturen'), 'https://www.kieskeurig.nl/airfryer/product/888-ander');
    const xg3 = draai(mDoor, ADVIES);
    const xg4 = draai(geval('m2b', GOED, vol(110, 110, -1), false, 'Proefmerk 5000 series PR555/00 Airfryer - 9L - Zwart'), ADVIES);
    toets('14f2 (review MOET 1+2, ronde 2) GSR ≠ GSB bij hetzelfde 18V-55, ook in kleine letters; 3-voudig en 60x130 zijn geen typenummer; een extra typenummer aan één kant = geen zin; productpagina doorgestuurd of met een ander product in de JSON-LD = geen zin',
      xg1.zin === null && /ander of geen modelnummer/.test(xg1.reden) && xg1b.zin === null && /ander of geen modelnummer/.test(xg1b.reden) && xg5.zin === null && xg5.reden === 'geen modelnummer in het advies' && xg2.zin === null && xg3.zin === null && /doorgestuurd/.test(xg3.reden) && xg4.zin === null && /ander product/.test(xg4.reden), [xg1, xg2, xg3, xg4]);
    const bom = JSON.parse(cp.execFileSync('python3', ['-I', '-B', '-c', [
      'import importlib.util, json, zlib', 'uit = []',
      'for f in ("prijshistorie.py", "winkel-score.py"):',
      '    s = importlib.util.spec_from_file_location("m", f); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      '    c = zlib.compressobj(9, zlib.DEFLATED, 31); g = c.compress(b"0" * (5 * 1024 * 1024)) + c.flush()',
      '    try:', '        m.uitpakken(g); uit.append("door")', '    except ValueError as e:', '        uit.append(str(e))',
      '    c = zlib.compressobj(9, zlib.DEFLATED, 31); uit.append(len(m.uitpakken(c.compress(b"klein") + c.flush())))',
      'print(json.dumps(uit))'].join('\n')], { encoding: 'utf8' }));
    toets('14f3 (review MOET 3) beide leesscripts pakken gzip begrensd uit: 5 MB uitgepakt = "pagina te groot", klein gaat door', JSON.stringify(bom) === JSON.stringify(['pagina te groot', 5, 'pagina te groot', 5]), bom);
    const mag = JSON.parse(cp.execFileSync('python3', ['-I', '-B', '-c', [
      'import importlib.util, json', 's = importlib.util.spec_from_file_location("ph", "prijshistorie.py"); ph = importlib.util.module_from_spec(s); s.loader.exec_module(ph)',
      'print(json.dumps([ph.mag(u) for u in ["https://www.kieskeurig.nl/search?q=proef%2Fx+s", "https://www.kieskeurig.nl/airfryer/merk/proef", "http://www.kieskeurig.nl/search?q=x",',
      '  "https://kieskeurig.nl/search?q=x", "https://www.kieskeurig.nl.evil.example/search?q=x", "https://www.kieskeurig.nl:8443/search?q=x", "https://www.kieskeurig.nl/product-clickout/1/2",',
      '  "https://www.kieskeurig.nl/airfryer?merken=proef", "https://www.kieskeurig.nl/airfryer?prijs=1-2", "https://www.kieskeurig.nl/api/x", "https://www.kieskeurig.nl/x/ajax/y"]]))'].join('\n')], { encoding: 'utf8' }));
    toets('14g alleen https op www.kieskeurig.nl (poort 443) en geen pad of query die robots.txt verbiedt', JSON.stringify(mag) === JSON.stringify([true, true, false, false, false, false, false, false, false, false, false]), mag);
    const py = fs.readFileSync('prijshistorie.py', 'utf8'), pyCode = py.slice(py.indexOf('import gzip'));
    toets('14h leesscript: alleen GET (geen data/POST), doorsturen gaat langs mag(), eigen User-Agent, geen omgevingsvariabelen, schrijft niets weg',
      /redirect_request[\s\S]{0,200}if not mag\(doel\)/.test(py) && /Socev-Shopper\/1\.0/.test(py) && !/os\.environ|getenv|open\([^)]*['"]w|method=|data=/.test(pyCode) && /HOST = "www\.kieskeurig\.nl"/.test(py));

    // shopper.js: prijshistorieBij (één lezing per 7 dagen, na een fout na 6 uur; alleen open + advies; vaste zinvorm en Kieskeurig-link)
    const V14 = path.join(W, 'v14'), M14 = path.join(V14, '20_Prive/Shopper'); fs.mkdirSync(M14, { recursive: true });
    const pag14 = (naam, status, product) => fs.writeFileSync(path.join(M14, naam + '.md'), pagina(['type: shopper-zoektocht', 'wens: "Proefairfryer"', 'status: ' + status, 'gezocht: 2026-11-10T09:00+01:00', 'aantal: 1', 'opties:',
      '  - {id: o1, winkel: "Proefwinkel", product: "' + product + '", prijs_eur: 110, verzending_eur: 0, totaal_eur: 110, url: "https://www.proefwinkel.nl/p/1"}', 'advies: o1']));
    pag14('Shopper - 2026-11-10 - A', 'open', ADVIES); pag14('Shopper - 2026-11-10 - B', 'open', 'Proefmerk PR999/00 Airfryer'); pag14('Shopper - 2026-11-10 - C', 'gekocht', ADVIES);
    let klok = new Date('2026-11-11T12:00:00Z'), vragen = [], antwoord = { zin: 'Kieskeurig: laagste prijs in 90 dagen (€ 110, gelezen 11-11)', reden: 'laagste', url: 'https://www.kieskeurig.nl/airfryer/product/777-proef' }, los = null;
    const PP14 = path.join(W, 'prijs14.json'), AP14 = path.join(W, 'aanwijs14.json');
    const m14 = S.maak({ vault: V14, vv: VV, nu: () => klok, prijsPad: PP14, aanwijsPad: AP14, prijsLezer: (inv) => { vragen.push(inv); return new Promise((r) => { los = () => r(antwoord); }); } });
    const idA = S.idVan('20_Prive/Shopper/Shopper - 2026-11-10 - A.md'), idB = S.idVan('20_Prive/Shopper/Shopper - 2026-11-10 - B.md'), idC = S.idVan('20_Prive/Shopper/Shopper - 2026-11-10 - C.md');
    const ph = (id) => m14.zoektocht(id).body.zoektocht.prijshistorie;
    const p1 = ph(idA), pB = ph(idB), pC = ph(idC);
    await new Promise((r) => setTimeout(r, 5));
    toets('14i eerste keer openen: stand leest, één vraag met alleen de productnaam van het advies; tweede zoektocht wacht (één tegelijk); gekocht = niets',
      p1 && p1.stand === 'leest' && vragen.length === 1 && JSON.stringify(vragen[0]) === JSON.stringify({ product: ADVIES }) && pB === null && pC === null, [p1, pB, pC, vragen]);
    toets('14j zolang de lezing loopt: nog steeds leest, geen tweede vraag', ph(idA).stand === 'leest' && vragen.length === 1);
    los(); await new Promise((r) => setTimeout(r, 20));
    const p2 = ph(idA), st14 = JSON.parse(fs.readFileSync(PP14, 'utf8'));
    toets('14k daarna de zin met leesdatum en Kieskeurig-link; staatbestand 0600 met alleen tijd, vingerafdruk, zin, url, fout (geen productnaam)',
      p2 && p2.zin === antwoord.zin && p2.url === antwoord.url && p2.t === klok.toISOString() && (fs.statSync(PP14).mode & 0o777) === 0o600
      && JSON.stringify(Object.keys(st14[idA]).sort()) === JSON.stringify(['fout', 'p', 't', 'url', 'zin']) && !/Proefmerk|PR552/.test(fs.readFileSync(PP14, 'utf8')), [p2, st14]);
    klok = new Date(klok.getTime() + 6 * 86400000); const p3 = ph(idA);
    klok = new Date(klok.getTime() + 2 * 86400000); const p4 = ph(idA);
    toets('14l na 6 dagen geen nieuwe lezing (zin blijft), na 8 dagen wel', p3 && p3.zin === antwoord.zin && p4 && p4.stand === 'leest' && vragen.length === 2, [p3, p4, vragen.length]);
    antwoord = { zin: null, reden: 'fout: zoeken gaf HTTP 503', url: null }; los(); await new Promise((r) => setTimeout(r, 20));
    const p5 = ph(idA); klok = new Date(klok.getTime() + 5 * 3600000); const p6 = ph(idA); klok = new Date(klok.getTime() + 2 * 3600000); const p7 = ph(idA);
    toets('14m leesfout: geen zin; na 5 uur niet opnieuw, na 7 uur wel', p5 === null && p6 === null && p7 && p7.stand === 'leest' && vragen.length === 3, [p5, p6, p7, vragen.length]);
    antwoord = { zin: 'Kieskeurig: koop nu, wacht niet!', reden: 'laagste', url: 'https://evil.example/x' }; los(); await new Promise((r) => setTimeout(r, 20));
    const p8 = ph(idA);
    pag14('Shopper - 2026-11-10 - A', 'open', 'Proefmerk PR552/00 Airfryer 9L zwart refurbished');
    const p9 = ph(idA);
    toets('14n een zin buiten de vaste vorm (koopadvies) telt niet; een ander advies-product = opnieuw lezen ondanks de verse uitkomst', p8 === null && p9 && p9.stand === 'leest' && vragen.length === 4 && vragen[3].product !== ADVIES, [p8, p9, vragen.length]);
    antwoord = { zin: 'Kieskeurig: op 3-11 was het € 87,25 (nu € 99,50); laagste in 90 dagen', reden: 'was_lager', url: 'https://www.kieskeurig.nl/../x' }; los(); await new Promise((r) => setTimeout(r, 20));
    const p10 = ph(idA);
    toets('14o tweede zinvorm komt door; een Kieskeurig-link die niet op een productpagina wijst wordt null', p10 && p10.zin === antwoord.zin && p10.url === null, p10);
    const m14z = S.maak({ vault: V14, vv: VV, nu: () => klok });
    toets('14p zonder lezer of pad (oude pod): prijshistorie null, geen fout', m14z.zoektocht(idA).body.zoektocht.prijshistorie === null);
    // aanwijsteller (stap A)
    klok = new Date('2026-11-30T22:30:00Z');   // 23:30 in Nederland, nog november
    const a1 = m14.aanwijs(); m14.aanwijs(); klok = new Date('2026-11-30T23:30:00Z'); m14.aanwijs();   // 00:30 NL = december
    const ast = JSON.parse(fs.readFileSync(AP14, 'utf8'));
    toets('14q aanwijsteller: alleen {maand: aantal} in Nederlandse tijd, 0600; info() geeft het aantal van deze maand', a1.status === 200 && JSON.stringify(ast) === JSON.stringify({ '2026-11': 2, '2026-12': 1 })
      && (fs.statSync(AP14).mode & 0o777) === 0o600 && m14.info().aanwijzen_maand === 1 && m14z.aanwijs().status === 404, [ast, m14.info()]);
    const src14 = fs.readFileSync('server.js', 'utf8'), bl14 = src14.slice(src14.indexOf('const shopper = (function () {'), src14.indexOf('// ── einde OVIS Shopper ──'));
    toets('14r server.js: POST /app/shopper/aanwijs met eigen teller (60/uur); prijshistorie.py kaal (alleen PATH/LANG/HOME), productnaam via stdin, 90 s; klokken-paden; uitrol-lijst',
      /route === 'POST \/app\/shopper\/aanwijs'/.test(bl14) && /appTeller\('shopper_aanwijs', 60, 3600000\)/.test(bl14) && /'prijshistorie\.py'/.test(bl14)
      && /execFile\('python3', \['-I', prijsScript\], \{ timeout: 90000[^}]*env: \{ PATH: process\.env\.PATH \|\| '\/usr\/bin:\/bin', LANG: 'C\.UTF-8', HOME: '\/tmp' \}/.test(bl14)
      && /k\.stdin\.end\(JSON\.stringify\(invoer\)\)/.test(bl14.slice(bl14.indexOf('prijsScript'))) && /shopper-prijshistorie\.json/.test(bl14) && /shopper-aanwijzen\.json/.test(bl14)
      && /RELEASE_OPTIONEEL="[^"]*\bprijshistorie\.py\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
  }


  // ── 15. wv2947: tab Winkels — "hier kocht je eerder" ook uit Facturen (verzonnen facturendatabase, alleen lezen) ──
  {
    const WM = require('./shopper-winkels.js'), F = require('./facturen-db.js'), FD = path.join(W, 'facturen15'), fdb = F.open(FD), db = fdb.db, nu = '2026-11-02T10:00:00.000Z';
    for (const e of ['groenhouten', 'tolgaarde', 'prive']) db.prepare('INSERT INTO entiteit (sleutel, naam) VALUES (?, ?)').run(e, 'Proef ' + e);
    const lev = (id, naam) => db.prepare('INSERT INTO leverancier (id, naam, genormaliseerd, aangemaakt_op) VALUES (?, ?, ?, ?)').run(id, naam, naam.toLowerCase(), nu);
    lev('b000000000000001', 'Koelblauw B.V.'); lev('b000000000000002', 'Bolwerk Proefhandel'); lev('b000000000000003', 'Vosproef - A. Vos en Zonen B.V.');
    let nr = 0;
    const fac = (x) => { nr++; const h = String(nr).padStart(15, '0'); db.prepare('INSERT INTO document (id, sha256, soort, aangemaakt_op) VALUES (?, ?, ?, ?)').run('d' + h, require('crypto').createHash('sha256').update('wv2947-' + nr).digest('hex'), 'pdf', nu);
      db.prepare('INSERT INTO factuur (id, document, soort, leverancier, leverancier_naam, factuurdatum, incl, incl_eur, valuta, entiteit, status, dubbel_van, aangemaakt_op, bijgewerkt_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('f' + h, 'd' + h, x.soort || 'factuur', x.lev || null, x.naam || null, x.datum === undefined ? '2026-10-03' : x.datum, 1999, 1999, 'EUR', x.ent === undefined ? 'groenhouten' : x.ent, x.st || 'te_beoordelen', x.dubbel || null, x.aan || nu, nu); return 'f' + h; };
    const arch = (x) => { nr++; db.prepare('INSERT INTO factuur_archief (id, herkomst, extern_id, entiteit, leverancier_naam, factuurdatum, incl, status, alleen_eigenaar, aangemaakt_op) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('a' + String(nr).padStart(15, '0'), 'fv2', 'x' + nr, x.ent || 'tolgaarde', x.naam, x.datum || '2026-05-01', 999, x.st === undefined ? 'beslist' : x.st, 1, nu); };
    const f1 = fac({ lev: 'b000000000000001', datum: '2026-08-04' });            // Koelblauw via leverancier.naam
    fac({ naam: 'Koelblauw B.V.', datum: '2026-06-01', ent: 'tolgaarde' });      // zonder leverancier-id (leverancier_naam), andere praktijk telt mee
    fac({ lev: 'b000000000000001', datum: '2026-09-09', soort: 'creditnota' });  // creditnota telt niet
    fac({ lev: 'b000000000000001', datum: '2026-09-10', st: 'geen_factuur' });   // geen factuur telt niet
    fac({ lev: 'b000000000000001', datum: '2026-09-11', dubbel: f1 });           // dubbel telt niet
    fac({ lev: 'b000000000000001', datum: '2026-09-12', ent: 'prive' });          // privé telt niet
    fac({ lev: 'b000000000000001', datum: '2026-09-13', ent: null });            // zonder entiteit telt niet
    fac({ lev: 'b000000000000002', datum: '2026-09-14' });                       // Bolwerk ≠ bol (heel woord)
    fac({ naam: 'Proefbol.com B.V.', datum: '2026-09-15' });                     // Proefbol ≠ bol
    fac({ naam: 'bol.com b.v.', datum: '2026-09-16' });                          // bol: naam én domein
    fac({ lev: 'b000000000000003', datum: null, aan: '2026-11-04T09:00:00.000Z' });   // Vosproef via naam; geen factuurdatum = aangemaakt_op
    arch({ naam: 'Koelblauw B.V.', datum: '2026-10-20' });                       // FV2-archief telt mee
    arch({ naam: 'Vosproef.nl', datum: '2026-07-07' });                          // domein als naam: past op de winkelnaam
    arch({ naam: 'Koelblauw B.V.', datum: '2026-10-25', st: 'genegeerd' });      // genegeerd telt niet
    arch({ naam: 'Koelblauw B.V.', datum: '2026-10-26', st: 'geen_factuur' });   // geen factuur telt niet
    arch({ naam: 'Inktproef.nl', datum: '2026-03-03', st: null });               // status leeg telt mee
    arch({ naam: 'Nergensproef BV', datum: '2026-04-04' });                      // geen winkel in de lijst: wordt geen winkel
    F.sluit ? F.sluit(fdb) : db.close();
    const FP = path.join(FD, 'facturen.sqlite'), hashVan = () => require('crypto').createHash('sha256').update(fs.readFileSync(FP)).digest('hex') + ':' + fs.statSync(FP).mtimeMs;
    const voorHash = hashVan();
    const FAV15 = ['---', 'type: shopper-favorieten', 'winkels:',
      '  - {domein: bol.com, naam: "bol", aan: true, categorie: alles, lezen: script}',
      '  - {domein: koelblauw.nl, naam: "Koelblauw", aan: true, categorie: elektronica, lezen: script}',
      '  - {domein: koelblauw.be, naam: "Koelblauw België", aan: false, categorie: elektronica, lezen: script}',
      '  - {domein: vosproef.nl, naam: "Vosproef", aan: true, categorie: medisch, lezen: script}',
      '  - {domein: inktproef.be, naam: "Inktproef België", aan: false, categorie: kantoor, lezen: script}',
      '  - {domein: inktproef.nl, naam: "Inktproef", aan: true, categorie: kantoor, lezen: script}',
      '  - {domein: leegproef.nl, naam: "Leegproef", aan: true, categorie: huis, lezen: script}',
      '---', ''].join('\n');
    const V15 = path.join(W, 'vault15'), VT = path.join(V15, '10_Zakelijk/Tolgaarde/Shopper');
    fs.mkdirSync(VT, { recursive: true }); fs.mkdirSync(path.join(V15, '00_Systeem'), { recursive: true });
    fs.writeFileSync(path.join(V15, '00_Systeem/Shopper - favoriete winkels.md'), FAV15);
    fs.writeFileSync(path.join(VT, 'Shopper - 2026-11-09 - Proefkabel.md'), ['---', 'type: shopper-zoektocht', 'wens: "Proefkabel"', 'status: gekocht',
      'gekocht: {optie: o1, winkel: "Vosproef", bedrag_eur: 9.9, datum: "2026-11-09", opmerking: null, via: app}', 'gezocht: 2026-11-09T09:00+01:00', 'aantal: 1', 'opties:',
      '  - {id: o1, winkel: "Vosproef", verkoper: "Vosproef", product: "Kabel", koop_aantal: 1, prijs_eur: 9.9, verzending_eur: 0, totaal_eur: 9.9, url: "https://www.vosproef.nl/p/k"}',
      'advies: o1', '---', ''].join('\n'));
    const m15 = S.maak({ vault: V15, vv: VV, facturenPad: () => FP });
    const r15 = m15.winkels(), wk = (d) => r15.body.winkels.find((w) => w.domein === d);
    toets('15a facturen per winkel: factuur + FV2-archief, alle praktijken; creditnota/geen factuur/dubbel/privé/zonder entiteit/genegeerd tellen niet',
      r15.status === 200 && r15.body.facturen_stand === 'ok' && JSON.stringify(wk('koelblauw.nl').facturen) === JSON.stringify({ aantal: 3, laatst: '2026-10-20' }), wk('koelblauw.nl'));
    toets('15b landvariant telt dezelfde facturen niet twee keer: naam gaat vóór domein (Koelblauw ≠ Koelblauw België), bij gelijke sterkte de eerste in de lijst',
      wk('koelblauw.be').facturen === null && JSON.stringify(wk('inktproef.nl').facturen) === JSON.stringify({ aantal: 1, laatst: '2026-03-03' }) && wk('inktproef.be').facturen === null,
      [wk('koelblauw.be'), wk('inktproef.nl'), wk('inktproef.be')]);
    toets('15c bol: alleen "bol.com b.v." (heel woord), Bolwerk en Proefbol tellen niet', JSON.stringify(wk('bol.com').facturen) === JSON.stringify({ aantal: 1, laatst: '2026-09-16' }), wk('bol.com'));
    toets('15d Vosproef: leveranciersnaam met toevoeging en zonder factuurdatum (aangemaakt_op) + archief; naast de eigen aankoop uit Gekocht',
      JSON.stringify(wk('vosproef.nl').facturen) === JSON.stringify({ aantal: 2, laatst: '2026-11-04' }) && wk('vosproef.nl').gekocht.aantal === 1, wk('vosproef.nl'));
    toets('15e geen nieuwe winkels uit Facturen: alleen de lijst, Nergensproef nergens; winkel zonder facturen = facturen null en blijft onbekend zonder score',
      r15.body.winkels.length === 7 && !JSON.stringify(r15.body).includes('Nergensproef') && wk('leegproef.nl').facturen === null && wk('leegproef.nl').onbekend === true
      && wk('koelblauw.nl').onbekend === false && r15.body.elders.length === 0, r15.body.winkels.map((w) => w.domein));
    const bodyTekst = JSON.stringify(r15.body);
    toets('15f geen bedrag, geen leveranciersnaam, geen entiteit en geen factuur-id in het antwoord', !/19\.99|1999|9\.99|"999"|B\.V\.|A\. Vos|groenhouten|tolgaarde|prive|"f0000|"a0000|bedrag/i.test(bodyTekst.replace(/"verzend":null/g, '')), bodyTekst.slice(0, 400));
    toets('15g de facturendatabase is na de vraag byte-gelijk (niets geschreven)', hashVan() === voorHash);
    const m15b = S.maak({ vault: V15, vv: VV, facturenPad: () => { throw new Error('kapot'); } }), m15c = S.maak({ vault: V15, vv: VV, facturenPad: () => null }), m15d = S.maak({ vault: V15, vv: VV });
    toets('15h facturenPad gooit / null / ontbreekt: tab gewoon 200, facturen_stand geen, per winkel facturen null',
      [m15b, m15c, m15d].every((x) => { const r = x.winkels(); return r.status === 200 && r.body.facturen_stand === 'geen' && r.body.winkels.every((w) => w.facturen === null); }));
    const k = { sleutelVan: S.sleutelVan, hostKern: S.hostKern, woorden: (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean) };
    const ws15 = WM.winkelsVan(FAV15);
    const pw = WM.facturenPerWinkel([{ naam: 'Koelblauw', aantal: 2, laatst: '2026-01-02' }, { naam: 'Koelblauw', aantal: 0, laatst: '2026-12-31' }, { naam: 'koelblauw', aantal: 1.5, laatst: '2026-12-30' },
      { naam: 'Koelblauw', aantal: 1, laatst: 'gisteren' }, null], ws15, k);
    toets('15i facturenPerWinkel: aantal 0/geen geheel getal telt niet, rare datum geen laatst; zonder hulpfuncties of groepen = leeg',
      JSON.stringify(pw) === JSON.stringify({ 'koelblauw.nl': { aantal: 3, laatst: '2026-01-02' } }) && JSON.stringify(WM.facturenPerWinkel(null, ws15, k)) === '{}'
      && JSON.stringify(WM.facturenPerWinkel([{ naam: 'Koelblauw', aantal: 1 }], ws15, null)) === '{}', pw);
    const bron15 = fs.readFileSync('shopper.js', 'utf8');
    toets('15j shopper.js: de telling loopt via metFacturen (readOnly + query_only), alleen SELECT', /const fac = metFacturen\(\(db\) => db\.prepare\(FAC_WINKEL_SQL\)\.all\(\)/.test(bron15)
      && /^const FAC_WINKEL_SQL = "SELECT /m.test(bron15) && !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|ATTACH)\b/.test(bron15));
  }

  // ── 16. wv4171 (2C96): "Wacht op jou" (wacht_op_jou + antwoord), link naar de zoektocht in het agentrapport ──
  {
    const V16 = path.join(W, 'vault16'), PR16 = path.join(V16, '20_Prive/Shopper');
    fs.mkdirSync(PR16, { recursive: true });
    const P16 = path.join(PR16, 'Shopper - 2026-11-02 - Proefplisse.md');
    const fm16 = ['type: shopper-zoektocht', 'wens: "Proefplisse keuken"', 'status: open', 'wacht_op_jou: "Raambreedte en -hoogte van de keuken"', 'gezocht: 2026-11-02T17:36+01:00',
      'eisen: ["honingraat"]', 'opties:', opt('o1', { p: 44.99, v: 0, t: 44.99, u: 'https://www.proefwinkel.nl/p/g/1/' }), 'advies: o1'];
    const bron16 = pagina(fm16, '# Proef\n');
    fs.writeFileSync(P16, bron16);
    fs.writeFileSync(path.join(PR16, 'Shopper - 2026-11-03 - Gekocht met vraag.md'), pagina(['type: shopper-zoektocht', 'wens: "Gekocht met vraag"', 'status: gekocht', 'wacht_op_jou: "oude vraag"', 'gezocht: 2026-11-03T09:00+01:00']));
    let klok = new Date('2026-11-06T09:00:00Z'), starts = [], startAntwoord = { ok: true, job_id: 'abcdef0123456789' };
    const PP = require('./intake/patientpoort.js'), POORT = (t) => PP.beoordeel({ teksten: t }, { eigen: PP.maakEigen(null, {}) });
    const m16 = S.maak({ vault: V16, vv: VV, nu: () => klok, opnieuwPad: path.join(W, 'opnieuw16.json'), grondwet: () => 'GRONDWET-KERN v1 — proefblok', poort: POORT,
      agentStart: async (pr) => { starts.push(pr); return startAntwoord; }, agentStand: () => 'loopt' });
    const L16 = m16.lijst().body.zoektochten, z16 = L16.find((x) => x.wens === 'Proefplisse keuken'), g16 = L16.find((x) => x.wens === 'Gekocht met vraag');
    toets('16a lijst en zoektocht: wacht_op_jou bij open; bij gekocht null', z16.wacht_op_jou === 'Raambreedte en -hoogte van de keuken' && g16.wacht_op_jou === null
      && m16.zoektocht(z16.id).body.zoektocht.wacht_op_jou === 'Raambreedte en -hoogte van de keuken', [z16, g16]);
    let r = await m16.antwoord(z16.id, { antwoord: 'x', extra: 1 });
    toets('16b antwoord: extra veld / leeg / te lang = 400', r.status === 400 && (await m16.antwoord(z16.id, { antwoord: '  ' })).status === 400 && (await m16.antwoord(z16.id, { antwoord: 'a'.repeat(201) })).status === 400);
    toets('16c antwoord op gekocht = 409; onbekende id = 404', (await m16.antwoord(g16.id, { antwoord: '120 x 140' })).status === 409 && (await m16.antwoord('000000000000', { antwoord: '1' })).status === 404);
    r = await m16.antwoord(z16.id, { antwoord: 'keuken 120 breed, 140 hoog' });
    const na16 = fs.readFileSync(P16, 'utf8');
    toets('16d antwoord: 200, eis erbij, wacht_op_jou weg, aangepast gezet, opnieuw gestart (één agent)', r.status === 200 && JSON.stringify(r.body.eisen) === JSON.stringify(['honingraat', 'keuken 120 breed, 140 hoog'])
      && r.body.zoekt && r.body.zoekt.stand === 'loopt' && !/wacht_op_jou/.test(na16) && /aangepast: "2026-11-06 door David"/.test(na16) && starts.length === 1, [r, na16.slice(0, 400)]);
    toets('16e de rest van de pagina byte-gelijk', na16.replace(/^eisen: .*\naangepast: .*\n/m, 'eisen: ["honingraat"]\n') === bron16.replace(/^wacht_op_jou: .*\n/m, ''), na16.slice(0, 400));
    toets('16f opnieuw-opdracht: link naar deze zoektocht en de wacht_op_jou-regel', starts[0].includes('[Open de zoektocht](/?app=shopper&zt=' + z16.id + ')') && /wacht_op_jou: "<wat je van David mist/.test(starts[0]));
    toets('16g tweede antwoord = 409 (geen vraag meer), geen tweede agent', (await m16.antwoord(z16.id, { antwoord: 'nog eens' })).status === 409 && starts.length === 1);
    const n16 = S.nieuwOpdracht({ grondwet: 'GRONDWET-KERN v1', start_id: 'abcdef012345', wens: 'x', eisen: [] });
    toets('16h nieuw-opdracht: link met de start_id en de wacht_op_jou-regel', n16.includes('[Open de zoektocht](/?app=shopper&zt=abcdef012345)') && n16.includes('wacht_op_jou:'));
    // review MOET 1: vol tijdens het schrijven (andere schrijver zette intussen de twintigste eis) = 409, vraag blijft, niets afgekapt
    const P16b = path.join(PR16, 'Shopper - 2026-11-04 - Bijna vol.md'), eisen19 = Array.from({ length: 19 }, (_, i) => '"eis ' + i + '"');
    fs.writeFileSync(P16b, pagina(['type: shopper-zoektocht', 'wens: "Bijna vol"', 'status: open', 'wacht_op_jou: "maat?"', 'gezocht: 2026-11-04T09:00+01:00', 'eisen: [' + eisen19.join(', ') + ']']));
    const id16b = S.idVan('20_Prive/Shopper/Shopper - 2026-11-04 - Bijna vol.md');
    const vvVol = Object.assign({}, VV, { wijzig: (pad, fn) => { const t = fs.readFileSync(pad, 'utf8').replace('"eis 18"]', '"eis 18", "eis 19"]'); fs.writeFileSync(pad, t); return VV.wijzig(pad, fn); } });
    const r16b = await S.maak({ vault: V16, vv: vvVol, nu: () => klok, opnieuwPad: path.join(W, 'opnieuw16b.json'), grondwet: () => 'GRONDWET-KERN v1', poort: POORT, agentStart: async () => startAntwoord, agentStand: () => 'loopt' }).antwoord(id16b, { antwoord: '80 x 120' });
    toets('16k vol onder het slot: 409, wacht_op_jou blijft, antwoord niet afgekapt weggeschreven', r16b.status === 409 && /wacht_op_jou: "maat\?"/.test(fs.readFileSync(P16b, 'utf8')) && !/80 x 120/.test(fs.readFileSync(P16b, 'utf8')), r16b);
    toets('16i opnieuw-opdracht zonder geldige id: link naar Shopper zelf', S.opnieuwOpdracht({ grondwet: 'GRONDWET-KERN v1', pad: 'a.md', entiteit: 'prive', wens: 'x', eisen: [] }).includes('[Open Shopper](/?app=shopper)'));
    const src16 = fs.readFileSync('server.js', 'utf8'), bl16 = src16.slice(src16.indexOf('const shopper = (function () {'), src16.indexOf('// ── einde OVIS Shopper ──'));
    toets('16j server.js: routes antwoord (status- en opnieuw-teller) en bedrag (statusteller)', /\\\/antwoord\$\/[\s\S]{0,200}shopper_status[\s\S]{0,200}shopper_opnieuw[\s\S]{0,200}shopper\.antwoord\(m\[1\], d\)/.test(bl16)
      && /\\\/bedrag\$\/[\s\S]{0,200}shopper_status[\s\S]{0,200}shopper\.bedrag\(m\[1\], d\)/.test(bl16));
  }

  // ── 17. wv4183 (2C70 stap 1): "Was dit hem?" — bestelling uit Pakjes bij een optie-winkel van een open zoektocht ──
  {
    const V17 = path.join(W, 'vault17');
    for (const mp of S.MAPPEN) fs.mkdirSync(path.join(V17, mp[2]), { recursive: true });
    const TG = '10_Zakelijk/Tolgaarde/Shopper', PRV = '20_Prive/Shopper';
    const PB = path.join(V17, TG, 'Shopper - 2026-11-20 - Proefkopjes.md'), PP = path.join(V17, PRV, 'Shopper - 2026-11-02 - Proefplisse.md');
    const bronB = pagina(['type: shopper-zoektocht', 'wens: "Proefkopjes"', 'status: open', 'gezocht: 2026-11-20T15:30+01:00', 'opties:',
      opt('o1', { w: 'Proefmedisch', p: 10.95, v: 6.5, t: 50.3, u: 'https://www.proefmedisch.nl/p/1' }), opt('o2', { w: 'Proefmedisch', p: 10.95, v: 6.5, t: 50.3, u: 'https://www.proefmedisch.nl/p/2' }),
      opt('o3', { w: 'Andere Proefzaak', p: 18, v: 0, t: 72, u: 'https://www.andereproefzaak.nl/p/3' }), 'advies: o1'], '# Proefkopjes\n\nlijf blijft\n');
    fs.writeFileSync(PB, bronB);
    fs.writeFileSync(PP, pagina(['type: shopper-zoektocht', 'wens: "Proefplisse"', 'status: open', 'gezocht: 2026-11-06T09:48+01:00', 'opties:',
      opt('o1', { w: 'bol', p: 44.99, v: 0, t: 44.99, u: 'https://www.bol.com/nl/nl/p/x/1/' }), 'advies: o1']));
    fs.writeFileSync(path.join(V17, TG, 'Shopper - 2026-11-10 - Al gekocht.md'), pagina(['type: shopper-zoektocht', 'wens: "Al gekocht"', 'status: gekocht', 'gezocht: 2026-11-10T09:00+01:00', 'opties:',
      opt('o1', { w: 'Proefmedisch', p: 1, v: 0, t: 1, u: 'https://www.proefmedisch.nl/p/9' })]));
    // de bestellingen uit Pakjes: een echte pakjes.js op een eigen map (verzonnen rijen)
    const P = require('./pakjes.js'), PD = path.join(W, 'pakjes17'), pk = P.maak({ dir: PD, nu: () => Date.parse('2026-11-27T12:00:00Z') });
    pk.bestellingen('2026-01-01T00:00:00Z');
    const { DatabaseSync } = require('node:sqlite'), pdb = new DatabaseSync(path.join(PD, 'pakjes.sqlite'));
    const zr = (id, sleutel, winkel, eerste, verborgen) => pdb.prepare("INSERT INTO zending (id, sleutel, vervoerder, winkel, eerste, bijgewerkt, verborgen) VALUES (?, ?, 'winkel', ?, ?, ?, ?)").run(id, sleutel, winkel, eerste, eerste, verborgen || null);
    zr('aaaaaaaaaaa1', 'winkel:proefmedisch.nl:111', 'Proefmedisch', '2026-11-20T08:00:00.000Z');     // vóór de zoektocht (zelfde dag, 's ochtends)
    zr('aaaaaaaaaaa2', 'winkel:proefmedisch.nl:222', 'Proefmedisch', '2026-11-21T10:00:00.000Z');     // de bestelling
    zr('aaaaaaaaaaa3', 'winkel:heelanders.nl:333', 'Heel Andere Winkel', '2026-11-22T10:00:00.000Z');   // andere winkel
    zr('aaaaaaaaaaa4', 'winkel:bol.com:444', 'bol', '2026-11-24T09:00:00.000Z');                      // bestelmail bol
    zr('aaaaaaaaaaa5', 'dhl:CODE5', 'bol', '2026-11-24T14:00:00.000Z');                               // vervoerderrij van dezelfde bestelling
    zr('aaaaaaaaaaa6', 'winkel:proefbol.nl:666', 'Proefbol', '2026-11-25T09:00:00.000Z');              // Proefbol ≠ bol
    zr('aaaaaaaaaaa7', 'winkel:proefmedisch.nl:777', 'Proefmedisch', '2026-11-26T09:00:00.000Z', '2026-11-26T10:00:00.000Z');   // verborgen
    zr('aaaaaaaaaaa8', 'winkel:proefmedisch.nl:888', 'Proefmedisch', '2026-09-01T09:00:00.000Z');     // ouder dan 45 dagen
    pdb.prepare("INSERT INTO zending (id, sleutel, vervoerder, winkel, eerste, bijgewerkt) VALUES ('aaaaaaaaaaa9', 'dpd:X', 'dpd', NULL, '2026-11-25T09:00:00.000Z', '2026-11-25T09:00:00.000Z')").run();
    let pl = pk.bestellingen('2026-01-01T00:00:00Z');
    toets('17a pakjes.bestellingen: id, winkel, dag, eerste, domein uit een winkelrij; geen verborgen, geen zonder winkel, niet ouder dan 45 dagen', pl.length === 6
      && pl.find((x) => x.id === 'aaaaaaaaaaa2').domein === 'proefmedisch.nl' && pl.find((x) => x.id === 'aaaaaaaaaaa5').domein === null && pl.find((x) => x.id === 'aaaaaaaaaaa2').dag === '2026-11-21'
      && !pl.some((x) => ['aaaaaaaaaaa7', 'aaaaaaaaaaa8', 'aaaaaaaaaaa9'].includes(x.id)), pl);
    // Facturen: één passende factuur van Proefmedisch op 21-11 (tolgaarde) en een oudere buiten het venster
    const F = require('./facturen-db.js'), FD = path.join(W, 'facturen17'), fdb = F.open(FD), db = fdb.db, fnu = '2026-11-21T10:00:00.000Z';
    for (const e of ['groenhouten', 'tolgaarde', 'prive']) db.prepare('INSERT INTO entiteit (sleutel, naam) VALUES (?, ?)').run(e, 'Proef ' + e);
    db.prepare('INSERT INTO leverancier (id, naam, genormaliseerd, aangemaakt_op) VALUES (?, ?, ?, ?)').run('b000000000000001', 'Proefmedisch.nl - Proef en Zonen B.V.', 'proefmedisch', fnu);
    let fnr = 0;
    const fac = (datum, c) => { fnr++; const h = String(fnr).padStart(15, '0'); db.prepare('INSERT INTO document (id, sha256, soort, aangemaakt_op) VALUES (?, ?, ?, ?)').run('d' + h, String(fnr).padStart(64, '1'), 'pdf', fnu);
      db.prepare('INSERT INTO factuur (id, document, soort, leverancier, leverancier_naam, factuurdatum, incl, incl_eur, valuta, entiteit, status, aangemaakt_op, bijgewerkt_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('f' + h, 'd' + h, 'factuur', 'b000000000000001', null, datum, c, c, 'EUR', 'tolgaarde', 'te_beoordelen', fnu, fnu); return 'f' + h; };
    const fJuist = fac('2026-11-21', 4930); fac('2026-11-09', 2190);
    F.sluit ? F.sluit(fdb) : db.close();
    let klok17 = new Date('2026-11-27T12:00:00Z');
    const ST17 = path.join(W, 'bestelling17.json');
    const m17 = S.maak({ vault: V17, vv: VV, nu: () => klok17, bestellingen: (s) => pk.bestellingen(s), bestellingPad: ST17, facturenPad: () => path.join(FD, 'facturen.sqlite') });
    const L17 = () => m17.lijst().body.zoektochten, zw = (w) => L17().find((x) => x.wens === w);
    const kB = zw('Proefkopjes'), kP = zw('Proefplisse');
    toets('17b lijst: bij een open zoektocht de nieuwste bestelling bij een optie-winkel na het begin (winkel van de pagina, dag); bij gekocht geen vraag',
      JSON.stringify(kB.bestelling) === JSON.stringify({ winkel: 'Proefmedisch', dag: '2026-11-21' }) && JSON.stringify(kP.bestelling) === JSON.stringify({ winkel: 'bol', dag: '2026-11-24' })
      && !zw('Al gekocht').bestelling, [kB.bestelling, kP.bestelling, zw('Al gekocht').bestelling]);
    const dB = m17.zoektocht(kB.id).body.zoektocht.bestelling;
    toets('17c zoektocht: pakje, geen optie (twee opties bij die winkel), de ene factuur in het venster met bedrag', dB && dB.pakje === 'aaaaaaaaaaa2' && dB.optie === null && dB.factuur && dB.factuur.id === fJuist && dB.factuur.bedrag_eur === 49.3, dB);
    const zB = S.ontleed(bronB, TG + '/Shopper - 2026-11-20 - Proefkopjes.md', ['tolgaarde', 'Tolgaarde'], []);
    const bv = (lijst, rel) => S.bestellingVoor(zB, rel || TG + '/Shopper - 2026-11-20 - Proefkopjes.md', lijst, []);
    toets('17d bestelling dezelfde dag maar vóór de zoektocht = geen vraag (review ZOU 1)', bv([pl.find((x) => x.id === 'aaaaaaaaaaa1')]) === null);
    toets('17e bestelling bij een andere winkel = geen vraag; Proefbol is niet bol', bv([pl.find((x) => x.id === 'aaaaaaaaaaa3')]) === null
      && S.bestellingVoor(S.ontleed(fs.readFileSync(PP, 'utf8'), PRV + '/Shopper - 2026-11-02 - Proefplisse.md', ['prive', 'Privé'], []), PRV + '/Shopper - 2026-11-02 - Proefplisse.md', [pl.find((x) => x.id === 'aaaaaaaaaaa6')], []) === null);
    toets('17f afzenderdomein telt ook (mail.proefmedisch.nl bij een andere weergavenaam); één optie = die optie', (() => {
      const z1 = S.ontleed(bronB.replace(/\n  - \{id: o2[^\n]*/, ''), TG + '/Shopper - 2026-11-20 - Proefkopjes.md', ['tolgaarde', 'Tolgaarde'], []);
      const b = S.bestellingVoor(z1, TG + '/Shopper - 2026-11-20 - Proefkopjes.md', [{ id: 'bbbbbbbbbbb1', winkel: 'Webshop Klantenservice', dag: '2026-11-22', eerste: '2026-11-22T09:00:00.000Z', domein: 'mail.proefmedisch.nl' }], []);
      return b && b.optie === 'o1' && b.winkel === 'Proefmedisch'; })());
    toets('17g begin: bestandsdag eerder dan gezocht (Opnieuw zoeken) = vanaf de bestandsdag', S.beginVan(PRV + '/Shopper - 2026-11-02 - Proefplisse.md', { gezocht: '2026-11-06T09:48+01:00' }) < Date.parse('2026-11-02T00:00:00+01:00')
      && S.beginVan(TG + '/Shopper - 2026-11-20 - Proefkopjes.md', { gezocht: '2026-11-20T15:30+01:00' }) === Date.parse('2026-11-20T13:30:00Z'));
    let r17 = m17.bestelling(kB.id, { pakje: 'aaaaaaaaaaa1', antwoord: 'ja' });
    toets('17h ander pakje dan de vraag = 409; ongeldig/extra veld/ander antwoord = 400; onbekende zoektocht = 404', r17.status === 409
      && m17.bestelling(kB.id, { pakje: 'xyz', antwoord: 'ja' }).status === 400 && m17.bestelling(kB.id, { pakje: 'aaaaaaaaaaa2', antwoord: 'ja', bedrag_eur: 1 }).status === 400
      && m17.bestelling(kB.id, { pakje: 'aaaaaaaaaaa2', antwoord: 'misschien' }).status === 400 && m17.bestelling('000000000000', { pakje: 'aaaaaaaaaaa2', antwoord: 'ja' }).status === 404, r17);
    r17 = m17.bestelling(kB.id, { pakje: 'aaaaaaaaaaa2', antwoord: 'ja' });
    const naB = fs.readFileSync(PB, 'utf8');
    toets('17i Ja: gekocht met winkel van de pagina, bedrag uit de factuur, datum van de bestelling, opmerking; rest byte-gelijk', r17.status === 200
      && /\nstatus: gekocht\ngekocht: \{optie: null, winkel: "Proefmedisch", bedrag_eur: 49\.3, datum: "2026-11-21", opmerking: "uit je bestelmail", via: app\}\n/.test(naB)
      && naB.replace(/status: gekocht\ngekocht: [^\n]*\n/, 'status: open\n') === bronB, [r17, naB.slice(0, 300)]);
    toets('17j na Ja: tweede Ja = 409 (staat niet meer open); geen vraag meer in de lijst', m17.bestelling(kB.id, { pakje: 'aaaaaaaaaaa2', antwoord: 'ja' }).status === 409 && !zw('Proefkopjes').bestelling);
    const terug = m17.status(kB.id, { status: 'open' });
    toets('17k Toch niet gekocht: weer open, maar dezelfde bestelling vraagt niet opnieuw', terug.status === 200 && zw('Proefkopjes').status === 'open' && zw('Proefkopjes').bestelling === null, [terug, zw('Proefkopjes')]);
    r17 = m17.bestelling(kP.id, { pakje: 'aaaaaaaaaaa5', antwoord: 'nee' });
    toets('17l Nee: 200, pagina ongewijzigd; ook de andere rij van dezelfde bestelling (bestelmail) vraagt niet meer', r17.status === 200 && /status: open/.test(fs.readFileSync(PP, 'utf8'))
      && zw('Proefplisse').bestelling === null && m17.bestelling(kP.id, { pakje: 'aaaaaaaaaaa5', antwoord: 'nee' }).status === 409, [r17, zw('Proefplisse').bestelling]);
    zr('aaaaaaaaaab1', 'winkel:bol.com:555', 'bol', '2026-11-28T09:00:00.000Z');   // meer dan 3 dagen na de Nee-bestelling
    toets('17m een nieuwe bestelling bij die winkel ruim 3 dagen later = wel weer één vraag', JSON.stringify(zw('Proefplisse').bestelling) === JSON.stringify({ winkel: 'bol', dag: '2026-11-28' }), zw('Proefplisse').bestelling);
    const st17 = JSON.parse(fs.readFileSync(ST17, 'utf8'));
    toets('17n staatbestand 0600, alleen sleutel/pakje/dag/antwoord/tijd (geen wens of bedrag)', (fs.statSync(ST17).mode & 0o777) === 0o600 && Object.keys(st17).length === 2
      && Object.values(st17).flat().every((x) => JSON.stringify(Object.keys(x).sort()) === JSON.stringify(['a', 'p', 't', 'tot', 'w'])), st17);
    const m17z = S.maak({ vault: V17, vv: VV, nu: () => klok17 });
    toets('17o zonder Pakjes-koppeling: geen vraag, route 404', m17z.lijst().body.zoektochten.every((x) => !x.bestelling) && m17z.bestelling(kP.id, { pakje: 'aaaaaaaaaab1', antwoord: 'nee' }).status === 404);
    const src17 = fs.readFileSync('server.js', 'utf8'), bl17 = src17.slice(src17.indexOf('const shopper = (function () {'), src17.indexOf('// ── einde OVIS Shopper ──'));
    toets('17p server.js: route bestelling (statusteller), bestellingen uit pakjes en bestellingPad in de klokken-map', /\\\/bestelling\$\/[\s\S]{0,200}shopper_status[\s\S]{0,200}shopper\.bestelling\(m\[1\], d\)/.test(bl17)
      && /bestellingen: function \(sinds\) \{ return typeof pakjes !== 'undefined' && pakjes && typeof pakjes\.bestellingen === 'function'/.test(bl17) && /'shopper-bestelling\.json'/.test(bl17));
    pdb.close(); pk.sluit();
  }

  // ── 18. wv4280 (2C96 e/f): winkel aan/uit en Zet in mijn winkels; ergens anders gekocht met link en "Waarom niet gevonden" (verzonnen winkels) ──
  {
    const WM = require('./shopper-winkels.js');
    const V18 = path.join(W, 'v18'), VS = path.join(V18, '20_Prive/Shopper'), FP = path.join(V18, '00_Systeem/Shopper - favoriete winkels.md');
    fs.mkdirSync(VS, { recursive: true }); fs.mkdirSync(path.join(V18, '00_Systeem'), { recursive: true });
    const FAV18 = ['---', 'type: shopper-favorieten', 'updated: 2026-11-11', '# uitleg', 'winkels:',
      '  - {domein: proefblauw.nl, naam: "Proefblauw", aan: true, soort: "elektronica, huis", categorie: "elektronica huis", lezen: script, verzend_eur: 0}',
      '  - {domein: weigerwinkel.nl, naam: "Weigerwinkel", aan: true, categorie: kantoor, lezen: niet}',
      '  # commentaar tussendoor, aan: false',
      '  - {domein: uitwinkel.be, naam: "Uitwinkel # België", aan: false, categorie: huis, lezen: script}',
      '  - {domein: zonderaan.nl, naam: "Zonder aan", categorie: bouw}',
      '  - domein: blokwinkel.nl', '    naam: Blokwinkel', '    aan: true',
      '  - {domein: dubbel.nl, aan: true}', '  - {domein: dubbel.nl, aan: false}',
      'volgend_veld: x', '---', '', '# Winkels', '', 'Tekst met aan: true die niet mag veranderen.', ''].join('\n');
    fs.writeFileSync(FP, FAV18);
    const leesF = () => fs.readFileSync(FP, 'utf8');
    const verschil = (a, b) => { const x = a.split('\n'), y = b.split('\n'); if (x.length !== y.length) return null; return x.map((r, i) => (r === y[i] ? null : i)).filter((i) => i !== null); };
    const klok18 = new Date('2026-11-27T10:00:00Z');
    const m18 = S.maak({ vault: V18, vv: VV, nu: () => klok18 });
    let r = m18.winkelAan({ domein: 'proefblauw.nl', aan: false });
    let vs = verschil(FAV18, leesF());
    toets('18a aan → uit: 200, alleen de regel van die winkel verandert (alleen aan: false), de rest byte-gelijk', r.status === 200 && r.body.aan === false && vs && vs.length === 1
      && leesF().split('\n')[vs[0]] === FAV18.split('\n')[vs[0]].replace('aan: true', 'aan: false'), [r, vs]);
    const na18a = leesF();
    r = m18.winkelAan({ domein: 'https://www.proefblauw.nl/', aan: false });
    toets('18b nog eens uit (ook als https://www.-adres) = 200 al, niets geschreven', r.status === 200 && r.body.al === true && leesF() === na18a, r);
    r = m18.winkelAan({ domein: 'proefblauw.nl', aan: true });
    toets('18c weer aan: pagina weer byte-gelijk aan het begin', r.status === 200 && leesF() === FAV18, r);
    r = m18.winkelAan({ domein: 'uitwinkel.be', aan: true });
    vs = verschil(FAV18, leesF());
    toets('18d winkel met # in de naam (na een commentaarregel) aan: alleen die regel', r.status === 200 && vs && vs.length === 1 && /uitwinkel\.be.*aan: true/.test(leesF().split('\n')[vs[0]])
      && WM.winkelsVan(leesF()).find((w) => w.domein === 'uitwinkel.be').aan === true, [r, vs]);
    fs.writeFileSync(FP, FAV18);
    r = m18.winkelAan({ domein: 'zonderaan.nl', aan: true });
    vs = verschil(FAV18, leesF());
    toets('18e winkel zonder veld aan: aan: true komt direct na het domein, alleen die regel', r.status === 200 && vs && vs.length === 1
      && leesF().split('\n')[vs[0]] === '  - {domein: zonderaan.nl, aan: true, naam: "Zonder aan", categorie: bouw}', [r, leesF().split('\n')[vs && vs[0]]]);
    fs.writeFileSync(FP, FAV18);
    const st18 = [m18.winkelAan({ domein: 'nergens.nl', aan: true }), m18.winkelAan({ domein: '../x', aan: true }), m18.winkelAan({ domein: 'proefblauw.nl', aan: 'true' }),
      m18.winkelAan({ domein: 'proefblauw.nl', aan: true, x: 1 }), m18.winkelAan(null), m18.winkelAan({ aan: false })].map((x) => x.status);
    toets('18f onbekend domein / ongeldig domein / aan geen boolean / extra veld / leeg = 400, niets geschreven', st18.every((x) => x === 400) && leesF() === FAV18, st18);
    const st18b = [m18.winkelAan({ domein: 'blokwinkel.nl', aan: false }), m18.winkelAan({ domein: 'dubbel.nl', aan: false })];
    toets('18g winkel in blokvorm of dubbel in de lijst = 409 (pas aan in Brain), niets geschreven', st18b.every((x) => x.status === 409) && leesF() === FAV18, st18b);
    // erbij
    r = m18.winkelErbij({ domein: 'https://www.verzonnenvak.nl/shop', naam: 'Verzonnen "Vak" winkel', categorie: ['medisch', 'kantoor'] });
    const regels18 = leesF().split('\n'), oud18 = FAV18.split('\n');
    const nieuweRegel = '  - {domein: verzonnenvak.nl, naam: "Verzonnen \'Vak\' winkel", aan: true, categorie: "medisch kantoor", toegevoegd: "2026-11-27"}';
    toets('18h Zet in mijn winkels: één regel erbij direct na de laatste winkelregel (vóór het volgende veld), rest byte-gelijk; " wordt \'',
      r.status === 200 && r.body.winkel.domein === 'verzonnenvak.nl' && regels18.length === oud18.length + 1 && regels18[oud18.indexOf('volgend_veld: x')] === nieuweRegel
      && regels18.filter((x) => x !== nieuweRegel).join('\n') === FAV18, [r, regels18.slice(10, 16)]);
    const wv18 = m18.winkels().body.winkels.find((w) => w.domein === 'verzonnenvak.nl');
    toets('18i daarna in de tab Winkels: aan, categorieën medisch + kantoor', wv18 && wv18.aan === true && JSON.stringify(wv18.categorie) === '["medisch","kantoor"]', wv18);
    const na18h = leesF();
    const st18c = [m18.winkelErbij({ domein: 'verzonnenvak.nl', naam: 'X', categorie: ['huis'] }), m18.winkelErbij({ domein: 'blokwinkel.nl', naam: 'X', categorie: ['huis'] })].map((x) => x.status);
    const st18d = [m18.winkelErbij({ domein: '10.0.0.1', naam: 'X', categorie: ['huis'] }), m18.winkelErbij({ domein: 'x.nl', naam: '', categorie: ['huis'] }),
      m18.winkelErbij({ domein: 'x.nl', naam: 'X', categorie: ['alles'] }), m18.winkelErbij({ domein: 'x.nl', naam: 'X', categorie: [] }),
      m18.winkelErbij({ domein: 'x.nl', naam: 'X'.repeat(81), categorie: ['huis'] }), m18.winkelErbij({ domein: 'x.nl', naam: 'X', categorie: ['huis'], aan: false }),
      m18.winkelErbij({ domein: 'x.nl', naam: 'X', categorie: 'huis' })].map((x) => x.status);
    toets('18j bestaat al (ook in blokvorm) = 409; ip-adres, lege of te lange naam, "alles", geen of losse categorie, extra veld = 400; niets geschreven',
      st18c.every((x) => x === 409) && st18d.every((x) => x === 400) && leesF() === na18h, [st18c, st18d]);
    let vol = FAV18.replace('volgend_veld: x', Array.from({ length: 60 }, (_, i) => '  - {domein: vol' + i + '.nl, aan: false}').join('\n') + '\nvolgend_veld: x');
    fs.writeFileSync(FP, vol);
    toets('18k lijst vol (60) = 409, niets geschreven', m18.winkelErbij({ domein: 'x.nl', naam: 'X', categorie: ['huis'] }).status === 409 && leesF() === vol);
    fs.writeFileSync(FP, FAV18);
    // f: ergens anders gekocht met link
    const zt = ['---', 'type: shopper-zoektocht', 'wens: "Proefprinter"', 'status: open', 'gezocht: 2026-11-20T09:00+01:00', 'aantal: 1', 'opties:',
      '  - {id: o1, winkel: "Proefblauw", product: "Printer", koop_aantal: 1, prijs_eur: 99, verzending_eur: 0, totaal_eur: 99, url: "https://www.proefblauw.nl/p/1"}',
      'advies: o1', '---', '# Shopper — proefprinter', '', 'Advies o1.', '', '## Waarom dit advies', 'Goedkoopst.', '', '## Gerelateerd', '- x', ''].join('\n');
    const ZP = path.join(VS, 'Shopper - 2026-11-20 - Proefprinter.md');
    fs.writeFileSync(ZP, zt);
    const zid18 = S.idVan('20_Prive/Shopper/Shopper - 2026-11-20 - Proefprinter.md'), leesZ = () => fs.readFileSync(ZP, 'utf8');
    const st18e = [m18.gekocht(zid18, { winkel: 'Nepzaak', link: 'http://www.nepzaak.nl/p/2' }), m18.gekocht(zid18, { optie: 'o1', link: 'https://www.proefblauw.nl/p/1' }),
      m18.gekocht(zid18, { winkel: 'Nepzaak', link: 'javascript:alert(1)' }), m18.gekocht(zid18, { winkel: 'Nepzaak', link: 'https://a:b@nepzaak.nl/p' }),
      m18.gekocht(zid18, { winkel: 'Nepzaak', link: 42 })].map((x) => x.status);
    toets('18l link: http, bij een optie, javascript:, met inloggegevens of geen tekst = 400, niets geschreven', st18e.every((x) => x === 400) && leesZ() === zt, st18e);
    r = m18.gekocht(zid18, { winkel: 'Nepzaak Leusden', link: 'https://www.nepzaak.nl/p/2?k=1,2#x', datum: '2026-11-26' });
    const t18 = leesZ(), g18 = S.gekochtVan(t18);
    const sect = '## Waarom niet gevonden\n- 26-11-2026, gekocht bij Nepzaak Leusden: nepzaak.nl staat niet in je winkellijst; Shopper zoekt bij Snel vergelijken alleen in je winkels. (vastgelegd door de app)\n\n';
    toets('18m elders met link: 200, gekocht-regel met link (terug te lezen), sectie Waarom niet gevonden vóór Gerelateerd, rest byte-gelijk',
      r.status === 200 && r.body.waarom_niet.soort === 'niet_in_lijst' && g18.link === 'https://www.nepzaak.nl/p/2?k=1,2#x' && g18.optie === null
      && t18.slice(t18.indexOf('\n---\n')) === zt.slice(zt.indexOf('\n---\n')).replace('## Gerelateerd', sect + '## Gerelateerd'), [r, t18.slice(t18.indexOf('\n---\n'))]);
    let d18 = m18.zoektocht(zid18).body.zoektocht;
    toets('18n detail: waarom_niet (de zin) en elders_winkel {soort niet_in_lijst, domein nepzaak.nl, winkel Nepzaak Leusden}', /staat niet in je winkellijst/.test(d18.waarom_niet)
      && d18.elders_winkel && d18.elders_winkel.soort === 'niet_in_lijst' && d18.elders_winkel.domein === 'nepzaak.nl' && d18.elders_winkel.winkel === 'Nepzaak Leusden', d18.elders_winkel);
    toets('18o daarna Zet in mijn winkels: elders_winkel wordt zoekgebied_te_smal (vers uit de lijst)', m18.winkelErbij({ domein: 'nepzaak.nl', naam: 'Nepzaak', categorie: ['bouw'] }).status === 200
      && m18.zoektocht(zid18).body.zoektocht.elders_winkel.soort === 'zoekgebied_te_smal');
    toets('18p dezelfde tik nog eens = 200 al; met een andere link = 409', m18.gekocht(zid18, { winkel: 'Nepzaak Leusden', link: 'https://www.nepzaak.nl/p/2?k=1,2#x', datum: '2026-11-26' }).body.al === true
      && m18.gekocht(zid18, { winkel: 'Nepzaak Leusden', link: 'https://www.nepzaak.nl/p/3', datum: '2026-11-26' }).status === 409);
    // Toch niet gekocht en opnieuw elders (nu bij een winkel die uit staat): één sectie, vervangen
    toets('18q Toch niet gekocht: link weg uit de frontmatter (sectie blijft als geschiedenis)', m18.status(zid18, { status: 'open' }).status === 200 && !/link:/.test(leesZ().split('\n---\n')[0]) && /## Waarom niet gevonden/.test(leesZ()));
    r = m18.gekocht(zid18, { winkel: 'Uitwinkel', link: 'https://uitwinkel.be/p', datum: '2026-11-27' });
    const t18b = leesZ();
    toets('18r opnieuw elders bij een winkel die uit staat: sectie vervangen (één keer), zin "staat in je winkellijst, maar uit."', r.status === 200 && r.body.waarom_niet.soort === 'uit'
      && t18b.split('## Waarom niet gevonden').length === 2 && /Uitwinkel # België staat in je winkellijst, maar uit\./.test(t18b) && t18b.indexOf('## Waarom niet gevonden') < t18b.indexOf('## Gerelateerd'), t18b.slice(t18b.indexOf('\n---\n')));
    toets('18s waaromNiet: lezen niet = niet_te_lezen; aan + leesbaar = zoekgebied_te_smal; subdomein telt; geen https = null',
      WM.waaromNiet('https://shop.weigerwinkel.nl/x', WM.winkelsVan(FAV18)).soort === 'niet_te_lezen' && WM.waaromNiet('https://www.proefblauw.nl/x', WM.winkelsVan(FAV18)).soort === 'zoekgebied_te_smal'
      && WM.waaromNiet('geen', WM.winkelsVan(FAV18)) === null);
    toets('18t zetWaaromSectie: zonder Gerelateerd onderaan met lege regel ervoor; bestaande sectie aan het eind vervangen',
      S.zetWaaromSectie('# T\n\nTekst\n', '- r') === '# T\n\nTekst\n\n## Waarom niet gevonden\n- r\n' && S.zetWaaromSectie('# T\n\n## Waarom niet gevonden\n- oud (vastgelegd door de app)\n', '- nieuw') === '# T\n\n## Waarom niet gevonden\n- nieuw\n');
    const cb = '# T\n\n```\n## Waarom niet gevonden\nvoorbeeld\n```\n\nNotitie na het codeblok.\n\n## Gerelateerd\n- x\n';
    toets('18t2 (review MOET 1) een kop binnen een codeblok telt niet: codeblok en notitie blijven, sectie vóór Gerelateerd; tweede keer vervangt alleen de echte sectie',
      S.zetWaaromSectie(cb, '- r') === cb.replace('## Gerelateerd', '## Waarom niet gevonden\n- r\n\n## Gerelateerd')
      && S.zetWaaromSectie(S.zetWaaromSectie(cb, '- r (vastgelegd door de app)'), '- s') === cb.replace('## Gerelateerd', '## Waarom niet gevonden\n- s\n\n## Gerelateerd')
      && S.zetWaaromSectie('# T\n\n## Waarom niet gevonden\n- oud (vastgelegd door de app)\n~~~\n## Gerelateerd\n~~~\nna\n\n## Echt\nz\n', '- n') === '# T\n\n## Waarom niet gevonden\n- n\n\n~~~\n## Gerelateerd\n~~~\nna\n\n## Echt\nz\n',
      S.zetWaaromSectie(cb, '- r'));
    const cb4 = '# T\n\n````\n```\n## Waarom niet gevonden\nvoorbeeld\n````\n~~~ tekst\n## Gerelateerd\n~~~~\nNotitie.\n\n## Gerelateerd\n- x\n';
    toets('18t3 (review ronde 2 MOET 1) codeblok van 4 backticks sluit niet op 3; ~~~ met info sluit niet op ~~~ tekst: alleen de echte Gerelateerd telt',
      S.zetWaaromSectie(cb4, '- r') === cb4.replace('Notitie.\n\n## Gerelateerd', 'Notitie.\n\n## Waarom niet gevonden\n- r\n\n## Gerelateerd'), S.zetWaaromSectie(cb4, '- r'));
    const ing = '# T\n\n## Waarom niet gevonden\n- 1-11-2026, gekocht bij X: y (vastgelegd door de app)\nEigen notitie van David.\n  ## Gerelateerd\n- x\n';
    toets('18t4 (review ronde 3) vervangen haalt alleen de eigen app-regels weg: notitie van David en een ingesprongen kop blijven byte-gelijk; ingesprongen Gerelateerd telt als kop',
      S.zetWaaromSectie(ing, '- n') === '# T\n\n## Waarom niet gevonden\n- n\n\nEigen notitie van David.\n  ## Gerelateerd\n- x\n'
      && S.zetWaaromSectie('# T\n\nTekst\n   ## Gerelateerd\n- x\n', '- r') === '# T\n\nTekst\n## Waarom niet gevonden\n- r\n\n   ## Gerelateerd\n- x\n', S.zetWaaromSectie(ing, '- n'));
    const kaalZt = ['---', 'type: shopper-zoektocht', 'wens: "Kaal"', 'status: open', 'gezocht: 2026-11-20T09:00+01:00', '---'].join('\n');
    const KP = path.join(VS, 'Shopper - 2026-11-20 - Kaal.md'); fs.writeFileSync(KP, kaalZt);
    const kid = S.idVan('20_Prive/Shopper/Shopper - 2026-11-20 - Kaal.md');
    r = m18.gekocht(kid, { winkel: 'Nepzaak', link: 'https://nepzaak.nl/p', datum: '2026-11-26' });
    const kt = fs.readFileSync(KP, 'utf8');
    toets('18t5 (review ronde 4) pagina met alleen frontmatter zonder slotregel: "---" blijft op een eigen regel, pagina leesbaar als gekocht met de sectie',
      r.status === 200 && /\n---\n## Waarom niet gevonden\n- 26-11-2026/.test(kt) && m18.zoektocht(kid).body.zoektocht.status === 'gekocht' && /kwam niet in de opties/.test(m18.zoektocht(kid).body.zoektocht.waarom_niet), kt);
    fs.unlinkSync(KP);
    // gekocht zonder link: geen sectie, regel zoals altijd (geen link-veld)
    fs.writeFileSync(ZP, zt);
    r = m18.gekocht(zid18, { winkel: 'Ergens', datum: '2026-11-26' });
    toets('18u elders zonder link: geen sectie, geen link-veld, geen waarom_niet', r.status === 200 && !/Waarom niet gevonden|link:/.test(leesZ()) && r.body.waarom_niet === undefined
      && m18.zoektocht(zid18).body.zoektocht.elders_winkel === null);
    const src18 = fs.readFileSync('server.js', 'utf8'), bl18 = src18.slice(src18.indexOf('async function appShopper'), src18.indexOf('// ── einde OVIS Shopper ──'));
    toets('18v server.js: POST winkels/aan en winkels/erbij vóór de id-routes, met de statusteller', /'POST \/app\/shopper\/winkels\/aan' \|\| route === 'POST \/app\/shopper\/winkels\/erbij'[\s\S]{0,300}shopper_status[\s\S]{0,200}shopper\.winkelAan : shopper\.winkelErbij/.test(bl18)
      && bl18.indexOf("'POST /app/shopper/winkels/aan'") < bl18.indexOf('\\/status$'));
    toets('18w shopper.js zegt niet meer dat de winkelpagina nooit geschreven wordt', !/De pagina zelf wordt nooit geschreven/.test(fs.readFileSync('shopper.js', 'utf8')));
  }

  // ── 19. wv4329 (2C70 stap 2): "Ook gekocht, buiten Shopper" — berekend uit Pakjes, Facturen en de privébank (verzonnen gegevens) ──
  {
    const A = S.aankopenLijst, V0 = '2026-11-27';
    const wk = [{ naam: 'Proefzaak', domein: 'proefzaak.nl' }, { naam: 'Nepmarkt', domein: 'nepmarkt.nl' }];
    let u = A({ vandaag: V0, winkels: wk, gekocht: [], bestellingen: [], facturen: [{ naam: 'Proefzaak B.V.', dag: '2026-11-20', eur: 49.3, entiteit: 'tolgaarde' }],
      bank: [{ naam: 'Nepmarkt Online via Proefpay', dag: '2026-11-22', eur: 19.99 }, { naam: 'Proefsuper 123', dag: '2026-11-22', eur: 12.5 }] });
    toets('19a verzonnen factuur + verzonnen bankregel bij bekende webwinkels = elk één regel; supermarkt (onbekend) niet', u.regels.length === 2
      && u.regels[0].winkel === 'Nepmarkt Online via Proefpay' && u.regels[0].bedrag_eur === 19.99 && u.regels[0].bronnen.join() === 'bank'
      && u.regels[1].bedrag_eur === 49.3 && u.regels[1].entiteit === 'tolgaarde' && u.regels[1].bronnen.join() === 'factuur', u);
    u = A({ vandaag: V0, winkels: wk, gekocht: [{ winkel: 'Proefzaak', datum: '2026-11-19' }], bestellingen: [], facturen: [{ naam: 'Proefzaak B.V.', dag: '2026-11-20', eur: 49.3, entiteit: 'tolgaarde' }], bank: [] });
    toets('19b dezelfde aankoop in Shopper (gekocht) en Facturen = één regel (alleen de Shopper-regel; al_in_shopper 1)', u.regels.length === 0 && u.al_in_shopper === 1, u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: [{ id: 'b1', winkel: 'Proefzaak', dag: '2026-11-18', domein: 'proefzaak.nl', bezorgd: true }, { id: 'b2', winkel: 'Proefzaak', dag: '2026-11-19', domein: null, bezorgd: false }],
      facturen: [{ naam: 'Proefzaak B.V.', dag: '2026-11-19', eur: 30, entiteit: 'prive' }], bank: [{ naam: 'Proefzaak.nl', dag: '2026-11-20', eur: 30 }] });
    toets('19c (review MOET 1) winkel- en vervoerderrij = één aankoop; factuur én betaling van die bestelling = één regel met drie bronnen', u.regels.length === 1
      && u.regels[0].bronnen.join() === 'pakje,factuur,bank' && u.regels[0].bedrag_eur === 30 && u.regels[0].bezorgd === false && u.regels[0].dag === '2026-11-18', u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: [{ id: 'b1', winkel: 'Proefzaak', dag: '2026-11-10' }, { id: 'b2', winkel: 'Proefzaak', dag: '2026-11-15' }],
      facturen: [{ naam: 'Proefzaak', dag: '2026-11-13', eur: 30, entiteit: 'prive' }], bank: [] });
    toets('19d (review MOET 2) een factuur die in de vensters van twee bestellingen valt: geen bedrag bij beide, geen eigen regel', u.regels.length === 2 && u.regels.every((r) => r.bedrag_eur === null), u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: ['2026-11-01', '2026-11-03', '2026-11-05', '2026-11-07'].map((d, i) => ({ id: 'c' + i, winkel: 'Proefzaak', dag: d })), facturen: [], bank: [] });
    toets('19e (ronde 2 MOET 2) samenvoegen hooguit 3 dagen vanaf de eerste: 1+3 en 5+7 = twee aankopen', u.regels.length === 2, u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: [{ id: 'd1', winkel: 'Proefzaak', dag: '2026-11-01' }, { id: 'd2', winkel: 'Proefzaak', dag: '2026-11-16' }],
      facturen: [{ naam: 'Proefzaak', dag: '2026-11-07', eur: 40, entiteit: 'prive' }], bank: [{ naam: 'Proefzaak', dag: '2026-11-14', eur: 40 }] });
    toets('19f (ronde 2 MOET 1) de betaling die uniek bij de tweede bestelling hoort gaat niet mee met de factuur van de eerste', u.regels.find((r) => r.dag === '2026-11-16').bedrag_eur === 40
      && u.regels.find((r) => r.dag === '2026-11-01').bronnen.join() === 'pakje,factuur', u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: [{ id: 's1', winkel: 'Proefprinter', dag: '2026-11-16' }], facturen: [{ naam: 'Proefprinter EU', dag: '2026-11-09', eur: 152.75, entiteit: 'tolgaarde' }], bank: [] });
    toets('19f2 factuur 7 dagen vóór de eerste mail (verzendmail) = dezelfde aankoop, geen tweede regel', u.regels.length === 1 && u.regels[0].bedrag_eur === 152.75, u);
    u = A({ vandaag: V0, winkels: [], gekocht: [], bestellingen: [{ id: 'e1', winkel: 'Amazon EU SARL', dag: '2026-11-20' }, { id: 'e2', winkel: 'Amazon', dag: '2026-11-21' }, { id: 'e3', winkel: 'Info', dag: '2026-11-21' },
      { id: 'e4', winkel: 'Oude zaak', dag: '2026-10-01' }], facturen: null, bank: null });
    toets('19g Amazon ↔ Amazon EU SARL = dezelfde winkel; een algemene naam ("Info") telt niet; ouder dan 45 dagen niet; geen Facturen/bank = gewoon zonder bedrag', u.regels.length === 1 && u.regels[0].bedrag_eur === null, u);
    u = A({ vandaag: V0, winkels: [{ naam: 'bol', domein: 'bol.com' }], gekocht: [], bestellingen: [], facturen: [], bank: [{ naam: 'bol.com', dag: '2026-11-24', eur: 23.99 }, { naam: 'Proefbol Shop', dag: '2026-11-24', eur: 5 }, { naam: 'Bolletje bakker', dag: '2026-11-24', eur: 3 }] });
    toets('19h bol ↔ bol.com, maar niet Bolletje; hele woorden ("Proefbol" ≠ bol)', u.regels.length === 1 && u.regels[0].winkel === 'bol.com', u);
    const veel = []; for (let i = 0; i < 130; i++) veel.push({ naam: 'Proefzaak', dag: '2026-11-' + String(1 + (i % 26)).padStart(2, '0'), eur: 1 + i, entiteit: 'prive' });
    u = A({ vandaag: V0, winkels: wk, gekocht: [], bestellingen: [], facturen: veel, bank: [] });
    toets('19i hooguit 100 regels, nieuwste eerst; alleen de velden winkel, dag, bedrag_eur, bronnen, entiteit, bezorgd', u.regels.length === 100 && u.regels[0].dag >= u.regels[99].dag
      && Object.keys(u.regels[0]).sort().join() === 'bedrag_eur,bezorgd,bronnen,dag,entiteit,winkel', u.regels[0]);
    // integratie: maak() met een echte pakjes.js en facturen-db.js (verzonnen rijen), bank als functie
    const V19 = path.join(W, 'vault19'); for (const mp of S.MAPPEN) fs.mkdirSync(path.join(V19, mp[2]), { recursive: true });
    fs.mkdirSync(path.join(V19, '00_Systeem'), { recursive: true });
    fs.writeFileSync(path.join(V19, '00_Systeem/Shopper - favoriete winkels.md'), pagina(['type: shopper-favorieten', 'winkels:', '  - {domein: nepmarkt.nl, naam: "Nepmarkt", aan: false, categorie: [elektronica]}']));
    fs.writeFileSync(path.join(V19, '20_Prive/Shopper', 'Shopper - 2026-11-15 - Proefkoffer.md'), pagina(['type: shopper-zoektocht', 'wens: "Proefkoffer"', 'status: gekocht', 'gezocht: 2026-11-15T09:00+01:00',
      'gekocht: {optie: null, winkel: "Proefkofferzaak", bedrag_eur: 80, datum: "2026-11-16", opmerking: null, via: app}']));
    const P = require('./pakjes.js'), PD = path.join(W, 'pakjes19'), pk = P.maak({ dir: PD, nu: () => Date.parse('2026-11-27T12:00:00Z') });
    pk.bestellingen('2026-01-01T00:00:00Z');
    const { DatabaseSync } = require('node:sqlite'), pdb = new DatabaseSync(path.join(PD, 'pakjes.sqlite'));
    pdb.prepare("INSERT INTO zending (id, sleutel, vervoerder, winkel, eerste, bijgewerkt, bezorgd_op) VALUES ('bbbbbbbbbbb1', 'winkel:proefzaak.nl:1', 'winkel', 'Proefzaak', '2026-11-20T10:00:00.000Z', '2026-11-20T10:00:00.000Z', '2026-11-22T10:00:00.000Z')").run();
    pdb.prepare("INSERT INTO zending (id, sleutel, vervoerder, winkel, eerste, bijgewerkt) VALUES ('bbbbbbbbbbb2', 'winkel:proefkofferzaak.nl:2', 'winkel', 'Proefkofferzaak', '2026-11-16T10:00:00.000Z', '2026-11-16T10:00:00.000Z')").run();
    pdb.close();
    toets('19j pakjes.bestellingen geeft nu ook bezorgd (stap 1 blijft gelijk)', pk.bestellingen('2026-01-01T00:00:00Z').find((x) => x.id === 'bbbbbbbbbbb1').bezorgd === true);
    const F = require('./facturen-db.js'), FD = path.join(W, 'facturen19'), fdb = F.open(FD), db = fdb.db, fnu = '2026-11-21T10:00:00.000Z';
    for (const e of ['tolgaarde', 'prive']) db.prepare('INSERT INTO entiteit (sleutel, naam) VALUES (?, ?)').run(e, 'Proef ' + e);
    db.prepare('INSERT INTO leverancier (id, naam, genormaliseerd, aangemaakt_op) VALUES (?, ?, ?, ?)').run('c000000000000001', 'Proefzaak B.V.', 'proefzaak', fnu);
    let fnr = 0;
    const fac = (datum, c, pk2) => { fnr++; const h = String(fnr).padStart(15, '0'); db.prepare('INSERT INTO document (id, sha256, soort, aangemaakt_op) VALUES (?, ?, ?, ?)').run('d' + h, String(fnr).padStart(64, '2'), 'pdf', fnu);
      db.prepare('INSERT INTO factuur (id, document, soort, leverancier, leverancier_naam, factuurdatum, incl, incl_eur, valuta, entiteit, status, patientkenmerk, aangemaakt_op, bijgewerkt_op) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('e' + h, 'd' + h, 'factuur', 'c000000000000001', null, datum, c, c, 'EUR', 'tolgaarde', 'te_beoordelen', pk2 ? 1 : 0, fnu, fnu); };
    fac('2026-11-21', 4930); fac('2026-11-05', 1000, 'ja');
    F.sluit ? F.sluit(fdb) : db.close();
    const m19 = S.maak({ vault: V19, vv: VV, nu: () => new Date('2026-11-27T12:00:00Z'), bestellingen: (s) => pk.bestellingen(s), facturenPad: () => path.join(FD, 'facturen.sqlite'),
      bankUitgaven: async () => [{ naam: 'Nepmarkt via Proefpay', dag: '2026-11-25', eur: 12.34 }, { naam: 'Proefkofferzaak', dag: '2026-11-16', eur: 80 }] });
    const r19 = await m19.aankopen(), b19 = r19.body;
    toets('19k aankopen(): pakje + factuur = één regel met bedrag en entiteit; bank bij winkel uit de winkellijst (ook uit); Shopper-aankoop (pakje + bank) valt weg; factuur met patiëntkenmerk telt niet',
      r19.status === 200 && b19.ok && b19.regels.length === 2 && b19.al_in_shopper === 1 && b19.bron.pakjes && b19.bron.facturen && b19.bron.bank
      && b19.regels[1].winkel === 'Proefzaak' && b19.regels[1].bedrag_eur === 49.3 && b19.regels[1].bezorgd === true && b19.regels[1].bronnen.join() === 'pakje,factuur'
      && b19.regels[0].winkel === 'Nepmarkt via Proefpay' && !JSON.stringify(b19).includes('10'), b19);
    const m19b = S.maak({ vault: V19, vv: VV, nu: () => new Date('2026-11-27T12:00:00Z'), bestellingen: () => [], facturenPad: () => null, bankUitgaven: async () => { throw new Error('x'); } });
    const r19b = (await m19b.aankopen()).body;
    toets('19l Facturen weg en bank faalt: ok met bron.facturen/bank false, lege lijst', r19b.ok && r19b.bron.facturen === false && r19b.bron.bank === false && r19b.regels.length === 0, r19b);
    const src19 = fs.readFileSync('server.js', 'utf8'), bl19 = src19.slice(src19.indexOf('async function appShopper'), src19.indexOf('// ── einde OVIS Shopper ──'));
    toets('19m server.js: GET /app/shopper/aankopen vóór de id-route, stil in het app-log; bank via bankKind zoek (lokaal), alleen uitgaven, 5 min in het geheugen',
      bl19.indexOf("route === 'GET /app/shopper/aankopen'") > 0 && bl19.indexOf("route === 'GET /app/shopper/aankopen'") < bl19.indexOf("soort = 'zoektocht'") && /soort === 'aankopen'\) && u\.status === 200\) res\._app\.stil = true/.test(bl19)
      && /bankUitgaven: shopperBankUitgaven/.test(src19) && /bankKind\(\['zoek', '--van'/.test(src19) && /x\.bedrag < 0 && x\.type === 'uitgave' && !x\.intern_met/.test(src19) && /BANK_LOKAAL = \[[^\]]*'zoek'/.test(src19));
  }

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
