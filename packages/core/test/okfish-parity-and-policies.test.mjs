import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePricing, formatApiPrice } from '../src/pricing-policy.mjs';
import { calculateTierPrice, resolveDiscountCap } from '../src/pricing.mjs';

test('okfish_compatible mode: action price has absolute precedence when cap is active', () => {
  // Base 100.00 €, Action 90.00 € (10% off), Tier 20% (would be 80.00 €), Cap 15% (would cap loyalty to 85.00 €)
  const okfishMode = evaluatePricing({
    baseMinor: 10000,
    actionMinor: 9000,
    tierPercent: 20,
    productCap: 15,
    salePolicy: 'okfish_compatible'
  });
  // In OKfish compatible mode: cap active + action price exists -> action price 90.00 € wins unconditionally
  assert.equal(okfishMode.priceMinor, 9000);
  assert.equal(okfishMode.source, 'sale');
  assert.equal(okfishMode.loyaltyApplied, false);

  // Pure pricing helper calculateTierPrice
  const helperPrice = calculateTierPrice({
    baseMinor: 10000,
    actionMinor: 9000,
    tierPercent: 20,
    capPercent: 15,
    salePolicy: 'okfish_compatible'
  });
  assert.equal(helperPrice, 9000);
});

test('lowest_price mode: cap limits loyalty and lowest price wins', () => {
  // Same inputs: Base 100.00 €, Action 90.00 €, Tier 20%, Cap 15% (capped loyalty = 85.00 €)
  const lowestPriceMode = evaluatePricing({
    baseMinor: 10000,
    actionMinor: 9000,
    tierPercent: 20,
    productCap: 15,
    salePolicy: 'lowest_price'
  });
  // In lowest_price mode: loyalty capped to 15% (85.00 €) < action 90.00 € -> 85.00 € wins!
  assert.equal(lowestPriceMode.priceMinor, 8500);
  assert.equal(lowestPriceMode.source, 'loyalty');
  assert.equal(lowestPriceMode.loyaltyApplied, true);

  const helperPrice = calculateTierPrice({
    baseMinor: 10000,
    actionMinor: 9000,
    tierPercent: 20,
    capPercent: 15,
    salePolicy: 'lowest_price'
  });
  assert.equal(helperPrice, 8500);
});

test('okfish parity: INC-004 / 2026-08-04 VAGNER incident (action steeper than cap)', () => {
  // Base 344.12 €, Action 281.67 € (18.15% discount), Product cap 10%
  // The sale price is steeper than 10% cap. It must NEVER be watered down / raised to 10% floor (309.71 €).
  const result = evaluatePricing({
    baseMinor: 34412,
    actionMinor: 28167,
    tierPercent: 25,
    productCap: 10,
    salePolicy: 'okfish_compatible'
  });
  assert.equal(result.priceMinor, 28167);
  assert.equal(result.source, 'sale');
  assert.equal(formatApiPrice(result.priceMinor), '281.67');
});

test('okfish parity: desktop-app profile sweep "product-limit-with-action-price"', () => {
  // Base 28.95 €, Action 24.61 € (15% off), Product limit 25%
  // In OKfish, for all tiers (ZR4 through ZR25), action price 24.61 is authoritative
  for (const tier of [4, 6, 8, 10, 12, 14, 16, 18, 20, 25]) {
    const okfish = evaluatePricing({
      baseMinor: 2895,
      actionMinor: 2461,
      tierPercent: tier,
      productCap: 25,
      salePolicy: 'okfish_compatible'
    });
    assert.equal(okfish.priceMinor, 2461);
    assert.equal(okfish.source, 'sale');
  }

  // In lowest_price mode:
  // Tier 4% (27.79 €) -> Action 24.61 € is lower -> 24.61 € wins
  const tier4 = evaluatePricing({
    baseMinor: 2895,
    actionMinor: 2461,
    tierPercent: 4,
    productCap: 25,
    salePolicy: 'lowest_price'
  });
  assert.equal(tier4.priceMinor, 2461);

  // Tier 25% (21.71 €) -> Loyalty 21.71 € is lower -> 21.71 € wins!
  const tier25 = evaluatePricing({
    baseMinor: 2895,
    actionMinor: 2461,
    tierPercent: 25,
    productCap: 25,
    salePolicy: 'lowest_price'
  });
  assert.equal(tier25.priceMinor, 2171);
  assert.equal(tier25.source, 'loyalty');
});

test('okfish parity: no-op action price (>= basePrice) is ignored', () => {
  // Base 100.00 €, ActionPrice 100.00 € (leftover promotion).
  // Must NOT trigger active-action overrides; raw loyalty must apply.
  const result = evaluatePricing({
    baseMinor: 10000,
    actionMinor: 10000,
    tierPercent: 10,
    salePolicy: 'okfish_compatible'
  });
  assert.equal(result.priceMinor, 9000);
  assert.equal(result.source, 'loyalty');
});

test('okfish parity: allowLoyaltyDiscount false blocks loyalty completely', () => {
  const result = evaluatePricing({
    baseMinor: 10000,
    actionMinor: 9500,
    tierPercent: 20,
    allowLoyaltyDiscount: false,
    salePolicy: 'okfish_compatible'
  });
  assert.equal(result.priceMinor, 9500);
  assert.equal(result.source, 'sale');
});

test('cap priority configuration: hierarchy vs most_restrictive', () => {
  // Product cap 15%, Brand cap 5%
  // In hierarchy: product cap overrides brand cap -> 15% cap
  const hierarchy = evaluatePricing({
    baseMinor: 10000,
    tierPercent: 20,
    productCap: 15,
    brandCap: 5,
    capPriority: 'hierarchy'
  });
  assert.equal(hierarchy.priceMinor, 8500); // 15% discount
  assert.equal(hierarchy.effectiveTierPercent, 15);

  // In most_restrictive: min(15%, 5%) = 5% cap
  const restrictive = evaluatePricing({
    baseMinor: 10000,
    tierPercent: 20,
    productCap: 15,
    brandCap: 5,
    capPriority: 'most_restrictive'
  });
  assert.equal(restrictive.priceMinor, 9500); // 5% discount
  assert.equal(restrictive.effectiveTierPercent, 5);
});

test('multi-currency CZK and EUR with fixed discounts and coupons', () => {
  // CZK: Base 1 000.00 Kč, Fixed discount 150.00 Kč, Action 880.00 Kč
  const czk = evaluatePricing({
    baseMinor: 100000,
    actionMinor: 88000,
    fixedDiscountMinor: 15000,
    salePolicy: 'lowest_price',
    incrementMinor: 100
  });
  // Fixed loyalty = 850.00 Kč < Action 880.00 Kč -> 850.00 Kč
  assert.equal(czk.priceMinor, 85000);
  assert.equal(czk.source, 'loyalty');

  // EUR: Base 100.00 €, Fixed discount 15.00 €, Action 88.00 €
  const eur = evaluatePricing({
    baseMinor: 10000,
    actionMinor: 8800,
    fixedDiscountMinor: 1500,
    salePolicy: 'lowest_price',
    incrementMinor: 1
  });
  assert.equal(eur.priceMinor, 8500);
  assert.equal(eur.source, 'loyalty');
});
