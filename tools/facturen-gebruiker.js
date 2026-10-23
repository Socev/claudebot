#!/usr/bin/env node
/*
 * facturen-gebruiker.js — gebruikers van de smalle Facturen-ingang (/fac, facturen.socev.dev) beheren (wv856, F6, 23-10-2026).
 * Bouwplan: vault "01_Ontwikkeling/Facturen-app - bouwplan (App, 22-10-2026).md" § 4.3. Draait op de pod (Olares, primaire kant), als
 * 'claude', tegen /opt/data/facturen/facturen.sqlite (of FACTUREN_DIR). Nooit vanuit een repo, de vault of een fixture: het e-mailadres
 * staat alleen in die database (en in de Access-policy, die tools/tunnel-inrichten.js facturen zet).
 *
 *   node tools/facturen-gebruiker.js zet <e-mail> [--naam <naam>] [--geen-bevestigen]
 *        ingang 'fac', rol praktijkmanager (de database staat via 'fac' niets anders toe), actief; entiteiten = alle actieve behalve Privé
 *        (bestaande rij: bijgewerkt, entiteiten opnieuw gezet). --geen-bevestigen: mag beoordelen en uploaden, niet Bevestigen.
 *   node tools/facturen-gebruiker.js uit <e-mail>     actief = 0 (de ingang weigert hem meteen; niets gewist)
 *   node tools/facturen-gebruiker.js lijst            fac-gebruikers: id, adres (gemaskeerd), actief, mag bevestigen, aantal entiteiten
 *
 * Uitvoer zonder volledige adressen (alleen eerste letter + domein).
 */
'use strict';
const path = require('path');
const crypto = require('crypto');
const D = require(path.join(__dirname, '..', 'facturen-db.js'));

const DIR = process.env.FACTUREN_DIR || '/opt/data/facturen';
const masker = (e) => { const s = String(e || ''); const i = s.indexOf('@'); return i > 0 ? s[0] + '…' + s.slice(i) : '…'; };

function hoofd(argv) {
  const [stap, adres] = argv;
  if (!['zet', 'uit', 'lijst'].includes(stap)) throw new Error('gebruik: zet <e-mail> [--naam …] [--geen-bevestigen] | uit <e-mail> | lijst');
  if (String(process.env.SOCEV_KANT || 'olares') !== 'olares') throw new Error('alleen op de Olares-kant (daar staat de facturendatabase)');
  const fdb = D.open(DIR);
  try {
    if (stap === 'lijst') {
      const rijen = fdb.db.prepare("SELECT g.id, g.email, g.actief, g.mag_bevestigen, (SELECT count(*) FROM gebruiker_entiteit e WHERE e.gebruiker = g.id) AS n FROM gebruiker g WHERE g.ingang = 'fac' ORDER BY g.id").all();
      if (!rijen.length) console.log('geen fac-gebruikers');
      for (const r of rijen) console.log(r.id + '  ' + masker(r.email) + '  actief=' + r.actief + '  bevestigen=' + r.mag_bevestigen + '  entiteiten=' + r.n);
      return;
    }
    const email = String(adres || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) || email.length > 254) throw new Error('geen geldig e-mailadres');
    if (stap === 'uit') {
      const n = fdb.db.prepare("UPDATE gebruiker SET actief = 0 WHERE email = ? AND ingang = 'fac'").run(email).changes;
      console.log(n ? 'uitgezet: ' + masker(email) : 'niet gevonden: ' + masker(email));
      return;
    }
    const i = argv.indexOf('--naam');
    const naam = i > 0 && argv[i + 1] ? String(argv[i + 1]).slice(0, 80) : null;
    const bevestigen = argv.includes('--geen-bevestigen') ? 0 : 1;
    const uit = D.transactie(fdb, function () {
      const ander = fdb.db.prepare("SELECT ingang FROM gebruiker WHERE email = ? AND ingang <> 'fac'").get(email);
      if (ander) throw new Error('dit adres staat al als gebruiker van een andere ingang');
      let g = fdb.db.prepare("SELECT id FROM gebruiker WHERE email = ? AND ingang = 'fac'").get(email);
      if (g) fdb.db.prepare('UPDATE gebruiker SET actief = 1, mag_bevestigen = ?, naam = coalesce(?, naam) WHERE id = ?').run(bevestigen, naam, g.id);
      else {
        g = { id: crypto.randomBytes(8).toString('hex') };
        D.voegToe(fdb, 'gebruiker', { id: g.id, email, naam, ingang: 'fac', rol: 'praktijkmanager', mag_bevestigen: bevestigen, actief: 1 });
      }
      fdb.db.prepare('DELETE FROM gebruiker_entiteit WHERE gebruiker = ?').run(g.id);
      const ents = fdb.db.prepare("SELECT sleutel FROM entiteit WHERE actief = 1 AND sleutel <> 'prive' ORDER BY sleutel").all().map((r) => r.sleutel);
      for (const e of ents) D.voegToe(fdb, 'gebruiker_entiteit', { gebruiker: g.id, entiteit: e });
      return { id: g.id, ents };
    });
    console.log('gezet: ' + masker(email) + ' (id ' + uit.id + ', praktijkmanager, bevestigen=' + bevestigen + ', entiteiten: ' + (uit.ents.join(', ') || 'geen') + ')');
  } finally { try { fdb.db.close(); } catch (e) {} }
}

if (require.main === module) {
  try { hoofd(process.argv.slice(2)); } catch (e) { console.error('FOUT: ' + (e && e.message || e)); process.exit(2); }
}
module.exports = { hoofd };
