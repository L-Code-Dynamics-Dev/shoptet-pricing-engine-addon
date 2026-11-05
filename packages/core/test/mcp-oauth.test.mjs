import test from 'node:test';
import assert from 'node:assert/strict';
import {testD1} from './helpers/d1.mjs';
import {createMcpOAuth,oauthConfiguration,pkce} from '../src/mcp-oauth.mjs';
import {authenticate} from '../../../apps/api/src/mcp/server.mjs';
import {issueSession} from '../../../apps/api/src/admin-session.mjs';
import worker from '../../../apps/api/src/index.mjs';
const origin='https://addon.example',resource=origin+'/mcp',redirect='https://client.example/callback';
function setup(){const DB=testD1();DB.sql.exec("INSERT INTO installations(shop_id,state) VALUES('101','active'),('202','active')");const env={DB,MCP_PUBLIC_ORIGIN:origin,MCP_OAUTH_CLIENTS:JSON.stringify([{client_id:'client',name:'Test Client',redirect_uris:[redirect]}]),ADMIN_SESSION_SECRET:'s'.repeat(64)};return {db:DB,env,oauth:createMcpOAuth(DB,oauthConfiguration(env))};}
async function begin(oauth){const verifier='v'.repeat(64),browser='b'.repeat(64);const params={response_type:'code',client_id:'client',redirect_uri:redirect,resource,scope:'shop:read pricing:read',code_challenge_method:'S256',code_challenge:await pkce(verifier),state:'client-state'};const started=await oauth.begin(params,browser);return {...started,verifier,browser,params};}
async function authorized(oauth){const start=await begin(oauth);await oauth.consent(start.requestId,'101','a'.repeat(64));const finished=await oauth.finish(start.requestId,start.browser);return {...start,code:new URL(finished.redirect).searchParams.get('code'),finished};}
const exchangeParams=a=>({client_id:'client',resource,redirect_uri:redirect,code:a.code,code_verifier:a.verifier});
const auth=(token,env,url=resource)=>authenticate(new Request(url,{headers:{authorization:'Bearer '+token}}),env);
test('OAuth code with S256 and trusted consent yields tenant-scoped expiring access',async()=>{
 const {db,env,oauth}=setup();try{const a=await authorized(oauth);assert.equal(new URL(a.finished.redirect).searchParams.get('state'),'client-state');const tokens=await oauth.exchange(exchangeParams(a));const identity=await auth(tokens.access_token,env);assert.equal(identity.shopId,'101');assert.ok(identity.scopes.has('pricing:read'));assert.equal(tokens.expires_in,600);assert.equal(await auth(tokens.refresh_token,env),null);assert.equal(await auth(tokens.access_token,env,'https://other.example/mcp'),null);assert.doesNotMatch(JSON.stringify(db.sql.prepare('SELECT * FROM mcp_credentials').all()),new RegExp(tokens.access_token));await assert.rejects(oauth.exchange(exchangeParams(a)),/invalid_grant/);}finally{db.sql.close();}
});
test('wrong verifier, redirect, resource, client, browser and unapproved requests cannot authorize',async()=>{
 const {db,oauth}=setup();try{const pending=await begin(oauth);assert.deepEqual(await oauth.finish(pending.requestId,pending.browser),{pending:true});await assert.rejects(oauth.finish(pending.requestId,'wrong'),/invalid_request/);const a=await authorized(oauth);for(const params of [{...exchangeParams(a),code_verifier:'x'.repeat(64)},{...exchangeParams(a),redirect_uri:'https://evil.example'},{...exchangeParams(a),resource:'https://evil.example/mcp'},{...exchangeParams(a),client_id:'other'}])await assert.rejects(oauth.exchange(params));await oauth.exchange(exchangeParams(a));}finally{db.sql.close();}
});
test('refresh rotates credentials; retired refresh replay revokes the family',async()=>{
 const {db,env,oauth}=setup();try{const a=await authorized(oauth);const old=await oauth.exchange(exchangeParams(a));const rotated=await oauth.refresh({client_id:'client',resource,refresh_token:old.refresh_token});assert.equal(await auth(old.access_token,env),null);assert.equal((await auth(rotated.access_token,env)).shopId,'101');await assert.rejects(oauth.refresh({client_id:'client',resource,refresh_token:old.refresh_token}),/invalid_grant/);assert.equal(await auth(rotated.access_token,env),null);await assert.rejects(oauth.refresh({client_id:'client',resource,refresh_token:rotated.refresh_token}),/invalid_grant/);}finally{db.sql.close();}
});
test('merchant can only disconnect their own client grants',async()=>{
 const {db,env,oauth}=setup();try{const a=await authorized(oauth),tokens=await oauth.exchange(exchangeParams(a));assert.equal((await oauth.connections('202')).connections.length,0);const grant=(await oauth.connections('101')).connections[0];assert.equal((await oauth.disconnect('202',grant.grant_id)).revoked,false);assert.ok(await auth(tokens.access_token,env));await oauth.disconnect('101',grant.grant_id);assert.equal(await auth(tokens.access_token,env),null);}finally{db.sql.close();}
});
test('authorization refuses unregistered redirects, plain PKCE, unsupported scopes and expiry',async()=>{
 const {db,oauth}=setup();try{const a=await begin(oauth);for(const params of [{...a.params,redirect_uri:'https://evil.example/cb'},{...a.params,code_challenge_method:'plain'},{...a.params,scope:'admin:all'}])await assert.rejects(oauth.begin(params,a.browser));db.sql.prepare('UPDATE mcp_authorizations SET expires_at=0 WHERE request_id=?').run(a.requestId);await assert.rejects(oauth.consent(a.requestId,'101','a'.repeat(64)),/access_denied/);await assert.rejects(oauth.finish(a.requestId,a.browser),/invalid_request/);}finally{db.sql.close();}
});
test('HTTP authorize → signed-admin consent → browser callback → token → MCP',async()=>{
 const {db,env}=setup();try{
 const verifier='v'.repeat(64);const params={response_type:'code',client_id:'client',redirect_uri:redirect,resource,scope:'shop:read',code_challenge_method:'S256',code_challenge:await pkce(verifier),state:'opaque-state'};
 const started=await worker.fetch(new Request(origin+'/oauth/authorize?'+new URLSearchParams(params)),env);
 assert.equal(started.status,200);const cookie=started.headers.get('set-cookie').split(';')[0];assert.match(started.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);const html=await started.text();const requestId=/<code>([a-f0-9]{64})<\/code>/.exec(html)[1];
 const session=await issueSession('101',env.ADMIN_SESSION_SECRET);
 const consent=await worker.fetch(new Request(origin+'/admin/settings/api/oauth/consent',{method:'POST',headers:{authorization:'Bearer '+session,origin,'content-type':'application/json'},body:JSON.stringify({requestId})}),env);assert.equal(consent.status,200);
 const finished=await worker.fetch(new Request(origin+'/oauth/finish',{method:'POST',headers:{cookie,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request_id:requestId})}),env);const callback=new URL((await finished.json()).redirect);assert.equal(callback.searchParams.get('state'),'opaque-state');
 const response=await worker.fetch(new Request(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:'client',code:callback.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier,resource})}),env);assert.equal(response.status,200);const tokens=await response.json();
 const tools=await worker.fetch(new Request(resource,{method:'POST',headers:{authorization:'Bearer '+tokens.access_token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env);const result=await tools.json();assert.ok(result.result.tools.some(t=>t.name==='shop_get_status'));assert.ok(!result.result.tools.some(t=>t.name==='configuration_apply'));
 }finally{db.sql.close();}
});
test('metadata discovery advertises PKCE and challenge without credentials',async()=>{
 const {db,env}=setup();try{const metadata=await (await worker.fetch(new Request(origin+'/.well-known/oauth-authorization-server'),env)).json();assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);const protectedResource=await (await worker.fetch(new Request(origin+'/.well-known/oauth-protected-resource/mcp'),env)).json();assert.equal(protectedResource.resource,resource);const denied=await worker.fetch(new Request(resource,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),env);assert.match(denied.headers.get('www-authenticate'),/resource_metadata=/);}finally{db.sql.close();}
});
test('concurrent refresh permits only one rotation and revokes family on detected reuse',async()=>{
 const {db,env,oauth}=setup();try{const a=await authorized(oauth),old=await oauth.exchange(exchangeParams(a));const params={client_id:'client',resource,refresh_token:old.refresh_token};const results=await Promise.allSettled([oauth.refresh(params),oauth.refresh(params)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);const issued=results.find(r=>r.status==='fulfilled').value;assert.equal(await auth(issued.access_token,env),null);}finally{db.sql.close();}
});
test('HTTP denies foreign origins, duplicate parameters, missing browser proof and unauthenticated consent',async()=>{
 const {db,env,oauth}=setup();try{
 const a=await begin(oauth);
 const consent=await worker.fetch(new Request(origin+'/admin/settings/api/oauth/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId:a.requestId})}),env);assert.equal(consent.status,401);
 const finish=await worker.fetch(new Request(origin+'/oauth/finish',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request_id:a.requestId})}),env);assert.equal(finish.status,400);
 const evil=await worker.fetch(new Request(origin+'/oauth/token',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/x-www-form-urlencoded'},body:'grant_type=refresh_token'}),env);assert.equal(evil.status,403);
 const dup=await worker.fetch(new Request(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'client_id=client&client_id=evil'}),env);assert.equal(dup.status,400);
 const bucket=await (await import('../src/mcp-oauth.mjs')).digest('/oauth/token:unknown');db.sql.prepare('INSERT OR REPLACE INTO mcp_oauth_rate_limits(bucket,window,requests) VALUES(?,?,120)').run(bucket,Math.floor(Date.now()/60000));const limited=await worker.fetch(new Request(origin+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:''}),env);assert.equal(limited.status,429);
 }finally{db.sql.close();}
});
test('RFC7009-style token revocation invalidates the whole grant without leaking token validity',async()=>{
 const {db,env,oauth}=setup();try{const a=await authorized(oauth),tokens=await oauth.exchange(exchangeParams(a));const r=await worker.fetch(new Request(origin+'/oauth/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'client',token:tokens.refresh_token})}),env);assert.equal(r.status,200);assert.equal(await auth(tokens.access_token,env),null);assert.deepEqual(await oauth.revoke({client_id:'client',token:'unknown'}),{});}finally{db.sql.close();}
});
