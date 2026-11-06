import test from 'node:test';
import assert from 'node:assert/strict';
import {testD1} from './helpers/d1.mjs';
import {
  savePricelistPolicy,
  getPricelistPolicy,
  classifyPricelist,
  evaluateCustomerLock,
  recordOrderToLedger,
  recordRefundToLedger,
  createRecalculationPlan,
  getPendingRecalculationItems,
  updateRecalculationItemStatus,
  recordWebhookEvent,
  getQueuedWebhookReconciliationEvents
} from '../src/loyalty-repository.mjs';

async function setupShop(db, shopId = '826800') {
  await db.prepare("INSERT INTO installations (shop_id, state) VALUES (?, 'active') ON CONFLICT DO NOTHING").bind(shopId).run();
}

test('Loyalty Repository: Pricelist policy classification and fail-closed B2B protection', async () => {
  const db = testD1();
  try {
    await setupShop(db, '826800');

    // 1. Save and retrieve policy
    const policy = {
      defaultPricelistId: 1,
      managedPricelistIds: [2, 3, 4],
      protectedPricelistIds: [5, 6]
    };
    await savePricelistPolicy(db, '826800', policy);
    const retrieved = await getPricelistPolicy(db, '826800');
    assert.deepEqual(retrieved, { ...policy, engineMode: 'installation' });

    // 2. Duplicate IDs must fail schema validation
    await assert.rejects(
      savePricelistPolicy(db, '826800', {
        defaultPricelistId: 1,
        managedPricelistIds: [1, 2], // 1 is duplicate!
        protectedPricelistIds: []
      }),
      /Pricelist IDs must be unique/
    );

    // 3. Classification
    assert.equal(classifyPricelist(policy, 1), 'default');
    assert.equal(classifyPricelist(policy, 2), 'managed');
    assert.equal(classifyPricelist(policy, 3), 'managed');
    assert.equal(classifyPricelist(policy, 5), 'protected');
    assert.equal(classifyPricelist(policy, 999), 'protected'); // Unknown is fail-closed protected!
    assert.equal(classifyPricelist(policy, null), 'default');

    // 4. Customer lock evaluation
    // Unlocked standard customer on default
    assert.equal(evaluateCustomerLock({ priceList: { id: 1 }, priceRatio: '1.0000' }, policy), 'unlocked');
    // Unlocked VIP customer on managed
    assert.equal(evaluateCustomerLock({ priceList: { id: 2 }, priceRatio: '1.0000' }, policy), 'unlocked');
    // B2B locked on wholesale pricelist 5
    assert.equal(evaluateCustomerLock({ priceList: { id: 5 }, priceRatio: '1.0000' }, policy), 'b2b_locked');
    // B2B locked on unknown pricelist 88 (fail-closed)
    assert.equal(evaluateCustomerLock({ priceList: { id: 88 }, priceRatio: '1.0000' }, policy), 'b2b_locked');
    // Individual discount ratio locked
    assert.equal(evaluateCustomerLock({ priceList: { id: 1 }, priceRatio: '0.9000' }, policy), 'price_ratio_locked');
    assert.equal(evaluateCustomerLock({ priceList: { id: 2 }, priceRatio: '1.0500' }, policy), 'price_ratio_locked');
  } finally {
    db.sql.close();
  }
});

test('Loyalty Repository: Order ledger delta updates, multi-order accumulation and out-of-order protection', async () => {
  const db = testD1();
  try {
    await setupShop(db, '826800');
    const customer = '1f676f66-d9ea-11f1-a35a-bc241195dd28';

    // 1. Record qualifying order 1 (5 040.00 Kč)
    const res1 = await recordOrderToLedger(db, '826800', {
      orderCode: '2026000001',
      customerGuid: customer,
      statusId: -3,
      isPaid: true,
      currency: 'CZK',
      orderTotalMinor: 504000,
      qualifyingAmountMinor: 504000,
      orderCreatedAt: '2026-11-06T12:00:00Z',
      lastChangeTime: '2026-11-06T12:00:00Z'
    });
    assert.equal(res1.applied, true);
    assert.equal(res1.contributedTurnoverMinor, 504000);
    assert.equal(res1.customerTurnoverMinor, 504000);
    assert.equal(res1.qualifyingOrdersCount, 1);

    // 2. Out-of-order or duplicate webhook with older change time is rejected
    const staleRes = await recordOrderToLedger(db, '826800', {
      orderCode: '2026000001',
      customerGuid: customer,
      statusId: -1, // Stale status
      isPaid: false,
      currency: 'CZK',
      orderTotalMinor: 504000,
      qualifyingAmountMinor: 0,
      orderCreatedAt: '2026-11-06T12:00:00Z',
      lastChangeTime: '2026-11-06T11:59:00Z' // 1 minute older than recorded!
    });
    assert.equal(staleRes.applied, false);
    assert.equal(staleRes.reason, 'stale_or_duplicate');

    // 3. Record order 2 for same customer (2 000.00 Kč) -> cumulative turnover increases to 7 040.00 Kč
    const res2 = await recordOrderToLedger(db, '826800', {
      orderCode: '2026000002',
      customerGuid: customer,
      statusId: -3,
      isPaid: true,
      currency: 'CZK',
      orderTotalMinor: 200000,
      qualifyingAmountMinor: 200000,
      orderCreatedAt: '2026-11-06T12:10:00Z',
      lastChangeTime: '2026-11-06T12:10:00Z'
    });
    assert.equal(res2.applied, true);
    assert.equal(res2.customerTurnoverMinor, 704000);
    assert.equal(res2.qualifyingOrdersCount, 2);

    // 4. Partial refund of 1 000.00 Kč on order 1 -> turnover decreases to 6 040.00 Kč
    const ref1 = await recordRefundToLedger(db, '826800', {
      orderCode: '2026000001',
      refundedAmountMinor: 100000,
      changeTime: '2026-11-06T12:30:00Z'
    });
    assert.equal(ref1.applied, true);
    assert.equal(ref1.contributedTurnoverMinor, 404000);
    assert.equal(ref1.customerTurnoverMinor, 604000);
    assert.equal(ref1.qualifyingOrdersCount, 2);

    // 5. Full remaining refund on order 1 (4 040.00 Kč) -> order 1 contribution drops to 0, count drops to 1
    const ref2 = await recordRefundToLedger(db, '826800', {
      orderCode: '2026000001',
      refundedAmountMinor: 404000,
      changeTime: '2026-11-06T12:35:00Z'
    });
    assert.equal(ref2.applied, true);
    assert.equal(ref2.contributedTurnoverMinor, 0);
    assert.equal(ref2.customerTurnoverMinor, 200000); // Only order 2 left
    assert.equal(ref2.qualifyingOrdersCount, 1);
  } finally {
    db.sql.close();
  }
});

test('Loyalty Repository: Recalculation plan checkpoints, resumability and state tracking', async () => {
  const db = testD1();
  try {
    await setupShop(db, '826800');
    const planId = 'recalc-plan-001';
    const c1 = '11111111-1111-1111-1111-111111111111';
    const c2 = '22222222-2222-2222-2222-222222222222';
    const c3 = '33333333-3333-3333-3333-333333333333';

    // 1. Create plan with 3 items
    await createRecalculationPlan(db, '826800', {
      planId,
      revisionId: 'rev-01',
      planJson: JSON.stringify({}),
      planSha256: 'sha256-dummy-hash',
      totalCustomers: 3,
      changesNeeded: 2,
      b2bSkipped: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      items: [
        { customerGuid: c1, currentPricelistId: 1, targetPricelistId: 2, calculatedTurnoverMinor: 504000, status: 'ready_to_patch' },
        { customerGuid: c2, currentPricelistId: 1, targetPricelistId: 2, calculatedTurnoverMinor: 600000, status: 'ready_to_patch' },
        { customerGuid: c3, currentPricelistId: 5, targetPricelistId: 5, calculatedTurnoverMinor: 900000, status: 'b2b_locked' }
      ]
    });

    // 2. Get pending items: only c1 and c2 should be returned (limit 50)
    let pending = await getPendingRecalculationItems(db, '826800', planId, 50);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].customer_guid, c1);
    assert.equal(pending[1].customer_guid, c2);

    // 3. Mark c1 as verified
    await updateRecalculationItemStatus(db, '826800', planId, c1, { status: 'verified' });

    // 4. Resume/restart checkpoint: only c2 should remain pending!
    pending = await getPendingRecalculationItems(db, '826800', planId, 50);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].customer_guid, c2);

    // 5. Mark c2 as uncertain (e.g. timeout during patch) -> still returned for readback retry
    await updateRecalculationItemStatus(db, '826800', planId, c2, { status: 'uncertain', errorCode: 'patch_timeout' });
    pending = await getPendingRecalculationItems(db, '826800', planId, 50);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'uncertain');

    // 6. Readback succeeds and confirms c2 -> update to verified
    await updateRecalculationItemStatus(db, '826800', planId, c2, { status: 'verified' });
    pending = await getPendingRecalculationItems(db, '826800', planId, 50);
    assert.equal(pending.length, 0); // All items completed!
  } finally {
    db.sql.close();
  }
});

test('Loyalty Repository: Tenant isolation and Webhook Staging reconciliation queue', async () => {
  const db = testD1();
  try {
    await setupShop(db, '826800');
    await setupShop(db, '999999'); // Other shop

    // 1. Tenant isolation on policies
    await savePricelistPolicy(db, '826800', { defaultPricelistId: 1, managedPricelistIds: [2], protectedPricelistIds: [3] });
    assert.equal(await getPricelistPolicy(db, '999999'), null); // Shop 999999 has no policy

    // 2. Webhook Staging queue during initial import
    const ev1 = await recordWebhookEvent(db, '826800', {
      eventHash: 'hash-order-001',
      eventType: 'order:update',
      orderCode: '2026000010',
      eventCreated: '2026-11-06T15:00:00Z',
      mode: 'staging'
    });
    assert.equal(ev1.duplicate, false);
    assert.equal(ev1.state, 'queued_for_reconciliation');

    // Duplicate webhook is rejected
    const dup = await recordWebhookEvent(db, '826800', {
      eventHash: 'hash-order-001',
      eventType: 'order:update',
      orderCode: '2026000010',
      eventCreated: '2026-11-06T15:00:00Z',
      mode: 'staging'
    });
    assert.equal(dup.duplicate, true);

    // Get queued reconciliation events for Shop 826800
    const queue826 = await getQueuedWebhookReconciliationEvents(db, '826800');
    assert.equal(queue826.length, 1);
    assert.equal(queue826[0].order_code, '2026000010');

    // Shop 999999 has empty queue (isolation)
    const queue999 = await getQueuedWebhookReconciliationEvents(db, '999999');
    assert.equal(queue999.length, 0);
  } finally {
    db.sql.close();
  }
});

test('Webhook dedupe resumes failed delivery once and reclaims stale pending delivery', async () => {
  const db = testD1();
  try {
    await setupShop(db);
    const event = {
      eventHash: 'retry-hash-001',
      eventType: 'order:update',
      orderCode: 'ORDER-RETRY-001',
      eventCreated: '2026-11-06T16:00:00Z',
      mode: 'live'
    };
    assert.equal((await recordWebhookEvent(db, '826800', event)).duplicate, false);
    assert.equal((await recordWebhookEvent(db, '826800', event)).duplicate, true);
    await db.prepare("UPDATE loyalty_webhook_events SET state='failed' WHERE shop_id=? AND event_hash=?")
      .bind('826800', event.eventHash).run();
    const retry = await recordWebhookEvent(db, '826800', event);
    assert.equal(retry.duplicate, false);
    assert.equal(retry.resumed, true);
    assert.equal((await recordWebhookEvent(db, '826800', event)).duplicate, true);
    await db.prepare("UPDATE loyalty_webhook_events SET received_at=unixepoch()-600 WHERE shop_id=? AND event_hash=?")
      .bind('826800', event.eventHash).run();
    const recovered = await recordWebhookEvent(db, '826800', event);
    assert.equal(recovered.duplicate, false);
    assert.equal(recovered.resumed, true);
  } finally { db.sql.close(); }
});
