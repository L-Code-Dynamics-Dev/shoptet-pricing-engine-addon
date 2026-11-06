// Prices are integral API hundredths. Percentages have at most two decimal places.
// No floating-point arithmetic is used after percentage validation.
const money=(n,label)=>{if(!Number.isSafeInteger(n)||n<0)throw TypeError('Invalid '+label);return BigInt(n);};
const percent=(p,label)=>{if(typeof p!=='number'||!Number.isFinite(p)||p<0||p>100||Number(p.toFixed(2))!==p)throw TypeError('Invalid '+label);return BigInt(p.toFixed(2).replace('.',''));};
const number=n=>{if(n>BigInt(Number.MAX_SAFE_INTEGER))throw TypeError('Price overflow');return Number(n);};
const divide=(n,d,mode='math')=>{const q=n/d,r=n%d;return q+(mode==='up'&&r>0n||mode==='math'&&r*2n>=d?1n:0n);};
export function parseApiPrice(value){if(typeof value!=='string'||!/^\d+\.\d{2}$/.test(value)||value.length>24)throw TypeError('Invalid API price');return number(BigInt(value.replace('.','')));}
export function formatApiPrice(value){const n=money(value,'price');return n/100n+'.'+String(n%100n).padStart(2,'0');}
export function grossApiPrice(row,vatPayer){
 if(typeof vatPayer!=='boolean'||typeof row.includingVat!=='boolean')throw TypeError('VAT context required');
 let n=money(parseApiPrice(row.price.price),'base price');
 if(vatPayer&&!row.includingVat){const rate=parseApiPrice(row.vatRate);if(rate>10000)throw TypeError('Invalid VAT rate');n=divide(n*(10000n+BigInt(rate)),10000n);}
 const ratio=row.price.priceRatio;if(typeof ratio!=='string'||!/^\d+\.\d{3}$/.test(ratio))throw TypeError('Invalid price ratio');
 return number(divide(n*BigInt(ratio.replace('.','')),1000n));
}
export function activeActionMinor(row,vatPayer,date){
 const action=row.price.actionPrice;if(!action||!action.fromDate||!action.toDate)return null;
 for(const d of [date,action.fromDate,action.toDate]){if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw TypeError('Invalid action date');}
 if(action.fromDate>action.toDate)throw TypeError('Invalid action period');
 if(date<action.fromDate||date>action.toDate)return null;
 const price=parseApiPrice(action.price);
 return vatPayer&&!row.includingVat?number(divide(money(price,'action')*(10000n+BigInt(parseApiPrice(row.vatRate))),10000n)):price;
}
export function evaluatePricing({baseMinor,actionMinor=null,tierPercent=0,fixedDiscountMinor=null,fixedPriceMinor=null,productCap=null,categoryCaps=[],brandCap=null,couponPercent=0,couponCombination='no_loyalty_combination',minimumMinor=null,rounding='math',incrementMinor=1}) {
 const base=money(baseMinor,'base price'),tier=percent(tierPercent,'tier');
 if(!Array.isArray(categoryCaps)||categoryCaps.length>200)throw TypeError('Invalid category caps');
 const caps=[productCap,brandCap,...categoryCaps].filter(x=>x!==null).map(p=>percent(p,'cap'));
 let effective=tier;for(const cap of caps)if(cap<effective)effective=cap;
 if(!['math','up','down','none'].includes(rounding))throw TypeError('Invalid rounding');
 const requestedStep=money(incrementMinor,'rounding increment');const step=rounding==='none'?1n:requestedStep;if(requestedStep<1n)throw TypeError('Invalid rounding increment');
 let loyalty=divide(base*(10000n-effective),10000n*step,rounding==='none'?'math':rounding)*step;
 if(fixedDiscountMinor!==null){
  const fixedD=money(fixedDiscountMinor,'fixed discount');
  let fixedLoyalty=base>fixedD?base-fixedD:0n;
  fixedLoyalty=divide(fixedLoyalty,step,rounding==='none'?'math':rounding)*step;
  loyalty=tier>0n?Math.min(loyalty,fixedLoyalty):fixedLoyalty;
 }
 if(fixedPriceMinor!==null){
  const fixedP=money(fixedPriceMinor,'fixed price');
  loyalty=Math.min(loyalty,fixedP);
 }
 if(loyalty>base)loyalty=base;
 const action=actionMinor===null?null:money(actionMinor,'action');
 const chosen=action!==null&&action<=loyalty?action:loyalty;
 const loyaltyApplied=chosen<base && (action===null||loyalty<action);
 const coupon=percent(couponPercent,'coupon');
 if(!['no_loyalty_combination','allow'].includes(couponCombination))throw TypeError('Invalid coupon combination');
 const couponApplied=coupon>0n && (!loyaltyApplied||couponCombination==='allow');
 let final=couponApplied?divide(chosen*(10000n-coupon),10000n*step,rounding==='none'?'math':rounding)*step:chosen;
 if(final>chosen)final=chosen;
 const minimum=minimumMinor===null?null:money(minimumMinor,'minimum');
 const valid=minimum===null||final>=minimum;
 return {priceMinor:number(final),loyaltyMinor:number(loyalty),effectiveTierPercent:Number(effective)/100,loyaltyApplied,couponApplied,source:action!==null&&action<=loyalty?'sale':loyaltyApplied?'loyalty':'base',valid,blockedReason:!valid?'minimum_price_violation':null};
}
export function shopDate(timezone,instant=new Date()) {const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);const value=k=>parts.find(p=>p.type===k).value;return value('year')+'-'+value('month')+'-'+value('day');}
