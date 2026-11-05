// Tenant-bound asset deployment. The caller must authenticate the approval in
// a trusted service; untrusted MCP arguments are never an approval source.
const FILES = new Set(['vip_detail.js','vip_prices.js','vip_catalog.js','vip_cart.js','vip_cart_coupon_lock.js']);
const ROOT = 'upload/CSSJS';
const HEX = /^[a-f0-9]{64}$/;
const text = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2,'0')).join('');
export async function sha256(content) { return hex(await crypto.subtle.digest('SHA-256',text.encode(content))); }
export function validateAssetManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > FILES.size) throw new Error('Invalid asset manifest');
  const seen = new Set();
  return manifest.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k=>!['name','sha256'].includes(k))) throw new Error('Invalid asset');
    if (!FILES.has(item.name) || seen.has(item.name) || typeof item.sha256 !== 'string' || !HEX.test(item.sha256)) throw new Error('Invalid asset');
    seen.add(item.name);
    return Object.freeze({name:item.name,sha256:item.sha256});
  });
}
export function deploymentPreview(manifest) {
  const validated=validateAssetManifest(manifest);
  return {readyForApproval:true,files:validated.map(x=>x.name),fileCount:validated.length,changesApplied:false};
}
// Transport contract: connect(shopId), read(path)->Uint8Array|null,
// write(path,bytes), rename(from,to), remove(path), close().
// A unique per-run suffix prevents concurrent staging-file collisions. A
// distributed per-shop lock must still be enforced by the calling service.
export async function deployApprovedAssets({shopId,manifest,assets,approval,transport,runId}) {
  if (typeof shopId !== 'string' || !shopId || !approval || approval.shopId !== shopId || approval.status !== 'approved' || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now()) throw new Error('Deployment not authorized');
  const validated=validateAssetManifest(manifest);
  if (!assets || typeof assets !== 'object' || !transport || !/^[a-f0-9]{32}$/.test(runId??'')) throw new Error('Invalid deployment');
  for (const entry of validated) {
    if (typeof assets[entry.name] !== 'string' || await sha256(assets[entry.name]) !== entry.sha256) throw new Error('Asset integrity check failed');
  }
  const stages=[];
  const backups=new Map();
  const published=[];
  let connected=false;
  let failure;
  try {
    await transport.connect(shopId);connected=true;
    // Snapshot ALL destinations before changing ANY of them. Null denotes a
    // missing file; an empty Uint8Array denotes an existing empty file.
    for (const entry of validated) {
      const dest=`${ROOT}/${entry.name}`;
      const previous=await transport.read(dest);
      if (previous !== null && !(previous instanceof Uint8Array)) throw new Error('Invalid backup data');
      backups.set(dest,previous===null?null:new Uint8Array(previous));
    }
    for (const entry of validated) {
      const stage=`${ROOT}/${entry.name}.${runId}.stage`;
      stages.push(stage);
      await transport.write(stage,text.encode(assets[entry.name]));
    }
    for (const entry of validated) {
      const dest=`${ROOT}/${entry.name}`;
      // Record before rename: a remote operation may succeed then throw.
      published.push(dest);
      await transport.rename(`${dest}.${runId}.stage`,dest);
    }
    return {deployed:true,fileCount:validated.length};
  } catch (error) {
    failure=error;
    if (connected) {
      const rollbackErrors=[];
      for (const dest of published.reverse()) {
        try {
          const previous=backups.get(dest);
          if (previous===null) await transport.remove(dest);
          else await transport.write(dest,previous);
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new AggregateError([error,...rollbackErrors],'Deployment failed; rollback incomplete');
    }
    throw error;
  } finally {
    if (connected) {
      for (const stage of stages) { try { await transport.remove(stage); } catch { /* best effort */ } }
      try { await transport.close(); } catch (closeError) { if (!failure) throw closeError; }
    }
  }
}
