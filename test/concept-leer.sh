#!/usr/bin/env bash
# Toetst concept-leer.js (wv4107, besluitenpagina nr 406 = 3C106 en nr 473 = 3C173; ontwerp + Codex-ontwerpreview mk-scripts/wv4107/ontwerp.md):
# schoonmaken (citaat over twee regels, handtekeningblok), Gmail-omgebroken tekst = ongewijzigd, aangepast/niet verstuurd/weggegooid/blijft liggen,
# eigen concept nog in de draad = wachten (ZOU 1), tekstvrije wijzigingen (MOET 1), vier gelijke aanpassingen → precies één weekkaart (niet twee
# keer, niet zolang open), knop Ja zet de bevroren regel in het correctiebestand en verval haalt hem weg, Nee = nooit meer; vervangen: zonder
# registerrij niets, bewerkt = geen knop, onbewerkt = kaart, Ja zonder vingerafdruk niets, Ja met vingerafdruk = n8n-stap met de oude tekst,
# 30-dagenwis; en de koppeling in server.js, mailvoorwerk.js, Dockerfile en uitrol.sh. Alles verzonnen en in een wegwerpmap.
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const C = require('./concept-leer.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-leer-'));
let klok = Date.parse('2026-11-23T10:00:00+01:00');   // maandag, ISO-week 48
const draden = {};   // draad → { berichten }
const uitkomsten = [], register = [], vervangAanroepen = [];
let corr = '# Mailstem\n\n## Correcties\n\n- 2026-11-01 — Oud: iets.\n';
let registerAan = false, vervangAntwoord = { status: 200, j: { ok: true, concept_id: 'r900000001', thread_id: 'abcdef0123456789' } };
const io = {
  dir: path.join(W, 'cl'), nu: function () { return klok; }, fout: function (l, e) { console.log('   (fout ' + l + ': ' + (e && e.message) + ')'); },
  gesprek: async function (d) { if (!draden[d]) throw new Error('onleesbaar'); return draden[d]; },
  uitkomst: function (r) { uitkomsten.push(r); }, register: function (r) { register.push(r); },
  correcties: { wijzig: function (fn) { const n = fn(corr); if (n == null) return false; corr = n; return true; } },
  registerAan: function () { return registerAan; },
  vervang: async function (b) { vervangAanroepen.push(b); return vervangAntwoord; },
};
const m = C.maak(io);
const iso = function (ms) { return new Date(ms).toISOString(); };
const H = 3600000;
const dr = function (i) { return ('a1b2c3d4e5f6' + String(i).padStart(4, '0')); };
const concept = function (naam, slot) {
  return 'Beste ' + naam + ',\n\nDank voor je bericht over de planning van volgende week. Ik kijk er morgen naar en kom erop terug met een voorstel.\n' +
    'Het rooster voor december staat bijna klaar, alleen de vrijdag moet nog rond.\n' + (slot === false ? '' : 'Laat maar weten als je nog vragen hebt.\n') + '\nGroet,\nDavid';
};
const omgebroken = function (t) { return t.replace(/(.{60,70}?) /g, '$1\n'); };   // zoals Gmail de text/plain breekt (spatie → regeleinde)

(async function () {
  // ── puur ──
  const c0 = concept('Piet');
  const verz0 = omgebroken(c0) + '\n\nOp ma 23 nov 2026 om 09:12 schreef Piet Voorbeeld <\npiet@voorbeeld.invalid>:\n> Hoi David,\n> hoe zit het?\n';
  toets('vergelijk: omgebroken + citaat over twee regels = ongewijzigd', C.vergelijk(c0, verz0).uitkomst === 'ongewijzigd', C.vergelijk(c0, verz0));
  const verzHt = c0 + '\n\nHuisartsenpraktijk Voorbeeld\nKvK 00000000 | www.voorbeeld.invalid\n';
  toets('vergelijk: handtekeningblok erachter = ongewijzigd', C.vergelijk(c0, verzHt).uitkomst === 'ongewijzigd', C.vergelijk(c0, verzHt));
  const aangepast = 'Hoi Piet,\n\nDank voor je bericht over de planning van volgende week. Ik kijk er morgen naar en kom erop terug met een voorstel.\n' +
    'Het rooster voor december staat bijna klaar, alleen de vrijdag moet nog rond.\n\nGroetjes,\nDavid';
  const v1 = C.vergelijk(c0, aangepast);
  const soorten = v1.wijzigingen.map(function (w) { return w.soort; }).sort();
  toets('vergelijk: aangepast met aanhef, groet en slotzin_weg', v1.uitkomst === 'aangepast' && soorten.join(',') === 'aanhef,groet,slotzin_weg', v1);
  toets('wijzigingen: tekstvrij (geen naam of zin in sleutels, MOET 1)', v1.wijzigingen.every(function (w) { return !/piet|planning|rooster|vragen/i.test(JSON.stringify(w)); }), v1.wijzigingen);
  toets('wijzigingen: groet buiten de vaste lijst telt niet', C.wijzigingen('Beste Jan,\n\nDit is een test met genoeg woorden erin.\n\nGroet,\nDavid', 'Beste Jan,\n\nDit is een test met genoeg woorden erin.\n\nGroeten aan Marieke en de kinderen,\nDavid').every(function (w) { return w.soort !== 'groet'; }));
  toets('vergelijk: heel andere tekst = niet_verstuurd (eigen_tekst)', C.vergelijk(c0, 'Hee, ik bel je straks even.\n\nD.').uitkomst === 'niet_verstuurd');
  toets('regelErin: bovenaan onder Correcties', C.regelErin(corr, '- 2026-11-23 — X').indexOf('## Correcties\n\n- 2026-11-23 — X\n- 2026-11-01') > 0);
  toets('regelErin: al aanwezig = null', C.regelErin('## Correcties\n\n- a\n', '- a') === null);
  toets('adressen: uit weergavenaam', C.adressen('"Jansen, Piet" <p@x.invalid>, q@y.invalid').join(',') === 'p@x.invalid,q@y.invalid');

  // ── bewaren + ronde ──
  toets('bewaar: ongeldig id geweigerd', m.bewaar({ concept_id: 'x', draad: dr(0), tekst: 'hallo daar' }).ok === false);
  for (let i = 1; i <= 5; i++) {
    toets('bewaar ' + i, m.bewaar({ concept_id: 'r10000000' + i, draad: dr(i), aan: 'p' + i + '@voorbeeld.invalid', onderwerp: 'Re: Planning', tekst: concept('Persoon' + i) }).ok === true);
  }
  m.bewaar({ concept_id: 'r200000001', draad: dr(10), aan: 'z@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Zus') });   // wordt weggegooid
  m.bewaar({ concept_id: 'r200000002', draad: dr(11), aan: 'y@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Yvo') });   // blijft liggen
  m.bewaar({ concept_id: 'r200000003', draad: dr(12), aan: 'w@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Wim') });   // ander SENT, eigen concept nog er
  const t0 = klok;
  klok += 2 * H;
  for (let i = 1; i <= 4; i++) {
    draden[dr(i)] = { berichten: [{ id: 'm' + i, labels: ['INBOX'], datum: iso(t0 - 5 * H), tekst: 'vraag' },
      { id: 's' + i, labels: ['SENT'], datum: iso(t0 + H), tekst: aangepast.replace('Piet', 'Persoon' + i) + '\n\nOp ma 23 nov 2026 schreef x:\n> vraag' }] };
  }
  draden[dr(5)] = { berichten: [{ id: 's5', labels: ['SENT'], datum: iso(t0 + H), tekst: omgebroken(concept('Persoon5')) }] };
  draden[dr(10)] = { berichten: [{ id: 'm10', labels: ['INBOX'], datum: iso(t0 - H), tekst: 'vraag' }] };
  draden[dr(11)] = { berichten: [{ id: 'd11', labels: ['DRAFT'], datum: iso(t0), aan: 'Yvo <y@voorbeeld.invalid>', onderwerp: 'Iets', tekst: concept('Yvo') }] };
  draden[dr(12)] = { berichten: [{ id: 's12', labels: ['SENT'], datum: iso(t0 + H), tekst: 'Los bericht van David, ander onderwerp helemaal.' }, { id: 'd12', labels: ['DRAFT'], datum: iso(t0), tekst: concept('Wim') }] };
  const r1 = await m.ronde();
  toets('ronde: 4 aangepast, 1 ongewijzigd, 1 weggegooid, 2 wachten', r1.aangepast === 4 && r1.ongewijzigd === 1 && r1.niet_verstuurd === 1 && r1.wacht === 2, r1);
  toets('uitkomst: regel per concept zonder tekst', uitkomsten.length === 6 && uitkomsten.every(function (u) { return !/Persoon|planning|rooster/i.test(JSON.stringify(u)); }), uitkomsten);
  toets('uitkomst: aangepast heeft soorten', uitkomsten.find(function (u) { return u.concept_id === 'r100000001'; }).wijzigingen.indexOf('groet') >= 0);
  const r2 = await m.ronde();
  toets('ronde: binnen 6 uur niet opnieuw', r2.gekeken === 0, r2);

  // ── weekkaart ──
  const k1 = m.kaart({});
  toets('kaart: vier gelijke aanpassingen → één voorstel', k1.kaart && k1.kaart.soort === 'besluit' && /\?$/.test(k1.kaart.titel) && k1.kaart.titel.length <= 90, k1);
  toets('kaart: sleutel per ISO-week', k1.kaart && k1.kaart.sleutel === 'mailstem-leer-2026-48');
  toets('kaart: regel ≤ 300 en met datumkop', k1.bevries && k1.bevries.regel.length <= 300 && /^- 2026-11-23 — Alle mailconcepten: /.test(k1.bevries.regel), k1.bevries);
  toets('kaart: geen mailtekst op de kaart', !/Persoon|planning|rooster/i.test(JSON.stringify(k1.kaart)), k1.kaart);
  m.kaartGezet(k1.bevries);
  toets('kaart: deze week geen tweede', m.kaart({}).reden === 'deze week al een kaart');
  klok += 7 * 24 * H;
  toets('kaart: volgende week niet zolang de vorige open staat', m.kaart({ 'mailstem-leer-2026-48': 'open' }).reden === 'er staat nog een mailstem-kaart open');
  klok -= 7 * 24 * H;
  toets('knop: vreemde sleutel = null', m.knop('zoek-snel-leer-2026-48', 'ja') === null && m.knop('mailstem-leer-2026-47', 'ja') === null);
  const kn = m.knop('mailstem-leer-2026-48', 'ja');
  kn.bijStart('ja', false);
  toets('knop Ja: bevroren regel staat bovenaan in het correctiebestand', corr.indexOf('## Correcties\n\n' + k1.bevries.regel + '\n') >= 0, corr);
  kn.bijVerval();
  toets('knop verval: regel weer weg', corr.indexOf(k1.bevries.regel) < 0, corr);
  const kn2 = m.knop('mailstem-leer-2026-48', 'nee'); kn2.bijStart('nee', false);
  toets('knop Nee: niets geschreven', corr.indexOf('Alle mailconcepten') < 0);
  klok += 7 * 24 * H;
  const k2 = m.kaart({});
  toets('kaart: afgewezen patroon komt niet terug (wel een ander)', !k2.kaart || k2.bevries.patroon !== k1.bevries.patroon, k2);
  klok -= 7 * 24 * H;

  // ── vervangen ──
  const nieuw = { aan: 'y@voorbeeld.invalid', onderwerp: 'Re: Iets', bericht: 'Beste Yvo,\n\nNieuwe versie van mijn antwoord.\n\nGroet,\nDavid' };
  toets('vervang: zonder registerrij uit', (await m.vervangKan(dr(11))).reden === 'uit');
  registerAan = true;
  toets('vervang: onbewerkt eigen concept = kan', (await m.vervangKan(dr(11))).kan === true);
  draden[dr(13)] = { berichten: [{ id: 'd13', labels: ['DRAFT'], datum: iso(t0), tekst: concept('Ans') + '\nNog iets erbij van David.' }] };
  m.bewaar({ concept_id: 'r200000004', draad: dr(13), aan: 'a@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Ans') });
  toets('vervang: bewerkt = geen knop', (await m.vervangKan(dr(13))).reden === 'bewerkt');
  draden[dr(14)] = { berichten: [{ id: 'd14', labels: ['DRAFT'], datum: iso(t0), aan: 'ander@voorbeeld.invalid', tekst: concept('Bo') }] };
  m.bewaar({ concept_id: 'r200000005', draad: dr(14), aan: 'b@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Bo') });
  toets('vervang: andere ontvanger = bewerkt (MOET 3)', (await m.vervangKan(dr(14))).reden === 'bewerkt');
  draden[dr(15)] = { berichten: [{ id: 'd15', labels: ['DRAFT'], datum: iso(t0), aan: 'c@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Cor'), bijlagen: [{ naam: 'x.pdf' }] }] };
  m.bewaar({ concept_id: 'r200000006', draad: dr(15), aan: 'c@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Cor') });
  toets('vervang: bijlage aan het oude = geen knop (MOET 3)', (await m.vervangKan(dr(15))).reden === 'bijlagen');
  draden[dr(16)] = { berichten: [{ id: 'd16', labels: ['DRAFT'], datum: iso(t0), aan: 'd@voorbeeld.invalid', cc: 'extra@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Dirk') }] };
  m.bewaar({ concept_id: 'r200000007', draad: dr(16), aan: 'd@voorbeeld.invalid', onderwerp: 'Iets', tekst: concept('Dirk') });
  toets('vervang: cc erbij gezet = bewerkt (n8n-review MOET 1)', (await m.vervangKan(dr(16))).reden === 'bewerkt');
  toets('vervang: geen eigen concept in de draad', (await m.vervangKan(dr(99))).reden === 'geen_eigen');
  const vk = await m.vervangKaart(dr(11), nieuw);
  toets('vervangkaart: besluit met verwijderen in de titel en spoed', vk.ok && vk.kaart.soort === 'besluit' && /verwijderen/.test(vk.kaart.titel) && /\?$/.test(vk.kaart.titel) && !!vk.kaart.spoed, vk);
  toets('vervangknop: vreemde sleutel = null', m.vervangKnop('mailconcept-vervang-000000000000', 'ja') === null);
  const vkn = m.vervangKnop(vk.sleutel, 'ja');
  vkn.bijStart('ja', false);
  toets('vervangknop: Ja zonder vingerafdruk doet niets', vervangAanroepen.length === 0 && m.vervangStand(dr(11)).status === 'geen_vingerafdruk', m.vervangStand(dr(11)));
  vkn.bijVerval();
  toets('vervangknop: verval zet hem terug op open', m.vervangStand(dr(11)).status === 'open');
  const vkn2 = m.vervangKnop(vk.sleutel, 'ja');
  vkn2.bijStart('ja', true);
  await new Promise(function (r) { setTimeout(r, 50); });
  const st = m.vervangStand(dr(11));
  toets('vervangknop: Ja met vingerafdruk → één n8n-stap met oude tekst en nieuwe versie', vervangAanroepen.length === 1 && vervangAanroepen[0].oud_concept_id === 'r200000002' &&
    vervangAanroepen[0].verwacht_tekst === concept('Yvo') && vervangAanroepen[0].verwacht_cc === '' && vervangAanroepen[0].verwacht_aan === 'y@voorbeeld.invalid' && vervangAanroepen[0].bericht === nieuw.bericht && vervangAanroepen[0].thread_id === dr(11), vervangAanroepen);
  toets('vervang: stand vervangen_los (andere draad terug) en register met vervangt', st.status === 'vervangen_los' && register.some(function (r) { return r.vervangt === 'r200000002' && r.bron === 'vervang'; }), [st, register]);
  // n8n weigert → niets veranderd
  const vk3 = await m.vervangKaart(dr(14).replace(/.$/, '7'), nieuw);
  toets('vervangkaart: geen eigen concept = geen kaart', vk3.ok === false);
  registerAan = false;

  // ── 30 dagen ──
  klok += 31 * 24 * H;
  m.opruim();
  toets('opruim: na 30 dagen geen concepttekst meer', m._db().prepare('SELECT count(*) n FROM concept').get().n === 0);
  toets('health: alleen aantallen', !/Persoon|planning/.test(JSON.stringify(m.health())), m.health());

  // ── koppeling ──
  const S = fs.readFileSync('server.js', 'utf8'), U = fs.readFileSync('uitrol.sh', 'utf8'), D = fs.readFileSync('Dockerfile', 'utf8'), V = fs.readFileSync('mailvoorwerk.js', 'utf8');
  toets('server: knop vóór zoek-het-uit', /conceptLeer\.knop\(p\.sleutel, keuze, d\.toelichting\) \|\| conceptLeer\.vervangKnop\(p\.sleutel, keuze\)/.test(S));
  toets('server: /smal/mailconcept register/vervang', /d\.opdracht === 'register'/.test(S) && /d\.opdracht === 'vervang'/.test(S) && /d\.opdracht === 'vervang-stand'/.test(S));
  toets('server: schakelaar = registerrij', /x\.id === CL\.VERVANG_RIJ && x\.status === 'aan'/.test(S));
  toets('server: /health concept_leer', /concept_leer: typeof conceptLeerInfo === 'function'/.test(S));
  toets('voorwerk: bewaar en vervangKaart', /io\.bewaar\(\{ concept_id: j\.concept_id/.test(V) && /io\.vervangKaart\(draad, body\)/.test(V));
  toets('uitrol: concept-leer.js in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bconcept-leer\.js\b/.test(U));
  toets('Dockerfile: concept-leer.js', /COPY concept-leer\.js /.test(D));

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
JS
