import {createTokenVault} from './token-vault.mjs';
import {getShoptetApiAccessToken} from './shoptet-oauth.mjs';
import {digest} from './crypto.mjs';
export async function boundedBytes(request,limit){const length=Number(request.headers.get('content-length')||0);if(length>limit)throw Error('payload_too_large');const reader=request.body?.getReader();if(!reader)return new Uint8Array();const chunks=[];let total=0;for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw Error('payload_too_large');}chunks.push(value);}const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}return bytes;}
export async function lifecycleReady(db,shopId){const row=await db.prepare('SELECT o.oauth_envelope,k.oauth_sha256 FROM shoptet_oauth o LEFT JOIN shop_webhook_credentials k ON k.shop_id=o.shop_id WHERE o.shop_id=?').bind(shopId).first();return !row?{ready:false,reason:'oauth_installation_missing'}:{ready:!!row.oauth_sha256&&row.oauth_sha256===await digest(row.oauth_envelope)};}
export async function initializeWebhookKey({db,shopId,tokenKeys,fetchImpl=fetch}){
 const row=await db.prepare("SELECT o.oauth_envelope FROM shoptet_oauth o JOIN installations i ON i.shop_id=o.shop_id WHERE o.shop_id=? AND i.state='active'").bind(shopId).first();if(!row)throw Error('active_installation_required');
 const hash=await digest(row.oauth_envelope);if((await lifecycleReady(db,shopId)).ready)return {configured:true,deliveryVerified:false};
 const token=await getShoptetApiAccessToken({db,shopId,tokenKeys,fetchImpl,expectedOAuthEnvelope:row.oauth_envelope});
 const claimed=await db.prepare("INSERT INTO webhook_key_operations(shop_id,oauth_sha256,state) SELECT ?,?,'processing' WHERE EXISTS(SELECT 1 FROM shoptet_oauth o JOIN installations i ON i.shop_id=o.shop_id WHERE o.shop_id=? AND o.oauth_envelope=? AND i.state='active') ON CONFLICT(shop_id,oauth_sha256) DO NOTHING").bind(shopId,hash,shopId,row.oauth_envelope).run();if(!claimed.meta?.changes)throw Error('webhook_setup_requires_attention');
 try{
  const response=await fetchImpl('https://api.myshoptet.com/api/webhooks/renew-signature-key',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Shoptet-Access-Token':token.apiAccessToken,'Content-Type':'application/json'}});
  if(!response.ok)throw Error('webhook_key_unavailable');const body=await response.json();if(body.errors?.length||typeof body.data?.signatureKey!=='string'||!body.data.signatureKey||body.data.signatureKey.length>512)throw Error('invalid_webhook_key');
  const envelope=await createTokenVault(tokenKeys).seal(shopId,'webhook',body.data.signatureKey);
  const result=await db.batch([
   db.prepare("INSERT INTO shop_webhook_credentials(shop_id,oauth_sha256,envelope) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM installations i JOIN shoptet_oauth o ON o.shop_id=i.shop_id WHERE i.shop_id=? AND i.state='active' AND o.oauth_envelope=?) ON CONFLICT(shop_id) DO UPDATE SET oauth_sha256=excluded.oauth_sha256,envelope=excluded.envelope,created_at=unixepoch()").bind(shopId,hash,envelope,shopId,row.oauth_envelope),
   db.prepare("UPDATE webhook_key_operations SET state='ready' WHERE shop_id=? AND oauth_sha256=? AND EXISTS(SELECT 1 FROM shop_webhook_credentials k WHERE k.shop_id=webhook_key_operations.shop_id AND k.envelope=?)").bind(shopId,hash,envelope)
  ]);if(!result[0].meta?.changes)throw Error('installation_changed');return {configured:true,deliveryVerified:false};
 }catch{await db.prepare("UPDATE webhook_key_operations SET state='uncertain' WHERE shop_id=? AND oauth_sha256=? AND state='processing'").bind(shopId,hash).run();throw Error('webhook_setup_requires_attention');}
}
export async function processLifecycle({db,tokenKeys,bytes,signature,allowedEvent=null}){
 if(typeof signature!=='string'||!/^[a-f0-9]{40}$/i.test(signature))throw Error('invalid_signature');
 let event;try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw Error('invalid_event');}
 const shopId=String(event?.eshopId??''),ranks={'addon:approve':1,'addon:suspend':2,'addon:uninstall':3};
 if(!/^[1-9][0-9]{0,11}$/.test(shopId)||!Object.hasOwn(ranks,event.event)||String(event.eventInstance)!==shopId||(allowedEvent&&event.event!==allowedEvent))throw Error('invalid_event');
 const record=await db.prepare('SELECT k.envelope,k.oauth_sha256,o.oauth_envelope,o.updated_at FROM shop_webhook_credentials k JOIN shoptet_oauth o ON o.shop_id=k.shop_id WHERE k.shop_id=?').bind(shopId).first();
 if(!record||record.oauth_sha256!==await digest(record.oauth_envelope))throw Error('invalid_signature');
 const secret=await createTokenVault(tokenKeys).open(shopId,'webhook',record.envelope);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-1'},false,['verify']);
 const proof=Uint8Array.from(signature.match(/../g),s=>parseInt(s,16));if(!await crypto.subtle.verify('HMAC',key,proof,bytes))throw Error('invalid_signature');
 if(typeof event.eventCreated!=='string')throw Error('invalid_event');const eventAt=Date.parse(event.eventCreated);if(!Number.isFinite(eventAt)||eventAt<Date.now()-3600000||eventAt>Date.now()+300000)throw Error('expired_event');
 if(eventAt<Date.parse(record.updated_at.replace(' ','T')+'Z'))return {accepted:true,applied:false,stale:true,shopId,event:event.event};
 const eventHash=await digest(new TextDecoder().decode(bytes)),delivery=crypto.randomUUID(),state=event.event==='addon:uninstall'?'uninstalled':event.event==='addon:suspend'?'suspended':'pending';
 const guard="EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=installations.shop_id AND l.delivery_id=?)";
 const statements=[
  db.prepare('INSERT INTO shop_lifecycle_events(shop_id,event_hash,event_type,event_at,delivery_id) VALUES(?,?,?,?,?) ON CONFLICT(shop_id,event_hash) DO NOTHING').bind(shopId,eventHash,event.event,eventAt,delivery),
  db.prepare("INSERT INTO shop_lifecycle_state(shop_id,oauth_sha256,event_hash,event_at,event_rank,event_type,delivery_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shop_lifecycle_events e WHERE e.shop_id=? AND e.delivery_id=?) AND EXISTS(SELECT 1 FROM shoptet_oauth o WHERE o.shop_id=? AND o.oauth_envelope=?) ON CONFLICT(shop_id) DO UPDATE SET oauth_sha256=excluded.oauth_sha256,event_hash=excluded.event_hash,event_at=excluded.event_at,event_rank=excluded.event_rank,event_type=excluded.event_type,delivery_id=excluded.delivery_id WHERE shop_lifecycle_state.oauth_sha256!=excluded.oauth_sha256 OR (shop_lifecycle_state.event_type!='addon:uninstall' AND (excluded.event_at>shop_lifecycle_state.event_at OR(excluded.event_at=shop_lifecycle_state.event_at AND excluded.event_rank>shop_lifecycle_state.event_rank)))").bind(shopId,record.oauth_sha256,eventHash,eventAt,ranks[event.event],event.event,delivery,shopId,delivery,shopId,record.oauth_envelope),
  db.prepare('UPDATE installations SET state=?,updated_at=CURRENT_TIMESTAMP WHERE shop_id=? AND '+guard).bind(state,shopId,delivery),
  db.prepare("UPDATE shoptet_installations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE eshop_id=? AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=? AND l.delivery_id=?)").bind(state,Number(shopId),shopId,delivery),
  db.prepare('UPDATE tenant_settings SET version=version+1 WHERE shop_id=? AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=tenant_settings.shop_id AND l.delivery_id=?)').bind(shopId,delivery),
  db.prepare("UPDATE sync_jobs SET cancel_requested=1 WHERE shop_id=? AND state IN('queued','running') AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=sync_jobs.shop_id AND l.delivery_id=?)").bind(shopId,delivery)
 ];
 if(event.event==='addon:approve')statements.push(db.prepare("INSERT INTO installation_verification_jobs(shop_id,oauth_sha256,state) SELECT ?,?,'queued' WHERE EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=? AND l.delivery_id=?) ON CONFLICT(shop_id) DO UPDATE SET oauth_sha256=excluded.oauth_sha256,state='queued',run_id=NULL,attempts=0,error_code=NULL,next_attempt_at=0,updated_at=unixepoch()").bind(shopId,record.oauth_sha256,shopId,delivery));
 if(event.event==='addon:uninstall'){
  for(const table of ['mcp_credentials','admin_credentials'])statements.push(db.prepare('UPDATE '+table+' SET revoked_at=CURRENT_TIMESTAMP WHERE shop_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id='+table+'.shop_id AND l.delivery_id=?)').bind(shopId,delivery));
  statements.push(db.prepare('UPDATE mcp_oauth_grants SET revoked_at=unixepoch() WHERE shop_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=mcp_oauth_grants.shop_id AND l.delivery_id=?)').bind(shopId,delivery));
  statements.push(db.prepare("UPDATE asset_install_approvals SET state='revoked' WHERE shop_id=? AND state='approved' AND EXISTS(SELECT 1 FROM shop_lifecycle_state l WHERE l.shop_id=asset_install_approvals.shop_id AND l.delivery_id=?)").bind(shopId,delivery));
 }
 const result=await db.batch(statements);return {accepted:true,duplicate:!result[0].meta?.changes,applied:!!result[1].meta?.changes,shopId,event:event.event};
}
