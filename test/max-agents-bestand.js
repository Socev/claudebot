const fs=require('fs'); const P='/tmp/mxt/m.json'; process.env.MAX_AGENTS_PAD=P; delete process.env.MAX_AGENTS;
const k=()=>{ delete require.cache[require.resolve('./knip.js')]; return require('./knip.js').maxAgents; };
const zet=(o)=>{ if(o===null){try{fs.unlinkSync(P)}catch(e){}} else fs.writeFileSync(P, typeof o==='string'?o:JSON.stringify(o)); const t=new Date(Date.now()+Math.random()*1000); fs.utimesSync?0:0; };
const r=[]; let f;
zet(null); f=k(); r.push(['geen bestand',f(),4]);
zet({max:6,tot:new Date(Date.now()+3600e3).toISOString()}); f=k(); r.push(['6 geldig',f(),6]);
zet({max:6,tot:new Date(Date.now()-1000).toISOString()}); f=k(); r.push(['verlopen',f(),4]);
zet({max:9,tot:new Date(Date.now()+3600e3).toISOString()}); f=k(); r.push(['te hoog',f(),4]);
zet({max:6}); f=k(); r.push(['zonder tot',f(),4]); zet({max:6,tot:new Date(Date.now()+20*86400e3).toISOString()}); f=k(); r.push(['te ver vooruit',f(),4]); zet({max:'6',tot:new Date(Date.now()+3600e3).toISOString()}); f=k(); r.push(['tekst-getal',f(),4]); zet({max:6,tot:'2026-12-01T00:00'}); f=k(); r.push(['zonder zone',f(),4]);
zet('{kapot'); f=k(); r.push(['kapot',f(),4]);
zet({max:6,tot:new Date(Date.now()+3600e3).toISOString()}); process.env.MAX_AGENTS='1'; f=k(); r.push(['env wint',f(),1]); delete process.env.MAX_AGENTS;
// cache: zelfde proces, bestand wijzigt
zet({max:5,tot:new Date(Date.now()+3600e3).toISOString()}); f=k(); const a=f(); fs.writeFileSync(P,JSON.stringify({max:3,tot:new Date(Date.now()+3600e3).toISOString()})); fs.utimesSync(P,new Date(),new Date(Date.now()+5000)); r.push(['cache volgt wijziging',[a,f()].join('>'),'5>3']);
let ok=true; for(const [n,g,v] of r){ const goed=String(g)===String(v); ok=ok&&goed; console.log(goed?'GOED':'FOUT',n,g,v); } process.exit(ok?0:1);
