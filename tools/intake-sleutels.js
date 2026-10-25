#!/usr/bin/env node
'use strict';
/*
 * tools/intake-sleutels.js — de routesleutels van OVIS Intake aanmaken (wv1282, 25-10-2026; ontwerp aanleverprotocol § 2.5; Davids Ja op
 * punt 3 van de kaart, 25-10 17:24: "de machinekamer maakt precies deze 9 aan via de n8n-API").
 *
 * WAT. Per route één willekeurige sleutel (32 bytes, hex). De sleutel gaat in het geheugen van dit proces rechtstreeks naar n8n als Header
 * Auth-credential "OVIS Intake – <route>" (Authorization: Bearer <sleutel>); de pod bewaart alleen de sha256 in sleutels.json (0600).
 * De sleutel staat nooit in een argument, een log, een bestand of de uitvoer: die noemt alleen route, credential-id en de eerste 8
 * tekens van de hash.
 *
 * VEILIG HERHAALBAAR. Bestaat een credential met die naam al in n8n én staat de route in sleutels.json, dan niets. Staat hij maar aan één
 * kant, dan stopt het script voor die route met een melding (nooit een tweede credential met dezelfde naam, nooit een hash zonder
 * credential). Rotatie (nieuw naast oud, 24 u, dan ingetrokken) is een latere stap: --roteer bestaat bewust nog niet.
 *
 * GEBRUIK (machinekamer, in de pod): N8N_API_KEY uit de omgeving.
 *   node tools/intake-sleutels.js droog     → laat zien wat er zou gebeuren
 *   node tools/intake-sleutels.js maak      → maakt wat ontbreekt
 * Omgeving: INTAKE_DIR (standaard /opt/data/intake), N8N_API_URL (standaard https://n8n.primumnonnocere.olares.com/api/v1).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROUTES = [
  { id: 'mail', omschrijving: 'Mail Processor (beide Gmail-accounts en de scanner)', profielen: ['mail@1'], bronnen: ['gmail:david', 'gmail:groenhouten'], lezen: [] },
  { id: 'outlook', omschrijving: 'Outlook meelezen (pc-route Tolgaarde)', profielen: ['outlook-mail@1'], bronnen: ['outlook:tolgaarde'], lezen: [] },
  { id: 'whatsapp-nacht', omschrijving: 'WhatsApp Nachtextractie (NL-nummer)', profielen: ['whatsapp-dump@1', 'whatsapp-media@1'], bronnen: ['whatsapp:nl'], lezen: ['whatsapp-volglijst'] },
  { id: 'whatsapp-lezer', omschrijving: 'WhatsApp Chat Reader (media, beide nummers)', profielen: ['whatsapp-media@1'], bronnen: ['whatsapp:nl', 'whatsapp:gambia'], lezen: [] },
  { id: 'gambia', omschrijving: 'WhatsApp Gambia Weekextractie', profielen: ['whatsapp-gambia-week@1', 'whatsapp-media@1'], bronnen: ['whatsapp:gambia'], lezen: [] },
  { id: 'signal-nacht', omschrijving: 'Signal Nachtextractie', profielen: ['signal-dump@1'], bronnen: ['signal'], lezen: [] },
  { id: 'signal-lezer', omschrijving: 'Signal meelezen (alleen de volglijst lezen)', profielen: [], bronnen: [], lezen: ['signal-volglijst'] },
  { id: 'teams', omschrijving: 'Teams extractie', profielen: ['teams-dump@1'], bronnen: ['teams'], lezen: [] },
  { id: 'contacten', omschrijving: 'Contacten Sync', profielen: ['contacten-export@1'], bronnen: ['contacten:google'], lezen: [] },
];
const DIR = process.env.INTAKE_DIR || '/opt/data/intake';
const REG = path.join(DIR, 'sleutels.json');
const API = (process.env.N8N_API_URL || 'https://n8n.primumnonnocere.olares.com/api/v1').replace(/\/+$/, '');
const naamVan = (r) => 'OVIS Intake – ' + r.id;

async function n8n(methode, pad, body) {
  const key = process.env.N8N_API_KEY;
  if (!key) throw new Error('N8N_API_KEY ontbreekt in de omgeving');
  const r = await fetch(API + pad, { method: methode, headers: { 'X-N8N-API-KEY': key, 'User-Agent': 'socev-machinekamer/intake-sleutels', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(methode + ' ' + pad + ' → ' + r.status + ' ' + t.replace(/[0-9a-f]{64}/g, '…').slice(0, 200));
  return t ? JSON.parse(t) : {};
}
function leesRegister() {
  try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { versie: 1, sleutels: [] }; throw e; }
}
function schrijfRegister(reg) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = path.join(DIR, '.sleutels.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(reg, null, 1) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, REG);
}

(async function () {
  const stand = process.argv[2];
  if (stand !== 'droog' && stand !== 'maak') { process.stderr.write('gebruik: intake-sleutels.js droog|maak\n'); process.exit(2); }
  const lijst = await n8n('GET', '/credentials?limit=250');
  const bestaand = new Map((lijst.data || []).map((c) => [c.name, c]));
  const reg = leesRegister();
  let fout = 0;
  for (const r of ROUTES) {
    const inN8n = bestaand.get(naamVan(r));
    const inReg = reg.sleutels.find((s) => s.id === r.id && s.status === 'actief');
    if (inN8n && inReg) { process.stdout.write(r.id + ': bestaat al (credential ' + inN8n.id + ', hash ' + inReg.sha256.slice(0, 8) + '…)\n'); continue; }
    if (inN8n || inReg) { fout++; process.stdout.write(r.id + ': HALF (' + (inN8n ? 'wel credential, geen hash' : 'wel hash, geen credential') + ') — niets gedaan, eerst uitzoeken\n'); continue; }
    if (stand === 'droog') { process.stdout.write(r.id + ': zou aanmaken ("' + naamVan(r) + '")\n'); continue; }
    let sleutel = crypto.randomBytes(32).toString('hex');
    const c = await n8n('POST', '/credentials', { name: naamVan(r), type: 'httpHeaderAuth', data: { name: 'Authorization', value: 'Bearer ' + sleutel } });
    const hash = crypto.createHash('sha256').update(sleutel).digest('hex');
    sleutel = null;
    reg.sleutels.push({ id: r.id, sha256: hash, route: r.omschrijving, profielen: r.profielen, bronnen: r.bronnen, lezen: r.lezen, status: 'actief',
      aangemaakt: new Date().toISOString(), door: 'machinekamer wv1282 (Davids Ja 25-10 17:24, punt 3)', n8n_credential: c.id });
    schrijfRegister(reg);     // na elke route: een fout halverwege laat geen credential zonder hash achter
    process.stdout.write(r.id + ': aangemaakt (credential ' + c.id + ', hash ' + hash.slice(0, 8) + '…)\n');
  }
  process.exit(fout ? 1 : 0);
})().catch((e) => { process.stderr.write('FOUT: ' + String(e && e.message || e).replace(/[0-9a-f]{64}/g, '…').slice(0, 300) + '\n'); process.exit(1); });
