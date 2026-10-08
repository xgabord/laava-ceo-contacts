import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { lastRun: null, lastAttempt: null, lastConnected: null, connection: 'not_configured', error: null, checked: 0, mailboxTotal: 0, rejected: {}, candidates: [], running: false, backfillNext: null, backfillDone: false, backfillProcessed: 0, uniqueContacts: 0 };
const localDomains = new Set(['laava.hu', 'matezz.hu', 'matezz.ro', 'matchai.hu']);
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
   const batch=Math.max(10,Math.min(500,Number(process.env.IMAP_BACKFILL_BATCH||150)));
   const newest=Math.max(1,count-99);
   if(results.backfillNext===null) results.backfillNext=newest-1;
   const olderEnd=Math.min(results.backfillNext,newest-1);
   const olderStart=Math.max(1,olderEnd-batch+1);
   const ranges=count ? [[newest,count], ...(olderEnd>=olderStart ? [[olderStart,olderEnd]] : [])] : [];
   const current=new Map(results.candidates.map(c=>[c.email+'|'+c.phone,c]));
   const rejected={};
   let checked=0;
   for (const [first,last] of ranges) {
    for await (const msg of client.fetch(first+':'+last,{source:true,uid:true})) {
     if(!msg.source)continue;
     checked++;
     try {
      const data=candidate(await simpleParser(msg.source));
      if(data?.contact){
       const contact=data.contact;
       current.set(contact.email+'|'+contact.phone,contact);
      }else{
       const reason=data?.reason||'egyéb';
       rejected[reason]=(rejected[reason]||0)+1;
      }
     } catch {
      rejected['feldolgozási hiba']=(rejected['feldolgozási hiba']||0)+1;
     }
    }
   }
   if(olderEnd>=olderStart){
    results.backfillNext=olderStart-1;
    results.backfillProcessed+=olderEnd-olderStart+1;
   }
   results.backfillDone=results.backfillNext<1;
   results.mailboxTotal=count;
   results.checked=checked;
   results.rejected=rejected;
   results.uniqueContacts=current.size;
   results.candidates=Array.from(current.values()).slice(-500);
  } finally { lock.release(); }
  results.lastRun=new Date().toISOString();
 } catch(e) {results.connection='error'; results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard() {
 const {lastRun,lastAttempt,lastConnected,connection,error,checked,mailboxTotal,rejected,candidates,running,backfillProcessed,backfillDone,uniqueContacts}=results;
 const labels={not_configured:'Nincs beállítva',connecting:'Csatlakozás folyamatban',connected:'Sikeres IMAP-kapcsolat',error:'IMAP-kapcsolat / ellenőrzés sikertelen'};
 const tone=connection==='connected'?'#147d46':connection==='error'?'#bd3030':'#805d12';
 return '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>CEO Contacts Sync</title><style>body{font-family:system-ui;margin:0;background:#f6f7f8;color:#17202a}main{max-width:850px;margin:40px auto;padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}small{color:#65707b}.status{border:1px solid #ddd;border-left:5px solid '+tone+';border-radius:10px;padding:16px;margin:20px 0}.status strong{color:'+tone+'}td{overflow-wrap:anywhere}</style><main><h1>CEO Contacts Sync</h1><p><strong>DRY RUN</strong> · csak olvasás, nincs névjegymentés</p><section class="status" aria-live="polite"><strong>IMAP: '+html(labels[connection]||connection)+'</strong><p>Utolsó csatlakozási próbálkozás: '+html(lastAttempt||'még nem történt')+'</p><p>Utolsó sikeres kapcsolódás: '+html(lastConnected||'még nem történt')+'</p>'+(error?'<p>Hiba: '+html(error)+'</p>':'')+'</section><p>Utolsó sikeres INBOX-ellenőrzés: '+html(lastRun||'még nincs')+' · INBOX levelek: '+mailboxTotal+' · Átvizsgált levelek: '+checked+' · Egyedi találatok: '+uniqueContacts+' · Régebbi levelek átvizsgálva: '+backfillProcessed+' / '+Math.max(0,mailboxTotal-100)+' · Előzmények: '+(backfillDone?'befejezve':'folyamatban')+' · Feldolgozás: '+(running?'folyamatban':'készen')+'</p><h2>Lehetséges névjegyek</h2><table><tr><th>Név</th><th>Cég / domain</th><th>Email</th><th>Telefon</th></tr>'+candidates.map(c=>'<tr><td>'+html(c.name)+'</td><td>'+html(c.company||'—')+'</td><td>'+html(c.email)+'</td><td>'+html(c.phone)+'</td></tr>').join('')+'</table><p><small>Az oldal 30 másodpercenként frissül. A régi levelek feldolgozása körönként halad; a haladás újraindításkor elölről kezdődik. A találatok csak előnézetek, Google Contacts mentés nélkül.</small></p></main></html>';
}
