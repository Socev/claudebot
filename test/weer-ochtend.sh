#!/usr/bin/env bash
# wv2389 (idee 28 meetpunt 3): weerregel in het ochtendbericht. Verzonnen One Call-antwoorden (geen echte plekken, geen echte sleutel).
# Gevallen uit het ontwerp § 10: zeven soorten, droge dag, al weg om 06:40, API-fout dag 1 stil / dag 2 één box-rij, rem 50,
# lat/lon op 1 decimaal en beide vakken ook op een vrije dag, sleutel en appid= nooit in log, buffer, staat of uitkomst.
set -euo pipefail
cd "$(dirname "$0")/.."
node - <<'JS'
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const W = require('./weer-ochtend.js');
let goed = 0, fouten = 0;
function toets(naam, ok, info) { if (ok) { goed++; console.log('GROEN ' + naam); } else { fouten++; console.log('ROOD  ' + naam + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'weer-'));
const SLEUTEL = 'nepsleutel0123456789abcdef';
const DATUM = '2026-11-11';                      // woensdag, wintertijd (UTC+1)
const UUR0 = Date.parse('2026-11-10T23:00:00Z') / 1000;   // 00:00 NL
// 48 uur droog en mild; f(uurNL, u) past een uur aan
function onecall(f, extra) {
  const hourly = [];
  for (let i = 0; i < 48; i++) { const u = { dt: UUR0 + i * 3600, temp: 8, feels_like: 6, wind_gust: 6, pop: 0.1, weather: [{ id: 803 }] }; if (f) f(i, u); hourly.push(u); }
  return Object.assign({ lat: 0, lon: 0, timezone: 'Europe/Amsterdam', hourly: hourly, daily: [{ dt: UUR0 + 12 * 3600, temp: { min: 4, max: 12 } }] }, extra || {});
}
const PLEKKEN = [{ naam: 'Huisartsenpraktijk Tolgaarde', klasse: 'werk', lat: 52.04, lon: 5.62 }, { naam: 'Huisartsenpraktijk Groenhouten', klasse: 'werk', lat: 52.06, lon: 5.58 }, { naam: 'Thuis', klasse: 'thuis', lat: 51.87, lon: 5.31 },
  { naam: 'Nepsportclub', klasse: 'overig', lat: 53.2, lon: 6.6 }];   // wv2592: een andere opgeslagen plek telt niet mee voor de 15 km
const DIENST = [{ soort: 'dienst', titel: 'DS', feed: 'rooster-tg-artsen', begin_datum: DATUM, eind_datum: DATUM, hele_dag: true }];
function proef(o) {
  o = o || {};
  const st = { aanroepen: [], buffer: [], box: [], log: [] };
  const staatPad = o.staatPad || path.join(d, 'staat-' + Math.random().toString(36).slice(2) + '.json');
  const w = W.maak({ staatPad: staatPad,
    sleutel: async () => (o.sleutel === undefined ? SLEUTEL : o.sleutel),
    plekken: async () => PLEKKEN,
    locatie: async () => (o.locatie || { plek: 'Thuis', leeftijd_s: 120 }),
    kalender: async () => (o.kalender || []),
    werkRecent: o.werkRecent === undefined ? undefined : async () => o.werkRecent,
    afspraken: o.afspraken === undefined ? undefined : async () => { if (o.afspraken === 'fout') throw new Error('agenda-luik http 500'); return o.afspraken; },
    ophalen: async (url) => {
      st.aanroepen.push(url);
      const q = new URL(url).searchParams;
      if (o.ophalen) return o.ophalen(url, q, st.aanroepen.length);
      if (url.indexOf('/geo/1.0/direct') >= 0) return { status: 200, json: o.geo ? o.geo(q.get('q')) : [] };
      const lat = q.get('lat');
      if (lat !== '51.9' && lat !== '52.0' && lat !== '52.1') return { status: 200, json: (o.ver && o.ver(lat)) || onecall() };
      const thuis = lat === '51.9';
      return { status: 200, json: thuis ? (o.thuis || onecall()) : (o.praktijk || onecall()) };
    },
    bufferZet: async (datum, tekst) => { st.buffer.push({ datum, tekst }); },
    boxRij: (t) => { st.box.push(t); return true; },
    log: (x) => st.log.push(JSON.stringify(x)),
    nu: () => Date.parse(DATUM + 'T05:40:00Z') });
  st.w = w; st.staatPad = staatPad;
  st.doe = (a) => w.doe({ ams: Object.assign({ datum: DATUM, uur: 6, min: 40 }, a || {}) });
  return st;
}
const regenUur = (h) => (i, u) => { if (i === h) { u.pop = 0.8; u.rain = { '1h': 1.2 }; u.weather = [{ id: 501 }]; } };
(async function () {
  // 1. droge dag: geen rij, wel beide vakken (vrije dag), lat/lon op 1 decimaal
  {
    const x = proef();
    const r = await x.doe();
    toets('1 droge vrije dag: ok, geen treffers, geen buffer-rij, geen box', r.ok && x.buffer.length === 0 && x.box.length === 0 && r.detail.treffers.length === 0, r);
    const q = x.aanroepen.map((u) => new URL(u).searchParams);
    toets('1 vrije dag: beide vakken gevraagd (Thuis + praktijk)', x.aanroepen.length === 2 && q[0].get('lat') === '51.9' && q[0].get('lon') === '5.3' && q[1].get('lat') === '52.0' && q[1].get('lon') === '5.6', x.aanroepen.length);
    toets('1 lat/lon met precies 1 decimaal in elke aanroep', q.every((p) => /^\d+\.\d$/.test(p.get('lat')) && /^\d+\.\d$/.test(p.get('lon'))));
    toets('1 One Call 3.0, metric, nl, zonder minutely', x.aanroepen.every((u) => u.startsWith('https://api.openweathermap.org/data/3.0/onecall?') && /units=metric/.test(u) && /lang=nl/.test(u) && /exclude=minutely/.test(u)));
    const r2 = await x.doe();
    toets('1 tweede keer dezelfde dag: al_gedaan, geen aanroep', r2.al_gedaan === true && x.aanroepen.length === 2);
  }
  // 2. regen bij vertrek (werkdag, thuis om 06:40): 07:00–09:00 → uur 7
  {
    const x = proef({ kalender: DIENST, thuis: onecall(regenUur(7)) });
    const r = await x.doe();
    toets('2 regen bij vertrek: één rij met "regen als je vertrekt" en tijd 7:00', x.buffer.length === 1 && x.buffer[0].datum === DATUM && /^Weer: Rond 7:00 regen als je vertrekt \(± 1 mm\)\.$/.test(x.buffer[0].tekst), x.buffer);
    toets('2 werkdag via de dienstcode, praktijk Tolgaarde', r.detail.werkdag === true && r.detail.praktijk === 'Tolgaarde', r.detail);
  }
  // 3. al weg om 06:40: geen vertrekdeel (ook niet als de locatie te oud is)
  {
    const x = proef({ kalender: DIENST, thuis: onecall(regenUur(7)), locatie: { plek: 'Huisartsenpraktijk Tolgaarde', leeftijd_s: 60 } });
    await x.doe();
    const y = proef({ kalender: DIENST, thuis: onecall(regenUur(7)), locatie: { plek: 'Thuis', leeftijd_s: 3600 } });
    await y.doe();
    toets('3 al weg om 06:40 of locatie > 30 min: geen vertrekregen, geen rij', x.buffer.length === 0 && y.buffer.length === 0, [x.buffer, y.buffer]);
  }
  // 3b. vrije dag: geen vertrekregen, ook al is hij thuis
  {
    const x = proef({ thuis: onecall(regenUur(7)) });
    await x.doe();
    toets('3b vrije dag: geen vertrekregen', x.buffer.length === 0, x.buffer);
  }
  // 3c. vertrekvenster tot de eerste afspraak (08:00 NL); een afspraak om 07:00 = al onderweg (diffreview MOET 1)
  {
    const om = (h) => DIENST.concat([{ soort: 'afspraak', sync_agenda: 'david', begin_tijd: DATUM + 'T' + String(h - 1).padStart(2, '0') + ':00:00+00:00', eind_tijd: DATUM + 'T' + String(h).padStart(2, '0') + ':00:00+00:00' }]);
    const x = proef({ kalender: om(8), thuis: onecall(regenUur(8)) }); await x.doe();
    const y = proef({ kalender: om(8), thuis: onecall(regenUur(7)) }); await y.doe();
    const z = proef({ kalender: om(7), thuis: onecall(regenUur(7)) }); await z.doe();
    toets('3c afspraak 08:00: regen om 8:00 valt buiten het vertrekvenster, om 7:00 erbinnen', x.buffer.length === 0 && y.buffer.length === 1, [x.buffer, y.buffer]);
    toets('3c eerste afspraak om 07:00: geen vertrekdeel', z.buffer.length === 0, z.buffer);
  }
  // 4. regen op de terugrit (praktijkvak, 16:30–19:00 zonder Werk-afspraak; Groenhouten-dienst → Groenhouten-vak)
  {
    const gh = [{ soort: 'dienst', titel: 'DS', feed: 'rooster-gh-artsen', begin_datum: DATUM, eind_datum: DATUM }];
    const x = proef({ kalender: gh, praktijk: onecall(regenUur(17)) });
    const r = await x.doe();
    const q = x.aanroepen.map((u) => new URL(u).searchParams);
    toets('4 regen op de terugrit uit het praktijkvak', x.buffer.length === 1 && /Rond 17:00 regen op je terugrit/.test(x.buffer[0].tekst), x.buffer);
    toets('4 Groenhouten-dienst: praktijk Groenhouten, vak 52.1/5.6', r.detail.praktijk === 'Groenhouten' && q[1].get('lat') === '52.1' && q[1].get('lon') === '5.6', [r.detail, q.map(String)]);
  }
  // 4b. terugvenster uit de laatste Werk-afspraak (eindigt 20:00 NL → venster 20:00–21:00)
  {
    const werk = [{ soort: 'afspraak', sync_agenda: 'werk', begin_tijd: DATUM + 'T07:00:00+00:00', eind_tijd: DATUM + 'T19:00:00+00:00' }];
    const x = proef({ kalender: werk, praktijk: onecall(regenUur(17)) });
    await x.doe();
    const y = proef({ kalender: werk, praktijk: onecall(regenUur(20)) });
    await y.doe();
    toets('4b getimede Werk-afspraak tot 20:00: regen om 17:00 telt niet, om 20:00 wel', x.buffer.length === 0 && y.buffer.length === 1 && /Rond 20:00 regen op je terugrit/.test(y.buffer[0].tekst), [x.buffer, y.buffer]);
  }
  // 5. onweer, 6. gladheid, 7. storm, 8. hitte, 9. KNMI-waarschuwing (vrije dag: die gelden ook zonder werk)
  {
    const x = proef({ thuis: onecall((i, u) => { if (i === 15 || i === 16) u.weather = [{ id: 211 }]; }) });
    await x.doe();
    toets('5 onweer 15:00–17:00', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: Kans op onweer tussen 15:00 en 17:00.', x.buffer);
  }
  {
    const x = proef({ thuis: onecall((i, u) => { if (i >= 5 && i <= 8) u.temp = 0; if (i === 6) u.snow = { '1h': 0.3 }; }) });
    await x.doe();
    toets('6 gladheid: vorst + sneeuw om 6:00, nat vorig uur om 7:00 → tot 8:00', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: Vanochtend tot 8:00 kans op gladheid.', x.buffer);
    const y = proef({ thuis: onecall((i, u) => { if (i >= 5 && i <= 8) u.temp = 0; }) });
    await y.doe();
    toets('6 alleen vorst zonder neerslag: geen gladheidsregel', y.buffer.length === 0, y.buffer);
  }
  {
    const x = proef({ thuis: onecall((i, u) => { if (i === 13) u.wind_gust = 22; if (i === 14) u.wind_gust = 24; }) });
    await x.doe();
    toets('7 storm: windstoten ≥ 20 m/s → km/u op 5 afgerond', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: Windstoten tot 85 km/u (vanaf 13:00).', x.buffer);
  }
  {
    const j = onecall(); j.daily[0].temp.max = 31.4;
    const x = proef({ thuis: j });
    await x.doe();
    toets('8 hitte: dagmaximum ≥ 30 °C', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: Warm, tot 31 °C.', x.buffer);
  }
  {
    const al = [{ sender_name: 'KNMI', event: 'Code geel wind', start: Date.parse(DATUM + 'T08:00:00Z') / 1000, end: Date.parse(DATUM + 'T14:00:00Z') / 1000, description: 'lange tekst die er niet in hoort', tags: ['Wind'] }];
    const x = proef({ thuis: onecall(null, { alerts: al }), praktijk: onecall(null, { alerts: al }) });
    await x.doe();
    toets('9 KNMI-waarschuwing: naam + eindtijd, ontdubbeld over beide vakken, zonder de lange tekst', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: KNMI Code geel wind tot 15:00.', x.buffer);
    const p = proef({ praktijk: onecall(null, { alerts: al }) }); await p.doe();
    const q = proef({ kalender: DIENST, praktijk: onecall(null, { alerts: al }) }); await q.doe();
    toets('9 waarschuwing alleen in het praktijkvak: niet op een vrije dag, wel op een werkdag (MOET 2)', p.buffer.length === 0 && q.buffer.length === 1 && /KNMI Code geel wind/.test(q.buffer[0].tekst), [p.buffer, q.buffer]);
    const oud = [{ sender_name: 'KNMI', event: 'Code geel gladheid', start: Date.parse(DATUM + 'T00:00:00Z') / 1000, end: Date.parse(DATUM + 'T04:30:00Z') / 1000 }];
    const y = proef({ thuis: onecall(null, { alerts: oud }) });
    await y.doe();
    toets('9 waarschuwing die vóór 06:00 afloopt: geen regel', y.buffer.length === 0, y.buffer);
  }
  // 10. meerdere treffers = één regel, waarschuwing eerst, ≤ ± 160 tekens
  {
    const al = [{ sender_name: 'KNMI', event: 'Code oranje wind', start: Date.parse(DATUM + 'T06:00:00Z') / 1000, end: Date.parse(DATUM + 'T20:00:00Z') / 1000 }];
    const t = onecall((i, u) => { if (i === 12) u.wind_gust = 25; if (i === 15) u.weather = [{ id: 201 }]; regenUur(7)(i, u); }, { alerts: al });
    const x = proef({ kalender: DIENST, thuis: t, praktijk: onecall(regenUur(18)) });
    await x.doe();
    const tk = x.buffer[0] && x.buffer[0].tekst;
    toets('10 meerdere treffers: één rij, begint met de waarschuwing, ≤ 160 tekens', x.buffer.length === 1 && /^Weer: KNMI Code oranje wind tot 21:00; /.test(tk) && tk.length <= 160, tk);
  }
  // 11. API-fout: dag 1 stil, dag 2 één box-rij, dag 3 geen tweede; daarna een goede dag en weer opnieuw meldbaar
  {
    const pad = path.join(d, 'fout.json');
    const f = { ophalen: async () => ({ status: 401, json: { cod: 401, message: 'Invalid API key ' + SLEUTEL } }), staatPad: pad };
    const x1 = proef(f); const r1 = await x1.doe({ datum: '2026-11-11' });
    toets('11 dag 1 fout: ok:true met detail.fout, geen rij, geen box', r1.ok === true && /http 401/.test(r1.detail.fout) && x1.buffer.length === 0 && x1.box.length === 0, r1);
    toets('11 401: geen herkansing (één aanroep)', x1.aanroepen.length === 1, x1.aanroepen.length);
    const x2 = proef(f); await x2.doe({ datum: '2026-11-12' });
    toets('11 dag 2 fout: precies één box-rij #weer-ochtend', x2.box.length === 1 && /#weer-ochtend/.test(x2.box[0]) && /- status: open/.test(x2.box[0]), x2.box);
    const x3 = proef(f); await x3.doe({ datum: '2026-11-13' });
    toets('11 dag 3 fout: geen tweede box-rij', x3.box.length === 0);
    const x4 = proef({ staatPad: pad }); await x4.doe({ datum: '2026-11-14' });
    const s4 = JSON.parse(fs.readFileSync(pad, 'utf8'));
    toets('11 goede dag wist de foutstand', s4.laatste_ok === '2026-11-14' && !s4.fout_sinds && !s4.box_gemeld, s4);
    const alle = JSON.stringify([x1, x2, x3].map((x) => [x.box, x.log, x.buffer])) + fs.readFileSync(pad, 'utf8') + JSON.stringify(r1);
    toets('11 sleutel en appid= nergens in box, log, buffer, staat of uitkomst', alle.indexOf(SLEUTEL) < 0 && !/appid=/i.test(alle));
  }
  // 12. time-out: één herkansing per plek
  {
    let n = 0;
    const x = proef({ ophalen: async (u, q) => { n++; if (n === 1) { const e = new Error('The operation was aborted due to timeout https://api.openweathermap.org/?appid=' + SLEUTEL); e.name = 'TimeoutError'; throw e; } return { status: 200, json: onecall() }; } });
    const r = await x.doe();
    toets('12 time-out: herkansing lukt, ok zonder fout, 3 aanroepen', r.ok && !r.detail.fout && x.aanroepen.length === 3, [r, x.aanroepen.length]);
    const y = proef({ ophalen: async () => { const e = new Error('fetch failed ' + 'appid=' + SLEUTEL); throw e; } });
    const ry = await y.doe();
    toets('12 netwerkfout tweemaal: stil, soort "netwerk", geen URL of sleutel', ry.ok && ry.detail.fout === 'thuis: netwerk' && JSON.stringify([ry, y.log]).indexOf(SLEUTEL) < 0, [ry, y.log]);
  }
  // 13. rem 50 per dag
  {
    const pad = path.join(d, 'rem.json');
    fs.writeFileSync(pad, JSON.stringify({ teller_datum: DATUM, teller: 49 }));
    const x = proef({ staatPad: pad });
    const r = await x.doe();
    toets('13 rem: bij 49 nog één aanroep, de tweede wordt geweigerd (stil, fout rem)', x.aanroepen.length === 1 && /rem 50/.test(r.detail.fout) && x.buffer.length === 0, [r, x.aanroepen.length]);
    const y = proef({ staatPad: pad }); fs.writeFileSync(pad, JSON.stringify({ teller_datum: '2026-11-10', teller: 50 }));
    await y.doe();
    toets('13 rem telt per dag (nieuwe dag = teller op 0)', y.aanroepen.length === 2 && JSON.parse(fs.readFileSync(pad, 'utf8')).teller === 2);
  }
  // 14. geen sleutel: stil, ook op de tweede dag geen box-rij, geen aanroep
  {
    const pad = path.join(d, 'geen.json');
    const a = proef({ sleutel: null, staatPad: pad }); await a.doe({ datum: '2026-11-11' });
    const b = proef({ sleutel: null, staatPad: pad }); const rb = await b.doe({ datum: '2026-11-12' });
    toets('14 geen sleutel: geen aanroep, geen box (ook dag 2), ok:true', a.aanroepen.length + b.aanroepen.length === 0 && a.box.length + b.box.length === 0 && rb.ok && rb.detail.fout === 'geen sleutel', rb);
  }
  // 15. na 07:00 (keten liep laat): geen aanroepen meer
  {
    const x = proef();
    const r = await x.doe({ uur: 7, min: 5 });
    toets('15 na 07:00: al_gedaan te_laat, geen aanroep', r.al_gedaan && r.detail.te_laat && x.aanroepen.length === 0, r);
  }
  // 16. staatbestand 600, tekst ≤ 160 bij een lange waarschuwingsnaam
  {
    const x = proef();
    await x.doe();
    toets('16 staatbestand modus 600', (fs.statSync(x.staatPad).mode & 0o777) === 0o600, (fs.statSync(x.staatPad).mode & 0o777).toString(8));
    const lang = [{ sender_name: 'KNMI', event: 'Code oranje ' + 'heel erg lange waarschuwingsnaam '.repeat(5), start: Date.parse(DATUM + 'T06:00:00Z') / 1000, end: Date.parse(DATUM + 'T20:00:00Z') / 1000 }];
    const y = proef({ thuis: onecall((i, u) => { if (i === 12) u.wind_gust = 25; }, { alerts: lang }) });
    await y.doe();
    toets('16 lange waarschuwing: regel ≤ 160 tekens', y.buffer.length === 1 && y.buffer[0].tekst.length <= 160, y.buffer);
  }
  // 18. wv2592: werkdag ook uit de locatie (6-11 gemist: op het werk zonder dienst of Werk-afspraak)
  {
    const x = proef({ werkRecent: { dagen: 2, plek: 'Huisartsenpraktijk Groenhouten' }, praktijk: onecall(regenUur(17)) });
    const r = await x.doe();
    const q = x.aanroepen.map((u) => new URL(u).searchParams);
    toets('18 ma–vr + 2 werkdagen deze week: werkdag (locatie_week), praktijk Groenhouten, terugritregen', r.detail.werkdag === true && r.detail.werk_bron === 'locatie_week' && r.detail.praktijk === 'Groenhouten' && q[1].get('lat') === '52.1' && x.buffer.length === 1 && /terugrit/.test(x.buffer[0].tekst), [r.detail, x.buffer]);
    const y = proef({ werkRecent: { dagen: 1, plek: null }, praktijk: onecall(regenUur(17)) });
    const ry = await y.doe();
    toets('18 maar 1 werkdag deze week: vrije dag, geen terugritregen', ry.detail.werkdag === false && ry.detail.werk_bron === null && y.buffer.length === 0, [ry.detail, y.buffer]);
    const z = proef({ werkRecent: { dagen: 4, plek: 'Huisartsenpraktijk Tolgaarde' } });
    const rz = await z.doe({ datum: '2026-11-14' });
    toets('18 zaterdag telt niet als werkdag uit de locatieweek', rz.detail.werkdag === false, rz.detail);
    const w = proef({ locatie: { plek: 'Huisartsenpraktijk Tolgaarde', leeftijd_s: 60 }, praktijk: onecall(regenUur(17)) });
    const rw = await w.doe();
    toets('18 om 06:40 al op de praktijk: werkdag (locatie_nu), geen vertrekdeel, wel terugrit', rw.detail.werk_bron === 'locatie_nu' && w.buffer.length === 1 && /terugrit/.test(w.buffer[0].tekst) && !/vertrek/.test(w.buffer[0].tekst), [rw.detail, w.buffer]);
    const v = proef({ locatie: { plek: 'Huisartsenpraktijk Tolgaarde', leeftijd_s: 7200 } });
    const rv = await v.doe();
    toets('18 oude locatie op de praktijk telt niet', rv.detail.werkdag === false, rv.detail);
    const k = proef({ werkRecent: undefined }); const rk = await k.doe();
    toets('18 zonder werkRecent (oude koppeling): als voorheen vrije dag', rk.ok && rk.detail.werkdag === false);
  }
  // 19. plaats uit de agendalocatie (verzonnen adressen)
  {
    const P = W._intern.plaatsUit;
    const gevallen = [
      ['Verzonnenstraat 12, 1234 AB Nepdorp, Nederland', 'Nepdorp'], ['Laan van Fop 3, 9999ZZ Fop-Stad', 'Fop-Stad'], ['Neplaan 7, Fopstad', null], ['Kamer 2, Nepinstelling', null],
      ['Rue Imaginaire 5, 1000 Nepville, Belgique', 'Nepville'], ['Fopweg 1, 12345 Nepheim', 'Nepheim'], ['Fopstad', null], ['Zaal 2', null],
      ['https://zoom.us/j/123', null], ['Teams-vergadering', null], ['Vergaderzaal | Gebouw - verdieping twee', null], ['Bel nep@voorbeeld.nl', null],
      ['', null], [null, null], ['Neplaan 7, 1234 AB Fopstad (achteringang)', 'Fopstad'], ['Neplaan 7, 1234 AB', null]];
    const fout = gevallen.filter((g) => P(g[0]) !== g[1]).map((g) => [g[0], P(g[0]), g[1]]);
    toets('19 plaatsUit: alleen de plaats, niets bij losse woorden, links of mailadressen', fout.length === 0, fout);
  }
  // 20. wv2592 meetpunt 4: weer op de plek van een afspraak elders
  {
    const NAAM = 'Nepstraat 4, 9999 ZZ Fopstad, Nederland';
    const geo = (q) => (q === 'Fopstad' ? [{ name: 'Fopstad', local_names: { nl: 'Fopstad' }, lat: 53.21, lon: 6.57, country: 'NL' }]
      : q === 'Dichtbij' ? [{ name: 'Dichtbij', lat: 51.88, lon: 5.33, country: 'NL' }] : q === 'Dubbelnaam' ? [{ name: 'Dubbelnaam', lat: 40.1, lon: -75.1, country: 'US' }, { name: 'Dubbelnaam', lat: 53.21, lon: 6.57, country: 'NL' }] : q === 'Verweg' ? [{ name: 'Verweg', lat: 13.4, lon: -16.6, country: 'GM' }]
      : [{ name: q, lat: 52.9, lon: 4.8, country: 'NL' }]);
    const ver = () => onecall((i, u) => { if (i === 13) { u.pop = 0.9; u.rain = { '1h': 1.1 }; } if (i === 14) u.wind_gust = 21; });
    const ev = (kal, uurNL, loc, extra) => Object.assign({ kalender: kal, start: DATUM + 'T' + String(uurNL).padStart(2, '0') + ':00:00+01:00', einde: DATUM + 'T' + String(uurNL + 1).padStart(2, '0') + ':00:00+01:00', hele_dag: false, status: 'confirmed', locatie: loc, titel: 'Geheimetitel' }, extra || {});
    const x = proef({ afspraken: [ev('Gezin', 14, NAAM)], geo: geo, ver: ver });
    const r = await x.doe();
    const geoUrl = x.aanroepen.filter((u) => u.indexOf('/geo/1.0/') >= 0);
    toets('20 afspraak elders: regel met tijd, plaats, regen en windstoten', x.buffer.length === 1 && x.buffer[0].tekst === 'Weer: 14:00 Fopstad: regen (± 1 mm), windstoten tot 75 km/u.', x.buffer);
    toets('20 naar de Geocoding-API alleen de plaatsnaam (geen straat, postcode of titel)', geoUrl.length === 1 && new URL(geoUrl[0]).searchParams.get('q') === 'Fopstad' && !/Nepstraat|9999|Geheim/.test(x.aanroepen.join(' ')), geoUrl.map((u) => u.replace(/appid=[^&]*/, '')));
    toets('20 One Call voor het vak van de plaats op 1 decimaal; 4 aanroepen totaal', x.aanroepen.length === 4 && x.aanroepen.some((u) => /lat=53\.2&lon=6\.6&/.test(u)), x.aanroepen.length);
    toets('20 log en detail zonder plaatsnaam of sleutel', !/Fopstad|Nepstraat/.test(JSON.stringify([x.log, r.detail])) && JSON.stringify(x.log).indexOf(SLEUTEL) < 0 && r.detail.elders.treffers === 1, [x.log, r.detail]);
    const w = proef({ afspraken: [ev('Werk', 14, NAAM), ev('Schapies', 15, NAAM)], geo: geo, ver: ver });
    await w.doe();
    toets('20 Werk-agenda (en andere dan David/Gezin/HAGRO): nooit opgezocht', w.aanroepen.length === 2 && w.buffer.length === 0, w.aanroepen.length);
    const dz = proef({ afspraken: [ev('David', 14, 'Neplaan 1, 9998 ZZ Dichtbij')], geo: geo, ver: ver });
    await dz.doe();
    toets('20 binnen 15 km van Thuis/praktijk: geocode wel, geen One Call, geen regel', dz.aanroepen.length === 3 && dz.buffer.length === 0, dz.aanroepen.length);
    const vw = proef({ afspraken: [ev('David', 14, 'Nepweg 2, 9997 ZZ Verweg')], geo: geo, ver: ver });
    await vw.doe();
    toets('20 buiten NL/BE/DE: geen One Call', vw.aanroepen.length === 3 && vw.buffer.length === 0, vw.aanroepen.length);
    const hd = proef({ afspraken: [ev('David', 14, NAAM, { hele_dag: true, start: DATUM }), ev('David', 6, NAAM), ev('David', 14, NAAM, { status: 'cancelled' }), ev('David', 14, 'Zoom')], geo: geo, ver: ver });
    await hd.doe();
    toets('20 hele dag, vóór 07:00, geannuleerd of geen plaats: overgeslagen', hd.aanroepen.length === 2 && hd.buffer.length === 0, hd.aanroepen.length);
    const veel = proef({ afspraken: ['Aa', 'Bb', 'Cc', 'Dd', 'Ee'].map((p, i) => ev('David', 9 + i, 'Nepweg ' + i + ', 999' + i + ' ZZ Plaats' + p)), geo: geo, ver: () => onecall() });
    await veel.doe();
    toets('20 hooguit 3 plaatsen (3 geocodes, 3 One Calls)', veel.aanroepen.filter((u) => /\/geo\//.test(u)).length === 3 && veel.aanroepen.length === 8, veel.aanroepen.length);
    const dub = proef({ afspraken: [ev('David', 15, NAAM), ev('Gezin', 14, 'Ander 1, 9999 ZZ Fopstad')], geo: geo, ver: ver });
    await dub.doe();
    toets('20 dezelfde plaats twee keer: één opzoeking, de vroegste afspraak telt', dub.aanroepen.length === 4 && dub.buffer.length === 1 && /^Weer: 14:00 Fopstad/.test(dub.buffer[0].tekst), dub.buffer);
    const af = proef({ afspraken: 'fout', kalender: DIENST, praktijk: onecall(regenUur(17)) });
    const ra = await af.doe();
    toets('20 agenda niet leesbaar: stil, thuisdeel blijft, geen box', ra.ok && ra.detail.elders.stand === 'agenda niet leesbaar' && af.buffer.length === 1 && /terugrit/.test(af.buffer[0].tekst) && af.box.length === 0, [ra.detail, af.buffer]);
    const sam = proef({ afspraken: [ev('Gezin', 14, NAAM)], geo: geo, ver: ver, kalender: DIENST, praktijk: onecall(regenUur(17)), thuis: onecall((i, u) => { if (i === 13) u.wind_gust = 22; }) });
    await sam.doe();
    const ts = sam.buffer[0] && sam.buffer[0].tekst;
    toets('20 samen met het thuisdeel: thuis eerst, plek erachter, ≤ 280 tekens', sam.buffer.length === 1 && /^Weer: Windstoten tot 80 km\/u \(vanaf 13:00\); rond 17:00 regen op je terugrit \(± 1 mm\); 14:00 Fopstad: /.test(ts) && ts.length <= 280, ts);
    const gf = proef({ afspraken: [ev('Gezin', 14, NAAM)], ophalen: async (u) => (u.indexOf('/geo/') >= 0 ? { status: 500, json: null } : { status: 200, json: onecall() }) });
    const rg = await gf.doe();
    toets('20 geocode-fout: stil, ok, geen box, geen rij', rg.ok && !rg.detail.fout && gf.box.length === 0 && gf.buffer.length === 0 && rg.detail.elders.fouten === 1, rg.detail);
    const dn = proef({ afspraken: [ev('David', 14, 'Nepweg 9, 9996 ZZ Dubbelnaam')], geo: geo, ver: ver });
    await dn.doe();
    toets('20 eerste geocode buiten NL/BE/DE: de eerste in NL/BE/DE telt (ronde 2 ZOU 1), limit 5', dn.buffer.length === 1 && /14:00 Dubbelnaam:/.test(dn.buffer[0].tekst) && dn.aanroepen.some((u) => /\/geo\/.*limit=5/.test(u)), dn.buffer);
    const raar = proef({ afspraken: [ev('Gezin', 14, NAAM)], geo: geo, ver: () => onecall((i, u) => { if (i === 13) { u.pop = 0.9; u.rain = { '1h': 1 }; u.weather = null; u.temp = 'x'; } }), kalender: DIENST, praktijk: onecall(regenUur(17)) });
    const rr = await raar.doe();
    toets('20 raar antwoord ter plaatse: thuisdeel blijft staan (MOET 2)', rr.ok && raar.buffer.length === 1 && /terugrit/.test(raar.buffer[0].tekst), [rr.detail, raar.buffer]);
    const droog = proef({ afspraken: [ev('Gezin', 14, NAAM)], geo: geo, ver: ver });
    const rd = await droog.w.doe({ droog: true, ams: { datum: DATUM, uur: 6, min: 40 } });
    toets('20 droog: regel terug, niets in de buffer', rd.droog && /Fopstad/.test(rd.regel) && droog.buffer.length === 0, rd);
  }
  // 22. wv2605 (idee 28 § 9): avondseintje bij vroeg vertrek. Vandaag = di 10-11 (avond), morgen = wo 11-11 (DATUM)
  {
    const VANDAAG = '2026-11-10';
    const avondProef = function (o) {
      o = o || {};
      const st = { aanroepen: [], berichten: [], log: [], box: [], buffer: [] };
      const staatPad = o.staatPad || path.join(d, 'avond-' + Math.random().toString(36).slice(2) + '.json');
      let klok = o.klok || [Date.parse(VANDAAG + 'T20:05:00Z')];   // 21:05 NL; een lijst = opeenvolgende nu()-waarden (laatste blijft)
      const w = W.maak({ staatPad: staatPad,
        sleutel: async () => (o.sleutel === undefined ? SLEUTEL : o.sleutel),
        plekken: async () => PLEKKEN,
        locatie: async () => ({ plek: 'Thuis', leeftijd_s: 60 }),
        kalender: async (dt) => { st.kalDatum = dt; if (o.kalFout && o.kalFout-- > 0) throw new Error('rpc 500'); return o.kalender || []; },
        werkRecent: async () => (o.werkRecent || { dagen: 0, plek: null }),
        ophalen: async (url) => { st.aanroepen.push(url); if (o.ophalen) return o.ophalen(url, st.aanroepen.length); return { status: 200, json: o.thuis || onecall() }; },
        bufferZet: async (dt, t) => { st.buffer.push(t); },
        boxRij: (t) => { st.box.push(t); return true; },
        melden: async (tekst, sl) => { if (o.meldFout && o.meldFout-- > 0) throw new Error('pod 500'); st.berichten.push({ tekst, sl }); },
        log: (x) => st.log.push(JSON.stringify(x)),
        nu: () => (klok.length > 1 ? klok.shift() : klok[0]) });
      st.w = w; st.staatPad = staatPad;
      st.tik = (a) => w.avond({ ams: Object.assign({ datum: VANDAAG, uur: 21, min: 5 }, a || {}) });
      return st;
    };
    const vorstSneeuw = (i, u) => { if (i >= 5 && i <= 6) { u.temp = -1; u.snow = { '1h': 0.4 }; u.weather = [{ id: 600 }]; } };
    // a. avond vóór een werkdag met vorst en neerslag in 05:00–07:00
    const a = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw) });
    const ra = await a.tik();
    toets('22a werkdag morgen + vorst/sneeuw 05–07: één bericht met gladheid en tijden', a.berichten.length === 1 && /^Weer morgenvroeg \(5–8 uur, je heenweg\): kans op gladheid \(5:00–7:00\)\.$/.test(a.berichten[0].tekst), [ra, a.berichten]);
    toets('22a één ontdubbelsleutel per avond, kalender van morgen, één aanroep voor het Thuisvak', a.berichten[0] && a.berichten[0].sl === 'weer-avond-' + VANDAAG && a.kalDatum === DATUM && a.aanroepen.length === 1 && new URL(a.aanroepen[0]).searchParams.get('lat') === '51.9', [a.kalDatum, a.aanroepen.length]);
    toets('22a niets in de ochtendbuffer, geen box-rij', a.buffer.length === 0 && a.box.length === 0);
    const ra2 = await a.tik({ min: 10 });
    toets('22a tweede tik dezelfde avond: al gedaan, geen tweede bericht of aanroep', ra2.al_gedaan === true && a.berichten.length === 1 && a.aanroepen.length === 1, ra2);
    const ra3 = await a.tik({ datum: DATUM, uur: 21, min: 5 });
    toets('22a volgende avond: weer een ronde (nieuwe datum)', !ra3.al_gedaan && a.aanroepen.length === 2, ra3);
    // b. werkdag, droog en mild: niets, wel de ene aanroep
    const b = avondProef({ kalender: DIENST });
    const rb = await b.tik();
    toets('22b werkdag zonder treffer: niets gemeld, één aanroep', b.berichten.length === 0 && b.aanroepen.length === 1 && rb.detail.gemeld === false && rb.detail.werkdag === true, rb);
    // c. vrije dag morgen (geen dienst, geen Werk-afspraak, locatieweek 0) met gladheid: niets, maar de aanroep gebeurt wel (geen patroon)
    const c = avondProef({ thuis: onecall(vorstSneeuw) });
    const rc = await c.tik();
    toets('22c vrije dag morgen met gladheid: niets gemeld, wel dezelfde ene aanroep', c.berichten.length === 0 && c.aanroepen.length === 1 && rc.detail.werkdag === false && rc.detail.treffers === 'gladheid', rc);
    // d. werkdag via de locatieweek-regel (wo, ≥ 2 werkdagen); en za-avond voor zondag: geen werkdag
    const dl = avondProef({ werkRecent: { dagen: 3, plek: 'Huisartsenpraktijk Groenhouten' }, thuis: onecall(vorstSneeuw) });
    const rdl = await dl.tik();
    toets('22d locatieweek-regel: werkdag, bericht', dl.berichten.length === 1 && rdl.detail.werk_bron === 'locatie_week', rdl);
    const za = avondProef({ werkRecent: { dagen: 5, plek: 'Huisartsenpraktijk Tolgaarde' }, thuis: onecall(vorstSneeuw) });
    const rza = await za.tik({ datum: '2026-11-14' });
    toets('22d za-avond voor zondag (locatieweek telt niet in het weekend): niets', za.berichten.length === 0 && rza.detail.werkdag === false, rza);
    // e. stille uren en venster
    const e1 = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw) });
    const re1 = await e1.tik({ uur: 23, min: 5 });
    const re0 = await e1.tik({ uur: 20, min: 55 });
    const re2 = await e1.tik({ uur: 22, min: 30 });
    toets('22e buiten 21:00–22:29 (20:55, 22:30, 23:05): geen aanroep, niets gemeld', re1.al_gedaan && re0.al_gedaan && re2.al_gedaan && e1.aanroepen.length === 0 && e1.berichten.length === 0, [re0, re2, re1]);
    const e2 = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw), klok: [Date.parse(VANDAAG + 'T22:01:00Z')] });   // de tik zag 22:29, bij het sturen is het 23:01
    const re3 = await e2.tik({ uur: 22, min: 29 });
    toets('22e ronde begon 22:29 maar het werd 23:01 vóór het sturen: niets gemeld (stille uren), avond klaar', e2.berichten.length === 0 && re3.detail.stille_uren === true && JSON.parse(fs.readFileSync(e2.staatPad, 'utf8')).avond_datum === VANDAAG, re3);
    // f. rem 50: geen aanroep, niets
    const fp = path.join(d, 'avond-rem.json');
    fs.writeFileSync(fp, JSON.stringify({ teller_datum: VANDAAG, teller: 50 }));
    const f = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw), staatPad: fp });
    const rf = await f.tik();
    const rf2 = await f.tik({ min: 15 });
    toets('22f rem 50 per dag: geen aanroep, niets gemeld, stil, avond klaar', f.aanroepen.length === 0 && f.berichten.length === 0 && /^rem 50/.test(rf.detail.fout) && rf2.al_gedaan === true && f.box.length === 0, rf);
    // g. bezorging faalt: volgende tik opnieuw, hooguit 3 pogingen; API-fout idem stil
    const g = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw), meldFout: 1 });
    const rg1 = await g.tik();
    const rg2 = await g.tik({ min: 10 });
    toets('22g bericht niet bezorgd: tweede tik bezorgt het (één bericht)', rg1.detail.gemeld === false && g.berichten.length === 1 && rg2.detail.gemeld === true, [rg1, rg2]);
    const g3 = avondProef({ kalender: DIENST, ophalen: async () => ({ status: 503, json: null }) });
    for (const mi of [5, 10, 15, 20]) await g3.tik({ min: mi });
    toets('22g API 503: stil, geen box-rij, hooguit 3 rondes (2 aanroepen per ronde) en dan klaar', g3.berichten.length === 0 && g3.box.length === 0 && g3.aanroepen.length === 6, g3.aanroepen.length);
    const g4 = avondProef({ kalender: DIENST, sleutel: null });
    const rg4 = await g4.tik();
    toets('22g geen sleutel: stil, geen aanroep', g4.aanroepen.length === 0 && g4.berichten.length === 0 && rg4.detail.fout === 'geen sleutel', rg4);
    const g5 = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw), kalFout: 1 });
    const rg5 = await g5.tik();
    const rg6 = await g5.tik({ min: 10 });
    toets('22g agenda even niet leesbaar (MOET 2): niet als vrije dag afgesloten, volgende tik meldt', rg5.detail.fout === 'kalender niet leesbaar' && g5.aanroepen.length === 1 && g5.berichten.length === 1 && rg6.detail.gemeld === true, [rg5, rg6]);
    const g7 = avondProef({ kalender: DIENST, kalFout: 9 });
    for (const mi of [5, 10, 15, 20]) await g7.tik({ min: mi });
    toets('22g agenda blijft onleesbaar: hooguit 3 pogingen, geen aanroep, stil', g7.aanroepen.length === 0 && g7.berichten.length === 0 && JSON.parse(fs.readFileSync(g7.staatPad, 'utf8')).avond_datum === VANDAAG);
    // h. storm, onweer en KNMI-waarschuwing in het venster; waarschuwing buiten het venster telt niet
    const ALERT = (sU, eU, ev) => ({ sender_name: 'KNMI', event: ev, start: UUR0 + sU * 3600, end: UUR0 + eU * 3600 });
    const h = avondProef({ kalender: DIENST, thuis: onecall((i, u) => { if (i === 6) { u.wind_gust = 23; u.weather = [{ id: 211 }]; } }, { alerts: [ALERT(3, 12, 'Code oranje wind'), ALERT(14, 20, 'Code geel onweer')] }) });
    await h.tik();
    const ht = h.berichten[0] && h.berichten[0].tekst;
    toets('22h waarschuwing eerst, dan storm en onweer; waarschuwing van 14–20 niet', /^Weer morgenvroeg \(5–8 uur, je heenweg\): KNMI Code oranje wind tot 12:00; windstoten tot 85 km\/u; kans op onweer rond 6:00\.$/.test(ht || '') && !/geel/.test(ht), ht);
    const h2 = avondProef({ kalender: DIENST, thuis: onecall((i, u) => { if (i === 9) { u.temp = -2; u.snow = { '1h': 1 }; u.weather = [{ id: 601 }]; } }, { alerts: [ALERT(10, 14, 'Code geel gladheid')] }) });
    await h2.tik();
    toets('22h gladheid en waarschuwing pas na 08:00: niets', h2.berichten.length === 0);
    // i. droog: regel terug, niets gemeld, avond niet afgesloten
    const dr = avondProef({ kalender: DIENST, thuis: onecall(vorstSneeuw) });
    const rdr = await dr.w.avond({ ams: { datum: VANDAAG, uur: 14, min: 0 }, droog: true });
    toets('22i droog (ook buiten het venster): regel terug, niets gemeld, avond niet afgesloten', rdr.droog && /gladheid/.test(rdr.regel) && dr.berichten.length === 0 && !JSON.parse(fs.readFileSync(dr.staatPad, 'utf8')).avond_datum, rdr);
    // j. sleutel en appid nooit in bericht, log, staat of uitkomst; /health-info
    const alles = JSON.stringify([a.berichten, a.log, fs.readFileSync(a.staatPad, 'utf8'), ra, g3.log, rf, a.w.info()]);
    toets('22j sleutel en appid= nooit in bericht, log, staat of uitkomst', alles.indexOf(SLEUTEL) < 0 && !/appid=/i.test(alles), alles.slice(0, 300));
    const inf = a.w.info();
    toets('22j info: avond met laatste ronde en gemeld_op', inf.avond && inf.avond.gemeld_op === VANDAAG && inf.avond.laatste && inf.avond.laatste.voor, inf);
    // k. server.js
    const sv = fs.readFileSync('server.js', 'utf8');
    toets('22k bron weer-avond in de vaste bronnenlijst en soort dag (seintje)', /\n\s+'weer-avond',\s+\/\/ wv2605/.test(sv.slice(sv.indexOf('const BERICHT_BRONNEN'), sv.indexOf('const MELD_SOORTEN'))) && /const MELD_SOORT = \{[^}]*'weer-avond': 'dag'/.test(sv));
    toets('22k melden via berichtIntern naar het hoofdkanaal met ontdubbelsleutel', /berichtIntern\(\{ kanaal: 'hoofd', bron: 'weer-avond', klasse: 'normaal', soort: 'dag', tekst: tekst, sleutel: sl \}\)/.test(sv));
    toets('22k eigen dagklok: elke 5 min, alleen echte pod en rol primair, nooit dubbel tegelijk', /if \(!weerOchtend \|\| typeof weerOchtend\.avond !== 'function' \|\| !SERVER_ECHT \|\| !rolPrimair\(\) \|\| weerAvondBezig\) return;/.test(sv) && /if \(weerOchtend && SERVER_ECHT\) \{ setInterval\(function \(\) \{ weerAvondTik\(\); \}, 5 \* 60000\)\.unref\(\); \}/.test(sv));
  }
  // 21. server.js-koppeling wv2592
  {
    const sv = fs.readFileSync('server.js', 'utf8');
    const blok = sv.slice(sv.indexOf('afspraken: async function (d)'), sv.indexOf('ophalen: async function (url)', sv.indexOf('afspraken: async function (d)')));
    toets('21 afspraken: Agenda-Wachter-API van vandaag, zonder titel of omschrijving door te geven', /appAgendaApi\(\{ actie: 'agenda', start: d, end: appYmdPlus\(d, 1\) \}\)/.test(blok) && !/titel|omschrijving/.test(blok.replace(/\/\/.*$/gm, '')) && /locatie: e\.locatie \}/.test(blok), blok.slice(0, 200));
    toets('21 werkRecent: alleen een telling en de laatste werkplek uit secondbrain.locatie', /werkRecent: async function \(\) \{\n\s+const r = await weerBeheer\("select \(select count\(distinct/.test(sv) && /as dagen, \(select plek from secondbrain\.locatie where klasse = 'werk'/.test(sv) && /::date >= \(now\(\) at time zone 'Europe\/Amsterdam'\)::date - 7 and/.test(sv));
  }
  // 17. server.js en uitrol.sh
  {
    const sv = fs.readFileSync('server.js', 'utf8');
    toets('17 server.js: stap weer-ochtend om 06:40 in de keten, in-proces, limiet 3 min, 2 pogingen', /\{ naam: 'weer-ochtend', start_na: \[6, 40\], limiet_min: 3, pogingen: 2, inProces: true,/.test(sv));
    toets('17 server.js: sleutel via de Management-API (vault.decrypted_secrets), niet uit process.env', /WEER_SLEUTEL_NAAM = 'openweathermap_api_key'/.test(sv) && /select decrypted_secret as w from vault\.decrypted_secrets where name = '" \+ WEER_SLEUTEL_NAAM/.test(sv) && !/process\.env\.[A-Z_]*(OPENWEATHER|OWM)/i.test(sv));
    toets('17 server.js: plekken in de databank afgerond op 1 decimaal', /round\(lat::numeric, 1\)::float8 as lat, round\(lon::numeric, 1\)::float8 as lon from secondbrain\.locatie_plekken/.test(sv));
    toets('17 server.js: buffer-rij bron weer met teruglezen', /data: \{ bron: 'weer', datum: datum, tekst: tekst \}/.test(sv) && /rij na het schrijven niet teruggelezen/.test(sv));
    toets('17 server.js: /health.weer', /weer: typeof weerInfo === 'function' \? weerInfo\(\)/.test(sv));
    const blok = sv.slice(sv.indexOf('const WEER_SLEUTEL_NAAM'), sv.indexOf('function weerInfo'));
    toets('17 server.js: geen url of foutmelding van fetch in een log in het weerblok', !/schrijfLog\([^)]*url/i.test(blok) && !/logError\([^)]*url/i.test(blok));
    toets('17 uitrol.sh: weer-ochtend.js optioneel in de release', /RELEASE_OPTIONEEL="[^"]*\bweer-ochtend\.js\b/.test(fs.readFileSync('uitrol.sh', 'utf8')));
  }
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
