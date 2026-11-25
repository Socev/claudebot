'use strict';
/*
 * open-eindjes.js — Open Eindjes-wachter (wv4007; bouwplan vault "01_Ontwikkeling/Open Eindjes-wachter (bouwplan 23-11-2026).md",
 * Fable-review 23-11 GO na fixes, David Ja 25-11-2026 21:40 op de kaart "zo bouwen?").
 *
 * WAAROM. David (23-11): "als iemand op Whatsapp/Telegram/Signal/Teams mij wat heeft gestuurd wat een antwoord behoeft, en ik vergeet te
 * antwoorden, attendeer mij dan". De Correspondentie-Wachter volgt alleen mail; niets keek naar een chatvraag zonder antwoord.
 *
 * HOE (drie stappen, de pod doet alles behalve het oordeel):
 *  1. haal()     — voorselectie zonder taalmodel (POST /smal/eindjes, beurtpas van de Correspondentie-Wachter 03:40 of API_SECRET).
 *                  Kandidaat = 1-op-1-gesprek waarvan het laatste bericht niet van David is en 24 uur tot 7 dagen oud, met een staart
 *                  (de berichten ná Davids laatste bericht, hooguit 8) die nog niet beoordeeld is. Kanalen: WhatsApp NL + Gambia (zoek-webhook
 *                  modus overzicht + Chat Reader modus staart, alleen nummers uit Davids contacten), Telegram (telegram-reader.js eindjes,
 *                  één proces, één regel in het leeslog), Signal en Teams (eigen databank). Een eerder beoordeelde vraag (zelfde anker =
 *                  Davids laatste bericht) komt alleen terug als er daarna iets anders dan een vulbericht ("?", "hallo?") bij kwam; dan
 *                  met `eerder` erbij, zodat het oordeel kan zien of het een nieuwe vraag is.
 *  2. oordeel()  — de run legt per kandidaat `eindje` + één zin (≤ 90) of `geen` terug (POST /smal/eindjes/oordeel). Opslag in
 *                  machinekamer.open_eindjes (wis na 30 dagen). De mail-uitvoer van de wachter (NIETS/BLIND/hartslag) blijft ongemoeid.
 *  3. kaartStap() — 06:50 (vóór 07:05: een kaart die later komt wacht tot 12:30, regel "eerstvolgend moment ≥ 10 min"): kaart van
 *                  gisteren sluiten, hercheck zonder taalmodel (antwoordde David intussen? dan afgerond), hooguit 5 eindjes op één kaart
 *                  "Nog beantwoorden" (oudste vraag eerst, de rest schuift door zolang hij binnen 7 dagen valt), Teams alleen op werkdagen,
 *                  en pas ná het zetten `getoond_op`. Een getoond eindje komt nooit terug.
 *  Storing ≠ stilte: een kanaal dat niet te lezen is, valt die nacht weg en geeft één box-rij per storing (niet elke nacht opnieuw).
 *  Teams-pc uit telt pas als storing na 2 werkdagen zonder nieuwe rijen.
 *
 * Puur waar het kan (kies, kaart, vulsel, venster): alle netwerk, databank, vault en klok komen via io (zie maak), zodat
 * test/open-eindjes.sh het met nepdata draait. Alles blijft lezen: niets wordt verstuurd, beantwoord of als gelezen gemarkeerd.
 * DEKT NIET: een emoji-reactie van David (👍) is onzichtbaar (WAHA leverde in 15 gemeten vensters geen reactionMessage); het oordeel
 * vangt het op ("kan met een duim af = geen"). Een antwoord via een ander kanaal (bellen, mail) ziet de pod niet.
 */
const crypto = require('crypto');

const DAG = 86400;
const MIN_LEEFTIJD = DAG;            // laatste bericht van de ander minstens 24 uur oud
const MAX_LEEFTIJD = 7 * DAG;        // en hooguit 7 kalenderdagen
const STAART_MAX = 8;
const KAART_MAX = 5;
const SPRAAK_NACHT = 10;             // Whisper-plafond per nacht (WhatsApp-staarten)
const SPRAAK_PER_CHAT = 3;
const ZIN_MAX = 90;
const STAP_MAX = 400;
const CACHE_MS = 3 * 3600 * 1000;    // een tweede haal in dezelfde nacht leest niet opnieuw (één Telegram-lezing, één leeslogregel)
const WIS_DAGEN = 30;
const KANALEN = ['whatsapp-nl', 'whatsapp-gambia', 'telegram', 'signal', 'teams'];
const KANAAL_NAAM = { 'whatsapp-nl': 'WhatsApp', 'whatsapp-gambia': 'WhatsApp Gambia', telegram: 'Telegram', signal: 'Signal', teams: 'Teams' };
const APP_NAAM = { 'whatsapp-nl': 'WhatsApp', 'whatsapp-gambia': 'WhatsApp (Gambia-nummer)', telegram: 'Telegram', signal: 'Signal', teams: 'Teams' };
const SLEUTEL_RE = /^eindjes-(\d{4}-\d{2}-\d{2})$/;
const LINK_RE = /^https:\/\/(wa\.me|t\.me|signal\.me|teams\.microsoft\.com)\/[^\s"<>]{1,280}$/;
const PRAKTIJK_NUMMERS = ['31334941210', '31334944600'];   // Tolgaarde en Groenhouten (bandjes-kaart.js): nooit lezen
const TEAMS_DAVID = 'David Schaap';
const WEEKDAG = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];

// ── puur ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function kandidaatId(kanaal, chat, laatste) {
  return crypto.createHash('sha256').update('wv4007|' + kanaal + '|' + chat + '|' + laatste).digest('hex').slice(0, 16);
}
function inVenster(ts, nu) { const l = nu - Number(ts); return Number.isFinite(l) && l >= MIN_LEEFTIJD && l <= MAX_LEEFTIJD; }
// "?", "hallo?", "en??", "👀", "..." — een herinnering, geen nieuwe vraag (bouwplan: maakt het geen nieuw eindje)
function vulsel(t) {
  const s = String(t || '').trim().toLowerCase().replace(/[\s?!.,…¿¡]+/g, ' ').trim();
  if (!s) return true;
  if (/^(hallo|hoi|hey|hee|he|hé|en|nou|ping|yo|david|dokter|\[leeg\])( (hallo|hoi|david|nou|en))?$/.test(s)) return true;
  return /^[\p{Extended_Pictographic}‍️\s]+$/u.test(s);
}
// Amsterdamse tijd als "za 14:10" (deze week) of "za 22-11 14:10" (ouder dan 6 dagen)
function amsDelen(d) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', weekday: 'short', year: 'numeric', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return p;
}
function amsWeekdag(d) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(amsDelen(d).weekday); }
function amsDatum(d) { const p = amsDelen(d); return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0'); }
function dagTijd(ts, nu) {
  const d = new Date(Number(ts) * 1000), p = amsDelen(d);
  return WEEKDAG[amsWeekdag(d)] + (nu - Number(ts) > 6 * DAG ? ' ' + Number(p.day) + '-' + Number(p.month) : '') + ' ' + p.hour + ':' + p.minute;
}
function schoon(t, max) {
  return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
/*
 * kies(items, rijen, nu) → { kandidaten, telling }
 *   items: [{ kanaal, chat, naam, link, laatste_ts, van_david, anker_ts, staart: [{ ts, tekst }] }] (staart = alleen de ander, oud → nieuw)
 *   rijen: bestaande rijen van open_eindjes (laatste 30 dagen) { kanaal, chat, anker_ts, vraag_ts, laatste_ts, oordeel, zin, getoond_op }
 */
function kies(items, rijen, nu) {
  const telling = { bekeken: 0, van_david: 0, buiten_venster: 0, leeg: 0, al_beoordeeld: 0, vulsel: 0, kandidaat: 0 };
  const kandidaten = [];
  (items || []).forEach(function (it) {
    telling.bekeken++;
    if (it.van_david) { telling.van_david++; return; }
    if (!inVenster(it.laatste_ts, nu)) { telling.buiten_venster++; return; }
    const staart = (it.staart || []).filter(function (b) { return b && Number(b.ts) > 0; }).slice(-STAART_MAX);
    if (!staart.length) { telling.leeg++; return; }
    const anker = Math.max(0, Number(it.anker_ts) || 0);
    const laatste = Number(it.laatste_ts);
    const zelfde = (rijen || []).filter(function (r) { return r.kanaal === it.kanaal && r.chat === it.chat && Number(r.anker_ts) === anker; });
    if (zelfde.some(function (r) { return Number(r.laatste_ts) >= laatste; })) { telling.al_beoordeeld++; return; }
    const eerder = zelfde.sort(function (a, b) { return Number(b.laatste_ts) - Number(a.laatste_ts); })[0] || null;
    if (eerder) {
      const nieuw = staart.filter(function (b) { return Number(b.ts) > Number(eerder.laatste_ts); });
      if (nieuw.every(function (b) { return vulsel(b.tekst); })) { telling.vulsel++; return; }
    }
    telling.kandidaat++;
    kandidaten.push({ id: kandidaatId(it.kanaal, it.chat, laatste), kanaal: it.kanaal, chat: it.chat, naam: schoon(it.naam, 80) || 'onbekend',
      link: LINK_RE.test(String(it.link || '')) ? it.link : null, anker_ts: anker, vraag_ts: Number(staart[0].ts), laatste_ts: laatste,
      staart: staart.map(function (b) { return { ts: Number(b.ts), tekst: schoon(b.tekst, 1500) || '[leeg]' }; }),
      eerder: eerder ? { oordeel: eerder.oordeel, zin: eerder.zin || null, tot: Number(eerder.laatste_ts), getoond: !!eerder.getoond_op } : null });
  });
  return { kandidaten: kandidaten, telling: telling };
}
// Wat de run te zien krijgt: geen chat-id, geen link, wel naam, kanaal en de staart met lokale tijden
function voorRun(k, nu) {
  return { id: k.id, kanaal: KANAAL_NAAM[k.kanaal], naam: k.naam, sinds: dagTijd(k.vraag_ts, nu),
    staart: k.staart.map(function (b) { return { tijd: dagTijd(b.ts, nu), tekst: b.tekst }; }),
    eerder: k.eerder ? { oordeel: k.eerder.oordeel, zin: k.eerder.zin, tot: dagTijd(k.eerder.tot, nu), al_op_kaart: k.eerder.getoond,
      let_op: 'beoordeel alleen wat ná ' + dagTijd(k.eerder.tot, nu) + ' kwam: alleen een nieuwe, andere vraag is een eindje' } : null };
}
function werkdag(nu) { const w = amsWeekdag(new Date(nu * 1000)); return w >= 1 && w <= 5; }
// De kaart (mk_voor_jou_zet). Eén eindje per stap; links in herkomst.links (server.js maakt er klikbare regels van in "Waar komt dit vandaan").
function kaart(datum, eindjes, rest, nu) {
  const n = eindjes.length;
  const stappen = eindjes.map(function (e) {
    const kop = schoon(e.naam, 80) + ' (' + KANAAL_NAAM[e.kanaal] + ', sinds ' + dagTijd(e.vraag_ts, nu) + '): ';
    const open = e.link ? ' Het gesprek opent via de link onderaan; lukt dat niet: ' + APP_NAAM[e.kanaal] + ' › ' + schoon(e.naam, 60) + '.'
      : ' Open ' + APP_NAAM[e.kanaal] + ' › ' + schoon(e.naam, 60) + '.';
    return (kop + schoon(e.zin, ZIN_MAX).replace(/[.\s]*$/, '') + '.' + open).slice(0, STAP_MAX);
  });
  const links = eindjes.filter(function (e) { return e.link; }).map(function (e) { return { tekst: KANAAL_NAAM[e.kanaal] + ' met ' + schoon(e.naam, 60), link: e.link }; });
  const klok = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nu * 1000));
  return { sleutel: 'eindjes-' + datum, soort: 'doen', waar: 'overal', prive: false, duur_min: Math.min(30, 2 * n + 1), volgorde: 40,
    titel: n === 1 ? 'Nog beantwoorden — 1 bericht wacht op je antwoord' : 'Nog beantwoorden — ' + n + ' berichten wachten op je antwoord',
    waarom: ('In ' + (n === 1 ? 'dit gesprek' : 'deze gesprekken') + ' vroeg iemand je iets en kwam er na een dag nog geen antwoord van jou. ' +
      'Elk bericht staat hier één keer' + (rest > 0 ? '; nog ' + rest + ' schuiven door naar morgen' : '') + '. Gedaan of Hoeft niet sluit de kaart.').slice(0, 400),
    stappen: stappen, meting: klok + ': nagekeken dat je hier nog niet antwoordde.',
    herkomst: { module: 'open-eindjes', handmatig: 'open-eindjes', links: links } };
}
function sqlTekst(s) { return "'" + String(s == null ? '' : s).replace(/\u0000/g, '').replace(/'/g, "''") + "'"; }
function sqlGetal(n) { const x = Math.floor(Number(n)); if (!Number.isFinite(x)) throw new Error('geen getal'); return String(x); }
function e164(id) { const m = /^(\d{6,15})@c\.us$/.exec(String(id || '')); return m ? '+' + m[1] : null; }

// ── met io ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/*
 * maak(io): io = {
 *   nu() → unix s;  datum() → 'JJJJ-MM-DD' (Amsterdam)
 *   wa(sessie 'nl'|'gambia') → { chats: [{ id, naam, ts, van_david }] }               zoek-webhook modus overzicht
 *   waStaart(sessie, chatId, maxSpraak) → { anker_ts, spraak, berichten: [{ ts, wie, tekst }] }   Chat Reader modus staart
 *   contacten(e164[]) → { '+31…': 'weergavenaam' }                                       Google Contacts-spiegel
 *   tg({ staart: true|false, van, tot, niet: [nrs] }) → { gesprekken, staarten, ankers }  telegram-reader.js eindjes
 *   sql(q) → rijen (eigen databank)                                                    rpc(naam, args) → antwoord
 *   leeslog(regel) · box(tekst) · staat() → object · staatZet(object) · log(object)
 * }
 */
function maak(io) {
  // tabelnamen: alleen de toets wijst ze naar een eigen schema (test/open-eindjes.sh)
  const T = Object.assign({ eindjes: 'machinekamer.open_eindjes', signal: 'secondbrain.signal_bericht', teams: 'secondbrain.teams_berichten' }, io.tabellen || {});
  Object.keys(T).forEach(function (k) { if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(T[k])) throw new Error('tabelnaam ongeldig: ' + k); });
  let cache = null;      // { op, uit, kandidaten: Map(id → kandidaat) }
  let bezig = null;
  const staat = function () { try { return io.staat() || {}; } catch (e) { return {}; } };
  const zetStaat = function (f) { const s = staat(); f(s); try { io.staatZet(s); } catch (e) { io.log({ fout: 'staat', e: String(e && e.message || e).slice(0, 120) }); } return s; };

  // één box-rij per storing; weer goed = storing vergeten (de volgende storing meldt opnieuw)
  function storing(kanaal, fout) {
    const s = staat();
    const st = (s.storingen = s.storingen || {});
    if (st[kanaal]) return;
    zetStaat(function (x) { x.storingen = x.storingen || {}; x.storingen[kanaal] = { sinds: io.datum(), fout: schoon(fout, 160) }; });
    const tijd = new Date(io.nu() * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16);
    try {
      io.box('\n## [direct] ' + tijd + ' — Open Eindjes-wachter: ' + (KANAAL_NAAM[kanaal] ? KANAAL_NAAM[kanaal] + ' niet te lezen' : 'de nachtronde haalde niets op') + ' (pod, automatisch) #open-eindjes\n' +
        '- status: open\n- van: pod open-eindjes.js (hooguit één rij per storing; weer leesbaar = vergeten)\n' +
        '- gemeten: ' + schoon(fout, 200).replace(/\d{8,}/g, '#') + '\n' +
        '- gevolg als er niets gebeurt: dit kanaal valt weg uit de kaart Nog beantwoorden tot het weer leest; de mailwachter merkt er niets van.\n' +
        '- voorstel: oorzaak nalopen (zoek-webhook/Chat Reader, telegram-reader.js eindjes, signal_bericht, teams_berichten); stand in /health open_eindjes en /opt/data/open-eindjes/staat.json.\n');
    } catch (e) { io.log({ fout: 'box', e: String(e && e.message || e).slice(0, 120) }); }
  }
  function goed(kanaal) {
    const s = staat();
    if (s.storingen && s.storingen[kanaal]) zetStaat(function (x) { delete x.storingen[kanaal]; });
  }
  async function rijen() {
    return io.sql("select kanaal, chat, anker_ts, vraag_ts, laatste_ts, oordeel, zin, getoond_op, afgerond_op from " + T.eindjes + " where beoordeeld_op > now() - interval '" + WIS_DAGEN + " days'");
  }
  // laatste-bericht-lijst per WhatsApp-sessie, alleen 1-op-1 met een nummer uit Davids contacten
  async function waLijst(sessie) {
    const j = await io.wa(sessie);
    if (!j || !Array.isArray(j.chats)) throw new Error('overzicht zonder chats');
    return j.chats.filter(function (c) { return c && /^\d{6,15}@c\.us$/.test(String(c.id)) && Number(c.ts) > 0; });
  }

  async function verzamel() {
    const nu = io.nu();
    const bestaand = await rijen();
    const items = [], kanalen = {};
    const s0 = staat();
    let spraak = s0.spraak && s0.spraak.datum === io.datum() ? Number(s0.spraak.n) || 0 : 0;
    const gelezenKanalen = [];
    for (const sessie of ['nl', 'gambia']) {
      const kanaal = sessie === 'nl' ? 'whatsapp-nl' : 'whatsapp-gambia';
      try {
        const lijst = await waLijst(sessie);
        const kand = lijst.filter(function (c) { return c.van_david === false && inVenster(c.ts, nu); });
        const namen = kand.length ? await io.contacten(kand.map(function (c) { return e164(c.id); }).filter(Boolean)) : {};
        let gelezen = 0, onbekend = 0;
        for (const c of kand) {
          const nr = e164(c.id);
          if (!nr || !namen[nr]) { onbekend++; continue; }   // onbekend nummer: niet in Davids contacten
          if (PRAKTIJK_NUMMERS.indexOf(nr.slice(1)) >= 0) continue;
          // al beoordeeld met precies dit laatste bericht: staart niet opnieuw lezen
          if (bestaand.some(function (r) { return r.kanaal === kanaal && r.chat === c.id && Number(r.laatste_ts) >= Number(c.ts); })) { items.push({ kanaal: kanaal, chat: c.id, laatste_ts: c.ts, van_david: false, anker_ts: -1, staart: [{ ts: c.ts, tekst: '' }], naam: namen[nr], al: true }); continue; }
          const max = Math.max(0, Math.min(SPRAAK_PER_CHAT, SPRAAK_NACHT - spraak));
          const st = await io.waStaart(sessie, c.id, max);
          if (!st || !Array.isArray(st.berichten)) throw new Error('staart zonder berichten');
          spraak += Math.max(0, Number(st.spraak) || 0);
          gelezen++;
          const staartAnder = st.berichten.filter(function (b) { return b && b.wie !== 'David'; });
          items.push({ kanaal: kanaal, chat: c.id, naam: namen[nr], link: 'https://wa.me/' + nr.slice(1), laatste_ts: Number(c.ts), van_david: st.berichten.length === 0,
            anker_ts: Number(st.anker_ts) || 0, staart: staartAnder });
        }
        kanalen[kanaal] = { ok: true, chats: lijst.length, in_venster: kand.length, onbekend: onbekend, staarten: gelezen };
        goed(kanaal);
      } catch (e) { kanalen[kanaal] = { ok: false, fout: schoon(e && e.message || e, 160) }; storing(kanaal, kanalen[kanaal].fout); }
    }
    zetStaat(function (x) { x.spraak = { datum: io.datum(), n: spraak }; });
    // Telegram: één proces, één leeslogregel
    try {
      const j = await io.tg({ staart: true, van: nu - MAX_LEEFTIJD, tot: nu - MIN_LEEFTIJD, niet: PRAKTIJK_NUMMERS });
      if (!j || !Array.isArray(j.gesprekken)) throw new Error('lezer gaf geen gesprekken');
      const staarten = j.staarten || {}, ankers = j.ankers || {};
      const gelezenNamen = [];
      j.gesprekken.forEach(function (g) {
        if (!Object.hasOwn(staarten, g.id)) return;
        gelezenNamen.push(schoon(g.naam, 40) + ' (' + g.id + ')');
        items.push({ kanaal: 'telegram', chat: String(g.id), naam: g.naam, link: g.gebruikersnaam ? 'https://t.me/' + g.gebruikersnaam : null,
          laatste_ts: Number(g.ts), van_david: !!g.van_david, anker_ts: Number(ankers[g.id]) || 0, staart: staarten[g.id] });
      });
      kanalen.telegram = { ok: true, chats: j.gesprekken.length, staarten: gelezenNamen.length };
      gelezenKanalen.push('telegram');
      try { io.leeslog('| ' + io.datum() + ' | ' + (gelezenNamen.length ? gelezenNamen.join(', ') : '*(geen staart gelezen)*') + ' | dialogenlijst (' + j.gesprekken.length + ' privé) + staart ná Davids laatste bericht (≤ 8, ≤ 7 dagen) | Open Eindjes-wachter (pod, nachtronde): alleen 1-op-1, niets gemarkeerd; inhoud niet bewaard, alleen oordeel en één zin |'); }
      catch (e) { io.log({ fout: 'leeslog', e: String(e && e.message || e).slice(0, 120) }); }
      goed('telegram');
    } catch (e) { kanalen.telegram = { ok: false, fout: schoon(e && e.message || e, 160) }; storing('telegram', kanalen.telegram.fout); }
    // Signal: alleen 1-op-1 (nummer of uuid), nooit een groep (de DBH-groep is een groep)
    try {
      const g = await io.sql("select gesprek_id, max(envelop_ts) filter (where eigen) as anker_ms, max(envelop_ts) as laatste_ms, " +
        "(array_agg(eigen order by envelop_ts desc))[1] as laatste_eigen, (array_agg(afzender_naam order by envelop_ts desc) filter (where not eigen))[1] as naam " +
        "from " + T.signal + " where gesprek_id ~ '^(\\+[0-9]{6,15}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' group by gesprek_id");
      let n = 0;
      for (const r of g) {
        const laatste = Math.floor(Number(r.laatste_ms) / 1000);
        if (r.laatste_eigen || !inVenster(laatste, nu)) { items.push({ kanaal: 'signal', chat: r.gesprek_id, laatste_ts: laatste, van_david: !!r.laatste_eigen, staart: [] }); continue; }
        const anker = Math.floor((Number(r.anker_ms) || 0) / 1000);
        const st = await io.sql("select envelop_ts, tekst, bijlagen from " + T.signal + " where gesprek_id = " + sqlTekst(r.gesprek_id) +
          " and not eigen and envelop_ts > " + sqlGetal(Number(r.anker_ms) || 0) + " order by envelop_ts desc limit " + STAART_MAX);
        n++;
        items.push({ kanaal: 'signal', chat: r.gesprek_id, naam: r.naam || 'onbekend', link: /^\+\d+$/.test(r.gesprek_id) ? 'https://signal.me/#p/' + r.gesprek_id : null,
          laatste_ts: laatste, van_david: false, anker_ts: anker,
          staart: st.reverse().map(function (b) { const bij = Array.isArray(b.bijlagen) && b.bijlagen.length ? '[bijlage] ' : ''; return { ts: Math.floor(Number(b.envelop_ts) / 1000), tekst: bij + (b.tekst || '') }; }) });
      }
      kanalen.signal = { ok: true, chats: g.length, staarten: n };
      goed('signal');
    } catch (e) { kanalen.signal = { ok: false, fout: schoon(e && e.message || e, 160) }; storing('signal', kanalen.signal.fout); }
    // Teams: 1-op-1 (@unq.gbl.spaces) en groepschats tot 3 deelnemers (@thread.v2), geen kanalen (@thread.tacv2)
    try {
      const vers = await io.sql("select extract(epoch from max(verwerkt_op))::bigint as t from " + T.teams);
      const versT = vers && vers[0] ? Number(vers[0].t) || 0 : 0;
      if (werkdagenSinds(versT, nu) >= 2) throw new Error('geen nieuwe Teams-rijen sinds ' + dagTijd(versT, nu) + ' (pc uit of lezer stil)');
      const g = await io.sql("select conversation_id, max(gesprek_naam) as gesprek_naam, extract(epoch from max(tijd) filter (where afzender = " + sqlTekst(TEAMS_DAVID) + "))::bigint as anker, " +
        "extract(epoch from max(tijd))::bigint as laatste, (array_agg(afzender order by tijd desc))[1] as laatste_afzender, count(distinct afzender) as mensen " +
        "from " + T.teams + " where tijd > now() - interval '30 days' and (conversation_id like '%@unq.gbl.spaces' or conversation_id like '%@thread.v2') group by conversation_id");
      let n = 0;
      for (const r of g) {
        if (/@thread\.v2$/.test(r.conversation_id) && Number(r.mensen) > 3) continue;
        const laatste = Number(r.laatste) || 0, vanDavid = r.laatste_afzender === TEAMS_DAVID;
        if (vanDavid || !inVenster(laatste, nu)) { items.push({ kanaal: 'teams', chat: r.conversation_id, laatste_ts: laatste, van_david: vanDavid, staart: [] }); continue; }
        const anker = Number(r.anker) || 0;
        const st = await io.sql("select extract(epoch from tijd)::bigint as t, afzender, tekst from " + T.teams + " where conversation_id = " + sqlTekst(r.conversation_id) +
          " and afzender <> " + sqlTekst(TEAMS_DAVID) + " and tijd > to_timestamp(" + sqlGetal(anker) + ") order by tijd desc limit " + STAART_MAX);
        n++;
        const ander = st.length ? st[0].afzender : '';
        items.push({ kanaal: 'teams', chat: r.conversation_id, naam: /@unq\.gbl\.spaces$/.test(r.conversation_id) ? ander || r.gesprek_naam : (r.gesprek_naam || ander),
          link: /^19:[A-Za-z0-9_.:@-]{10,200}$/.test(r.conversation_id) ? 'https://teams.microsoft.com/l/chat/' + encodeURIComponent(r.conversation_id) + '/conversations' : null,
          laatste_ts: laatste, van_david: false, anker_ts: anker,
          staart: st.reverse().map(function (b) { return { ts: Number(b.t), tekst: (/@thread\.v2$/.test(r.conversation_id) ? schoon(b.afzender, 40) + ': ' : '') + (b.tekst || '') }; }) });
      }
      kanalen.teams = { ok: true, chats: g.length, staarten: n };
      goed('teams');
    } catch (e) { kanalen.teams = { ok: false, fout: schoon(e && e.message || e, 160) }; storing('teams', kanalen.teams.fout); }
    const k = kies(items.filter(function (i) { return !i.al; }), bestaand, nu);
    k.telling.al_beoordeeld += items.filter(function (i) { return i.al; }).length;
    return { kanalen: kanalen, kandidaten: k.kandidaten, telling: k.telling, nu: nu };
  }

  async function haal(opt) {
    const o = opt || {};
    if (!o.vers && cache && Date.now() - cache.op < CACHE_MS) return cache.uit;
    if (bezig) return bezig;
    bezig = (async function () {
      const v = await verzamel();
      const kaartMap = new Map();
      v.kandidaten.forEach(function (k) { kaartMap.set(k.id, k); });
      const uit = { ok: true, datum: io.datum(), kanalen: v.kanalen, telling: v.telling,
        kandidaten: v.kandidaten.map(function (k) { return voorRun(k, v.nu); }),
        uitleg: 'Per kandidaat: eindje + één zin (≤ 90 tekens, wat ze vroegen) of geen; terug via oordeel. Staart = de berichten van de ander ná Davids laatste bericht.' };
      cache = { op: Date.now(), uit: uit, kandidaten: kaartMap };
      zetStaat(function (x) { x.haal = { datum: io.datum(), kandidaten: v.kandidaten.length, kanalen: Object.keys(v.kanalen).filter(function (k) { return v.kanalen[k].ok; }) }; });
      io.log({ stap: 'haal', kandidaten: v.kandidaten.length, telling: v.telling, kanalen: Object.keys(v.kanalen).map(function (k) { return k + ':' + (v.kanalen[k].ok ? 'ok' : 'fout'); }).join(',') });
      return uit;
    })();
    try { return await bezig; } finally { bezig = null; }
  }

  async function oordeel(body) {
    const lijst = Array.isArray(body && body.oordelen) ? body.oordelen.slice(0, 60) : null;
    if (!lijst) return { ok: false, fout: 'oordelen ontbreekt (lijst van {id, oordeel: eindje|geen, zin})' };
    if (!cache) return { ok: false, fout: 'geen kandidaten in het geheugen van de pod (herstart?): haal eerst opnieuw' };
    let opgeslagen = 0; const onbekend = [], fout = [];
    for (const x of lijst) {
      const k = x && cache.kandidaten.get(String(x.id));
      if (!k) { onbekend.push(String(x && x.id).slice(0, 20)); continue; }
      const o = x.oordeel === 'eindje' ? 'eindje' : x.oordeel === 'geen' ? 'geen' : null;
      let zin = schoon(x.zin, 200);
      if (!o) { fout.push(k.id + ': oordeel moet eindje of geen zijn'); continue; }
      if (o === 'eindje' && zin.length < 3) { fout.push(k.id + ': een eindje heeft een zin nodig'); continue; }
      if (zin.length > ZIN_MAX) zin = zin.slice(0, ZIN_MAX - 1).trimEnd() + '…';
      await io.sql('insert into ' + T.eindjes + ' as t (kanaal, chat, anker_ts, vraag_ts, laatste_ts, naam, link, oordeel, zin) values (' +
        [sqlTekst(k.kanaal), sqlTekst(k.chat), sqlGetal(k.anker_ts), sqlGetal(k.vraag_ts), sqlGetal(k.laatste_ts), sqlTekst(k.naam.slice(0, 80)),
          k.link ? sqlTekst(k.link) : 'null', sqlTekst(o), o === 'eindje' ? sqlTekst(zin) : 'null'].join(', ') +
        ') on conflict (kanaal, chat, laatste_ts) do update set oordeel = excluded.oordeel, zin = excluded.zin, beoordeeld_op = now() ' +
        'where t.getoond_op is null and t.afgerond_op is null');
      opgeslagen++;
    }
    zetStaat(function (s) { s.oordeel = { datum: io.datum(), opgeslagen: opgeslagen }; });
    io.log({ stap: 'oordeel', opgeslagen: opgeslagen, onbekend: onbekend.length, fout: fout.length });
    return { ok: fout.length === 0 && onbekend.length === 0, opgeslagen: opgeslagen, onbekend: onbekend, fouten: fout };
  }

  // hercheck zonder taalmodel: per kanaal de chats van de wachtende eindjes; true = David antwoordde intussen
  async function hercheck(wacht, nu) {
    const uit = {}, kapot = {};
    const per = {};
    wacht.forEach(function (r) { (per[r.kanaal] = per[r.kanaal] || []).push(r); });
    for (const kanaal of Object.keys(per)) {
      try {
        if (kanaal === 'whatsapp-nl' || kanaal === 'whatsapp-gambia') {
          const lijst = await waLijst(kanaal === 'whatsapp-nl' ? 'nl' : 'gambia');
          const op = {}; lijst.forEach(function (c) { op[c.id] = c; });
          per[kanaal].forEach(function (r) { const c = op[r.chat]; uit[r.id] = !!(c && c.van_david === true && Number(c.ts) > Number(r.laatste_ts)); });
        } else if (kanaal === 'telegram') {
          const j = await io.tg({ staart: false });
          if (!j || !Array.isArray(j.gesprekken)) throw new Error('lezer gaf geen gesprekken');
          const op = {}; j.gesprekken.forEach(function (g) { op[String(g.id)] = g; });
          per[kanaal].forEach(function (r) { const g = op[r.chat]; uit[r.id] = !!(g && g.van_david && Number(g.ts) > Number(r.laatste_ts)); });
          try { io.leeslog('| ' + io.datum() + ' | *(dialogenlijst, ' + j.gesprekken.length + ' privé)* | — | Open Eindjes-wachter (pod, hercheck 06:50): alleen of Davids laatste bericht nieuwer is, geen inhoud |'); } catch (e) {}
        } else if (kanaal === 'signal') {
          for (const r of per[kanaal]) {
            const q = await io.sql("select count(*) as n from " + T.signal + " where gesprek_id = " + sqlTekst(r.chat) + " and eigen and envelop_ts > " + sqlGetal(Number(r.laatste_ts) * 1000));
            uit[r.id] = Number(q[0] && q[0].n) > 0;
          }
        } else if (kanaal === 'teams') {
          for (const r of per[kanaal]) {
            const q = await io.sql("select count(*) as n from " + T.teams + " where conversation_id = " + sqlTekst(r.chat) + " and afzender = " + sqlTekst(TEAMS_DAVID) + " and tijd > to_timestamp(" + sqlGetal(r.laatste_ts) + ")");
            uit[r.id] = Number(q[0] && q[0].n) > 0;
          }
        }
        goed(kanaal);
      } catch (e) { kapot[kanaal] = true; storing(kanaal, 'hercheck: ' + schoon(e && e.message || e, 140)); }
    }
    return { beantwoord: uit, kapot: kapot };
  }

  async function kaartStap() {
    const nu = io.nu(), datum = io.datum();
    const s = staat();
    const uit = { datum: datum, gesloten: [], afgerond: 0, verlopen: 0, getoond: 0, door: 0, kaart: null };
    if (s.kaart && s.kaart.datum === datum) return Object.assign(uit, { al_gedaan: true });
    // 1. kaart van gisteren (en ouder) dicht; een getoond eindje komt nooit terug
    const lijst = await io.rpc('mk_voor_jou_lijst', { p_alles: true });
    if (!lijst || !Array.isArray(lijst.punten)) throw new Error('kaartenlijst onleesbaar');
    const vandaag = 'eindjes-' + datum;
    if (lijst.punten.some(function (p) { return p && p.sleutel === vandaag; })) { zetStaat(function (x) { x.kaart = { datum: datum, al: true }; }); return Object.assign(uit, { al_gedaan: true }); }
    for (const p of lijst.punten) {
      if (!p || !SLEUTEL_RE.test(String(p.sleutel)) || p.sleutel === vandaag || (p.status !== 'open' && p.status !== 'later')) continue;
      const r = await io.rpc('mk_voor_jou_status', { p_sleutel: p.sleutel, p_van: p.status, p_naar: 'vervallen', p_door: 'agent', p_later_tot: null,
        p_bewijs: 'Vervangen door de kaart van ' + datum.slice(8) + '-' + Number(datum.slice(5, 7)) + '; deze berichten komen niet opnieuw.', p_samengevoegd_in: null, p_reden: 'open-eindjes: nieuwe ochtend' });
      if (r && r.ok !== false) uit.gesloten.push(p.sleutel);
    }
    // 2. wachtende eindjes; ouder dan 7 dagen = verlopen
    const wacht = await io.sql("select id, kanaal, chat, anker_ts, vraag_ts, laatste_ts, naam, link, zin from " + T.eindjes + " where oordeel = 'eindje' and getoond_op is null and afgerond_op is null order by vraag_ts, id");
    const oud = wacht.filter(function (r) { return nu - Number(r.laatste_ts) > MAX_LEEFTIJD; });
    if (oud.length) { await io.sql("update " + T.eindjes + " set afgerond_op = now(), afgerond_reden = 'ouder dan 7 dagen, niet getoond' where id in (" + oud.map(function (r) { return sqlGetal(r.id); }).join(',') + ')'); uit.verlopen = oud.length; }
    let kand = wacht.filter(function (r) { return nu - Number(r.laatste_ts) <= MAX_LEEFTIJD; });
    if (!werkdag(nu)) kand = kand.filter(function (r) { return r.kanaal !== 'teams'; });   // Teams alleen op werkdagen; het weekend telt maandag mee
    // 3. hercheck: antwoordde David intussen, dan afgerond (valt van de kaart)
    const h = await hercheck(kand, nu);
    const beantwoord = kand.filter(function (r) { return h.beantwoord[r.id] === true; });
    if (beantwoord.length) { await io.sql("update " + T.eindjes + " set afgerond_op = now(), afgerond_reden = 'David antwoordde vóór de kaart' where id in (" + beantwoord.map(function (r) { return sqlGetal(r.id); }).join(',') + ')'); uit.afgerond = beantwoord.length; }
    kand = kand.filter(function (r) { return h.beantwoord[r.id] !== true && !h.kapot[r.kanaal]; });
    // 4. de kaart: hooguit 5, oudste vraag eerst; pas ná het zetten getoond
    const nu5 = kand.slice(0, KAART_MAX);
    uit.door = kand.length - nu5.length;
    if (nu5.length) {
      const k = kaart(datum, nu5, uit.door, nu);
      const r = await io.rpc('mk_voor_jou_zet', { p: k });
      if (!r || !r.sleutel) throw new Error('Voor jou-kaart niet gezet');
      await io.sql("update " + T.eindjes + " set getoond_op = now(), kaart = " + sqlTekst(k.sleutel) + " where id in (" + nu5.map(function (r2) { return sqlGetal(r2.id); }).join(',') + ')');
      uit.getoond = nu5.length; uit.kaart = k.sleutel;
    }
    // 5. wissen na 30 dagen
    await io.sql("delete from " + T.eindjes + " where beoordeeld_op < now() - interval '" + WIS_DAGEN + " days'");
    // 6. kwam de nachtronde vannacht niet ophalen? één box-rij per storing
    if (!s.haal || s.haal.datum !== datum) storing('nachtronde', 'de Correspondentie-Wachter haalde vannacht geen kandidaten op (geen /smal/eindjes sinds ' + ((s.haal && s.haal.datum) || 'nooit') + ')');
    else goed('nachtronde');
    zetStaat(function (x) { x.kaart = { datum: datum, getoond: uit.getoond, door: uit.door, afgerond: uit.afgerond }; });
    io.log(Object.assign({ stap: 'kaart' }, uit, { gesloten: uit.gesloten.length }));
    return uit;
  }

  function info() {
    const s = staat();
    return { aan: true, haal: s.haal || null, oordeel: s.oordeel || null, kaart: s.kaart || null, spraak: s.spraak || null,
      storingen: Object.keys(s.storingen || {}), cache: cache ? Math.round((Date.now() - cache.op) / 60000) + ' min' : null };
  }
  return { haal: haal, oordeel: oordeel, kaartStap: kaartStap, info: info };
}

// werkdagen (ma-vr) tussen t en nu, in Amsterdamse kalenderdagen; de dag van t zelf telt niet mee
function werkdagenSinds(t, nu) {
  if (!t) return 99;
  const eind = amsDatum(new Date(nu * 1000));
  let n = 0;
  for (let x = Number(t) + DAG, i = 0; i < 60; x += DAG, i++) {
    const d = new Date(x * 1000), dat = amsDatum(d);
    if (dat > eind) break;
    const w = amsWeekdag(d); if (w >= 1 && w <= 5) n++;
  }
  return n;
}

module.exports = { maak: maak, kies: kies, kaart: kaart, vulsel: vulsel, inVenster: inVenster, dagTijd: dagTijd, voorRun: voorRun, werkdag: werkdag,
  werkdagenSinds: werkdagenSinds, kandidaatId: kandidaatId, sqlTekst: sqlTekst, LINK_RE: LINK_RE, KANALEN: KANALEN, PRAKTIJK_NUMMERS: PRAKTIJK_NUMMERS };
