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
  // Unknown or corrupt combinations MUST fail self-check even if minExpectedCombinations met
  assert.equal(result.selfCheckPassed, false);
  assert.match(result.selfCheckReason, /corrupt_or_duplicate_data_detected/);

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
              sales: { discountCoupon: true, minPriceRatio: '0.945' } // MATCH (floor 8500 / 9000 = ceil 0.945)
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

test('P2: Self-check fails on single UNKNOWN with cardinality 1, and consistent minimumMinor resolution', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP', percent: 20, pricelistId: 2 }];

  // 1. Single UNKNOWN with minimum cardinality 1 must fail self-check
  const unknownSingle = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-unknown-single',
        visibility: 'normal',
        variants: [{ code: 'U-1', visible: true, basePriceMinor: 0 }] // Corrupted base
      }
    ],
    minExpectedCombinations: 1
  });
  assert.equal(unknownSingle.counts.unknown, 1);
  assert.equal(unknownSingle.selfCheckPassed, false);
  assert.match(unknownSingle.selfCheckReason, /corrupt_or_duplicate_data_detected/);

  // 2. Global minimumMinor vs per-product override in price reconciliation
  const priceRecon = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    policy: { minimumMinor: 8000 }, // Global min 80.00
    catalogProducts: [
      {
        guid: 'prod-global',
        visibility: 'normal',
        variants: [{
          code: 'GLOBAL-MIN',
          visible: true,
          basePriceMinor: 10000,
          perPricelistPrices: { 2: { priceMinor: 8000 } } // Tier 20% -> 8000, matches global min
        }]
      },
      {
        guid: 'prod-override',
        visibility: 'normal',
        minimumMinor: 8500, // Per-product override 85.00
        variants: [{
          code: 'OVERRIDE-MIN',
          visible: true,
          basePriceMinor: 10000,
          perPricelistPrices: { 2: { priceMinor: 8500 } } // Clamped to 8500 by product override
        }]
      }
    ],
    minExpectedCombinations: 2
  });
  assert.equal(priceRecon.counts.match, 2);
  assert.equal(priceRecon.selfCheckPassed, true);

  // 3. Global minimumMinor vs per-product override in coupon reconciliation
  const couponRecon = await reconcileCoupons({
    adapter: {},
    shopId,
    tiers,
    couponConfig: { mode: 'percent-ceiling', ceilingPercent: 30, minimumMinor: 8000 },
    catalogProducts: [
      {
        guid: 'prod-coupon-global',
        visibility: 'normal',
        variants: [{
          code: 'COUPON-GLOBAL',
          visible: true,
          basePriceMinor: 10000,
          perPricelistPrices: {
            2: {
              priceMinor: 8000,
              // Floor is 8000, tier is 8000 -> ratio 1.000 or disabled if exhausted
              sales: { discountCoupon: false, minPriceRatio: null }
            }
          }
        }]
      },
      {
        guid: 'prod-coupon-override',
        visibility: 'normal',
        minimumMinor: 8500, // Product override
        variants: [{
          code: 'COUPON-OVERRIDE',
          visible: true,
          basePriceMinor: 10000,
          perPricelistPrices: {
            2: {
              priceMinor: 9000,
              // Floor is 8500, tier is 9000 -> ceil(8500/9000) = 0.945
              sales: { discountCoupon: true, minPriceRatio: '0.945' }
            }
          }
        }]
      }
    ],
    minExpectedCombinations: 2
  });
  assert.equal(couponRecon.counts.match, 2);
  assert.equal(couponRecon.selfCheckPassed, true);
});

test('TASK E: Reconciliation runner detects missing variant code as UNKNOWN and fails self-check', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP', percent: 10, pricelistId: 2 }];

  // Price reconciliation with missing variant code
  const priceResult = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-no-code',
        visibility: 'normal',
        variants: [{ code: null, visible: true, basePriceMinor: 1000 }]
      }
    ],
    minExpectedCombinations: 1
  });
  assert.equal(priceResult.counts.unknown, 1);
  assert.equal(priceResult.selfCheckPassed, false);
  const drift = priceResult.drifts.find(d => d.reason === 'missing_variant_code');
  assert.ok(drift);
  assert.equal(drift.status, 'UNKNOWN');

  // Coupon reconciliation with empty variant code
  const couponResult = await reconcileCoupons({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-empty-code',
        visibility: 'normal',
        variants: [{ code: '   ', visible: true, basePriceMinor: 1000 }]
      }
    ],
    minExpectedCombinations: 1
  });
  assert.equal(couponResult.counts.unknown, 1);
  assert.equal(couponResult.selfCheckPassed, false);
  const couponDrift = couponResult.drifts.find(d => d.reason === 'missing_variant_code');
  assert.ok(couponDrift);
});

test('TASK 1: Audit conflict reproducer - manual action price below margin floor cannot be MATCH', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP-10', percent: 10, pricelistId: 2 }];

  // Reproducer candidate: base=10000, action=8000, tier=10%, minimum=9000, stored=8000
  const result = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-conflict',
        visibility: 'normal',
        variants: [
          {
            code: 'SKU-CONFLICT',
            visible: true,
            basePriceMinor: 10000,
            actionPriceMinor: 8000,
            minimumMinor: 9000,
            perPricelistPrices: {
              2: { priceMinor: 8000 } // Stored matches action price, but violates margin floor 9000
            }
          }
        ]
      }
    ],
    minExpectedCombinations: 1
  });

  // Must NOT classify as MATCH! Safety conflict must surface as UNKNOWN and fail self-check.
  assert.equal(result.counts.match, 0);
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.selfCheckPassed, false);
  const conflict = result.drifts.find(d => d.reason === 'manual_action_below_margin_floor');
  assert.ok(conflict);
  assert.equal(conflict.status, 'UNKNOWN');
  assert.equal(conflict.expected, 8000); // Merchant price is never raised
  assert.equal(conflict.actual, 8000);
});

test('TASK 4: Coverage trust - absent pagination metadata with fullCatalogVerified: false fails self-check', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP', percent: 10, pricelistId: 2 }];

  const result = await reconcilePrices({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-unverified',
        visibility: 'normal',
        variants: [{ code: 'SKU-UNV', visible: true, basePriceMinor: 1000, perPricelistPrices: { 2: { priceMinor: 900 } } }]
      }
    ],
    pagination: null,
    fullCatalogVerified: false, // Incomplete caller assurance without authenticated adapter proof
    minExpectedCombinations: 1
  });

  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.selfCheckReason, 'unverified_coverage_pagination_metadata_missing');
});

test('TASK 5: reconcileCoupons - missing sales field or discountCoupon fails closed to UNKNOWN', async () => {
  const shopId = 826800;
  const tiers = [{ name: 'VIP', percent: 10, pricelistId: 2 }];

  const result = await reconcileCoupons({
    adapter: {},
    shopId,
    tiers,
    catalogProducts: [
      {
        guid: 'prod-missing-sales',
        visibility: 'normal',
        variants: [
          {
            code: 'SKU-NO-SALES',
            visible: true,
            basePriceMinor: 10000,
            perPricelistPrices: {
              2: {
                priceMinor: 9000
                // sales field is completely missing!
              }
            }
          }
        ]
      }
    ],
    minExpectedCombinations: 1
  });

  // Must NOT silently default to discountCoupon: true!
  assert.equal(result.counts.unknown, 1);
  assert.equal(result.counts.match, 0);
  assert.equal(result.selfCheckPassed, false);
  const drift = result.drifts.find(d => d.reason === 'missing_sales_coupon_observation');
  assert.ok(drift);
  assert.equal(drift.status, 'UNKNOWN');
});
