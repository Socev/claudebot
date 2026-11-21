'use strict';
// wv3758 (besluitenpagina nr 912 = L12): Beleggen zonder huiswerk — aankopen uit de DEGIRO-mail, ochtendvraag, stortingen uit de bank,
// kwartaalcontrole. Alleen VERZONNEN gegevens (geen echte namen, ISIN's, order-id's of bedragen). De mailvorm volgt de echte bevestiging
// (gemeten 21-11, alleen de vorm): "Sleutel waarde"-reeks na "De volgende order is uitgevoerd:".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const B = require('../beleggen.js');
const M = require('../beleggen-mail.js');

function mail(o) {
  o = Object.assign({ naam: 'Voorbeeld Chips Corp', order: 'bbbb0000-0000-0000-0000-000000000001', dag: '13 nov 2026', tijd: '15:31:07', isin: 'XX0000000011',
    opdracht: 'Koop', aantal: '3', koers: 'USD 100,0000', lokaal: 'USD -300,00', waarde: '-276,50', wk: '1,0850', autofx: '-0,69', kosten: '-2,00', totaal: '-279,19' }, o);
  const tekst = 'Wereldwijd beleggen tegen ongekend lage tarieven\nDEGIRO [https://www.degiro.nl/]\nGeachte heer Voorbeeld,\nDe volgende order is uitgevoerd:\n' + o.naam + '\n' +
    'OrderID ' + o.order + ' Transactiedatum ' + o.dag + ',\n' + o.tijd + ' ISIN ' + o.isin + ' Opdracht ' + o.opdracht + ' Type Market Order Beurs NDQ\n' +
    'Handelsplaats CDED Aantal ' + o.aantal + ' Koers ' + o.koers + ' Lokale waarde ' + o.lokaal + ' Waarde\nEUR ' + o.waarde + ' Wisselkoers ' + o.wk +
    ' AutoFX kosten EUR ' + o.autofx + ' Transactiekosten en/of\nkosten van derden EUR ' + o.kosten + ' Totale Kosten EUR -2,69 Totaal EUR ' + o.totaal + '\n' +
    'Wilt u de transactiebevestigingen niet meer ontvangen? Log dan in op uw account\nHEEFT U VRAGEN?\n';
  return { onderwerp: 'DEGIRO - Transactiebevestiging: ' + o.opdracht + ' ' + o.aantal + ' ' + o.naam + ' @ 100', van: 'DEGIRO <noreply@degiro.nl>', tekst };
}
const MAIL2 = () => mail({ naam: 'Voorbeeld Wereld ETF', order: 'bbbb0000-0000-0000-0000-000000000002', isin: 'XX0000000022', dag: '14 nov 2026', tijd: '09:05:00',
  aantal: '10', koers: 'EUR 80,0000', lokaal: 'EUR -800,00', waarde: '-800,00', wk: '', autofx: '', kosten: '-1,00', totaal: '-801,00' });
// de export die DEGIRO later geeft (zelfde orders, productnaam in hoofdletters, tijd hh:mm)
const EXPORT = 'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde EUR,Wisselkoers,AutoFX Kosten,Transactiekosten en/of kosten van derden EUR,Totaal EUR,Order ID\n' +
  '13-11-2026,15:31,VOORBEELD CHIPS CORP,XX0000000011,NDQ,CDED,3,"100,0000",USD,"-300,00",USD,"-276,50","1,0850","-0,69","-2,00","-279,19",bbbb0000-0000-0000-0000-000000000001\n' +
  '14-11-2026,09:05,VOORBEELD WERELD ETF,XX0000000022,EAM,XAMS,10,"80,0000",EUR,"-800,00",EUR,"-800,00",,,"-1,00","-801,00",bbbb0000-0000-0000-0000-000000000002\n';

function nieuweApp(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-mail-'));
  return B.maak(Object.assign({ dbPad: path.join(dir, 'beleggen.sqlite'), vandaag: () => '2026-11-15' }, extra || {}));
}
function nepLuik(mails) {
  const n = { zoek: 0, lees: 0, queries: [] };
  const f = async (b) => {
    if (b.actie === 'mail_zoeken') { n.zoek++; n.queries.push(b.query); return { mails: mails.map((m, i) => ({ id: m.id || 'g' + i, onderwerp: m.onderwerp, van: m.van, datum: '2026-11-13T15:32:00Z' })) }; }
    if (b.actie === 'mail_lezen') { n.lees++; const m = mails.find((x, i) => (x.id || 'g' + i) === b.id); return m ? { id: b.id, datum: '2026-11-13T15:32:00Z', onderwerp: m.onderwerp, van: m.van, tekst: m.tekst } : { fout: 'weg' }; }
    throw new Error('onbekende actie');
  };
  f.n = n;
  return f;
}
const klok = (datum, uur) => () => ({ datum, uur, min: 0 });

test('mailNaarCsv: velden en dezelfde sleutel als de export', () => {
  const c = M.mailNaarCsv(mail());
  const l = B.leesBestand(c.csv);
  assert.strictEqual(l.soort, 'transacties');
  const r = l.rijen[0], e = B.leesBestand(EXPORT).rijen[0];
  assert.strictEqual(r.sleutel, e.sleutel);
  for (const k of ['datum', 'tijd', 'isin', 'aantal', 'koers', 'valuta', 'lokaal_cent', 'waarde_eur_cent', 'wisselkoers', 'kosten_eur_cent', 'autofx_eur_cent', 'totaal_eur_cent', 'order_id']) assert.strictEqual(String(r[k]), String(e[k]), k);
  assert.strictEqual(c.datum, '2026-11-13');
  // euro zonder wisselkoers en AutoFX
  assert.strictEqual(B.leesBestand(M.mailNaarCsv(MAIL2()).csv).rijen[0].sleutel, B.leesBestand(EXPORT).rijen[1].sleutel);
});

test('mailNaarCsv: verkoop = negatief aantal; vreemde mail of afzender = MailFout', () => {
  const v = mail({ opdracht: 'Verkoop', order: 'bbbb0000-0000-0000-0000-000000000009', lokaal: 'USD 300,00', waarde: '276,50', autofx: '-0,69', kosten: '-2,00', totaal: '273,81' });
  const r = B.leesBestand(M.mailNaarCsv(v).csv).rijen[0];
  assert.strictEqual(r.aantal, '-3');
  assert.throws(() => M.mailNaarCsv(Object.assign(mail(), { van: 'DEGIRO <noreply@degiro.nl.voorbeeld.net>' })), (e) => e instanceof M.MailFout && e.reden === 'afzender');
  assert.throws(() => M.mailNaarCsv(Object.assign(mail(), { onderwerp: 'Mis je context als je belegt?' })), (e) => e.reden === 'onderwerp');
  assert.throws(() => M.mailNaarCsv(Object.assign(mail(), { tekst: mail().tekst.replace(/ Koers USD 100,0000/, '') })), (e) => e.reden === 'koers');
  // tekst die niet optelt: de mail wordt CSV, de bestaande lezer weigert (aantal × koers ≠ lokale waarde)
  assert.throws(() => B.leesBestand(M.mailNaarCsv(mail({ aantal: '4' })).csv), /aantal × koers/);
});

test('mailronde: twee mails → twee transacties; tweede ronde en dezelfde mail opnieuw → niets dubbel; export erna = al bekend', async () => {
  const app = nieuweApp();
  const luik = nepLuik([mail(), MAIL2()]);
  const R = M.maak({ beleggen: app, luik, klok: klok('2026-11-15', 10), bericht: async () => ({ ok: true }) });
  const u = await R.mailRonde();
  assert.deepStrictEqual([u.ok, u.nieuw, u.bekend, u.fout], [true, 2, 0, 0]);
  let o = app.app({ pad: '/app/beleggen', methode: 'GET' }).body;
  assert.strictEqual(o.transacties.length, 2);
  assert.strictEqual(o.uit_mail.aantal, 2);
  assert.strictEqual(o.exports.transacties, null, 'een mail is geen export in het vak "Je bestanden uit DEGIRO"');
  assert.ok(o.bestanden.every((b) => !String(b.naam).startsWith('mail:')));
  assert.ok(o.open_punten.some((p) => p.soort === 'dagboek'), 'dagboekpunt na een aankoop uit de mail');
  // zelfde ronde opnieuw: mails al gezien, niet opnieuw gelezen
  const voor = luik.n.lees;
  const u2 = await R.mailRonde();
  assert.strictEqual(u2.nieuw, 0); assert.strictEqual(luik.n.lees, voor);
  // dezelfde transactie in een tweede mail (DEGIRO stuurt hem nog eens): al bekend
  const R2 = M.maak({ beleggen: app, luik: nepLuik([Object.assign(mail(), { id: 'ander' })]), klok: klok('2026-11-15', 11), bericht: async () => ({ ok: true }) });
  const u3 = await R2.mailRonde();
  assert.deepStrictEqual([u3.nieuw, u3.bekend], [0, 1]);
  // de export later: alles al bekend, geen dubbel; AutoFX uit de mail telt in de kosten
  const ex = app.app({ pad: '/app/beleggen/bestand', methode: 'POST', body: { naam: 'Transactions.csv', tekst: EXPORT, bewaar: true } });
  assert.strictEqual(ex.body.nieuw, 0);
  o = app.app({ pad: '/app/beleggen', methode: 'GET' }).body;
  assert.strictEqual(o.transacties.length, 2);
  assert.strictEqual(o.geld.kosten_valuta_cent, 69);
  assert.ok(!o.signalen.some((s) => s.soort === 'mail'), 'export bevestigt de mail: geen verschil');
});

test('onleesbare mail → fout + signaal, geen transactie; luikmelding → geen stempel', async () => {
  const app = nieuweApp();
  const kapot = Object.assign(mail(), { tekst: 'De volgende order is uitgevoerd: Voorbeeld OrderID bbbb0000-0000-0000-0000-000000000001 iets anders' });
  const R = M.maak({ beleggen: app, luik: nepLuik([kapot]), klok: klok('2026-11-15', 10), bericht: async () => ({ ok: true }) });
  const u = await R.mailRonde();
  assert.strictEqual(u.fout, 1);
  const o = app.app({ pad: '/app/beleggen', methode: 'GET' }).body;
  assert.strictEqual(o.transacties.length, 0);
  assert.ok(o.signalen.some((s) => s.soort === 'mail' && /kon ik niet lezen/.test(s.titel)));
  assert.strictEqual(R.info().fout, 1);
  // lees-luik met melding: ronde niet geslaagd, geen datumstempel
  const app2 = nieuweApp();
  const R2 = M.maak({ beleggen: app2, luik: async () => ({ mails: [], melding: 'fout bij zoeken' }), klok: klok('2026-11-15', 10) });
  assert.strictEqual((await R2.mailRonde()).ok, false);
  assert.strictEqual(R2.info().ronde_op, null);
});

test('vol venster (25): per dag opnieuw zoeken; vol dagvenster = geen stempel (review MOET 1)', async () => {
  const app = nieuweApp();
  const vijfentwintig = Array.from({ length: 25 }, (x, i) => ({ id: 'n' + i, onderwerp: 'Iets anders', van: 'x@voorbeeld.nl' }));
  let dagvragen = 0;
  const luik = async (b) => { if (b.actie !== 'mail_zoeken') return { fout: 'x' }; if (/before:/.test(b.query)) { dagvragen++; return { mails: dagvragen === 3 ? vijfentwintig : [] }; } return { mails: vijfentwintig }; };
  const R = M.maak({ beleggen: app, luik, klok: klok('2026-11-15', 10) });
  const u = await R.mailRonde();
  assert.ok(dagvragen > 20, 'per dag gezocht');
  assert.strictEqual(u.vol, 1);
  assert.strictEqual(R.info().ronde_op, null, 'geen stempel bij een vol dagvenster');
});

test('kwartaalcontrole: mailtransactie die niet in een export over die dagen staat = signaal', async () => {
  const app = nieuweApp();
  const R = M.maak({ beleggen: app, luik: nepLuik([mail(), mail({ order: 'bbbb0000-0000-0000-0000-000000000007', tijd: '15:40:00' })]), klok: klok('2026-11-15', 10) });
  await R.mailRonde();
  app.app({ pad: '/app/beleggen/bestand', methode: 'POST', body: { naam: 'Transactions.csv', tekst: EXPORT, bewaar: true } });
  const o = app.app({ pad: '/app/beleggen', methode: 'GET' }).body;
  const v = o.signalen.filter((s) => s.soort === 'mail' && /niet in je export/.test(s.titel));
  assert.strictEqual(v.length, 1);
});

test('ochtendvraag: één bericht de ochtend na een aankoop, niet dubbel, niet buiten de uren, niet na een dagboekregel', async () => {
  const app = nieuweApp({ vandaag: () => '2026-11-14' });
  const berichten = [];
  const bericht = async (t, s) => { berichten.push({ t, s }); return { ok: true }; };
  await M.maak({ beleggen: app, luik: nepLuik([mail()]), klok: klok('2026-11-14', 10) }).mailRonde();
  assert.strictEqual((await M.maak({ beleggen: app, luik: nepLuik([]), klok: klok('2026-11-14', 7), bericht }).ochtendvraag()).reden, 'buiten de uren');
  const R = M.maak({ beleggen: app, luik: nepLuik([]), klok: klok('2026-11-14', 8), bericht });
  const u = await R.ochtendvraag();
  assert.strictEqual(u.groepen, 1);
  assert.strictEqual(berichten.length, 1);
  assert.match(berichten[0].t, /^Je kocht gisteren Voorbeeld Chips Corp\. Waarom\?/);
  assert.doesNotMatch(berichten[0].t, /\d+,\d\d|€/, 'geen bedragen in het bericht');
  assert.strictEqual(berichten[0].s, 'beleggen-waarom:2026-11-14');
  assert.strictEqual((await R.ochtendvraag()).reden, 'al gevraagd');
  // volgende dag: dezelfde aankoop niet nog eens
  const R2 = M.maak({ beleggen: app, luik: nepLuik([]), klok: klok('2026-11-15', 9), bericht });
  assert.strictEqual((await R2.ochtendvraag()).reden, 'niets');
  assert.strictEqual(berichten.length, 1);
  // met dagboekregel: geen vraag
  const app2 = nieuweApp({ vandaag: () => '2026-11-14' });
  await M.maak({ beleggen: app2, luik: nepLuik([mail()]), klok: klok('2026-11-14', 10) }).mailRonde();
  const open = app2.gesprek({ opdracht: 'dagboek-open' }).body.open;
  app2.gesprek({ opdracht: 'dagboek', transactie: open[0].transactie, waarom: 'Verzonnen reden voor de toets.' });
  const b2 = [];
  assert.strictEqual((await M.maak({ beleggen: app2, luik: nepLuik([]), klok: klok('2026-11-14', 8), bericht: async (t) => { b2.push(t); return { ok: true }; } }).ochtendvraag()).reden, 'niets');
  assert.strictEqual(b2.length, 0);
});

test('ingelegd uit de bank: alleen na het rekeningoverzicht, zonder overzicht vanaf de eerste bankpost (review MOET 2)', () => {
  const g = (x) => B.geldOverzicht(Object.assign({ transacties: [], vandaag: null }, x));
  const rek = [{ datum: '2026-11-05', omschrijving: 'iDEAL storting', mutatie_cent: 100000, mutatie_valuta: 'EUR' }, { datum: '2026-11-06', omschrijving: 'Transactiekosten', mutatie_cent: -200, mutatie_valuta: 'EUR' }];
  const bank = [{ datum: '2026-11-05', cent: -100000 }, { datum: '2026-11-10', cent: -50000 }, { datum: '2026-11-12', cent: 20000 }];
  const a = g({ rekening: rek, bank });
  assert.strictEqual(a.ingelegd_cent, 100000 + 50000 - 20000, 'overzicht + bank erna (storting op dag 5 niet dubbel)');
  assert.strictEqual(a.ingelegd_bron, 'export+bank');
  assert.strictEqual(a.ingelegd_tot, '2026-11-12');
  const b = g({ rekening: [], bank });
  assert.strictEqual(b.ingelegd_cent, 130000); assert.strictEqual(b.ingelegd_bron, 'bank'); assert.strictEqual(b.ingelegd_van, '2026-11-05');
  const c = g({ rekening: rek, bank: null });
  assert.strictEqual(c.ingelegd_cent, 100000); assert.strictEqual(c.ingelegd_bron, 'export');
  // overzicht zonder storting blijft niet vast te stellen, ook met bankposten
  const d = g({ rekening: [{ datum: '2026-11-06', omschrijving: 'Transactiekosten', mutatie_cent: -200, mutatie_valuta: 'EUR' }], bank });
  assert.strictEqual(d.ingelegd_cent, null);
});
