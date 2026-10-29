'use strict';
// Toetsen voor mailman.js (wv1856, OVIS MailMan in de schaduw). Alle toetsdata is verzonnen (de repo is openbaar).
// Per reviewpunt van het ontwerp (bouwplan O.11b, #1–#15) minstens één toets; #6, #8 en #10 horen bij B5 (live) en staan onderaan als
// "niet in deze stap". De tien Jev-proefuitslagen van O.1 zijn vaste invoer voor de Jev-stap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const MM = require('../mailman.js');
const K = MM.K;
const poort = require('../intake/patientpoort.js');

const ALIAS = 'iemand+facturen@voorbeeld.invalid';
let klok = Date.parse('2026-11-02T09:00:00Z');
function nieuweKamer(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ postvakken: {
    'gmail:david': { naam: 'Privé', factuur_alias: ALIAS, stand: 'schaduw', jev: true, tekst: true },
    'gmail:groenhouten': { naam: 'Doktersmaten', factuur_alias: 'facturen@praktijk.invalid', stand: 'schaduw', jev: true, tekst: true },   // review B1 #2: de code houdt dit toch uit
  }, todo_nooit: ['doctolib'] }), { mode: 0o600 });
  const fouten = [];
  const mm = MM.maak(Object.assign({ dir, nu: function () { return klok; }, fout: function (w, e) { fouten.push(w + ': ' + e.message); },
    marker: poort, eigenAdressen: function () { return ['ik@eigen.invalid']; }, intakeDraden: function () { return new Set(); },
    primair: function () { return true; }, geheimOk: function (d) { return d && d.secret === 'proefgeheim'; } }, extra || {}));
  return { dir, mm, fouten };
}
let teller = 0;
function hexId() { teller++; return crypto.createHash('sha1').update('m' + teller).digest('hex').slice(0, 16); }
function mail(o) {
  return Object.assign({ id: hexId(), threadId: hexId(), van: 'Voorbeeld <info@voorbeeld.invalid>', aan: 'ontvanger@voorbeeld.invalid', onderwerp: 'Onderwerp',
    labels: ['INBOX', 'CATEGORY_UPDATES'], bijlagen: [], tekst: 'Een gewone tekst zonder bijzonderheden.', datum: klok - 3600000, afmeld: false }, o || {});
}
function ronde(mm, pv) {
  const s = mm.n8n('POST /mailman/start', {});
  assert.equal(s.status, 200);
  const r = s.j.postvakken.find(function (x) { return x.postvak === pv; });
  assert.ok(r, 'postvak ' + pv + ' in de ronde');
  return r;
}
function draai(mm, pv, mails, opties) {
  opties = opties || {};
  const r = ronde(mm, pv);
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: pv, ids: mails.map(function (m) { return m.id; }), volledig: opties.volledig !== false });
  assert.equal(n.status, 200);
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: pv, mails: mails.filter(function (m) { return n.j.nieuw.includes(m.id); }), gevolgd: opties.gevolgd || [] });
  assert.equal(s1.status, 200);
  const antwoorden = s1.j.jev.map(function (a) {
    const f = opties.jev ? opties.jev(a) : null;
    return f === undefined ? { gmail_id: a.gmail_id, antwoord: null, fout: 'time-out' } : { gmail_id: a.gmail_id, antwoord: f };
  });
  const s2 = mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: pv, antwoorden });
  const g = mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: pv, fout: opties.fout });
  return { r, n, s1, s2, g };
}
// Jev-antwoord in de vorm van Cloudflare (result.result.answers + usage), schaal 'waarde' 0–3
function jevAntwoord(w) {
  const answers = {};
  for (const k of ['factuur', 'mens', 'actie', 'systeem', 'aan_ai', 'injectie']) answers[k] = { type: 'noul', noul: w[k] == null ? 0.02 : w[k] };
  answers.waarde = { type: 'score', score: w.waarde == null ? 1 : w.waarde, legend: {}, probabilities: {}, confidence: 0.8 };
  return { result: { state: 'Completed', result: { model: 'jev-1.13.0', answers, usage: { input_tokens: w.tokens || 900, output_tokens: 40 } } }, success: true };
}
function rij(mm, id) { return mm._db.prepare('SELECT * FROM besluit WHERE gmail_id = ?').get(id); }

// ── de tien proefuitslagen van O.1 (factuur, mens, actie, systeem, waarde) met de verwachte stroom volgens O.5 ──
const PROEF = [
  ['github', { factuur: 0.01, mens: 0.02, actie: 0.12, systeem: 0.99, waarde: 0.14 }, [], 'info', 'hard_uit_systeem'],
  ['factuur', { factuur: 0.98, mens: 0.12, actie: 0.98, systeem: 0.08, waarde: 2.99 }, [{ naam: 'factuur-0412.pdf', mime: 'application/pdf' }], 'factuur', 'hard_factuur'],
  ['nieuwsbrief', { factuur: 0.02, mens: 0.03, actie: 0.60, systeem: 0.03, waarde: 1.08 }, [], 'info', 'score'],
  ['collega', { factuur: 0.01, mens: 0.94, actie: 0.98, systeem: 0.01, waarde: 2.33 }, [], 'intake', 'score'],
  ['bezorging', { factuur: 0.02, mens: 0.02, actie: 0.41, systeem: 0.98, waarde: 0.25 }, [], 'info', 'hard_uit_systeem'],
  ['inlog', { factuur: 0.02, mens: 0.02, actie: 0.88, systeem: 0.98, waarde: 0.65 }, [], 'info', 'hard_uit_systeem'],
  ['notaris', { factuur: 0.02, mens: 0.67, actie: 0.97, systeem: 0.02, waarde: 2.97 }, [{ naam: 'concept-akte.pdf', mime: 'application/pdf' }], 'intake', 'score'],
  ['school', { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 }, [], 'twijfel', 'score'],
  ['aanmaning', { factuur: 0.92, mens: 0.05, actie: 0.99, systeem: 0.46, waarde: 2.55 }, [], 'twijfel', 'factuur_zonder_bijlage'],
  ['reclame', { factuur: 0.02, mens: 0.02, actie: 0.98, systeem: 0.02, waarde: 0.00 }, [], 'info', 'score'],
];

test('Jev-stap: de tien proefmails van O.1 geven de stroom uit het ontwerp (O.5)', () => {
  const { mm } = nieuweKamer();
  const mails = PROEF.map(function (p) { return mail({ onderwerp: 'proef ' + p[0], bijlagen: p[2] }); });
  const per = new Map(mails.map(function (m, i) { return [m.id, PROEF[i]]; }));
  const u = draai(mm, 'gmail:david', mails, { jev: function (a) { return jevAntwoord(per.get(a.gmail_id)[1]); } });
  assert.equal(u.s1.j.jev.length, 10);
  assert.equal(u.s2.j.telling.besloten, 10);
  mails.forEach(function (m, i) {
    const b = rij(mm, m.id);
    assert.equal(b.stroom, PROEF[i][3], PROEF[i][0] + ': stroom');
    assert.equal(b.reden, PROEF[i][4], PROEF[i][0] + ': reden');
    assert.equal(b.status, 'klaar');
  });
  // de scores uit het bouwplan: nieuwsbrief 0,23, collega 0,84, notaris 0,86, school 0,31
  assert.equal(rij(mm, mails[2].id).score, 0.23);
  assert.equal(rij(mm, mails[3].id).score, 0.84);
  assert.equal(rij(mm, mails[6].id).score, 0.86);
  assert.equal(rij(mm, mails[7].id).score, 0.31);
  // tokens echt uit het antwoord, niet aangenomen
  assert.equal(rij(mm, mails[0].id).jev_tokens, 900);
});

test('#1 patiëntpoort vóór Jev: gemarkeerde mail niet naar Jev; onderwerp wel in het logboek (wv1980)', () => {
  const { mm } = nieuweKamer();
  const pat = mail({ onderwerp: 'Betreft: mw. Proef', tekst: 'Geachte collega, bovengenoemde patiënt zagen wij op de polikliniek. Geboortedatum: 01-02-1950. Diagnose en behandelplan volgen.' });
  const gewoon = mail({ onderwerp: 'Vraag over het overleg' });
  const u = draai(mm, 'gmail:david', [pat, gewoon], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 2.5 }); } });
  assert.deepEqual(u.s1.j.jev.map(function (a) { return a.gmail_id; }), [gewoon.id]);
  const b = rij(mm, pat.id);
  assert.equal(b.marker, 1);
  assert.equal(b.onderwerp, 'Betreft: mw. Proef');   // David 29-10: het logboek is voor David, onderwerp nooit filteren
  assert.ok(String(b.marker_soorten).includes('brieftaal'));
  assert.equal(b.stroom, 'twijfel');      // geen regel: naar Intake (standaard), waar de marker hem vasthoudt
  assert.equal(b.jev, null);
});

test('#1 ZORGMAIL-label en zorgdomeinen gaan nooit naar Jev', () => {
  const { mm } = nieuweKamer();
  const a = mail({ labels: ['INBOX', 'ZORGMAIL'] });
  const b = mail({ van: 'Bericht <noreply@post.zorgmail.nl>' });
  const u = draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.s1.j.jev.length, 0);
  assert.equal(rij(mm, a.id).marker_soorten, 'zorgmail');
  assert.equal(rij(mm, b.id).reden, 'zorgmail');
});

test('#1 doktersmaten: geen Jev, geen tekst, wel afzender en onderwerp in het logboek (wv1980); factuuradres → Factuur (schaduw)', () => {
  const { mm } = nieuweKamer();
  const r = ronde(mm, 'gmail:groenhouten');
  assert.equal(r.metadata_alleen, true);
  const f = mail({ aan: 'facturen@praktijk.invalid', onderwerp: 'Factuur oktober' });
  const g = mail({ onderwerp: 'Rooster' });
  const u = draai(mm, 'gmail:groenhouten', [f, g], { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.s1.j.jev.length, 0);
  assert.equal(rij(mm, f.id).stroom, 'factuur');
  assert.equal(rij(mm, g.id).stroom, 'twijfel');
  assert.equal(rij(mm, g.id).reden, 'jev_uit');
  assert.equal(rij(mm, g.id).onderwerp, 'Rooster');
  // review B1 #2/#18: ook met jev/tekst aan in config.json geen Jev, geen tekst, geen labels; afzender en aan wel (wv1980, vervangt #6)
  assert.equal(rij(mm, g.id).afzender, 'info@voorbeeld.invalid'); assert.equal(rij(mm, g.id).van_naam, 'Voorbeeld');
  assert.deepEqual(JSON.parse(rij(mm, g.id).aan), ['ontvanger@voorbeeld.invalid']); assert.equal(rij(mm, g.id).afzender_domein, 'voorbeeld.invalid');
  const lg = mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; }).logboek.find(function (x) { return x.id === rij(mm, g.id).id; });
  assert.equal(lg.onderwerp, 'Rooster'); assert.equal(lg.afzender, 'info@voorbeeld.invalid');
  assert.deepEqual(JSON.parse(rij(mm, f.id).labels_plan), []);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; }).jev, false);
});

test('Standaard zonder config: geen Jev en geen tekst (review B1 #2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ postvakken: { 'gmail:proef': { naam: 'Proef' } } }));
  const mm = MM.maak({ dir, nu: function () { return klok; }, marker: poort });
  const p = mm.app('GET /app/mailman', {}).j.postvakken[0];
  assert.equal(p.jev, false); assert.equal(p.tekst, false);
});

test('Labellijst ontbrak (ruwe Label_-id): geen besluit, geen Jev; de mail komt terug (review B1 #3)', () => {
  const { mm } = nieuweKamer();
  const m = mail({ labels: ['INBOX', 'Label_272'] });
  const u = draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.s1.j.jev.length, 0); assert.equal(u.s1.j.telling.labels_onbekend, 1);
  assert.equal(rij(mm, m.id), undefined);
});

test('Geen draad-sneeuwbal: een twijfelmail trekt latere meldingen in de draad niet vóór Filter Weg (review B1 #5)', () => {
  const { mm } = nieuweKamer();
  mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'ci', voorwaarden: { van_adres: { op: 'is', w: 'noreply@ci.invalid' } } });
  const eerste = mail();
  draai(mm, 'gmail:david', [eerste], { jev: function () { return jevAntwoord({ mens: 0.1, waarde: 1.33 }); } });
  assert.equal(rij(mm, eerste.id).stroom, 'twijfel');
  const ci = mail({ threadId: eerste.threadId, van: 'CI <noreply@ci.invalid>' });
  draai(mm, 'gmail:david', [ci], { jev: function () { return jevAntwoord({}); } });
  assert.equal(rij(mm, ci.id).stap, 'weg'); assert.equal(rij(mm, ci.id).stroom, 'info');
});

test('Marker, zorgmail en verzonden mail: afzender, aan en onderwerp in het logboek; geen Jev (wv1980, vervangt review B1 #6)', () => {
  const { mm } = nieuweKamer();
  const z = mail({ labels: ['ZORGMAIL'], onderwerp: 'Iets met een naam' }), v = mail({ labels: ['SENT'], aan: 'ontvanger@elders.invalid', onderwerp: 'Verzonden' });
  const zd = mail({ van: 'Bericht <noreply@post.zorgmail.nl>', onderwerp: 'Zorgdomein' });
  const pat = mail({ onderwerp: 'Betreft: mw. Proef', tekst: 'Geachte collega, bovengenoemde patiënt zagen wij op de polikliniek. Geboortedatum: 01-02-1950. Diagnose en behandelplan volgen.' });
  const u = draai(mm, 'gmail:david', [z, v, zd, pat], { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.s1.j.jev.length, 0, 'marker, zorgmail en verzonden gaan nooit naar Jev');
  for (const [m, o] of [[z, 'Iets met een naam'], [v, 'Verzonden'], [zd, 'Zorgdomein'], [pat, 'Betreft: mw. Proef']]) {
    const x = rij(mm, m.id); assert.equal(x.onderwerp, o); assert.ok(x.afzender); assert.ok(x.van_naam); assert.ok(JSON.parse(x.aan).length > 0); assert.equal(x.jev, null);
  }
  assert.deepEqual(JSON.parse(rij(mm, v.id).aan), ['ontvanger@elders.invalid']);
  // ook in de App (logboekrij) staat het onderwerp bij een marker
  const lijst = mm.app('POST /app/mailman/toets', { soort: 'regel', postvak: 'gmail:david', voorwaarden: { onderwerp: { op: 'bevat', w: 'mw. Proef' } } });
  assert.equal(lijst.j.treffers, 1); assert.equal(lijst.j.voorbeelden[0].onderwerp, 'Betreft: mw. Proef'); assert.equal(lijst.j.voorbeelden[0].marker, true);
});

test('Harde grens op een schaalvraag geldt genormaliseerd (review B1 #7)', () => {
  const v = MM.START_VRAGEN.map(function (x) { return Object.assign({ actief: true }, x); });
  v.find(function (x) { return x.sleutel === 'waarde'; }).rol = 'hard_in';
  v.find(function (x) { return x.sleutel === 'waarde'; }).grens = 0.9;
  const kaal = { bijlagen: [] }, dr = { in: 0.55, uit: 0.3 };
  assert.equal(K.besluitJev(v, { factuur: 0, systeem: 0, mens: 0, waarde: 2.0, actie: 0, aan_ai: 0, injectie: 0 }, kaal, dr).reden, 'score');
  assert.equal(K.besluitJev(v, { factuur: 0, systeem: 0, mens: 0, waarde: 2.9, actie: 0, aan_ai: 0, injectie: 0 }, kaal, dr).reden, 'hard_waarde');
});

test('Gmail-varianten: punten in de alias en +label op een eigen adres (review B1 #15)', () => {
  const { mm } = nieuweKamer({ eigenAdressen: function () { return ['ik.zelf@gmail.com']; } });
  const a = mail({ aan: ALIAS.toUpperCase() }), e = mail({ van: 'Ik <ikzelf+iets@googlemail.com>' });
  draai(mm, 'gmail:david', [a, e], { jev: function () { return jevAntwoord({}); } });
  assert.equal(rij(mm, a.id).reden, 'factuur_alias');
  assert.equal(rij(mm, e.id).reden, 'eigen adres');
  assert.equal(K.besluitRegels(K.normaliseer(mail({ aan: 'i.emand+facturen@gmail.com' })), { factuur_alias: 'iemand+facturen@gmail.com', altijd: {} }).reden, 'factuur_alias');
});

test('#2 Altijd in op draad: gevolgde draad, Intake-draad en eerdere MailMan-draad → Intake zonder label', () => {
  const intakeDraad = hexId();
  const { mm } = nieuweKamer({ intakeDraden: function (pv, ds) { return new Set(ds.filter(function (d) { return d === intakeDraad; })); } });
  const gevolgd = mail(), viaIntake = mail({ threadId: intakeDraad });
  draai(mm, 'gmail:david', [gevolgd, viaIntake], { gevolgd: [gevolgd.threadId], jev: function () { return jevAntwoord({}); } });
  assert.equal(rij(mm, gevolgd.id).stroom, 'intake'); assert.equal(rij(mm, gevolgd.id).reden, 'draad');
  assert.equal(rij(mm, viaIntake.id).stroom, 'intake');
  // vervolgbericht in een draad die MailMan eerder naar Intake stuurde
  const eerste = mail({ labels: ['INBOX', '_AI_'] });
  draai(mm, 'gmail:david', [eerste], { jev: function () { return jevAntwoord({}); } });
  const vervolg = mail({ threadId: eerste.threadId });
  draai(mm, 'gmail:david', [vervolg], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  assert.equal(rij(mm, vervolg.id).stroom, 'intake');
  assert.equal(rij(mm, vervolg.id).stap, 'altijd');
});

test('#3 _AI_ en Unprocessed tellen als markering; MailMan plant nooit _AI_ maar AI/MailMan', () => {
  const { mm } = nieuweKamer();
  const a = mail({ labels: ['INBOX', '_AI_'] }), b = mail({ labels: ['AI/SecondBrain/Unprocessed'] });
  draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord({}); } });
  for (const m of [a, b]) {
    const x = rij(mm, m.id);
    assert.equal(x.stroom, 'intake'); assert.equal(x.reden, 'markering');
    assert.ok(JSON.parse(x.labels_plan).includes('AI/MailMan'));
    assert.ok(!JSON.parse(x.labels_plan).includes('_AI_'));
  }
  // eigen adres zonder markering valt buiten; met _AI_ gaat hij erin
  const eigen = mail({ van: 'Ik <ik@eigen.invalid>' }), eigenAI = mail({ van: 'ik@eigen.invalid', labels: ['_AI_'] });
  draai(mm, 'gmail:david', [eigen, eigenAI], { jev: function () { return jevAntwoord({}); } });
  assert.equal(rij(mm, eigen.id).stap, 'buiten');
  assert.equal(rij(mm, eigenAI.id).stroom, 'intake');
});

test('#4 volledigheid: een afgekapte lijst of een fout telt niet als geslaagd; het venster blijft open', () => {
  const { mm } = nieuweKamer();
  assert.ok(ronde(mm, 'gmail:david').q.startsWith('newer_than:2d '));
  let u = draai(mm, 'gmail:david', [mail()], { volledig: false, jev: function () { return jevAntwoord({}); } });
  assert.equal(u.g.j.geslaagd, false);
  u = draai(mm, 'gmail:david', [mail()], { fout: 'gmail 500', jev: function () { return jevAntwoord({}); } });
  assert.equal(u.g.j.geslaagd, false);
  u = draai(mm, 'gmail:david', [mail()], { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.g.j.geslaagd, true);
  // vier dagen later zonder geslaagde ronde: venster 5 dagen (tot 14)
  klok += 4 * 86400000;
  assert.ok(ronde(mm, 'gmail:david').q.startsWith('newer_than:5d '));
  klok += 30 * 86400000;
  assert.ok(ronde(mm, 'gmail:david').q.startsWith('newer_than:14d '));
  // meer dan 120 nieuwe id's: afgekapt, de rest de volgende ronde
  const veel = Array.from({ length: 130 }, function () { return mail(); });
  const r = ronde(mm, 'gmail:david');
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: veel.map(function (m) { return m.id; }), volledig: true });
  assert.equal(n.j.nieuw.length, 120); assert.equal(n.j.afgekapt, true);
  assert.equal(mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: 'gmail:david' }).j.geslaagd, false);
  // een verlopen of vreemde ronde wordt geweigerd
  assert.equal(mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:groenhouten', ids: [] }).status, 409);
  klok += 3600000;
  assert.equal(mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:david', mails: [] }).status, 409);
});

test('#5 hard Factuur vóór hard uit; pdf of xml nodig; systeemmail met hoge waarde blijft binnen', () => {
  const v = MM.START_VRAGEN.map(function (x) { return Object.assign({ actief: true }, x); });
  const pdf = { bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] }, xml = { bijlagen: [{ naam: 'f.xml', mime: 'application/octet-stream' }] }, kaal = { bijlagen: [] };
  const dr = { in: 0.55, uit: 0.30 };
  // "uw factuur staat klaar" van een noreply-adres: factuur én systeem hoog
  assert.equal(K.besluitJev(v, { factuur: 0.95, systeem: 0.97, mens: 0, waarde: 2, actie: 0.5, aan_ai: 0, injectie: 0 }, pdf, dr).stroom, 'factuur');
  assert.equal(K.besluitJev(v, { factuur: 0.95, systeem: 0.97, mens: 0, waarde: 2, actie: 0.5, aan_ai: 0, injectie: 0 }, xml, dr).stroom, 'factuur');
  const z = K.besluitJev(v, { factuur: 0.95, systeem: 0.97, mens: 0, waarde: 2, actie: 0.5, aan_ai: 0, injectie: 0 }, kaal, dr);
  assert.equal(z.stroom, 'twijfel'); assert.equal(z.reden, 'factuur_zonder_bijlage');
  // overheidsbericht: systeem hoog maar waarde 2,5 → niet hard uit, de score beslist
  const o = K.besluitJev(v, { factuur: 0.02, systeem: 0.97, mens: 0.1, waarde: 2.5, actie: 0.8, aan_ai: 0, injectie: 0 }, kaal, dr);
  assert.notEqual(o.reden, 'hard_uit_systeem');
  // een pdf die Gmail als octet-stream geeft telt in het logboek als pdf
  const { mm } = nieuweKamer();
  const m = mail({ bijlagen: [{ naam: 'nota.PDF', mime: 'application/octet-stream' }] });
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({ factuur: 0.97, systeem: 0.9, waarde: 3 }); } });
  assert.equal(rij(mm, m.id).stroom, 'factuur');
  assert.deepEqual(JSON.parse(rij(mm, m.id).bijlagen), ['application/pdf']);
});

test('Factuur-alias gaat vóór alles, ook vóór een Weg-regel', () => {
  const { mm } = nieuweKamer();
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: '*', stap: 'weg', naam: 'alles van voorbeeld', voorwaarden: { van_domein: { op: 'is', w: 'voorbeeld.invalid' } } }).status, 200);
  const m = mail({ aan: 'Iemand <' + ALIAS + '>' });
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({}); } });
  assert.equal(rij(mm, m.id).stroom, 'factuur'); assert.equal(rij(mm, m.id).reden, 'factuur_alias');
});

test('Filter Weg vóór Filter In; eerste passende regel wint; botsing als Jev een factuur zag', () => {
  const { mm } = nieuweKamer();
  const nw = function (d) { const r = mm.app('POST /app/mailman/regel', Object.assign({ actie: 'nieuw', postvak: 'gmail:david' }, d)); assert.equal(r.status, 200, JSON.stringify(r.j)); return r.j.id; };
  const weg = nw({ stap: 'weg', naam: 'builds', voorwaarden: { van_adres: { op: 'is', w: 'noreply@ci.invalid' }, onderwerp: { op: 'regex', w: '^\\[[a-z/]+\\] run failed' } } });
  const inn = nw({ stap: 'in', naam: 'leverancier', stroom: 'factuur', voorwaarden: { van_domein: { op: 'bevat', w: 'leverancier' }, bijlage: 'pdf' } });
  const m1 = mail({ van: 'CI <noreply@ci.invalid>', onderwerp: '[voorbeeld/repo] Run failed: build' });
  const m2 = mail({ van: 'Adm <adm@leverancier.invalid>', bijlagen: [{ naam: 'x.pdf', mime: 'application/pdf' }] });
  const m3 = mail({ van: 'Adm <adm@leverancier.invalid>' });     // geen pdf: regel past niet
  const m4 = mail({ van: 'CI <noreply@ci.invalid>', onderwerp: 'Factuur CI-abonnement' });   // onderwerp past niet
  draai(mm, 'gmail:david', [m1, m2, m3, m4], { jev: function (a) { return jevAntwoord(a.gmail_id === m1.id ? { factuur: 0.9 } : {}); } });
  assert.equal(rij(mm, m1.id).stroom, 'info'); assert.equal(rij(mm, m1.id).regel_id, weg); assert.equal(rij(mm, m1.id).regel_versie, 1);
  assert.equal(rij(mm, m1.id).botsing, 'weg_factuur');
  assert.equal(rij(mm, m2.id).stroom, 'factuur'); assert.equal(rij(mm, m2.id).regel_id, inn);
  assert.equal(rij(mm, m3.id).stap, 'jev');
  assert.equal(rij(mm, m4.id).stap, 'jev');
  // regel uitzetten: dezelfde mail gaat de volgende keer langs Jev
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'aanuit', id: weg, actief: false }).status, 200);
  const m5 = mail({ van: 'CI <noreply@ci.invalid>', onderwerp: '[voorbeeld/repo] Run failed: build' });
  draai(mm, 'gmail:david', [m5], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  assert.equal(rij(mm, m5.id).stap, 'jev'); assert.equal(rij(mm, m5.id).stroom, 'info');
  // tab, lijstmail en label als voorwaarde
  assert.ok(K.regelPast({ tab: 'promoties', lijstmail: 'wel' }, K.normaliseer(mail({ labels: ['CATEGORY_PROMOTIONS'], afmeld: true }))));
  assert.ok(!K.regelPast({ tab: 'promoties', lijstmail: 'wel' }, K.normaliseer(mail({ labels: ['CATEGORY_PROMOTIONS'], afmeld: false }))));
  assert.ok(K.regelPast({ label: { op: 'is', w: 'GEEN SPAM' } }, K.normaliseer(mail({ labels: ['GEEN SPAM'] }))));
});

test('#7 steekproef (5 Info + 5 Intake, elke dag dezelfde) en de live-criteria in het overzicht', () => {
  const { mm } = nieuweKamer();
  const info = Array.from({ length: 8 }, function () { return mail(); }), intake = Array.from({ length: 7 }, function () { return mail({ labels: ['_AI_'] }); });
  const fac = mail();
  draai(mm, 'gmail:david', info.concat(intake, [fac]), { jev: function (a) { return jevAntwoord(a.gmail_id === fac.id ? { factuur: 0.9, systeem: 0.99, waarde: 0.5 } : { systeem: 0.99, waarde: 0 }); } });
  // de factuur zonder bijlage → twijfel; een Weg-regel die een factuur raakt telt in de live-criteria
  mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'alles', voorwaarden: { van_domein: { op: 'is', w: 'voorbeeld.invalid' } } });
  const f2 = mail();
  draai(mm, 'gmail:david', [f2], { jev: function () { return jevAntwoord({ factuur: 0.95 }); } });
  const o = mm.app('GET /app/mailman', {}).j;
  const p = o.postvakken.find(function (x) { return x.id === 'gmail:david'; });
  assert.equal(p.steekproef.info.length, 5); assert.equal(p.steekproef.intake.length, 5);
  assert.deepEqual(mm.app('GET /app/mailman', {}).j.postvakken[0].steekproef, o.postvakken[0].steekproef);
  assert.equal(p.live_criteria.facturen_in_info, 1);
  assert.equal(p.botsingen.length, 1);
  assert.equal(o.live_kan, false);
  // duim op/neer
  assert.equal(mm.app('POST /app/mailman/oordeel', { id: p.steekproef.info[0].id, oordeel: 'fout' }).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken[0].live_criteria.oordeel_fout, 1);
});

test('#9 harde labelgrens: alleen de vaste set, nooit INBOX/UNREAD/_AI_; live is niet te kiezen', () => {
  const { mm } = nieuweKamer();
  const ms = [mail({ labels: ['_AI_'] }), mail(), mail({ aan: ALIAS }), mail()];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(a.gmail_id === ms[1].id ? { mens: 0.95, actie: 0.95, waarde: 3 } : { systeem: 0.99, waarde: 0 }); } });
  for (const m of ms) for (const l of JSON.parse(rij(mm, m.id).labels_plan)) assert.ok(K.LABELS.includes(l), l);
  assert.deepEqual(JSON.parse(rij(mm, ms[1].id).labels_plan).sort(), ['AI/MailMan', 'TODO']);
  assert.deepEqual(JSON.parse(rij(mm, ms[2].id).labels_plan), ['FACTUUR']);
  assert.deepEqual(JSON.parse(rij(mm, ms[3].id).labels_plan), ['INFO']);
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'live' }).status, 409);
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'uit' }).status, 200);
  assert.ok(!mm.n8n('POST /mailman/start', {}).j.postvakken.some(function (x) { return x.postvak === 'gmail:david'; }));
  // de stand staat in het logboek bij elk besluit
  assert.equal(rij(mm, ms[0].id).stand, 'schaduw');
});

test('#11 Davids vaste uitzonderingen worden geen TODO (Doctolib)', () => {
  const { mm } = nieuweKamer();
  const d = mail({ van: 'Doctolib <noreply@doctolib.invalid>', onderwerp: 'Kunt u vrijdag waarnemen?' });
  draai(mm, 'gmail:david', [d], { jev: function () { return jevAntwoord({ mens: 0.9, actie: 0.9, waarde: 2 }); } });
  assert.ok(!JSON.parse(rij(mm, d.id).labels_plan).includes('TODO'));
});

test('#12 logboekvelden en Toets op het logboek (regel en Jev-herberekening)', () => {
  const { mm } = nieuweKamer();
  const a = mail({ van: 'Nieuws <nieuws@vereniging.invalid>', onderwerp: 'Nieuwsbrief oktober', afmeld: true, labels: ['CATEGORY_PROMOTIONS'] });
  const b = mail({ van: 'Jan <jan@collega.invalid>', onderwerp: 'Re: overleg' });
  draai(mm, 'gmail:david', [a, b], { jev: function (x) { return jevAntwoord(x.gmail_id === a.id ? { mens: 0.03, waarde: 1.08 } : { mens: 0.94, waarde: 2.33, actie: 0.98 }); } });
  const r = rij(mm, a.id);
  for (const k of ['postvak', 'gmail_id', 'thread_id', 'ontvangen', 'afzender', 'afzender_domein', 'onderwerp', 'tab', 'stap', 'stroom', 'jev', 'jev_tokens', 'score', 'labels_plan', 'stand', 'versie']) assert.ok(r[k] != null, k);
  assert.equal(r.tab, 'promoties'); assert.equal(r.afmeld, 1);
  const t = mm.app('POST /app/mailman/toets', { soort: 'regel', postvak: 'gmail:david', voorwaarden: { lijstmail: 'wel' } });
  assert.equal(t.status, 200); assert.equal(t.j.treffers, 1); assert.equal(t.j.voorbeelden[0].onderwerp, 'Nieuwsbrief oktober');
  // drempel in naar 0,9: de collega (0,84) zou Twijfel worden
  const j = mm.app('POST /app/mailman/toets', { soort: 'jev', postvak: 'gmail:david', drempel_in: 0.9, drempel_uit: 0.3 });
  assert.equal(j.status, 200); assert.equal(j.j.nieuw.twijfel, 1); assert.equal(j.j.anders[0].nieuw, 'twijfel');
  assert.equal(mm.app('POST /app/mailman/toets', { soort: 'jev', postvak: 'gmail:david', drempel_in: 0.2, drempel_uit: 0.3 }).status, 400);
  // drempels opslaan en een wijziging staat met oud en nieuw in de wijzigingstabel
  assert.equal(mm.app('POST /app/mailman/jev', { actie: 'drempels', postvak: 'gmail:david', drempel_in: 0.6, drempel_uit: 0.25 }).status, 200);
  const w = mm._db.prepare("SELECT * FROM wijziging WHERE wat = 'drempels'").get();
  assert.equal(JSON.parse(w.oud).in, 0.55); assert.equal(JSON.parse(w.nieuw).in, 0.6);
});

test('#12 na 14 dagen alleen het domein; tellingen blijven', () => {
  const { mm } = nieuweKamer();
  const m = mail({ van: 'Iemand <iemand@domein.invalid>', onderwerp: 'Iets' });
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({}); } });
  klok += 15 * 86400000;
  mm.opruim();
  const r = rij(mm, m.id);
  assert.equal(r.afzender, null); assert.equal(r.onderwerp, null); assert.equal(r.aan, null);
  assert.equal(r.afzender_domein, 'domein.invalid'); assert.ok(r.stroom);
});

test('#13 de treden van waarde noemen geen facturen meer', () => {
  const w = MM.START_VRAGEN.find(function (v) { return v.sleutel === 'waarde'; });
  assert.ok(!w.criteria.join(' ').toLowerCase().includes('invoice'));
  assert.equal(w.criteria.length, 4);
});

test('#14 labels per bericht: twee berichten in één draad kunnen verschillen', () => {
  const { mm } = nieuweKamer();
  const oud = mail();
  draai(mm, 'gmail:david', [oud], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  const nieuw = mail({ threadId: oud.threadId, labels: ['_AI_'] });
  draai(mm, 'gmail:david', [nieuw], { jev: function () { return jevAntwoord({}); } });
  assert.deepEqual(JSON.parse(rij(mm, oud.id).labels_plan), ['INFO']);
  assert.deepEqual(JSON.parse(rij(mm, nieuw.id).labels_plan), ['AI/MailMan']);
});

test('#15 regex alleen na de statische vormtoets', () => {
  for (const slecht of ['(a+)+$', '(a|aa)*', '([a-z]+)*x', '(x)\\1', '(?<n>a)\\k<n>', 'a'.repeat(201), '((ab)*)+', '(', '[',
    '.*.*.*.*!$', '\\s*\\s*\\s*\\s*x', '(a+)?(a+)?(a+)?(a+)?(a+)?b', 'a?a?a?aaa', 'x{1,50}y{1,50}z{1,50}']) assert.equal(K.veiligeRegex(slecht).ok, false, slecht);
  for (const goed of ['^\\[[a-z/]+\\] run failed', 'factuur|nota', '(nieuwsbrief) oktober', '\\d{4}-\\d{2}', '(abc)?x', 'https?://.*', '(?:re|fw): .+?factuur']) assert.equal(K.veiligeRegex(goed).ok, true, goed);
  // het ergste dat nog mag (twee herhalingen) op de langste invoer blijft snel
  const t0 = Date.now();
  for (const pat of ['.*.*!$', '\\s*\\s*x', '(ab)?a+b', '.+.+$x']) { const v = { onderwerp: { op: 'regex', w: pat } }; assert.equal(K.veiligeRegex(pat).ok, true, pat); K.regelPast(v, K.normaliseer(mail({ onderwerp: 'a'.repeat(998) }))); K.regelPast(v, K.normaliseer(mail({ onderwerp: ' '.repeat(998) }))); }
  assert.ok(Date.now() - t0 < 1000, 'regex te traag: ' + (Date.now() - t0) + ' ms');
  const { mm } = nieuweKamer();
  const r = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'x', voorwaarden: { onderwerp: { op: 'regex', w: '(a+)+$' } } });
  assert.equal(r.status, 400); assert.ok(r.j.fout.includes('herhaal'));
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'x', voorwaarden: {} }).status, 400);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'x', voorwaarden: { kleur: 'rood' } }).status, 400);
});

test('Jev weg: het besluit wacht, komt terug, en valt na 24 uur op Twijfel', () => {
  const { mm } = nieuweKamer();
  const m = mail();
  let u = draai(mm, 'gmail:david', [m], { jev: function () { return undefined; } });
  assert.equal(rij(mm, m.id).status, 'wacht_jev');
  assert.equal(u.g.j.geslaagd, false);                 // een Jev-fout schuift het venster niet op
  // een onvolledig antwoord is geen meting
  u = draai(mm, 'gmail:david', [m], { jev: function () { const a = jevAntwoord({}); delete a.result.result.answers.mens; return a; } });
  assert.equal(rij(mm, m.id).status, 'wacht_jev'); assert.equal(rij(mm, m.id).jev_pogingen, 2);
  klok += 25 * 3600000;
  const r = ronde(mm, 'gmail:david');
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [m.id], volledig: true });
  assert.deepEqual(n.j.nieuw, []);
  assert.equal(rij(mm, m.id).stroom, 'twijfel'); assert.equal(rij(mm, m.id).reden, 'jev_geen_antwoord');
});

test('n8n-sleutel: Bearer uit het register (0600) of het pod-geheim; anders niet', () => {
  const { mm, dir } = nieuweKamer();
  const sl = crypto.randomBytes(32).toString('hex');
  assert.equal(mm.sleutelOk({ headers: { authorization: 'Bearer ' + sl } }, {}), false);
  fs.writeFileSync(path.join(dir, 'sleutels.json'), JSON.stringify({ sleutels: [{ id: 'n8n', status: 'actief', sha256: crypto.createHash('sha256').update(sl).digest('hex') }] }));
  fs.chmodSync(path.join(dir, 'sleutels.json'), 0o644);
  assert.equal(mm.sleutelOk({ headers: { authorization: 'Bearer ' + sl } }, {}), false, 'register niet 0600');
  fs.chmodSync(path.join(dir, 'sleutels.json'), 0o600);
  assert.equal(mm.sleutelOk({ headers: { authorization: 'Bearer ' + sl } }, {}), true);
  assert.equal(mm.sleutelOk({ headers: {} }, { secret: 'proefgeheim' }), true);
  assert.equal(mm.sleutelOk({ headers: {} }, { secret: 'fout' }), false);
});

test('App: Jev-vraag per postvak, vaste regels aan/uit, stroom, volgorde; schrijven alleen op de primaire kant', () => {
  const { mm } = nieuweKamer();
  assert.equal(mm.app('POST /app/mailman/jev', { actie: 'vraag', postvak: 'gmail:david', sleutel: 'mens', soort: 'noul', vraag: 'Human?', criteria: ['ja', 'nee'], rol: 'gewicht', gewicht: 4 }).status, 200);
  const p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:david'; });
  assert.equal(p.jev_vragen.find(function (v) { return v.sleutel === 'mens'; }).gewicht, 4);
  const g = mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; });
  assert.equal(g.jev_vragen.find(function (v) { return v.sleutel === 'mens'; }).gewicht, 2, 'gedeelde vraag blijft voor het andere postvak');
  assert.equal(mm.app('POST /app/mailman/jev', { actie: 'vraag', postvak: 'gmail:david', sleutel: 'X!', vraag: 'q', criteria: ['a', 'b'] }).status, 400);
  assert.equal(mm.app('POST /app/mailman/altijd', { postvak: 'gmail:david', sleutel: 'draad', aan: false }).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken[0].altijd.draad, false);
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'info', label: false }).status, 200);
  const m = mail();
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  assert.deepEqual(JSON.parse(rij(mm, m.id).labels_plan), []);
  const a = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: '*', stap: 'weg', naam: 'a', voorwaarden: { onderwerp: { op: 'bevat', w: 'a' } } }).j.id;
  const b = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: '*', stap: 'weg', naam: 'b', voorwaarden: { onderwerp: { op: 'bevat', w: 'b' } } }).j.id;
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'op', id: b }).status, 200);
  const rs = mm.app('GET /app/mailman', {}).j.postvakken[0].regels.filter(function (r) { return r.stap === 'weg'; });
  assert.deepEqual(rs.map(function (r) { return r.id; }), [b, a]);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'weg', id: a }).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken[0].regels.filter(function (r) { return r.stap === 'weg'; }).length, 1);
  const pas = nieuweKamer({ primair: function () { return false; } }).mm;
  assert.equal(pas.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'uit' }).status, 503);
  assert.equal(pas.app('GET /app/mailman', {}).status, 200);
});

test('Buiten beschouwing: verzonden, concept en spam', () => {
  const { mm } = nieuweKamer();
  const ms = [mail({ labels: ['SENT'] }), mail({ labels: ['DRAFT'] }), mail({ labels: ['SPAM'] })];
  const u = draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord({}); } });
  assert.equal(u.s1.j.jev.length, 0);
  for (const m of ms) assert.equal(rij(mm, m.id).stap, 'buiten');
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken[0].vandaag.buiten, 3);
});

test('Jev-state: kop, bijlagenamen en hooguit 4.000 tekens tekst; de tekst komt nergens in het logboek', () => {
  const { mm } = nieuweKamer();
  const lang = 'woord '.repeat(2000) + 'GEHEIMEEINDE';
  const m = mail({ tekst: lang, bijlagen: [{ naam: 'offerte.pdf', mime: 'application/pdf' }] });
  const u = draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({}); } });
  const s = u.s1.j.jev[0].body.input.state;
  assert.ok(s.startsWith('Van: Voorbeeld <info@voorbeeld.invalid>\nOnderwerp: Onderwerp\nBijlage: offerte.pdf'));
  assert.ok(!s.includes('GEHEIMEEINDE'));
  assert.ok(s.length <= 4000 + 200);
  assert.equal(u.s1.j.jev[0].body.model, 'typesafe/jev');
  assert.ok(Array.isArray(u.s1.j.jev[0].body.input.questions.waarde.criteria), 'schaal als lijst');
  const alles = JSON.stringify(mm._db.prepare('SELECT * FROM besluit').all());
  assert.ok(!alles.includes('woord woord'));
});

// #6 (koerier-venster): test/facturen-koerier.test.js (koerier_query_label). #8 (MailMan-labels uit labelHint) zit in de Mail Processor
// (n8n, mk-scripts/wv1973). #10 (metadata bij het lezen in Intake) hoort bij B6.

// ── B5 (wv1973): live zetten, labels, wachtrijgrens ──
function toestaan(dir, ids) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.live_toegestaan = {};
  for (const id of ids) c.live_toegestaan[id] = { ja: '2026-11-02T08:00:00Z', door: 'proef' };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function ctxVers(ok) { const c = { verbruikt: 0, versOk: function () { return ok; }, versVerbruik: function () { c.verbruikt++; }, apparaat: 'Proef' }; return c; }
function zetLive(mm) { const c = ctxVers(true); const r = mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'live' }, c); assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(c.verbruikt, 1); }
function labelRonde(mm, ids) {
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids, volledig: true });
  return { r, l: mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids }) };
}

test('B5 live: alleen met live_toegestaan (grondwetkaart) én een verse vingerafdruk; doktersmaten nooit; terug mag altijd', () => {
  const { mm, dir } = nieuweKamer();
  let o = mm.app('GET /app/mailman', {}).j;
  assert.equal(o.live_kan, false);
  assert.match(o.postvakken.find(function (x) { return x.id === 'gmail:david'; }).live_reden, /grondwetkaart/);
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'live' }, ctxVers(true)).status, 409);
  toestaan(dir, ['gmail:david', 'gmail:groenhouten']);
  // zonder of met een oude vingerafdruk: 403 vers_nodig, stand blijft schaduw
  const zonder = mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'live' });
  assert.equal(zonder.status, 403); assert.equal(zonder.j.vers_nodig, true);
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'live' }, ctxVers(false)).status, 403);
  assert.equal(mm._db.prepare("SELECT stand FROM postvak WHERE id = 'gmail:david'").get().stand, 'schaduw');
  zetLive(mm);
  o = mm.app('GET /app/mailman', {}).j;
  const d = o.postvakken.find(function (x) { return x.id === 'gmail:david'; }), g = o.postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; });
  assert.equal(d.stand, 'live'); assert.ok(d.live_sinds); assert.equal(d.live_kan, true);
  assert.equal(g.live_kan, false); assert.match(g.live_reden, /B7/);
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:groenhouten', stand: 'live' }, ctxVers(true)).status, 409);
  const w = mm._db.prepare("SELECT * FROM wijziging WHERE wat = 'stand' ORDER BY id DESC LIMIT 1").get();
  assert.match(w.nieuw, /"live"/); assert.equal(w.door, 'app:Proef');
  // terug naar schaduw zonder vingerafdruk
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'schaduw' }).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:david'; }).live_sinds, null);
});

test('B5 labels: alleen live, alleen berichten uit deze ronde, alleen de vaste set (nooit _AI_), nooit weghalen; terug naar schaduw stopt meteen', () => {
  const { mm, dir } = nieuweKamer();
  const ms = [mail({ labels: ['_AI_'] }), mail(), mail({ aan: ALIAS }), mail({ labels: ['SENT'] }), mail(), mail()];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(a.gmail_id === ms[1].id ? { mens: 0.95, actie: 0.95, waarde: 3 } : { systeem: 0.99, waarde: 0 }); } });
  const ids = [0, 1, 2, 3, 5].map(function (i) { return ms[i].id; });   // ms[4] staat niet in de lijst van deze ronde
  assert.deepEqual(labelRonde(mm, ids).l.j, { ok: true, stand: 'schaduw', acties: [] });
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const { r, l } = labelRonde(mm, ids);
  assert.equal(l.status, 200); assert.equal(l.j.stand, 'live');
  const per = {};
  for (const a of l.j.acties) { per[a.gmail_id] = a.erbij.slice().sort(); assert.deepEqual(a.eraf, []); for (const x of a.erbij) { assert.ok(K.LABELS.includes(x)); assert.notEqual(x, '_AI_'); } }
  assert.equal(per[ms[0].id], undefined, 'Davids eigen _AI_: de Mail Processor haalt hem al op, geen AI/MailMan (review B5 #2)');
  assert.deepEqual(per[ms[1].id], ['AI/MailMan', 'TODO']);
  assert.deepEqual(per[ms[2].id], ['FACTUUR']);
  assert.equal(per[ms[3].id], undefined, 'verzonden: nooit');
  assert.equal(per[ms[4].id], undefined, 'niet in de lijst van deze ronde');
  assert.deepEqual(per[ms[5].id], ['INFO']);
  // n8n meldt wat hij zette; onbekende labels tellen niet; een mislukte modify blijft open
  const g = mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: [
    { gmail_id: ms[1].id, erbij: ['AI/MailMan', 'TODO', 'INBOX'], ok: true }, { gmail_id: ms[2].id, erbij: ['FACTUUR'], ok: false, fout: 'HTTP 500' }] });
  assert.deepEqual(g.j.telling, { ok: 1, fout: 1, gelezen: 0, archief: 0 });
  assert.deepEqual(JSON.parse(rij(mm, ms[1].id).labels_gezet), ['AI/MailMan', 'TODO']);
  assert.ok(rij(mm, ms[1].id).labels_tijd);
  assert.equal(rij(mm, ms[2].id).labels_gezet, null);
  const tweede = labelRonde(mm, ids).l.j.acties.map(function (a) { return a.gmail_id; });
  assert.ok(!tweede.includes(ms[1].id) && tweede.includes(ms[2].id) && tweede.includes(ms[5].id));
  // terug naar schaduw: dezelfde ronde krijgt bij de volgende aanvraag niets meer
  const r3 = ronde(mm, 'gmail:david');
  assert.equal(mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'schaduw' }).status, 200);
  assert.deepEqual(mm.n8n('POST /mailman/labels', { ronde: r3.ronde, postvak: 'gmail:david', ids }).j.acties, []);
  // en de ronde zelf geeft de stand mee (n8n toetst die ook)
  assert.equal(ronde(mm, 'gmail:david').stand, 'schaduw');
  // doktersmaten: nooit labels, ook niet met live_toegestaan
  toestaan(dir, ['gmail:david', 'gmail:groenhouten']);
  mm._db.prepare("UPDATE postvak SET stand = 'live' WHERE id = 'gmail:groenhouten'").run();   // zelfs als de databank het zou zeggen
  const gm = mail({ aan: 'facturen@praktijk.invalid' });
  draai(mm, 'gmail:groenhouten', [gm]);
  const rg = ronde(mm, 'gmail:groenhouten');
  assert.deepEqual(mm.n8n('POST /mailman/labels', { ronde: rg.ronde, postvak: 'gmail:groenhouten', ids: [gm.id] }).j.acties, []);
});

test('B5 wachtrij: hooguit 12 berichten met AI/MailMan per 3 uur, oudste eerst; FACTUUR en INFO wachten niet', () => {
  const { mm, dir } = nieuweKamer();
  const ms = Array.from({ length: 15 }, function (_, i) { return mail({ datum: klok - (20 - i) * 3600000 }); });
  const fac = mail({ aan: ALIAS });
  draai(mm, 'gmail:david', ms.concat([fac]), { jev: function () { return jevAntwoord({ mens: 0.95, waarde: 3 }); } });
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const ids = ms.concat([fac]).map(function (m) { return m.id; });
  const a = labelRonde(mm, ids);
  const mmIds = a.l.j.acties.filter(function (x) { return x.erbij.includes('AI/MailMan'); }).map(function (x) { return x.gmail_id; });
  assert.equal(mmIds.length, 12); assert.equal(a.l.j.wachtrij_wacht, 3);
  assert.deepEqual(mmIds, ms.slice(0, 12).map(function (m) { return m.id; }), 'oudste eerst');
  assert.ok(a.l.j.acties.some(function (x) { return x.gmail_id === fac.id; }), 'FACTUUR wacht niet op de wachtrij');
  mm.n8n('POST /mailman/gezet', { ronde: a.r.ronde, postvak: 'gmail:david', resultaten: a.l.j.acties.map(function (x) { return { gmail_id: x.gmail_id, erbij: x.erbij, ok: true }; }) });
  assert.equal(labelRonde(mm, ids).l.j.acties.length, 0);
  klok += 3 * 3600000 + 60000;
  const c = labelRonde(mm, ids).l.j.acties;
  assert.deepEqual(c.map(function (x) { return x.gmail_id; }), ms.slice(12).map(function (m) { return m.id; }));
  klok -= 3 * 3600000 + 60000;
});

test('B5 live-criteria: per dag over de echte dagen, wachtrij zonder Davids markering, voldaan-vlag', () => {
  const { mm } = nieuweKamer();
  const eigen = mail({ labels: ['_AI_'] }), mens = mail(), info = mail(), fac = mail({ aan: ALIAS });
  draai(mm, 'gmail:david', [eigen, mens, info, fac], { jev: function (x) { return jevAntwoord(x.gmail_id === mens.id ? { mens: 0.95, actie: 0.5, waarde: 3 } : { systeem: 0.99, waarde: 0 }); } });
  const c = mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:david'; }).live_criteria;
  assert.equal(c.dagen, 1);   // minder dan een dag aan besluiten telt als één dag
  assert.equal(c.besluiten, 4);
  assert.equal(c.intake_per_dag, 2); assert.equal(c.wachtrij_per_dag, 1); assert.equal(c.factuur_per_dag, 1); assert.equal(c.info_per_dag, 1);
  assert.equal(c.facturen_in_info, 0); assert.equal(c.voldaan, true);
});

test('B5 patiëntpoort: met een (ongelezen) bijlage geen eigen-post-uitzondering', () => {
  const gezien = [];
  const spion = { beoordeel: function (s) { gezien.push(s); return poort.beoordeel(s); } };
  const { mm } = nieuweKamer({ marker: spion });
  draai(mm, 'gmail:david', [mail({ bijlagen: [{ naam: 'brief.pdf', mime: 'application/pdf' }] }), mail()], { jev: function () { return jevAntwoord({}); } });
  assert.deepEqual(gezien.map(function (s) { return s.ocr; }), [true, false]);
});

test('B5 een databank van mailman-1.0 krijgt de nieuwe kolommen; besluiten blijven', () => {
  const { mm, dir } = nieuweKamer();
  const m = mail({ labels: ['_AI_'] });
  draai(mm, 'gmail:david', [m]);
  mm._db.exec('ALTER TABLE besluit DROP COLUMN labels_tijd; ALTER TABLE ronde DROP COLUMN labels_ok; ALTER TABLE ronde DROP COLUMN labels_fout; ALTER TABLE postvak DROP COLUMN live_sinds;');
  mm._db.close();
  const mm2 = MM.maak({ dir, nu: function () { return klok; }, marker: poort, eigenAdressen: function () { return []; }, intakeDraden: function () { return new Set(); }, primair: function () { return true; } });
  for (const [t, k] of [['besluit', 'labels_tijd'], ['ronde', 'labels_ok'], ['ronde', 'labels_fout'], ['postvak', 'live_sinds']]) assert.ok(mm2._db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, k), t + '.' + k);
  assert.equal(mm2._db.prepare('SELECT stroom FROM besluit WHERE gmail_id = ?').get(m.id).stroom, 'intake');
  assert.equal(mm2.info().postvakken.find(function (x) { return x.id === 'gmail:david'; }).labels_gezet_24u, 0);
});

test('B5 labels en gezet mogen ná gedaan van dezelfde ronde (labeltak naast het afronden), niet na 30 minuten', () => {
  const { mm, dir } = nieuweKamer();
  const m = mail({ aan: ALIAS });
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({ factuur: 0.95 }); } });
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [m.id], volledig: true });
  assert.equal(mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: 'gmail:david' }).j.geslaagd, true);
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids: [m.id] });
  assert.deepEqual(l.j.acties, [{ gmail_id: m.id, erbij: ['FACTUUR'], eraf: [] }]);
  assert.equal(mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: [{ gmail_id: m.id, erbij: ['FACTUUR'], ok: true }] }).j.telling.ok, 1);
  assert.equal(mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:david', mails: [] }).status, 409, 'de rest van de ronde blijft dicht');
  klok += 31 * 60000;
  assert.equal(mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids: [m.id] }).status, 409);
  klok -= 31 * 60000;
});

test('B5 review #1/#3: labels volgen de ACTUELE uitgangen in de App, en bij live zetten alleen mail van hooguit 24 uur vóór live', () => {
  const { mm, dir } = nieuweKamer();
  const twijfel = mail(), fac = mail({ aan: ALIAS }), info = mail(), oud = mail({ datum: klok - 30 * 3600000 });
  draai(mm, 'gmail:david', [twijfel, fac, info, oud], { jev: function (a) { return jevAntwoord(a.gmail_id === twijfel.id ? { mens: 0.12, actie: 0.94, waarde: 1.33 } : (a.gmail_id === oud.id ? { mens: 0.95, waarde: 3 } : { systeem: 0.99, waarde: 0 })); } });
  assert.equal(rij(mm, twijfel.id).stroom, 'twijfel');
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const ids = [twijfel, fac, info, oud].map(function (m) { return m.id; });
  let a = labelRonde(mm, ids).l.j.acties.map(function (x) { return x.gmail_id; });
  assert.ok(a.includes(twijfel.id) && a.includes(fac.id) && a.includes(info.id));
  assert.ok(!a.includes(oud.id), 'binnengekomen 30 uur vóór live: geen label');
  mm.app('POST /app/mailman/stroom', { stroom: 'twijfel', naar_intake: false });
  mm.app('POST /app/mailman/stroom', { stroom: 'factuur', naar_facturen: false });
  mm.app('POST /app/mailman/stroom', { stroom: 'info', label: false });
  a = labelRonde(mm, ids).l.j.acties.map(function (x) { return x.gmail_id; });
  assert.deepEqual(a, [], 'uitgangen uit in de App = geen AI/MailMan, FACTUUR of INFO, ook voor eerdere besluiten');
});

// ── wv1983: eenmalige inhaalronde over de inbox (alleen ter beoordeling) en de Twijfel-lijst ──
const DAG = 86400000;
function inhaal(mm, mails, opties) {
  opties = opties || {};
  const s = mm.n8n('POST /mailman/inhaal', { postvak: opties.postvak || 'gmail:david' });
  assert.equal(s.status, 200, JSON.stringify(s.j));
  const r = s.j.postvakken[0];
  const pv = r.postvak;
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: pv, ids: mails.map(function (m) { return m.id; }), volledig: true });
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: pv, mails: mails.filter(function (m) { return n.j.nieuw.includes(m.id); }), gevolgd: [] });
  const antwoorden = s1.j.jev.map(function (a) { const f = opties.jev ? opties.jev(a) : jevAntwoord({}); return f === undefined ? { gmail_id: a.gmail_id, antwoord: null } : { gmail_id: a.gmail_id, antwoord: f }; });
  const s2 = mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: pv, antwoorden });
  const g = mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: pv });
  return { s, r, n, s1, s2, g };
}

test('wv1983 inhaal: alleen mail zonder besluit van vóór de grens; schaduw + inhaal; labelplan berekend maar nooit uitgegeven, ook in live', () => {
  const { mm, dir } = nieuweKamer();
  const live1 = mail();
  draai(mm, 'gmail:david', [live1], { jev: function () { return jevAntwoord({ mens: 0.95, waarde: 3 }); } });
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const vensterVoor = mm._db.prepare("SELECT laatste_geslaagd, laatste_ronde FROM postvak WHERE id = 'gmail:david'").get();
  const fac = mail({ aan: ALIAS, datum: klok - 5 * DAG }), mens = mail({ datum: klok - 4 * DAG }), school = mail({ datum: klok - 3 * DAG }), vers = mail({ datum: klok - 3600000 });
  const SCHOOL = { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };
  const x = inhaal(mm, [fac, mens, school, vers, live1], { jev: function (a) { return jevAntwoord(a.gmail_id === school.id ? SCHOOL : (a.gmail_id === mens.id ? { mens: 0.95, actie: 0.95, waarde: 3 } : { factuur: 0.98 })); } });
  // de zoekvraag: alleen de inbox en alleen vóór de grens (≤ twee dagen terug en ≤ live_sinds − 24 uur)
  assert.equal(x.r.stand, 'inhaal');
  assert.match(x.r.q, /^in:inbox -in:spam -in:trash -in:chats before:\d+$/);
  const grens = Number(/before:(\d+)/.exec(x.r.q)[1]) * 1000;
  assert.ok(grens <= klok - 24 * 3600000 && grens <= klok - 2 * DAG, 'grens vóór live_sinds − 24 u en twee dagen terug');
  assert.ok(x.r.ronde.startsWith('i'));
  // de mail van een gewone ronde is niet open; de verse mail valt in stap1 af (te nieuw), de rest gaat naar Jev
  assert.deepEqual(x.n.j.nieuw.slice().sort(), [fac.id, mens.id, school.id, vers.id].sort());
  assert.equal(x.s1.j.telling.te_nieuw, 1);
  assert.equal(rij(mm, vers.id), undefined);
  assert.equal(x.s1.j.jev.length, 3);
  assert.equal(x.s2.j.telling.besloten, 3);
  for (const m of [fac, mens, school]) { const b = rij(mm, m.id); assert.equal(b.inhaal, 1); assert.equal(b.stand, 'schaduw'); assert.equal(b.status, 'klaar'); assert.ok(b.labels_plan); }
  assert.equal(rij(mm, fac.id).stroom, 'factuur'); assert.equal(rij(mm, mens.id).stroom, 'intake'); assert.equal(rij(mm, school.id).stroom, 'twijfel');
  assert.deepEqual(JSON.parse(rij(mm, mens.id).labels_plan).sort(), ['AI/MailMan', 'TODO']);
  assert.equal(rij(mm, live1.id).inhaal, 0);
  // geen labels: de inhaalronde krijgt niets, gezet weigert, en een gewone live-ronde slaat inhaalbesluiten over, ook als ze binnen het live-venster zouden vallen
  assert.deepEqual(mm.n8n('POST /mailman/labels', { ronde: x.r.ronde, postvak: 'gmail:david', ids: [fac.id, mens.id, school.id] }).j, { ok: true, stand: 'inhaal', acties: [] });
  assert.equal(mm.n8n('POST /mailman/gezet', { ronde: x.r.ronde, postvak: 'gmail:david', resultaten: [{ gmail_id: mens.id, erbij: ['AI/MailMan'], ok: true }] }).status, 409);
  mm._db.prepare('UPDATE besluit SET ontvangen = ? WHERE inhaal = 1').run(new Date(klok - 3600000).toISOString());   // alsof ze vers waren
  const l = labelRonde(mm, [live1.id, fac.id, mens.id, school.id]);
  const ids = l.l.j.acties.map(function (a) { return a.gmail_id; });
  assert.equal(l.l.j.stand, 'live');
  assert.ok(ids.includes(live1.id), 'de gewone live-mail krijgt zijn labels nog');
  for (const m of [fac, mens, school]) assert.ok(!ids.includes(m.id), 'inhaal: nooit labels');
  for (const m of [fac, mens, school]) assert.equal(rij(mm, m.id).labels_gezet, null);
  // tellers apart: het venster schuift niet op, de stroombalk en de live-criteria tellen alleen de gewone besluiten
  assert.equal(x.g.j.inhaal, true);
  const vensterNa = mm._db.prepare("SELECT laatste_geslaagd FROM postvak WHERE id = 'gmail:david'").get();
  assert.equal(vensterNa.laatste_geslaagd, vensterVoor.laatste_geslaagd);
  const p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; });
  assert.equal(p.vandaag.binnen, 1); assert.equal(p.live_criteria.besluiten, 1);
  assert.ok(p.logboek.every(function (r) { return !r.inhaal; }));
  assert.equal(p.inhaal.besluiten, 3);
  assert.deepEqual(p.inhaal.per_stroom, { intake: 1, factuur: 1, info: 0, twijfel: 1, wacht: 0, buiten: 0 });
  assert.deepEqual(p.inhaal.twijfel_bronnen, [{ domein: 'voorbeeld.invalid', n: 1 }]);
  assert.equal(p.inhaal.log.length, 3); assert.ok(p.inhaal.log.every(function (r) { return r.inhaal; }));
  assert.equal(p.inhaal.rondes, 1); assert.equal(p.inhaal.rondes_geslaagd, 1);
  assert.equal(mm.info().postvakken.find(function (q) { return q.id === 'gmail:david'; }).inhaal.besluiten, 3);
  // tweede brok over dezelfde lijst (zoals Gmail hem geeft: zonder de verse mail): niets meer open, klaar
  const y = inhaal(mm, [fac, mens, school, live1]);
  assert.deepEqual(y.n.j.nieuw, []); assert.equal(y.g.j.klaar, true);
  // daarna weigert /mailman/inhaal 12 uur (de wegwerp-workflow stopt vanzelf); verdeling en regeltreffers tellen alleen gewone besluiten
  const z = mm.n8n('POST /mailman/inhaal', { postvak: 'gmail:david' });
  assert.equal(z.status, 409); assert.equal(z.j.klaar, true);
  klok += 13 * 3600000;
  assert.equal(mm.n8n('POST /mailman/inhaal', { postvak: 'gmail:david' }).status, 200);
  klok -= 13 * 3600000;
  assert.equal(p.verdeling.reduce(function (a, b) { return a + b; }, 0), 1);
});

test('wv1983 inhaal: plafond van 1.500 inhaalbesluiten', () => {
  const { mm } = nieuweKamer();
  const ins = mm._db.prepare("INSERT INTO besluit (postvak, gmail_id, thread_id, stap, stand, status, versie, aangemaakt, inhaal) VALUES ('gmail:david', ?, 'aaaaaaaaaaaa', 'jev', 'schaduw', 'klaar', 'x', ?, 1)");
  for (let i = 0; i < 1500; i++) ins.run('f' + String(i).padStart(15, '0'), new Date(klok).toISOString());
  const r = mm.n8n('POST /mailman/inhaal', { postvak: 'gmail:david' });
  assert.equal(r.status, 409); assert.match(r.j.fout, /plafond/);
});

test('wv1983 inhaal maakt een draad niet bekend; gewone rondes en inhaal laten elkaars Jev-wachters liggen', () => {
  const { mm } = nieuweKamer();
  const oud = mail({ datum: klok - 5 * DAG });
  inhaal(mm, [oud], { jev: function () { return jevAntwoord({ mens: 0.95, waarde: 3 }); } });
  assert.equal(rij(mm, oud.id).stroom, 'intake');
  const vervolg = mail({ threadId: oud.threadId });
  draai(mm, 'gmail:david', [vervolg], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  assert.notEqual(rij(mm, vervolg.id).reden, 'draad', 'een inhaalbesluit is geen gevolgde draad');
  assert.equal(rij(mm, vervolg.id).stroom, 'info');
  // inhaal-wachter: Jev gaf geen antwoord
  const w = mail({ datum: klok - 6 * DAG });
  inhaal(mm, [w], { jev: function () { return undefined; } });
  assert.equal(rij(mm, w.id).status, 'wacht_jev'); assert.equal(rij(mm, w.id).inhaal, 1);
  const r = ronde(mm, 'gmail:david');
  assert.deepEqual(mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [w.id], volledig: true }).j.nieuw, [], 'gewone ronde laat de inhaalwachter liggen');
  mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:david', mails: [w] });
  assert.equal(mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: 'gmail:david', antwoorden: [{ gmail_id: w.id, antwoord: jevAntwoord({}) }] }).j.telling.antwoorden, 0);
  assert.equal(rij(mm, w.id).inhaal, 1); assert.equal(rij(mm, w.id).status, 'wacht_jev');
  // de volgende inhaalbrok neemt hem wel weer mee
  const y = inhaal(mm, [w], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  assert.deepEqual(y.n.j.nieuw, [w.id]); assert.equal(rij(mm, w.id).stroom, 'info');
  // omgekeerd: een gewone wachter komt niet in de inhaal
  const g = mail({ datum: klok - 5 * DAG });
  draai(mm, 'gmail:david', [g], { jev: function () { return undefined; } });
  assert.equal(rij(mm, g.id).status, 'wacht_jev');
  const z = inhaal(mm, [g]);
  assert.deepEqual(z.n.j.nieuw, []); assert.equal(rij(mm, g.id).inhaal, 0);
  // postvak uit: geen inhaal
  mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'uit' });
  assert.equal(mm.n8n('POST /mailman/inhaal', { postvak: 'gmail:david' }).status, 409);
  assert.equal(mm.n8n('POST /mailman/inhaal', { postvak: 'gmail:onbekend' }).status, 400);
});

test('wv1983 Twijfel-lijst (gewoon én inhaal, nieuwste bovenaan) en "had naar … gemoeten" (juist)', () => {
  const { mm } = nieuweKamer();
  const SCHOOL = { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };
  const t1 = mail({ datum: klok - 2 * 3600000 });
  draai(mm, 'gmail:david', [t1, mail()], { jev: function (a) { return jevAntwoord(a.gmail_id === t1.id ? SCHOOL : { systeem: 0.99, waarde: 0 }); } });
  const t2 = mail({ datum: klok - 4 * DAG });
  inhaal(mm, [t2], { jev: function () { return jevAntwoord(SCHOOL); } });
  let p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; });
  assert.deepEqual(p.twijfel.map(function (r) { return [r.id, r.inhaal]; }), [[rij(mm, t1.id).id, false], [rij(mm, t2.id).id, true]]);
  assert.equal(p.twijfel[0].reden, 'score'); assert.equal(typeof p.twijfel[0].score, 'number'); assert.equal(p.twijfel[0].juist, null);
  assert.equal(p.twijfel_open, 2);
  const id = rij(mm, t2.id).id;
  assert.equal(mm.app('POST /app/mailman/oordeel', { id: rij(mm, t1.id).id, juist: 'intake' }).status, 200);
  p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; });
  assert.deepEqual(p.twijfel.map(function (r) { return r.id; }), [id, rij(mm, t1.id).id], 'nog niet beoordeeld eerst, ook als hij ouder is');
  assert.equal(p.twijfel_open, 1);
  mm.app('POST /app/mailman/oordeel', { id: rij(mm, t1.id).id, juist: null });
  assert.equal(mm.app('POST /app/mailman/oordeel', { id, juist: 'info' }).status, 200);
  assert.equal(rij(mm, t2.id).juist, 'info'); assert.equal(rij(mm, t2.id).oordeel, null, 'juist laat de duim staan');
  assert.equal(mm.app('POST /app/mailman/oordeel', { id, juist: 'twijfel' }).status, 400);
  assert.equal(mm.app('POST /app/mailman/oordeel', { id }).status, 400);
  assert.equal(mm.app('POST /app/mailman/oordeel', { id, oordeel: 'goed' }).status, 200);
  assert.equal(rij(mm, t2.id).juist, 'info', 'de duim laat juist staan');
  assert.equal(mm.app('POST /app/mailman/oordeel', { id, juist: null }).status, 200);
  assert.equal(rij(mm, t2.id).juist, null);
  p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; });
  assert.equal(p.twijfel.find(function (r) { return r.id === id; }).oordeel, 'goed');
  // na 14 dagen valt een twijfelmail uit de lijst (afzender en onderwerp zijn dan weg)
  klok += 15 * DAG;
  assert.deepEqual(mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; }).twijfel, []);
  klok -= 15 * DAG;
});

test('wv1983 een databank van mailman-1.2 krijgt inhaal, juist, soort en grens; besluiten en rondes blijven', () => {
  const { mm, dir } = nieuweKamer();
  const m = mail({ labels: ['_AI_'] });
  draai(mm, 'gmail:david', [m]);
  mm._db.exec('ALTER TABLE besluit DROP COLUMN inhaal; ALTER TABLE besluit DROP COLUMN juist; ALTER TABLE ronde DROP COLUMN soort; ALTER TABLE ronde DROP COLUMN grens;');
  mm._db.close();
  const mm2 = MM.maak({ dir, nu: function () { return klok; }, marker: poort, eigenAdressen: function () { return []; }, intakeDraden: function () { return new Set(); }, primair: function () { return true; } });
  for (const [t, k] of [['besluit', 'inhaal'], ['besluit', 'juist'], ['ronde', 'soort'], ['ronde', 'grens']]) assert.ok(mm2._db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, k), t + '.' + k);
  assert.equal(mm2._db.prepare('SELECT inhaal FROM besluit WHERE gmail_id = ?').get(m.id).inhaal, 0);
  assert.equal(mm2._db.prepare("SELECT count(*) n FROM ronde WHERE soort = 'ronde'").get().n, 2);
  assert.ok(Array.isArray(mm2.zorgen()), "zorgen() werkt op de oude rondes (soort = ronde)");
});

// ── B6+ (wv1988): uitgangen gelezen markeren en archiveren na verwerking ──
function uitgangToestaan(dir, ids) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.uitgang_toegestaan = {};
  for (const id of ids) c.uitgang_toegestaan[id] = { ja: '2026-11-02T08:30:00Z', door: 'proef' };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function vinkje(mm, stroom, veld) { const r = mm.app('POST /app/mailman/stroom', { stroom, [veld]: true }, ctxVers(true)); assert.equal(r.status, 200, JSON.stringify(r.j)); }
function perId(acties) { const u = {}; for (const x of acties) u[x.gmail_id] = x; return u; }

test('B6+ vinkjes: gelezen/archief aan alleen na uitgang_toegestaan én verse vingerafdruk; alleen de juiste stromen; uit mag altijd', () => {
  const { mm, dir } = nieuweKamer();
  let o = mm.app('GET /app/mailman', {}).j;
  assert.equal(o.uitgang_kan, false);
  assert.deepEqual([o.stromen.intake.gelezen, o.stromen.factuur.archief], [false, false], 'standaard uit');
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'intake', gelezen: true }, ctxVers(true)).status, 409);
  uitgangToestaan(dir, ['gmail:david', 'gmail:groenhouten']);
  o = mm.app('GET /app/mailman', {}).j;
  assert.equal(o.uitgang_kan, true);
  assert.equal(o.postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; }).uitgang_kan, false, 'doktersmaten nooit');
  const zonder = mm.app('POST /app/mailman/stroom', { stroom: 'intake', gelezen: true });
  assert.equal(zonder.status, 403); assert.equal(zonder.j.vers_nodig, true);
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'info', gelezen: true }, ctxVers(true)).status, 400);
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'intake', archief: true }, ctxVers(true)).status, 400);
  const c = ctxVers(true);
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'intake', gelezen: true }, c).status, 200);
  assert.equal(c.verbruikt, 1);
  o = mm.app('GET /app/mailman', {}).j;
  assert.equal(o.stromen.intake.gelezen, true); assert.ok(o.stromen.intake.gelezen_sinds);
  assert.match(mm._db.prepare("SELECT nieuw FROM wijziging WHERE wat = 'stroom' ORDER BY id DESC LIMIT 1").get().nieuw, /"vingerafdruk":true/);
  const sinds = o.stromen.intake.gelezen_sinds;
  klok += 60000;
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'intake', label: true }).status, 200, 'ander veld: geen vingerafdruk');
  assert.equal(mm.app('GET /app/mailman', {}).j.stromen.intake.gelezen_sinds, sinds, 'gelezen_sinds blijft');
  assert.equal(mm.app('POST /app/mailman/stroom', { stroom: 'intake', gelezen: false }).status, 200, 'uitzetten zonder vingerafdruk');
  o = mm.app('GET /app/mailman', {}).j;
  assert.equal(o.stromen.intake.gelezen, false); assert.equal(o.stromen.intake.gelezen_sinds, null);
  klok -= 60000;
});

test('B6+ gelezen: UNREAD eraf alleen als de mail ergens heen gaat, nooit bij TODO of Info, alleen na het vinkje, ≤ 6 uur, één keer', () => {
  const { mm, dir } = nieuweKamer();
  toestaan(dir, ['gmail:david']);
  zetLive(mm);
  const voor = mail();
  draai(mm, 'gmail:david', [voor], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 3 }); } });   // besluit vóór het vinkje
  uitgangToestaan(dir, ['gmail:david']);
  // zonder vinkje (wel uitgang_toegestaan): nooit eraf
  assert.ok(labelRonde(mm, [voor.id]).l.j.acties.every(function (x) { return x.eraf.length === 0; }));
  klok += 1000;
  for (const s of ['intake', 'factuur', 'twijfel']) vinkje(mm, s, 'gelezen');
  klok += 1000;
  const ms = [mail(), mail(), mail({ aan: ALIAS }), mail(), mail({ labels: ['INBOX', '_AI_'] })];
  // 0 intake, 1 intake + TODO (mens/actie), 2 factuur (alias), 3 info (systeem), 4 Davids eigen _AI_ (intake, geen AI/MailMan)
  draai(mm, 'gmail:david', ms, { jev: function (a) {
    if (a.gmail_id === ms[1].id) return jevAntwoord({ mens: 0.95, actie: 0.95, waarde: 3 });
    if (a.gmail_id === ms[3].id) return jevAntwoord({ systeem: 0.99, waarde: 0 });
    return jevAntwoord({ mens: 0.9, waarde: 3 });
  } });
  const ids = ms.map(function (m) { return m.id; }).concat([voor.id]);
  const { r, l } = labelRonde(mm, ids);
  const per = perId(l.j.acties);
  assert.deepEqual(per[ms[0].id].eraf, ['UNREAD']);
  assert.deepEqual(per[ms[1].id].eraf, [], 'TODO: gelezen-status ongemoeid');
  assert.deepEqual(per[ms[2].id].eraf, ['UNREAD']); assert.deepEqual(per[ms[2].id].erbij, ['FACTUUR']);
  assert.deepEqual(per[ms[3].id].eraf, [], 'Info: nooit gelezen');
  assert.deepEqual(per[ms[4].id], { gmail_id: ms[4].id, erbij: [], eraf: ['UNREAD'] }, 'eigen _AI_: alleen gelezen');
  assert.deepEqual(per[voor.id].eraf, [], 'besluit van vóór het vinkje: geen terugwerkende kracht');
  for (const x of l.j.acties) for (const e of x.eraf) assert.ok(e === 'UNREAD', 'bij het besluit nooit INBOX');
  // één keer: de volgende ronde zonder gezet biedt de labels opnieuw aan, maar zonder eraf; gelezen-alleen komt niet terug
  const tweede = perId(labelRonde(mm, ids).l.j.acties);
  assert.deepEqual(tweede[ms[0].id].eraf, []); assert.equal(tweede[ms[4].id], undefined);
  // gezet: wat n8n werkelijk weghaalde
  const g = mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: [
    { gmail_id: ms[0].id, erbij: ['AI/MailMan'], eraf: ['UNREAD', 'TRASH'], ok: true },
    { gmail_id: ms[4].id, erbij: [], eraf: [], ok: false, overgeslagen: true, fout: 'overgeslagen bij de grens' },
    { gmail_id: ms[2].id, erbij: [], eraf: [], ok: true }] });
  assert.deepEqual(g.j.telling, { ok: 1, fout: 1, gelezen: 1, archief: 0 });
  assert.ok(rij(mm, ms[0].id).gelezen_tijd);
  assert.equal(rij(mm, ms[4].id).labels_gezet, '[]'); assert.equal(rij(mm, ms[4].id).gelezen_tijd, null);
  assert.equal(rij(mm, ms[2].id).labels_gezet, null, 'ok zonder iets = fout, blijft open');
  assert.equal(mm.info().postvakken.find(function (x) { return x.id === 'gmail:david'; }).gelezen_24u, 1);
  // na 6 uur: geen eraf meer, ook niet voor een vers aangeboden besluit
  const laat = mail();
  draai(mm, 'gmail:david', [laat], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 3 }); } });
  klok += 7 * 3600000;
  assert.deepEqual(perId(labelRonde(mm, [laat.id]).l.j.acties)[laat.id].eraf, []);
  klok -= 7 * 3600000;
});

test('B6+ gelezen: niet als de mail nergens heen gaat (label of naar Intake/Facturen uit) — review #1', () => {
  const { mm, dir } = nieuweKamer();
  toestaan(dir, ['gmail:david']); uitgangToestaan(dir, ['gmail:david']);
  zetLive(mm);
  vinkje(mm, 'intake', 'gelezen'); vinkje(mm, 'factuur', 'gelezen');
  mm.app('POST /app/mailman/stroom', { stroom: 'intake', label: false });
  mm.app('POST /app/mailman/stroom', { stroom: 'factuur', naar_facturen: false });
  klok += 1000;
  const a = mail(), f = mail({ aan: ALIAS }), eigen = mail({ labels: ['INBOX', '_AI_'] });
  draai(mm, 'gmail:david', [a, f, eigen], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 3 }); } });
  const per = perId(labelRonde(mm, [a.id, f.id, eigen.id]).l.j.acties);
  assert.equal(per[a.id], undefined); assert.equal(per[f.id], undefined);
  assert.deepEqual(per[eigen.id].eraf, ['UNREAD'], 'Davids eigen _AI_ gaat via de Mail Processor toch naar Intake');
});

test('B6+ archief: alleen factuurmail met MailMans FACTUUR-label, verwerkt, genoeg documenten, geen TODO; INBOX eraf + FACTUUR/verwerkt; pogingen bij het aanbieden', () => {
  const verwerkt = new Map();
  const { mm, dir } = nieuweKamer({ factuurVerwerkt: function (ids) { return new Map(ids.filter(function (i) { return verwerkt.has(i); }).map(function (i) { return [i, verwerkt.get(i)]; })); } });
  const pdf = { naam: 'nota.pdf', mime: 'application/pdf' };
  const f1 = mail({ aan: ALIAS, bijlagen: [pdf] }), f2 = mail({ aan: ALIAS, bijlagen: [pdf] }), f3 = mail({ aan: ALIAS }), info = mail();
  const f4 = mail({ aan: ALIAS, bijlagen: [pdf, { naam: 'tweede.pdf', mime: 'application/pdf' }] }), f5 = mail({ aan: ALIAS, labels: ['INBOX', 'TODO'] });
  draai(mm, 'gmail:david', [f1, f2, f3, info, f4, f5], { jev: function () { return jevAntwoord({ systeem: 0.99, waarde: 0 }); } });
  toestaan(dir, ['gmail:david']); uitgangToestaan(dir, ['gmail:david']);
  zetLive(mm);
  const ids = [f1, f2, info, f4, f5].map(function (m) { return m.id; });   // f3 krijgt (nog) geen FACTUUR-label
  const eerste = labelRonde(mm, ids);
  mm.n8n('POST /mailman/gezet', { ronde: eerste.r.ronde, postvak: 'gmail:david', resultaten: eerste.l.j.acties.map(function (x) { return { gmail_id: x.gmail_id, erbij: x.erbij, eraf: [], ok: true }; }) });
  verwerkt.set(f1.id, 1); verwerkt.set(f3.id, 1); verwerkt.set(info.id, 1); verwerkt.set(f4.id, 1); verwerkt.set(f5.id, 1);
  assert.equal(labelRonde(mm, []).l.j.archief, 0, 'vinkje uit');
  vinkje(mm, 'factuur', 'archief');
  const { r, l } = labelRonde(mm, []);   // archiefacties staan los van de lijst van deze ronde
  assert.deepEqual(l.j.acties, [{ gmail_id: f1.id, erbij: [K.VERWERKT_LABEL], eraf: ['INBOX'], archief: true }],
    'alleen f1: f2 niet verwerkt, f3 zonder FACTUUR, info geen factuur, f4 twee pdf maar één document, f5 TODO');
  assert.equal(rij(mm, f1.id).archief_poging, 1, 'aanbieden telt een poging, ook als n8n niets terugmeldt');
  for (let i = 0; i < 4; i++) assert.equal(labelRonde(mm, []).l.j.acties.length, 1);
  assert.equal(rij(mm, f1.id).archief_poging, 5);
  assert.deepEqual(labelRonde(mm, []).l.j.acties, [], 'na vijf aanbiedingen niet meer');
  mm._db.prepare('UPDATE besluit SET archief_poging = 0 WHERE gmail_id = ?').run(f1.id);
  const g = mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: [
    { gmail_id: f1.id, erbij: [K.VERWERKT_LABEL], eraf: ['INBOX'], ok: true },
    { gmail_id: f3.id, erbij: [K.VERWERKT_LABEL], eraf: ['INBOX'], ok: true }] });
  assert.equal(g.j.telling.archief, 1); assert.equal(g.j.telling.fout, 1, 'f3 had geen FACTUUR-label van MailMan');
  assert.ok(rij(mm, f1.id).archief_tijd); assert.equal(rij(mm, f3.id).archief_tijd, null);
  assert.deepEqual(JSON.parse(rij(mm, f1.id).labels_gezet), ['FACTUUR'], 'FACTUUR blijft het labelspoor');
  assert.deepEqual(labelRonde(mm, []).l.j.acties, [], 'gearchiveerd: niet opnieuw');
  verwerkt.set(f2.id, 1); verwerkt.set(f4.id, 2);   // later verwerkt, en f4 nu met twee documenten
  assert.deepEqual(labelRonde(mm, []).l.j.acties.map(function (x) { return x.gmail_id; }).sort(), [f2.id, f4.id].sort());
  mm.app('POST /app/mailman/stand', { postvak: 'gmail:david', stand: 'schaduw' });
  assert.deepEqual(labelRonde(mm, []).l.j.acties, [], 'schaduw: niets');
  assert.equal(mm.info().postvakken.find(function (x) { return x.id === 'gmail:david'; }).archief_24u, 1);
});

test('B6+ archief: zonder Facturen-koppeling of als die faalt geen archiefactie (dicht)', () => {
  for (const fv of [function () { throw new Error('databank weg'); }, function () { return new Set(['x']); }, undefined]) {
    const { mm, dir } = nieuweKamer(fv ? { factuurVerwerkt: fv } : {});
    const f = mail({ aan: ALIAS });
    draai(mm, 'gmail:david', [f]);
    toestaan(dir, ['gmail:david']); uitgangToestaan(dir, ['gmail:david']);
    zetLive(mm);
    const a = labelRonde(mm, [f.id]);
    mm.n8n('POST /mailman/gezet', { ronde: a.r.ronde, postvak: 'gmail:david', resultaten: [{ gmail_id: f.id, erbij: ['FACTUUR'], ok: true }] });
    vinkje(mm, 'factuur', 'archief');
    assert.deepEqual(labelRonde(mm, []).l.j.acties, []);
  }
});

// ── B7-V verkoopfacturen in doktersmaten (wv1997). Alle toetsdata verzonnen: geen echte nota, naam of het echte verkoopadres. ──
const VK_ADRES = 'voorbeeld@example.invalid';
const AR_OK = 'mx.google.com;\r\n       dkim=pass header.i=@hapleusden.nl header.s=google header.b=abcdefgh;\r\n       spf=pass (google.com: domain of x@hapleusden.nl designates 192.0.2.1 as permitted sender) smtp.mailfrom=x@hapleusden.nl;\r\n       dmarc=pass (p=none sp=none dis=none) header.from=hapleusden.nl';
function vkMail(o) {
  return mail(Object.assign({ van: 'Praktijk Proef <proef@hapleusden.nl>', aan: 'facturen@praktijk.invalid', onderwerp: 'gordelroos', labels: ['INBOX'],
    bijlagen: [{ naam: '', mime: 'onbekend' }], tekst: '', auth: AR_OK, ct: 'multipart/mixed; boundary="x"', datum: klok }, o || {}));
}
function vkToestaan(dir, adres, labelId) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (adres === null) delete c.verkoop_toegestaan; else c.verkoop_toegestaan = { 'gmail:groenhouten': { adres: adres || VK_ADRES, ja: '2026-11-02T08:30:00Z', door: 'proef', vraag: 'proef', label_id: labelId === undefined ? 'Label_99' : labelId } };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
// nep-lezer: pdftotext geeft de 'tekstlaag' uit de pdf (na de kop), pdftoppm maakt één png, tesseract geeft de 'ocr'-tekst
function nepProces(log) {
  return async function (cmd, args) {
    log && log.push(cmd);
    const f = args.find(function (a) { return /stuk\.pdf$/.test(a); });
    if (cmd === 'pdftotext') { const t = fs.readFileSync(f, 'latin1'); return /LAAG:([^\n]*)/.test(t) ? /LAAG:([^\n]*)/.exec(t)[1] : ''; }
    if (cmd === 'pdftoppm') { const uit = args[args.length - 1]; const t = fs.readFileSync(f, 'latin1'); if (/KAPOT/.test(t)) return null; fs.writeFileSync(uit + '-1.png', /SCAN:([^\n]*)/.test(t) ? /SCAN:([^\n]*)/.exec(t)[1] : ''); return ''; }
    if (cmd === 'tesseract') return fs.readFileSync(args[0], 'utf8');
    return null;
  };
}
function nepPdf(s) { return Buffer.from('%PDF-1.4\n' + s + '\n%%EOF\n').toString('base64'); }
function vkKamer(extra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-vk-tmp-'));
  const log = [];
  const k = nieuweKamer(Object.assign({ proces: nepProces(log), verkoopTmp: tmp }, extra || {}));
  return Object.assign(k, { tmp, log });
}
function vkRonde(mm, mails, ids) {
  const r = ronde(mm, 'gmail:groenhouten');
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:groenhouten', ids: ids || mails.map(function (m) { return m.id; }), volledig: true });
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:groenhouten', mails: mails.filter(function (m) { return n.j.nieuw.includes(m.id); }) });
  return { r, n, s1 };
}
function vRij(mm, id) { return mm._db.prepare('SELECT * FROM verkoop WHERE gmail_id = ?').get(id); }

test('B7-V afzendercontrole: alleen Gmails eigen kop met dmarc/dkim pass voor precies het afzenderdomein', () => {
  assert.equal(K.authPass(AR_OK, 'hapleusden.nl'), true);
  assert.equal(K.authPass('mx.google.com; dkim=pass header.i=@hapleusden.nl header.s=google', 'hapleusden.nl'), true, 'dkim alleen');
  assert.equal(K.authPass('mx.google.com; dmarc=pass (p=none) header.from=hapleusden.nl', 'hapleusden.nl'), true, 'dmarc alleen');
  assert.equal(K.authPass(AR_OK, 'hpgroenhouten.nl'), false, 'ander domein');
  assert.equal(K.authPass(AR_OK.replace('mx.google.com', 'mx.nep.invalid'), 'hapleusden.nl'), false, 'niet van Gmail');
  assert.equal(K.authPass('mx.google.com; dkim=pass header.i=@sub.hapleusden.nl; dmarc=pass header.from=sub.hapleusden.nl', 'hapleusden.nl'), false, 'subdomein');
  assert.equal(K.authPass('mx.google.com; dkim=fail header.i=@hapleusden.nl; dmarc=fail header.from=hapleusden.nl', 'hapleusden.nl'), false, 'fail');
  assert.equal(K.authPass('mx.google.com; spf=pass (header.from=hapleusden.nl dmarc=pass) smtp.mailfrom=x@hapleusden.nl', 'hapleusden.nl'), false, 'alleen in commentaar');
  assert.equal(K.authPass('', 'hapleusden.nl'), false);
});

test('B7-V kandidaat: domein precies, bijlage, niet verzonden, afzendercontrole; alleen doktersmaten', () => {
  const n = function (o) { return K.normaliseer(vkMail(o)); };
  assert.equal(K.verkoopKandidaat(n(), 'gmail:groenhouten').ok, true);
  assert.equal(K.verkoopKandidaat(n({ van: 'a@hpgroenhouten.nl', auth: 'mx.google.com; dmarc=pass header.from=hpgroenhouten.nl' }), 'gmail:groenhouten').ok, true, 'tweede domein');
  assert.equal(K.verkoopKandidaat(n(), 'gmail:david').ok, false, 'privépostvak nooit');
  assert.equal(K.verkoopKandidaat(n({ van: 'info@ander.invalid' }), 'gmail:groenhouten').reden, 'domein');
  assert.equal(K.verkoopKandidaat(n({ van: 'proef@post.hapleusden.nl' }), 'gmail:groenhouten').reden, 'domein', 'subdomein telt niet');
  assert.equal(K.verkoopKandidaat(n({ van: 'proef@hapleusden.nl.ander.invalid' }), 'gmail:groenhouten').reden, 'domein');
  assert.equal(K.verkoopKandidaat(n({ labels: ['SENT'] }), 'gmail:groenhouten').reden, 'verzonden/concept');
  assert.equal(K.verkoopKandidaat(n({ labels: ['DRAFT'] }), 'gmail:groenhouten').reden, 'verzonden/concept');
  assert.equal(K.verkoopKandidaat(n({ bijlagen: [], ct: 'multipart/alternative' }), 'gmail:groenhouten').reden, 'geen bijlage');
  assert.equal(K.verkoopKandidaat(n({ bijlagen: [], ct: 'multipart/related; x' }), 'gmail:groenhouten').ok, true);
  assert.equal(K.verkoopKandidaat(n({ auth: '' }), 'gmail:groenhouten').reden, 'afzendercontrole');
});

test('B7-V ankers: beide nodig, OCR-tolerant (I/1/l/|), hoofdletterongevoelig', () => {
  assert.deepEqual(K.verkoopAnkers('xx VACSHING yy SHINGRIX'), { vacshing: true, shingrix: true });
  assert.deepEqual(K.verkoopAnkers('VACSH1NG SH1NGR|X'), { vacshing: true, shingrix: true });
  assert.deepEqual(K.verkoopAnkers('vacshlng shlngrlx'), { vacshing: true, shingrix: true });
  assert.deepEqual(K.verkoopAnkers('VACSHNG SHINGRX'), { vacshing: false, shingrix: false });
  assert.deepEqual(K.verkoopAnkers('alleen SHINGRIX'), { vacshing: false, shingrix: true });
  assert.equal(K.verkoopOordeel([{ vacshing: true, shingrix: false }, { vacshing: false, shingrix: true }]), false, 'verdeeld over twee pdfs telt niet');
  assert.equal(K.verkoopOordeel([{ vacshing: true, shingrix: false }, { vacshing: true, shingrix: true }]), false, 'review #2: een tweede pdf zonder ankers gaat nooit mee');
  assert.equal(K.verkoopOordeel([{ vacshing: true, shingrix: true }, { vacshing: true, shingrix: true }]), true, 'twee nota\'s');
  assert.equal(K.verkoopOordeel([{ vacshing: true, shingrix: true }, { overgeslagen: 'te groot' }]), false);
  assert.equal(K.verkoopOordeel([]), false);
});

test('B7-V stap1: kandidaat wacht op de pdf-toets (vóór Altijd in); geen kandidaat = gewone stappen; privé nooit', () => {
  const { mm } = vkKamer();
  const k = vkMail(), ander = vkMail({ van: 'info@ander.invalid' }), verz = vkMail({ labels: ['SENT'] }), geenAuth = vkMail({ auth: '' });
  const { s1 } = vkRonde(mm, [k, ander, verz, geenAuth]);
  assert.deepEqual(s1.j.verkoop, [k.id]);
  assert.equal(rij(mm, k.id).status, 'wacht_verkoop');
  assert.equal(rij(mm, k.id).stroom, 'factuur', 'het regelbesluit (Altijd in 1d) blijft als gewone stappen staan');
  assert.equal(vRij(mm, k.id).status, 'kandidaat');
  for (const m of [ander, geenAuth]) assert.equal(rij(mm, m.id).status, 'klaar');
  assert.equal(vRij(mm, ander.id), undefined);
  const p = draai(mm, 'gmail:david', [vkMail()], { jev: function () { return jevAntwoord({}); } });
  assert.deepEqual(p.s1.j.verkoop, [], 'privé: geen verkoop');
  // de volgende ronde komt de wachtende kandidaat terug in nieuw
  const r2 = vkRonde(mm, [k]);
  assert.deepEqual(r2.n.j.nieuw, [k.id]); assert.deepEqual(r2.s1.j.verkoop, [k.id]);
});

test('B7-V pdf-toets: tekstlaag of OCR, alleen ankers/sha/grootte bewaard, map altijd weg', async () => {
  const { mm, tmp, log } = vkKamer();
  const tekst = vkMail(), scan = vkMail(), een = vkMail(), geen = vkMail();
  const { r } = vkRonde(mm, [tekst, scan, een, geen]);
  const t = function (m, bijlagen, fout) { return mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: m.id, bijlagen, fout }); };
  const b64 = nepPdf('LAAG:Verzonnen Proef Patient VACSHING SHINGRIX en nog genoeg tekst om als tekstlaag te tellen');
  let u = await t(tekst, [{ naam: 'nota.pdf', mime: 'application/pdf', b64 }]);
  assert.deepEqual(u.j, { ok: true, verkoop: true, pdfs: 1 });
  const b = rij(mm, tekst.id), v = vRij(mm, tekst.id);
  assert.equal(b.stap, 'verkoop'); assert.equal(b.stroom, 'verkoop'); assert.equal(b.reden, 'ankers'); assert.equal(b.status, 'klaar');
  assert.deepEqual(JSON.parse(b.labels_plan), ['VERKOOP'], 'labelplan alleen VERKOOP');
  assert.equal(v.status, 'herkend');
  const pd = JSON.parse(v.pdfs);
  assert.deepEqual(Object.keys(pd[0]).sort(), ['bedrag_cent', 'bron', 'grootte', 'naam', 'nummer', 'sha256', 'sha256_b64', 'shingrix', 'vacshing']);
  assert.equal(pd[0].naam, 'nota.pdf', 'wv1998: bestandsnaam voor de tab Verkoop');
  assert.equal(pd[0].sha256, crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'));
  assert.equal(pd[0].sha256_b64, crypto.createHash('sha256').update(b64).digest('hex'));
  assert.equal(pd[0].bron, 'tekst');
  const alles = JSON.stringify(mm._db.prepare('SELECT * FROM verkoop').all()) + JSON.stringify(mm._db.prepare('SELECT * FROM besluit').all());
  assert.ok(!/Proef Patient/.test(alles), 'geen tekst in de databank');
  u = await t(scan, [{ naam: 'scan.pdf', mime: 'application/octet-stream', b64: nepPdf('SCAN:VACSH1NG ... SH1NGR|X') }]);
  assert.equal(u.j.verkoop, true); assert.equal(JSON.parse(vRij(mm, scan.id).pdfs)[0].bron, 'ocr');
  assert.ok(log.includes('pdftoppm') && log.includes('tesseract'));
  u = await t(een, [{ naam: 'a.pdf', b64: nepPdf('SCAN:alleen SHINGRIX') }]);
  assert.equal(u.j.verkoop, false);
  assert.equal(rij(mm, een.id).status, 'klaar'); assert.equal(rij(mm, een.id).stroom, 'factuur', 'één anker: gewone stappen (Altijd in 1d)');
  assert.equal(vRij(mm, een.id).status, 'niet_herkend');
  u = await t(geen, [{ naam: 'b.txt', b64: Buffer.from('geen pdf').toString('base64') }]);
  assert.equal(u.j.verkoop, false); assert.equal(vRij(mm, geen.id).fout, 'geen leesbare pdf');
  assert.deepEqual(fs.readdirSync(tmp), [], 'tijdelijke mappen gewist');
  assert.equal((await t(tekst, [{ b64 }])).status, 409, 'al getoetst: geen tweede toets');
  const tl = mm.telling('gmail:groenhouten', '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z');
  assert.equal(tl.verkoop, 2, 'twee verkoopnota\'s, één keer geteld'); assert.equal(tl.binnen, 4);
});

test('B7-V pdf-toets: mislukt telt, na 3 keer gewone stappen; niet-canonieke base64 geweigerd; 24 uur zonder toets = gewone stappen', async () => {
  const { mm, tmp } = vkKamer();
  const a = vkMail(), c = vkMail(), w = vkMail();
  let { r } = vkRonde(mm, [a, c, w]);
  for (let i = 1; i <= 3; i++) {
    const u = await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: a.id, bijlagen: [{ b64: nepPdf('KAPOT') }] });
    assert.equal(u.j.opnieuw, i < 3);
  }
  assert.equal(rij(mm, a.id).status, 'klaar'); assert.equal(vRij(mm, a.id).status, 'niet_herkend');
  const nc = await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: c.id, bijlagen: [{ b64: nepPdf('LAAG:x').replace(/=+$/, '') }] });
  assert.equal(nc.j.opnieuw, true); assert.match(vRij(mm, c.id).fout, /canonieke/);
  const f = await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: c.id, fout: 'bijlage ophalen mislukt' });
  assert.equal(f.j.opnieuw, true);
  klok += 25 * 3600 * 1000;
  vkRonde(mm, [w]);
  assert.equal(rij(mm, w.id).status, 'klaar'); assert.equal(vRij(mm, w.id).status, 'niet_herkend'); assert.match(vRij(mm, w.id).fout, /24 uur/);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

async function vkHerkend(mm, n, extra) {
  const ms = []; for (let i = 0; i < n; i++) ms.push(vkMail(extra));
  const { r } = vkRonde(mm, ms);
  for (const m of ms) assert.equal((await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: m.id, bijlagen: [{ b64: nepPdf('SCAN:VACSHING SHINGRIX') }] })).j.verkoop, true);
  return ms;
}
function vkActies(mm, ids) {
  const r = ronde(mm, 'gmail:groenhouten');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:groenhouten', ids, volledig: true });
  return { r, a: mm.n8n('POST /mailman/verkoop/acties', { ronde: r.ronde, postvak: 'gmail:groenhouten', ids }) };
}

test('B7-V schakelaars: dicht zonder toestemming, aan alleen met vingerafdruk, adres alleen uit config.json, geen terugwerkende kracht', async () => {
  const { mm, dir } = vkKamer();
  const oud = await vkHerkend(mm, 1);
  klok += 60000;
  // ook als iemand de schakelaar in de databank zet: zonder toestemming geen acties
  mm._db.prepare("UPDATE postvak SET verkoop_door = 1, verkoop_archief = 1, verkoop_sinds = '2000-01-01T00:00:00Z' WHERE id = 'gmail:groenhouten'").run();
  assert.deepEqual(vkActies(mm, [oud[0].id]).a.j.acties, []);
  mm._db.prepare("UPDATE postvak SET verkoop_door = 0, verkoop_archief = 0, verkoop_sinds = NULL WHERE id = 'gmail:groenhouten'").run();
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(true)).status, 409, 'zonder toestemming kan het niet aan');
  vkToestaan(dir, 'niet-een-adres');
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(true)).status, 409, 'ongeldig adres');
  vkToestaan(dir);
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(false)).status, 403, 'zonder verse vingerafdruk niet');
  const ctx = ctxVers(true);
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true }, ctx).status, 200); assert.equal(ctx.verbruikt, 1);
  klok += 60000;
  const nieuw = await vkHerkend(mm, 1);
  const ids = [oud[0].id, nieuw[0].id];
  const { a } = vkActies(mm, ids);
  assert.deepEqual(a.j.acties.map(function (x) { return x.gmail_id; }), [nieuw[0].id], 'mail van vóór het aanzetten niet');
  assert.equal(a.j.acties[0].adres, VK_ADRES); assert.equal(a.j.acties[0].soort, 'door');
  assert.equal(a.j.acties[0].sha256_b64.length, 1);
  assert.equal(vRij(mm, nieuw[0].id).status, 'aangeboden');
  assert.deepEqual(vkActies(mm, ids).a.j.acties, [], 'hooguit één keer aangeboden');
  const ov = mm.app('GET /app/mailman', {}, {}).j.verkoop;
  assert.equal(ov.kan, true); assert.equal(ov.adres, VK_ADRES); assert.equal(ov.door, true); assert.equal(ov.archief, false);
  assert.equal(ov.journaal.length, 2);
  vkToestaan(dir, null);
  const n3 = await vkHerkend(mm, 1);
  assert.deepEqual(vkActies(mm, [n3[0].id]).a.j.acties, [], 'toestemming ingetrokken: dicht');
  vkToestaan(dir, 'ander@example.invalid');
  const v = vkActies(mm, [n3[0].id]).a.j.acties;
  assert.equal(v[0].adres, 'ander@example.invalid', 'het adres volgt alleen config.json');
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: false }, ctxVers(false)).status, 200, 'uitzetten mag altijd');
  const n4 = await vkHerkend(mm, 1);
  assert.deepEqual(vkActies(mm, [n4[0].id]).a.j.acties, []);
});

test('B7-V plafonds en lijst: ≤ 10 per ronde, ≤ 25 per dag, alleen id\'s uit de lijst van deze ronde', async () => {
  const { mm, dir } = vkKamer();
  vkToestaan(dir);
  mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(true));
  klok += 60000;
  const ms = await vkHerkend(mm, 30);
  const ids = ms.map(function (m) { return m.id; });
  assert.deepEqual(vkActies(mm, ids.slice(0, 2)).a.j.acties.length, 2, 'alleen uit de lijst');
  assert.equal(vkActies(mm, ids).a.j.acties.length, 10);
  assert.equal(vkActies(mm, ids).a.j.acties.length, 10);
  assert.equal(vkActies(mm, ids).a.j.acties.length, 3, 'dagplafond 25');
  assert.equal(vkActies(mm, ids).a.j.acties.length, 0);
  klok += 24 * 3600 * 1000 + 1000;
  assert.equal(vkActies(mm, ids).a.j.acties.length, 5, 'na een dag de rest');
});

test('B7-V gedaan en archief: verstuurd → na 15 min archief, geweigerd blijft staan, al_doorgestuurd en mislukt nooit opnieuw', async () => {
  const { mm, dir } = vkKamer();
  vkToestaan(dir);
  mm.app('POST /app/mailman/verkoop', { door: true, archief: true }, ctxVers(true));
  klok += 60000;
  const ms = await vkHerkend(mm, 4);
  const ids = ms.map(function (m) { return m.id; });
  const { r, a } = vkActies(mm, ids);
  assert.equal(a.j.acties.length, 4);
  const g = mm.n8n('POST /mailman/verkoop/gedaan', { ronde: r.ronde, postvak: 'gmail:groenhouten', resultaten: [
    { gmail_id: ids[0], soort: 'door', uitkomst: 'verstuurd', verstuurd_id: 'aaaabbbbccccdddd' },
    { gmail_id: ids[1], soort: 'door', uitkomst: 'verstuurd', verstuurd_id: 'aaaabbbbcccceeee' },
    { gmail_id: ids[2], soort: 'door', uitkomst: 'al_doorgestuurd' },
    { gmail_id: ids[3], soort: 'door', uitkomst: 'mislukt', fout: 'HTTP 500' },
    { gmail_id: ids[3], soort: 'door', uitkomst: 'verstuurd', verstuurd_id: 'aaaabbbbccccffff' }] });
  assert.deepEqual(g.j.telling, { verstuurd: 2, al_doorgestuurd: 1, overgeslagen: 0, onzeker: 0, mislukt: 1, gearchiveerd: 0, geweigerd: 0, later: 0, genegeerd: 1 });
  assert.deepEqual(vkActies(mm, ids).a.j.acties, [], 'archief pas na 15 minuten; mislukt/al_doorgestuurd nooit opnieuw');
  klok += 16 * 60000;
  const ar = vkActies(mm, []);
  assert.deepEqual(ar.a.j.acties.map(function (x) { return x.soort + ':' + x.gmail_id; }).sort(), ['archief:' + ids[0], 'archief:' + ids[1]].sort());
  mm.n8n('POST /mailman/verkoop/gedaan', { ronde: ar.r.ronde, postvak: 'gmail:groenhouten', resultaten: [
    { gmail_id: ids[0], soort: 'archief', uitkomst: 'gearchiveerd' }, { gmail_id: ids[1], soort: 'archief', uitkomst: 'geweigerd' },
    { gmail_id: ids[2], soort: 'archief', uitkomst: 'gearchiveerd' }] });
  assert.equal(vRij(mm, ids[0]).status, 'gearchiveerd'); assert.equal(vRij(mm, ids[1]).status, 'geweigerd'); assert.equal(vRij(mm, ids[2]).status, 'al_doorgestuurd', 'archief alleen na verstuurd');
  assert.deepEqual(vkActies(mm, ids).a.j.acties, []);
  const z = mm.zorgen().join(' | ');
  assert.match(z, /geweigerd/); assert.match(z, /mislukt/);
  const h = mm.info().postvakken.find(function (x) { return x.id === 'gmail:groenhouten'; }).verkoop;
  assert.equal(h.verstuurd, 2); assert.equal(h.gearchiveerd, 1); assert.equal(h.geweigerd, 1); assert.equal(h.toegestaan, true);
  assert.equal(mm.info().postvakken.find(function (x) { return x.id === 'gmail:david'; }).verkoop, undefined);
});

test('B7-V archief: hooguit 5 keer aangeboden; later = blijft verstuurd; privé en inhaal krijgen nooit verkoopacties', async () => {
  const { mm, dir } = vkKamer();
  vkToestaan(dir);
  mm.app('POST /app/mailman/verkoop', { door: true, archief: true }, ctxVers(true));
  klok += 60000;
  const [m] = await vkHerkend(mm, 1);
  const { r } = vkActies(mm, [m.id]);
  mm.n8n('POST /mailman/verkoop/gedaan', { ronde: r.ronde, postvak: 'gmail:groenhouten', resultaten: [{ gmail_id: m.id, soort: 'door', uitkomst: 'verstuurd', verstuurd_id: 'aaaabbbbccccdddd' }] });
  klok += 16 * 60000;
  for (let i = 0; i < 5; i++) {
    const x = vkActies(mm, []);
    assert.equal(x.a.j.acties.length, 1);
    mm.n8n('POST /mailman/verkoop/gedaan', { ronde: x.r.ronde, postvak: 'gmail:groenhouten', resultaten: [{ gmail_id: m.id, soort: 'archief', uitkomst: 'later', fout: 'label VERKOOP ontbreekt' }] });
  }
  assert.equal(vRij(mm, m.id).status, 'verstuurd');
  assert.deepEqual(vkActies(mm, []).a.j.acties, []);
  const p = ronde(mm, 'gmail:david');
  assert.deepEqual(mm.n8n('POST /mailman/verkoop/acties', { ronde: p.ronde, postvak: 'gmail:david', ids: [m.id] }).j.acties, []);
  assert.equal((await mm.verkoopToets({ ronde: p.ronde, postvak: 'gmail:david', gmail_id: m.id, bijlagen: [] })).status, 400);
  assert.equal(mm.n8n('POST /mailman/verkoop/toets', {}).status, 404, 'de toets gaat nooit via de gewone n8n-route (ankers niet van buiten)');
});

// Echte gereedschappen (pdftotext, pdftoppm, tesseract) op verzonnen pdf's die ghostscript hier maakt: een met tekstlaag en een scan
// zonder tekstlaag (pdfimage24). Overgeslagen als een van de gereedschappen ontbreekt (CI).
const { spawnSync, spawn } = require('child_process');
const GEREEDSCHAP = ['gs', 'pdftotext', 'pdftoppm', 'tesseract'].every(function (c) { return spawnSync('sh', ['-c', 'command -v ' + c]).status === 0; });
function echtProces(cmd, args, o) {
  return new Promise(function (klaar) {
    const k = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); let uit = '';
    const tm = setTimeout(function () { k.kill('SIGKILL'); }, (o && o.ms) || 60000);
    k.stdout.setEncoding('utf8'); k.stdout.on('data', function (c) { uit += c; });
    k.on('close', function (code) { clearTimeout(tm); klaar(code === 0 ? uit : null); });
    k.on('error', function () { clearTimeout(tm); klaar(null); });
  });
}
test('B7-V pdf-toets met echte gereedschappen: tekstlaag én scan herkend, andere factuur niet', { skip: !GEREEDSCHAP && 'gs/poppler/tesseract ontbreken' }, async () => {
  const werk = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-vk-gs-'));
  const maak = function (naam, regels, apparaat) {
    const ps = path.join(werk, naam + '.ps'), pdf = path.join(werk, naam + '.pdf');
    fs.writeFileSync(ps, '%!PS\n/Helvetica-Bold findfont 28 scalefont setfont\n' + regels.map(function (r, i) { return '72 ' + (700 - i * 50) + ' moveto (' + r + ') show'; }).join('\n') + '\nshowpage\n');
    assert.equal(spawnSync('gs', ['-q', '-dBATCH', '-dNOPAUSE', '-sDEVICE=' + apparaat, '-r150', '-o', pdf, ps]).status, 0);
    return fs.readFileSync(pdf).toString('base64');
  };
  const nota = ['PROEFPRAKTIJK NOTA', 'Factuurnr: VACSHING-42', 'Vaccinatie VACSHING', 'Product SHINGRIX', 'Te betalen EUR 12,34'];
  const tekstPdf = maak('tekst', nota, 'pdfwrite'), scanPdf = maak('scan', nota, 'pdfimage24'), anderPdf = maak('ander', ['PROEFLEVERANCIER FACTUUR', 'Kantoorartikelen', 'Bedrag 56,78'], 'pdfimage24');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-vk-tmp-'));
  const { mm } = nieuweKamer({ proces: echtProces, verkoopTmp: tmp });
  const a = vkMail(), b = vkMail(), c = vkMail();
  const { r } = vkRonde(mm, [a, b, c]);
  const t = function (m, b64) { return mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: m.id, bijlagen: [{ b64 }] }); };
  assert.equal((await t(a, tekstPdf)).j.verkoop, true); assert.equal(JSON.parse(vRij(mm, a.id).pdfs)[0].bron, 'tekst');
  assert.equal((await t(b, scanPdf)).j.verkoop, true); assert.equal(JSON.parse(vRij(mm, b.id).pdfs)[0].bron, 'ocr');
  // wv1998: factuurnummer en bedrag uit tekstlaag én OCR
  for (const m of [a, b]) { const x = JSON.parse(vRij(mm, m.id).pdfs)[0]; assert.equal(x.nummer, 'VACSHING-42', x.bron); assert.equal(x.bedrag_cent, 1234, x.bron); }
  assert.equal((await t(c, anderPdf)).j.verkoop, false); assert.equal(vRij(mm, c.id).status, 'niet_herkend');
  assert.deepEqual(fs.readdirSync(tmp), []);
  fs.rmSync(werk, { recursive: true, force: true });
});

test('B7-V review: groepsmail nooit kandidaat; gemengde pdf\'s of niet alles getoetst = bij David; OCR ook bij een tekstlaag zonder ankers', async () => {
  assert.equal(K.verkoopKandidaat(K.normaliseer(vkMail({ groep: true })), 'gmail:groenhouten').reden, 'groepsmail');
  const { mm, log } = vkKamer();
  const gemengd = vkMail(), teveel = vkMail(), laag = vkMail();
  const { r } = vkRonde(mm, [gemengd, teveel, laag]);
  const t = function (m, bijlagen, extra) { return mm.verkoopToets(Object.assign({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: m.id, bijlagen }, extra || {})); };
  let u = await t(gemengd, [{ b64: nepPdf('SCAN:VACSHING SHINGRIX') }, { b64: nepPdf('SCAN:Verwijsbrief proef') }]);
  assert.equal(u.j.verkoop, false); assert.equal(vRij(mm, gemengd.id).status, 'niet_herkend'); assert.match(vRij(mm, gemengd.id).fout, /blijft bij jou/);
  u = await t(teveel, [{ b64: nepPdf('SCAN:VACSHING SHINGRIX') }], { pdf_totaal: 4 });
  assert.equal(u.j.verkoop, false, 'een vierde pdf die niet getoetst is');
  log.length = 0;
  u = await t(laag, [{ b64: nepPdf('LAAG:een tekstlaag van een scanner zonder de woorden, lang genoeg om te tellen als tekst\nSCAN:VACSH1NG SH1NGR1X') }]);
  assert.equal(u.j.verkoop, true, 'OCR vond ze alsnog'); assert.ok(log.includes('tesseract'));
  assert.equal(typeof mm.verkoopBezig(), 'boolean'); assert.equal(mm.verkoopBezig(), false);
});

test('B7-V review: archiveren pas met label-ID in de toestemming; ontbrekend label kost geen poging; aangeboden > 48 u wordt mislukt (één melding)', async () => {
  const { mm, dir } = vkKamer();
  vkToestaan(dir, VK_ADRES, null);
  assert.equal(mm.app('POST /app/mailman/verkoop', { archief: true }, ctxVers(true)).status, 409, 'zonder label-ID geen archiveren');
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(true)).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}, {}).j.verkoop.archief_kan, false);
  klok += 60000;
  const [a, b] = await vkHerkend(mm, 2);
  const x = vkActies(mm, [a.id, b.id]);
  mm.n8n('POST /mailman/verkoop/gedaan', { ronde: x.r.ronde, postvak: 'gmail:groenhouten', resultaten: [{ gmail_id: a.id, soort: 'door', uitkomst: 'verstuurd', verstuurd_id: 'aaaabbbbccccdddd' }] });
  vkToestaan(dir, VK_ADRES);
  assert.equal(mm.app('POST /app/mailman/verkoop', { archief: true }, ctxVers(true)).status, 200);
  klok += 16 * 60000;
  for (let i = 0; i < 8; i++) {
    const y = vkActies(mm, []);
    assert.equal(y.a.j.acties.length, 1); assert.equal(y.a.j.acties[0].label_id, 'Label_99');
    mm.n8n('POST /mailman/verkoop/gedaan', { ronde: y.r.ronde, postvak: 'gmail:groenhouten', resultaten: [{ gmail_id: a.id, soort: 'archief', uitkomst: 'geen_label' }] });
  }
  assert.equal(vRij(mm, a.id).archief_pogingen, 0, 'geen_label verbruikt geen poging');
  // b staat op aangeboden zonder terugmelding: na 1 u een melding, na 48 u mislukt (en de melding over hangen stopt)
  klok += 2 * 3600 * 1000;
  assert.match(mm.zorgen().join('|'), /aangeboden zonder terugmelding/);
  klok += 47 * 3600 * 1000;
  vkActies(mm, []);
  assert.equal(vRij(mm, b.id).status, 'mislukt'); assert.match(vRij(mm, b.id).fout, /Verzonden/);
  assert.ok(!/aangeboden zonder terugmelding/.test(mm.zorgen().join('|')));
  assert.match(mm.zorgen().join('|'), /mislukt/);
});

test('B7-V review: overgeslagen is stil, onzeker meldt; oude tijdelijke mappen worden bij de start gewist', async () => {
  const { mm, dir, tmp } = vkKamer();
  vkToestaan(dir);
  mm.app('POST /app/mailman/verkoop', { door: true }, ctxVers(true));
  klok += 60000;
  const [a, b] = await vkHerkend(mm, 2);
  const x = vkActies(mm, [a.id, b.id]);
  const g = mm.n8n('POST /mailman/verkoop/gedaan', { ronde: x.r.ronde, postvak: 'gmail:groenhouten', resultaten: [
    { gmail_id: a.id, soort: 'door', uitkomst: 'overgeslagen', fout: 'niet meer in de inbox' }, { gmail_id: b.id, soort: 'door', uitkomst: 'onzeker', fout: 'HTTP 503' }] });
  assert.equal(g.j.telling.overgeslagen, 1); assert.equal(g.j.telling.onzeker, 1);
  assert.equal(vRij(mm, a.id).status, 'overgeslagen'); assert.equal(vRij(mm, b.id).status, 'onzeker');
  const z = mm.zorgen().join('|');
  assert.ok(!/overgeslagen/.test(z)); assert.match(z, /onzeker/);
  fs.mkdirSync(path.join(tmp, 'mailman-verkoop-0123456789abcdef')); fs.writeFileSync(path.join(tmp, 'mailman-verkoop-0123456789abcdef', 'stuk.pdf'), 'x');
  fs.mkdirSync(path.join(tmp, 'iets-anders'));
  MM.maak({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-')), marker: poort, primair: function () { return true; }, verkoopTmp: tmp });
  assert.deepEqual(fs.readdirSync(tmp), ['iets-anders']);
});

test('wv1998 velden: factuurnummer en bedrag uit de nota (vormen zoals gemeten), anders null', () => {
  const V = MM.K.verkoopVelden;
  assert.deepEqual(V('Factuurnr : VACSH1NG-123\nOmschrijving VACSHING SHINGRIX € 199,00\nTe betalen € 199,00'), { nummer: 'VACSHING-123', bedrag_cent: 19900 }, 'genormaliseerd');
  // review wv1998 MOET 1: alleen de gemeten vorm VACSHING-<n>; nooit een datum of een (verminkte) naam als nummer
  for (const t of ['Factuurnr: 01-02-1950', 'Factuur nr. 12.05.1950', '5mit Factuurnr: 5mit', 'Factuur: 202610290001', 'VACSHING-12.5', 'XVACSHING-12']) assert.equal(V(t).nummer, null, t);
  assert.equal(V('Factuur: 29-10-2026 VACSHING-5').nummer, 'VACSHING-5', 'de datum ervoor telt niet');
  // review wv1998 ZOU 2/3: een datum is geen bedrag; subtotaal en excl. tellen niet
  assert.equal(V('Te betalen vóór 30.10.2026\nTotaal € 45,00').bedrag_cent, 4500);
  assert.equal(V('Subtotaal € 41,28\nBTW € 3,72\nTotaal € 45,00').bedrag_cent, 4500);
  assert.equal(V('Totaal excl. btw € 41,28\nTotaal incl. btw € 45,00').bedrag_cent, 4500);
  assert.deepEqual(V('Factuurnr :\nVACSHING-77 Proef\nTe betalen € 1.234,56'), { nummer: 'VACSHING-77', bedrag_cent: 123456 }, 'nummer op een andere regel');
  assert.deepEqual(V('Totaal € 45,00'), { nummer: null, bedrag_cent: 4500 });
  assert.deepEqual(V('€ 12,34 en nog eens € 12,34'), { nummer: null, bedrag_cent: 1234 }, 'het enige bedrag');
  assert.deepEqual(V('€ 1,00 en € 2,00'), { nummer: null, bedrag_cent: null }, 'twee bedragen zonder "te betalen": geen gok');
  assert.deepEqual(V('Factuur aan Proef Persoon\nFactuurdatum: 29-10-2026'), { nummer: null, bedrag_cent: null }, 'geen naam of datum als nummer');
  assert.deepEqual(V('te betalen: 45,00'), { nummer: null, bedrag_cent: null }, 'te betalen zonder € of EUR: geen bedrag');
  assert.deepEqual(V('te betalen: EUR 99999999,00'), { nummer: null, bedrag_cent: null }, 'onzinbedrag');
  assert.deepEqual(V(''), { nummer: null, bedrag_cent: null });
});

test('wv1998 tab Verkoop: naam, nummer en bedrag in het journaal; naam na 14 dagen weg; fase en open-teller; alleen lezen', async () => {
  const { mm, dir } = vkKamer();
  assert.equal(mm.app('GET /app/mailman/verkoop', {}, ctxVers(false)).j.open, 0);
  const a = vkMail(), b = vkMail(), c = vkMail();
  const { r } = vkRonde(mm, [a, b, c]);
  const nota = nepPdf('LAAG:Factuurnr: VACSHING-9 Proef Patient VACSHING SHINGRIX Te betalen EUR 45,00 en nog wat tekst erbij');   // de nep-lezer leest latin1: EUR i.p.v. €
  assert.equal((await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: a.id, bijlagen: [{ naam: 'Gordelroos Proef\u0007 Persoon.pdf', mime: 'application/pdf', b64: nota }] })).j.verkoop, true);
  assert.equal((await mm.verkoopToets({ ronde: r.ronde, postvak: 'gmail:groenhouten', gmail_id: b.id, bijlagen: [{ naam: 'Verwijzing Proef Persoon.pdf', b64: nepPdf('LAAG:andere factuur zonder ankers maar met genoeg tekst voor een tekstlaag') }] })).j.verkoop, false);
  assert.equal(JSON.parse(vRij(mm, b.id).pdfs)[0].naam, null, 'review #6: naam alleen bij een herkende verkoopnota');
  let t = mm.app('GET /app/mailman/verkoop', {}, ctxVers(false));
  assert.equal(t.status, 200); assert.equal(t.j.ok, true); assert.equal(t.j.namen_dagen, 14);
  const ra = t.j.verkoop.journaal.find(function (x) { return x.status === 'herkend'; });
  assert.deepEqual([ra.pdfs[0].naam, ra.pdfs[0].nummer, ra.pdfs[0].bedrag_cent], ['Gordelroos Proef Persoon.pdf', 'VACSHING-9', 4500], 'stuurteken weg');
  assert.equal(ra.onderwerp, 'gordelroos');
  assert.ok(!JSON.stringify(t.j).includes('Proef Patient'), 'geen notatekst');
  assert.ok(!JSON.stringify(mm._db.prepare('SELECT * FROM verkoop').all()).includes('Verwijzing Proef'), 'geen naam van niet-herkende mail in de databank');
  const fase = function (id) { const x = mm.app('GET /app/mailman/verkoop', {}, ctxVers(false)).j.verkoop.journaal.find(function (y) { return y.id === vRij(mm, id).id; }); return [x.fase, x.open]; };
  assert.deepEqual(fase(a.id), ['zelf', true], 'herkend terwijl doorsturen uit staat: David stuurt hem zelf door (telt 14 dagen)');
  assert.deepEqual(fase(b.id), ['niet_herkend', false]);
  assert.deepEqual(fase(c.id), ['wacht_toets', true]);
  assert.equal(mm.app('GET /app/mailman/verkoop', {}, ctxVers(false)).j.open, 2);
  // doorsturen + archiveren aan: een nota die ná het aanzetten binnenkwam wacht op doorsturen
  vkToestaan(dir);
  klok += 60000;   // aanzetten ná de eerste nota (die blijft 'zelf')
  assert.equal(mm.app('POST /app/mailman/verkoop', { door: true, archief: true }, ctxVers(true)).status, 200);
  klok += 60000;
  const nieuw = await vkHerkend(mm, 1), nid = nieuw[0].id;
  assert.deepEqual(fase(a.id), ['zelf', true], 'van vóór het aanzetten');
  assert.deepEqual(fase(nid), ['wacht_door', true]);
  // review #4: stand uit of toestemming weg → MailMan pakt hem niet op; ouder dan het zoekvenster → blijft liggen (bij David)
  mm._db.prepare("UPDATE postvak SET stand = 'uit' WHERE id = 'gmail:groenhouten'").run();
  assert.deepEqual(fase(nid), ['blijft', true]); assert.deepEqual(fase(c.id), ['niet_getoetst', false], 'kandidaat met stand uit');
  mm._db.prepare("UPDATE postvak SET stand = 'schaduw' WHERE id = 'gmail:groenhouten'").run();
  vkToestaan(dir, null);
  assert.deepEqual(fase(nid), ['blijft', true], 'zonder toestemming');
  vkToestaan(dir);
  klok += 3 * 86400000;
  assert.deepEqual(fase(nid), ['blijft', true], 'buiten het zoekvenster van de ronde');
  assert.deepEqual(fase(c.id), ['niet_getoetst', false], 'kandidaat ouder dan 25 uur');
  // aangeboden zonder terugmelding > 48 u: onzeker (ook als er geen ronde meer loopt)
  mm._db.prepare("UPDATE verkoop SET status = 'aangeboden', aangeboden_tijd = ? WHERE gmail_id = ?").run(new Date(klok - 49 * 3600000).toISOString(), nid);
  assert.deepEqual(fase(nid), ['onzeker', true]);
  mm._db.prepare("UPDATE verkoop SET aangeboden_tijd = ? WHERE gmail_id = ?").run(new Date(klok - 3600000).toISOString(), nid);
  assert.deepEqual(fase(nid), ['bezig', true]);
  // verstuurd: wacht op archiveren; na 5 pogingen archief mislukt (bij David)
  mm._db.prepare("UPDATE verkoop SET status = 'verstuurd', verstuurd_tijd = ?, bijgewerkt = ? WHERE gmail_id = ?").run(new Date(klok).toISOString(), new Date(klok).toISOString(), nid);
  assert.deepEqual(fase(nid), ['wacht_archief', true]);
  mm._db.prepare('UPDATE verkoop SET archief_pogingen = 5 WHERE gmail_id = ?').run(nid);
  assert.deepEqual(fase(nid), ['archief_mislukt', true]);
  mm._db.prepare("UPDATE verkoop SET status = 'geweigerd', bijgewerkt = ? WHERE gmail_id = ?").run(new Date(klok).toISOString(), nid);
  assert.deepEqual(fase(nid), ['geweigerd', true]);
  mm._db.prepare("UPDATE verkoop SET status = 'gearchiveerd', gearchiveerd_tijd = ? WHERE gmail_id = ?").run(new Date(klok).toISOString(), nid);
  assert.deepEqual(fase(nid), ['gearchiveerd', false]);
  mm._db.prepare("UPDATE verkoop SET status = 'geweigerd' WHERE gmail_id = ?").run(nid);
  // na 14 dagen: naam weg (ook uit de databank), nummer en bedrag blijven; wat bij David lag telt niet meer; kapotte JSON wordt niet stil overgeslagen
  mm._db.prepare("UPDATE verkoop SET pdfs = '{kapot' WHERE gmail_id = ?").run(c.id);
  mm._db.prepare("UPDATE verkoop SET pdfs = ? WHERE gmail_id = ?").run('[{"naam":"Kapot Proef.pdf"', b.id);
  klok += 15 * 86400000;
  mm.opruim();
  const pa = JSON.parse(vRij(mm, a.id).pdfs)[0];
  assert.equal(pa.naam, null); assert.equal(pa.nummer, 'VACSHING-9'); assert.equal(pa.bedrag_cent, 4500);
  assert.ok(!/Gordelroos Proef|Kapot Proef/.test(JSON.stringify(mm._db.prepare('SELECT * FROM verkoop').all())), 'review #5: ook kapotte JSON gewist');
  assert.deepEqual(fase(nid), ['geweigerd', false]); assert.deepEqual(fase(a.id), ['zelf', false]);
  // de route schrijft niets
  const voor = JSON.stringify(mm._db.prepare('SELECT * FROM verkoop').all()) + JSON.stringify(mm._db.prepare('SELECT * FROM postvak').all());
  mm.app('GET /app/mailman/verkoop', {}, ctxVers(false));
  assert.equal(JSON.stringify(mm._db.prepare('SELECT * FROM verkoop').all()) + JSON.stringify(mm._db.prepare('SELECT * FROM postvak').all()), voor);
});

test('wv2006: regel uit de verzonden mail — herkomst alleen in het overzicht, beslissing als een gewone In-regel, aan/uit/weg via de App', () => {
  const { mm } = nieuweKamer();
  const db = mm._db;
  const id = Number(db.prepare(`INSERT INTO regel (postvak, stap, volgorde, naam, voorwaarden, stroom, actief, bron, aangemaakt, bijgewerkt, versie)
    VALUES ('gmail:david', 'in', 50, 'Verzonden: lev.invalid', ?, 'factuur', 1, 'verzonden', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z', 1)`)
    .run(JSON.stringify({ van_adres: { op: 'is', w: 'nota@lev.invalid' }, bijlage: 'pdf' })).lastInsertRowid);
  db.prepare(`INSERT INTO regel_herkomst (regel_id, soort, aantal, doel, voorbeeld, laatst, waarom, gemeten) VALUES (?, 'verzonden', 7, 'Proef BV', 'Factuur 12', '2026-10-01', '7 van 7 pdf-mails doorgestuurd', '2026-10-30')`).run(id);
  const p = mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:david'; });
  const r = p.regels.find(function (x) { return x.id === id; });
  assert.equal(r.bron, 'verzonden');
  assert.deepEqual(r.herkomst, { soort: 'verzonden', aantal: 7, doel: 'Proef BV', voorbeeld: 'Factuur 12', laatst: '2026-10-01', waarom: '7 van 7 pdf-mails doorgestuurd', gemeten: '2026-10-30' });
  assert.equal(p.regels.filter(function (x) { return x.id !== id; }).every(function (x) { return x.herkomst === null; }), true);
  const m1 = mail({ van: 'Lev <nota@lev.invalid>', bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] });
  const m2 = mail({ van: 'Lev <nota@lev.invalid>' });   // zonder pdf: regel past niet
  draai(mm, 'gmail:david', [m1, m2], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 2.5 }); } });
  assert.equal(rij(mm, m1.id).stroom, 'factuur'); assert.equal(rij(mm, m1.id).regel_id, id);
  assert.notEqual(rij(mm, m2.id).regel_id, id);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'aanuit', id, actief: false }).status, 200);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'weg', id }).status, 200);
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken.find(function (x) { return x.id === 'gmail:david'; }).regels.some(function (x) { return x.id === id; }), false);
});

test('wv2006 review MOET 1: Davids eigen In-regel gaat altijd vóór een regel uit de verzonden mail; ↑/↓ ruilt alleen binnen de eigen groep', () => {
  const { mm } = nieuweKamer();
  const db = mm._db;
  const vz = Number(db.prepare(`INSERT INTO regel (postvak, stap, volgorde, naam, voorwaarden, stroom, actief, bron, aangemaakt, bijgewerkt, versie)
    VALUES ('gmail:david', 'in', 1, 'Verzonden: lev.invalid', ?, 'factuur', 1, 'verzonden', '2026-10-30T00:00:00Z', '2026-10-30T00:00:00Z', 1)`)
    .run(JSON.stringify({ van_domein: { op: 'is', w: 'lev.invalid' }, bijlage: 'pdf' })).lastInsertRowid);
  const eigen1 = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'in', naam: 'vraag', voorwaarden: { van_domein: { op: 'is', w: 'lev.invalid' }, onderwerp: { op: 'bevat', w: 'vraag' } }, stroom: 'intake' }).j.id;
  const eigen2 = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'in', naam: 'b', voorwaarden: { onderwerp: { op: 'bevat', w: 'zzz' } }, stroom: 'intake' }).j.id;
  const m = mail({ van: 'Lev <x@lev.invalid>', onderwerp: 'Een vraag over de nota', bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] });
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 2.5 }); } });
  assert.equal(rij(mm, m.id).regel_id, eigen1); assert.equal(rij(mm, m.id).stroom, 'intake');
  // ↑ op Davids eerste regel: geen buur in zijn groep (de verzonden-regel met volgorde 1 telt niet mee); ↓ ruilt met zijn tweede
  const vo = function (id) { return db.prepare('SELECT volgorde FROM regel WHERE id = ?').get(id).volgorde; };
  const v1 = vo(eigen1), vvz = vo(vz);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'op', id: eigen1 }).status, 200);
  assert.equal(vo(eigen1), v1); assert.equal(vo(vz), vvz);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'neer', id: eigen1 }).status, 200);
  assert.ok(vo(eigen1) > vo(eigen2));
});
