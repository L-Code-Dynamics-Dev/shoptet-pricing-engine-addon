import { createInstallServices } from './install-services.mjs';
import { executeApprovedInstall } from '../../../../packages/core/src/approved-install.mjs';
import { deploymentPreview } from '../../../../packages/core/src/asset-deployment.mjs';
import { calculateTierPrice, resolveDiscountCap, createPricelistPricePatch } from '../../../../packages/core/src/pricing.mjs';
import { getShoptetApiAccessToken } from '../../../../packages/core/src/shoptet-oauth.mjs';

const protocol = '2025-03-26';
const publicStatus = (row) => ({ active: row?.state === 'active' });

const toolScope = {
  installation_status: 'installation:read',
  pricing_preview: 'pricing:preview',
  frontend_assets_preview: 'assets:preview',
  frontend_assets_install: 'assets:install',
  shoptet_get_info: 'shoptet:read',
  shoptet_get_products: 'shoptet:read',
  shoptet_get_tiers: 'shoptet:read',
  shoptet_configure_tiers: 'shoptet:write',
  shoptet_sync_tier_price: 'pricing:sync'
};

const definitions = [
  {
    name: 'pricing_preview',
    description: 'Preview the final customer price without applying changes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['baseMinor', 'tierPercent'],
      properties: {
        baseMinor: { type: 'integer', minimum: 0 },
        actionMinor: { type: ['integer', 'null'], minimum: 0 },
        tierPercent: { type: 'number', minimum: 0, maximum: 100 },
        productCap: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        brandCap: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        categoryCap: { type: ['number', 'null'], minimum: 0, maximum: 100 },
        code: { type: 'string', maxLength: 128 },
        vatRate: { type: 'string', pattern: '^[0-9]{1,2}\\.[0-9]{2}$' }
      }
    }
  },
  {
    name: 'frontend_assets_preview',
    description: 'Preview the approved frontend asset filenames before installation. No upload is performed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['manifest'],
      properties: {
        manifest: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'sha256'],
            properties: { name: { type: 'string' }, sha256: { type: 'string' } }
          }
        }
      }
    }
  },
  {
    name: 'frontend_assets_install',
    description: 'Install a previously approved frontend release. Requires an approval issued by the shop administrator.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['approvalId'],
      properties: { approvalId: { type: 'string', minLength: 16, maxLength: 96 } }
    }
  },
  {
    name: 'installation_status',
    description: 'Check whether the connected shop is active.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'shoptet_get_info',
    description: 'Get connected shop metadata, currencies, settings and pricelists from Shoptet API.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'shoptet_get_products',
    description: 'List products and prices from the connected Shoptet shop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        page: { type: 'integer', minimum: 1 },
        itemsPerPage: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    name: 'shoptet_get_tiers',
    description: 'Get the current loyalty tier configuration and discount caps for the connected shop.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'shoptet_configure_tiers',
    description: 'Save loyalty tier definitions, turnover limits, and margin caps for the connected shop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['tiers'],
      properties: {
        tiers: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['name', 'percent', 'minTurnover'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              percent: { type: 'number', minimum: 0, maximum: 100 },
              minTurnover: { type: 'number', minimum: 0 },
              pricelistId: { type: ['integer', 'null'] }
            }
          }
        },
        brandCaps: { type: 'object' },
        categoryCaps: { type: 'object' },
        productCaps: { type: 'object' }
      }
    }
  },
  {
    name: 'shoptet_sync_tier_price',
    description: 'Calculate and apply tier prices to a Shoptet pricelist with strict VAT rules.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['pricelistId', 'items'],
      properties: {
        pricelistId: { type: 'integer', minimum: 1 },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['code', 'baseMinor', 'tierPercent', 'vatRate'],
            properties: {
              code: { type: 'string' },
              baseMinor: { type: 'integer', minimum: 0 },
              actionMinor: { type: ['integer', 'null'], minimum: 0 },
              tierPercent: { type: 'number', minimum: 0, maximum: 100 },
              capPercent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
              vatRate: { type: 'string', pattern: '^[0-9]{1,2}\\.[0-9]{2}$' }
            }
          }
        }
      }
    }
  }
];

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});

const rpcError = (id, code, message, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);
const toolResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });
const hex = (bytes) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

export async function hashToken(token) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

async function authenticate(request, env) {
  const auth = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(auth);
  if (!match || !env.DB) return null;
  const digest = await hashToken(match[1]);
  const record = await env.DB.prepare(`
    SELECT c.shop_id, c.scopes_json
    FROM mcp_credentials c
    JOIN installations i ON i.shop_id = c.shop_id
    WHERE c.token_sha256 = ?
      AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > CURRENT_TIMESTAMP)
      AND i.state = 'active'
  `).bind(digest).first();

  if (!record) return null;
  let scopes;
  try { scopes = JSON.parse(record.scopes_json); } catch { return null; }
  if (!Array.isArray(scopes) || !scopes.every(x => typeof x === 'string')) return null;
  return { shopId: record.shop_id, scopes: new Set(scopes) };
}

function validPreview(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const allowed = new Set(['baseMinor', 'actionMinor', 'tierPercent', 'productCap', 'brandCap', 'categoryCap', 'code', 'vatRate']);
  if (Object.keys(a).some(k => !allowed.has(k))) return false;
  if (!Number.isSafeInteger(a.baseMinor) || a.baseMinor < 0 || !Number.isFinite(a.tierPercent) || a.tierPercent < 0 || a.tierPercent > 100) return false;
  if (a.actionMinor != null && (!Number.isSafeInteger(a.actionMinor) || a.actionMinor < 0)) return false;
  for (const k of ['productCap', 'brandCap', 'categoryCap']) if (a[k] != null && (!Number.isFinite(a[k]) || a[k] < 0 || a[k] > 100)) return false;
  if (a.code !== undefined && (typeof a.code !== 'string' || !a.code.trim() || a.code.length > 128)) return false;
  if (a.vatRate !== undefined && (typeof a.vatRate !== 'string' || !/^[0-9]{1,2}\.[0-9]{2}$/.test(a.vatRate))) return false;
  return (a.code === undefined) === (a.vatRate === undefined);
}

export async function handleMcp(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (request.headers.has('origin')) return json({ error: 'browser_origin_not_allowed' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'json_required' }, 415);
  
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 65536) return json({ error: 'payload_too_large' }, 413);

  const identity = await authenticate(request, env);
  if (!identity) return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });

  const raw = await request.text();
  if (raw.length > 65536) return json({ error: 'payload_too_large' }, 413);

  let rpc;
  try { rpc = JSON.parse(raw); } catch { return rpcError(null, -32700, 'Parse error'); }
  if (!rpc || Array.isArray(rpc) || typeof rpc !== 'object' || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (!('id' in rpc) && rpc.method !== 'notifications/initialized')) return rpcError(null, -32600, 'Invalid Request');
  if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });

  const id = rpc.id;
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return rpcError(null, -32600, 'Invalid id');
  if (rpc.method === 'initialize') return json({ jsonrpc: '2.0', id, result: { protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'L-Code Loyalty Pricing', version: '1.0' } } });
  if (rpc.method === 'ping') return json({ jsonrpc: '2.0', id, result: {} });

  if (rpc.method === 'tools/list') {
    return json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: definitions.filter(t => identity.scopes.has(toolScope[t.name] || 'installation:read'))
      }
    });
  }

  if (rpc.method === 'tools/call') {
    const name = rpc.params?.name;
    const args = rpc.params?.arguments ?? {};
    if (!definitions.some(t => t.name === name)) return rpcError(id, -32602, 'Unknown tool');

    const required = toolScope[name] || 'installation:read';
    if (!identity.scopes.has(required)) return rpcError(id, -32603, 'Forbidden', 403);

    // 1. Installation Status
    if (name === 'installation_status') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) return rpcError(id, -32602, 'Invalid arguments');
      const row = await env.DB.prepare('SELECT shop_id, state, created_at, updated_at FROM installations WHERE shop_id = ?').bind(identity.shopId).first();
      return json({ jsonrpc: '2.0', id, result: toolResult(publicStatus(row)) });
    }

    // 2. Pricing Preview
    if (name === 'pricing_preview') {
      if (!validPreview(args)) return rpcError(id, -32602, 'Invalid preview arguments');
      const cap = resolveDiscountCap({ productCap: args.productCap ?? null, brandCap: args.brandCap ?? null, categoryCap: args.categoryCap ?? null });
      const priceMinor = calculateTierPrice({ baseMinor: args.baseMinor, actionMinor: args.actionMinor ?? null, tierPercent: args.tierPercent, capPercent: cap });
      const result = { priceMinor, mode: 'preview', changesApplied: false };
      return json({ jsonrpc: '2.0', id, result: toolResult(result) });
    }

    // 3. Frontend Assets Preview
    if (name === 'frontend_assets_preview') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !('manifest' in args)) return rpcError(id, -32602, 'Invalid arguments');
      try { return json({ jsonrpc: '2.0', id, result: toolResult(deploymentPreview(args.manifest)) }); } catch { return rpcError(id, -32602, 'Invalid asset manifest'); }
    }

    // 4. Frontend Assets Install
    if (name === 'frontend_assets_install') {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.approvalId !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(args.approvalId)) return rpcError(id, -32602, 'Invalid arguments');
      const services = createInstallServices(env);
      if (!services) return rpcError(id, -32603, 'Installation unavailable', 503);
      try {
        const result = await executeApprovedInstall({ shopId: identity.shopId, approvalId: args.approvalId, ...services, runId: crypto.randomUUID().replaceAll('-', '') });
        return json({ jsonrpc: '2.0', id, result: toolResult(result) });
      } catch { return rpcError(id, -32603, 'Installation failed or not authorized'); }
    }

    // 5. Shoptet Get Info & Pricelists
    if (name === 'shoptet_get_info') {
      try {
        const { apiAccessToken } = await getShoptetApiAccessToken({ db: env.DB, shopId: identity.shopId, fetchImpl: fetch });
        const [eshopRes, pricelistsRes] = await Promise.all([
          fetch('https://api.myshoptet.com/api/eshop', { headers: { 'Shoptet-Access-Token': apiAccessToken, 'Content-Type': 'application/vnd.shoptet.v1.0' } }),
          fetch('https://api.myshoptet.com/api/pricelists', { headers: { 'Shoptet-Access-Token': apiAccessToken, 'Content-Type': 'application/vnd.shoptet.v1.0' } })
        ]);
        const eshop = await eshopRes.json();
        const pricelists = await pricelistsRes.json();
        return json({ jsonrpc: '2.0', id, result: toolResult({ shopId: identity.shopId, eshop: eshop.data, pricelists: pricelists.data?.pricelists || [] }) });
      } catch (err) {
        return rpcError(id, -32603, `Shoptet API error: ${err.message}`);
      }
    }

    // 6. Shoptet Get Products
    if (name === 'shoptet_get_products') {
      try {
        const { apiAccessToken } = await getShoptetApiAccessToken({ db: env.DB, shopId: identity.shopId, fetchImpl: fetch });
        const page = args.page || 1;
        const itemsPerPage = Math.min(args.itemsPerPage || 20, 50);
        const res = await fetch(`https://api.myshoptet.com/api/products?page=${page}&itemsPerPage=${itemsPerPage}`, {
          headers: { 'Shoptet-Access-Token': apiAccessToken, 'Content-Type': 'application/vnd.shoptet.v1.0' }
        });
        const data = await res.json();
        return json({ jsonrpc: '2.0', id, result: toolResult(data.data || {}) });
      } catch (err) {
        return rpcError(id, -32603, `Shoptet products error: ${err.message}`);
      }
    }

    // 7. Shoptet Get Tiers Configuration
    if (name === 'shoptet_get_tiers') {
      const row = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(identity.shopId).first();
      let config = { tiers: [], brandCaps: {}, categoryCaps: {}, productCaps: {} };
      if (row?.config_json) {
        try { config = JSON.parse(row.config_json); } catch {}
      }
      return json({ jsonrpc: '2.0', id, result: toolResult({ shopId: identity.shopId, version: row?.version || 1, config }) });
    }

    // 8. Shoptet Configure Tiers
    if (name === 'shoptet_configure_tiers') {
      if (!Array.isArray(args.tiers) || args.tiers.length === 0) return rpcError(id, -32602, 'Tiers array required');
      const payload = {
        tiers: args.tiers,
        brandCaps: args.brandCaps || {},
        categoryCaps: args.categoryCaps || {},
        productCaps: args.productCaps || {}
      };
      await env.DB.prepare(`
        INSERT INTO tenant_settings (shop_id, config_json, version)
        VALUES (?, ?, 1)
        ON CONFLICT(shop_id) DO UPDATE SET
          config_json = excluded.config_json,
          version = tenant_settings.version + 1
      `).bind(identity.shopId, JSON.stringify(payload)).run();
      return json({ jsonrpc: '2.0', id, result: toolResult({ status: 'saved', shopId: identity.shopId, tierCount: args.tiers.length }) });
    }

    // 9. Shoptet Sync Tier Price (PATCH Pricelist)
    if (name === 'shoptet_sync_tier_price') {
      if (!Number.isSafeInteger(args.pricelistId) || !Array.isArray(args.items) || args.items.length === 0) {
        return rpcError(id, -32602, 'Invalid pricelistId or empty items');
      }
      try {
        const { apiAccessToken } = await getShoptetApiAccessToken({ db: env.DB, shopId: identity.shopId, fetchImpl: fetch });
        const patches = [];
        for (const item of args.items) {
          const cap = resolveDiscountCap({ productCap: item.capPercent ?? null });
          const priceMinor = calculateTierPrice({
            baseMinor: item.baseMinor,
            actionMinor: item.actionMinor ?? null,
            tierPercent: item.tierPercent,
            capPercent: cap
          });
          patches.push(createPricelistPricePatch({
            code: item.code,
            priceMinor,
            vatRate: item.vatRate,
            includingVat: true
          }));
        }

        // Send to Shoptet API
        const patchRes = await fetch(`https://api.myshoptet.com/api/pricelists/${args.pricelistId}`, {
          method: 'PATCH',
          headers: {
            'Shoptet-Access-Token': apiAccessToken,
            'Content-Type': 'application/vnd.shoptet.v1.0'
          },
          body: JSON.stringify({ data: { prices: patches } })
        });

        const patchBody = await patchRes.text();
        return json({
          jsonrpc: '2.0',
          id,
          result: toolResult({
            pricelistId: args.pricelistId,
            itemsProcessed: patches.length,
            shoptetStatus: patchRes.status,
            applied: patchRes.ok,
            response: patchBody
          })
        });
      } catch (err) {
        return rpcError(id, -32603, `Sync error: ${err.message}`);
      }
    }
  }

  return rpcError(id, -32601, 'Method not found');
}
