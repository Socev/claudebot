'use strict';
// audio.js — telefoonversie van een bandje (wv743, 22-10-2026; bouwplan "01_Ontwikkeling/Bandjes - mini-app voor telefoonbandjes
// (bouwplan 22-10-2026).md" § 5.3). Puur JS, geen pakket en geen netwerk.
//
// WAAROM. Een telefooncentrale speelt aankondigingen op 8 kHz mono af. Een stemmotor levert 22.050 Hz (Piper) of 44.100 Hz
// (ElevenLabs pcm_44100). Zonder goed filter vouwt alles boven 4 kHz terug als fluittoon (6 kHz → 2 kHz; Fable mat −1,1 dB bij
// naïef herbemonsteren). Welk formaat KPN ÉÉN aanneemt is niet gemeten (aanname: WAV 8 kHz mono, PCM 16-bit of G.711 µ-law), dus
// beide versies.
//
// HOE. WAV lezen (PCM 16-bit, mono of stereo, elke rate; stereo wordt gemiddeld) → DC weg (gemiddelde) → windowed sinc op de
// uitvoerklok: voor elk uitvoermonster op tijd n/8000 een Kaiser-gevensterde sinc met afsnijding 3,4 kHz rond die tijd in de invoer
// (± 64 taps bij 22.050 Hz; bij een hogere rate evenredig meer, zodat het filter in Hz gelijk blijft), per monster genormaliseerd
// op een som van 1 (geen rimpel per fase). Verhoudingen als 2,756 en 5,513 zijn niet geheel, dus geen decimatie. Daarna
// normaliseren op de piek (−3 dBFS; −1 dBFS clipt in G.711; versterking hooguit +24 dB, zodat ruis nooit tot een bandje wordt
// opgeblazen), 0,3 s stilte voor en na. PCM krijgt een kale WAV-kop van 44 bytes (`fmt ` 16 bytes, geen LIST; zoals de telefoonpoort in
// server.js), µ-law de spec-kop van 58 bytes (zie wavKop). Het werk loopt in blokken met setImmediate ertussen, zodat de pod tijdens een lang bandje blijft antwoorden.
const fs = require('fs');
const path = require('path');

const UIT_RATE = 8000;
const AFSNIJ_HZ = 3400;
const TAPS_BIJ_22K = 64;
const KAISER_BETA = 9;              // ± −90 dB sperband (Kaiser); Fable mat met een gevensterde sinc −87,9 dB op 2 kHz
const OVERSAMPLE = 512;             // tabel voor de kern: 512 punten per invoermonster, lineair geïnterpoleerd
const STANDAARD = { piekDbfs: -3, maxVersterkingDb: 24, stilteS: 0.3 };
const BLOK = 8000;                  // uitvoermonsters per stap (1 s) tussen twee setImmediate's

// ── WAV ──
// Geeft { rate, kanalen, bits, formaat, monsters: Float32Array (mono, −1..1) } of gooit met een leesbare reden.
function leesWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('geen WAV (te kort)');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('geen WAV (geen RIFF/WAVE-kop)');
  let i = 12, fmt = null, data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), len = buf.readUInt32LE(i + 4);
    if (id === 'fmt ' && len >= 16 && i + 8 + 16 <= buf.length) {
      fmt = { formaat: buf.readUInt16LE(i + 8), kanalen: buf.readUInt16LE(i + 10), rate: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
      // WAVE_FORMAT_EXTENSIBLE: het echte formaat staat in de subformat-GUID (eerste twee bytes)
      if (fmt.formaat === 0xfffe && len >= 40 && i + 8 + 26 <= buf.length) fmt.formaat = buf.readUInt16LE(i + 8 + 24);
    } else if (id === 'data') {
      // Piper en sommige motoren schrijven bij streamen 0 of 0xFFFFFFFF als lengte: dan tot het eind van het bestand
      const eind = (len === 0 || len === 0xffffffff || i + 8 + len > buf.length) ? buf.length : i + 8 + len;
      data = { van: i + 8, tot: eind };
      break;
    }
    i += 8 + len + (len % 2);
  }
  if (!fmt) throw new Error('WAV zonder fmt-blok');
  if (!data) throw new Error('WAV zonder data-blok');
  if (fmt.formaat !== 1 || fmt.bits !== 16) throw new Error('alleen PCM 16-bit wordt omgezet (dit is formaat ' + fmt.formaat + ', ' + fmt.bits + ' bit)');
  if (fmt.kanalen < 1 || fmt.kanalen > 2) throw new Error('alleen mono of stereo (' + fmt.kanalen + ' kanalen)');
  if (fmt.rate < 8000 || fmt.rate > 192000) throw new Error('onverwachte bemonstering ' + fmt.rate + ' Hz');
  const stap = 2 * fmt.kanalen, n = Math.floor((data.tot - data.van) / stap);
  const m = new Float32Array(n);
  for (let k = 0, p = data.van; k < n; k++, p += stap) {
    m[k] = fmt.kanalen === 1 ? buf.readInt16LE(p) / 32768 : (buf.readInt16LE(p) + buf.readInt16LE(p + 2)) / 65536;
  }
  return { rate: fmt.rate, kanalen: fmt.kanalen, bits: fmt.bits, formaat: fmt.formaat, monsters: m };
}
// WAV-kop, mono. formaat 1 = PCM 16-bit: kaal, 44 bytes (`fmt ` 16, geen LIST; zoals de telefoonpoort). formaat 7 = G.711 µ-law
// 8-bit: volgens de RIFF-spec voor niet-PCM een `fmt ` van 18 bytes (cbSize 0) plus een `fact`-blok met het aantal monsters, 58 bytes;
// zo schrijven sox, ffmpeg en Windows hem en zo verwachten strenge lezers als BroadWorks (KPN ÉÉN) hem (Fable wv743 #4; niet gemeten).
function wavKop(formaat, rate, bits, dataBytes) {
  const blok = bits / 8, pcm = formaat === 1, fmtLen = pcm ? 16 : 18, kop = pcm ? 44 : 58;
  const h = Buffer.alloc(kop);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(kop - 8 + dataBytes, 4); h.write('WAVEfmt ', 8, 'ascii'); h.writeUInt32LE(fmtLen, 16);
  h.writeUInt16LE(formaat, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * blok, 28);
  h.writeUInt16LE(blok, 32); h.writeUInt16LE(bits, 34);
  let i = 36;
  if (!pcm) { h.writeUInt16LE(0, 36); h.write('fact', 38, 'ascii'); h.writeUInt32LE(4, 42); h.writeUInt32LE(dataBytes / blok, 46); i = 50; }
  h.write('data', i, 'ascii'); h.writeUInt32LE(dataBytes, i + 4);
  return h;
}
function naarPcm16(m) {
  const b = Buffer.alloc(m.length * 2);
  for (let k = 0; k < m.length; k++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(m[k] * 32768))), k * 2);
  return b;
}
// ── G.711 µ-law (ITU-T G.711; de gangbare 16-bit-vorm met bias 0x84 en clip 32635) ──
const MU_BIAS = 0x84, MU_CLIP = 32635;
function muLaw(s) {   // s: geheel getal −32768..32767 → byte
  let teken = 0;
  if (s < 0) { s = -s; teken = 0x80; }
  if (s > MU_CLIP) s = MU_CLIP;
  s += MU_BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return (~(teken | (exp << 4) | mant)) & 0xff;
}
function muLawTerug(u) {   // byte → geheel getal
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + MU_BIAS) << ((u & 0x70) >> 4);
  return (u & 0x80) ? MU_BIAS - t : t - MU_BIAS;
}
function naarMuLaw(m) {
  const b = Buffer.alloc(m.length);
  for (let k = 0; k < m.length; k++) b[k] = muLaw(Math.max(-32768, Math.min(32767, Math.round(m[k] * 32768))));
  return b;
}

// ── filter + herbemonsteren ──
function besselI0(x) {   // gemodificeerde Bessel-functie van de eerste soort, orde 0 (reeks; ruim genoeg voor beta ≤ 12)
  let som = 1, term = 1;
  for (let k = 1; k < 60; k++) { term *= (x / (2 * k)) * (x / (2 * k)); som += term; if (term < 1e-12 * som) break; }
  return som;
}
// Kern als tabel over d = 0 … halve breedte (in invoermonsters), symmetrisch; h(d) = sinc(2·fc/rate·d) · Kaiser(d / breedte).
function maakKern(rate) {
  const breedte = Math.max(TAPS_BIJ_22K, Math.round(TAPS_BIJ_22K * rate / 22050));
  const fc = AFSNIJ_HZ / rate;          // genormaliseerd op de invoerrate
  const n = breedte * OVERSAMPLE + 2, tabel = new Float64Array(n), i0b = besselI0(KAISER_BETA);
  for (let j = 0; j < n; j++) {
    const d = j / OVERSAMPLE;
    if (d >= breedte) { tabel[j] = 0; continue; }
    const x = 2 * fc * d;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = d / breedte;
    tabel[j] = 2 * fc * sinc * besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / i0b;
  }
  return { breedte: breedte, tabel: tabel };
}
const kernen = {};
function kern(rate) { return kernen[rate] || (kernen[rate] = maakKern(rate)); }
function nul() { return new Promise(function (r) { setImmediate(r); }); }

// Herbemonstert m (rate) naar 8 kHz met laagdoorlaat; geen normalisering. Async: blokken van 1 s met setImmediate ertussen.
async function herbemonster(m, rate) {
  const k = kern(rate), B = k.breedte, T = k.tabel;
  const verh = rate / UIT_RATE;
  const nUit = Math.round(m.length / verh);
  const uit = new Float32Array(nUit);
  for (let start = 0; start < nUit; start += BLOK) {
    const eind = Math.min(nUit, start + BLOK);
    for (let n = start; n < eind; n++) {
      const x = n * verh;                     // tijd van dit uitvoermonster in invoermonsters
      const lo = Math.max(0, Math.ceil(x - B)), hi = Math.min(m.length - 1, Math.floor(x + B));
      let som = 0, gew = 0;
      for (let j = lo; j <= hi; j++) {
        const p = Math.abs(x - j) * OVERSAMPLE, i = p | 0, f = p - i;
        const h = T[i] + (T[i + 1] - T[i]) * f;
        som += m[j] * h; gew += h;
      }
      // per monster op een som van 1 (in het midden van het signaal); aan de randen het gewone gewicht, anders tilt de
      // normalisering het afgekapte stuk kern op
      uit[n] = (hi - lo >= 2 * B - 2 && gew > 0) ? som / gew : som;
    }
    if (eind < nUit) await nul();
  }
  return uit;
}
function piek(m) { let p = 0; for (let k = 0; k < m.length; k++) { const a = Math.abs(m[k]); if (a > p) p = a; } return p; }

// Geeft Float32Array op 8 kHz: DC weg, filter + herbemonsteren, normaliseren ná het filter, stilte ervoor en erna.
// o: { piekDbfs, maxVersterkingDb, stilteS, normaliseer (standaard true) } — de toets zet normaliseer uit en stilte op 0.
async function naarTelefoon(monsters, rate, o) {
  o = Object.assign({}, STANDAARD, { normaliseer: true }, o || {});
  let gem = 0;
  for (let k = 0; k < monsters.length; k++) gem += monsters[k];
  gem = monsters.length ? gem / monsters.length : 0;
  const zonderDc = new Float32Array(monsters.length);
  for (let k = 0; k < monsters.length; k++) zonderDc[k] = monsters[k] - gem;
  const y = await herbemonster(zonderDc, rate);
  let versterking = 1;
  if (o.normaliseer) {
    const p = piek(y);
    if (p > 0) versterking = Math.min(Math.pow(10, o.piekDbfs / 20) / p, Math.pow(10, o.maxVersterkingDb / 20));
  }
  const stil = Math.round(o.stilteS * UIT_RATE);
  const uit = new Float32Array(y.length + 2 * stil);
  for (let k = 0; k < y.length; k++) uit[stil + k] = y[k] * versterking;
  return { monsters: uit, versterking_db: Math.round(200 * Math.log10(versterking)) / 10 };
}

// Maakt naast elke WAV in map `dir` (niet recursief, niet de eigen uitvoer) de twee telefoonversies:
// <naam>-telefoon-pcm.wav (PCM 16-bit 8 kHz mono) en <naam>-telefoon-ulaw.wav (G.711 µ-law 8 kHz mono).
// Geeft { bestanden: [namen] }; gooit bij een fout (de aanroeper laat het origineel staan: zacht falen, bouwplan § 5.3).
async function telefoonversie(dir, o) {
  const namen = fs.readdirSync(dir).filter(function (n) { return /\.wav$/i.test(n) && !/-telefoon-(pcm|ulaw)\.wav$/i.test(n); }).sort();
  if (!namen.length) throw new Error('geen WAV om om te zetten');
  const gemaakt = [];
  for (const n of namen) {
    const w = leesWav(fs.readFileSync(path.join(dir, n)));
    const t = await naarTelefoon(w.monsters, w.rate, o);
    const pcm = naarPcm16(t.monsters), ulaw = naarMuLaw(t.monsters);
    const basis = n.replace(/\.wav$/i, '');
    fs.writeFileSync(path.join(dir, basis + '-telefoon-pcm.wav'), Buffer.concat([wavKop(1, UIT_RATE, 16, pcm.length), pcm]), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, basis + '-telefoon-ulaw.wav'), Buffer.concat([wavKop(7, UIT_RATE, 8, ulaw.length), ulaw]), { mode: 0o600 });
    gemaakt.push(basis + '-telefoon-pcm.wav', basis + '-telefoon-ulaw.wav');
  }
  return { bestanden: gemaakt };
}

// wv803: het origineel (om te beluisteren in de app) op een gewone sterkte: piek naar −1 dBFS (versterking hooguit +24 dB, verzwakken
// mag), zelfde bemonstering, mono PCM 16-bit met een kale kop. ElevenLabs leverde 22-10 piek −11 dBFS / RMS ± −31 dBFS; in Chrome op
// Windows hoorde David "niets", het gedownloade bestand wel (met de volumeknop van zijn speler). Alleen WAV's die nog geen telefoonversie
// zijn; een bestand dat niet als PCM 16-bit te lezen is, blijft staan (gooit). Geeft [{ naam, versterking_db }].
async function normaliseer(dir, o) {
  o = Object.assign({ piekDbfs: -1, maxVersterkingDb: STANDAARD.maxVersterkingDb }, o || {});
  const namen = fs.readdirSync(dir).filter(function (n) { return /\.wav$/i.test(n) && !/-telefoon-(pcm|ulaw)\.wav$/i.test(n); }).sort();
  const uit = [];
  for (const n of namen) {
    const f = path.join(dir, n);
    const w = leesWav(fs.readFileSync(f));
    const p = piek(w.monsters);
    if (!(p > 0)) { uit.push({ naam: n, versterking_db: 0 }); continue; }
    const v = Math.min(Math.pow(10, o.piekDbfs / 20) / p, Math.pow(10, o.maxVersterkingDb / 20));
    const m = w.monsters;
    for (let k = 0; k < m.length; k++) m[k] = m[k] * v;
    await nul();
    const pcm = naarPcm16(m);
    const tmp = f + '.norm';
    try {
      fs.writeFileSync(tmp, Buffer.concat([wavKop(1, w.rate, 16, pcm.length), pcm]), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (x) {} throw e; }   // geen restbestand dat mee naar Bestanden gaat (Fable wv803 #10)
    uit.push({ naam: n, versterking_db: Math.round(200 * Math.log10(v)) / 10 });
  }
  return uit;
}

module.exports = { UIT_RATE, AFSNIJ_HZ, leesWav, wavKop, naarPcm16, naarMuLaw, muLaw, muLawTerug, herbemonster, naarTelefoon, telefoonversie, normaliseer, kern };
