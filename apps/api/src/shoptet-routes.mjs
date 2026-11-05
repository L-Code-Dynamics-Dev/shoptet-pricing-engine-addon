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

export async function handleShoptetInstall(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    return json({
      error: 'missing_code',
      message: 'Požadavek neobsahuje autorizační kód ze Shoptetu (parametr code).'
    }, 400);
  }

  const clientId = env.SHOPTET_CLIENT_ID;
  const clientSecret = env.SHOPTET_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return json({
      error: 'credentials_not_configured',
      message: 'Worker nemá nakonfigurován SHOPTET_CLIENT_ID nebo SHOPTET_CLIENT_SECRET.'
    }, 500);
  }

  const redirectUri = `${url.origin}/shoptet/install`;
  const eshopUrl = url.searchParams.get('eshopUrl');

  try {
    const tokenResult = await exchangeAuthorizationCode({
      code,
      eshopUrl,
      redirectUri,
      clientId,
      clientSecret,
      fetchImpl: fetch
    });

    await saveShoptetInstallation({
      db: env.DB,
      shopId: tokenResult.eshopId,
      accessToken: tokenResult.accessToken,
      eshopUrl: tokenResult.eshopUrl,
      contactEmail: tokenResult.contactEmail
    });

    // Shoptet vyžaduje HTTP 200 OK (text/plain "OK") pro úspěšné dokončení instalace
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  } catch (err) {
    console.error("Installation failed");
    return new Response('Installation failed', {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
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
