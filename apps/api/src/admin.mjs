import { issueAssetApproval } from '../../../packages/core/src/admin-approval.mjs';
import { hashToken } from './mcp/server.mjs';
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const RELEASE=/^[A-Za-z0-9_-]{1,80}$/;
export async function handleAdmin(request,env){
 if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
 if(request.headers.has('origin'))return reply({error:'browser_origin_not_allowed'},403);
 if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return reply({error:'json_required'},415);
 if(Number(request.headers.get('content-length')||0)>8192)return reply({error:'payload_too_large'},413);
 if(!env?.DB)return reply({error:'unavailable'},503);
 const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get('authorization')||'');
 if(!match)return reply({error:'unauthorized'},401);
 const tokenHash=await hashToken(match[1]);
 const identity=await env.DB.prepare(`SELECT a.shop_id FROM admin_credentials a JOIN installations i ON i.shop_id=a.shop_id WHERE a.token_sha256=? AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>CURRENT_TIMESTAMP) AND i.state='active'`).bind(tokenHash).first();
 if(!identity)return reply({error:'unauthorized'},401);
 const raw=await request.text();if(raw.length>8192)return reply({error:'payload_too_large'},413);
 let body;try{body=JSON.parse(raw);}catch{return reply({error:'invalid_json'},400);}
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['releaseId','manifest'].includes(k))||!RELEASE.test(body.releaseId??''))return reply({error:'invalid_request'},400);
 try{
   const approval=await issueAssetApproval({db:env.DB,shopId:identity.shop_id,releaseId:body.releaseId,manifest:body.manifest});
   return reply({approvalId:approval.approvalId,expiresAt:approval.expiresAt,fileCount:approval.fileCount},201);
 }catch{return reply({error:'approval_rejected'},400);}
}
