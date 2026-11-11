#!/usr/bin/env bash
# Toetst box-archief.js (wv2902, MrLean ML7/ML8): wekelijkse archiefstap van de machinekamer-box en Open vragen aan David.
#  A  box: afgesloten rij > 7 d naar Archief/machinekamer-<maand van de sluitdatum>.md direct onder de inleidende regel; open rij,
#     bezig-rij en afgesloten rij ≤ 7 d blijven; telling voor = na + archief; nooit in machinekamer-archief-t-m-*
#  B  datum direct achter het statuswoord (d-m, jaar uit de kop; jjjj-mm-dd; december-rij die in januari sluit = volgend jaar);
#     zonder datum: datum van vandaag erbij, rij blijft
#  C  formaatblok blijft in de box (rij vlak ervoor afgeknipt); '## ' binnen ``` is geen rijkop
#  D  rijen onder ## Archief naar boven; verwijzingsregel krijgt de nieuwe maand vooraan, een bestaande niet nogmaals
#  E  register: beantwoord/vervallen/afgehandeld > 7 d naar Archief/open-vragen-<maand>.md (tabelkop erbij); open rij blijft; rij bij
#     een open kaart (sleutel, herkomst.wv, herkomst.register) blijft; zonder kaartenlijst: register ongemoeid, ok false
#  F  tweede ronde: niets verandert (byte-gelijk); weekstempel: binnen 7 d al_gedaan, daarna weer aan de beurt
#  G  droog: niets geschreven
set -u
cd "$(dirname "$0")/.." || exit 1
W=$(mktemp -d /tmp/boxarchief-XXXXXX)
trap 'rm -rf "$W"' EXIT
W="$W" node - <<'JS'
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const B = require(path.join(process.cwd(), 'box-archief.js')), VV = require(path.join(process.cwd(), 'vault-veilig.js'));
let goed = 0, fout = 0;
function toets(n, ok, x) { if (ok) { goed++; console.log('GROEN ' + n); } else { fout++; console.log('ROOD  ' + n + (x !== undefined ? '  ' + JSON.stringify(x).slice(0, 600) : '')); } }
const W = process.env.W;
function vault(naam) {
  const v = path.join(W, naam), a = path.join(v, '00_Systeem', 'Meldingen', 'Archief');
  fs.mkdirSync(a, { recursive: true });
  const box = ['---', 'type: meldingenbus', 'updated: 2026-11-01', '---', '', '# Meldingen — Machinekamer (interne box)', '',
    '**Formaat** (nieuwste bovenaan): zie het blok.', '',
    '## [week] 2026-11-10 09:00 — open rij #a', '- status: open', '- van: socev', '',
    '## [log] 2026-11-09 10:00 — bezig rij #b', '- status: bezig — afgehandeld 1-11 staat later', '',
    '## [log] 2026-11-08 10:00 — recent dicht #c', '- status: afgehandeld 8-11 — net', '',
    '## [log] 2026-10-20 10:00 — oud dicht #d', '- status: **afgehandeld 25-10** — klaar', '- gemeten: x', '',
    '## [log] 2026-10-18 10:00 — gesloten iso #e', '- status: gesloten 2026-10-30 (terugkeer: y)', '',
    '## [log] 2026-11-01 10:00 — klaar zonder datum #f', '- status: klaar — gebouwd', '',
    '## [log] 2025-12-30 10:00 — jaarwissel #g', '- status: gedaan 2-1 — over de jaargrens', '',
    '## [log] 2026-10-15 10:00 — met formaatblok #h', '- status: afgehandeld 16-10', '- regel h', '', '**Formaat van een rij:**', '', '```', '',
    '## [direct|week|log] JJJJ-MM-DD HH:MM — kern in één regel', '- status: open | afgehandeld <datum>', '```', '', '`log` = alleen vastleggen.', '',
    '## [log] 2026-10-14 10:00 — status later in de rij #i', '- van: x', '- status: afgehandeld 15-10', '',
    '## [week] 2026-10-01 10:00 — open oud #j', '- status: open — wacht', '',
    '## [log] 2025-10-05 10:00 — vorig jaar zonder datum #m', '- status: afgehandeld — ooit', '',
    '## [week] 2026-10-03 10:00 — voorbeeld in codeblok #n', '```', '- status: afgehandeld 1-10', '```', '- status: open', '',
    '## Archief', 'Gearchiveerd: [[00_Systeem/Meldingen/Archief/machinekamer-2026-10|oktober 2026]] · [[00_Systeem/Meldingen/Archief/machinekamer-archief-t-m-2026-10-17|alles tot en met 17-10-2026]]. Nieuwe rijen horen bovenaan.',
    '', '## [log] 2026-11-10 23:00 — onder archief open #k', '- status: open', '', '## [log] 2026-10-10 23:00 — onder archief dicht #l', '- status: afgehandeld 12-10', ''].join('\n');
  fs.writeFileSync(path.join(v, '00_Systeem', 'Meldingen', 'machinekamer.md'), box);
  fs.writeFileSync(path.join(a, 'machinekamer-2026-10.md'), ['---', 'type: meldingenarchief', 'updated: 2026-10-30', '---', '', '# Machinekamer-box — archief 2026-10', '',
    'Ongewijzigd overgenomen uit [[00_Systeem/Meldingen/machinekamer|de box]], nieuwste bovenaan.', '', '## [log] 2026-10-02 10:00 — al gearchiveerd', '- status: afgehandeld 3-10', ''].join('\n'));
  const tm = ['---', 'type: meldingenarchief', '---', '', 'Ongewijzigd overgenomen uit de box.', ''].join('\n');
  fs.writeFileSync(path.join(a, 'machinekamer-archief-t-m-2026-10-17.md'), tm);
  const reg = ['---', 'type: register', '---', '', '# Open vragen aan David', '', '## Register', '| Gesteld | Kanaal | Vraag | Aanname | Status | Bewijs |', '|---|---|---|---|---|---|',
    '| 2026-11-10 09:00 | machinekamer | open vraag | x | open | - |',
    '| 2026-10-20 09:00 | machinekamer | oud beantwoord | x | beantwoord 21-10 10:00 (app-knop) | - |',
    '| 2026-10-21 09:00 | machinekamer (Voor jou-kaart doen wv77) | hoort bij open kaart | x | beantwoord 22-10 | - |',
    '| 2026-10-22 09:00 | machinekamer #wv88 | herkomst.register | x | **afgehandeld** 23-10 | - |',
    '| 2026-10-23 09:00 | machinekamer (wv99) | herkomst.wv | x | vervallen 24-10 | - |',
    '| 2026-11-08 09:00 | machinekamer | recent | x | beantwoord 8-11 | - |',
    '| 2026-09-28 18:00 | box | zonder datum in status | x | **beantwoord** — David "Gedaan" | - |',
    '| 2026-10-24 09:00 | machinekamer | met \\| pipe | x | beantwoord: JA 25-10 | - |',
    '| 2026-10-25 09:00 | kapot | te weinig cellen | beantwoord 26-10 |',
    '', '- [beantwoord] 2026-10-01 wv1 — losse regel blijft', ''].join('\n');
  fs.writeFileSync(path.join(v, '00_Systeem', 'Open vragen aan David.md'), reg);
  return v;
}
const kaarten = [{ sleutel: 'wv77', status: 'open', herkomst: {} }, { sleutel: 'x1', status: 'later', herkomst: { register: ['2026-10-22 09:00#wv88'] } },
  { sleutel: 'x2', status: 'open', herkomst: { wv: [99] } }, { sleutel: 'wv20', status: 'gedaan', herkomst: {} }];
const lees = (v, r) => fs.readFileSync(path.join(v, r), 'utf8');
const BOX = '00_Systeem/Meldingen/machinekamer.md', REG = '00_Systeem/Open vragen aan David.md', AR = '00_Systeem/Meldingen/Archief/';
function sha(v) { const h = crypto.createHash('sha256'); (function loop(d) { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) loop(p); else h.update(n + fs.readFileSync(p)); } })(path.join(v, '00_Systeem')); return h.digest('hex'); }

(async function () {
  const v = vault('a'), st = path.join(W, 'staat-a');
  const box0 = lees(v, BOX), reg0 = lees(v, REG);
  const r = await B.ronde({ vault: v, VV, vandaag: '2026-11-11', staatMap: st, kaarten: async () => kaarten });
  const box = lees(v, BOX), a10 = lees(v, AR + 'machinekamer-2026-10.md');
  toets('ronde ok', r.ok === true && !r.al_gedaan, r);
  // A
  const blijft = ['#a', '#b', '#c', '#f', '#j', '#k', '#m', '#n'], weg = ['#d', '#e', '#h', '#i', '#l', '#g'];
  toets('A: open, bezig, recent dicht en datumloos blijven in de box', blijft.every(k => box.includes(k)), blijft.filter(k => !box.includes(k)));
  toets('A: oude afgesloten rijen weg uit de box', weg.every(k => !box.includes('— ' + k.slice(1) + ' ') && !new RegExp('#' + k.slice(1) + '$', 'm').test(box)), weg.filter(k => new RegExp(k + '$', 'm').test(box)));
  toets('A: oktober-rijen letterlijk in machinekamer-2026-10, direct onder de inleidende regel, nieuwste bovenaan',
    a10.includes('## [log] 2026-10-20 10:00 — oud dicht #d\n- status: **afgehandeld 25-10** — klaar\n- gemeten: x\n') &&
    a10.indexOf('#d') < a10.indexOf('#e') && a10.indexOf('#e') < a10.indexOf('#h') && a10.indexOf('#l') < a10.indexOf('al gearchiveerd') &&
    /nieuwste bovenaan\.\n\n## \[log\] 2026-10-20 10:00 — oud dicht #d/.test(a10) && /^updated: 2026-11-11$/m.test(a10), a10);
  toets('A: niets in machinekamer-archief-t-m-*', lees(v, AR + 'machinekamer-archief-t-m-2026-10-17.md') === '---\ntype: meldingenarchief\n---\n\nOngewijzigd overgenomen uit de box.\n');
  toets('A: telling: 14 rijkoppen voor = 8 na + 6 archief', r.detail.box.rijen_voor === 14 && r.detail.box.rijen_na === 8 && r.detail.box.archief === 6, r.detail.box);
  // B
  toets('B: december-rij die 2-1 sloot = 2026-01-02 → archief 2026-01 (nieuw bestand met kop en inleiding)',
    fs.existsSync(path.join(v, AR, 'machinekamer-2026-01.md')) && /type: meldingenarchief[\s\S]*# Machinekamer-box — archief 2026-01[\s\S]*Ongewijzigd overgenomen[^\n]*\n\n## \[log\] 2025-12-30 10:00 — jaarwissel #g/.test(lees(v, AR + 'machinekamer-2026-01.md')));
  toets('B: datumloos "klaar" krijgt de datum van vandaag en blijft', box.includes('- status: klaar 11-11 — gebouwd'), box.match(/.*#f\n.*/));
  toets('B: datumloze rij uit 2025 krijgt d-m-jjjj (review MOET 2)', box.includes('- status: afgehandeld 11-11-2026 — ooit'), box.match(/.*#m\n.*/));
  toets('C: statusregel in een codeblok telt niet; open rij #n blijft (review MOET 1)', box.includes('#n\n```\n- status: afgehandeld 1-10\n```\n- status: open'));
  toets('B: "bezig — afgehandeld 1-11" telt niet als afgesloten', box.includes('- status: bezig — afgehandeld 1-11 staat later'));
  // C
  toets('C: formaatblok en codeblok blijven in de box, rij #h ervoor weg', box.includes('**Formaat van een rij:**\n\n```\n\n## [direct|week|log] JJJJ-MM-DD HH:MM — kern in één regel') && box.includes('`log` = alleen vastleggen.') && !box.includes('- regel h'));
  toets('C: archiefblok #h zonder formaatblok', a10.includes('#h\n- status: afgehandeld 16-10\n- regel h\n') && !a10.includes('Formaat van een rij'));
  // D
  const L = box.split('\n'), ai = L.indexOf('## Archief');
  toets('D: rij onder ## Archief (open) naar boven, vóór de eerste rij', box.indexOf('#k') < box.indexOf('#a') && ai > 0 && L.slice(ai + 1).filter(l => l.trim()).length === 1, L.slice(ai));
  toets('D: verwijzingsregel: januari 2026 achteraan (ouder dan oktober), oktober niet dubbel', L[ai + 1] === 'Gearchiveerd: [[00_Systeem/Meldingen/Archief/machinekamer-2026-10|oktober 2026]] · [[00_Systeem/Meldingen/Archief/machinekamer-archief-t-m-2026-10-17|alles tot en met 17-10-2026]]. Nieuwe rijen horen bovenaan. · [[00_Systeem/Meldingen/Archief/machinekamer-2026-01|januari 2026]]', L[ai + 1]);
  toets('D: nieuwe maand vooraan als die nieuwer is', B.linkRegel(L[ai + 1], ['2026-11']).startsWith('Gearchiveerd: [[00_Systeem/Meldingen/Archief/machinekamer-2026-11|november 2026]] · [[00_Systeem/Meldingen/Archief/machinekamer-2026-10|'));
  toets('D: box eindigt met de verwijzingsregel en één regeleinde', box.endsWith('Nieuwe rijen horen bovenaan. · [[00_Systeem/Meldingen/Archief/machinekamer-2026-01|januari 2026]]\n'));
  // E
  const reg = lees(v, REG), o10 = lees(v, AR + 'open-vragen-2026-10.md'), o09 = lees(v, AR + 'open-vragen-2026-09.md');
  toets('E: open, recent, bij open kaart (sleutel/herkomst.register/herkomst.wv), kapotte rij en losse regel blijven',
    ['open vraag', 'hoort bij open kaart', 'herkomst.register', 'herkomst.wv', '| recent |', 'te weinig cellen', 'losse regel blijft'].every(k => reg.includes(k)), reg);
  toets('E: oud beantwoord + pipe-rij → open-vragen-2026-10 met tabelkop, letterlijk', o10.includes('| Gesteld | Kanaal | Vraag | Aanname | Status | Bewijs |\n|---|---|---|---|---|---|\n') &&
    o10.includes('| 2026-10-20 09:00 | machinekamer | oud beantwoord | x | beantwoord 21-10 10:00 (app-knop) | - |') && o10.includes('met \\| pipe') && !reg.includes('oud beantwoord') && !reg.includes('met \\| pipe'), o10);
  toets('E: zonder datum in de status → Gesteld-maand (2026-09)', o09.includes('zonder datum in status') && !reg.includes('zonder datum in status'));
  toets('E: telling register', r.detail.register.rijen_voor === 8 && r.detail.register.archief === 3 && r.detail.register.bij_open_kaart === 3, r.detail.register);
  // F
  const s1 = sha(v);
  const r2 = await B.ronde({ vault: v, VV, vandaag: '2026-11-11', staatMap: st, kaarten: async () => kaarten });
  toets('F: tweede ronde binnen de week = al_gedaan', r2.ok && r2.al_gedaan === true, r2);
  const r3 = await B.ronde({ vault: v, VV, vandaag: '2026-11-11', staatMap: st, forceer: true, kaarten: async () => kaarten });
  toets('F: geforceerde tweede ronde verandert niets (byte-gelijk)', r3.ok && r3.detail.box.archief === 0 && r3.detail.register.archief === 0 && sha(v) === s1, r3.detail);
  const r4 = await B.ronde({ vault: v, VV, vandaag: '2026-11-19', staatMap: st, kaarten: async () => kaarten });
  toets('F: een week later weer aan de beurt (datumloze #f en #m van 11-11 nu > 7 d → archief 2026-11)', r4.ok && !r4.al_gedaan && fs.existsSync(path.join(v, AR, 'machinekamer-2026-11.md')) && !lees(v, BOX).includes('#f') && !lees(v, BOX).includes('#m') && lees(v, BOX).includes('#n'), r4.detail);
  // E2: kaarten niet leesbaar
  const v2 = vault('b'); const reg2 = lees(v2, REG);
  const r5 = await B.ronde({ vault: v2, VV, vandaag: '2026-11-11', staatMap: path.join(W, 'staat-b'), kaarten: async () => { throw new Error('rpc stuk'); } });
  toets('E: kaarten niet leesbaar → ok false, register ongemoeid, geen stempel (keten probeert opnieuw)', r5.ok === false && /rpc stuk/.test(r5.reden) && lees(v2, REG) === reg2 && !fs.existsSync(path.join(W, 'staat-b', 'laatste.json')), r5);
  // G
  const v3 = vault('c'); const s3 = sha(v3);
  const r6 = await B.ronde({ vault: v3, VV, vandaag: '2026-11-11', droog: true, staatMap: path.join(W, 'staat-c'), kaarten: async () => kaarten });
  toets('G: droog schrijft niets en telt wel', r6.ok && r6.detail.box.archief === 6 && r6.detail.register.archief === 3 && sha(v3) === s3 && !fs.existsSync(path.join(W, 'staat-c')), r6.detail);
  console.log('\n' + goed + ' groen, ' + fout + ' rood');
  process.exit(fout ? 1 : 0);
})().catch(e => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
