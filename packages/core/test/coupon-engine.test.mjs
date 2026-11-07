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

  // Base 100 EUR, Tier 95 EUR, Floor 80 EUR -> 80/95 = 0.84210... -> 0.842
  assert.equal(formatPriceRatio(8000, 9500), '0.842');

  // Floor >= Tier -> 1.000 (no room for discount)
  assert.equal(formatPriceRatio(9000, 9000), '1.000');
  assert.equal(formatPriceRatio(9500, 9000), '1.000');

  // Floor 0 -> 0.000
  assert.equal(formatPriceRatio(0, 9000), '0.000');
});

test('FÁZE 2: normalizeCouponPolicy - defaults and configurable locked tiers', () => {
  const standard = normalizeCouponPolicy();
  assert.equal(standard.mode, 'percent-ceiling');
  assert.equal(standard.ceilingPercent, 20);
  assert.equal(standard.defaultPricelistId, 1);

  // Custom per-shop configuration with locked tiers (e.g. ZR20/ZR25)
  const shopConfig = normalizeCouponPolicy({
    mode: 'fixed-amount',
    lockedPricelistIds: [26, 29],
    lockedTierNames: ['ZR20', 'ZR25']
  });
  assert.equal(shopConfig.mode, 'fixed-amount');
  assert.ok(shopConfig.lockedPricelistIds.has(26));
  assert.ok(shopConfig.lockedPricelistIds.has(29));
  assert.ok(shopConfig.lockedTierNames.has('ZR20'));
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
  // Ratio = 8500 / 9000 = 0.9444... -> 0.944
  const capped = evaluateCouponSettings({
    mode: 'percent-ceiling',
    ceilingPercent: 20,
    productCap: 15,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(capped.applyDiscountCoupon, true);
  assert.equal(capped.minPriceRatio, '0.944');
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
  // Floor = 85.00 EUR -> ratio 8500 / 9000 = 0.944
  const capped = evaluateCouponSettings({
    mode: 'fixed-amount',
    productCap: 15,
    baseMinor: 10000,
    tierPriceMinor: 9000
  });
  assert.equal(capped.applyDiscountCoupon, true);
  assert.equal(capped.minPriceRatio, '0.944');
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
  assert.equal(parsePercentBps('12.345'), 1235n); // rounded half-up to bps
  assert.equal(parsePercentBps(100), 10000n);

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
  // Ratio: 8800 / 9500 = 0.9263... -> 0.926
  assert.equal(hierarchyResult.applyDiscountCoupon, true);
  assert.equal(hierarchyResult.minPriceRatio, '0.926');

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
  // Floor is raised to 8500. Ratio: 8500 / 9000 = 0.944
  assert.equal(protectedFloor.applyDiscountCoupon, true);
  assert.equal(protectedFloor.minPriceRatio, '0.944');

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
