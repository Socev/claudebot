#!/usr/bin/env bash
# Toetst zoek-snel-uitzoek.js ("Zoek het uit" bij een misser, wv3821, besluitenpagina nr 472 = 3C172 deel 2; ontwerp mk-scripts/wv3821/ontwerp.md):
# grenscontrole (r6–r9: deel van een groter getal/bedrag/datum = nee), label uit de bronregel (r4), leesUitkomst, start (reserveren vóór de
# agent, één per vraag per dag, loopt/kaart-open/al-vandaag/vol-vandaag, weigering geeft vrij, time-out houdt vast, uitrolwacht = later,
# zonder grondwet geen agent), afloop (natoets met de echte bronAnker van zoek-snel.js, kaart Gevonden/Niet gevonden binnen de kaartgrenzen,
# dubbele afloop = één kaart, kosten op de kaart), knop (Ja = bevestigd paar → laag 0 zonder model; verval = terug; ankers verlopen = niets;
# Niet gevonden Ja = Socev zoekt verder) en de koppeling in server.js/uitrol.sh (incl. de afloop-haak in een nagebootste jobmap).
# Alles verzonnen, in een wegwerpmap. Gebruik: bash test/zoek-snel-uitzoek.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const U = require('./zoek-snel-uitzoek.js');
const L = require('./zoek-snel-leer.js');
const Z = require('./zoek-snel.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'zoek-snel-uitzoek-'));
let klok = Date.parse('2026-11-23T09:00:00+01:00');
const VAULT = path.join(W, 'vault');
const zet = function (rel, t) { const p = path.join(VAULT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
zet('00_Systeem/Woordenlijst.md', '# Woordenlijst\n');
zet('20_Prive/Verzekeringen.md', ['---', 'updated: 2026-11-20', '---', '# Verzekeringen', '', '## Zorgverzekering — Zilverkruis Proef (polis 11223344)', '- Ingang: 1-1-2026', '', '## Auto', '| Premie per maand | € 1.250,00 |', '| Korting | -€ 50,00 |', ''].join('\n'));
zet('10_Zakelijk/Proefpraktijk/Medewerkers/Ilse Proef.md', ['# Ilse Proef', '', '## Contract', '| Uren per week | 29,00 |', 'status: in dienst (bepaalde tijd 2026-07-01 t/m 2027-06-30)', ''].join('\n'));

(async function () {
  // ── grenscontrole ──
  const G = U.grensOk;
  toets('grens: 29,00 in "| Uren per week | 29,00 |"', G('| Uren per week | 29,00 |', '29,00'));
  toets('grens: 100 niet in 1000', !G('bedrag 1000 euro', '100'));
  toets('grens: 100 niet in 100,50', !G('bedrag 100,50', '100'));
  toets('grens: 50 niet in 100,50 (r7)', !G('bedrag 100,50', '50'));
  toets('grens: 250,00 niet in 1 250,00 (r8)', !G('bedrag 1 250,00', '250,00'));
  toets('grens: € 1.250,00 niet in -€ 1.250,00 (r9)', !G('saldo -€ 1.250,00', '€ 1.250,00'));
  toets('grens: 1.250,00 niet in -€ 1.250,00', !G('saldo -€ 1.250,00', '1.250,00'));
  toets('grens: -100 → 100 nee', !G('verschil -100 euro', '100'));
  toets('grens: € 1.250,00 wel in "bedrag: € 1.250,00."', G('bedrag: € 1.250,00.', '€ 1.250,00'));
  toets('grens: 12-11 niet in 12-11-2026', !G('datum 12-11-2026', '12-11'));
  toets('grens: 13 niet in 13:20', !G('om 13:20 uur', '13'));
  toets('grens: hele datum wel', G('t/m 2027-06-30)', '2027-06-30'));
  toets('grens: lijstteken mag ("- 29,00")', G('- 29,00', '29,00'));
  toets('grens: tekst in woord nee (Zorg in Zorgverzekering)', !G('Zorgverzekering', 'Zorg'));
  toets('grens: tekst als geheel ja', G('## Zorgverzekering — Zilverkruis Proef (polis 11223344)', 'Zilverkruis Proef'));
  toets('grens: tweede voorkomen telt (1000 en 100)', G('1000 en 100', '100'));
  // ── label ──
  toets('label: tabelcel ervoor', U.labelUit('| Uren per week | 29,00 |', '29,00', '') === 'Uren per week', U.labelUit('| Uren per week | 29,00 |', '29,00', ''));
  toets('label: kop zonder # en —', U.labelUit('## Zorgverzekering — Zilverkruis Proef (polis 11223344)', 'Zilverkruis Proef', '') === 'Zorgverzekering', U.labelUit('## Zorgverzekering — Zilverkruis Proef (polis 11223344)', 'Zilverkruis Proef', ''));
  toets('label: niets ervoor → laatste kop', U.labelUit('Zilverkruis Proef', 'Zilverkruis Proef', '# Verzekeringen › ## Zorg') === 'Zorg');
  const lang = U.labelUit('status: in dienst (bepaalde tijd 2026-07-01 t/m 2027-06-30)', '2027-06-30', '');
  toets('label: ≤ 40 tekens, uit de regel', lang.length <= 40 && /t\/m$/.test(lang), lang);
  const lang2 = U.labelUit('- **Ilse** (klantnr. 123) en **Bas** (456): Zilverkruis Proef polis € 10', 'Zilverkruis Proef polis', '# Verzekeringen › ## Zorgverzekering — Zilverkruis (polis 1)');
  toets('label: lange zin ervoor → laatste kop tot "—"', lang2 === 'Zorgverzekering', lang2);
  // ── leesUitkomst ──
  toets('lees: geldig', U.leesUitkomst('{"gevonden":true,"waarden":[{"waarde":" 29,00 "}],"pad":"10_Zakelijk/x.md"}').waarden[0] === '29,00');
  toets('lees: geen json = null', U.leesUitkomst('NIETS') === null);
  toets('lees: zonder gevonden = null', U.leesUitkomst('{"waarden":[]}') === null);
  toets('lees: hooguit 5 waarden, ≤ 120 tekens', U.leesUitkomst(JSON.stringify({ gevonden: true, pad: 'a', waarden: [1, 2, 3, 4, 5, 6, 7].map(function (i) { return { waarde: i === 2 ? 'x'.repeat(121) : 'w' + i }; }) })).waarden.join(',') === 'w1,w3,w4,w5');

  // ── module met nep-agent en nep-kaart ──
  const z = Z.maak({ vault: VAULT, claude: async function () { return { ok: true, data: { soort: 'geen', tekst: '', waarden: [], bronnen: [] } }; } });
  const leer = L.maak({ bestand: path.join(W, 'geleerd.json'), nu: function () { return klok; } });
  let starts = [], kaarten = [], antwoord = { ok: true, job_id: 'aaaaaaaaaaaaaaaa' }, uitrol = false, grondwet = 'GRONDWET-KERN v1 — proef';
  const maak = function (naam) {
    return U.maak({ bestand: path.join(W, naam), nu: function () { return klok; }, vraagSleutel: leer.vraagSleutel,
      bronAnker: z.bronAnker, ankerKlopt: z.ankerKlopt, grondwet: function () { return grondwet; }, uitrolWacht: function () { return uitrol; }, leer: leer,
      startAgent: async function (p, ref) { starts.push({ p: p, ref: ref }); return typeof antwoord === 'function' ? antwoord() : antwoord; },
      zetKaart: async function (k) { kaarten.push(k); return { sleutel: k.sleutel }; } });
  };
  const m = maak('u.json');
  const s1 = await m.start('Welke zorgverzekering heb ik?');
  toets('start: gestart', s1.stand === 'gestart' && starts.length === 1, s1);
  toets('start: opdracht = grondwet vooraan + vraag als gegeven', starts[0].p.indexOf('GRONDWET-KERN v1') === 0 && /DAVIDS VRAAG \(gegeven\): "Welke zorgverzekering heb ik\?"/.test(starts[0].p) && /exact: NIETS/.test(starts[0].p));
  toets('start: ref = 12 hex en record loopt', U.REF_RE.test(starts[0].ref) && m._lees().tochten[0].status === 'loopt' && m._lees().tochten[0].job_id === 'aaaaaaaaaaaaaaaa');
  toets('start: tweede tik = loopt, geen tweede agent', (await m.start('welke zorgverzekering heb ik')).stand === 'loopt' && starts.length === 1);
  toets('start: andere vraag mag', (await m.start('Hoeveel uur werkt Ilse Proef?')).stand === 'gestart' && starts.length === 2);
  // reserveren vóór de agent (r1 MOET 3)
  let tijdensStart = null;
  antwoord = function () { tijdensStart = m._lees().tochten.find(function (x) { return /kenteken/.test(x.vraag); }); return { ok: true, job_id: 'b'.repeat(16) }; };
  await m.start('kenteken van de auto');
  toets('start: record staat al op schijf tijdens de agentstart', tijdensStart && tijdensStart.status === 'start');
  antwoord = { ok: false, status: 429 };
  const s4 = await m.start('telefoon van de garage');
  toets('start: 429 = vol, plek vrij', s4.stand === 'vol' && !m._lees().tochten.some(function (x) { return /garage/.test(x.vraag); }), s4);
  antwoord = { ok: false, status: 0 };
  const s5 = await m.start('adres van de bakker');
  toets('start: time-out = loopt (onbekend), record vast', s5.stand === 'loopt' && m._lees().tochten.find(function (x) { return /bakker/.test(x.vraag); }).status === 'onbekend', s5);
  const n5 = starts.length;
  toets('start: na time-out geen tweede start vandaag', (await m.start('adres van de bakker')).stand === 'al-vandaag' && starts.length === n5);
  antwoord = { ok: true, job_id: 'c'.repeat(16) };
  uitrol = true;
  toets('start: uitrolwacht = later, niets gestart', (await m.start('nummer van de tandarts')).stand === 'later' && starts.length === n5);
  uitrol = false;
  grondwet = null;
  toets('start: zonder grondwet-blok geen agent', (await m.start('nummer van de tandarts')).stand === 'fout' && starts.length === n5);
  grondwet = 'GRONDWET-KERN v1 — proef';
  toets('start: alleen vulwoorden = geen-vraag', (await m.start('wat is het?')).stand === 'geen-vraag');
  // plafond per dag
  const mv = maak('vol.json');
  for (let i = 0; i < U.MAX_PER_DAG; i++) await mv.start('proefvraag nummer ' + i);
  toets('start: plafond per dag', (await mv.start('nog een proefvraag')).stand === 'vol-vandaag');

  // ── afloop ──
  const ref1 = starts[0].ref;
  const a1 = await m.afloop(ref1, { ok: true, inhoud: JSON.stringify({ gevonden: true, waarden: [{ waarde: 'Zilverkruis Proef' }, { waarde: '1122' }, { waarde: 'Niet Bestaand BV' }], pad: '20_Prive/Verzekeringen.md' }),
    verbruik: { usd_lijst: 0.0412, in: 1000, uit: 200 }, ms: 31000, job_id: 'a'.repeat(16) });
  toets('afloop: kaart gezet, alleen de verankerde waarde', a1.kaart && a1.soort === 'gevonden' && a1.waarden === 1 && a1.weg === 2, a1);
  const k1 = kaarten[0];
  toets('kaart: besluit, sleutel volgens patroon en DB-regex', k1.soort === 'besluit' && U.SLEUTEL_RE.test(k1.sleutel) && /^[a-z0-9][a-z0-9-]{1,60}$/.test(k1.sleutel), k1.sleutel);
  toets('kaart: titel ≤ 90 en "— onthouden?"', k1.titel.length <= 90 && /^Gevonden: .* — onthouden\?$/.test(k1.titel), k1.titel);
  toets('kaart: waarom ≤ 400, met pagina, kop en kosten', k1.waarom.length <= 400 && /Verzekeringen/.test(k1.waarom) && /Zilverkruis/.test(k1.waarom) && /31 s, ± \$0,04/.test(k1.waarom), k1.waarom);
  toets('kaart: label uit de bron, waarde in backticks; geen modeltekst', k1.stappen[0] === 'Zorgverzekering: `Zilverkruis Proef`' && !JSON.stringify(k1).includes('Niet Bestaand') && !JSON.stringify(k1).includes('1122'), k1.stappen);
  toets('kaart: ≤ 12 stappen, Ja/Nee', k1.stappen.length <= 12 && k1.stappen.includes('Ja: onthouden.') && k1.stappen.includes('Nee: niet onthouden.'));
  toets('kaart: waar overal, prive, herkomst', k1.waar === 'overal' && k1.prive === true && k1.herkomst && k1.herkomst.handmatig === 'zoek-snel');
  const a1b = await m.afloop(ref1, { ok: true, inhoud: '{"gevonden":false,"waarden":[],"pad":null}' });
  toets('afloop: tweede keer = al verwerkt, geen tweede kaart', a1b.reden === 'al verwerkt' && kaarten.length === 1);
  toets('start: kaart open = kaart-open (geen nieuwe zoektocht)', (await m.start('Welke zorgverzekering heb ik?')).stand === 'kaart-open');
  // niet gevonden / mislukt / genoemd maar niet letterlijk
  const ref2 = starts[1].ref;
  const a2 = await m.afloop(ref2, { ok: true, inhoud: JSON.stringify({ gevonden: true, waarden: [{ waarde: '30,00' }], pad: '10_Zakelijk/Proefpraktijk/Medewerkers/Ilse Proef.md' }) });
  const k2 = kaarten[1];
  toets('afloop: waarde staat er niet → Niet gevonden, paginanaam zonder waarde', a2.soort === 'niet' && /^Niet gevonden: .* — verder laten zoeken\?$/.test(k2.titel) && /Ilse Proef/.test(k2.waarom) && !/30,00/.test(JSON.stringify(k2)), k2);
  const refB = m._lees().tochten.find(function (x) { return /bakker/.test(x.vraag); }).ref;
  const a3 = await m.afloop(refB, { ok: false, inhoud: null });
  toets('afloop: mislukt = eerlijk op de kaart', a3.mislukt && /liep niet goed af/.test(kaarten[2].waarom), kaarten[2] && kaarten[2].waarom);
  toets('afloop: onbekende ref', (await m.afloop('ffffffffffff', { ok: true, inhoud: '{}' })).reden === 'onbekend');
  const refK = m._lees().tochten.find(function (x) { return /kenteken/.test(x.vraag); }).ref;
  const a4 = await m.afloop(refK, { ok: true, inhoud: JSON.stringify({ gevonden: true, waarden: [{ waarde: 'Zorgverzekering' }], pad: '00_Systeem/Woordenlijst.md' }) });
  toets('afloop: pad buiten Zakelijk/Privé = niet gevonden', a4.soort === 'niet' && !/Woordenlijst/.test(kaarten[3].waarom), kaarten[3] && kaarten[3].waarom);
  // kaart zetten mislukt
  const mf = U.maak({ bestand: path.join(W, 'f.json'), nu: function () { return klok; }, vraagSleutel: leer.vraagSleutel, bronAnker: z.bronAnker, ankerKlopt: z.ankerKlopt,
    grondwet: function () { return grondwet; }, leer: leer, startAgent: async function () { return { ok: true, job_id: 'd'.repeat(16) }; }, zetKaart: async function () { throw new Error('db weg'); } });
  await mf.start('proef kaart faalt');
  const af = await mf.afloop(mf._lees().tochten[0].ref, { ok: true, inhoud: '{"gevonden":false,"waarden":[],"pad":null}' });
  toets('afloop: kaart mislukt = status kaart-mislukt, geen gooi', af.kaart === null && mf._lees().tochten[0].status === 'kaart-mislukt');

  // ── knop ──
  toets('knop: vreemde sleutel = null', m.knop('zoek-snel-leer-2026-48', 'ja') === null && m.knop('zoek-snel-uit-0123456789-20261123', 'ja') === null);
  const kn = m.knop(k1.sleutel, 'ja');
  toets('knop Ja: vaste zin, geen waarde voor Socev', kn && /onthoudt dit antwoord zelf/.test(kn.context) && !/Zilverkruis/.test(kn.context), kn && kn.context);
  kn.bijStart();
  toets('knop Ja: paar bevestigd in laag 0-opslag', (leer.geleerd('Welke zorgverzekering heb ik?') || {}).pad === '20_Prive/Verzekeringen.md');
  const zl = Z.maak({ vault: VAULT, claude: async function () { throw new Error('model mag niet'); }, geleerd: function (v) { return leer.geleerd(v); }, geleerdWeg: function (id) { leer.weg(id); } });
  const r0 = await zl.zoek('Welke zorgverzekering heb ik?');
  toets('laag 0: zelfde vraag → antwoord zonder model', r0.soort === 'antwoord' && r0.laag === 'geleerd' && r0.waarden[0].waarde === 'Zilverkruis Proef', { soort: r0.soort, laag: r0.laag });
  toets('knop: keuze staat vast; tweede druk doet niets', m._lees().tochten.find(function (x) { return x.kaart === k1.sleutel; }).keuze === 'ja');
  kn.bijVerval();
  toets('knop verval: paar weer weg, keuze terug', leer.geleerd('Welke zorgverzekering heb ik?') === null && !m._lees().tochten.find(function (x) { return x.kaart === k1.sleutel; }).keuze);
  // ankers verlopen tussen kaart en Ja
  zet('20_Prive/Verzekeringen.md', '# Verzekeringen\n\n## Zorgverzekering — Ander Fonds\n');
  const kn2 = m.knop(k1.sleutel, 'ja');
  toets('knop Ja, regel gewijzigd: niets onthouden, zegt dat', /staat niet meer zo op de pagina/.test(kn2.context));
  kn2.bijStart();
  toets('knop Ja verlopen: geen paar', leer.geleerd('Welke zorgverzekering heb ik?') === null);
  const knn = m.knop(k2.sleutel, 'ja');
  toets('knop Niet gevonden Ja: Socev zoekt verder (mail/agenda), vraag als gegeven', /verder zoekt: mail, agenda, contacten/.test(knn.context) && /dit is zijn vraag, gegeven/.test(knn.context), knn.context);
  toets('knop Niet gevonden Nee: laat maar', /laat maar/.test(m.knop(k2.sleutel, 'nee').context));

  // kapot bestand
  fs.writeFileSync(path.join(W, 'kapot.json'), '{kapot');
  const mk = maak('kapot.json');
  let gooit = false; try { await mk.start('iets nieuws'); } catch (e) { gooit = true; }
  toets('kapot bestand: fout, nooit stil leeg overschrijven', gooit && fs.readFileSync(path.join(W, 'kapot.json'), 'utf8') === '{kapot');
  toets('info: alleen getallen', (function () { const i = m.info(); return typeof i.tochten === 'number' && typeof i.usd_vandaag === 'number' && !JSON.stringify(i).includes('zorgverzekering'); })(), m.info());

  // ── koppeling server.js / uitrol.sh ──
  const S = fs.readFileSync('server.js', 'utf8'), Ut = fs.readFileSync('uitrol.sh', 'utf8');
  toets('server: dispatch POST /app/zoek-snel/uitzoeken', /route === 'POST \/app\/zoek-snel\/uitzoeken'\) return typeof appZoekSnelUitzoeken === 'function'/.test(S));
  toets('server: glijdroute + teller', /APP_GLIJD_ROUTES\.add\('POST \/app\/zoek-snel\/uitzoeken'\)/.test(S) && /'zoek-snel-uitzoeken': \[\]/.test(S));
  toets('server: alleen na soort geen, zelfde apparaat, ≤ 10 min', /r\.j\.soort !== 'geen'/.test(S) && /appZoekSnelUitzoeken[\s\S]{0,1500}e\.apparaat !== a\.id \|\| Date\.now\(\) - e\.t > ZOEK_SNEL_HERHAAL_MS/.test(S));
  toets('server: /agent aanvaardt intern_stil alleen zonder smalle sleutel en met vast label', /STIL_LABEL = \{ 'zoek-snel-uitzoek': 'socev: Zoek het uit', 'wachter-voorwerk': 'socev: Wachter voorwerk' \}/.test(S) && /if \(smal \|\| !Object\.hasOwn\(STIL_LABEL, String\(d\.intern_stil\)\) \|\| !\/\^\[0-9a-f\]\{12\}\$\/\.test\(String\(d\.intern_ref \|\| ''\)\) \|\| label !== STIL_LABEL\[d\.intern_stil\]\)/.test(S));
  toets('server: /agent intern + uitrolwacht = 503', /internStil = String\(d\.intern_stil\)/.test(S) && /intern-ongeldig[\s\S]{0,400}uitrolWacht\(\)\.wacht/.test(S));
  toets('server: processAgent stil voor zoektocht (nooit sendReport)', /const stil = zoekUit \|\| wkVoorwerk \|\| agentStil\(entry\.label, r, r\.files\)/.test(S) && /if \(zoekUit\) \{ zoekUitAfloop\(jobId, entry, r, base\); r\.files = \[\]; \}/.test(S));
  toets('server: wees-afloop ook stil', /const stil = zoekUit \|\| wkVoorwerk \|\| agentStil\(a\.label, r, files\)/.test(S));
  toets('server: kwetsbaar zolang de zoektocht loopt', /if \(a\.intern_stil && \(a\.status === 'pending' \|\| a\.status === 'running'\)\) return 'stil-zoektocht'/.test(S));
  toets('server: knop aangesloten', S.indexOf('zoekSnelUitzoek.knop(p.sleutel, keuze)') > S.indexOf('zoekSnelLeer.knop(p.sleutel, keuze, d.toelichting)'));
  toets('server: kaart alleen door het sleutelmasker', /zetKaart: async function \(k\) \{\s*const m = function \(t\) \{ return appSleutelMasker\(String\(t\)\); \}/.test(S) && !/zetKaart[\s\S]{0,300}appBsnMasker/.test(S));
  toets('server: Sonnet, smal (geen API_SECRET-omgeving: label socev:)', /ZOEK_UIT_LABEL = 'socev: Zoek het uit', ZOEK_UIT_MODEL = process\.env\.ZOEK_UIT_MODEL \|\| 'claude-sonnet-5-5'/.test(S));
  toets('server: /health uitzoek', /uitzoek: typeof zoekSnelUitzoek !== 'undefined' && zoekSnelUitzoek \? zoekSnelUitzoek\.info\(\) : undefined/.test(S));
  toets('uitrol: zoek-snel-uitzoek.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bzoek-snel-uitzoek\.js\b/.test(Ut));
  // de afloop-haak zelf, geknipt uit server.js, op een nagebootste jobmap
  const knip = S.slice(S.indexOf('function zoekUitAfloop('), S.indexOf('async function appZoekSnelUitzoeken('));
  const job = path.join(W, 'io', 'job1'); fs.mkdirSync(path.join(job, 'out'), { recursive: true });
  fs.writeFileSync(path.join(job, 'zoek-uit.json'), '{"gevonden":false,"waarden":[],"pad":null}');
  fs.writeFileSync(path.join(job, 'out', 'per-ongeluk.txt'), 'x');
  const gezien = [], logs = [];
  const ctx = { fs: fs, path: path, Date: Date, logError: function (l, e) { logs.push(l + ': ' + e.message); }, schrijfLog: function (t) { logs.push(t); }, nu: function () { return 'nu'; },
    velden: function (v) { return JSON.stringify(v); }, zoekSnelUitzoek: { afloop: async function (ref, info) { gezien.push({ ref: ref, info: info }); return { kaart: 'k', soort: 'niet', waarden: 0 }; } } };
  vm.createContext(ctx); vm.runInContext(knip + '\nthis.f = zoekUitAfloop;', ctx);
  ctx.f('job1', { intern_ref: 'abcdefabcdef', started: Date.now() - 5000 }, { ok: true, verbruik: { usd_lijst: 0.01 } }, job);
  await new Promise(function (k) { setTimeout(k, 20); });
  toets('haak: leest zoek-uit.json uit de jobmap, met ref en verbruik', gezien.length === 1 && gezien[0].ref === 'abcdefabcdef' && /"gevonden":false/.test(gezien[0].info.inhoud) && gezien[0].info.verbruik.usd_lijst === 0.01, gezien);
  toets('haak: OUTDIR geleegd (niets naar app-bestanden)', fs.readdirSync(path.join(job, 'out')).length === 0);
  const ctx2 = Object.assign({}, ctx); delete ctx2.zoekSnelUitzoek; ctx2.zoekSnelUitzoek = null;
  vm.createContext(ctx2); vm.runInContext(knip + '\nthis.f = zoekUitAfloop;', ctx2);
  ctx2.f('job2', { intern_ref: 'abcdefabcdef' }, { ok: true }, path.join(W, 'io', 'job2'));
  toets('haak: zonder module alleen een logregel, gooit niet', logs.some(function (l) { return /afloop zonder module/.test(l); }));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
JS
