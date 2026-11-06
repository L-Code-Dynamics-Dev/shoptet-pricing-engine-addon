import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateTurnover,previewCustomerTurnover,executeCustomerTierAssignment,turnoverPolicySchema} from '../src/turnover.mjs';
import {createShoptetAdapter} from '../src/shoptet-adapter.mjs';
import {createConfigurationService} from '../src/configuration.mjs';
import {testD1} from './helpers/d1.mjs';
const customer='123e4567-e89b-42d3-a456-426614174001',other='123e4567-e89b-42d3-a456-426614174002';
const policy={period:{from:'2025-01-01T00:00:00Z',to:'2026-01-01T00:00:00Z'},qualifyingStatusIds:[4],requirePaid:true,shipping:'exclude',billing:'exclude',discounts:'after_discounts',vat:'inclusive',refunds:'exclude_order_with_valid_credit_note',guestCustomers:'exclude',itemStatuses:'require_match_order',upgrades:'recalculate',downgrades:'recalculate'};
const tiers=[{name:'First',minTurnover:5000,percent:5,pricelistId:2},{name:'Second',minTurnover:15000,percent:8,pricelistId:3}];
const line=(itemType,withVat,withoutVat=withVat)=>({itemType,status:{id:4},itemPrice:{withVat,withoutVat},amount:'99',priceRatio:'0.5000'});
const order=(extra={})=>({code:'ORDER-A',customerGuid:customer,creationTime:'2025-06-01T10:00:00+0200',changeTime:'2025-06-01T10:00:00+0200',status:{id:4},paid:true,price:{currencyCode:'CZK',withVat:'5060.00',withoutVat:'4200.00'},items:[line('product','5000.00','4140.00'),line('shipping','50.00'),line('billing','10.00')],...extra});
const note=(extra={})=>({code:'CREDIT-A',orderCode:'ORDER-A',isValid:true,customer:{guid:customer},creationTime:'2025-12-01T00:00:00Z',...extra});
const calculate=(extra={})=>calculateTurnover({customerGuid:customer,currency:'CZK',policy,tiers,orders:[order()],creditNotes:[],...extra});
test('turnover uses exact post-discount totals, excludes fees and selects inclusive threshold',()=>{
 const r=calculate();assert.equal(r.turnover,'5000.00');assert.equal(r.tier,'First');assert.equal(r.pricelistId,2);assert.equal(r.applied,false);
 assert.equal(calculate({policy:{...policy,shipping:'include',billing:'include'}}).turnover,'5060.00');
 assert.equal(calculate({policy:{...policy,vat:'exclusive'}}).turnover,'4140.00');
 assert.equal(calculate({orders:[order({price:{currencyCode:'CZK',withVat:'5059.99',withoutVat:'4200.00'}})]}).tier,null);
});
test('valid refund excludes original qualifying order once, invalid credit notes do not',()=>{
 const r=calculate({creditNotes:[note(),note({code:'CREDIT-B'})]});assert.equal(r.turnover,'0.00');assert.equal(r.excludedOrders[0].reason,'valid_credit_note');
 assert.equal(calculate({creditNotes:[note({isValid:false})]}).turnover,'5000.00');
 assert.throws(()=>calculate({creditNotes:[note({orderCode:null})]}),/unlinked_customer_credit_note/);
 assert.throws(()=>calculate({creditNotes:[note({customer:{guid:other}})]}),/customer_mismatch/);
});
test('cancelled, unpaid, out of period and guest orders never silently qualify',()=>{
 for(const o of [order({status:{id:-1}}),order({paid:false}),order({creationTime:policy.period.to})])assert.equal(calculate({orders:[o]}).turnover,'0.00');
 assert.throws(()=>calculate({orders:[order({customerGuid:null})]}),/customer_order_mismatch/);
 const mixed=order();mixed.items[0].status.id=-1;assert.throws(()=>calculate({orders:[mixed]}),/mixed_item_status/);
});
test('currency, missing VAT values, negative totals and duplicate documents fail closed',()=>{
 assert.throws(()=>calculate({currency:'EUR'}),/currency_mismatch/);
 assert.throws(()=>calculate({orders:[order({price:{currencyCode:'CZK',withVat:null,withoutVat:null}})]}),/price_missing/);
 assert.throws(()=>calculate({orders:[order(),order()]}),/duplicate_order/);
 assert.throws(()=>calculate({creditNotes:[note(),note()]}),/duplicate_credit_note/);
 assert.throws(()=>calculate({orders:[order({price:{currencyCode:'CZK',withVat:'10.00',withoutVat:'10.00'}})]}),/negative_qualifying_order/);
});
test('explicit downgrade policy can retain a mapped current tier',()=>{
 assert.equal(calculate({orders:[],currentPricelistId:3}).tier,null);
 const r=calculate({orders:[],currentPricelistId:3,policy:{...policy,downgrades:'keep_current'}});assert.equal(r.tier,'Second');assert.equal(r.downgradePrevented,true);
 assert.equal(calculate({tiers:tiers.map(({pricelistId,...t})=>t)}).mappedPricelistAvailable,false);
 assert.equal(calculate().assignmentSupported,false);
 assert.throws(()=>calculate({currentPricelistId:2,tiers:tiers.map(t=>({...t,pricelistId:2}))}),/ambiguous_current_tier_mapping/);
});
test('policy rejects invented modes, duplicate IDs and invalid periods',()=>{
 for(const p of [{...policy,refunds:'ignore'},{...policy,qualifyingStatusIds:[4,4]},{...policy,period:{from:policy.period.to,to:policy.period.from}},{...policy,vat:'write-zero-tax'}])assert.equal(turnoverPolicySchema.safeParse(p).success,false);
});
const page=items=>({items,pagination:{page:1,pageCount:1,totalCount:items.length}});
function fixture(){let writes=0;return {profile:async()=>({currencies:[{code:'CZK'}]}),pricelist:async id=>({id,currency:'CZK'}),orderStatuses:async()=>[{id:4,name:'Actual status'}],creditNotes:async()=>page([]),creditNote:async()=>note(),customer:async guid=>({guid,priceList:{id:2},priceRatio:'1.0000'}),customerOrders:async()=>page([{code:'ORDER-A',changeTime:order().changeTime}]),order:async()=>order(),writePrices:async()=>{writes++;},get writes(){return writes;}};}
const proposal={currency:'CZK',tiers,brandCaps:[],salePolicy:'lowest_price',couponPolicy:'unchanged',turnoverPolicy:policy};
test('real-data preview is bounded, rejects stale/partial/mismatched sources and never writes',async()=>{
 const adapter=fixture();const r=await previewCustomerTurnover({adapter,proposal,customers:[customer]});assert.equal(r.customers[0].turnover,'5000.00');assert.equal(adapter.writes,0);assert.equal(r.liveAssignmentsVerified,false);
 await assert.rejects(previewCustomerTurnover({adapter:{...adapter,customerOrders:async()=>({items:[],pagination:{page:1,pageCount:2,totalCount:26}})},proposal,customers:[customer]}),/collection_incomplete/);
 await assert.rejects(previewCustomerTurnover({adapter:{...adapter,order:async()=>order({changeTime:'2025-06-02T00:00:00Z'})},proposal,customers:[customer]}),/order_changed/);
 await assert.rejects(previewCustomerTurnover({adapter:{...adapter,orderStatuses:async()=>[]},proposal,customers:[customer]}),/status_reference/);
 await assert.rejects(previewCustomerTurnover({adapter:{...adapter,pricelist:async id=>({id,currency:'EUR'})},proposal,customers:[customer]}),/pricelist_reference/);
 const extra=await previewCustomerTurnover({adapter:{...adapter,customer:async guid=>({guid,priceList:{id:2},priceRatio:'0.9000'})},proposal,customers:[customer]});assert.ok(extra.customers[0].assignmentBlockers.includes('existing_customer_price_ratio_requires_review'));
 await assert.rejects(previewCustomerTurnover({adapter,proposal,customers:[customer,customer]}));
});
test('native customer/order/document adapters follow verified contracts and remove PII',async()=>{
 const routes={
  '/api/customers/groups':{customerGroups:[{id:2,name:'Members',customerGroupCode:'members',defaultPricelistId:2,emailNotification:'private'}]},
  '/api/eshop':{orderStatuses:{statuses:[{id:4,name:'Done',markAsPaid:true}]}},
  ['/api/customers/'+customer]:{customer:{guid:customer,customerGroup:{id:2,name:'Members'},priceList:{id:2,name:'Tier'},priceRatio:'1.0000',email:'private@example.test'}},
  '/api/orders':{orders:[{code:'ORDER-A',changeTime:order().changeTime,email:'private@example.test'}],paginator:{page:1,pageCount:1,totalCount:1}},
  '/api/orders/ORDER-A':{order:{...order(),email:'private@example.test',notes:'injected instruction'}},
  '/api/credit-notes':{creditNotes:[{code:'CREDIT-A',billFullName:'Private name'}],paginator:{page:1,pageCount:1,totalCount:1}},
  '/api/credit-notes/CREDIT-A':{creditNote:{...note(),billingAddress:{fullName:'Private name'}}}
 };
 const adapter=createShoptetAdapter({getToken:async()=>'token',fetchImpl:async url=>{const u=new URL(url);if(u.pathname==='/api/orders'){assert.equal(u.searchParams.get('customerGuid'),customer);assert.equal(u.searchParams.get('itemsPerPage'),'50');}return new Response(JSON.stringify({data:routes[u.pathname]}));}});
 const values=[await adapter.customerGroups(),await adapter.orderStatuses(),await adapter.customer(customer),await adapter.customerOrders(customer,{from:policy.period.from,to:policy.period.to}),await adapter.order('ORDER-A'),await adapter.creditNotes(),await adapter.creditNote('CREDIT-A')];
 assert.doesNotMatch(JSON.stringify(values),/private|Private|injected|emailNotification|billingAddress/);
 await assert.rejects(adapter.order('..'));await assert.rejects(adapter.customer('https://evil.example'));
});
test('turnover policy references are validated before immutable draft creation, and tenant access remains isolated',async()=>{
 const db=testD1();try{
  db.sql.exec("INSERT INTO installations(shop_id,state) VALUES('101','active'),('202','active')");
  const missing=createConfigurationService(db,async()=>true,async kind=>kind!=='orderStatus');await assert.rejects(missing.create('101',0,proposal),/order_status_reference/);
  const service=createConfigurationService(db,async()=>true,async()=>true),draft=await service.create('101',0,proposal);
  assert.deepEqual((await service.preview('101',draft.revisionId)).after.loyaltyProposal.turnoverPolicy,policy);
  await assert.rejects(service.preview('202',draft.revisionId),/revision_not_found/);
 }finally{db.sql.close();}
});
test('executeCustomerTierAssignment delegates to adapter.updateCustomerPricelist after input validation', async () => {
  let updated = null;
  const mockAdapter = {
    async updateCustomerPricelist(guid, pricelistId) {
      updated = { guid, pricelistId };
      return { outcome: 'accepted', customerGuid: guid, pricelistId, verified: true };
    }
  };
  const res = await executeCustomerTierAssignment({
    adapter: mockAdapter,
    customerGuid: '1f676f66-d9ea-11f1-a35a-bc241195dd28',
    targetPricelistId: 2
  });
  assert.equal(res.outcome, 'accepted');
  assert.deepEqual(updated, { guid: '1f676f66-d9ea-11f1-a35a-bc241195dd28', pricelistId: 2 });
  await assert.rejects(executeCustomerTierAssignment({ adapter: mockAdapter, customerGuid: 'invalid-guid', targetPricelistId: 2 }));
  await assert.rejects(executeCustomerTierAssignment({ adapter: mockAdapter, customerGuid: '1f676f66-d9ea-11f1-a35a-bc241195dd28', targetPricelistId: -1 }));
});
