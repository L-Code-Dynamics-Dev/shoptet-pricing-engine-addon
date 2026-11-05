import test from 'node:test';
import assert from 'node:assert/strict';
import {createD1ApprovalStore} from '../src/d1-approval-store.mjs';
const approvalId='a'.repeat(32);
const row={shop_id:'shop1',release_id:'r1',manifest_json:'[{"name":"vip_cart.js","sha256":"'+'b'.repeat(64)+'"}]',expires_at_ms:2000,state:'approved',claimed_at_ms:null};
function fakeDb(){
  const data={...row};let updates=0;
  return {data,updates:()=>updates,prepare(sql){return {bind(...args){return {
    async run(){updates++;const [time,id,shop,expiry]=args;const valid=id===approvalId&&shop===data.shop_id&&data.state==='approved'&&data.expires_at_ms>expiry;if(valid){data.state='claimed';data.claimed_at_ms=time;}return {meta:{changes:valid?1:0}};},
    async first(){const [id,shop,time]=args;return id===approvalId&&shop===data.shop_id&&data.state==='claimed'&&time===data.claimed_at_ms?{...data}:null;}
  };}};}};
}
test('approval claimed once; replay denied',async()=>{const db=fakeDb();const store=createD1ApprovalStore(db,()=>1000);const first=await store.claim({shopId:'shop1',approvalId});assert.equal(first.status,'approved');assert.equal(first.manifest[0].name,'vip_cart.js');assert.equal(await store.claim({shopId:'shop1',approvalId}),null);});
test('wrong tenant cannot consume approval',async()=>{const db=fakeDb();const store=createD1ApprovalStore(db,()=>1000);assert.equal(await store.claim({shopId:'shop2',approvalId}),null);assert.equal(db.data.state,'approved');});
test('expired approval cannot be consumed',async()=>{const db=fakeDb();const store=createD1ApprovalStore(db,()=>2000);assert.equal(await store.claim({shopId:'shop1',approvalId}),null);});
test('malformed ID rejected before database query',async()=>{const db=fakeDb();const store=createD1ApprovalStore(db,()=>1000);assert.equal(await store.claim({shopId:'shop1',approvalId:'../oops'}),null);assert.equal(db.updates(),0);});
test('corrupt manifest fails closed after claim',async()=>{const db=fakeDb();db.data.manifest_json='invalid';const store=createD1ApprovalStore(db,()=>1000);await assert.rejects(store.claim({shopId:'shop1',approvalId}),/Invalid approved manifest/);assert.equal(db.data.state,'claimed');});
