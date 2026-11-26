'use strict';
// wv4120 (26-11-2026, besluitenpagina nr 407 = 3C107, David Ja 25-11 22:00): op elke storingskaart in Meldingen twee vaste regels:
// "Gevolg voor jou" (één zin per automatisering, uit deze vaste tabel, niet door een model verzonnen) en "Ingehaald" (ja met tijdstip /
// nee / hoeft niet / niet vast te stellen, deterministisch). Een storing met een echt gevolg voor Davids dag komt als "let op" in Voor jou
// (storingsdienst.js beslist dat met letOp hieronder). Ontwerp + Codex-review: mk-scripts/wv4120/ontwerp.md.
//
// Tabel per n8n-workflow-id (Stiltewachter-stroom: pijplijn_id uit stilte_state, dus dezelfde rij):
//   gevolg    één zin in gewone taal: wat David merkt als deze automatisering één keer niet doet wat hij moet doen;
//   raakt_dag true = David mist iets in zijn dag (ochtendoverzicht, bericht, concept, mail die hij leest); alleen dan "let op";
//   inhaal    'vanzelf'    de volgende gewone run neemt het achtergebleven werk mee (poller op wachtrij/label/sinds-laatste);
//             'hoeft-niet' er blijft niets liggen (losse vraag op het moment zelf, of een controle die de volgende keer gewoon opnieuw doet);
//             'nodig'      het werk van die run is weg tot iemand hem inhaalt.
// Bij een stil-alarm telt raakt_david uit stilte_state (de Stiltewachter is daar de bron), niet raakt_dag hier.
// Uitbreiden = één regel; test/storing-gevolg.sh eist dat elke sleutel in werkers.js staat (actief of als overig) of als hartslag-stroom.

const GEVOLG = {
  // ── nachtwachters en ochtend: raken zijn dag ──
  FjPfBi64ND5PboBW: { naam: 'Dagelijkse briefing', raakt_dag: true, inhaal: 'nodig', gevolg: 'Je ochtendbericht kwam niet, of later dan normaal.' },
  '2sGqWO46keLSzNQw': { naam: 'Agenda-Wachter', raakt_dag: true, inhaal: 'nodig', gevolg: 'De nachtcontrole van je agenda (botsingen, boekingen, reistijd) ontbreekt in je ochtendoverzicht.' },
  s671dCP1OdjwzBGU: { naam: 'Correspondentie-Wachter', raakt_dag: true, inhaal: 'nodig', gevolg: 'De nachtcontrole op onbeantwoorde mails en je eigen open toezeggingen ontbreekt in je ochtendoverzicht.' },
  ExKOlDQ012gyJRuB: { naam: 'Personeels-Wachter', raakt_dag: true, inhaal: 'nodig', gevolg: 'De nachtcontrole op contracten, einddata en personeelstermijnen ontbreekt in je ochtendoverzicht.' },
  mYPR5ObQheQOcnyd: { naam: 'Actie-Bewaker', raakt_dag: true, inhaal: 'nodig', gevolg: 'De nachtcontrole op open actiepunten uit notulen en WhatsApp ontbreekt in je ochtendoverzicht.' },
  lKcF3Oxt8WVeELPJ: { naam: 'Nachtconsolidatie', raakt_dag: true, inhaal: 'nodig', gevolg: 'Wat je gisteren met Socev besprak, is (nog) niet vastgelegd in je Second Brain; Socev kan het vandaag vergeten zijn.' },
  // ── kanalen en concepten: hij wacht erop ──
  OfQgM9h4qGY2dFm8: { naam: 'Claude via Telegram', raakt_dag: true, inhaal: 'nodig', gevolg: 'Een bericht van jou aan Socev via Telegram kreeg (nog) geen antwoord.' },
  ruUxLjRmYxgM8jzp: { naam: 'Mailconcept naar Gmail', raakt_dag: true, inhaal: 'nodig', gevolg: 'Een mailconcept dat Socev voor je klaarzette, staat mogelijk niet in Gmail.' },
  // ── meelezen: komt later binnen ──
  am4hmDfEmCGOwCHD: { naam: 'Outlook meelezen', raakt_dag: true, inhaal: 'nodig', gevolg: 'Werkmail uit Outlook komt later of niet bij Socev; overzichten kunnen die mail missen.' },
  eS05MJkluKyINPls: { naam: 'Teams meelezen', raakt_dag: true, inhaal: 'nodig', gevolg: 'Teams-berichten komen later of niet bij Socev; overzichten kunnen die berichten missen.' },
  zbotiGO4UHG8w10j: { naam: 'Parro meelezen', raakt_dag: true, inhaal: 'nodig', gevolg: 'Berichten uit Parro (school) komen later of niet bij Socev.' },
  '8swfS8Km2fhuJSdT': { naam: 'Signal meelezen', raakt_dag: true, inhaal: 'vanzelf', gevolg: 'Nieuwe Signal-berichten komen later bij Socev; de volgende lezing (elk kwartier) haalt ze op.' },
  BIDXbs6nAN3vWLcJ: { naam: 'Second Brain - Mail Processor', raakt_dag: true, inhaal: 'vanzelf', gevolg: 'Nieuwe mail komt later in je Second Brain; de volgende ronde (elke 3 uur) neemt hem mee.' },
  '9tOfRu1yQeycCwrk': { naam: 'Mail volgen', raakt_dag: true, inhaal: 'vanzelf', gevolg: 'Een mail die je liet volgen (label Socev-volgt) wordt later opgepakt.' },
  // ── nachtextracties: later in de Second Brain ──
  DVUqVkEIt8rKPR7L: { naam: 'WhatsApp Nachtextractie', raakt_dag: false, inhaal: 'nodig', gevolg: 'De WhatsApp-berichten van gisteren staan (nog) niet in je Second Brain.' },
  agntIie8d9mqOlm6: { naam: 'WhatsApp Conversatie-consolidatie', raakt_dag: false, inhaal: 'nodig', gevolg: 'De WhatsApp-gesprekken van gisteren zijn (nog) niet bijgewerkt in je Second Brain.' },
  '5yl8k8SWT4sK4spi': { naam: 'Signal Nachtextractie', raakt_dag: false, inhaal: 'nodig', gevolg: 'De Signal-berichten van gisteren staan (nog) niet in je Second Brain.' },
  vmFrhWxNc7KrpdIL: { naam: 'Teams extractie + consolidatie', raakt_dag: false, inhaal: 'nodig', gevolg: 'De Teams-gesprekken van dit dagdeel zijn (nog) niet bijgewerkt in je Second Brain.' },
  '8o2bg3RXj6EJ02yF': { naam: 'Contacten Sync', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Een nieuw of gewijzigd contact uit Google is nog niet bekend bij Socev.' },
  MU9HdXpIpESnM7tB: { naam: 'Health-rapporten', raakt_dag: false, inhaal: 'nodig', gevolg: 'Een gezondheidsrapport komt later of niet in je gezondheidsdossier.' },
  // ── op verzoek (luiken): er blijft niets liggen ──
  '02Jga3TIAEigwgw0': { naam: 'WhatsApp Chats Zoeken', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Een zoekvraag van Socev in je WhatsApp mislukte; dat antwoord kan onvolledig zijn geweest.' },
  GIuod668nbn9YPXI: { naam: 'WhatsApp Chat Reader', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Socev kon een WhatsApp-gesprek even niet lezen; dat antwoord kan onvolledig zijn geweest.' },
  JD0yNxPq79jXk25J: { naam: 'Agenda-Wachter API', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Socev kon je agenda even niet lezen; een antwoord of controle van dat moment kan onvolledig zijn.' },
  Bl2ZEi8H36CbSu48: { naam: 'Voorlezen', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Een audiobericht dat je vroeg, kwam niet; vraag het zo nodig opnieuw.' },
  ZmtqbIKwoKp4UTHe: { naam: 'Secret-invoerluik', raakt_dag: false, inhaal: 'nodig', gevolg: 'Een sleutel die net is ingevoerd, is mogelijk niet opgeslagen.' },
  // ── achter de schermen: niets dat hij merkt ──
  I33oOyrHzUdK1hSM: { naam: 'CISO-bezorger', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Een beveiligingsbericht komt later in de machinekamer; aan je dag verandert niets.' },
  CH35hNIhH4aKJA4H: { naam: 'Werkvoorraad-tikker', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Klussen van de machinekamer starten later; je merkt het alleen als je op een rapport wacht.' },
  '2vnKvuZ4Cu3SEcNJ': { naam: 'Locatie (Tasker)', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Socev weet even niet waar je bent; meldingen kunnen dan op een minder handig moment komen.' },
  nDj2qyAC5hJL5eUU: { naam: 'Claude Debug via Telegram', raakt_dag: false, inhaal: 'nodig', gevolg: 'Een bericht in het debug-kanaal op Telegram kreeg (nog) geen antwoord.' },
  pwXNABV5CYnnv0as: { naam: 'Heartbeat - proactief overdag', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Een tussentijds seintje van Socev bleef uit; de volgende ronde kijkt opnieuw.' },
  vGPtvfzNhqVDVjgX: { naam: 'n8n Git-backup', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Niets dat je merkt; alleen de reservekopie van de automatiseringen van die nacht ontbreekt.' },
  fknxVgWDPcDAa4ZP: { naam: 'Site-verversing', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'socev.dev toont nog de vorige stand.' },
  '1LjJcxpO8ZJ6y6iQ': { naam: 'Ideeënmotor', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Niets dat je merkt; de ideeënronde van die dag valt uit.' },
  '7PzT2InwDZQo1acS': { naam: 'MrLean', raakt_dag: false, inhaal: 'nodig', gevolg: 'Niets dat je merkt; de wekelijkse lean-ronde met voorstellen schuift op.' },
  OcLEvP7xgEd9khA3: { naam: 'Research-scout', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Niets dat je merkt; de onderzoeksronde van die dag valt uit.' },
  Oo1wBLEJJYpua3UP: { naam: 'Bericht-foutteller', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Niets dat je merkt; de telling van mislukte berichten liep even niet.' },
  // ── Stiltewachter-stromen zonder n8n-workflow (pijplijn_id = hartslag-…) ──
  'hartslag-locatie': { naam: 'Locatie van je telefoon', raakt_dag: false, inhaal: 'hoeft-niet', gevolg: 'Socev weet even niet waar je bent; meldingen kunnen dan op een minder handig moment komen.' },
  'hartslag-bank': { naam: 'Bank-ronde', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Nieuwe banktransacties komen later in je overzichten.' },
  'hartslag-paypal': { naam: 'PayPal-ronde', raakt_dag: false, inhaal: 'vanzelf', gevolg: 'Nieuwe PayPal-betalingen komen later in je overzichten.' },
  'hartslag-harvester': { naam: 'Harvester-ronde', raakt_dag: false, inhaal: 'nodig', gevolg: 'Niets dat je merkt; de oogst van nieuwe bronnen voor de Second Brain schuift op.' },
  'hartslag-syncthing': { naam: 'Syncthing', raakt_dag: true, inhaal: 'vanzelf', gevolg: 'Wijzigingen in je Second Brain komen later aan op de Synology en je pc\'s.' },
};

const INHAAL_REDEN = { 'hoeft-niet': 'er blijft niets liggen; de volgende keer gaat het gewoon opnieuw.' };

function regel(id) { return id && Object.prototype.hasOwnProperty.call(GEVOLG, String(id)) ? GEVOLG[String(id)] : null; }

// Gevolg voor de kaart. r = regel of null; uitgezocht = de gevolgzin van het onderzoek (storingsdienst) als die er is.
function gevolgTekst(r, uitgezocht) {
  if (r) return { tekst: r.gevolg, bron: 'vast' };
  if (uitgezocht && !/^niet vast te stellen/i.test(uitgezocht)) return { tekst: uitgezocht, bron: 'onderzoek' };
  return { tekst: 'Niet vastgelegd wat je hiervan merkt.', bron: 'onbekend' };
}

// Ingehaald, deterministisch. i = { soort: 'storing'|'stil', zelfherstel: bool, r: regel|null,
//   onderzoek: { stand: 'bewezen'|'onzeker'|'kapot'|'afwachten', afloop, afloop_op }|null, herstel: { stand: 'weer-goed'|'nog-fout'|'onbekend', op, tekst }|null }
// → { stand: 'ja'|'nee'|'hoeft-niet'|'onbekend', op: ISO|null, toelichting }
function ingehaald(i) {
  const r = i.r, o = i.onderzoek || null, h = i.herstel || null;
  const vanzelf = !!(i.zelfherstel || (r && r.inhaal === 'vanzelf'));
  // Codex MOET 1 (ontwerpreview): een stroom die weer aanlevert bewijst herstel, niet dat de gemiste aanvoer is ingehaald; dat telt
  // alleen bij een stroom die zijn achterstand zelf meeneemt (inhaal vanzelf). Een storing met bewezen afloop (ingehaald, retry gelukt,
  // ZELFHERSTEL-run) is wél bewijs.
  const stilZonderBewijs = i.soort === 'stil' && !vanzelf;
  if (o && o.stand === 'bewezen' && !stilZonderBewijs) return { stand: 'ja', op: o.afloop_op || null, toelichting: o.afloop || '' };
  if (h && h.stand === 'weer-goed' && vanzelf) return { stand: 'ja', op: h.op || null, toelichting: h.tekst || '' };
  if (r && r.inhaal === 'hoeft-niet') return { stand: 'hoeft-niet', op: null, toelichting: INHAAL_REDEN['hoeft-niet'] };
  if ((h && h.stand === 'nog-fout') || (o && o.stand === 'kapot')) return { stand: 'nee', op: null, toelichting: (o && o.stand === 'kapot' ? o.afloop : h && h.tekst) || 'het gaat nog mis.' };
  if (vanzelf) return { stand: 'nee', op: null, toelichting: 'nog niet; de volgende gewone run neemt het mee.' };
  if (o && o.stand === 'afwachten') return { stand: 'nee', op: null, toelichting: o.afloop || 'nog niet opnieuw gedraaid.' };
  if (stilZonderBewijs && ((o && o.stand === 'bewezen') || (h && h.stand === 'weer-goed')))
    return { stand: 'onbekend', op: null, toelichting: String((h && h.stand === 'weer-goed' && h.tekst) || (o && o.afloop) || 'levert weer aan.').replace(/\.?$/, '') + '; of wat in de stille tijd binnen had moeten komen alsnog binnen is, is niet te zien.' };
  return { stand: 'onbekend', op: null, toelichting: (o && o.afloop) || (h && h.tekst) || '' };
}
function ingehaaldTekst(x, klok) {
  const t = x.toelichting ? ' — ' + String(x.toelichting).replace(/^\s+/, '') : '';
  if (x.stand === 'ja') return 'Ja' + (x.op ? ', ' + klok(x.op) : '') + t;
  if (x.stand === 'hoeft-niet') return 'Hoeft niet' + t;
  if (x.stand === 'nee') return 'Nee' + t;
  return 'Niet vast te stellen' + t;
}

// "Let op" in Voor jou: alleen bij een automatisering die Davids dag raakt (raakt = regel.raakt_dag, bij stil raakt_david uit
// stilte_state) en die niet is ingehaald. Een 'vanzelf'-automatisering pas als hij nog kapot is (anders neemt de volgende run het mee);
// een stille stroom alleen zolang hij nog stil is.
function letOp(raakt, r, inh, afStand, soort) {
  if (raakt !== true) return false;
  if (soort === 'stil' && afStand !== 'kapot') return false;   // stroom levert weer aan (of stand onbekend): geen let op, de kaart zegt het
  if (inh.stand === 'ja' || inh.stand === 'hoeft-niet') return false;
  if (r && r.inhaal === 'vanzelf' && afStand !== 'kapot') return false;
  return true;
}

module.exports = { GEVOLG, regel, gevolgTekst, ingehaald, ingehaaldTekst, letOp };
