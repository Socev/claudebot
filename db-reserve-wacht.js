'use strict';
// wv3416 (actieplan Fable 19-11, B35): stille wacht op de warme databankreserve op de R230 (wv3187).
// server.js meet elke minuut de reserve (dbReserveVraag: pg_stat_replication, slot r230, pg_stat_archiver, pg_wal) en geeft de
// meting hier door. Deze module is puur: ze houdt per soort afwijking bij sinds wanneer hij er is en zegt wanneer er één box-rij moet
// komen. Geen schijf, geen netwerk; de staat (een klein object) bewaart server.js tussen herstarts.
//
// Soorten en drempels (hoe lang de afwijking onafgebroken moet staan voor er een rij komt):
//   niet_verbonden  30 min  geen streamende verbinding van de R230 (spontane tunnelonderbrekingen zijn binnen ± 2 min terug)
//   slot             5 min  slot r230 weg of wal_status niet 'reserved' (lost = de reserve kan niet meer bijlezen)
//   archief         30 min  archivering faalt nu (laatste fout nieuwer dan de laatste geslaagde; failed_count telt alleen op
//                           sinds de laatste stats-reset, dus één oude fout zou anders voor altijd rood staan)
//   pg_wal          30 min  pg_wal groter dan 2 GB (slot of archief houdt WAL vast)
//   meting          30 min  de reserve is niet te meten (geen databanksocket, sb-sql faalt)
// Stilte: per soort één rij per afwijking; zolang hij blijft staan geen herhaling, na herstel geen rij. Komt dezelfde soort binnen
// 24 u na de vorige rij terug, dan ook geen nieuwe rij (flapperen); daarna wel.
const MIN = 60 * 1000;
const DREMPEL_MS = { niet_verbonden: 30 * MIN, slot: 5 * MIN, archief: 30 * MIN, pg_wal: 30 * MIN, meting: 30 * MIN };
const PG_WAL_GRENS = 2 * 1024 * 1024 * 1024;
const STIL_NA_MELDING_MS = 24 * 60 * MIN;

function gb(b) { return (Number(b) / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',') + ' GB'; }

// meting (dbReserve uit server.js) → { soort: tekst } van wat er nu mis is
function afwijkingen(m) {
  if (!m || m.fout) return { meting: 'de reserve is niet te meten (' + String((m && m.fout) || 'geen meting').slice(0, 80) + ')' };
  const a = {};
  if (!m.slot) a.slot = 'slot r230 bestaat niet (meer)';
  else if (m.slot.wal_status !== 'reserved') a.slot = 'slot r230 staat op ' + String(m.slot.wal_status) + ' in plaats van reserved';
  if (!m.verbonden) a.niet_verbonden = 'de R230 leest niet mee (verbinding ' + (m.staat || 'geen') + ')';
  const ar = m.archief;
  if (ar && ar.laatste_fout && (!ar.laatste_ok || Date.parse(ar.laatste_fout) > Date.parse(ar.laatste_ok))) {
    a.archief = 'WAL-archivering faalt (laatste fout ' + ar.laatste_fout + ', laatste geslaagd ' + (ar.laatste_ok || 'nooit') + ', ' + (ar.mislukt || 0) + ' fouten sinds de reset)';
  }
  if (m.pg_wal_bytes != null && Number(m.pg_wal_bytes) > PG_WAL_GRENS) a.pg_wal = 'pg_wal is ' + gb(m.pg_wal_bytes) + ' (grens 2 GB)';
  return a;
}

// staat { sinds: {soort: ms}, gemeld: {soort: {op: ms, hersteld: ms|null}} }, meting, nu (ms)
// → { staat (nieuw object), melden: [{ soort, tekst, sinds }], nu: { soort: tekst } }
function stap(staat, meting, nu) {
  const oud = staat && typeof staat === 'object' ? staat : {};
  const sinds = Object.assign({}, oud.sinds || {}), gemeld = {};
  Object.keys(oud.gemeld || {}).forEach(function (s) { gemeld[s] = Object.assign({}, oud.gemeld[s]); });
  const a = afwijkingen(meting), melden = [];
  Object.keys(DREMPEL_MS).forEach(function (s) {
    if (!a[s]) {
      delete sinds[s];
      if (gemeld[s]) {
        if (!gemeld[s].hersteld) gemeld[s].hersteld = nu;
        if (nu - gemeld[s].op >= STIL_NA_MELDING_MS) delete gemeld[s];
      }
      return;
    }
    if (typeof sinds[s] !== 'number') sinds[s] = nu;
    if (nu - sinds[s] < DREMPEL_MS[s]) return;
    const g = gemeld[s];
    if (g && (!g.hersteld || nu - g.op < STIL_NA_MELDING_MS)) {
      if (g.hersteld && g.hersteld < sinds[s]) g.hersteld = null;   // nieuwe afwijking binnen de stille 24 u: stil, telt als lopend
      return;
    }
    gemeld[s] = { op: nu, hersteld: null };
    melden.push({ soort: s, tekst: a[s], sinds: sinds[s] });
  });
  return { staat: { sinds: sinds, gemeld: gemeld }, melden: melden, nu: a };
}

function klok(ms) { return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).slice(0, 16); }

// melden (uit stap) → tekst van één box-rij (met witregel ervoor, zoals ovisBoxRij verwacht)
function boxRij(melden, nu) {
  const kop = melden.map(function (m) { return m.soort.replace('_', ' '); }).join(', ');
  return '\n## [direct] ' + klok(nu) + ' — Databankreserve R230: ' + kop + ' (automatisch, wv3416)\n' +
    '- status: open\n- van: pod server.js (reservewacht db-reserve-wacht.js; één rij per afwijking, geen herhaling, geen rij bij herstel)\n' +
    '- gemeten: ' + melden.map(function (m) { return m.tekst + ' (sinds ' + klok(m.sinds) + ')'; }).join('; ') + '. /health db.reserve en db.reserve_wacht tonen de stand.\n' +
    '- gevolg als er niets gebeurt: valt Olares weg, dan is de kopie op de R230 verouderd of onbruikbaar en gaat er bij een uitwijk data verloren.\n' +
    '- voorstel: verbinding: db-diensten.log (supervisor) en op de R230 `sudo ss -ltnp | grep 55432` (dode sshd-sessie); slot weg/lost: ' +
    '`uitwijk-reserve init --opnieuw` op de R230; archief: wal-archief en archive_command nalopen; pg_wal: welk slot of archief houdt WAL vast.\n';
}

module.exports = { afwijkingen: afwijkingen, stap: stap, boxRij: boxRij, DREMPEL_MS: DREMPEL_MS, PG_WAL_GRENS: PG_WAL_GRENS, STIL_NA_MELDING_MS: STIL_NA_MELDING_MS };
