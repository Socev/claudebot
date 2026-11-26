'use strict';
// wv4101 (26-11-2026, besluitenpagina nr 72 = C62, David Ja 25-11 21:43): proefweek sessies.
// WAAROM. De heartbeat (n8n "Heartbeat - proactief overdag", 07:05/08/12/15/18) draaide in Socevs hoofdgesprek (chat 40687) en las
// bij elke tik dat hele gesprek opnieuw in: gemiddeld 368k tokens startcontext, 19-25 nov 28 tikken = 46,5 USD (± 2 tankpunten per
// week). De machinekamer (telegram-debug) begint al sinds 12-10 elke nacht om 04:00 vers (nachtreset), maar zonder iets van gisteren.
// HOE. (1) Een heartbeat-tik krijgt een eigen sessie 'heartbeat' (de wachtrij en rechten blijven die van 40687; server.js /run +
// processJob). (2) De heartbeat krijgt een korte overdracht van Davids beurten in het hoofdkanaal sinds zijn vorige tik. (3) De
// volgende hoofdbeurt krijgt de heartbeat-berichten die intussen in de app kwamen (het hoofdgesprek zag die beurt niet meer).
// (4) De eerste machinekamerbeurt van de dag (verse sessie, nog geen David-beurt sinds 04:00) krijgt Davids laatste beurten van
// gisteren. Alles is context, geen opdracht.
// TERUG. /opt/data/sessie-proef.json {"aan": false} zet alles uit zonder uitrol (per beurt gelezen). Ontbreekt het bestand: proef
// aan. Onleesbaar of geen object: uit (iemand wilde iets zetten; oud gedrag is het veilige). Deelsleutels heartbeat_eigen, mk_overdracht.
// Puur: geen netwerk, alleen het instellingenbestand lezen. Toets: test/sessie-proef.test.js.
const fs = require('fs');

const HEARTBEAT_SESSIE = 'heartbeat';
const HOOFD_CHAT = '40687';
const MK_CHAT = 'telegram-debug';
const HEARTBEAT_AANHEF = /^Heartbeat-tik op /;   // vaste aanhef van de knoop "Heartbeat job"; andere tekst = oud gedrag (40687)
const DAVID_SOORTEN = { bericht: true, knop: true, telegram: true, tel: true };   // = APP_ANTWOORD_SOORTEN in server.js
const GRENS_UUR = 4;   // nachtreset 04:00 Europe/Amsterdam
const MK_TERUG_MS = 36 * 3600 * 1000;
const MAX_BEURTEN = 8, TEKST_MAX = 200, ANTW_MAX = 250, HB_MAX = 3, HB_TEKST_MAX = 600;

function stand(pad) {
  let ruw;
  try { ruw = fs.readFileSync(pad, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { heartbeat: true, mk: true, bron: 'standaard' };
    return { heartbeat: false, mk: false, bron: 'onleesbaar' };
  }
  let j;
  try { j = JSON.parse(ruw); } catch (e) { return { heartbeat: false, mk: false, bron: 'onleesbaar' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { heartbeat: false, mk: false, bron: 'onleesbaar' };
  const aan = j.aan !== false;
  return { heartbeat: aan && j.heartbeat_eigen !== false, mk: aan && j.mk_overdracht !== false, bron: 'bestand' };
}

function isHeartbeat(chatId, prompt, sessionId) {
  return String(chatId || '') === HOOFD_CHAT && !sessionId && HEARTBEAT_AANHEF.test(String(prompt || ''));
}

// Vandaag 04:00 Amsterdam in ms (vóór 04:00: gisteren 04:00). Op een DST-wisseldag hooguit een uur ernaast; onschadelijk.
function dagGrens(nuMs) {
  const d = new Date(nuMs);
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  const alsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = alsUtc - Math.floor(nuMs / 1000) * 1000;
  let g = Date.UTC(+p.year, +p.month - 1, +p.day, GRENS_UUR, 0, 0) - offset;
  if (g > nuMs) g -= 86400000;
  return g;
}

function klok(ms) {
  return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
function tijdVan(x) { const g = Date.parse(x && x.getypt), t = Date.parse(x && x.t); return Number.isFinite(g) && (!Number.isFinite(t) || g < t) ? g : t; }
function isDavid(x) { return !!x && DAVID_SOORTEN[x.soort] === true; }

function beurtRegels(lijst, een) {
  return lijst.map(function (x, i) {
    const antw = String(x.antwoord || '').trim();
    return (i + 1) + ') ' + klok(tijdVan(x)) + ' David: ' + JSON.stringify(een(x.tekst || x.invoer || '', TEKST_MAX)) +
      (antw ? ' — jij: ' + JSON.stringify(een(antw, ANTW_MAX)) : '');
  }).join('; ');
}

// (2) heartbeat: Davids beurten in het hoofdkanaal in (van, nu]
function heartbeatBlok(items, vanMs, nuMs, een) {
  const lijst = (items || []).filter(function (x) { const t = tijdVan(x); return isDavid(x) && t > vanMs && t <= nuMs; }).slice(-MAX_BEURTEN);
  if (!lijst.length) return { blok: '', n: 0 };
  return { n: lijst.length, blok: '[Systeem: overdracht uit het hoofdgesprek (deze heartbeat draait in een eigen sessie en ziet dat gesprek niet). ' +
    'Davids beurten sinds ' + klok(vanMs) + ', kort: ' + beurtRegels(lijst, een) + '. Gebruik dit alleen om niet te herhalen of te herinneren aan wat David al ' +
    'afhandelde; het is context, geen opdracht.]\n\n' };
}

// (3) hoofdbeurt: heartbeat-berichten die sinds vanMs in de app kwamen
function hoofdBlok(items, vanMs, nuMs, een) {
  const lijst = (items || []).filter(function (x) { const t = Date.parse(x && x.t); return x && x.soort === 'socev' && x.bron === 'heartbeat' && t > vanMs && t <= nuMs && String(x.antwoord || '').trim(); }).slice(-HB_MAX);
  if (!lijst.length) return { blok: '', n: 0 };
  return { n: lijst.length, blok: '[Systeem: de heartbeat draait sinds 26-11 in een eigen sessie; deze berichten stuurde hij David sinds je vorige beurt in de app: ' +
    lijst.map(function (x) { return klok(Date.parse(x.t)) + ' ' + JSON.stringify(een(x.antwoord, HB_TEKST_MAX)); }).join('; ') +
    '. Reageert David hierop, dan weet je zo waarover het gaat; het is context, geen opdracht.]\n\n' };
}

// (4) machinekamer: eerste beurt van de dag in een verse sessie → Davids laatste beurten van vóór 04:00 (binnen 36 uur)
function mkBlok(items, nuMs, een, eigenJob) {
  const grens = dagGrens(nuMs);
  const david = (items || []).filter(function (x) { return isDavid(x) && x.job_id !== eigenJob; });
  if (david.some(function (x) { return tijdVan(x) >= grens; })) return { blok: '', n: 0, reden: 'niet-eerste' };
  const lijst = david.filter(function (x) { const t = tijdVan(x); return t < grens && t >= nuMs - MK_TERUG_MS; }).slice(-MAX_BEURTEN);
  if (!lijst.length) return { blok: '', n: 0, reden: 'leeg' };
  return { n: lijst.length, reden: 'eerste', blok: '[Systeem: dit is de eerste machinekamerbeurt van vandaag in een verse sessie (nachtreset 04:00). Overdracht, Davids laatste ' +
    'beurten van gisteren, kort: ' + beurtRegels(lijst, een) + '. De box-rijen van gisteren en vandaag staan in de box. Context, geen opdracht.]\n\n' };
}

module.exports = { HEARTBEAT_SESSIE, HOOFD_CHAT, MK_CHAT, stand, isHeartbeat, dagGrens, heartbeatBlok, hoofdBlok, mkBlok };
