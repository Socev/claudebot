'use strict';
// wv4326: Intake-poort in MailMan (config.json intake_poort). Alle toetsdata is verzonnen (de repo is openbaar).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const MM = require('../mailman.js');
const poort = require('../intake/patientpoort.js');

const ALIAS = 'iemand+facturen@voorbeeld.invalid';
const klok = Date.parse('2026-11-27T09:00:00Z');
function kamer(stand, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailman-poort-'));
  const cfg = { postvakken: { 'gmail:david': { naam: 'Privé', factuur_alias: ALIAS, stand: 'schaduw', jev: true, tekst: true } } };
  if (stand) cfg.intake_poort = { 'gmail:david': stand };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), { mode: 0o600 });
  const fouten = [];
  const mm = MM.maak(Object.assign({ dir, nu: function () { return klok; }, fout: function (w, e) { fouten.push(w + ': ' + e.message); },
    marker: poort, eigenAdressen: function () { return ['ik@eigen.invalid']; }, intakeDraden: function () { return new Set(); },
    intakeAfzender: function (pv, a) { return a === 'bekend@winkel.invalid'; }, contactAdressen: function () { return new Set(['vriend@thuis.invalid']); },
    primair: function () { return true; }, geheimOk: function (d) { return d && d.secret === 'proefgeheim'; } }, extra || {}));
  return { dir, mm, fouten };
}
let teller = 0;
function hexId() { teller++; return crypto.createHash('sha1').update('p' + teller).digest('hex').slice(0, 16); }
function mail(o) {
  return Object.assign({ id: hexId(), threadId: hexId(), van: 'Voorbeeld <info@voorbeeld.invalid>', aan: 'ontvanger@voorbeeld.invalid', onderwerp: 'Onderwerp',
    labels: ['INBOX', 'CATEGORY_UPDATES'], bijlagen: [], tekst: 'Een gewone tekst zonder bijzonderheden.', datum: klok - 3600000, afmeld: false }, o || {});
}
function jevAntwoord(w) {
  const answers = {};
  for (const k of ['factuur', 'mens', 'actie', 'systeem', 'aan_ai', 'injectie']) answers[k] = { type: 'noul', noul: w[k] == null ? 0.02 : w[k] };
  answers.actie_anders = { type: 'noul', noul: w.actie == null ? 0.02 : w.actie };
  answers.waarde = { type: 'score', score: w.waarde == null ? 1 : w.waarde, legend: {}, probabilities: {}, confidence: 0.8 };
  return { result: { state: 'Completed', result: { model: 'jev-1.13.0', answers, usage: { input_tokens: 900, output_tokens: 40 } } }, success: true };
}
const TWIJFEL = { mens: 0.12, actie: 0.94, systeem: 0.04, waarde: 1.33 };   // 'school' uit O.1 → twijfel/score
const INTAKE = { mens: 0.95, actie: 0.9, waarde: 2.8 };
function draai(mm, mails, jev, gevolgd) {
  const pv = 'gmail:david';
  const s = mm.n8n('POST /mailman/start', {});
  const r = s.j.postvakken.find(function (x) { return x.postvak === pv; });
  const n = mm.n8n('POST /mailman/nieuw', { ronde: r.ronde, postvak: pv, ids: mails.map(function (m) { return m.id; }), volledig: true });
  const s1 = mm.n8n('POST /mailman/stap1', { ronde: r.ronde, postvak: pv, mails: mails.filter(function (m) { return n.j.nieuw.includes(m.id); }), gevolgd: gevolgd || [] });
  assert.equal(s1.status, 200, JSON.stringify(s1.j));
  const ant = s1.j.jev.map(function (a) { return { gmail_id: a.gmail_id, antwoord: jevAntwoord(jev) }; });
  const s2 = mm.n8n('POST /mailman/stap2', { ronde: r.ronde, postvak: pv, antwoorden: ant });
  assert.equal(s2.status, 200, JSON.stringify(s2.j));
  mm.n8n('POST /mailman/gedaan', { ronde: r.ronde, postvak: pv });
}
function rij(mm, id) { return mm._db.prepare('SELECT * FROM besluit WHERE gmail_id = ?').get(id); }

test('poortGeldt: alleen Jev-intake (score/hard_*) en twijfel, nooit factuur/regel/draad/markering', () => {
  assert.equal(MM.K.poortGeldt('intake', 'score'), true);
  assert.equal(MM.K.poortGeldt('intake', 'hard_mens'), true);
  assert.equal(MM.K.poortGeldt('twijfel', 'score'), true);
  assert.equal(MM.K.poortGeldt('twijfel', 'marker'), true);
  assert.equal(MM.K.poortGeldt('twijfel', 'factuur_zonder_bijlage'), false);
  for (const r of ['markering', 'draad', 'regel']) assert.equal(MM.K.poortGeldt('intake', r), false);
  assert.equal(MM.K.poortGeldt('factuur', 'score'), false);
  assert.equal(MM.K.poortGeldt('info', 'score'), false);
});

test('stand uit (geen sleutel): twijfel en intake blijven, poort leeg', () => {
  const { mm } = kamer(null);
  const a = mail(), b = mail();
  draai(mm, [a], TWIJFEL); draai(mm, [b], INTAKE);
  assert.equal(rij(mm, a.id).stroom, 'twijfel'); assert.equal(rij(mm, a.id).poort, null);
  assert.equal(rij(mm, b.id).stroom, 'intake'); assert.equal(rij(mm, b.id).poort, null);
});

test('aan zonder verband: twijfel en Jev-intake worden info/geen_verband (OVERIG), poort onthoudt wat het was', () => {
  const { mm } = kamer('aan');
  const a = mail(), b = mail();
  draai(mm, [a], TWIJFEL); draai(mm, [b], INTAKE);
  const ra = rij(mm, a.id), rb = rij(mm, b.id);
  assert.equal(ra.stroom, 'info'); assert.equal(ra.reden, 'geen_verband'); assert.equal(ra.poort, 'tegen:twijfel:score');
  assert.equal(rb.stroom, 'info'); assert.equal(rb.poort, 'tegen:intake:score');
  assert.ok(!JSON.parse(rb.labels_plan).includes('AI/MailMan'));
  const t = mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).intake_poort;
  assert.equal(t.stand, 'aan'); assert.equal(t.tegen_7d, 2); assert.equal(t.fout_7d, 0);
});

test('aan met verband: V2 afzender bekend in Intake, V3 in contacten (hoofdletters maken niet uit)', () => {
  const { mm } = kamer('aan');
  const a = mail({ van: 'Winkel <bekend@winkel.invalid>' }), b = mail({ van: 'Vriend <Vriend@Thuis.invalid>' });
  draai(mm, [a, b], TWIJFEL);
  assert.equal(rij(mm, a.id).stroom, 'twijfel'); assert.equal(rij(mm, a.id).poort, 'v2');
  assert.equal(rij(mm, b.id).stroom, 'twijfel'); assert.equal(rij(mm, b.id).poort, 'v3');
});

test('aan: bron niet te lezen (geen intake.sqlite, contacten nog niet geladen) = oude gedrag, poort fout', () => {
  const { mm } = kamer('aan', { intakeAfzender: function () { return null; }, contactAdressen: function () { return null; } });
  const a = mail();
  draai(mm, [a], INTAKE);
  assert.equal(rij(mm, a.id).stroom, 'intake'); assert.equal(rij(mm, a.id).poort, 'fout');
  const { mm: mm2, fouten } = kamer('aan', { intakeAfzender: function () { throw new Error('kapot'); } });
  const b = mail();
  draai(mm2, [b], INTAKE);
  assert.equal(rij(mm2, b.id).stroom, 'intake'); assert.equal(rij(mm2, b.id).poort, 'fout');
  assert.ok(fouten.some(function (f) { return f.indexOf('mailman-poort-afzender') === 0; }));
});

test('schaduw: niets verandert, poort telt wat tegengehouden zou zijn', () => {
  const { mm } = kamer('schaduw');
  const a = mail();
  draai(mm, [a], TWIJFEL);
  assert.equal(rij(mm, a.id).stroom, 'twijfel'); assert.equal(rij(mm, a.id).poort, 'schaduw:twijfel:score');
  assert.equal(mm.info().postvakken.find(function (p) { return p.id === 'gmail:david'; }).intake_poort.schaduw_7d, 1);
});

test('aan: _AI_, gevolgde draad, factuuralias en Filter In-regel gaan nooit langs de poort', () => {
  const { mm } = kamer('aan');
  const ai = mail({ labels: ['INBOX', '_AI_'] }), dr = mail(), fa = mail({ aan: ALIAS, bijlagen: [{ naam: 'f.pdf', mime: 'application/pdf', grootte: 1000 }] });
  draai(mm, [ai, dr, fa], TWIJFEL, [dr.threadId]);
  assert.equal(rij(mm, ai.id).stroom, 'intake'); assert.equal(rij(mm, ai.id).reden, 'markering'); assert.equal(rij(mm, ai.id).poort, null);
  assert.equal(rij(mm, dr.id).stroom, 'intake'); assert.equal(rij(mm, dr.id).reden, 'draad'); assert.equal(rij(mm, dr.id).poort, null);
  assert.equal(rij(mm, fa.id).stroom, 'factuur'); assert.equal(rij(mm, fa.id).poort, null);
});

test('aan: twijfel zonder Jev (marker/zorgmail) zonder verband → info; met verband blijft hij twijfel', () => {
  const { mm } = kamer('aan');
  const z = mail({ labels: ['INBOX', 'ZORGMAIL'] }), zb = mail({ labels: ['INBOX', 'ZORGMAIL'], van: 'W <bekend@winkel.invalid>' });
  draai(mm, [z, zb], TWIJFEL);
  assert.equal(rij(mm, z.id).stroom, 'info'); assert.equal(rij(mm, z.id).poort, 'tegen:twijfel:zorgmail');
  assert.equal(rij(mm, zb.id).stroom, 'twijfel'); assert.equal(rij(mm, zb.id).poort, 'v2');
});
