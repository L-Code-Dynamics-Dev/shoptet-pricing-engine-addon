import { createTokenVault } from './token-vault.mjs';
export function trustedShopOrigin(value) {
  let url; try { url = new URL(value); } catch { throw Error('Trusted shop URL required'); }
  if (url.protocol !== 'https:' || !/^[0-9]{1,12}\.myshoptet\.com$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Trusted shop URL required');
  return url.origin;
}

/**
 * Shoptet OAuth 2.0 handler for Partner Addon installation & short-term API token management.
 */

export async function exchangeAuthorizationCode({
  code,
  eshopUrl,
  redirectUri,
  clientId,
  clientSecret,
  fetchImpl = fetch
}) {
  if (!code || typeof code !== 'string') throw new Error('Missing authorization code');
  if (!clientId || !clientSecret) throw new Error('Missing client credentials');
  if (!redirectUri) throw new Error('Missing redirectUri');

  const baseUrl = trustedShopOrigin(eshopUrl);

  const tokenEndpoint = `${baseUrl}/action/ApiOAuthServer/token`;

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: code.trim(),
      redirect_uri: redirectUri,
      scope: 'api'
    })
  });

  if (!response.ok) {
    throw new Error(`OAuth exchange failed (${response.status})`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('OAuth server response did not include access_token');
  }

  return {
    accessToken: data.access_token,
    eshopId: String(data.eshopId || data.eshop_id || ''),
    eshopUrl: data.eshopUrl || data.eshop_url || baseUrl,
    contactEmail: data.contactEmail || data.contact_email || null
  };
}

export async function saveShoptetInstallation({ db, shopId, accessToken, eshopUrl, contactEmail, tokenKeys }) {
  if (!db || typeof shopId!=='string' || !/^[0-9]{1,12}$/.test(shopId)) throw Error('Invalid installation context');
  const origin=trustedShopOrigin(eshopUrl);
  const envelope=await createTokenVault(tokenKeys).seal(shopId,'oauth',accessToken);
  // D1 batch is transactional: installation identity and secret cannot partially persist.
  await db.batch([
    db.prepare("INSERT INTO installations(shop_id,state,updated_at) VALUES(?,'active',CURRENT_TIMESTAMP) ON CONFLICT(shop_id) DO UPDATE SET state='active',updated_at=CURRENT_TIMESTAMP").bind(shopId),
    db.prepare("INSERT INTO shoptet_oauth(shop_id,oauth_access_token,eshop_url,contact_email,oauth_envelope) VALUES(?,'',?,?,?) ON CONFLICT(shop_id) DO UPDATE SET oauth_access_token='',cached_api_token=NULL,api_envelope=NULL,api_token_expires_at=NULL,eshop_url=excluded.eshop_url,contact_email=excluded.contact_email,oauth_envelope=excluded.oauth_envelope,updated_at=CURRENT_TIMESTAMP").bind(shopId,origin,contactEmail??null,envelope),
    db.prepare("INSERT INTO shoptet_installations(eshop_id,eshop_url,contact_email,oauth_token,status) VALUES(?,?,?,'','active') ON CONFLICT(eshop_id) DO UPDATE SET eshop_url=excluded.eshop_url,contact_email=excluded.contact_email,oauth_token='',status='active',updated_at=CURRENT_TIMESTAMP").bind(Number(shopId),origin,contactEmail??null)
  ]);
  return {success:true,shopId};
}

export async function getShoptetApiAccessToken({ db, shopId, tokenKeys, fetchImpl = fetch }) {
  const vault=createTokenVault(tokenKeys);
  if(!db || typeof shopId!=='string'||!shopId)throw Error('Invalid installation context');
  const row=await db.prepare("SELECT o.oauth_envelope,o.api_envelope,o.api_token_expires_at,o.eshop_url FROM shoptet_oauth o JOIN installations i ON i.shop_id=o.shop_id WHERE o.shop_id=? AND i.state='active'").bind(shopId).first();
  if(!row?.oauth_envelope)throw Error('Encrypted installation token unavailable; migration required');
  const nowSec=Math.floor(Date.now()/1000);
  if(row.api_envelope && row.api_token_expires_at>nowSec+60)return {apiAccessToken:await vault.open(shopId,'api',row.api_envelope),expiresIn:row.api_token_expires_at-nowSec};
  const oauth=await vault.open(shopId,'oauth',row.oauth_envelope);
  const response=await fetchImpl(trustedShopOrigin(row.eshop_url)+'/action/ApiOAuthServer/getAccessToken',{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+oauth}});
  if(!response.ok)throw Error('API token renewal failed ('+response.status+')');
  const data=await response.json();
  if(typeof data.access_token!=='string'||!data.access_token||!Number.isSafeInteger(data.expires_in)||data.expires_in<=0||data.expires_in>86400)throw Error('Invalid API token response');
  const envelope=await vault.seal(shopId,'api',data.access_token);
  const saved=await db.prepare("UPDATE shoptet_oauth SET api_envelope=?,api_token_expires_at=? WHERE shop_id=? AND oauth_envelope=? AND EXISTS(SELECT 1 FROM installations i WHERE i.shop_id=shoptet_oauth.shop_id AND i.state='active')").bind(envelope,nowSec+data.expires_in,shopId,row.oauth_envelope).run();
  if(!saved.meta?.changes)throw Error('Installation changed during token renewal');
  return {apiAccessToken:data.access_token,expiresIn:data.expires_in};
}

// Explicit server/operator utility: never exposed as an MCP tool or public route.
// Retain old keys during rotation. Batch clears both legacy copies atomically.
export async function migrateShopTokens({db,shopId,tokenKeys}) {
  const vault=createTokenVault(tokenKeys);
  const row=await db.prepare('SELECT * FROM shoptet_oauth WHERE shop_id=?').bind(shopId).first();
  if(!row)throw Error('Installation unavailable');
  const token=row.oauth_envelope?await vault.open(shopId,'oauth',row.oauth_envelope):row.oauth_access_token;
  if(!token)throw Error('Installation token unavailable');
  const oauth=await vault.seal(shopId,'oauth',token);
  const api=row.api_envelope?await vault.open(shopId,'api',row.api_envelope):row.cached_api_token;
  const encryptedApi=api?await vault.seal(shopId,'api',api):null;
  const results=await db.batch([
    db.prepare("UPDATE shoptet_oauth SET oauth_envelope=?,api_envelope=?,oauth_access_token='',cached_api_token=NULL WHERE shop_id=? AND oauth_access_token=? AND oauth_envelope IS ?").bind(oauth,encryptedApi,shopId,row.oauth_access_token,row.oauth_envelope??null),
    db.prepare("UPDATE shoptet_installations SET oauth_token='' WHERE eshop_id=? AND EXISTS(SELECT 1 FROM shoptet_oauth WHERE shop_id=? AND oauth_envelope=?)").bind(Number(shopId),shopId,oauth)
  ]);
  if(!results[0].meta?.changes)throw Error('Concurrent token migration');
  return {shopId,encrypted:true};
}
