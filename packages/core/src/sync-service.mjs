import {buildSyncPlan,syncSelectionSchema} from './sync-planner.mjs';
import {digest} from './crypto.mjs';
export class SyncError extends Error {}
const now=()=>Math.floor(Date.now()/1000);
export function createSyncService({db,adapter,assertLiveAllowed=async()=>{throw new SyncError('live_execution_not_activated');}}) {
 const first=(sql,...args)=>db.prepare(sql).bind(...args).first();
 async function plan(shop,id){const r=await first('SELECT * FROM sync_execution_plans WHERE shop_id=? AND plan_id=?',shop,id);if(!r)throw new SyncError('plan_not_found');if(await digest(r.plan_json)!==r.sha256)throw new SyncError('plan_integrity_failed');return {...r,data:JSON.parse(r.plan_json)};}
 async function revision(shop,id){const r=await first('SELECT * FROM configuration_revisions WHERE shop_id=? AND revision_id=?',shop,id);if(!r)throw new SyncError('revision_not_found');return r;}
 async function activeVersion(shop,p){const r=await first("SELECT t.version,i.state FROM tenant_settings t JOIN installations i ON i.shop_id=t.shop_id WHERE t.shop_id=?",shop);if(r?.state!=='active'||r.version!==p.settings_version)throw new SyncError('configuration_changed_or_installation_inactive');if(p.expires_at<=now())throw new SyncError('plan_expired');}
 return {
  async preview(shop,selection){syncSelectionSchema.parse(selection);const r=await revision(shop,selection.revisionId);const data=await buildSyncPlan({adapter,proposal:JSON.parse(r.config_json).loyaltyProposal,selection});return {plan:data,changesApplied:false};},
  async plan(shop,selection){const r=await revision(shop,selection.revisionId);const current=await first('SELECT version,config_json FROM tenant_settings WHERE shop_id=?',shop);if(current?.version!==r.base_version+1||current.config_json!==r.config_json)throw new SyncError('saved_revision_required');const data=await buildSyncPlan({adapter,proposal:JSON.parse(r.config_json).loyaltyProposal,selection});const planId=crypto.randomUUID(),approvalId=crypto.randomUUID(),encoded=JSON.stringify(data),hash=await digest(encoded),expiry=Math.floor(data.expiresAt/1000);
   await db.batch([
    db.prepare('INSERT INTO sync_execution_plans(shop_id,plan_id,revision_id,settings_version,plan_json,sha256,expires_at) VALUES(?,?,?,?,?,?,?)').bind(shop,planId,r.revision_id,current.version,encoded,hash,expiry),
    db.prepare("INSERT INTO sync_execution_approvals(shop_id,approval_id,plan_id,plan_sha256,state,expires_at) VALUES(?,?,?,?,'pending',?)").bind(shop,approvalId,planId,hash,expiry)
   ]);return {planId,approvalId,sha256:hash,plan:data,approvalRequired:true,changesApplied:false};},
  async getPlan(shop,id){const r=await plan(shop,id);return {planId:r.plan_id,sha256:r.sha256,plan:r.data,settingsVersion:r.settings_version};},
  async pending(shop){return {approvals:(await db.prepare("SELECT approval_id,plan_id,expires_at FROM sync_execution_approvals WHERE shop_id=? AND state='pending' AND expires_at>unixepoch() ORDER BY expires_at LIMIT 30").bind(shop).all()).results};},
  async approve(shop,id,sessionHash){if(!/^[a-f0-9]{64}$/.test(sessionHash??''))throw new SyncError('admin_session_required');const a=await first('SELECT plan_id FROM sync_execution_approvals WHERE shop_id=? AND approval_id=?',shop,id);if(!a)throw new SyncError('approval_not_found');const p=await plan(shop,a.plan_id);await activeVersion(shop,p);
   const result=await db.prepare("UPDATE sync_execution_approvals SET state='approved',approved_by=? WHERE shop_id=? AND approval_id=? AND state='pending' AND expires_at>unixepoch()").bind(sessionHash,shop,id).run();if(!result.meta?.changes)throw new SyncError('approval_unavailable');return {approved:true};},
  async execute(shop,id,mode='dry-run',approvalId=null){if(!['dry-run','live'].includes(mode))throw new SyncError('invalid_mode');const p=await plan(shop,id);const key='plan:'+id+':'+mode;const existing=await first('SELECT job_id FROM sync_jobs WHERE shop_id=? AND idempotency_key=?',shop,key);if(existing)return this.progress(shop,existing.job_id);await activeVersion(shop,p);
   if(mode==='live')await assertLiveAllowed({shopId:shop,plan:p.data,planId:id});
   const jobId=crypto.randomUUID();const statements=[];
   if(mode==='live'){
    statements.push(db.prepare("UPDATE sync_execution_approvals SET state='consumed',consumed_job_id=? WHERE shop_id=? AND approval_id=? AND plan_id=? AND plan_sha256=? AND state='approved' AND expires_at>unixepoch()").bind(jobId,shop,approvalId,id,p.sha256));
    statements.push(db.prepare("INSERT INTO sync_jobs(job_id,shop_id,state,idempotency_key,plan_id,mode,updated_at) SELECT ?,?,'queued',?,?,'live',unixepoch() WHERE EXISTS(SELECT 1 FROM sync_execution_approvals WHERE shop_id=? AND consumed_job_id=?)").bind(jobId,shop,key,id,shop,jobId));
   }else statements.push(db.prepare("INSERT INTO sync_jobs(job_id,shop_id,state,idempotency_key,plan_id,mode,updated_at) VALUES(?,?,'queued',? ,?,'dry-run',unixepoch())").bind(jobId,shop,key,id));
   const inserted=mode==='live'?1:0;
   for(let i=0;i<p.data.actions.length;i++)statements.push(db.prepare("INSERT INTO sync_job_items(shop_id,job_id,sequence,state) SELECT ?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM sync_jobs WHERE shop_id=? AND job_id=?)").bind(shop,jobId,i,shop,jobId));
   const results=await db.batch(statements);if(!results[inserted].meta?.changes)throw new SyncError('approval_unavailable');return this.progress(shop,jobId);},
  async progress(shop,id){const j=await first('SELECT * FROM sync_jobs WHERE shop_id=? AND job_id=?',shop,id);if(!j)throw new SyncError('job_not_found');const items=(await db.prepare('SELECT sequence,state,attempts,error_code,changed FROM sync_job_items WHERE shop_id=? AND job_id=? ORDER BY sequence').bind(shop,id).all()).results;
   return {jobId:j.job_id,planId:j.plan_id,state:j.state,mode:j.mode,checkpoint:j.checkpoint,total:items.length,verifiedCount:j.verified_count,changedCount:j.changed_count,cancelRequested:!!j.cancel_requested,error:j.error_code,items,mayHaveAppliedChanges:j.mode==='live'&&items.some(x=>x.attempts>0),requiresReconciliation:items.some(x=>x.state==='uncertain'),shoptetApplied:j.mode==='live'&&j.state==='succeeded',storefrontVerified:false};},
  async history(shop){return {jobs:(await db.prepare('SELECT job_id,plan_id,state,mode,checkpoint,error_code,created_at,updated_at FROM sync_jobs WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shop).all()).results};},
  async cancel(shop,id){const r=await db.prepare("UPDATE sync_jobs SET cancel_requested=1,updated_at=unixepoch() WHERE shop_id=? AND job_id=? AND state IN('queued','running')").bind(shop,id).run();if(!r.meta?.changes)throw new SyncError('job_not_cancellable');return {cancellationRequested:true};},
  async retry(shop,id){const j=await first('SELECT * FROM sync_jobs WHERE shop_id=? AND job_id=?',shop,id);if(!j||j.mode!=='dry-run'||j.state!=='failed'||j.error_code==='external_outcome_uncertain')throw new SyncError('retry_requires_new_plan_or_manual_reconciliation');const p=await plan(shop,j.plan_id);await activeVersion(shop,p);
   await db.batch([db.prepare("UPDATE sync_jobs SET state='queued',error_code=NULL,cancel_requested=0,next_attempt_at=NULL WHERE shop_id=? AND job_id=? AND state='failed'").bind(shop,id),db.prepare("UPDATE sync_job_items SET state='pending',error_code=NULL,attempts=0 WHERE shop_id=? AND job_id=? AND state='failed'").bind(shop,id)]);return this.progress(shop,id);}
 };
}
