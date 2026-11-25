#!/usr/bin/env bash
# wv4007: Open Eindjes-wachter (open-eindjes.js) met verzonnen gesprekken, namen en nummers (geen echte personen).
# Draait op de pod: de SQL gaat echt naar de eigen databank (/app/sb-sql), maar alleen naar een wegwerpschema wv4007_toets_<pid>
# (kopie van de kolommen van open_eindjes, signal_bericht en teams_berichten) dat de toets aan het eind weggooit.
# WhatsApp, Telegram, contacten, Voor jou-RPC, box en leeslog zijn nep. Gevallen: venster 24 u-7 d, van_david, onbekend nummer,
# praktijknummer, "?"-vulbericht na een getoond eindje, nieuwe vraag na een getoond eindje, getoond nooit terug, 6e eindje schuift door,
# Teams alleen op werkdagen (weekend telt maandag mee), Teams-kanaal en grote groep eruit, Signal-groep eruit, hercheck (David antwoordde)
# = afgerond, kaartlengtes (titel ≤ 90, waarom ≤ 400, stap ≤ 400, ≤ 12 stappen), kaart van gisteren dicht, storing één keer per storing,
# geen haal = één box-rij, kaart pas getoond na zetten (zet faalt = niets getoond), wissen na 30 dagen, cache (één Telegram-lezing).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x /app/sb-sql ] || { echo "OVERGESLAGEN: geen /app/sb-sql (alleen op de pod)"; exit 0; }
node - <<'JS'
'use strict';
const { execFileSync } = require('child_process');
const M = require('./open-eindjes.js');
let goed = 0, fouten = 0;
function toets(naam, ok, info) { if (ok) { goed++; console.log('GROEN ' + naam); } else { fouten++; console.log('ROOD  ' + naam + (info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); } }
const S = 'wv4007_toets_' + process.pid;
function sql(q) {
  const uit = execFileSync('/app/sb-sql', [], { input: q, encoding: 'utf8' });
  const j = uit.trim() ? JSON.parse(uit) : [];
  if (!Array.isArray(j)) throw new Error('databank: ' + JSON.stringify(j));
  return j;
}
sql(`create schema ${S};
create table ${S}.open_eindjes (like machinekamer.open_eindjes including all);
create table ${S}.signal_bericht (like secondbrain.signal_bericht including defaults);
create table ${S}.teams_berichten (like secondbrain.teams_berichten including defaults);`);
(async function () {
  try {
    // ── puur ──
    toets('vulsel: ?, hallo?, en??, emoji = vulbericht; echte vraag niet', ['?', 'hallo?', 'En??', '👀🙏', 'Hallo David?'].every(M.vulsel) && !M.vulsel('kun je morgen?') && !M.vulsel('ok'));
    const NU = Date.parse('2026-11-26T05:50:00Z') / 1000;   // do 06:50 NL
    toets('venster: 23 u nee, 25 u ja, 6,9 d ja, 7,1 d nee', !M.inVenster(NU - 23 * 3600, NU) && M.inVenster(NU - 25 * 3600, NU) && M.inVenster(NU - 6.9 * 86400, NU) && !M.inVenster(NU - 7.1 * 86400, NU));
    toets('werkdagenSinds: vr-avond → ma 1, di 2', M.werkdagenSinds(Date.parse('2026-11-20T18:00:00Z') / 1000, Date.parse('2026-11-23T06:00:00Z') / 1000) === 1 && M.werkdagenSinds(Date.parse('2026-11-20T18:00:00Z') / 1000, Date.parse('2026-11-24T06:00:00Z') / 1000) === 2);
    // ── een nepwereld ──
    let nu = NU, datum = '2026-11-26';
    const W = { nl: [], gambia: [] }, STAART = {}, CONTACT = { '+31600000001': 'Proef Een', '+31600000002': 'Proef Twee', '+31600000004': 'Proef Vier', '+31600000005': 'Proef Vijf', '+31600000006': 'Proef Zes', '+31600000007': 'Proef Zeven', '+31334941210': 'Praktijk' };
    let TG = { gesprekken: [], staarten: {}, ankers: {} }, tgAanroepen = 0, tgFout = null, waFout = null, tgAnkerVoor = null, faalGetoond = false;
    const box = [], leeslog = [], kaarten = [], status = []; let staat = {}; let zetFout = false;
    let lijst = [];
    const io = {
      nu: () => nu, datum: () => datum, tabellen: { eindjes: S + '.open_eindjes', signal: S + '.signal_bericht', teams: S + '.teams_berichten' },
      wa: async (s) => { if (waFout) throw new Error(waFout); return { chats: W[s] }; },
      waStaart: async (s, id, max) => { const x = STAART[id] || { anker_ts: null, berichten: [] }; return { anker_ts: x.anker_ts, spraak: 0, berichten: x.berichten, max: max }; },
      contacten: async (nrs) => { const u = {}; nrs.forEach((n) => { if (CONTACT[n]) u[n] = CONTACT[n]; }); return u; },
      tg: async (o) => { tgAanroepen++; if (tgFout) throw new Error(tgFout); if (!o.staart) tgAnkerVoor = o.ankerVoor; return o.staart ? TG : { gesprekken: TG.gesprekken, ankers: TG.hercheckAnkers || {} }; },
      sql: async (q) => { if (faalGetoond && /set getoond_op = now\(\), kaart =/.test(q)) { faalGetoond = false; throw new Error('databank weg'); } return sql(q); },
      rpc: async (naam, a) => {
        if (naam === 'mk_voor_jou_lijst') return { punten: lijst };
        if (naam === 'mk_voor_jou_zet') { if (zetFout) throw new Error('zet faalt'); kaarten.push(a.p); lijst.push({ sleutel: a.p.sleutel, status: 'open', herkomst: JSON.parse(JSON.stringify(a.p.herkomst)) }); return { sleutel: a.p.sleutel }; }
        if (naam === 'mk_voor_jou_status') { status.push(a); const p = lijst.find((x) => x.sleutel === a.p_sleutel); if (p) p.status = a.p_naar; return { ok: true }; }
        throw new Error('onbekende rpc ' + naam);
      },
      leeslog: (r) => leeslog.push(r), box: (t) => { box.push(t); return true; },
      staat: () => JSON.parse(JSON.stringify(staat)), staatZet: (o) => { staat = JSON.parse(JSON.stringify(o)); }, log: () => {} };
    const H = 3600;
    const wa = (nr, ts, vanDavid) => ({ id: nr + '@c.us', naam: 'x', ts: ts, van_david: vanDavid });
    // NL: 1 = kandidaat (30 u oud), 2 = David laatst, 3 = onbekend nummer, 4 = 20 u (te vers), 5 = 8 dagen (te oud), 6/7 = kandidaten, praktijk = nooit
    W.nl = [wa('31600000001', NU - 30 * H, false), wa('31600000002', NU - 30 * H, true), wa('31600000003', NU - 30 * H, false), wa('31600000004', NU - 20 * H, false),
      wa('31600000005', NU - 8 * 86400, false), wa('31600000006', NU - 50 * H, false), wa('31600000007', NU - 70 * H, false), wa('31334941210', NU - 30 * H, false)];
    STAART['31600000001@c.us'] = { anker_ts: NU - 40 * H, berichten: [{ ts: NU - 31 * H, wie: 'ander', tekst: 'kun je donderdag invallen?' }, { ts: NU - 30 * H, wie: 'ander', tekst: 'graag snel' }] };
    STAART['31600000006@c.us'] = { anker_ts: NU - 60 * H, berichten: [{ ts: NU - 50 * H, wie: 'ander', tekst: 'dank je!' }] };
    STAART['31600000007@c.us'] = { anker_ts: 0, berichten: [{ ts: NU - 70 * H, wie: 'ander', tekst: 'wil je het contract tekenen?' }] };
    TG = { gesprekken: [{ id: '7001', naam: 'Tg Proef', gebruikersnaam: 'tgproef', ts: NU - 26 * H, van_david: false }, { id: '7002', naam: 'Tg Laat', gebruikersnaam: null, ts: NU - 26 * H, van_david: true }],
      staarten: { '7001': [{ ts: NU - 26 * H, wie: 'ander', tekst: 'kom je zaterdag?' }] }, ankers: { '7001': NU - 3 * 86400 } };
    // Signal: 1-op-1 met vraag, groep (44 tekens) nooit; Teams: 1-op-1 met vraag, kanaal (tacv2) nooit, grote groep nooit, kleine groep wel
    sql(`insert into ${S}.signal_bericht (gesprek_id, envelop_ts, afzender, afzender_naam, eigen, tekst) values
      ('+31600000011', ${(NU - 80 * H) * 1000}, '+31600000011', 'Sig Proef', false, 'kun je de waarneming bevestigen?'),
      ('+31600000011', ${(NU - 90 * H) * 1000}, 'ik', 'David', true, 'hoi'),
      ('${'A'.repeat(43)}=', ${(NU - 30 * H) * 1000}, '+31600000012', 'Groepslid', false, 'vraag in de groep?')`);
    const tijd = (t) => `to_timestamp(${t})`;
    sql(`insert into ${S}.teams_berichten (message_id, conversation_id, gesprek_naam, afzender, tekst, tijd, verwerkt_op, klasse) values
      ('t1', '19:aaaa_bbbb@unq.gbl.spaces', '', 'Collega Proef', 'kun jij het rooster checken?', ${tijd(NU - 30 * H)}, now(), 'zakelijk'),
      ('t2', '19:aaaa_bbbb@unq.gbl.spaces', '', 'David Schaap', 'eerder', ${tijd(NU - 40 * H)}, now(), 'zakelijk'),
      ('t3', '19:kanaal@thread.tacv2', 'Kanaal', 'Iemand', 'vraag aan iedereen?', ${tijd(NU - 30 * H)}, now(), 'zakelijk'),
      ('t4', '19:groot@thread.v2', 'Groot', 'A', 'vraag?', ${tijd(NU - 30 * H)}, now(), 'zakelijk'), ('t5', '19:groot@thread.v2', 'Groot', 'B', 'x', ${tijd(NU - 31 * H)}, now(), 'zakelijk'),
      ('t6', '19:groot@thread.v2', 'Groot', 'C', 'y', ${tijd(NU - 32 * H)}, now(), 'zakelijk'), ('t7', '19:groot@thread.v2', 'Groot', 'D', 'z', ${tijd(NU - 33 * H)}, now(), 'zakelijk'),
      ('t8', '19:klein@thread.v2', 'Klein', 'E', 'wie neemt dit op?', ${tijd(NU - 29 * H)}, now(), 'zakelijk'),
      ('t9', '19:midden@thread.v2', 'Midden', 'F', 'vraag aan de groep?', ${tijd(NU - 30 * H)}, now(), 'zakelijk'), ('t10', '19:midden@thread.v2', 'Midden', 'G', 'a', ${tijd(NU - 40 * 86400)}, now(), 'zakelijk'),
      ('t11', '19:midden@thread.v2', 'Midden', 'H', 'b', ${tijd(NU - 41 * 86400)}, now(), 'zakelijk'), ('t12', '19:midden@thread.v2', 'Midden', 'I', 'c', ${tijd(NU - 42 * 86400)}, now(), 'zakelijk')`);
    const o = M.maak(io);
    // ── haal ──
    const h = await o.haal();
    const namen = h.kandidaten.map((k) => k.naam).sort();
    toets('haal: kandidaten = 1, 6, 7, Telegram, Signal, Teams 1-op-1 (geen Teams-groep)', JSON.stringify(namen) === JSON.stringify(['Collega Proef', 'Proef Een', 'Proef Zes', 'Proef Zeven', 'Sig Proef', 'Tg Proef'].sort()), namen);
    toets('haal: geen onbekend nummer, geen praktijknummer, geen groep/kanaal, geen Teams-groepschat', !namen.some((n) => /Praktijk|Groepslid|Kanaal|Groot|Midden|Klein/.test(n)) && h.kanalen['whatsapp-nl'].onbekend === 1);
    toets('haal: run ziet geen chat-id of link, wel staart met tijd', h.kandidaten.every((k) => !k.chat && !k.link && Array.isArray(k.staart) && k.staart[0].tijd) && !JSON.stringify(h).includes('31600000001'));
    toets('haal: één Telegram-regel in het leeslog, met de gelezen chat', leeslog.length === 1 && /Tg Proef \(7001\)/.test(leeslog[0]) && !/Tg Laat/.test(leeslog[0]), leeslog);
    const h2 = await o.haal();
    toets('haal 2× in dezelfde nacht: cache, geen tweede Telegram-lezing', h2 === h && tgAanroepen === 1 && leeslog.length === 1);
    // ── oordeel ──
    const id = (n) => h.kandidaten.find((k) => k.naam === n).id;
    const r = await o.oordeel({ oordelen: [{ id: id('Proef Een'), oordeel: 'eindje', zin: 'of je donderdag kunt invallen' }, { id: id('Proef Zes'), oordeel: 'geen' },
      { id: id('Proef Zeven'), oordeel: 'eindje', zin: 'of je het contract wilt tekenen' }, { id: id('Tg Proef'), oordeel: 'eindje', zin: 'of je zaterdag komt' },
      { id: id('Sig Proef'), oordeel: 'eindje', zin: 'of je de waarneming bevestigt' + ' en nog veel meer tekst'.repeat(6) },
      { id: id('Collega Proef'), oordeel: 'eindje', zin: 'of je het rooster checkt' }, { id: 'onzin', oordeel: 'eindje', zin: 'x' }] });
    toets('oordeel: 6 opgeslagen, onbekend id gemeld', r.opgeslagen === 6 && r.onbekend.length === 1, r);
    const getal = await o.oordeel({ oordelen: [{ id: id('Proef Zes'), oordeel: 'eindje', zin: 'of je de 250 euro terugstuurt' }] });
    toets('oordeel: getal dat niet in het bericht staat → terug naar de run', getal.opgeslagen === 0 && /250/.test(getal.fouten[0] || ''), getal);
    const zinLang = sql(`select max(length(zin)) n from ${S}.open_eindjes`)[0].n;
    toets('oordeel: zin ingekort tot ≤ 90', zinLang <= 90, zinLang);
    const fout = await o.oordeel({ oordelen: [{ id: id('Proef Een'), oordeel: 'misschien' }, { id: id('Proef Een'), oordeel: 'eindje', zin: '' }] });
    toets('oordeel: ongeldig oordeel en eindje zonder zin geweigerd', fout.fouten.length === 2 && fout.opgeslagen === 0, fout);
    // ── kaart (donderdag): 6 eindjes, 1 hercheck-antwoord (Telegram) → 5 op de kaart, 0 door; daarna 6e-geval apart ──
    // hercheck: Telegram — David antwoordde om 04:50, daarna schreef de ander nog iets (laatste bericht niet van David; anker zegt het)
    TG.gesprekken[0] = Object.assign({}, TG.gesprekken[0], { ts: NU - 1 * H, van_david: false }); TG.hercheckAnkers = { '7001': NU - 2 * H };
    // WhatsApp — idem bij Proef Zeven ("dank je" na Davids antwoord)
    W.nl[6] = wa('31600000007', NU - 1 * H, false); STAART['31600000007@c.us'] = { anker_ts: NU - 2 * H, berichten: [{ ts: NU - 1 * H, wie: 'ander', tekst: 'dank je!' }] };
    lijst = [{ sleutel: 'eindjes-2026-11-25', status: 'open' }, { sleutel: 'facturen-2026-11-25', status: 'open' }];
    staat.haal = { datum: datum };
    // twee extra eindjes (jongste vragen): 7 - 2 hercheck = 5 + … → 5 op de kaart, 1 schuift door
    sql(`insert into ${S}.open_eindjes (kanaal, chat, anker_ts, vraag_ts, laatste_ts, naam, link, oordeel, zin) values ('whatsapp-nl', '31600000098@c.us', 0, ${NU - 25 * H}, ${NU - 25 * H}, 'Proef Acht', 'https://wa.me/31600000098', 'eindje', 'of je de sleutel terugbrengt'),
      ('whatsapp-nl', '31600000097@c.us', 0, ${NU - 24.5 * H}, ${NU - 24.5 * H}, 'Proef Negen', null, 'eindje', 'of je de map meeneemt'),
      ('signal', '+31600000096', 0, ${NU - 27 * H}, ${NU - 27 * H}, 'Sig Twee', null, 'eindje', 'of je de dienst overneemt')`);
    const k1 = await o.kaartStap();
    const kt = kaarten[0];
    toets('kaart: hercheck ziet Davids antwoord ook als de ander daarna nog schreef (Telegram + WhatsApp afgerond)', k1.afgerond === 2 && Number(sql(`select count(*) n from ${S}.open_eindjes where afgerond_reden like 'David antwoordde%' and naam in ('Tg Proef', 'Proef Zeven')`)[0].n) === 2, k1);
    toets('kaart: Telegram-hercheck vraagt alleen het anker van de wachtende chat', Array.isArray(tgAnkerVoor) && tgAnkerVoor.length === 1 && tgAnkerVoor[0] === '7001', tgAnkerVoor);
    toets('kaart: eindje-id\'s op de kaart (herstelpad)', Array.isArray(kaarten[0].herkomst.eindjes) && kaarten[0].herkomst.eindjes.length === 5);
    toets('kaart: 5 eindjes, oudste vraag eerst (Signal 80 u)', kt && kt.stappen.length === 5 && /^Sig Proef \(Signal/.test(kt.stappen[0]), kt && kt.stappen);
    toets('kaart: lengtes (titel ≤ 90, waarom ≤ 400, stap ≤ 400, ≤ 12)', kt.titel.length <= 90 && kt.waarom.length <= 400 && kt.stappen.every((s) => s.length <= 400) && kt.stappen.length <= 12, [kt.titel.length, kt.waarom.length]);
    toets('kaart: titel "Nog beantwoorden — 5 berichten …", sleutel eindjes-<datum>, soort doen, herkomst module open-eindjes', kt.titel === 'Nog beantwoorden — 5 berichten wachten op je antwoord' && kt.sleutel === 'eindjes-2026-11-26' && kt.soort === 'doen' && kt.herkomst.module === 'open-eindjes');
    toets('kaart: links alleen wa.me/signal.me/teams, ook in herkomst', kt.herkomst.links.length >= 3 && kt.herkomst.links.every((l) => M.LINK_RE.test(l.link)), kt.herkomst.links);
    toets('kaart: geen wv-nummer, pad of vaultpad in de tekst', !/wv\d|\/opt\/data|\d\d_[A-Z]|\.md\b/.test(JSON.stringify([kt.titel, kt.waarom, kt.stappen])));
    toets('kaart: gisteren dicht (vervallen, door agent), andere kaart ongemoeid', status.length === 1 && status[0].p_sleutel === 'eindjes-2026-11-25' && status[0].p_naar === 'vervallen' && status[0].p_door === 'agent', status);
    toets('kaart: 6e eindje schuift door (rest 1)', k1.getoond === 5 && k1.door === 1 && /nog 1 schuiven door/.test(kt.waarom), k1);
    const getoond = sql(`select count(*) n from ${S}.open_eindjes where getoond_op is not null`)[0].n;
    toets('kaart: getoond_op op precies de 5', Number(getoond) === 5, getoond);
    const k1b = await o.kaartStap();
    toets('kaart: tweede tik op dezelfde dag doet niets', k1b.al_gedaan === true && kaarten.length === 1);
    // ── vrijdag: nieuwe haal; "?" na getoond = geen kandidaat; nieuwe vraag na getoond = wel (met eerder); de 6e komt nu op de kaart ──
    nu = NU + 86400; datum = '2026-11-27';
    W.nl[0] = wa('31600000001', NU - 4 * H, false);   // nieuw laatste bericht, nog steeds niet van David
    // Davids laatste bericht valt nu buiten het leesvenster (anker null): het blijft dezelfde open vraag (Codex r1 MOET 5)
    STAART['31600000001@c.us'] = { anker_ts: null, berichten: STAART['31600000001@c.us'].berichten.concat([{ ts: NU - 4 * H, wie: 'ander', tekst: 'hallo??' }]) };
    W.nl[5] = wa('31600000006', NU - 5 * H, false);
    STAART['31600000006@c.us'] = { anker_ts: NU - 60 * H, berichten: STAART['31600000006@c.us'].berichten.concat([{ ts: NU - 5 * H, wie: 'ander', tekst: 'en kun je volgende week dienst ruilen?' }]) };
    TG.gesprekken[0] = Object.assign({}, TG.gesprekken[0], { ts: NU - 1 * H, van_david: true });
    const hv = await o.haal({ vers: true });
    const nv = hv.kandidaten.map((k) => k.naam);
    toets('vr: "hallo??" na een getoond eindje = geen kandidaat (vulbericht)', nv.indexOf('Proef Een') < 0 && hv.telling.vulsel >= 1, hv.telling);
    const zes = hv.kandidaten.find((k) => k.naam === 'Proef Zes');
    toets('vr: nieuwe vraag na een "geen" = kandidaat met eerder', !!zes && zes.eerder && zes.eerder.oordeel === 'geen' && /alleen een nieuwe, andere vraag/.test(zes.eerder.let_op), zes);
    toets('vr: al beoordeelde chats niet opnieuw (Signal, Teams)', ['Sig Proef', 'Collega Proef'].every((n) => nv.indexOf(n) < 0), nv);
    const zeven = hv.kandidaten.find((k) => k.naam === 'Proef Zeven');
    toets('vr: na Davids antwoord is "dank je" een nieuwe kandidaat zonder eerder (nieuwe periode)', !!zeven && !zeven.eerder && zeven.staart.length === 1, zeven);
    await o.oordeel({ oordelen: [{ id: zes.id, oordeel: 'eindje', zin: 'of je volgende week dienst wilt ruilen' }, { id: zeven.id, oordeel: 'geen' }] });
    const k2 = await o.kaartStap();
    const kv = kaarten[1];
    toets('vr: kaart met de doorgeschoven 6e (Proef Negen) + de nieuwe vraag; getoonde nooit terug', kv && kv.stappen.length === 2 && kv.stappen.some((s) => /^Proef Negen/.test(s)) && kv.titel === 'Nog beantwoorden — 2 berichten wachten op je antwoord' && !kv.stappen.some((s) => /Sig Proef|Proef Een|Proef Zeven/.test(s)), kv && kv.stappen);
    toets('vr: kaart van do dicht', status.some((s) => s.p_sleutel === 'eindjes-2026-11-26' && s.p_naar === 'vervallen'));
    // ── zaterdag: Teams-eindje wacht tot maandag; zet faalt = niets getoond ──
    sql(`insert into ${S}.open_eindjes (kanaal, chat, anker_ts, vraag_ts, laatste_ts, naam, oordeel, zin) values ('teams', '19:zat_x@unq.gbl.spaces', 0, ${NU + 86400}, ${NU + 86400}, 'Weekend Teams', 'eindje', 'of je het weekendrooster ziet'),
      ('whatsapp-nl', '31600000099@c.us', 0, ${NU + 86400}, ${NU + 86400}, 'Za Proef', 'eindje', 'of je komt eten')`);
    nu = NU + 2 * 86400; datum = '2026-11-28';
    faalGetoond = true; let viel = false; try { await o.kaartStap(); } catch (e) { viel = true; }
    const zaVoor = sql(`select getoond_op from ${S}.open_eindjes where naam = 'Za Proef'`)[0].getoond_op;
    const k3 = await o.kaartStap();
    const zaNa = sql(`select getoond_op, kaart from ${S}.open_eindjes where naam = 'Za Proef'`)[0];
    toets('za: kaart gezet maar markeren faalt → volgende tik herstelt getoond_op via de kaart (Codex r1 MOET 4)', viel && zaVoor === null && k3.al_gedaan === true && zaNa.getoond_op !== null && zaNa.kaart === 'eindjes-2026-11-28', { viel, zaVoor, k3, zaNa });
    toets('za: Teams-eindje niet op de kaart (alleen werkdagen), WhatsApp wel', kaarten[2] && kaarten[2].stappen.length === 1 && /Za Proef/.test(kaarten[2].stappen[0]), kaarten[2] && kaarten[2].stappen);
    nu = NU + 4 * 86400; datum = '2026-11-30'; zetFout = true;
    let gegooid = false; try { await o.kaartStap(); } catch (e) { gegooid = true; }
    const tgn = sql(`select getoond_op from ${S}.open_eindjes where naam = 'Weekend Teams'`)[0];
    toets('ma: zet faalt → gooit, Teams-eindje niet als getoond gemarkeerd', gegooid && tgn.getoond_op === null, tgn);
    zetFout = false; staat.kaart = null;
    const k4 = await o.kaartStap();
    toets('ma: weekend-Teams telt maandag mee', kaarten[3] && kaarten[3].stappen.length === 1 && /Weekend Teams \(Teams/.test(kaarten[3].stappen[0]), kaarten[3] && kaarten[3].stappen);
    // ── storingen: één box-rij per storing; geen haal = één box-rij ──
    const boxVoor = box.length;
    tgFout = 'sessie is ingetrokken'; waFout = 'http 500';
    await o.haal({ vers: true }); await o.haal({ vers: true });
    const tgRijen = box.slice(boxVoor).filter((b) => /Telegram niet te lezen/.test(b)).length, waRijen = box.slice(boxVoor).filter((b) => /WhatsApp niet te lezen/.test(b)).length;
    toets('storing: Telegram en WhatsApp elk één box-rij, ook na twee nachten', tgRijen === 1 && waRijen === 1, box.slice(boxVoor).map((b) => b.slice(0, 90)));
    toets('storing: box-rij zonder nummers', !box.some((b) => /\d{8,}/.test(b.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, ''))));
    tgFout = null; waFout = null; await o.haal({ vers: true });
    toets('storing: weer leesbaar = vergeten', !(staat.storingen || {}).telegram && !(staat.storingen || {})['whatsapp-nl']);
    nu = NU + 5 * 86400; datum = '2026-12-01'; staat.haal = { datum: '2026-11-30' };
    const bv = box.length; await o.kaartStap();
    nu = NU + 6 * 86400; datum = '2026-12-02'; await o.kaartStap();
    toets('geen haal (za, zo, ma, di, wo): één box-rij voor de hele storing, niet elke ochtend', box.filter((b) => /nachtronde haalde niets op/.test(b)).length === 1 && box.slice(bv).filter((b) => /nachtronde/.test(b)).length === 0, box.map((b) => b.slice(0, 90)));
    // ── wissen na 30 dagen ──
    sql(`update ${S}.open_eindjes set beoordeeld_op = now() - interval '31 days' where naam = 'Proef Zes'`);
    staat.kaart = null; nu = NU + 7 * 86400; datum = '2026-12-03'; await o.kaartStap();
    toets('wissen: rij ouder dan 30 dagen weg', Number(sql(`select count(*) n from ${S}.open_eindjes where naam = 'Proef Zes'`)[0].n) === 0);
    // ── kaart-tekst puur: 1 bericht ──
    const een = M.kaart('2026-11-26', [{ kanaal: 'signal', naam: 'X'.repeat(120), vraag_ts: NU - 30 * H, zin: 'y'.repeat(200), link: null }], 0, NU);
    toets('kaart puur: 1 bericht, lange naam/zin begrensd, terugval "Open Signal › …"', een.titel === 'Nog beantwoorden — 1 bericht wacht op je antwoord' && een.stappen[0].length <= 400 && /Open Signal › X+\.$/.test(een.stappen[0]) && een.herkomst.links.length === 0, een.stappen[0]);
  } catch (e) { fouten++; console.log('ROOD  uitzondering ' + (e && e.stack || e)); }
  finally { try { sql(`drop schema ${S} cascade`); } catch (e) { console.log('LET OP: schema ' + S + ' niet weg: ' + e.message); fouten++; } }
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
