#!/usr/bin/env bash
# Toetst te-lezen.js (wv2245, Te lezen in Voor jou; bouwplan "Eén meldingenkanaal" § 4.8) en de koppeling in server.js (route, slot,
# release-lijst). Toetst: alleen de wortelklus van een opdracht van David (geen vervolgstap, bundel, afwerkrij, eigen klus, onbekende
# herkomst), agentrapport-david in het hoofdkanaal, antwoord op Davids beurt alleen zolang hij het gesprek daarna niet zag, nooit een
# bericht met een vraag (ook niet bewaard zolang het in Moet iets staat), Telegram en zoekvragen niet, vaste plek zonder hoofdkanaal,
# 7 dagen vanzelf en 14 dagen bewaard, afvinken en terugzetten, bewaren alleen van een bestaand bericht jonger dan 16 dagen, het getal
# (nieuw = niet afgevinkt en nog niet in beeld), begrenzing (40 + meer), staat zonder rommel. Alle gegevens verzonnen.
# Geen netwerk, geen bestanden. Gebruik: bash test/te-lezen.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const T = require('./te-lezen.js');
const fs = require('fs');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const NU = Date.parse('2026-11-02T12:00:00Z'), U = 3600000, D = 24 * U;
const iso = (ms) => new Date(ms).toISOString();
let n = 0;
const job = () => (0x1000000000000000 + (++n) * 7919).toString(16).slice(0, 16).padStart(16, 'a');
const rap = (agent, t, x) => Object.assign({ t: iso(t), job_id: job(), soort: 'socev', bron: 'agentrapport', klasse: 'normaal', tekst: '', antwoord: '🤖 Agentrapport — proefklus\n\nGedaan: iets gebouwd.', ok: true, agent_job: agent, meld: 'archief' }, x || {});
const beurt = (soort, t, x) => Object.assign({ t: iso(t), getypt: iso(t - 60000), job_id: job(), soort: soort, tekst: soort === 'knop' ? '✓ Ja — op de vraag: Mag ik de proefknop bouwen?' : 'Kun je de proef nakijken?', antwoord: 'Gedaan, de proef staat klaar.', ok: true }, x || {});
const vraag = (x) => !!x.vraag_hash || /VRAAG AAN DAVID: \S/.test(String(x.antwoord || ''));
const A1 = 'a1a1a1a1a1a1a1a1', A2 = 'a2a2a2a2a2a2a2a2', A3 = 'a3a3a3a3a3a3a3a3', A4 = 'a4a4a4a4a4a4a4a4', A5 = 'a5a5a5a5a5a5a5a5', A6 = 'a6a6a6a6a6a6a6a6';
const klussen = {
  [A1]: { rij: 10, herkomst: 'david', soort: 'gewoon', diepte: 0, titel: 'Een proefknop in de app voor David.', wortel: 10 },
  [A2]: { rij: 11, herkomst: 'david', soort: 'gewoon', diepte: 1, titel: 'Vervolgstap van de proef.', wortel: 10 },
  [A3]: { rij: 12, herkomst: 'eigen', soort: 'gewoon', diepte: 0, titel: 'Eigen meetklus.', wortel: 12 },
  [A4]: { rij: 13, herkomst: 'david', soort: 'bundel', diepte: 0, titel: 'Nacontrolebundel.', wortel: 13 },
  [A5]: { rij: 14, herkomst: 'david', soort: 'afwerk', diepte: 0, titel: 'Afwerkrij managerronde.', wortel: 14 },
};
// ── 1. welke agentrapporten ──
const r1 = rap(A1, NU - 2 * U), r2 = rap(A2, NU - U), r3 = rap(A3, NU - U), r4 = rap(A4, NU - U), r5 = rap(A5, NU - U), r6 = rap(A6, NU - U);
const r7 = rap(A1, NU - 30 * 60000, { antwoord: '🤖 Agentrapport — proefklus\n\nVRAAG AAN DAVID: Mag ik doorgaan?' });
const per1 = { hoofd: [], machinekamer: [r1, r2, r3, r4, r5, r6, r7] };
const u1 = T.uit({ per: per1, klussen, staat: {}, tabs: {}, vraag, nu: NU });
toets('1a alleen het rapport van de wortelklus van David komt erin (geen vervolg, eigen, bundel, afwerk, onbekend, vraag)', u1.punten.length === 1 && u1.punten[0].job_id === r1.job_id, u1.punten.map((p) => p.job_id));
toets('1b titel = de zin voor David uit de werkvoorraad; soort klus; sleutel t:<job>', u1.punten[0].titel === 'Een proefknop in de app voor David.' && u1.punten[0].soort === 'klus' && u1.punten[0].sleutel === 't:' + r1.job_id);
const u1n = T.uit({ per: per1, klussen: null, staat: {}, tabs: {}, vraag, nu: NU });
toets('1c herkomst onleesbaar: geen klus-punten (niet raden)', u1n.punten.length === 0);
toets('1d klusTelt eist rij = wortel', !T.klusTelt({ rij: 9, herkomst: 'david', soort: 'gewoon', diepte: 0, wortel: 8 }) && T.klusTelt(klussen[A1]));
toets('1e klusJobs: alleen agentrapporten in het venster, uniek', JSON.stringify(T.klusJobs({ machinekamer: [r1, r7, rap(A6, NU - 8 * D), beurt('knop', NU)] }, NU)) === JSON.stringify([A1]));
// ── 2. hoofdkanaal en vaste plek ──
const h1 = Object.assign(rap(null, NU - U), { bron: 'agentrapport-david', agent_job: undefined, meld: 'antwoord' });
const hb = Object.assign(rap(null, NU - U), { bron: 'briefing', agent_job: undefined });
const u2 = T.uit({ per: { hoofd: [h1, hb], machinekamer: [] }, klussen, staat: {}, tabs: {}, vraag, nu: NU });
toets('2a hoofdkanaal: agentrapport-david wel, briefing niet', u2.punten.length === 1 && u2.punten[0].job_id === h1.job_id && u2.punten[0].kanaal === 'hoofd');
const u2v = T.uit({ per: { hoofd: [h1], machinekamer: [r1] }, klussen, staat: {}, tabs: {}, vraag, vast: true, nu: NU });
toets('2b wv3446: ook met de oude vaste-plekvlag hoofdkanaal en machinekamer', u2v.punten.length === 2 && u2v.punten.some((p) => p.kanaal === 'hoofd'));
// ── 3. antwoorden op Davids eigen beurt ──
const b1 = beurt('knop', NU - 2 * U, { bestanden: ['Proefplan.md'] }), b2 = beurt('bericht', NU - 3 * U), b3 = beurt('bericht', NU - U, { vraag_hash: 'abcd1234', antwoord: 'Klaar.\n\nVRAAG AAN DAVID: Zal ik het aanzetten?' });
const b4 = beurt('telegram', NU - U), b5 = beurt('zoek', NU - U), b6 = beurt('bericht', NU - U, { antwoord: '' });
const per3 = { hoofd: [b2], machinekamer: [b1, b3, b4, b5, b6] };
const u3 = T.uit({ per: per3, klussen, staat: {}, tabs: { machinekamer: iso(NU - 3 * U), hoofd: iso(NU - 4 * U) }, vraag, nu: NU });
toets('3a antwoord op knop (met bestand) en getypt bericht dat David nog niet zag: erin, met zijn eigen tekst (van)', u3.punten.length === 2 && u3.punten.every((p) => p.soort === 'antwoord') && u3.punten.find((p) => p.job_id === b1.job_id).knop === true && /proefknop/.test(u3.punten.find((p) => p.job_id === b1.job_id).van), u3.punten);
toets('3b met een vraag, Telegram, zoekvraag of leeg antwoord: niet', !u3.punten.some((p) => [b3, b4, b5, b6].some((b) => b.job_id === p.job_id)));
const u3z = T.uit({ per: per3, klussen, staat: {}, tabs: { machinekamer: iso(NU - U), hoofd: iso(NU - 2 * U) }, vraag, nu: NU });
toets('3c David zag het gesprek ná het antwoord: vanzelf weg (niet afgevinkt)', u3z.punten.length === 0 && u3z.afgevinkt.length === 0);
const u3g = T.uit({ per: per3, klussen, staat: {}, tabs: { machinekamer: iso(NU - 2.5 * U) }, vraag, nu: NU });
toets('3d gezien vóór het antwoord telt niet als gezien (t = afloop van de beurt)', u3g.punten.some((p) => p.job_id === b1.job_id));
// ── 4. vensters ──
const oud = rap(A1, NU - 7 * D - 60000), oudb = beurt('bericht', NU - 10 * D);
const st4 = { sinds: iso(NU - 30 * D), gezien: {}, bewaard: { [oudb.job_id]: { kanaal: 'machinekamer', op: iso(NU - 2 * D) } } };
const u4 = T.uit({ per: { hoofd: [], machinekamer: [oud, oudb] }, klussen, staat: st4, tabs: {}, vraag, nu: NU });
toets('4a vanzelf na 7 dagen uit de lijst; bewaard blijft (bericht 10 dagen oud, 2 dagen geleden bewaard)', u4.punten.length === 1 && u4.punten[0].job_id === oudb.job_id && u4.punten[0].soort === 'bewaard' && u4.punten[0].bewaard === true);
const st4b = { gezien: {}, bewaard: { [oudb.job_id]: { kanaal: 'machinekamer', op: iso(NU - 14 * D - 60000) } } };
toets('4b bewaard vervalt 14 dagen na het bewaren', T.uit({ per: { machinekamer: [oudb] }, klussen, staat: st4b, tabs: {}, vraag, nu: NU }).punten.length === 0);
const st4c = { gezien: {}, bewaard: { [oudb.job_id]: { kanaal: 'hoofd', op: iso(NU - D) } } };
toets('4c bewaard in een ander gesprek telt niet', T.uit({ per: { machinekamer: [oudb] }, klussen, staat: st4c, tabs: {}, vraag, nu: NU }).punten.length === 0);
// ── 5. bewaard bericht met een vraag ──
const bv = beurt('bericht', NU - U, { vraag_hash: 'ffff0000', antwoord: 'VRAAG AAN DAVID: Mag het?' });
const st5 = { bewaard: { [bv.job_id]: { kanaal: 'machinekamer', op: iso(NU - 1000) } } };
toets('5a bewaard en nog in Moet iets: niet dubbel', T.uit({ per: { machinekamer: [bv] }, klussen, staat: st5, tabs: {}, vraag, moet: new Set([bv.job_id]), nu: NU }).punten.length === 0);
toets('5b bewaard en niet (meer) in Moet iets: wel (David koos het zelf)', T.uit({ per: { machinekamer: [bv] }, klussen, staat: st5, tabs: {}, vraag, moet: new Set(), nu: NU }).punten.length === 1);
// ── 6. afvinken, terugzetten, bewaren ──
let z = T.zet({}, { job_id: r1.job_id, kanaal: 'machinekamer', actie: 'gezien' }, NU);
toets('6a afvinken', !z.fout && z.staat.gezien[r1.job_id] === iso(NU));
const u6 = T.uit({ per: per1, klussen, staat: z.staat, tabs: {}, vraag, nu: NU });
toets('6b afgevinkt: uit de lijst, in Afgevinkt (met tijd)', u6.punten.length === 0 && u6.afgevinkt.length === 1 && u6.afgevinkt[0].gezien === iso(NU) && u6.ongezien === 0);
z = T.zet(z.staat, { job_id: r1.job_id, kanaal: 'machinekamer', actie: 'terug' }, NU + 1000);
toets('6c terugzetten: weer in de lijst', !z.fout && !z.staat.gezien[r1.job_id] && T.uit({ per: per1, klussen, staat: z.staat, tabs: {}, vraag, nu: NU }).punten.length === 1);
toets('6d bewaren van een bericht dat niet in het gesprek staat: geweigerd', T.zet({}, { job_id: r3.job_id, kanaal: 'machinekamer', actie: 'bewaar' }, NU, null).fout === 'dat bericht staat niet (meer) in dit gesprek');
toets('6e bewaren van een bericht ouder dan 16 dagen: geweigerd', /te oud/.test(T.zet({}, { job_id: r3.job_id, kanaal: 'machinekamer', actie: 'bewaar' }, NU, NU - 17 * D).fout || ''));
z = T.zet({ gezien: { [r3.job_id]: iso(NU - U) } }, { job_id: r3.job_id, kanaal: 'machinekamer', actie: 'bewaar' }, NU, NU - U);
toets('6f bewaren: in de staat, en een eerder vinkje gaat eraf (weer te lezen)', !z.fout && z.staat.bewaard[r3.job_id].kanaal === 'machinekamer' && !z.staat.gezien[r3.job_id]);
const u6g = T.uit({ per: per1, klussen, staat: z.staat, tabs: {}, vraag, nu: NU });
toets('6g een bewaarde eigen klus staat erin als bewaard', u6g.punten.some((p) => p.job_id === r3.job_id && p.soort === 'bewaard'));
z = T.zet(z.staat, { job_id: r3.job_id, kanaal: 'machinekamer', actie: 'niet-bewaren' }, NU);
toets('6g2 de lijst noemt de bewaarde ids (voor ★ in het gesprek); wv3446: ook met de oude vaste-plekvlag die uit het hoofdkanaal', JSON.stringify(u6g.bewaard) === JSON.stringify([r3.job_id])
  && JSON.stringify(T.uit({ per: {}, klussen, staat: { bewaard: { [r3.job_id]: { kanaal: 'hoofd', op: iso(NU) } } }, tabs: {}, vraag, vast: true, nu: NU }).bewaard) === JSON.stringify([r3.job_id]));
toets('6h niet meer bewaren', !z.fout && !z.staat.bewaard[r3.job_id]);
toets('6i ongeldig: job, actie, gesprek', T.zet({}, { job_id: 'x', kanaal: 'machinekamer', actie: 'gezien' }, NU).fout === 'ongeldig bericht' && T.zet({}, { job_id: r1.job_id, kanaal: 'machinekamer', actie: 'wis' }, NU).fout === 'onbekende actie' && T.zet({}, { job_id: r1.job_id, kanaal: 'cijfer-meester', actie: 'gezien' }, NU).fout === 'onbekend gesprek');
// ── 7. het getal ──
const per7 = { hoofd: [], machinekamer: [r1, b1] };
const u7 = T.uit({ per: per7, klussen, staat: {}, tabs: {}, inBeeld: { ['t:' + r1.job_id]: iso(NU - 1000) }, vraag, nu: NU });
toets('7a nieuw = niet afgevinkt en nog niet in beeld; ongezien = alle niet afgevinkte', u7.ongezien === 2 && u7.nieuw === 1, { ongezien: u7.ongezien, nieuw: u7.nieuw });
// ── 8. begrenzing, volgorde, inhoud ──
const veel = []; for (let i = 0; i < 45; i++) veel.push(beurt('bericht', NU - (i + 1) * 60000));
const u8 = T.uit({ per: { machinekamer: veel }, klussen, staat: {}, tabs: {}, vraag, nu: NU });
toets('8a hooguit 40, nieuwste eerst, meer = de rest', u8.punten.length === 40 && u8.meer === 5 && u8.ongezien === 45 && u8.punten[0].job_id === veel[0].job_id);
const lang = beurt('bericht', NU - U, { antwoord: 'x'.repeat(7000) });
const u8b = T.uit({ per: { machinekamer: [lang] }, klussen, staat: {}, tabs: {}, vraag, nu: NU });
toets('8b bericht begrensd op 6000 tekens, afgekapt gemeld', u8b.punten[0].afgekapt === true && u8b.punten[0].bericht.length < 6010);
const dubbel = Object.assign({}, r1);
toets('8c zelfde job twee keer in het log: één punt', T.uit({ per: { machinekamer: [r1, dubbel] }, klussen, staat: {}, tabs: {}, vraag, nu: NU }).punten.length === 1);
toets('8d bericht in de toekomst telt niet', T.uit({ per: { machinekamer: [rap(A1, NU + 5 * 60000)] }, klussen, staat: {}, tabs: {}, vraag, nu: NU }).punten.length === 0);
// ── 9. staat ──
const s9 = T.staatNorm({ gezien: { kapot: iso(NU), [r1.job_id]: iso(NU - 16 * D), [r2.job_id]: 'geen tijd', [r3.job_id]: iso(NU - D) }, bewaard: { [r4.job_id]: { kanaal: 'x', op: iso(NU) }, [r5.job_id]: { kanaal: 'hoofd', op: iso(NU) } }, rommel: 1 }, NU);
toets('9a staat: alleen geldige ids en tijden, oud afgevinkt (> 15 dagen) weg, onbekend gesprek weg, geen extra velden', JSON.stringify(Object.keys(s9.gezien)) === JSON.stringify([r3.job_id]) && JSON.stringify(Object.keys(s9.bewaard)) === JSON.stringify([r5.job_id]) && Object.keys(s9).join() === 'versie,sinds,gezien,bewaard');
toets('9b kapotte invoer: lege staat, sinds 24 uur terug', JSON.stringify(T.staatNorm(null, NU)) === JSON.stringify({ versie: 1, sinds: iso(NU - D), gezien: {}, bewaard: {} }));
// ── 11. startpunt ──
const s11 = T.staatNorm({}, NU), r11a = rap(A1, NU - 2 * D), r11b = rap(A1, NU - 2 * U), b11 = beurt('bericht', NU - 3 * D);
const st11 = Object.assign({}, s11, { bewaard: { [b11.job_id]: { kanaal: 'machinekamer', op: iso(NU - U) } } });
const u11 = T.uit({ per: { machinekamer: [r11a, r11b, b11] }, klussen, staat: st11, tabs: {}, vraag, nu: NU });
toets('11a eerste keer: vanzelf alleen de laatste 24 uur (geen week achterstand); bewaard van daarvoor wel', u11.punten.length === 2 && u11.punten.some((p) => p.job_id === r11b.job_id) && u11.punten.some((p) => p.job_id === b11.job_id && p.soort === 'bewaard'));
toets('11b sinds blijft staan (niet elke keer 24 uur terug)', T.staatNorm(s11, NU + 5 * D).sinds === s11.sinds);
// ── 12. wv3093: antwoord op een knopdruk (David 14-11: "die hoef ik niet te zien in de 'Voor jou' lijst") ──
const k1 = beurt('knop', NU - U), k2 = beurt('knop', NU - U, { tekst: '✗ Nee — op de vraag: Mag ik de proefknop bouwen?' });
const k3 = beurt('knop', NU - U, { tekst: '✎ Anders: liever morgen — bij de kaart "Proefknop"' });
const k4 = beurt('knop', NU - U, { ok: false, fout: 'proeffout', antwoord: 'Er ging iets mis met de proef.' });
const k5 = beurt('knop', NU - U, { bestanden: ['Proefplan.md'] }), k6 = beurt('knop', NU - U, { bestanden: [] });
const k7 = beurt('knop', NU - U, { vraag_hash: 'beefbeef', antwoord: 'Begrepen.\n\nVRAAG AAN DAVID: Zal ik ook de tweede proef doen?' });
const g12 = beurt('bericht', NU - U);
const u12 = T.uit({ per: { hoofd: [k1, k5], machinekamer: [k2, k3, k4, k6, k7, g12] }, klussen, staat: {}, tabs: {}, vraag, nu: NU });
const in12 = (b) => u12.punten.some((p) => p.job_id === b.job_id);
toets('12a knopantwoord Ja/Nee/Anders (ook lege bestandenlijst): niet in Te lezen, in beide gesprekken', !in12(k1) && !in12(k2) && !in12(k3) && !in12(k6), u12.punten.map((p) => p.job_id));
toets('12b knopantwoord dat mislukte of een bestand meegeeft: wel', in12(k4) && in12(k5) && u12.punten.find((p) => p.job_id === k4.job_id).ok === false);
toets('12c knopantwoord met een nieuwe vraag: niet in Te lezen (staat in Moet iets), getypt bericht blijft', !in12(k7) && in12(g12) && vraag(k7));
toets('12d het getal telt de knopantwoorden niet mee', u12.ongezien === 3 && u12.nieuw === 3, { ongezien: u12.ongezien, nieuw: u12.nieuw });
const st12 = { sinds: iso(NU - D), gezien: {}, bewaard: { [k1.job_id]: { kanaal: 'hoofd', op: iso(NU - 1000) } } };
toets('12e een knopantwoord dat David zelf bewaarde: wel (als bewaard)', T.uit({ per: { hoofd: [k1] }, klussen, staat: st12, tabs: {}, vraag, nu: NU }).punten.some((p) => p.job_id === k1.job_id && p.soort === 'bewaard'));
toets('12f knopTelt alleen op velden: ok false of een niet-lege bestandenlijst', T.knopTelt({ ok: false }) && T.knopTelt({ bestanden: ['a'] }) && !T.knopTelt({ ok: true, bestanden: [] }) && !T.knopTelt({ antwoord: 'storing: VRAAG' }));
// ── 13. wv3678 (nr 130, 2C30): "Alles gezien" / Zet terug in één aanroep ──
const v13 = [{ job_id: r1.job_id, kanaal: 'machinekamer' }, { job_id: g12.job_id, kanaal: 'machinekamer' }, { job_id: k1.job_id, kanaal: 'hoofd' }];
const z13 = T.zetVeel({ sinds: iso(NU - D) }, v13, 'gezien', NU);
toets('13a drie berichten in één keer op gezien', !z13.fout && v13.every((i) => z13.staat.gezien[i.job_id] === iso(NU)), z13);
const z13b = T.zetVeel(z13.staat, v13.slice(0, 2), 'terug', NU + 1000);
toets('13b Zet terug van twee: die twee weer te lezen, de derde blijft gezien', !z13b.fout && !z13b.staat.gezien[r1.job_id] && !z13b.staat.gezien[g12.job_id] && !!z13b.staat.gezien[k1.job_id]);
const z13c = T.zetVeel(z13.staat, [v13[0], { job_id: 'niet-geldig', kanaal: 'hoofd' }], 'terug', NU);
toets('13c één ongeldig item: hele aanroep geweigerd', z13c.fout === 'ongeldig bericht' && !z13c.staat);
toets('13d bewaar/niet-bewaren in bulk: geweigerd; leeg en meer dan VEEL_MAX: geweigerd', T.zetVeel({}, v13, 'bewaar', NU).fout === 'onbekende actie'
  && T.zetVeel({}, [], 'gezien', NU).fout === 'ongeldig bericht' && T.zetVeel({}, Array.from({ length: T.VEEL_MAX + 1 }, () => v13[0]), 'gezien', NU).fout === 'ongeldig bericht');
toets('13e verkeerd gesprek in bulk: geweigerd', T.zetVeel({}, [{ job_id: r1.job_id, kanaal: 'socev' }], 'gezien', NU).fout === 'onbekend gesprek');
// ── 14. wv4175 (3C08): de uitkomst van Socevs achtergrondklus; (3C75) het merkje van de slotregel ──
const SJ = 'b1b1b1b1b1b1b1b1', SJ2 = 'b2b2b2b2b2b2b2b2';
const sp = (t, x) => Object.assign({ t: iso(t), job_id: job(), soort: 'socev', bron: 'socev-spreekt', klasse: 'normaal', tekst: '', antwoord: 'De vergelijking van de drie proefopties is klaar: optie B is het goedkoopst.', ok: true, agent_job: SJ, meld: 'antwoord' }, x || {});
const s1 = sp(NU - 3 * U), s2 = sp(NU - U, { agent_job: undefined }), s3 = sp(NU - 2 * U, { agent_job: SJ2, antwoord: 'Ik heb de proefreis uitgezocht.\n\nVRAAG AAN DAVID: Zal ik optie B vastleggen?' });
const g14 = beurt('bericht', NU - 10 * 60000), a14 = rap(null, NU - 20 * 60000, { bron: 'agentrapport-david', antwoord: '🤖 Agentrapport — proef\n\nUitkomst: iets gebouwd.\n\nVoor David: Niets doen' });
const u14 = T.uit({ per: { hoofd: [s1, s2, s3, g14, a14], machinekamer: [] }, klussen: {}, staat: { sinds: iso(NU - D) }, tabs: {}, vraag, nu: NU, mkKlussen: false, momentSinds: NU - 4 * U });
const p14 = (x) => u14.punten.find((p) => p.job_id === x.job_id);
toets('14a socev-spreekt mét klusnummer: punt soort klus met socev true, ook na het vaste moment', !!p14(s1) && p14(s1).soort === 'klus' && p14(s1).socev === true, u14.punten);
toets('14b socev-spreekt zonder klusnummer (Mail volgen) en met een vraag: niet in Te lezen', !p14(s2) && !p14(s3));
toets('14c Socev-uitkomst staat bovenaan, ook boven een nieuwer gewoon antwoord', u14.punten[0].job_id === s1.job_id && !!p14(g14) && !p14(g14).socev, u14.punten.map((p) => p.job_id));
toets('14d een gewoon antwoord en een agentrapport-david na het vaste moment: zoals vroeger (antwoord wel, rapport wacht)', p14(g14).soort === 'antwoord' && !p14(a14));
toets('14e socevKlus alleen in het hoofdkanaal', T.socevKlus(s1, 'hoofd') && !T.socevKlus(s1, 'machinekamer') && !T.socevKlus(s2, 'hoofd'));
// slotregel
const sl = T.slotregel;
toets('14f slotregel: de vier woorden', sl('x\nVoor David: Niets doen').merk === 'niets' && sl('Voor David: Wacht: op de uitrol').merk === 'wacht'
  && sl('Voor David: Mislukt: de toets bleef rood').merk === 'mislukt' && sl('**Voor David:** Probeer het: Financiën › Overzicht.').merk === 'probeer');
toets('14g Probeer het geeft de plek (geschoond, zonder link en punt)', sl('- Voor David: Probeer het — [Tripper](https://x.y) › Reis.').plek === 'Tripper › Reis' && sl('Voor David: Probeer het').plek === null);
toets('14h vrije tekst, geen regel, of alleen in een codeblok: geen merkje', sl('Voor David: kijk er eens naar') === null && sl('Uitkomst: klaar.') === null
  && sl('Uitkomst: x\n```\nVoor David: Mislukt\n```') === null && sl('') === null && sl(null) === null);
toets('14i de laatste regel telt', sl('Voor David: Mislukt: eerste poging\n\nherstel gedaan\n\nVoor David: Probeer het: Socev › Te lezen').merk === 'probeer'
  && sl('Voor David: Niets doen\nVoor David: zie hierboven') === null);
toets('14j lange plek ingekort tot 80 tekens', Array.from(sl('Voor David: Probeer het: ' + 'Financiën › '.repeat(20)).plek).length <= 80);
// merk op het punt en de volgorde
const m1 = sp(NU - 5 * U, { agent_job: 'c1c1c1c1c1c1c1c1', slot: { merk: 'probeer', plek: 'Financiën › Overzicht' } });
const m2 = rap(null, NU - 6 * U, { bron: 'agentrapport-david', antwoord: '🤖 Agentrapport — proef\n\nUitkomst: toets rood.\n\nVoor David: Mislukt: de toets bleef rood' });
const m3 = rap(null, NU - 30 * 60000, { bron: 'agentrapport-david', antwoord: '🤖 Agentrapport — proef\n\nUitkomst: klaar.\n\nVoor David: Niets doen' });
const m4 = rap(null, NU - 40 * 60000, { bron: 'agentrapport-david', antwoord: '🤖 Agentrapport — oud\n\nGedaan: iets gebouwd.' });
const m5 = sp(NU - 7 * U, { agent_job: 'c5c5c5c5c5c5c5c5', antwoord: 'Socev vertelt het in eigen woorden.' });
const m6 = beurt('bericht', NU - 50 * 60000, { ok: false, antwoord: 'De beurt liep vast.' });
const per14 = { hoofd: [m1, m2, m3, m4, m5, m6], machinekamer: [] };
const slotVan = (j) => (j === 'c5c5c5c5c5c5c5c5' ? { merk: 'wacht', plek: 'genegeerd' } : null);
const u14b = T.uit({ per: per14, klussen: {}, staat: { sinds: iso(NU - D) }, tabs: {}, vraag, nu: NU, mkKlussen: false, slotVan });
const q = (x) => u14b.punten.find((p) => p.job_id === x.job_id) || {};
toets('14k merk uit de logregel (slot), uit de rapporttekst, uit het register (slotVan, plek alleen bij probeer)', q(m1).merk === 'probeer' && q(m1).plek === 'Financiën › Overzicht'
  && q(m2).merk === 'mislukt' && q(m3).merk === 'niets' && q(m5).merk === 'wacht' && q(m5).plek === null, u14b.punten.map((p) => [p.job_id, p.merk, p.plek]));
toets('14l rapport zonder slotregel (oud): geen merkje, zoals vroeger', q(m4).merk === null && q(m4).soort === 'klus' && q(m4).socev === false);
toets('14m mislukte beurt: merk mislukt (ook zonder slotregel)', q(m6).merk === 'mislukt' && q(m6).ok === false);
const volg = u14b.punten.map((p) => p.job_id);
const rang0 = [m1, m2, m5, m6].map((x) => x.job_id), rang1 = [m3, m4].map((x) => x.job_id);
toets('14n Mislukt, Probeer het en Socev bovenaan (op tijd), daarna de rest (op tijd)', volg.slice(0, 4).every((j) => rang0.includes(j)) && volg.slice(4).every((j) => rang1.includes(j))
  && volg[0] === m6.job_id && volg[4] === m3.job_id, volg);
toets('14o een onzinnig slot uit het log telt niet', T.slotNorm({ merk: 'altijd' }) === null && T.slotNorm(null) === null && T.slotNorm({ merk: 'niets', plek: 'x' }).plek === null);
const S14 = fs.readFileSync('server.js', 'utf8');
toets('14p server.js: socev-spreekt mét klusnummer = antwoord (seintje); eindregel vraagt "Voor David:"; slot in register en logregel', /bron === 'socev-spreekt' && \/\^\[a-f0-9\]\{16\}\$\/\.test\(String\(agentJob/.test(S14)
  && /Eindig je eindrapport met één regel "Voor David: …"/.test(S14) && /entry\.slot = ok === false/.test(S14) && /regel\.slot = agentsReg\[agentJob\]\.slot/.test(S14) && /slotVan: function \(job\)/.test(S14));
// meldSoort zelf (statisch uit server.js)
{
  const vm = require('vm');
  const i = S14.indexOf('function meldSoort('), e = S14.indexOf('\n}\n', i) + 3, ms = S14.indexOf('const MELD_SOORT = {'), me = S14.indexOf('\n', ms);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(S14.slice(ms, me) + '\n' + S14.slice(i, e) + '\nthis.f = meldSoort;', ctx);
  const f = ctx.f;
  toets('14q meldSoort: socev-spreekt met klus = antwoord; zonder klus of in de machinekamer = archief; vraag gaat voor; stil blijft stil',
    f('hoofd', 'socev-spreekt', 'normaal', false, false, undefined, SJ) === 'antwoord' && f('hoofd', 'socev-spreekt', 'normaal', false, false, undefined, undefined) === 'archief'
    && f('machinekamer', 'socev-spreekt', 'normaal', false, false, undefined, SJ) === 'archief' && f('hoofd', 'socev-spreekt', 'normaal', true, false, undefined, SJ) === 'vraag'
    && f('hoofd', 'socev-spreekt', 'stil', false, false, undefined, SJ) === 'archief' && f('hoofd', 'socev-spreekt', 'normaal', false, false, undefined, 'geen-klus') === 'archief');
}
// ── 10. koppeling in server.js en de release ──
const S = fs.readFileSync('server.js', 'utf8'), UR = fs.readFileSync('uitrol.sh', 'utf8');
toets('10a route POST /app/te-lezen bestaat en glijdt (David die leest), niet in APP_SLOT_VRIJ', /route === 'POST \/app\/te-lezen'\) return appTeLezenZet/.test(S) && /'POST \/app\/aanwezig', 'POST \/app\/te-lezen'\]\)/.test(S) && !/APP_SLOT_VRIJ = new Set\(\[[^\]]*te-lezen/.test(S));
toets('10b te_lezen alleen in /app/voor-jou/kanaal, en de t:-sleutels gaan mee in gezien', /teLezen\.punten\.forEach\(function \(p\) \{ sleutels\.push\(p\.sleutel\); \}\)/.test(S) && /te_lezen: teLezen/.test(S));
toets('10c te-lezen.js staat in RELEASE_OPTIONEEL', /RELEASE_OPTIONEEL="[^"]*\bte-lezen\.js\b/.test(UR));
toets('10d module laadt geen netwerk-, proces- of bestandsmodule', !/require\(/.test(fs.readFileSync('te-lezen.js', 'utf8').replace(/^\s*\/\/.*$/gm, '')));
toets('10e wv3446: hoofdkanaal niet meer geweigerd per apparaat', !/te-lezen vast hoofd/.test(S) && !/appAfscherm/.test(S));
toets('10f wv3678: bulkpad staat in appTeLezenZet (alleen tekstcontrole; het gedrag toetst UI-blok wv3678)', /Array\.isArray\(d\.items\) && typeof teLezenMod\.zetVeel === 'function'/.test(S) && /teLezenMod\.zetVeel\(staatV, d\.items, actieV/.test(S));
console.log(`\nte-lezen: ${goed} groen, ${fouten} rood`);
process.exit(fouten ? 1 : 0);
JS
