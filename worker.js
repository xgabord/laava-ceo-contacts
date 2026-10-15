import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { lastRun: null, lastAttempt: null, lastConnected: null, connection: 'not_configured', error: null, checked: 0, mailboxTotal: 0, rejected: {}, candidates: [], running: false, backfillNext: null, backfillDone: false, backfillProcessed: 0, uniqueContacts: 0, sync: {enabled:false, state:'disabled', created:0, existing:0, errors:0, lastResult:null, cursor:null, cursorStore:'not_checked', rejected:0} };
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
   results.backfillDone=true;
   results.backfillProcessed=0;
   results.mailboxTotal=count;
   results.checked=0;
   results.rejected={};
   results.candidates=[];
   results.uniqueContacts=0;
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
  results.lastRun=new Date().toISOString();
 } catch(e) {results.connection='error'; results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard(buildInfo={}) {
 const launched=buildInfo.startedAt?new Intl.DateTimeFormat('hu-HU',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(buildInfo.startedAt)):'ismeretlen';
 const {lastRun,lastAttempt,lastConnected,connection,error,checked,mailboxTotal,candidates,running,sync}=results;
 const labels={not_configured:'Nincs beállítva',connecting:'Csatlakozás folyamatban',connected:'Sikeres IMAP-kapcsolat',error:'IMAP-kapcsolat / ellenőrzés sikertelen'};
 const tone=connection==='connected'?'#147d46':connection==='error'?'#bd3030':'#805d12';
 return '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CEO Contacts Sync</title><style>body{font-family:system-ui;margin:0;background:#f6f7f8;color:#17202a}main{max-width:850px;margin:40px auto;padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}small{color:#65707b}.status{border:1px solid #ddd;border-left:5px solid '+tone+';border-radius:10px;padding:16px;margin:20px 0}.status strong{color:'+tone+'}td{overflow-wrap:anywhere}</style><main><h1>CEO Contacts Sync</h1><p style="color:#65707b;font-size:14px">Verzió: <strong>v'+html(buildInfo.version||'ismeretlen')+'</strong> · Git: <code>'+html(buildInfo.commit||'ismeretlen')+'</code> · Utolsó alkalmazásindítás (Budapest): <strong>'+html(launched)+'</strong></p><p><strong>Új levelek figyelése</strong> · történeti feldolgozás kikapcsolva · Google mentés: '+(sync.enabled?'BEKAPCSOLVA':'KIKAPCSOLVA')+'</p><section class="status" aria-live="polite"><strong>IMAP: '+html(labels[connection]||connection)+'</strong><p>Utolsó csatlakozási próbálkozás: '+html(lastAttempt||'még nem történt')+'</p><p>INBOX levelek: '+mailboxTotal+' · Újonnan mentve: '+sync.created+' · Már létezett: '+sync.existing+' · Szinkronhibák: '+sync.errors+' · Állapot: '+html(sync.state)+' · Tartós pozíció: '+html(sync.cursor??'nincs')+' · Pozíciótároló: '+html(sync.cursorStore)+'</p><section style="margin:20px 0"><button type="button" id="gtest" style="padding:12px 18px;cursor:pointer">Google kapcsolat tesztelése (írás nélkül)</button><span id="gtest-result" style="margin-left:12px"></span></section><script>document.getElementById("gtest").addEventListener("click",async()=>{const el=document.getElementById("gtest-result");el.textContent="Ellenőrzés...";try{const response=await fetch("/google-test",{method:"POST",credentials:"same-origin",cache:"no-store"});const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{el.textContent="A szerver nem JSON választ adott (HTTP "+response.status+"). Lehetséges bejelentkezési vagy proxyhiba.";return}el.textContent=data.ok?"Google People API kapcsolat sikeres":"Hiba (HTTP "+response.status+"): "+((data.error||"ismeretlen")+(data.googleHttpStatus?" · Google HTTP "+data.googleHttpStatus:"")+(data.googleHost?" · "+data.googleHost:"")+(data.contentType?" · "+data.contentType:""))}catch(e){el.textContent="Kapcsolódási hiba"}})</script><h2>Egyetlen kontakt tesztmentése</h2><p><a href="/google-test-history">Utolsó tesztmentés eredménye</a></p><p>A mentés valódi Google-névjegyet hoz létre, ha még nem létezik. Az automatikus szinkron kikapcsolva marad.</p><form id="contactTest" style="display:grid;gap:8px;max-width:480px"><input required name="name" placeholder="Teljes név" minlength="5" style="padding:10px"><input required type="email" name="email" placeholder="E-mail-cím" style="padding:10px"><input required name="phone" placeholder="Telefon nemzetközi formában: +3620..." pattern="\\+\\d{7,15}" style="padding:10px"><input name="company" placeholder="Cég / domain" style="padding:10px"><label><input required type="checkbox" name="confirm"> Jóváhagyom ennek az egy névjegynek a Google Contactsba mentését.</label><button type="submit" style="padding:12px;cursor:pointer">Tesztkontakt mentése</button><output id="contactTestResult" aria-live="polite"></output></form><script>document.getElementById("contactTest").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,out=document.getElementById("contactTestResult");const b=form.querySelector("button");b.disabled=true;out.textContent="Mentés folyamatban...";try{const f=new FormData(form),payload={name:f.get("name"),email:f.get("email"),phone:f.get("phone"),company:f.get("company"),confirm:f.get("confirm")==="on"};const r=await fetch("/google-contact-test",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});const j=await r.json();out.textContent=j.ok?(j.status==="created"?"Névjegy létrehozva. Ellenőrizd a ceo-kontakt címkét.":j.status==="exists"?"Már létező névjegy, nem készült duplikátum.":"Google válasz: "+j.status):"Hiba: "+(j.error||r.status)}catch(err){out.textContent="Kapcsolati hiba"}finally{b.disabled=false}})</script><h2>Új névjegyek</h2><table><tr><th>Név</th><th>Cég / domain</th><th>Email</th><th>Telefon</th></tr>'+candidates.map(c=>'<tr><td>'+html(c.name)+'</td><td>'+html(c.company||'—')+'</td><td>'+html(c.email)+'</td><td>'+html(c.phone)+'</td></tr>').join('')+'</table><p><small>Az oldal kézzel frissíthető, hogy a mentési kérés ne szakadjon meg. Csak az első élesítés után érkező levelekből dolgozik; az IMAP UID-pozíció a Google Apps Scriptben megőrződik. A Google mentés csak engedélyezett szinkron esetén aktív.</small></p></main></html>';
}
