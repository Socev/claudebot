'use strict';
// wv3750 (besluitenpagina nr 483 = 3C183, David Ja 21-11-2026; Fable-review brein-graaf idee 8): de vaste landkaart van de Second Brain.
// De schikking van de kaart (welk bolletje waar ligt) rekent de pod 's nachts uit, in plaats van de app bij elke opening. Drie regels:
//  1. elk domein een vaste plek (anker op NAAM, niet op volgorde: een nieuw domein schuift de rest niet op); de Stamboom als eigen eiland
//     verder weg, zijn lijnen naar buiten zijn zwakke veren;
//  2. start vanaf gisteren: wie gisteren een plek had begint daar (plus een zwak elastiekje terug), nieuwe pagina's bij hun buren;
//  3. dezelfde lijstregel als de app (wv3749, socev-app breinNamen.lijstPaginas): ≥ 60 uitgaande lijnen en inkomend ≤ een tiende = lijstpagina,
//     zijn lijnen zijn geen veer (anders trekken de woordenlijsten alles naar het midden).
// Eigen krachtschikking (Barnes-Hut voor de afstoting, veren, ankers) met alleen de standaardbibliotheek, deterministisch (geen Math.random):
// dezelfde invoer = dezelfde kaart. Parameters zoals de worker van de app (breinSchik.worker.ts) waar het kan, zodat de terugval er
// ongeveer hetzelfde uitziet. Alleen paden en getallen, geen inhoud.
// Gebruik: schikDraad(invoer, ms) draait schik() in een worker_thread met harde grens (server.js blijft vrij); schrijf() bewaart atomisch.
const fs = require('fs');
const path = require('path');

const LIJST_MIN_UIT = 60, LIJST_IN_DEEL = 0.1;   // = socev-app breinNamen.ts (wv3749)
// De privésplitsing van de app (socev-app brein.ts PRIVE_DELEN): Stamboom en Herinneringen een eigen anker
const PRIVE_DELEN = [['Stamboom', '20_Prive/Familie/Stamboom/'], ['Herinneringen', '20_Prive/Herinneringen/']];
// Vaste volgorde van de ankers (nooit herschikken: een nieuw domein komt achteraan, dan blijft de rest op zijn plek)
const ANKER_VOLGORDE = ['Tolgaarde', 'Groenhouten', 'HAGRO', 'POT', 'DBH', 'Holding', 'Praktijkhouders', 'Projecten', 'Gedeeld', 'Zakelijk overig',
  'Privé', 'Herinneringen', 'Ontwikkeling', 'Systeem', 'Gesprekken', 'Cijfer-Meester', 'Vault', 'Overig'];
const EILAND = 'Stamboom';
const P = { lading: -26, theta: 0.95, afstandMax: 400, veerLengte: 26, veerKracht: 0.35, veerEiland: 0.03, anker: 0.05, elastiek: 0.03,
  afkoel: 0.028, demping: 0.35, maxStap: 320, warm: 0.3, straal: 1.0, eilandVer: 2.2 };

function ankerSleutel(p, d) {
  for (const [naam, map] of PRIVE_DELEN) if (p.startsWith(map)) return naam;
  return d || 'Overig';
}

function lijstPaginas(n, lijnen) {
  const uit = new Int32Array(n), inn = new Int32Array(n);
  for (let j = 0; j + 1 < lijnen.length; j += 2) {
    const a = lijnen[j], b = lijnen[j + 1];
    if (a < 0 || b < 0 || a >= n || b >= n || a === b) continue;
    uit[a]++; inn[b]++;
  }
  const lijst = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (uit[i] >= LIJST_MIN_UIT && inn[i] <= uit[i] * LIJST_IN_DEEL) lijst[i] = 1;
  return lijst;
}

// Ankerplek per naam: Fibonacci-bol (3D) of cirkel (2D) met een vast aantal plaatsen, zodat een domein erbij de rest niet verschuift.
const PLAATSEN = 24;
function ankerPlek(naam, dim, straal) {
  if (naam === EILAND) return dim === 3 ? [straal * P.eilandVer, 0, 0] : [straal * P.eilandVer, 0, 0];
  const i = ANKER_VOLGORDE.indexOf(naam);
  if (i < 0) {
    // onbekend domein (Codex ZOU 1): richting uit een hash van de naam over de hele ruimte (niet over de 6 vrije plaatsen), zodat twee
    // nieuwe domeinen niet op hetzelfde anker vallen; vast per naam, dus ook morgen dezelfde plek. Altijd aan de kant weg van het eiland.
    let h1 = 2166136261, h2 = 5381;
    for (let c = 0; c < naam.length; c++) { h1 = Math.imul(h1 ^ naam.charCodeAt(c), 16777619) >>> 0; h2 = ((h2 * 33) ^ naam.charCodeAt(c)) >>> 0; }
    const u = h1 / 4294967296, v = h2 / 4294967296;
    if (dim === 2) { const hoek = Math.PI / 2 + Math.PI * u; return [straal * Math.cos(hoek), straal * Math.sin(hoek) * 1.6, 0]; }
    const y = 1 - 2 * u, r = Math.sqrt(1 - y * y), phi = 2 * Math.PI * v;
    return [straal * (-Math.abs(r * Math.cos(phi)) * 0.7 - 0.15), straal * y, straal * r * Math.sin(phi)];
  }
  if (dim === 2) {
    // halve cirkel aan de andere kant van het eiland (het eiland ligt rechts), van boven naar beneden
    const hoek = Math.PI / 2 + Math.PI * (i + 0.5) / PLAATSEN;
    return [straal * Math.cos(hoek) * 1.0, straal * Math.sin(hoek) * 1.6, 0];
  }
  // Fibonacci-bol, alleen de helft weg van het eiland (x < 0,3·straal), zodat het eiland vrij ligt
  const t = (i + 0.5) / PLAATSEN, y = 1 - 2 * t, r = Math.sqrt(1 - y * y), phi = Math.PI * (3 - Math.sqrt(5)) * i;
  let x = r * Math.cos(phi), z = r * Math.sin(phi);
  x = -Math.abs(x) * 0.7 - 0.15;
  return [straal * x, straal * y, straal * z];
}

// Barnes-Hut: boom van 2^dim kinderen; per cel het zwaartepunt en het gewicht (aantal knopen).
function bouwBoom(x, y, z, n, dim) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i];
    if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i];
    if (dim === 3) { if (z[i] < z0) z0 = z[i]; if (z[i] > z1) z1 = z[i]; }
  }
  if (dim === 2) { z0 = 0; z1 = 0; }
  const w = Math.max(x1 - x0, y1 - y0, z1 - z0, 1) * 1.0001;
  const K = 1 << dim;
  // platte opslag: per cel kinderen (K), massa, zwaartepunt, breedte, punt (-1 = leeg, -2 = binnenknoop)
  let cap = Math.max(64, n * 4);
  let kind = new Int32Array(cap * K).fill(-1), massa = new Float64Array(cap), mx = new Float64Array(cap), my = new Float64Array(cap), mz = new Float64Array(cap);
  let cx = new Float64Array(cap), cy = new Float64Array(cap), cz = new Float64Array(cap), br = new Float64Array(cap), punt = new Int32Array(cap).fill(-1);
  let volgende = 0;
  const groei = function () {
    const c2 = cap * 2;
    const k2 = new Int32Array(c2 * K).fill(-1); k2.set(kind); kind = k2;
    const f = function (a) { const b = new Float64Array(c2); b.set(a); return b; };
    massa = f(massa); mx = f(mx); my = f(my); mz = f(mz); cx = f(cx); cy = f(cy); cz = f(cz); br = f(br);
    const p2 = new Int32Array(c2).fill(-1); p2.set(punt); punt = p2;
    cap = c2;
  };
  const nieuw = function (mx0, my0, mz0, b) {
    if (volgende >= cap) groei();
    const c = volgende++;
    cx[c] = mx0; cy[c] = my0; cz[c] = mz0; br[c] = b; punt[c] = -1; massa[c] = 0;
    return c;
  };
  const wortel = nieuw(x0 + w / 2, y0 + w / 2, dim === 3 ? z0 + w / 2 : 0, w);
  const deel = function (c, i) {
    let o = (x[i] >= cx[c] ? 1 : 0) | (y[i] >= cy[c] ? 2 : 0);
    if (dim === 3 && z[i] >= cz[c]) o |= 4;
    return o;
  };
  const kindVan = function (c, o) {
    let k = kind[c * K + o];
    if (k < 0) {
      const h = br[c] / 4;
      k = nieuw(cx[c] + (o & 1 ? h : -h), cy[c] + (o & 2 ? h : -h), dim === 3 ? cz[c] + (o & 4 ? h : -h) : 0, br[c] / 2);
      kind[c * K + o] = k;
    }
    return k;
  };
  for (let i = 0; i < n; i++) {
    let c = wortel, diep = 0;
    for (;;) {
      massa[c]++; mx[c] += x[i]; my[c] += y[i]; mz[c] += z[i];
      if (punt[c] === -1 && massa[c] === 1) { punt[c] = i; break; }
      if (punt[c] >= 0) {   // blad met één punt: splitsen
        const j = punt[c]; punt[c] = -2;
        if (diep > 40) { punt[c] = j; break; }   // samenvallende punten: blijven samen in dit blad
        const kj = kindVan(c, deel(c, j));
        massa[kj]++; mx[kj] += x[j]; my[kj] += y[j]; mz[kj] += z[j]; punt[kj] = j;
      }
      c = kindVan(c, deel(c, i)); diep++;
    }
  }
  return { kind: kind, massa: massa, mx: mx, my: my, mz: mz, br: br, punt: punt, wortel: wortel, K: K };
}

function lading(x, y, z, vx, vy, vz, n, dim, alfa) {
  const b = bouwBoom(x, y, z, n, dim);
  const th2 = P.theta * P.theta, dmax2 = P.afstandMax * P.afstandMax, kracht = P.lading * alfa;
  const stapel = new Int32Array(4096);
  for (let i = 0; i < n; i++) {
    let sp = 0; stapel[sp++] = b.wortel;
    let ax = 0, ay = 0, az = 0;
    while (sp) {
      const c = stapel[--sp];
      const m = b.massa[c]; if (!m) continue;
      const gx = b.mx[c] / m, gy = b.my[c] / m, gz = b.mz[c] / m;
      let dx = gx - x[i], dy = gy - y[i], dz = dim === 3 ? gz - z[i] : 0;
      let l = dx * dx + dy * dy + dz * dz;
      const w = b.br[c];
      if (b.punt[c] !== -2 || (w * w) / th2 < l) {   // blad of ver genoeg: als één geheel
        if (b.punt[c] === i && m === 1) continue;
        if (l >= dmax2) continue;
        let mm = m;
        if (b.punt[c] >= 0 && b.punt[c] !== -2) {
          // blad: zichzelf niet meetellen; samenvallend = vaste kleine duw (deterministisch)
          if (b.punt[c] === i) { mm = m - 1; if (!mm) continue; }
          if (l === 0) { dx = ((i * 7919) % 13 - 6) * 1e-3 || 1e-3; dy = ((i * 104729) % 11 - 5) * 1e-3 || 1e-3; l = dx * dx + dy * dy; }
        }
        if (l < 1) l = Math.sqrt(l);   // = d3 distanceMin2 1
        const f = kracht * mm / l;
        ax += dx * f; ay += dy * f; az += dz * f;
        continue;
      }
      for (let o = 0; o < b.K; o++) { const k = b.kind[c * b.K + o]; if (k >= 0) { if (sp >= stapel.length - 1) break; stapel[sp++] = k; } }
    }
    vx[i] += ax; vy[i] += ay; if (dim === 3) vz[i] += az;
  }
}

// schik({ paden, ankers, lijnen, dim, vorige }) → Float32Array(n*3). vorige: Map pad → [x, y, z].
function schik(inv) {
  const n = inv.paden.length, dim = inv.dim === 2 ? 2 : 3;
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const vx = new Float64Array(n), vy = new Float64Array(n), vz = new Float64Array(n);
  const straal = 12 * Math.cbrt(n + 1) * P.straal * (dim === 2 ? 1.3 : 1);
  const ankers = inv.ankers.map(function (a) { return ankerPlek(a, dim, straal); });
  const lijst = lijstPaginas(n, inv.lijnen);
  // veren: zonder lijstpagina's; een lijn tussen het eiland en de rest is een zwakke veer
  const bron = [], doel = [], kracht = [];
  const tel = new Int32Array(n);
  for (let j = 0; j + 1 < inv.lijnen.length; j += 2) {
    const a = inv.lijnen[j], b = inv.lijnen[j + 1];
    if (a < 0 || b < 0 || a >= n || b >= n || a === b || lijst[a] || lijst[b]) continue;
    bron.push(a); doel.push(b); tel[a]++; tel[b]++;
    kracht.push((inv.ankers[a] === EILAND) !== (inv.ankers[b] === EILAND) ? P.veerEiland : P.veerKracht);
  }
  // beginplek: gisteren, anders bij de buren met een plek van gisteren, anders bij het anker (vast patroon)
  const vorige = inv.vorige || new Map();
  const heeft = new Uint8Array(n);
  let bekend = 0;
  for (let i = 0; i < n; i++) {
    const v = vorige.get(inv.paden[i]);
    if (v && v.length >= 2 && v.every(function (g) { return typeof g === 'number' && isFinite(g); })) {
      x[i] = v[0]; y[i] = v[1]; z[i] = dim === 3 ? (v[2] || 0) : 0; heeft[i] = 1; bekend++;
    }
  }
  const buren = new Array(n);
  for (let j = 0; j < bron.length; j++) { (buren[bron[j]] = buren[bron[j]] || []).push(doel[j]); (buren[doel[j]] = buren[doel[j]] || []).push(bron[j]); }
  for (let i = 0; i < n; i++) {
    if (heeft[i]) continue;
    const a = ankers[i];
    const t = i / Math.max(1, n - 1), phi = Math.acos(1 - 2 * t), theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = 20 + 30 * ((i * 7919) % 1000) / 1000;
    let bx = a[0], by = a[1], bz = a[2], m = 0;
    if (buren[i]) {
      let sx = 0, sy = 0, sz = 0;
      for (const j of buren[i]) if (heeft[j]) { sx += x[j]; sy += y[j]; sz += z[j]; m++; }
      if (m) { bx = sx / m; by = sy / m; bz = sz / m; }
    }
    const rr = m ? r / 3 : r;
    x[i] = bx + rr * Math.sin(phi) * Math.cos(theta); y[i] = by + rr * Math.sin(phi) * Math.sin(theta); z[i] = dim === 3 ? bz + rr * Math.cos(phi) : 0;
  }
  const warm = bekend >= n * 0.8;
  let alfa = warm ? P.warm : 1;
  const vast = new Float64Array(n * 3);   // plek van gisteren (elastiek)
  for (let i = 0; i < n; i++) { vast[i * 3] = x[i]; vast[i * 3 + 1] = y[i]; vast[i * 3 + 2] = z[i]; }
  let stap = 0;
  const bias = bron.map(function (a, j) { return tel[a] / (tel[a] + tel[doel[j]]); });
  while (stap < P.maxStap && alfa > 0.004) {
    alfa += (0 - alfa) * P.afkoel;
    lading(x, y, z, vx, vy, vz, n, dim, alfa);
    for (let j = 0; j < bron.length; j++) {
      const s = bron[j], t = doel[j];
      let dx = x[t] + vx[t] - x[s] - vx[s], dy = y[t] + vy[t] - y[s] - vy[s], dz = dim === 3 ? z[t] + vz[t] - z[s] - vz[s] : 0;
      let l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
      l = (l - P.veerLengte) / l * alfa * kracht[j];
      dx *= l; dy *= l; dz *= l;
      const bb = bias[j];
      vx[t] -= dx * bb; vy[t] -= dy * bb; vz[t] -= dz * bb;
      vx[s] += dx * (1 - bb); vy[s] += dy * (1 - bb); vz[s] += dz * (1 - bb);
    }
    for (let i = 0; i < n; i++) {
      const a = ankers[i];
      vx[i] += (a[0] - x[i]) * P.anker * alfa; vy[i] += (a[1] - y[i]) * P.anker * alfa;
      if (dim === 3) vz[i] += (a[2] - z[i]) * P.anker * alfa;
      if (warm && heeft[i]) {
        vx[i] += (vast[i * 3] - x[i]) * P.elastiek; vy[i] += (vast[i * 3 + 1] - y[i]) * P.elastiek;
        if (dim === 3) vz[i] += (vast[i * 3 + 2] - z[i]) * P.elastiek;
      }
    }
    const d = 1 - P.demping;
    for (let i = 0; i < n; i++) { x[i] += (vx[i] *= d); y[i] += (vy[i] *= d); if (dim === 3) z[i] += (vz[i] *= d); else z[i] = 0; }
    stap++;
  }
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = x[i]; pos[i * 3 + 1] = y[i]; pos[i * 3 + 2] = z[i]; }
  return { pos: pos, stappen: stap, warm: warm, bekend: bekend, lijsten: lijst.reduce(function (s, v) { return s + v; }, 0) };
}

// De invoer voor de nacht uit de kaart (zelfde knopen en lijnen als kaartVoor(…, false) aan de app geeft)
function invoerUitKaart(knopen, lijnen) {
  return { paden: knopen.map(function (k) { return k.p; }), ankers: knopen.map(function (k) { return ankerSleutel(k.p, k.d); }), lijnen: lijnen };
}

// Beide schikkingen (3D en 2D) in een worker_thread met harde grens. Geeft { d3: Map, d2: Map, ms, stappen } of gooit (time-out/fout).
function schikDraad(inv, vorig, ms) {
  const { Worker } = require('worker_threads');
  return new Promise(function (klaar, faal) {
    const w = new Worker(__filename, { workerData: { inv: inv, vorig: vorig || null } });
    let af = false;
    const t = setTimeout(function () { if (af) return; af = true; w.terminate(); faal(new Error('schikking duurde langer dan ' + Math.round(ms / 1000) + ' s')); }, ms);
    w.once('message', function (m) { if (af) return; af = true; clearTimeout(t); w.terminate(); if (m && m.ok) klaar(m); else faal(new Error(m && m.fout || 'schikking mislukt')); });
    w.once('error', function (e) { if (af) return; af = true; clearTimeout(t); faal(e); });
    w.once('exit', function (c) { if (af) return; af = true; clearTimeout(t); faal(new Error('schikking stopte (code ' + c + ')')); });
  });
}

// vorig: { d3: {pad: [x,y,z]}, d2: {pad: [x,y]} } (uit schikking.json) → per dim een Map
function rekenBeide(inv, vorig) {
  const t0 = Date.now();
  const uit = { ok: true, d3: {}, d2: {} };
  for (const dim of [3, 2]) {
    const sl = dim === 3 ? 'd3' : 'd2';
    const m = new Map(vorig && vorig[sl] ? Object.entries(vorig[sl]) : []);
    const r = schik(Object.assign({}, inv, { dim: dim, vorige: m }));
    const o = {};
    inv.paden.forEach(function (p, i) { o[p] = dim === 3 ? [Math.round(r.pos[i * 3]), Math.round(r.pos[i * 3 + 1]), Math.round(r.pos[i * 3 + 2])] : [Math.round(r.pos[i * 3]), Math.round(r.pos[i * 3 + 1])]; });
    uit[sl] = o;
    uit['stappen' + dim] = r.stappen; uit['warm' + dim] = r.warm; uit.lijsten = r.lijsten;
  }
  uit.ms = Date.now() - t0;
  return uit;
}

if (!require('worker_threads').isMainThread && require('worker_threads').workerData && require('worker_threads').workerData.inv) {
  const wd = require('worker_threads').workerData;
  try { require('worker_threads').parentPort.postMessage(rekenBeide(wd.inv, wd.vorig)); }
  catch (e) { require('worker_threads').parentPort.postMessage({ ok: false, fout: String(e && e.message || e).slice(0, 160) }); }
}

const VERSIE = 1;
function lees(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'schikking.json'), 'utf8'));
    if (!j || j.versie !== VERSIE || !j.d3 || !j.d2 || typeof j.d3 !== 'object' || typeof j.d2 !== 'object') return null;
    return j;
  } catch (e) { return null; }
}
function schrijf(dir, j) {
  const doel = path.join(dir, 'schikking.json'), tmp = doel + '.tmp' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 });
  // de vorige nacht bewaren (meetbaar: ligt Tolgaarde twee nachten op dezelfde plek?); niet kunnen kopiëren houdt de nieuwe niet tegen
  try { const vorig = path.join(dir, 'schikking-vorige.json'); fs.copyFileSync(doel, vorig); fs.chmodSync(vorig, 0o600); } catch (e) { /* eerste nacht */ }
  fs.renameSync(tmp, doel);
}

module.exports = { schik: schik, schikDraad: schikDraad, rekenBeide: rekenBeide, invoerUitKaart: invoerUitKaart, ankerSleutel: ankerSleutel,
  ankerPlek: ankerPlek, lijstPaginas: lijstPaginas, lees: lees, schrijf: schrijf, VERSIE: VERSIE, P: P };
