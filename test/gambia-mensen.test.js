'use strict';
// wv3950 (3C202): Apps › Gambia — personen, laatste contact op beide nummers, koppeling alleen op +220, steunbord, reisbriefing. Verzonnen data.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const G = require(path.join(__dirname, '..', 'gambia-mensen.js'));
let n = 0; const t = function (naam, fn) { fn(); n++; console.log('ok', naam); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-'));
const pers = path.join(dir, '20_Prive', 'Gambia', 'Personen'), gm = path.join(dir, '30_Conversaties', 'WhatsApp-Gambia'),
  nl = path.join(dir, '30_Conversaties', 'WhatsApp', 'Verwerkt', '2026-11');
[pers, gm, path.join(gm, 'Media'), nl].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
const w = function (p, s) { fs.writeFileSync(p, s); };
w(path.join(pers, 'Abdou Jallow.md'), '---\ntype: persoon\ngambia_contact: ja\nstatus: actueel\nrol: taxichauffeur\nupdated: 2026-11-20\n---\n# Abdou Jallow\n\n## Basis\n\n- Telefoon: +220 700 1111\n\n' +
  '## Stand 16 september 2026\n\nOude stand.\n\n## 20 november 2026 — vraagt naar de **watertank**\n\n> Hij vroeg of de tank al besteld is bij [[20_Prive/Gambia/Personen/Binta Ceesay|Binta]].\n\n### 3-10 — los\n\nzonder jaar\n');
w(path.join(pers, 'Binta Ceesay.md'), '---\ntype: persoon\ngambia_contact: ja\nstatus: actueel\n---\n# Binta\n\nGeen gedateerde kop.\n');
w(path.join(pers, 'Lamin Touray.md'), '---\ntype: persoon\ngambia_contact: ja\nstatus: contact beëindigd (1-10-2026)\n---\n# Lamin\n\n- WhatsApp: +220 700 3333\n- nummer +220 700 4444\n');
w(path.join(pers, 'Omar Sowe.md'), '---\ntype: persoon\ngambia_contact: ja\nstatus: actueel\n---\n# Omar\n\n- nummer +220 700 4444 (gedeeld)\n- De rector heeft nummer +220 700 5555\n');
w(path.join(pers, 'Fatou NL.md'), '---\ntype: persoon\ngambia_contact: nee\n---\n# geen Gambia-contact\n');
w(path.join(pers, 'David Schaap.md'), '---\ntype: persoon\ngambia_contact: ja\n---\n');
w(path.join(dir, '20_Prive', 'Gambia', 'Local Support Network.md'), '| Naam | Rol | Telefoon |\n|---|---|---|\n| [[20_Prive/Gambia/Personen/Binta Ceesay\\|Binta]] | buur | +220 700 2222 |\n');
const dump = function (id, contact, regels) { return '---\ntype: bron\ncontact: "' + contact + '"\nchat_id: ' + id + '\nstatus: verwerkt\n---\n\n# x\n\n' + regels.join('\n') + '\n'; };
w(path.join(gm, 'WhatsApp-Gambia - Abdou - 2026-11-14.md'), dump('2207001111@c.us', 'Abdou', ['**[10-11-2026 9:05] Abdou:** hi', '**[12-11-2026 20:10] David:** hello brother']));
w(path.join(gm, 'WhatsApp-Gambia - Abdou - 2026-11-21.md'), dump('2207001111@c.us', 'Abdou', ['**[18-11-2026 07:00] Abdou:** morning']));
w(path.join(gm, 'WhatsApp-Gambia - 2207004444 - 2026-11-21.md'), dump('2207004444@c.us', '2207004444', ['**[19-11-2026 10:00] 2207004444:** who?']));
w(path.join(gm, 'WhatsApp-Gambia - 2207009999 - 2026-11-21.md'), dump('2207009999@c.us', '2207009999', ['**[20-11-2026 10:00] 2207009999:** new']));
w(path.join(gm, 'WhatsApp-Gambia - Lamin - 2026-09-01.md'), dump('2207003333@c.us', 'Lamin', ['**[1-9-2026 10:00] Lamin:** hey']));
w(path.join(gm, 'WhatsApp-Gambia - rector - 2026-11-21.md'), dump('2207005555@c.us', 'rector', ['**[21-11-2026 10:00] rector:** fees']));
// NL-kant: Binta (LSN-nummer) via entiteit, een groep, en een Nederlands nummer dat toevallig op dezelfde zeven cijfers eindigt (Codex MOET 1)
w(path.join(nl, 'WhatsApp - Binta (1-op-1) - 2026-11-23.md'), '---\ntype: bron\ngroep: "Binta (1-op-1)"\ngroup_id: 2207002222@c.us\nentiteit: "Prive/Gambia"\n---\n\n**[22-11-2026 13:40] David:** sent\n**[22-11-2026 15:03] Binta C:** thanks\n');
w(path.join(nl, 'WhatsApp - Groep - 2026-11-23.md'), '---\ntype: bron\ngroep: "Bouw"\ngroup_id: 120363000000000000@g.us\nentiteit: "Prive/Gambia"\n---\n\n**[23-11-2026 08:00] Abdou:** foto\n');
w(path.join(nl, 'WhatsApp - Buurman - 2026-11-23.md'), '---\ntype: bron\ngroep: "Buurman"\ngroup_id: 31617001111@c.us\nentiteit: "Prive/Gambia"\n---\n\n**[24-11-2026 08:00] Buurman:** hoi\n');
w(path.join(nl, 'WhatsApp - Werk - 2026-11-23.md'), '---\ntype: bron\ngroep: "Werk"\ngroup_id: 31600000000@c.us\nentiteit: "Tolgaarde"\n---\n\n**[24-11-2026 08:00] X:** y\n');

const steun = { personen: [{ naam: 'Abdou Jallow', betaald: [{ zeker: true }], som: { GMD: { zeker: 10000, waarschijnlijk: 0 } },
  toezeggingen: [{ datum: '2026-09-07', wat: 'Watertank', bedrag_tekst: 'D 10.000', citaat: 'when the bank works', stand: 'open' },
    { datum: '2026-10-01', wat: 'Fiets', stand: 'betaald volgens dossier' }, { datum: '2026-08-01', wat: 'Zaad', stand: 'betaald' }] }] };
const reizen = [
  { id: 'aaaaaaaaaaaa', titel: 'Gambia 2026 voorjaar', soort: 'gambia', stand: 'geweest', van: '2026-04-01', tot: '2026-04-20' },
  { id: 'bbbbbbbbbbbb', titel: 'Gambia 2026 december', soort: 'gambia', stand: 'gepland', van: '2026-12-05', tot: '2026-12-19', deelnemers: [] },
  { id: 'cccccccccccc', titel: 'Wintersport', soort: 'vakantie', stand: 'gepland', van: '2026-11-28', tot: '2026-12-02' },
];
const reisTekst = function (id) { return id === 'bbbbbbbbbbbb' ? '## Plan\n\n- Bij [[20_Prive/Gambia/Personen/Binta Ceesay|Binta]] op bezoek\n' : null; };

const B = G.bereken({ vault: dir, steunbord: steun, reizen: reizen, reis_tekst: reisTekst, vandaag: '2026-11-25' });
const kaart = function (naam) { return B.personen.find(function (p) { return p.naam === naam; }); };

t('alleen type persoon met gambia_contact ja, David Schaap overgeslagen; beëindigd onderaan', function () {
  assert.deepStrictEqual(B.personen.map(function (p) { return p.naam; }), ['Abdou Jallow', 'Binta Ceesay', 'Omar Sowe', 'Lamin Touray']);
  assert.strictEqual(kaart('Lamin Touray').gestopt, true);
  assert.strictEqual(kaart('Abdou Jallow').rol, 'taxichauffeur');
});
t('laatste contact GM over twee dumps, jij en zij apart', function () {
  const c = kaart('Abdou Jallow').contact;
  assert.deepStrictEqual(c.GM, { laatst: '2026-11-18 07:00', jij: '2026-11-12 20:10', zij: '2026-11-18 07:00', nummers: 1 });
  assert.strictEqual(c.NL, null, 'groep en Nederlands nummer tellen niet (MOET 1)');
  assert.strictEqual(kaart('Abdou Jallow').dagen_stil, 7);
});
t('NL-kant via entiteit en LSN-nummer', function () {
  assert.deepStrictEqual(kaart('Binta Ceesay').contact.NL, { laatst: '2026-11-22 15:03', jij: '2026-11-22 13:40', zij: '2026-11-22 15:03', nummers: 1 });
});
t('twijfel en nieuw niet toegewezen; rector-nummer = genoemd, dus twijfel', function () {
  const z = B.zonder_naam.map(function (x) { return x.nummer + ':' + x.oordeel + ':' + x.kandidaten.join('/'); });
  assert.deepStrictEqual(z, ['+220 700 5555:twijfel:Omar Sowe', '+220 700 9999:nieuw:', '+220 700 4444:twijfel:Lamin Touray/Omar Sowe']);
  assert.strictEqual(kaart('Omar Sowe').contact.GM, null);
  assert.strictEqual(kaart('Lamin Touray').contact.GM.laatst, '2026-09-01 10:00');
});
t('wat speelt = jongste gedateerde kop, eerste regel zonder opmaak', function () {
  const s = kaart('Abdou Jallow').speelt;
  assert.strictEqual(s.datum, '2026-11-20');
  assert.strictEqual(s.kop, '20 november 2026 — vraagt naar de watertank');
  assert.strictEqual(s.regel, 'Hij vroeg of de tank al besteld is bij Binta.');
  assert.strictEqual(kaart('Binta Ceesay').speelt, null);
  assert.strictEqual(G.kopDatum('Stand 16 september 2026 (Telegram)', null), '2026-09-16');
  assert.strictEqual(G.kopDatum('6–13 november 2026 — warm', null), '2026-11-13');
  assert.strictEqual(G.kopDatum('3-10 — los', 2026), null, 'd-m zonder jaar is geen kopdatum');
});
t('steun uit het steunbord: open en niet zeker apart; geen steunbord = null (niet 0)', function () {
  const s = kaart('Abdou Jallow').steun;
  assert.deepStrictEqual(s.open.map(function (x) { return x.wat; }), ['Watertank']);
  assert.deepStrictEqual(s.niet_zeker.map(function (x) { return x.wat; }), ['Fiets']);
  assert.deepStrictEqual(kaart('Binta Ceesay').steun, { som: {}, betalingen: 0, open: [], niet_zeker: [] });
  const zonder = G.bereken({ vault: dir, steunbord: null, steunbord_fout: true, reizen: reizen, reis_tekst: reisTekst, vandaag: '2026-11-25' });
  assert.strictEqual(zonder.personen[0].steun, null); assert.strictEqual(zonder.bron.steunbord, 'fout');
  assert.strictEqual(zonder.reis.briefing.beloofd, null, 'ZOU 2: geen aantal toezeggingen zonder steunbord');
});
t('reisbriefing: eerstvolgende Gambiareis; binnen 14 dagen briefing, wie in het plan staat eerst', function () {
  const r = B.reis;
  assert.strictEqual(r.reis.id, 'bbbbbbbbbbbb'); assert.strictEqual(r.reis.over_dagen, 10); assert.strictEqual(r.reis.briefing_vanaf, '2026-11-21');
  assert.deepStrictEqual(r.briefing.mensen.map(function (m) { return m.naam + (m.in_plan ? '*' : ''); }), ['Binta Ceesay*', 'Abdou Jallow', 'Omar Sowe']);
  assert.strictEqual(r.briefing.beloofd, 1);
  const vroeg = G.bereken({ vault: dir, steunbord: steun, reizen: reizen, reis_tekst: reisTekst, vandaag: '2026-11-01' });
  assert.strictEqual(vroeg.reis.briefing, null); assert.strictEqual(vroeg.reis.reis.over_dagen, 34);
  assert.deepStrictEqual(G.bereken({ vault: dir, steunbord: steun, reizen: [], vandaag: '2026-11-25' }).reis, { reis: null });
  assert.strictEqual(G.bereken({ vault: dir, steunbord: steun, reizen: null, vandaag: '2026-11-25' }).reis, null);
});
t('ochtendregel één keer per (reis, vertrekdatum); verschoven reis meldt opnieuw (MOET 2)', function () {
  const r = G.ochtendRegel(B, {});
  assert.strictEqual(r.sleutel, 'bbbbbbbbbbbb:2026-12-05'); assert.strictEqual(r.onderwerp, 'reis-bbbbbbbbbbbb-20261205');
  assert.strictEqual(r.tekst, 'Over 10 dagen vertrek (Gambia 2026 december). Je briefing staat klaar: 3 mensen, 1 open toezegging.');
  assert.strictEqual(G.ochtendRegel(B, { 'bbbbbbbbbbbb:2026-12-05': 'x' }), null);
  const verschoven = G.bereken({ vault: dir, steunbord: steun, reizen: [Object.assign({}, reizen[1], { van: '2026-12-06' })], reis_tekst: reisTekst, vandaag: '2026-11-25' });
  assert.strictEqual(G.ochtendRegel(verschoven, { 'bbbbbbbbbbbb:2026-12-05': 'x' }).sleutel, 'bbbbbbbbbbbb:2026-12-06');
  const vroeg = G.bereken({ vault: dir, steunbord: steun, reizen: reizen, vandaag: '2026-11-01' });
  assert.strictEqual(G.ochtendRegel(vroeg, {}), null);
});
t('gmNummer: alleen 220 + 7 cijfers @c.us', function () {
  assert.deepStrictEqual(G.gmNummer('2207223769@c.us'), { nummer: '2207223769', zeven: '7223769' });
  assert.strictEqual(G.gmNummer('31617223769@c.us'), null); assert.strictEqual(G.gmNummer('120363@g.us'), null); assert.strictEqual(G.gmNummer('22072237690@c.us'), null);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(n + ' / 9 groen');
