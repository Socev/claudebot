'use strict';
// wv4104 (besluitenpagina nr 175 = 2C75): OVIS Imagine — Oude foto tot leven (keten) en "In Imagine" vanuit MemoryLane (laad met hergebruik).
// Tegen een nagebootste motor (zoals imagine-opruim.test.js; geen ComfyUI, geen Pillow), verzonnen beelden.
//   1. vier stappen in vaste volgorde → vier versies, elk op het resultaat van de vorige; filmstap via de stapel; keten klaar.
//   2. één vingerafdruk bij de tik geldt voor alle stappen (flows op proef); zonder vingerafdruk 403 en geen keten.
//   3. uitval van stap 3 → versies van stap 1 en 2 blijven, geen stap 4; Opnieuw op stap 3 gaat verder met stap 4.
//   4. stop tijdens stap 2 → geen stap 3; keuze van stappen (ongeordend gestuurd) = vaste volgorde, alleen de gekozen.
//   5. volgende stap kon niet starten (rij vol) → mislukte taak met Opnieuw en vanzelf opnieuw; herstart tussen stappen → hervat.
//   6. laad met hergebruik: dezelfde Immich-foto = hetzelfde beeld; zonder hergebruik = een nieuw; niets naar Immich zonder tik.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kverder (geen volgende stap), =kvers (de vingerafdruk geldt niet voor de volgende stappen),
// =kvolg (volgende stap op het origineel i.p.v. op het resultaat).
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 3000); while (Date.now() < t) { if (await f()) return true; await slaap(10); } return false; }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-keten-'));
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
fs.copyFileSync(path.join(ROOT, 'imagine.js'), path.join(MOD, 'imagine.js'));
function wijzig(oud, nieuw) { const p = path.join(MOD, 'imagine.js'); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden'); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kverder') wijzig("    if (t.status !== 'klaar' || !t.versie) return;   // uitgevallen", "    return;   // uitgevallen");
if (KRUIS === 'kvers') wijzig('return !!t && klok() - t < KETEN_T.vers_ms;', 'return false;');
if (KRUIS === 'kvolg') wijzig('try { r = await ketenStap(k, i, t.versie, \'\'); }', 'try { r = await ketenStap(k, i, k.start, \'\'); }');
const I = require(path.join(MOD, 'imagine.js'));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const UUID = '0a1b2c3d-1111-4222-8333-444455556666';
function stub() {
  const live = new Map();
  const S = {
    live: live, starts: [], proef: true, weiger: 0, immichN: 0,
    beeldPijp: async function (args, buf) {
      if (args[0] === 'pijp-toon') return { ok: true, formaat: buf[0] === 0xff ? 'JPEG' : 'PNG', breed: 64, hoog: 48, bytes: JPG };
      if (args[0] === 'pijp-maat') return { ok: true, bytes: PNG, breed: 64, hoog: 48 };
      return { ok: false, reden: 'onbekend' };
    },
    flowVan: async function (id) { const film = /^video-/.test(id); return { id: id, klaar: true, reden: null, tijd: '', status: film || !S.proef ? 'actief' : 'proef', vers_per_keer: !film && S.proef, velden: [] }; },
    maakGeheugen: async function (o, ctx) {
      for (const t of live.values()) if (t.beurt === o.beurt_id) return { status: 200, taak: { id: t.id }, al: true };
      if (S.weiger) { S.weiger--; return { status: 429, fout: 'er staan al 5 taken in de rij; wacht tot er een klaar is' }; }
      const proef = !/^video-/.test(o.flow) && S.proef;
      if (proef && !ctx.versOk()) return { status: 403, fout: 'deze bewerking is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
      if (proef) ctx.versVerbruik();
      const id = 's' + String(S.starts.length).padStart(15, '0');
      live.set(id, { id: id, o: o, beurt: o.beurt_id });
      S.starts.push({ id: id, flow: o.flow, beurt: o.beurt_id, beeld: o.beeld ? o.beeld.toString('hex') : null });
      return { status: 200, taak: { id: id } };
    },
    geheugenTaak: function (id) { return live.has(id) ? { status: 'bezig', fase: 'nep', procent: null, plek_in_rij: null } : null; },
    stopGeheugen: function (id) { const t = live.get(id); if (!t) return { status: 404 }; S.af(id, { status: 'gestopt', reden: 'gestopt', beelden: [] }); return { status: 200 }; },
    health: function () { return { in_rij: live.size, bezig: live.size > 0, taken_vandaag: 0 }; },
    incognito: function () { return { herstart: false, nog_te_wissen: 0 }; },
    immichHaal: async function () { S.immichN++; return { bytes: PNG }; },
    af: function (id, u) { const t = live.get(id); live.delete(id); try { Promise.resolve(t.o.klaar(u)).catch(function () {}); } catch (e) {} },
  };
  return S;
}
// elk resultaat een eigen beeld (zodat "op het resultaat van de vorige" te zien is aan de bytes die de volgende stap krijgt)
let uitN = 0;
const beeld = () => { const b = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(40, 10 + (++uitN))]); return { status: 'klaar', reden: null, duur_s: 3, model: 'nep', beelden: [{ bytes: b, breed: 64, hoog: 48, ext: 'png' }] }; };
const film = () => ({ status: 'klaar', reden: null, duur_s: 5, model: 'nep', beelden: [{ video: true, bytes: Buffer.from('0000ftypisom' + 'x'.repeat(40)), affiche: PNG, breed: 64, hoog: 48, beelden: 10 }] });
let klokT = Date.parse('2026-11-27T12:00:00+01:00');
const klok = () => klokT;
const logs = [];
function nieuweImagine(dir, S, extra) {
  return I.maak(Object.assign({ dir: dir, studio: S, primair: () => true, nu: klok, log: (r) => logs.push(r), fout: () => {}, tempo: { ronde: 3600000 },
    immich: { uploaden: async () => { throw new Error('mag niet zonder tik'); } } }, extra || {}));
}
// een vingerafdruk die één keer telt (zoals de echte app-poort)
function eenVinger() { let n = 1; return { versOk: () => n > 0, versVerbruik: () => { n--; } }; }
const geenVinger = { versOk: () => false, versVerbruik: () => {} };
const app = (im, pad, methode, body, ctx) => im.app({ pad: pad, methode: methode || 'GET', body: body, apparaat: 'toestel-1', ctx: ctx || eenVinger() });
let beurtN = 0; const beurt = () => 'beurt-' + (++beurtN).toString().padStart(6, '0');
const ALLE = ['krassen', 'inkleuren', 'opknappen', 'bewegen'];
async function laadFoto(im) { const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64'), titel: 'proef' }); return l.body; }
const laatste = (S) => S.starts[S.starts.length - 1];
async function rondaf(S, n, maak) { const ok = await totDat(() => S.starts.length >= n && S.live.has(laatste(S).id)); if (!ok) return false; S.af(laatste(S).id, maak()); return true; }
const ketenVan = async (im, bron) => (await app(im, '/app/imagine/bron/' + bron)).body.ketens[0];

(async function () {
  // ── 1 + 2. vier stappen, één vingerafdruk ──
  {
    const dir = path.join(W, 'p1'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await laadFoto(im);
    const geen = await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ALLE, beurt_id: beurt() }, geenVinger);
    toets('2a. zonder vingerafdruk (flows op proef) = 403, geen keten', geen.status === 403 && geen.body.vers_nodig === true && !im._db().prepare('SELECT 1 FROM keten').get(), geen);
    const r = await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ALLE, model: 'snel', beurt_id: beurt() }, eenVinger());
    toets('1a. keten gestart, stap 1 = krassen (foto-herstel)', r.status === 200 && r.body.keten && r.body.keten.stappen.length === 4 && S.starts[0] && S.starts[0].flow === 'foto-herstel', r);
    const dub = await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ALLE, beurt_id: 'beurt-000002' }, eenVinger());
    toets('1b. dezelfde tik nog eens = dezelfde keten (geen tweede)', dub.status === 200 && dub.body.al === true && im._db().prepare('SELECT COUNT(*) AS n FROM keten').get().n === 1, dub);
    await rondaf(S, 1, beeld);
    const s2 = await totDat(() => S.starts.length >= 2);
    toets('1c. na stap 1 start stap 2 vanzelf (inkleuren)', s2 && S.starts[1].flow === 'foto-inkleuren', S.starts.map((x) => x.flow));
    toets('2b. stap 2 kreeg de vingerafdruk van de tik (flow op proef, geen 403)', s2 && !im._db().prepare("SELECT 1 FROM taak WHERE status = 'mislukt'").get());
    const v2 = im._db().prepare('SELECT * FROM versie WHERE nr = 2').get();
    toets('1d. stap 2 werkt op het resultaat van stap 1 (niet op het origineel)', s2 && v2 && S.starts[1].beeld === fs.readFileSync(path.join(dir, 'beelden', v2.bron, v2.id + '.' + v2.ext)).toString('hex') && S.starts[1].beeld !== S.starts[0].beeld);
    await rondaf(S, 2, beeld);
    await totDat(() => S.starts.length >= 3);
    toets('1e. stap 3 = opknappen', S.starts[2] && S.starts[2].flow === 'foto-opknappen', S.starts.map((x) => x.flow));
    await rondaf(S, 3, beeld);
    const inStapel = await totDat(() => im._db().prepare("SELECT 1 FROM taak WHERE status = 'stapel' AND keten IS NOT NULL").get() || S.starts.length >= 4);
    toets('1f. filmstap gaat via de stapel', inStapel);
    await im._ronde3();
    await totDat(() => S.starts.length >= 4);
    toets('1g. de ronde start de filmstap (video-wan-snel, zoals gekozen)', S.starts[3] && S.starts[3].flow === 'video-wan-snel', S.starts.map((x) => x.flow));
    await rondaf(S, 4, film);
    await totDat(async () => (await ketenVan(im, l.bron)).status === 'klaar');
    const k = await ketenVan(im, l.bron);
    const vs = im._db().prepare('SELECT * FROM versie WHERE bron = ? ORDER BY nr').all(l.bron);
    toets('1h. keten klaar: origineel + vier versies, elk met de vorige als voorganger', k.status === 'klaar' && vs.length === 5 && vs.slice(1).every((v, i) => v.voorganger === vs[i].id) && vs[4].ext === 'mp4'
      && JSON.stringify(vs.slice(1).map((v) => v.stand)) === JSON.stringify(ALLE), { k: k, vs: vs.map((v) => [v.nr, v.stand, v.ext]) });
    toets('1i. de keten noemt per stap zijn versie', k.versies.length === 4 && k.versies.every((x, i) => x === vs[i + 1].id), k.versies);
    toets('1j. seintje na de filmstap (stapel leeg)', im._db().prepare('SELECT COUNT(*) AS n FROM seintje').get().n === 1);
    toets('6a. niets naar Immich zonder tik', !vs.some((v) => v.immich_asset));
    toets('1k. vingerafdruk na afloop vergeten', !im._ketenVers.size);
    im.stopTimers();
  }
  // ── 3. uitval van stap 3, Opnieuw gaat verder ──
  {
    const dir = path.join(W, 'p3'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await laadFoto(im);
    await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ALLE, beurt_id: beurt() }, eenVinger());
    await rondaf(S, 1, beeld); await rondaf(S, 2, beeld);
    await totDat(() => S.starts.length >= 3);
    S.af(S.starts[2].id, { status: 'mislukt', reden: 'nep: stap 3 viel uit', beelden: [] });
    await totDat(async () => (await ketenVan(im, l.bron)).status === 'mislukt');
    await slaap(30);
    const k = await ketenVan(im, l.bron);
    const vs = im._db().prepare('SELECT * FROM versie WHERE bron = ? ORDER BY nr').all(l.bron);
    toets('3a. uitval stap 3: keten mislukt op stap 3, versie van stap 2 blijft staan, geen stap 4', k.status === 'mislukt' && k.stap === 2 && vs.length === 3 && vs[2].stand === 'inkleuren' && S.starts.length === 3
      && !im._db().prepare("SELECT 1 FROM taak WHERE keten_stap = 3").get(), { k: k, n: vs.length, starts: S.starts.length });
    toets('3b. Opnieuw kan op de uitgevallen stap', k.kan_opnieuw === true);
    const o = await app(im, '/app/imagine/opnieuw/' + k.taak, 'POST', { beurt_id: beurt() }, eenVinger());
    toets('3c. Opnieuw start stap 3 op het resultaat van stap 2', o.status === 200 && S.starts[3] && S.starts[3].flow === 'foto-opknappen' && S.starts[3].beeld === S.starts[2].beeld, o);
    await rondaf(S, 4, beeld);
    await totDat(() => im._db().prepare("SELECT 1 FROM taak WHERE status = 'stapel'").get());
    await im._ronde3();
    await rondaf(S, 5, film);
    await totDat(async () => (await ketenVan(im, l.bron)).status === 'klaar');
    toets('3d. daarna gaat de keten verder tot het filmpje (trouw = standaard)', (await ketenVan(im, l.bron)).status === 'klaar' && S.starts[4].flow === 'video-minimax-trouw', S.starts.map((x) => x.flow));
    im.stopTimers();
  }
  // ── 4. stop en keuze ──
  {
    const dir = path.join(W, 'p4'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await laadFoto(im);
    await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ALLE, beurt_id: beurt() }, eenVinger());
    await rondaf(S, 1, beeld);
    await totDat(() => S.starts.length >= 2);
    const t2 = im._db().prepare('SELECT id FROM taak WHERE keten_stap = 1').get();
    const st = await app(im, '/app/imagine/stop/' + t2.id, 'POST', {});
    await slaap(40);
    const k = await ketenVan(im, l.bron);
    toets('4a. stop tijdens stap 2: keten gestopt, geen stap 3, versie van stap 1 blijft', st.status === 200 && k.status === 'gestopt' && S.starts.length === 2 && im._db().prepare('SELECT COUNT(*) AS n FROM versie').get().n === 2, { st: st, k: k });
    const l2 = await laadFoto(im);
    const r = await app(im, '/app/imagine/keten', 'POST', { versie: l2.versie, stappen: ['bewegen', 'inkleuren'], beurt_id: beurt() }, eenVinger());
    toets('4b. keuze ongeordend gestuurd = vaste volgorde, alleen de gekozen', r.status === 200 && JSON.stringify(r.body.keten.stappen.map((x) => x.id)) === '["inkleuren","bewegen"]' && laatste(S).flow === 'foto-inkleuren', r.body);
    const fout1 = await app(im, '/app/imagine/keten', 'POST', { versie: l2.versie, stappen: [], beurt_id: beurt() });
    const fout2 = await app(im, '/app/imagine/keten', 'POST', { versie: l2.versie, stappen: ['krassen', 'dansen'], beurt_id: beurt() });
    const fout3 = await app(im, '/app/imagine/keten', 'POST', { versie: l2.versie, stappen: ['krassen'], beurt_id: beurt() });
    toets('4c. geen stap / onbekende stap = 400; tweede keten op hetzelfde beeld = 409', fout1.status === 400 && fout2.status === 400 && fout3.status === 409, [fout1.status, fout2.status, fout3.status]);
    im.stopTimers();
  }
  // ── 5. volgende stap kon niet starten; herstart tussen stappen ──
  {
    const dir = path.join(W, 'p5'), S = stub();
    let im = nieuweImagine(dir, S);
    const l = await laadFoto(im);
    await app(im, '/app/imagine/keten', 'POST', { versie: l.versie, stappen: ['krassen', 'inkleuren', 'opknappen'], beurt_id: beurt() }, eenVinger());
    S.weiger = 1;   // stap 2 krijgt "rij vol"
    await rondaf(S, 1, beeld);
    await totDat(() => im._db().prepare("SELECT 1 FROM taak WHERE keten_stap = 1 AND status = 'mislukt'").get());
    const t = im._db().prepare('SELECT * FROM taak WHERE keten_stap = 1').get();
    toets('5a. niet gestart = mislukte taak met Opnieuw en vanzelf opnieuw', t && t.status === 'mislukt' && !!t.instel && !!t.auto && /kon niet starten/.test(t.reden), t);
    await im._ronde3();
    await totDat(() => S.starts.length >= 2);
    toets('5b. de ronde probeert het zelf opnieuw, met de vingerafdruk van de tik', S.starts.length === 2 && S.starts[1].flow === 'foto-inkleuren', S.starts.map((x) => x.flow));
    // herstart tussen stap 2 en 3: stap 2 klaar in de databank zonder vervolg, nieuwe instantie (vingerafdruk weg)
    im.stopTimers();
    const db = im._db();
    const t2 = db.prepare("SELECT * FROM taak WHERE keten_stap = 1 AND status IN ('wacht','bezig')").get();
    S.live.delete(S.starts[1].id);
    db.prepare("UPDATE taak SET status = 'klaar', eind = ?, versie = (SELECT id FROM versie WHERE nr = 2) WHERE id = ?").run(new Date(klokT - 5 * 60000).toISOString(), t2.id);
    im = nieuweImagine(dir, S);
    await im._ronde3();
    await totDat(() => im._db().prepare('SELECT 1 FROM taak WHERE keten_stap = 2').get());
    const t3 = im._db().prepare('SELECT * FROM taak WHERE keten_stap = 2').get();
    toets('5c. na een herstart tussen twee stappen hervat de ronde de keten (stap op proef zonder vingerafdruk = mislukt met Opnieuw)', t3 && t3.status === 'mislukt' && /vingerafdruk/.test(t3.reden) && !!t3.instel, t3);
    const k = await ketenVan(im, l.bron);
    toets('5d. keten zegt mislukt met Opnieuw', k.status === 'mislukt' && k.kan_opnieuw === true, k);
    im.stopTimers();
  }
  // ── 6. In Imagine vanuit MemoryLane ──
  {
    const dir = path.join(W, 'p6'), S = stub();
    const im = nieuweImagine(dir, S);
    const a = await app(im, '/app/imagine/laad', 'POST', { immich: UUID, hergebruik: true, titel: 'Zomer' });
    const b = await app(im, '/app/imagine/laad', 'POST', { immich: UUID, hergebruik: true });
    const c = await app(im, '/app/imagine/laad', 'POST', { immich: UUID });
    toets('6b. dezelfde foto uit MemoryLane = hetzelfde beeld (één keer gehaald)', a.status === 200 && b.status === 200 && b.body.al === true && b.body.bron === a.body.bron && b.body.versie === a.body.versie, [a.body, b.body]);
    toets('6c. zonder hergebruik blijft laden een nieuw beeld (zoals altijd)', c.status === 200 && c.body.bron !== a.body.bron && S.immichN === 2);
    const g = await app(im, '/app/imagine');
    toets('6d. lijst kent de keten (stappen en tijd)', g.body.keten && g.body.keten.stappen.length === 4 && g.body.keten.tijd, g.body.keten);
    const w = await app(im, '/app/imagine/bron/' + a.body.bron + '/weg', 'POST', {});
    toets('6e. beeld weggooien kan', w.status === 200);
    im.stopTimers();
  }
  console.log('\n' + goed + ' groen, ' + fouten + ' rood' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('FOUT', e && e.stack); process.exit(2); });
