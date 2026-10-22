#!/usr/bin/env bash
# Toetst de POT-rekening in de bankluis (wv786, 22-10-2026; bouwplan § 9e): de ABN-rekening van de POT-constructie (salariskosten)
# staat in de transactiedatabase met eigenaar POT, herkend op een zakelijke IBAN (meta, alleen machinekamer), en blijft buiten elk
# privé-overzicht (saldo zonder rekening, zoek, maand, intern, abonnementen, vaste-lasten, stroom), buiten het taalmodel (aiOpen) en
# wordt ingedeeld op vaste regels (salarissen, loonheffing, pensioen, overig, ontvangsten). Ook: een machinekamer-noodgreep 'extern'
# wordt POT, een eigenaar van David wint, een privéregel van David raakt geen POT-post, een AI-groep met dezelfde sleutel ook niet;
# pot-overzicht zonder namen; bank-lezer.js (CLI, zonder netwerk) verbergt de POT in saldo en toont hem met rekening=POT.
# Raakt de pod, de kluis, de bank en /opt/data/bank niet. Gebruik: bash test/bank-pot.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankpot-'));
const BD = path.join(W, 'bank');
const A = require(path.resolve('bank-archief.js'));
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const dagTerug = (n) => { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const IB = { gez: 'NL00ABNA0123456789', pot: 'NL99ABNA0987654321', prive: 'NL11BUNQ0000000001' };
const REK = {
  gez: { uid: 'u1', bank: 'ABN AMRO', naam: 'D Schaap', iban: IB.gez, sessie: 's2' },
  pot: { uid: 'u2', bank: 'ABN AMRO', naam: 'D Schaap', iban: IB.pot, sessie: 's2' },
  prive: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Privé', soort: 'lopend', iban: IB.prive, status: 'ACTIVE' },
};
// Namen van nagebootste medewerkers: mogen in geen enkel privé-overzicht, pot-overzicht of AI-groep opduiken
const MW = ['Jansen Medewerker', 'Pietersen Medewerker'];
const p = (id, datum, bedrag, tegen, omschr, extra) => Object.assign({ id: id, datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: omschr || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: { id: id } }, extra || {});
const bevatNaam = (o) => { const t = JSON.stringify(o); return MW.some((n) => t.indexOf(n) >= 0) || t.indexOf(IB.pot) >= 0; };

(function () {
  try {
    const a = A.open(BD);
    A.rekeningenSync(a, REK);
    const eig = (r) => a.db.prepare('SELECT eigenaar, eigenaar_herkomst h, gezamenlijk g FROM rekeningen WHERE rek = ?').get(r);
    toets('zonder zakelijke IBAN: een tweede ABN-rekening start op samen (oude gedrag)', eig('pot').eigenaar === 'samen', eig('pot'));

    // ── zakelijke IBAN zetten ──
    let fout = null;
    try { A.zakelijkZet(a, { [IB.pot]: 'Holding' }); } catch (e) { fout = e.message; }
    toets('zakelijkZet weigert een andere entiteit dan POT', !!fout && fout.indexOf(IB.pot) < 0, fout);
    fout = null;
    try { A.zakelijkZet(a, { 'geen-iban': 'POT' }); } catch (e) { fout = e.message; }
    toets('zakelijkZet weigert iets dat geen IBAN is', !!fout, fout);
    A.zakelijkZet(a, { [IB.pot.toLowerCase().replace(/(.{4})/g, '$1 ')]: 'POT' });   // met spaties en kleine letters
    A.rekeningenSync(a, REK);
    toets('zakelijke IBAN (genormaliseerd) → eigenaar POT, niet gezamenlijk', eig('pot').eigenaar === 'POT' && eig('pot').g === 0, eig('pot'));
    toets('gezamenlijke rekening blijft samen', eig('gez').eigenaar === 'samen' && eig('gez').g === 1, eig('gez'));
    toets('stand: aantal zakelijke IBANs, geen IBAN in de uitvoer', A.stand(a).zakelijke_ibans === 1 && !bevatNaam(A.stand(a)), A.stand(a).zakelijke_ibans);

    // noodgreep van de machinekamer vóór de uitrol (extern) wordt POT; een eigenaar van David wint
    A.corrigeer(a, { rek: 'pot', eigenaar: 'extern', door: 'machinekamer' });
    toets('noodgreep: machinekamer zet extern', eig('pot').eigenaar === 'extern', eig('pot'));
    A.rekeningenSync(a, REK);
    toets('na synchronisatie: extern van de machinekamer wordt POT', eig('pot').eigenaar === 'POT' && eig('pot').h === 'systeem', eig('pot'));

    // ── posten ──
    const d1 = dagTerug(40), d2 = dagTerug(10);
    A.bij(a, 'pot', [
      p('e:s1', d1, -2100.55, MW[0], 'Salaris september 2026'),
      p('e:s2', d1, -1850.10, MW[1], 'netto loon sep'),
      p('e:s3', d2, -2100.55, MW[0], 'Salaris oktober 2026'),
      p('e:s4', d2, -1850.10, MW[1], 'netto loon okt'),
      p('e:l1', d1, -1200, 'Belasting dienst', 'Betalingskenmerk 1234 5678 9012 3456'),
      p('e:pf', d1, -640.40, 'Pension Fund Zorg en Welzi jn', 'premie 2026-09'),
      p('e:nn', d1, -35, 'Nationale Nederlanden', 'premie verzuim'),
      p('e:v1', d1, 9000, 'Huisartsenpraktijk Groenhouten', 'voorschot Q4'),
    ], null);
    // privé: een overboeking naar de POT, en een gewone uitgave bij dezelfde naam als een medewerker
    A.bij(a, 'prive', [
      p('b:1', d2, -500, 'D Schaap', 'aanvulling POT', { tegen_iban: IB.pot }),
      p('b:2', d2, -25, MW[0], 'Salaris september 2026'),   // zelfde groepsleutel als e:s1 (richting, tegenpartij, omschrijving)
      p('b:3', d2, -12.5, 'Bakker', 'brood'),
    ], null);
    A.bij(a, 'gez', [p('g:1', d1, -80, 'Energie BV', 'termijn'), p('g:2', d2, -80, 'Energie BV', 'termijn')], null);
    A.verrijk(a);
    const v = (nr) => a.db.prepare('SELECT v.* FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE t.rek = ? AND t.bron_id = ?').get(nr[0], nr[1]);
    const cat = (id) => (v(['pot', id]) || {}).categorie;
    toets('indeling: salaris en netto loon → salarissen', cat('e:s1') === 'salarissen' && cat('e:s2') === 'salarissen', [cat('e:s1'), cat('e:s2')]);
    toets('indeling: Belasting dienst (met spatie) → loonheffing', cat('e:l1') === 'loonheffing', cat('e:l1'));
    toets('indeling: Pension Fund Zorg en Welzi jn → pensioen', cat('e:pf') === 'pensioen', cat('e:pf'));
    toets('indeling: verzekering → overig; voorschot → ontvangsten', cat('e:nn') === 'overig' && cat('e:v1') === 'ontvangsten', [cat('e:nn'), cat('e:v1')]);
    toets('indeling: herkomst regel, eigenaar POT, type uitgave/inkomst', ['e:s1', 'e:v1'].every((i) => v(['pot', i]).herkomst === 'regel' && v(['pot', i]).eigenaar === 'POT') &&
      v(['pot', 'e:s1']).type === 'uitgave' && v(['pot', 'e:v1']).type === 'inkomst', v(['pot', 'e:s1']));
    toets('overboeking privé → POT is geen intern (uitgave), wel ingedeeld (overig / POT)', v(['prive', 'b:1']).type === 'uitgave' && v(['prive', 'b:1']).categorie === 'overig' &&
      v(['prive', 'b:1']).subcategorie === 'POT', v(['prive', 'b:1']));
    // Fable wv786 #3: factuur van de salarisadministratie is geen loon; "incl pensioenpremie" in een salarisomschrijving is loon
    toets('regels: factuur salarisadministratie → overig', A.potCategorie({ bedrag: -95, tegenpartij: 'Salarisverwerker X', omschrijving: 'factuur salarisadministratie sep' }) === 'overig', null);
    toets('regels: salaris incl pensioenpremie → salarissen', A.potCategorie({ bedrag: -2000, tegenpartij: MW[0], omschrijving: 'Salaris oktober incl pensioenpremie' }) === 'salarissen', null);
    toets('regels: PGGM zonder omschrijving → pensioen; teruggave → ontvangsten', A.potCategorie({ bedrag: -10, tegenpartij: 'P G G M', omschrijving: null }) === 'pensioen' &&
      A.potCategorie({ bedrag: 50, tegenpartij: 'Belastingdienst', omschrijving: 'teruggaaf' }) === 'ontvangsten', null);

    // ── taalmodel: geen POT-post, ook niet de overboeking ernaartoe ──
    const open = A.aiOpen(a, 500);
    const potGroepen = open.groepen.filter((g) => /salaris|loon|pension|belasting|voorschot|aanvulling pot/i.test((g.tegenpartij || '') + ' ' + (g.omschrijving || '')) && !/bakker/i.test(g.tegenpartij || ''));
    // b:2 (privé, zelfde naam) mag wel naar de AI: die staat op Davids eigen rekening
    // open: Energie (gezamenlijk), Bakker en de privépost b:2 (€ 25); niets van de POT-rekening en niet de overboeking ernaartoe
    toets('aiOpen: geen groep van de POT-rekening of de overboeking ernaartoe', open.groepen.length === 3 && potGroepen.length === 1 && potGroepen[0].bedrag_typisch === 25 &&
      open.open_posten === 4 && !open.groepen.some((x) => /aanvulling|voorschot|belasting|pension/i.test((x.tegenpartij || '') + ' ' + (x.omschrijving || ''))), open.groepen);
    // AI zet een oordeel voor de privégroep met dezelfde sleutel als e:s1: de POT-post houdt de regelindeling
    const g = open.groepen.find((x) => /salaris/i.test(x.omschrijving || ''));
    A.aiZet(a, [{ g: g.g, type: 'uitgave', categorie: 'cadeaus en goede doelen', omschrijving: 'gift' }], 'test', [g.g]);
    toets('AI-groep met dezelfde sleutel raakt de POT-post niet', cat('e:s1') === 'salarissen' && v(['prive', 'b:2']).categorie === 'cadeaus en goede doelen', [cat('e:s1'), v(['prive', 'b:2']).categorie]);
    // privéregel van David (zonder rekening) raakt geen POT-post
    const nrB2 = a.db.prepare("SELECT nr FROM transacties WHERE bron_id = 'b:2'").get().nr;
    A.corrigeer(a, { nr: nrB2, categorie: 'kinderen' });
    toets('privéregel van David voor dezelfde tegenpartij raakt de POT-post niet', cat('e:s3') === 'salarissen' && v(['prive', 'b:2']).categorie === 'kinderen', [cat('e:s3'), v(['prive', 'b:2']).categorie]);
    // David corrigeert een POT-post: wint, regel alleen op de POT-rekening
    const nrNN = a.db.prepare("SELECT nr FROM transacties WHERE bron_id = 'e:nn'").get().nr;
    A.corrigeer(a, { nr: nrNN, categorie: 'verzekeringen' });
    toets('correctie van David op een POT-post wint', cat('e:nn') === 'verzekeringen' && v(['pot', 'e:nn']).herkomst === 'david', v(['pot', 'e:nn']));

    // Fable wv786 #7: een AI-groep die alleen op POT-posten past (gat vóór de uitrol) wordt bij verrijk gewist; een gedeelde niet
    const gPot = A.groepSleutel({ bedrag: -1850.10, tegenpartij: MW[1], omschrijving: 'netto loon okt' });
    a.db.prepare("INSERT INTO ai_groepen (sleutel, type, categorie, ai_omschrijving, model, gemaakt) VALUES (?, 'uitgave', 'overig', 'Salaris Pietersen', 'oud', '2026-10-22')").run(gPot);
    a.db.prepare("INSERT INTO ai_overslaan (sleutel, pogingen, laatst) VALUES (?, 1, '2026-10-22')").run(A.groepSleutel({ bedrag: -2100.55, tegenpartij: MW[0], omschrijving: 'Salaris oktober 2026' }));
    const vw = A.verrijk(a);
    toets('AI-groep die alleen op POT-posten past: gewist bij verrijk (ook de overslaanregel)', vw.ai_pot_gewist === 1 && !a.db.prepare('SELECT 1 FROM ai_groepen WHERE sleutel = ?').get(gPot) &&
      a.db.prepare('SELECT count(*) n FROM ai_overslaan').get().n === 0, vw);
    toets('de gedeelde AI-groep (privé b:2) blijft staan', !!a.db.prepare('SELECT 1 FROM ai_groepen WHERE sleutel = ?').get(g.g), null);

    // ── privé-overzichten ──
    const zoek = A.zoek(a, {});
    toets('zoek zonder rekening: geen POT-post, geen medewerkersnaam van de POT', !zoek.posten.some((x) => x.rekening === 'D Schaap' && x.eigenaar === 'POT') &&
      zoek.posten.every((x) => x.eigenaar !== 'POT') && /POT-rekening/.test(zoek.let_op_extern || ''), zoek.posten.map((x) => [x.rekening, x.eigenaar]));
    const m1 = A.maand(a, { maand: d1.slice(0, 7) }), m2 = A.maand(a, { maand: d2.slice(0, 7) });
    toets('maand: geen salarissen, loonheffing of voorschot in de privétotalen', !m1.per_categorie.concat(m2.per_categorie).some((c) => ['salarissen', 'loonheffing', 'pensioen', 'ontvangsten'].indexOf(c.categorie) >= 0) &&
      m1.totaal_in === 0, [m1.per_categorie, m1.totaal_in]);
    toets('intern: geen overboeking naar de POT', A.internLijst(a, {}).aantal === 0, A.internLijst(a, {}));
    const ab = A.abonnementen(a, { alle: true });
    toets('abonnementen: geen salarisreeks van de POT', ab.abonnementen.every((x) => x.rekening !== 'D Schaap' || x.naam === 'Energie BV' || /energie/i.test(x.naam || '')) && !bevatNaam(ab), ab.abonnementen.map((x) => x.naam));
    let vl = null; fout = null;
    try { vl = A.vasteLasten(a, {}); } catch (e) { fout = e.message; }
    toets('vaste-lasten zonder rekening: werkt nog (één vaste-lastenrekening), zonder POT', !fout && vl && !bevatNaam(vl), fout || vl.rekening);
    fout = null;
    try { A.vasteLasten(a, { rek: 'pot' }); } catch (e) { fout = e.message; }
    toets('vaste-lasten rekening=POT: geweigerd', /POT/.test(fout || ''), fout);
    const st = A.stroom(a, { maand: d2.slice(0, 7) });
    toets('stroom: geen POT-posten als bron', !bevatNaam(st), st);

    // ── expliciet: alleen met rekening=POT of eigenaar=POT ──
    const zp = A.zoek(a, { rek: 'pot' });
    toets('zoek rekening=POT: alle 8 posten met let_op POT', zp.aantal === 8 && /personeelsgegevens/.test(zp.let_op_extern || ''), [zp.aantal, zp.let_op_extern]);
    const ze = A.zoek(a, { eigenaar: 'POT' });
    toets('zoek eigenaar=POT: alleen de POT-posten', ze.aantal === 8 && ze.posten.every((x) => x.eigenaar === 'POT'), ze.aantal);

    // ── POT-overzicht zonder namen ──
    const po = A.potOverzicht(a, { van: dagTerug(60) });
    const tot = po.totaal_per_categorie;
    toets('pot-overzicht: totalen per categorie', tot.salarissen === -7901.3 && tot.loonheffing === -1200 && tot.pensioen === -640.4 && tot.ontvangsten === 9000 && tot.verzekeringen === -35, tot);
    toets('pot-overzicht: geen namen, omschrijvingen of IBAN', !bevatNaam(po) && JSON.stringify(po).indexOf('Salaris september') < 0 && JSON.stringify(po).indexOf('Belasting dienst') < 0, po);
    toets('pot-overzicht: per maand', po.maanden.length >= 1 && po.maanden.every((x) => x.aantal > 0), po.maanden);

    // ── David wint van de zakelijke IBAN ──
    A.corrigeer(a, { rek: 'pot', eigenaar: 'POT' });
    A.rekeningenSync(a, REK);
    toets('eigenaar=pot (kleine letters) van David wordt POT en blijft staan', eig('pot').eigenaar === 'POT' && eig('pot').h === 'david', eig('pot'));
    a.db.close();

    // ── bank-lezer.js (CLI, zonder netwerk, zonder sleutel) ──
    const nu = new Date().toISOString();
    fs.writeFileSync(path.join(BD, 'stand.json'), JSON.stringify({ versie: 1, wachtend: {}, sessies: { s2: { bank: 'ABN AMRO', status: 'AUTHORIZED', geldig_tot: '2027-04-18T00:00:00Z', rekeningen: ['gez', 'pot'] } },
      rekeningen: { gez: Object.assign({}, REK.gez, { label: 'Vaste lasten' }), pot: REK.pot }, tellers: { dag: '', per: {} },
      opgehaald: { gez: { saldo: nu, transacties: nu, vanaf: dagTerug(400) }, pot: { saldo: nu, transacties: nu, vanaf: dagTerug(400) } } }), { mode: 0o600 });
    const c = new DatabaseSync(path.join(BD, 'cache.sqlite'));
    c.exec('CREATE TABLE IF NOT EXISTS tx (rek TEXT NOT NULL, id TEXT NOT NULL, datum TEXT, valutadatum TEXT, bedrag REAL, valuta TEXT, tegenpartij TEXT, omschrijving TEXT, status TEXT, saldo_na REAL, mcc TEXT, opgehaald TEXT, tegen_iban TEXT, PRIMARY KEY (rek, id));' +
      'CREATE TABLE IF NOT EXISTS saldo (rek TEXT PRIMARY KEY, json TEXT, opgehaald TEXT);');
    c.prepare('INSERT INTO saldo VALUES (?, ?, ?)').run('gez', JSON.stringify({ geboekt: 1000, valuta: 'EUR' }), nu);
    c.prepare('INSERT INTO saldo VALUES (?, ?, ?)').run('pot', JSON.stringify({ geboekt: 23456.78, valuta: 'EUR' }), nu);
    c.prepare("INSERT INTO tx VALUES ('pot', 'e:s3', ?, ?, -2100.55, 'EUR', ?, 'Salaris oktober 2026', 'geboekt', NULL, NULL, ?, NULL)").run(d2, d2, MW[0], nu);
    c.close();
    const cli = (args, stdin) => {
      const r = spawnSync(process.execPath, ['--no-warnings', 'bank-lezer.js'].concat(args), { input: stdin || '', env: { PATH: process.env.PATH, BANK_DIR: BD, TZ: 'Europe/Amsterdam', HOME: W }, encoding: 'utf8', timeout: 30000 });
      try { return JSON.parse(r.stdout); } catch (e) { return { _ruw: r.stdout, _err: r.stderr }; }
    };
    const s0 = cli(['saldo']);
    toets('CLI saldo zonder rekening: geen POT, wel de hint', s0.ok && s0.saldi.length === 1 && s0.saldi[0].geboekt === 1000 && /POT/.test(s0.let_op_pot || '') && JSON.stringify(s0).indexOf('23456') < 0, s0);
    const s1 = cli(['saldo', 'POT']);
    toets('CLI saldo POT: alleen de POT-rekening, met let_op_pot', s1.ok && s1.saldi.length === 1 && s1.saldi[0].geboekt === 23456.78 && s1.saldi[0].pot === true && /personeelsgegevens/.test(s1.saldi[0].let_op_pot || ''), s1);
    const r0 = cli(['rekeningen']);
    const rp = (r0.rekeningen || []).find((x) => x.iban === IB.pot), rg = (r0.rekeningen || []).find((x) => x.iban === IB.gez);
    toets('CLI rekeningen: POT met eigenaar POT, gezamenlijke met samen', !!rp && rp.eigenaar === 'POT' && rp.pot === true && !rp.gezamenlijk && !rp.extern && rg && rg.eigenaar === 'samen', r0);
    const t0 = cli(['transacties', 'POT']);
    toets('CLI transacties POT: uit de cache met let_op_pot, geen let_op_gezamenlijk', t0.ok && t0.aantal === 1 && /personeelsgegevens/.test(t0.let_op_pot || '') && !t0.let_op_gezamenlijk && !t0.let_op_extern, t0);
    const z0 = cli(['zoek']);
    toets('CLI zoek zonder rekening: geen POT-post', z0.ok && !bevatNaam(z0.posten.filter((x) => x.eigenaar === 'POT')) && z0.posten.every((x) => x.eigenaar !== 'POT'), z0.posten && z0.posten.length);
    const pz = cli(['pot', '--van', dagTerug(60)]);
    toets('CLI pot: overzicht zonder namen', pz.ok && pz.totaal_per_categorie && pz.totaal_per_categorie.salarissen < 0 && !bevatNaam(pz), pz);
    const zk = cli(['zakelijk'], JSON.stringify({ ibans: { [IB.pot]: 'POT' } }));
    toets('CLI zakelijk: zet de lijst, geeft geen IBAN terug', zk.ok && zk.zakelijk === 1 && zk.pot_rekeningen === 1 && JSON.stringify(zk).indexOf(IB.pot) < 0, zk);
    const zf = cli(['zakelijk'], JSON.stringify({ ibans: { [IB.pot]: 'Holding' } }));
    toets('CLI zakelijk: andere entiteit geweigerd, zonder IBAN in de fout', zf.ok === false && JSON.stringify(zf).indexOf(IB.pot) < 0, zf);

    // ── server.js: pot via /smal/bank, zakelijk niet ──
    const srv = fs.readFileSync('server.js', 'utf8');
    const lijst = (srv.match(/const BANK_OPDRACHTEN = \[([\s\S]*?)\];/) || [])[1] || '';
    toets("server: 'pot' wel in BANK_OPDRACHTEN, 'zakelijk' en 'masker' niet", /'pot'/.test(lijst) && !/'zakelijk'/.test(lijst) && !/'masker'/.test(lijst), lijst);
    // PayPal-laag: POT-posten nooit als PayPal-post
    const pp = fs.readFileSync('paypal-bewijs.js', 'utf8');
    toets('paypal-bewijs.js sluit extern en POT uit (koppelen en posten zonder bewijs)', (pp.match(/'extern', 'pot'/g) || []).length >= 2, null);
  } catch (e) { fouten++; console.log('ROOD  uitzondering: ' + (e && e.stack || e)); }
  finally { try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {} }
  console.log((fouten ? 'ROOD' : 'GROEN') + ': ' + goed + ' goed, ' + fouten + ' fout');
  process.exit(fouten ? 1 : 0);
})();
JS
