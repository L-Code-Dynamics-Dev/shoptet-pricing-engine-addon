import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {calculateTurnover} from '../src/turnover.mjs';

// Helper to compute HMAC-SHA1 signature as Shoptet does
function computeShoptetSignature(secret, bodyBuffer) {
  return crypto.createHmac('sha1', secret).update(bodyBuffer).digest('hex');
}

test('Mock E2E: Webhook order:update promotes customer based on turnover and strict eligibility', async () => {
  const SECRET = 'test-webhook-signing-key-12345';
  const SHOP_ID = 826800;
  const CUSTOMER_GUID = '1f676f66-d9ea-11f1-a35a-bc241195dd28';
  
  // Tiers: Ceník 1 (0 Kč, base), Ceník 2 (5 000 Kč, VIP 1), Ceník 3 (10 000 Kč, VIP 2)
  const tiers = [
    { name: 'Standard', minTurnover: 0, pricelistId: 1 },
    { name: 'VIP 1', minTurnover: 5000, pricelistId: 2 },
    { name: 'VIP 2', minTurnover: 10000, pricelistId: 3 }
  ];

  const policy = {
    period: { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' },
    qualifyingStatusIds: [-3], // -3 = Vyřízená
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

  // Mock Shoptet API state
  const mockDb = {
    processedWebhooks: new Set(),
    customer: {
      guid: CUSTOMER_GUID,
      priceList: { id: 1, name: 'Základní ceník' },
      priceRatio: '1.0000'
    },
    orders: new Map([
      ['2026000003', {
        code: '2026000003',
        customerGuid: CUSTOMER_GUID,
        creationTime: '2026-11-06T12:00:00Z',
        changeTime: '2026-11-06T12:00:00Z',
        status: { id: -1, name: 'Nevyřízená' },
        paid: false,
        price: { currencyCode: 'CZK', withVat: '5040.00', withoutVat: '4165.29' },
        items: [
          { itemType: 'product', status: { id: -1 }, itemPrice: { withVat: '5040.00', withoutVat: '4165.29' } }
        ]
      }]
    ]),
    apiCallLog: []
  };

  // Webhook handler logic
  async function handleWebhook(rawBody, signature) {
    mockDb.apiCallLog.push({ action: 'webhook_received', length: rawBody.length });
    
    // 1. Signature check
    const expectedSig = computeShoptetSignature(SECRET, rawBody);
    if (signature !== expectedSig) {
      return { status: 403, error: 'invalid_signature' };
    }

    const payload = JSON.parse(rawBody.toString('utf-8'));
    if (payload.eshopId !== SHOP_ID) return { status: 403, error: 'shop_mismatch' };

    // 2. Idempotency check
    const eventKey = `${payload.event}:${payload.eventInstance}:${payload.eventCreated}`;
    if (mockDb.processedWebhooks.has(eventKey)) {
      return { status: 200, duplicate: true, message: 'already_processed' };
    }

    if (payload.event !== 'order:update') {
      return { status: 200, ignored: true };
    }

    // 3. Fetch order from Shoptet REST API
    mockDb.apiCallLog.push({ action: 'GET /api/orders/' + payload.eventInstance });
    const order = mockDb.orders.get(payload.eventInstance);
    if (!order) return { status: 404, error: 'order_not_found' };

    // 4. Fetch customer orders & credit notes for turnover calculation
    mockDb.apiCallLog.push({ action: 'GET /api/orders?customerGuid=' + order.customerGuid });
    const customerOrders = Array.from(mockDb.orders.values()).filter(o => o.customerGuid === order.customerGuid);

    // 5. Calculate turnover
    const result = calculateTurnover({
      customerGuid: order.customerGuid,
      currency: 'CZK',
      tiers,
      policy,
      orders: customerOrders,
      creditNotes: [],
      currentPricelistId: mockDb.customer.priceList.id
    });

    let assigned = false;
    // 6. Promote customer if eligible tier != current tier
    if (result.pricelistId && result.pricelistId !== mockDb.customer.priceList.id) {
      mockDb.apiCallLog.push({
        action: 'PATCH /api/customers/' + order.customerGuid,
        data: { priceListId: result.pricelistId }
      });
      // Update mock customer
      mockDb.customer.priceList = { id: result.pricelistId, name: result.tier };
      assigned = true;
    }

    mockDb.processedWebhooks.add(eventKey);
    return {
      status: 200,
      turnover: result.turnover,
      tier: result.tier,
      newPricelistId: mockDb.customer.priceList.id,
      assigned
    };
  }

  // TEST SCENARIO A: Order is in status -1 (Nevyřízená), paid: false
  {
    const body = Buffer.from(JSON.stringify({
      event: 'order:update',
      eventInstance: '2026000003',
      eshopId: SHOP_ID,
      eventCreated: '2026-11-06T15:00:00Z'
    }));
    const sig = computeShoptetSignature(SECRET, body);

    const res = await handleWebhook(body, sig);
    assert.equal(res.status, 200);
    assert.equal(res.turnover, '0.00'); // Unpaid / status -1 not counted!
    assert.equal(res.assigned, false);
    assert.equal(mockDb.customer.priceList.id, 1); // Remains on standard
  }

  // TEST SCENARIO B: Order changes status to -3 (Vyřízená) but paid is FALSE -> should NOT qualify because requirePaid: true
  {
    const order = mockDb.orders.get('2026000003');
    order.status = { id: -3, name: 'Vyřízená' };
    order.items[0].status = { id: -3 };
    order.paid = false;

    const body = Buffer.from(JSON.stringify({
      event: 'order:update',
      eventInstance: '2026000003',
      eshopId: SHOP_ID,
      eventCreated: '2026-11-06T15:05:00Z'
    }));
    const sig = computeShoptetSignature(SECRET, body);

    const res = await handleWebhook(body, sig);
    assert.equal(res.turnover, '0.00'); // NOT counted because paid === false
    assert.equal(res.assigned, false);
    assert.equal(mockDb.customer.priceList.id, 1);
  }

  // TEST SCENARIO C: Order is marked as paid: true with status -3 -> qualifies, reaches 5040 CZK -> auto-promotes to VIP 1 (Pricelist 2)
  {
    const order = mockDb.orders.get('2026000003');
    order.paid = true;

    const body = Buffer.from(JSON.stringify({
      event: 'order:update',
      eventInstance: '2026000003',
      eshopId: SHOP_ID,
      eventCreated: '2026-11-06T15:10:00Z'
    }));
    const sig = computeShoptetSignature(SECRET, body);

    const res = await handleWebhook(body, sig);
    assert.equal(res.turnover, '5040.00');
    assert.equal(res.tier, 'VIP 1');
    assert.equal(res.newPricelistId, 2);
    assert.equal(res.assigned, true);
    assert.equal(mockDb.customer.priceList.id, 2); // Customer is promoted!
  }

  // TEST SCENARIO D: Idempotency replay of identical webhook -> no duplicate API write
  {
    const body = Buffer.from(JSON.stringify({
      event: 'order:update',
      eventInstance: '2026000003',
      eshopId: SHOP_ID,
      eventCreated: '2026-11-06T15:10:00Z'
    }));
    const sig = computeShoptetSignature(SECRET, body);

    const patchCallsBefore = mockDb.apiCallLog.filter(c => c.action.startsWith('PATCH')).length;
    const res = await handleWebhook(body, sig);
    assert.equal(res.duplicate, true);
    const patchCallsAfter = mockDb.apiCallLog.filter(c => c.action.startsWith('PATCH')).length;
    assert.equal(patchCallsBefore, patchCallsAfter); // No extra PATCH call
  }

  // TEST SCENARIO E: Invalid signature rejected with 403
  {
    const body = Buffer.from(JSON.stringify({ event: 'order:update', eshopId: SHOP_ID }));
    const res = await handleWebhook(body, 'invalid_signature_hex');
    assert.equal(res.status, 403);
    assert.equal(res.error, 'invalid_signature');
  }
});
