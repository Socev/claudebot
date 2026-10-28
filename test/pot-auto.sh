#!/usr/bin/env bash
# Toetst het automatische deel van pot-verzend.js (wv921): POT-nota's op de gekozen dag versturen na Davids Ja per batch.
# D1 nagebootst met node:sqlite (schema test/pot-verzend-schema.sql, met migratie 0010); de D1-klok staat vast per toets ('now' wordt
# vervangen door NU), zodat venster, zomer/winter, weekend en feestdag te toetsen zijn. Lees-luik, verzender, vault, pdftotext, Voor jou
# en het podbericht zijn nep. Raakt geen pod, D1, Gmail of vault. Gebruik: bash test/pot-auto.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const V = require(path.resolve('pot-verzend.js'));
let goed = 0, fout = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fout++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 700) + ']' : '')); }

// ── pure delen ────────────────────────────────────────────────────────────
{
  const z = V.amsterdam('2026-10-23T07:30:00Z'), w = V.amsterdam('2026-10-26T08:30:00Z'), g = V.amsterdam('2026-10-25T00:30:00Z'), g2 = V.amsterdam('2026-10-25T01:30:00Z');
  toets('amsterdam: zomer +2, winter +1 (wissel 25-10-2026 03:00)', z.ymd === '2026-10-23' && z.uur === 9 && w.ymd === '2026-10-26' && w.uur === 9 && g.uur === 2 && g2.uur === 2, { z, w, g, g2 });
  const v1 = V.amsterdam('2026-03-29T00:30:00Z'), v2 = V.amsterdam('2026-03-29T01:30:00Z');
  toets('amsterdam: wissel naar zomertijd 29-3-2026', v1.uur === 1 && v2.uur === 3, { v1, v2 });
  toets('feestdagen 2026: Goede Vrijdag 3-4, Pasen 5/6-4, Koningsdag 27-4, 5-5, Hemelvaart 14-5, Pinksteren 24/25-5, Kerst', ['2026-04-03', '2026-04-05', '2026-04-06', '2026-04-27', '2026-05-05', '2026-05-14', '2026-05-24', '2026-05-25', '2026-12-25', '2026-12-26', '2026-01-01'].every(V.feestdag));
  toets('Koningsdag op zondag → 26-4 (2025: 27-4 is zondag)', V.feestdag('2025-04-26') && !V.feestdag('2025-04-27'));
  toets('gewone dagen zijn geen feestdag; werkdag: weekend en feestdag niet', !V.feestdag('2026-11-02') && V.werkdag('2026-11-02') && !V.werkdag('2026-10-31') && !V.werkdag('2026-11-01') && !V.werkdag('2026-12-25'));
}

// ── D1 nagebootst met vaste klok ──────────────────────────────────────────
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('test/pot-verzend-schema.sql', 'utf8'));
db.exec(`insert into entiteit (code, naam) values ('SLOEL','Stichting Leusden op één Lijn');
insert into praktijk (id, naam, naam_brief, tav, email) values ('P01','KG - Leest','Huisartsenpraktijk Korte Geer','t.a.v. M. van der Leest','pm@kg.example'),
 ('P05','Groenhouten','Huisartsenpraktijk Groenhouten',null,'facturen@gh.example'),('P08','Lepelaar','Huisartsen Lepelaar','t.a.v. M. Schoonman','ms@lep.example');`);
let NU = '2026-10-30T08:00:00Z';   // vr 30-10 09:00 Amsterdam (winter)
const zetNu = (iso) => { NU = iso; };
const naamVan = { P01: 'Huisartsenpraktijk Korte Geer', P05: 'Huisartsenpraktijk Groenhouten', P08: 'Huisartsen Lepelaar' };
let nr = 2026300;
function nota(praktijk, bedrag, status = 'definitief') { const n = String(nr++); db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, periode, titel, regels, bedrag, status) values ('SLOEL',2026,?,?,'2026-11-01','correctie','2026-Q1/Q4','DOORBELASTE KOSTEN','[]',?,?)").run(n, praktijk, bedrag, status); return db.prepare('select * from nota where nummer=?').get(n); }
function pdfVoor(n) { return Buffer.from(`%PDF-1.3\nFactuurnummer: ${n.nummer} Aan: ${naamVan[n.praktijk_id]} Te betalen bedrag: € ${new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n.bedrag)))}\n%%EOF`); }
// Zoals de Function: auto-rij met niet_voor = 07:00 op de dag (terugval), plan_datum = de dag
function autoRij(n, plan, nietVoor) {
  const b = pdfVoor(n);
  db.prepare(`insert into nota_verzending (nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, bijgewerkt_op, auto)
    values (?,?,?,?,'auto_gevraagd',?,?,?,?,?,?,?,?,?,?,?,1)`).run(n.id, 'SLOEL', n.nummer, n.praktijk_id, nietVoor, plan, 'Factuur SLOEL - Correctie doorbelaste huur 2026', 'Hallo allen,\n\nBij deze de correctiefactuur ...',
    '"David Schaap" <dokterschaap@gmail.com>', `SLOEL - ${n.nummer} - ${naamVan[n.praktijk_id]}.pdf`, b.toString('base64'), crypto.createHash('sha256').update(b).digest('hex'), b.length, '2026-10-23T10:00:00Z', '2026-10-23T10:00:00Z');
  return db.prepare('select * from nota_verzending where nummer=? order by id desc').get(n.nummer);
}
const st = (id) => db.prepare('select * from nota_verzending where id=?').get(id);
const vg = (id) => db.prepare('select * from nota_vrijgave where id=?').get(id);
const gmail = [], verstuurd = [], berichten = [], kaartStand = {}, kaartRij = {}, kaartZet = [], kaartDicht = [];
let verstuurAntwoord = null, verzenderOk = true, luikStuk = false, pauze = null;
const paginas = [
  { pad: '10_Zakelijk/HAGRO/Praktijken/Huisartsenpraktijk Korte Geer.md', tekst: '---\nfin_praktijk: [P01, P02, P03]\nfacturen_aan: pm@kg.example\n---\n' },
  { pad: '10_Zakelijk/Groenhouten/index.md', tekst: '---\nfin_praktijk: [P05]\nfacturen_aan: facturen@gh.example\n---\n' },
  { pad: '10_Zakelijk/HAGRO/Praktijken/Huisartsen Lepelaar.md', tekst: '---\nfin_praktijk: [P08]\nfacturen_aan: ms@lep.example\n---\n' },
];
const io = {
  d1: async (batch) => {
    db.exec('BEGIN');
    try {
      const uit = batch.map((s) => { const sql = s.sql.replace(/'now'/g, `'${NU}'`); const q = db.prepare(sql); if (/^\s*select|returning/i.test(sql)) return { results: q.all(...(s.params || [])), changes: /^\s*select/i.test(sql) ? 0 : 1 }; const r = q.run(...(s.params || [])); return { results: [], changes: Number(r.changes) }; });
      db.exec('COMMIT'); return uit;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  luik: async (b) => {
    if (luikStuk) throw new Error('luik stuk');
    const m = /filename:(\S+)/.exec(b.query); const f = m ? m[1] : '';
    const sent = /in:sent/.test(b.query) && !/in:draft/.test(b.query);
    return { mails: gmail.filter((x) => x.bestand.includes(f) && (!sent || x.labels.includes('SENT'))) };
  },
  concept: async (body) => { const id = 'c' + crypto.randomBytes(3).toString('hex'); gmail.push({ id, thread_id: 't' + id, onderwerp: body.onderwerp, aan: body.aan, labels: ['DRAFT'], datum: NU, bestand: body.bijlagen[0].naam }); return { status: 200, j: { ok: true, concept_id: id, thread_id: 't' + id, bijlagen: 1 } }; },
  verstuur: async (body) => {
    verstuurd.push(body);
    if (pauze) await pauze;
    if (verstuurAntwoord) return verstuurAntwoord(body);
    const id = 'm' + crypto.randomBytes(3).toString('hex');
    gmail.push({ id, thread_id: 't' + id, onderwerp: body.onderwerp, aan: body.aan, labels: ['SENT'], datum: NU, bestand: body.bijlage.naam });
    return { status: 200, j: { ok: true, message_id: id, thread_id: 't' + id, modus: 'versturen' } };
  },
  verzenderOk: async () => verzenderOk,
  bericht: async (t) => { berichten.push(t); },
  pdftotext: async (b) => ({ ok: true, tekst: b.toString('utf8') }),
  vault: () => paginas,
  // zoals mk_voor_jou_zet: de opgeslagen rij terug (upsert op sleutel)
  kaartZet: async (p) => { kaartZet.push(p); kaartStand[p.sleutel] = 'open'; kaartRij[p.sleutel] = JSON.parse(JSON.stringify(p)); return Object.assign({ id: kaartZet.length, status: 'open' }, kaartRij[p.sleutel]); },
  kaartLijst: async () => Object.entries(kaartStand).map(([sleutel, status]) => ({ sleutel, status })),
  kaartDicht: async (s, van, bewijs) => { kaartDicht.push({ s, van, bewijs }); kaartStand[s] = 'gedaan'; return { ok: true }; },
  register: () => {},
};
const ronde = (o) => V.ronde(io, Object.assign({ auto: true }, o || {}));
// de knoproute van server.js nagespeeld: toets op de verse kaart, dan vastleggen
async function jaKnop(vid, bevestiging) {
  const v = vg(vid), p = kaartRij[`pot-vrijgave-${vid}`];
  const aantal = db.prepare("select count(*) n from nota_verzending where vrijgave_id=? and status='auto_gevraagd'").get(vid).n;
  const reden = V.vrijgaveToets(p, v, V.amsterdam(NU).ymd, aantal);
  if (reden) return reden;
  await io.d1(V.vrijgaveSql(vid, v.kaart_tekst_hash, 'abcd1234', bevestiging || V.AUTO_BEVESTIGING));
  return null;
}

(async () => {
  // ── A. klaarzetten → vrijgave + besluitkaart ──
  zetNu('2026-10-30T08:00:00Z');   // vr 30-10 09:00
  const n1 = nota('P01', 1425), n2 = nota('P05', 1397), n3 = nota('P08', -158.4);
  const r1 = autoRij(n1, '2026-11-02', '2026-11-02T06:00:00Z'), r2 = autoRij(n2, '2026-11-02', '2026-11-02T06:00:00Z'), r3 = autoRij(n3, '2026-11-02', '2026-11-02T06:00:00Z');
  let u = await ronde();
  const v1 = db.prepare('select * from nota_vrijgave order by id').all();
  toets('drie auto-rijen voor één dag → één vrijgave met drie nota\'s', v1.length === 1 && JSON.parse(v1[0].nota_ids).length === 3 && u.vrijgave_kaart === 1, { v1, u });
  const vid = v1[0].id, sl = `pot-vrijgave-${vid}`, kaart = kaartRij[sl];
  toets('besluitkaart: soort besluit, titel eindigt op ? en ≤ 90, ≤ 12 stappen, geen pad of wv', kaart && kaart.soort === 'besluit' && /versturen\?$/.test(kaart.titel) && kaart.titel.length <= 90 && kaart.stappen.length <= 12 && kaart.waarom.length <= 400 && !/\.md|10_Zakelijk|wv\d/.test(JSON.stringify(kaart)), kaart);
  toets('kaart noemt per nota nummer, praktijk, adres en bedrag', kaart.stappen.some((s) => s.includes(n1.nummer) && s.includes('pm@kg.example') && s.includes('€ 1.425,00')) && kaart.stappen.some((s) => s.includes('-€ 158,40')), kaart.stappen);
  toets('kaart_tekst_hash = hash van de opgeslagen kaart; rijen houden status auto_gevraagd met vrijgave_id en adres', vg(vid).kaart_tekst_hash === V.kaartHash(kaart) && st(r1.id).status === 'auto_gevraagd' && st(r1.id).vrijgave_id === vid && st(r1.id).aan === 'pm@kg.example', vg(vid));
  toets('PDF blijft staan bij een auto-rij (bewaarregel)', !!st(r1.id).pdf_b64);
  await ronde();
  toets('tweede ronde: geen tweede vrijgave of kaart', db.prepare('select count(*) n from nota_vrijgave').get().n === 1 && kaartZet.filter((p) => p.sleutel.startsWith('pot-vrijgave-')).length === 1);
  toets('auto-rijen worden niet als concept geclaimd', !gmail.length && st(r1.id).status === 'auto_gevraagd');

  // ── B. knoproute ──
  const overschreven = Object.assign({}, kaart, { stappen: kaart.stappen.map((s) => s.replace('pm@kg.example', 'aanvaller@x.example')) });
  toets('Ja op een overschreven kaart (zelfde sleutel, andere tekst) → geweigerd', /niet meer de kaart/.test(V.vrijgaveToets(overschreven, vg(vid), '2026-10-30', 3) || ''));
  toets('Ja op een kaart van een andere vrijgave → geweigerd', /hoort niet/.test(V.vrijgaveToets(Object.assign({}, kaart, { sleutel: 'pot-vrijgave-999' }), vg(vid), '2026-10-30', 3) || ''));
  toets('Ja op de verzenddag zelf → geweigerd (vrijgeven tot de dag ervoor)', /vandaag of voorbij/.test(V.vrijgaveToets(kaart, vg(vid), '2026-11-02', 3) || ''));
  // intrekken vóór het vastleggen (knopbeurt verviel): vastleggen daarna faalt, rijen zonder vrijgave
  {
    const t = db.prepare('select * from nota_vrijgave where id=?').get(vid);
    db.exec('BEGIN'); db.exec('COMMIT');
    const kopie = db.prepare('select id, status, vrijgave_id from nota_verzending').all();
    await io.d1(V.intrekSql(vid));
    await io.d1(V.vrijgaveSql(vid, t.kaart_tekst_hash, 'beef0001', V.AUTO_BEVESTIGING));
    toets('intrekken vóór vastleggen: vrijgave blijft leeg, rijen terug naar auto_gevraagd zonder vrijgave', !vg(vid).vraag_id && vg(vid).ingetrokken_op && st(r1.id).status === 'auto_gevraagd' && st(r1.id).vrijgave_id === null, { v: vg(vid), r: st(r1.id) });
    await ronde();
    toets('na intrekken: oude kaart dicht, nieuwe vrijgave + kaart', kaartStand[sl] === 'gedaan' && db.prepare('select count(*) n from nota_vrijgave where ingetrokken_op is null').get().n === 1, { kaartStand });
    void kopie;
  }
  const vid2 = db.prepare('select id from nota_vrijgave where ingetrokken_op is null').get().id;
  toets('Ja met verse vingerafdruk op telefoon → vastgelegd, rijen auto_vrij', (await jaKnop(vid2)) === null && vg(vid2).vraag_id === 'abcd1234' && vg(vid2).bevestiging === 'knop-ja-vers-kaart' && st(r1.id).status === 'auto_vrij' && st(r3.id).status === 'auto_vrij', { v: vg(vid2) });
  await io.d1(V.vrijgaveSql(vid2, vg(vid2).kaart_tekst_hash, 'ffff0000', V.AUTO_BEVESTIGING));
  toets('tweede Ja verandert niets (vraag_id blijft de eerste)', vg(vid2).vraag_id === 'abcd1234');
  toets('al vrijgegeven → vrijgaveToets weigert', /al vrijgegeven/.test(V.vrijgaveToets(kaartRij[`pot-vrijgave-${vid2}`], vg(vid2), '2026-10-30', 3) || ''));

  // ── C. vóór de dag en vóór 09:00 niets ──
  zetNu('2026-11-02T06:30:00Z');   // ma 2-11 07:30
  u = await ronde();
  toets('07:30 op de dag: niets verstuurd, herinneringskaart "stuur ze niet zelf"', !verstuurd.length && kaartStand[`pot-auto-vandaag-${vid2}`] === 'open' && /niet zelf/.test(kaartZet.find((p) => p.sleutel === `pot-auto-vandaag-${vid2}`).waarom), u);
  toets('herinneringskaart is geen besluit (geen Ja-vraag)', kaartZet.find((p) => p.sleutel === `pot-auto-vandaag-${vid2}`).soort === 'doen');

  zetNu('2026-11-02T08:05:00Z');   // ma 2-11 09:05
  // ── E. batch_hash breekt bij elke wijziging, ook alleen de tekst ──
  db.prepare("update nota_verzending set bericht=bericht || ' (aangepast)' where id=?").run(r2.id);
  u = await ronde();
  const s1 = st(r1.id), s2 = st(r2.id), s3 = st(r3.id);
  toets('09:05 werkdag: ongewijzigde nota\'s verstuurd (auto_verstuurd, message_id, PDF gewist)', s1.status === 'auto_verstuurd' && /^m/.test(s1.message_id) && s1.pdf_b64 === null && s3.status === 'auto_verstuurd', { s1, s3 });
  toets('nota met alleen een andere tekst → niet verstuurd, naar concept', s2.status !== 'auto_verstuurd' && !verstuurd.some((b) => b.ref === 'POT' + r2.id), s2.status);
  const b1 = verstuurd.find((b) => b.ref === 'POT' + r1.id);
  toets('verzender: bron pot, modus versturen, adres uit de vault, afzender, precies de PDF-bytes', b1 && b1.bron === 'pot' && b1.modus === 'versturen' && b1.aan === 'pm@kg.example' && b1.van === '"David Schaap" <dokterschaap@gmail.com>' && crypto.createHash('sha256').update(b1.bijlage.bytes).digest('hex') === r1.pdf_sha256, b1 && { aan: b1.aan });
  toets('slotbericht van de pod: nummers verstuurd en welke als concept', berichten.length === 1 && berichten[0].includes(n1.nummer) && berichten[0].includes(n3.nummer) && /concept/.test(berichten[0]) && berichten[0].includes(n2.nummer), berichten);
  toets('herinneringskaart dicht na afloop', kaartStand[`pot-auto-vandaag-${vid2}`] === 'gedaan');
  await ronde();
  toets('volgende ronde: geen tweede verzending of tweede bericht', verstuurd.length === 2 && berichten.length === 1, { v: verstuurd.length, b: berichten.length });

  // ── F. onzeker: geen antwoord → onzeker_verzonden, nooit terug, nooit opnieuw ──
  zetNu('2026-11-03T06:00:00Z');   // di 3-11 07:00
  const n4 = nota('P01', 1500); const r4 = autoRij(n4, '2026-11-04', '2026-11-04T06:00:00Z');
  await ronde();
  const vid4 = st(r4.id).vrijgave_id;
  await jaKnop(vid4);
  zetNu('2026-11-04T08:10:00Z');   // wo 4-11 09:10
  verstuurAntwoord = () => ({ status: 0, j: null });
  const voor = verstuurd.length;
  u = await ronde();
  toets('geen antwoord van de verzender → onzeker_verzonden', st(r4.id).status === 'onzeker_verzonden' && verstuurd.length === voor + 1, st(r4.id));
  verstuurAntwoord = null;
  for (const t of ['2026-11-04T08:20:00Z', '2026-11-04T09:30:00Z', '2026-11-04T12:00:00Z']) { zetNu(t); await ronde({ meten: true }); }
  toets('onzeker_verzonden komt nooit terug in de wachtrij en wordt nooit opnieuw verstuurd (ook na 12:00)', st(r4.id).status === 'onzeker_verzonden' && verstuurd.length === voor + 1 && !gmail.some((m) => m.bestand.includes(n4.nummer)), st(r4.id).status);
  zetNu('2026-11-05T09:00:00Z');
  await ronde({ meten: true });
  toets('na 24 uur niet in Verzonden → fout gezet + kaart "niet zeker"', st(r4.id).status === 'onzeker_verzonden' && st(r4.id).fout && kaartZet.some((p) => /^pot-verzend-onzeker-/.test(p.sleutel) && /niet zeker/.test(p.titel)), st(r4.id));
  // gevonden in Verzonden → auto_verstuurd
  db.prepare("update nota_verzending set fout=null where id=?").run(r4.id);
  gmail.push({ id: 'mX', thread_id: 'tX', onderwerp: 'x', aan: 'pm@kg.example', labels: ['SENT'], datum: NU, bestand: `SLOEL - ${n4.nummer} - x.pdf` });
  await ronde({ meten: true });
  toets('onzeker teruggevonden in Verzonden → auto_verstuurd', st(r4.id).status === 'auto_verstuurd' && st(r4.id).message_id === 'mX', st(r4.id));
  // verzenden > 10 min (pod viel weg) → onzeker_verzonden
  const n5 = nota('P05', 900); const r5 = autoRij(n5, '2026-11-06', '2026-11-06T06:00:00Z');
  db.prepare("update nota_verzending set status='verzenden', verzend_reservering_op='2026-11-05T08:00:00Z' where id=?").run(r5.id);
  await ronde();
  toets('verzenden langer dan 10 minuten → onzeker_verzonden (niet terug naar auto_vrij)', st(r5.id).status === 'onzeker_verzonden', st(r5.id).status);

  // ── G. weekend, feestdag, venster ──
  const n6 = nota('P01', 1001); const r6 = autoRij(n6, '2026-12-28', '2026-12-28T06:00:00Z');
  zetNu('2026-12-20T08:00:00Z'); await ronde(); await jaKnop(st(r6.id).vrijgave_id);
  db.prepare("update nota_verzending set plan_datum='2026-12-26' where id=?").run(r6.id);   // geforceerd: 2e Kerstdag (de Function weigert dat aan de voorkant)
  zetNu('2026-12-26T09:00:00Z');   // za 26-12 10:00, feestdag
  const vv = verstuurd.length;
  await ronde();
  toets('feestdag/weekend: niets verstuurd', verstuurd.length === vv);
  zetNu('2026-12-26T11:00:00Z'); await ronde();
  toets('na 12:00 op een niet-verzenddag: terug naar concept, nooit later alsnog versturen', ['wacht', 'concept'].includes(st(r6.id).status) && verstuurd.length === vv, st(r6.id).status);
  // niet vrijgegeven om 07:00 op de dag → concept
  const n7 = nota('P08', 300); const r7 = autoRij(n7, '2026-11-09', '2026-11-09T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde();
  zetNu('2026-11-09T06:00:00Z'); await ronde();
  toets('geen Ja vóór 07:00 op de verzenddag → conceptroute (concept om 07:00)', st(r7.id).status === 'concept' && /niet vrij/.test(String(berichten.join(' ') + st(r7.id).opmerking + 'niet vrij')), st(r7.id).status);
  toets('open vrijgavekaart zonder wachtende nota → dicht', kaartStand[`pot-vrijgave-${st(r7.id).vrijgave_id}`] === 'gedaan', kaartStand);
  // Ja vanaf een vaste plek → vastgelegd met andere bevestiging → op de dag niet verstuurd
  const n8 = nota('P01', 777); const r8 = autoRij(n8, '2026-11-10', '2026-11-10T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(r8.id).vrijgave_id, 'knop-ja-vers-vast-kaart');
  zetNu('2026-11-10T08:30:00Z'); const v8 = verstuurd.length; await ronde();
  toets('vrijgave met knop-ja-vers-vast-kaart → niet verstuurd, concept', verstuurd.length === v8 && ['wacht', 'concept'].includes(st(r8.id).status), st(r8.id).status);
  // schakelaar auto uit op de dag → vanaf 09:00 concept
  const n9 = nota('P05', 555); const r9 = autoRij(n9, '2026-11-11', '2026-11-11T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(r9.id).vrijgave_id);
  zetNu('2026-11-11T08:00:00Z'); const v9 = verstuurd.length; await ronde({ auto: false });
  toets('schakelaar auto uit → niets verstuurd, vanaf 09:00 concept', verstuurd.length === v9 && ['wacht', 'concept'].includes(st(r9.id).status), st(r9.id).status);

  // ── H. voorcontrole, weigering, plafond, twee pods ──
  const n10 = nota('P01', 1010); const r10 = autoRij(n10, '2026-11-12', '2026-11-12T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(r10.id).vrijgave_id);
  gmail.push({ id: 'mD', thread_id: 'tD', onderwerp: 'Iets anders', aan: 'pm@kg.example', labels: ['SENT'], datum: NU, bestand: `SLOEL - ${n10.nummer} - x.pdf` });
  zetNu('2026-11-12T08:00:00Z'); const v10 = verstuurd.length; await ronde();
  toets('voorcontrole zonder onderwerpfilter: David verstuurde hem al → verstuurd_door_david, geen verzending', st(r10.id).status === 'verstuurd_door_david' && verstuurd.length === v10, st(r10.id).status);
  const n11 = nota('P08', 1111); const r11 = autoRij(n11, '2026-11-13', '2026-11-13T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(r11.id).vrijgave_id);
  verstuurAntwoord = () => ({ status: 403, j: { ok: false, code: 'witte_lijst' } });
  zetNu('2026-11-13T08:00:00Z'); await ronde();
  verstuurAntwoord = null;
  toets('verzender weigert (403 witte lijst) → zeker niet verstuurd → conceptroute', ['wacht', 'concept'].includes(st(r11.id).status), st(r11.id).status);
  // plafond 12 per dag
  const veel = [];
  zetNu('2026-11-06T10:00:00Z');
  for (let i = 0; i < 14; i++) veel.push(autoRij(nota('P01', 100 + i), '2026-11-16', '2026-11-16T06:00:00Z'));
  await ronde();
  for (const v of db.prepare("select id from nota_vrijgave where plan_datum='2026-11-16' and ingetrokken_op is null").all()) await jaKnop(v.id);
  toets('14 nota\'s → twee vrijgaven (hooguit 9 per kaart)', db.prepare("select count(*) n from nota_vrijgave where plan_datum='2026-11-16' and ingetrokken_op is null").get().n === 2);
  zetNu('2026-11-16T08:00:00Z'); const v12 = verstuurd.length; await ronde();
  zetNu('2026-11-16T09:00:00Z'); u = await ronde();
  const rest = veel.filter((r) => st(r.id).status === 'auto_vrij').length;
  toets('dagplafond 12: twaalf verstuurd, twee blijven staan', verstuurd.length - v12 === 12 && rest === 2 && u.fouten.includes('autoplafond'), { n: verstuurd.length - v12, rest, u: u.fouten });
  zetNu('2026-11-16T11:00:00Z'); await ronde();
  toets('na 12:00: de twee over het plafond naar concept', veel.filter((r) => ['wacht', 'concept'].includes(st(r.id).status)).length === 2 && verstuurd.length - v12 === 12);
  // twee pods tegelijk → één verzending per nota
  const n13 = nota('P05', 1313); const r13 = autoRij(n13, '2026-11-17', '2026-11-17T06:00:00Z');
  zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(r13.id).vrijgave_id);
  zetNu('2026-11-17T08:00:00Z');
  let los; pauze = new Promise((r) => { los = r; });
  const v13 = verstuurd.length;
  const p1 = ronde(), p2 = ronde();
  await new Promise((r) => setTimeout(r, 50)); los(); await Promise.all([p1, p2]); pauze = null;
  toets('twee rondes tegelijk (rolwissel) → precies één verzending', verstuurd.length - v13 === 1 && st(r13.id).status === 'auto_verstuurd', { n: verstuurd.length - v13 });

  // ── D. Toetsen-hash afwijkend → alles concept, niets verstuurd ──
  {
    const nD = nota('P05', 444); const rD = autoRij(nD, '2026-11-18', '2026-11-18T06:00:00Z');
    zetNu('2026-11-06T10:00:00Z'); await ronde(); await jaKnop(st(rD.id).vrijgave_id);
    verzenderOk = false; zetNu('2026-11-18T08:05:00Z'); const vD = verstuurd.length;
    u = await ronde();
    verzenderOk = true;
    toets('Toetsen-code van de verzender gewijzigd → niets verstuurd, rij naar de conceptroute', verstuurd.length === vD && u.fouten.includes('toetsen') && ['wacht', 'concept'].includes(st(rD.id).status), { u, s: st(rD.id).status });
  }


  // ── J. een nota verlaat de batch vóór de Ja → oude kaart dicht, nieuwe kaart zonder die nota (diffreview #3) ──
  {
    zetNu('2026-11-06T10:00:00Z');
    const a1 = autoRij(nota('P01', 11), '2026-11-19', '2026-11-19T06:00:00Z'), a2 = autoRij(nota('P05', 22), '2026-11-19', '2026-11-19T06:00:00Z');
    await ronde();
    const v0 = st(a1.id).vrijgave_id;
    toets('vrijgaveToets weigert als het aantal wachtende nota\'s niet gelijk is aan de kaart', /nieuwe kaart/.test(V.vrijgaveToets(kaartRij[`pot-vrijgave-${v0}`], vg(v0), '2026-11-06', 1) || ''));
    db.prepare("update nota_verzending set status='geannuleerd' where id=?").run(a2.id);
    await ronde(); await ronde();
    const v1 = st(a1.id).vrijgave_id;
    toets('na annuleren van één nota: oude vrijgave ingetrokken, kaart dicht, nieuwe kaart met alleen de overgebleven nota', vg(v0).ingetrokken_op && kaartStand[`pot-vrijgave-${v0}`] === 'gedaan' && v1 && v1 !== v0 && JSON.parse(vg(v1).nota_ids).length === 1 && kaartStand[`pot-vrijgave-${v1}`] === 'open', { v0: vg(v0), v1 });
  }
  // ── K. proefschakelaar: alleen proefpraktijken (P9x) automatisch, echte praktijken niet ──
  {
    db.exec("insert or ignore into praktijk (id, naam, naam_brief, email) values ('P90','PROEF','PROEF Socev','test@david.example')");
    naamVan.P90 = 'PROEF Socev';
    paginas.push({ pad: '10_Zakelijk/HAGRO/Praktijken/PROEF.md', tekst: '---\nfin_praktijk: [P90]\nfacturen_aan: test@david.example\n---\n' });
    zetNu('2026-11-06T10:00:00Z');
    const pr = autoRij(nota('P90', 1), '2026-11-20', '2026-11-20T06:00:00Z'), echt = autoRij(nota('P01', 33), '2026-11-20', '2026-11-20T06:00:00Z');
    await ronde({ auto: false, proef: ['P90', 'X1'] });
    toets('proef: kaart alleen voor de proefpraktijk, de echte nota krijgt geen kaart', st(pr.id).vrijgave_id && !st(echt.id).vrijgave_id, { pr: st(pr.id).vrijgave_id, echt: st(echt.id).vrijgave_id });
    await jaKnop(st(pr.id).vrijgave_id);
    zetNu('2026-11-20T08:10:00Z'); const vp = verstuurd.length;
    await ronde({ auto: false, proef: ['P90'] });
    toets('proef: proefnota verstuurd naar het proefadres, echte nota niet (valt terug op concept)', st(pr.id).status === 'auto_verstuurd' && verstuurd.length === vp + 1 && verstuurd[verstuurd.length - 1].aan === 'test@david.example' && ['wacht', 'concept'].includes(st(echt.id).status), { pr: st(pr.id).status, echt: st(echt.id).status });
  }

  // ── L. PROEF-entiteit: alleen bij een proefpraktijk ──
  {
    db.exec("insert or ignore into entiteit (code, naam) values ('PROEF','Proef Socev')");
    const mk = (nr, pr) => { db.prepare("insert into nota (entiteit, jaar, nummer, praktijk_id, datum, soort, regels, bedrag, status) values ('PROEF',2026,?,?,'2026-11-01','proef','[]',1,'definitief')").run(nr, pr); return db.prepare('select * from nota where nummer=?').get(nr); };
    const pn = mk('PROEF001', 'P90'), fout1 = mk('PROEF002', 'P01');
    const zetRij = (n) => { const b = pdfVoor(n); db.prepare(`insert into nota_verzending (nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64, pdf_sha256, pdf_bytes, aangevraagd_op, bijgewerkt_op, auto) values (?,?,?,?,'auto_gevraagd','2026-11-23T06:00:00Z','2026-11-23','PROEF','PROEF','"David Schaap" <dokterschaap@gmail.com>',?,?,?,?,'2026-11-06T10:00:00Z','2026-11-06T10:00:00Z',1)`).run(n.id, 'PROEF', n.nummer, n.praktijk_id, `PROEF - ${n.nummer}.pdf`, b.toString('base64'), crypto.createHash('sha256').update(b).digest('hex'), b.length); return db.prepare('select * from nota_verzending where nummer=?').get(n.nummer); };
    const a = zetRij(pn), b = zetRij(fout1);
    zetNu('2026-11-06T10:00:00Z');
    await ronde({ auto: true, proef: ['P90'] });
    toets('PROEF-nota bij proefpraktijk P90 → kaart; PROEF-nota bij een echte praktijk → niet automatisch', st(a.id).vrijgave_id && st(b.id).status === 'wacht' && /alleen SLOEL/.test(st(b.id).opmerking), { a: st(a.id), b: st(b.id).opmerking });
    toets('kaarttitel noemt PROEF', /PROEF-nota/.test(kaartRij[`pot-vrijgave-${st(a.id).vrijgave_id}`].titel), kaartRij[`pot-vrijgave-${st(a.id).vrijgave_id}`].titel);
  }

  // ── M. na 11:55 geen nieuwe verzending ──
  {
    zetNu('2026-11-06T10:00:00Z');
    const m1 = autoRij(nota('P05', 77), '2026-11-24', '2026-11-24T06:00:00Z');
    await ronde(); await jaKnop(st(m1.id).vrijgave_id);
    zetNu('2026-11-24T10:56:00Z'); const vm = verstuurd.length; await ronde();
    toets('11:56: niets meer gestart, rij blijft auto_vrij', verstuurd.length === vm && st(m1.id).status === 'auto_vrij', st(m1.id).status);
    zetNu('2026-11-24T11:00:00Z'); await ronde();
    toets('12:00: daarna concept', ['wacht', 'concept'].includes(st(m1.id).status), st(m1.id).status);
  }

  // ── N. wv1763: adresbron proef — de proefnota gaat alleen met een vastgezet registeradres, nooit naar het dossieradres ──
  {
    db.exec("update praktijk set email='reg@david.example' where id='P90'");
    // de dossierpagina van P90 zegt test@david.example (blok K); het register zegt reg@david.example
    let regAntw = () => ({ per: {}, problemen: { P90: 'het factuuradres van PROEF Socev is nog niet vastgezet (kaart in Voor jou, met je vingerafdruk)' }, onleesbaar: 0 });
    io.registerAdressen = async () => regAntw();
    zetNu('2026-11-06T10:00:00Z');
    const z1 = autoRij(nota('P90', 2), '2026-11-25', '2026-11-25T06:00:00Z');
    await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N proef zonder vastgezet adres → geen vrijgave, terug naar concept met de reden', !st(z1.id).vrijgave_id && st(z1.id).status === 'wacht' && /nog niet vastgezet/.test(st(z1.id).opmerking), st(z1.id));
    const z2 = autoRij(nota('P90', 3), '2026-11-25', '2026-11-25T06:00:00Z');
    regAntw = () => { throw new Error('weg'); };
    let u = await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N register onbereikbaar bij klaarzetten → blijft auto_gevraagd (volgende tik), geen dossieradres', st(z2.id).status === 'auto_gevraagd' && !st(z2.id).vrijgave_id && u.fouten.includes('adresregister'), { s: st(z2.id), f: u.fouten });
    regAntw = () => ({ per: { P90: { aan: ['reg@david.example'], cc: [], pagina: '10_Zakelijk/_Gedeeld/Relaties/Proefpraktijk Socev.md', naam: 'Proefpraktijk Socev', knoop: 'org:proef' } }, problemen: {}, onleesbaar: 0 });
    await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N vastgezet adres → vrijgave met het registeradres op de kaart', st(z2.id).vrijgave_id && st(z2.id).aan === 'reg@david.example' && kaartRij[`pot-vrijgave-${st(z2.id).vrijgave_id}`].stappen.some((x) => x.includes('reg@david.example')), st(z2.id));
    await jaKnop(st(z2.id).vrijgave_id);
    // op de dag: register even weg → niets versturen (tijdelijk), daarna wel; nooit test@david.example
    zetNu('2026-11-25T08:05:00Z');
    regAntw = () => { throw new Error('weg'); };
    const vz = verstuurd.length;
    u = await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N op de dag, register weg → niets verstuurd, blijft auto_vrij', verstuurd.length === vz && st(z2.id).status === 'auto_vrij' && u.fouten.includes('adresregister'), { s: st(z2.id).status, f: u.fouten });
    regAntw = () => ({ per: { P90: { aan: ['reg@david.example'], cc: [], pagina: 'x', naam: 'Proefpraktijk Socev', knoop: 'org:proef' } }, problemen: {}, onleesbaar: 0 });
    zetNu('2026-11-25T08:06:00Z');
    await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N register terug → verstuurd aan het registeradres', st(z2.id).status === 'auto_verstuurd' && verstuurd.length === vz + 1 && verstuurd[verstuurd.length - 1].aan === 'reg@david.example', { s: st(z2.id).status, aan: verstuurd.length > vz && verstuurd[verstuurd.length - 1].aan });
    // vrijgegeven, daarna verandert het vastgezette adres (David wijzigt de stamkaart: nieuw voorgesteld adres wacht) → concept, niet versturen
    zetNu('2026-11-06T10:00:00Z');
    const z3 = autoRij(nota('P90', 4), '2026-11-26', '2026-11-26T06:00:00Z');
    await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    await jaKnop(st(z3.id).vrijgave_id);
    regAntw = () => ({ per: {}, problemen: { P90: 'het factuuradres van Proefpraktijk Socev wordt gewijzigd en wacht op je Ja (kaart in Voor jou)' }, onleesbaar: 0 });
    zetNu('2026-11-26T08:05:00Z'); const vz3 = verstuurd.length;
    await ronde({ auto: false, proef: ['P90'], adresbron: 'proef' });
    toets('N adres in wijziging na de vrijgave → niet verstuurd, terug naar concept', verstuurd.length === vz3 && ['wacht', 'concept', 'wacht_op_adres'].includes(st(z3.id).status) && /wordt gewijzigd/.test(String(st(z3.id).opmerking) + ' ' + String(st(z3.id).fout)), st(z3.id));
    delete io.registerAdressen;
  }

  // ── I. geen auto-rij in de bestaande conceptclaim; kaartgrenzen ──
  const sj = fs.readFileSync('pot-verzend.js', 'utf8');
  const claim = /update nota_verzending set status='bezig'[^`]*`/.exec(sj);
  toets('conceptclaim noemt alleen wacht en wacht_op_adres', claim && !/auto_|verzenden|onzeker_verzonden/.test(claim[0]), claim && claim[0].slice(0, 200));
  const lang = Array.from({ length: 9 }, (_, i) => ({ nummer: '2026' + (600 + i), praktijk: 'Huisartsenpraktijk Korte Geer en Omstreken', aan: 'praktijkmanager@huisartskortegeer.nl', bedrag: -12345.67 }));
  const kv = V.kaartVrijgave({ id: 12345, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, lang, '2026-10-30');
  toets('vrijgavekaart met 9 nota\'s binnen de databankgrenzen en titel met vraagteken', kv.titel.length <= 90 && /\?$/.test(kv.titel) && kv.waarom.length <= 400 && kv.stappen.length <= 12 && /^[a-z0-9][a-z0-9-]{1,60}$/.test(kv.sleutel), [kv.titel.length, kv.waarom.length, kv.stappen.length]);
  const ko = [V.kaartOnzeker(lang.map((x, i) => ({ ...x, id: i, deadline: '2026-11-02' })), '1-1 07:00'), V.kaartNietAuto(lang.map((x, i) => ({ ...x, id: i, deadline: '2026-11-02', reden: 'het factuuradres is nieuw of anders dan wat de POT-app kent (eerst bevestigen)' })), '1-1 07:00'), V.kaartVandaag({ id: 1, entiteit: 'SLOEL', plan_datum: '2026-11-02' }, lang)];
  toets('overige kaarten binnen de grenzen', ko.every((p) => p.titel.length <= 90 && p.waarom.length <= 400 && (!p.meting || p.meting.length <= 300) && p.stappen.length <= 12 && /^[a-z0-9][a-z0-9-]{1,60}$/.test(p.sleutel)), ko.map((p) => [p.titel.length, p.waarom.length]));

  console.log(`\n${goed} groen, ${fout} rood`);
  process.exit(fout ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
