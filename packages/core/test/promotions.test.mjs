import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidDateString,
  isPromotionActive,
  validateProductPromotion,
  validateBrandPromotion,
  resolveScheduledPromotionActionMinor
} from '../src/promotions.mjs';

test('promotions: isValidDateString strictly validates YYYY-MM-DD', () => {
  assert.equal(isValidDateString('2026-11-07'), true);
  assert.equal(isValidDateString('2026-02-28'), true);
  assert.equal(isValidDateString('2026-02-29'), false); // not a leap year
  assert.equal(isValidDateString('2026-13-01'), false);
  assert.equal(isValidDateString('07-11-2026'), false);
  assert.equal(isValidDateString('2026/11/07'), false);
  assert.equal(isValidDateString(''), false);
  assert.equal(isValidDateString(null), false);
});

test('promotions: isPromotionActive respects date windows (from-to)', () => {
  // 1. No window -> always active
  assert.equal(isPromotionActive({}), true);

  // Reference now: 2026-11-07T12:00:00Z
  const now = new Date('2026-11-07T12:00:00.000Z');

  // 2. Active window
  assert.equal(isPromotionActive({ validFrom: '2026-11-01', validTo: '2026-11-10', now }), true);

  // 3. Before window
  assert.equal(isPromotionActive({ validFrom: '2026-11-08', validTo: '2026-11-15', now }), false);

  // 4. After window
  assert.equal(isPromotionActive({ validFrom: '2026-10-01', validTo: '2026-11-06', now }), false);

  // 5. Boundary tests (exact start day at 00:00:00Z and end day until 23:59:59.999Z)
  assert.equal(isPromotionActive({ validFrom: '2026-11-07', validTo: '2026-11-07', now: new Date('2026-11-07T00:00:00.000Z') }), true);
  assert.equal(isPromotionActive({ validFrom: '2026-11-07', validTo: '2026-11-07', now: new Date('2026-11-07T23:59:59.000Z') }), true);
  assert.equal(isPromotionActive({ validFrom: '2026-11-07', validTo: '2026-11-07', now: new Date('2026-11-08T00:00:01.000Z') }), false);

  // 6. Invalid dates throw
  assert.throws(() => isPromotionActive({ validFrom: 'invalid', now }), /Neplatné datum/);
  assert.throws(() => isPromotionActive({ validFrom: '2026-11-10', validTo: '2026-11-05', now }), /Datum začátku akce/);
});

test('promotions: validateProductPromotion and validateBrandPromotion sanitize merchant inputs', () => {
  // Valid product promo
  const pValid = validateProductPromotion({ code: 'SKU-100', discountPercent: 20, validFrom: '2026-11-01', validTo: '2026-11-30' });
  assert.equal(pValid.error, undefined);
  assert.equal(pValid.item.code, 'SKU-100');
  assert.equal(pValid.item.discountPercent, 20);

  // Invalid discount percent
  const pInvalidPct = validateProductPromotion({ code: 'SKU-100', discountPercent: 0 });
  assert.match(pInvalidPct.error, /0,01–99,99 %/);

  // Invalid inverted period
  const pInverted = validateProductPromotion({ code: 'SKU-100', discountPercent: 15, validFrom: '2026-12-01', validTo: '2026-11-01' });
  assert.match(pInverted.error, /nesmí být po datu konce/);

  // Valid brand promo
  const bValid = validateBrandPromotion({ brand: 'Delphin', discountPercent: 15, validFrom: '2026-11-01', validTo: '2026-12-31' });
  assert.equal(bValid.error, undefined);
  assert.equal(bValid.item.brand, 'Delphin');
  assert.equal(bValid.item.discountPercent, 15);
});

test('promotions: resolveScheduledPromotionActionMinor synthesizes action prices and respects HighestDiscountPolicy', () => {
  const baseMinor = 10000; // 100.00 EUR
  const now = new Date('2026-11-07T12:00:00.000Z');

  const productPromotions = [
    { code: 'SKU-CLEARANCE', discountPercent: 30, validFrom: '2026-11-01', validTo: '2026-11-30' },
    { code: 'SKU-EXPIRED', discountPercent: 50, validFrom: '2026-10-01', validTo: '2026-10-31' }
  ];

  const brandPromotions = [
    { brand: 'Mivardi', discountPercent: 10, validFrom: '2026-11-01', validTo: '2026-11-30' }
  ];

  // 1. Active product clearance: 30% off base 10000 -> 7000
  const promoMinor = resolveScheduledPromotionActionMinor({
    baseMinor,
    code: 'SKU-CLEARANCE',
    brand: 'Mivardi',
    productPromotions,
    brandPromotions,
    now
  });
  assert.equal(promoMinor, 7000);

  // 2. Expired product clearance falls back to active brand promotion (10% off -> 9000)
  const expiredPromoMinor = resolveScheduledPromotionActionMinor({
    baseMinor,
    code: 'SKU-EXPIRED',
    brand: 'Mivardi',
    productPromotions,
    brandPromotions,
    now
  });
  assert.equal(expiredPromoMinor, 9000);

  // 3. No active promotion returns null
  const noPromoMinor = resolveScheduledPromotionActionMinor({
    baseMinor,
    code: 'SKU-OTHER',
    brand: 'OtherBrand',
    productPromotions,
    brandPromotions,
    now
  });
  assert.equal(noPromoMinor, null);
});

test('promotions: reconcilePrices dynamically applies scheduled product and brand promotions', async () => {
  const { reconcilePrices } = await import('../src/reconciliation-runner.mjs');

  const now = new Date('2026-11-07T12:00:00.000Z');
  const tiers = [
    { pricelistId: 2, name: 'ZR10', percent: 10 }
  ];

  // Base price: 1000 CZK (100000 minor)
  // Tier ZR10 (10%): normal loyalty price would be 900 CZK (90000 minor)
  // Active Clearance (20% off): action price = 800 CZK (80000 minor)
  // Under OKfish rules with cap=null and action=800 CZK: min(800 CZK, 900 CZK) = 800 CZK (80000 minor).
  const products = [
    {
      guid: 'prod-1',
      brand: 'Delphin',
      visibility: 'normal',
      variants: [
        {
          code: 'PROMO-CLEARANCE-1',
          visible: true,
          basePriceMinor: 100000,
          perPricelistPrices: {
            2: { priceMinor: 80000 } // matches expected action price!
          }
        }
      ]
    }
  ];

  const adapter = {
    isFullCatalogVerified: () => true,
    catalogProducts: async () => ({
      items: products,
      pagination: { totalPages: 1 }
    })
  };

  const policy = {
    now,
    scheduledPromotions: [
      { code: 'PROMO-CLEARANCE-1', discountPercent: 20, validFrom: '2026-11-01', validTo: '2026-11-30' }
    ]
  };

  const report = await reconcilePrices({
    shopId: 100,
    adapter,
    tiers,
    catalogProducts: products,
    policy,
    fullCatalogVerified: true,
    minExpectedCombinations: 1
  });

  assert.equal(report.selfCheckPassed, true);
  assert.equal(report.counts.total, 1);
  assert.equal(report.counts.match, 1);
  assert.equal(report.counts.drift, 0);
  assert.equal(report.drifts.length, 0);

  // 2. Active brand promotion: 25% off on Delphin brand
  const brandProducts = [
    {
      guid: 'prod-2',
      brand: 'Delphin',
      visibility: 'normal',
      variants: [
        {
          code: 'PROMO-BRAND-1',
          visible: true,
          basePriceMinor: 100000,
          perPricelistPrices: {
            2: { priceMinor: 75000 } // 25% off base 100000 -> 75000
          }
        }
      ]
    }
  ];

  const brandReport = await reconcilePrices({
    shopId: 100,
    adapter,
    tiers,
    catalogProducts: brandProducts,
    policy: {
      now,
      brandPromotions: [
        { brand: 'Delphin', discountPercent: 25, validFrom: '2026-11-01', validTo: '2026-11-30' }
      ]
    },
    fullCatalogVerified: true,
    minExpectedCombinations: 1
  });

  assert.equal(brandReport.selfCheckPassed, true);
  assert.equal(brandReport.counts.match, 1);
  assert.equal(brandReport.counts.drift, 0);

  // 3. Expired promotion: does not apply, regular loyalty tier price (10% off -> 90000) applies
  const expiredReport = await reconcilePrices({
    shopId: 100,
    adapter,
    tiers,
    catalogProducts: products,
    policy: {
      now,
      scheduledPromotions: [
        { code: 'PROMO-CLEARANCE-1', discountPercent: 20, validFrom: '2026-10-01', validTo: '2026-10-31' }
      ]
    },
    fullCatalogVerified: true,
    minExpectedCombinations: 1
  });

  // Expected price is 90000 (normal tier), but actual in store was 80000 -> DRIFT detected!
  assert.equal(expiredReport.counts.drift, 1);
  assert.equal(expiredReport.drifts[0].reason, 'price_mismatch');
  assert.equal(expiredReport.drifts[0].expected, 90000);
  assert.equal(expiredReport.drifts[0].actual, 80000);
});

test('promotions: buildSyncPlan (PRICE-005) applies scheduled product clearance and brand promotions with time windows', async () => {
  const { syncFixture, BRAND } = await import('./helpers/sync-fixture.mjs');
  const f = await syncFixture({
    scheduledPromotions: [
      { code: 'TEST/A', discountPercent: 25, validFrom: '2020-01-01', validTo: '2099-12-31' }
    ],
    brandPromotions: [
      { brand: BRAND, discountPercent: 15, validFrom: '2020-01-01', validTo: '2099-12-31' }
    ]
  });
  try {
    const p = await f.plan();
    // TEST/A has 25% scheduled clearance -> 75.00 (overrides 5% loyalty tier and 15% brand promo)
    assert.equal(p.plan.actions[0].code, 'TEST/A');
    assert.equal(p.plan.actions[0].expected.price, '75.00');
    assert.equal(p.plan.actions[0].calculation.source, 'sale');
    // TEST/B has no SKU clearance, inherits 15% active brand promo -> 85.00 (overrides 5% loyalty tier)
    assert.equal(p.plan.actions[1].code, 'TEST/B');
    assert.equal(p.plan.actions[1].expected.price, '85.00');
    assert.equal(p.plan.actions[1].calculation.source, 'sale');
  } finally {
    f.db.sql.close();
  }
});
