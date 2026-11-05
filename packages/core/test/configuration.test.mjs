import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createConfigurationService,proposalSchema} from '../src/configuration.mjs';
import {handleMerchantMcp} from '../../../apps/api/src/mcp/gateway.mjs';
import {handleAdminSettingsApi} from '../../../apps/api/src/iframe-settings.mjs';
import {issueSession} from '../../../apps/api/src/admin-session.mjs';
import {hashToken} from '../../../apps/api/src/mcp/server.mjs';
const proposal={currency:'CZK',tiers:[{name:'První',percent:5,minTurnover:5000},{name:'Druhá',percent:8,minTurnover:15000}],brandCaps:[],salePolicy:'lowest_price',couponPolicy:'no_loyalty_combination'};
function database(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const path of ['0001_initial.sql','0002_mcp_credentials.sql','0010_configuration_revisions.sql'])sql.exec(readFileSync(new URL('../../../migrations/'+path,import.meta.url),'utf8'));
 sql.exec("INSERT INTO installations(shop_id,state) VALUES('101','active'),('202','active')");
 return {sql,prepare(query){return {bind(...args){const stmt=sql.prepare(query);return {async first(){return stmt.get(...args)??null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};}};}};}};
}
test('strict domain schema rejects ambiguous tiers and arbitrary patches',()=>{
 assert.throws(()=>proposalSchema.parse({...proposal,shopId:'202'}));
 assert.throws(()=>proposalSchema.parse({...proposal,tiers:[proposal.tiers[0],proposal.tiers[0]]}));
 assert.throws(()=>proposalSchema.parse({...proposal,brandCaps:[{id:'text-brand',percent:5}]}));
});
test('real SQLite: preview, trusted approval, atomic apply, verify, replay denial',async()=>{
 const db=database();try{const s=createConfigurationService(db);
 const d=await s.create('101',0,proposal);assert.equal((await s.preview('101',d.revisionId)).after.loyaltyProposal.currency,'CZK');
 const a=await s.requestApproval('101',d.revisionId);
 await assert.rejects(s.apply('101',a.approvalId),/approval_not_available/);
 await s.approve('101',a.approvalId,'a'.repeat(64));await s.apply('101',a.approvalId);
 assert.equal((await s.verify('101',d.revisionId)).configurationSaved,true);
 assert.equal((await s.history('101')).history.length,1);
 await assert.rejects(s.apply('101',a.approvalId),/approval_not_available/);
 assert.equal(db.sql.prepare('SELECT version FROM tenant_settings WHERE shop_id=?').get('101').version,1);
 }finally{db.sql.close();}
});
test('real SQLite: cross-tenant preview, confirmation and apply cannot cross boundaries',async()=>{
 const db=database();try{const s=createConfigurationService(db);const d=await s.create('101',0,proposal);const a=await s.requestApproval('101',d.revisionId);
 await assert.rejects(s.preview('202',d.revisionId),/revision_not_found/);
 await assert.rejects(s.approve('202',a.approvalId,'b'.repeat(64)),/approval_not_available/);
 await s.approve('101',a.approvalId,'a'.repeat(64));await assert.rejects(s.apply('202',a.approvalId),/approval_not_available/);
 }finally{db.sql.close();}
});
test('real SQLite: competing revisions cause atomic version conflict without consuming approval',async()=>{
 const db=database();try{const s=createConfigurationService(db);const d1=await s.create('101',0,proposal),d2=await s.create('101',0,{...proposal,currency:'EUR'});
 const a1=await s.requestApproval('101',d1.revisionId),a2=await s.requestApproval('101',d2.revisionId);
 for(const a of [a1,a2])await s.approve('101',a.approvalId,'a'.repeat(64));
 await s.apply('101',a1.approvalId);await assert.rejects(s.apply('101',a2.approvalId),/version_conflict/);
 assert.equal(db.sql.prepare('SELECT state FROM configuration_approvals WHERE approval_id=?').get(a2.approvalId).state,'approved');
 assert.equal((await s.history('101')).history.length,1);
 }finally{db.sql.close();}
});
test('real SQLite: immutable revision and approved action cannot be edited',async()=>{
 const db=database();try{const s=createConfigurationService(db);const d=await s.create('101',0,proposal),a=await s.requestApproval('101',d.revisionId);
 assert.throws(()=>db.sql.prepare('UPDATE configuration_revisions SET config_json=? WHERE revision_id=?').run('{}',d.revisionId),/immutable_revision/);
 assert.throws(()=>db.sql.prepare('UPDATE configuration_approvals SET expires_at=expires_at+100 WHERE approval_id=?').run(a.approvalId),/immutable_approval/);
 }finally{db.sql.close();}
});
test('reference validation rejects absent or unverified brand GUIDs',async()=>{
 const db=database();try{const s=createConfigurationService(db,async()=>false);
 await assert.rejects(s.create('101',0,{...proposal,brandCaps:[{id:crypto.randomUUID(),percent:5}]}),/brand_reference_not_verified/);
 }finally{db.sql.close();}
});
test('HTTP merchant journey: model cannot approve; authenticated admin confirms exact revision',async()=>{
 const db=database();try{
 const token='m'.repeat(48),secret='s'.repeat(64);
 db.sql.prepare('INSERT INTO mcp_credentials(token_sha256,shop_id,scopes_json) VALUES(?,?,?)').run(await hashToken(token),'101',JSON.stringify(['pricing:read','pricing:configure','pricing:execute']));
 const env={DB:db,ADMIN_SESSION_SECRET:secret};
 async function call(name,args){const r=await handleMerchantMcp(new Request('https://addon.example/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);return (await r.json()).result;}
 const draft=(await call('configuration_create_draft',{expectedVersion:0,proposal})).structuredContent;
 const a=(await call('configuration_request_approval',{revisionId:draft.revisionId})).structuredContent;
 assert.equal((await call('configuration_apply',{approvalId:a.approvalId})).isError,true);
 const forged=await handleAdminSettingsApi(new Request('https://addon.example/admin/settings/api/configuration/approve',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({approvalId:a.approvalId})}),env);
 assert.equal(forged.status,401);
 const session=await issueSession('101',secret);
 const approved=await handleAdminSettingsApi(new Request('https://addon.example/admin/settings/api/configuration/approve',{method:'POST',headers:{authorization:'Bearer '+session,origin:'https://addon.example','content-type':'application/json'},body:JSON.stringify({approvalId:a.approvalId})}),env);
 assert.equal(approved.status,200);
 const applied=(await call('configuration_apply',{approvalId:a.approvalId})).structuredContent;assert.equal(applied.configurationSaved,true);assert.equal(applied.shoptetApplied,false);
 assert.equal((await call('configuration_verify',{revisionId:draft.revisionId})).structuredContent.configurationSaved,true);
 }finally{db.sql.close();}
});
test('draft replacement invalidates authority transfer; rollback is only a new proposal',async()=>{
 const db=database();try{const s=createConfigurationService(db);
 const d=await s.create('101',0,proposal),a=await s.requestApproval('101',d.revisionId);
 const replacement=await s.update('101',d.revisionId,{...proposal,currency:'EUR'});
 assert.notEqual(replacement.revisionId,d.revisionId);
 await s.approve('101',a.approvalId,'a'.repeat(64));await s.apply('101',a.approvalId);
 assert.equal((await s.verify('101',replacement.revisionId)).configurationSaved,false);
 const d2=await s.create('101',1,{...proposal,currency:'EUR'}),a2=await s.requestApproval('101',d2.revisionId);
 await s.approve('101',a2.approvalId,'a'.repeat(64));await s.apply('101',a2.approvalId);
 const rollback=await s.rollback('101',1,2);assert.equal(rollback.requiresNewApproval,true);
 assert.equal(db.sql.prepare('SELECT version FROM tenant_settings WHERE shop_id=?').get('101').version,2);
 assert.equal((await s.preview('101',rollback.revisionId)).after.loyaltyProposal.currency,'CZK');
 }finally{db.sql.close();}
});
test('expired approval cannot be approved or applied',async()=>{
 const db=database();try{const s=createConfigurationService(db);const d=await s.create('101',0,proposal);
 const approvalId=crypto.randomUUID();db.sql.prepare("INSERT INTO configuration_approvals(shop_id,approval_id,revision_id,action,state,expires_at) VALUES(?,?,?,'save_configuration','pending',0)").run('101',approvalId,d.revisionId);
 await assert.rejects(s.approve('101',approvalId,'a'.repeat(64)),/approval_not_available/);
 await assert.rejects(s.apply('101',approvalId),/approval_not_available/);
 }finally{db.sql.close();}
});
test('all forward migrations execute on a clean SQLite database',async()=>{
 const {readdirSync}=await import('node:fs');const sql=new DatabaseSync(':memory:');
 try{sql.exec('PRAGMA foreign_keys=ON');for(const file of readdirSync(new URL('../../../migrations/',import.meta.url)).filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../../../migrations/'+file,import.meta.url),'utf8'));assert.ok(sql.prepare("SELECT name FROM sqlite_master WHERE name='configuration_apply'").get());}finally{sql.close();}
});
test('real credential table enforces expiration, revocation and installation state',async()=>{
 const db=database();try{
 const token='x'.repeat(48),hash=await hashToken(token);
 db.sql.prepare("INSERT INTO mcp_credentials(token_sha256,shop_id,scopes_json,expires_at) VALUES(?,?,'[\"pricing:read\"]','2000-01-01 00:00:00')").run(hash,'101');
 const request=()=>new Request('https://addon.example/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 assert.equal((await handleMerchantMcp(request(),{DB:db})).status,401);
 db.sql.prepare('UPDATE mcp_credentials SET expires_at=NULL,revoked_at=CURRENT_TIMESTAMP WHERE token_sha256=?').run(hash);
 assert.equal((await handleMerchantMcp(request(),{DB:db})).status,401);
 db.sql.prepare('UPDATE mcp_credentials SET revoked_at=NULL WHERE token_sha256=?').run(hash);
 db.sql.prepare("UPDATE installations SET state='suspended' WHERE shop_id='101'").run();
 assert.equal((await handleMerchantMcp(request(),{DB:db})).status,401);
 }finally{db.sql.close();}
});
