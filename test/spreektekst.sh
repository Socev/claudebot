#!/usr/bin/env bash
# Toetst spreektekst.js (wv803, 22-10-2026): de spreektekst van een bandje — telefoonnummers in groepjes uitgeschreven, websites en
# mailadressen gespeld, kies-cijfers, tijden, afkortingen, twijfelmarkeringen weg, uitspraaklijst, [pauze] tussen zinnen — en de
# vertaling per model (v2/flash: <break time>, v3/v4: [pause]/[long pause], Piper: niets). Ook audio.normaliseer (origineel op sterkte).
# Gebruik: bash test/spreektekst.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./spreektekst.js'), A = require('./audio.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
const af = (t, u) => S.afleiden(t, u);
// getallen
toets('getal: 0, 1, 11, 21, 22, 23, 40, 85, 99', [0, 1, 11, 21, 22, 23, 40, 85, 99].map(S.getal).join(' ') === 'nul een elf eenentwintig tweeëntwintig drieëntwintig veertig vijfentachtig negenennegentig');
// telefoonnummers (David 22-10: "nul vijfentachtig, zeven zeven drie, elf, nul nul")
toets('nummer met spaties', af('Bel 085 773 11 00.') === 'Bel nul vijfentachtig, zeven zeven drie, elf, nul nul.', af('Bel 085 773 11 00.'));
toets('nummer zonder spaties: 3-3-2-2', af('Bel 0857731100.') === 'Bel nul vijfentachtig, zeven zeven drie, elf, nul nul.', af('Bel 0857731100.'));
toets('06-nummer in paren', af('Bel 0612345678.') === 'Bel nul zes, twaalf, vierendertig, zesenvijftig, achtenzeventig.', af('Bel 0612345678.'));
toets('0900-nummer', /^Bel nul negenhonderd, /.test(af('Bel 0900-1234.')), af('Bel 0900-1234.'));
toets('112 als één, één, twee', af('Bel 112.') === 'Bel één, één, twee.', af('Bel 112.'));
toets('geen nummer: een huisnummer of jaartal blijft', af('Weg 112a en 2026.') === 'Weg 112 a en 2026.', af('Weg 112a en 2026.'));
// websites en mail
toets('website met www: gespeld, n l', af('Kijk op www.hpgroenhouten.nl.') === 'Kijk op w w w punt hpgroenhouten punt n l.', af('Kijk op www.hpgroenhouten.nl.'));
toets('website zonder www, met pad', af('Ga naar huisartsenposteemland.nl/spoed') === 'Ga naar huisartsenposteemland punt n l slash spoed', af('Ga naar huisartsenposteemland.nl/spoed'));
toets('mailadres', af('Mail info@hp-groenhouten.nl') === 'Mail info apenstaartje hp streepje groenhouten punt n l', af('Mail info@hp-groenhouten.nl'));
toets('uitspraaklijst na de regels (website)', af('Kijk op www.hpgroenhouten.nl.', 'hpgroenhouten = h p groenhouten') === 'Kijk op w w w punt h p groenhouten punt n l.');
toets('uitspraaklijst: hele woorden, hoofdletterongevoelig, langste eerst', af('Gebruik Uw Zorg Online of Zorgdomein.', 'zorg = zorrug; uw zorg online = oe zorg onlijn') === 'Gebruik oe zorg onlijn of Zorgdomein.', af('Gebruik Uw Zorg Online of Zorgdomein.', 'zorg = zorrug; uw zorg online = oe zorg onlijn'));
// keuzes, tijden, afkortingen, markeringen
toets('kies 1 → kies één; optie 2 → optie twee', af('Kies 1 of optie 2') === 'Kies één of optie twee', af('Kies 1 of optie 2'));
toets('tijden en bereik', af('Open 8:00 tot 10:30 en 13:00-17:00.') === 'Open acht uur tot half elf en dertien uur tot zeventien uur.', af('Open 8:00 tot 10:30 en 13:00-17:00.'));
toets('t/m en o.a.', af('ma t/m vr, o.a. recepten') === 'ma tot en met vr, onder andere recepten');
toets('twijfelmarkering [?] weg', af('Wij zijn op [?] werkdagen open') === 'Wij zijn op werkdagen open', af('Wij zijn op [?] werkdagen open'));
// pauzes
const p = af('Eerste zin. Tweede zin? Derde zin!');
toets('pauze tussen zinnen, niet aan het eind', p === 'Eerste zin. [pauze] Tweede zin? [pauze] Derde zin!', p);
toets('witregel = één pauze, niet dubbel', af('Een.\n\nTwee.') === 'Een. [pauze] Twee.', af('Een.\n\nTwee.'));
toets('v2: break-tag met de standaardpauze', S.naarModel(p, 'eleven_multilingual_v2', { pauze: 0.7 }) === 'Eerste zin. <break time="0.7s" /> Tweede zin? <break time="0.7s" /> Derde zin!');
toets('flash: break-tag', /<break time="0\.8s" \/>/.test(S.naarModel(p, 'eleven_flash_v2_5')));
toets('v4: [pause] vanaf 0,5 s', S.naarModel(p, 'eleven_v4', { pauze: 0.8 }) === 'Eerste zin. [pause] Tweede zin? [pause] Derde zin!');
toets('v4: [long pause] vanaf 1,4 s; eigen duur per markering', S.naarModel('A. [pauze 1,5] B. [pauze] C.', 'eleven_v4', { pauze: 0.3 }) === 'A. [long pause] B. C.', S.naarModel('A. [pauze 1,5] B. [pauze] C.', 'eleven_v4', { pauze: 0.3 }));
toets('v3 gelijk aan v4', S.naarModel(p, 'eleven_v3', { pauze: 0.8 }) === S.naarModel(p, 'eleven_v4', { pauze: 0.8 }));
toets('pauze 0: geen tag', S.naarModel(p, 'eleven_multilingual_v2', { pauze: 0 }) === 'Eerste zin. Tweede zin? Derde zin!');
toets('Piper (model null): markering weg', S.naarModel(p, null) === 'Eerste zin. Tweede zin? Derde zin!');
toets('v2: audiotags worden weggehaald (anders voorgelezen)', S.naarModel('Hallo [whispering] daar.', 'eleven_multilingual_v2') === 'Hallo daar.');
toets('v4: break-tag weggehaald, audiotag blijft', S.naarModel('Hallo <break time="1s"/> [whispering] daar.', 'eleven_v4') === 'Hallo [whispering] daar.');
toets('v2: hooguit 40 break-tags, daarna …', (S.naarModel(Array(50).fill('Zin.').join(' [pauze] '), 'eleven_multilingual_v2').match(/<break/g) || []).length === 40);
toets('break hooguit 3 s', /<break time="3\.0s" \/>/.test(S.naarModel('A. [pauze 9] B.', 'eleven_multilingual_v2')));
// zinnen
toets('zinnen: stukken zonder markering', JSON.stringify(S.zinnen(p)) === JSON.stringify(['Eerste zin.', 'Tweede zin?', 'Derde zin!']), S.zinnen(p));
toets('zinnen: leeg = []', S.zinnen('').length === 0);
// uitspraaklijst
toets('lijstFout: goed, fout, streep', S.lijstFout('a = b; c = d') === null && !!S.lijstFout('a b') && S.lijstFout('—') === null && S.lijstFout('') === null);
toets('lijstNaarRegel: nieuwe regels → "; "', S.lijstNaarRegel('a = b\n c=d ') === 'a = b; c = d');
// echte tekst Groenhouten (uitschrift 22-10)
const gh = 'Zie voor meer informatie onze website www.hpgroenhouten.nl. Alleen voor zaken die echt niet kunnen wachten tot de volgende werkdag, kunt u kiezen voor optie 1. U wordt dan doorverbonden met de dienstdoende dokter.';
const ghs = af(gh, 'hpgroenhouten = h p groenhouten');
toets('echte tekst Groenhouten', ghs === 'Zie voor meer informatie onze website w w w punt h p groenhouten punt n l. [pauze] Alleen voor zaken die echt niet kunnen wachten tot de volgende werkdag, kunt u kiezen voor optie één. [pauze] U wordt dan doorverbonden met de dienstdoende dokter.', ghs);
// normaliseer
(async () => {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'spreek-'));
  const n = 24000, m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / 24000);   // piek −12 dBFS
  const pcm = A.naarPcm16(m);
  fs.writeFileSync(path.join(W, 'bandje.wav'), Buffer.concat([A.wavKop(1, 24000, 16, pcm.length), pcm]));
  fs.writeFileSync(path.join(W, 'bandje-telefoon-pcm.wav'), Buffer.concat([A.wavKop(1, 8000, 16, 4), Buffer.alloc(4)]));
  const r = await A.normaliseer(W);
  const w = A.leesWav(fs.readFileSync(path.join(W, 'bandje.wav')));
  let pk = 0; for (const x of w.monsters) pk = Math.max(pk, Math.abs(x));
  toets('normaliseer: piek −1 dBFS, zelfde bemonstering en lengte, telefoonversie overgeslagen', r.length === 1 && Math.abs(20 * Math.log10(pk) + 1) < 0.05 && w.rate === 24000 && w.monsters.length === n && Math.abs(r[0].versterking_db - 11) < 0.1, { r, pk, rate: w.rate });
  fs.writeFileSync(path.join(W, 'stil.wav'), Buffer.concat([A.wavKop(1, 24000, 16, 200), Buffer.alloc(200)]));
  fs.unlinkSync(path.join(W, 'bandje.wav'));
  const r2 = await A.normaliseer(W);
  toets('normaliseer: stilte blijft stilte (geen deling door 0)', r2.length === 1 && r2[0].versterking_db === 0, r2);
  fs.rmSync(W, { recursive: true, force: true });
  console.log(goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
