import {proposalSchema} from './configuration.mjs';
import {parseTokenKeys} from './token-vault.mjs';
import {oauthConfiguration} from './mcp-oauth.mjs';
export function createDiagnostics({db,shopId,adapter,env}){
 const capture=async(name,run)=>{try{return {name,ok:true,result:await run()};}catch(error){return {name,ok:false,error:typeof error?.code==='string'?error.code:'check_failed'};}};
 return {
  async run(){
   const checks=[];
   checks.push(await capture('shop_profile',()=>adapter.profile()));
   checks.push(await capture('approved_shoptet_endpoints',()=>adapter.capabilities()));
   checks.push(await capture('saved_proposal',async()=>{const row=await db.prepare('SELECT config_json,version FROM tenant_settings WHERE shop_id=?').bind(shopId).first();const config=row?JSON.parse(row.config_json):{};if(config.loyaltyProposal)proposalSchema.parse(config.loyaltyProposal);return {version:row?.version??0,proposalPresent:!!config.loyaltyProposal};}));
   checks.push(await capture('token_vault',async()=>{parseTokenKeys(env.SHOPTET_TOKEN_KEYS);return {configured:true};}));
   checks.push(await capture('mcp_oauth',async()=>{const c=oauthConfiguration(env);return {configured:true,registeredClients:c.clients.length};}));
   return {checks,passed:checks.every(c=>c.ok),syncCoordinatorConfigured:!!env.SYNC_COORDINATOR,nativeWriteMode:env.SYNC_MODE==='live'?'operator_enabled':'off',pricingParityReleaseApproved:env.PRICING_PARITY_APPROVAL==='native-price-policy-v1',livePricesVerified:false,storefrontVerified:false};
  },
  async errors(){return {errors:(await db.prepare("SELECT job_id,plan_id,error_code,updated_at FROM sync_jobs WHERE shop_id=? AND state='failed' ORDER BY updated_at DESC LIMIT 50").bind(shopId).all()).results};},
  async audit(){
   const versions=(await db.prepare('SELECT version,revision_id,applied_at FROM configuration_history WHERE shop_id=? ORDER BY version DESC LIMIT 50').bind(shopId).all()).results;
   const jobs=(await db.prepare('SELECT job_id,state,mode,error_code,created_at,updated_at FROM sync_jobs WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shopId).all()).results;
   const clients=(await db.prepare('SELECT client_id,created_at,last_connection_at,revoked_at FROM mcp_oauth_grants WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shopId).all()).results;
   return {configurationRevisions:versions,synchronizations:jobs,clientGrants:clients,coverage:'persisted_configuration_sync_and_oauth_lifecycle_metadata'};
  },
  async report(){return {generatedAt:new Date().toISOString(),diagnostics:await this.run(),recentErrors:await this.errors(),audit:await this.audit(),credentialsIncluded:false,customerDataIncluded:false};}
 };
}
