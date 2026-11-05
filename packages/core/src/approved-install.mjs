import { deployApprovedAssets, validateAssetManifest } from './asset-deployment.mjs';

// This boundary is deliberately server-only. The agent supplies an opaque
// approval ID; the server resolves the shop, immutable manifest and assets.
// claimApproval must atomically consume an approval bound to the authenticated
// shop, so retries/concurrent agents cannot execute the same authorization.
const ID = /^[a-zA-Z0-9_-]{16,96}$/;
export async function executeApprovedInstall({shopId,approvalId,approvalStore,assetProvider,transportFactory,lock,runId}) {
  if (typeof shopId !== 'string' || !shopId || !ID.test(approvalId ?? '') ||
      typeof approvalStore?.claim !== 'function' || typeof assetProvider?.get !== 'function' ||
      typeof transportFactory !== 'function' || typeof lock?.withShopLock !== 'function') {
    throw new Error('Installation unavailable');
  }
  return lock.withShopLock(shopId, async () => {
    const approval = await approvalStore.claim({shopId,approvalId});
    if (!approval || approval.shopId !== shopId || approval.status !== 'approved' ||
        !Number.isFinite(approval.expiresAt) || approval.expiresAt <= Date.now()) {
      throw new Error('Installation not authorized');
    }
    // Manifest comes from a trusted approval record, not agent arguments.
    const manifest = validateAssetManifest(approval.manifest);
    const assets = await assetProvider.get({shopId,manifest,releaseId:approval.releaseId});
    const transport = await transportFactory(shopId);
    const result = await deployApprovedAssets({shopId,manifest,assets,approval,transport,runId});
    return {installed:result.deployed,fileCount:result.fileCount};
  });
}
