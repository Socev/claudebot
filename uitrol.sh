#!/usr/bin/env bash
# uitrol.sh — zet een nieuwe release neer op /opt/data/app en laat de supervisor
# hem oppakken. Draait ALS 'claude' op de pod, aangeroepen door de uitrolworkflow.
#
# GEBRUIK:  /app/uitrol.sh <git-sha|branch>
#           omgeving: UITROL_NU=1 (niet wachten), UITROL_WACHT_MAX=<s> (standaard 1800),
#           UITROL_AGENTS=alle (wacht op alle lopende agents i.p.v. alleen agents.kwetsbaar, wv2667),
#           UITROL_DROOG=1 (niet omzetten, voor toetsen), UITROL_MARKER=<pad> (standaard /opt/data/uitrol-wacht),
#           UITROL_NACONTROLE=0 (geen echt-nacontrole), UITROL_NACONTROLE_MAX=<s> (standaard 90), UITROL_BOX=<pad>
#           UITROL_DATAKAART=0 (datakaart-poort uit, nood), UITROL_DATAKAART_PAD=<pad>, UITROL_POORT_ALLEEN=1 (stop na de poort, toets)
#           exit 1 = mislukt, ook als de nacontrole terugzette (wv358), en als de nieuwe versie niet binnen UITROL_NACONTROLE_MAX op
#           /health verschijnt (wv3418: terugflip, halve stand, geen supervisor) - dan geen "klaar"
#           Schrijft bij elke omzetting $APP_ROOT/gewenst ({sha,tijd,door,reden}): de bedoelde versie; server.js toont hem op /health
#           (gewenst naast versie) en meldt een verschil van 10 min één keer in de machinekamer-box (wv3418, actieplan Fable 19-11 B39).
#
# WAAROM DIT EEN SCRIPT IS EN GEEN REGEL IN EEN PROMPT. De uitrol bestaat uit
# symlink-chirurgie op een draaiende pod: `vorige` bijwerken, `current` omzetten,
# het kind herstarten. Dat als los commando door een taalmodel laten samenstellen
# is precies het soort handeling waarbij één ontbrekende `-n` bij `ln` een symlink
# IN de doelmap maakt in plaats van eroverheen — en dan wijst `current` nergens
# meer heen. Hier staat het één keer goed, getest, en de workflow roept het aan.
#
# WAT HET NIET DOET: beslissen of de nieuwe release goed is. Dat doet de
# boot-zelfcontrole van de supervisor, en die flipt zelf terug. Eén uitzondering
# (wv358): een release die gezond opkomt maar in een wegwerpmap draait (/health
# server.echt false) ziet de supervisor niet; die zet stap 4b terug.
set -u

APP_ROOT="${APP_ROOT:-/opt/data/app}"
RELEASES="$APP_ROOT/releases"
CURRENT="$APP_ROOT/current"
VORIGE="$APP_ROOT/vorige"
BRON_REPO="${UITROL_REPO:-/opt/data/claudebot-src}"
BEWAAR="${UITROL_BEWAAR:-4}"     # hoeveel releases blijven staan (incl. current + vorige)
LOG="${BIN_DIR:-/opt/data/bin}/uitrol.log"

# Alleen deze bestanden vormen een release. Bewust een expliciete lijst en geen
# `cp -r` van de hele repo: dan zouden .github, Dockerfile en losse testbestanden
# meeverhuizen naar een map die als applicatie wordt gedraaid.
RELEASE_BESTANDEN="server.js telegram-reader.js koppel-telegram.js package.json"
# telegram-claude-bot.js (de oude in-container bot) is weg sinds wv1021: draaide niet meer (geen TG_TOKEN, bot.log stil sinds 26-6),
# maar startte claude met de volle omgeving en cwd = vault zonder de mk-args van mk-tekst.js. Terugrollen naar een oudere commit
# blijft kunnen: dat bestand gaat dan gewoon niet mee.
# Optioneel: gaat mee als het in de commit staat; een oudere commit zonder dit bestand blijft uitrolbaar (terugrollen).
# bank-lezer.js (wv680): alleen-lezen bankluis, aangeroepen door server.js (/smal/bank, /bank/terug).
# bunq-lezer.js (wv683): bunq-bron van de bankluis, door bank-lezer.js geladen (ontbreekt hij, dan alleen Enable Banking).
# bewaker.js (wv701): levensbewaking, door server.js losgekoppeld gestart (ontbreekt hij, dan geen bewaking).
# schijfdruk.js (wv3124): schijfdrukmeting per minuut buiten server.js, door server.js losgekoppeld gestart (ontbreekt hij, dan geen meting en /health.schijfdruk.aan=false).
# meld.js (wv3424): meldmodule van bewaker.js en schijfdruk.js (box-rij via vault-veilig in een kindproces met herkansing, seintje via bericht.py); ontbreekt hij, dan bewaken en meten ze door zonder box-rij en seintje.
# tarieven-wachter.js (wv3412, B14): 'geldig tot'-wachter van de belastingtarieven in OVIS Financiën, elk uur door server.js geladen; ontbrak tot wv3483
#   in deze lijst (elk uur MODULE_NOT_FOUND in api.log). Ontbreekt hij, dan een fout per uur in api.log en geen werkvoorraadrij. test/release-lijst.sh vangt dit voortaan.
# besluiten.js (wv3588): Besluitenpagina — App Besluiten (voorstellen uit de reviews, Ja/Nee/toelichting) en de kwartierronde naar de machinekamer
# promedico-agenda.js (wv3132): ontvanger van de Chrome-extensie Promedico-agenda (route /promedico-agenda/stand); ontbreekt hij, dan 404 op die route.
# agenda-narekenen.js (wv3704): Socev rekent een agendavoorstel na (route /agenda/narekenen); ontbreekt hij, dan 404 op die route.
# agenda-potlood.js (wv3741): potloodlaag in de Socev-kalender (dagtik 07:05-11:00); ontbreekt hij, dan geen tik en /health.agenda_potlood aan=false.
# promedico-betekenis.js + promedico-woorden.json (wv3143): Promedico-laag in Apps › Calendar (route /app/promedico/<van>/<tot>); ontbreekt de module, dan 404 en promedico_agenda.app.aan=false. Een .json gaat alleen mee als hij te parsen is.
# bank-archief.js (wv687): transactiedatabase, door bank-lezer.js geladen (ontbreekt hij, dan alleen de cache; leesopdrachten op het archief falen netjes).
# studio.js (wv707): tab Studio in de app, door server.js geladen (ontbreekt hij, dan 404 op /app/studio/* en studio.aan=false in /health).
# bandjes.js (wv743): mini-app Bandjes, door server.js geladen (ontbreekt hij, dan 404 op /app/bandjes* en bandjes.aan=false in /health).
# studio-beeld.py (wv2482): beeldcontrole van Studio (fotoveld), door studio.js aangeroepen (ontbreekt hij, dan weigert elke foto-flow met "de beeldcontrole start niet").
# studio-splat.js (wv3272): hulpstukken voor de Studio-motor splat (Foto's → 3D, gedeelde taakmap), door studio.js geladen (ontbreekt hij, dan staat de 3D-flow op kapot; de rest van Studio werkt).
# audio.js (wv743): telefoonversie van een bandje, door studio.js geladen als een flow erom vraagt (ontbreekt hij, dan alleen het origineel met een noot).
# harvester.js (wv820): App Harvester, door server.js geladen (ontbreekt hij, dan 404 op /app/harvester* en /harvester-ronde, harvester.aan=false in /health).
# spreektekst.js (wv803): spreektekst van een bandje (nummers, websites, pauzes), door bandjes.js geladen (zelfde commit; ontbreekt hij, dan laadt bandjes.js niet: 404 op /app/bandjes*).
# ecobank-mail.js (wv2202): Ecobank-laag (Gambia), door bank-lezer.js en server.js geladen als een Ecobank-opdracht hem vraagt (ontbreekt hij, dan faalt alleen die opdracht).
# paypal-bewijs.js (wv765): PayPal-laag, door bank-lezer.js en server.js geladen als een PayPal-opdracht hem vraagt (ontbreekt hij, dan faalt alleen die opdracht netjes).
# financien-app.js (wv771): App Financiën, door bank-lezer.js geladen bij de opdracht app-financien (ontbreekt hij, dan geeft de route 503).
# pot-afschrift.js + mt940-lezer.js (wv787): App POT-afschriften, door bank-lezer.js geladen bij pot-afschrift (ontbreken ze, dan 503 op /app/pot-afschriften en pot_afschrift.aan=false in /health).
# facturen-kern.js (wv797): kern van de Facturen-app (puur); nog door niets geladen, F1c/F2 koppelen hem (ontbreekt hij, dan geen Facturen).
# facturen-bank.js (wv798): bankparsers, matching en signalen van de Facturen-app (puur, laadt facturen-kern.js + mt940-lezer.js); F2 koppelt hem.
# facturen-validatie.js (wv944): factuurvalidatie op de bankhistorie (puur, laadt facturen-kern.js); facturen.js laadt hem (ontbreekt hij, dan geen Facturen).
# facturen-sepa.js (wv1405): het pain.001-bestand van de SEPA-batch (puur, laadt alleen crypto); facturen.js laadt hem (ontbreekt hij, dan geen Facturen).
# facturen-specificatie.js (wv2025): PDF en mailtekst van de specificatie per SEPA-batch voor de boekhouder (puur, alleen crypto); facturen.js laadt hem (ontbreekt hij, dan geen Facturen).
# pot-datahub.js (wv815): POT-posten naar Davids datahub, door server.js geladen in potDatahubRonde na de bank-ronde (ontbreekt hij, dan faalt alleen die stap: box-rij, de ronde loopt door).
# pot-verzend.js (wv911): nota's uit de POT-app als Gmail-concept, door server.js geladen in potVzTik (ontbreekt hij, dan pot_verzend.module=false in /health en blijven rijen wachten).
# pot-app.js (wv1894, wv1939): App POT, de leesroutes van werk.socev.dev/pot, door server.js geladen (ontbreekt hij, dan 404 op /app/pot/* en pot_app.aan=false in /health).
# facturen-db.js (wv824): opslag van de Facturen-app (SQLite /opt/data/facturen, migraties, triggers, stukken, back-up); server.js opent hem alleen
#   op de primaire kant voor /health.facturen (ontbreekt hij, dan facturen.aan=false; F2 koppelt de routes).
# facturen.js (wv833): routes /app/facturen/* en POST /facturen-ronde, door server.js geladen (ontbreekt hij, dan 404 op /app/facturen* en facturen.aan=false in /health).
# facturen-koerier.js (wv855): de koerier (verzend-detectie, consistentiecontrole, verzender, uploads, postvak), door server.js geladen bij POST
#   /facturen-ronde (ontbreekt hij, dan doet de ronde alleen de back-up en /health.facturen.koerier.aan=false).
# facturen-ingang.js (wv856): smalle ingang /fac/* voor de praktijkmanager (facturen.socev.dev); door server.js geladen, slapend (404) tot de inrichting (ontbreekt hij, dan 404 op /fac).
#   Met wv856 krijgt de facturendatabase migratie 3: een terugrol naar een release van vóór wv856 opent hem niet meer (schema_nieuwer) — dan ook
#   /opt/data/facturen/backup/ van vóór de uitrol terugzetten, of vooruit herstellen.
#   Met wv944 komt migratie 4 (bankhistorie, factuurarchief, startdatum): idem voor een terugrol naar een release van vóór wv944.
#   Met wv1299 komt migratie 5 (Triodos: bank/formaat-CHECKs verruimd via writable_schema): een release van vóór wv1299 opent hem dan niet meer;
#   lichtste terugrol: DELETE FROM schema_migratie WHERE versie = 5 (de verruimde CHECKs hinderen de oudere release niet).
# brein-schik.js (wv3750): de vaste landkaart van Brain, 's nachts uitgerekend (ontbreekt hij, dan schikt de app zelf zoals vroeger).
# brain-tekst.js (wv3734): tekst van pdf en docx voor Brain › Zoeken op inhoud (ontbreekt hij, dan zoekt Brain die stukken alleen op naam).
# vaultzoek.js + vaultzoek-index.py (wv3295): zoeken op betekenis in de eigen databank (smalActie vault-zoek, Brain op betekenis) en de nachtronde
#   die de index vult (ontbreken ze, dan 503 op vault-zoek, Brain op betekenis geeft "geen antwoord", vaultzoek.aan=false in /health).
# secondbrain.js (wv832): App Second Brain, routes /app/secondbrain* (ontbreekt hij, dan 404 en secondbrain.aan=false in /health).
# financien-vault.js (wv1337): App Financiën, tabbladen Hypotheek/Belasting/Holding uit de vault (ontbreekt hij, dan blijven die tabbladen leeg).
# financien-advies.js (wv2620): Financiën 8+ stap 4, adviesregels A1–A5 (door financien-app.js geladen; ontbreekt hij, dan blijft overzicht.advies leeg).
# financien-vooruit.js (wv2621): Financiën 8+ stap 5 en 6, Vooruit en Doelen (door financien-app.js en server.js lui geladen; ontbreekt hij, dan blijven overzicht.vooruit/doelen leeg en weigert POST /app/financien/doel met 503).
# stroom-tabel.js (wv2704): maandtabel op de energiepagina vanzelf bij uit de Tibber-factuur (server.js na de bankronde; ontbreekt hij, dan gebeurt er niets).
# nmbrs-data.js (wv2797): Nmbrs REST alleen lezen (server.js: /nmbrs/terug, /smal/nmbrs, dagronde na de bankronde; ontbreekt hij, dan 404 en geen ronde).
# homey.js (wv3460): Homey (Athom MCP) alleen lezen (server.js: /homey/terug, /smal/homey; ontbreekt hij, dan 404).
# tibber-uur.js (wv2707): Tibber-uurverbruik dagelijks bij (server.js na de bankronde; ontbreekt hij, dan gebeurt er niets).
# ah-bonnen.js (wv2703): AH-kassabonnen in Financiën (server.js lui geladen; ontbreekt hij, dan 404 op /app/financien/ah en geen ronde).
# financien-plan.js (wv2706): Financiën potjes, rekeningen afvinken en geldstroom (door financien-overzicht.js, financien-app.js en server.js lui geladen; ontbreekt hij, dan blijven uitgaven.potjes, geldstroom en vaste_lasten.deze_maand leeg en weigert POST /app/financien/potje met 503).
# financien-corrigeer.js (wv2717): Financiën zelf corrigeren (door bank-lezer.js app-corrigeer geladen; ontbreekt hij, dan weigeren /app/financien/corrigeer, /herstel, /naam en /regels met een nette fout).
# financien-vermogen.js (wv2716): Financiën vermogensverloop per maand (door bank-lezer.js app-vermogen geladen; ontbreekt hij, dan weigert POST /app/financien/vermogen met een nette fout).
# financien-reis.js (wv2715): Financiën kosten per reis (door bank-lezer.js app-reizen/app-reislabel geladen; ontbreekt hij, dan weigeren POST /app/financien/reizen en /reislabel met een nette fout).
# financien-teller.js (wv3925, lijst wv3958): Financiën-teller op de tegel (server.js lui geladen; ontbreekt hij, dan geeft de tellerroute 503 'nu niet te tellen').
# financien-bijsturen.js (wv2700): Financiën › Uitgaven "Zelf bij te sturen" (door financien-overzicht.js lui geladen; ontbreekt hij, dan blijft uitgaven.bijsturen leeg).
# financien-overzicht.js (wv2596): Financiën 8+ (stromen, kerngetallen, boekingen, stroom kiezen), door financien-app.js en bank-lezer.js geladen (ontbreekt hij, dan blijft het blok overzicht leeg en geven /app/financien/boekingen en /stroom 400).
# gezondheid-app.js (wv937): App Gezondheid, routes GET /app/gezondheid(/genoom) (ontbreekt hij, dan 404 en gezondheid.aan=false in /health).
# ideeen.js (wv761): App Ideeën van buitenaf (Ideeënbeurs), door server.js geladen (ontbreekt hij, dan 404 op /app/ideeen* en ideeen.aan=false in /health).
# ideeen-filter.js (wv861): de vaste toets van de Ideeënbeurs, door ideeen.js geladen (ontbreekt hij, dan geen catalogus, geen Deel en geen plaatsen: ideeen.catalogus=false).
# zoek-snel.js (wv1252): Zoek snel achter het OVIS-logo, route /app/zoek-snel (ontbreekt hij, dan 404 en zoek_snel.aan=false in /health).
# zoek-snel-leer.js (wv3743): Zoek snel leert van wat David kopieert, route /app/zoek-snel/gekozen + weekkaart (ontbreekt hij, dan 404 en geen laag 0).
# zoek-snel-uitzoek.js (wv3821): "Zoek het uit" bij een misser, route /app/zoek-snel/uitzoeken + stille zoektocht + kaart (ontbreekt hij, dan 404).
# zoek-overal.js (wv3742): Zoek snel in al Davids bronnen, route /app/zoek-snel/overal (ontbreekt hij, dan 404 en de app toont geen bronkaartjes).
# vault-veilig.js (wv900): lezen/schrijven/aanvullen in de vault zonder een symlink te volgen; server.js laadt hem lui, bandjes.js, ideeen.js en harvester.js
#   bij het laden (ontbreekt hij, dan schrijft server.js geen box-rij meer (logError) en laden die drie niet: 404 op hun routes).
# aix.js (wv942): de pod-kant van AIX (ondertekenen, lezen, goedkeuringsronde), door server.js geladen (ontbreekt hij, dan aix.aan=false en geen uurronde).
# app-vast.js (wv1051, OVIS M1b): vastzetten in het menu, GET/POST /app/vast (ontbreekt hij, dan 404 en toont de app de standaard).
# app-open.js (wv1712, OVIS M6-pod): [OPEN …]-regel uit de uitvoer en het open-veld (ontbreekt hij, dan blijft de tekst zoals hij was en geen veld).
# intake-ingang.js (wv1282): aanleverweg OVIS Intake /intake/*, door server.js geladen (ontbreekt hij, dan 404 op /intake/* en intake.aan=false in /health).
#   Met de map intake/ (RELEASE_MAPPEN): de profielen (intake/profielen/*.json) en de marker (intake/patientpoort.js).
# herstelreferentie.js (wv1962): nachtketen-stap sb2-herstelreferentie (SB2 fase 6a; droge reconcile op de facturendump uit de podstaat-bundel), door server.js geladen (ontbreekt hij, dan doet die stap niets: al_gedaan, niet_in_release).
# uitwijk-cred.js (wv2041): nachtketen-stap uitwijk-cred (versleutelde n8n-credentials via olares-eigen n8n-cred-export en ssh-stdin naar de R230), door server.js geladen (ontbreekt hij: al_gedaan, niet_in_release).
# uitwijk-sleutelkopie.js (wv3893, lijst wv3958): nachtketen-stap uitwijk-sleutelkopie (03:15, versleutelde uitwijksleutels van de R230 naar Drive + DS920), door server.js geladen (ontbreekt hij: al_gedaan, niet_in_release; gemeten 23-11).
# intake-verwijder.js (wv1964, SB2 fase 6d): verwijderroute + tombstones, opdrachtregel voor de machinekamer (node intake-verwijder.js plan|voer-uit|lijst);
#   niet door server.js geladen (ontbreekt hij, dan is er geen verwijderroute; de poort bij binnenkomst zit in intake-ingang.js).
# intake-voorstel.js (wv1945): voorstelservice met citaatcontrole + sweep Tolgaarde (SB2 fase 3c), door server.js geladen (ontbreekt hij, dan doet de nachtketen-stap intake-voorstel niets en /health.intake.voorstel.module=false).
# sb2-berichten.js (wv2383): berichtverbindingen (SB2 fase 6 § 6.2, mention + target_org_id), door server.js geladen (ontbreekt hij, dan doet de nachtketen-stap sb2-berichten niets).
# intake-publicatie.js (wv1869): publicatieservice van OVIS Intake (bronnotities + register via outbox_publication), door server.js geladen (ontbreekt hij, dan doet de nachtketen-stap intake-publicatie niets en /health.intake.publicatie.module=false).
# geheimen.js (wv3405, A32): de gedeelde geheimenlijst; secondbrain.js, zoek-snel.js, docs-delen.js en openai-hulp.js laden hem.
# lees-of-weiger.js (wv3423, B80): 'niet kunnen lezen is nooit leeg'; ovis-register.js, secondbrain.js en zoek-snel.js laden hem (ontbreekt hij, dan laden die drie niet).
# docs-delen.js (wv1382): OVIS Docs › Delen, routes /app/docs/* (ontbreekt hij, dan 404 en docs_delen.aan=false in /health; secondbrain.js nodig).
# scansnap.js (wv1343): ScanSnap-scans uit Google Drive → OVIS Intake + Voor jou-kaart, door server.js geladen (ontbreekt hij, dan geen tik, geen
#   knop-haak en scansnap.module=false in /health).
# herinneringen-verhaal.js (wv2118): MemoryLane R2 — verhaal uit een opname (Claude zonder tools), citaattoets, Verhalen/, voorstellen, register.
# herinneringen.js (wv1969): MemoryLane R1 — opnames in stukken via /app/ramble, audio-archief, uitschrijven, Intake ramble@1, opnamenotitie,
#   audio-offsite; door server.js geladen (ontbreekt hij, dan 404 op /app/ramble/*, geen tik en ramble.module=false in /health).
# memorylane-delen.js (wv2114): MemoryLane delen (reizen, eigen tekst, deellinks familie/vrienden via deel.socev.dev/h/); door server.js geladen
#   (ontbreekt hij, dan 404 op /app/memorylane/*, geen tik en memorylane_delen.module=false in /health; herinneringen.js nodig).
# kalender-app.js (wv2333): OVIS Calendar in de app (/app/kalender, leest public.sb_kalender_tijdlijn); ontbreekt hij, dan 404 en
#   kalender.aan=false in /health, de rest draait door.
# memorylane-publiek.js (wv2636): MemoryLane op memorylane.socev.dev (familie/Shizzle): kringen naar D1 `memorylane` + R2 `memorylane`; door server.js geladen
# reizen.js (wv2136): de reispagina's (20_Prive/Reizen) voor OVIS Tripper (/app/tripper/*) én MemoryLane (reisInfo); memorylane-delen.js
#   heeft hem nodig (ontbreekt hij, dan 404 op /app/tripper/*, tripper.aan=false en geen MemoryLane delen).
# immich.js + memorylane-fotos.js (wv2120): MemoryLane × Immich — albums per herinnering, foto's via de pod, foto's bij de deellinks; ontbreken
#   ze, dan MemoryLane zonder foto's (memorylane_delen.immich null in /health, /app/memorylane/*/fotos 404).
# memorylane-video.js (wv2938): MemoryLane-video's afspelen (kleine versie per video met ffmpeg uit /opt/data/tools, ook voor memorylane.socev.dev);
#   ontbreekt hij, dan geen afspelen (/app/memorylane/v/* 404, memorylane_delen.video null in /health) en blijven video's buiten.
# memorylane-plaatje.js (wv2325): MemoryLane Plaatje maken (gegenereerde gevel voor een huis zonder foto, via openai-hulp beeld); ontbreekt hij,
#   dan geen knop (plaatje_kan false, /app/memorylane/h/*/plaatje 409) en memorylane_delen.plaatjes null in /health.
# memorylane-verteller.js (wv2366): MemoryLane-verteller in Davids eigen stem (ElevenLabs via de Router, eigen plafond € 5/maand); ontbreekt hij,
# elevenlabs-credits.js (wv2751): credit-teller ElevenLabs; stond niet in deze lijst, dus ontbrak in de release (elevenlabs.aan=false, gevonden wv2755).
#   dan geen verteller in eigen stem (detail.verteller null, /app/memorylane/h/*/verteller 404) en memorylane_delen.verteller null in /health.
# memorylane-vertelscript.js (wv2484): MemoryLane "Als verhaal vertellen" (vertelscript met ElevenLabs-audio-tags via Claude); ontbreekt hij,
#   dan alleen voorlezen (detail.verteller_verhaal null, /app/memorylane/h/*/verteller-verhaal 404) en memorylane_delen.vertelscript null.
# huisstijl-pod.js (wv1373): Socev-blauw + OVIS-favicon voor Sleutelportaal en bankpagina (gemaakt met tools/huisstijl-pod.py; ontbreekt hij,
#   dan de kale pagina zonder huisstijl of favicon).
# omzet.js (wv1854): Download als… (PDF/Word/Excel), routes GET/POST /app/omzet (ontbreekt hij, dan 404 en omzet.aan=false in /health; docs-delen.js
#   nodig). omzet-huisstijl.js (gemaakt met tools/omzet-huisstijl.py) = briefhoofd/voet en reference-docx per entiteit (ontbreekt hij, dan geen
#   huisstijlen); xlsx-schrijver.js = de Excel-schrijver (ontbreekt hij, dan laadt omzet.js niet).
# facturen-creditcard.js (wv2043): creditcard (ICS) als bron; facturen.js laadt hem met try (ontbreekt hij, dan alleen geen opdracht creditcard).
# facturen-paypal.js + paypal-zakelijk-lezer.js (wv2056): PayPal zakelijk als bron; facturen.js en server.js laden ze met try (ontbreken ze, dan geen opdracht paypal en geen PayPal-ronde).
# facturen-maandspec.js (wv2060): maandspecificatie PayPal en creditcard voor de boekhouder (puur); facturen.js laadt hem met try (ontbreekt hij, dan geen maandspecificatie).
# facturen-boekstuk.js (wv2316): boekstuk Google Home naar de boekhouder (puur); server.js laadt hem met try (ontbreekt hij, dan geen boekstuk-ronde).
# fin-toewijzing.js + fin-reconcile.js (wv1864, SB2 fase 4a): aansluiting bank ↔ inkoopfacturen (dekking per dag, statussen); server.js laadt
#   fin-reconcile.js lui bij /smal/facturen opdracht aansluiting (ontbreekt hij, dan 404 op alleen dat commando). Rekenproduct in /opt/data/fin-reken
#   (reken.sqlite + snapshot/); terugrol = die map weg, de Facturen-databank merkt niets.
# codex-mk.js (wv2081): Terra-nacontrolebundel (Codex als meter in een eigen CODEX_HOME); server.js laadt hem met try (ontbreekt hij, dan
#   geen Terra-bundel: /agent weigert die met 400 en de tikker zet de leden na het afsluiten terug naar de Sonnet-bundel).
# shopper.js (wv2264): OVIS Shopper, de zoektochtpagina's per entiteit voor /app/shopper*; heeft reizen.js nodig (ontbreekt een van beide,
#   dan 404 op /app/shopper* en shopper.aan=false).
# jev-pod.js (wv2427): het Jev-blok (pod-terugval intakeJevPod van OVIS Intake) + de CLI voor de hook web-jev en naar-markdown; server.js laadt
#   hem lui (ontbreekt hij, dan geen pod-terugval: intakeJev geeft alleen de webhook-uitslag, de router probeert later opnieuw).
# pakjes.js (wv2593): OVIS Pakjes, bezorgmail meelezen + openbare volgpagina's (DHL, PostNL, GLS) voor /app/pakjes*; ontbreekt hij, dan 404 en pakjes.aan=false.
# gambia-steunbord.js (wv3949): steunbord Gambia, door bank-lezer.js geladen; stond niet in deze lijst, dus ontbrak live (bank.py gambia-steunbord
#   "Cannot find module", gevonden wv3950 25-11). gambia-mensen.js (wv3950): Apps › Gambia, /app/gambia; ontbreekt hij, dan 404.
# facturen-bonjacht-ronde.js (wv3973): facturen-koerier.js laadt hem bovenaan; ontbrak live, dus de hele koerier uit (health facturen.koerier.aan
#   false sinds de release van wv3973; gevonden wv3950 25-11).
# ghawa.js (wv2877): OVIS GHAWA fase 1, eigen databank /opt/data/ghawa/ghawa.sqlite + rekenkern voor /app/ghawa*; ontbreekt hij, dan 404 en ghawa.aan=false.
# ghawa-bij.js (wv2880): OVIS GHAWA fase 2 (bijhouden: GHAWA-bank uit Facturen, ECG-afschriften, fondsen, maandronde); ghawa.js laadt hem.
# imagine.js (wv2984): OVIS Imagine fase 1, bibliotheek /opt/data/imagine (imagine.sqlite + beelden/) en incognito in het geheugen, bovenop studio.js; ontbreekt hij, dan 404 en imagine.aan=false.
# personeelsscherm.js (wv2991): OVIS Personeelsscherm fase 0 (proefscherm tekenen naar D1 personeel, koppelen/intrekken van het kastje-token, hartslag); ontbreekt hij, dan 404 op /app/personeelsscherm* en personeelsscherm.aan=false.
# beleggen-nieuws.js (wv2993): OVIS Beleggen fase 2, weekbericht met nieuws (ophalen 06:40, zondag 09:00 weekronde); ontbreekt hij, dan geen weekbericht (beleggen.weekbericht ontbreekt in /health).
# beleggen-mail.js (wv3758): OVIS Beleggen zonder huiswerk, aankopen uit de DEGIRO-mail + ochtendvraag; ontbreekt hij, dan geen mailronde (beleggen.mail ontbreekt in /health).
# beleggen.js (wv2982): OVIS Beleggen fase 1, eigen databank /opt/data/beleggen/beleggen.sqlite + bestandslezer en rekenwerk voor /app/beleggen*; ontbreekt hij, dan 404 en beleggen.aan=false.
# strateeg.js + strateeg-reken.js + strateeg-bron.js + strateeg-kind.js + strateeg-universum.json + strateeg-regels.json (wv3993): OVIS Beleggen › Strateeg, een maand droog oefenen met fictief geld (eigen databank /opt/data/strateeg/strateeg.sqlite); ontbreekt hij, dan 404 op /app/beleggen/strateeg* en strateeg.aan=false.
# strateeg-segment.js + strateeg-segment-reken.js + strateeg-segment.json (wv4002): vijfde boek Segment van de Strateeg (fictief, drie van tien sector-ETF's, zelfde databank, eigen seg_-tabellen); ontbreekt hij, dan segment: null in /app/beleggen/strateeg en strateeg.segment.aan=false.
# strateeg-ideeen.js + strateeg-ideeen-reken.js + strateeg-ideeen.json (wv4012): zesde boek Ideeën van de Strateeg (fictief, stellingen uit nieuws en Davids ideeën, zelfde databank, eigen idee_-tabellen); ontbreekt hij, dan ideeen: null in /app/beleggen/strateeg en strateeg.ideeen.aan=false.
# ghawa-stichting.js (wv2886): OVIS GHAWA fase 4 (Stichting: doelen, statuten en ANBI, overleg, mensen); ghawa.js laadt hem.
# ghawa-voorstel.js (wv3920): OVIS GHAWA Voorstellen uit WhatsApp; ghawa.js laadt hem (ontbreekt hij, dan valt Apps › GHAWA om: altijd meesturen).
# ghawa-site.js (wv2883): OVIS GHAWA fase 3 (website: concept op de proefsite, publiceren met vingerafdruk); ontbreekt hij, dan 404 op /app/ghawa/website.
# pot-maand.js (wv2762): OVIS POT maandronde (nota's op de 1e, één concept per praktijk, Exact, herinneringen); heeft de map ovis-pot/ (bundel
#   uit Socev/ovis-pot: api.mjs, kern/*.mjs, bron.json) nodig. Ontbreekt een van beide, dan pot_maand.aan=false of een box-rij; niets anders raakt het.
# osint.py (wv2694): OVIS OSINT, bronnenlaag + poort + osint.sqlite voor /app/osint* en /smal/osint (draait met /opt/data/venvs/osint, anders
#   python3); ontbreekt hij, dan 404 en osint.aan=false. Heeft intake/patientpoort.js nodig (ontbreekt die, dan poort dicht: alleen offline).
# deadline-lijstje.js (wv3707, 3C71): deadlines in het actielijstje (POST /voorwerk/deadlines + register bijwerken na een tik); ontbreekt
#   hij, dan 503 op die route en Kies portie gaat verder zonder deadlines.
# herinnering-kaart.js (wv3905, 3C56): herinnering als Voor jou-kaart (POST /herinnering/kaart + tik terug in het register); ontbreekt
#   hij, dan 503 op die route en de heartbeat stuurt de herinnering als gewone tekst. Heeft deadline-lijstje.js nodig.
RELEASE_MAPPEN="intake ovis-pot"
RELEASE_OPTIONEEL="geheimen.js vj-moment.js lees-of-weiger.js homey.js nmbrs-data.js nmbrs-betaal.js nmbrs-laad.js ah-bonnen.js intake-ingang.js intake-verwijder.js intake-router.js keten-match.js mailman.js vault-veilig.js bank-lezer.js bunq-lezer.js bewaker.js bank-archief.js studio.js bandjes.js audio.js studio-beeld.py studio-splat.js spreektekst.js paypal-bewijs.js financien-app.js pot-afschrift.js mt940-lezer.js facturen-kern.js facturen-bank.js pot-datahub.js pot-verzend.js pot-app.js harvester.js facturen-db.js facturen.js facturen-koerier.js facturen-ingang.js facturen-validatie.js facturen-sepa.js facturen-specificatie.js secondbrain.js ideeen.js ideeen-filter.js aix.js managers.js managers-poort.js mk-tekst.js ringkaart.js mediatheek.js gezondheid-app.js ovis-register.js ovis-run.js ovis-plekken.js app-vast.js app-open.js intake-telling.js zoek-snel.js onderhoud.js datums.js scansnap.js sb2-nacht.js nachtketen.js docs-delen.js financien-vault.js financien-overzicht.js financien-advies.js financien-vooruit.js financien-bijsturen.js financien-plan.js financien-reis.js financien-corrigeer.js financien-vermogen.js stroom-tabel.js tibber-uur.js pdf-lezer.js facturen-kaart.js werkers.js brain-entiteiten.js entiteit-nu.js bank-partij.js huisstijl-pod.js tokenteller.js omzet.js omzet-huisstijl.js xlsx-schrijver.js fin-toewijzing.js fin-reconcile.js intake-publicatie.js intake-voorstel.js herstelreferentie.js uitwijk-cred.js werkstroom.js herinneringen.js herinneringen-verhaal.js memorylane-delen.js memorylane-publiek.js reizen.js kalender-app.js immich.js memorylane-fotos.js memorylane-plaatje.js memorylane-verteller.js elevenlabs-credits.js memorylane-vertelscript.js facturen-creditcard.js openai-hulp.js facturen-paypal.js paypal-zakelijk-lezer.js facturen-maandspec.js facturen-boekstuk.js facturen-bonjacht.js codex-mk.js docplan-totaal.js docplan-koppel.js docplan-rekeningen.js docplan-controle.js docplan-jaaropgaaf.js docplan-bezetting.js nieuwsbrief.js ecobank-mail.js mailvoorwerk.js voorwerk-poort.js voorwerk-lees.js te-lezen.js shopper.js shopper-vergelijk.js shopper-winkels.js winkel-browser.js winkel-score.py prijshistorie.py shopper-proactief.py winkel-lezen.py sb2-berichten.js jev-pod.js weer-ochtend.js pakjes.js brain-web.js brain-web-io.js osint.py pot-maand.js ghawa.js ghawa-bij.js ghawa-site.js ghawa-stichting.js ghawa-voorstel.js ghawa-deel.js contactringen.js box-archief.js memorylane-video.js beleggen.js pma.js imagine.js personeelsscherm.js beleggen-nieuws.js beleggen-mail.js strateeg.js strateeg-reken.js strateeg-bron.js strateeg-kind.js strateeg-universum.json strateeg-regels.json strateeg-segment.js strateeg-segment-reken.js strateeg-segment.json strateeg-ideeen.js strateeg-ideeen-reken.js strateeg-ideeen.json mail-app.js mail-sluit.js vastgoed.js woning-bron.js nza-scherm.js nza-vragen.js nza-dubbelcheck.js tarieven-wachter.js schijfdruk.js meld.js db-reserve-wacht.js promedico-agenda.js promedico-betekenis.js promedico-woorden.json promedico-botsingen.js weekinhaal.js hartslag-alarm.js storingsdienst.js code-apps.js ovis-code.js ophalen.js tabula-loket.js vaultzoek.js vaultzoek-index.py besluiten.js agents-af.js heartbeat-moment.js brain-tekst.js agenda-narekenen.js briefing-punten.js bandjes-kaart.js pot-antwoord.js sms-tik.js sms-ingang.js zoek-overal.js agenda-potlood.js app-nieuws.js raad.js zoek-snel-leer.js beurt-stappen.js zoek-snel-uitzoek.js beurt-stroom.js brein-schik.js financien-teller.js uitwijk-sleutelkopie.js warme-staat.js map-ingang.js vault-versies.js deadline-lijstje.js herinnering-kaart.js dagplan-app.js gambia-steunbord.js gambia-mensen.js facturen-bonjacht-ronde.js"

log(){ printf '%s uitrol: %s\n' "$(date '+%F %T')" "$1" | tee -a "$LOG"; }
fout(){ log "FOUT: $1"; exit 1; }

REF="${1:-}"
[ -n "$REF" ] || fout "geen git-sha of branch meegegeven"

command -v git >/dev/null 2>&1 || fout "git ontbreekt"
[ -d "$BRON_REPO/.git" ] || fout "geen git-repo op $BRON_REPO"

mkdir -p "$RELEASES" "$(dirname "$LOG")"

# ── 1. ophalen ──────────────────────────────────────────────────────────────
log "ophalen uit $BRON_REPO"
git -C "$BRON_REPO" fetch --quiet origin || fout "git fetch mislukt"

# Review-fix 5-9-2026 (vondst machinekamer): een branchnaam eerst op ORIGIN oplossen.
# De lokale branch 'main' van de kloon wordt door niets bijgewerkt; wie 'main' vroeg
# kreeg wat de kloon toevallig had, met 'release staat er al' als geruststelling -
# oude code, groen log. Een sha of tag blijft gewoon werken (tweede poging).
SHA="$(git -C "$BRON_REPO" rev-parse --verify --quiet "origin/${REF}^{commit}" \
       || git -C "$BRON_REPO" rev-parse --verify --quiet "${REF}^{commit}")" \
  || fout "kan $REF niet oplossen naar een commit"
KORT="${SHA:0:12}"
DOEL="$RELEASES/$KORT"

# ── 1a. bestandslijst ook uit de commit zelf (wv3464, 20-11-2026) ─────────────────────────────────────────────────────────
# Dit script draait uit de werkboom (vaak $BRON_REPO/uitrol.sh), de inhoud komt uit $SHA. Stond de werkboom achter op origin/main,
# dan kende dit script een nieuw bestand nog niet en ging het stil niet mee: homey.js in ec273d1/53c5738 (19-11, /homey/terug 404),
# gemeten 22 van 474 releases sinds 19-8 (financien-*, ghawa-bij, voorwerk-*, beleggen-nieuws, nmbrs-betaal, lees-of-weiger ...).
# Daarom de lijsten van de commit erbij (vereniging): een naam die niet in de commit staat, slaat stap 2 toch over, dus een terugrol
# naar een oudere commit verandert niets. Namen uit de commit alleen als platte bestands-/mapnaam (geen /, geen ..).
commit_lijst(){ git -C "$BRON_REPO" show "$SHA:uitrol.sh" 2>/dev/null | sed -n "s/^$1=\"\\([^\"]*\\)\"\$/\\1/p" | tail -1; }
lijst_erbij(){ local naam="$1" eigen="$2" n uit="" extra=""
  for n in $(commit_lijst "$naam"); do
    case " $eigen " in (*" $n "*) continue ;; esac
    case "$n" in ([A-Za-z0-9]*) ;; (*) log "LET OP: $naam van $KORT noemt '$n' - overgeslagen" >&2; continue ;; esac
    case "$n" in (*[!A-Za-z0-9._-]*|*..*) log "LET OP: $naam van $KORT noemt '$n' - overgeslagen" >&2; continue ;; esac
    extra="$extra $n"
  done
  [ -n "$extra" ] && log "lijst uit commit $KORT: $naam +${extra# } (de werkboom-uitrol.sh kende ze niet)" >&2
  printf '%s' "$eigen$extra"; }
RELEASE_BESTANDEN="$(lijst_erbij RELEASE_BESTANDEN "$RELEASE_BESTANDEN")"
RELEASE_OPTIONEEL="$(lijst_erbij RELEASE_OPTIONEEL "$RELEASE_OPTIONEEL")"
RELEASE_MAPPEN="$(lijst_erbij RELEASE_MAPPEN "$RELEASE_MAPPEN")"
# (log gaat via tee ook naar stdout: binnen $(...) dus naar stderr, anders komt de logregel in de lijst.)
# Welke bestanden uit de lijsten staan in de commit maar niet in map $1? (stap 2 en de nacontrole; wv3464 vangnet)
ontbrekend(){ local b f m
  for b in $RELEASE_BESTANDEN $RELEASE_OPTIONEEL; do
    git -C "$BRON_REPO" cat-file -e "$SHA:$b" 2>/dev/null && [ ! -f "$1/$b" ] && printf '%s ' "$b"; done
  for m in $RELEASE_MAPPEN; do
    for f in $(git -C "$BRON_REPO" ls-tree -r --name-only "$SHA" -- "$m/" 2>/dev/null); do
      case "$f" in (*.js|*.mjs|*.json) [ -f "$1/$f" ] || printf '%s ' "$f" ;; esac; done; done; return 0; }
# Een release die er al staat maar iets mist (gebouwd door een achterlopend script), wordt opnieuw gebouwd, behalve als hij draait.
ONVOLLEDIG=""
if [ -f "$DOEL/server.js" ]; then
  ONVOLLEDIG="$(ontbrekend "$DOEL")"
  if [ -n "$ONVOLLEDIG" ]; then
    if [ "$(readlink "$CURRENT" 2>/dev/null)" = "releases/$KORT" ]; then log "LET OP: draaiende release $KORT mist ${ONVOLLEDIG% } - niet aangeraakt (zie de nacontrole)"
    else log "release $KORT stond er al maar mist ${ONVOLLEDIG% } - opnieuw bouwen"; fi
  fi
fi
DRAAIT_ONVOLLEDIG=""; [ -n "$ONVOLLEDIG" ] && [ "$(readlink "$CURRENT" 2>/dev/null)" = "releases/$KORT" ] && DRAAIT_ONVOLLEDIG="$ONVOLLEDIG"

# ── 1b. datakaart-poort (wv844, Data Manager; Fable-review wv844 #1) ────────────────────────────────────────────────────
# Nieuwe opslag bestaat pas met een regel in 00_Systeem/datakaart.json. Een .sqlite/.jsonl-basisnaam in de release-bestanden
# van deze commit (.sqlite, .sqlite3, .jsonl; bewust geen .db: dat matcht ook JS als `this.db`) die NIET in de draaiende release staat en ook in geen `pod_bestanden` van de Datakaart, stopt de uitrol.
# Alleen namen die nieuw zijn t.o.v. current: zo blokkeert een terugrol of een herhaalde uitrol nooit. Grens: een naam zonder
# vaste vorm (`${x}.jsonl`) glipt erdoor; de weekronde van de Data Manager vangt de rest. Nood: UITROL_DATAKAART=0.
DATAKAART="${UITROL_DATAKAART_PAD:-/opt/data/AI_SecondBrain/00_Systeem/datakaart.json}"
if [ "${UITROL_DATAKAART:-1}" = "0" ]; then
  log "datakaart-poort UIT (UITROL_DATAKAART=0)"
elif [ -f "$DOEL/server.js" ] && [ -z "$ONVOLLEDIG" ]; then
  log "datakaart-poort: release $KORT stond er al (terugrol of herhaling) - niet getoetst"
elif [ ! -f "$DATAKAART" ]; then
  log "datakaart-poort: $DATAKAART ontbreekt (uitwijkkant?) - niet getoetst"
elif [ ! -f "$CURRENT/server.js" ]; then
  log "datakaart-poort: geen draaiende release (vers volume of herstel) - niet getoetst"
else
  ONBEKEND="$(for b in $RELEASE_BESTANDEN $RELEASE_OPTIONEEL; do git -C "$BRON_REPO" show "$SHA:$b" 2>/dev/null; echo; done \
    | python3 -c 'import glob,json,re,sys
R=re.compile(r"(?<![A-Za-z0-9_.-])(\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:sqlite3?|jsonl))(?![A-Za-z0-9_])")
nieuw=set(R.findall(sys.stdin.read()))
nu=set()
for f in glob.glob(sys.argv[2]+"/*.js"): nu|=set(R.findall(open(f,errors="ignore").read()))
kaart=set(b for p in json.load(open(sys.argv[1])).get("plekken",[]) for b in p.get("pod_bestanden") or [])
print(" ".join(sorted(nieuw-nu-kaart)))' "$DATAKAART" "$CURRENT")" || fout "datakaart-poort: datakaart.json onleesbaar (of de poort faalde); herstel de JSON of zet UITROL_DATAKAART=0"
  [ -z "$ONBEKEND" ] || fout "datakaart-poort: nieuw opslagpad zonder regel in datakaart.json: $ONBEKEND - geef de plek eerst een regel (pod_bestanden), of in nood UITROL_DATAKAART=0"
  log "datakaart-poort: groen"
fi
if [ "${UITROL_POORT_ALLEEN:-0}" = "1" ]; then log "poort-alleen: gestopt na de datakaart-poort"; exit 0; fi

# ── 2. release neerzetten ───────────────────────────────────────────────────
# Eerst in een tijdelijke map bouwen en daarna hernoemen: een half uitgepakte
# release mag nooit onder een naam staan waar `current` naar kan gaan wijzen.
if [ -f "$DOEL/server.js" ] && { [ -z "$ONVOLLEDIG" ] || [ -n "$DRAAIT_ONVOLLEDIG" ]; }; then
  log "release $KORT staat er al - opnieuw gebruiken"
else
  TMP="$DOEL.bezig.$$"
  rm -rf "$TMP"; mkdir -p "$TMP"
  for b in $RELEASE_BESTANDEN; do
    git -C "$BRON_REPO" show "$SHA:$b" > "$TMP/$b" 2>/dev/null || fout "$b ontbreekt in commit $KORT"
  done
  for b in $RELEASE_OPTIONEEL; do
    if git -C "$BRON_REPO" cat-file -e "$SHA:$b" 2>/dev/null; then
      git -C "$BRON_REPO" show "$SHA:$b" > "$TMP/$b" || fout "$b niet te lezen uit commit $KORT"
      case "$b" in   # wv2273: een .py-bestand (shopper-proactief.py) krijgt de Python-syntaxcontrole
        (*.py) python3 -I -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$TMP/$b" || fout "$b van $KORT komt de syntaxcontrole niet door" ;;
        (*.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TMP/$b" || fout "$b van $KORT is geen geldige JSON" ;;   # wv3143
        (*) node --check "$TMP/$b" || fout "$b van $KORT komt de syntaxcontrole niet door" ;;
      esac
    fi
  done
  # Mappen (wv1282): elk .js- of .json-bestand onder de map gaat mee met zijn relatieve pad (js: syntaxcontrole, json: moet te lezen zijn).
  # Optioneel zoals hierboven: een commit zonder de map blijft uitrolbaar. Geen pijp naar while: fout moet het script zelf stoppen.
  for m in $RELEASE_MAPPEN; do
    for f in $(git -C "$BRON_REPO" ls-tree -r --name-only "$SHA" -- "$m/" 2>/dev/null); do
      case "$f" in (*.js|*.mjs|*.json) ;; (*) continue ;; esac   # wv2762: .mjs voor de bundel ovis-pot (kern, stukken, api)
      case "$f" in (*..*|/*|*[!A-Za-z0-9@._/-]*) fout "onverwachte bestandsnaam in $m/: $f" ;; esac
      mkdir -p "$TMP/$(dirname "$f")"
      git -C "$BRON_REPO" show "$SHA:$f" > "$TMP/$f" || fout "$f niet te lezen uit commit $KORT"
      case "$f" in
        (*.js|*.mjs) node --check "$TMP/$f" || fout "$f van $KORT komt de syntaxcontrole niet door" ;;
        (*.json) node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$TMP/$f" || fout "$f van $KORT is geen geldige JSON" ;;
      esac
    done
  done
  [ -s "$TMP/server.js" ] || fout "server.js is leeg in commit $KORT"
  node --check "$TMP/server.js" || fout "server.js van $KORT komt de syntaxcontrole niet door"
  MIST="$(ontbrekend "$TMP")"; [ -z "$MIST" ] || fout "release $KORT mist na het bouwen ${MIST% } - niet klaargezet"
  if [ -d "$DOEL" ]; then   # wv3464: onvolledige oude bouw vervangen (niet de draaiende, zie 1a); kort gat in de naam, nooit half
    mv -T "$DOEL" "$DOEL.onvolledig.$$" || fout "kon de onvolledige release $KORT niet opzij zetten"
    mv -T "$TMP" "$DOEL" || fout "kon de nieuwe bouw van $KORT niet neerzetten (de oude staat in $DOEL.onvolledig.$$)"
    rm -rf "$DOEL.onvolledig.$$"
    log "release $KORT opnieuw klaargezet (was onvolledig)"
  else
    mv "$TMP" "$DOEL"
    log "release $KORT klaargezet"
  fi
fi

# ── 2b. wachten tot het rustig is (28-9-2026, akkoord David) ─────────────────
# Een herstart doodt elke lopende beurt en elk resultaat dat n8n nog niet ophaalde: het antwoord
# verdwijnt dan stil (27-9 22:42). Wacht daarom tot /health lopend.beurten, lopend.onopgehaald
# en agents.lopend alle drie 0 zijn (wv2016: plus sb2_herstelproef.lopend, de maandklok van de herstelproef; ± 4 min, plafond 30)
# (wv1868: plus nachtketen.lopend, 1 alleen zolang een nachtstap echt draait; de keten
# start zelf niets zolang deze marker staat). Hooguit UITROL_WACHT_MAX seconden (standaard 1800), daarna
# toch - met een logregel. UITROL_NU=1 slaat het wachten over (noodgeval).
# wv2667 (7-11-2026): van de agents telt alleen agents.kwetsbaar, en van de beurten alleen lopend.gesprekken (beurten telt de
# agentjobs ook mee) (wie een herstart echt raakt: pending, jong < 2 min, in zijn
# eindcontrole, rapport in herkansing, runtime zonder weesafhandeling, auto-wachtrij). Een gewone lopende agent leeft de herstart
# door als wees (wv211/wv216) en levert zijn rapport daarna af; op lopend wachten liet de werkvoorraad bij elke uitrol leeglopen.
# Kent de draaiende pod het veld niet (oudere release), of UITROL_AGENTS=alle (bv. bij een wijziging aan de weesafhandeling
# zelf), dan telt agents.lopend zoals vroeger.
#
# Uitrolmarker (7-10-2026, wv91, akkoord David): zolang dit script op stilte wacht, staat MARKER er. De
# werkvoorraad-tikker en POST /agent met een machinekamer:-label starten dan niets nieuws - anders raakt het
# wachten nooit leeg en drukt het na WACHT_MAX door over een lopende agent heen (7-10 19:26, wv79 afgebroken).
# Agents voor David starten gewoon. Elke wachtronde ververst de mtime; de pod negeert een marker die 5 min niet
# ververst is of waarvan het proces weg is (kill -9, containerherstart). De trap wist hem alleen als hij nog van
# DIT proces is: een tweede uitrol die hem intussen overnam, blijft beschermd (Fable-review wv91 #4, #5).
# De wikkels in /opt/data/mk-scripts (uitrol-na-agents.sh, uitrol-als-auto-stil.sh) zetten dezelfde marker met
# hun eigen pid en exec'en dit script: zelfde pid, dus de marker loopt naadloos door.
MARKER="${UITROL_MARKER:-/opt/data/uitrol-wacht}"
marker_zet(){ printf '{"sha":"%s","start_iso":"%s","pid":%s}\n' "$KORT" "${MARKER_START:=$(date -Iseconds)}" "$$" > "$MARKER.nieuw.$$" \
  && mv -f "$MARKER.nieuw.$$" "$MARKER"; }
marker_weg(){ rm -f "$MARKER.nieuw.$$"; grep -q "\"pid\":$$}" "$MARKER" 2>/dev/null && rm -f "$MARKER"; return 0; }
if [ "${UITROL_NU:-0}" != "1" ]; then
  marker_zet || log "LET OP: kon de uitrolmarker $MARKER niet zetten"
  trap marker_weg EXIT
  trap 'exit 130' INT TERM HUP
  WACHT_MAX="${UITROL_WACHT_MAX:-1800}"; GEWACHT=0; TOCH=0
  while :; do
    DRUK="$(curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys,os
try:
  j=json.load(sys.stdin); l=j.get("lopend") or {}; a=j.get("agents") or {}; k=j.get("nachtketen") or {}; h=j.get("sb2_herstelproef") or {}
  oud=os.environ.get("UITROL_AGENTS")=="alle" or "kwetsbaar" not in a or "gesprekken" not in l
  b,ag=(l.get("beurten",0),a.get("lopend",0)) if oud else (l.get("gesprekken",0),a.get("kwetsbaar",0))
  print(int(b)+int(l.get("onopgehaald",0))+int(ag)+int(k.get("lopend",0))+int(h.get("lopend",0)))
except Exception: print(0)' 2>/dev/null || echo 0)"
    [ "${DRUK:-0}" = "0" ] && break
    if [ "$GEWACHT" -ge "$WACHT_MAX" ]; then log "LET OP: na ${GEWACHT}s nog ${DRUK} lopend - uitrol gaat toch door"; TOCH=1; break; fi
    if [ "$GEWACHT" = "0" ]; then log "wachten: ${DRUK} beurt(en)/resultaat(en)/agent(s) lopend"; fi
    sleep 10; GEWACHT=$((GEWACHT+10))
    marker_zet 2>/dev/null || true   # verversen; een overgenomen marker (tweede uitrol) wordt weer van ons - beide wachten
  done
  if [ "$GEWACHT" -gt 0 ] && [ "$TOCH" = "0" ]; then log "rustig na ${GEWACHT}s"; fi
fi

# UITROL_DROOG=1: alleen ophalen, klaarzetten en wachten (met marker), niet omzetten en niets herstarten. Voor toetsen.
if [ "${UITROL_DROOG:-0}" = "1" ]; then log "droog: gestopt na het wachten, niets omgezet"; exit 0; fi

# Gesprekken met het spraakkastje (socev-auto, 3-10-2026) tellen bewust NIET mee als blokkade: een hangend gesprek
# zou de uitrol 30 minuten ophouden. Wel een logregel, zodat een afgebroken gesprek te verklaren is.
TUN="$(curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys
try: print(int((json.load(sys.stdin).get("auto") or {}).get("tunnels",0)))
except Exception: print(0)' 2>/dev/null || echo 0)"
[ "${TUN:-0}" != "0" ] && log "LET OP: ${TUN} gesprek(ken) met het spraakkastje lopen; die breken af bij de herstart"

# Hulpstukken voor de nacontrole (stap 3 en 4b).
BOX="${UITROL_BOX:-/opt/data/AI_SecondBrain/00_Systeem/Meldingen/machinekamer.md}"
health_veld(){ curl -s -m 5 "http://127.0.0.1:${PORT:-8080}/health" | python3 -c 'import json,sys
try:
  j=json.load(sys.stdin); s=j.get("server") or {}; a=j.get("app") or {}
  e=[x.get("echt") for x in (s,a) if isinstance(x,dict) and "echt" in x]
  print(str(j.get("versie","")) + " " + ("nee" if False in e else ("ja" if True in e else "onbekend")))
except Exception: print("- onbekend")' 2>/dev/null || echo "- onbekend"; }
box_rij(){ [ -f "$BOX" ] || { log "LET OP: box $BOX bestaat niet - geen rij geschreven"; return 0; }
  python3 -I -B - "$BOX" "$1" "$2" "$3" "$4" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd):$BRON_REPO:/opt/data/mk-scripts/veilig" <<'PYBOX' || log "LET OP: kon geen rij in de box schrijven"
import sys, datetime
p, titel, zag, status, kost, hier = sys.argv[1:7]
# wv900: de box staat in de vault, schrijfbaar voor socev; een vaste tijdelijke naam (vroeger .machinekamer.md.uitrol.tmp)
# volgde een symlink die socev daar zette. Nu vault_veilig.wijzig: getoetste mapdescriptor, eigen tmp met O_EXCL, rename, flock.
sys.path[:0] = hier.split(':')   # naast dit script, dan de werkboom (BRON_REPO), dan de kopie in mk-scripts (Fable wv900 #5)
import vault_veilig
nu = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
rij = ('\n## [log] %s — %s\n- status: %s\n- van: uitrol.sh (nacontrole wv358)\n- wat ik zag: %s\n'
       '- wat het David kost als het blijft liggen: %s\n'
       '- voorstel: oorzaak zoeken in /opt/data/bin/uitrol.log, supervisor.log en de release; niet opnieuw uitrollen voor het verklaard is.\n') % (nu, titel, status, zag, kost)
def erin(s):
    i = s.find('**Formaat**')
    if i < 0: sys.exit(1)
    j = s.index('\n', i) + 1
    return s[:j] + rij + s[j:]
vault_veilig.wijzig(p, erin)
PYBOX
}
NC_MAX="${UITROL_NACONTROLE_MAX:-90}"
# wv3418 (B39): de bedoelde versie vastleggen. Atomisch (tmp + mv); mislukt het, dan een LET OP en door (de uitrol zelf is niet kapot).
GEWENST="$APP_ROOT/gewenst"
gewenst_zet(){ printf '{"sha":"%s","tijd":"%s","door":"uitrol.sh","reden":"%s"}\n' "$1" "$(date -Iseconds)" "$2" > "$GEWENST.nieuw.$$" \
  && mv -f "$GEWENST.nieuw.$$" "$GEWENST" || { rm -f "$GEWENST.nieuw.$$"; log "LET OP: kon $GEWENST niet schrijven"; }; return 0; }
# Wacht tot /health versie $1 toont, hooguit NC_MAX s. Zet STAND ("<versie> ja|nee|onbekend"); 0 = gezien.
wacht_op_versie(){ local tot=$((SECONDS + NC_MAX)); STAND="- onbekend"
  while :; do STAND="$(health_veld)"; [ "${STAND%% *}" = "$1" ] && return 0; [ "$SECONDS" -ge "$tot" ] && return 1; sleep 2; done; }

# ── 3. omzetten ─────────────────────────────────────────────────────────────
HUIDIG="$(readlink "$CURRENT" 2>/dev/null || echo '')"
VORIGE_OUD="$(readlink "$VORIGE" 2>/dev/null || echo '')"   # wv358: terug te zetten als de nacontrole terugzet
if [ "$HUIDIG" = "releases/$KORT" ]; then
  gewenst_zet "$KORT" "current wees al naar deze release"
  # wv3418 (B39, review M4): de symlink zegt niets over wat draait. Halve stand (current omgezet, oud kind leeft nog) = exit 1.
  if [ "${UITROL_NACONTROLE:-1}" = "1" ] && ! wacht_op_versie "$KORT"; then
    fout "current wijst al naar $KORT, maar /health toont na ${NC_MAX}s versie ${STAND%% *} (halve stand: het oude kind draait nog, of terugflip/trage start; zie supervisor.log) - niet uitgerold"
  fi
  if [ -n "$DRAAIT_ONVOLLEDIG" ]; then   # wv3464 vangnet: de draaiende release mist bestanden die de commit wel heeft
    box_rij "Uitrol: draaiende release $KORT mist ${DRAAIT_ONVOLLEDIG% }" \
      "uitrol.sh (wv3464): releases/$KORT draait, maar ${DRAAIT_ONVOLLEDIG% } staat wel in commit $KORT en niet in de release (gebouwd door een achterlopend uitrol.sh). Niet aangeraakt omdat hij draait." \
      "open — uitrol.sh $(date '+%-d-%-m %H:%M')" "de routes/onderdelen in die bestanden geven 404 of staan uit tot de volgende uitrol; herstel: volgende commit uitrollen, of de bestanden met git show in de release zetten en het kind herstarten."
    fout "current wijst al naar $KORT, maar die release mist ${DRAAIT_ONVOLLEDIG% } (rij in de box)"
  fi
  log "current wijst al naar $KORT - niets om te doen"
  exit 0
fi

# `vorige` wijst hierna naar wat NU draait: dat is het vangnet van de supervisor.
if [ -n "$HUIDIG" ]; then
  ln -sfn "$HUIDIG" "$VORIGE.nieuw" && mv -Tf "$VORIGE.nieuw" "$VORIGE" || fout "kon vorige niet zetten"
  log "vorige -> $HUIDIG"
fi
ln -sfn "releases/$KORT" "$CURRENT.nieuw" && mv -Tf "$CURRENT.nieuw" "$CURRENT" || fout "kon current niet omzetten"
log "current -> releases/$KORT"
gewenst_zet "$KORT" "uitrol"

# ── 4. kind herstarten ──────────────────────────────────────────────────────
# De supervisor start het kind vanzelf opnieuw op als het stopt, en doet dan zijn
# boot-zelfcontrole. We stoppen dus alleen het kind; de supervisor doet de rest,
# inclusief de terugflip als de nieuwe release niet gezond opkomt.
# Alleen kinderen onder DEZE releases-map (wv358): een toets met een eigen APP_ROOT raakt zo nooit het productiekind.
# Wat dit nog wel raakt: een proef die als `node /opt/data/app/releases/<sha>/server.js` op een andere poort draait.
PIDS="$(pgrep -f "node .*${RELEASES}/[^/]*/server\.js" || true)"
if [ -n "$PIDS" ]; then
  log "kind stoppen (pid $(echo "$PIDS" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill -TERM $PIDS 2>/dev/null || true
else
  log "geen draaiend kind gevonden - de supervisor start er zelf een"
fi

# ── 4b. nacontrole: draait de nieuwe release op de echte paden? (wv358, 10-10-2026) ──────────────────────
# Sinds wv349 valt server.js terug op een wegwerpmap (/tmp/socev-app-proef-<pid>) als realpath(__dirname) niet gelijk
# is aan realpath(RELEASE_DIR) (SERVER_ECHT). In productie betekent dat: verse Telegram-sessies, agents nooit afgerond,
# rolbestand niet ververst, app op lege data - terwijl /health gewoon ok zegt, dus de boot-zelfcontrole van de
# supervisor slaagt. Daarom hier: zodra /health de nieuwe versie toont, server.echt en app.echt lezen. Alleen een
# expliciete false telt (een oude release zonder veld is geen meting). False -> current terug naar HUIDIG, vorige
# terug naar wat hij was, het KORT-kind stoppen (de supervisor herstart vanaf HUIDIG mét boot-zelfcontrole), een rij
# in de machinekamer-box en exit 1. Niet bij een droge uitrol (stopt hierboven). Zonder HUIDIG (vers volume) is er niets om naar
# terug te gaan: dan alleen exit 1 (de Werkvoorraad-tikker meldt het). Sinds wv3418 ook zonder gestopt kind: de versie moet opkomen.
# De periodieke kant (podstart, image-wissel) bewaakt n8n AI - Werkvoorraad-tikker (knoop Echt-alarm?).
# wv3418 (B39, review M1): komt de nieuwe versie niet op (terugflip door de supervisor, geen supervisor, trage start), dan exit 1
# zonder "klaar". Vroeger alleen een LET OP en daarna "klaar" met exit 0; zonder gevonden kind of zonder HUIDIG werd niets gemeten.
# gewenst blijft $KORT: blijft het verschil staan, dan meldt server.js het na 10 min één keer in de box.
if [ "${UITROL_NACONTROLE:-1}" = "1" ]; then
  if ! wacht_op_versie "$KORT"; then
    fout "nacontrole - /health toont na ${NC_MAX}s versie ${STAND%% *}, niet $KORT (terugflip door de supervisor, geen supervisor of trage start; zie supervisor.log) - niet uitgerold"
  fi
  if [ "${STAND#* }" = "ja" ]; then
    log "nacontrole: $KORT draait op de echte paden (echt: ja)"
  elif [ "${STAND#* }" != "nee" ]; then
    log "nacontrole: $KORT toont geen echt-veld (release van vóór wv349) - niet te toetsen"
  elif [ -z "$HUIDIG" ]; then
    fout "nacontrole - $KORT draait in een wegwerpmap (/health server.echt/app.echt false) en er is geen vorige release om naar terug te gaan"
  else
    log "FOUT: nacontrole - $KORT draait in een wegwerpmap (/health server.echt/app.echt false); terugzetten naar $HUIDIG"
    if [ "$(readlink "$CURRENT" 2>/dev/null)" != "releases/$KORT" ]; then
      log "current wijst al naar $(readlink "$CURRENT" 2>/dev/null) - de supervisor was ons voor; niets omgezet"
    else
      ln -sfn "$HUIDIG" "$CURRENT.nieuw" && mv -Tf "$CURRENT.nieuw" "$CURRENT" || fout "kon current niet terugzetten (current wijst nog naar $KORT)"
      log "current -> $HUIDIG (teruggezet)"
      gewenst_zet "$(basename "$HUIDIG")" "nacontrole zette $KORT terug (wegwerpmap)"
      if [ -n "$VORIGE_OUD" ] && [ -f "$APP_ROOT/$VORIGE_OUD/server.js" ]; then
        ln -sfn "$VORIGE_OUD" "$VORIGE.nieuw" && mv -Tf "$VORIGE.nieuw" "$VORIGE" && log "vorige -> $VORIGE_OUD (teruggezet)"
      else
        log "LET OP: vorige blijft $HUIDIG (de oude vorige '${VORIGE_OUD}' is er niet meer); de supervisor heeft dan geen terugvalrelease"
      fi
      KPIDS="$(pgrep -f "node .*${RELEASES}/${KORT}/server\.js" || true)"
      if [ -n "$KPIDS" ]; then
        log "kind van $KORT stoppen (pid $(echo "$KPIDS" | tr '\n' ' '))"
        # shellcheck disable=SC2086
        kill -TERM $KPIDS 2>/dev/null || true
      else
        log "geen kind van $KORT meer gevonden - de supervisor start vanaf $HUIDIG"
      fi
    fi
    TERUG="$(basename "$HUIDIG")"; wacht_op_versie "$TERUG" || true
    if [ "${STAND%% *}" != "$TERUG" ]; then UITSLAG="na ${NC_MAX}s draait versie ${STAND%% *}, niet $TERUG - zie supervisor.log"
    elif [ "${STAND#* }" = "nee" ]; then UITSLAG="ook $TERUG draait in een wegwerpmap: de oorzaak zit buiten de release (supervisor/image, RELEASE_DIR) - pod herstarten of image nakijken"
    else UITSLAG="$TERUG draait weer (echt: ${STAND#* })"; fi
    case "$UITSLAG" in
      "$TERUG draait weer"*) KOST="niets zolang $TERUG echt draait; de nieuwe code staat niet live." ;;
      *) KOST="veel: verse Telegram-sessies, agents worden niet afgerond, de app draait op lege data (de Werkvoorraad-tikker start niets en meldt het in de debug-bot)." ;;
    esac
    log "nacontrole: $UITSLAG"
    box_rij "Uitrol $KORT teruggezet: release draaide in een wegwerpmap (server.echt false)" \
      "uitrol.sh zette current naar releases/$KORT; /health gaf echt=false (realpath(__dirname) != realpath(RELEASE_DIR), zie server.js SERVER_ECHT). Teruggezet naar $HUIDIG. Uitslag: $UITSLAG." \
      "open — uitrol.sh nacontrole $(date '+%-d-%-m %H:%M')" "$KOST"
    exit 1
  fi
fi

# ── 5. opruimen ─────────────────────────────────────────────────────────────
# current en vorige blijven altijd staan; de rest op ouderdom.
HOUD_A="$(basename "$(readlink "$CURRENT" 2>/dev/null || echo x)")"
HOUD_B="$(basename "$(readlink "$VORIGE" 2>/dev/null || echo x)")"
n=0
for d in $(ls -1dt "$RELEASES"/*/ 2>/dev/null); do
  naam="$(basename "$d")"
  [ "$naam" = "$HOUD_A" ] && continue
  [ "$naam" = "$HOUD_B" ] && continue
  n=$((n + 1))
  [ "$n" -lt "$BEWAAR" ] && continue
  rm -rf "$d" && log "oude release opgeruimd: $naam"
done

log "klaar - uitgerold naar $KORT (de supervisor controleert nu zelf of hij gezond opkomt)"
