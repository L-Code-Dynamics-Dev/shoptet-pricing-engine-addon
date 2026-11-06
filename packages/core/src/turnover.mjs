import {z} from 'zod';

const statusId=z.number().int().safe();
export const turnoverPolicySchema=z.object({
 period:z.object({from:z.string().datetime({offset:true}),to:z.string().datetime({offset:true})}).strict(),
 qualifyingStatusIds:z.array(statusId).min(1).max(100),
 requirePaid:z.boolean(),
 shipping:z.enum(['include','exclude']),
 billing:z.enum(['include','exclude']),
 discounts:z.literal('after_discounts'),
 vat:z.enum(['inclusive','exclusive']),
 refunds:z.literal('exclude_order_with_valid_credit_note'),
 guestCustomers:z.literal('exclude'),
 itemStatuses:z.literal('require_match_order'),
 upgrades:z.literal('recalculate'),
 downgrades:z.enum(['recalculate','keep_current']),
 exchangeRates:z.record(z.string().regex(/^[A-Z]{3}$/), z.number().positive().finite().max(1000000).refine(v=>Number(v.toFixed(4))===v,'Exchange rate supports at most 4 decimal places')).optional(),
 multiCurrency:z.enum(['fail_on_mismatch','convert_explicit','accumulate_separate']).optional()
}).strict().superRefine((p,c)=>{
 if(Date.parse(p.period.from)>=Date.parse(p.period.to))c.addIssue({code:'custom',message:'Period must increase'});
 if(new Set(p.qualifyingStatusIds).size!==p.qualifyingStatusIds.length)c.addIssue({code:'custom',message:'Duplicate status'});
});
export class TurnoverError extends Error{}
function fail(code){throw new TurnoverError(code);}
const money=value=>{if(typeof value!=='string'||! /^-?\d+\.\d{2}$/.test(value)||value.length>24)fail('turnover_price_missing');return BigInt(value.replace('.',''));};
const amount=n=>`${n<0n?'-':''}${(n<0n?-n:n)/100n}.${String((n<0n?-n:n)%100n).padStart(2,'0')}`;

// Pure calculation. Values are already line totals after quantity and discount.
export function calculateTurnover({customerGuid,currency,tiers,policy,orders,creditNotes,currentPricelistId=null}){
 const p=turnoverPolicySchema.parse(policy),start=Date.parse(p.period.from),end=Date.parse(p.period.to);
 const relevant=new Map(),seen=new Set(),excluded=[];let total=0n;
 const turnoverByCurrency=new Map();
 for(const o of orders){
  if(seen.has(o.code))fail('duplicate_order');seen.add(o.code);
  if(o.customerGuid!==customerGuid)fail('customer_order_mismatch');
  const date=Date.parse(o.creationTime);if(!Number.isFinite(date))fail('order_date_invalid');
  if(date<start||date>=end)continue;
  if(!o.status||!p.qualifyingStatusIds.includes(o.status.id)||p.requirePaid&&o.paid!==true){excluded.push({code:o.code,reason:'status_or_payment'});continue;}
  const orderCur=o.price.currencyCode;
  if(orderCur!==currency){
   const hasRate=p.exchangeRates&&typeof p.exchangeRates[orderCur]==='number';
   if(!hasRate&&p.multiCurrency!=='accumulate_separate')fail('turnover_currency_mismatch');
  }
  relevant.set(o.code,o);
 }
 const refunded=new Set(),notes=new Set();
 for(const n of creditNotes){
  if(notes.has(n.code))fail('duplicate_credit_note');notes.add(n.code);
  if(!n.isValid)continue;
  if(n.customer.guid===customerGuid&&!n.orderCode)fail('unlinked_customer_credit_note');
  if(relevant.has(n.orderCode)){
   if(n.customer.guid!==null&&n.customer.guid!==customerGuid)fail('credit_note_customer_mismatch');
   refunded.add(n.orderCode);
  }
 }
 let counted=0;
 for(const o of relevant.values()){
  if(refunded.has(o.code)){excluded.push({code:o.code,reason:'valid_credit_note'});continue;}
  if(o.items.some(i=>i.status.id!==o.status.id))fail('mixed_item_status_requires_supported_policy');
  const field=p.vat==='inclusive'?'withVat':'withoutVat';let value=money(o.price[field]);
  for(const i of o.items)if(i.itemType==='shipping'&&p.shipping==='exclude'||i.itemType==='billing'&&p.billing==='exclude')value-=money(i.itemPrice[field]);
  if(value<0n)fail('negative_qualifying_order');
  const orderCur=o.price.currencyCode;
  turnoverByCurrency.set(orderCur,(turnoverByCurrency.get(orderCur)??0n)+value);
  if(orderCur===currency){
   total+=value;
  }else if(p.exchangeRates&&typeof p.exchangeRates[orderCur]==='number'){
   const rate=p.exchangeRates[orderCur];
   // The schema validated the decimal scale. Convert from decimal text,
   // never via a binary-float multiplication of monetary values.
   const rateScaled=BigInt(rate.toFixed(4).replace('.',''));
   const converted=(value*rateScaled+5000n)/10000n;
   total+=converted;
  }
  counted++;
 }
 let previous=-1n;const names=new Set();
 for(const t of tiers){if(!Number.isSafeInteger(t.minTurnover)||t.minTurnover<0||names.has(t.name)||BigInt(t.minTurnover)<=previous)fail('invalid_turnover_tiers');previous=BigInt(t.minTurnover);names.add(t.name);}
 if(currentPricelistId!==null&&tiers.filter(t=>t.pricelistId===currentPricelistId).length>1)fail('ambiguous_current_tier_mapping');
 const eligible=tiers.filter(t=>total>=BigInt(t.minTurnover)*100n).at(-1)??null;
 const current=currentPricelistId===null?null:tiers.find(t=>t.pricelistId===currentPricelistId);
 const kept=!!(current&&p.downgrades==='keep_current'&&(!eligible||current.minTurnover>eligible.minTurnover));
 const selected=kept?current:eligible;
 const currencyBreakdown=Object.fromEntries(Array.from(turnoverByCurrency.entries()).map(([k,v])=>[k,amount(v)]));
 return {customerGuid,currency,turnover:amount(total),turnoverByCurrency:currencyBreakdown,qualifyingOrders:counted,excludedOrders:excluded,tier:selected?.name??null,pricelistId:selected?.pricelistId??null,downgradePrevented:kept,mappedPricelistAvailable:!!selected?.pricelistId,assignmentSupported:false,assignmentBlockers:['customer_assignment_executor_not_implemented'],applied:false};
}

async function boundedCollection(load,max){
 const result=[],seen=new Set();let expected=null;
 for(let page=1;;page++){
  const r=await load(page),p=r.pagination;
  if(p.page!==page||p.totalCount>max||p.pageCount>Math.max(1,Math.ceil(max/50))||expected!==null&&p.totalCount!==expected)fail('turnover_collection_incomplete');
  expected=p.totalCount;
  for(const item of r.items){if(seen.has(item.code))fail('turnover_collection_changed');seen.add(item.code);result.push(item);}
  if(result.length>max)fail('turnover_collection_incomplete');
  if(page>=p.pageCount){if(result.length!==expected)fail('turnover_collection_incomplete');return result;}
  if(!r.items.length)fail('turnover_collection_incomplete');
 }
}
export async function previewCustomerTurnover({adapter,proposal,customers}){
 if(!proposal.turnoverPolicy)fail('turnover_policy_required');const policy=turnoverPolicySchema.parse(proposal.turnoverPolicy);
 z.array(z.string().uuid()).min(1).max(5).refine(a=>new Set(a).size===a.length).parse(customers);
 if(Date.parse(policy.period.to)>Date.now())fail('turnover_period_in_future');
 const [profile,statuses]=await Promise.all([adapter.profile(),adapter.orderStatuses()]);
 if(!profile.currencies.some(c=>c.code===proposal.currency))fail('turnover_currency_unavailable');
 if(policy.qualifyingStatusIds.some(id=>!statuses.some(s=>s.id===id)))fail('order_status_reference_missing');
 for(const id of new Set(proposal.tiers.map(t=>t.pricelistId).filter(id=>id!=null))){const list=await adapter.pricelist(id);if(list.id!==id||list.currency!==proposal.currency)fail('tier_pricelist_reference_invalid');}
 const creditRows=await boundedCollection(page=>adapter.creditNotes({page}),50);
 const creditNotes=[];for(const row of creditRows){const detail=await adapter.creditNote(row.code);if(row.code!==detail.code)fail('credit_note_reference_mismatch');creditNotes.push(detail);}
 const results=[];let remaining=25;
 for(const guid of customers){
  const customer=await adapter.customer(guid);if(customer.guid!==guid)fail('customer_reference_mismatch');
  const rows=await boundedCollection(page=>adapter.customerOrders(guid,{page,from:policy.period.from,to:policy.period.to}),remaining);
  remaining-=rows.length;const orders=[];
  for(const row of rows){const detail=await adapter.order(row.code);if(row.code!==detail.code||row.changeTime!==detail.changeTime)fail('order_changed_during_preview');orders.push(detail);}
  const calculated=calculateTurnover({customerGuid:guid,currency:proposal.currency,tiers:proposal.tiers,policy,orders,creditNotes,currentPricelistId:customer.priceList?.id??null});
  if(customer.priceRatio!=='1.0000')calculated.assignmentBlockers.push('existing_customer_price_ratio_requires_review');
  results.push(calculated);
 }
 return {customers:results,policy,snapshotOnly:true,retrievedAt:new Date().toISOString(),limits:{customers:5,orders:25,shopCreditNotes:50},applied:false,liveAssignmentsVerified:false};
}

const uuid=z.string().uuid();
const positive=z.number().int().positive();
export async function executeCustomerTierAssignment({ adapter, customerGuid, targetPricelistId }) {
 uuid.parse(customerGuid);
 positive.parse(targetPricelistId);
 return adapter.updateCustomerPricelist(customerGuid, targetPricelistId);
}
