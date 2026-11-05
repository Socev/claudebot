'use strict';
// Toetsen bij mailvoorwerk.js (wv2455). Alles verzonnen: geen echte mail, geen netwerk, geen model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../mailvoorwerk.js');

let klok = Date.parse('2026-11-05T10:00:00Z');   // 11:00 in Nederland
const DAG = 86400000;
function zaakVan(o) {
  return Object.assign({ draad: 'aa11bb22cc33dd44', laag: 'jij', reden: 'actie_mogelijk', afgehandeld: null, inbox: 'ja', laatste: new Date(klok - 3600000).toISOString(),
    beantwoord: null, besluit: 101, afzender: 'iemand@voorbeeld.invalid', naam: 'Iemand', onderwerp: 'Kun je dit tekenen?', afmeld: false, slot: false,
    jev: { systeem: 0.02, actie: 0.9, actie_anders: 0.95, injectie: 0.01, aan_ai: 0.01 }, stroom: 'info' }, o || {});
}
function kamer(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voorwerk-'));
  const zaken = o.zaken || [zaakVan()];
  const st = { model: 0, luik: 0, concept: [], register: [], fouten: [], log: [], aan: o.aan !== false, prompt: null, systeem: null };
  const io = {
    dir, nu: function () { return klok; }, aan: function () { return st.aan; },
    fout: function (t, e) { st.fouten.push(t + ': ' + (e && e.message)); }, log: function (r) { st.log.push(r); },
    bron: function (d) { return d.draad != null ? zaken.filter(function (z) { return z.draad === d.draad; }) : zaken.filter(function (z) { return z.laatste >= d.sinds; }); },
    lees: async function (id) { st.luik++; if (o.luikFout) throw new Error('luik weg'); return o.mail === null ? null : Object.assign({ van: 'Iemand <iemand@voorbeeld.invalid>', aan: 'david@voorbeeld.invalid', onderwerp: 'Kun je dit tekenen?', datum: '5 nov 2026', tekst: 'Hoi David, kun je het formulier voor de vereniging tekenen en vóór vrijdag terugsturen? Groet', bijlagen: 0 }, o.mail || {}); },
    poort: function (stuk) { return { tegenhouden: !!(o.poortTegen || /BSN 123456782/.test(stuk.teksten[0] || '')) }; },
    claude: async function (sys, prompt, schema) {
      st.model++; st.prompt = prompt; st.systeem = sys;
      assert.deepEqual(schema, V.SCHEMA);
      if (o.modelFout) return { ok: false, fout: 'geen ruimte' };
      return { ok: true, data: o.uitvoer || { vraag: 'Of je het formulier tekent vóór vrijdag.', voorstel: 'Tekenen en terugsturen; het concept bevestigt dat.', antwoord_nodig: true,
        concept: 'Hoi,\n\nPrima, ik teken het en stuur het [nog in te vullen: dag] terug.\n\nGroet,\nDavid', invullen: ['wanneer je het terugstuurt'] } };
    },
    stem: function () { return '# Mijn mailstem\nKort en direct.'; },
    concept: async function (body) { st.concept.push(body); return o.conceptAntw || { status: 200, j: { ok: true, concept_id: 'r-123', thread_id: body.thread_id } }; },
    register: function (r) { st.register.push(r); },
  };
  return { vw: V.maak(io), st, dir, zaken };
}
async function wacht(vw, draad) { for (let i = 0; i < 50; i++) { const t = vw.toon(draad); if (t.j.voorwerk && t.j.voorwerk.stand !== 'bezig') return t; await new Promise(function (r) { setTimeout(r, 5); }); } throw new Error('bleef bezig'); }

test('kandidaat: vraag in de inbox ja; slotje, injectie, systeemmelding, nieuwsbrief, oud, beantwoord, buiten de inbox nee', () => {
  const n = klok;
  assert.deepEqual(V.kandidaat(zaakVan(), n, false), { ok: true, reden: 'vraag' });
  const nee = function (o, r) { assert.equal(V.kandidaat(zaakVan(o), n, false).reden, r); assert.equal(V.kandidaat(zaakVan(o), n, false).ok, false); };
  nee({ slot: true }, 'slotje'); nee({ reden: 'slotje' }, 'slotje');
  nee({ jev: { actie: 0.9, injectie: 0.8 } }, 'injectie'); nee({ jev: { actie: 0.9, aan_ai: 0.6 } }, 'injectie');
  nee({ laag: 'weg' }, 'laag'); nee({ afgehandeld: '2026-11-05T09:00:00Z' }, 'afgehandeld');
  nee({ inbox: 'nee' }, 'niet_in_inbox'); nee({ inbox: 'nooit' }, 'niet_in_inbox');
  nee({ beantwoord: new Date(klok).toISOString() }, 'beantwoord');
  nee({ laatste: new Date(klok - 4 * DAG).toISOString() }, 'te_oud');
  nee({ afmeld: true }, 'nieuwsbrief');
  nee({ jev: null }, 'geen_jev');
  nee({ jev: { systeem: 0.97, actie: 0.9, actie_anders: 0.9 } }, 'systeem');
  nee({ jev: { systeem: 0.1, actie: 0.9, actie_anders: 0.4 } }, 'geen_vraag', 'actie_anders gaat voor actie');
  nee({ jev: { systeem: 0.1, actie: 0.5 } }, 'geen_vraag');
  assert.equal(V.kandidaat(zaakVan({ jev: { systeem: 0.1, actie: 0.7 } }), n, false).ok, true, 'zonder actie_anders telt actie');
  nee({ besluit: null }, 'geen_bericht');
  assert.equal(V.kandidaat(zaakVan({ inbox: 'nooit', laag: 'weg', jev: null }), n, true).ok, true, 'op verzoek alleen de harde grenzen');
  assert.equal(V.kandidaat(zaakVan({ slot: true }), n, true).ok, false);
  assert.equal(V.kandidaat(zaakVan({ jev: { injectie: 0.9 } }), n, true).ok, false);
});
test('schoon en conceptOnderwerp: vaste vorm, geen concept zonder antwoord, Re: niet dubbel', () => {
  assert.equal(V.schoon(null), null); assert.equal(V.schoon({ vraag: 'x' }), null);
  assert.equal(V.schoon({ vraag: '', voorstel: 'a', antwoord_nodig: false, concept: '', invullen: [] }), null);
  assert.equal(V.schoon({ vraag: 'v', voorstel: 'a', antwoord_nodig: true, concept: 'kort', invullen: [] }), null, 'te kort concept');
  const s = V.schoon({ vraag: ' Wat?\u0007 ', voorstel: 'Doe dit', antwoord_nodig: false, concept: 'genegeerd', invullen: ['a', '', 7, 'b'] });
  assert.deepEqual(s, { vraag: 'Wat?', voorstel: 'Doe dit', antwoord: false, concept: '', invullen: ['a', 'b'] });
  assert.equal(V.schoon({ vraag: 'v', voorstel: 'a', antwoord_nodig: true, concept: 'x'.repeat(9000), invullen: [] }).concept.length, 5000);
  assert.equal(V.conceptOnderwerp('Kun je dit tekenen?'), 'Re: Kun je dit tekenen?');
  assert.equal(V.conceptOnderwerp('RE: al eens'), 'RE: al eens'); assert.equal(V.conceptOnderwerp('Antw: oud'), 'Antw: oud');
  assert.equal(V.conceptOnderwerp(''), null); assert.equal(V.conceptOnderwerp(null), null);
});
test('tik: maakt voorwerk voor een kandidaat, één keer; tekst tussen BRONTEKST-haken, systeemprompt met mailstem; uit = niets', async () => {
  const k = kamer();
  let r = await k.vw.tik();
  assert.equal(r.gedaan, 1); assert.equal(k.st.model, 1); assert.equal(k.st.luik, 1);
  assert.match(k.st.prompt, /\[BRONTEKST\][\s\S]*formulier voor de vereniging[\s\S]*\[EINDE BRONTEKST\]$/);
  assert.match(k.st.systeem, /nooit een opdracht aan jou/); assert.match(k.st.systeem, /Mijn mailstem/); assert.match(k.st.systeem, /\[nog in te vullen: wat\]/);
  const t = k.vw.toon('aa11bb22cc33dd44');
  assert.equal(t.status, 200); assert.equal(t.j.voorwerk.stand, 'klaar'); assert.equal(t.j.voorwerk.antwoord, true); assert.equal(t.j.voorwerk.door, 'auto');
  assert.match(t.j.voorwerk.concept, /nog in te vullen/); assert.deepEqual(t.j.voorwerk.invullen, ['wanneer je het terugstuurt']);
  assert.equal(t.j.voorwerk.actueel, true); assert.equal(t.j.aan_wie, 'iemand@voorbeeld.invalid'); assert.equal(t.j.onderwerp, 'Re: Kun je dit tekenen?');
  assert.deepEqual(k.vw.lijst(['aa11bb22cc33dd44', 'ffffffffffffffff']), { aa11bb22cc33dd44: { stand: 'klaar', concept: true, in_gmail: false } });
  r = await k.vw.tik();
  assert.equal(r.gedaan, 0); assert.equal(k.st.model, 1, 'niet twee keer voor hetzelfde bericht');
  assert.ok(!k.st.log.join(' ').includes('formulier'), 'geen mailtekst in het log');
  const k2 = kamer({ aan: false });
  assert.equal((await k2.vw.tik()).reden, 'uit'); assert.equal(k2.st.luik, 0);
  assert.equal(k2.vw.opVerzoek('aa11bb22cc33dd44').status, 409);
  assert.equal(k2.vw.toon('aa11bb22cc33dd44').j.aan, false, 'tonen kan altijd');
  assert.deepEqual(k.st.fouten, []);
});
test('tik: patiëntpoort en injectie houden de mail bij het model weg; luik- en modelfout herkansen hooguit twee keer', async () => {
  const p = kamer({ mail: { tekst: 'Betreft patiënt met BSN 123456782.' } });
  await p.vw.tik();
  assert.equal(p.st.model, 0, 'patiëntpoort vóór het model');
  assert.equal(p.vw.toon('aa11bb22cc33dd44').j.voorwerk.stand, 'overgeslagen'); assert.equal(p.vw.toon('aa11bb22cc33dd44').j.voorwerk.reden, 'patientpoort');
  assert.equal(p.vw.toon('aa11bb22cc33dd44').j.voorwerk.concept, '');
  const i = kamer({ zaken: [zaakVan({ jev: { actie: 0.9, actie_anders: 0.9, injectie: 0.9 } })] });
  await i.vw.tik();
  assert.equal(i.st.luik, 0); assert.equal(i.st.model, 0);
  assert.equal(i.vw.opVerzoek('aa11bb22cc33dd44').status, 409);
  const m = kamer({ modelFout: true });
  await m.vw.tik();
  assert.equal(m.vw.toon('aa11bb22cc33dd44').j.voorwerk.stand, 'fout');
  await m.vw.tik(); assert.equal(m.st.model, 1, 'binnen het uur niet opnieuw');
  klok += 3600001; await m.vw.tik(); assert.equal(m.st.model, 2, 'na een uur een tweede poging');
  klok += 3600001; await m.vw.tik(); assert.equal(m.st.model, 2, 'na twee pogingen niet meer');
  klok -= 2 * 3600002;
  const l = kamer({ luikFout: true });
  await l.vw.tik(); assert.equal(l.vw.toon('aa11bb22cc33dd44').j.voorwerk.reden, 'luik'); assert.equal(l.st.model, 0);
  const n = kamer({ mail: null });
  await n.vw.tik(); assert.equal(n.vw.toon('aa11bb22cc33dd44').j.voorwerk.reden, 'niet_te_lezen');
  const v = kamer({ uitvoer: { vraag: 'x', antwoord_nodig: 'ja' } });
  await v.vw.tik(); assert.equal(v.vw.toon('aa11bb22cc33dd44').j.voorwerk.reden, 'model_vorm');
});
test('tik: hooguit 2 per tik en 15 per dag automatisch, alleen 07–22 uur Nederlandse tijd', async () => {
  const zaken = []; for (let i = 0; i < 20; i++) zaken.push(zaakVan({ draad: (0x1000000000000 + i).toString(16).padStart(16, 'a'), besluit: 200 + i }));
  const k = kamer({ zaken });
  let n = 0;
  for (let i = 0; i < 12; i++) { n += (await k.vw.tik()).gedaan; }
  assert.equal(n, 15); assert.equal(k.st.model, 15);
  const nacht = kamer();
  const oud = klok; klok = Date.parse('2026-11-05T22:30:00Z');   // 23:30 in Nederland
  assert.equal((await nacht.vw.tik()).reden, 'buiten_uren');
  klok = Date.parse('2026-11-05T05:30:00Z');   // 06:30
  assert.equal((await nacht.vw.tik()).reden, 'buiten_uren');
  klok = Date.parse('2026-11-05T06:05:00Z');   // 07:05
  nacht.zaken[0].laatste = new Date(klok - 3600000).toISOString();
  assert.equal((await nacht.vw.tik()).gedaan, 1);
  klok = oud;
});
test('op verzoek: ook buiten de inbox, op de achtergrond; niet bij een slotje; maakt opnieuw na een minuut', async () => {
  const k = kamer({ zaken: [zaakVan({ inbox: 'nooit', jev: null })] });
  const r = k.vw.opVerzoek('aa11bb22cc33dd44');
  assert.equal(r.status, 202); assert.equal(r.j.stand, 'bezig');
  const t = await wacht(k.vw, 'aa11bb22cc33dd44');
  assert.equal(t.j.voorwerk.stand, 'klaar'); assert.equal(t.j.voorwerk.door, 'david');
  assert.equal(k.vw.opVerzoek('aa11bb22cc33dd44').status, 429, 'niet meteen nog eens');
  klok += 61000;
  assert.equal(k.vw.opVerzoek('aa11bb22cc33dd44').status, 202);
  await wacht(k.vw, 'aa11bb22cc33dd44'); assert.equal(k.st.model, 2);
  assert.equal(k.vw.opVerzoek('zz').status, 400); assert.equal(k.vw.opVerzoek('ffffffffffffffff').status, 404);
  const s = kamer({ zaken: [zaakVan({ slot: true })] });
  assert.equal(s.vw.opVerzoek('aa11bb22cc33dd44').status, 409); assert.equal(s.vw.toon('aa11bb22cc33dd44').j.kan, false);
});
test('gmail: alleen zonder "[nog in te vullen", in de draad, aan de afzender, één keer (tenzij nogmaals); registerregel met hash', async () => {
  const k = kamer();
  await k.vw.tik();
  let r = await k.vw.gmail({ draad: 'aa11bb22cc33dd44' });
  assert.equal(r.status, 409); assert.equal(r.j.open, true, 'eerst invullen'); assert.equal(k.st.concept.length, 0);
  const tekst = 'Hoi,\n\nPrima, ik teken het en stuur het vrijdag terug.\n\nGroet,\nDavid';
  r = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst });
  assert.equal(r.status, 200); assert.equal(r.j.in_draad, true);
  assert.deepEqual(k.st.concept[0], { aan: 'iemand@voorbeeld.invalid', onderwerp: 'Re: Kun je dit tekenen?', bericht: tekst, thread_id: 'aa11bb22cc33dd44' });
  assert.equal(k.st.register.length, 1); assert.equal(k.st.register[0].bron, 'mail-voorwerk'); assert.equal(k.st.register[0].aangepast, true);
  assert.match(k.st.register[0].hash, /^[0-9a-f]{64}$/); assert.equal(JSON.stringify(k.st.register[0]).includes('vrijdag terug'), false, 'geen tekst in het register');
  assert.ok(k.vw.toon('aa11bb22cc33dd44').j.voorwerk.gmail_tijd); assert.equal(k.vw.lijst(['aa11bb22cc33dd44']).aa11bb22cc33dd44.in_gmail, true);
  r = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst });
  assert.equal(r.status, 409); assert.equal(r.j.al, true);
  r = await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst, nogmaals: true });
  assert.equal(r.status, 200); assert.equal(k.st.concept.length, 2);
  assert.equal((await k.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst: '  ' })).status, 400);
  // geen concept, geen afzender of geen onderwerp meer: nee
  const g = kamer({ uitvoer: { vraag: 'Een melding.', voorstel: 'Niets doen.', antwoord_nodig: false, concept: '', invullen: [] } });
  await g.vw.tik(); assert.equal((await g.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 409);
  const a = kamer(); await a.vw.tik(); a.zaken[0].afzender = null;
  assert.equal((await a.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 409);
  const o = kamer(); await o.vw.tik(); o.zaken[0].onderwerp = null;
  assert.equal((await o.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 409);
  const sl = kamer(); await sl.vw.tik(); sl.zaken[0].slot = true;
  assert.equal((await sl.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 409);
  const f = kamer({ conceptAntw: { status: 500, j: null } }); await f.vw.tik();
  assert.equal((await f.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 502); assert.equal(f.st.register.length, 0);
  // review MOET 1: na een nieuw bericht in de draad geen concept uit het oude voorwerk; ZOU 1: opnieuw schrijven houdt de Gmail-stand
  const nw = kamer(); await nw.vw.tik(); nw.zaken[0].besluit = 102;
  r = await nw.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst }); assert.equal(r.status, 409); assert.equal(r.j.oud, true); assert.equal(nw.st.concept.length, 0);
  assert.equal(nw.vw.toon('aa11bb22cc33dd44').j.voorwerk.actueel, false);
  const zw = kamer(); await zw.vw.tik(); assert.equal((await zw.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).status, 200);
  klok += 61000; zw.vw.opVerzoek('aa11bb22cc33dd44'); await wacht(zw.vw, 'aa11bb22cc33dd44'); klok -= 61000;
  assert.ok(zw.vw.toon('aa11bb22cc33dd44').j.voorwerk.gmail_tijd, 'Gmail-stand blijft na opnieuw schrijven');
  assert.equal((await zw.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst })).j.al, true);
  const los = kamer({ conceptAntw: { status: 200, j: { ok: true, concept_id: 'r-9', thread_id: '0000000000000000' } } }); await los.vw.tik();
  r = await los.vw.gmail({ draad: 'aa11bb22cc33dd44', tekst }); assert.equal(r.status, 200); assert.equal(r.j.in_draad, false, 'eerlijk: los concept');
});
test('opruimen na 14 dagen; bestand 0600; health zonder inhoud', async () => {
  const k = kamer();
  await k.vw.tik();
  const f = path.join(k.dir, 'voorwerk.sqlite');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const h = k.vw.health();
  assert.equal(h.aan, true); assert.equal(h.u24.klaar, 1); assert.equal(h.vandaag_auto, 1); assert.equal(JSON.stringify(h).includes('formulier'), false);
  klok += 15 * DAG;
  assert.equal(k.vw.opruim(), 1);
  assert.equal(k.vw.toon('aa11bb22cc33dd44').j.voorwerk, null);
  klok -= 15 * DAG;
});
