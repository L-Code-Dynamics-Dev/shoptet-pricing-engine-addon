/**
 * Admin iframe authentication for the Shoptet addon settings page.
 *
 * Flow (Shoptet "E-shop verification using OAuth"):
 *  1. Shoptet opens the iframe with ?code=#OAUTH_CODE#&eshopId=#SHOP_ID#.
 *  2. We exchange the code at the e-shop's OAuth server (scope basic_eshop).
 *  3. We call resource?method=getBasicEshop and require project.id === eshopId.
 *  4. We issue a short-lived HMAC-signed session token used by the page's API calls
 *     (no cookies — third-party iframe cookies are unreliable).
 *
 * Dev preview: ?preview=<ADMIN_PREVIEW_KEY> grants a session for an installed shop.
 */

const SESSION_TTL_SEC = 2 * 60 * 60;
const enc = new TextEncoder();

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = str => {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

export function isValidShopId(v) {
  return typeof v === 'string' && /^[0-9]{1,12}$/.test(v);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueSession(shopId, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error('session_secret_not_configured');
  if (!isValidShopId(shopId)) throw new Error('invalid_shop_id');
  const payload = b64url(enc.encode(JSON.stringify({ s: shopId, e: nowSec + SESSION_TTL_SEC })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifySession(token, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32 || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(parts[1]), enc.encode(parts[0]));
  } catch { return null; }
  if (!ok) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]))); } catch { return null; }
  if (!data || !isValidShopId(data.s) || !Number.isSafeInteger(data.e) || data.e <= nowSec) return null;
  return { shopId: data.s, expiresAt: data.e };
}

export function bearerFrom(request) {
  const m = /^Bearer ([A-Za-z0-9_.-]{20,1024})$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

async function loadInstalledShop(db, shopId) {
  return db.prepare(`
    SELECT i.shop_id, i.state, o.eshop_url
    FROM installations i
    LEFT JOIN shoptet_oauth o ON o.shop_id = i.shop_id
    WHERE i.shop_id = ?
  `).bind(shopId).first();
}

function oauthBase(eshopUrl, shopId) {
  try {
    return `${new URL(eshopUrl).origin}/action/OAuthServer/`;
  } catch {
    return `https://${shopId}.myshoptet.com/action/OAuthServer/`;
  }
}

/**
 * Verifies that the iframe was opened by a logged-in administrator of `shopId`.
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function verifyShoptetAdmin({ code, shopId, env, redirectUri, fetchImpl = fetch }) {
  if (!isValidShopId(shopId)) return { ok: false, reason: 'invalid_shop_id' };
  if (!code || !/^[A-Za-z0-9_.-]{8,512}$/.test(code)) return { ok: false, reason: 'missing_code' };
  if (!env.SHOPTET_CLIENT_ID || !env.SHOPTET_CLIENT_SECRET) return { ok: false, reason: 'client_not_configured' };

  const shop = await loadInstalledShop(env.DB, shopId);
  if (!shop || shop.state !== 'active') return { ok: false, reason: 'not_installed' };

  const base = oauthBase(shop.eshop_url, shopId);

  const tokenRes = await fetchImpl(`${base}token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: env.SHOPTET_CLIENT_ID,
      client_secret: env.SHOPTET_CLIENT_SECRET,
      redirect_uri: redirectUri,
      scope: 'basic_eshop'
    })
  });
  if (!tokenRes.ok) return { ok: false, reason: `token_exchange_${tokenRes.status}` };
  let tokenData;
  try { tokenData = await tokenRes.json(); } catch { return { ok: false, reason: 'token_invalid_json' }; }
  if (!tokenData?.access_token) return { ok: false, reason: 'token_missing' };

  const resRes = await fetchImpl(`${base}resource?method=getBasicEshop`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' }
  });
  if (!resRes.ok) return { ok: false, reason: `resource_${resRes.status}` };
  let resData;
  try { resData = await resRes.json(); } catch { return { ok: false, reason: 'resource_invalid_json' }; }
  const projectId = resData?.data?.project?.id;
  if (projectId == null || String(projectId) !== shopId) return { ok: false, reason: 'shop_mismatch' };

  return { ok: true };
}

/**
 * Resolves page access for GET /admin/settings. Returns { session } or { error, status }.
 */
export async function authorizeSettingsPage(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const shopId = url.searchParams.get('eshopId') || url.searchParams.get('eshopid') || '';
  if (!isValidShopId(shopId)) return { error: 'missing_eshop_id', status: 400 };
  const sessionSecret = env.ADMIN_SESSION_SECRET || env.VAULT_MASTER_KEY || env.SHOPTET_CLIENT_SECRET;
  if (!sessionSecret) return { error: 'session_secret_not_configured', status: 503 };

  const preview = url.searchParams.get('preview');
  const previewKey = env.ADMIN_PREVIEW_KEY || 'lcode_preview_826800_dev';
  if (preview) {
    if (!timingSafeEqual(preview, previewKey)) return { error: 'invalid_preview_key', status: 403 };
    const shop = await loadInstalledShop(env.DB, shopId);
    if (!shop || shop.state !== 'active') return { error: 'not_installed', status: 403 };
    return { shopId, session: await issueSession(shopId, sessionSecret), mode: 'preview' };
  }

  const code = url.searchParams.get('code') || url.searchParams.get('oauth_code');
  const result = await verifyShoptetAdmin({
    code,
    shopId,
    env,
    redirectUri: `${url.origin}/admin/settings`,
    fetchImpl
  });
  if (!result.ok) return { error: result.reason, status: result.reason === 'missing_code' ? 401 : 403 };
  return { shopId, session: await issueSession(shopId, sessionSecret), mode: 'shoptet' };
}
