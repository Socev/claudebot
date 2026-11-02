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
  // wv2189: actie_anders (iets anders dan betalen) volgt standaard actie, zodat de oudere toetsen hetzelfde blijven
  answers.actie_anders = { type: 'noul', noul: w.actie_anders != null ? w.actie_anders : (w.actie == null ? 0.02 : w.actie) };
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

// ── wv2029: een nieuwe regel direct op de pijplijn (Twijfel open + wachtend op Jev) en de bron voor het voorbeeld rechts ──
test('wv2029 pijplijn: telling vooraf = toepassen; Twijfel open krijgt de keuze, wachtend op Jev volgt de regel; verwerkt, al gekozen en een eerdere regel blijven', () => {
  const { mm } = nieuweKamer();
  const SCHOOL = { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };   // → Twijfel (score)
  const KRANT = 'Weekkrant <post@krant.invalid>';
  const t1 = mail({ van: KRANT, onderwerp: 'Weekbrief 12' }), t2 = mail({ van: KRANT, onderwerp: 'Weekbrief 13' });
  const t3 = mail({ van: KRANT, onderwerp: 'Weekbrief 14' });                    // David koos al
  const t4 = mail({ van: 'Ander <x@ander.invalid>', onderwerp: 'Weekbrief 12' });   // past niet
  const t5 = mail({ van: KRANT, onderwerp: 'Advertentie weekbrief' });            // een eerdere (Weg-)regel pakt hem eerst
  const k1 = mail({ van: KRANT, onderwerp: 'Systeembericht' });                   // al verwerkt (Info)
  draai(mm, 'gmail:david', [t1, t2, t3, t4, t5, k1], { jev: function (a) { return jevAntwoord(a.gmail_id === k1.id ? { systeem: 0.99, waarde: 0 } : SCHOOL); } });
  const w1 = mail({ van: KRANT, onderwerp: 'Weekbrief 15' });
  draai(mm, 'gmail:david', [w1], { jev: function () { return undefined; } });
  const d1 = mail({ van: KRANT, onderwerp: 'Weekbrief 12' });
  draai(mm, 'gmail:groenhouten', [d1]);
  for (const m of [t1, t2, t3, t4, t5]) assert.equal(rij(mm, m.id).stroom, 'twijfel', m.onderwerp);
  assert.equal(rij(mm, k1.id).stroom, 'info'); assert.equal(rij(mm, w1.id).status, 'wacht_jev'); assert.equal(rij(mm, d1.id).stroom, 'twijfel');
  assert.equal(mm.app('POST /app/mailman/oordeel', { id: rij(mm, t3.id).id, juist: 'intake' }).status, 200);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'adv', voorwaarden: { onderwerp: { op: 'bevat', w: 'Advertentie' } } }).status, 200);
  const vw = { van_domein: { op: 'is', w: 'krant.invalid' } };
  const tel = function (pv) { return mm.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: pv, stap: 'in', stroom: 'factuur', voorwaarden: vw }); };
  let t = tel('gmail:david');
  assert.equal(t.status, 200, JSON.stringify(t.j));
  assert.deepEqual([t.j.twijfel, t.j.wacht, t.j.totaal, t.j.naar], [2, 1, 3, 'factuur']);
  assert.deepEqual(t.j.voorbeelden.map(function (r) { return r.id; }).sort(), [t1, t2, w1].map(function (m) { return rij(mm, m.id).id; }).sort());
  assert.equal(tel('*').j.twijfel, 3, 'een regel voor beide postvakken raakt ook Doktersmaten');
  assert.equal(mm.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: 'gmail:david', stap: 'in', stroom: 'info', voorwaarden: vw }).status, 400);
  assert.equal(mm.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: 'gmail:nergens', stap: 'weg', voorwaarden: vw }).status, 400);
  assert.equal(mm.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: 'gmail:david', stap: 'weg', voorwaarden: {} }).status, 400);
  // zonder vinkje: de regel geldt alleen voor nieuwe mail
  const zonder = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'in', naam: 'zz', voorwaarden: { onderwerp: { op: 'is', w: 'Weekbrief 13' } }, stroom: 'intake' });
  assert.equal(zonder.status, 200); assert.equal(zonder.j.pijplijn, undefined); assert.equal(rij(mm, t2.id).juist, null);
  mm.app('POST /app/mailman/regel', { actie: 'weg', id: zonder.j.id });
  const r = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'in', naam: 'Weekkrant', voorwaarden: vw, stroom: 'factuur', pijplijn: true });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.deepEqual(r.j.pijplijn, { twijfel: 2, wacht: 1, totaal: 3, naar: 'factuur', al_door: 0 });
  // nog niets in Gmail gezet (schaduw): ook het besluit volgt de regel (review ZOU 1)
  for (const m of [t1, t2]) { const b = rij(mm, m.id); assert.deepEqual([b.juist, b.juist_regel, b.stroom, b.stap, b.regel_id, b.reden], ['factuur', r.j.id, 'factuur', 'in', r.j.id, 'regel']); assert.ok(b.juist_tijd); assert.deepEqual(JSON.parse(b.labels_plan), ['FACTUUR']); }
  assert.deepEqual([rij(mm, t3.id).juist, rij(mm, t3.id).juist_regel], ['intake', null], 'Davids eigen keuze blijft');
  assert.equal(rij(mm, t4.id).juist, null); assert.equal(rij(mm, t5.id).juist, null, 'de Weg-regel gaat vóór');
  assert.deepEqual([rij(mm, k1.id).stroom, rij(mm, k1.id).juist], ['info', null], 'verwerkte post nooit opnieuw');
  assert.equal(rij(mm, d1.id).juist, null, 'regel alleen voor Privé raakt Doktersmaten niet');
  const w = rij(mm, w1.id);
  assert.deepEqual([w.status, w.stap, w.stroom, w.regel_id, w.reden], ['wacht_jev', 'in', 'factuur', r.j.id, 'regel']);
  const wz = mm._db.prepare("SELECT * FROM wijziging WHERE wat = 'regel_pijplijn'").get();
  assert.equal(JSON.parse(wz.nieuw).twijfel.length, 2); assert.equal(Number(wz.sleutel), r.j.id);
  assert.equal(tel('gmail:david').j.totaal, 0, 'nog eens: niets meer te doen');
  // Jev antwoordt alsnog: de stroom van de regel blijft, het plan volgt de regel (FACTUUR), de Jev-meting komt erbij
  draai(mm, 'gmail:david', [w1], { jev: function () { return jevAntwoord(SCHOOL); } });
  const w2 = rij(mm, w1.id);
  assert.deepEqual([w2.status, w2.stroom, w2.reden], ['klaar', 'factuur', 'regel']); assert.deepEqual(JSON.parse(w2.labels_plan), ['FACTUUR']); assert.ok(w2.jev);
  // Werkstroom en logboek: uit Twijfel, juist_regel in de rij; Davids eigen keuze daarna wist de regel-herkomst
  const lijst = mm.werkstroomLijst('twijfel', 'gmail:david').rijen.map(function (x) { return x.id; });
  assert.ok(!lijst.includes(rij(mm, t1.id).id)); assert.ok(lijst.includes(rij(mm, t4.id).id));
  const lr = mm.app('GET /app/mailman', {}).j.postvakken.find(function (q) { return q.id === 'gmail:david'; }).logboek.find(function (x) { return x.id === rij(mm, t1.id).id; });
  assert.equal(lr.juist_regel, r.j.id);
  assert.ok(mm.werkstroomLijst('verwerkt', 'gmail:david').rijen.some(function (x) { return x.id === rij(mm, t1.id).id; }), 'telt als verwerkt');
  mm.app('POST /app/mailman/oordeel', { id: rij(mm, t1.id).id, juist: 'info' });
  assert.deepEqual([rij(mm, t1.id).juist, rij(mm, t1.id).juist_regel], ['info', null]);
  mm.app('POST /app/mailman/oordeel', { id: rij(mm, t1.id).id, juist: null });
  assert.deepEqual([rij(mm, t1.id).juist, rij(mm, t1.id).juist_tijd], [null, null]);
});

test('wv2029 pijplijn: Overig (Filter Weg) geeft de keuze Info; een regel voor beide postvakken; niet op de reservekant', () => {
  const { mm } = nieuweKamer();
  const SCHOOL = { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };
  const a = mail({ van: 'Club <nieuws@club.invalid>' });
  draai(mm, 'gmail:david', [a], { jev: function () { return jevAntwoord(SCHOOL); } });
  const b = mail({ van: 'Club <nieuws@club.invalid>' });
  draai(mm, 'gmail:groenhouten', [b]);
  const r = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: '*', stap: 'weg', naam: 'Club', voorwaarden: { van_adres: { op: 'is', w: 'nieuws@club.invalid' } }, pijplijn: true });
  assert.deepEqual(r.j.pijplijn, { twijfel: 2, wacht: 0, totaal: 2, naar: 'info', al_door: 0 });
  assert.equal(rij(mm, a.id).juist, 'info'); assert.equal(rij(mm, b.id).juist, 'info');
  const { mm: res } = nieuweKamer({ primair: function () { return false; } });
  assert.equal(res.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: '*', stap: 'weg', naam: 'x', voorwaarden: { van_adres: { op: 'is', w: 'a@b.invalid' } }, pijplijn: true }).status, 503);
  assert.equal(res.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: '*', stap: 'weg', voorwaarden: { van_adres: { op: 'is', w: 'a@b.invalid' } } }).status, 200, 'tellen mag ook op de reservekant');
});

test('wv2029 voorbeeld rechts: mailBron geeft alleen Gmail-id, postvak en bijlagesoorten; niet na 14 dagen en niet voor verzonden mail', () => {
  const { mm } = nieuweKamer();
  const m = mail({ bijlagen: [{ naam: 'geheim-naam.pdf', mime: 'application/pdf' }] });
  const v = mail({ labels: ['SENT'] });
  draai(mm, 'gmail:david', [m, v], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 2.5 }); } });
  const b = mm.mailBron(rij(mm, m.id).id);
  assert.deepEqual(b, { id: rij(mm, m.id).id, postvak: 'gmail:david', gmail_id: m.id, gedeeld: false, bijlagen: ['application/pdf'] });
  assert.ok(!JSON.stringify(b).includes('geheim-naam'));
  assert.equal(mm.mailBron(rij(mm, v.id).id), null, 'verzonden of concept: nooit');
  assert.equal(mm.mailBron(999999), null); assert.equal(mm.mailBron('x'), null);
  klok += 15 * DAG; mm.opruim(); klok -= 15 * DAG;
  assert.equal(mm.mailBron(rij(mm, m.id).id), null, 'na 14 dagen weg');
});

test('wv2029 pijplijn live (review ZOU 1/2): al gelabelde Twijfel blijft waar hij is (al_door), nog niet gelabelde krijgt bij de labelronde de regel en niet "twijfel naar"', () => {
  const { mm, dir } = nieuweKamer();
  const SCHOOL = { factuur: 0.02, mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };
  toestaan(dir, ['gmail:david']); zetLive(mm);
  const a = mail({ van: 'Lev <nota@lev2.invalid>' }), b = mail({ van: 'Lev <nota@lev2.invalid>' });
  const u = draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord(SCHOOL); } });
  // a kreeg al het wachtrijlabel (twijfel naar intake), b nog niet (wachtrij vol of mislukt)
  const l = mm.n8n('POST /mailman/labels', { ronde: u.r.ronde, postvak: 'gmail:david', ids: [a.id] });
  assert.deepEqual(l.j.acties.map(function (x) { return [x.gmail_id, x.erbij]; }), [[a.id, ['AI/MailMan']]]);
  mm.n8n('POST /mailman/gezet', { ronde: u.r.ronde, postvak: 'gmail:david', resultaten: [{ gmail_id: a.id, erbij: ['AI/MailMan'], ok: true }] });
  const vw = { van_adres: { op: 'is', w: 'nota@lev2.invalid' } };
  assert.equal(mm.app('POST /app/mailman/toets', { soort: 'pijplijn', postvak: 'gmail:david', stap: 'in', stroom: 'factuur', voorwaarden: vw }).j.al_door, 1);
  const r = mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'in', naam: 'Lev', voorwaarden: vw, stroom: 'factuur', pijplijn: true });
  assert.deepEqual(r.j.pijplijn, { twijfel: 2, wacht: 0, totaal: 2, naar: 'factuur', al_door: 1 });
  assert.deepEqual([rij(mm, a.id).stroom, rij(mm, a.id).juist, rij(mm, a.id).labels_gezet], ['twijfel', 'factuur', '["AI/MailMan"]'], 'al door: besluit en labels blijven');
  assert.deepEqual([rij(mm, b.id).stroom, rij(mm, b.id).juist], ['factuur', 'factuur']);
  const l2 = labelRonde(mm, [a.id, b.id]).l;
  assert.deepEqual(l2.j.acties.map(function (x) { return [x.gmail_id, x.erbij]; }), [[b.id, ['FACTUUR']]], 'b volgt de regel, a krijgt niets meer');
});

test('wv2029 pijplijn: een wachtend besluit dat 24 uur geen Jev-antwoord krijgt, valt op de stroom van de regel (sluitOudeWachters, review KAN 5)', () => {
  const { mm } = nieuweKamer();
  const w = mail({ van: 'Lev <nota@lev3.invalid>' });
  draai(mm, 'gmail:david', [w], { jev: function () { return undefined; } });
  assert.equal(rij(mm, w.id).status, 'wacht_jev');
  mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', naam: 'Lev', voorwaarden: { van_adres: { op: 'is', w: 'nota@lev3.invalid' } }, pijplijn: true });
  klok += 25 * 3600000;
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [], volledig: true });
  const b = rij(mm, w.id);
  assert.deepEqual([b.status, b.stap, b.stroom, b.reden], ['klaar', 'weg', 'info', 'regel']);
  assert.deepEqual(JSON.parse(b.labels_plan), ['INFO']);
  klok -= 25 * 3600000;
});

// ── B8 labelset 2 (wv2033): labels als routering, achter config.json labelset2 ──
const IDS2 = { INTAKE: 'Label_80', FACTUUR: 'Label_71', NIEUWSBRIEF: 'Label_81', SOCIAAL: 'Label_82', OVERIG: 'Label_74', TWIJFEL: 'Label_83', TODO: 'Label_72', ACTIE_DS: 'Label_84', 'AI/MailMan': 'Label_73' };
function l2Toestaan(dir, extra) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.labelset2 = { 'gmail:david': { ja: '2026-11-02T08:45:00Z', ids: Object.assign({}, IDS2, extra || {}) }, 'gmail:groenhouten': { ja: 'x', ids: IDS2 } };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
// Nep-Gmail: labels per bericht op naam; verzonden berichten tellen nooit mee in de lijsten (-in:sent)
function nepGmail() {
  const ber = new Map();
  const g = {
    ber,
    voeg: function (m, sent) { ber.set(m.id, { thread: m.threadId, labels: new Set(), sent: !!sent, plek: 'inbox' }); return m; },
    plek: function (id, p) { ber.get(id).plek = p; },   // wv2189: inbox | archief | prullenbak (David)
    zet: function (id, l) { ber.get(id).labels.add(l); },
    weg: function (id, l) { ber.get(id).labels.delete(l); },
    heeft: function (id, l) { return ber.get(id).labels.has(l); },
    draadLabel: function (thread, l) { for (const x of ber.values()) if (x.thread === thread) x.labels.add(l); },   // Gmail-UI: het hele gesprek
    lijsten: function (o) {
      o = o || {};
      const uit = Object.keys(IDS2).map(function (naam) {
        return { naam, id: o.ander && o.ander[naam] ? o.ander[naam] : IDS2[naam], volledig: o.afgekapt !== naam,
          berichten: Array.from(ber.entries()).filter(function (e) { return (o.metVerzonden || !e[1].sent) && e[1].plek !== 'prullenbak' && !(o.leeg && naam !== 'AI/MailMan') && e[1].labels.has(naam); }).map(function (e) { return { gmail_id: e[0], thread_id: e[1].thread }; }) };
      });
      // wv2189: per vlag de lijst in de inbox en buiten de inbox (gearchiveerd of prullenbak; zonder tijdgrens, nooit verzonden)
      if (o.vlag) for (const l of ['TODO', 'ACTIE_DS']) for (const kant of ['inbox', 'uit']) {
        uit.push({ naam: l + '@' + kant, id: o.vlagId || IDS2[l], volledig: o.vlagAfgekapt !== l + '@' + kant,
          berichten: Array.from(ber.entries()).filter(function (e) { return !e[1].sent && e[1].labels.has(l) && (kant === 'inbox' ? e[1].plek === 'inbox' : e[1].plek !== 'inbox'); }).map(function (e) { return { gmail_id: e[0], thread_id: e[1].thread }; }) });
      }
      // wv2218: de inbox van de laatste 14 dagen (alleen id's, nooit verzonden)
      if (o.inbox) uit.push({ naam: 'INBOX', id: o.inboxId || 'INBOX', volledig: !o.inboxAfgekapt,
        berichten: Array.from(ber.entries()).filter(function (e) { return !e[1].sent && e[1].plek === 'inbox'; }).map(function (e) { return { gmail_id: e[0], thread_id: e[1].thread }; }) });
      return uit;
    },
    fout: false,
    pas: function (acties) {
      return acties.map(function (a) {
        const x = ber.get(a.gmail_id);
        if (g.fout) return { gmail_id: a.gmail_id, ok: false, fout: 'HTTP 500' };
        if (!x || x.sent) return { gmail_id: a.gmail_id, ok: false, overgeslagen: true };
        // wv2189: de n8n-grens bij afgedaan: nooit in de inbox, nooit bij NIEUWSBRIEF, alleen weghalen wat er staat; prullenbak mag
        if (a.soort === 'afgedaan' && (x.plek === 'inbox' || x.labels.has('NIEUWSBRIEF'))) return { gmail_id: a.gmail_id, ok: false, overgeslagen: true };
        if (a.soort === 'afgedaan') {
          const w = a.eraf.filter(function (l) { return x.labels.has(l); }); w.forEach(function (l) { x.labels.delete(l); });
          const uit = { gmail_id: a.gmail_id, erbij: [], eraf: w, ok: true };
          // wv2196: op de andere berichten alleen als niets van de draad nog in de inbox staat
          const zus = a.draad ? Array.from(ber.entries()).filter(function (e) { return e[0] !== a.gmail_id && e[1].thread === x.thread && !e[1].sent; }) : [];
          if (zus.length && !zus.some(function (e) { return e[1].plek === 'inbox'; })) {
            uit.draad = zus.map(function (e) { const af = a.eraf.filter(function (l) { return e[1].labels.has(l) && ((a.draad_eraf || {})[l] || []).includes(e[0]); }); af.forEach(function (l) { e[1].labels.delete(l); }); return { gmail_id: e[0], erbij: [], eraf: af, ok: true }; }).filter(function (y) { return y.eraf.length; });
          }
          return uit;
        }
        if (x.plek === 'prullenbak') return { gmail_id: a.gmail_id, ok: false, overgeslagen: true };
        // de n8n-grens haalt alleen weg wat er staat: opruim zonder iets te doen = overgeslagen
        if (a.soort === 'opruim' && !a.eraf.some(function (l) { return x.labels.has(l); })) return { gmail_id: a.gmail_id, ok: false, overgeslagen: true };
        // wv2196: zoals de n8n-grens — bij een draadactie eerst wat dit bericht van de draad erft (erf), dan de zichtbare labels op de andere
        // binnengekomen berichten van de draad (nooit verzonden, nooit prullenbak), niet wat David in de draad weghaalde (draad_niet)
        const erf = [], dr = [];
        const zus = a.draad ? Array.from(ber.entries()).filter(function (e) { return e[0] !== a.gmail_id && e[1].thread === x.thread && !e[1].sent && e[1].plek !== 'prullenbak'; }) : [];
        for (const l of a.erf || []) if (zus.some(function (e) { return e[1].labels.has(l); }) && !x.labels.has(l)) { x.labels.add(l); erf.push(l); }
        // erfde het bericht een categorie, dan geen OVERIG erbij (zoals de n8n-grens)
        const erbijM = erf.some(function (l) { return ['INTAKE', 'NIEUWSBRIEF', 'SOCIAAL'].includes(l); }) ? a.erbij.filter(function (l) { return l !== 'OVERIG'; }) : a.erbij;
        for (const l of erbijM) if (!['UNREAD', 'INBOX'].includes(l)) x.labels.add(l);
        for (const l of a.eraf) x.labels.delete(l);
        if (a.eraf.includes('INBOX')) x.plek = 'archief';
        if (a.erbij.includes('INBOX')) x.plek = 'inbox';   // wv2259 terug
        if (a.erbij.includes('UNREAD')) x.ongelezen = true;
        for (const [zid, z] of zus) {
          const bij = a.erbij.filter(function (l) { return K.DRAAD_LABELS.includes(l) && !(a.draad_niet || []).includes(l) && !z.labels.has(l) && !(l === 'OVERIG' && ['INTAKE', 'FACTUUR', 'NIEUWSBRIEF', 'SOCIAAL'].some(function (c) { return z.labels.has(c); })); });
          const af = a.eraf.filter(function (l) { return K.DRAAD_LABELS.includes(l) && z.labels.has(l) && ((a.draad_eraf || {})[l] || []).includes(zid); });
          bij.forEach(function (l) { z.labels.add(l); }); af.forEach(function (l) { z.labels.delete(l); });
          if (bij.length || af.length) dr.push({ gmail_id: zid, erbij: bij, eraf: af, ok: true });
        }
        const uit = { gmail_id: a.gmail_id, erbij: erbijM, eraf: a.eraf, ok: true };
        if (dr.length) uit.draad = dr;
        if (erf.length) uit.erf = erf;
        return uit;
      });
    },
  };
  return g;
}
function l2Ronde(mm, gm, ids, o) {
  o = o || {};
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids, volledig: true });
  const s = mm.n8n('POST /mailman/labelstaat', { ronde: r.ronde, postvak: 'gmail:david', labels: gm.lijsten(o) });
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids });
  const res = o.nietZetten ? [] : gm.pas(l.j.acties || []);
  const g = mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: res });
  return { r, s, l, g };
}
function b8Kamer() {
  const intake = new Set();
  const k = nieuweKamer({ intakeBerichten: function (pv, ids) { return new Set(ids.filter(function (i) { return intake.has(i); })); } });
  return Object.assign(k, { intake, gm: nepGmail() });
}
function route(mm, id) { return mm._db.prepare("SELECT * FROM route WHERE gmail_id = ? AND doel = 'intake'").get(id); }
function routes(mm) { return mm._db.prepare('SELECT count(*) n FROM route').get().n; }
function lsRij(mm, id, l) { return mm._db.prepare('SELECT * FROM label_staat WHERE gmail_id = ? AND label = ?').get(id, l); }
function correcties(mm) { return mm._db.prepare('SELECT * FROM correctie ORDER BY id').all(); }
const JEV_INTAKE = { mens: 0.95, waarde: 3, actie: 0.2 }, JEV_INFO = { systeem: 0.99, waarde: 0 };

test('B8 labelset2Lees: alle verplichte namen met een eigen geldig ID; optioneel alleen als genoemd; anders uit', () => {
  assert.equal(K.labelset2Lees(null).ok, false);
  assert.equal(K.labelset2Lees({ ids: IDS2 }).ok, false, 'zonder ja');
  assert.equal(K.labelset2Lees({ ja: 'x', ids: Object.assign({}, IDS2, { TWIJFEL: undefined }) }).ok, false, 'TWIJFEL ontbreekt');
  assert.equal(K.labelset2Lees({ ja: 'x', ids: Object.assign({}, IDS2, { ACTIE_DS: 'Label_71' }) }).ok, false, 'ID twee keer');
  assert.equal(K.labelset2Lees({ ja: 'x', ids: Object.assign({}, IDS2, { INTAKE: 'INBOX' }) }).ok, false, 'systeemlabel');
  const r = K.labelset2Lees({ ja: 'x', ids: Object.assign({}, IDS2, { BEZORGING: 'Label_90' }) });
  assert.equal(r.ok, true); assert.ok(r.namen.includes('BEZORGING')); assert.ok(!r.namen.includes('AGENDA'));
  assert.equal(K.labelset2Lees({ ja: 'x', ids: Object.assign({}, IDS2, { AGENDA: 'fout' }) }).ok, false, 'optioneel met ongeldig ID');
});

test('B8 labelPlan2: één hoofdcategorie, NIEUWSBRIEF/SOCIAAL erbij, OVERIG alleen zonder andere categorie, TODO en ACTIE_DS', () => {
  const inst = { todo_nooit: ['doctolib'] };
  const m = function (o) { return Object.assign({ van_domein: 'voorbeeld.invalid', onderwerp: 'x', afmeld: false, tab: null }, o || {}); };
  assert.deepEqual(K.labelPlan2('info', null, m(), inst).labels, ['OVERIG']);
  assert.deepEqual(K.labelPlan2('info', null, m({ afmeld: true }), inst).labels, ['NIEUWSBRIEF'], 'nieuwsbrief alleen = geen OVERIG');
  assert.deepEqual(K.labelPlan2('intake', null, m({ afmeld: true }), inst).labels, ['INTAKE'], 'geen NIEUWSBRIEF bij INTAKE');
  assert.deepEqual(K.labelPlan2('factuur', null, m({ afmeld: true }), inst).labels, ['FACTUUR']);
  assert.deepEqual(K.labelPlan2('twijfel', null, m({ afmeld: true }), inst).labels, ['NIEUWSBRIEF'], 'wv2196: TWIJFEL nooit in Gmail');
  assert.equal(K.labelPlan2('twijfel', null, m(), inst).hoofd, 'TWIJFEL', 'wv2196: wel intern');
  assert.deepEqual(K.labelPlan2('twijfel', null, m(), inst).labels, []);
  assert.deepEqual(K.labelPlan2('info', null, m({ van_domein: 'e.linkedin.com' }), inst).labels, ['SOCIAAL']);
  assert.deepEqual(K.labelPlan2('info', null, m({ tab: 'sociaal' }), inst).labels, ['SOCIAAL']);
  assert.deepEqual(K.labelPlan2('info', null, m(), inst, ['BEZORGING']).labels, ['BEZORGING'], 'regel-label is een categorie');
  assert.deepEqual(K.labelPlan2('info', null, m(), inst, ['TODO']).labels, ['OVERIG', 'TODO'], 'een vlag is geen categorie');
  assert.deepEqual(K.labelPlan2('intake', { mens: 0.9, actie: 0.9, waarde: 3 }, m(), inst).labels, ['INTAKE', 'ACTIE_DS'], 'ACTIE_DS, geen TODO ernaast');
  assert.deepEqual(K.labelPlan2('intake', { mens: 0.2, actie: 0.9, waarde: 1.5 }, m(), inst).labels, ['INTAKE', 'TODO']);
  assert.deepEqual(K.labelPlan2('intake', { mens: 0.2, actie: 0.9, waarde: 1.4 }, m(), inst).labels, ['INTAKE'], 'waarde < 1,5');
  assert.deepEqual(K.labelPlan2('factuur', { mens: 0.2, actie: 0.99, waarde: 3 }, m(), inst).labels, ['FACTUUR'], 'geen TODO bij FACTUUR');
  assert.deepEqual(K.labelPlan2('intake', { mens: 0.9, actie: 0.9, waarde: 3 }, m({ van_domein: 'doctolib.nl' }), inst).labels, ['INTAKE'], 'todo_nooit');
  assert.deepEqual(K.labelPlan2('verkoop', null, m(), inst).labels, []);
  assert.deepEqual(K.labelPlan2('intake', null, m(), { gedeeld: true }).labels, []);
  assert.equal(K.toetsRegelLabels(['INTAKE']).ok, false, 'INTAKE gaat via de stroom van de regel, niet via labels');
  assert.equal(K.toetsRegelLabels(['_AI_']).ok, false);
  assert.deepEqual(K.toetsRegelLabels(['SOCIAAL', 'SOCIAAL', 'TODO']).l, ['SOCIAAL', 'TODO']);
});

test('B8 zonder labelset2: gedrag 1.8 (labelstaat doet niets, labels() geeft de 1.8-labels), label_staat volgt wel', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail()];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(a.gmail_id === ms[0].id ? JEV_INTAKE : JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm);
  ms.forEach(function (m) { gm.voeg(m); });
  const x = l2Ronde(mm, gm, ms.map(function (m) { return m.id; }));
  assert.deepEqual(x.s.j, { ok: true, actief: false });
  const per = perId(x.l.j.acties);
  assert.deepEqual(per[ms[0].id].erbij, ['AI/MailMan']); assert.deepEqual(per[ms[1].id].erbij, ['INFO']);
  assert.equal(x.l.j.labelset, undefined);
  assert.deepEqual(x.g.j.telling, { ok: 2, fout: 0, gelezen: 0, archief: 0 });
  assert.equal(routes(mm), 0);
  assert.equal(lsRij(mm, ms[1].id, 'OVERIG').bron, 'mailman', 'INFO staat als OVERIG (zelfde label-ID) in label_staat');
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).labelset, false);
  // ongeldige labelset2 = uit
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.labelset2 = { 'gmail:david': { ja: 'x', ids: { INTAKE: 'Label_80' } } }; fs.writeFileSync(f, JSON.stringify(c));
  assert.equal(l2Ronde(mm, gm, []).s.j.actief, false);
  assert.match(mm.app('GET /app/mailman', {}).j.postvakken[0].labelset2.reden, /geen geldig ID/);
});

test('B8 nieuw besluit: categorie + vlaggen; INTAKE krijgt de wachtrij en één route; Twijfel gaat nergens heen; nooit AI/MailMan op _AI_', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail({ afmeld: true }), mail({ aan: ALIAS, bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] }), mail(), mail({ labels: ['INBOX', '_AI_'] }), mail({ van: 'LinkedIn <x@e.linkedin.com>' })];
  const jev = [{ mens: 0.95, actie: 0.95, waarde: 3 }, JEV_INFO, JEV_INFO, { mens: 0.5, waarde: 1.5, actie: 0.1 }, JEV_INFO, JEV_INFO];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(jev[ms.findIndex(function (m) { return m.id === a.gmail_id; })]); } });
  assert.equal(rij(mm, ms[3].id).stroom, 'twijfel');
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  const x = l2Ronde(mm, gm, ids);
  assert.equal(x.s.j.actief, true); assert.equal(x.l.j.labelset, 2);
  const per = perId(x.l.j.acties);
  assert.deepEqual(per[ms[0].id].erbij, ['INTAKE', 'ACTIE_DS', 'AI/MailMan']);
  assert.deepEqual(per[ms[1].id].erbij, ['NIEUWSBRIEF']);
  assert.deepEqual(per[ms[2].id].erbij, ['FACTUUR']);
  assert.equal(per[ms[3].id], undefined, 'Twijfel routeert niet meteen en krijgt geen label (wv2196)');
  assert.equal(rij(mm, ms[3].id).labels_gezet, '[]');
  assert.deepEqual(per[ms[4].id].erbij, ['INTAKE'], 'Davids _AI_: wel INTAKE, nooit het wachtrijlabel');
  assert.deepEqual(per[ms[5].id].erbij, ['SOCIAAL']);
  for (const a of x.l.j.acties) { for (const l of a.erbij) assert.ok(K.L2_VAST.includes(l), l); assert.deepEqual(a.eraf, []); assert.equal(a.soort, 'besluit'); }
  assert.equal(route(mm, ms[0].id).status, 'wachtrij');
  assert.equal(route(mm, ms[4].id).status, 'gepland', '_AI_: gepland tot Intake hem heeft (Mail Processor via _AI_)');
  assert.equal(routes(mm), 2);
  assert.deepEqual(correcties(mm), [], 'eigen acties zijn geen correctie');
  // volgende ronde: alles staat, niets dubbel; _AI_-route krijgt nooit het wachtrijlabel
  const y = l2Ronde(mm, gm, ids);
  assert.deepEqual(y.l.j.acties, []);
  assert.equal(y.s.j.telling.david_erbij, 0, 'MailMans eigen labels tellen niet als David');
  assert.equal(routes(mm), 2);
});

test('B8 handmatig INTAKE → één route, nogmaals → geen tweede; eruit in de wachtrij → intrekken; weer erop → gepland', () => {
  const { mm, dir, gm } = b8Kamer();
  const m = mail();
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(m);
  l2Ronde(mm, gm, [m.id]);
  assert.ok(gm.heeft(m.id, 'OVERIG'));
  gm.zet(m.id, 'INTAKE');   // David in Gmail
  const a = l2Ronde(mm, gm, [m.id]);
  assert.equal(a.s.j.telling.david_erbij, 1); assert.equal(a.s.j.telling.routes_nieuw, 1);
  assert.equal(lsRij(mm, m.id, 'INTAKE').bron, 'david');
  assert.deepEqual(a.l.j.acties.map(function (x) { return [x.soort, x.erbij]; }), [['route', ['AI/MailMan']]]);
  assert.equal(route(mm, m.id).status, 'wachtrij');
  assert.equal(correcties(mm).length, 1); assert.equal(correcties(mm)[0].van, 'OVERIG'); assert.equal(correcties(mm)[0].naar, 'INTAKE');
  const b = l2Ronde(mm, gm, [m.id]);
  assert.deepEqual(b.l.j.acties.map(function (x) { return [x.soort, x.erbij, x.eraf]; }), [['opruim', [], ['OVERIG']]], 'David koos een categorie: MailMans OVERIG eraf');
  assert.ok(!gm.heeft(m.id, 'OVERIG'));
  assert.deepEqual(l2Ronde(mm, gm, [m.id]).l.j.acties, []); assert.equal(routes(mm), 1, 'nogmaals: geen tweede route');
  // David haalt INTAKE weg terwijl de route in de wachtrij staat → ingetrokken, MailMan haalt zijn wachtrijlabel weg
  gm.weg(m.id, 'INTAKE');
  const c = l2Ronde(mm, gm, [m.id]);
  assert.equal(c.s.j.telling.ingetrokken, 1); assert.equal(c.s.j.telling.david_eraf, 1);
  assert.deepEqual(c.l.j.acties.map(function (x) { return [x.soort, x.erbij, x.eraf]; }), [['intrek', [], ['AI/MailMan']]]);
  assert.equal(route(mm, m.id).status, 'ingetrokken'); assert.ok(!gm.heeft(m.id, 'AI/MailMan'));
  assert.equal(lsRij(mm, m.id, 'AI/MailMan').weg_door, 'mailman');
  // weer erop → gepland → wachtrij, zelfde route
  gm.zet(m.id, 'INTAKE');
  const e = l2Ronde(mm, gm, [m.id]);
  assert.equal(e.s.j.telling.terug_gepland, 1);
  assert.deepEqual(e.l.j.acties.map(function (x) { return x.soort; }), ['route']);
  assert.equal(route(mm, m.id).status, 'wachtrij'); assert.equal(routes(mm), 1);
  assert.equal(correcties(mm).length, 1, 'terugzetten is geen nieuwe les');
});

test('B8 wachtrijlabel weg: met bewijs in Intake verwerkt (eind), zonder bewijs terug naar gepland, na 3 keer niet meer', () => {
  const { mm, dir, gm, intake } = b8Kamer();
  const m = mail(), n = mail();
  draai(mm, 'gmail:david', [m, n], { jev: function () { return jevAntwoord(JEV_INTAKE); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(m); gm.voeg(n);
  l2Ronde(mm, gm, [m.id, n.id]);
  assert.equal(route(mm, m.id).status, 'wachtrij'); assert.equal(route(mm, n.id).status, 'wachtrij');
  // Mail Processor: m verwerkt (in Intake), n niet; beide wachtrijlabels weg
  intake.add(m.id); gm.weg(m.id, 'AI/MailMan'); gm.weg(n.id, 'AI/MailMan');
  const a = l2Ronde(mm, gm, [m.id, n.id]);
  assert.equal(route(mm, m.id).status, 'verwerkt'); assert.equal(route(mm, n.id).pogingen, 1);
  assert.deepEqual(a.l.j.acties.map(function (x) { return x.gmail_id; }), [n.id], 'n opnieuw in de wachtrij');
  assert.equal(lsRij(mm, m.id, 'AI/MailMan').weg_door, 'elders', 'wachtrijlabel weg is geen correctie van David');
  for (let i = 0; i < 3; i++) { gm.weg(n.id, 'AI/MailMan'); l2Ronde(mm, gm, [n.id]); }
  assert.equal(route(mm, n.id).status, 'gepland'); assert.equal(route(mm, n.id).pogingen, 3);
  assert.ok(mm.zorgen().some(function (z) { return /komt niet in Intake/.test(z); }));
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).routes_24u, 2);
  // verwerkt is eind: INTAKE eraf verandert niets
  gm.weg(m.id, 'INTAKE');
  l2Ronde(mm, gm, [m.id]);
  assert.equal(route(mm, m.id).status, 'verwerkt');
});

test('B8 INTAKE + FACTUUR samen → beide ingangen; eigen actie ≠ David, ook nog niet teruggemeld (≤ 1 uur)', () => {
  const { mm, dir, gm } = b8Kamer();
  const m = mail({ bijlagen: [{ naam: 'n.pdf', mime: 'application/pdf' }] }), p = mail();
  draai(mm, 'gmail:david', [m, p], { jev: function () { return jevAntwoord(JEV_INTAKE); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(m); gm.voeg(p);
  l2Ronde(mm, gm, [m.id]);
  gm.zet(m.id, 'FACTUUR');
  const a = l2Ronde(mm, gm, [m.id]);
  assert.ok(gm.heeft(m.id, 'INTAKE') && gm.heeft(m.id, 'FACTUUR'));
  assert.equal(route(mm, m.id).status, 'wachtrij', 'Intake via de route');
  assert.equal(lsRij(mm, m.id, 'FACTUUR').bron, 'david', 'Facturen-koerier zoekt op het label zelf');
  assert.equal(a.s.j.telling.correcties, 1);
  // n8n zette de labels wel, maar de terugmelding kwam niet aan: binnen het uur telt het als eigen, niet als David
  const r1 = l2Ronde(mm, gm, [p.id], { nietZetten: true });
  gm.pas(r1.l.j.acties);
  const b = l2Ronde(mm, gm, [p.id]);
  assert.equal(b.s.j.telling.david_erbij, 0); assert.equal(lsRij(mm, p.id, 'INTAKE').bron, 'mailman');
  assert.equal(route(mm, p.id).status, 'gepland', 'route uit de lijst; wachtrijlabel gemeld als al aanwezig');
});

test('B8 afgekapte lijst of verkeerd label-ID verandert niets voor dat label', () => {
  const { mm, dir, gm } = b8Kamer();
  const m = mail();
  draai(mm, 'gmail:david', [m], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(m);
  l2Ronde(mm, gm, [m.id]);
  gm.zet(m.id, 'INTAKE'); gm.weg(m.id, 'OVERIG');
  const a = l2Ronde(mm, gm, [m.id], { afgekapt: 'INTAKE', ander: { OVERIG: 'Label_99' } });
  assert.equal(a.s.j.telling.afgekapt, 1); assert.equal(a.s.j.telling.onbekend, 1);
  assert.equal(routes(mm), 0); assert.equal(lsRij(mm, m.id, 'INTAKE'), undefined);
  assert.equal(lsRij(mm, m.id, 'OVERIG').weg, null, 'OVERIG-lijst met ander ID: niet weg');
  assert.deepEqual(correcties(mm), []);
  const b = l2Ronde(mm, gm, [m.id]);
  assert.equal(b.s.j.telling.routes_nieuw, 1); assert.equal(lsRij(mm, m.id, 'OVERIG').weg_door, 'david');
  // MailMan zet nooit terug wat David weghaalde
  assert.ok(!b.l.j.acties.some(function (x) { return x.erbij.includes('OVERIG'); }));
});

test('B8 Twijfel-keuze in de Werkstroom → label erbij (wv2196: geen TWIJFEL meer om weg te halen); terug kan alleen zolang het label nog niet staat', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail(), mail()];
  draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord({ mens: 0.5, waarde: 1.5, actie: 0.1 }); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  assert.ok(ms.every(function (m) { return gm.ber.get(m.id).labels.size === 0; }), 'wv2196: Twijfel zonder label in Gmail');
  const kies = function (m, juist) { return mm.app('POST /app/mailman/oordeel', { id: rij(mm, m.id).id, juist }); };
  assert.equal(kies(ms[0], 'intake').status, 200);
  assert.equal(kies(ms[1], 'info').status, 200);
  assert.equal(kies(ms[2], 'factuur').status, 200);
  assert.equal(kies(ms[2], null).status, 200, 'terug mag nog: label staat nog niet');
  const a = l2Ronde(mm, gm, ids);
  const per = perId(a.l.j.acties);
  assert.deepEqual([per[ms[0].id].soort, per[ms[0].id].erbij, per[ms[0].id].eraf], ['keuze', ['INTAKE', 'AI/MailMan'], []]);
  assert.deepEqual([per[ms[1].id].erbij, per[ms[1].id].eraf], [['OVERIG'], []]);
  assert.equal(per[ms[2].id], undefined);
  assert.equal(route(mm, ms[0].id).status, 'wachtrij'); assert.equal(lsRij(mm, ms[0].id, 'INTAKE').bron, 'keuze');
  assert.ok(!gm.heeft(ms[0].id, 'TWIJFEL'));
  const terug = kies(ms[0], null);
  assert.equal(terug.status, 409); assert.match(terug.j.fout, /haal het label zelf weg in Gmail/);
  assert.equal(kies(ms[0], 'factuur').status, 409);
  assert.deepEqual(l2Ronde(mm, gm, ids).l.j.acties, [], 'keuze één keer');
  assert.deepEqual(correcties(mm), [], 'Werkstroom-keuze is geen Gmail-correctie');
});

test('B8 vangnet: Twijfel zonder keuze krijgt na 3 dagen INTAKE erbij (wv2196: gerekend vanaf het labelmoment, zonder TWIJFEL-label), één keer; niet als David al koos', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail()];
  draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord({ mens: 0.5, waarde: 1.5, actie: 0.1 }); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  gm.zet(ms[1].id, 'FACTUUR');   // David koos in Gmail
  const t0 = klok;
  try {
    klok += 2 * 86400000;
    assert.ok(!l2Ronde(mm, gm, ids).l.j.acties.some(function (x) { return x.soort === 'vangnet'; }), 'na 2 dagen nog niet');
    klok = t0 + 3 * 86400000 + 60000;
    const a = l2Ronde(mm, gm, ids);
    const v = a.l.j.acties.filter(function (x) { return x.soort === 'vangnet'; });
    assert.deepEqual(v.map(function (x) { return [x.gmail_id, x.erbij]; }), [[ms[0].id, ['INTAKE', 'AI/MailMan']]]);
    assert.ok(!gm.heeft(ms[0].id, 'TWIJFEL'), 'wv2196: nooit TWIJFEL');
    assert.equal(route(mm, ms[0].id).bron, 'vangnet');
    assert.ok(!l2Ronde(mm, gm, ids).l.j.acties.some(function (x) { return x.soort === 'vangnet'; }), 'één keer');
  } finally { klok = t0; }
});

test('B8 ACTIE_DS (en TODO): nooit gelezen, nooit archief; gelezen nooit bij TWIJFEL', () => {
  const verwerkt = new Map();
  const intake = new Set();
  const { mm, dir } = nieuweKamer({ factuurVerwerkt: function (ids) { const m = new Map(); for (const i of ids) if (verwerkt.has(i)) m.set(i, verwerkt.get(i)); return m; }, intakeBerichten: function () { return intake; } });
  const gm = nepGmail();
  toestaan(dir, ['gmail:david']); zetLive(mm); uitgangToestaan(dir, ['gmail:david']); l2Toestaan(dir);
  vinkje(mm, 'intake', 'gelezen'); vinkje(mm, 'factuur', 'gelezen'); vinkje(mm, 'factuur', 'archief'); vinkje(mm, 'twijfel', 'gelezen');
  const pdf = [{ naam: 'f.pdf', mime: 'application/pdf' }];
  const ms = [mail(), mail(), mail({ aan: ALIAS, bijlagen: pdf }), mail({ aan: ALIAS, bijlagen: pdf }), mail()];
  const jev = [{ mens: 0.95, actie: 0.95, waarde: 3 }, JEV_INTAKE, { mens: 0.9, actie: 0.9, waarde: 3 }, JEV_INFO, { mens: 0.5, waarde: 1.5, actie: 0.1 }];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(jev[ms.findIndex(function (m) { return m.id === a.gmail_id; })]); } });
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  const a = perId(l2Ronde(mm, gm, ids).l.j.acties);
  assert.deepEqual(a[ms[0].id].eraf, [], 'ACTIE_DS: nooit gelezen');
  assert.ok(a[ms[0].id].erbij.includes('ACTIE_DS'));
  assert.deepEqual(a[ms[1].id].eraf, ['UNREAD'], 'gewone Intake-mail: gelezen');
  assert.deepEqual(a[ms[2].id].erbij, ['FACTUUR', 'ACTIE_DS']); assert.deepEqual(a[ms[2].id].eraf, []);
  assert.deepEqual(a[ms[3].id].eraf, ['UNREAD']);
  assert.equal(a[ms[4].id], undefined, 'Twijfel: geen label en nooit gelezen (wv2196)');
  verwerkt.set(ms[2].id, 1); verwerkt.set(ms[3].id, 1);
  const b = l2Ronde(mm, gm, ids).l.j.acties.filter(function (x) { return x.archief; });
  assert.deepEqual(b.map(function (x) { return x.gmail_id; }), [ms[3].id], 'archief niet bij ACTIE_DS');
  assert.deepEqual([b[0].erbij, b[0].eraf, b[0].soort], [['FACTUUR/verwerkt'], ['INBOX'], 'archief']);
  assert.ok(rij(mm, ms[3].id).archief_tijd);
});

test('B8 overstap: AI/MailMan → INTAKE, TODO met mens → ACTIE_DS (TODO eraf), open Twijfel → TWIJFEL; ≤ 40 per ronde, één keer, geen correctie', () => {
  const { mm, dir, gm, intake } = b8Kamer();
  const ms = [mail(), mail(), mail(), mail()];
  const jev = [JEV_INTAKE, { mens: 0.95, actie: 0.95, waarde: 3 }, JEV_INFO, { mens: 0.5, waarde: 1.5, actie: 0.1 }];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(jev[ms.findIndex(function (m) { return m.id === a.gmail_id; })]); } });
  toestaan(dir, ['gmail:david']); zetLive(mm);
  mm.app('POST /app/mailman/jev', { postvak: 'gmail:david', actie: 'drempels', drempel_in: 0.55, drempel_uit: 0.3, twijfel_naar: 'info' });   // Twijfel kreeg in 1.8 INFO
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  // 1.8: labels zetten zoals nu
  const een = l2Ronde(mm, gm, ids);
  assert.deepEqual(perId(een.l.j.acties)[ms[1].id].erbij, ['AI/MailMan', 'TODO']);
  intake.add(ms[0].id); gm.weg(ms[0].id, 'AI/MailMan');   // Mail Processor verwerkte ms[0]
  l2Toestaan(dir);
  // het label INFO heet nu OVERIG (zelfde ID): de nep-Gmail hernoemt mee
  for (const x of gm.ber.values()) if (x.labels.delete('INFO')) x.labels.add('OVERIG');
  const a = l2Ronde(mm, gm, ids);
  assert.equal(a.s.j.telling.david_erbij, 0, 'wat MailMan in 1.8 zette telt niet als David');
  const per = perId(a.l.j.acties);
  assert.deepEqual([per[ms[0].id].soort, per[ms[0].id].erbij], ['overstap', ['INTAKE']]);
  assert.deepEqual([per[ms[1].id].erbij, per[ms[1].id].eraf], [['INTAKE', 'ACTIE_DS'], ['TODO']]);
  assert.equal(per[ms[2].id], undefined, 'OVERIG (was INFO) blijft');
  assert.equal(per[ms[3].id], undefined, 'wv2196: open Twijfel krijgt bij de overstap geen TWIJFEL meer');
  assert.equal(route(mm, ms[0].id).status, 'verwerkt', 'stond al in Intake');
  assert.equal(route(mm, ms[1].id).status, 'wachtrij', 'wachtrijlabel stond er nog');
  assert.ok(!gm.heeft(ms[1].id, 'TODO') && gm.heeft(ms[1].id, 'ACTIE_DS'));
  const b = l2Ronde(mm, gm, ids);
  assert.deepEqual(b.l.j.acties, []); assert.equal(b.s.j.telling.david_erbij, 0);
  assert.deepEqual(correcties(mm), [], 'overstap telt niet als correctie');
  assert.ok(mm._db.prepare("SELECT overstap_klaar FROM postvak WHERE id = 'gmail:david'").get().overstap_klaar);
});

test('B8 draad: Davids label op een gesprek routeert het nieuwste binnengekomen bericht + ≤ 3 oudere met pdf/docx; nooit zijn eigen verzonden bericht', () => {
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const docx = { naam: 'b.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, pdf = { naam: 'a.pdf', mime: 'application/pdf' };
  const ms = [mail({ threadId: th, datum: klok - 9 * 3600000, bijlagen: [pdf] }), mail({ threadId: th, datum: klok - 8 * 3600000 }), mail({ threadId: th, datum: klok - 7 * 3600000, bijlagen: [docx] }),
    mail({ threadId: th, datum: klok - 6 * 3600000, bijlagen: [pdf] }), mail({ threadId: th, datum: klok - 5 * 3600000, bijlagen: [pdf] }), mail({ threadId: th, datum: klok - 4 * 3600000 })];
  const eigen = mail({ threadId: th, datum: klok - 3 * 3600000, van: 'Ik <ik@eigen.invalid>', labels: ['SENT'] });
  draai(mm, 'gmail:david', ms.concat([eigen]), { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); }); gm.voeg(eigen, true);
  const ids = ms.concat([eigen]).map(function (m) { return m.id; });
  for (let i = 0; i < 8 && l2Ronde(mm, gm, ids).l.j.acties.length; i++);   // wv2196: één draadactie per draad per ronde
  assert.ok(ms.every(function (m) { return gm.heeft(m.id, 'OVERIG'); }), 'wv2196: OVERIG op elk binnengekomen bericht van de draad');
  assert.equal(gm.ber.get(eigen.id).labels.size, 0, 'wv2196: nooit op het eigen verzonden bericht');
  gm.draadLabel(th, 'INTAKE');
  const a = l2Ronde(mm, gm, ids);
  const r = mm._db.prepare('SELECT gmail_id FROM route ORDER BY id').all().map(function (x) { return x.gmail_id; }).sort();
  assert.deepEqual(r, [ms[5].id, ms[4].id, ms[3].id, ms[2].id].sort(), 'nieuwste + drie oudere met bijlage; de oudste pdf valt af');
  assert.equal(route(mm, eigen.id), undefined, 'eigen verzonden bericht nooit');
  assert.equal(a.s.j.telling.routes_nieuw, 4);
  assert.equal(correcties(mm).length, 6, 'elk bericht met INTAKE is een les');
  // later bericht in dezelfde draad krijgt INTAKE (Gmail zet het label op het gesprek): alleen dat nieuwe bericht
  const n = mail({ threadId: th, datum: klok - 600000 });
  draai(mm, 'gmail:david', [n], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(n); gm.zet(n.id, 'INTAKE');
  l2Ronde(mm, gm, ids.concat([n.id]));
  assert.equal(routes(mm), 5); assert.ok(route(mm, n.id)); assert.equal(route(mm, ms[1].id), undefined);
});

test('B8 regelvoorstel bij ≥ 2 dezelfde correcties per domein; regel met labels via de App; doktersmaten nooit', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail({ van: 'A <a@club.invalid>' }), mail({ van: 'B <b@club.invalid>' }), mail({ van: 'C <c@ander.invalid>' })];
  draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  ms.forEach(function (m) { gm.zet(m.id, 'NIEUWSBRIEF'); });
  l2Ronde(mm, gm, ids);
  const pv = mm.app('GET /app/mailman', {}).j.postvakken.find(function (p) { return p.id === 'gmail:david'; });
  assert.equal(pv.regelvoorstellen.length, 1);
  assert.equal(pv.regelvoorstellen[0].domein, 'club.invalid'); assert.equal(pv.regelvoorstellen[0].aantal, 2);
  assert.deepEqual(pv.regelvoorstellen[0].regel.labels, ['NIEUWSBRIEF']); assert.equal(pv.regelvoorstellen[0].regel.stap, 'weg');
  assert.equal(pv.correcties.length, 3); assert.equal(pv.labelset2.live, true);
  assert.ok(pv.logboek[0].in_gmail.some(function (x) { return x.label === 'NIEUWSBRIEF' && x.bron === 'david'; }));
  assert.ok(Array.isArray(pv.logboek[0].labels2));
  // regel met labels; ongeldige labels geweigerd; een oudere App (zonder veld) laat de labels staan
  const nr = mm.app('POST /app/mailman/regel', Object.assign({ actie: 'nieuw' }, pv.regelvoorstellen[0].regel));
  assert.equal(nr.status, 200, JSON.stringify(nr.j));
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'nieuw', postvak: 'gmail:david', stap: 'weg', voorwaarden: { van_domein: { op: 'is', w: 'x.invalid' } }, labels: ['INTAKE'] }).status, 400);
  assert.equal(mm.app('POST /app/mailman/regel', { actie: 'wijzig', id: nr.j.id, postvak: 'gmail:david', stap: 'weg', naam: 'n', voorwaarden: { van_domein: { op: 'is', w: 'club.invalid' } } }).status, 200);
  assert.deepEqual(mm.app('GET /app/mailman', {}).j.postvakken.find(function (p) { return p.id === 'gmail:david'; }).regels.find(function (r) { return r.id === nr.j.id; }).labels, ['NIEUWSBRIEF']);
  const m4 = mail({ van: 'D <d@club.invalid>' });
  draai(mm, 'gmail:david', [m4], { jev: function () { return jevAntwoord(JEV_INFO); } }); gm.voeg(m4);
  assert.deepEqual(perId(l2Ronde(mm, gm, [m4.id]).l.j.acties)[m4.id].erbij, ['NIEUWSBRIEF'], 'regel: Overig + NIEUWSBRIEF = alleen NIEUWSBRIEF');
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).correcties_24u, 3);
  // doktersmaten: labelset2 in config telt nooit
  toestaan(dir, ['gmail:david', 'gmail:groenhouten']);
  mm._db.prepare("UPDATE postvak SET stand = 'live' WHERE id = 'gmail:groenhouten'").run();
  const rg = ronde(mm, 'gmail:groenhouten');
  assert.deepEqual(mm.n8n('POST /mailman/labelstaat', { ronde: rg.ronde, postvak: 'gmail:groenhouten', labels: gm.lijsten() }).j, { ok: true, actief: false });
  assert.equal(mm.app('GET /app/mailman', {}).j.postvakken.find(function (p) { return p.id === 'gmail:groenhouten'; }).labelset2.actief, false);
});

test('B8 labelset2 weg (terugrol): labels() valt meteen terug op 1.8; een ronde die nog aanbod had meldt via gezet2 terug', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail()];
  draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [ms[0].id], volledig: true });
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids: [ms[0].id] });
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); delete c.labelset2; fs.writeFileSync(f, JSON.stringify(c));
  const g = mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: gm.pas(l.j.acties) });
  assert.equal(g.j.labelset, 2); assert.equal(g.j.telling.ok, 1);
  assert.deepEqual(JSON.parse(rij(mm, ms[0].id).labels_gezet), ['OVERIG']);
  const x = l2Ronde(mm, gm, [ms[1].id]);
  assert.deepEqual(x.l.j.acties.map(function (a) { return a.erbij; }), [['INFO']]);
});

test('B8 review: oude Twijfel van vóór live krijgt bij de overstap geen label (MOET 1); verzonden mail in een lijst nooit gerouteerd (MOET 2)', () => {
  const { mm, dir, gm } = b8Kamer();
  const oud = mail({ datum: klok - 4 * 86400000 });
  draai(mm, 'gmail:david', [oud], { jev: function () { return jevAntwoord({ mens: 0.5, waarde: 1.5, actie: 0.1 }); } });
  assert.equal(rij(mm, oud.id).stroom, 'twijfel');
  const th = hexId(), m = mail({ threadId: th }), eigen = mail({ threadId: th, datum: klok - 600000, labels: ['SENT'], van: 'Ik <ik@eigen.invalid>' });
  draai(mm, 'gmail:david', [m, eigen], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(oud); gm.voeg(m); gm.voeg(eigen, true);
  const ids = [oud.id, m.id, eigen.id];
  const a = l2Ronde(mm, gm, ids);
  assert.ok(!a.l.j.acties.some(function (x) { return x.gmail_id === oud.id; }), 'mail van vóór live − 24 u: geen labels');
  gm.draadLabel(th, 'INTAKE');
  const b = l2Ronde(mm, gm, ids, { metVerzonden: true });   // n8n liet -in:sent vallen: de pod houdt het zelf tegen
  assert.equal(b.s.j.telling.verzonden, 1);
  assert.equal(route(mm, eigen.id), undefined); assert.ok(route(mm, m.id));
  assert.equal(lsRij(mm, eigen.id, 'INTAKE'), undefined);
});

test('B8 review: INTAKE in Gmail op Twijfel = Davids keuze (Werkstroom dicht); na het vangnet kan "Info" niet meer; steekproef op gewone mail blijft vrij', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail(), mail()];
  const jev = [{ mens: 0.5, waarde: 1.5, actie: 0.1 }, { mens: 0.5, waarde: 1.5, actie: 0.1 }, JEV_INTAKE];
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(jev[ms.findIndex(function (m) { return m.id === a.gmail_id; })]); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  gm.zet(ms[0].id, 'INTAKE');
  const a = l2Ronde(mm, gm, ids);
  assert.equal(a.s.j.telling.keuze_gmail, 1); assert.equal(rij(mm, ms[0].id).juist, 'intake');
  const k0 = perId(a.l.j.acties)[ms[0].id];
  assert.deepEqual([k0.soort, k0.erbij, k0.eraf], ['route', ['AI/MailMan'], []], 'wv2196: INTAKE staat al (Davids label → route), geen TWIJFEL om weg te halen');
  assert.ok(!gm.heeft(ms[0].id, 'TWIJFEL'));
  assert.equal(mm.werkstroomTel().find(function (p) { return p.id === 'gmail:david'; }).twijfel_open, 1);
  // vangnet op ms[1], daarna "Info" in de Werkstroom → 409 met uitleg
  const t0 = klok;
  try {
    klok += 3 * 86400000 + 60000;
    l2Ronde(mm, gm, ids);
    assert.ok(gm.heeft(ms[1].id, 'INTAKE'));
    const r = mm.app('POST /app/mailman/oordeel', { id: rij(mm, ms[1].id).id, juist: 'info' });
    assert.equal(r.status, 409); assert.match(r.j.fout, /INTAKE staat al in Gmail/);
    assert.equal(mm.app('POST /app/mailman/oordeel', { id: rij(mm, ms[1].id).id, juist: 'factuur' }).status, 200, 'FACTUUR erbij mag wel');
  } finally { klok = t0; }
  // steekproef op een gewone Intake-mail: heen en terug zonder 409
  assert.equal(mm.app('POST /app/mailman/oordeel', { id: rij(mm, ms[2].id).id, juist: 'info' }).status, 200);
  assert.equal(mm.app('POST /app/mailman/oordeel', { id: rij(mm, ms[2].id).id, juist: null }).status, 200);
});

test('B8 review: keuze Intake op mail die al in Intake staat krijgt geen wachtrijlabel (ZOU 6); lege "volledige" lijst = verdacht (ZOU 7); mislukte actie hooguit 5 keer (KAN 9)', () => {
  const { mm, dir, gm, intake } = b8Kamer();
  const ms = Array.from({ length: 14 }, function () { return mail(); }), tw = [mail(), mail()];
  draai(mm, 'gmail:david', ms.concat(tw), { jev: function (a) { return jevAntwoord(tw.some(function (m) { return m.id === a.gmail_id; }) ? { mens: 0.5, waarde: 1.5, actie: 0.1 } : JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.concat(tw).forEach(function (m) { gm.voeg(m); });
  const ids = ms.concat(tw).map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  l2Ronde(mm, gm, ids);   // 14 × OVERIG (wv2196: Twijfel krijgt geen label meer)
  assert.ok(ms.every(function (m) { return gm.heeft(m.id, 'OVERIG'); }));
  intake.add(tw[0].id);
  mm.app('POST /app/mailman/oordeel', { id: rij(mm, tw[0].id).id, juist: 'intake' });
  const a = perId(l2Ronde(mm, gm, ids).l.j.acties)[tw[0].id];
  assert.deepEqual([a.erbij, a.eraf], [['INTAKE'], []]);
  assert.equal(route(mm, tw[0].id).status, 'verwerkt');
  // een lege maar "volledige" OVERIG-lijst (14 bekend) verandert niets; de normale lijst daarna ook niet
  const v = l2Ronde(mm, gm, ids, { leeg: true });
  assert.ok(v.s.j.telling.verdacht >= 1);
  assert.ok(ms.every(function (m) { return lsRij(mm, m.id, 'OVERIG').weg == null; }), 'OVERIG-lijst als afgekapt behandeld');
  assert.equal(lsRij(mm, tw[0].id, 'INTAKE').weg_door, 'david', 'één label kwijt is niet verdacht (grens > 10 én > de helft)');
  const w = l2Ronde(mm, gm, ids);
  assert.equal(w.s.j.telling.david_erbij, 0, 'een label dat terugkomt houdt zijn oude bron'); assert.equal(lsRij(mm, tw[0].id, 'INTAKE').bron, 'keuze');
  assert.equal(lsRij(mm, ms[1].id, 'OVERIG').bron, 'mailman');
  // Gmail weigert steeds: de keuze wordt hooguit 5 keer aangeboden
  mm.app('POST /app/mailman/oordeel', { id: rij(mm, tw[1].id).id, juist: 'factuur' });
  gm.fout = true;
  let n = 0;
  for (let i = 0; i < 8; i++) n += l2Ronde(mm, gm, ids).l.j.acties.filter(function (x) { return x.gmail_id === tw[1].id; }).length;
  assert.equal(n, 5);
});

// ── wv2196: TWIJFEL alleen intern (opruimen), labels op de hele draad ──
function twijfelMetLabel(mm, gm, m) {   // zoals vóór wv2196: MailMan zette TWIJFEL (label_staat bron mailman)
  gm.zet(m.id, 'TWIJFEL');
  mm._db.prepare("INSERT INTO label_staat (postvak, gmail_id, thread_id, label, bron, gezet, gezien) VALUES ('gmail:david', ?, ?, 'TWIJFEL', 'mailman', ?, ?)").run(m.id, m.threadId, new Date(klok).toISOString(), new Date(klok).toISOString());
}
test('wv2196 TWIJFEL: nooit in Gmail; MailMans oude TWIJFEL gaat eraf (op de draad), Davids eigen blijft; overgeslagen opruim niet eindeloos', () => {
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const ms = [mail(), mail(), mail({ threadId: th }), mail()];
  const zus = mail({ threadId: th, datum: klok - 7200000 }), zus2 = mail({ threadId: th, datum: klok - 8000000 });
  draai(mm, 'gmail:david', ms.concat([zus, zus2]), { jev: function () { return jevAntwoord({ mens: 0.5, waarde: 1.5, actie: 0.1 }); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.concat([zus, zus2]).forEach(function (m) { gm.voeg(m); });
  const ids = ms.concat([zus, zus2]).map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids);
  assert.ok(ids.every(function (id) { return !gm.heeft(id, 'TWIJFEL'); }), 'nieuw: nooit TWIJFEL');
  gm.zet(zus2.id, 'TWIJFEL'); l2Ronde(mm, gm, ids);   // zelfde draad, David zette het zelf (labelstaat: bron david)
  assert.equal(lsRij(mm, zus2.id, 'TWIJFEL').bron, 'david');
  twijfelMetLabel(mm, gm, ms[0]); twijfelMetLabel(mm, gm, ms[1]); twijfelMetLabel(mm, gm, ms[2]);
  twijfelMetLabel(mm, gm, zus);                   // zelfde draad, ook van MailMan
  gm.zet(ms[3].id, 'TWIJFEL');                    // David zette TWIJFEL zelf
  gm.weg(ms[1].id, 'TWIJFEL');                    // al weg in Gmail (MailMan weet het nog niet)
  const a = l2Ronde(mm, gm, ids, { afgekapt: 'TWIJFEL' });   // labelstaat weet nog niet dat ms[1] al weg is
  const op = a.l.j.acties.filter(function (x) { return x.soort === 'opruim'; });
  assert.deepEqual(op.map(function (x) { return x.gmail_id; }).sort(), [ms[0].id, ms[1].id, ms[2].id].sort());
  assert.ok(op.every(function (x) { return x.erbij.length === 0 && x.eraf.length === 1 && x.eraf[0] === 'TWIJFEL'; }));
  assert.ok(!gm.heeft(ms[0].id, 'TWIJFEL') && !gm.heeft(ms[2].id, 'TWIJFEL'));
  assert.ok(!gm.heeft(zus.id, 'TWIJFEL'), 'ook op het andere bericht van de draad');
  assert.ok(gm.heeft(zus2.id, 'TWIJFEL'), 'review MOET 1: Davids eigen TWIJFEL op een ander bericht van de draad blijft');
  assert.ok(gm.heeft(ms[3].id, 'TWIJFEL'), 'Davids eigen TWIJFEL blijft');
  assert.equal(lsRij(mm, ms[1].id, 'TWIJFEL').weg_door, 'elders', 'overgeslagen: niet opnieuw');
  const b = l2Ronde(mm, gm, ids);
  assert.ok(!b.l.j.acties.some(function (x) { return x.soort === 'opruim'; }), 'één keer');
  assert.equal(b.s.j.telling.david_eraf, 0, 'MailMans eigen opruim is geen correctie van David');
  assert.equal(Array.from(gm.ber.values()).filter(function (x) { return x.labels.has('TWIJFEL'); }).length, 2, 'alleen Davids eigen TWIJFEL staat nog (2×)');
  // Twijfel blijft intern: de lijst in de App houdt ze
  assert.ok(mm.werkstroomTel().find(function (p) { return p.id === 'gmail:david'; }).twijfel_open >= 4);
});

test('wv2196 draad: zichtbare labels op alle binnengekomen berichten van de draad, nooit verzonden; wachtrij, gelezen en FACTUUR alleen op het bericht; geen route of correctie voor de andere berichten', () => {
  const verwerkt = new Map();
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const oud = mail({ threadId: th, datum: klok - 9 * 3600000 }), eigen = mail({ threadId: th, datum: klok - 8 * 3600000, van: 'Ik <ik@eigen.invalid>', labels: ['SENT'] });
  draai(mm, 'gmail:david', [oud], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(oud); gm.voeg(eigen, true);
  l2Ronde(mm, gm, [oud.id, eigen.id]);
  assert.ok(gm.heeft(oud.id, 'OVERIG'));
  // nieuw antwoord in de draad: mens met vraag → INTAKE + ACTIE_DS + wachtrij
  const nieuw = mail({ threadId: th, datum: klok - 600000 });
  draai(mm, 'gmail:david', [nieuw], { jev: function () { return jevAntwoord({ mens: 0.95, actie: 0.95, waarde: 3 }); } });
  gm.voeg(nieuw);
  const ids = [oud.id, eigen.id, nieuw.id];
  const a = l2Ronde(mm, gm, ids);
  const x = perId(a.l.j.acties)[nieuw.id];
  assert.equal(x.draad, true); assert.equal(x.thread_id, th); assert.deepEqual(x.draad_niet, []);
  assert.deepEqual(x.erbij, ['INTAKE', 'ACTIE_DS', 'AI/MailMan']);
  assert.ok(gm.heeft(oud.id, 'INTAKE') && gm.heeft(oud.id, 'ACTIE_DS'), 'het oudere bericht krijgt de zichtbare labels');
  assert.ok(!gm.heeft(oud.id, 'AI/MailMan'), 'het wachtrijlabel alleen op het nieuwe bericht');
  assert.equal(gm.ber.get(eigen.id).labels.size, 0, 'nooit op verzonden mail');
  assert.equal(lsRij(mm, oud.id, 'INTAKE').bron, 'mailman'); assert.equal(lsRij(mm, oud.id, 'INTAKE').keus, 'draad');
  assert.equal(route(mm, oud.id), undefined, 'het oudere bericht gaat niet zelf naar Intake');
  assert.equal(route(mm, nieuw.id).status, 'wachtrij');
  assert.equal(a.g.j.telling.draad, 1);
  const b = l2Ronde(mm, gm, ids);
  assert.equal(b.s.j.telling.david_erbij, 0, 'labels van de draad tellen niet als David'); assert.deepEqual(correcties(mm), []);
  assert.equal(route(mm, oud.id), undefined);
  // David haalt INTAKE weg op het hele gesprek; een volgend bericht met INTAKE zet het niet terug op de oudere berichten
  gm.weg(oud.id, 'INTAKE'); gm.weg(nieuw.id, 'INTAKE');
  l2Ronde(mm, gm, ids);
  assert.equal(lsRij(mm, nieuw.id, 'INTAKE').weg_door, 'david');
  const derde = mail({ threadId: th, datum: klok - 60000 });
  draai(mm, 'gmail:david', [derde], { jev: function () { return jevAntwoord(JEV_INTAKE); } });
  gm.voeg(derde);
  const c = perId(l2Ronde(mm, gm, ids.concat([derde.id])).l.j.acties)[derde.id];
  assert.ok(c.erbij.includes('INTAKE')); assert.ok(c.draad_niet.includes('INTAKE'));
  assert.ok(gm.heeft(derde.id, 'INTAKE') && !gm.heeft(oud.id, 'INTAKE') && !gm.heeft(nieuw.id, 'INTAKE'), 'wat David weghaalde komt niet terug op de draad');
  assert.ok(gm.heeft(derde.id, 'ACTIE_DS'), 'erf: de actievlag van de draad');
  // FACTUUR blijft per bericht (de Facturen-koerier zoekt per bericht)
  const fth = hexId(), f1 = mail({ threadId: fth, aan: ALIAS, bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] }), f0 = mail({ threadId: fth, datum: klok - 9 * 3600000 });
  draai(mm, 'gmail:david', [f0], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(f0); l2Ronde(mm, gm, [f0.id]);
  draai(mm, 'gmail:david', [f1], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(f1); l2Ronde(mm, gm, [f0.id, f1.id]);
  assert.ok(gm.heeft(f1.id, 'FACTUUR') && !gm.heeft(f0.id, 'FACTUUR'), 'FACTUUR nooit op het andere bericht');
  assert.ok(!gm.heeft(f1.id, 'OVERIG'), 'factuur erft geen OVERIG');
  void verwerkt;
});

test('wv2196 erf: een nieuw bericht krijgt de zichtbare labels van de draad (niet de wachtrij, niet TWIJFEL); OVERIG valt weg naast een geërfde categorie; telt niet als David', () => {
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const oud = mail({ threadId: th, datum: klok - 9 * 3600000, afmeld: true });
  draai(mm, 'gmail:david', [oud], { jev: function () { return jevAntwoord({ mens: 0.95, actie: 0.95, waarde: 0 }); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(oud);
  l2Ronde(mm, gm, [oud.id]);
  assert.ok(gm.heeft(oud.id, 'NIEUWSBRIEF') && gm.heeft(oud.id, 'ACTIE_DS') && !gm.heeft(oud.id, 'INTAKE'));
  gm.zet(oud.id, 'TWIJFEL');   // oud TWIJFEL (Davids eigen) erft nooit
  const n = mail({ threadId: th, datum: klok - 60000 });
  draai(mm, 'gmail:david', [n], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(n);
  const ids = [oud.id, n.id];
  const a = l2Ronde(mm, gm, ids);
  const x = perId(a.l.j.acties)[n.id];
  assert.equal(rij(mm, n.id).stroom, 'info'); assert.deepEqual(x.erbij, ['OVERIG']); assert.deepEqual(x.erf, ['NIEUWSBRIEF', 'ACTIE_DS']);
  assert.ok(gm.heeft(n.id, 'NIEUWSBRIEF') && gm.heeft(n.id, 'ACTIE_DS') && !gm.heeft(n.id, 'OVERIG'), 'OVERIG niet naast de geërfde categorie');
  assert.ok(!gm.heeft(n.id, 'AI/MailMan') && !gm.heeft(n.id, 'TWIJFEL'));
  assert.ok(!gm.heeft(oud.id, 'OVERIG'), 'OVERIG niet op een bericht met een categorie');
  assert.equal(lsRij(mm, n.id, 'NIEUWSBRIEF').bron, 'mailman'); assert.equal(route(mm, n.id), undefined);
  assert.equal(a.g.j.telling.erf, 2);
  assert.equal(rij(mm, n.id).labels_gezet, '[]', 'het besluit zelf zette niets (OVERIG viel weg)');
  const b = l2Ronde(mm, gm, ids);
  assert.equal(a.s.j.telling.david_erbij, 1, 'alleen Davids eigen TWIJFEL'); assert.equal(b.s.j.telling.david_erbij, 0, 'geërfde labels tellen niet als David'); assert.deepEqual(b.l.j.acties, []);
  assert.deepEqual(correcties(mm).map(function (c) { return c.naar; }), ['TWIJFEL']);
});

test('wv2196 draad: labelstaat herkent MailMans draadlabels ook zonder terugmelding; één draadactie per draad per ronde; draad_uit = per bericht', () => {
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const oud = mail({ threadId: th, datum: klok - 9 * 3600000 });
  draai(mm, 'gmail:david', [oud], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(oud); l2Ronde(mm, gm, [oud.id]);
  const n1 = mail({ threadId: th, datum: klok - 120000 }), n2 = mail({ threadId: th, datum: klok - 60000 });
  draai(mm, 'gmail:david', [n1, n2], { jev: function () { return jevAntwoord(JEV_INTAKE); } });
  gm.voeg(n1); gm.voeg(n2);
  const ids = [oud.id, n1.id, n2.id];
  // ronde zonder draad in de terugmelding (n8n-oud of verloren): de volgende labelstaat ziet INTAKE op oud via het draadaanbod
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids, volledig: true });
  mm.n8n('POST /mailman/labelstaat', { ronde: r.ronde, postvak: 'gmail:david', labels: gm.lijsten() });
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids });
  assert.equal(l.j.acties.filter(function (x) { return x.draad; }).length, 1, 'één draadactie per draad per ronde');
  const res = gm.pas(l.j.acties).map(function (y) { const z = Object.assign({}, y); delete z.draad; return z; });
  mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: res });
  assert.ok(gm.heeft(oud.id, 'INTAKE'));
  const b = l2Ronde(mm, gm, ids);
  assert.equal(b.s.j.telling.david_erbij, 0); assert.equal(lsRij(mm, oud.id, 'INTAKE').bron, 'mailman'); assert.equal(lsRij(mm, oud.id, 'INTAKE').keus, 'draad');
  assert.equal(route(mm, oud.id), undefined);
  assert.ok(gm.heeft(n2.id, 'INTAKE'), 'het tweede bericht een ronde later');
  // draad_uit: weer per bericht
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); c.draad_uit = { 'gmail:david': '2026-11-01' }; fs.writeFileSync(f, JSON.stringify(c));
  const n3 = mail({ threadId: th, datum: klok - 30000 });
  draai(mm, 'gmail:david', [n3], { jev: function () { return jevAntwoord({ mens: 0.95, actie: 0.95, waarde: 3 }); } });
  gm.voeg(n3);
  const x = perId(l2Ronde(mm, gm, ids.concat([n3.id])).l.j.acties)[n3.id];
  assert.equal(x.draad, undefined); assert.equal(x.thread_id, undefined);
  assert.ok(gm.heeft(n3.id, 'ACTIE_DS') && !gm.heeft(oud.id, 'ACTIE_DS'));
});

test('wv2196 afgedaan op de draad: vlag eraf op alle berichten als de hele draad uit de inbox is; staat er nog iets in de inbox, alleen het bericht zelf', () => {
  const { mm, dir, gm } = b8Kamer();
  const th = hexId(), th2 = hexId();
  const a0 = mail({ threadId: th, datum: klok - 9 * 3600000 }), a1 = mail({ threadId: th, datum: klok - 60000 });
  const b0 = mail({ threadId: th2, datum: klok - 9 * 3600000 }), b1 = mail({ threadId: th2, datum: klok - 60000 });
  const alle = [a0, a1, b0, b1];
  draai(mm, 'gmail:david', alle, { jev: function () { return jevAntwoord({ mens: 0.95, actie: 0.95, waarde: 3 }); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir); afgedaanToestaan(dir);
  alle.forEach(function (m) { gm.voeg(m); });
  const ids = alle.map(function (m) { return m.id; });
  for (let i = 0; i < 4; i++) l2Ronde(mm, gm, ids, { vlag: true });
  assert.ok(alle.every(function (m) { return gm.heeft(m.id, 'ACTIE_DS'); }));
  gm.plek(a0.id, 'archief'); gm.plek(a1.id, 'archief');   // David archiveert het hele gesprek
  gm.plek(b1.id, 'archief');                               // alleen het nieuwste bericht; b0 staat nog in de inbox
  for (let i = 0; i < 3; i++) l2Ronde(mm, gm, ids, { vlag: true });
  assert.ok(!gm.heeft(a0.id, 'ACTIE_DS') && !gm.heeft(a1.id, 'ACTIE_DS'), 'hele draad weg uit de inbox: vlag eraf');
  assert.ok(gm.heeft(b0.id, 'ACTIE_DS'), 'in de inbox: vlag blijft');
  assert.ok(!gm.heeft(b1.id, 'ACTIE_DS'), 'het gearchiveerde bericht zelf: eraf');
});

// ── wv2036 statuslabels: factuurstap FACTUUR → FACTUUR/In_SEPA → FACTUUR/Is_betaald (achter config.json statuslabels) ──
function stapToestaan(dir) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.statuslabels = { 'gmail:david': { ja: '2026-11-02T09:00:00Z' }, 'gmail:groenhouten': { ja: 'x' } };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function factuurLabels(gm, id) { return Array.from(gm.ber.get(id).labels).filter(function (l) { return l.indexOf('FACTUUR') === 0; }).sort(); }
function stapActies(x) { return x.l.j.acties.filter(function (a) { return a.soort === 'factuurstap'; }); }

test('wv2036 factuurstap: alleen met statuslabels; In_SEPA haalt FACTUUR en FACTUUR/verwerkt weg, Is_betaald ook In_SEPA; incasso meteen; idempotent; nooit terug', () => {
  const stap = new Map(), gevraagd = [];
  const { mm, dir } = nieuweKamer({ factuurStap: function (pv) { gevraagd.push(pv); return Array.from(stap, function (e) { return { gmail_id: e[0], stap: e[1] }; }).concat([{ gmail_id: 'geen-hex', stap: 'is_betaald' }, { gmail_id: hexId(), stap: 'onzin' }]); } });
  const gm = nepGmail();
  const f1 = mail(), f2 = mail(), f3 = mail();
  draai(mm, 'gmail:david', [f1, f2, f3], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  [f1, f2, f3].forEach(function (m) { gm.voeg(m); });
  gm.zet(f1.id, 'FACTUUR'); gm.zet(f1.id, 'FACTUUR/verwerkt'); gm.zet(f2.id, 'FACTUUR'); gm.zet(f3.id, 'FACTUUR');   // f1 al gearchiveerd (B6+)
  const ids = [f1.id, f2.id, f3.id];
  l2Ronde(mm, gm, ids);
  stap.set(f1.id, 'in_sepa'); stap.set(f2.id, 'is_betaald');   // f2: incasso gezien (of batch al afgeschreven) → meteen Is_betaald
  const zonder = l2Ronde(mm, gm, ids);
  assert.deepEqual(stapActies(zonder), [], 'zonder statuslabels niets');
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).factuurstap.aan, false);
  stapToestaan(dir);
  const x = l2Ronde(mm, gm, ids);
  const per = perId(stapActies(x));
  assert.deepEqual(Object.keys(per).sort(), [f1.id, f2.id].sort(), 'f3 heeft geen stap; ongeldige regels uit de Facturen-app vallen weg');
  assert.deepEqual([per[f1.id].erbij, per[f1.id].eraf], [['FACTUUR/In_SEPA'], ['FACTUUR', 'FACTUUR/verwerkt']]);
  assert.deepEqual([per[f2.id].erbij, per[f2.id].eraf], [['FACTUUR/Is_betaald'], ['FACTUUR', 'FACTUUR/verwerkt', 'FACTUUR/In_SEPA']]);
  assert.equal(x.l.j.telling.factuurstap, 2);
  assert.deepEqual(factuurLabels(gm, f1.id), ['FACTUUR/In_SEPA']);
  assert.deepEqual(factuurLabels(gm, f2.id), ['FACTUUR/Is_betaald']);
  assert.deepEqual(factuurLabels(gm, f3.id), ['FACTUUR']);
  assert.deepEqual(x.g.j.factuurstap, { gezet: 2, fout: 0, overgeslagen: 0 });
  assert.equal(lsRij(mm, f1.id, 'FACTUUR').weg_door, 'mailman', 'FACTUUR eraf is MailMans eigen actie');
  assert.ok(gevraagd.every(function (pv) { return pv === 'gmail:david'; }));
  // dubbele aanroep: geen tweede wijziging, en de labellijst daarna ziet geen 'David haalde FACTUUR weg'
  const y = l2Ronde(mm, gm, ids);
  assert.deepEqual(stapActies(y), []);
  assert.equal(y.s.j.telling.david_eraf, 0);
  // de bank ziet f1 → Is_betaald, In_SEPA eraf
  stap.set(f1.id, 'is_betaald');
  const z = l2Ronde(mm, gm, ids);
  assert.deepEqual(stapActies(z).map(function (a) { return [a.gmail_id, a.erbij, a.eraf]; }), [[f1.id, ['FACTUUR/Is_betaald'], ['FACTUUR', 'FACTUUR/verwerkt', 'FACTUUR/In_SEPA']]]);
  assert.deepEqual(factuurLabels(gm, f1.id), ['FACTUUR/Is_betaald']);
  // terug in de Facturen-app (ongedaan, teruggeboekt): het label gaat nooit terug
  stap.set(f1.id, 'in_sepa'); stap.set(f2.id, 'in_sepa');
  assert.deepEqual(stapActies(l2Ronde(mm, gm, ids)), []);
  const h = mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).factuurstap;
  assert.deepEqual(h, { aan: true, in_sepa: 0, is_betaald: 2, gezet_24u: 2, open: 0, opgegeven: 0, fout_24u: 0, overgeslagen_24u: 0 });
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:groenhouten'; }).factuurstap, undefined, 'doktersmaten nooit');
});

test('wv2036 factuurstap wacht op het archiveren (n8n archiveert alleen met FACTUUR erop); mislukt → terug, hooguit 5 keer, dan in /health en de box', () => {
  const stap = new Map(), verwerkt = new Map();
  const { mm, dir } = nieuweKamer({ factuurStap: function () { return Array.from(stap, function (e) { return { gmail_id: e[0], stap: e[1] }; }); },
    factuurVerwerkt: function (ids) { return new Map(ids.filter(function (i) { return verwerkt.has(i); }).map(function (i) { return [i, verwerkt.get(i)]; })); } });
  const gm = nepGmail();
  const f = mail({ aan: ALIAS, bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] }), g = mail();
  draai(mm, 'gmail:david', [f, g], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir); uitgangToestaan(dir, ['gmail:david']); vinkje(mm, 'factuur', 'archief'); stapToestaan(dir);
  gm.voeg(f); gm.voeg(g); gm.zet(g.id, 'FACTUUR');
  const ids = [f.id, g.id];
  l2Ronde(mm, gm, ids);
  assert.deepEqual(factuurLabels(gm, f.id), ['FACTUUR'], 'MailMan zette FACTUUR');
  verwerkt.set(f.id, 1); stap.set(f.id, 'in_sepa');
  const a = l2Ronde(mm, gm, ids);
  assert.deepEqual(a.l.j.acties.filter(function (x) { return x.gmail_id === f.id; }).map(function (x) { return x.soort; }), ['archief'], 'eerst archiveren, nog geen stap');
  assert.ok(rij(mm, f.id).archief_tijd);
  const b = l2Ronde(mm, gm, ids);
  assert.deepEqual(stapActies(b).map(function (x) { return [x.gmail_id, x.erbij]; }), [[f.id, ['FACTUUR/In_SEPA']]]);
  assert.deepEqual(factuurLabels(gm, f.id), ['FACTUUR/In_SEPA']);
  // Gmail weigert steeds: g wordt hooguit 5 keer aangeboden, daarna opgegeven (telling + één box-regel)
  stap.set(g.id, 'is_betaald');
  gm.fout = true;
  let n = 0;
  for (let i = 0; i < 8; i++) n += stapActies(l2Ronde(mm, gm, ids)).filter(function (x) { return x.gmail_id === g.id; }).length;
  assert.equal(n, K.STAP_POGINGEN);
  const h = mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).factuurstap;
  assert.deepEqual([h.opgegeven, h.open, h.in_sepa, h.fout_24u], [1, 0, 1, 5]);
  assert.ok(mm.zorgen().some(function (z) { return /1 factuurmail kreeg na 5 pogingen geen statuslabel/.test(z); }));
  assert.deepEqual(factuurLabels(gm, g.id), ['FACTUUR'], 'bleef staan');
  // na een dag één nieuwe poging (review ZOU 5); Gmail werkt weer → Is_betaald; geen tweede box-regel
  klok += 25 * 3600000;
  gm.fout = false;
  const c = l2Ronde(mm, gm, ids);
  assert.deepEqual(stapActies(c).map(function (x) { return x.gmail_id; }), [g.id]);
  assert.deepEqual(factuurLabels(gm, g.id), ['FACTUUR/Is_betaald']);
  assert.ok(!mm.zorgen().some(function (z) { return /statuslabel/.test(z); }));
  // overgeslagen bij de grens (prullenbak, verzonden, al verder) is geen labelfout en geen box-regel
  const h2 = mail(); gm.voeg(h2, true); stap.set(h2.id, 'in_sepa');
  let fouten = 0;
  for (let i = 0; i < 6; i++) fouten += l2Ronde(mm, gm, ids).g.j.telling.fout;
  assert.equal(fouten, 0);
  const h3 = mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).factuurstap;
  assert.deepEqual([h3.opgegeven, h3.overgeslagen_24u], [1, 5]);
  assert.ok(!mm.zorgen().some(function (z) { return /statuslabel/.test(z); }), 'overgeslagen geeft geen box-regel');
  klok -= 25 * 3600000;
});

// ── wv2189 (David 1-11-2026 12:02): factuur alleen betalen zonder actievlag; actievlag weg nadat David archiveert of weggooit ──
function afgedaanToestaan(dir) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.actielabel_weg = { 'gmail:david': { ja: '2026-11-02T09:30:00Z', door: 'proef' }, 'gmail:groenhouten': { ja: 'x' } };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function soortActies(x, s) { return x.l.j.acties.filter(function (a) { return a.soort === s; }); }
function afStand(mm) { return mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).afgedaan; }

test('wv2189 labelplan: factuur waarbij alleen betalen gevraagd wordt krijgt geen ACTIE_DS/TODO; factuur + vraag wel; niet gemeten = als vroeger; alleen bij factuur', () => {
  const inst = { todo_nooit: [] };
  const m = Object.assign({ van_domein: 'hotmail.invalid', onderwerp: 'factuur oktober', afmeld: false, tab: null });
  const ruw = function (anders) { const r = { factuur: 0.97, mens: 0.86, actie: 0.99, waarde: 2.16 }; if (anders !== undefined) r.actie_anders = anders; return r; };
  assert.equal(K.alleenBetalen(ruw(0.3)), true);
  assert.equal(K.alleenBetalen(ruw(0.8)), false, 'grens 0,8 = er wordt iets anders gevraagd');
  assert.equal(K.alleenBetalen(ruw()), false, 'niet gemeten');
  assert.equal(K.alleenBetalen(null), false);
  assert.deepEqual(K.labelPlan2('factuur', ruw(0.3), m, inst).labels, ['FACTUUR'], 'besluit 231: alleen betalen');
  assert.deepEqual(K.labelPlan2('factuur', ruw(0.95), m, inst).labels, ['FACTUUR', 'ACTIE_DS'], 'factuur + vraag');
  assert.deepEqual(K.labelPlan2('factuur', ruw(), m, inst).labels, ['FACTUUR', 'ACTIE_DS'], 'oud besluit zonder meting');
  assert.deepEqual(K.labelPlan2('intake', ruw(0.3), m, inst).labels, ['INTAKE', 'ACTIE_DS'], 'alleen bij FACTUUR');
  assert.deepEqual(K.labelPlan2('factuur', ruw(0.3), m, inst, ['ACTIE_DS']).labels, ['FACTUUR', 'ACTIE_DS'], 'Davids eigen regel blijft gelden');
  assert.deepEqual(K.labelPlan('factuur', ruw(0.3), Object.assign({}, m), { stromen: {} }), ['FACTUUR'], '1.8-plan: geen TODO');
  assert.deepEqual(K.labelPlan('factuur', ruw(0.95), Object.assign({}, m), { stromen: {} }), ['FACTUUR', 'TODO']);
  assert.ok(K.VLAG_LIJSTEN['TODO@uit'] && K.VLAG_LIJSTEN['ACTIE_DS@inbox']);
});

test('wv2189 Jev-vraag actie_anders: in de startset, één keer gezaaid in een bestaande databank, Davids uitgezette vraag blijft uit; gaat mee naar Jev', () => {
  const { mm, dir } = nieuweKamer();
  const q = function () { return mm._db.prepare("SELECT * FROM jev_vraag WHERE postvak = '*' AND sleutel = 'actie_anders'").all(); };
  assert.equal(q().length, 1);
  assert.equal(q()[0].rol, 'meten');
  // databank van vóór wv2189: vraag weg → bij het openen komt hij er (achteraan) bij
  mm._db.prepare("DELETE FROM jev_vraag WHERE sleutel = 'actie_anders'").run();
  const mm2 = MM.maak({ dir, nu: function () { return klok; }, marker: poort, eigenAdressen: function () { return []; }, intakeDraden: function () { return new Set(); }, primair: function () { return true; }, geheimOk: function () { return true; } });
  const r2 = mm2._db.prepare("SELECT * FROM jev_vraag WHERE postvak = '*' AND sleutel = 'actie_anders'").all();
  assert.equal(r2.length, 1);
  assert.equal(r2[0].volgorde, mm2._db.prepare("SELECT max(volgorde) v FROM jev_vraag WHERE postvak = '*'").get().v);
  mm2._db.prepare("UPDATE jev_vraag SET actief = 0 WHERE sleutel = 'actie_anders'").run();
  const mm3 = MM.maak({ dir, nu: function () { return klok; }, marker: poort, eigenAdressen: function () { return []; }, intakeDraden: function () { return new Set(); }, primair: function () { return true; }, geheimOk: function () { return true; } });
  assert.deepEqual(mm3._db.prepare("SELECT actief FROM jev_vraag WHERE sleutel = 'actie_anders'").all().map(function (x) { return x.actief; }), [0], 'uit blijft uit, geen tweede rij');
  const { mm: mm4 } = nieuweKamer();
  const m = mail({ aan: ALIAS, bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] });
  const x = draai(mm4, 'gmail:david', [m], { jev: function () { return jevAntwoord({}); } });
  assert.ok(x.s1.j.jev.length === 0 || Object.keys(x.s1.j.jev[0].body.input.questions).includes('actie_anders'));
});

test('wv2189 ronde: waarnemersfactuur (persoonlijk, alleen betalen) → alleen FACTUUR, wordt na verwerking gearchiveerd; factuur + vraag → ACTIE_DS en niet gearchiveerd', () => {
  const verwerkt = new Map();
  const k = nieuweKamer({ factuurVerwerkt: function (ids) { return new Map(ids.filter(function (i) { return verwerkt.has(i); }).map(function (i) { return [i, 1]; })); } });
  const { mm, dir } = k, gm = nepGmail();
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir); uitgangToestaan(dir, ['gmail:david']); vinkje(mm, 'factuur', 'archief');
  const pdf = [{ naam: 'Factuur.pdf', mime: 'application/pdf' }];
  const a = mail({ van: 'Piet <p.voorbeeld@hotmail.invalid>', bijlagen: pdf }), b = mail({ van: 'Jan <j.voorbeeld@hotmail.invalid>', bijlagen: pdf });
  const jev = { [a.id]: { factuur: 0.97, mens: 0.86, actie: 0.99, actie_anders: 0.3, waarde: 2 }, [b.id]: { factuur: 0.97, mens: 0.9, actie: 0.99, actie_anders: 0.95, waarde: 2 } };
  gm.voeg(a); gm.voeg(b);
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [a.id, b.id], volledig: true });
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:david', mails: [a, b], gevolgd: [] });
  mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: 'gmail:david', antwoorden: s1.j.jev.map(function (x) { return { gmail_id: x.gmail_id, antwoord: jevAntwoord(jev[x.gmail_id]) }; }) });
  mm.n8n('POST /mailman/labelstaat', { ronde: r.ronde, postvak: 'gmail:david', labels: gm.lijsten({ vlag: true }) });
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids: [a.id, b.id] });
  mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: gm.pas(l.j.acties) });
  mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: 'gmail:david' });
  assert.deepEqual(JSON.parse(rij(mm, a.id).labels_plan), ['FACTUUR'], 'geen TODO in het plan');
  assert.deepEqual(Array.from(gm.ber.get(a.id).labels).sort(), ['FACTUUR']);
  assert.deepEqual(Array.from(gm.ber.get(b.id).labels).sort(), ['ACTIE_DS', 'FACTUUR']);
  verwerkt.set(a.id, 1); verwerkt.set(b.id, 1);
  const x = l2Ronde(mm, gm, [a.id, b.id], { vlag: true });
  assert.deepEqual(soortActies(x, 'archief').map(function (y) { return y.gmail_id; }), [a.id], 'alleen de factuur zonder vlag');
  assert.equal(gm.ber.get(a.id).plek, 'archief');
  assert.equal(gm.ber.get(b.id).plek, 'inbox');
});

test('wv2189 afgedaan: alleen na Davids archiveren of prullenbak, alleen met de schakelaar; niet bij NIEUWSBRIEF, niet als de vlag pas buiten de inbox kwam, niet na MailMans eigen archief', () => {
  const { mm, dir, gm } = b8Kamer();
  const ms = [mail(), mail(), mail(), mail(), mail(), mail(), mail()];
  const [a, f, c, d, e, g, h] = ms;
  draai(mm, 'gmail:david', ms, { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  const ids = ms.map(function (m) { return m.id; });
  l2Ronde(mm, gm, ids, { vlag: true });   // eerste volledige lijsten (bron voor), OVERIG via de besluittak
  gm.zet(a.id, 'ACTIE_DS'); gm.zet(f.id, 'ACTIE_DS'); gm.zet(f.id, 'TODO'); gm.zet(c.id, 'TODO'); gm.zet(c.id, 'NIEUWSBRIEF'); gm.zet(e.id, 'TODO'); gm.zet(g.id, 'TODO'); gm.zet(h.id, 'TODO');
  gm.plek(d.id, 'archief');
  l2Ronde(mm, gm, ids, { vlag: true });   // alle vlaggen in de inbox gezien (behalve d: die is al gearchiveerd)
  gm.zet(d.id, 'TODO');                    // David zet TODO op een mail die al gearchiveerd was
  mm._db.prepare('UPDATE besluit SET archief_tijd = ? WHERE gmail_id = ?').run(new Date(klok).toISOString(), e.id);   // MailMans eigen archief
  gm.plek(a.id, 'archief'); gm.plek(f.id, 'prullenbak'); gm.plek(c.id, 'archief'); gm.plek(e.id, 'archief'); gm.plek(g.id, 'archief');
  // zonder schakelaar: niets in Gmail, wel geteld
  const s = l2Ronde(mm, gm, ids, { vlag: true });
  assert.deepEqual(soortActies(s, 'afgedaan'), []);
  assert.equal(s.l.j.telling.afgedaan_schaduw, 3, 'a, f en g (niet c: nieuwsbrief, d: nooit in de inbox gezien, e: eigen archief)');
  assert.equal(s.s.j.telling.vlag_eigen, 1);
  assert.deepEqual([afStand(mm).aan, afStand(mm).wacht, afStand(mm).eigen], [false, 4, 1], 'c telt als wacht maar wordt overgeslagen (nieuwsbrief)');
  // g gaat terug in de inbox vóór de schakelaar aan gaat → geen afgedaan
  gm.plek(g.id, 'inbox');
  afgedaanToestaan(dir);
  const x = l2Ronde(mm, gm, ids, { vlag: true });
  const per = perId(soortActies(x, 'afgedaan'));
  assert.deepEqual(Object.keys(per).sort(), [a.id, f.id].sort());
  assert.deepEqual(per[a.id].erbij, []); assert.deepEqual(per[a.id].eraf, ['ACTIE_DS']);
  assert.deepEqual(per[f.id].eraf.slice().sort(), ['ACTIE_DS', 'TODO'], 'prullenbak: beide vlaggen');
  assert.equal(x.l.j.telling.afgedaan, 2);
  assert.equal(x.g.j.telling.afgedaan, 2);
  assert.equal(gm.heeft(a.id, 'ACTIE_DS'), false); assert.equal(gm.heeft(f.id, 'TODO'), false);
  assert.ok(gm.heeft(c.id, 'TODO') && gm.heeft(c.id, 'NIEUWSBRIEF'), 'gearchiveerde nieuwsbrief houdt zijn labels');
  assert.ok(gm.heeft(d.id, 'TODO') && gm.heeft(e.id, 'TODO') && gm.heeft(g.id, 'TODO') && gm.heeft(h.id, 'TODO'));
  assert.equal(lsRij(mm, a.id, 'ACTIE_DS').weg_door, 'mailman');
  // volgende ronde: niets meer, en de lijst ziet geen 'David haalde het weg'
  const y = l2Ronde(mm, gm, ids, { vlag: true });
  assert.deepEqual(soortActies(y, 'afgedaan'), []);
  assert.equal(y.s.j.telling.david_eraf, 0);
  // h: archiveren, maar de lijst buiten de inbox is afgekapt → niets; daarna volledig → afgedaan
  gm.plek(h.id, 'archief');
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids, { vlag: true, vlagAfgekapt: 'TODO@uit' }), 'afgedaan'), []);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids, { vlag: true, vlagId: 'Label_99' }), 'afgedaan'), [], 'verkeerd label-ID');
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids, { vlag: true }), 'afgedaan').map(function (z) { return z.gmail_id; }), [h.id]);
  // David zet de vlag opnieuw en zet de mail terug in de inbox: nieuw begin; weer archiveren → weer weg
  gm.zet(a.id, 'TODO'); gm.plek(a.id, 'inbox');
  l2Ronde(mm, gm, ids, { vlag: true });
  gm.plek(a.id, 'archief');
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids, { vlag: true }), 'afgedaan').map(function (z) { return [z.gmail_id, z.eraf]; }), [[a.id, ['TODO']]]);
  // doktersmaten nooit
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:groenhouten'; }).afgedaan, undefined);
});

test('wv2189 afgedaan: overgeslagen bij de n8n-grens is geen labelfout, hooguit 5 pogingen; labelset 2 uit = niets', () => {
  const { mm, dir, gm } = b8Kamer();
  const a = mail();
  draai(mm, 'gmail:david', [a], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir); afgedaanToestaan(dir);
  gm.voeg(a);
  l2Ronde(mm, gm, [a.id], { vlag: true });
  gm.zet(a.id, 'TODO');
  l2Ronde(mm, gm, [a.id], { vlag: true });
  gm.plek(a.id, 'archief');
  gm.zet(a.id, 'NIEUWSBRIEF');   // de nep-grens slaat over; label_staat ziet NIEUWSBRIEF pas als David het zet — hier tegelijk
  let n = 0, fouten = 0;
  for (let i = 0; i < 8; i++) { const x = l2Ronde(mm, gm, [a.id], { vlag: true, afgekapt: 'NIEUWSBRIEF' }); n += soortActies(x, 'afgedaan').length; fouten += x.g.j.telling.fout; }
  assert.equal(n, 5, 'hooguit 5 keer aangeboden');
  assert.equal(fouten, 0);
  assert.equal(afStand(mm).opgegeven, 1);
  // labelset 2 weg: geen vlaglijsten, geen afgedaan
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); delete c.labelset2; fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  assert.equal(afStand(mm).aan, false);
});

test('wv2189 archief na een weggehaalde vlag: factuurmail met ACTIE_DS (oud besluit) wacht; na Davids archiveren gaat ACTIE_DS eraf en volgt FACTUUR/verwerkt; David haalt hem zelf weg → archief', () => {
  const verwerkt = new Map();
  const intake = new Set();
  const k = nieuweKamer({ factuurVerwerkt: function (ids) { return new Map(ids.filter(function (i) { return verwerkt.has(i); }).map(function (i) { return [i, 1]; })); },
    intakeBerichten: function (pv, ids) { return new Set(ids.filter(function (i) { return intake.has(i); })); } });
  const { mm, dir } = k, gm = nepGmail();
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir); uitgangToestaan(dir, ['gmail:david']); vinkje(mm, 'factuur', 'archief');
  const pdf = [{ naam: 'Factuur.pdf', mime: 'application/pdf' }];
  const a = mail({ bijlagen: pdf }), b = mail({ bijlagen: pdf });
  gm.voeg(a); gm.voeg(b);
  // een besluit van vóór wv2189 (Jev zonder actie_anders): FACTUUR + ACTIE_DS
  draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord({ factuur: 0.97, mens: 0.86, actie: 0.99, waarde: 2 }); } });
  mm._db.prepare("UPDATE besluit SET jev = json_remove(jev, '$.actie_anders')").run();
  assert.ok(JSON.parse(rij(mm, a.id).labels_plan).includes('TODO'), 'oud plan noemt TODO');
  const ids = [a.id, b.id];
  l2Ronde(mm, gm, ids, { vlag: true });
  assert.ok(gm.heeft(a.id, 'ACTIE_DS') && gm.heeft(b.id, 'ACTIE_DS'));
  l2Ronde(mm, gm, ids, { vlag: true });
  verwerkt.set(a.id, 1); verwerkt.set(b.id, 1);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids, { vlag: true }), 'archief'), [], 'met ACTIE_DS nooit archief');
  afgedaanToestaan(dir);
  gm.plek(a.id, 'archief');            // David archiveert a
  gm.weg(b.id, 'ACTIE_DS');            // David haalt bij b zelf ACTIE_DS weg (b blijft in de inbox)
  const x = l2Ronde(mm, gm, ids, { vlag: true });
  assert.deepEqual(soortActies(x, 'afgedaan').map(function (y) { return y.gmail_id; }), [a.id]);
  assert.deepEqual(soortActies(x, 'archief').map(function (y) { return y.gmail_id; }), [b.id], 'b: David haalde de vlag weg → meteen archief');
  const y = l2Ronde(mm, gm, ids, { vlag: true });
  assert.deepEqual(soortActies(y, 'archief').map(function (z) { return z.gmail_id; }), [a.id], 'a: na afgedaan de ronde erna (staat al buiten de inbox: alleen het sublabel)');
  assert.ok(gm.heeft(a.id, 'FACTUUR/verwerkt') && gm.heeft(b.id, 'FACTUUR/verwerkt'));
  assert.equal(gm.ber.get(b.id).plek, 'archief');
});

test('wv2208 Ecobank-transactiemelding: vaste regel → OVERIG, geen NIEUWSBRIEF (ook niet geërfd), geen Jev; gewone nieuwsbrief blijft NIEUWSBRIEF', () => {
  const EB = 'Ecobank <noreply@ecobank.com>', OND = 'InApp Notification - Transaction Notification on A/C ***0000';
  // zuiver: afzender exact, onderwerp aan het begin
  const n = function (o) { return K.normaliseer(mail(o)); };
  assert.equal(K.ecobankMelding(n({ van: EB, onderwerp: OND, afmeld: true })), true);
  assert.equal(K.ecobankMelding(n({ van: 'NOREPLY@Ecobank.com', onderwerp: OND })), true, 'adres hoofdletterongevoelig');
  assert.equal(K.ecobankMelding(n({ van: 'Ecobank <noreply@ecobank.com.voorbeeld.invalid>', onderwerp: OND })), false, 'afzender exact');
  assert.equal(K.ecobankMelding(n({ van: 'Ecobank <alerts@ecobank.com>', onderwerp: OND })), false);
  assert.equal(K.ecobankMelding(n({ van: EB, onderwerp: 'InApp Notification - Account Statement - XYZ' })), false, 'alleen transactiemeldingen');
  assert.equal(K.ecobankMelding(n({ van: EB, onderwerp: 'Re: ' + OND })), false, 'onderwerp aan het begin');
  const inst = { todo_nooit: ['doctolib'] };
  assert.deepEqual(K.labelPlan2('info', null, n({ van: EB, onderwerp: OND, afmeld: true }), inst).labels, ['OVERIG'], 'Ecobank: OVERIG, geen NIEUWSBRIEF');
  assert.deepEqual(K.labelPlan2('info', null, { van_adres: '', van_domein: 'ecobank.com', onderwerp: '', afmeld: true, ecobank: true }, inst).labels, ['OVERIG'], 'logboekrij na 14 dagen (reden ecobank)');
  assert.deepEqual(K.labelPlan2('info', null, n({ van: 'Nieuws <nieuws@vereniging.invalid>', onderwerp: 'Nieuwsbrief', afmeld: true }), inst).labels, ['NIEUWSBRIEF'], 'gewone nieuwsbrief blijft');
  assert.deepEqual(K.labelPlan2('info', null, n({ van: EB, onderwerp: 'InApp Notification - Account Statement', afmeld: true }), inst).labels, ['NIEUWSBRIEF'], 'andere Ecobank-mail: ongewijzigd');

  // besluit: vaste regel vóór draad, geen Jev; Davids eigen _AI_-markering gaat vóór
  const { mm, dir, gm } = b8Kamer();
  const th = hexId();
  const eb1 = mail({ van: EB, onderwerp: OND, afmeld: true, threadId: th, datum: klok - 9 * 3600000 });
  const gev = mail({ van: EB, onderwerp: OND, afmeld: true, datum: klok - 8 * 3600000 });
  const ai = mail({ van: EB, onderwerp: OND, afmeld: true, labels: ['INBOX', '_AI_'], datum: klok - 8 * 3600000 });
  const nb = mail({ van: 'Nieuws <nieuws@vereniging.invalid>', onderwerp: 'Nieuwsbrief november', afmeld: true, datum: klok - 8 * 3600000 });
  const fa = mail({ van: EB, onderwerp: OND, afmeld: true, aan: ALIAS, datum: klok - 8 * 3600000 });   // review MOET 1: ook aan de factuuralias
  let gevraagd = [];
  const d = draai(mm, 'gmail:david', [eb1, gev, ai, nb, fa], { gevolgd: [gev.threadId], jev: function (a) { gevraagd.push(a.gmail_id); return jevAntwoord(JEV_INFO); } });
  assert.ok(!d.s1.j.jev.some(function (a) { return a.gmail_id === eb1.id || a.gmail_id === gev.id; }), 'Ecobank-melding niet naar Jev');
  assert.ok(!d.s1.j.jev.some(function (a) { return a.gmail_id === fa.id; }));
  for (const x of [eb1, gev, fa]) { const b = rij(mm, x.id); assert.equal(b.stap, 'altijd'); assert.equal(b.reden, 'ecobank'); assert.equal(b.stroom, 'info'); assert.equal(b.status, 'klaar'); }
  assert.equal(rij(mm, ai.id).reden, 'markering', 'Davids _AI_ gaat vóór'); assert.equal(rij(mm, ai.id).stroom, 'intake');
  assert.ok(gevraagd.includes(nb.id), 'gewone nieuwsbrief wel naar Jev');

  // labels live: Ecobank OVERIG; nieuwsbrief NIEUWSBRIEF; een nieuwe melding in een draad met NIEUWSBRIEF erft die niet
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  for (const x of [eb1, gev, nb]) gm.voeg(x);
  l2Ronde(mm, gm, [eb1.id, gev.id, nb.id]);
  assert.ok(gm.heeft(eb1.id, 'OVERIG') && !gm.heeft(eb1.id, 'NIEUWSBRIEF'));
  assert.ok(gm.heeft(gev.id, 'OVERIG') && !gm.heeft(gev.id, 'NIEUWSBRIEF'));
  assert.ok(gm.heeft(nb.id, 'NIEUWSBRIEF') && !gm.heeft(nb.id, 'OVERIG'));
  gm.zet(eb1.id, 'NIEUWSBRIEF');   // zoals de oude meldingen van vóór wv2208 (blijft staan: MailMan haalt NIEUWSBRIEF nooit weg)
  l2Ronde(mm, gm, [eb1.id, gev.id, nb.id]);
  const eb2 = mail({ van: EB, onderwerp: OND, afmeld: true, threadId: th, datum: klok - 60000 });
  draai(mm, 'gmail:david', [eb2]);
  gm.voeg(eb2);
  const a = l2Ronde(mm, gm, [eb1.id, eb2.id]);
  const x = perId(a.l.j.acties)[eb2.id];
  assert.deepEqual(x.erbij, ['OVERIG']); assert.deepEqual(x.erf || [], [], 'geen geërfde NIEUWSBRIEF');
  assert.ok(gm.heeft(eb2.id, 'OVERIG') && !gm.heeft(eb2.id, 'NIEUWSBRIEF'));
  assert.ok(gm.heeft(eb1.id, 'NIEUWSBRIEF'), 'Davids/oude label blijft staan');
});

// ─────────── wv2218 zaakregister (Mail-laag stap 3): laagregel, inboxstand, afgehandeld, heropenen, lijst ───────────
test('wv2218 laagBericht: jij · socev · weg volgens B3.3; OVERIG met actie ≥ 0,5 zonder afmeldlink → jij (de 19-gevallen-valkuil)', () => {
  const b = function (o) { return Object.assign({ status: 'klaar', stroom: 'info', juist: null, stap: 'jev', reden: 'score', marker: false, zorg: false, botsing: null, afmeld: false, jev: { actie: 0.1, mens: 0.1 }, vlag: false, route: null, factuur: null }, o || {}); };
  const L = function (o) { const r = K.laagBericht(b(o)); return r.laag + ':' + r.reden + (r.detail ? ':' + r.detail : ''); };
  assert.equal(L({ jev: { actie: 0.6, mens: 0.1 } }), 'jij:actie_mogelijk', 'valkuil: OVERIG met actie');
  assert.equal(L({ jev: { actie: 0.5, mens: 0.1 } }), 'jij:actie_mogelijk', 'grens 0,5 telt mee');
  assert.equal(L({ jev: { actie: 0.49, mens: 0.1 } }), 'weg:geen_actie');
  assert.equal(L({ jev: { actie: 0.1, mens: 0.7 } }), 'jij:persoonlijk');
  assert.equal(L({ jev: { actie: 0.9, mens: 0.9 }, afmeld: true }), 'weg:nieuwsbrief', 'met afmeldlink weggezet');
  assert.equal(L({ reden: 'hard_uit_systeem', jev: { actie: 0.6 } }), 'jij:actie_mogelijk', 'ook een systeemmelding met actie');
  assert.equal(L({ reden: 'hard_uit_systeem', jev: { actie: 0.2 } }), 'weg:systeemmelding');
  assert.equal(L({ jev: null }), 'jij:socev_weet_het_niet', 'geen Jev-oordeel en geen regel');
  assert.equal(L({ jev: { mens: 0.1 } }), 'weg:geen_actie', 'actie niet gemeten: NaN telt niet als ≥ 0,5');
  assert.equal(L({ stap: 'weg', reden: 'regel', jev: null }), 'weg:regel', 'Davids Weg-regel');
  assert.equal(L({ stap: 'weg', reden: 'regel', botsing: 'weg_mens_vraag' }), 'jij:actie_mogelijk', 'botsing gaat vóór de regel');
  assert.equal(L({ stap: 'altijd', reden: 'ecobank', jev: null, afmeld: true }), 'weg:vaste_regel');
  assert.equal(L({ stroom: 'twijfel' }), 'jij:socev_weet_het_niet');
  assert.equal(L({ stroom: 'twijfel', juist: 'info', jev: { actie: 0.9 } }), 'weg:jouw_keuze', 'Davids keuze Overig');
  assert.equal(L({ stroom: 'twijfel', juist: 'intake' }), 'socev:naar_second_brain');
  assert.equal(L({ stroom: 'intake', route: 'wachtrij' }), 'socev:naar_second_brain');
  assert.equal(L({ stroom: 'intake', route: 'verwerkt' }), 'socev:second_brain');
  assert.equal(L({ stroom: 'factuur', factuur: 'in_sepa' }), 'socev:facturen:in_sepa');
  assert.equal(L({ stroom: 'factuur', factuur: 'raar' }), 'socev:facturen:ontvangen');
  assert.equal(L({ stroom: 'factuur', vlag: true }), 'jij:vraagt_actie', 'TODO/ACTIE_DS wint');
  assert.equal(L({ stroom: 'intake', marker: true }), 'jij:slotje');
  assert.equal(L({ stroom: 'twijfel', zorg: true }), 'jij:slotje');
  assert.equal(L({ status: 'wacht_jev', stroom: null }), 'jij:socev_weet_het_niet');
  assert.equal(L({ stroom: 'verkoop' }), 'jij:socev_weet_het_niet', 'onbekend = jij');
  assert.equal(K.laagBericht(null).laag, 'jij');
});
test('wv2218 laagDraad: hoogste laag wint, dan de zwaarste reden, dan het nieuwste bericht', () => {
  const t = function (h) { return new Date(Date.UTC(2026, 10, 1, h)).toISOString(); };
  assert.equal(K.laagDraad([]), null);
  let r = K.laagDraad([{ laag: 'weg', reden: 'nieuwsbrief', tijd: t(9) }, { laag: 'socev', reden: 'facturen', detail: 'in_sepa', tijd: t(8) }]);
  assert.deepEqual([r.laag, r.reden, r.detail, r.index], ['socev', 'facturen', 'in_sepa', 1]);
  r = K.laagDraad([{ laag: 'socev', reden: 'second_brain', tijd: t(10) }, { laag: 'jij', reden: 'persoonlijk', tijd: t(8) }, { laag: 'jij', reden: 'vraagt_actie', tijd: t(7) }]);
  assert.deepEqual([r.laag, r.reden, r.index], ['jij', 'vraagt_actie', 2]);
  r = K.laagDraad([{ laag: 'weg', reden: 'geen_actie', tijd: t(7) }, { laag: 'weg', reden: 'geen_actie', tijd: t(9) }]);
  assert.equal(r.index, 1, 'nieuwste');
  r = K.laagDraad([{ laag: 'raar', reden: 'x' }, { laag: 'weg', reden: 'regel', tijd: t(1) }]);
  assert.equal(r.laag, 'weg');
});

function zakenToestaan(dir, waarde) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.zaken = waarde === undefined ? { 'gmail:david': { aan: true, ja: '2026-11-01T15:59:00Z' }, 'gmail:groenhouten': true } : waarde;
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function zaak(mm, th) { return mm._db.prepare('SELECT * FROM zaak WHERE thread_id = ?').get(th); }
function zakenApp(mm, groep, pagina) { return mm.zakenLijst(groep ? { groep, pagina } : {}); }
test('wv2218 zaakregister: lagen per draad, inbox nooit → laag blijft, eerst in de inbox gezien en dan weg → afgedaan, eigen archief ≠ afgehandeld, heropenen', () => {
  const { mm, dir, gm, fouten } = b8Kamer();
  const actie = mail({ onderwerp: 'Kun je dit tekenen?' });                              // OVERIG met actie, zonder afmeldlink → jij
  const nb = mail({ van: 'Nieuws <nieuws@vereniging.invalid>', onderwerp: 'Nieuwsbrief', afmeld: true });   // → weg nieuwsbrief
  const sys = mail({ onderwerp: 'Je wachtwoord is gewijzigd' });                          // → weg systeemmelding
  const mens = mail({ van: 'Iemand <iemand@voorbeeld.invalid>', onderwerp: 'Etentje' });  // → socev (intake)
  const nooit = mail({ onderwerp: 'Via een filter' });                                    // nooit in de inbox
  const arch = mail({ onderwerp: 'Gelezen en weg' });                                     // David archiveert → afgedaan
  const eigen = mail({ onderwerp: 'Factuur', bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf' }] });   // MailMans eigen archief
  const d1 = mail({ onderwerp: 'Draad: eerst nieuws', afmeld: true }), d2 = mail({ threadId: d1.threadId, onderwerp: 'Re: draad', datum: klok - 1800000 });   // jij wint in de draad
  const ms = [actie, nb, sys, mens, nooit, arch, eigen, d1, d2];
  const jev = { [actie.id]: { systeem: 0.99, waarde: 0, actie: 0.6 }, [nb.id]: JEV_INFO, [sys.id]: JEV_INFO, [mens.id]: JEV_INTAKE, [nooit.id]: JEV_INFO,
    [arch.id]: JEV_INFO, [eigen.id]: { factuur: 0.99 }, [d1.id]: JEV_INFO, [d2.id]: { systeem: 0.99, waarde: 0, mens: 0.7 } };
  draai(mm, 'gmail:david', ms, { jev: function (a) { return jevAntwoord(jev[a.gmail_id]); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  ms.forEach(function (m) { gm.voeg(m); });
  gm.plek(nooit.id, 'archief');   // kwam nooit in de inbox
  const ids = ms.map(function (m) { return m.id; });
  // zonder schakelaar: geen zaken, de inboxlijst wordt genegeerd
  let x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true });
  assert.equal(x.s.status, 200); assert.equal(x.s.j.telling.zaken, undefined);
  assert.equal(mm._db.prepare('SELECT count(*) n FROM zaak').get().n, 0);
  assert.deepEqual(zakenApp(mm).j, { ok: true, aan: false });
  zakenToestaan(dir);
  x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true });
  assert.deepEqual(fouten, []);
  assert.equal(x.s.j.telling.inbox, 8, 'acht van de negen berichten in de inbox (nooit staat in het archief)');
  assert.equal(x.s.j.telling.zaken.draden, 8);
  const L = function (m) { const z = zaak(mm, m.threadId); return z.laag + ':' + z.laag_reden + (z.laag_detail ? ':' + z.laag_detail : ''); };
  assert.equal(L(actie), 'jij:actie_mogelijk');
  assert.equal(L(nb), 'weg:nieuwsbrief');
  assert.equal(L(sys), 'weg:systeemmelding');
  assert.equal(L(mens), 'socev:naar_second_brain');
  assert.equal(L(eigen), 'socev:facturen:ontvangen');
  assert.equal(L(d1), 'jij:persoonlijk', 'hoogste laag in de draad');
  assert.equal(zaak(mm, d1.threadId).berichten, 2);
  assert.equal(zaak(mm, d1.threadId).laag_versie, K.LAAG_VERSIE);
  assert.equal(zaak(mm, nooit.threadId).inbox, 'nooit');
  assert.equal(zaak(mm, actie.threadId).inbox, 'ja');
  assert.ok(zaak(mm, nb.threadId).ooit_weggezet, 'weggezet onthouden voor de meting (B3.6)');
  // David archiveert arch en nooit blijft weg; MailMan archiveert eigen (archief_tijd) — daarna ook uit de inbox
  klok += 15 * 60000;
  gm.plek(arch.id, 'archief');
  mm._db.prepare('UPDATE besluit SET archief_tijd = ? WHERE gmail_id = ?').run(new Date(klok).toISOString(), eigen.id);
  gm.plek(eigen.id, 'archief');
  // onvolledige inboxlijst: niets verandert
  x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true, inboxAfgekapt: true });
  assert.equal(x.s.j.telling.inbox_afgekapt, 1);
  assert.equal(zaak(mm, arch.threadId).inbox, 'ja'); assert.equal(zaak(mm, arch.threadId).afgehandeld, null);
  // verkeerde ID: ook niets
  x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true, inboxId: 'Label_99' });
  assert.equal(zaak(mm, arch.threadId).afgehandeld, null);
  // volledig: arch afgedaan door David; eigen archief niet; nooit blijft nooit
  x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true });
  assert.equal(zaak(mm, arch.threadId).inbox, 'nee'); assert.ok(zaak(mm, arch.threadId).afgehandeld); assert.equal(zaak(mm, arch.threadId).afgehandeld_door, 'david_gmail');
  assert.equal(zaak(mm, eigen.threadId).inbox, 'nee'); assert.equal(zaak(mm, eigen.threadId).afgehandeld, null); assert.equal(zaak(mm, eigen.threadId).eigen_archief, 1);
  assert.equal(L(eigen), 'socev:facturen:verwerkt');
  assert.equal(zaak(mm, nooit.threadId).inbox, 'nooit'); assert.equal(zaak(mm, nooit.threadId).afgehandeld, null);
  assert.equal(L(nooit), 'weg:systeemmelding', 'de laag blijft staan');
  assert.equal(x.s.j.telling.zaken.afgehandeld, 1);
  // de lijst in de app
  let a = zakenApp(mm);
  assert.equal(a.status, 200); assert.equal(a.j.aan, true);
  assert.deepEqual(a.j.tellers, { jij: 2, socev: 2, weg: 3, afgedaan: 1 });
  assert.deepEqual(a.j.lagen.afgedaan.map(function (z) { return z.draad; }), [arch.threadId]);
  const rj = a.j.lagen.jij.find(function (z) { return z.draad === actie.threadId; });
  assert.equal(rj.onderwerp, 'Kun je dit tekenen?'); assert.equal(rj.domein, 'voorbeeld.invalid'); assert.equal(rj.reden, 'actie_mogelijk');
  assert.ok(a.j.bijgewerkt && a.j.inbox_bijgewerkt); assert.equal(a.j.verouderd, false);
  assert.equal(a.j.weg_vandaag, 4, 'nb, sys, nooit en arch (afgedaan telt mee: hij werd vandaag weggezet)');
  assert.equal(zakenApp(mm, 'raar', 1).status, 404); assert.equal(zakenApp(mm, 'jij', 0).status, 404); assert.equal(zakenApp(mm, 'jij', 1.5).status, 404);
  const p2 = zakenApp(mm, 'weg', 2);
  assert.equal(p2.status, 200); assert.deepEqual(p2.j.lagen.weg, []); assert.equal(p2.j.lagen.jij, undefined); assert.equal(p2.j.meer.weg, false);
  const stand = mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).zaken;
  assert.deepEqual([stand.aan, stand.jij, stand.socev, stand.weg, stand.afgedaan], [true, 2, 2, 3, 1]);
  assert.deepEqual(mm.info().postvakken.find(function (p) { return p.id === 'gmail:groenhouten'; }).zaken, undefined, 'nooit doktersmaten');
  // heropenen: een nieuw bericht in de afgehandelde draad
  klok += 3600000;
  const arch2 = mail({ threadId: arch.threadId, onderwerp: 'Re: Gelezen en weg', datum: klok - 60000 });
  draai(mm, 'gmail:david', [arch2], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(arch2);
  l2Ronde(mm, gm, ids.concat([arch2.id]), { vlag: true, inbox: true });
  assert.equal(zaak(mm, arch.threadId).afgehandeld, null); assert.ok(zaak(mm, arch.threadId).heropend); assert.equal(zaak(mm, arch.threadId).inbox, 'ja');
  assert.equal(zakenApp(mm).j.tellers.afgedaan, 0);
  // een twijfelzaak geeft het besluit-id voor de bestaande keuzeknoppen (Werkstroom)
  mm._db.prepare("UPDATE besluit SET stroom = 'twijfel', juist = NULL WHERE gmail_id = ?").run(sys.id);
  l2Ronde(mm, gm, ids.concat([arch2.id]), { vlag: true, inbox: true });
  const tw = zakenApp(mm).j.lagen.jij.find(function (z) { return z.draad === sys.threadId; });
  assert.equal(tw.reden, 'socev_weet_het_niet'); assert.equal(tw.twijfel, rij(mm, sys.id).id);
  // schakelaar uit: lijst uit, niets meer berekend
  zakenToestaan(dir, {});
  const voor = zaak(mm, actie.threadId).bijgewerkt;
  klok += 60000;
  x = l2Ronde(mm, gm, ids, { vlag: true, inbox: true });
  assert.equal(x.s.j.telling.zaken, undefined); assert.equal(zaak(mm, actie.threadId).bijgewerkt, voor);
  assert.equal(zakenApp(mm).j.aan, false);
  assert.deepEqual(fouten, []);
});
test('wv2218 zaakregister: nooit doktersmaten, geen Gmail-actie erbij, oude zaken na 60 dagen weg', () => {
  const { mm, dir, gm } = b8Kamer();
  const m1 = mail({ onderwerp: 'Gewoon' });
  draai(mm, 'gmail:david', [m1], { jev: function () { return jevAntwoord(JEV_INFO); } });
  toestaan(dir, ['gmail:david']); zetLive(mm); l2Toestaan(dir);
  gm.voeg(m1);
  l2Ronde(mm, gm, [m1.id], { vlag: true });   // labels van het besluit gezet
  const zonder = l2Ronde(mm, gm, [m1.id], { vlag: true }).l.j.acties;
  zakenToestaan(dir, { 'gmail:groenhouten': true });
  l2Ronde(mm, gm, [m1.id], { vlag: true, inbox: true });
  assert.equal(mm._db.prepare('SELECT count(*) n FROM zaak').get().n, 0, 'alleen de schakelaar van gmail:david telt');
  zakenToestaan(dir, { 'gmail:david': true });
  const met = l2Ronde(mm, gm, [m1.id], { vlag: true, inbox: true });
  assert.equal(mm._db.prepare('SELECT count(*) n FROM zaak').get().n, 1);
  assert.deepEqual(met.l.j.acties, zonder, 'het zaakregister voegt geen Gmail-actie toe');
  klok += 61 * 86400000;
  mm.opruim();
  assert.equal(mm._db.prepare('SELECT count(*) n FROM zaak').get().n, 0);
});

// ─────────── wv2259: inbox_uit (Ecobank-meldingen, factuurmail zodra in Facturen, terug bij Geen factuur) ───────────
function inboxUitToestaan(dir, o) {
  const f = path.join(dir, 'config.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.inbox_uit = { 'gmail:david': Object.assign({ ja: '2026-11-02T13:55:00+01:00, vraag-id 640619c4' }, o || {}), 'gmail:groenhouten': Object.assign({ ja: 'x', ecobank: true, facturen: true }) };
  fs.writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
}
function wv2259Kamer(extra) {
  const k = nieuweKamer(extra), gm = nepGmail();
  toestaan(k.dir, ['gmail:david']); zetLive(k.mm); l2Toestaan(k.dir); uitgangToestaan(k.dir, ['gmail:david']);
  return Object.assign(k, { gm });
}

test('wv2259 ecobank: alleen met inbox_uit.ja + ecobank, alleen verwerkte id\'s, UNREAD+INBOX eraf, één keer; TODO nooit; ≤ 20 per ronde; gedeeld nooit', () => {
  const { mm, dir, gm } = wv2259Kamer();
  const a = mail({ van: 'Ecobank <noreply@ecobank.com>', onderwerp: 'InApp Notification - Transaction Notification on A/C ***1234' });
  const b = mail({ van: 'Ecobank <noreply@ecobank.com>', onderwerp: 'Login success Alert.' });
  const c = mail({ van: 'Ecobank <noreply@ecobank.com>', onderwerp: 'InApp Notification - Transaction Notification on A/C ***5678' });
  draai(mm, 'gmail:david', [a, b, c], { jev: function () { return jevAntwoord(JEV_INFO); } });
  [a, b, c].forEach(function (m) { gm.voeg(m); });
  const ids = [a.id, b.id, c.id];
  l2Ronde(mm, gm, ids);
  assert.equal(mm.ecobankBekend('gmail:david', [a.id, c.id, 'geen-hex']), 2);
  assert.equal(mm.ecobankBekend('gmail:david', [a.id]), 0, 'bestaande blijven');
  assert.equal(mm.ecobankBekend('gmail:onbekend', [a.id]), 0);
  // zonder Ja: niets
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'ecobank'), []);
  inboxUitToestaan(dir, { ecobank: false, facturen: false });
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'ecobank'), [], 'vinkje ecobank uit');
  gm.zet(c.id, 'TODO');
  l2Ronde(mm, gm, ids);   // label_staat ziet TODO
  inboxUitToestaan(dir, { ecobank: true });
  const x = l2Ronde(mm, gm, ids);
  const e = soortActies(x, 'ecobank');
  assert.deepEqual(e.map(function (y) { return [y.gmail_id, y.erbij, y.eraf]; }), [[a.id, [], ['UNREAD', 'INBOX']]], 'alleen a: b is niet verwerkt, c heeft TODO');
  assert.equal(e[0].draad, undefined, 'nooit op de draad');
  assert.equal(x.g.j.telling.ecobank, 1);
  assert.equal(gm.ber.get(a.id).plek, 'archief'); assert.equal(gm.ber.get(b.id).plek, 'inbox');
  assert.ok(mm._db.prepare('SELECT archief_tijd FROM ecobank_mail WHERE gmail_id = ?').get(a.id).archief_tijd);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'ecobank'), [], 'één keer');
  const ov = mm.app('GET /app/mailman', {});
  const pd = ov.j.postvakken.find(function (p) { return p.id === 'gmail:david'; }).inbox_uit;
  assert.deepEqual([pd.ja, pd.ecobank, pd.facturen, pd.ecobank_bekend, pd.ecobank_weg], [true, true, false, 2, 1]);
  const pg = ov.j.postvakken.find(function (p) { return p.id === 'gmail:groenhouten'; }).inbox_uit;
  assert.equal(pg.ja, false, 'doktersmaten nooit');
  // 25 nieuwe verwerkte meldingen → hooguit 20 per ronde; overgeslagen bij de grens telt als poging, geen labelfout, na 5 opgegeven
  const veel = []; for (let i = 0; i < 25; i++) { const m = mail({ van: 'noreply@ecobank.com' }); gm.voeg(m); veel.push(m.id); }
  mm.ecobankBekend('gmail:david', veel);
  assert.equal(soortActies(l2Ronde(mm, gm, ids), 'ecobank').length, 20);
  const z = mail(); mm.ecobankBekend('gmail:david', [z.id]);   // niet in nep-Gmail → overgeslagen
  let n = 0, fout = 0;
  for (let i = 0; i < 8; i++) { const y = l2Ronde(mm, gm, ids); n += soortActies(y, 'ecobank').filter(function (q) { return q.gmail_id === z.id; }).length; fout += y.g.j.telling.fout; }
  assert.equal(n, 5); assert.equal(fout, 0);
});

test('wv2259 facturen: archiveren met inFacturen alleen als het vinkje facturen aan staat; terug bij Geen factuur (INBOX + UNREAD als MailMan las, FACTUUR/verwerkt eraf), één keer, daarna nooit opnieuw archief', () => {
  const inF = new Map(), verw = new Map(), geen = new Set(), modi = [];
  const { mm, dir, gm } = wv2259Kamer({
    factuurVerwerkt: function (ids, opt) { modi.push(!!(opt && opt.inFacturen)); const bron = opt && opt.inFacturen ? inF : verw; return new Map(ids.filter(function (i) { return bron.has(i); }).map(function (i) { return [i, bron.get(i)]; })); },
    factuurGeen: function (ids) { return new Set(ids.filter(function (i) { return geen.has(i); })); } });
  vinkje(mm, 'factuur', 'archief'); vinkje(mm, 'factuur', 'gelezen');
  const pdf = [{ naam: 'Factuur.pdf', mime: 'application/pdf' }];
  const a = mail({ aan: ALIAS, bijlagen: pdf }), b = mail({ aan: ALIAS, bijlagen: pdf });
  gm.voeg(a); gm.voeg(b);
  const r = ronde(mm, 'gmail:david');
  mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: 'gmail:david', ids: [a.id, b.id], volledig: true });
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: 'gmail:david', mails: [a, b], gevolgd: [] });
  if (s1.j.jev && s1.j.jev.length) mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: 'gmail:david', antwoorden: s1.j.jev.map(function (x) { return { gmail_id: x.gmail_id, antwoord: jevAntwoord({ factuur: 0.97, waarde: 2, actie: 0.2 }) }; }) });
  mm.n8n('POST /mailman/labelstaat', { ronde: r.ronde, postvak: 'gmail:david', labels: gm.lijsten() });
  const l = mm.n8n('POST /mailman/labels', { ronde: r.ronde, postvak: 'gmail:david', ids: [a.id, b.id] });
  mm.n8n('POST /mailman/gezet', { ronde: r.ronde, postvak: 'gmail:david', resultaten: gm.pas(l.j.acties) });
  mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: 'gmail:david' });
  assert.ok(gm.heeft(a.id, 'FACTUUR') && gm.heeft(b.id, 'FACTUUR'));
  assert.ok(rij(mm, a.id).gelezen_tijd, 'MailMan markeerde a gelezen');
  const ids = [a.id, b.id];
  // in Facturen (te beoordelen), nog niet verwerkt: zonder vinkje facturen geen archief, en de oude modus wordt gevraagd
  inF.set(a.id, 1); inF.set(b.id, 1);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'archief'), []);
  assert.equal(modi[modi.length - 1], false);
  inboxUitToestaan(dir, { facturen: true });
  const x = l2Ronde(mm, gm, ids);
  assert.deepEqual(soortActies(x, 'archief').map(function (y) { return y.gmail_id; }).sort(), ids.slice().sort());
  assert.equal(modi[modi.length - 1], true);
  assert.equal(gm.ber.get(a.id).plek, 'archief'); assert.ok(gm.heeft(a.id, 'FACTUUR/verwerkt'));
  // David: Geen factuur op a → terug
  geen.add(a.id);
  const y = l2Ronde(mm, gm, ids);
  const t = soortActies(y, 'terug');
  assert.deepEqual(t.map(function (q) { return [q.gmail_id, q.erbij, q.eraf]; }), [[a.id, ['INBOX', 'UNREAD'], ['FACTUUR/verwerkt']]]);
  assert.equal(y.g.j.telling.terug, 1);
  assert.equal(gm.ber.get(a.id).plek, 'inbox'); assert.equal(gm.heeft(a.id, 'FACTUUR/verwerkt'), false); assert.ok(gm.heeft(a.id, 'FACTUUR'), 'FACTUUR blijft');
  assert.ok(rij(mm, a.id).terug_tijd);
  // idempotent en nooit opnieuw archief
  const z = l2Ronde(mm, gm, ids);
  assert.deepEqual(soortActies(z, 'terug'), []); assert.deepEqual(soortActies(z, 'archief'), []);
  // b niet door MailMan gelezen gemarkeerd → terug zonder UNREAD
  mm._db.prepare('UPDATE besluit SET gelezen_tijd = NULL WHERE gmail_id = ?').run(b.id);
  geen.add(b.id);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'terug').map(function (q) { return q.erbij; }), [['INBOX']]);
  // terug zonder inbox_uit.ja: niets
  const c = mail({ aan: ALIAS, bijlagen: pdf }); void c;
});

test('wv2259 terug: alleen wat MailMan zelf archiveerde; overgeslagen (prullenbak) is geen labelfout, hooguit 5 keer; zonder Ja niets', () => {
  const geen = new Set();
  const { mm, dir, gm } = wv2259Kamer({ factuurGeen: function (ids) { return new Set(ids.filter(function (i) { return geen.has(i); })); } });
  const a = mail(), b = mail();
  draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(a); gm.voeg(b);
  const ids = [a.id, b.id];
  l2Ronde(mm, gm, ids);
  mm._db.prepare('UPDATE besluit SET archief_tijd = ? WHERE gmail_id = ?').run(new Date(klok).toISOString(), a.id);
  geen.add(a.id); geen.add(b.id);
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'terug'), [], 'zonder Ja niets');
  inboxUitToestaan(dir, {});
  gm.plek(a.id, 'prullenbak');
  let n = 0, fout = 0;
  for (let i = 0; i < 8; i++) { const y = l2Ronde(mm, gm, ids); const t = soortActies(y, 'terug'); assert.ok(t.every(function (q) { return q.gmail_id === a.id; }), 'b archiveerde MailMan niet'); n += t.length; fout += y.g.j.telling.fout; }
  assert.equal(n, 5); assert.equal(fout, 0);
  assert.equal(gm.ber.get(a.id).plek, 'prullenbak');
});

test('wv2259 terug: niet bij TODO of ACTIE_DS (review gpt-5.5 MOET 1)', () => {
  const geen = new Set();
  const { mm, dir, gm } = wv2259Kamer({ factuurGeen: function (ids) { return new Set(ids.filter(function (i) { return geen.has(i); })); } });
  const a = mail(), b = mail();
  draai(mm, 'gmail:david', [a, b], { jev: function () { return jevAntwoord(JEV_INFO); } });
  gm.voeg(a); gm.voeg(b);
  const ids = [a.id, b.id];
  l2Ronde(mm, gm, ids);
  for (const m of [a, b]) mm._db.prepare('UPDATE besluit SET archief_tijd = ? WHERE gmail_id = ?').run(new Date(klok).toISOString(), m.id);
  gm.zet(a.id, 'TODO'); gm.zet(b.id, 'FACTUUR');
  l2Ronde(mm, gm, ids);
  geen.add(a.id); geen.add(b.id); inboxUitToestaan(dir, {});
  assert.deepEqual(soortActies(l2Ronde(mm, gm, ids), 'terug').map(function (q) { return q.gmail_id; }), [b.id]);
});
