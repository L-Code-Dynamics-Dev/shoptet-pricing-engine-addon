import {createD1ApprovalStore} from '../../../../packages/core/src/d1-approval-store.mjs';
import {createD1ShopLock} from '../../../../packages/core/src/d1-shop-lock.mjs';
import {createR2AssetProvider} from '../../../../packages/core/src/r2-asset-provider.mjs';
// Integration boundary: an operator must supply a verified SFTP transport
// factory. Without it, no write-capable MCP operation is available.
export function createInstallServices(env){
 if(!env?.DB || !env?.RELEASE_ASSETS || typeof env?.SFTP_TRANSPORT_FACTORY!=='function')return null;
 return {
  approvalStore:createD1ApprovalStore(env.DB),
  assetProvider:createR2AssetProvider(env.RELEASE_ASSETS),
  lock:createD1ShopLock(env.DB),
  transportFactory:env.SFTP_TRANSPORT_FACTORY
 };
}
