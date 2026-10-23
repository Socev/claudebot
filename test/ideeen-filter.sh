#!/usr/bin/env bash
# Toetst ideeen-filter.js (wv861, Ideeënbeurs fase 2: de vaste toets; bouwplan "01_Ontwikkeling/Ideeënbeurs met Albert van der Veer
# (ontwerp 22-10-2026).md" § 6 en § 13). Toetsset van 20 zinnen: 10 vieze (naam, bedrag, hostnaam, werkvoorraadnummer, telefoon, e-mail,
# IBAN, praktijknaam, pad, sleutelnaam) moeten allemaal tegengehouden worden, 10 schone allemaal door. Daarna losse randgevallen
# (postcode, adres, BSN-achtig, percentage bij een praktijkwoord wel / zonder niet, secretgrep, losse naam alleen met hoofdletter, vrije
# merknamen) en de catalogusparser (velden, lengtes, status, deelbaar, dubbel id). Met verzonnen namen: raakt de echte vault niet.
# Gebruik: bash test/ideeen-filter.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const F = require('./ideeen-filter.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 400) + ']' : '')); }
// verzonnen namen, zoals leesNamen ze uit de contactenlijst en de medewerkerspagina's zou halen
const namen = { vol: new Set(['jorien vlasblom', 'teun van der grift']), los: new Set(['jorien', 'vlasblom', 'teun', 'grift', 'bos']) };
const f = F.maak({ namen });

const VIES = [
  ['naam', 'Jorien Vlasblom bouwde dit samen met ons in een middag.'],
  ['bedrag', 'Het abonnement kost € 45 per maand en dat valt mee.'],
  ['hostnaam', 'Kijk op forum.socev.dev hoe de kaart eruitziet.'],
  ['werkvoorraadnummer', 'Dit staat uitgewerkt in wv761 en loopt nog door.'],
  ['telefoonnummer', 'Bel gerust op 033-4567890 als je vragen hebt.'],
  ['e-mailadres', 'Stuur de schermafdruk naar iemand@voorbeeld.nl voor meer.'],
  ['IBAN', 'Het geld komt binnen op NL91ABNA0417164300 aan het eind van de maand.'],
  ['praktijk- of entiteitsnaam', 'Op Tolgaarde gebruiken we dit elke ochtend bij de start.'],
  ['pad', 'Het script staat in /opt/data/mk-scripts/ideeenbeurs en draait elke nacht.'],
  ['sleutelnaam', 'Zet eerst WERKKAMER_SLEUTEL_POD in de omgeving en start opnieuw.'],
];
const SCHOON = [
  'Elke ja/nee-vraag van de assistent krijgt drie knoppen; een druk komt terug als antwoord.',
  'Eén knop op de telefoon neemt een vraag op; het antwoord wordt voorgelezen in een natuurlijke stem.',
  'Werk loopt door terwijl je slaapt, zonder dat het budget opgaat aan eigen hobby\'s van de bot.',
  'Onder elk antwoord in de app staat een knop Voorlezen.',
  'Een wekelijkse ronde leest gevolgde blogs en zet de beste ideeën klaar.',
  'Alle schermen gebruiken dezelfde kleuren, knoppen en panelen uit één bouwdoos.',
  'Wil je meer weten? Vraag het hieronder.',
  'Met Telegram, WhatsApp en Gmail als bron zoekt de assistent in alle kanalen tegelijk.',
  'De eerste tien minuten van elke taak zijn al gedaan als je opstaat.',
  'Twee keer per dag zet een motor een stap aan het idee dat het verst kan komen.',
];
VIES.forEach(function ([soort, z], i) { const t = f.toets(z); toets('vies ' + (i + 1) + ' tegengehouden (' + soort + ')', t.some((x) => x.soort === soort), t); });
SCHOON.forEach(function (z, i) { const t = f.toets(z); toets('schoon ' + (i + 1) + ' door', t.length === 0, t); });
toets('toetsset: 10 vies + 10 schoon', VIES.length === 10 && SCHOON.length === 10);

// randgevallen
const heeft = (z, soort) => f.toets(z).some((x) => x.soort === soort);
toets('volledige naam ook in kleine letters', heeft('gemaakt door teun van der grift', 'naam'));
toets('losse achternaam met hoofdletter = naam; als gewoon woord klein niet', heeft('Overleg met Bos ging goed.', 'naam') && !heeft('Een wandeling door het bos.', 'naam'));
toets('dubbele naam met streepje (Vlasblom-Grift)', heeft('Mevrouw Vlasblom-Grift belde.', 'naam'));
toets('postcode', heeft('Ons adres is 3833 AB in het dorp.', 'postcode'));
toets('adres met huisnummer', heeft('Kom langs op de Dorpsstraat 12 voor koffie.', 'adres'));
toets('BSN-achtig getal (ook met punten)', heeft('nummer 123.456.782 staat erbij', 'BSN-achtig getal'));
toets('06-nummer', heeft('app me op 06 12345678', 'telefoonnummer'));
toets('+31-nummer', heeft('bereikbaar op +31 6 1234 5678', 'telefoonnummer'));
toets('percentage bij een praktijkwoord', heeft('De omzet van de praktijk steeg 12% dit jaar.', 'percentage bij een praktijkwoord'));
toets('percentage zonder praktijkwoord niet', !heeft('Het idee staat op 85% af.', 'percentage bij een praktijkwoord'));
toets('bedrag in woorden (euro)', heeft('Dat scheelt 300 euro per jaar.', 'bedrag'));
toets('huisdokter.dev en *.olares.com', heeft('zie huisdokter.dev', 'hostnaam') && heeft('n8n.voorbeeld.olares.com', 'hostnaam'));
toets('vaultpad met 01_Ontwikkeling/', heeft('staat in 01_Ontwikkeling/Plan', 'pad'));
toets('bestandsnaam .md', heeft('lees Systeemoverzicht.md eerst', 'pad'));
toets('n8n-workflowid (16 tekens gemengd)', heeft('workflow E2QG1yARZY0Js4KQ draait', 'workflow'));
toets('workflownaam AI - …', heeft('de workflow AI - Werkkamer-post antwoordt', 'workflow'));
toets('run-nummer', heeft('zie run 91148 voor de proef', 'workflow'));
toets('sleutelnaam klein (n8n_verzender_secret)', heeft('kluisregel n8n_verzender_secret', 'sleutelnaam'));
toets('secretgrep: werkkamer-sleutel', heeft('wk_appie_' + 'A'.repeat(30), 'sleutel'));
toets('secretgrep: token = …', heeft('token=' + 'x'.repeat(20), 'sleutel'));
toets('praktijknaam POT alleen in hoofdletters (pot = gewoon woord)', heeft('de POT doet mee', 'praktijk- of entiteitsnaam') && !heeft('een pot koffie', 'praktijk- of entiteitsnaam'));
toets('merknamen en Socev vrij', f.toets('Socev leest Todoist, Gemini en Whisper.').length === 0, f.toets('Socev leest Todoist, Gemini en Whisper.'));
toets('hooguit 20 treffers, elk ≤ 60 tekens', (() => { const t = f.toets(VIES.map((x) => x[1]).join(' ').repeat(3)); return t.length <= 20 && t.every((x) => x.treffer.length <= 60); })());
// Fable-review wv861
const fd = F.maak({ namen: { vol: new Set(['david schaap', 'cynthia klaver']), los: new Set(['david', 'schaap', 'cynthia', 'klaver']) } });
const hd = (z, soort) => fd.toets(z).some((x) => x.soort === soort);
toets('Fable #1: bezitsvormen (Davids, Cynthia\'s, Cynthia’s) = naam', hd('Davids agenda staat vol.', 'naam') && hd("Cynthia's idee was goed.", 'naam') && hd('Cynthia’s idee was goed.', 'naam'));
toets('Fable #2: zachte afbreking / nulbreedte / breedtevariant: naam én "onzichtbaar teken"', hd('Da\u00ADvid Sch\u00ADaap belde', 'naam') && hd('Da\u00ADvid Sch\u00ADaap belde', 'onzichtbaar teken') && hd('Da\u200Bvid kwam', 'naam') && hd('Ｄavid kwam', 'naam'));
toets('Fable #3: elke domeinnaam (ook .eu, .de, github.com)', heeft('zie voorbeeld.eu', 'hostnaam') && heeft('kijk op github.com/x', 'hostnaam') && heeft('iets.de', 'hostnaam'));
toets('Fable #11: wv 861, 06 12 34 56 78, 06 1234 5678, 45,-, €45 heel', heeft('in wv 861', 'werkvoorraadnummer') && heeft('bel 06 12 34 56 78', 'telefoonnummer') && heeft('bel 06 1234 5678', 'telefoonnummer') && heeft('kost 45,- per maand', 'bedrag') && f.toets('kost €45').some((x) => x.soort === 'bedrag' && x.treffer === '€45'));
toets('gewone afkortingen (o.a., i.p.v., bijv.) geen hostnaam', !heeft('o.a. knoppen, i.p.v. tekst, bijv. een lijst', 'hostnaam'));
toets('leeg en null zijn schoon', f.toets('').length === 0 && f.toets(null).length === 0);

// leesNamen op een kleine nepvault
const fs = require('fs'), os = require('os'), path = require('path');
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'ideeen-filter-'));
fs.mkdirSync(path.join(V, '20_Prive/Contacten'), { recursive: true });
fs.mkdirSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers'), { recursive: true });
fs.writeFileSync(path.join(V, '20_Prive/Contacten/Contacten.md'), '# C\n\n- **(geen naam)**\n- **+31 6 12345678**\n- **Kees Plompen, huisarts** - tel: x\n- **1Password Billing Support** - mail: y\n');
fs.writeFileSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/Annet Wiersma - assistente.md'), 'x');
fs.writeFileSync(path.join(V, '10_Zakelijk/Tolgaarde/Medewerkers/Index.md'), 'x');
const fv = F.maak({ vault: V });
toets('leesNamen: contact (zonder ", huisarts") en medewerker (bestandsnaam vóór " - ")', fv.toets('Kees Plompen en Annet Wiersma').filter((x) => x.soort === 'naam').length >= 2 && fv.namen().vol.has('kees plompen') && fv.namen().vol.has('annet wiersma'), [...fv.namen().vol]);
toets('leesNamen: regels zonder naam en Index overgeslagen; Billing/Support vrij', !fv.namen().los.has('index') && !fv.namen().los.has('support') && !fv.namen().los.has('billing'), [...fv.namen().los]);
fs.appendFileSync(path.join(V, '20_Prive/Contacten/Contacten.md'), '- **Ruud Hoogkamp**\n');
const st = fs.statSync(path.join(V, '20_Prive/Contacten/Contacten.md')); fs.utimesSync(path.join(V, '20_Prive/Contacten/Contacten.md'), st.atime, new Date(st.mtimeMs + 5000));
toets('namen ververst bij een nieuwe mtime', fv.toets('Ruud Hoogkamp').some((x) => x.soort === 'naam'));
fs.rmSync(V, { recursive: true, force: true });

// catalogus
const md = `# Cat\n\n### K01 · Goed\n- titel: Goed\n- wat: Doet iets.\n- waarom: Handig.\n- status: in gebruik\n- deelbaar: concept\n\n### K02 · Te lang\n- titel: ${'a'.repeat(71)}\n- wat: x\n- waarom: y\n- status: klaar\n- deelbaar: misschien\n\n### K02 · Dubbel\n- titel: tt\n- wat: w\n- waarom: z\n- status: bedacht\n- deelbaar: privé\n- link: https://x.nl\n- id: k09\n\n### Geen id\n- titel: q\n`;
const c = F.leesCatalogus(md);
toets('catalogus: 3 kaarten (blok zonder K-id genegeerd), id klein', c.kaarten.length === 3 && c.kaarten[0].id === 'k01', c.kaarten.map((k) => k.id));
toets('catalogus: K01 zonder vormfout', c.kaarten[0].vormfout.length === 0, c.kaarten[0]);
toets('catalogus: K02 titel te lang, status en deelbaar onbekend', ['titel te lang', 'status onbekend', 'deelbaar onbekend'].every((s) => c.kaarten[1].vormfout.some((x) => x.indexOf(s) === 0)), c.kaarten[1].vormfout);
toets('catalogus: dubbel id op BEIDE kaarten; link en te korte velden = vormfout; "- id:" overschrijft het id niet', c.kaarten[1].vormfout.includes('dubbel id') && c.kaarten[2].vormfout.includes('dubbel id') && c.kaarten[2].id === 'k02' &&
  c.kaarten[2].vormfout.some((x) => /^link: in fase 2 niet toegestaan/.test(x)) && c.kaarten[2].vormfout.includes('titel te kort'), c.kaarten[2]);
const c2 = F.leesCatalogus('### K05 · x\r\n- titel: Goede titel\r\n- wat: Eerste zin hier. Tweede zin hier. Derde zin hier.\r\n- waarom: Kort. En nog een.\r\n- status: bedacht\r\n- deelbaar: concept\r\n');
toets('catalogus: CRLF gelezen; wat > 2 zinnen en waarom > 1 zin = vormfout (zoals het forum)', c2.kaarten[0].titel === 'Goede titel' && c2.kaarten[0].vormfout.includes('wat: hooguit twee zinnen') && c2.kaarten[0].vormfout.includes('waarom: één zin'), c2.kaarten[0]);
toets('kaartTekst: titel, wat, waarom, link (geen bron)', F.kaartTekst({ titel: 'a', wat: 'b', waarom: 'c', bron: 'wv1', link: '' }) === 'a\nb\nc\n');

console.log('\n' + goed + ' groen, ' + fouten + ' rood');
process.exit(fouten ? 1 : 0);
JS
