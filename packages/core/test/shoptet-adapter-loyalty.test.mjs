import test from 'node:test';
import assert from 'node:assert/strict';
import { createShoptetAdapter } from '../src/shoptet-adapter.mjs';

const response = (data, status = 200) => new Response(JSON.stringify({ data }), { status });

test('createPricelist requires authorizeWrite and calls POST /api/pricelists', async () => {
  let postCalls = 0;
  let authCalls = 0;
  const a = createShoptetAdapter({
    getToken: async () => 'test-token',
    authorizeWrite: async (payload) => {
      authCalls++;
      assert.equal(payload.action, 'createPricelist');
      assert.equal(payload.name, 'Věrnostní úroveň 1');
    },
    fetchImpl: async (url, options = {}) => {
      postCalls++;
      assert.equal(url, 'https://api.myshoptet.com/api/pricelists');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { data: { name: 'Věrnostní úroveň 1' } });
      return response({ id: 10, name: 'Věrnostní úroveň 1' }, 201);
    }
  });

  const res = await a.createPricelist({ name: 'Věrnostní úroveň 1' });
  assert.equal(authCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.pricelist.id, 10);
  assert.equal(res.pricelist.name, 'Věrnostní úroveň 1');
});

test('createPricelist fails closed without authorizeWrite', async () => {
  const unauth = createShoptetAdapter({
    getToken: async () => 'token',
    fetchImpl: async () => assert.fail('no fetch allowed')
  });
  await assert.rejects(unauth.createPricelist({ name: 'VIP' }), /write_not_authorized/);
});

test('createPricelist handles 403 Forbidden without throwing unhandled exception', async () => {
  const a = createShoptetAdapter({
    getToken: async () => 'token',
    authorizeWrite: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      errors: [{ errorCode: 'forbidden', message: 'Insufficient scope for pricelists write' }]
    }), { status: 403 })
  });

  const res = await a.createPricelist({ name: 'VIP' });
  assert.equal(res.outcome, 'failed');
  assert.equal(res.error, 'permission_missing');
  assert.equal(res.status, 403);
});

test('createCustomerGroup requires authorizeWrite and calls POST /api/customers/groups', async () => {
  let postCalls = 0;
  let authCalls = 0;
  const a = createShoptetAdapter({
    getToken: async () => 'test-token',
    authorizeWrite: async (payload) => {
      authCalls++;
      assert.equal(payload.action, 'createCustomerGroup');
      assert.equal(payload.name, 'VIP Zákazníci');
      assert.equal(payload.defaultPricelistId, 10);
    },
    fetchImpl: async (url, options = {}) => {
      postCalls++;
      assert.equal(url, 'https://api.myshoptet.com/api/customers/groups');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { data: { name: 'VIP Zákazníci', defaultPricelistId: 10 } });
      return response({ id: 5, name: 'VIP Zákazníci', defaultPricelistId: 10 }, 201);
    }
  });

  const res = await a.createCustomerGroup({ name: 'VIP Zákazníci', defaultPricelistId: 10 });
  assert.equal(authCalls, 1);
  assert.equal(postCalls, 1);
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.customerGroup.id, 5);
  assert.equal(res.customerGroup.defaultPricelistId, 10);
});

test('createCustomerGroup handles 403 Forbidden without pretending success', async () => {
  const a = createShoptetAdapter({
    getToken: async () => 'token',
    authorizeWrite: async () => {},
    fetchImpl: async () => new Response(JSON.stringify({
      errors: [{ errorCode: 'forbidden', message: 'Customer groups write not granted' }]
    }), { status: 403 })
  });

  const res = await a.createCustomerGroup({ name: 'VIP Zákazníci', defaultPricelistId: 10 });
  assert.equal(res.outcome, 'failed');
  assert.equal(res.error, 'permission_missing');
  assert.equal(res.status, 403);
});

test('updateCustomerGroup links customer group to default pricelist via PATCH', async () => {
  let patchCalls = 0;
  const a = createShoptetAdapter({
    getToken: async () => 'token',
    authorizeWrite: async () => {},
    fetchImpl: async (url, options = {}) => {
      patchCalls++;
      assert.equal(url, 'https://api.myshoptet.com/api/customers/groups/5');
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(JSON.parse(options.body), { data: { defaultPricelistId: 12 } });
      return response({ id: 5, defaultPricelistId: 12 });
    }
  });

  const res = await a.updateCustomerGroup(5, { defaultPricelistId: 12 });
  assert.equal(patchCalls, 1);
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.id, 5);
  assert.equal(res.defaultPricelistId, 12);
});
