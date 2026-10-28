'use strict';
// Ploeg-register (wv1707, OVIS M4a; ontwerplijnen § 6 en de gemeten werkerslijst van M0, bijlage "OVIS - werkerslijst (24-10-2026)").
// Eén lijst van alle werkers: agents, wachters, managers en routines, met wat vast staat (naam, soort, module, skill, sessie, model,
// hartslagcomponent, uitkomst, uitzetbaar). Wat beweegt komt er live bij: het rooster en aan/uit uit n8n (n8n blijft de bron van het
// rooster, Fable #18: hier alleen het workflow-id), de hartslag uit machinekamer.hartslag. Pod-werkers buiten n8n (triggersoort
// pod-tijdklok of pod) dragen hun rooster hier, als tekst (de klok zelf staat in server.js / sb2-nacht.js).
// Daarnaast OVERIG: de actieve n8n-workflows die geen werker zijn (kanalen, luiken, JIMMY), zodat de check sluit: elke actieve
// n8n-workflow staat óf als werker óf als overig in dit bestand; een nieuwe die er niet in staat is een bevinding (Data Manager DM12).
// Managers: de weekronde en Nu draaien blijven in managers.js (veld manager = id daar); dit register verwijst, het rooster niet dubbel.
// Een nieuwe werker = één regel hier (+ test/werkers.sh telt mee). Geen netwerk in maak/stand; alleen de CLI (ronde) leest n8n en
// Supabase met de sleutels uit de omgeving van de aanroeper. Geen sleutels of inhoud in dit bestand.
// model: 'pod-standaard' = de workflow geeft geen model mee en draait op de standaard van de pod (§ 6.2 wil het altijd ingevuld: M4b).
// wv1733 (Opus-review M4): CISO-ronde, CISO-bezorger, Keten-attest (beveiliging), Bericht-foutteller (kanaal) en Locatie (de kwartierronde
// van de Stiltewachter kent de schakelaar niet) staan op uitzetbaar false: alleen pauze met vingerafdruk.
// wv1733 (M4b, groep managers): de vijf managers zonder hartslag stempelen nu (n8n-knopen Run gelukt? + Hartslag stempel) en geven, net als
// de CISO, model claude-opus-5-5 mee in de workflow. De andere groepen volgen (box-rij machinekamer 27-10).
const fs = require('fs');
const path = require('path');

const SOORTEN = ['agent', 'wachter', 'manager', 'routine'];
const SOORT_NAAM = { agent: 'Agents', wachter: 'Wachters', manager: 'Managers', routine: 'Routines' };

// ── werkers die n8n start (gemeten 27-10-2026 18:30, 98 actieve workflows; duiding uit M0 van 24-10) ──
const N8N = [
  {"id": "n8n-mYPR5ObQheQOcnyd", "naam": "Actie-Bewaker", "soort": "wachter", "n8n": "mYPR5ObQheQOcnyd", "sessie": "hoofd", "skill": "actie-bewaker", "model": "pod-standaard", "hartslag": ["wachter-actie"], "uitkomst": "ochtend_buffer + Bericht aan David (hoofd)"},
  {"id": "n8n-2sGqWO46keLSzNQw", "naam": "Agenda-Wachter", "soort": "wachter", "n8n": "2sGqWO46keLSzNQw", "sessie": "hoofd", "skill": "agenda-wachter", "model": "pod-standaard", "hartslag": ["wachter-agenda"], "uitkomst": "ochtend_buffer + Bericht aan David (hoofd)"},
  {"id": "n8n-J3JXCQYONcio5CtV", "naam": "Bank-ronde", "soort": "routine", "module": "financien", "n8n": "J3JXCQYONcio5CtV", "model": "geen", "hartslag": ["bank-ronde", "paypal-ronde"], "uitkomst": "Bericht aan David (hoofd) alleen bij nieuws/fout"},
  {"id": "n8n-Oo1wBLEJJYpua3UP", "naam": "Bericht-foutteller", "soort": "routine", "n8n": "Oo1wBLEJJYpua3UP", "model": "geen", "hartslag": [], "uitkomst": "Telegram", "uitzetbaar": false},
  {"id": "n8n-I33oOyrHzUdK1hSM", "naam": "CISO-bezorger", "soort": "routine", "n8n": "I33oOyrHzUdK1hSM", "model": "geen", "hartslag": ["ciso_bezorger"], "uitkomst": "Bericht aan David (machinekamer)", "uitzetbaar": false},
  {"id": "n8n-FyzsteLHpvRHhrdk", "naam": "CISO-ronde", "soort": "manager", "n8n": "FyzsteLHpvRHhrdk", "sessie": "ciso", "skill": "ciso", "model": "claude-opus-5-5", "hartslag": ["ciso"], "uitkomst": "box + Bericht aan David (machinekamer)", "manager": "ciso", "uitzetbaar": false},
  {"id": "n8n-8o2bg3RXj6EJ02yF", "naam": "Contacten Sync (Google → Supabase)", "soort": "routine", "n8n": "8o2bg3RXj6EJ02yF", "model": "geen", "hartslag": [], "uitkomst": "Supabase secondbrain.contacten"},
  {"id": "n8n-s671dCP1OdjwzBGU", "naam": "Correspondentie-Wachter", "soort": "wachter", "n8n": "s671dCP1OdjwzBGU", "sessie": "hoofd", "skill": "correspondentie-wachter", "model": "pod-standaard", "hartslag": ["wachter-correspondentie"], "uitkomst": "ochtend_buffer + Bericht aan David (hoofd)"},
  {"id": "n8n-xQuUyrEKLe0CsSqJ", "naam": "Dagsamenvatting", "soort": "wachter", "n8n": "xQuUyrEKLe0CsSqJ", "sessie": "dagsamenvatting", "model": "claude-sonnet-5-5", "hartslag": [], "uitkomst": "Bericht aan David (machinekamer)"},
  {"id": "n8n-61aJDhDfnOccwXvA", "naam": "Data Manager", "soort": "manager", "n8n": "61aJDhDfnOccwXvA", "sessie": "data-manager", "skill": "data-manager", "model": "claude-sonnet-5-5", "hartslag": ["data_manager"], "uitkomst": "box + ≤ 1 kaart + Bericht (machinekamer)", "manager": "data"},
  {"id": "n8n-B5BlzKh4YSeT1xra", "naam": "Design Manager", "soort": "manager", "n8n": "B5BlzKh4YSeT1xra", "sessie": "design-manager", "skill": "design-manager", "model": "claude-sonnet-5-5", "hartslag": ["design_manager"], "uitkomst": "box + ≤ 1 kaart + Bericht (machinekamer)", "manager": "design"},
  {"id": "n8n-me0Tg5w9EeaPL3Bo", "naam": "Facturen-ronde", "soort": "routine", "module": "facturen", "n8n": "me0Tg5w9EeaPL3Bo", "model": "geen", "hartslag": [], "uitkomst": "Facturen-app (pod)"},
  {"id": "n8n-JG9l6rX2YTDsIKwl", "naam": "Gambia Weekreview", "soort": "wachter", "n8n": "JG9l6rX2YTDsIKwl", "sessie": "hoofd", "skill": "gambia-weekreview", "model": "pod-standaard", "hartslag": [], "uitkomst": "Bericht aan David (hoofd)"},
  {"id": "n8n-Em9VynFMj1RpmZMJ", "naam": "Harvester-ronde", "soort": "routine", "module": "harvester", "n8n": "Em9VynFMj1RpmZMJ", "model": "claude-sonnet-5-5", "hartslag": ["harvester-ronde"], "uitkomst": "Bericht aan David (machinekamer)"},
  {"id": "n8n-MU9HdXpIpESnM7tB", "naam": "Health-rapporten", "soort": "routine", "module": "gezondheid", "n8n": "MU9HdXpIpESnM7tB", "model": "geen", "hartslag": [], "uitkomst": "health-pod"},
  {"id": "n8n-1LjJcxpO8ZJ6y6iQ", "naam": "Ideeënmotor", "soort": "manager", "n8n": "1LjJcxpO8ZJ6y6iQ", "sessie": "ideeenmotor", "model": "claude-opus-5-5", "hartslag": ["ideeenmotor"], "uitkomst": "werkvoorraad + Bericht aan David (machinekamer)"},
  {"id": "n8n-1w4T7mdQ1NqYSxJP", "naam": "Keten-attest", "soort": "manager", "n8n": "1w4T7mdQ1NqYSxJP", "sessie": "keten-attest", "model": "pod-standaard", "hartslag": ["ciso_dag", "olares_login"], "uitkomst": "hartslag + n8n-datatabel", "uitzetbaar": false},
  {"id": "n8n-2vnKvuZ4Cu3SEcNJ", "naam": "Locatie (Tasker)", "soort": "routine", "n8n": "2vnKvuZ4Cu3SEcNJ", "model": "geen", "hartslag": ["locatie"], "uitkomst": "Supabase locatie", "uitzetbaar": false},
  {"id": "n8n-DDk9idnKqy6fnRYv", "naam": "Machinekamer droomronde", "soort": "manager", "n8n": "DDk9idnKqy6fnRYv", "sessie": "telegram-debug", "model": "pod-standaard", "hartslag": ["droomronde"], "uitkomst": "Bericht aan David (machinekamer)"},
  {"id": "n8n-9tOfRu1yQeycCwrk", "naam": "Mail volgen", "soort": "wachter", "n8n": "9tOfRu1yQeycCwrk", "sessie": "hoofd", "skill": "achtergrondagent", "model": "pod-standaard", "hartslag": [], "uitkomst": "label Socev-volgt + achtergrondagent (mailconcept)"},
  {"id": "n8n-9att2bGQ1e6TlxoB", "naam": "MCP-gezondheidscheck", "soort": "manager", "n8n": "9att2bGQ1e6TlxoB", "sessie": "mcp-check", "model": "claude-opus-5-5", "hartslag": ["mcp_check"], "uitkomst": "n8n-datatabel"},
  {"id": "n8n-ZxyRaseEh3qE4iO9", "naam": "n8n Backup (nachtelijk)", "soort": "routine", "n8n": "ZxyRaseEh3qE4iO9", "model": "geen", "hartslag": [], "uitkomst": "back-up", "uitzetbaar": false},
  {"id": "n8n-KsFUIOHcYScyCqBQ", "naam": "n8n Backup Data Tables (nachtelijk)", "soort": "routine", "n8n": "KsFUIOHcYScyCqBQ", "model": "geen", "hartslag": [], "uitkomst": "back-up", "uitzetbaar": false},
  {"id": "n8n-vGPtvfzNhqVDVjgX", "naam": "n8n Git-backup (nachtelijk)", "soort": "routine", "n8n": "vGPtvfzNhqVDVjgX", "sessie": "n8n-git-backup", "model": "pod-standaard", "hartslag": [], "uitkomst": "git", "uitzetbaar": false},
  {"id": "n8n-am4hmDfEmCGOwCHD", "naam": "Outlook meelezen", "soort": "routine", "n8n": "am4hmDfEmCGOwCHD", "model": "Qwen", "hartslag": ["outlook"], "uitkomst": "Supabase mail_register + Bericht (machinekamer)"},
  {"id": "n8n-zbotiGO4UHG8w10j", "naam": "Parro meelezen", "soort": "routine", "n8n": "zbotiGO4UHG8w10j", "sessie": "parro", "model": "pod-standaard", "hartslag": ["parro"], "uitkomst": "Bericht aan David (hoofd/machinekamer)"},
  {"id": "n8n-ExKOlDQ012gyJRuB", "naam": "Personeels-Wachter", "soort": "wachter", "n8n": "ExKOlDQ012gyJRuB", "sessie": "personeels-wachter", "skill": "personeels-wachter", "model": "pod-standaard", "hartslag": ["wachter-personeel"], "uitkomst": "ochtend_buffer + meldingenbestand"},
  {"id": "n8n-8cvqdjorQoOYFcrF", "naam": "Quotumalarm (weeklimiet Claude)", "soort": "routine", "n8n": "8cvqdjorQoOYFcrF", "model": "geen", "hartslag": [], "uitkomst": "Bericht aan David (machinekamer)"},
  {"id": "n8n-OcLEvP7xgEd9khA3", "naam": "Research-scout", "soort": "manager", "n8n": "OcLEvP7xgEd9khA3", "sessie": "research-scout", "model": "claude-opus-5-5", "hartslag": ["research_scout"], "uitkomst": "Bericht aan David (machinekamer)"},
  {"id": "n8n-BIDXbs6nAN3vWLcJ", "naam": "Second Brain - Mail Processor", "soort": "routine", "module": "intake", "n8n": "BIDXbs6nAN3vWLcJ", "sessie": "hoofd", "model": "claude-sonnet-5-5", "hartslag": [], "uitkomst": "raw_input in de vault + mail_verwerkt"},
  {"id": "n8n-8swfS8Km2fhuJSdT", "naam": "Signal meelezen", "soort": "routine", "n8n": "8swfS8Km2fhuJSdT", "model": "geen", "hartslag": [], "uitkomst": "Supabase signal_* + Bericht (machinekamer)"},
  {"id": "n8n-5yl8k8SWT4sK4spi", "naam": "Signal Nachtextractie", "soort": "wachter", "n8n": "5yl8k8SWT4sK4spi", "sessie": "signal", "model": "pod-standaard", "hartslag": [], "uitkomst": "vault + Bericht (hoofd/machinekamer)"},
  {"id": "n8n-fknxVgWDPcDAa4ZP", "naam": "Site-verversing", "soort": "routine", "n8n": "fknxVgWDPcDAa4ZP", "sessie": "site-verversing", "model": "pod-standaard", "hartslag": [], "uitkomst": "socev.dev"},
  {"id": "n8n-9aiWD9tXz448nS7E", "naam": "SMS Gateway", "soort": "routine", "n8n": "9aiWD9tXz448nS7E", "model": "geen", "hartslag": ["sms_aanvoer"], "uitkomst": "n8n-datatabel sms_inbox"},
  {"id": "n8n-W87J5NxDVGJOUagb", "naam": "Stiltewachter", "soort": "routine", "n8n": "W87J5NxDVGJOUagb", "model": "geen", "hartslag": ["stiltewachter"], "uitkomst": "Bericht aan David (hoofd/machinekamer)", "uitzetbaar": false},
  {"id": "n8n-I8Zp1BVfmcknTGmp", "naam": "Systeemrapport", "soort": "manager", "n8n": "I8Zp1BVfmcknTGmp", "sessie": "structuur-wachter", "skill": "systeemrapport", "model": "claude-opus-5-5", "hartslag": ["systeemrapport"], "uitkomst": "socev.dev + meldingenbestand"},
  {"id": "n8n-vmFrhWxNc7KrpdIL", "naam": "Teams extractie + consolidatie", "soort": "wachter", "n8n": "vmFrhWxNc7KrpdIL", "sessie": "hoofd", "skill": "teams-conversatie-consolidatie", "model": "pod-standaard", "hartslag": [], "uitkomst": "vault + Bericht (hoofd)"},
  {"id": "n8n-eS05MJkluKyINPls", "naam": "Teams meelezen", "soort": "routine", "n8n": "eS05MJkluKyINPls", "model": "Qwen", "hartslag": ["teams"], "uitkomst": "Supabase teams_berichten + Bericht (machinekamer)"},
  {"id": "n8n-gNfADWC3tXqGpgBo", "naam": "Tokenboekhouding (nachtelijk)", "soort": "routine", "n8n": "gNfADWC3tXqGpgBo", "sessie": "tokenmeting", "model": "pod-standaard", "hartslag": [], "uitkomst": "n8n-datatabel"},
  {"id": "n8n-fyOInqi5keQTUG5Y", "naam": "UI Manager", "soort": "manager", "n8n": "fyOInqi5keQTUG5Y", "sessie": "ui-manager", "skill": "ui-manager", "model": "claude-sonnet-5-5", "hartslag": ["ui_manager"], "uitkomst": "box + ≤ 1 kaart + Bericht (machinekamer)", "manager": "ui"},
  {"id": "n8n-sYkXgXKcZx4nDndO", "naam": "Vault-Conciërge", "soort": "manager", "n8n": "sYkXgXKcZx4nDndO", "sessie": "vault-concierge", "skill": "vault-concierge", "model": "claude-opus-5-5", "hartslag": ["vault_concierge"], "uitkomst": "meldingenbestand + zondagsbriefing"},
  {"id": "n8n-gxtTrqieHdEFSMmy", "naam": "Voor jou-beheer", "soort": "wachter", "n8n": "gxtTrqieHdEFSMmy", "sessie": "voor-jou", "skill": "voor-jou-beheer", "model": "claude-sonnet-5-5", "hartslag": ["voor_jou"], "uitkomst": "Voor jou + Bericht (machinekamer)"},
  {"id": "n8n-1e5YVrDUV5aOAJaf", "naam": "Voorwerk (acties in porties)", "soort": "wachter", "n8n": "1e5YVrDUV5aOAJaf", "model": "geen", "hartslag": ["voorwerk_acties"], "uitkomst": "Telegram + Bericht (hoofd/machinekamer)"},
  {"id": "n8n-vzW6OWQfr8kbZdFR", "naam": "Voorwerk (herinneringsconcepten)", "soort": "wachter", "n8n": "vzW6OWQfr8kbZdFR", "sessie": "voorwerk-herinnering", "model": "pod-standaard", "hartslag": ["voorwerk_mail"], "uitkomst": "Voor jou-kaarten + Bericht (machinekamer)"},
  {"id": "n8n-BvUvLnM1wm1ckUN6", "naam": "Voorwerk (ochtendblok)", "soort": "wachter", "n8n": "BvUvLnM1wm1ckUN6", "sessie": "voorwerk-ochtend", "model": "pod-standaard", "hartslag": ["voorwerk_ochtend"], "uitkomst": "Bericht (machinekamer)"},
  {"id": "n8n-AJhUsI1jjHchzEYB", "naam": "Voorwerk (vergaderbriefings)", "soort": "wachter", "n8n": "AJhUsI1jjHchzEYB", "sessie": "voorwerk", "model": "pod-standaard", "hartslag": ["voorwerk"], "uitkomst": "Bericht (hoofd/machinekamer)"},
  {"id": "n8n-CH35hNIhH4aKJA4H", "naam": "Werkvoorraad-tikker", "soort": "routine", "n8n": "CH35hNIhH4aKJA4H", "sessie": "werkvoorraad-box", "model": "pod-standaard", "hartslag": ["werkvoorraad"], "uitkomst": "start agents + Bericht (machinekamer)", "uitzetbaar": false},
  {"id": "n8n-agntIie8d9mqOlm6", "naam": "WhatsApp Conversatie-consolidatie", "soort": "wachter", "n8n": "agntIie8d9mqOlm6", "sessie": "hoofd", "skill": "whatsapp-conversatie-consolidatie", "model": "pod-standaard", "hartslag": [], "uitkomst": "vault + Bericht (machinekamer)"},
  {"id": "n8n-1JUome7OI4f7tkul", "naam": "WhatsApp Gambia Weekextractie", "soort": "routine", "n8n": "1JUome7OI4f7tkul", "model": "Whisper", "hartslag": [], "uitkomst": "vault-dumps (Gambia)"},
  {"id": "n8n-DVUqVkEIt8rKPR7L", "naam": "WhatsApp Nachtextractie", "soort": "routine", "n8n": "DVUqVkEIt8rKPR7L", "model": "Whisper", "hartslag": [], "uitkomst": "vault-dumps"},
  {"id": "n8n-FjPfBi64ND5PboBW", "naam": "Dagelijkse briefing", "soort": "wachter", "n8n": "FjPfBi64ND5PboBW", "sessie": "hoofd", "model": "pod-standaard", "hartslag": [], "uitkomst": "Bericht aan David (hoofd) + audio"},
  {"id": "n8n-GYzoDYNbU70K6Xxl", "naam": "Dagplanner - proactieve dagstart", "soort": "wachter", "n8n": "GYzoDYNbU70K6Xxl", "sessie": "hoofd", "model": "pod-standaard", "hartslag": [], "uitkomst": "hoofdsessie (stuurbestand)"},
  {"id": "n8n-h9fgRMuNxFEowfTQ", "naam": "Dienstwaarschuwer", "soort": "routine", "n8n": "h9fgRMuNxFEowfTQ", "model": "geen", "hartslag": [], "uitkomst": "Bericht aan David (hoofd)"},
  {"id": "n8n-scxWN2NUtsDRVdIb", "naam": "FV2 - 2 Extractie (elke 30 min, :15/:45)", "soort": "routine", "module": "facturen", "n8n": "scxWN2NUtsDRVdIb", "model": "lokaal", "hartslag": [], "uitkomst": "Supabase fv"},
  {"id": "n8n-NriiDaTuwS0xlDWS", "naam": "FV2 - Hulp - Waarneemdiensten iCal (1e van de maand 05:30)", "soort": "routine", "module": "facturen", "n8n": "NriiDaTuwS0xlDWS", "model": "geen", "hartslag": [], "uitkomst": "Supabase fv"},
  {"id": "n8n-pwXNABV5CYnnv0as", "naam": "Heartbeat - proactief overdag", "soort": "wachter", "n8n": "pwXNABV5CYnnv0as", "sessie": "hoofd", "model": "pod-standaard", "hartslag": [], "uitkomst": "Bericht aan David (hoofd)"},
  {"id": "n8n-lKcF3Oxt8WVeELPJ", "naam": "Nachtconsolidatie - dromen (03:00)", "soort": "wachter", "n8n": "lKcF3Oxt8WVeELPJ", "sessie": "hoofd", "skill": "nachtconsolidatie", "model": "pod-standaard", "hartslag": [], "uitkomst": "vault (actueel, logboek, deadlines)"},
  {"id": "n8n-vNsdkyTQIaGhU0Fj", "naam": "Nachtelijke raw_input-verwerking", "soort": "wachter", "n8n": "vNsdkyTQIaGhU0Fj", "sessie": "hoofd", "skill": "second-brain-verwerk-raw-input", "model": "pod-standaard", "hartslag": [], "uitkomst": "vault + Bericht (hoofd/machinekamer)"},
  {"id": "n8n-OQBs2wP6YugOHhQC", "naam": "Waarnemingzoeker", "soort": "routine", "n8n": "OQBs2wP6YugOHhQC", "model": "geen", "hartslag": [], "uitkomst": "Bericht aan David (hoofd)"},
];

// ── werkers buiten n8n (pod-tijdklok, pod-scripts, de tikker) — rooster als tekst, de klok staat in de code die erbij genoemd is ──
const POD = [
  { id: 'agents', naam: 'Achtergrondagents', soort: 'agent', trigger: 'tikker', rooster: 'de werkvoorraad-tikker (elke 2 min) en /agent op afroep',
    model: 'per opdracht', hartslag: [], uitkomst: 'Agent-rapport (machinekamer of hoofd); lijst in Agents', bron: 'server.js /agent, agent_jobs.json' },
  { id: 'bibliothecaris', naam: 'Bibliothecaris', soort: 'manager', module: 'intake', trigger: 'pod-tijdklok', rooster: 'elke nacht 02:30',
    model: 'geen', hartslag: ['bibliothecaris'], uitkomst: 'box-rij bij nieuwe bevindingen (BB1–BB7)', manager: 'bibliothecaris', bron: 'ovis-run.js bibliothecaris' },
  { id: 'ovis-compiler', naam: 'OVIS-compiler', soort: 'routine', module: 'intake', trigger: 'pod-tijdklok', rooster: 'elke 5 min (databank), nacht 01:00 (pagina\'s)',
    model: 'geen', hartslag: [], uitkomst: 'secondbrain.knoop + gegenereerd blok in de entiteitpagina\'s', bron: 'ovis-register.js compileer' },
  { id: 'sb2-linter', naam: 'SB2 frontmatter-linter', soort: 'routine', trigger: 'pod-tijdklok', rooster: 'elke nacht 02:00–02:29',
    model: 'geen', hartslag: ['sb2_linter'], uitkomst: 'vault-manifest + box bij fouten', bron: 'sb2-nacht.js → socev-scripts linter.py' },
  { id: 'socev-run-veeg', naam: 'Opruimronde crash-vangnet', soort: 'routine', trigger: 'pod-tijdklok', rooster: 'elke nacht 03:50–04:49',
    model: 'geen', hartslag: ['socev-run-veeg'], uitkomst: 'opgeruimde runs', bron: 'sb2-nacht.js → socev-run --veeg' },
  { id: 'ovis-kalender', naam: 'OVIS Calendar (externe kalenders)', soort: 'routine', trigger: 'pod-tijdklok', rooster: 'elke dag 06:35–07:34',
    model: 'geen', hartslag: ['ovis-kalender'], uitkomst: 'kalenderfeeds in de databank', bron: 'sb2-nacht.js → kalender_feed.py' },
  { id: 'ovis-agenda', naam: 'OVIS Calendar (spiegel Google-agenda\'s)', soort: 'routine', trigger: 'pod-tijdklok', rooster: 'elke dag 03:30–03:59',
    model: 'geen', hartslag: ['ovis-agenda'], uitkomst: 'agenda\'s alleen-lezen in de tijdlijn', bron: 'sb2-nacht.js → kalender_spiegel.py' },
  { id: 'ovis-deadlines', naam: 'OVIS Calendar (deadline-register op de tijdlijn)', soort: 'routine', trigger: 'pod-tijdklok', rooster: 'elke nacht 03:45–03:59',
    model: 'geen', hartslag: ['ovis-deadlines'], uitkomst: 'deadlines in de databank + tijdlijn-momentopname voor de agenda-wachter', bron: 'sb2-nacht.js → kalender_deadlines.py' },
  { id: 'offsite', naam: 'Offsite-back-ups (podstaat, health-pod, Supabase)', soort: 'routine', trigger: 'pod', rooster: 'elke nacht, eerste wekkertik na middernacht / 02:40 / 03:00',
    model: 'geen', hartslag: ['podstaat_offsite', 'healthpod_offsite', 'supabase_offsite'], uitkomst: 'versleuteld op Drive', uitzetbaar: false, bron: 'bin/vault-offsite.sh' },
  { id: 'vault-r2', naam: 'Vault naar R2', soort: 'routine', trigger: 'pod', rooster: 'elke nacht',
    model: 'geen', hartslag: ['vault_sync_r2'], uitkomst: 'kopie in de EU-R2-bucket', uitzetbaar: false, bron: 'sync-naar-r2.sh' },
  { id: 'uitwijk', naam: 'Uitwijk-sync en R230-nachtronde', soort: 'routine', trigger: 'pod', rooster: 'elke nacht',
    model: 'geen', hartslag: ['uitwijk_sync', 'r230_nachtcheck'], uitkomst: 'uitwijkserver bij', uitzetbaar: false, bron: 'bouwplan uitwijk § 4.3 en § 13.7' },
  { id: 'syncthing', naam: 'Syncthing (vault ↔ thuis, laptop, werk-pc)', soort: 'routine', trigger: 'pod', rooster: 'stempel elke 30 min',
    model: 'geen', hartslag: ['syncthing'], uitkomst: 'vault op de apparaten', uitzetbaar: false, bron: 'server.js (wv1277)' },
  { id: 'pot-verzending', naam: 'POT-verzending (SLOEL-nota\'s)', soort: 'routine', trigger: 'pod', rooster: 'op de verzenddatum die David koos',
    model: 'geen', hartslag: [], uitkomst: 'één mail per nota naar het factuuradres (grondwet 1, uitzondering)', bron: 'server.js potVzTik' },
  { id: 'app-meldingen', naam: 'App-seintjes', soort: 'routine', trigger: 'pod', rooster: 'doorlopend',
    model: 'geen', hartslag: [], uitkomst: 'seintje op de telefoon', uitzetbaar: false, bron: 'server.js appPushMeldTik' },
];

// ── actieve n8n-workflows die geen werker zijn (kanaal, luik, JIMMY) ──
const OVERIG = [
  {"n8n": "LeqoYYEvJPhAKPS3", "naam": "Agenda-knoppen", "soort": "luik"},
  {"n8n": "JD0yNxPq79jXk25J", "naam": "Agenda-Wachter API", "soort": "luik"},
  {"n8n": "KH0DmU21dWxRy5Ma", "naam": "Agent-rapport", "soort": "kanaal", "sessie": "hoofd", "uitzetbaar": false},
  {"n8n": "uuWKUlbTnPaP1K78", "naam": "Bericht aan David", "soort": "kanaal", "uitzetbaar": false},
  {"n8n": "rNAH29kzj0PxqWb9", "naam": "Cijfermeester Bot", "soort": "kanaal", "sessie": "cijfermeester"},
  {"n8n": "MiWuPjabqip7dCNo", "naam": "Facturen-verzender", "soort": "luik"},
  {"n8n": "YvuAcDCy14yxKkxm", "naam": "Files-portaal", "soort": "luik", "sessie": "hoofd"},
  {"n8n": "3KSm6ON7lQFxdBve", "naam": "Foutmelder", "soort": "kanaal", "uitzetbaar": false},
  {"n8n": "Pxl1HeB7woGqcXzF", "naam": "Injectie-canary (Jev)", "soort": "luik"},
  {"n8n": "9a6vZy16RncxlQ8A", "naam": "Injectielabel (Jev)", "soort": "luik"},
  {"n8n": "Z0OxkHC6vk3WCCHA", "naam": "Kluisluik (webhook)", "soort": "luik"},
  {"n8n": "ruUxLjRmYxgM8jzp", "naam": "Mailconcept naar Gmail", "soort": "luik"},
  {"n8n": "u2XdwcstzRuzb0nC", "naam": "OCR-gateway (DeepSeek) v2 (serieel)", "soort": "luik"},
  {"n8n": "43WqW5Y1NKy6YOw4", "naam": "Ping (bewaking)", "soort": "luik"},
  {"n8n": "daBOTmx9VdovlvtV", "naam": "Poortwachter (Jev)", "soort": "luik"},
  {"n8n": "ZmtqbIKwoKp4UTHe", "naam": "Secret-invoerluik", "soort": "luik"},
  {"n8n": "3oiAigcCz6LNmeBd", "naam": "Socev Agenda", "soort": "luik"},
  {"n8n": "p79ai87zzTjMIuYq", "naam": "Verbeterlog (webhook)", "soort": "luik"},
  {"n8n": "Bl2ZEi8H36CbSu48", "naam": "Voorlezen (Gemini-stem)", "soort": "luik"},
  {"n8n": "L2ODO5KsHlwiw4x1", "naam": "Voorwerk-blok (fase D)", "soort": "luik"},
  {"n8n": "SLYiYwqAabFlC8H3", "naam": "Voorwerk-knoppen", "soort": "luik"},
  {"n8n": "8SohM1ujMQqybT5p", "naam": "Werkkamer-bijlage", "soort": "luik"},
  {"n8n": "ca3ptS5xxeR6Tmbh", "naam": "Werkkamer-toegang", "soort": "luik"},
  {"n8n": "z7RCo4tFgVARf3UO", "naam": "Werkrooster Tolgaarde", "soort": "luik"},
  {"n8n": "GIuod668nbn9YPXI", "naam": "WhatsApp Chat Reader (webhook)", "soort": "luik"},
  {"n8n": "02Jga3TIAEigwgw0", "naam": "WhatsApp Chats Zoeken (webhook)", "soort": "luik"},
  {"n8n": "nDj2qyAC5hJL5eUU", "naam": "Claude Debug via Telegram", "soort": "kanaal", "sessie": "telegram-debug", "uitzetbaar": false},
  {"n8n": "OfQgM9h4qGY2dFm8", "naam": "Claude via Telegram", "soort": "kanaal", "sessie": "hoofd", "uitzetbaar": false},
  {"n8n": "yeF9UZ6t7Z7PfBH1", "naam": "FV2 - 5 Dashboard + Status + SEPA-pagina (web)", "soort": "luik"},
  {"n8n": "nbtGLStSN0sQ4ns3", "naam": "FV2 - 7 Bankimport (handmatig, uploadformulier)", "soort": "luik"},
  {"n8n": "rA3bpcRfShuLXIk2", "naam": "FV2 - Hulp - Backtest Harvest (eenmalig, handmatig)", "soort": "luik"},
  {"n8n": "rzFcROmWRQsINhBE", "naam": "FV2 - Sub - Forward na OK (dashboard/Telegram)", "soort": "luik"},
  {"n8n": "Z8lwj3ctPEuXPqPE", "naam": "FV2 - Sub - Normaliseer document", "soort": "luik"},
  {"n8n": "4R2JPMAwJq9xCZNi", "naam": "GHAWA Website via Telegram", "soort": "kanaal"},
  {"n8n": "mPIDK1kI5x6zB6iu", "naam": "JIMMY - Chat via Telegram", "soort": "jimmy"},
  {"n8n": "sXgSLOEYc9mBcThI", "naam": "JIMMY - Cijfercontrole", "soort": "jimmy"},
  {"n8n": "yC3NwNYJgHo6B5jb", "naam": "JIMMY - Dromen", "soort": "jimmy"},
  {"n8n": "HY55oGtbeTZKFz7q", "naam": "JIMMY - Heartbeat", "soort": "jimmy"},
  {"n8n": "hVr3SeSsfyxXfXdp", "naam": "JIMMY - Wachters", "soort": "jimmy"},
];

const WERKERS = N8N.map(function (w) { return Object.assign({ trigger: 'n8n' }, w); }).concat(POD);
const PER_ID = {};
WERKERS.forEach(function (w) { PER_ID[w.id] = w; });
const BEKEND_N8N = new Set(N8N.map(function (w) { return w.n8n; }).concat(OVERIG.map(function (w) { return w.n8n; })));

// ── rooster uit een n8n-workflow (live; alleen de triggerknopen die niet uit staan) ──
const DAGEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const twee = function (n) { return String(n).padStart(2, '0'); };
// eenvoudige cron (minuut uur * * dag) in gewone taal; de rest blijft "cron …"
function cronTekst(e) {
  const m = /^(\d{1,2}) (\d{1,2}(?:,\d{1,2})*|\d{1,2}-\d{1,2}) \* \* (\*|[0-7](?:[,-][0-7])*)$/.exec(e);
  if (!m) { const n = /^(\d{1,2}(?:,\d{1,2})*) (\*|\d{1,2}-\d{1,2}) \* \* \*$/.exec(e); return n ? 'elk uur op :' + n[1].split(',').map(twee).join('/:') + (n[2] === '*' ? '' : ' (' + n[2] + ' uur)') : 'cron ' + e; }
  const dag = m[3] === '*' ? 'elke dag' : m[3] === '1-5' ? 'werkdagen' : m[3].split(',').map(function (d) { return /-/.test(d) ? d.split('-').map(function (x) { return DAGEN[Number(x) % 7]; }).join('–') : DAGEN[Number(d) % 7]; }).join('/');
  const uren = /-/.test(m[2]) ? m[2].split('-').map(twee).join('–') + ' uur elk uur op :' + twee(m[1]) : m[2].split(',').map(function (u) { return twee(u) + ':' + twee(m[1]); }).join(', ');
  return dag + ' ' + uren;
}
function intervalTekst(iv) {
  const u = Number(iv.triggerAtHour || 0), m = Number(iv.triggerAtMinute || 0);
  switch (iv.field || 'days') {
    case 'cronExpression': return cronTekst(String(iv.expression || '').trim());
    case 'minutes': return 'elke ' + (iv.minutesInterval || 1) + ' min';
    case 'hours': return (Number(iv.hoursInterval || 1) === 1 ? 'elk uur' : 'elke ' + iv.hoursInterval + ' uur') + (iv.triggerAtMinute != null ? ' op :' + twee(m) : '');
    case 'days': return (Number(iv.daysInterval || 1) === 1 ? 'elke dag ' : 'elke ' + iv.daysInterval + ' dagen ') + twee(u) + ':' + twee(m);
    case 'weeks': return (Array.isArray(iv.triggerAtDay) ? iv.triggerAtDay : [iv.triggerAtDay || 0]).map(function (d) { return DAGEN[Number(d) % 7] || '?'; }).join('/') + ' ' + twee(u) + ':' + twee(m);
    case 'months': return 'dag ' + (iv.triggerAtDayOfMonth || 1) + ' van de maand ' + twee(u) + ':' + twee(m);
    default: return 'rooster (' + String(iv.field).slice(0, 20) + ')';
  }
}
function rooster(wf) {
  const uit = [];
  ((wf && Array.isArray(wf.nodes)) ? wf.nodes : []).forEach(function (n) {
    if (!n || n.disabled) return;
    const t = String(n.type || '');
    if (t === 'n8n-nodes-base.scheduleTrigger') {
      const l = (n.parameters && n.parameters.rule && Array.isArray(n.parameters.rule.interval)) ? n.parameters.rule.interval : [{}];
      l.forEach(function (iv) { uit.push(intervalTekst(iv || {})); });
    } else if (t === 'n8n-nodes-base.cron') uit.push('cron');
    else if (t === 'n8n-nodes-base.webhook' || t === 'n8n-nodes-base.formTrigger') { if (uit.indexOf('op afroep') < 0) uit.push('op afroep'); }
    else if (/telegramTrigger$/i.test(t)) { if (uit.indexOf('bij een bericht') < 0) uit.push('bij een bericht'); }
    else if (t === 'n8n-nodes-base.executeWorkflowTrigger') { if (uit.indexOf('door een andere workflow') < 0) uit.push('door een andere workflow'); }
    else if (t === 'n8n-nodes-base.errorTrigger') { if (uit.indexOf('bij een fout') < 0) uit.push('bij een fout'); }
  });
  return uit.join(' · ').slice(0, 160);
}

// ── hartslagrij → oordeel (mk_hartslag_stand geeft het al; uit een kale tabelrij rekenen we het zelf) ──
function oordeel(r, nu) {
  if (r && ['vers', 'te_laat', 'nooit', 'onbeoordeelbaar'].indexOf(r.oordeel) >= 0) return r.oordeel;
  if (!r || !r.laatste_ronde) return 'nooit';
  const t = Date.parse(r.laatste_ronde);
  if (!isFinite(t)) return 'onbeoordeelbaar';
  return r.drempel_min && nu - t > r.drempel_min * 60000 ? 'te_laat' : 'vers';
}
const ERG = { nooit: 3, te_laat: 2, onbeoordeelbaar: 1, vers: 0 };

// Alleen wat stand nodig heeft van een n8n-workflow (de triggerknopen), zodat de buffer klein blijft
const TRIGGER = /(scheduleTrigger|\.cron|\.webhook|formTrigger|telegramTrigger|executeWorkflowTrigger|errorTrigger)$/i;
function kaal(w) {
  return { id: w.id, name: String(w.name || ''), active: !!w.active, isArchived: !!w.isArchived,
    nodes: (Array.isArray(w.nodes) ? w.nodes : []).filter(function (n) { return n && TRIGGER.test(String(n.type || '')); })
      .map(function (n) { return { type: n.type, disabled: !!n.disabled, parameters: n.type === 'n8n-nodes-base.scheduleTrigger' ? n.parameters : undefined }; }) };
}
// stand(o): o.workflows = de actieve n8n-workflows uit de API ([{id, name, active, nodes}], kaal of volledig) of null bij een meetfout;
// o.hartslag = rijen van mk_hartslag_stand of machinekamer.hartslag, of null; o.nu (ms); o.vast (vaste plek: geen sessie/skill/bron).
function stand(o) {
  o = o || {};
  const nu = o.nu || Date.now(), vast = !!o.vast;
  if (!Array.isArray(o.workflows)) o = Object.assign({}, o, { workflows: null });   // een vreemde vorm telt als niet gemeten (Opus-review #5)
  if (!Array.isArray(o.hartslag)) o = Object.assign({}, o, { hartslag: null });
  const wf = {};
  (Array.isArray(o.workflows) ? o.workflows : []).forEach(function (w) { if (w && w.id) wf[w.id] = w; });
  const hs = {};
  (Array.isArray(o.hartslag) ? o.hartslag : []).forEach(function (r) { if (r && r.component) hs[r.component] = r; });
  const sch = schakelPerWerker(o.schakelaars);
  const kaarten = WERKERS.map(function (w) {
    const live = w.n8n ? wf[w.n8n] : null;
    const slagen = (w.hartslag || []).map(function (c) {
      const r = hs[c];
      return { c: c, oordeel: o.hartslag ? oordeel(r, nu) : 'onbeoordeelbaar', laatst: r && r.laatste_ronde ? new Date(r.laatste_ronde).toISOString() : null,
        drempel: r && typeof r.drempel_min === 'number' ? r.drempel_min : null };
    });
    let status;
    let sk = sch ? sch[w.id] || null : null;
    // Opus-review wv1733 Z2: een uit-rij terwijl n8n de workflow actief noemt (met de hand aangezet, of de wis mislukte) telt niet
    if (sk && sk.stand === 'uit' && w.n8n && o.workflows && live && live.active) sk = null;
    if (sk && sk.stand === 'uit') status = 'uit door David';
    else if (sk && sk.stand === 'pauze') status = sk.verlopen ? 'pauze voorbij, nog uit' : 'pauze';
    else if (w.n8n && o.workflows && (!live || !live.active)) status = 'uit';
    else if (!slagen.length) status = 'geen hartslag';
    else {
      const ergst = slagen.reduce(function (x, s) { return ERG[s.oordeel] > ERG[x] ? s.oordeel : x; }, 'vers');
      status = { vers: 'op tijd', te_laat: 'te laat', nooit: 'nog nooit', onbeoordeelbaar: 'onbekend' }[ergst];
    }
    const laatst = slagen.reduce(function (x, s) { return s.laatst && (!x || s.laatst > x) ? s.laatst : x; }, null);
    const k = { id: w.id, naam: w.naam, soort: w.soort, module: w.module || null, trigger: w.trigger,
      rooster: w.n8n ? (live && live.active ? rooster(live) || 'geen rooster (alleen met de hand)' : (o.workflows ? 'staat uit in n8n' : 'n8n nu niet leesbaar')) : (w.rooster || ''),
      actief: w.n8n ? (o.workflows ? !!(live && live.active) : null) : true,
      model: w.model, uitkomst: w.uitkomst, uitzetbaar: w.uitzetbaar !== false, status: status, laatst: laatst, hartslag: slagen,
      manager: w.manager || null, n8n: w.n8n || null,
      // wv1733 (OVIS M4b): schakelaar. kan = wat de knop mag (leeg op een vaste plek, buiten n8n of als de stand niet leesbaar is)
      schakelaar: sk ? { stand: sk.stand, sinds: sk.sinds || null, tot: sk.tot || null } : null,
      // geen knop voor wat zonder rij al uit staat in n8n (zou toch 409 geven; Opus-review KAN-4)
      kan: vast || !w.n8n || !sch ? [] : sk ? ['aan'] : (o.workflows && !(live && live.active)) ? [] : (w.uitzetbaar === false ? ['pauze'] : ['uit']) };
    if (!vast) { k.sessie = w.sessie || null; k.skill = w.skill || null; k.bron = w.bron || null; }
    else { k.uitkomst = ''; k.n8n = null; }   // vaste plek: geen beschrijving en geen id's (zoals de ringkaart, Fable wv888 #4)
    return k;
  });
  const groepen = {};
  SOORTEN.forEach(function (s) { groepen[s] = kaarten.filter(function (k) { return k.soort === s; }); });
  let c = check(o.workflows, o.hartslag, o.schakelaars);
  if (vast) c = { n8n_actief: c.n8n_actief, ontbreekt: c.ontbreekt && c.ontbreekt.map(function () { return { id: '', naam: '' }; }),
    niet_actief: c.niet_actief && c.niet_actief.map(function () { return { id: '', naam: '' }; }), hartslag_zonder_werker: c.hartslag_zonder_werker && c.hartslag_zonder_werker.map(function () { return ''; }) };
  return { groepen: groepen, overig: { aantal: OVERIG.length, per_soort: telPer(OVERIG) }, check: c,
    fout: { n8n: o.workflows ? null : 'het rooster uit n8n is nu niet leesbaar', hartslag: o.hartslag ? null : 'de hartslag is nu niet leesbaar',
      schakelaar: sch ? null : 'de schakelaarstand is nu niet leesbaar' } };
}
function telPer(l) { const t = {}; l.forEach(function (w) { t[w.soort] = (t[w.soort] || 0) + 1; }); return t; }

// check: elke actieve n8n-workflow staat in het register (als werker of als overig); elke n8n-werker is actief; elke hartslagcomponent
// hoort bij een werker (proefrijen niet). null-velden = niet gemeten.
function check(workflows, hartslag, schakelaars) {
  const uit = { n8n_actief: null, ontbreekt: null, niet_actief: null, hartslag_zonder_werker: null };
  const sch = schakelPerWerker(schakelaars) || {};   // wv1733: door David uitgezet of gepauzeerd = geen bevinding (wel een verlopen pauze)
  if (Array.isArray(workflows)) {
    const actief = workflows.filter(function (w) { return w && w.active && !w.isArchived; });
    const ids = new Set(actief.map(function (w) { return w.id; }));
    uit.n8n_actief = actief.length;
    uit.ontbreekt = actief.filter(function (w) { return !BEKEND_N8N.has(w.id); }).map(function (w) { return { id: w.id, naam: String(w.name || '').slice(0, 80) }; });
    uit.niet_actief = N8N.filter(function (w) { return !ids.has(w.n8n) && !(sch[w.id] && sch[w.id].geldig && !sch[w.id].verlopen); }).map(function (w) { return { id: w.n8n, naam: w.naam }; })
      .concat(OVERIG.filter(function (w) { return !ids.has(w.n8n); }).map(function (w) { return { id: w.n8n, naam: w.naam, overig: true }; }));
  }
  if (Array.isArray(hartslag)) {
    const gekend = new Set();
    WERKERS.forEach(function (w) { (w.hartslag || []).forEach(function (c) { gekend.add(c); }); });
    uit.hartslag_zonder_werker = hartslag.filter(function (r) { return r && r.component && !/proef/i.test(r.component) && !gekend.has(r.component); })
      .map(function (r) { return String(r.component).slice(0, 60); });
  }
  return uit;
}

// ── schakelaar (wv1733, OVIS M4b; ontwerplijnen § 6.2) ──
// Stand in Supabase machinekamer.schakelaar (RPC mk_schakelaar_stand → {rijen}); geen rij = aan. uit = n8n gedeactiveerd door David
// (één knop), pauze = 1 uur uit voor wat niet uit mag (kanalen, back-ups, beveiliging; vingerafdruk), daarna zet de pod hem zelf aan.
// Aanzetten altijd met vingerafdruk. Alleen n8n-werkers: pod-werkers krijgen hun schakelaar in een volgende stap.
function schakelPerWerker(rijen) {
  if (!Array.isArray(rijen)) return null;
  const m = {};
  rijen.forEach(function (r) { if (r && typeof r.werker === 'string' && (r.stand === 'uit' || r.stand === 'pauze')) m[r.werker] = r; });
  return m;
}
const SCHAKEL_ACTIES = ['uit', 'aan', 'pauze'];
// schakelKeuze(werker, actie, huidige rij of null) → { fout, status } of { actie, vers, al }
function schakelKeuze(w, actie, sk) {
  if (!w) return { fout: 'onbekende werker', status: 404 };
  if (SCHAKEL_ACTIES.indexOf(actie) < 0) return { fout: 'ongeldige keuze', status: 400 };
  if (!w.n8n) return { fout: w.naam + ' draait niet in n8n; zijn schakelaar volgt', status: 409 };
  if (actie === 'aan') return sk ? { actie: 'aan', vers: true } : { actie: 'aan', al: true };
  if (sk) return sk.stand === actie ? { actie: actie, al: true } : { fout: 'staat al ' + (sk.stand === 'uit' ? 'uit' : 'op pauze') + '; zet hem eerst aan', status: 409 };
  if (actie === 'uit' && w.uitzetbaar === false) return { fout: w.naam + ' mag niet uit (kanaal, back-up of beveiliging); alleen pauze van een uur', status: 409 };
  if (actie === 'pauze' && w.uitzetbaar !== false) return { fout: 'pauze is alleen voor wat niet uit mag; gebruik uitzetten', status: 409 };
  return { actie: actie, vers: actie === 'pauze' };
}
const PAUZE_MS = 60 * 60 * 1000;

// ── 00_Systeem/Ploeg.md (gegenereerd; zelfde patroon als de Datakaart) ──
const AMS_TIJD = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const cel = function (s) { return String(s == null ? '' : s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim(); };
function markdown(st, datum) {
  const r = ['---', 'type: systeem', 'onderwerp: Ploeg — alle agents, wachters, managers en routines (gegenereerd)', 'updated: ' + datum,
    'bron: claudebot-src/werkers.js (register) + n8n (rooster, aan/uit) + machinekamer.hartslag', '---', '',
    '# Ploeg', '', '> Gegenereerd door `werkers.js ronde` in de Data Manager-ronde (DM12). Niet met de hand bewerken: wijzig het register',
    '> `claudebot-src/werkers.js` (review + uitrol). Ontwerp: [[01_Ontwikkeling/OVIS - ontwerplijnen (bouwplan 24-10-2026)]] § 6.', ''];
  const c = st.check;
  r.push('**Stand ' + datum + ':** ' + SOORTEN.map(function (s) { return st.groepen[s].length + ' ' + SOORT_NAAM[s].toLowerCase(); }).join(', ') +
    '; daarnaast ' + st.overig.aantal + ' kanalen, luiken en JIMMY-stromen in n8n. ' +
    (c.n8n_actief == null ? 'n8n niet gemeten.' : c.n8n_actief + ' actieve n8n-workflows, ' + c.ontbreekt.length + ' niet in het register, ' +
      c.niet_actief.length + ' uit of weg.') + (c.hartslag_zonder_werker && c.hartslag_zonder_werker.length ? ' Hartslag zonder werker: ' + c.hartslag_zonder_werker.join(', ') + '.' : ''), '');
  SOORTEN.forEach(function (s) {
    r.push('## ' + SOORT_NAAM[s] + ' (' + st.groepen[s].length + ')', '', '| Werker | Module | Rooster | Model | Hartslag | Uitkomst | Uitzetbaar |', '|---|---|---|---|---|---|---|');
    st.groepen[s].forEach(function (k) {
      r.push('| ' + [k.naam + (k.n8n ? ' (`' + k.n8n + '`)' : ''), k.module || '—', k.rooster, k.model,
        k.status + (k.laatst ? ', ' + AMS_TIJD.format(new Date(k.laatst)) : ''), k.uitkomst, k.uitzetbaar ? 'ja' : 'nee (alleen pauze)'].map(cel).join(' | ') + ' |');
    });
    r.push('');
  });
  if (c.ontbreekt && c.ontbreekt.length) {
    r.push('## Niet in het register', '');
    c.ontbreekt.forEach(function (w) { r.push('- ' + cel(w.naam) + ' (`' + w.id + '`)'); });
    r.push('');
  }
  return r.join('\n') + '\n';
}

// ── CLI voor de Data Manager-ronde (en de machinekamer): node werkers.js ronde [--md <pad>] [--json <pad>] ──
// Leest n8n (N8N_API_URL of N8N_MCP_URL + N8N_API_KEY) en de hartslag (SUPABASE_MCP_TOKEN, Management API, alleen een SELECT).
// Uitvoer: de check als JSON op stdout. Exit 0 = alles in het register, 1 = bevinding, 2 = meetfout.
async function haalN8n() {
  const u = String(process.env.N8N_API_URL || process.env.N8N_MCP_URL || ''), i = u.indexOf('/mcp');
  const basis = (i > 0 ? u.slice(0, i) : u).replace(/\/$/, ''), k = process.env.N8N_API_KEY;
  if (!basis || !k) throw new Error('n8n-API niet ingesteld (N8N_API_URL/N8N_MCP_URL + N8N_API_KEY)');
  const uit = [];
  let cursor = null;
  for (let n = 0; n < 40; n++) {
    const r = await fetch(basis + '/api/v1/workflows?limit=25&active=true&excludePinnedData=true' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      { headers: { 'X-N8N-API-KEY': k, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('n8n http ' + r.status);
    const j = await r.json();
    if (!j || !Array.isArray(j.data)) throw new Error('n8n: antwoord zonder lijst');
    j.data.forEach(function (w) { if (w && w.active && !w.isArchived) uit.push(kaal(w)); });
    cursor = j.nextCursor;
    if (!cursor) return uit;
  }
  throw new Error('n8n: meer dan 40 pagina\'s');
}
const SB_PROJECT = 'tiwfbqwttnknnblhqpoo';
async function haalHartslag() {
  const t = process.env.SUPABASE_MCP_TOKEN;
  if (!t) throw new Error('SUPABASE_MCP_TOKEN ontbreekt');
  const r = await fetch('https://api.supabase.com/v1/projects/' + SB_PROJECT + '/database/query', { method: 'POST',
    headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', 'user-agent': 'socev-werkers/1.0' },
    // dezelfde RPC als de app (één definitie van "te laat", Opus-review wv1707 #3). read_only kan hier niet: die rol mag de functie niet
    // uitvoeren (gemeten 27-10); de querytekst staat vast en leest alleen.
    body: JSON.stringify({ query: 'select component, drempel_min, laatste_ronde, minuten_sinds, oordeel from public.mk_hartslag_stand()' }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('supabase http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('supabase: antwoord is geen lijst');
  return j;
}
// wv1733: schakelaarstand (dezelfde RPC als de pod); fout = null, dan telt een uitgezette werker als 'uit of weg' en staat er een fout bij
async function haalSchakelaars() {
  const t = process.env.SUPABASE_MCP_TOKEN;
  if (!t) throw new Error('SUPABASE_MCP_TOKEN ontbreekt');
  const r = await fetch('https://api.supabase.com/v1/projects/' + SB_PROJECT + '/database/query', { method: 'POST',
    headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json', 'user-agent': 'socev-werkers/1.0' },
    body: JSON.stringify({ query: 'select public.mk_schakelaar_stand() as s' }), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('supabase schakelaar http ' + r.status);
  const j = await r.json();
  const s = Array.isArray(j) && j[0] ? j[0].s : null;
  if (!s || !Array.isArray(s.rijen)) throw new Error('supabase: schakelaarstand zonder rijen');
  return s.rijen;
}
async function cli(argv) {
  const arg = function (n) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] !== 'ronde') { process.stderr.write('gebruik: node werkers.js ronde [--md <pad>] [--json <pad>]\n'); return 2; }
  let wf = null, hs = null;
  const fout = [];
  try { wf = await haalN8n(); } catch (e) { fout.push(String(e.message || e)); }
  try { hs = await haalHartslag(); } catch (e) { fout.push(String(e.message || e)); }
  let sk = null;
  try { sk = await haalSchakelaars(); } catch (e) { fout.push(String(e.message || e)); }
  const st = stand({ workflows: wf, hartslag: hs, schakelaars: sk });
  const datum = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(st, null, 1));
  if (arg('--md') && wf) {
    const md = markdown(st, datum);
    // vault-veilig.js staat in dezelfde release (byte-gelijk aan de mk-scripts-kopie); zonder die module niet schrijven (Opus-review wv1707 #2)
    let VV = null;
    try { VV = require(path.join(__dirname, 'vault-veilig.js')); } catch (e) { VV = null; }
    if (!VV || typeof VV.schrijf !== 'function') { fout.push('vault-veilig.js ontbreekt: Ploeg.md niet geschreven'); }
    else VV.schrijf(arg('--md'), md);
  }
  const telling = {}; SOORTEN.forEach(function (s) { telling[s] = st.groepen[s].length; });
  process.stdout.write(JSON.stringify({ datum: datum, telling: telling, overig: st.overig.aantal, check: st.check, fout: fout }, null, 1) + '\n');
  if (fout.length || st.check.n8n_actief == null || st.check.hartslag_zonder_werker == null) return 2;
  return st.check.ontbreekt.length || st.check.niet_actief.length || (st.check.hartslag_zonder_werker || []).length ? 1 : 0;
}

module.exports = { WERKERS: WERKERS, OVERIG: OVERIG, SOORTEN: SOORTEN, PER_ID: PER_ID, rooster: rooster, intervalTekst: intervalTekst, oordeel: oordeel,
  stand: stand, check: check, markdown: markdown, kaal: kaal, schakelKeuze: schakelKeuze, schakelPerWerker: schakelPerWerker, PAUZE_MS: PAUZE_MS };

if (require.main === module) cli(process.argv.slice(2)).then(function (c) { process.exitCode = c; }, function (e) { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 2; });
