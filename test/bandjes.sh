#!/usr/bin/env bash
# Toetst bandjes.js (wv739, skelet van rij B): het register van de telefoonbandjes in de vault lezen en schrijven.
# Toetst: de echte registerpagina's (of een kopie die erop lijkt) lezen, lezer tolerant (kop met - of –, hoofdletters, lege regel in het
# citaat, ontbrekende versiegeschiedenis), dubbel id of verkeerd voorvoegsel = alleen-lezen, Bewaar met versie + tekst_hash (409 bij een
# verschil, ook als David in Obsidian de tekst wijzigt zonder de versie op te hogen), versiegeschiedenis, rest van de pagina byte-gelijk,
# teruggezet door de synchronisatie (journaal) en een .conflict-kopie = schrijven dicht, voorstel zetten/weghalen, nieuw bandje met
# uniek id, een tekst die de paginavorm probeert te breken, stuurtekens en lengte, tijdelijk bestand buiten de vault, rechten.
# wv830: versiemodel (vN in de centrale, hooguit één werkversie v(N+1); opnieuw maken of de tekst wijzigen overschrijft die), "Staat in centrale"
# alleen voor een gemaakte werkversie (hash), archief in de vault (nooit overschrijven), teruggezet op dezelfde versie, nieuw bandje.
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
- in centrale: v2, 1-10-2026
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
toets('wv830 bewaar op de werkversie: 200, nummer blijft v3 (overschrijft het concept)', r.status === 200 && r.bandje.versie === 3 && r.bandje.status === 'concept (v3)' && r.bandje.werkversie === 3 && r.bandje.centrale_versie === 2, r);
na = fs.readFileSync(TG, 'utf8');
toets('wv830 versiegeschiedenis: alleen de tekst uit de centrale (v2), geen concept', (na.match(/### tg-buiten v/g) || []).length === 1 && na.includes('### tg-buiten v2'));
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Versie vier.', versie: 3, tekst_hash: B.tekstHash('Versie vier.') });
toets('zelfde tekst opnieuw = ongewijzigd, geen nieuwe versie', r.status === 200 && r.ongewijzigd === true && S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten').versie === 3, r);
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
toets('tekst die de vorm wil breken: zelfde bandjes, geen fouten, tekst rond-trip', r.status === 200 && l.bandjes.length === 2 && l.fouten.length === 0 && bx.tekst === kwaad && bx.versie === 3 && !bx.voorstel, { l: l.bandjes.map((b) => b.id), t: bx.tekst });
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
toets('voorstel: gezet, tekst ongemoeid, versie gelijk', r.status === 200 && bx.voorstel && bx.voorstel.tekst === 'Kijk op huisartsenposteemland.nl.' && /reden: kernboodschap HAP/.test(bx.voorstel.kop) && bx.tekst === 'abc' && bx.versie === 3, bx);
r = S.zetVoorstel('tolgaarde', 'tg-buiten', { tekst: 'Tweede voorstel.', reden: 'beter' });
na = fs.readFileSync(TG, 'utf8');
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('voorstel: hooguit één open voorstel (overschreven)', (na.match(/^\*\*Voorstel van Socev\*\*/gm) || []).length === 1 && bx.voorstel.tekst === 'Tweede voorstel.', na);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Tweede voorstel.', versie: bx.versie, tekst_hash: bx.tekst_hash, voorstel_weg: true });
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('bewaar met voorstel_weg: tekst bewaard, voorstel weg', r.status === 200 && bx.tekst === 'Tweede voorstel.' && !bx.voorstel && bx.versie === 3, bx);
S.zetVoorstel('tolgaarde', 'tg-buiten', { tekst: 'Derde.', reden: '' });
r = S.haalVoorstelWeg('tolgaarde', 'tg-buiten');
na = fs.readFileSync(TG, 'utf8');
toets('voorstel laten liggen: blok weg, tekst ongemoeid', r.status === 200 && !/^\*\*Voorstel van Socev/m.test(na) && r.bandje.tekst === 'Tweede voorstel.', r);

// ── velden ──
r = S.zetVelden('tolgaarde', 'tg-buiten', { 'in centrale': 'v3, 22-10-2026', versie: '99', 'laatste bestand': 'x' }, { versie: 3 });
bx = S.lees('tolgaarde').bandjes.find((b) => b.id === 'tg-buiten');
toets('velden: alleen toegestane sleutels (versie niet)', r.status === 200 && bx.in_centrale === 'v3, 22-10-2026' && bx.versie === 3 && bx.laatste_bestand === 'x' && bx.centrale_versie === 3 && bx.werkversie === null && bx.volgende_versie === 4, bx);
r = S.zetVelden('tolgaarde', 'tg-buiten', { status: 'gemaakt (v2)' }, { versie: 2 });
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
toets('voorbereiding: tekst na de centrale (v3) = werkversie v4', r.status === 200 && r.bandje.versie === 4, r);
S.lees('tolgaarde');   // cache gevuld met v4: de teruggezette kopie moet de cache toch verversen (mtime ouder)
fs.writeFileSync(TG, vorige);   // bisync zet een oudere kopie terug (zelfde grootte kan, mtime ouder)
fs.utimesSync(TG, new Date(t / 1000 - 3600), new Date((t - 3600 * 1000) / 1000));
l = S.lees('tolgaarde');
toets('teruggezet door de synchronisatie: dicht, met reden', l.dicht && /teruggezet/.test(l.dicht) && l.teruggezet.length === 1, l.dicht);
r = S.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Toch?', versie: 3, tekst_hash: l.bandjes.find((b) => b.id === 'tg-buiten').tekst_hash });
toets('teruggezet: Bewaar = 409 dicht', r.status === 409 && r.dicht === true, r);
const jr = fs.readFileSync(path.join(DIR, 'journaal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((j) => j.bandje === 'tg-buiten' && j.versie === 4);
toets('journaal: tekst van v4 terug te halen', jr.length === 1 && jr[0].tekst === 'Versie acht.', jr);
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
// wv900: het tijdelijke bestand staat nu (willekeurige naam, O_EXCL) in de getoetste vaultmap zelf; na het schrijven is het weg
toets('geen tijdelijk bestand achtergebleven (vaultmap en pod-tmp)', (!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0) && !fs.readdirSync(path.dirname(TG)).some((n) => n !== 'Bandjes.md'));
{ // wv900: een map-symlink onderweg (socev) wordt niet gevolgd; een link op de registernaam ook niet
  const echt = path.dirname(GH), ander = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bandjes-ander-'));
  fs.copyFileSync(GH, path.join(ander, path.basename(GH))); const kopie = fs.readFileSync(GH, 'utf8');
  fs.renameSync(echt, echt + '-weg'); fs.symlinkSync(ander, echt);
  let geweigerd = false, r0 = null; try { r0 = S.nieuw('groenhouten', { naam: 'Via link' }); } catch (e) { geweigerd = true; }
  const leeg = fs.readdirSync(ander).length === 1 && fs.readFileSync(path.join(ander, path.basename(GH)), 'utf8') === kopie;
  fs.unlinkSync(echt); fs.renameSync(echt + '-weg', echt); fs.rmSync(ander, { recursive: true, force: true });
  toets('wv900 map-symlink: niets geschreven in de doelmap', leeg, geweigerd);
  // wv900 (Fable #7): symlink op de registerpagina zelf → dicht met reden, geen uitzondering
  const geheim = path.join(ander + '-g'); fs.writeFileSync(geheim, 'SLEUTEL=x\n');
  const bewaard = fs.readFileSync(GH); fs.unlinkSync(GH); fs.symlinkSync(geheim, GH);
  let l2 = null, gooit = false; try { l2 = S.lees('groenhouten'); } catch (e) { gooit = true; }
  fs.unlinkSync(GH); fs.writeFileSync(GH, bewaard); fs.rmSync(geheim, { force: true });
  toets('wv900 symlink op de registerpagina: dicht, geen uitzondering', !gooit && l2 && /symlink/.test(l2.dicht || '') && l2.bandjes.length === 0, gooit || l2);
}
toets('registerpagina 0644', (fs.statSync(path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad.replace('Bandjes.md', 'Bandjes.md'))).mode & 0o777) === 0o644 || (fs.statSync(TG).mode & 0o777) === 0o644, (fs.statSync(TG).mode & 0o777).toString(8));
toets('journaal 0600 buiten de vault', (fs.statSync(path.join(DIR, 'journaal.jsonl')).mode & 0o777) === 0o600 && !path.join(DIR, 'journaal.jsonl').startsWith(VAULT));


// ── wv830: versiemodel (vN in de centrale, hooguit één werkversie v(N+1)), journaal per hash, nieuw bandje ──
toets('wv830 centraleVersie: "v3 sinds …, [[…]]" = 3, "v1, 22-10-2026" = 1, "—" en leeg = 0', B.centraleVersie({ 'in centrale': 'v3 sinds 22-10-2026, [[x/y]]' }) === 3 && B.centraleVersie({ 'in centrale': 'v1, 22-10-2026' }) === 1 && B.centraleVersie({ 'in centrale': '—' }) === 0 && B.centraleVersie({}) === 0);
toets('wv830 laatsteVan: met en zonder tekst-hash', JSON.stringify(B.laatsteVan('22-10-2026 · v2 · s:x · tekst 0123456789abcdef · 84148f838e679769/bandje.wav (+ telefoon PCM en µ-law)')) === JSON.stringify({ versie: 2, job: '84148f838e679769', hash: '0123456789abcdef' }) &&
  JSON.stringify(B.laatsteVan('22-10-2026 · v1 · s:x · m · 84148f838e679769/bandje.wav')) === JSON.stringify({ versie: 1, job: '84148f838e679769', hash: null }) && B.laatsteVan('—') === null);
{
  const W3 = fs.mkdtempSync(path.join(os.tmpdir(), 'bandjes-830-'));
  const V3 = path.join(W3, 'vault'), D3 = path.join(W3, 'bandjes'), TG3 = path.join(V3, B.PRAKTIJKEN.tolgaarde.pad);
  fs.mkdirSync(path.dirname(TG3), { recursive: true });
  fs.writeFileSync(TG3, `---
updated: 2026-10-01
---

## tg-buiten — Buiten kantooruren
- menu: hoofdnummer
- versie: 1
- laatste bestand: 22-10-2026 · v1 · s:x · m · 84148f838e679769/bandje.wav (+ telefoonversies PCM en µ-law)
- in centrale: v1, 22-10-2026
- status: gemaakt (v1)

**Tekst**
> Eerste tekst.

## Versiegeschiedenis

(nog geen versies)
`);
  const S3 = B.maak({ vault: V3, dir: D3, klok: () => t });
  let x = S3.lees('tolgaarde').bandjes[0];
  toets('wv830 opnieuw gemaakt op de centrale-versie (oud): geen werkversie, volgende = v2, niet naar de centrale', x.versie === 1 && x.werkversie === null && x.volgende_versie === 2 && x.kan_centrale === false, x);
  let r3 = S3.zetGemaakt('tolgaarde', 'tg-buiten', { basis: 0, versie: 2, tekst_hash: x.tekst_hash, waarde: 'w' });
  toets('wv830 zetGemaakt met verouderde basis: 409, niets geschreven', r3.status === 409 && S3.lees('tolgaarde').bandjes[0].versie === 1, r3);
  r3 = S3.zetGemaakt('tolgaarde', 'tg-buiten', { basis: 1, versie: 3, tekst_hash: x.tekst_hash, waarde: 'w' });
  toets('wv830 zetGemaakt met een doel dat niet de werkversie is: 409', r3.status === 409, r3);
  r3 = S3.zetGemaakt('tolgaarde', 'tg-buiten', { basis: 1, versie: 2, tekst_hash: x.tekst_hash, waarde: '22-10-2026 · v2 · s:x · tekst ' + x.tekst_hash + ' · 84148f838e679769/bandje.wav' });
  x = S3.lees('tolgaarde').bandjes[0];
  toets('wv830 zetGemaakt: v2 gemaakt, tekst gelijk, in centrale v1, kan naar de centrale', r3.status === 200 && x.versie === 2 && x.status === 'gemaakt (v2)' && x.tekst === 'Eerste tekst.' && x.centrale_versie === 1 && x.kan_centrale === true, x);
  // terug naar precies de gemaakte tekst = weer gemaakt (Fable wv830 #9)
  r3 = S3.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Even anders.', versie: 2, tekst_hash: x.tekst_hash });
  const r3b = S3.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Eerste tekst.', versie: 2, tekst_hash: r3.bandje.tekst_hash });
  toets('wv830 tekst terug naar die van het gemaakte bandje: weer gemaakt (v2), kan naar de centrale', r3.bandje.status === 'concept (v2)' && r3.bandje.kan_centrale === false && r3b.status === 200 && r3b.bandje.status === 'gemaakt (v2)' && r3b.bandje.kan_centrale === true, [r3, r3b]);
  x = r3b.bandje;
  r3 = S3.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Concept één.', versie: 2, tekst_hash: x.tekst_hash });
  const naEen = fs.readFileSync(TG3, 'utf8');
  toets('wv830 eerste tekstwijziging na een generatie op dezelfde tekst: v2 blijft, de tekst van v1 in de versiegeschiedenis', r3.status === 200 && r3.bandje.versie === 2 && /### tg-buiten v1 — vervangen [\d-]+\n> Eerste tekst\./.test(naEen), naEen);
  r3 = S3.zetTekst('tolgaarde', 'tg-buiten', { tekst: 'Concept twee.', versie: 2, tekst_hash: r3.bandje.tekst_hash });
  toets('wv830 tweede concept: v2, geen tweede item in de geschiedenis', r3.status === 200 && r3.bandje.versie === 2 && (fs.readFileSync(TG3, 'utf8').match(/### tg-buiten v/g) || []).length === 1);
  toets('wv830 open na eigen schrijven', S3.lees('tolgaarde').dicht === null);
  // David wijzigt in Obsidian op dezelfde versie (nieuwe tekst, niet in het journaal): open
  fs.writeFileSync(TG3, fs.readFileSync(TG3, 'utf8').replace('> Concept twee.', '> Concept twee, door David.'));
  toets('wv830 Obsidian-wijziging op dezelfde versie: open (niet teruggezet)', S3.lees('tolgaarde').dicht === null, S3.lees('tolgaarde').dicht);
  // bisync zet de pagina terug naar "Concept één." (eerder door de pod op v2 geschreven): dicht
  fs.writeFileSync(TG3, naEen);
  const l3 = S3.lees('tolgaarde');
  toets('wv830 teruggezet op dezelfde versie (eerdere hash uit het journaal): dicht', l3.dicht && /eerdere tekst van v2/.test(l3.dicht), l3.dicht);
  // in centrale teruggezet door de synchronisatie (velden, tekst gelijk): dicht (Fable wv830 #5)
  fs.writeFileSync(TG3, naEen.replace('> Concept één.', '> Concept twee.'));
  const lnu = S3.lees('tolgaarde').bandjes[0];
  const rc = S3.zetVelden('tolgaarde', 'tg-buiten', { 'in centrale': 'v2 sinds 22-10-2026, [[a/b]]', status: 'in centrale (v2)' }, { versie: lnu.versie, tekst_hash: lnu.tekst_hash });
  const metCentrale = fs.readFileSync(TG3, 'utf8');
  fs.writeFileSync(TG3, metCentrale.replace('- in centrale: v2 sinds 22-10-2026, [[a/b]]', '- in centrale: v1, 22-10-2026'));
  const lc = S3.lees('tolgaarde');
  toets('wv830 "in centrale" teruggezet (zelfde versie en tekst): dicht', rc.status === 200 && lc.dicht && /in centrale v1 terwijl v2 bewaard was/.test(lc.dicht), lc.dicht);
  fs.writeFileSync(TG3, metCentrale);
  // zetGemaakt zonder basis-doel (taak van vóór wv830) = de werkversie van nu; lange stem-id kapt versie, hash en job niet af (Fable #2, #11)
  const lg = S3.lees('tolgaarde').bandjes[0];
  const lang = 'elevenlabs:' + 'X'.repeat(95);
  const rg = S3.zetGemaakt('tolgaarde', 'tg-buiten', { basis: lg.versie, versie: null, tekst_hash: lg.tekst_hash, waarde: (v) => '22-10-2026 · v' + v + ' · tekst ' + lg.tekst_hash + ' · 0123456789abcdef/bandje.wav · ' + lang + ' · eleven_multilingual_v2 (+ telefoon PCM en µ-law)' });
  toets('wv830 zetGemaakt zonder doel: werkversie v3 (centrale v2); lange stem afgekapt, versie/hash/job heel', rg.status === 200 && rg.bandje.versie === 3 && rg.bandje.laatste_bestand.length <= 160 &&
    JSON.stringify(B.laatsteVan(rg.bandje.laatste_bestand)) === JSON.stringify({ versie: 3, job: '0123456789abcdef', hash: lg.tekst_hash }) && rg.bandje.kan_centrale === true, rg);
  // nieuw bandje (bv. Noodscenario): v0, in centrale —, volgende v1
  toets('wv830 open vóór het nieuwe bandje', S3.lees('tolgaarde').dicht === null, S3.lees('tolgaarde').dicht);
  const nb = S3.nieuw('tolgaarde', { naam: 'Noodscenario', menu: 'hoofdnummer, vóór het keuzemenu', wanneer: 'bij een storing of calamiteit' });
  toets('wv830 nieuw bandje Noodscenario: tg-noodscenario, v0, leeg, in centrale —, volgende v1', nb.status === 200 && nb.bandje.id === 'tg-noodscenario' && nb.bandje.versie === 0 && nb.bandje.onbekend && nb.bandje.in_centrale === '—' &&
    nb.bandje.centrale_versie === 0 && nb.bandje.volgende_versie === 1 && nb.bandje.menu === 'hoofdnummer, vóór het keuzemenu', nb);
  const nt = S3.zetTekst('tolgaarde', 'tg-noodscenario', { tekst: 'Door een storing zijn wij slecht bereikbaar.', versie: 0, tekst_hash: nb.bandje.tekst_hash });
  toets('wv830 eerste tekst van het nieuwe bandje: v1 concept = werkversie, niet naar de centrale', nt.status === 200 && nt.bandje.versie === 1 && nt.bandje.status === 'concept (v1)' && nt.bandje.werkversie === 1 && nt.bandje.kan_centrale === false, nt);
  const nt2 = S3.zetTekst('tolgaarde', 'tg-noodscenario', { tekst: 'Door een storing zijn wij nu slecht bereikbaar.', versie: 1, tekst_hash: nt.bandje.tekst_hash });
  toets('wv830 nieuw bandje, tekst nog eens: blijft v1 (nooit in de centrale geweest, geen geschiedenis)', nt2.status === 200 && nt2.bandje.versie === 1 && !/### tg-noodscenario/.test(fs.readFileSync(TG3, 'utf8')), nt2);
  fs.rmSync(W3, { recursive: true, force: true });
}

// ══ rij B (wv743): routes, Studio-koppeling, telefoonversie, naKlaar, /smal, box-rij, server.js-koppeling ══
(async () => {
const studioMod = require('./studio.js'), A = require('./audio.js'), vm = require('vm'), crypto = require('crypto');
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
async function totDat(f, ms) { const e = Date.now() + (ms || 8000); while (Date.now() < e) { if (await f()) return true; await slaap(25); } return false; }
const W2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bandjes-b-'));
const V2 = path.join(W2, 'vault'), D2 = path.join(W2, 'bandjes'), SD = path.join(W2, 'studio'), BEWAAR = path.join(W2, 'app-bestanden');
const TG2 = path.join(V2, B.PRAKTIJKEN.tolgaarde.pad), GH2 = path.join(V2, B.PRAKTIJKEN.groenhouten.pad);
fs.mkdirSync(path.dirname(TG2), { recursive: true }); fs.mkdirSync(path.dirname(GH2), { recursive: true });
fs.writeFileSync(TG2, voorbeeld('tg')); fs.writeFileSync(GH2, voorbeeld('gh'));
const BOX = path.join(V2, '00_Systeem', 'Meldingen', 'machinekamer.md');
fs.mkdirSync(path.dirname(BOX), { recursive: true });
fs.writeFileSync(BOX, '# Machinekamer\n\n```\n## [week] 2026-01-01 00:00 — voorbeeld in een codeblok\n```\n\n## [week] 2026-10-22 09:55 — Bandjes: mini-app\n- status: bezig\n');
// nep-Piper: echte WAV (22.050 Hz, toon), gedrag via een bestand: "traag" (1,5 s), "kapot" (geen WAV), anders normaal
const MODUS = path.join(W2, 'piper-modus');
const NEP = path.join(W2, 'piper');
fs.writeFileSync(NEP, '#!' + process.execPath + `
const fs = require('fs'); const a = process.argv; const uit = a[a.indexOf('--output_file') + 1];
let tekst = ''; process.stdin.on('data', (b) => tekst += b); process.stdin.on('end', () => {
  let modus = ''; try { modus = fs.readFileSync(${JSON.stringify(MODUS)}, 'utf8').trim(); } catch (e) {}
  fs.writeFileSync(uit + '.tekst', tekst);
  const schrijf = () => {
    if (modus === 'kapot') { fs.writeFileSync(uit, Buffer.alloc(3000, 7)); return; }
    const rate = 22050, n = Math.round(rate * Math.max(0.5, tekst.length * 0.02)), pcm = Buffer.alloc(n * 2);
    for (let k = 0; k < n; k++) pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * k / rate)), k * 2);
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(uit, Buffer.concat([h, pcm]));
  };
  if (modus === 'traag') setTimeout(schrijf, 1500); else schrijf();
});
`, { mode: 0o755 });
// flows: de echte bandje-piper uit de repo + een stem op proef + een gewone Studio-flow
const zetFlow = (naam, y) => { fs.mkdirSync(path.join(SD, 'flows', naam), { recursive: true }); fs.writeFileSync(path.join(SD, 'flows', naam, 'flow.yaml'), JSON.stringify(y)); };
const echteFlow = JSON.parse(fs.readFileSync('studio-flows/bandje-piper/flow.yaml', 'utf8'));
zetFlow('bandje-piper', echteFlow);
zetFlow('bandje-proef', Object.assign({}, echteFlow, { titel: 'Proefstem op proef', status: 'proef', stem: 'piper:proef-stem' }));
zetFlow('proefbandje', { titel: 'Bandje, proefstem', motor: 'piper', status: 'actief', uitvoer: 'geluid', velden: [{ naam: 'tekst', soort: 'tekstvak', verplicht: true }] });
// stub van appBewaar (zelfde vorm: op naam gesorteerd, b/<n>, meta)
const bewaard = {};
const bewaar = (jobId, outdir, meta) => {
  const dir = path.join(BEWAAR, jobId); fs.mkdirSync(path.join(dir, 'b'), { recursive: true });
  const lijst = [];
  for (const n of fs.readdirSync(outdir).sort()) { if (n.endsWith('.tekst')) continue; const g = fs.statSync(path.join(outdir, n)).size; fs.renameSync(path.join(outdir, n), path.join(dir, 'b', String(lijst.length + 1))); lijst.push({ n: lijst.length + 1, naam: n, grootte: g }); }
  const m = { job_id: jobId, soort: meta.soort, label: meta.label, bestanden: lijst, studio: meta.studio }; bewaard[jobId] = m; return m;
};
let prim = true, gooiNaKlaar = false;
const logs = [], fouts = [];
let R2 = null;
const ST = studioMod.maak({ dir: SD, bewaar, primair: () => prim, sleutel: async () => null, routerUrl: 'http://127.0.0.1:9', flowstudioUrl: 'http://127.0.0.1:9', comfyUrl: 'http://127.0.0.1:9',
  piper: { bin: NEP, model: '-', data: '-' }, log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)), tempo: { poll: 30 },
  naKlaar: (t) => { if (gooiNaKlaar) { gooiNaKlaar = false; throw new Error('naKlaar gooit'); } return R2.naKlaar(t); } });
const OP = B.maak({ vault: V2, dir: D2, klok: () => Date.now(), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)) });
OP.mkdir();
toets('B mkdir: map 0700, tmp 0700', (fs.statSync(D2).mode & 0o777) === 0o700 && (fs.statSync(path.join(D2, 'tmp')).mode & 0o777) === 0o700);
let bestandWeg = false;   // wv830: Bestanden na 30 dagen leeg
const bestandVan = (job) => (bestandWeg || !bewaard[job] ? null : bewaard[job].bestanden.map((x) => ({ naam: x.naam, pad: path.join(BEWAAR, job, 'b', String(x.n)) })));
R2 = B.routes({ opslag: OP, studio: ST, primair: () => prim, dir: D2, boxPad: BOX, bestandVan, log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)) });
let vers = false, verbruikt = 0;
const ctx = { versOk: () => vers, versVerbruik: () => { vers = false; verbruikt++; }, apparaat: 'toets' };
const app = (route, d) => R2.app(route, d, ctx);

// ── 1. lezen + stemmen ──
let g = await app('GET /app/bandjes', {});
toets('B GET: twee praktijken, open, schrijven', g.status === 200 && g.j.praktijken.length === 2 && g.j.praktijken.every((p) => p.dicht === null) && g.j.schrijven === true, g.j);
const stemIds = g.j.stemmen.map((x) => x.id);
toets('B GET: stemmen uit de flows met vlag bandje (+ ElevenLabs grijs)', stemIds.join(',') === 'piper:nl_NL-ronnie-medium,piper:proef-stem,elevenlabs' &&
  g.j.stemmen[0].beschikbaar === true && g.j.stemmen[0].flow === 'bandje-piper' && g.j.stemmen[2].beschikbaar === false && /Studio fase 2/.test(g.j.stemmen[2].reden), g.j.stemmen);
toets('B GET: praktijkstem uit het register (geldige stem-id)', g.j.praktijken[0].praktijkstem === 'piper:nl_NL-ronnie-medium');
const lijstStudio = (await ST.flows()).flows.map((f) => f.id);
toets('B Studio-lijst: verborgen flows staan er niet in', lijstStudio.indexOf('bandje-piper') < 0 && lijstStudio.indexOf('bandje-proef') < 0 && lijstStudio.indexOf('proefbandje') >= 0, lijstStudio);
toets('B Studio-lijst met verborgen (alleen de server): wel', (await ST.flows({ verborgen: true })).flows.some((f) => f.id === 'bandje-piper' && f.bandje && f.stem === 'piper:nl_NL-ronnie-medium'));
const tgB = () => g.j.praktijken[0].bandjes.find((b) => b.id === 'tg-buiten');
const herlees = async () => { g = await app('GET /app/bandjes', {}); return tgB(); };
let bu = tgB();

// ── 2. tekst ──
let r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Route-tekst één.', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('B tekst: 200, versie 3', r.status === 200 && r.j.bandje.versie === 3 && r.j.bandje.status === 'concept (v3)', r);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Oud.', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('B tekst met oude versie+hash: 409 gewijzigd', r.status === 409 && r.j.gewijzigd === true, r);
bu = await herlees();
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Route-tekst één.', versie: bu.versie, tekst_hash: 'ffffffffffffffff' });
toets('B tekst met goede versie maar andere hash: 409', r.status === 409 && r.j.gewijzigd === true, r);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Route-tekst één.', versie: bu.versie, tekst_hash: bu.tekst_hash, stem: 'piper:proef-stem' });
bu = await herlees();
toets('B alleen een andere stem: geen nieuwe versie, stem gezet', r.status === 200 && bu.versie === 3 && bu.stem === 'piper:proef-stem', bu);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'x', versie: bu.versie, tekst_hash: bu.tekst_hash, stem: 'elders:bestaat-niet' });
toets('B onbekende stem: 400', r.status === 400, r);
await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Route-tekst één.', versie: bu.versie, tekst_hash: bu.tekst_hash, stem: 'praktijkstem' });
bu = await herlees();
toets('B terug naar praktijkstem', bu.stem === 'praktijkstem' && bu.versie === 3, bu);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: '(onbekend nummer) belt u 112', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('B tekst die met "(onbekend" begint: 400 (Fable wv743 #6)', r.status === 400 && /onbekend/.test(r.j.fout), r);
r = await app('POST /app/bandjes/tekst', { praktijk: 'elders', bandje: 'tg-buiten', tekst: 'x', versie: 0, tekst_hash: '' });
toets('B onbekende praktijk: 400', r.status === 400, r);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: '../../etc', tekst: 'x', versie: 0, tekst_hash: '' });
toets('B ongeldig bandje-id: 400', r.status === 400, r);

// ── 3. voorstel via /smal; "neem over" bestaat niet op de server ──
r = R2.smal('voorstel', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Kijk eerst op huisartsenposteemland.nl of gebruik Spreekuur.nl.', reden: 'proef: Spreekuur.nl' });
toets('B smal voorstel: 200 + link met alleen ids', r.status === 200 && r.j.link === 'https://app.socev.dev/?mini=bandjes&praktijk=tolgaarde&bandje=tg-buiten&voorstel=1' && r.j.bandje.voorstel, r);
bu = await herlees();
toets('B smal voorstel: tekst en versie ongemoeid', bu.tekst === 'Route-tekst één.' && bu.versie === 3 && /Spreekuur/.test(bu.voorstel.tekst), bu);
r = R2.smal('voorstel', { praktijk: 'groenhouten', nieuw: { naam: 'HAP-verwijzing', menu: 'hoofdnummer', wanneer: 'avond' }, tekst: 'Nieuw voorstel.', reden: 'proef' });
toets('B smal voorstel met nieuw bandje: id + voorstel', r.status === 200 && r.j.bandje.id === 'gh-hap-verwijzing' && r.j.bandje.onbekend && r.j.bandje.voorstel.tekst === 'Nieuw voorstel.', r);
toets('B smal: onbekende praktijk 400, te lang 400, geen bandje 400', R2.smal('voorstel', { praktijk: 'x', bandje: 'tg-buiten', tekst: 'a' }).status === 400 &&
  R2.smal('voorstel', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'x'.repeat(1501) }).status === 400 && R2.smal('voorstel', { praktijk: 'tolgaarde', tekst: 'a' }).status === 400);
{ const voor = (await herlees(), g.j.praktijken[1].bandjes.length);
  r = R2.smal('voorstel', { praktijk: 'groenhouten', nieuw: { naam: 'Leeg' }, tekst: '' });
  g = await app('GET /app/bandjes', {});
  toets('B smal nieuw met lege tekst: 400 en geen bandje aangemaakt (Fable wv743 #3)', r.status === 400 && g.j.praktijken[1].bandjes.length === voor, r); }
{ const a1 = R2.smal('voorstel', { praktijk: 'groenhouten', nieuw: { naam: 'Twee' }, tekst: 'b' }), a2 = R2.smal('voorstel', { praktijk: 'groenhouten', nieuw: { naam: 'Drie' }, tekst: 'c' });
  const a3 = R2.smal('voorstel', { praktijk: 'groenhouten', nieuw: { naam: 'Vier' }, tekst: 'd' });
  toets('B smal nieuw: hooguit 3 open bandjes van Socev zonder tekst, de vierde 409', a1.status === 200 && a2.status === 200 && a3.status === 409 && /al 3 nieuwe bandjes/.test(a3.j.fout) && /^voorstel van Socev /.test(a1.j.bandje.bron), [a1.status, a2.status, a3]);
  toets('B smal: voorstel op een bestaand bandje kan dan nog wel', R2.smal('voorstel', { praktijk: 'groenhouten', bandje: 'gh-buiten', tekst: 'e' }).status === 200); }
toets('B smal: alleen voorstel', R2.smal('tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'a' }).status === 404);
for (const k of ['neem', 'over', 'neem over', 'accepteer', undefined]) {
  r = await app('POST /app/bandjes/voorstel', { praktijk: 'tolgaarde', bandje: 'tg-buiten', keuze: k });
  if (r.status !== 400) toets('B voorstel keuze ' + k + ' moet 400 zijn', false, r);
}
toets('B "neem over" bestaat niet op de server (keuze ≠ laat = 400; geen route)', (await app('POST /app/bandjes/neem-over', { praktijk: 'tolgaarde', bandje: 'tg-buiten' })).status === 404 &&
  !!(await herlees()).voorstel);
r = await app('POST /app/bandjes/voorstel', { praktijk: 'tolgaarde', bandje: 'tg-buiten', keuze: 'laat' });
bu = await herlees();
toets('B voorstel laten liggen: weg, tekst ongemoeid', r.status === 200 && !bu.voorstel && bu.tekst === 'Route-tekst één.', bu);

// ── 4. instellingen ──
r = await app('POST /app/bandjes/instellingen', { praktijk: 'groenhouten', praktijkstem: 'piper:proef-stem' });
g = await app('GET /app/bandjes', {});
toets('B instellingen: praktijkstem gezet', r.status === 200 && g.j.praktijken[1].instellingen.praktijkstem === 'piper:proef-stem' && g.j.praktijken[1].praktijkstem === 'piper:proef-stem', r);
toets('B instellingen: onbekende stem 400, "praktijkstem" 400', (await app('POST /app/bandjes/instellingen', { praktijk: 'groenhouten', praktijkstem: 'x:y' })).status === 400 &&
  (await app('POST /app/bandjes/instellingen', { praktijk: 'groenhouten', praktijkstem: 'praktijkstem' })).status === 400);
await app('POST /app/bandjes/instellingen', { praktijk: 'groenhouten', praktijkstem: 'piper:nl_NL-ronnie-medium' });
{ const p = B.parse(fs.readFileSync(GH2, 'utf8'), 'gh'); toets('B instellingen: blok blijft één, model-regel blijft staan', p.instellingen.praktijkstem === 'piper:nl_NL-ronnie-medium' && p.instellingen.model === 'piper' && (fs.readFileSync(GH2, 'utf8').match(/^- praktijkstem:/gm) || []).length === 1); }
{ const md = B.zetInstelling('---\nupdated: 2026-01-01\n---\n# X\n\n## gh-aa — A\n**Tekst**\n> a\n', 'gh', 'praktijkstem', 'piper:nl_NL-ronnie-medium');
  toets('B instellingen: blok aangemaakt vóór het eerste bandje', md.status === 200 && /\n## Praktijkinstellingen\n- praktijkstem: piper:nl_NL-ronnie-medium\n\n## gh-aa/.test(md.md), md.md); }
{ const md0 = '---\nupdated: 2026-01-01\n---\n# X\n\n## Praktijkinstellingen\n- praktijkstem: onbekend\n- model: onbekend\n\n## gh-aa — A\n**Tekst**\n> a\n';
  let r1 = B.zetInstelling(md0, 'gh', 'stemmen', 'Roos (elevenlabs:7qdUFMklKPaaAVMsBTBt); Kees (abcDEF123)');
  toets('B instellingen wv757: stemmen gezet als nieuwe regel na model, lijst leesbaar (kaal id = elevenlabs)', r1.status === 200 && /\n- model: onbekend\n- stemmen: Roos \(elevenlabs:7qdUFMklKPaaAVMsBTBt\); Kees \(abcDEF123\)\n\n## gh-aa/.test(r1.md)
    && JSON.stringify(B.stemmenLijst(r1.instellingen.stemmen)) === JSON.stringify([{ naam: 'Roos', id: 'elevenlabs:7qdUFMklKPaaAVMsBTBt' }, { naam: 'Kees', id: 'elevenlabs:abcDEF123' }]), r1);
  const r2 = B.zetInstelling(r1.md, 'gh', 'model', 'standaard van Studio fase 2');
  toets('B instellingen wv757: model overschreven, stemmen blijft', r2.status === 200 && r2.instellingen.model === 'standaard van Studio fase 2' && /- stemmen: Roos/.test(r2.md) && (r2.md.match(/^- model:/gm) || []).length === 1, r2);
  toets('B instellingen wv757: stemmen zonder (motor:id) geweigerd', B.zetInstelling(md0, 'gh', 'stemmen', 'Roos').status === 400 && B.zetInstelling(md0, 'gh', 'stemmen', 'Roos (ab:yz); ').status === 200 && B.zetInstelling(md0, 'gh', 'stemmen', 'Roos (a b)').status === 400 && B.zetInstelling(md0, 'gh', 'stemmen', '').status === 400);
  toets('B instellingen wv757: lange lijst (600) niet afgekapt op 100', B.zetInstelling(md0, 'gh', 'stemmen', Array.from({ length: 8 }, (_, i) => 'Stem' + i + ' (elevenlabs:7qdUFMklKPaaAVMsBTB' + i + ')').join('; ')).instellingen.stemmen.split(';').length === 8); }
{ const md = fs.readFileSync(TG2, 'utf8').replace('- praktijkstem: piper:nl_NL-ronnie-medium', '- praktijkstem: onbekend (ElevenLabs)'); fs.writeFileSync(TG2, md);
  g = await app('GET /app/bandjes', {});
  toets('B praktijkstem "onbekend" in het register: valt terug op de gratis proefstem', g.j.praktijken[0].praktijkstem === 'piper:nl_NL-ronnie-medium'); }

// ── 5. maak: tekst uit het register, versie + hash, telefoonversie, label, naKlaar ──
bu = await herlees();
const beurt = () => 'bt-' + crypto.randomBytes(6).toString('hex');
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: 'ffffffffffffffff', beurt_id: beurt() });
toets('B maak met andere hash: 409', r.status === 409 && r.j.gewijzigd === true, r);
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-hoofdmenu', versie: 0, tekst_hash: B.tekstHash(''), beurt_id: beurt() });
toets('B maak zonder tekst (onbekend): 400', r.status === 400 && /bewaar eerst/.test(r.j.fout), r);
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('B maak zonder beurt_id: 400', r.status === 400, r);
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, stem: 'elevenlabs', beurt_id: beurt() });
toets('B maak met ElevenLabs: 409 nog niet beschikbaar', r.status === 409 && /Studio fase 2/.test(r.j.fout), r);
const b1 = beurt();
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: b1, tekst: 'GESMOKKELDE TEKST' });
toets('B maak: 200, taak met bron', r.status === 200 && r.j.taak && r.j.taak.bron && r.j.taak.bron.bandje === 'tg-buiten' && r.j.taak.bron.versie === 3 && r.j.taak.flow === 'bandje-piper', r);
const tid = r.j.taak.id;
await totDat(() => ST.taak(tid).status !== 'wacht' && ST.taak(tid).status !== 'bezig');
let tk = ST.taak(tid);
toets('B maak: klaar, drie bestanden op naam (origineel + twee telefoonversies)', tk.status === 'klaar' && tk.bestanden.map((x) => x.naam).join(',') === 'bandje-telefoon-pcm.wav,bandje-telefoon-ulaw.wav,bandje.wav' && !tk.noot, tk);
const job = bewaard[tid];
toets('B label in Bestanden uit de bron', job && job.label === 'tolgaarde · tg-buiten · v3', job && job.label);
{ const pcm = fs.readFileSync(path.join(BEWAAR, tid, 'b', '1')), ul = fs.readFileSync(path.join(BEWAAR, tid, 'b', '2'));
  const w = A.leesWav(pcm);
  toets('B telefoonversie PCM: 8 kHz mono 16-bit; µ-law: formaat 7, kop 58', w.rate === 8000 && w.kanalen === 1 && pcm.length > 44 && ul.readUInt16LE(20) === 7 && ul.readUInt32LE(24) === 8000 && ul.toString('ascii', 50, 54) === 'data', { rate: w.rate }); }
toets('B de tekst kwam uit het register (niet uit de invoer)', tk.velden.tekst === 'Route-tekst één.', tk.velden);
await totDat(async () => /gemaakt/.test((await herlees()).status));
bu = await herlees();
toets('B naKlaar: status gemaakt (v3), laatste bestand met datum · versie · stem · tekst-hash · job/naam', bu.status === 'gemaakt (v3)' &&
  new RegExp('^\\d{1,2}-\\d{1,2}-\\d{4} · v3 · tekst ' + bu.tekst_hash + ' · ' + tid + '/bandje\\.wav · piper:nl_NL-ronnie-medium \\(\\+ telefoon PCM en µ-law\\)$').test(bu.laatste_bestand), bu);
toets('wv830 naKlaar: werkversie gemaakt = kan in de centrale', bu.kan_centrale === true && bu.werkversie === 3 && bu.centrale_versie === 2, bu);
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: b1 });
toets('B maak met dezelfde beurt_id: dezelfde taak (al)', r.status === 200 && r.j.al === true && r.j.taak.id === tid, r);
// via de Studio-route kan een bron niet meegegeven worden (alleen het derde argument van maak)
r = await ST.maak({ flow: 'proefbandje', velden: { tekst: 'x' }, beurt_id: beurt(), bron: { soort: 'bandje', praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: 3, tekst_hash: bu.tekst_hash, stem: 's:x' } }, ctx);
toets('B Studio-invoer kan geen bron zetten', r.status === 200 && r.taak.bron === null, r.taak);
await totDat(() => ST.taak(r.taak.id).status === 'klaar');
// tekst gewijzigd terwijl de taak loopt: het register krijgt geen "laatste bestand" bij de nieuwe versie
fs.writeFileSync(MODUS, 'traag');
const vorigBestand = bu.laatste_bestand;
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
const tTraag = r.j.taak.id;
await totDat(() => ST.taak(tTraag).status === 'bezig');
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Versie vier, tijdens het maken.', versie: bu.versie, tekst_hash: bu.tekst_hash });
await totDat(() => ST.taak(tTraag).status === 'klaar', 6000);
await slaap(100);
bu = await herlees();
toets('B tekst gewijzigd tijdens het maken: register houdt concept (v3, werkversie overschreven), laatste bestand ongewijzigd, niet naar de centrale', ST.taak(tTraag).status === 'klaar' && bu.versie === 3 && bu.status === 'concept (v3)' && bu.laatste_bestand === vorigBestand && bu.kan_centrale === false, bu);
toets('B ... met een logregel', logs.some((l) => /naklaar taak=.*register niet bijgewerkt/.test(l)), logs.slice(-3));
fs.writeFileSync(MODUS, '');
// naKlaar die gooit: de wachtrij loopt door
gooiNaKlaar = true;
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
const tGooi = r.j.taak.id;
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
const tNa = r.j.taak.id;
await totDat(() => ST.taak(tNa).status === 'klaar', 6000);
toets('B naKlaar gooit: taak klaar, volgende taak loopt ook, fout gelogd', ST.taak(tGooi).status === 'klaar' && ST.taak(tNa).status === 'klaar' && fouts.some((f) => /studio-naklaar: naKlaar gooit/.test(f)), fouts.slice(-3));
// telefoonversie mislukt: zacht, origineel bewaard met een noot
fs.writeFileSync(MODUS, 'kapot');
bu = await herlees();
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
const tKapot = r.j.taak.id;
await totDat(() => ST.taak(tKapot).status !== 'wacht' && ST.taak(tKapot).status !== 'bezig');
tk = ST.taak(tKapot);
toets('B telefoonversie mislukt: taak klaar, alleen het origineel, met noot', tk.status === 'klaar' && tk.bestanden.length === 1 && tk.bestanden[0].naam === 'bandje.wav' && /telefoonversie mislukt/.test(tk.noot || ''), tk);
await totDat(async () => (await herlees()).laatste_bestand.indexOf(tKapot) >= 0);
toets('B ... register: "zonder telefoonversie"', /zonder telefoonversie/.test((await herlees()).laatste_bestand), (await herlees()).laatste_bestand);
{ const bk = await herlees();
  const rk = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bk.versie, tekst_hash: bk.tekst_hash });
  toets('wv830 status bij een bandje zonder telefoonversies: 409, niets gemarkeerd (Fable #10)', rk.status === 409 && /telefoonversies/.test(rk.j.fout) && (await herlees()).status === bk.status, rk); }
fs.writeFileSync(MODUS, '');

// ── 6. proefstem zonder verse vingerafdruk: 403 vers_nodig (vervangt "betaald geweigerd" tot Studio fase 2) ──
bu = await herlees();
vers = false; verbruikt = 0;
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', stem: 'piper:proef-stem', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
toets('B stem op proef zonder verse vingerafdruk: 403 vers_nodig', r.status === 403 && r.j.vers_nodig === true && verbruikt === 0, r);
vers = true;
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', stem: 'piper:proef-stem', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
toets('B ... met verse vingerafdruk: 200 en verbruikt', r.status === 200 && verbruikt === 1 && vers === false, r);
await totDat(() => ST.taak(r.j.taak.id).status === 'klaar');
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', stem: 'piper:proef-stem', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
toets('B ... tweede keer zonder nieuwe vingerafdruk: weer 403', r.status === 403 && r.j.vers_nodig === true, r);

// ── 7. status in centrale (wv830: alleen een gemaakte werkversie; archief in de vault) ──
const ARCH = path.join(path.dirname(TG2), 'Archief');
const maakEnWacht = async (b0) => {
  const m = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: b0.versie, tekst_hash: b0.tekst_hash, beurt_id: beurt() });
  if (m.status !== 200) return { m };
  await totDat(() => ST.taak(m.j.taak.id).status === 'klaar');
  await totDat(async () => (await herlees()).laatste_bestand.indexOf(m.j.taak.id) >= 0, 3000);
  return { m, b: await herlees() };
};
bu = await herlees();
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie - 1, tekst_hash: bu.tekst_hash });
toets('B status met verouderde versie: 409', r.status === 409, r);
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie });
toets('B status zonder tekst_hash: 400 (Fable wv743 #2)', r.status === 400, r);
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: 'ffffffffffffffff' });
toets('B status met andere hash (David wijzigde in Obsidian): 409', r.status === 409, r);
toets('wv830 voor het markeren: v3 gemaakt, in centrale v2', bu.versie === 3 && bu.kan_centrale === true && /^v2,/.test(bu.in_centrale), bu);
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, job: 'ffffffffffffffff' });
toets('wv830 status met een ander job dan het laatst gemaakte: 409', r.status === 409, r);
bestandWeg = true;
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('wv830 status als de bestanden niet meer in Bestanden staan: 409, niets gemarkeerd, geen archief', r.status === 409 && /Bestanden/.test(r.j.fout) && (await herlees()).status === bu.status && !fs.existsSync(ARCH), r);
bestandWeg = false;
// terwijl er nog een Maak loopt: 409 (anders valt die generatie na het markeren weg; Fable wv830 #4)
fs.writeFileSync(MODUS, 'traag');
const mTraag = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, beurt_id: beurt() });
await totDat(() => ST.taak(mTraag.j.taak.id).status === 'bezig');
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('wv830 status terwijl een Maak voor dit bandje loopt: 409', r.status === 409 && /nog een bandje gemaakt/.test(r.j.fout), r);
await totDat(() => ST.taak(mTraag.j.taak.id).status === 'klaar', 6000);
fs.writeFileSync(MODUS, '');
await totDat(async () => (await herlees()).laatste_bestand.indexOf(mTraag.j.taak.id) >= 0, 3000);
bu = await herlees();
toets('wv830 ... die generatie bleef v3 (werkversie overschreven)', bu.versie === 3 && bu.kan_centrale === true && B.laatsteVan(bu.laatste_bestand).job === mTraag.j.taak.id, bu);
const lb3 = B.laatsteVan(bu.laatste_bestand);
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash, job: lb3.job });
bu = await herlees();
const iso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const basis3 = 'tg-buiten-v3-' + iso;
toets('wv830 status: in centrale (v3), veld "v3 sinds <datum>, [[archief]]", geen werkversie meer', r.status === 200 && bu.status === 'in centrale (v3)' && bu.werkversie === null && bu.centrale_versie === 3 && bu.kan_centrale === false &&
  new RegExp('^v3 sinds \\d{1,2}-\\d{1,2}-\\d{4}, \\[\\[10_Zakelijk/Tolgaarde/Telefoon/Archief/' + basis3 + '\\]\\]$').test(bu.in_centrale) && r.j.archief === '10_Zakelijk/Tolgaarde/Telefoon/Archief/' + basis3 + '.md', { r, ic: bu.in_centrale });
const archNamen = fs.existsSync(ARCH) ? fs.readdirSync(ARCH).sort() : [];
toets('wv830 archief: telefoonversies (µ-law, PCM), luisterversie en tekst', archNamen.join(',') === [basis3 + '-luister.wav', basis3 + '-telefoon-pcm.wav', basis3 + '-telefoon-ulaw.wav', basis3 + '.md'].join(','), archNamen);
{ const jb = bewaard[lb3.job].bestanden.find((x) => x.naam === 'bandje-telefoon-ulaw.wav');
  toets('wv830 archief: µ-law byte-gelijk aan het gemaakte bestand, 0644', fs.readFileSync(path.join(ARCH, basis3 + '-telefoon-ulaw.wav')).equals(fs.readFileSync(path.join(BEWAAR, lb3.job, 'b', String(jb.n)))) && (fs.statSync(path.join(ARCH, basis3 + '.md')).mode & 0o777) === 0o644); }
const amd = fs.readFileSync(path.join(ARCH, basis3 + '.md'), 'utf8');
toets('wv830 archief-md: frontmatter, tekst als citaat, spreektekst, links naar de wav-bestanden met volledig pad', /^---\ntype: bandje-archief\npraktijk: Tolgaarde\nbandje: tg-buiten\nversie: 3\n/.test(amd) && amd.includes('> Versie vier, tijdens het maken.') &&
  amd.includes('**Spreektekst**') && amd.includes('![[10_Zakelijk/Tolgaarde/Telefoon/Archief/' + basis3 + '-telefoon-ulaw.wav]]') && amd.includes('[[10_Zakelijk/Tolgaarde/Telefoon/Bandjes]]'), amd);
toets('wv830 archief: geen tijdelijk bestand achtergebleven', fs.readdirSync(path.join(D2, 'tmp')).length === 0, fs.readdirSync(path.join(D2, 'tmp')));
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('wv830 nog eens markeren: 409 staat al in de centrale', r.status === 409 && /al in de centrale/.test(r.j.fout), r);
// opnieuw genereren na het markeren = een nieuwe werkversie v4; nog eens genereren blijft v4
let mk = await maakEnWacht(bu);
toets('wv830 opnieuw genereren na de centrale: taak voor v4 (basis v3), register gemaakt (v4), tekst gelijk, in centrale blijft v3', mk.m.j.taak.bron.versie === 4 && mk.m.j.taak.bron.basis === 3 &&
  mk.b.versie === 4 && mk.b.status === 'gemaakt (v4)' && mk.b.tekst_hash === bu.tekst_hash && /^v3 sinds/.test(mk.b.in_centrale) && mk.b.kan_centrale === true && bewaard[mk.m.j.taak.id].label === 'tolgaarde · tg-buiten · v4', { m: mk.m.j.taak.bron, b: mk.b });
const eersteV4 = mk.m.j.taak.id;
mk = await maakEnWacht(mk.b);
toets('wv830 nog eens genereren: blijft v4, laatste bestand = de nieuwe', mk.m.j.taak.bron.versie === 4 && mk.b.versie === 4 && mk.b.laatste_bestand.indexOf(mk.m.j.taak.id) >= 0 && mk.m.j.taak.id !== eersteV4, mk.b);
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Versie vier, eigen tekst.', versie: mk.b.versie, tekst_hash: mk.b.tekst_hash });
bu = await herlees();
toets('wv830 tekst wijzigen op de werkversie: blijft v4, concept, niet meer naar de centrale', r.status === 200 && bu.versie === 4 && bu.status === 'concept (v4)' && bu.kan_centrale === false, bu);
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('wv830 markeren zonder gemaakt bandje bij deze tekst: 409', r.status === 409 && /maak eerst/.test(r.j.fout), r);
mk = await maakEnWacht(bu);
fs.writeFileSync(path.join(ARCH, 'tg-buiten-v4-' + iso + '.md'), 'van David\n');   // naam al bezet: nooit overschrijven
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: mk.b.versie, tekst_hash: mk.b.tekst_hash });
bu = await herlees();
toets('wv830 v4 in de centrale: archief met -2 (naam bezet), v3 en Davids bestand ongemoeid', r.status === 200 && bu.status === 'in centrale (v4)' && bu.in_centrale.includes('tg-buiten-v4-' + iso + '-2]]') &&
  fs.existsSync(path.join(ARCH, 'tg-buiten-v4-' + iso + '-2-telefoon-ulaw.wav')) && fs.readFileSync(path.join(ARCH, 'tg-buiten-v4-' + iso + '.md'), 'utf8') === 'van David\n' && fs.readFileSync(path.join(ARCH, basis3 + '.md'), 'utf8') === amd, { r, ic: bu.in_centrale, n: fs.readdirSync(ARCH) });
toets('wv830 versiegeschiedenis: de tekst uit de centrale (v3) staat erin bij de wijziging', /### tg-buiten v3 — vervangen [\d-]+\n> Versie vier, tijdens het maken\./.test(fs.readFileSync(TG2, 'utf8')));
await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Versie vijf.', versie: bu.versie, tekst_hash: bu.tekst_hash });
bu = await herlees();
toets('B status volgt de versie: concept (v5) · in centrale blijft v4', bu.status === 'concept (v5)' && /^v4 sinds/.test(bu.in_centrale), bu);
// "laatste bestand" van vóór wv830 (zonder tekst-hash): de route toetst aan de Studio-taak
mk = await maakEnWacht(bu);
const lb5 = B.laatsteVan(mk.b.laatste_bestand);
const zonderHash = () => fs.writeFileSync(TG2, fs.readFileSync(TG2, 'utf8').replace(' · tekst ' + mk.b.tekst_hash + ' · ', ' · '));
zonderHash();
fs.writeFileSync(TG2, fs.readFileSync(TG2, 'utf8').replace('> Versie vijf.', '> Versie vijf, door David.'));
bu = await herlees();
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('wv830 oud veld zonder hash + tekst in Obsidian gewijzigd: de taak verraadt het, 409', lb5 && lb5.job && B.laatsteVan(bu.laatste_bestand).hash === null && r.status === 409 && /eerdere tekst/.test(r.j.fout), { r, lb: bu.laatste_bestand });
fs.writeFileSync(TG2, fs.readFileSync(TG2, 'utf8').replace('> Versie vijf, door David.', '> Versie vijf.'));
bu = await herlees();
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: bu.versie, tekst_hash: bu.tekst_hash });
bu = await herlees();
toets('wv830 oud veld zonder hash, tekst klopt met de taak: v5 in de centrale', r.status === 200 && bu.status === 'in centrale (v5)' && /^v5 sinds/.test(bu.in_centrale), r);

// ── 8. nieuw via de app ──
r = await app('POST /app/bandjes/nieuw', { praktijk: 'tolgaarde', naam: 'Griepprik', menu: 'keuze 3', wanneer: 'oktober', tekst: 'Info over de griepprik.' });
toets('B nieuw: tg-griepprik v1', r.status === 200 && r.j.bandje.id === 'tg-griepprik' && r.j.bandje.versie === 1, r);

// ── 9. passief ──
prim = false;
g = await app('GET /app/bandjes', {});
r = await app('POST /app/bandjes/tekst', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'x', versie: bu.versie, tekst_hash: bu.tekst_hash });
toets('B passief: lezen wel (schrijven false), bewaren 409, smal 409', g.status === 200 && g.j.schrijven === false && r.status === 409 && R2.smal('voorstel', { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'a' }).status === 409, r);
prim = true;

// ── 10. teruggezet / conflict: dicht + één box-rij per dag ──
fs.chmodSync(BOX, 0o640);
const boxVoor = fs.readFileSync(BOX, 'utf8');
const nuTg = fs.readFileSync(TG2, 'utf8');
fs.writeFileSync(TG2, nuTg.replace(/- versie: 5/, '- versie: 2'));   // bisync zet een oudere kopie terug
fs.writeFileSync(GH2 + '.conflict1', 'x');
g = await app('GET /app/bandjes', {});
await app('GET /app/bandjes', {});
const boxNa = fs.readFileSync(BOX, 'utf8');
toets('B teruggezet: Tolgaarde dicht met reden', /teruggezet/.test(g.j.praktijken[0].dicht || ''), g.j.praktijken[0].dicht);
toets('B conflictkopie: Groenhouten dicht met naam', /Bandjes\.md\.conflict1/.test(g.j.praktijken[1].dicht || ''), g.j.praktijken[1].dicht);
toets('B box: twee rijen (één per praktijk/soort), boven de eerste echte rij, niet in het codeblok', (boxNa.match(/— Bandjes (Tolgaarde|Groenhouten):/g) || []).length === 2 &&
  boxNa.indexOf('— Bandjes Tolgaarde: bewaarde tekst teruggezet') > boxNa.indexOf('```\n\n') && boxNa.indexOf('— Bandjes Tolgaarde') < boxNa.indexOf('## [week] 2026-10-22 09:55') && boxNa.startsWith(boxVoor.slice(0, boxVoor.indexOf('\n## [week] 2026-10-22'))), boxNa.slice(0, 900));
toets('B box: modus van het origineel behouden, geen tijdelijk bestand in de vault (Fable wv743 #5)', (fs.statSync(BOX).mode & 0o777) === 0o640 && fs.readdirSync(path.dirname(BOX)).length === 1 && fs.readdirSync(path.join(D2, 'tmp')).length === 0, fs.readdirSync(path.dirname(BOX)));
toets('B box: rij in het vaste formaat (status open, gevolg, voorstel)', /## \[direct\] \d{4}-\d{2}-\d{2} \d{2}:\d{2} — Bandjes Tolgaarde: [^\n]+\n- status: open\n- van: pod bandjes\.js[^\n]*\n- gemeten: [^\n]+\n- gevolg als er niets gebeurt: [^\n]+\n- voorstel: [^\n]+journaal\.jsonl/.test(boxNa), boxNa.slice(0, 1200));
r = await app('POST /app/bandjes/maak', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: 2, tekst_hash: B.tekstHash('Versie vijf.'), beurt_id: beurt() });
toets('B teruggezet: maak 409 dicht', r.status === 409 && r.j.dicht === true, r);
toets('B health: dicht per praktijk, zonder inhoud', JSON.stringify(R2.health()) === JSON.stringify({ aan: true, dicht_tolgaarde: true, dicht_groenhouten: true }), R2.health());
// zelfde dag, na een "herstart" (nieuwe routes-laag): geen tweede rij
const R3 = B.routes({ opslag: B.maak({ vault: V2, dir: D2 }), studio: ST, primair: () => true, dir: D2, boxPad: BOX });
await R3.app('GET /app/bandjes', {}, ctx);
toets('B box: na een herstart dezelfde dag geen tweede rij', (fs.readFileSync(BOX, 'utf8').match(/— Bandjes (Tolgaarde|Groenhouten):/g) || []).length === 2);
fs.writeFileSync(TG2, nuTg); fs.unlinkSync(GH2 + '.conflict1');
toets('B opgelost: weer open', JSON.stringify(R2.health()) === JSON.stringify({ aan: true, dicht_tolgaarde: false, dicht_groenhouten: false }), R2.health());

// ── 11. server.js-koppeling: het blok Bandjes in een vm, met de echte ctx-functie van server.js ──
{
  const src = fs.readFileSync('server.js', 'utf8');
  const a = src.indexOf('// ── Bandjes (wv743'), e = src.indexOf('// ── einde bandjes ──');
  const ctxRegel = (/^function appStudioCtx\(a, s\) \{.*\}$/m.exec(src) || [''])[0];
  toets('S server.js: blok Bandjes en appStudioCtx gevonden', a > 0 && e > a && !!ctxRegel);
  toets('S server.js: appStudio gebruikt dezelfde ctx-functie', /async function appStudio\(req, res, a, s, d, route\) \{\n[^\n]*\n  const ctx = appStudioCtx\(a, s\);/.test(src));
  toets('S server.js: dispatch, smalle route, grens en /health', /route === 'GET \/app\/bandjes' \|\| route\.indexOf\('POST \/app\/bandjes\/'\) === 0\) return typeof appBandjes === 'function'/.test(src) &&
    /'bandjes\/voorstel': 30/.test(src) && /if \(actie === 'bandjes\/voorstel'\) return bandjes \? bandjes\.smal\('voorstel', d\)/.test(src) && /bandjes: bandjesInfo\(\),/.test(src) &&
    /naKlaar: function \(t\) \{ return bandjes \? bandjes\.naKlaar\(t\) : null; \}/.test(src));
  const V3 = path.join(W2, 'vault3'); fs.mkdirSync(path.dirname(path.join(V3, B.PRAKTIJKEN.tolgaarde.pad)), { recursive: true }); fs.mkdirSync(path.dirname(path.join(V3, B.PRAKTIJKEN.groenhouten.pad)), { recursive: true });
  fs.writeFileSync(path.join(V3, B.PRAKTIJKEN.tolgaarde.pad), fs.readFileSync(TG2)); fs.writeFileSync(path.join(V3, B.PRAKTIJKEN.groenhouten.pad), fs.readFileSync(GH2));
  const D3 = path.join(W2, 'bandjes3');
  const stuurde = [];
  const c = { require: (m) => m === path.join(process.cwd(), 'bandjes.js') ? B : require(m), fs, path, process: { env: {} }, __dirname: process.cwd(),
    VAULT: V3, studio: ST, serverPad: (n, env, echt, proef) => D3, serverProefDeel: (x) => x, rolPrimair: () => true, schrijfLog: () => {}, nu: () => '', logError: () => {},
    appVersOk: (a, s) => s.vers_tot > Date.now(), appBsnAchtig: (t) => /\b\d{9}\b/.test(t), appBsnMasker: (t) => t.replace(/\b\d{9}\b/g, '[BSN-achtig getal weggelaten]'),
    appWeiger: (res, st, f) => stuurde.push({ st, j: { ok: false, fout: f } }), appStuur: (res, st, j) => stuurde.push({ st, j }) };
  vm.createContext(c);
  vm.runInContext(ctxRegel + '\n' + src.slice(a, e) + '\nthis.appBandjes = appBandjes; this.bandjesInfo = bandjesInfo;', c);
  toets('S koppeling: /opt/data/bandjes-map aangemaakt op 0700', (fs.statSync(D3).mode & 0o777) === 0o700);
  const res = () => ({ _app: {} });
  const sessie = { vers_tot: 0 };
  const apparaat = { soort: 'vast', naam: 'pc' };
  let rs = res();
  await c.appBandjes({}, rs, apparaat, sessie, {}, 'GET /app/bandjes');
  const lees = stuurde.pop();
  const tb = lees.j.praktijken[0].bandjes.find((x) => x.id === 'tg-buiten');
  toets('S GET via server.js: 200, stil', lees.st === 200 && rs._app.stil === true && tb && tb.versie === 5, lees.st);
  await c.appBandjes({}, res(), apparaat, sessie, { praktijk: 'tolgaarde', bandje: 'tg-buiten', stem: 'piper:proef-stem', versie: tb.versie, tekst_hash: tb.tekst_hash, beurt_id: beurt() }, 'POST /app/bandjes/maak');
  let o = stuurde.pop();
  toets('S maak op een flow op proef zonder verse vingerafdruk (echte ctx uit de sessie): 403 vers_nodig', o.st === 403 && o.j.vers_nodig === true, o);
  sessie.vers_tot = Date.now() + 60000;
  await c.appBandjes({}, res(), apparaat, sessie, { praktijk: 'tolgaarde', bandje: 'tg-buiten', stem: 'piper:proef-stem', versie: tb.versie, tekst_hash: tb.tekst_hash, beurt_id: beurt() }, 'POST /app/bandjes/maak');
  o = stuurde.pop();
  toets('S ... met verse vingerafdruk: 200, vingerafdruk verbruikt in de sessie', o.st === 200 && sessie.vers_tot === 0, o);
  await totDat(() => ST.taak(o.j.taak.id).status === 'klaar');
  rs = res();
  await c.appBandjes({}, rs, apparaat, sessie, { praktijk: 'tolgaarde', bandje: 'tg-buiten', tekst: 'Bel 123456782 niet.', versie: tb.versie, tekst_hash: tb.tekst_hash }, 'POST /app/bandjes/tekst');
  o = stuurde.pop();
  toets('S BSN-achtig getal op een vaste plek: gemaskeerd, niet geweigerd', o.st === 200 && o.j.bandje.tekst === 'Bel [BSN-achtig getal weggelaten] niet.' && rs._app.bsnWeg === true, o);
  toets('S health via server.js', JSON.stringify(c.bandjesInfo()) === JSON.stringify({ aan: true, dicht_tolgaarde: false, dicht_groenhouten: false }), c.bandjesInfo());
}
toets('B geen onverwachte fouten', fouts.filter((f) => !/naKlaar gooit|studio-telefoonversie|studio-normaliseer|studio-sleutel/.test(f)).length === 0, fouts);
ST.stopTimers();
fs.rmSync(W2, { recursive: true, force: true });
fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
