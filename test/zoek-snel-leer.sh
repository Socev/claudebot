#!/usr/bin/env bash
# Toetst zoek-snel-leer.js en laag 0 in zoek-snel.js (wv3743, besluitenpagina nr 472 = 3C172; ontwerp mk-scripts/wv3743/ontwerp.md, Codex r3 GO):
# vraagsleutel (volgorde telt, vulwoorden weg), alleen een antwoord uit tekstindex/zoektocht met bronanker, kaart per ISO-week (bevroren,
# ≤ 12 stappen, niet zolang er een open staat), knop Ja/Nee/Anders "zonder n"/Anders zonder nummers, terugdraaien bij verval, een na de
# kaart gewijzigd paar telt niet; laag 0: antwoord zonder model met "Onthouden antwoord", anker met de hele koppenstructuur (verhuisde
# IBAN-regel = niet gebruiken, vergeten, gewoon zoeken), eindwoord = geen anker; en de koppeling in server.js en uitrol.sh. Alles in een
# wegwerpmap; raakt de echte vault en app-data niet. Gebruik: bash test/zoek-snel-leer.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const L = require('./zoek-snel-leer.js');
const Z = require('./zoek-snel.js');
const OV = require('./ovis-register.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'zoek-snel-leer-'));
let klok = Date.parse('2026-11-23T09:00:00+01:00');   // maandag, ISO-week 48
const maak = function (naam) { return L.maak({ bestand: path.join(W, naam), nu: function () { return klok; }, eruitUit: OV.eruitUit }); };

(async function () {
  // ── vraagsleutel ──
  const m = maak('a.json');
  toets('sleutel: vulwoorden weg', m.vraagSleutel('Wat is het kenteken van de leaseauto?') === m.vraagSleutel('kenteken leaseauto'), m.vraagSleutel('Wat is het kenteken van de leaseauto?'));
  toets('sleutel: volgorde telt (r1 MOET 1)', m.vraagSleutel('schuld van Jan aan Piet') !== m.vraagSleutel('schuld van Piet aan Jan'));
  toets('sleutel: ontkenning blijft', m.vraagSleutel('nummer apotheek niet de HAP') !== m.vraagSleutel('nummer apotheek de HAP'));
  toets('sleutel: alleen vulwoorden = null', m.vraagSleutel('wat is het?') === null);

  // ── gekozen ──
  const anker = { regel: '| Kenteken | AB-123-C |', kop: '# Auto › ## Lease', nr: 7 };
  const basis = { vraag: 'Wat is het kenteken van de leaseauto?', waarde: 'AB-123-C', label: 'Kenteken', pad: '20_Prive/Auto.md', laag: 'tekstindex', soort: 'antwoord', anker: anker };
  toets('gekozen: feitenlijst-antwoord leert niet (al snel)', m.gekozen(Object.assign({}, basis, { laag: 'identifier' })).reden === 'al snel');
  toets('gekozen: Contacten leert niet', m.gekozen(Object.assign({}, basis, { laag: 'contacten' })).reden === 'al snel');
  toets('gekozen: geen antwoord', m.gekozen(Object.assign({}, basis, { soort: 'geen' })).ok === false);
  toets('gekozen: zonder anker niet', m.gekozen(Object.assign({}, basis, { anker: null })).reden === 'geen bronanker');
  toets('gekozen: pad buiten Zakelijk/Privé niet', m.gekozen(Object.assign({}, basis, { pad: '00_Systeem/x.md' })).reden === 'geen vaultbron');
  toets('gekozen: pad met .. niet', m.gekozen(Object.assign({}, basis, { pad: '20_Prive/../00_Systeem/x.md' })).reden === 'geen vaultbron');
  const g1 = m.gekozen(basis);
  toets('gekozen: model-antwoord → voorgesteld', g1.ok && g1.status === 'voorgesteld' && g1.nieuw, g1);
  const g2 = m.gekozen(Object.assign({}, basis, { vraag: 'kenteken leaseauto', laag: 'volledig' }));
  toets('gekozen: zelfde vraag + waarde = zelfde paar (keer 2)', g2.ok && !g2.nieuw && m._lees().paren.length === 1 && m._lees().paren[0].keer === 2, m._lees());
  m.gekozen(Object.assign({}, basis, { waarde: 'Lease BV', label: 'Leasemaatschappij', anker: { regel: '| Lease | Lease BV |', kop: '# Auto › ## Lease' } }));
  toets('gekozen: tweede waarde bij hetzelfde paar', m._lees().paren[0].waarden.length === 2);
  const st = fs.statSync(path.join(W, 'a.json'));
  toets('opslag 0600', (st.mode & 0o777) === 0o600, (st.mode & 0o777).toString(8));
  m.gekozen(Object.assign({}, basis, { vraag: 'btw-nummer tolgaarde', waarde: 'NL000000000B01', label: 'Btw', pad: '10_Zakelijk/Tolgaarde/index.md', anker: { regel: '| BTW | NL000000000B01 |', kop: '# Tolgaarde' } }));
  toets('geleerd: voorgesteld telt nog niet', m.geleerd('kenteken leaseauto') === null);

  // ── kaart ──
  const k1 = m.kaart({});
  toets('kaart: gezet met 2 stappen + 3 knopregels', k1.kaart && k1.kaart.stappen.length === 5 && k1.bevries.stappen.length === 2, k1);
  toets('kaart: sleutel per ISO-week', k1.kaart && k1.kaart.sleutel === 'zoek-snel-leer-2026-48', k1.kaart && k1.kaart.sleutel);
  toets('kaart: besluit, titel eindigt op ?, ≤ 90 tekens', k1.kaart.soort === 'besluit' && /\?$/.test(k1.kaart.titel) && k1.kaart.titel.length <= 90, k1.kaart.titel);
  toets('kaart: waarom ≤ 400', k1.kaart.waarom.length <= 400, k1.kaart.waarom.length);
  toets('kaart: stap noemt vraag, waarde en pagina (geen pad)', /"Wat is het kenteken van de leaseauto\?" → Kenteken: AB-123-C · Leasemaatschappij: Lease BV \(Auto\)/.test(k1.kaart.stappen[0]) && !/20_Prive/.test(k1.kaart.stappen.join(' ')), k1.kaart.stappen[0]);
  m.kaartGezet(k1.bevries);
  toets('kaart: zelfde week niet nog eens', m.kaart({}).reden === 'deze week al een kaart');
  klok += 7 * 86400000;
  toets('kaart: volgende week niet zolang de vorige open staat', m.kaart({ 'zoek-snel-leer-2026-48': 'open' }).reden === 'er staat nog een Zoek snel-kaart open');
  klok -= 7 * 86400000;

  // ── knop ──
  toets('knop: andere sleutel = null', m.knop('herinnering-0123456789', 'ja') === null && m.knop('zoek-snel-leer-2026-47', 'ja') === null);
  const kj = m.knop('zoek-snel-leer-2026-48', 'ja');
  toets('knop Ja: context zonder waarden', kj && /David zei Ja/.test(kj.context) && !/AB-123-C/.test(kj.context), kj && kj.context);
  toets('knop Ja: telt pas bij de start', m.geleerd('kenteken leaseauto') === null);
  kj.bijStart();
  const gl = m.geleerd('Wat is het kenteken van de leaseauto');
  toets('knop Ja: bevestigd, geleerd geeft waarden + anker', gl && gl.waarden.length === 2 && gl.waarden[0].anker.regel === anker.regel && gl.pad === '20_Prive/Auto.md', gl);
  toets('knop Ja: andere stap ook bevestigd', !!m.geleerd('btw-nummer tolgaarde'));
  kj.bijVerval();
  toets('knop verval: terug naar voorgesteld', m.geleerd('kenteken leaseauto') === null && m._lees().paren.every(function (p) { return p.status === 'voorgesteld'; }), m._lees().paren.map(function (p) { return p.status; }));
  const ka = m.knop('zoek-snel-leer-2026-48', 'anders', 'zonder 2');
  toets('knop Anders "zonder 2": context noemt nummer', ka && /nummer\(s\) 2/.test(ka.context), ka && ka.context);
  ka.bijStart();
  toets('knop Anders: 1 bevestigd, 2 in rust', !!m.geleerd('kenteken leaseauto') && m.geleerd('btw-nummer tolgaarde') === null && m._lees().paren[1].status === 'rust', m._lees().paren.map(function (p) { return p.status; }));
  toets('knop: tweede druk op dezelfde kaart doet niets', (function () { const x = m.knop('zoek-snel-leer-2026-48', 'nee'); x.bijStart(); return !!m.geleerd('kenteken leaseauto'); })());

  // Nee en Anders zonder nummers
  const m2 = maak('b.json');
  m2.gekozen(basis); const kb = m2.kaart({}); m2.kaartGezet(kb.bevries);
  const kn = m2.knop(kb.bevries.sleutel, 'anders', 'liever niet nu');
  toets('knop Anders zonder nummers: niets onthouden', /niets vastzetten|onthoudt niets/.test(kn.context), kn.context);
  kn.bijStart();
  toets('knop Anders zonder nummers: paar blijft voorgesteld, vrij voor een volgende kaart', m2._lees().paren[0].status === 'voorgesteld' && !m2._lees().paren[0].kaart, m2._lees().paren[0]);
  klok += 7 * 86400000;
  const kb2 = m2.kaart({ [kb.bevries.sleutel]: 'gedaan' });
  toets('kaart: volgende week komt het paar terug', kb2.kaart && kb2.bevries.stappen.length === 1, kb2);
  m2.kaartGezet(kb2.bevries);
  const kn2 = m2.knop(kb2.bevries.sleutel, 'nee'); kn2.bijStart();
  toets('knop Nee: rust 28 d', m2._lees().paren[0].status === 'rust' && m2._lees().paren[0].rust_tot === klok + 28 * 86400000);
  klok += 7 * 86400000;
  toets('rust: binnen 28 d geen kaart', m2.kaart({}).reden === 'niets te leren');
  klok += 28 * 86400000;
  toets('rust: na 28 d weer op de kaart', !!m2.kaart({}).kaart);

  // gewijzigd na de kaart
  const m3 = maak('c.json');
  m3.gekozen(basis); const kc = m3.kaart({}); m3.kaartGezet(kc.bevries);
  m3.gekozen(Object.assign({}, basis, { waarde: 'XY-999-Z', anker: { regel: '| Kenteken | XY-999-Z |', kop: '# Auto' } }));
  const kcj = m3.knop(kc.bevries.sleutel, 'ja'); kcj.bijStart();
  toets('knop Ja: paar dat na de kaart veranderde wordt niet bevestigd', m3.geleerd('kenteken leaseauto') === null && m3._lees().paren[0].status === 'voorgesteld', m3._lees().paren[0]);
  // weg
  const m4 = maak('d.json');
  m4.gekozen(basis); const kd = m4.kaart({}); m4.kaartGezet(kd.bevries); m4.knop(kd.bevries.sleutel, 'ja').bijStart();
  const id4 = m4.geleerd('kenteken leaseauto').id;
  toets('weg: bevestigd → verdwenen', m4.weg(id4) === true && m4.geleerd('kenteken leaseauto') === null && m4._lees().paren[0].status === 'verdwenen');
  m4.gekozen(basis);
  toets('weg: nieuwe tik = weer voorgesteld', m4._lees().paren[0].status === 'voorgesteld');
  // kapot bestand
  fs.writeFileSync(path.join(W, 'kapot.json'), '{kapot');
  const mk = maak('kapot.json');
  let gooit = false; try { mk.gekozen(basis); } catch (e) { gooit = true; }
  toets('kapot bestand: fout, nooit stil leeg overschrijven', gooit && fs.readFileSync(path.join(W, 'kapot.json'), 'utf8') === '{kapot');
  toets('kapot bestand: geleerd = null (gewoon zoeken)', mk.geleerd('kenteken leaseauto') === null);
  // ≤ 12 stappen
  const m5 = maak('e.json');
  for (let i = 0; i < 15; i++) m5.gekozen(Object.assign({}, basis, { vraag: 'kenteken auto nummer ' + (i + 1), waarde: 'AA-' + (100 + i) + '-B', anker: { regel: 'r' + i, kop: '' } }));
  const k5 = m5.kaart({});
  toets('kaart: hooguit 12 stappen, rest genoemd', k5.bevries.stappen.length === 12 && /Nog 3 volgen/.test(k5.kaart.waarom), k5.kaart && k5.kaart.waarom);

  // ── laag 0 in zoek-snel.js ──
  const VAULT = path.join(W, 'vault');
  const zet = function (rel, t) { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  zet('00_Systeem/Woordenlijst.md', '# Woordenlijst\n');
  zet('10_Zakelijk/Relaties/Banken.md', ['---', 'updated: 2026-11-20', '---', '# Banken', '', '## Organisatie Alfa', '### Rekening', '| IBAN | NL91 TEST 0417 1643 00 |', '',
    '## Organisatie Beta', '### Rekening', '| IBAN | NL20 TEST 0123 4567 89 |', '| Vorige IBAN | NL55 TEST 9999 8888 77 |', ''].join('\n'));
  let aanroepen = 0, weg = [];
  const nep = async function () { aanroepen++; return { ok: true, data: { soort: 'geen', tekst: '', waarden: [], bronnen: [] } }; };
  const ml = maak('z.json');
  const z = Z.maak({ vault: VAULT, claude: nep, geleerd: function (v) { return ml.geleerd(v); }, geleerdWeg: function (id) { weg.push(id); ml.weg(id); } });
  const an = z.bronAnker('10_Zakelijk/Relaties/Banken.md', 'NL91 TEST 0417 1643 00');
  toets('bronAnker: regel + hele koppenstructuur', an && an.regel === '| IBAN | NL91 TEST 0417 1643 00 |' && an.kop === '# Banken › ## Organisatie Alfa › ### Rekening' && an.nr === 8, an);
  toets('bronAnker: waarde met eindwoord op de regel = geen anker', z.bronAnker('10_Zakelijk/Relaties/Banken.md', 'NL55 TEST 9999 8888 77') === null);
  toets('bronAnker: niet op de pagina = null', z.bronAnker('10_Zakelijk/Relaties/Banken.md', 'NL00 NIET 0000 0000 00') === null);
  toets('bronAnker: pad buiten de wortels = null', z.bronAnker('00_Systeem/Woordenlijst.md', 'Woordenlijst') === null);
  ml.gekozen({ vraag: 'iban organisatie alfa', waarde: 'NL91 TEST 0417 1643 00', label: 'IBAN', pad: '10_Zakelijk/Relaties/Banken.md', laag: 'volledig', soort: 'antwoord', anker: an });
  const kz = ml.kaart({}); ml.kaartGezet(kz.bevries); ml.knop(kz.bevries.sleutel, 'ja').bijStart();
  const t0 = process.hrtime.bigint();
  const r = await z.zoek('Wat is de IBAN van Organisatie Alfa?');
  const ms0 = Number(process.hrtime.bigint() - t0) / 1e6;
  toets('laag 0: antwoord zonder model', r.soort === 'antwoord' && r.laag === 'geleerd' && aanroepen === 0, { soort: r.soort, laag: r.laag, aanroepen: aanroepen });
  toets('laag 0: waarde, bron op de regel', r.waarden && r.waarden[0].waarde === 'NL91 TEST 0417 1643 00' && r.bronnen[0].pad === '10_Zakelijk/Relaties/Banken.md' && r.bronnen[0].nr === 8, r.bronnen);
  const dagJa = new Date(klok).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }).split('-').reverse().join('-');
  toets('laag 0: conclusie "Onthouden antwoord (je zei Ja op …)"', r.conclusie === 'Onthouden antwoord (je zei Ja op ' + dagJa + ').', r.conclusie);
  toets('laag 0: losse regel "bronpagina net nagekeken"', r.los && /net nagekeken/.test(r.los.dekking_regel || ''), r.los);
  toets('laag 0: queryRun bron_laag = identifier', (Z.queryRunVan(r, { sha: 'a'.repeat(64), metVraag: false }) || {}).bron_laag === 'identifier', Z.queryRunVan(r, { sha: 'a'.repeat(64), metVraag: false }));
  console.log('  (laag 0 gemeten: ' + ms0.toFixed(1) + ' ms)');
  toets('laag 0: binnen 200 ms', ms0 < 200, ms0);
  // de IBAN-regel verhuist naar Organisatie Beta (regel zelf ongewijzigd) → niet gebruiken (r2 MOET 1)
  zet('10_Zakelijk/Relaties/Banken.md', ['---', 'updated: 2026-11-21', '---', '# Banken', '', '## Organisatie Alfa', '### Rekening', '| IBAN | (nieuw, nog niet bekend) |', '',
    '## Organisatie Beta', '### Rekening', '| IBAN | NL91 TEST 0417 1643 00 |', ''].join('\n'));
  const r2 = await z.zoek('Wat is de IBAN van Organisatie Alfa?');
  toets('laag 0: verhuisde regel = niet gebruikt, gewoon gezocht', r2.laag !== 'geleerd' && aanroepen >= 0 && weg.length === 1, { laag: r2.laag, weg: weg.length });
  toets('laag 0: paar staat op verdwenen', ml._lees().paren[0].status === 'verdwenen');
  const r3 = await z.zoek('Wat is de IBAN van Organisatie Alfa?');
  toets('laag 0: daarna niet nog eens geprobeerd', r3.laag !== 'geleerd' && weg.length === 1);
  // regel krijgt een eindwoord
  const ml2 = maak('z2.json');
  zet('20_Prive/Auto.md', '# Auto\n## Lease\n| Kenteken | AB-123-C |\n');
  const z2 = Z.maak({ vault: VAULT, claude: nep, geleerd: function (v) { return ml2.geleerd(v); }, geleerdWeg: function (id) { ml2.weg(id); } });
  ml2.gekozen(Object.assign({}, basis, { anker: z2.bronAnker('20_Prive/Auto.md', 'AB-123-C') }));
  const kz2 = ml2.kaart({}); ml2.kaartGezet(kz2.bevries); ml2.knop(kz2.bevries.sleutel, 'ja').bijStart();
  toets('laag 0: kenteken leaseauto → geleerd', (await z2.zoek('kenteken leaseauto')).laag === 'geleerd');
  toets('laag 0: andere vraagvolgorde/woorden → niet geleerd', (await z2.zoek('leaseauto kenteken')).laag !== 'geleerd');
  zet('20_Prive/Auto.md', '# Auto\n## Lease\n| Kenteken | AB-123-C (verkocht) |\n');
  toets('laag 0: regel gewijzigd (verkocht) → niet gebruikt', (await z2.zoek('kenteken leaseauto')).laag !== 'geleerd');
  // zonder geleerd-functie: zoals vóór wv3743
  const z3 = Z.maak({ vault: VAULT, claude: nep });
  toets('zonder opt.geleerd: geen laag 0', (await z3.zoek('kenteken leaseauto')).laag !== 'geleerd');

  // ── koppeling server.js / uitrol.sh ──
  const S = fs.readFileSync('server.js', 'utf8'), U = fs.readFileSync('uitrol.sh', 'utf8');
  toets('server: dispatch POST /app/zoek-snel/gekozen', /route === 'POST \/app\/zoek-snel\/gekozen'\) return typeof appZoekSnelGekozen === 'function'/.test(S));
  toets('server: glijdroute + teller', /APP_GLIJD_ROUTES\.add\('POST \/app\/zoek-snel\/gekozen'\)/.test(S) && /'zoek-snel-gekozen': \[\]/.test(S));
  toets('server: vraag bij de zoek_id bewaard', /st\.ids\[id\] = \{ t: nu, apparaat: a\.id, p: p, vraag: vraag \}/.test(S));
  toets('server: waarde uit het EIGEN antwoord (j.waarden[i]), bron via bronAnker', /j\.waarden\[i\]/.test(S) && /zoekSnel\.bronAnker\(b\.pad, w\.waarde\)/.test(S));
  toets('server: alleen hetzelfde apparaat binnen 10 min', /e\.apparaat !== a\.id \|\| Date\.now\(\) - e\.t > ZOEK_SNEL_HERHAAL_MS/.test(S));
  toets('server: laag 0 aangesloten', /geleerd: function \(vraag\) \{ return zoekSnelLeer \? zoekSnelLeer\.geleerd\(vraag\) : null; \}/.test(S));
  toets('server: weekkaart in de kaartenronde', /await zoekSnelLeerKaart\(\)/.test(S));
  toets('server: knop vóór de gewone knop, na de markerkaart', S.indexOf('zoekSnelLeer.knop(p.sleutel, keuze, d.toelichting)') > S.indexOf('herinneringen.knop(p.sleutel, keuze)'));
  toets('server: /health alleen aantallen', /leer: zoekSnelLeer \? zoekSnelLeer\.info\(\) : undefined/.test(S));
  toets('uitrol: zoek-snel-leer.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]* zoek-snel-leer\.js"/.test(U));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
JS
