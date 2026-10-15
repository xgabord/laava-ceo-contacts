/**
 * LAAVA CEO Contacts receiver.
 * Google Apps Script web app: Execute as Me (callerid.laava@gmail.com).
 * Set Script Property CEO_SYNC_SECRET to a long random secret.
 * Deploy access: Anyone, authenticated by secret in POST body.
 * No OAuth client/refresh token on xCloud.
 */
const BASE='https://people.googleapis.com/v1/';
function api_(path, method='get', body) {
  const options={method,headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
  if(body!==undefined){options.contentType='application/json';options.payload=JSON.stringify(body);}
  const response=UrlFetchApp.fetch(BASE+path,options);
  const code=response.getResponseCode();
  const data=JSON.parse(response.getContentText()||'{}');
  if(code<200||code>=300)throw Error('People API '+code+': '+JSON.stringify(data).slice(0,350));
  return data;
}
function e164_(value){return String(value||'').replace(/[^+\d]/g,'');}
function group_() {
  let page='', group;
  do {
    const r=api_('contactGroups?pageSize=1000'+(page?'&pageToken='+encodeURIComponent(page):''));
    group=(r.contactGroups||[]).find(g=>g.name==='ceo-kontakt');
    if(group)return group.resourceName;
    page=r.nextPageToken||'';
  }while(page);
  return api_('contactGroups','post',{contactGroup:{name:'ceo-kontakt'}}).resourceName;
}
function exists_(email, phone) {
  let token='';
  do {
    const r=api_('people/me/connections?personFields=emailAddresses,phoneNumbers&pageSize=1000'+(token?'&pageToken='+encodeURIComponent(token):''));
    const found=(r.connections||[]).find(p=>
      (p.emailAddresses||[]).some(e=>String(e.value||'').toLowerCase()===email)||
      (p.phoneNumbers||[]).some(n=>e164_(n.canonicalForm||n.value)===phone)
    );
    if(found)return found.resourceName;
    token=r.nextPageToken||'';
  }while(token);
  return null;
}
function cursor_(data) {
  const props=PropertiesService.getScriptProperties();
  const key='CEO_IMAP_CURSOR_V1';
  if(data.action==='cursor_get'){
    const raw=props.getProperty(key);
    return out_({ok:true,status:'cursor',cursor:raw?JSON.parse(raw):null});
  }
  if(data.action==='cursor_set'){
    const c=data.cursor||{};
    const validity=Number(c.uidValidity),next=Number(c.nextUid);
    if(!Number.isSafeInteger(validity)||validity<1||!Number.isSafeInteger(next)||next<1)
      return out_({ok:false,error:'invalid_cursor'});
    const prevRaw=props.getProperty(key);
    const prev=prevRaw?JSON.parse(prevRaw):null;
    if(prev && prev.uidValidity===validity && next<prev.nextUid)
      return out_({ok:false,error:'cursor_regression'});
    const state={uidValidity:validity,nextUid:next,updatedAt:new Date().toISOString()};
    props.setProperty(key,JSON.stringify(state));
    return out_({ok:true,status:'cursor_saved',cursor:state});
  }
}
function doPost(e) {
  const lock=LockService.getScriptLock();
  try {
    const data=JSON.parse(e.postData&&e.postData.contents||'{}');
    const secret=PropertiesService.getScriptProperties().getProperty('CEO_SYNC_SECRET');
    if(!secret||secret.length<32||data.secret!==secret)return out_({ok:false,error:'unauthorized'});
    if(!lock.tryLock(25000))return out_({ok:false,error:'busy'});
    if(data.action==='ping'){
      const info=api_('contactGroups?pageSize=1');
      return out_({ok:true,status:'connected',peopleApi:true});
    }
    if(data.action==='cursor_get'||data.action==='cursor_set')return cursor_(data);
    const c=data.contact||{};
    const email=String(c.email||'').trim().toLowerCase();
    const phone=e164_(c.phone);
    const name=String(c.name||'').trim();
    if(!email.includes('@')||!/^\+\d{7,15}$/.test(phone)||name.length<5)return out_({ok:false,error:'invalid_contact'});
    const existing=exists_(email,phone);
    if(existing){
      api_('contactGroups/'+encodeURIComponent(group_().split('/').pop())+'/members:modify','post',{resourceNamesToAdd:[existing]});
      return out_({ok:true,status:'exists'});
    }
    const person=api_('people:createContact?personFields=names,emailAddresses,phoneNumbers,organizations','post',{
      names:[{unstructuredName:name}],
      emailAddresses:[{value:email}],
      phoneNumbers:[{value:phone}],
      organizations:c.company?[{name:String(c.company).slice(0,120)}]:[]
    });
    api_('contactGroups/'+encodeURIComponent(group_().split('/').pop())+'/members:modify','post',{resourceNamesToAdd:[person.resourceName]});
    return out_({ok:true,status:'created'});
  } catch(err){console.error(String(err).slice(0,400));return out_({ok:false,error:'server_error'});}
  finally{try{lock.releaseLock();}catch(_){}}
}
function out_(o){return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);}
