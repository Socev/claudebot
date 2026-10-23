-- Deel van het D1-schema fin (gemeten 23-10-2026) + migratie 0009 (fin-datahub-skill, pot/migratie_0009_nota_verzending.sql), voor test/pot-verzend.sh
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
