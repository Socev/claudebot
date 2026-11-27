'use strict';
// Toets van tabula-overlegblad.js (wv4240, L57: het overlegblad ligt al klaar). Verzonnen agenda, verzonnen actiepunten, verzonnen
// voorbereiding in een tijdelijke vault; nep-loket (geen netwerk). Draai: node test/tabula-overlegblad.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require(path.join(__dirname, '..', 'tabula-overlegblad.js'));
const K = M.K;

let fouten = 0, goed = 0;
async function toets(naam, f) {
  try { await f(); goed++; console.log('OK   ' + naam); } catch (e) { fouten++; console.log('FAIL ' + naam + ': ' + (e && e.message)); }
}

// nu = vr 27-11-2026 10:00 NL (09:00 UTC)
const NU = Date.parse('2026-11-27T09:00:00Z');
const rij = (agenda, titel, begin, extra) => Object.assign({ bron_soort: 'google_spiegel', sync_agenda: agenda, feed: 'google-' + agenda, soort: 'afspraak', status: 'actief', hele_dag: false, titel, begin_tijd: begin, eind_tijd: null }, extra || {});
const TIJDLIJN = [
  rij('hagro', 'HAGRO-vergadering', '2026-11-28T15:00:00+00:00', { eind_tijd: '2026-11-28T17:00:00+00:00' }),
  rij('david', 'HAGRO', '2026-11-28T15:00:00+00:00'),                       // zelfde overleg in een tweede agenda
  rij('werk', 'Maatschapsvergadering', '2026-11-27T19:00:00+00:00'),
  rij('werk', 'Werkoverleg Tolgaarde', '2026-11-28T07:30:00+00:00'),
  rij('david', 'Borrel POH GGZ', '2026-11-27T16:00:00+00:00'),              // geen overleg
  rij('hagro', 'Hagro meets Lariks', '2026-11-27T12:00:00+00:00'),         // uitgesloten
  rij('werk', 'Driehoeksoverleg Hamersveld', '2026-11-29T10:45:00+00:00'),  // later dan 24 u
  rij('werk', 'Artsenoverleg', '2026-11-27T08:00:00+00:00'),                // al begonnen
  rij('werk', 'Maatschap hele dag', '2026-11-27', { hele_dag: true, begin_tijd: null }),
  Object.assign(rij('werk', 'Maatschap uit ical', '2026-11-27T20:00:00+00:00'), { bron_soort: 'ical_feed' }),
  { sb_kalender_tijdlijn: rij('werk', 'POT-overleg POH-GGZ', '2026-11-28T06:00:00+00:00') },   // verpakte rij zoals PostgREST hem soms geeft
];
const ACTIES = [
  { actie_id: 'a1', entiteit: 'HAGRO', status: 'open', actie: 'Data HAGRO 2027 rondsturen', eigenaar: 'Proefpersoon A', deadline: '2026-12-10', bron: '10_Zakelijk/HAGRO/Notulen/2026-11-19 - HAGRO-vergadering.md' },
  { actie_id: 'a2', entiteit: 'HAGRO', status: 'gemeld', actie: 'Lijst **werkgroepen** bijwerken', eigenaar: 'David', deadline: '', bron: '10_Zakelijk/HAGRO/Notulen/2026-09-10 - HAGRO-vergadering.md' },
  { actie_id: 'a3', entiteit: 'HAGRO', status: 'afgerond', actie: 'Al gedaan', eigenaar: 'David', bron: '10_Zakelijk/HAGRO/Notulen/2026-11-19 - HAGRO-vergadering.md' },
  { actie_id: 'a4', entiteit: 'HAGRO / Lariks', status: 'open', actie: 'Uit WhatsApp, niet uit notulen', eigenaar: 'David', bron: '30_Conversaties/WhatsApp/x.md' },
  { actie_id: 'a5', entiteit: 'Groenhouten', status: 'open', actie: 'Noodbox nalopen', eigenaar: 'Proefpersoon B', bron: '10_Zakelijk/Groenhouten/Notulen/2026-10-14 - Notulen maatschapsvergadering.md (concept)' },
  { actie_id: 'a6', entiteit: 'Groenhouten', status: 'open', actie: 'Werkvloerpunt', eigenaar: 'Proefpersoon C', bron: '10_Zakelijk/Groenhouten/Notulen/2026-10-15 - Werkvloeroverleg.md' },
  { actie_id: 'a7', entiteit: 'Tolgaarde', status: 'open', actie: 'Tolgaarde-punt uit artsenoverleg', eigenaar: 'David', bron: '10_Zakelijk/Tolgaarde/Notulen/2026-09-02 - Notulen Artsenoverleg.md' },
];
const VOORBEREIDING = '---\ntype: gespreksvoorbereiding\n---\n# HAGRO-vergadering — voorbereiding\n\nInleiding.\n\n## Agenda monodisciplinair deel (17:00–18:00)\n\n' +
  '1. Vaststellen agenda, notulen (1 min)\n2. **Update POH-GGZ** — stand van zaken [[10_Zakelijk/HAGRO/POH|POH-GGZ]]\n   - subpunt telt niet\n3. Rondvraag\n\n## Reader\n\n1. Dit is geen agendapunt\n\n' +
  '## Agenda wijkdeel\n\n### 1. Mededelingen\nTekst met\n1. opsomming die niet telt\n### 2. Wijkplan 2027\n';

function vault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4240-vault-'));
  fs.mkdirSync(path.join(v, '10_Zakelijk/HAGRO/Notulen'), { recursive: true });
  fs.mkdirSync(path.join(v, '10_Zakelijk/Groenhouten/Notulen'), { recursive: true });
  fs.writeFileSync(path.join(v, '10_Zakelijk/HAGRO/Notulen/2026-11-28 - HAGRO-vergadering (voorbereiding).md'), VOORBEREIDING);
  fs.writeFileSync(path.join(v, '10_Zakelijk/HAGRO/Notulen/2026-11-19 - HAGRO-vergadering.md'), '## Agenda\n1. Oud\n');
  return v;
}
function nepLoket() {
  const l = { bladen: new Map(), verzoeken: 0, code: 'pod-code-van-ruim-dertig-tekens-1234567' };
  l.fetch = async function (u, opt) {
    l.verzoeken++;
    const url = new URL(u);
    const ant = (status) => ({ status, text: async () => '' });
    if (opt.headers.authorization !== 'Bearer ' + l.code) return ant(401);
    if (url.pathname !== '/blad' || opt.method !== 'POST') return ant(404);
    const b = JSON.parse(opt.body);
    if (!/^overleg-\d{8}-[0-9a-f]{8}$/.test(b.sheet)) return ant(400);
    if (l.bladen.has(b.sheet)) return ant(409);
    l.bladen.set(b.sheet, b.tekst);
    return ant(200);
  };
  return l;
}
function opzet(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv4240-tabula-'));
  fs.writeFileSync(path.join(dir, 'tabula.json'), JSON.stringify({ aan: true }));
  const l = nepLoket(), v = vault(), gevraagd = [];
  const m = M.maak(Object.assign({ dir, vault: v, basis: 'http://nep', fetch: l.fetch, code: async () => l.code, nu: () => NU,
    tijdlijn: async (van, tot) => { gevraagd.push([van, tot]); return TIJDLIJN; }, acties: async () => ACTIES, fout: () => {} }, extra || {}));
  return { dir, l, v, m, gevraagd };
}
const tekstVan = (l, re) => [...l.bladen.values()].find((t) => re.test(t.split('\n')[0]));

(async function () {
  await toets('herkennen: HAGRO, maatschap, werkoverleg met praktijk in de titel, POT; borrel/meets niet', () => {
    const R = K.STANDAARD;
    assert.strictEqual(K.herken('HAGRO-vergadering', R).entiteit, 'HAGRO');
    assert.strictEqual(K.herken('Maatschapsvergadering', R).entiteit, 'Groenhouten');
    const w = K.herken('Werkoverleg Tolgaarde', R);
    assert.strictEqual(w.entiteit, 'Tolgaarde'); assert.strictEqual(w.map, '10_Zakelijk/Tolgaarde/Notulen'); assert.strictEqual(w.plek, 'TG');
    assert.strictEqual(K.herken('Overleg Gemeente POH-Jeugd', R).entiteit, 'POT');
    assert.strictEqual(K.herken('Borrel POH GGZ', R), null);
    assert.strictEqual(K.herken('Hagro meets Lariks', R), null);
    assert.strictEqual(K.herken('Visiteronde Hamersveld', R), null);
    assert.strictEqual(K.herken('Tandarts', R), null);
  });
  await toets('kandidaten: alleen binnen 24 u, gespiegeld, niet hele dag; HAGRO in twee agenda\'s = één (langste titel)', () => {
    const ks = K.kandidaten(TIJDLIJN, K.STANDAARD, NU);
    assert.deepStrictEqual(ks.map((k) => k.titel), ['Maatschapsvergadering', 'POT-overleg POH-GGZ', 'Werkoverleg Tolgaarde']);
    const ks2 = K.kandidaten(TIJDLIJN, K.STANDAARD, NU + 7 * 3600000);   // 17:00 NL: HAGRO (za 16:00) valt nu binnen 24 u
    assert.ok(ks2.some((k) => k.titel === 'HAGRO-vergadering'));
    assert.strictEqual(ks2.filter((k) => k.h.entiteit === 'HAGRO').length, 1);
  });
  await toets('blad-id: deterministisch, pod-reeks, NL-datum', () => {
    const h = K.herken('HAGRO', K.STANDAARD);
    const a = K.bladId(h, '2026-11-28T15:00:00+00:00'), b = K.bladId(K.herken('HAGRO-vergadering', K.STANDAARD), '2026-11-28T15:00:00Z');
    assert.strictEqual(a, b); assert.ok(/^overleg-20261128-[0-9a-f]{8}$/.test(a));
    assert.ok(/^overleg-20261128-/.test(K.bladId(h, '2026-11-27T23:30:00Z')), 'na middernacht NL = volgende dag');
    assert.notStrictEqual(a, K.bladId(h, '2026-11-28T16:00:00Z'));
  });
  await toets('agenda uit een voorbereiding: genummerde punten onder ## Agenda, ### N. als die er zijn; reader telt niet', () => {
    const s = K.agendaUitTekst(VOORBEREIDING);
    assert.strictEqual(s.length, 2);
    assert.deepStrictEqual(s[0].punten, ['Vaststellen agenda, notulen (1 min)', 'Update POH-GGZ — stand van zaken POH-GGZ', 'Rondvraag']);
    assert.deepStrictEqual(s[1].punten, ['Mededelingen', 'Wijkplan 2027']);
  });
  await toets('actiepunten: open/gemeld, uit de notulen van dit overleg, deadline eerst', () => {
    const a = K.actiepunten(ACTIES, K.herken('HAGRO-vergadering', K.STANDAARD));
    assert.deepStrictEqual(a, ['- [ ] Data HAGRO 2027 rondsturen — Proefpersoon A (uiterlijk 10-12)', '- [ ] Lijst werkgroepen bijwerken — David']);
    assert.deepStrictEqual(K.actiepunten(ACTIES, K.herken('Maatschapsvergadering', K.STANDAARD)), ['- [ ] Noodbox nalopen — Proefpersoon B']);
    assert.deepStrictEqual(K.actiepunten(ACTIES, K.herken('Werkoverleg', K.STANDAARD)), ['- [ ] Werkvloerpunt — Proefpersoon C']);
  });
  await toets('ronde: één blad per overleg, met titel, agenda, actiepunten en "Klaargezet door Socev"; register zonder inhoud', async () => {
    const o = opzet({ nu: () => NU + 7 * 3600000 });
    const u = await o.m.ronde();
    assert.strictEqual(u.gezet, 4); assert.strictEqual(o.l.bladen.size, 4);
    const t = tekstVan(o.l, /^# HAGRO-vergadering — za 28 nov 16:00–18:00$/);
    assert.ok(t, 'HAGRO-blad met kop'); const r = t.split('\n');
    assert.strictEqual(r[1], '_Klaargezet door Socev · HAGRO · HAGRO-vergadering_');
    assert.ok(t.includes('### Agenda monodisciplinair deel (17:00–18:00)\n1. Vaststellen agenda, notulen (1 min)\n2. Update POH-GGZ'));
    assert.ok(t.includes('### Agenda wijkdeel\n1. Mededelingen\n2. Wijkplan 2027'));
    assert.ok(t.includes('_Uit de voorbereiding: 2026-11-28 - HAGRO-vergadering (voorbereiding)_'));
    assert.ok(t.includes('## Open actiepunten van vorige keer\n- [ ] Data HAGRO 2027 rondsturen — Proefpersoon A (uiterlijk 10-12)\n- [ ] Lijst werkgroepen bijwerken — David\n'));
    assert.ok(t.endsWith('## Aantekeningen\n- \n'));
    const m = tekstVan(o.l, /^# Maatschapsvergadering — vr 27 nov 20:00$/);
    assert.ok(m.includes('## Agenda\n1. Opening\n2. Notulen en actiepunten vorige keer\n3. Personeel en team'), 'vaste rubrieken zonder voorbereiding');
    assert.ok(m.includes('_Vaste rubrieken: er lag nog geen voorbereide agenda._'));
    assert.ok(m.includes('- [ ] Noodbox nalopen — Proefpersoon B'));
    const w = tekstVan(o.l, /^# Werkoverleg Tolgaarde/);
    assert.ok(w.includes('_Geen open actiepunten uit de vorige notulen gevonden._'));
    const reg = JSON.parse(fs.readFileSync(path.join(o.dir, 'overlegbladen.json'), 'utf8'));
    assert.strictEqual(Object.keys(reg).length, 4);
    const hr = Object.values(reg).find((x) => x.entiteit === 'HAGRO');
    assert.deepStrictEqual(Object.keys(hr).sort(), ['begin', 'door', 'entiteit', 'gezet', 'notulen_map', 'overleg', 'plek']);
    assert.strictEqual(hr.plek, 'HAGRO'); assert.strictEqual(hr.notulen_map, '10_Zakelijk/HAGRO/Notulen');
    assert.ok(!JSON.stringify(reg).includes('Proefpersoon') && !JSON.stringify(reg).includes('HAGRO-vergadering —'), 'register zonder inhoud');
    assert.strictEqual((fs.statSync(path.join(o.dir, 'overlegbladen.json')).mode & 0o777), 0o600);
  });
  await toets('tweede ronde: geen tweede blad en geen verzoek (register); register kwijt: 409 = bestond, nog steeds geen tweede blad', async () => {
    const o = opzet();
    await o.m.ronde(); const n = o.l.bladen.size, v = o.l.verzoeken;
    const u2 = await o.m.ronde();
    assert.strictEqual(o.l.bladen.size, n); assert.strictEqual(o.l.verzoeken, v); assert.strictEqual(u2.gezet, 0);
    fs.unlinkSync(path.join(o.dir, 'overlegbladen.json'));
    const u3 = await o.m.ronde();
    assert.strictEqual(o.l.bladen.size, n); assert.strictEqual(u3.gezet, 0); assert.strictEqual(u3.bestond, n);
    assert.strictEqual(o.m.health().gezet, n); assert.strictEqual(o.m.health().bestond, n);
  });
  await toets('schakelaar: aan false of overlegblad false = niets; niet primair = niets', async () => {
    for (const j of [{ aan: false }, { aan: true, overlegblad: false }]) {
      const o = opzet(); fs.writeFileSync(path.join(o.dir, 'tabula.json'), JSON.stringify(j));
      const u = await o.m.ronde(); assert.strictEqual(u.gedaan, false); assert.strictEqual(o.l.bladen.size, 0); assert.strictEqual(o.gevraagd.length, 0);
    }
    const o = opzet({ primair: () => false });
    assert.strictEqual((await o.m.ronde()).gedaan, false); assert.strictEqual(o.l.bladen.size, 0);
  });
  await toets('actiepunten niet te lezen: blad komt er toch, met die mededeling', async () => {
    const o = opzet({ acties: async () => { throw new Error('n8n weg'); } });
    const u = await o.m.ronde(); assert.strictEqual(u.gezet, 3);
    assert.ok([...o.l.bladen.values()].every((t) => t.includes('_De actiepunten waren nu niet te lezen._')));
  });
  await toets('loket weigert (500): fout geteld, niet in het register, volgende ronde opnieuw', async () => {
    const o = opzet(); const echt = o.l.fetch; let stuk = true;
    o.l.fetch = async (u, opt) => (stuk ? { status: 500, text: async () => '' } : echt(u, opt));
    const m = M.maak({ dir: o.dir, vault: o.v, basis: 'http://nep', fetch: (u, opt) => o.l.fetch(u, opt), code: async () => o.l.code, nu: () => NU, tijdlijn: async () => TIJDLIJN, acties: async () => ACTIES, fout: () => {} });
    const u = await m.ronde(); assert.strictEqual(u.fouten, 3); assert.strictEqual(u.gezet, 0);
    stuk = false; const u2 = await m.ronde(); assert.strictEqual(u2.gezet, 3);
  });
  await toets('regels uit overlegblad.json alleen als ze kloppen (pad buiten 10_Zakelijk/…/Notulen geweigerd)', () => {
    assert.ok(K.regelsGeldig([{ overleg: 'X', re: 'x', entiteit: 'HAGRO', map: '10_Zakelijk/HAGRO/Notulen', notulen: 'x' }]));
    assert.ok(!K.regelsGeldig([{ overleg: 'X', re: 'x', entiteit: 'HAGRO', map: '10_Zakelijk/../../etc/Notulen', notulen: 'x' }]));
    assert.ok(!K.regelsGeldig([{ overleg: 'X', re: '(', entiteit: 'HAGRO', map: '10_Zakelijk/HAGRO/Notulen', notulen: 'x' }]));
    assert.ok(!K.regelsGeldig([]));
  });
  console.log(goed + ' goed, ' + fouten + ' fout');
  process.exit(fouten ? 1 : 0);
})();
