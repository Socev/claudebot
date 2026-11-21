#!/usr/bin/env bash
# wv3768 (besluitenpagina nr 191 = 2C91 b+d): Bandjes terugmelden aan wie erom vroeg en het huidige geluid aanleveren.
# Toetst bandjes.js: veld "gevraagd door" (lezer/schrijver, route vrager, /smal gevraagd_door), het conceptantwoord bij "Staat in de
# centrale" (nep-mailluik: klaar / zeker mislukt / onzeker, nooit twee concepten, nogmaals), de terugmeldstand in GET, de belkaartstap,
# en aanleveren (upload → Bronnen-map, veld aangeleverd, uitschrift als VOORSTEL, nooit de tekst; fouten bewaren het geluid wel).
# Plus de server.js-koppeling (mailConcept/uitschrijf, geen adres in het log). Alles verzonnen, in een wegwerpmap. Gebruik: bash test/bandjes-terug.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const B = require('./bandjes.js');
const K = require('./bandjes-kaart.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
(async () => {
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bandjes-terug-'));
const VAULT = path.join(W, 'vault'), DIR = path.join(W, 'bandjes');
const TG = path.join(VAULT, B.PRAKTIJKEN.tolgaarde.pad), GH = path.join(VAULT, B.PRAKTIJKEN.groenhouten.pad);
fs.mkdirSync(path.dirname(TG), { recursive: true }); fs.mkdirSync(path.dirname(GH), { recursive: true });
const TEKST3 = 'U belt met de proefpraktijk. Wij zijn nu gesloten.\nVoor spoed belt u de huisartsenpost.';
const H3 = B.tekstHash(TEKST3);
const JOB = '0123456789abcdef';
const reg = (pr) => `---
type: register
updated: 2026-10-01
---

# Telefoonbandjes (proef wv3768, verzonnen)

## Praktijkinstellingen
- praktijkstem: piper:nl_NL-ronnie-medium

## ${pr}-buiten — Buiten kantooruren
- menu: hoofdnummer
- wanneer: buiten openingstijden
- versie: 3
- laatste bestand: 21-11-2026 · v3 · tekst ${H3} · ${JOB}/bandje.wav · piper:nl_NL-ronnie-medium (+ telefoon PCM en µ-law)
- in centrale: v2 sinds 1-10-2026, [[x]]
- status: gemaakt (v3)

**Tekst**
${TEKST3.split('\n').map((r) => '> ' + r).join('\n')}

## ${pr}-feestdagen — Feestdagen
- menu: hoofdnummer
- wanneer: op feestdagen
- versie: 0
- laatste bestand: —
- in centrale: —
- status: tekst onbekend

**Tekst**
> (onbekend — wacht op het huidige bandje)

## Versiegeschiedenis

(nog geen versies)
`;
fs.writeFileSync(TG, reg('tg')); fs.writeFileSync(GH, reg('gh'));
// nep-bestanden van de "gemaakte" werkversie (voor het archief bij Staat in de centrale)
const BD = path.join(W, 'bestanden'); fs.mkdirSync(BD);
const wav = (fmt, hz) => { const n = 800, b = Buffer.alloc(44 + n); b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(fmt, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(hz, 24); b.writeUInt32LE(hz, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); return b; };
for (const [n, b] of [['bandje.wav', wav(1, 16000)], ['bandje-telefoon-pcm.wav', wav(1, 8000)], ['bandje-telefoon-ulaw.wav', wav(7, 8000)]]) fs.writeFileSync(path.join(BD, n), b);
const bestandVan = (job) => job === JOB ? ['bandje.wav', 'bandje-telefoon-pcm.wav', 'bandje-telefoon-ulaw.wav'].map((n, i) => ({ n: i + 1, naam: n, pad: path.join(BD, n) })) : null;
const studio = { taak: () => null, lopend: () => ({ taken: [] }), flows: async () => ({ flows: [] }) };
const logs = [], fouts = [];
let mailAntw = { ok: true, concept_id: 'r-123' };
const mails = [];
let uitAntw = 'U belt met de proefpraktijk. Op feestdagen zijn wij gesloten. Voor spoed belt u de huisartsenpost.';
const uitgeschreven = [];
const S = B.maak({ vault: VAULT, dir: DIR, fout: (w, e) => fouts.push(w + ': ' + (e && e.message)) });
S.mkdir();
const R = B.routes({ opslag: S, studio, primair: () => true, dir: DIR, bestandVan, log: (r) => logs.push(r), fout: (w, e) => fouts.push(w + ': ' + (e && e.message)),
  mailConcept: async (c) => { mails.push(c); if (mailAntw instanceof Error) throw mailAntw; return mailAntw; },
  uitschrijf: async (b, hint) => { uitgeschreven.push({ bytes: b.length, hint }); if (uitAntw instanceof Error) throw uitAntw; return uitAntw; } });
const app = (route, d, ctx) => R.app(route, d, ctx || {});
const lees = (pr) => fs.readFileSync(pr === 'groenhouten' ? GH : TG, 'utf8');
const sectie = (t, id) => { const i = t.indexOf('## ' + id + ' '); const j = t.indexOf('\n## ', i + 3); return t.slice(i, j < 0 ? t.length : j); };
const bandjeGet = async (pr, id) => (await app('GET /app/bandjes')).j.praktijken.find((p) => p.id === pr).bandjes.find((b) => b.id === id);

// ── 1. pure functies ──
toets('1 vragerVan: "Naam <adres>", kaal adres, "—" en onzin', JSON.stringify(B.vragerVan('Proef Vrager <Proef.Vrager@Voorbeeld.nl>')) === JSON.stringify({ naam: 'Proef Vrager', mail: 'proef.vrager@voorbeeld.nl' }) &&
  JSON.stringify(B.vragerVan('a@b.nl')) === JSON.stringify({ naam: '', mail: 'a@b.nl' }) && B.vragerVan('—') === null && B.vragerVan('') === null && B.vragerVan('Jan <geen-adres>') === null && B.vragerVan('a@b') === null);
toets('1 vragerRegel: strikt (naam zonder <>, geldig adres), leeg = wissen', B.vragerRegel('Proef <x> "V"', 'P@V.NL').waarde === 'Proef x V <p@v.nl>' && B.vragerRegel('', '').waarde === '—' &&
  !!B.vragerRegel('Proef', '').fout && !!B.vragerRegel('Proef', 'a b@c.nl').fout && !!B.vragerRegel('', 'x@y').fout && B.vragerRegel('', 'x@y.nl').waarde === '<x@y.nl>', [B.vragerRegel('Proef <x> "V"', 'P@V.NL')]);
const m1 = B.terugmeldMail('Tolgaarde', { naam: 'Buiten kantooruren', tekst: TEKST3 }, { naam: 'Proef Vrager', mail: 'p@v.nl' }, () => Date.parse('2026-11-21T12:00:00Z'));
toets('1 terugmeldMail: onderwerp, "Hoi Proef,", datum, de tekst, "Groet,\\nDavid"; geen adres in de tekst', m1.onderwerp === 'Bandje Buiten kantooruren (Tolgaarde) staat in de centrale' && /^Hoi Proef,\n\n/.test(m1.bericht) &&
  /sinds 21-11-2026 in de telefooncentrale/.test(m1.bericht) && m1.bericht.includes(TEKST3) && /Groet,\nDavid$/.test(m1.bericht) && !/p@v\.nl/.test(m1.bericht), m1);
const mp4 = Buffer.alloc(100); mp4.write('ftypM4A ', 4);
const tgp = Buffer.alloc(100); tgp.write('ftyp3gp4', 4);
toets('1 audioSoort op de eerste bytes: wav, mp3 (ID3), m4a, 3gp, ogg; tekst of pdf = null', B.audioSoort(wav(7, 8000)).ext === 'wav' && B.audioSoort(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(80)])).ext === 'mp3' &&
  B.audioSoort(mp4).ext === 'm4a' && B.audioSoort(tgp).ext === '3gp' && B.audioSoort(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(80)])).ext === 'ogg' &&
  B.audioSoort(Buffer.from('%PDF-1.7' + ' '.repeat(80))) === null && B.audioSoort(Buffer.from('x'.repeat(100))) === null && B.audioSoort(Buffer.alloc(10)) === null);

// ── 2. route vrager ──
let r = await app('POST /app/bandjes/vrager', { praktijk: 'tolgaarde', bandje: 'tg-buiten', naam: 'Proef Vrager', mail: 'geen-adres' });
toets('2 vrager: ongeldig adres = 400, register ongemoeid', r.status === 400 && !/gevraagd door/.test(lees('tolgaarde')), r);
const voor = lees('tolgaarde');
r = await app('POST /app/bandjes/vrager', { praktijk: 'tolgaarde', bandje: 'tg-buiten', naam: 'Proef Vrager', mail: 'proef.vrager@voorbeeld.nl' });
const na = lees('tolgaarde');
toets('2 vrager: veld "gevraagd door: Proef Vrager <adres>" in de sectie, versie en tekst ongemoeid, rest van de pagina gelijk', r.status === 200 && r.j.bandje.vrager.mail === 'proef.vrager@voorbeeld.nl' &&
  /- gevraagd door: Proef Vrager <proef\.vrager@voorbeeld\.nl>/.test(sectie(na, 'tg-buiten')) && r.j.bandje.versie === 3 && r.j.bandje.tekst_hash === H3 &&
  na.replace(/^- gevraagd door: .*\n/m, '').replace(/^updated: .*$/m, '') === voor.replace(/^updated: .*$/m, ''), r);
let b = await bandjeGet('tolgaarde', 'tg-buiten');
toets('2 GET: bandje draagt vrager {naam, mail} en terugmelding null (nog niet in de centrale gezet)', b.vrager && b.vrager.naam === 'Proef Vrager' && b.terugmelding === null, b.vrager);
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-feestdagen' });
toets('2 terugmeld bij een bandje dat nog nooit in de centrale stond: 409', r.status === 409 && /nog niet in de centrale/.test(r.j.fout), r);

// ── 3. Staat in de centrale → conceptantwoord ──
r = await app('POST /app/bandjes/status', { praktijk: 'tolgaarde', bandje: 'tg-buiten', versie: 3, tekst_hash: H3 });
toets('3 Staat in de centrale: 200, archief, en het conceptantwoord is klaar (één aanroep van het mailluik)', r.status === 200 && !!r.j.archief && r.j.terugmelding && r.j.terugmelding.status === 'klaar' &&
  r.j.terugmelding.naam === 'Proef Vrager' && mails.length === 1, { r: r.j.terugmelding, mails: mails.length, fout: r.j.fout });
toets('3 het concept gaat aan de vrager, onderwerp en tekst van v3; geen secret of url in wat bandjes.js meegeeft', mails[0] && mails[0].aan === 'proef.vrager@voorbeeld.nl' && /Buiten kantooruren \(Tolgaarde\) staat in de centrale/.test(mails[0].onderwerp) &&
  mails[0].bericht.includes(TEKST3) && Object.keys(mails[0]).sort().join(',') === 'aan,bericht,onderwerp', mails[0]);
toets('3 antwoord: bandje draagt terugmelding klaar voor v3', r.j.bandje && r.j.bandje.terugmelding && r.j.bandje.terugmelding.status === 'klaar' && r.j.bandje.terugmelding.versie === 3, r.j.bandje && r.j.bandje.terugmelding);
toets('3 log zonder mailadres of tekst', logs.some((l) => /terugmeld concept tolgaarde\/tg-buiten v3/.test(l)) && !logs.some((l) => /voorbeeld\.nl|proefpraktijk/.test(l)), logs);
const st0 = JSON.parse(fs.readFileSync(path.join(DIR, 'terugmeld.json'), 'utf8'));
toets('3 stand terugmeld.json (0600): concept_op, geen concept-id of tekst', (fs.statSync(path.join(DIR, 'terugmeld.json')).mode & 0o777) === 0o600 && st0['tolgaarde/tg-buiten/v3'] && st0['tolgaarde/tg-buiten/v3'].concept_op &&
  !JSON.stringify(st0).includes('r-123') && !JSON.stringify(st0).includes('proefpraktijk'), st0);
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'tolgaarde', bandje: 'tg-buiten' });
toets('3 nog eens terugmeld: "al klaar", geen tweede concept', r.status === 200 && r.j.terugmelding.status === 'klaar' && r.j.terugmelding.al === true && mails.length === 1, r.j);
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'tolgaarde', bandje: 'tg-buiten', nogmaals: true });
toets('3 nogmaals: bewust een tweede concept', r.status === 200 && r.j.terugmelding.status === 'klaar' && !r.j.terugmelding.al && mails.length === 2, r.j);
b = await bandjeGet('tolgaarde', 'tg-buiten');
toets('3 GET: terugmelding {versie 3, klaar, op, aan}', b.terugmelding && b.terugmelding.status === 'klaar' && b.terugmelding.versie === 3 && b.terugmelding.aan === 'proef.vrager@voorbeeld.nl', b.terugmelding);

// ── 4. mislukt en onzeker (Groenhouten, zelfde vorm) ──
await app('POST /app/bandjes/vrager', { praktijk: 'groenhouten', bandje: 'gh-buiten', naam: '', mail: 'kaal@voorbeeld.nl' });
mailAntw = { ok: false, zeker: true, reden: 'Gmail weigerde het concept' };
r = await app('POST /app/bandjes/status', { praktijk: 'groenhouten', bandje: 'gh-buiten', versie: 3, tekst_hash: H3 });
toets('4 mailluik weigert zeker: bandje staat toch in de centrale, terugmelding mislukt met reden, stand weer leeg', r.status === 200 && /in centrale: v3/.test(sectie(lees('groenhouten'), 'gh-buiten')) &&
  r.j.terugmelding.status === 'mislukt' && /Gmail weigerde/.test(r.j.terugmelding.reden) && r.j.terugmelding.naam === 'kaal@voorbeeld.nl' && r.j.bandje.terugmelding === null && mails.length === 3, r.j.terugmelding);
mailAntw = { ok: false, zeker: false, reden: 'x' };
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten' });
toets('4 onzeker (geen bevestiging): status onzeker, stand aangevraagd', r.j.terugmelding.status === 'onzeker' && /Concepten/.test(r.j.terugmelding.reden) && r.j.bandje.terugmelding.status === 'aangevraagd' && mails.length === 4, r.j);
mailAntw = { ok: true, concept_id: 'r-9' };
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten' });
toets('4 binnen 24 uur na onzeker: geen nieuwe aanroep, "kijk eerst bij Concepten"', r.j.terugmelding.status === 'onzeker' && mails.length === 4, r.j);
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten', nogmaals: true });
toets('4 nogmaals na onzeker: concept klaar; kaal adres → "Hoi,"', r.j.terugmelding.status === 'klaar' && mails.length === 5 && /^Hoi,\n/.test(mails[4].bericht), r.j);
mailAntw = new Error('netwerk weg');
await app('POST /app/bandjes/vrager', { praktijk: 'groenhouten', bandje: 'gh-buiten', naam: 'Ander', mail: 'ander@voorbeeld.nl' });
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten', nogmaals: true });
toets('4 het mailluik gooit: onzeker (niet "mislukt": misschien staat het er toch)', r.status === 200 && r.j.terugmelding.status === 'onzeker', r.j);
mailAntw = { ok: true, concept_id: 'r-1' };
// tekst gewijzigd na de centrale (werkversie): het antwoord hoort bij de versie in de centrale → niet nu
const gb = await bandjeGet('groenhouten', 'gh-buiten');
await app('POST /app/bandjes/tekst', { praktijk: 'groenhouten', bandje: 'gh-buiten', tekst: 'Nieuwe proeftekst.', versie: gb.versie, tekst_hash: gb.tekst_hash });
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten', nogmaals: true });
toets('4 met een nieuwe werkversie: geen concept met de verkeerde tekst', r.j.terugmelding.status === 'mislukt' && /nieuwe tekst/.test(r.j.terugmelding.reden) && mails.length === 6, { t: r.j.terugmelding, n: mails.length });
// zonder vrager: geen aanroep
r = await app('POST /app/bandjes/vrager', { praktijk: 'groenhouten', bandje: 'gh-buiten', naam: '', mail: '' });
toets('4 vrager wissen: "gevraagd door: —", vrager null', r.status === 200 && r.j.bandje.vrager === null && /- gevraagd door: —/.test(sectie(lees('groenhouten'), 'gh-buiten')), r.j.bandje && r.j.bandje.vrager);
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'groenhouten', bandje: 'gh-buiten' });
toets('4 terugmeld zonder vrager: 409 "vul eerst in"', r.status === 409 && /vul eerst in/.test(r.j.fout), r);

// Codex MOET 2: een andere vrager = nog geen concept aan die persoon
await app('POST /app/bandjes/vrager', { praktijk: 'tolgaarde', bandje: 'tg-buiten', naam: 'Andere Vrager', mail: 'andere@voorbeeld.nl' });
b = await bandjeGet('tolgaarde', 'tg-buiten');
toets('4 MOET 2: andere vrager → terugmelding null in GET (het concept ging naar de vorige)', b.terugmelding === null, b.terugmelding);
const nM2 = mails.length;
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'tolgaarde', bandje: 'tg-buiten' });
toets('4 MOET 2: terugmeld voor de nieuwe vrager maakt een nieuw concept aan die persoon (niet "al klaar")', r.j.terugmelding.status === 'klaar' && !r.j.terugmelding.al && mails.length === nM2 + 1 && mails[nM2].aan === 'andere@voorbeeld.nl' && r.j.bandje.terugmelding.aan === 'andere@voorbeeld.nl', r.j);
// Codex MOET 1: kan de pod de aanvraag niet vastleggen, dan geen concept
const TS = path.join(DIR, 'terugmeld.json'), TSb = TS + '.bewaar';
fs.renameSync(TS, TSb); fs.mkdirSync(TS);
const nM1 = mails.length;
r = await app('POST /app/bandjes/terugmeld', { praktijk: 'tolgaarde', bandje: 'tg-buiten', nogmaals: true });
toets('4 MOET 1: stand niet te schrijven → mislukt, het mailluik niet aangeroepen', r.j.terugmelding.status === 'mislukt' && /niet vastleggen/.test(r.j.terugmelding.reden) && mails.length === nM1, r.j);
toets('4 MOET 1: geen achtergebleven tijdelijk bestand', fs.readdirSync(DIR).filter((n) => /^terugmeld\.json\.\d+$/.test(n)).length === 0, fs.readdirSync(DIR));
fs.rmdirSync(TS); fs.renameSync(TSb, TS);

// ── 5. /smal voorstel met gevraagd_door (de skill bandjes) ──
r = R.smal('voorstel', { praktijk: 'groenhouten', bandje: 'gh-feestdagen', tekst: 'Proefvoorstel.', reden: 'proef', gevraagd_door: { naam: 'Proef', mail: 'fout' } });
toets('5 smal: ongeldig gevraagd_door = 400 vóór er iets geschreven is', r.status === 400 && !/Proefvoorstel/.test(lees('groenhouten')), r);
r = R.smal('voorstel', { praktijk: 'groenhouten', bandje: 'gh-feestdagen', tekst: 'Proefvoorstel.', reden: 'proef', gevraagd_door: { naam: 'Proef Manager', mail: 'pm@voorbeeld.nl' } });
toets('5 smal: voorstel én "gevraagd door" gezet', r.status === 200 && r.j.bandje.vrager && r.j.bandje.vrager.mail === 'pm@voorbeeld.nl' && r.j.bandje.voorstel && /- gevraagd door: Proef Manager <pm@voorbeeld\.nl>/.test(sectie(lees('groenhouten'), 'gh-feestdagen')), r.j);
R.app('POST /app/bandjes/voorstel', { praktijk: 'groenhouten', bandje: 'gh-feestdagen', keuze: 'laat' }, {});

// ── 6. belkaart: stap conceptantwoord alleen als het concept klaar is voor die versie ──
const stand = R.kaartStand();
const kb = stand.find((p) => p.id === 'tolgaarde').bandjes.find((x) => x.id === 'tg-buiten');
const kaart = K.belKaart('tolgaarde', 'Tolgaarde', kb, '');
toets('6 belkaart: stap "Het conceptantwoord aan <vrager van nu> staat in Gmail … vink het daar af"', kaart.stappen.length === 4 && /^Het conceptantwoord aan Andere Vrager staat in Gmail bij Concepten/.test(kaart.stappen[3]) && /actiepunt in een overleg, vink het daar af/.test(kaart.stappen[3]), kaart.stappen);
const kaart2 = K.belKaart('tolgaarde', 'Tolgaarde', Object.assign({}, kb, { terugmelding: null }), '');
toets('6 belkaart zonder concept: drie stappen zoals in wv3723', kaart2.stappen.length === 3, kaart2.stappen);

// ── 7. aanleveren (d) ──
const PROEF_WAV = fs.existsSync('/tmp/wv3768/proef/proef-telefoon-ulaw.wav') ? fs.readFileSync('/tmp/wv3768/proef/proef-telefoon-ulaw.wav') : wav(7, 8000);
let upNeem = [], upWeg = 0;
const ctx = (bytes, naam) => ({ neemUpload: (beurt, n) => { upNeem.push([beurt, n]); return bytes ? { naam: naam || 'opname.wav', bytes, weg: () => { upWeg++; } } : null; } });
const fd = await bandjeGet('groenhouten', 'gh-feestdagen');
const D = { praktijk: 'groenhouten', bandje: 'gh-feestdagen', beurt_id: 'beurt-3768-0001', n: 1, versie: fd.versie, tekst_hash: fd.tekst_hash };
r = await app('POST /app/bandjes/aanlever', Object.assign({}, D, { versie: 5 }), ctx(PROEF_WAV));
toets('7 aanlever met verkeerde versie: 409 gewijzigd, niets bewaard', r.status === 409 && r.j.gewijzigd && upNeem.length === 0, r);
r = await app('POST /app/bandjes/aanlever', D, ctx(null));
toets('7 aanlever zonder upload: 400 "kies het opnieuw"', r.status === 400 && /kies het opnieuw/.test(r.j.fout), r);
r = await app('POST /app/bandjes/aanlever', D, ctx(Buffer.from('%PDF-1.7' + ' '.repeat(200)), 'x.pdf'));
toets('7 aanlever met een pdf: 400 geen geluid, niets in Bronnen', r.status === 400 && /geen geluidsbestand/.test(r.j.fout) && !fs.existsSync(path.join(VAULT, '10_Zakelijk/Groenhouten/Bronnen')), r);
r = await app('POST /app/bandjes/aanlever', D, ctx(PROEF_WAV));
const bron = path.join(VAULT, '10_Zakelijk/Groenhouten/Bronnen');
const bronnen = fs.existsSync(bron) ? fs.readdirSync(bron) : [];
const iso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
toets('7 aanlever: 200, geluid in Groenhouten/Bronnen als "Groenhouten - <datum> - Telefoonbandje Feestdagen (aangeleverd).wav" (0644, byte-gelijk)', r.status === 200 &&
  bronnen.join() === 'Groenhouten - ' + iso + ' - Telefoonbandje Feestdagen (aangeleverd).wav' && fs.readFileSync(path.join(bron, bronnen[0])).equals(PROEF_WAV) && (fs.statSync(path.join(bron, bronnen[0])).mode & 0o777) === 0o644, { r: r.j, bronnen });
const sf = sectie(lees('groenhouten'), 'gh-feestdagen');
toets('7 uitschrift als VOORSTEL met reden; de tekst blijft onbekend, versie 0', r.j.bandje.voorstel && r.j.bandje.voorstel.tekst === uitAntw && /uitgeschreven uit het geluid dat je op \d{1,2}-\d{1,2}-\d{4} aanleverde/.test(r.j.bandje.voorstel.kop) &&
  r.j.bandje.onbekend === true && r.j.bandje.versie === 0 && /> \(onbekend — wacht op het huidige bandje\)/.test(sf) && /\*\*Voorstel van Socev\*\*/.test(sf), r.j.bandje);
toets('7 veld "aangeleverd: <datum> · [[pad naar de opname]]", ≤ 160 tekens', /- aangeleverd: \d{1,2}-\d{1,2}-\d{4} · \[\[10_Zakelijk\/Groenhouten\/Bronnen\/Groenhouten - \d{4}-\d{2}-\d{2} - Telefoonbandje Feestdagen \(aangeleverd\)\.wav\]\]$/m.test(sf) &&
  sf.split('\n').every((x) => x.length <= 170) && r.j.bandje.aangeleverd.length <= 160, sf.slice(0, 600));
toets('7 upload weg na het bewaren; uitschrijver kreeg het geluid met de praktijkwoorden als hint', upWeg === 1 && uitgeschreven.length === 1 && uitgeschreven[0].bytes === PROEF_WAV.length && /Groenhouten/.test(uitgeschreven[0].hint), { upWeg, uitgeschreven });
toets('7 log: soort en grootte, geen tekst', logs.some((l) => /^bandjes aanlever groenhouten\/gh-feestdagen wav \d+ bytes$/.test(l)) && !logs.some((l) => /feestdagen zijn wij gesloten/.test(l)), logs.slice(-3));
// mislukt uitschrijven: geluid blijft, tweede bestand -2
uitAntw = new Error('Whisper 500');
r = await app('POST /app/bandjes/aanlever', Object.assign({}, D, { beurt_id: 'beurt-3768-0002' }), ctx(PROEF_WAV));
const bronnen2 = fs.readdirSync(bron).sort();
toets('7 uitschrijven mislukt: 502 met "het geluid is wel bewaard", tweede opname naast de eerste (nooit overschreven)', r.status === 502 && /wel bewaard/.test(r.j.fout) && bronnen2.length === 2 && bronnen2.some((n) => / \(aangeleverd 2\)\.wav$/.test(n)), { r: r.j, bronnen2 });
uitAntw = '';
r = await app('POST /app/bandjes/aanlever', Object.assign({}, D, { beurt_id: 'beurt-3768-0003' }), ctx(PROEF_WAV));
toets('7 niets verstaan: 422, geluid bewaard, voorstel van de eerste aanlevering blijft', r.status === 422 && /verstond niets/.test(r.j.fout) && fs.readdirSync(bron).length === 3 && (await bandjeGet('groenhouten', 'gh-feestdagen')).voorstel.tekst.length > 10, r.j);
// Codex MOET 3: tijdens het uitschrijven zet de skill een voorstel → niets overschrijven, geluid wel bewaard
const vM3 = (await bandjeGet('groenhouten', 'gh-feestdagen')).voorstel;
uitAntw = null;
const R3 = B.routes({ opslag: S, studio, primair: () => true, dir: DIR, bestandVan, log: () => {}, fout: () => {}, mailConcept: async () => ({ ok: true, concept_id: 'x' }),
  uitschrijf: async () => { R.smal('voorstel', { praktijk: 'groenhouten', bandje: 'gh-feestdagen', tekst: 'Voorstel van de skill tijdens het uitschrijven.', reden: 'proef MOET 3' }); return 'Het uitschrift.'; } });
const nBron = fs.readdirSync(bron).length;
r = await R3.app('POST /app/bandjes/aanlever', Object.assign({}, D, { beurt_id: 'beurt-3768-0m3' }), ctx(PROEF_WAV));
const vNa = (await bandjeGet('groenhouten', 'gh-feestdagen')).voorstel;
toets('7 MOET 3: voorstel veranderde tijdens het uitschrijven → 409 gewijzigd, voorstel van de skill blijft, geluid wel bewaard', r.status === 409 && r.j.gewijzigd && /wel bewaard/.test(r.j.fout) && vNa && vNa.tekst === 'Voorstel van de skill tijdens het uitschrijven.' &&
  fs.readdirSync(bron).length === nBron + 1 && JSON.stringify(vM3) !== JSON.stringify(vNa), { r: r.j, vNa });
// een bandje met tekst: niet
const tb = await bandjeGet('tolgaarde', 'tg-buiten');
r = await app('POST /app/bandjes/aanlever', { praktijk: 'tolgaarde', bandje: 'tg-buiten', beurt_id: 'beurt-3768-0004', n: 1, versie: tb.versie, tekst_hash: tb.tekst_hash }, ctx(PROEF_WAV));
toets('7 bandje met tekst: 409, niets bewaard', r.status === 409 && /al een tekst/.test(r.j.fout) && !fs.existsSync(path.join(VAULT, '10_Zakelijk/Tolgaarde/Bronnen')), r);
// grens per uur
uitAntw = 'Proef.';
let laatste = null;
for (let i = 0; i < 9; i++) laatste = await app('POST /app/bandjes/aanlever', Object.assign({}, D, { beurt_id: 'beurt-3768-1' + String(i).padStart(3, '0') }), ctx(wav(1, 16000)));
toets('7 hooguit 10 aanleveringen per uur (de 11e: 429)', laatste.status === 429, laatste);
// zonder uitschrijver (oude koppeling)
const R0 = B.routes({ opslag: S, studio, primair: () => true, dir: DIR, bestandVan, log: () => {}, fout: () => {} });
r = await R0.app('POST /app/bandjes/aanlever', D, ctx(PROEF_WAV));
toets('7 zonder uitschrijver in de koppeling: 503', r.status === 503, r);

// ── 8. server.js-koppeling ──
const src = fs.readFileSync('server.js', 'utf8');
const a = src.indexOf('// ── Bandjes (wv743'), e = src.indexOf('// ── einde bandjes ──');
const blok = src.slice(a, e);
toets('8 server.js: mailConcept en uitschrijf in de deps; mailluik = AI - Mailconcept naar Gmail (POT_AF_MAILWF), uitschrijven = appWhisper',
  /mailConcept: function \(c\) \{ return bandjesMailConcept\(c\); \}, uitschrijf: function \(b, hint\) \{ return bandjesUitschrijf\(b, hint\); \}/.test(blok) &&
  /async function bandjesMailConcept\(c\)/.test(blok) && /typeof POT_AF_MAILWF === 'string' \? POT_AF_MAILWF/.test(blok) && /return appWhisper\(b, hint\);/.test(blok), null);
// de mailfunctie in een vm met een nep-n8n: 200 ok, 404 dan opnieuw, 400 zeker, 502 van het luik zeker, kale 502 onzeker; secret alleen in de body
const http = require('http');
let antw = [], gezien = [];
const srv = http.createServer((q, s) => { let t = ''; q.on('data', (d) => t += d); q.on('end', () => { gezien.push({ url: q.url, body: JSON.parse(t) }); const [st, j] = antw.shift() || [500, {}]; s.writeHead(st, { 'content-type': 'application/json' }); s.end(JSON.stringify(j)); }); });
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const basis = 'http://127.0.0.1:' + srv.address().port;
const c = { require, fs, path, process: { env: { N8N_WEBHOOK_MAILCONCEPT: 'proefgeheim' } }, fetch, AbortSignal, __dirname: process.cwd(), VAULT, studio: null, serverPad: () => path.join(W, 'b8'), serverProefDeel: (x) => x,
  rolPrimair: () => true, schrijfLog: () => {}, nu: () => '', logError: () => {}, appStudioCtx: () => ({}), appWeiger: () => {}, appStuur: () => {}, bandjesBestandVan: () => null,
  appWebhookUrl: async (wf, naam, sl, opnieuw) => basis + '/webhook/' + wf + (opnieuw ? '-2' : ''), POT_AF_MAILWF: 'ruUxLjRmYxgM8jzp' };
vm.createContext(c);
vm.runInContext(blok + '\nthis.bandjesMailConcept = bandjesMailConcept; this.bandjesUitschrijf = bandjesUitschrijf;', c);
const M = { aan: 'p@v.nl', onderwerp: 'O', bericht: 'B' };
antw = [[200, { ok: true, concept_id: 'r-1', thread_id: 't' }]];
let u = await c.bandjesMailConcept(M);
toets('8 mailluik 200: ok + concept_id; secret, aan, onderwerp, bericht in de body; geen bijlagen', u.ok === true && u.concept_id === 'r-1' && gezien[0].body.secret === 'proefgeheim' && gezien[0].body.aan === 'p@v.nl' && !('bijlagen' in gezien[0].body) && /ruUxLjRmYxgM8jzp$/.test(gezien[0].url), { u, g: gezien[0] });
antw = [[404, {}], [200, { ok: true, concept_id: 'r-2' }]];
u = await c.bandjesMailConcept(M);
toets('8 mailluik 404: pad opnieuw opgehaald, dan ok', u.ok === true && gezien.length === 3 && /-2$/.test(gezien[2].url), u);
antw = [[400, { ok: false }]]; u = await c.bandjesMailConcept(M);
toets('8 mailluik 400: zeker geen concept', u.ok === false && u.zeker === true, u);
antw = [[502, { ok: false, fout: 'gmail' }]]; u = await c.bandjesMailConcept(M);
toets('8 mailluik 502 van het luik zelf: zeker', u.ok === false && u.zeker === true, u);
antw = [[502, 'x']]; u = await c.bandjesMailConcept(M);
toets('8 kale 502 of 200 zonder concept_id: onzeker', u.ok === false && u.zeker === false, u);
c.process.env.N8N_WEBHOOK_MAILCONCEPT = '';
u = await c.bandjesMailConcept(M);
toets('8 zonder luik-sleutel: zeker niets', u.ok === false && u.zeker === true && /niet ingericht/.test(u.reden), u);
let gooit = null; try { await c.bandjesUitschrijf(Buffer.alloc(10)); } catch (x) { gooit = x.message; }
toets('8 uitschrijven zonder Cloudflare-sleutel: duidelijke fout', /staat op de pod niet aan/.test(String(gooit)), gooit);
srv.close();

toets('B geen onverwachte fouten', fouts.filter((f) => !/bandjes-uitschrijf: Whisper 500|bandjes-terugmeld: netwerk weg|bandjes-terugmeld-stand: EISDIR/.test(f)).length === 0, fouts);
fs.rmSync(W, { recursive: true, force: true });
console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
})().catch((e) => { console.log('ROOD  uitzondering: ' + (e && e.stack || e)); process.exit(1); });
JS
