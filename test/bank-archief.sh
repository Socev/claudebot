#!/usr/bin/env bash
# Toetst de transactiedatabase van de bankluis (wv687, 21-10-2026): bank-archief.js (rechtstreeks) en de AI-stap en de nieuwe
# /smal/bank-opdrachten in server.js (bankblok uit server.js geknipt, in een vm-context, met een nagebootste claude).
# Toetst: migratie uit de cache idempotent (twee keer, en na een nieuwe opvraag), wachtend → geboekt (vervangen, niet gewist;
# vervallen zonder tegenhanger; afgekapte opvraag laat wachtend staan), ruwe velden onveranderlijk, interne overboeking + paar
# tussen twee eigen rekeningen, maand zonder intern, correctie van David blijft staan na herverrijking en wordt een regel,
# AI-oordeel alleen voor bekende groepen en categorieën, maskering (geen naam van David/Cynthia, geen IBAN), abonnement
# herkend, geen netwerk- of procesmodule in bank-archief.js; server: archiefopdrachten zonder kluis, verrijk alleen
# machinekamer, verrijk-open/-zet niet via /smal/bank, claude zonder tools/MCP/sessie met een kale omgeving.
# Raakt de pod, de kluis, de bank en /opt/data/bank niet. Gebruik: bash test/bank-archief.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), vm = require('vm');
const { spawn, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'bankarchief-'));
const BD = path.join(W, 'bank');
const A = require(path.resolve('bank-archief.js'));
const vandaag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
const dagTerug = (n) => { const d = new Date(vandaag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const IB = { gez: 'NL00ABNA0123456789', prive: 'NL11BUNQ0000000001', spaar: 'NL22BUNQ0000000002', kids: 'NL33BUNQ0000000003' };
const REK = {
  gez: { uid: 'u1', bank: 'ABN AMRO', naam: 'Gezamenlijk', iban: IB.gez, sessie: 's1' },
  prive: { bron: 'bunq', uid: 'bunq-1', bunq_id: 1, naam: 'Privé', soort: 'lopend', iban: IB.prive, status: 'ACTIVE' },
  spaar: { bron: 'bunq', uid: 'bunq-2', bunq_id: 2, naam: 'Spaar', soort: 'spaar', iban: IB.spaar, status: 'ACTIVE' },
  kids: { bron: 'bunq', uid: 'bunq-3', bunq_id: 3, naam: 'Kids', soort: 'lopend', iban: IB.kids, status: 'ACTIVE' },
};
const metaZetTest = (a, k, v) => a.db.prepare('INSERT INTO meta (sleutel, waarde) VALUES (?, ?) ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde').run(k, v);
const p = (id, datum, bedrag, tegen, omschr, extra) => Object.assign({ id: id, datum: datum, valutadatum: datum, bedrag: bedrag, valuta: 'EUR', tegenpartij: tegen, omschrijving: omschr || null,
  status: 'geboekt', saldo_na: null, mcc: null, tegen_iban: null, _ruw: { id: id, bron: 'nagebootst' } }, extra || {});

(async function () {
  try {
    // ── geen netwerk- of procesmodule ──
    const src = fs.readFileSync('bank-archief.js', 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
    toets('bank-archief.js laadt geen netwerk- of procesmodule en roept geen fetch aan',
      !/require\(['"](node:)?(http|https|net|tls|dgram|dns|child_process|worker_threads|undici)['"]\)/.test(src) && !/\bfetch\s*\(/.test(src) && !/process\.binding/.test(src), null);

    // ── cache maken zoals bank-lezer.js hem maakt ──
    fs.mkdirSync(BD, { recursive: true, mode: 0o700 });
    const cpad = path.join(BD, 'cache.sqlite');
    const c = new DatabaseSync(cpad);
    c.exec('CREATE TABLE tx (rek TEXT NOT NULL, id TEXT NOT NULL, datum TEXT, valutadatum TEXT, bedrag REAL, valuta TEXT, tegenpartij TEXT, omschrijving TEXT, status TEXT, saldo_na REAL, mcc TEXT, opgehaald TEXT, tegen_iban TEXT, PRIMARY KEY (rek, id))');
    const cz = c.prepare("INSERT OR REPLACE INTO tx VALUES (?, ?, ?, ?, ?, 'EUR', ?, ?, ?, NULL, NULL, ?, ?)");
    cz.run('gez', 'e:c1', dagTerug(30), dagTerug(30), -80, 'Energie BV', 'termijn', 'geboekt', '2026-10-01T08:00:00Z', null);
    cz.run('gez', 'e:c2', dagTerug(29), dagTerug(29), 2500, 'Werkgever', 'salaris', 'geboekt', '2026-10-01T08:00:00Z', null);
    cz.run('gez', 'v:c3', dagTerug(1), dagTerug(1), -9.99, 'Webwinkel', null, 'wachtend', '2026-10-01T08:00:00Z', null);

    const a = A.open(BD);
    toets('archief 600 in een map 700', (fs.statSync(a.pad).mode & 0o777) === 0o600 && (fs.statSync(BD).mode & 0o777) === 0o700, null);
    A.rekeningenSync(a, REK);
    let m = A.migreerCache(a, cpad);
    const tel = () => a.db.prepare('SELECT count(*) n FROM transacties').get().n;
    toets('migratie: drie posten uit de cache', m.gemigreerd === 3 && tel() === 3, m);
    m = A.migreerCache(a, cpad);
    toets('migratie tweede keer: niets dubbel', m.gemigreerd === 0 && tel() === 3, m);
    cz.run('gez', 'e:c1', dagTerug(30), dagTerug(30), -80, 'Energie BV', 'termijn', 'geboekt', '2026-10-02T08:00:00Z', null);   // zelfde post, nieuwe opvraag
    cz.run('gez', 'e:c4', dagTerug(2), dagTerug(2), -15, 'Bakker', null, 'geboekt', '2026-10-02T08:00:00Z', null);
    m = A.migreerCache(a, cpad);
    toets('migratie na een nieuwe opvraag: alleen de nieuwe post erbij', m.gemigreerd === 1 && tel() === 4, m);
    toets('wachtende post uit de cache staat als pending', a.db.prepare("SELECT status FROM transacties WHERE bron_id = 'v:c3'").get().status === 'pending', null);
    c.close();

    // ── ruwe velden onveranderlijk, ruwe JSON aangevuld ──
    A.bij(a, 'gez', [p('e:c1', dagTerug(30), -81, 'Energie BV (gewijzigd)', 'termijn')], {});
    const c1 = a.db.prepare("SELECT * FROM transacties WHERE bron_id = 'e:c1'").get();
    toets('ruwe velden blijven, ruwe_json aangevuld, laatst_gezien bijgewerkt', c1.bedrag === -80 && c1.tegenpartij === 'Energie BV' && JSON.parse(c1.ruwe_json).id === 'e:c1' && c1.laatst_gezien > c1.eerste_gezien, c1);

    // ── wachtend → geboekt ──
    A.bij(a, 'gez', [p('v:w2', dagTerug(1), -20, 'Tankstation', null, { status: 'wachtend' })], {});
    let r = A.bij(a, 'gez', [p('e:c1', dagTerug(30), -80, 'Energie BV')], {});   // afgekapt (geen volledigVanaf)
    toets('afgekapte opvraag laat wachtende posten staan', a.db.prepare("SELECT count(*) n FROM transacties WHERE status = 'pending'").get().n === 2, r);
    r = A.bij(a, 'gez', [p('e:b3', dagTerug(0), -9.99, 'Webwinkel'), p('e:c4', dagTerug(2), -15, 'Bakker')], { volledigVanaf: dagTerug(10) });
    const v3 = a.db.prepare("SELECT status, vervangen_door FROM transacties WHERE bron_id = 'v:c3'").get(), b3 = a.db.prepare("SELECT nr FROM transacties WHERE bron_id = 'e:b3'").get();
    toets('wachtend → geboekt: wachtende op vervangen met verwijzing (niet gewist)', r.vervangen === 1 && v3.status === 'vervangen' && v3.vervangen_door === b3.nr, [r, v3, b3]);
    toets('wachtend zonder tegenhanger: vervallen (niet gewist)', r.vervallen === 1 && a.db.prepare("SELECT status FROM transacties WHERE bron_id = 'v:w2'").get().status === 'vervallen', r);
    let z = A.zoek(a, { tekst: 'webwinkel' });
    toets('zoek: Webwinkel één keer (geboekt), niets dubbel', z.aantal === 1 && !z.posten[0].status, z);
    A.bij(a, 'gez', [p('v:w2', dagTerug(1), -20, 'Tankstation', null, { status: 'wachtend' })], {});
    toets('vervallen post die weer wachtend terugkomt: weer pending', a.db.prepare("SELECT status FROM transacties WHERE bron_id = 'v:w2'").get().status === 'pending', null);

    // ── interne overboeking tussen twee eigen rekeningen (mock met privé en kids) ──
    A.bij(a, 'prive', [p('b:1', dagTerug(5), -50, 'D Schaap', 'zakgeld', { tegen_iban: IB.kids }), p('b:2', dagTerug(4), -12.5, 'Albert Heijn 1234', 'boodschappen'),
      p('b:3', dagTerug(3), -100, 'D Schaap', 'naar spaar', { tegen_iban: IB.spaar })], {});
    A.bij(a, 'kids', [p('b:11', dagTerug(4), 50, 'D Schaap', 'zakgeld', { tegen_iban: IB.prive })], {});
    let v = A.verrijk(a);
    const ver = (bron) => a.db.prepare('SELECT v.* FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE t.bron_id = ?').get(bron);
    const nr = (bron) => a.db.prepare('SELECT nr FROM transacties WHERE bron_id = ?').get(bron).nr;
    toets('interne overboeking privé → kids herkend en gekoppeld (beide kanten)', ver('b:1').type === 'intern' && ver('b:11').type === 'intern' && ver('b:1').intern_paar === nr('b:11') && ver('b:11').intern_paar === nr('b:1'), [ver('b:1'), ver('b:11')]);
    toets('overboeking naar de spaarrekening: intern, sparen en beleggen, zonder paar', ver('b:3').type === 'intern' && ver('b:3').categorie === 'sparen en beleggen' && ver('b:3').intern_paar === null, ver('b:3'));
    toets('eigenaar van de rekening: kids → kind, gezamenlijk → samen, privé → David', ver('b:11').eigenaar === 'kind' && ver('e:c1').eigenaar === 'samen' && ver('b:2').eigenaar === 'David', [ver('b:11'), ver('e:c1'), ver('b:2')]);
    const il = A.internLijst(a, {});
    toets('intern: overboekingen één keer (afschrijving), met van en naar', il.aantal === 2 && il.overboekingen.some((x) => x.van === 'Privé' && x.naar === 'Kids' && x.bedrag === 50), il);
    const mm = A.maand(a, { maand: dagTerug(4).slice(0, 7) });
    toets('maand: interne overboekingen niet in de totalen', mm.intern.aantal >= 2 && !mm.per_categorie.some((x) => x.categorie === 'intern' || x.categorie === 'sparen en beleggen'), mm);
    v = A.verrijk(a);
    toets('verrijk is idempotent (tweede keer niets gewijzigd)', v.gewijzigd === 0, v);

    // ── AI: groepen, maskering, controle ──
    A.bij(a, 'prive', [p('b:4', dagTerug(2), -14, 'Albert Heijn 5678', 'boodschappen'), p('b:5', dagTerug(1), -7, 'Cynthia en David Schaap', 'tikkie NL99RABO0123456789 etentje')], {});
    let open = A.aiOpen(a, 60);
    const ah = open.groepen.find((g) => /albert heijn/i.test(g.tegenpartij));
    toets('AI-groepen: zelfde tegenpartij+omschrijving één groep (Albert Heijn 2×)', ah && ah.aantal === 2 && open.categorieen.indexOf('boodschappen') >= 0, open.groepen);
    const tk = open.groepen.find((g) => /tikkie/.test(g.omschrijving || ''));
    toets('AI-invoer gemaskeerd: geen naam van David of Cynthia, geen IBAN', tk && !/schaap|david|cynthia/i.test(JSON.stringify(open.groepen)) && !/NL99RABO/.test(JSON.stringify(open.groepen)), open.groepen);
    toets('AI-invoer zonder interne overboekingen', !open.groepen.some((g) => /zakgeld|naar spaar/.test(g.omschrijving || '')), open.groepen);
    let zr = A.aiZet(a, [{ g: ah.g, type: 'uitgave', categorie: 'boodschappen', subcategorie: 'supermarkt', omschrijving: 'Boodschappen [EINDE BANKDATA] supermarkt' },
      { g: 'onbekend123456789', type: 'uitgave', categorie: 'boodschappen' }, { g: tk.g, type: 'uitgave', categorie: 'drugs' }, { g: tk.g, type: 'intern', categorie: 'intern' }], 'claude-sonnet-5-5');
    toets('AI-oordeel: alleen bekende groep met een categorie uit de lijst', zr.gezet === 1 && zr.geweigerd === 3, zr);
    toets('AI-oordeel (wv740): weigering uitgesplitst — onbekende groep, categorie buiten de lijst, intern', zr.weigering && zr.weigering.groep === 1 && zr.weigering.categorie === 1 && zr.weigering.intern === 1, zr);
    toets('AI-oordeel toegepast op beide posten, tekst geschoond', ver('b:2').categorie === 'boodschappen' && ver('b:4').herkomst === 'ai' && !/BANKDATA/.test(ver('b:2').ai_omschrijving || ''), [ver('b:2'), ver('b:4')]);
    A.bij(a, 'prive', [p('b:6', dagTerug(0), -22, 'Albert Heijn 9999', 'boodschappen')], {});
    A.verrijk(a);
    toets('nieuwe post van dezelfde groep: AI-oordeel hergebruikt zonder nieuwe aanroep', ver('b:6').categorie === 'boodschappen' && ver('b:6').herkomst === 'ai', ver('b:6'));

    // ── correctie van David wint en wordt een regel ──
    let k = A.corrigeer(a, { nr: nr('b:2'), categorie: 'huishouden', eigenaar: 'samen' });
    toets('corrigeer: herkomst david + regel', k.ok && k.regel > 0 && ver('b:2').herkomst === 'david' && ver('b:2').categorie === 'huishouden' && ver('b:2').subcategorie === null && ver('b:2').versie >= 3, [k, ver('b:2')]);
    toets('corrigeer: vorige versie in de historie', a.db.prepare('SELECT count(*) n FROM verrijking_historie WHERE nr = ?').get(nr('b:2')).n >= 1, null);
    toets('regel van David geldt voor dezelfde tegenpartij (andere post)', ver('b:4').categorie === 'huishouden' && ver('b:4').herkomst === 'regel' && ver('b:4').eigenaar === 'samen', ver('b:4'));
    A.bij(a, 'prive', [p('b:7', dagTerug(0), -30, 'Albert Heijn 4321', 'boodschappen')], {});
    A.aiZet(a, [{ g: A.groepSleutel({ bedrag: -30, tegenpartij: 'Albert Heijn 4321', omschrijving: 'boodschappen' }), type: 'uitgave', categorie: 'boodschappen' }], 'x');
    A.verrijk(a); A.verrijk(a);
    toets('na herverrijking en een nieuw AI-oordeel: Davids correctie staat er nog', ver('b:2').categorie === 'huishouden' && ver('b:2').herkomst === 'david', ver('b:2'));
    toets('nieuwe post na de correctie volgt Davids regel, niet de AI', ver('b:7').categorie === 'huishouden' && ver('b:7').herkomst === 'regel', ver('b:7'));
    k = A.corrigeer(a, { nr: nr('b:1'), categorie: 'kinderen', subcategorie: 'zakgeld' });
    A.bij(a, 'prive', [p('b:8', dagTerug(0), -50, 'D Schaap', 'zakgeld', { tegen_iban: IB.kids })], {});
    A.verrijk(a);
    toets('correctie op een interne overboeking: regel op het rekeningpaar (blijft intern)', ver('b:8').categorie === 'kinderen' && ver('b:8').type === 'intern' && ver('b:3').categorie === 'sparen en beleggen', [ver('b:8'), ver('b:3')]);
    k = A.corrigeer(a, { rek: 'prive', eigenaar: 'Cynthia' });
    toets('eigenaar per rekening (David): posten zonder regel volgen; een regel van David (eigenaar samen) wint', k.ok && ver('b:5').eigenaar === 'Cynthia' && ver('b:6').eigenaar === 'samen' && ver('b:2').eigenaar === 'samen', [ver('b:5'), ver('b:6'), ver('b:2')]);
    A.rekeningenSync(a, REK);
    toets('eigenaar van David blijft na een nieuwe rekeningensync', a.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'prive'").get().eigenaar === 'Cynthia', null);
    k = A.corrigeer(a, { rek: 'spaar', eigenaar: 'kind', door: 'machinekamer' });
    A.rekeningenSync(a, REK);
    toets('eigenaar door de machinekamer blijft na een sync', k.ok && a.db.prepare("SELECT eigenaar, eigenaar_herkomst h FROM rekeningen WHERE rek = 'spaar'").get().h === 'machinekamer', k);
    let f0 = null; try { A.corrigeer(a, { rek: 'prive', eigenaar: 'kind', door: 'machinekamer' }); } catch (e) { f0 = e.message; }
    toets('machinekamer overschrijft een eigenaar van David niet', /David/.test(f0 || '') && a.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'prive'").get().eigenaar === 'Cynthia', f0);
    let fout = null; try { A.corrigeer(a, { nr: 999999, categorie: 'x' }); } catch (e) { fout = e.message; }
    toets('corrigeer onbekende post: nette fout', /bestaat niet/.test(fout || ''), fout);

    // ── Fable wv687 #3: storting van een derde zonder IBAN wordt geen interne overboeking als de echte tegenpost er is ──
    A.bij(a, 'kids', [p('b:oma', dagTerug(6), 75, 'Oma', 'verjaardag'), p('b:12', dagTerug(6), 75, 'D Schaap', 'kado', { tegen_iban: IB.prive })], {});
    A.bij(a, 'prive', [p('b:9', dagTerug(6), -75, 'D Schaap', 'kado', { tegen_iban: IB.kids })], {});
    A.verrijk(a);
    toets('paar: de tegenpost met de eigen IBAN, niet de storting van een derde', ver('b:9').intern_paar === nr('b:12') && ver('b:oma').type === 'inkomst', [ver('b:9'), ver('b:oma')]);

    // ── Fable wv687 #4: David zette alleen de categorie; de eigenaar blijft meerekenen ──
    A.bij(a, 'kids', [p('b:13', dagTerug(5), -9, 'Bioscoop', 'film')], {});
    A.verrijk(a);
    k = A.corrigeer(a, { nr: nr('b:13'), categorie: 'vrije tijd en sport', regel: false });
    A.corrigeer(a, { rek: 'kids', eigenaar: 'Cynthia' });
    toets('correctie alleen categorie: eigenaar volgt een latere rekeningwijziging', ver('b:13').categorie === 'vrije tijd en sport' && ver('b:13').eigenaar === 'Cynthia' && ver('b:13').herkomst === 'david' && k.vast === 'categorie,ai_omschrijving', [k, ver('b:13')]);
    A.corrigeer(a, { rek: 'kids', eigenaar: 'kind' });

    // ── tegenlezing #1: David zette alleen de categorie; een later AI-oordeel brengt geen subcategorie of type uit een andere categorie mee ──
    A.bij(a, 'kids', [p('b:15', dagTerug(5), -11, 'Speelgoedwinkel', 'lego')], {});
    A.verrijk(a);
    A.corrigeer(a, { nr: nr('b:15'), categorie: 'kinderen', regel: false });
    A.aiZet(a, [{ g: A.groepSleutel({ bedrag: -11, tegenpartij: 'Speelgoedwinkel', omschrijving: 'lego' }), type: 'terugboeking', categorie: 'cadeaus en goede doelen', subcategorie: 'verjaardag' }], 'x');
    A.verrijk(a);
    toets('david-categorie: geen subcategorie of type van de AI uit een andere categorie', ver('b:15').categorie === 'kinderen' && ver('b:15').subcategorie === null && ver('b:15').type === 'uitgave', ver('b:15'));

    // ── Fable wv687 #6: wachtende post zonder datum ──
    A.bij(a, 'gez', [p('v:nd', '', -33, 'Garage', null, { status: 'wachtend', datum: '' })], {});
    A.bij(a, 'gez', [p('e:nd', dagTerug(0), -33, 'Garage')], { volledigVanaf: dagTerug(10) });
    z = A.zoek(a, { tekst: 'garage' });
    toets('wachtend zonder datum: na volledige opvraag vervangen, niet dubbel', z.aantal === 1 && a.db.prepare("SELECT status FROM transacties WHERE bron_id = 'v:nd'").get().status === 'vervangen', z);

    // ── CI #159: twee schrijfacties in dezelfde milliseconde (bevroren klok) ──
    {
      const echt = Date.prototype.toISOString;
      Date.prototype.toISOString = function () { return '2026-10-21T10:00:00.000Z'; };
      try {
        A.bij(a, 'gez', [p('v:ms', dagTerug(1), -44, 'Kapper', null, { status: 'wachtend' })], {});
        A.bij(a, 'gez', [p('e:ms', dagTerug(0), -44, 'Kapper')], { volledigVanaf: dagTerug(10) });
      } finally { Date.prototype.toISOString = echt; }
      toets('zelfde milliseconde: wachtende post toch vervangen', a.db.prepare("SELECT status FROM transacties WHERE bron_id = 'v:ms'").get().status === 'vervangen', null);
    }

    // ── wv847: overboeking naar of van een eigen rekening die niet gekoppeld is (Ja David 23-10, #bank-eigen-intern) ──
    {
      const BO = path.join(W, 'bank-eigen');
      const o = A.open(BO);
      const IO = { gez: 'NL00ABNA0777777777', prive: 'NL11BUNQ0000000071', eliz: 'NL08BUNQ0000000073', ing: 'NL44INGB0000000074', zaak: 'NL55RABO0000000075',
        ander: 'NL66ASNB0000000076', pot: 'NL77ABNA0000000077', fam: 'NL88INGB0000000078' };
      A.rekeningenSync(o, { gez: { uid: 'u7', bank: 'ABN AMRO', naam: 'Vaste lasten', iban: IO.gez, sessie: 's7' },
        prive: { bron: 'bunq', uid: 'bunq-71', bunq_id: 71, naam: 'Privé', soort: 'lopend', iban: IO.prive, status: 'ACTIVE' },
        eliz: { bron: 'bunq', uid: 'bunq-73', bunq_id: 73, naam: 'Elizabeth', soort: 'lopend', iban: IO.eliz, status: 'ACTIVE' } });
      A.corrigeer(o, { rek: 'eliz', eigenaar: 'extern' });
      A.maskerZet(o, ['van Testnaam', 'Kidnaam']);
      A.zakelijkZet(o, { [IO.pot]: 'POT' });
      const d = (n) => dagTerug(n), mnd = (k) => dagTerug(3 + 30 * k);
      A.bij(o, 'prive', [p('o:1', d(4), -200, 'D Schaap', 'overboeking', { tegen_iban: IO.ing }), p('o:2', d(4), 300, 'CYNTHIA VAN TESTNAAM', 'terug', { tegen_iban: IO.ander }),
        p('o:3', d(4), -50, 'J Schaap', 'verjaardag', { tegen_iban: IO.fam }), p('o:4', d(4), 1000, 'D Schaap Beheer B.V.', 'uitkering', { tegen_iban: IO.zaak }),
        p('o:5', d(4), -100, 'D Schaap', 'naar spaarrekening', { tegen_iban: IO.ing }), p('o:6', d(4), -75, 'D Schaap', 'contant'),
        p('o:7', d(4), -20, 'David Jansen', 'lunch', { tegen_iban: IO.fam }), p('o:8', d(4), -60, 'D Schaap', 'geld', { tegen_iban: IO.eliz }),
        p('o:10', d(4), -80, 'D Schaap', 'loon', { tegen_iban: IO.pot }), p('o:12', d(6), 500, 'D Schaap', 'dividend', { tegen_iban: IO.zaak }),
        p('o:13', d(5), 600, 'D Schaap', 'dividend', { tegen_iban: IO.zaak }), p('o:14', d(5), 700, 'D Schaap', 'terug', { tegen_iban: IO.ing }),
        p('o:15', d(4), -30, 'Dhr. D. Schaap', null, { tegen_iban: IO.ing }),
        p('o:16', d(4), -35, 'J.D. Schaap', 'cadeau', { tegen_iban: IO.fam }), p('o:17', d(4), -45, 'Kidnaam Schaap', 'zakgeld', { tegen_iban: IO.fam }),
        p('o:18', d(4), -55, 'D Schaap & Zn', 'hout', { tegen_iban: IO.fam })].concat([0, 1, 2, 3].map((k) => p('o:m' + k, mnd(k), -500, 'D Schaap eo C van Testnaam', 'maandelijks', { tegen_iban: IO.ander }))), {});
      A.bij(o, 'eliz', [p('o:9', d(4), 40, 'D Schaap', 'van eigen', { tegen_iban: IO.ing })], {});
      A.verrijk(o);
      const vo = (bron) => o.db.prepare('SELECT v.* FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE t.bron_id = ?').get(bron);
      const no = (bron) => o.db.prepare('SELECT nr FROM transacties WHERE bron_id = ?').get(bron).nr;
      const isEigen = (b) => vo(b).type === 'intern' && vo(b).herkomst === 'regel' && vo(b).intern_paar == null && /eigen rekening \(niet gekoppeld\)/.test(vo(b).ai_omschrijving || '');
      toets('eigen niet gekoppeld (wv847): naar en van een eigen naam met onbekende IBAN is intern, zonder paar, "Naar/Van eigen rekening (niet gekoppeld)"',
        isEigen('o:1') && isEigen('o:2') && isEigen('o:14') && isEigen('o:15') && vo('o:1').categorie === 'intern' && /^Naar/.test(vo('o:1').ai_omschrijving) && /^Van/.test(vo('o:2').ai_omschrijving), ['o:1', 'o:2', 'o:14', 'o:15'].map(vo));
      toets('eigen niet gekoppeld: omschrijving met spaar → sparen en beleggen', isEigen('o:5') && vo('o:5').categorie === 'sparen en beleggen', vo('o:5'));
      toets('eigen niet gekoppeld: "D Schaap eo C <meisjesnaam>" ook intern', isEigen('o:m0') && isEigen('o:m3'), vo('o:m0'));
      toets('eigen niet gekoppeld: andere voorletter (ook J.D.), rechtsvorm, & Zn, andere David, kindernaam, geen IBAN blijven buiten', ['o:3', 'o:4', 'o:6', 'o:7', 'o:16', 'o:17', 'o:18'].every((b) => vo(b).type !== 'intern'), ['o:3', 'o:4', 'o:6', 'o:7', 'o:16', 'o:17', 'o:18'].map(vo));
      toets('eigen niet gekoppeld: naar de externe rekening, de POT-IBAN of óp de externe rekening nooit intern', vo('o:8').type === 'uitgave' && vo('o:10').type === 'uitgave' && vo('o:9').type === 'inkomst', ['o:8', 'o:9', 'o:10'].map(vo));
      const mo = A.maand(o, { maand: d(4).slice(0, 7) });
      toets('eigen niet gekoppeld: maand telt ze als intern, niet in de totalen, niet als nog niet ingedeeld',
        mo.intern.aantal >= 5 && !mo.per_categorie.some((x) => x.categorie === 'intern' || x.categorie === 'sparen en beleggen') && mo.totaal_in === Math.round(mo.per_categorie.reduce((s, x) => s + x.in, 0) * 100) / 100 &&
        !mo.per_categorie.some((x) => x.in === 300 || x.in === 700), mo);
      toets('eigen niet gekoppeld: niet naar het taalmodel', !A.aiOpen(o, 500).groepen.some((g) => /overboeking|maandelijks|naar spaar|^terug$/.test(g.omschrijving || '')), A.aiOpen(o, 500).groepen);
      toets('eigen niet gekoppeld: vaste maandelijkse overboeking is geen abonnement', !A.abonnementen(o, { alle: true }).abonnementen.some((b) => b.bedrag === 500), A.abonnementen(o, { alle: true }));
      const il = A.internLijst(o, {});
      toets('eigen niet gekoppeld: intern-lijst toont ze met "eigen rekening (niet gekoppeld)"', il.overboekingen.some((x) => x.bedrag === 200 && x.naar === 'eigen rekening (niet gekoppeld)') && il.zonder_paar >= 5, il);
      let fo = null;
      try { A.vasteLasten(o, {}); A.stroom(o, {}); A.zoek(o, { type: 'intern' }); A.stand(o); } catch (x) { fo = x.message; }
      toets('eigen niet gekoppeld: vaste-lasten, stroom, zoek en stand breken niet op een intern zonder paar', !fo || /^rekening:/.test(fo), fo);
      // de regel wint van de AI (systeemregel), niet van David
      o.db.prepare("INSERT OR REPLACE INTO ai_groepen (sleutel, type, categorie, subcategorie, ai_omschrijving, model, gemaakt) VALUES (?, 'uitgave', 'overig', NULL, 'iets', 'x', '2026-10-23')")
        .run(A.groepSleutel({ bedrag: -200, tegenpartij: 'D Schaap', omschrijving: 'overboeking' }));
      A.metaZet(o, 'vuil', '1'); A.verrijk(o);
      toets('eigen niet gekoppeld: wint van een AI-oordeel op dezelfde groep', isEigen('o:1'), vo('o:1'));
      // David wijst een tegenrekening aan (de zaak): regel per tegen-IBAN, niet voor al zijn posten met dezelfde naam
      A.corrigeer(o, { nr: no('o:12'), categorie: 'inkomen' });
      toets('eigen niet gekoppeld: correctie van David geldt voor die tegenrekening (inkomen), andere eigen rekening blijft intern',
        vo('o:12').type === 'inkomst' && vo('o:12').categorie === 'inkomen' && vo('o:13').type === 'inkomst' && vo('o:13').categorie === 'inkomen' && vo('o:13').herkomst === 'regel' &&
        isEigen('o:14') && o.db.prepare("SELECT soort FROM regels WHERE herkomst = 'david' AND actief = 1 ORDER BY id DESC").get().soort === 'tegen_iban', ['o:12', 'o:13', 'o:14'].map(vo));
      A.corrigeer(o, { nr: no('o:1'), categorie: 'sparen en beleggen', regel: false });
      toets('eigen niet gekoppeld: David zet sparen en beleggen → blijft intern', vo('o:1').type === 'intern' && vo('o:1').categorie === 'sparen en beleggen' && vo('o:1').herkomst === 'david', vo('o:1'));
      A.metaZet(o, 'vuil', '1'); A.verrijk(o);
      toets('eigen niet gekoppeld: correctie blijft staan na herverrijking', vo('o:1').herkomst === 'david' && vo('o:1').type === 'intern' && vo('o:12').categorie === 'inkomen', [vo('o:1'), vo('o:12')]);
      // wordt de onbekende rekening alsnog gekoppeld, dan wordt het een gewone interne overboeking met de rekeningnaam
      A.rekeningenSync(o, { gez: { uid: 'u7', bank: 'ABN AMRO', naam: 'Vaste lasten', iban: IO.gez, sessie: 's7' },
        prive: { bron: 'bunq', uid: 'bunq-71', bunq_id: 71, naam: 'Privé', soort: 'lopend', iban: IO.prive, status: 'ACTIVE' },
        eliz: { bron: 'bunq', uid: 'bunq-73', bunq_id: 73, naam: 'Elizabeth', soort: 'lopend', iban: IO.eliz, status: 'ACTIVE' },
        ing: { bron: 'bunq', uid: 'bunq-74', bunq_id: 74, naam: 'Buffer', soort: 'lopend', iban: IO.ing, status: 'ACTIVE' } });
      A.metaZet(o, 'vuil', '1'); A.verrijk(o);
      toets('eigen niet gekoppeld: na koppelen gewone interne overboeking met rekeningnaam', vo('o:5').type === 'intern' && vo('o:5').ai_omschrijving === 'Naar Buffer', vo('o:5'));
      o.db.close();
    }

    // ── wv709: externe rekening (op Davids naam, van een ander; eigen archief) ──
    {
      const BE = path.join(W, 'bank-extern');
      const e = A.open(BE);
      const IE = { gez: 'NL00ABNA0999999999', prive: 'NL11BUNQ0000000091', eliz: 'NL08BUNQ0000000093' };
      A.rekeningenSync(e, { gez: { uid: 'u9', bank: 'ABN AMRO', naam: 'Vaste lasten', iban: IE.gez, sessie: 's9' },
        prive: { bron: 'bunq', uid: 'bunq-91', bunq_id: 91, naam: 'Privé', soort: 'lopend', iban: IE.prive, status: 'ACTIVE' },
        eliz: { bron: 'bunq', uid: 'bunq-93', bunq_id: 93, naam: 'Elizabeth', soort: 'lopend', iban: IE.eliz, status: 'ACTIVE' } });
      const d5 = dagTerug(5);
      A.bij(e, 'gez', [p('x:1', d5, -350, 'D. Schaap', 'Periodieke overb Geld')], {});   // ABN geeft geen tegen-IBAN mee
      A.bij(e, 'prive', [p('x:4', d5, -100, 'D. Schaap', null, { tegen_iban: IE.eliz }), p('x:5', d5, -20, 'Bakker', 'brood')], {});
      A.bij(e, 'eliz', [p('x:2', d5, 350, 'D SCHAAP CJ', 'Geld', { tegen_iban: IE.gez }), p('x:6', d5, 100, 'D. Schaap', null, { tegen_iban: IE.prive }),
        p('x:3', d5, -42, 'Kruidvat 123', 'pasbetaling'), p('x:a1', dagTerug(95), -9.99, 'Spotify', 'abo'), p('x:a2', dagTerug(65), -9.99, 'Spotify', 'abo'),
        p('x:a3', dagTerug(35), -9.99, 'Spotify', 'abo'), p('x:a4', d5, -9.99, 'Spotify', 'abo')], {});
      A.verrijk(e);
      const ve = (bron) => e.db.prepare('SELECT v.* FROM verrijking v JOIN transacties t ON t.nr = v.nr WHERE t.bron_id = ?').get(bron);
      const ne = (bron) => e.db.prepare('SELECT nr FROM transacties WHERE bron_id = ?').get(bron).nr;
      toets('extern, vooraf: overboeking naar de rekening telt nog als intern en haar Spotify als abonnement', ve('x:1').type === 'intern' && ve('x:1').intern_paar === ne('x:2') &&
        A.abonnementen(e, {}).abonnementen.some((b) => b.rekening === 'Elizabeth'), [ve('x:1'), A.abonnementen(e, {})]);
      let ke = A.corrigeer(e, { rek: 'eliz', eigenaar: 'extern' });
      toets('extern: eigenaar per rekening (David), blijft na een rekeningensync', ke.ok && ke.eigenaar === 'extern' &&
        (A.rekeningenSync(e, { eliz: { bron: 'bunq', uid: 'bunq-93', naam: 'Elizabeth', soort: 'lopend', iban: IE.eliz, status: 'ACTIVE' }, gez: { uid: 'u9', bank: 'ABN AMRO', iban: IE.gez }, prive: { bron: 'bunq', uid: 'bunq-91', naam: 'Privé', iban: IE.prive, status: 'ACTIVE' } }),
          e.db.prepare("SELECT eigenaar, eigenaar_herkomst h FROM rekeningen WHERE rek = 'eliz'").get().h === 'david') && e.db.prepare("SELECT eigenaar FROM rekeningen WHERE rek = 'eliz'").get().eigenaar === 'extern', ke);
      A.verrijk(e);
      toets('extern: de € 350 (ABN, zonder tegen-IBAN) is een uitgave, geen intern; paar blijft, omschrijving "Naar Elizabeth"', ve('x:1').type === 'uitgave' && ve('x:1').intern_paar === ne('x:2') &&
        ve('x:1').ai_omschrijving === 'Naar Elizabeth' && ve('x:1').eigenaar === 'samen', ve('x:1'));
      toets('extern: overboeking vanaf een bunq-rekening (met tegen-IBAN) ook uitgave', ve('x:4').type === 'uitgave', ve('x:4'));
      toets('extern: op de externe rekening zelf is niets intern; eigenaar extern', ve('x:2').type === 'inkomst' && ve('x:6').type === 'inkomst' && ve('x:3').eigenaar === 'extern', [ve('x:2'), ve('x:6'), ve('x:3')]);
      ke = A.corrigeer(e, { rek: 'eliz', categorie: 'cadeaus en goede doelen', subcategorie: 'steun Elizabeth', door: 'machinekamer' });
      toets('extern: categorie per rekening (machinekamer) wordt een regel voor alle overboekingen ernaartoe', ke.ok && ke.regel > 0 &&
        ve('x:1').categorie === 'cadeaus en goede doelen' && ve('x:1').subcategorie === 'steun Elizabeth' && ve('x:4').categorie === 'cadeaus en goede doelen' && ve('x:1').herkomst === 'regel' &&
        ve('x:1').ai_omschrijving === 'Naar Elizabeth' && ve('x:1').type === 'uitgave' && e.db.prepare('SELECT herkomst FROM regels WHERE id = ?').get(ke.regel).herkomst === 'machinekamer', [ke, ve('x:1')]);
      const me = A.maand(e, { maand: d5.slice(0, 7) });
      const cg = me.per_categorie.find((x) => x.categorie === 'cadeaus en goede doelen') || {};
      toets('extern: maand telt de € 350 en € 100 als uitgave, niets intern, Elizabeths posten niet mee', cg.uit === -450 && me.intern.aantal === 0 && me.totaal_uit === -470 &&
        !JSON.stringify(me).includes('Kruidvat') && /extern/.test(me.let_op_extern || ''), me);
      const ze = A.zoek(e, {});
      toets('extern: zoek zonder rekening laat Elizabeths posten weg, met let_op_extern', !ze.posten.some((x) => x.rekening === 'Elizabeth') && ze.aantal === 3 && !!ze.let_op_extern &&
        (ze.posten.find((x) => x.bedrag === -350) || {}).extern_met === 'Elizabeth' && !(ze.posten.find((x) => x.bedrag === -350) || {}).intern_met, ze);
      const zr2 = A.zoek(e, { rek: 'eliz' });
      toets('extern: met rekening=Elizabeth wel op te vragen (bewaard), met de waarschuwing', zr2.aantal === 7 && zr2.let_op_extern === A.LET_OP_EXTERN, zr2.aantal);
      toets('extern: eigenaar=extern geeft haar posten', A.zoek(e, { eigenaar: 'extern' }).aantal === 7, null);
      toets('extern: intern-lijst leeg', A.internLijst(e, {}).aantal === 0, A.internLijst(e, {}));
      toets('extern: geen abonnement op de externe rekening (ook niet met alle)', !A.abonnementen(e, { alle: true }).abonnementen.some((b) => b.rekening === 'Elizabeth'), A.abonnementen(e, { alle: true }));
      toets('extern: haar posten gaan niet naar het taalmodel', !/kruidvat|spotify/i.test(JSON.stringify(A.aiOpen(e, 500).groepen)), A.aiOpen(e, 500).groepen);
      ke = A.corrigeer(e, { rek: 'eliz', categorie: 'kinderen' });
      let fe = null; try { A.corrigeer(e, { rek: 'eliz', categorie: 'overig', door: 'machinekamer' }); } catch (x) { fe = x.message; }
      toets('extern: categorie van David wint; machinekamer overschrijft hem niet', ve('x:1').categorie === 'kinderen' && /David/.test(fe || '') && ve('x:1').categorie === 'kinderen', [fe, ve('x:1')]);
      fe = null; try { A.corrigeer(e, { rek: 'prive', categorie: 'overig' }); } catch (x) { fe = x.message; }
      toets('extern: categorie per rekening alleen bij een externe rekening', /extern/.test(fe || ''), fe);
      fe = null; try { A.corrigeer(e, { rek: 'eliz', categorie: 'intern' }); } catch (x) { fe = x.message; }
      toets('extern: categorie intern geweigerd', /nooit intern/.test(fe || ''), fe);
      ke = A.corrigeer(e, { nr: ne('x:4'), categorie: 'overig' });
      toets('extern: correctie per post wordt een regel op de externe rekening (geldt ook voor de ABN-overboeking)', ke.ok && e.db.prepare('SELECT soort, patroon, rek FROM regels WHERE id = ?').get(ke.regel).soort === 'extern' &&
        e.db.prepare('SELECT patroon FROM regels WHERE id = ?').get(ke.regel).patroon === 'eliz' && ve('x:1').categorie === 'overig' && ve('x:1').type === 'uitgave', [ke, ve('x:1')]);
      // Fable wv709: randgevallen
      A.bij(e, 'gez', [p('x:7', d5, -500, 'DEGIRO', 'storting'), p('x:12', d5, 60, 'D. Schaap', 'terug', { tegen_iban: IE.prive })], {});
      A.bij(e, 'prive', [p('x:8', d5, -5, 'Kruidvat 123', 'eigen'), p('x:10', d5, 30, 'Elizabeth', 'terugbetaling-x10', { tegen_iban: IE.eliz }), p('x:11', d5, -60, 'D. Schaap', 'naar gez', { tegen_iban: IE.gez })], {});
      A.bij(e, 'eliz', [p('x:9', d5, -30, 'D. Schaap', 'terug-x9', { tegen_iban: IE.prive })], {});
      A.verrijk(e);
      A.corrigeer(e, { nr: ne('x:7'), type: 'intern', regel: false });
      A.verrijk(e);
      toets('extern (Fable #1): type intern van David op een gewone ongepaarde post blijft staan', ve('x:7').type === 'intern', ve('x:7'));
      ke = A.corrigeer(e, { nr: ne('x:3'), categorie: 'gezondheid', eigenaar: 'Elizabeth' });
      toets('extern (Fable #2): correctie op een post van de externe rekening raakt Davids eigen posten niet', ve('x:3').categorie === 'gezondheid' && ve('x:8').categorie !== 'gezondheid' && ve('x:8').eigenaar === 'David' &&
        e.db.prepare('SELECT rek FROM regels WHERE id = ?').get(ke.regel).rek === 'eliz', [ve('x:8'), ke]);
      toets('extern (Fable #4/5): bijschrijving vanaf de externe rekening is inkomst "Van Elizabeth", niet intern, niet naar het taalmodel', ve('x:10').type === 'inkomst' && ve('x:10').ai_omschrijving === 'Van Elizabeth' &&
        ve('x:10').intern_paar === ne('x:9') && !/terugbetaling-x10|Periodieke/.test(JSON.stringify(A.aiOpen(e, 500).groepen)), [ve('x:10'), A.aiOpen(e, 500).groepen]);
      fe = null; try { A.corrigeer(e, { nr: ne('x:1'), type: 'intern' }); } catch (x) { fe = x.message; }
      toets('extern (Fable #3): type intern per post op een overboeking naar de externe rekening geweigerd', /nooit intern/.test(fe || '') && ve('x:1').type === 'uitgave', fe);
      A.corrigeer(e, { nr: ne('x:11'), type: 'uitgave', categorie: 'kinderen', regel: false });
      const z11 = A.zoek(e, { tekst: 'naar gez' }).posten[0] || {};
      toets('extern (Fable #6): extern_met alleen bij een echte externe tegenrekening', !!z11.intern_met && !z11.extern_met, z11);
      ke = A.corrigeer(e, { rek: 'eliz', eigenaar: 'Extern' });
      toets('extern (Fable #8): hoofdletter genormaliseerd', ke.eigenaar === 'extern' && A.stand(e).per_rekening.some((r) => r.eigenaar === 'extern'), ke);
      toets('extern: verrijk idempotent', A.verrijk(e).gewijzigd === 0, null);
      toets('extern: stand noemt eigenaar extern', A.stand(e).per_rekening.some((r) => r.eigenaar === 'extern'), A.stand(e).per_rekening);
      A.corrigeer(e, { rek: 'eliz', eigenaar: 'David' });
      toets('extern terugdraaien: weer intern (niets in de ruwe rijen veranderd)', ve('x:1').type === 'intern' && ve('x:2').type === 'intern' &&
        e.db.prepare("SELECT bedrag, tegenpartij FROM transacties WHERE bron_id = 'x:3'").get().bedrag === -42, [ve('x:1'), ve('x:2')]);
      e.db.close();
    }

    // ── Fable wv687 #10: lege rekeningenlijst zet niets op ontkoppeld ──
    A.rekeningenSync(a, {});
    toets('lege rekeningenlijst (onleesbare stand): niets ontkoppeld', a.db.prepare("SELECT count(*) n FROM rekeningen WHERE status = 'ontkoppeld'").get().n === 0, null);

    // ── Fable wv687 #9: extra namen maskeren (alleen lokaal in meta) ──
    A.maskerZet(a, ['van Oostrum', 'Ilvy']);
    A.bij(a, 'prive', [p('b:14', dagTerug(1), -5, 'C van Oostrum', 'voor Ilvy schoolreis'), p('b:16', dagTerug(1), -6, 'I'.normalize('NFD') + 'lvy'.normalize('NFD') + ' Ilvy'.normalize('NFD'), 'bijdrage')], {});
    A.verrijk(a);
    open = A.aiOpen(a, 200);
    toets('maskerlijst: meisjesnaam en kindernaam niet naar het model', !/oostrum|ilvy/i.test(JSON.stringify(open.groepen)) && open.groepen.some((g) => /\[eigen\]/.test(g.tegenpartij || '')), open.groepen.filter((g) => /eigen/.test(JSON.stringify(g))));
    toets('stand noemt het aantal maskernamen, niet de namen', A.stand(a).masker_namen === 2 && !/oostrum|ilvy/i.test(JSON.stringify(A.stand(a))), null);

    // ── Fable wv687 #5: groep zonder bruikbaar oordeel na twee pogingen niet meer aangeboden ──
    const gb = open.groepen.find((g) => /bioscoop/i.test(g.tegenpartij || '')) || open.groepen[0];
    A.aiZet(a, [{ g: gb.g, type: 'uitgave', categorie: 'onzin' }], 'x', [gb.g]);
    toets('één mislukte poging: nog open', A.aiOpen(a, 500).groepen.some((g) => g.g === gb.g), null);
    A.aiZet(a, [], 'x', [gb.g]);
    toets('twee mislukte pogingen: niet meer aangeboden', !A.aiOpen(a, 500).groepen.some((g) => g.g === gb.g) && A.stand(a).ai_overgeslagen_groepen === 1, null);

    // ── Fable wv687 #1: een correctie van David (ander handvat = ander proces) precies tussen lezen en schrijven van verrijk ──
    {
      const b = A.open(BD), doel = nr('b:6');
      a.db.prepare("UPDATE verrijking SET herkomst = 'ai', categorie = 'boodschappen', david_velden = NULL WHERE nr = ?").run(doel);
      a.db.prepare("UPDATE ai_groepen SET categorie = 'overig' WHERE sleutel = ?").run(A.groepSleutel({ bedrag: -22, tegenpartij: 'Albert Heijn 9999', omschrijving: 'boodschappen' }));
      a.db.prepare("UPDATE regels SET actief = 0 WHERE herkomst = 'david'").run();
      metaZetTest(a, 'vuil', '1');
      const echteExec = a.db.exec.bind(a.db);
      let gehaakt = false;
      a.db.exec = function (sql) { if (!gehaakt && /BEGIN IMMEDIATE/.test(sql)) { gehaakt = true; A.corrigeer(b, { nr: doel, categorie: 'wonen', regel: false }); } return echteExec(sql); };
      try { A.verrijk(a); } finally { a.db.exec = echteExec; }
      toets('race: correctie tussen lezen en schrijven van verrijk blijft staan', gehaakt && ver('b:6').herkomst === 'david' && ver('b:6').categorie === 'wonen', ver('b:6'));
      a.db.prepare("UPDATE regels SET actief = 1 WHERE herkomst = 'david' AND id IN (SELECT max(id) FROM regels WHERE herkomst = 'david' GROUP BY soort, patroon, rek, richting)").run();
      b.db.close();
    }

    // ── abonnement ──
    A.bij(a, 'gez', [1, 2, 3, 4].map((i) => p('e:nf' + i, dagTerug(i * 30 - 20), -15.99, 'Netflix International', 'abonnement')), {});
    A.verrijk(a);
    const ab = A.abonnementen(a, {});
    toets('abonnement herkend (maandritme, vast bedrag)', ab.abonnementen.some((x) => /netflix/i.test(x.naam) && x.ritme === 'maand' && x.actief), ab);

    // ── wv764: vaste lasten (idee 16 fase B) — herkenning per machtiging, termijnen, clusters, tabel en geldstroom ──
    {
      toets('machtiging genormaliseerd (spaties, voorloopnullen) en naam zonder rechtsvorm', A.machtigingVan('Naam: X Machtiging: 0000 4356 2 Omschrijving: y') === '43562' &&
        A.machtigingVan('Machtiging: 43562') === '43562' && A.naamNorm('PayPal (Europe) S.a r.l.') === A.naamNorm('PayPal Europe S.a.r.l. e') && A.naamNorm('TAF B.V.') === A.naamNorm('TAF BV'),
        [A.machtigingVan('Naam: X Machtiging: 0000 4356 2 Omschrijving: y'), A.naamNorm('PayPal (Europe) S.a r.l.'), A.naamNorm('PayPal Europe S.a.r.l. e')]);
      const BV = path.join(W, 'bank-vl'), v = A.open(BV);
      const IV = { vl: 'NL00ABNA0555555555', pr: 'NL11BUNQ0000000071', el: 'NL08BUNQ0000000073' };
      A.rekeningenSync(v, { vl: { uid: 'u7', bank: 'ABN AMRO', naam: 'Vaste lasten', iban: IV.vl, sessie: 's7' },
        pr: { bron: 'bunq', uid: 'bunq-71', bunq_id: 71, naam: 'Privé', soort: 'lopend', iban: IV.pr, status: 'ACTIVE' },
        el: { bron: 'bunq', uid: 'bunq-73', bunq_id: 73, naam: 'Elizabeth', soort: 'lopend', iban: IV.el, status: 'ACTIVE' } });
      const mnd = []; for (let y = 2025, m = 1; y < 2026 || m <= 6; m++) { if (m > 12) { m = 1; y++; } mnd.push(y + '-' + String(m).padStart(2, '0')); if (y === 2026 && m === 6) break; }
      const dg = (ym, d) => ym + '-' + String(d).padStart(2, '0');
      const inc = (mach, naam) => 'SEPA Incasso algemeen doorlopend Incassant: NL00ZZZ999999990000 Naam: ' + naam + ' Machtiging: ' + mach + ' Omschrijving: termijn';
      const VL = [], PR = [], EL = [];
      let n = 0; const q = (l, datum, bedrag, tegen, oms, extra) => l.push(p('vl:' + (++n), datum, bedrag, tegen, oms, extra));
      mnd.forEach((ym, k) => {
        q(VL, dg(ym, 1), -(2900 - 2.5 * k), 'ABN AMRO BANK NV', inc('ST 1110 7002', 'ABN AMRO BANK NV'));                     // hypotheek, lineair dalend
        q(VL, dg(ym, 2), ym === '2026-06' ? -302 : -300, 'MKB LEASE', inc('331959-3', 'MKB LEASE'));                           // prijsstap 0,67% in juni
        q(VL, dg(ym, 15), ym >= '2026-05' ? -31 : -30, 'KPN - Mobiel', inc('M1', 'KPN - Mobiel'));                             // twee nummers, één rij
        { const d = new Date(Date.UTC(2025, 0, 1) + Math.round(30.4 * k) * 86400000).toISOString().slice(0, 10); q(VL, d, -15, 'KPN - Mobiel', inc('M 2', 'KPN - Mobiel')); }   // schuift over de maandgrens
        q(VL, dg(ym, 25), -[400, 380, 300, 250, 200, 180, 170, 190, 260, 330, 390, 420, 410, 390, 310, 240, 210, 190][k], 'Tibber Netherlands B.V.', inc('TB1', 'Tibber'));
        q(VL, dg(ym, 27), -270, 'NV UNIVE ZORG', inc('UV1', 'NV UNIVE ZORG'));
        q(VL, dg(ym, 10), -9.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));
        q(VL, dg(ym, 11), -4.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));
        q(VL, dg(ym, 19), -4.99, 'PayPal (Europe) S.a r.l.', inc('PP1', 'PayPal'));
        if (ym <= '2026-02') q(VL, dg(ym, 5), -2.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));                         // gestopt
        q(VL, dg(ym, 5), -50, 'Jan Jansen', 'SEPA Overboeking IBAN: NL22RABO0123456789 BIC: RABONL2U Naam: Jan Jansen Omschrijving: huur');
        if (['2025-03', '2025-08', '2026-02'].indexOf(ym) >= 0) q(VL, dg(ym, 3), -40, 'NV UNIVE ZORG', inc('UV1', 'NV UNIVE ZORG'));   // eigen bijdrage
        if (ym >= '2025-02' && ym <= '2025-11') q(VL, dg(ym, 28), -200, 'Gemeente Huizen', inc('000000043562', 'Gemeente Huizen'));
        if (ym >= '2026-03') q(VL, dg(ym, 28), -210, 'GEM HUIZEN BELASTINGEN', inc('43562', 'GEM HUIZEN BELASTINGEN'));          // naamwissel, zelfde machtiging
        if (ym >= '2025-07') {
          q(VL, dg(ym, 20), -350, 'D. Schaap', 'Periodieke overb Geld', { tegen_iban: IV.el });                                   // steun (externe rekening)
          q(VL, dg(ym, 19), 5000, 'D. Schaap', 'vaste storting', { tegen_iban: IV.pr });
          PR.push(p('pr:' + ym, dg(ym, 19), -5000, 'D. Schaap', 'vaste storting', { tegen_iban: IV.vl }));
          EL.push(p('el:' + ym, dg(ym, 20), 350, 'D SCHAAP CJ', 'Geld', { tegen_iban: IV.vl }));
        }
      });
      q(VL, '2025-06-29', -266, 'NV UNIVE ZORG', inc('UV1', 'NV UNIVE ZORG'));                                                   // twee dagen na de premie
      q(VL, '2026-04-20', -125.99, 'PayPal Europe S.a.r.l. e', inc('PP1', 'PayPal'));                                            // eenmalig
      [['2025-03-23', 160], ['2025-06-23', 160], ['2025-09-23', 160], ['2025-12-23', 260], ['2026-03-23', 180], ['2026-06-23', 180]].forEach((x) => q(VL, x[0], -x[1], 'Nv Pwn Waterleidingbedri', inc('3942177', 'PWN')));
      A.bij(v, 'vl', VL, {}); A.bij(v, 'pr', PR, {}); A.bij(v, 'el', EL, {});
      A.corrigeer(v, { rek: 'el', eigenaar: 'extern' });
      const nrv = (b) => v.db.prepare('SELECT nr FROM transacties WHERE bron_id = ?').get(b).nr;
      const tib = VL.find((x) => /Tibber/.test(x.tegenpartij)).id;
      A.corrigeer(v, { nr: nrv(tib), categorie: 'wonen', subcategorie: 'energie' });                                           // regel: alle Tibber-posten wonen/energie
      A.verrijk(v);
      // de opgeslagen reeksen rekenen met vandaag; de toets rekent met een vaste peildatum (zelfde functie, zelfde posten)
      const RS = A.reeksenBereken(A.vastePosten(v, 'vl').lasten, { ref: '2026-06-30', start: { vl: A.archiefStart(v).get('vl') } });
      const reeks = (re) => RS.filter((x) => new RegExp('^' + re.replace(/%/g, '.*')).test(x.naam || '')).map((x) => Object.assign({}, x, { bedrag_typisch: x.bedrag, nrs: undefined }));
      const hyp = reeks('ABN AMRO%')[0], gem = reeks('%HUIZEN%'), kpn = reeks('KPN%'), tb = reeks('Tibber%')[0], uv = reeks('NV UNIVE%')[0], pw = reeks('Nv Pwn%')[0], ls = reeks('MKB%')[0];
      toets('vl: hypotheek dalend, bedrag = laatste post', hyp && hyp.wijze === 'dalend' && hyp.bedrag_typisch === 2857.5 && hyp.per_maand === 2857.5, hyp);
      toets('vl: gemeente één reeks over de naamwissel en voorloopnullen, 10 termijnen gemeten, per maand = 210 × 10 / 12', gem.length === 1 && gem[0].ritme === 'termijnen' &&
        gem[0].termijnen === 10 && gem[0].termijnen_bron === 'gemeten' && gem[0].bedrag_typisch === 210 && gem[0].per_maand === 175 && gem[0].naam === 'GEM HUIZEN BELASTINGEN' && gem[0].bedrag_vorig === 200, gem);
      toets('vl: KPN twee machtigingen = twee reeksen, niet geclusterd; prijsstap 30 → 31', kpn.length === 2 && kpn.some((x) => x.bedrag_typisch === 31 && x.bedrag_vorig === 30) && kpn.some((x) => x.bedrag_typisch === 15 && x.actief), kpn);
      toets('vl: Tibber wisselend, gemiddelde van 12 maanden', tb && tb.wijze === 'wisselend' && tb.bedrag_typisch === 292.5 && tb.soort === 'vast', tb);
      toets('vl: Univé premie met losse eigen bijdragen als extra (niet in het bedrag, geen abonnement-id)', uv && uv.bedrag_typisch === 270 && uv.extra === 4 &&
        v.db.prepare("SELECT count(*) n FROM verrijking WHERE abonnement_id IS NOT NULL AND nr IN (SELECT nr FROM transacties WHERE bedrag IN (-40, -266))").get().n === 0, uv);
      const pwId = (v.db.prepare("SELECT id FROM abonnementen WHERE tegen_sleutel = 'm:3942177'").get() || {}).id;
      toets('vl: PWN afrekening hangt aan de reeks, bedrag 180 sinds maart', pw && pw.ritme === 'kwartaal' && pw.bedrag_typisch === 180 && pw.afrekening === 1 && pw.bedrag_vorig === 160 && pw.per_maand === 60 &&
        !!pwId && v.db.prepare("SELECT abonnement_id a FROM verrijking WHERE nr = (SELECT nr FROM transacties WHERE bedrag = -260 AND tegenpartij LIKE 'Nv Pwn%')").get().a === pwId, [pw, pwId]);
      toets('vl: kleine prijsstap (0,67%) is een stap, geen ruis', ls && ls.bedrag_typisch === 302 && ls.bedrag_vorig === 300 && ls.gewijzigd_op === '2026-06-02', ls);
      const pp = RS.filter((x) => x.sleutel_soort === 'machtiging|cluster' && x.actief).sort((x, y) => x.bedrag - y.bedrag);
      toets('vl: PayPal per bedragcluster, twee diensten van 4,99, gestopte en eenmalige niet actief', pp.length === 2 && pp[0].bedrag === 4.99 && pp[0].n_per_maand === 2 && pp[1].bedrag === 9.99 &&
        !RS.some((x) => x.actief && (x.bedrag === 2.99 || x.bedrag === 125.99)), pp.map((x) => [x.bedrag, x.n_per_maand]));
      toets('vl: opgeslagen in abonnementen met soort en per_maand; oude rijen (zonder sleutel_soort) opgeruimd', v.db.prepare("SELECT count(*) n FROM abonnementen WHERE sleutel_soort IS NULL").get().n === 0 &&
        v.db.prepare("SELECT count(*) n FROM abonnementen WHERE tegen_sleutel = 'm:43562' AND per_maand > 0 AND soort IS NOT NULL").get().n === 1, v.db.prepare('SELECT tegen_sleutel, per_maand, soort FROM abonnementen').all());
      toets('vl: overboeking aan een persoon, steun en storting geen reeks', !reeks('Jan%').length && !reeks('D%Schaap%').length, reeks('%Schaap%'));
      const vlr = A.vasteLasten(v, { maand: '2026-06' });
      toets('vl: vaste-lasten juni 2026 — totaal, steun, storting, over', vlr.totaal_per_maand === 4022.97 && vlr.steun.length === 1 && vlr.steun[0].per_maand === 350 &&
        vlr.vaste_storting.length === 1 && vlr.vaste_storting[0].bedrag === 5000 && vlr.over === 627.03 && vlr.peildatum === '2026-06-30', [vlr.totaal_per_maand, vlr.steun, vlr.vaste_storting, vlr.over, vlr.vaste_lasten.map((x) => [x.naam, x.per_maand])]);
      toets('vl: KPN als één rij met twee reeksen, PayPal als één rij', vlr.vaste_lasten.filter((x) => /KPN/.test(x.naam)).length === 1 && vlr.vaste_lasten.find((x) => /KPN/.test(x.naam)).reeksen === 2 &&
        vlr.vaste_lasten.filter((x) => /PayPal/.test(x.naam)).length === 1 && vlr.vaste_lasten.find((x) => /PayPal/.test(x.naam)).per_maand === 19.97, vlr.vaste_lasten);
      toets('vl: verschil met de vorige stand (lease 300 → 302; hypotheek telt niet als verschil)', vlr.verschil.some((x) => x.wat === 'anders' && /MKB/.test(x.post) && x.van === 300 && x.naar === 302) &&
        !vlr.verschil.some((x) => /ABN AMRO/.test(x.post)), vlr.verschil);
      toets('vl: tabel_md zonder IBAN, machtiging, omschrijving, persoon of markering', /\| \*\*Totaal vaste lasten\*\* \| \*\*€ 4\.022,97\*\* \|/.test(vlr.tabel_md) &&
        !/NL\d\d[A-Z]{4}|ST 1110|M1\b|331959|Machtiging|Incassant|termijn Omschrijving|Jan Jansen|<!--|-->|huur/.test(vlr.tabel_md), vlr.tabel_md);
      const vm2 = A.vasteLasten(v, { maand: '2025-12' });
      toets('vl: een eerdere maand rekent met de posten tot die maand (gemeente tussen twee aanslagen nog actief)', vm2.peildatum === '2025-12-31' && vm2.vaste_lasten.some((x) => /Gemeente/.test(x.naam)), vm2.vaste_lasten.map((x) => x.naam));
      toets('vl: nieuwste_post = nieuwste geboekte post van de rekening, los van de maand (poort maandronde wv776)', /^\d{4}-\d{2}-\d{2}$/.test(vlr.nieuwste_post || '') &&
        vlr.nieuwste_post === vm2.nieuwste_post && vlr.nieuwste_post >= '2026-06-01', [vlr.nieuwste_post, vm2.nieuwste_post]);
      let fout = null; try { A.vasteLasten(v, { maand: '2099-01' }); } catch (e) { fout = e.message; }
      toets('vl: toekomstige maand geweigerd', /^maand:/.test(fout || ''), fout);
      fout = null; try { A.vasteLasten(v, { maand: '2026-06', rek: 'el' }); } catch (e) { fout = e.message; }
      toets('vl: externe rekening geweigerd', /^rekening:/.test(fout || ''), fout);
      const sr = A.stroom(v, { maand: '2026-06' });
      const ps = sr.overboekingen.find((x) => x.van === 'Privé' && x.naar === 'Vaste lasten'), es = sr.overboekingen.find((x) => x.naar === 'Elizabeth');
      toets('vl: stroom — vaste storting en steun als vast paar, buffer over 3 maanden, dekking met saldo', ps && ps.vast.length === 1 && ps.vast[0].bedrag === 5000 && es && es.extern && es.som === 350 &&
        sr.buffer && sr.buffer.per_maand.length === 3 && sr.buffer.per_maand[2].stortingen === 5000, sr);
      // Fable wv764: randgevallen
      const R = (posten, ref, start) => A.reeksenBereken(posten.map((x, i) => Object.assign({ nr: 9000 + i, rek: 'x', tegenpartij: 'Org', categorie: null, subcategorie: null }, x)), { ref: ref, start: { x: start || '2024-01-01' } });
      const maandPosten = (van, n, bedrag, mach, extra) => Array.from({ length: n }, (_, k) => Object.assign({ datum: (Number(van.slice(0, 4)) + Math.floor((Number(van.slice(5, 7)) - 1 + k) / 12)) + '-' +
        String(((Number(van.slice(5, 7)) - 1 + k) % 12) + 1).padStart(2, '0') + '-10', bedrag: -(typeof bedrag === 'function' ? bedrag(k) : bedrag), omschrijving: inc(mach, 'Org') }, extra || {}));
      let rr = R(maandPosten('2025-01', 12, (k) => k < 11 ? 2.75 : 9.25, 'NM1'), '2025-12-31');
      toets('rand: prijsstap > 35% als laatste post — reeks blijft actief, laatste post voorlopig', rr.length === 1 && rr[0].actief === 1 && rr[0].bedrag === 2.75 && rr[0].laatste_afwijkend === 9.25, rr);
      rr = R(maandPosten('2025-01', 13, (k) => k < 11 ? 2.75 : 9.25, 'NM1'), '2026-01-31');
      toets('rand: twee posten op de nieuwe stand — nieuwe prijs, niet meer voorlopig', rr.length === 1 && rr[0].bedrag === 9.25 && rr[0].bedrag_vorig === 2.75 && rr[0].laatste_afwijkend === null, rr);
      rr = R(maandPosten('2025-03', 8, 210, 'GM1', { categorie: 'belastingen' }), '2026-01-31', '2025-02-01');
      toets('rand: belastingen vóór het eerste gat — termijnen (10 aangenomen), in de gatmaand nog actief', rr.length === 1 && rr[0].ritme === 'termijnen' && rr[0].termijnen === 10 &&
        rr[0].termijnen_bron === 'aangenomen' && rr[0].actief === 1 && rr[0].per_maand === 175, rr);
      rr = R(maandPosten('2025-01', 1, 39.95, 'SP1').concat(maandPosten('2025-06', 10, 39.95, 'SP1')), '2026-03-31');
      toets('rand: één pauze maakt van een maandabonnement geen termijnreeks', rr.length === 1 && rr[0].ritme === 'maand' && rr[0].per_maand === 39.95, rr);
      rr = R([{ datum: '2025-06-13', bedrag: -59.99, omschrijving: inc('PPX', 'PayPal') }, { datum: '2026-06-15', bedrag: -59.99, omschrijving: inc('PPX', 'PayPal') }]
        .concat(maandPosten('2025-06', 12, 9.99, 'PPX'), maandPosten('2025-06', 12, 4.99, 'PPX'), maandPosten('2025-06', 12, 2.99, 'PPX')), '2026-06-30');
      toets('rand: paraplumachtiging — twee jaarposten zijn geen reeks, de maanddiensten wel', !rr.some((x) => x.bedrag === 59.99) && rr.filter((x) => x.actief).length === 3, rr.map((x) => [x.bedrag, x.ritme]));
      // wv779: PayPal-dienst op de post (pp_dienst uit de PayPal-laag): één bedragcluster met twee diensten wordt twee reeksen; een post
      // zonder bewijs gaat naar de dienst op dezelfde dag van de maand; is er geen enkele dienst in een cluster, dan "zonder ontvangstbewijs"
      const dpost = (van, n, bedrag, dag, dienst, zonder) => maandPosten(van, n, bedrag, 'PPY').map((x, k) => Object.assign(x, { datum: x.datum.slice(0, 8) + dag },
        dienst && !(zonder && zonder.indexOf(k) >= 0) ? { pp_dienst: dienst, pp_naam: dienst === 'samsung' ? 'Samsung Electronics' : 'Jan de Vries' } : {}));
      rr = R(dpost('2025-07', 12, 4.99, '11', 'samsung', [11]).concat(dpost('2025-07', 12, 4.99, '19', 'skyshowtime'), dpost('2025-07', 12, 1.5, '05', null), dpost('2025-07', 12, 6, '03', 'jan')), '2026-06-30');
      const rd = (d) => rr.filter((x) => x.paypal_dienst === d);
      toets('wv779 rand: twee diensten van 4,99 = twee reeksen met elk één per maand; post zonder bewijs bij Samsung', rd('samsung').length === 1 && rd('skyshowtime').length === 1 &&
        rd('samsung')[0].n_per_maand === 1 && rd('samsung')[0].aantal === 12 && rd('samsung')[0].paypal_naam === 'Samsung', rr.map((x) => [x.bedrag, x.paypal_dienst, x.n_per_maand, x.aantal]));
      toets('wv779 rand: cluster zonder enig bewijs = zonder ontvangstbewijs; persoon zonder naam; rijTekst', rr.some((x) => x.bedrag === 1.5 && x.paypal_zonder_bewijs) && rd('jan')[0].paypal_naam === null &&
        A.rijenVan(rr.filter((x) => x.actief)).map(A.rijTekst).sort().join('|') === ['PayPal (zonder ontvangstbewijs)', 'PayPal — Samsung', 'PayPal — SkyShowtime', 'PayPal — onbekende dienst, rond de 3e'].sort().join('|'),
        A.rijenVan(rr.filter((x) => x.actief)).map(A.rijTekst));
      // wv909 (Fable wv779 #5): een cluster van posten met elk twee bewijzen (pp_meerdere, koppel_soort som) heeft wél bewijzen; een
      // cluster dat vooral uit posten zonder bewijs bestaat blijft "zonder ontvangstbewijs"; mist alleen de nieuwste post zijn bewijzen nog
      // (PayPal-ronde koppelt na de bankronde), dan blijft het "meerdere" (Fable wv909 #1)
      const meer = (van, n, bedrag, dag, zonder) => maandPosten(van, n, bedrag, 'PPY').map((x, k) => Object.assign(x, { datum: x.datum.slice(0, 8) + dag }, zonder && zonder.indexOf(k) >= 0 ? {} : { pp_meerdere: true }));
      rr = R(dpost('2025-07', 12, 4.99, '11', 'samsung').concat(meer('2025-07', 12, 9.98, '25'), meer('2025-07', 12, 7.5, '20', [0, 1, 2, 3, 5, 6, 8]), meer('2025-07', 12, 12.5, '22', [11])), '2026-06-30');
      const rm = rr.find((x) => x.bedrag === 9.98), rz = rr.find((x) => x.bedrag === 7.5);
      toets('wv909 #5: cluster met alleen posten met twee bewijzen = "meerdere diensten in één afschrijving", eigen sleutel |d:+', rm && rm.paypal_meerdere && !rm.paypal_zonder_bewijs && /\|d:\+\|c:9\.98$/.test(rm.sleutel) &&
        A.ppTitel(rm) === 'PayPal — meerdere diensten in één afschrijving' && A.rijenVan([rm]).map(A.rijTekst)[0] === 'PayPal — meerdere diensten in één afschrijving', rm);
      const rn = rr.find((x) => x.bedrag === 12.5);
      toets('wv909 #5: cluster met vooral posten zonder bewijs blijft "zonder ontvangstbewijs"', rz && rz.paypal_zonder_bewijs && !rz.paypal_meerdere && A.ppTitel(rz) === 'PayPal (zonder ontvangstbewijs)', rz);
      toets('wv909 #5: nieuwste post nog zonder bewijzen — blijft "meerdere" (geen kanteling)', rn && rn.paypal_meerdere && /\|d:\+\|/.test(rn.sleutel), rn);
      toets('wv909 #5: "zonder ontvangstbewijs" en "meerdere" van dezelfde groep en hetzelfde bedrag zijn één rij tussen peildata',
        A.rijHoort(A.rijenVan([rm])[0], A.rijenVan([Object.assign({}, rm, { sleutel: rm.sleutel.replace('|d:+|', '|d:-|'), paypal_meerdere: undefined, paypal_zonder_bewijs: true })])[0]) &&
        !A.rijHoort(A.rijenVan([rm])[0], A.rijenVan([Object.assign({}, rm, { sleutel: rm.sleutel.replace('|d:+|c:9.98', '|d:-|c:7.50'), paypal_meerdere: undefined, paypal_zonder_bewijs: true })])[0]), null);
      rr = R(maandPosten('2025-07', 12, 9.98, 'PPM').map((x) => Object.assign(x, { pp_meerdere: true })), '2026-06-30');
      toets('wv909 #5: één reeks (één per maand) met alleen zulke posten heet ook zo', rr.length === 1 && rr[0].paypal_meerdere && A.ppTitel(rr[0]) === 'PayPal — meerdere diensten in één afschrijving', rr);
      // wv909 (Fable wv779 #7): twee onbekende diensten (ontvanger mogelijk een persoon) krijgen de incassodag in de titel
      rr = R(dpost('2025-07', 12, 6, '03', 'jan').concat(dpost('2025-07', 12, 8, '17', 'klaas')), '2026-06-30');
      const tt = A.rijenVan(rr.filter((x) => x.actief)).map(A.ppTitel).sort();
      toets('wv909 #7: twee onbekende diensten = twee titels met de incassodag', tt.join('|') === 'PayPal — onbekende dienst, rond de 17e|PayPal — onbekende dienst, rond de 3e' && rr.every((x) => A.ppTitel(x) === tt.find((t) => t.indexOf(', rond de ' + x.dag + 'e') > 0)), [tt, rr.map((x) => [x.paypal_dienst, x.dag])]);
      rr = R(maandPosten('2025-07', 12, 4.99, 'PPZ').concat(maandPosten('2025-07', 12, 4.99, 'PPZ').map((x) => Object.assign(x, { datum: x.datum.slice(0, 8) + '19' }))), '2026-06-30');
      toets('wv779 rand: zonder dienstinformatie de paraplu zoals vóór wv779 (één cluster, twee per maand)', rr.length === 1 && rr[0].n_per_maand === 2 && !rr[0].paypal_dienst && !rr[0].paypal_zonder_bewijs, rr);
      // Fable wv779 #3: prijsstap waarbij de incassodag verschuift (oud laatst 31-7, nieuw 26-8 en 21-9): één reeks, niet twee naast elkaar
      const nf = (datum, bedrag) => ({ datum: datum, bedrag: -bedrag, omschrijving: inc('PPY', 'PayPal'), pp_dienst: 'netflix', pp_naam: 'Netflix.com' });
      rr = R(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'].map((d) => nf(d, 17.99)).concat([nf('2026-08-26', 20.99), nf('2026-09-21', 20.99)],
        dpost('2026-02', 8, 4.99, '11', 'samsung'), dpost('2026-02', 8, 4.99, '19', 'skyshowtime')), '2026-09-21');
      const nfr = rr.filter((x) => x.paypal_dienst === 'netflix' && x.actief);
      toets('wv779 rand: prijsstap binnen één dienst = één reeks met bedrag_vorig (niet 17,99 + 20,99 naast elkaar)', nfr.length === 1 && nfr[0].bedrag === 20.99 && nfr[0].bedrag_vorig === 17.99 && nfr[0].per_maand === 20.99 &&
        A.rijenVan(rr.filter((x) => x.actief)).filter((x) => x.paypal_dienst === 'netflix').length === 1, rr.filter((x) => x.paypal_dienst === 'netflix').map((x) => [x.bedrag, x.bedrag_vorig, x.actief, x.per_maand]));
      toets('wv779 naam: persoon met een "rechtsvorm" als voornaam blijft naamloos; organisatie wel bij naam', A.paypalNaam('ab', 'Ab Jansen') === null && A.paypalNaam('sa', 'Sa Nguyen') === null &&
        A.paypalNaam('jan', 'Jan de Vries') === null && A.paypalNaam('voorbeeld', 'Voorbeeld Games Ltd') === 'Voorbeeld Games Ltd' && A.paypalNaam('zweeds', 'Zweeds Bedrijf AB') === 'Zweeds Bedrijf AB' &&
        A.paypalNaam('steampowered', 'www.steampowered.com') === 'Steam' && A.paypalNaam('x', 'Iets Payments') === 'Iets Payments', null);
      rr = R(maandPosten('2025-01', 12, (k) => k < 8 ? 1000 : 1250, 'HR1', { categorie: 'wonen', subcategorie: 'huur' }), '2025-12-31');
      toets('rand: huurstap +25% in wonen is een prijsstap, niet wisselend', rr.length === 1 && rr[0].wijze === 'vast' && rr[0].bedrag === 1250 && rr[0].bedrag_vorig === 1000, rr);
      const vlB = A.vasteLasten(v, { maand: '2026-06', rek: 'pr' });
      toets('vl: andere rekening dan de vaste-lastenrekening: standaard_rekening false (bank.py schrijft dan niet)', vlB.standaard_rekening === false && vlr.standaard_rekening === true, [vlB.standaard_rekening, vlr.standaard_rekening]);
      v.db.close();
    }

    // ── stand: alleen aantallen ──
    const st = A.stand(a);
    toets('stand: aantallen per status en herkomst, geen bedragen of namen', st.transacties === tel() && st.per_status.vervangen >= 1 && st.verrijking.per_herkomst.david >= 2 &&
      !/Albert|Netflix|Schaap|NL\d\d/.test(JSON.stringify(st)), st);
    toets('niets ooit verwijderd (alle bron_ids er nog)', ['e:c1', 'e:c2', 'v:c3', 'e:c4', 'v:w2', 'e:b3', 'b:1', 'b:11'].every((b) => a.db.prepare('SELECT 1 FROM transacties WHERE bron_id = ?').get(b)), null);

    // ── server.js: /smal/bank-archiefopdrachten en de AI-stap (vm, nagebootste claude) ──
    const ssrc = fs.readFileSync('server.js', 'utf8');
    const s1 = ssrc.indexOf('// ── wv680: bankluis'), s2 = ssrc.indexOf('// ── einde bankluis ──');
    const k1 = ssrc.indexOf('function smalKind('), k2 = ssrc.indexOf('async function smalSbRpc(');
    const SECRET = 's'.repeat(40), logs = [];
    let kluis = 0;
    const nep = path.join(W, 'nep-claude.js'), spoor = path.join(W, 'claude-spoor.json');
    fs.writeFileSync(nep, '#!' + process.execPath + '\n' + `
const fs = require('fs'); const a = process.argv.slice(2); const i = a.indexOf('--json-schema');
const prompt = fs.readFileSync(0, 'utf8'); const m = /\\[BANKDATA[^\\n]*\\n([\\s\\S]*?)\\n\\[EINDE BANKDATA\\]/.exec(prompt);
const groepen = JSON.parse(m[1]);
fs.writeFileSync(process.env.SPOOR || ${JSON.stringify(spoor)}, JSON.stringify({ args: a, env: Object.keys(process.env), cwd: process.cwd(), leeg: fs.readdirSync(process.cwd()).length, prompt: prompt, schema: JSON.parse(a[i + 1]) }));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 10, output_tokens: 5 }, structured_output: { r: groepen.map((g) => ({ g: g.g, type: g.richting === 'af' ? 'uitgave' : 'inkomst', categorie: g.richting === 'af' ? 'overig' : 'overig inkomen', omschrijving: 'nep' })) } }) + '\\n');
`, { mode: 0o700 });
    const env = { PATH: process.env.PATH, HOME: W, TZ: 'Europe/Amsterdam', BANK_DIR: BD, BANK_CLAUDE_BIN: nep, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-mag-mee',
      SUPABASE_URL: 'https://abcdef.supabase.co', SUPABASE_MCP_TOKEN: 'pat-geheim', ANDERE_SLEUTEL: 'mag-niet-mee' };
    const g = { VV: () => require(require('path').resolve('vault-veilig.js')), require, fs, path, crypto, Buffer, console, URL, setTimeout, clearTimeout, setInterval, AbortSignal, Promise, JSON, Date, spawn, VAULT: W, SECRET: SECRET,
      __dirname: process.cwd(), process: { env: env, execPath: process.execPath, pid: process.pid },
      fetch: async function () { kluis++; return { ok: true, json: async () => [] }; },
      logError: (w, e) => logs.push(w + ': ' + (e && e.message || e)), schrijfLog: (r) => logs.push(r), nu: () => 'NU', velden: (o) => JSON.stringify(o),
      reqPath: (req) => (req.url || '').split('?')[0], rolPoort: (res, verder) => verder(), rol: { eerste: true }, rolPrimair: () => true, rolEerste: Promise.resolve(), ROL_START_WACHT_MS: 50 };
    vm.createContext(g);
    vm.runInContext(ssrc.slice(k1, k2) + '\n' + ssrc.slice(s1, s2) + '\n;globalThis.__h = { bankSmal, bankVerrijkStand, bankArchiefFout, laatsteFout: () => bankArchiefFoutLaatst };', g, { filename: 'server.js#bank' });
    const h = g.__h;
    fs.writeFileSync(path.join(BD, 'stand.json'), JSON.stringify({ versie: 1, wachtend: {}, sessies: {}, rekeningen: REK, tellers: { dag: '', per: {} }, opgehaald: {} }), { mode: 0o600 });
    let s = await h.bankSmal({ secret: 'socev', opdracht: 'zoek', tekst: 'albert', max: 5 });
    toets('smal zoek met de Socev-sleutel: ok, BANKDATA-markering, geen kluis', s.status === 200 && s.j.ok && s.j.aantal >= 3 && /BANKDATA/.test(s.j.let_op_bron) && kluis === 0, [s, kluis]);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'vaste-lasten', maand: '2026-13' });   // maand 13: 400 vóór het kindproces
    toets('smal vaste-lasten met een ongeldige maand: 400', s.status === 400, s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'vaste-lasten' });
    toets('smal vaste-lasten met de Socev-sleutel: ok, BANKDATA-markering, tabel_md, geen kluis', s.status === 200 && s.j.ok && /BANKDATA/.test(s.j.let_op_bron) && typeof s.j.tabel_md === 'string' && kluis === 0, [s, kluis]);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'stroom', maand: vandaag.slice(0, 7) });
    toets('smal stroom: ok, BANKDATA-markering', s.status === 200 && s.j.ok && /BANKDATA/.test(s.j.let_op_bron), s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'maand', maand: 'oktober' });
    toets('smal maand met een ongeldige maand: 400', s.status === 400, s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'corrigeer', nr: String(nr('b:6')), categorie: '--regel' });
    toets('smal corrigeer met een vlag als waarde: 400', s.status === 400, s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'corrigeer', nr: String(nr('b:6')), categorie: 'boodschappen', regel: 'nee' });
    toets('smal corrigeer zonder regel: ok, geen nieuwe regel', s.status === 200 && s.j.ok && s.j.regel === null && ver('b:6').herkomst === 'david', [s.j, ver('b:6')]);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'corrigeer', rekening: 'Kids', eigenaar: 'kind', door: 'machinekamer' });
    toets('smal corrigeer door=machinekamer met de Socev-sleutel: 403', s.status === 403, s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'verrijk' });
    toets('smal verrijk met de Socev-sleutel: 403', s.status === 403, s);
    s = await h.bankSmal({ secret: SECRET, opdracht: 'verrijk-zet', resultaten: [] });
    toets('smal verrijk-zet bestaat niet als opdracht: 400', s.status === 400, s);
    s = await h.bankSmal({ secret: 'socev', opdracht: 'historie', sessie: 'abn-diep', van: '2015-01-01' });
    toets('smal historie abn-diep met de Socev-sleutel: 403', s.status === 403, s);
    s = await h.bankSmal({ secret: SECRET, opdracht: 'verrijk', max_batches: 3 });
    toets('smal verrijk met API_SECRET: gestart (202)', s.status === 202 && s.j.gestart, s);
    for (let i = 0; i < 100 && h.bankVerrijkStand().bezig; i++) await new Promise((ok) => setTimeout(ok, 100));
    const vs = h.bankVerrijkStand();
    toets('AI-stand (wv740): weigering als aantallen in de stand (ook in /health bank_verrijk_ai)', vs.laatst && vs.laatst.weigering && ['groep', 'categorie', 'intern'].every((k) => Number.isInteger(vs.laatst.weigering[k])) &&
      /bank_verrijk_ai: bankVerrijkStand\(true\)/.test(ssrc), vs.laatst);
    {
      // wv740 (Fable MOET): /health krijgt van een fout alleen de soort, niet de tekst van claude of bank-lezer
      const b1 = ssrc.indexOf('function bankVerrijkStand('), b2 = ssrc.indexOf('function bankAiSchema(');
      const c = {};
      vm.createContext(c);
      vm.runInContext('let bankVerrijkBezig = false, bankVerrijkLaatste = { begin: 1, eind: 2, batches: 1, groepen_gezet: 0, geweigerd: 0, open_groepen: 3, fout: "claude: gegeven X\\nY" };\n' +
        ssrc.slice(b1, b2) + '\n;globalThis.__s = [bankVerrijkStand(true), bankVerrijkStand()];', c);
      toets('AI-stand open (/health): fout alleen de soort, met sleutel de volle tekst', c.__s[0].laatst.fout === 'claude' && /gegeven X/.test(c.__s[1].laatst.fout), c.__s.map((x) => x.laatst.fout));
    }
    {
      // wv740: eigen uurteller per sleutel — de machinekamer (API_SECRET) kan Socevs teller niet opmaken
      const t1 = ssrc.indexOf('function smalTel('), t2 = ssrc.indexOf('function smalRoute(');
      const gr = /const SMAL_GRENS = \{[^\n}]*\};/.exec(ssrc)[0];
      const c = { Date };
      vm.createContext(c);
      vm.runInContext(gr + '\nconst smalTellers = {};\n' + ssrc.slice(t1, t2) + '\n;globalThis.__t = { smalTel, SMAL_GRENS, smalTellers };', c);
      const T = c.__t, nu0 = Date.now();
      let mk = 0; for (let i = 0; i < T.SMAL_GRENS.bank + 5; i++) if (T.smalTel('bank', false, nu0 + i)) mk++;
      toets('smal-teller: machinekamer stopt op zijn eigen grens', mk === T.SMAL_GRENS.bank, mk);
      toets('smal-teller: Socev daarna nog gewoon door (eigen teller)', T.smalTel('bank', true, nu0 + 100) && T.smalTellers.bank.length === 1, Object.keys(T.smalTellers));
      let so = 1; for (let i = 0; i < T.SMAL_GRENS.bank + 5; i++) if (T.smalTel('bank', true, nu0 + 200 + i)) so++;
      toets('smal-teller: Socev stopt op zijn eigen grens', so === T.SMAL_GRENS.bank, so);
      toets('smal-teller: na een uur weer ruimte', T.smalTel('bank', true, nu0 + 3600000 + 300) && T.smalTel('bank', false, nu0 + 3600000 + 300), null);
      toets('smal-teller: andere route los van bank', T.smalTel('fin-sql', false, nu0), null);
      // wv1030: de socev-schakelaar plus een eigen klasse per beurtpas-sessie
      toets('smalRoute gebruikt smalTel met de Socev-sleutel als schakelaar', /const socev = sleutelOk && socevAgentSleutelOk\(d\.secret\);/.test(ssrc) && /if \(!smalTel\(actie, socev, Date\.now\(\), pas \? pas\.sessie : ''\)\)/.test(ssrc), null);
    }
    toets('AI-stap klaar: groepen ingedeeld, niets open', !vs.bezig && vs.laatst.groepen_gezet >= 1 && vs.laatst.open_groepen === 0 && !vs.laatst.fout, vs);
    const sp = JSON.parse(fs.readFileSync(spoor, 'utf8'));
    toets('claude: geen tools, geen MCP, geen sessie, beperkt, Sonnet', sp.args.join(' ').indexOf('--tools  ') >= 0 && sp.args.indexOf('--strict-mcp-config') >= 0 && sp.args.indexOf('--no-session-persistence') >= 0 &&
      sp.args.indexOf('--restricted') >= 0 && sp.args[sp.args.indexOf('--model') + 1] === 'claude-sonnet-5-5' && sp.args.indexOf('--dangerously-skip-permissions') < 0, sp.args.filter((x) => x.length < 40));
    toets('claude: prompt via stdin, niet in argv (geen bankdata in de proceslijst)', sp.args.indexOf('--') < 0 && !/Albert|tikkie|bedrag_typisch/i.test(sp.args.join(' ')) && /bedrag_typisch/.test(sp.prompt), [sp.prompt.slice(0, 200), sp.args.filter((x) => x.length < 60)]);
    toets('claude: kale omgeving (alleen de eigen inlog), lege werkmap', sp.env.indexOf('CLAUDE_CODE_OAUTH_TOKEN') >= 0 && sp.env.indexOf('SUPABASE_MCP_TOKEN') < 0 && sp.env.indexOf('ANDERE_SLEUTEL') < 0 &&
      sp.env.indexOf('BANK_DIR') < 0 && sp.leeg === 0 && sp.cwd.indexOf(BD) < 0, [sp.env, sp.cwd]);
    toets('claude: invoer zonder naam van David/Cynthia en zonder IBAN, schema met de categorielijst', !/schaap|david|cynthia|NL\d\d[A-Z]{4}/i.test(sp.prompt.split('[BANKDATA')[1]) && sp.schema.properties.r.items.properties.categorie.enum.indexOf('boodschappen') >= 0, sp.prompt.slice(0, 300));
    toets('werkmap van claude opgeruimd', !fs.existsSync(sp.cwd), sp.cwd);
    toets('correctie van David blijft staan na de AI-stap', ver('b:2').herkomst === 'david' && ver('b:2').categorie === 'huishouden', ver('b:2'));
    s = await h.bankSmal({ secret: 'socev', opdracht: 'archief' });
    toets('smal archief: aantallen + stand AI-stap, geen namen of bedragen', s.status === 200 && s.j.ok && s.j.verrijk_ai && s.j.verrijk_ai.laatst.batches >= 1 && !/Albert|Netflix|Schaap/.test(JSON.stringify(s.j)), s.j);
    toets('log zonder invoer of uitvoer van het model', !logs.some((l) => /Albert|Netflix|tikkie|nep/i.test(l)), logs);
    // archieffout zichtbaar: log met tekst (cijferreeksen weg), /health-tijd, één box-rij per dag
    fs.mkdirSync(path.join(W, '00_Systeem', 'Meldingen'), { recursive: true });
    const box = path.join(W, '00_Systeem', 'Meldingen', 'machinekamer.md');
    fs.writeFileSync(box, '# box\n\n## [direct] 2026-10-01 10:00 — oud\n- status: open\n');
    h.bankArchiefFout('bij: database is locked 12345678'); h.bankArchiefFout('bij: database is locked');
    const bt = fs.readFileSync(box, 'utf8');
    toets('archieffout: log met reden, één box-rij per dag, tijd voor /health', logs.some((l) => /bank-archief .*database is locked #/.test(l)) && (bt.match(/transactiedatabase: schrijven mislukt/g) || []).length === 1 && !!h.laatsteFout().tijd, [logs.slice(-2), bt.slice(0, 300)]);
  } catch (e) { fouten++; console.log('ROOD  uitzondering: ' + (e && e.stack || e)); }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})();
JS
