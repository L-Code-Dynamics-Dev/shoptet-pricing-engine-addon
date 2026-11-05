import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin } from '../../../apps/api/src/admin.mjs';
import { hashToken } from '../../../apps/api/src/mcp/server.mjs';
const token='a'.repeat(48);
const digest=await hashToken(token);
function fakeDb(){let writes=0;return {get writes(){return writes;},prepare(sql){return {bind(...args){return {async first(){if(sql.includes('admin_credentials'))return args[0]===digest?{shop_id:'shop-1'}:null;if(sql.includes('SELECT state FROM installations'))return {state:'active'};return null;},async run(){writes++;return {meta:{changes:1}};}};}};}};}
const manifest=[{name:'vip_cart.js',sha256:'a'.repeat(64)}];
const request=(body,authorization=`Bearer ${token}`,origin=false)=>new Request('https://example.test/admin/asset-approvals',{method:'POST',headers:{'content-type':'application/json',authorization,...(origin?{origin:'https://evil.test'}:{})},body:JSON.stringify(body)});
test('admin issues a tenant-bound one-time approval without exposing internals',async()=>{const db=fakeDb();const res=await handleAdmin(request({releaseId:'release-1',manifest}),{DB:db});assert.equal(res.status,201);const body=await res.json();assert.match(body.approvalId,/^[a-f0-9]{64}$/);assert.equal(body.fileCount,1);assert.equal(db.writes,1);assert.ok(!JSON.stringify(body).includes('shop-1'));});
test('admin rejects invalid credentials',async()=>{const db=fakeDb();const res=await handleAdmin(request({releaseId:'release-1',manifest},`Bearer ${'b'.repeat(48)}`),{DB:db});assert.equal(res.status,401);assert.equal(db.writes,0);});
test('admin rejects browser origin and unapproved assets',async()=>{const db=fakeDb();assert.equal((await handleAdmin(request({releaseId:'release-1',manifest},undefined,true),{DB:db})).status,403);assert.equal((await handleAdmin(request({releaseId:'release-1',manifest:[{name:'other.js',sha256:'a'.repeat(64)}]}),{DB:db})).status,400);assert.equal(db.writes,0);});
test('admin rejects shop-id override',async()=>{const db=fakeDb();assert.equal((await handleAdmin(request({shopId:'shop-2',releaseId:'release-1',manifest}),{DB:db})).status,400);assert.equal(db.writes,0);});
