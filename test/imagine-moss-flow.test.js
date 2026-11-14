'use strict';
// wv3038: de echte flow beeld-tekst-moss (kopie in test/fixtures/imagine-moss, gemaakt met mk-scripts/ovis-imagine/moss/maak-flow.py) tegen
// /object_info van de echte ComfyUI 0.44 (alleen de gebruikte knopen en modelnamen). Geheugen-taak (Imagine): de knopentoets moet hem
// doorlaten met precies één uitvoerknoop = SaveImageWebsocket; de Studio-flow moss-comfyui (SaveImage + PreviewAny met de uitgeschreven
// beschrijving) moet in een geheugen-taak GEWEIGERD worden. Ook: buiten Imagine blijft moss-comfyui gewoon door de toets komen (Studio-kaart).
const fs = require('fs'), path = require('path');
const S = require(path.join(__dirname, '..', 'studio.js'));
const F = path.join(__dirname, 'fixtures', 'imagine-moss');
const oi = JSON.parse(fs.readFileSync(path.join(F, 'object_info.json'), 'utf8'));
const moss = JSON.parse(fs.readFileSync(path.join(F, 'beeld-tekst-moss.json'), 'utf8'));
const oud = JSON.parse(fs.readFileSync(path.join(F, 'moss-comfyui.json'), 'utf8'));
let rood = 0, groen = 0;
const toets = (n, ok, x) => { if (ok) groen++; else rood++; console.log((ok ? 'GROEN ' : 'ROOD  ') + n + (!ok && x !== undefined ? '  [' + JSON.stringify(x).slice(0, 400) + ']' : '')); };
const uitKnopen = (p) => Object.keys(p).filter((k) => oi[p[k].class_type] && oi[p[k].class_type].output_node === true).map((k) => p[k].class_type);
let r = S.flowToets(moss, oi, { ws: true, geheugen: true });
toets('M1 beeld-tekst-moss door de knopentoets van een geheugen-taak', !r.fout && !!r.prompt, r.fout);
toets('M1 precies één uitvoerknoop, en dat is SaveImageWebsocket', r.prompt && uitKnopen(r.prompt).join() === 'SaveImageWebsocket' && r.ws_knopen.length === 1, r.prompt && uitKnopen(r.prompt));
toets('M1 geen SaveImage, PreviewImage of PreviewAny in wat ComfyUI krijgt', r.prompt && !Object.values(r.prompt).some((n) => /^(SaveImage|PreviewImage|PreviewAny)$/.test(n.class_type)));
toets('M1 modellen: MOSS-Image SFT int8, Qwen3.5 9B w4a8, flux2-vae small', moss['1'].inputs.unet_name === 'moss_image_sft_int8_convrot.safetensors' && moss['2'].inputs.clip_name === 'qwen3.5_9b_w4a8_gptq.safetensors' && moss['3'].inputs.vae_name === 'flux2-vae_small.safetensors');
r = S.flowToets(oud, oi, { ws: true, geheugen: true });
toets('M2 moss-comfyui (SaveImage + PreviewAny) in een geheugen-taak: geweigerd op PreviewAny', !!r.fout && /PreviewAny/.test(r.fout), r);
r = S.flowToets(oud, oi);
toets('M3 moss-comfyui buiten Imagine (Studio-kaart) komt nog door de toets (Save → Preview)', !r.fout && r.prompt && r.prompt['9'].class_type === 'PreviewImage', r.fout);
const metPrev = Object.assign({}, moss, { 99: { class_type: 'PreviewAny', inputs: { source: ['4', 0] } } });
r = S.flowToets(metPrev, oi, { ws: true, geheugen: true });
toets('M4 beeld-tekst-moss met een PreviewAny erbij: geweigerd', !!r.fout && /PreviewAny/.test(r.fout), r);
// wv3044: MOSS breidt zelf niet meer stil uit (uitbreiden = aparte, zichtbare stap); de opdracht gaat letterlijk naar CLIPTextEncode
toets('M5 beeld-tekst-moss zonder TextGenerate of ComfySwitchNode; CLIPTextEncode leest de opdracht zelf', !Object.values(moss).some((n) => /^(TextGenerate|TextGenerateV2|ComfySwitchNode)$/.test(n.class_type)) && JSON.stringify(moss['8'].inputs.text) === '["4",0]');
console.log(rood + ' ROOD, ' + groen + ' GROEN');
process.exit(rood ? 1 : 0);
