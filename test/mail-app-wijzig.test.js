'use strict';
// wv3090 (OVIS Mail fase 1b): wijzig in mail-app.js met een nep-leesluik en nep-MailMan. Alle gesprekken verzonnen.
const test = require('node:test');
const assert = require('node:assert/strict');
const MA = require('../mail-app.js');

const D1 = 'cccccccccccc0001', D2 = 'cccccccccccc0002', SLOT = 'cccccccccccc0003';
const IDS = { INTAKE: 'Label_77', FACTUUR: 'Label_71', NIEUWSBRIEF: 'Label_79', SOCIAAL: 'Label_78', OVERIG: 'Label_74', TWIJFEL: 'Label_80', TODO: 'Label_72', ACTIE_DS: 'Label_76', 'AI/MailMan': 'Label_73' };
function kamer(o) {
  o = o || {};
  const roepen = [], tikken = [], passen = [];
  const io = {
    luik: async function (b) {
      roepen.push(b);
      if (o.luikFout) throw new Error('weg');
      if (b.actie === 'mail_gesprek') {
        if (o.gesprekWeg && o.gesprekWeg.includes(b.draad)) return { fout: 'weg' };
        return { draad: b.draad, aantal: 1, berichten: [{ id: b.draad, van: 'Verzonnen <a@voorbeeld.invalid>', aan: 'ik@voorbeeld.invalid', onderwerp: 'Proef', datum: '2026-11-14T09:00:00Z', labels: ['INBOX'],
          tekst: (o.poortRaak || []).includes(b.draad) ? 'RAAK-PATIENT' : 'Gewone verzonnen tekst.', html: '', bijlagen: [] }] };
      }
      if (b.actie !== 'mail_wijzig') throw new Error('onbekend');
      if (o.weiger && o.weiger.includes(b.draad)) return { ok: false, fout: 'geweigerd' };
      return { ok: true, draad: b.draad, labels: ['INBOX'] };
    },
    mailman: { mailLaag: function (dr) { const u = {}; dr.forEach(function (x) { if (x === SLOT) u[x] = { slot: true }; }); return u; }, mailTik: function (t, w) { tikken.push([t, w]); return true; } },
    labelIds: function () { return o.ids === undefined ? IDS : o.ids; },
    toestemming: function () { return o.register !== false; },
    pas: function (x) { passen.push(x); return 'ab'.repeat(16); },
    poort: function (stuk) { return { tegenhouden: stuk.teksten.some(function (t) { return /RAAK-PATIENT/.test(t); }) }; },
  };
  return { m: MA.maak(io), roepen, tikken, passen };
}

test('wijzig: elke handeling = precies de vaste labelverandering, met een pas per gesprek; terug = de tegenhanger', async () => {
  const verwacht = { archiveer: [[], ['INBOX'], 'terug'], terug: [['INBOX'], [], 'archiveer'], gelezen: [[], ['UNREAD'], 'ongelezen'], ongelezen: [['UNREAD'], [], 'gelezen'],
    ster: [['STARRED'], [], 'geen_ster'], geen_ster: [[], ['STARRED'], 'ster'] };
  for (const wat of Object.keys(verwacht)) {
    const { m, roepen, passen } = kamer();
    const r = await m.wijzig({ draden: [D1, D2, D1], wat });
    assert.equal(r.status, 200, wat);
    assert.deepEqual(roepen.map(function (x) { return [x.actie, x.draad, x.erbij, x.eraf, x.pas]; }), [D1, D2].map(function (d) { return ['mail_wijzig', d, verwacht[wat][0], verwacht[wat][1], 'ab'.repeat(16)]; }), wat + ': dubbel gesprek één keer');
    assert.deepEqual(passen.map(function (p) { return p.draad; }), [D1, D2]);
    assert.equal(r.j.tegen, verwacht[wat][2]);
  }
});

test('wijzig label: alleen de acht namen van MailMan (ID uit labelset2), nooit AI/MailMan, TRASH, SPAM, INBOX als label of een ruw ID', async () => {
  const { m, roepen: alle } = kamer();
  const roepen = { get length() { return alle.filter(function (x) { return x.actie === 'mail_wijzig'; }).length; } };
  const w = function (i) { return alle.filter(function (x) { return x.actie === 'mail_wijzig'; })[i]; };
  let r = await m.wijzig({ draad: D1, wat: 'label_erbij', label: 'TODO' });
  assert.equal(r.status, 200); assert.deepEqual([w(0).erbij, w(0).eraf], [['Label_72'], []]);
  assert.equal(r.j.tegen, 'label_eraf'); assert.equal(r.j.label, 'TODO');
  r = await m.wijzig({ draad: D1, wat: 'label_eraf', label: 'ACTIE_DS' });
  assert.equal(r.status, 200); assert.deepEqual([w(1).erbij, w(1).eraf], [[], ['Label_76']]);
  for (const label of ['AI/MailMan', 'TRASH', 'SPAM', 'INBOX', 'Label_72', 'todo', '', undefined, 'CONCEPT_KLAAR']) {
    const x = await m.wijzig({ draad: D1, wat: 'label_erbij', label });
    assert.equal(x.status, 400, String(label));
  }
  assert.equal(roepen.length, 2, 'geweigerd = geen luik-aanroep');
  for (const wat of ['verwijder', 'trash', 'spam', 'stuur', '', 'constructor', '__proto__', 'toString']) assert.equal((await m.wijzig({ draad: D1, wat })).status, 400, wat);
  // erbij/eraf/labelIds van de aanroeper tellen niet: alleen wat
  const k2 = kamer(); await k2.m.wijzig({ draad: D1, wat: 'archiveer', erbij: ['TRASH'], eraf: ['SPAM'], label: 'TODO' });
  assert.deepEqual([k2.roepen[0].erbij, k2.roepen[0].eraf], [[], ['INBOX']]);
  // labelset kapot of onbekend ID: niets
  const k3 = kamer({ ids: { TODO: 'TRASH' } }); assert.equal((await k3.m.wijzig({ draad: D1, wat: 'label_erbij', label: 'TODO' })).status, 409); assert.equal(k3.roepen.length, 0);
  const k4 = kamer({ ids: null }); assert.equal((await k4.m.wijzig({ draad: D1, wat: 'label_erbij', label: 'TODO' })).status, 409);
});

test('wijzig: zonder registerrij niets in Gmail (409 met link naar Gmail); slotje weigert een label maar archiveren mag', async () => {
  const k = kamer({ register: false });
  const r = await k.m.wijzig({ draad: D1, wat: 'archiveer' });
  assert.equal(r.status, 409); assert.equal(r.j.register, false); assert.ok(/mail\.google\.com/.test(r.j.link)); assert.equal(k.roepen.length, 0);
  const s = kamer();
  assert.equal((await s.m.wijzig({ draden: [D1, SLOT], wat: 'label_erbij', label: 'FACTUUR' })).status, 409);
  assert.equal(s.roepen.filter(function (x) { return x.actie === 'mail_wijzig'; }).length, 0, 'slotje: ook het andere gesprek niet (alles of niets bij een label)');
  // review MOET 2: de patiëntpoort slaat nu aan (MailMan kent geen slot) → geen label; Gmail gaf het gesprek niet → niets (onzeker)
  const pr = kamer({ poortRaak: [D2] });
  assert.equal((await pr.m.wijzig({ draden: [D1, D2], wat: 'label_erbij', label: 'TODO' })).status, 409);
  assert.equal(pr.roepen.filter(function (x) { return x.actie === 'mail_wijzig'; }).length, 0);
  assert.equal((await pr.m.wijzig({ draad: D2, wat: 'archiveer' })).status, 200, 'archiveren leest niets en mag');
  const gw = kamer({ gesprekWeg: [D1] });
  assert.equal((await gw.m.wijzig({ draad: D1, wat: 'label_eraf', label: 'TODO' })).status, 502);
  assert.equal(gw.roepen.filter(function (x) { return x.actie === 'mail_wijzig'; }).length, 0);
  assert.equal((await s.m.wijzig({ draad: SLOT, wat: 'archiveer' })).status, 200);
  assert.equal((await s.m.wijzig({ draad: SLOT, wat: 'gelezen' })).status, 200);
});

test('wijzig: grenzen op invoer (vorm draad, 1–20 gesprekken) en de uitkomst per gesprek; MailMan alleen bij archiveren/terug en alleen bij gelukt', async () => {
  const { m, roepen } = kamer();
  assert.equal((await m.wijzig({ draad: 'xyz', wat: 'archiveer' })).status, 400);
  assert.equal((await m.wijzig({ draden: [], wat: 'archiveer' })).status, 400);
  assert.equal((await m.wijzig({ draden: [D1, '../x'], wat: 'archiveer' })).status, 400);
  const veel = []; for (let i = 0; i < 21; i++) veel.push('dddddddddddd' + String(1000 + i));
  assert.equal((await m.wijzig({ draden: veel, wat: 'archiveer' })).status, 400);
  assert.equal(roepen.length, 0);
  const k = kamer({ weiger: [D2] });   // (archiveren: geen gespreksvraag vooraf)
  const r = await k.m.wijzig({ draden: [D1, D2], wat: 'archiveer' });
  assert.equal(r.status, 200); assert.deepEqual(r.j.gedaan, [D1]); assert.deepEqual(r.j.mislukt, [D2]);
  assert.deepEqual(k.tikken, [[D1, 'archiveer']]);
  const k2 = kamer(); await k2.m.wijzig({ draad: D1, wat: 'ster' }); assert.deepEqual(k2.tikken, [], 'ster raakt het zaakregister niet');
  const k3 = kamer({ luikFout: true }); const r3 = await k3.m.wijzig({ draad: D1, wat: 'terug' });
  assert.equal(r3.status, 502); assert.deepEqual(k3.tikken, []);
  // een luik-antwoord voor een ander gesprek telt niet als gelukt
  const k5 = kamer(); k5.m = MA.maak(Object.assign({}, { luik: async function () { return { ok: true, draad: D2 }; }, mailman: { mailLaag: function () { return {}; }, mailTik: function () { throw new Error('mag niet'); } },
    labelIds: function () { return IDS; }, toestemming: function () { return true; }, pas: function () { return 'ab'.repeat(16); } }));
  assert.equal((await k5.m.wijzig({ draad: D1, wat: 'archiveer' })).status, 502);
});

test('passen: eenmalig, 60 s, alleen precies dezelfde handeling; onbekende of kapotte pas = nee', () => {
  let klok = 1000000, teller = 0;
  const P = MA.passen({ nu: function () { return klok; }, toeval: function () { teller++; return ('0' + teller.toString(16)).slice(-2).repeat(16); } });
  const h = { draad: D1, erbij: [], eraf: ['INBOX'] };
  const p1 = P.maak(h);
  assert.equal(P.toets(Object.assign({ pas: p1 }, h)).j.ok, true);
  assert.equal(P.toets(Object.assign({ pas: p1 }, h)).j.ok, false, 'tweede keer: op');
  const p2 = P.maak(h);
  assert.equal(P.toets({ pas: p2, draad: D1, erbij: ['INBOX'], eraf: [] }).j.ok, false, 'andere handeling');
  assert.equal(P.toets(Object.assign({ pas: p2 }, h)).j.ok, false, 'ook na een nee is de pas op');
  const p3 = P.maak({ draad: D1, erbij: ['UNREAD', 'STARRED'], eraf: [] });
  assert.equal(P.toets({ pas: p3, draad: D1, erbij: ['STARRED', 'UNREAD'], eraf: [] }).j.ok, true, 'volgorde telt niet');
  const p4 = P.maak(h); klok += 60001;
  assert.equal(P.toets(Object.assign({ pas: p4 }, h)).j.ok, false, 'verlopen');
  const p5 = P.maak(h);
  assert.equal(P.toets(Object.assign({ pas: p5 }, h, { draad: D2 })).j.ok, false, 'ander gesprek');
  for (const pas of [undefined, '', 'x'.repeat(32), p5.toUpperCase(), 'ab'.repeat(17)]) assert.equal(P.toets(Object.assign({ pas }, h)).j.ok, false);
  assert.throws(function () { MA.passen({ nu: Date.now, toeval: function () { return 'kort'; } }).maak(h); });
});

test('schoonLijst: vast = de labels uit de vaste lijst die op het gesprek staan (voor het labelmenu), op naam via de labelkaart', () => {
  const j = { labels: [{ id: 'Label_72', naam: 'TODO' }, { id: 'Label_71', naam: 'FACTUUR' }, { id: 'Label_73', naam: 'AI/MailMan' }, { id: 'Label_91', naam: 'Vakantie' }],
    gesprekken: [{ draad: D1, labels: ['INBOX', 'Label_72', 'Label_73', 'Label_91'] }, { draad: D2, labels: ['INBOX'] }] };
  const s = MA.schoonLijst(j);
  assert.deepEqual(s.regels.map(function (r) { return r.vast; }), [['TODO'], []]);
});
