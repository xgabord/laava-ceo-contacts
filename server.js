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
const server=http.createServer((req,res)=>{
 const url=new URL(req.url||'/', 'http://localhost');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 if(url.pathname==='/health'){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({ok:true,service:'laava-ceo-contacts',version:'0.2.0',mode:'dry-run'}));return;
 }
 if(!verify(req)){
  res.writeHead(process.env.ADMIN_PASSWORD?401:503,{'content-type':'text/plain','WWW-Authenticate':'Basic realm="CEO Contacts"'});
  res.end('Administrator credentials required');return;
 }
 if(url.pathname==='/status'){
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(status()));return;
 }
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
 res.end(dashboard());
});
server.listen(port,'0.0.0.0',()=>{
 console.log('CEO Contacts dry-run listening on '+port);
 scan();
 setInterval(scan,Math.max(60,Number(process.env.POLL_SECONDS||60))*1000).unref();
});
