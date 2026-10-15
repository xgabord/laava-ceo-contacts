import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { lastRun: null, lastAttempt: null, lastConnected: null, connection: 'not_configured', error: null, checked: 0, mailboxTotal: 0, rejected: {}, candidates: [], running: false, backfillNext: null, backfillDone: false, backfillProcessed: 0, uniqueContacts: 0, sync: {enabled:false, state:'disabled', created:0, existing:0, errors:0, lastResult:null} };
const localDomains = new Set(['laava.hu', 'matezz.hu', 'matezz.ro', 'matchai.hu']);
let nextLiveUid=null;
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
 const company=email.split('@')[1] || '';
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
   const count=client.mailbox.exists;
   const sync=results.sync;
   sync.enabled=process.env.GCONTACTS_SYNC_ENABLED==='true';
   sync.state=sync.enabled?'configured':'disabled';
   const uidNext=client.mailbox.uidNext;
   // First run establishes a baseline: never sync historical mail without review.
   if(nextLiveUid===null)nextLiveUid=uidNext;
   // Historical backfill intentionally disabled: only process newly arrived UID messages.
   results.backfillDone=true;
   results.backfillProcessed=0;
   results.mailboxTotal=count;
   results.checked=0;
   results.rejected={};
   results.candidates=[];
   results.uniqueContacts=0;
   // New messages only, sorted by immutable IMAP UID (not volatile sequence numbers).
   if(sync.enabled && uidNext>nextLiveUid) {
    const range=nextLiveUid+':'+(uidNext-1);
    for await(const msg of client.fetch(range,{source:true,uid:true},{uid:true})) {
     if(!msg.source)continue;
     try {
      const parsed=candidate(await simpleParser(msg.source));
      if(parsed.contact){
       const outcome=await sendToGoogle(parsed.contact);
       if(outcome==='created')sync.created++;
       else if(outcome==='exists')sync.existing++;
       else throw Error('Unexpected response');
       sync.lastResult=outcome;
      }
      nextLiveUid=msg.uid+1;
     }catch(err){
      sync.errors++;
      sync.lastResult='error';
      console.error('Contact sync failed:',String(err.message||err).slice(0,150));
      // Retry this UID next cycle; avoid skipping a potentially valid contact.
      break;
     }
    }
   }
   if(nextLiveUid!==null && nextLiveUid>=uidNext)sync.state=sync.enabled?'active':'disabled';
  } finally { lock.release(); }
  results.lastRun=new Date().toISOString();
 } catch(e) {results.connection='error'; results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard() {
 const {lastRun,lastAttempt,lastConnected,connection,error,checked,mailboxTotal,candidates,running,sync}=results;
 const labels={not_configured:'Nincs beállítva',connecting:'Csatlakozás folyamatban',connected:'Sikeres IMAP-kapcsolat',error:'IMAP-kapcsolat / ellenőrzés sikertelen'};
 const tone=connection==='connected'?'#147d46':connection==='error'?'#bd3030':'#805d12';
 return '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>CEO Contacts Sync</title><style>body{font-family:system-ui;margin:0;background:#f6f7f8;color:#17202a}main{max-width:850px;margin:40px auto;padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}small{color:#65707b}.status{border:1px solid #ddd;border-left:5px solid '+tone+';border-radius:10px;padding:16px;margin:20px 0}.status strong{color:'+tone+'}td{overflow-wrap:anywhere}</style><main><h1>CEO Contacts Sync</h1><p><strong>Új levelek figyelése</strong> · történeti feldolgozás kikapcsolva · Google mentés: '+(sync.enabled?'BEKAPCSOLVA':'KIKAPCSOLVA')+'</p><section class="status" aria-live="polite"><strong>IMAP: '+html(labels[connection]||connection)+'</strong><p>Utolsó csatlakozási próbálkozás: '+html(lastAttempt||'még nem történt')+'</p><p>INBOX levelek: '+mailboxTotal+' · Újonnan mentve: '+sync.created+' · Már létezett: '+sync.existing+' · Szinkronhibák: '+sync.errors+' · Állapot: '+html(sync.state)+'</p><section style="margin:20px 0"><button type="button" id="gtest" style="padding:12px 18px;cursor:pointer">Google kapcsolat tesztelése (írás nélkül)</button><span id="gtest-result" style="margin-left:12px"></span></section><script>document.getElementById("gtest").addEventListener("click",async()=>{const el=document.getElementById("gtest-result");el.textContent="Ellenőrzés...";try{const response=await fetch("/google-test",{method:"POST"});const data=await response.json();el.textContent=data.ok?"Google People API kapcsolat sikeres":"Hiba: "+(data.error||"ismeretlen")}catch(e){el.textContent="Kapcsolódási hiba"}})</script><h2>Új névjegyek</h2><table><tr><th>Név</th><th>Cég / domain</th><th>Email</th><th>Telefon</th></tr>'+candidates.map(c=>'<tr><td>'+html(c.name)+'</td><td>'+html(c.company||'—')+'</td><td>'+html(c.email)+'</td><td>'+html(c.phone)+'</td></tr>').join('')+'</table><p><small>Az oldal 30 másodpercenként frissül. Csak a szolgáltatás elindulása után érkező új levelekből dolgozik. A Google mentés csak engedélyezett szinkron esetén aktív.</small></p></main></html>';
}
