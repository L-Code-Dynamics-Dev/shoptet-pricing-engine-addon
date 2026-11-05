import {createSyncService,SyncError} from '../../../../packages/core/src/sync-service.mjs';
import {createSyncRunner,ownsSyncFence,NATIVE_PRICING_POLICY_VERSION} from '../../../../packages/core/src/sync-runner.mjs';
import {createShoptetAdapter} from '../../../../packages/core/src/shoptet-adapter.mjs';
import {getShoptetApiAccessToken} from '../../../../packages/core/src/shoptet-oauth.mjs';
export function syncRuntime(env,shopId){
 const getToken=async()=> (await getShoptetApiAccessToken({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS})).apiAccessToken;
 const adapter=createShoptetAdapter({getToken});
 async function assertLiveAllowed({plan}){
  if(env.SYNC_MODE!=='live')throw new SyncError('live_execution_not_activated');
  if(env.PRICING_PARITY_APPROVAL!==NATIVE_PRICING_POLICY_VERSION)throw new SyncError('pricing_parity_approval_missing');
  const endpoint=env.SHOPTET_PRICE_WRITE_ENDPOINT;
  if(typeof endpoint!=='string'||!endpoint||endpoint.length>128)throw new SyncError('approved_endpoint_identifier_not_configured');
  const approved=await adapter.capabilities();
  if(!approved.endpoints.some(e=>e.endpoint===endpoint && ['write','both'].includes(e.access)&&e.action===null))throw new SyncError('native_price_write_permission_missing');
  if(plan.schemaVersion!==1)throw new SyncError('unsupported_plan_schema');
 }
 const service=createSyncService({db:env.DB,adapter,assertLiveAllowed});
 const runner=createSyncRunner({db:env.DB,assertLiveAllowed,adapterFactory:async context=>createShoptetAdapter({getToken,authorizeWrite:async({pricelistId,items})=>{
  if(context.shopId!==shopId||pricelistId!==context.plan.targetPricelistId||JSON.stringify(items)!==JSON.stringify([context.action.patch]))throw new SyncError('immutable_plan_mismatch');
  await assertLiveAllowed({plan:context.plan});
  const state=await env.DB.prepare('SELECT j.cancel_requested,j.state,t.version,p.settings_version,p.expires_at,i.state AS installation_state FROM sync_jobs j JOIN sync_execution_plans p ON p.shop_id=j.shop_id AND p.plan_id=j.plan_id JOIN tenant_settings t ON t.shop_id=j.shop_id JOIN installations i ON i.shop_id=j.shop_id WHERE j.shop_id=? AND j.job_id=?').bind(shopId,context.jobId).first();
  if(!state||state.cancel_requested||state.state!=='running'||state.installation_state!=='active'||state.version!==state.settings_version||state.expires_at<=Math.floor(Date.now()/1000))throw new SyncError('write_preflight_denied');
  if(!await ownsSyncFence(env.DB,shopId,context.jobId,context.fence))throw new SyncError('stale_sync_worker');
 }})});
 async function schedule(job){if(!env.SYNC_COORDINATOR)throw new SyncError('sync_coordinator_not_configured');try{await env.SYNC_COORDINATOR.getByName('shop:'+shopId).enqueue({shopId,jobId:job.jobId});return job;}catch{return {...job,schedulingError:'coordinator_unavailable',recoverable:true};}}
 return {service,runner,async execute(planId,mode,approvalId){if(!env.SYNC_COORDINATOR)throw new SyncError('sync_coordinator_not_configured');return schedule(await service.execute(shopId,planId,mode,approvalId));},async retry(jobId){return schedule(await service.retry(shopId,jobId));},async verify(planId){const {plan}=await service.getPlan(shopId,planId);const results=[];for(const action of plan.actions){const response=await adapter.prices(plan.targetPricelistId,{code:action.code,limit:2});const {matchesExpectedPrice}=await import('../../../../packages/core/src/sync-runner.mjs');results.push({code:action.code,matches:response.items.length===1&&matchesExpectedPrice(response.items[0],action,plan)});}return {planId,pricesMatched:results.every(r=>r.matches),items:results,customerAssignmentsVerified:false,storefrontVerified:false};}};
}
