import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, handleMcpSse } from '../../apps/api/src/mcp/server.mjs';

const token = 'A'.repeat(48);
const credentials = {
  prepare(sql) {
    return {
      bind(...values) {
        return {
          async first() {
            if (sql.includes('FROM mcp_credentials')) {
              return { shop_id: 'shop-test', scopes_json: JSON.stringify([
                'installation:read', 'pricing:preview', 'shoptet:read',
                'shoptet:write', 'pricing:sync', 'assets:install'
              ]) };
            }
            if (sql.includes('FROM installations')) return { state: 'active' };
            if (sql.includes('FROM tenant_settings')) return { config_json: '{"tiers":[]}', version: 1 };
            return null;
          }
        };
      }
    };
  }
};
const env = { DB: credentials };
const call = (method, params, authorization = 'Bearer ' + token) => handleMcp(
  new Request('https://example.invalid/mcp', {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  }), env
);

test('agent tool listing contains no mutation capabilities even with legacy write scopes', async () => {
  const response = await call('tools/list', {});
  assert.equal(response.status, 200);
  const names = (await response.json()).result.tools.map(x => x.name);
  assert.deepEqual(names.sort(), ['installation_status', 'pricing_preview', 'shoptet_get_tiers'].sort());
});

test('legacy write tool cannot be called', async () => {
  for (const name of ['shoptet_sync_tier_price', 'shoptet_configure_tiers', 'frontend_assets_install']) {
    const response = await call('tools/call', { name, arguments: {} });
    assert.equal((await response.json()).error.code, -32602);
  }
});

test('query-string token is rejected', async () => {
  const response = await handleMcp(new Request('https://example.invalid/mcp?token=' + token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  }), env);
  assert.equal(response.status, 401);
});

test('legacy SSE endpoint is disabled', async () => {
  const response = await handleMcpSse();
  assert.equal(response.status, 410);
});

test('tier config does not disclose shop identifier', async () => {
  const response = await call('tools/call', { name: 'shoptet_get_tiers', arguments: {} });
  const body = JSON.stringify(await response.json());
  assert.equal(body.includes('shop-test'), false);
});
