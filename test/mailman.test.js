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
    'gmail:david': { naam: 'Privé', factuur_alias: ALIAS, stand: 'schaduw' },
    'gmail:groenhouten': { naam: 'Doktersmaten', factuur_alias: 'facturen@praktijk.invalid', stand: 'schaduw', jev: false, tekst: false },
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

test('#1 patiëntpoort vóór Jev: gemarkeerde mail niet naar Jev, onderwerp niet in het logboek', () => {
  const { mm } = nieuweKamer();
  const pat = mail({ onderwerp: 'Betreft: mw. Proef', tekst: 'Geachte collega, bovengenoemde patiënt zagen wij op de polikliniek. Geboortedatum: 01-02-1950. Diagnose en behandelplan volgen.' });
  const gewoon = mail({ onderwerp: 'Vraag over het overleg' });
  const u = draai(mm, 'gmail:david', [pat, gewoon], { jev: function () { return jevAntwoord({ mens: 0.9, waarde: 2.5 }); } });
  assert.deepEqual(u.s1.j.jev.map(function (a) { return a.gmail_id; }), [gewoon.id]);
  const b = rij(mm, pat.id);
  assert.equal(b.marker, 1);
  assert.equal(b.onderwerp, null);
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

test('#1 doktersmaten: geen Jev, geen tekst, geen onderwerp in het logboek; factuuradres → Factuur (schaduw)', () => {
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
  assert.equal(rij(mm, g.id).onderwerp, null);
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
  for (const slecht of ['(a+)+$', '(a|aa)*', '([a-z]+)*x', '(x)\\1', '(?<n>a)\\k<n>', 'a'.repeat(201), '((ab)*)+', '(', '[']) assert.equal(K.veiligeRegex(slecht).ok, false, slecht);
  for (const goed of ['^\\[[a-z/]+\\] run failed', 'factuur|nota', '(nieuwsbrief) oktober', '\\d{4}-\\d{2}', '(abc)?x']) assert.equal(K.veiligeRegex(goed).ok, true, goed);
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

// #6 (koerier-venster en koerier_query), #8 (MailMan-labels uit labelHint van de Mail Processor) en #10 (metadata bij het lezen in
// Intake) horen bij B5/B6: in deze stap verandert er niets aan de koerier, de Mail Processor of de Intake-router.
