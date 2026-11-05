import { createInstallServices } from './install-services.mjs';
import { executeApprovedInstall } from '../../../../packages/core/src/approved-install.mjs';
import { deploymentPreview } from '../../../../packages/core/src/asset-deployment.mjs';
import { calculateTierPrice, resolveDiscountCap } from '../../../../packages/core/src/pricing.mjs';

const protocol = '2025-03-26';
// Public MCP contract: expose business outcomes only, never implementation details.
// This is a data minimization boundary, not a guarantee about third-party agent speech.
const publicStatus = (row) => ({ active: row?.state === 'active' });
const definitions = [
  { name:'pricing_preview', description:'Preview the final customer price without applying changes.', inputSchema:{type:'object',additionalProperties:false,required:['baseMinor','tierPercent'],properties:{baseMinor:{type:'integer',minimum:0},actionMinor:{type:['integer','null'],minimum:0},tierPercent:{type:'number',minimum:0,maximum:100},productCap:{type:['number','null'],minimum:0,maximum:100},brandCap:{type:['number','null'],minimum:0,maximum:100},categoryCap:{type:['number','null'],minimum:0,maximum:100},code:{type:'string',maxLength:128},vatRate:{type:'string',pattern:'^[0-9]{1,2}\\.[0-9]{2}$'}}}},
  { name:'frontend_assets_preview',description:'Preview the approved frontend asset filenames before installation. No upload is performed.',inputSchema:{type:'object',additionalProperties:false,required:['manifest'],properties:{manifest:{type:'array',minItems:1,maxItems:5,items:{type:'object',additionalProperties:false,required:['name','sha256'],properties:{name:{type:'string'},sha256:{type:'string'}}}}}}},
  { name:'frontend_assets_install',description:'Install a previously approved frontend release. Requires an approval issued by the shop administrator.',inputSchema:{type:'object',additionalProperties:false,required:['approvalId'],properties:{approvalId:{type:'string',minLength:16,maxLength:96}}}},
  { name:'installation_status',description:'Check whether the connected shop is active.',inputSchema:{type:'object',additionalProperties:false,properties:{}}}
];
const json = (body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const rpcError=(id,code,message,status=200)=>json({jsonrpc:'2.0',id,error:{code,message}},status);
const toolResult=(value)=>({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
const hex=(bytes)=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export async function hashToken(token){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));}
async function authenticate(request,env){
  const auth=request.headers.get('authorization')||'';
  const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth);
  if(!match || !env.DB) return null;
  const digest=await hashToken(match[1]);
  const record=await env.DB.prepare(`SELECT c.shop_id,c.scopes_json FROM mcp_credentials c JOIN installations i ON i.shop_id=c.shop_id WHERE c.token_sha256=? AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>CURRENT_TIMESTAMP) AND i.state='active'`).bind(digest).first();
  if(!record) return null;
  let scopes;try{scopes=JSON.parse(record.scopes_json);}catch{return null;}
  if(!Array.isArray(scopes)||!scopes.every(x=>typeof x==='string'))return null;
  return {shopId:record.shop_id,scopes:new Set(scopes)};
}
function validPreview(a){
  if(!a||typeof a!=='object'||Array.isArray(a))return false;
  const allowed=new Set(['baseMinor','actionMinor','tierPercent','productCap','brandCap','categoryCap','code','vatRate']);
  if(Object.keys(a).some(k=>!allowed.has(k)))return false;
  if(!Number.isSafeInteger(a.baseMinor)||a.baseMinor<0||!Number.isFinite(a.tierPercent)||a.tierPercent<0||a.tierPercent>100)return false;
  if(a.actionMinor!=null&&(!Number.isSafeInteger(a.actionMinor)||a.actionMinor<0))return false;
  for(const k of ['productCap','brandCap','categoryCap'])if(a[k]!=null&&(!Number.isFinite(a[k])||a[k]<0||a[k]>100))return false;
  if(a.code!==undefined&&(typeof a.code!=='string'||!a.code.trim()||a.code.length>128))return false;
  if(a.vatRate!==undefined&&(typeof a.vatRate!=='string'||!/^[0-9]{1,2}\.[0-9]{2}$/.test(a.vatRate)))return false;
  return (a.code===undefined)===(a.vatRate===undefined);
}
export async function handleMcp(request,env){
  if(request.method!=='POST')return json({error:'method_not_allowed'},405,{allow:'POST'});
  // Browser-originated requests are disallowed until trusted-origin validation is configured.
  if(request.headers.has('origin'))return json({error:'browser_origin_not_allowed'},403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'json_required'},415);
  const length=Number(request.headers.get('content-length')||0);
  if(length>16384)return json({error:'payload_too_large'},413);
  const identity=await authenticate(request,env);
  if(!identity)return json({error:'unauthorized'},401,{'www-authenticate':'Bearer'});
  const raw=await request.text();if(raw.length>16384)return json({error:'payload_too_large'},413);
  let rpc;try{rpc=JSON.parse(raw);}catch{return rpcError(null,-32700,'Parse error');}
  if(!rpc||Array.isArray(rpc)||typeof rpc!=='object'||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||(!('id' in rpc)&&rpc.method!=='notifications/initialized'))return rpcError(null,-32600,'Invalid Request');
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  const id=rpc.id;
  if(typeof id!=='string'&&typeof id!=='number'&&id!==null)return rpcError(null,-32600,'Invalid id');
  if(rpc.method==='initialize')return json({jsonrpc:'2.0',id,result:{protocolVersion:protocol,capabilities:{tools:{listChanged:false}},serverInfo:{name:'L-Code Loyalty Pricing',version:'1.0'}}});
  if(rpc.method==='ping')return json({jsonrpc:'2.0',id,result:{}});
  if(rpc.method==='tools/list')return json({jsonrpc:'2.0',id,result:{tools:definitions.filter(t=>identity.scopes.has(t.name==='pricing_preview'?'pricing:preview':t.name==='frontend_assets_preview'?'assets:preview':t.name==='frontend_assets_install'?'assets:install':'installation:read'))}});
  if(rpc.method==='tools/call'){
    const name=rpc.params?.name, args=rpc.params?.arguments??{};
    if(!definitions.some(t=>t.name===name))return rpcError(id,-32602,'Unknown tool');
    const required=name==='pricing_preview'?'pricing:preview':name==='frontend_assets_preview'?'assets:preview':name==='frontend_assets_install'?'assets:install':'installation:read';
    if(!identity.scopes.has(required))return rpcError(id,-32603,'Forbidden',403);
    if(name==='frontend_assets_install'){
      if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length!==1 || typeof args.approvalId!=='string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(args.approvalId))return rpcError(id,-32602,'Invalid arguments');
      // Never accept manifests, file content, credentials or shop IDs from MCP.
      // Production must inject an atomic approval store, per-shop lock and
      // host-key-verified SFTP transport. Otherwise the tool fails closed.
      const services=createInstallServices(env);
      if(!services)return rpcError(id,-32603,'Installation unavailable',503);
      try {
        const result=await executeApprovedInstall({shopId:identity.shopId,approvalId:args.approvalId,...services,runId:crypto.randomUUID().replaceAll('-','')});
        return json({jsonrpc:'2.0',id,result:toolResult(result)});
      } catch {return rpcError(id,-32603,'Installation failed or not authorized');}
    }
    if(name==='frontend_assets_preview'){
      if(!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length!==1 || !('manifest' in args))return rpcError(id,-32602,'Invalid arguments');
      try{return json({jsonrpc:'2.0',id,result:toolResult(deploymentPreview(args.manifest))});}catch{return rpcError(id,-32602,'Invalid asset manifest');}
    }
    if(name==='pricing_preview'){
      if(!validPreview(args))return rpcError(id,-32602,'Invalid preview arguments');
      const cap=resolveDiscountCap({productCap:args.productCap??null,brandCap:args.brandCap??null,categoryCap:args.categoryCap??null});
      const priceMinor=calculateTierPrice({baseMinor:args.baseMinor,actionMinor:args.actionMinor??null,tierPercent:args.tierPercent,capPercent:cap});
      const result={priceMinor,mode:'preview',changesApplied:false};
      return json({jsonrpc:'2.0',id,result:toolResult(result)});
    }
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length)return rpcError(id,-32602,'Invalid arguments');
    const row=await env.DB.prepare('SELECT shop_id,state,created_at,updated_at FROM installations WHERE shop_id=?').bind(identity.shopId).first();
    return json({jsonrpc:'2.0',id,result:toolResult(publicStatus(row))});
  }
  return rpcError(id,-32601,'Method not found');
}
