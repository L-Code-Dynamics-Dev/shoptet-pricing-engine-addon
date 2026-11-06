import {boundedBytes,processLifecycle} from '../../../packages/core/src/webhooks.mjs';
import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
import {processOrderWebhook} from '../../../packages/core/src/loyalty-webhook-processor.mjs';
import {getPricelistPolicy} from '../../../packages/core/src/loyalty-repository.mjs';
import {createShoptetAdapter} from '../../../packages/core/src/shoptet-adapter.mjs';
import {getShoptetApiAccessToken} from '../../../packages/core/src/shoptet-oauth.mjs';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function handleShoptetLifecycle(request,env,ctx=null){
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 const signature=request.headers.get('shoptet-webhook-signature');if(!/^[a-f0-9]{40}$/i.test(signature||'')||request.headers.has('origin'))return json({error:'webhook_not_authorized'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'json_required'},415);
 try{const bytes=await boundedBytes(request,16384);const result=await processLifecycle({db:env.DB,tokenKeys:env.SHOPTET_TOKEN_KEYS,bytes,signature,allowedEvent:new URL(request.url).pathname==='/shoptet/uninstall'?'addon:uninstall':null});
  if(result.applied&&result.event==='addon:approve'&&ctx?.waitUntil)ctx.waitUntil(verifyInstallation({db:env.DB,shopId:result.shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS}));
  return json({accepted:true});
 }catch{return json({error:'webhook_not_authorized'},403);}
}

export async function handleShoptetOrderWebhook(request,env,fetchImpl=fetch,ctx=null){
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 const signature=request.headers.get('shoptet-webhook-signature');if(!/^[a-f0-9]{40}$/i.test(signature||'')||request.headers.has('origin'))return json({error:'webhook_not_authorized'},403);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'json_required'},415);
 try{
  const bytes=await boundedBytes(request,16384);
  const event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  const shopId=String(event?.eshopId??'');
  const adapter=createShoptetAdapter({
   getToken:async()=>{
    const t=await getShoptetApiAccessToken({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS,fetchImpl});
    return t.apiAccessToken;
   },
   fetchImpl,
   authorizeWrite:async()=>true
  });
  const result=await processOrderWebhook({
   db:env.DB,
   tokenKeys:env.SHOPTET_TOKEN_KEYS,
   bytes,
   signature,
   adapter,
   loadVerifiedContext:async verifiedShopId=>{
    const settingsRow=await env.DB.prepare('SELECT config_json FROM tenant_settings WHERE shop_id=?')
      .bind(verifiedShopId).first();
    const config=settingsRow?JSON.parse(settingsRow.config_json):{};
    const proposal=config.loyaltyProposal ?? config;
    const policy=proposal.turnoverPolicy || config.turnoverPolicy || {
     period:{from:'2020-01-01T00:00:00Z',to:'2030-01-01T00:00:00Z'},
     qualifyingStatusIds:[-3],
     requirePaid:true,
     shipping:'exclude',
     billing:'exclude',
     discounts:'after_discounts',
     vat:'inclusive',
     refunds:'exclude_order_with_valid_credit_note',
     guestCustomers:'exclude',
     itemStatuses:'require_match_order',
     upgrades:'recalculate',
     downgrades:'keep_current'
    };
    const policyRow=await getPricelistPolicy(env.DB,verifiedShopId);
    const mode=policyRow?.engineMode==='active'?'live':'staging';
    return {policy,tiers:proposal.tiers ?? config.tiers ?? [],mode};
   }
  });
  return json(result,result.accepted?200:503);
 }catch(error){
  const authFailure=['invalid_signature','invalid_event'].includes(error?.message);
  return authFailure
   ? json({error:'webhook_not_authorized'},403)
   : json({error:'webhook_processing_unavailable'},503);
 }
}
