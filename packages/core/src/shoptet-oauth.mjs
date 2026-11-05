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

  // If eshopUrl is provided, use it as origin, otherwise fallback to 826800.myshoptet.com
  let baseUrl = 'https://826800.myshoptet.com';
  if (eshopUrl) {
    try {
      baseUrl = new URL(eshopUrl).origin;
    } catch {
      baseUrl = `https://${eshopUrl}`;
    }
  }

  const tokenEndpoint = `${baseUrl}/action/ApiOAuthServer/token`;

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
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
    const errorBody = await response.text();
    throw new Error(`OAuth exchange failed (${response.status}): ${errorBody}`);
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

export async function saveShoptetInstallation({ db, shopId, accessToken, eshopUrl, contactEmail }) {
  if (!db) throw new Error('Missing database handle');
  if (!shopId) throw new Error('Missing shopId');
  if (!accessToken) throw new Error('Missing accessToken');

  // 1. Upsert into installations
  await db.prepare(`
    INSERT INTO installations (shop_id, state, updated_at)
    VALUES (?, 'active', CURRENT_TIMESTAMP)
    ON CONFLICT(shop_id) DO UPDATE SET
      state = 'active',
      updated_at = CURRENT_TIMESTAMP
  `).bind(shopId).run();

  // 2. Upsert into shoptet_oauth
  await db.prepare(`
    INSERT INTO shoptet_oauth (shop_id, oauth_access_token, eshop_url, contact_email, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(shop_id) DO UPDATE SET
      oauth_access_token = excluded.oauth_access_token,
      eshop_url = excluded.eshop_url,
      contact_email = excluded.contact_email,
      updated_at = CURRENT_TIMESTAMP
  `).bind(shopId, accessToken, eshopUrl, contactEmail).run();

  return { success: true, shopId };
}

export async function getShoptetApiAccessToken({ db, shopId, fetchImpl = fetch }) {
  if (!db) throw new Error('Missing database handle');
  if (!shopId) throw new Error('Missing shopId');

  const row = await db.prepare(`
    SELECT oauth_access_token, eshop_url
    FROM shoptet_oauth
    WHERE shop_id = ?
  `).bind(shopId).first();

  if (!row || !row.oauth_access_token) {
    throw new Error(`Shop ${shopId} is not installed or missing OAuth token`);
  }

  let baseUrl = row.eshop_url || `https://${shopId}.myshoptet.com`;
  try {
    baseUrl = new URL(baseUrl).origin;
  } catch {
    baseUrl = `https://${baseUrl}`;
  }

  const endpoint = `${baseUrl}/action/ApiOAuthServer/getAccessToken`;
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${row.oauth_access_token}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to obtain short-term API token (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return {
    apiAccessToken: data.access_token,
    expiresIn: data.expires_in
  };
}
