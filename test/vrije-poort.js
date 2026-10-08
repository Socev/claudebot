// Vrije poort voor een toets (wv229, 8-10-2026). Vaste poorten botsten als twee agents dezelfde toets tegelijk
// draaiden (EADDRINUSE; de toets praatte dan met de server van de buurman). De kernel kiest hier een ongebruikte
// poort (listen 0), die we lezen en weer sluiten. Synchroon, zodat `const poort = vrijePoort();` overal past.
// In een toets: const vrijePoort = require(require('path').resolve('test/vrije-poort.js'));  In bash: POORT=$(node test/vrije-poort.js)
const { execFileSync } = require('child_process');
const KIES = "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
function vrijePoort() {
  const p = Number(execFileSync(process.execPath, ['-e', KIES], { encoding: 'utf8' }));
  if (!(p > 0)) throw new Error('geen vrije poort gekregen');
  return p;
}
module.exports = vrijePoort;
if (require.main === module) console.log(vrijePoort());
