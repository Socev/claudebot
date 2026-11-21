#!/usr/bin/env bash
# wv3745 (besluitenpagina nr 438 = 3C138 + nr 478 = 3C178): toetst in ovis-code.js
#  K. standKern: Volgende stap en Besluiten uit STAND.md (punten, vervolgregels, lege punten weg, podpaden weg, hooguit 5), datum = mtime;
#     geen STAND of lege kopjes = null; afgekeurd bestand (open rechten) = null.
#  U. uitkomstUit: "Uitkomst: …" in gewone, vette en opsommingsvorm; anders null.
#  G. gewijzigdBij: nieuwste klare klus per app wint (ook over een ouder bestand heen), nacontrole/open/geen app tellen niet, late
#     uitkomstregel wordt alsnog bijgezet, bestand 0600.
#  A. appsUit: gewijzigd + stand_kern per app; uitrol_schil alleen bij een scherm-app zonder eigen uitrol.
# Kruisproef: OC=<pad naar oude ovis-code.js> bash test/ovis-code-kern.sh → rood. Raakt niets buiten een wegwerpmap.
set -u
cd "$(dirname "$0")/.." || exit 1
OC="${OC:-./ovis-code.js}" node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const OC = require(path.resolve(process.env.OC));
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-kern-')); fs.chmodSync(W, 0o700);
const basis = path.join(W, 'ovis-code');
let klok = Date.parse('2026-11-21T15:00:00Z');
const w = OC.maak({ basis, nu: () => klok });
const veilig = (f) => { try { return f(); } catch (e) { return 'FOUT ' + e.message; } };
w.werkKlaar && w.werkKlaar('facturen');
const map = path.join(basis, 'facturen'); fs.mkdirSync(map, { recursive: true, mode: 0o700 }); fs.chmodSync(map, 0o700);
const zet = (id, t) => { const m = path.join(basis, id); fs.mkdirSync(m, { recursive: true, mode: 0o700 }); const p = path.join(m, 'STAND.md'); try { fs.unlinkSync(p); } catch (e) {} fs.writeFileSync(p, t, { mode: 0o600 }); fs.utimesSync(p, new Date('2026-11-21T12:11:00Z'), new Date('2026-11-21T12:11:00Z')); };
zet('facturen', ['# Facturen — STAND', '', '_Bijgewerkt 2026-11-21._', '', '## Stand', '- iets', '', '## Besluiten', '- Datumregel bewust **niet** ingebouwd.', '',
  '## Volgende stap', '- Na uitrol: versie toetsen in `/opt/data/x/y.log` en meten', '  vervolgregel hoort erbij.', '- ', '- Tweede punt', '- 3', '- 4', '- 5', '- 6', '', '## Valkuilen', '- niet dit'].join('\n'));
const k = veilig(() => w.standKern('facturen'));
toets('K Volgende stap: punten met vervolgregel, leeg punt weg, podpad weg, hooguit 5', k && Array.isArray(k.volgende) && k.volgende.length === 5 &&
  k.volgende[0] === 'Na uitrol: versie toetsen in en meten vervolgregel hoort erbij.' && k.volgende[1] === 'Tweede punt', k);
toets('K Besluiten zonder markdown-vet; Valkuilen/Stand niet mee', k && k.besluiten && k.besluiten.length === 1 && k.besluiten[0] === 'Datumregel bewust niet ingebouwd.', k);
toets('K datum = laatste wijziging van STAND.md', k && k.op === '2026-11-21T12:11:00.000Z', k && k.op);
zet('crisis', ['# x', '## Stand', '- a', '## Besluiten', '- ', '## Volgende stap', '- ', '## Valkuilen', '- b'].join('\n'));
toets('K zaad-STAND met lege kopjes = null (niets verzinnen)', veilig(() => w.standKern('crisis')) === null);
toets('K geen STAND / onbekende app = null', veilig(() => w.standKern('pot')) === null && veilig(() => w.standKern('bestaat-niet')) === null);
zet('zorgplein', ['## Volgende stap', '- Geen.'].join('\n')); fs.chmodSync(path.join(basis, 'zorgplein', 'STAND.md'), 0o644);
toets('K STAND met open rechten = null', veilig(() => w.standKern('zorgplein')) === null);

toets('U Uitkomst: gewone, vette en opsommingsvorm', veilig(() => w.uitkomstUit('Agentrapport\nUitkomst: Facturen toont nu X.\nrest')) === 'Facturen toont nu X.' &&
  w.uitkomstUit('**Uitkomst:** Klaar en live.') === 'Klaar en live.' && w.uitkomstUit('- Uitkomst: kaart werkt') === 'kaart werkt' && w.uitkomstUit('## Uitkomst: kop') === 'kop');
toets('U zonder regel of leeg = null', veilig(() => w.uitkomstUit('Geen uitkomst hier\nDe uitkomst: is niet aan het begin')) === null && w.uitkomstUit('Uitkomst:   ') === null);

const items = [
  { id: 10, label: 'machinekamer:facturen-oud', status: 'klaar', klaar_op: '2026-11-19T10:00:00Z', samenvatting: 'Oude klus', job_id: 'aaaaaaaaaaaaaaaa' },
  { id: 11, label: 'machinekamer:facturen-nieuw', status: 'klaar', klaar_op: '2026-11-21T10:00:00Z', samenvatting: 'Nieuwe klus', job_id: 'bbbbbbbbbbbbbbbb' },
  { id: 12, label: 'machinekamer:facturen-nacontrole', status: 'klaar', soort: 'nacontrole', klaar_op: '2026-11-21T11:00:00Z', samenvatting: 'Nacontrole' },
  { id: 13, label: 'machinekamer:facturen-open', status: 'open', klaar_op: null, samenvatting: 'Open' },
  { id: 14, label: 'machinekamer:onzin-x', status: 'klaar', klaar_op: '2026-11-21T12:00:00Z', samenvatting: 'Geen app' },
  { id: 15, label: 'machinekamer:pot-iets', status: 'klaar', klaar_op: '2026-11-20T08:00:00Z', job_id: null },
];
let g = veilig(() => w.gewijzigdBij(items, () => null));
toets('G nieuwste klare klus wint; nacontrole, open en geen app tellen niet', g && g.facturen && g.facturen.wv === 11 && g.facturen.titel === 'Nieuwe klus' && g.facturen.uitkomst === null && !g.onzin, g);
toets('G zonder samenvatting = label als titel', g && g.pot && g.pot.titel === 'pot iets', g && g.pot);
const p = path.join(basis, 'gewijzigd.json');
toets('G bestand 0600', fs.existsSync(p) && (fs.statSync(p).mode & 0o777) === 0o600);
g = veilig(() => w.gewijzigdBij([items[0]], () => 'zou niet mogen'));
toets('G een oudere klus later in de lijst overschrijft niet', g && g.facturen.wv === 11, g && g.facturen);
g = veilig(() => w.gewijzigdBij([items[1]], (j) => j === 'bbbbbbbbbbbbbbbb' ? 'Facturen toont nu de uitgaande nota apart.' : null));
toets('G late uitkomstregel wordt alsnog bijgezet', g && g.facturen.wv === 11 && g.facturen.uitkomst === 'Facturen toont nu de uitgaande nota apart.', g && g.facturen);
klok += 5 * 24 * 3600 * 1000;
let gevraagd = 0;
veilig(() => w.gewijzigdBij([items[1]], () => { gevraagd++; return 'x'; }));
toets('G bekende klus met uitkomst: rapport niet opnieuw gelezen', gevraagd === 0);

const stand = { gemeten: '2026-11-21T14:00:00Z', repos: {}, workers: {}, main: { 'socev-app': 'abc1234ffff' },
  pages: { 'socev-app': { op: '2026-11-21T13:00:00Z', commit: 'abc1234ffff', branch: 'main', bron_repo: 'socev-app' }, crisis: { op: '2026-11-21T12:00:00Z', commit: 'def5678', bron_repo: 'crisis' } } };
const uit = veilig(() => w.appsUit({ stand }));
const A = (id) => uit && uit.apps ? uit.apps.find((x) => x.id === id) : null;
toets('A facturen: gewijzigd met uitkomstzin + stand_kern', A('facturen') && A('facturen').gewijzigd && A('facturen').gewijzigd.zin === 'Facturen toont nu de uitgaande nota apart.' &&
  A('facturen').gewijzigd.uitkomst === true && A('facturen').stand_kern && A('facturen').stand_kern.volgende.length === 5, A('facturen'));
toets('A pot zonder uitkomst: zin = titel', A('pot') && A('pot').gewijzigd && A('pot').gewijzigd.zin === 'pot iets' && A('pot').gewijzigd.uitkomst === false, A('pot') && A('pot').gewijzigd);
toets('A scherm-app zonder eigen uitrol (facturen) krijgt de uitrol van de Socev-app', A('facturen') && A('facturen').uitrol === null && A('facturen').uitrol_schil && A('facturen').uitrol_schil.naam === 'socev-app', A('facturen') && A('facturen').uitrol_schil);
toets('A app met eigen uitrol of zonder scherm: geen uitrol_schil', A('crisis') && A('crisis').uitrol && A('crisis').uitrol_schil === null && A('socev-app').uitrol_schil === null && A('n8n').uitrol_schil === null,
  [A('crisis') && A('crisis').uitrol_schil, A('n8n') && A('n8n').uitrol_schil]);
toets('A app zonder klus en STAND: gewijzigd en stand_kern null', A('n8n') && A('n8n').gewijzigd === null && A('n8n').stand_kern === null, A('n8n'));
fs.rmSync(W, { recursive: true, force: true });
console.log('\novis-code-kern: ' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
