import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateTierPrice, resolveDiscountCap, createPricelistPricePatch} from '../src/pricing.mjs';

test('better sale price wins against smaller loyalty tier', () => {
  assert.equal(calculateTierPrice({baseMinor:10000,actionMinor:8500,tierPercent:4}),8500);
});
test('better loyalty price wins against smaller sale discount', () => {
  assert.equal(calculateTierPrice({baseMinor:10000,actionMinor:8500,tierPercent:20}),8000);
});
test('product cap takes precedence over brand and category', () => {
  assert.equal(resolveDiscountCap({productCap:5,brandCap:10,categoryCap:15}),5);
});
test('zero product cap is not treated as missing', () => {
  assert.equal(resolveDiscountCap({productCap:0,brandCap:10}),0);
});
test('cap limits loyalty without erasing better action price', () => {
  assert.equal(calculateTierPrice({baseMinor:10000,actionMinor:8500,tierPercent:25,capPercent:10}),8500);
});
test('price PATCH always includes explicit VAT metadata', () => {
  assert.deepEqual(createPricelistPricePatch({code:'12345',priceMinor:591,vatRate:'23.00'}),{
    code:'12345',price:'5.91',includingVat:true,vatRate:'23.00'
  });
});
test('missing VAT rate is rejected before network write', () => {
  assert.throws(()=>createPricelistPricePatch({code:'12345',priceMinor:591}),/VAT/);
});
test('invalid money is rejected', () => {
  assert.throws(()=>calculateTierPrice({baseMinor:NaN,tierPercent:10}),/baseMinor/);
});

test('most restrictive category and brand override larger product cap',()=>{assert.equal(resolveDiscountCap({productCap:20,categoryCap:8,brandCap:5}),5);assert.throws(()=>resolveDiscountCap({brandCap:-1}),/Invalid/);});

test('tier discounts use exact minor-unit arithmetic for large safe integers', () => {
  assert.equal(calculateTierPrice({baseMinor: 9999, tierPercent: 12.5}), 8749);
  assert.equal(calculateTierPrice({baseMinor: 10000, tierPercent: 25, fixedDiscountMinor: 9000, capPercent: 10}), 9000);
  assert.throws(() => calculateTierPrice({baseMinor: 10000, tierPercent: 12.345}), /tierPercent/);
  assert.throws(() => calculateTierPrice({baseMinor: 10000, salePolicy: 'unknown'}), /salePolicy/);
});

test('price patch serializes integer minor units without floating-point formatting', () => {
  assert.equal(createPricelistPricePatch({code:'big',priceMinor: Number.MAX_SAFE_INTEGER,vatRate:'21.00'}).price, '90071992547409.91');
});

test('TASK 2: category policy consistency when both categoryCap and categoryCaps are supplied', () => {
  // When categoryCap=15 and categoryCaps=[5] are supplied under both modes:
  const mostRestrictive = resolveDiscountCap({
    categoryCap: 15,
    categoryCaps: [5],
    priority: 'most_restrictive'
  });
  assert.equal(mostRestrictive, 5);

  const hierarchy = resolveDiscountCap({
    productCap: null,
    brandCap: null,
    categoryCap: 15,
    categoryCaps: [5],
    priority: 'hierarchy'
  });
  assert.equal(hierarchy, 5);
});

test('TASK 6: floor rounding - calculateTierPrice uses ceiling-to-step on minimumMinor', () => {
  // base 10000, tier 50% (would be 5000), minimumMinor 8566, incrementMinor 100 (CZK 1.00 step)
  const price = calculateTierPrice({
    baseMinor: 10000,
    tierPercent: 50,
    minimumMinor: 8566,
    incrementMinor: 100
  });

  // Ceiling-to-step: ceil(8566 / 100) * 100 = 8600 >= 8566
  assert.equal(price, 8600);
  assert.ok(price >= 8566);
  assert.equal(price % 100, 0); // Exactly representable on shop currency step
});
