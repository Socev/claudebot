#!/usr/bin/env bash
# Toetst pot-app.js (wv1894, OVIS POT fase P1: de leesroutes van de POT-app als pod-module) op een nagebootste D1 `fin` (node:sqlite,
# schema uit test/pot-app-schema.sql, VERZONNEN gegevens: geen echte praktijken, namen, adressen of rekeningnummers).
# Wat: padvorm (padstukken in kleine letters, onbekend = 404, centen voor extra/jaarlast), bundelen (vragen in dezelfde tik = één
# rondgang, ≤ 2 rondgangen per route, batch ≤ 50, een fout raakt de hele batch), alleen SELECT, de databank blijft ongewijzigd, de
# volgorde POT/KM/SLOEL, en een paar uitkomsten per route (betaalanalyse, status per praktijk, rekening-courant, sleutel, voorbeeldmail,
# hartslag). De gelijkheid met de oude Function (werk.socev.dev/pot) is buiten CI gemeten op een kopie van de echte gegevens (vault-
# bouwplan OVIS POT § Log); deze toets bewaakt dat het zo blijft. Raakt geen netwerk, geen pod, geen D1. Gebruik: bash test/pot-app.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const P = require(path.resolve('pot-app.js'));
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }

const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
db.exec(fs.readFileSync('test/pot-app-schema.sql', 'utf8'));
const NU = new Date('2026-10-15T10:00:00Z');
const ins = (t, o) => db.prepare(`insert into ${t} (${Object.keys(o).join(',')}) values (${Object.keys(o).map(() => '?').join(',')})`).run(...Object.values(o));
for (const [code, naam] of [['POT', 'Toets POT bv'], ['KM', 'Toets Kostenmaatschap'], ['SLOEL', 'Toets SLOEL']])
  ins('entiteit', { code, naam, naam_document: naam.toUpperCase(), iban: 'NL00TEST000000000' + code.length, tnv: naam, adres: 'Proefstraat 1', postcode_plaats: '0000 AA Proefstad' });
for (const [id, naam] of [['P01', 'Praktijk Aap'], ['P02', 'Praktijk Noot'], ['P03', 'Praktijk Mies'], ['P07', 'Praktijk Zeven'], ['P09', 'Praktijk Wim']])
  ins('praktijk', { id, naam, naam_brief: naam, tav: 'de maten', adres: 'Laan ' + id, postcode_plaats: '0000 AA Proefstad', email: id.toLowerCase() + '@voorbeeld.test' });
ins('praktijk_naam', { praktijk_id: 'P01', naam: 'Praktijk Aap', iban: 'NL00TEST0000000101', geldig_van: '2020-01-01' });
for (const p of ['P01', 'P02', 'P03']) ins('deelname', { entiteit: 'SLOEL', praktijk_id: p, geldig_van: '2020-01-01' });
for (const p of ['P01', 'P02']) { ins('deelname', { entiteit: 'POT', praktijk_id: p, geldig_van: '2020-01-01' }); ins('deelname', { entiteit: 'KM', praktijk_id: p, geldig_van: '2020-01-01' }); }
for (const [p, a, b] of [['P01', 3000, 3100], ['P02', 2000, 2100], ['P03', 1000, 1000]]) { ins('praktijk_patienten', { praktijk_id: p, peildatum: '2025-01-01', aantal: a, status: 'toets' }); ins('praktijk_patienten', { praktijk_id: p, peildatum: '2026-01-01', aantal: b, status: 'toets' }); }
ins('verdeelsleutel', { entiteit: 'SLOEL', jaar: 2025, praktijk_id: 'P01', soort: 'afrekening', versie: 'vastgesteld', aandeel: 500 });
ins('verdeelsleutel', { entiteit: 'SLOEL', jaar: 2025, praktijk_id: 'P01', soort: 'afrekening', versie: 'hub', aandeel: 510 });
// POT: begroting 2026 per maand; P01 betaalt op schema (10 x 1200), P02 loopt achter (3 x 800)
const bPot = ins('begroting', { entiteit: 'POT', jaar: 2026, versie: 'v1', status: 'vastgesteld', totaal: 24000, termijn: 'maand', gemaakt_op: '2025-12-01',
  grondslag: JSON.stringify({ personeel: [{ naam: 'Verzonnen Persoon', functie: 'POH-GGZ', uren_week: 20, bruto_maand: 3000 }] }) }).lastInsertRowid;
ins('begroting', { entiteit: 'POT', jaar: 2026, versie: 'v0', status: 'concept', totaal: 23000, termijn: 'maand', gemaakt_op: '2025-11-01' });
ins('begroting_regel', { begroting_id: bPot, praktijk_id: 'P01', aandeel: 600, jaarbedrag: 14400, termijnbedrag: 1200 });
ins('begroting_regel', { begroting_id: bPot, praktijk_id: 'P02', aandeel: 400, jaarbedrag: 9600, termijnbedrag: 800 });
let mut = 0;
const bank = (entiteit, boekdatum, bedrag, omschrijving, soort, praktijk_id, boekjaar, tegen) => {
  const id = ins('bankmutatie', { rekening: 'NL00TEST0000000999', entiteit, boekdatum, bedrag, tegenrekening: tegen || 'NL00TEST0000000' + (praktijk_id || 'X99').slice(1).padStart(3, '0'), naam: 'toets', omschrijving, sleutel: 'm' + (++mut), geladen_op: '2026-10-01' }).lastInsertRowid;
  if (soort) ins('bank_toewijzing', { bankmutatie_id: id, soort, praktijk_id, boekjaar, bedrag });
  return id;
};
for (let m = 1; m <= 10; m++) bank('POT', `2026-${String(m).padStart(2, '0')}-05`, 1200, 'voorschot', 'voorschot', 'P01', 2026);
for (let m = 1; m <= 3; m++) bank('POT', `2026-${String(m).padStart(2, '0')}-07`, 800, 'voorschot', 'voorschot', 'P02', 2026);
bank('POT', '2026-06-30', -4000, 'salaris', 'salaris', null, 2026);
bank('POT', '2026-07-01', 12.5, 'rente', null, null, null);   // ongekoppeld
for (let m = 1; m <= 10; m++) ins('dienstverband_maand', { dienstverband_id: 1, entiteit: 'POT', medewerker_id: 1, jaar: 2026, maand: m, in_dienst: 1, uren_week: 20, bruto_maand_contract: 3000 });
// rekening-courant Tolgaarde (P07): 2024 telt niet (afgerond), 2025 en 2026 wel
bank('SLOEL', '2024-05-01', 5000, 'liquiditeit', 'liquiditeit', 'P07', 2024);
bank('SLOEL', '2025-05-01', -2000, 'liquiditeit', 'liquiditeit', 'P07', 2025);
bank('SLOEL', '2026-05-01', 1000, 'liquiditeit', 'liquiditeit', 'P07', 2026);
ins('controlebevinding', { entiteit: 'SLOEL', jaar: 2026, omschrijving: 'toetsbevinding open', status: 'open' });
ins('controlebevinding', { entiteit: 'SLOEL', jaar: 2025, omschrijving: 'toetsbevinding dicht', status: 'afgesloten' });
// SLOEL: plan 2026 vastgesteld (kwartaal), nota's en betalingen
const plan = ins('plan', { entiteit: 'SLOEL', jaar: 2026, versie: 'v1', status: 'vastgesteld', termijn: 'kwartaal', marge_pct: 0, totaal: 12000, sleutel_toelichting: 'stand 1-1-2026', gemaakt_op: '2026-01-02' }).lastInsertRowid;
ins('plan_post', { plan_id: plan, volgorde: 1, omschrijving: 'Huur proefpand', bedrag: 12000, per: 'jaar', aantal: 1, indexatie_pct: 0, jaarbedrag: 12000 });
for (const [p, g] of [['P01', 3100], ['P02', 2100], ['P03', 1000]]) ins('plan_deelnemer', { plan_id: plan, praktijk_id: p, actief: 1, grondslag: g, aandeel: g / 6200, termijnbedrag: Math.round(g / 6200 * 3000) });
const nota = (nummer, praktijk_id, datum, periode, bedrag, status, soort) => ins('nota', { entiteit: 'SLOEL', jaar: 2026, nummer, praktijk_id, datum, soort: soort || 'voorschot', periode, titel: 'DOORBELASTE KOSTEN',
  regels: JSON.stringify([{ omschrijving: 'Doorbelaste huur', bedrag, jaar: 2026 }]), bedrag, status, plan_id: plan }).lastInsertRowid;
const n1 = nota('2026001', 'P01', '2026-01-01', '2026-Q1', 1500, 'definitief');
nota('2026002', 'P02', '2026-01-01', '2026-Q1', 1016, 'definitief');
nota('2026003', 'P03', '2026-01-01', '2026-Q1', 484, 'concept');
nota('2026004', 'P01', '2026-04-01', '2026-Q2', 1500, 'definitief');
nota('2026005', 'P01', '2026-12-01', '2026-Q4', 1500, 'definitief');
const nCredit = nota('2026006', 'P02', '2026-09-01', null, -200, 'definitief', 'correctie');
bank('SLOEL', '2026-01-10', 1500, 'factuur 2026001', 'huur', 'P01', 2026);
bank('SLOEL', '2026-01-20', 1500, 'factuur 2026001 nogmaals', 'huur', 'P01', 2026);   // dubbel
bank('SLOEL', '2026-04-12', 1500, 'huur tweede kwartaal', 'huur', 'P01', 2026);       // op bedrag → 2026004
ins('afrekening', { entiteit: 'SLOEL', jaar: 2025, praktijk_id: 'P01', versie: 'excel-bron', jaarlast_toegerekend: 5000, voorschotten: 4800, saldo: 200, status: 'definitief' });
ins('afrekening', { entiteit: 'SLOEL', jaar: 2025, praktijk_id: 'P01', versie: 'hub-2026-02-01', jaarlast_toegerekend: 5100, voorschotten: 4800, saldo: 300, status: 'concept' });
ins('afrekening', { entiteit: 'SLOEL', jaar: 2025, praktijk_id: 'P02', versie: 'hub-2026-02-01', jaarlast_toegerekend: 3000, voorschotten: 3200, status: 'concept' });
ins('jaarlast', { entiteit: 'SLOEL', jaar: 2025, bedrag: 8100, bron: 'toets' });
ins('nota_verzending', { nota_id: n1, entiteit: 'SLOEL', nummer: '2026001', praktijk_id: 'P01', status: 'concept', niet_voor: '2026-01-01T00:00:00Z', onderwerp: 'o', bericht: 'b', pdf_naam: 'x.pdf', pdf_b64: 'JVBERi0=',
  pdf_sha256: 'a'.repeat(64), pdf_bytes: 5, aangevraagd_op: '2026-01-01T00:00:00Z', bijgewerkt_op: '2026-01-01T00:00:00Z' });
ins('pot_pod_stand', { sleutel: 'auto', waarde: 'aan', op: new Date(NU.getTime() - 5 * 60e3).toISOString() });
const tellingVoor = db.prepare('select total_changes() as n').get().n;

// io: elke batch = één rondgang; alleen SELECT; optioneel een vertraging
const log = [];
let vertraging = 0;
const io = { nu: () => NU, d1: async (batch) => {
  log.push(batch.length);
  for (const x of batch) if (!/^\s*select\b/i.test(x.sql)) throw new Error('toets: niet-SELECT naar D1: ' + x.sql.slice(0, 40));
  if (vertraging) await new Promise((r) => setTimeout(r, vertraging));
  return batch.map((x) => ({ results: db.prepare(x.sql).all(...x.params) }));
} };
const app = P.maak(io);

(async () => {
  // ── padvorm ──
  const o = (p) => P.ontleed(p);
  toets('ontleed overzicht zonder en met jaar', o('overzicht').route === 'overzicht' && o('overzicht/2026').params.jaar === '2026');
  toets('ontleed planning/notas met entiteit (klein) en jaar', o('planning/sloel/2026').params.entiteit === 'sloel' && o('notas/km').params.jaar === undefined);
  toets('ontleed correctie: tot-heden wordt tot_heden', o('correctie/sloel/2026/tot-heden/3/123456').params.modus === 'tot_heden');
  toets('ontleed verzend/voorbeeld/<id>', o('verzend/voorbeeld/12').route === 'verzend/voorbeeld' && o('verzend/voorbeeld/12').params.nota_id === '12');
  for (const p of ['', 'pot', 'overzicht/2026/x', 'kasstroom', 'kasstroom/pot/2026', 'liquiditeit/2026', 'planning', 'correctie/sloel', 'verzend/12', 'verzend/voorbeeld', 'nota/1/status', 'verzend', 'patienten/x'])
    toets('ontleed weigert "' + p + '"', o(p) === null);
  toets('alle routes in ROUTES zijn bereikbaar', P.ROUTES.every((r) => ['overzicht', 'afrekening/2025', 'begroting', 'kasstroom/pot', 'liquiditeit', 'planning/sloel', 'correctie/sloel/2026', 'patienten', 'notas/sloel', 'verzend/voorbeeld/1'].some((x) => (o(x) || {}).route === r)));

  // ── bundelen ──
  {
    const calls = [];
    const b = P.vraagBundel(async (batch) => { calls.push(batch.length); return batch.map(() => ({ results: [{ x: 1 }] })); });
    const r = await Promise.all(Array.from({ length: 120 }, (_, i) => b.vraag('select ' + i, [])));
    toets('120 vragen in één tik → 3 batches (≤ 50) en 120 antwoorden', calls.join(',') === '50,50,20' && r.length === 120 && b.teller.rondgangen === 3 && b.teller.vragen === 120, calls);
    let fout = null; try { await b.vraag('update nota set status=1', []); } catch (e) { fout = e.message; }
    toets('bundel weigert een niet-SELECT', /alleen lezen/.test(fout || ''), fout);
    const kapot = P.vraagBundel(async () => { throw new Error('D1 http 401'); });
    const uit = await Promise.allSettled([kapot.vraag('select 1', []), kapot.vraag('select 2', [])]);
    toets('fout in een batch raakt elke vraag erin', uit.every((x) => x.status === 'rejected' && /401/.test(x.reason.message)));
    const kort = P.vraagBundel(async (batch) => batch.slice(1).map(() => ({ results: [] })));
    const k = await Promise.allSettled([kort.vraag('select 1', []), kort.vraag('select 2', [])]);
    toets('te kort D1-antwoord = fout, geen verkeerde koppeling', k.every((x) => x.status === 'rejected'));
  }

  // ── routes ──
  const lees = async (p) => { log.length = 0; const r = await app.lees(p); return r; };
  const ov = await lees('overzicht/2026');
  toets('overzicht: 200, ≤ 2 rondgangen', ov.status === 200 && ov.j.ok && ov.rondgangen <= 2, { s: ov.status, r: ov.rondgangen, j: ov.j.fout });
  toets('overzicht: entiteiten in de volgorde POT, KM, SLOEL (lopend en liquiditeit)', Object.keys(ov.j.lopend).join() === 'POT,KM,SLOEL' && Object.keys(ov.j.liquiditeit).join() === 'POT,KM,SLOEL');
  const potR = Object.fromEntries(ov.j.lopend.POT.rijen.map((r) => [r.praktijk_id, r]));
  toets('overzicht POT: 10 van 12 maanden verstreken (klok 15-10)', ov.j.lopend.POT.verstreken === 10 && ov.j.lopend.POT.termijn === 'maand');
  toets('overzicht POT: P01 op schema, P02 achter', potR.P01.status === 'op_schema' && potR.P01.verschil === 0 && potR.P02.status === 'achter' && potR.P02.verschil === -5600, potR);
  toets('overzicht POT: personeel uit maand 10, zonder namen', ov.j.lopend.POT.personeel && ov.j.lopend.POT.personeel.maand === 10 && !JSON.stringify(ov.j.lopend.POT).includes('Verzonnen Persoon'));
  toets('overzicht: rekening-courant telt vanaf 2025 (saldo −1000, alle jaren 4000)', ov.j.liquiditeit.SLOEL.saldo === -1000 && ov.j.liquiditeit.SLOEL.saldo_alle_jaren === 4000);
  toets('overzicht: alleen open controlepunten', ov.j.open_punten.length === 1 && ov.j.open_punten[0].omschrijving === 'toetsbevinding open');
  toets('overzicht zonder jaar = jaar van de klok', (await lees('overzicht')).j.jaar === 2026);
  toets('overzicht: jaar ongeldig → 400 met de tekst van de Function', (await lees('overzicht/20x6')).status === 400 && (await lees('overzicht/1999')).j.fout === 'jaar ongeldig');

  const af = await lees('afrekening/2025');
  toets('afrekening: 1 rondgang, getoonde versie = nieuwste hub-<datum>', af.status === 200 && af.rondgangen === 1 && af.j.afrekening.SLOEL.versie === 'hub-2026-02-01', { r: af.rondgangen, v: af.j.afrekening && af.j.afrekening.SLOEL.versie });
  toets('afrekening: vergelijking tussen versies (P01 100 verschil)', af.j.afrekening.SLOEL.vergelijking.rijen.find((r) => r.praktijk_id === 'P01').verschil === 100);
  toets('afrekening zonder jaar = vorig jaar', (await lees('afrekening')).j.jaar === 2025);

  const be = await lees('begroting/2026');
  toets('begroting: 200, ≤ 2 rondgangen, vastgesteld gaat voor concept', be.status === 200 && be.rondgangen <= 2 && be.j.begroting.POT.versie === 'v1' && be.j.begroting.POT.andere_versies.length === 1, { r: be.rondgangen });
  toets('begroting: personeel zonder naam', !JSON.stringify(be.j).includes('Verzonnen Persoon') && be.j.begroting.POT.grondslag.personeel[0].functie === 'POH-GGZ');
  toets('begroting: geen begroting = null', be.j.begroting.KM === null && be.j.begroting.SLOEL === null);

  const ks = await lees('kasstroom/pot');
  toets('kasstroom: 1 rondgang, ongekoppelde rente zichtbaar', ks.status === 200 && ks.rondgangen === 1 && ks.j.entiteit === 'POT' && ks.j.ongekoppeld.length === 1 && ks.j.ongekoppeld[0].bedrag === 12.5);
  toets('kasstroom: onbekende entiteit → 400', (await lees('kasstroom/xx')).j.fout === 'entiteit ongeldig (POT, KM of SLOEL)');
  const lq = await lees('liquiditeit');
  toets('liquiditeit: lopend saldo vanaf 2025', lq.status === 200 && lq.j.liquiditeit.SLOEL.map((r) => r.saldo_na).join() === ',-2000,-1000');
  const pa = await lees('patienten');
  toets('patienten: standen en deelname', pa.status === 200 && pa.j.standen.length === 6 && pa.j.deelname.length === 7);

  const pl = await lees('planning/sloel/2026');
  toets('planning: 200, ≤ 2 rondgangen', pl.status === 200 && pl.rondgangen <= 2, { r: pl.rondgangen, f: pl.j.fout });
  toets('planning: vastgesteld plan met opgeslagen sleutel, termijnbedragen hele euro\'s', pl.j.plannen.length === 1 && pl.j.plannen[0].uitkomst.sleutel.bron === 'plan' && pl.j.plannen[0].uitkomst.sleutel.per.P01.termijnbedrag === 1500);
  toets('planning: in rekening gebracht telt alleen definitieve nota\'s', pl.j.in_rekening.P01.bedrag === 4500 && !pl.j.in_rekening.P03 && pl.j.in_rekening.P02.bedrag === 816);
  toets('planning: volgend nummer en laatste mutatie', pl.j.volgend_nummer === '2026007' && pl.j.vorig.laatste_mutatie === '2026-05-01', { v: pl.j.volgend_nummer, l: pl.j.vorig.laatste_mutatie });
  toets('planning zonder plannen: sjabloon uit vorig jaar (2027 ← 2026)', (await lees('planning/sloel/2027')).j.sjabloon.van === '2026 v1');
  toets('planning: entiteit ongeldig → 400', (await lees('planning/xx/2026')).status === 400);

  const no = await lees('notas/sloel/2026');
  const st = Object.fromEntries(no.j.notas.map((n) => [n.nummer, n.betaal.status]));
  toets('notas: 200, ≤ 2 rondgangen', no.status === 200 && no.rondgangen <= 2, { r: no.rondgangen });
  toets('notas: betaalstatus (dubbel, open, concept, betaald op bedrag, nog niet, terug te betalen)',
    st['2026001'] === 'dubbel' && st['2026002'] === 'open' && st['2026003'] === 'concept' && st['2026004'] === 'betaald' && st['2026005'] === 'nog_niet' && st['2026006'] === 'terug_te_betalen', st);
  toets('notas: dubbel betaald apart, met voorstel', no.j.betaalanalyse.dubbel.length === 1 && no.j.betaalanalyse.dubbel[0].voorstel === 'Terugbetaling dubbel betaalde nota 2026001' && no.j.betaalanalyse.status === undefined);
  toets('notas: laatste verzending per nota, zonder pdf', no.j.notas.find((n) => n.nummer === '2026001').verzending.status === 'concept' && !('pdf_b64' in no.j.notas.find((n) => n.nummer === '2026001').verzending));

  const co = await lees('correctie/sloel/2026/tot-heden/3/123456');
  toets('correctie: 200, ≤ 2 rondgangen, extra in centen → euro\'s', co.status === 200 && co.rondgangen <= 2 && co.j.grondslag.extra === 1234.56 && co.j.grondslag.basis === 10234.56, { r: co.rondgangen, g: co.j.grondslag });
  const ce = await lees('correctie/sloel/2025/eindafrekening/4/geen/810000');
  toets('correctie eindafrekening: jaarlast uit het pad (8100), deelnemers uit deelname', ce.status === 200 && ce.rondgangen <= 2 && ce.j.grondslag.jaarlast === 8100 && ce.j.grondslag.deelnemers_bron === 'deelname', { r: ce.rondgangen, g: ce.j.grondslag });
  toets('correctie eindafrekening zonder jaarlast: uit de databank', (await lees('correctie/sloel/2025/eindafrekening')).j.jaarlast_db.bedrag === 8100);
  toets('correctie: tot_kwartaal 5 → 400', (await lees('correctie/sloel/2026/tot-heden/5')).j.fout === 'tot_kwartaal ongeldig');
  toets('correctie: extra met een punt/letters → 400', (await lees('correctie/sloel/2026/tot-heden/3/12a')).j.fout === 'extra ongeldig');
  toets('correctie: negatieve jaarlast → 400', (await lees('correctie/sloel/2026/eindafrekening/4/geen/-100')).j.fout === 'jaarlast ongeldig');

  const vb = await lees('verzend/voorbeeld/' + n1);
  toets('voorbeeld: SLOEL-tekst, bestandsnaam en adres in de app', vb.status === 200 && vb.rondgangen <= 2 && vb.j.onderwerp === 'Factuur SLOEL - Doorbelaste huur' && vb.j.pdf_naam === 'SLOEL - 2026001 - Praktijk Aap - de maten.pdf' && vb.j.adres_in_app === 'p01@voorbeeld.test', vb.j);
  toets('voorbeeld: verse hartslag → automatisch versturen kan', vb.j.auto.kan === true);
  toets('voorbeeld: creditnota-tekst', (await lees('verzend/voorbeeld/' + nCredit)).j.onderwerp === 'Creditnota SLOEL - Correctie doorbelaste huur 2026');
  db.prepare("update pot_pod_stand set op=? where sleutel='auto'").run(new Date(NU.getTime() - 20 * 60e3).toISOString());
  toets('voorbeeld: hartslag ouder dan 15 min → kan niet', (await lees('verzend/voorbeeld/' + n1)).j.auto.reden === 'automatisch versturen staat nu uit bij Socev');
  const tellingNa0 = db.prepare('select total_changes() as n').get().n;   // (de update hierboven is van de toets zelf)
  toets('voorbeeld: onbekende nota → 404, id 0 → 400', (await lees('verzend/voorbeeld/999')).status === 404 && (await lees('verzend/voorbeeld/0')).j.fout === 'nota_id ongeldig');
  toets('onbekende route → 404 zonder D1', (await lees('nota/1/status')).status === 404 && log.length === 0);

  // ── fouten en tijd ──
  const kapot = P.maak({ nu: () => NU, d1: async () => { throw new Error('D1 http 401'); } });
  const k = await kapot.lees('overzicht/2026');
  toets('D1 onbereikbaar → 500 met de fouttekst (geen uitzondering)', k.status === 500 && /D1 http 401/.test(k.j.fout), k);
  vertraging = 200;
  const t0 = Date.now(); const traag = await lees('overzicht/2026'); const ms = Date.now() - t0;
  toets('met 0,2 s per rondgang: overzicht ≤ 1,5 s (' + ms + ' ms)', traag.status === 200 && ms <= 1500);
  vertraging = 0;
  toets('de databank is door pot-app niet gewijzigd', db.prepare('select total_changes() as n').get().n === tellingNa0 && tellingNa0 === tellingVoor + 1);
  // wv1939: zonder plek in de uitrollijst kwam pot-app.js niet in de release (/health.pot_app.aan=false, 404 op /app/pot)
  toets('uitrol.sh: pot-app.js optioneel in de release', /^RELEASE_OPTIONEEL="[^"]*\bpot-app\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  toets('Dockerfile: pot-app.js in release-bootstrap', /^COPY pot-app\.js \/app\/release-bootstrap\/pot-app\.js$/m.test(fs.readFileSync('Dockerfile', 'utf8')));

  console.log(`\npot-app: ${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error('ROOD  uitzondering', e); process.exit(1); });
JS
