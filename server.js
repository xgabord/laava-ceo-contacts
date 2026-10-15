import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { scan, status, dashboard } from './worker.js';

const port=Number(process.env.PORT||3005);
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
  res.end(JSON.stringify({ok:true,service:'laava-ceo-contacts',version:'0.2.0',mode:process.env.GCONTACTS_SYNC_ENABLED==='true'?'google-contacts':'dry-run'}));return;
 }
 if(!verify(req)){
  res.writeHead(process.env.ADMIN_PASSWORD?401:503,{'content-type':'text/plain','WWW-Authenticate':'Basic realm="CEO Contacts"'});
  res.end('Administrator credentials required');return;
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
   let data;try{data=JSON.parse(raw)}catch{throw new Error('Google Script returned non-JSON response')}
   res.writeHead(data.ok?200:502,{'content-type':'application/json'});
   res.end(JSON.stringify({ok:Boolean(data.ok),peopleApi:Boolean(data.peopleApi),status:data.status||null,error:data.error||null}));
  }catch(err){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:String(err.message||err).slice(0,120)}))}
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
