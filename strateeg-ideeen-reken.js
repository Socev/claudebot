'use strict';
// wv4012 — OVIS Beleggen › Strateeg › zesde boek "Ideeën": puur rekenwerk (geen netwerk, geen klok, geen databank). Ontwerp
// mk-scripts/wv4012/ontwerp.md (Fable 5.2). Een stelling = één toetsbare gebeurtenis met een uiterste datum, een eigen kans en wat de markt al
// inprijst. Hier: koppen schonen en ontdubbelen, voorstellen van het taalmodel verifiëren, Polymarket lezen, koop- en verkoopregels,
// de hash van een vastgelegde stelling en de scores (Brier, kalibratie, meeropbrengst).
const crypto = require('crypto');

// ── tekst ──
function schoon(t, n) {
  return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/<[^>]{0,200}>/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n || 240);
}
function veiligeLink(l) { const s = String(l || '').trim(); return /^https:\/\/[^\s"<>]{3,600}$/.test(s) ? s : null; }
function uitgeverVan(t) { const m = / - ([^-]{2,60})$/.exec(String(t)); return m ? m[1].trim() : ''; }
function kernWoorden(t) {
  return String(t).replace(/ - [^-]{2,60}$/, '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter((w) => w.length > 2);
}
function gelijkenis(a, b) { const A = new Set(a), B = new Set(b); let n = 0; A.forEach((x) => { if (B.has(x)) n++; }); return n / Math.max(1, Math.min(A.size, B.size)); }
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function woordRe(namen) {
  const l = (namen || []).map((n) => String(n).trim()).filter((n) => n.length >= 2);
  return l.length ? new RegExp('(^|[^\\p{L}\\p{N}])(' + l.map(esc).join('|') + ')(?![\\p{L}\\p{N}])', 'iu') : null;
}
function kaal(n) {
  return String(n || '').toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(INC|CORP|CORPORATION|CO|LTD|PLC|NV|N V|SA|AG|SE|ASA|AB|HOLDING|HOLDINGS|GROUP|CLASS|CL|A|B|C|THE|DL|EO|SF|DK|LS|ADR|REGISTERED|SHARES|AKTIE)\b/g, ' ')
    .replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function sleutelVan(bron, link, titel) { return crypto.createHash('sha256').update(bron + '|' + (link || '') + '|' + kernWoorden(titel).join(' ')).digest('hex').slice(0, 24); }

// ── koppen: feed-items → koppen (reclame weg, belang gemarkeerd), en ontdubbelen tot feiten met het aantal uitgevers ──
const RECLAME = /\b(stocks? to buy|should you buy|buy now|is it time to buy|better .{0,30} stock|top \d+ |price target|koersdoel|kooptip|koopadvies|forecast|prediction|could soar|soars?|millionaire|dividend stock|undervalued|overvalued|cheap stock|wall street thinks|analysts? (say|says|upgrade|downgrade)|(buy|sell|hold) rating|aandelentip|tips?)\b/i;
const RUISBRON = /^(The Motley Fool|Motley Fool|Seeking Alpha|Simply Wall St|Zacks.*|MarketBeat|Benzinga|InvestorPlace|24\/7 Wall St\.?|TipRanks.*|GuruFocus.*|AInvest|Finimize|Insider Monkey|Stock Titan|Investing\.com.*|ad-hoc-news\.de|parameter\.io|Kalkine.*|Defense World|ETF Daily News|MarketScreener|marketscreener\.com|IG|Beursduivel.*|IEX\.nl|Briefs Finance|Barchart.*)$/i;
function isReclame(titel) { return RECLAME.test(titel) || RUISBRON.test(uitgeverVan(titel)); }
function koppenUit(items, bron, hard, belangRe, vraag) {
  const uit = [];
  for (const it of items || []) {
    const titel = schoon(it.titel, 200), link = veiligeLink(it.link);
    if (!titel || !link || isReclame(titel)) continue;
    const ms = it.datum ? Date.parse(it.datum) : NaN;
    uit.push({ sleutel: sleutelVan(bron, link, titel), bron, hard: hard ? 1 : 0, uitgever: schoon(it.uitgever || uitgeverVan(titel) || bron, 60), titel, link,
      datum: Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null, ms: Number.isFinite(ms) ? ms : null, vraag: vraag || null,
      belang: belangRe && belangRe.test(titel) ? 1 : 0 });
  }
  return uit;
}
// ontdubbelen: ≥ 60 % gedeelde kernwoorden = één feit; melders = aantal verschillende uitgevers
function clusters(koppen) {
  const cl = [];
  for (const k of koppen) {
    const w = kernWoorden(k.titel);
    let c = cl.find((x) => gelijkenis(x.w, w) >= 0.6);
    if (!c) { c = { w, leden: [], uitgevers: new Set(), hard: 0 }; cl.push(c); }
    c.leden.push(k); c.uitgevers.add(String(k.uitgever).toLowerCase()); if (k.hard) c.hard = 1;
  }
  return cl.map((c) => { const e = c.leden.slice().sort((a, b) => (b.hard - a.hard) || ((b.ms || 0) - (a.ms || 0)))[0]; return { eerste: e, leden: c.leden, melders: c.uitgevers.size, hard: c.hard, belang: c.leden.some((x) => x.belang) ? 1 : 0 }; });
}
// rangorde: aantal uitgevers (officiële bron telt als twee extra), dan nieuwste; hooguit perBron uit één bron die geen nieuwszoeker is
// (droge ronde 23-11: zonder die grens vulden SEC-meldingen van kleine fondsen en weken oude AFM-berichten alle 60 plekken)
function rangKoppen(cl, max, perBron) {
  const tel = {}, uit = [];
  for (const c of cl.filter((x) => !x.belang).sort((a, b) => ((b.melders + 2 * b.hard) - (a.melders + 2 * a.hard)) || ((b.eerste.ms || 0) - (a.eerste.ms || 0)))) {
    const br = c.eerste.bron; if (perBron && br !== 'gnews' && (tel[br] || 0) >= perBron) continue;
    tel[br] = (tel[br] || 0) + 1; uit.push(c); if (uit.length >= max) break;
  }
  return uit;
}
function recent(koppen, vanaf) { return koppen.filter((k) => k.datum && k.datum >= vanaf); }
// SEC-treffer alleen voor een bedrijf met een beurscode uit de grootste (company_tickers.json staat op grootte, gemeten 23-11: Apple 0, Microsoft 1)
function secTop(tekst, n) { let d; try { d = typeof tekst === 'string' ? JSON.parse(tekst) : tekst; } catch (e) { return null; } if (!d || typeof d !== 'object') return null;
  return Object.keys(d).sort((a, b) => Number(a) - Number(b)).slice(0, n).map((k) => String((d[k] || {}).ticker || '').toUpperCase()).filter(Boolean); }
function secGroot(titel, top) { const m = /\(([A-Z0-9., ]{1,40})\): 8-K/.exec(titel); if (!m) return false; return m[1].split(/[, ]+/).some((t) => top.has(t)); }

// ── SEC volledige-tekstzoeker → koppen (alleen de gekozen 8-K-punten) ──
const ITEM8K = { '1.01': 'belangrijke overeenkomst', '2.01': 'overname of verkoop afgerond', '5.02': 'bestuur gewijzigd' };
function secKoppen(tekst, items) {
  let d; try { d = typeof tekst === 'string' ? JSON.parse(tekst) : tekst; } catch (e) { return []; }
  const hits = d && d.hits && Array.isArray(d.hits.hits) ? d.hits.hits : [];
  const gezien = new Set(), uit = [];
  for (const h of hits) {
    const s = h && h._source; if (!s || !/^8-K/.test(String(s.form || ''))) continue;
    const it = (s.items || []).filter((x) => items.includes(x)); if (!it.length) continue;
    const adsh = String(s.adsh || ''); if (!/^\d{10}-\d{2}-\d{6}$/.test(adsh) || gezien.has(adsh)) continue; gezien.add(adsh);
    const cik = String((s.ciks || [])[0] || '').replace(/^0+/, ''); if (!/^\d{1,10}$/.test(cik)) continue;
    const naam = schoon(String((s.display_names || [])[0] || '').replace(/\s*\(CIK[^)]*\)/, ''), 120);
    uit.push({ titel: naam + ': 8-K ' + it.map((x) => ITEM8K[x] || x).join(', '), link: 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + adsh.replace(/-/g, '') + '/', datum: s.file_date || null, uitgever: 'SEC' });
  }
  return uit;
}

// ── Polymarket ──
function getal(x) { const n = typeof x === 'string' ? Number(x) : x; return typeof n === 'number' && isFinite(n) ? n : null; }
function polyPrijs(m) {   // kans op "Yes": midden van bod en laat, anders laatste koers, anders outcomePrices[0]
  const b = getal(m.bestBid), a = getal(m.bestAsk);
  if (b != null && a != null && a >= b && a - b <= 0.2) return (a + b) / 2;
  const l = getal(m.lastTradePrice); if (l != null && l >= 0 && l <= 1) return l;
  try { const p = JSON.parse(m.outcomePrices); const v = getal(p[0]); if (v != null) return v; } catch (e) { /* */ }
  return null;
}
function polyJaNee(m) { try { const o = JSON.parse(m.outcomes); return Array.isArray(o) && o.length === 2 && /^yes$/i.test(o[0]) && /^no$/i.test(o[1]); } catch (e) { return false; } }
function plusDagen(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function polyMarkten(tekst) {   // public-search → platte lijst markten
  let d; try { d = typeof tekst === 'string' ? JSON.parse(tekst) : tekst; } catch (e) { return []; }
  const uit = [];
  for (const e of (d && Array.isArray(d.events) ? d.events : [])) for (const m of (Array.isArray(e.markets) ? e.markets : [])) uit.push(Object.assign({ _event: e.slug }, m));
  return uit;
}
function polyKandidaten(markten, beslisdatum, cfg) {
  const van = plusDagen(beslisdatum, cfg.eind_van), tot = plusDagen(beslisdatum, cfg.eind_tot);
  const uit = [], gezien = new Set();
  for (const m of markten) {
    const id = String(m.id || ''); if (!/^\d{1,12}$/.test(id) || gezien.has(id)) continue;
    if (m.closed || m.active === false || !polyJaNee(m)) continue;
    const liq = getal(m.liquidityNum) || 0, vol = getal(m.volumeNum) || 0;
    if (liq < cfg.liquiditeit_min && vol < cfg.volume_min) continue;
    const eind = String(m.endDate || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(eind) || eind < van || eind > tot) continue;
    const p = polyPrijs(m); if (p == null) continue;
    gezien.add(id);
    uit.push({ id, vraag: schoon(m.question, 200), prijs: p, eind, liq: Math.round(liq), vol: Math.round(vol), slug: /^[a-z0-9-]{1,200}$/.test(String(m._event || '')) ? m._event : null });
  }
  return uit.sort((a, b) => b.vol - a.vol).slice(0, 5);
}
function polyStand(tekst) {   // /markets/<id> → {open, prijs, uitkomst}
  let m; try { m = typeof tekst === 'string' ? JSON.parse(tekst) : tekst; } catch (e) { return null; }
  if (!m || typeof m !== 'object' || !polyJaNee(m)) return null;
  const p = polyPrijs(m);
  let eind = null; try { const o = JSON.parse(m.outcomePrices); eind = getal(o[0]); } catch (e) { /* */ }
  return { open: !m.closed, prijs: p, slot: m.closed ? eind : null };
}

// ── bedrijf: tarief en beurs uit het ISIN-voorvoegsel; L&S-treffer kiezen ──
const RE_ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
function isinOk(s) {   // vorm + Luhn-controlecijfer (een verzonnen ISIN valt hier meestal al af)
  if (!RE_ISIN.test(String(s || ''))) return false;
  const cijfers = String(s).split('').map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join('');
  let som = 0, dubbel = false;
  for (let i = cijfers.length - 1; i >= 0; i--) { let d = Number(cijfers[i]); if (dubbel) { d *= 2; if (d > 9) d -= 9; } som += d; dubbel = !dubbel; }
  return som % 10 === 0;
}
function tariefVan(isin) {
  const p = String(isin || '').slice(0, 2);
  if (p === 'US') return { tarief: 'VS', beurs: 'VS' };
  if (p === 'NL' || p === 'BE') return { tarief: 'NL', beurs: 'EA' };
  if (['DE', 'FR', 'IE', 'ES', 'IT', 'FI', 'AT', 'LU'].includes(p)) return { tarief: 'EU', beurs: 'XE' };
  if (p === 'DK') return { tarief: 'EUV', beurs: 'CPH' };
  if (p === 'CH') return { tarief: 'EUV', beurs: 'SIX' };
  if (p === 'GB') return { tarief: 'EUVL', beurs: 'LSE' };
  return null;
}
function lsTreffers(tekst) {
  let d; try { d = typeof tekst === 'string' ? JSON.parse(tekst) : tekst; } catch (e) { return []; }
  return (Array.isArray(d) ? d : []).filter((x) => x && x.categorySymbol === 'STK' && RE_ISIN.test(String(x.isin || '')) && /^\d{1,9}$/.test(String(x.instrumentId)))
    .map((x) => ({ id: Number(x.instrumentId), isin: x.isin, naam: String(x.displayname || '').replace(/\s+/g, ' ').trim().slice(0, 80) }));
}
function naamWoorden(n) { return kaal(n).split(' ').filter((w) => w.length >= 3); }
// op ISIN: precies die ISIN en het eerste naamwoord komt voor in de L&S-naam
function lsKiesIsin(treffers, isin, naam) {
  const t = treffers.filter((x) => x.isin === isin); if (t.length !== 1) return null;
  const w = naamWoorden(naam); if (!w.length) return null;
  return kaal(t[0].naam).split(' ').includes(w[0]) || kaal(t[0].naam).includes(w[0]) ? t[0] : null;
}
// op naam (L&S zoekt alleen op één woord): de enige aandelentreffer waarvan de naam alle naamwoorden bevat; 0 of ≥ 2 = niet te kiezen
// bekend: ISIN's die de Strateeg al gemeten heeft (universum); bij meerdere noteringen wint precies één bekende (Roche: genotsbewijs, aandeel, ADR)
function lsKiesNaam(treffers, naam, bekend) {
  const w = naamWoorden(naam); if (!w.length) return null;
  const t = treffers.filter((x) => { const k = kaal(x.naam); return w.every((y) => k.includes(y)); });
  let isins = [...new Set(t.map((x) => x.isin))];
  if (isins.length > 1 && bekend) { const b = isins.filter((i) => bekend.includes(i)); if (b.length === 1) isins = b; }
  return isins.length === 1 ? t.find((x) => x.isin === isins[0]) : null;
}

// ── voorstel van het model verifiëren (aanroep A / D2) ──
// ctx: { vandaag, koppen: {kid: kop}, belangRe, concurrentRe, cfg }
const SOORTEN = ['bestuur', 'overname', 'toezicht', 'rechtszaak', 'product', 'studie', 'cijfers', 'anders'];
const THEMAS = ['tech', 'health', 'overig'];
function verifieer(v, ctx) {
  const cfg = ctx.cfg;
  if (!v || typeof v !== 'object') return { ok: false, code: 'vorm' };
  const ids = (Array.isArray(v.bron_ids) ? v.bron_ids : []).map(String).filter((x) => ctx.koppen[x]);
  if (!ids.length || ids.length !== (v.bron_ids || []).length) return { ok: false, code: 'bron_weg' };
  const tekst = schoon(v.tekst, 240), toets = schoon(v.toets, 240), waarom = schoon(v.waarom, 400), kat = schoon(v.katalysator, 160), ir = schoon(v.ingeprijsd_reden, 240);
  if (!tekst || !toets) return { ok: false, code: 'vorm' };
  const naam = schoon(v.bedrijf && v.bedrijf.naam, 80);
  if (!naam) return { ok: false, code: 'vorm' };
  if (ctx.belangRe && [tekst, toets, waarom, kat, ir, naam].some((x) => ctx.belangRe.test(x))) return { ok: false, code: 'belang' };
  const bd = String(v.beslisdatum || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd) || bd <= ctx.vandaag || bd > plusDagen(ctx.vandaag, cfg.stelling.termijn_max_dagen)) return { ok: false, code: 'datum' };
  const kans = getal(v.kans), ing = getal(v.ingeprijsd_schatting);
  if (kans == null || kans < cfg.koop.kans_grens[0] || kans > cfg.koop.kans_grens[1]) return { ok: false, code: 'kans' };
  if (ing == null || ing < 0 || ing > 1) return { ok: false, code: 'kans' };
  const kap = (x) => Math.max(-cfg.koop.effect_max, Math.min(cfg.koop.effect_max, (getal(x) || 0) / 100));
  const isin = String((v.bedrijf && v.bedrijf.isin) || '').toUpperCase().trim();
  const ticker = String((v.bedrijf && v.bedrijf.ticker) || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 10);
  if (isin && (ctx.cfg.nooit || []).includes(isin)) return { ok: false, code: 'belang' };
  return { ok: true, s: {
    tekst, toets, waarom, katalysator: kat, ingeprijsd_reden: ir, soort: SOORTEN.includes(v.soort) ? v.soort : 'anders', thema: THEMAS.includes(v.thema) ? v.thema : 'overig',
    bedrijf: naam, ticker, isin_model: isinOk(isin) ? isin : null, beslisdatum: bd, kans_eigen: Math.round(kans * 1000) / 1000, ingeprijsd_model: Math.round(ing * 1000) / 1000,
    effect_ja: kap(v.effect_ja_pct), effect_nee: kap(v.effect_nee_pct), bron_ids: ids,
    zoek: (Array.isArray(v.zoek_en) ? v.zoek_en : []).map((x) => schoon(x, 120)).filter(Boolean).slice(0, 2),
    poly_zoek: (Array.isArray(v.poly_zoek) ? v.poly_zoek : []).map((x) => schoon(x, 80)).filter(Boolean).slice(0, 2),
    belang_label: ctx.concurrentRe && [tekst, waarom, naam].some((x) => ctx.concurrentRe.test(x)) ? 'concurrent' : null,
  } };
}

// ── vastleggen: canonieke hash (sleutels gesorteerd, hash zelf eruit) ──
function canoniek(o) {
  if (Array.isArray(o)) return '[' + o.map(canoniek).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).filter((k) => k !== 'hash').sort().map((k) => JSON.stringify(k) + ':' + canoniek(o[k])).join(',') + '}';
  return JSON.stringify(o === undefined ? null : o);
}
function hashVan(rij) { return crypto.createHash('sha256').update(canoniek(rij)).digest('hex'); }

// ── koopregels (§ 3.1). st: vastgelegde stelling; boek {contant, posities [{isin, thema}]}, waarde; uit: {ok, reden, bedrag} ──
function voordeelVan(st) { return st.kans_eigen - st.ingeprijsd; }
function verwachtVan(st) { return voordeelVan(st) * (st.effect_ja - st.effect_nee); }
function koopToets(st, boek, waarde, cfg, koersNu) {
  const k = cfg.koop;
  if (!st.ls_id || !st.tarief) return { ok: false, reden: 'niet_te_koop' };
  if (st.effect_ja < k.effect_ja_min) return { ok: false, reden: 'niet_lang' };
  if (st.kans_eigen < k.kans_min) return { ok: false, reden: 'kans_laag' };
  const lat = st.ingeprijsd_hoe === 'polymarket' ? k.voordeel_poly : k.voordeel_model;
  if (voordeelVan(st) < lat - 1e-9) return { ok: false, reden: 'voordeel_klein' };
  if (verwachtVan(st) < k.verwacht_min - 1e-9) return { ok: false, reden: 'verwacht_klein' };
  // wat de koers sinds het nieuws al deed: tot het vastleggen (koersreactie) en daarna tot nu (koers nu tegen koers_vast)
  const kr = st.koersreactie || 0;
  const gelopen = koersNu && st.koers_vast ? (1 + kr) * (koersNu / st.koers_vast) - 1 : kr;
  if (gelopen >= k.al_gelopen * st.effect_ja) return { ok: false, reden: 'al_gelopen' };
  if (boek.posities.some((p) => p.isin === st.isin)) return { ok: false, reden: 'al_in_boek' };
  if (boek.posities.length >= k.posities) return { ok: false, reden: 'boek_vol' };
  if (boek.posities.filter((p) => p.thema === st.thema).length >= k.max_per_thema) return { ok: false, reden: 'thema_vol' };
  const bedrag = Math.min(k.per_positie * waarde, boek.contant - k.contant_min * waarde);
  if (!(bedrag >= k.min_order)) return { ok: false, reden: 'geen_geld' };
  return { ok: true, reden: 'koop', bedrag };
}
// verkoopregels (§ 3.2): nooit op koersgedrag, behalve de noodrem; stand {status, kans_nu, ingeprijsd_nu, koop_midden, koop_dag}
function verkoopReden(st, stand, koersNu, beursdagenGehouden, cfg) {
  if (stand.status === 'uitgekomen') return 'uitgekomen';
  if (stand.status === 'weerlegd') return 'weerlegd';
  if (stand.status === 'vervallen') return 'vervallen';
  if (koersNu && stand.koop_midden && koersNu / stand.koop_midden - 1 <= -cfg.verkoop.noodrem) return 'noodrem';
  if (beursdagenGehouden >= cfg.verkoop.houd_beursdagen) {
    if (stand.kans_nu != null && stand.kans_nu <= st.ingeprijsd) return 'voordeel_weg';
    if (st.ingeprijsd_hoe === 'polymarket' && stand.ingeprijsd_nu != null && stand.kans_nu != null && stand.ingeprijsd_nu >= stand.kans_nu - cfg.verkoop.markt_ingehaald) return 'markt_ingehaald';
    if (st.ingeprijsd_hoe === 'polymarket' && stand.ingeprijsd_nu != null && stand.kans_nu == null && stand.ingeprijsd_nu >= st.kans_eigen - cfg.verkoop.markt_ingehaald) return 'markt_ingehaald';
  }
  return null;
}
// uitkomst uit een oordeel van het model: alleen met een harde bron of ≥ 2 uitgevers
function bewijsGenoeg(kopRijen) { if (!kopRijen.length) return false; if (kopRijen.some((k) => k.hard)) return true; return new Set(kopRijen.map((k) => String(k.uitgever).toLowerCase())).size >= 2 || kopRijen.some((k) => (k.melders || 1) >= 2); }

// ── scores (§ 5) ──
function gem(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function sd(a) { if (a.length < 2) return null; const m = gem(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }
function scores(rijen, cfg) {   // rijen: [{kans_eigen, ingeprijsd, ingeprijsd_hoe, uitkomst (0/1/null), bron, meer (null of getal), noodrem}]
  const b = rijen.filter((r) => r.uitkomst === 0 || r.uitkomst === 1);
  const groep = (l) => ({ n: l.length, brier_eigen: l.length ? gem(l.map((r) => (r.kans_eigen - r.uitkomst) ** 2)) : null, brier_markt: l.length ? gem(l.map((r) => (r.ingeprijsd - r.uitkomst) ** 2)) : null,
    uitgekomen: l.filter((r) => r.uitkomst === 1).length });
  const bakjes = [0, 1, 2, 3, 4].map((i) => { const l = b.filter((r) => Math.min(4, Math.floor(r.kans_eigen * 5)) === i); return { van: i * 0.2, tot: (i + 1) * 0.2, n: l.length, voorspeld: l.length ? gem(l.map((r) => r.kans_eigen)) : null, werkelijk: l.length ? gem(l.map((r) => r.uitkomst)) : null }; });
  const meer = rijen.filter((r) => typeof r.meer === 'number' && isFinite(r.meer)).map((r) => r.meer);
  const s = sd(meer);
  const o = cfg.oordeel, poly = b.filter((r) => r.ingeprijsd_hoe === 'polymarket').length;
  const zin = b.length < o.niets ? 'Te weinig besliste stellingen om iets te zeggen (' + b.length + ' van de minstens ' + o.niets + ').'
    : (b.length < o.aanwijzing || poly < o.poly_min) ? 'Een aanwijzing, geen bewijs: ' + b.length + ' besliste stellingen, waarvan ' + poly + ' met een Polymarket-markt als maatstaf.'
    : 'Genoeg om te oordelen: ' + b.length + ' besliste stellingen, ' + poly + ' met Polymarket.';
  return {
    vastgelegd: rijen.length, beslist: b.length, alle: groep(b), polymarket: groep(b.filter((r) => r.ingeprijsd_hoe === 'polymarket')), model: groep(b.filter((r) => r.ingeprijsd_hoe !== 'polymarket')),
    david: groep(b.filter((r) => r.bron === 'david')), nieuws: groep(b.filter((r) => r.bron !== 'david')),
    bakjes, meer: { n: meer.length, gem: gem(meer), fout2: s != null ? 2 * s / Math.sqrt(meer.length) : null }, noodrem: rijen.filter((r) => r.noodrem).length, zin,
  };
}

module.exports = { schoon, veiligeLink, uitgeverVan, kernWoorden, gelijkenis, woordRe, kaal, sleutelVan, isReclame, koppenUit, clusters, rangKoppen, secKoppen,
  recent, secTop, secGroot, polyPrijs, polyMarkten, polyKandidaten, polyStand, isinOk, tariefVan, lsTreffers, lsKiesIsin, lsKiesNaam, naamWoorden, verifieer, canoniek, hashVan,
  voordeelVan, verwachtVan, koopToets, verkoopReden, bewijsGenoeg, scores, plusDagen, gem, SOORTEN, THEMAS };
