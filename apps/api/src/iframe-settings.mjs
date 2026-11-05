/**
 * L-Code Loyalty Pricing Engine — addon settings page embedded in Shoptet administration.
 * High-fidelity native Shoptet administration theme with Shoptet tabs, cards, and buttons.
 */
import { authorizeSettingsPage, verifySession, bearerFrom } from './admin-session.mjs';

const FRAME_ANCESTORS = "'self' https://*.myshoptet.com https://*.shoptet.cz https://*.shoptet.sk https://admin.shoptet.cz";
const MCP_UI_SCOPES = ['installation:read', 'pricing:preview', 'assets:preview', 'shoptet:read', 'shoptet:write', 'pricing:sync'];
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
  if (input.brandLimits && typeof input.brandLimits === 'object') {
    for (const [k, v] of Object.entries(input.brandLimits)) {
      const cleanKey = String(k).trim().toUpperCase();
      const num = Number(v);
      if (cleanKey && Number.isFinite(num) && num >= 0 && num <= 100) {
        brandLimits[cleanKey] = Math.round(num * 10) / 10;
      }
    }
  }
  return {
    rules: {
      couponLockTopTiers: input.couponLockTopTiers !== false && input.couponLockZR20ZR25 !== false,
      couponLockMaxRemaining: input.couponLockMaxRemaining !== false,
      highestDiscountWins: input.highestDiscountWins !== false,
      vatIntegrity: true,
      postWriteVerify: input.postWriteVerify !== false && input.postWriteVerifyINC010 !== false,
      brandLimits
    }
  };
}

/* ---------------------------------------------------------------- API */

async function requireSession(request, env) {
  const secret = env.ADMIN_SESSION_SECRET || env.VAULT_MASTER_KEY || env.SHOPTET_CLIENT_SECRET;
  if (!secret) return null;
  return verifySession(bearerFrom(request), secret);
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

export async function handleAdminSettingsApi(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return jsonRes({ error: 'origin_denied' }, 403);

  const identity = await requireSession(request, env);
  if (!identity) return jsonRes({ error: 'unauthorized' }, 401);
  const shopId = identity.shopId;
  const route = url.pathname.replace(/^\/admin\/settings\/api/, '');

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
      brandLimits: { 'MIVARDI': 10, 'HONDA': 0 }
    };
    const rules = { ...defaultRules, ...(config.rules || {}) };

    const cleanTiers = [
      { name: 'Věrnostní hladina 4 %', percent: 4, minTurnover: 5000 },
      { name: 'Věrnostní hladina 6 %', percent: 6, minTurnover: 12500 },
      { name: 'Věrnostní hladina 8 %', percent: 8, minTurnover: 25000 },
      { name: 'Věrnostní hladina 10 %', percent: 10, minTurnover: 37500 },
      { name: 'Věrnostní hladina 12 %', percent: 12, minTurnover: 62500 },
      { name: 'Věrnostní hladina 14 %', percent: 14, minTurnover: 87500 },
      { name: 'Věrnostní hladina 16 %', percent: 16, minTurnover: 125000 },
      { name: 'Věrnostní hladina 18 %', percent: 18, minTurnover: 175000 },
      { name: 'Věrnostní hladina 20 %', percent: 20, minTurnover: 250000 },
      { name: 'Věrnostní hladina 25 %', percent: 25, minTurnover: 375000 }
    ];
    const tiers = Array.isArray(config.tiers) && config.tiers.length > 0 ? config.tiers : cleanTiers;

    return jsonRes({
      shopId,
      installation: inst || null,
      tiers,
      rules,
      version,
      mcpTokens: (tokens.results || []).map(t => ({
        fingerprint: t.fp,
        createdAt: t.created_at,
        expiresAt: t.expires_at,
        scopes: (() => { try { return JSON.parse(t.scopes_json); } catch { return []; } })()
      })),
      mcpEndpoint: `${url.origin}/mcp/sse`
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

  if (route === '/mcp-token' && request.method === 'POST') {
    const raw = new Uint8Array(24);
    crypto.getRandomValues(raw);
    const token = 'lcode_mcp_' + [...raw].map(b => b.toString(16).padStart(2, '0')).join('');
    const digest = await sha256Hex(token);
    await env.DB.batch([
      env.DB.prepare('UPDATE mcp_credentials SET revoked_at = CURRENT_TIMESTAMP WHERE shop_id = ? AND revoked_at IS NULL').bind(shopId),
      env.DB.prepare('INSERT INTO mcp_credentials (token_sha256, shop_id, scopes_json) VALUES (?, ?, ?)').bind(digest, shopId, JSON.stringify(MCP_UI_SCOPES))
    ]);
    return jsonRes({ token, fingerprint: digest.slice(0, 8), scopes: MCP_UI_SCOPES });
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

      <div id="brand-limits-container" style="display: flex; flex-direction: column; gap: 8px; max-width: 440px; margin-bottom: 14px;"></div>
      <button type="button" class="btn-secondary" id="btn-add-brand-limit">+ Přidat značku</button>

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #eeeeee; display: flex; align-items: center; gap: 8px;">
        <button type="button" class="btn-shoptet-green" id="rules-save-bottom">Uložit pravidla</button>
        <span style="color: #888888; font-size: 12px; margin-left: 8px;" id="rules-version"></span>
      </div>
    </section>

    <!-- Tab 3: Přehled -->
    <section class="panel" id="panel-overview">
      <p class="tab-intro">Základní přehled o stavu propojení věrnostního systému s vaším e-shopem.</p>

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
      $('ov-url').value = i.eshop_url || 'https://' + BOOT.shopId + '.myshoptet.com/';
      $('ov-email').value = i.contact_email || 'ceo@l-code-dynamics.com';
      $('ov-tiers').textContent = state.tiers.length ? state.tiers.length + ' aktivních věrnostních ceníků' : 'Zatím nenastaveny';
    }

    /* Tiers table */
    function tierRow(t = { name: '', percent: '', minTurnover: '' }) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" class="input-text w-full tier-name" placeholder="např. Věrnostní sleva 4 %" value="' + (t.name || '') + '"></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-small tier-percent" min="0.01" max="100" step="0.01" value="' + (t.percent ?? '') + '"><span class="unit">%</span></div></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="input-text w-med tier-turnover" min="0" step="1" value="' + (t.minTurnover ?? '') + '"><span class="unit">Kč</span></div></td>' +
        '<td><button type="button" class="btn-remove tier-remove" title="Smazat ceník">×</button></td>';
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
    function addBrandLimitRow(name = '', limit = 10) {
      const c = $('brand-limits-container');
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.innerHTML = '<input type="text" class="input-text bl-name" placeholder="NÁZEV ZNAČKY" value="' + name + '" style="flex:1;text-transform:uppercase;">' +
        '<input type="number" class="input-text bl-limit w-small" min="0" max="100" step="1" value="' + limit + '">' +
        '<span class="unit">%</span>' +
        '<button type="button" class="btn-remove bl-remove" title="Odebrat">×</button>';
      row.querySelector('.bl-remove').addEventListener('click', () => { row.remove(); resize(); });
      c.append(row);
      resize();
    }

    function renderRules() {
      const r = state.rules || {};
      $('rule-highest-discount').checked = r.highestDiscountWins !== false;
      $('rule-coupon-lock-top').checked = (r.couponLockTopTiers !== false && r.couponLockZR20ZR25 !== false);
      $('rule-coupon-min-price-ratio').checked = r.couponLockMaxRemaining !== false;
      $('rule-post-write-verify').checked = (r.postWriteVerify !== false && r.postWriteVerifyINC010 !== false);

      const c = $('brand-limits-container');
      c.textContent = '';
      const limits = r.brandLimits || { 'MIVARDI': 10, 'HONDA': 0 };
      Object.entries(limits).forEach(([k, v]) => addBrandLimitRow(k, v));

      $('rules-version').textContent = state.version ? 'Uloženo (verze: ' + state.version + ')' : '';
    }

    $('btn-add-brand-limit').addEventListener('click', () => addBrandLimitRow('', 10));

    async function saveRules() {
      const brandLimits = {};
      document.querySelectorAll('#brand-limits-container > div').forEach(row => {
        const name = row.querySelector('.bl-name').value.trim().toUpperCase();
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

    /* Boot */
    (async () => {
      try {
        state = await api('/state');
        $('loading').remove();
        renderOverview(); renderTiers(); renderRules();
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
