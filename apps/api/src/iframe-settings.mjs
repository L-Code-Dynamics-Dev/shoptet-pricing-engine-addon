import {initializeWebhookKey,lifecycleReady} from '../../../packages/core/src/webhooks.mjs';
import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
import {createShoptetAdapter} from '../../../packages/core/src/shoptet-adapter.mjs';
import {getShoptetApiAccessToken} from '../../../packages/core/src/shoptet-oauth.mjs';
import {syncRuntime} from './sync/runtime.mjs';
import {createMcpOAuth,oauthConfiguration,digest,OAuthError} from '../../../packages/core/src/mcp-oauth.mjs';
import { createConfigurationService } from '../../../packages/core/src/configuration.mjs';
import {
  getPricelistPolicy,
  getLatestRecalculationPlan,
  getRecalculationPlanDetails,
  approveRecalculationPlan
} from '../../../packages/core/src/loyalty-repository.mjs';
import {
  generateCustomerRecalculationPlan,
  executeCustomerRecalculationBatch
} from '../../../packages/core/src/loyalty-batch-runner.mjs';
import {
  SUPPORTED_PERIODS,
  RETENTION_POLICIES,
  validateOnboardingConfig,
  setupLoyaltyEntities,
  inspectStoreOnboardingData
} from '../../../packages/core/src/loyalty-onboarding.mjs';
import {
  validateProductPromotion,
  validateBrandPromotion
} from '../../../packages/core/src/promotions.mjs';
import {
  reconcilePrices,
  reconcileCoupons
} from '../../../packages/core/src/reconciliation-runner.mjs';
import {
  classifyRemediationEligibility
} from '../../../packages/core/src/self-healing-engine.mjs';
import {
  grossApiPrice,
  activeActionMinor,
  parseApiPrice,
  shopDate
} from '../../../packages/core/src/pricing-policy.mjs';
/**
 * L-Code Loyalty Pricing Engine — addon settings page embedded in Shoptet administration.
 * High-fidelity native Shoptet administration theme with Shoptet tabs, cards, and buttons.
 */
import { authorizeSettingsPage, verifySession, bearerFrom } from './admin-session.mjs';
import { UI_DEFAULTS, validateUiSection } from './admin-sections.mjs';

const FRAME_ANCESTORS = "'self' https://*.myshoptet.com https://*.shoptet.cz https://*.shoptet.sk https://admin.shoptet.cz";
const MCP_UI_SCOPES = ['shop:read', 'catalog:read', 'pricing:read','sync:read'];
const MAX_TIERS = 10;

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function htmlHeaders(nonce) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS};`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };
}

/* ---------------------------------------------------------------- validation */

export function validateTiers(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'Zadejte alespoň jednu hladinu.' };
  if (input.length > MAX_TIERS) return { error: `Maximálně ${MAX_TIERS} hladin.` };
  const tiers = [];
  const names = new Set();
  for (let i = 0; i < input.length; i++) {
    const t = input[i];
    const row = `Řádek ${i + 1}: `;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: row + 'neplatná data.' };
    const extra = Object.keys(t).filter(k => !['name', 'percent', 'minTurnover', 'pricelistId', 'customerGroupId'].includes(k));
    if (extra.length) return { error: row + 'neznámá pole.' };
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (name.length < 1 || name.length > 60) return { error: row + 'název musí mít 1–60 znaků.' };
    if (names.has(name.toLowerCase())) return { error: row + 'duplicitní název.' };
    names.add(name.toLowerCase());
    const percent = Number(t.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100 || Math.abs(Math.round(percent * 100) - percent * 100) > 1e-9) {
      return { error: row + 'sleva musí být číslo 0,01–100 (max. 2 desetinná místa).' };
    }
    const minTurnover = Number(t.minTurnover);
    if (!Number.isSafeInteger(minTurnover) || minTurnover < 0) return { error: row + 'obrat musí být celé číslo ≥ 0.' };
    if (tiers.length && minTurnover <= tiers[tiers.length - 1].minTurnover) {
      return { error: row + 'obrat musí být vyšší než u předchozí hladiny.' };
    }
    let pricelistId = null;
    if (t.pricelistId !== undefined && t.pricelistId !== null && t.pricelistId !== '') {
      pricelistId = Number(t.pricelistId);
      if (!Number.isSafeInteger(pricelistId) || pricelistId <= 0) return { error: row + 'ceník musí být kladné číslo.' };
    }
    let customerGroupId = null;
    if (t.customerGroupId !== undefined && t.customerGroupId !== null && t.customerGroupId !== '') {
      customerGroupId = Number(t.customerGroupId);
      if (!Number.isSafeInteger(customerGroupId) || customerGroupId <= 0) return { error: row + 'skupina zákazníků musí být kladné číslo.' };
    }
    tiers.push({
      name,
      percent,
      minTurnover,
      ...(pricelistId !== null ? { pricelistId } : {}),
      ...(customerGroupId !== null ? { customerGroupId } : {})
    });
  }
  return { tiers };
}

export function validateRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Neplatná data pravidel.' };
  const brandLimits = {};
  if(input.brandLimits!==undefined && (!input.brandLimits || typeof input.brandLimits!=='object' || Array.isArray(input.brandLimits) || Object.keys(input.brandLimits).length>100))return {error:'Neplatný seznam značek.'};
  for(const [key,value] of Object.entries(input.brandLimits||{})){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))return {error:'Značku vyberte ze skutečného katalogu obchodu.'};
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100||Number(value.toFixed(2))!==value)return {error:'Sleva značky musí být 0–100 %.'};
    const id=key.toLowerCase();if(Object.hasOwn(brandLimits,id))return {error:'Duplicitní značka.'};brandLimits[id]=value;
  }
  const categoryLimits = {};
  if(input.categoryLimits!==undefined && (!input.categoryLimits || typeof input.categoryLimits!=='object' || Array.isArray(input.categoryLimits) || Object.keys(input.categoryLimits).length>100))return {error:'Neplatný seznam kategorií.'};
  for(const [key,value] of Object.entries(input.categoryLimits||{})){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))return {error:'Kategorii vyberte ze skutečného katalogu obchodu.'};
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100||Number(value.toFixed(2))!==value)return {error:'Sleva kategorie musí být 0–100 %.'};
    const id=key.toLowerCase();if(Object.hasOwn(categoryLimits,id))return {error:'Duplicitní kategorie.'};categoryLimits[id]=value;
  }
  const productLimits = {};
  if(input.productLimits!==undefined && (!input.productLimits || typeof input.productLimits!=='object' || Array.isArray(input.productLimits) || Object.keys(input.productLimits).length>100))return {error:'Neplatný seznam produktů.'};
  for(const [key,value] of Object.entries(input.productLimits||{})){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))return {error:'Produkt vyberte ze skutečného katalogu obchodu.'};
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100||Number(value.toFixed(2))!==value)return {error:'Sleva produktu musí být 0–100 %.'};
    const id=key.toLowerCase();if(Object.hasOwn(productLimits,id))return {error:'Duplicitní produkt.'};productLimits[id]=value;
  }
  let couponLockMinPercent = null;
  if (input.couponLockMinPercent !== undefined && input.couponLockMinPercent !== null && input.couponLockMinPercent !== '') {
    const minP = Number(input.couponLockMinPercent);
    if (!Number.isFinite(minP) || minP < 1 || minP > 100) return { error: 'Hranice slevy pro zákaz kupónů musí být 1–100 %.' };
    couponLockMinPercent = Math.round(minP * 100) / 100;
  }

  let couponMode = 'fixed-amount';
  if (input.couponMode !== undefined && input.couponMode !== null && input.couponMode !== '') {
    if (!['fixed-amount', 'percent-ceiling'].includes(input.couponMode)) {
      return { error: 'Neznámý režim kupónů. Povolené hodnoty jsou pevná částka nebo procentní strop.' };
    }
    couponMode = input.couponMode;
  }

  let couponCeilingPercent = null;
  if (input.couponCeilingPercent !== undefined && input.couponCeilingPercent !== null && input.couponCeilingPercent !== '') {
    const cp = Number(input.couponCeilingPercent);
    if (!Number.isFinite(cp) || cp < 1 || cp > 100 || Math.abs(Math.round(cp * 100) - cp * 100) > 1e-9) {
      return { error: 'Celkový strop slevy s kupónem musí být 1–100 %.' };
    }
    couponCeilingPercent = Math.round(cp * 100) / 100;
  }
  if (couponMode === 'percent-ceiling' && couponCeilingPercent === null) {
    return { error: 'Při režimu procentního kupónu musíte zadat celkový strop slevy s kupónem (1–100 %).' };
  }

  let capPriority = 'hierarchy';
  if (input.capPriority !== undefined && input.capPriority !== null && input.capPriority !== '') {
    if (!['hierarchy', 'most_restrictive'].includes(input.capPriority)) {
      return { error: 'Neznámá priorita stropů slev.' };
    }
    capPriority = input.capPriority;
  }

  let minMarginPercent = null;
  if (input.minMarginPercent !== undefined && input.minMarginPercent !== null && input.minMarginPercent !== '') {
    const mm = Number(input.minMarginPercent);
    if (!Number.isFinite(mm) || mm < 0 || mm > 99.99 || Math.abs(Math.round(mm * 100) - mm * 100) > 1e-9) {
      return { error: 'Minimální marže musí být 0–99,99 %.' };
    }
    minMarginPercent = Math.round(mm * 100) / 100;
  }

  const scheduledPromotions = [];
  if (Array.isArray(input.scheduledPromotions)) {
    if (input.scheduledPromotions.length > 500) return { error: 'Maximálně 500 položek plánovaného výprodeje.' };
    for (const item of input.scheduledPromotions) {
      const v = validateProductPromotion(item);
      if (v.error) return { error: v.error };
      scheduledPromotions.push(v.item);
    }
  }

  const brandPromotions = [];
  if (Array.isArray(input.brandPromotions)) {
    if (input.brandPromotions.length > 100) return { error: 'Maximálně 100 plánovaných akcí na značky.' };
    for (const item of input.brandPromotions) {
      const v = validateBrandPromotion(item);
      if (v.error) return { error: v.error };
      brandPromotions.push(v.item);
    }
  }

  return {
    rules: {
      couponLockTopTiers: input.couponLockTopTiers !== false,
      couponLockMinPercent,
      couponLockMaxRemaining: input.couponLockMaxRemaining !== false,
      couponMode,
      couponCeilingPercent,
      capPriority,
      minMarginPercent,
      highestDiscountWins: input.highestDiscountWins !== false,
      vatIntegrity: true,
      postWriteVerify: input.postWriteVerify !== false,
      brandLimits,
      categoryLimits,
      productLimits,
      scheduledPromotions,
      brandPromotions
    }
  };
}

/* ---------------------------------------------------------------- API */

async function requireSession(request, env) {
  const secret = env.ADMIN_SESSION_SECRET;
  if (!secret) return null;
  const identity=await verifySession(bearerFrom(request), secret);if(!identity)return null;
  const installation=await env.DB.prepare('SELECT i.state,o.oauth_envelope FROM installations i LEFT JOIN shoptet_oauth o ON o.shop_id=i.shop_id WHERE i.shop_id=?').bind(identity.shopId).first();
  if(!installation||!['active','pending'].includes(installation.state))return null;
  if(installation.oauth_envelope&&identity.credentialGeneration!==await sha256Hex(installation.oauth_envelope))return null;
  return identity;
}

function parseConfig(row) {
  let config = {};
  if (row?.config_json) { try { config = JSON.parse(row.config_json) || {}; } catch { config = {}; } }
  return { config, version: row?.version ?? 0 };
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fetchVerifiedStoreCatalogForReconciliation({ adapter, profile, defaultPricelistId, tiers, minMarginPercent }) {
  const vatPayer = typeof profile?.vatPayer === 'boolean'
    ? profile.vatPayer
    : (profile?.priceType === 'including_vat' ? true : (profile?.priceType === 'excluding_vat' ? false : null));
  if (typeof vatPayer !== 'boolean') {
    throw new Error('missing_verified_vat_payer_status');
  }
  const date = shopDate(profile?.timezone || 'Europe/Prague');
  const minMarginBps = typeof minMarginPercent === 'number' && Number.isFinite(minMarginPercent) && minMarginPercent > 0
    ? Math.round(minMarginPercent * 100)
    : null;

  let hasVerifiedPricePagination = true;
  const basePriceByCode = new Map();
  try {
    for await (const row of adapter.iteratePrices(defaultPricelistId)) {
      const basePriceMinor = grossApiPrice(row, vatPayer);
      const actionPriceMinor = activeActionMinor(row, vatPayer, date);
      let minimumMinor = null;
      let missingMarginCost = false;
      if (minMarginBps !== null) {
        const purchase = row.prices?.purchasePrice;
        if (purchase?.price && purchase.vatRate === row.vatRate) {
          const vat = BigInt(parseApiPrice(row.vatRate));
          const cost = BigInt(parseApiPrice(purchase.price));
          if (cost > 0n) {
            const grossCost = purchase.includingVat ? cost : (cost * (10000n + vat) + 9999n) / 10000n;
            const denom = 10000n - BigInt(minMarginBps);
            const floor = (grossCost * 10000n + denom - 1n) / denom;
            if (floor <= BigInt(Number.MAX_SAFE_INTEGER)) minimumMinor = Number(floor);
          }
        }
        if (minimumMinor === null) {
          missingMarginCost = true;
        }
      }
      basePriceByCode.set(row.code, { basePriceMinor, actionPriceMinor, minimumMinor, missingMarginCost });
    }
  } catch (err) {
    if (err?.code === 'incomplete_price_pagination_scan' || err?.code === 'max_pages_exceeded_incomplete_scan') {
      hasVerifiedPricePagination = false;
    } else {
      throw err;
    }
  }

  const tierPricesByPricelist = new Map();
  for (const tier of tiers) {
    const byCode = new Map();
    try {
      for await (const row of adapter.iteratePrices(tier.pricelistId)) {
        byCode.set(row.code, {
          priceMinor: grossApiPrice(row, vatPayer),
          sales: row.sales
        });
      }
    } catch (err) {
      if (err?.code === 'incomplete_price_pagination_scan' || err?.code === 'max_pages_exceeded_incomplete_scan') {
        hasVerifiedPricePagination = false;
      } else {
        throw err;
      }
    }
    tierPricesByPricelist.set(tier.pricelistId, byCode);
  }

  const catalogProducts = [];
  const brandCache = new Map();
  let page = 1;
  let pageCount = 1;
  let hasVerifiedPagination = true;
  let expectedTotalCount = null;

  while (page <= pageCount) {
    const res = await adapter.list('products', { page, limit: 50 });
    if (!res?.pagination || !Number.isSafeInteger(res.pagination.pageCount) || res.pagination.pageCount < 1) {
      hasVerifiedPagination = false;
      pageCount = 1;
    } else {
      pageCount = res.pagination.pageCount;
      if (Number.isSafeInteger(res.pagination.totalCount) && res.pagination.totalCount >= 0) {
        expectedTotalCount = res.pagination.totalCount;
      }
    }

    const pageItems = Array.isArray(res?.items) ? res.items : null;
    if (!pageItems || pageItems.length === 0) {
      hasVerifiedPagination = false;
    }

    for (const item of (pageItems || [])) {
      const detail = typeof adapter.product === 'function' ? await adapter.product(item.guid) : item;
      let brandId = null;
      if (detail.brand?.code && typeof adapter.brand === 'function') {
        if (!brandCache.has(detail.brand.code)) {
          const b = await adapter.brand(detail.brand.code);
          brandCache.set(detail.brand.code, b.guid);
        }
        brandId = brandCache.get(detail.brand.code);
      } else if (detail.brand?.guid) {
        brandId = detail.brand.guid;
      }
      const categoryIds = Array.from(new Set([
        detail.defaultCategory?.guid,
        ...(Array.isArray(detail.categories) ? detail.categories.map(c => c.guid) : [])
      ].filter(Boolean)));

      const rawVariants = Array.isArray(detail.variants) ? detail.variants : (Array.isArray(item.variants) ? item.variants : []);
      const variants = rawVariants.map(v => {
        const baseEntry = basePriceByCode.get(v.code);
        const perPricelistPrices = {};
        for (const tier of tiers) {
          const tEntry = tierPricesByPricelist.get(tier.pricelistId)?.get(v.code);
          if (tEntry !== undefined) {
            perPricelistPrices[tier.pricelistId] = tEntry;
          }
        }
        return {
          code: v.code,
          visible: v.visible ?? v.active ?? true,
          basePriceMinor: baseEntry?.basePriceMinor ?? null,
          actionPriceMinor: baseEntry?.actionPriceMinor ?? null,
          minimumMinor: baseEntry?.minimumMinor ?? null,
          missingMarginCost: Boolean(baseEntry?.missingMarginCost),
          perPricelistPrices
        };
      });

      catalogProducts.push({
        guid: detail.guid || item.guid,
        visibility: detail.visibility ?? (item.active === false ? 'hidden' : 'normal'),
        brand: detail.brand?.name || detail.brand?.code || null,
        brandId,
        categoryIds,
        variants
      });
    }
    page++;
  }

  if (catalogProducts.length === 0) {
    hasVerifiedPagination = false;
  }
  if (expectedTotalCount !== null && catalogProducts.length !== expectedTotalCount) {
    hasVerifiedPagination = false;
  }

  const fullCatalogVerified = hasVerifiedPagination && hasVerifiedPricePagination && page > pageCount;
  const pagination = {
    page: Math.max(1, page - 1),
    pageCount,
    isComplete: fullCatalogVerified
  };
  const minExpectedCombinations = Math.max(
    1,
    (expectedTotalCount !== null ? Math.max(expectedTotalCount, catalogProducts.length) : catalogProducts.length) * tiers.length
  );
  return { catalogProducts, pagination, fullCatalogVerified, minExpectedCombinations };
}

export async function handleAdminSettingsApi(request, env, ctx=null) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return jsonRes({ error: 'origin_denied' }, 403);

  const identity = await requireSession(request, env);
  if (!identity) return jsonRes({ error: 'unauthorized' }, 401);
  const shopId = identity.shopId;
  const route = url.pathname.replace(/^\/admin\/settings\/api/, '');

  if(route==='/webhooks/enable'&&request.method==='POST'){
    let body;try{body=await request.json();}catch{return jsonRes({error:'invalid_request'},400);}
    if(!body||Object.keys(body).length!==1||body.confirm!=='initialize_installation_webhook_signing')return jsonRes({error:'explicit_confirmation_required'},400);
    try{return jsonRes(await initializeWebhookKey({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS}));}catch{return jsonRes({error:'webhook_setup_requires_attention',message:'Bezpečné notifikace nelze zapnout. Zkontrolujte oprávnění a diagnostiku; neznámý výsledek se automaticky neopakuje.'},409);}
  }
  if(route==='/webhooks/status'&&request.method==='GET')return jsonRes(await lifecycleReady(env.DB,shopId));

  if(route==='/installation/retry'&&request.method==='POST'){
    const changed=await env.DB.prepare("UPDATE installation_verification_jobs SET state='queued',run_id=NULL,attempts=0,error_code=NULL,next_attempt_at=0,updated_at=unixepoch() WHERE shop_id=? AND state IN('failed','queued') AND EXISTS(SELECT 1 FROM installations WHERE shop_id=? AND state='pending')").bind(shopId,shopId).run();
    if(!changed.meta?.changes)return jsonRes({error:'verification_not_retryable'},409);
    if(ctx?.waitUntil)ctx.waitUntil(verifyInstallation({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS}));
    return jsonRes({queued:true});
  }

  if(route.startsWith('/catalog/')){
    const installed=await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();if(installed?.state!=='active')return jsonRes({error:'inactive_installation'},403);
    if(request.method!=='GET')return jsonRes({error:'method_not_allowed'},405);
    try{
      const catalog=createShoptetAdapter({getToken:async()=> (await getShoptetApiAccessToken({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS})).apiAccessToken});
      if(route==='/catalog/brands')return jsonRes(await catalog.list('brands',{page:Number(url.searchParams.get('page')||1),limit:50,query:url.searchParams.get('query')||''}));
      if(route==='/catalog/brand'){const id=url.searchParams.get('id')||'';if(!/^[a-f0-9-]{36}$/i.test(id))return jsonRes({error:'invalid_brand_id'},400);return jsonRes(await catalog.brand(id));}
      if(route==='/catalog/products')return jsonRes(await catalog.list('products',{page:Number(url.searchParams.get('page')||1),limit:50,query:url.searchParams.get('query')||''}));
      if(route==='/catalog/product'){const id=url.searchParams.get('id')||'';if(!/^[a-f0-9-]{36}$/i.test(id))return jsonRes({error:'invalid_product_id'},400);return jsonRes(await catalog.product(id));}
      if(route==='/catalog/categories')return jsonRes(await catalog.list('categories',{page:Number(url.searchParams.get('page')||1),limit:50,query:url.searchParams.get('query')||''}));
      if(route==='/catalog/category'){const id=url.searchParams.get('id')||'';if(!/^[a-f0-9-]{36}$/i.test(id))return jsonRes({error:'invalid_category_id'},400);return jsonRes(await catalog.category(id));}
      if(route==='/catalog/pricelists')return jsonRes(await catalog.list('pricelists'));
    }catch{return jsonRes({error:'catalog_unavailable',message:'Katalog není dostupný. Ověřte připojení Shoptetu a schválená oprávnění.'},502);}
    return jsonRes({error:'not_found'},404);
  }

  if(route.startsWith('/sync/')){
    const installed=await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();if(installed?.state!=='active')return jsonRes({error:'inactive_installation'},403);
    try{const sync=syncRuntime(env,shopId);
      if(route==='/sync/pending'&&request.method==='GET')return jsonRes(await sync.service.pending(shopId));
      if(route==='/sync/history'&&request.method==='GET')return jsonRes(await sync.service.history(shopId));
      if(request.method==='POST'){
        const body=await request.json();if(!body||Array.isArray(body)||Object.keys(body).length!==1)return jsonRes({error:'invalid_request'},400);
        if(route==='/sync/plan'&&typeof body.planId==='string')return jsonRes(await sync.service.getPlan(shopId,body.planId));
        if(route==='/sync/approve'&&typeof body.approvalId==='string')return jsonRes(await sync.service.approve(shopId,body.approvalId,await sha256Hex(bearerFrom(request))));
        if(route==='/sync/progress'&&typeof body.jobId==='string')return jsonRes(await sync.service.progress(shopId,body.jobId));
      }
    }catch{return jsonRes({error:'sync_action_failed'},409);}
    return jsonRes({error:'not_found'},404);
  }

  if(route.startsWith('/oauth/')){
    const installed=await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();
    if(installed?.state!=='active')return jsonRes({error:'inactive_installation'},403);
    try{
      const oauth=createMcpOAuth(env.DB,oauthConfiguration(env));
      if(route==='/oauth/connections' && request.method==='GET')return jsonRes(await oauth.connections(shopId));
      if(request.method==='POST'){
        const body=await request.json();if(!body||Array.isArray(body)||Object.keys(body).length!==1)return jsonRes({error:'invalid_request'},400);
        if(route==='/oauth/inspect' && /^[a-f0-9]{64}$/.test(body.requestId??''))return jsonRes(await oauth.inspect(body.requestId));
        if(route==='/oauth/consent' && /^[a-f0-9]{64}$/.test(body.requestId??''))return jsonRes(await oauth.consent(body.requestId,shopId,await digest(bearerFrom(request))));
        if(route==='/oauth/disconnect' && typeof body.grantId==='string')return jsonRes(await oauth.disconnect(shopId,body.grantId));
      }
    }catch(error){return jsonRes({error:error instanceof OAuthError?error.code:'oauth_action_unavailable',...(error?.code==='signed_lifecycle_required'?{message:'Nejdřív v Přehledu zapněte bezpečná oznámení Shoptetu.'}:{})},400);}
    return jsonRes({error:'not_found'},404);
  }

  if (route.startsWith('/configuration/')) {
    const installed=await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();
    if(installed?.state!=='active') return jsonRes({error:'inactive_installation'},403);
    const service=createConfigurationService(env.DB);
    try {
      if(route==='/configuration/pending' && request.method==='GET') return jsonRes({approvals:await service.pending(shopId)});
      if(route==='/configuration/history' && request.method==='GET') return jsonRes(await service.history(shopId));
      if(route==='/configuration/preview' && request.method==='POST') {
        const body=await request.json();
        if(Object.keys(body).length!==1 || typeof body.revisionId!=='string') return jsonRes({error:'invalid_request'},400);
        return jsonRes(await service.preview(shopId,body.revisionId));
      }
      if(route==='/configuration/approve' && request.method==='POST') {
        const body=await request.json();
        if(Object.keys(body).length!==1 || typeof body.approvalId!=='string') return jsonRes({error:'invalid_request'},400);
        return jsonRes(await service.approve(shopId,body.approvalId,await sha256Hex(bearerFrom(request))));
      }
    } catch {return jsonRes({error:'configuration_action_failed'},409);}
    return jsonRes({error:'not_found'},404);
  }

  if (route.startsWith('/reconciliation/')) {
    const installed = await env.DB.prepare('SELECT i.state FROM installations i LEFT JOIN shoptet_oauth o ON o.shop_id=i.shop_id WHERE i.shop_id=?').bind(shopId).first();
    if (installed?.state !== 'active') return jsonRes({ error: 'inactive_installation' }, 403);

    if (route === '/reconciliation/status' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT config_json FROM tenant_settings WHERE shop_id=?').bind(shopId).first();
      const { config } = parseConfig(row);
      return jsonRes({
        status: config.lastReconciliation ? 'completed' : 'idle',
        lastReconciliation: config.lastReconciliation || null,
        remediationMode: 'OFF',
        autoRemediationEnabled: false
      });
    }

    if (route === '/reconciliation/run' && request.method === 'POST') {
      let body = {};
      try {
        const rawText = await request.text();
        if (rawText && rawText.trim() !== '') {
          body = JSON.parse(rawText);
        }
      } catch {
        return jsonRes({ error: 'invalid_json', message: 'Neplatný formát požadavku.' }, 400);
      }

      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0) {
        return jsonRes({
          error: 'caller_supplied_reconciliation_data_forbidden',
          message: 'Kontrola souladu smí číst pouze serverově ověřená data přímo ze Shoptet API.'
        }, 400);
      }

      const row = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id=?').bind(shopId).first();
      const { config, version } = parseConfig(row);
      const rawTiers = Array.isArray(config.tiers) ? config.tiers : [];
      const tiers = rawTiers.filter(t => Number.isSafeInteger(Number(t.pricelistId)) && Number(t.pricelistId) > 0).map(t => ({
        name: t.name,
        percent: Number(t.percent),
        pricelistId: Number(t.pricelistId)
      }));
      if (!tiers.length) {
        return jsonRes({ error: 'no_configured_tier_pricelists', message: 'Pro spuštění kontroly nejprve nastavte a namapujte věrnostní ceníky.' }, 422);
      }

      const rules = config.rules || {};
      const couponMode = rules.couponMode || 'fixed-amount';
      const couponCeilingPercent = rules.couponCeilingPercent !== undefined && rules.couponCeilingPercent !== null
        ? Number(rules.couponCeilingPercent)
        : null;
      if (couponMode === 'percent-ceiling' && (!Number.isFinite(couponCeilingPercent) || couponCeilingPercent <= 0 || couponCeilingPercent > 100)) {
        return jsonRes({
          error: 'missing_coupon_ceiling_percent',
          message: 'Pro procentní režim kupónů musí být v pravidlech slev nastaven platný maximální strop kupónu v procentech.'
        }, 422);
      }

      const adapter = typeof env.createShoptetAdapter === 'function'
        ? await env.createShoptetAdapter(shopId)
        : createShoptetAdapter({
            getToken: async () => (await getShoptetApiAccessToken({ db: env.DB, shopId, tokenKeys: env.SHOPTET_TOKEN_KEYS })).apiAccessToken
          });

      const policyRow = await getPricelistPolicy(env.DB, shopId);
      let profile = null;
      try {
        profile = typeof adapter.profile === 'function' ? await adapter.profile() : null;
      } catch (err) {
        if (!policyRow?.defaultPricelistId) {
          return jsonRes({ error: 'reconciliation_failed', message: err.message || 'Nepodařilo se ověřit profil obchodu a výchozí ceník ze Shoptetu.' }, 422);
        }
      }

      const resolvedDefaultPricelistId = policyRow?.defaultPricelistId ?? profile?.defaultPricelistId;
      const defaultPricelistId = Number(resolvedDefaultPricelistId);
      if (!Number.isSafeInteger(defaultPricelistId) || defaultPricelistId <= 0) {
        return jsonRes({
          error: 'missing_default_pricelist_id',
          message: 'Výchozí (hlavní) ceník obchodu není serverově ověřen. Zkontrolujte nastavení ceníků.'
        }, 422);
      }
      if (tiers.some(t => t.pricelistId === defaultPricelistId)) {
        return jsonRes({
          error: 'default_pricelist_protected',
          message: 'Výchozí (hlavní) ceník obchodu nesmí být použit jako věrnostní ceník.'
        }, 422);
      }

      const managedPricelistIds = tiers.map(t => t.pricelistId);

      const brandCaps = Object.entries(rules.brandLimits || {}).map(([id, percent]) => ({ id, percent: Number(percent) }));
      const categoryCaps = Object.entries(rules.categoryLimits || {}).map(([id, percent]) => ({ id, percent: Number(percent) }));
      const productCaps = Object.entries(rules.productLimits || {}).map(([id, percent]) => ({ id, percent: Number(percent) }));

      const lockedTierNames = [];
      if (rules.couponLockTopTiers !== false && tiers.length > 0) {
        const sorted = tiers.slice().sort((a, b) => b.percent - a.percent);
        const topCount = Math.max(1, Math.ceil(sorted.length * 0.25));
        for (let i = 0; i < topCount; i++) {
          if (sorted[i]?.name) lockedTierNames.push(sorted[i].name);
        }
      }
      if (rules.couponLockMinPercent != null && Number(rules.couponLockMinPercent) > 0) {
        for (const t of tiers) {
          if (t.percent >= Number(rules.couponLockMinPercent) && !lockedTierNames.includes(t.name)) {
            lockedTierNames.push(t.name);
          }
        }
      }

      const policy = {
        version,
        capPriority: rules.capPriority || 'hierarchy',
        salePolicy: rules.highestDiscountWins !== false ? 'okfish_compatible' : 'lowest_price',
        brandCaps,
        categoryCaps,
        productCaps,
        scheduledPromotions: Array.isArray(rules.scheduledPromotions) ? rules.scheduledPromotions : [],
        brandPromotions: Array.isArray(rules.brandPromotions) ? rules.brandPromotions : []
      };

      const couponConfig = {
        mode: couponMode,
        ceilingPercent: couponMode === 'percent-ceiling' ? couponCeilingPercent : null,
        capPriority: rules.capPriority || 'hierarchy',
        defaultPricelistId,
        managedPricelistIds,
        lockedTierNames,
        brandCaps,
        categoryCaps,
        productCaps,
        scheduledPromotions: Array.isArray(rules.scheduledPromotions) ? rules.scheduledPromotions : [],
        brandPromotions: Array.isArray(rules.brandPromotions) ? rules.brandPromotions : []
      };

      try {
        const verified = await fetchVerifiedStoreCatalogForReconciliation({
          adapter,
          profile,
          defaultPricelistId,
          tiers,
          minMarginPercent: rules.minMarginPercent
        });

        const reconciliationAdapter = {
          ...adapter,
          isFullCatalogVerified: () => verified.fullCatalogVerified
        };

        const [priceReport, couponReport] = await Promise.all([
          reconcilePrices({
            adapter: reconciliationAdapter,
            shopId,
            policy,
            tiers,
            catalogProducts: verified.catalogProducts,
            pagination: verified.pagination,
            fullCatalogVerified: verified.fullCatalogVerified,
            minExpectedCombinations: verified.minExpectedCombinations
          }),
          reconcileCoupons({
            adapter: reconciliationAdapter,
            shopId,
            couponConfig,
            tiers,
            catalogProducts: verified.catalogProducts,
            pagination: verified.pagination,
            fullCatalogVerified: verified.fullCatalogVerified,
            minExpectedCombinations: verified.minExpectedCombinations
          })
        ]);

        const classifiedDrifts = [
          ...priceReport.drifts.map(d => ({
            ...d,
            domain: 'price',
            remediation: classifyRemediationEligibility({
              item: {
                shopId,
                variantCode: d.code,
                pricelistId: d.targetPricelistId,
                driftType: 'price_drift',
                field: 'price',
                expected: d.expected,
                actual: d.actual
              },
              selfCheckPassed: priceReport.selfCheckPassed,
              autoEnabled: false,
              verifiedTenantShopId: shopId,
              managedPricelistIds,
              isProtectedPricelist: d.targetPricelistId === defaultPricelistId,
              hasManualSaleConflict: d.reason === 'manual_action_below_margin_floor'
            })
          })),
          ...couponReport.drifts.map(d => ({
            ...d,
            domain: 'coupon',
            remediation: classifyRemediationEligibility({
              item: {
                shopId,
                variantCode: d.code,
                pricelistId: d.targetPricelistId,
                driftType: d.reason === 'locked_tier_coupon_enabled' ? 'locked_tier_violation' : 'coupon_drift',
                field: 'discountCoupon',
                expected: d.expected,
                actual: d.actual
              },
              selfCheckPassed: couponReport.selfCheckPassed,
              autoEnabled: false,
              verifiedTenantShopId: shopId,
              managedPricelistIds,
              isProtectedPricelist: d.targetPricelistId === defaultPricelistId
            })
          }))
        ];

        const lastReconciliation = {
          checkedAt: new Date().toISOString(),
          policyVersion: version,
          remediationMode: 'OFF',
          autoRemediationEnabled: false,
          priceReport,
          couponReport,
          classifiedDrifts
        };

        const nextConfig = { ...config, lastReconciliation };
        if (row) {
          await env.DB.prepare('UPDATE tenant_settings SET config_json = ? WHERE shop_id = ?')
            .bind(JSON.stringify(nextConfig), shopId).run();
        } else {
          await env.DB.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1) ON CONFLICT(shop_id) DO UPDATE SET config_json = excluded.config_json')
            .bind(shopId, JSON.stringify(nextConfig)).run();
        }

        return jsonRes({
          status: 'completed',
          lastReconciliation,
          remediationMode: 'OFF',
          autoRemediationEnabled: false
        });
      } catch (err) {
        return jsonRes({ error: 'reconciliation_failed', message: err.message || 'Kontrolu souladu cen a kupónů se nepodařilo dokončit.' }, 422);
      }
    }

    return jsonRes({ error: 'not_found' }, 404);
  }

  if (route.startsWith('/loyalty/')) {
    const installed = await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();
    if (installed?.state !== 'active') return jsonRes({ error: 'inactive_installation' }, 403);

    const adapter = createShoptetAdapter({
      getToken: async () => (await getShoptetApiAccessToken({ db: env.DB, shopId, tokenKeys: env.SHOPTET_TOKEN_KEYS })).apiAccessToken,
      authorizeWrite: async () => true
    });

    try {
      if (route === '/loyalty/status' && request.method === 'GET') {
        const policyRow = await getPricelistPolicy(env.DB, shopId);
        const engineMode = policyRow?.engineMode || 'installation';
        const latestPlan = await getLatestRecalculationPlan(env.DB, shopId);
        return jsonRes({ engineMode, latestPlan });
      }

      if (route === '/loyalty/dry-run' && request.method === 'POST') {
        const settingsRow = await env.DB.prepare('SELECT config_json FROM tenant_settings WHERE shop_id=?').bind(shopId).first();
        const config = settingsRow ? JSON.parse(settingsRow.config_json) : {};
        const policy = config.turnoverPolicy || {
          period: { from: '2020-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' },
          qualifyingStatusIds: [-3],
          requirePaid: true,
          shipping: 'exclude',
          billing: 'exclude',
          discounts: 'after_discounts',
          vat: 'inclusive',
          refunds: 'exclude_order_with_valid_credit_note',
          guestCustomers: 'exclude',
          itemStatuses: 'require_match_order',
          upgrades: 'recalculate',
          downgrades: 'keep_current'
        };
        const tiers = config.tiers || [];
        const plan = await generateCustomerRecalculationPlan({
          db: env.DB,
          shopId,
          adapter,
          policy,
          tiers
        });
        return jsonRes(plan);
      }

      if (route === '/loyalty/plan' && request.method === 'GET') {
        const url = new URL(request.url);
        const planId = url.searchParams.get('planId');
        let targetPlanId = planId;
        if (!targetPlanId) {
          const latest = await getLatestRecalculationPlan(env.DB, shopId);
          targetPlanId = latest?.plan_id;
        }
        if (!targetPlanId) return jsonRes({ plan: null, items: [] });
        const details = await getRecalculationPlanDetails(env.DB, shopId, targetPlanId);
        return jsonRes(details || { plan: null, items: [] });
      }

      if (route === '/loyalty/approve' && request.method === 'POST') {
        const body = await request.json();
        if (!body.planId || typeof body.planId !== 'string') return jsonRes({ error: 'invalid_request' }, 400);
        const res = await approveRecalculationPlan(env.DB, shopId, body.planId);
        return jsonRes(res);
      }

      if (route === '/loyalty/sync' && request.method === 'POST') {
        const body = await request.json();
        if (!body.planId || typeof body.planId !== 'string') return jsonRes({ error: 'invalid_request' }, 400);
        const res = await executeCustomerRecalculationBatch({
          db: env.DB,
          shopId,
          planId: body.planId,
          adapter,
          batchSize: 50
        });
        return jsonRes(res);
      }
    } catch (e) {
      const code = e?.code || e?.message;
      const safeMap = {
        incomplete_data_credit_notes_missing: 'Návrh nelze schválit, protože chybí data o dobropisech (aplikace nemá v Shoptetu potřebná oprávnění).',
        credit_notes_permission_missing: 'Návrh nelze schválit, protože chybí data o dobropisech (aplikace nemá v Shoptetu potřebná oprávnění).',
        plan_not_found: 'Plán přepočtu nebyl nalezen.',
        plan_already_processed: 'Tento plán byl již dříve zpracován nebo schválen.',
        plan_expired: 'Platnost plánu vypršela. Vygenerujte prosím nový Dry Run.',
        plan_stale_configuration_changed: 'Konfigurace pravidel nebo ceníků se od vytvoření plánu změnila. Vygenerujte prosím nový kontrolní Dry Run.',
        plan_not_approved: 'Plán ještě nebyl schválen obchodníkem.',
        pricelist_policy_required: 'Chybí nastavení věrnostních ceníků.',
        permission_missing: 'Aplikace nemá v Shoptetu potřebná oprávnění (zkontrolujte práva v Shoptet Partner portálu).',
        upstream_unavailable: 'Shoptet API je dočasně nedostupné. Zkuste to prosím za chvíli.',
        rate_limited: 'Byl dosažen limit volání Shoptet API. Počkejte chvíli a akci opakujte.'
      };
      const safeMessage = typeof code === 'string' && safeMap[code]
        ? safeMap[code]
        : 'Operaci se nepodařilo dokončit. Zkontrolujte nastavení a zkuste to znovu.';
      const safeCode = typeof code === 'string' && safeMap[code] ? code : 'loyalty_action_failed';
      return jsonRes({ error: safeCode, message: safeMessage }, 409);
    }
    return jsonRes({ error: 'not_found' }, 404);
  }

  if (route.startsWith('/onboarding/')) {
    const installed = await env.DB.prepare('SELECT state FROM installations WHERE shop_id=?').bind(shopId).first();
    if (installed?.state !== 'active') return jsonRes({ error: 'inactive_installation' }, 403);

    const adapter = createShoptetAdapter({
      getToken: async () => (await getShoptetApiAccessToken({ db: env.DB, shopId, tokenKeys: env.SHOPTET_TOKEN_KEYS })).apiAccessToken,
      authorizeWrite: async (action) => true
    });

    if (route === '/onboarding/periods' && request.method === 'GET') {
      return jsonRes({ periods: Object.values(SUPPORTED_PERIODS) });
    }

    if (route === '/onboarding/retention-policies' && request.method === 'GET') {
      return jsonRes({ policies: Object.values(RETENTION_POLICIES) });
    }

    if (route === '/onboarding/overview' && request.method === 'GET') {
      try {
        const storeData = await inspectStoreOnboardingData({ adapter });
        return jsonRes(storeData);
      } catch (e) {
        return jsonRes({ error: 'store_inspection_failed', message: 'Nepodařilo se načíst data z vašeho e-shopu. Zkontrolujte oprávnění v Shoptet Partner portálu.' }, 502);
      }
    }

    if (route === '/onboarding/validate' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonRes({ error: 'invalid_json' }, 400); }
      const validation = validateOnboardingConfig(body);
      if (!validation.valid) {
        return jsonRes({ error: 'validation_failed', message: validation.error }, 400);
      }
      return jsonRes({ valid: true, config: validation.config });
    }

    if (route === '/onboarding/setup-entities' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return jsonRes({ error: 'invalid_json' }, 400); }
      const validation = validateOnboardingConfig(body);
      if (!validation.valid) {
        return jsonRes({ error: 'validation_failed', message: validation.error }, 400);
      }

      try {
        const [existingPricelistsRes, existingGroups] = await Promise.all([
          adapter.list('pricelists'),
          adapter.customerGroups()
        ]);

        const result = await setupLoyaltyEntities({
          adapter,
          shopId,
          tiers: validation.config.tiers,
          autoCreate: body.autoCreate === true,
          existingPricelists: existingPricelistsRes.items || [],
          existingGroups: existingGroups || []
        });

        if (result.status === 'READY') {
          const row = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
          const { config } = parseConfig(row);
          config.onboarding = {
            completedAt: new Date().toISOString(),
            period: validation.config.period,
            retentionPolicy: validation.config.retentionPolicy,
            inactivityDays: validation.config.inactivityDays ?? null,
            warningDays: validation.config.warningDays ?? null
          };
          config.tiers = result.entities;
          await env.DB.prepare(`
            INSERT INTO tenant_settings (shop_id, config_json, version)
            VALUES (?, ?, 1)
            ON CONFLICT(shop_id) DO UPDATE SET config_json = excluded.config_json, version = version + 1
          `).bind(shopId, JSON.stringify(config)).run();
        }

        return jsonRes(result);
      } catch (err) {
        return jsonRes({ error: 'entity_setup_failed', message: 'Při přípravě ceníků a skupin došlo k chybě. Zkontrolujte oprávnění aplikace.' }, 500);
      }
    }

    return jsonRes({ error: 'not_found' }, 404);
  }

  if (route === '/state' && request.method === 'GET') {
    const inst = await env.DB.prepare(`
      SELECT i.state, i.created_at, i.updated_at, o.eshop_url, o.contact_email
      FROM installations i LEFT JOIN shoptet_oauth o ON o.shop_id = i.shop_id
      WHERE i.shop_id = ?
    `).bind(shopId).first();
    const { config, version } = parseConfig(await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first());
    const tokens = await env.DB.prepare(`
      SELECT substr(token_sha256, 1, 8) AS fp, scopes_json, created_at, expires_at
      FROM mcp_credentials
      WHERE shop_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      ORDER BY created_at DESC
    `).bind(shopId).all();

    const defaultRules = {
      couponLockTopTiers: true,
      couponLockMinPercent: null,
      couponLockMaxRemaining: true,
      couponMode: 'fixed-amount',
      couponCeilingPercent: null,
      capPriority: 'hierarchy',
      minMarginPercent: null,
      highestDiscountWins: true,
      vatIntegrity: true,
      postWriteVerify: true,
      brandLimits: {},
      categoryLimits: {},
      productLimits: {},
      scheduledPromotions: [],
      brandPromotions: []
    };
    const rules = { ...defaultRules, ...(config.rules || {}) };

    const tiers = Array.isArray(config.tiers) ? config.tiers : [];

    return jsonRes({
      shopId,
      verification:await env.DB.prepare('SELECT state,attempts,error_code,next_attempt_at FROM installation_verification_jobs WHERE shop_id=?').bind(shopId).first(),
      installation: inst || null,
      tiers,
      rules,
      ui: Object.fromEntries(Object.entries(UI_DEFAULTS).map(([k, v]) => [k, config.ui?.[k] ?? v])),
      version,
      currency:config.loyaltyProposal?.currency??null,
      onboarding: config.onboarding || null,
      periods: Object.values(SUPPORTED_PERIODS),
      retentionPolicies: Object.values(RETENTION_POLICIES),
      mcpTokens: (tokens.results || []).map(t => ({
        fingerprint: t.fp,
        createdAt: t.created_at,
        expiresAt: t.expires_at,
        scopes: (() => { try { return JSON.parse(t.scopes_json); } catch { return []; } })()
      })),
      mcpEndpoint: `${url.origin}/mcp`
    });
  }

  if (route === '/tiers' && request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return jsonRes({ error: 'Neplatný JSON.' }, 400); }
    if (!body || !Number.isSafeInteger(body.version) || body.version < 0) return jsonRes({ error: 'Chybí verze nastavení.' }, 400);
    const v = validateTiers(body.tiers);
    if (v.error) return jsonRes({ error: v.error }, 422);

    if (v.tiers.some(t => t.pricelistId)) {
      try {
        const catalog = createShoptetAdapter({ getToken: async () => (await getShoptetApiAccessToken({ db: env.DB, shopId, tokenKeys: env.SHOPTET_TOKEN_KEYS })).apiAccessToken });
        for (const t of v.tiers) {
          if (t.pricelistId) {
            try {
              const pl = await catalog.pricelist(t.pricelistId);
              if (!pl || pl.id !== t.pricelistId) return jsonRes({ error: `Ceník ${t.pricelistId} již neexistuje v Shoptetu.` }, 422);
            } catch {
              return jsonRes({ error: `Ceník ${t.pricelistId} již neexistuje v Shoptetu.` }, 422);
            }
          }
        }
      } catch {
        return jsonRes({ error: 'Ceníky Shoptetu nelze ověřit. Zkontrolujte oprávnění.' }, 422);
      }
    }

    const current = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
    const { config, version } = parseConfig(current);
    if (version !== body.version) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.', version }, 409);
    const next = { ...config, tiers: v.tiers, ...(body.onboarding ? { onboarding: body.onboarding } : {}) };

    let result;
    if (current) {
      result = await env.DB.prepare('UPDATE tenant_settings SET config_json = ?, version = version + 1 WHERE shop_id = ? AND version = ?')
        .bind(JSON.stringify(next), shopId, version).run();
    } else {
      result = await env.DB.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1) ON CONFLICT(shop_id) DO NOTHING')
        .bind(shopId, JSON.stringify(next)).run();
    }
    if (!result?.meta?.changes) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.' }, 409);
    return jsonRes({ status: 'saved', tiers: v.tiers, version: version + 1 });
  }

  if (route === '/rules' && request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return jsonRes({ error: 'Neplatný JSON.' }, 400); }
    if (!body || !Number.isSafeInteger(body.version) || body.version < 0) return jsonRes({ error: 'Chybí verze nastavení.' }, 400);
    const v = validateRules(body.rules);
    if (v.error) return jsonRes({ error: v.error }, 422);
    if(Object.keys(v.rules.brandLimits).length || Object.keys(v.rules.productLimits).length || Object.keys(v.rules.categoryLimits).length){
      try{
        const catalog=createShoptetAdapter({getToken:async()=> (await getShoptetApiAccessToken({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS})).apiAccessToken});
        for(const id of Object.keys(v.rules.brandLimits))if(!await catalog.verifyBrand(id))return jsonRes({error:'Značka již neexistuje v katalogu.'},422);
        for(const id of Object.keys(v.rules.productLimits)){try{await catalog.product(id);}catch{return jsonRes({error:'Produkt již neexistuje v katalogu.'},422);}}
        for(const id of Object.keys(v.rules.categoryLimits)){try{await catalog.category(id);}catch{return jsonRes({error:'Kategorie již neexistuje v katalogu.'},422);}}
      }catch{return jsonRes({error:'Položky katalogu nelze ověřit. Zkontrolujte oprávnění Shoptetu.'},422);}
    }

    const current = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
    const { config, version } = parseConfig(current);
    if (version !== body.version) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.', version }, 409);
    const next = { ...config, rules: v.rules };

    let result;
    if (current) {
      result = await env.DB.prepare('UPDATE tenant_settings SET config_json = ?, version = version + 1 WHERE shop_id = ? AND version = ?')
        .bind(JSON.stringify(next), shopId, version).run();
    } else {
      result = await env.DB.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1) ON CONFLICT(shop_id) DO NOTHING')
        .bind(shopId, JSON.stringify(next)).run();
    }
    if (!result?.meta?.changes) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.' }, 409);
    return jsonRes({ status: 'saved', rules: v.rules, version: version + 1 });
  }

  if (route === '/section' && request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return jsonRes({ error: 'Neplatný JSON.' }, 400); }
    if (!body || !Number.isSafeInteger(body.version) || body.version < 0) return jsonRes({ error: 'Chybí verze nastavení.' }, 400);
    const checked = validateUiSection(body.section, body.value);
    if (checked.error) return jsonRes({ error: checked.error }, 422);

    const current = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
    const { config, version } = parseConfig(current);
    if (version !== body.version) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.', version }, 409);

    const next = { ...config, ui: { ...(config.ui || {}), [body.section]: checked.value } };

    let result;
    if (current) {
      result = await env.DB.prepare('UPDATE tenant_settings SET config_json = ?, version = version + 1 WHERE shop_id = ? AND version = ?')
        .bind(JSON.stringify(next), shopId, version).run();
    } else {
      result = await env.DB.prepare('INSERT INTO tenant_settings (shop_id, config_json, version) VALUES (?, ?, 1) ON CONFLICT(shop_id) DO NOTHING')
        .bind(shopId, JSON.stringify(next)).run();
    }
    if (!result?.meta?.changes) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.' }, 409);
    return jsonRes({ status: 'saved', section: body.section, value: checked.value, version: version + 1 });
  }

  if (route === '/mcp-token' && request.method === 'DELETE') {
    await env.DB.prepare('UPDATE mcp_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND revoked_at IS NULL AND oauth_grant_id IS NULL').bind(shopId).run();
    return jsonRes({ revoked: true });
  }

  if (route === '/mcp-token' && request.method === 'POST') {
    const installed=await env.DB.prepare('SELECT oauth_envelope FROM shoptet_oauth WHERE shop_id=?').bind(shopId).first();if(installed&&!(await lifecycleReady(env.DB,shopId)).ready)return jsonRes({error:'signed_lifecycle_required',message:'Nejdřív v Přehledu zapněte bezpečná oznámení Shoptetu.'},409);
    let body;try{body=await request.json();}catch{return jsonRes({error:'invalid_json'},400);}
    if(!body || Array.isArray(body) || Object.keys(body).some(k=>k!=='permissions') || (body.permissions!==undefined && (!Array.isArray(body.permissions)||body.permissions.some(k=>!['pricing:configure','pricing:execute','sync:execute','audit:read','customers:read'].includes(k)))))return jsonRes({error:'invalid_permissions'},400);
    const scopes=[...MCP_UI_SCOPES,...new Set(body.permissions||[])];
    const raw = new Uint8Array(24);
    crypto.getRandomValues(raw);
    const token = 'lcode_mcp_' + [...raw].map(b => b.toString(16).padStart(2, '0')).join('');
    const digest = await sha256Hex(token);
    await env.DB.batch([
      env.DB.prepare('UPDATE mcp_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND revoked_at IS NULL AND oauth_grant_id IS NULL').bind(shopId),
      env.DB.prepare("INSERT INTO mcp_credentials (token_sha256, shop_id, scopes_json, expires_at) VALUES (?, ?, ?, datetime('now', '+7 days'))").bind(digest, shopId, JSON.stringify(scopes))
    ]);
    return jsonRes({ token, fingerprint: digest.slice(0, 8), scopes });
  }

  return jsonRes({ error: 'not_found' }, 404);
}

/* ---------------------------------------------------------------- render */

const SHOPTET_STYLES = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #f0f2f5;
      color: #333333;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      padding: 20px;
    }

    .page-card {
      background: #ffffff;
      border: 1px solid #e2e5e8;
      border-radius: 4px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      padding: 24px 34px 40px;
      max-width: 1140px;
      margin: 0 auto;
      min-height: 520px;
    }

    /* Breadcrumbs */
    .breadcrumbs {
      font-size: 11px;
      color: #888888;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .breadcrumbs .sep { color: #cccccc; }
    .breadcrumbs .current { color: #555555; }

    /* Top Title Row */
    .title-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
    }
    .page-title {
      font-size: 32px;
      font-weight: 300;
      color: #25a9e0;
      line-height: 1.2;
      margin: 0;
    }
    .top-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    /* Buttons */
    .btn-shoptet-green {
      background-color: #79b928;
      color: #ffffff;
      font-size: 13px;
      font-weight: bold;
      border-radius: 3px;
      border: none;
      padding: 6px 18px;
      cursor: pointer;
      line-height: 1.4;
      transition: background 0.15s ease;
    }
    .btn-shoptet-green:hover {
      background-color: #65a01c;
    }
    .btn-secondary {
      background: #ffffff;
      border: 1px solid #cfcfcf;
      border-radius: 3px;
      color: #333333;
      font-size: 13px;
      padding: 6px 14px;
      cursor: pointer;
      line-height: 1.4;
      transition: background 0.15s ease;
    }
    .btn-secondary:hover {
      background: #f7f7f7;
    }
    .btn-remove {
      background: none;
      border: none;
      color: #d9534f;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 4px;
      font-weight: bold;
    }
    .btn-remove:hover {
      color: #c9302c;
    }
    button[disabled] {
      opacity: 0.55;
      cursor: default;
    }

    /* Shoptet Tabs */
    .shoptet-tabs {
      display: flex;
      gap: 2px;
      border-bottom: 1px solid #d9d9d9;
      margin-bottom: 18px;
    }
    .shoptet-tab {
      background: #f3f3f3;
      color: #444444;
      border: 1px solid #d9d9d9;
      border-bottom: none;
      border-radius: 3px 3px 0 0;
      padding: 7px 18px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      margin-bottom: 0;
      outline: none;
      transition: background 0.1s ease;
    }
    .shoptet-tab:hover {
      background: #ebebeb;
      color: #222222;
    }
    .shoptet-tab.active {
      background: #ffffff;
      color: #111111;
      font-weight: bold;
      border-bottom: 1px solid #ffffff;
      margin-bottom: -1px;
    }

    .tab-intro {
      color: #444444;
      font-size: 13px;
      margin: 0 0 22px 0;
      line-height: 1.5;
    }

    /* Section Headings */
    .section-heading {
      display: flex;
      align-items: center;
      gap: 14px;
      margin: 28px 0 16px;
      color: #25a9e0;
      font-size: 20px;
      font-weight: 300;
    }
    .section-heading::after {
      content: "";
      flex: 1;
      height: 1px;
      background: #e4e4e4;
    }

    /* Notice Box (Daně) */
    .shoptet-notice {
      background-color: #fffdf5;
      border: 1px solid #e6b85c;
      border-radius: 3px;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 22px;
      font-size: 13px;
      color: #333333;
    }
    .notice-icon {
      font-size: 18px;
      line-height: 1;
      color: #e6b85c;
    }

    /* Form Rows */
    .form-row {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
    }
    .form-label {
      width: 280px;
      text-align: right;
      padding-right: 18px;
      color: #333333;
      font-size: 13px;
      font-weight: 400;
    }
    .form-field {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #333333;
    }
    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      border: 1px solid #25a9e0;
      color: #25a9e0;
      font-size: 11px;
      font-family: serif;
      font-style: italic;
      font-weight: bold;
      cursor: help;
      background: #ffffff;
      margin-left: 4px;
      flex-shrink: 0;
    }

    /* Inputs */
    .input-text {
      height: 30px;
      border: 1px solid #cfcfcf;
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 13px;
      color: #333333;
      background: #ffffff;
      outline: none;
      font-family: inherit;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .input-text:focus {
      border-color: #25a9e0;
      box-shadow: 0 0 3px rgba(37,169,224,0.35);
    }
    .input-text[readonly] {
      background: #f9f9f9;
      color: #555555;
    }
    .w-small { width: 85px; }
    .w-med { width: 140px; }
    .w-full { width: 100%; }
    .unit { color: #666666; margin-left: 4px; }

    /* Table */
    .shoptet-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    .shoptet-table th {
      background-color: #f7f7f7;
      color: #555555;
      font-size: 12px;
      font-weight: bold;
      padding: 9px 12px;
      border-bottom: 1px solid #d9d9d9;
      text-align: left;
    }
    .shoptet-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #eeeeee;
      font-size: 13px;
      color: #333333;
      vertical-align: middle;
    }
    .shoptet-table tr:hover {
      background-color: #fafbfc;
    }

    /* Alerts */
    .flash-box {
      margin-bottom: 16px;
    }
    .alert-success {
      background: #dff0d8;
      border: 1px solid #d6e9c6;
      color: #3c763d;
      padding: 10px 14px;
      border-radius: 3px;
      font-size: 13px;
    }
    .alert-error {
      background: #f2dede;
      border: 1px solid #ebccd1;
      color: #a94442;
      padding: 10px 14px;
      border-radius: 3px;
      font-size: 13px;
    }

    .form-offset {
      margin: 8px 0 16px 298px;
    }

    .shoptet-table-responsive {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin-bottom: 16px;
    }

    /* Mobile responsive (Shoptet standard) */
    @media (max-width: 768px) {
      body {
        padding: 8px;
      }
      .page-card {
        padding: 16px 14px 24px;
        border-radius: 4px;
      }
      .title-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
        margin-bottom: 14px;
      }
      .page-title {
        font-size: 22px;
        line-height: 1.25;
      }
      .top-actions {
        width: 100%;
      }
      .top-actions .btn-shoptet-green {
        width: 100%;
        text-align: center;
        padding: 9px 18px;
      }
      .shoptet-tabs {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        gap: 4px;
        padding-bottom: 4px;
        border-bottom: 1px solid #d9d9d9;
      }
      .shoptet-tab {
        padding: 8px 14px;
        font-size: 13px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .tab-intro {
        font-size: 13px;
        margin-bottom: 16px;
      }
      .shoptet-notice {
        padding: 10px 12px;
        font-size: 12px;
        gap: 8px;
        margin-bottom: 16px;
      }
      .section-heading {
        font-size: 17px;
        margin: 20px 0 12px;
      }
      .form-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 6px;
        margin-bottom: 16px;
      }
      .form-label {
        width: 100%;
        text-align: left;
        padding-right: 0;
        font-weight: 600;
        font-size: 13px;
      }
      .form-field {
        width: 100%;
        flex-wrap: wrap;
        font-size: 13px;
      }
      .form-field .input-text {
        width: 100% !important;
        max-width: 100% !important;
      }
      .form-offset {
        margin: 8px 0 16px 0 !important;
      }
      .shoptet-table {
        min-width: 520px;
      }
      #brand-picker, #product-picker, #category-picker {
        max-width: 100% !important;
      }
      #brand-limits-container, #product-limits-container, #category-limits-container {
        max-width: 100% !important;
      }
      #brand-limits-container > div, #product-limits-container > div, #category-limits-container > div {
        max-width: 100% !important;
      }
    }

    .panel { display: none; }
    .panel.active { display: block; }
`;

function renderErrorPage(error, status) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const messages = {
    missing_code: 'Stránku otevřete z administrace Shoptetu: <strong>Propojení → L-Code Loyalty Pricing Engine B2C</strong>.',
    missing_eshop_id: 'V adrese chybí parametr <code>eshopId</code>.',
    not_installed: 'Doplněk není na tomto e-shopu nainstalovaný.',
    invalid_preview_key: 'Neplatný náhledový klíč.',
    shop_mismatch: 'Přihlášený uživatel nepatří k tomuto e-shopu.',
    session_secret_not_configured: 'Server není nakonfigurovaný.',
    client_not_configured: 'Server nemá nakonfigurovaný Shoptet klient.'
  };
  const msg = messages[error] || `Ověření uživatele se nezdařilo (${escapeHtml(error)}). Zkuste stránku otevřít znovu z administrace.`;
  return new Response(`<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>L-Code Loyalty Pricing Engine B2C</title><style>${SHOPTET_STYLES}</style></head><body><div class="page-card">
<div class="title-row"><h1 class="page-title">L-Code Loyalty Pricing Engine B2C</h1></div>
<div class="alert-error">${msg}</div>
</div>
<script nonce="${nonce}">
  function h(){window.parent.postMessage({action:'shoptet.resize',height:document.documentElement.scrollHeight},'*');}
  addEventListener('load',h);
</script></body></html>`, { status, headers: htmlHeaders(nonce) });
}

export function renderAdminHtml(eshopId, auth) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const boot = JSON.stringify({ shopId: eshopId, session: auth?.session, mode: auth?.mode }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>L-Code Loyalty Pricing Engine B2C</title>
  <style>
    ${SHOPTET_STYLES}
  </style>
</head>
<body>
  <div class="page-card">
    <!-- Breadcrumbs -->
    <div class="breadcrumbs">
      <span>🏠</span>
      <span class="sep">&gt;</span>
      <span>Propojení</span>
      <span class="sep">&gt;</span>
      <span class="current">L-Code Loyalty Pricing Engine B2C</span>
    </div>

    <!-- Title Row -->
    <div class="title-row">
      <h1 class="page-title">L-Code Loyalty Pricing Engine B2C</h1>
      <div class="top-actions">
        <button type="button" class="btn-shoptet-green" id="btn-top-save">Uložit</button>
      </div>
    </div>

    <!-- Flash message -->
    <div id="flash" class="flash-box"></div>

    <!-- Navigation Tabs -->
    <div class="shoptet-tabs" role="tablist">
      <button type="button" class="shoptet-tab active" data-tab="tiers" role="tab">Nastavení</button>
      <button type="button" class="shoptet-tab" data-tab="rules" role="tab">Pravidla slev</button>
      <button type="button" class="shoptet-tab" data-tab="settings" role="tab">Obecné</button>
      <button type="button" class="shoptet-tab" data-tab="pricelists" role="tab">Ceníky</button>
      <button type="button" class="shoptet-tab" data-tab="categories" role="tab">Kategorie</button>
      <button type="button" class="shoptet-tab" data-tab="products" role="tab">Produkty</button>
      <button type="button" class="shoptet-tab" data-tab="brandSales" role="tab">Akce značek</button>
      <button type="button" class="shoptet-tab" data-tab="coupons" role="tab">Kupóny</button>
      <button type="button" class="shoptet-tab" data-tab="sync" role="tab">Synchronizace</button>
      <button type="button" class="shoptet-tab" data-tab="mcp" role="tab">AI asistent</button>
      <button type="button" class="shoptet-tab" data-tab="overview" role="tab">Přehled</button>
    </div>

    <div id="loading" style="padding: 24px 0; color: #777777;">Načítám nastavení…</div>

    <!-- Tab 1: Nastavení (Věrnostní úrovně a průvodce) -->
    <section class="panel active" id="panel-tiers">
      <p class="tab-intro">Vypište pečlivě níže uvedené údaje. Nastavení určuje procentuální věrnostní slevy a nákupní obrat pro automatické zařazení vašich zákazníků do ceníků.</p>

      <div class="shoptet-notice">
        <span class="notice-icon">💡</span>
        <span>Pokud má produkt v e-shopu akční cenu výhodnější než zákazníkova věrnostní sleva, zákazník nakupuje za výhodnější akční cenu. Všechny ceny se do e-shopu ukládají včetně platné sazby DPH. První načtení nemění žádné ceny v e-shopu.</span>
      </div>

      <!-- Stav obchodu -->
      <div id="onboarding-store-card" class="shoptet-notice" style="background:#fafafa;border:1px solid #dcdcdc;border-left:4px solid #4a90e2;margin-bottom:16px;">
        <span class="notice-icon">📊</span>
        <div>
          <strong style="color:#333;font-size:13px;">Aktuální stav vašeho e-shopu</strong>
          <div id="onboarding-store-summary" style="margin-top:4px;font-size:12px;color:#555;">
            Načítám data z e-shopu…
          </div>
        </div>
      </div>

      <!-- Pravidla obratu a udržení úrovně -->
      <div class="section-heading">Výpočet obratu a udržení úrovně</div>

      <div class="form-row">
        <label class="form-label">Období pro výpočet obratu</label>
        <div class="form-field">
          <select id="onboarding-period" class="input-text" style="max-width:340px;">
            <option value="7_days">Posledních 7 dní</option>
            <option value="1_month">Poslední měsíc (30 dní)</option>
            <option value="3_months" selected>Poslední 3 měsíce (90 dní)</option>
            <option value="6_months">Posledních 6 měsíců (180 dní)</option>
            <option value="12_months">Posledních 12 měsíců (365 dní)</option>
            <option value="all_time">Za celou dobu (kompletní historie)</option>
          </select>
          <span class="info-icon" title="Klouzavé období nákupů zákazníka. Vratky a stornované objednávky se automaticky odečítají.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Udržení věrnostní úrovně</label>
        <div class="form-field">
          <select id="onboarding-retention" class="input-text" style="max-width:340px;">
            <option value="permanent" selected>Úroveň zůstává natrvalo</option>
            <option value="rolling_turnover">Průběžně přepočítávat podle obratu ve zvoleném období</option>
            <option value="inactivity_drop_one">Po zvolené době bez nákupu pokles o jednu úroveň</option>
            <option value="inactivity_drop_base">Po zvolené době bez nákupu návrat na základní úroveň</option>
          </select>
          <span class="info-icon" title="Určuje, jak se úroveň chová při poklesu nákupní aktivity.">i</span>
        </div>
      </div>

      <div class="form-row" id="row-inactivity-days" style="display:none;">
        <label class="form-label">Doba neaktivity</label>
        <div class="form-field">
          <span>Při neaktivitě</span>
          <input type="number" id="onboarding-inactivity-days" class="input-text w-small" min="1" max="999" value="90" style="margin:0 6px;">
          <span>dní bez nákupu dojde ke snížení úrovně.</span>
        </div>
      </div>

      <div class="form-row" id="row-warning-days" style="display:none;">
        <label class="form-label">Upozornění před poklesem</label>
        <div class="form-field">
          <span>Upozornit</span>
          <input type="number" id="onboarding-warning-days" class="input-text w-small" min="1" max="90" value="14" style="margin:0 6px;">
          <span>dní předem, že zákazníkovi hrozí pokles úrovně.</span>
        </div>
      </div>

      <div class="section-heading">Věrnostní ceníky, slevy a zákaznické skupiny</div>

      <div class="shoptet-table-responsive">
        <table class="shoptet-table">
          <thead>
            <tr>
              <th style="width: 26%;">Název věrnostní úrovně</th>
              <th style="width: 14%;">Věrnostní sleva</th>
              <th style="width: 18%;">Požadovaný obrat</th>
              <th style="width: 19%;">Ceník v Shoptetu</th>
              <th style="width: 19%;">Zákaznická skupina</th>
              <th style="width: 4%;"></th>
            </tr>
          </thead>
          <tbody id="tiers-body"></tbody>
        </table>
      </div>

      <div style="display: flex; gap: 8px; align-items: center; margin-top: 16px; flex-wrap: wrap;">
        <button type="button" class="btn-secondary" id="tiers-add">+ Přidat další úroveň</button>
        <button type="button" class="btn-secondary" id="btn-setup-entities" style="border-color:#4a90e2;color:#2060a0;">⚡ Připravit ceníky a skupiny v Shoptetu</button>
        <button type="button" class="btn-shoptet-green" id="tiers-save-bottom">Uložit</button>
        <span style="color: #888888; font-size: 12px; margin-left: 8px;" id="tiers-version"></span>
      </div>

      <!-- Manuální návod (pokud chybí API práva na vytváření) -->
      <div id="onboarding-manual-guide-box" style="display:none;margin-top:20px;padding:16px;background:#fff8e7;border:1px solid #ffd175;border-radius:4px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong style="color:#8a6d3b;">💡 Postup pro ruční vytvoření ceníků a skupin v Shoptetu</strong>
          <button type="button" class="btn-secondary" id="btn-close-manual-guide" style="padding:2px 8px;">Zavřít</button>
        </div>
        <div id="onboarding-manual-guide-text" style="margin-top:10px;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#555;"></div>
      </div>
    </section>

    <!-- Tab 2: Pravidla slev -->
    <section class="panel" id="panel-rules">
      <p class="tab-intro">Nastavte pravidla pro kombinování slev, uplatňování slevových kupónů v nákupním košíku a slevové stropy pro vybrané značky.</p>

      <div class="section-heading">Kombinování slev a slevových kupónů</div>

      <div class="form-row">
        <label class="form-label">Výhodnější cena má přednost</label>
        <div class="form-field">
          <input type="checkbox" id="rule-highest-discount" checked style="width: 16px; height: 16px; cursor: pointer;">
          <label for="rule-highest-discount" style="cursor: pointer;">Pokud je akční cena zboží výhodnější než věrnostní sleva, platí nižší akční cena.</label>
          <span class="info-icon" title="Zákazník vždy nakupuje za nejvýhodnější nabízenou cenu.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Zákaz slevových kupónů v košíku</label>
        <div class="form-field">
          <input type="checkbox" id="rule-coupon-lock-top" checked style="width: 16px; height: 16px; cursor: pointer;">
          <label for="rule-coupon-lock-top" style="cursor: pointer;">Zakázat zadání kupónu pro zákazníky s věrnostní slevou od:</label>
          <input type="number" id="rule-coupon-min-percent" class="input-text w-small" min="1" max="100" step="1" placeholder="Všechny" style="margin: 0 4px;">
          <span class="unit">%</span>
          <span class="info-icon" title="Zákazníci se slevou od této hranice nebudou moci v košíku uplatnit kupón. Pokud necháte prázdné, zákaz platí pro všechny věrnostní úrovně.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Sčítání slevového kupónu s věrností</label>
        <div class="form-field">
          <input type="checkbox" id="rule-coupon-min-price-ratio" checked style="width: 16px; height: 16px; cursor: pointer;">
          <label for="rule-coupon-min-price-ratio" style="cursor: pointer;">U ostatních slev omezit výši kupónu tak, aby výsledná částka neklesla pod nákupní marži zboží.</label>
          <span class="info-icon" title="Hlídá minimální prodejní cenu při zadání kupónu.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label" for="rule-coupon-mode">Režim slevových kupónů</label>
        <div class="form-field">
          <select id="rule-coupon-mode" class="input-select" style="width: 320px;">
            <option value="fixed-amount">Pevná částka kupónu (dárkové a ambasadorské šeky)</option>
            <option value="percent-ceiling">Procentní kupón s celkovým stropem slevy</option>
          </select>
          <span class="info-icon" title="Určuje, jak se slevové kupóny kombinují se stropy slev a akčními cenami.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label" for="rule-coupon-ceiling-percent">Celkový strop pro procentní kupóny</label>
        <div class="form-field">
          <input type="number" id="rule-coupon-ceiling-percent" class="input-text w-small" min="1" max="100" step="0.01" placeholder="např. 20">
          <span class="unit">%</span>
          <span class="info-icon" title="Povinné při volbě procentního režimu kupónů: maximální celková kombinovaná sleva (věrnost + kupón).">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label" for="rule-cap-priority">Priorita stropů slev</label>
        <div class="form-field">
          <select id="rule-cap-priority" class="input-select" style="width: 320px;">
            <option value="hierarchy">Podle hierarchie (Produkt → Značka → Kategorie)</option>
            <option value="most_restrictive">Nejpřísnější platný strop</option>
          </select>
          <span class="info-icon" title="Stejné pořadí stropů slev se použije pro věrnostní ceny i slevové kupóny.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label" for="rule-min-margin">Ochrana minimální marže</label>
        <div class="form-field">
          <input type="number" id="rule-min-margin" class="input-text w-small" min="0" max="99.99" step="0.01" placeholder="např. 20">
          <span>% z prodejní ceny (dle nákupní ceny v Shoptetu)</span>
          <span class="info-icon" title="Věrnostní sleva ani kupón nesníží prodejní cenu pod požadovanou obchodní marži.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Okamžitá kontrola uložení cen</label>
        <div class="form-field">
          <input type="checkbox" id="rule-post-write-verify" checked style="width: 16px; height: 16px; cursor: pointer;">
          <label for="rule-post-write-verify" style="cursor: pointer;">Po každé změně cen ihned ověřit, že se nová cena v e-shopu v pořádku uložila.</label>
          <span class="info-icon" title="Automaticky zkontroluje uložení cen v Shoptetu.">i</span>
        </div>
      </div>

      <div class="section-heading">Maximální povolená sleva pro vybrané značky</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 14px;">U vybraných značek můžete nastavit pevný strop maximální slevy, který věrnostní program nikdy nepřekročí:</p>

      <div id="brand-picker" hidden style="max-width: 480px; background: #ffffff; border: 1px solid #cfcfcf; border-radius: 4px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
        <div style="font-weight: bold; margin-bottom: 8px; color: #25a9e0;">Výběr značky z katalogu e-shopu</div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="search" id="brand-picker-search" class="input-text" placeholder="Hledat značku…" autocomplete="off" style="flex: 1;">
        </div>
        <select id="brand-picker-results" aria-label="Skutečné značky obchodu" size="6" style="width: 100%; border: 1px solid #cfcfcf; border-radius: 3px; padding: 4px; font-size: 13px; outline: none; margin-bottom: 8px;"></select>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span id="brand-picker-status" role="status" style="font-size: 12px; color: #777;"></span>
          <div style="display: flex; gap: 4px;">
            <button type="button" class="btn-secondary" id="brand-picker-prev" style="padding: 2px 10px; font-size: 12px;">Předchozí</button>
            <button type="button" class="btn-secondary" id="brand-picker-next" style="padding: 2px 10px; font-size: 12px;">Další</button>
          </div>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button type="button" class="btn-secondary" id="brand-picker-close">Zavřít</button>
          <button type="button" class="btn-shoptet-green" id="brand-picker-use">Vybrat značku</button>
        </div>
      </div>
      <div id="brand-limits-container" style="display: flex; flex-direction: column; gap: 8px; max-width: 440px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-brand-limit">+ Přidat značku</button>

      <div class="section-heading">Maximální povolená sleva pro vybrané kategorie</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 14px;">U vybraných kategorií můžete nastavit strop slevy (nebo 0 % pro úplné vyloučení kategorie z věrnostních slev):</p>

      <div id="category-picker" hidden style="max-width: 480px; background: #ffffff; border: 1px solid #cfcfcf; border-radius: 4px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
        <div style="font-weight: bold; margin-bottom: 8px; color: #25a9e0;">Výběr kategorie z katalogu e-shopu</div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="search" id="category-picker-search" class="input-text" placeholder="Hledat kategorii podle názvu…" autocomplete="off" style="flex: 1;">
        </div>
        <select id="category-picker-results" aria-label="Skutečné kategorie obchodu" size="6" style="width: 100%; border: 1px solid #cfcfcf; border-radius: 3px; padding: 4px; font-size: 13px; outline: none; margin-bottom: 8px;"></select>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span id="category-picker-status" role="status" style="font-size: 12px; color: #777;"></span>
          <div style="display: flex; gap: 4px;">
            <button type="button" class="btn-secondary" id="category-picker-prev" style="padding: 2px 10px; font-size: 12px;">Předchozí</button>
            <button type="button" class="btn-secondary" id="category-picker-next" style="padding: 2px 10px; font-size: 12px;">Další</button>
          </div>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button type="button" class="btn-secondary" id="category-picker-close">Zavřít</button>
          <button type="button" class="btn-shoptet-green" id="category-picker-use">Vybrat kategorii</button>
        </div>
      </div>
      <div id="category-limits-container" style="display: flex; flex-direction: column; gap: 8px; max-width: 440px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-category-limit">+ Přidat kategorii</button>

      <div class="section-heading">Výjimky a stropy slev pro vybrané produkty</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 14px;">Zde můžete vybrané produkty úplně vyloučit z věrnostních slev (zadáním 0 %) nebo jim nastavit individuální strop:</p>

      <div id="product-picker" hidden style="max-width: 480px; background: #ffffff; border: 1px solid #cfcfcf; border-radius: 4px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
        <div style="font-weight: bold; margin-bottom: 8px; color: #25a9e0;">Výběr produktu z katalogu e-shopu</div>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="search" id="product-picker-search" class="input-text" placeholder="Hledat produkt podle názvu nebo kódu…" autocomplete="off" style="flex: 1;">
        </div>
        <select id="product-picker-results" aria-label="Skutečné produkty obchodu" size="6" style="width: 100%; border: 1px solid #cfcfcf; border-radius: 3px; padding: 4px; font-size: 13px; outline: none; margin-bottom: 8px;"></select>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <span id="product-picker-status" role="status" style="font-size: 12px; color: #777;"></span>
          <div style="display: flex; gap: 4px;">
            <button type="button" class="btn-secondary" id="product-picker-prev" style="padding: 2px 10px; font-size: 12px;">Předchozí</button>
            <button type="button" class="btn-secondary" id="product-picker-next" style="padding: 2px 10px; font-size: 12px;">Další</button>
          </div>
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button type="button" class="btn-secondary" id="product-picker-close">Zavřít</button>
          <button type="button" class="btn-shoptet-green" id="product-picker-use">Vybrat produkt</button>
        </div>
      </div>
      <div id="product-limits-container" style="display: flex; flex-direction: column; gap: 8px; max-width: 440px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-product-limit">+ Přidat produkt</button>

      <div class="section-heading">Plánované akce a výprodeje produktů (časová okna od–do)</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 14px;">Zde můžete nastavit dočasné akční slevy a výprodeje pro konkrétní produkty s přesnou dobou platnosti:</p>
      <div id="scheduled-promotions-container" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-scheduled-promo">+ Přidat výprodej produktu</button>

      <div class="section-heading">Plošné akce na značky (časová okna od–do)</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 14px;">Plošná akční sleva na celý sortiment vybrané značky s možností omezení od–do:</p>
      <div id="brand-promotions-container" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-brand-promo">+ Přidat akci na značku</button>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eeeeee; display: flex; align-items: center; gap: 8px;">
        <button type="button" class="btn-shoptet-green" id="rules-save-bottom">Uložit pravidla</button>
        <span style="color: #888888; font-size: 12px; margin-left: 8px;" id="rules-version"></span>
      </div>
    </section>

    <!-- Konfigurační sekce doplňku -->
    <section class="panel" id="panel-settings"><p class="tab-intro">Obecné nastavení doplňku.</p><div id="section-settings"></div></section>
    <section class="panel" id="panel-pricelists"><p class="tab-intro">Přiřazení ceníků k věrnostním úrovním. ID zadejte podle Shoptetu.</p><div id="section-pricelists"></div></section>
    <section class="panel" id="panel-categories"><p class="tab-intro">Maximální sleva pro jednotlivé kategorie.</p><div id="section-categories"></div></section>
    <section class="panel" id="panel-products"><p class="tab-intro">Výjimky a maximální slevy jednotlivých produktů.</p><div id="section-products"></div></section>
    <section class="panel" id="panel-brandSales"><p class="tab-intro">Samostatné akční limity značek.</p><div id="section-brandSales"></div></section>
    <section class="panel" id="panel-coupons"><p class="tab-intro">Omezení kupónů a věrnostních úrovní.</p><div id="section-coupons"></div></section>
    <section class="panel" id="panel-sync"><p class="tab-intro">Konfigurace synchronizace. Tato stránka synchronizaci nespouští.</p><div id="section-sync"></div></section>

    <!-- Tab 3: Přístup k MCP -->
    <section class="panel" id="panel-mcp">
      <p class="tab-intro">Přístup k MCP pro propojení s vaším asistentem. Umožňuje bezpečně kontrolovat a spravovat věrnostní ceny přirozenou řečí.</p>

      <div class="section-heading">Spárování s AI asistentem</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 12px;">Pokud používáte podporovaného klienta, zadejte jednorázový kód pro bezpečné spárování:</p>

      <div class="form-row">
        <label class="form-label" for="oauth-pair-code">Připojovací kód</label>
        <div class="form-field">
          <input id="oauth-pair-code" class="input-text" style="width: 320px;" placeholder="Vložte kód z okna klienta" autocomplete="off">
          <button type="button" class="btn-secondary" id="oauth-inspect">Ověřit kód</button>
          <span class="info-icon" title="Jednorázový kód vygenerovaný AI klientem pro autorizaci.">i</span>
        </div>
      </div>
      <div id="oauth-consent" class="form-offset"></div>
      <div id="oauth-connections" class="form-offset"></div>

      <div class="section-heading">Aktivní přístupové klíče pro MCP</div>

      <div class="shoptet-table-responsive">
        <table class="shoptet-table">
          <thead>
            <tr>
              <th style="width: 35%;">Otisk klíče</th>
              <th style="width: 30%;">Vytvořeno</th>
              <th style="width: 35%;">Přiřazená oprávnění</th>
            </tr>
          </thead>
          <tbody id="tokens-body"></tbody>
        </table>
      </div>

      <div class="section-heading">Vygenerovat nový přístupový klíč</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 10px;">Zvolte oprávnění, která má mít nový klíč pro asistenta:</p>

      <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; padding-left: 10px;">
        <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="permission-configure"> <span>Povolit přípravu návrhů ceníků</span></label>
        <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="permission-customers"> <span>Povolit čtení objednávek pro výpočet obratu zákazníků</span></label>
        <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="permission-audit"> <span>Povolit čtení historie změn</span></label>
        <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="permission-sync"> <span>Povolit spouštění synchronizačních úloh</span></label>
        <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="permission-execute"> <span>Povolit uložení revizí schválených v administraci</span></label>
      </div>

      <div style="display: flex; gap: 10px; align-items: center; margin: 16px 0;">
        <button type="button" class="btn-shoptet-green" id="token-new">Vygenerovat nový klíč</button>
        <button type="button" class="btn-secondary" id="token-revoke">Odvolat ruční klíče</button>
        <span style="color: #777777; font-size: 12px;">Vygenerováním se všechny dosavadní klíče automaticky zneplatní.</span>
      </div>

      <div id="token-result"></div>

      <div class="section-heading">Nastavení pro Claude Desktop</div>
      <p style="color: #666666; font-size: 13px; margin-bottom: 8px;">Vložte následující konfiguraci do vašeho souboru <code>claude_desktop_config.json</code>:</p>
      <pre style="background: #f8f9fa; border: 1px solid #d9d9d9; border-radius: 3px; padding: 12px; font-family: monospace; font-size: 12px; overflow-x: auto; line-height: 1.4;" id="mcp-snippet"></pre>
    </section>

    <!-- Tab 4: Přehled -->
    <section class="panel" id="panel-overview">
      <p class="tab-intro">Základní přehled o stavu propojení věrnostního systému s vaším e-shopem.</p>

      <div class="shoptet-notice" id="onboarding-notice">
        <span class="notice-icon">ℹ️</span>
        <div style="flex: 1; display: flex; justify-content: space-between; align-items: center;">
          <span id="onboarding-status" role="status">Načítám stav instalace…</span>
          <button type="button" class="btn-secondary" id="onboarding-retry" hidden style="margin-left: 12px;">Zopakovat ověření</button>
        </div>
      </div>

      <div class="section-heading">Stav propojení s e-shopem</div>

      <div class="form-row">
        <label class="form-label">Adresa e-shopu</label>
        <div class="form-field">
          <input type="text" class="input-text" style="width: 320px;" readonly id="ov-url" value="—">
          <span class="info-icon" title="Adresa připojeného e-shopu.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Stav</label>
        <div class="form-field">
          <span style="display: inline-flex; align-items: center; gap: 6px; font-weight: bold; color: #79b928;">
            <span style="font-size: 14px;">●</span> Schváleno a v provozu
          </span>
          <span class="info-icon" title="Doplněk je aktivní a platný.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Způsob zápisu cen</label>
        <div class="form-field">
          <span>Všechny ceny se do ceníků ukládají včetně platné sazby DPH</span>
          <span class="info-icon" title="Zajišťuje bezchybné zobrazení cen pro plátce i neplátce.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">E-mail podpory</label>
        <div class="form-field">
          <input type="text" class="input-text" style="width: 320px;" readonly id="ov-email" value="—">
          <span class="info-icon" title="Kontaktní e-mail pro dotazy.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label">Aktivní ceníky</label>
        <div class="form-field">
          <span id="ov-tiers">—</span>
          <span class="info-icon" title="Počet nakonfigurovaných věrnostních ceníků.">i</span>
        </div>
      </div>

      <div class="section-heading">Zabezpečená systémová oznámení</div>

      <div class="form-row">
        <label class="form-label">Stav oznámení</label>
        <div class="form-field">
          <span id="webhook-status" role="status" style="font-weight: 500;">Načítám stav…</span>
          <span class="info-icon" title="Zabezpečená komunikace událostí mezi Shoptetem a doplňkem.">i</span>
        </div>
      </div>

      <div class="form-row">
        <label class="form-label"></label>
        <div class="form-field" style="display: flex; flex-direction: column; align-items: flex-start; gap: 8px;">
          <label style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
            <input type="checkbox" id="webhook-confirm">
            <span>Souhlasím s vytvořením podpisového klíče bezpečných oznámení pro tuto instalaci.</span>
          </label>
          <button type="button" class="btn-secondary" id="webhook-enable">Zapnout bezpečná oznámení</button>
        </div>
      </div>

      <div id="loyalty-onboarding-container"></div>
      <div id="reconciliation-container"></div>
      <div id="approvals-container"></div>
      <div id="sync-approvals-container"></div>
      <div id="history-container"></div>
    </section>
  </div>

  <script nonce="${nonce}">
  (() => {
    const BOOT = ${boot};
    const $ = id => document.getElementById(id);
    let state = null;
    let activeTab = 'tiers';

    function resize() {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      window.parent.postMessage({ action: 'shoptet.resize', height: h + 20 }, '*');
    }
    addEventListener('load', resize);
    addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

    function flash(msg, isError = false) {
      const box = $('flash');
      box.textContent = '';
      if (!msg) return;
      const el = document.createElement('div');
      el.className = isError ? 'alert-error' : 'alert-success';
      el.textContent = msg;
      box.append(el);
      if (!isError) setTimeout(() => { if (box.firstChild === el) box.textContent = ''; }, 5000);
      resize();
    }

    async function api(path, opts = {}) {
      const res = await fetch('/admin/settings/api' + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + BOOT.session, 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 401) throw new Error('Platnost přihlášení vypršela. Obnovte administraci.');
      if (!res.ok) throw new Error(data.error || ('Chyba serveru (' + res.status + ').'));
      return data;
    }

    /* Tabs */
    document.querySelectorAll('.shoptet-tab').forEach(btn => btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.shoptet-tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + activeTab));
      resize();
    }));

    /* Overview */
    function renderOverview() {
      const i = state.installation || {};
      const onboarding=$('onboarding-status');onboarding.textContent=i.state==='active'?'Instalace ověřena.':i.state==='pending'?'Probíhá ověření instalace. AI přístup se povolí až po ověření obchodu.':'Instalace není aktivní.';
      if(state.verification?.error_code)onboarding.textContent+=' Chyba: '+state.verification.error_code;
      $('onboarding-retry').hidden=i.state!=='pending';$('token-new').disabled=i.state!=='active';
      if(i.state==='pending'&&state.verification?.state!=='failed'){clearTimeout(window.onboardingTimer);window.onboardingTimer=setTimeout(async()=>{try{state=await api('/state');renderOverview();}catch{}},5000);}

      $('ov-url').value = i.eshop_url || 'https://' + BOOT.shopId + '.myshoptet.com/';
      $('ov-email').value = i.contact_email || '';
      $('ov-tiers').textContent = state.tiers.length ? state.tiers.length + ' uložených návrhů úrovní' : 'Zatím nenastaveny';
    }

    /* Tiers table */
    function tierRow(t = { name: '', percent: '', minTurnover: '', pricelistId: null, customerGroupId: null }) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" class="input-text w-full tier-name" placeholder="Název úrovně"></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-small tier-percent" min="0.01" max="100" step="0.01"><span class="unit">%</span></div></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-med tier-turnover" min="0" step="1"><span class="unit tier-currency"></span></div></td>' +
        '<td><select class="input-select tier-pricelist" style="width: 100%;"><option value="">— Bez ceníku —</option></select></td>' +
        '<td><select class="input-select tier-group" style="width: 100%;"><option value="">— Bez skupiny —</option></select></td>' +
        '<td><button type="button" class="btn-remove tier-remove" title="Smazat úroveň">×</button></td>';
      tr.querySelector('.tier-name').value = t.name || '';
      tr.querySelector('.tier-percent').value = t.percent ?? '';
      tr.querySelector('.tier-turnover').value = t.minTurnover ?? '';
      tr.querySelector('.tier-currency').textContent = state.currency || 'měna obchodu';
      const plSelect = tr.querySelector('.tier-pricelist');
      (state.pricelists || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.currency ? ' (' + p.currency + ')' : '');
        if (t.pricelistId && String(p.id) === String(t.pricelistId)) opt.selected = true;
        plSelect.append(opt);
      });
      const grpSelect = tr.querySelector('.tier-group');
      (state.customerGroups || []).forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        if (t.customerGroupId && String(g.id) === String(t.customerGroupId)) opt.selected = true;
        grpSelect.append(opt);
      });
      tr.querySelector('.tier-remove').addEventListener('click', () => { tr.remove(); resize(); });
      return tr;
    }

    function updateRetentionFormVisibility() {
      const pol = $('onboarding-retention')?.value;
      const showInactivity = pol === 'inactivity_drop_one' || pol === 'inactivity_drop_base';
      if ($('row-inactivity-days')) $('row-inactivity-days').style.display = showInactivity ? 'flex' : 'none';
      if ($('row-warning-days')) $('row-warning-days').style.display = showInactivity ? 'flex' : 'none';
      resize();
    }
    if ($('onboarding-retention')) {
      $('onboarding-retention').addEventListener('change', updateRetentionFormVisibility);
    }

    function renderTiers() {
      const b = $('tiers-body');
      b.textContent = '';
      state.tiers.forEach(t => b.append(tierRow(t)));
      $('tiers-version').textContent = state.version ? 'Uloženo (verze: ' + state.version + ')' : '';

      if (state.onboarding) {
        if ($('onboarding-period') && state.onboarding.period) $('onboarding-period').value = state.onboarding.period;
        if ($('onboarding-retention') && state.onboarding.retentionPolicy) $('onboarding-retention').value = state.onboarding.retentionPolicy;
        if ($('onboarding-inactivity-days') && state.onboarding.inactivityDays) $('onboarding-inactivity-days').value = state.onboarding.inactivityDays;
        if ($('onboarding-warning-days') && state.onboarding.warningDays) $('onboarding-warning-days').value = state.onboarding.warningDays;
      }
      updateRetentionFormVisibility();
    }

    function getTiersFormData() {
      const rows = [...$('tiers-body').querySelectorAll('tr')];
      return rows.map(r => {
        const pl = r.querySelector('.tier-pricelist').value;
        const grp = r.querySelector('.tier-group').value;
        return {
          name: r.querySelector('.tier-name').value,
          percent: r.querySelector('.tier-percent').value === '' ? NaN : Number(r.querySelector('.tier-percent').value),
          minTurnover: r.querySelector('.tier-turnover').value === '' ? NaN : Number(r.querySelector('.tier-turnover').value),
          ...(pl ? { pricelistId: Number(pl) } : {}),
          ...(grp ? { customerGroupId: Number(grp) } : {})
        };
      });
    }

    async function saveTiers() {
      const tiers = getTiersFormData();
      const period = $('onboarding-period')?.value || '3_months';
      const retentionPolicy = $('onboarding-retention')?.value || 'permanent';
      const inactivityDays = Number($('onboarding-inactivity-days')?.value || 90);
      const warningDays = Number($('onboarding-warning-days')?.value || 14);
      const onboarding = { period, retentionPolicy, inactivityDays, warningDays };

      const btn = $('btn-top-save');
      btn.disabled = true;
      try {
        const res = await api('/tiers', { method: 'PUT', body: JSON.stringify({ tiers, onboarding, version: state.version }) });
        state.tiers = res.tiers; state.version = res.version;
        state.onboarding = onboarding;
        renderTiers(); renderOverview();
        flash('Věrnostní úrovně byly úspěšně uloženy.');
      } catch (e) { flash(e.message, true); }
      finally { btn.disabled = false; resize(); }
    }

    if ($('btn-setup-entities')) {
      $('btn-setup-entities').addEventListener('click', async () => {
        const tiers = getTiersFormData();
        if (!tiers.length) return flash('Nejdříve přidejte alespoň jednu věrnostní úroveň.', true);
        const period = $('onboarding-period')?.value || '3_months';
        const retentionPolicy = $('onboarding-retention')?.value || 'permanent';
        const inactivityDays = Number($('onboarding-inactivity-days')?.value || 90);
        const warningDays = Number($('onboarding-warning-days')?.value || 14);

        const btn = $('btn-setup-entities');
        btn.disabled = true;
        btn.textContent = 'Připravuji ceníky a skupiny…';
        try {
          const res = await api('/onboarding/setup-entities', {
            method: 'POST',
            body: JSON.stringify({ period, retentionPolicy, inactivityDays, warningDays, tiers, autoCreate: true })
          });

          if (res.status === 'READY') {
            state.tiers = res.entities;
            state.onboarding = { period, retentionPolicy, inactivityDays, warningDays };
            renderTiers();
            flash('Ceníky a skupiny pro všechny úrovně jsou v Shoptetu připraveny a propojeny.');
            if ($('onboarding-manual-guide-box')) $('onboarding-manual-guide-box').style.display = 'none';
          } else if (res.status === 'MANUAL_SETUP_REQUIRED') {
            if ($('onboarding-manual-guide-box')) {
              $('onboarding-manual-guide-box').style.display = 'block';
              $('onboarding-manual-guide-text').textContent = res.manualInstructions || '';
            }
            flash('Aplikace nemá v Shoptetu oprávnění pro automatické zakládání. Níže naleznete jednoduchý návod.', true);
          }
        } catch (e) {
          flash(e.message || 'Nepodařilo se připravit ceníky.', true);
        } finally {
          btn.disabled = false;
          btn.textContent = '⚡ Připravit ceníky a skupiny v Shoptetu';
          resize();
        }
      });
    }

    if ($('btn-close-manual-guide')) {
      $('btn-close-manual-guide').addEventListener('click', () => {
        if ($('onboarding-manual-guide-box')) $('onboarding-manual-guide-box').style.display = 'none';
        resize();
      });
    }

    function renderStoreSummary(ov) {
      if (!ov || !$('onboarding-store-summary')) return;
      $('onboarding-store-summary').innerHTML =
        'V e-shopu nalezeno <strong>' + (ov.productsCount || 0) + ' produktů</strong>, <strong>' +
        (ov.categoriesCount || 0) + ' kategorií</strong>, <strong>' + (ov.customersCount || 0) + ' zákazníků</strong>, <strong>' +
        (ov.pricelists ? ov.pricelists.length : 0) + ' ceníků</strong> a <strong>' + (ov.customerGroups ? ov.customerGroups.length : 0) + ' zákaznických skupin</strong>. Měna: ' + (ov.currency || 'CZK') + '.';
    }

    $('tiers-save-bottom').addEventListener('click', saveTiers);

    /* Rules */
    const brandNames=new Map();let brandTarget=null,brandPage=1,brandPages=1;
    async function loadBrandPicker(){
      const list=$('brand-picker-results');list.textContent='';$('brand-picker-status').textContent='Načítám značky…';
      try{const data=await api('/catalog/brands?page='+brandPage+'&query='+encodeURIComponent($('brand-picker-search').value.trim()));brandPages=data.pagination?.pageCount||brandPage;
        for(const brand of data.items){brandNames.set(brand.guid,brand.name);const option=document.createElement('option');option.value=brand.guid;option.textContent=brand.name;list.append(option);}
        $('brand-picker-status').textContent=data.items.length?'Stránka '+brandPage+' z '+brandPages:'Na této stránce nejsou odpovídající značky. Projděte další stránku.';
        $('brand-picker-next').disabled=brandPage>=brandPages;$('brand-picker-prev').disabled=brandPage<=1;
      }catch{$('brand-picker-status').textContent='Katalog značek není dostupný. Ověřte připojení a oprávnění.';}
      resize();
    }
    function showBrandPicker(row){brandTarget=row;$('brand-picker').hidden=false;brandPage=1;$('brand-picker-search').value='';loadBrandPicker();$('brand-picker-search').focus();}
    function addBrandLimitRow(id='',limit=0){
      const row=document.createElement('div');row.style.cssText='display:flex;gap:8px;align-items:center;max-width:440px';
      const value=document.createElement('input');value.type='hidden';value.className='bl-name';value.value=id;
      const choose=document.createElement('button');choose.type='button';choose.className='btn-secondary bl-label';choose.style.cssText='flex:1;min-width:0;overflow-wrap:anywhere';choose.textContent=id?'Ověřuji značku…':'Vybrat značku';choose.addEventListener('click',()=>showBrandPicker(row));
      const percent=document.createElement('input');percent.type='number';percent.min='0';percent.max='100';percent.step='0.01';percent.className='input-text bl-limit w-small';percent.value=limit;percent.setAttribute('aria-label','Maximální sleva v procentech');
      const unit=document.createElement('span');unit.textContent='%';const remove=document.createElement('button');remove.type='button';remove.className='btn-remove';remove.textContent='×';remove.setAttribute('aria-label','Odebrat značku');remove.addEventListener('click',()=>row.remove());row.append(value,choose,percent,unit,remove);$('brand-limits-container').append(row);
      if(id){if(!/^[a-f0-9-]{36}$/i.test(id)){choose.textContent='Chybí platný odkaz: '+id;row.dataset.invalid='true';}else api('/catalog/brand?id='+encodeURIComponent(id)).then(brand=>{if(value.value!==id)return;brandNames.set(brand.guid,brand.name);choose.textContent=brand.name;row.dataset.invalid='false';}).catch(()=>{if(value.value!==id)return;choose.textContent='Nedostupná značka: '+id;row.dataset.invalid='true';});}
      resize();return row;
    }
    $('brand-picker-search').addEventListener('input',()=>{clearTimeout(window.brandSearchTimer);window.brandSearchTimer=setTimeout(()=>{brandPage=1;loadBrandPicker();},250);});
    $('brand-picker-next').addEventListener('click',()=>{brandPage++;loadBrandPicker();});$('brand-picker-prev').addEventListener('click',()=>{brandPage=Math.max(1,brandPage-1);loadBrandPicker();});
    $('brand-picker-use').addEventListener('click',()=>{const id=$('brand-picker-results').value;if(!id||!brandTarget)return;if([...document.querySelectorAll('.bl-name')].some(input=>input!==brandTarget.querySelector('.bl-name')&&input.value===id)){flash('Tato značka už je vybraná.',true);return;}brandTarget.querySelector('.bl-name').value=id;brandTarget.querySelector('.bl-label').textContent=brandNames.get(id)||id;brandTarget.dataset.invalid='false';$('brand-picker').hidden=true;});
    $('brand-picker-close').addEventListener('click',()=>{$('brand-picker').hidden=true;});

    const categoryNames=new Map();let categoryTarget=null,categoryPage=1,categoryPages=1;
    async function loadCategoryPicker(){
      const list=$('category-picker-results');list.textContent='';$('category-picker-status').textContent='Načítám kategorie…';
      try{const data=await api('/catalog/categories?page='+categoryPage+'&query='+encodeURIComponent($('category-picker-search').value.trim()));categoryPages=data.pagination?.pageCount||categoryPage;
        for(const cat of data.items){categoryNames.set(cat.guid,cat.name);const option=document.createElement('option');option.value=cat.guid;option.textContent=cat.name;list.append(option);}
        $('category-picker-status').textContent=data.items.length?'Stránka '+categoryPage+' z '+categoryPages:'Na této stránce nejsou odpovídající kategorie. Projděte další stránku.';
        $('category-picker-next').disabled=categoryPage>=categoryPages;$('category-picker-prev').disabled=categoryPage<=1;
      }catch{$('category-picker-status').textContent='Katalog kategorií není dostupný. Ověřte připojení a oprávnění.';}
      resize();
    }
    function showCategoryPicker(row){categoryTarget=row;$('category-picker').hidden=false;categoryPage=1;$('category-picker-search').value='';loadCategoryPicker();$('category-picker-search').focus();}
    function addCategoryLimitRow(id='',limit=0){
      const row=document.createElement('div');row.style.cssText='display:flex;gap:8px;align-items:center;max-width:440px';
      const value=document.createElement('input');value.type='hidden';value.className='cl-name';value.value=id;
      const choose=document.createElement('button');choose.type='button';choose.className='btn-secondary cl-label';choose.style.cssText='flex:1;min-width:0;overflow-wrap:anywhere';choose.textContent=id?'Ověřuji kategorii…':'Vybrat kategorii';choose.addEventListener('click',()=>showCategoryPicker(row));
      const percent=document.createElement('input');percent.type='number';percent.min='0';percent.max='100';percent.step='0.01';percent.className='input-text cl-limit w-small';percent.value=limit;percent.setAttribute('aria-label','Maximální sleva kategorie');
      const unit=document.createElement('span');unit.textContent='%';const remove=document.createElement('button');remove.type='button';remove.className='btn-remove';remove.textContent='×';remove.setAttribute('aria-label','Odebrat kategorii');remove.addEventListener('click',()=>row.remove());row.append(value,choose,percent,unit,remove);$('category-limits-container').append(row);
      if(id){if(!/^[a-f0-9-]{36}$/i.test(id)){choose.textContent='Chybí platný odkaz: '+id;row.dataset.invalid='true';}else api('/catalog/category?id='+encodeURIComponent(id)).then(cat=>{if(value.value!==id)return;categoryNames.set(cat.guid,cat.name);choose.textContent=cat.name+(limit===0?' (0 % - vyloučeno)':'');row.dataset.invalid='false';}).catch(()=>{if(value.value!==id)return;choose.textContent='Nedostupná kategorie: '+id;row.dataset.invalid='true';});}
      resize();return row;
    }
    $('category-picker-search').addEventListener('input',()=>{clearTimeout(window.categorySearchTimer);window.categorySearchTimer=setTimeout(()=>{categoryPage=1;loadCategoryPicker();},250);});
    $('category-picker-next').addEventListener('click',()=>{categoryPage++;loadCategoryPicker();});$('category-picker-prev').addEventListener('click',()=>{categoryPage=Math.max(1,categoryPage-1);loadCategoryPicker();});
    $('category-picker-use').addEventListener('click',()=>{const id=$('category-picker-results').value;if(!id||!categoryTarget)return;if([...document.querySelectorAll('.cl-name')].some(input=>input!==categoryTarget.querySelector('.cl-name')&&input.value===id)){flash('Tato kategorie už je vybraná.',true);return;}categoryTarget.querySelector('.cl-name').value=id;categoryTarget.querySelector('.cl-label').textContent=categoryNames.get(id)||id;categoryTarget.dataset.invalid='false';$('category-picker').hidden=true;});
    $('category-picker-close').addEventListener('click',()=>{$('category-picker').hidden=true;});

    const productNames=new Map();let productTarget=null,productPage=1,productPages=1;
    async function loadProductPicker(){
      const list=$('product-picker-results');list.textContent='';$('product-picker-status').textContent='Načítám produkty…';
      try{const data=await api('/catalog/products?page='+productPage+'&query='+encodeURIComponent($('product-picker-search').value.trim()));productPages=data.pagination?.pageCount||productPage;
        for(const prod of data.items){productNames.set(prod.guid,prod.name||prod.code);const option=document.createElement('option');option.value=prod.guid;option.textContent=(prod.name||'Bez názvu')+' ('+prod.code+')';list.append(option);}
        $('product-picker-status').textContent=data.items.length?'Stránka '+productPage+' z '+productPages:'Na této stránce nejsou odpovídající produkty. Projděte další stránku.';
        $('product-picker-next').disabled=productPage>=productPages;$('product-picker-prev').disabled=productPage<=1;
      }catch{$('product-picker-status').textContent='Katalog produktů není dostupný. Ověřte připojení a oprávnění.';}
      resize();
    }
    function showProductPicker(row){productTarget=row;$('product-picker').hidden=false;productPage=1;$('product-picker-search').value='';loadProductPicker();$('product-picker-search').focus();}
    function addProductLimitRow(id='',limit=0){
      const row=document.createElement('div');row.style.cssText='display:flex;gap:8px;align-items:center;max-width:440px';
      const value=document.createElement('input');value.type='hidden';value.className='pl-name';value.value=id;
      const choose=document.createElement('button');choose.type='button';choose.className='btn-secondary pl-label';choose.style.cssText='flex:1;min-width:0;overflow-wrap:anywhere';choose.textContent=id?'Ověřuji produkt…':'Vybrat produkt';choose.addEventListener('click',()=>showProductPicker(row));
      const percent=document.createElement('input');percent.type='number';percent.min='0';percent.max='100';percent.step='0.01';percent.className='input-text pl-limit w-small';percent.value=limit;percent.setAttribute('aria-label','Maximální sleva produktu');
      const unit=document.createElement('span');unit.textContent='%';const remove=document.createElement('button');remove.type='button';remove.className='btn-remove';remove.textContent='×';remove.setAttribute('aria-label','Odebrat produkt');remove.addEventListener('click',()=>row.remove());row.append(value,choose,percent,unit,remove);$('product-limits-container').append(row);
      if(id){if(!/^[a-f0-9-]{36}$/i.test(id)){choose.textContent='Chybí platný odkaz: '+id;row.dataset.invalid='true';}else api('/catalog/product?id='+encodeURIComponent(id)).then(prod=>{if(value.value!==id)return;productNames.set(prod.guid,prod.name||prod.code);choose.textContent=(prod.name||prod.code)+(limit===0?' (0 % - vyloučeno)':'');row.dataset.invalid='false';}).catch(()=>{if(value.value!==id)return;choose.textContent='Nedostupný produkt: '+id;row.dataset.invalid='true';});}
      resize();return row;
    }

    function addScheduledPromoRow(promo = {}) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:4px;';
      const codeInput = document.createElement('input');
      codeInput.type = 'text'; codeInput.className = 'input-text sp-code'; codeInput.style.width = '140px'; codeInput.placeholder = 'Kód produktu'; codeInput.value = promo.code || '';
      const pctInput = document.createElement('input');
      pctInput.type = 'number'; pctInput.min = '0.01'; pctInput.max = '99.99'; pctInput.step = '0.01'; pctInput.className = 'input-text sp-pct w-small'; pctInput.value = promo.discountPercent !== undefined ? promo.discountPercent : 20;
      const pctLabel = document.createElement('span'); pctLabel.textContent = '%';
      const fromLabel = document.createElement('span'); fromLabel.style.fontSize = '12px'; fromLabel.textContent = 'Od:';
      const fromInput = document.createElement('input'); fromInput.type = 'date'; fromInput.className = 'input-text sp-from'; fromInput.value = promo.validFrom || '';
      const toLabel = document.createElement('span'); toLabel.style.fontSize = '12px'; toLabel.textContent = 'Do:';
      const toInput = document.createElement('input'); toInput.type = 'date'; toInput.className = 'input-text sp-to'; toInput.value = promo.validTo || '';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Odebrat položku výprodeje');
      remove.addEventListener('click', () => row.remove());
      row.append(codeInput, pctInput, pctLabel, fromLabel, fromInput, toLabel, toInput, remove);
      $('scheduled-promotions-container').append(row);
      resize();
      return row;
    }

    function addBrandPromoRow(promo = {}) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px;background:#f9f9f9;border:1px solid #e5e5e5;border-radius:4px;';
      const brandInput = document.createElement('input');
      brandInput.type = 'text'; brandInput.className = 'input-text bp-brand'; brandInput.style.width = '160px'; brandInput.placeholder = 'Název značky'; brandInput.value = promo.brand || '';
      const pctInput = document.createElement('input');
      pctInput.type = 'number'; pctInput.min = '0.01'; pctInput.max = '99.99'; pctInput.step = '0.01'; pctInput.className = 'input-text bp-pct w-small'; pctInput.value = promo.discountPercent !== undefined ? promo.discountPercent : 15;
      const pctLabel = document.createElement('span'); pctLabel.textContent = '%';
      const fromLabel = document.createElement('span'); fromLabel.style.fontSize = '12px'; fromLabel.textContent = 'Od:';
      const fromInput = document.createElement('input'); fromInput.type = 'date'; fromInput.className = 'input-text bp-from'; fromInput.value = promo.validFrom || '';
      const toLabel = document.createElement('span'); toLabel.style.fontSize = '12px'; toLabel.textContent = 'Do:';
      const toInput = document.createElement('input'); toInput.type = 'date'; toInput.className = 'input-text bp-to'; toInput.value = promo.validTo || '';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'btn-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Odebrat akci na značku');
      remove.addEventListener('click', () => row.remove());
      row.append(brandInput, pctInput, pctLabel, fromLabel, fromInput, toLabel, toInput, remove);
      $('brand-promotions-container').append(row);
      resize();
      return row;
    }
    $('product-picker-search').addEventListener('input',()=>{clearTimeout(window.productSearchTimer);window.productSearchTimer=setTimeout(()=>{productPage=1;loadProductPicker();},250);});
    $('product-picker-next').addEventListener('click',()=>{productPage++;loadProductPicker();});$('product-picker-prev').addEventListener('click',()=>{productPage=Math.max(1,productPage-1);loadProductPicker();});
    $('product-picker-use').addEventListener('click',()=>{const id=$('product-picker-results').value;if(!id||!productTarget)return;if([...document.querySelectorAll('.pl-name')].some(input=>input!==productTarget.querySelector('.pl-name')&&input.value===id)){flash('Tento produkt už je vybraný.',true);return;}productTarget.querySelector('.pl-name').value=id;productTarget.querySelector('.pl-label').textContent=productNames.get(id)||id;productTarget.dataset.invalid='false';$('product-picker').hidden=true;});
    $('product-picker-close').addEventListener('click',()=>{$('product-picker').hidden=true;});

    function renderRules() {
      const r = state.rules || {};
      $('rule-highest-discount').checked = r.highestDiscountWins !== false;
      $('rule-coupon-lock-top').checked = r.couponLockTopTiers !== false;
      $('rule-coupon-min-percent').value = (r.couponLockMinPercent !== undefined && r.couponLockMinPercent !== null) ? r.couponLockMinPercent : '';
      $('rule-coupon-min-percent').disabled = !$('rule-coupon-lock-top').checked;
      $('rule-coupon-min-price-ratio').checked = r.couponLockMaxRemaining !== false;
      if ($('rule-coupon-mode')) $('rule-coupon-mode').value = r.couponMode || 'fixed-amount';
      if ($('rule-coupon-ceiling-percent')) $('rule-coupon-ceiling-percent').value = (r.couponCeilingPercent !== undefined && r.couponCeilingPercent !== null) ? r.couponCeilingPercent : '';
      if ($('rule-cap-priority')) $('rule-cap-priority').value = r.capPriority || 'hierarchy';
      if ($('rule-min-margin')) $('rule-min-margin').value = (r.minMarginPercent !== undefined && r.minMarginPercent !== null) ? r.minMarginPercent : '';
      $('rule-post-write-verify').checked = r.postWriteVerify !== false;

      const c = $('brand-limits-container');
      c.textContent = '';
      const limits = r.brandLimits || {};
      Object.entries(limits).forEach(([k, v]) => addBrandLimitRow(k, v));

      const cc = $('category-limits-container');
      cc.textContent = '';
      const cLimits = r.categoryLimits || {};
      Object.entries(cLimits).forEach(([k, v]) => addCategoryLimitRow(k, v));

      const pc = $('product-limits-container');
      pc.textContent = '';
      const pLimits = r.productLimits || {};
      Object.entries(pLimits).forEach(([k, v]) => addProductLimitRow(k, v));

      const spc = $('scheduled-promotions-container');
      spc.textContent = '';
      const sPromos = r.scheduledPromotions || [];
      sPromos.forEach(p => addScheduledPromoRow(p));

      const bpc = $('brand-promotions-container');
      bpc.textContent = '';
      const bPromos = r.brandPromotions || [];
      bPromos.forEach(p => addBrandPromoRow(p));

      $('rules-version').textContent = state.version ? 'Uloženo (verze: ' + state.version + ')' : '';
    }

    $('rule-coupon-lock-top').addEventListener('change', () => {
      $('rule-coupon-min-percent').disabled = !$('rule-coupon-lock-top').checked;
    });

    $('btn-add-brand-limit').addEventListener('click', () => showBrandPicker(addBrandLimitRow()));
    $('btn-add-category-limit').addEventListener('click', () => showCategoryPicker(addCategoryLimitRow()));
    $('btn-add-product-limit').addEventListener('click', () => showProductPicker(addProductLimitRow()));
    $('btn-add-scheduled-promo').addEventListener('click', () => addScheduledPromoRow());
    $('btn-add-brand-promo').addEventListener('click', () => addBrandPromoRow());

    async function saveRules() {
      if(document.querySelector('#brand-limits-container [data-invalid="true"]')){flash('Nejdřív opravte nedostupné odkazy značek.',true);return;}
      if(document.querySelector('#category-limits-container [data-invalid="true"]')){flash('Nejdřív opravte nedostupné odkazy kategorií.',true);return;}
      if(document.querySelector('#product-limits-container [data-invalid="true"]')){flash('Nejdřív opravte nedostupné odkazy produktů.',true);return;}
      const brandLimits = {};
      document.querySelectorAll('#brand-limits-container > div').forEach(row => {
        const name = row.querySelector('.bl-name').value.trim();
        const val = Number(row.querySelector('.bl-limit').value);
        if (name && Number.isFinite(val)) brandLimits[name] = val;
      });
      const categoryLimits = {};
      document.querySelectorAll('#category-limits-container > div').forEach(row => {
        const name = row.querySelector('.cl-name').value.trim();
        const val = Number(row.querySelector('.cl-limit').value);
        if (name && Number.isFinite(val)) categoryLimits[name] = val;
      });
      const productLimits = {};
      document.querySelectorAll('#product-limits-container > div').forEach(row => {
        const name = row.querySelector('.pl-name').value.trim();
        const val = Number(row.querySelector('.pl-limit').value);
        if (name && Number.isFinite(val)) productLimits[name] = val;
      });

      const scheduledPromotions = [];
      document.querySelectorAll('#scheduled-promotions-container > div').forEach(row => {
        const code = row.querySelector('.sp-code').value.trim();
        const pct = Number(row.querySelector('.sp-pct').value);
        const validFrom = row.querySelector('.sp-from').value.trim() || undefined;
        const validTo = row.querySelector('.sp-to').value.trim() || undefined;
        if (code && Number.isFinite(pct)) {
          const item = { code, discountPercent: pct };
          if (validFrom) item.validFrom = validFrom;
          if (validTo) item.validTo = validTo;
          scheduledPromotions.push(item);
        }
      });

      const brandPromotions = [];
      document.querySelectorAll('#brand-promotions-container > div').forEach(row => {
        const brand = row.querySelector('.bp-brand').value.trim();
        const pct = Number(row.querySelector('.bp-pct').value);
        const validFrom = row.querySelector('.bp-from').value.trim() || undefined;
        const validTo = row.querySelector('.bp-to').value.trim() || undefined;
        if (brand && Number.isFinite(pct)) {
          const item = { brand, discountPercent: pct };
          if (validFrom) item.validFrom = validFrom;
          if (validTo) item.validTo = validTo;
          brandPromotions.push(item);
        }
      });

      const minP = $('rule-coupon-min-percent').value.trim();
      const couponCeilingRaw = $('rule-coupon-ceiling-percent') ? $('rule-coupon-ceiling-percent').value.trim() : '';
      const minMarginRaw = $('rule-min-margin') ? $('rule-min-margin').value.trim() : '';
      const rules = {
        highestDiscountWins: $('rule-highest-discount').checked,
        couponLockTopTiers: $('rule-coupon-lock-top').checked,
        couponLockMinPercent: $('rule-coupon-lock-top').checked && minP !== '' ? Number(minP) : null,
        couponLockMaxRemaining: $('rule-coupon-min-price-ratio').checked,
        couponMode: $('rule-coupon-mode') ? $('rule-coupon-mode').value : 'fixed-amount',
        couponCeilingPercent: couponCeilingRaw !== '' ? Number(couponCeilingRaw) : null,
        capPriority: $('rule-cap-priority') ? $('rule-cap-priority').value : 'hierarchy',
        minMarginPercent: minMarginRaw !== '' ? Number(minMarginRaw) : null,
        postWriteVerify: $('rule-post-write-verify').checked,
        brandLimits,
        categoryLimits,
        productLimits,
        scheduledPromotions,
        brandPromotions
      };
      const btn = $('btn-top-save');
      btn.disabled = true;
      try {
        const res = await api('/rules', { method: 'PUT', body: JSON.stringify({ rules, version: state.version }) });
        state.rules = res.rules; state.version = res.version;
        renderRules(); renderOverview();
        flash('Pravidla slev, stropy značek, kategorií a výjimky produktů byly úspěšně uloženy.');
      } catch (e) { flash(e.message, true); }
      finally { btn.disabled = false; resize(); }
    }

    $('rules-save-bottom').addEventListener('click', saveRules);

    /* Top Save Button saves active tab */
    $('btn-top-save').addEventListener('click', () => {
      if (activeTab === 'rules') {
        saveRules();
      } else if (activeTab === 'tiers') {
        saveTiers();
      } else if (sectionKeys.includes(activeTab)) {
        saveSection(activeTab);
      }
    });

    /* MCP */
    function fmtDate(s) {
      if (!s) return '—';
      const d = new Date(String(s).replace(' ', 'T') + 'Z');
      return isNaN(d) ? s : d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function snippet(token) {
      return JSON.stringify({ mcpServers: { 'shoptet-pricing': { command: 'npx', args: ['-y', 'mcp-remote', state.mcpEndpoint, '--header', 'Authorization: Bearer ' + (token || '<VÁŠ_TOKEN>')] } } }, null, 2);
    }

    function renderTokens() {
      const b = $('tokens-body');
      b.textContent = '';
      if (!state.mcpTokens.length) {
        b.innerHTML = '<tr><td colspan="3" style="color:#777777;padding:12px;">Zatím nemáte vygenerovaný žádný klíč pro MCP. Klikněte níže na vygenerování.</td></tr>';
      } else {
        state.mcpTokens.forEach(t => {
          const tr = document.createElement('tr');
          const scopes = (t.scopes || []).map(s => '<span style="background:#e9ecef;color:#495057;padding:2px 6px;border-radius:3px;font-size:11px;margin-right:4px;font-family:monospace;">' + s + '</span>').join('');
          tr.innerHTML = '<td><code>lcode_mcp_… (' + t.fingerprint + ')</code></td>' +
            '<td>' + fmtDate(t.createdAt) + '</td>' +
            '<td>' + scopes + '</td>';
          b.append(tr);
        });
      }
      $('mcp-snippet').textContent = snippet(null);
    }

    $('token-revoke').addEventListener('click',async()=>{try{await api('/mcp-token',{method:'DELETE'});state.mcpTokens=[];renderTokens();$('token-result').textContent='Ruční přístupové klíče byly odvolány.';}catch(e){flash(e.message,true);}});

    $('token-new').addEventListener('click', async () => {
      if (state.mcpTokens.length && !confirm('Vygenerovat nový klíč pro MCP? Všechny dosavadní klíče přestanou fungovat.')) return;
      const btn = $('token-new'); btn.disabled = true;
      try {
        const permissions=[];if($('permission-customers').checked)permissions.push('customers:read');if($('permission-audit').checked)permissions.push('audit:read');if($('permission-sync').checked)permissions.push('sync:execute');if($('permission-configure').checked)permissions.push('pricing:configure');if($('permission-execute').checked)permissions.push('pricing:execute');
        const res = await api('/mcp-token', { method: 'POST', body: JSON.stringify({permissions}) });
        const fresh = await api('/state');
        state = fresh; renderTokens(); renderOverview();
        const box = $('token-result');
        box.innerHTML = '<div class="alert-success" style="margin: 14px 0;">' +
          '<strong>Nový přístupový klíč pro MCP byl vygenerován:</strong>' +
          '<div style="display:flex;gap:8px;margin-top:8px;">' +
          '<input type="text" readonly class="input-text" style="flex:1;font-family:monospace;" value="' + res.token + '" id="new-token-val">' +
          '<button type="button" class="btn-shoptet-green" id="btn-copy-token">Zkopírovat</button>' +
          '</div></div>';
        $('btn-copy-token').addEventListener('click', () => {
          const inp = $('new-token-val'); inp.select();
          navigator.clipboard?.writeText(res.token);
          flash('Klíč byl zkopírován do schránky.');
        });
        $('mcp-snippet').textContent = snippet(res.token);
      } catch (e) { flash(e.message, true); }
      finally { btn.disabled = false; resize(); }
    });

    /* Validated configuration sections: edit in existing Shoptet iframe, save to D1. */
    const sectionKeys = ['settings', 'pricelists', 'categories', 'products', 'brandSales', 'coupons', 'sync'];
    const sectionRows = { pricelists: ['id','name','tierName'], categories: ['id','name','limit'], products: ['id','name','limit'], brandSales: ['id','name','limit'] };
    const el = (tag, attrs = {}, value = '') => {
      const n = document.createElement(tag);
      for (const [key, val] of Object.entries(attrs)) n.setAttribute(key, val);
      if (tag === 'input' && attrs.type !== 'checkbox') n.value = String(value ?? '');
      if (tag === 'input' && attrs.type === 'checkbox') n.checked = !!value;
      return n;
    };
    function sectionInput(parent, key, value, type = 'text') {
      const row = el('div', { class: 'form-row' });
      const label = el('label', { class: 'form-label' }); label.textContent = key;
      const field = el('div', { class: 'form-field' });
      const input = el('input', { class: 'input-text', type, 'data-field': key }, value);
      if (type === 'number') { input.step = '0.01'; input.min = '0'; }
      field.append(input); row.append(label, field); parent.append(row);
      return input;
    }
    function renderSection(key) {
      const root = $('section-' + key); if (!root || !state || !state.ui) return;
      root.textContent = '';
      const value = state.ui[key] || {};
      if (sectionRows[key]) {
        const table = el('table', { class: 'shoptet-table' });
        const head = el('thead'); const header = el('tr');
        for (const col of sectionRows[key]) { const th = el('th'); th.textContent = col === 'limit' ? 'Max. sleva %' : col === 'tierName' ? 'Věrnostní úroveň' : col === 'id' ? 'ID' : 'Název'; header.append(th); }
        head.append(header); table.append(head);
        const body = el('tbody');
        function addRow(data = {}) {
          const tr = el('tr');
          for (const col of sectionRows[key]) {
            const td = el('td'); const input = el('input', { class: 'input-text w-full', 'data-col': col, type: col === 'limit' ? 'number' : 'text' }, data[col] ?? (col === 'limit' ? 0 : ''));
            if (col === 'limit') { input.min = '0'; input.max = '100'; input.step = '0.01'; }
            td.append(input); tr.append(td);
          }
          const td = el('td'); const remove = el('button', { type: 'button', class: 'btn-remove' }); remove.textContent = '×'; remove.addEventListener('click', () => { tr.remove(); resize(); }); td.append(remove); tr.append(td); body.append(tr);
        }
        (Array.isArray(value) ? value : []).forEach(addRow); table.append(body); root.append(table);
        const add = el('button', { type: 'button', class: 'btn-secondary', style: 'margin-top: 8px;' }); add.textContent = '+ Přidat'; add.addEventListener('click', () => { addRow(); resize(); }); root.append(add);
      } else if (key === 'settings') {
        sectionInput(root, 'enabled', value.enabled, 'checkbox');
        sectionInput(root, 'currency', value.currency);
        sectionInput(root, 'verifyWrites', value.verifyWrites, 'checkbox');
        sectionInput(root, 'rounding', value.rounding, 'number');
      } else if (key === 'coupons') {
        sectionInput(root, 'enabled', value.enabled, 'checkbox');
        sectionInput(root, 'mode', value.mode);
        sectionInput(root, 'maxPercent', value.maxPercent, 'number');
        for (const field of ['lockedTiers','disabledBrands','disabledProducts']) sectionInput(root, field, (value[field] || []).join(', '));
      } else if (key === 'sync') {
        sectionInput(root, 'incremental', value.incremental, 'checkbox');
        sectionInput(root, 'intervalMinutes', value.intervalMinutes, 'number');
        sectionInput(root, 'dryRun', value.dryRun, 'checkbox');
        const note = el('p', { class: 'tab-intro' }); note.textContent = 'Synchronizace se spustí až po dokončení a schválení Shoptet API adaptéru.'; root.append(note);
      }
      const saveDiv = el('div', { style: 'margin-top: 16px;' });
      const save = el('button', { type: 'button', class: 'btn-shoptet-green' }); save.textContent = 'Uložit nastavení';
      save.addEventListener('click', () => saveSection(key)); saveDiv.append(save); root.append(saveDiv);
    }
    function sectionValue(key) {
      const root = $('section-' + key);
      if (sectionRows[key]) return [...root.querySelectorAll('tbody tr')].map(tr => Object.fromEntries([...tr.querySelectorAll('[data-col]')].map(input => [input.dataset.col, input.type === 'number' ? Number(input.value) : input.value])));
      const next = {};
      for (const input of root.querySelectorAll('[data-field]')) {
        const field = input.dataset.field;
        next[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : ['lockedTiers','disabledBrands','disabledProducts'].includes(field) ? input.value.split(',').map(x => x.trim()).filter(Boolean) : input.value;
      }
      return next;
    }
    async function saveSection(key) {
      const btn = $('section-' + key).querySelector('.btn-shoptet-green');
      if (btn) btn.disabled = true;
      try {
        const res = await api('/section', { method: 'PUT', body: JSON.stringify({ section: key, value: sectionValue(key), version: state.version }) });
        state.ui[key] = res.value; state.version = res.version;
        renderSection(key);
        flash('Nastavení sekce ' + key + ' uloženo (verze ' + state.version + ').');
      } catch (e) { flash(e.message, true); } finally { if (btn) btn.disabled = false; resize(); }
    }

    async function renderConfigurationApprovals() {
      const root = $('approvals-container');
      if (!root) return;
      root.textContent = '';
      try {
        const data = await api('/configuration/pending');
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.textContent = 'Návrhy změn ke schválení';
        root.append(heading);

        if (!data.approvals || !data.approvals.length) {
          const empty = document.createElement('p');
          empty.style.cssText = 'color: #777777; font-size: 13px; margin: 10px 0 18px;';
          empty.textContent = 'Žádné čekající návrhy změn ke schválení.';
          root.append(empty);
          return;
        }

        for (const approval of data.approvals) {
          const preview = await api('/configuration/preview', { method: 'POST', body: JSON.stringify({ revisionId: approval.revision_id }) });
          const card = document.createElement('div');
          card.style.cssText = 'background: #ffffff; border: 1px solid #d9d9d9; border-radius: 4px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);';
          const impact = document.createElement('p');
          impact.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: #333333;';
          impact.textContent = preview.impact || 'Návrh úpravy věrnostních ceníků';

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn-shoptet-green';
          button.textContent = 'Schválit uložení této revize';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              await api('/configuration/approve', { method: 'POST', body: JSON.stringify({ approvalId: approval.approval_id }) });
              button.textContent = 'Schváleno';
              flash('Návrh revize byl úspěšně schválen.');
            } catch (e) {
              button.disabled = false;
              flash(e.message, true);
            }
          });
          card.append(impact, button);
          root.append(card);
        }
      } catch {
        // Fallback gracefully
      }
      resize();
    }

    async function renderOAuthConnections() {
      const root = $('oauth-connections');
      if (!root) return;
      root.textContent = '';
      try {
        const data = await api('/oauth/connections');
        if (!data.connections || !data.connections.length) {
          root.innerHTML = '<p style="color: #777777; font-size: 13px; margin-top: 8px;">Žádná aktivní propojení s AI asistentem.</p>';
          return;
        }
        for (const grant of data.connections) {
          const row = document.createElement('div');
          row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: #fafbfc; border: 1px solid #e2e5e8; border-radius: 3px; padding: 10px 14px; margin-top: 8px;';
          const info = document.createElement('div');
          const isRevoked = Boolean(grant.revoked_at);
          const statusText = isRevoked ? '<span style="color: #a94442;">odpojeno</span>' : '<span style="color: #3c763d;">aktivní</span>';
          const lastConn = grant.last_connection_at ? new Date(grant.last_connection_at * 1000).toLocaleString('cs-CZ') : 'dosud nepoužito';
          info.innerHTML = '<div style="font-weight: 600; color: #333333;">' + escapeHtml(grant.client_id) + ' (' + statusText + ')</div>' +
            '<div style="font-size: 12px; color: #777777; margin-top: 2px;">Poslední připojení: ' + lastConn + '</div>';
          row.append(info);
          if (!isRevoked) {
            const revoke = document.createElement('button');
            revoke.type = 'button';
            revoke.className = 'btn-secondary';
            revoke.style.cssText = 'font-size: 12px; padding: 4px 10px;';
            revoke.textContent = 'Odpojit';
            revoke.addEventListener('click', async () => {
              revoke.disabled = true;
              await api('/oauth/disconnect', { method: 'POST', body: JSON.stringify({ grantId: grant.grant_id }) });
              renderOAuthConnections();
            });
            row.append(revoke);
          }
          root.append(row);
        }
      } catch {
        root.innerHTML = '<p style="color: #777777; font-size: 13px; margin-top: 8px;">Připojení k asistentovi je připraveno.</p>';
      }
      resize();
    }
    $('oauth-inspect').addEventListener('click', async () => {
      const root = $('oauth-consent');
      root.textContent = '';
      try {
        const requestId = $('oauth-pair-code').value.trim();
        const info = await api('/oauth/inspect', { method: 'POST', body: JSON.stringify({ requestId }) });
        const card = document.createElement('div');
        card.style.cssText = 'background: #fffdf5; border: 1px solid #e6b85c; border-radius: 3px; padding: 12px 14px; margin: 10px 0;';
        const desc = document.createElement('p');
        desc.style.cssText = 'font-size: 13px; color: #333333; margin-bottom: 10px;';
        desc.textContent = 'Klient: ' + info.clientName + ' | Oprávnění: ' + info.scopes.join(', ');
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'btn-shoptet-green';
        approve.textContent = 'Povolit připojení pro tohoto asistenta';
        approve.addEventListener('click', async () => {
          approve.disabled = true;
          try {
            await api('/oauth/consent', { method: 'POST', body: JSON.stringify({ requestId }) });
            card.innerHTML = '<span style="color: #3c763d; font-weight: bold;">Připojení povoleno. Vraťte se do okna klienta.</span>';
            renderOAuthConnections();
          } catch (e) {
            approve.disabled = false;
            flash(e.message, true);
          }
        });
        card.append(desc, approve);
        root.append(card);
      } catch (e) {
        flash(e.message, true);
      }
      resize();
    });

    async function renderSyncApprovals() {
      const root = $('sync-approvals-container');
      if (!root) return;
      root.textContent = '';
      try {
        const data = await api('/sync/pending');
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.textContent = 'Synchronizace cen';
        root.append(heading);

        if (data.approvals && data.approvals.length) {
          for (const approval of data.approvals) {
            const detail = await api('/sync/plan', { method: 'POST', body: JSON.stringify({ planId: approval.plan_id }) });
            const card = document.createElement('div');
            card.style.cssText = 'background: #ffffff; border: 1px solid #d9d9d9; border-radius: 4px; padding: 14px 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);';
            const title = document.createElement('p');
            title.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: #333333;';
            title.textContent = 'Plán synchronizace: ' + (detail.plan?.actions?.length || 0) + ' položek k propsání do ceníků.';
            const approve = document.createElement('button');
            approve.type = 'button';
            approve.className = 'btn-shoptet-green';
            approve.textContent = 'Schválit přesně tento plán';
            approve.addEventListener('click', async () => {
              approve.disabled = true;
              try {
                await api('/sync/approve', { method: 'POST', body: JSON.stringify({ approvalId: approval.approval_id }) });
                approve.textContent = 'Schváleno';
                flash('Synchronizace cen byla schválena.');
              } catch (e) {
                approve.disabled = false;
                flash(e.message, true);
              }
            });
            card.append(title, approve);
            root.append(card);
          }
        }

        const history = await api('/sync/history');
        if (history.jobs && history.jobs.length) {
          const histHeading = document.createElement('div');
          histHeading.style.cssText = 'font-weight: bold; margin: 14px 0 8px; color: #555555;';
          histHeading.textContent = 'Poslední proběhlé synchronizace:';
          root.append(histHeading);

          const histList = document.createElement('div');
          histList.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
          for (const job of history.jobs) {
            const row = document.createElement('div');
            row.style.cssText = 'font-size: 12px; color: #666666; display: flex; gap: 10px; align-items: center;';
            const stateLabel = job.state === 'completed' ? 'Dokončeno' : (job.state === 'failed' ? 'Chyba' : job.state);
            row.innerHTML = '<span>Úloha #' + escapeHtml(job.job_id) + '</span>' +
              '<span style="background: #e9ecef; padding: 1px 6px; border-radius: 3px;">' + escapeHtml(job.mode) + '</span>' +
              '<span style="color: ' + (job.state === 'completed' ? '#3c763d' : '#a94442') + ';">' + stateLabel + '</span>';
            histList.append(row);
          }
          root.append(histList);
        } else if (!data.approvals || !data.approvals.length) {
          const empty = document.createElement('p');
          empty.style.cssText = 'color: #777777; font-size: 13px; margin: 10px 0 18px;';
          empty.textContent = 'Žádné probíhající synchronizační úlohy.';
          root.append(empty);
        }
      } catch {
        // Fallback gracefully
      }
      resize();
    }

    async function renderLoyaltyOnboarding() {
      const root = $('loyalty-onboarding-container');
      if (!root) return;
      root.textContent = '';

      try {
        const status = await api('/loyalty/status');
        const card = document.createElement('div');
        card.style.cssText = 'background: #ffffff; border: 1px solid #d9d9d9; border-radius: 4px; padding: 18px 20px; margin-top: 18px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);';

        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.style.marginTop = '0';
        heading.textContent = 'Inicializace věrnostního systému (Onboarding & Schválení)';

        const modeBadge = document.createElement('div');
        modeBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 3px; font-size: 13px; font-weight: 600; margin-bottom: 12px;';
        
        const modeLabels = {
          installation: { text: '1. Instalační režim (automatické změny pozastaveny)', bg: '#fcf8e3', color: '#8a6d3b', border: '#faebcc' },
          dry_run_ready: { text: '2. Analýza dokončena (čeká na schválení změn)', bg: '#e8f4fc', color: '#31708f', border: '#bce8f1' },
          approved: { text: '3. Schváleno obchodníkem (připraveno k synchronizaci)', bg: '#dff0d8', color: '#3c763d', border: '#d6e9c6' },
          syncing: { text: '4. Probíhá synchronizace zákazníků do Shoptetu…', bg: '#f2dede', color: '#a94442', border: '#ebccd1' },
          active: { text: '5. Automatický přepočet aktivní (živý provoz)', bg: '#dff0d8', color: '#3c763d', border: '#d6e9c6' }
        };
        const m = modeLabels[status.engineMode] || modeLabels.installation;
        modeBadge.style.background = m.bg;
        modeBadge.style.color = m.color;
        modeBadge.style.border = '1px solid ' + m.border;
        modeBadge.textContent = m.text;

        const desc = document.createElement('p');
        desc.style.cssText = 'font-size: 13px; color: #555555; line-height: 1.5; margin-bottom: 16px;';

        const actionsDiv = document.createElement('div');
        actionsDiv.style.cssText = 'display: flex; gap: 10px; align-items: center; margin-top: 12px; flex-wrap: wrap;';

        if (status.engineMode === 'installation') {
          desc.textContent = 'Věrnostní systém je v bezpečném instalačním režimu. Žádné automatické změny zákaznických ceníků se neprovádějí. Spusťte kontrolní náhled změn pro výpočet navrhovaných VIP hladin bez jakýchkoliv zápisů do e-shopu.';
          const btnDryRun = document.createElement('button');
          btnDryRun.type = 'button';
          btnDryRun.className = 'btn-shoptet-green';
          btnDryRun.textContent = 'Spustit kontrolní náhled změn';
          btnDryRun.addEventListener('click', async () => {
            btnDryRun.disabled = true;
            btnDryRun.textContent = 'Přepočítávám náhled…';
            try {
              await api('/loyalty/dry-run', { method: 'POST', body: '{}' });
              flash('Kontrolní náhled změn byl úspěšně vygenerován bez zápisů do e-shopu.');
              await renderLoyaltyOnboarding();
            } catch (err) {
              btnDryRun.disabled = false;
              btnDryRun.textContent = 'Spustit kontrolní náhled změn';
              flash(err.message, true);
            }
          });
          actionsDiv.append(btnDryRun);
        } else if (status.engineMode === 'dry_run_ready' || status.engineMode === 'approved') {
          desc.textContent = 'Kontrolní analýza byla dokončena. Níže naleznete přesný přehled všech navrhovaných změn zákaznických ceníků k vašemu schválení.';

          const planData = await api('/loyalty/plan');
          const plan = planData.plan;
          const items = planData.items || [];

          if (plan) {
            let planMeta = {};
            try { planMeta = typeof plan.plan_json === 'string' ? JSON.parse(plan.plan_json) : (plan.plan_json || {}); } catch {}
            const isIncomplete = planMeta.canApprove === false || Boolean(planMeta.creditNotesUnavailable);

            if (isIncomplete) {
              const warnBox = document.createElement('div');
              warnBox.style.cssText = 'background: #fff8e5; border: 1px solid #f5c6cb; border-left: 4px solid #d9534f; color: #8a6d3b; border-radius: 4px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; line-height: 1.5;';
              warnBox.innerHTML = '<strong style="color: #a94442; font-size: 14px;">⚠️ Upozornění: Návrh je pouze diagnostický náhled (data nejsou úplná)</strong><br><span style="color: #555;">V Shoptetu chybí oprávnění k rozhraní dobropisů (API vrátilo HTTP 403 Forbidden). Bez těchto dat nelze spolehlivě odečíst vrácené nebo stornované objednávky. <strong>Schválení a zápis změn do Shoptetu je z bezpečnostních důvodů zablokován</strong>, aby zákazníkům nebyly neoprávněně přiděleny VIP slevy. Pro aktivaci schvalování udělte doplňku oprávnění k dobropisům v administraci Shoptetu.</span>';
              card.append(warnBox);
            }

            const summaryBox = document.createElement('div');
            summaryBox.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px;';
            summaryBox.innerHTML = '<div style="background: #f7f9fa; border: 1px solid #e2e5e8; border-radius: 3px; padding: 8px 12px; text-align: center;"><div style="font-size: 11px; color: #777;">Celkem zákazníků</div><div style="font-size: 18px; font-weight: bold; color: #333;">' + plan.total_customers + '</div></div>' +
              '<div style="background: #f7f9fa; border: 1px solid #e2e5e8; border-radius: 3px; padding: 8px 12px; text-align: center;"><div style="font-size: 11px; color: #777;">Ke změně ceníku</div><div style="font-size: 18px; font-weight: bold; color: #2e6da4;">' + plan.changes_needed + '</div></div>' +
              '<div style="background: #f7f9fa; border: 1px solid #e2e5e8; border-radius: 3px; padding: 8px 12px; text-align: center;"><div style="font-size: 11px; color: #777;">Beze změny</div><div style="font-size: 18px; font-weight: bold; color: #3c763d;">' + (plan.total_customers - plan.changes_needed - plan.b2b_skipped) + '</div></div>' +
              '<div style="background: #f7f9fa; border: 1px solid #e2e5e8; border-radius: 3px; padding: 8px 12px; text-align: center;"><div style="font-size: 11px; color: #777;">Chráněno (B2B/zámek)</div><div style="font-size: 18px; font-weight: bold; color: #8a6d3b;">' + plan.b2b_skipped + '</div></div>';
            card.append(summaryBox);

            const tableWrap = document.createElement('div');
            tableWrap.className = 'shoptet-table-responsive';
            tableWrap.style.maxHeight = '280px';
            tableWrap.style.overflowY = 'auto';
            tableWrap.style.marginBottom = '14px';

            const table = document.createElement('table');
            table.className = 'shoptet-table';
            const tbodyHtml = items.map(it => {
              const statusBadges = {
                ready_to_patch: '<span style="color: #2e6da4; font-weight: 600;">Ke změně</span>',
                no_change: '<span style="color: #777;">Beze změny</span>',
                b2b_locked: '<span style="color: #8a6d3b;">Chráněno B2B</span>',
                verified: '<span style="color: #3c763d; font-weight: 600;">Zapsáno</span>'
              };
              const statusHtml = statusBadges[it.status] || it.status;
              const curPlName = (state.pricelists && state.pricelists.find(p => p.id === it.current_pricelist_id)?.name) || (it.current_pricelist_id ? 'Ceník #' + it.current_pricelist_id : 'Výchozí');
              const tgtPlName = (state.pricelists && state.pricelists.find(p => p.id === it.target_pricelist_id)?.name) || (it.target_pricelist_id ? 'Ceník #' + it.target_pricelist_id : 'Výchozí');
              const turnoverKc = (it.calculated_turnover_minor / 100).toLocaleString('cs-CZ') + ' Kč';
              return '<tr><td><strong>' + escapeHtml(it.customer_name || 'Zákazník') + '</strong></td><td>' + escapeHtml(it.customer_email || '—') + '</td><td>' + escapeHtml(curPlName) + '</td><td><strong style="color: #2e6da4;">' + escapeHtml(tgtPlName) + '</strong></td><td>' + turnoverKc + '</td><td>' + statusHtml + '</td></tr>';
            }).join('');

            table.innerHTML = '<thead><tr><th>Zákazník</th><th>E-mail</th><th>Stávající ceník</th><th>Navržený ceník</th><th>Započtený obrat</th><th>Stav</th></tr></thead><tbody>' + tbodyHtml + '</tbody>';
            tableWrap.append(table);
            card.append(tableWrap);

            if (status.engineMode === 'dry_run_ready') {
              const btnApprove = document.createElement('button');
              btnApprove.type = 'button';
              btnApprove.className = 'btn-shoptet-green';
              btnApprove.textContent = 'Schválit a provést synchronizaci';
              if (isIncomplete) {
                btnApprove.disabled = true;
                btnApprove.style.opacity = '0.5';
                btnApprove.style.cursor = 'not-allowed';
                btnApprove.title = 'Návrh nelze schválit bez dat o dobropisech (aplikace nemá potřebná oprávnění v Shoptetu).';
              } else {
                btnApprove.addEventListener('click', async () => {
                  btnApprove.disabled = true;
                  btnApprove.textContent = 'Schvaluji…';
                  try {
                    await api('/loyalty/approve', { method: 'POST', body: JSON.stringify({ planId: plan.plan_id }) });
                    flash('Plán byl schválen. Spouštím dávkovou synchronizaci…');
                    await api('/loyalty/sync', { method: 'POST', body: JSON.stringify({ planId: plan.plan_id }) });
                    flash('Synchronizace zákazníků byla úspěšně dokončena a automatický přepočet je aktivní.');
                    await renderLoyaltyOnboarding();
                  } catch (err) {
                    btnApprove.disabled = false;
                    btnApprove.textContent = 'Schválit a provést synchronizaci';
                    flash(err.message, true);
                  }
                });
              }
              actionsDiv.append(btnApprove);
            } else if (status.engineMode === 'approved') {
              const btnSync = document.createElement('button');
              btnSync.type = 'button';
              btnSync.className = 'btn-shoptet-green';
              btnSync.textContent = 'Spustit synchronizaci ceníků';
              btnSync.addEventListener('click', async () => {
                btnSync.disabled = true;
                btnSync.textContent = 'Synchronizuji…';
                try {
                  await api('/loyalty/sync', { method: 'POST', body: JSON.stringify({ planId: plan.plan_id }) });
                  flash('Synchronizace byla dokončena a automatický přepočet aktivován.');
                  await renderLoyaltyOnboarding();
                } catch (err) {
                  btnSync.disabled = false;
                  btnSync.textContent = 'Spustit synchronizaci ceníků';
                  flash(err.message, true);
                }
              });
              actionsDiv.append(btnSync);
            }

            const btnReDryRun = document.createElement('button');
            btnReDryRun.type = 'button';
            btnReDryRun.className = 'btn-secondary';
            btnReDryRun.textContent = 'Přepočítat znovu (Aktualizovat náhled)';
            btnReDryRun.addEventListener('click', async () => {
              btnReDryRun.disabled = true;
              btnReDryRun.textContent = 'Přepočítávám…';
              try {
                await api('/loyalty/dry-run', { method: 'POST', body: '{}' });
                flash('Nový kontrolní náhled byl úspěšně vygenerován.');
                await renderLoyaltyOnboarding();
              } catch (err) {
                btnReDryRun.disabled = false;
                btnReDryRun.textContent = 'Přepočítat znovu (Aktualizovat náhled)';
                flash(err.message, true);
              }
            });
            actionsDiv.append(btnReDryRun);
          }
        } else if (status.engineMode === 'active') {
          desc.innerHTML = '<span style="color: #3c763d; font-weight: 600;">✓ Inicializace a synchronizace byla úspěšně dokončena.</span><br>' +
            'Automatický přepočet věrnostních ceníků je v živém provozu. Jakákoli nová nebo upravená objednávka okamžitě aktualizuje zařazení zákazníka.';
          
          const btnNewAudit = document.createElement('button');
          btnNewAudit.type = 'button';
          btnNewAudit.className = 'btn-secondary';
          btnNewAudit.textContent = 'Spustit kontrolní přepočet bez zápisu';
          btnNewAudit.addEventListener('click', async () => {
            btnNewAudit.disabled = true;
            btnNewAudit.textContent = 'Přepočítávám…';
            try {
              await api('/loyalty/dry-run', { method: 'POST', body: '{}' });
              flash('Kontrolní náhled byl vygenerován.');
              await renderLoyaltyOnboarding();
            } catch (err) {
              btnNewAudit.disabled = false;
              btnNewAudit.textContent = 'Spustit kontrolní přepočet bez zápisu';
              flash(err.message, true);
            }
          });
          actionsDiv.append(btnNewAudit);
        }

        card.prepend(heading, modeBadge, desc);
        card.append(actionsDiv);
        root.append(card);
      } catch (e) {
        // Fallback
      }
      resize();
    }

    async function renderReconciliation() {
      const root = $('reconciliation-container');
      if (!root) return;
      root.textContent = '';
      try {
        const res = await api('/reconciliation/status');
        const card = document.createElement('div');
        card.style.cssText = 'background: #ffffff; border: 1px solid #d9d9d9; border-radius: 4px; padding: 18px 20px; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);';

        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.style.marginTop = '0';
        heading.textContent = 'Kontrola souladu cen a slevových kupónů';
        card.append(heading);

        const autoNotice = document.createElement('div');
        autoNotice.style.cssText = 'font-size: 12px; color: #555555; margin-bottom: 12px; background: #f8f9fa; border: 1px solid #e2e5e8; border-radius: 3px; padding: 6px 10px;';
        autoNotice.textContent = 'Automatická oprava cen: VYPNUTO (veškeré změny cen v e-shopu vždy vyžadují schválení obchodníka).';
        card.append(autoNotice);

        const rec = res.lastReconciliation;
        if (rec && rec.priceReport && rec.couponReport) {
          const p = rec.priceReport.counts || { total: 0, match: 0, drift: 0, missing: 0, skipped: 0, unknown: 0 };
          const c = rec.couponReport.counts || { total: 0, match: 0, drift: 0, missing: 0, skipped: 0, unknown: 0 };
          const grid = document.createElement('div');
          grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px;';
          grid.innerHTML =
            '<div style="background:#f7f9fa;border:1px solid #e2e5e8;border-radius:3px;padding:8px 12px;text-align:center;"><div style="font-size:11px;color:#777;">Ceny v pořádku</div><div style="font-size:16px;font-weight:bold;color:#3c763d;">' + p.match + ' / ' + p.total + '</div></div>' +
            '<div style="background:#f7f9fa;border:1px solid #e2e5e8;border-radius:3px;padding:8px 12px;text-align:center;"><div style="font-size:11px;color:#777;">Rozdíly v cenách</div><div style="font-size:16px;font-weight:bold;color:' + (p.drift > 0 ? '#a94442' : '#333') + ';">' + p.drift + '</div></div>' +
            '<div style="background:#f7f9fa;border:1px solid #e2e5e8;border-radius:3px;padding:8px 12px;text-align:center;"><div style="font-size:11px;color:#777;">Kupóny v pořádku</div><div style="font-size:16px;font-weight:bold;color:#3c763d;">' + c.match + ' / ' + c.total + '</div></div>' +
            '<div style="background:#f7f9fa;border:1px solid #e2e5e8;border-radius:3px;padding:8px 12px;text-align:center;"><div style="font-size:11px;color:#777;">Rozdíly u kupónů</div><div style="font-size:16px;font-weight:bold;color:' + (c.drift > 0 ? '#a94442' : '#333') + ';">' + c.drift + '</div></div>';
          card.append(grid);
        } else {
          const empty = document.createElement('p');
          empty.style.cssText = 'font-size: 13px; color: #777777; margin-bottom: 12px;';
          empty.textContent = 'Dosud nebyla spuštěna žádná kontrola souladu cen a slevových kupónů.';
          card.append(empty);
        }

        const btnRun = document.createElement('button');
        btnRun.type = 'button';
        btnRun.className = 'btn-secondary';
        btnRun.id = 'btn-run-reconciliation';
        btnRun.textContent = 'Spustit kontrolu cen a kupónů';
        btnRun.addEventListener('click', async () => {
          btnRun.disabled = true;
          btnRun.textContent = 'Kontroluji ceny a kupóny…';
          try {
            await api('/reconciliation/run', { method: 'POST', body: '{}' });
            flash('Kontrola souladu cen a kupónů byla dokončena.');
            await renderReconciliation();
          } catch (err) {
            btnRun.disabled = false;
            btnRun.textContent = 'Spustit kontrolu cen a kupónů';
            flash(err.message, true);
          }
        });
        card.append(btnRun);
        root.append(card);
      } catch {
        // Fallback gracefully
      }
      resize();
    }

    async function renderConfigurationHistory() {
      const root = $('history-container');
      if (!root) return;
      root.textContent = '';
      try {
        const data = await api('/configuration/history');
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.textContent = 'Historie schválených změn nastavení';
        root.append(heading);
        if (!data.history || !data.history.length) {
          const empty = document.createElement('p');
          empty.style.cssText = 'color: #777777; font-size: 13px; margin: 10px 0 18px;';
          empty.textContent = 'Zatím nebyly zaznamenány žádné historické verze nastavení.';
          root.append(empty);
          return;
        }
        const list = document.createElement('div');
        list.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px;';
        for (const item of data.history) {
          const row = document.createElement('div');
          row.style.cssText = 'font-size: 12px; color: #555555; background: #fafbfc; border: 1px solid #e2e5e8; border-radius: 3px; padding: 8px 12px; display: flex; justify-content: space-between;';
          const dt = item.applied_at ? new Date(item.applied_at * 1000).toLocaleString('cs-CZ') : '—';
          row.innerHTML = '<span><strong>Verze #' + escapeHtml(item.version) + '</strong> (revize ' + escapeHtml(String(item.revision_id || '').slice(0, 8)) + ')</span><span>' + escapeHtml(dt) + '</span>';
          list.append(row);
        }
        root.append(list);
      } catch {
        // Fallback gracefully
      }
      resize();
    }

    $('onboarding-retry').addEventListener('click',async()=>{try{await api('/installation/retry',{method:'POST',body:'{}'});state=await api('/state');renderOverview();}catch(e){flash(e.message,true);}});

    async function renderWebhookStatus(){try{const result=await api('/webhooks/status');$('webhook-status').textContent=result.ready?'Podpisový klíč je nastaven. Doručení oznámení je třeba ověřit.':'Bezpečná oznámení nejsou nastavená.';$('webhook-enable').disabled=result.ready||state.installation?.state!=='active';if(!result.ready)$('token-new').disabled=true;}catch{$('webhook-status').textContent='Stav bezpečných oznámení nelze načíst.';}}
    $('webhook-enable').addEventListener('click',async()=>{if(!$('webhook-confirm').checked){flash('Potvrďte vytvoření podpisového klíče pro tuto instalaci.',true);return;}try{await api('/webhooks/enable',{method:'POST',body:JSON.stringify({confirm:'initialize_installation_webhook_signing'})});await renderWebhookStatus();}catch(e){flash(e.message,true);}});

    /* Boot */
    (async () => {
      try {
        state = await api('/state');
        try { const plData = await api('/catalog/pricelists'); state.pricelists = plData.items || []; } catch { state.pricelists = []; }
        try {
          const ov = await api('/onboarding/overview');
          state.overview = ov;
          state.customerGroups = ov.customerGroups || [];
          renderStoreSummary(ov);
        } catch {
          state.overview = null;
          state.customerGroups = [];
        }
        $('loading').remove();
        renderOverview(); renderTiers(); renderRules(); renderTokens(); sectionKeys.forEach(renderSection); renderConfigurationApprovals(); renderOAuthConnections(); renderSyncApprovals(); renderWebhookStatus(); renderLoyaltyOnboarding(); renderReconciliation(); renderConfigurationHistory();
      } catch (e) {
        $('loading').textContent = '';
        flash(e.message, true);
      }
      resize();
    })();
  })();
  </script>
</body>
</html>`;
}

export async function handleAdminSettingsIframe(request, env) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!env.DB) return renderErrorPage('db_not_bound', 503);
  const auth = await authorizeSettingsPage(request, env);
  if (auth.error) return renderErrorPage(auth.error, auth.status);
  
  const url = new URL(request.url);
  const shopId = auth.shopId || url.searchParams.get('eshopId') || '826800';
  const html = renderAdminHtml(shopId, auth);

  const nonce = crypto.randomUUID().replace(/-/g, '');
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `frame-ancestors ${FRAME_ANCESTORS};`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer-when-downgrade',
      'Cache-Control': 'no-store'
    }
  });
}
