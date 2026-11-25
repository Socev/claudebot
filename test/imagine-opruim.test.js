'use strict';
// wv4092 (besluitenpagina nr 20 = B121, nr 916 = L16, nr 917 = L17): OVIS Imagine — opruimronde, Opnieuw, vanzelf opnieuw, stapel filmpjes.
// Tegen een nagebootste motor (studio-stub in dit bestand; geen ComfyUI, geen Pillow): imagine.js met een eigen toetsmap en een schuifbare klok.
//   1. opruimronde: geplant weesbestand + .nieuw.-rest + lege weesmap; telweek = geteld en NIET gewist; na de omschakeldatum gewist;
//      een echt beeld met rij blijft altijd staan; vreemde namen nooit gewist; rem bij > de helft wees.
//   2. hangende taak (geen levende studiotaak) → onderbroken; een afronding die gooit → mislukt (geen eeuwige wacht).
//   3. Opnieuw na een mislukte taak (zelfde stand/velden, poging 1, één keer); oude filmtaak van 17-11 met de noot.
//   4. gesimuleerde podherstart: nieuwe instantie op dezelfde map → onderbroken + vanzelf opnieuw zodra de server stil is.
//   5. "server te vol" → één keer vanzelf opnieuw; tweede keer niet.
//   6. stapel van 3: één voor één, één seintje "3 klaar"; stapel vol bij 5; stille uren = geen push.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kecht (koppeling rij ↔ bestand kapot), =ktel (geen telweek), =kafrond (geen afrond-wikkel),
// =kstapel (stapel start alles tegelijk). Verzonnen data.
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 5000); while (Date.now() < t) { if (await f()) return true; await slaap(10); } return false; }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-opruim-'));
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
fs.copyFileSync(path.join(ROOT, 'imagine.js'), path.join(MOD, 'imagine.js'));
function wijzig(oud, nieuw) { const p = path.join(MOD, 'imagine.js'); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden'); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kecht') wijzig("if (!v || v.bron !== b || n !== v.id + '.' + v.ext) wees.push(p);", 'wees.push(p);');
if (KRUIS === 'ktel') wijzig("let stand = nu >= opruimVanaf() ? 'opruimen' : 'tellen';", "let stand = 'opruimen';");
if (KRUIS === 'kafrond') wijzig('    try { await fn(); }\n    catch (e) {', '    try { await fn(); }\n    catch (e) { throw e;');
if (KRUIS === 'kstapel') wijzig("      if (!studioStil() || imagineLoopt()) return;\n      // 1. vanzelf", "      // 1. vanzelf");
const I = require(path.join(MOD, 'imagine.js'));

// ── nep-motor ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
function stub() {
  const live = new Map();
  const S = {
    live: live, starts: [], gooi: false,
    beeldPijp: async function (args, buf) {
      if (S.gooi && args[0] === 'pijp-toon') throw new Error('gooi');
      if (args[0] === 'pijp-toon') return { ok: true, formaat: buf[0] === 0xff ? 'JPEG' : 'PNG', breed: 64, hoog: 48, bytes: JPG };
      if (args[0] === 'pijp-maat') return { ok: true, bytes: PNG, breed: 64, hoog: 48 };
      return { ok: false, reden: 'onbekend' };
    },
    flowVan: async function () { return { klaar: true, reden: null, tijd: '', velden: [{ naam: 'opdracht', soort: 'tekst' }] }; },
    maakGeheugen: async function (o, ctx) {
      for (const t of live.values()) if (t.beurt === o.beurt_id) return { status: 200, taak: { id: t.id }, al: true };
      if (S.weiger) return { status: S.weiger, fout: 'nep geweigerd' };
      const id = 's' + String(S.starts.length).padStart(15, '0');
      live.set(id, { id: id, o: o, beurt: o.beurt_id });
      S.starts.push({ id: id, flow: o.flow, velden: o.velden, beurt: o.beurt_id, vers: ctx.versOk() });
      return { status: 200, taak: { id: id } };
    },
    geheugenTaak: function (id) { return live.has(id) ? { status: 'bezig', fase: 'nep', procent: null, plek_in_rij: null } : null; },
    stopGeheugen: function (id) { const t = live.get(id); if (!t) return { status: 404 }; S.af(id, { status: 'gestopt', reden: 'gestopt', beelden: [] }); return { status: 200 }; },
    health: function () { return { in_rij: live.size, bezig: live.size > 0, taken_vandaag: 0 }; },
    incognito: function () { return { herstart: false, nog_te_wissen: 0 }; },
    // zoals studio.geheugenAf: eerst uit de lijst, dan de callback (afwijzing alleen gelogd)
    af: function (id, u) { const t = live.get(id); live.delete(id); try { Promise.resolve(t.o.klaar(u)).catch(function () {}); } catch (e) {} },
  };
  return S;
}
const film = () => ({ status: 'klaar', reden: null, duur_s: 5, model: 'nep', beelden: [{ video: true, bytes: Buffer.from('0000ftypisom' + 'x'.repeat(40)), affiche: PNG, breed: 64, hoog: 48, beelden: 10 }] });
const beeld = () => ({ status: 'klaar', reden: null, duur_s: 3, model: 'nep', beelden: [{ bytes: PNG, breed: 64, hoog: 48, ext: 'png' }] });
const ctxDavid = { versOk: () => true, versVerbruik: () => {} };
let klokT = Date.parse('2026-11-26T12:00:00+01:00');
const klok = () => klokT;
function nieuweImagine(dir, S, extra) {
  return I.maak(Object.assign({ dir: dir, studio: S, primair: () => true, nu: klok, log: (r) => logs.push(r), fout: () => {}, tempo: { ronde: 3600000, opruim_start: 3600000, opruim: 3600000 },
    opruimVanaf: '2026-12-03T00:00:00+01:00' }, extra || {}));
}
const logs = [];
const app = (im, pad, methode, body, ctx) => im.app({ pad: pad, methode: methode || 'GET', body: body, apparaat: 'toestel-1', ctx: ctx || ctxDavid });
let beurtN = 0; const beurt = () => 'beurt-' + (++beurtN).toString().padStart(6, '0');

(async function () {
  // ── 1. opruimronde ──
  {
    const dir = path.join(W, 'p1'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64'), titel: 'proef' });
    toets('1a echt beeld geladen', l.status === 200, l);
    const bron = l.body.bron, ver = l.body.versie;
    const echt = path.join(dir, 'beelden', bron, ver + '.png'), echtToon = path.join(dir, 'toon', ver + '.jpg');
    const wees = path.join(dir, 'beelden', bron, 'aaaaaaaaaaaaaaaa.png'), weesToon = path.join(dir, 'toon', 'bbbbbbbbbbbbbbbb.jpg');
    const rest = path.join(dir, 'beelden', bron, 'cccccccccccccccc.png.nieuw.4242'), vreemd = path.join(dir, 'beelden', bron, 'notitie.txt');
    const weesMap = path.join(dir, 'beelden', 'dddddddddddddddd');
    fs.writeFileSync(wees, PNG); fs.writeFileSync(weesToon, JPG); fs.writeFileSync(rest, PNG); fs.writeFileSync(vreemd, 'x'); fs.mkdirSync(weesMap);
    const oud = (klokT - 2 * 3600 * 1000) / 1000; fs.utimesSync(rest, oud, oud);
    const r1 = im._opruim();
    toets('1b telweek: geteld (2 wees, 1 rest, 1 map, 1 vreemd), stand tellen', r1.stand === 'tellen' && r1.wees === 2 && r1.rest === 1 && r1.mappen === 1 && r1.vreemd === 1 && r1.gewist === 0, r1);
    toets('1c telweek: niets gewist', [wees, weesToon, rest, vreemd, weesMap, echt, echtToon].every((p) => fs.existsSync(p)));
    toets('1d logregel zonder namen', logs.some((x) => /^imagine opruim stand=tellen wees=2 rest=1 mappen=1 vreemd=1 gewist=0$/.test(x)), logs.slice(-3));
    const info1 = im.info();
    toets('1e /health opruim zonder namen', info1.opruim && info1.opruim.stand === 'tellen' && info1.opruim.wees === 2 && !JSON.stringify(info1).includes('aaaa'), info1.opruim);
    klokT = Date.parse('2026-12-03T09:00:00+01:00');
    const r2 = im._opruim();
    toets('1f na de omschakeldatum: wees, rest en lege weesmap gewist', r2.stand === 'opruimen' && r2.gewist === 4 && ![wees, weesToon, rest, weesMap].some((p) => fs.existsSync(p)), r2);
    toets('1g kruisproef: echt beeld met rij blijft (bestand + weergave)', fs.existsSync(echt) && fs.existsSync(echtToon));
    toets('1h vreemde naam blijft', fs.existsSync(vreemd));
    // rem: meer dan de helft wees (bv. een verkeerde databank) → niets wissen
    for (const h of ['1111111111111111', '2222222222222222', '3333333333333333', '4444444444444444']) fs.writeFileSync(path.join(dir, 'beelden', bron, h + '.png'), PNG);
    const r3 = im._opruim();
    toets('1i rem: > de helft wees → stand rem, niets gewist', r3.stand === 'rem' && r3.gewist === 0 && fs.existsSync(path.join(dir, 'beelden', bron, '1111111111111111.png')), r3);
    im.stopTimers();
    klokT = Date.parse('2026-11-26T12:00:00+01:00');
  }

  // ── 2. hangende taak en afronding die gooit ──
  {
    const dir = path.join(W, 'p2'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') });
    const db = im._db();
    db.prepare("INSERT INTO taak (id, studio, bron, voorganger, stand, status, gemaakt) VALUES ('eeeeeeeeeeeeeeee', 'sweg', ?, ?, 'opknappen', 'bezig', ?)").run(l.body.bron, l.body.versie, new Date(klokT).toISOString());
    await im._ronde2();
    const t = db.prepare("SELECT status, reden FROM taak WHERE id = 'eeeeeeeeeeeeeeee'").get();
    toets('2a taak zonder levende studiotaak → onderbroken', t.status === 'onderbroken', t);
    toets('2b daarna mag de bron weg (geen 409)', (await app(im, '/app/imagine/bron/' + l.body.bron + '/weg', 'POST', {})).status === 200);
    // afronding die gooit (toets in naKlaar gooit)
    const l2 = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') });
    const b = await app(im, '/app/imagine/bewerk', 'POST', { versie: l2.body.versie, stand: 'opknappen', velden: {}, beurt_id: beurt() });
    toets('2c bewerk gestart', b.status === 200, b);
    const sid = S.starts[S.starts.length - 1].id;
    await im._ronde2();
    toets('2d lopende taak blijft staan in de ronde', db.prepare('SELECT status FROM taak WHERE id = ?').get(b.body.taak.id).status === 'wacht');
    S.gooi = true; S.af(sid, beeld());
    const ok = await totDat(() => db.prepare('SELECT status FROM taak WHERE id = ?').get(b.body.taak.id).status === 'mislukt', 2000);
    S.gooi = false;
    toets('2e afronding gooit → mislukt (geen eeuwige wacht)', ok, db.prepare('SELECT status, reden FROM taak WHERE id = ?').get(b.body.taak.id));
    im.stopTimers();
  }

  // ── 3. Opnieuw ──
  {
    const dir = path.join(W, 'p3'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') });
    const b = await app(im, '/app/imagine/bewerk', 'POST', { versie: l.body.versie, stand: 'opdracht-qwen', velden: { opdracht: 'maak de lucht paars', pod_x: 9 }, beurt_id: beurt() });
    S.af(S.starts[0].id, { status: 'mislukt', reden: 'nep mislukt', beelden: [] });
    await totDat(() => im._db().prepare('SELECT status FROM taak WHERE id = ?').get(b.body.taak.id).status === 'mislukt');
    const g = await app(im, '/app/imagine');
    const t = g.body.taken.find((x) => x.id === b.body.taak.id);
    toets('3a mislukte taak: kan_opnieuw', t && t.kan_opnieuw === true, t);
    const o = await app(im, '/app/imagine/opnieuw/' + b.body.taak.id, 'POST', { beurt_id: beurt() });
    toets('3b Opnieuw start dezelfde stand met dezelfde opdracht (pod_* eruit)', o.status === 200 && S.starts.length === 2 && S.starts[1].velden.opdracht === 'maak de lucht paars' && S.starts[1].velden.pod_x === undefined, { o: o, s: S.starts[1] });
    const db = im._db();
    const oudR = db.prepare('SELECT opnieuw, instel FROM taak WHERE id = ?').get(b.body.taak.id), nieuwR = db.prepare('SELECT poging, instel FROM taak WHERE id = ?').get(o.body.taak.id);
    toets('3c oude taak wijst naar de herhaling, nieuwe heeft poging 1', oudR.opnieuw === o.body.taak.id && nieuwR.poging === 1 && !oudR.instel, { oudR, nieuwR });
    const o2 = await app(im, '/app/imagine/opnieuw/' + b.body.taak.id, 'POST', { beurt_id: beurt() });
    toets('3d tweede tik = dezelfde herhaling, geen nieuwe start', o2.status === 200 && o2.body.al === true && S.starts.length === 2, o2);
    S.af(S.starts[1].id, beeld());
    await totDat(() => db.prepare('SELECT status FROM taak WHERE id = ?').get(o.body.taak.id).status === 'klaar');
    toets('3e klaar → instellingen (opdracht) niet meer in de taakrij', db.prepare('SELECT instel FROM taak WHERE id = ?').get(o.body.taak.id).instel === null);
    // oude filmtaak van 17-11 zonder instel
    db.prepare("INSERT INTO taak (id, studio, bron, voorganger, stand, status, reden, gemaakt) VALUES ('ffffffffffffffff', 'soud', ?, ?, 'bewegen', 'mislukt', 'afgebroken: server te vol (het werkgeheugen van ComfyUI zakte onder 12 GB); er wordt niets herhaald', '2026-11-17T14:47:07.849Z')").run(l.body.bron, l.body.versie);
    const g2 = await app(im, '/app/imagine');
    const t2 = g2.body.taken.find((x) => x.id === 'ffffffffffffffff');
    toets('3f filmtaak 17-11: noot "Dit past sinds 18-11 wel. Opnieuw?" + kan_opnieuw', t2 && t2.noot === 'Dit past sinds 18-11 wel. Opnieuw?' && t2.kan_opnieuw, t2);
    const o3 = await app(im, '/app/imagine/opnieuw/ffffffffffffffff', 'POST', { beurt_id: beurt() });
    toets('3g Opnieuw van die filmtaak start de standaardkeuze (Trouw)', o3.status === 200 && S.starts[S.starts.length - 1].flow === 'video-minimax-trouw', o3);
    S.af(S.starts[S.starts.length - 1].id, film());
    im.stopTimers();
  }

  // ── 4. podherstart ──
  {
    const dir = path.join(W, 'p4'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') });
    const b = await app(im, '/app/imagine/bewegen', 'POST', { versie: l.body.versie, model: 'snel', beweging: 'de hond kwispelt', beurt_id: beurt() });
    toets('4a film gestart', b.status === 200, b);
    im.stopTimers();
    // "herstart": nieuwe motor (leeg) en nieuwe imagine op dezelfde map
    const S2 = stub();
    const im2 = nieuweImagine(dir, S2);
    const g = await app(im2, '/app/imagine');
    const t = g.body.taken.find((x) => x.id === b.body.taak.id);
    toets('4b na herstart: onderbroken en vanzelf opnieuw gepland', t && t.status === 'onderbroken' && t.auto === true, t);
    S2.live.set('sbezet', { id: 'sbezet', o: { klaar: () => {} }, beurt: 'x' });
    await im2._ronde2();
    toets('4c niet zolang de server bezig is', S2.starts.length === 0);
    S2.live.delete('sbezet');
    await im2._ronde2();
    toets('4d server stil → dezelfde film opnieuw (Snel, eigen beweging, zonder vingerafdruk)', S2.starts.length === 1 && S2.starts[0].flow === 'video-wan-snel' && S2.starts[0].velden.opdracht === 'de hond kwispelt' && S2.starts[0].vers === false, S2.starts);
    const db = im2._db();
    const nieuwId = db.prepare('SELECT opnieuw FROM taak WHERE id = ?').get(b.body.taak.id).opnieuw;
    toets('4e herhaling heeft poging 1', nieuwId && db.prepare('SELECT poging FROM taak WHERE id = ?').get(nieuwId).poging === 1);
    im2.stopTimers();
    // nog een herstart tijdens de herhaling: poging 1 → niet nog eens vanzelf
    const S3 = stub(), im3 = nieuweImagine(dir, S3);
    const t3 = (await app(im3, '/app/imagine')).body.taken.find((x) => x.id === nieuwId);
    await im3._ronde2();
    toets('4f tweede herstart: alleen de knop Opnieuw, niet vanzelf', t3 && t3.status === 'onderbroken' && t3.auto === false && t3.kan_opnieuw === true && S3.starts.length === 0, t3);
    im3.stopTimers();
  }

  // ── 5. server te vol ──
  {
    const dir = path.join(W, 'p5'), S = stub();
    const im = nieuweImagine(dir, S);
    const l = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') });
    const b = await app(im, '/app/imagine/bewegen', 'POST', { versie: l.body.versie, beurt_id: beurt() });
    const vol = { status: 'mislukt', reden: 'afgebroken: server te vol (het werkgeheugen van ComfyUI zakte onder 12 GB); er wordt niets herhaald', beelden: [] };
    S.af(S.starts[0].id, vol);
    await totDat(() => im._db().prepare('SELECT status FROM taak WHERE id = ?').get(b.body.taak.id).status === 'mislukt');
    await im._ronde2();
    toets('5a te vol → één keer vanzelf opnieuw', S.starts.length === 2, S.starts.length);
    S.af(S.starts[1].id, vol);
    await slaap(30);
    klokT += 10 * 60 * 1000;
    await im._ronde2();
    toets('5b tweede keer te vol → niet nog eens', S.starts.length === 2, S.starts.length);
    im.stopTimers();
    klokT = Date.parse('2026-11-26T12:00:00+01:00');
  }

  // ── 6. stapel ──
  {
    const dir = path.join(W, 'p6'), S = stub();
    let seintjes = 0;
    const im = nieuweImagine(dir, S, { seintje: () => { seintjes++; } });
    const vs = [];
    for (let i = 0; i < 6; i++) vs.push((await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64') })).body.versie);
    const st = [];
    for (let i = 0; i < 3; i++) st.push(await app(im, '/app/imagine/bewegen', 'POST', { versie: vs[i], stapel: true, beurt_id: beurt() }));
    toets('6a drie foto\'s in de stapel, één groep', st.every((x) => x.status === 200 && x.body.taak.status === 'stapel') && new Set(st.map((x) => x.body.taak.stapel)).size === 1, st.map((x) => x.status));
    await slaap(20);
    await im._ronde2(); await im._ronde2();
    toets('6b één voor één: er loopt er maar één', S.starts.length === 1 && S.live.size === 1, S.starts.length);
    const g0 = await app(im, '/app/imagine');
    toets('6c bewegen toont de stapel (2 wachten)', g0.body.bewegen.stapel.n === 2 && g0.body.bewegen.stapel.max === 5, g0.body.bewegen.stapel);
    const weg = await app(im, '/app/imagine/bron/' + st[1].body.taak.bron + '/weg', 'POST', {});
    toets('6d bron met een stapelrij kan niet weg (409)', weg.status === 409, weg);
    for (let i = 0; i < 3; i++) {
      S.af(S.starts[S.starts.length - 1].id, film());
      await totDat(() => !S.live.size && !im._db().prepare("SELECT 1 FROM taak WHERE status IN ('wacht','bezig')").get());
      await im._ronde2();
    }
    toets('6e alle drie gemaakt', S.starts.length === 3 && im._db().prepare("SELECT COUNT(*) AS n FROM taak WHERE stapel IS NOT NULL AND status = 'klaar'").get().n === 3, S.starts.length);
    const g = await app(im, '/app/imagine');
    toets('6f één seintje "3 filmpjes klaar"', seintjes === 1 && g.body.seintjes.length === 1 && g.body.seintjes[0].klaar === 3 && g.body.seintjes[0].mislukt === 0, { seintjes, s: g.body.seintjes });
    const gz = await app(im, '/app/imagine/seintje/' + g.body.seintjes[0].groep + '/gezien', 'POST', {});
    toets('6g Gezien → weg', gz.status === 200 && (await app(im, '/app/imagine')).body.seintjes.length === 0);
    // stapel vol bij 5 (de server is bezig met iets anders, dus niets start)
    S.live.set('sbezet', { id: 'sbezet', o: { klaar: () => {} }, beurt: 'x' });
    const r = [];
    for (let i = 0; i < 6; i++) r.push((await app(im, '/app/imagine/bewegen', 'POST', { versie: vs[i % 6], stapel: true, beurt_id: beurt() })).status);
    toets('6h stapel vol: vijf erin, de zesde 429', r.slice(0, 5).every((x) => x === 200) && r[5] === 429, r);
    // uit de stapel halen; stille uren = geen push, wel het seintje in Imagine
    const rijen = im._db().prepare("SELECT id FROM taak WHERE status = 'stapel'").all();
    klokT = Date.parse('2026-11-26T23:30:00+01:00');
    for (const x of rijen.slice(0, 4)) await app(im, '/app/imagine/stop/' + x.id, 'POST', {});
    toets('6i Stop haalt uit de stapel', im._db().prepare("SELECT COUNT(*) AS n FROM taak WHERE status = 'stapel'").get().n === 1);
    S.live.delete('sbezet');
    await im._ronde2();
    S.af(S.starts[S.starts.length - 1].id, film());
    await totDat(() => (im._db().prepare('SELECT COUNT(*) AS n FROM seintje').get().n === 2));
    const s2 = im._db().prepare('SELECT * FROM seintje ORDER BY op DESC').get();
    toets('6j stille uren: seintje in Imagine (1 klaar, 4 gestopt), geen push', s2 && s2.klaar === 1 && s2.mislukt === 4 && seintjes === 1, { s2, seintjes });
    im.stopTimers();
  }

  console.log('\n' + goed + ' groen, ' + fouten + ' rood' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  onverwacht: ' + (e && e.stack || e)); process.exit(1); });
