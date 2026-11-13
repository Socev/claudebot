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
        // wv1973: de label-zoekvraag van MailMan (label:FACTUUR) ziet alleen mail met dat label; de gewone zoekvraag ziet die niet
        lijst = /label:FACTUUR/.test(q) ? lijst.filter((m) => m.labels.includes('FACTUUR')) : lijst.filter((m) => !m.labels.includes('FACTUUR'));
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
  // wv2852: ABN-MT940 begint met de kop BIC / 940 / BIC vóór ':20:' (zo maakt pot-afschrift.js hem ook) → verzendbaar; andere tekst ervoor niet
  const abn = 'ABNANL2A\r\n940\r\nABNANL2A\r\n:20:ABN AMRO BANK NV\r\n:25:NL00TEST0000000001\r\n-';
  assert.equal(KO.naamMetExtensie('POT-2026-10.sta', 'application/octet-stream', Buffer.from(abn), 'boekhouder_afschrift'), 'POT-2026-10.940');
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from('ABNANL2AXXX\n940\nABNANL2AXXX\n:20:X'), 'boekhouder_afschrift'), 'a.940');
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from(abn), 'boekhouder_factuur'), null);
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from('Hallo wereld\r\n940\r\nABNANL2A\r\n:20:X'), 'boekhouder_afschrift'), null);
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from('ABNANL2A\r\n941\r\nABNANL2A\r\n:20:X'), 'boekhouder_afschrift'), null);
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from('ABNANL2A\r\n940\r\n:20:X'), 'boekhouder_afschrift'), null);
  assert.equal(KO.naamMetExtensie('a.sta', 'application/octet-stream', Buffer.from('tekst\n:20:X'), 'boekhouder_afschrift'), null);
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
  const inv = { rekening: rek.id, periode: '2026-10', mt940: { naam: 'POT-2026-10.sta', bytes: Buffer.from('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:PROEF\r\n:25:NL00TEST0000000001\r\n-') }, pdf: { naam: 'POT-2026-10.pdf', bytes: Z.pdf(['Afschrift POT 2026-10', 'synthetisch']) } };
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

test('wv2992 afschriftsignaal: eigen knoppen, geen dubbele opdracht via de knop, gelukte latere verzending sluit het signaal (vervallen)', async () => {
  const t = opzet(), g = nepGmail();
  const rek = t.fdb.db.prepare("SELECT id FROM rekening WHERE entiteit = 'pot'").get();
  const pdf = { naam: 'POT-2026-10.pdf', bytes: Z.pdf(['Afschrift POT 2026-10', 'synthetisch']) };
  const goed = { naam: 'POT-2026-10.sta', bytes: Buffer.from('ABNANL2A\r\n940\r\nABNANL2A\r\n:20:PROEF\r\n:25:NL00TEST0000000001\r\n-') };
  const fout = { naam: 'POT-2026-10.sta', bytes: Buffer.from('tekst\n:20:PROEF') };   // geen verzendbaar bijlagetype → geweigerd (zoals 9-11)
  const sig = (afs) => t.fdb.db.prepare("SELECT * FROM signaal WHERE soort = 'verzending_mislukt' AND json_extract(details, '$.afschrift') = ? ORDER BY aangemaakt_op, rowid").all(afs);
  const inLijst = (id) => t.call('GET', 'bank').j.signalen.find((x) => x.id === id);
  const opdrachten = (afs) => t.n('SELECT count(*) AS n FROM opdracht WHERE afschrift = ?', [afs]);

  // (A) zoals 9/10-11: geweigerd → signaal; David zet het afschrift opnieuw klaar (POT-app) → gelukt → het oude signaal vervalt vanzelf
  const r1 = F.afschriftKlaarzetten(t.fdb, t.eig, { rekening: rek.id, periode: '2026-10', mt940: fout, pdf }, { nu: NU });
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(r1.opdracht.id).status, 'geweigerd');
  const [s1] = sig(r1.afschrift);
  assert.ok(s1 && s1.status === 'open', 'signaal na weigering');
  assert.deepEqual(JSON.parse(s1.facturen), []);
  assert.equal(JSON.parse(s1.details).periode, '2026-10');
  assert.deepEqual(inLijst(s1.id).knoppen.map((k) => k.knop), ['opnieuw_proberen', 'al_geregeld'], 'afschrift: geen Terug naar Beoordelen');
  assert.equal(inLijst(s1.id).knoppen[1].label, 'Weg, al geregeld');
  assert.equal(t.call('POST', 'signaal', { id: s1.id, knop: 'terug_naar_beoordelen' }).status, 400);
  const r2 = F.afschriftKlaarzetten(t.fdb, t.eig, { rekening: rek.id, periode: '2026-10', mt940: goed, pdf }, { nu: NU + 2 * UUR });
  // er loopt nu een opdracht: Opnieuw proberen staat niet in de lijst en de route weigert (geen tweede opdracht naar de boekhouder)
  assert.deepEqual(inLijst(s1.id).knoppen.map((k) => k.knop), ['al_geregeld']);
  const n0 = opdrachten(r1.afschrift);
  const x = t.call('POST', 'signaal', { id: s1.id, knop: 'opnieuw_proberen' });
  assert.equal(x.status, 409, JSON.stringify(x.j));
  assert.match(JSON.stringify(x.j), /loopt al een verzending/);
  assert.equal(opdrachten(r1.afschrift), n0, 'geen extra opdracht');
  assert.equal(t.fdb.db.prepare('SELECT status FROM signaal WHERE id = ?').get(s1.id).status, 'open', 'weigering laat het signaal open');
  await t.ronde(g, NU + 2 * UUR + 35 * MIN);
  assert.equal(t.op(r2.opdracht.id).status, 'gelukt');
  const d1 = t.fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(s1.id);
  assert.equal(d1.status, 'afgehandeld');
  assert.equal(d1.afhandeling, 'vervallen');
  assert.equal(d1.wie, 'pod');
  assert.ok(d1.les.includes(r2.opdracht.id), 'les noemt de gelukte opdracht');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'signaal_vervallen' AND object_id = ? AND wie = 'pod'", [s1.id]), 1);
  assert.equal(inLijst(s1.id), undefined, 'niet meer bij de open signalen');
  // na de gelukte verzending: ook met de route geen nieuwe opdracht voor dit afschrift
  assert.match(JSON.stringify(t.call('POST', 'signaal', { id: s1.id, knop: 'opnieuw_proberen' }).j), /niet_open|al afgehandeld/);
  // een tweede open signaal over dit afschrift (bv. een oude weigering) kan na de gelukte verzending niet meer opnieuw
  t.fdb.db.prepare("UPDATE signaal SET status = 'open', afhandeling = NULL, les = NULL, wie = NULL, wanneer = NULL WHERE id = ?").run(s1.id);
  assert.deepEqual(inLijst(s1.id).knoppen.map((k) => k.knop), ['al_geregeld']);
  const y = t.call('POST', 'signaal', { id: s1.id, knop: 'opnieuw_proberen' });
  assert.equal(y.status, 409);
  assert.match(JSON.stringify(y.j), /al gelukt/);
  assert.equal(opdrachten(r1.afschrift), n0);

  // (B) Opnieuw proberen met de knop: dezelfde bestanden opnieuw in de wachtrij, één nieuwe opdracht; twee keer drukken = nog steeds één
  const r3 = F.afschriftKlaarzetten(t.fdb, t.eig, { rekening: rek.id, periode: '2026-09', mt940: goed, pdf }, { nu: NU + 3 * UUR });
  assert.ok(D.claimOpdrachten(t.fdb, NU + 4 * UUR).opdrachten.some((o) => o.id === r3.opdracht.id));
  assert.equal(D.opdrachtResultaat(t.fdb, r3.opdracht.id, { status: 'geweigerd', fout: 'proef' }, { nu: NU + 4 * UUR }).ok, true);
  const [s3] = sig(r3.afschrift);
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r3.afschrift).status, 'klaar');
  const k = t.call('POST', 'signaal', { id: s3.id, knop: 'opnieuw_proberen' }, { nu: NU + 5 * UUR });
  assert.equal(k.status, 200, JSON.stringify(k.j));
  assert.match(k.j.les, /bankafschrift van september 2026 opnieuw gestart/);
  const nieuw = t.fdb.db.prepare("SELECT * FROM opdracht WHERE afschrift = ? AND status = 'wacht'").all(r3.afschrift);
  assert.equal(nieuw.length, 1);
  assert.deepEqual(JSON.parse(nieuw[0].bijlagen).map((b) => b.sha256), JSON.parse(t.op(r3.opdracht.id).bijlagen).map((b) => b.sha256), 'dezelfde bestanden');
  assert.equal(nieuw[0].doeladres, t.op(r3.opdracht.id).doeladres);
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r3.afschrift).status, 'in_wachtrij');
  assert.equal(t.call('POST', 'signaal', { id: s3.id, knop: 'opnieuw_proberen' }, { nu: NU + 5 * UUR }).status, 409, 'al afgehandeld');
  assert.equal(opdrachten(r3.afschrift), 2);
  t.fdb.db.prepare("UPDATE gebruiker SET actief = 1 WHERE rol = 'praktijkmanager'").run();
  const rolPm = F.rolVoor(t.fdb, { ingang: 'fac', email: 'praktijkmanager@voorbeeld.invalid' });
  assert.ok(rolPm, 'praktijkmanager uit het zaad');

  // (C) Weg, al geregeld: sluit zonder gevolg, met les
  const r4 = F.afschriftKlaarzetten(t.fdb, t.eig, { rekening: rek.id, periode: '2025-08', mt940: goed, pdf }, { nu: NU + 6 * UUR });
  D.claimOpdrachten(t.fdb, NU + 7 * UUR);
  D.opdrachtResultaat(t.fdb, r4.opdracht.id, { status: 'geweigerd', fout: 'proef' }, { nu: NU + 7 * UUR });
  const [s4] = sig(r4.afschrift);
  assert.equal(s4.alleen_eigenaar, 1);
  assert.equal(t.call('POST', 'signaal', { id: s4.id, knop: 'al_geregeld' }, { rol: rolPm, nu: NU + 8 * UUR }).status, 404, 'POT-signaal: alleen de eigenaar');
  const w = t.call('POST', 'signaal', { id: s4.id, knop: 'al_geregeld' }, { nu: NU + 8 * UUR });
  assert.equal(w.status, 200, JSON.stringify(w.j));
  const d4 = t.fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(s4.id);
  assert.equal(d4.afhandeling, 'al_geregeld');
  assert.match(d4.les, /augustus 2025 was al geregeld/);
  assert.equal(opdrachten(r4.afschrift), 1, 'geen nieuwe opdracht');
  assert.equal(t.fdb.db.prepare('SELECT status FROM pot_afschrift WHERE id = ?').get(r4.afschrift).status, 'klaar');
});

test('wv2992 factuursignaal: knoppen ongewijzigd; een gelukte latere opdracht voor dezelfde factuur sluit het open signaal, een ander signaal blijft', async () => {
  const t = opzet(), g = nepGmail();
  const { f, op } = t.bevestig();
  const ander = t.fdb.db.prepare("SELECT id FROM factuur WHERE id <> ? LIMIT 1").get(f.id).id;
  const B = require(path.join(ROOT, 'facturen-bank.js'));
  const zet = (fid, opId) => { const s = B.maakSignaal('verzending_mislukt', { facturen: [fid], entiteit: f.entiteit, details: { opdracht: opId, status: 'geweigerd' }, sleutel_extra: 'op=' + opId });
    t.fdb.db.prepare('INSERT INTO signaal (id, sleutel, soort, titel, entiteit, facturen, details, aangemaakt_op) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(D.nieuwId(), s.sleutel, s.soort, s.titel, s.entiteit, JSON.stringify(s.facturen), JSON.stringify(s.details), new Date(NU).toISOString());
    return t.fdb.db.prepare('SELECT * FROM signaal WHERE sleutel = ?').get(s.sleutel); };
  const oud = zet(f.id, 'eerdereopdracht'), los = zet(ander, 'anderopdracht');
  assert.deepEqual(t.call('GET', 'bank').j.signalen.find((x) => x.id === oud.id).knoppen.map((k) => k.knop), ['opnieuw_proberen', 'terug_naar_beoordelen']);
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(t.op(op.id).status, 'gelukt');
  const d = t.fdb.db.prepare('SELECT * FROM signaal WHERE id = ?').get(oud.id);
  assert.equal(d.status, 'afgehandeld');
  assert.equal(d.afhandeling, 'vervallen');
  assert.ok(d.les.includes(op.id));
  assert.equal(t.fdb.db.prepare('SELECT status FROM signaal WHERE id = ?').get(los.id).status, 'open', 'signaal over een andere factuur blijft');
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

test('verzamelpostvak + MailMan (wv1973, bouwplan O.6): koerier_query_label kijkt 14 dagen terug, los van het venster van de gewone zoekvraag', async () => {
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  const dag = K.plusDagen('2026-10-22', -10);   // ver buiten "laatste geslaagde ronde min 2 dagen", binnen 14 dagen
  g.mails.push({ id: 'lab0000000000001', thread_id: 'lab0000000000001', van: 'facturen@leverancier-a.invalid', aan: 'iemand@voorbeeld.invalid', onderwerp: 'Uw factuur',
    labels: ['INBOX', 'FACTUUR'], datum: dag + 'T08:00:00.000Z', datum_lokaal: dag + 'T10:00:00+02:00', dag_lokaal: dag });
  g.bijlagen.lab0000000000001 = [{ naam: 'factuur-lab.pdf', mime: 'application/pdf', bytes: Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: LAB-1', 'Factuurdatum: 12-10-2026',
    'Totaal incl. btw: EUR 77,00', 'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban]) }];
  t.fdb.db.prepare("UPDATE bron SET actief = 1 WHERE soort = 'verzamelpostvak'").run();
  const u0 = await t.ronde(g, NU);
  assert.equal(u0.postvak.ok, true);
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id = 'lab0000000000001'"), 0, 'zonder koerier_query_label: niet gezocht');
  assert.ok(!g.zoek.some((q) => /label:FACTUUR/.test(q)));
  D.metaZet(t.fdb, 'koerier_query_label', 'label:FACTUUR has:attachment');
  const u = await t.ronde(g, NU + 70 * MIN);
  assert.equal(u.postvak.ok, true, JSON.stringify(u.postvak));
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id = 'lab0000000000001'"), 1);
  const q = g.zoek.filter((x) => /label:FACTUUR/.test(x));
  assert.ok(q.length >= 1);
  assert.match(q[0], new RegExp('after:' + K.plusDagen('2026-10-22', -15).replace(/-/g, '/')));
  // volgende ronde: niets dubbel
  const u2 = await t.ronde(g, NU + 130 * MIN);
  assert.equal(u2.postvak.aantallen.nieuw, 0);
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id = 'lab0000000000001'"), 1);
});

test('wv2464: eigen verzonden mail aan anderen (boekstuk aan de boekhouder) komt niet uit het verzamelpostvak; aan de eigen +facturen-ingang wel', async () => {
  assert.equal(KO.eigenVerzondenAanAnderen({ labels: ['SENT'], aan: 'Boekhouder <boekhouder@kantoor.invalid>' }, ['d.schaap@gmail.com']), true);
  assert.equal(KO.eigenVerzondenAanAnderen({ labels: ['SENT', 'INBOX'], aan: 'd.schaap+facturen@gmail.com' }, ['d.schaap@gmail.com']), false);
  assert.equal(KO.eigenVerzondenAanAnderen({ labels: ['INBOX'], aan: 'iemand@voorbeeld.invalid' }, ['d.schaap@gmail.com']), false);
  assert.equal(KO.eigenVerzondenAanAnderen({ aan: 'iemand@voorbeeld.invalid' }, ['d.schaap@gmail.com']), false);
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  const dag = '2026-10-21';
  const stuk = (nr) => Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: ' + nr, 'Factuurdatum: 12-10-2026', 'Totaal incl. btw: EUR 7,99', 'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban]);
  g.mails.push({ id: 'eig0000000000001', thread_id: 'eig0000000000001', van: 'David <d.schaap@gmail.com>', aan: 'boekhouder@kantoor.invalid', onderwerp: 'Boekstuk oktober',
    labels: ['INBOX', 'SENT', 'FACTUUR'], datum: dag + 'T08:00:00.000Z', datum_lokaal: dag + 'T10:00:00+02:00', dag_lokaal: dag });
  g.bijlagen.eig0000000000001 = [{ naam: 'boekstuk.pdf', mime: 'application/pdf', bytes: stuk('EIG-1') }];
  g.mails.push({ id: 'eig0000000000002', thread_id: 'eig0000000000002', van: 'David <d.schaap@gmail.com>', aan: 'd.schaap+facturen@gmail.com', onderwerp: 'Fwd: factuur',
    labels: ['INBOX', 'SENT', 'FACTUUR'], datum: dag + 'T09:00:00.000Z', datum_lokaal: dag + 'T11:00:00+02:00', dag_lokaal: dag });
  g.bijlagen.eig0000000000002 = [{ naam: 'factuur.pdf', mime: 'application/pdf', bytes: stuk('EIG-2') }];
  D.metaZet(t.fdb, 'koerier_query_label', 'label:FACTUUR has:attachment');
  t.fdb.db.prepare("UPDATE bron SET actief = 1 WHERE soort = 'verzamelpostvak'").run();
  const u = await t.ronde(g, NU);
  assert.equal(u.postvak.ok, true, JSON.stringify(u.postvak));
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id = 'eig0000000000001'"), 0, 'eigen verzonden aan de boekhouder: niet ingelezen');
  assert.equal(t.n("SELECT count(*) AS n FROM bericht WHERE message_id = 'eig0000000000002'"), 1, 'aan de eigen ingang: wel');
  assert.equal(u.postvak.aantallen.eigen_verzonden, 1);
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

// ───────────────────────────── OVIS Intake als tweede bron (wv1919, stap 3d) ─────────────────────────────

// nep-Intake: wat de router aanbiedt (facturenAangeboden) en wat de koerier terugmeldt (facturenUitkomst); alle data verzonnen
function nepIntake(stukken) {
  const n = { stukken: stukken || [], uitkomsten: [], knoop: [], live: [], fout: false };
  n.io = (g) => Object.assign(g.io(), {
    intake: { lijst: async () => { if (n.fout) throw new Error('router weg'); return n.stukken.filter((s) => !n.uitkomsten.some((u) => u.id === s.stuk_id && u.r.ok)); },
      uitkomst: async (id, versie, r) => { n.uitkomsten.push({ id, versie, r }); return { ok: true }; } },
    knoopVoor: async (x) => { n.knoop.push(x); return x.kvk === '98000065' ? 'org:leverancier-a' : null; },
    pdfLive: async (x) => { n.live.push(x.documenten.length); return null; } });
  return n;
}
function intakeStuk(id, bytes, extra) {
  return Object.assign({ stuk_id: id, versie: 1, bron: 'gmail:david', bron_id: '19a2b3c4d5e6f7a8', profiel: 'mail@1', onderwerp: 'Factuur oktober', van: 'facturen@leverancier-a.invalid',
    van_naam: 'Leverancier A', thread_id: null, ontvangen: '2026-10-22T10:00:00Z', dkim: 'uitgelijnd', jev: 'onder', na_keuze: false, doel: 'TG',
    documenten: [{ naam: 'factuur-okt.pdf', mime: 'application/pdf', sha256: null, bytes }], ontbreekt: 0, te_groot: 0, mailtekst: null }, extra || {});
}

test('Intake → koerier: aangeboden stuk wordt bericht (bron intake:gmail:david, Gmail-id), zelfde besliskader, terugmelden; knoop_id via KvK; één keer', async () => {
  const t = opzet(), g = nepGmail();
  const lev = t.fdb.db.prepare("SELECT l.id, i.iban FROM leverancier l JOIN leverancier_iban i ON i.leverancier = l.id WHERE l.naam = 'Leverancier A B.V.'").get();
  const bytes = Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: INTAKE-0001', 'Factuurdatum: 20-10-2026', 'Totaal incl. btw: EUR 61,50',
    'Huisartsenpraktijk Tolgaarde B.V.', 'IBAN ' + lev.iban, 'KvK 98000065', 'Merkwoord Kolibrievleugel']);
  const n = nepIntake([intakeStuk('stk_20261022_0000aaaa', bytes)]);
  const u = await KO.ronde(t.fdb, n.io(g), { nu: NU, klok: () => NU });
  assert.equal(u.intake.ok, true, JSON.stringify(u.intake));
  assert.equal(u.intake.aantallen.ingelezen, 1);
  assert.deepEqual(n.uitkomsten.map((x) => x.r), [{ ok: true, uitkomst: 'facturen:1' }]);
  const b = t.fdb.db.prepare("SELECT b.*, r.naam AS bron_naam, r.soort FROM bericht b JOIN bron r ON r.id = b.bron WHERE r.soort = 'intake'").get();
  assert.equal(b.bron_naam, 'intake:gmail:david'); assert.equal(b.message_id, '19a2b3c4d5e6f7a8');
  assert.equal(b.bron_link, 'https://mail.google.com/mail/u/0/#all/19a2b3c4d5e6f7a8');
  const f = t.fdb.db.prepare('SELECT * FROM factuur WHERE bericht = ?').get(b.id);
  assert.equal(f.nummer, 'INTAKE-0001'); assert.equal(f.status, 'te_beoordelen');   // bevestigen blijft Davids knop
  assert.equal(n.live.length, 1, 'Jev onder de drempel: PDF-lezer mag');
  // knoop_id: KvK van de factuur → precies één organisatie; audit; nooit overschrijven
  assert.equal(t.fdb.db.prepare('SELECT knoop_id FROM leverancier WHERE id = ?').get(lev.id).knoop_id, 'org:leverancier-a');
  assert.equal(t.n("SELECT count(*) AS n FROM audit WHERE wat = 'knoop_id' AND object_id = ?", [lev.id]), 1);
  assert.equal(n.knoop[0].domein, 'leverancier-a.invalid');
  // de pdftotext-tekst nergens bewaard
  t.fdb.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  for (const s of ['', '-wal']) { const p = t.fdb.pad + s; if (fs.existsSync(p)) assert.ok(fs.readFileSync(p).indexOf('Kolibrievleugel') < 0, 'tekst niet in ' + path.basename(p)); }
  // terugmelden ging mis en de router biedt hem opnieuw aan → al ingelezen, geen tweede factuur
  n.uitkomsten.length = 0;
  const u2 = await KO.ronde(t.fdb, n.io(g), { nu: NU + 60 * MIN, klok: () => NU + 60 * MIN });
  assert.equal(u2.intake.aantallen.al_ingelezen, 1);
  assert.deepEqual(n.uitkomsten.map((x) => x.r.uitkomst), ['al_ingelezen']);
  assert.equal(t.n("SELECT count(*) AS n FROM factuur WHERE nummer = 'INTAKE-0001'"), 1);
  // MailMan ziet dit bericht zoals een bericht uit het verzamelpostvak (factuurstap)
  t.fdb.db.prepare("UPDATE factuur SET status = 'verstuurd', bevestigd_op = ?, bevestigd_door = 'david (proef)', betaalspoor = 'betaald_gezien' WHERE id = ?").run(new Date(NU).toISOString(), f.id);
  assert.deepEqual(F.mailStappen(t.fdb).filter((x) => x.gmail_id === '19a2b3c4d5e6f7a8'), [{ gmail_id: '19a2b3c4d5e6f7a8', stap: 'is_betaald' }]);
});

test('Intake → koerier: pdf al via het verzamelpostvak binnen → al_in_facturen (dubbel op sha256, geen tweede factuur); geen model zonder Jev onder of na "gewoon verwerken"', async () => {
  const t = opzet(), g = nepGmail();
  const bytes = Z.pdf(['Leverancier A B.V.', 'Factuur', 'Factuurnummer: DUBBEL-0001', 'Factuurdatum: 20-10-2026', 'Totaal incl. btw: EUR 12,00', 'Huisartsenpraktijk Tolgaarde B.V.']);
  const st = D.stukSchrijf(t.fdb, bytes);
  D.voegToe(t.fdb, 'document', { id: D.nieuwId(), sha256: st.sha256, naam: 'al.pdf', mime: 'application/pdf', bytes: st.bytes, soort: 'pdf', te_lezen: 0, aangemaakt_op: new Date(NU).toISOString() });
  const n = nepIntake([intakeStuk('stk_20261022_0000bbbb', bytes, { jev: 'geen_uitslag', bron: 'gmail:groenhouten', bron_id: '29a2b3c4d5e6f7a8', dkim: null }),
    intakeStuk('stk_20261022_0000cccc', Z.pdf(['Factuur', 'Factuurnummer: NAKEUZE-1', 'Totaal incl. btw: EUR 5,00']), { na_keuze: true, bron_id: '39a2b3c4d5e6f7a8' })]);
  const u = await KO.ronde(t.fdb, n.io(g), { nu: NU, klok: () => NU });
  assert.equal(u.intake.ok, true, JSON.stringify(u.intake));
  assert.deepEqual(n.uitkomsten.map((x) => x.r.uitkomst).sort(), ['al_in_facturen', 'facturen:1']);
  assert.equal(t.n("SELECT count(*) AS n FROM factuur WHERE nummer = 'DUBBEL-0001'"), 0);
  assert.equal(n.live.length, 0, 'geen PDF-lezer zonder Jev onder de drempel of na gewoon verwerken');
  assert.equal(t.fdb.db.prepare("SELECT bron_link FROM bericht WHERE message_id = '29a2b3c4d5e6f7a8'").get().bron_link, null, 'alleen voor Davids privé-Gmail een link');
  assert.equal(t.n("SELECT count(*) AS n FROM bron WHERE soort = 'intake'"), 2);
});

test('Intake → koerier: bijlage weg uit Intake → terugmelden als fout (de router telt pogingen); router weg → ronde gaat door', async () => {
  const t = opzet(), g = nepGmail();
  const n = nepIntake([intakeStuk('stk_20261022_0000dddd', Z.pdf(['x']), { ontbreekt: 1 }), intakeStuk('stk_20261022_0000eeee', Z.pdf(['y']), { te_groot: 1, bron_id: '49a2b3c4d5e6f7a8' }),
    intakeStuk('stk_20261022_0000ffff', Buffer.from('geen pdf'), { bron_id: '59a2b3c4d5e6f7a8' })]);
  const u = await KO.ronde(t.fdb, n.io(g), { nu: NU, klok: () => NU });
  assert.equal(u.intake.ok, false);
  // review MOET 1: te groot of geen pdf/UBL is nooit een geslaagde levering
  assert.deepEqual(n.uitkomsten.map((x) => x.r), [{ ok: false, code: 'ontbreekt' }, { ok: false, code: 'te_groot' }, { ok: false, code: 'geen_document' }]);
  n.stukken = [n.stukken[0]];
  assert.equal(t.n("SELECT count(*) AS n FROM bericht b JOIN bron r ON r.id = b.bron WHERE r.soort = 'intake'"), 0);
  n.fout = true;
  const u2 = await KO.ronde(t.fdb, n.io(g), { nu: NU + 60 * MIN, klok: () => NU + 60 * MIN });
  assert.equal(u2.intake.ok, false); assert.equal(u2.intake.fout, 'lijst');
  assert.ok(u2.upload, 'de rest van de ronde liep');
  // zonder io.intake (oude server.js) doet de koerier niets extra
  const u3 = await t.ronde(g, NU + 120 * MIN);
  assert.equal(u3.intake, undefined);
});

// wv2617 (David 7-11-2026: rode melding 'intake:gmail:david' terwijl alles liep): elke gelukte lijst = een ronde per Intake-bron
test('Intake-hartslag: lijst zonder stukken → bron groen; lijstfout → rood; twee Intake-bronnen elk een eigen ronde', async () => {
  const t = opzet(), g = nepGmail();
  const kleur = (nu) => Object.fromEntries(t.call('GET', '', {}, { nu }).j.gezondheid.bronnen.filter((b) => b.soort === 'intake').map((b) => [b.naam, b.kleur]));
  const rondes = (naam) => t.n("SELECT count(*) AS n FROM bron_ronde x JOIN bron r ON r.id = x.bron WHERE r.naam = ?", [naam]);
  // dag 1: één stuk van gmail:david
  const n = nepIntake([intakeStuk('stk_20261022_0000a001', Z.pdf(['Factuur', 'Factuurnummer: HART-0001', 'Totaal incl. btw: EUR 7,00']))]);
  await KO.ronde(t.fdb, n.io(g), { nu: NU, klok: () => NU });
  assert.equal(rondes('intake:gmail:david'), 1);
  // twee dagen lang geen stukken: elke ronde toch een hartslag → groen na > 26 u
  for (let h = 1; h <= 48; h += 12) { const nu = NU + h * 60 * MIN; await KO.ronde(t.fdb, n.io(g), { nu, klok: () => nu }); }
  assert.equal(rondes('intake:gmail:david'), 5);
  assert.deepEqual(kleur(NU + 50 * 60 * MIN), { 'intake:gmail:david': 'groen' });
  // ook zonder ooit een stuk: de vaste bron gmail:david bestaat en krijgt een ronde
  const t2 = opzet(), g2 = nepGmail();
  await KO.ronde(t2.fdb, nepIntake([]).io(g2), { nu: NU, klok: () => NU });
  assert.equal(t2.n("SELECT count(*) AS n FROM bron_ronde x JOIN bron r ON r.id = x.bron WHERE r.naam = 'intake:gmail:david' AND x.ok = 1"), 1);
  // een stuk van een tweede bron (gmail:groenhouten): elk een eigen ronde, niet allebei op de eerste naam
  n.stukken = [intakeStuk('stk_20261022_0000a002', Z.pdf(['Factuur', 'Factuurnummer: HART-0002', 'Totaal incl. btw: EUR 8,00']), { bron: 'gmail:groenhouten', bron_id: '69a2b3c4d5e6f7a8' })];
  const nu3 = NU + 51 * 60 * MIN;
  await KO.ronde(t.fdb, n.io(g), { nu: nu3, klok: () => nu3 });
  assert.equal(rondes('intake:gmail:david'), 6); assert.equal(rondes('intake:gmail:groenhouten'), 1);
  const a = (naam) => JSON.parse(t.fdb.db.prepare("SELECT x.aantallen FROM bron_ronde x JOIN bron r ON r.id = x.bron WHERE r.naam = ? ORDER BY x.start DESC LIMIT 1").get(naam).aantallen);
  assert.equal(a('intake:gmail:groenhouten').stukken, 1); assert.equal(a('intake:gmail:david').stukken, 0);
  assert.deepEqual(kleur(nu3 + MIN), { 'intake:gmail:david': 'groen', 'intake:gmail:groenhouten': 'groen' });
  // lijst faalt → beide rood (ronde ok 0)
  n.fout = true;
  const nu4 = nu3 + 60 * MIN;
  const u4 = await KO.ronde(t.fdb, n.io(g), { nu: nu4, klok: () => nu4 });
  assert.equal(u4.intake.fout, 'lijst');
  assert.deepEqual(kleur(nu4 + MIN), { 'intake:gmail:david': 'rood', 'intake:gmail:groenhouten': 'rood' });
});

// ───────────────────────────── wv2969: eisen van de Exact-Scanservice (verzonnen data) ─────────────────────────────

// PDF met n pagina's (synthetisch), voor de paginagrens; opvulling als PDF-commentaar voor de groottegrens
function pdfPaginas(n, opvul) {
  const obj = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (let i = 0; i < n; i++) {
    const tekst = 'BT /F1 11 Tf 56 780 Td (Factuur PROEF-PAG pagina ' + (i + 1) + ') Tj ET';
    obj.push('<< /Length ' + tekst.length + ' >>\nstream\n' + tekst + '\nendstream');
    obj.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + obj.length + ' 0 R >>');
    kids.push(obj.length + ' 0 R');
  }
  obj[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + n + ' >>';
  let uit = '%PDF-1.4\n' + (opvul ? '%' + 'x'.repeat(opvul) + '\n' : '');
  const plek = [];
  obj.forEach((o, i) => { plek.push(Buffer.byteLength(uit, 'latin1')); uit += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(uit, 'latin1');
  uit += 'xref\n0 ' + (obj.length + 1) + '\n0000000000 65535 f \n' + plek.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  uit += 'trailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(uit, 'latin1');
}
// een te beoordelen factuur van een Exact-entiteit, zonder twijfel te bevestigen; met ubl = met een UBL-bestand ernaast
function exactFactuur(t, ubl) {
  return t.fdb.db.prepare("SELECT * FROM factuur WHERE status = 'te_beoordelen' AND entiteit IN ('tolgaarde','groenhouten','holding','kostenmaatschap') AND betaalwijze <> 'onbekend' " +
    "AND iban_nieuw = 0 AND patientkenmerk = 0 AND valuta = 'EUR' AND incl > 0 AND ubl_document IS " + (ubl ? 'NOT NULL' : 'NULL') + ' ORDER BY aangemaakt_op, id LIMIT 1').get();
}
// het stuk van een factuur vervangen door andere bytes (vóór Bevestigen; naam optioneel; bytes-kolom optioneel anders dan de echte grootte)
function vervangStuk(t, f, bytes, o) {
  o = o || {};
  const s = D.stukSchrijf(t.fdb, bytes), id = D.nieuwId();
  D.voegToe(t.fdb, 'document', { id, sha256: s.sha256, naam: o.naam || 'factuur-proef.pdf', mime: 'application/pdf', bytes: o.bytes != null ? o.bytes : s.bytes, soort: 'pdf', tekstlaag: 1,
    patientkenmerk: 0, te_lezen: 0, aangemaakt_op: new Date(NU).toISOString() });
  t.fdb.db.prepare('UPDATE factuur SET document = ? WHERE id = ?').run(id, f.id);
  return s.sha256;
}
function zelfBevestig(t, f, d) {
  const r = t.call('POST', 'bevestig', Object.assign({ id: f.id }, d || {}));
  return { r, op: r.j && r.j.opdracht ? t.op(r.j.opdracht.id) : null, tok: 'FV' + f.id };
}

test('wv2969 bestandsnaam naar Exact: ≤ 99 tekens incl. extensie, leesbaar, uniek binnen de mail; zonder grens zoals vroeger', () => {
  const pdfB = Z.pdf(['x']);
  const lang = 'Factuur ' + 'Leverancier Met Een Heel Lange Naam B.V. '.repeat(4) + '\u0007nummer 2026-0001.pdf';
  const n = KO.naamMetExtensie(lang, 'application/pdf', pdfB, 'boekhouder_factuur', 99);
  assert.ok(n.length <= 99, n.length + ' tekens');
  assert.match(n, /^Factuur Leverancier .*\.pdf$/);
  assert.ok(!/[\u0000-\u001f]|\s{2}|\s\.pdf$/.test(n), 'geen stuurtekens, dubbele spaties of spatie vóór de extensie');
  assert.equal(KO.naamMetExtensie(lang, 'application/pdf', pdfB, 'boekhouder_factuur').length, 114, 'zonder grens (route mail) ongewijzigd: 110 + .pdf');
  assert.equal(KO.naamMetExtensie('kort.pdf', 'application/pdf', pdfB, 'boekhouder_factuur', 99), 'kort.pdf');
  const u = KO.uniekeNamen([{ naam: 'a'.repeat(95) + '.pdf' }, { naam: 'A'.repeat(95) + '.pdf' }, { naam: 'b.pdf' }], 99).map((b) => b.naam);
  assert.equal(new Set(u.map((x) => x.toLowerCase())).size, 3);
  assert.ok(u.every((x) => x.length <= 99 && /\.pdf$/.test(x)), JSON.stringify(u));
  assert.match(u[1], / \(2\)\.pdf$/);
});

test('wv2969 route exact: alleen de PDF gaat mee (geen UBL-XML), naam ≤ 99; de vingerafdruk van het akkoord (met UBL) blijft gelden', async () => {
  const t = opzet(), g = nepGmail();
  const f = exactFactuur(t, true);
  assert.ok(f, 'zaad heeft een Exact-factuur met UBL');
  t.fdb.db.prepare('UPDATE document SET naam = ? WHERE id = ?').run('Inkoopfactuur ' + 'zeer lange omschrijving '.repeat(8) + '.pdf', f.document);
  const { r, op, tok } = zelfBevestig(t, f);
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(JSON.parse(op.bijlagen).length, 2, 'het akkoord dekt PDF en UBL (zoals opdrachten die al wachten)');
  await t.ronde(g, VERSTUUR + 5 * MIN);
  const mijn = g.verzonden.filter((v) => v.token === tok);
  assert.equal(mijn.length, 1);
  assert.equal(mijn[0].namen.length, 1);
  assert.match(mijn[0].namen[0], /\.pdf$/);
  assert.ok(mijn[0].namen[0].length <= 99, mijn[0].namen[0].length + ' tekens');
  assert.deepEqual(mijn[0].shas, [JSON.parse(op.bijlagen)[0].sha256], 'alleen de PDF uit het akkoord');
  assert.equal(t.op(op.id).status, 'gelukt');
  assert.equal(t.op(op.id).vingerafdruk_koerier, op.vingerafdruk);
});

test('wv2969 route mail (Acta) en POT-afschriften ongewijzigd: PDF én UBL gaan mee', async () => {
  const t = opzet(), g = nepGmail();
  const f = exactFactuur(t, true);
  const { r, op, tok } = zelfBevestig(t, f, { entiteit: 'sloel' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  await t.ronde(g, VERSTUUR + 5 * MIN);
  const mijn = g.verzonden.filter((v) => v.token === tok);
  assert.equal(mijn.length, 1);
  assert.deepEqual(mijn[0].namen.map((n) => n.slice(-4)).sort(), ['.pdf', '.xml']);
  assert.equal(t.op(op.id).status, 'gelukt');
});

test('wv2969 route exact zonder PDF (alleen UBL): Bevestigen weigert vooraf met uitleg; een oude opdracht wordt geweigerd met signaal', async () => {
  const t = opzet(), g = nepGmail();
  const f = exactFactuur(t, true);
  // zo'n factuur nabootsen: het hoofdstuk is de UBL (vóór Bevestigen); het oude PDF-stuk hangt er niet meer aan
  const ubl = t.fdb.db.prepare('SELECT ubl_document FROM factuur WHERE id = ?').get(f.id).ubl_document;
  t.fdb.db.prepare('UPDATE factuur SET ubl_document = NULL WHERE id = ?').run(f.id);
  t.fdb.db.prepare('UPDATE factuur SET document = ? WHERE id = ?').run(ubl, f.id);
  const detail = t.call('GET', 'factuur/' + f.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.j.bevestigen.ok, false);
  assert.ok(detail.j.bevestigen.redenen.some((x) => /niet naar Exact: alleen een UBL-bestand/.test(x)), JSON.stringify(detail.j.bevestigen));
  const a = zelfBevestig(t, f);
  assert.equal(a.r.status, 409);
  assert.equal(a.r.j.code, 'exact');
  assert.match(a.r.j.fout || a.r.j.error || JSON.stringify(a.r.j), /alleen een UBL-bestand \(XML\), geen PDF/);
  assert.equal(t.fac(f.id).status, 'te_beoordelen', 'blijft in Beoordelen');
  // naar de route mail mag het wel (die neemt UBL)
  assert.equal(zelfBevestig(t, f, { entiteit: 'sloel' }).r.status, 200);
  // een opdracht van vóór deze wijziging (Exact, alleen UBL; toen weigerde Bevestigen dat niet): zo'n opdracht maken zoals de oude code deed
  t.fdb.db.prepare("UPDATE opdracht SET status = 'teruggedraaid' WHERE factuur = ? AND status = 'wacht'").run(f.id);
  t.fdb.db.prepare("UPDATE factuur SET entiteit = 'tolgaarde' WHERE id = ?").run(f.id);
  const fk = D.factuurVoorKern(t.fdb, f.id);
  const ent = t.fdb.db.prepare("SELECT * FROM entiteit WHERE sleutel = 'tolgaarde'").get();
  const opk = { id: D.nieuwId(), soort: 'boekhouder_factuur', entiteit: 'tolgaarde', doeladres: ent.boekhoud_doel, bijlagen: F.bijlagenVan(t.fdb, fk), verstuur_na: new Date(VERSTUUR).toISOString() };
  opk.idempotentiesleutel = f.id + ':' + opk.id;
  opk.vingerafdruk = K.vingerafdruk({ id: opk.id, soort: opk.soort, doeladres: opk.doeladres, regel: { factuur_id: f.id, entiteit: 'tolgaarde', bedrag_centen: fk.incl, doeladres: opk.doeladres }, bijlagen: opk.bijlagen });
  D.voegToe(t.fdb, 'opdracht', { id: opk.id, soort: opk.soort, factuur: f.id, entiteit: opk.entiteit, doeladres: opk.doeladres, bijlagen: opk.bijlagen, vingerafdruk: opk.vingerafdruk,
    verstuur_na: opk.verstuur_na, idempotentiesleutel: opk.idempotentiesleutel, status: 'wacht', poging: 0, aangemaakt_door: 'proef', aangemaakt_op: new Date(NU).toISOString(), bijgewerkt_op: new Date(NU).toISOString() });
  const b = { tok: 'FV' + f.id }, op = t.op(opk.id), f2 = f;
  for (let i = 0; i <= 3 && t.op(op.id).status === 'wacht'; i++) await t.ronde(g, VERSTUUR + 5 * MIN + i * UUR);
  assert.equal(g.verzonden.filter((v) => v.token === b.tok).length, 0);
  assert.equal(t.op(op.id).status, 'geweigerd');
  assert.match(t.op(op.id).fout, /geen PDF: Exact neemt alleen een PDF aan/);
  assert.equal(t.fac(f2.id).status, 'verzending_mislukt');
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt' AND status = 'open' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [f2.id]), 1);
});

test('wv2969 te groot voor Exact (> 15 MB): Bevestigen weigert vooraf; een opdracht met zo\'n stuk wordt geweigerd, zichtbaar, niets verstuurd', async () => {
  const t = opzet(), g = nepGmail();
  const f = exactFactuur(t, false);
  vervangStuk(t, f, Z.pdf(['Leverancier A B.V.', 'Factuur GROOT-1']), { bytes: 16 * 1024 * 1024 });
  const a = zelfBevestig(t, f);
  assert.equal(a.r.status, 409);
  assert.equal(a.r.j.code, 'exact');
  assert.match(JSON.stringify(a.r.j), /te groot voor Exact \(16 MB, Exact neemt tot 15 MB\)/);
  // echte grootte boven 15 MB, terwijl de bytes-kolom klein is (zoals een opdracht die al wachtte): de koerier vangt het
  const f2 = exactFactuur(t, false);
  vervangStuk(t, f2, pdfPaginas(1, 15 * 1024 * 1024 + 10), { bytes: 1000 });
  const b = zelfBevestig(t, f2);
  assert.equal(b.r.status, 200, JSON.stringify(b.r.j));
  await t.ronde(g, VERSTUUR + 5 * MIN);
  assert.equal(g.verzonden.filter((v) => v.token === b.tok).length, 0);
  assert.equal(t.op(b.op.id).status, 'geweigerd');
  assert.match(t.op(b.op.id).fout, /^te groot voor Exact \(15 MB, Exact neemt tot 15 MB\)/);
  assert.equal(t.fac(f2.id).status, 'verzending_mislukt');
  assert.equal(t.n("SELECT count(*) AS n FROM signaal WHERE soort = 'verzending_mislukt' AND EXISTS (SELECT 1 FROM json_each(facturen) j WHERE j.value = ?)", [f2.id]), 1);
  // Opnieuw proberen maakt geen nieuwe opdracht zolang het stuk te groot is
  t.fdb.db.prepare('UPDATE document SET bytes = ? WHERE sha256 = ?').run(15 * 1024 * 1024 + 500, JSON.parse(b.op.bijlagen)[0].sha256);
  const n0 = t.n('SELECT count(*) AS n FROM opdracht WHERE factuur = ?', [f2.id]);
  const o = t.call('POST', 'opnieuw', { id: f2.id });
  assert.equal(o.status, 409, JSON.stringify(o.j));
  assert.equal(o.j.code, 'exact');
  assert.match(JSON.stringify(o.j), /te groot voor Exact/);
  assert.equal(t.n('SELECT count(*) AS n FROM opdracht WHERE factuur = ?', [f2.id]), n0, 'geen nieuwe opdracht');
  assert.equal(t.fac(f2.id).status, 'verzending_mislukt');
});

test('wv2969 meer dan 150 pagina\'s: geweigerd met het paginatal (echte pdftotext); 150 pagina\'s gaat gewoon', async () => {
  const t = opzet(), g = nepGmail();
  const f = exactFactuur(t, false);
  vervangStuk(t, f, pdfPaginas(151));
  const a = zelfBevestig(t, f);
  assert.equal(a.r.status, 200, JSON.stringify(a.r.j));
  const f2 = exactFactuur(t, false);
  vervangStuk(t, f2, pdfPaginas(150));
  const b = zelfBevestig(t, f2);
  assert.equal(b.r.status, 200, JSON.stringify(b.r.j));
  for (let i = 0; i <= 3 && [a, b].some((x) => t.op(x.op.id).status === 'wacht'); i++) await t.ronde(g, VERSTUUR + 5 * MIN + i * UUR);   // het zaad heeft al opdrachten in de rij (8 per ronde)
  assert.equal(g.verzonden.filter((v) => v.token === a.tok).length, 0);
  assert.equal(t.op(a.op.id).status, 'geweigerd');
  assert.match(t.op(a.op.id).fout, /^te veel pagina's voor Exact \(151, Exact neemt tot 150\)/);
  assert.equal(t.fac(f.id).status, 'verzending_mislukt');
  assert.equal(g.verzonden.filter((v) => v.token === b.tok).length, 1, '150 pagina\'s mag');
  assert.equal(t.op(b.op.id).status, 'gelukt');
  // pdftotext faalt of de tekst is te lang: niet versturen (fail-closed), met reden
  assert.match(await KO.exactPaginas([{ naam: 'a.pdf', bytes: Buffer.from('x') }], async () => ({ ok: false, fout: 'pdftotext' })), /niet vast te stellen/);
  assert.match(await KO.exactPaginas([{ naam: 'a.pdf', bytes: Buffer.from('x') }], async () => ({ ok: false, fout: 'te_lang' })), /meer dan 150/);
  assert.equal(await KO.exactPaginas([{ naam: 'a.pdf', bytes: Buffer.from('x') }], async () => ({ ok: true, tekst: 'a\fb\f' })), null);
});

test('wv2969 herinnering, aanmaning, offerte: de lezer herkent de titel, zet de reden bovenaan in Beoordelen; Bevestigen naar Exact weigert, naar Acta niet', () => {
  const S = (tekst, ond, naam) => K.stapSoortStuk(tekst, ond ? { onderwerp: ond } : null, naam || 'stuk.pdf').soort;
  assert.equal(S('Leverancier Proef B.V.        BETALINGSHERINNERING\nFactuurnummer P-1\nTotaal 12,00'), 'herinnering');
  assert.equal(S('AANMANING\nFactuur P-2'), 'aanmaning');
  assert.equal(S('2e herinnering\nFactuur P-2'), 'herinnering');
  assert.equal(S('OFFERTE\nProef B.V.'), 'offerte');
  assert.equal(S('Leverancier\nFactuur P-3', null, 'Aanmaning_2026-17.pdf'), 'aanmaning');
  assert.equal(S('Leverancier\nFactuur P-3', 'Tweede herinnering factuur P-3'), 'herinnering');
  // geen herinnering: verwijzingen, voetteksten en meldingsmails
  assert.equal(S('Leverancier\nFactuur P-4\nOfferte: Q-12\nOffertenummer 77\nBij niet tijdig betalen volgt een aanmaning'), null);
  assert.equal(S('Leverancier\nFactuur P-5', 'Herinnering: uw factuur staat klaar'), null);
  assert.equal(S('Leverancier\nFactuur P-6', 'Dit is geen aanmaning'), null);
  assert.equal(S('Factuur P-7\n' + 'regel\n'.repeat(20) + 'HERINNERING'), null, 'alleen de kop van het stuk');
  // het besliskader: reden bovenaan, besluit soort_stuk, status blijft te beoordelen
  const tekst = 'Proef Leverancier B.V.\nBETALINGSHERINNERING\nFactuur\nFactuurnummer: HER-1\nFactuurdatum: 01-10-2026\nTotaal incl. btw: 121,00\nIBAN NL91ABNA0417164300';
  const u = K.beslisBericht({ bericht: { message_id: 'm1', afzender: 'x@proef.invalid', onderwerp: 'Factuur HER-1' }, documenten: [{ sha256: 'a'.repeat(64), naam: 'HER-1.pdf', mime: 'application/pdf', tekst, tekstlaag: true }] }, { vandaag: '2026-10-22' });
  assert.equal(u.facturen.length, 1);
  assert.equal(u.facturen[0].status, 'te_beoordelen');
  assert.match(u.facturen[0].redenen[0], /^Lijkt een betalingsherinnering .*Exact keurt die af/);
  assert.ok(u.facturen[0].besluiten.some((b) => b.stap === 'soort_stuk' && b.waarde === 'herinnering'));
  // routes: Exact weigert met uitleg, Acta (mail) mag
  const t = opzet();
  const f = exactFactuur(t, false);
  t.fdb.db.prepare("INSERT INTO besluit (factuur, stap, veld, waarde, bron, toelichting, wanneer) VALUES (?, 'soort_stuk', 'soort_stuk', 'aanmaning', 'regel', 'proef', ?)").run(f.id, new Date(NU).toISOString());
  const a = zelfBevestig(t, f);
  assert.equal(a.r.status, 409);
  assert.equal(a.r.j.code, 'exact');
  assert.match(JSON.stringify(a.r.j), /lijkt een aanmaning: Exact keurt die af/);
  assert.equal(t.fac(f.id).status, 'te_beoordelen');
  assert.equal(zelfBevestig(t, f, { entiteit: 'sloel' }).r.status, 200);
});
