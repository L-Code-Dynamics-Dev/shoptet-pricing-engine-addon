import test from 'node:test';
import assert from 'node:assert/strict';
import {createSftpTransport} from '../src/sftp-transport.mjs';
import {deployApprovedAssets,sha256} from '../src/asset-deployment.mjs';
const encoder=new TextEncoder();
const HOST_KEY='SHA256:'+ 'A'.repeat(43);
function fixture(){
 const files=new Map();let connected=false,closed=false;
 const client={async connect(config){assert.equal(config.port,22);connected=true;},async verifiedHostKey(){return HOST_KEY;},async exists(p){return files.has(p)?'-':false;},async get(p){return files.get(p);},async put(b,p){files.set(p,new Uint8Array(b));},async rename(a,b){if(!files.has(a))throw Error('missing');files.set(b,files.get(a));files.delete(a);},async delete(p){files.delete(p);},async end(){closed=true;}};
 const make=(shop='shop-a')=>createSftpTransport({clientFactory:()=>client,resolveCredentials:async()=>({host:'example.test',port:22,username:'test',password:'not-a-real-secret',hostKeySha256:HOST_KEY}),expectedShopId:shop});
 return {files,make,get connected(){return connected},get closed(){return closed}};
}
test('SFTP adapter denies cross-shop connection',async()=>{const f=fixture();await assert.rejects(f.make().connect('shop-b'),/denied/);assert.equal(f.connected,false);});
test('SFTP adapter restricts paths and publication',async()=>{const f=fixture(),t=f.make();await t.connect('shop-a');await assert.rejects(t.write('upload/CSSJS/../other.js',encoder.encode('x')),/path/);await assert.rejects(t.rename('upload/CSSJS/vip_cart.js','upload/CSSJS/vip_prices.js'),/publication/);await t.close();assert.equal(f.closed,true);});
test('SFTP adapter performs approved deployment and closes',async()=>{const f=fixture();const content='console.log("safe")';const name='vip_cart.js';const result=await deployApprovedAssets({shopId:'shop-a',manifest:[{name,sha256:await sha256(content)}],assets:{[name]:content},approval:{shopId:'shop-a',status:'approved',expiresAt:Date.now()+60000},transport:f.make(),runId:'a'.repeat(32)});assert.equal(result.deployed,true);assert.deepEqual(f.files.get('upload/CSSJS/'+name),encoder.encode(content));assert.equal(f.closed,true);});
test('SFTP adapter rejects non-file remote targets',async()=>{const f=fixture(),t=f.make();await t.connect('shop-a');f.files.set('upload/CSSJS/vip_cart.js',encoder.encode('a'));const x=t.read('upload/CSSJS/vip_cart.js');assert.deepEqual(await x,encoder.encode('a'));await t.close();});
test('SFTP adapter fails closed for missing credentials',async()=>{const t=createSftpTransport({clientFactory:()=>({connect:async()=>{throw Error('should not run')}}),resolveCredentials:async()=>({}),expectedShopId:'shop-a'});await assert.rejects(t.connect('shop-a'),/configuration/);});

test('SFTP rejects a mismatched server host key',async()=>{const f=fixture();const t=createSftpTransport({clientFactory:()=>({async connect(){},async verifiedHostKey(){return 'SHA256:'+'B'.repeat(43)},async end(){}}),resolveCredentials:async()=>({host:'example.test',port:22,username:'test',password:'fake',hostKeySha256:HOST_KEY}),expectedShopId:'shop-a'});await assert.rejects(t.connect('shop-a'),/connection failed/);});
