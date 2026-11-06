import { z } from 'zod';
import {turnoverPolicySchema} from './turnover.mjs';
const percent=z.number().finite().min(0).max(100);
export const proposalSchema=z.object({
  currency:z.string().regex(/^[A-Z]{3}$/),
  tiers:z.array(z.object({name:z.string().trim().min(1).max(60),percent,minTurnover:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),pricelistId:z.number().int().positive().nullable().optional()}).strict()).max(30),
  brandCaps:z.array(z.object({id:z.string().uuid(),percent}).strict()).max(100),
  categoryCaps:z.array(z.object({id:z.string().uuid(),percent}).strict()).max(200).default([]),
  productCaps:z.array(z.object({id:z.string().uuid(),variantCode:z.string().min(1).max(128).optional(),percent}).strict()).max(200).default([]),
  salePolicy:z.enum(['okfish_compatible','lowest_price']).default('okfish_compatible'),
  capPriority:z.enum(['hierarchy','most_restrictive']).default('most_restrictive'),
  couponPolicy:z.enum(['no_loyalty_combination','unchanged']),
  turnoverPolicy:turnoverPolicySchema.optional()
}).strict().superRefine((v,c)=>{
  const names=new Set();let threshold=-1;
  v.tiers.forEach((t,i)=>{const n=t.name.toLocaleLowerCase('cs');if(names.has(n)||t.minTurnover<=threshold)c.addIssue({code:'custom',path:['tiers',i],message:'Duplicate name or invalid tier order'});names.add(n);threshold=t.minTurnover;});
  if(new Set(v.categoryCaps.map(x=>x.id)).size!==v.categoryCaps.length)c.addIssue({code:'custom',path:['categoryCaps'],message:'Duplicate category identifier'});
  if(new Set(v.productCaps.map(x=>x.id+':'+(x.variantCode??''))).size!==v.productCaps.length)c.addIssue({code:'custom',path:['productCaps'],message:'Duplicate product variant identifier'});
  if(new Set(v.brandCaps.map(x=>x.id)).size!==v.brandCaps.length)c.addIssue({code:'custom',path:['brandCaps'],message:'Duplicate brand identifier'});
});
export class ConfigurationError extends Error {}
const id=()=>crypto.randomUUID();
const checkShop=shop=>{if(typeof shop!=='string'||!shop||shop.length>128)throw new ConfigurationError('invalid_tenant');};
export function createConfigurationService(db, verifyBrand, verifyCatalog=null) {
  async function current(shop) {checkShop(shop);const row=await db.prepare('SELECT config_json,version FROM tenant_settings WHERE shop_id=?').bind(shop).first();return {version:row?.version??0,config:row?JSON.parse(row.config_json):{}};}
  async function revision(shop,revisionId) {checkShop(shop);const row=await db.prepare('SELECT * FROM configuration_revisions WHERE shop_id=? AND revision_id=?').bind(shop,revisionId).first();if(!row)throw new ConfigurationError('revision_not_found');return row;}
  async function validate(proposal) {const parsed=proposalSchema.parse(proposal);for(const cap of parsed.brandCaps){if(!verifyBrand||!await verifyBrand(cap.id))throw new ConfigurationError('brand_reference_not_verified');}for(const tier of parsed.tiers){if(tier.pricelistId!=null&&(!verifyCatalog||!await verifyCatalog('pricelist',tier.pricelistId)))throw new ConfigurationError('pricelist_reference_not_verified');}for(const cap of parsed.categoryCaps){if(!verifyCatalog||!await verifyCatalog('category',cap.id))throw new ConfigurationError('category_reference_not_verified');}for(const cap of parsed.productCaps){if(!verifyCatalog||!await verifyCatalog('product',cap.id,cap.variantCode))throw new ConfigurationError('product_reference_not_verified');}if(parsed.turnoverPolicy){for(const status of parsed.turnoverPolicy.qualifyingStatusIds)if(!verifyCatalog||!await verifyCatalog('orderStatus',status))throw new ConfigurationError('order_status_reference_not_verified');}return parsed;}
  return {
    async create(shop,expectedVersion,proposal) {
      const checked=await validate(proposal);const base=await current(shop);
      if(base.version!==expectedVersion)throw new ConfigurationError('version_conflict');
      const revisionId=id();const next={...base.config,loyaltyProposal:checked};
      await db.prepare('INSERT INTO configuration_revisions(shop_id,revision_id,base_version,base_json,config_json,created_at) VALUES(?,?,?,?,?,?)').bind(shop,revisionId,expectedVersion,JSON.stringify(base.config),JSON.stringify(next),Math.floor(Date.now()/1000)).run();
      return {revisionId,baseVersion:expectedVersion,state:'draft',configurationSaved:false,shoptetApplied:false};
    },
    async update(shop,revisionId,proposal) {
      const old=await revision(shop,revisionId);
      // Updating always creates a new immutable revision; old approvals never transfer.
      return this.create(shop,old.base_version,proposal);
    },
    async rollback(shop,targetVersion,expectedVersion) {
      checkShop(shop);
      const row=await db.prepare('SELECT after_json FROM configuration_history WHERE shop_id=? AND version=?').bind(shop,targetVersion).first();
      if(!row)throw new ConfigurationError('history_not_found');
      const proposal=JSON.parse(row.after_json).loyaltyProposal;
      if(!proposal)throw new ConfigurationError('rollback_schema_unsupported');
      return {...await this.create(shop,expectedVersion,proposal),rollbackTargetVersion:targetVersion,requiresNewApproval:true};
    },
    async preview(shop,revisionId) {const r=await revision(shop,revisionId);return {revisionId,baseVersion:r.base_version,before:JSON.parse(r.base_json),after:JSON.parse(r.config_json),action:'save_configuration',impact:'Uloží návrh konfigurace doplňku. Ceny, kupóny a přiřazení zákazníků v Shoptetu se tím neaktivují.',shoptetApplied:false};},
    async validate(shop,revisionId) {const r=await revision(shop,revisionId);await validate(JSON.parse(r.config_json).loyaltyProposal);const base=await current(shop);if(base.version!==r.base_version)throw new ConfigurationError('version_conflict');return {valid:true,revisionId,liveActivationSupported:false};},
    async requestApproval(shop,revisionId) {
      const r=await revision(shop,revisionId);await validate(JSON.parse(r.config_json).loyaltyProposal);
      const approvalId=id();const expiresAt=Math.floor(Date.now()/1000)+900;
      await db.prepare("INSERT INTO configuration_approvals(shop_id,approval_id,revision_id,action,state,expires_at) VALUES(?,?,?,'save_configuration','pending',?)").bind(shop,approvalId,revisionId,expiresAt).run();
      return {approvalId,revisionId,expiresAt,state:'pending',approvalMethod:'authenticated_addon_admin',action:'save_configuration'};
    },
    async pending(shop) {checkShop(shop);return (await db.prepare("SELECT approval_id,revision_id,expires_at FROM configuration_approvals WHERE shop_id=? AND state='pending' AND expires_at>unixepoch() ORDER BY expires_at LIMIT 50").bind(shop).all()).results;},
    async approve(shop,approvalId,sessionHash) {
      checkShop(shop);if(!/^[a-f0-9]{64}$/.test(sessionHash))throw new ConfigurationError('admin_session_required');
      const r=await db.prepare("UPDATE configuration_approvals SET state='approved',approved_by=? WHERE shop_id=? AND approval_id=? AND state='pending' AND expires_at>unixepoch()").bind(sessionHash,shop,approvalId).run();
      if(!r.meta?.changes)throw new ConfigurationError('approval_not_available');return {approved:true,approvalId};
    },
    async apply(shop,approvalId) {
      checkShop(shop);
      // Database trigger is authoritative; conflict rolls back the one-time claim.
      const r=await db.prepare("UPDATE configuration_approvals SET state='consumed' WHERE shop_id=? AND approval_id=? AND state='approved' AND expires_at>unixepoch()").bind(shop,approvalId).run();
      if(!r.meta?.changes)throw new ConfigurationError('approval_not_available');
      return {configurationSaved:true,shoptetApplied:false,storefrontVerified:false,state:'saved_only'};
    },
    async history(shop) {checkShop(shop);return {history:(await db.prepare('SELECT version,revision_id,applied_at FROM configuration_history WHERE shop_id=? ORDER BY version DESC LIMIT 50').bind(shop).all()).results};},
    async verify(shop,revisionId) {const r=await revision(shop,revisionId);const base=await current(shop);return {configurationSaved:base.version===r.base_version+1 && JSON.stringify(base.config)===r.config_json,shoptetApplied:false,storefrontVerified:false};}
  };
}
