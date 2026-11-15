'use strict';
// wv3077 (OVIS Mail fase 1): mail-app.js met een nep-leesluik, nep-MailMan en de echte patiëntpoort. Alle mails verzonnen.
const test = require('node:test');
const assert = require('node:assert/strict');
const MA = require('../mail-app.js');
const poort = require('../intake/patientpoort.js');

const D1 = 'aaaaaaaaaaaa0001', D2 = 'aaaaaaaaaaaa0002', D3 = 'aaaaaaaaaaaa0003', D4 = 'aaaaaaaaaaaa0004', D5 = 'aaaaaaaaaaaa0005';
const KAART = [{ id: 'INBOX', naam: 'INBOX', soort: 'system' }, { id: 'UNREAD', naam: 'UNREAD', soort: 'system' }, { id: 'STARRED', naam: 'STARRED', soort: 'system' },
  { id: 'CATEGORY_UPDATES', naam: 'CATEGORY_UPDATES', soort: 'system' }, { id: 'Label_71', naam: 'FACTUUR', soort: 'user' }, { id: 'Label_72', naam: 'TODO', soort: 'user' },
  { id: 'Label_90', naam: 'AI/Tolgaarde', soort: 'user' }, { id: 'Label_91', naam: 'Vakantie', soort: 'user' }, { id: 'Label_92', naam: 'AI/Nieuwigheid', soort: 'user' },
  { id: 'Label_93', naam: 'Socev-volgt', soort: 'user' }, { id: 'Label_82', naam: 'FACTUUR/In_SEPA', soort: 'user' }];
function g(draad, o) { return Object.assign({ draad, berichten: 1, ids: [draad], van: 'Verzonnen <a@voorbeeld.invalid>', namen: ['Verzonnen'], onderwerp: 'Onderwerp ' + draad.slice(-1), snippet: 'Begin van de tekst', datum: '2026-11-14T10:00:00.000Z', ongelezen: false, bijlage: false, labels: ['INBOX'] }, o || {}); }
function kamer(o) {
  o = o || {};
  const roepen = [], todos = [], bijlagen = [];
  const laag = Object.assign({ [D2]: { laag: 'socev', reden: 'facturen', detail: 'ontvangen', inbox: 'ja', slot: false, app_wacht: null },
    [D3]: { laag: 'jij', reden: 'slotje', inbox: 'ja', slot: true }, [D4]: { laag: 'weg', reden: 'nieuwsbrief', inbox: 'ja', slot: false, zou_weg: true } }, o.laag || {});
  const regel = Object.assign({ aan: true, dag: '2026-11-14', binnen: 5, jij: 2, socev: 1, inbox: 2, buiten: 0, onbekend: 0, laatste_geslaagd: '2026-11-14T10:55:00.000Z' }, o.regel || {});
  const io = {
    nu: function () { return Date.parse('2026-11-14T11:00:00Z'); },
    luik: async function (b) {
      roepen.push(b);
      if (o.luikFout) throw new Error('weg');
      if (b.actie === 'mail_lijst') return o.lijst || { aantal: 5, volgende: 'TOKEN_2', inbox: { totaal: 11, ongelezen: 2, ok: true }, labels: KAART,
        gesprekken: [g(D1, { ongelezen: true, labels: ['INBOX', 'UNREAD', 'Label_72', 'Label_90', 'Label_91', 'Label_92', 'STARRED', 'CATEGORY_UPDATES'] }), g(D2, { labels: ['INBOX', 'Label_71', 'Label_82'] }), g(D3, { snippet: 'iets geheims' }), g(D4), g(D5), { draad: 'kapot', van: 'x' }] };
      if (b.actie === 'mail_gesprek') return o.gesprek ? o.gesprek(b.draad) : { draad: b.draad, aantal: 2, berichten: [
        { id: b.draad, van: 'Verzonnen <a@voorbeeld.invalid>', aan: 'ik@voorbeeld.invalid', onderwerp: 'Re: Vergadering', datum: '2026-11-13T09:00:00Z', labels: [], tekst: 'Eerste bericht.', html: '', bijlagen: [] },
        { id: 'bbbbbbbbbbbb0002', van: 'Verzonnen <a@voorbeeld.invalid>', onderwerp: 'Re: Vergadering', datum: '2026-11-14T09:00:00Z', labels: ['UNREAD', 'INBOX'], tekst: 'Kun je donderdag 19 november?', html: '<p>Kun je <b>donderdag</b>?</p>', bijlagen: [{ naam: 'agenda.pdf', mime: 'application/pdf', grootte: 1000 }] }] };
      throw new Error('onbekend');
    },
    bijlage: async function (b) { bijlagen.push(b); return o.bijlageAntw || { bytes: Buffer.from('%PDF-1.4 proef'), type: 'application/pdf' }; },
    mailman: { mailLaag: function (dr) { const u = {}; dr.forEach(function (x) { if (laag[x]) u[x] = laag[x]; }); return u; }, mailRegel: function () { return regel; } },
    voorwerkLijst: function () { return o.vw || { [D5]: { stand: 'klaar', concept: true, in_gmail: false } }; },
    voorwerkKan: function () { return { [D1]: true }; },
    poort: function (stuk) { return poort.beoordeel(stuk); },
    datums: async function () { return o.treffers || [{ start: '2026-11-10' }, { start: '2026-11-19T00:00:00', rol: 'afspraak' }]; },
    todoist: async function (body) { todos.push(body); return o.todoAntw || { status: 200, j: { id: '9001' } }; },
  };
  return { m: MA.maak(io), roepen, todos, bijlagen };
}

test('vertaalLabels: systeem- en MailMan-labels verborgen, communicatielabels als teken, eigen labels apart, onbekende AI/ nooit ruw', () => {
  const kaart = new Map(KAART.map(function (l) { return [l.id, l.naam]; }));
  const v = MA.vertaalLabels(['INBOX', 'UNREAD', 'Label_72', 'Label_90', 'Label_91', 'Label_92', 'STARRED', 'CATEGORY_UPDATES', 'Label_71'], kaart);
  assert.deepEqual(v.tekens.map(function (t) { return t.tekst; }), ['Actie', 'Tolgaarde']);
  assert.deepEqual(v.eigen, ['Vakantie']);
  assert.equal(v.ster, true);
  assert.deepEqual(MA.vertaalLabels(['Label_93', 'Label_82'], kaart).tekens.map(function (t) { return t.id; }), ['volgt', 'sepa']);
});

test('lijst: volgorde van Gmail, vlakjes uit de laag (één per regel), mogelijk medisch mét begin van de tekst (wv3134), regel en storing, kapotte regel eruit', async () => {
  const { m, roepen } = kamer();
  const r = await m.lijst({ map: 'inbox' });
  assert.equal(r.status, 200);
  assert.deepEqual(roepen[0], { actie: 'mail_lijst', map: 'inbox', q: '', max: 50, pagina: undefined });
  const j = r.j;
  assert.deepEqual(j.gesprekken.map(function (x) { return x.draad; }), [D1, D2, D3, D4, D5]);
  assert.deepEqual(j.gesprekken.map(function (x) { return x.vlak && x.vlak.id; }), ['antwoord', 'facturen', 'medisch', 'kan-weg', 'antwoord-klaar']);
  assert.equal(j.gesprekken[2].snippet, 'iets geheims', 'wv3134: het begin van de tekst blijft staan');
  assert.equal(j.gesprekken[2].slot, true, 'wel het teken: Socevs knoppen uit');
  assert.equal(j.gesprekken[2].vlak.tekst, 'mogelijk medisch');
  assert.equal(j.gesprekken[0].ongelezen, true); assert.equal(j.gesprekken[0].ster, true);
  assert.deepEqual(j.gesprekken[1].tekens.map(function (t) { return t.tekst; }), ['In SEPA']);
  assert.deepEqual(j.eigen_labels, ['Vakantie']);
  assert.equal(j.volgende, 'TOKEN_2');
  assert.deepEqual(j.inbox, { totaal: 11, ongelezen: 2 });
  assert.equal(j.regel.binnen, 5);
  assert.equal(j.storing.mailman, false);
  const z = await m.lijst({ map: 'alle', q: 'from:verzonnen', pagina: 'TOKEN_2' });
  assert.equal(z.j.regel, null, 'de regel alleen bij de inbox zelf');
  assert.deepEqual(roepen[1], { actie: 'mail_lijst', map: 'alle', q: 'from:verzonnen', max: 50, pagina: 'TOKEN_2' });
});

test('lijst: oranje bij een gemiste ronde (geel vlakje voor wat MailMan niet kent), 502 bij een onbereikbaar luik, invoer getoetst', async () => {
  const oud = kamer({ regel: { laatste_geslaagd: '2026-11-14T09:30:00.000Z' } });
  const r = await oud.m.lijst({});
  assert.equal(r.j.storing.mailman, true);
  assert.equal(r.j.gesprekken.find(function (x) { return x.draad === D1; }).vlak.id, 'antwoord');
  const zonder = kamer({ regel: { laatste_geslaagd: '2026-11-14T09:30:00.000Z' }, laag: {} , vw: {} });
  const r2 = await zonder.m.lijst({});
  assert.equal(r2.j.gesprekken.find(function (x) { return x.draad === D5; }).vlak.id, 'ongelezen-socev');
  const weg = kamer({ luikFout: true });
  const f = await weg.m.lijst({});
  assert.equal(f.status, 502); assert.equal(f.j.luik, false);
  const leeg = kamer({ lijst: { melding: 'fout bij lijst: x', gesprekken: [] } });
  assert.equal((await leeg.m.lijst({})).status, 502);
  assert.equal((await weg.m.lijst({ map: 'prullenbak' })).status, 400);
  assert.equal((await weg.m.lijst({ q: 'a\nb' })).status, 400);
  assert.equal((await weg.m.lijst({ q: 'x'.repeat(501) })).status, 400);
  assert.equal((await weg.m.lijst({ pagina: '../x' })).status, 400);
});

test('gesprek: alle berichten; wv3134: ook mogelijk medisch (MailMan of de poort) volledig, met slot als teken', async () => {
  const { m, roepen } = kamer();
  const r = await m.gesprek({ draad: D1 });
  assert.equal(r.status, 200);
  assert.equal(r.j.berichten.length, 2);
  assert.equal(r.j.berichten[1].ongelezen, true);
  assert.equal(r.j.berichten[1].bijlagen[0].naam, 'agenda.pdf');
  assert.equal(r.j.link, 'https://mail.google.com/mail/u/0/#all/' + D1);
  assert.equal(r.j.slot, false);
  const s = await m.gesprek({ draad: D3 });
  assert.equal(s.status, 200); assert.equal(s.j.slot, true); assert.equal(s.j.vlak.id, 'medisch');
  assert.equal(s.j.berichten[1].tekst, 'Kun je donderdag 19 november?', 'MailMans slotje: de tekst komt gewoon op Davids scherm');
  assert.equal(roepen.filter(function (b) { return b.actie === 'mail_gesprek' && b.draad === D3; }).length, 1);
  const pat = kamer({ gesprek: function (d) { return { draad: d, aantal: 1, berichten: [{ id: d, van: 'x', onderwerp: 'Betreft: mw. Proef', labels: [], tekst: 'Geachte collega, bovengenoemde patiënt zagen wij op de polikliniek. Geboortedatum: 01-02-1950. Diagnose en behandelplan volgen.', bijlagen: [] }] }; } });
  const p = await pat.m.gesprek({ draad: D1 });
  assert.equal(p.status, 200); assert.equal(p.j.slot, true); assert.ok(JSON.stringify(p.j).includes('polikliniek'), 'poort slaat aan: toch volledig');
  const kapot = MA.maak({ nu: Date.now, fout: function () {}, luik: async function (b) { return { draad: b.draad, aantal: 1, berichten: [{ id: b.draad, van: 'x', onderwerp: 'y', labels: [], tekst: 'z', bijlagen: [] }] }; },
    mailman: { mailLaag: function () { return {}; } }, poort: function () { throw new Error('poort stuk'); } });
  const k = await kapot.gesprek({ draad: D1 });
  assert.equal(k.status, 200); assert.equal(k.j.slot, true, 'poort faalt: tonen wel, handelingen uit');
  const ander = kamer({ gesprek: function () { return { draad: D2, berichten: [] }; } });
  assert.equal((await ander.m.gesprek({ draad: D1 })).status, 502, 'ander gesprek terug = geen gesprek');
  assert.equal((await m.gesprek({ draad: 'xyz' })).status, 400);
});

test('bijlage: base64 naar de App, ook bij mogelijk medisch (wv3134), te groot = Open in Gmail', async () => {
  const { m } = kamer();
  const r = await m.bijlage({ draad: D1, bericht: 'bbbbbbbbbbbb0002', naam: 'agenda.pdf' });
  assert.equal(r.status, 200); assert.equal(Buffer.from(r.j.inhoud, 'base64').toString(), '%PDF-1.4 proef'); assert.equal(r.j.type, 'application/pdf');
  assert.equal((await m.bijlage({ draad: D3, bericht: 'bbbbbbbbbbbb0002', naam: 'agenda.pdf' })).status, 200, 'MailMans slotje: bijlage gewoon naar Davids scherm');
  assert.equal((await m.bijlage({ draad: D1, bericht: 'zz', naam: 'x.pdf' })).status, 400);
  const groot = kamer({ bijlageAntw: { bytes: Buffer.alloc(16 * 1024 * 1024), type: 'application/pdf' } });
  assert.equal((await groot.m.bijlage({ draad: D1, bericht: 'bbbbbbbbbbbb0002', naam: 'agenda.pdf' })).status, 413);
  const json = kamer({ bijlageAntw: { json: { fout: 'bijlage niet gevonden' } } });
  assert.equal((await json.m.bijlage({ draad: D1, bericht: 'bbbbbbbbbbbb0002', naam: 'agenda.pdf' })).status, 502);
});

// review wv3077 (Codex NO-GO): MOET 1 poort op alles wat de App toont, MOET 2 bijlage alleen uit een getoetst gesprek van dezelfde draad,
// MOET 3 todo langs dezelfde actuele gesprekscontrole. Verzonnen toetstekst.
const PAT = 'Geachte collega, bovengenoemde patiënt zagen wij op de polikliniek. Geboortedatum: 01-02-1950. Diagnose en behandelplan volgen.';
function patKamer(waar) {
  return kamer({ gesprek: function (d) { return { draad: d, aantal: 2, berichten: [
    { id: d, van: 'x <x@voorbeeld.invalid>', onderwerp: 'Overleg', labels: [], tekst: 'Gewone tekst.', html: '', bijlagen: [] },
    { id: 'bbbbbbbbbbbb0002', van: 'x <x@voorbeeld.invalid>', onderwerp: waar === 'onderwerp' ? 'Betreft patiënt, geboortedatum 01-02-1950, diagnose' : 'Re: Overleg', labels: [], tekst: 'Schone platte tekst.',
      html: waar === 'html' ? '<p>' + PAT + '</p>' : '', bijlagen: [{ naam: 'verslag.pdf', mime: 'application/pdf', grootte: 10 }] }] }; } });
}
test('review MOET 1: de poort ziet ook de html naast schone platte tekst, en latere onderwerpen (sinds wv3134: slot als teken, inhoud blijft)', async () => {
  for (const waar of ['html', 'onderwerp']) {
    const r = await patKamer(waar).m.gesprek({ draad: D1 });
    assert.equal(r.status, 200, waar); assert.equal(r.j.slot, true, waar);
  }
  assert.equal((await patKamer('geen').m.gesprek({ draad: D1 })).j.slot, false, 'kruiscontrole: zonder patiënttekst geen teken');
});
test('review MOET 2: bijlage alleen als bericht en naam bij de draad horen; wv3134: ook als de poort aanslaat', async () => {
  const { m } = kamer();
  assert.equal((await m.bijlage({ draad: D1, bericht: 'cccccccccccc0003', naam: 'agenda.pdf' })).status, 404, 'bericht uit een ander gesprek');
  assert.equal((await m.bijlage({ draad: D1, bericht: 'bbbbbbbbbbbb0002', naam: 'ander.pdf' })).status, 404, 'naam hoort niet bij het bericht');
  const p = patKamer('html');
  const r = await p.m.bijlage({ draad: D1, bericht: 'bbbbbbbbbbbb0002', naam: 'verslag.pdf' });
  assert.equal(r.status, 200);
  assert.equal(p.bijlagen.length, 1);
});
test('review MOET 3: geen todo voor een gesprek waar de poort nu aanslaat (ook zonder slot bij MailMan)', async () => {
  const p = patKamer('html');
  const r = await p.m.todo({ draad: D1, titel: 'Overleg voorbereiden' });
  assert.equal(r.status, 409); assert.equal(r.j.slot, true); assert.equal(p.todos.length, 0);
  const v = await p.m.todoVoorstel({ draad: D1 });
  assert.equal(v.status, 409, 'wv3134: ook geen voorstel (de todo gaat naar Todoist)');
  const weg = kamer({ luikFout: true });
  assert.equal((await weg.m.todo({ draad: D1, titel: 'x' })).status, 502); assert.equal(weg.todos.length, 0);
});

test('todo: voorstel met onderwerp zonder Re: en eerste datum vanaf vandaag; taak alleen op tik, nooit bij slotje of patiënttitel; rechtenfout gemeld', async () => {
  const { m, todos } = kamer();
  const v = await m.todoVoorstel({ draad: D1 });
  assert.deepEqual([v.j.titel, v.j.datum], ['Vergadering', '2026-11-19']);
  const t = await m.todo({ draad: D1, titel: 'Vergadering voorbereiden', datum: '2026-11-19' });
  assert.equal(t.status, 200);
  assert.deepEqual(todos[0], { content: 'Vergadering voorbereiden', description: 'Uit OVIS Mail: https://mail.google.com/mail/u/0/#all/' + D1, due_date: '2026-11-19' });
  assert.equal((await m.todo({ draad: D3, titel: 'x' })).status, 409);
  assert.equal((await m.todo({ draad: D1, titel: 'Bel mw. Proef, geboortedatum 01-02-1950, over de diagnose' })).status, 409);
  assert.equal((await m.todo({ draad: D1, titel: '' })).status, 400);
  assert.equal((await m.todo({ draad: D1, titel: 'x', datum: 'morgen' })).status, 400);
  assert.equal(todos.length, 1);
  const dicht = kamer({ todoAntw: { status: 403, j: null } });
  const r = await dicht.m.todo({ draad: D1, titel: 'x' });
  assert.equal(r.status, 502); assert.equal(r.j.rechten, true);
});

test('kiesDatum: geen datum in het verleden, geen geboortedatum-rol', () => {
  assert.equal(MA.kiesDatum([{ start: '2026-11-01' }], '2026-11-14'), null);
  assert.equal(MA.kiesDatum([{ start: '2026-12-01', rol: 'geboortedatum' }, { start: '2026-12-02' }], '2026-11-14'), '2026-12-02');
});
