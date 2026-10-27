'use strict';
/*
 * Zaadscript Facturen-app (wv824, F1c): vult een WEGWERPdatabase met synthetische gegevens voor toetsen en de UI-proef (F3).
 * Nooit op de echte database: weigert /opt/data/facturen (ook via een koppeling) en een database waar al facturen in staan.
 * Alles verzonnen: IBAN's met bankcode TEST (geldig mod-97, geen echte rekening), "Leverancier A B.V.", adressen op .invalid
 * (kunnen per constructie niet bezorgd worden), stukken = kleine PDF's met de tekst "synthetisch". Deterministisch per zaadgetal.
 *
 * Gebruik: node test/facturen-zaad.js <map> [--vandaag JJJJ-MM-DD] [--zaad N]
 *          of require('./test/facturen-zaad.js').zaai(fdb, { vandaag, zaad })
 */
const fs = require('fs');
const path = require('path');
const D = require(path.resolve(__dirname, '..', 'facturen-db.js'));
const K = require(path.resolve(__dirname, '..', 'facturen-kern.js'));
const B = require(path.resolve(__dirname, '..', 'facturen-bank.js'));

const ECHT = '/opt/data/facturen';

function maakIban(land, bank, rek) {
  const r = bank + rek + land + '00';
  let rest = 0;
  for (const ch of r) { const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch; for (const d of v) rest = (rest * 10 + Number(d)) % 97; }
  return land + String(98 - rest).padStart(2, '0') + bank + rek;
}
function rng(zaad) {   // mulberry32
  let a = zaad >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Kleine geldige PDF (één pagina, Helvetica) zodat pdf.js in de UI-proef iets kan tekenen.
function pdf(regels) {
  const tekst = regels.map((r, i) => 'BT /F1 11 Tf 56 ' + (780 - i * 18) + ' Td (' + String(r).replace(/[()\\]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?') + ') Tj ET').join('\n');
  const obj = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(tekst) + ' >>\nstream\n' + tekst + '\nendstream',
  ];
  let uit = '%PDF-1.4\n';
  const plek = [];
  obj.forEach((o, i) => { plek.push(Buffer.byteLength(uit)); uit += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = Buffer.byteLength(uit);
  uit += 'xref\n0 ' + (obj.length + 1) + '\n0000000000 65535 f \n' + plek.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  uit += 'trailer\n<< /Size ' + (obj.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(uit, 'latin1');
}

const ENTITEITEN = [
  ['tolgaarde', 'Huisartsenpraktijk Tolgaarde B.V.', 'Tolgaarde', 'TG', 'exact'],
  ['groenhouten', 'Huisartsenpraktijk Groenhouten', 'Groenhouten', 'GH', 'exact'],
  ['holding', 'Primum Non Nocere Holding B.V.', 'Holding', 'HOLD', 'exact'],
  ['praktijkhouders_bv', 'Praktijkhouders B.V.', 'Praktijkhouders', 'PHBV', 'exact'],
  ['pot', 'Samenwerkende Werkgevers (POT POH-GGZ)', 'POT', 'POT', 'exact'],
  ['kostenmaatschap', 'Maatschap POH-GGZ Leusden', 'Kostenmaatschap', 'KM', 'exact'],
  ['sloel', 'Stichting Leusden op een Lijn', 'SLOEL', 'SLOEL', 'mail'],
  ['sel', 'SEL', 'SEL', null, 'mail'],
  ['prive', 'Privé', 'Privé', null, null],
  ['hagro', 'HAGRO', 'HAGRO', null, null],
  ['dbh', 'DBH', 'DBH', null, null],
];
const ACTIEF = ['tolgaarde', 'groenhouten', 'holding', 'praktijkhouders_bv', 'pot', 'kostenmaatschap', 'sloel', 'sel', 'prive'];
// sleutel → [bankcode-volgnummer, bank, formaat, controle, alleen_eigenaar]
const REKENINGEN = {
  tolgaarde: ['0000000011', 'ABN', 'abn_mt940', 1, 0], groenhouten: ['0000000012', 'ABN', 'abn_tab', 1, 0], holding: ['0000000013', 'ABN', 'abn_tab', 1, 0],
  praktijkhouders_bv: ['0000000014', 'ABN', 'abn_tab', 1, 0], pot: ['0000000015', 'ABN', 'bankluis', 1, 1], kostenmaatschap: ['0000000016', 'ING', 'ing_csv', 1, 0],
  sloel: ['0000000017', 'ING', 'ing_csv', 1, 0], prive: ['0000000019', 'ABN', 'abn_tab', 0, 1],
};
// [letter, standaard_entiteit, standaard_betaalwijze, incasso?]
const LEVERANCIERS = [
  ['A', 'tolgaarde', 'zelf'], ['B', 'tolgaarde', 'incasso'], ['C', 'groenhouten', 'zelf'], ['D', 'groenhouten', 'incasso'],
  ['E', 'holding', 'zelf'], ['F', 'praktijkhouders_bv', 'betaald'], ['G', 'pot', 'zelf'], ['H', 'kostenmaatschap', 'incasso'],
  ['I', 'sloel', 'zelf'], ['J', 'sel', 'zelf'], ['K', 'prive', 'zelf'], ['L', 'tolgaarde', 'zelf'],
];
// status → aantal (samen 80)
// (dubbel als laatste: verwijst naar een eerder verstuurde factuur)
const VERDELING = [['te_beoordelen', 22], ['geen_factuur', 5], ['in_wachtrij', 10], ['prive_archief', 5], ['wordt_verstuurd', 4],
  ['concept_klaar', 6], ['verstuurd', 18], ['verzending_mislukt', 6], ['dubbel', 4]];

function weigerEcht(dir) {
  const echt = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };
  const d = echt(dir), e = echt(ECHT);
  if (d === e || d.indexOf(e + path.sep) === 0 || path.resolve(dir) === ECHT || path.resolve(dir).indexOf(ECHT + path.sep) === 0) {
    throw new Error('zaad weigert de echte facturenmap (' + ECHT + '); gebruik een wegwerpmap');
  }
}

function zaai(fdb, o) {
  o = o || {};
  weigerEcht(fdb.dir);
  if (Number(fdb.db.prepare('SELECT count(*) AS n FROM factuur').get().n) > 0) throw new Error('zaad weigert een database met facturen');
  const vandaag = o.vandaag || '2026-10-22';
  const r = rng(Number.isInteger(o.zaad) ? o.zaad : 824);
  const kies = (l) => l[Math.floor(r() * l.length)];
  const t0 = Date.parse(vandaag + 'T12:00:00Z');
  const dag = (n) => K.plusDagen(vandaag, n);
  const tijd = (n, uur) => new Date(t0 + n * 86400000 + ((uur || 0) - 12) * 3600000).toISOString();
  const id = () => { let s = ''; for (let i = 0; i < 16; i++) s += '0123456789abcdef'[Math.floor(r() * 16)]; return s; };
  const W = 'zaad';
  const tel = { stukken: 0 };

  return D.transactie(fdb, function () {
    // ── entiteiten, rekeningen, gebruikers, bronnen ──
    const ent = {};
    for (const [sleutel, naam, kort, fin, route] of ENTITEITEN) {
      const actief = ACTIEF.includes(sleutel);
      const doel = actief && route ? 'boekhouder-' + sleutel.replace(/_/g, '-') + '@acta.invalid' : null;
      ent[sleutel] = { sleutel, boekhoud_doel: doel, afschrift_doel: sleutel === 'pot' ? 'afschrift-pot@acta.invalid' : null };
      D.voegToe(fdb, 'entiteit', { sleutel, naam, naam_kort: kort, aliassen: sleutel === 'prive' ? ['D. Schaap'] : [kort], fin_code: fin,
        kvk: actief && sleutel !== 'prive' ? '9900' + String(ENTITEITEN.findIndex((x) => x[0] === sleutel) + 1).padStart(4, '0') : null,
        actief: actief ? 1 : 0, boekhoud_doel: doel, boekhoud_route: actief && route ? route : null, afschrift_doel: ent[sleutel].afschrift_doel });
    }
    const rek = {};
    for (const s of Object.keys(REKENINGEN)) {
      const [nr, bank, formaat, controle, eigenaar] = REKENINGEN[s];
      rek[s] = { id: id(), iban: maakIban('NL', 'TEST', nr) };
      D.voegToe(fdb, 'rekening', { id: rek[s].id, entiteit: s, iban: rek[s].iban, bank, bank_formaat: formaat, bankluis_rek: formaat === 'bankluis' ? 'proef-pot' : null,
        afschrift_doorsturen: s === 'pot' ? 1 : 0, controle, alleen_eigenaar: eigenaar, laatste_invoer_op: s === 'prive' ? null : tijd(-(2 + Math.floor(r() * 9))) });
    }
    const eigenaar = id(), pm = id();
    D.voegToe(fdb, 'gebruiker', { id: eigenaar, email: null, naam: 'Eigenaar (app-sessie)', ingang: 'app', rol: 'eigenaar' });
    D.voegToe(fdb, 'gebruiker', { id: pm, email: 'praktijkmanager@voorbeeld.invalid', naam: 'Praktijkmanager (proef)', ingang: 'fac', rol: 'praktijkmanager', actief: 0 });
    for (const s of ACTIEF.filter((x) => x !== 'prive')) D.voegToe(fdb, 'gebruiker_entiteit', { gebruiker: pm, entiteit: s });
    const bron = { verzamelpostvak: id(), upload: id(), bankluis: id() };
    for (const s of Object.keys(bron)) D.voegToe(fdb, 'bron', { id: bron[s], soort: s, naam: s, actief: 0 });
    for (let i = 0; i < 6; i++) {
      const ok = i !== 2;
      D.voegToe(fdb, 'bron_ronde', { bron: bron.verzamelpostvak, start: tijd(-i, 6), eind: tijd(-i, 6.02), ok: ok ? 1 : 0,
        aantallen: { berichten_gezien: 20 + i, nieuw: ok ? i % 3 : 0, bijlagen: ok ? i % 4 : 0, te_groot: 0, fout: ok ? 0 : 1 },
        fouten: ok ? [] : [{ wat: 'mail_bijlage', id: 'proef', melding: 'HTTP 502' }], niet_gelezen: [] });
    }
    D.voegToe(fdb, 'bron_ronde', { bron: bron.bankluis, start: tijd(0, 5), eind: tijd(0, 5.01), ok: 1, aantallen: { transacties: 12 } });

    // ── leveranciers ──
    const lev = {};
    for (const [letter, se, sb] of LEVERANCIERS) {
      const l = { id: id(), naam: 'Leverancier ' + letter + ' B.V.', entiteit: se, betaalwijze: sb, iban: maakIban('NL', 'TEST', '00000' + String(100 + letter.charCodeAt(0) - 64).padStart(5, '0')),
        incassant: sb === 'incasso' ? 'NL00ZZZ9999000000' + (letter.charCodeAt(0) - 64) : null };
      lev[letter] = l;
      D.voegToe(fdb, 'leverancier', { id: l.id, naam: l.naam, genormaliseerd: K.normNaam(l.naam), domeinen: ['leverancier-' + letter.toLowerCase() + '.invalid'],
        kvk: '9800' + String(letter.charCodeAt(0)).padStart(4, '0'), standaard_entiteit: se, standaard_betaalwijze: sb,
        mediaan: { [se]: 10000 + (letter.charCodeAt(0) - 64) * 2500 }, alleen_portaal: letter === 'J' ? 1 : 0,
        incassant_ids: l.incassant ? [l.incassant] : [], incasso_tolerantie_pct: sb === 'incasso' ? 5 : null, aangemaakt_op: tijd(-200) });
      D.voegToe(fdb, 'leverancier_iban', { leverancier: l.id, iban: l.iban, toegevoegd_door: W, toegevoegd_op: tijd(-200) });
    }
    D.voegToe(fdb, 'tekstanker', { tekst: 'Tolgaarde', entiteit: 'tolgaarde', aangemaakt_door: W, aangemaakt_op: tijd(-200) });
    D.voegToe(fdb, 'tekstanker', { tekst: 'Groenhouten', entiteit: 'groenhouten', aangemaakt_door: W, aangemaakt_op: tijd(-200) });
    D.voegToe(fdb, 'tekstanker', { tekst: 'Leusden op een Lijn', entiteit: 'sloel', aangemaakt_door: W, aangemaakt_op: tijd(-200) });
    D.voegToe(fdb, 'tekstanker', { tekst: 'Samenwerkende Werkgevers', entiteit: 'pot', aangemaakt_door: W, aangemaakt_op: tijd(-200) });
    D.voegToe(fdb, 'geen_factuur', { patroon: 'orderbevestiging', toelichting: 'proef', aangemaakt_door: W, aangemaakt_op: tijd(-100) });
    D.voegToe(fdb, 'geen_factuur', { patroon: 'nieuwsbrief', leverancier: lev.J.id, toelichting: 'proef', aangemaakt_door: W, aangemaakt_op: tijd(-100) });

    // ── facturen in alle statussen ──
    const facturen = [];
    let volg = 0;
    function stuk(regels, soort, bericht, n) {
      const bytes = soort === 'ubl' ? Buffer.from('<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><ID>' + regels[1] + '</ID><!-- synthetisch --></Invoice>')
        : pdf(regels);
      const s = D.stukSchrijf(fdb, bytes);
      tel.stukken++;
      const did = id();
      D.voegToe(fdb, 'document', { id: did, sha256: s.sha256, bericht: bericht || null, naam: (soort === 'ubl' ? 'factuur-' : 'factuur-') + n + (soort === 'ubl' ? '.xml' : '.pdf'),
        mime: soort === 'ubl' ? 'application/xml' : 'application/pdf', bytes: s.bytes, soort, tekstlaag: soort === 'pdf' ? 1 : null,
        geupload_door: bericht ? null : W, aangemaakt_op: tijd(-60) });
      return { id: did, sha256: s.sha256, naam: 'factuur-' + n + (soort === 'ubl' ? '.xml' : '.pdf'), mime: soort === 'ubl' ? 'application/xml' : 'application/pdf' };
    }
    const verstuurdIds = [];
    for (const [status, aantal] of VERDELING) {
      for (let i = 0; i < aantal; i++) {
        volg++;
        const fid = id();
        let letter = kies(LEVERANCIERS.filter((x) => x[1] !== 'prive').map((x) => x[0]));
        if (status === 'prive_archief') letter = 'K';
        else if (status === 'te_beoordelen' && i < 2) letter = 'K';   // privé nog te beoordelen
        const l = lev[letter];
        const nummer = 'ZA-' + String(2026000 + volg);
        const ouderdom = status === 'te_beoordelen' ? Math.floor(r() * 10) : 10 + Math.floor(r() * 80);
        const fdatum = dag(-ouderdom), verval = K.plusDagen(fdatum, 30);
        const creditnota = status === 'te_beoordelen' && i === 5;
        const excl = (creditnota ? -1 : 1) * (2000 + Math.floor(r() * 150000));
        const btw = Math.round(excl * 0.21), incl = excl + btw;
        const uitMail = r() < 0.7;
        let bericht = null;
        if (uitMail) {
          bericht = id();
          D.voegToe(fdb, 'bericht', { id: bericht, bron: bron.verzamelpostvak, message_id: 'proef-' + bericht, afzender: 'facturen@leverancier-' + letter.toLowerCase() + '.invalid',
            onderwerp: 'Factuur ' + nummer, datum_lokaal: fdatum + 'T08:00:00+02:00', ontvangen_op: tijd(-ouderdom, 8) });
        }
        const doc = stuk(['Leverancier ' + letter + ' B.V.', nummer, 'Factuurdatum ' + fdatum, 'Totaal ' + (incl / 100).toFixed(2) + ' EUR', 'synthetisch zaadstuk, geen echte factuur'], 'pdf', bericht, nummer);
        const metUbl = uitMail && r() < 0.25;
        const ubl = metUbl ? stuk(['Leverancier ' + letter + ' B.V.', nummer], 'ubl', bericht, nummer) : null;
        // entiteit: standaard van de leverancier; bij te_beoordelen soms nog open (scan) of afwijkend
        let entiteit = l.entiteit;
        if (status === 'te_beoordelen' && (i === 6 || i === 7)) entiteit = null;
        if (status === 'prive_archief') entiteit = 'prive';
        let betaalwijze = status === 'te_beoordelen' && (i === 6 || i === 8) ? 'onbekend' : l.betaalwijze;
        const nieuwIban = status === 'te_beoordelen' && (i === 2 || i === 3 || i === 4);
        const iban = nieuwIban ? maakIban('NL', 'TEST', '09' + String(volg).padStart(8, '0')) : l.iban;
        const bevestigd = !['te_beoordelen', 'geen_factuur', 'dubbel'].includes(status);
        let betaalspoor = null;
        if (bevestigd) {
          betaalspoor = K.betaalspoorBegin(betaalwijze);
          if (['verstuurd', 'concept_klaar'].includes(status)) {
            if (betaalwijze === 'zelf') betaalspoor = kies(['te_betalen', 'ingevoerd', 'betaald_gezien', 'betaald_gezien']);
            else if (betaalwijze === 'incasso') betaalspoor = kies(['incasso_verwacht', 'betaald_gezien']);
          }
        }
        const f = {
          id: fid, document: doc.id, ubl_document: ubl ? ubl.id : null, bericht, soort: creditnota ? 'creditnota' : 'factuur', leverancier: l.id,
          leverancier_naam: l.naam, nummer, factuurdatum: fdatum, vervaldatum: verval, excl, btw, incl,
          valuta: status === 'te_beoordelen' && i === 9 ? 'USD' : 'EUR', incl_eur: status === 'te_beoordelen' && i === 9 ? Math.round(incl * 0.92) : incl,
          iban, ibans_betaal: [iban], iban_nieuw: nieuwIban ? 1 : 0, ibans_onbekend: nieuwIban ? [iban] : [],
          kenmerk: r() < 0.4 ? 'KM' + String(volg).padStart(8, '0') : null, betaalwijze, entiteit,
          intern: 0, status, redenen: [entiteit ? 'Leverancier factureert altijd aan ' + entiteit : 'Geen entiteit herkend (scan)'],
          controles: [{ naam: 'bedragen', ok: true, ernst: 'fout' }, { naam: 'iban_mod97', ok: true, ernst: 'fout' }],
          patientkenmerk: status === 'te_beoordelen' && (i === 10 || i === 11) ? 1 : 0, alleen_eigenaar: status === 'te_beoordelen' && (i === 10 || i === 11) ? 1 : 0,
          dubbel_van: status === 'dubbel' ? verstuurdIds[i % Math.max(1, verstuurdIds.length)] || null : null,
          bevestigd_door: bevestigd ? W : null, bevestigd_op: bevestigd ? tijd(-ouderdom + 1, 9) : null, betaalspoor,
          ingevoerd_door: betaalspoor === 'ingevoerd' ? W : null, ingevoerd_op: betaalspoor === 'ingevoerd' ? tijd(-3, 10) : null,
          betaald_gezien_op: betaalspoor === 'betaald_gezien' ? dag(-Math.floor(ouderdom / 2)) : null,
          aangemaakt_op: tijd(-ouderdom, 8), bijgewerkt_op: tijd(-Math.max(0, ouderdom - 2), 9),
        };
        D.voegToe(fdb, 'factuur', f);
        D.voegToe(fdb, 'besluit', { factuur: fid, stap: 'entiteit', veld: 'entiteit', waarde: entiteit, bron: entiteit ? 'leverancier' : 'regel', toelichting: f.redenen[0], wanneer: f.aangemaakt_op });
        D.voegToe(fdb, 'besluit', { factuur: fid, stap: 'betaalwijze', veld: 'betaalwijze', waarde: betaalwijze, bron: 'leverancier', toelichting: 'leverancierstandaard', wanneer: f.aangemaakt_op });
        if (bevestigd) {
          D.voegToe(fdb, 'besluit', { factuur: fid, stap: 'bevestigen', veld: 'status', waarde: status === 'prive_archief' ? 'prive_archief' : 'in_wachtrij', bron: 'mens', wie: W, wanneer: f.bevestigd_op });
          D.audit(fdb, { wie: W, wat: 'bevestigen', object_soort: 'factuur', object_id: fid, entiteit, na: { status: status === 'prive_archief' ? 'prive_archief' : 'in_wachtrij', betaalspoor }, wanneer: f.bevestigd_op });
        }
        if (status === 'verstuurd' && dubbelKan(f)) verstuurdIds.push(fid);
        facturen.push(Object.assign({}, f, { doc, ubl, l }));

        // opdracht voor alles wat onderweg is naar de boekhouder
        const opStatus = { in_wachtrij: 'wacht', wordt_verstuurd: 'opgehaald', concept_klaar: 'gelukt', verstuurd: 'gelukt', verzending_mislukt: i % 2 ? 'geweigerd' : 'mislukt' }[status];
        if (opStatus) {
          const oid = id();
          const bijlagen = [{ naam: doc.naam, mime: doc.mime, sha256: doc.sha256 }].concat(ubl ? [{ naam: ubl.naam, mime: ubl.mime, sha256: ubl.sha256 }] : []);
          const doel = ent[entiteit].boekhoud_doel;
          const op = { id: oid, soort: 'boekhouder_factuur', doeladres: doel, regel: { factuur_id: fid, entiteit, bedrag_centen: incl, doeladres: doel }, bijlagen };
          const poging = opStatus === 'wacht' ? 0 : opStatus === 'mislukt' ? 3 : 1;
          D.voegToe(fdb, 'opdracht', { id: oid, soort: 'boekhouder_factuur', factuur: fid, entiteit, doeladres: doel, bijlagen, vingerafdruk: K.vingerafdruk(op),
            vingerafdruk_koerier: ['gelukt', 'geweigerd'].includes(opStatus) ? (opStatus === 'geweigerd' ? '0'.repeat(64) : K.vingerafdruk(op)) : null,
            verstuur_na: opStatus === 'wacht' ? tijd(0, 13 + (i % 4)) : tijd(-ouderdom + 1, 10), idempotentiesleutel: fid + ':' + oid, status: opStatus,
            opgehaald_op: opStatus === 'wacht' ? null : tijd(opStatus === 'opgehaald' ? 0 : -ouderdom + 1, 10.2), poging,
            verzend_reservering: ['gelukt', 'mislukt', 'opgehaald'].includes(opStatus) ? 'FV' + fid : null,   // het token van de koerier (wv855)
            verzend_reservering_op: ['gelukt', 'mislukt', 'opgehaald'].includes(opStatus) ? tijd(-ouderdom + 1, 10.25) : null,
            modus: opStatus === 'gelukt' ? 'concept' : null, extern_id: opStatus === 'gelukt' ? 'proef-concept-' + oid : null,
            fout: opStatus === 'geweigerd' ? 'vingerafdruk wijkt af' : opStatus === 'mislukt' ? 'HTTP 502 (proef)' : null,
            aangemaakt_door: W, aangemaakt_op: f.bevestigd_op, bijgewerkt_op: f.bijgewerkt_op });
          if (status === 'verzending_mislukt') {
            const s = B.maakSignaal('verzending_mislukt', { entiteit, leverancier: l.id, facturen: [fid], bedrag_centen: incl, details: { opdracht: oid, status: opStatus }, sleutel_extra: 'op=' + oid });
            signaal(s, f.bijgewerkt_op);
          }
        }
        if (status === 'dubbel' && f.dubbel_van) {
          signaal(B.maakSignaal('dubbele_factuur', { entiteit, leverancier: l.id, facturen: [fid, f.dubbel_van], bedrag_centen: incl }), f.aangemaakt_op);
        }
      }
    }
    function dubbelKan(f) { return f.soort === 'factuur'; }
    function signaal(s, wanneer, af) {
      const rij = { id: id(), sleutel: s.sleutel, soort: s.soort, titel: s.titel, entiteit: s.entiteit || null, leverancier: s.leverancier || null,
        transacties: s.transacties || [], facturen: s.facturen || [], bedrag_centen: s.bedrag_centen == null ? null : s.bedrag_centen,
        details: s.details || null, alleen_eigenaar: s.alleen_eigenaar ? 1 : 0, aangemaakt_op: wanneer };
      if (af) Object.assign(rij, { status: 'afgehandeld', afhandeling: af.afhandeling, les: af.les, wie: W, wanneer: af.wanneer || wanneer, sluimer_tot: af.sluimer_tot || null });
      D.voegToe(fdb, 'signaal', rij);
      return rij;
    }

    // ── POT-afschriften (bankluis-rekening, alleen eigenaar) ──
    const potAf = [];
    for (const [periode, st] of [['2026-08', 'verstuurd'], ['2026-09', 'klaar']]) {
      const mt = D.stukSchrijf(fdb, Buffer.from(':20:PROEF' + periode + '\r\n:25:' + rek.pot.iban + '\r\n:28C:1\r\n:60F:C' + periode.replace('-', '').slice(2) + '01EUR0,00\r\n:62F:C' + periode.replace('-', '').slice(2) + '30EUR0,00\r\n-'));
      const pd = D.stukSchrijf(fdb, pdf(['Afschrift POT ' + periode, 'synthetisch']));
      const md = id(), pdid = id(), aid = id();
      D.voegToe(fdb, 'document', { id: md, sha256: mt.sha256, naam: 'pot-' + periode + '.sta', mime: 'text/plain', bytes: mt.bytes, soort: 'mt940', geupload_door: W, aangemaakt_op: tijd(-20) });
      D.voegToe(fdb, 'document', { id: pdid, sha256: pd.sha256, naam: 'pot-' + periode + '.pdf', mime: 'application/pdf', bytes: pd.bytes, soort: 'pdf', tekstlaag: 1, geupload_door: W, aangemaakt_op: tijd(-20) });
      D.voegToe(fdb, 'pot_afschrift', { id: aid, rekening: rek.pot.id, periode, mt940_document: md, pdf_document: pdid, status: st, aangemaakt_op: tijd(-20), bijgewerkt_op: tijd(-19) });
      potAf.push(aid);
      if (st === 'verstuurd') {
        const oid = id(), doel = ent.pot.afschrift_doel;
        const bijlagen = [{ naam: 'pot-' + periode + '.sta', mime: 'text/plain', sha256: mt.sha256 }, { naam: 'pot-' + periode + '.pdf', mime: 'application/pdf', sha256: pd.sha256 }];
        const op = { id: oid, soort: 'boekhouder_afschrift', doeladres: doel, regel: { afschrift_id: aid, entiteit: 'pot', periode, doeladres: doel }, bijlagen };
        D.voegToe(fdb, 'opdracht', { id: oid, soort: 'boekhouder_afschrift', afschrift: aid, entiteit: 'pot', doeladres: doel, bijlagen, vingerafdruk: K.vingerafdruk(op),
          vingerafdruk_koerier: K.vingerafdruk(op), verstuur_na: tijd(-19, 10), idempotentiesleutel: aid + ':' + oid, status: 'gelukt', opgehaald_op: tijd(-19, 10.1), poging: 1,
          verzend_reservering: 'FA' + aid, verzend_reservering_op: tijd(-19, 10.15), modus: 'concept', extern_id: 'proef-concept-' + oid, aangemaakt_door: W, aangemaakt_op: tijd(-19, 9), bijgewerkt_op: tijd(-19, 10.2) });
      }
    }

    // ── bank: bestanden, transacties, uitzonderingen, koppelingen, voorstellen ──
    const uitz = {};
    for (const [cat, tegen, oms] of [['loon', null, 'salaris'], ['bankkosten', 'Proefbank N.V.', null], ['declaraties', 'Zorgverzekeraar Proef', null], ['belasting', 'Belastingdienst (proef)', null]]) {
      uitz[cat] = id();
      D.voegToe(fdb, 'uitzondering', { id: uitz[cat], richting: cat === 'declaraties' ? 'bij' : 'af', tegenpartij: tegen, omschrijving: oms, categorie: cat,
        toelichting: 'proef', aangemaakt_door: W, aangemaakt_op: tijd(-150) });
    }
    const bestanden = {};
    for (const s of ['tolgaarde', 'groenhouten', 'kostenmaatschap']) {
      bestanden[s] = id();
      D.voegToe(fdb, 'bank_bestand', { id: bestanden[s], sha256: D.sha256(Buffer.from('bankbestand-proef-' + s)), formaat: REKENINGEN[s][2], naam: s + '-proef.' + (s === 'kostenmaatschap' ? 'csv' : s === 'tolgaarde' ? 'sta' : 'tab'),
        aantal: 0, prive_weggegooid: s === 'groenhouten' ? 3 : 0, per_rekening: { [rek[s].iban]: 0 }, geupload_door: W, geupload_op: tijd(-2, 11) });
    }
    const txs = [];
    function tx(entiteit, o2) {
      const tid = id(), formaat = REKENINGEN[entiteit][2];
      const t = Object.assign({ id: tid, bestand: formaat === 'bankluis' ? null : bestanden[entiteit] || bestanden.tolgaarde, rekening: rek[entiteit].id, entiteit,
        eigen_iban: rek[entiteit].iban, valuta: 'EUR', formaat, entry_ref: (formaat === 'bankluis' ? 'bankluis:proef-pot|' : 'proef:') + tid,
        bankluis_sleutel: formaat === 'bankluis' ? 'proef-' + tid : null, bestand_op: formaat === 'bankluis' ? null : tijd(-2, 11),
        alleen_eigenaar: REKENINGEN[entiteit][4], aangemaakt_op: tijd(-2, 11) }, o2);
      if (!bestanden[entiteit] && formaat !== 'bankluis') return null;   // proef: alleen rekeningen met een proefbestand
      D.voegToe(fdb, 'bank_transactie', t);
      txs.push(t);
      return t;
    }
    // betalingen bij facturen met betaald_gezien
    for (const f of facturen.filter((x) => x.betaalspoor === 'betaald_gezien')) {
      const ent2 = bestanden[f.entiteit] ? f.entiteit : null;
      if (!ent2) continue;
      const t = tx(ent2, { boekdatum: f.betaald_gezien_op, bedrag_centen: -f.incl, tegenpartij_naam: f.l.naam, tegenpartij_iban: f.l.iban,
        omschrijving: (f.betaalwijze === 'incasso' ? 'Incasso ' : 'Betaling ') + f.nummer, kenmerk: f.kenmerk, is_incasso: f.betaalwijze === 'incasso' ? 1 : 0,
        incassant_id: f.betaalwijze === 'incasso' ? f.l.incassant : null, transactietype: f.betaalwijze === 'incasso' ? 'ABN:Incasso' : 'ABN:Overboeking' });
      if (t) D.voegToe(fdb, 'koppeling', { transactie: t.id, factuur: f.id, bron: f.betaalwijze === 'incasso' ? 'auto' : 'mens', methode: f.betaalwijze === 'incasso' ? 'incasso' : 'kenmerk',
        zekerheid: 0.95, volledig: f.betaalwijze === 'incasso' ? null : 1, wie: f.betaalwijze === 'incasso' ? null : W, wanneer: tijd(-1, 9) });
    }
    // stromen zonder factuur (uitzonderingen)
    for (let i = 0; i < 3; i++) tx('tolgaarde', { boekdatum: dag(-25 - i), bedrag_centen: -(450000 + i * 1000), tegenpartij_naam: 'Salarisbatch proef', omschrijving: 'salaris oktober (proef)', transactietype: 'ABN:Salaris', categorie: 'loon', uitzondering: uitz.loon });
    tx('groenhouten', { boekdatum: dag(-5), bedrag_centen: -1250, tegenpartij_naam: 'Proefbank N.V.', omschrijving: 'kosten betaalpakket', categorie: 'bankkosten', uitzondering: uitz.bankkosten });
    tx('groenhouten', { boekdatum: dag(-8), bedrag_centen: 2345600, tegenpartij_naam: 'Zorgverzekeraar Proef', omschrijving: 'declaraties kwartaal (proef)', categorie: 'declaraties', uitzondering: uitz.declaraties });
    tx('kostenmaatschap', { boekdatum: dag(-12), bedrag_centen: -500000, tegenpartij_naam: 'Huisartsenpraktijk Tolgaarde B.V.', tegenpartij_iban: rek.tolgaarde.iban, omschrijving: 'rekening-courant (proef)', categorie: 'rekening_courant' });
    // POT via de bankluis (alleen eigenaar)
    for (let i = 0; i < 4; i++) tx('pot', { boekdatum: dag(-10 - i * 7), bedrag_centen: -(320000 + i * 500), tegenpartij_naam: 'Salarisbatch POT (proef)', omschrijving: 'salaris (proef)', transactietype: 'bankluis:Salaris', categorie: 'loon' });
    // signaalbronnen: geen factuur, onbekend IBAN, dubbel betaald, mogelijk dubbel geüpload
    const gf = tx('tolgaarde', { boekdatum: dag(-15), bedrag_centen: -8900, tegenpartij_naam: 'Webwinkel Proef', tegenpartij_iban: maakIban('NL', 'TEST', '0700000001'), omschrijving: 'bestelling 4711 (proef)' });
    const oi = tx('groenhouten', { boekdatum: dag(-4), bedrag_centen: -45000, tegenpartij_naam: lev.C.naam, tegenpartij_iban: maakIban('NL', 'TEST', '0800000001'), omschrijving: 'factuur (proef)' });
    const db1 = tx('tolgaarde', { boekdatum: dag(-30), bedrag_centen: -12100, tegenpartij_naam: lev.B.naam, tegenpartij_iban: lev.B.iban, omschrijving: 'Betaling ZA-dubbel', is_incasso: 0 });
    const db2 = tx('tolgaarde', { boekdatum: dag(-28), bedrag_centen: -12100, tegenpartij_naam: lev.B.naam, tegenpartij_iban: lev.B.iban, omschrijving: 'Incasso ZA-dubbel', is_incasso: 1, incassant_id: lev.B.incassant });
    const du1 = tx('groenhouten', { boekdatum: dag(-6), bedrag_centen: -7600, tegenpartij_naam: 'Leverancier D B.V.', tegenpartij_iban: lev.D.iban, omschrijving: 'incasso (proef)' });
    const du2 = tx('groenhouten', { boekdatum: dag(-6), bedrag_centen: -7600, tegenpartij_naam: 'Leverancier D B.V.', tegenpartij_iban: lev.D.iban, omschrijving: 'incasso (proef)', bestand_op: tijd(-1, 11) });
    for (const s of Object.keys(bestanden)) {
      const n = txs.filter((t) => t.bestand === bestanden[s]).length;
      fdb.db.prepare('UPDATE bank_bestand SET aantal = ?, per_rekening = ? WHERE id = ?').run(n, JSON.stringify({ [rek[s].iban]: n }), bestanden[s]);
    }
    // voorstellen ter bevestiging
    const open = facturen.filter((f) => f.betaalspoor === 'te_betalen' && bestanden[f.entiteit]);
    for (const f of open.slice(0, 3)) {
      const t = tx(f.entiteit, { boekdatum: dag(-1), bedrag_centen: -f.incl, tegenpartij_naam: f.l.naam, tegenpartij_iban: f.l.iban, omschrijving: 'betaling (proef)' });
      if (t) D.voegToe(fdb, 'voorstel', { sleutel: 'voorstel:' + t.id + '|' + f.id, transactie: t.id, facturen: [f.id], methode: 'iban_bedrag', zekerheid: 0.7, aangemaakt_op: tijd(0, 6) });
    }
    // één signaal per soort (bovenop verzending_mislukt en dubbele_factuur uit de facturen); een paar afgehandeld met les
    const ingevoerd = facturen.find((f) => f.betaalspoor === 'ingevoerd');
    const incasso = facturen.find((f) => f.betaalspoor === 'incasso_verwacht');
    const teBetalen = facturen.find((f) => f.betaalspoor === 'te_betalen');
    if (gf) signaal(B.maakSignaal('geen_factuur', { entiteit: 'tolgaarde', transacties: [gf.id], bedrag_centen: gf.bedrag_centen }), tijd(0, 6));
    if (oi) signaal(B.maakSignaal('onbekend_iban', { entiteit: 'groenhouten', leverancier: lev.C.id, transacties: [oi.id], bedrag_centen: oi.bedrag_centen }), tijd(0, 6));
    if (db1 && db2) signaal(B.maakSignaal('dubbel_betaald', { entiteit: 'tolgaarde', leverancier: lev.B.id, transacties: [db1.id, db2.id], bedrag_centen: 12100, details: { nummer: 'ZA-dubbel', datums: [db1.boekdatum, db2.boekdatum] } }), tijd(0, 6));
    if (du1 && du2) signaal(B.maakSignaal('mogelijk_dubbel_geupload', { entiteit: 'groenhouten', leverancier: lev.D.id, transacties: [du1.id, du2.id], bedrag_centen: 7600, details: { te_verwijderen: du2.id } }), tijd(0, 6));
    if (incasso) signaal(B.maakSignaal('incasso_niet_gezien', { entiteit: incasso.entiteit, leverancier: incasso.l.id, facturen: [incasso.id], bedrag_centen: incasso.incl }), tijd(-3, 6),
      { afhandeling: 'afwachten', les: 'Incasso van ' + incasso.l.naam + ' komt later; over twee weken opnieuw kijken.', sluimer_tot: dag(11), wanneer: tijd(-3, 9) });
    // wv1415: een teruggeboekte batchbetaling (verzonnen; de factuur staat al weer op te betalen)
    if (teBetalen) signaal(B.maakSignaal('teruggeboekt', { entiteit: teBetalen.entiteit, leverancier: teBetalen.l.id, facturen: [teBetalen.id], bedrag_centen: teBetalen.incl,
      details: { nummer: teBetalen.nummer || null, automatisch: true } }), tijd(0, 6));
    if (teBetalen) signaal(B.maakSignaal('te_betalen_niet_betaald', { entiteit: teBetalen.entiteit, leverancier: teBetalen.l.id, facturen: [teBetalen.id], bedrag_centen: teBetalen.incl }), tijd(0, 6));
    if (ingevoerd) signaal(B.maakSignaal('ingevoerd_niet_gezien', { entiteit: ingevoerd.entiteit, leverancier: ingevoerd.l.id, facturen: [ingevoerd.id], bedrag_centen: ingevoerd.incl }), tijd(-10, 6),
      { afhandeling: 'opnieuw_kijken', les: 'Betaling aan ' + ingevoerd.l.naam + ' nog niet op de bank; over drie dagen opnieuw kijken.', sluimer_tot: dag(-7), wanneer: tijd(-10, 9) });
    D.metaZet(fdb, 'zaad', JSON.stringify({ vandaag, zaad: Number.isInteger(o.zaad) ? o.zaad : 824, door: 'test/facturen-zaad.js' }));
    return { facturen: facturen.length, stukken: tel.stukken, transacties: txs.length, tellingen: D.tellingen(fdb), ids: { eigenaar, praktijkmanager: pm, rekening: rek, afschriften: potAf } };
  });
}

module.exports = { zaai, maakIban, pdf, VERDELING };

if (require.main === module) {
  const a = process.argv.slice(2);
  const dir = a.find((x) => !x.startsWith('--'));
  if (!dir) { console.error('gebruik: node test/facturen-zaad.js <wegwerpmap> [--vandaag JJJJ-MM-DD] [--zaad N]'); process.exit(2); }
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  weigerEcht(dir);
  const fdb = D.open(dir);
  try {
    const u = zaai(fdb, { vandaag: opt('--vandaag'), zaad: opt('--zaad') ? Number(opt('--zaad')) : undefined });
    console.log(JSON.stringify({ map: dir, facturen: u.facturen, stukken: u.stukken, transacties: u.transacties, tellingen: u.tellingen }));
  } finally { D.sluit(fdb); }
}
