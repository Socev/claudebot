#!/usr/bin/env node
// loper-volg-tick.js [pad naar socev-loper.js] — deterministische toets van wv785 (Fable wv715 #4): komt er een brok binnen
// in dezelfde poll-ronde als een volg-verzoek, maar ná dat verzoek, dan moet de volger hem krijgen. In de echte loper is
// dat venster zeldzaam (gemeten: 0 van 42 keer onder belasting); hier bootsen we het exact na met een nepverbinding.
// Daarna: na het afkappen blijft de buffer een aaneengesloten begin (Fable wv785 #7).
// Uitvoer: één JSON-regel {ok, …}; exit 0 = groen.
'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const L = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'socev-loper.js')))._toets;
if (!L.verbinding || !L.jobs || !L.voegToe) { console.log(JSON.stringify({ ok: false, reden: 'toets-haken ontbreken' })); process.exit(1); }
const leeg = () => ({ delen: [], lengte: 0, totaal: 0, afgekapt: false });
const j = { id: 'tick', brein: 'claude', pid: null, gestart: Date.now(), klaar: 0, code: null, signaal: null,
  uit: leeg(), fout: leeg(), volgers: new Set() };
L.jobs.set('tick', j);
L.voegToe(j, 'uit', Buffer.from('A'));
const sock = new EventEmitter();
sock.destroyed = false;
sock.setEncoding = function () {};
const berichten = [];
sock.write = function (t) { t.split('\n').filter(Boolean).forEach(function (r) { berichten.push(JSON.parse(r)); }); return true; };
L.verbinding(sock);
sock.emit('data', JSON.stringify({ op: 'volg', nr: 1, id: 'tick' }) + '\n');
L.voegToe(j, 'uit', Buffer.from('B'));          // zelfde tick: na het verzoek, vóór elke setImmediate
setImmediate(function () {
  setImmediate(function () {
    L.voegToe(j, 'uit', Buffer.from('C'));      // later live
    const uit = berichten.filter(function (m) { return m.ev === 'uit'; }).map(function (m) { return Buffer.from(m.b64, 'base64').toString(); }).join('');
    const eerst = berichten.length > 0 && berichten[0].nr === 1 && berichten[0].ok === true;
    // afkappen: een brok dat niet past, en daarna een klein brok dat wel zou passen, mogen niet in de buffer
    const k = { id: 'kap', uit: leeg(), fout: leeg(), volgers: new Set() };
    const groot = 64 * 1024 * 1024;
    L.voegToe(k, 'uit', Buffer.alloc(groot - 10, 0x61));
    L.voegToe(k, 'uit', Buffer.alloc(20, 0x62));
    L.voegToe(k, 'uit', Buffer.from('c'));
    const kapOk = k.uit.afgekapt === true && k.uit.lengte === groot - 10 && k.uit.totaal === groot + 11;
    const ok = eerst && uit === 'ABC' && kapOk;
    console.log(JSON.stringify({ ok: ok, uit: uit, antwoord_eerst: eerst, n: berichten.length, afkappen_ok: kapOk }));
    process.exit(ok ? 0 : 1);
  });
});
