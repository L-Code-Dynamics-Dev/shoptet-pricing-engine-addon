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
