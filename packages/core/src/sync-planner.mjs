import {z} from 'zod';
import {proposalSchema} from './configuration.mjs';
import {evaluatePricing,grossApiPrice,activeActionMinor,formatApiPrice,shopDate} from './pricing-policy.mjs';
export const syncSelectionSchema=z.object({revisionId:z.string().uuid(),tierName:z.string().min(1).max(60),targetPricelistId:z.number().int().positive(),products:z.array(z.object({guid:z.string().uuid(),codes:z.array(z.string().min(1).max(128)).min(1).max(20)}).strict()).min(1).max(25)}).strict();
export async function buildSyncPlan({adapter,proposal,selection,instant=new Date()}) {
 const policy=proposalSchema.parse(proposal),selected=syncSelectionSchema.parse(selection);
 const tier=policy.tiers.find(t=>t.name===selected.tierName);if(!tier)throw Error('tier_not_found');
 const profile=await adapter.profile();const currency=profile.currencies.find(c=>c.code===policy.currency);
 if(!currency||currency.priceDecimalPlaces>2)throw Error('currency_rounding_not_supported');
 if(profile.defaultPricelistId===selected.targetPricelistId)throw Error('default_pricelist_write_forbidden');
 const target=await adapter.pricelist(selected.targetPricelistId);
 if(target.isDefault || target.currency!==null&&target.currency!==policy.currency)throw Error('target_currency_mismatch');
 const source=await adapter.pricelist(profile.defaultPricelistId);
 if(source.currency!==null&&source.currency!==policy.currency)throw Error('source_currency_mismatch');
 const date=shopDate(profile.timezone,instant),actions=[],seen=new Set(),productIds=new Set();
 for(const item of selected.products){
  if(productIds.has(item.guid))throw Error('duplicate_product');productIds.add(item.guid);
  const product=await adapter.product(item.guid);
  if(product.visibility!=='normal')throw Error('inactive_product');
  let brandId=null;
  if(product.brand){brandId=(await adapter.brand(product.brand.code)).guid;}
  const brandCap=policy.brandCaps.find(c=>c.id===brandId)?.percent??null;
  for(const code of item.codes){
   if(seen.has(code))throw Error('duplicate_variant');seen.add(code);
   if(!product.variants.some(v=>v.code===code && v.visible))throw Error('variant_not_visible_or_missing');
   const from=await adapter.prices(source.id,{code,limit:2}),to=await adapter.prices(target.id,{code,limit:2});
   if(from.items.length!==1||to.items.length!==1||from.items[0].code!==code||to.items[0].code!==code)throw Error('price_reference_missing_or_ambiguous');
   const before=to.items[0],base=from.items[0];
   if(base.currencyCode!==policy.currency||before.currencyCode!==policy.currency||base.vatRate!==before.vatRate)throw Error('currency_or_vat_mismatch');
   // Unsupported target ratios/promotions could change native checkout price independently.
   if(before.price.priceRatio!=='1.000'||activeActionMinor(before,profile.vatPayer,date)!==null)throw Error('target_price_modifier_requires_separate_plan');
   const baseMinor=grossApiPrice(base,profile.vatPayer),actionMinor=activeActionMinor(base,profile.vatPayer,date);
   if(policy.categoryCaps.length && !Array.isArray(product.categories))throw Error('all_product_categories_required');
   const categories=new Set([product.defaultCategory.guid,...(product.categories??[]).map(c=>c.guid)].filter(Boolean));
   const categoryCaps=policy.categoryCaps.filter(c=>categories.has(c.id)).map(c=>c.percent);
   const productCaps=policy.productCaps.filter(c=>c.id===product.guid&&(c.variantCode===undefined||c.variantCode===code)).map(c=>c.percent);
   const productCap=productCaps.length?Math.min(...productCaps):null;
   const calculated=evaluatePricing({baseMinor,actionMinor,tierPercent:tier.percent,brandCap,categoryCaps,productCap,rounding:currency.rounding,incrementMinor:10**(2-currency.priceDecimalPlaces)});
   if(!calculated.valid||calculated.priceMinor===0)throw Error('zero_or_invalid_price_not_supported');
   const patch={code,priceWithVat:{price:formatApiPrice(calculated.priceMinor)},...(policy.couponPolicy==='no_loyalty_combination'&&calculated.loyaltyApplied?{sales:{discountCoupon:false}}:{})};
   const expected={price:patch.priceWithVat.price,discountCoupon:patch.sales?.discountCoupon??before.sales.discountCoupon};
   actions.push({productGuid:product.guid,brandId,categoryIds:[...categories].sort(),code,sourcePricelistId:source.id,targetPricelistId:target.id,baseSnapshot:base,beforeSnapshot:before,patch,expected,calculation:calculated});
  }
 }
 if(actions.length>100)throw Error('plan_too_large');
 actions.sort((a,b)=>a.code.localeCompare(b.code,'en'));
 return {schemaVersion:1,revisionId:selected.revisionId,currency:policy.currency,vatPayer:profile.vatPayer,timezone:profile.timezone,date,createdAt:instant.toISOString(),expiresAt:instant.getTime()+900000,sourcePricelistId:source.id,targetPricelistId:target.id,tierName:tier.name,actions,limitations:['customer_assignments_not_included','storefront_not_verified','write_activation_requires_verified_capability_and_parity']};
}
