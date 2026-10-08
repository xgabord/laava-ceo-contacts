import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { lastRun: null, lastAttempt: null, lastConnected: null, connection: 'not_configured', error: null, checked: 0, mailboxTotal: 0, rejected: {}, candidates: [], running: false };
const localDomains = new Set(['laava.hu', 'matezz.hu', 'matezz.ro', 'matchai.hu']);
const html = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function status() { return { ...results, candidates: [...results.candidates] }; }
function candidate(mail) {
 const from = mail.from?.value?.[0];
 const email = from?.address?.trim().toLowerCase();
 if (!email || localDomains.has(email.split('@')[1])) return { reason: 'belső / hiányzó feladó' };
 if (/no-?reply|newsletter|notification|mailer-daemon|postmaster|bounce|ertesites|értesítés|ertesito|notification|automata|robot/i.test(email)) return { reason: 'automata feladó' };
 if (['list-id','list-unsubscribe','auto-submitted'].some(k=>mail.headers?.has(k))) return { reason: 'hírlevél / automata fejléc' };
 const body = (mail.text || '').split(/\n(?:From:|Feladó:|On .+wrote:|-----Original Message-----)/i)[0];
 const signature = body.split('\n').slice(-18).join('\n');
 const phones = [...new Set(findPhoneNumbersInText(signature,'HU').filter(v=>v.number.isValid()).map(v=>v.number.number))];
 if (phones.length !== 1) return { reason: phones.length===0 ? 'nem találtunk telefonszámot' : 'több telefonszám' };
 const name = (from.name||'').trim();
 if (/(?:értesítő|ertesito|értesítés|ertesites|notification|automated|automata|ügyfélszolgálat|ugyfelszolgalat|customer service|support|logistics|webshop|team|csapat|system|rendszer)/i.test(name)) return { reason: 'nem személy / szervezeti feladó' };
 if (!/^[\p{L}][\p{L}\p{M} .'-]{3,89}$/u.test(name) || name.split(/\s+/).length < 2) return { reason: 'nem megbízható név' };
 const companyLines=signature.split('\n').map(line=>line.trim()).filter(Boolean);
 const companyPattern=/\b(?:Kft\.?|Zrt\.?|Nyrt\.?|Bt\.?|Kkt\.?|Ltd\.?|LLC|Inc\.?|GmbH|AG|S\.?r\.?l\.?)\b/i;
 const companyCandidates=companyLines.filter(line=>line.length<=100 && companyPattern.test(line) && !line.includes('@') && !/https?:\/\/|www\.|\+?\d[\d\s()-]{7,}/i.test(line));
 const normalizedCompanies=[...new Set(companyCandidates.map(line=>line.replace(/^[\s\u2013\u2014\-:|]+/, '').trim()).filter(Boolean))];
 const company=normalizedCompanies.length===1 ? normalizedCompanies[0] : '';
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
   const items=[];
   const rejected={};
   results.mailboxTotal=count;
   let checked=0;
   if(count) {
    const start=Math.max(1,count-Number(process.env.IMAP_SCAN_LIMIT||100)+1);
    for await (const msg of client.fetch(start+':*',{source:true,uid:true})) {
     checked++;
     try {
      const data=candidate(await simpleParser(msg.source));
      if(data?.contact)items.push(data.contact);
      else { const reason=data?.reason||'egyéb'; rejected[reason]=(rejected[reason]||0)+1; }
     } catch { rejected['feldolgozási hiba']=(rejected['feldolgozási hiba']||0)+1; }
    }
   }
   results.checked=checked;
   results.rejected=rejected;
   results.candidates=items.slice(-100);
  } finally { lock.release(); }
  results.lastRun=new Date().toISOString();
 } catch(e) {results.connection='error'; results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard() {
 const {lastRun,lastAttempt,lastConnected,connection,error,checked,mailboxTotal,rejected,candidates,running}=results;
 const labels={not_configured:'Nincs beállítva',connecting:'Csatlakozás folyamatban',connected:'Sikeres IMAP-kapcsolat',error:'IMAP-kapcsolat / ellenőrzés sikertelen'};
 const tone=connection==='connected'?'#147d46':connection==='error'?'#bd3030':'#805d12';
 return '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>CEO Contacts Sync</title><style>body{font-family:system-ui;margin:0;background:#f6f7f8;color:#17202a}main{max-width:850px;margin:40px auto;padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}small{color:#65707b}.status{border:1px solid #ddd;border-left:5px solid '+tone+';border-radius:10px;padding:16px;margin:20px 0}.status strong{color:'+tone+'}td{overflow-wrap:anywhere}</style><main><h1>CEO Contacts Sync</h1><p><strong>DRY RUN</strong> · csak olvasás, nincs névjegymentés</p><section class="status" aria-live="polite"><strong>IMAP: '+html(labels[connection]||connection)+'</strong><p>Utolsó csatlakozási próbálkozás: '+html(lastAttempt||'még nem történt')+'</p><p>Utolsó sikeres kapcsolódás: '+html(lastConnected||'még nem történt')+'</p>'+(error?'<p>Hiba: '+html(error)+'</p>':'')+'</section><p>Utolsó sikeres INBOX-ellenőrzés: '+html(lastRun||'még nincs')+' · INBOX levelek: '+mailboxTotal+' · Átvizsgált levelek: '+checked+' · Találatok: '+candidates.length+' · Feldolgozás: '+(running?'folyamatban':'készen')+'</p><h2>Lehetséges névjegyek</h2><table><tr><th>Név</th><th>Cég</th><th>Email</th><th>Telefon</th></tr>'+candidates.map(c=>'<tr><td>'+html(c.name)+'</td><td>'+html(c.company||'—')+'</td><td>'+html(c.email)+'</td><td>'+html(c.phone)+'</td></tr>').join('')+'</table><p><small>Az oldal 30 másodpercenként frissül. A találatok csak előnézetek.</small></p></main></html>';
}
