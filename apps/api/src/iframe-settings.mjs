import {initializeWebhookKey,lifecycleReady} from '../../../packages/core/src/webhooks.mjs';
import {verifyInstallation} from '../../../packages/core/src/installation-verification.mjs';
import {createShoptetAdapter} from '../../../packages/core/src/shoptet-adapter.mjs';
import {getShoptetApiAccessToken} from '../../../packages/core/src/shoptet-oauth.mjs';
import {syncRuntime} from './sync/runtime.mjs';
import {createMcpOAuth,oauthConfiguration,digest,OAuthError} from '../../../packages/core/src/mcp-oauth.mjs';
import { createConfigurationService } from '../../../packages/core/src/configuration.mjs';
/**
 * L-Code Loyalty Pricing Engine — addon settings page embedded in Shoptet administration.
 * High-fidelity native Shoptet administration theme with Shoptet tabs, cards, and buttons.
 */
import { authorizeSettingsPage, verifySession, bearerFrom } from './admin-session.mjs';

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
    const extra = Object.keys(t).filter(k => !['name', 'percent', 'minTurnover'].includes(k));
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
    tiers.push({ name, percent, minTurnover });
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
  return {
    rules: {
      couponLockTopTiers: input.couponLockTopTiers !== false,
      couponLockMaxRemaining: input.couponLockMaxRemaining !== false,
      highestDiscountWins: input.highestDiscountWins !== false,
      vatIntegrity: true,
      postWriteVerify: input.postWriteVerify !== false,
      brandLimits
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
      couponLockMaxRemaining: true,
      highestDiscountWins: true,
      vatIntegrity: true,
      postWriteVerify: true,
      brandLimits: {}
    };
    const rules = { ...defaultRules, ...(config.rules || {}) };

    const tiers = Array.isArray(config.tiers) ? config.tiers : [];

    return jsonRes({
      shopId,
      verification:await env.DB.prepare('SELECT state,attempts,error_code,next_attempt_at FROM installation_verification_jobs WHERE shop_id=?').bind(shopId).first(),
      installation: inst || null,
      tiers,
      rules,
      version,
      currency:config.loyaltyProposal?.currency??null,
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

    const current = await env.DB.prepare('SELECT config_json, version FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
    const { config, version } = parseConfig(current);
    if (version !== body.version) return jsonRes({ error: 'Nastavení mezitím změnil někdo jiný. Obnovte stránku.', version }, 409);
    const next = { ...config, tiers: v.tiers };

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
    if(Object.keys(v.rules.brandLimits).length){
      try{const catalog=createShoptetAdapter({getToken:async()=> (await getShoptetApiAccessToken({db:env.DB,shopId,tokenKeys:env.SHOPTET_TOKEN_KEYS})).apiAccessToken});for(const id of Object.keys(v.rules.brandLimits))if(!await catalog.verifyBrand(id))return jsonRes({error:'Značka již neexistuje v katalogu.'},422);}catch{return jsonRes({error:'Značky nelze ověřit. Zkontrolujte oprávnění Shoptetu.'},422);}
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

    .panel { display: none; }
    .panel.active { display: block; }
`;

function renderErrorPage(error, status) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const messages = {
    missing_code: 'Stránku otevřete z administrace Shoptetu: <strong>Propojení → Věrnostní slevy a ceníky</strong>.',
    missing_eshop_id: 'V adrese chybí parametr <code>eshopId</code>.',
    not_installed: 'Doplněk není na tomto e-shopu nainstalovaný.',
    invalid_preview_key: 'Neplatný náhledový klíč.',
    shop_mismatch: 'Přihlášený uživatel nepatří k tomuto e-shopu.',
    session_secret_not_configured: 'Server není nakonfigurovaný.',
    client_not_configured: 'Server nemá nakonfigurovaný Shoptet klient.'
  };
  const msg = messages[error] || `Ověření uživatele se nezdařilo (${escapeHtml(error)}). Zkuste stránku otevřít znovu z administrace.`;
  return new Response(`<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Věrnostní slevy a ceníky</title><style>${SHOPTET_STYLES}</style></head><body><div class="page-card">
<div class="title-row"><h1 class="page-title">Věrnostní slevy a ceníky</h1></div>
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
  <title>Věrnostní slevy a ceníky</title>
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
      <span class="current">Věrnostní slevy a ceníky</span>
    </div>

    <!-- Title Row -->
    <div class="title-row">
      <h1 class="page-title">Věrnostní slevy a ceníky</h1>
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
      <button type="button" class="shoptet-tab" data-tab="mcp" role="tab">AI asistent</button>
      <button type="button" class="shoptet-tab" data-tab="overview" role="tab">Přehled</button>
    </div>

    <div id="loading" style="padding: 24px 0; color: #777777;">Načítám nastavení…</div>

    <!-- Tab 1: Nastavení (Věrnostní ceníky) -->
    <section class="panel active" id="panel-tiers">
      <p class="tab-intro">Vypište pečlivě níže uvedené údaje. Nastavení určuje procentuální věrnostní slevy a nákupní obrat pro automatické zařazení vašich zákazníků do ceníků.</p>

      <div class="shoptet-notice">
        <span class="notice-icon">💡</span>
        <span>Pokud má produkt v e-shopu akční cenu výhodnější než zákazníkova věrnostní sleva, zákazník nakupuje za výhodnější akční cenu. Všechny ceny se do e-shopu ukládají včetně platné sazby DPH.</span>
      </div>

      <div class="section-heading">Věrnostní ceníky a obraty</div>

      <table class="shoptet-table">
        <thead>
          <tr>
            <th style="width: 48%;">Název věrnostního ceníku</th>
            <th style="width: 24%;">Věrnostní sleva</th>
            <th style="width: 24%;">Požadovaný obrat</th>
            <th style="width: 4%;"></th>
          </tr>
        </thead>
        <tbody id="tiers-body"></tbody>
      </table>

      <div style="display: flex; gap: 8px; align-items: center; margin-top: 16px;">
        <button type="button" class="btn-secondary" id="tiers-add">+ Přidat další ceník</button>
        <button type="button" class="btn-shoptet-green" id="tiers-save-bottom">Uložit</button>
        <span style="color: #888888; font-size: 12px; margin-left: 8px;" id="tiers-version"></span>
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
        <label class="form-label">Zákaz kupónů pro nejvyšší slevy</label>
        <div class="form-field">
          <input type="checkbox" id="rule-coupon-lock-top" checked style="width: 16px; height: 16px; cursor: pointer;">
          <label for="rule-coupon-lock-top" style="cursor: pointer;">Zákazníci s nejvyššími slevami (20 % a 25 %) nemohou v nákupním košíku uplatnit slevový kupón.</label>
          <span class="info-icon" title="Ochrana před kombinováním vysoké věrnostní slevy se slevovými kupóny.">i</span>
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

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eeeeee; display: flex; align-items: center; gap: 8px;">
        <button type="button" class="btn-shoptet-green" id="rules-save-bottom">Uložit pravidla</button>
        <span style="color: #888888; font-size: 12px; margin-left: 8px;" id="rules-version"></span>
      </div>
    </section>

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
      <div id="oauth-consent" style="margin: 10px 0 16px 298px;"></div>
      <div id="oauth-connections" style="margin: 8px 0 16px 298px;"></div>

      <div class="section-heading">Aktivní přístupové klíče pro MCP</div>

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

      <div id="approvals-container"></div>
      <div id="sync-approvals-container"></div>
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
    function tierRow(t = { name: '', percent: '', minTurnover: '' }) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" class="input-text w-full tier-name" placeholder="Název úrovně"></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-small tier-percent" min="0.01" max="100" step="0.01"><span class="unit">%</span></div></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-med tier-turnover" min="0" step="1"><span class="unit tier-currency"></span></div></td>' +
        '<td><button type="button" class="btn-remove tier-remove" title="Smazat úroveň">×</button></td>';
      tr.querySelector('.tier-name').value=t.name||'';tr.querySelector('.tier-percent').value=t.percent??'';tr.querySelector('.tier-turnover').value=t.minTurnover??'';tr.querySelector('.tier-currency').textContent=state.currency||'měna obchodu';
      tr.querySelector('.tier-remove').addEventListener('click', () => { tr.remove(); resize(); });
      return tr;
    }

    function renderTiers() {
      const b = $('tiers-body');
      b.textContent = '';
      state.tiers.forEach(t => b.append(tierRow(t)));
      $('tiers-version').textContent = state.version ? 'Uloženo (verze: ' + state.version + ')' : '';
    }

    $('tiers-add').addEventListener('click', () => {
      const b = $('tiers-body');
      if (b.children.length >= 10) return flash('Můžete nastavit maximálně 10 věrnostních ceníků.', true);
      const r = tierRow();
      b.append(r);
      r.querySelector('input').focus();
      resize();
    });

    async function saveTiers() {
      const rows = [...$('tiers-body').querySelectorAll('tr')];
      const tiers = rows.map(r => ({
        name: r.querySelector('.tier-name').value,
        percent: r.querySelector('.tier-percent').value === '' ? NaN : Number(r.querySelector('.tier-percent').value),
        minTurnover: r.querySelector('.tier-turnover').value === '' ? NaN : Number(r.querySelector('.tier-turnover').value)
      }));
      const btn = $('btn-top-save');
      btn.disabled = true;
      try {
        const res = await api('/tiers', { method: 'PUT', body: JSON.stringify({ tiers, version: state.version }) });
        state.tiers = res.tiers; state.version = res.version;
        renderTiers(); renderOverview();
        flash('Věrnostní ceníky byly úspěšně uloženy.');
      } catch (e) { flash(e.message, true); }
      finally { btn.disabled = false; resize(); }
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

    function renderRules() {
      const r = state.rules || {};
      $('rule-highest-discount').checked = r.highestDiscountWins !== false;
      $('rule-coupon-lock-top').checked = r.couponLockTopTiers !== false;
      $('rule-coupon-min-price-ratio').checked = r.couponLockMaxRemaining !== false;
      $('rule-post-write-verify').checked = r.postWriteVerify !== false;

      const c = $('brand-limits-container');
      c.textContent = '';
      const limits = r.brandLimits || {};
      Object.entries(limits).forEach(([k, v]) => addBrandLimitRow(k, v));

      $('rules-version').textContent = state.version ? 'Uloženo (verze: ' + state.version + ')' : '';
    }

    $('btn-add-brand-limit').addEventListener('click', () => showBrandPicker(addBrandLimitRow()));

    async function saveRules() {
      if(document.querySelector('#brand-limits-container [data-invalid="true"]')){flash('Nejdřív opravte nedostupné odkazy značek.',true);return;}
      const brandLimits = {};
      document.querySelectorAll('#brand-limits-container > div').forEach(row => {
        const name = row.querySelector('.bl-name').value.trim();
        const val = Number(row.querySelector('.bl-limit').value);
        if (name && Number.isFinite(val)) brandLimits[name] = val;
      });

      const rules = {
        highestDiscountWins: $('rule-highest-discount').checked,
        couponLockTopTiers: $('rule-coupon-lock-top').checked,
        couponLockMaxRemaining: $('rule-coupon-min-price-ratio').checked,
        postWriteVerify: $('rule-post-write-verify').checked,
        brandLimits
      };
      const btn = $('btn-top-save');
      btn.disabled = true;
      try {
        const res = await api('/rules', { method: 'PUT', body: JSON.stringify({ rules, version: state.version }) });
        state.rules = res.rules; state.version = res.version;
        renderRules(); renderOverview();
        flash('Pravidla slev a stropy značek byly úspěšně uloženy.');
      } catch (e) { flash(e.message, true); }
      finally { btn.disabled = false; resize(); }
    }

    $('rules-save-bottom').addEventListener('click', saveRules);

    /* Top Save Button saves active tab */
    $('btn-top-save').addEventListener('click', () => {
      if (activeTab === 'rules') {
        saveRules();
      } else {
        saveTiers();
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

    async function renderConfigurationApprovals() {
      const root=document.createElement('section');
      const heading=document.createElement('h2'); heading.textContent='Návrhy ke schválení';root.append(heading);
      $('panel-overview').append(root);
      try {
        const data=await api('/configuration/pending');
        for(const approval of data.approvals) {
          const preview=await api('/configuration/preview',{method:'POST',body:JSON.stringify({revisionId:approval.revision_id})});
          const card=document.createElement('div');
          const impact=document.createElement('p');impact.textContent=preview.impact;
          const details=document.createElement('pre');details.style.cssText='max-height:320px;overflow:auto;white-space:pre-wrap';details.textContent=JSON.stringify({revision:preview.revisionId,baseVersion:preview.baseVersion,before:preview.before,after:preview.after},null,2);
          const button=document.createElement('button');button.type='button';button.className='btn-shoptet-green';button.textContent='Schválit uložení této revize';
          button.addEventListener('click',async()=>{button.disabled=true;try{await api('/configuration/approve',{method:'POST',body:JSON.stringify({approvalId:approval.approval_id})});button.textContent='Schváleno';}catch(e){button.disabled=false;flash(e.message,true);}});
          card.append(impact,details,button);root.append(card);
        }
        if(!data.approvals.length)root.append(document.createTextNode('Žádné čekající návrhy.'));
      }catch{root.append(document.createTextNode('Návrhy nelze načíst. Ověřte migraci 0010.'));}
      resize();
    }

    async function renderOAuthConnections(){
      const root=$('oauth-connections');root.textContent='';
      try{const data=await api('/oauth/connections');for(const grant of data.connections){const row=document.createElement('p');row.textContent=grant.client_id+' — '+(grant.revoked_at?'odpojeno':'povoleno')+' — '+JSON.parse(grant.scopes_json).join(', ')+' — poslední připojení: '+(grant.last_connection_at?new Date(grant.last_connection_at*1000).toLocaleString('cs'):'dosud neověřeno');if(!grant.revoked_at){const revoke=document.createElement('button');revoke.type='button';revoke.textContent='Odpojit';revoke.addEventListener('click',async()=>{await api('/oauth/disconnect',{method:'POST',body:JSON.stringify({grantId:grant.grant_id})});renderOAuthConnections();});row.append(revoke);}root.append(row);}if(!data.connections.length)root.textContent='Žádná OAuth připojení.';}catch{root.textContent='OAuth není nakonfigurované nebo dostupné.';}
      resize();
    }
    $('oauth-inspect').addEventListener('click',async()=>{
      const root=$('oauth-consent');root.textContent='';
      try{const requestId=$('oauth-pair-code').value.trim();const info=await api('/oauth/inspect',{method:'POST',body:JSON.stringify({requestId})});const description=document.createElement('p');description.textContent='Klient: '+info.clientName+'; návratová adresa: '+info.redirectUri+'; požadovaná oprávnění: '+info.scopes.join(', ');const approve=document.createElement('button');approve.type='button';approve.className='btn-shoptet-green';approve.textContent='Povolit tato oprávnění tomuto klientovi';approve.addEventListener('click',async()=>{approve.disabled=true;try{await api('/oauth/consent',{method:'POST',body:JSON.stringify({requestId})});root.textContent='Povoleno. Vraťte se do okna AI klienta.';renderOAuthConnections();}catch(e){approve.disabled=false;flash(e.message,true);}});root.append(description,approve);}catch(e){flash(e.message,true);}resize();
    });

    async function renderSyncApprovals(){
      const root=document.createElement('section');const heading=document.createElement('h2');heading.textContent='Synchronizace cen';root.append(heading);$('panel-overview').append(root);
      try{const data=await api('/sync/pending');
        for(const approval of data.approvals){const detail=await api('/sync/plan',{method:'POST',body:JSON.stringify({planId:approval.plan_id})});const card=document.createElement('div');const title=document.createElement('p');title.textContent='Plán '+detail.planId+'; položek: '+detail.plan.actions.length+'; cílový ceník: '+detail.plan.targetPricelistId;const preview=document.createElement('pre');preview.style.cssText='max-height:320px;overflow:auto;white-space:pre-wrap';preview.textContent=JSON.stringify(detail,null,2);const approve=document.createElement('button');approve.type='button';approve.className='btn-shoptet-green';approve.textContent='Schválit přesně tento plán';approve.addEventListener('click',async()=>{approve.disabled=true;try{await api('/sync/approve',{method:'POST',body:JSON.stringify({approvalId:approval.approval_id})});approve.textContent='Schváleno';}catch(e){approve.disabled=false;flash(e.message,true);}});card.append(title,preview,approve);root.append(card);}
        const history=await api('/sync/history');for(const job of history.jobs){const row=document.createElement('p');row.textContent=job.job_id+' — '+job.mode+' — '+job.state+(job.error_code?' — '+job.error_code:'');root.append(row);}if(!data.approvals.length&&!history.jobs.length)root.append(document.createTextNode('Žádné plány ani synchronizační úlohy.'));
      }catch{root.append(document.createTextNode('Synchronizace není dostupná; ověřte migraci 0013 a konfiguraci koordinátoru.'));}resize();
    }

    $('onboarding-retry').addEventListener('click',async()=>{try{await api('/installation/retry',{method:'POST',body:'{}'});state=await api('/state');renderOverview();}catch(e){flash(e.message,true);}});

    async function renderWebhookStatus(){try{const result=await api('/webhooks/status');$('webhook-status').textContent=result.ready?'Podpisový klíč je nastaven. Doručení oznámení je třeba ověřit.':'Bezpečná oznámení nejsou nastavená.';$('webhook-enable').disabled=result.ready||state.installation?.state!=='active';if(!result.ready)$('token-new').disabled=true;}catch{$('webhook-status').textContent='Stav bezpečných oznámení nelze načíst.';}}
    $('webhook-enable').addEventListener('click',async()=>{if(!$('webhook-confirm').checked){flash('Potvrďte vytvoření podpisového klíče pro tuto instalaci.',true);return;}try{await api('/webhooks/enable',{method:'POST',body:JSON.stringify({confirm:'initialize_installation_webhook_signing'})});await renderWebhookStatus();}catch(e){flash(e.message,true);}});

    /* Boot */
    (async () => {
      try {
        state = await api('/state');
        $('loading').remove();
        renderOverview(); renderTiers(); renderRules(); renderTokens(); renderConfigurationApprovals(); renderOAuthConnections(); renderSyncApprovals(); renderWebhookStatus();
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
