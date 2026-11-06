import {createTokenVault} from './token-vault.mjs';
import {digest} from './crypto.mjs';
import {trustedShopOrigin} from './shoptet-oauth.mjs';
const REDIRECT_MODE = typeof WebSocketPair !== 'undefined' ? 'manual' : 'error';
export async function verifyInstallation({db,shopId,tokenKeys,fetchImpl=fetch}){
 const runId=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
 const claimed=await db.prepare("UPDATE installation_verification_jobs SET state='running',run_id=?,attempts=attempts+1,started_at=unixepoch(),updated_at=unixepoch() WHERE shop_id=? AND attempts<3 AND next_attempt_at<=unixepoch() AND (state='queued' OR (state='running' AND started_at<unixepoch()-60)) RETURNING oauth_sha256").bind(runId,shopId).first();
 if(!claimed)return {claimed:false};
 try{
  const row=await db.prepare("SELECT o.oauth_envelope,o.eshop_url FROM shoptet_oauth o JOIN installations i ON i.shop_id=o.shop_id WHERE o.shop_id=? AND i.state='pending'").bind(shopId).first();
  if(!row||await digest(row.oauth_envelope)!==claimed.oauth_sha256)throw Error('installation_changed');
  const permanent=await createTokenVault(tokenKeys).open(shopId,'oauth',row.oauth_envelope);
  const temporary=await fetchImpl(trustedShopOrigin(row.eshop_url)+'/action/ApiOAuthServer/getAccessToken',{redirect:REDIRECT_MODE,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+permanent,Accept:'application/json'}});
  if(!temporary.ok)throw Error('temporary_token_unavailable');const temp=await temporary.json();if(typeof temp.access_token!=='string'||!temp.access_token)throw Error('temporary_token_unavailable');
  const headers={'Shoptet-Access-Token':temp.access_token,'Content-Type':'application/json'};
  const identity=await fetchImpl('https://api.myshoptet.com/api/eshop',{redirect:REDIRECT_MODE,signal:AbortSignal.timeout(10000),headers});if(!identity.ok)throw Error('identity_unavailable');const profile=await identity.json();
  if(profile.errors?.length||String(profile.data?.contactInformation?.eshopId)!==shopId)throw Error('identity_mismatch');
  let capabilities={verified:false,error:'approved_permissions_not_readable'};
  try{const res=await fetchImpl('https://api.myshoptet.com/api/system/endpoints?status=approved',{redirect:REDIRECT_MODE,signal:AbortSignal.timeout(5000),headers});if(res.ok){const body=await res.json();if(!body.errors?.length&&Array.isArray(body.data?.endpoints)&&body.data.endpoints.length<=1000&&body.data.endpoints.every(e=>typeof e.endpoint==='string'&&e.endpoint.length<=128&&['read','write','both'].includes(e.access)&&e.action===null))capabilities={verified:true,endpoints:body.data.endpoints.map(e=>({endpoint:e.endpoint,access:e.access,action:null}))};}}catch{}
  const results=await db.batch([
   db.prepare("UPDATE installations SET state='active',updated_at=CURRENT_TIMESTAMP WHERE shop_id=? AND state='pending' AND EXISTS(SELECT 1 FROM shoptet_oauth o JOIN installation_verification_jobs j ON j.shop_id=o.shop_id WHERE o.shop_id=installations.shop_id AND o.oauth_envelope=? AND j.run_id=? AND j.state='running')").bind(shopId,row.oauth_envelope,runId),
   db.prepare("UPDATE shoptet_installations SET status='active',updated_at=CURRENT_TIMESTAMP WHERE eshop_id=? AND EXISTS(SELECT 1 FROM installations i JOIN shoptet_oauth o ON o.shop_id=i.shop_id JOIN installation_verification_jobs j ON j.shop_id=i.shop_id WHERE i.shop_id=? AND i.state='active' AND o.oauth_envelope=? AND j.run_id=?)").bind(Number(shopId),shopId,row.oauth_envelope,runId),
   db.prepare("INSERT INTO tenant_capability_snapshots(shop_id,verified,capabilities_json,checked_at) SELECT ?,?,?,unixepoch() WHERE EXISTS(SELECT 1 FROM installations i JOIN shoptet_oauth o ON o.shop_id=i.shop_id JOIN installation_verification_jobs j ON j.shop_id=i.shop_id WHERE i.shop_id=? AND i.state='active' AND o.oauth_envelope=? AND j.run_id=?) ON CONFLICT(shop_id) DO UPDATE SET verified=excluded.verified,capabilities_json=excluded.capabilities_json,checked_at=excluded.checked_at").bind(shopId,capabilities.verified?1:0,JSON.stringify(capabilities),shopId,row.oauth_envelope,runId),
   db.prepare("UPDATE installation_verification_jobs SET state='succeeded',error_code=NULL,updated_at=unixepoch() WHERE shop_id=? AND run_id=? AND EXISTS(SELECT 1 FROM installations i JOIN shoptet_oauth o ON o.shop_id=i.shop_id WHERE i.shop_id=installation_verification_jobs.shop_id AND i.state='active' AND o.oauth_envelope=?)").bind(shopId,runId,row.oauth_envelope)
  ]);
  return {claimed:true,verified:!!results[0].meta?.changes,stale:!results[0].meta?.changes};
 }catch(error){
  const allowed=['installation_changed','temporary_token_unavailable','identity_unavailable','identity_mismatch'];const code=allowed.includes(error?.message)?error.message:'verification_failed';
  await db.prepare("UPDATE installation_verification_jobs SET state=CASE WHEN attempts>=3 OR ?='identity_mismatch' THEN 'failed' ELSE 'queued' END,error_code=?,next_attempt_at=?,updated_at=unixepoch() WHERE shop_id=? AND run_id=? AND state='running'").bind(code,code,now+60,shopId,runId).run();
  return {claimed:true,verified:false,error:code};
 }
}
export async function retryInstallations(env,fetchImpl=fetch){const rows=(await env.DB.prepare("SELECT shop_id FROM installation_verification_jobs WHERE attempts<3 AND next_attempt_at<=unixepoch() AND (state='queued' OR(state='running' AND started_at<unixepoch()-60)) ORDER BY updated_at LIMIT 10").bind().all()).results;for(const row of rows)await verifyInstallation({db:env.DB,shopId:row.shop_id,tokenKeys:env.SHOPTET_TOKEN_KEYS,fetchImpl});return {checked:rows.length};}
