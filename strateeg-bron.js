'use strict';
// wv3993 — OVIS Beleggen › Strateeg: ontleden van bronantwoorden (puur, geen netwerk; ophalen gaat via de ingespoten haal() in server.js).
// Koersen komen van Lang & Schwarz Exchange (ls-tc.de, gratis, EUR, 07:30–23:00, persoonlijk niet-commercieel gebruik toegestaan; gemeten
// 23-11-2026, mk-scripts/wv3993/metingen.md). Tradegate valt af: zijn voorwaarden verbieden geautomatiseerde toegang.
//
// Valkuilen in de L&S-dagreeks (gemeten op 68 reeksen): weekendpunten met ONgecorrigeerde koersen (NVIDIA ×4 op zaterdag rond splitsingen),
// en een handvol ééndagsuitschieters die de volgende dag terugkeren (AstraZeneca 27-03-2025 ×0,5 → ×1,99). Beide gaan eruit.

const LS = 'https://www.ls-tc.de/_rpc/json';
const RE_ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

function lsZoekUrl(isin) { if (!RE_ISIN.test(String(isin))) throw new Error('isin'); return LS + '/.lstc/instrument/search/main?q=' + isin + '&localeId=2'; }
function lsReeksUrl(id, serie) {
  if (!/^\d{1,9}$/.test(String(id))) throw new Error('id');
  if (serie !== 'intraday' && serie !== 'history') throw new Error('serie');
  return LS + '/instrument/chart/dataForInstrument?instrumentId=' + id + '&marketId=1&quotetype=mid&series=' + serie + '&localeId=2';
}

function json(tekst) { if (tekst && typeof tekst === 'object') return tekst; try { return JSON.parse(String(tekst)); } catch (e) { return null; } }

// Zoekantwoord → instrumentId voor precies deze ISIN (anders null)
function lsZoekId(tekst, isin) {
  const d = json(tekst);
  if (!Array.isArray(d)) return null;
  const r = d.find((x) => x && x.isin === isin && /^\d{1,9}$/.test(String(x.instrumentId)));
  return r ? { id: Number(r.instrumentId), naam: String(r.displayname || '').replace(/\s+/g, ' ').trim().slice(0, 80) } : null;
}

function goedGetal(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v < 1e7; }

// Nederlandse kalenderdag van een tijdstip (ms)
const NL_DAG = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
function nlDag(ms) { return NL_DAG.format(new Date(ms)); }
function weekdag(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }   // 0 = zondag, 6 = zaterdag

// Dagreeks → [{d: 'jjjj-mm-dd', k: koers}] oplopend, alleen werkdagen, laatste punt per dag (weekendpunten weg: daar staan ongecorrigeerde koersen).
// vandaag (iso) = het punt van vandaag telt niet mee als slot (het is een lopende koers).
function lsDagreeks(tekst, vandaag) {
  const d = json(tekst);
  const data = d && d.series && d.series.history && Array.isArray(d.series.history.data) ? d.series.history.data : null;
  if (!data) return null;
  const perDag = new Map();
  for (const p of data) {
    if (!Array.isArray(p) || typeof p[0] !== 'number' || !goedGetal(p[1])) continue;
    const dag = nlDag(p[0]);
    if (vandaag && dag >= vandaag) continue;
    const wd = weekdag(dag);
    if (wd === 0 || wd === 6) continue;
    perDag.set(dag, p[1]);
  }
  // geen opschoning van uitschieters: elke opschoning die naar latere dagen kijkt is vooruitkijken (Codex-MOET 1, 23-11)
  return [...perDag.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dag, k]) => ({ d: dag, k: k }));
}

// NIET gebruikt (kijkt vooruit; Codex-MOET 1): alleen bewaard als meetgereedschap voor losse analyses.
function zonderUitschieters(rij) {
  const weg = new Set();
  for (let i = 1; i < rij.length - 1; i++) {
    const a = rij[i - 1].k;
    const sprong = Math.log(rij[i].k / a);
    if (Math.abs(sprong) < Math.log(1.3)) continue;
    for (let j = i + 1; j <= Math.min(i + 4, rij.length - 1); j++) {
      const terug = Math.log(rij[j].k / a);
      if (Math.abs(terug) <= 0.2 * Math.abs(sprong)) { for (let x = i; x < j; x++) weg.add(x); break; }
    }
  }
  return weg.size ? rij.filter((_, i) => !weg.has(i)) : rij;
}

// Intraday → { punten: [[ms, koers]], laatste: {ms, k}, vorige: slot vorige dag | null }
function lsIntraday(tekst) {
  const d = json(tekst);
  const data = d && d.series && d.series.intraday && Array.isArray(d.series.intraday.data) ? d.series.intraday.data : null;
  if (!data) return null;
  const punten = data.filter((p) => Array.isArray(p) && typeof p[0] === 'number' && goedGetal(p[1])).map((p) => [p[0], p[1]]);
  let vorige = null;
  const pl = d.info && Array.isArray(d.info.plotlines) ? d.info.plotlines.find((x) => x && x.id === 'previousDay') : null;
  if (pl && goedGetal(pl.value)) vorige = pl.value;
  const isin = d.info && typeof d.info.isin === 'string' ? d.info.isin : null;
  return { isin: isin, punten: punten, laatste: punten.length ? { ms: punten[punten.length - 1][0], k: punten[punten.length - 1][1] } : null, vorige: vorige };
}

// ── Wikipedia-pageviews (wikimedia REST, dagelijks, alleen gebruikers) ──
function wikiUrl(titel, van, tot) {
  const t = String(titel || ''); if (!t || t.length > 120 || /[\/\s]/.test(t)) throw new Error('titel');
  if (!/^\d{8}$/.test(van) || !/^\d{8}$/.test(tot)) throw new Error('datum');
  return 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/' + encodeURIComponent(t) + '/daily/' + van + '/' + tot;
}
function wikiRijen(tekst) {
  const d = json(tekst); if (!d || !Array.isArray(d.items)) return null;
  return d.items.filter((x) => x && /^\d{10}$/.test(String(x.timestamp)) && Number.isFinite(x.views) && x.views >= 0)
    .map((x) => ({ d: x.timestamp.slice(0, 4) + '-' + x.timestamp.slice(4, 6) + '-' + x.timestamp.slice(6, 8), v: x.views }));
}

// ── SEC: kwartaalcijfers = 8-K met punt 2.02 (indiendatum) ──
function secUrl(cik) { if (!/^\d{1,10}$/.test(String(cik))) throw new Error('cik'); return 'https://data.sec.gov/submissions/CIK' + String(cik).padStart(10, '0') + '.json'; }
function secDeelUrl(naam) { if (!/^CIK\d{10}-submissions-\d{3}\.json$/.test(String(naam))) throw new Error('naam'); return 'https://data.sec.gov/submissions/' + naam; }
function secKolommen(d) { return d && d.filings && d.filings.recent ? d.filings.recent : d; }
function secCijferdagen(tekst) {
  const d = json(tekst); const r = secKolommen(d);
  if (!r || !Array.isArray(r.form) || !Array.isArray(r.filingDate)) return null;
  const uit = new Set();
  for (let i = 0; i < r.form.length; i++) {
    if ((r.form[i] === '8-K' || r.form[i] === '8-K/A') && String((r.items || [])[i] || '').split(',').includes('2.02') && /^\d{4}-\d{2}-\d{2}$/.test(r.filingDate[i])) uit.add(r.filingDate[i]);
  }
  return [...uit].sort();
}
function secDelen(tekst) { const d = json(tekst); return d && d.filings && Array.isArray(d.filings.files) ? d.filings.files.map((f) => f && f.name).filter((n) => /^CIK\d{10}-submissions-\d{3}\.json$/.test(String(n))) : []; }

// ── Nasdaq cijferkalender (per datum; alleen symbool + tijdstip) ──
function nasdaqCijferUrl(iso) { if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('datum'); return 'https://api.nasdaq.com/api/calendar/earnings?date=' + iso; }
function nasdaqCijfers(tekst) {
  const d = json(tekst); const rows = d && d.data && Array.isArray(d.data.rows) ? d.data.rows : (d && d.data && d.data.rows === null ? [] : null);
  if (!rows) return null;
  return rows.filter((x) => x && /^[A-Z.]{1,6}$/.test(String(x.symbol))).map((x) => ({ code: x.symbol, tijd: /after/.test(String(x.time)) ? 'na' : (/pre/.test(String(x.time)) ? 'voor' : 'onbekend') }));
}

module.exports = { LS, RE_ISIN, lsZoekUrl, lsReeksUrl, lsZoekId, lsDagreeks, lsIntraday, zonderUitschieters, nlDag, weekdag,
  wikiUrl, wikiRijen, secUrl, secDeelUrl, secCijferdagen, secDelen, nasdaqCijferUrl, nasdaqCijfers };
