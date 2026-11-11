#!/usr/bin/env bash
# wv2894 (idee 19d meetpunt 6): zondagseintje binnenste kring. Verzonnen ringpagina, namen, nummers en datums (geen echte personen).
# Gevallen: alleen zondag; huishouden en geen_signaal nooit; > 42 dagen één keer per stilteperiode; nieuw contact = nieuwe periode;
# blind = stil; extra contactnaam uit config; verjaardag ≤ 14 d één keer; fail-closed (pagina, contacten, luik, ander antwoord) met
# één box-rij en geen regel; nummers nooit in staat, log, box, detail of regel; staat 600; > 30 ids in porties.
set -euo pipefail
cd "$(dirname "$0")/.."
node - <<'JS'
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const C = require('./contactringen.js');
let goed = 0, fouten = 0;
function toets(naam, ok, info) { if (ok) { goed++; console.log('GROEN ' + naam); } else { fouten++; console.log('ROOD  ' + naam + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); } }
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-'));
const ZO = { datum: '2026-11-15', uur: 6, min: 40 };   // zondag
const RING = `# Contactringen

## Regels

- iets

## Ring 1 — binnenste kring

### Huishouden (nooit een stil-signaal)

- [[20_Prive/Familie/Nep Huisgenoot|Huisgenoot]] — partner

### Overig ring 1

- [[20_Prive/Familie/Anna Nepper|Anna]] — zus
- [[20_Prive/Familie/Bram Nepper|Bram]] — broer
- [[20_Prive/Vrienden/Cees Verzonnen (Bijnaam)|Cees]] — vriend
- [[20_Prive/Familie/Dirk Nepper|Dirk]] — vader
- [[20_Prive/Familie/Eef Nepper|Eef]] — tante · geen_signaal (zie ik vaak, 12-11-2026)
- [[20_Prive/Familie/Fien Onvindbaar|Fien]] — nicht

## Ring 2 t/m 5

- [[20_Prive/Familie/Gijs Buiten|Gijs]] — ring 2
`;
// verzonnen contacten: Dirk heeft zijn mobiel onder een tweede contactnaam (config)
const CONTACT = {
  'nep huisgenoot': [{ weergavenaam: 'Nep Huisgenoot', telefoons_e164: ['+31600000100'] }],
  'anna nepper': [{ weergavenaam: 'Anna Nepper', telefoons_e164: ['+31600000101'], verjaardag: '1980-11-20' }],
  'bram nepper': [{ weergavenaam: 'Bram Nepper', telefoons_e164: ['+31600000102'] }, { weergavenaam: 'Bram Nepper Zakelijk', telefoons_e164: ['+31600000999'] }],
  'cees verzonnen': [{ weergavenaam: 'Cees Verzonnen', telefoons_e164: ['+31600000103'] }],
  'dirk nepper': [{ weergavenaam: 'Dirk Nepper', telefoons_e164: ['+31330000104'] }],
  'pa nep mob': [{ weergavenaam: 'Pa Nep Mob', telefoons_e164: ['+31600000105'] }],
  'eef nepper': [{ weergavenaam: 'Eef Nepper', telefoons_e164: ['+31600000106'], verjaardag: '1950-11-25' }],   // geen_signaal: ook geen verjaardag
  'fien onvindbaar': []
};
let DATUMS = { '31600000101@c.us': '2026-11-01', '31600000102@c.us': '2026-09-20', '31600000103@c.us': '2026-09-01', '31330000104@c.us': null, '31600000105@c.us': '2026-09-10', '31600000106@c.us': '2026-01-01', '31600000999@c.us': '2026-11-14' };
function maak(over) {
  const box = [], buf = [], log = [], vraag = { contacten: [], datums: [] };
  const o = Object.assign({ staatPad: path.join(d, 'cr', 'staat.json'), configPad: path.join(d, 'config.json'),
    ringTekst: async () => RING,
    contacten: async (q) => { vraag.contacten.push(q); return { ok: true, treffers: CONTACT[q.toLowerCase()] || [] }; },
    datums: async (ids) => { vraag.datums.push(ids.slice()); const u = {}; ids.forEach(function (i) { u[i] = Object.prototype.hasOwnProperty.call(DATUMS, i) ? DATUMS[i] : null; }); return { datums: u }; },
    bufferZet: async (datum, t) => { buf.push([datum, t]); }, boxRij: (t) => { box.push(t); return true; }, log: (x) => log.push(x) }, over || {});
  return { k: C.maak(o), box, buf, log, vraag, o };
}
fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ contactnamen: { '20_Prive/Familie/Dirk Nepper': ['Dirk Nepper', 'Pa Nep Mob'] } }));
const NR = /\d{8,}/;
(async function () {
  // 1. leesRing
  const r = C._intern.leesRing(RING);
  toets('ring: 7 personen in ring 1 (1 huishouden), ring 2 niet mee', r && r.length === 7 && r.filter(p => p.huishouden).length === 1 && !r.some(p => p.voornaam === 'Gijs'), r);
  toets('ring: geen_signaal herkend bij Eef', r.find(p => p.voornaam === 'Eef').geen_signaal === true && r.filter(p => p.geen_signaal).length === 1);
  toets('ring: verkeerde vorm → null', C._intern.leesRing('# x\n## Ring 1\n- [[a|b]]\n') === null && C._intern.leesRing('') === null);
  toets('naamUitPad knipt de bijnaam', C._intern.naamUitPad('20_Prive/Vrienden/Cees Verzonnen (Bijnaam)') === 'Cees Verzonnen');

  // 2. niet op zondag: niets
  let x = maak();
  let u = await x.k.doe({ ams: { datum: '2026-11-14', uur: 6, min: 40 } });
  toets('zaterdag: al_gedaan, geen aanroep', u.al_gedaan === true && x.vraag.contacten.length === 0 && x.buf.length === 0, u);

  // 3. zondag: Bram (56 d) en Cees (75 d) stil, Dirk via tweede contactnaam (66 d) stil; Anna recent + jarig 20-11; Eef geen_signaal; Fien blind
  x = maak();
  u = await x.k.doe({ ams: ZO });
  const t = x.buf.length ? x.buf[0][1] : '';
  toets('zondag: één bufferrij voor vandaag', x.buf.length === 1 && x.buf[0][0] === '2026-11-15', x.buf);
  toets('regel: Cees, Dirk en Bram stil (langst eerst), in weken', /laatste 1-op-1-appje met Cees is 10 weken geleden, met Dirk 9 weken, met Bram 8 weken/.test(t), t);
  toets('regel: nooit "lang niets gehoord"', !/niets gehoord/i.test(t), t);
  toets('regel: Anna jarig (vr 20-11), niet stil', /binnenkort jarig: Anna \(vr 20-11\)/.test(t) && !/met Anna/.test(t), t);
  toets('regel: huishouden, geen_signaal (Eef) en blind (Fien) niet genoemd', !/Huisgenoot|Eef|Fien/.test(t), t);
  toets('regel: uitweg "zie ik vaak"', /zie ik vaak/.test(t), t);
  toets('huishouden niet opgezocht', x.vraag.contacten.indexOf('Nep Huisgenoot') === -1, x.vraag.contacten);
  toets('Bram: alleen het contact met exact zijn naam telt (zakelijk-contact niet)', x.vraag.datums[0].indexOf('31600000999@c.us') === -1, x.vraag.datums);
  toets('detail: tellingen, geen namen of nummers', u.ok && u.detail.personen === 6 && u.detail.stil === 3 && u.detail.jarig === 1 && u.detail.blind === 1 && u.detail.geen_signaal === 1 && !NR.test(JSON.stringify(u)), u);
  const sp = path.join(d, 'cr', 'staat.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  toets('staat 600 en map 700', (fs.statSync(sp).mode & 0o777) === 0o600 && (fs.statSync(path.join(d, 'cr')).mode & 0o777) === 0o700, (fs.statSync(sp).mode & 0o777).toString(8));
  toets('staat: per vaultpad alleen laatst_gezien/gemeld_op/jarig_jaar, geen nummers', !NR.test(JSON.stringify(st)) && Object.values(st.personen).every(p => Object.keys(p).sort().join() === 'gemeld_op,jarig_jaar,laatst_gezien') && st.personen['20_Prive/Familie/Bram Nepper'].gemeld_op === '2026-11-15', st);
  toets('log en box zonder nummers', !NR.test(JSON.stringify(x.log)) && x.box.length === 0, [x.log, x.box]);
  u = await x.k.doe({ ams: ZO });
  toets('zelfde zondag nog eens: al_gedaan', u.al_gedaan === true && x.buf.length === 1);

  // 4. volgende zondag: niets nieuw (al gemeld in deze periode, verjaardag al gemeld) → geen rij
  x = maak();
  u = await x.k.doe({ ams: { datum: '2026-11-22', uur: 6, min: 40 } });
  toets('week erna: geen dubbele melding, geen rij', x.buf.length === 0 && u.ok && u.detail.stil === 0 && u.detail.jarig === 0, [u, x.buf]);
  // 5. Bram appt (nieuwe periode), 7 weken later weer stil → opnieuw één melding
  DATUMS['31600000102@c.us'] = '2026-11-25'; DATUMS['31600000101@c.us'] = '2027-01-05';
  x = maak(); u = await x.k.doe({ ams: { datum: '2026-11-29', uur: 6, min: 40 } });
  toets('nieuw contact: geen melding', x.buf.length === 0 && u.detail.stil === 0, [u, x.buf]);
  x = maak(); u = await x.k.doe({ ams: { datum: '2027-01-10', uur: 6, min: 40 } });
  toets('nieuwe stilteperiode (46 d): Bram opnieuw gemeld, de rest niet', x.buf.length === 1 && /met Bram is 6 weken geleden/.test(x.buf[0][1]) && !/Cees|Dirk/.test(x.buf[0][1]), x.buf);

  // 6. droog: geen staat, geen buffer, ook niet op een doordeweekse dag
  const voor = fs.readFileSync(sp, 'utf8');
  x = maak(); u = await x.k.doe({ ams: { datum: '2027-01-13', uur: 10, min: 0 }, droog: true });
  toets('droog: regel terug, niets geschreven', u.droog === true && typeof u.regel === 'string' && x.buf.length === 0 && fs.readFileSync(sp, 'utf8') === voor, u);

  // 7. na 07:00 op zondag: niets
  x = maak(); u = await x.k.doe({ ams: { datum: '2027-01-17', uur: 7, min: 5 } });
  toets('zondag na 07:00: al_gedaan te_laat, geen aanroep', u.al_gedaan && u.detail.te_laat && x.vraag.contacten.length === 0, u);

  // 8. fail-closed
  const gevallen = [
    ['ringpagina weg', { ringTekst: async () => { throw new Error('ENOENT'); } }, /ringpagina niet leesbaar/],
    ['ringpagina andere vorm', { ringTekst: async () => '# leeg\n' }, /verwachte vorm/],
    ['contacten fout secret', { contacten: async () => ({ ok: false, fout: 'secret' }) }, /contacten-webhook weigerde de sleutel/],
    ['contacten fout met tekst', { contacten: async () => ({ ok: false, fout: 'Jan Nepnaam 06-12 34 56 78 onbekend' }) }, /^contacten-webhook gaf een fout$/],
    ['contacten onbereikbaar', { contacten: async () => { throw new Error('http 500 +31600000101'); } }, /contacten-webhook onbereikbaar/],
    ['luik onbereikbaar', { datums: async () => { throw new Error('http 500'); } }, /zoekluik onbereikbaar/],
    ['luik oude vorm (chats)', { datums: async () => ({ aantal: 1, chats: [{ id: '31600000101@c.us', naam: 'x' }] }) }, /ander antwoord/],
    ['luik extra veld', { datums: async (ids) => ({ datums: {}, body: 'tekst' }) }, /ander antwoord/],
    ['luik geen datum', { datums: async (ids) => ({ datums: Object.fromEntries(ids.map(i => [i, 'gisteren om 10:00'])) }) }, /iets anders dan een datum/],
    ['buffer faalt', { bufferZet: async () => { throw new Error('n8n 500'); } }, /buffer niet gezet/]
  ];
  let zo = Date.parse('2027-01-24T12:00:00Z'), nr = 0;
  for (const [naam, over, re] of gevallen) {
    const dag = new Date(zo).toISOString().slice(0, 10); zo += 7 * 86400000;
    x = maak(Object.assign({ staatPad: path.join(d, 'fc' + (nr++), 'staat.json') }, over)); u = await x.k.doe({ ams: { datum: dag, uur: 6, min: 40 } });
    const box = x.box.join('');
    const alles = box + JSON.stringify(u) + JSON.stringify(x.log) + fs.readFileSync(x.o.staatPad, 'utf8');
    toets('fail-closed ' + naam + ': ok, geen regel, één box-rij, geen nummer of externe tekst', u.ok === true && re.test(u.detail.fout) && (naam === 'buffer faalt' || x.buf.length === 0) && x.box.length === 1 && /#contactringen/.test(box) && !NR.test(alles) && !/Nepnaam|34 56/.test(alles), [u, box.slice(0, 200)]);
    if (naam === 'buffer faalt') {
      const s3 = JSON.parse(fs.readFileSync(x.o.staatPad, 'utf8'));
      toets('buffer faalt: niemand als gemeld vastgelegd (volgende zondag opnieuw)', Object.values(s3.personen).every(p => !p.gemeld_op && !p.jarig_jaar), s3);
    }
    if (naam === 'contacten fout secret') {
      const u2 = await x.k.doe({ ams: { datum: dag, uur: 6, min: 45 } });
      toets('fail-closed: zelfde dag geen tweede box-rij', u2.al_gedaan === true && x.box.length === 1, u2);
    }
  }

  // review r2: na 07:00 klaar met ophalen → niets schrijven, niemand gemeld, één box-rij
  { let klok = 1000; const sp5 = path.join(d, 'cr5', 'staat.json');
    x = maak({ staatPad: sp5, nu: () => klok, datums: async (ids) => { klok += 21 * 60000; const u = {}; ids.forEach(i => { u[i] = DATUMS[i] || null; }); return { datums: u }; } });
    u = await x.k.doe({ ams: { datum: '2027-06-06', uur: 6, min: 40 } });
    const s5 = JSON.parse(fs.readFileSync(sp5, 'utf8'));
    toets('na 07:00 klaar: geen rij, niemand gemeld, één box-rij', x.buf.length === 0 && /te laat/.test(u.detail.fout) && x.box.length === 1 && Object.values(s5.personen).every(p => !p.gemeld_op), [u, x.buf]); }
  // review r2 MOET 2: extra contactnaam vult de paginanaam aan (Dirk: vaste lijn onder de paginanaam + mobiel onder 'Pa Nep Mob')
  { fs.writeFileSync(path.join(d, 'config2.json'), JSON.stringify({ contactnamen: { '20_Prive/Familie/Dirk Nepper': ['Pa Nep Mob'] } }));
    x = maak({ configPad: path.join(d, 'config2.json'), staatPad: path.join(d, 'cr6', 'staat.json') }); await x.k.doe({ ams: ZO });
    toets('config vult aan: paginanaam én extra naam opgezocht', x.vraag.contacten.indexOf('Dirk Nepper') >= 0 && x.vraag.contacten.indexOf('Pa Nep Mob') >= 0, x.vraag.contacten); }
  { let klok = 0; const sp7 = path.join(d, 'cr7', 'staat.json');
    x = maak({ staatPad: sp7, nu: () => klok, datums: async (ids) => { klok += 11000; const u = {}; ids.forEach(i => { u[i] = DATUMS[i] || null; }); return { datums: u }; } });
    u = await x.k.doe({ ams: { datum: '2027-06-13', uur: 6, min: 59 } });
    toets('start 06:59 (+ seconden onbekend), 11 s ophalen: te laat, niets geschreven', x.buf.length === 0 && /te laat/.test(u.detail.fout), u);
    x = maak({ staatPad: path.join(d, 'cr8', 'staat.json'), nu: () => klok }); u = await x.k.doe({ ams: { datum: '2027-06-13', uur: 6, min: 58 } });
    toets('start 06:58 zonder vertraging: wel geschreven', x.buf.length === 1, u); }
  { let klok = 0; const sp10 = path.join(d, 'cr10', 'staat.json');
    x = maak({ staatPad: sp10, nu: () => klok, bufferZet: async () => { klok += 25 * 60000; } });
    u = await x.k.doe({ ams: { datum: '2027-06-20', uur: 6, min: 40 } });
    const s10 = JSON.parse(fs.readFileSync(sp10, 'utf8'));
    toets('schrijven duurt tot na 07:00: niemand als gemeld, box-rij', /na 07:00 geschreven/.test(u.detail.fout) && Object.values(s10.personen).every(p => !p.gemeld_op && !p.jarig_jaar) && x.box.length === 1, [u, s10]); }
  { x = maak({ staatPad: path.join(d, 'cr11', 'staat.json'), datums: async (ids) => ({ datums: {} }) }); u = await x.k.doe({ ams: ZO });
    toets('luik laat een gevraagd nummer weg: fail-closed', /liet een gevraagd nummer weg/.test(u.detail.fout) && x.buf.length === 0, u); }
  // review r3 MOET 1: appje op de meldzondag zelf → nieuwe periode, 43 d later opnieuw gemeld
  { const sp9 = path.join(d, 'cr9', 'staat.json'); fs.mkdirSync(path.dirname(sp9), { recursive: true });
    fs.writeFileSync(sp9, JSON.stringify({ personen: { '20_Prive/Nep/Persoon 0': { laatst_gezien: '2027-01-01', gemeld_op: '2027-03-07', jarig_jaar: null } } }));
    const een = '## Ring 1\n### Overig ring 1\n- [[20_Prive/Nep/Persoon 0|P0]]\n';
    CONTACT['persoon 0'] = [{ weergavenaam: 'Persoon 0', telefoons_e164: ['+31610000000'] }];
    let dd = '2027-03-07';
    x = maak({ ringTekst: async () => een, staatPad: sp9, datums: async (ids) => ({ datums: { [ids[0]]: dd } }) });
    await x.k.doe({ ams: { datum: '2027-03-14', uur: 6, min: 40 } });
    x = maak({ ringTekst: async () => een, staatPad: sp9, datums: async (ids) => ({ datums: { [ids[0]]: dd } }) });
    u = await x.k.doe({ ams: { datum: '2027-04-25', uur: 6, min: 40 } });
    toets('appje op de meldzondag: 49 d later opnieuw gemeld', x.buf.length === 1 && /met P0 is 7 weken/.test(x.buf[0][1]), [u, x.buf]); }
  toets('isDatum: 2026-13-01 geeft false (geen uitzondering)', C._intern.isDatum('2026-13-01') === false);

  // 9. meer dan 30 ids → porties van ≤ 30
  const veel = { contactnamen: {} };
  let ring2 = '## Ring 1\n### Overig ring 1\n';
  for (let i = 0; i < 35; i++) { ring2 += '- [[20_Prive/Nep/Persoon ' + i + '|P' + i + ']]\n'; CONTACT['persoon ' + i] = [{ weergavenaam: 'Persoon ' + i, telefoons_e164: ['+316100000' + String(i).padStart(2, '0')] }]; }
  x = maak({ ringTekst: async () => ring2, staatPad: path.join(d, 'cr2', 'staat.json') });
  u = await x.k.doe({ ams: ZO });
  toets('35 personen: twee luikaanroepen (30 + 5)', x.vraag.datums.length === 2 && x.vraag.datums[0].length === 30 && x.vraag.datums[1].length === 5 && u.ok, x.vraag.datums.map(a => a.length));
  // review MOET 2: 35 stil → hooguit 5 in de regel, alleen die 5 als gemeld; volgende week de volgende 5
  for (let i = 0; i < 35; i++) DATUMS['316100000' + String(i).padStart(2, '0') + '@c.us'] = '2026-08-01';
  const sp2 = path.join(d, 'cr3', 'staat.json');
  x = maak({ ringTekst: async () => ring2, staatPad: sp2 }); u = await x.k.doe({ ams: ZO });
  let gem = Object.values(JSON.parse(fs.readFileSync(sp2, 'utf8')).personen).filter(p => p.gemeld_op).length;
  const n1 = (x.buf[0][1].match(/P\d+/g) || []).length;
  toets('35 stil: 5 in de regel (≤ 400 tekens, niet afgekapt), 5 als gemeld, 30 wachten', n1 === 5 && x.buf[0][1].length <= 400 && !/…/.test(x.buf[0][1]) && gem === 5 && u.detail.wacht === 30, [n1, gem, u.detail, x.buf[0][1].length]);
  x = maak({ ringTekst: async () => ring2, staatPad: sp2 }); u = await x.k.doe({ ams: { datum: '2026-11-22', uur: 6, min: 40 } });
  gem = Object.values(JSON.parse(fs.readFileSync(sp2, 'utf8')).personen).filter(p => p.gemeld_op).length;
  toets('week erna: de volgende 5 (andere namen), 10 als gemeld', x.buf.length === 1 && gem === 10 && u.detail.stil === 5, [gem, u.detail]);
  toets('kies: lange namen → minder personen, nooit boven 400', (() => { const s = Array.from({ length: 5 }, (_, i) => ({ voornaam: 'X'.repeat(90) + i, weken: 9 })); const k = C._intern.kies(s, []); return k.tekst.length <= 400 && k.stil.length < 5 && k.stil.length > 0; })());
  // review ZOU 1: toekomstige of onechte datum telt niet en wekt geen melding op een oude opgeslagen datum
  toets('isDatum: 2026-02-30 en vrije tekst niet', !C._intern.isDatum('2026-02-30') && !C._intern.isDatum('gisteren') && C._intern.isDatum('2026-02-28'));
  const sp4 = path.join(d, 'cr4', 'staat.json'); fs.mkdirSync(path.dirname(sp4), { recursive: true });
  fs.writeFileSync(sp4, JSON.stringify({ personen: { '20_Prive/Nep/Persoon 0': { laatst_gezien: '2026-01-01', gemeld_op: null, jarig_jaar: null } } }));
  x = maak({ ringTekst: async () => '## Ring 1\n### Overig ring 1\n- [[20_Prive/Nep/Persoon 0|P0]]\n', staatPad: sp4, datums: async (ids) => ({ datums: { [ids[0]]: '2027-05-01' } }) });
  u = await x.k.doe({ ams: ZO });
  toets('toekomstige datum: blind, geen melding op de oude opgeslagen datum', x.buf.length === 0 && u.detail.blind === 1 && u.detail.stil === 0, [u, x.buf]);

  // 10. verjaardag zonder jaar ('--MM-DD') en over de jaargrens
  toets('verjaardag --01-03 vanaf 28-12 → volgend jaar', C._intern.volgendeJarig('--01-03', '2026-12-28') === '2027-01-03');
  toets('verjaardag vandaag telt', C._intern.volgendeJarig('1970-11-15', '2026-11-15') === '2026-11-15');

  // 11. server.js: stap in de keten na weer-ochtend, module via webhooks uit de workflow (geen pad in de code), geen nummer in een log
  const sv = fs.readFileSync('server.js', 'utf8');
  toets('server.js: stap contactringen na weer-ochtend, in-proces, 5 min', /naam: 'contactringen', start_na: \[6, 40\], na: \['weer-ochtend'\], limiet_min: 5, pogingen: 2, inProces: true/.test(sv));
  toets('server.js: datumvraag alleen met datums_voor en sessie nl', /datums: function \(ids\) \{ return crPost\(CR_WA_WF, null, 'crWaUrl', process\.env\.N8N_WEBHOOK_WHATSAPP, \{ sessie: 'nl', datums_voor: ids \}\); \}/.test(sv));
  toets('server.js: bron contactringen in ochtend_buffer, teruggelezen', /bron: 'contactringen', datum: datum, tekst: tekst/.test(sv) && /rij na het schrijven niet teruggelezen/.test(sv));

  // 12. kruisproef: een nummer in de regel moet de nummertoets rood maken
  toets('kruisproef nummertoets: een nummer wordt gezien', NR.test('met 31600000101 is'));

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  fs.rmSync(d, { recursive: true, force: true });
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
