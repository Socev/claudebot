#!/usr/bin/env bash
# wv3723: toetst bandjes-kaart.js (afmaakkaart 2C22, belkaart 2C91c, oude verzamelkaart op in de nieuwe) en het gelijktrekken van de tekst met
# het gemaakte geluid in bandjes.js (2C91a: route gelijk, gelijk_kan, versie/status blijven, hash mee in laatste bestand, spreektekst en
# werkversie, versiegeschiedenis, weigeren als het voorstel anders klinkt of de spreektekst na het maken wijzigde). Verzonnen bandjes, een
# wegwerpmap; raakt de echte vault niet. Gebruik: bash test/bandjes-kaart.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const B = require('./bandjes.js'), K = require('./bandjes-kaart.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 500) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bandjes-kaart-'));
const VAULT = path.join(W, 'vault'), DIR = path.join(W, 'bandjes');
const TG = path.join(VAULT, B.PRAKTIJKEN.tolgaarde.pad), GH = path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad);
fs.mkdirSync(path.dirname(TG), { recursive: true }); fs.mkdirSync(path.dirname(GH), { recursive: true });
const OUDE = 'Welkom bij de Proefpraktijk. Voorheen Oude Naam. Voor spoed, kies 1. Zie www.proefpraktijk.nl.';
const NIEUW = 'Welkom bij de Proefpraktijk. Voor spoed, kies 1. Zie www.proefpraktijk.nl.';
const h = B.tekstHash;
const reg = (pr, secties) => `---\ntype: register\nupdated: 2026-10-01\n---\n\n# Telefoonbandjes\n\n## Praktijkinstellingen\n- praktijkstem: piper:nl_NL-ronnie-medium\n\n${secties}\n## Versiegeschiedenis\n\n(nog geen versies)\n`;
const sectie = (id, naam, o) => `## ${id} — ${naam}\n- menu: hoofdnummer; 1 spoed\n- wanneer: ${o.wanneer || 'werkdagen'}\n${o.tv ? '- tijdvensters: ' + o.tv + '\n' : ''}- stem: praktijkstem\n- versie: ${o.versie}\n- laatste bestand: ${o.lb || '—'}\n- in centrale: ${o.ic || '—'}\n- status: ${o.status}\n\n**Tekst**\n> ${o.tekst}\n${o.voorstel ? '\n**Voorstel van Socev** (23-10-2026, reden: proef)\n> ' + o.voorstel + '\n' : ''}${o.spreek ? '\n**Spreektekst** (bij v1, tekst ' + o.spreekBij + ', 22-10-2026)\n> ' + o.spreek + '\n' : ''}\n`;
const JOB = 'aaaaaaaaaaaaaaaa', JOB2 = 'bbbbbbbbbbbbbbbb';
const spreekNieuw = require('./spreektekst.js').afleiden(NIEUW);
function schrijfRegs(extraGh) {
  fs.writeFileSync(TG, reg('tolgaarde', sectie('tg-buiten', 'Buiten kantooruren', { versie: 2, tv: 'ma-vr 00:00-08:00; ma-vr 17:00-24:00; za-zo 00:00-24:00',
    lb: `23-10-2026 · v2 · tekst ${h('Tekst twee van buiten.')} · ${JOB2}/bandje.wav · piper:x (+ telefoon PCM en µ-law)`, ic: 'v1 sinds 22-10-2026, [[x]]', status: 'gemaakt (v2)', tekst: 'Tekst twee van buiten.' }) +
    sectie('tg-hoofdmenu', 'Welkom', { versie: 1, ic: 'v1 sinds 22-10-2026, [[y]]', status: 'in centrale (v1)', tekst: 'Welkom bij Tolgaarde.' })));
  fs.writeFileSync(GH, reg('groenhouten', sectie('gh-koffiepauze', 'Koffiepauze', Object.assign({ versie: 2, lb: `22-10-2026 · v2 · tekst ${h(OUDE)} · ${JOB}/bandje.wav · piper:x (+ telefoonversies PCM en µ-law)`,
    ic: 'v1 sinds 22-10-2026, [[z]]', status: 'gemaakt (v2)', tekst: OUDE, voorstel: NIEUW, spreek: spreekNieuw, spreekBij: h(OUDE) }, extraGh || {}))));
}
schrijfRegs();
let taak = null;   // Studio-taak van het laatste bestand (gezegd)
const studio = { taak: function (id) { return taak && taak.id === id ? taak : null; }, lopend: function () { return { taken: [] }; }, flows: async function () { return { flows: [] }; } };
let klokMs = Date.parse('2026-11-21T14:00:00Z');
const S = B.maak({ vault: VAULT, dir: DIR, klok: () => klokMs });
S.mkdir();
const R = B.routes({ opslag: S, dir: DIR, primair: () => true, studio: studio });

(async function () {
  // ── 2C91a gelijktrekken ──
  let st = R.kaartStand();
  let kp = st[1].bandjes.find((x) => x.id === 'gh-koffiepauze');
  toets('a: zonder taak en zonder journaal-spreekwijziging: gelijk_kan (spreektekst = voorstel)', kp.gelijk_kan === true, kp.gelijk_kan);
  taak = { id: JOB, status: 'klaar', bron: { soort: 'bandje', praktijk: 'groenhouten', bandje: 'gh-koffiepauze', tekst_hash: h(OUDE) }, velden: { tekst: 'Welkom bij de Proefpraktijk. [pause] Voor spoed, kies één. [pause] Zie w w w punt proefpraktijk punt n l.' } };
  st = R.kaartStand(); kp = st[1].bandjes.find((x) => x.id === 'gh-koffiepauze');
  toets('a: met de Studio-taak (wat de stem zei) = voorstel: gelijk_kan', kp.gelijk_kan === true, kp.gelijk_kan);
  taak.velden.tekst = 'Welkom bij de Proefpraktijk. [pause] Voorheen Oude Naam. [pause] Voor spoed, kies één.';
  st = R.kaartStand(); kp = st[1].bandjes.find((x) => x.id === 'gh-koffiepauze');
  toets('a: stem zei iets anders dan het voorstel: niet gelijk_kan', kp.gelijk_kan === false, kp.gelijk_kan);
  let r = await R.app('POST /app/bandjes/gelijk', { praktijk: 'groenhouten', bandje: 'gh-koffiepauze', versie: 2, tekst_hash: h(OUDE) }, {});
  toets('a: route weigert dan met 409 en laat het register staan', r.status === 409 && /klinkt anders/.test(r.j.fout) && fs.readFileSync(GH, 'utf8').includes('Voorheen Oude Naam'), r);
  taak.velden.tekst = 'Welkom bij de Proefpraktijk. [long pause] Voor spoed, kies één. <break time="0.8s" /> Zie w w w punt proefpraktijk punt n l.';
  r = await R.app('POST /app/bandjes/gelijk', { praktijk: 'groenhouten', bandje: 'gh-koffiepauze', versie: 1, tekst_hash: h(OUDE) }, {});
  toets('a: verkeerde versie = 409 gewijzigd', r.status === 409 && r.j.gewijzigd === true, r);
  // werkversie op de bewaarplek met de oude hash
  const wm = path.join(DIR, 'werkversies', 'groenhouten', 'gh-koffiepauze');
  fs.mkdirSync(path.join(wm, 'b'), { recursive: true }); fs.writeFileSync(path.join(wm, 'b', '1'), 'RIFF');
  fs.writeFileSync(path.join(wm, 'meta.json'), JSON.stringify({ job: JOB, versie: 2, tekst_hash: h(OUDE), bestanden: [{ n: 1, naam: 'bandje-telefoon-ulaw.wav' }] }));
  r = await R.app('POST /app/bandjes/gelijk', { praktijk: 'groenhouten', bandje: 'gh-koffiepauze', versie: 2, tekst_hash: h(OUDE) }, {});
  const md = fs.readFileSync(GH, 'utf8');
  toets('a: gelijk geslaagd: tekst = voorstel, voorstel weg', r.status === 200 && r.j.bandje.tekst === NIEUW && !r.j.bandje.voorstel, r);
  toets('a: versie en status blijven (geen nieuw geluid)', r.j.bandje.versie === 2 && r.j.bandje.status === 'gemaakt (v2)', r.j.bandje);
  toets('a: laatste bestand en spreektekst dragen de nieuwe hash; kan_centrale blijft waar', md.includes('tekst ' + h(NIEUW) + ' · ' + JOB) && /\*\*Spreektekst\*\* \(bij v2, tekst [0-9a-f]{16}/.test(md) && r.j.bandje.spreek_eigen.bij === h(NIEUW) && r.j.bandje.kan_centrale === true, md);
  toets('a: de tekst uit de centrale (v1) staat in de versiegeschiedenis', /### gh-koffiepauze v1 — vervangen 21-11-2026\n> Welkom bij de Proefpraktijk\. Voorheen Oude Naam/.test(md), md.slice(-400));
  toets('a: de bewaarde werkversie hoort nu bij de nieuwe hash', JSON.parse(fs.readFileSync(path.join(wm, 'meta.json'), 'utf8')).tekst_hash === h(NIEUW));
  toets('a: journaal noteert gelijk met de nieuwe hash', fs.readFileSync(path.join(DIR, 'journaal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).some((j) => j.actie === 'gelijk' && j.tekst_hash === h(NIEUW)));
  const lees = S.lees('groenhouten');
  toets('a: register daarna niet dicht (geen "teruggezet")', !lees.dicht, lees.dicht);
  // spreektekst ná het maken gewijzigd (zonder taak): nee
  schrijfRegs(); taak = null;
  fs.writeFileSync(path.join(DIR, 'journaal.jsonl'), [{ tijd: '2026-10-22T20:27:55.000Z', praktijk: 'groenhouten', bandje: 'gh-koffiepauze', actie: 'gemaakt', versie: 2, tekst_hash: h(OUDE) },
    { tijd: '2026-10-22T21:00:00.000Z', praktijk: 'groenhouten', bandje: 'gh-koffiepauze', actie: 'spreektekst', versie: 2, tekst_hash: h(OUDE) }].map(JSON.stringify).join('\n') + '\n');
  r = await R.app('POST /app/bandjes/gelijk', { praktijk: 'groenhouten', bandje: 'gh-koffiepauze', versie: 2, tekst_hash: h(OUDE) }, {});
  toets('a: spreektekst na het maken gewijzigd en geen taak: 409', r.status === 409 && /na het maken/.test(r.j.fout), r);
  fs.writeFileSync(path.join(DIR, 'journaal.jsonl'), '');
  // niet gemaakt (status concept) = nee
  schrijfRegs({ status: 'concept (v2)' });
  r = await R.app('POST /app/bandjes/gelijk', { praktijk: 'groenhouten', bandje: 'gh-koffiepauze', versie: 2, tekst_hash: h(OUDE) }, {});
  toets('a: niet gemaakt: 409', r.status === 409 && /gemaakt bandje/.test(r.j.fout), r);
  schrijfRegs();

  // ── 2C22 afmaakkaart ──
  const nu = Date.parse('2026-11-21T13:00:00Z');   // za 14:00 NL
  let pl = K.plan({ praktijken: R.kaartStand(), punten: [], nu: nu, nuKort: '21-11 14:00' });
  const sl = pl.zet.map((k) => k.sleutel).sort();
  toets('2C22: precies één kaart per gemaakt bandje dat niet in de centrale staat', JSON.stringify(sl) === JSON.stringify(['bandjes-af-groenhouten-gh-koffiepauze-v2', 'bandjes-af-tolgaarde-tg-buiten-v2']), sl);
  const kt = pl.zet.find((k) => k.sleutel === 'bandjes-af-tolgaarde-tg-buiten-v2');
  toets('2C22: tik landt op het geluid van dat bandje', kt.herkomst.doel.scherm === 'bandjes' && kt.herkomst.doel.focus === 'geluid:tolgaarde/tg-buiten', kt.herkomst);
  toets('2C22: klikpad MijnKPN en Staat in de centrale in de stappen', kt.stappen.some((s) => s.includes(K.MIJNKPN_PAD)) && kt.stappen.some((s) => /Staat in de centrale/.test(s)), kt.stappen);
  toets('2C22: geen pad, wv-nummer of vaultpad in de kaart', !/wv\d|\/opt\/|\d\d_[A-Z]|\.md\b/.test(JSON.stringify([kt.titel, kt.waarom, kt.stappen])));
  const kk = pl.zet.find((k) => k.sleutel === 'bandjes-af-groenhouten-gh-koffiepauze-v2');
  toets('2C22 + a: bij een gelijk te trekken voorstel staat die stap in de kaart', kk.stappen.some((s) => /gelijktrekken/.test(s)), kk.stappen);
  const punten = sl.map((s) => ({ sleutel: s, status: 'open', gesloten_door: null }));
  pl = K.plan({ praktijken: R.kaartStand(), punten: punten, nu: nu });
  toets('2C22: opnieuw maken (zelfde versie, kaart bestaat) = geen tweede kaart', pl.zet.length === 0 && pl.dicht.length === 0, pl);
  pl = K.plan({ praktijken: R.kaartStand(), punten: [{ sleutel: 'bandjes-af-tolgaarde-tg-buiten-v2', status: 'gedaan', gesloten_door: 'david' }], nu: nu });
  toets('2C22: door David gedaan blijft dicht (niet heropend, geen nieuwe)', !pl.zet.some((k) => k.sleutel === 'bandjes-af-tolgaarde-tg-buiten-v2') && pl.open.length === 0, pl);
  pl = K.plan({ praktijken: R.kaartStand(), punten: [{ sleutel: 'bandjes-af-tolgaarde-tg-buiten-v2', status: 'gedaan', gesloten_door: 'agent' }], nu: nu });
  toets('2C22: door de ronde gesloten en weer klaar = dezelfde kaart weer open', pl.open.length === 1 && pl.open[0].sleutel === 'bandjes-af-tolgaarde-tg-buiten-v2', pl);
  // Staat in de centrale → dicht
  const taakTg = { id: JOB2, status: 'klaar', bron: { soort: 'bandje', praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst_hash: h('Tekst twee van buiten.') }, velden: { tekst: 'Tekst twee van buiten.' } };
  taak = taakTg;
  const best = path.join(W, 'best'); fs.mkdirSync(best);
  ['bandje.wav', 'bandje-telefoon-ulaw.wav', 'bandje-telefoon-pcm.wav'].forEach((n) => fs.writeFileSync(path.join(best, n), 'RIFF' + n));
  const R2 = B.routes({ opslag: S, dir: DIR, primair: () => true, studio: studio, bestandVan: (j) => j === JOB2 ? ['bandje.wav', 'bandje-telefoon-ulaw.wav', 'bandje-telefoon-pcm.wav'].map((n, i) => ({ n: i + 1, naam: n, pad: path.join(best, n) })) : null });
  r = await R2.app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: 2, tekst_hash: h('Tekst twee van buiten.') }, {});
  toets('2C22: Staat in de centrale lukt (toetsopzet)', r.status === 200, r);
  pl = K.plan({ praktijken: R2.kaartStand(), punten: punten.concat([{ sleutel: 'wv3073', status: 'later' }]), nu: nu, nuKort: '21-11 14:00' });
  const d = pl.dicht.find((x) => x.sleutel === 'bandjes-af-tolgaarde-tg-buiten-v2');
  toets('2C22: na Staat in de centrale gaat de kaart dicht met bewijs', d && /in de centrale gemarkeerd/.test(d.bewijs), pl.dicht);
  const oud = pl.dicht.find((x) => x.sleutel === 'wv3073');
  toets('oude verzamelkaart gaat op in de nieuwe zodra beide bandjes gedekt zijn', oud && oud.samengevoegd_in === 'bandjes-af-groenhouten-gh-koffiepauze-v2', pl.dicht);
  pl = K.plan({ praktijken: R2.kaartStand(), punten: [{ sleutel: 'wv3073', status: 'later' }], nu: nu });
  toets('oude verzamelkaart blijft als de nieuwe kaart er nog niet is… behalve via het plan zelf', pl.dicht.some((x) => x.sleutel === 'wv3073'), pl);
  pl = K.plan({ praktijken: [{ id: 'groenhouten', ok: true, dicht: 'conflictkopie', bandjes: [] }], punten: punten.concat([{ sleutel: 'wv3073', status: 'later' }]), nu: nu });
  toets('register dicht: niets aan de kaarten van die praktijk', pl.zet.length === 0 && pl.dicht.length === 0, pl);

  // ── 2C91c belkaart ──
  const stand = R2.kaartStand();
  const tg = stand[0].bandjes.find((x) => x.id === 'tg-buiten');
  toets('c: toetsopzet: tg-buiten staat nu v2 in de centrale sinds 21-11', tg.centrale_versie === 2 && /sinds 21-11-2026/.test(tg.in_centrale), tg.in_centrale);
  pl = K.plan({ praktijken: stand, punten: [], nu: Date.parse('2026-11-23T12:00:00Z') });   // ma 13:00: speelt niet
  toets('c: buiten het tijdvenster nog geen belkaart', !pl.zet.some((k) => /^bandjes-bel-/.test(k.sleutel)), pl.zet.map((k) => k.sleutel));
  pl = K.plan({ praktijken: stand, punten: [], nu: Date.parse('2026-11-23T16:30:00Z') });   // ma 17:30: speelt
  const bel = pl.zet.find((k) => k.sleutel === 'bandjes-bel-tolgaarde-tg-buiten-v2');
  toets('c: op het eerste speelmoment precies één belkaart met het nummer', !!bel && pl.zet.filter((k) => /^bandjes-bel-/.test(k.sleutel)).length === 1 && bel.stappen[0].includes('033-494 12 10'), pl.zet);
  pl = K.plan({ praktijken: stand, punten: [{ sleutel: 'bandjes-bel-tolgaarde-tg-buiten-v2', status: 'open' }], nu: Date.parse('2026-11-23T17:30:00Z') });
  toets('c: de kaart komt één keer (bestaat al = niets)', !pl.zet.some((k) => /^bandjes-bel-/.test(k.sleutel)), pl.zet);
  pl = K.plan({ praktijken: stand, punten: [], nu: Date.parse('2026-11-23T23:30:00Z') });   // di 00:30: speelt, maar stille uren
  toets('c: niet tussen 23:00 en 07:00', !pl.zet.some((k) => /^bandjes-bel-/.test(k.sleutel)), pl.zet);
  pl = K.plan({ praktijken: stand, punten: [], nu: Date.parse('2026-12-05T16:30:00Z') });
  toets('c: na zeven dagen geen belkaart meer', !pl.zet.some((k) => /^bandjes-bel-/.test(k.sleutel)), pl.zet);
  const hm = stand[0].bandjes.find((x) => x.id === 'tg-hoofdmenu');
  toets('c: bandjes die in oktober al in de centrale stonden krijgen geen belkaart', !K.plan({ praktijken: stand, punten: [], nu: Date.parse('2026-11-23T08:00:00Z') }).zet.some((k) => k.sleutel.includes('tg-hoofdmenu')) && hm.centrale_versie === 1);
  pl = K.plan({ praktijken: stand, punten: [{ sleutel: 'bandjes-bel-tolgaarde-tg-buiten-v2', status: 'gedaan', gesloten_door: 'david' }], nu: Date.parse('2026-11-23T17:30:00Z') });
  toets('c: door David gedaan → gehoord in het register', pl.gehoord.length === 1 && pl.gehoord[0].versie === 2, pl.gehoord);
  r = R2.zetGehoord('tolgaarde', 'tg-buiten', 2);
  toets('c: zetGehoord schrijft het veld gehoord', r.status === 200 && /^- gehoord: v2 op /m.test(fs.readFileSync(TG, 'utf8')), r);
  pl = K.plan({ praktijken: R2.kaartStand(), punten: [{ sleutel: 'bandjes-bel-tolgaarde-tg-buiten-v2', status: 'gedaan', gesloten_door: 'david' }], nu: Date.parse('2026-11-23T17:30:00Z') });
  toets('c: daarna niet nog eens', pl.gehoord.length === 0, pl.gehoord);
  // vensters
  const v = K.vensters('ma-vr 00:00-08:00; za-zo 00:00-24:00; onzin');
  toets('vensters: twee gelezen, onzin genegeerd', v.length === 2 && v[1].dagen.has(6) && v[1].dagen.has(7) && !v[1].dagen.has(1));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
