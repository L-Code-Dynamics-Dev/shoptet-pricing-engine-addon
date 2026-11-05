import {boundedBytes,processLifecycle} from '../../../packages/core/src/webhooks.mjs';
import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
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
