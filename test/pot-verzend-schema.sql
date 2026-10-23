-- Deel van het D1-schema fin (gemeten 23-10-2026) + migraties 0009 en 0010 (fin-datahub-skill, pot/migratie_00*.sql), voor test/pot-verzend.sh en test/pot-auto.sh
CREATE TABLE entiteit (code TEXT PRIMARY KEY, naam TEXT NOT NULL, rechtsvorm TEXT, kvk TEXT, agb TEXT, eigenaar TEXT, boekjaar TEXT DEFAULT 'kalenderjaar', vault_pad TEXT, opmerking TEXT, iban TEXT, tnv TEXT, adres TEXT, postcode_plaats TEXT, naam_document TEXT);
CREATE TABLE praktijk (id TEXT PRIMARY KEY, naam TEXT NOT NULL, naam_vorig TEXT, eigenaar TEXT, opmerking TEXT, naam_brief TEXT, tav TEXT, adres TEXT, postcode_plaats TEXT, email TEXT);
CREATE TABLE praktijk_naam (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), naam TEXT, iban TEXT, geldig_van TEXT, geldig_tot TEXT, herkomst TEXT, opmerking TEXT);
CREATE TABLE nota (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, nummer TEXT NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), datum TEXT NOT NULL, soort TEXT NOT NULL, periode TEXT, titel TEXT, regels TEXT NOT NULL, bedrag REAL NOT NULL, status TEXT NOT NULL DEFAULT 'definitief', bron TEXT, plan_id INTEGER REFERENCES plan(id), aangemaakt_op TEXT, opmerking TEXT, UNIQUE(entiteit, nummer));
CREATE TABLE plan (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, versie TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'concept', termijn TEXT NOT NULL DEFAULT 'kwartaal', marge_pct REAL NOT NULL DEFAULT 0, totaal REAL, sleutel_toelichting TEXT, gemaakt_op TEXT, vastgesteld_op TEXT, opmerking TEXT, UNIQUE(entiteit, jaar, versie));
CREATE TABLE migratie (nr INTEGER PRIMARY KEY, naam TEXT, toegepast_op TEXT);
CREATE TABLE bank_toewijzing (id INTEGER PRIMARY KEY AUTOINCREMENT, bankmutatie_id INTEGER NOT NULL REFERENCES bankmutatie(id), soort TEXT NOT NULL, praktijk_id TEXT REFERENCES praktijk(id), tegen_entiteit TEXT, persoon TEXT, boekjaar INTEGER, bedrag REAL NOT NULL, herkomst TEXT, opmerking TEXT);
CREATE TABLE bankmutatie (id INTEGER PRIMARY KEY AUTOINCREMENT, rekening TEXT NOT NULL REFERENCES bankrekening(iban), entiteit TEXT NOT NULL REFERENCES entiteit(code), boekdatum TEXT NOT NULL, bedrag REAL NOT NULL, tegenrekening TEXT, naam TEXT, omschrijving TEXT, kenmerk TEXT, banksoort TEXT, saldo_na REAL, bron_bestand TEXT, sleutel TEXT UNIQUE, bron_id INTEGER REFERENCES bron(id), geladen_op TEXT NOT NULL);
CREATE TABLE deelname (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), geldig_van TEXT, geldig_tot TEXT, regel TEXT, UNIQUE(entiteit, praktijk_id, geldig_van));
CREATE TABLE praktijk_patienten (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), peildatum TEXT NOT NULL, aantal REAL, status TEXT, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, UNIQUE(praktijk_id, peildatum));

-- 0009 (23-10-2026, wv911): nota's klaarzetten voor verzending — één rij per poging per nota.
-- Bouwplan: vault 01_Ontwikkeling/POT-app - nota's klaarzetten voor verzending (bouwplan 23-10-2026).md
-- Schrijvers: de POT-app (functions/api/pot: aanvragen, annuleren, adres bevestigen) en de pod (wacht → bezig → concept/...).
-- De PDF (base64) staat hier alleen tot het concept gemaakt is of de rij afloopt; daarna leeg.
CREATE TABLE IF NOT EXISTS nota_verzending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id INTEGER NOT NULL REFERENCES nota(id),
  entiteit TEXT NOT NULL,
  nummer TEXT NOT NULL,
  praktijk_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','fout','geannuleerd','vervangen','concept_weg')),
  niet_voor TEXT NOT NULL,            -- ISO UTC (JJJJ-MM-DDTHH:MM:SSZ); de pod vergelijkt in D1 met strftime('now')
  plan_datum TEXT,                    -- gekozen verzenddatum (lokaal, 07:00) of NULL = meteen
  onderwerp TEXT NOT NULL,
  bericht TEXT NOT NULL,
  van TEXT,
  pdf_naam TEXT NOT NULL,             -- door de server bepaald (zelfde regel als notaBestand in pot.html)
  pdf_b64 TEXT,
  pdf_sha256 TEXT NOT NULL,
  pdf_bytes INTEGER NOT NULL,
  aangevraagd_op TEXT NOT NULL,
  reden TEXT,                         -- reden bij opnieuw klaarzetten
  geclaimd_op TEXT,
  pogingen INTEGER NOT NULL DEFAULT 0,
  aan TEXT, cc TEXT, bron_pagina TEXT,
  concept_id TEXT, thread_id TEXT, bericht_id TEXT, concept_op TEXT, verzonden_op TEXT, gemeten_op TEXT,
  opmerking TEXT, fout TEXT,
  bijgewerkt_op TEXT NOT NULL
);
-- Eén actieve verzending per nota; fout, geannuleerd, vervangen en concept_weg blokkeren niet.
CREATE UNIQUE INDEX IF NOT EXISTS nota_verzending_actief ON nota_verzending(nota_id)
  WHERE status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker');
CREATE INDEX IF NOT EXISTS nota_verzending_status ON nota_verzending(status, niet_voor);
CREATE INDEX IF NOT EXISTS nota_verzending_nota ON nota_verzending(nota_id, id);
INSERT OR IGNORE INTO migratie (nr, naam, toegepast_op) VALUES (9, 'nota_verzending: nota''s klaarzetten als Gmail-concept (wv911)', '2026-10-23');

-- 0010 (23-10-2026, wv921): POT-nota's automatisch versturen op de gekozen datum, na Davids Ja per batch.
-- Ontwerp: vault 01_Ontwikkeling/POT-app - nota's automatisch versturen op datum (ontwerp 23-10-2026).md
-- 1. nota_verzending krijgt eigen statussen voor de automatische route (buiten alle bestaande where-clausules van de conceptroute):
--      auto_gevraagd       David vinkte "op die dag zelf versturen" aan; de pod maakt een vrijgave + besluitkaart
--      auto_vrij           David drukte Ja met verse vingerafdruk op die kaart (alleen de knoproute van de pod schrijft dit)
--      verzenden           gereserveerd door de pod vlak vóór de aanroep van de verzender (het enige slot tegen dubbel versturen)
--      auto_verstuurd      de verzender gaf een message_id terug
--      onzeker_verzonden   geen of onduidelijk antwoord: NOOIT terug naar de wachtrij; alleen-lezend terugzoeken in Verzonden
--      verstuurd_door_david de voorcontrole vond de nota al in Verzonden
--    en kolommen auto (1 = aangevraagd als automatisch), vrijgave_id, verzend_reservering_op, message_id.
--    Een auto-rij die niet automatisch kan (geen Ja, fout, na 12:00) wordt 'wacht' en loopt de conceptroute van 0009.
--    Bewaarregel pdf_b64: bij een auto-rij tot verstuurd, teruggevallen of vervallen (hooguit 45 dagen), anders tot het concept.
-- 2. nota_vrijgave: één rij per batch (per entiteit en dag, hooguit 9 nota's), gemaakt door de pod met de besluitkaart.
--    batch_hash = sha256 over de nota-hashes; nota_hashes = {verzending_id: sha256(id, nummer, bedrag, aan, cc, pdf, onderwerp, tekst,
--    afzender, dag)}; kaart_tekst_hash = sha256 over titel, waarom en stappen zoals de databank de kaart opsloeg.
--    Vrijgeven (vraag_id, bevestiging, bevestigd_op) alleen door de knoproute van de pod; ingetrokken_op bij een vervallen knopbeurt.
-- 3. pot_pod_stand: hartslag van de pod ('auto' = aan/uit); de POT-app biedt "zelf versturen" alleen aan als die vers is.
-- nota_verzending was leeg bij het toepassen (gemeten 23-10 13:00); de kopie hieronder is voor de zekerheid.
CREATE TABLE nota_verzending_nieuw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id INTEGER NOT NULL REFERENCES nota(id),
  entiteit TEXT NOT NULL,
  nummer TEXT NOT NULL,
  praktijk_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','fout','geannuleerd','vervangen','concept_weg',
    'auto_gevraagd','auto_vrij','verzenden','auto_verstuurd','onzeker_verzonden','verstuurd_door_david')),
  niet_voor TEXT NOT NULL,
  plan_datum TEXT,
  onderwerp TEXT NOT NULL,
  bericht TEXT NOT NULL,
  van TEXT,
  pdf_naam TEXT NOT NULL,
  pdf_b64 TEXT,
  pdf_sha256 TEXT NOT NULL,
  pdf_bytes INTEGER NOT NULL,
  aangevraagd_op TEXT NOT NULL,
  reden TEXT,
  geclaimd_op TEXT,
  pogingen INTEGER NOT NULL DEFAULT 0,
  aan TEXT, cc TEXT, bron_pagina TEXT,
  concept_id TEXT, thread_id TEXT, bericht_id TEXT, concept_op TEXT, verzonden_op TEXT, gemeten_op TEXT,
  opmerking TEXT, fout TEXT,
  bijgewerkt_op TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  vrijgave_id INTEGER,
  verzend_reservering_op TEXT,
  message_id TEXT
);
INSERT INTO nota_verzending_nieuw (id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64,
  pdf_sha256, pdf_bytes, aangevraagd_op, reden, geclaimd_op, pogingen, aan, cc, bron_pagina, concept_id, thread_id, bericht_id, concept_op, verzonden_op,
  gemeten_op, opmerking, fout, bijgewerkt_op)
  SELECT id, nota_id, entiteit, nummer, praktijk_id, status, niet_voor, plan_datum, onderwerp, bericht, van, pdf_naam, pdf_b64,
  pdf_sha256, pdf_bytes, aangevraagd_op, reden, geclaimd_op, pogingen, aan, cc, bron_pagina, concept_id, thread_id, bericht_id, concept_op, verzonden_op,
  gemeten_op, opmerking, fout, bijgewerkt_op FROM nota_verzending;
DROP TABLE nota_verzending;
ALTER TABLE nota_verzending_nieuw RENAME TO nota_verzending;
-- Eén actieve verzending per nota; fout, geannuleerd, vervangen en concept_weg blokkeren niet.
CREATE UNIQUE INDEX nota_verzending_actief ON nota_verzending(nota_id)
  WHERE status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','auto_gevraagd','auto_vrij','verzenden','auto_verstuurd','onzeker_verzonden','verstuurd_door_david');
CREATE INDEX nota_verzending_status ON nota_verzending(status, niet_voor);
CREATE INDEX nota_verzending_nota ON nota_verzending(nota_id, id);
CREATE INDEX nota_verzending_vrijgave ON nota_verzending(vrijgave_id);
CREATE TABLE IF NOT EXISTS nota_vrijgave (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entiteit TEXT NOT NULL,
  plan_datum TEXT NOT NULL,           -- verzenddag (lokaal)
  nota_ids TEXT NOT NULL,             -- JSON-lijst van nota_verzending.id
  nota_hashes TEXT NOT NULL,          -- JSON {verzending_id: sha256}
  batch_hash TEXT NOT NULL,
  kaart_sleutel TEXT UNIQUE,          -- pot-vrijgave-<id>
  kaart_tekst_hash TEXT,              -- pas gezet als de kaart in de databank staat
  vraag_id TEXT, bevestiging TEXT, bevestigd_op TEXT,
  vervalt_op TEXT NOT NULL,           -- = plan_datum (een vrijgave geldt alleen voor die dag; gemaakt hooguit 45 dagen vooraf)
  ingetrokken_op TEXT,
  herinnerd_op TEXT, gemeld_op TEXT,
  gemaakt_op TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pot_pod_stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL, op TEXT NOT NULL);
INSERT OR IGNORE INTO migratie (nr, naam, toegepast_op) VALUES (10, 'nota_vrijgave: POT-nota''s automatisch versturen na Davids Ja per batch (wv921)', '2026-10-23');
