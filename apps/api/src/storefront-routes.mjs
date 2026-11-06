import { STOREFRONT_FILE_NAMES, getStorefrontAssets } from '../../../packages/storefront/src/index.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Shop-Id',
    'cache-control': 'public, max-age=300'
  }
});

const corsOptions = () => new Response(null, {
  status: 204,
  headers: {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-Shop-Id',
    'cache-control': 'public, max-age=86400'
  }
});

let assetCache = null;
function getAssets() {
  if (!assetCache) {
    assetCache = getStorefrontAssets();
  }
  return assetCache;
}

export async function handleStorefrontRoutes(request, env) {
  if (request.method === 'OPTIONS') return corsOptions();
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const url = new URL(request.url);

  // 1. Serving storefront JavaScript assets
  if (url.pathname.startsWith('/storefront/assets/')) {
    const filename = url.pathname.slice('/storefront/assets/'.length);
    if (!STOREFRONT_FILE_NAMES.includes(filename)) {
      return json({ error: 'asset_not_found' }, 404);
    }
    const assets = getAssets();
    const content = assets[filename];
    if (!content) return json({ error: 'asset_not_found' }, 404);

    return new Response(content, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600'
      }
    });
  }

  // 2. Serving coupon configuration (/v1/coupon-config or /storefront/config)
  if (url.pathname === '/v1/coupon-config' || url.pathname === '/storefront/config') {
    const shopId = url.searchParams.get('shopId') || request.headers.get('x-shop-id');
    if (!shopId) {
      // Default / empty config if no shopId specified
      return json({
        shopId: null,
        topTiers: false,
        minPercent: null,
        lockedTiers: [],
        allTiers: []
      });
    }

    try {
      const row = await env.DB.prepare('SELECT config_json FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
      let config = {};
      if (row?.config_json) {
        try { config = JSON.parse(row.config_json); } catch {}
      }

      const tiers = Array.isArray(config.tiers) ? config.tiers : [];
      const rules = config.rules || {};

      const topTiers = rules.couponLockTopTiers !== false;
      const minPercent = rules.couponLockMinPercent != null ? Number(rules.couponLockMinPercent) : null;

      // Compute locked tiers
      const lockedTiers = [];
      if (topTiers && tiers.length > 0) {
        // Sort tiers by percent descending
        const sorted = tiers.slice().sort((a, b) => (b.percent || 0) - (a.percent || 0));
        const topCount = Math.max(1, Math.ceil(sorted.length * 0.25));
        for (let i = 0; i < topCount; i++) {
          if (sorted[i]?.name) lockedTiers.push(sorted[i].name);
        }
      }

      if (minPercent != null && minPercent > 0) {
        for (const t of tiers) {
          if (t.percent >= minPercent && !lockedTiers.includes(t.name)) {
            lockedTiers.push(t.name);
          }
        }
      }

      return json({
        shopId,
        topTiers,
        minPercent,
        lockedTiers,
        allTiers: tiers.map(t => ({ name: t.name, percent: t.percent }))
      });
    } catch {
      return json({
        shopId,
        topTiers: false,
        minPercent: null,
        lockedTiers: [],
        allTiers: []
      });
    }
  }

  return json({ error: 'not_found' }, 404);
}
