import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
import {trustedShopOrigin} from '../../../packages/core/src/shoptet-oauth.mjs';
import {parseTokenKeys} from '../../../packages/core/src/token-vault.mjs';
import {digest} from '../../../packages/core/src/mcp-oauth.mjs';
import { exchangeAuthorizationCode, saveShoptetInstallation } from '../../../packages/core/src/shoptet-oauth.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export async function handleShoptetInstall(request, env, fetchImpl=fetch, ctx=null) {
  const url=new URL(request.url),code=url.searchParams.get('code');
  if(request.method!=='GET')return json({error:'method_not_allowed'},405);
  if(!code||code.length<8||code.length>512||url.searchParams.getAll('code').length!==1)return json({error:'invalid_installation_code'},400);
  let oauthOrigin,publicOrigin;
  try{
    oauthOrigin=trustedShopOrigin(env.SHOPTET_OAUTH_ORIGIN);
    const origin=new URL(env.ADDON_PUBLIC_ORIGIN||env.MCP_PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error();publicOrigin=origin.origin;
    if(!env.SHOPTET_CLIENT_ID||!env.SHOPTET_CLIENT_SECRET)throw Error();parseTokenKeys(env.SHOPTET_TOKEN_KEYS);
  }catch{return json({error:'installation_not_configured'},503);}
  if(url.origin!==publicOrigin || url.searchParams.has('eshopUrl'))return json({error:'invalid_installation_origin'},400);
  const callbackHash=await digest(code);
  const claim=await env.DB.prepare("INSERT INTO shoptet_install_callbacks(code_sha256,state) VALUES(?,'processing') ON CONFLICT(code_sha256) DO NOTHING").bind(callbackHash).run();
  if(!claim.meta?.changes){const prior=await env.DB.prepare('SELECT state FROM shoptet_install_callbacks WHERE code_sha256=?').bind(callbackHash).first();return prior?.state==='succeeded'?new Response('OK',{headers:{'content-type':'text/plain','cache-control':'no-store'}}):json({error:'installation_code_already_claimed'},409);}
  try{
    const token=await exchangeAuthorizationCode({code,eshopUrl:oauthOrigin,redirectUri:publicOrigin+'/shoptet/install',clientId:env.SHOPTET_CLIENT_ID,clientSecret:env.SHOPTET_CLIENT_SECRET,fetchImpl,timeoutMs:4000});
    if(!/^[1-9][0-9]{0,11}$/.test(token.eshopId))throw Error('Unverified shop identity');
    const shopOrigin='https://'+token.eshopId+'.myshoptet.com';
    await saveShoptetInstallation({db:env.DB,shopId:token.eshopId,accessToken:token.accessToken,eshopUrl:shopOrigin,contactEmail:null,tokenKeys:env.SHOPTET_TOKEN_KEYS,callbackHash,installationState:'pending'});
    if(ctx?.waitUntil)ctx.waitUntil(verifyInstallation({db:env.DB,shopId:token.eshopId,tokenKeys:env.SHOPTET_TOKEN_KEYS,fetchImpl}));
    return new Response('OK',{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
  }catch{
    await env.DB.prepare("UPDATE shoptet_install_callbacks SET state='failed',completed_at=unixepoch() WHERE code_sha256=? AND state='processing'").bind(callbackHash).run();
    return json({error:'installation_verification_failed',message:'Instalaci se nepodařilo ověřit. Zkontrolujte partnerské nastavení, schválená oprávnění a spusťte instalaci s novým autorizačním kódem.'},502);
  }
}
