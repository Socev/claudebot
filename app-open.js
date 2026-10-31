'use strict';
// OVIS M6-pod (wv1712, ontwerplijnen § 3.6; David Ja 24-10 20:51 op keuze 6, e1580d70): Socev stuurt de weergave.
// Socev zet als LAATSTE regel van zijn antwoord, buiten codeblok en citaat, één opdrachtregel:
//   [OPEN scherm=<module-id>]  of  [OPEN scherm=<module-id> focus=<soort>:<waarde>]
// De pod haalt elke zo'n regel (buiten codeblokken en citaten) uit alle uitvoer, ook Telegram, agentrapporten en /bericht, en
// geeft hem alleen bij een app-beurt in het hoofdgesprek als veld mee, alleen aan het apparaat dat de beurt typte.
//
// Waarom streng (Fable 24-10 #3): de pod kan niet zien of Socev de regel zelf schreef of overnam uit een mail die hij op Davids
// verzoek las. Daarom wordt het een wissel (vorm 3: de app opent zelf) alleen als focus LEEG is (de App op zijn startscherm) of
// verwijst naar iets dat de pod in DEZE beurt zelf maakte (een bandjesvoorstel, een bestand van deze job). Elk ander doel wordt
// een kaartlink (vorm 1: David tikt zelf). Een regel in een agentrapport, briefing, wachter of Telegram-beurt: alleen weg, geen veld.
// Welk apparaat (Fable 24-10 #4): alleen het apparaat van de beurt krijgt het veld; op een vaste plek nooit naar een privé-module.
//
// Logica zonder opslag of HTTP (drie lagen, § 4.4); server.js knipt, registreert wat de pod maakte en levert uit.
//
// STUURBAAR = de catalogus (socev-app src/modules.ts) met stuurbaar: true — lezen en concepten. Bewust niet: het gesprek zelf
// (hoofd), de Machinekamer en zijn onderdelen (machinekamer, agents, meldingen, managers), de Cijfer-Meester (eigen gesprek),
// instellingen en het slot. Een nieuwe module wordt pas stuurbaar als hij hier bijkomt (en in de catalogus).
const STUURBAAR = ['overzicht', 'intake', 'apps', 'brain',
  'praktijken', 'projecten', 'bandjes', 'financien', 'gezondheid', 'facturen', 'bestanden', 'pot-afschriften', 'studio',
  'broedstoof', 'mediatheek', 'harvester', 'ideeen', 'flock', 'verbruik', 'secondbrain', 'pot'];   // wv1894: OVIS POT; wv2077: docs eruit (opgegaan in Brain)
// Strikt (de enige vorm die telt): precies zo, op één regel, vooraan de regel, zonder opmaak eromheen.
const STRIKT_RE = /^\[OPEN scherm=([a-z][a-z0-9-]{1,39})(?: focus=([^\s\]]{1,100}))?\]$/;
// Ruim (wat er altijd uit gaat): ook met opmaak eromheen, andere hoofdletters of extra spaties. Wordt getoetst op de genormaliseerde
// regel (onzichtbare opmaaktekens weg, NFKC: vol-breedte ［ wordt [), zoals appOntmasker.
const RUIM_RE = /^[\s*_~`]*\[\s*OPEN\b[^\]\n]*\][\s*_~`.]*$/i;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const CITAAT_RE = /^\s{0,3}>/;
// Focusvorm zoals de kaartdoelen van M3b (appVjDoel): "<soort>:<waarde>", geen spatie, geen pad naar buiten.
const FOCUS_RE = /^[a-z][a-z-]{0,19}:[A-Za-z0-9._:\/-]{1,80}$/;
const BESTAND_RE = /^bestand:([a-f0-9]{16})\/([1-9][0-9]{0,2})$/;            // bestanden: <job>/<n> uit de tab Bestanden (appBewaar)
const VOORSTEL_RE = /^voorstel:(tolgaarde|groenhouten)\/((?:tg|gh)-[a-z0-9-]{2,30})$/;   // bandjes: praktijk/bandje-id (bandjes.js ID_RE)

function norm(l) { return String(l).replace(/\p{Cf}/gu, '').normalize('NFKC'); }

// Knipt de OPEN-regels uit een tekst. Geeft { tekst, regel, weg }: regel = { scherm, focus } als de LAATSTE niet-lege regel
// (buiten codeblok en citaat) strikt een OPEN-regel was; weg = aantal weggehaalde regels. Codeblokken en citaten blijven ongemoeid
// (dat is geciteerde tekst; die telt nooit). Geen OPEN-regel = dezelfde tekst terug (ook geen witruimte-wijziging).
function uit(tekst) {
  const t = typeof tekst === 'string' ? tekst : '';
  if (!/OPEN/i.test(norm(t))) return { tekst: t, regel: null, weg: 0 };
  const regels = t.split('\n');
  let inBlok = false, laatsteBuiten = -1;
  const weg = [];
  regels.forEach(function (l, i) {
    if (FENCE_RE.test(l)) { inBlok = !inBlok; if (l.trim()) laatsteBuiten = -2; return; }
    if (inBlok) { if (l.trim()) laatsteBuiten = -2; return; }
    if (!l.trim()) return;
    if (CITAAT_RE.test(l)) { laatsteBuiten = -2; return; }
    if (RUIM_RE.test(norm(l).trim())) weg.push(i);
    laatsteBuiten = i;   // laatste niet-lege regel buiten codeblok en citaat (-2: de laatste niet-lege regel is code of citaat)
  });
  if (!weg.length) return { tekst: t, regel: null, weg: 0 };
  let regel = null;
  if (!inBlok && laatsteBuiten >= 0 && weg.indexOf(laatsteBuiten) >= 0) {
    const m = STRIKT_RE.exec(regels[laatsteBuiten].replace(/\s+$/, ''));   // Fable diff #2: niet ingesprongen (4 spaties = code)
    if (m) regel = { scherm: m[1], focus: m[2] || null };
  }
  const blijf = regels.filter(function (_, i) { return weg.indexOf(i) < 0; });
  return { tekst: blijf.join('\n').replace(/\s+$/, ''), regel: regel, weg: weg.length };
}

// Toetst een regel tegen de beurt. ctx: { kanaal, soort, job, bestanden (aantal bestanden van deze job), gemaakt (focus-strings
// die de pod in deze beurt maakte) }. Geeft { open: { scherm, focus, vorm } | null, reden }.
function toets(regel, ctx) {
  ctx = ctx || {};
  if (!regel) return { open: null, reden: 'geen regel' };
  if (ctx.kanaal !== 'hoofd' || ctx.soort !== 'bericht') return { open: null, reden: 'geen eigen beurt in het hoofdgesprek' };
  if (STUURBAAR.indexOf(regel.scherm) < 0) return { open: null, reden: 'scherm niet stuurbaar' };
  const f = regel.focus;
  if (!f) return { open: { scherm: regel.scherm, focus: null, vorm: 'wissel' }, reden: 'startscherm' };
  if (!FOCUS_RE.test(f)) return { open: { scherm: regel.scherm, focus: null, vorm: 'link' }, reden: 'focus ongeldig' };
  const b = BESTAND_RE.exec(f), v = VOORSTEL_RE.exec(f);
  const eigen = (regel.scherm === 'bestanden' && b && b[1] === ctx.job && Number(b[2]) <= (Number(ctx.bestanden) || 0)) ||
    (regel.scherm === 'bandjes' && v && Array.isArray(ctx.gemaakt) && ctx.gemaakt.indexOf(f) >= 0);
  return eigen ? { open: { scherm: regel.scherm, focus: f, vorm: 'wissel' }, reden: 'door de pod gemaakt' }
    : { open: { scherm: regel.scherm, focus: f, vorm: 'link' }, reden: 'focus niet door de pod in deze beurt gemaakt' };
}

// Wat een apparaat te zien krijgt. open = het veld van de beurt; beurtApparaat = het apparaat dat typte; a = het vragende apparaat
// ({ id, soort }); prive = de ene lijst privé-id's; vers = het antwoord is net klaar (een wissel geldt alleen voor het verse
// antwoord; uit de geschiedenis of later opgehaald is het een kaartlink). null = geen veld.
function voorApparaat(open, beurtApparaat, a, prive, vers) {
  if (!open || typeof open !== 'object' || !a || !a.id || a.id !== beurtApparaat) return null;
  if (a.soort === 'vast' && Array.isArray(prive) && prive.indexOf(open.scherm) >= 0) return null;
  return { scherm: open.scherm, focus: open.focus || null, vorm: open.vorm === 'wissel' && vers ? 'wissel' : 'link' };
}

module.exports = { STUURBAAR: STUURBAAR, uit: uit, toets: toets, voorApparaat: voorApparaat };
