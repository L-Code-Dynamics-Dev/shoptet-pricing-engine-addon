import test from 'node:test';
import assert from 'node:assert/strict';
import {sha256,validateAssetManifest,deploymentPreview,deployApprovedAssets} from '../src/asset-deployment.mjs';
const RUN='a'.repeat(32);
const approval={shopId:'shop-1',status:'approved',expiresAt:Date.now()+60000};
const content='console.log("frontend")';
const manifest=async()=>[{name:'vip_detail.js',sha256:await sha256(content)}];
const setup=(initial={},failRenameAt=0)=>{
  const files=new Map(Object.entries(initial).map(([k,v])=>[k,new TextEncoder().encode(v)]));
  const calls=[];let renames=0;
  const transport={
    async connect(id){calls.push(['connect',id]);},
    async read(path){calls.push(['read',path]);return files.has(path)?files.get(path):null;},
    async write(path,data){calls.push(['write',path]);files.set(path,new Uint8Array(data));},
    async rename(from,to){calls.push(['rename',from,to]);if(!files.has(from))throw Error('missing stage');files.set(to,files.get(from));files.delete(from);if(++renames===failRenameAt)throw Error('remote rename failed');},
    async remove(path){calls.push(['remove',path]);files.delete(path);},
    async close(){calls.push(['close']);}
  };return {files,calls,transport};
};
test('allowlist and manifest validation',async()=>{
  assert.throws(()=>validateAssetManifest([{name:'../secret.js',sha256:'a'.repeat(64)}]));
  assert.throws(()=>validateAssetManifest([{name:'vip_detail.js',sha256:'a'.repeat(64)},{name:'vip_detail.js',sha256:'b'.repeat(64)}]));
  assert.deepEqual(deploymentPreview(await manifest()),{readyForApproval:true,files:['vip_detail.js'],fileCount:1,changesApplied:false});
});
test('approval and tenant binding before connect',async()=>{
  const s=setup();await assert.rejects(deployApprovedAssets({shopId:'shop-1',manifest:await manifest(),assets:{'vip_detail.js':content},approval:{...approval,shopId:'shop-2'},transport:s.transport,runId:RUN}),/not authorized/);
  assert.equal(s.calls.length,0);
});
test('integrity and run identifier before connect',async()=>{
  const s=setup();await assert.rejects(deployApprovedAssets({shopId:'shop-1',manifest:await manifest(),assets:{'vip_detail.js':'changed'},approval,transport:s.transport,runId:RUN}),/integrity/);
  await assert.rejects(deployApprovedAssets({shopId:'shop-1',manifest:await manifest(),assets:{'vip_detail.js':content},approval,transport:s.transport,runId:'../bad'}),/Invalid deployment/);
  assert.equal(s.calls.length,0);
});
test('successful deploy stages and publishes approved asset',async()=>{
  const s=setup();const result=await deployApprovedAssets({shopId:'shop-1',manifest:await manifest(),assets:{'vip_detail.js':content},approval,transport:s.transport,runId:RUN});
  assert.deepEqual(result,{deployed:true,fileCount:1});
  assert.equal(new TextDecoder().decode(s.files.get('upload/CSSJS/vip_detail.js')),content);
  assert.equal(s.files.size,1);assert.deepEqual(s.calls.at(-1),['close']);
});
test('failed remote rename restores existing file and cleans stages',async()=>{
  const path='upload/CSSJS/vip_detail.js';const s=setup({[path]:'old version'},1);
  await assert.rejects(deployApprovedAssets({shopId:'shop-1',manifest:await manifest(),assets:{'vip_detail.js':content},approval,transport:s.transport,runId:RUN}),/remote rename failed/);
  assert.equal(new TextDecoder().decode(s.files.get(path)),'old version');assert.equal(s.files.size,1);
  assert.deepEqual(s.calls.at(-1),['close']);
});
test('failed second publish rolls back both existing and newly created assets',async()=>{
  const first='upload/CSSJS/vip_detail.js',second='upload/CSSJS/vip_prices.js';
  const s=setup({[first]:'original'},2);
  const two=[{name:'vip_detail.js',sha256:await sha256(content)},{name:'vip_prices.js',sha256:await sha256('new')}];
  await assert.rejects(deployApprovedAssets({shopId:'shop-1',manifest:two,assets:{'vip_detail.js':content,'vip_prices.js':'new'},approval,transport:s.transport,runId:RUN}),/remote rename failed/);
  assert.equal(new TextDecoder().decode(s.files.get(first)),'original');assert.equal(s.files.has(second),false);assert.equal(s.files.size,1);
});
