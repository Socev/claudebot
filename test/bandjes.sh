#!/usr/bin/env bash
# Toetst bandjes.js (wv739, skelet van rij B): het register van de telefoonbandjes in de vault lezen en schrijven.
# Toetst: de echte registerpagina's (of een kopie die erop lijkt) lezen, lezer tolerant (kop met - of –, hoofdletters, lege regel in het
# citaat, ontbrekende versiegeschiedenis), dubbel id of verkeerd voorvoegsel = alleen-lezen, Bewaar met versie + tekst_hash (409 bij een
# verschil, ook als David in Obsidian de tekst wijzigt zonder de versie op te hogen), versiegeschiedenis, rest van de pagina byte-gelijk,
# teruggezet door de synchronisatie (journaal) en een .conflict-kopie = schrijven dicht, voorstel zetten/weghalen, nieuw bandje met
# uniek id, een tekst die de paginavorm probeert te breken, stuurtekens en lengte, tijdelijk bestand buiten de vault, rechten.
# Raakt de echte vault niet (alles in een wegwerpmap). Gebruik: bash test/bandjes.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const B = require('./bandjes.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bandjes-'));
const VAULT = path.join(W, 'vault'), DIR = path.join(W, 'bandjes');
const TG = path.join(VAULT, B.PRAKTIJKEN.tolgaarde.pad), GH = path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad);
fs.mkdirSync(path.dirname(TG), { recursive: true }); fs.mkdirSync(path.dirname(GH), { recursive: true });
const ECHT = '/opt/data/AI_SecondBrain';
const voorbeeld = (pr) => `---
type: register
updated: 2026-10-01
---

# Telefoonbandjes

Uitleg die blijft staan.

## Praktijkinstellingen
- praktijkstem: piper:nl_NL-ronnie-medium
- model: piper

## ${pr}-hoofdmenu — Welkom en keuzemenu
- menu: hoofdnummer
- wanneer: tijdens openingstijden
- stem: praktijkstem
- versie: 0
- laatste bestand: —
- status: tekst onbekend
- bron: proef

**Tekst**
> (onbekend — wacht op het huidige bandje)

Een notitie van David in de sectie.

## ${pr}-buiten — Buiten kantooruren
- menu: hoofdnummer
- wanneer: buiten openingstijden
- versie: 2
- status: in centrale

**Tekst**
> U belt buiten onze openingstijden.
> Voor spoed belt u 112.

## Historie (niet meer in gebruik)

- iets ouds

## Versiegeschiedenis

(nog geen versies)
`;
// echte pagina's als ze er zijn (lezen), anders het voorbeeld
for (const [pr, f] of [['tolgaarde', TG], ['groenhouten', GH]]) {
  const echt = path.join(ECHT, B.PRAKTIJKEN[pr].pad);
  if (fs.existsSync(echt)) {
    const p = B.parse(fs.readFileSync(echt, 'utf8'), B.PRAKTIJKEN[pr].voorvoegsel);
    toets('echte pagina ' + pr + ': leesbaar, geen fouten, ≥ 1 bandje', p.fouten.length === 0 && p.bandjes.length >= 1, p.fouten);
    toets('echte pagina ' + pr + ': praktijkinstellingen gelezen', 'praktijkstem' in p.instellingen, p.instellingen);
    toets('echte pagina ' + pr + ': onbekende tekst = leeg + onbekend', p.bandjes.every((b) => b.onbekend ? b.tekst === '' : b.tekst.length > 0));
  }
  fs.writeFileSync(f, voorbeeld(B.PRAKTIJKEN[pr].voorvoegsel));
}
let t = 1761120000000;
const klok = () => t;
const S = B.maak({ vault: VAULT, dir: DIR, klok: klok });

// ── lezen ──
let l = S.lees('tolgaarde');
toets('lezen: twee bandjes, open', l.status === 200 && l.bandjes.length === 2 && l.dicht === null, l);
const bu = l.bandjes.find((b) => b.id === 'tg-buiten');
toets('lezen: tekst uit het citaat, versie, hash', bu && bu.tekst === 'U belt buiten onze openingstijden.\nVoor spoed belt u 112.' && bu.versie === 2 && bu.tekst_hash === B.tekstHash(bu.tekst), bu);
toets('lezen: hoofdmenu onbekend', l.bandjes[0].onbekend === true && l.bandjes[0].tekst === '' && l.bandjes[0].versie === 0);
toets('lezen: onbekende praktijk = 404', S.lees('elders').status === 404);
toets('normTekst: CRLF, spaties aan het eind, lege randen', B.normTekst('\r\n a  \r\nb \n\n') === ' a\nb');

// tolerant
const los = `## tg-een - Eén
- Versie: 3
- STATUS: x

**Tekst**
> regel 1
>
> regel 3

## tg-twee – Twee
**tekst**
>  ingesprongen
`;
let p = B.parse(los, 'tg');
toets('tolerant: kop met - en –, veldnaam met hoofdletters', p.bandjes.length === 2 && p.bandjes[0].versie === 3 && p.bandjes[0].velden.status === 'x', p.bandjes);
toets('tolerant: lege citaatregel telt mee', p.bandjes[0].tekst === 'regel 1\n\nregel 3', p.bandjes[0].tekst);
toets('tolerant: **tekst** kleine letters, één spatie na > weg', p.bandjes[1].tekst === ' ingesprongen', p.bandjes[1].tekst);
const p2 = B.parse(los.replace('> regel 1\n>\n> regel 3', '> regel 1\n\n> regel 3'), 'tg');
toets('tolerant: echte lege regel tussen twee citaatregels telt mee', p2.bandjes[0].tekst === 'regel 1\n\nregel 3', p2.bandjes[0].tekst);
p = B.parse(los + '\n## tg-een — Dubbel\n**Tekst**\n> x\n', 'tg');
toets('dubbel id = fout', p.fouten.some((f) => /twee keer/.test(f)), p.fouten);
p = B.parse('## gh-iets — In de verkeerde pagina\n', 'tg');
toets('verkeerd voorvoegsel = fout', p.fouten.some((f) => /hoort niet bij/.test(f)), p.fouten);

// ── Bewaar ──
const voor = fs.readFileSync(TG, 'utf8');
let r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Nieuwe tekst.\nTweede regel.', versie: 2, tekst_hash: bu.tekst_hash });
toets('bewaar: 200, versie 3, status concept (v3)', r.status === 200 && r.bandje.versie === 3 && r.bandje.status === 'concept (v3)', r);
let na = fs.readFileSync(TG, 'utf8');
toets('bewaar: citaat geschreven', /\*\*Tekst\*\*\n> Nieuwe tekst\.\n> Tweede regel\.\n/.test(na), na);
toets('bewaar: frontmatter updated bijgewerkt', /updated: 2025-10-22/.test(na) || /updated: \d{4}-\d{2}-\d{2}/.test(na) && !/updated: 2026-10-01/.test(na));
const sectieVan = (md, id) => { const i = md.indexOf('## ' + id); const j = md.indexOf('\n## ', i + 3); return md.slice(i, j); };
toets('bewaar: ander bandje byte-gelijk', sectieVan(voor, 'tg-hoofdmenu') === sectieVan(na, 'tg-hoofdmenu'));
toets('bewaar: notitie van David in de sectie blijft staan', na.includes('Een notitie van David in de sectie.'));
toets('bewaar: kop, uitleg en historie blijven staan', na.includes('Uitleg die blijft staan.') && na.includes('- iets ouds'));
toets('bewaar: oude tekst in de versiegeschiedenis, placeholder weg', /### tg-buiten v2 — vervangen [\d-]+\n> U belt buiten onze openingstijden\.\n> Voor spoed belt u 112\./.test(na) && !na.includes('(nog geen versies)'), na.slice(na.indexOf('## Versiegeschiedenis')));
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Nog eens.', versie: 2, tekst_hash: bu.tekst_hash });
toets('bewaar met oude versie = 409 gewijzigd', r.status === 409 && r.gewijzigd === true, r);
l = S.lees('tolgaarde');
let b3 = l.bandjes.find((b) => b.id === 'tg-buiten');
// David wijzigt in Obsidian de tekst zonder de versie op te hogen
fs.writeFileSync(TG, fs.readFileSync(TG, 'utf8').replace('> Tweede regel.', '> Tweede regel, door David.'));
t += 1000;
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Overschrijft David.', versie: b3.versie, tekst_hash: b3.tekst_hash });
toets('Obsidian-wijziging zonder versie: Bewaar met oude hash = 409', r.status === 409 && r.gewijzigd === true, r);
l = S.lees('tolgaarde'); b3 = l.bandjes.find((b) => b.id === 'tg-buiten');
toets('Obsidian-wijziging: lezer ziet Davids tekst', b3.tekst.includes('door David'), b3.tekst);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Versie vier.', versie: b3.versie, tekst_hash: b3.tekst_hash });
toets('bewaar na herladen: 200, versie 4', r.status === 200 && r.bandje.versie === 4, r);
na = fs.readFileSync(TG, 'utf8');
toets('versiegeschiedenis: twee items, nieuwste onderaan', (na.match(/### tg-buiten v/g) || []).length === 2 && na.indexOf('### tg-buiten v2') < na.indexOf('### tg-buiten v3'));
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Versie vier.', versie: 4, tekst_hash: B.tekstHash('Versie vier.') });
toets('zelfde tekst opnieuw = ongewijzigd, geen nieuwe versie', r.status === 200 && r.ongewijzigd === true && S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten').versie === 4, r);
// onbekend → eerste tekst: geen versiegeschiedenis van de placeholder
const hm = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-hoofdmenu');
r = S.zetTekst('tolgaarde', 'tg-hoofdmenu', { tekst: 'Welkom bij Tolgaarde.', versie: hm.versie, tekst_hash: hm.tekst_hash });
na = fs.readFileSync(TG, 'utf8');
toets('eerste tekst bij een onbekend bandje: v1, placeholder niet in de geschiedenis', r.status === 200 && r.bandje.versie === 1 && !/### tg-hoofdmenu/.test(na) && na.includes('Een notitie van David in de sectie.'), r);

// grenzen en vorm
const kwaad = 'Gewone regel\n## tg-kwaad — Ingeschoven\n- versie: 99\n**Tekst**\n> nep\n**Voorstel van Socev**';
let bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: kwaad, versie: bx.versie, tekst_hash: bx.tekst_hash });
l = S.lees('tolgaarde');
bx = l.bandjes.find((b) => b.id === 'tg-buiten');
toets('tekst die de vorm wil breken: zelfde bandjes, geen fouten, tekst rond-trip', r.status === 200 && l.bandjes.length === 2 && l.fouten.length === 0 && bx.tekst === kwaad && bx.versie === 5 && !bx.voorstel, { l: l.bandjes.map((b) => b.id), t: bx.tekst });
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'a\u0007b‮c', versie: bx.versie, tekst_hash: bx.tekst_hash });
toets('stuurtekens en bidi weg', r.status === 200 && r.bandje.tekst === 'abc', r);
bx = r.bandje;
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'x'.repeat(1501), versie: bx.versie, tekst_hash: bx.tekst_hash });
toets('langer dan 1.500 tekens = 400', r.status === 400, r);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: '  \n ', versie: bx.versie, tekst_hash: bx.tekst_hash });
toets('lege tekst = 400', r.status === 400, r);
r = S.zetTekst('tolgaarde', 'tg-bestaat-niet', { tekst: 'x', versie: 0, tekst_hash: '' });
toets('onbekend bandje = 404', r.status === 404, r);

// ── voorstel ──
r = S.zetVoorstel('tolgaarde', 'tg-buiten', { tekst: 'Kijk op huisartsenposteemland.nl.', reden: 'kernboodschap HAP' });
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('voorstel: gezet, tekst ongemoeid, versie gelijk', r.status === 200 && bx.voorstel && bx.voorstel.tekst === 'Kijk op huisartsenposteemland.nl.' && /reden: kernboodschap HAP/.test(bx.voorstel.kop) && bx.tekst === 'abc' && bx.versie === 6, bx);
r = S.zetVoorstel('tolgaarde', 'tg-buiten', { tekst: 'Tweede voorstel.', reden: 'beter' });
na = fs.readFileSync(TG, 'utf8');
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('voorstel: hooguit één open voorstel (overschreven)', (na.match(/^\*\*Voorstel van Socev\*\*/gm) || []).length === 1 && bx.voorstel.tekst === 'Tweede voorstel.', na);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Tweede voorstel.', versie: bx.versie, tekst_hash: bx.tekst_hash, voorstel_weg: true });
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('bewaar met voorstel_weg: tekst bewaard, voorstel weg', r.status === 200 && bx.tekst === 'Tweede voorstel.' && !bx.voorstel && bx.versie === 7, bx);
S.zetVoorstel('tolgaarde', 'tg-buiten', { tekst: 'Derde.', reden: '' });
r = S.haalVoorstelWeg('tolgaarde', 'tg-buiten');
na = fs.readFileSync(TG, 'utf8');
toets('voorstel laten liggen: blok weg, tekst ongemoeid', r.status === 200 && !/^\*\*Voorstel van Socev/m.test(na) && r.bandje.tekst === 'Tweede voorstel.', r);

// ── velden ──
r = S.zetVelden('tolgaarde', 'tg-buiten', { 'in centrale': 'v7, 22-10-2026', versie: '99', 'laatste bestand': 'x' }, { versie: 7 });
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('velden: alleen toegestane sleutels (versie niet)', r.status === 200 && bx.in_centrale === 'v7, 22-10-2026' && bx.versie === 7 && bx.laatste_bestand === 'x', bx);
r = S.zetVelden('tolgaarde', 'tg-buiten', { status: 'gemaakt (v6)' }, { versie: 6 });
toets('velden met verouderde versie = 409', r.status === 409, r);

// ── nieuw ──
r = S.nieuw('groenhouten', { naam: 'Vakantie zomer', menu: 'hoofdnummer', wanneer: 'juli' });
toets('nieuw: id gh-vakantie-zomer, onbekend, v0', r.status === 200 && r.bandje.id === 'gh-vakantie-zomer' && r.bandje.onbekend && r.bandje.versie === 0, r);
r = S.nieuw('groenhouten', { naam: 'Vakantie zomer', tekst: 'Wij zijn met vakantie.' });
toets('nieuw: dubbele naam krijgt -2, met tekst = v1', r.status === 200 && r.bandje.id === 'gh-vakantie-zomer-2' && r.bandje.versie === 1 && r.bandje.tekst === 'Wij zijn met vakantie.', r);
r = S.nieuw('groenhouten', { naam: 'Één & ánder!' });
toets('nieuw: slug ASCII', r.status === 200 && r.bandje.id === 'gh-een-ander', r);
na = fs.readFileSync(GH, 'utf8');
toets('nieuw: vóór de historie', na.indexOf('## gh-vakantie-zomer ') < na.indexOf('## Historie'), na);
toets('nieuw: zonder naam = 400', S.nieuw('groenhouten', { naam: '  ' }).status === 400);

// ── synchronisatie ──
const vorige = fs.readFileSync(TG, 'utf8');
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Versie acht.', versie: bx.versie, tekst_hash: bx.tekst_hash });
toets('voorbereiding: versie 8 bewaard', r.status === 200 && r.bandje.versie === 8, r);
S.lees('tolgaarde');   // cache gevuld met v8: de teruggezette kopie moet de cache toch verversen (mtime ouder)
fs.writeFileSync(TG, vorige);   // bisync zet een oudere kopie terug (zelfde grootte kan, mtime ouder)
fs.utimesSync(TG, new Date(t / 1000 - 3600), new Date((t - 3600 * 1000) / 1000));
l = S.lees('tolgaarde');
toets('teruggezet door de synchronisatie: dicht, met reden', l.dicht && /teruggezet/.test(l.dicht) && l.teruggezet.length === 1, l.dicht);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Toch?', versie: 7, tekst_hash: l.bandjes.find((b) => b.id === 'tg-buiten').tekst_hash });
toets('teruggezet: Bewaar = 409 dicht', r.status === 409 && r.dicht === true, r);
const jr = fs.readFileSync(path.join(DIR, 'journaal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((j) => j.bandje === 'tg-buiten' && j.versie === 8);
toets('journaal: tekst van v8 terug te halen', jr.length === 1 && jr[0].tekst === 'Versie acht.', jr);
fs.writeFileSync(GH + '.conflict1', 'x');
l = S.lees('groenhouten');
toets('conflictkopie naast de pagina: dicht, met naam', l.dicht && /Bandjes\.md\.conflict1/.test(l.dicht), l.dicht);
toets('conflictkopie: nieuw bandje geweigerd', S.nieuw('groenhouten', { naam: 'Nog een' }).status === 409);
fs.unlinkSync(GH + '.conflict1');
toets('conflict opgelost: weer open', S.lees('groenhouten').dicht === null);
fs.writeFileSync(GH, fs.readFileSync(GH, 'utf8') + '\n## gh-buiten — Dubbel\n**Tekst**\n> x\n');
l = S.lees('groenhouten');
toets('dubbel id in de pagina: dicht en niets geschreven', l.dicht && /twee keer/.test(l.dicht) && S.nieuw('groenhouten', { naam: 'X' }).status === 409, l.dicht);

// ── bestanden ──
const tmpDir = path.join(DIR, 'tmp');
toets('tijdelijk bestand buiten de vault, niets achtergebleven', fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length === 0 && !fs.readdirSync(path.dirname(TG)).some((n) => n !== 'Bandjes.md'));
toets('registerpagina 0644', (fs.statSync(path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad.replace('Bandjes.md', 'Bandjes.md'))).mode & 0o777) === 0o644 || (fs.statSync(TG).mode & 0o777) === 0o644, (fs.statSync(TG).mode & 0o777).toString(8));
toets('journaal 0600 buiten de vault', (fs.statSync(path.join(DIR, 'journaal.jsonl')).mode & 0o777) === 0o600 && !path.join(DIR, 'journaal.jsonl').startsWith(VAULT));

fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
