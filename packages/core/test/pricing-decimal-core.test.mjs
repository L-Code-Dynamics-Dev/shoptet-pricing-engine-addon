import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTierPrice,
  resolveDiscountCap,
  createPricelistPricePatch,
  resolveCurrencyRoundingRules
} from '../src/pricing.mjs';
import { evaluatePricing, formatApiPrice } from '../src/pricing-policy.mjs';

test('FÁZE 1: Exact Decimal arithmetic - boundary values and zero rounding error', () => {
  // Test with large integers up to safe bounds
  const largeBase = 90071992547400; // Large safe integer minor units
  const res = calculateTierPrice({ baseMinor: largeBase, tierPercent: 10 });
  assert.equal(res, 81064793292660);

  // Exact penny / cent half-up rounding
  assert.equal(calculateTierPrice({ baseMinor: 105, tierPercent: 10, rounding: 'math', incrementMinor: 1 }), 95); // 105 * 0.90 = 94.5 -> 95
  assert.equal(calculateTierPrice({ baseMinor: 105, tierPercent: 10, rounding: 'down', incrementMinor: 1 }), 94);
  assert.equal(calculateTierPrice({ baseMinor: 105, tierPercent: 10, rounding: 'up', incrementMinor: 1 }), 95);
});

test('FÁZE 1: HighestDiscountPolicy - lower of sale and loyalty price, zero stacking', () => {
  // Base 1000 CZK (100000 minor)
  // Loyalty 10% -> 900 CZK (90000 minor)
  // Sale 850 CZK (85000 minor) -> Sale wins
  const saleWins = calculateTierPrice({
    baseMinor: 100000,
    actionMinor: 85000,
    tierPercent: 10,
    salePolicy: 'lowest_price'
  });
  assert.equal(saleWins, 85000);

  // Loyalty 20% -> 800 CZK (80000 minor)
  // Sale 850 CZK -> Loyalty wins
  const loyaltyWins = calculateTierPrice({
    baseMinor: 100000,
    actionMinor: 85000,
    tierPercent: 20,
    salePolicy: 'lowest_price'
  });
  assert.equal(loyaltyWins, 80000);

  // Stacking is NEVER performed (no 20% off 850)
  assert.notEqual(loyaltyWins, 68000);
});

test('FÁZE 1: Strop precedence - product -> brand -> category (hierarchy)', () => {
  // Product cap 12%, Brand cap 8%, Category cap 5%
  // In hierarchy mode, product cap 12% is authoritative
  const hierarchyProduct = resolveDiscountCap({
    productCap: 12,
    brandCap: 8,
    categoryCap: 5,
    priority: 'hierarchy'
  });
  assert.equal(hierarchyProduct, 12);

  // If product cap is null, brand cap 8% takes precedence over category cap 5%
  const hierarchyBrand = resolveDiscountCap({
    productCap: null,
    brandCap: 8,
    categoryCap: 5,
    priority: 'hierarchy'
  });
  assert.equal(hierarchyBrand, 8);

  // If product and brand caps are null, category cap 5% takes effect
  const hierarchyCat = resolveDiscountCap({
    productCap: null,
    brandCap: null,
    categoryCap: 5,
    priority: 'hierarchy'
  });
  assert.equal(hierarchyCat, 5);

  // In most_restrictive mode, min(12, 8, 5) = 5%
  const mostRestrictive = resolveDiscountCap({
    productCap: 12,
    brandCap: 8,
    categoryCap: 5,
    priority: 'most_restrictive'
  });
  assert.equal(mostRestrictive, 5);
});

test('FÁZE 1: Action price is never raised by cap or minimum guardrail (INC-004 & GPT-6 P1 Blocker)', () => {
  // Base 10000, Action 8000 (20% off), Product Cap 10% (floor 9000), Tier 25%
  const res = calculateTierPrice({
    baseMinor: 10000,
    actionMinor: 8000,
    tierPercent: 25,
    capPercent: 10,
    salePolicy: 'okfish_compatible'
  });
  // Must NOT be raised to 9000
  assert.equal(res, 8000);

  // P1 BLOCKER REPRODUCER:
  // When minimumMinor = 9000, manual action price 8000 must NOT be raised to 9000!
  const resWithMin = calculateTierPrice({
    baseMinor: 10000,
    actionMinor: 8000,
    tierPercent: 25,
    capPercent: 10,
    salePolicy: 'okfish_compatible',
    minimumMinor: 9000
  });
  assert.equal(resWithMin, 8000);

  // If loyalty is chosen (e.g. action price 9500 > loyalty 7500), minimumMinor protects the margin:
  const resLoyaltyMin = calculateTierPrice({
    baseMinor: 10000,
    actionMinor: 9500,
    tierPercent: 25,
    minimumMinor: 9000
  });
  assert.equal(resLoyaltyMin, 9000);
});

test('FÁZE 1: Zero-discount product cap blocks loyalty without error', () => {
  // Product with cap 0% (strictly no loyalty discount)
  const capZero = resolveDiscountCap({ productCap: 0, brandCap: 15 });
  assert.equal(capZero, 0);

  const price = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: 20,
    capPercent: capZero
  });
  assert.equal(price, 10000); // Full base price preserved
});

test('FÁZE 1: Currency rounding rules and Shoptet conventions', () => {
  const czk = resolveCurrencyRoundingRules('CZK');
  assert.equal(czk.currencyCode, 'CZK');
  assert.equal(czk.decimals, 2);
  assert.equal(czk.incrementMinor, 100); // whole CZK default for customer pricing

  const eur = resolveCurrencyRoundingRules('EUR');
  assert.equal(eur.currencyCode, 'EUR');
  assert.equal(eur.decimals, 2);
  assert.equal(eur.incrementMinor, 1); // 0.01 cent

  const huf = resolveCurrencyRoundingRules('HUF');
  assert.equal(huf.decimals, 0);
  assert.equal(huf.incrementMinor, 100); // whole HUF

  assert.throws(() => resolveCurrencyRoundingRules('INVALID'), /Invalid currencyCode/);
});

test('FÁZE 1: Fail closed on missing VAT, zero prices or invalid data (INC-010, INC-014, INC-015)', () => {
  // Reject zero prices without explicit approval
  assert.throws(() => createPricelistPricePatch({ code: 'SKU1', priceMinor: 0, vatRate: '21.00' }), /Zero price/);
  // Allow zero price only when explicitly approved
  const freeItem = createPricelistPricePatch({ code: 'FREE1', priceMinor: 0, vatRate: '21.00', allowZeroPrice: true });
  assert.equal(freeItem.price, '0.00');

  // Reject missing VAT
  assert.throws(() => createPricelistPricePatch({ code: 'SKU1', priceMinor: 1000 }), /Explicit VAT rate/);
  assert.throws(() => createPricelistPricePatch({ code: 'SKU1', priceMinor: 1000, vatRate: 'invalid' }), /Explicit VAT rate/);

  // Reject non-inclusive VAT writes
  assert.throws(() => createPricelistPricePatch({ code: 'SKU1', priceMinor: 1000, vatRate: '21.00', includingVat: false }), /VAT-inclusive/);

  // Minimum margin floor violation
  const marginProtected = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: 25, // would be 7500
    minimumMinor: 8500
  });
  assert.equal(marginProtected, 8500); // Clamped to minimum margin floor
});

test('Task 4: resolveCurrencyRoundingRules strict validation of options and currency codes', () => {
  // Valid overrides
  const customCzk = resolveCurrencyRoundingRules('czk', {
    priceDecimalPlaces: 0,
    rounding: 'up',
    incrementMinor: 100
  });
  assert.equal(customCzk.decimals, 0);
  assert.equal(customCzk.rounding, 'up');
  assert.equal(customCzk.incrementMinor, 100);

  // Invalid currencyCode
  assert.throws(() => resolveCurrencyRoundingRules(''), /Invalid currencyCode/);
  assert.throws(() => resolveCurrencyRoundingRules('XYZ'), /Unsupported currencyCode/);
  assert.throws(() => resolveCurrencyRoundingRules(123), /Invalid currencyCode/);

  // Invalid priceDecimalPlaces
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { priceDecimalPlaces: -1 }), /Invalid priceDecimalPlaces/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { priceDecimalPlaces: 5 }), /Invalid priceDecimalPlaces/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { priceDecimalPlaces: 2.5 }), /Invalid priceDecimalPlaces/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { priceDecimalPlaces: 'two' }), /Invalid priceDecimalPlaces/);

  // Invalid rounding method
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { rounding: 'floor' }), /Invalid rounding/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { rounding: 1 }), /Invalid rounding/);

  // Invalid incrementMinor
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { incrementMinor: 0 }), /Invalid incrementMinor/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { incrementMinor: -10 }), /Invalid incrementMinor/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { incrementMinor: 1.5 }), /Invalid incrementMinor/);
  assert.throws(() => resolveCurrencyRoundingRules('CZK', { incrementMinor: '100' }), /Invalid incrementMinor/);
});

test('P2: calculateTierPrice exact percent parsing and categoryCaps support', () => {
  // Fractional percent as number and string without float errors
  const priceFrac = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: 12.5 // 12.5% off -> 8750
  });
  assert.equal(priceFrac, 8750);

  const priceStr = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: '12.5'
  });
  assert.equal(priceStr, 8750);

  // Invalid percents throw
  assert.throws(() => calculateTierPrice({ baseMinor: 10000, tierPercent: NaN }), /Invalid tierPercent/);
  assert.throws(() => calculateTierPrice({ baseMinor: 10000, tierPercent: -5 }), /Invalid tierPercent/);
  assert.throws(() => calculateTierPrice({ baseMinor: 10000, tierPercent: 105 }), /Invalid tierPercent/);

  // categoryCaps array support
  const catCapResult = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: 20,
    categoryCaps: [15, 8, 12], // min is 8%
    capPriority: 'most_restrictive'
  });
  // Cap = 8% -> price = 9200
  assert.equal(catCapResult, 9200);
});
