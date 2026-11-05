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
    :root {
      --bg: #f4f6f8;
      --card-bg: #ffffff;
      --border: #dfe3e8;
      --border-dark: #c4cdd5;
      --text: #212b36;
      --text-muted: #637381;
      --primary: #008060;
      --primary-hover: #006e52;
      --danger: #de3618;
      --blue: #2c6ecb;
      --blue-subtle: #ebf5fa;
      --tag-green-bg: #e3f1df;
      --tag-green-text: #108043;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      padding: 20px;
    }

    .wrapper {
      max-width: 1140px;
      margin: 0 auto;
    }

    /* Top Bar */
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .main-title {
      font-size: 20px;
      font-weight: 600;
      color: #0084a8;
      letter-spacing: -0.3px;
    }

    /* Shoptet Tabs */
    .nav-tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .nav-tab {
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      background: #eaedef;
      border: 1px solid var(--border);
      border-bottom: none;
      border-radius: 4px 4px 0 0;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: -1px;
    }
    .nav-tab:hover {
      background: #f0f2f4;
      color: var(--text);
    }
    .nav-tab.active {
      background: var(--card-bg);
      color: var(--text);
      border-bottom: 1px solid var(--card-bg);
      font-weight: 600;
    }

    /* Card Panels */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: #0084a8;
      border-bottom: 1px solid #e1e9ee;
      padding-bottom: 8px;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Key-Value Tables & Status */
    .table-kv {
      width: 100%;
      border-collapse: collapse;
    }
    .table-kv td {
      padding: 9px 0;
      vertical-align: middle;
      font-size: 13px;
      border-bottom: 1px solid #f4f6f8;
    }
    .table-kv tr:last-child td {
      border-bottom: none;
    }
    .table-kv td.key {
      width: 280px;
      color: var(--text-muted);
      font-weight: 500;
    }
    .table-kv td.val {
      color: var(--text);
    }

    /* Data Tables */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
    }
    .data-table th {
      background: #f9fafb;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-muted);
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #f0f2f4;
      vertical-align: middle;
    }
    .data-table tr:last-child td {
      border-bottom: none;
    }

    /* Badges & Inputs */
    .badge-success {
      display: inline-block;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 12px;
      background: var(--tag-green-bg);
      color: var(--tag-green-text);
    }
    .badge-scope {
      display: inline-block;
      padding: 2px 6px;
      font-size: 11px;
      border-radius: 3px;
      background: #e4e8eb;
      color: #454f5b;
      margin-right: 4px;
      font-family: monospace;
    }

    .form-input {
      height: 32px;
      padding: 4px 10px;
      border: 1px solid var(--border-dark);
      border-radius: 4px;
      font-size: 13px;
      color: var(--text);
      background: #fff;
      outline: none;
      transition: border 0.15s ease;
    }
    .form-input:focus {
      border-color: var(--blue);
      box-shadow: 0 0 0 1px var(--blue);
    }
    .form-input.w-small { width: 90px; }
    .form-input.w-med { width: 140px; }
    .form-input.w-full { width: 100%; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 14px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      border: 1px solid transparent;
      text-decoration: none;
    }
    .btn-primary {
      background: var(--primary);
      color: #fff;
    }
    .btn-primary:hover {
      background: var(--primary-hover);
    }
    .btn-secondary {
      background: #fff;
      border-color: var(--border-dark);
      color: var(--text);
    }
    .btn-secondary:hover {
      background: #f9fafb;
    }
    .btn-danger {
      color: var(--danger);
      background: none;
      border: none;
      padding: 0 6px;
      cursor: pointer;
      font-size: 16px;
    }
    .btn[disabled] { opacity: .55; cursor: default; }

    /* Alert / Flash */
    .alert {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      border: 1px solid var(--primary);
      background: #ffffff;
      border-radius: 4px;
      padding: 12px 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.03);
    }
    .alert-icon { color: var(--primary); font-weight: 700; }
    .alert.error { border-color: var(--danger); }
    .alert.error .alert-icon { color: var(--danger); }
    .alert.warn { border-color: #f0a30a; }
    .alert.warn .alert-icon { color: #f0a30a; }

    .panel { display: none; }
    .panel.active { display: block; }
    .hint { color: var(--text-muted); font-size: 12px; margin-top: 4px; }
    pre.snippet { background: #f9fafb; border: 1px solid var(--border); padding: 12px 14px; font: 12px/1.5 Menlo, Consolas, monospace; overflow-x: auto; margin-top: 8px; border-radius: 4px; }
    .unit { color: var(--text-muted); margin-left: 6px; }
`;

function renderErrorPage(error, status) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const messages = {
    missing_code: 'Stránku otevřete z administrace Shoptetu: <strong>Propojení → L-Code Loyalty Pricing Engine</strong>.',
    missing_eshop_id: 'V adrese chybí parametr <code>eshopId</code>.',
    not_installed: 'Doplněk není na tomto e-shopu nainstalovaný.',
    invalid_preview_key: 'Neplatný náhledový klíč.',
    shop_mismatch: 'Přihlášený uživatel nepatří k tomuto e-shopu.',
    session_secret_not_configured: 'Server není nakonfigurovaný.',
    client_not_configured: 'Server nemá nakonfigurovaný Shoptet klient.'
  };
  const msg = messages[error] || `Ověření uživatele se nezdařilo (${escapeHtml(error)}). Zkuste stránku otevřít znovu z administrace.`;
  return new Response(`<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>L-Code Loyalty Pricing Engine</title><style>${SHOPTET_STYLES}</style></head><body><div class="wrapper">
<div class="topbar"><h1 class="main-title">L-Code Loyalty Pricing Engine</h1></div>
<div class="alert error"><span class="alert-icon">!</span><div>${msg}</div></div>
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
  <title>L-Code Loyalty Pricing Engine</title>
  <style>
    ${SHOPTET_STYLES}
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="topbar">
      <h1 class="main-title">L-Code Loyalty Pricing Engine</h1>
      <div>
        <span class="badge-success" id="badge-status">Připojeno k e-shopu</span>
      </div>
    </div>

    <div id="flash"></div>

    <!-- Shoptet Navigation Tabs -->
    <div class="nav-tabs" role="tablist">
      <button class="nav-tab active" data-tab="overview" role="tab">Přehled</button>
      <button class="nav-tab" data-tab="tiers" role="tab">Věrnostní hladiny</button>
      <button class="nav-tab" data-tab="rules" role="tab">Pravidla a ochrana marže</button>
      <button class="nav-tab" data-tab="mcp" role="tab">AI agent (MCP)</button>
    </div>

    <div id="loading" style="padding: 24px 0; color: var(--text-muted);">Načítám konfiguraci e-shopu…</div>

    <!-- Tab 1: Přehled -->
    <section class="panel" id="panel-overview">
      <div class="card">
        <div class="card-title">Stav instalace a licence</div>
        <table class="table-kv">
          <tbody>
            <tr><td class="key">Identifikátor e-shopu</td><td class="val"><strong>${escapeHtml(eshopId)}</strong></td></tr>
            <tr><td class="key">Adresa obchodu</td><td class="val" id="ov-url">—</td></tr>
            <tr><td class="key">Stav doplňku</td><td class="val"><span class="badge-success" id="ov-state">Aktivní</span></td></tr>
            <tr><td class="key">Datum aktivace</td><td class="val" id="ov-created">—</td></tr>
            <tr><td class="key">Poslední synchronizace ceníků</td><td class="val" id="ov-updated">—</td></tr>
            <tr><td class="key">Kontaktní e-mail</td><td class="val" id="ov-email">—</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Souhrn cenového enginu</div>
        <table class="table-kv">
          <tbody>
            <tr><td class="key">Věrnostní hladiny</td><td class="val" id="ov-tiers">—</td></tr>
            <tr><td class="key">Ochrana marže</td><td class="val" id="ov-rules">—</td></tr>
            <tr><td class="key">Aktivní připojení pro AI agenta</td><td class="val" id="ov-tokens">—</td></tr>
            <tr><td class="key">DPH a zaokrouhlování</td><td class="val">Ceny se do Shoptetu zapisují vždy včetně platné sazby DPH.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Tab 2: Věrnostní hladiny -->
    <section class="panel" id="panel-tiers">
      <div class="card">
        <div class="card-title">Nastavení věrnostních slev a obratů</div>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 45%;">Název hladiny</th>
              <th style="width: 25%;">Věrnostní sleva</th>
              <th style="width: 25%;">Minimální obrat</th>
              <th style="width: 5%;"></th>
            </tr>
          </thead>
          <tbody id="tiers-body"></tbody>
        </table>
        <p class="hint">Zákazník získá slevu nejvyšší hladiny, jejíhož obratu za rozhodné období dosáhl. Pokud je akční cena zboží výhodnější než věrnostní, platí pro zákazníka nižší akční cena.</p>
        
        <div style="display: flex; gap: 8px; align-items: center; margin-top: 16px;">
          <button class="btn btn-primary" id="tiers-save">Uložit hladiny</button>
          <button class="btn btn-secondary" id="tiers-add">+ Přidat hladinu</button>
          <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;" id="tiers-version"></span>
        </div>
      </div>
    </section>

    <!-- Tab 3: Pravidla a ochrana marže -->
    <section class="panel" id="panel-rules">
      <div class="card">
        <div class="card-title">Pravidla výpočtu a ochrana marže</div>
        <table class="table-kv">
          <tbody>
            <tr>
              <td class="key">Výhodnější cena má přednost</td>
              <td class="val">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                  <input type="checkbox" id="rule-highest-discount" checked style="width: 16px; height: 16px;">
                  <span>Pokud má produkt akční cenu výhodnější než věrnostní hladina, zákazník platí nižší akční cenu; je-li věrnostní sleva vyšší, uplatní se věrnostní cena.</span>
                </label>
              </td>
            </tr>
            <tr>
              <td class="key">Zákaz kupónů pro nejvyšší hladiny</td>
              <td class="val">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                  <input type="checkbox" id="rule-coupon-lock-top" checked style="width: 16px; height: 16px;">
                  <span>Zákazníci s nejvyššími slevami (20 % a 25 %) nesmí v košíku kombinovat věrnostní cenu se slevovými kupóny.</span>
                </label>
              </td>
            </tr>
            <tr>
              <td class="key">Sčítání slevového kupónu s věrností</td>
              <td class="val">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                  <input type="checkbox" id="rule-coupon-min-price-ratio" checked style="width: 16px; height: 16px;">
                  <span>U nižších hladin omezit slevu z kupónu tak, aby sečtení obou slev nepřekročilo tvůj maržový strop na zboží.</span>
                </label>
              </td>
            </tr>
            <tr>
              <td class="key">Okamžitá kontrola uložení cen</td>
              <td class="val">
                <label style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
                  <input type="checkbox" id="rule-post-write-verify" checked style="width: 16px; height: 16px;">
                  <span>U nově naceněných položek provést okamžitou kontrolu uložení v Shoptetu a při výpadku zápis automaticky zopakovat.</span>
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Maximální povolená sleva pro vybrané značky</div>
        <p class="hint" style="margin-bottom: 12px;">Značky s pevným stropem maximální věrnostní slevy (např. <code>MIVARDI: 10%</code>, <code>HONDA: 0%</code>):</p>
        <div id="brand-limits-container" style="display: flex; flex-direction: column; gap: 8px; max-width: 420px; margin-bottom: 12px;"></div>
        <button class="btn btn-secondary" id="btn-add-brand-limit">+ Přidat značku</button>

        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #f0f2f4;">
          <button class="btn btn-primary" id="rules-save">Uložit pravidla</button>
          <span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;" id="rules-version"></span>
        </div>
      </div>
    </section>

    <!-- Tab 4: AI agent (MCP) -->
    <section class="panel" id="panel-mcp">
      <div class="card">
        <div class="card-title">Připojení pro AI asistenta (Model Context Protocol)</div>
        <p style="margin-bottom: 14px;">Připojte Claude Desktop, Cursor nebo jiného AI klienta a ovládejte věrnostní ceny a ceníky přirozenou řečí.</p>
        
        <table class="data-table">
          <thead>
            <tr>
              <th>Identifikátor klíče</th>
              <th>Vytvořeno</th>
              <th>Přiřazená oprávnění</th>
            </tr>
          </thead>
          <tbody id="tokens-body"></tbody>
        </table>

        <div style="display: flex; gap: 8px; align-items: center; margin-top: 14px;">
          <button class="btn btn-primary" id="token-new">Vygenerovat nový přístupový token</button>
          <span class="hint">Vygenerováním se všechny dosavadní tokeny pro jistotu zneplatní.</span>
        </div>

        <div id="token-result"></div>
      </div>

      <div class="card">
        <div class="card-title">Konfigurační soubor klienta</div>
        <p class="hint">Vložte do souboru <code>claude_desktop_config.json</code> (Mac: <code>~/Library/Application Support/Claude/</code>, Windows: <code>%APPDATA%\\Claude\\</code>):</p>
        <pre class="snippet" id="mcp-snippet"></pre>
      </div>
    </section>
  </div>

  <script nonce="${nonce}">
  (() => {
    const BOOT = ${boot};
    const $ = id => document.getElementById(id);
    let state = null;

    function resize() {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      window.parent.postMessage({ action: 'shoptet.resize', height: h + 20 }, '*');
    }
    addEventListener('load', resize);
    addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

    function flash(msg, kind) {
      const box = $('flash');
      box.textContent = '';
      if (!msg) return;
      const el = document.createElement('div');
      el.className = 'alert' + (kind === 'error' ? ' error' : kind === 'warn' ? ' warn' : '');
      const icon = document.createElement('span');
      icon.className = 'alert-icon';
      icon.textContent = kind === 'error' || kind === 'warn' ? '!' : '✓';
      const text = document.createElement('div');
      text.textContent = msg;
      el.append(icon, text);
      box.append(el);
      if (kind !== 'error') setTimeout(() => { if (box.firstChild === el) box.textContent = ''; }, 5000);
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

    const fmtDate = s => {
      if (!s) return '—';
      const d = new Date(String(s).replace(' ', 'T') + 'Z');
      return isNaN(d) ? s : d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    };

    /* Tabs switching */
    document.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
      resize();
    }));

    /* Overview */
    function renderOverview() {
      const i = state.installation || {};
      $('ov-url').textContent = i.eshop_url || '—';
      $('ov-state').textContent = i.state === 'active' ? 'Aktivní' : (i.state || 'Aktivní');
      $('ov-created').textContent = fmtDate(i.created_at);
      $('ov-updated').textContent = fmtDate(i.updated_at);
      $('ov-email').textContent = i.contact_email || '—';
      $('ov-tiers').textContent = state.tiers.length ? state.tiers.length + ' hladin (verze nastavení ' + state.version + ')' : 'Zatím nenastaveny';
      const r = state.rules || {};
      const blCount = Object.keys(r.brandLimits || {}).length;
      $('ov-rules').textContent = 'Zákaz kupónů u nejvyšších slev, ochrana marže, stropy značek: ' + blCount + ' aktivní';
      $('ov-tokens').textContent = String(state.mcpTokens.length);
    }

    /* Tiers table */
    function tierRow(t = { name: '', percent: '', minTurnover: '' }) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><input type="text" class="form-input w-full tier-name" placeholder="např. VIP Bronz" value="' + (t.name || '') + '"></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="form-input w-small tier-percent" min="0.01" max="100" step="0.01" value="' + (t.percent ?? '') + '"><span class="unit">%</span></div></td>' +
        '<td><div style="display:flex;align-items:center;"><input type="number" class="form-input w-med tier-turnover" min="0" step="1" value="' + (t.minTurnover ?? '') + '"><span class="unit">Kč</span></div></td>' +
        '<td><button class="btn-danger tier-remove" title="Odebrat">×</button></td>';
      tr.querySelector('.tier-remove').addEventListener('click', () => { tr.remove(); resize(); });
      return tr;
    }

    function renderTiers() {
      const b = $('tiers-body');
      b.textContent = '';
      state.tiers.forEach(t => b.append(tierRow(t)));
      $('tiers-version').textContent = state.version ? 'Verze nastavení: ' + state.version : '';
    }

    $('tiers-add').addEventListener('click', () => {
      const b = $('tiers-body');
      if (b.children.length >= 10) return flash('Maximálně 10 věrnostních hladin.', 'warn');
      const r = tierRow();
      b.append(r);
      r.querySelector('input').focus();
      resize();
    });

    $('tiers-save').addEventListener('click', async () => {
      const rows = [...$('tiers-body').querySelectorAll('tr')];
      const tiers = rows.map(r => ({
        name: r.querySelector('.tier-name').value,
        percent: r.querySelector('.tier-percent').value === '' ? NaN : Number(r.querySelector('.tier-percent').value),
        minTurnover: r.querySelector('.tier-turnover').value === '' ? NaN : Number(r.querySelector('.tier-turnover').value)
      }));
      const btn = $('tiers-save');
      btn.disabled = true;
      try {
        const res = await api('/tiers', { method: 'PUT', body: JSON.stringify({ tiers, version: state.version }) });
        state.tiers = res.tiers; state.version = res.version;
        renderTiers(); renderOverview();
        flash('Věrnostní hladiny byly uloženy.');
      } catch (e) { flash(e.message, 'error'); }
      finally { btn.disabled = false; resize(); }
    });

    /* Rules */
    function addBrandLimitRow(name = '', limit = 10) {
      const c = $('brand-limits-container');
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      row.style.alignItems = 'center';
      row.innerHTML = '<input type="text" class="form-input bl-name" placeholder="ZNAČKA" value="' + name + '" style="flex:1;text-transform:uppercase;">' +
        '<input type="number" class="form-input bl-limit w-small" min="0" max="100" step="1" value="' + limit + '">' +
        '<span class="unit">%</span>' +
        '<button class="btn-danger bl-remove" title="Odebrat">×</button>';
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

      $('rules-version').textContent = state.version ? 'Verze nastavení: ' + state.version : '';
    }

    $('btn-add-brand-limit').addEventListener('click', () => addBrandLimitRow('', 10));

    $('rules-save').addEventListener('click', async () => {
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
      const btn = $('rules-save');
      btn.disabled = true;
      try {
        const res = await api('/rules', { method: 'PUT', body: JSON.stringify({ rules, version: state.version }) });
        state.rules = res.rules; state.version = res.version;
        renderRules(); renderOverview();
        flash('Pravidla a slevové stropy byly uloženy.');
      } catch (e) { flash(e.message, 'error'); }
      finally { btn.disabled = false; resize(); }
    });

    /* MCP */
    function snippet(token) {
      return JSON.stringify({ mcpServers: { 'shoptet-pricing': { command: 'npx', args: ['-y', 'mcp-remote', state.mcpEndpoint, '--header', 'Authorization: Bearer ' + (token || '<VÁŠ_TOKEN>')] } } }, null, 2);
    }

    function renderTokens() {
      const b = $('tokens-body');
      b.textContent = '';
      if (!state.mcpTokens.length) {
        b.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);padding:14px 12px;">Žádný aktivní klíč. Vygenerujte nový níže.</td></tr>';
      } else {
        state.mcpTokens.forEach(t => {
          const tr = document.createElement('tr');
          const scopes = (t.scopes || []).map(s => '<span class="badge-scope">' + s + '</span>').join('');
          tr.innerHTML = '<td><code>lcode_mcp_… (' + t.fingerprint + ')</code></td>' +
            '<td>' + fmtDate(t.createdAt) + '</td>' +
            '<td>' + scopes + '</td>';
          b.append(tr);
        });
      }
      $('mcp-snippet').textContent = snippet(null);
    }

    $('token-new').addEventListener('click', async () => {
      if (state.mcpTokens.length && !confirm('Vygenerovat nový token? Všechny dosavadní klíče přestanou fungovat.')) return;
      const btn = $('token-new'); btn.disabled = true;
      try {
        const res = await api('/mcp-token', { method: 'POST', body: '{}' });
        const fresh = await api('/state');
        state = fresh; renderTokens(); renderOverview();
        const box = $('token-result');
        box.innerHTML = '<div class="alert" style="margin-top:14px;"><span class="alert-icon">✓</span><div style="flex:1;">' +
          '<strong>Nový přístupový token byl vygenerován:</strong>' +
          '<div style="display:flex;gap:8px;margin-top:8px;">' +
          '<input type="text" readonly class="form-input" style="flex:1;font-family:monospace;" value="' + res.token + '" id="new-token-val">' +
          '<button class="btn btn-primary" id="btn-copy-token">Zkopírovat</button>' +
          '</div></div></div>';
        $('btn-copy-token').addEventListener('click', () => {
          const inp = $('new-token-val'); inp.select();
          navigator.clipboard?.writeText(res.token);
          flash('Token byl zkopírován do schránky.');
        });
        $('mcp-snippet').textContent = snippet(res.token);
      } catch (e) { flash(e.message, 'error'); }
      finally { btn.disabled = false; resize(); }
    });

    /* Boot */
    (async () => {
      try {
        state = await api('/state');
        $('loading').remove();
        $('panel-overview').classList.add('active');
        renderOverview(); renderTiers(); renderRules(); renderTokens();
        if (BOOT.mode === 'preview') flash('Režim přímého náhledu (bez nutnosti přihlášení ze Shoptetu).', 'warn');
      } catch (e) {
        $('loading').textContent = '';
        flash(e.message, 'error');
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
