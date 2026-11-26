#!/usr/bin/env bash
# Toetst de nachtketenstap promedico-botsingen (wv3145, fase 2 "Agenda-Wachter", bouwplan "Promedico-agenda meelezen" § F2.4 punt 1–9):
# geen HIS- of Google-tekst op pagina/buffer/register/log/health (tekstfilter), spiegel niet van vannacht = niet beoordeelbaar zonder rij,
# oud/niet gezien/dagblik, alleen a/b zeker in de bufferrij, drie weekpagina's (vandaag + 13 op de derde, + 14 nergens), nooit twee keer
# (register ná de buffer), één schrijver per bestand (padcontrole aan beide kanten), zelfde invoer = zelfde bytes en mtime, opruimen alleen
# op naampatroon, regelopbouw rond de wissel naar wintertijd, de echte nachtketen met nepklok (ook na een fout van ovis-agenda) en de
# koppeling in server.js/uitrol.sh. Daarna één kruisproef per MOET: dezelfde gevallen op een kopie met die controle uit moeten ROOD worden.
# Alleen verzonnen gegevens; raakt geen echte staat, vault, databank of n8n. Gebruik: bash test/promedico-botsingen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
if grep -nE "console\.|eval\(|child_process|fetch\(" promedico-botsingen.js; then echo "ROOD  promedico-botsingen.js logt zelf of praat met het net"; exit 1; fi
TMPK="$(mktemp -d)"; trap 'rm -rf "$TMPK"' EXIT
node --no-warnings - "$TMPK" <<'JS'
const fs = require('fs'), path = require('path');
const TMPK = process.argv[2];
const VV = require('./vault-veilig.js');
const K = require('./nachtketen.js');
const B = require('./promedico-betekenis.js');
let goed = 0, fouten = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (extra !== undefined && !ok ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

const MERK = ['MERK-OMS-ZQX', 'MERK-PAT-ZQX', 'MERK-NOTITIE-ZQX', 'MERK-TITEL-ZQX'];
const bevatMerk = (t) => MERK.some((m) => String(t).includes(m));
const MAP = path.join('10_Zakelijk', 'Tolgaarde', 'Promedico-agenda');
const Z = (iso) => Date.parse(iso);
const S = (van, tot, soort) => ({ van, tot, soort: soort || 'consult', kleur: '#3366FF' });
const P = (van, tot, o) => Object.assign({ van, tot, soort: 'consult', kleur: '#3366FF', patient: true, omschrijving: MERK[1] }, o || {});
const Bl = (van, tot, soort, o) => Object.assign({ van, tot, soort, kleur: '#884488', patient: false }, o || {});
const dag = (gezienMs, blokken, sjabloon, o) => Object.assign({ gezien_ms: gezienMs, weergave: 'werkweek', periode_van: '2026-11-16', periode_tot: '2026-11-20',
  dag: { sjabloon: sjabloon || [], blokken: blokken || [] } }, o || {});
// Google-spiegelrij zoals sb_kalender_tijdlijn hem geeft (tijden in UTC)
const G = (id, agenda, b, e, o) => Object.assign({ bron_soort: 'google_spiegel', hele_dag: false, begin_tijd: b, eind_tijd: e, event_id: id, sync_agenda: agenda, titel: MERK[3], status: 'actief' }, o || {});

// ── de standaardnacht: vandaag di 17-11-2026 03:36 (CET), spiegel 03:30 van vannacht ──
const NU = Z('2026-11-17T02:36:00Z'), AMS = { datum: '2026-11-17', uur: 3, min: 36 };
const VERS = Z('2026-11-16T13:46:00Z');           // blik ma 16-11 14:46
const STEMPEL = { stand: 'klaar', eind: '2026-11-17T02:30:11.000Z', poging: 1 };
function staatStandaard(vers) {
  vers = vers || VERS;
  return { versie: 2, log: {}, datums: {
    '2026-11-17': Object.assign(dag(vers, [P('09:00', '09:15'), Bl('15:30', '17:00', 'brief_info', { omschrijving: MERK[0] })], [S('08:00', '12:00'), S('13:00', '17:00')]), {}),
    '2026-11-18': dag(vers, [Bl('07:00', '18:30', 'vergadering_overig', { omschrijving: MERK[0] })], [S('08:00', '12:00')]),
    '2026-11-19': dag(vers, [], [S('08:00', '12:00')], { weergave: 'dag' }),
    '2026-11-20': dag(Z('2026-11-12T10:00:00Z'), [], [S('08:00', '12:00')]),
    '2026-11-24': dag(vers, [Bl('14:00', '15:00', 'roze', { omschrijving: 'op de dag' })], [])
  } };
}
function rijenStandaard() {
  return [
    G(101, 'gezin', '2026-11-17T08:00:00Z', '2026-11-17T08:30:00Z'),   // a patiënt geboekt (09:00–09:30)
    G(102, 'david', '2026-11-17T09:00:00Z', '2026-11-17T09:30:00Z'),   // b spreekuur open (10:00–10:30)
    G(103, 'david', '2026-11-17T14:45:00Z', '2026-11-17T15:45:00Z'),   // d afgedekt (15:45–16:45 onder het eigen blok)
    G(104, 'werk', '2026-11-17T10:00:00Z', '2026-11-17T10:30:00Z'),    // Werk: geen botsingregel
    G(105, 'david', '2026-11-17T17:00:00Z', '2026-11-17T18:00:00Z'),   // buiten Promedico-tijd
    G(106, 'david', '2026-11-18T08:00:00Z', '2026-11-18T08:30:00Z'),   // c controleer (dagbreed onbekend)
    G(107, 'david', '2026-11-19T08:00:00Z', '2026-11-19T08:30:00Z'),   // dagblik: open uren niet te bepalen
    G(108, 'gezin', '2026-11-20T08:00:00Z', '2026-11-20T08:30:00Z'),   // oud
    G(109, 'gezin', '2026-11-23T09:00:00Z', '2026-11-23T09:30:00Z'),   // niet gezien
    G(110, 'david', '2026-11-24T13:00:00Z', '2026-11-24T13:30:00Z')    // b waarschijnlijk (alleen 'op de dag')
  ];
}
// omgeving: eigen vault-map, register, spionnen; o.nu/ams/staat/rijen/stempel/bufferFaalt overschrijfbaar
let teller = 0;
function omgeving(M, o) {
  o = o || {};
  const root = path.join(TMPK, 'o' + (++teller)); const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, MAP), { recursive: true });
  const e = { root, vault, mapAbs: path.join(vault, MAP), registerPad: path.join(root, 'pa', 'gemeld.json'), buffer: [], log: [], tijdlijnRoep: 0,
    staat: o.staat === undefined ? staatStandaard() : o.staat, rijen: o.rijen || rijenStandaard(), stempel: o.stempel === undefined ? STEMPEL : o.stempel,
    bufferFaalt: false, nu: o.nu || NU, ams: o.ams || AMS };
  e.m = M.maak({ vault, registerPad: e.registerPad,
    leesStaat: () => (e.staat === null ? null : typeof e.staat === 'string' ? e.staat : JSON.stringify(e.staat)),
    tijdlijn: async () => { e.tijdlijnRoep++; return e.rijen; },
    spiegelStempel: (d) => (typeof e.stempel === 'function' ? e.stempel(d) : e.stempel),
    bufferZet: async (datum, tekst) => { if (e.bufferFaalt) throw new Error('n8n 500'); e.buffer.push({ datum, tekst }); },
    vv: { lees: (p) => VV.lees(p, 'utf8', { max: 400000 }), schrijf: (p, t) => VV.schrijf(p, t), wegAlsGelijk: (p, s) => VV.wegAlsGelijk(p, s) },
    lijst: (m) => fs.readdirSync(m), log: (x) => e.log.push(x), nu: () => e.nu });
  e.doe = () => e.m.doe({ ams: e.ams });
  e.paginas = () => fs.readdirSync(e.mapAbs).filter((n) => / - botsingen\.md$/.test(n)).sort();
  e.pagina = (w) => fs.readFileSync(path.join(e.mapAbs, 'Promedico-agenda ' + w + ' - botsingen.md'), 'utf8');
  e.alles = () => e.paginas().map((n) => fs.readFileSync(path.join(e.mapAbs, n), 'utf8')).join('\n');
  e.register = () => { try { return fs.readFileSync(e.registerPad, 'utf8'); } catch (x) { return null; } };
  return e;
}

// ── De gevallen. Elk geval krijgt de module M (en de ontvangermodule A) en geeft true als het gedrag klopt. ──
const geval = {};
geval.p1_geen_tekst = async (M) => {
  const e = omgeving(M); e.staat.datums['2026-11-17'].dag.dagnotitie = MERK[2];
  const r = await e.doe();
  const overal = [e.alles(), JSON.stringify(e.buffer), e.register(), JSON.stringify(r), JSON.stringify(e.log), JSON.stringify(e.m.info())].join('\n');
  return r.ok === true && e.paginas().length === 3 && e.buffer.length === 1 && !bevatMerk(overal) && !/patiënten|\b\d+ patiënt/.test(e.alles());
};
geval.p1_tekstfilter_weigert = async (M) => {
  let weg = 0;
  for (const t of ['- Jij · event 1 · 10:00–11:00 · a patiënt geboekt · zeker · regel patient ' + MERK[0], '- notitie: ' + MERK[2], '## di 17-11 2026-11-17 ' + MERK[3]]) {
    try { M.tekstfilter(t, M.GRAMMATICA); } catch (x) { if (x.tekstfilter) weg++; }
  }
  try { M.tekstfilter('Promedico-agenda, zekere botsing(en) met je agenda:\n- di 17-11 10:00–10:30 (je agenda): ' + MERK[3], M.MELD_GRAMMATICA); } catch (x) { if (x.tekstfilter) weg++; }
  let goedDoor = true; try { M.tekstfilter('- Jij · event 1 · 10:00–11:00 · a patiënt geboekt · zeker · regel patient', M.GRAMMATICA); } catch (x) { goedDoor = false; }
  return weg === 4 && goedDoor;
};
geval.p2_spiegel_niet_van_vannacht = async (M) => {
  const varianten = [{ stand: 'fout', eind: STEMPEL.eind }, null, { stand: 'overgeslagen', reden: 'te-laat' }, { stand: 'klaar', eind: '2026-11-16T02:30:00Z' },
    { stand: 'klaar', eind: STEMPEL.eind, al_gedaan: true, detail: { niet_in_release: true } }, { stand: 'opnieuw', eind: STEMPEL.eind }];
  for (const st of varianten) {
    const e = omgeving(M, { stempel: st });
    const r = await e.doe();
    const t = e.alles();
    const dagen = t.match(/^## /gm) || [], nb = t.match(/^- status: .*spiegel niet van vannacht$/gm) || [];
    if (!(r.ok && e.buffer.length === 0 && e.tijdlijnRoep === 0 && dagen.length === 14 && nb.length === 14 && /spiegel_op: niet van vannacht/.test(t) &&
      !/event \d+ · /.test(t) && Object.values(r.detail.per_uitkomst).every((n) => n === 0) && r.detail.spiegel === false)) return false;
  }
  return true;
};
geval.p3_oud_niet_gezien_dagblik = async (M) => {
  const e = omgeving(M); const r = await e.doe(); const t = e.pagina('2026-W47'), t2 = e.pagina('2026-W48');
  return r.ok && /## vr 20-11 2026-11-20\n- status: gezien 2026-11-12T11:00:00\+01:00 \(werkweek\) · oud\n- Gezin · event 108 · 09:00–09:30 · niet beoordeelbaar: oud · — · regel nb/.test(t) &&
    /## do 19-11 2026-11-19\n- status: gezien 2026-11-16T14:46:00\+01:00 \(dag\) · open uren niet te bepalen\n- Jij · event 107 · 09:00–09:30 · niet beoordeelbaar: open uren niet te bepalen/.test(t) &&
    /## ma 23-11 2026-11-23\n- status: niet gezien\n- Gezin · event 109 · 10:00–10:30 · niet beoordeelbaar: niet gezien · — · regel nb/.test(t2) &&
    /## za 21-11 2026-11-21\n- status: niet gezien\n- geen afspraken/.test(t) && !/vrij/i.test(t.replace('nooit "vrij"', '')) && !e.buffer.some((b) => /20-11|19-11|23-11/.test(b.tekst));
};
geval.p4_alleen_a_b_zeker = async (M) => {
  const e = omgeving(M); const r = await e.doe(); const t = e.pagina('2026-W47') + e.pagina('2026-W48');
  const regels = e.buffer.length === 1 ? e.buffer[0].tekst.split('\n') : [];
  return r.ok && e.buffer.length === 1 && e.buffer[0].datum === '2026-11-17' && regels.length === 3 &&
    regels[0] === 'Promedico-agenda, zekere botsing(en) met je agenda:' &&
    regels[1] === '- di 17-11 09:00–09:30 (Gezin-agenda): er staat een patiënt geboekt — Promedico gezien ma 16-11 14:46' &&
    regels[2] === '- di 17-11 10:00–10:30 (je agenda): Promedico-spreekuur staat open 10:00–10:30 — Promedico gezien ma 16-11 14:46' &&
    /event 103 · 15:45–16:45 · d afgedekt · zeker/.test(t) && /event 106 · 09:00–09:30 · c controleer · onzeker/.test(t) && /event 110 · 14:00–14:30 · b spreekuur open 14:00–14:30 · waarschijnlijk/.test(t) &&
    /event 105 · 18:00–19:00 · buiten Promedico-tijd/.test(t) && !/event 104/.test(t) && r.detail.gemeld === 2 && r.detail.per_uitkomst.a === 1 && r.detail.per_uitkomst.b === 2;
};
geval.p4_meer_dan_vijf = async (M) => {
  const st = staatStandaard(); const rijen = [];
  for (let i = 0; i < 7; i++) rijen.push(G(200 + i, 'david', '2026-11-17T' + String(7 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00') + ':00Z', '2026-11-17T' + String(7 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '45' : '15') + ':00Z'));
  st.datums['2026-11-17'].dag.blokken = []; const e = omgeving(M, { staat: st, rijen });
  const r = await e.doe(); const regels = e.buffer[0] ? e.buffer[0].tekst.split('\n') : [];
  const r2 = await e.doe();
  return r.ok && regels.length === 7 && regels[6] === "- en 2 andere (zie de botsingenpagina's)" && r.detail.gemeld === 5 && e.buffer.length === 2 && e.buffer[1].tekst.split('\n').length === 3 && r2.detail.gemeld === 2;
};
geval.p5_drie_weken = async (M) => {
  for (const [vandaag, weken, plus13, plus14] of [['2026-11-17', ['2026-W47', '2026-W48', '2026-W49'], '2026-11-30', '2026-12-01'],
    ['2026-11-18', ['2026-W47', '2026-W48', '2026-W49'], '2026-12-01', '2026-12-02'], ['2026-11-22', ['2026-W47', '2026-W48', '2026-W49'], '2026-12-05', '2026-12-06'],
    ['2026-12-28', ['2026-W53', '2027-W01', '2027-W02'], '2027-01-10', '2027-01-11']]) {
    const nu = Z(vandaag + 'T02:36:00Z'), vers = nu - 12 * 3600000;
    const st = { versie: 2, log: {}, datums: {} };
    st.datums[plus13] = dag(vers, [], [S('08:00', '12:00')]); st.datums[plus14] = dag(vers, [], [S('08:00', '12:00')]);
    const rijen = [G(301, 'david', plus13 + 'T08:00:00Z', plus13 + 'T08:30:00Z'), G(302, 'david', plus14 + 'T08:00:00Z', plus14 + 'T08:30:00Z')];
    const e = omgeving(M, { staat: st, rijen, nu, ams: { datum: vandaag, uur: 3, min: 36 }, stempel: { stand: 'klaar', eind: vandaag + 'T02:30:00Z' } });
    const r = await e.doe();
    const namen = weken.map((w) => 'Promedico-agenda ' + w + ' - botsingen.md');
    if (!(r.ok && JSON.stringify(e.paginas()) === JSON.stringify(namen.slice().sort()) && e.pagina(B.isoWeek(plus13)).includes('event 301 · 09:00–09:30 · b spreekuur open') && (vandaag === '2026-12-28' || B.isoWeek(plus13) === weken[2]) &&
      !e.alles().includes('event 302') && !e.alles().includes(plus14) && e.buffer.length === 1 && e.buffer[0].tekst.split('\n').length === 2 &&
      e.buffer[0].tekst.includes(M.kortDag(plus13) + ' 09:00–09:30'))) return false;
  }
  return true;
};
geval.p6_nooit_twee_keer = async (M) => {
  const e = omgeving(M);
  const r1 = await e.doe(); const n1 = e.buffer.length;
  const e2 = omgeving(M);   // zelfde invoer nog eens (ook een volgende nacht met dezelfde blik) = geen nieuwe rij
  await e2.doe(); const reg1 = e2.register();
  await e2.doe();
  const tweede = e2.buffer.length;                       // zelfde nacht/invoer nog eens: geen nieuwe rij
  e2.staat = staatStandaard(VERS + 3600000);            // nieuwere blik, zelfde botsingen → één keer opnieuw
  await e2.doe();
  const derde = e2.buffer.length;
  // buffer faalt: ok:false, register ongewijzigd; herhaling meldt alsnog
  const e3 = omgeving(M); e3.bufferFaalt = true;
  const f = await e3.doe(); const regNaFout = e3.register();
  e3.bufferFaalt = false; const h = await e3.doe();
  return r1.ok && n1 === 1 && tweede === 1 && derde === 2 && f.ok === false && f.reden === 'buffer niet gezet' && regNaFout === null &&
    h.ok && e3.buffer.length === 1 && h.detail.gemeld === 2 && JSON.parse(e3.register()).gemeld && Object.keys(JSON.parse(e3.register()).gemeld).length === 2 && !!reg1;
};
geval.p6_register_opruimen = async (M) => {
  const e = omgeving(M); fs.mkdirSync(path.dirname(e.registerPad), { recursive: true, mode: 0o700 });
  fs.writeFileSync(e.registerPad, JSON.stringify({ versie: 1, gemeld: { 'oud|1': '2026-11-09', 'grens|2': '2026-11-10', 'nieuw|3': '2026-11-16' } }));
  const r = await e.doe(); const g = JSON.parse(e.register()).gemeld;
  return r.ok && !('oud|1' in g) && ('grens|2' in g) && ('nieuw|3' in g) && (fs.statSync(e.registerPad).mode & 0o777) === 0o600;
};
geval.p7_een_schrijver = async (M, A) => {
  const e = omgeving(M);
  const week = path.join(e.mapAbs, 'Promedico-agenda 2026-W47.md'); fs.writeFileSync(week, 'weekpagina van de ontvanger\n'); fs.utimesSync(week, 1700000000, 1700000000);
  const oud = (n) => { const p = path.join(e.mapAbs, n); fs.writeFileSync(p, 'x\n'); return p; };
  const weg = oud('Promedico-agenda 2026-W37 - botsingen.md'), blijftWeek = oud('Promedico-agenda 2026-W37.md'), blijftKopie = oud('Promedico-agenda 2026-W30 - botsingen kopie.md'),
    blijftRecent = oud('Promedico-agenda 2026-W39 - botsingen.md');
  const r = await e.doe();
  const p = path.join(e.mapAbs, 'Promedico-agenda 2026-W47 - botsingen.md'); fs.utimesSync(p, 1700000000, 1700000000);
  const voor = fs.readFileSync(p); await e.doe(); const na = fs.readFileSync(p);
  let weigert = 0;
  for (const w of ['2026-W47 x', '../2026-W47', '2026-W47.md', '', null]) { try { M.botsingenNaam(w); } catch (x) { weigert++; } }
  for (const w of ['2026-W47 - botsingen', '2026-W47 x', '../2026-W47', '']) { try { A.weekPaginaNaam(w); } catch (x) { weigert++; } }
  return r.ok && fs.readFileSync(week, 'utf8') === 'weekpagina van de ontvanger\n' && fs.statSync(week).mtimeMs === 1700000000000 &&
    voor.equals(na) && fs.statSync(p).mtimeMs === 1700000000000 && r.detail.geschreven === 3 &&
    !fs.existsSync(weg) && fs.existsSync(blijftWeek) && fs.existsSync(blijftKopie) && fs.existsSync(blijftRecent) && r.detail.opgeruimd === 1 &&
    weigert === 9 && M.botsingenNaam('2026-W47') === 'Promedico-agenda 2026-W47 - botsingen.md' && A.weekPaginaNaam('2026-W47') === 'Promedico-agenda 2026-W47.md';
};
geval.p8_wintertijd = async (M) => {
  // vandaag zo 25-10-2026 03:36 CET (de klok ging om 03:00 CEST terug naar 02:00); blik om 02:30 CET (01:30Z) en één om 01:30 CEST (23:30Z ervoor)
  const nu = Z('2026-10-25T02:36:00Z');
  const st = { versie: 2, log: {}, datums: { '2026-10-26': dag(Z('2026-10-25T01:30:00Z'), [], [S('15:00', '17:00')]), '2026-10-27': dag(Z('2026-10-24T23:30:00Z'), [P('09:00', '09:15')], [S('08:00', '12:00')]) } };
  const rijen = [G(401, 'david', '2026-10-26T14:00:00Z', '2026-10-26T15:00:00Z'), G(402, 'gezin', '2026-10-27T07:45:00Z', '2026-10-27T08:15:00Z')];
  const e = omgeving(M, { staat: st, rijen, nu, ams: { datum: '2026-10-25', uur: 3, min: 36 }, stempel: { stand: 'klaar', eind: '2026-10-25T02:30:00Z' } });
  const r = await e.doe(); const regels = e.buffer[0] ? e.buffer[0].tekst.split('\n') : []; const t = e.alles();
  return r.ok && regels[1] === '- ma 26-10 15:00–16:00 (je agenda): Promedico-spreekuur staat open 15:00–16:00 — Promedico gezien zo 25-10 02:30' &&
    regels[2] === '- di 27-10 08:45–09:15 (Gezin-agenda): er staat een patiënt geboekt — Promedico gezien zo 25-10 01:30' &&
    /berekend_op: 2026-10-25T03:36:00\+01:00/.test(t) && /spiegel_op: 2026-10-25T03:30:00\+01:00/.test(t) &&
    /status: gezien 2026-10-25T02:30:00\+01:00/.test(t) && /status: gezien 2026-10-25T01:30:00\+02:00/.test(t) && M.isoLokaal(Z('2026-07-01T10:00:00Z')) === '2026-07-01T12:00:00+02:00';
};
geval.p8_fouten = async (M) => {
  const e = omgeving(M, { staat: '{kapot' }); const r = await e.doe();
  const e2 = omgeving(M); e2.rijen = null; const r2 = await e2.doe();
  const e3 = omgeving(M, { staat: null }); const r3 = await e3.doe();
  return r.ok === false && r.reden === 'staat onleesbaar' && e.paginas().length === 0 && e.buffer.length === 0 &&
    r2.ok === false && r2.reden === 'tijdlijn onleesbaar' && r3.ok === true && /- status: niet gezien/.test(e3.alles()) && e3.buffer.length === 0;
};
geval.p8_health_log_aantallen = async (M) => {
  const e = omgeving(M); await e.doe(); const i = e.m.info();
  const toegestaan = ['aan', 'op', 'datum', 'spiegel', 'weken', 'dagen', 'gezien', 'per_uitkomst', 'zeker', 'nieuw', 'gemeld', 'ms', 'geschreven', 'opgeruimd', 'te_laat'];
  const lg = JSON.stringify(e.log);
  return Object.keys(i).every((k) => toegestaan.includes(k)) && i.weken === 3 && i.gemeld === 2 && i.per_uitkomst.a === 1 &&
    !/\d{2}:\d{2}–|event|10[1-9]\b/.test(JSON.stringify(i).replace(/"op":"[^"]*"/, '')) && !/\d{2}:\d{2}|event|\b10[1-9]\b|MERK/.test(lg) && e.log.length === 1;
};
geval.p8_te_laat = async (M) => {
  const e = omgeving(M, { ams: { datum: '2026-11-17', uur: 7, min: 0 }, nu: Z('2026-11-17T06:00:00Z') }); const r = await e.doe();
  return r.ok && e.buffer.length === 0 && r.detail.te_laat === true && Object.keys(JSON.parse(e.register()).gemeld).length === 0;
};
geval.p9_keten = async (M) => {
  // echte nachtketen.js met nepklok: ovis-agenda (fout of goed) → promedico-botsingen, stempel uit de staat van de keten zelf
  const uit = [];
  for (const agendaOk of [false, true]) {
    const map = path.join(TMPK, 'keten-' + agendaOk); let ms = Z('2026-11-17T02:30:00Z'), klok = { datum: '2026-11-17', uur: 3, min: 30 };
    const e = omgeving(M, { stempel: (d) => { try { return JSON.parse(fs.readFileSync(path.join(map, d + '.json'), 'utf8')).stappen['ovis-agenda'] || null; } catch (x) { return null; } } });
    const stappen = [{ naam: 'ovis-agenda', start_na: [3, 30], limiet_min: 7, pogingen: 1, meldtZelf: true, doe: async () => (agendaOk ? { ok: true, detail: { ms: 5 } } : { ok: false, reden: 'exit 1' }) },
      { naam: 'promedico-botsingen', start_na: [3, 35], na: ['ovis-agenda'], limiet_min: 3, pogingen: 2, inProces: true, meldtZelf: false, doe: async (c) => { e.nu = ms; return e.m.doe({ ams: c.ams }); } }];
    const box = [];
    const k = K.maak({ staatMap: map, stappen, nu: () => ms, ams: () => Object.assign({ klok: '' }, klok), log: () => {}, fout: () => {}, boxRij: (s) => box.push(s), procLeeft: () => false, procStart: () => '1', boot: 'b' });
    const tik = async (n) => { for (let i = 0; i < n; i++) { await k.tik(); await new Promise((r) => setTimeout(r, 20)); } };
    await tik(2); const naAgenda = e.paginas().length;
    klok = { datum: '2026-11-17', uur: 3, min: 35 }; ms = Z('2026-11-17T02:35:00Z'); await tik(3);
    const s = k._lees('2026-11-17');
    uit.push({ agendaOk, naAgenda, stand: s.stappen['promedico-botsingen'] && s.stappen['promedico-botsingen'].stand, agenda: s.stappen['ovis-agenda'].stand, paginas: e.paginas().length,
      nb: (e.alles().match(/spiegel niet van vannacht$/gm) || []).length, buffer: e.buffer.length, afgesloten: !!s.afgesloten, box: box.length });
  }
  const [f, g] = uit;
  return f.naAgenda === 0 && f.agenda === 'fout' && f.stand === 'klaar' && f.paginas === 3 && f.nb === 14 && f.buffer === 0 &&
    g.agenda === 'klaar' && g.stand === 'klaar' && g.paginas === 3 && g.nb === 0 && g.buffer === 1 && g.afgesloten;
};

(async function () {
  const M = require('./promedico-botsingen.js'), A = require('./promedico-agenda.js');
  for (const n of Object.keys(geval)) {
    let ok = false, x;
    try { ok = await geval[n](M, A); } catch (e) { x = String(e && e.stack || e).slice(0, 300); }
    toets(n, ok, x);
  }

  // ── koppeling in server.js en uitrol.sh ──
  const sv = fs.readFileSync('server.js', 'utf8'), us = fs.readFileSync('uitrol.sh', 'utf8');
  const iAg = sv.indexOf("{ naam: 'ovis-agenda', start_na: [3, 30]"), iPb = sv.indexOf("{ naam: 'promedico-botsingen', start_na: [3, 35], na: ['ovis-agenda'], limiet_min: 3, pogingen: 2, inProces: true, meldtZelf: false,"), iDl = sv.indexOf("{ naam: 'ovis-deadlines', start_na");
  toets('server.js: stap promedico-botsingen 03:35 ná ovis-agenda (inProces, limiet 3, pogingen 2, meldtZelf false), vóór deadlines', iAg > 0 && iPb > iAg && iDl > iPb);
  toets('server.js: stempel = ovis-agenda uit de nachtketenstaat van die datum', /spiegelStempel: function \(datum\) \{\s*try \{ const s = JSON\.parse\(fs\.readFileSync\(path\.join\(NACHTKETEN_DIR, datum \+ '\.json'\), 'utf8'\)\); return s && s\.stappen && s\.stappen\['ovis-agenda'\] \|\| null; \}/.test(sv));
  toets('server.js: bufferrij bron promedico (upsert + teruglezen), register in PROMEDICO_AGENDA_DIR/gemeld.json', /const PB_FILTER = \{ type: 'and', filters: \[\{ columnName: 'bron', condition: 'eq', value: 'promedico' \}\] \};/.test(sv) && /bufferZet: promedicoRijZet/.test(sv) && /registerPad: path\.join\(dir, 'gemeld\.json'\)/.test(sv) && /rij na het schrijven niet teruggelezen/.test(sv.slice(sv.indexOf('async function promedicoRijZet'))));
  toets('server.js: vault alleen via vault-veilig (lees/schrijf/wegAlsGelijk)', /vv: \{ lees: function \(q\) \{ return VV\(\)\.lees\(q, 'utf8', \{ max: 400000 \}\); \}, schrijf: function \(q, inhoud\) \{ return VV\(\)\.schrijf\(q, inhoud\); \},\s*wegAlsGelijk: function \(q, sha\) \{ return VV\(\)\.wegAlsGelijk\(q, sha\); \} \}/.test(sv));
  toets('server.js: /health.promedico_agenda.botsingen', /botsingen: typeof promedicoBotsingenInfo === 'function' \? promedicoBotsingenInfo\(\) : \{ aan: false \}/.test(sv));
  toets('uitrol.sh: promedico-botsingen.js in de release (optioneel)', /RELEASE_OPTIONEEL="[^"]*\bpromedico-botsingen\.js\b/.test(us));
  toets('promedico-agenda.js: de ontvanger schrijft via weekPaginaNaam (padcontrole)', /o\.vv\.schrijf\(path\.join\(mapAbs, weekPaginaNaam\(week\)\), maakPagina\(staat, week\)\)/.test(fs.readFileSync('promedico-agenda.js', 'utf8')));

  // ── kruisproeven: één per MOET; de gevallen moeten op een kopie met die controle uit ROOD worden ──
  function kopie(naam, ingrepen, bestand) {
    bestand = bestand || 'promedico-botsingen.js';
    const d = path.join(TMPK, 'kp-' + naam); fs.mkdirSync(d, { recursive: true });
    for (const f of ['promedico-botsingen.js', 'promedico-betekenis.js', 'promedico-woorden.json', 'promedico-agenda.js']) fs.copyFileSync(f, path.join(d, f));
    let s = fs.readFileSync(path.join(d, bestand), 'utf8');
    for (const [van, naar] of ingrepen) { if (!s.includes(van)) throw new Error('kruisproef ' + naam + ': ingreep niet gevonden: ' + van.slice(0, 60)); s = s.split(van).join(naar); }
    fs.writeFileSync(path.join(d, bestand), s);
    return { M: require(path.join(d, 'promedico-botsingen.js')), A: require(path.join(d, 'promedico-agenda.js')) };
  }
  const KP = [
    ['tekstfilter', [['function tekstfilter(tekst, grammatica) {', 'function tekstfilter(tekst, grammatica) { return tekst;'],
      ["r.push('', '## ' + kortDag(datum) + ' ' + datum, '- status: ' + dagStatus(d.dag, o.spiegelOk));", "r.push('', '## ' + kortDag(datum) + ' ' + datum, '- status: ' + dagStatus(d.dag, o.spiegelOk)); if (d.dag.dagnotitie) r.push('- notitie: ' + d.dag.dagnotitie);"]],
      ['p1_geen_tekst', 'p1_tekstfilter_weigert']],
    ['spiegelcontrole', [['const spiegelOk = !!(', 'const spiegelOk = true || !!(']], ['p2_spiegel_niet_van_vannacht', 'p9_keten']],
    ['zekerheidsfilter', [["(b.uitkomst === 'a' || b.uitkomst === 'b') && b.zekerheid === 'zeker'", "(b.uitkomst === 'a' || b.uitkomst === 'b')"]], ['p4_alleen_a_b_zeker']],
    ['drie-weken', [['const WEKEN = 3;', 'const WEKEN = 2;']], ['p5_drie_weken']],
    ['register-na-buffer', [["try { await o.bufferZet(vandaag, tekst); } catch (e) { return fout('buffer niet gezet'); }",
      "for (const b of toon) reg.gemeld[sleutel(b, b.gezien_ms)] = b.datum; registerZet(reg); try { await o.bufferZet(vandaag, tekst); } catch (e) { return fout('buffer niet gezet'); }"]], ['p6_nooit_twee_keer']],
    ['padcontrole-botsingen', [["if (typeof week !== 'string' || !WEEK_RE.test(week)) throw new Error('padcontrole: geen weeknaam');", ''], ["if (!BOTS_NAAM_RE.test(n)) throw new Error('padcontrole: naam');", '']], ['p7_een_schrijver']],
    ['padcontrole-ontvanger', [["if (typeof week !== 'string' || !/^\\d{4}-W\\d{2}$/.test(week)) throw new Error('padcontrole: geen weeknaam');", ''], ["if (!/^Promedico-agenda \\d{4}-W\\d{2}\\.md$/.test(n)) throw new Error('padcontrole: naam');", '']], ['p7_een_schrijver'], 'promedico-agenda.js'],
    ['oud-geen-melding', [["&& !b.oud && Number.isFinite(b.gezien_ms)", "&& Number.isFinite(b.gezien_ms)"]], []]
  ];
  for (const [naam, ingrepen, gevallen, bestand] of KP) {
    if (!gevallen.length) continue;   // oud wordt al in betekenDag 'niet beoordeelbaar' (zie p3); deze ingreep is alleen een tweede slot
    let k;
    try { k = kopie(naam, ingrepen, bestand); } catch (e) { toets('kruisproef ' + naam + ': kopie te maken', false, String(e.message)); continue; }
    let rood = 0;
    for (const g of gevallen) { let ok = false; try { ok = await geval[g](k.M, k.A); } catch (e) { ok = false; } if (!ok) rood++; }
    toets('kruisproef ' + naam + ': rood (' + rood + '/' + gevallen.length + ')', rood === gevallen.length);
  }

  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
