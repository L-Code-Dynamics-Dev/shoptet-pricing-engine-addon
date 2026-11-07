import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePrices, reconcileCoupons } from '../src/reconciliation-runner.mjs';

test('FÁZE 3: reconcilePrices - detects MATCH, DRIFT, MISSING, SKIPPED and UNKNOWN', async () => {
  const shopId = 826800;
  const tiers = [
    { name: 'VIP Bronz', percent: 10, pricelistId: 2 },
    { name: 'VIP Stříbro', percent: 20, pricelistId: 3 }
  ];

  const catalogProducts = [
    {
      guid: 'prod-1-match',
      visibility: 'normal',
      variants: [
        {
          code: 'VAR-1',
          visible: true,
          basePriceMinor: 10000, // 100 EUR
          perPricelistPrices: {
            2: { priceMinor: 9000 }, // 10% off -> 90 EUR (MATCH)
            3: { priceMinor: 8000 }  // 20% off -> 80 EUR (MATCH)
          }
        }
      ]
    },
    {
      guid: 'prod-2-drift',
      visibility: 'normal',
      variants: [
        {
          code: 'VAR-2',
          visible: true,
          basePriceMinor: 10000,
          perPricelistPrices: {
            2: { priceMinor: 9500 }, // Should be 9000 -> DRIFT!
            3: null // MISSING!
          }
        }
      ]
    },
    {
      guid: 'prod-3-skipped',
      visibility: 'hidden', // Product is hidden -> SKIPPED
      variants: [
        { code: 'VAR-3', visible: true, basePriceMinor: 10000 }
      ]
    },
    {
      guid: 'prod-4-unknown',
      visibility: 'normal',
      variants: [
        { code: 'VAR-4', visible: true, basePriceMinor: 0 } // Corrupted base price -> UNKNOWN
      ]
    }
  ];

  const result = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts,
    minExpectedCombinations: 4
  });

  assert.equal(result.type, 'price');
  assert.equal(result.remediationMode, 'OFF');
  assert.equal(result.counts.match, 2);
  assert.equal(result.counts.drift, 1);
  assert.equal(result.counts.missing, 1);
  assert.equal(result.counts.skipped, 2);
  assert.equal(result.counts.unknown, 2);
  assert.equal(result.selfCheckPassed, true);

  const driftEntry = result.drifts.find(d => d.status === 'DRIFT');
  assert.equal(driftEntry.code, 'VAR-2');
  assert.equal(driftEntry.expected, 9000);
  assert.equal(driftEntry.actual, 9500);
  assert.equal(driftEntry.deltaMinor, 500);

  const missingEntry = result.drifts.find(d => d.status === 'MISSING');
  assert.equal(missingEntry.code, 'VAR-2');
  assert.equal(missingEntry.targetPricelistId, 3);
});

test('FÁZE 3: Coverage self-check guard - zero drift with insufficient coverage fails closed (INC-011, INC-012)', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP', percent: 10, pricelistId: 2 }];

  // Only 1 item checked, but expected minimum is 100
  const result = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-1',
        visibility: 'normal',
        variants: [{ code: 'V-1', visible: true, basePriceMinor: 1000, perPricelistPrices: { 2: { priceMinor: 900 } } }]
      }
    ],
    minExpectedCombinations: 100
  });

  // Zero drift alone MUST NOT mean success when coverage is insufficient!
  assert.equal(result.counts.drift, 0);
  assert.equal(result.selfCheckPassed, false);
  assert.match(result.selfCheckReason, /insufficient_coverage/);
});

test('FÁZE 3: reconcileCoupons - audits coupon settings and catches INC-011 lock violations', async () => {
  const shopId = 826800;
  const tiers = [
    { name: 'ZR10', percent: 10, pricelistId: 11 },
    { name: 'ZR20', percent: 20, pricelistId: 26 }, // Locked tier!
    { name: 'ZR25', percent: 25, pricelistId: 29 }  // Locked tier!
  ];

  const couponConfig = {
    mode: 'fixed-amount',
    lockedPricelistIds: [26, 29]
  };

  const catalogProducts = [
    {
      guid: 'prod-1',
      visibility: 'normal',
      productCap: 15,
      variants: [
        {
          code: 'SKU-A',
          visible: true,
          basePriceMinor: 10000, // 100 EUR
          perPricelistPrices: {
            11: {
              priceMinor: 9000,
              sales: { discountCoupon: true, minPriceRatio: '0.944' } // MATCH (floor 8500 / 9000 = 0.944)
            },
            26: {
              priceMinor: 8000,
              sales: { discountCoupon: false, minPriceRatio: null } // MATCH (locked tier)
            },
            29: {
              priceMinor: 7500,
              sales: { discountCoupon: true, minPriceRatio: null } // INC-011 DRIFT: Locked tier has coupon enabled!
            }
          }
        }
      ]
    }
  ];

  const result = await reconcileCoupons({
    adapter: {},
    shopId,
    couponConfig,
    tiers,
    catalogProducts,
    minExpectedCombinations: 3
  });

  assert.equal(result.type, 'coupon');
  assert.equal(result.counts.match, 2);
  assert.equal(result.counts.drift, 1);
  assert.equal(result.selfCheckPassed, true);

  const lockDrift = result.drifts.find(d => d.reason === 'INC-011_lock_violation');
  assert.ok(lockDrift);
  assert.equal(lockDrift.code, 'SKU-A');
  assert.equal(lockDrift.targetPricelistId, 29);
  assert.equal(lockDrift.expected.discountCoupon, false);
  assert.equal(lockDrift.actual.discountCoupon, true);
});

test('Task 5: Reconciliation runner validation - invalid shopId, truncated pagination and duplicate variant codes', async () => {
  const tiers = [{ name: 'VIP', percent: 10, pricelistId: 2 }];

  // 1. Invalid shopId fails closed
  await assert.rejects(
    () => reconcilePrices({ adapter: {}, shopId: 'not-a-number', tiers }),
    /Invalid shopId/
  );
  await assert.rejects(
    () => reconcileCoupons({ adapter: {}, shopId: -5, tiers }),
    /Invalid shopId/
  );

  // 2. Truncated pagination causes selfCheckPassed to fail
  const truncatedResult = await reconcilePrices({
    adapter: {},
    shopId: 826800,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-1',
        visibility: 'normal',
        variants: [{ code: 'VAR-1', visible: true, basePriceMinor: 1000, perPricelistPrices: { 2: { priceMinor: 900 } } }]
      }
    ],
    pagination: { isComplete: false },
    minExpectedCombinations: 1
  });
  assert.equal(truncatedResult.selfCheckPassed, false);
  assert.equal(truncatedResult.selfCheckReason, 'incomplete_pagination_truncated_run');

  // 3. Duplicate variant codes marked as UNKNOWN with reason 'duplicate_variant_code'
  const duplicateResult = await reconcilePrices({
    adapter: {},
    shopId: 826800,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-1',
        visibility: 'normal',
        variants: [{ code: 'DUP-1', visible: true, basePriceMinor: 1000, perPricelistPrices: { 2: { priceMinor: 900 } } }]
      },
      {
        guid: 'prod-2',
        visibility: 'normal',
        variants: [{ code: 'DUP-1', visible: true, basePriceMinor: 1000, perPricelistPrices: { 2: { priceMinor: 900 } } }]
      }
    ],
    minExpectedCombinations: 2
  });
  assert.equal(duplicateResult.counts.match, 1);
  assert.equal(duplicateResult.counts.unknown, 1);
  const dupEntry = duplicateResult.drifts.find(d => d.reason === 'duplicate_variant_code');
  assert.ok(dupEntry);
  assert.equal(dupEntry.status, 'UNKNOWN');
  assert.equal(dupEntry.code, 'DUP-1');
});
