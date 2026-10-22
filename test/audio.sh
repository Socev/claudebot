#!/usr/bin/env bash
# Toetst audio.js (wv743, telefoonversie van een bandje; bouwplan Bandjes § 5.3, Fable-review vooraf #14).
# Toetst: 1 kHz → 0 ± 0,5 dB; 3 kHz ≥ −1 dB; 6 kHz in → energie op 2 kHz (de spiegeling) ≤ −40 dB (22.050 en 44.100 Hz, zonder
# normalisering, ten opzichte van de invoer; en in een mengsel 1 kHz + 6 kHz met normalisering, ten opzichte van de 1 kHz);
# lengte ± 1 per 1.000; WAV-kop geldig (PCM 44 bytes, fmt 16; µ-law 58 bytes, fmt 18 + fact; geen LIST); µ-law terug-gedecodeerd binnen de
# G.711-fout; normaliseren op −3 dBFS na het filter met 0,3 s stilte; DC weg; stereo; WAV lezen met data-lengte 0 (streamend);
# geen WAV / 24-bit = nette fout; telefoonversie() in een map (origineel blijft staan, twee bestanden erbij, niet zichzelf omzetten).
# Raakt niets buiten een wegwerpmap. Gebruik: bash test/audio.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const A = require('./audio.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined ? '  [' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
function toon(rate, s, delen) {   // delen: [[hz, amplitude]]
  const n = Math.round(rate * s), m = new Float32Array(n);
  for (let k = 0; k < n; k++) for (const [hz, a] of delen) m[k] += a * Math.sin(2 * Math.PI * hz * k / rate);
  return m;
}
// amplitude van een frequentie in y (8 kHz), over het middenstuk met een Hann-venster (geen randeffecten, weinig lekken)
function amp(y, hz, rate) {
  rate = rate || 8000;
  const van = Math.floor(y.length * 0.2), tot = Math.floor(y.length * 0.8), n = tot - van;
  let re = 0, im = 0, wsom = 0;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1));
    re += w * y[van + k] * Math.cos(2 * Math.PI * hz * (van + k) / rate);
    im += w * y[van + k] * Math.sin(2 * Math.PI * hz * (van + k) / rate);
    wsom += w;
  }
  return 2 * Math.sqrt(re * re + im * im) / wsom;
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const r1 = (x) => Math.round(x * 10) / 10;

(async () => {
  const kaal = { normaliseer: false, stilteS: 0 };
  for (const rate of [22050, 44100]) {
    const r1k = await A.naarTelefoon(toon(rate, 2, [[1000, 0.5]]), rate, kaal);
    const g1 = db(amp(r1k.monsters, 1000) / 0.5);
    toets(rate + ' Hz: 1 kHz → 0 ± 0,5 dB (gemeten ' + r1(g1) + ' dB)', Math.abs(g1) <= 0.5);
    const r3k = await A.naarTelefoon(toon(rate, 2, [[3000, 0.5]]), rate, kaal);
    const g3 = db(amp(r3k.monsters, 3000) / 0.5);
    toets(rate + ' Hz: 3 kHz ≥ −1 dB (gemeten ' + r1(g3) + ' dB)', g3 >= -1 && g3 <= 0.5);
    const r6k = await A.naarTelefoon(toon(rate, 2, [[6000, 0.5]]), rate, kaal);
    const g2 = db(amp(r6k.monsters, 2000) / 0.5);
    toets(rate + ' Hz: 6 kHz in → 2 kHz-spiegeling ≤ −40 dB (gemeten ' + r1(g2) + ' dB)', g2 <= -40);
    const n = Math.round(rate * 2), verwacht = n * 8000 / rate;
    toets(rate + ' Hz: lengte ± 1/1000 (' + r1k.monsters.length + ' voor ' + verwacht + ')', Math.abs(r1k.monsters.length - verwacht) <= verwacht / 1000);
  }
  // het mengsel met normalisering: 2 kHz ten opzichte van de 1 kHz, piek op −3 dBFS, stilte 0,3 s
  {
    const t = await A.naarTelefoon(toon(22050, 2, [[1000, 0.3], [6000, 0.3]]), 22050);
    const y = t.monsters, stil = 2400;
    const midden = y.subarray(stil, y.length - stil);
    const rel = db(amp(midden, 2000) / amp(midden, 1000));
    toets('mengsel 1 + 6 kHz, genormaliseerd: 2 kHz ≤ −40 dB onder de 1 kHz (gemeten ' + r1(rel) + ' dB)', rel <= -40);
    let p = 0; for (const v of y) p = Math.max(p, Math.abs(v));
    toets('normaliseren: piek −3 dBFS (gemeten ' + r1(db(p)) + ')', Math.abs(db(p) + 3) <= 0.05);
    let voor = 0, na = 0; for (let k = 0; k < stil; k++) { voor = Math.max(voor, Math.abs(y[k])); na = Math.max(na, Math.abs(y[y.length - 1 - k])); }
    toets('0,3 s stilte voor en na', voor === 0 && na === 0 && y.length === Math.round(2 * 8000) + 2 * stil);
  }
  // DC weg
  {
    const m = toon(22050, 1, [[1000, 0.3]]); for (let k = 0; k < m.length; k++) m[k] += 0.25;
    const t = await A.naarTelefoon(m, 22050, kaal);
    let s = 0; const van = 2000, tot = t.monsters.length - 2000; for (let k = van; k < tot; k++) s += t.monsters[k];
    toets('DC weg (gemiddelde ' + (s / (tot - van)).toExponential(1) + ')', Math.abs(s / (tot - van)) < 1e-3);
  }
  // versterking hooguit +24 dB (ruis wordt geen bandje)
  {
    const t = await A.naarTelefoon(toon(22050, 1, [[1000, 0.001]]), 22050);
    toets('versterking begrensd op +24 dB (gemeten ' + t.versterking_db + ')', t.versterking_db <= 24.01);
  }
  // WAV: schrijven via telefoonversie() in een map, kop en inhoud nagaan
  const wavVan = (m, rate, kanalen) => {
    const pcm = Buffer.alloc(m.length * 2 * kanalen);
    for (let k = 0; k < m.length; k++) for (let c = 0; c < kanalen; c++) pcm.writeInt16LE(Math.round(m[k] * 32767), (k * kanalen + c) * 2);
    const h = Buffer.alloc(44); h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8, 'ascii'); h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); h.writeUInt16LE(kanalen, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2 * kanalen, 28); h.writeUInt16LE(2 * kanalen, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii'); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
  };
  const D = path.join(W, 'out'); fs.mkdirSync(D);
  const bron = wavVan(toon(22050, 3, [[440, 0.2], [1200, 0.2], [5000, 0.2]]), 22050, 1);
  fs.writeFileSync(path.join(D, 'bandje.wav'), bron);
  const r = await A.telefoonversie(D);
  toets('telefoonversie(): twee bestanden erbij', JSON.stringify(r.bestanden) === JSON.stringify(['bandje-telefoon-pcm.wav', 'bandje-telefoon-ulaw.wav']), r);
  toets('origineel onaangeroerd', fs.readFileSync(path.join(D, 'bandje.wav')).equals(bron));
  const pcmB = fs.readFileSync(path.join(D, 'bandje-telefoon-pcm.wav')), uB = fs.readFileSync(path.join(D, 'bandje-telefoon-ulaw.wav'));
  const kop = (b) => ({ riff: b.toString('ascii', 0, 4), grootte: b.readUInt32LE(4), wave: b.toString('ascii', 8, 16), fmtLen: b.readUInt32LE(16),
    formaat: b.readUInt16LE(20), kanalen: b.readUInt16LE(22), rate: b.readUInt32LE(24), bps: b.readUInt32LE(28), blok: b.readUInt16LE(32), bits: b.readUInt16LE(34),
    data: b.toString('ascii', 36, 40), dataLen: b.readUInt32LE(40), lengte: b.length, list: b.indexOf('LIST') >= 0 });
  const kp = kop(pcmB), ku = kop(uB);
  toets('PCM-kop: RIFF/WAVE, fmt 16, PCM 1, mono, 8000, 16 bit, data direct na 44 bytes, geen LIST',
    kp.riff === 'RIFF' && kp.wave === 'WAVEfmt ' && kp.fmtLen === 16 && kp.formaat === 1 && kp.kanalen === 1 && kp.rate === 8000 && kp.bps === 16000 && kp.blok === 2 &&
    kp.bits === 16 && kp.data === 'data' && kp.dataLen === kp.lengte - 44 && kp.grootte === kp.lengte - 8 && !kp.list, kp);
  // µ-law volgens de RIFF-spec (Fable wv743 #4): fmt 18 (cbSize 0) + fact (aantal monsters) + data op 50, kop 58 bytes
  Object.assign(ku, { cb: uB.readUInt16LE(36), fact: uB.toString('ascii', 38, 42), factLen: uB.readUInt32LE(42), factN: uB.readUInt32LE(46), data: uB.toString('ascii', 50, 54), dataLen: uB.readUInt32LE(54) });
  toets('µ-law-kop: formaat 7, mono, 8000, 8 bit, 8000 B/s, blok 1, fmt 18 + cbSize 0, fact = aantal monsters, 58 bytes, geen LIST',
    ku.riff === 'RIFF' && ku.wave === 'WAVEfmt ' && ku.fmtLen === 18 && ku.formaat === 7 && ku.kanalen === 1 && ku.rate === 8000 && ku.bps === 8000 && ku.blok === 1 &&
    ku.bits === 8 && ku.cb === 0 && ku.fact === 'fact' && ku.factLen === 4 && ku.factN === ku.dataLen && ku.data === 'data' && ku.dataLen === ku.lengte - 58 && ku.grootte === ku.lengte - 8 && !ku.list, ku);
  toets('PCM en µ-law even lang (monsters)', kp.dataLen / 2 === ku.dataLen, [kp.dataLen, ku.dataLen]);
  const duur = (kp.dataLen / 2) / 8000;
  toets('duur = 3 s + 2 × 0,3 s (± 1/1000; ' + duur + ' s)', Math.abs(duur - 3.6) <= 3.6 / 1000);
  // µ-law terug-gedecodeerd binnen de G.711-fout: per segment e hooguit 2^(e+2) naast de PCM-waarde (half een kwantiseerstap)
  let slechtst = 0, buiten = 0;
  for (let k = 0; k < ku.dataLen; k++) {
    const s = pcmB.readInt16LE(44 + 2 * k), u = uB[58 + k], d = A.muLawTerug(u);
    const e = ((~u & 0xff) & 0x70) >> 4, grens = Math.pow(2, e + 2) + (Math.abs(s) > 32635 ? Math.abs(s) - 32635 : 0);
    const f = Math.abs(d - s);
    if (f > grens) buiten++;
    slechtst = Math.max(slechtst, f / grens);
  }
  toets('µ-law terug binnen de G.711-fout (' + buiten + ' monsters erbuiten; slechtst ' + r1(slechtst * 100) + '% van de grens)', buiten === 0);
  // de standaardwaarden van G.711 zelf (0 → 0xFF, kleinste en grootste)
  toets('µ-law: 0 → 0xFF, −1 → 0x7F, 32767 → 0x80, −32768 → 0x00', A.muLaw(0) === 0xff && A.muLaw(-1) === 0x7f && A.muLaw(32767) === 0x80 && A.muLaw(-32768) === 0x00,
    [A.muLaw(0), A.muLaw(-1), A.muLaw(32767), A.muLaw(-32768)]);
  // tweede keer in dezelfde map: de telefoonversies zelf worden niet opnieuw omgezet
  const r2 = await A.telefoonversie(D);
  toets('niet de eigen uitvoer omzetten', r2.bestanden.length === 2 && fs.readdirSync(D).length === 3, fs.readdirSync(D));
  // stereo + data-lengte 0 (streamend geschreven) + piper-achtige 22.050
  {
    const st = wavVan(toon(22050, 1, [[1000, 0.4]]), 22050, 2); st.writeUInt32LE(0, 40);
    const w = A.leesWav(st);
    toets('stereo + data-lengte 0: gelezen als mono, hele bestand', w.kanalen === 2 && w.monsters.length === 22050 && Math.abs(amp(w.monsters, 1000, 22050) - 0.4) < 0.01, { k: w.kanalen, n: w.monsters.length });
  }
  // WAV met een LIST-blok vóór data (zoals sommige motoren schrijven)
  {
    const b = wavVan(toon(16000, 0.5, [[700, 0.3]]), 16000, 1);
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([10, 0, 0, 0]), Buffer.from('INFOabcdef')]);
    const met = Buffer.concat([b.subarray(0, 36), list, b.subarray(36)]); met.writeUInt32LE(met.length - 8, 4);
    const w = A.leesWav(met);
    toets('LIST-blok vóór data wordt overgeslagen', w.rate === 16000 && w.monsters.length === 8000);
  }
  // nette fouten
  const gooit = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  toets('geen WAV → fout', /geen WAV/.test(gooit(() => A.leesWav(Buffer.alloc(100))) || ''));
  { const b = wavVan(toon(22050, 0.1, [[1000, 0.3]]), 22050, 1); b.writeUInt16LE(24, 34);
    toets('24-bit → nette fout', /alleen PCM 16-bit/.test(gooit(() => A.leesWav(b)) || '')); }
  { const E = path.join(W, 'leeg'); fs.mkdirSync(E);
    let f = null; try { await A.telefoonversie(E); } catch (e) { f = e.message; }
    toets('lege map → fout (zacht falen is aan de aanroeper)', /geen WAV/.test(f || '')); }
  // snelheid: 100 s spraak (± 1.500 tekens) binnen een paar seconden en de lus blijft vrij
  {
    let tikken = 0; const iv = setInterval(() => tikken++, 20);
    const t0 = Date.now();
    await A.naarTelefoon(toon(22050, 100, [[300, 0.3], [2500, 0.1]]), 22050);
    clearInterval(iv);
    const ms = Date.now() - t0;
    toets('100 s geluid in ' + ms + ' ms (< 15 s) en de lus bleef draaien (' + tikken + ' tikken)', ms < 15000 && tikken >= Math.floor(ms / 400), { ms, tikken });
  }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
