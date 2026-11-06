import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePricing,parseApiPrice,formatApiPrice,grossApiPrice,activeActionMinor} from '../src/pricing-policy.mjs';
const golden=[
 ['tier',{},9500],['brand cap',{brandCap:3},9700],['product exclusion',{productCap:0},10000],['multiple categories',{tierPercent:20,categoryCaps:[12,4,8]},9600],['most restrictive',{tierPercent:20,productCap:15,brandCap:5,categoryCaps:[10]},9500],['better sale',{actionMinor:8000},8000],['better tier',{actionMinor:9800},9500],['coupon conflict',{couponPercent:10},9500],['allowed coupon',{couponPercent:10,couponCombination:'allow'},8550],['coupon on sale',{actionMinor:8000,couponPercent:10},7200],['zero amount',{baseMinor:0},0],['up rounding',{baseMinor:10001,rounding:'up',incrementMinor:100},9600],['down rounding',{baseMinor:10001,rounding:'down',incrementMinor:100},9500],['never raise base',{baseMinor:147,tierPercent:0,rounding:'up',incrementMinor:100},147]
];
for(const [name,options,expected] of golden)test('golden pricing: '+name,()=>assert.equal(evaluatePricing({baseMinor:10000,tierPercent:5,...options}).priceMinor,expected));
test('minimum protection blocks unsafe prices and invalid data is rejected',()=>{assert.equal(evaluatePricing({baseMinor:10000,tierPercent:5,minimumMinor:9800}).blockedReason,'minimum_price_violation');for(const input of [{baseMinor:-1,tierPercent:5},{baseMinor:100,tierPercent:NaN},{baseMinor:100,tierPercent:1.234},{baseMinor:100,tierPercent:5,categoryCaps:[-1]}])assert.throws(()=>evaluatePricing(input));});
test('VAT and ratios use explicit decimal metadata',()=>{const row={includingVat:false,vatRate:'21.00',price:{price:'100.00',priceRatio:'0.800',actionPrice:{price:'70.00',fromDate:'2026-01-01',toDate:'2026-12-31'}}};assert.equal(grossApiPrice(row,true),9680);assert.equal(grossApiPrice(row,false),8000);assert.equal(activeActionMinor(row,true,'2026-11-06'),8470);assert.equal(activeActionMinor(row,true,'2027-01-01'),null);assert.equal(formatApiPrice(parseApiPrice('123456.78')),'123456.78');assert.throws(()=>parseApiPrice('1.234'));});


test('fixed discount and fixed price use BigInt comparisons without throwing', () => {
  const fixedDiscount = evaluatePricing({baseMinor:10000,tierPercent:10,fixedDiscountMinor:1500});
  assert.equal(fixedDiscount.priceMinor,8500);
  const fixedPrice = evaluatePricing({baseMinor:10000,tierPercent:10,fixedPriceMinor:8000});
  assert.equal(fixedPrice.priceMinor,8000);
  const zeroTier = evaluatePricing({baseMinor:10000,tierPercent:0,fixedDiscountMinor:2500});
  assert.equal(zeroTier.priceMinor,7500);
});
