'use strict';
// wv4109 (besluitenpagina nr 918 = L18): OVIS Imagine — levende herinneringen 's nachts (nachtStart / nachtOchtend / nachtStand).
// Tegen dezelfde nagebootste motor als imagine-keten.test.js (geen ComfyUI, geen Immich), verzonnen beelden en verzonnen Immich-nummers.
//   1. hooguit 3 oude foto's (jaar < 2000), geen dubbele of ongeldige, dezelfde dag-maand eerst; elk een NIEUW beeld + filmpje in de stapel.
//   2. dezelfde nacht nog eens = niets; volgende nacht niets zolang er een stuk op besluit wacht; bezette server = niets.
//   3. stapel loopt één voor één; geen seintje voor een nachtgroep.
//   4. ochtend: wat nog in de stapel staat stopt; mislukt = de kopie weg (Immich-origineel onaangeroerd).
//   5. Houd = Zet in Immich op het filmpje (alleen op de tik), Weg = beeld weg; besloten → volgende nacht weer; een gekozen foto nooit opnieuw.
//   6. een beeld dat David zelf al uit Immich laadde, wordt niet gebruikt (en dus nooit door Weg geraakt).
// Kruisproeven (moeten ROOD): IMAGINE_KRUIS=kseintje (nachtgroep krijgt wel een seintje), =kdavid (eigen beelden van David niet overslaan).
const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..');
const KRUIS = process.env.IMAGINE_KRUIS || '';
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const t = Date.now() + (ms || 3000); while (Date.now() < t) { if (await f()) return true; await slaap(10); } return false; }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-nacht-'));
const MOD = path.join(W, 'mod'); fs.mkdirSync(MOD);
fs.copyFileSync(path.join(ROOT, 'imagine.js'), path.join(MOD, 'imagine.js'));
function wijzig(oud, nieuw) { const p = path.join(MOD, 'imagine.js'); const s = fs.readFileSync(p, 'utf8'); if (s.indexOf(oud) < 0) throw new Error('kruisproef: tekst niet gevonden'); fs.writeFileSync(p, s.split(oud).join(nieuw)); }
if (KRUIS === 'kseintje') wijzig("    if (db.prepare('SELECT 1 FROM nacht WHERE groep = ?').get(t.stapel)) return;", '');
if (KRUIS === 'kdavid') wijzig(" && !db.prepare('SELECT 1 FROM bron WHERE immich = ?').get(k.immich)", '');
const I = require(path.join(MOD, 'imagine.js'));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);
const UUID = '0a1b2c3d-1111-4222-8333-444455556666';
function stub() {
  const live = new Map();
  const S = {
    live: live, starts: [], proef: true, weiger: 0, immichN: 0, voorStart: null,
    beeldPijp: async function (args, buf) {
      if (args[0] === 'pijp-toon') return { ok: true, formaat: buf[0] === 0xff ? 'JPEG' : 'PNG', breed: 64, hoog: 48, bytes: JPG };
      if (args[0] === 'pijp-maat') return { ok: true, bytes: PNG, breed: 64, hoog: 48 };
      return { ok: false, reden: 'onbekend' };
    },
    flowVan: async function (id) { const film = /^video-/.test(id); return { id: id, klaar: true, reden: null, tijd: '', status: film || !S.proef ? 'actief' : 'proef', vers_per_keer: !film && S.proef, velden: [] }; },
    maakGeheugen: async function (o, ctx) {
      for (const t of live.values()) if (t.beurt === o.beurt_id) return { status: 200, taak: { id: t.id }, al: true };
      if (S.voorStart) { const f = S.voorStart; S.voorStart = null; await f(o); }
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


const uu = (n) => '0a1b2c3d-1111-4222-8333-' + String(n).padStart(12, '0');
const K = (n, jaar, md) => ({ immich: uu(n), jaar: jaar, md: md || '06-15' });
const nachtRijen = (im) => im._db().prepare('SELECT * FROM nacht ORDER BY gekozen, immich').all();
const filmTaak = (im, n) => im._db().prepare('SELECT * FROM taak WHERE id = ?').get(n.taak);

(async function () {
  // ── 1–5 op één bibliotheek ──
  {
    const dir = path.join(W, 'n1'), S = stub(); S.proef = true;   // fotoflows op proef: de nacht gebruikt alleen de filmflow (actief)
    let seintjes = 0;
    const uploads = [];
    const im = nieuweImagine(dir, S, { seintje: () => { seintjes++; },
      immich: { basis: 'https://immich.nep', uploaden: async (o) => { uploads.push(o.taak); return { id: uu(900 + uploads.length), nieuw: true }; },
        fotoInfo: async () => ({ opname: '1985-06-15T12:00:00Z', eigenaar: 'ik' }), albumsVan: async () => [{ id: uu(800) }], mijnId: async () => 'ik',
        magStapelen: async () => false, inAlbum: async () => true, album: async () => null } });
    const kand = [K(1, 1985, '03-02'), K(2, 2012, '11-27'), K(3, 1996, '11-27'), { immich: 'geen-uuid', jaar: 1980, md: '01-01' }, K(1, 1985, '03-02'),
      K(4, 1998, '05-05'), K(5, 1984, '07-07'), K(6, 1970, '11-27')];
    const r = await im.nachtStart(kand, { dag: '2026-11-27', aantal: 3, md: '11-27' });
    const rij = nachtRijen(im);
    toets('1a. drie gekozen, alleen oud (2012 nooit), geen ongeldige of dubbele', r.status === 200 && r.gekozen === 3 && rij.length === 3 && rij.every((x) => x.jaar < 2000) && new Set(rij.map((x) => x.immich)).size === 3, { r, rij });
    toets('1b. dezelfde dag-maand eerst (1996 en 1970 op 27-11 zitten erbij)', [uu(3), uu(6)].every((u) => rij.some((x) => x.immich === u)), rij.map((x) => x.immich));
    const bronnen = im._db().prepare('SELECT * FROM bron').all();
    toets('1c. elk een nieuw beeld met titel Vannacht · rond <jaar>', bronnen.length === 3 && bronnen.every((b) => /^Vannacht · rond \d{4}$/.test(b.titel) && b.immich), bronnen.map((b) => b.titel));
    const st = im._db().prepare("SELECT * FROM taak WHERE stand = 'bewegen'").all();
    toets('1d. drie filmpjes in één nachtgroep (stapel of al gestart)', st.length === 3 && new Set(st.map((t) => t.stapel)).size === 1 && st[0].stapel === rij[0].groep, st.map((t) => [t.status, t.stapel]));
    toets('1e. niets naar Immich', uploads.length === 0);
    const nog = await im.nachtStart(kand, { dag: '2026-11-27', aantal: 3, md: '11-27' });
    toets('2a. dezelfde nacht nog eens = niets', nog.al === true && nachtRijen(im).length === 3, nog);
    // 3. stapel één voor één: eerste filmpje klaar, tweede klaar, derde nog in de stapel als de ochtend komt
    await im._ronde3();
    const s1 = await rondaf(S, 1, film);
    await totDat(() => im._db().prepare("SELECT 1 FROM taak WHERE stand = 'bewegen' AND status = 'klaar'").get());
    await im._ronde3();
    const s2 = await rondaf(S, 2, () => ({ status: 'mislukt', reden: 'server te vol', beelden: [] }));
    await totDat(() => im._db().prepare("SELECT COUNT(*) AS n FROM taak WHERE stand = 'bewegen' AND status IN ('klaar','mislukt')").get().n >= 2);
    toets('3a. één voor één: twee gestart, één klaar, één mislukt', s1 && s2 && S.starts.length === 2 && S.starts.every((x) => x.flow === 'video-minimax-trouw'), S.starts.map((x) => x.flow));
    const volgende = await im.nachtStart([K(20, 1990)], { dag: '2026-11-28', aantal: 3, md: '11-28' });
    toets('2b. volgende nacht niets zolang er een stuk op besluit wacht', volgende.gekozen === 0 && /besluit/.test(volgende.reden), volgende);
    // 4. ochtend
    const o = im.nachtOchtend('2026-11-27');
    toets('4a. ochtend: derde uit de stapel gehaald, mislukte kopie weg, één open', o.open === 1 && o.wacht === 0 && o.mislukt === 2 && im._db().prepare('SELECT COUNT(*) AS n FROM bron').get().n === 1, o);
    toets('3b. geen seintje voor de nachtgroep', seintjes === 0, seintjes);
    toets('4b. Immich nog steeds onaangeroerd', uploads.length === 0);
    // 5. Houd = Zet in Immich op het filmpje
    const open1 = o.stukken.find((x) => x.stand === 'open');
    const h = await app(im, '/app/imagine/v/' + open1.versie + '/immich', 'POST', {});
    const na = im.nachtStand('2026-11-27');
    toets('5a. Houd (Zet in Immich op het filmpje) → stand houd, besloten', h.status === 200 && uploads.length === 1 && na.houd === 1 && na.besloten === true, { h: h.body, na });
    const nacht1 = rij.map((x) => x.immich);   // ook de twee die mislukten of gestopt werden
    const v2 = await im.nachtStart(nacht1.map((u) => ({ immich: u, jaar: 1985, md: '11-28' })).concat([K(30, 1991, '11-28'), K(31, 1992)]), { dag: '2026-11-28', aantal: 2, md: '11-28' });
    const rij2 = nachtRijen(im).filter((x) => x.dag === '2026-11-28');
    toets('5b. besloten → volgende nacht weer; eerder gekozen foto nooit opnieuw (ook niet na mislukt/gestopt)', v2.gekozen === 2 && v2.kandidaten === 2 && rij2.every((x) => nacht1.indexOf(x.immich) < 0), { v2, rij2 });
    // Weg op een stuk van nacht 2 (eerst afronden)
    await im._ronde3(); await rondaf(S, 3, film); await totDat(() => filmTaak(im, rij2[0]).status === 'klaar');
    await im._ronde3(); await rondaf(S, 4, film); await totDat(() => filmTaak(im, rij2[1]).status === 'klaar');
    const w = await app(im, '/app/imagine/bron/' + rij2[0].bron + '/weg', 'POST', {});
    const s3 = im.nachtStand('2026-11-28');
    toets('5c. Weg = beeld weg → stand weg; nog één open = niet besloten', w.status === 200 && s3.weg === 1 && s3.open === 1 && !s3.besloten, s3);
  }
  // ── 6 + 2c. een eigen beeld van David uit Immich wordt niet gebruikt; bezette server = niets ──
  {
    const dir = path.join(W, 'n2'), S = stub();
    const im = nieuweImagine(dir, S);
    const eigen = await app(im, '/app/imagine/laad', 'POST', { immich: uu(50), titel: 'Van David' });
    const r = await im.nachtStart([K(50, 1980)], { dag: '2026-11-27', aantal: 3 });
    toets('6a. eigen beeld van David met hetzelfde Immich-nummer wordt overgeslagen', eigen.status === 200 && r.gekozen === 0 && im._db().prepare('SELECT COUNT(*) AS n FROM bron').get().n === 1, r);
    const dir2 = path.join(W, 'n3'), S2 = stub();
    const im2 = nieuweImagine(dir2, S2);
    S2.live.set('sbezig', { id: 'sbezig', o: {}, beurt: 'x' });
    const b = await im2.nachtStart([K(60, 1980)], { dag: '2026-11-27', aantal: 3 });
    toets('2c. server bezig (iets in de rij) = niets gemaakt', b.gekozen === 0 && /bezig/.test(b.reden) && !im2._db().prepare('SELECT 1 FROM bron').get(), b);
    toets('6b. info: aantallen zonder namen', !!im.info().nacht && typeof im.info().nacht.stukken === 'number', im.info().nacht);
  }
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(W, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
