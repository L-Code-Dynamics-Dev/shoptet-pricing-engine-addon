import {validateAssetManifest} from './asset-deployment.mjs';
const ID=/^[A-Za-z0-9_-]{16,96}$/;
const RELEASE=/^[A-Za-z0-9_-]{1,80}$/;
// Only invoke after verifying administrator identity and its shop ownership.
export async function issueAssetApproval({db,shopId,releaseId,manifest,now=Date.now(),ttlMs=300000}){
 if(typeof db?.prepare!=='function'||typeof shopId!=='string'||!shopId||!RELEASE.test(releaseId??'')||!Number.isSafeInteger(now)||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>900000)throw new Error('Approval unavailable');
 const validated=validateAssetManifest(manifest);
 const id=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
 if(!ID.test(id))throw new Error('Approval unavailable');
 const row=await db.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();
 if(row?.state!=='active')throw new Error('Shop inactive');
 await db.prepare(`INSERT INTO asset_install_approvals(approval_id,shop_id,release_id,manifest_json,state,expires_at_ms,created_at_ms)
 VALUES(?,?,?,?,'approved',?,?)`).bind(id,shopId,releaseId,JSON.stringify(validated),now+ttlMs,now).run();
 return {approvalId:id,expiresAt:now+ttlMs,fileCount:validated.length};
}
