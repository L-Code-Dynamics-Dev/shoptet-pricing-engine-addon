import test from 'node:test';
import assert from 'node:assert/strict';
import {executeApprovedInstall} from '../src/approved-install.mjs';
import {sha256} from '../src/asset-deployment.mjs';
const approvalId='A'.repeat(32);
const runId='b'.repeat(32);
const lock={withShopLock:async(_shop,fn)=>fn()};
function fixture(){
 const files=new Map(); let claims=0,connections=0;
 const transport={async connect(){connections++},async read(p){return files.get(p)??null},async write(p,v){files.set(p,v)},async rename(a,b){files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async close(){}};
 return {files,transport,claims:()=>claims,connections:()=>connections,store:{async claim({shopId}){claims++;return {shopId,status:'approved',expiresAt:Date.now()+60000,releaseId:'r1',manifest:[{name:'vip_cart.js',sha256:await sha256('safe')}]} }} };
}
test('approved install uses trusted manifest and tenant',async()=>{
 const f=fixture();const result=await executeApprovedInstall({shopId:'shop1',approvalId,approvalStore:f.store,assetProvider:{get:async()=>({'vip_cart.js':'safe'})},transportFactory:async()=>f.transport,lock,runId});
 assert.deepEqual(result,{installed:true,fileCount:1});assert.equal(f.connections(),1);assert.equal(f.claims(),1);
});
test('invalid approval ID fails before claim',async()=>{
 const f=fixture();await assert.rejects(executeApprovedInstall({shopId:'shop1',approvalId:'../x',approvalStore:f.store,assetProvider:{get:async()=>({})},transportFactory:async()=>f.transport,lock,runId}));assert.equal(f.claims(),0);
});
test('cross-shop approval fails without SFTP connection',async()=>{
 const f=fixture();f.store.claim=async()=>({shopId:'shop2',status:'approved',expiresAt:Date.now()+60000,manifest:[]});
 await assert.rejects(executeApprovedInstall({shopId:'shop1',approvalId,approvalStore:f.store,assetProvider:{get:async()=>({})},transportFactory:async()=>f.transport,lock,runId}));assert.equal(f.connections(),0);
});
test('expired approval fails closed',async()=>{
 const f=fixture();f.store.claim=async()=>({shopId:'shop1',status:'approved',expiresAt:Date.now()-1,manifest:[]});
 await assert.rejects(executeApprovedInstall({shopId:'shop1',approvalId,approvalStore:f.store,assetProvider:{get:async()=>({})},transportFactory:async()=>f.transport,lock,runId}));assert.equal(f.connections(),0);
});
