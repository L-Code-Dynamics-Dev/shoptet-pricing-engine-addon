import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {testD1} from './helpers/d1.mjs';
import {createAdaptiveRateLimiter} from '../src/rate-limiter.mjs';
import {processOrderWebhook} from '../src/loyalty-webhook-processor.mjs';
import {generateCustomerRecalculationPlan, executeCustomerRecalculationBatch} from '../src/loyalty-batch-runner.mjs';
import {savePricelistPolicy, approveRecalculationPlan} from '../src/loyalty-repository.mjs';
import {saveShoptetInstallation} from '../src/shoptet-oauth.mjs';
import {createTokenVault} from '../src/token-vault.mjs';
import {digest} from '../src/crypto.mjs';

function computeSig(secret, bodyBuffer) {
  return crypto.createHmac('sha1', secret).update(bodyBuffer).digest('hex');
}

const keys = { active: 'test', keys: { test: 'a'.repeat(64) } };
const SIGNING_SECRET = 'test-signing-key-for-orders-12345';
const SHOP_ID = '826800';

async function setupShopWithWebhookCredentials(db) {
  await saveShoptetInstallation({
    db,
    shopId: SHOP_ID,
    accessToken: 'permanent-secret',
    eshopUrl: 'https://826800.myshoptet.com',
    tokenKeys: keys
  });
  const row = await db.prepare('SELECT oauth_envelope FROM shoptet_oauth WHERE shop_id=?').bind(SHOP_ID).first();
  const oauthSha = await digest(row.oauth_envelope);

  const webhookEnvelope = await createTokenVault(keys).seal(SHOP_ID, 'webhook', SIGNING_SECRET);
  await db.prepare("INSERT INTO shop_webhook_credentials (shop_id, oauth_sha256, envelope, created_at) VALUES (?, ?, ?, unixepoch()) ON CONFLICT DO NOTHING").bind(SHOP_ID, oauthSha, webhookEnvelope).run();

  await savePricelistPolicy(db, SHOP_ID, {
    defaultPricelistId: 1,
    managedPricelistIds: [2, 3],
    protectedPricelistIds: [5]
  });
}

const tiers = [
  { name: 'Standard', minTurnover: 0, pricelistId: 1 },
  { name: 'VIP 1', minTurnover: 5000, pricelistId: 2 },
  { name: 'VIP 2', minTurnover: 15000, pricelistId: 3 }
];

const policy = {
  period: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
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

test('Rate limiter: adapts to remaining budget, backs off on 429 and trips circuit breaker on consecutive errors', async () => {
  let sleptMs = 0;
  const limiter = createAdaptiveRateLimiter({
    minDelayMs: 100,
    maxDelayMs: 2000,
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 5000,
    sleep: async ms => { sleptMs += ms; }
  });

  // 1. High budget: nominal delay
  limiter.observeResponse({ status: 200, ok: true, headers: new Headers({ 'x-ratelimit-remaining': '35', 'x-ratelimit-reset': '10' }) });
  let pace = await limiter.waitBeforeNextRequest();
  assert.equal(pace.reason, 'nominal_delay');
  assert.equal(pace.waitMs, 100);

  // 2. Low budget: paces to 1s
  limiter.observeResponse({ status: 200, ok: true, headers: new Headers({ 'x-ratelimit-remaining': '8', 'x-ratelimit-reset': '5' }) });
  pace = await limiter.waitBeforeNextRequest();
  assert.equal(pace.reason, 'low_budget_pacing');
  assert.equal(pace.waitMs, 1000);

  // 3. Exhausted budget: waits reset seconds
  limiter.observeResponse({ status: 200, ok: true, headers: new Headers({ 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': '4' }) });
  pace = await limiter.waitBeforeNextRequest();
  assert.equal(pace.reason, 'exhausted_budget');
  assert.equal(pace.waitMs, 4200);

  // 4. Rate limited (429) increments failure count
  limiter.observeResponse({ status: 429, ok: false, headers: new Headers({ 'retry-after': '3' }) });
  assert.equal(limiter.consecutiveFailures, 1);
  limiter.observeResponse({ status: 429, ok: false, headers: new Headers({ 'retry-after': '3' }) });
  assert.equal(limiter.consecutiveFailures, 2);

  // 5. Third consecutive error trips circuit breaker
  limiter.observeResponse({ status: 500, ok: false, headers: new Headers() });
  assert.equal(limiter.consecutiveFailures, 3);
  assert.equal(limiter.isCircuitOpen, true);
  pace = await limiter.waitBeforeNextRequest();
  assert.equal(pace.reason, 'circuit_breaker_cooldown');
});

test('Webhook Pipeline: full flow with signature check, D1 ledger, calculation, PATCH, and readback recovery', async () => {
  const db = testD1();
  try {
    await setupShopWithWebhookCredentials(db);
    const customerGuid = '1f676f66-d9ea-11f1-a35a-bc241195dd28';

    let currentCustomerPricelistId = 1;
    let customerState = {
      guid: customerGuid,
      priceList: { id: 1, name: 'Základní ceník' },
      priceRatio: '1.0000'
    };

    let simulatePatchTimeout = false;
    let patchCalls = 0;

    const mockAdapter = {
      async order(code) {
        return {
          code,
          customerGuid,
          status: { id: -3 }, // Vyřízená
          paid: true,
          creationTime: '2026-11-06T12:00:00Z',
          changeTime: '2026-11-06T12:00:00Z',
          price: { currencyCode: 'CZK', withVat: '5040.00', withoutVat: '4165.29' },
          items: [{ itemType: 'product', itemPrice: { withVat: '5040.00', withoutVat: '4165.29' } }]
        };
      },
      async customer(guid) {
        return {
          guid,
          customerGroup: null,
          priceList: { id: currentCustomerPricelistId, name: 'Pricelist ' + currentCustomerPricelistId },
          priceRatio: '1.0000'
        };
      },
      async updateCustomerPricelist(guid, targetId) {
        patchCalls++;
        if (simulatePatchTimeout) {
          // Shoptet secretly applied the change, but worker network timed out!
          currentCustomerPricelistId = targetId;
          return { outcome: 'unknown', error: 'write_outcome_unknown', requiresReadback: true };
        }
        currentCustomerPricelistId = targetId;
        return { outcome: 'accepted', customerGuid: guid, pricelistId: targetId, verified: true };
      }
    };

    // 1. Send qualifying webhook event
    const bodyObj = {
      event: 'order:update',
      eventInstance: '2026000003',
      eshopId: Number(SHOP_ID),
      eventCreated: '2026-11-06T12:00:00Z'
    };
    const bodyBytes = Buffer.from(JSON.stringify(bodyObj));
    const sig = computeSig(SIGNING_SECRET, bodyBytes);

    const res1 = await processOrderWebhook({
      db,
      tokenKeys: keys,
      bytes: bodyBytes,
      signature: sig,
      adapter: mockAdapter,
      policy,
      tiers,
      mode: 'live'
    });

    assert.equal(res1.accepted, true);
    assert.equal(res1.changed, true);
    assert.equal(res1.newPricelistId, 2);
    assert.equal(res1.tier, 'VIP 1');
    assert.equal(res1.verified, true);
    assert.equal(patchCalls, 1);

    // 2. Duplicate webhook payload: immediately recognized and deduplicated
    const dupRes = await processOrderWebhook({
      db,
      tokenKeys: keys,
      bytes: bodyBytes,
      signature: sig,
      adapter: mockAdapter,
      policy,
      tiers,
      mode: 'live'
    });
    assert.equal(dupRes.accepted, true);
    assert.equal(dupRes.duplicate, true);
    assert.equal(patchCalls, 1); // No new patch call!

    // 3. Test readback recovery: simulate network timeout on patch, but Shoptet applied it
    simulatePatchTimeout = true;
    const bodyObj2 = {
      event: 'order:update',
      eventInstance: '2026000004',
      eshopId: Number(SHOP_ID),
      eventCreated: '2026-11-06T12:15:00Z'
    };
    const bodyBytes2 = Buffer.from(JSON.stringify(bodyObj2));
    const sig2 = computeSig(SIGNING_SECRET, bodyBytes2);

    mockAdapter.order = async code => ({
      code,
      customerGuid,
      status: { id: -3 },
      paid: true,
      creationTime: '2026-11-06T12:15:00Z',
      changeTime: '2026-11-06T12:15:00Z',
      price: { currencyCode: 'CZK', withVat: '10000.00', withoutVat: '8264.46' },
      items: [{ itemType: 'product', itemPrice: { withVat: '10000.00', withoutVat: '8264.46' } }]
    });

    const recoveryRes = await processOrderWebhook({
      db,
      tokenKeys: keys,
      bytes: bodyBytes2,
      signature: sig2,
      adapter: mockAdapter,
      policy,
      tiers,
      mode: 'live'
    });

    assert.equal(recoveryRes.accepted, true);
    assert.equal(recoveryRes.changed, true);
    assert.equal(recoveryRes.newPricelistId, 3); // VIP 2 (15 040 Kč cumulative)
    assert.equal(recoveryRes.recoveredViaReadback, true);
  } finally {
    db.sql.close();
  }
});

test('Batch Runner: Dry-Run plan generation, B2B protection, item checkpointing, and webhook reconciliation', async () => {
  const db = testD1();
  try {
    await setupShopWithWebhookCredentials(db);
    const standardCustomer = '11111111-1111-1111-1111-111111111111';
    const b2bCustomer = '22222222-2222-2222-2222-222222222222';
    const indivDiscountCustomer = '33333333-3333-3333-3333-333333333333';

    let patchesExecuted = 0;

    const mockAdapter = {
      async list(kind, { page = 1 } = {}) {
        if (kind === 'customers' && page === 1) {
          return {
            items: [
              { guid: standardCustomer, priceList: { id: 1 }, priceRatio: '1.0000' },
              { guid: b2bCustomer, priceList: { id: 5 }, priceRatio: '1.0000' }, // Ceník 5 je chráněný B2B!
              { guid: indivDiscountCustomer, priceList: { id: 1 }, priceRatio: '0.9000' } // Individuální sleva!
            ],
            pagination: { page: 1, pageCount: 1, totalCount: 3 }
          };
        }
        return { items: [], pagination: { page, pageCount: 1, totalCount: 3 } };
      },
      async customerOrders(guid) {
        if (guid === standardCustomer) {
          return { items: [{ code: 'ORDER-STD' }] };
        }
        return { items: [] };
      },
      async order(code) {
        return {
          code,
          customerGuid: standardCustomer,
          status: { id: -3 },
          paid: true,
          price: { currencyCode: 'CZK', withVat: '5500.00', withoutVat: '4545.45' },
          items: [{ itemType: 'product', status: { id: -3 }, itemPrice: { withVat: '5500.00', withoutVat: '4545.45' } }],
          creationTime: '2026-06-01T10:00:00Z',
          changeTime: '2026-06-01T10:00:00Z'
        };
      },
      async customer(guid) {
        if (guid === standardCustomer) return { guid, priceList: { id: 1 }, priceRatio: '1.0000' };
        if (guid === b2bCustomer) return { guid, priceList: { id: 5 }, priceRatio: '1.0000' };
        return { guid, priceList: { id: 1 }, priceRatio: '0.9000' };
      },
      async updateCustomerPricelist(guid, targetPricelistId) {
        patchesExecuted++;
        return { outcome: 'accepted', customerGuid: guid, pricelistId: targetPricelistId, verified: true };
      }
    };

    // 1. Generate Dry-Run Plan
    const plan = await generateCustomerRecalculationPlan({
      db,
      shopId: SHOP_ID,
      adapter: mockAdapter,
      policy,
      tiers,
      revisionId: 'rev-dry-run-001'
    });

    assert.equal(plan.totalCustomers, 3);
    assert.equal(plan.changesNeeded, 1); // Only standardCustomer needs promotion to Ceník 2
    assert.equal(plan.b2bSkipped, 1); // 1 B2B locked
    assert.equal(plan.priceRatioSkipped, 1); // 1 priceRatio locked
    assert.equal(plan.state, 'draft');
    assert.equal(patchesExecuted, 0); // Dry-run performs zero writes!

    // 2. Queue a webhook event in staging mode during import
    const stagedBody = Buffer.from(JSON.stringify({
      event: 'order:update',
      eventInstance: '2026000099',
      eshopId: Number(SHOP_ID),
      eventCreated: '2026-11-06T13:00:00Z'
    }));
    const stagedSig = computeSig(SIGNING_SECRET, stagedBody);
    const stageRes = await processOrderWebhook({
      db,
      tokenKeys: keys,
      bytes: stagedBody,
      signature: stagedSig,
      adapter: mockAdapter,
      policy,
      tiers,
      mode: 'staging'
    });
    assert.equal(stageRes.queuedForReconciliation, true);

    // 3. Approve plan and execute approved batch (Live execution)
    await approveRecalculationPlan(db, SHOP_ID, plan.planId);
    const execRes = await executeCustomerRecalculationBatch({
      db,
      shopId: SHOP_ID,
      planId: plan.planId,
      adapter: mockAdapter,
      batchSize: 10
    });

    assert.equal(execRes.completedInThisBatch, 1);
    assert.equal(execRes.remainingCount, 0);
    assert.equal(execRes.planCompleted, true);
    assert.equal(execRes.reconciledCount, 1); // Staged webhook was reconciled!
    assert.equal(patchesExecuted, 1);
  } finally {
    db.sql.close();
  }
});

test('Webhook rejects invalid monetary amounts instead of silently treating them as zero', async () => {
  const db = testD1();
  try {
    await setupShopWithWebhookCredentials(db);
    const body = Buffer.from(JSON.stringify({
      event:'order:update', eventInstance:'BAD-AMOUNT-01', eshopId:Number(SHOP_ID),
      eventCreated:'2026-11-06T17:30:00Z'
    }));
    const adapter = {
      async order(code) {
        return {
          code, customerGuid:'1f676f66-d9ea-11f1-a35a-bc241195dd28',
          status:{id:-3}, paid:true,
          creationTime:'2026-11-06T17:30:00Z', changeTime:'2026-11-06T17:30:00Z',
          price:{currencyCode:'CZK',withVat:null,withoutVat:null},
          items:[]
        };
      },
      async customer() { throw new Error('should_not_reach_customer'); }
    };
    await assert.rejects(processOrderWebhook({
      db, tokenKeys:keys, bytes:body, signature:computeSig(SIGNING_SECRET,body),
      adapter, policy, tiers, mode:'live'
    }), /order_amount_invalid/);
  } finally { db.sql.close(); }
});

test('Webhook does not acknowledge an in-progress duplicate as completed', async () => {
  const db = testD1();
  try {
    await setupShopWithWebhookCredentials(db);
    const body = Buffer.from(JSON.stringify({
      event:'order:update', eventInstance:'PENDING-01', eshopId:Number(SHOP_ID),
      eventCreated:'2026-11-06T17:45:00Z'
    }));
    const eventHash = await digest(new TextDecoder().decode(body));
    await db.prepare(`
      INSERT INTO loyalty_webhook_events
        (shop_id,event_hash,event_type,order_code,event_created,mode,state,received_at)
      VALUES (?,?,?,?,?,'live','pending',unixepoch())
    `).bind(SHOP_ID,eventHash,'order:update','PENDING-01','2026-11-06T17:45:00Z').run();
    const result = await processOrderWebhook({
      db, tokenKeys:keys, bytes:body, signature:computeSig(SIGNING_SECRET,body),
      adapter:{}, policy, tiers, mode:'live'
    });
    assert.equal(result.accepted,false);
    assert.equal(result.retryable,true);
    assert.equal(result.error,'event_still_processing');
  } finally { db.sql.close(); }
});
