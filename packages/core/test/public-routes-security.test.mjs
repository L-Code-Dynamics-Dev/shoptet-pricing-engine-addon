import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../../apps/api/src/index.mjs';
test('legacy public shop-ID routes cannot inspect or uninstall any tenant',async()=>{
  const env={DB:{prepare(){assert.fail('unauthenticated database access');}}};
  for(const path of ['/shoptet/status','/shoptet/uninstall','/shoptet/api-test']) {
    const response=await worker.fetch(new Request('https://addon.example'+path+'?shopId=other-shop'),env);
    assert.equal(response.status,403);
  }
});
test('public health contains no merchant identity',async()=>{
 const body=await (await worker.fetch(new Request('https://addon.example/health'),{})).json();
 assert.equal(body.liveWrites,false); assert.equal(body.partner_shop,undefined);
});
test('legacy SSE with URL credentials is permanently removed',async()=>{
 const r=await worker.fetch(new Request('https://addon.example/mcp/sse?token=secret'),{});
 assert.equal(r.status,410);assert.doesNotMatch(await r.text(),/secret/);
});
