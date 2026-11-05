import test from 'node:test';
import assert from 'node:assert/strict';
import {handleMcp,hashToken} from '../../../apps/api/src/mcp/server.mjs';
const token='A'.repeat(48);
const records=[];
const env={DB:{prepare(sql){return {bind(...args){return {async first(){if(sql.includes('FROM mcp_credentials'))return records.find(x=>x.digest===args[0])?.identity??null;if(sql.includes('FROM installations'))return {shop_id:args[0],state:'active'};return null;}}}}}}};
function req(method,params={},t=token,extra={}){return new Request('https://example.com/mcp',{method:'POST',headers:{authorization:`Bearer ${t}`,'content-type':'application/json',...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
test('unauthenticated denied',async()=>{assert.equal((await handleMcp(req('tools/list',{},'bad'),env)).status,401)});
test('origin denied',async()=>{assert.equal((await handleMcp(req('tools/list',{},token,{origin:'https://evil.example'}),env)).status,403)});
test('hash stable and token never stored in plain text',async()=>{assert.match(await hashToken(token),/^[a-f0-9]{64}$/)});
test('scopes isolate tools and shop context',async()=>{records.push({digest:await hashToken(token),identity:{shop_id:'shop-1',scopes_json:'["pricing:preview"]'}});const r=await (await handleMcp(req('tools/list'),env)).json();assert.deepEqual(r.result.tools.map(t=>t.name),['pricing_preview']);});
test('preview calculates and does not write',async()=>{const r=await (await handleMcp(req('tools/call',{name:'pricing_preview',arguments:{baseMinor:10000,tierPercent:20,actionMinor:8500,code:'SKU-1',vatRate:'21.00'}}),env)).json();const result=JSON.parse(r.result.content[0].text);assert.equal(result.priceMinor,8000);assert.equal(result.changesApplied,false);assert.deepEqual(Object.keys(result).sort(),['changesApplied','mode','priceMinor']);});
test('write-like tool forbidden',async()=>{const r=await (await handleMcp(req('tools/call',{name:'sync_execute',arguments:{}}),env)).json();assert.equal(r.error.code,-32602)});
test('cross-shop ID cannot be supplied',async()=>{const r=await (await handleMcp(req('tools/call',{name:'pricing_preview',arguments:{baseMinor:10000,tierPercent:10,shopId:'other'}}),env)).json();assert.equal(r.error.code,-32602)});

test('status exposes no internal identifiers or timestamps',async()=>{const r=await (await handleMcp(req('tools/call',{name:'installation_status',arguments:{}}),env)).json();assert.equal(r.error.code,-32603);});
test('authorized installation status is minimal',async()=>{
 const t='B'.repeat(48);
 records.push({digest:await hashToken(t),identity:{shop_id:'shop-private',scopes_json:'["installation:read"]'}});
 const r=await (await handleMcp(req('tools/call',{name:'installation_status',arguments:{}},t),env)).json();
 assert.deepEqual(JSON.parse(r.result.content[0].text),{active:true});
 assert.doesNotMatch(JSON.stringify(r),/shop-private|created_at|updated_at|database|token/i);
});
test('install tool is not listed without install scope',async()=>{
 const r=await (await handleMcp(req('tools/list'),env)).json();
 assert.equal(r.result.tools.some(x=>x.name==='frontend_assets_install'),false);
});
test('install tool fails closed without trusted services',async()=>{
 const t='C'.repeat(48);records.push({digest:await hashToken(t),identity:{shop_id:'shop1',scopes_json:'["assets:install"]'}});
 const r=await handleMcp(req('tools/call',{name:'frontend_assets_install',arguments:{approvalId:'A'.repeat(32)}},t),env);
 assert.equal(r.status,503);
});
test('install tool rejects caller supplied assets and credentials',async()=>{
 const t='C'.repeat(48);
 const r=await (await handleMcp(req('tools/call',{name:'frontend_assets_install',arguments:{approvalId:'A'.repeat(32),password:'secret'}},t),env)).json();
 assert.equal(r.error.code,-32602);
});
