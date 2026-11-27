#!/usr/bin/env bash
# Toets wv4199 (27-11-2026, besluitenpagina nr 461 = 3C161 stap 1): de voorpost (voorpost.js + koppeling in server.js).
#   wie krijgt een voorpost (akkoord/kort/bijlage/Antwoord hierop niet), vraag-herkenning voor Zoek snel, natoets (Codex MOET 1: geen getal
#   dat niet in Davids bericht staat, geen toezegging over versturen/betalen/boeken/verwijderen/afspreken), modeluitvoer streng gelezen,
#   feit > plan > vraag, wacht() geeft binnen de grens de beste uitkomst en daarna null/laatste, de geparkeerde vraag is een geldige
#   wv4179-vraag (appVraagUit + appVraagKnoppen uit server.js), regels voor de grondige en de knopbeurt, en in server.js: geen --json-schema
#   en geen tools voor de voorpost, de parkeerweg vóór processJob, /app/uitslag en app-log met voorpostveld.
# Kruisproef: VOORPOST_MOD=<kopie zonder natoets> bash test/voorpost.sh moet rood zijn; op main (geen voorpost.js) ook.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/toets.js" <<'EINDE'
'use strict';
const path = require('path'), fs = require('fs'), vm = require('vm');
const HIER = process.argv[2], MOD = process.env.VOORPOST_MOD || path.join(HIER, 'voorpost.js');
let ok = 0, fout = 0;
function toets(naam, waar) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam); } }
let V;
try { V = require(MOD); } catch (e) { console.log('FOUT voorpost.js laadt niet: ' + e.message); process.exit(1); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

(async function () {
  // 1. Wie krijgt een voorpost
  toets('akkoord "Ja" niet', !V.magVoorpost('Ja').ok && V.magVoorpost('Ja').reden === 'akkoord');
  toets('"doe maar." niet', !V.magVoorpost('doe maar.').ok);
  toets('"dank je wel" niet', !V.magVoorpost('dank je wel').ok);
  toets('kort zonder ? niet', !V.magVoorpost('bel Jan').ok);
  toets('kort met ? wel', V.magVoorpost('Kenteken Volvo?').ok);
  toets('bijlage niet', !V.magVoorpost('Kun je deze factuur nakijken', { bijlagen: true }).ok);
  toets('Antwoord hierop niet', !V.magVoorpost('Kun je deze factuur nakijken', { antwoordOp: true }).ok);
  toets('gewone opdracht wel', V.magVoorpost('Zoek eens uit welke stofzuiger het beste is').ok);
  toets('leeg niet', !V.magVoorpost('   ').ok);
  // 2. Lijkt een vraag (dan ook Zoek snel)
  toets('vraagwoord', V.lijktVraag('Wat is het kenteken van de Volvo'));
  toets('eindigt op ?', V.lijktVraag('Het IBAN van de VvE?'));
  toets('opdracht niet', !V.lijktVraag('Zet morgen om 9 uur een afspraak'));
  toets('kun je … plannen niet', !V.lijktVraag('Kun je de vergadering van dinsdag verplaatsen?'));
  toets('kun je … opzoeken wel', V.lijktVraag('Kun je het nummer van de loodgieter opzoeken?'));
  // 3. Natoets (Codex MOET 1)
  toets('getal uit bericht mag', V.natoets('Ik zoek de offerte van 1200 euro op', 'die offerte van 1200 euro'));
  toets('verzonnen getal niet', !V.natoets('Ik zoek het op; het kost 350 euro', 'wat kost dat'));
  toets('verzonnen datum niet', !V.natoets('Ik kijk naar je agenda van 3-12', 'kijk in mijn agenda'));
  toets('versturen niet', !V.natoets('Ik verstuur de mail aan Piet', 'mail piet'));
  toets('stuur niet', !V.natoets('Ik stuur Piet een bericht', 'stuur piet'));
  toets('betalen niet', !V.natoets('Ik betaal de rekening', 'betaal'));
  toets('inplannen niet', !V.natoets('Ik plan het overleg in', 'overleg'));
  toets('afgesproken niet', !V.natoets('Dat is afgesproken', 'x'));
  toets('concept klaarzetten mag', V.natoets('Ik zet een concept-antwoord klaar voor Piet', 'antwoord piet'));
  toets('voorstel mag', V.natoets('Ik zoek de vergadering op en stel een later tijdstip voor', 'verplaats de vergadering'));
  // 4. Modeluitvoer streng
  toets('plan ok', JSON.stringify(V.leesModel({ soort: 'plan', tekst: 'Ik zoek in je mail naar de offerte.' }, 'offerte?')) === JSON.stringify({ soort: 'plan', tekst: 'Ik zoek in je mail naar de offerte.' }));
  toets('plan zonder ik-vorm weg', V.leesModel({ soort: 'plan', tekst: 'Het kenteken is AB-12-CD.' }, 'kenteken?') === null);
  toets('plan met toezegging weg', V.leesModel({ soort: 'plan', tekst: 'Ik verstuur het meteen.' }, 'stuur het') === null);
  toets('niets = null', V.leesModel({ soort: 'niets', tekst: '' }, 'x') === null);
  toets('onbekende soort = null', V.leesModel({ soort: 'feit', tekst: 'Ik weet het' }, 'x') === null);
  const vq = V.leesModel({ soort: 'vraag', tekst: 'Welke offerte bedoel je?', knoppen: ['Die van de dakgoot', 'Die van de kozijnen', 'Nog een'] }, 'doe die offerte');
  toets('vraag: twee knoppen, derde valt af', vq && vq.knoppen.length === 2 && vq.knoppen[0] === 'Die van de dakgoot');
  toets('vraag zonder ? = null', V.leesModel({ soort: 'vraag', tekst: 'Welke offerte', knoppen: ['a b', 'c d'] }, 'x') === null);
  toets('vraag met één knop = null', V.leesModel({ soort: 'vraag', tekst: 'Welke?', knoppen: ['De ene'] }, 'x') === null);
  toets('knop ja/nee telt niet', V.leesModel({ soort: 'vraag', tekst: 'Welke?', knoppen: ['Ja', 'Nee'] }, 'x') === null);
  toets('knop met link telt niet', V.leesModel({ soort: 'vraag', tekst: 'Welke?', knoppen: ['https://x.nl', 'De andere', 'Nog een'] }, 'x').knoppen.join() === 'De andere,Nog een');
  toets('knop met verzonnen datum telt niet', V.leesModel({ soort: 'vraag', tekst: 'Wanneer?', knoppen: ['Op 3-12', 'Later deze week', 'Volgende week'] }, 'verplaats het').knoppen.join() === 'Later deze week,Volgende week');
  toets('lange tekst afgekapt', V.leesModel({ soort: 'plan', tekst: 'Ik ' + 'zoek heel lang '.repeat(30) }, 'x').tekst.length <= 160);
  // 5. Zoek snel → feit
  toets('zoek antwoord = feit met bron', (function () { const f = V.leesZoek({ soort: 'antwoord', tekst: 'Kenteken: AB-12-CD', laag: 'feitenlijst', bronnen: [{ pad: '20_Prive/Auto.md', naam: 'Auto', nr: 4 }] }); return f && f.soort === 'feit' && f.bronnen[0].pad === '20_Prive/Auto.md'; })());
  toets('zoek zonder bron = null', V.leesZoek({ soort: 'antwoord', tekst: 'x', bronnen: [] }) === null);
  toets('zoek geen = null', V.leesZoek({ soort: 'geen', tekst: 'Niet gevonden', bronnen: [{ pad: 'a' }] }) === null);
  // 6. Geparkeerde vraag = geldige wv4179-vraag volgens server.js
  const src = fs.readFileSync(path.join(HIER, 'server.js'), 'utf8');
  const stuk = function (begin, eind) { const i = src.indexOf(begin), k = src.indexOf(eind, i); if (i < 0 || k < 0) throw new Error('niet gevonden: ' + begin); return src.slice(i, k); };
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(stuk('function appVraagLeeg(zin) {', '// wv4179 (besluitenpagina nr 364') + stuk('const APP_KNOPPEN_RE =', '// Registerrij voor een vraag') + '; this.appVraagUit = appVraagUit; this.appVraagKnoppen = appVraagKnoppen;', ctx);
  const pt = V.parkeerTekst(vq);
  const vu = ctx.appVraagUit(pt), kn = ctx.appVraagKnoppen(pt);
  toets('parkeertekst: één vraagregel', vu && vu.tekst === 'Welke offerte bedoel je?');
  toets('parkeertekst: drie knoppen met Kies zelf', kn && kn.length === 3 && kn[2] === V.KIES_ZELF);
  toets('parkeertekst: vraag niet dubbel in de tekst', pt.split('Welke offerte bedoel je?').length === 2);
  // 7. Regels voor de grondige en de knopbeurt
  const gr = V.grondigRegel({ soort: 'feit', tekst: 'Kenteken: AB-12-CD', bronnen: [{ pad: 'x.md', naam: 'Auto' }] }, 4);
  toets('grondige: feit met bron en tegenspraakregel', /voorpost/.test(gr) && /Auto/.test(gr) && /eerste zin/.test(gr) && /na 4 s/.test(gr));
  toets('grondige: geen regel bij vraag/null', V.grondigRegel({ soort: 'vraag', tekst: 'x?' }) === '' && V.grondigRegel(null) === '');
  const kr = V.knopRegel({ bericht: 'doe die offerte', getypt: '18:30' }, 'Die van de dakgoot');
  toets('knopregel: bericht erbij', /doe die offerte/.test(kr) && /18:30/.test(kr) && /afhandelen|af met deze keuze/.test(kr));
  toets('knopregel: Kies zelf', /waarschijnlijkst/.test(V.knopRegel({ bericht: 'x' }, V.KIES_ZELF)));
  toets('knopregel: geen voorpostrij = leeg', V.knopRegel(null, 'x') === '');
  // 8. maak(): tijden met nep-model en nep-Zoek snel
  const nep = function (modelMs, data, zoekMs, zoekR) {
    const aanroepen = [];
    return { aanroepen, dep: {
      claude: function (s, p, sc, o) { aanroepen.push(o); return slaap(modelMs).then(() => (data ? { ok: true, data, verbruik: { kosten: 0.0002, account: 2 } } : { ok: false, fout: 'nep' })); },
      zoek: function () { return slaap(zoekMs).then(() => zoekR); } } };
  };
  const PLAN = { soort: 'plan', tekst: 'Ik zoek het kenteken op in je Brain.' };
  const FEIT = { soort: 'antwoord', tekst: 'Kenteken: AB-12-CD', bronnen: [{ pad: '20_Prive/Auto.md', naam: 'Auto' }] };
  let n = nep(100, PLAN, 0, null), h = V.maak(n.dep).start('Wat is het kenteken van de Volvo?', { metZoek: false });
  let t0 = Date.now(), r = await h.wacht(Date.now() + 2000);
  toets('plan binnen de grens, meteen terug', r && r.soort === 'plan' && Date.now() - t0 < 600);
  toets('modelaanroep: Haiku, grens 8 s', n.aanroepen[0].model === 'claude-haiku-5-5' && n.aanroepen[0].timeoutMs === 8000);
  await h.klaar; toets('meting: tools 0, kosten, uitkomst', h.meting().tools === 0 && h.meting().kosten === 0.0002 && h.meting().uitkomst === 'plan');
  n = nep(100, PLAN, 400, FEIT); h = V.maak(n.dep).start('Wat is het kenteken van de Volvo?', { metZoek: true });
  r = await h.wacht(Date.now() + 2000);
  toets('feit wint van plan (wacht op Zoek snel binnen de grens)', r && r.soort === 'feit');
  n = nep(100, PLAN, 3000, FEIT); h = V.maak(n.dep).start('Wat is het kenteken van de Volvo?', { metZoek: true });
  t0 = Date.now(); r = await h.wacht(Date.now() + 500);
  toets('Zoek snel te laat: plan op de grens', r && r.soort === 'plan' && Date.now() - t0 >= 450 && Date.now() - t0 < 900);
  n = nep(1500, PLAN, 0, null); h = V.maak(n.dep).start('Zoek eens uit welke stofzuiger het beste is', { metZoek: false });
  t0 = Date.now(); r = await h.wacht(Date.now() + 400);
  toets('model te laat: null op de grens', r === null && Date.now() - t0 < 800);
  await h.klaar; toets('daarna alsnog het plan (voor de wachtbel)', h.huidig() && h.huidig().soort === 'plan');
  n = nep(50, null, 0, null); h = V.maak(n.dep).start('Zoek eens uit welke stofzuiger het beste is', { metZoek: false });
  r = await h.wacht(Date.now() + 1000); await h.klaar;
  toets('modelfout: geen voorpost, fout gemeten', r === null && /nep/.test(h.meting().model_fout || ''));
  n = nep(50, { soort: 'plan', tekst: 'Ik verstuur het nu.' }, 0, null); h = V.maak(n.dep).start('Stuur Piet dat ik later ben', { metZoek: false });
  r = await h.wacht(Date.now() + 1000);
  toets('toezegging van het model komt niet bij David', r === null);
  n = nep(50, { soort: 'plan', tekst: 'Ik zoek een stofzuiger tot 250 euro.' }, 0, null); h = V.maak(n.dep).start('Zoek eens een goede stofzuiger', { metZoek: false });
  r = await h.wacht(Date.now() + 1000);
  toets('verzonnen bedrag van het model komt niet bij David', r === null);

  // 9. server.js-koppeling (vaste plekken)
  toets('harvesterClaude: --json-schema alleen met schema', /if \(schema\) args\.push\('--json-schema'/.test(src) && !/'--system-prompt', systeem,\s*\n\s*'--json-schema'/.test(src));
  toets('harvesterClaude: zonder tools en MCP', /'--strict-mcp-config', '--tools', ''/.test(src) && /'--no-session-persistence'/.test(src));
  toets('voorpost: claude zonder schema', /return harvesterClaude\(systeem, prompt, null, o\)/.test(src));
  const ps = src.indexOf('if (j.app.voorpostParkeer) {'), pj = src.indexOf("return processJob(jobId, prompt + (staart || '')");
  toets('parkeerweg vóór processJob, zonder beurt', ps > 0 && pj > ps && /j\.result = \{ ok: true, output: j\.app\.voorpostParkeer\.tekst/.test(src));
  toets('parkeren alleen niet-gevoelig met eigen knoppen', /appGevoelig\(vp\.tekst \+ '\\n' \+ vp\.knoppen\.join\('\\n'\)\) \|\| !appVraagKnoppen\(pt\)/.test(src));
  toets('alleen hoofdkanaal', /const vpJob = kanaal === 'hoofd' && typeof voorpostStart === 'function' \?/.test(src));
  toets('uitslag + app-log + geschiedenis + knop', /voorpostUitslagVeld\(id\)/.test(src) && /voorpostLogVeld\(j, jobId\)/.test(src) && /voorpost: x\.voorpost && x\.voorpost\.tekst/.test(src) && /VOORPOST\.knopRegel\(rij\.voorpost/.test(src));
  toets('uitslag toont nooit een vraag', /if \(!vp \|\| vp\.soort === 'vraag'\) return \{\};/.test(src));
  toets('uitknop en health', /VOORPOST_UIT = process\.env\.VOORPOST_UIT \|\| '\/opt\/data\/voorpost-uit'/.test(src) && /voorpost: typeof voorpostInfo === 'function'/.test(src));
  toets('uitrol: voorpost.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bvoorpost\.js\b/.test(fs.readFileSync(path.join(HIER, 'uitrol.sh'), 'utf8')));
  console.log('\n' + ok + ' ok, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})().catch(function (e) { console.log('FOUT uitzondering: ' + (e && e.stack || e)); process.exit(1); });
EINDE
node "$T/toets.js" "$HIER"
