#!/usr/bin/env bash
# Toetst secondbrain.js (wv832, App Second Brain; bouwplan "01_Ontwikkeling/Second Brain - Obsidian-browser in de app (bouwplan 22-10-2026).md")
# en de koppeling in server.js. Toetst: kaart (domeinen, nooit-mappen, conflictkopie, symlink, extensies, verborgen, vaste plek), linkoplossing
# (exact pad, naam, hoofdletters/NFC, zelfde map, dubbelzinnig, #kop, |tekst, \| in tabel, embed, md-link met %20, codeblok genegeerd),
# backlinks, openen (masker, frontmatter, .., absoluut, NUL, niet in kaart, vast + privé/personeel, symlink na de bouw, te groot), bestand
# (alleen niet-md, tekst gemaskeerd, twee tegelijk), zoeken (naam, tekst, accenten, verborgen, vast, fragment gemaskeerd, betekenis gefilterd),
# kaart.json 0600 buiten de vault, koppeltabel Financiën, en server.js (dispatch, grenzen, glijdroutes, invoerslot, audit zonder pad, /health,
# verrijking Financiën, uitrol-lijst, Dockerfile). Raakt de echte vault niet. Gebruik: bash test/secondbrain.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const S = require('./secondbrain.js');
let fouten = 0, goed = 0;
function toets(naam, ok, extra) { if (ok) goed++; else fouten++; console.log((ok ? 'GROEN ' : 'ROOD  ') + naam + (!ok && extra !== undefined ? '  [' + JSON.stringify(extra).slice(0, 600) + ']' : '')); }

(async function () {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'sb832-'));
  const V = path.join(W, 'vault'), D = path.join(W, 'staat');
  const zet = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
  const TOKEN = 'abcd_' + 'Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR'.repeat(1);
  zet('index.md', '# Index\n[[Systeemoverzicht]] en [[10_Zakelijk/Tolgaarde/Verzekeringen|verzekeringen]] en [[Bestaat niet]]\n');
  zet('00_Systeem/Systeemoverzicht.md', '---\ntitel: Systeem\napi_key: ' + 'z'.repeat(8) + '1234567890abcdef\nverwant:\n  - "[[index]]"\n---\n# Systeem\nZie [[index#Kop]] en [[#Eigen kop]].\n```\n[[In codeblok]]\n```\nInline `[[ook niet]]`.\nToken ' + TOKEN + ' hier.\nhttps://drive.google.com/file/d/1AbC2dEf3GhI4jKl5MnO6pQr7StU8vWx/view\n');
  zet('00_Systeem/Beveiliging/Sleutelregister.md', '# geheim\n');
  zet('00_Systeem/Tokens/dag.jsonl', '{}\n');
  zet('00_Systeem/Meldingen/machinekamer.md', '# box\n');
  zet('TempFinData/cf_token.txt', TOKEN + '\n');
  zet('Claude outputs/x.pdf', '%PDF');
  zet('01_Ontwikkeling/0b-werkmap/a.md', '# a\n');
  zet('01_Ontwikkeling/Plan.md', '# Plan\n| a | [[10_Zakelijk/Tolgaarde/Verzekeringen\\|tabel]] |\n![[schema.png]]\n[md-link](../10_Zakelijk/Tolgaarde/Mijn%20contract.md)\n[[david schaap]]\n[[Notulen]]\n');
  zet('01_Ontwikkeling/schema.png', Buffer.from('89504e470d0a1a0a', 'hex'));
  zet('01_Ontwikkeling/script.js', 'x');
  zet('01_Ontwikkeling/pagina.html', '<b>x</b>');
  zet('01_Ontwikkeling/Plan.md.conflict1', '# oud\n');
  zet('10_Zakelijk/Tolgaarde/Verzekeringen.md', '# Verzekeringen\nCentraal Beheer, polis. Financiën en café.\n');
  zet('10_Zakelijk/Tolgaarde/Mijn contract.md', '# contract\n');
  zet('10_Zakelijk/Tolgaarde/Notulen.md', '# notulen T\n[[Notulen]]\n');
  zet('10_Zakelijk/Groenhouten/Notulen.md', '# notulen G\n');
  zet('10_Zakelijk/Tolgaarde/Medewerkers/Jan Jansen.md', '# Jan\nNL12ABNA0123456789\n');
  zet('10_Zakelijk/Tolgaarde/Bronnen/scan.pdf', '%PDF-1.4');
  zet('10_Zakelijk/Tolgaarde/Bronnen/_register.md', '# register\nverzekering bron\n');
  zet('10_Zakelijk/HAGRO/David Schaap.md', '# David HAGRO\n');
  zet('20_Prive/Gambia/David Schaap.md', '# David Gambia\n');
  zet('20_Prive/Gezondheid/Bloed.md', '# bloed\nverzekering privé\n');
  zet('20_Prive/Financien/data.csv', 'a;b\npassword=' + 'Pw'.repeat(5) + '1234567890\n');
  zet('20_Prive/Financien/Financiën - koppeling Second Brain.md', '| tegenpartij | pagina |\n|---|---|\n| Centraal Beheer B.V. | [[10_Zakelijk/Tolgaarde/Verzekeringen]] |\n| Weg | [[Bestaat niet]] |\n');
  zet('30_Conversaties/WhatsApp/2026-10-22.md', '# dump\nverzekering in gesprek\n');
  zet('.obsidian/app.json', '{}');
  zet('.git/HEAD', 'ref');
  zet('node_modules/x/index.md', '# nm');
  fs.symlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Verzekeringen.md'), path.join(V, '01_Ontwikkeling/link.md'));
  fs.symlinkSync('/etc', path.join(V, '01_Ontwikkeling/etc'));
  zet('01_Ontwikkeling/Groot.md', '# groot\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
  // NFD-naam (macOS/Drive) moet ook via NFC vindbaar zijn
  zet('10_Zakelijk/Holding/Café notitie.md', '# cafe\n');

  zet('01_Ontwikkeling/Beveiliging/CISO.md', '# ciso\n');
  const sb = S.maak({ vault: V, dir: D, fout: (w, e) => console.error('fout', w, e && e.message), hmac: (p) => 'h' + Buffer.from(p).toString('hex').slice(0, 15),
    bsnMasker: (t) => String(t).replace(/\b\d{9}\b/g, '[BSN]'),
    betekenis: async (q) => [{ key: 'vault/20_Prive/Gezondheid/Bloed.md', text: 'privé ' + TOKEN }, { key: 'vault/10_Zakelijk/Tolgaarde/Verzekeringen.md', text: 'polis' },
      { key: 'vault/weg/oud.md', text: 'oud' }, { key: 'vault/10_Zakelijk/Tolgaarde/Bronnen/_register.md', text: 'bron' }] });
  sb.mkdir();
  const k = await sb.app('POST /app/secondbrain/kaart', { alles: true }, {});
  const paden = k.j.knopen.map((x) => x[0]);
  toets('1 kaart: 200 met knopen en lijnen', k.status === 200 && paden.length > 10 && k.j.lijnen.length > 0, k.j);
  const nooit = ['00_Systeem/Tokens/dag.jsonl',
    '01_Ontwikkeling/script.js', '01_Ontwikkeling/pagina.html', '01_Ontwikkeling/Plan.md.conflict1', '.obsidian/app.json', '.git/HEAD', 'node_modules/x/index.md', '01_Ontwikkeling/link.md'];
  toets('1 nooit in de kaart (onbekende soort, code, html, conflictkopie, punt-mappen, node_modules, symlink)',
    nooit.every((p) => paden.indexOf(p) < 0), nooit.filter((p) => paden.indexOf(p) >= 0));
  const nuWel = ['00_Systeem/Beveiliging/Sleutelregister.md', 'TempFinData/cf_token.txt', 'Claude outputs/x.pdf', '01_Ontwikkeling/0b-werkmap/a.md'];
  toets('1 wv1931: Beveiliging, TempFinData, Claude outputs, 0b-werkmap wel in de kaart (geen afscherming naar David)',
    nuWel.every((p) => paden.indexOf(p) >= 0), nuWel.filter((p) => paden.indexOf(p) < 0));
  toets('1 niets uit een symlink-map', !paden.some((p) => p.indexOf('01_Ontwikkeling/etc') === 0));
  toets('1 wel: md, png, pdf in Bronnen, csv', ['index.md', '01_Ontwikkeling/schema.png', '10_Zakelijk/Tolgaarde/Bronnen/scan.pdf', '20_Prive/Financien/data.csv'].every((p) => paden.indexOf(p) >= 0));
  const dom = (p) => k.j.domeinen[k.j.knopen.find((x) => x[0] === p)[1]].naam;
  toets('1 domeinen: Tolgaarde, Groenhouten, Privé, Systeem, Ontwikkeling, Gesprekken, Vault', dom('10_Zakelijk/Tolgaarde/Verzekeringen.md') === 'Tolgaarde' && dom('10_Zakelijk/Groenhouten/Notulen.md') === 'Groenhouten' &&
    dom('20_Prive/Gezondheid/Bloed.md') === 'Privé' && dom('00_Systeem/Systeemoverzicht.md') === 'Systeem' && dom('01_Ontwikkeling/Plan.md') === 'Ontwikkeling' &&
    dom('30_Conversaties/WhatsApp/2026-10-22.md') === 'Gesprekken' && dom('index.md') === 'Vault');
  const std = await sb.app('GET /app/secondbrain', {}, {});
  const sp = std.j.knopen.map((x) => x[0]);
  toets('1 standaard zonder Bronnen en 30_Conversaties (P4), met teller', !sp.some((p) => /\/Bronnen\//.test(p) || /^30_Conversaties\//.test(p)) && std.j.verborgen_n === 3, { n: std.j.verborgen_n });
  const vast = await sb.app('POST /app/secondbrain/kaart', { alles: true }, { vast: true });
  const vp = vast.j.knopen.map((x) => x[0]);
  toets('1 vaste plek: geen 20_Prive, 30_Conversaties, Medewerkers, Meldingen (P2)', !vp.some((p) => /^20_Prive\//.test(p) || /^30_Conversaties\//.test(p) || /\/Medewerkers\//.test(p) || /^00_Systeem\/Meldingen\//.test(p)) && vp.indexOf('index.md') >= 0, vp);
  toets('1 lijnen verwijzen alleen naar knopen in het antwoord', vast.j.lijnen.every((i) => i >= 0 && i < vast.j.knopen.length));
  toets('1 kaart.json 0600 in een 0700-map buiten de vault', (fs.statSync(path.join(D, 'kaart.json')).mode & 0o777) === 0o600 && (fs.statSync(D).mode & 0o777) === 0o700 && !fs.existsSync(path.join(V, 'kaart.json')));
  const kj = fs.readFileSync(path.join(D, 'kaart.json'), 'utf8');
  toets('1 kaart.json zonder inhoud (geen paginatekst, geen token)', kj.indexOf('Centraal Beheer') < 0 && kj.indexOf(TOKEN) < 0 && kj.indexOf('notulen T') < 0);

  // ── 2. links ──
  const o = await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/Plan.md' }, {});
  const dl = o.j.doelen || {};
  toets('2 \\| in tabel: doel goed', dl['10_Zakelijk/Tolgaarde/Verzekeringen'] && dl['10_Zakelijk/Tolgaarde/Verzekeringen'].p === '10_Zakelijk/Tolgaarde/Verzekeringen.md', dl);
  toets('2 embed ![[schema.png]] in dezelfde map', dl['schema.png'] && dl['schema.png'].p === '01_Ontwikkeling/schema.png' && dl['schema.png'].s === 'beeld', dl['schema.png']);
  toets('2 md-link met %20 en ../', dl['../10_Zakelijk/Tolgaarde/Mijn%20contract.md'] && dl['../10_Zakelijk/Tolgaarde/Mijn%20contract.md'].p === '10_Zakelijk/Tolgaarde/Mijn contract.md', dl);
  toets('2 dubbelzinnig (twee keer David Schaap.md, hoofdletters anders): kandidaten, geen gok', dl['david schaap'] && Array.isArray(dl['david schaap'].k) && dl['david schaap'].k.length === 2, dl['david schaap']);
  toets('2 dubbelzinnig Notulen vanuit 01_Ontwikkeling: kandidaten', dl['Notulen'] && dl['Notulen'].k && dl['Notulen'].k.length === 2, dl['Notulen']);
  const ot = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Notulen.md' }, {});
  toets('2 Notulen vanuit Tolgaarde: zelfde map wint (zichzelf)', ot.j.doelen['Notulen'] && ot.j.doelen['Notulen'].p === '10_Zakelijk/Tolgaarde/Notulen.md', ot.j.doelen);
  const os2 = await sb.app('POST /app/secondbrain/open', { pad: '00_Systeem/Systeemoverzicht.md' }, {});
  toets('2 #kop: naar index; [[#Eigen kop]] = deze pagina', os2.j.doelen['index#Kop'].p === 'index.md' && os2.j.doelen['#Eigen kop'].p === '00_Systeem/Systeemoverzicht.md', os2.j.doelen);
  toets('2 codeblok en inline code genegeerd', !('In codeblok' in os2.j.doelen) && !('ook niet' in os2.j.doelen), Object.keys(os2.j.doelen));
  toets('2 link in frontmatter telt mee (verwant)', os2.j.doelen['index'] && os2.j.doelen['index'].p === 'index.md');
  const oi = await sb.app('POST /app/secondbrain/open', { pad: 'index.md' }, {});
  toets('2 onbekend doel = null', oi.j.doelen['Bestaat niet'] === null && oi.j.doelen['Systeemoverzicht'].p === '00_Systeem/Systeemoverzicht.md', oi.j.doelen);
  toets('2 linksIn: [[a|b]] en ![[c]]', JSON.stringify(S.linksIn('x [[a|b]] ![[c.png]] [d](e%20f.md)').map((l) => l.doel)) === '["a","c.png","e f.md"]');

  // ── 3. backlinks en openen ──
  const ov = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, {});
  toets('3 backlinks: index en Plan', ov.j.terug.indexOf('index.md') >= 0 && ov.j.terug.indexOf('01_Ontwikkeling/Plan.md') >= 0, ov.j.terug);
  toets('3 audit: domein + hmac, nooit het pad', ov.audit.domein === 'Tolgaarde' && /^h[0-9a-f]+$/.test(ov.audit.h) && JSON.stringify(ov.audit).indexOf('Verzekeringen') < 0, ov.audit);
  toets('3 masker: token in de tekst weg, Drive-link blijft', os2.j.md.indexOf(TOKEN) < 0 && /\[sleutel weggelaten\]/.test(os2.j.md) && os2.j.md.indexOf('1AbC2dEf3GhI4jKl5MnO6pQr7StU8vWx') >= 0, os2.j.md);
  const ap = os2.j.eigenschappen.find((e) => e.naam === 'api_key');
  toets('3 frontmatter apart en gemaskeerd', !/^---/.test(os2.j.md) && ap && ap.waarde === '[sleutel weggelaten]' && os2.j.eigenschappen.find((e) => e.naam === 'verwant').waarde.indexOf('[[index]]') >= 0, os2.j.eigenschappen);
  const slecht = ['../etc/passwd', '/etc/passwd', '01_Ontwikkeling/../index.md', 'index.md\u0000', '', '01_Ontwikkeling/link.md', '01_Ontwikkeling/etc/passwd', 'bestaat/niet.md'];
  const sl = [];
  for (const p of slecht) sl.push((await sb.app('POST /app/secondbrain/open', { pad: p }, {})).status);
  toets('3 openen weigert .., absoluut, NUL, leeg, symlink, onbekend (404)', sl.every((s) => s === 404), sl);
  const tf = await sb.app('POST /app/secondbrain/bestand', { pad: 'TempFinData/cf_token.txt' }, {});
  const tfT = tf.j && tf.j.inhoud ? Buffer.from(tf.j.inhoud, 'base64').toString('utf8') : '';
  toets('3 wv1931: TempFinData opent (200), sleutel gemaskeerd', tf.status === 200 && tfT.indexOf(TOKEN) < 0 && /sleutel weggelaten/.test(tfT), tf.status + ' ' + tfT.slice(0, 120));
  const vastP = [];
  for (const p of ['20_Prive/Gezondheid/Bloed.md', '10_Zakelijk/Tolgaarde/Medewerkers/Jan Jansen.md', '00_Systeem/Meldingen/machinekamer.md', '30_Conversaties/WhatsApp/2026-10-22.md'])
    vastP.push((await sb.app('POST /app/secondbrain/open', { pad: p }, { vast: true })).status);
  toets('3 vaste plek: privé, personeel, box, gesprekken dicht (404)', vastP.every((s) => s === 404), vastP);
  const ovv = await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/Plan.md' }, { vast: true });
  toets('3 vaste plek: link naar David Schaap (HAGRO + Gambia) wordt één kandidaat (Gambia valt weg)', ovv.j.doelen['david schaap'] && ovv.j.doelen['david schaap'].p === '10_Zakelijk/HAGRO/David Schaap.md', ovv.j.doelen['david schaap']);
  const ovb = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, { vast: true });
  toets('3 vaste plek: backlinks zonder dichte bronnen', ovb.j.terug.every((p) => !/^20_Prive|Medewerkers|^30_/.test(p)));
  toets('3 NFC: NFD-bestandsnaam ook met NFC-pad te openen', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Holding/Café notitie.md' }, {})).status === 200);
  toets('3 groter dan 2 MB: 413', (await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/Groot.md' }, {})).status === 413);
  toets('3 een niet-md via open: 404', (await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/schema.png' }, {})).status === 404);
  // symlink die na de bouw in de plaats van een bestand komt (TOCTOU): weigeren
  fs.unlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Mijn contract.md'));
  fs.symlinkSync('/etc/hostname', path.join(V, '10_Zakelijk/Tolgaarde/Mijn contract.md'));
  toets('3 symlink na de bouw: 404', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Mijn contract.md' }, {})).status === 404);
  const vm = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Medewerkers/Jan Jansen.md' }, {});
  toets('3 telefoon: personeel wel, IBAN niet gemaskeerd (alleen op vast)', vm.status === 200 && vm.j.md.indexOf('NL12ABNA0123456789') >= 0);

  // Fable diffreview: op een vaste plek is verborgen (Bronnen) ook dicht, ook met alles
  toets('3 vaste plek: Bronnen (verborgen) dicht, ook via open', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Bronnen/_register.md' }, { vast: true })).status === 404 &&
    (await sb.app('POST /app/secondbrain/bestand', { pad: '10_Zakelijk/Tolgaarde/Bronnen/scan.pdf' }, { vast: true })).status === 404);
  toets('3 vaste plek: kaart met alles zonder Bronnen', !(await sb.app('POST /app/secondbrain/kaart', { alles: true }, { vast: true })).j.knopen.some((x) => /\/Bronnen\//.test(x[0])));
  const a404 = await sb.app('POST /app/secondbrain/open', { pad: '20_Prive/Gezondheid/Bloed.md' }, { vast: true });
  toets('3 audit bij 404: hmac van het gevraagde pad, geen domein, geen pad', a404.audit.h && a404.audit.domein === null && JSON.stringify(a404.audit).indexOf('Bloed') < 0, a404.audit);
  // ── 4. bestand ──
  const b1 = await sb.app('POST /app/secondbrain/bestand', { pad: '01_Ontwikkeling/schema.png' }, {});
  toets('4 bestand: beeld als base64 met type', b1.status === 200 && b1.j.type === 'image/png' && Buffer.from(b1.j.inhoud, 'base64').toString('hex') === '89504e470d0a1a0a', b1.j);
  const b2 = await sb.app('POST /app/secondbrain/bestand', { pad: '20_Prive/Financien/data.csv' }, {});
  toets('4 bestand: tekst door het masker', b2.status === 200 && Buffer.from(b2.j.inhoud, 'base64').toString('utf8').indexOf('[sleutel weggelaten]') >= 0, Buffer.from(b2.j.inhoud || '', 'base64').toString());
  toets('4 bestand: md via bestand = 404', (await sb.app('POST /app/secondbrain/bestand', { pad: 'index.md' }, {})).status === 404);
  toets('4 bestand: vaste plek + privé = 404', (await sb.app('POST /app/secondbrain/bestand', { pad: '20_Prive/Financien/data.csv' }, { vast: true })).status === 404);
  toets('4 bestand: pdf in Bronnen (verborgen) wel te openen', (await sb.app('POST /app/secondbrain/bestand', { pad: '10_Zakelijk/Tolgaarde/Bronnen/scan.pdf' }, {})).status === 200);

  // ── 5. zoeken ──
  const z1 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering' }, {});
  const zp = z1.j.treffers.map((t) => t.pad);
  toets('5 zoeken: naam en tekst, standaard zonder Bronnen en gesprekken', zp.indexOf('10_Zakelijk/Tolgaarde/Verzekeringen.md') >= 0 && zp.indexOf('20_Prive/Gezondheid/Bloed.md') >= 0 &&
    !zp.some((p) => /Bronnen|^30_/.test(p)), zp);
  const z2 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering', alles: true }, {});
  toets('5 zoeken met alles: ook Bronnen en gesprekken', z2.j.treffers.some((t) => /Bronnen/.test(t.pad)) && z2.j.treffers.some((t) => /^30_/.test(t.pad)));
  const z3 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering', alles: true }, { vast: true });
  toets('5 zoeken op vast: geen privé of gesprekken', !z3.j.treffers.some((t) => /^20_|^30_/.test(t.pad)), z3.j.treffers);
  const z4 = await sb.app('POST /app/secondbrain/zoek', { q: 'financien cafe' }, {});
  toets('5 zoeken zonder accenten vindt Financiën en café', z4.j.treffers.some((t) => t.pad === '10_Zakelijk/Tolgaarde/Verzekeringen.md'), z4.j);
  const z5 = await sb.app('POST /app/secondbrain/zoek', { q: 'Token' }, {});
  toets('5 fragment gemaskeerd', z5.j.treffers.length > 0 && z5.j.treffers.every((t) => t.fragment.indexOf(TOKEN) < 0), z5.j.treffers);
  toets('5 te korte vraag: 400', (await sb.app('POST /app/secondbrain/zoek', { q: 'a' }, {})).status === 400);
  const zb = await sb.app('POST /app/secondbrain/zoek', { q: 'polis', betekenis: true }, {});
  toets('5 betekenis: treffers buiten de kaart en verborgen weg, fragment gemaskeerd', zb.j.treffers.map((t) => t.pad).join() === '20_Prive/Gezondheid/Bloed.md,10_Zakelijk/Tolgaarde/Verzekeringen.md' &&
    zb.j.treffers[0].fragment.indexOf(TOKEN) < 0, zb.j.treffers);
  const zbv = await sb.app('POST /app/secondbrain/zoek', { q: 'polis', betekenis: true }, { vast: true });
  toets('5 betekenis op vast: geen privé', zbv.j.treffers.map((t) => t.pad).join() === '10_Zakelijk/Tolgaarde/Verzekeringen.md', zbv.j.treffers);

  // ── 6. Financiën-koppeltabel ──
  toets('6 koppel: "Centraal Beheer" (zonder B.V., andere hoofdletters) → pagina', sb.koppelNaam('CENTRAAL BEHEER') === '10_Zakelijk/Tolgaarde/Verzekeringen.md' && sb.koppelNaam('Weg') === null && sb.koppelNaam('Iets anders') === null);

  const zv = await sb.app('POST /app/secondbrain/zoek', { q: 'bron', alles: true }, { vast: true });
  toets('5 zoeken op vast met alles: geen Bronnen', !zv.j.treffers.some((t) => /Bronnen/.test(t.pad)), zv.j.treffers);
  // fragment: een sleutel op de knipgrens (60 tekens voor de treffer) blijft gemaskeerd (Fable diffreview K4)
  const lang = 'Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR';
  zet('01_Ontwikkeling/Grens.md', '# grens\n' + 'x'.repeat(30) + ' ' + lang + ' ' + 'y'.repeat(5) + ' grenswoord hier\n');
  sb.vers(true);
  const zg = await sb.app('POST /app/secondbrain/zoek', { q: 'grenswoord' }, {});
  toets('5 fragment: geen stuk van een sleutel op de knipgrens', zg.j.treffers.length === 1 && !/[A-Za-z0-9]{8,}/.test(zg.j.treffers[0].fragment.replace('grenswoord', '').replace(/sleutel weggelaten/, '').replace(/x{8,}|y+/g, '')), zg.j.treffers);
  // onbekend pad: hooguit eens per 10 s een geforceerde herbouw (Fable diffreview K6)
  for (let i = 0; i < 5; i++) await sb.app('POST /app/secondbrain/open', { pad: 'bestaat/niet' + i + '.md' }, {});
  const naBouw = sb.health().gebouwd;
  await new Promise((r) => setTimeout(r, 5));
  await sb.app('POST /app/secondbrain/open', { pad: 'bestaat/nogniet.md' }, {});
  toets('3 onbekend pad: hooguit één geforceerde herbouw per 10 s', sb.health().gebouwd === naBouw, [naBouw, sb.health().gebouwd]);

  // ── 7. masker los ──
  const m = S.masker;
  toets('7 masker: jwt, sk-, github, bearer, private key, AIza', ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'sk-' + 'a1'.repeat(15), 'ghp_' + 'A1'.repeat(15), 'Authorization: Bearer ' + 'abc123'.repeat(5),
    '-----BEGIN PRIVATE KEY-----\nMIIx\n-----END PRIVATE KEY-----', 'AIza' + 'Sy1'.repeat(12)].every((x) => m(x).indexOf('[sleutel weggelaten]') >= 0 && m(x).length < x.length + 21), ['x']);
  toets('7 masker laat namen staan (mk_werkvoorraad_tik_wv427, n8n-backup-2026-10-22.json, UUID, CLOUDFLARE_API_TOKEN)',
    ['mk_werkvoorraad_tik_eerlijke_beurt_wv427', 'n8n-backup-2026-10-22.json', '3569d2f6-35b7-4048-b65a-8839257ea464', 'sleutel: CLOUDFLARE_API_TOKEN', 'Arbeidsovereenkomst2026'].every((x) => m(x) === x));
  toets('7 masker: token na een punt, Slack- en Discord-webhook', m('x.' + lang) === 'x.[sleutel weggelaten]' && /services\/\[sleutel weggelaten\]$/.test(m('https://hooks.slack.com/services/T0/B0/abcXYZ123')) && /webhooks\/\[sleutel weggelaten\]$/.test(m('https://discord.com/api/webhooks/1/abc')));
  toets('7 masker vast: IBAN in kleine letters en buitenlands', m('nl91abna0417164300 en DE89 3704 0044 0532 0130 00', true) === '[IBAN weggelaten] en [IBAN weggelaten]', m('nl91abna0417164300 en DE89 3704 0044 0532 0130 00', true));
  toets('7 masker vast: IBAN en BSN weg', m('NL12 ABNA 0123 4567 89 en 123456782', true, (t) => t.replace(/\b\d{9}\b/g, '[BSN]')) === '[IBAN weggelaten] en [BSN]');

  // ── 8. podstart met bewaarde kaart, health ──
  const sb2 = S.maak({ vault: V, dir: D });
  sb2.laadBewaard();
  toets('8 podstart: bewaarde kaart wordt bij de eerste vraag vers gebouwd', sb2.health().knopen > 0 && (await sb2.app('GET /app/secondbrain', {}, {})).status === 200 && sb2.health().gebouwd !== null);
  toets('8 nacht: één keer per datum', sb.nacht('2026-10-23') === true && sb.nacht('2026-10-23') === false);
  toets('8 health zonder inhoud', JSON.stringify(sb.health()).indexOf('Verzekeringen') < 0 && sb.health().knopen > 0, sb.health());
  toets('8 onbekende route 404', (await sb.app('POST /app/secondbrain/wis', {}, {})).status === 404);

  // ── 9. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('9 dispatch GET /app/secondbrain en POST /app/secondbrain/* via appSecondBrain', /route === 'GET \/app\/secondbrain' \|\| route\.indexOf\('POST \/app\/secondbrain\/'\) === 0\) return typeof appSecondBrain === 'function'/.test(src));
  toets('9 grens 600/u en betekenis 60/u', /appTeller\('secondbrain', 600, 3600000\)/.test(src) && /appTeller\('secondbrain-betekenis', 60, 3600000\)/.test(src));
  toets('9 tellers vooraf in appStaat (anders crasht appTeller)', /tellers: \{[^}]*secondbrain: \[\], 'secondbrain-betekenis': \[\]/.test(src));
  toets('9 glijdroutes: open en zoek', /\['POST \/app\/secondbrain\/open', 'POST \/app\/secondbrain\/zoek'\]\.forEach\(function \(r\) \{ APP_GLIJD_ROUTES\.add\(r\); \}\);/.test(src));
  const slotVrij = /const APP_SLOT_VRIJ = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  toets('9 invoerslot op vaste plek geldt (niet in APP_SLOT_VRIJ)', slotVrij.indexOf('secondbrain') < 0);
  toets('9 audit: reden met domein en h=, niet het pad', /res\._app\.reden = 'secondbrain ' \+ actie \+ \(au\.domein \? ' ' \+ au\.domein : ''\) \+ \(au\.h \? ' h=' \+ au\.h : ''\)/.test(src) && !/res\._app\.reden = [^\n]*d\.pad/.test(src));
  toets('9 GET /app/secondbrain valt op een vaste plek onder het invoerslot', src.indexOf("  if (route === 'GET /app/secondbrain') return true;") > src.indexOf('function appInvoerRoute('));
  toets('9 vast doorgegeven aan de module', /secondbrain\.app\(route, d \|\| \{\}, \{ vast: appAfscherm\(a\) \}\)/.test(src));   // wv1901
  toets('9 /health.secondbrain', /secondbrain: secondbrainInfo\(\),/.test(src));
  toets('9 Financiën verrijkt vóór de cache', /if \(typeof secondbrainFinPagina === 'function'\) secondbrainFinPagina\(d\);[^\n]*\n  appFinCache = /.test(src));
  toets('9 blokmarkers voor de UI-toets', src.indexOf('// ── Second Brain (wv832') > 0 && src.indexOf('// ── einde secondbrain') > src.indexOf('// ── Second Brain (wv832'));
  toets('9 uitrol-lijst en Dockerfile', /RELEASE_OPTIONEEL="[^"]*secondbrain\.js/.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY secondbrain\.js \/app\/release-bootstrap\/secondbrain\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  // de koppeling echt laden met nagebootste server-omgeving
  const vm2 = require('vm');
  const hb = src.indexOf('// ── Second Brain (wv832'), he = src.indexOf('// ── einde secondbrain');
  const gestuurd = [];
  const ctx = vm2.createContext({ require, process: { env: { SECONDBRAIN_DIR: path.join(W, 'sd'), CLOUDFLARE_API_TOKEN: 'proef' } }, __dirname: process.cwd(), path, fs, crypto: require('crypto'), console, setInterval: () => ({ unref() {} }),
    VAULT: V, logError: () => {}, appBsnMasker: (t) => t, appPoortGeheim: () => 'proefgeheim', smalCf: async () => ({ status: 200, j: { result: { chunks: [{ item: { key: 'vault/index.md' }, text: 'x', score: 0.5 }] } } }),
    SMAL_CF_BASIS: 'x', SMAL_CF_ACCOUNT: 'y', appTeller: () => true, appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Date, Promise, JSON, String, Number, Array, Object, Math });
  // wv1901: de schakelaar en appAfscherm uit server.js (staan buiten dit blok)
  const afs = /^const APP_VAST_AFSCHERMEN = [^\n]*\n/m.exec(src)[0] + /^function appAfscherm\(a\) \{[\s\S]*?\n\}\n/m.exec(src)[0];
  vm2.runInContext(afs + src.slice(hb, he) + ';globalThis.__sb = { secondbrain, appSecondBrain, secondbrainFinPagina };', ctx, { filename: 'server.js#secondbrain' });
  const res = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res, { soort: 'meereizend' }, { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, 'POST /app/secondbrain/open');
  toets('9 koppeling: open geeft 200 en reden zonder pad', gestuurd[0] && gestuurd[0].s === 200 && /^secondbrain open Tolgaarde h=[0-9a-f]{16}$/.test(res._app.reden), { g: gestuurd[0] && gestuurd[0].s, r: res._app.reden });
  const res2 = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res2, { soort: 'vast' }, { pad: '20_Prive/Gezondheid/Bloed.md' }, 'POST /app/secondbrain/open');
  toets('9 koppeling wv1901: vaste plek + privé = 200 (David 28-10: op alle pc\'s alles)', gestuurd[1] && gestuurd[1].s === 200, gestuurd[1] && gestuurd[1].s);
  const res3 = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res3, { soort: 'meereizend' }, { q: 'xy', betekenis: true }, 'POST /app/secondbrain/zoek');
  toets('9 koppeling: betekenis leest item.key uit AI Search', gestuurd[2] && gestuurd[2].s === 200 && gestuurd[2].j.treffers.length === 1 && gestuurd[2].j.treffers[0].pad === 'index.md', gestuurd[2]);
  const fd = { vaste_lasten: { rijen: [{ naam: 'Centraal Beheer' }, { naam: 'Ziggo' }] }, paypal: { diensten: [{ naam: 'centraal beheer b.v.' }] } };
  ctx.__sb.secondbrainFinPagina(fd);
  toets('9 Financiën: pagina bij de passende post, niet bij de rest', fd.vaste_lasten.rijen[0].pagina === '10_Zakelijk/Tolgaarde/Verzekeringen.md' && !fd.vaste_lasten.rijen[1].pagina && fd.paypal.diensten[0].pagina === '10_Zakelijk/Tolgaarde/Verzekeringen.md', fd);

  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
