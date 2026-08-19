#!/usr/bin/env node
/*
 * koppel-telegram.js — EENMALIG koppelscript voor de Telegram-lezer.
 *
 * Draai dit één keer, interactief, in de pod-terminal:
 *   node /app/koppel-telegram.js
 *
 * Wat het doet: inloggen op Davids Telegram-account met api_id/api_hash plus een
 * telefooncode, en de resulterende sessiestring RECHTSTREEKS in de Supabase Vault
 * zetten via de RPC public.sb_secret_toevoegen.
 *
 * WAT HET BEWUST NIET DOET:
 *   - De sessiestring komt NOOIT op het scherm, in een logregel of in een bestand.
 *     Hij bestaat alleen in het geheugen van dit proces (StringSession('') is
 *     memory-only) en gaat van daar rechtstreeks naar de kluis.
 *   - Telefoonnummer, code en 2FA-wachtwoord komen NOOIT via CLI-argumenten
 *     binnen, alleen via readline. Argumenten staan in /proc/PID/cmdline en zijn
 *     leesbaar voor elk proces van dezelfde gebruiker.
 *   - Het script verstuurt geen berichten en markeert niets als gelezen.
 *
 * ENV: TELEGRAM_API_ID, TELEGRAM_API_HASH, SUPABASE_URL, SUPABASE_ANON_KEY.
 */
const readline = require('readline');

// Eenmalige invoercode voor de Vault-RPC. Bewust in de code: hij is één keer
// bruikbaar, deze koppeling is een eenmalige handeling, en na gebruik hoort hij
// door David te worden ingetrokken. Dit is GEEN doorlopend werkgeheim.
const INVOERCODE = 'BFA23121';

const SECRET_NAAM = 'telegram_sessie';
const OMSCHRIJVING =
  'MTProto-sessiestring voor telegram-reader.js (lezend luik op Davids Telegram-account). ' +
  'Regenereren: node /app/koppel-telegram.js opnieuw draaien. ' +
  'Intrekken: Telegram > Instellingen > Apparaten > sessie "Socev reader" beëindigen.';

function vraag(rl, tekst) {
  return new Promise(function (resolve) { rl.question(tekst, function (a) { resolve(a.trim()); }); });
}

async function naarVault(sessie) {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL of SUPABASE_ANON_KEY ontbreekt in de omgeving.');

  const res = await fetch(url + '/rest/v1/rpc/sb_secret_toevoegen', {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      p_code: INVOERCODE,
      p_naam: SECRET_NAAM,
      p_waarde: sessie,
      p_omschrijving: OMSCHRIJVING
    })
  });

  const tekst = await res.text();
  if (!res.ok) throw new Error('RPC gaf HTTP ' + res.status);
  let j = null;
  try { j = JSON.parse(tekst); } catch (e) { /* stil: het antwoord kan de waarde citeren */ }
  if (j && j.ok === false) throw new Error('RPC weigerde de invoer (code al gebruikt of ongeldig?).');
  return true;
}

(async function () {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  if (!apiId || !apiHash) {
    process.stderr.write('TELEGRAM_API_ID of TELEGRAM_API_HASH ontbreekt in de omgeving.\n');
    process.exit(78);
  }

  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Lege StringSession = memory-only. Er wordt niets naar schijf geschreven.
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: 'Socev reader',
    systemVersion: 'pod',
    appVersion: '1.0',
    // Zie telegram-reader.js: kale MTProto over TCP wordt door de egress
    // geaccepteerd maar niet doorgelaten; alleen websocket over TLS werkt.
    useWSS: true
  });
  client.setLogLevel('error');

  process.stdout.write('\nKoppelen van de Telegram-lezer. Alle invoer gaat via dit scherm.\n\n');

  try {
    await client.start({
      phoneNumber: async function () { return await vraag(rl, 'Telefoonnummer (met landcode, bv. +316...): '); },
      phoneCode:   async function () { return await vraag(rl, 'Code die Telegram net stuurde: '); },
      password:    async function () { return await vraag(rl, 'Tweestapswachtwoord (leeg laten als je er geen hebt): '); },
      onError:     function (e) { process.stderr.write('Inlogfout: ' + (e && e.message ? e.message : e) + '\n'); }
    });

    const sessie = client.session.save();
    if (!sessie || sessie.length < 20) throw new Error('geen bruikbare sessiestring gekregen.');

    await naarVault(sessie);

    // Alleen de LENGTE, nooit de waarde.
    process.stdout.write('\nsessie opgeslagen als ' + SECRET_NAAM + ' (lengte ' + sessie.length + ')\n');
    process.stdout.write([
      '',
      'Nog drie dingen die jij moet doen:',
      '  1. Herstart de pod. Pas dan haalt fetch-secrets.sh de nieuwe sessie op.',
      '  2. Bevestig de nieuwe-login-melding die Telegram zo op je telefoon toont;',
      '     de sessie heet "Socev reader".',
      '  3. Controleer in Telegram > Instellingen > Apparaten de instelling',
      '     "Terminate old sessions if away" — staat die kort, dan wordt de lezer',
      '     vanzelf uitgelogd en moet je opnieuw koppelen.',
      '',
      'Intrekken kan altijd: Telegram > Instellingen > Apparaten > sessie beëindigen.',
      ''
    ].join('\n'));
  } catch (e) {
    process.stderr.write('\nKoppelen mislukt: ' + (e && e.message ? e.message : e) + '\n');
    process.exitCode = 1;
  } finally {
    rl.close();
    await client.disconnect().catch(function () {});
    // Belangrijk: niets van de sessie achterlaten in dit proces.
    try { client.session.delete(); } catch (e) {}
  }
})();
