#!/usr/bin/env node
/*
 * telegram-reader.js — LEZEND luik op Davids Telegram-account (MTProto/GramJS).
 *
 * Twee commando's:
 *   node telegram-reader.js dialogen [--aantal N]
 *   node telegram-reader.js lees --chat <naam-of-id> --dagen N
 *
 * WAAROM DIT BESTAND ALLEEN LEEST, EN HOE DAT IS AFGEDWONGEN.
 * Een MTProto-sessie is een volwaardige accountsleutel: dezelfde sessie kán
 * versturen. "Read-only" is dus geen eigenschap van de credential maar van het
 * gereedschap. Daarom staat hier geen enkele verzend- of markeerfunctie, wordt
 * er niets uit GramJS geïmporteerd dat dat kan, en faalt de CI-build als iemand
 * er alsnog een toevoegt (zie .github/workflows/build.yml). Dat is de garantie:
 * de code plus de poort ervoor — niet een belofte.
 *
 * ENV (komt via fetch-secrets.sh uit de Supabase Vault):
 *   TELEGRAM_API_ID     api_id van my.telegram.org
 *   TELEGRAM_API_HASH   api_hash van my.telegram.org
 *   TELEGRAM_SESSIE     de sessiestring (gemaakt met koppel-telegram.js)
 */
const fs = require('fs');
const path = require('path');

const LOCK = process.env.TELEGRAM_LOCK || '/opt/data/telegram-reader.lock';
const LOCK_WACHT_MS = 5000;   // hoe lang een tweede aanroep beleefd wacht
const LOCK_POLL_MS = 250;
const LOCK_MAX_LEEFTIJD_MS = 10 * 60 * 1000;  // ouder = verweesd, mag weg

function fout(bericht, code) {
  process.stderr.write(bericht + '\n');
  process.exit(code || 1);
}

// ── Lock ────────────────────────────────────────────────────────────────────
// Twee gelijktijdige sessies op hetzelfde account leveren floodwaits en in het
// ergste geval een ingetrokken sessie op. Eén lezer tegelijk, dus.
function pakLock() {
  const grens = Date.now() + LOCK_WACHT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      lockVastgehouden = true;
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Verweesd lock van een gesneuvelde run? Dan opruimen en opnieuw proberen.
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > LOCK_MAX_LEEFTIJD_MS) {
          fs.unlinkSync(LOCK);
          continue;
        }
      } catch (e2) { /* net weggehaald door een ander; opnieuw proberen */ }
      if (Date.now() > grens) return false;
      // korte blokkerende pauze zonder extra afhankelijkheid
      try { fs.readFileSync('/proc/self/stat'); } catch (e3) {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
}

/*
 * De grendel loslaten - en dat moet gebeuren langs WELK pad het proces ook eindigt.
 *
 * DE BUG DIE HIER ZAT (gemeten 19-8-2026). De hoofdlus liet de grendel keurig los in
 * zijn catch en aan het eind, maar `fout()` roept `process.exit()` aan en dat gooit
 * geen exception. Elke foutmelding diep in de code - "geen gesprek gevonden", een
 * ontbrekende omgevingsvariabele, een ingetrokken sessie - sprong dus om die
 * opruiming heen. Gevolg: één mislukte leespoging liet een grendel achter en de
 * volgende tien minuten weigerde elke leesopdracht met "reader is bezig". Precies
 * het soort fout dat zich pas laat zien op het moment dat je het niet kunt gebruiken.
 *
 * De opruiming hangt daarom aan `process.on('exit')`, want die loopt óók na
 * `process.exit()`. De vlag erbij is geen franje maar het gevaarlijke deel: zonder
 * die vlag zou een proces dat de grendel juist NIET kreeg - het pad "reader is
 * bezig" - bij zijn eigen afsluiten de grendel van de dráaiende lezer weghalen. Dan
 * had de reparatie een ergere fout gemaakt dan hij oploste.
 */
let lockVastgehouden = false;

function laatLockLos() {
  if (!lockVastgehouden) return;
  lockVastgehouden = false;
  try { fs.unlinkSync(LOCK); } catch (e) {}
}

// Loopt ook na process.exit(). Moet synchroon blijven: asynchroon werk wordt hier
// niet meer afgemaakt.
process.on('exit', laatLockLos);

// Een onderbroken lezer hoort zijn grendel net zo goed terug te geven. Deze twee
// eindigen via process.exit, dus de opruiming hierboven loopt daarna alsnog.
process.on('SIGINT', function () { process.exit(130); });
process.on('SIGTERM', function () { process.exit(143); });

// ── Argumenten ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const uit = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const naam = a.slice(2);
      const volgende = argv[i + 1];
      if (volgende && !volgende.startsWith('--')) { uit[naam] = volgende; i++; }
      else uit[naam] = true;
    } else uit._.push(a);
  }
  return uit;
}

// ── Opmaak, gelijk aan de WhatsApp-dumps ────────────────────────────────────
function tijd(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function afzender(bericht, entiteiten) {
  if (bericht.out) return 'David';
  const id = bericht.senderId ? String(bericht.senderId) : '';
  const e = entiteiten.get(id);
  if (!e) return id || 'onbekend';
  const naam = [e.firstName, e.lastName].filter(Boolean).join(' ').trim();
  return naam || e.username || e.title || id;
}

// Media wordt bewust NIET gedownload: alleen benoemd. Dat scheelt verkeer, en
// het houdt bijlagen buiten de vault tenzij iemand daar bewust om vraagt.
function mediaLabel(bericht) {
  const m = bericht.media;
  if (!m) return '';
  const t = m.className || '';
  if (t === 'MessageMediaPhoto') return '[foto]';
  if (t === 'MessageMediaDocument') {
    const attrs = (m.document && m.document.attributes) || [];
    for (const a of attrs) {
      const c = a.className || '';
      if (c === 'DocumentAttributeAudio') return a.voice ? '[spraak]' : '[audio]';
      if (c === 'DocumentAttributeVideo') return a.roundMessage ? '[videobericht]' : '[video]';
      if (c === 'DocumentAttributeSticker') return '[sticker]';
      if (c === 'DocumentAttributeFilename') return '[bestand: ' + a.fileName + ']';
    }
    return '[document]';
  }
  if (t === 'MessageMediaGeo' || t === 'MessageMediaGeoLive') return '[locatie]';
  if (t === 'MessageMediaContact') return '[contact]';
  if (t === 'MessageMediaPoll') return '[peiling]';
  if (t === 'MessageMediaWebPage') return '';   // linkvoorbeeld: de tekst zegt het al
  return '[media]';
}

function soortVanDialoog(d) {
  if (d.isUser) return 'privé';
  if (d.isGroup) return 'groep';
  if (d.isChannel) return 'kanaal';
  return 'onbekend';
}

// ── Telegram ────────────────────────────────────────────────────────────────
async function maakClient() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const sessie = process.env.TELEGRAM_SESSIE || '';
  if (!apiId || !apiHash) fout('TELEGRAM_API_ID of TELEGRAM_API_HASH ontbreekt in de omgeving.', 78);
  if (!sessie) fout('TELEGRAM_SESSIE ontbreekt in de omgeving - koppeling nog niet gedaan.', 78);

  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');

  const client = new TelegramClient(new StringSession(sessie), apiId, apiHash, {
    connectionRetries: 4,
    deviceModel: 'Socev reader',
    systemVersion: 'pod',
    appVersion: '1.0',
    // useWSS: websocket over ECHT TLS. Gemeten op 19-8-2026 vanaf de pod: kale
    // MTProto over TCP verbindt wel (connect in 7 ms) maar krijgt daarna NUL
    // bytes terug - de egress accepteert de verbinding en laat het verkeer
    // vallen. Met useWSS verbindt GramJS in ~1 s. connectionRetries van 2 naar 4
    // omdat een websocket-opzet meer stappen heeft die los kunnen mislukken.
    useWSS: true,
    // 0 = nooit zelf slapen op een floodwait. Wachten verbergt het probleem en
    // laat het proces minutenlang hangen; we geven het door als nette fout.
    floodSleepThreshold: 0,
    baseLogger: undefined
  });
  client.setLogLevel('error');
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.disconnect().catch(() => {});
    fout('sessie is ingetrokken - herkoppelen nodig (koppel-telegram.js).', 78);
  }
  return client;
}

function vertaalFout(e) {
  const naam = (e && (e.errorMessage || e.message || '')) + '';
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|USER_DEACTIVATED/i.test(naam)) {
    return 'sessie is ingetrokken - herkoppelen nodig (koppel-telegram.js).';
  }
  const flood = naam.match(/FLOOD_WAIT_(\d+)/i) || (e && e.seconds ? [null, String(e.seconds)] : null);
  if (flood) return 'Telegram vraagt ' + flood[1] + ' s wachttijd - later opnieuw proberen.';
  return 'Telegram-fout: ' + (naam || 'onbekend');
}

// ── Commando: dialogen ──────────────────────────────────────────────────────
async function cmdDialogen(args) {
  const aantal = Math.min(Math.max(parseInt(args.aantal || '40', 10) || 40, 1), 200);
  const client = await maakClient();
  try {
    const dialogen = await client.getDialogs({ limit: aantal });
    const regels = dialogen.map(function (d) {
      const naam = d.title || d.name || String(d.id);
      const ts = d.message && d.message.date ? tijd(d.message.date) : '-';
      return [naam, soortVanDialoog(d), ts, String(d.id)].join(' | ');
    });
    process.stdout.write('naam | soort | laatste bericht | id\n');
    process.stdout.write(regels.join('\n') + '\n');
    process.stdout.write('\n' + regels.length + ' gesprekken. Geen inhoud opgehaald.\n');
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── Commando: lees ──────────────────────────────────────────────────────────
async function cmdLees(args) {
  const chat = args.chat;
  const dagen = Math.min(Math.max(parseInt(args.dagen || '1', 10) || 1, 1), 90);
  if (!chat || chat === true) fout('gebruik: lees --chat <naam-of-id> --dagen N');

  const client = await maakClient();
  try {
    // Zoek de dialoog op naam of id; exacte id gaat voor.
    const dialogen = await client.getDialogs({ limit: 200 });
    const naaldLaag = String(chat).toLowerCase();
    let doel = dialogen.find(function (d) { return String(d.id) === String(chat); });
    if (!doel) {
      doel = dialogen.find(function (d) {
        const n = (d.title || d.name || '').toLowerCase();
        return n === naaldLaag;
      });
    }
    if (!doel) {
      doel = dialogen.find(function (d) {
        const n = (d.title || d.name || '').toLowerCase();
        return n.indexOf(naaldLaag) !== -1;
      });
    }
    if (!doel) fout('geen gesprek gevonden voor "' + chat + '" - draai eerst: dialogen');

    const grens = Math.floor(Date.now() / 1000) - dagen * 86400;
    const berichten = [];
    for await (const b of client.iterMessages(doel.entity, { limit: 2000 })) {
      if (!b || !b.date) continue;
      if (b.date < grens) break;          // iterMessages loopt van nieuw naar oud
      berichten.push(b);
    }
    berichten.reverse();

    // Namen van afzenders ophalen zonder per bericht een extra aanvraag.
    const entiteiten = new Map();
    for (const b of berichten) {
      const id = b.senderId ? String(b.senderId) : '';
      if (!id || entiteiten.has(id)) continue;
      try { entiteiten.set(id, await b.getSender()); } catch (e) { entiteiten.set(id, null); }
    }

    const naam = doel.title || doel.name || String(doel.id);
    const uit = [];
    uit.push('# Telegram — ' + naam);
    uit.push('');
    uit.push('Gesprek: ' + naam + ' (' + soortVanDialoog(doel) + ', id ' + doel.id + ')');
    uit.push('Periode: laatste ' + dagen + ' dag(en) — ' + berichten.length + ' berichten');
    uit.push('Opgehaald: ' + tijd(Math.floor(Date.now() / 1000)) + ' (alleen gelezen)');
    uit.push('');
    for (const b of berichten) {
      const media = mediaLabel(b);
      const tekst = (b.message || '').trim();
      const inhoud = [media, tekst].filter(Boolean).join(' ');
      if (!inhoud) continue;
      uit.push('[' + tijd(b.date) + '] ' + afzender(b, entiteiten) + ': ' + inhoud);
    }
    process.stdout.write(uit.join('\n') + '\n');
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// ── Hoofd ───────────────────────────────────────────────────────────────────
(async function () {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || ['help', '-h', '--help'].indexOf(cmd) !== -1) {
    process.stdout.write(
      'telegram-reader.js — alleen lezen\n\n' +
      '  dialogen [--aantal N]              lijst gesprekken (geen inhoud)\n' +
      '  lees --chat <naam-of-id> --dagen N berichten van de laatste N dagen\n');
    return;
  }
  if (['dialogen', 'lees'].indexOf(cmd) === -1) fout('onbekend commando: ' + cmd);

  if (!pakLock()) fout('reader is bezig - probeer het zo opnieuw.', 75);
  try {
    if (cmd === 'dialogen') await cmdDialogen(args);
    else await cmdLees(args);
  } catch (e) {
    laatLockLos();
    fout(vertaalFout(e), 1);
  }
  laatLockLos();
})().catch(function (e) {
  laatLockLos();
  fout(vertaalFout(e), 1);
});
