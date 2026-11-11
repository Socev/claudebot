'use strict';
// Toetsen bij voorwerk-2 (wv2916): voorwerk-poort.js (bronbewijs, onderbouwing, gevoeligheidspoort), voorwerk-lees.js (luikgrenzen,
// patiëntpoort op elk antwoord) en mailvoorwerk.js versie 2 (stappen, herschrijfronde, gmail() op de definitieve tekst, plafond).
// ALLES VERZONNEN: geen echte medewerkers, mails, IBAN's of domeinen (.invalid / voorbeeld). Geen netwerk, geen model.
// VW2_DIR wijst naar een kopie (kruisproef in test/voorwerk2.sh); standaard de werkboom.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DIR = process.env.VW2_DIR || path.join(__dirname, '..');
const P = require(path.join(DIR, 'voorwerk-poort.js'));
const L = require(path.join(DIR, 'voorwerk-lees.js'));
const V = require(path.join(DIR, 'mailvoorwerk.js'));

// Verzonnen: medewerker "Petra Proefmans", verwerker "loonproef.invalid", IBAN met geldige vorm (NL-proefnummer)
const IBAN = 'NL91 ABNA 0417 1643 00', IBAN2 = 'NL20 INGB 0001 2345 67';
const VERWERKERS = [{ naam: 'Loonproef', domein: 'loonproef.invalid' }];
function stukkenVan(lijst) { const m = new Map(); lijst.forEach(function (s, i) { const id = 'S' + (i + 1); m.set(id, Object.assign({ id }, s)); }); return m; }
const DOSSIER = { soort: 'dossier', label: '10_Zakelijk/Proef/Medewerkers/Petra Proefmans - assistente.md', gebonden: 'Petra Proefmans', datum: '2026-11-03',
  tekst: 'Petra Proefmans werkt dinsdag en donderdag, schooldag woensdag. Schaal 5, trede 2 per 1 december 2026. IBAN ' + IBAN + '.' };
const VERZAMEL = { soort: 'vault', label: '10_Zakelijk/Proef/Personeelslijst.md', gebonden: null, datum: null,
  tekst: 'Personeel: Petra Proefmans, Kees Kladblok. Kees werkt maandag. Schaal 7, trede 4.' };

test('bronbewijs: verzonnen waarde met echte vindplaats = niet bewezen; ongelezen bron; verzamelstuk telt niet; geldig = bewezen', () => {
  const st = stukkenVan([DOSSIER, VERZAMEL]);
  const r = P.bronbewijs([
    { persoon: 'Petra Proefmans', waarde: 'schaal 5, trede 2', bron: 'S1', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' },
    { persoon: 'Petra Proefmans', waarde: 'schaal 6, trede 3', bron: 'S1', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' },
    { persoon: 'Petra Proefmans', waarde: 'maandag', bron: 'S9', datum_stuk: '', soort: 'persoonsgegeven' },
    { persoon: 'Petra Proefmans', waarde: 'schaal 7, trede 4', bron: 'S2', datum_stuk: '2026-01-01', soort: 'persoonsgegeven' },
    { persoon: '', waarde: 'Kees werkt maandag', bron: 'S2', datum_stuk: '', soort: 'werk' }
  ], st);
  assert.deepEqual(r.bewezen.map(function (f) { return f.waarde; }), ['schaal 5, trede 2', 'Kees werkt maandag']);
  assert.equal(r.bewezen[0].vindplaats, DOSSIER.label, 'vindplaats komt van de pod, niet van het model');
  assert.deepEqual(r.niet_bewezen.map(function (f) { return f.reden; }), ['waarde_niet_in_bron', 'bron_niet_gelezen', 'niet_persoonsgebonden']);
  assert.equal(r.keuzes.length, 0);
});
test('bronbewijs: twee contracten van dezelfde persoon = keuze; persoonsfeit zonder datum = keuze', () => {
  const c1 = { soort: 'contract', label: 'Medewerkers/Arbeidsovereenkomst Petra Proefmans 2025-06-01.pdf', gebonden: 'Arbeidsovereenkomst Petra Proefmans 2025-06-01', datum: '2025-06-01', tekst: 'Schaal 4, trede 1. 16 uur.' };
  const c2 = { soort: 'contract', label: 'Medewerkers/Arbeidsovereenkomst Petra Proefmans 2026-11-03.pdf', gebonden: 'Arbeidsovereenkomst Petra Proefmans 2026-11-03', datum: '2026-11-03', tekst: 'Schaal 5, trede 2. 24 uur.' };
  const r = P.bronbewijs([{ persoon: 'Petra Proefmans', waarde: '24 uur', bron: 'S2', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' }], stukkenVan([c1, c2]));
  assert.equal(r.bewezen.length, 1);
  assert.equal(r.keuzes.length, 1); assert.equal(r.keuzes[0].reden, 'twee_stukken'); assert.match(r.keuzes[0].anders, /2025-06-01/);
  const d = Object.assign({}, DOSSIER, { datum: null });
  const r2 = P.bronbewijs([{ persoon: 'Petra Proefmans', waarde: 'dinsdag en donderdag', bron: 'S1', datum_stuk: '', soort: 'persoonsgegeven' }], stukkenVan([d]));
  assert.equal(r2.bewezen.length, 1); assert.equal(r2.keuzes[0].reden, 'geen_datum');
});
test('bevat: normalisatie van bedrag, datum en IBAN; los getal bewijst niets', () => {
  assert.ok(P.bevat('€ 2345,67', 'loon 2.345,67 euro'));
  assert.ok(P.bevat('1-12-2026', 'per 1 december 2026'));
  assert.ok(P.bevat(IBAN.replace(/ /g, ''), 'rekening ' + IBAN));
  assert.ok(!P.bevat('5', 'schaal 5'));
  assert.ok(!P.bevat('3 december 2026', 'per 1 december 2026'));
  assert.ok(!P.bevat('€ 2.345,68', 'loon 2.345,67 euro'));
});
test('gevoeligheidspoort: IBAN naar onbekend domein dicht, naar verwerker (bewezen) open, lijkend domein dicht, niet bewezen dicht', () => {
  const bewezen = [{ persoon: 'Petra Proefmans', waarde: IBAN, soort: 'persoonsgegeven' }];
  const t = 'Beste,\nHet IBAN van Petra is ' + IBAN + '.\nGroet, David';
  const o = function (aan, bw) { return P.gevoelig(t, { mail: 'Wat is het IBAN van Petra?', aan, verwerkers: VERWERKERS, bewezen: bw, feiten: bewezen }); };
  assert.equal(o('iemand@ander.invalid', bewezen).dicht, true);
  assert.equal(o('iemand@ander.invalid', bewezen).redenen[0].reden, 'geen_verwerker');
  assert.equal(o('loket@loonproef.invalid', bewezen).dicht, false);
  assert.equal(o('loket@loonproef.invalid.evil.invalid', bewezen).dicht, true);
  assert.equal(o('loket@sub.loonproef.invalid', bewezen).dicht, true);
  assert.equal(o('loket@loonpr0ef.invalid', bewezen).dicht, true);
  assert.equal(o('loket@loonproef.invalid', []).redenen[0].reden, 'niet_onderbouwd');
  // ander IBAN dan bewezen (gewijzigd) = dicht
  assert.equal(P.gevoelig('IBAN ' + IBAN2, { aan: 'loket@loonproef.invalid', verwerkers: VERWERKERS, bewezen }).dicht, true);
});
test('gevoeligheidspoort: BSN altijd dicht (ook naar verwerker, ook als het in de mail stond); verzuim en wachtwoord dicht; persoonsgegeven-feit naar onbekend dicht', () => {
  const bsn = '111222333';   // verzonnen, voldoet aan de 11-proef
  assert.equal(P._intern.elfproef(bsn), true);
  const g = P.gevoelig('Haar BSN is ' + bsn, { mail: 'BSN ' + bsn + '?', aan: 'loket@loonproef.invalid', verwerkers: VERWERKERS, bewezen: [{ waarde: bsn }] });
  assert.equal(g.dicht, true); assert.equal(g.redenen[0].soort, 'bsn'); assert.equal(g.redenen[0].reden, 'nooit');
  assert.equal(P.gevoelig('Zij is ziekgemeld sinds maandag.', { aan: 'loket@loonproef.invalid', verwerkers: VERWERKERS }).dicht, true);
  assert.equal(P.gevoelig('Het wachtwoord is Zomer2026', { aan: 'loket@loonproef.invalid', verwerkers: VERWERKERS }).dicht, true);
  const f = [{ persoon: 'Petra Proefmans', waarde: 'dinsdag en donderdag', soort: 'persoonsgegeven' }];
  assert.equal(P.gevoelig('Petra werkt dinsdag en donderdag.', { aan: 'x@ander.invalid', verwerkers: VERWERKERS, bewezen: f, feiten: f }).dicht, true);
  assert.equal(P.gevoelig('Petra werkt dinsdag en donderdag.', { aan: 'x@loonproef.invalid', verwerkers: VERWERKERS, bewezen: f, feiten: f }).dicht, false);
  assert.equal(P.gevoelig('Bedankt, ik kijk ernaar.', { aan: 'x@ander.invalid', verwerkers: VERWERKERS }).dicht, false);
  // wat al in de binnengekomen mail stond, is geen nieuw gegeven (geen BSN)
  assert.equal(P.gevoelig('Bel me op 06-12345678', { mail: 'bel 0612345678', aan: 'x@ander.invalid', verwerkers: VERWERKERS }).dicht, false);
});
test('onderbouwing: waarde buiten mail, feiten en keuzes = niet onderbouwd', () => {
  const no = P.onderbouwing('Ingang 1 december 2026, 24 uur, € 1.500,00.', { mail: 'Graag de ingangsdatum.', bewezen: [{ waarde: 'per 1 december 2026' }], keuzes: [] });
  assert.deepEqual(no.map(function (x) { return x.soort; }).sort(), ['bedrag', 'uren']);
  assert.equal(P.onderbouwing('Tot 3 november!', { mail: 'Zullen we 3-11-2026 afspreken?' }).length, 0);
});

// ── luik ──
function luikIo(o) {
  o = o || {};
  const st = { poort: 0, vault: [] };
  return { st, io: {
    poort: function (stuk) { st.poort++; if (o.poortGooit) throw new Error('poort stuk'); return { tegenhouden: /PATIENTPROEF/.test(stuk.teksten[0]) }; },
    vaultZoek: async function () { return ['10_Zakelijk/Proef/Medewerkers/Petra Proefmans - assistente.md', '20_Prive/Gezondheid/x.md', '.claude/skills/x.md', '50_Onderzoek/a.md']; },
    vaultLees: async function (rel) { st.vault.push(rel); return o.tekst != null ? o.tekst : 'Tekst van ' + rel; },
    mailZoek: async function () { return [{ id: 'm1', van: 'a@voorbeeld.invalid', onderwerp: 'x', datum: '2026-11-01' }, { id: 'm2', van: 'b@voorbeeld.invalid', onderwerp: 'y', datum: '2026-11-02' }]; },
    mailLees: async function (id) { return { van: 'a@voorbeeld.invalid', aan: 'd@voorbeeld.invalid', onderwerp: 'o', datum: '2026-11-01', tekst: id === 'm2' ? 'PATIENTPROEF' : 'gewone mail' }; },
    mailSlot: function (id) { return id === 'm9'; },
    agenda: async function () { return [{ titel: 'Overleg', start: '2026-11-12T10:00', einde: '2026-11-12T11:00' }]; },
    contact: async function () { return [{ naam: 'Proef' }]; },
    facturen: async function () { return { profielen: [] }; },
    nmbrs: async function () { return { ok: true, treffers: [{ naam: 'Petra Proefmans', bedrijf: 'Proef BV', schaal: '5', trede: '2', ingangsdatum_salaris: '2026-12-01', salaris_bedrag: 2345.67, bsn: '111222333', iban: IBAN }] }; },
    nu: function () { return Date.parse('2026-11-11T10:00:00Z'); }
  } };
}
test('luik: verboden vaultmappen, verborgen mappen, .. en absolute paden geweigerd; zoeklijst zonder verboden paden', async () => {
  ['20_Prive/Gezondheid/a.md', '20_Prive/Gambia/a.md', '20_Prive/Relaties/a.md', '50_Onderzoek/a.md', '00_Systeem/Meldingen/machinekamer.md', '.claude/skills/x/SKILL.md',
    '10_Zakelijk/../20_Prive/Gezondheid/a.md', '/etc/passwd', '10_Zakelijk/a.sqlite', '10_Zakelijk/.git/config'].forEach(function (p) { assert.equal(L.vaultPadOk(p), null, p); });
  assert.equal(L.vaultPadOk('10_Zakelijk/Proef/a.md'), '10_Zakelijk/Proef/a.md');
  const { io, st } = luikIo();
  const l = L.maakLuik(io, { afzender: 'a@voorbeeld.invalid' });
  const z = await l.roep('vault_zoek', { term: 'Petra' });
  assert.match(z.tekst, /Medewerkers\/Petra Proefmans/); assert.doesNotMatch(z.tekst, /Gezondheid|\.claude|50_Onderzoek/);
  const g = await l.roep('vault_lees', { pad: '20_Prive/Gezondheid/x.md' });
  assert.match(g.tekst, /geweigerd/); assert.deepEqual(st.vault, []);
  const ok = await l.roep('vault_lees', { pad: '10_Zakelijk/Proef/Medewerkers/Petra Proefmans - assistente.md' });
  assert.match(ok.tekst, /\[STUK S2 \| soort: dossier .*persoonsgebonden: Petra Proefmans/);
  assert.equal(l.stukken.get('S2').gebonden, 'Petra Proefmans');
  assert.ok(l.log.every(function (x) { return !('tekst' in x); }), 'run-log zonder tekst');
});
test('luik: patiëntpoort op elk antwoord — tegenhouden of een fout in de poort = stuk niet terug, nooit gedeeltelijk', async () => {
  const { io } = luikIo({ tekst: 'Begin van het stuk. PATIENTPROEF. Einde.' });
  const l = L.maakLuik(io, {});
  const r = await l.roep('vault_lees', { pad: '10_Zakelijk/a.md' });
  assert.match(r.tekst, /overgeslagen: mogelijk patiëntgegevens/); assert.doesNotMatch(r.tekst, /Begin van het stuk/);
  assert.equal(l.stukken.size, 0); assert.equal(l.tel.tegengehouden, 1);
  const g = luikIo({ poortGooit: true });
  const l2 = L.maakLuik(g.io, { afzender: 'a@voorbeeld.invalid' });
  for (const [t, a] of [['vault_lees', { pad: '10_Zakelijk/a.md' }], ['agenda', { van: '2026-11-11', tot: '2026-11-12' }], ['contact', { naam: 'Proef' }], ['facturen', { tegenpartij: 'Proef' }], ['nmbrs', { naam: 'Petra' }], ['mail_afzender', {}]]) {
    const x = await l2.roep(t, a);
    assert.match(x.tekst, /overgeslagen/, t);
  }
  assert.equal(l2.stukken.size, 0);
  // mail: tweede mail bevat een patiëntkenmerk; slotje bij MailMan = niet eens lezen; id buiten de lijst = geweigerd
  const m = luikIo();
  const l3 = L.maakLuik(m.io, { afzender: 'a@voorbeeld.invalid' });
  assert.match((await l3.roep('mail_lees', { id: 'm1' })).tekst, /geweigerd/);
  await l3.roep('mail_afzender', {});
  assert.match((await l3.roep('mail_lees', { id: 'm1' })).tekst, /\[STUK S2 \| soort: mail/);
  assert.match((await l3.roep('mail_lees', { id: 'm2' })).tekst, /overgeslagen/);
});
test('luik: grenzen — 40 kB per stuk, 25 stukken, 40 aanroepen; nmbrs alleen vaste velden (nooit bedrag, BSN, IBAN)', async () => {
  const { io } = luikIo({ tekst: 'x'.repeat(50000) });
  const l = L.maakLuik(io, {});
  const r = await l.roep('vault_lees', { pad: '10_Zakelijk/a.md' });
  assert.match(r.tekst, /afgekapt na 40000/); assert.equal(l.stukken.get('S1').tekst.length, 40000);
  for (let i = 0; i < 30; i++) await l.roep('vault_lees', { pad: '10_Zakelijk/a' + i + '.md' });
  assert.equal(l.stukken.size, 25); assert.match((await l.roep('vault_lees', { pad: '10_Zakelijk/b.md' })).tekst, /grens: hooguit 25 stukken/);
  for (let i = 0; i < 20; i++) await l.roep('agenda', { van: 'x', tot: 'y' });
  assert.match((await l.roep('agenda', { van: '2026-11-11', tot: '2026-11-12' })).tekst, /grens: hooguit 40 aanroepen/);
  const n = luikIo();
  const l2 = L.maakLuik(n.io, {});
  const t = (await l2.roep('nmbrs', { naam: 'Petra' })).tekst;
  assert.match(t, /schaal: 5/); assert.doesNotMatch(t, /2345|111222333|ABNA/);
  assert.equal(l2.stukken.get('S1').gebonden, 'Petra Proefmans');
  assert.match((await l2.roep('agenda', { van: '2026-11-01', tot: '2026-12-31' })).tekst, /hooguit 31 dagen/);
  assert.match((await l2.roep('bash', {})).tekst, /onbekende tool/);
});

// ── mailvoorwerk versie 2 ──
let klok = Date.parse('2026-11-11T10:00:00Z');
function zaakVan(o) {
  return Object.assign({ draad: 'aa11bb22cc33dd44', laag: 'jij', reden: 'actie_mogelijk', afgehandeld: null, inbox: 'ja', laatste: new Date(klok - 3600000).toISOString(),
    beantwoord: null, besluit: 101, afzender: 'loket@loonproef.invalid', naam: 'Loket', onderwerp: 'Gegevens nieuwe medewerker', afmeld: false, slot: false,
    jev: { systeem: 0.02, actie: 0.9, actie_anders: 0.95, injectie: 0.01, aan_ai: 0.01 }, stroom: 'info' }, o || {});
}
const STAP1 = { vraag: 'Werkdagen en IBAN van Petra.', voorstel: 'Opzoeken en doorgeven.', antwoord_nodig: true, concept: 'Hoi,\n\nDat zoek ik op.\n\nGroet, David', invullen: [],
  gevraagd: [{ wat: 'werkdagen Petra', soort: 'zoek' }, { wat: 'IBAN Petra', soort: 'zoek' }] };
function stap3(concept, feiten) {
  return { vraag: 'Werkdagen en IBAN van Petra.', voorstel: 'Concept goedkeuren.', antwoord_nodig: true, concept: concept,
    feiten: feiten || [{ persoon: 'Petra Proefmans', waarde: 'dinsdag en donderdag', bron: 'S1', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' },
      { persoon: 'Petra Proefmans', waarde: IBAN, bron: 'S1', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' }],
    keuzes: [], niet_gevonden: [{ wat: 'praktijkovereenkomst', gezocht: 'dossier, mail' }], gevoelig: [] };
}
function kamer(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voorwerk2-'));
  const zaken = o.zaken || [zaakVan(o.zaak)];
  const st = { stap1: 0, onderzoek: 0, herschrijf: 0, concept: [], fouten: [], log: [], aanwijzing: null };
  const io = {
    dir, nu: function () { return klok; }, aan: function () { return true; }, versie: function () { return o.versie || 2; }, verwerkers: function () { return VERWERKERS; },
    fout: function (t, e) { st.fouten.push(t + ': ' + (e && e.message)); }, log: function (r) { st.log.push(r); },
    bron: function (d) { return d.draad != null ? zaken.filter(function (z) { return z.draad === d.draad; }) : zaken.filter(function (z) { return z.laatste >= d.sinds; }); },
    lees: async function () { return { van: 'Loket <loket@loonproef.invalid>', aan: 'david@voorbeeld.invalid', onderwerp: 'Gegevens nieuwe medewerker', datum: '2026-11-11', tekst: o.mail || 'Beste David, van Petra Proefmans missen we de werkdagen en het IBAN. Groet, Loket' }; },
    poort: function (stuk) { return { tegenhouden: /PATIENTPROEF/.test(stuk.teksten[0] || '') }; },
    claude: async function (sys, prompt, schema) {
      if (schema === V.SCHEMA_STAP1) { st.stap1++; return { ok: true, data: o.stap1 || STAP1, verbruik: { kosten: 0.03 } }; }
      if (schema && schema.properties && Object.keys(schema.properties).length === 1) { st.herschrijf++; return { ok: true, data: { concept: o.herschreven || 'Hoi,\n\nPetra werkt dinsdag en donderdag.\n\nGroet, David' }, verbruik: { kosten: 0.01 } }; }
      return { ok: true, data: { vraag: 'v1', voorstel: 'v', antwoord_nodig: true, concept: 'Hoi,\n\nPrima.\n\nGroet, David', invullen: [] } };
    },
    onderzoek: async function (a) {
      st.onderzoek++; st.prompt2 = a.prompt; st.systeem2 = a.systeem; assert.equal(a.schema, V.SCHEMA_STAP3);
      const stukken = stukkenVan([DOSSIER]);
      return { ok: true, data: o.stap3 || stap3('Hoi,\n\nPetra werkt dinsdag en donderdag; haar IBAN is ' + IBAN + '.\n\nGroet, David'), verbruik: { kosten: o.kosten != null ? o.kosten : 0.5 }, stukken, log: [{ id: 'S1', soort: 'dossier', ref: DOSSIER.label }] };
    },
    stem: function () { return '# Mijn mailstem\nKort.'; },
    concept: async function (body) { st.concept.push(body); return { status: 200, j: { ok: true, concept_id: 'r-1', thread_id: body.thread_id } }; },
    register: function () {}
  };
  return { vw: V.maak(io), st, dir, zaken };
}
async function wacht(vw, draad) { for (let i = 0; i < 100; i++) { const t = vw.toon(draad); if (t.j.voorwerk && t.j.voorwerk.stand !== 'bezig') return t; await new Promise(function (r) { setTimeout(r, 10); }); } throw new Error('bleef bezig'); }

test('v2: stap 1 zonder iets op te zoeken = geen onderzoek; met zoekpunten = onderzoek, feiten met vindplaats, toets in de rij', async () => {
  const k0 = kamer({ stap1: Object.assign({}, STAP1, { gevraagd: [{ wat: 'akkoord', soort: 'keuze' }] }) });
  await k0.vw.tik();
  assert.equal(k0.st.stap1, 1); assert.equal(k0.st.onderzoek, 0);
  assert.equal(k0.vw.toon('aa11bb22cc33dd44').j.voorwerk.stap, 1);
  const k = kamer();
  await k.vw.tik();
  assert.equal(k.st.onderzoek, 1);
  assert.match(k.st.prompt2, /verwerker\) van de praktijk\? JA/);
  const vw = k.vw.toon('aa11bb22cc33dd44').j.voorwerk;
  assert.equal(vw.stap, 2); assert.equal(vw.versie, 'voorwerk-2');
  assert.equal(vw.feiten.length, 2); assert.equal(vw.feiten[0].vindplaats, DOSSIER.label);
  assert.equal(vw.toets.dicht, false); assert.deepEqual(vw.toets.blok, []);
  assert.equal(vw.niet_gevonden[0].wat, 'praktijkovereenkomst');
  const rij = k.vw._db().prepare('SELECT bronlog, kosten FROM voorwerk').get();
  assert.doesNotMatch(rij.bronlog, /dinsdag/, 'bronlog zonder tekst'); assert.equal(rij.kosten, 0.53);
});
test('v2: verzonnen waarde in het concept → herschrijfronde; blijft hij staan, dan Gmail dicht', async () => {
  const feiten = [{ persoon: 'Petra Proefmans', waarde: 'maandag en vrijdag', bron: 'S1', datum_stuk: '2026-11-03', soort: 'persoonsgegeven' }];
  const k = kamer({ stap3: stap3('Hoi,\n\nPetra werkt maandag en vrijdag.\n\nGroet, David', feiten) });
  await k.vw.tik();
  assert.equal(k.st.herschrijf, 1);
  let vw = k.vw.toon('aa11bb22cc33dd44').j.voorwerk;
  assert.doesNotMatch(vw.concept, /maandag en vrijdag/); assert.deepEqual(vw.toets.blok, []);
  assert.equal(vw.niet_bewezen[0].reden, 'waarde_niet_in_bron');
  const k2 = kamer({ stap3: stap3('Hoi,\n\nPetra werkt maandag en vrijdag.\n\nGroet, David', feiten), herschreven: 'Hoi,\n\nPetra werkt maandag en vrijdag hoor.\n\nGroet, David' });
  await k2.vw.tik();
  vw = k2.vw.toon('aa11bb22cc33dd44').j.voorwerk;
  assert.deepEqual(vw.toets.blok, ['maandag en vrijdag']);
  const g = await k2.vw.gmail({ draad: 'aa11bb22cc33dd44' });
  assert.equal(g.status, 409); assert.deepEqual(g.j.niet_bewezen, ['maandag en vrijdag']); assert.equal(k2.st.concept.length, 0);
});
test('v2 gmail(): de definitieve (aangepaste) tekst opnieuw door de poort — BSN dicht, IBAN naar onbekend domein dicht, naar verwerker open', async () => {
  const k = kamer();
  await k.vw.tik();
  let g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: 'Hoi,\n\nHaar BSN is 111222333.\n\nGroet, David' });
  assert.equal(g.status, 409); assert.equal(g.j.gevoelig[0].soort, 'bsn'); assert.doesNotMatch(g.j.fout, /111222333/);
  g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: 'Hoi,\n\nHet IBAN is ' + IBAN2 + '.\n\nGroet, David' });
  assert.equal(g.status, 409, 'IBAN dat niet bewezen is, ook naar de verwerker');
  g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: 'Hoi,\n\nPATIENTPROEF\n\nGroet, David' });
  assert.equal(g.status, 409); assert.equal(g.j.gevoelig[0].soort, 'patient');
  assert.equal(k.st.concept.length, 0);
  g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44' });
  assert.equal(g.status, 200, JSON.stringify(g.j)); assert.equal(k.st.concept.length, 1); assert.equal(k.st.concept[0].aan, 'loket@loonproef.invalid');
  // dezelfde zaak van een onbekend domein: IBAN en werkdagen dicht
  const k2 = kamer({ zaak: { afzender: 'loket@loonproef-nl.invalid' } });
  await k2.vw.tik();
  assert.match(k2.st.prompt2, /verwerker\) van de praktijk\? NEE/);
  assert.equal(k2.vw.toon('aa11bb22cc33dd44').j.voorwerk.toets.dicht, true);
  g = await k2.vw.gmail({ draad: 'aa11bb22cc33dd44' });
  assert.equal(g.status, 409); assert.ok(g.j.gevoelig.some(function (x) { return x.reden === 'geen_verwerker'; }));
});
test('v2 gmail(): niet-onderbouwde gewone waarde vraagt één extra tik (toch), geen poortweigering', async () => {
  const k = kamer();
  await k.vw.tik();
  let g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: 'Hoi,\n\nPetra werkt dinsdag en donderdag, vanaf 5 januari 2027.\n\nGroet, David' });
  assert.equal(g.status, 409); assert.equal(g.j.toch_vragen, true); assert.equal(g.j.niet_onderbouwd[0].soort, 'datum');
  g = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: 'Hoi,\n\nPetra werkt dinsdag en donderdag, vanaf 5 januari 2027.\n\nGroet, David', toch: true });
  assert.equal(g.status, 200);
});
test('v2 plafond: hooguit 6 automatische onderzoeksruns per dag en $ 5; op Davids tik wel, met aanwijzing', async () => {
  const zaken = []; for (let i = 0; i < 9; i++) zaken.push(zaakVan({ draad: 'aa11bb22cc33dd' + (10 + i), besluit: 200 + i }));
  const k = kamer({ zaken });
  for (let i = 0; i < 6; i++) await k.vw.tik();
  assert.equal(k.st.onderzoek, 6);
  const h = k.vw.health(); assert.equal(h.onderzoek_auto_vandaag, 6); assert.equal(h.plafond_ok, false);
  const rest = zaken.map(function (z) { return k.vw.toon(z.draad).j.voorwerk; }).filter(function (v) { return v && v.reden === 'plafond'; });
  assert.ok(rest.length >= 1, 'na 6 runs alleen stap 1 met reden plafond');
  const k2 = kamer({ zaken: zaken.slice(0, 3), kosten: 5.2 });
  await k2.vw.tik(); await k2.vw.tik();
  assert.equal(k2.st.onderzoek, 1, 'boven $ 5 geen automatisch onderzoek meer');
  const r = k.vw.opVerzoek(zaken[8].draad, 'Salaris staat in het nieuwe contract.');
  assert.equal(r.status, 202);
  await wacht(k.vw, zaken[8].draad);
  assert.equal(k.st.onderzoek, 7); assert.match(k.st.prompt2, /Aanwijzing van David .*nieuwe contract/);
  assert.equal(k.vw.opVerzoek(zaken[7].draad, 'x'.repeat(201)).status, 400);
  assert.equal(k.vw.opVerzoek(zaken[7].draad, 'regel\ntwee').status, 400);
});
test('v1 (schakelaar): geen stap 2, oude vorm', async () => {
  const k = kamer({ versie: 1 });
  await k.vw.tik();
  assert.equal(k.st.onderzoek, 0); assert.equal(k.st.stap1, 0);
  assert.equal(k.vw.toon('aa11bb22cc33dd44').j.voorwerk.vraag, 'v1');
});
test('MCP-kind: alleen de luiktools, elke aanroep naar de eigen URL met het runtoken; zonder geldig antwoord geen tekst', async () => {
  const http = require('http');
  const { spawn } = require('child_process');
  const gezien = [];
  const srv = http.createServer(function (req, res) {
    let b = ''; req.on('data', function (c) { b += c; }); req.on('end', function () {
      gezien.push({ token: req.headers['x-voorwerk-token'], body: JSON.parse(b) });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ tekst: '[STUK S1 | soort: vault] proef' }));
    });
  });
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  const k = spawn(process.execPath, [path.join(DIR, 'voorwerk-lees.js')], { env: { VOORWERK_LUIK_URL: 'http://127.0.0.1:' + srv.address().port + '/intern/voorwerk-luik', VOORWERK_LUIK_TOKEN: 'a'.repeat(64) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const antw = new Map(); let buf = '';
  k.stdout.on('data', function (c) { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); antw.set(m.id, m); } });
  const vraag = async function (id, method, params) { k.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 200 && !antw.has(id); i++) await new Promise(function (r) { setTimeout(r, 10); }); return antw.get(id); };
  try {
    assert.equal((await vraag(1, 'initialize', { protocolVersion: '2025-11-25' })).result.serverInfo.name, 'voorwerk-lees');
    const l = await vraag(2, 'tools/list', {});
    assert.deepEqual(l.result.tools.map(function (t) { return t.name; }).sort(), ['agenda', 'contact', 'facturen', 'mail_afzender', 'mail_lees', 'mail_zoek', 'nmbrs', 'vault_lees', 'vault_zoek']);
    const c = await vraag(3, 'tools/call', { name: 'vault_lees', arguments: { pad: '10_Zakelijk/a.md' } });
    assert.match(c.result.content[0].text, /STUK S1/);
    assert.deepEqual(gezien, [{ token: 'a'.repeat(64), body: { tool: 'vault_lees', args: { pad: '10_Zakelijk/a.md' } } }]);
    assert.equal((await vraag(4, 'resources/list', {})).error.code, -32601);
  } finally { k.kill(); srv.close(); }
});

// ── review Fable (wv2916): elk MOET-punt en de ZOU-punten als toets ──
test('review MOET 1: persoonsgegeven of IBAN zonder persoon uit een verzamelstuk = niet bewezen', () => {
  const st = stukkenVan([{ soort: 'vault', label: '10_Zakelijk/Proef/Salarisoverzicht.md', gebonden: null, datum: null, tekst: 'Overzicht: ' + IBAN + ' en dinsdag en donderdag.' }]);
  const r = P.bronbewijs([{ persoon: '', waarde: IBAN, bron: 'S1', datum_stuk: '', soort: 'werk' }, { persoon: '', waarde: 'dinsdag en donderdag', bron: 'S1', datum_stuk: '', soort: 'persoonsgegeven' }], st);
  assert.equal(r.bewezen.length, 0); assert.deepEqual(r.niet_bewezen.map(function (x) { return x.reden; }), ['persoon_ontbreekt', 'persoon_ontbreekt']);
});
test('review MOET 2: bevat keurt geen voorvoegsel, geen andere getallen en geen losse woorden goed', () => {
  assert.equal(P.bevat('schaal 5 trede 3 per 1-1-2026', 'schaal 7, trede 9 per 01-01-2026'), false);
  assert.equal(P.bevat('ma en di, 16 uur', 'Werkt wo en vr, samen 16 uur'), false);
  assert.equal(P.bevat('€ 1.250', 'Lening € 1.250.000'), false);
  assert.equal(P.bevat('jansen@voorbeeld.invalid', 'p.jansen@voorbeeld.invalid'), false);
  assert.equal(P.bevat('schaal 5, trede 2 per 1 december 2026', 'Salaris: schaal 5, trede 2 per 1 december 2026 (contract)'), true);
});
test('review MOET 3: verzuim/medisch en codes op genormaliseerde tekst; BSN met streepjes', () => {
  const o = { aan: 'x@loonproef.invalid', verwerkers: VERWERKERS };
  ['Het ziekteverzuim van Kim loopt sinds oktober.', 'Kim is sinds maandag ziek thuis.', 'Ze is 50% arbeidsongeschikt.', 'Ze is zwanger.', 'De reïntegratie loopt.', 'De herstelmelding volgt.',
    'Haar toegangscodes volgen.', 'De inloggegevens stuur ik apart.', 'BSN 1112-22-333'].forEach(function (t) { assert.equal(P.gevoelig(t, o).dicht, true, t); });
  assert.equal(P.gevoelig('We luisteren muziek op de praktijk.', o).dicht, false, 'muziek is geen ziek');
  assert.ok(P.gevoelig('BSN 1112-22-333', o).redenen.every(function (r) { return r.ruw === ''; }), 'nooit-soort zonder waarde (ZOU 6)');
});
test('review MOET 4: loonbedrag zonder euroteken of met "verdient" naar een niet-verwerker = dicht', () => {
  const o = { aan: 'iemand@elders.invalid', verwerkers: VERWERKERS };
  ['Het salaris van Kim is 3200 bruto per maand.', 'bruto 3200,- per maand', 'Kim verdient € 3.200 per maand.'].forEach(function (t) {
    const g = P.gevoelig(t, o); assert.equal(g.dicht, true, t); assert.equal(g.redenen[0].soort, 'loonbedrag');
  });
  const ok = P.gevoelig('Kim verdient € 3.200 per maand.', { aan: 'x@loonproef.invalid', verwerkers: VERWERKERS, bewezen: [{ waarde: '€ 3.200' }] });
  assert.equal(ok.dicht, false, 'naar de verwerker en onderbouwd: open');
});
test('review MOET 5: slotmail niet in de zoeklijst (ook niet met onderwerp)', async () => {
  const { io } = luikIo();
  io.mailSlot = function (id) { return id === 'm2'; };
  const l = L.maakLuik(io, { afzender: 'a@voorbeeld.invalid' });
  const r = (await l.roep('mail_zoek', { term: 'uitslag' })).tekst;
  assert.match(r, /id m1/); assert.doesNotMatch(r, /id m2|b@voorbeeld/);
  assert.match((await l.roep('mail_lees', { id: 'm2' })).tekst, /geweigerd/);
});
test('review ZOU 1–5: parafrase van een niet-bewezen bedrag blokkeert; naam en datum strenger; 30_Conversaties dicht; patronen', () => {
  assert.deepEqual(P.nietBewezenInTekst('Kim krijgt € 3.200 per maand.', [{ waarde: '€ 3.200 bruto per maand' }], []), ['€ 3.200 bruto per maand']);
  assert.deepEqual(P.nietBewezenInTekst('Tot 3 november.', [{ waarde: 'start 3 november 2026' }], ['Zullen we 3 november spreken?']), [], 'staat ook in de mail: geen blok');
  assert.equal(P.naamPast('Kim', 'Kim Anders'), false); assert.equal(P.naamPast('van', 'Bo van Test'), false);
  assert.equal(P.naamPast('Petra Proefmans', 'Arbeidsovereenkomst Petra Proefmans 2025-06-01'), true);
  const r = P.bronbewijs([{ persoon: 'Petra Proefmans', waarde: 'dinsdag en donderdag', bron: 'S1', datum_stuk: 'onbekend', soort: 'persoonsgegeven' }],
    stukkenVan([Object.assign({}, DOSSIER, { datum: null, tekst: 'Petra Proefmans werkt dinsdag en donderdag.' })]));
  assert.equal(r.keuzes[0].reden, 'geen_datum', '"onbekend" is geen datum');
  assert.equal(L.vaultPadOk('30_Conversaties/WhatsApp/a.md'), null);
  const sc = function (t) { return P.scan(t).map(function (x) { return x.soort; }); };
  assert.deepEqual(sc('(06) 12345678'), ['telefoon']); assert.deepEqual(sc('+31 (0)6 1234 5678'), ['telefoon']); assert.deepEqual(sc('06.12.34.56.78'), ['telefoon']);
  assert.deepEqual(sc('+32 470 12 34 56'), ['telefoon']); assert.deepEqual(sc('DE89 3704 0044 0532 0130 00'), ['iban']);
  assert.deepEqual(sc('Dat regel ik in 2026 op de praktijk.'), []);
  assert.equal(P.gevoelig('date of birth 3 May 1990', { aan: 'x@elders.invalid', verwerkers: VERWERKERS }).redenen[0].soort, 'geboortedatum');
});
