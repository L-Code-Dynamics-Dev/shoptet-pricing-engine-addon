import test from 'node:test';
import assert from 'node:assert/strict';
import { testD1 } from './helpers/d1.mjs';
import { handleMerchantMcp } from '../../../apps/api/src/mcp/gateway.mjs';
import { handleMcp, hashToken } from '../../../apps/api/src/mcp/server.mjs';
import { savePricelistPolicy, approveRecalculationPlan, getRecalculationPlanDetails } from '../src/loyalty-repository.mjs';
import { generateCustomerRecalculationPlan } from '../src/loyalty-batch-runner.mjs';
import { handleAdminSettingsApi } from '../../../apps/api/src/iframe-settings.mjs';
import { issueSession } from '../../../apps/api/src/admin-session.mjs';
import { createTokenVault } from '../src/token-vault.mjs';
import { digest } from '../src/crypto.mjs';

const SHOP_ID = '826800';
const TOKEN = 's'.repeat(48);

async function setupTestEnvironment() {
  const db = testD1();
  const digest = await hashToken(TOKEN);
  const tokenKeys = { active: 'key1', keys: { key1: 'f'.repeat(64) } };
  const vault = createTokenVault(tokenKeys);
  const envelope = await vault.seal(SHOP_ID, 'oauth', 'perm-test-token');

  db.sql.exec(`
    INSERT INTO installations (shop_id, state) VALUES ('${SHOP_ID}', 'active');
    INSERT INTO shoptet_oauth (shop_id, eshop_url, oauth_envelope, oauth_access_token) VALUES ('${SHOP_ID}', 'https://826800.myshoptet.com/', '${envelope}', '');
    INSERT INTO mcp_credentials (shop_id, token_sha256, scopes_json)
    VALUES ('${SHOP_ID}', '${digest}', '["shop:read","catalog:read","pricing:read","pricing:configure","customers:read"]');
  `);

  await savePricelistPolicy(db, SHOP_ID, {
    defaultPricelistId: 1,
    managedPricelistIds: [2, 3],
    protectedPricelistIds: [99],
    engineMode: 'installation'
  });

  const tenantConfig = {
    tiers: [
      { id: 't1', name: 'VIP Bronz', percent: 5, minTurnover: 1000, pricelistId: 2 },
      { id: 't2', name: 'VIP Stříbro', percent: 10, minTurnover: 5000, pricelistId: 3 }
    ],
    turnoverPolicy: {
      period: { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
      qualifyingStatusIds: [-3],
      requirePaid: true
    }
  };

  db.sql.prepare(`
    INSERT INTO tenant_settings (shop_id, config_json, version)
    VALUES (?, ?, 1)
  `).run(SHOP_ID, JSON.stringify(tenantConfig));

  let shoptetWritesCount = 0;

  const mockCustomers = [
    {
      guid: 'a0000000-0000-4000-8000-000000000001',
      billingAddress: { fullName: 'Jan Novak' },
      accounts: [{ email: 'jan.novak@example.cz' }],
      priceList: { id: 1 },
      priceRatio: '1.0000'
    },
    {
      guid: 'b0000000-0000-4000-8000-000000000002',
      billingAddress: { fullName: 'B2B Partner s.r.o.' },
      accounts: [{ email: 'objednavky@partner.cz' }],
      priceList: { id: 99 },
      priceRatio: '1.0000'
    }
  ];

  const env = {
    DB: db,
    SHOPTET_TOKEN_KEYS: tokenKeys,
    SHOPTET_CLIENT_ID: 'test-client',
    SHOPTET_CLIENT_SECRET: 'test-secret',
    ADMIN_SESSION_SECRET: 'a'.repeat(64)
  };

  // Mock global fetch to intercept Shoptet API calls
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const urlStr = String(url);
    if (urlStr.includes('/action/ApiOAuthServer/getAccessToken')) {
      return Response.json({ access_token: 'temp-token', expires_in: 1800 });
    }

    if (options.method && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(options.method.toUpperCase())) {
      shoptetWritesCount++;
      throw new Error('ILLEGAL_SHOPTET_WRITE_ATTEMPT: ' + urlStr);
    }

    if (urlStr.includes('/api/customers?')) {
      return Response.json({
        data: {
          customers: mockCustomers,
          paginator: { page: 1, pageCount: 1, totalCount: 2 }
        }
      });
    }

    if (urlStr.includes('/api/customers/a0000000-0000-4000-8000-000000000001')) {
      return Response.json({
        data: {
          customer: {
            guid: 'a0000000-0000-4000-8000-000000000001',
            customerGroup: null,
            priceList: { id: 1, name: 'Základní' },
            priceRatio: '1.0000'
          }
        }
      });
    }

    if (urlStr.includes('/api/customers/b0000000-0000-4000-8000-000000000002')) {
      return Response.json({
        data: {
          customer: {
            guid: 'b0000000-0000-4000-8000-000000000002',
            customerGroup: null,
            priceList: { id: 99, name: 'B2B Partner' },
            priceRatio: '1.0000'
          }
        }
      });
    }

    if (urlStr.includes('/api/orders?') && urlStr.includes('a0000000-0000-4000-8000-000000000001')) {
      return Response.json({
        data: {
          orders: [
            { code: 'ORD-101', changeTime: '2024-05-01T14:00:00Z' }
          ],
          paginator: { page: 1, pageCount: 1, totalCount: 1 }
        }
      });
    }

    if (urlStr.includes('/api/orders?') && urlStr.includes('b0000000-0000-4000-8000-000000000002')) {
      return Response.json({
        data: {
          orders: [],
          paginator: { page: 1, pageCount: 1, totalCount: 0 }
        }
      });
    }

    if (urlStr.includes('/api/orders/ORD-101')) {
      return Response.json({
        data: {
          order: {
            code: 'ORD-101',
            creationTime: '2024-05-01T12:00:00Z',
            changeTime: '2024-05-01T14:00:00Z',
            customerGuid: 'a0000000-0000-4000-8000-000000000001',
            status: { id: -3 },
            paid: true,
            price: { currencyCode: 'CZK', withVat: '2500.00', withoutVat: '2066.12' },
            items: [
              {
                itemType: 'product',
                status: { id: -3 },
                itemPrice: { withVat: '2500.00', withoutVat: '2066.12' }
              }
            ]
          }
        }
      });
    }

    if (urlStr.includes('/api/credit-notes')) {
      return Response.json({
        data: {
          creditNotes: [],
          paginator: { page: 1, pageCount: 1, totalCount: 0 }
        }
      });
    }

    if (urlStr.includes('/action/ApiOAuthServer/getAccessToken')) {
      return Response.json({ access_token: 'temp-token', expires_in: 1800 });
    }

    if (urlStr.includes('/api/eshop')) {
      return Response.json({
        data: {
          contactInformation: { eshopId: Number(SHOP_ID), eshopName: 'Test Shop' },
          settings: { vatPayer: true, defaultPricelist: { id: 1 }, timezone: 'Europe/Prague' },
          currencies: [{ code: 'CZK', priceDecimalPlaces: 2, rounding: 'math' }]
        }
      });
    }

    return Response.json({ data: {} });
  };

  const cleanup = () => {
    globalThis.fetch = originalFetch;
    db.sql.close();
  };

  return { db, env, cleanup, getWritesCount: () => shoptetWritesCount };
}

function createMcpRequest(method, params = {}) {
  return new Request('https://addon.example/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + TOKEN
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
}

test('MCP Loyalty: loyalty_status inspects engine mode and plan state without writes', async () => {
  const { env, cleanup, getWritesCount } = await setupTestEnvironment();
  try {
    const res = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_status',
      arguments: {}
    }), env)).json();

    assert.equal(res.result.isError, undefined);
    const content = res.result.structuredContent;
    assert.equal(content.engineMode, 'installation');
    assert.equal(content.defaultPricelistId, 1);
    assert.deepEqual(content.managedPricelists, [2, 3]);
    assert.deepEqual(content.protectedPricelists, [99]);
    assert.equal(content.hasPlan, false);
    assert.equal(getWritesCount(), 0);
  } finally {
    cleanup();
  }
});

test('MCP Loyalty: loyalty_dry_run calculates proposed tiers with zero Shoptet writes', async () => {
  const { db, env, cleanup, getWritesCount } = await setupTestEnvironment();
  try {
    const res = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_dry_run',
      arguments: {}
    }), env)).json();

    assert.equal(res.result.isError, undefined);
    const content = res.result.structuredContent;
    assert.equal(content.mode, 'dry_run');
    assert.equal(content.state, 'draft');
    assert.equal(content.writesApplied, false);
    assert.equal(content.totalCustomers, 2);
    assert.equal(content.changesNeeded, 1); // Customer 1 qualifies for VIP Bronz (id 2)
    assert.equal(content.b2bSkipped, 1); // Customer 2 is on protected B2B pricelist 99
    assert.ok(content.planId);

    // Verify engine mode transitioned to dry_run_ready in D1
    const policyRow = db.sql.prepare('SELECT engine_mode FROM loyalty_pricelist_policies WHERE shop_id = ?').get(SHOP_ID);
    assert.equal(policyRow.engine_mode, 'dry_run_ready');

    // Verify ZERO writes occurred against Shoptet
    assert.equal(getWritesCount(), 0);
  } finally {
    cleanup();
  }
});

test('MCP Loyalty: loyalty_inspect_plan sanitizes customer PII (masks email & name)', async () => {
  const { env, cleanup } = await setupTestEnvironment();
  try {
    // 1. Run dry run to create plan
    await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_dry_run',
      arguments: {}
    }), env);

    // 2. Inspect plan
    const res = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_inspect_plan',
      arguments: { limit: 10 }
    }), env)).json();

    assert.equal(res.result.isError, undefined);
    const content = res.result.structuredContent;
    assert.equal(content.plan.state, 'draft');
    assert.equal(content.itemsSample.length, 2);

    const cust1 = content.itemsSample.find(x => x.customerGuid === 'a0000000-0000-4000-8000-000000000001');
    assert.ok(cust1);
    assert.equal(cust1.targetPricelistId, 2);
    assert.equal(cust1.status, 'ready_to_patch');
    // Verify customer privacy: no plain customer email or phone leaked
    assert.doesNotMatch(JSON.stringify(content), /jan\.novak@example\.cz/);
    assert.doesNotMatch(JSON.stringify(content), /objednavky@partner\.cz/);
  } finally {
    cleanup();
  }
});

test('MCP Loyalty: loyalty_request_approval signals pending approval and forbids agent approval', async () => {
  const { env, cleanup } = await setupTestEnvironment();
  try {
    // 1. Run dry run
    const dryRunRes = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_dry_run',
      arguments: {}
    }), env)).json();
    const planId = dryRunRes.result.structuredContent.planId;

    // 2. Request approval
    const res = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_request_approval',
      arguments: { planId }
    }), env)).json();

    assert.equal(res.result.isError, undefined);
    const content = res.result.structuredContent;
    assert.equal(content.planId, planId);
    assert.equal(content.canAgentApprove, false);
    assert.equal(content.canAgentExecute, false);
    assert.equal(content.requiresMerchantApproval, true);
    assert.match(content.instructions, /administraci/);
  } finally {
    cleanup();
  }
});

test('MCP Security: AI Agent is strictly forbidden from direct pricelist modifications', async () => {
  const { env, cleanup } = await setupTestEnvironment();
  try {
    // 1. loyalty_approve must NOT exist as a tool
    const toolsRes = await (await handleMerchantMcp(createMcpRequest('tools/list', {}), env)).json();
    const toolNames = toolsRes.result.tools.map(t => t.name);
    assert.equal(toolNames.includes('loyalty_approve'), false);
    assert.equal(toolNames.includes('loyalty_sync'), false);

    // 2. Attempting to call loyalty_approve or loyalty_sync fails closed
    const approveCall = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_approve',
      arguments: { planId: '11111111-1111-1111-1111-111111111111' }
    }), env)).json();
    assert.ok(approveCall.error || approveCall.result?.isError);

    // 3. Attempting to call shoptet_sync_tier_price in JSON-RPC server is explicitly forbidden
    const legacyReq = new Request('https://addon.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + TOKEN
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: 'shoptet_sync_tier_price',
          arguments: {
            pricelistId: 2,
            items: [{ code: 'SKU-1', baseMinor: 10000, tierPercent: 10, vatRate: '21.00' }]
          }
        }
      })
    });
    const syncRes = await (await handleMcp(legacyReq, env)).json();
    assert.equal(syncRes.error.code, -32603);
    assert.match(syncRes.error.message, /forbidden/i);
  } finally {
    cleanup();
  }
});

test('MCP Security: Responses and error messages never leak tokens, envelopes or internal paths', async () => {
  const { env, cleanup } = await setupTestEnvironment();
  try {
    // 1. Normal tool outputs do not leak secrets
    const statusRes = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_status',
      arguments: {}
    }), env)).json();
    const statusText = JSON.stringify(statusRes);
    assert.doesNotMatch(statusText, /permanent-secret|temp-token|oauth_envelope|f{32,}/i);

    // 2. Error responses sanitize internal paths and tokens
    const badPlanCall = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_request_approval',
      arguments: { planId: '00000000-0000-0000-0000-000000000000' }
    }), env)).json();
    assert.equal(badPlanCall.result.isError, true);
    assert.equal(badPlanCall.result.structuredContent.error, 'plan_not_found');
    assert.doesNotMatch(JSON.stringify(badPlanCall), /\/Users\/|[a-f0-9]{32,64}/);
  } finally {
    cleanup();
  }
});

test('Regression 1: Dry Run paginates customer orders across pages and accounts for credit notes', async () => {
  const db = testD1();
  try {
    db.sql.exec(`
      INSERT INTO installations (shop_id, state) VALUES ('${SHOP_ID}', 'active');
    `);

    await savePricelistPolicy(db, SHOP_ID, {
      defaultPricelistId: 1,
      managedPricelistIds: [2, 3],
      protectedPricelistIds: [99],
      engineMode: 'installation'
    });

    const tenantConfig = {
      tiers: [
        { id: 't1', name: 'VIP Bronz', percent: 5, minTurnover: 3000, pricelistId: 2 },
        { id: 't2', name: 'VIP Stříbro', percent: 10, minTurnover: 5000, pricelistId: 3 }
      ],
      turnoverPolicy: {
        period: { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
        qualifyingStatusIds: [-3],
        requirePaid: true,
        shipping: 'exclude',
        billing: 'exclude',
        discounts: 'after_discounts',
        vat: 'inclusive',
        refunds: 'exclude_order_with_valid_credit_note',
        guestCustomers: 'exclude',
        itemStatuses: 'require_match_order',
        upgrades: 'recalculate',
        downgrades: 'keep_current'
      }
    };
    db.sql.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1)').run(SHOP_ID, JSON.stringify(tenantConfig));

    const pagedCalls = [];
    const testCustGuid = 'c0000000-0000-4000-8000-000000000001';
    const mockAdapter = {
      creditNotes: async ({ page = 1 } = {}) => {
        pagedCalls.push(`creditNotes:page:${page}`);
        if (page === 1) {
          return { items: [{ code: 'CN-101' }], pagination: { page: 1, pageCount: 1, totalCount: 1 } };
        }
        return { items: [], pagination: { page: 2, pageCount: 1, totalCount: 1 } };
      },
      creditNote: async (code) => {
        return {
          code,
          isValid: true,
          orderCode: 'ORD-PAGE-1',
          customer: { guid: testCustGuid },
          creationTime: '2024-05-01T12:00:00Z'
        };
      },
      list: async (kind, { page = 1 } = {}) => {
        if (kind === 'customers') {
          if (page === 1) {
            return {
              items: [{
                guid: testCustGuid,
                billingAddress: { fullName: 'Pavel Stránkovaný' },
                accounts: [{ email: 'pavel@example.cz' }],
                priceList: { id: 1 },
                priceRatio: '1.0000'
              }],
              pagination: { page: 1, pageCount: 1, totalCount: 1 }
            };
          }
          return { items: [], pagination: { page, pageCount: 1, totalCount: 1 } };
        }
        return { items: [] };
      },
      customer: async (guid) => ({
        guid,
        priceList: { id: 1, name: 'Základní' },
        priceRatio: '1.0000'
      }),
      customerOrders: async (guid, { page = 1 } = {}) => {
        pagedCalls.push(`customerOrders:page:${page}`);
        if (page === 1) {
          return {
            items: [{ code: 'ORD-PAGE-1' }],
            pagination: { page: 1, pageCount: 2, totalCount: 2 }
          };
        }
        if (page === 2) {
          return {
            items: [{ code: 'ORD-PAGE-2' }],
            pagination: { page: 2, pageCount: 2, totalCount: 2 }
          };
        }
        return { items: [], pagination: { page, pageCount: 2, totalCount: 2 } };
      },
      order: async (code) => {
        if (code === 'ORD-PAGE-1') {
          return {
            code: 'ORD-PAGE-1',
            status: { id: -3 },
            paid: true,
            customerGuid: testCustGuid,
            creationTime: '2024-05-01T12:00:00Z',
            price: { currencyCode: 'CZK', withVat: '2000.00', withoutVat: '1652.89' },
            items: [{ status: { id: -3 }, itemPrice: { withVat: '2000.00' } }]
          };
        }
        if (code === 'ORD-PAGE-2') {
          return {
            code: 'ORD-PAGE-2',
            status: { id: -3 },
            paid: true,
            customerGuid: testCustGuid,
            creationTime: '2024-05-02T12:00:00Z',
            price: { currencyCode: 'CZK', withVat: '3500.00', withoutVat: '2892.56' },
            items: [{ status: { id: -3 }, itemPrice: { withVat: '3500.00' } }]
          };
        }
      }
    };

    const plan = await generateCustomerRecalculationPlan({
      db,
      shopId: SHOP_ID,
      adapter: mockAdapter,
      policy: tenantConfig.turnoverPolicy,
      tiers: tenantConfig.tiers
    });

    assert.ok(pagedCalls.includes('customerOrders:page:1'));
    assert.ok(pagedCalls.includes('customerOrders:page:2'));
    assert.ok(pagedCalls.includes('creditNotes:page:1'));

    const details = await getRecalculationPlanDetails(db, SHOP_ID, plan.planId);
    const targetItem = details.items.find(i => i.customer_guid === testCustGuid);
    assert.ok(targetItem);
    assert.equal(targetItem.target_pricelist_id, 2, 'Customer qualifies for VIP Bronz (3500 CZK) after ORD-PAGE-1 excluded by credit note');
  } finally {
    db.sql.close();
  }
});

test('Regression 2: Stale plan rejection upon configuration update', async () => {
  const db = testD1();
  try {
    db.sql.exec(`
      INSERT INTO installations (shop_id, state) VALUES ('${SHOP_ID}', 'active');
    `);

    await savePricelistPolicy(db, SHOP_ID, {
      defaultPricelistId: 1,
      managedPricelistIds: [2, 3],
      protectedPricelistIds: [99],
      engineMode: 'installation'
    });

    const tenantConfig = {
      tiers: [
        { id: 't1', name: 'VIP Bronz', percent: 5, minTurnover: 1000, pricelistId: 2 }
      ],
      turnoverPolicy: {
        period: { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
        qualifyingStatusIds: [-3],
        requirePaid: true
      }
    };
    db.sql.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1)').run(SHOP_ID, JSON.stringify(tenantConfig));

    const mockAdapter = {
      creditNotes: async () => ({ items: [], pagination: { page: 1, pageCount: 1, totalCount: 0 } }),
      list: async () => ({ items: [], pagination: { page: 1, pageCount: 1, totalCount: 0 } })
    };

    const plan = await generateCustomerRecalculationPlan({
      db,
      shopId: SHOP_ID,
      adapter: mockAdapter,
      policy: tenantConfig.turnoverPolicy,
      tiers: tenantConfig.tiers
    });

    const planRow = db.sql.prepare('SELECT plan_json FROM loyalty_recalculation_plans WHERE shop_id = ? AND plan_id = ?').get(SHOP_ID, plan.planId);
    const planMeta = JSON.parse(planRow.plan_json);
    assert.equal(planMeta.configVersion, 1);
    assert.ok(planMeta.configSha256);

    // Modify configuration to increment version
    db.sql.prepare('UPDATE tenant_settings SET version = 2 WHERE shop_id = ?').run(SHOP_ID);

    // Approval must fail closed with plan_stale_configuration_changed
    await assert.rejects(
      approveRecalculationPlan(db, SHOP_ID, plan.planId),
      /plan_stale_configuration_changed/
    );
  } finally {
    db.sql.close();
  }
});

test('Regression 3: Admin settings API sanitizes errors into human-readable Czech messages', async () => {
  const { env, cleanup } = await setupTestEnvironment();
  try {
    const envelope = env.DB.sql.prepare('SELECT oauth_envelope FROM shoptet_oauth WHERE shop_id = ?').get(SHOP_ID)?.oauth_envelope;
    const session = await issueSession(SHOP_ID, env.ADMIN_SESSION_SECRET, undefined, envelope ? await digest(envelope) : undefined);

    // 1. Non-existent plan
    const nonExistentReq = new Request('https://addon.example/admin/settings/api/loyalty/approve', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + session,
        origin: 'https://addon.example',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ planId: 'plan-does-not-exist' })
    });
    const res1 = await handleAdminSettingsApi(nonExistentReq, env);
    assert.equal(res1.status, 409);
    const body1 = await res1.json();
    assert.equal(body1.error, 'plan_not_found');
    assert.equal(body1.message, 'Plán přepočtu nebyl nalezen.');
    assert.equal(body1.stack, undefined);
    assert.doesNotMatch(JSON.stringify(body1), /(?:\.js|\.mjs):\d+:\d+|\b(?:Traceback|at\s+\w+)\b/);

    // 2. Stale plan rejection via admin API
    const dryRunRes = await (await handleMerchantMcp(createMcpRequest('tools/call', {
      name: 'loyalty_dry_run',
      arguments: {}
    }), env)).json();
    const planId = dryRunRes.result.structuredContent.planId;

    // Simulate config update in DB
    env.DB.sql.prepare('UPDATE tenant_settings SET version = version + 1 WHERE shop_id = ?').run(SHOP_ID);

    const staleReq = new Request('https://addon.example/admin/settings/api/loyalty/approve', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + session,
        origin: 'https://addon.example',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ planId })
    });
    const res2 = await handleAdminSettingsApi(staleReq, env);
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.error, 'plan_stale_configuration_changed');
    assert.equal(body2.message, 'Konfigurace pravidel nebo ceníků se od vytvoření plánu změnila. Vygenerujte prosím nový kontrolní Dry Run.');
    assert.equal(body2.stack, undefined);
    assert.doesNotMatch(JSON.stringify(body2), /(?:\.js|\.mjs):\d+:\d+|\b(?:Traceback|at\s+\w+)\b/);
  } finally {
    cleanup();
  }
});

test('Regression 4: sync_execute allows dry-run without approval, but strictly requires approvalId and pricing:execute in live mode', async () => {
  const { db, env, cleanup } = await setupTestEnvironment();
  try {
    const syncToken = 'y'.repeat(48);
    const syncTokenSha256 = await hashToken(syncToken);
    db.sql.prepare(`
      INSERT INTO mcp_credentials (shop_id, token_sha256, scopes_json)
      VALUES (?, ?, ?)
    `).run(SHOP_ID, syncTokenSha256, JSON.stringify(['sync:execute', 'pricing:read']));

    const createSyncMcpReq = (args) => new Request('https://addon.example/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + syncToken
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'sync_execute', arguments: args }
      })
    });

    const testPlanId = '11111111-1111-4111-8111-111111111111';

    // 1. Live mode WITHOUT approvalId -> must fail with approval_required_for_live_sync
    const liveNoApproval = await (await handleMerchantMcp(createSyncMcpReq({
      planId: testPlanId,
      mode: 'live'
    }), env)).json();
    assert.equal(liveNoApproval.result?.isError, true);
    assert.equal(liveNoApproval.result?.structuredContent?.error, 'approval_required_for_live_sync');

    // 2. Live mode WITH approvalId but WITHOUT pricing:execute scope -> must fail with pricing_execute_scope_required
    const liveNoScope = await (await handleMerchantMcp(createSyncMcpReq({
      planId: testPlanId,
      mode: 'live',
      approvalId: '22222222-2222-4222-8222-222222222222'
    }), env)).json();
    assert.equal(liveNoScope.result?.isError, true);
    assert.equal(liveNoScope.result?.structuredContent?.error, 'pricing_execute_scope_required');

    // 3. Dry-run mode -> allowed without approvalId and without pricing:execute scope
    const dryRunCall = await (await handleMerchantMcp(createSyncMcpReq({
      planId: testPlanId,
      mode: 'dry-run'
    }), env)).json();
    assert.equal(dryRunCall.result?.isError, true);
    // Fails at coordinator level because sync coordinator isn't configured in test env, but passed approval checks!
    assert.notEqual(dryRunCall.result?.structuredContent?.error, 'approval_required_for_live_sync');
    assert.notEqual(dryRunCall.result?.structuredContent?.error, 'pricing_execute_scope_required');
    assert.equal(dryRunCall.result?.structuredContent?.error, 'sync_coordinator_not_configured');
  } finally {
    cleanup();
  }
});
