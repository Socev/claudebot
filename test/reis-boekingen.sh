#!/usr/bin/env bash
# Toetst wv4334 (boekingsbevestiging → eigen blok van de komende reispagina): reis-boekingen.js puur (kandidaat, datums met rol, koppelen,
# naam als platte tekst, regel zonder nummers, blok aanmaken/aanvullen met nacontrole) en de ronde met een nep-luik op een wegwerpvault
# (25-grens → per dag, herkansing, fout stopt het venster, droog schrijft niets, uitgesteld houdt het venster vast, voorbije reis nooit).
# Alleen verzonnen reizen, mails en namen; raakt de echte vault en het echte luik niet. Gebruik: bash test/reis-boekingen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(" reis-boekingen.js; then echo "ROOD  reis-boekingen.js logt naar de console of gebruikt eval"; exit 1; fi
node - <<'JS'
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('./reis-boekingen.js'), VV = require('./vault-veilig.js');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
(async function () {
  // ── puur ──
  toets('kandidaat: verblijf via Booking.com', (B.kandidaat({ onderwerp: 'Bedankt! Je boeking bij Hotel Proef is bevestigd.', van: 'noreply@booking.com' }, new Set()) || {}).soort === 'verblijf');
  toets('kandidaat: vlucht', (B.kandidaat({ onderwerp: 'Thank you for booking with us | From Nergens to Ergens on 3 March 2027', van: 'Proef Airlines <b@proefair.example>' }, new Set()) || {}).soort === 'vlucht');
  toets('kandidaat: review/check-in/betaalbewijs niet', ['Beoordeel Hotel Proef', 'Do your online check-in for your stay', 'Dit is je betaalbewijs', 'Instapkaart voor uw vlucht'].every((o) => B.kandidaat({ onderwerp: o, van: 'noreply@booking.com' }, new Set()) === null));
  toets('kandidaat: bevestiging zonder reissignaal (bestelling) niet', B.kandidaat({ onderwerp: 'je bestelling is bevestigd', van: 'winkel <a@winkel.example>' }, new Set(['proefland'])) === null);
  toets('kandidaat: inschrijving mag gelezen worden', (B.kandidaat({ onderwerp: 'Fwd: Bedankt voor je inschrijving', van: 'Kees <k@x.example>' }, new Set()) || {}).soort === 'inschrijving');
  toets('kandidaat: naamwoord in onderwerp maakt overig kandidaat', (B.kandidaat({ onderwerp: 'Bevestiging Proefland-avond', van: 'a@b.example' }, new Set(['proefland'])) || {}).soort === 'overig');
  const ds = B.datumsUit('Aankomst 3 maart 2027\nKosteloos annuleren tot 20 februari 2027\nVertrek: 2027-03-07\nBetaling voor 1-2-2027\nzo 19 apr\nOn March 5, 2027 we start\n31-2-2027');
  toets('datums: met jaar, NL/EN/ISO; annulerings-/betaaldatum en datum zonder jaar of ongeldig niet', JSON.stringify(ds) === '["2027-03-03","2027-03-05","2027-03-07"]', ds);
  const reizen = [{ id: 'aaaaaaaaaaaa', van: '2027-02-22', tot: '2027-02-26', woorden: ['proefrally', 'poolcirkel', 'kiruna'] },
    { id: 'bbbbbbbbbbbb', van: '2027-07-20', tot: '2027-08-10', woorden: ['proefland'] }];
  toets('koppel A: vlucht met datum in de periode', JSON.stringify(B.koppelReizen({ onderwerp: 'Your flight', tekst: 'Departure 21 July 2027' }, 'vlucht', reizen)) === '["bbbbbbbbbbbb"]');
  toets('koppel A: datum één dag vóór de reis telt (aankomst/heenreis)', JSON.stringify(B.koppelReizen({ onderwerp: 'x', tekst: 'Check-in 2027-02-21' }, 'verblijf', reizen)) === '["aaaaaaaaaaaa"]');
  toets('koppel: scholing-inschrijving met datum in de periode zonder naamwoord = niets', B.koppelReizen({ onderwerp: 'Bevestiging inschrijving', tekst: 'Cursus op 23 februari 2027 in Utrecht' }, 'inschrijving', reizen).length === 0);
  toets('koppel: maartboeking met annuleringsdeadline in februari = niets (review MOET 2)', B.koppelReizen({ onderwerp: 'Booking confirmation', tekst: 'Kosteloos annuleren tot 24 februari 2027\nAankomst 10 maart 2027' }, 'verblijf', reizen).length === 0);
  toets('koppel B: twee naamwoorden + jaartal zonder datum (inschrijving)', JSON.stringify(B.koppelReizen({ onderwerp: 'Bedankt voor je inschrijving', tekst: 'Proefrally Winter 2027 Poolcirkel, tot dan!' }, 'inschrijving', reizen)) === '["aaaaaaaaaaaa"]');
  toets('koppel B: één naamwoord + jaartal = niets', B.koppelReizen({ onderwerp: 'Bevestiging', tekst: 'Proefland 2027 nieuwsbrief' }, 'overig', reizen).length === 0);
  toets('koppel: datum in twee reizen = twee (twijfel)', B.koppelReizen({ onderwerp: 'x', tekst: 'van 25 februari 2027 tot 21 juli 2027' }, 'verblijf', reizen).length === 2);
  toets('naam: markdown/url/html weg (review MOET 3)', !/[[\]()!<>:`|#]|https|extern/.test(B.afzenderNaam('"![x](https://extern.example/p) <b>Hotel</b> Zon" <a@b.example>', '')), B.afzenderNaam('"![x](https://extern.example/p) <b>Hotel</b> Zon" <a@b.example>', ''));
  toets('naam: "via Booking.com" eraf', B.afzenderNaam('"Hotel Proef via Booking.com" <123@x.booking.com>', '') === 'Hotel Proef');
  toets('naam: Booking.com zonder naam = verblijf uit onderwerp, zonder nummers', B.afzenderNaam('noreply@booking.com', 'Bedankt! Je boeking bij Hotel 42 Proef is bevestigd.') === 'Hotel Proef');
  const rg = B.regelVoor({ id: '19aa00bb11cc22dd', datum: '2026-04-07T10:00:00Z', van: 'Proef Air Booking <b@proefair.example>', onderwerp: 'Booking number: XZ9876543 | From A to B on 3 March 2027' }, 'vlucht');
  toets('regel: datum, soort, afzender, gmail-id; geen onderwerp of boekingsnummer', rg === '- 07-04-2026 · Vlucht · Proef Air Booking — mail gmail:19aa00bb11cc22dd' && !/XZ98|From A/.test(rg), rg);
  toets('regel: ongeldige id = geen regel', B.regelVoor({ id: '../x', datum: '2026-01-01' }, 'vlucht') === null);
  const pag = '---\ntype: reis\nperiode: "2027-02-22 – 2027-02-26"\n---\n\n# Proefrally\n\n## Nog te regelen\n\n- [ ] Vervoer\n\n## Gerelateerd\n\n- [[20_Prive/Reizen/Index|Reizen]]\n';
  const r1 = B.blokToepassen(pag, ['- 07-04-2026 · Inschrijving · Kees — mail gmail:19aa00bb11cc22dd']);
  toets('blok: nieuw blok vlak vóór ## Gerelateerd, rest byte-gelijk', r1.nieuw_blok === true && r1.tekst === pag.replace('## Gerelateerd', '## Boekingen (Socev)\n\n- 07-04-2026 · Inschrijving · Kees — mail gmail:19aa00bb11cc22dd\n\n## Gerelateerd'), r1.tekst);
  const r2 = B.blokToepassen(r1.tekst, ['- 08-04-2026 · Vlucht · Proef Air — mail gmail:19aa00bb11cc22ee', '- 07-04-2026 · Inschrijving · Kees — mail gmail:19aa00bb11cc22dd']);
  toets('blok: tweede regel onder de eerste, dubbele niet nog eens', r2.nieuw_blok === false && r2.regels === 1 && r2.tekst.indexOf('gmail:19aa00bb11cc22dd\n- 08-04-2026 · Vlucht · Proef Air — mail gmail:19aa00bb11cc22ee\n\n## Gerelateerd') > 0, r2.tekst);
  toets('blok: niets nieuw = niets', B.blokToepassen(r2.tekst, ['- 08-04-2026 · Vlucht · Proef Air — mail gmail:19aa00bb11cc22ee']).niets === true);
  const zonder = '---\ntype: reis\nperiode: "2027-02-22 – 2027-02-26"\n---\n# X\n\ntekst';
  const r3 = B.blokToepassen(zonder, ['- 01-01-2027 · Vlucht · A — mail gmail:19aa00bb11cc22ff']);
  toets('blok: zonder Gerelateerd aan het eind', r3.tekst === zonder + '\n\n## Boekingen (Socev)\n\n- 01-01-2027 · Vlucht · A — mail gmail:19aa00bb11cc22ff\n', r3.tekst);
  toets('blok: regel met regeleinde of zonder "- " geweigerd', B.blokToepassen(pag, ['- a\n## Kop', 'geen lijst']).niets === true);
  toets('al op pagina: gmail-id of draad-id', B.alOpPagina('bron gmail:19aa00bb11cc22dd', { id: 'ffff00001111', thread_id: '19aa00bb11cc22dd' }) === true && B.alOpPagina('niets', { id: '19aa00bb11cc22dd' }) === false);
  toets('zoekvraag: venster met after/before en naamwoorden', /after:2027\/01\/01 before:2027\/01\/15$/.test(B.zoekVraag('2027-01-01', '2027-01-15', ['kiruna'])) && / OR kiruna\)/.test(B.zoekVraag('2027-01-01', '2027-01-15', ['kiruna'])));

  // ── ronde met nep-luik op een wegwerpvault ──
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'reisboek-')), V = path.join(W, 'vault'), RM = path.join(V, '20_Prive/Reizen'), ST = path.join(W, 'staat');
  fs.mkdirSync(RM, { recursive: true });
  const rally = '---\ntype: reis\nonderwerp: "Proefrally Winter 2027 — Poolcirkel"\naliases: ["Proefrally Kiruna"]\nperiode: "2027-02-22 – 2027-02-26"\n---\n\n# Proefrally (gepland)\n\n## Nog te regelen\n\n- [ ] Vervoer\n\n## Bronnen\n\n- Mailarchief: inschrijving (gmail:19aa00000000a001)\n\n## Gerelateerd\n\n- [[20_Prive/Reizen/Index|Reizen]]\n';
  const voorbij = '---\ntype: reis\nonderwerp: "Proefland 2026"\nperiode: "2026-04-19 – 2026-05-04"\n---\n\n# Proefland\n';
  fs.writeFileSync(path.join(RM, '2027 - Proefrally.md'), rally);
  fs.writeFileSync(path.join(RM, '2026 - Proefland.md'), voorbij);
  const MAILS = [
    { id: '19aa00000000a001', thread_id: '19aa00000000a001', datum: '2026-04-07T18:00:00Z', van: 'Kees <k@x.example>', onderwerp: 'Fwd: Bedankt voor je inschrijving', tekst: 'Proefrally winter 2027 Poolcirkel' },
    { id: '19aa00000000a002', thread_id: '19aa00000000a002', datum: '2026-10-01T09:00:00Z', van: '"Hotel Kiruna Proef via Booking.com" <1@x.booking.com>', onderwerp: 'Bedankt! Je boeking bij Hotel Kiruna Proef is bevestigd (nr 6249632449)', tekst: 'Inchecken: 24 februari 2027\nUitchecken 25 februari 2027\nGratis annuleren tot 20 februari 2027' },
    { id: '19aa00000000a003', thread_id: '19aa00000000a003', datum: '2026-10-02T09:00:00Z', van: 'Proef Air <b@proefair.example>', onderwerp: 'Thank you for booking with us', tekst: 'Flight on 19 April 2026' },   // voorbije reis
    { id: '19aa00000000a004', thread_id: '19aa00000000a004', datum: '2026-10-03T09:00:00Z', van: 'Scholing <s@school.example>', onderwerp: 'Bevestiging inschrijving cursus', tekst: 'Op 23 februari 2027' },
  ];
  let vragen = [], hapering = 0, vol = null;
  const luik = async (b) => {
    vragen.push(b.actie + (b.query ? ' ' + (/after:(\S+) before:(\S+)/.exec(b.query) || []).slice(1).join('..') : ''));
    if (b.actie === 'mail_lezen') { const m = MAILS.find((x) => x.id === b.id); return m ? { id: m.id, datum_lokaal: m.datum.slice(0, 10), tekst: m.tekst } : { fout: 'niet gevonden' }; }
    if (hapering > 0) { hapering--; return { query: b.query, aantal: 0, mails: [], melding: 'deels mislukt: proef' }; }
    const [, a, z] = /after:(\S+) before:(\S+)/.exec(b.query).map((x) => x.replace(/\//g, '-'));
    if (vol && a <= vol && vol < z) return { mails: Array.from({ length: 25 }, (_, i) => ({ id: 'f' + String(i).padStart(15, '0'), datum: vol + 'T08:00:00Z', van: 'x@y.example', onderwerp: 'nieuwsbrief' })) };
    return { mails: MAILS.filter((m) => m.datum.slice(0, 10) >= a && m.datum.slice(0, 10) < z).map((m) => ({ id: m.id, thread_id: m.thread_id, datum: m.datum, van: m.van, onderwerp: m.onderwerp })) };
  };
  const maak = (dag, vv) => B.maak({ vault: V, vv: vv || VV, luik, staatDir: ST, vandaag: () => dag });
  const R0 = maak('2026-11-27');
  toets('ronde: zonder aan.json is de stap uit', R0.aan() === false);
  fs.mkdirSync(ST, { recursive: true }); fs.writeFileSync(path.join(ST, 'aan.json'), '{"schrijven": false}');
  let r = await R0.ronde({});
  toets('droog: rapport noemt de hotelboeking, de inschrijving als al-bron, niets geschreven, geen staat', r.droog === true && r.al === 1 && r.per_reis[Object.keys(r.per_reis)[0]].regels.length === 1 &&
    /Verblijf · Hotel Kiruna Proef — mail gmail:19aa00000000a002$/.test(r.per_reis[Object.keys(r.per_reis)[0]].regels[0]) && fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8') === rally && !fs.existsSync(path.join(ST, 'staat.json')), r);
  toets('droog: één reis (voorbije telt niet), scholing niet gekoppeld, eerste venster = een jaar', r.reizen === 1 && r.geen >= 1 && r.venster[0] === '2025-11-27' && r.venster[1] === '2026-11-28', r);
  fs.writeFileSync(path.join(ST, 'aan.json'), '{"schrijven": true}');
  vragen = [];
  r = await R0.ronde({});
  const na = fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8');
  toets('schrijven: één regel in het eigen blok vóór Gerelateerd, rest van de pagina byte-gelijk, geen boekingsnummer', r.droog === false && r.ok === true &&
    na === rally.replace('## Gerelateerd', '## Boekingen (Socev)\n\n- 01-10-2026 · Verblijf · Hotel Kiruna Proef — mail gmail:19aa00000000a002\n\n## Gerelateerd') && !/6249632449/.test(na), [r, na]);
  toets('voorbije reis nooit aangeraakt', fs.readFileSync(path.join(RM, '2026 - Proefland.md'), 'utf8') === voorbij);
  const st = JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8'));
  toets('staat: tot = morgen, gezien met uitkomsten', st.tot === '2026-11-28' && st.gezien['19aa00000000a002'] === 'gezet:' + Object.keys(r.per_reis)[0] && /^al:/.test(st.gezien['19aa00000000a001']) && st.gezien['19aa00000000a004'] === 'geen', st);
  toets('staat en rapport 0600', (fs.statSync(path.join(ST, 'staat.json')).mode & 0o777) === 0o600 && (fs.statSync(path.join(ST, 'laatste.json')).mode & 0o777) === 0o600);
  vragen = [];
  r = await maak('2026-11-28').ronde({});
  toets('tweede nacht: klein venster (tot − 2 d), één luikvraag, niets nieuw geschreven', vragen.length === 1 && r.venster[0] === '2026-11-26' && fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8') === na, [vragen, r]);
  // nieuwe mail + hapering (herkansing) + 25-grens op één dag in het venster
  MAILS.push({ id: '19aa00000000a005', thread_id: '19aa00000000a005', datum: '2026-11-29T09:00:00Z', van: 'Proef Ferry <f@proefferry.example>', onderwerp: 'Your ferry booking confirmation', tekst: 'Sailing 21-02-2027' });
  hapering = 1; vragen = [];
  r = await maak('2026-11-30').ronde({});
  toets('hapering: één keer opnieuw, dan gewoon verder; veerboot erbij in hetzelfde blok', r.ok === true && vragen.filter((x) => /^mail_zoeken/.test(x)).length === 2 &&
    /gmail:19aa00000000a002\n- 29-11-2026 · Veerboot · Proef Ferry — mail gmail:19aa00000000a005\n\n## Gerelateerd/.test(fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8')), [vragen, r]);
  hapering = 9; vragen = [];
  const totVoor = JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8')).tot;
  r = await maak('2026-12-05').ronde({});
  const st2 = JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8'));
  toets('luik blijft falen: ronde stopt, tot schuift niet, fout_nachten 1, ok false', r.ok === false && st2.tot === totVoor && st2.fout_nachten === 1 && r.fouten.length === 1, [r, st2]);
  hapering = 0; vol = '2026-12-03'; vragen = [];
  r = await maak('2026-12-05').ronde({});
  toets('25-grens: venster per dag opnieuw gevraagd, dag met 25 = fout, tot blijft op die dag', r.ok === false && vragen.length > 2 && JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8')).tot === '2026-12-03' && /2026-12-03: meer dan 25/.test(r.fouten[0]), [vragen, r]);
  vol = null;
  // uitgesteld (MOET 1): meer dan 5 nieuwe voor één reis → de rest de volgende nacht, venster blijft staan
  for (let i = 0; i < 7; i++) MAILS.push({ id: '19aa00000000b00' + i, thread_id: '19aa00000000b00' + i, datum: '2026-12-06T0' + i + ':00:00Z', van: 'Proef Air <b@proefair.example>', onderwerp: 'Your flight booking confirmation', tekst: 'Flight on 22 February 2027' });
  r = await maak('2026-12-07').ronde({});
  const st3 = JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8'));
  const blok = (t) => t.slice(t.indexOf('## Boekingen (Socev)'), t.indexOf('## Gerelateerd'));
  toets('uitgesteld: 5 regels erbij, 2 uitgesteld, tot schuift niet op', r.uitgesteld === 2 && (blok(fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8')).match(/^- /gm) || []).length === 7 && st3.tot <= '2026-12-03', [r, st3]);
  r = await maak('2026-12-08').ronde({});
  toets('volgende nacht: de 2 uitgestelde erbij, daarna tot = morgen', r.uitgesteld === 0 && (blok(fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8')).match(/^- /gm) || []).length === 9 && JSON.parse(fs.readFileSync(path.join(ST, 'staat.json'), 'utf8')).tot === '2026-12-09', r);
  // de reis is intussen voorbij → niets meer
  const voor = fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8');
  MAILS.push({ id: '19aa00000000c001', thread_id: '19aa00000000c001', datum: '2027-03-01T09:00:00Z', van: 'Proef Air <b@proefair.example>', onderwerp: 'Your flight booking confirmation', tekst: 'Flight on 22 February 2027' });
  r = await maak('2027-03-02').ronde({});
  toets('na de reis: geen komende reis, geen luikvraag, pagina ongemoeid', r.reizen === 0 && fs.readFileSync(path.join(RM, '2027 - Proefrally.md'), 'utf8') === voor, r);
  // symlink in plaats van de reispagina: vault-veilig volgt hem niet
  const echt = path.join(W, 'buiten.md'); fs.writeFileSync(echt, rally.replace('Proefrally (gepland)', 'Buiten'));
  fs.renameSync(path.join(RM, '2027 - Proefrally.md'), path.join(W, 'weg.md')); fs.symlinkSync(echt, path.join(RM, '2027 - Proefrally.md'));
  fs.rmSync(path.join(ST, 'staat.json'));
  r = await maak('2026-12-08').ronde({});
  toets('symlink als reispagina: niet gelezen of beschreven', fs.readFileSync(echt, 'utf8') === rally.replace('Proefrally (gepland)', 'Buiten') && r.reizen === 0, r);
  // server.js-blok
  const sv = fs.readFileSync('server.js', 'utf8');
  toets('server.js: stap tripper-boekingen 04:30 in-proces, meldt via de keten', /naam: 'tripper-boekingen', start_na: \[4, 30\], limiet_min: 10, pogingen: 2, inProces: true, meldtZelf: false, doe: function \(\) \{ return tripperBoekingenStap\(\); \}/.test(sv));
  toets('server.js: schakelaar en luik via appAgendaApi', /TRIPPER_BOEKINGEN_DIR = '\/opt\/data\/scripts-staat\/tripper-boekingen'/.test(sv) && /luik: function \(body\) \{ return appAgendaApi\(body, \{ timeoutMs: 60000 \}\); \}/.test(sv) && /if \(!tripperBoekingen\.aan\(\)\) return \{ ok: true, al_gedaan: true/.test(sv));
  toets('uitrol.sh: reis-boekingen.js in de releaselijst', /^RELEASE_OPTIONEEL="[^"]*\breis-boekingen\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering ' + (e && e.stack)); process.exit(1); });
JS
