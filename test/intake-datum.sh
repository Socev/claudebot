#!/usr/bin/env bash
# Toets wv4134 (besluitenpagina nr 442 = 3C142): intake-datum.js met verzonnen kandidaten, een nep-luik en een tijdelijke Deadlines-pagina.
#   Eén voorstel per stuk (vroegste, termijn eerst), filters (verleden, weekdag, al in Deadlines/agenda, potlood), Zet bij Deadlines schrijft één
#   regel (tweede keer niet), Zet in agenda vraagt alleen een Poortwachter-kaart (david_plaatsen, kaart: true, geen deelnemers/herhaling) en
#   pas daarna staat; mislukte kaart = keuze weer vrij, onzekere = blijft; Nee = klopt_niet + nooit meer; één keuze per stuk; potlood slaat
#   gekozen kandidaten over. Kruisproef: ID_MOD=<kopie zonder potloodfilter> bash test/intake-datum.sh moet rood zijn.
set -u
HIER="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node - "$HIER" "$TMP" <<'EINDE'
'use strict';
const path = require('path'), fs = require('fs');
const M = require(process.env.ID_MOD || path.join(process.argv[2], 'intake-datum.js'));
const TMP = process.argv[3];
let ok = 0, fout = 0;
function toets(naam, waar, x) { if (waar) { ok++; console.log('ok   ' + naam); } else { fout++; console.log('FOUT ' + naam + ' ' + JSON.stringify(x)); } }
const NU = Date.UTC(2026, 10, 27, 9, 0);   // vr 27-11-2026 10:00 lokaal
const S1 = 'stk_20261120_aaaaaaaa', S2 = 'stk_20261121_bbbbbbbb', S3 = 'stk_20261122_cccccccc', S4 = 'stk_20261123_dddddddd', S5 = 'stk_20261124_eeeeeeee';
const rij = (id, stuk, soort, dag, extra, bron) => Object.assign({ event_id: id, soort, begin_datum: dag, hele_dag: true, titel: (soort === 'deadline' ? 'Deadline uit: ' : 'Afspraak uit: ') + 'Proefbrief ' + id,
  datum_precisie: 'dag', bron: Object.assign({ stuk, bronpad: '10_Zakelijk/Proefpraktijk/Bronnen/proef ' + id + '.md', staat_er: [] }, bron || {}) }, extra || {});
let RIJEN = [
  rij(1, S1, 'afspraak', '2026-12-10', { hele_dag: false, begin_tijd: '14:00:00' }),
  rij(2, S1, 'deadline', '2026-12-10'),                                    // zelfde dag: termijn eerst
  rij(3, S1, 'deadline', '2026-12-20'),
  rij(4, S2, 'deadline', '2026-11-20'),                                    // verleden: geen voorstel
  rij(5, S2, 'afspraak', '2026-12-03', { hele_dag: false, begin_tijd: '09:30:00', eind_tijd: '10:00:00' }),
  rij(6, S3, 'deadline', '2026-12-05', {}, { staat_er: ['deadlines'] }),   // staat al in Deadlines
  rij(7, S3, 'afspraak', '2026-12-06', {}, { regel: 'rel.weekdag' }),      // losse weekdag
  rij(8, S4, 'afspraak', '2026-12-08', { hele_dag: false, begin_tijd: '11:00:00' }),   // potlood kent hem al
  rij(9, S5, 'deadline', '2026-12-15', { datum_precisie: 'maand' }),       // te vaag
  rij(10, 'geen-stuk', 'deadline', '2026-12-15'),
];
// zuiver: kies
const k = M.kies(RIJEN, '2026-11-27', new Set([8]));
toets('S1: één voorstel, termijn eerst op dezelfde dag', k.get(S1) && k.get(S1).soort === 'deadline' && k.get(S1).ev === 2 && k.get(S1).dag === '2026-12-10', k.get(S1));
toets('S2: verleden overgeslagen, afspraak 3-12 09:30', k.get(S2) && k.get(S2).ev === 5 && k.get(S2).tijd === '09:30' && k.get(S2).eind === '10:00', k.get(S2));
toets('S3: al in Deadlines en losse weekdag → geen voorstel', !k.has(S3), k.get(S3));
toets('S4: potlood bestaat al → geen tweede voorstel', !k.has(S4), k.get(S4));
toets('S5: precisie maand → geen voorstel', !k.has(S5));
toets('kandidaat zonder Intake-stuk telt niet', k.size === 2, Array.from(k.keys()));
toets('titel zonder voorvoegsel van de detector', k.get(S1).titel === 'Proefbrief 2', k.get(S1).titel);

// Deadlines-pagina en nep-vault-veilig
const VAULT = path.join(TMP, 'vault'); fs.mkdirSync(path.join(VAULT, '00_Systeem'), { recursive: true });
const DL = path.join(VAULT, '00_Systeem', 'Deadlines.md');
fs.writeFileSync(DL, '# Deadlines\n\n## Actueel\n\n| Datum | Entiteit | Wat | Actie | Signaleer | Bron |\n|---|---|---|---|---|---|\n| 2026-12-31 | Privé | Proef | - | 3 | - |\n\n## Afgehandeld\n');
const vv = { wijzig: (p, f) => { const n = f(fs.readFileSync(p)); if (n === null) return false; fs.writeFileSync(p, n); return true; } };
const LUIK = []; let luikGedrag = 'ok';
const OORDEEL = []; let oordeelFaalt = false;
let POTLOOD = [8];
const staatPad = path.join(TMP, 'intake-datum.json');
const D = M.maak({ nu: () => NU, vault: VAULT, vv, staatPad, rpc: async (fn, b) => { toets('rpc ' + fn + ' venster', fn === 'sb_kalender_gevonden' && b.p_van === '2026-11-27' && b.p_tot === '2027-03-27', b); return RIJEN.map((x) => ({ sb_kalender_gevonden: x })); },
  potloodIds: () => POTLOOD,
  luik: async (b) => { LUIK.push(b); if (luikGedrag === 'weg') throw new Error('time-out'); if (luikGedrag === 'nee') return { ok: false, fout: 'Poortwachter weigert' }; return { ok: true, knop_verstuurd: true, correlatie_id: 'ag-123' }; },
  oordeel: async (id, w) => { OORDEEL.push([id, w]); return oordeelFaalt ? { status: 500 } : { status: 200 }; } });

(async () => {
  // app-antwoord verrijken (ook genest, alleen beoordeelde stukken)
  const body = { stukken: [{ stuk_id: S1, status: 'beoordeeld' }, { stuk_id: S2, status: 'vastgehouden' }], dagen: [{ dag: 'x', stukken: [{ stuk_id: S2, status: 'beoordeeld' }, { stuk_id: S4, status: 'beoordeeld' }] }] };
  await D.erbij(body);
  toets('kaart S1 krijgt datum open', body.stukken[0].datum && body.stukken[0].datum.staat === 'open' && body.stukken[0].datum.soort === 'deadline', body.stukken[0]);
  toets('vastgehouden stuk krijgt niets', !body.stukken[1].datum);
  toets('Geschiedenis (genest) S2 afspraak', body.dagen[0].stukken[0].datum && body.dagen[0].stukken[0].datum.soort === 'afspraak');
  toets('S4 (potlood) niets', !body.dagen[0].stukken[1].datum);

  // ongeldige verzoeken
  let r = await D.keuze({ stuk_id: S1, ev: 2, keuze: 'agenda' });
  toets('termijn → agenda geweigerd', r.status === 400, r);
  r = await D.keuze({ stuk_id: S1, ev: 5, keuze: 'deadlines' });
  toets('kandidaat van een ander stuk geweigerd', r.status === 409, r);
  r = await D.keuze({ stuk_id: 'x', ev: 2, keuze: 'deadlines' });
  toets('ongeldig stuk-id', r.status === 400);

  // Zet bij Deadlines
  r = await D.keuze({ stuk_id: S1, ev: 2, keuze: 'deadlines' });
  const t = fs.readFileSync(DL, 'utf8');
  toets('Deadlines: 200 en één regel onder ## Actueel', r.status === 200 && r.j.staat === 'deadlines' && (t.match(/stuk stk_20261120_aaaaaaaa/g) || []).length === 2, { r, t });
  toets('regel in de tabel, vóór ## Afgehandeld, met datum en entiteit', /\| 2026-12-31 .*\n\| 2026-12-10 \| Proefpraktijk \| \*\*Termijn: Proefbrief 2\*\*/.test(t) && t.indexOf('2026-12-10') < t.indexOf('## Afgehandeld'), t);
  r = await D.keuze({ stuk_id: S1, ev: 2, keuze: 'deadlines' });
  toets('tweede tik: 409, geen tweede regel', r.status === 409 && (fs.readFileSync(DL, 'utf8').match(/Termijn: Proefbrief 2/g) || []).length === 1, r);
  toets('Deadlines schreef geen agenda', LUIK.length === 0);

  // Zet in agenda: eerst mislukt (zeker) → vrij; dan gelukt
  luikGedrag = 'nee';
  r = await D.keuze({ stuk_id: S2, ev: 5, keuze: 'agenda' });
  toets('kaart zeker mislukt: 502 en keuze weer vrij', r.status === 502 && !JSON.parse(fs.readFileSync(staatPad, 'utf8')).stukken[S2], r);
  luikGedrag = 'ok';
  r = await D.keuze({ stuk_id: S2, ev: 5, keuze: 'agenda' });
  const kaart = LUIK[LUIK.length - 1];
  toets('agenda: alleen een Poortwachter-kaart (david_plaatsen, kaart: true)', r.status === 200 && kaart.actie === 'david_plaatsen' && kaart.kaart === true && kaart.agenda === 'hoofd', kaart);
  toets('kaart: tijd en titel, geen deelnemers of herhaling', kaart.start === '2026-12-03T09:30' && kaart.eind === '2026-12-03T10:00' && kaart.titel === 'Proefbrief 5' &&
    !('deelnemers' in kaart) && !('attendees' in kaart) && !('herhaling' in kaart) && !('recurrence' in kaart), kaart);
  toets('kaart: stuklink in de omschrijving', /^Stuk: https:\/\/app\.socev\.dev\/10_Zakelijk\/Proefpraktijk\/Bronnen\/proef%205\.md$/.test(kaart.omschrijving || ''), kaart.omschrijving);
  r = await D.keuze({ stuk_id: S2, ev: 5, keuze: 'agenda' });
  toets('agenda tweede tik: 409, geen tweede kaart', r.status === 409 && LUIK.length === 2, LUIK.length);
  const b2 = { stukken: [{ stuk_id: S2, status: 'beoordeeld' }, { stuk_id: S1, status: 'beoordeeld' }] };
  await D.erbij(b2);
  toets('na keuze: staat agenda / deadlines op de kaart', b2.stukken[0].datum.staat === 'agenda' && b2.stukken[1].datum.staat === 'deadlines', b2);
  toets('potlood slaat gekozen kandidaten over', D.gekozenIds().has(5) && D.gekozenIds().has(2) && !D.gekozenIds().has(1), Array.from(D.gekozenIds()));

  // onzeker (time-out): keuze blijft staan
  RIJEN.push(rij(11, 'stk_20261125_ffffffff', 'afspraak', '2026-12-12'));
  luikGedrag = 'weg';
  r = await D.keuze({ stuk_id: 'stk_20261125_ffffffff', ev: 11, keuze: 'agenda' });
  toets('kaart onzeker: keuze blijft (nooit twee kaarten)', r.status === 502 && JSON.parse(fs.readFileSync(staatPad, 'utf8')).stukken.stk_20261125_ffffffff.k === 'agenda', r);
  toets('hele dag: start dag, eind volgende dag', LUIK[LUIK.length - 1].start === '2026-12-12' && LUIK[LUIK.length - 1].eind === '2026-12-13', LUIK[LUIK.length - 1]);

  // Nee: klopt_niet (eerst mislukt → later opnieuw), nooit meer een voorstel
  RIJEN.push(rij(12, 'stk_20261126_99999999', 'deadline', '2026-12-18'));
  oordeelFaalt = true;
  r = await D.keuze({ stuk_id: 'stk_20261126_99999999', ev: 12, keuze: 'nee' });
  toets('Nee: 200, oordeel klopt_niet gevraagd', r.status === 200 && OORDEEL.some((x) => x[0] === 12 && x[1] === 'klopt_niet'), OORDEEL);
  toets('Nee: mislukt oordeel blijft open staan', (JSON.parse(fs.readFileSync(staatPad, 'utf8')).stukken.stk_20261126_99999999.oordeel_open || []).includes(12));
  toets('Nee: ook overgeslagen door de potloodlaag', D.gekozenIds().has(12));
  oordeelFaalt = false;
  const b3 = { stukken: [{ stuk_id: 'stk_20261126_99999999', status: 'beoordeeld' }] };
  await new Promise((k) => setTimeout(k, 5));
  await D.erbij(b3);
  toets('Nee: geen voorstel meer op de kaart', !b3.stukken[0].datum, b3);
  // verse lezing (cache weg na de keuze) probeert het oordeel opnieuw
  await new Promise((k) => setTimeout(k, 20));
  toets('Nee: oordeel later opnieuw gelukt', !JSON.parse(fs.readFileSync(staatPad, 'utf8')).stukken.stk_20261126_99999999.oordeel_open, JSON.parse(fs.readFileSync(staatPad, 'utf8')).stukken.stk_20261126_99999999);

  // potloodregister onleesbaar → geen voorstellen (fail-closed)
  const D2 = M.maak({ nu: () => NU, vault: VAULT, vv, staatPad: path.join(TMP, 'b.json'), rpc: async () => RIJEN, potloodIds: () => { throw new Error('kapot'); }, luik: async () => ({}), oordeel: async () => ({ status: 200 }) });
  const b4 = { stukken: [{ stuk_id: S1, status: 'beoordeeld' }] };
  await D2.erbij(b4);
  toets('potloodregister onleesbaar: geen voorstel', !b4.stukken[0].datum, b4);
  // rpc faalt: kaart werkt gewoon
  const D3 = M.maak({ nu: () => NU, vault: VAULT, vv, staatPad: path.join(TMP, 'c.json'), rpc: async () => { throw new Error('db weg'); }, potloodIds: () => [], luik: async () => ({}), oordeel: async () => ({ status: 200 }) });
  const b5 = { stukken: [{ stuk_id: S1, status: 'beoordeeld' }] };
  await D3.erbij(b5);
  toets('databank weg: geen veld, geen fout', !b5.stukken[0].datum);
  // HAGRO-stuk → HAGRO-agenda
  toets('HAGRO-stuk → agenda hagro', M.kaartVerzoek({ dag: '2026-12-01', tijd: '20:00', hele_dag: false, titel: 'x', pad: '10_Zakelijk/HAGRO/Bronnen/a.md' }).agenda === 'hagro');
  toets('afspraak 23:30 zonder eind: niet over middernacht', M.kaartVerzoek({ dag: '2026-12-01', tijd: '23:30', hele_dag: false, titel: 'x', pad: null }).eind === '2026-12-01T23:59');

  console.log('\nintake-datum: ' + ok + ' goed, ' + fout + ' fout');
  process.exit(fout ? 1 : 0);
})();
EINDE
