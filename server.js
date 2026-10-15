import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { scan, status, dashboard } from './worker.js';

const port=Number(process.env.PORT||3005);
let lastContactTest={status:'not_tested',time:null};
function verify(req){
 const user=process.env.ADMIN_USER, pass=process.env.ADMIN_PASSWORD;
 if (!user || !pass || pass.length<16) return false;
 const auth=req.headers.authorization||'';
 if(!auth.startsWith('Basic '))return false;
 let decoded='';
 try{decoded=Buffer.from(auth.slice(6),'base64').toString('utf8')}catch{return false}
 const expected=Buffer.from(user+':'+pass), actual=Buffer.from(decoded);
 return actual.length===expected.length && timingSafeEqual(actual,expected);
}
const server=http.createServer(async (req,res)=>{
 const url=new URL(req.url||'/', 'http://localhost');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 if(url.pathname==='/health'){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,service:'laava-ceo-contacts',version:'0.3.0',mode:process.env.GCONTACTS_SYNC_ENABLED==='true'?'google-contacts':'dry-run'}));return;
 }
 if(!verify(req)){
  res.writeHead(process.env.ADMIN_PASSWORD?401:503,{'content-type':'text/plain','WWW-Authenticate':'Basic realm="CEO Contacts"'});
  res.end('Administrator credentials required');return;
 }
 if(url.pathname==='/google-diagnostics' && req.method==='GET'){
  const endpoint=process.env.GCONTACTS_SCRIPT_URL||'';
  const secret=process.env.GCONTACTS_SCRIPT_SECRET||'';
  const report={syncEnabled:process.env.GCONTACTS_SYNC_ENABLED==='true',urlConfigured:/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint),secretConfigured:secret.length>=32};
  if(report.urlConfigured&&report.secretConfigured){
   try{
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'ping',secret}),signal:AbortSignal.timeout(20000)});
    report.googleHttpStatus=response.status;
    report.googleHost=new URL(response.url).hostname;
    report.googleContentType=response.headers.get('content-type')||'unknown';
    const raw=await response.text();
    try{
     const data=JSON.parse(raw);
     report.googleResult={ok:!!data.ok,status:data.status||null,error:data.error||null};
    }catch{
     report.googleResult={ok:false,error:'Google did not return JSON',htmlResponse:/<!doctype html|<html/i.test(raw),loginPage:/sign in|bejelentkez|accounts.google.com/i.test(raw)};
    }
   }catch(err){report.googleError=String(err.message||err).slice(0,140)}
  }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
  const escape=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Google diagnosztika</title><main style="font:16px system-ui;max-width:800px;margin:40px auto;padding:20px"><h1>Google Contacts kapcsolat – diagnosztika</h1><p>Csak olvasási teszt, nem ment névjegyet.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">'+escape(JSON.stringify(report,null,2))+'</pre><a href="/">Vissza</a></main>');
  return;
 }
 if(url.pathname==='/google-test' && req.method==='POST'){
  const endpoint=process.env.GCONTACTS_SCRIPT_URL||'';
  const secret=process.env.GCONTACTS_SCRIPT_SECRET||'';
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint) || secret.length<32){
   res.writeHead(503,{'content-type':'application/json'});
   res.end(JSON.stringify({ok:false,error:'Google Script URL or secret not configured'}));return;
  }
  try{
   const reply=await fetch(endpoint,{method:'POST',headers:{'content-type':'text/plain;charset=utf-8'},body:JSON.stringify({action:'ping',secret}),signal:AbortSignal.timeout(20000)});
   const raw=await reply.text();
   let data;try{data=JSON.parse(raw)}catch{const finalHost=new URL(reply.url).hostname;res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'Google Script nem JSON választ adott',googleHttpStatus:reply.status,googleHost:finalHost,contentType:reply.headers.get('content-type')||'unknown'}));return}
   res.writeHead(data.ok?200:502,{'content-type':'application/json'});
   res.end(JSON.stringify({ok:Boolean(data.ok),peopleApi:Boolean(data.peopleApi),status:data.status||null,error:data.error||null}));
  }catch(err){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:String(err.message||err).slice(0,120)}))}
  return;
 }
 if(url.pathname==='/google-test-history' && req.method==='GET'){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(lastContactTest));return;
 }
 if(url.pathname==='/google-contact-test' && req.method==='POST'){
  if(req.headers.origin && req.headers.origin!==('https://'+req.headers.host)){
   res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'Invalid origin'}));return;
  }
  const endpoint=process.env.GCONTACTS_SCRIPT_URL||'',secret=process.env.GCONTACTS_SCRIPT_SECRET||'';
  if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint)||secret.length<32){
   res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'Google kapcsolat nincs konfigurálva'}));return;
  }
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)throw Error('Too much data')}
   const input=JSON.parse(raw),contact={
    name:String(input.name||'').trim(),email:String(input.email||'').trim().toLowerCase(),
    phone:String(input.phone||'').trim(),company:String(input.company||'').trim()
   };
   if(!input.confirm||!/^.{5,90}$/u.test(contact.name)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)||!/^\+\d{7,15}$/.test(contact.phone)||contact.company.length>120)
    throw Error('Hiányzó jóváhagyás vagy hibás adatok');
   const reply=await fetch(endpoint,{method:'POST',headers:{'content-type':'text/plain;charset=utf-8'},body:JSON.stringify({secret,contact}),signal:AbortSignal.timeout(25000)});
   const result=await reply.json();
   lastContactTest={time:new Date().toISOString(),status:result.status||'unknown',ok:Boolean(result.ok),error:result.error||null};
   res.writeHead(result.ok?200:502,{'content-type':'application/json'});
   res.end(JSON.stringify({ok:!!result.ok,status:result.status||null,error:result.error||null}));
  }catch(err){
   lastContactTest={time:new Date().toISOString(),status:'error',ok:false,error:String(err.message||err).slice(0,120)};
   res.writeHead(400,{'content-type':'application/json'});
   res.end(JSON.stringify({ok:false,error:String(err.message||err).slice(0,120)}));
  }
  return;
 }
 if(url.pathname==='/status'){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(status()));return;
 }
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 res.end(dashboard());
});
server.listen(port,'0.0.0.0',()=>{
 console.log('CEO Contacts listening on '+port+' (Google sync: '+(process.env.GCONTACTS_SYNC_ENABLED==='true'?'enabled':'disabled')+')');
 scan();
 setInterval(scan,Math.max(60,Number(process.env.POLL_SECONDS||60))*1000).unref();
});
