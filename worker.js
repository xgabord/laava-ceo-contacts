import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { findPhoneNumbersInText } from 'libphonenumber-js';

const results = { lastRun: null, error: null, checked: 0, candidates: [], running: false };
const localDomains = new Set(['laava.hu', 'matezz.hu', 'matezz.ro', 'matchai.hu']);
const html = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function status() { return { ...results, candidates: [...results.candidates] }; }
function candidate(mail) {
 const from = mail.from?.value?.[0];
 const email = from?.address?.trim().toLowerCase();
 if (!email || localDomains.has(email.split('@')[1])) return null;
 if (/no-?reply|newsletter|notification|mailer-daemon|postmaster|bounce/i.test(email)) return null;
 if (['list-id','list-unsubscribe','auto-submitted'].some(k=>mail.headers?.has(k))) return null;
 const body = (mail.text || '').split(/\n(?:From:|Feladó:|On .+wrote:|-----Original Message-----)/i)[0];
 const signature = body.split('\n').slice(-18).join('\n');
 const phones = [...new Set(findPhoneNumbersInText(signature,'HU').filter(v=>v.number.isValid()).map(v=>v.number.number))];
 if (phones.length !== 1) return null;
 const name = (from.name||'').trim();
 if (!/^[\p{L}][\p{L}\p{M} .'-]{3,89}$/u.test(name) || name.split(/\s+/).length < 2) return null;
 return {name,email,phone:phones[0]};
}
export async function scan() {
 if (results.running || !process.env.IMAP_HOST || !process.env.IMAP_USER || !process.env.IMAP_PASSWORD) return;
 results.running=true; results.error=null;
 const client = new ImapFlow({host:process.env.IMAP_HOST,port:Number(process.env.IMAP_PORT||993),secure:true,auth:{user:process.env.IMAP_USER,pass:process.env.IMAP_PASSWORD},logger:false});
 try {
  await client.connect();
  const lock=await client.getMailboxLock('INBOX',{readOnly:true});
  try {
   const count=client.mailbox.exists;
   const items=[];
   let checked=0;
   if(count) {
    const start=Math.max(1,count-29);
    for await (const msg of client.fetch(start+':*',{source:true,uid:true})) {
     checked++;
     const data=candidate(await simpleParser(msg.source));
     if(data)items.push(data);
    }
   }
   results.checked=checked;
   results.candidates=items.slice(-30);
  } finally { lock.release(); }
  results.lastRun=new Date().toISOString();
 } catch(e) {results.error=String(e.message||e).slice(0,180);console.error('IMAP scan error:',results.error);}
 finally {results.running=false;try{await client.logout()}catch{}}
}
export function dashboard() {
 const {lastRun,error,checked,candidates,running}=results;
 return '<!doctype html><html lang="hu"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CEO Contacts Sync</title><style>body{font-family:system-ui;margin:0;background:#f6f7f8;color:#17202a}main{max-width:850px;margin:40px auto;padding:24px;background:white;border-radius:16px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}small{color:#65707b}</style><main><h1>CEO Contacts Sync</h1><p><strong>DRY RUN</strong> · csak olvasás, nincs névjegymentés</p><p>Utolsó ellenőrzés: '+html(lastRun||'még nincs')+' · Üzenetek: '+checked+' · Feldolgozás: '+(running?'folyamatban':'készen')+'</p><p>'+html(error||'')+'</p><h2>Lehetséges névjegyek</h2><table><tr><th>Név</th><th>Email</th><th>Telefon</th></tr>'+candidates.map(c=>'<tr><td>'+html(c.name)+'</td><td>'+html(c.email)+'</td><td>'+html(c.phone)+'</td></tr>').join('')+'</table><p><small>A találatok csak előnézetek, azonosításuk ellenőrzést igényel.</small></p></main></html>';
}
