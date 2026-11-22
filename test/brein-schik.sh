#!/usr/bin/env bash
# Toetst brein-schik.js en de vaste landkaart in secondbrain.js (wv3750, besluitenpagina nr 483 = 3C183): deterministisch, lijstregel (lijnen van
# een lijstpagina zijn geen veer), ankers op naam (Stamboom als eiland), start vanaf gisteren (stabiel onder de drempel: gemiddelde verschuiving
# < 3 % van R95, zwaartepunt Tolgaarde < 3 % R95), worker_thread met harde grens, kaartVoor met plek3/plek2 (alleen gewone weergave),
# schikNacht schrijft 0600 en houdt bij een fout de schikking van gisteren, server.js-stap in de nachtketen, uitrol-lijst. Verzonnen vault.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const BS = require('./brein-schik.js');
const S = require('./secondbrain.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
(async function () {
  // verzonnen kaart: 6 domeinen + stamboom-eiland, ± 900 knopen, één lijstpagina die naar 80 pagina's linkt
  const dom = ['Tolgaarde', 'Groenhouten', 'Ontwikkeling', 'Systeem', 'Privé', 'Gedeeld'];
  const paden = [], ankers = [], lijnen = [];
  for (let i = 0; i < 800; i++) { const d = dom[i % dom.length]; paden.push('map' + (i % dom.length) + '/p' + i + '.md'); ankers.push(d); }
  for (let i = 0; i < 100; i++) { paden.push('20_Prive/Familie/Stamboom/Persoon ' + i + '.md'); ankers.push(BS.ankerSleutel('20_Prive/Familie/Stamboom/Persoon ' + i + '.md', 'Privé')); }
  for (let i = 0; i < 800; i++) { const j = (i * 37 + 11) % 800; if (j % dom.length === i % dom.length) lijnen.push(i, j); if (i % 50 === 0) lijnen.push(i, (i + 1) % 800); }
  for (let i = 0; i < 99; i++) lijnen.push(800 + i, 800 + i + 1);
  lijnen.push(800, 0);   // eiland ↔ rest: zwakke veer
  paden.push('00_Systeem/Lijst.md'); ankers.push('Systeem');
  const L = paden.length - 1;
  for (let i = 0; i < 80; i++) lijnen.push(L, i * 10);
  { const na = ['Nieuw A', 'Nieuw B', 'Nieuw C', 'Nieuw D', 'Nieuw E', 'Nieuw F', 'Nieuw G', 'Nieuw H'], R = 100;
    const pl = na.map(function (x) { return BS.ankerPlek(x, 3, R).map(Math.round).join(','); });
    const vast = BS.ankerPlek('Tolgaarde', 3, R).map(Math.round).join(',');
    toets('1b onbekende domeinen: elk een eigen anker (Codex ZOU 1), niet op een bekend anker, vast per naam', new Set(pl).size === na.length && pl.indexOf(vast) < 0 && BS.ankerPlek('Nieuw A', 3, R).join() === BS.ankerPlek('Nieuw A', 3, R).join()); }
  toets('1 ankerSleutel: stamboom en herinneringen eigen anker, rest het domein', BS.ankerSleutel('20_Prive/Familie/Stamboom/X.md', 'Privé') === 'Stamboom' && BS.ankerSleutel('20_Prive/Herinneringen/Y.md', 'Privé') === 'Herinneringen' && BS.ankerSleutel('20_Prive/Z.md', 'Privé') === 'Privé');
  const lp = BS.lijstPaginas(paden.length, lijnen);
  toets('2 lijstregel: de lijstpagina (80 uit, 0 in) is een lijst, gewone pagina niet', lp[L] === 1 && lp.reduce((s, v) => s + v, 0) === 1);
  const inv = { paden, ankers, lijnen };
  const a = BS.schik(Object.assign({}, inv, { dim: 3 })), b = BS.schik(Object.assign({}, inv, { dim: 3 }));
  toets('3 deterministisch: twee keer dezelfde invoer = dezelfde plekken', a.pos.every((v, i) => v === b.pos[i]));
  toets('4 alle plekken eindig', a.pos.every(Number.isFinite));
  const zw = (pos, f) => { let s = [0, 0, 0], m = 0; paden.forEach((p, i) => { if (!f(i)) return; s[0] += pos[i * 3]; s[1] += pos[i * 3 + 1]; s[2] += pos[i * 3 + 2]; m++; }); return s.map(v => v / m); };
  const st = zw(a.pos, i => ankers[i] === 'Stamboom'), rest = zw(a.pos, i => ankers[i] !== 'Stamboom');
  const afst = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const r95 = (pos) => { const c = zw(pos, () => true); const x = paden.map((p, i) => afst([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], c)).sort((p, q) => p - q); return x[Math.floor(x.length * 0.95)]; };
  const R = r95(a.pos);
  toets('5 Stamboom ligt als eiland apart (zwaartepunt > 0,8 × R95 van de rest af)', afst(st, rest) > 0.8 * R, { afst: afst(st, rest), R });
  // vaste hoek: Tolgaarde ligt dichter bij zijn eigen anker dan bij dat van Systeem
  const ankT = BS.ankerPlek('Tolgaarde', 3, 12 * Math.cbrt(paden.length + 1)), ankS = BS.ankerPlek('Systeem', 3, 12 * Math.cbrt(paden.length + 1));
  const zt = zw(a.pos, i => ankers[i] === 'Tolgaarde');
  toets('6 Tolgaarde in zijn eigen hoek (dichter bij eigen anker dan bij Systeem)', afst(zt, ankT) < afst(zt, ankS), { zt, ankT, ankS });
  // dag 2: 1 % nieuw, 0,5 % weg, start vanaf gisteren
  const vorige = new Map(paden.map((p, i) => [p, [a.pos[i * 3], a.pos[i * 3 + 1], a.pos[i * 3 + 2]]]));
  const weg = new Set([5, 205, 405, 605]);
  const p2 = [], k2 = [], naar = new Map();
  paden.forEach((p, i) => { if (weg.has(i)) return; naar.set(i, p2.length); p2.push(p); k2.push(ankers[i]); });
  for (let q = 0; q < 9; q++) { p2.push('map0/nieuw' + q + '.md'); k2.push('Tolgaarde'); }
  const l2 = [];
  for (let j = 0; j + 1 < lijnen.length; j += 2) { const x = naar.get(lijnen[j]), y = naar.get(lijnen[j + 1]); if (x !== undefined && y !== undefined) l2.push(x, y); }
  for (let q = 0; q < 9; q++) l2.push(p2.length - 9 + q, naar.get(q * 6));
  const c = BS.schik({ paden: p2, ankers: k2, lijnen: l2, dim: 3, vorige });
  toets('7 warm gestart (≥ 80 % bekend)', c.warm === true && c.bekend === paden.length - weg.size, { warm: c.warm, bekend: c.bekend });
  let som = 0, n = 0; p2.forEach((p, i) => { const v = vorige.get(p); if (!v) return; som += Math.hypot(v[0] - c.pos[i * 3], v[1] - c.pos[i * 3 + 1], v[2] - c.pos[i * 3 + 2]); n++; });
  toets('8 stabiel: gemiddelde verschuiving < 3 % van R95', som / n < 0.03 * R, { gem: som / n, R });
  const zt2 = (() => { let s = [0, 0, 0], m = 0; p2.forEach((p, i) => { if (k2[i] !== 'Tolgaarde' || !vorige.get(p)) return; s[0] += c.pos[i * 3]; s[1] += c.pos[i * 3 + 1]; s[2] += c.pos[i * 3 + 2]; m++; }); return s.map(v => v / m); })();
  toets('9 stabiel: zwaartepunt Tolgaarde < 3 % van R95', afst(zt, zt2) < 0.03 * R, { d: afst(zt, zt2), R });
  const nieuw0 = p2.length - 9; const buur = naar.get(0);
  toets('10 nieuwe pagina ligt bij zijn buur (< 0,25 × R95)', Math.hypot(c.pos[nieuw0 * 3] - c.pos[buur * 3], c.pos[nieuw0 * 3 + 1] - c.pos[buur * 3 + 1], c.pos[nieuw0 * 3 + 2] - c.pos[buur * 3 + 2]) < 0.25 * R);
  const d2 = BS.schik(Object.assign({}, inv, { dim: 2 }));
  toets('11 2D: z overal 0 en eindig', d2.pos.every((v, i) => i % 3 !== 2 ? Number.isFinite(v) : v === 0));
  // worker_thread
  const r = await BS.schikDraad(inv, null, 60000);
  toets('12 worker_thread: d3 en d2 voor elk pad, gehele getallen', paden.every(p => Array.isArray(r.d3[p]) && r.d3[p].length === 3 && Array.isArray(r.d2[p]) && r.d2[p].length === 2 && r.d3[p].every(Number.isInteger)));
  let tijdFout = null; try { await BS.schikDraad(inv, null, 1); } catch (e) { tijdFout = e.message; }
  toets('13 worker_thread: harde grens gooit (time-out)', /langer dan/.test(tijdFout || ''), tijdFout);

  // secondbrain.js: kaartVoor met plekken, schikNacht
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'sb3750-'));
  const V = path.join(W, 'vault'), D = path.join(W, 'staat');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  zet('index.md', '# Index\n[[Plan]] [[Verzekeringen]]\n');
  zet('01_Ontwikkeling/Plan.md', '# Plan\n[[index]]\n');
  zet('10_Zakelijk/Tolgaarde/Verzekeringen.md', '# V\n[[Plan]]\n');
  zet('20_Prive/Familie/Stamboom/Iemand Verzonnen.md', '# x\n');
  zet('Bronnen/bron.md', '# verborgen\n[[index]]\n');
  const sb = S.maak({ vault: V, dir: D, fout: () => {} });
  let k = await sb.app('GET /app/secondbrain', {}, {});
  toets('14 zonder schikking: geen plekken in de kaart (app schikt zelf)', k.status === 200 && k.j.plek3 === undefined);
  const sn = await sb.schikNacht('2026-11-21');
  const bestand = path.join(D, 'schikking.json');
  toets('15 schikNacht schrijft schikking.json (0600) met dag', sn.ok && fs.existsSync(bestand) && (fs.statSync(bestand).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(bestand, 'utf8')).dag === '2026-11-21', sn);
  { const eerst = fs.readFileSync(bestand, 'utf8'); const sn2 = await sb.schikNacht('2026-11-21b'); const vg = path.join(D, 'schikking-vorige.json');
    toets('15b tweede nacht: de vorige schikking staat in schikking-vorige.json (0600)', sn2.ok && fs.existsSync(vg) && fs.readFileSync(vg, 'utf8') === eerst && (fs.statSync(vg).mode & 0o777) === 0o600);
    await sb.schikNacht('2026-11-21'); }
  k = await sb.app('GET /app/secondbrain', {}, {});
  toets('16 kaart: plek3/plek2 per knoop, dag erbij, niets mist', Array.isArray(k.j.plek3) && k.j.plek3.length === k.j.knopen.length * 3 && k.j.plek2.length === k.j.knopen.length * 2 && k.j.plek_dag === '2026-11-21' && k.j.plek_mis === 0 && k.j.plek3.every(Number.isInteger), k.j);
  const ka = await sb.app('POST /app/secondbrain/kaart', { alles: true }, {});
  toets('17 "alles": geen plekken (verborgen deel niet geschikt)', ka.status === 200 && ka.j.plek3 === undefined && ka.j.knopen.length > k.j.knopen.length);
  const voor = fs.readFileSync(bestand, 'utf8');
  zet('10_Zakelijk/Tolgaarde/Nieuw.md', '# n\n[[Verzekeringen]]\n');
  let nf = null; try { await sb.schikNacht('2026-11-22', { reken: async () => { throw new Error('proef: rekenen mislukt'); } }); } catch (e) { nf = e.message; }
  toets('18 nachtstap faalt → fout gemeld, schikking.json van gisteren onveranderd', nf === 'proef: rekenen mislukt' && fs.readFileSync(bestand, 'utf8') === voor);
  sb.vers(true);
  k = await sb.app('GET /app/secondbrain', {}, {});
  const ni = k.j.knopen.findIndex(x => x[0] === '10_Zakelijk/Tolgaarde/Nieuw.md');
  toets('19 na de mislukte nacht: plekken van gisteren, nieuwe pagina null (app legt hem bij zijn buren)', k.j.plek_dag === '2026-11-21' && ni >= 0 && k.j.plek3[ni * 3] === null && k.j.plek_mis === 1, { dag: k.j.plek_dag, mis: k.j.plek_mis });
  toets('20 health: schik.laatst met fout, dag van gisteren', sb.health().schik && sb.health().schik.laatst.ok === false && sb.health().schik.dag === '2026-11-21');
  fs.writeFileSync(bestand, '{kapot');
  k = await sb.app('GET /app/secondbrain', {}, {});
  toets('21 onleesbare schikking → geen plekken, kaart werkt', k.status === 200 && k.j.plek3 === undefined);
  // server.js en uitrol
  const srv = fs.readFileSync('server.js', 'utf8'), ui = fs.readFileSync('uitrol.sh', 'utf8');
  toets('22 server.js: nachtstap secondbrain-schik ná secondbrain-kaart, inProces', /naam: 'secondbrain-schik', start_na: \[3, 52\], na: \['secondbrain-kaart'\], limiet_min: 5, pogingen: 2, inProces: true/.test(srv) && srv.indexOf("naam: 'secondbrain-schik'") > srv.indexOf("naam: 'secondbrain-kaart'"));
  toets('23 uitrol.sh: brein-schik.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bbrein-schik\.js\b/.test(ui));
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(e => { console.log('ROOD  uitzondering ' + (e && e.stack || e)); process.exit(1); });
JS
