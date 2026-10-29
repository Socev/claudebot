#!/usr/bin/env bash
# Toetst intake-publicatie.js (wv1869, SB2 fase 3b: publicatieservice) met een nep-Supabase die de regels van migratie 0012 nadoet
# (publicatie_zet, outbox_gevonden/_klaar, published bij klaar, poort op doel_pad) en een wegwerpvault met het echte vault-veilig.
# Toetst: schakelaar/pauze, bronnotitie (frontmatter, blok, origineel terugvinden na verplaatsen en op sha256), alleen de entiteiten in de
# scope, geen quarantaine, register als blok onder het handgeschreven log (log byte-gelijk), idempotent, proef 7 (crash ná de rename →
# volgende ronde afgerond, niet dubbel), proef 8 (handwijziging in notitie of register → blokkeer, niets geschreven, één melding),
# voetblok ná het blok blijft staan, inode/mtime-toets (tussendoor), patiëntmarker zonder onderwerp, neutrale doel_paden; koppeling in
# server.js (nachtketen-stap na de Bibliothecaris, /health) en uitrol.sh.
# Gebruik: bash test/intake-publicatie.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 800) + ']' : '')); }
const P = require('./intake-publicatie.js');
const VVecht = require('./vault-veilig.js');
const { DatabaseSync } = require('node:sqlite');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── nep-Supabase met de regels van 0012 ──
const PAD_RE = { bronnotitie: /^(10_Zakelijk\/(Tolgaarde|Groenhouten|HAGRO|POT_POH_GGZ|Holding|Praktijkhouders_BV|SEL|DBH|GHAWA-ECG)|20_Prive|_INBOX)\/Bronnen\/[0-9]{4}-[0-9]{2}-[0-9]{2}_stk_[0-9]{8}_[0-9a-f]{8}\.md$/,
  bronregister: /^(10_Zakelijk\/(Tolgaarde|Groenhouten|HAGRO|POT_POH_GGZ|Holding|Praktijkhouders_BV|SEL|DBH|GHAWA-ECG)|20_Prive|_INBOX)\/Bronnen\/_register\.md$/ };
function nepSb() {
  const S = { rows: [], besluiten: [], runs: [], occ: [], recs: new Map(), aanroepen: [] };
  const OPEN = ['wacht', 'bezig', 'geblokkeerd_handmatig'];
  function klaar(o) { o.status = 'klaar'; if (o.revision_ids) for (const x of S.occ) if (o.revision_ids.includes(x.revision_id) && x.processing_status === 'registered') x.processing_status = 'published'; }
  const fn = {
    sb2_publicatie_zet({ p }) {
      if (!PAD_RE[p.blok_id] || !PAD_RE[p.blok_id].test(p.doel_pad)) throw new Error('rpc sb2_publicatie_zet http 400');
      const o = S.rows.find((r) => r.doel_pad === p.doel_pad && r.blok_id === p.blok_id && OPEN.includes(r.status));
      const g = p.gevonden_hash == null ? null : p.gevonden_hash;
      if (o) {
        if (o.status === 'geblokkeerd_handmatig') return { geblokkeerd: true, outbox_id: o.outbox_id };
        if (g === o.nieuwe_inhoud_hash) klaar(o);
        else if (g === o.verwachte_vorige_hash) { o.nieuwe_inhoud_hash = p.nieuwe_hash; o.revision_ids = p.revision_ids; return { outbox_id: o.outbox_id, status: o.status, verwachte_vorige_hash: o.verwachte_vorige_hash, nieuwe_inhoud_hash: o.nieuwe_inhoud_hash }; }
        else return { outbox_id: o.outbox_id, status: o.status, verwachte_vorige_hash: o.verwachte_vorige_hash, nieuwe_inhoud_hash: o.nieuwe_inhoud_hash };
      }
      if (g === p.nieuwe_hash) return { niets: true };
      const vorige = S.rows.filter((r) => r.doel_pad === p.doel_pad && r.blok_id === p.blok_id && r.status === 'klaar').pop();
      const r = { outbox_id: S.rows.length + 1, doel_pad: p.doel_pad, blok_id: p.blok_id, verwachte_vorige_hash: vorige ? vorige.nieuwe_inhoud_hash : null, nieuwe_inhoud_hash: p.nieuwe_hash, status: 'wacht', revision_ids: p.revision_ids };
      S.rows.push(r);
      return { outbox_id: r.outbox_id, status: r.status, verwachte_vorige_hash: r.verwachte_vorige_hash, nieuwe_inhoud_hash: r.nieuwe_inhoud_hash, nieuw: true };
    },
    sb2_outbox_gevonden({ p_outbox_id, p_gevonden_hash }) {
      const o = S.rows.find((r) => r.outbox_id === p_outbox_id);
      if (!['wacht', 'bezig'].includes(o.status)) return o.status;
      const g = p_gevonden_hash == null ? null : p_gevonden_hash;
      if (g === o.nieuwe_inhoud_hash) { klaar(o); return 'al_klaar'; }
      if (g === o.verwachte_vorige_hash) { o.status = 'bezig'; return 'schrijf'; }
      S.besluiten.push({ outbox_id: o.outbox_id }); o.status = 'geblokkeerd_handmatig'; return 'blokkeer';
    },
    sb2_outbox_klaar({ p_outbox_id, p_hash }) { const o = S.rows.find((r) => r.outbox_id === p_outbox_id); if (o.nieuwe_inhoud_hash !== p_hash) return 'andere_hash:' + o.status; if (o.status === 'bezig') klaar(o); return o.status; },
    sb2_publicatie_open() { return S.rows.filter((r) => OPEN.includes(r.status)).map((r) => Object.assign({}, r)); },
    sb2_bron_ontvangsten({ p_record_ids }) {
      if (p_record_ids.length > 200) throw new Error('te veel');
      return p_record_ids.filter((id) => S.recs.has(id)).map((id) => Object.assign({ source_record_id: id }, S.recs.get(id), { ontvangsten: S.occ.filter((x) => x.record === id) }));
    },
    sb2_publicatie_run({ p }) { S.runs.push(p); return S.runs.length; },
  };
  S.rpc = async function (naam, body) { S.aanroepen.push(naam); if (!fn[naam]) throw new Error('onbekend ' + naam); return JSON.parse(JSON.stringify(fn[naam](body))); };
  return S;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wv1869-'));
const vault = path.join(tmp, 'vault');
for (const d of ['10_Zakelijk/Tolgaarde/raw_input', '10_Zakelijk/Tolgaarde/Bronnen/Sub', '10_Zakelijk/Holding/raw_input', '10_Zakelijk/Holding/Bronnen', '_INBOX', '30_Conversaties/WhatsApp'])
  fs.mkdirSync(path.join(vault, d), { recursive: true });
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE stuk (stuk_id TEXT PRIMARY KEY, bron TEXT, bron_id TEXT, profiel TEXT, versie INTEGER, status TEXT, access_context TEXT, ontvangen TEXT,
  aangemaakt TEXT, meta TEXT, marker_patient TEXT);
CREATE TABLE onderdeel (stuk_id TEXT, deel TEXT, rol TEXT, naam TEXT, mime TEXT, grootte INTEGER, sha256 TEXT, PRIMARY KEY (stuk_id, deel));
CREATE TABLE overgang (id INTEGER PRIMARY KEY, stuk_id TEXT, deel TEXT, stand TEXT, pad TEXT, geschreven_sha TEXT, uitkomst TEXT, tijd TEXT);
CREATE TABLE uitvoering (id INTEGER PRIMARY KEY, stuk_id TEXT, versie INTEGER, lens TEXT, doel TEXT, pad TEXT, sha256 TEXT, uitkomst TEXT, tijd TEXT, door TEXT);
CREATE TABLE spiegel (stuk_id TEXT PRIMARY KEY, stand TEXT, ps TEXT, ids TEXT, bronnen TEXT);`);
const sb = nepSb();
let recNr = 100, revNr = 500, occNr = 900;
function stuk(id, o) {
  db.prepare('INSERT INTO stuk VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, o.bron || 'gmail:david', 'x' + id, o.profiel || 'mail@1', 1, 'geschreven', o.ac || 'zakelijk_intern',
    o.ontvangen || '2026-10-28T09:15:00Z', o.ontvangen || '2026-10-28T09:15:00Z', JSON.stringify({ onderwerp: o.onderwerp || 'Factuur Onited oktober' }), o.marker || 'geen');
  const ids = [];
  for (const d of o.delen || []) {
    db.prepare('INSERT INTO onderdeel VALUES (?,?,?,?,?,?,?)').run(id, d.deel, d.rol, d.naam, d.mime, d.bytes.length, sha(d.bytes));
    if (d.pad) db.prepare("INSERT INTO overgang (stuk_id, deel, stand, pad, geschreven_sha, uitkomst, tijd) VALUES (?,?,?,?,?,?,?)").run(id, d.deel, o.stand || 'om', d.pad, sha(d.schrijf || d.bytes), 'nieuw', 'x');
    if (d.rol === 'origineel' && /^mail/.test(o.profiel || 'mail@1')) continue;
    const rec = ++recNr, rev = ++revNr;
    sb.recs.set(rec, { origin_system: d.rol === 'bijlage' ? 'bestand' : 'mail', versies: [{ revision_id: rev, sha256: sha(d.bytes), version_label: null, recorded_at: '2026-10-28T09:16:00Z' }] });
    sb.occ.push({ record: rec, occurrence_id: ++occNr, revision_id: rev, intake_route: 'gmail.david', received_at: o.ontvangen || '2026-10-28T09:15:00Z', access_context: o.ac || 'zakelijk_intern', processing_status: o.ps || 'registered', binnen: d.rol === 'bijlage' ? occNr - 1 : null });
    ids.push({ route: 'gmail.david', bijlage: d.rol === 'bijlage', record: rec, revisie: rev, ontvangst: occNr });
  }
  db.prepare('INSERT INTO spiegel VALUES (?,?,?,?,?)').run(id, o.spiegel || 'gespiegeld', o.ps || 'registered', JSON.stringify(ids), '[]');
  return ids;
}
const pdf = Buffer.from('%PDF-1.4 proefpdf ' + 'x'.repeat(300));
const mailA = '---\nonderwerp: Factuur\novis_stuk: stk_20261028_0000000a\novis_profiel: mail@1\n---\nMailtekst A\n';
const mailB = '---\novis_stuk: stk_20261028_0000000b\n---\nMailtekst B\n';
// A: mail + pdf-bijlage; de oude skill verplaatste beide naar Bronnen (hernoemd, ook in een submap)
const idsA = stuk('stk_20261028_0000000a', { delen: [
  { deel: 'eml', rol: 'origineel', naam: 'mail.eml', mime: 'message/rfc822', bytes: Buffer.from('eml') },
  { deel: 'tekst', rol: 'hoofdtekst', naam: 'tekst.md', mime: 'text/markdown', bytes: Buffer.from('Mailtekst A'), schrijf: mailA, pad: '10_Zakelijk/Tolgaarde/raw_input/2026-10-28_mail_factuur.md' },
  { deel: 'b1', rol: 'bijlage', naam: 'factuur-oktober.pdf', mime: 'application/pdf', bytes: pdf, pad: '10_Zakelijk/Tolgaarde/raw_input/2026-10-28_mail_factuur_factuur-oktober.pdf' }] });
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/Tolgaarde - 2026-10-28 - Factuur Onited (mail).md'), mailA);
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/Sub/Tolgaarde - 2026-10-28 - Factuur Onited.pdf'), pdf);
// B: mail, nog in raw_input (de oude skill verplaatst niet meer)
stuk('stk_20261028_0000000b', { ontvangen: '2026-10-28T23:30:00Z', onderwerp: 'Rooster', delen: [
  { deel: 'tekst', rol: 'hoofdtekst', naam: 'tekst.md', mime: 'text/markdown', bytes: Buffer.from('Mailtekst B'), schrijf: mailB, pad: '10_Zakelijk/Tolgaarde/raw_input/2026-10-29_rooster.md' }] });
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/raw_input/2026-10-29_rooster.md'), mailB);
// C: Holding (buiten de scope), D: quarantaine, E: dump zonder entiteit, F: patiëntmarker
stuk('stk_20261028_0000000c', { delen: [{ deel: 'tekst', rol: 'hoofdtekst', naam: 't.md', mime: 'text/markdown', bytes: Buffer.from('C'), pad: '10_Zakelijk/Holding/raw_input/c.md' }] });
stuk('stk_20261028_0000000d', { ps: 'quarantaine', delen: [{ deel: 'tekst', rol: 'hoofdtekst', naam: 't.md', mime: 'text/markdown', bytes: Buffer.from('D'), pad: '10_Zakelijk/Tolgaarde/raw_input/d.md' }] });
stuk('stk_20261028_0000000e', { profiel: 'whatsapp-dump@1', delen: [{ deel: 'dump', rol: 'representatie', naam: 'dump.md', mime: 'text/markdown', bytes: Buffer.from('E'), pad: '30_Conversaties/WhatsApp/e.md' }] });
stuk('stk_20261028_0000000f', { marker: 'mogelijk', onderwerp: 'Uitslag van mevrouw Proefnaam', delen: [{ deel: 'tekst', rol: 'hoofdtekst', naam: 'Proefnaam-uitslag.md', mime: 'text/markdown', bytes: Buffer.from('F'), pad: '10_Zakelijk/Tolgaarde/raw_input/f.md' }] });
const LOG = '---\ntype: bronnenregister\n---\n\n# Verwerkingslog — Tolgaarde\n\n| Bestand | Origineel |\n|---|---|\n| Tolgaarde - oud.pdf | oud.pdf |\n';
fs.writeFileSync(path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/_register.md'), LOG);

let schakel = { aan: true, entiteiten: ['TG'] }, pauze = false, meldingen = [], naRename = null, vvWrap = null;
const vv = { lees: VVecht.lees, schrijf: function (p, t, o) { if (vvWrap) vvWrap(p); return VVecht.schrijf(p, t, o); } };
const pub = P.maak({ db, vault, vv, rpc: sb.rpc, schakelaar: () => schakel, pauze: () => pauze, meld: (t) => meldingen.push(t), naRename: (p) => { if (naRename) naRename(p); },
  staatBestand: path.join(tmp, 'stand.json'), versie: () => 'proef' });
const TG = '10_Zakelijk/Tolgaarde/Bronnen/';
const lees = (rel) => { try { return fs.readFileSync(path.join(vault, rel), 'utf8'); } catch (e) { return null; } };

(async function () {
  toets('0 entiteitVanPad', P.entiteitVanPad('10_Zakelijk/Tolgaarde/raw_input/x.md') === 'TG' && P.entiteitVanPad('20_Prive/raw_input/a.pdf') === 'PRIVE' &&
    P.entiteitVanPad('_INBOX/a.md') === 'INBOX' && P.entiteitVanPad('10_Zakelijk/Projecten/raw_input/a.md') === null && P.entiteitVanPad('30_Conversaties/x.md') === null);
  schakel = null;
  toets('1 schakelaar weg = uit, niets aangeroepen', (await pub.ronde()).uit === true && sb.aanroepen.length === 0);
  schakel = { aan: true, entiteiten: ['TG'] }; pauze = true;
  toets('1b onderhoud/nachtgrendel = wachten', (await pub.ronde()).wacht === 'onderhoud' && sb.aanroepen.length === 0);
  pauze = false;

  const r1 = await pub.ronde();
  const nA = lees(TG + '2026-10-28_stk_20261028_0000000a.md'), nB = lees(TG + '2026-10-29_stk_20261028_0000000b.md'), nF = lees(TG + '2026-10-28_stk_20261028_0000000f.md');
  toets('2 eerste ronde: drie bronnotities + register, geen fout', r1.geschreven === 4 && r1.fout === 0 && nA && nB && nF, r1);
  toets('2b datum in de naam = ontvangst in NL (23:30Z → 29-10)', !!nB);
  toets('2c buiten de scope, quarantaine en zonder entiteit: geen notitie', !fs.existsSync(path.join(vault, '10_Zakelijk/Holding/Bronnen/2026-10-28_stk_20261028_0000000c.md')) &&
    !lees(TG + '2026-10-28_stk_20261028_0000000d.md') && r1.in_scope === 3 && r1.overgeslagen.status === 1 && r1.overgeslagen.entiteit === 1, r1);
  toets('3 frontmatter: type bron, ids, sha256, route, toegang, sb_link nee', /^---\ntype: bron\n/.test(nA) && /\nsource_record_id: 101\n/.test(nA) && /\nrevision_id: 501\n/.test(nA) &&
    new RegExp('\\nsha256: ' + sha('Mailtekst A') + '\\n').test(nA) && /\nroute: \["gmail.david"\]\n/.test(nA) && /\naccess_context: zakelijk_intern\n/.test(nA) && /\nsb_link: nee\n/.test(nA) && /\novis_bronnotitie: stk_20261028_0000000a\n/.test(nA) && /\nentiteit_id: TG\n/.test(nA), nA);
  toets('3b origineel teruggevonden na verplaatsen (ovis_stuk) en de bijlage op sha256 in een submap', /origineel: "\[\[10_Zakelijk\/Tolgaarde\/Bronnen\/Tolgaarde - 2026-10-28 - Factuur Onited \(mail\)\]\]"/.test(nA) &&
    nA.includes('[[10_Zakelijk/Tolgaarde/Bronnen/Sub/Tolgaarde - 2026-10-28 - Factuur Onited.pdf]]'), nA);
  toets('3c origineel in raw_input (niet verplaatst)', nB.includes('origineel: "[[10_Zakelijk/Tolgaarde/raw_input/2026-10-29_rooster]]"'));
  toets('3d blok met content_hash, ontvangsten en onderdelen; geen samenvatting', /<!-- ovis:blok begin id="bronnotitie" content_hash="[0-9a-f]{16}" -->/.test(nA) && nA.includes('<!-- ovis:blok eind -->') &&
    nA.includes('## Ontvangsten') && nA.includes('factuur-oktober.pdf') && nA.includes('| Onderwerp | Factuur Onited oktober |') && !nA.includes('Mailtekst A'));
  toets('3e patiëntmarker: geen onderwerp, geen bestandsnaam', !nF.includes('Proefnaam') && nF.includes('patiëntmarker'));
  const reg1 = lees(TG + '_register.md');
  toets('4 register: handgeschreven log byte-gelijk, blok eronder met drie regels', reg1.startsWith(LOG) && /<!-- ovis:blok begin id="bronregister"/.test(reg1) &&
    (reg1.match(/\| \[\[10_Zakelijk\/Tolgaarde\/Bronnen\/2026-10-2\d_stk_/g) || []).length === 3, reg1);
  toets('4b register nieuwste eerst', reg1.indexOf('0000000b') < reg1.indexOf('0000000a'));
  toets('5 published na klaar (notitie), register zonder versies', sb.occ.filter((x) => x.processing_status === 'published').length === 4 &&
    sb.rows.every((r) => r.status === 'klaar') && sb.rows.filter((r) => r.blok_id === 'bronregister').every((r) => r.revision_ids == null), sb.rows);
  toets('5b doel_paden neutraal (geen onderwerp of naam)', sb.rows.every((r) => PAD_RE[r.blok_id].test(r.doel_pad) && !/Factuur|Rooster|Proefnaam/.test(r.doel_pad)));
  toets('5c run met tellingen', sb.runs.length === 1 && Object.values(sb.runs[0].details).every((v) => typeof v === 'number'));
  toets('5d telling per entiteit: oud gearchiveerd (Bronnen) tegen nieuw', r1.per_entiteit.TG.bronnotities === 3 && r1.per_entiteit.TG.oud_bronnen === 1 && r1.per_entiteit.TG.oud_raw_input === 1 &&
    r1.per_entiteit.HOLD && r1.per_entiteit.HOLD.bronnotities === 0 && r1.per_entiteit.HOLD.in_scope === 0, r1.per_entiteit);

  // idempotent
  const mt = fs.statSync(path.join(vault, TG + '_register.md')).mtimeMs, nRows = sb.rows.length;
  const r2 = await pub.ronde();
  toets('6 tweede ronde: alles gelijk, niets geschreven, geen rijen, geen run', r2.geschreven === 0 && r2.gelijk === 4 && sb.rows.length === nRows && sb.runs.length === 1 &&
    fs.statSync(path.join(vault, TG + '_register.md')).mtimeMs === mt, r2);

  // voetblok van de steekwoorden ná het blok: geen blokkade, blijft staan bij herpublicatie
  const VOET = '\n<!-- sb:generated begin id="steekwoorden" -->\nSteekwoorden: [[X]]\n<!-- sb:generated eind -->\n';
  fs.appendFileSync(path.join(vault, TG + '2026-10-28_stk_20261028_0000000a.md'), VOET);
  sb.occ.push({ record: idsA[0].record, occurrence_id: ++occNr, revision_id: idsA[0].revisie, intake_route: 'outlook.tolgaarde', received_at: '2026-10-28T09:20:00Z', access_context: 'zakelijk_intern', processing_status: 'registered', binnen: null });
  // proef 7: crash ná de rename (vóór klaar)
  naRename = (p) => { if (/0000000a\.md$/.test(p)) throw new Error('proef 7: crash na de rename'); };
  const r3 = await pub.ronde();
  naRename = null;
  const nA2 = lees(TG + '2026-10-28_stk_20261028_0000000a.md');
  const rijA = sb.rows.filter((r) => /0000000a/.test(r.doel_pad)).pop();
  toets('7 proef 7: bestand nieuw (tweede route), voetblok staat er nog, rij bezig', nA2.includes('outlook.tolgaarde') && nA2.endsWith(VOET) && rijA.status === 'bezig' && r3.fout === 1, { r3, rijA });
  const r4 = await pub.ronde();
  const rijA2 = sb.rows.filter((r) => /0000000a/.test(r.doel_pad));
  toets('7b proef 7: volgende ronde rondt af zonder opnieuw te schrijven (geen nieuwe rij)', rijA2.length === 2 && rijA2.every((r) => r.status === 'klaar') && r4.afgerond === 1 && r4.fout === 0 &&
    lees(TG + '2026-10-28_stk_20261028_0000000a.md') === nA2, { r4, rijA2 });

  // proef 8: met de hand gewijzigd in het blok van een notitie
  const pB = path.join(vault, TG + '2026-10-29_stk_20261028_0000000b.md');
  const hand = lees(TG + '2026-10-29_stk_20261028_0000000b.md').replace('## Onderdelen', '## Onderdelen (met de hand)');
  fs.writeFileSync(pB, hand);
  meldingen = [];
  const r5 = await pub.ronde();
  toets('8 proef 8: blokkeer, niets geschreven, één melding', r5.geblokkeerd === 1 && lees(TG + '2026-10-29_stk_20261028_0000000b.md') === hand && meldingen.length === 1 && sb.besluiten.length === 1 &&
    sb.rows.some((r) => /0000000b/.test(r.doel_pad) && r.status === 'geblokkeerd_handmatig'), { r5, meldingen });
  const r6 = await pub.ronde();
  toets('8b volgende ronde: nog geblokkeerd, geen tweede melding of besluit', r6.geblokkeerd === 1 && meldingen.length === 1 && sb.besluiten.length === 1 && lees(TG + '2026-10-29_stk_20261028_0000000b.md') === hand, r6);
  // proef 8 op het register; een regel van de oude skill boven het blok blokkeert niet
  const regPad = path.join(vault, TG + '_register.md');
  fs.writeFileSync(regPad, lees(TG + '_register.md').replace('| Tolgaarde - oud.pdf | oud.pdf |\n', '| Tolgaarde - oud.pdf | oud.pdf |\n| Tolgaarde - nieuw.md | ovis_stuk stk_20261028_0000000b |\n'));
  const r7 = await pub.ronde();
  toets('8c regel van de oude skill boven het blok: geen blokkade', r7.geblokkeerd === 1 && !sb.rows.some((r) => r.blok_id === 'bronregister' && r.status === 'geblokkeerd_handmatig') && r7.per_entiteit.TG.gelogd === 1, r7);
  const regHand = lees(TG + '_register.md').replace('| bronnotitie | ontvangen |', '| bronnotitie (hand) | ontvangen |');
  fs.writeFileSync(regPad, regHand);
  const r8 = await pub.ronde();
  // het register verandert alleen als er iets nieuws is; forceer een nieuwe regel (nieuwe stuk G)
  stuk('stk_20261029_0000000a', { ontvangen: '2026-10-29T10:00:00Z', delen: [{ deel: 'tekst', rol: 'hoofdtekst', naam: 't.md', mime: 'text/markdown', bytes: Buffer.from('G'), pad: '10_Zakelijk/Tolgaarde/raw_input/g.md' }] });
  const r9 = await pub.ronde();
  toets('8d handwijziging in het registerblok → blokkeer, register onveranderd', lees(TG + '_register.md') === regHand && sb.rows.some((r) => r.blok_id === 'bronregister' && r.status === 'geblokkeerd_handmatig') &&
    !!lees(TG + '2026-10-29_stk_20261029_0000000a.md'), { r8, r9 });

  // inode/mtime-toets: iemand schrijft tussen lezen en rename
  sb.occ.push({ record: idsA[0].record, occurrence_id: ++occNr, revision_id: idsA[0].revisie, intake_route: 'gmail.groenhouten', received_at: '2026-10-28T09:25:00Z', access_context: 'zakelijk_intern', processing_status: 'registered', binnen: null });
  const pA = path.join(vault, TG + '2026-10-28_stk_20261028_0000000a.md');
  vvWrap = (p) => { if (p === pA) { const t = fs.readFileSync(pA, 'utf8'); fs.writeFileSync(pA, t + '\nlos\n'); } };
  const r10 = await pub.ronde();
  vvWrap = null;
  toets('9 tussendoor gewijzigd: niet vervangen (inode/mtime-toets), rij blijft bezig', r10.tussendoor === 1 && fs.readFileSync(pA, 'utf8').endsWith('\nlos\n') && !fs.readFileSync(pA, 'utf8').includes('gmail.groenhouten') &&
    sb.rows.filter((r) => /0000000a\.md$/.test(r.doel_pad)).pop().status === 'bezig', r10);

  // schakelaar: Holding erbij
  schakel = { aan: true, entiteiten: ['TG', 'HOLD'] };
  const r11 = await pub.ronde();
  toets('10 tweede entiteit aan: Holding-notitie + nieuw register (bestand bestond niet)', !!lees('10_Zakelijk/Holding/Bronnen/2026-10-28_stk_20261028_0000000c.md') &&
    /^---\ntype: bronnenregister\nentiteit_id: HOLD\n/.test(lees('10_Zakelijk/Holding/Bronnen/_register.md') || ''), r11);
  toets('10b stand op schijf zonder namen of paden', (function () { const t = fs.readFileSync(path.join(tmp, 'stand.json'), 'utf8'); return !/Factuur|Rooster|Proefnaam|10_Zakelijk|stk_/.test(t) && JSON.parse(t).per_entiteit.TG; })());
  toets('10c nooit iets buiten Bronnen/ geschreven', sb.rows.every((r) => /\/Bronnen\//.test(r.doel_pad)) && lees('10_Zakelijk/Tolgaarde/raw_input/2026-10-29_rooster.md') === mailB);

  // kapot register (twee blokken): blokkeer; ook na vrijgeven met overschrijven nooit schrijven (review #4)
  const rk = sb.rows.find((r) => r.blok_id === 'bronregister' && /Tolgaarde/.test(r.doel_pad) && r.status === 'geblokkeerd_handmatig');
  rk.status = 'vervallen';
  const kapotReg = lees(TG + '_register.md') + '\n<!-- ovis:blok begin id="bronregister" content_hash="0" -->\nkopie\n';
  fs.writeFileSync(regPad, kapotReg);
  const kapotHash = P.registerHash(kapotReg).hash;
  sb.rows.push({ outbox_id: sb.rows.length + 1, doel_pad: TG + '_register.md', blok_id: 'bronregister', verwachte_vorige_hash: null, nieuwe_inhoud_hash: kapotHash, status: 'klaar' });   // = vrijgeven --overschrijven
  stuk('stk_20261029_0000000b', { ontvangen: '2026-10-29T11:00:00Z', delen: [{ deel: 'tekst', rol: 'hoofdtekst', naam: 't.md', mime: 'text/markdown', bytes: Buffer.from('H'), pad: '10_Zakelijk/Tolgaarde/raw_input/h.md' }] });
  const r12 = await pub.ronde();
  toets('11c kapot register na overschrijven: nooit schrijven (kapot geteld), bestand onveranderd', r12.kapot === 1 && lees(TG + '_register.md') === kapotReg, r12);
  fs.writeFileSync(regPad, LOG);   // met de hand hersteld tot het log zonder blok (daarna vrijgeven --weg)

  // symlink als wortel en fifo: niet volgen, niet blijven hangen (review #6)
  const buiten = path.join(tmp, 'buiten'); fs.mkdirSync(buiten);
  fs.writeFileSync(path.join(buiten, 'geheim.md'), '---\novis_stuk: stk_20261028_0000000c\n---\n');
  fs.rmSync(path.join(vault, '10_Zakelijk/Holding/raw_input'), { recursive: true, force: true });
  fs.symlinkSync(buiten, path.join(vault, '10_Zakelijk/Holding/raw_input'));
  require('child_process').execFileSync('mkfifo', [path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/vast.md')]);
  require('child_process').execFileSync('mkfifo', [path.join(vault, '10_Zakelijk/Tolgaarde/Bronnen/vast.pdf')]);
  const t0 = Date.now();
  const r13 = await pub.ronde();
  const nC = lees('10_Zakelijk/Holding/Bronnen/2026-10-28_stk_20261028_0000000c.md');
  toets('11d fifo in Bronnen: geen hapering; symlink-wortel niet gevolgd (origineel niet via de link)', Date.now() - t0 < 5000 && r13.fout === 0 && !/buiten|geheim/.test(nC), { r13, ms: Date.now() - t0 });

  // twee rondes tegelijk: de tweede wacht (slot over processen heen, review #2)
  const slot = path.join(tmp, 'publicatie.lock');
  const pubS = P.maak({ db, vault, vv, rpc: sb.rpc, schakelaar: () => schakel, slot });
  fs.writeFileSync(slot, String(process.pid));
  toets('11e slot van een levend proces: wacht', (await pubS.ronde()).wacht === 'andere ronde');
  fs.writeFileSync(slot, '999999');
  const r14 = await pubS.ronde();
  toets('11f slot van een dood proces: opgeruimd, ronde loopt, slot daarna weg', !r14.wacht && r14.fout === 0 && !fs.existsSync(slot), r14);
  // onderhoud halverwege: stoppen
  let tel = 0;
  const pubP = P.maak({ db, vault, vv, rpc: sb.rpc, schakelaar: () => schakel, pauze: () => ++tel > 1 });
  toets('11g pauze halverwege de ronde: stoppen met wacht', (await pubP.ronde()).wacht === 'onderhoud');

  // vindBlok en hashes
  toets('11 vindBlok: twee blokken of geen eind = kapot', P.vindBlok('<!-- ovis:blok begin id="bronregister" -->a<!-- ovis:blok eind -->x<!-- ovis:blok begin id="bronregister" -->', P.REG_BEGIN_RE).kapot === true &&
    P.vindBlok('<!-- ovis:blok begin id="bronregister" -->a', P.REG_BEGIN_RE).kapot === true && P.vindBlok('geen', P.REG_BEGIN_RE) === null);
  toets('11b notitie zonder blok = kapot (blokkeert), register zonder blok = null (aanvullen)', P.notitieHash('---\na\n---\ntekst').kapot === true && P.registerHash('log').hash === null && P.registerHash(null).hash === null);

  // server.js en uitrol.sh
  const srv = fs.readFileSync('server.js', 'utf8');
  const nk = srv.slice(srv.indexOf('const nachtketen = (function'));
  const ix = nk.indexOf("naam: 'intake-publicatie'"), ib = nk.indexOf("naam: 'bibliothecaris'"), ia = nk.indexOf("naam: 'ovis-agenda'");
  toets('12 nachtketen: stap intake-publicatie na de Bibliothecaris, vóór ovis-agenda, in-process', ix > ib && ix < ia && /naam: 'intake-publicatie', start_na: \[2, 40\], na: \['bibliothecaris'\], limiet_min: 15, pogingen: 2, inProces: true/.test(srv));
  toets('12b schakelaar en module in server.js, /health.intake.publicatie', /path\.join\(INTAKE_DIR, 'publicatie\.json'\)/.test(srv) && /require\(p\)\.maak\(\{ db: intake\._db/.test(srv) && /publicatie: intakePublicatieInfo\(\)/.test(srv));
  toets('13 uitrol.sh: intake-publicatie.js optioneel in de release', /^RELEASE_OPTIONEEL="[^"]*\bintake-publicatie\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${goed} groen, ${fouten} rood`);
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS
