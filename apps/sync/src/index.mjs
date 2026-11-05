import {DurableObject} from 'cloudflare:workers';
import {syncRuntime} from '../../api/src/sync/runtime.mjs';
// One object per authenticated tenant. Remote requests cannot call this Worker;
// only the API Worker's namespace binding can invoke the enqueue RPC.
export class ShopSyncCoordinator extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.ctx.blockConcurrencyWhile(async()=>{this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS tenant(id INTEGER PRIMARY KEY CHECK(id=1),shop_id TEXT NOT NULL)');this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS queue(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE)');});}
 async enqueue({shopId,jobId}){
  if(typeof shopId!=='string'||!shopId||shopId.length>128||typeof jobId!=='string'||!/^[a-f0-9-]{36}$/.test(jobId))throw Error('Invalid sync identity');
  const job=await this.env.DB.prepare('SELECT state FROM sync_jobs WHERE shop_id=? AND job_id=?').bind(shopId,jobId).first();if(!job)throw Error('Unknown tenant job');
  // All local queue/ownership mutations are synchronous SQL, with no network await between them.
  const sql=this.ctx.storage.sql;const owners=sql.exec('SELECT shop_id FROM tenant WHERE id=1').toArray();
  if(owners.length&&owners[0].shop_id!==shopId)throw Error('Cross-tenant coordinator access');
  sql.exec('INSERT OR IGNORE INTO tenant(id,shop_id) VALUES(1,?)',shopId);
  if(sql.exec('SELECT count(*) AS n FROM queue').one().n>=25&&!sql.exec('SELECT 1 FROM queue WHERE job_id=?',jobId).toArray().length)throw Error('Sync queue full');
  sql.exec('INSERT OR IGNORE INTO queue(job_id) VALUES(?)',jobId);await this.ctx.storage.setAlarm(Date.now()+1000);
  return {queued:true,jobId};
 }
 async alarm(){
  if(this.running){await this.ctx.storage.setAlarm(Date.now()+60000);return;}this.running=true;
  try{
   const owners=this.ctx.storage.sql.exec('SELECT shop_id FROM tenant WHERE id=1').toArray(),queue=this.ctx.storage.sql.exec('SELECT sequence,job_id FROM queue ORDER BY sequence LIMIT 1').toArray();
   if(!owners.length||!queue.length)return;
   const shopId=owners[0].shop_id,current=queue[0];
   await this.ctx.storage.setAlarm(Date.now()+60000);
   const result=await syncRuntime(this.env,shopId).runner.step(shopId,current.job_id);
   if(result.done){this.ctx.storage.sql.exec('DELETE FROM queue WHERE sequence=? AND job_id=?',current.sequence,current.job_id);if(this.ctx.storage.sql.exec('SELECT 1 FROM queue LIMIT 1').toArray().length)await this.ctx.storage.setAlarm(Date.now()+1000);else await this.ctx.storage.deleteAlarm();}
   else await this.ctx.storage.setAlarm(result.retryAt||Date.now()+(result.blocked?60000:1000));
  }finally{this.running=false;}
 }
}

export default {fetch(){return new Response('Not found',{status:404});}};
