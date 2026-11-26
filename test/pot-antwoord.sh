#!/usr/bin/env bash
# Toetst pot-antwoord.js (wv3677): antwoorden op de decembermail als voorstel per praktijk, met de bundel ovis-pot/ (API van de app) tegen een
# nagebootste D1 (node:sqlite met ovis-pot/schema.sql), een nep-Gmail (lees-luik), een nep-Voor jou en een vaste klok. VERZONNEN praktijken,
# adressen en getallen. Toetst: één kaart met het juiste getal; Ja zet het aantal met bron (logboek); tweede mail = nieuw voorstel (oude vervalt);
# jaartal, datum, postcode, telefoon, bedrag en tijd worden nooit als aantal gekozen; gedeeld adres per naam; twijfel = vraag-kaart; stand
# veranderd vóór de Ja = niets geschreven en een verse kaart; Nee schrijft niets; gelijk = geen kaart; PMA-voorstel één keer; kaartgrenzen;
# de ronde schrijft nooit in D1. Raakt de pod, D1, Gmail en Voor jou niet. Gebruik: bash test/pot-antwoord.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), url = require('url');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }
const A = require(path.resolve('pot-antwoord.js'));
(async () => {
  const map = path.resolve('ovis-pot');
  const api = await import(url.pathToFileURL(path.join(map, 'api.mjs')).href);
  const M = require(path.resolve('pot-maand.js'));
  // ── losse regels ──
  const k1 = A.kiesAantal('Beste David,\n\nOns aantal ingeschreven patiënten per 1 januari 2027 is 3.412.\n\nGroet,\nProefweg 12, 9999 ZZ Proefstad\nTel 012-3456789\nKvK 12345678', 3300);
  toets('kies: 3.412 uit een tekst met jaartal, datum, postcode, telefoon en KvK', k1.aantal === 3412, k1);
  const k2 = A.kiesAantal('Per 1-1-2027 hebben we 2027 nog niet geteld. Bel 06-12345678 of om 10:30. Kosten € 1.234,56, 3,5 %.', 2400);
  toets('kies: alleen jaartal/datum/telefoon/tijd/bedrag/procent = geen aantal', k2.probleem === 'geen', k2);
  const k3 = A.kiesAantal('Het aantal patiënten is 2 400.\nOnze praktijk zit op Proefweg 1250.', 2350);
  toets('kies: twee getallen, één bij "patiënten" dicht bij vorig jaar → dat getal', k3.aantal === 2400 && k3.andere.includes(1250), k3);
  const k4 = A.kiesAantal('We hebben 2.400 of misschien 2.450, ik kijk het na.', 2350);
  toets('kies: twee getallen zonder duidelijk aantal → meerdere (geen gok)', k4.probleem === 'meerdere', k4);
  const k5 = A.kiesAantal('3412 patiënten (peildatum 1 januari 2027, postcode 3831AB)', 0);
  toets('kies: 3412 zonder punt; 3831AB is postcode', k5.aantal === 3412, k5);
  toets('antwoordDeel: geciteerde tekst valt weg', !/2\.400/.test(A.antwoordDeel('Wij hebben 3.000.\n\nOp 1 dec. 2026 om 09:00 schreef David <x@y.z>:\n> vorig jaar 2.400')));
  toets('adresVan: "Naam" <adres>', A.adresVan('"Proef Praktijk" <Een@Proef.Example>') === 'een@proef.example');
  const cfgT = A.instellingen(2027);
  toets('overAantal: contract "per 1 januari 2027" zonder aantal = niet relevant (26-11)', !A.overAantal('Re: Arbeidsovereenkomst per 1 januari 2027', 'Hoi, hierbij getekend retour. Groet, Proef', cfgT));
  toets('overAantal: contract-onderwerp met "aantal uren" = niet relevant', !A.overAantal('Re: Arbeidsovereenkomst per 1 januari 2027', 'Het aantal uren klopt. Getekend retour.', cfgT));
  toets('overAantal: onderwerp met jaarzin + aantal in de tekst = relevant', A.overAantal('Re: per 1 januari 2027', 'Wij hebben 3.412.', cfgT));
  toets('overAantal: onderwerp met jaarzin + "ingeschreven" = relevant', A.overAantal('Re: ingeschreven per 1 januari 2027', 'Zie bijlage.', cfgT));
  toets('overAantal: jaarzin + alleen bijlage van een bekend praktijkadres = relevant', A.overAantal('Re: per 1 januari 2027', 'Zie bijlage.', cfgT, true));
  toets('overAantal: "Patiëntenaantal" in het onderwerp = relevant', A.overAantal('Re: Patiëntenaantal', 'zie bijlage', cfgT));

  // ── nep-D1 met het schema van de app en een vaste klok ──
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(map, 'schema.sql'), 'utf8'));
  let klok = '2026-12-03T10:00:00Z';
  let sqlLog = [];
  const d1 = async (batch) => {
    db.exec('BEGIN');
    try {
      const r = batch.map((s) => {
        const sql = s.sql.replace(/strftime\('%Y-%m-%dT%H:%M:%SZ',\s*'now'\)/g, `'${klok}'`);
        sqlLog.push(sql);
        const st = db.prepare(sql);
        if (/^\s*select\b/i.test(sql) || /\breturning\b/i.test(sql)) return { results: st.all(...(s.params || [])), changes: undefined };
        const x = st.run(...(s.params || [])); return { results: [], changes: Number(x.changes) };
      });
      db.exec('COMMIT'); return r;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  db.exec(`insert into instelling (sleutel, waarde) values ('overstap_fin', '2026-11-08') on conflict(sleutel) do update set waarde=excluded.waarde;
    insert into entiteit (code, naam, naam_document) values ('POT','Proef POT','Proef POT'),('KM','Proef KM','Proef KM'),('SLOEL','Proef SLOEL','Proef SLOEL') on conflict do nothing;
    insert into praktijk (id, naam, naam_brief, email, eigenaar) values
      ('P91','Proef Een','Huisartsenpraktijk Proef Een','een@proef.example','A. Een'),
      ('P92','GP - Jansen','Groepspraktijk Proef','pm@groep.example','B. Jansen'),
      ('P93','GP - Pietersen','Groepspraktijk Proef','pm@groep.example','C. Pietersen'),
      ('P94','Eigenpraktijk','Huisartsenpraktijk Eigen','facturen@eigen.example','D. Eigen'),
      ('P95','Gestopt','Gestopte praktijk','weg@gestopt.example','E. Weg');
    insert into praktijk_patienten (praktijk_id, peildatum, aantal) values ('P91','2026-01-01',3300),('P92','2026-01-01',2350),('P93','2026-01-01',2400),('P94','2026-01-01',5700);
    insert into deelname (entiteit, praktijk_id, geldig_van, geldig_tot) values ('POT','P91','2020-01-01',null),('POT','P92','2020-01-01',null),('POT','P93','2020-01-01',null),('POT','P94','2020-01-01',null),('POT','P95','2020-01-01','2025-12-31');`);
  // ── nep-Gmail ──
  const mails = [];
  let id = 100;
  const mail = (van, datum, onderwerp, tekst) => { const m = { id: 'mailproef' + (id++), van, datum, onderwerp, tekst }; mails.push(m); return m; };
  const zoekLog = [];
  const zoek = async (q) => {
    zoekLog.push(q);
    const na = /after:(\d{4})\/(\d{2})\/(\d{2})/.exec(q), voor = /before:(\d{4})\/(\d{2})\/(\d{2})/.exec(q);
    const van = `${na[1]}-${na[2]}-${na[3]}`, tot = `${voor[1]}-${voor[2]}-${voor[3]}`;
    const f = /from:\(([^)]*)\)/.exec(q);
    const lijst = mails.filter((m) => { const d = new Date(m.datum).toISOString().slice(0, 10); return d > van && d < tot; }).filter((m) => {
      const a = A.adresVan(m.van);
      if (f) return f[1].split(' OR ').some((x) => x === a || (!x.includes('@') && a.endsWith('@' + x)));
      return /"1 januari 2027"/.test(q) && (m.onderwerp + m.tekst).includes('1 januari 2027') && a !== 'dokterschaap@gmail.com';
    });
    return { mails: lijst.slice(0, 25).map((m) => ({ id: m.id, datum: m.datum, van: m.van, onderwerp: m.onderwerp })) };   // lees-luik: hooguit 25
  };
  const gelezen = [];
  const lees = async (i) => { gelezen.push(i); const m = mails.find((x) => x.id === i); return m ? { id: m.id, datum: m.datum, van: m.van, onderwerp: m.onderwerp, tekst: m.tekst } : { fout: 'weg' }; };
  // ── nep-Voor jou ──
  const kaarten = new Map();
  let pma = null;
  const staat = {};
  const io = {
    d1, zoek, lees, staat, bewaar: async () => {},
    pma: (naam, pd) => (pma && naam === 'Eigenpraktijk' && pd === '2027-01-01' ? pma : null),
    kaartZet: async (k) => { kaarten.set(k.sleutel, Object.assign({ status: 'open' }, k)); return { sleutel: k.sleutel }; },
    kaartLijst: async () => [...kaarten.values()].map((k) => ({ sleutel: k.sleutel, status: k.status })),
    kaartVervalt: async (sl, van) => { const k = kaarten.get(sl); if (!k || k.status !== van) throw new Error('van klopt niet'); k.status = 'vervallen'; },
    schrijfStand: (b) => api.schrijf(M.d1Achtig(d1), 'stand', b, 'David (Socev-kaart)'),
    box: () => {},
  };
  const open = () => [...kaarten.values()].filter((k) => k.status === 'open');
  const stand = (p) => db.prepare("select aantal, status, opgegeven_door, bron_tekst from praktijk_patienten where praktijk_id=? and peildatum='2027-01-01'").get(p) || null;
  const druk = async (sl, keuze) => { const k = kaarten.get(sl); k.status = 'gedaan'; const h = await A.knopVoor(io, sl, keuze); return { h, r: h ? await h.uitvoeren(keuze) : null }; };
  const schrijftNiet = () => sqlLog.filter((s) => !/^\s*select\b/i.test(s));

  // ronde 0: vóór 25-11 niets
  klok = '2026-11-21T10:00:00Z';
  let u = await A.ronde(io, {});
  toets('vóór 25 november: buiten het venster, geen zoekactie', u.buiten === true && zoekLog.length === 0, u);

  // ronde 1: één antwoord van Proef Een (3 december) + een niet-relevante mail + een mail van David zelf
  klok = '2026-12-03T10:00:00Z';
  const m1 = mail('"Praktijk Proef Een" <een@proef.example>', '2026-12-02T14:12:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027',
    'Beste David,\n\nOns aantal ingeschreven patiënten is 3.412.\n\nGroet,\nPraktijkmanager\nProefweg 12, 9999 ZZ Proefstad\nTel 012-3456789\n\nOp 1 dec. 2026 om 09:00 schreef David <dokterschaap@gmail.com>:\n> Graag jullie aantal per 1 januari 2027. Vorig jaar 3.300.');
  mail('"Praktijk Proef Een" <een@proef.example>', '2026-12-02T15:00:00Z', 'Vraag over de huur', 'Klopt de nota van 1.250? Groet');
  sqlLog = [];
  u = await A.ronde(io, {});
  let o = open();
  toets('ronde 1: één kaart voor Proef Een met 3.412', o.length === 1 && /Proef Een geeft 3\.412 patiënten door \(mail van 2-12\)\. Overnemen\?/.test(o[0].titel), { u, o });
  toets('ronde 1: niet-relevante mail overgeslagen', u.niet_relevant === 1, u);
  toets('ronde 1: kaart toont oud → nieuw, vorig jaar en voorlopig', /nu leeg, wordt 3\.412 \(voorlopig/.test(o[0].waarom) && /Vorig jaar 3\.300/.test(o[0].waarom), o[0].waarom);
  toets('ronde 1: zoekvraag sluit verzonden en concepten uit', zoekLog.every((q) => /-in:sent -in:draft/.test(q) && /after:/.test(q) && /before:/.test(q)), zoekLog.slice(-2));
  toets('ronde 1: gestopte praktijk niet in de zoekvraag', zoekLog.every((q) => !/gestopt/.test(q)));
  toets('ronde: schrijft nooit in D1', schrijftNiet().length === 0, schrijftNiet());
  const sl1 = o[0].sleutel;

  // ronde 2 zonder nieuwe mails: geen nieuwe kaart, geen nieuwe leesactie
  const nGelezen = gelezen.length;
  u = await A.ronde(io, {});
  toets('ronde 2: niets nieuw → geen kaart en niets opnieuw gelezen', open().length === 1 && gelezen.length === nGelezen && u.voorstellen === 0, u);

  // Ja: schrijft met bron en logboek
  let d = await druk(sl1, 'ja');
  let s = stand('P91');
  toets('Ja: context zegt dat de pod schrijft', /De pod zet nu zelf 3\.412/.test(d.h.context), d.h.context);
  toets('Ja: stand 3412 voorlopig met de mail als bron', s && s.aantal === 3412 && s.status === 'voorlopig' && s.bron_tekst.includes(m1.id) && s.opgegeven_door === 'een@proef.example', s);
  const log = db.prepare("select wie, actie, nieuw from logboek where tabel='praktijk_patienten' order by id desc").get();
  toets('Ja: logboek "nieuw" door David (Socev-kaart)', log && log.wie === 'David (Socev-kaart)' && log.actie === 'nieuw', log);
  d = await druk(sl1, 'ja');
  toets('tweede druk op dezelfde kaart doet niets', /al afgehandeld/.test(d.h.context) && d.r.ok === false);

  // ronde 3: tweede mail van dezelfde praktijk (januari) → nieuw voorstel, oud → nieuw; daarnaast een groepsmail en twijfel
  klok = '2027-01-05T10:00:00Z';
  mail('<een@proef.example>', '2027-01-04T09:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Correctie: per 1-1-2027 zijn het 3.420 patiënten.\n\n-- \nProefweg 12\n9999 ZZ Proefstad');
  mail('Praktijkmanager <pm@groep.example>', '2027-01-04T10:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Beste David,\n\nJansen: 2.360 patiënten\nPietersen: 2.415 patiënten\n\nGroet');
  mail('Onbekend <iemand@elders.example>', '2027-01-04T11:00:00Z', 'Fwd: patiëntenaantal per 1 januari 2027', 'Hier ons aantal: 2.999');
  mail('<een@proef.example>', '2027-01-03T08:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Het patiëntenaantal volgt begin januari 2027, postcode 9999 ZZ.');
  u = await A.ronde(io, {});
  o = open();
  const een = o.filter((k) => k.herkomst.praktijk_id === 'P91');
  toets('ronde 3: tweede mail Proef Een → nieuwe kaart 3.420, oud 3.412 (voorlopig) in beeld', een.length === 1 && /3\.420/.test(een[0].titel) && /nu 3\.412 \(voorlopig\), wordt 3\.420\./.test(een[0].waarom), een.map((k) => [k.titel, k.waarom]));
  toets('ronde 3: groepsadres → Jansen 2.360 en Pietersen 2.415', o.some((k) => k.herkomst.praktijk_id === 'P92' && /2\.360/.test(k.titel)) && o.some((k) => k.herkomst.praktijk_id === 'P93' && /2\.415/.test(k.titel)), o.map((k) => k.titel));
  const vragen = o.filter((k) => k.soort === 'doen');
  toets('ronde 3: onbekende afzender + mail zonder aantal → twee vraag-kaarten zonder Ja', vragen.length === 2 && vragen.some((k) => /iemand@elders\.example/.test(k.waarom)) && vragen.some((k) => /geen aantal/.test(k.waarom)), vragen.map((k) => k.waarom));
  toets('ronde 3: nooit een jaartal of postcode als aantal', !o.some((k) => /\b(2\.?027|9\.?999)\b/.test(k.titel)), o.map((k) => k.titel));

  // de stand verandert vóór de Ja (David typte op de pc): niets schrijven, verse kaart
  db.prepare("update praktijk_patienten set aantal=3415, status='definitief' where praktijk_id='P91' and peildatum='2027-01-01'").run();
  const slOud = een[0].sleutel;
  d = await druk(slOud, 'ja');
  toets('stand veranderd: NIET overgenomen', /NIET overgenomen/.test(d.h.context) && d.r.ok === false && stand('P91').aantal === 3415, { c: d.h.context, s: stand('P91') });
  u = await A.ronde(io, {});
  const vers = open().filter((k) => k.herkomst.praktijk_id === 'P91');
  toets('stand veranderd: volgende ronde een verse kaart met nu 3.415', vers.length === 1 && vers[0].sleutel !== slOud && /nu 3\.415, wordt 3\.420/.test(vers[0].waarom), vers.map((k) => k.waarom));

  // race: de stand verandert tussen knopVoor en uitvoeren → ja() toetst opnieuw
  const h = await A.knopVoor(io, vers[0].sleutel, 'ja');
  db.prepare("update praktijk_patienten set aantal=3416 where praktijk_id='P91' and peildatum='2027-01-01'").run();
  kaarten.get(vers[0].sleutel).status = 'gedaan';
  const r = await h.uitvoeren('ja');
  toets('race: ja() toetst de stand opnieuw en schrijft niet', r.ok === false && stand('P91').aantal === 3416, r);

  // Nee schrijft niets
  const jans = open().find((k) => k.herkomst.praktijk_id === 'P92');
  d = await druk(jans.sleutel, 'nee');
  toets('Nee: niets geschreven', d.r.ok === true && stand('P92') === null && /NIET over/.test(d.h.context));
  // Ja op Pietersen
  const piet = open().find((k) => k.herkomst.praktijk_id === 'P93');
  d = await druk(piet.sleutel, 'ja');
  toets('Ja op groepskaart: Pietersen 2415 definitief', stand('P93') && stand('P93').aantal === 2415 && stand('P93').status === 'definitief', stand('P93'));

  // gelijk aan de stand → geen kaart
  klok = '2027-01-07T10:00:00Z';
  mail('Praktijkmanager <pm@groep.example>', '2027-01-06T10:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Pietersen: 2.415 patiënten (nogmaals)');
  const voor = open().length;
  u = await A.ronde(io, {});
  toets('gelijk aan de stand: geen nieuwe kaart', u.gelijk >= 1 && open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P93').length === 0, { u, n: open().length, voor });

  // PMA: eigen praktijk één keer
  pma = { aantal: 5712, exportdatum: '2027-01-06' };
  u = await A.ronde(io, {});
  let eigen = open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P94');
  toets('PMA: kaart "Eigenpraktijk: 5.712 patiënten per 1-1-2027 volgens Promedico"', eigen.length === 1 && /Eigenpraktijk: 5\.712 patiënten per 1-1-2027 volgens Promedico\. Overnemen\?/.test(eigen[0].titel), eigen.map((k) => k.titel));
  u = await A.ronde(io, {});
  toets('PMA: zelfde export geeft geen tweede kaart', open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P94').length === 1);
  d = await druk(eigen[0].sleutel, 'ja');
  toets('PMA Ja: 5712 met de export als bron', stand('P94') && stand('P94').aantal === 5712 && /Promedico-export/.test(stand('P94').bron_tekst), stand('P94'));

  // Codex r1 MOET 1: een nieuw antwoord gelijk aan de stand laat de oude voorstelkaart vervallen
  klok = '2027-01-08T10:00:00Z';
  let p91 = open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91');
  toets('voorbereiding MOET 1: er staat een open kaart voor Proef Een', p91.length === 1, open().map((k) => k.titel));
  mail('<een@proef.example>', '2027-01-07T09:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Het klopt: 3.416 patiënten.');
  u = await A.ronde(io, {});
  toets('MOET 1: antwoord gelijk aan de stand → oude kaart vervallen, geen nieuwe', open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91').length === 0 && kaarten.get(p91[0].sleutel).status === 'vervallen', { u, s: kaarten.get(p91[0].sleutel).status });
  // MOET 2: herhaalvoorstel (stand veranderde vóór de Ja) verdringt nooit een nieuwer antwoord uit dezelfde ronde
  mail('<een@proef.example>', '2027-01-08T08:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Toch 3.430 patiënten, excuus.');
  klok = '2027-01-08T12:00:00Z';
  u = await A.ronde(io, {});
  let k430 = open().find((k) => k.herkomst && k.herkomst.praktijk_id === 'P91');
  db.prepare("update praktijk_patienten set aantal=3417 where praktijk_id='P91' and peildatum='2027-01-01'").run();
  d = await druk(k430.sleutel, 'ja');
  toets('voorbereiding MOET 2: Ja op 3.430 met veranderde stand = opnieuw', /NIET overgenomen/.test(d.h.context));
  mail('<een@proef.example>', '2027-01-08T13:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Definitief: 3.440 patiënten.');
  klok = '2027-01-08T15:00:00Z';
  u = await A.ronde(io, {});
  p91 = open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91');
  toets('MOET 2: één kaart, met het nieuwste antwoord (3.440), niet het herhaalde 3.430', p91.length === 1 && /3\.440/.test(p91[0].titel), p91.map((k) => k.titel));
  // ZOU 1: een Ja die bleef hangen ('bezig') wordt na 10 min uit de databank afgerond
  const kb = staat.jaren['2027'].kaarten[p91[0].sleutel];
  kb.stand = 'bezig'; kb.bezig_op = '2027-01-08T14:00:00Z'; kaarten.get(p91[0].sleutel).status = 'gedaan';
  db.prepare("update praktijk_patienten set aantal=3440, status='definitief' where praktijk_id='P91' and peildatum='2027-01-01'").run();
  u = await A.ronde(io, {});
  toets('ZOU 1: hangende Ja die wel in de databank staat → ja, geen nieuwe kaart', kb.stand === 'ja' && open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91').length === 0, kb.stand);

  // Codex r2 MOET 2: een oudere mail (eerder niet te lezen) vervangt nooit een nieuwer verwerkt antwoord
  klok = '2027-01-09T10:00:00Z';
  mail('<een@proef.example>', '2027-01-07T07:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Ons aantal: 3.399 patiënten.');   // binnen het zoekvenster, maar ouder dan het nieuwste antwoord
  u = await A.ronde(io, {});
  toets('r2 MOET 2: oudere mail geeft geen kaart', open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91').length === 0 && u.ouder === 1, u);
  // Codex r2 MOET 3: een vaag antwoord van een gedeeld adres laat de open kaarten van de hele groep vervallen
  mail('Praktijkmanager <pm@groep.example>', '2027-01-09T08:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Jansen: 2.370 patiënten\nPietersen: 2.420 patiënten');
  klok = '2027-01-09T11:00:00Z';
  u = await A.ronde(io, {});
  const groepKaarten = open().filter((k) => k.herkomst && ['P92', 'P93'].includes(k.herkomst.praktijk_id));
  toets('voorbereiding MOET 3: twee groepskaarten', groepKaarten.length === 2, groepKaarten.map((k) => k.titel));
  mail('Praktijkmanager <pm@groep.example>', '2027-01-09T12:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Sorry, de patiëntenaantallen van vanochtend kloppen niet. Volgt.');
  klok = '2027-01-09T13:00:00Z';
  u = await A.ronde(io, {});
  toets('r2 MOET 3: vaag groepsantwoord → beide groepskaarten vervallen + één vraag-kaart', groepKaarten.every((k) => kaarten.get(k.sleutel).status === 'vervallen') && u.vragen === 1, { u, st: groepKaarten.map((k) => kaarten.get(k.sleutel).status) });
  // Codex r2 MOET 4: een vol zoekvenster (25) wordt per adres gesplitst; niets afgekapt
  for (let i = 0; i < 13; i++) { mail('<een@proef.example>', '2027-01-10T0' + (i % 9) + ':1' + (i % 6) + ':00Z', 'Overleg ' + i, 'Agenda'); mail('<pm@groep.example>', '2027-01-10T0' + (i % 9) + ':2' + (i % 6) + ':00Z', 'Rooster ' + i, 'Rooster'); }
  klok = '2027-01-10T20:00:00Z';
  const zl = zoekLog.length;
  u = await A.ronde(io, {});
  const u2 = await A.ronde(io, {});
  toets('r2 MOET 4: 26 mails op één dag → gesplitst per adres, alles gelezen, niets afgekapt', !u.fouten.includes('afgekapt') && u.niet_relevant + u2.niet_relevant === 26 && zoekLog.slice(zl).some((q) => /from:\(een@proef\.example\)/.test(q)), { u, u2 });
  toets('r2 MOET 1: geen vrije mailtekst op de kaarten', ![...kaarten.values()].some((k) => /"[^"]*\d[^"]*"/.test(k.waarom)), [...kaarten.values()].map((k) => k.waarom).find((w) => /"/.test(w)));

  // Codex r3 ZOU 3: een collega-adres op het eigen praktijkdomein wordt gevonden en gekoppeld
  mail('Dokter Een <dokter@proef.example>', '2027-01-11T09:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Ons aantal ingeschreven patiënten: 3.450.');
  klok = '2027-01-11T12:00:00Z';
  u = await A.ronde(io, {});
  toets('r3 ZOU 3: collega-adres op het praktijkdomein (antwoord met jaarzin) → kaart voor Proef Een', open().some((k) => k.herkomst && k.herkomst.praktijk_id === 'P91' && /3\.450/.test(k.titel)), open().map((k) => k.titel));
  // Codex r3 ZOU 1: een uitgestelde (later) kaart vervalt met haar echte status
  const k450 = open().find((k) => k.herkomst && k.herkomst.praktijk_id === 'P91');
  k450.status = 'later';
  mail('Dokter Een <dokter@proef.example>', '2027-01-11T13:00:00Z', 'Re: POH-GGZ: jullie patiëntenaantal per 1 januari 2027', 'Correctie: het aantal is 3.455 patiënten.');
  klok = '2027-01-11T15:00:00Z';
  u = await A.ronde(io, {});
  toets('r3 ZOU 1: later-kaart vervallen, één nieuwe kaart 3.455', kaarten.get(k450.sleutel).status === 'vervallen' && open().filter((k) => k.herkomst && k.herkomst.praktijk_id === 'P91').length === 1, { s: kaarten.get(k450.sleutel).status, u });

  // kaartgrenzen (databank: titel 3–90, waarom ≤ 400, stappen ≤ 12, sleutel-vorm voor de knop)
  const alle = [...kaarten.values()];
  const mis = alle.filter((k) => k.titel.length < 3 || k.titel.length > 90 || k.waarom.length > 400 || (k.stappen || []).length > 12 || !/^[a-z0-9][a-z0-9_-]{1,60}$/.test(k.sleutel) || !['overal'].includes(k.waar) || (k.soort === 'besluit' && !/\?$/.test(k.titel)));
  toets('alle kaarten binnen de grenzen (' + alle.length + ')', mis.length === 0, mis.map((k) => [k.sleutel, k.titel.length, k.waarom.length]));
  toets('kaarten zonder geheimen of wv-nummers', !alle.some((k) => /wv\d{3,}|\/opt\/data|\.md\b/.test(JSON.stringify(k))));
  toets('besluitkaarten privé (knopbeurt in het hoofdkanaal), vraag-kaarten niet (Anders → machinekamer)', alle.every((k) => (k.soort === 'besluit') === (k.prive === true)));

  // na half februari: niets meer
  klok = '2027-02-20T10:00:00Z';
  u = await A.ronde(io, {});
  toets('na 15 februari: buiten het venster', u.buiten === true, u);

  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
