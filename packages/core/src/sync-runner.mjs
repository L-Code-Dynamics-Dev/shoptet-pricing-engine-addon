import {digest} from './mcp-oauth.mjs';
import {grossApiPrice,formatApiPrice,shopDate,activeActionMinor} from './pricing-policy.mjs';
import {SyncError} from './sync-service.mjs';
export const NATIVE_PRICING_POLICY_VERSION='native-price-policy-v1';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const now=()=>Math.floor(Date.now()/1000);
export async function ownsSyncFence(db,shop,job,fence){return !!await db.prepare('SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?').bind(shop,job,fence).first();}
export function matchesExpectedPrice(row,action,p){return row?.code===action.code&&row.currencyCode===p.currency&&row.price.priceRatio==='1.000'&&activeActionMinor(row,p.vatPayer,p.date)===null&&formatApiPrice(grossApiPrice(row,p.vatPayer))===action.expected.price&&row.sales.discountCoupon===action.expected.discountCoupon;}
export function createSyncRunner({db,adapterFactory,assertLiveAllowed=async()=>{throw new SyncError('live_execution_not_activated');}}){
 async function job(shop,id){const j=await db.prepare('SELECT * FROM sync_jobs WHERE shop_id=? AND job_id=?').bind(shop,id).first();if(!j)throw new SyncError('job_not_found');return j;}
 async function check(shop,id,fence){if(!await ownsSyncFence(db,shop,id,fence))throw new SyncError('stale_sync_worker');}
 async function finish(shop,id,fence,error=null,quarantine=false){await db.prepare("UPDATE sync_jobs SET state=?,error_code=?,updated_at=unixepoch() WHERE shop_id=? AND job_id=? AND fence=? AND EXISTS(SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?)").bind(error?'failed':'succeeded',error,shop,id,fence,shop,id,fence).run();if(!quarantine)await db.prepare('UPDATE sync_shop_fences SET active_job_id=NULL WHERE shop_id=? AND active_job_id=? AND epoch=?').bind(shop,id,fence).run();return {done:true,error,quarantined:quarantine};}
 return {
  async step(shop,id){
   let j=await job(shop,id);if(!['queued','running'].includes(j.state))return {done:true,error:j.error_code};
   const f=await db.prepare('INSERT INTO sync_shop_fences(shop_id,epoch,active_job_id) VALUES(?,1,?) ON CONFLICT(shop_id) DO UPDATE SET epoch=epoch+1,active_job_id=excluded.active_job_id WHERE active_job_id IS NULL OR active_job_id=excluded.active_job_id RETURNING epoch').bind(shop,id).first();
   if(!f)return {done:false,blocked:'another_job_owns_shop'};const fence=f.epoch;
   const claimed=await db.prepare("UPDATE sync_jobs SET state='running',fence=?,updated_at=unixepoch() WHERE shop_id=? AND job_id=? AND state IN('queued','running') AND EXISTS(SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?)").bind(fence,shop,id,shop,id,fence).run();
   if(!claimed.meta?.changes)return {done:true,error:'stale_sync_worker'};
   // A prior external write may still be in flight. Never release this shop to a conflicting plan.
   const interrupted=await db.prepare("SELECT sequence FROM sync_job_items WHERE shop_id=? AND job_id=? AND state IN('writing','uncertain') LIMIT 1").bind(shop,id).first();
   if(interrupted){await db.prepare("UPDATE sync_job_items SET state='uncertain',error_code='external_outcome_uncertain' WHERE shop_id=? AND job_id=? AND sequence=?").bind(shop,id,interrupted.sequence).run();return finish(shop,id,fence,'external_outcome_uncertain',true);}
   j=await job(shop,id);
   if(j.cancel_requested)return finish(shop,id,fence,'cancelled');
   if(j.next_attempt_at && j.next_attempt_at>now())return {done:false,retryAt:j.next_attempt_at*1000};
   const item=await db.prepare("SELECT * FROM sync_job_items WHERE shop_id=? AND job_id=? AND state='pending' ORDER BY sequence LIMIT 1").bind(shop,id).first();
   if(!item)return finish(shop,id,fence);
   let writing=false;
   try{
    const stored=await db.prepare('SELECT * FROM sync_execution_plans WHERE shop_id=? AND plan_id=?').bind(shop,j.plan_id).first();
    if(!stored||await digest(stored.plan_json)!==stored.sha256)throw new SyncError('plan_integrity_failed');const p=JSON.parse(stored.plan_json),action=p.actions[item.sequence];
    const current=await db.prepare("SELECT t.version,i.state FROM tenant_settings t JOIN installations i ON i.shop_id=t.shop_id WHERE t.shop_id=?").bind(shop).first();
    if(current?.state!=='active'||current.version!==stored.settings_version)throw new SyncError('configuration_changed_or_installation_inactive');
    if(stored.expires_at<=now()||shopDate(p.timezone)!==p.date)throw new SyncError('plan_expired');
    if(j.mode==='live')await assertLiveAllowed({shopId:shop,plan:p,planId:j.plan_id});
    const adapter=await adapterFactory({shopId:shop,jobId:id,fence,plan:p,action});
    const profile=await adapter.profile();if(profile.vatPayer!==p.vatPayer||profile.timezone!==p.timezone||profile.defaultPricelistId!==p.sourcePricelistId)throw new SyncError('shop_profile_changed');
    const product=await adapter.product(action.productGuid);if(product.visibility!=='normal'||!product.variants.some(v=>v.code===action.code&&v.visible))throw new SyncError('product_or_variant_changed');
    const brandId=product.brand?(await adapter.brand(product.brand.code)).guid:null;if(brandId!==action.brandId)throw new SyncError('product_brand_changed');
    const categoryIds=[...new Set([product.defaultCategory.guid,...(product.categories??[]).map(c=>c.guid)].filter(Boolean))].sort();if(!equal(categoryIds,action.categoryIds))throw new SyncError('product_categories_changed');
    const source=await adapter.prices(p.sourcePricelistId,{code:action.code,limit:2}),target=await adapter.prices(p.targetPricelistId,{code:action.code,limit:2});
    if(source.items.length!==1||!equal(source.items[0],action.baseSnapshot)||target.items.length!==1)throw new SyncError('source_price_changed');
    await check(shop,id,fence);
    if(j.mode==='live'&&!matchesExpectedPrice(target.items[0],action,p)){
     if(!equal(target.items[0],action.beforeSnapshot))throw new SyncError('target_price_changed');
     const marked=await db.prepare("UPDATE sync_job_items SET state='writing',attempts=attempts+1 WHERE shop_id=? AND job_id=? AND sequence=? AND state='pending' AND EXISTS(SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?)").bind(shop,id,item.sequence,shop,id,fence).run();
     if(!marked.meta?.changes)throw new SyncError('stale_sync_worker');writing=true;
     const result=await adapter.writePrices(p.targetPricelistId,[action.patch]);
     await check(shop,id,fence);
     const readback=await adapter.prices(p.targetPricelistId,{code:action.code,limit:2});
     if(result.outcome==='unknown')throw new SyncError('external_outcome_uncertain');
     if(result.outcome!=='accepted')throw new SyncError('native_price_write_rejected');
     if(readback.items.length!==1||!matchesExpectedPrice(readback.items[0],action,p))throw new SyncError('native_price_verification_failed');
    }else if(j.mode==='dry-run'&&!equal(target.items[0],action.beforeSnapshot))throw new SyncError('target_price_changed');
    await check(shop,id,fence);
    await db.batch([
     db.prepare("UPDATE sync_job_items SET state='verified',changed=?,error_code=NULL WHERE shop_id=? AND job_id=? AND sequence=? AND EXISTS(SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?)").bind(writing?1:0,shop,id,item.sequence,shop,id,fence),
     db.prepare('UPDATE sync_jobs SET checkpoint=?,verified_count=verified_count+1,changed_count=changed_count+?,next_attempt_at=NULL,updated_at=unixepoch() WHERE shop_id=? AND job_id=? AND fence=? AND EXISTS(SELECT 1 FROM sync_shop_fences WHERE shop_id=? AND active_job_id=? AND epoch=?)').bind(item.sequence+1,writing?1:0,shop,id,fence,shop,id,fence)
    ]);
    return {done:false,checkpoint:item.sequence+1};
   }catch(error){
    if(!await ownsSyncFence(db,shop,id,fence))return {done:true,error:'stale_sync_worker'};
    const code=error instanceof SyncError?error.message:typeof error?.code==='string'?error.code:'sync_operation_failed';
    if(writing && !['native_price_write_rejected','native_price_verification_failed'].includes(code)){
     await db.prepare("UPDATE sync_job_items SET state='uncertain',error_code='external_outcome_uncertain' WHERE shop_id=? AND job_id=? AND sequence=?").bind(shop,id,item.sequence).run();return finish(shop,id,fence,'external_outcome_uncertain',true);
    }
    const transient=!writing && ['upstream_unavailable','rate_limited','upstream_error'].includes(code);
    if(transient&&item.attempts<2){const next=now()+Math.min(60,2**(item.attempts+1));await db.batch([db.prepare('UPDATE sync_job_items SET attempts=attempts+1,error_code=? WHERE shop_id=? AND job_id=? AND sequence=?').bind(code,shop,id,item.sequence),db.prepare('UPDATE sync_jobs SET next_attempt_at=?,updated_at=unixepoch() WHERE shop_id=? AND job_id=? AND fence=?').bind(next,shop,id,fence)]);return {done:false,retryAt:next*1000};}
    await db.prepare("UPDATE sync_job_items SET state='failed',error_code=? WHERE shop_id=? AND job_id=? AND sequence=?").bind(code,shop,id,item.sequence).run();return finish(shop,id,fence,code);
   }
  }
 };
}
