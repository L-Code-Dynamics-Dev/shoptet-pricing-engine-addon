import test from 'node:test';
import assert from 'node:assert/strict';
import {createD1ShopLock} from '../src/d1-shop-lock.mjs';
import {createR2AssetProvider} from '../src/r2-asset-provider.mjs';
import {issueAssetApproval} from '../src/admin-approval.mjs';
import {sha256} from '../src/asset-deployment.mjs';
const db={prepare(sql){return {bind(...params){return {async run(){return {meta:{changes:1}}},async first(){return {state:'active'}}}}}}};
test('R2 provider loads and checks approved asset',async()=>{
 const content='console.log(1)';const hash=await sha256(content);
 const bucket={async get(path){assert.equal(path,'releases/shop1/v1/vip_cart.js');return {async arrayBuffer(){return new TextEncoder().encode(content).buffer}}}};
 assert.equal((await createR2AssetProvider(bucket).get({shopId:'shop1',releaseId:'v1',manifest:[{name:'vip_cart.js',sha256:hash}]}))['vip_cart.js'],content);
});
test('R2 provider blocks path traversal',async()=>{
 await assert.rejects(createR2AssetProvider({get:async()=>null}).get({shopId:'../other',releaseId:'v1',manifest:[{name:'vip_cart.js',sha256:'a'.repeat(64)}]}));
});
test('R2 provider rejects tampered content',async()=>{
 await assert.rejects(createR2AssetProvider({get:async()=>({arrayBuffer:async()=>new TextEncoder().encode('tampered').buffer})}).get({shopId:'shop1',releaseId:'v1',manifest:[{name:'vip_cart.js',sha256:'a'.repeat(64)}]}),/integrity/);
});
test('approval is issued for active shop',async()=>{
 const result=await issueAssetApproval({db,shopId:'shop1',releaseId:'v1',manifest:[{name:'vip_cart.js',sha256:'a'.repeat(64)}],now:10000});
 assert.equal(result.fileCount,1);assert.equal(result.expiresAt,310000);assert.match(result.approvalId,/^[a-f0-9]{64}$/);
});
test('approval rejects invalid TTL',async()=>{
 await assert.rejects(issueAssetApproval({db,shopId:'shop1',releaseId:'v1',manifest:[{name:'vip_cart.js',sha256:'a'.repeat(64)}],ttlMs:10000000}));
});
test('D1 lock releases after callback',async()=>{
 const queries=[];const fake={prepare(sql){return {bind(...args){return {async run(){queries.push({sql,args});return {meta:{changes:1}}}}}}}};
 const lock=createD1ShopLock(fake);assert.equal(await lock.withShopLock('shop1',async()=>42),42);
 assert.equal(queries.length,2);assert.match(queries[1].sql,/DELETE FROM/);
});
test('D1 lock blocks concurrent lease',async()=>{
 const fake={prepare(sql){return {bind(){return {async run(){return {meta:{changes:0}}}}}}}};
 await assert.rejects(createD1ShopLock(fake).withShopLock('shop1',async()=>true),/already running/);
});
