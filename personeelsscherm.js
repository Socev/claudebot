'use strict';
/**
 * personeelsscherm.js — OVIS Scherm (zichtbare naam sinds wv3214, 16-11-2026; vroeger "Personeelsscherm"; id, routes en bestanden ongewijzigd) fase 0 (wv2991, 13-11-2026).
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
 * oud; in de app aan/uit als infoscherm met vaste id NIEUWS_ID. Codex-review 3 rondes (lineaire, structuurbewuste parser).
 * Zichzelf opruimen + jarige (wv4141, 25-11-2026, Davids Ja op 2C55): per kop telt alleen het scherm uit de nieuwste set (oud = 'vervangen',
 * in de app weer aan te zetten via stand.info_naast); een punt kan een eigen einddatum (tot) hebben, op de kaart en de tv, daarna weg (zonder
 * het veld blijven kaart-hash en schermId gelijk); felicitatiepagina (voornaam; maandag ook het weekend; JARIG_ID aan/uit); Komende weken
 * komt na elke twee pagina's terug (klokscript); stipjes in plaats van "Info k/n".
 * Schermtijd + QR (wv4208, 27-11-2026, Davids Ja op nr 925 = L25 en nr 921 = L21): werkdagen 07:00–18:30 het gewone scherm, daarbuiten zwart met
 * klok (pod stuurt 18:30–06:45 een rust-envelop zonder inhoud; het gewone scherm schakelt op de wandklok); QR-code naar het artikel naast elk
 * medisch bericht en bij een infoscherm met bron_url, op de tv alleen met de eigen registerrij personeelsscherm-qr (QR_ZIN). Deze module:
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
// wv4208 (besluitenpagina nr 925 = L25, David Ja 25-11-2026): schermtijd. Op werkdagen (ma–vr, geen landelijke feestdag) van 07:00 tot 18:30 het
// gewone scherm; daarbuiten zwart met klok. Gemeten 27-11: het kastje haalt dag en nacht, ook in het weekend, elke 2 min het volle scherm op
// (± 705 hartslagen per dag); of de tv zelf aan staat meldt het kastje niet. De pod stuurt buiten SCHERM_VOORAF–SCHERM_TOT een envelop zonder
// inhoud (rust); het gewone scherm wordt al om 06:45 gestuurd en schakelt zelf op de wandklok van het kastje (Europe/Amsterdam) om 07:00 aan
// en om 18:30 uit, zodat de wissel op de minuut klopt (de tik loopt elke 5 min, het kastje haalt elke 2 min).
const SCHERM_VAN = 7 * 60, SCHERM_TOT = 18 * 60 + 30, SCHERM_VOORAF = 6 * 60 + 45;
function schermDag(a) { return a.dag >= 0 && a.dag <= 4 && !feestdag(a.datum); }
function inSchermtijd(ms) { const a = amsDelen(ms), m = a.uur * 60 + a.min; return schermDag(a) && m >= SCHERM_VAN && m < SCHERM_TOT; }
function inhoudVenster(ms) { const a = amsDelen(ms), m = a.uur * 60 + a.min; return schermDag(a) && m >= SCHERM_VOORAF && m < SCHERM_TOT; }
const RUST_TEKST = 'Het scherm staat aan op werkdagen van 07:00 tot 18:30.';

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
function bouwHtml({ gemaakt, houdbaar_tot, leeg, rust, logoSvg, inhoud, toon }) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; connect-src 'none'";
  // wv4208: feestdagen van dit en volgend jaar voor de schermtijd op de wandklok van het kastje
  const fj = amsDelen(Number(gemaakt) || 0).datum.slice(0, 4), feest = JSON.stringify([...feestdagen(Number(fj)).keys(), ...feestdagen(Number(fj) + 1).keys()]);
  const klokScript = `(function(){var T=${Number(houdbaar_tot)},F=${feest};var D=['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'],M=['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
function z(n){return(n<10?'0':'')+n}function s(){var e=document.getElementById('doek');if(e){var f=Math.min(innerWidth/1920,innerHeight/1080);e.style.transform='scale('+f+')';}}s();addEventListener('resize',s);
function p(){var A=document.getElementById('agenda');A=A&&A.parentNode&&A.parentNode.parentNode;if(!A||A.getAttribute('data-pas')||!A.clientHeight)return;var T=A.querySelectorAll('.tt'),i,g;for(i=0;i<T.length;i++){g=44;while(T[i].scrollHeight>T[i].clientHeight+1&&g>30){g-=2;T[i].style.fontSize=g+'px';}}g=44;while(A.scrollHeight>A.clientHeight+1&&g>26){g-=2;for(i=0;i<T.length;i++){if((parseFloat(T[i].style.fontSize)||44)>g)T[i].style.fontSize=g+'px';}}A.setAttribute('data-pas','1');}
function t(){var n=new Date();var k=document.getElementById('klok'),w=document.getElementById('wd'),d=document.getElementById('dag');if(k)k.textContent=z(n.getHours())+':'+z(n.getMinutes());if(w)w.textContent=D[n.getDay()];if(d)d.textContent=n.getDate()+' '+M[n.getMonth()];
if(n.getTime()>T){document.body.className='oud';}
var mm=n.getHours()*60+n.getMinutes(),wg=n.getDay(),ds=n.getFullYear()+'-'+z(n.getMonth()+1)+'-'+z(n.getDate()),R=wg<1||wg>5||mm<${SCHERM_VAN}||mm>=${SCHERM_TOT}||F.indexOf(ds)>=0,b=document.body;if(b&&b.classList)b.classList.toggle('rust',R);
var rk=document.getElementById('rklok'),rd=document.getElementById('rdag');if(rk)rk.textContent=z(n.getHours())+':'+z(n.getMinutes());if(rd)rd.textContent=D[n.getDay()]+' '+n.getDate()+' '+M[n.getMonth()];
var P=document.querySelectorAll('.paneel');if(P.length>1){var V=[],L=[],S=0,i,j,a=null;for(i=0;i<P.length;i++){var x=+P[i].getAttribute('data-tot')||0;if(x&&n.getTime()>x){P[i].classList.remove('aan');continue;}V.push(P[i]);}
function r(e){var u=+e.getAttribute('data-s')||20;L.push([e,S,u]);S+=u;}for(i=0,j=0;i<V.length;i++){if(j===2){r(V[0]);j=0;}r(V[i]);if(i>0)j++;}
var q=Math.floor(n.getTime()/1000)%S,c=Math.floor(n.getTime()/1000/S);for(i=0;i<L.length;i++){if(q>=L[i][1]&&q<L[i][1]+L[i][2])a=L[i][0];}
for(i=0;i<V.length;i++){V[i].classList.toggle('aan',V[i]===a);var B=V[i].querySelectorAll('.blad');for(j=0;j<B.length;j++){B[j].classList.toggle('aan',j===c%B.length);}}}p();}t();setInterval(t,1000);})();`;
  if (leeg) {
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>OVIS Scherm</title>
<style>*{cursor:none!important}html,body{margin:0;height:100%;background:#000;color:#444;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#000}#klok{position:absolute;right:38px;bottom:38px;font-size:46px}#dag,#wd{display:none}</style></head>
<body data-soort="leeg" data-gemaakt="${Number(gemaakt)}"><div id="doek"><div id="klok"></div><div id="wd"></div><div id="dag"></div></div><script>${klokScript}</script></body></html>`;
  }
  // wv4208: buiten schermtijd zwart met een gedimde klok (en dag), plus één regel waarom het scherm zwart is; geen inhoud in het bestand
  const rustBlok = (kl, dg) => `<div id="rust"><div id="rklok">${esc(kl || '')}</div><div id="rdag">${esc(dg || '')}</div><div class="rt">${RUST_TEKST}</div></div>`;
  const rustCss = '#rust{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;background:#000;color:#5a5a5a;z-index:9}#rklok{font-size:220px;line-height:1;letter-spacing:-4px}#rdag{font-size:54px;margin-top:24px;color:#4a4a4a}#rust .rt{font-size:28px;margin-top:60px;color:#3a3a3a}';
  if (rust) {
    const ri = inhoud || {};
    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>OVIS Scherm</title>
<style>*{cursor:none!important}html,body{margin:0;height:100%;background:#000;font-family:'Liberation Sans',Arial,Helvetica,sans-serif;overflow:hidden}#doek{position:relative;width:1920px;height:1080px;transform-origin:0 0;background:#000}${rustCss}#rust{display:flex}</style></head>
<body data-soort="rust" data-gemaakt="${Number(gemaakt)}"><div id="doek">${rustBlok(ri.klok_tekst, ri.wd_tekst && ri.dag_tekst ? ri.wd_tekst + ' ' + ri.dag_tekst : '')}</div><script>${klokScript}</script></body></html>`;
  }
  const i = inhoud || {};
  // wv4208 (nr 921 = L21): QR-code naar het artikel bij de bron; alleen als i.qr (registerrij personeelsscherm-qr op de tv, altijd in het app-voorbeeld)
  const qrBij = (url, dom) => { const u = i.qr ? openbareUrl(url, dom) : ''; const svg = u ? qrSvg(u, QR_PX) : ''; return svg ? `<div class="qrv">${svg}<span>Lees verder</span></div>` : ''; };
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
  // wv3154: medisch nieuws en Belangrijk (alleen wat schermInhoud doorliet); een lege lijst (alleen app-voorbeeld) = uitlegregel
  const md = i.medisch && typeof i.medisch === 'object' ? i.medisch : null;
  const mdN = md && Array.isArray(md.nieuws) && (md.nieuws.length || md.leeg_tonen) ? md.nieuws : null;
  const mdB = md && Array.isArray(md.belangrijk) && (md.belangrijk.length || md.leeg_tonen) ? md.belangrijk : null;
  // wv4141 (2C55): felicitatiepagina op de verjaardag zelf (maandag ook wie za/zo jarig was): alleen voornaam, vaste tekst, weg om middernacht
  const jd = Array.isArray(i.jarig_dag) && (i.jarig_dag.length || i.jarig_leeg) ? i.jarig_dag : null;
  // wv4149 (2C31): weekpagina (alleen wat schermInhoud doorliet; lege dagen = alleen app-voorbeeld zonder rooster)
  const wk = i.week && typeof i.week === 'object' && Array.isArray(i.week.dagen) ? i.week : null;
  const nPan = info.length + (jd ? 1 : 0) + (wk ? 1 : 0) + (nw ? 1 : 0) + (mdN ? 1 : 0) + (mdB ? 1 : 0);
  const zicht = Number.isInteger(toon) && toon >= 0 && toon <= nPan ? toon : 0;
  const nwTijd = (ms) => { const a = amsDelen(ms); return a.datum === nwDag ? String(a.uur).padStart(2, '0') + ':' + String(a.min).padStart(2, '0') : 'gisteren'; };
  let plek = 0;
  const jarigHtml = jd ? `<section class="paneel jarig${zicht === ++plek ? ' aan' : ''}" data-s="${INFO_S}" data-tot="${Date.parse(plusDag(nwDag, 1) + 'T00:00:00+01:00')}"><div class="ph"><h1>Gefeliciteerd!</h1><div class="lab">Jarig</div></div>`
    + `<div class="slinger">${SLINGER_SVG}</div>`
    + (jd.length ? `<div class="jarigen">${jd.slice(0, 6).map((x) => `<div class="jr"><div class="jn">${esc(x.naam)}</div><div class="jw">${x.wanneer === 'vandaag' ? 'is vandaag jarig' : 'was ' + esc(x.wanneer) + ' jarig'}</div></div>`).join('')}</div>`
      : '<div class="niets">Op een verjaardag staat hier de felicitatie (alleen de voornaam). Op maandag ook wie in het weekend jarig was.</div>')
    + '<div class="voet">Van harte gefeliciteerd!</div></section>' : '';
  // wv4149: vijf werkdagen onder elkaar; vandaag rode rand, voorbije dagen grijs, feestdag als label; weg op de wandklok na de vrijdag van de week
  const wkNaam = (x) => `<span class="an">${esc(x.naam)}${x.wanneer && x.wanneer !== 'hele dag' ? `<em> ${esc(x.wanneer)}</em>` : ''}</span>`;
  const wkTekens = wk ? wk.dagen.reduce((n, d) => n + d.artsen.slice(0, WEEK_NAMEN_MAX).reduce((m, x) => m + String(x.naam).length + (x.wanneer && x.wanneer !== 'hele dag' ? 9 : 0) + 3, 0), 0) : 0;
  const wkMaat = (WEEK_MAAT.find(([n]) => wkTekens > n) || [0, ''])[1];
  const weekHtml = wk ? `<section class="paneel week${wkMaat ? ' ' + wkMaat : ''}${zicht === ++plek ? ' aan' : ''}" data-s="${WEEK_S}"${wk.maandag ? ` data-tot="${Date.parse(plusDag(wk.maandag, 5) + 'T00:00:00+01:00')}"` : ''}><div class="ph"><h1>${esc(wk.kop || 'Deze week op Tolgaarde')}</h1><div class="lab">Artsen</div></div>`
    + (wk.dagen.length ? `<div class="wk">${wk.dagen.map((d) => `<div class="wr${d.vandaag ? ' nu' : ''}${d.voorbij ? ' voorbij' : ''}"><div class="wd2"><div class="dat"><span class="wd">${esc(d.wd)}</span><span class="dg">${esc(d.dg)}</span><span class="mn">${esc(d.mn)}</span></div>`
      + (d.feestdag || d.vandaag ? `<div class="wc">${d.vandaag ? '<span class="chip a">Vandaag</span>' : ''}${d.feestdag ? `<span class="chip">${esc(d.feestdag)}</span>` : ''}</div>` : '') + '</div>'
      + `<div class="wn">${d.artsen.length ? d.artsen.slice(0, WEEK_NAMEN_MAX).map(wkNaam).join('') + (d.artsen.length > WEEK_NAMEN_MAX ? `<span class="an">+${d.artsen.length - WEEK_NAMEN_MAX}</span>` : '') : '<span class="leeg">Geen rooster bekend</span>'}</div></div>`).join('')}</div>`
      : '<div class="niets">Nog geen rooster voor deze week binnen.</div>')
    + `<div class="voet">Artsen en waarnemers volgens het rooster · bijgewerkt ${esc(amsTekst(gemaakt))}</div></section>` : '';
  const nieuwsHtml = nw ? `<section class="paneel nieuws${zicht === ++plek ? ' aan' : ''}" data-s="${INFO_S}"${nw.items.length ? ` data-tot="${Number(nw.nieuwste) + NIEUWS_OUD_MS}"` : ''}><div class="ph"><h1>Nieuws</h1><div class="lab">NOS</div></div>`
    + (nw.items.length ? nw.items.slice(0, NIEUWS_N).map((x) => `<div class="nws"><span class="nt">${esc(nwTijd(x.ms))}</span><span class="nk">${esc(x.kop)}</span></div>`).join('')
      : '<div class="niets">Nu geen recent nieuws: de NOS is niet bereikbaar of het nieuwste bericht is ouder dan 6 uur. Dan staat dit scherm niet op de tv.</div>')
    + '<div class="voet">Bron: NOS</div></section>' : '';
  const mdDatum = (ms) => { const a = amsDelen(ms), d = datumDelen(a.datum); return d.dg + ' ' + d.mn; };
  // blad per beurt: 3 berichten per blad; het klokscript toont elke keer dat de pagina langskomt het volgende blad (zonder script: blad 1)
  const mdPaneel = (lijst, plek, kop, lab, voet, leegTekst) => {
    const bladen = []; for (let b = 0; b < lijst.length; b += MEDISCH_PER_BLAD) bladen.push(lijst.slice(b, b + MEDISCH_PER_BLAD));
    return `<section class="paneel med${zicht === plek ? ' aan' : ''}" data-s="${MEDISCH_S}"><div class="ph"><h1>${kop}</h1><div class="lab">${lab}${bladen.length > 1 ? ` · ${bladen.length} pagina's` : ''}</div></div>`
      + (bladen.length ? bladen.map((bl, b) => `<div class="blad${b === 0 ? ' aan' : ''}">${bl.map((x) => {
        const br = (MEDISCH_BRONNEN.find((y) => y.id === x.bron) || { naam: '' }).naam;
        const q = qrBij(x.url, medischDomein(x.bron));
        const vw = typeof x.voor === 'string' && VOOR_WIE[x.voor] ? `<span class="mvoor">voor ${esc(VOOR_WIE[x.voor])}</span>` : '';   // wv4210
        return `<div class="mb${q ? ' mq' : ''}"><div class="mi"><div class="mm"><span class="chip a">${esc(br)}</span><span>${esc(mdDatum(x.ms))}</span>${vw}${Number.isFinite(x.tot) ? `<span class="mtot">blijft staan tot ${esc(mdDatum(x.tot))}</span>` : ''}</div>`
          + `<div class="mk">${esc(x.kop)}</div>${x.zin ? `<div class="mz">${esc(x.zin)}</div>` : ''}${x.tekst ? `<div class="mt">${esc(x.tekst)}</div>` : ''}</div>${q}</div>`;
      }).join('')}</div>`).join('') : `<div class="niets">${leegTekst}</div>`)
      + `<div class="voet">${voet}</div></section>`;
  };
  const mdTeam = !!(md && md.team);   // wv4210: met de teamrij een bredere kop en bronregel
  const medHtml = (mdN ? mdPaneel(mdN, ++plek, 'Medisch nieuws', mdTeam ? 'Voor het hele team' : 'NHG · LHV · RIVM', mdTeam ? 'Bron: NHG, LHV, RIVM, NVDA, NVvPO en Thuisarts · elk uur bijgewerkt' : 'Bron: nieuwsberichten van NHG, LHV en RIVM · elk uur bijgewerkt', 'Nog geen berichten van de afgelopen 30 dagen binnen.') : '')
    + (mdB ? mdPaneel(mdB, ++plek, 'Belangrijk', mdTeam ? 'LHV · NHG · NVDA' : 'LHV · NHG', mdTeam ? 'Blijft enkele weken staan · bron: LHV, NHG en NVDA' : 'Blijft enkele weken staan · bron: LHV en NHG', mdTeam ? 'Nu geen belangrijke berichten. Een bericht van LHV, NHG of NVDA over een standaard, cao, tarief, subsidie of oproep komt hier vanzelf; jij kunt er een vastzetten.' : 'Nu geen belangrijke berichten. Een bericht van LHV of NHG over een standaard, cao, tarief, subsidie of oproep komt hier vanzelf; jij kunt er een vastzetten.') : '');
  // wv4141 (2C55): stipjes (k van n) in plaats van "Info k/n"; sc.lab (alleen app-voorbeeld) = tekst, sc.stip = [k, n] (app-voorbeeld)
  const stip = (k, n) => n > 1 ? `<span class="stip" aria-label="${k + 1} van ${n}">${Array.from({ length: n }, (_, m) => `<i${m === k ? ' class="op"' : ''}></i>`).join('')}</span>` : '';
  const ptDatum = (d) => { const x = datumDelen(d); return x.dg + ' ' + x.mn; };
  const infoHtml = jarigHtml + weekHtml + nieuwsHtml + medHtml + info.map((sc, k) => `<section class="paneel info${zicht === k + 1 + plek ? ' aan' : ''}" data-s="${INFO_S}" data-tot="${Date.parse(plusDag(sc.tot, 1) + 'T00:00:00+01:00')}"><div class="ph"><h1>${esc(sc.kop)}</h1><div class="lab">${sc.lab ? esc(sc.lab) : Array.isArray(sc.stip) ? stip(sc.stip[0], sc.stip[1]) : stip(k, info.length)}</div></div>`
    + (sc.intro ? `<p class="intro">${esc(sc.intro)}</p>` : '')
    + `<div class="punten">${sc.punten.map((x) => `<div class="punt"><div class="pt">${esc(x.titel)}</div>${x.tekst ? `<div class="px">${esc(x.tekst)}</div>` : ''}${x.tot ? `<div class="ptot">t/m ${esc(ptDatum(x.tot))}</div>` : ''}</div>`).join('')}</div>`
    + (() => { const q = sc.bron_url ? qrBij(sc.bron_url, null) : ''; return q ? `<div class="voet vq"><span>Bron: ${esc(sc.bron)}</span>${q}</div>` : `<div class="voet">Bron: ${esc(sc.bron)}</div>`; })() + '</section>').join('');
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="refresh" content="60"><title>OVIS Scherm</title>
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
.wat{flex:1;min-width:0}.tt{font-size:44px;font-weight:bold;color:#3E3F42;line-height:1.15;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.sub{font-size:30px;margin-top:2px}
.chip{display:inline-block;font-size:22px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;padding:5px 14px;border-radius:999px;border:2px solid #D9DADC;color:#88898C;white-space:nowrap}.chip.a{border-color:#ED1C24;color:#ED1C24}
.niets{font-size:40px;color:#88898C;padding:30px 0}
.voet{margin-top:auto;padding-top:20px;font-size:24px;color:#88898C}
.paneel{display:none;flex:1;flex-direction:column;min-height:0}.paneel.aan{display:flex}
.intro{font-size:38px;line-height:1.3;color:#3E3F42;margin:4px 0 26px}
.punten{display:grid;grid-template-columns:1fr 1fr;gap:30px 44px}.punt{border-left:8px solid #ED1C24;padding:4px 0 4px 24px;min-width:0}
.pt{font-size:40px;font-weight:bold;color:#3E3F42;line-height:1.15}.px{font-size:32px;line-height:1.3;margin-top:8px}
.nws{display:flex;align-items:baseline;gap:24px;padding:16px 0;border-bottom:2px solid #D9DADC}.nt{flex:none;width:100px;font-size:30px;font-weight:bold;color:#88898C;white-space:nowrap}
.nk{flex:1;min-width:0;font-size:39px;font-weight:bold;color:#3E3F42;line-height:1.2;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.med .blad{display:none;flex-direction:column}.med .blad.aan{display:flex}.mb{padding:12px 0 14px;border-bottom:2px solid #D9DADC;min-width:0}
.mm{display:flex;align-items:center;gap:18px;font-size:26px;font-weight:bold;color:#88898C}.mm .chip{font-size:20px;padding:3px 12px}.mtot{margin-left:auto;color:#ED1C24}.mvoor{color:#3E3F42}
.mz{font-size:30px;font-weight:bold;line-height:1.25;margin-top:8px;color:#ED1C24}.mz+.mt{-webkit-line-clamp:2}
.mk{font-size:38px;font-weight:bold;color:#3E3F42;line-height:1.18;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.mt{font-size:29px;line-height:1.28;margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.stip{display:inline-flex;gap:12px;align-items:center}.stip i{display:inline-block;width:18px;height:18px;border-radius:50%;border:3px solid #ED1C24}.stip i.op{background:#ED1C24}
.ptot{font-size:24px;font-weight:bold;color:#ED1C24;margin-top:6px}
.slinger{height:110px;margin:-10px 0 10px}.slinger svg{width:100%;height:110px}
.jarigen{display:flex;flex-wrap:wrap;gap:40px 80px;align-content:center;flex:1;padding:10px 0 30px}.jr{min-width:0}
.jn{font-size:120px;font-weight:bold;color:#ED1C24;line-height:1.05;overflow-wrap:anywhere}.jw{font-size:42px;color:#3E3F42;margin-top:8px}
.wk{display:flex;flex-direction:column}.wr{display:flex;align-items:center;gap:26px;padding:12px 16px 12px 18px;border-bottom:2px solid #D9DADC;border-left:8px solid transparent;min-height:128px}
.wr.nu{border-left-color:#ED1C24;background:#FDF1F1}.wr.voorbij{opacity:.45}.wd2{flex:none;width:220px}.wd2 .dat{width:220px}
.wn{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px 36px;font-size:38px;font-weight:bold;color:#3E3F42;line-height:1.2}
.k1 .wn{font-size:34px;gap:2px 32px}.k2 .wn{font-size:30px;gap:2px 28px}.k3 .wn{font-size:27px;gap:0 24px}.k2 .wr,.k3 .wr{min-height:110px;padding-top:8px;padding-bottom:8px}
.wn em{font-style:normal;font-weight:normal;color:#88898C;font-size:.75em}.wn .leeg{font-weight:normal;color:#88898C;font-size:32px}.an{max-width:100%;overflow-wrap:anywhere}
.wc{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}.wc .chip{font-size:19px;padding:3px 10px}
.qrv{flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;margin-left:24px}.qrv .qr{display:block}.qrv span{font-size:20px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#88898C}
.mb.mq{display:flex;align-items:center}.mi{flex:1;min-width:0}.voet.vq{display:flex;align-items:flex-end;justify-content:space-between}
${rustCss}body.rust,body.rust #doek{background:#000}body.rust #rust{display:flex}body.rust .rail,body.rust .podium{visibility:hidden}
.oud-tekst{display:none;font-size:44px;color:#3E3F42}body.oud .podium>*,body.oud .weer-blok,body.oud .blok{display:none}body.oud .podium .oud-tekst{display:block}
</style></head>
<body data-soort="scherm" data-gemaakt="${Number(gemaakt)}" data-houdbaar="${Number(houdbaar_tot)}">
<div id="doek"><div class="rail">${logo}<div><div id="wd">${esc(i.wd_tekst || '')}</div><div id="dag">${esc(i.dag_tekst || '')}</div><div id="klok">${esc(i.klok_tekst || '')}</div></div>
${weerHtml}${persBlok('Artsen vandaag', i.artsen, 'Geen rooster bekend', 5)}${persBlok('Jarig deze week', i.jarig, 'Niemand jarig deze week', Math.max(2, 6 - Math.min(5, (i.artsen || []).length)))}</div>
<div class="podium"><section class="paneel${zicht === 0 ? ' aan' : ''}" data-s="${INFO_HOOFD_S}"><div class="ph"><h1 id="agenda">Komende weken</h1><div class="lab">Agenda</div></div>${agHtml}
<div class="voet">Bijgewerkt ${esc(amsTekst(gemaakt))}</div></section>${infoHtml}<p class="oud-tekst">Dit scherm wordt bijgewerkt.</p></div>${rustBlok('', '')}</div>
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
// wv3438 (afspraak David 19-11: niet filteren, B31): geen woord- of naamfilter meer op agendatitels.
// wv3560 (2B20): ook geen knip meer; de volle titel gaat de envelop in en loopt op de tv over twee regels (.tt line-clamp 2);
// past hij daar niet, dan zet het schermscript p() die titel kleiner (≥ 30 px) en, als het vak overloopt, alle titels (≥ 26 px).
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
// wv4141 (2C55): felicitatiepagina, vaste id voor aan/uit in de app (zelfde vorm als schermId)
const JARIG_ID = crypto.createHash('sha256').update('jarig:vandaag').digest('hex').slice(0, 16);
const SLINGER_SVG = '<svg viewBox="0 0 1200 110" preserveAspectRatio="none" aria-hidden="true"><path d="M0 8 Q600 70 1200 8" fill="none" stroke="#88898C" stroke-width="3"/>'
  + Array.from({ length: 13 }, (_, k) => { const x = 40 + k * 86, y = 8 + 62 * (1 - Math.pow((x - 600) / 600, 2)) * 0.97; return `<path d="M${x - 26} ${y.toFixed(0)} L${x + 26} ${y.toFixed(0)} L${x} ${(y + 44).toFixed(0)} Z" fill="${k % 2 ? '#D9DADC' : '#ED1C24'}"/>`; }).join('') + '</svg>';
// ── wv4149 (2C31, David Ja 25-11-2026): pagina "Deze week op Tolgaarde" — per werkdag (ma–vr) de artsen en waarnemers uit het artsenrooster,
// zelfde namen en dagdeel als het railvak (artsenVandaag per dag), vandaag gemarkeerd, vanaf vrijdag 12:00 de volgende week, feestdagen berekend.
// Op de tv alleen met een EIGEN registerrij WEEK_RIJ (status aan, naast de basisrij) die WEEK_ZIN bevat, zoals Medisch nieuws (wv3154); daarvoor
// alleen als proef in de app. Ontwerp + Codex-review: mk-scripts/personeelsscherm/week/ontwerp.md (MOET 1: tijdlijn vanaf de maandag lezen).
const WEEK_RIJ = 'personeelsscherm-week';
const WEEK_ZIN = 'Deze week op Tolgaarde: per werkdag (maandag tot en met vrijdag) welke artsen en waarnemers';
const WEEK_ID = crypto.createHash('sha256').update('week:tolgaarde').digest('hex').slice(0, 16);
const WEEK_S = 25, WEEK_NAMEN_MAX = 6;
// letter kleiner naarmate de week meer tekst heeft (tekens van namen + dagdeel over vijf dagen); gemeten 26-11: ± 15 namen, ± 200 tekens per week
const WEEK_MAAT = [[420, 'k3'], [300, 'k2'], [200, 'k1']];
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
// wv3154: velden = welke directe kinderen van item tellen (NOS: title + pubDate; medisch ook description, guid, link)
function rssItems(xml, velden = ['title', 'pubDate']) {
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
    else if (cur && !vang && stapel.length === 4 && velden.includes(naam) && !Object.prototype.hasOwnProperty.call(cur, naam)) { vang = naam; vangVan = gt + 1; }
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
// ── medisch nieuws + Belangrijk (wv3154, David 15-11-2026 21:08: "Ik wil het verversend hebben, elke keer weer nieuwe zaken. En 1 pagina
// die belangrijkere berichten (LHV, NHG) misschien langer vasthoudt") ──
// Bronnen (gemeten 15-11 vanuit de pod, openbaar, robots staat het toe): NHG en LHV via de RSS van hun nieuwstype (WordPress
// /feed/?post_type=news, 10 nieuwste; de gewone /feed/ is leeg of een proefbericht), RIVM via /nieuws/rss.xml (± 20 nieuwste). Samen
// ± 10 berichten per week. De POD haalt ze (server.js o.medisch(bron), nooit het kastje) hooguit elk uur. Per bericht alleen kop, één à
// twee hele zinnen uit de samenvatting van de bron zelf (geen taalmodel), bron en datum; geen link, beeld of verdere tekst.
// Pagina "Medisch nieuws": hooguit 12 berichten ≤ 30 dagen, nieuwste eerst, 3 per blad; elke keer dat de pagina langskomt het volgende
// blad (klokscript). Pagina "Belangrijk": berichten van NHG en LHV die aan BELANGRIJK_REGEL voldoen blijven tot 21 dagen na hun datum;
// David kan in de app een bericht vasthouden (28 dagen vanaf zijn tik) of loslaten. RIVM alleen als het over zorg/gezondheid gaat
// (ZORG_REGEL; RIVM schrijft ook over stikstof en batterijen). Op de tv alleen als registerrij MEDISCH_RIJ (status aan, naast
// personeelsscherm-vast) MEDISCH_ZIN bevat; daarvoor alleen als proef in de app (Davids eigen voorbeeld).
const MEDISCH_ZIN = 'Medisch nieuws: berichten van NHG, LHV en RIVM uit hun openbare nieuwsfeeds (alleen kop';
// eigen registerrij (kort genoeg om op Davids kaart helemaal te passen: de app toont per stap 400 tekens); alleen geldig naast personeelsscherm-vast
const MEDISCH_RIJ = 'personeelsscherm-medisch';
// wv4210 (nr 922 = L22, David Ja 25-11-2026 met verse vingerafdruk): nieuws voor het hele team. Gemeten 27-11 vanaf de pod (openbare RSS,
// robots staat het toe): NVDA /feed/ (doktersassistenten, ± 6 per maand, ook cao), NVvPO /feed/ (praktijkondersteuners, blog, alleen kop,
// ± 3 per maand) en Thuisarts /rss.xml (NHG voor patiënten, ± 2 per maand). LV POH-GGZ en Huisartsen Eemland: geen DNS/feed → niet erbij,
// niet nabouwen met scrapen. team = alleen op de tv met de eigen rij TEAM_RIJ (TEAM_ZIN); daarvoor alleen in het app-voorbeeld.
// voor = standaard 'voor wie' per bron; David kan het per bericht kiezen (VOOR_WIE), alleen zichtbaar met TEAM_RIJ.
const MEDISCH_BRONNEN = [{ id: 'nhg', naam: 'NHG', vast: true, domein: 'nhg.org', voor: 'artsen' }, { id: 'lhv', naam: 'LHV', vast: true, domein: 'lhv.nl', voor: 'artsen' }, { id: 'rivm', naam: 'RIVM', vast: false, alleenZorg: true, domein: 'rivm.nl', voor: 'iedereen' },
  { id: 'nvda', naam: 'NVDA', vast: true, domein: 'nvda.nl', voor: 'assistentes', team: true }, { id: 'nvvpo', naam: 'NVvPO', vast: false, domein: 'nvvpo.nl', voor: 'poh', team: true },
  { id: 'thuisarts', naam: 'Thuisarts', vast: false, domein: 'thuisarts.nl', voor: 'iedereen', team: true }];
const TEAM_ZIN = 'Nieuws voor het hele team: ook berichten van NVDA (doktersassistenten), NVvPO (praktijkondersteuners) en Thuisarts';
const TEAM_RIJ = 'personeelsscherm-team';
const VOOR_WIE = { artsen: 'artsen', assistentes: 'assistentes', poh: "POH's", iedereen: 'iedereen' };
const TEAM_PER_BRON = 4, EIGEN_ZIN_MAX = 120;
const medischBron = (id) => MEDISCH_BRONNEN.find((b) => b.id === id) || null;
// wv4208: de QR-code van een medisch bericht wijst alleen naar de eigen site van die bron (domein; ook www.)
const medischDomein = (id) => { const b = MEDISCH_BRONNEN.find((x) => x.id === id); return b ? [b.domein] : []; };
// wv4208 (nr 921 = L21): QR-code naast een medisch bericht en bij een infoscherm met een openbare bron, op de tv alleen met een EIGEN registerrij
// (patroon medisch/week); daarvoor alleen in het app-voorbeeld. QR_PX = breedte op het doek (1920×1080; ± 15 cm op een tv van 55 inch).
const QR_RIJ = 'personeelsscherm-qr';
const QR_ZIN = 'QR-code naar het artikel: naast een medisch bericht (NHG, LHV, RIVM) en bij een infoscherm met een openbare bron';
// ── wv4209 (besluitenpagina nr 919 = L19 en nr 920 = L20, David Ja 25-11-2026 met verse vingerafdruk) ──
// (1) Mededelingen: David zet zelf een punt in Komende weken (tekst, datum, eventueel tijd) via Apps › OVIS Scherm › + Mededeling; server.js eist
//     een verse vingerafdruk (zijn knop per bericht; registerrij personeelsscherm-vast: "eigen schermpunten van David"). Bewaard in <dir>/punten.json
//     (dat de module sinds fase 1 al las), label Praktijk; weg na de datum; hooguit 28 dagen vooruit. Socev kan er een voorstellen
//     (POST /smal/personeelsscherm/voorstel): dat staat in de app als voorstel en komt pas op de tv als David het met zijn vingerafdruk overneemt.
// (2) Feestdagen in Komende weken, en per vaste bron (scherm-id van de weekset) de keuze "mag vanzelf": schermen van zo'n bron komen zonder
//     knop per set op de tv (set.vanzelf in infoschermen.json; zelfde vorm- en inhoudsregels als een infoscherm). Beide alleen met een EIGEN
//     registerrij VANZELF_RIJ (naast de basisrij, met INFO_ZIN voor de schermen); daarvoor alleen als proef in de app. Elke bron staat uit tot
//     David hem in de app aanzet (vingerafdruk); uitzetten werkt meteen, zonder vingerafdruk.
const MEDEDELING_MAX = 12, MEDEDELING_TITEL_MAX = 80, MEDEDELING_DAGEN = 28, VOORSTEL_MAX = 5, VOORSTEL_BEWAAR_MS = 7 * 24 * UUR;
const VANZELF_RIJ = 'personeelsscherm-vanzelf';
const FEEST_ZIN = 'Komende weken: ook de landelijke feestdagen (alleen naam en datum)';
const VANZELF_ZIN = 'Infoschermen van een vaste bron die David in de app op «mag vanzelf» zette';
const VASTE_BRONNEN = [
  { id: 'wijk', naam: 'Uit de wijk', uitleg: 'nieuwsbrief wijk en regio van Huisartsen Eemland' },
  { id: 'nieuws', naam: 'In het nieuws', uitleg: 'LHV, NHG, NZa, VWS en Huisartsen Eemland' },
  { id: 'wor', naam: 'Welzijn op Recept', uitleg: 'Welzijn op Recept in Leusden' },
];
const APP_LINK = 'https://app.socev.dev/?app=personeelsscherm';
const QR_PX = 132;
const MEDISCH_MS = UUR, MEDISCH_OUD_MS = 30 * 24 * UUR, MEDISCH_N = 12, MEDISCH_PER_BLAD = 3, MEDISCH_S = 25, MEDISCH_TEKST_MAX = 220, MEDISCH_BEWAAR = 80;
const BELANGRIJK_MS = 21 * 24 * UUR, BELANGRIJK_DAVID_MS = 28 * 24 * UUR, BELANGRIJK_N = 6;
const MEDISCH_ID = crypto.createHash('sha256').update('medisch:nieuws').digest('hex').slice(0, 16);
const BELANGRIJK_ID = crypto.createHash('sha256').update('medisch:belangrijk').digest('hex').slice(0, 16);
const MEDISCH_VELDEN = ['title', 'pubDate', 'description', 'guid', 'link'];
// gemeten 15-11: alleen 'richtlijn' koos ook reclame ("Altijd toegang tot de NHG-Richtlijnen"); daarom alleen een nieuwe of herziene standaard
const BELANGRIJK_REGEL = /herzien|herziening|gewijzigd|(nieuwe|aangepaste|vernieuwde) (nhg-)?(standaard|richtlijn)|\bcao\b|tarie[fv]|bekostiging|declar|subsidie|oproep|controleer|verplicht|deadline|uiterlijk|let op/i;
const ZORG_REGEL = /gezond|ziek|zorg|vaccin|griep|prik\b|infect|virus|bacter|kanker|bevolkingsonderzoek|screening|huisarts|medic|genees|epidem|uitbraak|besmet|hepatitis|zoönose|soa\b|hiv\b|tubercul|leefstijl|overgewicht|obesitas|roken|alcohol|luchtweg|corona|covid|mpox|mazelen|kinkhoest|pfas/i;
// tekst van derden schoon (zelfde stappen als nieuwsKop, zonder lengte- en adresregel)
function schoonTekst(ruw) {
  let s = String(ruw == null ? '' : ruw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, nieuwsEntiteit);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ');
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, ' ').replace(/\s+/g, ' ').trim();
}
// samenvatting: alleen hele zinnen uit het begin van de beschrijving (≤ 220 tekens; past de eerste zin niet, dan afgekapt met …);
// "Lees meer/het artikel …" en een afgebroken staart ([…]) eraf; een adres of link erin = geen samenvatting (alleen de kop)
function medischTekst(ruw) {
  let s = schoonTekst(ruw).replace(/\s*(\[(…|\.\.\.)\]|…)\s*$/, ' …');
  s = s.replace(/\s*\bLees (het|meer|verder|hier|alles|de|ook)\b[\s\S]*$/i, '').replace(/\s*\bThe post\b[\s\S]*\bappeared first on\b[\s\S]*$/, '').trim();   // wv4210: WordPress-staart (NVDA)
  if (!s || NIEUWS_WEG.test(s)) return '';
  const zinnen = s.match(/[^.!?…]+[.!?]+["”’)]*(?=\s|$)/g) || [];
  let uit = '';
  for (const z of zinnen) { const n = (uit + ' ' + z.trim()).trim(); if ([...n].length > MEDISCH_TEKST_MAX) break; uit = n; if ((uit.match(/[.!?]/g) || []).length >= 2) break; }
  if (!uit) { const t = [...s].slice(0, MEDISCH_TEKST_MAX - 1).join(''); const k = t.lastIndexOf(' '); uit = (k > 80 ? t.slice(0, k) : t).replace(/[\s,.;:–…-]+$/, '') + '…'; }
  return uit;
}
// RSS van één bron → [{id, bron, kop, tekst, ms}] (≤ 30 dagen, niet in de toekomst), of null bij een kapotte feed
function medischItems(xml, bron, t) {
  if (typeof xml !== 'string' || !xml || xml.length > NIEUWS_BYTES_MAX || !bron) return null;
  if (!/<rss[\s>]/.test(xml.slice(0, 4000))) return null;   // foutpagina (html) is geen lege feed
  const ruw = rssItems(xml, MEDISCH_VELDEN);
  if (!ruw) return null;
  const uit = [];
  for (const it of ruw) {
    if (typeof it.title !== 'string' || typeof it.pubDate !== 'string' || it.title.length > 2000 || it.pubDate.length > 200) continue;
    const ms = Date.parse(schoonTekst(it.pubDate).slice(0, 40));
    if (!Number.isFinite(ms) || ms > t + 15 * 60000 || t - ms > MEDISCH_OUD_MS) continue;
    const kop = nieuwsKop(it.title);
    if (!kop) continue;
    const tekst = typeof it.description === 'string' && it.description.length <= 20000 ? medischTekst(it.description) : '';
    if (bron.alleenZorg && !ZORG_REGEL.test(kop + ' ' + tekst)) continue;
    const sl = [it.guid, it.link, it.title].map((x) => (typeof x === 'string' ? schoonTekst(x) : '')).find((x) => x) || kop;
    const id = crypto.createHash('sha256').update(bron.id + ':' + sl.slice(0, 500)).digest('hex').slice(0, 16);
    const url = typeof it.link === 'string' ? openbareUrl(it.link, [bron.domein]) : '';   // wv4208: alleen de artikellink, nooit de guid (?p=…)
    if (!uit.some((x) => x.id === id || x.kop === kop)) uit.push(Object.assign({ id, bron: bron.id, kop, tekst, ms }, url ? { url } : {}));
  }
  return uit;
}
// opgehaalde berichten in de bewaarde lijst (st = {items: {id: {...}}}); David vast/los blijft staan; ouder dan 30 dagen en niet meer
// vast = weg; hooguit MEDISCH_BEWAAR (de nieuwste, vastgehouden eerst)
function medischBijwerken(st, bronId, items, t) {
  const m = st && typeof st === 'object' && st.items && typeof st.items === 'object' ? st.items : {};
  const bron = MEDISCH_BRONNEN.find((b) => b.id === bronId);
  for (const x of Array.isArray(items) ? items : []) {
    const oud = m[x.id];
    const regel = !!bron && bron.vast && BELANGRIJK_REGEL.test(x.kop + ' ' + x.tekst);
    if (oud) { Object.assign(oud, { kop: x.kop, tekst: x.tekst, ms: x.ms }); if (x.url) oud.url = x.url; else delete oud.url; if (!oud.door && !oud.los && regel) { oud.vast_tot = x.ms + BELANGRIJK_MS; oud.door = 'regel'; } }
    else m[x.id] = Object.assign({ bron: x.bron, kop: x.kop, tekst: x.tekst, ms: x.ms, gezien: t, vast_tot: regel ? x.ms + BELANGRIJK_MS : null, door: regel ? 'regel' : null, los: false }, x.url ? { url: x.url } : {});
  }
  const ids = Object.keys(m).filter((id) => { const x = m[id]; return x && Number.isFinite(x.ms) && (t - x.ms <= MEDISCH_OUD_MS || (x.vast_tot && x.vast_tot > t)); })
    .sort((a, b) => (Number(m[b].vast_tot > t) - Number(m[a].vast_tot > t)) || m[b].ms - m[a].ms).slice(0, MEDISCH_BEWAAR);
  const uit = {}; for (const id of ids) uit[id] = m[id];
  return Object.assign({}, st || {}, { items: uit });
}
// wat er nu op de twee pagina's hoort: { nieuws: [...≤12], belangrijk: [...≤6] }; vast = niet ook op Medisch nieuws.
// wv4210: team = ook de teambronnen, hooguit TEAM_PER_BRON per bron op Medisch nieuws (zodat niet 9 van de 12 van één bron komen), en per
// bericht 'voor wie' + Davids eigen zin (alleen zolang hij het vasthoudt). Zonder team precies het oude beeld.
function medischBeeld(st, t, team) {
  const m = st && st.items && typeof st.items === 'object' ? st.items : {};
  const alle = Object.keys(m).map((id) => Object.assign({ id }, m[id])).filter((x) => x && typeof x.kop === 'string' && x.kop && Number.isFinite(x.ms) && MEDISCH_BRONNEN.some((b) => b.id === x.bron && (team || !b.team)));
  const vast = alle.filter((x) => Number.isFinite(x.vast_tot) && x.vast_tot > t)
    .sort((a, b) => (Number(b.door === 'david') - Number(a.door === 'david')) || b.ms - a.ms).slice(0, BELANGRIJK_N);
  const vastIds = new Set(vast.map((x) => x.id));
  const perBron = {};
  const nieuws = alle.filter((x) => !vastIds.has(x.id) && t - x.ms <= MEDISCH_OUD_MS).sort((a, b) => b.ms - a.ms)
    .filter((x) => !team || (perBron[x.bron] = (perBron[x.bron] || 0) + 1) <= TEAM_PER_BRON).slice(0, MEDISCH_N);
  const kaal = (x, metTot) => Object.assign({ bron: x.bron, kop: x.kop, tekst: x.tekst || '', ms: x.ms }, metTot ? { tot: x.vast_tot } : {}, typeof x.url === 'string' && x.url ? { url: x.url } : {},
    team ? { voor: voorVan(x) } : {}, team && metTot && x.door === 'david' && typeof x.zin === 'string' && x.zin ? { zin: x.zin } : {});
  return { nieuws: nieuws.map((x) => kaal(x, false)), belangrijk: vast.map((x) => kaal(x, true)) };
}
// wv4210: 'voor wie' van een bewaard bericht: Davids keuze, anders de standaard van de bron
function voorVan(x) { return x && Object.prototype.hasOwnProperty.call(VOOR_WIE, x.voor) ? x.voor : ((medischBron(x && x.bron) || {}).voor || 'iedereen'); }
// wv4210: Davids eigen zin bij een vastgehouden bericht: één regel platte tekst, ≤ 120 tekens, geen adres of link; '' = weg; null = ongeldig
function eigenZin(ruw) {
  if (ruw == null) return '';
  if (typeof ruw !== 'string' || ruw.length > 1000) return null;
  const z = ruw.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!z) return '';
  return [...z].length > EIGEN_ZIN_MAX || NIEUWS_WEG.test(z) || /[<>]/.test(z) ? null : z;
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
    // wv4141: zonder geboortedatum mag 'verjaardag: MM-DD' (alleen dag en maand; David geeft geen jaar door)
    const v = /^(\d{2})-(\d{2})$/.exec(fm.verjaardag || '');
    const geboren = g ? g[2] + '-' + g[3] : v && echteDatum('2024-' + v[0]) ? v[0] : null;
    uit.push({ voornaam: vn, naam: String(fm.naam).trim().toLowerCase(), geboren, actief });
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
// wv4141 (2C55): wie vandaag jarig is; op maandag ook wie zaterdag of zondag jarig was ('zaterdag' / 'zondag'). Alleen voornaam.
function jarigDag(meds, vandaag) {
  const schrikkel = (j) => (j % 4 === 0 && j % 100 !== 0) || j % 400 === 0;
  const dagen = [[0, 'vandaag']].concat(datumDelen(vandaag).wd === 'ma' ? [[-2, 'zaterdag'], [-1, 'zondag']] : []);
  const uit = [], gezien = new Set();
  for (const [n, wanneer] of dagen) {
    const d = plusDag(vandaag, n), md = d.slice(5);
    for (const m of meds) {
      if (!m.actief || !m.geboren) continue;
      const mmdd = m.geboren === '02-29' && !schrikkel(Number(d.slice(0, 4))) ? '02-28' : m.geboren;
      if (mmdd !== md || gezien.has(m.voornaam + md)) continue;
      gezien.add(m.voornaam + md);
      uit.push({ naam: m.voornaam, wanneer });
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
// ── wv4149: week en feestdagen ──
// Pasen (anonieme Gregoriaanse rekenregel, Meeus/Jones/Butcher) → JJJJ-MM-DD
// ── QR-code (wv4208, 27-11-2026, besluitenpagina nr 921 = L21) ──
// Eigen kleine maker, zodat de module bij fs, path en crypto blijft: bytemodus, foutcorrectie M (± 15 %), versie 1–10 (tot 213 tekens; een
// bronadres is hier ≤ QR_URL_MAX), beste masker volgens de vier strafregels van ISO/IEC 18004. Opbouw zoals de bekende openbare
// referentie (Nayuki, MIT). Uitvoer: een inline <svg> (de CSP van het scherm laat geen externe beelden toe; svg is gewoon opmaak).
const QR_ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];   // ecc-codewoorden per blok, versie 1–10
const QR_BLOK_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];            // aantal blokken, versie 1–10
function qrRuw(v) { let r = (16 * v + 128) * v + 64; if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; } return r; }
const qrData = (v) => Math.floor(qrRuw(v) / 8) - QR_ECC_M[v] * QR_BLOK_M[v];
function qrMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z & 0xff; }
function qrDeler(n) { const r = new Array(n).fill(0); r[n - 1] = 1; let root = 1; for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) { r[j] = qrMul(r[j], root); if (j + 1 < n) r[j] ^= r[j + 1]; } root = qrMul(root, 0x02); } return r; }
function qrRest(data, deler) { const r = deler.map(() => 0); for (const b of data) { const f = b ^ r.shift(); r.push(0); deler.forEach((c, i) => { r[i] ^= qrMul(c, f); }); } return r; }
// tekst → matrix (array van rijen, true = donker) of null als hij niet past
function qrMatrix(tekst) {
  const bytes = [...Buffer.from(String(tekst), 'utf8')];
  let v = 0;
  for (let k = 1; k <= 10; k++) if (4 + (k < 10 ? 8 : 16) + bytes.length * 8 <= qrData(k) * 8) { v = k; break; }
  if (!v) return null;
  const bits = [], zet = (w, n) => { for (let i = n - 1; i >= 0; i--) bits.push((w >>> i) & 1); };
  zet(4, 4); zet(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => zet(b, 8));
  const cap = qrData(v) * 8;
  zet(0, Math.min(4, cap - bits.length)); zet(0, (8 - bits.length % 8) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) zet(p, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // blokken + foutcorrectie, verweven
  const nb = QR_BLOK_M[v], ecl = QR_ECC_M[v], raw = Math.floor(qrRuw(v) / 8), kort = nb - raw % nb, kortLen = Math.floor(raw / nb), del = qrDeler(ecl), blokken = [];
  for (let i = 0, k = 0; i < nb; i++) { const d = data.slice(k, k + kortLen - ecl + (i < kort ? 0 : 1)); k += d.length; const e = qrRest(d, del); if (i < kort) d.push(0); blokken.push(d.concat(e)); }
  const cw = []; for (let i = 0; i < blokken[0].length; i++) blokken.forEach((b, j) => { if (i !== kortLen - ecl || j >= kort) cw.push(b[i]); });
  const n = v * 4 + 17, M = Array.from({ length: n }, () => new Array(n).fill(false)), F = Array.from({ length: n }, () => new Array(n).fill(false));
  const f = (x, y, d) => { M[y][x] = d; F[y][x] = true; };
  for (let i = 0; i < n; i++) { f(6, i, i % 2 === 0); f(i, 6, i % 2 === 0); }
  const zoeker = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy; if (xx >= 0 && xx < n && yy >= 0 && yy < n) f(xx, yy, d !== 2 && d !== 4); } };
  zoeker(3, 3); zoeker(n - 4, 3); zoeker(3, n - 4);
  if (v > 1) {
    const na = Math.floor(v / 7) + 2, stap = Math.floor((v * 8 + na * 3 + 5) / (na * 4 - 4)) * 2, pos = [6];
    for (let p = n - 7; pos.length < na; p -= stap) pos.splice(1, 0, p);
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === na - 1) || (i === na - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) f(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const formaat = (masker) => {
    const d = (0 << 3) | masker; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) f(8, i, bit(i));
    f(8, 7, bit(6)); f(8, 8, bit(7)); f(7, 8, bit(8));
    for (let i = 9; i < 15; i++) f(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) f(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) f(8, n - 15 + i, bit(i));
    f(8, n - 8, true);
  };
  formaat(0);
  if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25); const b = (v << 12) | r;
    for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = n - 11 + i % 3, c = Math.floor(i / 3); f(a, c, d); f(c, a, d); } }
  let i = 0;
  for (let rechts = n - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = rechts - j, y = ((rechts + 1) & 2) === 0 ? n - 1 - vert : vert;
      if (!F[y][x] && i < cw.length * 8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const MASKER = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
  const maskeer = (m) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!F[y][x] && MASKER[m](x, y)) M[y][x] = !M[y][x]; };
  const straf = () => {
    let s = 0, donker = 0;
    const lijn = (get) => { for (let a = 0; a < n; a++) { let run = 1; for (let b = 1; b <= n; b++) { if (b < n && get(a, b) === get(a, b - 1)) run++; else { if (run >= 5) s += run - 2; run = 1; } }
      const rij = Array.from({ length: n }, (_, b) => (get(a, b) ? 1 : 0)).join('');
      for (const p of ['10111010000', '00001011101']) { let k = rij.indexOf(p); while (k >= 0) { s += 40; k = rij.indexOf(p, k + 1); } } } };
    lijn((a, b) => M[a][b]); lijn((a, b) => M[b][a]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = M[y][x]; if (c === M[y][x + 1] && c === M[y + 1][x] && c === M[y + 1][x + 1]) s += 3; }
    for (const r of M) for (const c of r) if (c) donker++;
    return s + (Math.ceil(Math.abs(donker * 20 - n * n * 10) / (n * n)) - 1) * 10;
  };
  let beste = 0, laagst = Infinity;
  for (let m = 0; m < 8; m++) { maskeer(m); formaat(m); const p = straf(); if (p < laagst) { laagst = p; beste = m; } maskeer(m); }
  maskeer(beste); formaat(beste);
  return M;
}
// matrix → <svg> met 4 modules witte rand; px = breedte op het doek van 1920×1080
function qrSvg(tekst, px) {
  const M = qrMatrix(tekst); if (!M) return '';
  const n = M.length, w = n + 8; let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (M[y][x]) d += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z';
  return `<svg class="qr" width="${Number(px)}" height="${Number(px)}" viewBox="0 0 ${w} ${w}" shape-rendering="crispEdges" aria-hidden="true"><rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
// openbaar bronadres voor een QR-code: alleen https, geen inlog/poort/IP/socev.dev, zonder #-deel en zonder volg- of reclameparameters;
// domeinen (optioneel) = de host moet daarop eindigen (medisch: de eigen site van de bron). '' = geen code.
const QR_URL_MAX = 200;
const VOLG_PARAM = /^(utm_[a-z0-9_]*|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|igshid|twclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|_ga|_gl|oly_[a-z_]+|vero_[a-z_]+|s_cid|cmpid|campaign|ref|ref_src)$/i;
function openbareUrl(ruw, domeinen) {
  const s = schoonTekst(ruw);
  if (!s || s.length > 500 || !/^https:\/\//i.test(s)) return '';
  let u; try { u = new URL(s); } catch (e) { return ''; }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^[\d.]+$/.test(h) || /(^|\.)socev\.dev$|(^|\.)local$|(^|\.)internal$/.test(h)) return '';
  if (Array.isArray(domeinen) && !domeinen.some((d) => h === d || h.endsWith('.' + d))) return '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (VOLG_PARAM.test(k)) u.searchParams.delete(k);
  if (!u.searchParams.toString()) u.search = '';
  const uit = u.toString();
  return uit.length <= QR_URL_MAX && /^[\x21-\x7e]+$/.test(uit) ? uit : '';
}
function paasZondag(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mnd = Math.floor((h + l - 7 * m + 114) / 31), dag = ((h + l - 7 * m + 114) % 31) + 1;
  return j + '-' + String(mnd).padStart(2, '0') + '-' + String(dag).padStart(2, '0');
}
// landelijke feestdagen (Bevrijdingsdag alleen in lustrumjaren, Koningsdag op zondag = zaterdag ervoor); alleen de naam, niet "praktijk dicht"
function feestdagen(j) {
  const p = paasZondag(j), kd = j + '-04-27', m = new Map();
  m.set(j + '-01-01', 'Nieuwjaarsdag'); m.set(p, 'Eerste Paasdag'); m.set(plusDag(p, 1), 'Tweede Paasdag');
  m.set(new Date(kd + 'T12:00:00Z').getUTCDay() === 0 ? j + '-04-26' : kd, 'Koningsdag');
  if (j % 5 === 0) m.set(j + '-05-05', 'Bevrijdingsdag');
  m.set(plusDag(p, 39), 'Hemelvaartsdag'); m.set(plusDag(p, 49), 'Eerste Pinksterdag'); m.set(plusDag(p, 50), 'Tweede Pinksterdag');
  m.set(j + '-12-25', 'Eerste Kerstdag'); m.set(j + '-12-26', 'Tweede Kerstdag');
  return m;
}
function feestdag(datum) { return feestdagen(Number(String(datum).slice(0, 4))).get(datum) || ''; }
// welke week: Amsterdamse tijd; vrijdag vanaf 12:00, zaterdag en zondag = de volgende week
function weekMaandag(t) {
  const a = amsDelen(t), volgende = a.dag >= 5 || (a.dag === 4 && a.uur >= 12), ma = plusDag(a.datum, -a.dag);
  return { maandag: volgende ? plusDag(ma, 7) : ma, volgende };
}
// ruwe week (bewaard in stand.week): per werkdag de artsen zoals het railvak ze die dag zou tonen
function weekRooster(rijen, maandag, meds, vol) {
  return { sleutel: maandag, vol: !!vol, dagen: [0, 1, 2, 3, 4].map((k) => { const d = plusDag(maandag, k); return { datum: d, artsen: artsenVandaag(rijen, d, meds, vol) }; }) };
}
// wat de pagina toont, op moment t: alleen als de bewaarde week de week van nu is (anders null); vandaag/voorbij/feestdag per dag
function weekBeeld(w, t) {
  const { maandag, volgende } = weekMaandag(t);
  if (!w || w.sleutel !== maandag || !Array.isArray(w.dagen) || w.dagen.length !== 5) return null;
  const vandaag = ymd(t);
  return { kop: volgende ? 'Volgende week op Tolgaarde' : 'Deze week op Tolgaarde', maandag, volgende, dagen: w.dagen.map((d) => {
    const x = datumDelen(d.datum);
    return { datum: d.datum, wd: x.wd, dg: x.dg, mn: x.mn, vandaag: d.datum === vandaag, voorbij: d.datum < vandaag, feestdag: feestdag(d.datum),
      artsen: (Array.isArray(d.artsen) ? d.artsen : []).map((y) => ({ naam: String(y.naam), wanneer: String(y.wanneer) })) };
  }) };
}
// wv4209: feestdagen in Komende weken (alleen met de eigen rij): Eerste en Tweede … op één regel, op de eerste dag
function feestPunten(vandaag, dagen) {
  const uit = [];
  for (let k = 0; k <= dagen; k++) {
    const d = plusDag(vandaag, k), n = feestdag(d);
    if (!n) continue;
    const v = uit[uit.length - 1], m = /^Tweede (.+)$/.exec(n);
    if (v && m && v.naam === 'Eerste ' + m[1] && plusDag(v.datum, 1) === d) { v.titel = 'Eerste en Tweede ' + m[1]; v.naam = n; continue; }
    uit.push({ datum: d, titel: n, naam: n });
  }
  return uit;
}
function agendaPunten(rijen, vandaag, eigen, feest) {
  const uit = [];
  for (const r0 of rijen) {
    const r = tijdlijnRij(r0);
    if (!r || r.status !== 'actief' || !(r.feed === 'google-hagro' || r.sync_agenda === 'hagro')) continue;
    if (!r.begin_datum || r.begin_datum < vandaag) continue;
    const t = String(r.titel || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    uit.push({ datum: r.begin_datum, sort: r.begin_datum + (r.hele_dag ? '00:00' : hhmmAms(r.begin_tijd)), titel: t,
      tijd: r.hele_dag ? 'hele dag' : hhmmAms(r.begin_tijd) + (r.eind_tijd ? '–' + hhmmAms(r.eind_tijd) : ''), label: 'HAGRO' });
  }
  for (const e of Array.isArray(eigen) ? eigen : []) {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.datum || '') || e.datum < vandaag || e.datum > plusDag(vandaag, AGENDA_DAGEN)) continue;
    const t = String(e.titel || '').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const tijd = /^\d{2}:\d{2}$/.test(e.tijd || '') ? e.tijd : 'hele dag';
    uit.push({ datum: e.datum, sort: e.datum + (tijd === 'hele dag' ? '00:00' : tijd), titel: t, tijd, label: 'Praktijk' });
  }
  if (feest) for (const f of feestPunten(vandaag, AGENDA_DAGEN)) uit.push({ datum: f.datum, sort: f.datum + '00:00', titel: f.titel, tijd: 'hele dag', label: 'Feestdag' });
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
  // wv4141 (2C55): een punt met een eigen datum heeft een einddatum (tot); alleen als het veld er staat (zonder veld: zelfde punt, hash en id als vóór wv4141)
  const punten = Array.isArray(sc.punten) ? sc.punten.map((x) => Object.assign({ titel: schoon(x && x.titel), tekst: schoon(x && x.tekst) },
    x && x.tot != null && x.tot !== '' ? { tot: String(x.tot) } : {})) : [];
  if (punten.some((x) => x.tot !== undefined && !echteDatum(x.tot))) return null;
  if (!kop || kop.length > 40 || intro.length > 160 || !bron || bron.length > 130) return null;
  if (!punten.length || punten.length > 4 || punten.some((x) => !x.titel || x.titel.length > 50 || x.tekst.length > 130)) return null;
  if (!echteDatum(tot)) return null;
  if (INFO_WEG.test([kop, intro, bron].concat(...punten.map((x) => [x.titel, x.tekst])).join(' '))) return null;
  // wv4208: openbaar bronadres voor de QR-code (alleen als het veld er staat; zonder veld blijven kaarttekst, hash en id gelijk). Moet al in
  // de schone vorm staan (openbareUrl verandert niets): dan staat op Davids kaart precies het adres dat in de code komt.
  if (sc.bron_url != null && sc.bron_url !== '') { const u = String(sc.bron_url); if (openbareUrl(u, null) !== u) return null; return { kop, intro, punten, bron, tot, bron_url: u }; }
  return { kop, intro, punten, bron, tot };
}
// de stap op Davids kaart: de volledige schermtekst, letterlijk
function stapTekst(sc, van) {
  return 'Infoscherm «' + sc.kop + '» van ' + datumNl(van) + ' tot en met ' + datumNl(sc.tot) + ': ' + (sc.intro ? sc.intro + ' ' : '') +
    sc.punten.map((x) => x.titel + (x.tekst ? ': ' + x.tekst : '') + (x.tot ? ' (tot en met ' + datumNl(x.tot) + ')' : '')).join(' | ') + ' (bron: ' + sc.bron + (sc.bron_url ? '; QR-code naar ' + sc.bron_url : '') + ')';
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
  if (sch.some((x) => x.punten.some((y) => y.tot !== undefined && (y.tot < set.set || y.tot > x.tot)))) return null;   // wv4141: punt binnen zijn scherm
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
  return crypto.createHash('sha256').update(JSON.stringify([String(sleutel), sc.kop, sc.intro, sc.punten, sc.bron, sc.tot].concat(sc.bron_url ? [sc.bron_url] : []))).digest('hex').slice(0, 16);
}
// wv4209: één mededeling (David in de app, of een voorstel van Socev) gecontroleerd; { fout } of { titel, datum, tijd }
function mededelingNorm(x, vandaag) {
  const titel = aanvraagTekst(x && x.titel);
  if (titel.length < 2) return { fout: 'Schrijf wat er op het scherm moet.' };
  if (titel.length > MEDEDELING_TITEL_MAX) return { fout: 'Houd het korter (hooguit ' + MEDEDELING_TITEL_MAX + ' tekens).' };
  const datum = String((x && x.datum) || '');
  if (!echteDatum(datum)) return { fout: 'Kies een datum.' };
  if (datum < vandaag) return { fout: 'Die datum is al voorbij.' };
  if (datum > plusDag(vandaag, MEDEDELING_DAGEN)) return { fout: 'Hooguit vier weken vooruit.' };
  const tijd = x.tijd == null || x.tijd === '' ? null : String(x.tijd);
  if (tijd !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(tijd)) return { fout: 'Schrijf de tijd als 16:30, of laat hem leeg.' };
  return { titel, datum, tijd };
}
const mededelingId = (m) => crypto.createHash('sha256').update(JSON.stringify([m.titel.toLowerCase(), m.datum, m.tijd || ''])).digest('hex').slice(0, 12);
// wv4209: schermen van een vaste bron uit set.vanzelf, alleen als David die bron in de app aanzette (aan[id].op) vóór of op de setdag; zelfde vorm-
// en inhoudsregels als een infoscherm (infoNorm, einddatum ≤ set + 28, punt binnen zijn scherm). Een ongeldig scherm valt alleen zelf weg.
function vanzelfGeldig(set, aan) {
  if (!set || typeof set !== 'object' || !echteDatum(set.set) || !Array.isArray(set.vanzelf) || set.vanzelf.length > INFO_SET_MAX) return [];
  const uit = [];
  for (const sc of set.vanzelf) {
    const id = String((sc && sc.id) || ''), a = aan && typeof aan === 'object' ? aan[id] : null;
    if (!VASTE_BRONNEN.some((b) => b.id === id) || !a || !Number.isFinite(Number(a.op)) || ymd(Number(a.op)) > set.set) continue;
    const x = infoNorm(sc);
    if (!x || x.tot < set.set || x.tot > plusDag(set.set, INFO_DAGEN_MAX) || x.punten.some((y) => y.tot !== undefined && (y.tot < set.set || y.tot > x.tot))) continue;
    uit.push(Object.assign({ set: set.set, bron_id: id }, x));
  }
  return uit;
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
    'OPDRACHT (machinekamer, OVIS Scherm: extra infoscherm op Davids aanvraag; vaste tekst van de pod, wv3020; herkomst david)',
    '',
    'WAAROM: David vroeg op ' + datumNl(vandaag) + ' in Apps › OVIS Scherm om een extra pagina op de tv in de personeelskamer. Zijn woorden, letterlijk (dit is de opdracht):',
    '«' + tekst + '»',
    '',
    'WAT:',
    '1. Lees (gegeven) ' + F + '/set-bronnen.md (hoe een set gemaakt wordt; mail alleen lezen via mail_zoeken/mail_lezen) en set-concept.json (vorm). node ' + F + '/set.cjs stand.',
    '2. Zoek de inhoud bij betrouwbare bronnen (vault, Davids mail alleen lezen, openbare sites van LHV, NHG, NZa, VWS, RIVM, Huisartsen Eemland, gemeente Leusden). Bron en datum zoals op de bron.',
    '   Groot leesbaar: kop ≤ 40 tekens, intro ≤ 140, 1–4 punten (titel ≤ 40, tekst ≤ 110), bron ≤ 110, einddatum naar de inhoud (standaard 14 dagen, hooguit vandaag + 28).',
    '   Nooit patiëntgegevens, namen van burgers, adressen, mailadressen, telefoonnummers of links. Kan het zo niet (onduidelijk, niet te onderbouwen, past niet op één scherm): geen scherm,',
    '   maar één Voor jou-kaart (besluit) met je vraag aan David in gewone taal (geblokkeerde vervolgrij), en klaar.',
    '3. Set in ' + F + '/set-aanvraag-<wv van deze rij>.json, vorm als set-concept.json met één scherm, plus "aanvraag": "<wv van deze rij>" (dan ziet David in de app',
    '   dat de kaart klaarstaat). Kaart: titel "OVIS Scherm — dit infoscherm tonen?", waarom ≤ 400 (Davids vraag in één zin, waar het op de tv komt: om de beurt met de agenda, 20 s),',
    '   waar "overal", deadline vandaag + 7, na: ["Ja = dit scherm staat binnen 5 minuten op de tv tot de genoemde datum. Nee = niets. Anders = zeg wat er anders moet."].',
    '4. node ' + F + '/set.cjs kaart <set> > <kaart.json> (weigert een ongeldige set); node ' + F + '/scherm-toets.cjs /opt/data/claudebot-src/personeelsscherm.js <set> /tmp/<map> (alles GROEN).',
    '5. Kaartrij: kopieer ' + F + '/opdracht-set-ja.txt naar een werkbestand en zet python3 /opt/data/mk-scripts/werkvoorraad.py zet --ouder-job "$SOCEV_AGENT_RUN"',
    '   --label "machinekamer:personeelsscherm-aanvraag-ja-<wv van deze rij>" --herkomst david --prompt-bestand <werkbestand> --status geblokkeerd',
    '   --geblokkeerd-door "David: Ja op het nieuwe infoscherm" --voor-jou <kaart.json> --samenvatting "OVIS Scherm: nieuw infoscherm op jouw aanvraag ter goedkeuring."',
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
  function registerRij(id = REGISTER_RIJ) {
    try { const r = JSON.parse(fs.readFileSync(registerPad, 'utf8')); return (r && Array.isArray(r.rijen) && r.rijen.find((x) => x && x.id === id && x.status === 'aan')) || null; }
    catch (e) { return null; }
  }
  function toestemming() { return !!registerRij(); }
  // wv3015: wat de tekst van de rij toestaat (bij verschil geldt de tekst, registerkop)
  function rijMag(zin, id) { const r = registerRij(id); return !!r && Array.isArray(r.tekst) && r.tekst.map(String).join(' ').replace(/\s+/g, ' ').includes(zin); }
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
      if (g) for (const x of g) if (x.set <= vandaag && x.tot >= vandaag) uit.push(Object.assign({ id: schermId(set.sleutel, x), sleutel: set.sleutel }, x));
      // wv4209: schermen van een bron die David op 'mag vanzelf' zette (alleen met de eigen rij); id op 'vanzelf:<setdag>'
      if (vanzelfMag()) for (const x of vanzelfGeldig(set, vanzelfAan())) if (x.set <= vandaag && x.tot >= vandaag) uit.push(Object.assign({ id: schermId('vanzelf:' + set.set, x), sleutel: 'vanzelf' }, x));
    }
    // wv4141 (2C55): nieuw vervangt oud — per kop (zonder hoofdletters) telt alleen het scherm uit de nieuwste set (gelijke datum: de laatste in
    // het bestand); de rest is vervangen. Bepaald vóór het uit-filter (Codex MOET 1): zet David het nieuwe uit, dan komt het oude niet terug.
    const nieuwst = new Map();
    uit.forEach((x, k) => { const kk = schoon(x.kop).toLowerCase(), b = nieuwst.get(kk); if (b === undefined || x.set >= uit[b].set) nieuwst.set(kk, k); });
    return uit.map((x, k) => Object.assign(x, { vervangen: nieuwst.get(schoon(x.kop).toLowerCase()) !== k }));
  }
  // wv3020: wat David in de app uitzette (stand.info_uit, op id) blijft van de tv tot hij het weer aanzet of het scherm verloopt
  const uitLijst = () => { const u = leesStand().info_uit; return u && typeof u === 'object' ? u : {}; };
  // vrijgegeven infoschermen van vandaag die op de tv horen: goedgekeurd, binnen de looptijd, niet uitgezet; hooguit INFO_MAX (de nieuwste)
  // wv4141: een vervangen scherm alleen als David het in de app weer aanzette (stand.info_naast); punten over hun einddatum vallen weg,
  // een scherm zonder punten ook
  const naastLijst = () => { const u = leesStand().info_naast; return u && typeof u === 'object' ? u : {}; };
  function infoSchermen(vandaag) {
    const u = uitLijst(), nb = naastLijst();
    return infoKandidaten(vandaag).filter((x) => !u[x.id] && (!x.vervangen || nb[x.id]))
      .map((x) => Object.assign({}, x, { punten: x.punten.filter((y) => !y.tot || y.tot >= vandaag) })).filter((x) => x.punten.length).slice(-INFO_MAX);
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
  // ── medisch nieuws (wv3154) ──
  // ophalen zodra de basisrij aan staat (ook vóór de Ja: dan alleen als proef in de app); op de tv alleen met MEDISCH_ZIN en niet uit
  const medischMag = () => toestemming() && rijMag(MEDISCH_ZIN, MEDISCH_RIJ);   // eigen rij, en alleen naast de basisrij
  const teamMag = () => medischMag() && rijMag(TEAM_ZIN, TEAM_RIJ);   // wv4210: eigen rij, alleen naast de medische en de basisrij
  const medischBinnenUur = (s, t) => !!s.medisch_poging && t >= s.medisch_poging && t - s.medisch_poging < MEDISCH_MS;
  // hooguit elk uur één ronde langs de bronnen (ook een mislukte telt); een bron die faalt houdt zijn bewaarde berichten (gedateerd, ≤ 30 dagen)
  async function medischVers(t) {
    const s0 = leesStand();
    if (medischBinnenUur(s0, t)) return s0.medisch || null;
    wijzig((x) => { x.medisch_poging = t; });
    const opgehaald = [], status = {};
    if (typeof o.medisch === 'function') {
      for (const b of MEDISCH_BRONNEN) {
        let klok = null;
        try {
          const xml = await Promise.race([Promise.resolve().then(() => o.medisch(b.id)), new Promise((_, nee) => { klok = setTimeout(() => nee(new Error('timeout')), nieuwsTimeout); })]);
          const it = medischItems(xml, b, t);
          if (!it) throw new Error('kapot');
          opgehaald.push([b.id, it]); status[b.id] = { ok: t, n: it.length, fout: null };
        } catch (e) { status[b.id] = null; fout('personeelsscherm-medisch', new Error('medisch nieuws ' + b.id + ' ophalen faalde')); }   // nooit inhoud of adres
        finally { if (klok) clearTimeout(klok); }
      }
    }
    // binnen wijzig: een vastzet-tik van David tijdens het ophalen blijft staan
    return wijzig((x) => { let st = x.medisch || { items: {} }; for (const [id, it] of opgehaald) st = medischBijwerken(st, id, it, t); st = medischBijwerken(st, '', [], t);
      st.bronnen = Object.assign({}, st.bronnen || {}, Object.fromEntries(Object.entries(status).map(([k, v]) => [k, v || Object.assign({ ok: null, n: 0 }, (st.bronnen || {})[k] || {}, { fout: t })]))); x.medisch = st; }).medisch;
  }
  // wat de tv mag tonen: alleen met de registerzin en per pagina niet uitgezet (altijd opnieuw tegen de bewaarde lijst en de klok)
  function medischOpTv(s, t) {
    if (!toestemming() || !medischMag()) return null;
    const team = teamMag(), u = uitLijst(), b = medischBeeld(s.medisch, t, team);
    const m = Object.assign({ nieuws: u[MEDISCH_ID] ? [] : b.nieuws, belangrijk: u[BELANGRIJK_ID] ? [] : b.belangrijk }, team ? { team: true } : {});
    return m.nieuws.length || m.belangrijk.length ? m : null;
  }
  // ── weekpagina (wv4149) ──
  // op de tv alleen met de eigen rij (naast de basisrij), niet uitgezet in de app, en volle namen nooit zonder de zin in de basisrij
  const weekMag = () => toestemming() && rijMag(WEEK_ZIN, WEEK_RIJ);
  const qrMag = () => toestemming() && rijMag(QR_ZIN, QR_RIJ);   // wv4208: eigen rij, alleen naast de basisrij
  function weekOpTv(s, t) {
    if (!weekMag() || uitLijst()[WEEK_ID]) return null;
    if (s && s.week && s.week.vol && !volleNaamMag()) return null;
    return weekBeeld(s && s.week, t);
  }
  const puntenPad = path.join(dir, 'punten.json');
  function eigenPunten() { try { const j = JSON.parse(fs.readFileSync(puntenPad, 'utf8')); return Array.isArray(j) ? j : []; } catch (e) { return []; } }
  // wv4209: punten.json alleen hier geschreven (0600, atomair); verlopen punten gaan er bij elke schrijfbeurt uit
  function puntenSchrijf(lijst) { const tmp = puntenPad + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(lijst, null, 1), { mode: 0o600 }); fs.renameSync(tmp, puntenPad); }
  // wv4209: eigen rij voor feestdagen en 'mag vanzelf' (naast de basisrij; schermen ook alleen met INFO_ZIN in de basisrij)
  const feestMag = () => toestemming() && rijMag(FEEST_ZIN, VANZELF_RIJ);
  const vanzelfMag = () => toestemming() && infoMag() && rijMag(VANZELF_ZIN, VANZELF_RIJ);
  const vanzelfAan = () => { const v = leesStand().vanzelf; return v && typeof v === 'object' ? v : {}; };
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
    const wm = weekMaandag(t).maandag;   // wv4149 (Codex MOET 1): vanaf de maandag van de getoonde week, ook midden in de week
    if (typeof o.tijdlijn === 'function') {
      try { const r = await o.tijdlijn(wm < vandaag ? wm : vandaag, plusDag(vandaag, AGENDA_DAGEN)); if (Array.isArray(r)) rijen = r; else throw new Error('x'); }
      catch (e) { fout('personeelsscherm-agenda', new Error('tijdlijn lezen faalde')); }
    }
    const meds = aan ? leesMedewerkers(o.vault, vandaag) : [];
    const weer = await weerVers(s, t);
    const nieuws = aan ? await nieuwsVers(s, t) : null;   // wv3023
    if (aan) await medischVers(t);   // wv3154 (schrijft zelf in de stand)
    const inhoud = {
      datum: vandaag,
      weer: weer || null,
      agenda: rijen ? agendaPunten(rijen, vandaag, eigenPunten(), feestMag()) : (Array.isArray(oud.agenda) ? oud.agenda : []),
      feest_tv: feestMag(),   // wv4209: rij erbij/weg = meteen opnieuw verzamelen
      artsen: aan ? (rijen ? artsenVandaag(rijen, vandaag, meds, vol) : (oud.datum === vandaag && Array.isArray(oud.artsen) && !!oud.volle_naam === vol ? oud.artsen : [])) : null,
      jarig: aan ? jarigen(meds, vandaag) : null,
      jarig_dag: aan ? jarigDag(meds, vandaag) : null,   // wv4141
      persoonsvakken: aan,
      volle_naam: vol,
      info: aan ? infoSchermen(vandaag) : [],
      nieuws: nieuws || null,
      bronnen: { agenda: !!rijen, weer: !!weer, medewerkers: aan ? meds.length : null },
    };
    inhoud.bronnen.info = inhoud.info.length;
    inhoud.bronnen.nieuws = nieuws ? nieuws.items.length : 0;
    // wv3154: wat er nu op de tv zou staan (voor de vergelijking: nieuw bericht, verlopen, zin erbij/weg = nieuwe envelop)
    inhoud.medisch = medischOpTv(leesStand(), t);
    inhoud.medisch_tv = aan && medischMag();
    if (aan && teamMag()) inhoud.team_tv = true;   // wv4210: rij erbij/weg = nieuwe envelop (zonder rij geen veld: inhoud-sha gelijk)
    inhoud.qr_tv = aan && qrMag();   // wv4208: rij erbij/weg = nieuwe envelop
    inhoud.bronnen.medisch = inhoud.medisch ? inhoud.medisch.nieuws.length + inhoud.medisch.belangrijk.length : 0;
    // wv4149: weekrooster bewaard zodra de basisrij aan is (proef in de app); tijdlijn mislukt = het oude alleen als het dezelfde week is.
    // Zonder basisrij geen namen in de stand. inhoud.week = alleen wat op de tv mag (verandering = nieuwe envelop).
    const week = !aan ? null : rijen ? weekRooster(rijen, wm, meds, vol) : (s.week && s.week.sleutel === wm && !!s.week.vol === vol ? s.week : null);
    inhoud.week = weekOpTv({ week }, t);
    inhoud.bronnen.week = inhoud.week ? inhoud.week.dagen.length : 0;
    const ish = crypto.createHash('sha256').update(JSON.stringify(inhoud.info)).digest('hex');
    wijzig((x) => { x.inhoud = inhoud; x.inhoud_op = t; x.week = week; x.weer = s.weer || null; x.weer_op = s.weer_op || null; x.info_sha = ish;
      if (s.nieuws_poging) { x.nieuws = s.nieuws || null; x.nieuws_poging = s.nieuws_poging; } });
    return inhoud;
  }
  // vaste delen van het moment (voorbeeld zonder script): dag en klok in Amsterdamse tijd
  function schermInhoud(s, t) {
    const a = amsDelen(t), d = datumDelen(a.datum);
    const i = s.inhoud && s.inhoud.datum === a.datum ? s.inhoud : Object.assign({}, s.inhoud || {}, { artsen: s.inhoud && s.inhoud.artsen ? [] : null, jarig: s.inhoud && s.inhoud.jarig ? [] : null, jarig_dag: null });
    // persoonsvakken nooit zonder rij, ook niet uit een oude stand
    const aan = toestemming();
    // wv3015: volle namen nooit zonder de zin in de rij (ook niet uit een oude stand); infoschermen alleen met de rij en vóór hun einddatum
    const artsen = aan && i.artsen && !!i.volle_naam && !volleNaamMag() ? [] : i.artsen;
    // Fable ZOU 4: bij elke publicatie (ook noodknop uit) opnieuw tegen de Ja, niet uit de stand
    const info = aan ? infoSchermen(a.datum) : [];
    // wv3023: nieuws bij elke publicatie opnieuw tegen registerzin, uit-knop en leeftijd (nooit uit een oude stand doorgeschoven)
    const nieuws = aan && nieuwsActief() && nieuwsGeldig(i.nieuws, t) ? i.nieuws : null;
    // wv3154: medisch nieuws ook bij elke publicatie opnieuw tegen registerzin, uit-knoppen, vasthoudtermijn en leeftijd
    const medisch = medischOpTv(s, t);
    // wv4141: felicitatiepagina alleen met de registerrij, van vandaag en niet uitgezet
    const jarig_dag = aan && Array.isArray(i.jarig_dag) && i.jarig_dag.length && !uitLijst()[JARIG_ID] ? i.jarig_dag : null;
    // wv4149: weekpagina bij elke publicatie opnieuw tegen rij, zin, uit-knop en de week van nu (nooit uit een oude stand doorgeschoven)
    const week = aan ? weekOpTv(s, t) : null;
    return Object.assign({}, i, { artsen: aan ? artsen : null, jarig: aan ? i.jarig : null, jarig_dag, week, info, nieuws, medisch, qr: aan && qrMag(),   // wv4208
      wd_tekst: d.wdl, dag_tekst: d.dg + ' ' + d.mnl, klok_tekst: String(a.uur).padStart(2, '0') + ':' + String(a.min).padStart(2, '0') });
  }
  function inhoudSha(i) { const c = Object.assign({}, i || {}); delete c.bronnen; return crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'); }

  // ── envelop ──
  // wv4208: buiten het inhoudvenster (werkdag 06:45–18:30) een rust-envelop: zwart met klok, zonder inhoud (geen namen 's nachts in het bestand)
  function envelop(s, t, leeg) {
    const volgnr = Math.max(Number(s.volgnr || 0) + 1, t);
    const rust = !leeg && !inhoudVenster(t);
    const doc = { v: 1, soort: 'scherm', volgnr, gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg,
      html: bouwHtml({ gemaakt: t, houdbaar_tot: t + HOUDBAAR_MS, leeg: !!leeg, rust, logoSvg: leeg || rust ? null : logoSvg(), inhoud: leeg ? null : schermInhoud(s, t) }),
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
    const rust = !aan && !inhoudVenster(t);   // wv4208
    const sig = crypto.sign(null, bytes, k);
    await d1([{ sql: 'INSERT INTO envelop (id, volgnr, bytes, sig, op) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET volgnr = excluded.volgnr, bytes = excluded.bytes, sig = excluded.sig, op = excluded.op WHERE excluded.volgnr > envelop.volgnr',
      params: [doc.volgnr, bytes.toString('base64'), sig.toString('base64'), t] }]);
    // wv3020: een knop in de app en de tik kunnen tegelijk publiceren; D1 houdt het hoogste volgnr, de stand ook
    wijzig((x) => { if (Number(x.volgnr || 0) > doc.volgnr) return; x.volgnr = doc.volgnr; x.gemaakt = t; x.houdbaar_tot = doc.houdbaar_tot; x.leeg = aan; x.rust = rust; x.html = doc.html; x.fout = null; x.inhoud_sha = inhoudSha(s.inhoud); });
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
    const x = id === NIEUWS_ID ? (toestemming() && nieuwsMag() ? { tot: '9999-12-31' } : null)
      : id === MEDISCH_ID || id === BELANGRIJK_ID ? (toestemming() && medischMag() ? { tot: '9999-12-31' } : null)   // wv3154: zelfde als het NOS-scherm
      : id === JARIG_ID ? (toestemming() ? { tot: '9999-12-31' } : null)   // wv4141: felicitatiepagina
      : id === WEEK_ID ? (weekMag() ? { tot: '9999-12-31' } : null)   // wv4149: weekpagina, alleen met de eigen rij
      : infoKandidaten(vandaag).find((y) => y.id === id);
    if (aan && !x) return { status: 409, body: { ok: false, fout: 'Dit scherm kan niet meer aan: het is niet (meer) door jou goedgekeurd of de looptijd is voorbij.' } };
    if (!aan && !x && !uitLijst()[id]) return { status: 404, body: { ok: false, fout: 'Dit scherm staat niet (meer) op de tv.' } };
    wijzig((s) => {
      const u = s.info_uit && typeof s.info_uit === 'object' ? s.info_uit : {};
      for (const k of Object.keys(u)) if (!u[k] || !(String(u[k].tot) >= vandaag)) delete u[k];   // verlopen = weg
      if (aan) delete u[id]; else u[id] = { op: nu(), tot: x ? x.tot : vandaag };
      s.info_uit = u;
      // wv4141: een vervangen scherm weer aan = naast het nieuwe tonen (tot zijn einddatum); uit = die keuze weg
      const nb = s.info_naast && typeof s.info_naast === 'object' ? s.info_naast : {};
      for (const k of Object.keys(nb)) if (!nb[k] || !(String(nb[k].tot) >= vandaag)) delete nb[k];
      if (aan && x && x.vervangen) nb[id] = { op: nu(), tot: x.tot }; else delete nb[id];
      s.info_naast = nb;
      if (id === NIEUWS_ID) { s.nieuws_poging = null; if (!aan) s.nieuws = null; }   // wv3023: aan = de volgende tik haalt meteen vers; uit = niets bewaren
    });
    try { await publiceer(); }
    catch (e) {
      fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80)));
      return { status: 503, body: { ok: false, fout: (aan ? 'Aangezet' : 'Uitgezet') + ', maar de tv is nog niet bijgewerkt; dat probeer ik binnen 5 minuten opnieuw.' } };
    }
    return { status: 200, body: { ok: true, id, aan: !!aan } };
  }
  // wv3154: David houdt een bericht vast op Belangrijk (28 dagen vanaf nu) of laat het los (ook een bericht dat de regel koos). Alleen een
  // bericht dat al in de bewaarde lijst staat: dus nooit nieuwe tekst, alleen hoe lang openbare tekst blijft staan. Geen vingerafdruk.
  // wv4210: body.voor (artsen|assistentes|poh|iedereen, of null = standaard van de bron) en body.zin (Davids eigen regel; server.js eist een
  // verse vingerafdruk voor een niet-lege zin, '' haalt weg) passen alleen dat aan, niet het vasthouden. Een zin alleen bij een bericht dat
  // David zelf vasthoudt; loslaten haalt de zin weg, opnieuw vasthouden na het verlopen ook.
  async function medischZet(idRuw, vast, body) {
    const id = String(idRuw == null ? '' : idRuw);
    if (!/^[0-9a-f]{16}$/.test(id)) return { status: 400, body: { ok: false, fout: 'Onbekend bericht.' } };
    if (!toestemming()) return { status: 409, body: { ok: false, fout: 'Het OVIS Scherm toont nu geen berichten.' } };
    const b = body && typeof body === 'object' ? body : {};
    const heeft = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const aanpas = heeft('voor') || heeft('zin');
    if (heeft('voor') && b.voor !== null && !Object.prototype.hasOwnProperty.call(VOOR_WIE, b.voor)) return { status: 400, body: { ok: false, fout: 'Kies artsen, assistentes, POH\'s of iedereen.' } };
    const zin = heeft('zin') ? eigenZin(b.zin) : undefined;
    if (zin === null) return { status: 400, body: { ok: false, fout: 'Eén korte zin (hooguit 120 tekens), zonder link of adres.' } };
    const t = nu();
    let gevonden = false, nietVast = false;
    wijzig((s) => {
      const x = s.medisch && s.medisch.items ? s.medisch.items[id] : null;
      if (!x) return;
      gevonden = true;
      if (aanpas) {
        if (zin && !(x.door === 'david' && Number.isFinite(x.vast_tot) && x.vast_tot > t)) { nietVast = true; return; }
        if (heeft('voor')) { if (b.voor === null) delete x.voor; else x.voor = b.voor; }
        if (zin !== undefined) { if (zin) x.zin = zin; else delete x.zin; }
        return;
      }
      const nogVast = x.door === 'david' && Number.isFinite(x.vast_tot) && x.vast_tot > t;
      if (vast) { Object.assign(x, { vast_tot: t + BELANGRIJK_DAVID_MS, door: 'david', los: false }); if (!nogVast) delete x.zin; }
      else { Object.assign(x, { vast_tot: null, door: null, los: true }); delete x.zin; }
    });
    if (!gevonden) return { status: 404, body: { ok: false, fout: 'Dit bericht staat niet (meer) in de lijst.' } };
    if (nietVast) return { status: 409, body: { ok: false, fout: 'Houd het bericht eerst vast; dan kun je er een eigen zin bij zetten.' } };
    if (!medischMag() || (aanpas && !teamMag())) return { status: 200, body: { ok: true, id, vast: !!vast } };   // proef: nog niet op de tv (voor wie/zin alleen met de teamrij)   // proef: nog niet op de tv, dus niets te publiceren
    try { await publiceer(); }
    catch (e) {
      fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80)));
      return { status: 503, body: { ok: false, fout: 'Opgeslagen, maar de tv is nog niet bijgewerkt; dat probeer ik binnen 5 minuten opnieuw.' } };
    }
    return { status: 200, body: { ok: true, id, vast: !!vast } };
  }
  // ── wv4209: mededelingen, voorstellen van Socev en 'mag vanzelf' ──
  // na een wijziging meteen opnieuw verzamelen en publiceren; lukt dat niet, dan doet de volgende tik het (inhoud_op terug)
  async function herbouw(t, wat) {
    try { await verzamel(t); await publiceer(); return null; }
    catch (e) { fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80))); wijzig((x) => { x.inhoud_op = 0; }); return wat + ', maar de tv is nog niet bijgewerkt; dat probeer ik binnen 5 minuten opnieuw.'; }
  }
  const voorstellenNu = (s, t) => (Array.isArray(s.mededeling_voorstellen) ? s.mededeling_voorstellen : []).filter((v) => v && t - Number(v.op) < VOORSTEL_BEWAAR_MS && v.datum >= ymd(t));
  // POST mededeling: {titel, datum, tijd?} = nieuw (David; server.js eiste de verse vingerafdruk), {voorstel: id} = voorstel van Socev overnemen
  // (idem), {voorstel: id, laat: true} = voorstel laten liggen, {weg: id} = van het scherm halen (beide zonder vingerafdruk: haalt alleen weg)
  let mededelingBezig = false;
  async function mededelingZet(b) {
    b = b && typeof b === 'object' ? b : {};
    const t = nu(), vandaag = ymd(t);
    if (b.voorstel != null && b.laat === true) {
      const id = String(b.voorstel); let weg = false;
      wijzig((s) => { const v = Array.isArray(s.mededeling_voorstellen) ? s.mededeling_voorstellen : []; s.mededeling_voorstellen = v.filter((x) => { const h = x && x.id === id; weg = weg || h; return !h; }); });
      return weg ? { status: 200, body: { ok: true, voorstel: id, laat: true } } : { status: 404, body: { ok: false, fout: 'Dit voorstel staat er niet (meer).' } };
    }
    if (mededelingBezig) return { status: 409, body: { ok: false, fout: 'Er wordt net iets op het scherm gezet; probeer het zo opnieuw.' } };
    mededelingBezig = true;
    try {
      let lijst = eigenPunten().filter((x) => x && echteDatum(x.datum) && x.datum >= vandaag);
      if (b.weg != null) {
        const id = String(b.weg), n = lijst.length;
        lijst = lijst.filter((x) => x.id !== id);
        if (lijst.length === n) return { status: 404, body: { ok: false, fout: 'Deze mededeling staat niet (meer) op het scherm.' } };
        puntenSchrijf(lijst);
        const w = await herbouw(t, 'Weggehaald');
        return w ? { status: 503, body: { ok: false, fout: w } } : { status: 200, body: { ok: true, weg: id } };
      }
      let bron = b, door = 'david', vid = null;
      if (b.voorstel != null) {
        vid = String(b.voorstel);
        bron = voorstellenNu(leesStand(), t).find((x) => x.id === vid);
        if (!bron) return { status: 404, body: { ok: false, fout: 'Dit voorstel staat er niet (meer).' } };
        door = 'socev';
      }
      const m = mededelingNorm(bron, vandaag);
      if (m.fout) return { status: 400, body: { ok: false, fout: m.fout } };
      const id = mededelingId(m), al = lijst.some((x) => x.id === id);
      if (!al && lijst.length >= MEDEDELING_MAX) return { status: 409, body: { ok: false, fout: 'Er staan al ' + MEDEDELING_MAX + ' mededelingen klaar; haal er eerst een weg.' } };
      if (!al) { lijst.push({ id, titel: m.titel, datum: m.datum, tijd: m.tijd, op: t, door }); lijst.sort((x, y) => (x.datum + (x.tijd || '')).localeCompare(y.datum + (y.tijd || ''))); puntenSchrijf(lijst); }
      if (vid) wijzig((s) => { s.mededeling_voorstellen = (Array.isArray(s.mededeling_voorstellen) ? s.mededeling_voorstellen : []).filter((x) => x && x.id !== vid); });
      const w = al ? null : await herbouw(t, 'Opgeslagen');
      return w ? { status: 503, body: { ok: false, fout: w, opgeslagen: true } } : { status: 200, body: { ok: true, id, al } };
    } finally { mededelingBezig = false; }
  }
  // /smal/personeelsscherm/voorstel (server.js, Socev-sleutel of machinekamer): alleen bewaren als voorstel; nooit op de tv zonder Davids tik
  function voorstel(b) {
    const t = nu(), m = mededelingNorm(b || {}, ymd(t));
    if (m.fout) return { status: 400, j: { ok: false, fout: m.fout } };
    const id = mededelingId(m);
    wijzig((s) => { const v = voorstellenNu(s, t).filter((x) => x.id !== id); s.mededeling_voorstellen = v.slice(-(VOORSTEL_MAX - 1)).concat([{ id, titel: m.titel, datum: m.datum, tijd: m.tijd, op: t }]); });
    const d = datumDelen(m.datum);
    return { status: 200, j: { ok: true, id, link: APP_LINK, op_scherm: d.wd + ' ' + d.dg + ' ' + d.mn + ' · ' + (m.tijd || 'hele dag') + ' · ' + m.titel + ' (Praktijk)',
      uitleg: 'Staat als voorstel in Apps › OVIS Scherm; het komt pas op de tv als David het daar met zijn vingerafdruk overneemt.' } };
  }
  // POST vanzelf {bron, aan}: aan = server.js eiste de verse vingerafdruk; uit = meteen, zonder
  async function vanzelfZet(bronRuw, aan) {
    const bron = String(bronRuw == null ? '' : bronRuw);
    if (!VASTE_BRONNEN.some((x) => x.id === bron)) return { status: 400, body: { ok: false, fout: 'Onbekende bron.' } };
    const t = nu();
    wijzig((s) => { const v = s.vanzelf && typeof s.vanzelf === 'object' ? s.vanzelf : {}; if (aan) { if (!v[bron]) v[bron] = { op: t }; } else delete v[bron]; s.vanzelf = v; });
    if (vanzelfMag()) { const w = await herbouw(t, aan ? 'Aangezet' : 'Uitgezet'); if (w) return { status: 503, body: { ok: false, fout: w } }; }
    return { status: 200, body: { ok: true, bron, aan: !!aan } };
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
      try { z = await o.werkvoorraad({ label, prompt: aanvraagOpdracht(tekst, dag), samenvatting: ('OVIS Scherm: David vraagt een extra pagina — ' + tekst).slice(0, 200), notitie: 'pod wv3020: Apps › OVIS Scherm, Nieuwe pagina' }); }
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
    const lijst = [{ id: 'hoofd', soort: 'hoofd', titel: 'Komende weken', looptijd_s: opTv.length || inh.nieuws || inh.medisch || inh.jarig_dag || inh.week ? INFO_HOOFD_S : null, aan: true, uit: false }];
    // wv4141: felicitatiepagina (alleen met de registerrij); voorbeeld met wie vandaag jarig is, of de uitlegregel
    if (toestemming()) {
      const jdNu = s.inhoud && s.inhoud.datum === vandaag && Array.isArray(s.inhoud.jarig_dag) ? s.inhoud.jarig_dag : [];
      lijst.push({ id: JARIG_ID, soort: 'info', titel: 'Gefeliciteerd (jarig vandaag)', looptijd_s: INFO_S, van: null, tot: null, aan: !!inh.jarig_dag, uit: !!u[JARIG_ID],
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [], nieuws: null, medisch: null, jarig_dag: jdNu, jarig_leeg: true }), toon: 1 }) });
    }
    // wv4149: weekpagina; vóór de Ja (geen eigen rij) alleen als proef: voorbeeld met het bewaarde rooster, niet op de tv, geen aan-knop
    if (toestemming()) {
      const mag = weekMag(), wb = weekBeeld(s.week, t);
      const leegWeek = { kop: weekMaandag(t).volgende ? 'Volgende week op Tolgaarde' : 'Deze week op Tolgaarde', maandag: null, dagen: [] };
      lijst.push({ id: WEEK_ID, soort: 'info', titel: 'Deze week op Tolgaarde', looptijd_s: WEEK_S, van: null, tot: null, proef: !mag, aan: !!inh.week, uit: !!u[WEEK_ID],
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [], jarig_dag: null, nieuws: null, medisch: null, week: wb || leegWeek }), toon: 1 }) });
    }
    // wv3023: nieuwsscherm (alleen met de registerzin); voorbeeld met de koppen die nu op de tv staan, of de uitlegregel als er geen vers nieuws is
    if (toestemming() && nieuwsMag()) {
      lijst.push({ id: NIEUWS_ID, soort: 'info', titel: 'Nieuws (NOS)', looptijd_s: INFO_S, van: null, tot: null, aan: !!inh.nieuws, uit: !!u[NIEUWS_ID],
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [], jarig_dag: null, nieuws: inh.nieuws || { items: [] }, medisch: null }), toon: 1 }) });
    }
    // wv3154: Medisch nieuws en Belangrijk; vóór de Ja (geen registerzin) alleen als proef: niet op de tv, wel het voorbeeld en de berichtenlijst
    if (toestemming() && (typeof o.medisch === 'function' || medischMag())) {   // pod zonder ophaler en zonder zin: geen lege proefpagina's
      const mag = medischMag(), team = teamMag(), b = medischBeeld(s.medisch, t, true), opT = mag ? (inh.medisch || { nieuws: [], belangrijk: [] }) : { nieuws: [], belangrijk: [] };
      const m = s.medisch && s.medisch.items ? s.medisch.items : {};
      const lijstVan = (sel) => Object.keys(m).map((id) => Object.assign({ id }, m[id])).filter(sel).sort((a, c) => c.ms - a.ms).slice(0, 20)
        .map((x) => ({ id: x.id, bron: (MEDISCH_BRONNEN.find((y) => y.id === x.bron) || { naam: '' }).naam, kop: x.kop, ms: x.ms, vast: Number.isFinite(x.vast_tot) && x.vast_tot > t, tot: Number.isFinite(x.vast_tot) && x.vast_tot > t ? x.vast_tot : null, door: x.door || null,
          voor: voorVan(x), zin: typeof x.zin === 'string' && x.zin ? x.zin : null, team: !!(medischBron(x.bron) || {}).team, team_proef: !team }));   // wv4210
      // wv4210: het voorbeeld toont altijd het teambeeld (proef tot de teamrij er is; team_proef in de berichtenlijst)
      const vb = (md, toon) => bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [], jarig_dag: null, nieuws: null, medisch: md, qr: true }), toon });   // wv4208: QR in het voorbeeld (proef tot de rij er is)
      lijst.push({ id: MEDISCH_ID, soort: 'info', titel: 'Medisch nieuws', looptijd_s: MEDISCH_S, van: null, tot: null, proef: !mag, aan: opT.nieuws.length > 0, uit: !!u[MEDISCH_ID],
        html: vb({ nieuws: b.nieuws, belangrijk: null, leeg_tonen: true, team: true }, 1),
        berichten: lijstVan((x) => !(Number.isFinite(x.vast_tot) && x.vast_tot > t) && t - x.ms <= MEDISCH_OUD_MS) });
      lijst.push({ id: BELANGRIJK_ID, soort: 'info', titel: team ? 'Belangrijk' : 'Belangrijk (LHV, NHG)', looptijd_s: MEDISCH_S, van: null, tot: null, proef: !mag, aan: opT.belangrijk.length > 0, uit: !!u[BELANGRIJK_ID],
        html: vb({ nieuws: null, belangrijk: b.belangrijk, leeg_tonen: true, team: true }, 1),
        berichten: lijstVan((x) => Number.isFinite(x.vast_tot) && x.vast_tot > t) });
    }
    for (const x of kand) {
      const k = opTv.indexOf(x.id);
      // wv4141: vervangen (zelfde kop in een nieuwere set) = niet op de tv, in de app 'Weer op de tv' (dan naast het nieuwe)
      const verv = !!x.vervangen && k < 0 && !u[x.id];
      const sc = Object.assign({}, x, { punten: x.punten.filter((y) => !y.tot || y.tot >= vandaag) }, k >= 0 ? { stip: [k, opTv.length] } : { lab: u[x.id] ? 'Staat uit' : verv ? 'Vervangen' : 'Wacht op een plek' });
      lijst.push({ id: x.id, soort: 'info', titel: verv ? x.kop + ' · vervangen door nieuwer' : x.kop, looptijd_s: INFO_S, van: x.set, tot: x.tot, aan: k >= 0, uit: !!u[x.id] || verv, vervangen: verv,
        html: bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [sc], jarig_dag: null, nieuws: null, medisch: null, qr: true }), toon: 1 }) });
    }
    let sets = [], vr = {};
    try { const j = JSON.parse(infoBestand() || '{}'); sets = Array.isArray(j.sets) ? j.sets : []; vr = JSON.parse(fs.readFileSync(vragenPad, 'utf8')); } catch (e) { /* stand blijft wacht */ }
    // wv4209: een set die op Davids Ja wacht (hooguit 7 dagen oud) en schermen van een bron op 'mag vanzelf' zonder de eigen rij: als proef
    // (voorbeeld zoals op de tv, geen aan-knop), zodat de vrijdagkaart naar Apps › OVIS Scherm kan wijzen in plaats van alles uit te schrijven
    if (toestemming() && infoMag()) {
      const vb = (sc) => bouwHtml({ gemaakt: s.gemaakt || t, houdbaar_tot: t + HOUDBAAR_MS, leeg: false, logoSvg: null, inhoud: Object.assign({}, inh, { info: [sc], jarig_dag: null, nieuws: null, medisch: null, qr: true }), toon: 1 });
      const al = new Set(lijst.map((x) => x.id));
      for (const set of sets) {
        let g = null, k = null; try { g = setGeldig(set, vr); k = g ? null : setKaart(set); } catch (e) { g = null; k = null; }
        if (k && set.set >= plusDag(vandaag, -7) && /^wv\d{1,7}$/.test(String(set.sleutel || ''))) for (const x of k.schermen) {
          if (x.tot < vandaag) continue;
          const id = schermId(set.sleutel, x); if (al.has(id)) continue; al.add(id);
          lijst.push({ id, soort: 'info', titel: x.kop + ' · wacht op je Ja', looptijd_s: INFO_S, van: set.set, tot: x.tot, proef: true, concept: true, aan: false, uit: false, html: vb(Object.assign({ set: set.set }, x)) });
        }
        if (!vanzelfMag()) for (const x of vanzelfGeldig(set, vanzelfAan())) {
          if (x.tot < vandaag) continue;
          const id = schermId('vanzelf:' + set.set, x); if (al.has(id)) continue; al.add(id);
          lijst.push({ id, soort: 'info', titel: x.kop + ' · mag vanzelf (nog niet op de tv)', looptijd_s: INFO_S, van: set.set, tot: x.tot, proef: true, aan: false, uit: false, html: vb(x) });
        }
      }
    }
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
    if (!c || !c.account || !c.access_app_id || !c.access_app || !c.eigenaar) return { status: 503, body: { ok: false, fout: 'Het OVIS Scherm is nog niet ingericht; meld het de machinekamer.' } };
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
      try { await melding('personeelsscherm-koppel:' + token.id, 'OVIS Scherm: kastje gekoppeld (' + iso(t0).slice(0, 16) + ' UTC). Sleutel ' + TOKEN_NAAM + ' (id ' + token.id + ') verloopt ' + iso(token.verloopt).slice(0, 10) + ', werkt alleen vanaf het adres waarmee de code werd aangevraagd. Zet de rij in het sleutelregister.'); } catch (e) { fout('personeelsscherm-melding', e); }
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
    if (!c) return { status: 503, body: { ok: false, fout: 'Het OVIS Scherm is nog niet ingericht.' } };
    if (bezig) return { status: 409, body: { ok: false, fout: 'Er loopt al een koppeling; wacht even.' } };
    bezig = true;
    try {
      await zorgSchema();
      const id = (leesStand().token || {}).id;
      await intrekIntern(c);
      try { await melding('personeelsscherm-intrek:' + (id || nu()), 'OVIS Scherm: sleutel ' + TOKEN_NAAM + (id ? ' (id ' + id + ')' : '') + ' ingetrokken via de app. Zet de rij in het sleutelregister op ingetrokken.'); } catch (e) { fout('personeelsscherm-melding', e); }
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
        rust: !!s.rust, schermtijd: 'werkdagen 07:00–18:30',   // wv4208: nu zwart met klok (buiten schermtijd)
        scherm: s.volgnr ? { volgnr: s.volgnr, gemaakt: s.gemaakt, houdbaar_tot: s.houdbaar_tot } : null,
        token: s.token ? { aangemaakt: s.token.aangemaakt, verloopt: s.token.verloopt, ip_eis: !!s.token.ip_eis } : null,
        fout: ffout || s.fout || (s.intrek_open ? 'Intrekken is nog niet helemaal klaar; ik probeer het opnieuw.' : null),
      },
      voorbeeld_html: s.html || '',
      ...appSchermen(s, nu()),   // wv3020
      // wv4209: Davids mededelingen (komende), open voorstellen van Socev en de keuze 'mag vanzelf' per vaste bron
      mededelingen: eigenPunten().filter((x) => x && echteDatum(x.datum) && x.datum >= ymd(nu())).map((x) => ({ id: String(x.id || ''), titel: String(x.titel || ''), datum: x.datum, tijd: x.tijd || null, door: x.door === 'socev' ? 'socev' : 'david' })),
      voorstellen: voorstellenNu(s, nu()).map((x) => ({ id: x.id, titel: x.titel, datum: x.datum, tijd: x.tijd || null, op: x.op })),
      vanzelf: { rij: vanzelfMag(), feestdagen: feestMag(), bronnen: VASTE_BRONNEN.map((b) => ({ id: b.id, naam: b.naam, uitleg: b.uitleg, aan: !!vanzelfAan()[b.id], sinds: vanzelfAan()[b.id] ? Number(vanzelfAan()[b.id].op) : null })) },
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
    if (methode === 'POST' && pad === '/app/personeelsscherm/medisch') return medischZet(body && body.id, !!(body && body.vast === true), body);   // wv3154; wv4210: voor/zin
    if (methode === 'POST' && pad === '/app/personeelsscherm/mededeling') return mededelingZet(body);   // wv4209
    if (methode === 'POST' && pad === '/app/personeelsscherm/vanzelf') return vanzelfZet(body && body.bron, !!(body && body.aan === true));   // wv4209
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
      || (toestemming() && nieuwsActief() && !nieuwsBinnenKwartier(s, t)) || (!!(s.inhoud && s.inhoud.nieuws) && !(toestemming() && nieuwsActief()))
      || (toestemming() && !medischBinnenUur(s, t)) || !!(s.inhoud && s.inhoud.medisch_tv) !== (toestemming() && medischMag()) || !!(s.inhoud && s.inhoud.team_tv) !== (toestemming() && teamMag())   // wv4210
      || !!(s.inhoud && s.inhoud.qr_tv) !== (toestemming() && qrMag()) || !!(s.inhoud && s.inhoud.feest_tv) !== feestMag()) {   // wv4209: feestdagenrij erbij/weg = meteen   // wv4208: QR-rij erbij/weg = meteen   // wv3154: elk uur; zin erbij/weg = meteen   // wv3023: nieuws elk kwartier; zin weg of uit = meteen
      try { const i = await verzamel(t); nieuw = inhoudSha(i) !== s.inhoud_sha; } catch (e) { fout('personeelsscherm-inhoud', new Error(String(e && e.message).slice(0, 80))); }
      s = leesStand();
    }
    // wv4208: schermtijd — wissel tussen rust en gewoon = nieuwe envelop; in de rust geeft nieuwe inhoud geen nieuwe (zelfde zwarte) envelop
    const rustNu = !s.leeg && !inhoudVenster(t);
    if (nieuw && rustNu && s.rust) nieuw = false;
    if (nieuw || !s.gemaakt || t - s.gemaakt > OPNIEUW_MS || !s.houdbaar_tot || !!s.rust !== rustNu) {
      try { await publiceer(); } catch (e) { wijzig((x) => { x.fout = 'Het scherm kon niet worden bijgewerkt.'; }); fout('personeelsscherm-publiceer', new Error(String(e && e.message).slice(0, 80))); }
    }
    let live;
    try { live = await leesD1(); } catch (e) { fout('personeelsscherm-lees', new Error('D1 lezen faalde')); return { ok: false }; }
    s = wijzig((x) => { x.hartslag = live.hartslag; x.vreemd = live.vreemd; x.laatste_tik = t; });
    // meldingen: nooit vaker dan één keer per voorval of per dag
    if (live.vreemd && live.vreemd.op && s.vreemd_gemeld !== live.vreemd.op) {
      wijzig((x) => { x.vreemd_gemeld = live.vreemd.op; });
      try { await melding('personeelsscherm-vreemd:' + live.vreemd.op, 'OVIS Scherm: de sleutel van het kastje werd ' + iso(live.vreemd.op).slice(0, 16) + ' UTC gebruikt vanaf een ander internetadres (land ' + (live.vreemd.land || '?') + ') en geweigerd. Mogelijk een gestolen kaart of een nieuw adres van de praktijk: David kan in Apps › OVIS Scherm de sleutel intrekken.', true); } catch (e) { fout('personeelsscherm-melding', e); }
    }
    if (s.token && s.gekoppeld_op && t - s.gekoppeld_op > STIL_MS && inWerktijd(t)) {
      const laatst = live.hartslag ? live.hartslag.op : 0;
      const dag = amsDelen(t).datum;
      if (t - laatst > STIL_MS && s.stil_gemeld !== dag) {
        wijzig((x) => { x.stil_gemeld = dag; });
        try { await melding('personeelsscherm-stil:' + dag, 'OVIS Scherm: het kastje meldde zich ' + (laatst ? 'sinds ' + iso(laatst).slice(0, 16) + ' UTC' : 'nog nooit') + ' niet meer (werktijd). Stroom, kabel of internet van de praktijk?'); } catch (e) { fout('personeelsscherm-melding', e); }
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
      // wv3154: alleen aantallen en per bron of de laatste ronde lukte
      medisch: { mag: medischMag(), team: teamMag(), uit: !!uitLijst()[MEDISCH_ID], belangrijk_uit: !!uitLijst()[BELANGRIJK_ID], poging: s.medisch_poging ? iso(s.medisch_poging) : null,
        bewaard: s.medisch && s.medisch.items ? Object.keys(s.medisch.items).length : 0,
        op_tv: s.inhoud && s.inhoud.medisch ? { nieuws: s.inhoud.medisch.nieuws.length, belangrijk: s.inhoud.medisch.belangrijk.length } : null,
        bronnen: s.medisch && s.medisch.bronnen ? Object.fromEntries(Object.entries(s.medisch.bronnen).map(([k, v]) => [k, { ok: v && v.ok ? iso(v.ok) : null, n: v && Number.isFinite(v.n) ? v.n : 0, fout: v && v.fout ? iso(v.fout) : null }])) : null },
      week: { mag: weekMag(), uit: !!uitLijst()[WEEK_ID], sleutel: s.week ? s.week.sleutel : null, op_tv: s.inhoud && s.inhoud.week ? s.inhoud.week.dagen.length : null },   // wv4149: geen namen
      info_uit: s.info_uit ? Object.keys(s.info_uit).length : 0, aanvragen: (s.aanvragen || []).filter((a) => a && nu() - a.op < AANVRAAG_BEWAAR_MS).length,   // wv3020
      bronnen: s.inhoud ? s.inhoud.bronnen || null : null };   // alleen tellingen, nooit namen
  }

  return { app, tik, info, publiceer, open, koppel, intrek, leeg, leesD1, appStand, verzamel, toestemming, infoSchermen, infoKandidaten, infoZet, aanvraag, medischZet, mededelingZet, voorstel, vanzelfZet };
}

module.exports = { maak, bouwHtml, D1_SCHEMA, inWerktijd, inSchermtijd, inhoudVenster, QR_RIJ, QR_ZIN, HOUDBAAR_MS, OPNIEUW_MS, TOKEN_NAAM, HOST, REGISTER_RIJ,
  VANZELF_RIJ, VANZELF_ZIN, FEEST_ZIN, VASTE_BRONNEN, MEDEDELING_DAGEN,   // wv4209
  VOLLE_NAAM_ZIN, INFO_ZIN, NIEUWS_ZIN, NIEUWS_ID, JARIG_ID, WEEK_RIJ, WEEK_ZIN, WEEK_ID, MEDISCH_ZIN, MEDISCH_RIJ, MEDISCH_ID, BELANGRIJK_ID, MEDISCH_BRONNEN, TEAM_ZIN, TEAM_RIJ, VOOR_WIE,
  _t: { qrMatrix, qrSvg, openbareUrl, paasZondag, feestdagen, feestdag, weekMaandag, weekRooster, weekBeeld, medischTekst, medischItems, medischBijwerken, medischBeeld, voorVan, eigenZin, rssItems, nieuwsKop, nieuwsKoppen, nieuwsGeldig, agendaPunten, feestPunten, mededelingNorm, vanzelfGeldig, artsenVandaag, jarigen, jarigDag, leesMedewerkers, weerBeeld, dagdeel, frontmatter, infoNorm, stapTekst, kaartHash, fnv, setKaart, setGeldig, schermId, aanvraagOpdracht, aanvraagTekst } };
