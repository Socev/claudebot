'use strict';
// wv4099 (besluitenpagina nr 914 = L14, nr 915 = L15): OVIS Imagine — recepten en Nederlands typen met meteen maken.
// Tegen een nagebootste motor (studio-stub zoals test/imagine-reeks.test.js; geen ComfyUI). Verzonnen data.
//   1. Meteen maken: eerst de uitbreidflow op de eigen tekst, dan vanzelf de beeldflow met de Engelse tekst; één vingerafdruk; titel = eigen
//      tekst, versie-opdracht = Engelse tekst; Nog een daarna = dezelfde Engelse tekst zonder opnieuw uit te schrijven.
//   2. Zonder verse vingerafdruk 403 vóór er iets start; rij vol 429 vóór er iets start.
//   3. Uitschrijven mislukt: taak mislukt met reden, geen beeldstart; Opnieuw schrijft opnieuw uit.
//   4. Maak er 4 met meteen maken: vier uitschrijvingen, één vingerafdruk.
//   5. Recepten: vaste lijst, eigen recept bewaren (dubbel = bijwerken), alleen bij een vrije opdracht, weggooien.
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kmeteen (uitschrijven genegeerd), =kvers (stap 2 zonder de vingerafdruk van de tik).
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 5000); while (Date.now() < t) { if (await f()) return true; await slaap(10); } return false; }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-recept-'));
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
fs.copyFileSync(path.join(ROOT, 'imagine.js'), path.join(MOD, 'imagine.js'));
function wijzig(oud, nieuw) { const p = path.join(MOD, 'imagine.js'); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden'); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kmeteen') wijzig('const metUit = d && d.uitschrijven === true && !bij;', 'const metUit = false;');
if (KRUIS === 'kvers') wijzig("const ctx2 = Object.assign({}, ctx, { versOk: function () { return vers; }, versVerbruik: function () {} });\n    const beurt = String(d.beurt_id || '');", "const ctx2 = ctx;\n    const beurt = String(d.beurt_id || '');");
const I = require(path.join(MOD, 'imagine.js'));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
function stub() {
  const live = new Map();
  const flows = { 'beeld-tekst-moss': 'proef', 'beeld-tekst-flux': 'proef', 'beeld-opdracht-qwen': 'proef', 'beeld-plus-qwen-0': 'proef', 'beeld-plus-qwen-1': 'proef', 'beeld-plus-qwen-2': 'actief', 'opdracht-uitbreiden': 'actief' };
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
      if ((flows[o.flow] || 'proef') === 'proef') {   // zoals studio.js: alleen een flow op proef vraagt (en verbruikt) de vingerafdruk
        if (!ctx.versOk()) return { status: 403, fout: 'deze flow is nog op proef: bevestig met je vingerafdruk', vers_nodig: true };
        ctx.versVerbruik();
      }
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

const tekstUit = (t) => ({ status: 'klaar', reden: null, duur_s: 2, tekst: t, beelden: [] });
(async function () {
  const S = stub();
  const im = nieuweImagine(path.join(W, 'p1'), S);
  const lijst = async () => (await app(im, '/app/imagine', 'GET', null, ctxNiet)).body;
  // ── 1. meteen maken ──
  let bronId = null;
  {
    const c = ctxVers();
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een vuurtoren bij nacht' }, uitschrijven: true, beurt_id: beurt() }, c);
    toets('1a meteen maken: 200, eerste start = uitbreidflow met de eigen tekst', r.status === 200 && S.starts.length === 1 && S.starts[0].flow === 'opdracht-uitbreiden' && S.starts[0].velden.opdracht === 'een vuurtoren bij nacht', [r.status, S.starts]);
    toets('1b één vingerafdruk, bij de tik verbruikt', c.verbruikt === 1, c.verbruikt);
    const t0 = (await lijst()).taken[0];
    toets('1c taak zegt: wordt uitgeschreven', t0 && t0.uitschrijven === true && t0.fase === 'wordt uitgeschreven', t0);
    S.af(S.starts[0].id, tekstUit('A tall lighthouse on a rocky coast at night, its beam cutting through light fog.'));
    await totDat(async () => S.starts.length === 2);
    toets('1d daarna vanzelf de beeldflow met de Engelse tekst', S.starts.length === 2 && S.starts[1].flow === 'beeld-tekst-moss' && /^A tall lighthouse/.test(S.starts[1].velden.opdracht), S.starts);
    const t1 = (await lijst()).taken[0];
    toets('1e taak niet meer in de uitschrijffase', t1 && !t1.uitschrijven && t1.status === 'bezig', t1);
    S.af(S.starts[1].id, beeld());
    await totDat(async () => (await lijst()).taken[0].status === 'klaar');
    const l = await lijst();
    bronId = l.bronnen[0] && l.bronnen[0].id;
    const b = (await app(im, '/app/imagine/bron/' + bronId, 'GET', null, ctxNiet)).body;
    toets('1f titel = eigen tekst, versie-opdracht = de Engelse tekst', b.bron && b.bron.titel === 'een vuurtoren bij nacht' && /^A tall lighthouse/.test(b.versies[0].opdracht), [b.bron, b.versies && b.versies[0]]);
    const n0 = S.starts.length;
    const r2 = await app(im, '/app/imagine/nieuw', 'POST', { beurt_id: beurt(), bij: bronId, uitschrijven: true }, ctxVers());
    toets('1g Nog een daarna: meteen de beeldflow met dezelfde Engelse tekst (geen tweede uitschrijving)', r2.status === 200 && S.starts[n0] && S.starts[n0].flow === 'beeld-tekst-moss' && /^A tall lighthouse/.test(S.starts[n0].velden.opdracht), [r2.status, S.starts[n0]]);
    await afAlles(S);
  }
  // ── 2. vooraf geweigerd ──
  {
    const n0 = S.starts.length;
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een boot' }, uitschrijven: true, beurt_id: beurt() }, ctxNiet);
    toets('2a zonder verse vingerafdruk: 403 vers_nodig, niets gestart', r.status === 403 && r.body.vers_nodig === true && S.starts.length === n0, [r, S.starts.length - n0]);
    S.extraRij = 5;
    const r2 = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een boot' }, uitschrijven: true, beurt_id: beurt() }, ctxVers());
    toets('2b rij vol: 429, niets gestart', r2.status === 429 && S.starts.length === n0, [r2.status, S.starts.length - n0]);
    S.extraRij = 0;
  }
  // ── 3. uitschrijven mislukt + Opnieuw ──
  {
    const n0 = S.starts.length;
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'een boot op het meer' }, uitschrijven: true, beurt_id: beurt() }, ctxVers());
    const tid = r.body.taak && r.body.taak.id;
    S.af(S.starts[n0].id, { status: 'klaar', reden: null, duur_s: 1, tekst: '   ', beelden: [] });
    await totDat(async () => { const t = (await lijst()).taken.find((x) => x.id === tid); return t && t.status === 'mislukt'; });
    const t = (await lijst()).taken.find((x) => x.id === tid);
    toets('3a lege tekst: taak mislukt met reden, geen beeldstart', t && t.status === 'mislukt' && /uitschrijven lukte niet/.test(t.reden) && S.starts.length === n0 + 1, [t, S.starts.length - n0]);
    toets('3b kan opnieuw', t && t.kan_opnieuw === true, t);
    const ro = await app(im, '/app/imagine/opnieuw/' + tid, 'POST', { beurt_id: beurt() }, ctxVers());
    toets('3c Opnieuw schrijft opnieuw uit', ro.status === 200 && S.starts[n0 + 1] && S.starts[n0 + 1].flow === 'opdracht-uitbreiden' && S.starts[n0 + 1].velden.opdracht === 'een boot op het meer', [ro.status, ro.body, S.starts[n0 + 1]]);
    S.af(S.starts[n0 + 1].id, { status: 'mislukt', reden: 'nep', beelden: [] });
    await slaap(50);
  }
  // ── 4. Maak er 4 met meteen maken ──
  {
    const n0 = S.starts.length, c = ctxVers();
    const r = await app(im, '/app/imagine/nieuw', 'POST', { velden: { opdracht: 'vier katten' }, uitschrijven: true, aantal: 4, beurt_id: beurt() }, c);
    const st = S.starts.slice(n0);
    toets('4a vier uitschrijvingen, één vingerafdruk', r.status === 200 && st.length === 4 && st.every((x) => x.flow === 'opdracht-uitbreiden') && c.verbruikt === 1, [r.status, st.map((x) => x.flow), c.verbruikt]);
    for (const x of st) S.af(x.id, tekstUit('Four cats on a sofa, warm light.'));
    await totDat(async () => S.starts.length === n0 + 8);
    toets('4b daarna vier beeldstarts met vers', S.starts.length === n0 + 8 && S.starts.slice(n0 + 4).every((x) => x.flow === 'beeld-tekst-moss'), S.starts.slice(n0 + 4).map((x) => x.flow));
    await afAlles(S);
  }
  // ── 5. recepten ──
  {
    let l = await lijst();
    const vast = (l.recepten || []).filter((x) => !x.eigen);
    toets('5a vaste recepten: 5 foto + 3 bewegen', vast.filter((x) => x.soort === 'foto').length === 5 && vast.filter((x) => x.soort === 'bewegen').length === 3 && vast.every((x) => x.opdracht && x.naam), vast.map((x) => x.id));
    toets("5b fotorecepten op FLUX.2 klein (past in het geheugen)", vast.filter((x) => x.soort === "foto").every((x) => x.stand === "opdracht-flux"), vast.map((x) => x.stand));
    const r = await app(im, '/app/imagine/recept', 'POST', { soort: 'foto', naam: 'Mijn sneeuw', stand: 'opdracht-flux', opdracht: 'Add snow everywhere.' }, ctxNiet);
    toets('5c eigen recept bewaren: 200', r.status === 200 && /^[a-f0-9]{16}$/.test(r.body.recept), r);
    const r2 = await app(im, '/app/imagine/recept', 'POST', { soort: 'foto', naam: 'Sneeuw!', stand: 'opdracht-flux', opdracht: 'Add snow everywhere.' }, ctxNiet);
    l = await lijst();
    const eigen = l.recepten.filter((x) => x.eigen);
    toets('5d dubbel = bijwerken (één eigen recept, nieuwe naam)', r2.status === 200 && r2.body.al === true && eigen.length === 1 && eigen[0].naam === 'Sneeuw!', eigen);
    const r3 = await app(im, '/app/imagine/recept', 'POST', { soort: 'foto', naam: 'x', stand: 'opknappen', opdracht: 'y' }, ctxNiet);
    toets('5e recept bij een vaste stand: 400', r3.status === 400, r3);
    const r4 = await app(im, '/app/imagine/recept', 'POST', { soort: 'bewegen', naam: 'Springen', opdracht: 'Everyone jumps.' }, ctxNiet);
    toets('5f filmrecept bewaren: 200', r4.status === 200, r4);
    const r5 = await app(im, '/app/imagine/recept', 'POST', { soort: 'foto', naam: '', stand: 'opdracht-qwen', opdracht: 'y' }, ctxNiet);
    toets('5g zonder naam: 400', r5.status === 400, r5);
    const w1 = await app(im, '/app/imagine/recept/' + r.body.recept + '/weg', 'POST', {}, ctxNiet);
    const w2 = await app(im, '/app/imagine/recept/' + r.body.recept + '/weg', 'POST', {}, ctxNiet);
    l = await lijst();
    toets('5h weggooien: 200, daarna 404; nog één eigen', w1.status === 200 && w2.status === 404 && l.recepten.filter((x) => x.eigen).length === 1, [w1.status, w2.status]);
  }
  im.stopTimers && im.stopTimers();
  console.log((fouten ? 'ROOD' : 'GROEN') + ' imagine-recept: ' + goed + ' goed, ' + fouten + ' fout');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering ' + (e && e.stack)); process.exit(1); });
