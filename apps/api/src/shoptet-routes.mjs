import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
import {trustedShopOrigin} from '../../../packages/core/src/shoptet-oauth.mjs';
import {parseTokenKeys} from '../../../packages/core/src/token-vault.mjs';
import {digest} from '../../../packages/core/src/mcp-oauth.mjs';
import { exchangeAuthorizationCode, saveShoptetInstallation, getShoptetApiAccessToken } from '../../../packages/core/src/shoptet-oauth.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const html = (body, status = 200) => new Response(`<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>L-Code Loyalty Pricing Engine — Shoptet</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 32px; max-width: 520px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    h1 { margin-top: 0; font-size: 1.5rem; color: #38bdf8; }
    .badge { display: inline-block; background: #065f46; color: #34d399; padding: 4px 10px; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; margin-bottom: 16px; }
    p { line-height: 1.6; color: #cbd5e1; }
    .details { background: #0f172a; border: 1px solid #1e293b; padding: 16px; border-radius: 8px; font-family: monospace; font-size: 0.9rem; color: #94a3b8; word-break: break-all; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
  </div>
</body>
</html>`, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
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

export async function handleShoptetUninstall(request, env) {
  let shopId = null;
  try {
    const data = await request.json();
    shopId = data.eshopId || data.shop_id || data.shopId;
  } catch {
    const url = new URL(request.url);
    shopId = url.searchParams.get('eshopId') || url.searchParams.get('shopId');
  }

  if (!shopId) {
    return json({ error: 'missing_shop_id' }, 400);
  }

  if (env.DB) {
    await env.DB.prepare(`
      UPDATE installations SET state = 'uninstalled', updated_at = CURRENT_TIMESTAMP
      WHERE shop_id = ?
    `).bind(String(shopId)).run();
  }

  return json({ status: 'uninstalled', shopId: String(shopId) });
}

export async function handleShoptetStatus(request, env) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get('shopId') || '826800';

  if (!env.DB) return json({ error: 'db_not_bound' }, 500);

  const row = await env.DB.prepare(`
    SELECT shop_id, eshop_url, contact_email, created_at, updated_at
    FROM shoptet_oauth
    WHERE shop_id = ?
  `).bind(shopId).first();

  if (!row) {
    return json({ installed: false, shopId });
  }

  return json({
    installed: true,
    shop: row
  });
}

export async function handleShoptetApiTest(request, env) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get('shopId') || '826800';

  try {
    const { apiAccessToken, expiresIn } = await getShoptetApiAccessToken({
      db: env.DB,
      tokenKeys: env.SHOPTET_TOKEN_KEYS,
      shopId,
      fetchImpl: fetch
    });

    // Test calling Shoptet REST API eshop info endpoint
    const apiRes = await fetch('https://api.myshoptet.com/api/eshop', {
      headers: {
        'Shoptet-Access-Token': apiAccessToken,
        'Content-Type': 'application/vnd.shoptet.v1.0'
      }
    });

    const apiData = await apiRes.json();

    return json({
      status: 'connected',
      shopId,
      expiresIn,
      shoptetApiStatus: apiRes.status,
      eshop: apiData
    });
  } catch (err) {
    return json({
      status: 'error',
      shopId,
      message: err.message
    }, 500);
  }
}
