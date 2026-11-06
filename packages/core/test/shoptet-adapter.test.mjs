import test from 'node:test';
import assert from 'node:assert/strict';
import {createShoptetAdapter} from '../src/shoptet-adapter.mjs';
const response=(data,status=200)=>new Response(JSON.stringify({data}),{status});
test('catalog uses fixed origin, bounded pagination and minimizes fields',async()=>{const a=createShoptetAdapter({getToken:async()=>'token',fetchImpl:async(url,options)=>{assert.equal(url,'https://api.myshoptet.com/api/brands?page=2&itemsPerPage=5');assert.equal(options.redirect,'error');return response({brands:[{guid:'brand-guid',name:'Other brand',secret:'hidden'}]});}});const r=await a.list('brands',{page:2,limit:5});assert.deepEqual(r.items,[{guid:'brand-guid',name:'Other brand'}]);await assert.rejects(a.list('https://evil.example'),/invalid_parameters/);});
test('rate limit bounded retries then permission error without upstream body',async()=>{let n=0;const a=createShoptetAdapter({getToken:async()=>'secret',sleep:async()=>{},fetchImpl:async()=>++n<3?response({},429):new Response('sensitive error',{status:403})});await assert.rejects(a.list('products'),/permission_missing/);assert.equal(n,3);});
test('timeouts are mapped and invalid API payload fails closed',async()=>{let a=createShoptetAdapter({getToken:async()=>'x',fetchImpl:async()=>{throw Error('secret');}});await assert.rejects(a.profile(),/upstream_unavailable/);a=createShoptetAdapter({getToken:async()=>'x',fetchImpl:async()=>response({brands:'not array'})});await assert.rejects(a.list('brands'),/invalid_collection/);});
test('search reports page-local completeness and preserves verified identifier',async()=>{const a=createShoptetAdapter({getToken:async()=>'x',fetchImpl:async()=>response({brands:[{guid:'id1',name:'Šípek'},{guid:'id2',name:'Other'}],paginator:{currentPage:1}})});const r=await a.list('brands',{query:'šíp'});assert.equal(r.items[0].guid,'id1');assert.equal(r.searchScope,'returned_page_only');});
test('official direct-data brand detail and nested shop profile are normalized without personal fields',async()=>{
 const guid='123e4567-e89b-42d3-a456-426614174001';const a=createShoptetAdapter({getToken:async()=>'x',fetchImpl:async url=>url.includes('/brands/')?response({guid,name:'Test maker',indexName:'test-maker',contactEmail:'private@example.test'}):response({contactInformation:{eshopId:101,eshopName:'Test',email:'private@example.test'},settings:{vatPayer:true,defaultPricelist:{id:1},timezone:'Europe/Prague'},currencies:[{code:'EUR',priceDecimalPlaces:2,rounding:'math',bankAccount:{iban:'secret'}}]})});
 assert.equal(await a.verifyBrand(guid),true);assert.equal((await a.brand(guid)).guid,guid);const profile=await a.profile();assert.equal(profile.vatPayer,true);assert.doesNotMatch(JSON.stringify(profile),/private|secret|iban/);
});
test('native PATCH uses current endpoint and reports 200 partial failures without retrying',async()=>{
 let calls=0;const a=createShoptetAdapter({getToken:async()=>'x',authorizeWrite:async()=>{},fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.myshoptet.com/api/price-lists/2/prices');assert.equal(options.method,'PATCH');assert.deepEqual(JSON.parse(options.body),{data:[{code:'TEST/A',priceWithVat:{price:'95.00'}}]});return new Response(JSON.stringify({data:null,errors:[{errorCode:'pricelist-code-not-found',instance:'TEST/A',message:'sensitive upstream detail'}]}));}});
 const r=await a.writePrices(2,[{code:'TEST/A',priceWithVat:{price:'95.00'}}]);assert.equal(r.outcome,'partial');assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(r),/sensitive/);
});
test('native PATCH timeout is unknown, never retried; default adapter forbids writes',async()=>{
 let calls=0;const patch={code:'TEST/A',priceWithVat:{price:'95.00'}};
 const off=createShoptetAdapter({getToken:async()=>'x',fetchImpl:async()=>{assert.fail('no fetch allowed');}});await assert.rejects(off.writePrices(2,[patch]),/write_not_authorized/);
 const a=createShoptetAdapter({getToken:async()=>'x',authorizeWrite:async()=>{},fetchImpl:async()=>{calls++;throw Error('timeout');}});assert.equal((await a.writePrices(2,[patch])).outcome,'unknown');assert.equal(calls,1);
});

test('updateCustomerPricelist validates customer state, permissions, destination pricelist, patches and verifies readback', async () => {
  const customerGuid = '1f676f66-d9ea-11f1-a35a-bc241195dd28';
  let customerPricelistId = 1;
  let priceRatio = '1.0000';
  let patchCalls = 0;
  let authorizeCalls = 0;

  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://api.myshoptet.com/api/customers/' + customerGuid) {
      if (options.method === 'PATCH') {
        patchCalls++;
        const body = JSON.parse(options.body);
        assert.equal(body.data.pricelistId, 2);
        customerPricelistId = body.data.pricelistId;
        return response({ customer: { guid: customerGuid, priceList: { id: 2, name: 'VIP 1' }, priceRatio } });
      }
      return response({ customer: { guid: customerGuid, customerGroup: null, priceList: { id: customerPricelistId, name: 'Pricelist ' + customerPricelistId }, priceRatio } });
    }
    if (url === 'https://api.myshoptet.com/api/price-lists/2') {
      return response({ priceList: { id: 2, name: 'VIP 1', currency: 'CZK', isDefault: false } });
    }
    throw Error('unexpected url: ' + url);
  };

  // 1. Without authorizeWrite: fails closed
  const unauth = createShoptetAdapter({ getToken: async () => 'token', fetchImpl });
  await assert.rejects(unauth.updateCustomerPricelist(customerGuid, 2), /write_not_authorized/);

  // 2. Individual price ratio blocks assignment
  priceRatio = '0.9000';
  const adapter = createShoptetAdapter({
    getToken: async () => 'token',
    authorizeWrite: async () => { authorizeCalls++; },
    fetchImpl
  });
  const blockedRes = await adapter.updateCustomerPricelist(customerGuid, 2);
  assert.equal(blockedRes.outcome, 'blocked');
  assert.equal(blockedRes.reason, 'price_ratio_locked');
  assert.equal(patchCalls, 0);

  // 3. Normal customer promotion: patches and readback verifies
  priceRatio = '1.0000';
  customerPricelistId = 1;
  const successRes = await adapter.updateCustomerPricelist(customerGuid, 2);
  assert.equal(successRes.outcome, 'accepted');
  assert.equal(successRes.previousPricelistId, 1);
  assert.equal(successRes.pricelistId, 2);
  assert.equal(successRes.verified, true);
  assert.equal(patchCalls, 1);

  // 4. If customer already on target pricelist: no_change, no PATCH
  const noChangeRes = await adapter.updateCustomerPricelist(customerGuid, 2);
  assert.equal(noChangeRes.outcome, 'no_change');
  assert.equal(patchCalls, 1); // Not incremented!

  // 5. Timeout on PATCH returns outcome: unknown without retry
  let timeoutAdapter = createShoptetAdapter({
    getToken: async () => 'token',
    authorizeWrite: async () => {},
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'PATCH') throw Error('timeout');
      if (url.includes('/api/customers/')) return response({ customer: { guid: customerGuid, customerGroup: null, priceList: { id: 1, name: 'Standard' }, priceRatio: '1.0000' } });
      if (url.includes('/api/price-lists/2')) return response({ priceList: { id: 2, name: 'VIP 1', currency: 'CZK', isDefault: false } });
      throw Error('unexpected');
    }
  });
  const timeoutRes = await timeoutAdapter.updateCustomerPricelist(customerGuid, 2);
  assert.equal(timeoutRes.outcome, 'unknown');
  assert.equal(timeoutRes.requiresReadback, true);
});
