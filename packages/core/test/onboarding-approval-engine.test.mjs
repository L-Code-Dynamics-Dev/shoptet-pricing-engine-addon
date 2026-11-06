import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import {
  savePricelistPolicy,
  getPricelistPolicy,
  getEngineMode,
  setEngineMode,
  getLatestRecalculationPlan,
  getRecalculationPlanDetails,
  approveRecalculationPlan,
  recordWebhookEvent
} from '../src/loyalty-repository.mjs';
import {
  generateCustomerRecalculationPlan,
  executeCustomerRecalculationBatch
} from '../src/loyalty-batch-runner.mjs';
import { processOrderWebhook } from '../src/loyalty-webhook-processor.mjs';
import { saveShoptetInstallation } from '../src/shoptet-oauth.mjs';
import { createTokenVault } from '../src/token-vault.mjs';
import { digest } from '../src/crypto.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createTestD1() {
  const db = new DatabaseSync(':memory:');
  const migrationsDir = path.resolve(__dirname, '../../../migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    db.exec(sql);
  }

  return {
    sql: db,
    prepare(query) {
      const stmt = db.prepare(query);
      return {
        bind(...args) {
          return {
            async first() {
              return stmt.get(...args) || null;
            },
            async all() {
              return { results: stmt.all(...args) };
            },
            async run() {
              const info = stmt.run(...args);
              return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
            }
          };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const s of statements) {
        results.push(await s.run());
      }
      return results;
    }
  };
}

const TOKEN_KEYS = { active: 'v1', keys: { v1: 'a'.repeat(64) } };
const SHOP_ID = '826800';
const SECRET_SIGNATURE_KEY = 'test_webhook_secret_key_12345';

test('Onboarding & Approval Engine: Full 6-phase lifecycle', async () => {
  const db = createTestD1();
  const vault = createTokenVault(TOKEN_KEYS);

  // Setup shop installation
  await saveShoptetInstallation({
    db,
    shopId: SHOP_ID,
    accessToken: 'test-permanent-token',
    eshopUrl: 'https://826800.myshoptet.com/',
    tokenKeys: TOKEN_KEYS,
    installationState: 'active'
  });

  const oauthRow = await db.prepare('SELECT oauth_envelope FROM shoptet_oauth WHERE shop_id = ?').bind(SHOP_ID).first();
  const oauthSha = await digest(oauthRow.oauth_envelope);
  const webhookEnvelope = await vault.seal(SHOP_ID, 'webhook', SECRET_SIGNATURE_KEY);
  await db.prepare('INSERT INTO shop_webhook_credentials (shop_id, oauth_sha256, envelope, created_at) VALUES (?, ?, ?, unixepoch())').bind(SHOP_ID, oauthSha, webhookEnvelope).run();

  // Save policy with default engine_mode = 'installation'
  await savePricelistPolicy(db, SHOP_ID, {
    defaultPricelistId: 1,
    managedPricelistIds: [2, 3],
    protectedPricelistIds: [5],
    engineMode: 'installation'
  });

  // Verify Phase 1: Instalační režim
  assert.equal(await getEngineMode(db, SHOP_ID), 'installation');

  const tiers = [
    { name: 'VIP Bronz', percent: 5, minTurnover: 2000, pricelistId: 2 },
    { name: 'VIP Stříbro', percent: 10, minTurnover: 5000, pricelistId: 3 }
  ];

  const policy = {
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
  };

  // Mock Shoptet adapter
  let patchCalls = 0;
  const customers = [
    {
      guid: 'cust-1-regular',
      priceList: { id: 1, name: 'Hlavní' },
      priceRatio: '1.0000',
      billingAddress: { fullName: 'Jan Novák' },
      accounts: [{ email: 'novak@example.cz' }]
    },
    {
      guid: 'cust-2-vip-eligible',
      priceList: { id: 1, name: 'Hlavní' },
      priceRatio: '1.0000',
      billingAddress: { fullName: 'Petra Svobodová' },
      accounts: [{ email: 'svobodova@example.cz' }]
    },
    {
      guid: 'cust-3-b2b',
      priceList: { id: 5, name: 'B2B Speciál' }, // protected pricelist 5
      priceRatio: '1.0000',
      billingAddress: { fullName: 'Velkoobchod s.r.o.' },
      accounts: [{ email: 'b2b@example.cz' }]
    }
  ];

  const ordersByCustomer = {
    'cust-1-regular': [
      {
        code: 'ORD-101',
        customerGuid: 'cust-1-regular',
        status: { id: -3 },
        paid: true,
        creationTime: '2026-05-01T10:00:00Z',
        changeTime: '2026-05-01T10:00:00Z',
        price: { currencyCode: 'CZK', withVat: '1000.00', withoutVat: '826.45' },
        items: []
      }
    ],
    'cust-2-vip-eligible': [
      {
        code: 'ORD-201',
        customerGuid: 'cust-2-vip-eligible',
        status: { id: -3 },
        paid: true,
        creationTime: '2026-06-01T10:00:00Z',
        changeTime: '2026-06-01T10:00:00Z',
        price: { currencyCode: 'CZK', withVat: '6000.00', withoutVat: '4958.68' },
        items: []
      }
    ],
    'cust-3-b2b': []
  };

  const adapter = {
    async list(kind, { page = 1 } = {}) {
      if (page === 1) return { items: customers, pagination: { pageCount: 1 } };
      return { items: [], pagination: { pageCount: 1 } };
    },
    async customer(guid) {
      return customers.find(c => c.guid === guid);
    },
    async customerOrders(guid) {
      return { items: (ordersByCustomer[guid] || []).map(o => ({ code: o.code })) };
    },
    async order(code) {
      for (const list of Object.values(ordersByCustomer)) {
        const found = list.find(o => o.code === code);
        if (found) return found;
      }
      throw new Error('order_not_found');
    },
    async updateCustomerPricelist(guid, targetId) {
      patchCalls++;
      const c = customers.find(x => x.guid === guid);
      if (c) c.priceList = { id: targetId, name: 'Ceník ' + targetId };
      return { outcome: 'accepted', customerGuid: guid, pricelistId: targetId, verified: true };
    }
  };

  // --- Phase 1: Test that webhooks in 'installation' mode do NOT patch customers ---
  const webhookEvent = {
    eshopId: 826800,
    event: 'order:update',
    eventInstance: 'ORD-201',
    eventCreated: new Date().toISOString()
  };
  const bodyBytes = new TextEncoder().encode(JSON.stringify(webhookEvent));
  const sigHmac = crypto.createHmac('sha1', SECRET_SIGNATURE_KEY);
  sigHmac.update(bodyBytes);
  const signature = sigHmac.digest('hex');

  const webhookResult = await processOrderWebhook({
    db,
    tokenKeys: TOKEN_KEYS,
    bytes: bodyBytes,
    signature,
    adapter,
    policy,
    tiers,
    mode: 'staging' // Because engine_mode === 'installation'
  });

  assert.equal(webhookResult.accepted, true);
  assert.equal(webhookResult.queuedForReconciliation, true);
  assert.equal(patchCalls, 0, 'Zero writes during installation mode!');

  // Check event was queued for reconciliation
  const queuedEvents = await db.prepare('SELECT state, mode FROM loyalty_webhook_events WHERE shop_id = ?').bind(SHOP_ID).first();
  assert.equal(queuedEvents.state, 'queued_for_reconciliation');
  assert.equal(queuedEvents.mode, 'staging');

  // --- Phase 2 & 3: Hromadná analýza zákazníků & Dry Run ---
  const dryRunPlan = await generateCustomerRecalculationPlan({
    db,
    shopId: SHOP_ID,
    adapter,
    policy,
    tiers
  });

  assert.equal(dryRunPlan.state, 'draft');
  assert.equal(dryRunPlan.totalCustomers, 3);
  assert.equal(dryRunPlan.changesNeeded, 1, 'Only cust-2 needs promotion to VIP Stříbro (turnover 6000 >= 5000)');
  assert.equal(dryRunPlan.b2bSkipped, 1, 'cust-3 is protected B2B');
  assert.equal(dryRunPlan.noChangeCount, 1, 'cust-1 has turnover 1000 (< 2000), remains on default');
  assert.equal(patchCalls, 0, 'Dry Run executed ZERO live writes!');
  assert.equal(await getEngineMode(db, SHOP_ID), 'dry_run_ready');

  // --- Phase 4: Schvalovací obrazovka (Review Plan Details) ---
  const planDetails = await getRecalculationPlanDetails(db, SHOP_ID, dryRunPlan.planId);
  assert.equal(planDetails.plan.plan_id, dryRunPlan.planId);
  assert.equal(planDetails.items.length, 3);

  const cust2Item = planDetails.items.find(i => i.customer_guid === 'cust-2-vip-eligible');
  assert.equal(cust2Item.customer_name, 'Petra Svobodová');
  assert.equal(cust2Item.customer_email, 'svobodova@example.cz');
  assert.equal(cust2Item.current_pricelist_id, 1);
  assert.equal(cust2Item.target_pricelist_id, 3); // VIP Stříbro
  assert.equal(cust2Item.status, 'ready_to_patch');

  // Ensure batch runner refuses to execute unapproved plan
  await assert.rejects(
    executeCustomerRecalculationBatch({ db, shopId: SHOP_ID, planId: dryRunPlan.planId, adapter }),
    /plan_not_approved/
  );

  // --- Phase 5: Schválená synchronizace ---
  const approvalRes = await approveRecalculationPlan(db, SHOP_ID, dryRunPlan.planId);
  assert.equal(approvalRes.state, 'approved');
  assert.equal(await getEngineMode(db, SHOP_ID), 'approved');

  const execRes = await executeCustomerRecalculationBatch({
    db,
    shopId: SHOP_ID,
    planId: dryRunPlan.planId,
    adapter,
    batchSize: 50
  });

  assert.equal(execRes.completedInThisBatch, 1);
  assert.equal(execRes.planCompleted, true);
  assert.equal(execRes.reconciledCount, 1, 'Staged webhook event was reconciled!');
  assert.equal(patchCalls, 1, 'Customer 2 was safely patched');
  assert.equal(customers.find(c => c.guid === 'cust-2-vip-eligible').priceList.id, 3);

  // --- Phase 6: Aktivace automatického přepočtu ---
  assert.equal(await getEngineMode(db, SHOP_ID), 'active', 'Engine is now active in live mode!');

  // Now incoming webhook runs in mode: 'live' and updates customers automatically!
  const liveWebhookEvent = {
    eshopId: 826800,
    event: 'order:update',
    eventInstance: 'ORD-LIVE-NEW',
    eventCreated: new Date().toISOString()
  };
  ordersByCustomer['cust-1-regular'].push({
    code: 'ORD-LIVE-NEW',
    customerGuid: 'cust-1-regular',
    status: { id: -3 },
    paid: true,
    creationTime: new Date().toISOString(),
    changeTime: new Date().toISOString(),
    price: { currencyCode: 'CZK', withVat: '2500.00', withoutVat: '2066.12' },
    items: []
  });

  const liveBodyBytes = new TextEncoder().encode(JSON.stringify(liveWebhookEvent));
  const liveSigHmac = crypto.createHmac('sha1', SECRET_SIGNATURE_KEY);
  liveSigHmac.update(liveBodyBytes);
  const liveSig = liveSigHmac.digest('hex');

  const policyRow = await getPricelistPolicy(db, SHOP_ID);
  const liveEngineMode = policyRow.engineMode;
  assert.equal(liveEngineMode, 'active');

  const liveResult = await processOrderWebhook({
    db,
    tokenKeys: TOKEN_KEYS,
    bytes: liveBodyBytes,
    signature: liveSig,
    adapter,
    policy,
    tiers,
    mode: liveEngineMode === 'active' ? 'live' : 'staging'
  });

  assert.equal(liveResult.accepted, true);
  assert.equal(liveResult.changed, true);
  assert.equal(liveResult.newPricelistId, 2, 'cust-1 promoted to VIP Bronz (1000 + 2500 = 3500 >= 2000)!');
  assert.equal(patchCalls, 2);
  assert.equal(customers.find(c => c.guid === 'cust-1-regular').priceList.id, 2);
});
