// financien-vault.js — App Financiën, tabbladen Hypotheek, Belasting en Holding (wv1337; bouwplan "Privé-financiën - ontwerp levend
// overzicht (bouwplan 22-10-2026)" § 13). Leest alleen uit de vault, nooit uit de bank: de bankdatabase blijft bij financien-app.js.
//
// WAAROM. David 26-10-2026: "Inmiddels is er zoveel over de financiën dat die app ook wel uitgebreid kan; onder andere met overzicht
// Hypotheken, minstens". Op 26-10 leverde hij (via Claude Desktop) de bankstand van de hypotheek naast zijn eigen Excel, 33 aangiftes
// IB 2011-2025 en de reconstructie van de leningen en de rekening-courant met de Holding aan; de nachtronde maakte er vaultpagina's van.
//
// BRONNEN (elk getal draagt zijn bron mee; geen eigen rekenwerk behalve het verschil bank − Excel per deel en het kiezen van de vroegste
// rentevaste datum):
//   Hypotheek  — json "Prive - <datum> - Hypotheek bank vs Excel data.json" (nieuwste datum) in 20_Prive/Bronnen/Financien: bankstand per
//                leningdeel naast de eigen Excel; de Excel-reeks TOTAAL voor het verloop. Velden met een datum in de naam
//                (excel_restschuld_JJJJ_MM_DD, stand_JJJJ_MM_DD) worden op vorm gezocht, niet op één vaste datum; de datum gaat mee.
//                Rentevaste data komen uit de Excel (groen gemarkeerd), niet van de bank: de App zegt dat erbij. Einde looptijd en de ORV-polissen uit de pagina
//                "Hypotheek en overlijdensrisicoverzekeringen". Woninglening Holding uit de DGA-json (contract + jaarrekeningstanden).
//   Belasting  — de pagina "Belastingaangiftes IB 2011-2025" (tabellen David, Cynthia, eigen woning). NIET de kerncijfers-json: die is
//                automatisch uit de tekst gehaald en wijkt af (gemeten 27-10: in een jaar "terug" waar de aangifte bijbetalen zegt,
//                saldo's zonder Zvw), en de pagina zegt zelf dat de bronnotities leidend zijn.
//   Holding    — de besluitpagina "Afbouw rekening-courant en herstel woninglening" (planning, standen van de boekhouder, punten ter
//                bevestiging) en de DGA-json "Holding - <datum> - DGA-reconstructie data.json" (contracten, dividenden, reconstructie).
//
// WAT ER NIET IN HET ANTWOORD STAAT: IBAN, rekening-, lening- of polisnummer, BSN, transacties, omschrijvingen, tegenpartijen. Het antwoord
// wordt veld voor veld opgebouwd; elke tekst uit de vault gaat door schoon() (wikilinks naar hun naam, opmaak weg, IBAN en lange
// nummerreeksen gemaskeerd). Een kapotte of verplaatste bron maakt alleen dat blok leeg (fouten: ["hypotheek"] e.d.).
// Schrijft niets. Geen netwerk.
'use strict';
const fs = require('fs'), path = require('path');

const P_HYPO = path.join('20_Prive', 'Financien', 'Hypotheek en overlijdensrisicoverzekeringen.md');
const P_BEL = path.join('20_Prive', 'Financien', 'Belastingaangiftes IB 2011-2025.md');
const P_DGA = path.join('10_Zakelijk', 'Holding', 'Financieel', 'Afbouw rekening-courant en herstel woninglening (besluit 2026-10-26).md');
const D_HYPO = path.join('20_Prive', 'Bronnen', 'Financien'), RE_HYPO = /^Prive - (\d{4}-\d{2}-\d{2}) - Hypotheek bank vs Excel data\.json$/;
const D_DGA = path.join('10_Zakelijk', 'Holding', 'Bronnen'), RE_DGA = /^Holding - (\d{4}-\d{2}-\d{2}) - DGA-reconstructie data\.json$/;
const MAX_MD = 400000, MAX_JSON = 5 * 1024 * 1024;

// ── tekst ──
// IBAN, lange cijferreeksen (BSN, rekening) en gepunte nummers (12.34.56.789, 123.456.789) maskeren; bedragen (1.234,50) blijven
function schoon(s, n) {
  let t = String(s == null ? '' : s).normalize('NFC');
  t = t.replace(/\\\|/g, '|').replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, function (m, p) { return p.split('/').pop().replace(/\.(md|pdf)$/i, ''); });
  t = t.replace(/\*\*|__|`/g, '').replace(/(^|\s)\*([^*]+)\*/g, '$1$2').replace(/<[^>]*>/g, ' ');
  t = t.replace(/\b[A-Z]{2}\d{2}\s?[A-Z]{4}(\s?\d){7,}\b/g, '[rekening]');
  // een bedrag tot € 99 miljoen (1.234.567) blijft; 123.456.789 en 1234.567.890.123 zijn lening- of rekeningnummers
  t = t.replace(/\b\d{1,4}(\.\d{2,3}){2,}\b/g, function (m) { return /^\d{1,2}\.\d{3}\.\d{3}$/.test(m) ? m : '[nummer]'; });
  t = t.replace(/\b\d{7,}\b/g, '[nummer]');   // BSN, polis- en klantnummers (bedragen hebben punten)
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return n && t.length > n ? t.slice(0, n - 1).trim() + '…' : t;
}
// eerste getal in een cel: "€ 12.345,67" → 12345.67, "−1.234" → -1234, "1,23%" → 1.23, "4.20%" → 4.2, "–" → null (leeg), "–1.234" → -1234
function nlGetal(s) {
  const t = schoon(s).replace(/\s+/g, ' ');
  const m = /(^|[^\d.,])([+\-−–]?)\s*(?:€\s*)?(\d{1,3}(?:\.\d{3})+(?!\d)|\d+\.\d{1,2}(?![\d.])|\d+)(?:,(\d+))?/.exec(t);
  if (!m) return null;
  const decimaal = /^\d+\.\d{1,2}$/.test(m[3]) && !m[4];
  const v = Number(decimaal ? m[3] : m[3].replace(/\./g, '') + (m[4] ? '.' + m[4] : ''));
  if (!Number.isFinite(v)) return null;
  // "–" alleen als minteken als er direct een cijfer of € volgt ("– (in aanbouw)" is leeg en heeft geen cijfer)
  return m[2] === '-' || m[2] === '−' || m[2] === '–' ? -v : v;
}
// veld met een datum in de naam: nieuwste die bestaat, bv. excel_restschuld_2026_10_01 → { sleutel, datum: '2026-10-01' }
function datumVeld(o, voor) {
  if (!o || typeof o !== 'object') return null;
  const re = new RegExp('^' + voor + '(\\d{4})_(\\d{2})_(\\d{2})$');
  const k = Object.keys(o).map(function (x) { const m = re.exec(x); return m ? { sleutel: x, datum: m[1] + '-' + m[2] + '-' + m[3] } : null; }).filter(Boolean)
    .sort(function (a, b) { return a.datum < b.datum ? 1 : -1; })[0];
  return k || null;
}
function eersteVeld(o, re) { if (!o || typeof o !== 'object') return undefined; const k = Object.keys(o).find(function (x) { return re.test(x); }); return k ? o[k] : undefined; }
function getal(v) { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function datumIso(s) {
  const t = String(s || '');
  let m = /^(\d{4})-(\d{2})(?:-(\d{2}))?\b/.exec(t.trim());
  if (m) return m[1] + '-' + m[2] + (m[3] ? '-' + m[3] : '');
  m = /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/.exec(t);
  return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : null;
}
function norm(s) { return schoon(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }

// ── bestanden ──
function leesTekst(vault, rel, max) {
  const p = path.join(vault, rel);
  const st = fs.statSync(p);
  if (!st.isFile() || st.size > max) throw new Error('bron te groot of geen bestand');
  return { tekst: fs.readFileSync(p, 'utf8'), gewijzigd: st.mtime.toISOString() };
}
// nieuwste "… - <datum> - …json" in de map (een nieuwe aanlevering krijgt een nieuwe datum)
function nieuwste(vault, dir, re) {
  let namen = [];
  try { namen = fs.readdirSync(path.join(vault, dir)); } catch (e) { return null; }
  const hit = namen.map(function (n) { const m = re.exec(n); return m ? { n: n, d: m[1] } : null; }).filter(Boolean).sort(function (a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; })[0];
  return hit ? { rel: path.join(dir, hit.n), datum: hit.d } : null;
}
function leesJson(vault, rel) { return JSON.parse(leesTekst(vault, rel, MAX_JSON).tekst); }
function pagina(vault, rel) { const t = leesTekst(vault, rel, MAX_MD); return { rel: rel, tekst: t.tekst, gewijzigd: t.gewijzigd, fm: frontmatter(t.tekst) }; }
function frontmatter(t) {
  const m = /^---\n([\s\S]*?)\n---/.exec(t);
  const uit = {};
  if (m) m[1].split('\n').forEach(function (r) { const k = /^([a-z_]+):\s*(.*)$/.exec(r); if (k && k[2]) uit[k[1]] = k[2].replace(/^"|"$/g, ''); });
  return uit;
}

// ── markdowntabellen ──
// Splitst op | die niet ge-escaped is (wikilink [[a\|b]] in een cel)
function cellen(regel) {
  const r = regel.trim().replace(/^\|/, '').replace(/\|$/, '');
  const uit = []; let cur = '';
  for (let i = 0; i < r.length; i++) {
    if (r[i] === '\\' && r[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (r[i] === '|') { uit.push(cur.trim()); cur = ''; continue; }
    cur += r[i];
  }
  uit.push(cur.trim());
  return uit;
}
// Alle tabellen van een pagina, met de kop (genormaliseerd) en de rijen (ruwe cellen) en de koptekst (## …) erboven
function tabellen(t) {
  const regels = t.split('\n'), uit = [];
  let kopje = '';
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    if (/^#{2,4}\s/.test(r)) { kopje = r.replace(/^#+\s*/, '').trim(); continue; }
    if (/^\s*\|/.test(r) && i + 1 < regels.length && /^\s*\|[\s:|-]+\|\s*$/.test(regels[i + 1]) && /-/.test(regels[i + 1])) {
      const kop = cellen(r).map(norm), rijen = [];
      let j = i + 2;
      for (; j < regels.length && /^\s*\|/.test(regels[j]); j++) rijen.push(cellen(regels[j]));
      uit.push({ kopje: kopje, kop: kop, rijen: rijen });
      i = j - 1;
    }
  }
  return uit;
}
// eerste tabel waarvan de kop al deze kolommen heeft (exact, genormaliseerd); geeft per rij een object kolom → cel
function tabel(ts, moet) {
  const t = ts.find(function (x) { return moet.every(function (k) { return x.kop.indexOf(k) >= 0; }); });
  if (!t) return null;
  return t.rijen.map(function (r) { const o = {}; t.kop.forEach(function (k, i) { o[k] = r[i] === undefined ? '' : r[i]; }); return o; });
}
function opsomming(t, kop) {
  const i = t.split('\n').findIndex(function (r) { return /^#{2,4}\s/.test(r) && norm(r.replace(/^#+\s*/, '')) === norm(kop); });
  if (i < 0) return null;
  const uit = [];
  for (const r of t.split('\n').slice(i + 1)) {
    if (/^#{1,4}\s/.test(r)) break;
    const m = /^\s*[-*]\s+(.*)$/.exec(r);
    if (m) uit.push(m[1]);
    else if (/^\s+\S/.test(r) && uit.length) uit[uit.length - 1] += ' ' + r.trim();   // doorlopende regel van hetzelfde punt
  }
  return uit.slice(0, 15).map(function (x) { return schoon(x, 300); });
}

// ── Hypotheek ──
function hypotheek(vault) {
  const bron = nieuwste(vault, D_HYPO, RE_HYPO);
  if (!bron) throw new Error('hypotheek-json ontbreekt');
  const j = leesJson(vault, bron.rel);
  const pg = pagina(vault, P_HYPO), ts = tabellen(pg.tekst);
  // einde looptijd per Excel-deel uit de pagina (tabel Leningdelen); geen tabel = geen einddatum, de rest blijft
  const einde = {};
  (tabel(ts, ['deel (model)', 'einde looptijd']) || []).forEach(function (r) {
    const m = /hypo\s*(\d)/i.exec(r['deel (model)']);
    if (m) einde['Hypo' + m[1]] = schoon(r['einde looptijd'], 30) || null;
  });
  const bankDatum = datumIso((/(\d{1,2}-\d{1,2}-\d{4})/.exec(String(j.bron_bank || '')) || [])[1]) || bron.datum;
  const ruw = Array.isArray(j.leningdelen) ? j.leningdelen : [];
  const xv = datumVeld(ruw[0], 'excel_restschuld_'), excelOp = xv ? xv.datum : null;   // de Excel-stand waarmee vergeleken wordt
  const delen = ruw.slice(0, 20).map(function (d) {
    const label = schoon(d.excel_label, 60), model = /^Hypo\d$/.test(String(d.excel_deel)) ? d.excel_deel : null;
    const bank = getal(d.bank_restschuld), x10 = xv ? getal(d[xv.sleutel]) : null;
    return {
      deel: /^\d{1,4}$/.test(String(d.bank_leningdeel)) ? String(d.bank_leningdeel) : null,
      model: model, doel: schoon(label.replace(/^Hypo\d\s*-\s*/i, ''), 40) || null, soort: schoon(d.bank_soort, 20) || null,
      hoofdsom: getal(d.excel_hoofdsom), start: datumIso(d.excel_startmaand), rente_bank: getal(d.bank_rente_pct), rente_excel: getal(eersteVeld(d, /^excel_rente_pct/)),
      rentevast_tm: datumIso(d.rentevast_tm_excel_groen), einde: model ? einde[model] || null : null,
      aflossing_mnd: getal(d.excel_aflossing_mnd), rente_mnd_excel: getal(d.excel_rente_mnd),
      restschuld_bank: bank, restschuld_excel: x10, verschil: bank != null && x10 != null ? getal(bank - x10) : null,
      excel_gelijk_op: datumIso(d.beste_match), verschil_gelijk: getal(d.verschil_bij_beste_match),
    };
  });
  const rv = delen.filter(function (d) { return d.rentevast_tm; }).sort(function (a, b) { return a.rentevast_tm < b.rentevast_tm ? -1 : 1; })[0];
  const ctrl = j.controle_maandlast || {}, tk = eersteVeld(j, /^excel_totaalkolom/) || {}, som = datumVeld(j, 'excel_som_delen_');
  // verloop: de Excel-reeks TOTAAL op 1 januari per jaar (Davids eigen model, met de toekomst als schema)
  const tot = j.volledige_excel_reeksen && j.volledige_excel_reeksen.TOTAAL && Array.isArray(j.volledige_excel_reeksen.TOTAAL.rows) ? j.volledige_excel_reeksen.TOTAAL.rows : [];
  const verloop = tot.filter(function (r) { return r && /^\d{4}-01-01$/.test(String(r.datum)) && getal(r.restschuld) != null; })
    .map(function (r) { return { jaar: Number(String(r.datum).slice(0, 4)), restschuld: Math.round(r.restschuld) }; }).slice(0, 60);
  // ORV-polissen (pagina): verzekeraar, kapitaal, looptijd, premie, status; geen polisnummer
  const orv = (tabel(ts, ['verzekeraar', 'kapitaal start', 'einde polis', 'status']) || []).slice(0, 10).map(function (r) {
    return { verzekeraar: schoon(r.verzekeraar, 40) || null, verzekerde_nemer: schoon(r.nemer, 20) || null, kapitaal_start: nlGetal(r['kapitaal start']),
      ingang: datumIso(r.ingang), einde: datumIso(r['einde polis']), premie_mnd: nlGetal(r.premie), status: schoon(r.status, 60) || null };
  });
  return {
    bron: { pagina: P_HYPO, data: bron.rel, bank: 'ABN AMRO-app (schermafdruk ' + (bankDatum ? bankDatum.split('-').reverse().map(Number).join('-') : '?') + ')', bank_op: bankDatum,
      excel: 'je eigen Excel "Hypotheek - Totaal"', excel_op: excelOp, rentevast: 'je Excel (groen gemarkeerd); de schermafdruk van de bank toont geen rentevaste data',
      pagina_bijgewerkt: pg.fm.updated || null },
    bank: { restschuld: getal(j.bank_totaal_restschuld), oorspronkelijk: getal(j.bank_oorspronkelijk), afgelost: getal(j.bank_afgelost), maandbetaling: getal(j.bank_maandbetaling) },
    excel: { restschuld: som ? getal(j[som.sleutel]) : null, restschuld_op: som ? som.datum : null, maandlast_totaalkolom: getal(tk.bruto_last), aflossing_som_delen: getal(tk.som_delen_aflossing) },
    controle: { aflossing: getal(ctrl.aflossing_som_delen), rente_bankstand: getal(ctrl.rente_bij_bankstand_en_bankrente), totaal: getal(ctrl.totaal), bank_maandbetaling: getal(ctrl.bank_maandbetaling) },
    delen: delen,
    eerste_renteherziening: rv ? { datum: rv.rentevast_tm, deel: rv.deel, doel: rv.doel, restschuld: rv.restschuld_bank, rente: rv.rente_bank } : null,
    bevindingen: (Array.isArray(j.bevindingen) ? j.bevindingen : []).slice(0, 12).map(function (b) { return schoon(b, 300); }),
    verloop: verloop,
    orv: orv,
  };
}

// woninglening van de Holding: contract en jaarrekeningstanden uit de DGA-json (ook getoond onder Hypotheek: hoort bij de eigenwoningschuld)
function woninglening(j) {
  const c = j && j.contracten && j.contracten.woninglening || {}, s = j && j.woninglening_verloop && j.woninglening_verloop.samenvatting || {};
  const jr = s.jaarrekening && typeof s.jaarrekening === 'object' ? s.jaarrekening : {};
  return {
    hoofdsom: getal(c.hoofdsom), ingang: datumIso(c.ingangsdatum), rente_pct: getal(c.rente_pct), termijn: getal(c.termijn),
    eerste_termijn: datumIso(c.eerste_termijn), laatste_termijn: datumIso(c.laatste_termijn), doel: c.doel ? 'verbouwing zolder en badkamer' : null,
    jaarrekening: Object.keys(jr).filter(function (k) { return /^\d{4}$/.test(k); }).sort().map(function (k) { return { jaar: Number(k), stand: getal(jr[k]) }; }),
  };
}

// ── Belasting ──
function belasting(vault) {
  const pg = pagina(vault, P_BEL), ts = tabellen(pg.tekst);
  const dav = tabel(ts, ['jaar', 'datum aangifte', 'box 1', 'box 2', 'verschuldigd ib/pvv', 'saldo']);
  const cyn = tabel(ts, ['jaar', 'stuk (datum)', 'box 1', 'box 2', 'uitkomst']);
  const won = tabel(ts, ['jaar', 'woz-waarde', 'eigenwoningschuld 31-12']);
  if (!dav && !cyn) throw new Error('aangiftetabellen niet gevonden');
  const jaar = function (r) { const n = nlGetal(r.jaar); return n && n > 2000 && n < 2100 ? n : null; };
  const david = (dav || []).map(function (r) {
    return { jaar: jaar(r), datum: datumIso(r['datum aangifte']), concept: /concept/i.test(r['datum aangifte']), loon: nlGetal(r.loon), winst: nlGetal(r['belastbare winst']),
      box1: nlGetal(r['box 1']), box2: nlGetal(r['box 2']), verschuldigd: nlGetal(r['verschuldigd ib/pvv']),
      saldo: nlGetal(r.saldo), toelichting: /\(/.test(r.saldo) ? schoon(r.saldo, 60) : null };
  }).filter(function (r) { return r.jaar; });
  const cynthia = (cyn || []).map(function (r) {
    const u = schoon(r.uitkomst), b = nlGetal(u);
    return { jaar: jaar(r), datum: datumIso(r['stuk (datum)']), concept: /concept/i.test(r['stuk (datum)']), box1: nlGetal(r['box 1']), box2: nlGetal(r['box 2']),
      uitkomst: b == null ? null : /^terug/i.test(u) ? -Math.abs(b) : /^bij/i.test(u) ? Math.abs(b) : null };
  }).filter(function (r) { return r.jaar; });
  const woning = (won || []).map(function (r) {
    // wat tussen haakjes staat ("(vanaf 07-09)", "(na bouwdepot)") hoort bij het getal: als noot mee
    const noot = [['woz-waarde', 'WOZ'], ['aftrekbare rente', 'rente'], ['eigenwoningschuld 31-12', 'schuld']]
      .map(function (k) { const m = /\(([^)]{1,60})\)/.exec(schoon(r[k[0]])); return m ? k[1] + ': ' + m[1] : null; }).filter(Boolean).join('; ');
    return { jaar: jaar(r), woz: nlGetal(r['woz-waarde']), forfait: nlGetal(r.eigenwoningforfait), rente: nlGetal(r['aftrekbare rente']),
      schuld: nlGetal(r['eigenwoningschuld 31-12']), box3: nlGetal(r['box 3 grondslag (samen)']), noot: noot || null };
  }).filter(function (r) { return r.jaar; });
  return { bron: { pagina: P_BEL, pagina_bijgewerkt: pg.fm.updated || null, stukken: 'afschriften van de aangiftes (2011-2014 concepten)' }, david: david, cynthia: cynthia, woning: woning };
}

// ── Holding (DGA): rekening-courant, woninglening, planning, dividend ──
function dga(vault) {
  const pg = pagina(vault, P_DGA), ts = tabellen(pg.tekst);
  const bron = nieuwste(vault, D_DGA, RE_DGA);
  let j = null;
  if (bron) j = leesJson(vault, bron.rel);
  const planning = (tabel(ts, ['wanneer', 'actie', 'wie', 'status']) || []).slice(0, 30).map(function (r) {
    const st = schoon(r.status, 60);
    // alleen een status die ermee begint ("uitgevoerd 26-10"); "niet uitgevoerd", "deels betaald" en "onbetaald" zijn niet klaar
    return { wanneer: schoon(r.wanneer, 30), actie: schoon(r.actie, 240), wie: schoon(r.wie, 40), status: st, klaar: /^(uitgevoerd|gedaan|afgerond|betaald|klaar)\b/i.test(st) };
  });
  const rcRijen = tabel(ts, ['post', 'bedrag']) || [];
  const rcAlle = rcRijen.map(function (r) { return { post: schoon(r.post, 120), bedrag: nlGetal(r.bedrag) }; }).filter(function (r) { return r.post; });
  const totaal = rcAlle.find(function (r) { return /^totaal/i.test(r.post); });
  // De tabel noemt ook de woninglening (staat los van de RC; zie woninglening). Alleen weglaten als de rest precies optelt tot het totaal;
  // anders de tabel zoals hij op de pagina staat.
  const zonderWl = rcAlle.filter(function (r) { return r !== totaal && !/^woninglening/i.test(r.post); });
  const som = Math.round(zonderWl.reduce(function (a, r) { return a + (r.bedrag || 0); }, 0) * 100) / 100;
  const telt = totaal && totaal.bedrag != null && Math.abs(som - totaal.bedrag) < 0.005;
  const rc = telt ? zonderWl : rcAlle.filter(function (r) { return r !== totaal; });
  const c = j && j.contracten && j.contracten.rekening_courant || {};
  const sv = datumVeld(j, 'stand_'), st = sv && j[sv.sleutel] && j[sv.sleutel].rc_dga || null;
  return {
    bron: { pagina: P_DGA, data: bron ? bron.rel : null, besluit: schoon(pg.fm.status, 120) || null, pagina_bijgewerkt: pg.fm.updated || null,
      rc_stand: 'standen van de boekhouder (besluitpagina)', data_status: j && j.meta && j.meta.status ? schoon(j.meta.status, 20) : null },
    rc: { posten: rc, totaal: totaal ? totaal.bedrag : null, telt_op: !!telt,
      // de reconstructie is alleen de RC bij de Holding (rc_dga); het totaal van de boekhouder telt ook de RC bij Tolgaarde mee
      reconstructie: st && getal(st.bedrag) != null ? { bedrag: getal(st.bedrag), basis: schoon(st.basis, 160), op: sv.datum, alleen: 'Holding' } : null },
    rc_contract: j ? { maximum: getal(c.maximum), rente_pct: getal(c.rente_pct), rentevrij_onder: /17\.?500/.test(String(c.rentegrondslag || '')) ? 17500 : null,
      aflossing: schoon(c.aflossing, 80) || null, getekend: datumIso(c.getekend) } : null,
    woninglening: j ? woninglening(j) : null,
    planning: planning,
    dividend: (j && Array.isArray(j.dividend) ? j.dividend : []).slice(0, 20).map(function (d) {
      return { datum: datumIso(d.datum), bruto: getal(d.bruto), dividendbelasting: getal(d.dividendbelasting_15pct), netto_betaald: getal(d.netto_betaald), verschil: getal(d.verschil) };
    }),
    bevestigen: opsomming(pg.tekst, 'Ter bevestiging door Acta Synergia') || [],
  };
}

// Alle drie; een kapot blok wordt null en komt in fouten
function lees(vault) {
  const uit = { hypotheek: null, belasting: null, dga: null, fouten: [] };
  [['hypotheek', hypotheek], ['belasting', belasting], ['dga', dga]].forEach(function (b) {
    try { uit[b[0]] = b[1](vault); } catch (e) { uit.fouten.push(b[0]); }
  });
  // woninglening Holding ook onder Hypotheek (hoort bij de eigenwoningschuld); uit het Holding-blok, dus dezelfde bron
  if (uit.hypotheek) uit.hypotheek.holding = uit.dga && uit.dga.woninglening ? Object.assign({ bron: uit.dga.bron.data }, uit.dga.woninglening) : null;
  return uit;
}

module.exports = { lees: lees, schoon: schoon, nlGetal: nlGetal, tabellen: tabellen, tabel: tabel, datumIso: datumIso, P_HYPO: P_HYPO, P_BEL: P_BEL, P_DGA: P_DGA };
