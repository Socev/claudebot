#!/usr/bin/env bash
# Toetst secondbrain.js (wv832, App Second Brain; bouwplan "01_Ontwikkeling/Second Brain - Obsidian-browser in de app (bouwplan 22-10-2026).md")
# en de koppeling in server.js. Toetst: kaart (domeinen, nooit-mappen, conflictkopie, symlink, extensies, verborgen, vaste plek), linkoplossing
# (exact pad, naam, hoofdletters/NFC, zelfde map, dubbelzinnig, #kop, |tekst, \| in tabel, embed, md-link met %20, codeblok genegeerd),
# backlinks, openen (masker, frontmatter, .., absoluut, NUL, niet in kaart, vast + privé/personeel, symlink na de bouw, te groot), bestand
# (alleen niet-md, tekst gemaskeerd, twee tegelijk), zoeken (naam, tekst, accenten, verborgen, vast, fragment gemaskeerd, betekenis gefilterd;
# wv1940 zoekfilter soorten: codes, soort én plek, afgekapt per soort, teller, vault eerst; wv2077 relevantie: entiteitpagina bovenaan,
# groepen entiteiten · paginas · tekst, paginanaam/alias/vaker genoemd, map-wirwar achteraan, register weg = zonder groep),
# kaart.json 0600 buiten de vault, koppeltabel Financiën, en server.js (dispatch, grenzen, glijdroutes, invoerslot, audit zonder pad, /health,
# verrijking Financiën, uitrol-lijst, Dockerfile); wv3003 linkcache.json over een herstart heen (8c). Raakt de echte vault niet. Gebruik: bash test/secondbrain.sh
set -u
cd "$(dirname "$0")/.." || exit 1
node --no-warnings - <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const S = require(process.env.SB_MODULE || './secondbrain.js');   // wv3003: SB_MODULE alleen voor de kruisproef
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
  // wv1999: markering van een gegenereerd blok (64-hex hash) niet tonen; het blok wel, een echte sleutel nog gemaskeerd, codeblok onaangeroerd
  const HASH = '9f3a' + 'c0d1e2b4'.repeat(7) + '5b6c7d8e'.slice(0, 4);
  zet('20_Prive/Proef/Proefvriend.md', '# Proefvriend\nTekst met ' + TOKEN + '.\n<!-- sb:generated id="verbonden" content_hash="' + HASH + '" begin -->\n> [!abstract]- Verbonden pagina\'s (2)\n> **20_Prive/Proef** (2): [[20_Prive/Proef/A|A]]\n<!-- sb:generated id="verbonden" eind -->\nNa het blok.\n```\n<!-- sb:generated id="uitleg" eind -->\n```\n');
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
  toets('1 wv3446: ook met de oude vaste-plekvlag de hele vault (20_Prive, 30_Conversaties, Medewerkers, Meldingen)', vp.some((p) => /^20_Prive\//.test(p)) && vp.some((p) => /^00_Systeem\/Meldingen\//.test(p)) && vp.indexOf('index.md') >= 0, vp);
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
  const pv = await sb.app('POST /app/secondbrain/open', { pad: '20_Prive/Proef/Proefvriend.md' }, {});
  const pvm = pv.j.md || '';
  toets('3 wv1999: sb:generated-markering niet in de lezer, blok wel, hash niet als sleutel, echte sleutel nog weg',
    HASH.length === 64 && pv.status === 200 && pvm.indexOf('content_hash') < 0 && pvm.indexOf(HASH) < 0 && /\n\n> \[!abstract\]- Verbonden/.test(pvm) &&
    /> \*\*20_Prive\/Proef\*\* \(2\): \[\[20_Prive\/Proef\/A\|A\]\]\n\nNa het blok\./.test(pvm) && pvm.indexOf(TOKEN) < 0 &&
    (pvm.match(/\[sleutel weggelaten\]/g) || []).length === 1 && pvm.indexOf('```\n<!-- sb:generated id="uitleg" eind -->\n```') >= 0, pvm);
  toets('3 wv1999: zonder de afscherming zou de hash als sleutel gemaskeerd worden (toets meet echt iets)', S.masker('x ' + HASH + ' y', false).indexOf(HASH) < 0);
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
  for (const p of ['20_Prive/Gezondheid/Bloed.md', '10_Zakelijk/Tolgaarde/Medewerkers/Jan Jansen.md', '00_Systeem/Meldingen/machinekamer.md', '30_Conversaties/WhatsApp/2026-10-22.md',
    '00_Systeem/Beveiliging/Sleutelregister.md'])   // wv1931-review MOET 1: vroeger NOOIT_MAP, nu vast-dicht
    vastP.push((await sb.app('POST /app/secondbrain/open', { pad: p }, { vast: true })).status);
  toets('3 wv3446: privé, personeel, box, gesprekken ook met de oude vaste-plekvlag open (200)', vastP.every((s) => s === 200), vastP);
  const vastB = [];
  for (const p of ['TempFinData/cf_token.txt', 'Claude outputs/x.pdf']) vastB.push((await sb.app('POST /app/secondbrain/bestand', { pad: p }, { vast: true })).status);
  const telB = (await sb.app('POST /app/secondbrain/bestand', { pad: 'Claude outputs/x.pdf' }, {})).status;
  toets('3 wv3446: TempFinData en Claude outputs overal open, ook met de oude vaste-plekvlag', vastB.every((s) => s === 200) && telB === 200, vastB.concat([telB]));
  const ovv = await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/Plan.md' }, { vast: true });
  toets('3 wv3446: link naar David Schaap blijft twee kandidaten (HAGRO + Gambia), ook met de oude vaste-plekvlag', ovv.j.doelen['david schaap'] && Array.isArray(ovv.j.doelen['david schaap'].k) && ovv.j.doelen['david schaap'].k.length === 2, ovv.j.doelen['david schaap']);
  const ovb = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, { vast: true });
  toets('3 wv3446: backlinks ook uit privé en personeel, ook met de oude vaste-plekvlag', JSON.stringify(ovb.j.terug) === JSON.stringify((await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, {})).j.terug));
  toets('3 NFC: NFD-bestandsnaam ook met NFC-pad te openen', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Holding/Café notitie.md' }, {})).status === 200);
  toets('3 groter dan 2 MB: 413', (await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/Groot.md' }, {})).status === 413);
  toets('3 een niet-md via open: 404', (await sb.app('POST /app/secondbrain/open', { pad: '01_Ontwikkeling/schema.png' }, {})).status === 404);
  // symlink die na de bouw in de plaats van een bestand komt (TOCTOU): weigeren
  fs.unlinkSync(path.join(V, '10_Zakelijk/Tolgaarde/Mijn contract.md'));
  fs.symlinkSync('/etc/hostname', path.join(V, '10_Zakelijk/Tolgaarde/Mijn contract.md'));
  toets('3 symlink na de bouw: 404', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Mijn contract.md' }, {})).status === 404);
  const vm = await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Medewerkers/Jan Jansen.md' }, {});
  toets('3 telefoon: personeel wel, IBAN niet gemaskeerd (alleen op vast)', vm.status === 200 && vm.j.md.indexOf('NL12ABNA0123456789') >= 0);

  // wv3446: verborgen (Bronnen) gaat via een link open, ook met de oude vaste-plekvlag
  toets('3 wv3446: Bronnen (verborgen) via open, ook met de oude vaste-plekvlag', (await sb.app('POST /app/secondbrain/open', { pad: '10_Zakelijk/Tolgaarde/Bronnen/_register.md' }, { vast: true })).status === 200 &&
    (await sb.app('POST /app/secondbrain/bestand', { pad: '10_Zakelijk/Tolgaarde/Bronnen/scan.pdf' }, { vast: true })).status === 200);
  toets('3 wv3446: kaart met alles bevat Bronnen, ook met de oude vaste-plekvlag', (await sb.app('POST /app/secondbrain/kaart', { alles: true }, { vast: true })).j.knopen.some((x) => /\/Bronnen\//.test(x[0])));
  const a404 = await sb.app('POST /app/secondbrain/open', { pad: '20_Prive/Gezondheid/Bestaat Niet Bloed.md' }, {});
  toets('3 audit bij 404: hmac van het gevraagde pad, geen domein, geen pad', a404.audit.h && a404.audit.domein === null && JSON.stringify(a404.audit).indexOf('Bloed') < 0, a404.audit);
  // ── 4. bestand ──
  const b1 = await sb.app('POST /app/secondbrain/bestand', { pad: '01_Ontwikkeling/schema.png' }, {});
  toets('4 bestand: beeld als base64 met type', b1.status === 200 && b1.j.type === 'image/png' && Buffer.from(b1.j.inhoud, 'base64').toString('hex') === '89504e470d0a1a0a', b1.j);
  const b2 = await sb.app('POST /app/secondbrain/bestand', { pad: '20_Prive/Financien/data.csv' }, {});
  toets('4 bestand: tekst door het masker', b2.status === 200 && Buffer.from(b2.j.inhoud, 'base64').toString('utf8').indexOf('[sleutel weggelaten]') >= 0, Buffer.from(b2.j.inhoud || '', 'base64').toString());
  toets('4 bestand: md via bestand = 404', (await sb.app('POST /app/secondbrain/bestand', { pad: 'index.md' }, {})).status === 404);
  toets('4 wv3446: bestand privé ook met de oude vaste-plekvlag 200', (await sb.app('POST /app/secondbrain/bestand', { pad: '20_Prive/Financien/data.csv' }, { vast: true })).status === 200);
  toets('4 bestand: pdf in Bronnen (verborgen) wel te openen', (await sb.app('POST /app/secondbrain/bestand', { pad: '10_Zakelijk/Tolgaarde/Bronnen/scan.pdf' }, {})).status === 200);

  // ── 5. zoeken ──
  const z1 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering' }, {});
  const zp = z1.j.treffers.map((t) => t.pad);
  toets('5 zoeken: naam en tekst, standaard zonder Bronnen en gesprekken', zp.indexOf('10_Zakelijk/Tolgaarde/Verzekeringen.md') >= 0 && zp.indexOf('20_Prive/Gezondheid/Bloed.md') >= 0 &&
    !zp.some((p) => /Bronnen|^30_/.test(p)), zp);
  const z2 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering', alles: true }, {});
  toets('5 zoeken met alles: ook Bronnen en gesprekken', z2.j.treffers.some((t) => /Bronnen/.test(t.pad)) && z2.j.treffers.some((t) => /^30_/.test(t.pad)));
  const z3 = await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering', alles: true }, { vast: true });
  toets('5 wv3446: zoeken met de oude vaste-plekvlag = zonder', JSON.stringify(z3.j.treffers) === JSON.stringify((await sb.app('POST /app/secondbrain/zoek', { q: 'verzekering', alles: true }, {})).j.treffers) && z3.j.treffers.some((t) => /^20_|^30_/.test(t.pad)), z3.j.treffers);
  const z4 = await sb.app('POST /app/secondbrain/zoek', { q: 'financien cafe' }, {});
  toets('5 zoeken zonder accenten vindt Financiën en café', z4.j.treffers.some((t) => t.pad === '10_Zakelijk/Tolgaarde/Verzekeringen.md'), z4.j);
  const z5 = await sb.app('POST /app/secondbrain/zoek', { q: 'Token' }, {});
  toets('5 fragment gemaskeerd', z5.j.treffers.length > 0 && z5.j.treffers.every((t) => t.fragment.indexOf(TOKEN) < 0), z5.j.treffers);
  toets('5 te korte vraag: 400', (await sb.app('POST /app/secondbrain/zoek', { q: 'a' }, {})).status === 400);
  const zb = await sb.app('POST /app/secondbrain/zoek', { q: 'polis', betekenis: true }, {});
  toets('5 betekenis: treffers buiten de kaart en verborgen weg, fragment gemaskeerd', zb.j.treffers.map((t) => t.pad).join() === '20_Prive/Gezondheid/Bloed.md,10_Zakelijk/Tolgaarde/Verzekeringen.md' &&
    zb.j.treffers[0].fragment.indexOf(TOKEN) < 0, zb.j.treffers);
  const zbv = await sb.app('POST /app/secondbrain/zoek', { q: 'polis', betekenis: true }, { vast: true });
  toets('5 wv3446: betekenis met de oude vaste-plekvlag ook privé', zbv.j.treffers.some((t) => /^20_Prive/.test(t.pad)), zbv.j.treffers);

  // ── 5b. zoekfilter soorten (wv1940): vaste codes, soort én plek, afgekapt per soort, teller, betekenis, vaste plek ──
  {
    const V2 = path.join(W, 'vault2');
    const zet2 = (p, t) => { fs.mkdirSync(path.dirname(path.join(V2, p)), { recursive: true }); fs.writeFileSync(path.join(V2, p), t); };
    for (let i = 0; i < 45; i++) zet2('Rapporten/rapport-' + i + '.pdf', '%PDF');
    zet2('Rapporten/rapport overzicht.md', '# overzicht\nkwartaal\n');
    zet2('Rapporten/rapport cijfers.xlsx', 'x'); zet2('Rapporten/rapport tabel.csv', 'a;b\n');
    zet2('Rapporten/rapport foto.jpg', 'x'); zet2('Rapporten/rapport memo.mp3', 'x');
    zet2('Pagina.md', '# pagina\nhet rapport in tekst\n'); zet2('Notitie.txt', 'rapport in een tekstbestand\n');
    zet2('10_Zakelijk/Tolgaarde/Bronnen/rapport bron.pdf', '%PDF');
    zet2('10_Zakelijk/Tolgaarde/Bronnen/notitie.md', '# bron\nrapport en kwartaal\n');
    zet2('20_Prive/rapport prive.pdf', '%PDF');
    zet2('30_Conversaties/WhatsApp/2026-10-28.md', '# dump\nrapport besproken, kwartaal\n');
    const oud = new Date(Date.now() - 86400000);
    fs.utimesSync(path.join(V2, 'Rapporten/rapport overzicht.md'), oud, oud);   // de vault-pagina is ouder en moet toch eerst
    const sb2 = S.maak({ vault: V2, dir: path.join(W, 'staat2'), hmac: (p) => 'h' + p.length,
      betekenis: async () => ['Pagina.md', '10_Zakelijk/Tolgaarde/Bronnen/notitie.md', 'Rapporten/rapport-1.pdf', '30_Conversaties/WhatsApp/2026-10-28.md'].map((k) => ({ key: 'vault/' + k, text: 'x' })) });
    const z = async (q, soorten, ctx, extra) => (await sb2.app('POST /app/secondbrain/zoek', Object.assign({ q: q, soorten: soorten }, extra || {}), ctx || {}));
    const pd = (r) => (r.j.treffers || []).map((t) => t.pad);
    const p1 = await z('rapport', ['paginas']);
    toets('5b paginas: alleen md en tekst, ook uit Bronnen en gesprekken, niet afgekapt', pd(p1).length === 5 && pd(p1).every((p) => /\.(md|txt)$/.test(p)) && pd(p1).indexOf('Notitie.txt') >= 0 &&
      pd(p1).some((p) => /Bronnen/.test(p)) && pd(p1).some((p) => /^30_/.test(p)) && p1.j.afgekapt === false, p1.j);
    const p2 = await z('rapport', ['pdf']);
    toets('5b pdf: 40 treffers, alleen pdf, afgekapt, teller 47 (ook Bronnen en privé)', pd(p2).length === 40 && pd(p2).every((p) => /\.pdf$/.test(p)) && p2.j.afgekapt === true &&
      p2.j.tel && p2.j.tel.pdf === 47 && p2.j.tel.office === 2 && p2.j.tel.media === 2 && !pd(p2).some((p) => /Bronnen/.test(p)), p2.j);
    const p3 = await z('rapport', ['pdf', 'bronnen']);
    toets('5b pdf + bronnen: alleen de pdf in Bronnen, teller binnen de plek', pd(p3).join() === '10_Zakelijk/Tolgaarde/Bronnen/rapport bron.pdf' && p3.j.tel.pdf === 1 && p3.j.tel.office === 0, p3.j);
    const p4 = await z('rapport', ['office']), p5 = await z('rapport', ['media']);
    toets('5b office = Word/Excel en csv, media = foto en audio', pd(p4).sort().join() === 'Rapporten/rapport cijfers.xlsx,Rapporten/rapport tabel.csv' &&
      pd(p5).sort().join() === 'Rapporten/rapport foto.jpg,Rapporten/rapport memo.mp3', [pd(p4), pd(p5)]);
    const p6 = await z('rapport', ['gesprekken']), p7 = await z('rapport', ['vault', 'paginas']);
    toets('5b gesprekken alleen 30_Conversaties; vault zonder Bronnen en gesprekken', pd(p6).join() === '30_Conversaties/WhatsApp/2026-10-28.md' &&
      pd(p7).sort().join() === 'Notitie.txt,Pagina.md,Rapporten/rapport overzicht.md', [pd(p6), pd(p7)]);
    const p8 = await z('kwartaal', []);
    toets('5b geen keuze = alles, de vault zelf eerst (ook als die ouder is)', pd(p8).length === 3 && pd(p8)[0] === 'Rapporten/rapport overzicht.md', pd(p8));
    const fout = [['video'], 'pdf', [1], ['pdf', 'PDF'], { pdf: true }];
    const st = [];
    for (const f of fout) st.push((await z('rapport', f)).status);
    toets('5b onbekende of verkeerde code: 400', st.every((x) => x === 400), st);
    const p9 = await z('rapport', ['pdf'], { vast: true });
    toets('5b wv3446: met de oude vaste-plekvlag dezelfde treffers en teller', await (async () => { const p0 = (await z('rapport', ['pdf'])).j; return JSON.stringify(p9.j.treffers) === JSON.stringify(p0.treffers) && JSON.stringify(p9.j.tel) === JSON.stringify(p0.tel); })(), p9.j.tel);
    const pb = await z('rapport', ['paginas', 'vault'], {}, { betekenis: true });
    const pb2 = await z('rapport', ['pdf'], {}, { betekenis: true });
    toets('5b betekenis: zelfde filter op het pad van de treffers', pd(pb).join() === 'Pagina.md' && pd(pb2).join() === 'Rapporten/rapport-1.pdf', [pd(pb), pd(pb2)]);
    const p10 = await sb2.app('POST /app/secondbrain/zoek', { q: 'kwartaal' }, {});
    toets('5b zonder soorten: oud gedrag (geen Bronnen of gesprekken, geen teller)', pd(p10).join() === 'Rapporten/rapport overzicht.md' && p10.j.tel === undefined, p10.j);
  }

  // ── 6. Financiën-koppeltabel ──
  toets('6 koppel: "Centraal Beheer" (zonder B.V., andere hoofdletters) → pagina', sb.koppelNaam('CENTRAAL BEHEER') === '10_Zakelijk/Tolgaarde/Verzekeringen.md' && sb.koppelNaam('Weg') === null && sb.koppelNaam('Iets anders') === null);

  const zv = await sb.app('POST /app/secondbrain/zoek', { q: 'bron', alles: true }, { vast: true });
  toets('5 wv3446: zoeken met alles en de oude vaste-plekvlag: ook Bronnen', zv.j.treffers.some((t) => /Bronnen/.test(t.pad)), zv.j.treffers);
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

  // ── 5c. relevantie (wv2077, David 31-10: "de Entiteitspagina bovenaan"; alle namen verzonnen, openbare repo) ──
  {
    const V3 = path.join(W, 'vault3');
    const zet3 = (p, t) => { fs.mkdirSync(path.dirname(path.join(V3, p)), { recursive: true }); fs.writeFileSync(path.join(V3, p), t); };
    zet3('10_Zakelijk/Voorbeeld/Entiteit - VB.md', '# Voorbeeldpraktijk\nDe Voorbeeldpraktijk.\n');
    for (let i = 0; i < 60; i++) zet3('10_Zakelijk/Voorbeeld/Notulen/Overleg ' + i + '.md', '# overleg\nniets\n');   // alleen de map heet zo (de oude wirwar)
    zet3('10_Zakelijk/Voorbeeld/Medewerkers/Piet Verzonnen.md', '# Piet\n');
    zet3('10_Zakelijk/_Gedeeld/Relaties/Voorbeeld Leverancier.md', '# lev\n');
    zet3('01_Ontwikkeling/Voorbeeld.md', '# precies de naam\n');
    zet3('01_Ontwikkeling/Voorbeeld plan.md', '# begint ermee\n');
    zet3('01_Ontwikkeling/Allevoorbeeldig.md', '# ergens in de naam\n');
    zet3('01_Ontwikkeling/Bijnaam.md', '---\naliases: [Voorbeeld, VB]\n---\n# alias\n');
    zet3('01_Ontwikkeling/Veel.md', '# veel\nvoorbeeld voorbeeld voorbeeld voorbeeld voorbeeld\n');
    zet3('01_Ontwikkeling/Weinig.md', '# weinig\neen voorbeeld\n');
    zet3('20_Prive/Geheim Voorbeeld.md', '# privé\n');
    zet3('30_Conversaties/WhatsApp/2026-10-30.md', '# dump\nvoorbeeld\n');
    const nieuw = new Date(), oud = new Date(Date.now() - 5 * 86400000);
    fs.utimesSync(path.join(V3, '01_Ontwikkeling/Veel.md'), oud, oud);   // veel treffers maar ouder: toch boven Weinig
    let entVraag = null;
    const ENT = [{ pad: '10_Zakelijk/Voorbeeld/Entiteit - VB.md', naam: 'Voorbeeldpraktijk', soort: 'eigen entiteit', sleutel: 'aaaaaaaaaaaa', sterk: 0 },
      { pad: '20_Prive/Geheim Voorbeeld.md', naam: 'Geheim', soort: 'privé', sleutel: 'bbbbbbbbbbbb', sterk: 1 },
      { pad: '10_Zakelijk/Bestaat/Niet.md', naam: 'Weg', soort: 'leverancier', sleutel: 'cccccccccccc', sterk: 1 },
      { pad: '10_Zakelijk/_Gedeeld/Relaties/Voorbeeld Leverancier.md', naam: 'Voorbeeld Leverancier', soort: 'leverancier', sleutel: 'niet-hex', sterk: 1 }];
    const sb3 = S.maak({ vault: V3, dir: path.join(W, 'staat3'), hmac: (p) => 'h' + p.length, entiteiten: async (q, vast) => { entVraag = [q, vast]; return ENT; } });
    const r = (await sb3.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: [] }, {})).j;
    const pd = r.treffers.map((t) => t.pad);
    toets('5c entiteitpagina bovenaan, groep entiteiten, met soort en sleutel', r.treffers[0].pad === '10_Zakelijk/Voorbeeld/Entiteit - VB.md' && r.treffers[0].groep === 'entiteiten' &&
      r.treffers[0].waar === 'entiteit' && r.treffers[0].soort === 'eigen entiteit' && r.treffers[0].sleutel === 'aaaaaaaaaaaa' && r.treffers[0].domein && /^\d{4}-\d{2}-\d{2}$/.test(r.treffers[0].gewijzigd), r.treffers[0]);
    toets('5c register-pad buiten de kaart valt weg; vreemde sleutel niet mee', pd.indexOf('10_Zakelijk/Bestaat/Niet.md') < 0 &&
      r.treffers.find((t) => t.pad === '10_Zakelijk/_Gedeeld/Relaties/Voorbeeld Leverancier.md').sleutel === undefined, r.treffers.slice(0, 4));
    toets('5c entiteit niet nog eens als pagina', pd.filter((p) => p === '10_Zakelijk/Voorbeeld/Entiteit - VB.md').length === 1);
    const groepen = r.treffers.map((t) => t.groep);
    toets('5c groepen op volgorde: entiteiten · paginas · tekst', groepen.join(',') === groepen.slice().sort((a, b) => ['entiteiten', 'paginas', 'tekst'].indexOf(a) - ['entiteiten', 'paginas', 'tekst'].indexOf(b)).join(','), groepen);
    const nm = r.treffers.filter((t) => t.groep === 'paginas').map((t) => t.pad.split('/').pop());
    toets('5c paginanaam: precies, begint ermee, alias, dan ergens in de naam', nm.indexOf('Voorbeeld.md') === 0 && nm.indexOf('Voorbeeld plan.md') < nm.indexOf('Bijnaam.md') &&
      nm.indexOf('Bijnaam.md') < nm.indexOf('Allevoorbeeldig.md') && r.treffers.find((t) => t.pad === '01_Ontwikkeling/Bijnaam.md').waar === 'alias', nm);
    const tk = r.treffers.filter((t) => t.groep === 'tekst');
    const ix = (f) => tk.findIndex(f);
    toets('5c tekst: vaker genoemd eerst (ook als ouder), dan alleen-de-map; gesprekken na de vault', tk[0].pad === '01_Ontwikkeling/Veel.md' &&
      ix((t) => t.pad === '01_Ontwikkeling/Weinig.md') < ix((t) => t.waar === 'map') && (ix((t) => /^30_/.test(t.pad)) < 0 || ix((t) => /^30_/.test(t.pad)) > ix((t) => t.pad === '01_Ontwikkeling/Weinig.md')), tk.map((t) => t.waar + ' ' + t.pad).slice(0, 6));
    toets('5c de map-wirwar (60 overleggen) staat niet vóór de pagina\'s, en houdt plek voor tekst', r.treffers.length === 40 && r.afgekapt === true &&
      r.treffers.findIndex((t) => t.waar === 'map') > r.treffers.findIndex((t) => t.pad === '01_Ontwikkeling/Allevoorbeeldig.md') && r.groepen.entiteiten === 3, { n: r.treffers.length, g: r.groepen });
    toets('5c opt.entiteiten krijgt alleen de vraag (wv3446)', entVraag && entVraag[0] === 'Voorbeeld' && entVraag[1] === undefined, entVraag);
    const rv = (await sb3.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: [] }, { vast: true })).j;
    toets('5c wv3446: geen vaste-plekvlag naar het register; zelfde treffers als zonder', entVraag[1] === undefined && JSON.stringify(rv.treffers) === JSON.stringify((await sb3.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: [] }, {})).j.treffers), rv.treffers);
    const rk = (await sb3.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: ['vault'] }, {})).j;
    toets('5c chip Vault: entiteit blijft, privé-entiteit en gesprekken alleen als ze in de vault-plek vallen', rk.treffers[0].groep === 'entiteiten' && !rk.treffers.some((t) => /^30_/.test(t.pad)), rk.treffers.slice(0, 3));
    const rp = (await sb3.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: ['pdf'] }, {})).j;
    toets('5c chip PDF: geen entiteitpagina (dat is geen pdf)', !rp.treffers.some((t) => t.groep === 'entiteiten'), rp.treffers);
    const sb4 = S.maak({ vault: V3, dir: path.join(W, 'staat4'), hmac: (p) => 'h' + p.length, entiteiten: async () => { throw new Error('register weg'); } });
    const rf = (await sb4.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: [] }, {})).j;
    toets('5c register weg: zoeken werkt, zonder entiteiten, met ent_fout', rf.ok && rf.ent_fout === true && rf.treffers[0].pad === '01_Ontwikkeling/Voorbeeld.md', rf.treffers[0]);
    const sb5 = S.maak({ vault: V3, dir: path.join(W, 'staat5'), hmac: (p) => 'h' + p.length });
    const ro = (await sb5.app('POST /app/secondbrain/zoek', { q: 'Voorbeeld', soorten: [] }, {})).j;
    toets('5c zonder opt.entiteiten (oude aansluiting): geen ent_fout, paginanaam eerst', ro.ent_fout === undefined && ro.treffers[0].pad === '01_Ontwikkeling/Voorbeeld.md' && ro.treffers.every((t) => t.pad && t.waar && typeof t.fragment === 'string'));
    const rw = (await sb3.app('POST /app/secondbrain/zoek', { q: 'oorbee', soorten: [] }, {})).j;
    toets('5c deel van een woord: geen entiteitgroep-eis, wel ergens-in-de-naam', rw.treffers.some((t) => t.pad === '01_Ontwikkeling/Allevoorbeeldig.md' && t.groep === 'paginas'), rw.treffers.slice(0, 3));
  }

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

  // ── 8b. wv2607: kaart in het geheugen, alleen gewijzigde pagina's opnieuw lezen, afscherming per verzoek ──
  {
    const V10 = path.join(W, 'vault10');
    const zet10 = (p, t) => { fs.mkdirSync(path.dirname(path.join(V10, p)), { recursive: true }); fs.writeFileSync(path.join(V10, p), t); };
    zet10('a.md', '# A\n[[b]] en [[nog niet]]\n');
    zet10('b.md', '# B\n[[a]]\n');
    fs.utimesSync(path.join(V10, 'b.md'), 1700000000, 1700000000);   // hele seconden: terugzetten verderop is dan exact (anders rondt utimes af)
    zet10('c.md', '# C\n');
    zet10('10_Zakelijk/Personeel/dossier.md', '# dicht op vaste plek\n[[a]]\n');
    zet10('10_Zakelijk/Bronnen/bron.md', '# verborgen\n[[b]]\n');
    let klok = 1e12;
    const s10 = S.maak({ vault: V10, dir: path.join(W, 'staat10'), nu: () => klok });
    const heeft = (r, x, y) => { const kn = r.j.knopen.map((k) => k[0]); const ix = kn.indexOf(x), iy = kn.indexOf(y); for (let i = 0; i < r.j.lijnen.length; i += 2) if (r.j.lijnen[i] === ix && r.j.lijnen[i + 1] === iy) return true; return false; };
    const r1 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    const h1 = s10.health();
    toets('8b eerste kaart: alle md-bestanden gelezen', r1.status === 200 && h1.gelezen === 5 && heeft(r1, 'a.md', 'b.md'), h1);
    const k1 = s10.vers(false);
    klok += 1000;
    const r2 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b tweede keer binnen de versheid: uit het geheugen (zelfde kaart, zelfde bouwtijd)', s10.vers(false) === k1 && r2.j.bijgewerkt === r1.j.bijgewerkt && s10.health().hergebruik === 0);
    klok += 200000;
    const r3 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b na de versheid zonder wijziging: zelfde kaart hergebruikt, wel weer vers', s10.vers(false) === k1 && s10.health().hergebruik === 1 && r3.j.bijgewerkt !== r1.j.bijgewerkt, s10.health());
    zet10('c.md', '# C\n[[a]]\n');
    klok += 200000;
    const r4 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b pagina gewijzigd: nieuwe kaart, alleen die pagina gelezen, nieuwe link erin', s10.vers(false) !== k1 && s10.health().gelezen === 1 && heeft(r4, 'c.md', 'a.md'), s10.health());
    zet10('nog niet.md', '# nu wel\n');
    klok += 200000;
    const r5 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b nieuw bestand: oude link lost nu op zonder a.md opnieuw te lezen', s10.health().gelezen === 1 && heeft(r5, 'a.md', 'nog niet.md'), s10.health());
    const st = fs.statSync(path.join(V10, 'b.md'));
    fs.writeFileSync(path.join(V10, 'b.md'), '# B\n[[c]]\n');   // even lang, mtime teruggezet: alleen ctime verraadt het
    fs.utimesSync(path.join(V10, 'b.md'), 1700000000, 1700000000);
    klok += 200000;
    const r6 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b zelfde grootte en mtime teruggezet: ctime ziet de wijziging', fs.statSync(path.join(V10, 'b.md')).mtimeMs === st.mtimeMs && s10.health().gelezen === 1 && heeft(r6, 'b.md', 'c.md') && !heeft(r6, 'b.md', 'a.md'), s10.health());
    fs.unlinkSync(path.join(V10, 'c.md'));
    klok += 200000;
    const r7 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    toets('8b bestand weg: uit de kaart en uit de links', r7.j.knopen.every((k) => k[0] !== 'c.md') && s10.health().gelezen === 0, s10.health());
    // wv3446: de oude vaste-plekvlag verandert niets meer (zelfde kaart, zelfde lijst)
    const kv = s10.vers(false);
    const v1 = await s10.app('GET /app/secondbrain', {}, { vast: true });
    const o1 = await s10.app('POST /app/secondbrain/kaart', { alles: true }, { vast: false });
    const v2 = await s10.app('POST /app/secondbrain/kaart', { alles: true }, { vast: true });
    const o2 = await s10.app('GET /app/secondbrain', {}, { vast: false });
    const pv = (r) => r.j.knopen.map((k) => k[0]);
    toets('8b wv3446: met de oude vaste-plekvlag personeel erin, zelfde kaart', s10.vers(false) === kv && [v1, v2].every((r) => !r.j.vaste_plek && pv(r).indexOf('10_Zakelijk/Personeel/dossier.md') >= 0) && JSON.stringify(pv(v1)) === JSON.stringify(pv(o2)) && JSON.stringify(pv(v2)) === JSON.stringify(pv(o1)), [pv(v1), pv(v2)]);
    toets('8b open apparaat: personeel erin, bronnen alleen met alles', pv(o2).indexOf('10_Zakelijk/Personeel/dossier.md') >= 0 && pv(o2).indexOf('10_Zakelijk/Bronnen/bron.md') < 0 && pv(o1).indexOf('10_Zakelijk/Bronnen/bron.md') >= 0 && !o2.j.vaste_plek, [pv(o1), pv(o2)]);
    const kj = JSON.parse(fs.readFileSync(path.join(W, 'staat10', 'kaart.json'), 'utf8'));
    toets('8b ctime en linkcache niet in kaart.json, de kaart (vers) of het antwoord', kj.bestanden.every((b) => !('c' in b) && !('doelen' in b)) && s10.vers(false).bestanden.every((b) => !('c' in b) && !('doelen' in b))
      && [o1, o2, v1, v2].every((r) => r.j.knopen.every((k) => k.length === 5) && Object.keys(r.j).sort().join() === 'alles,bijgewerkt,domeinen,knopen,lijnen,ok,verborgen_n,verkeer,verkeer_week'), kj.bestanden[0]);
  }

  // ── 8c. wv3003: linkcache op schijf, zodat de eerste bouw na een herstart niet alles opnieuw leest; even streng als in het geheugen ──
  {
    const V = path.join(W, 'vault11'), DA = path.join(W, 'staat11'), DB = path.join(W, 'staat11-leeg');
    const zet11 = (p, t) => { fs.mkdirSync(path.dirname(path.join(V, p)), { recursive: true }); fs.writeFileSync(path.join(V, p), t); };
    zet11('a.md', '# A\n[[b]] en [[b]] en [[nog niet]] en [md](c.md)\n');
    zet11('b.md', '# B\n[[a]]\n');
    fs.utimesSync(path.join(V, 'b.md'), 1700000000, 1700000000);
    zet11('c.md', '# C\n[[b]]\n');
    zet11('map/d.md', '# D\n[[a]] [[c]]\n');
    const klok = () => 1e12;
    const start = (dir) => { const s = S.maak({ vault: V, dir: dir, nu: klok }); s.laadBewaard(); s.vers(false); return s; };
    const kaartVan = (dir) => fs.readFileSync(path.join(dir, 'kaart.json'));
    const leeg = (naam) => { const d = path.join(W, naam); fs.rmSync(d, { recursive: true, force: true }); return d; };
    const s1 = start(DA);
    const lc = path.join(DA, 'linkcache.json');
    const st = fs.statSync(lc);
    toets('8c eerste bouw: alles gelezen, linkcache.json 0600 naast kaart.json', s1.health().gelezen === 4 && (st.mode & 0o777) === 0o600, [s1.health(), (st.mode & 0o777).toString(8)]);
    const lj = JSON.parse(fs.readFileSync(lc, 'utf8'));
    toets('8c linkcache: alleen paden, mtime/ctime/grootte en linkdoelen (geen paginatekst), dubbel doel één keer',
      lj.items.length === 4 && lj.items.every((it) => it.length === 5) && fs.readFileSync(lc, 'utf8').indexOf('# A') < 0
      && JSON.stringify(lj.items.find((it) => it[0] === 'a.md')[4]) === JSON.stringify([['b'], ['nog niet'], ['c.md', 1]]), lj.items);
    const s2 = start(DA);
    toets('8c herstart met cache: niets opnieuw gelezen', s2.health().gelezen === 0, s2.health());
    start(leeg('staat11-zonder'));
    toets('8c herstart met cache: kaart byte-gelijk aan een koude bouw zonder cache', Buffer.compare(kaartVan(DA), kaartVan(path.join(W, 'staat11-zonder'))) === 0);
    // gewijzigd tussen twee starts: zelfde grootte, mtime teruggezet (alleen ctime verraadt het)
    fs.writeFileSync(path.join(V, 'b.md'), '# B\n[[c]]\n');
    fs.utimesSync(path.join(V, 'b.md'), 1700000000, 1700000000);
    const s3 = start(DA);
    const b3 = s3.vers(false).bestanden.find((b) => b.p === 'b.md');
    const ic = s3.vers(false).bestanden.findIndex((b) => b.p === 'c.md');
    toets('8c na herstart: pagina met nieuwe ctime (mtime/grootte gelijk) wél opnieuw gelezen', s3.health().gelezen === 1 && JSON.stringify(b3.l) === JSON.stringify([ic]), [s3.health(), b3.l]);
    // kruisproef-gevallen: het cachebestand liegt over één veld; de echte stat moet winnen
    const lieg = (pad, veld, waarde) => { const j = JSON.parse(fs.readFileSync(lc, 'utf8')); const it = j.items.find((x) => x[0] === pad); it[veld] = waarde; it[4] = [['map/d']]; fs.writeFileSync(lc, JSON.stringify(j)); };
    const dLinkVan = (s, pad) => { const k = s.vers(false); const id = k.bestanden.findIndex((b) => b.p === 'map/d.md'); return k.bestanden.find((b) => b.p === pad).l.indexOf(id) >= 0; };
    lieg('c.md', 1, 1);   // mtime anders, ctime + grootte kloppen
    const s4 = start(DA);
    toets('8c cache met andere mtime: opnieuw gelezen, oude linkdoelen niet gebruikt', s4.health().gelezen === 1 && !dLinkVan(s4, 'c.md'), s4.health());
    lieg('c.md', 2, 1);   // ctime anders
    const s5 = start(DA);
    toets('8c cache met andere ctime (kopie/verplaatsing van de vault): opnieuw gelezen', s5.health().gelezen === 1 && !dLinkVan(s5, 'c.md'), s5.health());
    lieg('c.md', 3, 999);   // grootte anders
    const s6 = start(DA);
    toets('8c cache met andere grootte: opnieuw gelezen', s6.health().gelezen === 1 && !dLinkVan(s6, 'c.md'), s6.health());
    const kopje = (wijzig) => { const j = JSON.parse(fs.readFileSync(lc, 'utf8')); wijzig(j); fs.writeFileSync(lc, JSON.stringify(j)); };
    kopje((j) => { j.vault = '/ergens/anders'; });
    toets('8c cache van een andere vault: genegeerd (alles gelezen)', start(DA).health().gelezen === 4);
    kopje((j) => { j.parser = 'oud'; });
    toets('8c cache van een andere linksIn-code: genegeerd (alles gelezen)', start(DA).health().gelezen === 4);
    fs.writeFileSync(lc, '{"versie":1,"items":[["a.md",1,');
    let s9; try { s9 = start(DA); } catch (e) { s9 = null; }
    toets('8c onleesbare cache: geen crash, alles gelezen, daarna weer bruikbaar', s9 && s9.health().gelezen === 4 && start(DA).health().gelezen === 0, s9 && s9.health());
    kopje((j) => { j.items[0][4] = [[42]]; });
    toets('8c cache met verkeerde vorm: genegeerd', start(DA).health().gelezen === 4);
    start(leeg('staat11-zonder'));
    toets('8c eindstand: kaart met cache byte-gelijk aan koude bouw', Buffer.compare(kaartVan(DA), kaartVan(path.join(W, 'staat11-zonder'))) === 0);
  }

  // ── 9. server.js ──
  const src = fs.readFileSync('server.js', 'utf8');
  toets('9 dispatch GET /app/secondbrain en POST /app/secondbrain/* via appSecondBrain', /route === 'GET \/app\/secondbrain' \|\| route\.indexOf\('POST \/app\/secondbrain\/'\) === 0\) return typeof appSecondBrain === 'function'/.test(src));
  toets('9 grens 600/u en betekenis 200/u (wv3735)', /appTeller\('secondbrain', 600, 3600000\)/.test(src) && /appTeller\('secondbrain-betekenis', 200, 3600000\)/.test(src));
  toets('9 tellers vooraf in appStaat (anders crasht appTeller)', /tellers: \{[^}]*secondbrain: \[\], 'secondbrain-betekenis': \[\]/.test(src));
  toets('9 glijdroutes: open en zoek', /\['POST \/app\/secondbrain\/open', 'POST \/app\/secondbrain\/zoek'\]\.forEach\(function \(r\) \{ APP_GLIJD_ROUTES\.add\(r\); \}\);/.test(src));
  const slotVrij = /const APP_SLOT_VRIJ = new Set\(\[([^\]]*)\]\)/.exec(src)[1];
  toets('9 invoerslot op vaste plek geldt (niet in APP_SLOT_VRIJ)', slotVrij.indexOf('secondbrain') < 0);
  toets('9 audit: reden met domein en h=, niet het pad', /res\._app\.reden = 'secondbrain ' \+ actie \+ \(au\.domein \? ' ' \+ au\.domein : ''\) \+ \(au\.h \? ' h=' \+ au\.h : ''\)/.test(src) && !/res\._app\.reden = [^\n]*d\.pad/.test(src));
  toets('9 GET /app/secondbrain valt op een vaste plek onder het invoerslot', src.indexOf("  if (route === 'GET /app/secondbrain') return true;") > src.indexOf('function appInvoerRoute('));
  toets('9 wv3446: geen vaste-plekvlag meer naar de module', /secondbrain\.app\(route, d \|\| \{\}, \{\}\)/.test(src) && !/appAfscherm/.test(src));
  toets('9 /health.secondbrain', /secondbrain: secondbrainInfo\(\),/.test(src));
  toets('9 Financiën verrijkt vóór de cache', /if \(typeof secondbrainFinPagina === 'function'\) secondbrainFinPagina\(d\);[^\n]*\n  appFinCache = /.test(src));
  toets('9 blokmarkers voor de UI-toets', src.indexOf('// ── Second Brain (wv832') > 0 && src.indexOf('// ── einde secondbrain') > src.indexOf('// ── Second Brain (wv832'));
  toets('9 uitrol-lijst en Dockerfile', /RELEASE_OPTIONEEL="[^"]*secondbrain\.js/.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY secondbrain\.js \/app\/release-bootstrap\/secondbrain\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
  // de koppeling echt laden met nagebootste server-omgeving
  const vm2 = require('vm');
  const hb = src.indexOf('// ── Second Brain (wv832'), he = src.indexOf('// ── einde secondbrain');
  const gestuurd = [];
  const ctx = vm2.createContext({ require, process: { env: { SECONDBRAIN_DIR: path.join(W, 'sd'), CLOUDFLARE_API_TOKEN: 'proef' } }, __dirname: process.cwd(), path, fs, crypto: require('crypto'), console, setInterval: () => ({ unref() {} }),
    VAULT: V, logError: () => {}, vaultzoek: { zoekBrain: async () => [{ key: 'vault/index.md', text: 'x', score: 0.5 }] }, appBsnMasker: (t) => t, appPoortGeheim: () => 'proefgeheim', smalCf: async () => ({ status: 200, j: { result: { chunks: [{ item: { key: 'vault/index.md' }, text: 'x', score: 0.5 }] } } }),
    SMAL_CF_BASIS: 'x', SMAL_CF_ACCOUNT: 'y', appTeller: () => true, appWeiger: (res, s, f) => gestuurd.push({ s, f }), appStuur: (res, s, j) => gestuurd.push({ s, j }), Date, Promise, JSON, String, Number, Array, Object, Math });
  // wv3446: geen afscherm-schakelaar meer buiten dit blok
  vm2.runInContext(src.slice(hb, he) + ';globalThis.__sb = { secondbrain, appSecondBrain, secondbrainFinPagina };', ctx, { filename: 'server.js#secondbrain' });
  const res = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res, { soort: 'meereizend' }, { pad: '10_Zakelijk/Tolgaarde/Verzekeringen.md' }, 'POST /app/secondbrain/open');
  toets('9 koppeling: open geeft 200 en reden zonder pad', gestuurd[0] && gestuurd[0].s === 200 && /^secondbrain open Tolgaarde h=[0-9a-f]{16}$/.test(res._app.reden), { g: gestuurd[0] && gestuurd[0].s, r: res._app.reden });
  const res2 = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res2, { soort: 'vast' }, { pad: '20_Prive/Gezondheid/Bloed.md' }, 'POST /app/secondbrain/open');
  toets('9 koppeling wv1901: vaste plek + privé = 200 (David 28-10: op alle pc\'s alles)', gestuurd[1] && gestuurd[1].s === 200, gestuurd[1] && gestuurd[1].s);
  const res3 = { _app: {} };
  await ctx.__sb.appSecondBrain({}, res3, { soort: 'meereizend' }, { q: 'xy', betekenis: true }, 'POST /app/secondbrain/zoek');
  toets('9 koppeling: betekenis via vaultzoek (wv3295), key vault/<pad>', gestuurd[2] && gestuurd[2].s === 200 && gestuurd[2].j.treffers.length === 1 && gestuurd[2].j.treffers[0].pad === 'index.md', gestuurd[2]);
  const fd = { vaste_lasten: { rijen: [{ naam: 'Centraal Beheer' }, { naam: 'Ziggo' }] }, paypal: { diensten: [{ naam: 'centraal beheer b.v.' }] } };
  ctx.__sb.secondbrainFinPagina(fd);
  toets('9 Financiën: pagina bij de passende post, niet bij de rest', fd.vaste_lasten.rijen[0].pagina === '10_Zakelijk/Tolgaarde/Verzekeringen.md' && !fd.vaste_lasten.rijen[1].pagina && fd.paypal.diensten[0].pagina === '10_Zakelijk/Tolgaarde/Verzekeringen.md', fd);

  // ── 12. wv3423 (B80): niet kunnen lezen is nooit leeg — oude kaart blijft, overgeslagen deelmappen in /health ──
  { const VB = path.join(W, 'vault-b80'), DB = path.join(W, 'staat-b80');
    const zetB = (p, t) => { fs.mkdirSync(path.dirname(path.join(VB, p)), { recursive: true }); fs.writeFileSync(path.join(VB, p), t); };
    zetB('10_Zakelijk/A.md', '# A\n[[B]]\n'); zetB('10_Zakelijk/B.md', '# B\n'); zetB('20_Prive/C.md', '# C\n');
    let klok = 1000000, lees = null;
    const sbB = S.maak({ vault: VB, dir: DB, nu: () => klok, leesMap: (abs) => (lees ? lees(abs) : fs.readdirSync(abs, { withFileTypes: true })) });
    const k1 = sbB.vers(true), json1 = fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8');
    toets('12 eerste bouw: 3 bestanden', k1.bestanden.length === 3 && sbB.health().overgeslagen === 0 && sbB.health().bouw_fout === null, sbB.health());
    const fout = (code) => () => { const e = new Error(code); e.code = code; throw e; };
    // onleesbare wortel (EACCES): oude kaart blijft, kaart.json gelijk, fout zichtbaar
    lees = (abs) => abs === VB ? fout('EACCES')() : fs.readdirSync(abs, { withFileTypes: true }); klok += 1e9;
    let k = sbB.vers(true);
    toets('12 wortel EACCES: oude kaart blijft (3), kaart.json ongewijzigd, bouw_fout in health', k === k1 && k.bestanden.length === 3 && fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8') === json1 && /EACCES/.test((sbB.health().bouw_fout || {}).fout), sbB.health());
    // wortel EIO idem
    lees = (abs) => abs === VB ? fout('EIO')() : fs.readdirSync(abs, { withFileTypes: true }); klok += 1e9;
    k = sbB.vers(true);
    toets('12 wortel EIO: oude kaart blijft', k === k1 && fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8') === json1);
    // onleesbare deelmap: kaart zonder die map, maar /health telt hem
    lees = (abs) => abs === path.join(VB, '20_Prive') ? fout('EIO')() : fs.readdirSync(abs, { withFileTypes: true }); klok += 1e9;
    k = sbB.vers(true);
    toets('12 deelmap EIO: overgeslagen 1 in health met map en code, geen bouw_fout', k.bestanden.length === 2 && sbB.health().overgeslagen === 1 && sbB.health().overgeslagen_mappen[0] === '20_Prive (EIO)' && sbB.health().bouw_fout === null, sbB.health());
    lees = null; klok += 1e9; k = sbB.vers(true);
    toets('12 weer leesbaar: 3 bestanden, overgeslagen 0', k.bestanden.length === 3 && sbB.health().overgeslagen === 0);
    const json2 = fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8');
    // hernoemde vault (echte fs, geen nep-lezer): oude kaart blijft
    fs.renameSync(VB, VB + '-weg'); klok += 1e9;
    const kh = sbB.vers(true);
    toets('12 hernoemde vault: oude kaart blijft, kaart.json ongewijzigd', kh.bestanden.length === 3 && fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8') === json2 && /ENOENT/.test((sbB.health().bouw_fout || {}).fout), sbB.health());
    // lege mount: wortel leesbaar maar leeg terwijl de kaart bestanden had
    fs.mkdirSync(VB); klok += 1e9;
    const kl = sbB.vers(true);
    toets('12 lege mount: oude kaart blijft (niet gemeten), kaart.json ongewijzigd', kl.bestanden.length === 3 && fs.readFileSync(path.join(DB, 'kaart.json'), 'utf8') === json2 && /0 gevonden/.test((sbB.health().bouw_fout || {}).fout), sbB.health());
    // zonder eerdere kaart en zonder vault: geen kaart (503), niet "0 knopen"
    const sbC = S.maak({ vault: path.join(W, 'bestaat-niet'), dir: path.join(W, 'staat-c') });
    toets('12 lees-of-weiger.js gaat mee in de release (uitrol.sh + Dockerfile)', /^RELEASE_OPTIONEEL="[^"]*\blees-of-weiger\.js\b/m.test(fs.readFileSync('uitrol.sh', 'utf8')) && /COPY lees-of-weiger\.js \/app\/release-bootstrap\/lees-of-weiger\.js/.test(fs.readFileSync('Dockerfile', 'utf8')));
    toets('12 geen vault, geen oude kaart: geen kaart (niet een lege)', !sbC.vers(true) && sbC.health().knopen === 0 && !!sbC.health().bouw_fout); }

  // ── 13. wv3608 (actieplan 3B25): per dag tellen waar een geopende pagina vandaan kwam; alleen aantallen, geen pad ──
  { const DH = path.join(W, 'staat-herkomst');
    let klok = Date.UTC(2026, 10, 20, 22, 30);   // 20-11 23:30 Amsterdamse tijd
    const sH = S.maak({ vault: V, dir: DH, nu: () => klok, herkomstSchrijfMs: 60000 }); sH.mkdir();
    const opn = (h, p) => sH.app('POST /app/secondbrain/open', Object.assign({ pad: p || 'index.md' }, h === undefined ? {} : { herkomst: h }), {});
    await opn('kaart'); await opn('kaart'); await opn('zoeken'); await opn('bladeren');
    await opn('kaart', 'Bestaat/niet.md');   // 404: telt niet
    await opn(); await opn('onzin'); await opn(['kaart']);   // geen of onbekende herkomst: telt niet
    const h1 = sH.health().herkomst || {};
    toets('13 telling per herkomst vandaag (alleen geslaagde opening met bekende herkomst)', JSON.stringify(h1.vandaag) === JSON.stringify({ kaart: 2, zoeken: 1, bladeren: 1 }), h1);
    klok += 60 * 60000;   // 21-11 00:30: nieuwe dag (Amsterdam)
    await opn('link'); await opn('kaart');
    const h2 = sH.health().herkomst;
    toets('13 nieuwe dag na middernacht NL; laatste 7 dagen opgeteld', JSON.stringify(h2.vandaag) === JSON.stringify({ link: 1, kaart: 1 }) && h2.dagen7.kaart === 3 && h2.dagen7.zoeken === 1 && h2.dagen7.link === 1, h2);
    sH._herkomstNu();
    let hj = null; for (let i = 0; i < 50 && !hj; i++) { await new Promise((r) => setTimeout(r, 20)); try { hj = fs.readFileSync(path.join(DH, 'herkomst.json'), 'utf8'); } catch (e) {} }
    const st = fs.statSync(path.join(DH, 'herkomst.json'));
    toets('13 herkomst.json 0600, alleen dagen en aantallen (geen pad of naam)', (st.mode & 0o777) === 0o600 && JSON.stringify(JSON.parse(hj)) === JSON.stringify({ '2026-11-20': { kaart: 2, zoeken: 1, bladeren: 1 }, '2026-11-21': { link: 1, kaart: 1 } }) && !/index|\.md/.test(hj), hj);
    const sH2 = S.maak({ vault: V, dir: DH, nu: () => klok });
    const srt = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
    toets('13 telling overleeft een herstart', srt(sH2.health().herkomst.dagen7) === srt(h2.dagen7), sH2.health().herkomst);
    klok += 8 * 86400000;
    toets('13 na 8 dagen: vandaag leeg, oude dagen buiten de week', JSON.stringify(sH2.health().herkomst) === JSON.stringify({ vandaag: {}, dagen7: {} }), sH2.health().herkomst);
    klok += 120 * 86400000; await sH2.app('POST /app/secondbrain/open', { pad: 'index.md', herkomst: 'terug' }, {}); sH2._herkomstNu();
    let hj2 = ''; for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 20)); hj2 = fs.readFileSync(path.join(DH, 'herkomst.json'), 'utf8'); if (/terug/.test(hj2)) break; }
    toets('13 dagen ouder dan 120 dagen vallen weg', Object.keys(JSON.parse(hj2)).length === 1 && /terug/.test(hj2), hj2); }
    // review ZOU 2: rond de klokwissel (25-10-2026) telt de week zeven kalenderdagen
    const DZ = path.join(W, 'staat-herkomst-zomer'); fs.mkdirSync(DZ, { recursive: true });
    fs.writeFileSync(path.join(DZ, 'herkomst.json'), JSON.stringify({ '2026-10-19': { kaart: 100 }, '2026-10-20': { kaart: 1 }, '2026-10-26': { zoeken: 1 } }));
    const sZ = S.maak({ vault: V, dir: DZ, nu: () => Date.UTC(2026, 9, 26, 22, 30) });   // 26-10 23:30 Amsterdam (wintertijd)
    const srtZ = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
    toets('13 week rond de klokwissel: 20-10 t/m 26-10, niet 19-10', srtZ(sZ.health().herkomst.dagen7) === srtZ({ kaart: 1, zoeken: 1 }), sZ.health().herkomst);

  // wv3735 (3C122): typfouten vergeven via de tekstindex (opt.gelijkend); alleen bij weinig eigen vondsten, achteraan in de tekstgroep
  { const VG = path.join(W, 'vault-g');
    const zg = (p, t) => { fs.mkdirSync(path.dirname(path.join(VG, p)), { recursive: true }); fs.writeFileSync(path.join(VG, p), t); };
    zg('10_Zakelijk/Tolgaarde/Tolgaarde.md', '# Tolgaarde\nHuisartsenpraktijk in Leusden. Telefoon 033-0000000.\n');
    zg('10_Zakelijk/Tolgaarde/Rooster.md', '# Rooster\nWie werkt waar.\n');
    zg('20_Prive/Auto.md', '# Auto\nKenteken XX-00-YY.\n');
    for (let i = 0; i < 6; i++) zg('10_Zakelijk/Map/Kenteken ' + i + '.md', '# k\nkenteken\n');
    let gevraagd = [];
    const TOKG = 'abcd_' + 'Qw3rTy7uIo9pAs1dFg5hJk2lZx4cVb6nM8qW0eR';
    const sg = S.maak({ vault: VG, dir: path.join(W, 'staat-g'), hmac: (p) => 'h' + p.length,
      gelijkend: async (q) => { gevraagd.push(q); return { paginas: ['10_Zakelijk/Tolgaarde/Tolgaarde.md', 'bestaat/niet.md', '20_Prive/Auto.md', '10_Zakelijk/Tolgaarde/Rooster.md'],
        delen: [{ pad: '10_Zakelijk/Tolgaarde/Tolgaarde.md', kop: 'Tolgaarde', van: 1, tekst: '# Tolgaarde\nHuisartsenpraktijk in Leusden. ' + TOKG }] }; } });
    const g1 = await sg.app('POST /app/secondbrain/zoek', { q: 'Tolgarde', soorten: [] }, {});
    const t1 = g1.j.treffers;
    toets('14 typfout: de index-pagina\'s komen erbij als tekst/gelijkend, in de volgorde van de index, buiten de kaart weg',
      t1.map((t) => t.pad).join() === '10_Zakelijk/Tolgaarde/Tolgaarde.md,20_Prive/Auto.md,10_Zakelijk/Tolgaarde/Rooster.md' && t1.every((t) => t.waar === 'gelijkend' && t.groep === 'tekst') && g1.j.groepen.gelijkend === 3 && gevraagd[0] === 'Tolgarde', g1.j);
    toets('14 fragment uit de index, gemaskeerd', /Huisartsenpraktijk in Leusden/.test(t1[0].fragment) && t1[0].fragment.indexOf(TOKG) < 0 && t1[1].fragment === '', t1[0]);
    const g2 = await sg.app('POST /app/secondbrain/zoek', { q: 'Tolgarde', soorten: ['pdf'] }, {});
    const g2b = await sg.app('POST /app/secondbrain/zoek', { q: 'Tolgarde', soorten: ['bronnen'] }, {});
    toets('14 zelfde filter (soort en plek) op de index-pagina\'s', g2.j.treffers.length === 0 && g2b.j.treffers.length === 0, [g2.j.treffers, g2b.j.treffers]);
    const g3 = await sg.app('POST /app/secondbrain/zoek', { q: 'kenteken', soorten: [] }, {});
    toets('14 genoeg eigen vondsten (>= 5): geen index-pagina\'s erbij', g3.j.treffers.every((t) => t.waar !== 'gelijkend') && g3.j.groepen.gelijkend === 0, g3.j.treffers.map((t) => t.waar));
    const g4 = await sg.app('POST /app/secondbrain/zoek', { q: 'Tolgaarde', soorten: [] }, {});
    toets('14 eigen vondst eerst, de index vult aan zonder dubbel', g4.j.treffers[0].pad === '10_Zakelijk/Tolgaarde/Tolgaarde.md' && g4.j.treffers[0].waar !== 'gelijkend' &&
      g4.j.treffers.filter((t) => t.pad === '10_Zakelijk/Tolgaarde/Tolgaarde.md').length === 1, g4.j.treffers);
    const sg2 = S.maak({ vault: VG, dir: path.join(W, 'staat-g2'), hmac: (p) => 'h' + p.length, gelijkend: async () => { throw new Error('index weg'); } });
    const g5 = await sg2.app('POST /app/secondbrain/zoek', { q: 'Tolgarde', soorten: [] }, {});
    const sg3 = S.maak({ vault: VG, dir: path.join(W, 'staat-g3'), hmac: (p) => 'h' + p.length, gelijkend: async () => null });
    const g6 = await sg3.app('POST /app/secondbrain/zoek', { q: 'Tolgarde', soorten: [] }, {});
    toets('14 index faalt of geeft niets: gewoon zonder (200, leeg)', g5.status === 200 && g5.j.treffers.length === 0 && g6.status === 200 && g6.j.treffers.length === 0, [g5, g6]); }

  // ── 15. wv3717 (3C205): "Wat speelt" — deadlines ≤ 14 d, vannacht vastgelegd (dagverslag), bronverkeer deze week; alle namen verzonnen ──
  { const VW = path.join(W, 'vault-w');
    const zw = (p, t) => { fs.mkdirSync(path.dirname(path.join(VW, p)), { recursive: true }); fs.writeFileSync(path.join(VW, p), t); };
    const klokW = Date.UTC(2026, 10, 21, 9, 0);   // za 21-11-2026 10:00 Amsterdam
    zw('10_Zakelijk/Tolgaarde/Proefcontract.md', '# a\n'); zw('10_Zakelijk/Tolgaarde/Proefrooster.md', '# b\n'); zw('20_Prive/Proefreis.md', '# c\n');
    zw('10_Zakelijk/HAGRO/Proefoverleg.md', '# d\n'); zw('10_Zakelijk/Groenhouten/Proefpand.md', '# e\n'); zw('00_Systeem/Deadlines.md', '# dl\n');
    zw('01_Ontwikkeling/Proefplan.md', '# f\n');
    for (let i = 0; i < 25; i++) zw('20_Prive/Veel/Pagina ' + i + '.md', '# p\n');
    zw('00_Systeem/Logboek/2026-11-20.md', '# Logboek\n## Besproken\n- [[10_Zakelijk/Groenhouten/Proefpand]] hoort hier niet\n## Vastgelegd\n' +
      '- Getekend proefcontract → [[10_Zakelijk/Tolgaarde/Proefcontract]] en [[00_Systeem/Deadlines]]\n- Plan → [[01_Ontwikkeling/Proefplan]]\n' +
      '- Reisje **bijgewerkt** → [[Proefreis|de reis]]\n- Gesprekspagina\'s: zonder link\n## Niet bewaard\n- [[10_Zakelijk/HAGRO/Proefoverleg]]\n');
    zw('00_Systeem/Logboek/2026-11-19.md', '# oud\n## Vastgelegd\n- Oud → [[10_Zakelijk/HAGRO/Proefoverleg]]\n');
    // bronverkeer: 3 gesprekken deze week naar Proefoverleg, 1 naar Proefrooster, 4 oude (buiten de week) naar Proefpand, 3 zonder datum
    for (const d of ['2026-11-15', '2026-11-18', '2026-11-21']) zw('30_Conversaties/WhatsApp/Groep - ' + d + '.md', '[[Proefoverleg]] [[Proefoverleg]]' + (d === '2026-11-18' ? ' [[Proefrooster]]' : '') + '\n');
    zw('30_Conversaties/WhatsApp/Groep - 2026-11-14.md', '[[Proefrooster]]\n'); zw('30_Conversaties/WhatsApp/Groep - 2026-11-22.md', '[[Proefrooster]]\n');   // net buiten de week, en morgen
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-14']) zw('10_Zakelijk/Groenhouten/Bronnen/GH - ' + d + ' - brief.md', '[[Proefpand]]\n');
    for (let i = 0; i < 3; i++) zw('raw_input/zonder datum ' + i + '.md', '[[Proefpand]]\n');
    zw('30_Conversaties/Teams/Kanaal - 2026-11-20.md', '[[00_Systeem/Deadlines]] [[Proefplan]]\n');
    zw('30_Conversaties/Teams/Kanaal2 - 2026-11-20.md', '[[00_Systeem/Deadlines]] [[Proefplan]]\n');
    zw('30_Conversaties/Teams/Kanaal3 - 2026-11-20.md', '[[00_Systeem/Deadlines]] [[Proefplan]]\n');
    let dlW = [
      { datum: '2026-11-21', dagen: 0, titel: 'Proefdeadline vandaag', bron: { pad: '10_Zakelijk/Tolgaarde/Proefcontract' } },
      { datum: '2026-12-05', dagen: 14, titel: 'Proefdeadline grens', bron: { pad: 'Proefrooster' } },
      { datum: '2026-12-06', dagen: 15, titel: 'Te laat', bron: { pad: '20_Prive/Proefreis' } },
      { datum: '2026-11-20', dagen: -1, titel: 'Verlopen', bron: { pad: '20_Prive/Proefreis' } },
      { datum: '2026-11-25', dagen: 4, titel: 'Systeem', bron: { pad: '00_Systeem/Deadlines' } },
      { datum: '2026-11-26', dagen: 5, titel: 'Bestaat niet', bron: { pad: 'Nergens' } },
      { datum: '2026-11-27', dagen: 6, titel: 'Tweede op dezelfde pagina', bron: { pad: 'Proefcontract' } },
      { datum: '2026-11-28', dagen: 7, titel: 'In een bron', bron: { pad: '10_Zakelijk/Groenhouten/Bronnen/GH - 2026-11-01 - brief' } },
    ];
    const sw = S.maak({ vault: VW, dir: path.join(W, 'staat-w'), nu: () => klokW, deadlines: () => dlW });
    const w1 = await sw.app('POST /app/secondbrain/vandaag', {}, {});
    const pw = (p) => (w1.j.items.find((x) => x.p === p) || { redenen: [] }).redenen;
    toets('15 status 200, dag en logboek van gisteren', w1.status === 200 && w1.j.dag === '2026-11-21' && w1.j.bronnen.logboek === '2026-11-20' && w1.j.bronnen.deadlines === 'ok', w1.j);
    toets('15 deadline vandaag en precies over 14 dagen licht op, één reden per pagina (de vroegste)',
      pw('10_Zakelijk/Tolgaarde/Proefcontract.md').filter((r) => r.soort === 'deadline').map((r) => r.tekst).join() === 'deadline vandaag: Proefdeadline vandaag' &&
      /^deadline 5-12: Proefdeadline grens$/.test((pw('10_Zakelijk/Tolgaarde/Proefrooster.md').find((r) => r.soort === 'deadline') || {}).tekst), w1.j.items);
    toets('15 geen deadline na 14 dagen, verlopen, in 00_Systeem, onbekend of in een bron', !pw('20_Prive/Proefreis.md').some((r) => r.soort === 'deadline') &&
      !w1.j.items.some((x) => /^00_Systeem|Bronnen/.test(x.p)) && w1.j.tel.deadline === 2 && w1.j.totaal.deadline === 6, [w1.j.tel, w1.j.totaal]);
    toets('15 nacht: alleen sectie Vastgelegd van gisteren, wat vóór de pijl, alias en 00/01 eruit',
      pw('10_Zakelijk/Tolgaarde/Proefcontract.md').some((r) => r.tekst === 'vannacht bijgewerkt: Getekend proefcontract') &&
      pw('20_Prive/Proefreis.md').some((r) => r.tekst === 'vannacht bijgewerkt: Reisje bijgewerkt') &&
      !w1.j.items.some((x) => /Proefplan|Proefpand/.test(x.p)) && !pw('10_Zakelijk/HAGRO/Proefoverleg.md').some((r) => r.soort === 'nacht') && w1.j.tel.nacht === 2, w1.j.items);
    toets('15 verkeer: 3 gesprekken deze week (dubbele link telt één keer), niet oud, niet zonder datum, drempel 3',
      pw('10_Zakelijk/HAGRO/Proefoverleg.md').map((r) => r.tekst).join() === 'deze week in 3 bronnen en gesprekken genoemd' &&
      !pw('10_Zakelijk/Tolgaarde/Proefrooster.md').some((r) => r.soort === 'verkeer') && !w1.j.items.some((x) => /Proefpand/.test(x.p)) && w1.j.tel.verkeer === 1, w1.j.items);
    toets('15 elke pagina heeft een reden, domein mee', w1.j.items.length === 4 && w1.j.items.every((x) => x.redenen.length && typeof x.d === 'number' && x.d >= 0), w1.j.items);
    // meer dan 20: deadlines gaan voor, hooguit 10 deadlines, totaal blijft eerlijk
    dlW = Array.from({ length: 25 }, (_, i) => ({ datum: '2026-11-2' + (i % 9), dagen: i % 9, titel: 'Veel ' + i, bron: { pad: '20_Prive/Veel/Pagina ' + i } }));
    fs.writeFileSync(path.join(VW, '00_Systeem/Deadlines.md'), '# dl gewijzigd\n');
    const w2 = await sw.app('POST /app/secondbrain/vandaag', {}, {});
    toets('15 plafond: 10 deadlines (vroegste eerst), totaal 25, hooguit 20 bolletjes', w2.j.tel.deadline === 10 && w2.j.totaal.deadline === 25 && w2.j.items.length <= 20 &&
      w2.j.items.filter((x) => x.redenen[0].soort === 'deadline').every((x) => /deadline (vandaag|morgen|2[23]-11):/.test(x.redenen[0].tekst)), [w2.j.tel, w2.j.items.map((x) => x.redenen[0].tekst)]);
    const sw2 = S.maak({ vault: VW, dir: path.join(W, 'staat-w2'), nu: () => klokW, deadlines: () => { throw new Error('register weg'); } });
    const w3 = await sw2.app('POST /app/secondbrain/vandaag', {}, {});
    toets('15 register onleesbaar: rest werkt, bron zegt het', w3.status === 200 && w3.j.tel.deadline === 0 && w3.j.tel.nacht === 2 && /niet te lezen/.test(w3.j.bronnen.deadlines), w3.j);
    const sw3 = S.maak({ vault: VW, dir: path.join(W, 'staat-w3'), nu: () => klokW + 86400000 });   // zondag: geen logboek van za 21-11
    const w4 = await sw3.app('POST /app/secondbrain/vandaag', {}, {});
    toets('15 geen dagverslag van gisteren: geen nacht (niet terugvallen op eergisteren), geen deadlinebron', w4.status === 200 && w4.j.tel.nacht === 0 && w4.j.bronnen.logboek === null &&
      w4.j.bronnen.deadlines === 'niet beschikbaar', w4.j);
    // wv3751 (3C179): hetzelfde bronverkeer als getal per knoop op de kaart (grootte), ook onder de drempel van Wat speelt; dag in Amsterdam
    const kw = await sw.app('GET /app/secondbrain', {}, {});
    const vk = new Map((kw.j.verkeer || []).map((x) => [kw.j.knopen[x[0]][0], x[1]]));
    toets('15 wv3751 kaart: verkeer per knoop (3 Proefoverleg, 1 Proefrooster), niet oud, niet 00/01, alleen > 0, week erbij',
      vk.get('10_Zakelijk/HAGRO/Proefoverleg.md') === 3 && vk.get('10_Zakelijk/Tolgaarde/Proefrooster.md') === 1 && !vk.has('10_Zakelijk/Groenhouten/Proefpand.md') &&
      !vk.has('01_Ontwikkeling/Proefplan.md') && !vk.has('00_Systeem/Deadlines.md') && kw.j.verkeer.every((x) => Number.isInteger(x[0]) && x[0] >= 0 && x[0] < kw.j.knopen.length && x[1] > 0) &&
      kw.j.verkeer_week.van === '2026-11-15' && kw.j.verkeer_week.tot === '2026-11-21', [kw.j.verkeer, kw.j.verkeer_week]);
    const ka = await sw.app('POST /app/secondbrain/kaart', { alles: true }, {});
    const vka = new Map((ka.j.verkeer || []).map((x) => [ka.j.knopen[x[0]][0], x[1]]));
    toets('15 wv3751 kaart met alles: zelfde getallen op de juiste knoop (andere nummering)', vka.get('10_Zakelijk/HAGRO/Proefoverleg.md') === 3 && vka.size === vk.size, [...vka]);
    const zDag = Date.UTC(2026, 10, 20, 23, 30);   // vr 20-11 23:30 UTC = za 21-11 00:30 Amsterdam
    fs.utimesSync(path.join(VW, '20_Prive/Proefreis.md'), zDag / 1000, zDag / 1000);
    const kw2 = await S.maak({ vault: VW, dir: path.join(W, 'staat-w4'), nu: () => klokW }).app('GET /app/secondbrain', {}, {});
    toets('15 wv3751 dag per knoop in Amsterdam (00:30 op 21-11 is 21-11, niet de UTC-dag 20-11)', (kw2.j.knopen.find((k) => k[0] === '20_Prive/Proefreis.md') || [])[3] === '2026-11-21', kw2.j.knopen.find((k) => k[0] === '20_Prive/Proefreis.md')); }
  toets('15 server.js geeft de deadlines van Projecten mee', /deadlines: function \(\) \{ const p = appProjecten\(\); return p && Array\.isArray\(p\.deadlines\) \? p\.deadlines : null; \}/.test(fs.readFileSync('server.js', 'utf8')));

  // ── 16. wv3753 (3C208): de stamboom als waaier — POST /app/secondbrain/stamboom (verzonnen namen) ──
  { const VS = path.join(W, 'vault-stam');
    const zs = (p, t) => { fs.mkdirSync(path.dirname(path.join(VS, p)), { recursive: true }); fs.writeFileSync(path.join(VS, p), t); };
    const M = '20_Prive/Familie/Stamboom/';
    const fm = (o) => '---\n' + Object.keys(o).map((k) => k + ': ' + o[k]).join('\n') + '\n---\n# x\n';
    zs(M + 'Proef Midden (1980).md', fm({ type: 'persoon', naam: '"Proef Midden"', geslacht: '"man"', geboren: '"1980-02-03"', relatie_tot_david: '"zelf"', kwartierstaat: 1,
      ouders: '["[[20_Prive/Familie/Stamboom/Proef Vader (1950)|Proef Vader]]", "[[Proef Moeder (1952)]]"]', partners: '["[[20_Prive/Familie/Partner Elders]]"]', kinderen: '' }));
    zs(M + 'Proef Vader (1950).md', fm({ naam: '"Proef Vader"', geslacht: '"man"', geboren: '"1950"', overleden: '"2020-01-01"', kwartierstaat: 2, ouders: '', kinderen: '["[[Proef Midden (1980)]]", "[[Proef Broer (1982)]]"]' }));
    zs(M + 'Proef Moeder (1952).md', '---\nnaam: "Proef Moeder"\ngeslacht: "vrouw"\nkwartierstaat: "3"\nouders:\n  - "[[Proef Opa Zondernummer]]"\n---\n');
    zs(M + 'Proef Opa Zondernummer.md', fm({ naam: '"Proef Opa Zondernummer"', geslacht: '"man"', kwartierstaat: '' }));
    zs(M + 'Proef Broer (1982).md', fm({ naam: '"Proef Broer"', geslacht: '"man"', ouders: '["[[Proef Vader (1950)]]"]' }));
    zs(M + 'Proef Raar nummer.md', fm({ naam: '"Proef Raar"', kwartierstaat: '"12a"' }));
    zs(M + 'Zonder frontmatter.md', '# geen kop\n');
    zs(M + 'Deelmap/Proef Diep.md', fm({ naam: '"Diep"', kwartierstaat: 9 }));
    zs('20_Prive/Familie/Partner Elders.md', fm({ naam: '"Elders"', kwartierstaat: 7 }));
    zs('10_Zakelijk/Ander/Proef Nummer.md', fm({ naam: '"Ander"', kwartierstaat: 4 }));
    const ss = S.maak({ vault: VS, dir: path.join(W, 'staat-stam') });
    const st = await ss.app('POST /app/secondbrain/stamboom', {}, {});
    const pers = st.j.personen || [];
    const op = (naam) => pers.findIndex((x) => x[1] === naam);
    const mid = pers[op('Proef Midden')] || [];
    toets('16 stamboom: alleen de stamboommap zelf (geen deelmap, geen pagina elders), zonder frontmatter niet mee', st.status === 200 && pers.length === 6 &&
      !pers.some((x) => /Deelmap|Elders|Ander/.test(x[0])) && op('Zonder frontmatter') < 0, pers.map((x) => x[0]));
    toets('16 velden: pad, naam, nummer, geboren, overleden, geslacht, relatie', mid[0] === M + 'Proef Midden (1980).md' && mid[2] === 1 && mid[3] === '1980-02-03' && mid[5] === 'm' && mid[6] === 'zelf' &&
      pers[op('Proef Vader')][4] === '2020-01-01' && pers[op('Proef Moeder')][2] === 3 && pers[op('Proef Moeder')][5] === 'v', mid);
    toets('16 ouders als plek in de lijst (wikilink met pad|tekst en kale naam, ook als YAML-lijst)', JSON.stringify(mid[7]) === JSON.stringify([op('Proef Vader'), op('Proef Moeder')]) &&
      JSON.stringify(pers[op('Proef Moeder')][7]) === JSON.stringify([op('Proef Opa Zondernummer')]), [mid[7], pers[op('Proef Moeder')][7]]);
    toets('16 kinderen terug, link buiten de stamboommap telt alleen in los_n', JSON.stringify(pers[op('Proef Vader')][9]) === JSON.stringify([op('Proef Midden'), op('Proef Broer')]) &&
      mid[8].length === 0 && st.j.los_n === 1, [pers[op('Proef Vader')][9], st.j.los_n]);
    toets('16 leeg nummer = null, onleesbaar nummer = waarschuwing, niet als nummer', pers[op('Proef Opa Zondernummer')][2] === null && pers[op('Proef Raar')][2] === null &&
      st.j.waarschuwingen.length === 1 && /onleesbaar: 12a/.test(st.j.waarschuwingen[0].tekst), st.j.waarschuwingen);
    const st2 = await ss.app('POST /app/secondbrain/stamboom', {}, {});
    toets('16 zelfde kaart = zelfde uitkomst uit het geheugen', st2.j === st.j);
  }
  toets('16 server.js: de route valt onder appSecondBrain (POST /app/secondbrain/…)', /route\.indexOf\('POST \/app\/secondbrain\/'\) === 0\) return typeof appSecondBrain/.test(fs.readFileSync('server.js', 'utf8')));

  // wv3752 (3C195): Losse eindjes — twee lijsten en de klusknoppen (start/stand nep; nooit een echte agent)
  {
    const VE = path.join(W, 'vault-eindjes');
    const ze = (p, t) => { fs.mkdirSync(path.dirname(path.join(VE, p)), { recursive: true }); fs.writeFileSync(path.join(VE, p), t); };
    const klokE = Date.UTC(2026, 10, 22, 12, 0);   // zo 22-11 13:00 Amsterdam
    ze('10_Zakelijk/_Gedeeld/Relaties/Proefpartij.md', '---\ntype: entiteit\n---\n# Proefpartij\nkort\n');                 // dun: 6 bronnen in 30 d
    ze('10_Zakelijk/_Gedeeld/Relaties/Grootpartij.md', '# Groot\n' + 'x'.repeat(3000) + '\n');                               // veel verkeer, maar groot
    ze('10_Zakelijk/_Gedeeld/Relaties/Weinigpartij.md', '# Weinig\n');                                                     // 4 bronnen: onder de drempel
    ze('20_Prive/Financien/Rekeningen/Proefrekening.md', '---\ntype: rekening\n---\n# rek\n');                              // type rekening: nooit
    ze('20_Prive/Herinneringen/Proefherinnering.md', '# herinnering\n');                                                   // Herinneringen: nooit
    ze('00_Systeem/Proefsysteem.md', '# sys\n');
    ze('10_Zakelijk/AGENTS.md', '# agents\n');
    ze('10_Zakelijk/_Gedeeld/Skills-broncode/x/SKILL.md', '# skill\n'); ze('10_Zakelijk/Projecten/P/code/README-deploy.md', '# code\n'); ze('leeg.md', '');
    ze('10_Zakelijk/Tolgaarde/Losse notitie.md', '# Losse notitie\n' + 'y'.repeat(900) + '\n[[Proefpartij]]\n');           // los, groot
    ze('10_Zakelijk/Tolgaarde/Kleine los.md', '# Klein\n');                                                               // los, klein
    ze('10_Zakelijk/Tolgaarde/Gelinkt.md', '# Gelinkt\n[[Kleine los]]\n'.replace('Kleine los', 'Losse notitie') + '');      // linkt naar Losse notitie
    ze('10_Zakelijk/Tolgaarde/Bron achtig.md', '---\ntype: bron\n---\n# bron\n');                                          // type bron: nooit
    ze('10_Zakelijk/Tolgaarde/Nu - TG.md', '---\ntype: entiteit-nu\nbron: pod nachtstap\n---\n# Nu\n');                     // machine: nooit
    ze('10_Zakelijk/Tolgaarde/Promedico-agenda/Week.md', '---\nbron: promedico-agenda@1 (extensie)\n---\n# week\n');        // machine (bron): nooit
    ze('10_Zakelijk/Tolgaarde/Promedico-agenda/Week - botsingen.md', '---\nsoort: x\nmodule: promedico-betekenis@1\n---\n# b\n');   // machine (module): nooit
    ze('10_Zakelijk/Tolgaarde/Shopper/Lange kop.md', '---\ntype: shopper-zoektocht\naannames: ["' + 'z'.repeat(5000) + '"]\n---\n# s\n');   // kop langer dan 4 kB: toch herkend
    for (let i = 0; i < 6; i++) ze('10_Zakelijk/Tolgaarde/Bronnen/TG - 2026-11-' + String(10 + i) + ' - mail ' + i + '.md', '[[Proefpartij]] [[Grootpartij]]\n');
    for (let i = 0; i < 4; i++) ze('30_Conversaties/WhatsApp/Groep - 2026-11-0' + (i + 1) + '.md', '[[Weinigpartij]] [[Grootpartij]]\n');
    ze('30_Conversaties/WhatsApp/Groep - 2026-10-01.md', '[[Weinigpartij]]\n');   // buiten de 30 dagen
    ze('10_Zakelijk/Tolgaarde/Bronnen/TG - 2026-11-16 - mail rek.md', '[[Proefrekening]] [[Proefherinnering]]\n'.repeat(1));
    let gestart = [], antwoord = { ok: true, job_id: 'a'.repeat(16) }, standen = {}, register = [];
    const klusNep = { start: async (prompt, label, min) => { gestart.push({ prompt, label, min }); const a = typeof antwoord === 'function' ? antwoord() : antwoord; return a; },
      stand: (job) => standen[job] || null, grondwet: () => 'GRONDWET-KERN v1 — proef',
      zoek: (label, sinds) => { const x = register.filter((r) => r.label === label && r.started >= sinds - 2000).pop(); return x ? x.job : null; } };
    const DE = path.join(W, 'staat-eindjes');
    let klok = klokE;
    const se = S.maak({ vault: VE, dir: DE, nu: () => klok, klus: klusNep });
    const e1 = await se.app('POST /app/secondbrain/eindjes', {}, {});
    const dunP = (e1.j.dun || []).map((x) => x[0]), losP = (e1.j.los || []).map((x) => x[0]);
    toets('17 eindjes: status 200, maat 30 d / ≥ 5 / < 2 kB, klus aan', e1.status === 200 && e1.j.maat.dagen === 30 && e1.j.maat.min === 5 && e1.j.maat.max_kb === 2 && e1.j.klus_aan === true, e1.j.maat);
    toets('17 dun: alleen de kleine pagina met ≥ 5 bronnen in 30 dagen (niet groot, niet 4, niet rekening/herinnering)',
      JSON.stringify(dunP) === JSON.stringify(['10_Zakelijk/_Gedeeld/Relaties/Proefpartij.md']) && e1.j.dun[0][3] === 6 && e1.j.dun_n === 1, e1.j.dun);
    toets('17 los: niemand linkt ernaar, grootste eerst; niet Systeem, AGENTS, Herinneringen, type bron/rekening, niet als er een link heen gaat',
      losP.indexOf('10_Zakelijk/Tolgaarde/Kleine los.md') >= 0 && losP.indexOf('10_Zakelijk/Tolgaarde/Gelinkt.md') >= 0 && losP.indexOf('10_Zakelijk/Tolgaarde/Losse notitie.md') < 0 &&
      !losP.some((p) => /Proefsysteem|AGENTS|Herinneringen|Bron achtig|Proefrekening|Bronnen\/|Nu - TG|Promedico-agenda|Shopper|SKILL|README|leeg/.test(p)) &&
      e1.j.los.every((x, i, a) => !i || a[i - 1][2] >= x[2]), e1.j.los);
    // klus: niet in de lijst, onbekende soort
    const kNiet = await se.app('POST /app/secondbrain/klus', { pad: '00_Systeem/Proefsysteem.md', soort: 'oogst' }, {});
    const kSoort = await se.app('POST /app/secondbrain/klus', { pad: dunP[0], soort: 'wis' }, {});
    toets('17 klus: pagina buiten de lijsten start niets; onbekende soort = 400', kNiet.j.stand === 'niet-in-lijst' && kSoort.status === 400 && gestart.length === 0, [kNiet.j, kSoort.status]);
    const k1 = await se.app('POST /app/secondbrain/klus', { pad: dunP[0], soort: 'oogst' }, {});
    const g1 = gestart[0] || {};
    toets('17 klus: eerste tik start precies één klus (label socev: Oogst — naam, grondwet vooraan, pad in de opdracht, 45 min)',
      k1.j.stand === 'gestart' && gestart.length === 1 && g1.label === 'socev: Oogst — Proefpartij' && g1.prompt.indexOf('GRONDWET-KERN v1') === 0 &&
      g1.prompt.indexOf('10_Zakelijk/_Gedeeld/Relaties/Proefpartij.md') > 0 && /onderwerp-oogsten/.test(g1.prompt) && /second-brain-verwerk-raw-input/.test(g1.prompt) && /Mail doorzocht op <datum>/.test(g1.prompt) && g1.min === 45, [k1.j, g1.label]);
    const k2 = await se.app('POST /app/secondbrain/klus', { pad: dunP[0], soort: 'links' }, {});
    toets('17 klus: tweede tik (ook de andere knop) terwijl die loopt start niets', k2.j.stand === 'loopt' && gestart.length === 1, k2.j);
    standen['a'.repeat(16)] = 'loopt';
    const e2 = await se.app('POST /app/secondbrain/eindjes', {}, {});
    toets('17 eindjes toont de lopende klus (pad, soort, loopt)', JSON.stringify((e2.j.klussen || [])[0] && e2.j.klussen[0].slice(0, 3)) === JSON.stringify([dunP[0], 'oogst', 'loopt']), e2.j.klussen);
    const opSchijf = JSON.parse(fs.readFileSync(path.join(DE, 'klussen.json'), 'utf8'));
    toets('17 klussen.json 0600 met job; overleeft een herstart (nieuwe module ziet hem lopen)', (fs.statSync(path.join(DE, 'klussen.json')).mode & 0o777) === 0o600 &&
      opSchijf.k[dunP[0]].job === 'a'.repeat(16) && opSchijf.s.length === 1, opSchijf);
    const se2 = S.maak({ vault: VE, dir: DE, nu: () => klok, klus: klusNep });
    const k3 = await se2.app('POST /app/secondbrain/klus', { pad: dunP[0], soort: 'oogst' }, {});
    toets('17 na herstart: zelfde pagina nog steeds niet dubbel', k3.j.stand === 'loopt' && gestart.length === 1, k3.j);
    // tweede pagina: Leg de links; derde: vol (2 tegelijk)
    antwoord = { ok: true, job_id: 'b'.repeat(16) };
    const k4 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Kleine los.md', soort: 'links' }, {});
    const g2 = gestart[1] || {};
    toets('17 Leg de links: eigen opdracht (linkcheck, alleen dit doel, hooguit 40, geen aliassen), 30 min', k4.j.stand === 'gestart' && g2.label === 'socev: Leg de links — Kleine los' &&
      /second-brain-linkcheck/.test(g2.prompt) && /Hooguit 40/.test(g2.prompt) && /Geen aliassen/.test(g2.prompt) && g2.min === 30, [k4.j, g2.label]);
    const k5 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
    toets('17 hooguit 2 klussen tegelijk', k5.j.stand === 'vol' && gestart.length === 2, k5.j);
    // klaar: de plek komt vrij, de klus blijft zichtbaar als klaar
    standen['a'.repeat(16)] = 'klaar';
    const e3 = await se.app('POST /app/secondbrain/eindjes', {}, {});
    const kl = (e3.j.klussen || []).find((x) => x[0] === dunP[0]) || [];
    toets('17 klaar: stand klaar met eindtijd', kl[2] === 'klaar' && typeof kl[4] === 'string', kl);
    // weigering geeft de plek vrij; time-out houdt hem vast
    antwoord = { ok: false, status: 429 };
    const k6 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
    const naW = JSON.parse(fs.readFileSync(path.join(DE, 'klussen.json'), 'utf8'));
    toets('17 pod weigert (429): stand plekken-bezet, niets vastgehouden, start telt niet', k6.j.stand === 'plekken-bezet' && !naW.k['10_Zakelijk/Tolgaarde/Gelinkt.md'] && naW.s.length === 2, [k6.j, Object.keys(naW.k), naW.s.length]);
    antwoord = { ok: false, status: 0 };
    const k7 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
    const k8 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'oogst' }, {});
    toets('17 time-out: niet-gestart, maar de pagina blijft vast (nooit twee agents)', k7.j.stand === 'niet-gestart' && k8.j.stand === 'loopt', [k7.j, k8.j]);
    klok += 46 * 60000;
    const nVoor8b = gestart.length;
    const k8b = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
    toets('17 Codex MOET 2: na 46 min (langer dan een oogst mag) nog steeds vast', k8b.j.stand === 'loopt' && gestart.length === nVoor8b, k8b.j);
    klok += 30 * 60000;
    antwoord = { ok: true, job_id: 'c'.repeat(16) };
    const k9 = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
    toets('17 na 75 min zonder job: weer vrij', k9.j.stand === 'gestart', k9.j);
    // time-out terwijl de agent wél startte: de pod vindt hem terug in het register en houdt de stand bij
    antwoord = () => { register.push({ label: 'socev: Oogst — Weinigpartij', started: klok, job: 'd'.repeat(16) }); return { ok: false, status: 0 }; };
    standen['b'.repeat(16)] = 'klaar';
    const kT = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Kleine los.md', soort: 'oogst' }, {});
    register[register.length - 1].label = 'socev: Oogst — Kleine los';
    standen['d'.repeat(16)] = 'loopt';
    const eT = await se.app('POST /app/secondbrain/eindjes', {}, {});
    const rT = JSON.parse(fs.readFileSync(path.join(DE, 'klussen.json'), 'utf8')).k['10_Zakelijk/Tolgaarde/Kleine los.md'] || {};
    standen['d'.repeat(16)] = 'klaar';
    const eT2 = await se.app('POST /app/secondbrain/eindjes', {}, {});
    toets('17 Codex MOET 2: time-out maar de agent liep wel = job teruggevonden (loopt, daarna klaar)', kT.j.stand === 'niet-gestart' && rT.job === 'd'.repeat(16) &&
      (eT.j.klussen.find((x) => x[0] === '10_Zakelijk/Tolgaarde/Kleine los.md') || [])[2] === 'loopt' && (eT2.j.klussen.find((x) => x[0] === '10_Zakelijk/Tolgaarde/Kleine los.md') || [])[2] === 'klaar', [kT.j, rT]);
    // daggrens (Codex MOET 1): elke start telt, ook steeds dezelfde pagina na klaar
    standen['c'.repeat(16)] = 'klaar';
    let job = 0, kGrens = null;
    antwoord = () => ({ ok: true, job_id: (0xe0 + job++).toString(16).padStart(16, '0') });
    const sTel = () => JSON.parse(fs.readFileSync(path.join(DE, 'klussen.json'), 'utf8')).s.filter((x) => new Date(x).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }) === new Date(klok).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })).length;
    for (let i = 0; i < 12; i++) {
      kGrens = await se.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Gelinkt.md', soort: 'links' }, {});
      if (kGrens.j.stand !== 'gestart') break;
      standen[kGrens.j.job] = 'klaar';
    }
    toets('17 Codex MOET 1: hooguit 10 starts per dag, ook als het steeds dezelfde pagina is', kGrens.j.stand === 'grens' && sTel() === 10, [kGrens.j, sTel()]);
    const se3 = S.maak({ vault: VE, dir: DE, nu: () => klok, klus: klusNep });
    const k10 = await se3.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Kleine los.md', soort: 'oogst' }, {});
    toets('17 daggrens overleeft een herstart', k10.j.stand === 'grens', k10.j);
    klok += 8 * 86400000;
    const e4 = await se3.app('POST /app/secondbrain/eindjes', {}, {});
    toets('17 afgeronde klussen na 7 dagen weg', (e4.j.klussen || []).length === 0, e4.j.klussen);
    // zonder klus-koppeling of grondwet
    const se4 = S.maak({ vault: VE, dir: path.join(W, 'staat-eindjes4'), nu: () => klok });
    const k11 = await se4.app('POST /app/secondbrain/klus', { pad: dunP[0], soort: 'oogst' }, {});
    const e5 = await se4.app('POST /app/secondbrain/eindjes', {}, {});
    const se5 = S.maak({ vault: VE, dir: path.join(W, 'staat-eindjes5'), nu: () => klok, klus: Object.assign({}, klusNep, { grondwet: () => null }) });
    const n0 = gestart.length;
    const k12 = await se5.app('POST /app/secondbrain/klus', { pad: '10_Zakelijk/Tolgaarde/Kleine los.md', soort: 'oogst' }, {});
    toets('17 zonder koppeling: stand uit, lijsten wel; zonder grondwet-blok start niets', k11.j.stand === 'uit' && e5.j.klus_aan === false && e5.j.los.length > 0 &&
      k12.status === 503 && gestart.length === n0, [k11.j, k12.j]);
  }
  {
    const src = fs.readFileSync('server.js', 'utf8');
    toets('17 server.js: klus-koppeling alleen met de twee vaste labels, route socev (chat 40687), stand uit agentsReg, grondwet uit de release',
      /klus: \{\s*start: function \(prompt, label, min\)/.test(src) && /\^socev: \(Oogst\|Leg de links\) — /.test(src) && /grondwet: function \(\) \{ return typeof autoGrondwet === 'function' \? autoGrondwet\(\) : null; \}/.test(src));
  }
  fs.rmSync(W, { recursive: true, force: true });
  console.log('\n' + goed + ' groen, ' + fouten + ' rood');
  process.exit(fouten ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
JS
