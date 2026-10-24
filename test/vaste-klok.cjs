// Vaste klok voor toetsen (wv1044): met TOETS_NU=<ISO-tijd> start dit Node-proces op dat moment en tikt daarna gewoon door
// (Date.now(), new Date() en alles wat daarop leunt). Zonder TOETS_NU of TOETS_KLOK_DELTA doet het niets. Laden met:
// node --require ./test/vaste-klok.cjs … Het eerste proces zet de verschuiving in TOETS_KLOK_DELTA; een kindproces dat die meekrijgt,
// loopt op dezelfde klok (niet opnieuw vanaf TOETS_NU). Zo draait een toets die zelf de klok leest, met de processen die hij start, op
// een vast moment, bijvoorbeeld 00:30 Nederlandse tijd terwijl de UTC-datum nog op gisteren staat: daar faalden de bankluis-toetsen in
// CI tussen 22:00 en 24:00 UTC (runs 241 en 242).
'use strict';
const Echt = Date;
let delta = Number(process.env.TOETS_KLOK_DELTA);
if (!process.env.TOETS_KLOK_DELTA || !Number.isFinite(delta)) {
  const doel = Echt.parse(process.env.TOETS_NU || '');
  delta = isNaN(doel) ? null : doel - Echt.now();
  if (delta !== null) process.env.TOETS_KLOK_DELTA = String(delta);
}
if (delta !== null) {
  class Klok extends Echt {
    constructor(...a) { if (a.length === 0) super(Echt.now() + delta); else super(...a); }
    static now() { return Echt.now() + delta; }
  }
  globalThis.Date = new Proxy(Klok, { apply: () => new Klok().toString() });   // Date() als functie geeft ook de verschoven tijd
}
