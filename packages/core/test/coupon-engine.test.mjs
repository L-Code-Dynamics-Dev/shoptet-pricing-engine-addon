import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPriceRatio,
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
