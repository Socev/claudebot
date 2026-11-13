'use strict';
/**
 * personeelsscherm.js — OVIS Personeelsscherm fase 0 (wv2991, 13-11-2026).
 *
 * WAAROM. David (13-11 in de app): een Raspberry Pi aan de tv in de personeelskamer toont personeel.socev.dev; alleen dat kastje en hij
 * (Google-inlog) komen erin; de machinekamer onderhoudt het scherm. Plan: vault 01_Ontwikkeling "OVIS Personeelsscherm - plan (Fable 5.2,
 * 13-11-2026)"; ontwerp fase 0 met Codex-review: mk-scripts/personeelsscherm/ontwerp-fase0.md (machinekamer).
 *
 * WAT. Fase 1 (wv3005, 13-11-2026, David: "ik wil niet dat iedereen zo een halve dag tegen de demo aan kijkt"): dag, klok, weer
 * (Leusden), Komende weken (HAGRO-agenda: titel, datum, tijd; plus eigen schermpunten in <dir>/punten.json) en, ALLEEN als registerrij
 * 'personeelsscherm-vast' in het toestemmingenregister op aan staat, artsen van vandaag (voornaam + dagdeel) en jarigen (voornaam, dag en
 * maand). Inhoud elke 30 min opnieuw verzameld, gepubliceerd zodra hij verandert.
 * Fase 2 (wv3015, 13-11-2026, David: "bij artsen mag de volle naam" en "extra schermen: Welzijn op Recept, highlights uit de wijk,
 * nieuws"): (1) artsen van vandaag met voor- en achternaam (ook waarnemers) ALLEEN als de tekst van de registerrij de zin VOLLE_NAAM_ZIN
 * bevat (nieuwe rij via Davids kaart); anders blijft het voornaam / "Waarnemer". (2) infoschermen: het podium wisselt (Komende weken
 * 30 s, elk infoscherm 20 s, op de wandklok zodat de meta-refresh de wissel niet terugzet). Een infoscherm komt alleen op het scherm als
 * de registerrij INFO_ZIN noemt, de set in <dir>/infoschermen.json staat EN in vragen.json van de app een Ja staat op het vraag-id van
 * precies die kaart met kaart_hash == sha256 van de kaartinhoud zoals deze module hem uit de set opbouwt (stapTekst): David keurde dus
 * deze letterlijke tekst goed. Elk scherm heeft een einddatum (tot); daarna valt het weg (pod bij de dagwissel, kastje op de wandklok).
 * Nieuws (wv3023, 13-11-2026, Davids Ja op de kaart van wv3022): paneel met de vijf nieuwste NOS-koppen (kop + tijd + "Bron: NOS"), alleen als
 * de registertekst NIEUWS_ZIN bevat; de pod haalt de feed hooguit elk kwartier (server.js o.nieuws), weg bij storing, kapotte feed of > 6 uur
 * oud; in de app aan/uit als infoscherm met vaste id NIEUWS_ID. Codex-review 3 rondes (lineaire, structuurbewuste parser). Deze module:
 *  - bouwt het scherm (één HTML-bestand, alles inline) en zet het als ondertekende envelop (Ed25519 over de exacte bytes) in D1 `personeel`;
 *    de Worker (socev-app personeel/worker.ts) geeft hem door, het kastje controleert de handtekening en het volgnr (geen terugrol);
 *    elke 6 uur opnieuw getekend, houdbaar 36 uur; de noodknop tekent meteen een zwarte envelop met een hoger volgnr;
 *  - koppelen: David opent het venster in de app (stand.koppel_open_tot, 15 min), het kastje vraagt een code, David tikt hem in met zijn
 *    vingerafdruk (server.js eist die) → hier: koppelrij claimen (voorwaardelijk), service token `personeelsscherm-pi` maken (1 jaar),
 *    Access-beleid "alleen dit token EN alleen vanaf het adres waarmee het kastje de code vroeg" (review MOET 1), token versleutelen
 *    (RSA-OAEP-SHA256) voor de sleutel van het kastje, kastje_id/kastje_ip in D1. Het token komt niet in de kluis, een log of een bericht:
 *    de enige kopie staat op het kastje. Mislukt een stap na het aanmaken, dan gaat het token meteen weer weg;
 *  - intrekken: eerst kastje_id/kastje_ip uit D1 (de Worker weigert meteen), dan Access-beleid terug naar alleen David, dan het token weg;
 *    lukt een Cloudflare-stap niet, dan blijft `intrek_open` staan en probeert de tik het opnieuw;
 *  - tik (elke 5 min, alleen primair): schema, zo nodig opnieuw tekenen, hartslag en meldingen lezen; stilte tijdens werktijd > 30 min
 *    of een verzoek met het juiste token van een ander adres → één bericht aan de machinekamer (per dag / per voorval).
 *
 * VORM. Alleen fs, path en crypto. D1 via o.d1(batch) → [{results, meta}], Cloudflare-API via o.cf(methode, pad, body) → {status, j}
 * (server.js), berichten via o.melding(sleutel, tekst). Staat in <dir>/stand.json (0600), tekensleutel <dir>/geheim/teken-ed25519.pem
 * (0600, door de machinekamer gemaakt; ontbreekt hij, dan publiceert de module niets). Nooit een token, geheim, code of IP in een log of fout.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// zelfde lijst als D1_SCHEMA in socev-app personeel/worker.ts (toets vergelijkt ze)
const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS stand (sleutel TEXT PRIMARY KEY, waarde TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS envelop (id INTEGER PRIMARY KEY CHECK (id = 1), volgnr INTEGER NOT NULL, bytes TEXT NOT NULL, sig TEXT NOT NULL, op INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS hartslag (id INTEGER PRIMARY KEY CHECK (id = 1), op INTEGER NOT NULL, json TEXT NOT NULL, ip TEXT, land TEXT, kastje_id TEXT)",
  "CREATE TABLE IF NOT EXISTS hartslag_dag (dag TEXT PRIMARY KEY, aantal INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS koppel (code_hash TEXT PRIMARY KEY, poll_hash TEXT NOT NULL, pub TEXT NOT NULL, pub_fp TEXT NOT NULL, gemaakt INTEGER NOT NULL, verloopt INTEGER NOT NULL, pogingen INTEGER NOT NULL DEFAULT 0, gebruikt INTEGER NOT NULL DEFAULT 0, cipher TEXT, land TEXT, ip TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS grens (sleutel TEXT PRIMARY KEY, aantal INTEGER NOT NULL, tot INTEGER NOT NULL)",
];
const UUR = 3600000;
const HOUDBAAR_MS = 36 * UUR;
const OPNIEUW_MS = 6 * UUR;
const VENSTER_MS = 15 * 60000;
const NA_INTIKKEN_MS = 10 * 60000;
const FOUT_MAX = 5, FOUT_VENSTER = 30 * 60000;
const STIL_MS = 30 * 60000;
const TOKEN_NAAM = 'personeelsscherm-pi';
const TOKEN_DUUR = '8760h';
const BELEID_POGINGEN = 8, BELEID_WACHT_MS = 1000;   // wv3012
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = 'personeel.socev.dev';

function iso(ms) { return new Date(ms).toISOString(); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Amsterdamse tijd zonder Intl-afhankelijkheid van de pod-locale
function amsDelen(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const d = {}; for (const p of f.formatToParts(new Date(ms))) d[p.type] = p.value;
  return { dag: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(d.weekday), uur: Number(d.hour), min: Number(d.minute), datum: `${d.year}-${d.month}-${d.day}` };
}
// werktijd: ma–vr 07:30–18:00 (Amsterdam)
function inWerktijd(ms) { const a = amsDelen(ms); const m = a.uur * 60 + a.min; return a.dag >= 0 && a.dag <= 4 && m >= 450 && m < 1080; }

// ── het scherm (fase 1, wv3005) ──
// Vast doek van 1920×1080 in px (zo klopt ook het voorbeeld in de app, die het doek zelf schaalt en geen script draait); op het kastje
// schaalt een regel script het doek naar het venster. Klok en dag lopen op het kastje zelf (inline script, CSP laat niets anders toe);
// de pod zet ze ook vast in de HTML, zodat het voorbeeld in de app (zonder script) ze toont. houdbaar_tot staat erin: de pagina valt terug
// op "wordt bijgewerkt" als de wandklok voorbij is (extra slot; het kastje beslist op zijn monotone klok, ontwerp review MOET 2).
// Leeg = zwart met een kleine klok. Vorm = mock-up 3 van het plan (vaste rand links, podium rechts), huisstijl Tolgaarde.
// inhoud = { dag_tekst, klok_tekst, weer, agenda[], artsen[]|null, jarig[]|null } (zie verzamel()); artsen/jarig null = vak weg
// (geen toestemmingsrij). Alle tekst gaat door esc().
const WD_KORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const MND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const WD_LANG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const MND_LANG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
function icoon(soort, groot) {
  const c = groot ? 'ico' : 'ico kl';
  if (soort === 'zon') return `<svg class="${c}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="11" fill="#88898C"/><path d="M26 4v7M26 41v7M4 26h7M41 26h7M10 10l5 5M37 37l5 5M42 10l-5 5M15 37l-5 5" stroke="#88898C" stroke-width="3" stroke-linecap="round"/></svg>`;
  if (soort === 'regen') return `<svg class="${c}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="19" cy="24" r="10" fill="#C9CACD"/><circle cx="31" cy="20" r="13" fill="#C9CACD"/><rect x="12" y="24" width="32" height="11" rx="5.5" fill="#C9CACD"/><path d="M19 40l-3 7M28 40l-3 7M37 40l-3 7" stroke="#88898C" stroke-width="3" stroke-linecap="round"/></svg>`;
  if (soort === 'sneeuw') return `<svg class="${c}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="19" cy="24" r="10" fill="#C9CACD"/><circle cx="31" cy="20" r="13" fill="#C9CACD"/><rect x="12" y="24" width="32" height="11" rx="5.5" fill="#C9CACD"/><circle cx="18" cy="44" r="3" fill="#88898C"/><circle cx="28" cy="44" r="3" fill="#88898C"/><circle cx="38" cy="44" r="3" fill="#88898C"/></svg>`;
  return `<svg class="${c}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="19" cy="28" r="10" fill="#C9CACD"/><circle cx="31" cy="24" r="13" fill="#C9CACD"/><rect x="12" y="28" width="32" height="11" rx="5.5" fill="#C9CACD"/></svg>`;
}
// wv3020: toon = welk paneel zonder script zichtbaar is (0 = Komende weken, k = infoscherm k; voor het voorbeeld per scherm in de app);
// een infoscherm met lab (alleen voorbeeld) toont die tekst in plaats van "Info k/n".
function bouwHtml({ gemaakt, houdbaar_tot, leeg, logoSvg, inhoud, toon }) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'";
  const klokScript = `(function(){var T=${Number(houdbaar_tot)};var D=['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'],M=['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
function z(n){return(n<10?'0':'')+n}function s(){var e=document.getElementById('doek');if(e){var f=Math.min(innerWidth/1920,innerHeight/1080);e.style.transform='scale('+f+')';}}s();addEventListener('resize',s);
function t(){var n=new Date();var k=document.getElementById('klok'),w=document.getElementById('wd'),d=document.getElementById('dag');if(k)k.textContent=z(n.getHours())+':'+z(n.getMinutes());if(w)w.textContent=D[n.getDay()];if(d)d.textContent=n.getDate()+' '+M[n.getMonth()];
if(n.getTime()>T){document.body.className='oud';}
var P=document.querySelectorAll('.paneel');if(P.length>1){var L=[],S=0,i;for(i=0;i<P.length;i++){var x=+P[i].getAttribute('data-tot')||0;if(x&&n.getTime()>x){P[i].classList.remove('aan');continue;}var u=+P[i].getAttribute('data-s')||20;L.push([P[i],S,u]);S+=u;}
var q=Math.floor(n.getTime()/1000)%S;for(i=0;i<L.length;i++){L[i][0].classList.toggle('aan',q>=L[i][1]&&q<L[i][1]+L[i][2]);}}}t();setInterval(t,1000);})();`;
  if (leeg) {
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>Personeelsscherm</title>
<style>*{cursor:none!important}html,body{margin:0;height:100%;background:#000;color:#444;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#000}#klok{position:absolute;right:38px;bottom:38px;font-size:46px}#dag,#wd{display:none}</style></head>
<body data-soort="leeg" data-gemaakt="${Number(gemaakt)}"><div id="doek"><div id="klok"></div><div id="wd"></div><div id="dag"></div></div><script>${klokScript}</script></body></html>`;
  }
  const i = inhoud || {};
  const logo = logoSvg ? `<img class="logo" alt="Huisartsenpraktijk Tolgaarde" src="data:image/svg+xml;base64,${Buffer.from(logoSvg).toString('base64')}">` : '<div class="merk"><i></i>Huisartsenpraktijk Tolgaarde</div>';
  const w = i.weer;
  const weerHtml = w && Number.isFinite(w.temp) ? `<div class="blok weer-blok"><div class="weer">${icoon(w.soort, true)}<div class="t">${esc(Math.round(w.temp))}°</div><div class="o">${esc(w.tekst || '')}${Number.isFinite(w.max) ? `<br><span class="zacht">max ${esc(Math.round(w.max))}° · min ${esc(Math.round(w.min))}°</span>` : ''}</div></div>`
    + (Array.isArray(w.dagen) && w.dagen.length ? `<div class="w3">${w.dagen.slice(0, 3).map((d) => `<div>${icoon(d.soort, false)}<span>${esc(d.wd)} ${esc(Math.round(d.max))}°</span></div>`).join('')}</div>` : '') + '</div>' : '';
  const persBlok = (lab, lijst, leegTekst, max) => lijst == null ? '' : `<div class="blok"><div class="lab">${lab}</div>${lijst.length ? lijst.slice(0, max).map((x) => `<div class="pers${x.nu ? ' nu' : ''}"><span>${esc(x.naam)}</span><span>${esc(x.wanneer)}</span></div>`).join('') : `<div class="pers leeg"><span>${leegTekst}</span></div>`}</div>`;
  const ag = Array.isArray(i.agenda) ? i.agenda.slice(0, 6) : [];
  const agHtml = ag.length ? ag.map((a) => `<div class="rij"><div class="dat"><span class="wd">${esc(a.wd)}</span><span class="dg">${esc(a.dg)}</span><span class="mn">${esc(a.mn)}</span></div><div class="wat"><div class="tt">${esc(a.titel)}</div><div class="sub">${esc(a.tijd)}</div></div><span class="chip${a.label === 'HAGRO' ? ' a' : ''}">${esc(a.label)}</span></div>`).join('')
    : '<div class="niets">Geen afspraken in de komende weken.</div>';
  // wv3015: infoschermen (alleen wat verzamel() na Davids Ja doorliet); einde van de dag 'tot' op de wandklok (CET; in de zomer hooguit een uur later)
  const info = Array.isArray(i.info) ? i.info.slice(0, INFO_MAX) : [];
  // wv3023: nieuws (NOS) als eerste paneel na Komende weken; alleen wat schermInhoud doorliet (registerzin, niet uit, ≤ 6 uur oud).
  // data-tot = nieuwste + 6 uur: ook als de pod niet meer publiceert valt het op de wandklok weg. Leeg (alleen app-voorbeeld) = uitlegregel.
  const nw = i.nieuws && typeof i.nieuws === 'object' && Array.isArray(i.nieuws.items) ? i.nieuws : null;
  const nwDag = amsDelen(Number(gemaakt) || 0).datum;
  const nPan = info.length + (nw ? 1 : 0);
  const zicht = Number.isInteger(toon) && toon >= 0 && toon <= nPan ? toon : 0;
  const nwTijd = (ms) => { const a = amsDelen(ms); return a.datum === nwDag ? String(a.uur).padStart(2, '0') + ':' + String(a.min).padStart(2, '0') : 'gisteren'; };
  const nieuwsHtml = nw ? `<section class="paneel nieuws${zicht === 1 ? ' aan' : ''}" data-s="${INFO_S}"${nw.items.length ? ` data-tot="${Number(nw.nieuwste) + NIEUWS_OUD_MS}"` : ''}><div class="ph"><h1>Nieuws</h1><div class="lab">NOS</div></div>`
    + (nw.items.length ? nw.items.slice(0, NIEUWS_N).map((x) => `<div class="nws"><span class="nt">${esc(nwTijd(x.ms))}</span><span class="nk">${esc(x.kop)}</span></div>`).join('')
      : '<div class="niets">Nu geen recent nieuws: de NOS is niet bereikbaar of het nieuwste bericht is ouder dan 6 uur. Dan staat dit scherm niet op de tv.</div>')
    + '<div class="voet">Bron: NOS</div></section>' : '';
  const infoHtml = nieuwsHtml + info.map((sc, k) => `<section class="paneel info${zicht === k + 1 + (nw ? 1 : 0) ? ' aan' : ''}" data-s="${INFO_S}" data-tot="${Date.parse(plusDag(sc.tot, 1) + 'T00:00:00+01:00')}"><div class="ph"><h1>${esc(sc.kop)}</h1><div class="lab">${sc.lab ? esc(sc.lab) : `Info ${k + 1}/${info.length}`}</div></div>`
    + (sc.intro ? `<p class="intro">${esc(sc.intro)}</p>` : '')
    + `<div class="punten">${sc.punten.map((x) => `<div class="punt"><div class="pt">${esc(x.titel)}</div>${x.tekst ? `<div class="px">${esc(x.tekst)}</div>` : ''}</div>`).join('')}</div>`
    + `<div class="voet">Bron: ${esc(sc.bron)}</div></section>`).join('');
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>Personeelsscherm</title>
<style>
*{box-sizing:border-box;cursor:none!important}
html,body{margin:0;height:100%;background:#fff;color:#5B5C60;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}
#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#fff;overflow:hidden;display:flex}
.rail{width:620px;flex:none;background:#F4F4F5;padding:44px 52px;display:flex;flex-direction:column;gap:30px;border-right:8px solid #ED1C24;overflow:hidden}
.logo{width:420px;height:auto}.merk{font-size:28px;font-weight:bold;color:#5B5C60}.merk i{display:inline-block;width:18px;height:18px;background:#ED1C24;margin-right:12px;border-radius:3px}
#wd{font-size:40px;color:#88898C;font-weight:bold}#dag{font-size:72px;font-weight:bold;color:#3E3F42;line-height:1.05}
#klok{font-size:104px;color:#3E3F42;line-height:1;letter-spacing:-2px;margin-top:10px}
.weer{display:flex;align-items:center;gap:22px}.ico{width:96px;height:96px;flex:none}.ico.kl{width:44px;height:44px}
.weer .t{font-size:76px;font-weight:bold;color:#3E3F42;line-height:1}.weer .o{font-size:30px;line-height:1.25}.zacht{color:#88898C;font-size:26px}
.w3{display:flex;gap:12px;margin-top:14px}.w3 div{flex:1;display:flex;align-items:center;gap:6px;font-size:27px;font-weight:bold;white-space:nowrap;background:#fff;border-radius:14px;padding:8px 10px}
.lab{font-size:24px;letter-spacing:3px;text-transform:uppercase;font-weight:bold;color:#88898C;margin-bottom:10px}
.pers{display:flex;flex-wrap:wrap;justify-content:space-between;column-gap:16px;font-size:34px;line-height:1.4}.pers span:last-child{margin-left:auto}.pers span:first-child{font-weight:bold;color:#3E3F42;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pers span:last-child{color:#88898C;white-space:nowrap}
.pers.nu span:last-child{color:#ED1C24;font-weight:bold}.pers.leeg span{font-weight:normal;color:#88898C;font-size:30px}
.podium{flex:1;display:flex;flex-direction:column;padding:48px 64px 32px 64px;min-width:0}
.ph{display:flex;align-items:flex-end;justify-content:space-between;border-bottom:4px solid #ED1C24;padding-bottom:18px;margin-bottom:22px}
.ph h1{font-size:64px;line-height:1;color:#3E3F42;margin:0}.ph .lab{font-size:26px;margin:0}
.rij{display:flex;align-items:center;gap:30px;padding:15px 0;border-bottom:2px solid #D9DADC}
.dat{width:200px;flex:none;display:flex;align-items:baseline;gap:8px;color:#3E3F42}.dat .wd{font-size:28px;color:#88898C;font-weight:bold;width:42px}
.dat .dg{font-size:56px;font-weight:bold;line-height:1;width:66px}.dat .mn{font-size:28px;font-weight:bold}
.wat{flex:1;min-width:0}.tt{font-size:44px;font-weight:bold;color:#3E3F42;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{font-size:30px;margin-top:2px}
.chip{display:inline-block;font-size:22px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:5px 14px;border-radius:999px;border:2px solid #D9DADC;color:#88898C;white-space:nowrap}.chip.a{border-color:#ED1C24;color:#ED1C24}
.niets{font-size:40px;color:#88898C;padding:30px 0}
.voet{margin-top:auto;padding-top:20px;font-size:24px;color:#88898C}
.paneel{display:none;flex:1;flex-direction:column;min-height:0}.paneel.aan{display:flex}
.intro{font-size:38px;line-height:1.3;color:#3E3F42;margin:4px 0 26px}
.punten{display:grid;grid-template-columns:1fr 1fr;gap:30px 44px}.punt{border-left:8px solid #ED1C24;padding:4px 0 4px 24px;min-width:0}
.pt{font-size:40px;font-weight:bold;color:#3E3F42;line-height:1.15}.px{font-size:32px;line-height:1.3;margin-top:8px}
.nws{display:flex;align-items:baseline;gap:24px;padding:16px 0;border-bottom:2px solid #D9DADC}.nt{flex:none;width:100px;font-size:30px;font-weight:bold;color:#88898C;white-space:nowrap}
.nk{flex:1;min-width:0;font-size:39px;font-weight:bold;color:#3E3F42;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.oud-tekst{display:none;font-size:44px;color:#3E3F42}body.oud .podium>*,body.oud .weer-blok,body.oud .blok{display:none}body.oud .podium .oud-tekst{display:block}
</style></head>
<body data-soort="scherm" data-gemaakt="${Number(gemaakt)}" data-houdbaar="${Number(houdbaar_tot)}">
<div id="doek"><div class="rail">${logo}<div><div id="wd">${esc(i.wd_tekst || '')}</div><div id="dag">${esc(i.dag_tekst || '')}</div><div id="klok">${esc(i.klok_tekst || '')}</div></div>
${weerHtml}${persBlok('Artsen vandaag', i.artsen, 'Geen rooster bekend', 5)}${persBlok('Jarig deze week', i.jarig, 'Niemand jarig deze week', Math.max(2, 6 - Math.min(5, (i.artsen || []).length)))}</div>
<div class="podium"><section class="paneel${zicht === 0 ? ' aan' : ''}" data-s="${INFO_HOOFD_S}"><div class="ph"><h1>Komende weken</h1><div class="lab">Agenda</div></div>${agHtml}
<div class="voet">Bijgewerkt ${esc(amsTekst(gemaakt))}</div></section>${infoHtml}<p class="oud-tekst">Dit scherm wordt bijgewerkt.</p></div></div>
<script>${klokScript}</script></body></html>`;
}

// ── inhoud verzamelen (fase 1) ──
// Bronnen (gemeten 13-11): sb_kalender_tijdlijn (feed google-hagro = HAGRO-agenda, alleen titel/datum/tijd; feed rooster-tg-artsen =
// artsenrooster Tolgaarde, hele dag, persoon in entiteiten rol 'betreft'), weer (OpenWeatherMap onecall voor Leusden via server.js),
// verjaardagen uit de medewerkerspagina's van Tolgaarde in de vault (frontmatter type medewerker + geboortedatum JJJJ-MM-DD + status).
// Persoonsvakken (artsen, jarigen) alleen als registerrij REGISTER_RIJ in het toestemmingenregister staat met status 'aan'; anders
// null (vak weg). Getoond wordt alleen een voornaam en dag/maand of dagdeel: nooit achternaam, jaar, leeftijd, titel van de roosterrij
// (kan een reden bevatten) of omschrijving/deelnemers van een afspraak.
const REGISTER_RIJ = 'personeelsscherm-vast';
const MEDEWERKERS_MAP = '10_Zakelijk/Tolgaarde/Medewerkers';
const ROOSTER_FEED = 'rooster-tg-artsen';
const AGENDA_DAGEN = 42;
const JARIG_DAGEN = 7;
const INHOUD_MS = 30 * 60000;          // inhoud opnieuw verzamelen
const WEER_MS = 2 * UUR;               // weer hooguit elke 2 uur ophalen (≤ 12 per dag)
const WEER_OUD_MS = 12 * UUR;          // ouder weer valt weg
const TITEL_WEG = /priv[eé]|vertrouwelijk|persoonlijk|patiënt|patient|ziek|verlof|vakantie|uitvaart|begrafenis|overl|condoleance|@|\d{6,}/i;
// fase 2 (wv3015)
const VOLLE_NAAM_ZIN = 'artsen van vandaag (voor- en achternaam';   // staat deze zin in de registertekst, dan volle naam
const INFO_ZIN = 'infoschermen) alleen na Davids knop';             // staat deze zin in de registertekst, dan infoschermen (met Ja per set; Fable ZOU 3)
// hooguit 28 dagen na de set: de app bewaart antwoorden 30 dagen (server.js appVragenSchrijf, APP_LOG_MS) en de Ja is het enige bewijs (Fable ZOU 2)
const INFO_MAX = 6, INFO_SET_MAX = 4, INFO_DAGEN_MAX = 28;
const INFO_HOOFD_S = 30, INFO_S = 20;
const INFO_WEG = /@|\d{6,}|\bBSN\b|geboortedatum|https?:|<|>/i;     // geen adressen, nummers of opmaak op een half openbaar scherm
// ── nieuws (wv3023, David Ja 13-11-2026 op de kaart van wv3022: "het laatste nieuws, bijvoorbeeld van nu.nl of nos.nl") ──
// De POD haalt de NOS-feed (server.js o.nieuws, nooit het kastje), hooguit elk kwartier; alleen <title> en <pubDate> van de vijf nieuwste
// items, geen link, beeld of beschrijving. Weg als het ophalen faalt, de feed kapot is of het nieuwste bericht ouder is dan 6 uur; alleen
// als de registertekst NIEUWS_ZIN bevat en David het in de app niet uitzette. Tekst van derden zonder knop per kop: daarom streng schoon.
const NIEUWS_ZIN = 'Nieuws: de vijf nieuwste koppen van de NOS (alleen kop en tijd';   // staat deze zin in de registertekst, dan het nieuwsscherm
const NIEUWS_N = 5, NIEUWS_KOP_MAX = 110, NIEUWS_MS = 15 * 60000, NIEUWS_OUD_MS = 6 * 3600000, NIEUWS_ITEM_OUD_MS = 24 * 3600000;
const NIEUWS_BYTES_MAX = 2 * 1024 * 1024, NIEUWS_TIMEOUT_MS = 20000, NIEUWS_ITEMS_MAX = 200;
const NIEUWS_ID = crypto.createHash('sha256').update('nieuws:nos').digest('hex').slice(0, 16);   // vaste id voor aan/uit in de app (zelfde vorm als schermId)
const NIEUWS_WEG = /https?:|www\.|@/i;   // een kop met een adres of link komt er niet op
function nieuwsEntiteit(m, x) {
  const vast = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  if (x[0] === '#') { const n = x[1] === 'x' || x[1] === 'X' ? parseInt(x.slice(2), 16) : parseInt(x.slice(1), 10); return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' '; }
  return Object.prototype.hasOwnProperty.call(vast, x) ? vast[x] : ' ';
}
// één kop schoon: CDATA uitpakken, entiteiten één keer omzetten, tags en losse < > weg, stuur-, opmaak- en richtingstekens weg, ≤ 110 tekens
function nieuwsKop(ruw) {
  let s = String(ruw == null ? '' : ruw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, nieuwsEntiteit);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');   // ook de inhoud van script/style weg
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || NIEUWS_WEG.test(s)) return '';
  if ([...s].length > NIEUWS_KOP_MAX) { const t = [...s].slice(0, NIEUWS_KOP_MAX - 1).join(''); const k = t.lastIndexOf(' '); s = (k > 60 ? t.slice(0, k) : t).replace(/[\s,.;:–-]+$/, '') + '…'; }
  return s;
}
// Lineair en structuurbewust (Codex MOET ronde 1 en 2, review wv3023): één doorgang met indexOf; CDATA, commentaar en <?…?> worden
// overgeslagen (dus geen "items" uit een beschrijving of commentaar); alleen de directe kinderen title en pubDate van rss>channel>item
// tellen. Elke afwijking (onafgesloten tag/CDATA/commentaar, DOCTYPE, rare tagnaam, sluittag past niet) = hele feed kapot = null.
function rssItems(xml) {
  const stapel = [], items = [];
  let i = 0, cur = null, vang = null, vangVan = 0;
  for (;;) {
    const lt = xml.indexOf('<', i); if (lt < 0) break;
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt + 9); if (e < 0) return null; i = e + 3; continue; }
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt + 4); if (e < 0) return null; i = e + 3; continue; }
    if (xml[lt + 1] === '?') { const e = xml.indexOf('?>', lt + 2); if (e < 0) return null; i = e + 2; continue; }
    if (xml[lt + 1] === '!') return null;   // DOCTYPE/ENTITY: niet in een NOS-feed, en eigen entiteiten willen we niet
    const gt = xml.indexOf('>', lt + 1); if (gt < 0) return null;
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw[0] === '/') {
      const naam = raw.slice(1).trim();
      if (stapel.pop() !== naam) return null;
      if (vang && naam === vang && stapel.length === 3) { cur[vang] = xml.slice(vangVan, lt); vang = null; }
      if (naam === 'item' && cur && stapel.length === 2) { items.push(cur); cur = null; if (items.length >= NIEUWS_ITEMS_MAX) return items; }
      continue;
    }
    const zelf = raw.endsWith('/');
    const naam = (zelf ? raw.slice(0, -1) : raw).split(/[ \t\r\n]/, 1)[0];
    if (!/^[A-Za-z_][\w:.-]{0,40}$/.test(naam)) return null;
    if (zelf) continue;
    stapel.push(naam);
    if (stapel.length === 3 && naam === 'item' && stapel[0] === 'rss' && stapel[1] === 'channel') cur = {};
    else if (cur && !vang && stapel.length === 4 && (naam === 'title' || naam === 'pubDate') && !(naam in cur)) { vang = naam; vangVan = gt + 1; }
  }
  return stapel.length === 0 ? items : null;
}
// RSS → { items: [{kop, ms}] (nieuwste eerst, ≤ 5), nieuwste } of null (geen/kapotte feed, niets bruikbaars, nieuwste > 6 uur oud)
function nieuwsKoppen(xml, t) {
  if (typeof xml !== 'string' || !xml || xml.length > NIEUWS_BYTES_MAX) return null;
  const ruw = rssItems(xml);
  if (!ruw) return null;
  const items = [];
  for (const it of ruw) {
    if (typeof it.title !== 'string' || typeof it.pubDate !== 'string' || it.title.length > 2000 || it.pubDate.length > 200) continue;
    const ms = Date.parse(nieuwsKop(it.pubDate).slice(0, 40));
    if (!Number.isFinite(ms) || ms > t + 15 * 60000 || t - ms > NIEUWS_ITEM_OUD_MS) continue;   // toekomst of > 1 dag oud: niet
    const kop = nieuwsKop(it.title);
    if (kop && !items.some((x) => x.kop === kop)) items.push({ kop, ms });
  }
  items.sort((a, b) => b.ms - a.ms);
  const top = items.slice(0, NIEUWS_N);
  if (!top.length || t - top[0].ms > NIEUWS_OUD_MS) return null;
  return { items: top, nieuwste: top[0].ms };
}
// mag dit nieuws nu op het scherm (vorm + leeftijd)?
function nieuwsGeldig(n, t) {
  return !!n && Array.isArray(n.items) && n.items.length > 0 && n.items.length <= NIEUWS_N && Number.isFinite(n.nieuwste) && t - n.nieuwste <= NIEUWS_OUD_MS
    && n.items.every((x) => x && typeof x.kop === 'string' && x.kop && [...x.kop].length <= NIEUWS_KOP_MAX && Number.isFinite(x.ms));
}
function ymd(ms) { return amsDelen(ms).datum; }
function plusDag(datum, n) { const d = new Date(datum + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function datumDelen(datum) { const d = new Date(datum + 'T12:00:00Z'); return { wd: WD_KORT[d.getUTCDay()], wdl: WD_LANG[d.getUTCDay()], dg: String(d.getUTCDate()), mn: MND_KORT[d.getUTCMonth()], mnl: MND_LANG[d.getUTCMonth()] }; }
function hhmmAms(iso) { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const a = amsDelen(t); return String(a.uur).padStart(2, '0') + ':' + String(a.min).padStart(2, '0'); }
function tijdlijnRij(x) { return x && typeof x === 'object' && x.sb_kalender_tijdlijn && !x.event_id ? x.sb_kalender_tijdlijn : x; }
function voornaamVan(naam) { const w = String(naam || '').trim().split(/\s+/)[0] || ''; return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]{0,19}$/.test(w) ? w : ''; }
function weerSoort(id) { id = Number(id) || 0; if (id >= 200 && id < 600) return 'regen'; if (id >= 600 && id < 700) return 'sneeuw'; if (id === 800) return 'zon'; return 'wolk'; }
function frontmatter(s) {
  if (!s.startsWith('---')) return {};
  const e = s.indexOf('\n---', 3); if (e < 0) return {};
  const o = {};
  for (const r of s.slice(3, e).split('\n')) { const m = /^([a-z_]+):\s*(.*)$/.exec(r); if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
  return o;
}
// medewerkers van de praktijk: [{voornaam, naam, geboren: 'MM-DD'|null, actief}] — alleen wat nodig is; de volledige naam verlaat de module niet
function leesMedewerkers(vault, vandaag) {
  if (!vault) return [];
  const map = path.join(vault, MEDEWERKERS_MAP);
  let namen = [];
  try { namen = fs.readdirSync(map).filter((f) => f.endsWith('.md')); } catch (e) { return []; }
  const uit = [];
  for (const f of namen) {
    let st; try { st = fs.lstatSync(path.join(map, f)); } catch (e) { continue; }
    if (!st.isFile() || st.size > 512 * 1024) continue;
    let fm; try { fm = frontmatter(fs.readFileSync(path.join(map, f), 'utf8')); } catch (e) { continue; }
    if (fm.type !== 'medewerker' || !fm.naam) continue;
    const vn = voornaamVan(fm.naam); if (!vn) continue;
    const status = String(fm.status || '');
    const eind = /^\d{4}-\d{2}-\d{2}$/.test(fm.einddatum || '') ? fm.einddatum : null;
    const actief = !/uit dienst|oud-|gestopt|vertrokken|beëindigd|beeindigd|overleden/i.test(status) && !(eind && eind < vandaag);
    const g = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fm.geboortedatum || '');
    uit.push({ voornaam: vn, naam: String(fm.naam).trim().toLowerCase(), geboren: g ? g[2] + '-' + g[3] : null, actief });
  }
  return uit;
}
function jarigen(meds, vandaag) {
  const schrikkel = (j) => (j % 4 === 0 && j % 100 !== 0) || j % 400 === 0;
  const uit = [], gezien = new Set();
  for (let n = 0; n < JARIG_DAGEN; n++) {
    const d = plusDag(vandaag, n), md = d.slice(5);
    for (const m of meds) {
      if (!m.actief || !m.geboren) continue;
      const mmdd = m.geboren === '02-29' && !schrikkel(Number(d.slice(0, 4))) ? '02-28' : m.geboren;
      if (mmdd !== md || gezien.has(m.voornaam + md)) continue;
      gezien.add(m.voornaam + md);
      const dd = datumDelen(d);
      uit.push({ naam: m.voornaam, wanneer: n === 0 ? 'vandaag' : dd.wd + ' ' + dd.dg + ' ' + dd.mn, nu: n === 0 });
    }
  }
  return uit;
}
function dagdeel(titel) {
  const m = /(\d{1,2})(?:[:.]\d{2})?\s*[-–]\s*(\d{1,2})/.exec(String(titel || ''));
  if (!m) return 'hele dag';
  const a = Number(m[1]), b = Number(m[2]);
  if (b <= 13 && a < 12) return 'ochtend';
  if (a >= 12) return 'middag';
  return 'hele dag';
}
function volleNaam(naam) { const n = String(naam || '').replace(/\s+/g, ' ').trim(); return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]{1,44}$/.test(n) ? n : ''; }
function artsenVandaag(rijen, vandaag, meds, vol) {
  const bekend = new Map(meds.map((m) => [m.naam, m.voornaam]));
  const uit = [], gezien = new Map();
  for (const r0 of rijen) {
    const r = tijdlijnRij(r0);
    if (!r || r.feed !== ROOSTER_FEED || r.status !== 'actief' || r.soort !== 'dienst') continue;
    if (!(String(r.begin_datum) <= vandaag && String(r.eind_datum || r.begin_datum) >= vandaag)) continue;
    const p = (Array.isArray(r.entiteiten) ? r.entiteiten : []).find((e) => e && e.rol === 'betreft');
    // vaste artsen staan met een roostercode (DS, AL, SvH, "MU 9-17 uur"), waarnemers met hun volle naam (gemeten 13-11): voornaam bij
    // een roostercode of een medewerkerspagina, anders "Waarnemer" (plan § 4)
    // code = initialen: alleen hoofdletters (DS, AL) of hoofdletter-kleine-hoofdletter (SvH, MvdW); een naam als "Hugo" of "Ed" niet (Codex MOET 1)
    const code = /^(?:[A-Z]{2,4}|[A-Z][a-z]{1,2}[A-Z])(\s|$)/.test(String(r.titel || '').trim());
    const vn = p && (bekend.get(String(p.naam || '').trim().toLowerCase()) || (code ? voornaamVan(p.naam) : ''));
    // wv3015: met de nieuwe registerrij de volle naam uit het rooster (vaste artsen én waarnemers); zonder rij zoals hierboven
    const naam = (vol && p && volleNaam(p.naam)) || vn || 'Waarnemer';
    const dd = r.hele_dag === false && r.begin_tijd ? (Number(hhmmAms(r.begin_tijd).slice(0, 2)) >= 12 ? 'middag' : 'ochtend') : dagdeel(r.titel);
    const k = (p && p.object_id) || naam + r.event_id;
    // twee diensten van dezelfde persoon: dagdelen samen (ochtend + middag = hele dag; Codex ZOU 1)
    if (gezien.has(k)) { const x = gezien.get(k); if (x.wanneer !== dd) x.wanneer = 'hele dag'; continue; }
    const x = { naam, wanneer: dd }; gezien.set(k, x); uit.push(x);
  }
  return uit.sort((a, b) => (a.naam === 'Waarnemer') - (b.naam === 'Waarnemer') || a.naam.localeCompare(b.naam, 'nl'));
}
function agendaPunten(rijen, vandaag, eigen) {
  const uit = [];
  for (const r0 of rijen) {
    const r = tijdlijnRij(r0);
    if (!r || r.status !== 'actief' || !(r.feed === 'google-hagro' || r.sync_agenda === 'hagro')) continue;
    if (!r.begin_datum || r.begin_datum < vandaag) continue;
    const t = String(r.titel || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 70 || TITEL_WEG.test(t)) continue;
    if ((Array.isArray(r.entiteiten) ? r.entiteiten : []).some((e) => e && e.rol === 'betreft')) continue;   // gaat over een persoon
    uit.push({ datum: r.begin_datum, sort: r.begin_datum + (r.hele_dag ? '00:00' : hhmmAms(r.begin_tijd)), titel: t,
      tijd: r.hele_dag ? 'hele dag' : hhmmAms(r.begin_tijd) + (r.eind_tijd ? '–' + hhmmAms(r.eind_tijd) : ''), label: 'HAGRO' });
  }
  for (const e of Array.isArray(eigen) ? eigen : []) {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.datum || '') || e.datum < vandaag || e.datum > plusDag(vandaag, AGENDA_DAGEN)) continue;
    const t = String(e.titel || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 70 || TITEL_WEG.test(t)) continue;
    const tijd = /^\d{2}:\d{2}$/.test(e.tijd || '') ? e.tijd : 'hele dag';
    uit.push({ datum: e.datum, sort: e.datum + (tijd === 'hele dag' ? '00:00' : tijd), titel: t, tijd, label: 'Praktijk' });
  }
  return uit.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0)).slice(0, 6)
    .map((a) => { const d = datumDelen(a.datum); return { wd: d.wd, dg: d.dg, mn: d.mn, titel: a.titel, tijd: a.tijd, label: a.label }; });
}
// ── infoschermen (fase 2, wv3015) ──
const schoon = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
// echte kalenderdatum JJJJ-MM-DD (geen 2026-13-45 of 2026-02-30; Fable ZOU 1)
function echteDatum(d) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false; const x = new Date(d + 'T12:00:00Z'); return !isNaN(x) && x.toISOString().slice(0, 10) === d; }
function datumNl(d) { const [j, m, dd] = String(d).split('-'); return Number(dd) + '-' + Number(m) + '-' + j; }
// één scherm uit de set, gecontroleerd op vorm (zonder datumtoets); null = ongeldig (dan is de hele set ongeldig: de kaart toonde hem)
function infoNorm(sc) {
  if (!sc || typeof sc !== 'object') return null;
  const kop = schoon(sc.kop), intro = schoon(sc.intro), bron = schoon(sc.bron), tot = String(sc.tot || '');
  const punten = Array.isArray(sc.punten) ? sc.punten.map((x) => ({ titel: schoon(x && x.titel), tekst: schoon(x && x.tekst) })) : [];
  if (!kop || kop.length > 40 || intro.length > 160 || !bron || bron.length > 130) return null;
  if (!punten.length || punten.length > 4 || punten.some((x) => !x.titel || x.titel.length > 50 || x.tekst.length > 130)) return null;
  if (!echteDatum(tot)) return null;
  if (INFO_WEG.test([kop, intro, bron].concat(...punten.map((x) => [x.titel, x.tekst])).join(' '))) return null;
  return { kop, intro, punten, bron, tot };
}
// de stap op Davids kaart: de volledige schermtekst, letterlijk
function stapTekst(sc, van) {
  return 'Infoscherm «' + sc.kop + '» van ' + datumNl(van) + ' tot en met ' + datumNl(sc.tot) + ': ' + (sc.intro ? sc.intro + ' ' : '') +
    sc.punten.map((x) => x.titel + (x.tekst ? ': ' + x.tekst : '')).join(' | ') + ' (bron: ' + sc.bron + ')';
}
// zelfde vingerafdruk als server.js appVjInhoudHash (wv3010) en toestemming.py inhoud_hash
function kaartHash(k) {
  const t = (x) => (x == null ? '' : String(x));
  return crypto.createHash('sha256').update(JSON.stringify([t(k.titel), t(k.waarom), (Array.isArray(k.stappen) ? k.stappen : []).map(t), t(k.waar), t(k.deadline)]), 'utf8').digest('hex');
}
// vraag-id van een Voor jou-kaart: FNV-1a van 'voorjou:<sleutel>:kaart' (server.js appVjKaartSleutel, toestemming.py fnv)
function fnv(t) { let h = 0x811c9dc5; for (const c of String(t)) { h = (h ^ c.codePointAt(0)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
function setKaart(set) {
  const k = (set && set.kaart) || {};
  if (!set || !echteDatum(set.set)) return null;
  const sch = Array.isArray(set.schermen) ? set.schermen.map(infoNorm) : [];
  if (!sch.length || sch.length > INFO_SET_MAX || sch.some((x) => !x || x.tot < set.set || x.tot > plusDag(set.set, INFO_DAGEN_MAX))) return null;
  return { schermen: sch, kaart: { titel: k.titel, waarom: k.waarom, stappen: sch.map((x) => stapTekst(x, set.set)).concat(Array.isArray(k.na) ? k.na.map(String) : []), waar: k.waar, deadline: k.deadline } };
}
// set geldig = vorm klopt, kaarttitel noemt infoschermen, vraag-id hoort bij de kaartsleutel en in vragen.json staat op dat id een Ja
// met de hash van precies deze kaartinhoud. Geeft de schermen (met setdatum) of null.
function setGeldig(set, vragen) {
  if (!set || typeof set !== 'object' || !/^wv\d{1,7}$/.test(String(set.sleutel || '')) || !echteDatum(set.set)) return null;
  if (fnv('voorjou:' + set.sleutel + ':kaart') !== String(set.vraag_id || '')) return null;
  const sk = setKaart(set); if (!sk || !/infoscherm/i.test(String(sk.kaart.titel || ''))) return null;
  const h = kaartHash(sk.kaart);
  const ja = vragen && typeof vragen === 'object' && Object.keys(vragen).some((key) => {
    const a = key.endsWith(':' + set.vraag_id) && vragen[key] && vragen[key].antwoord;
    return !!a && a.keuze === 'ja' && a.kaart_hash === h;
  });
  if (!ja) return null;
  return sk.schermen.map((x) => Object.assign({ set: set.set }, x));
}
// wv3020: vaste id per goedgekeurd scherm (set-sleutel + letterlijke inhoud): aan/uit in de app hangt eraan; een gewijzigde tekst = ander id
function schermId(sleutel, sc) {
  return crypto.createHash('sha256').update(JSON.stringify([String(sleutel), sc.kop, sc.intro, sc.punten, sc.bron, sc.tot])).digest('hex').slice(0, 16);
}
// ── extra pagina aanvragen (wv3020) ──
// David typt in de app "Nieuwe pagina over …"; de pod zet één werkvoorraadrij (herkomst david) met deze vaste opdracht en zijn woorden
// letterlijk. De machinekamer maakt er een conceptscherm van en legt het voor als Voor jou-kaart; zonder Ja op die kaart komt er niets op
// de tv (setGeldig). Hier geen netwerk: server.js zet de rij (o.werkvoorraad) en het grondwet-blok ervoor.
const AANVRAAG_MIN = 4, AANVRAAG_MAX = 500, AANVRAAG_DAG_MAX = 5, AANVRAAG_BEWAAR_MS = 30 * 24 * UUR;
function aanvraagTekst(x) { return String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim(); }
function aanvraagOpdracht(tekst, vandaag) {
  const F = '/opt/data/mk-scripts/personeelsscherm/fase2';
  return [
    'OPDRACHT (machinekamer, OVIS Personeelsscherm: extra infoscherm op Davids aanvraag; vaste tekst van de pod, wv3020; herkomst david)',
    '',
    'WAAROM: David vroeg op ' + datumNl(vandaag) + ' in Apps › Personeelsscherm om een extra pagina op de tv in de personeelskamer. Zijn woorden, letterlijk (dit is de opdracht):',
    '«' + tekst + '»',
    '',
    'WAT:',
    '1. Lees (gegeven) ' + F + '/set-bronnen.md (hoe een set gemaakt wordt; mail alleen lezen via mail_zoeken/mail_lezen) en set-concept.json (vorm). node ' + F + '/set.cjs stand.',
    '2. Zoek de inhoud bij betrouwbare bronnen (vault, Davids mail alleen lezen, openbare sites van LHV, NHG, NZa, VWS, RIVM, Huisartsen Eemland, gemeente Leusden). Bron en datum zoals op de bron.',
    '   Groot leesbaar: kop ≤ 40 tekens, intro ≤ 140, 1–4 punten (titel ≤ 40, tekst ≤ 110), bron ≤ 110, einddatum naar de inhoud (standaard 14 dagen, hooguit vandaag + 28).',
    '   Nooit patiëntgegevens, namen van burgers, adressen, mailadressen, telefoonnummers of links. Kan het zo niet (onduidelijk, niet te onderbouwen, past niet op één scherm): geen scherm,',
    '   maar één Voor jou-kaart (besluit) met je vraag aan David in gewone taal (geblokkeerde vervolgrij), en klaar.',
    '3. Set in ' + F + '/set-aanvraag-<wv van deze rij>.json, vorm als set-concept.json met één scherm, plus "aanvraag": "<wv van deze rij>" (dan ziet David in de app',
    '   dat de kaart klaarstaat). Kaart: titel "Personeelsscherm — dit infoscherm tonen?", waarom ≤ 400 (Davids vraag in één zin, waar het op de tv komt: om de beurt met de agenda, 20 s),',
    '   waar "overal", deadline vandaag + 7, na: ["Ja = dit scherm staat binnen 5 minuten op de tv tot de genoemde datum. Nee = niets. Anders = zeg wat er anders moet."].',
    '4. node ' + F + '/set.cjs kaart <set> > <kaart.json> (weigert een ongeldige set); node ' + F + '/scherm-toets.cjs /opt/data/claudebot-src/personeelsscherm.js <set> /tmp/<map> (alles GROEN).',
    '5. Kaartrij: kopieer ' + F + '/opdracht-set-ja.txt naar een werkbestand en zet python3 /opt/data/mk-scripts/werkvoorraad.py zet --ouder-job "$SOCEV_AGENT_RUN"',
    '   --label "machinekamer:personeelsscherm-aanvraag-ja-<wv van deze rij>" --herkomst david --prompt-bestand <werkbestand> --status geblokkeerd',
    '   --geblokkeerd-door "David: Ja op het nieuwe infoscherm" --voor-jou <kaart.json> --samenvatting "Personeelsscherm: nieuw infoscherm op jouw aanvraag ter goedkeuring."',
    '   Dan node ' + F + '/set.cjs toevoegen <set> wv<nieuw> en python3 ' + F + '/controleer.py wv<nieuw> → GELIJK (ONGELIJK = uitzoeken, niet negeren).',
    '   Zet de vraag in 00_Systeem/Open vragen aan David.md.',
    '6. Vastleggen: één regel in § Log van 01_Ontwikkeling/OVIS Personeelsscherm - plan (Fable 5.2, 13-11-2026).md en een box-rij #personeelsscherm.',
    'Rapport aan David: geen apart bericht; de kaart is het bericht. Vervolg: de kaartrij uit stap 5.',
  ].join('\n');
}
function weerBeeld(j, vandaag) {
  if (!j || typeof j !== 'object' || !j.current || !Array.isArray(j.daily)) return null;
  const c = j.current, w0 = Array.isArray(c.weather) && c.weather[0] ? c.weather[0] : {};
  const d0 = j.daily[0] || {};
  const tekst = String(w0.description || '').slice(0, 40);
  const dagen = j.daily.slice(1, 4).map((d) => ({ wd: datumDelen(ymd(Number(d.dt) * 1000 || 0)).wd, max: Number(d.temp && d.temp.max), soort: weerSoort(d.weather && d.weather[0] && d.weather[0].id) }))
    .filter((d) => Number.isFinite(d.max));
  return { temp: Number(c.temp), tekst: tekst ? tekst[0].toUpperCase() + tekst.slice(1) : '', soort: weerSoort(w0.id),
    max: Number(d0.temp && d0.temp.max), min: Number(d0.temp && d0.temp.min), dagen };
}

function amsTekst(ms) {
  const a = amsDelen(ms); const [j, m, d] = a.datum.split('-');
  return `${Number(d)}-${Number(m)}-${j} ${String(a.uur).padStart(2, '0')}:${String(a.min).padStart(2, '0')}`;
}

function maak(o) {
  const dir = o.dir;
  const nu = o.nu || Date.now;
  const fout = o.fout || function () {};
  const melding = o.melding || async function () {};
  const standPad = path.join(dir, 'stand.json');
  const sleutelPad = path.join(dir, 'geheim', 'teken-ed25519.pem');
  const configPad = path.join(dir, 'config.json');   // {account, access_app_id, access_app (zonder beleid), eigenaar} — door de machinekamer
  let schemaKlaar = false;

  function leesStand() { try { return JSON.parse(fs.readFileSync(standPad, 'utf8')); } catch (e) { return {}; } }
  function schrijfStand(s) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = standPad + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, standPad);
  }
  function wijzig(f) { const s = leesStand(); f(s); schrijfStand(s); return s; }
  function config() { try { return JSON.parse(fs.readFileSync(configPad, 'utf8')); } catch (e) { return null; } }
  function sleutel() { try { return crypto.createPrivateKey(fs.readFileSync(sleutelPad)); } catch (e) { return null; } }
  function logoSvg() {
    if (!o.vault) return null;
    try { const s = fs.readFileSync(path.join(o.vault, '.claude/skills/tolgaarde-brand-communication/assets/huisstijl-v1/Tolgaarde_horizontaal.svg'), 'utf8'); return /^<svg[\s>]/.test(s.trim()) && !/<script|on\w+=|href=/i.test(s) ? s : null; } catch (e) { return null; }
  }

  async function d1(batch) {
    const r = await o.d1(batch);
    if (!Array.isArray(r) || r.length !== batch.length) throw new Error('D1 gaf een onverwacht antwoord');
    return r;
  }
  async function zorgSchema() { if (!schemaKlaar) { await d1(D1_SCHEMA.map((sql) => ({ sql, params: [] }))); schemaKlaar = true; } }
  async function cf(methode, pad, body) {
    const r = await o.cf(methode, pad, body);
    if (!r || r.status < 200 || r.status >= 300 || !r.j || r.j.success !== true) {
      const code = r && r.j && Array.isArray(r.j.errors) && r.j.errors[0] ? r.j.errors[0].code : '';
      const e = new Error('Cloudflare gaf HTTP ' + (r ? r.status : '?') + (code ? ' (' + code + ')' : ''));
      e.status = r ? r.status : 0; e.cfCode = code; throw e;
    }
    return r.j.result;
  }

  // ── inhoud (fase 1) ──
  const registerPad = o.registerPad || '/opt/data/mk-scripts/toestemmingen.json';
  // registerrij aan? Alleen die bron telt (grondwet, alinea TOESTEMMINGEN); onleesbaar = uit
  function registerRij() {
    try { const r = JSON.parse(fs.readFileSync(registerPad, 'utf8')); return (r && Array.isArray(r.rijen) && r.rijen.find((x) => x && x.id === REGISTER_RIJ && x.status === 'aan')) || null; }
    catch (e) { return null; }
  }
  function toestemming() { return !!registerRij(); }
  // wv3015: wat de tekst van de rij toestaat (bij verschil geldt de tekst, registerkop)
  function rijMag(zin) { const r = registerRij(); return !!r && Array.isArray(r.tekst) && r.tekst.map(String).join(' ').replace(/\s+/g, ' ').includes(zin); }
  const volleNaamMag = () => rijMag(VOLLE_NAAM_ZIN);
  const infoMag = () => rijMag(INFO_ZIN);
  const vragenPad = o.vragenPad || '/opt/data/socev-app-data/vragen.json';
  const infoPad = path.join(dir, 'infoschermen.json');
  function infoBestand() { try { return fs.readFileSync(infoPad, 'utf8'); } catch (e) { return ''; } }
  // Fable ZOU 4: de uitkomst telt (set + rij + Ja in vragen.json), niet alleen het bestand: een Ja of een weggevallen Ja werkt bij de volgende tik
  const infoBestandSha = (vandaag) => crypto.createHash('sha256').update(JSON.stringify(infoSchermen(vandaag))).digest('hex');
  // goedgekeurde infoschermen van vandaag (zie setGeldig), ook die David in de app uitzette; alles onleesbaar = geen.
  // wv3020: elk met id (schermId) en de set-sleutel; aanvraag = het wv-nummer van Davids aanvraag als de set daaruit kwam
  function infoKandidaten(vandaag) {
    if (!infoMag()) return [];
    let j, vr;
    try { j = JSON.parse(infoBestand() || '{}'); vr = JSON.parse(fs.readFileSync(vragenPad, 'utf8')); } catch (e) { return []; }
    const uit = [];
    for (const set of Array.isArray(j && j.sets) ? j.sets : []) {
      let g = null; try { g = setGeldig(set, vr); } catch (e) { g = null; }
      if (!g) continue;
      for (const x of g) if (x.set <= vandaag && x.tot >= vandaag) uit.push(Object.assign({ id: schermId(set.sleutel, x), sleutel: set.sleutel }, x));
    }
    return uit;
  }
  // wv3020: wat David in de app uitzette (stand.info_uit, op id) blijft van de tv tot hij het weer aanzet of het scherm verloopt
  const uitLijst = () => { const u = leesStand().info_uit; return u && typeof u === 'object' ? u : {}; };
  // vrijgegeven infoschermen van vandaag die op de tv horen: goedgekeurd, binnen de looptijd, niet uitgezet; hooguit INFO_MAX (de nieuwste)
  function infoSchermen(vandaag) {
    const u = uitLijst();
    return infoKandidaten(vandaag).filter((x) => !u[x.id]).slice(-INFO_MAX);
  }
  // ── nieuws (wv3023) ──
  const nieuwsMag = () => rijMag(NIEUWS_ZIN);
  const nieuwsActief = () => nieuwsMag() && !uitLijst()[NIEUWS_ID];
  const nieuwsTimeout = Number(o.nieuwsTimeoutMs) > 0 ? Number(o.nieuwsTimeoutMs) : NIEUWS_TIMEOUT_MS;
  const nieuwsBinnenKwartier = (s, t) => !!s.nieuws_poging && t >= s.nieuws_poging && t - s.nieuws_poging < NIEUWS_MS;
  // hooguit elk kwartier één poging (ook een mislukte telt); mislukt of oud = null (scherm weg), geen terugval op een oudere kop.
  // Zet s.nieuws/s.nieuws_poging (verzamel schrijft ze weg). Niet actief (geen zin, of uit in de app) = niets ophalen.
  async function nieuwsVers(s, t) {
    if (!nieuwsActief()) return null;
    if (nieuwsBinnenKwartier(s, t)) return nieuwsGeldig(s.nieuws, t) ? s.nieuws : null;
    s.nieuws_poging = t; s.nieuws = null;
    if (typeof o.nieuws !== 'function') return null;
    let klok = null;
    try {
      const xml = await Promise.race([Promise.resolve().then(() => o.nieuws()), new Promise((_, nee) => { klok = setTimeout(() => nee(new Error('timeout')), nieuwsTimeout); })]);
      const n = nieuwsKoppen(xml, t);
      if (n) s.nieuws = n;   // zonder ophaaltijd: dezelfde koppen = dezelfde inhoud = geen nieuwe envelop
    } catch (e) { fout('personeelsscherm-nieuws', new Error('nieuws ophalen faalde')); }   // nooit de inhoud of het adres in de fout
    finally { if (klok) clearTimeout(klok); }
    return s.nieuws;
  }
  function eigenPunten() { try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'punten.json'), 'utf8')); return Array.isArray(j) ? j : []; } catch (e) { return []; } }
  async function weerVers(s, t) {
    if (s.weer && s.weer_op && t - s.weer_op < WEER_MS) return s.weer;
    if (typeof o.weer !== 'function') return null;
    try { const b = weerBeeld(await o.weer(), ymd(t)); if (b && Number.isFinite(b.temp)) { s.weer = b; s.weer_op = t; return b; } } catch (e) { fout('personeelsscherm-weer', new Error('weer ophalen faalde')); }
    return s.weer && s.weer_op && t - s.weer_op < WEER_OUD_MS ? s.weer : null;
  }
  // Verzamelt alle vakken. Mislukt de agenda, dan blijft het vak zoals het was (plan § 5); persoonsvakken alleen met de registerrij.
  async function verzamel(t) {
    const s = leesStand(), vandaag = ymd(t), oud = s.inhoud || {};
    const aan = toestemming(), vol = aan && volleNaamMag();
    let rijen = null;
    if (typeof o.tijdlijn === 'function') {
      try { const r = await o.tijdlijn(vandaag, plusDag(vandaag, AGENDA_DAGEN)); if (Array.isArray(r)) rijen = r; else throw new Error('x'); }
      catch (e) { fout('personeelsscherm-agenda', new Error('tijdlijn lezen faalde')); }
    }
    const meds = aan ? leesMedewerkers(o.vault, vandaag) : [];
    const weer = await weerVers(s, t);
    const nieuws = aan ? await nieuwsVers(s, t) : null;   // wv3023
    const inhoud = {
      datum: vandaag,
      weer: weer || null,
      agenda: rijen ? agendaPunten(rijen, vandaag, eigenPunten()) : (Array.isArray(oud.agenda) ? oud.agenda : []),
      artsen: aan ? (rijen ? artsenVandaag(rijen, vandaag, meds, vol) : (oud.datum === vandaag && Array.isArray(oud.artsen) && !!oud.volle_naam === vol ? oud.artsen : [])) : null,
      jarig: aan ? jarigen(meds, vandaag) : null,
      persoonsvakken: aan,
      volle_naam: vol,
      info: aan ? infoSchermen(vandaag) : [],
      nieuws: nieuws || null,
      bronnen: { agenda: !!rijen, weer: !!weer, medewerkers: aan ? meds.length : null },
    };
    inhoud.bronnen.info = inhoud.info.length;
    inhoud.bronnen.nieuws = nieuws ? nieuws.items.length : 0;
    const ish = crypto.createHash('sha256').update(JSON.stringify(inhoud.info)).digest('hex');
    wijzig((x) => { x.inhoud = inhoud; x.inhoud_op = t; x.weer = s.weer || null; x.weer_op = s.weer_op || null; x.info_sha = ish;
      if (s.nieuws_poging) { x.nieuws = s.nieuws || null; x.nieuws_poging = s.nieuws_poging; } });
    return inhoud;
  }
  // vaste delen van het moment (voorbeeld zonder script): dag en klok in Amsterdamse tijd
  function schermInhoud(s, t) {
    const a = amsDelen(t), d = datumDelen(a.datum);
    const i = s.inhoud && s.inhoud.datum === a.datum ? s.inhoud : Object.assign({}, s.inhoud || {}, { artsen: s.inhoud && s.inhoud.artsen ? [] : null, jarig: s.inhoud && s.inhoud.jarig ? [] : null });
    // persoonsvakken nooit zonder rij, ook niet uit een oude stand
    const aan = toestemming();
    // wv3015: volle namen nooit zonder de zin in de rij (ook niet uit een oude stand); infoschermen alleen met de rij en vóór hun einddatum
    const artsen = aan && i.artsen && !!i.volle_naam && !volleNaamMag() ? [] : i.artsen;
    // Fable ZOU 4: bij elke publicatie (ook noodknop uit) opnieuw tegen de Ja, niet uit de stand
    const info = aan ? infoSchermen(a.datum) : [];
    // wv3023: nieuws bij elke publicatie opnieuw tegen registerzin, uit-knop en leeftijd (nooit uit een oude stand doorgeschoven)
    const nieuws = aan && nieuwsActief() && nieuwsGeldig(i.nieuws, t) ? i.nieuws : null;
    return Object.assign({}, i, { artsen: aan ? artsen : null, jarig: aan ? i.jarig : null, info, nieuws,
      wd_tekst: d.wdl, dag_tekst: d.dg + ' ' + d.mnl, klok_tekst: String(a.uur).padStart(2, '0') + ':' + String(a.min).padStart(2, '0') });
  }
  function inhoudSha(i) { const c = Object.assign({}, i || {}); delete c.bronnen; return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'); }

  // ── envelop ──
  function envelop(s, t, leeg) {
    const volgnr = Math.max(Number(s.volgnr || 0) + 1, t);
    const doc = { v: 1, soort: 'scherm', volgnr, gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg,
      html: bouwHtml({ gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg, logoSvg: leeg ? null : logoSvg(), inhoud: leeg ? null : schermInhoud(s, t) }),
      instellingen: { ophaal_s: 120 }, code: null };
    const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
    return { doc, bytes };
  }
  async function publiceer(leeg) {
    const k = sleutel();
    if (!k) throw new Error('geen tekensleutel');
    await zorgSchema();
    const s = leesStand(), t = nu();
    const aan = leeg === undefined ? !!s.leeg : !!leeg;
    const { doc, bytes } = envelop(s, t, aan);
    if (bytes.length > 900 * 1024) throw new Error('scherm te groot');
    const sig = crypto.sign(null, bytes, k);
    await d1([{ sql: 'INSERT INTO envelop (id, volgnr, bytes, sig, op) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET volgnr = excluded.volgnr, bytes = excluded.bytes, sig = excluded.sig, op = excluded.op WHERE excluded.volgnr > envelop.volgnr',
      params: [doc.volgnr, bytes.toString('base64'), sig.toString('base64'), t] }]);
    // wv3020: een knop in de app en de tik kunnen tegelijk publiceren; D1 houdt het hoogste volgnr, de stand ook
    wijzig((x) => { if (Number(x.volgnr || 0) > doc.volgnr) return; x.volgnr = doc.volgnr; x.gemaakt = t; x.houdbaar_tot = doc.houdbaar_tot; x.leeg = aan; x.html = doc.html; x.fout = null; x.inhoud_sha = inhoudSha(s.inhoud); });
    return doc;
  }

  // ── Access ──
  function appBody(c, token) {
    const pol = [{ name: 'Eigenaar (Google of code per mail)', decision: 'allow', precedence: 1, include: [{ email: { email: c.eigenaar } }] }];
    if (token) pol.push({ name: 'Alleen het kastje ' + TOKEN_NAAM + ' vanaf het praktijkadres', decision: 'non_identity', precedence: 2,
      include: [{ service_token: { token_id: token.id } }], require: [{ ip: { ip: token.ip + '/32' } }] });
    return Object.assign({}, c.access_app, { policies: pol });
  }
  // wv3012: een net gemaakt service token is bij Cloudflare niet meteen bekend; PUT geeft dan 400/12130 'service token not found'.
  // Daarom met token tot 8 keer opnieuw (oplopend, samen ± 30 s); zonder token (terugzetten) één keer.
  async function zetBeleid(c, token) {
    const pad = '/accounts/' + c.account + '/access/apps/' + c.access_app_id;
    for (let i = 0; ; i++) {
      try { await cf('PUT', pad, appBody(c, token)); return; }
      catch (e) { if (!token || i >= BELEID_POGINGEN - 1 || !(e.status === 400 && String(e.cfCode) === '12130')) throw e; await slaap(BELEID_WACHT_MS * (i + 1)); }
    }
  }
  async function tokenWeg(c, id) {
    try { await cf('DELETE', '/accounts/' + c.account + '/access/service_tokens/' + id); }
    catch (e) { if (e.status !== 404 && e.cfCode !== 12135) throw e; }   // al weg = goed
  }

  // ── app-handelingen (server.js doet sessie, vingerafdruk en grenzen) ──
  async function open() {
    await zorgSchema();
    const tot = nu() + VENSTER_MS;
    await d1([{ sql: "INSERT INTO stand (sleutel, waarde) VALUES ('koppel_open_tot', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [String(tot)] }]);
    wijzig((x) => { x.koppel_open_tot = tot; });
    return { status: 200, body: { ok: true, koppel_open_tot: tot } };
  }

  // wv3020: infoscherm uit (meteen van de tv: nieuwe getekende envelop, zonder vingerafdruk, zoals de noodknop) of weer aan (server.js eist
  // een verse vingerafdruk; hier: alleen een scherm dat nu goedgekeurd is en binnen zijn looptijd valt, dus nooit nieuwe tekst)
  async function infoZet(idRuw, aan) {
    const id = String(idRuw == null ? '' : idRuw);
    if (!/^[0-9a-f]{16}$/.test(id)) return { status: 400, body: { ok: false, fout: 'Onbekend scherm.' } };
    const vandaag = ymd(nu());
    // wv3023: het nieuwsscherm heeft een vaste id; kandidaat zolang de registerzin er staat (uit blijft uit tot David het weer aanzet)
    const x = id === NIEUWS_ID ? (toestemming() && nieuwsMag() ? { tot: '9999-12-31' } : null) : infoKandidaten(vandaag).find((y) => y.id === id);
    if (aan && !x) return { status: 409, body: { ok: false, fout: 'Dit scherm kan niet meer aan: het is niet (meer) door jou goedgekeurd of de looptijd is voorbij.' } };
    if (!aan && !x && !uitLijst()[id]) return { status: 404, body: { ok: false, fout: 'Dit scherm staat niet (meer) op de tv.' } };
    wijzig((s) => {
      const u = s.info_uit && typeof s.info_uit === 'object' ? s.info_uit : {};
      for (const k of Object.keys(u)) if (!u[k] || !(String(u[k].tot) >= vandaag)) delete u[k];   // verlopen = weg
      if (aan) delete u[id]; else u[id] = { op: nu(), tot: x ? x.tot : vandaag };
      s.info_uit = u;
      if (id === NIEUWS_ID) { s.nieuws_poging = null; if (!aan) s.nieuws = null; }   // wv3023: aan = de volgende tik haalt meteen vers; uit = niets bewaren
    });
    try { await publiceer(); }
    catch (e) {
      fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80)));
      return { status: 503, body: { ok: false, fout: (aan ? 'Aangezet' : 'Uitgezet') + ', maar de tv is nog niet bijgewerkt; dat probeer ik binnen 5 minuten opnieuw.' } };
    }
    return { status: 200, body: { ok: true, id, aan: !!aan } };
  }
  let aanvraagBezig = false;
  async function aanvraag(ruw) {
    const tekst = aanvraagTekst(ruw);
    if (tekst.length < AANVRAAG_MIN) return { status: 400, body: { ok: false, fout: 'Schrijf waar de nieuwe pagina over moet gaan.' } };
    if (tekst.length > AANVRAAG_MAX) return { status: 400, body: { ok: false, fout: 'Houd het korter (hooguit ' + AANVRAAG_MAX + ' tekens).' } };
    if (typeof o.werkvoorraad !== 'function') return { status: 503, body: { ok: false, fout: 'Aanvragen kan in deze versie nog niet.' } };
    const t = nu(), dag = ymd(t);
    const lijst = (leesStand().aanvragen || []).filter((a) => a && t - a.op < AANVRAAG_BEWAAR_MS);
    const al = lijst.find((a) => ymd(a.op) === dag && String(a.tekst).toLowerCase() === tekst.toLowerCase());
    if (al) return { status: 200, body: { ok: true, al: true } };
    if (lijst.filter((a) => ymd(a.op) === dag).length >= AANVRAAG_DAG_MAX) return { status: 429, body: { ok: false, fout: 'Vandaag heb je al ' + AANVRAAG_DAG_MAX + ' pagina\'s aangevraagd; morgen kan het weer.' } };
    if (aanvraagBezig) return { status: 409, body: { ok: false, fout: 'Er gaat net een aanvraag weg; probeer het zo opnieuw.' } };
    aanvraagBezig = true;
    try {
      const label = 'machinekamer:personeelsscherm-aanvraag-' + dag.replace(/-/g, '') + '-' + crypto.createHash('sha256').update(tekst.toLowerCase()).digest('hex').slice(0, 8);
      let z;
      try { z = await o.werkvoorraad({ label, prompt: aanvraagOpdracht(tekst, dag), samenvatting: ('Personeelsscherm: David vraagt een extra pagina — ' + tekst).slice(0, 200), notitie: 'pod wv3020: Apps › Personeelsscherm, Nieuwe pagina' }); }
      catch (e) { fout('personeelsscherm-aanvraag', new Error('werkvoorraad: ' + String(e && e.message).slice(0, 60))); z = null; }
      if (!z || !/^\d{1,7}$/.test(String(z.id))) return { status: 503, body: { ok: false, fout: 'De aanvraag kon niet worden doorgegeven; probeer het zo opnieuw.' } };
      wijzig((s) => { s.aanvragen = (s.aanvragen || []).filter((a) => a && t - a.op < AANVRAAG_BEWAAR_MS).concat([{ op: t, tekst, wv: Number(z.id) }]).slice(-20); });
      return { status: 200, body: { ok: true, al: !!z.bestond } };
    } finally { aanvraagBezig = false; }
  }
  // wv3020: elk scherm apart voor de app (bladeren): Komende weken = de envelop zelf (voorbeeld_html); elk goedgekeurd infoscherm met zijn
  // eigen voorbeeld (zelfde doek, dat paneel zichtbaar), looptijd en of het op de tv staat. Aanvragen met hun stand: wacht (nog geen
  // concept), kaart (concept ligt in Voor jou), aan (goedgekeurd).
  function appSchermen(s, t) {
    const vandaag = ymd(t), kand = infoKandidaten(vandaag), u = uitLijst();
    const opTv = infoSchermen(vandaag).map((x) => x.id);
    const inh = schermInhoud(s, t);
    const lijst = [{ id: 'hoofd', soort: 'hoofd', titel: 'Komende weken', looptijd_s: opTv.length || inh.nieuws ? INFO_HOOFD_S : null, aan: true, uit: false }];
    // wv3023: nieuwsscherm (alleen met de registerzin); voorbeeld met de koppen die nu op de tv staan, of de uitlegregel als er geen vers nieuws is
    if (toestemming() && nieuwsMag()) {
      lijst.push({ id: NIEUWS_ID, soort: 'info', titel: 'Nieuws (NOS)', looptijd_s: INFO_S, van: null, tot: null, aan: !!inh.nieuws, uit: !!u[NIEUWS_ID],
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [], nieuws: inh.nieuws || { items: [] } }), toon: 1 }) });
    }
    for (const x of kand) {
      const k = opTv.indexOf(x.id);
      const sc = Object.assign({}, x, { lab: k >= 0 ? 'Info ' + (k + 1) + '/' + opTv.length : (u[x.id] ? 'Staat uit' : 'Wacht op een plek') });
      lijst.push({ id: x.id, soort: 'info', titel: x.kop, looptijd_s: INFO_S, van: x.set, tot: x.tot, aan: k >= 0, uit: !!u[x.id],
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [sc], nieuws: null }), toon: 1 }) });
    }
    let sets = [], vr = {};
    try { const j = JSON.parse(infoBestand() || '{}'); sets = Array.isArray(j.sets) ? j.sets : []; vr = JSON.parse(fs.readFileSync(vragenPad, 'utf8')); } catch (e) { /* stand blijft wacht */ }
    const aanvragen = (s.aanvragen || []).filter((a) => a && t - a.op < AANVRAAG_BEWAAR_MS).slice(-10).reverse().map((a) => {
      const bij = sets.filter((x) => x && String(x.aanvraag || '') === 'wv' + a.wv);
      let geldig = false; try { geldig = bij.some((x) => !!setGeldig(x, vr)); } catch (e) { geldig = false; }
      return { op: a.op, tekst: a.tekst, stand: geldig ? 'aan' : bij.length ? 'kaart' : 'wacht' };
    });
    return { schermen: lijst, aanvragen };
  }

  let bezig = false;   // één koppeling of intrekking tegelijk
  async function koppel(codeRuw) {
    const code = String(codeRuw == null ? '' : codeRuw).replace(/[\s-]/g, '');
    if (!/^\d{8}$/.test(code)) return { status: 400, body: { ok: false, fout: 'De code bestaat uit 8 cijfers.' } };
    const c = config();
    if (!c || !c.account || !c.access_app_id || !c.access_app || !c.eigenaar) return { status: 503, body: { ok: false, fout: 'Het personeelsscherm is nog niet ingericht; meld het de machinekamer.' } };
    const t0 = nu();
    const s0 = leesStand();
    const fouten = (s0.foutcodes || []).filter((x) => x > t0 - FOUT_VENSTER);
    if (fouten.length >= FOUT_MAX) return { status: 429, body: { ok: false, fout: 'Te vaak een verkeerde code. Probeer het over een half uur opnieuw.' } };
    if (bezig) return { status: 409, body: { ok: false, fout: 'Er loopt al een koppeling; wacht even.' } };
    bezig = true;
    try {
      await zorgSchema();
      const ch = crypto.createHash('sha256').update('code:' + code).digest('hex');
      const r = await d1([{ sql: 'UPDATE koppel SET gebruikt = 1, verloopt = ? WHERE code_hash = ? AND gebruikt = 0 AND verloopt > ? RETURNING pub, ip, gemaakt', params: [t0 + NA_INTIKKEN_MS, ch, t0] }]);
      const rij = r[0] && r[0].results && r[0].results[0];
      if (!rij) {
        wijzig((x) => { x.foutcodes = (x.foutcodes || []).filter((y) => y > t0 - FOUT_VENSTER).concat([t0]); });
        return { status: 404, body: { ok: false, fout: 'Deze code ken ik niet of hij is verlopen. Kijk op de tv of er een nieuwe code staat.' } };
      }
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(rij.ip || ''))) return { status: 409, body: { ok: false, fout: 'Het kastje vroeg de code niet via een gewoon internetadres aan; meld het de machinekamer.' } };
      let pub;
      try { pub = crypto.createPublicKey(String(rij.pub)); if (pub.asymmetricKeyType !== 'rsa' || pub.asymmetricKeyDetails.modulusLength !== 3072) throw new Error('x'); }
      catch (e) { return { status: 409, body: { ok: false, fout: 'De sleutel van het kastje klopt niet; zet het kastje uit en aan voor een nieuwe code.' } }; }
      // een vorig kastje gaat eerst helemaal dicht
      if (s0.token || s0.intrek_open) await intrekIntern(c);
      let stap = 'token maken';
      const vrijgeven = async (e) => {   // wv3012: melding bewaren (logError logt alleen name/code; code = melding, zonder geheimen) en code vrijgeven
        const mld = ('stap ' + stap + ': ' + String(e && e.message)).replace(/[^\w .:()'\/-]/g, '').slice(0, 120);
        const fe = new Error('koppelen faalde'); fe.code = mld; fout('personeelsscherm-koppel', fe);
        wijzig((x) => { x.laatste_koppelfout = { op: t0, melding: mld }; });
        try { await d1([{ sql: 'UPDATE koppel SET gebruikt = 0, verloopt = ? WHERE code_hash = ? AND gebruikt = 1 AND cipher IS NULL', params: [nu() + NA_INTIKKEN_MS, ch] }]); }
        catch (e2) { fout('personeelsscherm-koppel', new Error('code vrijgeven faalde')); }
        return { status: 503, body: { ok: false, fout: 'Koppelen lukte niet (' + mld + '). Er is niets blijven staan; tik dezelfde code nog eens in.' } };
      };
      let tk;
      try { tk = await cf('POST', '/accounts/' + c.account + '/access/service_tokens', { name: TOKEN_NAAM, duration: TOKEN_DUUR }); }
      catch (e) { return await vrijgeven(e); }
      const token = { id: tk.id, client_id: tk.client_id, ip: String(rij.ip), aangemaakt: t0, verloopt: tk.expires_at ? Date.parse(tk.expires_at) : t0 + 365 * 24 * UUR };
      let geheim = tk.client_secret; tk.client_secret = undefined;
      try {
        stap = 'token controleren';
        if (!token.id || !/^[a-z0-9]{20,64}\.access$/.test(String(token.client_id || '')) || !/^[A-Za-z0-9._-]{32,200}$/.test(String(geheim || ''))) throw new Error('onverwacht token');
        stap = 'beleid';
        await zetBeleid(c, token);
        stap = 'opslaan';
        const cipher = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(JSON.stringify({ client_id: token.client_id, client_secret: geheim }), 'utf8')).toString('base64');
        geheim = null;
        await d1([
          { sql: 'UPDATE koppel SET cipher = ? WHERE code_hash = ? AND gebruikt = 1', params: [cipher, ch] },
          { sql: "INSERT INTO stand (sleutel, waarde) VALUES ('kastje_id', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [token.client_id] },
          { sql: "INSERT INTO stand (sleutel, waarde) VALUES ('kastje_ip', ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde", params: [token.ip] },
          { sql: "DELETE FROM stand WHERE sleutel IN ('koppel_open_tot', 'vreemd')", params: [] },
        ]);
      } catch (e) {
        geheim = null;
        try { await zetBeleid(c, null); } catch (e2) { fout('personeelsscherm-koppel', new Error('beleid terugzetten faalde')); }
        try { await tokenWeg(c, token.id); } catch (e2) { wijzig((x) => { x.intrek_open = { id: token.id }; }); }
        return await vrijgeven(e);
      }
      wijzig((x) => { x.token = { id: token.id, client_id: token.client_id, ip_eis: true, aangemaakt: token.aangemaakt, verloopt: token.verloopt };   // het adres zelf staat alleen in D1 en het Access-beleid
        x.koppel_open_tot = null; x.vreemd = null; x.foutcodes = []; x.gekoppeld_op = t0; x.stil_gemeld = null; });
      try { await melding('personeelsscherm-koppel:' + token.id, 'Personeelsscherm: kastje gekoppeld (' + iso(t0).slice(0, 16) + ' UTC). Sleutel ' + TOKEN_NAAM + ' (id ' + token.id + ') verloopt ' + iso(token.verloopt).slice(0, 10) + ', werkt alleen vanaf het adres waarmee de code werd aangevraagd. Zet de rij in het sleutelregister.'); } catch (e) { fout('personeelsscherm-melding', e); }
      try { if (!leesStand().gemaakt) await publiceer(); } catch (e) { fout('personeelsscherm-publiceer', e); }
      return { status: 200, body: { ok: true, gekoppeld: true } };
    } finally { bezig = false; }
  }

  async function intrekIntern(c) {
    const s = leesStand();
    // 1. de Worker weigert meteen
    await d1([{ sql: "DELETE FROM stand WHERE sleutel IN ('kastje_id', 'kastje_ip')", params: [] }]);
    wijzig((x) => { x.intrek_open = x.intrek_open || (x.token ? { id: x.token.id } : null); x.token = null; });
    // 2. Access terug naar alleen de eigenaar, 3. token weg
    await zetBeleid(c, null);
    const id = (s.token && s.token.id) || (s.intrek_open && s.intrek_open.id);
    if (id) await tokenWeg(c, id);
    wijzig((x) => { x.intrek_open = null; x.ingetrokken_op = nu(); });
  }
  async function intrek() {
    const c = config();
    if (!c) return { status: 503, body: { ok: false, fout: 'Het personeelsscherm is nog niet ingericht.' } };
    if (bezig) return { status: 409, body: { ok: false, fout: 'Er loopt al een koppeling; wacht even.' } };
    bezig = true;
    try {
      await zorgSchema();
      const id = (leesStand().token || {}).id;
      await intrekIntern(c);
      try { await melding('personeelsscherm-intrek:' + (id || nu()), 'Personeelsscherm: sleutel ' + TOKEN_NAAM + (id ? ' (id ' + id + ')' : '') + ' ingetrokken via de app. Zet de rij in het sleutelregister op ingetrokken.'); } catch (e) { fout('personeelsscherm-melding', e); }
      return { status: 200, body: { ok: true } };
    } catch (e) {
      fout('personeelsscherm-intrek', new Error('intrekken: ' + String(e && e.message).slice(0, 80)));
      // stap 1 (D1) gaat vóór alles: is die gelukt, dan is het kastje al dicht; de tik maakt de rest af
      return { status: 503, body: { ok: false, fout: 'Het kastje kan niets meer ophalen als dat deel lukte; de rest probeer ik elke 5 minuten opnieuw.', open: true } };
    } finally { bezig = false; }
  }
  async function leeg(aan) {
    wijzig((x) => { x.leeg = !!aan; });
    const doc = await publiceer(!!aan);
    return { status: 200, body: { ok: true, leeg: doc.leeg } };
  }

  // ── lezen ──
  async function leesD1() {
    await zorgSchema();
    const r = await d1([
      { sql: 'SELECT op, json, land FROM hartslag WHERE id = 1', params: [] },
      { sql: "SELECT sleutel, waarde FROM stand WHERE sleutel IN ('vreemd', 'koppel_open_tot', 'kastje_id')", params: [] },
      { sql: 'SELECT gemaakt, land, gebruikt FROM koppel WHERE verloopt > ? ORDER BY gemaakt', params: [nu()] },
    ]);
    const h = r[0].results[0] || null, st = {};
    for (const x of r[1].results) st[x.sleutel] = x.waarde;
    let hs = null; try { hs = h ? JSON.parse(h.json) : null; } catch (e) { hs = null; }
    let vreemd = null; try { vreemd = st.vreemd ? JSON.parse(st.vreemd) : null; } catch (e) { vreemd = null; }
    return { hartslag: h ? { op: Number(h.op), land: String(h.land || ''), velden: hs } : null, vreemd, koppel_open_tot: st.koppel_open_tot ? Number(st.koppel_open_tot) : null,
      kastje_in_d1: !!st.kastje_id, codes: r[2].results.map((x) => ({ gemaakt: Number(x.gemaakt), land: String(x.land || ''), ingetikt: Number(x.gebruikt) === 1 })) };
  }
  async function appStand() {
    let live = null, ffout = null;
    try { live = await leesD1(); } catch (e) { ffout = 'De stand van het kastje is nu niet te lezen.'; }
    const s = leesStand();
    if (live) wijzig((x) => { x.hartslag = live.hartslag; x.vreemd = live.vreemd; });
    const h = live ? live.hartslag : s.hartslag;
    const vel = (h && h.velden) || null;
    return {
      ok: true,
      stand: {
        gekoppeld: !!s.token,
        laatst_gezien: h ? h.op : null,
        kastje: vel ? Object.assign({}, vel, { land: h.land }) : null,
        vreemd: live ? live.vreemd : (s.vreemd || null),
        koppel_open_tot: live ? live.koppel_open_tot : (s.koppel_open_tot || null),
        codes: live ? live.codes : [],
        leeg: !!s.leeg,
        scherm: s.volgnr ? { volgnr: s.volgnr, gemaakt: s.gemaakt, houdbaar_tot: s.houdbaar_tot } : null,
        token: s.token ? { aangemaakt: s.token.aangemaakt, verloopt: s.token.verloopt, ip_eis: !!s.token.ip_eis } : null,
        fout: ffout || s.fout || (s.intrek_open ? 'Intrekken is nog niet helemaal klaar; ik probeer het opnieuw.' : null),
      },
      voorbeeld_html: s.html || '',
      ...appSchermen(s, nu()),   // wv3020
    };
  }

  async function app({ pad, methode, body }) {
    if (methode === 'GET' && pad === '/app/personeelsscherm') return { status: 200, body: await appStand() };
    if (methode === 'POST' && pad === '/app/personeelsscherm/open') return open();
    if (methode === 'POST' && pad === '/app/personeelsscherm/koppel') return koppel(body && body.code);
    if (methode === 'POST' && pad === '/app/personeelsscherm/intrek') return intrek();
    if (methode === 'POST' && pad === '/app/personeelsscherm/leeg') return leeg(!!(body && body.aan === true));
    if (methode === 'POST' && pad === '/app/personeelsscherm/info') return infoZet(body && body.id, !!(body && body.aan === true));   // wv3020
    if (methode === 'POST' && pad === '/app/personeelsscherm/aanvraag') return aanvraag(body && body.tekst);   // wv3020
    return { status: 404, body: { ok: false, fout: 'onbekend' } };
  }

  // ── tik (elke 5 min) ──
  async function tik() {
    if (!sleutel() || !config()) return { overgeslagen: true };
    let s = leesStand();
    const t = nu();
    if (s.intrek_open) { try { await intrekIntern(config()); } catch (e) { fout('personeelsscherm-intrek', new Error('opnieuw intrekken faalde')); } }
    let nieuw = false;
    if (!s.inhoud_op || t - s.inhoud_op >= INHOUD_MS || ymd(s.inhoud_op) !== ymd(t) || (s.inhoud && s.inhoud.persoonsvakken) !== toestemming()
      || !!(s.inhoud && s.inhoud.volle_naam) !== (toestemming() && volleNaamMag()) || s.info_sha !== infoBestandSha(ymd(t))   // wv3015: rij of vrijgave gewijzigd = meteen
      || (toestemming() && nieuwsActief() && !nieuwsBinnenKwartier(s, t)) || (!!(s.inhoud && s.inhoud.nieuws) && !(toestemming() && nieuwsActief()))) {   // wv3023: nieuws elk kwartier; zin weg of uit = meteen
      try { const i = await verzamel(t); nieuw = inhoudSha(i) !== s.inhoud_sha; } catch (e) { fout('personeelsscherm-inhoud', new Error(String(e && e.message).slice(0, 80))); }
      s = leesStand();
    }
    if (nieuw || !s.gemaakt || t - s.gemaakt > OPNIEUW_MS || !s.houdbaar_tot) {
      try { await publiceer(); } catch (e) { wijzig((x) => { x.fout = 'Het scherm kon niet worden bijgewerkt.'; }); fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80))); }
    }
    let live;
    try { live = await leesD1(); } catch (e) { fout('personeelsscherm-lees', new Error('D1 lezen faalde')); return { ok: false }; }
    s = wijzig((x) => { x.hartslag = live.hartslag; x.vreemd = live.vreemd; x.laatste_tik = t; });
    // meldingen: nooit vaker dan één keer per voorval of per dag
    if (live.vreemd && live.vreemd.op && s.vreemd_gemeld !== live.vreemd.op) {
      wijzig((x) => { x.vreemd_gemeld = live.vreemd.op; });
      try { await melding('personeelsscherm-vreemd:' + live.vreemd.op, 'Personeelsscherm: de sleutel van het kastje werd ' + iso(live.vreemd.op).slice(0, 16) + ' UTC gebruikt vanaf een ander internetadres (land ' + (live.vreemd.land || '?') + ') en geweigerd. Mogelijk een gestolen kaart of een nieuw adres van de praktijk: David kan in Apps › Personeelsscherm de sleutel intrekken.', true); } catch (e) { fout('personeelsscherm-melding', e); }
    }
    if (s.token && s.gekoppeld_op && t - s.gekoppeld_op > STIL_MS && inWerktijd(t)) {
      const laatst = live.hartslag ? live.hartslag.op : 0;
      const dag = amsDelen(t).datum;
      if (t - laatst > STIL_MS && s.stil_gemeld !== dag) {
        wijzig((x) => { x.stil_gemeld = dag; });
        try { await melding('personeelsscherm-stil:' + dag, 'Personeelsscherm: het kastje meldde zich ' + (laatst ? 'sinds ' + iso(laatst).slice(0, 16) + ' UTC' : 'nog nooit') + ' niet meer (werktijd). Stroom, kabel of internet van de praktijk?'); } catch (e) { fout('personeelsscherm-melding', e); }
      }
    }
    return { ok: true };
  }

  function info() {
    const s = leesStand(), c = config();
    return { aan: true, ingericht: !!c && !!sleutel(), gekoppeld: !!s.token, laatst_gezien: s.hartslag ? iso(s.hartslag.op) : null,
      stil_min: s.hartslag ? Math.round((nu() - s.hartslag.op) / 60000) : null, temp_c: s.hartslag && s.hartslag.velden ? s.hartslag.velden.temp_c : null,
      getoond: s.hartslag && s.hartslag.velden ? s.hartslag.velden.getoond || null : null, leeg: !!s.leeg, volgnr: s.volgnr || null,
      houdbaar_tot: s.houdbaar_tot ? iso(s.houdbaar_tot) : null, token_verloopt: s.token ? iso(s.token.verloopt).slice(0, 10) : null,
      vreemd: s.vreemd ? iso(s.vreemd.op) : null, intrek_open: !!s.intrek_open, laatste_tik: s.laatste_tik ? iso(s.laatste_tik) : null, fout: s.fout || null,
      inhoud_op: s.inhoud_op ? iso(s.inhoud_op) : null, persoonsvakken: !!(s.inhoud && s.inhoud.persoonsvakken),
      vakken: s.inhoud ? { agenda: (s.inhoud.agenda || []).length, artsen: s.inhoud.artsen ? s.inhoud.artsen.length : null, jarig: s.inhoud.jarig ? s.inhoud.jarig.length : null, weer: !!s.inhoud.weer,
        info: Array.isArray(s.inhoud.info) ? s.inhoud.info.length : 0, volle_naam: !!s.inhoud.volle_naam,
        nieuws: s.inhoud.nieuws && Array.isArray(s.inhoud.nieuws.items) ? s.inhoud.nieuws.items.length : 0 } : null,   // wv3023: alleen het aantal koppen
      nieuws_mag: nieuwsMag(), nieuws_uit: !!uitLijst()[NIEUWS_ID], nieuws_poging: s.nieuws_poging ? iso(s.nieuws_poging) : null,
      info_uit: s.info_uit ? Object.keys(s.info_uit).length : 0, aanvragen: (s.aanvragen || []).filter((a) => a && nu() - a.op < AANVRAAG_BEWAAR_MS).length,   // wv3020
      bronnen: s.inhoud ? s.inhoud.bronnen || null : null };   // alleen tellingen, nooit namen
  }

  return { app, tik, info, publiceer, open, koppel, intrek, leeg, leesD1, appStand, verzamel, toestemming, infoSchermen, infoKandidaten, infoZet, aanvraag };
}

module.exports = { maak, bouwHtml, D1_SCHEMA, inWerktijd, HOUDBAAR_MS, OPNIEUW_MS, TOKEN_NAAM, HOST, REGISTER_RIJ,
  VOLLE_NAAM_ZIN, INFO_ZIN, NIEUWS_ZIN, NIEUWS_ID,
  _t: { nieuwsKop, nieuwsKoppen, nieuwsGeldig, agendaPunten, artsenVandaag, jarigen, leesMedewerkers, weerBeeld, dagdeel, frontmatter, infoNorm, stapTekst, kaartHash, fnv, setKaart, setGeldig, schermId, aanvraagOpdracht, aanvraagTekst } };
