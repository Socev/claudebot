#!/usr/bin/env bash
# Toetst POST /werkkamer-tegels (wv561, 19-10-2026): de deterministische Werkkamer-tegels zonder taalmodel. Het app-blok en het
# routestuk worden uit server.js geknipt en in een vm-context gedraaid (zoals test/socev-app-poort.sh); Todoist en rclone zijn
# nagebootst, de vault is een wegwerpmap. Regressie: appProjecten() (tab Projecten van de app) geeft op de échte vault dezelfde
# uitvoer als de server.js van main (of $WK_OUD). Raakt de pod, Todoist, Drive en de Werkkamer niet.
# Gebruik: bash test/werkkamer-tegels.sh
set -u
cd "$(dirname "$0")/.." || exit 1
OUD="${WK_OUD:-}"
if [ -z "$OUD" ]; then OUD=$(mktemp); git show main:server.js > "$OUD" 2>/dev/null || cp server.js "$OUD"; fi
WK_OUD_PAD="$OUD" node - <<'JS'
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os'), crypto = require('crypto'), http = require('http');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400) + ']' : '')); }
function laad(bestand, o) {
  o = o || {};
  const src = fs.readFileSync(bestand, 'utf8');
  const a = src.indexOf('// ── Socev-app poort'), b = src.indexOf('// ── einde socev-app poort');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'wktoets-')), logs = [];
  fs.mkdirSync(path.join(W, 'data'), { recursive: true });
  const stil = function () { return { unref() {} }; };
  const g = { require, fs, path, crypto, Buffer, console, URL, setInterval: stil, setTimeout, clearTimeout, AbortSignal, Promise, JSON, Date, URLSearchParams,
    process: { env: Object.assign({ APP_DATA_DIR: path.join(W, 'data'), APP_LOG_DIR: path.join(W, 'log'), APP_VAULT_DIR: o.vault, TODOIST_MCP_TOKEN: 'nep-todoist',
      IO_DIR: path.join(W, 'io'), APP_BESTANDEN_DIR: path.join(W, 'b'), APP_UPLOAD_DIR: path.join(W, 'u'), APP_RCLONE_BIN: path.join(W, 'geen-rclone') }, o.env || {}), pid: process.pid },
    VAULT: o.vault, SECRET: 'g'.repeat(40), fetch: o.fetch || function () { return Promise.reject(new Error('geen netwerk in de toets')); },
    logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), rol: {}, rolPrimair: () => g.__primair !== false, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50,
    jobs: {}, agentsReg: {}, DEFAULT_WS: 'vault', reqPath: (req) => (req.url || '').split('?')[0] };
  const ctx = vm.createContext(g);
  const wk = src.indexOf('function werkkamerTegels') > 0;
  vm.runInContext(src.slice(a, b) + '\n;globalThis.__h = { appStaat, appProjecten' + (wk ? ', werkkamerTegels, wkDeadlines, wkEntiteit, wkHouder, wkDocumenten, wkTodoist, wkEersteRegel, WK_TOTAAL_MS' : '') + ' };', ctx, { filename: bestand });
  if (wk) {
    // het routestuk uit de hoofdhandler, met readBody en rolPoort zoals in server.js (rolPoort nagebootst: primair of 409)
    const ra = src.indexOf('  // ── wv561: Werkkamer-tegels zonder taalmodel'), rb = src.indexOf('  // ── v2: achtergrondagent starten');
    vm.runInContext('function reqLogExtra(res, o) { res._log = Object.assign({}, res._log || {}, o); }\n' +
      'function readBody(req, cb) { let t = ""; req.on("data", function (c) { t += c; }); req.on("end", function () { try { cb(JSON.parse(t)); } catch (e) { cb(null); } }); }\n' +
      'function rolPoort(res, verder) { if (rolPrimair()) return verder(); res.writeHead(409, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "passief" })); }\n' +
      'globalThis.__route = function (req, res) {\n' + src.slice(ra, rb) + '\n  res.writeHead(404); res.end("nee");\n};', ctx, { filename: bestand + '#route' });
  }
  ctx.__h.logs = logs; ctx.__h.W = W; ctx.__h.g = g; ctx.__h.route = ctx.__route;
  return ctx.__h;
}
let klaar = false;
const wakker = setInterval(() => {}, 1000);   // AbortSignal.timeout houdt de lus niet zelf wakker
process.on('exit', () => { if (!klaar) { console.log('ROOD  toets eindigde voortijdig'); process.exitCode = 1; } });
(async function () {
  const NIEUW = 'server.js', OUD = process.env.WK_OUD_PAD;
  // ── 1. regressie: tab Projecten van de app ongewijzigd op de echte vault ──
  const VAULT = '/opt/data/AI_SecondBrain';
  if (fs.existsSync(path.join(VAULT, '00_Systeem', 'Deadlines.md'))) {
    const o = laad(OUD, { vault: VAULT }), n = laad(NIEUW, { vault: VAULT });
    const po = o.appProjecten(), pn = n.appProjecten();
    delete po.op; delete pn.op;
    toets('1 regressie: appProjecten() op de echte vault gelijk aan main (' + po.deadlines.length + ' deadlines, ' + po.lopend.length + ' lopend)', JSON.stringify(po) === JSON.stringify(pn));
  } else console.log('OVERGESLAGEN 1 (geen vault)');

  // ── 2. deadlines: de vastgelegde regels ──
  const V = fs.mkdtempSync(path.join(os.tmpdir(), 'wkvault-'));
  const H = laad(NIEUW, { vault: V });
  const vandaag = '2026-10-19', plus = (n) => new Date(Date.parse(vandaag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const rij = (d, e, wat, actie, sein, bron) => '| ' + d + ' | ' + e + ' | ' + wat + ' | ' + actie + ' | ' + sein + ' | ' + (bron || '[[00_Systeem/X\\|x]]') + ' |';
  const kop = '# Deadlines\n\n## Actueel\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n';
  const reg = [
    rij(plus(3), 'Tolgaarde', '**AFGEHANDELD 1-10:** klaar.', 'David: x', 7),                                     // 0 dicht (kop)
    rij(plus(4), 'Tolgaarde', '**Titel vier.** Iets gebeurd. **AFGEHANDELD 3-10:** rond.', 'David: x', 7),         // 1 dicht (later blok na zinseinde)
    rij(plus(5), 'Groenhouten', '**UPDATE 1-10:** **LOSGELATEN 2-10** niet meer nodig', 'David: x', 7),            // 2 dicht (na statusblok)
    rij(plus(6), 'Groenhouten', '**Titel zes** — iemand zei **afgehandeld** maar niet echt', 'David: x', 7),      // 3 open (woord midden in tekst)
    rij(plus(7), 'Privé / Fiore school', '**Studiedag** — vrij.', 'geen actie — ter info dat de kinderen vrij zijn', 0), // 4 open, ter info
    rij(plus(8), 'Privé', '**Feest**', 'geen actie meer — gedaan', 3),                                              // 5 dicht
    rij(plus(9), 'Privé', '**Feest2**', 'vervallen — geen actie', 3),                                               // 6 dicht
    rij(plus(3), 'HAGRO', '**Zonder getal**', 'David: x', '— (gemeld in de briefing 14-10 door de A)'),           // 7 open, signaleer 0, telt
    rij(plus(45), 'POT / POH-GGZ', '**Ver maar sein**', 'Cynthia: bellen', 60),                                   // 8 open, sein
    rij(plus(90), 'DBH / Bevlogen huisartsen', '**Heel ver met sein**', 'David: x', 100),                         // 9 open (sein buiten 60)
    rij(plus(90), 'DBH', '**Heel ver zonder sein**', 'David: x', 5),                                               // 10 weg
    rij(plus(-7), 'Privé / Gambia', '**Net verlopen**', 'David: x', 3),                                            // 11 open, verlopen
    rij(plus(-8), 'Privé', '**Te lang verlopen**', 'David: x', 3),                                                 // 12 weg
    '| 2026-11 | Privé | **Halve datum toekomst** | David | 3 | x |',                                                // 13 telt als halve datum
    '| 2026-01 | Privé | **Halve datum verleden** | David | 3 | x |',                                                // 14 niet geteld
    '| ' + plus(2) + ' | Privé | **Scheef** | David | 3 |',                                                             // 15 scheef
    rij(plus(2), 'Tolgaarde + Groenhouten', '**UPDATE 13-10 (WhatsApp): bla.** **Echte titel** met rest', 'Een hele lange houdernaam die langer is dan veertig tekens: x', 3), // 16 titel + houder
    rij(plus(2), 'Systeem', '**Werk aan Socev**', 'David', 3),                                                     // 17 Systeem blijft (privé dashboard)
    rij(plus(2), 'David (nascholing)', '**Nascholing**', 'David: x', 3),                                           // 18 Overig
    rij(plus(2), 'Familie', '**BSN 111222333 in de titel**', 'David: x', 3),                                       // 19 BSN gemaskeerd
    rij(plus(2), 'POT / kostenmaatschap', '**Pipe in [[a/b\\|alias]] titel**', 'David: x', 3),                    // 20 pipe in wikilink
    rij(plus(11), 'Tolgaarde', '**Titel zeven** — iemand zei **AFGEHANDELD 1-10** maar niet echt', 'David: x', 7),  // 22 open (sluitwoord opent geen zin)
    rij(plus(12), 'Tolgaarde', '**Titel acht**', 'David: bellen, anders vervallen', 7),                           // 23 open (vervallen niet aan het begin)
    rij(plus(2), 'LHV Midden-Nederland', '**28-9 (opgave David): Niet meer seinen.** Oorspronkelijk: **x**', 'David: x', 3), // 21 dicht (kop: niet meer seinen)
  ];
  const D = H.wkDeadlines(kop + reg.join('\n') + '\n\n## Kandidaten\n\n| 2026-10-20 | X | **Niet in Actueel** | David | 3 | x |\n', vandaag);
  const T = (t) => D.items.find((x) => x.titel.indexOf(t) === 0);
  toets('2a dicht: kop, later blok na zinseinde, na statusblok, "geen actie meer", "vervallen", "niet meer seinen"', !T('klaar') && !T('Titel vier') && !D.items.some((x) => x.datum === plus(5) || x.datum === plus(4) || x.datum === plus(3) && /klaar/i.test(x.titel)) && !T('Feest') && !T('Oorspronkelijk') && !D.items.some((x) => x.datum === plus(9)), D.items.map((x) => x.titel));
  toets('2b een sluitwoord midden in de tekst sluit niets (ook in hoofdletters na een streep; ook "vervallen" niet aan het begin van Actie)', !!T('Titel zes') && !!T('Titel zeven') && !!T('Titel acht'), D.items.map((x) => x.titel));
  toets('2c "geen actie — ter info" blijft zichtbaar met houder "geen actie (ter info)"', T('Studiedag') && T('Studiedag').houder === 'geen actie (ter info)' && T('Studiedag').entiteit === 'Privé', T('Studiedag'));
  toets('2d signaleer zonder leidend getal = 0 (geen 1410), sein false, geteld in melding', T('Zonder getal') && T('Zonder getal').sein === false && /1 regel zonder getal bij Signaleer/.test(D.melding || ''), [T('Zonder getal'), D.melding]);
  toets('2e sein binnen signaleer; buiten 60 dagen alleen met sein', T('Ver maar sein').sein === true && T('Heel ver met sein') && T('Heel ver met sein').sein === true && !T('Heel ver zonder sein'));
  toets('2f -7 dagen mee (sein false), -8 niet', T('Net verlopen') && T('Net verlopen').dagen === -7 && T('Net verlopen').sein === false && !T('Te lang verlopen'));
  toets('2g halve datum: toekomstige maand geteld, verleden niet; scheve rij geteld; Kandidaten-sectie niet gelezen', /1 regel zonder volledige datum/.test(D.melding) && /1 regel in het register onleesbaar/.test(D.melding) && !T('Niet in Actueel') && !T('Halve'), D.melding);
  toets('2h titel slaat UPDATE-blok over; houder > 40 tekens -> David; "Tolgaarde + Groenhouten" -> Tolgaarde', T('Echte titel') && T('Echte titel').houder === 'David' && T('Echte titel').entiteit === 'Tolgaarde', T('Echte titel'));
  toets('2i Systeem en Overig blijven zichtbaar; Gambia gaat voor Privé; LHV-rij dicht', T('Werk aan Socev').entiteit === 'Systeem' && T('Nascholing').entiteit === 'Overig' && T('Net verlopen').entiteit === 'Gambia');
  toets('2j BSN in de titel gemaskeerd, rij blijft', D.items.some((x) => /BSN/.test(x.titel) && !/111222333/.test(x.titel) && /weggelaten/i.test(x.titel)), D.items.filter((x) => /BSN/.test(x.titel)));
  toets('2k pipe in wikilink: zes cellen, titel met alias', T('Pipe in alias titel') && T('Pipe in alias titel').entiteit === 'POT', D.items.map((x) => x.titel));
  toets('2l houder = tekst vóór de dubbele punt', T('Ver maar sein').houder === 'Cynthia');
  toets('2m uitvoer op datum gesorteerd, velden exact', D.items.every((x, i) => i === 0 || D.items[i - 1].datum <= x.datum) && D.items.every((x) => JSON.stringify(Object.keys(x)) === '["datum","titel","houder","dagen","sein","entiteit"]'));
  const em = { 'Groenhouten': 'Groenhouten', 'Tolgaarde / ONTIE': 'Tolgaarde', 'Tolgaarde ↔ Groenhouten': 'Tolgaarde', 'POT POH-GGZ': 'POT', 'POT / HAGRO': 'POT', 'DBH (raakt praktijken)': 'DBH',
    'HAGRO / beide praktijken': 'HAGRO', 'Privé / Gambia': 'Gambia', 'Privé (Shizzle)': 'Privé', 'Privé / GHAWA': 'Privé', 'Familie': 'Privé', 'Systeem': 'Systeem',
    'Holding / Privé': 'Overig', 'Projecten/OurMind': 'Overig', 'LHV Midden-Nederland': 'HAGRO', 'David (beroep)': 'Overig', '': 'Overig' };
  const emFout = Object.keys(em).filter((k) => H.wkEntiteit(k) !== em[k]);
  toets('2n entiteit: vaste afbeelding (' + Object.keys(em).length + ' gevallen)', !emFout.length, emFout.map((k) => k + ' -> ' + H.wkEntiteit(k)));
  // plafond: 45 open rijen, waarvan 5 met sein ver weg -> 40, die 5 zitten erin, afgekapt 5
  const veel = [];
  for (let i = 0; i < 40; i++) veel.push(rij(plus(10 + i), 'Tolgaarde', '**Gewoon ' + i + '**', 'David: x', 0));
  for (let i = 0; i < 5; i++) veel.push(rij(plus(80 + i), 'Tolgaarde', '**Sein ver ' + i + '**', 'David: x', 120));
  const P = H.wkDeadlines(kop + veel.join('\n'), vandaag);
  toets('2o plafond 40: sein eerst, afgekapt 5 in veld en melding, gesorteerd', P.items.length === 40 && P.afgekapt === 5 && P.items.filter((x) => /^Sein ver/.test(x.titel)).length === 5 && /5 latere deadlines niet getoond/.test(P.melding) && !P.items.some((x) => /^Gewoon 3[5-9]$/.test(x.titel)), [P.items.length, P.afgekapt, P.melding]);
  toets('2p deterministisch: twee keer dezelfde uitvoer', JSON.stringify(H.wkDeadlines(kop + reg.join('\n'), vandaag)) === JSON.stringify(D));
  toets('2q geen sectie Actueel -> fout (paneel overslaan), geen items', (function () { const x = H.wkDeadlines('# leeg\n', vandaag); return x.fout && !x.items.length; })());

  // ── 3. documenten op een wegwerpvault ──
  const mk = (p, t, mt) => { const f = path.join(V, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); if (mt) fs.utimesSync(f, mt, mt); };
  const fm = (u) => '---\ntype: x\n' + (u ? 'updated: ' + u + '\n' : '') + '---\n';
  for (let i = 1; i <= 10; i++) mk('10_Zakelijk/Groenhouten/Map' + (i % 3) + '/Doc ' + i + '.md', fm('2026-10-' + String(i).padStart(2, '0')) + '# Kop\n\nRegel ' + i + '.\n');
  mk('10_Zakelijk/Groenhouten/raw_input/Nieuwst.md', fm('2026-12-01') + 'x');
  mk('10_Zakelijk/Groenhouten/Voltooid/Nieuwst2.md', fm('2026-12-01') + 'x');
  mk('10_Zakelijk/Groenhouten/_sjabloon.md', fm('2026-12-01') + 'x');
  mk('10_Zakelijk/Groenhouten/.obsidian/x.md', fm('2026-12-01') + 'x');
  mk('10_Zakelijk/Tolgaarde/Zonder fm.md', '# T\n\n> [!abstract] Samenvatting\n> Eerste regel van [[10_Zakelijk/Tolgaarde/index|Stichting De\n> Tolgaarde]] en meer.\n', new Date('2026-10-18T10:00:00Z'));
  mk('10_Zakelijk/Tolgaarde/BSN 111222333.md', fm('2026-10-01') + '**Kopje**\n\nPatiënt 111222333 hier.\n');
  mk('20_Prive/Gambia/Personen/G.md', fm('2026-10-05') + 'Gambia-regel\n');
  mk('20_Prive/Huis.md', fm('2026-10-04') + 'Huis-regel\n');
  mk('00_Systeem/Logboek/2026-10-19.md', fm('2026-10-19') + 'x');
  mk('01_Ontwikkeling/Plan.md', fm('2026-10-02') + 'Plan-regel\n');
  fs.mkdirSync(path.join(V, '10_Zakelijk/HAGRO'), { recursive: true });
  mk('buiten/geheim.md', fm('2026-12-31') + 'buiten de entiteit\n');
  fs.symlinkSync(path.join(V, 'buiten'), path.join(V, '10_Zakelijk/HAGRO/link-naar-buiten'));
  mk('10_Zakelijk/HAGRO/echt.md', fm('2026-10-01') + 'Echte regel\n');
  fs.symlinkSync(path.join(V, '10_Zakelijk/HAGRO/echt.md'), path.join(V, '10_Zakelijk/HAGRO/symlink.md'));
  mk('10_Zakelijk/DBH/Sleutel sk-abcdefghijklmnopqrstuvwxyz0123.md', fm('2026-10-01') + 'Tekst met sk-abcdefghijklmnopqrstuvwxyz0123 erin\n');
  // rclone-cache vooraf gevuld voor één map (de route gebruikt verouderde cache gewoon)
  H.appStaat.projDrive.mappen['10_Zakelijk/Groenhouten/Map1'] = { op: Date.now() - 3 * 3600 * 1000, ids: { 'Doc 10.md': 'ABCDEFGHIJ1234567890' } };
  const t0 = Date.now();
  const docs = await H.wkDocumenten(Date.now() + 38000);
  const E = (n) => docs.find((x) => x.entiteit === n);
  toets('3a acht entiteiten in vaste volgorde', JSON.stringify(docs.map((x) => x.entiteit)) === '["Groenhouten","Tolgaarde","POT","DBH","HAGRO","Gambia","Privé","Systeem"]', docs.map((x) => x.entiteit));
  toets('3b nieuwste 8 op updated, uitsluitingen (raw_input, Voltooid, _, .map, Logboek) gelden', E('Groenhouten').items.length === 8 && E('Groenhouten').items[0].titel === 'Doc 10' && E('Groenhouten').items[7].titel === 'Doc 3' && !E('Groenhouten').items.some((x) => /Nieuwst|sjabloon|^x$/.test(x.titel)) && !E('Systeem').items.some((x) => /Logboek/.test(x.pad)), E('Groenhouten').items.map((x) => x.titel));
  toets('3c zonder updated: mtime als datum; calloutkop overgeslagen; afgebroken wikilink heel', (function () { const x = E('Tolgaarde').items.find((i) => i.titel === 'Zonder fm'); return x && x.updated === '2026-10-18' && x.eerste_regel === 'Eerste regel van Stichting De Tolgaarde en meer.'; })(), E('Tolgaarde').items);
  toets('3d BSN gemaskeerd in titel en eerste regel; vet-only kopje overgeslagen', (function () { const x = E('Tolgaarde').items.find((i) => /^BSN/.test(i.titel)); return x && !/111222333/.test(JSON.stringify(x)) && /^Patiënt/.test(x.eerste_regel); })(), E('Tolgaarde').items);
  toets('3e Privé zonder Gambia; Gambia apart; Systeem uit 00_ en 01_; lege map -> items [] met melding', E('Privé').items.length === 1 && E('Privé').items[0].titel === 'Huis' && E('Gambia').items[0].titel === 'G' && E('Systeem').items[0].titel === 'Plan' && E('POT').items.length === 0 && /geen documenten/.test(E('POT').melding));
  toets('3f link uit (verouderde) cache, zonder ID geen link; rclone afwezig hangt niet (' + (Date.now() - t0) + ' ms)', E('Groenhouten').items[0].link === 'https://drive.google.com/file/d/ABCDEFGHIJ1234567890/view' && !('link' in E('Groenhouten').items[1]) && Date.now() - t0 < 9500, E('Groenhouten').items.slice(0, 2));
  toets('3h symlink-map en symlink-.md overgeslagen', E('HAGRO').items.length === 1 && E('HAGRO').items[0].titel === 'echt', E('HAGRO').items.map((x) => x.pad));
  toets('3i sleutelvorm gemaskeerd in titel, pad en eerste regel', E('DBH').items.length === 1 && !/sk-abcdefghij/.test(JSON.stringify(E('DBH').items)), E('DBH').items);
  // mtime verandert -> opnieuw gelezen; gekozen bestand ontbreekt in > 10 min oude cache -> voorrang (op 0)
  mk('20_Prive/Huis.md', fm('2026-10-04') + 'Nieuwe huisregel\n', new Date(Date.now() + 5000));
  H.appStaat.projDrive.mappen['20_Prive'] = { op: Date.now() - 20 * 60 * 1000, ids: { 'Ander.md': 'ZZZZZZZZZZZZZZZZZZZZ' } };
  H.appStaat.projDrive.mappen['01_Ontwikkeling'] = { op: Date.now() - 20 * 60 * 1000, ids: { 'Plan.md': 'PPPPPPPPPPPPPPPPPPPP' } };
  const docs2 = await H.wkDocumenten(Date.now() + 38000), E2 = (n) => docs2.find((x) => x.entiteit === n);
  toets('3j gewijzigde mtime -> nieuwe eerste regel (cache op mtime)', E2('Privé').items[0].eerste_regel === 'Nieuwe huisregel', E2('Privé').items[0]);
  toets('3k map waarin een gekozen bestand ontbreekt (cache > 10 min) krijgt voorrang; volledige map niet', H.appStaat.projDrive.mappen['20_Prive'].op === 0 && H.appStaat.projDrive.mappen['01_Ontwikkeling'].op > 0 && E2('Systeem').items[0].link === 'https://drive.google.com/file/d/PPPPPPPPPPPPPPPPPPPP/view');
  fs.unlinkSync(path.join(V, '01_Ontwikkeling/Plan.md'));
  await H.wkDocumenten(Date.now() + 38000);
  toets('3l verdwenen bestand uit de documentcache', !Object.keys(H.appStaat.wkDocs).some((p) => /Plan\.md$/.test(p)) && Object.keys(H.appStaat.wkDocs).some((p) => /Huis\.md$/.test(p)));
  mk('01_Ontwikkeling/Plan.md', fm('2026-10-02') + 'Plan-regel\n');
  // trage rclone: wachten hooguit 8 s, alleen bij mappen zonder cache
  const RC = path.join(H.W, 'trage-rclone'); fs.writeFileSync(RC, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  H.g.process.env.APP_RCLONE_BIN = RC; H.appStaat.projDrive = { mappen: {}, bezig: null, uitTot: 0 };
  let t2 = Date.now(); await H.wkDocumenten(Date.now() + 38000); const duur1 = Date.now() - t2;
  H.appStaat.projDrive = { mappen: {}, bezig: null, uitTot: 0 };
  t2 = Date.now(); await H.wkDocumenten(Date.now() + 6000); const duur2 = Date.now() - t2;
  toets('3m trage rclone: wacht begrensd op 8 s (' + duur1 + ' ms) en door de totaalgrens (' + duur2 + ' ms bij 6 s rest)', duur1 >= 7500 && duur1 < 9500 && duur2 >= 3500 && duur2 < 5000, [duur1, duur2]);
  H.g.process.env.APP_RCLONE_BIN = path.join(H.W, 'geen-rclone');
  toets('3g geen veld fout bij gezonde documenten; velden exact', docs.every((d) => !d.fout) && E('Groenhouten').items.every((x) => /^(titel,pad,updated,eerste_regel)(,link)?$/.test(Object.keys(x).join(','))));

  // ── 4. Todoist (nagebootst) ──
  const taken = [];
  for (let i = 0; i < 85; i++) taken.push({ id: 't' + i, content: '**Taak** [' + i + '](https://x.nl)', project_id: i % 2 ? 'pInbox' : 'pWerk', priority: (i % 4) + 1, labels: i === 1 ? ['socev'] : [], parent_id: null, checked: false, is_deleted: false, child_order: i, due: i < 3 ? { date: '2026-10-0' + (3 - i) + 'T19:30:00' } : i < 6 ? { date: '2026-11-0' + i } : null });
  taken.push({ id: 'kind', content: 'Subtaak', project_id: 'pWerk', priority: 4, labels: [], parent_id: 't0', checked: false, is_deleted: false, child_order: 0, due: { date: '2026-09-01' } });
  taken.push({ id: 'af', content: 'Afgevinkt', project_id: 'pWerk', priority: 4, labels: [], parent_id: null, checked: true, is_deleted: false, child_order: 0, due: { date: '2026-01-01' } });
  let aanroepen = [];
  const nepTodoist = (modus) => async function (url, o) {
    aanroepen.push(url);
    if (!/^https:\/\/api\.todoist\.com\/api\/v1\/(tasks|projects)\?limit=200/.test(url) || !/^Bearer nep-todoist$/.test(o.headers.Authorization)) throw new Error('verkeerde aanroep ' + url);
    if (modus === 'kapot') return { ok: false, status: 503, json: async () => ({ geheim: 'body' }) };
    const pag = /cursor=(\d)/.exec(url), n = pag ? Number(pag[1]) : 0;
    if (/projects/.test(url)) return { ok: true, json: async () => ({ results: [{ id: 'pInbox', name: 'Inbox', inbox_project: true }, { id: 'pWerk', name: 'Werk' }], next_cursor: null }) };
    if (modus === 'eindeloos') return { ok: true, json: async () => ({ results: [{ id: 'e' + n, content: 'p' + n, project_id: 'pWerk', priority: 1, checked: false }], next_cursor: String(n + 1) }) };
    const deel = taken.slice(n * 30, n * 30 + 30);
    return { ok: true, json: async () => ({ results: deel, next_cursor: n * 30 + 30 < taken.length ? String(n + 1) : null }) };
  };
  H.g.fetch = nepTodoist('goed');
  const td = await H.wkTodoist(Date.now() + 38000);
  toets('4a cursor gevolgd (3 pagina\'s), afgevinkt weg, plafond 80 met afgekapt', td.items.length === 80 && td.afgekapt === 6 && /6 taken niet getoond/.test(td.melding) && !td.items.some((x) => x.titel === 'Afgevinkt'), [td.items.length, td.afgekapt, td.melding]);
  toets('4b volgorde: over tijd/datum oplopend eerst, dan zonder datum op prioriteit aflopend', td.items[0].titel === 'Taak 0 › Subtaak' && td.items[1].datum === '2026-10-01' && td.items[6].datum === '2026-11-05' && td.items[7].datum === null && td.items[7].prioriteit === 4 && td.items[79].prioriteit <= td.items[7].prioriteit, td.items.slice(0, 8));
  toets('4c opmaak weg, Inbox-naam, url, labels, datum zonder tijd', td.items[1].titel === 'Taak 2' && td.items.some((x) => x.project === 'Inbox') && td.items[1].url === 'https://app.todoist.com/app/task/t2' && td.items.find((x) => x.url.endsWith('/t1')).labels[0] === 'socev' && td.items[3].datum === '2026-10-03');
  H.g.fetch = nepTodoist('eindeloos'); aanroepen = [];
  const te = await H.wkTodoist(Date.now() + 38000);
  toets('4d hooguit 3 pagina\'s per lijst, dan melding', aanroepen.filter((u) => /tasks/.test(u)).length === 3 && /meer dan 3 pagina/.test(te.melding), [aanroepen.length, te.melding]);
  H.g.fetch = nepTodoist('kapot');
  const tk = await H.wkTodoist(Date.now() + 38000);
  toets('4e Todoist stuk -> vaste fouttekst, geen body, geen items', tk.fout === 'Todoist is nu niet te lezen' && !tk.items.length && !/geheim/.test(JSON.stringify(tk)));
  H.g.fetch = (u, o) => new Promise((ok, nee) => { o.signal.addEventListener('abort', () => nee(new Error('afgebroken'))); });   // hangt tot de grens (zoals echte fetch met signal)
  const t1 = Date.now(), th = await H.wkTodoist(Date.now() + 3000);
  toets('4f hangende Todoist begrensd door de totaalgrens (' + (Date.now() - t1) + ' ms)', th.fout && Date.now() - t1 < 4000);

  // ── 5. route-contract ──
  H.g.fetch = nepTodoist('goed');
  const srv = http.createServer((q, s) => H.route(q, s)); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const vraag = (body, pad) => new Promise((ok) => { const r = http.request({ host: '127.0.0.1', port: srv.address().port, path: pad || '/werkkamer-tegels', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (e) {} ok({ s: res.statusCode, j, t }); }); }); r.end(body); });
  let r = await vraag(JSON.stringify({ secret: 'fout' }));
  toets('5a verkeerd secret -> 401', r.s === 401, r.s);
  r = await vraag('geen json');
  toets('5b geen JSON -> 400', r.s === 400, r.s);
  r = await vraag(JSON.stringify({ secret: 'g'.repeat(40), datum: '2020-01-01', pad: '/etc' }));
  toets('5c goed secret -> 200 met drie panelen; extra velden genegeerd', r.s === 200 && r.j.ok === true && Array.isArray(r.j.todoist.items) && Array.isArray(r.j.deadlines.items) && r.j.documenten.length === 8 && r.j.vandaag !== '2020-01-01', r.t.slice(0, 300));
  toets('5d deadline-register weg -> alleen dat paneel fout, de rest gewoon', r.j.deadlines.fout === 'het deadline-register is nu niet te lezen' && !r.j.todoist.fout && r.j.todoist.items.length === 80);
  H.g.__primair = false;
  r = await vraag(JSON.stringify({ secret: 'g'.repeat(40) }));
  toets('5e passieve kant -> 409 (rolPoort)', r.s === 409, r.s);
  H.g.__primair = true;
  toets('5f totaalgrens onder de n8n-timeout van 60 s', H.WK_TOTAAL_MS <= 40000 && H.WK_TOTAAL_MS >= 30000);
  srv.close();
  klaar = true; clearInterval(wakker);
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  toets brak: ' + (e && e.stack || e)); process.exit(1); });
JS
