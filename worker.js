import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { history:[],historyError:null,lastRun: null, lastAttempt: null, lastConnected: null, connection: 'not_configured', error: null, running: false, sync: {enabled:false, state:'disabled', created:0, existing:0, errors:0, lastResult:null, cursor:null, cursorStore:'not_checked', rejected:0} };
const localDomains = new Set(['laava.hu', 'matezz.hu', 'matezz.ro', 'matchai.hu']);
let nextLiveUid=null;
let knownUidValidity=null;
async function cursorRequest(action,cursor) {
 const endpoint=process.env.GCONTACTS_SCRIPT_URL,secret=process.env.GCONTACTS_SCRIPT_SECRET;
 if(!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(endpoint||'')||!secret||secret.length<32)throw Error('Google cursor store is not configured');
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({secret,action,...(cursor?{cursor}:{})}),signal:AbortSignal.timeout(25000)});
 const data=await response.json();
 if(!response.ok||!data.ok)throw Error('Persistent cursor: '+String(data.error||response.status));
 return data.cursor||null;
}

async function loadHistory(){
 const endpoint=process.env.GCONTACTS_SCRIPT_URL,secret=process.env.GCONTACTS_SCRIPT_SECRET;
 if(!endpoint||!secret)return;
 try{
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({secret,action:'history_get'}),signal:AbortSignal.timeout(25000)});
  const data=await response.json();
  if(!response.ok||!data.ok)throw Error(String(data.error||response.status));
  results.history=Array.isArray(data.items)?data.items.slice(0,100):[];
  results.historyError=null;
 }catch(err){results.historyError=String(err.message||err).slice(0,140)}
}
async function sendToGoogle(contact) {
 const endpoint=process.env.GCONTACTS_SCRIPT_URL;
 const secret=process.env.GCONTACTS_SCRIPT_SECRET;
 if(!/^https:\/\/script\.google\.com\/macros\/s\//.test(endpoint||'')||!secret||secret.length<32)throw Error('Google Script URL or secret missing');
 const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({secret,contact}),signal:AbortSignal.timeout(20000)});
 const json=await response.json();
 if(!response.ok||!json.ok)throw Error('Google sync: '+String(json.error||response.status));
 return json.status;
}
const html = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function status() { return { ...results, candidates: [...results.candidates] }; }
function candidate(mail) {
 const from = mail.from?.value?.[0];
 const email = from?.address?.trim().toLowerCase();
 if (!email || localDomains.has(email.split('@')[1])) return { reason: 'belső / hiányzó feladó' };
 if (/no-?reply|newsletter|notification|mailer-daemon|postmaster|bounce|ertesites|értesítés|ertesito|automata|robot|szamlazz\.hu|hello\.notion\.so/i.test(email)) return { reason: 'automata feladó' };
 if (['list-id','list-unsubscribe','auto-submitted'].some(k=>mail.headers?.has(k))) return { reason: 'hírlevél / automata fejléc' };
 const body = (mail.text || '').split(/\n(?:From:|Feladó:|On .+wrote:|-----Original Message-----)/i)[0];
 const visible = body.split(/\n\s*(?:On .{5,120}wrote:|Feladó:|From:|Eredeti üzenet|Original Message|_{8,}|-{8,})/i)[0];
 const signature = visible.split('\n').slice(-18).join('\n');
 const phones = [...new Set(findPhoneNumbersInText(signature,'HU').filter(v=>v.number.isValid()).map(v=>v.number.number))];
 if (phones.length !== 1) return { reason: phones.length===0 ? 'nem találtunk telefonszámot' : 'több telefonszám' };
 const name = (from.name||'').trim();
 if (/(?:értesítő|ertesito|értesítés|ertesites|notification|automated|automata|ügyfélszolgálat|ugyfelszolgalat|customer service|support|logistics|webshop|team|csapat|system|rendszer|vevőszolgálat|vevoszolgalat|accounto|acounto|hosting|kurier|sales|\bfrom\b|\bKft\b|\bLLC\b|\bLtd\b|\bGmbH\b|\bplanet\b|\bpack\b)/i.test(name)) return { reason: 'nem személy / szervezeti feladó' };
 if (!/^[\p{L}][\p{L}\p{M} .'-]{3,89}$/u.test(name) || name.split(/\s+/).length < 2) return { reason: 'nem megbízható név' };
 const domain=email.split('@')[1]||'';
 const companyLine=signature.split('\n').map(line=>line.trim()).find(line=>
  /^(?:cég|ceg|company|vállalat|organization|organisation)\s*:\s*\S/i.test(line)||
  /\b(?:Kft\.?|Zrt\.?|Bt\.?|GmbH|Ltd\.?|Limited|LLC|Inc\.?|S\.r\.l\.?|S\.R\.O\.?|SAS|S\.A\.)\s*$/i.test(line)
 );
 const company=companyLine?companyLine.replace(/^(?:cég|ceg|company|vállalat|organization|organisation)\s*:\s*/i,'').slice(0,120):domain;
 return { contact: {name,email,phone:phones[0],company} };
}
export async function scan() {
 if (results.running) return;
 results.lastAttempt = new Date().toISOString();
 if (!process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASSWORD) {
  results.connection='not_configured'; results.error='Hiányzó IMAP_HOST, IMAP_USER vagy IMAP_PASSWORD beállítás.'; return;
 }
 results.running=true; results.error=null; results.connection='connecting';
 const client = new ImapFlow({host:process.env.IMAP_HOST,port:Number(process.env.IMAP_PORT||993),secure:true,auth:{user:process.env.IMAP_USER,pass:process.env.IMAP_PASSWORD},logger:false});
 try {
  await client.connect();
  results.connection='connected'; results.lastConnected=new Date().toISOString();
  const lock=await client.getMailboxLock('INBOX',{readOnly:true});
  try {
   const sync=results.sync;
   sync.enabled=process.env.GCONTACTS_SYNC_ENABLED==='true';
   sync.state=sync.enabled?'configured':'disabled';
   const uidNext=Number(client.mailbox.uidNext);
   const uidValidity=Number(client.mailbox.uidValidity);
   if(!Number.isSafeInteger(uidNext)||!Number.isSafeInteger(uidValidity)||uidValidity<1)throw Error('Invalid IMAP UID state');
   if(sync.enabled){
    const saved=await cursorRequest('cursor_get');
    sync.cursorStore='connected';
    if(!saved || Number(saved.uidValidity)!==uidValidity){
     // First activation or mailbox replacement: start at the current mailbox tail.
     const initial={uidValidity,nextUid:uidNext};
     await cursorRequest('cursor_set',initial);
     nextLiveUid=uidNext;
     knownUidValidity=uidValidity;
     sync.state='initialized';
    }else{
     nextLiveUid=Number(saved.nextUid);
     knownUidValidity=uidValidity;
    }
    sync.cursor=nextLiveUid;
   }else{
    sync.cursorStore='inactive';
    sync.state='disabled';
   }
   // Historical backfill intentionally disabled: only process newly arrived UID messages.
   // Process only unseen UIDs. Save progress after each message to survive redeploys.
   if(sync.enabled && nextLiveUid!==null && uidNext>nextLiveUid) {
    let failed=false;
    const upper=uidNext-1;
    for await(const msg of client.fetch(nextLiveUid+':'+upper,{source:true,uid:true},{uid:true})) {
     if(!msg.uid || msg.uid<nextLiveUid || msg.uid>upper)continue;
     try {
      if(msg.source){
       const parsed=candidate(await simpleParser(msg.source));
       if(parsed.contact){
        const outcome=await sendToGoogle(parsed.contact);
        if(outcome==='created')sync.created++;
        else if(outcome==='exists')sync.existing++;
        else throw Error('Unexpected Google response');
        sync.lastResult=outcome;
       }else{
        sync.rejected++;
       }
      }
      await cursorRequest('cursor_set',{uidValidity,nextUid:msg.uid+1});
      nextLiveUid=msg.uid+1;
      sync.cursor=nextLiveUid;
      sync.state='active';
     }catch(err){
      failed=true;
      sync.errors++; sync.lastResult='error';sync.state='error';
      results.error=String(err.message||err).slice(0,160);
      console.error('Contact sync failed:',results.error);
      break;
     }
    }
    if(!failed && nextLiveUid<uidNext){
     // Missing/expunged UIDs are safely skipped after a successful full-range fetch.
     await cursorRequest('cursor_set',{uidValidity,nextUid:uidNext});
     nextLiveUid=uidNext;
     sync.cursor=nextLiveUid;
    }
   }
   if(sync.enabled && sync.state==='configured')sync.state='active';
  } finally { lock.release(); }
  await loadHistory();
  results.lastRun=new Date().toISOString();
 } catch(e) {results.connection='error'; results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard(buildInfo={}) {
 const stamp=buildInfo.startedAt?new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'medium',timeStyle:'short'}).format(new Date(buildInfo.startedAt)):'–';
 const safe=html;
 const rows=results.history.map(c=>'<tr><td>'+safe(c.name)+'</td><td>'+safe(c.company||'–')+'</td><td><div>'+safe(c.email)+'</div><small>'+safe(c.phone)+'</small></td><td><span class="tag '+(c.status==='created'?'new':'existing')+'">'+(c.status==='created'?'Új':'Már létezett')+'</span></td><td>'+safe(c.time?new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'short',timeStyle:'short'}).format(new Date(c.time)):'–')+'</td></tr>').join('');
 const age=results.lastRun?Date.now()-new Date(results.lastRun).getTime():Infinity;
 const online=results.connection==='connected' && !results.error && age<Math.max(180000,Number(process.env.POLL_SECONDS||60)*3000) && results.sync.enabled && results.sync.state!=='error';
 const text=online?'Aktív e-mail-figyelés':!results.sync.enabled?'Automatikus mentés kikapcsolva':results.error?'Kapcsolati hiba':'Figyelés ellenőrzése...';
 return '<!doctype html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b1019"><title>CEO Contacts Sync</title><style>'+
 ':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0b1019;color:#ecf2fa;font:15px system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:0 auto;padding:34px 22px 64px}header{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}h1{font-size:25px;letter-spacing:-.65px;margin:0}h2{font-size:17px;margin:0 0 16px}.muted,small{color:#8d9bac}.meta{font-size:12px;margin-top:8px}.panel{background:#151c29;border:1px solid #293448;border-radius:17px;padding:22px;margin-top:24px}.monitor{display:flex;align-items:center;gap:13px}.pulse{width:12px;height:12px;border-radius:50%;background:#748195;flex:0 0 auto}.pulse.active{background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:ping 1.8s infinite}@keyframes ping{0%{box-shadow:0 0 0 0 rgba(52,211,153,.4)}70%{box-shadow:0 0 0 11px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}@media(prefers-reduced-motion:reduce){.pulse.active{animation:none}}.status{font-weight:650;font-size:17px}.stats{display:flex;gap:24px;flex-wrap:wrap;margin-top:18px}.stat strong{display:block;font-size:23px}.stat span{font-size:12px;color:#95a2b3}.tablewrap{overflow-x:auto}table{width:100%;border-collapse:collapse}th{text-align:left;color:#91a0b3;font-weight:500;font-size:12px}td,th{padding:13px 10px;border-bottom:1px solid #273143;vertical-align:middle}td{overflow-wrap:anywhere}.tag{font-size:12px;padding:5px 9px;border-radius:20px;background:#303847;color:#d3dce7;white-space:nowrap}.tag.new{background:#123e35;color:#79e4bd}button{border:1px solid #34445b;background:#222d40;color:#e7eef8;border-radius:10px;padding:9px 13px;cursor:pointer}button:hover{background:#2b3950}.empty{color:#91a0b3;padding:22px 0}.footer{color:#8493a6;font-size:12px;margin-top:30px}.alert{color:#f0b9aa;font-size:13px;margin-top:10px}'+
 '</style></head><body><main><header><div><h1>CEO Contacts Sync</h1><div class="meta muted">v'+safe(buildInfo.version||'–')+' · '+safe(buildInfo.commit||'–')+' · Indítva: '+safe(stamp)+' (Budapest)</div></div><button type="button" onclick="location.reload()">Frissítés</button></header>'+
 '<section class="panel"><div class="monitor"><span id="pulse" class="pulse '+(online?'active':'')+'" aria-hidden="true"></span><div><div class="status" id="watchState">'+safe(text)+'</div><small id="lastCheck">Utolsó sikeres ellenőrzés: '+safe(results.lastRun?new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',dateStyle:'short',timeStyle:'short'}).format(new Date(results.lastRun)):'nincs adat')+'</small></div></div><div class="stats"><div class="stat"><strong>'+results.sync.created+'</strong><span>Új névjegy (indítás óta)</span></div><div class="stat"><strong>'+results.sync.existing+'</strong><span>Már létezett (indítás óta)</span></div><div class="stat"><strong>'+results.sync.errors+'</strong><span>Szinkronhibák (indítás óta)</span></div></div>'+(results.error?'<p class="alert">'+safe(results.error)+'</p>':'')+'</section>'+
 '<section class="panel"><h2>Feldolgozott névjegyek</h2>'+(results.historyError?'<p class="alert">Napló: '+safe(results.historyError)+'</p>':'')+'<div class="tablewrap"><table><thead><tr><th>Név</th><th>Cég</th><th>Elérhetőség</th><th>Eredmény</th><th>Időpont</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5" class="empty">Még nincs feldolgozott névjegy.</td></tr>')+'</tbody></table></div></section>'+
 '<p class="footer">Csak az újonnan érkező leveleket figyeli. A korábbi leveleket nem dolgozza fel. A lista legfeljebb 100 feldolgozott kontaktot mutat.</p></main>'+
 '<script>const poll=async()=>{try{const r=await fetch("/status",{cache:"no-store"});if(!r.ok)throw Error();const d=await r.json();const age=d.lastRun?Date.now()-Date.parse(d.lastRun):Infinity;const active=d.connection==="connected"&&!d.error&&d.sync.enabled&&d.sync.state!=="error"&&age<'+Math.max(180000,Number(process.env.POLL_SECONDS||60)*3000)+';document.getElementById("pulse").classList.toggle("active",active);document.getElementById("watchState").textContent=active?"Aktív e-mail-figyelés":!d.sync.enabled?"Automatikus mentés kikapcsolva":d.error?"Kapcsolati hiba":"Figyelés ellenőrzése...";document.getElementById("lastCheck").textContent="Utolsó sikeres ellenőrzés: "+(d.lastRun?new Date(d.lastRun).toLocaleString("hu-HU",{timeZone:"Europe/Budapest"}):"nincs adat")}catch{document.getElementById("pulse").classList.remove("active");document.getElementById("watchState").textContent="A figyelés állapota nem ellenőrizhető"}};setInterval(poll,30000)</script></body></html>';
}
