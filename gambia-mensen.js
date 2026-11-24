'use strict';
/*
 * gambia-mensen.js — Apps › Gambia: je mensen op één scherm, met een reisbriefing twee weken voor vertrek.
 * wv3950 (besluitenpagina nr 502 = 3C202, David Ja 22-11-2026 18:23): "Wil je een scherm Gambia in je Apps met per persoon het laatste
 * contact, de steun en wat openstaat, plus een briefing vóór een reis?" → JA. Ontwerp: mk-scripts/wv3950/ontwerp.md (Codex GO-MET-WIJZIGINGEN).
 *
 * WAAROM. De kennis over wie David hoopt te zien en wat hij beloofde haalde hij vlak voor vertrek uit zijn hoofd en uit maanden chat; er waren
 * dossiers maar geen scherm.
 *
 * BRONNEN (alleen lezen, via vault-veilig: geen symlink volgen):
 *   - personen: 20_Prive/Gambia/Personen/<Naam>.md met type persoon en gambia_contact: ja (status, rol uit de frontmatter);
 *   - laatste contact: de berichtregels "**[d-m-jjjj hh:mm] Naam:**" in de WhatsApp-dumps: Gambiaans nummer (30_Conversaties/WhatsApp-Gambia,
 *     ook submappen) en NL-nummer (30_Conversaties/WhatsApp/Verwerkt/<maand>/ met entiteit Prive/Gambia of een +220-chat). "David" = jij.
 *   - steun en toezeggingen: het steunbord (gambia-steunbord.js via de bank-lezer; komt van server.js binnen, hier niets gerekend);
 *   - reizen: Tripper (reizen.js lijst; komt van server.js binnen).
 * KOPPELING dump ↔ persoon (port van .claude/skills/gambia-weekreview/nummers.py, wv3949): alleen een individueel +220-nummer (@c.us,
 *   220 + 7 cijfers; Codex MOET 1); laatste zeven cijfers tegen de Telefoon-kolom van Local Support Network en tegen dossierregels met een
 *   telefoonwoord. Precies één dossier = toegewezen; meer of alleen genoemd = twijfel, nooit stil toewijzen (komt onder "Nummers zonder naam").
 *   Groepen (@g.us) en niet-Gambiaanse nummers tellen niet als persoonscontact.
 * PRIVACY. Strikt privé, alleen voor Davids eigen app; deze module logt niets en praat met geen taalmodel.
 */
const fs = require('fs');
const path = require('path');

let veiligObj = null;
function veilig() { if (!veiligObj) veiligObj = require(path.join(__dirname, 'vault-veilig.js')); return veiligObj; }

const VERSIE = 1;
const PERS = path.join('20_Prive', 'Gambia', 'Personen');
const LSN = path.join('20_Prive', 'Gambia', 'Local Support Network.md');
const GM_MAP = path.join('30_Conversaties', 'WhatsApp-Gambia');
const NL_MAP = path.join('30_Conversaties', 'WhatsApp', 'Verwerkt');
const OVERSLAAN = /verbonden pagina|^david schaap$/i;
const MAX_DOSSIER = 400000, MAX_DUMP = 600000, MAX_SPEELT = 240;
const BRIEFING_DAGEN = 14;
const TEL_WOORD = /telefoon|nummer|tel\b|whatsapp|📞|\bnr\b|bereikbaar/i;
const NIET_EIGEN = /rector|school|winkel|bank|kliniek|dokter|van (zijn|haar) (zus|broer|vrouw|man)/i;
const NUMMER_RE = /(?<!\d)(?:\+?220[\s-]?)?(\d{3})[\s-]?(\d{4})(?!\d)/g;
const BERICHT_RE = /^\*\*\[(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{2})\] ([^*\n]{1,80}?):\*\*/;
const MND = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mrt: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dec: 12 };

function lees(p, max) { try { return veilig().lees(p, 'utf8', { max: max || MAX_DOSSIER }); } catch (e) { return null; } }
function lijstMap(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return []; } }
function frontmatter(t) { const m = /^---\n([\s\S]*?)\n---/.exec(t || ''); return m ? m[1] : ''; }
function zonderFm(t) { const m = /^---\n[\s\S]*?\n---\n?/.exec(t || ''); return m ? t.slice(m[0].length) : String(t || ''); }
function fmVeld(fm, veld) {
  const m = new RegExp('^' + veld + ':[ \\t]*(.*)$', 'm').exec(fm || '');
  return m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : null;
}
function isoDag(j, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && j >= 2000 && j <= 2100)) return null;
  const t = new Date(Date.UTC(j, m - 1, d));
  return t.getUTCMonth() === m - 1 ? t.toISOString().slice(0, 10) : null;
}
function dagVerschil(a, b) { return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }
function plat(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// ── nummers ──
// Individueel Gambiaans nummer uit een chat_id/group_id ("2207223769@c.us") → { nummer: '2207223769', zeven: '7223769' } of null
function gmNummer(id) {
  const s = String(id || '').trim().replace(/^"|"$/g, '');
  const m = /^(220\d{7})@c\.us$/.exec(s);
  return m ? { nummer: m[1], zeven: m[1].slice(3) } : null;
}
function nummersIn(tekst) {
  const uit = new Set(); let m; NUMMER_RE.lastIndex = 0;
  while ((m = NUMMER_RE.exec(String(tekst || '')))) uit.add(m[1] + m[2]);
  return uit;
}
function lsnEigen(tekst) {
  const uit = {};
  String(tekst || '').split('\n').forEach(function (r) {
    const m = /^\|\s*\[\[20_Prive\/Gambia\/Personen\/([^|\]\\]+)/.exec(r);
    if (!m) return;
    const cellen = r.split(/(?<!\\)\|/);   // een wikilink met alias staat in de tabel als [[…\|naam]]: die pijp is geen kolomgrens
    if (cellen.length > 3) nummersIn(cellen[3]).forEach(function (z) { (uit[z] = uit[z] || new Set()).add(m[1].trim()); });
  });
  return uit;
}
// nummers.py zoek(): { oordeel: bekend|twijfel|nieuw, eigen: [naam], genoemd: [naam] }
function koppel(zeven, teksten, lsn) {
  const eigen = new Set(lsn[zeven] ? Array.from(lsn[zeven]) : []), genoemd = new Set();
  const d = zeven.split('');
  const pat = new RegExp('(?<!\\d)(?:\\+?220[\\s-]?)?' + d.slice(0, 3).join('[\\s-]?') + '[\\s-]?' + d.slice(3).join('[\\s-]?') + '(?!\\d)');
  Object.keys(teksten).forEach(function (naam) {
    String(teksten[naam] || '').split('\n').forEach(function (r) {
      if (!pat.test(r)) return;
      if (TEL_WOORD.test(r) && !NIET_EIGEN.test(r)) eigen.add(naam); else genoemd.add(naam);
    });
  });
  eigen.forEach(function (n) { genoemd.delete(n); });
  const e = Array.from(eigen).sort(), g = Array.from(genoemd).sort();
  return { oordeel: e.length === 1 ? 'bekend' : (e.length || g.length) ? 'twijfel' : 'nieuw', eigen: e, genoemd: g };
}

// ── dossiers ──
// "wat speelt": de jongste kop (## of ###) met een datum, met de eerste tekstregel eronder. Datum uit de kop: 2026-11-20, 20-11-2026,
// "20 november 2026", "Stand 16 september 2026". Zonder jaar in de kop telt het jaar van updated (of geen datum).
function kopDatum(kop, jaar) {
  let m = /\b(20\d\d)-(\d\d)-(\d\d)\b/.exec(kop);
  if (m) return isoDag(+m[1], +m[2], +m[3]);
  m = /(?<![\d-])(\d{1,2})-(\d{1,2})-(20\d\d)(?![\d-])/.exec(kop);
  if (m) return isoDag(+m[3], +m[2], +m[1]);
  m = /\b(\d{1,2})(?:\s?[–-]\s?(\d{1,2}))?\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|jan|feb|mrt|apr|jun|jul|aug|sept|sep|okt|nov|dec)\b\.?(?:\s+(20\d\d))?/i.exec(kop);
  if (m) { const j = m[4] ? +m[4] : jaar; return j ? isoDag(j, MND[m[3].toLowerCase()], +(m[2] || m[1])) : null; }
  m = /\b(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(20\d\d)\b/i.exec(kop);
  if (m) return isoDag(+m[2], MND[m[1].toLowerCase()], 1);
  return null;
}
function watSpeelt(tekst, jaar) {
  const regels = zonderFm(tekst).split('\n');
  let best = null;
  for (let i = 0; i < regels.length; i++) {
    const k = /^#{2,3}[ \t]+(.+?)\s*$/.exec(regels[i]);
    if (!k) continue;
    const d = kopDatum(k[1], jaar);
    if (!d || (best && d <= best.datum)) continue;
    let regel = '';
    for (let j = i + 1; j < regels.length && j < i + 12; j++) {
      const r = regels[j].trim();
      if (/^#{1,6}\s/.test(r)) break;
      if (!r || /^(\||---|<!--)/.test(r)) continue;
      regel = r.replace(/^[-*>]\s+/, '').replace(/\*\*/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1');
      break;
    }
    if (regel.length > MAX_SPEELT) regel = regel.slice(0, MAX_SPEELT - 1).replace(/\s+\S*$/, '') + '…';
    best = { datum: d, kop: k[1].replace(/\*\*/g, '').slice(0, 120), regel: regel };
  }
  return best;
}
function leesPersonen(vault) {
  const dir = path.join(vault, PERS), uit = [], teksten = {}, fouten = [];
  lijstMap(dir).filter(function (e) { return e.isFile() && /\.md$/.test(e.name); }).map(function (e) { return e.name; }).sort().forEach(function (f) {
    const naam = f.replace(/\.md$/, '');
    if (OVERSLAAN.test(naam)) return;
    const t = lees(path.join(dir, f), MAX_DOSSIER);
    if (t == null) { fouten.push('dossier niet te lezen'); return; }
    teksten[naam] = t;
    const fm = frontmatter(t);
    if ((fmVeld(fm, 'type') || '') !== 'persoon' || !/^ja$/i.test(fmVeld(fm, 'gambia_contact') || '')) return;
    const status = (fmVeld(fm, 'status') || '').slice(0, 120);
    const upd = fmVeld(fm, 'updated') || '';
    const jaar = /^(20\d\d)/.test(upd) ? +upd.slice(0, 4) : null;
    uit.push({ naam: naam, pad: path.join(PERS, f).split(path.sep).join('/'), status: status || null, rol: (fmVeld(fm, 'rol') || '').slice(0, 80) || null,
      gestopt: /beëindigd|beeindigd|vervallen|gestopt/i.test(status), bijgewerkt: /^\d{4}-\d{2}-\d{2}$/.test(upd) ? upd : null, speelt: watSpeelt(t, jaar) });
  });
  return { personen: uit, teksten: teksten, fouten: fouten };
}

// ── dumps ──
function dumpBestanden(vault) {
  const uit = [];
  const gm = path.join(vault, GM_MAP);
  lijstMap(gm).forEach(function (e) {
    if (e.isFile() && /\.md$/.test(e.name)) uit.push({ kant: 'GM', pad: path.join(gm, e.name) });
    else if (e.isDirectory() && e.name !== 'Media' && !e.name.startsWith('.')) {
      lijstMap(path.join(gm, e.name)).forEach(function (x) { if (x.isFile() && /\.md$/.test(x.name)) uit.push({ kant: 'GM', pad: path.join(gm, e.name, x.name) }); });
    }
  });
  const nl = path.join(vault, NL_MAP);
  lijstMap(nl).forEach(function (e) {
    if (!e.isDirectory() || e.name.startsWith('.')) return;
    lijstMap(path.join(nl, e.name)).forEach(function (x) { if (x.isFile() && /\.md$/.test(x.name)) uit.push({ kant: 'NL', pad: path.join(nl, e.name, x.name) }); });
  });
  return uit;
}
// Eén dump → { nummer, zeven, groep, laatst: { alles, jij, zij }, berichten } (tijden als 'JJJJ-MM-DD hh:mm'); null = niet van Gambia
// Uitkomst per bestand bewaard op (grootte, mtime): de ± 450 NL-dumps worden zo alleen de eerste keer (en na een wijziging) gelezen.
const dumpCache = new Map();
function leesDump(b) {
  let st = null;
  try { st = fs.lstatSync(b.pad); } catch (e) { return { fout: true }; }
  const sleutel = st.size + ':' + st.mtimeMs, oud = dumpCache.get(b.pad);
  if (oud && oud.sleutel === sleutel) return oud.uit;
  const uit = leesDumpVers(b);
  if (!uit || !uit.fout) { if (dumpCache.size > 5000) dumpCache.clear(); dumpCache.set(b.pad, { sleutel: sleutel, uit: uit }); }
  return uit;
}
function leesDumpVers(b) {
  const t = lees(b.pad, MAX_DUMP);
  if (t == null) return { fout: true };
  const fm = frontmatter(t);
  const id = fmVeld(fm, 'chat_id') || fmVeld(fm, 'group_id') || '';
  if (b.kant === 'NL' && !/^Prive\/Gambia$/.test(fmVeld(fm, 'entiteit') || '') && !/^220\d{7}@c\.us$/.test(id)) return null;
  const n = gmNummer(id);
  const laatst = { alles: null, jij: null, zij: null };
  let berichten = 0;
  zonderFm(t).split('\n').forEach(function (r) {
    const m = BERICHT_RE.exec(r);
    if (!m) return;
    const d = isoDag(+m[3], +m[2], +m[1]);
    if (!d) return;
    const tijd = d + ' ' + ('0' + m[4]).slice(-2) + ':' + m[5];
    berichten++;
    const wie = /^david$/i.test(m[6].trim()) ? 'jij' : 'zij';
    if (!laatst.alles || tijd > laatst.alles) laatst.alles = tijd;
    if (!laatst[wie] || tijd > laatst[wie]) laatst[wie] = tijd;
  });
  return { kant: b.kant, nummer: n ? n.nummer : null, zeven: n ? n.zeven : null, groep: /@g\.us$/.test(id), laatst: laatst, berichten: berichten,
    contact: (fmVeld(fm, 'contact') || fmVeld(fm, 'groep') || '').slice(0, 80) };
}
function later(a, b) { return !a ? b : !b ? a : (b > a ? b : a); }
function voegLaatst(doel, l) { ['alles', 'jij', 'zij'].forEach(function (k) { doel[k] = later(doel[k], l[k]); }); }

// ── alles samen ──
// inv = { vault, steunbord?: {personen:[…]} | null, steunbord_fout?: bool, reizen?: [reis uit tripper.lijst] | null, reis_tekst?(id) → tekst|null,
//         vandaag: 'JJJJ-MM-DD' }
function bereken(inv) {
  const vault = inv.vault, vandaag = inv.vandaag;
  const P = leesPersonen(vault);
  const lsn = lsnEigen(lees(path.join(vault, LSN), MAX_DOSSIER) || '');
  const perNaam = {};
  P.personen.forEach(function (p) { perNaam[p.naam] = { GM: { alles: null, jij: null, zij: null, nummers: new Set() }, NL: { alles: null, jij: null, zij: null, nummers: new Set() } }; });
  const zonder = {};   // nummer → { nummer, laatst, kandidaten, oordeel }
  const koppelCache = {};
  let dumps = 0, dumpFout = 0;
  dumpBestanden(vault).forEach(function (b) {
    const d = leesDump(b);
    if (d === null) return;
    if (d.fout) { dumpFout++; return; }
    dumps++;
    if (!d.zeven || d.groep || !d.laatst.alles) return;   // Codex MOET 1: alleen een individueel +220-nummer telt
    const k = koppelCache[d.zeven] || (koppelCache[d.zeven] = koppel(d.zeven, P.teksten, lsn));
    if (k.oordeel === 'bekend' && perNaam[k.eigen[0]]) {
      const x = perNaam[k.eigen[0]][d.kant];
      voegLaatst(x, d.laatst); x.nummers.add(d.nummer);
      return;
    }
    const z = zonder[d.nummer] || (zonder[d.nummer] = { nummer: '+220 ' + d.nummer.slice(3, 6) + ' ' + d.nummer.slice(6), laatst: null, kanten: [],
      kandidaten: k.eigen.concat(k.genoemd).filter(function (n) { return perNaam[n]; }), oordeel: k.oordeel === 'bekend' ? 'twijfel' : k.oordeel });
    z.laatst = later(z.laatst, d.laatst.alles);
    if (z.kanten.indexOf(d.kant) < 0) z.kanten.push(d.kant);
  });
  // steunbord per naam
  const sb = {};
  ((inv.steunbord && inv.steunbord.personen) || []).forEach(function (p) { sb[p.naam] = p; });
  const steunOk = !!(inv.steunbord && Array.isArray(inv.steunbord.personen));
  const kaarten = P.personen.map(function (p) {
    const c = perNaam[p.naam];
    const contact = {};
    ['GM', 'NL'].forEach(function (k) { contact[k] = c[k].alles ? { laatst: c[k].alles, jij: c[k].jij, zij: c[k].zij, nummers: c[k].nummers.size } : null; });
    const laatst = later(contact.GM && contact.GM.laatst, contact.NL && contact.NL.laatst);
    const s = sb[p.naam] || null;
    const steun = !steunOk ? null : {
      som: s ? s.som : {},   // per valuta { zeker, waarschijnlijk }; nooit opgeteld over valuta's
      betalingen: s ? s.betaald.length : 0,
      open: s ? s.toezeggingen.filter(function (t) { return t.stand === 'open' || t.stand === 'doorlopend'; }).map(function (t) { return { datum: t.datum, wat: t.wat, bedrag_tekst: t.bedrag_tekst || null, citaat: t.citaat || null, stand: t.stand }; }) : [],
      niet_zeker: s ? s.toezeggingen.filter(function (t) { return t.stand === 'mogelijk betaald' || t.stand === 'betaald volgens dossier'; }).map(function (t) { return { datum: t.datum, wat: t.wat, stand: t.stand }; }) : [],
    };
    return { naam: p.naam, pad: p.pad, status: p.status, rol: p.rol, gestopt: p.gestopt, speelt: p.speelt, contact: contact, laatst: laatst,
      dagen_stil: laatst ? dagVerschil(vandaag, laatst.slice(0, 10)) : null, steun: steun };
  }).sort(function (a, b) {
    if (a.gestopt !== b.gestopt) return a.gestopt ? 1 : -1;
    const oa = a.steun ? a.steun.open.length : 0, ob = b.steun ? b.steun.open.length : 0;
    if (!!oa !== !!ob) return oa ? -1 : 1;
    if ((a.laatst || '') !== (b.laatst || '')) return (a.laatst || '') < (b.laatst || '') ? 1 : -1;
    return a.naam < b.naam ? -1 : 1;
  });
  return { versie: VERSIE, vandaag: vandaag, personen: kaarten, zonder_naam: Object.keys(zonder).sort().map(function (k) { return zonder[k]; })
    .sort(function (a, b) { return (a.laatst || '') < (b.laatst || '') ? 1 : -1; }),
    reis: reisBriefing(kaarten, inv.reizen, inv.reis_tekst, vandaag, steunOk),
    bron: { dumps: dumps, dumps_onleesbaar: dumpFout, dossiers: P.personen.length, dossiers_onleesbaar: P.fouten.length, steunbord: steunOk ? 'ok' : (inv.steunbord_fout ? 'fout' : 'niet'),
      reizen: Array.isArray(inv.reizen) ? 'ok' : 'fout', nl_sinds: '2026-11-21' } };
}

// ── reisbriefing ──
// De eerstvolgende komende Gambiareis (soort gambia, stand gepland of nu). Briefing vanaf 14 dagen vóór vertrek (en tijdens de reis).
function volgendeReis(reizen) {
  return (Array.isArray(reizen) ? reizen : []).filter(function (r) { return r && r.soort === 'gambia' && (r.stand === 'gepland' || r.stand === 'nu') && r.van; })
    .sort(function (a, b) { return a.van < b.van ? -1 : 1; })[0] || null;
}
function noemtNaam(tekst, naam) {
  const t = plat(tekst);
  if (!t) return false;
  const delen = plat(naam).split(' ').filter(function (w) { return w.length >= 3; });
  if (t.indexOf(plat(naam)) >= 0) return true;
  // voornaam + achternaam los (ook "Kemo" alleen als die voornaam uniek genoeg is: minstens 4 letters en niet "lamin")
  return delen.length >= 2 && delen.every(function (w) { return new RegExp('\\b' + w + '\\b').test(t); });
}
function reisBriefing(kaarten, reizen, reisTekst, vandaag, steunOk) {
  if (!Array.isArray(reizen)) return null;
  const r = volgendeReis(reizen);
  if (!r) return { reis: null };
  const over = dagVerschil(r.van, vandaag);
  const basis = { id: r.id, titel: r.titel, van: r.van, tot: r.tot, over_dagen: over, briefing_vanaf: plusDagen(r.van, -BRIEFING_DAGEN) };
  if (over > BRIEFING_DAGEN) return { reis: basis, briefing: null };
  let tekst = '';
  if (typeof reisTekst === 'function') { try { tekst = reisTekst(r.id) || ''; } catch (e) { tekst = ''; } }
  const deelnemers = (r.deelnemers || []).map(plat);
  const mensen = kaarten.filter(function (k) { return !k.gestopt; }).map(function (k) {
    const inPlan = noemtNaam(tekst, k.naam) || deelnemers.indexOf(plat(k.naam)) >= 0;
    return { naam: k.naam, pad: k.pad, in_plan: inPlan, laatst: k.laatst, dagen_stil: k.dagen_stil, speelt: k.speelt,
      beloofd: k.steun ? k.steun.open : null, niet_zeker: k.steun ? k.steun.niet_zeker : null };
  }).sort(function (a, b) { return (a.in_plan !== b.in_plan) ? (a.in_plan ? -1 : 1) : ((b.beloofd ? b.beloofd.length : 0) - (a.beloofd ? a.beloofd.length : 0)) || ((a.laatst || '') < (b.laatst || '') ? 1 : -1); });
  const beloofd = steunOk ? mensen.reduce(function (s, m) { return s + (m.beloofd ? m.beloofd.length : 0); }, 0) : null;
  return { reis: basis, briefing: { mensen: mensen, beloofd: beloofd, steun_bekend: steunOk } };
}
function plusDagen(d, n) { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }

// Ochtendregel twee weken vóór vertrek (uurtik gambia-reis in server.js; het loket zet "Gambia: " ervoor). sleutel = reis-id + vertrekdatum (Codex MOET 2: een verschoven reis meldt
// opnieuw één keer). Geeft null als er niets te melden is.
function ochtendRegel(b, gemeld) {
  const x = b && b.reis;
  if (!x || !x.reis || !x.briefing) return null;
  const r = x.reis;
  if (r.over_dagen < 0) return null;
  const sleutel = r.id + ':' + r.van;
  if (gemeld && gemeld[sleutel]) return null;
  const n = x.briefing.mensen.length;
  const wanneer = r.over_dagen === 0 ? 'Vandaag vertrek' : r.over_dagen === 1 ? 'Morgen vertrek' : 'Over ' + r.over_dagen + ' dagen vertrek';
  const delen = [n + (n === 1 ? ' persoon' : ' mensen')];
  if (x.briefing.beloofd != null) delen.push(x.briefing.beloofd + (x.briefing.beloofd === 1 ? ' open toezegging' : ' open toezeggingen'));
  return { sleutel: sleutel, onderwerp: 'reis-' + r.id + '-' + r.van.replace(/-/g, ''),
    tekst: wanneer + ' (' + r.titel + '). Je briefing staat klaar: ' + delen.join(', ') + '.' };
}

module.exports = { bereken, ochtendRegel, leesPersonen, leesDump, koppel, lsnEigen, gmNummer, watSpeelt, kopDatum, volgendeReis, noemtNaam, BRIEFING_DAGEN, VERSIE };
