import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPriceRatio,
  parsePercentBps,
  resolveCapBps,
  normalizeCouponPolicy,
  evaluateCouponSettings,
  createPricelistCouponPatch
} from '../src/coupon-engine.mjs';

test('FÁZE 2: formatPriceRatio - exact 3-decimal places relative to tier price', () => {
  // Base 100 EUR, Tier 90 EUR, Floor 80 EUR -> 80/90 = 0.88888... -> 0.889
  assert.equal(formatPriceRatio(8000, 9000), '0.889');

  // Base 100 EUR, Tier 95 EUR, Floor 80 EUR -> 80/95 = 0.84210... -> 0.843 (CEILING)
  assert.equal(formatPriceRatio(8000, 9500), '0.843');

  // Floor >= Tier -> 1.000 (no room for discount)
  assert.equal(formatPriceRatio(9000, 9000), '1.000');
  assert.equal(formatPriceRatio(9500, 9000), '1.000');

  // Floor 0 -> 0.000
  assert.equal(formatPriceRatio(0, 9000), '0.000');
});

test('FÁZE 2: normalizeCouponPolicy - defaults and configurable locked tiers', () => {
  // Fail closed without authenticated main pricelist ID
  assert.throws(() => normalizeCouponPolicy(), /Missing or invalid authenticated shop-scoped default\/main pricelist ID/);
  assert.throws(() => normalizeCouponPolicy({ defaultPricelistId: 0 }), /Missing or invalid authenticated shop-scoped default\/main pricelist ID/);

  const standard = normalizeCouponPolicy({ defaultPricelistId: 1 });
  assert.equal(standard.mode, 'percent-ceiling');
  assert.equal(standard.ceilingPercent, 20);
  assert.equal(standard.defaultPricelistId, 1);
  assert.equal(standard.mainPricelistId, 1);

  // Custom per-shop configuration with locked tiers (e.g. ZR20/ZR25)
  const shopConfig = normalizeCouponPolicy({
    defaultPricelistId: 17,
    managedPricelistIds: [1, 2, 3],
    mode: 'fixed-amount',
    lockedPricelistIds: [26, 29],
    lockedTierNames: ['ZR20', 'ZR25']
  });
  assert.equal(shopConfig.mode, 'fixed-amount');
  assert.equal(shopConfig.ceilingPercent, null);
  assert.equal(shopConfig.defaultPricelistId, 17);
  assert.deepEqual(shopConfig.managedPricelistIds, [1, 2, 3]);
  assert.ok(shopConfig.lockedPricelistIds.has(26));
  assert.ok(shopConfig.lockedPricelistIds.has(29));
  assert.ok(shopConfig.lockedTierNames.has('ZR20'));

  assert.throws(
    () => normalizeCouponPolicy({ defaultPricelistId: 17, mode: 'percent-ceiling', ceilingPercent: null }),
    /Missing or invalid ceilingPercent for percent-ceiling mode/
  );
});

test('FÁZE 2: percent-ceiling mode rules and ratio relative to tier price', () => {
  // Base 100.00 EUR (10000 minor)
  // Tier ZR10 (10% discount): tierPrice = 90.00 EUR (9000 minor)
  // Ceiling = 20%: floor price = 80.00 EUR (8000 minor)
  // Ratio relative to tier price: 8000 / 9000 = 0.889
  const zr10 = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(zr10.applyDiscountCoupon, true);
  assert.equal(zr10.minPriceRatio, '0.889');
  assert.equal(zr10.reason, 'ceiling_headroom');

  // Tier ZR20 (20% discount): tierPrice = 80.00 EUR (8000 minor)
  // Ceiling = 20%: floor price = 80.00 EUR. Tier already exhausted ceiling!
  const zr20 = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    baseMinor: 10000,
    tierPriceMinor: 8000
  });
  assert.equal(zr20.applyDiscountCoupon, false);
  assert.equal(zr20.minPriceRatio, null);
  assert.equal(zr20.reason, 'ceiling_exhausted_by_tier');

  // Product with product cap 15% on ZR10 (9000 minor)
  // Effective ceiling = min(20%, 15%) = 15%: floor = 85.00 EUR (8500 minor)
  // Ratio = ceil(8500 / 9000) = 0.945 (never breaches floor 8500)
  const capped = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    productCap: 15,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(capped.applyDiscountCoupon, true);
  assert.equal(capped.minPriceRatio, '0.945');
});

test('FÁZE 2: fixed-amount mode - essential distinctions (TRANSFER_RULES.md)', () => {
  // 1. Tier lock -> coupon OFF
  const locked = evaluateCouponSettings({
    mode: 'fixed-amount',
    isLocked: true,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(locked.applyDiscountCoupon, false);
  assert.equal(locked.minPriceRatio, null);
  assert.equal(locked.reason, 'tier_locked');

  // 2. Manual coupon disable -> coupon OFF
  const manualOff = evaluateCouponSettings({
    mode: 'fixed-amount',
    manualCouponDisabled: true,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(manualOff.applyDiscountCoupon, false);
  assert.equal(manualOff.minPriceRatio, null);

  // 3. Explicit zero cap -> coupon ON with zero remaining room (ratio 1.000)
  // Note: applyDiscountCoupon=true with ratio=1.000 is NOT equivalent to false!
  const zeroCap = evaluateCouponSettings({
    mode: 'fixed-amount',
    productCap: 0,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(zeroCap.applyDiscountCoupon, true);
  assert.equal(zeroCap.minPriceRatio, '1.000');
  assert.equal(zeroCap.reason, 'explicit_zero_cap');

  // 4. Sale / clearance action -> coupon ON with zero remaining room (ratio 1.000)
  const saleItem = evaluateCouponSettings({
    mode: 'fixed-amount',
    hasActiveSale: true,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(saleItem.applyDiscountCoupon, true);
  assert.equal(saleItem.minPriceRatio, '1.000');
  assert.equal(saleItem.reason, 'sale_action_floor');

  // 5. Capped product (cap 15%, base 100 EUR, tier 90 EUR)
  // Floor = 85.00 EUR -> ratio ceil(8500 / 9000) = 0.945
  const capped = evaluateCouponSettings({
    mode: 'fixed-amount',
    productCap: 15,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(capped.applyDiscountCoupon, true);
  assert.equal(capped.minPriceRatio, '0.945');
  assert.equal(capped.reason, 'cap_constrained');

  // 6. Unrestricted product -> coupon ON, no ratio floor
  const unrestricted = evaluateCouponSettings({
    mode: 'fixed-amount',
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(unrestricted.applyDiscountCoupon, true);
  assert.equal(unrestricted.minPriceRatio, null);
  assert.equal(unrestricted.reason, 'unrestricted');
});

test('FÁZE 2: INC-003 regression - coupon patch strictly forbids modifying main pricelist', () => {
  // Writing to tier pricelist ID 2 is allowed
  const validPatch = createPricelistCouponPatch({
    targetPricelistId: 2,
    defaultPricelistId: 1,
    code: 'PROD-1',
    applyDiscountCoupon: true,
    minPriceRatio: '0.889'
  });
  assert.deepEqual(validPatch, {
    code: 'PROD-1',
    sales: {
      discountCoupon: true,
      minPriceRatio: '0.889'
    }
  });

  // INC-003: Attempting to modify main pricelist ID 1 MUST throw
  assert.throws(
    () => createPricelistCouponPatch({
      targetPricelistId: 1,
      defaultPricelistId: 1,
      code: 'PROD-1',
      applyDiscountCoupon: false
    }),
    /main_pricelist_coupon_write_forbidden/
  );
});

test('FÁZE 2: INC-011 regression - locked tiers ZR20 and ZR25 strictly disable coupons', () => {
  const policy = normalizeCouponPolicy({
    defaultPricelistId: 1,
    mode: 'fixed-amount',
    lockedPricelistIds: [26, 29],
    lockedTierNames: ['ZR20', 'ZR25']
  });

  for (const tierId of [26, 29]) {
    const isLocked = policy.lockedPricelistIds.has(tierId);
    const evalResult = evaluateCouponSettings({
      mode: policy.mode,
      isLocked,
      baseMinor: 5000,
      tierPriceMinor: 4000
    });
    assert.equal(evalResult.applyDiscountCoupon, false);
    assert.equal(evalResult.minPriceRatio, null);
    assert.equal(evalResult.reason, 'tier_locked');
  }
});

test('Task 1: parsePercentBps handles integers, decimals, strings and invalid inputs without float rounding', () => {
  assert.equal(parsePercentBps(0), 0n);
  assert.equal(parsePercentBps(10), 1000n);
  assert.equal(parsePercentBps(12.5), 1250n);
  assert.equal(parsePercentBps('12.5'), 1250n);
  assert.equal(parsePercentBps('12.35'), 1235n);
  assert.equal(parsePercentBps(100), 10000n);

  // Precision excess (>2 decimal places) throws
  assert.throws(() => parsePercentBps(12.345), /Invalid percent/);
  assert.throws(() => parsePercentBps('12.345'), /Invalid percent/);

  // Invalid inputs throw range or type errors
  assert.throws(() => parsePercentBps(NaN), /Invalid percent/);
  assert.throws(() => parsePercentBps(Infinity), /Invalid percent/);
  assert.throws(() => parsePercentBps(-1), /Invalid percent/);
  assert.throws(() => parsePercentBps(101), /Invalid percent/);
  assert.throws(() => parsePercentBps('not-a-number'), /Invalid percent/);
});

test('Task 2: resolveCapBps and evaluateCouponSettings cap precedence (hierarchy vs most_restrictive)', () => {
  // Product 12%, Brand 8%, Category 5%
  // In hierarchy mode: productCap (12%) wins
  const hierarchyResult = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    capPriority: 'hierarchy',
    productCap: 12,
    brandCap: 8,
    categoryCap: 5,
    baseMinor: 10000,
    tierPriceMinor: 9500
  });
  // Effective cap: min(20%, 12%) = 12% -> floor = 8800
  // Ratio: ceil(8800 / 9500) = 0.927
  assert.equal(hierarchyResult.applyDiscountCoupon, true);
  assert.equal(hierarchyResult.minPriceRatio, '0.927');

  // In most_restrictive mode: min(12%, 8%, 5%) = 5% wins
  const mostRestrictiveResult = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    capPriority: 'most_restrictive',
    productCap: 12,
    brandCap: 8,
    categoryCap: 5,
    baseMinor: 10000,
    tierPriceMinor: 9600
  });
  // Effective cap: min(20%, 5%) = 5% -> floor = 9500
  // Ratio: 9500 / 9600 = 0.9895... -> 0.990
  assert.equal(mostRestrictiveResult.applyDiscountCoupon, true);
  assert.equal(mostRestrictiveResult.minPriceRatio, '0.990');
});

test('Task 3: minimumMinor margin floor protects against coupon discount breaches', () => {
  // Base 10000, Tier 9000, Ceiling 20% (would be floor 8000)
  // But configured minimumMinor (cost + margin) is 8500
  const protectedFloor = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    minimumMinor: 8500,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  // Floor is raised to 8500. Ratio: ceil(8500 / 9000) = 0.945 (never breaches floor 8500)
  assert.equal(protectedFloor.applyDiscountCoupon, true);
  assert.equal(protectedFloor.minPriceRatio, '0.945');

  // P1 BLOCKER REGRESSION: formatPriceRatio(8500, 9000) must equal '0.945'
  // Effective post-coupon price: 9000 * 0.945 = 8505 >= 8500
  assert.equal(formatPriceRatio(8500, 9000), '0.945');

  // If tier price is already at or below minimumMinor, coupons MUST be disabled entirely
  const exhaustedMinimum = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    minimumMinor: 9000,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(exhaustedMinimum.applyDiscountCoupon, false);
  assert.equal(exhaustedMinimum.minPriceRatio, null);
  assert.equal(exhaustedMinimum.reason, 'minimum_floor_exhausted');
});

test('TASK B: formatPriceRatio boundary test vectors and ceiling proof', () => {
  // floor 8500, tier 9000 -> 0.945
  assert.equal(formatPriceRatio(8500, 9000), '0.945');
  // tiny positive floor (1 cent) on tier 9000 -> 0.001
  assert.equal(formatPriceRatio(1, 9000), '0.001');
  // floor near tier (8999 vs 9000) -> 1.000
  assert.equal(formatPriceRatio(8999, 9000), '1.000');
  // floor equal tier -> 1.000
  assert.equal(formatPriceRatio(9000, 9000), '1.000');
  // zero floor -> 0.000
  assert.equal(formatPriceRatio(0, 9000), '0.000');
});

test('TASK D: resolveCapBps categoryCaps array validation and multiple categories', () => {
  // Valid multiple categoryCaps
  const cap = resolveCapBps({ categoryCaps: [15, 8, '12.5'], priority: 'most_restrictive' });
  assert.equal(cap, 800n);

  // Hierarchy mode with categoryCaps fallback
  const hier = resolveCapBps({ productCap: null, brandCap: null, categoryCaps: [10, 5], priority: 'hierarchy' });
  assert.equal(hier, 500n);

  // Invalid categoryCaps elements throw
  assert.throws(() => resolveCapBps({ categoryCaps: [NaN] }), /Invalid categoryCap/);
  assert.throws(() => resolveCapBps({ categoryCaps: [{}] }), /Invalid categoryCap/);
  assert.throws(() => resolveCapBps({ categoryCaps: 'not-array' }), /categoryCaps must be an array/);
});

test('TASK H: Coupon-mode parity and boundary invariants', () => {
  // 1. Guest tier immunity to tier locks (TRANSFER_RULES.md / INC-011)
  const guestResult = evaluateCouponSettings({
    mode: 'fixed-amount',
    isLocked: true,
    isGuest: true, // Guest tier overrides isLocked
    baseMinor: 10000,
    tierPriceMinor: 10000
  });
  assert.equal(guestResult.applyDiscountCoupon, true);
  assert.equal(guestResult.reason, 'unrestricted');

  // 2. Explicit zero cap (0% limit) distinction between fixed-amount and percent-ceiling
  // Fixed-amount: coupon ON with zero remaining room (ratio 1.000)
  const fixedZeroCap = evaluateCouponSettings({
    mode: 'fixed-amount',
    productCap: 0,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(fixedZeroCap.applyDiscountCoupon, true);
  assert.equal(fixedZeroCap.minPriceRatio, '1.000');
  assert.equal(fixedZeroCap.reason, 'explicit_zero_cap');

  // Percent-ceiling: product disallows discounts entirely -> coupon OFF (Rule 1)
  const percentZeroCap = evaluateCouponSettings({
    mode: 'percent-ceiling',
    productCap: 0,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(percentZeroCap.applyDiscountCoupon, false);
  assert.equal(percentZeroCap.minPriceRatio, null);
  assert.equal(percentZeroCap.reason, 'zero_discount_cap');

  // 3. Active sale / clearance price behavior
  // Fixed-amount: active sale takes precedence -> coupon ON with zero room (ratio 1.000)
  const fixedSale = evaluateCouponSettings({
    mode: 'fixed-amount',
    actionPriceMinor: 8500,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(fixedSale.applyDiscountCoupon, true);
  assert.equal(fixedSale.minPriceRatio, '1.000');
  assert.equal(fixedSale.reason, 'sale_action_floor');

  // Percent-ceiling: sale already meets or exceeds ceiling (e.g. 20% sale on 20% ceiling) -> coupon OFF
  const percentSaleExhausted = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    actionPriceMinor: 8000, // 20% sale -> floor 8000
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(percentSaleExhausted.applyDiscountCoupon, false);
  assert.equal(percentSaleExhausted.minPriceRatio, null);
  assert.equal(percentSaleExhausted.reason, 'ceiling_exhausted_by_sale');

  // Percent-ceiling: sale deeper than ceiling (e.g. 30% sale) -> coupon OFF
  const percentDeeperSale = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    actionPriceMinor: 7000,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(percentDeeperSale.applyDiscountCoupon, false);
  assert.equal(percentDeeperSale.minPriceRatio, null);
  assert.equal(percentDeeperSale.reason, 'ceiling_exhausted_by_sale');
});

test('TASK 3: createPricelistCouponPatch strictly validates 0..1 minPriceRatio boundary', () => {
  // Valid ratios: 0.000, 1.000, 0.889, null
  const patchZero = createPricelistCouponPatch({
    targetPricelistId: 2,
    defaultPricelistId: 1,
    code: 'SKU-1',
    applyDiscountCoupon: true,
    minPriceRatio: '0.000'
  });
  assert.equal(patchZero.sales.minPriceRatio, '0.000');

  const patchOne = createPricelistCouponPatch({
    targetPricelistId: 2,
    defaultPricelistId: 1,
    code: 'SKU-1',
    applyDiscountCoupon: true,
    minPriceRatio: '1.000'
  });
  assert.equal(patchOne.sales.minPriceRatio, '1.000');

  const patchMid = createPricelistCouponPatch({
    targetPricelistId: 2,
    defaultPricelistId: 1,
    code: 'SKU-1',
    applyDiscountCoupon: true,
    minPriceRatio: '0.889'
  });
  assert.equal(patchMid.sales.minPriceRatio, '0.889');

  // Invalid ratios: > 1.000 (e.g. 2.000, 9.999), negative, wrong decimals
  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 2, defaultPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true, minPriceRatio: '2.000' }),
    /Invalid minPriceRatio/
  );

  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 2, defaultPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true, minPriceRatio: '9.999' }),
    /Invalid minPriceRatio/
  );

  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 2, defaultPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true, minPriceRatio: '-0.100' }),
    /Invalid minPriceRatio/
  );

  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 2, defaultPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true, minPriceRatio: '1.001' }),
    /Invalid minPriceRatio/
  );

  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 2, defaultPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true, minPriceRatio: '0.88' }),
    /Invalid minPriceRatio/
  );
});

test('TASK A: authenticated shop-scoped main ID=17 and managed tier ID=1 regression', () => {
  // Missing or non-positive main ID fails closed
  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 1, code: 'SKU-1', applyDiscountCoupon: true }),
    /Missing or invalid authenticated default\/main pricelist ID/
  );
  assert.throws(
    () => createPricelistCouponPatch({ targetPricelistId: 1, defaultPricelistId: 0, code: 'SKU-1', applyDiscountCoupon: true }),
    /Missing or invalid authenticated default\/main pricelist ID/
  );

  // Main ID = 17, managed tiers = [1, 2, 3]
  // 1) Writing to managed tier ID 1 succeeds (never falsely rejected as main ID)
  const patchTier1 = createPricelistCouponPatch({
    targetPricelistId: 1,
    mainPricelistId: 17,
    managedPricelistIds: [1, 2, 3],
    code: 'SKU-1',
    applyDiscountCoupon: true,
    minPriceRatio: '0.889'
  });
  assert.equal(patchTier1.code, 'SKU-1');
  assert.equal(patchTier1.sales.discountCoupon, true);
  assert.equal(patchTier1.sales.minPriceRatio, '0.889');

  // 2) Writing to main ID 17 strictly throws main_pricelist_coupon_write_forbidden
  assert.throws(
    () => createPricelistCouponPatch({
      targetPricelistId: 17,
      mainPricelistId: 17,
      managedPricelistIds: [1, 2, 3],
      code: 'SKU-1',
      applyDiscountCoupon: true
    }),
    /main_pricelist_coupon_write_forbidden/
  );

  // 3) Writing to unmanaged tier ID 99 throws unmanaged_tier_pricelist_coupon_write_forbidden
  assert.throws(
    () => createPricelistCouponPatch({
      targetPricelistId: 99,
      mainPricelistId: 17,
      managedPricelistIds: [1, 2, 3],
      code: 'SKU-1',
      applyDiscountCoupon: true
    }),
    /unmanaged_tier_pricelist_coupon_write_forbidden/
  );
});
