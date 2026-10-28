'use strict';
// Contracttoetsen voor facturen-koerier.js (wv855, F4): de koerier tegen een nep-lees-luik (paginering 25, UTC + lokaal, 8 MB-grens,
// foutvariant, doorgestuurde mail) en een nep-verzender (witte lijst, kan "het antwoord verliezen"), op een wegwerpdatabase met zaaddata.
// Raakt /opt/data/facturen, n8n, Gmail, de kluis en de vault niet; pdftotext draait echt (vast pad, stdin/stdout) op synthetische PDF's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'facturen-db.js'));
const K = require(path.join(ROOT, 'facturen-kern.js'));
const F = require(path.join(ROOT, 'facturen.js'));
const KO = require(path.join(ROOT, 'facturen-koerier.js'));
const Z = require(path.join(ROOT, 'test', 'facturen-zaad.js'));

const NU = Date.parse('2026-10-22T12:30:00Z');
const UUR = 3600000, MIN = 60000;
const WEG = [];
process.on('exit', () => { for (const d of WEG) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

// ── nep-Gmail achter het lees-luik en de verzender ──
function nepGmail(o) {
  o = o || {};
  const g = { mails: [], bijlagen: {}, teksten: {}, n: 0, verzonden: [], zoek: [], luikStuk: false, verlies: {}, status: null, witteLijst: o.witteLijst || null };
  const tokens = (q) => (q.match(/F[VA][0-9a-f]{16}/g) || []);
  g.luik = async function (b) {
    if (g.luikStuk) throw Object.assign(new Error('lees-luik weg'), { code: 'ECONNRESET' });
    if (b.actie === 'mail_zoeken') {
      g.zoek.push(b.query);
      // zoals het echte luik bij een Gmail-fout: 200 met een lege lijst en een melding
      if (g.zoekMelding) return { query: b.query, aantal: 0, mails: [], melding: g.zoekMelding };
      const q = String(b.query);
      let lijst;
      const tok = tokens(q);
      if (tok.length) {
        const alleenSent = /^in:sent /.test(q);
        lijst = g.mails.filter((m) => tok.some((t) => m.onderwerp.indexOf('[ref ' + t + ']') >= 0) && (alleenSent ? m.labels.includes('SENT') : (m.labels.includes('SENT') || m.labels.includes('DRAFT'))));
      } else {
        const na = /after:(\d{4})\/(\d{2})\/(\d{2})/.exec(q), voor = /before:(\d{4})\/(\d{2})\/(\d{2})/.exec(q);
        const van = na ? na.slice(1).join('-') : '0000', tot = voor ? voor.slice(1).join('-') : '9999';
        lijst = g.mails.filter((m) => m.labels.includes('INBOX') && m.dag_lokaal >= van && m.dag_lokaal < tot);
      }
      // het luik geeft hooguit 25 (paginering doet de koerier door het venster te halveren)
      return { query: q, aantal: Math.min(25, lijst.length), mails: lijst.slice(0, 25).map((m) => Object.assign({}, m)) };
    }
    if (b.actie === 'mail_bijlage') {
      const m = g.mails.find((x) => x.id === b.id);
      if (m && m.te_groot) return { modus: 'lijst', mail_id: b.id, fout: 'mail te groot voor dit luik' };
      return { modus: 'lijst', mail_id: b.id, aantal: (g.bijlagen[b.id] || []).length, bijlagen: (g.bijlagen[b.id] || []).map((x) => ({ naam: x.naam, mime: x.mime })) };
    }
    if (b.actie === 'mail_lezen') return { id: b.id, tekst: g.teksten[b.id] || '' };
    throw new Error('onbekende actie');
  };
  g.luikBytes = async function (b) {
    if (g.luikStuk) throw new Error('lees-luik weg');
    const x = (g.bijlagen[b.id] || []).find((y) => y.naam === b.naam);
    return x ? { bytes: x.bytes } : { json: { modus: 'lijst', fout: 'bijlage niet gevonden' } };
  };
  g.verzender = async function (v) {
    g.verzonden.push({ token: v.token, aan: v.aan, modus: v.modus, onderwerp: v.onderwerp, tekst: v.tekst, namen: v.bijlagen.map((b) => b.naam), n: v.bijlagen.length, shas: v.bijlagen.map((b) => D.sha256(b.bytes)) });
    if (g.status) return { status: g.status, j: { ok: false, code: g.status === 401 ? 'secret' : 'gmail', fout: 'proef' } };
    if (g.witteLijst && !g.witteLijst.includes(v.aan)) return { status: 403, j: { ok: false, code: 'witte_lijst', fout: 'adres staat niet op de witte lijst' } };
    if (v.modus !== 'concept') return { status: 403, j: { ok: false, code: 'versturen_uit' } };
    const id = 'm' + String(++g.n).padStart(15, '0');
    g.mails.push({ id, thread_id: id, aan: v.aan, onderwerp: v.onderwerp, snippet: v.tekst.replace(/\s+/g, ' ').slice(0, 200), labels: ['DRAFT'], datum: new Date(NU).toISOString(), dag_lokaal: '2026-10-22' });
    if (g.verlies[v.token] > 0) { g.verlies[v.token]--; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }
    return { status: 200, j: { ok: true, extern_id: 'r-' + id, message_id: id, modus: 'concept', bijlagen: v.bijlagen.length } };
  };
  // David verstuurt het concept: het concept verdwijnt, er komt een verzonden mail (andere id)
  g.verstuurConcept = (token) => { const m = g.mails.find((x) => x.labels.includes('DRAFT') && x.onderwerp.indexOf(token) >= 0); m.labels = ['SENT']; m.id = 's' + m.id.slice(1); };
  g.io = () => ({ luik: g.luik, luikBytes: g.luikBytes, verzender: g.verzender });
  g.concepten = (token) => g.mails.filter((m) => m.onderwerp.indexOf('[ref ' + token + ']') >= 0).length;
  return g;
}

function opzet() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facturen-koerier-'));
  WEG.push(dir);
  const fdb = D.open(path.join(dir, 'db'));
  Z.zaai(fdb, { vandaag: '2026-10-22' });
  const routes = F.maak({ fout: () => {} });
  const eig = F.rolVoor(fdb, { ingang: 'app', wie: 'david (proef)' });
  const t = { dir, fdb, routes, eig, klok: NU };
  t.call = (methode, rest, d, x) => routes.app(fdb, { methode, pad: '/app/facturen' + (rest ? '/' + rest : ''), d: d || {}, rol: (x && x.rol) || eig, primair: true, nu: (x && x.nu) || NU,
    versOk: () => true, versVerbruik: () => {} });
  t.ronde = (g, nu, extra) => { t.klok = nu; return KO.ronde(fdb, Object.assign(g.io(), extra || {}), { nu, klok: () => t.klok }); };
  t.op = (id) => fdb.db.prepare('SELECT * FROM opdracht WHERE id = ?').get(id);
  t.fac = (id) => fdb.db.prepare('SELECT * FROM factuur WHERE id = ?').get(id);
  t.n = (sql, p) => Number(fdb.db.prepare(sql).get(...(p || [])).n);
  // een gewone factuur bevestigen → { f, op }
  t.bevestig = (extra) => {
    const f = fdb.db.prepare("SELECT * FROM factuur WHERE status = 'te_beoordelen' AND entiteit IN ('tolgaarde','groenhouten','holding','kostenmaatschap') AND betaalwijze <> 'onbekend' " +
      "AND iban_nieuw = 0 AND patientkenmerk = 0 AND valuta = 'EUR' AND incl > 0" + (extra ? ' AND ' + extra : '') + ' ORDER BY aangemaakt_op, id LIMIT 1').get();
    const r = t.call('POST', 'bevestig', { id: f.id });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    return { f, op: t.op(r.j.opdracht.id), tok: 'FV' + f.id };
  };
  return t;
}
const VERSTUUR = Date.parse('2026-10-22T13:00:00Z');   // verstuur_na van een bevestiging om 12:30Z

// ───────────────────────────── CI-poort en pure delen ─────────────────────────────

test('CI-poort: de koerier laadt alleen crypto, child_process (pdftotext) en de Facturen-buren; geen fetch, geen fs', () => {
  const C = fs.readFileSync(path.join(ROOT, 'facturen-koerier.js'), 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/)/.test(r)).join('\n');
  const req = (C.match(/require\([^)]*\)/g) || []);
  assert.deepEqual([...new Set(req)].sort(), ["require('./facturen-db.js')", "require('./facturen-kern.js')", "require('./facturen.js')", "require('child_process')", "require('crypto')"]);
  assert.ok(!/\bfetch\s*\(|\bspawn\s*\(|(?<!\.)\bexec\s*\(|execSync|spawnSync|writeFile|appendFile|console\.(log|error)/.test(C));
  assert.equal((C.match(/execFile\(/g) || []).length, 1, 'één execFile');
  assert.match(C, /const PDFTOTEXT = '\/usr\/bin\/pdftotext';/);
});

test('pdftotext: tekst in het geheugen (stdin → stdout); geen PDF → ok:false zonder inhoud', async () => {
  const t = await KO.pdfNaarTekst(Z.pdf(['Leverancier A B.V.', 'Factuur PROEF-1', 'synthetisch']));
  assert.equal(t.ok, true);
  assert.match(t.tekst, /Factuur PROEF-1/);
  assert.equal(t.tekstlaag, true);
  const x = await KO.pdfNaarTekst(Buffer.from('geen pdf'));
  assert.equal(x.ok, false);
  assert.deepEqual(Object.keys(x), ['ok', 'fout']);
});

test('doorgestuurde mail: oorspronkelijke afzender uit het eerste citaatblok; anders null', () => {
  assert.equal(KO.oorspronkelijkeAfzender('Zie bijlage\n\n---------- Forwarded message ---------\nFrom: Leverancier A <facturen@leverancier-a.invalid>\nDate: ma 20 okt\n'), 'facturen@leverancier-a.invalid');
  assert.equal(KO.oorspronkelijkeAfzender('-----Oorspronkelijk bericht-----\n> Van: boekhouding@b.invalid\n> Aan: iemand'), 'boekhouding@b.invalid');
  assert.equal(KO.oorspronkelijkeAfzender('Van: niet-doorgestuurd@c.invalid'), null);
  assert.equal(KO.isDoorgestuurd({ onderwerp: 'Fwd: Factuur 12', van: 'x@y.invalid' }, []), true);
  assert.equal(KO.isDoorgestuurd({ onderwerp: 'Factuur 12', van: '"D" <d.schaap@gmail.com>' }, ['d.schaap@gmail.com']), true);
  assert.equal(KO.isDoorgestuurd({ onderwerp: 'Factuur 12', van: 'x@y.invalid' }, ['d.schaap@gmail.com']), false);
});

// ───────────────────────────── verzenden: wachtrij, controle, idempotentie ─────────────────────────────

test('opdracht pas na verstuur_na; dan één concept met het token en de stukken; factuur concept_klaar; tweede gelukt verandert niets', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.bevestig();
  await t.ronde(g, NU + 5 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 0, 'vóór verstuur_na niets');
  assert.equal(t.op(op.id).status, 'wacht');
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(u.ok, true, JSON.stringify(u.fouten));
  const mijn = g.verzonden.filter((v) => v.token === tok);
  assert.equal(mijn.length, 1, JSON.stringify(u));
  assert.match(mijn[0].tekst, new RegExp('^Kenmerk ' + tok + ', opdracht ' + op.id));
  assert.ok(mijn[0].namen.every((n) => /\.(pdf|xml)$/.test(n)));
  assert.equal(mijn[0].aan, op.doeladres);
  assert.equal(mijn[0].modus, 'concept');
  assert.match(mijn[0].onderwerp, new RegExp('\\[ref ' + tok + '\\]$'));
  assert.deepEqual(mijn[0].shas, JSON.parse(op.bijlagen).map((b) => b.sha256), 'de stukken van het akkoord');
  const na = t.op(op.id);
  assert.equal(na.status, 'gelukt');
  assert.equal(na.modus, 'concept');
  assert.equal(na.verzend_reservering, tok);
  assert.equal(na.vingerafdruk_koerier, na.vingerafdruk);
  assert.equal(t.fac(f.id).status, 'concept_klaar');
  const r2 = D.opdrachtResultaat(t.fdb, op.id, { status: 'gelukt', extern_id: 'x', modus: 'concept' }, { nu: VERSTUUR + 6 * MIN });
  assert.deepEqual(r2, { ok: true, gewijzigd: false });
  assert.equal(t.op(op.id).extern_id, na.extern_id);
  // volgende ronde: geen tweede
  await t.ronde(g, VERSTUUR + 2 * UUR);
  assert.equal(g.concepten(tok), 1);
});

test('teruggedraaid komt nooit mee', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.bevestig();
  assert.equal(t.call('POST', 'terugdraaien', { id: f.id }).status, 200);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  await t.ronde(g, VERSTUUR + 3 * UUR);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 0);
  assert.equal(t.op(op.id).status, 'teruggedraaid');
});

test('gewijzigde bytes na het akkoord → geweigerd + signaal, geen verzending, geen nieuwe poging', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.bevestig();
  const sha = JSON.parse(op.bijlagen)[0].sha256;
  fs.chmodSync(D.stukPad(t.fdb, sha), 0o600);
  fs.writeFileSync(D.stukPad(t.fdb, sha), Z.pdf(['iets anders']));
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 0);
  assert.equal(t.op(op.id).status, 'geweigerd');
  assert.match(t.op(op.id).fout, /beschadigd|sha256/);
  assert.equal(t.fac(f.id).status, 'verzending_mislukt');
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt' AND status = 'open' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [f.id]), 1);
  assert.ok(u.verzending.geweigerd >= 1);
  await t.ronde(g, VERSTUUR + 2 * UUR);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 0, 'geen nieuwe poging');
});

test('gewijzigd doeladres na Bevestigen → geweigerd (claim) en de consistentiecontrole vangt een wijziging ná de claim', async () => {
  const t = opzet(), g = nepGmail();
  const a = t.bevestig();
  t.fdb.db.prepare("UPDATE entiteit SET boekhoud_doel = 'nieuw-adres@acta.invalid' WHERE sleutel = ?").run(a.f.entiteit);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === a.tok).length, 0);
  assert.equal(t.op(a.op.id).status, 'geweigerd');
  // na de claim: adres of bedrag wijzigt → controleer weigert met reden, zonder inhoud
  const b = t.bevestig("entiteit <> '" + a.f.entiteit + "'");
  D.claimOpdrachten(t.fdb, VERSTUUR + 1000, { max: 50 });
  const op = t.op(b.op.id);
  assert.equal(op.status, 'opgehaald');
  assert.equal(KO.controleer(t.fdb, op).ok, true);
  t.fdb.db.prepare("UPDATE factuur SET incl = incl + 1 WHERE id = ?").run(b.f.id);
  assert.deepEqual(KO.controleer(t.fdb, op), { ok: false, reden: 'vingerafdruk wijkt af van het akkoord' });
  t.fdb.db.prepare("UPDATE factuur SET incl = incl - 1 WHERE id = ?").run(b.f.id);
  t.fdb.db.prepare("UPDATE entiteit SET boekhoud_doel = 'ander@acta.invalid' WHERE sleutel = ?").run(b.f.entiteit);
  assert.deepEqual(KO.controleer(t.fdb, op), { ok: false, reden: 'doeladres wijkt af van de entiteitentabel' });
});

test('geen resultaat (time-out vóór het concept) → na 30 min opnieuw met dezelfde sleutel; één concept', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.bevestig();
  const echt = g.verzender;
  g.verzender = async (v) => { g.verzonden.push({ token: v.token }); throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
  const u1 = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(op.id).status, 'opgehaald');
  assert.equal(t.op(op.id).verzend_reservering, tok, 'reservering staat vóór de aanroep');
  assert.ok(u1.verzending.geen_resultaat >= 1);
  g.verzender = echt;
  await t.ronde(g, VERSTUUR + 20 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 1, 'binnen 30 min niets');
  await t.ronde(g, VERSTUUR + 40 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 2, 'na 30 min opnieuw');
  assert.equal(g.concepten(tok), 1);
  assert.ok(g.zoek.some((q) => q.indexOf('subject:' + tok + ' {in:draft in:sent}') === 0), 'eerst gezocht');
  const na = t.op(op.id);
  assert.equal(na.status, 'gelukt');
  assert.equal(na.poging, 2);
  assert.equal(na.idempotentiesleutel, op.idempotentiesleutel);
  assert.equal(t.fac(f.id).status, 'concept_klaar');
});

test('antwoord verloren ná het concept → precies één concept (ook drie keer achter elkaar)', async () => {
  const t = opzet(), g = nepGmail();
  const { op, tok } = t.bevestig();
  g.verlies[tok] = 1;
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.concepten(tok), 1);
  assert.equal(t.op(op.id).status, 'opgehaald');
  const u = await t.ronde(g, VERSTUUR + 40 * MIN);
  assert.equal(u.voorronde.overgenomen >= 1, true, JSON.stringify(u.voorronde));
  assert.equal(t.op(op.id).status, 'gelukt');
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 1, 'geen tweede aanroep');
  assert.equal(g.concepten(tok), 1);
  // drie pogingen die elk zonder antwoord eindigen (de derde zou bij de claim definitief mislukken): de voorronde vindt het concept
  const b = t.bevestig("id <> '" + op.factuur + "'");
  g.verlies[b.tok] = 99;
  const weg = () => { g.mails = g.mails.filter((m) => m.onderwerp.indexOf(b.tok) < 0); };   // het concept van die poging is (nog) niet te vinden
  await t.ronde(g, VERSTUUR + 5 * MIN); weg();
  await t.ronde(g, VERSTUUR + 40 * MIN); weg();
  await t.ronde(g, VERSTUUR + 80 * MIN);
  assert.equal(t.op(b.op.id).poging, 3);
  assert.equal(t.op(b.op.id).status, 'opgehaald');
  g.verlies[b.tok] = 0;
  assert.equal(g.concepten(b.tok), 1, 'alleen het concept van poging 3 staat er');
  await t.ronde(g, VERSTUUR + 120 * MIN);
  assert.equal(t.op(b.op.id).status, 'gelukt', 'overgenomen in plaats van definitief mislukt');
  assert.equal(g.concepten(b.tok), 1);
});

test('lees-luik stuk → nul aanroepen van de verzender (een zoekfout is nooit "niet gevonden")', async () => {
  const t = opzet(), g = nepGmail();
  const { op, tok } = t.bevestig();
  g.verlies[tok] = 1;
  await t.ronde(g, VERSTUUR + 5 * MIN);
  const voor = g.verzonden.length;
  g.luikStuk = true;
  const u = await t.ronde(g, VERSTUUR + 45 * MIN);
  assert.equal(u.ok, false);
  assert.ok(u.fouten.some((x) => x.wat === 'lees-luik'));
  assert.equal(g.verzonden.length, voor, 'geen enkele aanroep zolang het lees-luik stuk is');
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 1);
  assert.equal(t.op(op.id).status, 'opgehaald');
  assert.equal(t.op(op.id).poging, 1, 'niet opnieuw geclaimd');
  g.luikStuk = false;
  // Gmail-fout in het luik (200 + melding, geen lijst): ook geen aanroep (diffreview wv855 #1)
  g.zoekMelding = 'fout bij zoeken: proef';
  const u2 = await t.ronde(g, VERSTUUR + 90 * MIN);
  assert.equal(u2.ok, false);
  assert.equal(g.verzonden.length, voor);
  assert.equal(t.op(op.id).status, 'opgehaald');
  g.zoekMelding = 'deels mislukt: proef';
  await t.ronde(g, VERSTUUR + 95 * MIN);
  assert.equal(g.verzonden.length, voor);
  g.zoekMelding = null;
  await t.ronde(g, VERSTUUR + 100 * MIN);
  assert.equal(t.op(op.id).status, 'gelukt');
  assert.equal(g.concepten(tok), 1);
});

test('een oud concept met andere stukken wordt niet overgenomen en er komt geen tweede: geweigerd + signaal (diffreview wv855 #4)', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op, tok } = t.bevestig();
  t.fdb.db.prepare('UPDATE opdracht SET verzend_reservering = ?, verzend_reservering_op = ? WHERE id = ?').run(null, null, op.id);
  g.mails.push({ id: 'mo00000000000001', aan: op.doeladres, onderwerp: 'oud [ref ' + tok + ']', snippet: 'Kenmerk ' + tok + ', opdracht 00000000000000aa.', labels: ['DRAFT'], dag_lokaal: '2026-10-22' });
  // een eerdere reservering voor deze factuur (bv. een opdracht van vóór Terug naar beoordelen) laat de koerier eerst zoeken
  const oud = t.fdb.db.prepare("SELECT id FROM opdracht WHERE factuur = ? AND id <> ?").get(f.id, op.id);
  assert.equal(oud, undefined);
  D.claimOpdrachten(t.fdb, VERSTUUR + 1000, { max: 50 });
  D.reserveer(t.fdb, op.id, { sleutel: tok, modus: 'concept', nu: VERSTUUR + 2000 });
  t.fdb.db.prepare("UPDATE opdracht SET opgehaald_op = ? WHERE id = ?").run(new Date(VERSTUUR - UUR).toISOString(), op.id);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(op.id).status, 'geweigerd');
  assert.match(t.op(op.id).fout, /al een concept met dit kenmerk/);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 0);
  assert.equal(g.concepten(tok), 1);
});

test('verkeerd geheim (401) of plafond (429) bij de verzender: geen extra poging, de ronde stopt met verzenden (diffreview wv855 #3)', async () => {
  const t = opzet(), g = nepGmail();
  t.bevestig();
  g.status = 401;
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.verzonden.length, 1, 'na de eerste 401 niets meer');
  assert.equal(u.verzending.mislukt, 0);
  assert.equal(u.verzending.geen_resultaat, 1);
  assert.ok(u.fouten.some((x) => x.soort === 'verzender_geheim'));
});

test('een upload die steeds faalt, houdt de rest niet tegen en wordt na drie keer overgeslagen (diffreview wv855 #6)', async () => {
  const t = opzet(), g = nepGmail();
  const kapot = D.stukSchrijf(t.fdb, Buffer.from('%PDF-1.4 kapot'));
  const goed = D.stukSchrijf(t.fdb, Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: GOED-1']));
  const k = D.nieuwId(), gd = D.nieuwId();
  D.voegToe(t.fdb, 'document', { id: k, sha256: kapot.sha256, naam: 'kapot.pdf', mime: 'application/pdf', bytes: kapot.bytes, soort: 'pdf', te_lezen: 1, geupload_door: 'david (proef)', aangemaakt_op: new Date(NU - UUR).toISOString() });
  D.voegToe(t.fdb, 'document', { id: gd, sha256: goed.sha256, naam: 'goed.pdf', mime: 'application/pdf', bytes: goed.bytes, soort: 'pdf', te_lezen: 1, geupload_door: 'david (proef)', aangemaakt_op: new Date(NU).toISOString() });
  const u = await t.ronde(g, NU + MIN);
  assert.equal(u.upload.gelezen, 1);
  assert.equal(u.upload.fout, 1);
  assert.equal(t.fdb.db.prepare('SELECT te_lezen FROM document WHERE id = ?').get(gd).te_lezen, 0);
  await t.ronde(g, NU + 61 * MIN); await t.ronde(g, NU + 121 * MIN);
  const u4 = await t.ronde(g, NU + 181 * MIN);
  assert.equal(u4.upload.overgeslagen, 1);
  assert.equal(u4.upload.fout, 0);
});

test('bijlagetype: alleen PDF, UBL of (afschrift) MT940 gaat mee; een foto of onbekend bestand → geweigerd, nooit als .940', () => {
  const pdfB = Z.pdf(['x']);
  assert.equal(KO.naamMetExtensie('factuur', 'application/pdf', pdfB, 'boekhouder_factuur'), 'factuur.pdf');
  assert.equal(KO.naamMetExtensie('scan.pdf', 'application/pdf', pdfB, 'boekhouder_factuur'), 'scan.pdf');
  assert.equal(KO.naamMetExtensie('f.xml', 'application/xml', Buffer.from('<?xml version="1.0"?><Invoice/>'), 'boekhouder_factuur'), 'f.xml');
  assert.equal(KO.naamMetExtensie('foto.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'boekhouder_factuur'), null);
  assert.equal(KO.naamMetExtensie('nep.pdf', 'application/pdf', Buffer.from('geen pdf'), 'boekhouder_factuur'), null);
  assert.equal(KO.naamMetExtensie('POT.sta', 'application/octet-stream', Buffer.from(':20:PROEF'), 'boekhouder_afschrift'), 'POT.940');
  assert.equal(KO.naamMetExtensie('x.940', 'application/octet-stream', Buffer.from(':20:PROEF'), 'boekhouder_factuur'), null);
});

test('mislukt max 3× dan signaal; daarna geen poging meer; Opnieuw proberen vindt een eerder concept via het token', async (tc) => {
  const t = opzet(), g = nepGmail();
  const oud = KO.GRENS.verzendingen; KO.GRENS.verzendingen = 30; tc.after(() => { KO.GRENS.verzendingen = oud; });   // het zaad heeft zelf veel claimbare opdrachten
  const { f, op, tok } = t.bevestig();
  g.status = 500;
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(op.id).status, 'mislukt');
  await t.ronde(g, VERSTUUR + 65 * MIN);
  await t.ronde(g, VERSTUUR + 125 * MIN);
  assert.equal(t.op(op.id).status, 'mislukt');
  assert.equal(t.op(op.id).poging, 3);
  assert.equal(t.fac(f.id).status, 'verzending_mislukt');
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [f.id]), 1);
  await t.ronde(g, VERSTUUR + 185 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 3);
  // stel dat poging 3 tóch een concept maakte: Opnieuw proberen → nieuwe opdracht, zelfde token → overgenomen, geen tweede
  g.status = null;
  g.mails.push({ id: 'mx00000000000001', aan: op.doeladres, onderwerp: 'x [ref ' + tok + ']', snippet: 'Kenmerk ' + tok + ', opdracht ' + op.id + '. Inkoopfactuur', labels: ['DRAFT'], dag_lokaal: '2026-10-22' });
  const r = t.call('POST', 'opnieuw', { id: f.id }, { nu: VERSTUUR + 190 * MIN });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  await t.ronde(g, Date.parse(r.j.opdracht.verstuur_na) + MIN);
  assert.equal(t.op(r.j.opdracht.id).status, 'gelukt');
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 3, 'geen vierde aanroep');
  assert.equal(g.concepten(tok), 1);
});

test('adres buiten de witte lijst → de verzender weigert → geweigerd + signaal, geen herhaling', async () => {
  const t = opzet(), g = nepGmail({ witteLijst: ['alleen-dit@acta.invalid'] });
  const { f, op, tok } = t.bevestig();
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(op.id).status, 'geweigerd');
  assert.match(t.op(op.id).fout, /witte_lijst/);
  assert.equal(t.fac(f.id).status, 'verzending_mislukt');
  await t.ronde(g, VERSTUUR + 2 * UUR);
  assert.equal(g.verzonden.filter((v) => v.token === tok).length, 1);
});

test('verzend-detectie: concept verstuurd door David → factuur verstuurd; tokens gebundeld in één zoekopdracht', async () => {
  const t = opzet(), g = nepGmail();
  const { f, tok } = t.bevestig();
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.fac(f.id).status, 'concept_klaar');
  const voor = g.zoek.length;
  await t.ronde(g, VERSTUUR + 65 * MIN);
  assert.equal(t.fac(f.id).status, 'concept_klaar', 'nog niet verstuurd');
  const detectie = g.zoek.slice(voor).filter((q) => /^in:sent subject:\(/.test(q));
  assert.ok(detectie.length >= 1 && detectie.some((q) => q.indexOf(tok) >= 0));
  g.verstuurConcept(tok);
  const u = await t.ronde(g, VERSTUUR + 125 * MIN);
  assert.equal(t.fac(f.id).status, 'verstuurd', JSON.stringify(u.detectie));
  // overzicht: concept dat 3 dagen niet verstuurd is telt mee (geen signaal)
  const b = t.bevestig("id <> '" + f.id + "'");
  await t.ronde(g, VERSTUUR + 185 * MIN);
  assert.equal(t.fac(b.f.id).status, 'concept_klaar');
  const o = t.call('GET', '', {}, { nu: VERSTUUR + 4 * 86400000 }).j;
  assert.ok(o.tellers.concept_oud >= 1);
  assert.equal(o.gezondheid.koerier.ok, true);
});

test('rondebudget en pod-plafond: wat niet past blijft opgehaald zonder reservering; het plafond houdt claims tegen', async () => {
  const t = opzet(), g = nepGmail();
  const a = t.bevestig(), b = t.bevestig("id <> '" + t.op(a.op.id).factuur + "'");
  const traag = g.verzender;
  g.verzender = async (v) => { t.klok += 3 * MIN; return traag(v); };   // elke aanroep kost 3 minuten
  const voor = g.verzonden.length;
  const u = await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.verzonden.length - voor, 1, 'na de eerste aanroep is het budget op');
  assert.equal(u.verzending.budget_op, true);
  assert.equal(u.verzending.geclaimd, 1, 'alleen geclaimd wat ook geprobeerd wordt');
  assert.equal(t.n("SELECT count(*) AS n FROM opdracht WHERE status = 'opgehaald' AND verzend_reservering IS NULL AND opgehaald_op = ?", [new Date(VERSTUUR + 5 * MIN).toISOString()]), 0);
  for (const o of [t.op(a.op.id), t.op(b.op.id)]) assert.ok(['gelukt', 'wacht'].includes(o.status), o.status);
  // plafond: 30 reserveringen in het laatste uur → geen claim
  const t2 = opzet(), g2 = nepGmail();
  const c = t2.bevestig();
  for (const o of t2.fdb.db.prepare("SELECT id FROM opdracht WHERE status <> 'wacht' LIMIT 40").all()) t2.fdb.db.prepare('UPDATE opdracht SET verzend_reservering = coalesce(verzend_reservering, ?), verzend_reservering_op = ? WHERE id = ?').run('FV' + o.id, new Date(VERSTUUR).toISOString(), o.id);
  const u2 = await t2.ronde(g2, VERSTUUR + 5 * MIN);
  assert.equal(u2.verzending.plafond, true);
  assert.equal(t2.op(c.op.id).status, 'wacht');
});

// ───────────────────────────── POT-afschrift ─────────────────────────────

test('POT-afschrift: klaarzetten → opdracht naar het afschriftadres met MT940 + PDF; concept; detectie → verstuurd; zonder adres 409', async () => {
  const t = opzet(), g = nepGmail();
  const rek = t.fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get();
  const inv = { rekening: rek.id, periode: '2026-10', mt940: { naam: 'POT-2026-10.940', bytes: Buffer.from(':20:PROEF\r\n:25:NL00TEST0000000001\r\n-') }, pdf: { naam: 'POT-2026-10.pdf', bytes: Z.pdf(['Afschrift POT 2026-10', 'synthetisch']) } };
  const pm = { soort: 'praktijkmanager', wie: 'pm', entiteiten: ['pot'] };
  assert.throws(() => F.afschriftKlaarzetten(t.fdb, pm, inv, { nu: NU }), /eigenaar/);
  const r = F.afschriftKlaarzetten(t.fdb, t.eig, inv, { nu: NU });
  const op = t.op(r.opdracht.id);
  assert.equal(op.soort, 'boekhouder_afschrift');
  assert.equal(op.doeladres, t.fdb.db.prepare("SELECT afschrift_doel FROM entiteit WHERE sleutel = 'pot'").get().afschrift_doel);
  assert.throws(() => F.afschriftKlaarzetten(t.fdb, t.eig, inv, { nu: NU }), /al in de wachtrij/);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  const v = g.verzonden.find((x) => x.token === 'FA' + r.afschrift);
  assert.ok(v, 'verstuurd als concept');
  assert.equal(v.n, 2);
  assert.match(v.onderwerp, /^Bankafschrift POT 2026-10 \[ref FA/);
  assert.equal(t.op(op.id).status, 'gelukt');
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r.afschrift).status, 'in_wachtrij', 'concept: nog niet verstuurd');
  g.verstuurConcept('FA' + r.afschrift);
  await t.ronde(g, VERSTUUR + 65 * MIN);
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r.afschrift).status, 'verstuurd');
  t.fdb.db.prepare("UPDATE entiteit SET afschrift_doel = NULL WHERE sleutel = 'pot'").run();
  const voor = t.n('SELECT count(*) AS n FROM document');
  assert.throws(() => F.afschriftKlaarzetten(t.fdb, t.eig, Object.assign({}, inv, { periode: '2026-11' }), { nu: NU }), /geen afschriftadres/);
  assert.equal(t.n('SELECT count(*) AS n FROM document'), voor, 'geen losse stukken');
});

// ───────────────────────────── binnenkomend: uploads en verzamelpostvak ─────────────────────────────

test('te_lezen-upload: de koerier leest de PDF (pdftotext) en maakt de factuur; de tekst komt nergens in de database', async () => {
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  const bytes = Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: KOERIER-0001', 'Factuurdatum: 20-10-2026', 'Totaal incl. btw: EUR 60,50',
    'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban, 'Merkwoord Zwaluwstaartvlinder']);
  const st = D.stukSchrijf(t.fdb, bytes);
  const did = D.nieuwId();
  D.voegToe(t.fdb, 'document', { id: did, sha256: st.sha256, naam: 'portaal.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', te_lezen: 1, geupload_door: 'david (proef)', aangemaakt_op: new Date(NU).toISOString() });
  const u = await t.ronde(g, NU + MIN);
  assert.equal(u.upload.gelezen, 1, JSON.stringify(u));
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE document = ?').get(did);
  assert.ok(f);
  assert.equal(f.nummer, 'KOERIER-0001');
  assert.equal(t.fdb.db.prepare('SELECT te_lezen FROM document WHERE id = ?').get(did).te_lezen, 0);
  t.fdb.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const s of ['', '-wal']) { const p = t.fdb.pad + s; if (fs.existsSync(p)) assert.ok(fs.readFileSync(p).indexOf('Zwaluwstaartvlinder') < 0, 'tekst niet in ' + path.basename(p)); }
  assert.equal(t.n("SELECT count(*) AS n FROM bron_ronde r JOIN bron b ON b.id = r.bron WHERE b.soort = 'upload'"), 1);
});

test('verzamelpostvak: uit → niet gelezen; aan → paginering (venster halveren), 8 MB-grens, doorgestuurde mail, één keer per bericht', async () => {
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  // 30 mails op verschillende dagen (> 25: het venster moet halveren), één te grote, één doorgestuurde
  for (let i = 0; i < 30; i++) {
    const dag = K.plusDagen('2026-10-22', -(i % 2));   // binnen het venster (2 dagen vóór de laatste geslaagde ronde van het zaad)
    const id = 'in' + String(i).padStart(14, '0');
    g.mails.push({ id, thread_id: id, van: i === 1 ? '"David" <d.schaap@gmail.com>' : 'facturen@leverancier-a.invalid', aan: 'd.schaap+facturen@gmail.com',
      onderwerp: i === 1 ? 'Fwd: Factuur' : 'Factuur ' + i, labels: ['INBOX'], datum: dag + 'T22:30:00.000Z', datum_lokaal: K.plusDagen(dag, 1) + 'T00:30:00+02:00', dag_lokaal: dag, te_groot: i === 2 });
    g.bijlagen[id] = [{ naam: 'factuur-' + i + '.pdf', mime: 'application/pdf', bytes: Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: PV-' + i, 'Factuurdatum: 15-10-2026',
      'Totaal incl. btw: EUR ' + (100 + i) + ',00', 'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban]) }];
  }
  g.teksten.in00000000000001 = 'Zie bijlage\n\n---------- Forwarded message ---------\nFrom: Leverancier A <facturen@leverancier-a.invalid>\n';
  const u0 = await t.ronde(g, NU);
  assert.deepEqual(u0.postvak, { aan: false });
  assert.ok(!g.zoek.some((q) => /has:attachment/.test(q)), 'bron uit: postvak niet gelezen');
  assert.equal(t.fdb.db.prepare("UPDATE bron SET actief = 1 WHERE soort = 'verzamelpostvak'").run().changes, 1);
  const u = await t.ronde(g, NU + 10 * MIN);
  assert.equal(u.postvak.ok, true, JSON.stringify(u.postvak));
  assert.equal(u.postvak.aantallen.nieuw, 30);
  assert.equal(u.postvak.aantallen.te_groot, 1);
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id LIKE 'in%'"), 30);
  assert.equal(t.n("SELECT count(*) AS n FROM factuur f JOIN bericht b ON b.id = f.bericht WHERE b.message_id LIKE 'in%'"), 29);
  assert.equal(t.fdb.db.prepare("SELECT afzender FROM bericht WHERE message_id = 'in00000000000001'").get().afzender, 'facturen@leverancier-a.invalid');
  assert.ok(g.zoek.filter((q) => /has:attachment/.test(q)).length > 1, 'venster gehalveerd');
  const zoekVoor = g.zoek.length;
  const u2 = await t.ronde(g, NU + 70 * MIN);
  assert.equal(u2.postvak.aantallen.nieuw, 0, 'niets dubbel');
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id LIKE 'in%'"), 30);
  assert.ok(g.zoek.length > zoekVoor);
  // lees-luik stuk tijdens het zoeken → hartslag rood, niets kapot
  g.luikStuk = true;
  const u3 = await t.ronde(g, NU + 130 * MIN);
  assert.equal(u3.ok, false);
  const kr = JSON.parse(D.metaLees(t.fdb, 'koerier_ronde'));
  assert.equal(kr.ok, false);
  assert.match(kr.fout, /lees-luik/);
});

test('back-up: de eerste ronde na 02:00 (Nederlandse tijd) op een dag zonder back-up; daarna die dag niet meer', async () => {
  const t = opzet(), g = nepGmail();
  const u1 = await t.ronde(g, Date.parse('2026-10-22T23:30:00Z'));   // 01:30 lokaal op de 23e: nog niet
  assert.equal(u1.backup, undefined);
  const u2 = await t.ronde(g, Date.parse('2026-10-23T00:05:00Z'));   // 02:05 lokaal
  assert.equal(u2.backup.ok, true);
  assert.equal(u2.backup.dag, '2026-10-23');
  const u3 = await t.ronde(g, Date.parse('2026-10-23T01:05:00Z'));
  assert.equal(u3.backup, undefined);
});

// ───────────────────────────── F3-punten ─────────────────────────────

test('creditnota: nooit te_betalen (ook met zelf of incasso), niet op de betaallijst, geen signaal te betalen/incasso niet gezien', () => {
  const t = opzet();
  const f = t.fdb.db.prepare("SELECT * FROM factuur WHERE status = 'te_beoordelen' AND entiteit IN ('tolgaarde','groenhouten') AND iban_nieuw = 0 AND patientkenmerk = 0 AND valuta = 'EUR' AND incl > 0 LIMIT 1").get();
  t.fdb.db.prepare("UPDATE factuur SET soort = 'creditnota', incl = -incl, excl = -excl, btw = -btw, vervaldatum = '2026-09-01' WHERE id = ?").run(f.id);
  const r = t.call('POST', 'bevestig', { id: f.id, betaalwijze: 'zelf' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.betaalspoor, 'betaald_vooraf');
  assert.ok(!t.call('GET', 'betalen').j.te_betalen.some((x) => x.id === f.id));
  assert.equal(K.betaalspoorBegin('incasso', { soort: 'creditnota' }), 'betaald_vooraf');
  assert.equal(K.betaalspoorBegin('zelf', { incl: -100 }), 'betaald_vooraf');
  assert.equal(K.betaalspoorBegin('zelf', { incl: 100 }), 'te_betalen');
  // ook een oude creditnota op te_betalen geeft geen signaal en staat niet op de lijst
  t.fdb.db.prepare("UPDATE factuur SET betaalspoor = 'te_betalen' WHERE id = ?").run(f.id);
  F.bankcontroleToepassen(t.fdb, NU);
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort IN ('te_betalen_niet_betaald','incasso_niet_gezien') AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [f.id]), 0);
  assert.ok(!t.call('GET', 'betalen').j.te_betalen.some((x) => x.id === f.id));
});

test('kandidaten: afschrijvingen van de entiteit, 60 dagen, ± 5 %, rol- en POT-filter', () => {
  const t = opzet();
  const rek = t.fdb.db.prepare("SELECT * FROM rekening WHERE entiteit = 'tolgaarde' AND controle = 1").get();
  const sid = D.nieuwId();
  D.voegToe(t.fdb, 'signaal', { id: sid, sleutel: 'proef-kand', soort: 'te_betalen_niet_betaald', titel: 'Te betalen, niet betaald', entiteit: 'tolgaarde', bedrag_centen: 100000, aangemaakt_op: new Date(NU).toISOString() });
  const tx = (bedrag, dag, ref) => D.voegToe(t.fdb, 'bank_transactie', { id: D.nieuwId(), bestand: t.fdb.db.prepare('SELECT id FROM bank_bestand LIMIT 1').get().id, rekening: rek.id, entiteit: 'tolgaarde',
    eigen_iban: rek.iban, boekdatum: dag, bedrag_centen: bedrag, entry_ref: 'proef-kand-' + ref, formaat: rek.bank_formaat === 'bankluis' ? 'ing_csv' : rek.bank_formaat, aangemaakt_op: new Date(NU).toISOString() });
  const a = tx(-100000, '2026-10-10', 1), b = tx(-104000, '2026-10-12', 2); tx(-106000, '2026-10-12', 3); tx(-100000, '2026-07-01', 4); tx(100000, '2026-10-12', 5);
  const r = t.call('GET', 'kandidaten/' + sid);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const ids = r.j.kandidaten.map((k) => k.id);
  assert.ok(ids.includes(a) && ids.includes(b), 'binnen 5 %');
  assert.equal(ids.indexOf(a), 0, 'dichtstbijzijnde eerst');
  assert.equal(ids.length, 2, 'buiten 5 %, ouder dan 60 dagen en bijschrijvingen niet');
  // POT-signaal: praktijkmanager 404
  const ps = D.nieuwId();
  D.voegToe(t.fdb, 'signaal', { id: ps, sleutel: 'proef-kand-pot', soort: 'te_betalen_niet_betaald', titel: 'x', entiteit: 'pot', bedrag_centen: 1000, alleen_eigenaar: 1, aangemaakt_op: new Date(NU).toISOString() });
  t.fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run();
  const pm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  assert.equal(t.call('GET', 'kandidaten/' + ps, {}, { rol: pm }).status, 404);
  assert.equal(t.call('GET', 'kandidaten/' + ps).status, 200);
  const ander = t.fdb.db.prepare("SELECT id FROM signaal WHERE soort = 'geen_factuur' LIMIT 1").get();
  if (ander) assert.equal(t.call('GET', 'kandidaten/' + ander.id).status, 409);
});

test('server.js: /facturen-ronde achter rolPoort + body-secret, één ronde tegelijk; passieve kant geen ronde; verzender met het mailconcept-geheim', () => {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const i = s.indexOf("req.url === '/facturen-ronde'");
  const blok = s.slice(i, s.indexOf("// ── wv820", i));
  assert.match(blok, /return rolPoort\(res, function/);
  assert.match(blok, /timingSafeEqual/);
  assert.match(blok, /if \(!fdb\) return stuur\(409/);
  assert.match(blok, /facturenRondeBezig && Date\.now\(\) - facturenRondeBezig\.op < 10 \* 60000\) return stuur\(503/);
  assert.match(blok, /if \(facturenRondeBezig === mijn\) facturenRondeBezig = null/);
  assert.match(s, /function facturenMagOpenen\(\) \{ return ROL_KANT === 'olares' && rolPrimair\(\); \}/);
  const vz = s.slice(s.indexOf('async function facturenVerzender'), s.indexOf('function facturenIo'));
  assert.match(vz, /process\.env\.N8N_WEBHOOK_MAILCONCEPT/);
  assert.match(vz, /AbortSignal\.timeout\(120000\)/);
  assert.ok(!/send|versturen\s*=/.test(vz.replace(/zekerNietVerstuurd|fd\.append\('modus', v\.modus\)/g, '')), 'de pod kiest geen eigen verzendroute');
});

test('schaduw PDF-lezer (wv1431): na de transactie stukken + kern-uitkomst naar io.pdfSchaduw; een fout daar raakt de ronde niet', async () => {
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  const bytes = Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: SCHADUW-0001', 'Factuurdatum: 20-10-2026', 'Totaal incl. btw: EUR 60,50',
    'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban]);
  const st = D.stukSchrijf(t.fdb, bytes);
  D.voegToe(t.fdb, 'document', { id: D.nieuwId(), sha256: st.sha256, naam: 'portaal.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', te_lezen: 1, geupload_door: 'david (proef)', aangemaakt_op: new Date(NU).toISOString() });
  const gezien = [];
  let inTransactie = null;
  const u = await t.ronde(g, NU + MIN, { pdfSchaduw: (job) => { inTransactie = t.fdb.db.isTransaction; gezien.push(job); } });
  assert.equal(u.upload.gelezen, 1);
  assert.equal(gezien.length, 1);
  assert.equal(inTransactie, false, 'pas na de transactie');
  const j = gezien[0];
  assert.equal(j.soort, 'facturen');
  assert.equal(j.documenten[0].sha256, st.sha256);
  assert.ok(Buffer.isBuffer(j.documenten[0].bytes) && j.documenten[0].bytes.equals(bytes));
  assert.match(j.documenten[0].tekst, /SCHADUW-0001/);
  assert.equal(j.kern[0].document, st.sha256);
  assert.equal(j.kern[0].nummer, 'SCHADUW-0001');
  assert.equal(j.kern[0].incl, 6050);
  assert.equal(j.overgeslagen, 0, 'upload: niets overgeslagen');
  // postvak aan, schaduw gooit: de ronde gaat gewoon door
  assert.equal(t.fdb.db.prepare("UPDATE bron SET actief = 1 WHERE soort = 'verzamelpostvak'").run().changes, 1);
  g.mails.push({ id: 'sch00000000000001', thread_id: 'x', van: 'facturen@leverancier-a.invalid', aan: 'd.schaap+facturen@gmail.com', onderwerp: 'Factuur', labels: ['INBOX'],
    datum: '2026-10-22T08:00:00.000Z', datum_lokaal: '2026-10-22T10:00:00+02:00', dag_lokaal: '2026-10-22' });
  g.bijlagen.sch00000000000001 = [{ naam: 'f.pdf', mime: 'application/pdf', bytes: Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: SCHADUW-0002', 'Totaal incl. btw: EUR 70,00', 'IBAN ' + lev.iban]) }];
  const u2 = await t.ronde(g, NU + 10 * MIN, { pdfSchaduw: () => { throw new Error('schaduw stuk'); } });
  assert.equal(u2.postvak.ok, true, JSON.stringify(u2.postvak));
  assert.equal(t.n("SELECT count(*) AS n FROM factuur WHERE nummer = 'SCHADUW-0002'"), 1);
  // een bijlage die niet als document meegaat (beeld) telt als overgeslagen: de PDF-lezer sluit dan het hele bericht
  g.mails.push({ id: 'sch00000000000002', thread_id: 'y', van: 'facturen@leverancier-a.invalid', aan: 'd.schaap+facturen@gmail.com', onderwerp: 'Factuur', labels: ['INBOX'],
    datum: '2026-10-22T09:00:00.000Z', datum_lokaal: '2026-10-22T11:00:00+02:00', dag_lokaal: '2026-10-22' });
  g.bijlagen.sch00000000000002 = [{ naam: 'f3.pdf', mime: 'application/pdf', bytes: Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: SCHADUW-0003', 'Totaal incl. btw: EUR 80,00', 'IBAN ' + lev.iban]) },
    { naam: 'logo.png', mime: 'image/png', bytes: Buffer.from('nep-png') }];
  const gezien3 = [];
  await t.ronde(g, NU + 20 * MIN, { pdfSchaduw: (job) => gezien3.push(job) });
  assert.equal(gezien3.length, 1);
  assert.equal(gezien3[0].overgeslagen, 1);
});

test('live PDF-lezer (wv1921): vóór de transactie per document een kandidaat van Claude; de factuur krijgt de naam van de afzender; geen antwoord = tekstregels', async () => {
  const t = opzet(), g = nepGmail();
  assert.equal(t.fdb.db.prepare("UPDATE bron SET actief = 1 WHERE soort = 'verzamelpostvak'").run().changes, 1);
  const pdf = Z.pdf(['Factuur', 'Factuurnummer: LIVE-0001', 'Factuurdatum: 20-10-2026', 'Totaal incl. btw: EUR 45,82', 'Hosting Voorbeeld B.V.']);
  g.mails.push({ id: 'live0000000000001', thread_id: 'l', van: 'noreply@hosting-voorbeeld.invalid', aan: 'd.schaap+facturen@gmail.com', onderwerp: 'Factuur LIVE-0001', labels: ['INBOX'],
    datum: '2026-10-22T08:00:00.000Z', datum_lokaal: '2026-10-22T10:00:00+02:00', dag_lokaal: '2026-10-22' });
  g.bijlagen.live0000000000001 = [{ naam: 'live.pdf', mime: 'application/pdf', bytes: pdf }];
  const jobs = [];
  let inTransactie = null;
  const pdfLive = async (job) => {
    inTransactie = t.fdb.db.isTransaction; jobs.push(job);
    const d = job.documenten[0];
    return { open: true, perDoc: { [d.sha256]: { kandidaat: { live: true, soort_stuk: 'factuur', factuurnummer: 'LIVE-0001', bedrag_incl: '45.82', leverancier_naam: 'Hosting Voorbeeld B.V.' }, ocr_tekst: 'Totaal incl. btw: EUR 45,82 Hosting Voorbeeld B.V.' } } };
  };
  const u = await t.ronde(g, NU + MIN, { pdfLive });
  assert.equal(u.postvak.ok, true, JSON.stringify(u.postvak));
  assert.equal(u.postvak.aantallen.claude, 1);
  assert.equal(inTransactie, false, 'Claude vóór de transactie, niet erin');
  assert.equal(jobs[0].overgeslagen, 0);
  assert.ok(Buffer.isBuffer(jobs[0].documenten[0].bytes));
  assert.equal(jobs[0].bericht.afzender, 'noreply@hosting-voorbeeld.invalid');
  const f = t.fdb.db.prepare("SELECT * FROM factuur WHERE nummer = 'LIVE-0001'").get();
  assert.equal(f.leverancier_naam, 'Hosting Voorbeeld B.V.');
  assert.equal(f.incl, 4582);
  assert.ok(t.n("SELECT count(*) AS n FROM besluit WHERE factuur = '" + f.id + "' AND bron = 'model' AND veld = 'leverancier_naam'") === 1);
  // pdfLive gooit of geeft niets: de ronde gaat door op de tekstregels
  g.mails.push({ id: 'live0000000000002', thread_id: 'm', van: 'noreply@hosting-voorbeeld.invalid', aan: 'd.schaap+facturen@gmail.com', onderwerp: 'Factuur LIVE-0002', labels: ['INBOX'],
    datum: '2026-10-22T09:00:00.000Z', datum_lokaal: '2026-10-22T11:00:00+02:00', dag_lokaal: '2026-10-22' });
  g.bijlagen.live0000000000002 = [{ naam: 'live2.pdf', mime: 'application/pdf', bytes: Z.pdf(['Factuur', 'Factuurnummer: LIVE-0002', 'Totaal incl. btw: EUR 10,00']) }];
  const u2 = await t.ronde(g, NU + 10 * MIN, { pdfLive: async () => { throw new Error('api weg'); } });
  assert.equal(u2.postvak.ok, true);
  const f2 = t.fdb.db.prepare("SELECT * FROM factuur WHERE nummer = 'LIVE-0002'").get();
  assert.equal(f2.leverancier_naam, null);
  assert.equal(f2.incl, 1000);
});
