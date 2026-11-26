'use strict';
// wv4096 (besluitenpagina nr 161 = 2C61 e, nr 913 = L13): OVIS Imagine — "Maak er 4", "Nog een" (variant als versie) en een stand vast aanzetten.
// Tegen een nagebootste motor (studio-stub; geen ComfyUI, geen Pillow), zoals test/imagine-opruim.test.js. Verzonnen data.
//   1. Maak er 4 (gewoon): vier starts met één vingerafdruk (één keer verbruikt), alle vier met vers; resultaat = één beeld met vier versies.
//   2. Nog een (bij): het resultaat wordt versie 5 van hetzelfde beeld; bij een geladen foto 409; bron weg tijdens de taak = mislukt, niets nieuws.
//   3. Grenzen: te weinig plek in de rij of over de dag = 429 vóór er iets start; aantal 5 = 400.
//   4. Opnieuw na een mislukte "Nog een" houdt het doelbeeld.
//   5. Incognito Maak er 4: vier starts, één keer verbruikt; geen plek voor vier = 409.
//   6. Vast aanzetten: zonder verse vingerafdruk 403; met = activeer op de hoofdflow én de stuk-/voorbeeldflows; uit = terug op proef zonder vingerafdruk.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kvers (elke start eigen vingerafdruk), =kreeks (elke uitkomst een nieuw beeld), =kvast (aan zonder vingerafdruk).
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 5000); while (Date.now() < t) { if (await f()) return true; await slaap(10); } return false; }

const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-reeks-'));
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
fs.copyFileSync(path.join(ROOT, 'imagine.js'), path.join(MOD, 'imagine.js'));
function wijzig(oud, nieuw) { const p = path.join(MOD, 'imagine.js'); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden'); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kvers') wijzig("const r = await nieuw(Object.assign({}, d, { beurt_id: beurt + '-' + i, uitbreiding: i === 1 ? d.uitbreiding : undefined }), ctx2,", "const r = await nieuw(Object.assign({}, d, { beurt_id: beurt + '-' + i, uitbreiding: i === 1 ? d.uitbreiding : undefined }), ctx,");
if (KRUIS === 'kreeks') wijzig('    const doel = variantDoel(bij, reeks, taakId);', '    const doel = null;');
if (KRUIS === 'kvast') wijzig("      if (!ctx.versOk()) return { status: 403, fout: 'bevestig het vast aanzetten met je vingerafdruk', vers_nodig: true };", '');
const I = require(path.join(MOD, 'imagine.js'));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
function stub() {
  const live = new Map();
  const flows = { 'beeld-tekst-moss': 'proef', 'beeld-tekst-flux': 'proef', 'beeld-opdracht-qwen': 'proef', 'beeld-plus-qwen-0': 'proef', 'beeld-plus-qwen-1': 'proef', 'beeld-plus-qwen-2': 'actief' };
  const S = {
    live: live, starts: [], flows: flows, act: [], prf: [], vandaag: 0, extraRij: 0,
    beeldPijp: async function (args, buf) {
      if (args[0] === 'pijp-toon') return { ok: true, formaat: buf[0] === 0xff ? 'JPEG' : 'PNG', breed: 64, hoog: 48, bytes: JPG };
      return { ok: false, reden: 'onbekend' };
    },
    flowVan: async function (id) { return { id: id, klaar: true, reden: null, tijd: '', status: flows[id] || 'proef', betaald: false, vers_per_keer: (flows[id] || 'proef') === 'proef', velden: [{ naam: 'opdracht', soort: 'tekst' }] }; },
    activeer: function (id, ctx) {
      if (!(id in flows)) return { status: 404, fout: 'geen' };
      if (flows[id] !== 'proef') return { status: 409, fout: 'niet op proef' };
      if (!ctx.versOk()) return { status: 403, fout: 'vers', vers_nodig: true };
      ctx.versVerbruik(); flows[id] = 'actief'; S.act.push(id); return { status: 200 };
    },
    opProef: function (id) { if (!(id in flows)) return { status: 404 }; if (flows[id] !== 'actief') return { status: 409 }; flows[id] = 'proef'; S.prf.push(id); return { status: 200 }; },
    maakGeheugen: async function (o, ctx) {
      for (const t of live.values()) if (t.beurt === o.beurt_id) return { status: 200, taak: { id: t.id }, al: true };
      if (S.weiger) return { status: S.weiger, fout: 'nep geweigerd' };
      if (!ctx.versOk()) return { status: 403, fout: 'deze flow is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
      ctx.versVerbruik();
      const id = 's' + String(S.starts.length).padStart(15, '0');
      live.set(id, { id: id, o: o, beurt: o.beurt_id });
      S.starts.push({ id: id, flow: o.flow, velden: o.velden, beurt: o.beurt_id, geheim: o.geheim });
      S.vandaag++;
      return { status: 200, taak: { id: id } };
    },
    geheugenTaak: function (id) { return live.has(id) ? { status: 'bezig', fase: 'nep', procent: null, plek_in_rij: null } : null; },
    stopGeheugen: function (id) { const t = live.get(id); if (!t) return { status: 404 }; S.af(id, { status: 'gestopt', reden: 'gestopt', beelden: [] }); return { status: 200 }; },
    health: function () { return { in_rij: live.size + S.extraRij, bezig: live.size > 0, taken_vandaag: S.vandaag }; },
    incognito: function () { return { herstart: false, nog_te_wissen: 0 }; },
    geheimWis: async function () { return { stappen: [], schoon: true }; },
    af: function (id, u) { const t = live.get(id); live.delete(id); try { Promise.resolve(t.o.klaar(u)).catch(function () {}); } catch (e) {} },
  };
  return S;
}
const beeld = () => ({ status: 'klaar', reden: null, duur_s: 3, model: 'nep', beelden: [{ bytes: PNG, breed: 64, hoog: 48, ext: 'png' }] });
// één verse vingerafdruk: versOk tot hij verbruikt is
function ctxVers() { const c = { verbruikt: 0, vers: true }; c.versOk = () => c.vers; c.versVerbruik = () => { c.verbruikt++; c.vers = false; }; return c; }
const ctxNiet = { versOk: () => false, versVerbruik: () => {} };
let klokT = Date.parse('2026-11-26T12:00:00+01:00');
const klok = () => klokT;
const logs = [];
function nieuweImagine(dir, S) {
  return I.maak({ dir: dir, studio: S, primair: () => true, nu: klok, log: (r) => logs.push(r), fout: () => {}, tempo: { ronde: 3600000, opruim_start: 3600000, opruim: 3600000 }, opruimVanaf: '2026-12-03T00:00:00+01:00' });
}
const app = (im, pad, methode, body, ctx) => im.app({ pad: pad, methode: methode || 'GET', body: body, apparaat: 'toestel-1', ctx: ctx });
let beurtN = 0; const beurt = () => 'beurt-' + (++beurtN).toString().padStart(6, '0');
async function afAlles(S) { for (const id of [...S.live.keys()]) { S.af(id, beeld()); await slaap(30); } }

(async function () {
  const S = stub();
  const im = nieuweImagine(path.join(W, 'p1'), S);
  let bronId = null;
  // ── 1. Maak er 4 ──
  {
    const c = ctxVers();
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een vuurtoren bij nacht' }, beurt_id: beurt(), aantal: 4 }, c);
    toets('1a Maak er 4: 200 met vier taken', r.status === 200 && r.body.taken && r.body.taken.length === 4, r);
    toets('1b vier starts in de motor', S.starts.length === 4, S.starts.length);
    toets('1c één vingerafdruk, één keer verbruikt', c.verbruikt === 1, c.verbruikt);
    await afAlles(S);
    await totDat(async () => (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body.taken.every((t) => t.status === 'klaar'));
    const l = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body;
    toets('1d resultaat = één beeld (bron)', l.bronnen.length === 1, l.bronnen.length);
    bronId = l.bronnen[0] && l.bronnen[0].id;
    const b = (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body;
    const vs = b.versies || [];
    toets('1e met vier versies, nr 1–4', vs.length === 4 && vs.map((v) => v.nr).join() === '1,2,3,4', vs.map((v) => v.nr));
    toets('1f versie 2–4: voorganger = het origineel, stand tekst', vs.slice(1).every((v) => v.voorganger === vs[0].id && v.stand === 'tekst'), vs.map((v) => [v.voorganger, v.stand]));
    toets('1g elke versie heeft de opdracht', vs.every((v) => v.opdracht === 'een vuurtoren bij nacht'));
  }
  // ── 2. Nog een ──
  {
    const c = ctxVers();
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een vuurtoren bij nacht' }, beurt_id: beurt(), bij: bronId }, c);
    toets('2a Nog een: 200', r.status === 200, r);
    const b0 = (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body;
    toets('2b de lopende taak staat bij het beeld (Bewerken ziet hem)', b0.taken.some((t) => t.status === 'bezig' || t.status === 'wacht'), b0.taken.map((t) => t.status));
    await afAlles(S);
    await totDat(async () => (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body.versies.length === 5);
    const b = (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body;
    toets('2c resultaat = versie 5 van hetzelfde beeld', b.versies.length === 5 && b.versies[4].nr === 5, b.versies.length);
    const l = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body;
    toets('2d geen nieuw beeld erbij', l.bronnen.length === 1, l.bronnen.length);
    // Nog een zonder opdracht (vanuit Bewerken): de pod neemt de instellingen van het beeld
    const n0 = S.starts.length;
    const r5 = await app(im, '/app/imagine/nieuw', 'POST', { beurt_id: beurt(), bij: bronId }, ctxVers());
    toets('2g Nog een zonder opdracht: zelfde opdracht en model als het beeld', r5.status === 200 && S.starts[n0] && S.starts[n0].velden.opdracht === 'een vuurtoren bij nacht' && S.starts[n0].flow === 'beeld-tekst-moss', [r5.status, S.starts[n0]]);
    await afAlles(S);
    await totDat(async () => (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body.versies.length === 6);
    const f = await app(im, '/app/imagine/laad', 'POST', { data: PNG.toString('base64'), titel: 'foto' }, ctxNiet);
    const r2 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), bij: f.body.bron }, ctxVers());
    toets('2e Nog een bij een geladen foto: 409', r2.status === 409, r2);
    const r3 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), bij: '0123456789abcdef' }, ctxVers());
    toets('2f Nog een bij een onbekend beeld: 404', r3.status === 404, r3);
  }
  // ── 3. grenzen ──
  {
    const n0 = S.starts.length;
    S.extraRij = 2;
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), aantal: 4 }, ctxVers());
    toets('3a te weinig plek in de rij: 429, niets gestart', r.status === 429 && S.starts.length === n0, [r.status, S.starts.length - n0]);
    S.extraRij = 0; const v0 = S.vandaag; S.vandaag = 28;
    const r2 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), aantal: 4 }, ctxVers());
    toets('3b over de 30 van vandaag: 429', r2.status === 429 && S.starts.length === n0, r2.status);
    S.vandaag = v0;
    const r3 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), aantal: 5 }, ctxVers());
    toets('3c aantal 5: 400', r3.status === 400, r3.status);
    const r4 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'x' }, beurt_id: beurt(), aantal: 4 }, ctxNiet);
    toets('3d zonder vingerafdruk (proef): 403 vers_nodig, niets gestart', r4.status === 403 && r4.body.vers_nodig && S.starts.length === n0, r4);
  }
  // ── 4. Opnieuw houdt het doelbeeld ──
  {
    await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een vuurtoren bij nacht' }, beurt_id: beurt(), bij: bronId }, ctxVers());
    for (const id of [...S.live.keys()]) S.af(id, { status: 'mislukt', reden: 'nep mislukt', beelden: [] });
    await slaap(50);
    const l = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body;
    const t = l.taken.find((x) => x.status === 'mislukt');
    toets('4a mislukte Nog een kan opnieuw', !!(t && t.kan_opnieuw), l.taken.map((x) => [x.status, x.kan_opnieuw]));
    const r = await app(im, '/app/imagine/opnieuw/' + (t && t.id), 'POST', { beurt_id: beurt() }, ctxVers());
    toets('4b Opnieuw gestart', r.status === 200, r);
    await afAlles(S);
    await totDat(async () => (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body.versies.length === 7);
    const b = (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body;
    toets('4c resultaat van Opnieuw = versie 7 van hetzelfde beeld', b.versies.length === 7, b.versies.length);
  }
  // ── 5. incognito ──
  {
    const n0 = S.starts.length, c = ctxVers();
    const r = await app(im, '/app/imagine/incognito/nieuw', 'POST', { velden: { opdracht: 'een kat' }, beurt_id: beurt(), aantal: 4 }, c);
    toets('5a incognito Maak er 4: 200, vier starts, geheim', r.status === 200 && S.starts.length === n0 + 4 && S.starts.slice(n0).every((x) => x.geheim === true), [r.status, S.starts.length - n0]);
    toets('5b één keer verbruikt', c.verbruikt === 1, c.verbruikt);
    await afAlles(S);
    await totDat(async () => (await app(im, '/app/imagine/incognito', 'GET', null, ctxNiet)).body.beelden.length === 4);
    const l = (await app(im, '/app/imagine/incognito', 'GET', null, ctxNiet)).body;
    toets('5c vier beelden in de sessie', l.beelden.length === 4, l.beelden.length);
    for (let i = 0; i < 2; i++) { await app(im, '/app/imagine/incognito/nieuw', 'POST', { velden: { opdracht: 'een kat' }, beurt_id: beurt(), aantal: 4 }, ctxVers()); await afAlles(S); }
    await slaap(50);
    const n1 = S.starts.length;
    const r2 = await app(im, '/app/imagine/incognito/nieuw', 'POST', { velden: { opdracht: 'een kat' }, beurt_id: beurt(), aantal: 4 }, ctxVers());
    toets('5d geen plek voor vier (12 in het geheugen): 409, niets gestart', r2.status === 409 && S.starts.length === n1, [r2.status, S.starts.length - n1]);
  }
  // ── 6. vast aanzetten ──
  {
    const l = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body;
    const q = l.standen.find((s) => s.id === 'opdracht-qwen');
    toets('6a standen tonen sleutel en vast (één voorbeeldflow staat al vast = de stand toont vast)', q && q.sleutel === 'opdracht-qwen' && q.vast === 'actief' && l.teksten.some((t) => t.sleutel === 'tekst-moss' && t.vast === 'proef'), [q && q.sleutel, q && q.vast, l.teksten.map((t) => t.sleutel)]);
    const r0 = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: true }, ctxNiet);
    toets('6b aan zonder verse vingerafdruk: 403 vers_nodig, niets veranderd', r0.status === 403 && r0.body.vers_nodig && S.act.length === 0, r0);
    const c = ctxVers();
    const r = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: true }, c);
    toets('6c aan met vingerafdruk: hoofdflow + stuk-/voorbeeldflows vast', r.status === 200 && S.flows['beeld-opdracht-qwen'] === 'actief' && S.flows['beeld-plus-qwen-0'] === 'actief' && S.flows['beeld-plus-qwen-1'] === 'actief', [r, S.flows]);
    toets('6d één keer verbruikt; andere standen ongemoeid', c.verbruikt === 1 && S.flows['beeld-tekst-moss'] === 'proef', [c.verbruikt, S.flows['beeld-tekst-moss']]);
    const r1 = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: false }, ctxNiet);
    toets('6e uit (terug op proef) zonder vingerafdruk', r1.status === 200 && S.flows['beeld-opdracht-qwen'] === 'proef' && S.flows['beeld-plus-qwen-2'] === 'proef', [r1, S.flows]);
    const r2 = await app(im, '/app/imagine/vast/tekst-moss', 'POST', { aan: true }, ctxVers());
    toets('6f tekst-moss vast', r2.status === 200 && S.flows['beeld-tekst-moss'] === 'actief' && S.flows['beeld-tekst-flux'] === 'proef', S.flows);
    // review Codex MOET 1: een onderdeel dat niet terug wil, geeft geen succes
    S.flows['beeld-tekst-moss'] = 'actief';
    const oud = S.opProef; S.opProef = function (id) { if (id === 'beeld-plus-qwen-1') return { status: 500 }; return oud(id); };
    await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: true }, ctxVers());
    const r4 = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: false }, ctxNiet);
    toets('6h terugzetten half gelukt: geen 200, zegt hoeveel nog vast staan', r4.status === 500 && /1 van 4/.test(r4.body.fout), r4);
    const lh = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body.standen.find((x) => x.id === 'opdracht-qwen');
    toets('6i half teruggezet: de stand toont nog "vast" (zodat David opnieuw kan terugzetten)', lh.vast === 'actief', lh.vast);
    S.opProef = oud;
    const r6 = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: false }, ctxNiet);
    toets('6j opnieuw terugzetten lukt dan helemaal', r6.status === 200 && S.flows['beeld-plus-qwen-1'] === 'proef', [r6, S.flows]);
    const ofv = S.flowVan; S.flowVan = async function (id) { if (id === 'beeld-plus-qwen-0') throw new Error('nep leesfout'); return ofv(id); };
    const r7 = await app(im, '/app/imagine/vast/opdracht-qwen', 'POST', { aan: false }, ctxNiet);
    toets('6k leesfout tijdens nalopen = geen 200', r7.status === 500, r7);
    S.flowVan = ofv;
    // ronde 3: een vaste voorbeeldflow achter een ontbrekende telt ook
    S.flows['beeld-plus-qwen-2'] = 'actief';
    S.flowVan = async function (id) { if (id === 'beeld-plus-qwen-1') return null; return ofv(id); };
    const lg = (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body.standen.find((x) => x.id === 'opdracht-qwen');
    toets('6l vaste voorbeeldflow na een ontbrekende: stand toont vast, voorbeelden tot de ontbrekende', lg.vast === 'actief' && lg.refs_max === 0, [lg.vast, lg.refs_max]);
    S.flowVan = ofv;
    const r3 = await app(im, '/app/imagine/vast/bestaat-niet', 'POST', { aan: true }, ctxVers());
    toets('6g onbekende stand: 404', r3.status === 404, r3.status);
  }
  try { im.stopTimers(); } catch (e) {}
  console.log('\n' + goed + ' groen, ' + fouten + ' rood' + (KRUIS ? ' (kruisproef ' + KRUIS + ')' : ''));
  try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {}
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
