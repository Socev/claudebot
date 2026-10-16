#!/usr/bin/env bash
# wv390: toetst berichtVeeg (server.js) los: start bericht.py --veeg alleen als er een .json-wachtbestand is. Raakt de pod en mk-scripts niet.
set -u
cd "$(dirname "$0")/.." || exit 1
node - <<'JS'
const fs=require('fs'),os=require('os'),path=require('path');const {spawn}=require('child_process');
const src=fs.readFileSync(require('path').join(process.cwd(),'server.js'),'utf8');
const a=src.indexOf('const BERICHT_VEEG_MAP'), b=src.indexOf('setTimeout(berichtVeeg');
const W=fs.mkdtempSync(path.join(os.tmpdir(),'veeg-')); const M=path.join(W,'wacht'); fs.mkdirSync(M);
const S=path.join(W,'nep.py'); fs.writeFileSync(S,"import sys,pathlib;pathlib.Path('"+W+"/gestart').write_text(' '.join(sys.argv[1:]))\n");
process.env.BERICHT_VEEG_MAP=M; process.env.BERICHT_VEEG_SCRIPT=S; const fouten=[]; const logError=(w,e)=>fouten.push(w+String(e));
eval(src.slice(a,b)+';globalThis.bv=berichtVeeg;');
const r1=bv(); fs.writeFileSync(path.join(M,'x.json.123.tmp'),'{}'); const r2=bv();
fs.writeFileSync(path.join(M,'x.json'),'{}'); const r3=bv();
setTimeout(()=>{const g=fs.existsSync(W+'/gestart')&&fs.readFileSync(W+'/gestart','utf8');
 process.env.BERICHT_VEEG_MAP=path.join(W,'bestaatniet');
 console.log((!r1&&!r2&&r3&&g==='--veeg'&&fouten.length===0)?'GROEN veegtoets':'ROOD veegtoets',r1,r2,r3,g,fouten);},800);
JS
