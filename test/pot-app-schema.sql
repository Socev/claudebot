-- Schema van de tabellen in D1 `fin` die pot-app.js leest (wv1894). Overgenomen uit het live schema (export 28-10-2026), alleen CREATE-
-- statements, geen gegevens. Voor test/pot-app.sh (verzonnen toetsdata: claudebot is openbaar).
CREATE TABLE entiteit (code TEXT PRIMARY KEY, naam TEXT NOT NULL, rechtsvorm TEXT, kvk TEXT, agb TEXT, eigenaar TEXT, boekjaar TEXT DEFAULT 'kalenderjaar', vault_pad TEXT, opmerking TEXT, iban TEXT, tnv TEXT, adres TEXT, postcode_plaats TEXT, naam_document TEXT);
CREATE TABLE praktijk (id TEXT PRIMARY KEY, naam TEXT NOT NULL, naam_vorig TEXT, eigenaar TEXT, opmerking TEXT, naam_brief TEXT, tav TEXT, adres TEXT, postcode_plaats TEXT, email TEXT);
CREATE TABLE praktijk_naam (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), naam TEXT, iban TEXT, geldig_van TEXT, geldig_tot TEXT, herkomst TEXT, opmerking TEXT);
CREATE TABLE deelname (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), geldig_van TEXT, geldig_tot TEXT, regel TEXT, UNIQUE(entiteit, praktijk_id, geldig_van));
CREATE TABLE verdeelsleutel (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), soort TEXT NOT NULL, versie TEXT NOT NULL, grondslag REAL, aandeel REAL NOT NULL, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, UNIQUE(entiteit, jaar, praktijk_id, soort, versie));
CREATE TABLE begroting (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, versie TEXT NOT NULL, status TEXT DEFAULT 'concept', totaal REAL NOT NULL, termijn TEXT NOT NULL, methode TEXT, grondslag TEXT, gemaakt_op TEXT, opmerking TEXT, UNIQUE(entiteit, jaar, versie));
CREATE TABLE begroting_regel (id INTEGER PRIMARY KEY AUTOINCREMENT, begroting_id INTEGER NOT NULL REFERENCES begroting(id), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), aandeel REAL NOT NULL, jaarbedrag REAL NOT NULL, termijnbedrag REAL NOT NULL, opmerking TEXT, UNIQUE(begroting_id, praktijk_id));
CREATE TABLE bankmutatie (id INTEGER PRIMARY KEY AUTOINCREMENT, rekening TEXT NOT NULL REFERENCES bankrekening(iban), entiteit TEXT NOT NULL REFERENCES entiteit(code), boekdatum TEXT NOT NULL, bedrag REAL NOT NULL, tegenrekening TEXT, naam TEXT, omschrijving TEXT, kenmerk TEXT, banksoort TEXT, saldo_na REAL, bron_bestand TEXT, sleutel TEXT UNIQUE, bron_id INTEGER REFERENCES bron(id), geladen_op TEXT NOT NULL);
CREATE TABLE bank_toewijzing (id INTEGER PRIMARY KEY AUTOINCREMENT, bankmutatie_id INTEGER NOT NULL REFERENCES bankmutatie(id), soort TEXT NOT NULL, praktijk_id TEXT REFERENCES praktijk(id), tegen_entiteit TEXT, persoon TEXT, boekjaar INTEGER, bedrag REAL NOT NULL, herkomst TEXT, opmerking TEXT);
CREATE TABLE dienstverband_maand (id INTEGER PRIMARY KEY AUTOINCREMENT, dienstverband_id INTEGER NOT NULL REFERENCES dienstverband(id), entiteit TEXT NOT NULL REFERENCES entiteit(code), medewerker_id INTEGER NOT NULL REFERENCES medewerker(id), jaar INTEGER NOT NULL, maand INTEGER NOT NULL, in_dienst INTEGER NOT NULL, functie TEXT, contracttype TEXT, uren_week REAL, uren_voltijd REAL, deeltijdfactor REAL, cao TEXT, schaal TEXT, trede INTEGER, bruto_maand_voltijd REAL, bruto_maand_contract REAL, uren_jeugd REAL, uren_volwassen REAL, herkomst TEXT, opgebouwd_op TEXT, uren_verloond REAL, UNIQUE (dienstverband_id, jaar, maand));
CREATE TABLE controlebevinding (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT, jaar INTEGER, praktijk_id TEXT, bron TEXT, omschrijving TEXT NOT NULL, bedrag REAL, status TEXT DEFAULT 'open', besluit TEXT, aangemaakt_op TEXT, opmerking TEXT);
CREATE TABLE afrekening (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), versie TEXT NOT NULL, aandeel REAL, jaarlast_toegerekend REAL, voorschotten REAL, saldo REAL, status TEXT, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, openstaand_vorig REAL, betaald_afrekening REAL, jaarlast_totaal REAL, UNIQUE(entiteit, jaar, praktijk_id, versie));
CREATE TABLE jaarlast (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, bedrag REAL NOT NULL, bron TEXT, opmerking TEXT, ingevoerd_op TEXT, UNIQUE(entiteit, jaar));
CREATE TABLE document (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, praktijk_id TEXT REFERENCES praktijk(id), soort TEXT NOT NULL, nummer TEXT, datum TEXT, bedrag REAL, titel TEXT, bestand TEXT, status TEXT DEFAULT 'concept', gemaakt_op TEXT, UNIQUE(entiteit, jaar, praktijk_id, soort));
CREATE TABLE plan (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, versie TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'concept', termijn TEXT NOT NULL DEFAULT 'kwartaal', marge_pct REAL NOT NULL DEFAULT 0, totaal REAL, sleutel_toelichting TEXT, gemaakt_op TEXT, vastgesteld_op TEXT, opmerking TEXT, UNIQUE(entiteit, jaar, versie));
CREATE TABLE plan_post (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL REFERENCES plan(id), volgorde INTEGER NOT NULL DEFAULT 0, omschrijving TEXT NOT NULL, bedrag REAL NOT NULL, per TEXT NOT NULL DEFAULT 'jaar', aantal REAL NOT NULL DEFAULT 1, indexatie_pct REAL NOT NULL DEFAULT 0, jaarbedrag REAL NOT NULL, opmerking TEXT);
CREATE TABLE plan_deelnemer (plan_id INTEGER NOT NULL REFERENCES plan(id), praktijk_id TEXT NOT NULL REFERENCES praktijk(id), actief INTEGER NOT NULL DEFAULT 1, grondslag REAL, aandeel REAL, termijnbedrag REAL, PRIMARY KEY(plan_id, praktijk_id));
CREATE TABLE nota (id INTEGER PRIMARY KEY AUTOINCREMENT, entiteit TEXT NOT NULL REFERENCES entiteit(code), jaar INTEGER NOT NULL, nummer TEXT NOT NULL, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), datum TEXT NOT NULL, soort TEXT NOT NULL, periode TEXT, titel TEXT, regels TEXT NOT NULL, bedrag REAL NOT NULL, status TEXT NOT NULL DEFAULT 'definitief', bron TEXT, plan_id INTEGER REFERENCES plan(id), aangemaakt_op TEXT, opmerking TEXT, UNIQUE(entiteit, nummer));
CREATE TABLE praktijk_patienten (id INTEGER PRIMARY KEY AUTOINCREMENT, praktijk_id TEXT NOT NULL REFERENCES praktijk(id), peildatum TEXT NOT NULL, aantal REAL, status TEXT, bron_id INTEGER REFERENCES bron(id), opmerking TEXT, UNIQUE(praktijk_id, peildatum));
CREATE TABLE "nota_verzending" (
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
CREATE TABLE pot_pod_stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL, op TEXT NOT NULL);
CREATE INDEX idx_dvm_ent_jaar ON dienstverband_maand (entiteit, jaar, maand);
CREATE INDEX idx_bm_ent_datum ON bankmutatie(entiteit, boekdatum);
CREATE INDEX idx_bt_praktijk ON bank_toewijzing(praktijk_id, boekjaar, soort);
CREATE INDEX ix_nota_ent_jaar ON nota(entiteit, jaar);
CREATE UNIQUE INDEX nota_verzending_actief ON nota_verzending(nota_id)
  WHERE status IN ('wacht','bezig','concept','verzonden','wacht_op_adres','onzeker','auto_gevraagd','auto_vrij','verzenden','auto_verstuurd','onzeker_verzonden','verstuurd_door_david');
CREATE INDEX nota_verzending_status ON nota_verzending(status, niet_voor);
CREATE INDEX nota_verzending_nota ON nota_verzending(nota_id, id);
CREATE INDEX nota_verzending_vrijgave ON nota_verzending(vrijgave_id);
