/**
 * L-Code Loyalty Pricing Engine — addon settings page embedded in Shoptet administration.
 * Visual language mirrors Shoptet admin (light-blue headings, tabs, green "Uložit").
 * Only real data from D1 is shown; tiers are editable; MCP tokens are shown once at creation.
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
  const maxCap = Number(input.circuitBreakerMaxPercent);
  if (!Number.isFinite(maxCap) || maxCap <= 0 || maxCap > 90) return { error: 'Maximální sleva (Circuit Breaker) musí být 1–90 %.' };
  const couponLock = Number(input.couponLockAbovePercent);
  if (!Number.isFinite(couponLock) || couponLock < 0 || couponLock > 100) return { error: 'Kupónový zámek musí být 0–100 %.' };
  return {
    rules: {
      circuitBreakerMaxPercent: Math.round(maxCap * 10) / 10,
      couponLockAbovePercent: Math.round(couponLock * 10) / 10,
      selfHealingBatch: Boolean(input.selfHealingBatch),
      vipCartDynamic: Boolean(input.vipCartDynamic)
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
      circuitBreakerMaxPercent: 30,
      couponLockAbovePercent: 20,
      selfHealingBatch: true,
      vipCartDynamic: true
    };
    const rules = { ...defaultRules, ...(config.rules || {}) };

    return jsonRes({
      shopId,
      installation: inst || null,
      tiers: Array.isArray(config.tiers) ? config.tiers : [],
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

/* ---------------------------------------------------------------- pages */

const BASE_CSS = `
  :root {
    --blue: #25a9e0; --blue-dark: #1b8fc0;
    --green: #79b928; --green-dark: #65a01c;
    --border: #cfcfcf; --border-light: #e4e4e4;
    --text: #333333; --muted: #777777;
    --tab-bg: #f3f3f3; --row-alt: #fafafa; --red: #d9534f;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; color: var(--text); font: 13px/1.5 Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif; padding: 20px 22px 28px; }
  h1 { margin: 0 0 22px; color: var(--blue); font-size: 32px; font-weight: 300; line-height: 1.2; }
  .section-title { display: flex; align-items: center; gap: 14px; margin: 26px 0 14px; color: var(--blue); font-size: 20px; font-weight: 300; }
  .section-title::after { content: ""; flex: 1; height: 1px; background: var(--border-light); }
  .btn { display: inline-block; border: 0; border-radius: 0; padding: 7px 11px; font: 600 12px/1.2 inherit; font-family: inherit; color: #fff; cursor: pointer; text-decoration: none; }
  .btn-green { background: var(--green); } .btn-green:hover { background: var(--green-dark); }
  .btn-blue { background: var(--blue); } .btn-blue:hover { background: var(--blue-dark); }
  .btn-link { background: none; color: var(--blue); padding: 0; font-weight: 400; }
  .btn-link:hover { text-decoration: underline; }
  .btn[disabled] { opacity: .55; cursor: default; }
  .alert { display: flex; gap: 12px; align-items: flex-start; border: 1px solid var(--green); border-radius: 3px; padding: 13px 18px; margin-bottom: 18px; background: #fff; }
  .alert-icon { color: var(--green); font-weight: 700; }
  .alert.error { border-color: var(--red); } .alert.error .alert-icon { color: var(--red); }
  .alert.warn { border-color: #f0a30a; } .alert.warn .alert-icon { color: #f0a30a; }
  code { font-family: Menlo, Consolas, monospace; font-size: 12px; background: #f5f5f5; padding: 1px 4px; }
`;

function renderErrorPage(error, status) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const messages = {
    missing_code: 'Stránku otevřete z administrace Shoptetu: <strong>Propojení → L-Code Loyalty Pricing Engine</strong>. Přímý odkaz bez přihlášení nefunguje.',
    missing_eshop_id: 'V adrese chybí parametr <code>eshopId</code>.',
    not_installed: 'Doplněk není na tomto e-shopu nainstalovaný.',
    invalid_preview_key: 'Neplatný náhledový klíč.',
    shop_mismatch: 'Přihlášený uživatel nepatří k tomuto e-shopu.',
    session_secret_not_configured: 'Server není nakonfigurovaný (chybí ADMIN_SESSION_SECRET).',
    client_not_configured: 'Server není nakonfigurovaný (chybí OAuth klient).'
  };
  const msg = messages[error] || `Ověření uživatele se nezdařilo (<code>${escapeHtml(error)}</code>). Zkuste stránku otevřít znovu z administrace.`;
  return new Response(`<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>L-Code Loyalty Pricing Engine</title><style>${BASE_CSS}</style></head><body>
<h1>L-Code Loyalty Pricing Engine</h1>
<div class="alert error"><span class="alert-icon">!</span><div>${msg}</div></div>
<script nonce="${nonce}">
  function h(){window.parent.postMessage({action:'shoptet.resize',height:document.documentElement.scrollHeight},'*');}
  addEventListener('load',h);
</script></body></html>`, { status, headers: htmlHeaders(nonce) });
}

function renderApp({ shopId, session, mode }) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const boot = JSON.stringify({ shopId, session, mode }).replace(/</g, '\\u003c');

  return new Response(`<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>L-Code Loyalty Pricing Engine</title>
<style>
  ${BASE_CSS}
  .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--border); margin-bottom: 4px; }
  .tab { background: var(--tab-bg); border: 1px solid var(--border); border-bottom: 0; margin-right: -1px; padding: 9px 16px 8px; font: 12px/1.2 inherit; font-family: inherit; color: var(--text); cursor: pointer; border-top: 3px solid transparent; position: relative; top: 1px; }
  .tab:hover { background: #fafafa; }
  .tab.active { background: #fff; border-top-color: var(--green); padding-bottom: 9px; }
  .panel { display: none; } .panel.active { display: block; }
  .form-row { display: grid; grid-template-columns: minmax(160px, 300px) 1fr; gap: 6px 16px; align-items: center; padding: 6px 0; }
  .form-row > label, .form-row > .label { text-align: right; font-size: 12px; }
  .form-row .value { font-size: 12px; word-break: break-all; }
  @media (max-width: 640px) { .form-row { grid-template-columns: 1fr; } .form-row > .label { text-align: left; color: var(--muted); } }
  table.grid { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.grid th { text-align: left; font-weight: 700; background: #f2f2f2; padding: 9px 10px; border-bottom: 2px solid var(--blue); }
  table.grid td { padding: 7px 10px; border-bottom: 1px solid var(--border-light); vertical-align: middle; }
  table.grid tbody tr:nth-child(even) td { background: var(--row-alt); }
  table.grid input { width: 100%; height: 26px; border: 1px solid var(--border); border-radius: 0; padding: 3px 7px; font: 12px inherit; font-family: inherit; color: var(--text); background: #fff; }
  table.grid input:focus { outline: 0; border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue); }
  table.grid input.num { text-align: right; max-width: 140px; }
  .unit { color: var(--muted); margin-left: 6px; }
  .cell-inline { display: flex; align-items: center; }
  .pill { display: inline-block; background: var(--green); color: #fff; border-radius: 9px; padding: 1px 8px; font-size: 11px; font-weight: 600; margin: 1px 2px 1px 0; }
  .pill.grey { background: #9e9e9e; }
  .remove { color: var(--red); background: none; border: 0; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; }
  .actions { display: flex; gap: 6px; align-items: center; margin-top: 14px; }
  .hint { color: var(--muted); font-size: 12px; margin: 6px 0 0; }
  pre.snippet { background: #f7f7f7; border: 1px solid var(--border-light); padding: 12px 14px; font: 12px/1.5 Menlo, Consolas, monospace; overflow-x: auto; margin: 8px 0 0; white-space: pre; }
  .token-box { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .token-box input { flex: 1; height: 28px; border: 1px solid var(--green); padding: 3px 8px; font: 12px Menlo, Consolas, monospace; }
  .empty { color: var(--muted); padding: 14px 10px; }
  .muted { color: var(--muted); }
  .loading { color: var(--muted); padding: 30px 0; }
</style>
</head>
<body>
  <div class="topbar">
    <h1>L-Code Loyalty Pricing Engine</h1>
  </div>

  <div id="flash"></div>

  <div class="tabs" role="tablist">
    <button class="tab active" data-tab="overview" role="tab">Přehled</button>
    <button class="tab" data-tab="tiers" role="tab">Věrnostní hladiny</button>
    <button class="tab" data-tab="rules" role="tab">Pravidla a ochrana marže</button>
    <button class="tab" data-tab="mcp" role="tab">AI agent (MCP)</button>
  </div>

  <div id="loading" class="loading">Načítám…</div>

  <section class="panel" id="panel-overview">
    <div class="section-title">Stav instalace</div>
    <div class="form-row"><span class="label">E-shop ID</span><span class="value" id="ov-shop"></span></div>
    <div class="form-row"><span class="label">Adresa e-shopu</span><span class="value" id="ov-url"></span></div>
    <div class="form-row"><span class="label">Stav doplňku</span><span class="value" id="ov-state"></span></div>
    <div class="form-row"><span class="label">Nainstalováno</span><span class="value" id="ov-created"></span></div>
    <div class="form-row"><span class="label">Poslední změna instalace</span><span class="value" id="ov-updated"></span></div>
    <div class="form-row"><span class="label">Kontaktní e-mail</span><span class="value" id="ov-email"></span></div>
    <div class="section-title">Souhrn</div>
    <div class="form-row"><span class="label">Věrnostní hladiny</span><span class="value" id="ov-tiers"></span></div>
    <div class="form-row"><span class="label">Ochrana marže (Circuit Breaker)</span><span class="value" id="ov-rules"></span></div>
    <div class="form-row"><span class="label">Aktivní MCP tokeny</span><span class="value" id="ov-tokens"></span></div>
    <div class="form-row"><span class="label">Synchronizace cen</span><span class="value">Ceny se do Shoptetu zapisují vždy s DPH a explicitní sazbou (<code>includingVat</code> + <code>vatRate</code>).</span></div>
  </section>

  <section class="panel" id="panel-tiers">
    <div class="section-title">Věrnostní hladiny</div>
    <table class="grid">
      <thead><tr><th style="width:38%">Název hladiny</th><th>Sleva</th><th>Obrat od</th><th style="width:40px"></th></tr></thead>
      <tbody id="tiers-body"></tbody>
    </table>
    <p class="hint">Zákazník dostane slevu nejvyšší hladiny, jejíhož obratu dosáhl. Je-li akční cena produktu nižší než věrnostní, platí akční cena.</p>
    <div class="actions">
      <button class="btn btn-green" id="tiers-save">Uložit hladiny</button>
      <button class="btn btn-blue" id="tiers-add">Přidat hladinu</button>
      <span class="muted" id="tiers-version"></span>
    </div>
  </section>

  <section class="panel" id="panel-rules">
    <div class="section-title">Ochrana marže a mantinely</div>
    
    <div class="form-row">
      <label for="rule-circuit-breaker"><strong>Maximální celková sleva (Circuit Breaker)</strong></label>
      <div class="cell-inline">
        <input type="number" id="rule-circuit-breaker" class="num" min="1" max="90" step="0.5" style="width:90px;height:26px;border:1px solid var(--border);padding:3px 7px;">
        <span class="unit">%</span>
      </div>
    </div>
    <div class="form-row">
      <div></div>
      <p class="hint" style="margin:0 0 10px;">Bezpečnostní strop marže: žádný produkt nesmí po věrnostní slevě klesnout pod tuto maximální hranici slevy.</p>
    </div>

    <div class="form-row">
      <label for="rule-coupon-lock"><strong>Kupónový zámek nad</strong></label>
      <div class="cell-inline">
        <input type="number" id="rule-coupon-lock" class="num" min="0" max="100" step="1" style="width:90px;height:26px;border:1px solid var(--border);padding:3px 7px;">
        <span class="unit">%</span>
      </div>
    </div>
    <div class="form-row">
      <div></div>
      <p class="hint" style="margin:0 0 10px;">Zamezení kumulace: dosáhne-li zákazník věrnostní hladiny rovné nebo vyšší než toto procento, košík zablokuje další slevový kupón.</p>
    </div>

    <div class="section-title">Automatizace a košík</div>

    <div class="form-row">
      <label for="rule-self-healing"><strong>Self-Healing synchronizace</strong></label>
      <div>
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
          <input type="checkbox" id="rule-self-healing" style="width:16px;height:16px;cursor:pointer;">
          <span>Automaticky vyřadit neexistující SKU bez pádu celé dávky</span>
        </label>
      </div>
    </div>

    <div class="form-row">
      <label for="rule-vip-cart"><strong>VIP dynamický košík (vip_cart.js)</strong></label>
      <div>
        <label style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;">
          <input type="checkbox" id="rule-vip-cart" style="width:16px;height:16px;cursor:pointer;">
          <span>Zobrazovat dosaženou hladinu a ušetřenou částku v košíku Shoptetu</span>
        </label>
      </div>
    </div>

    <div class="form-row">
      <span class="label">Pravidlo vítězné ceny</span>
      <div class="value" style="color:var(--green);font-weight:600;">
        ✓ Aktivní v enginu (akční cena produktu má vždy přednost před věrnostní slevou)
      </div>
    </div>

    <div class="actions" style="margin-top:20px;">
      <button class="btn btn-green" id="rules-save">Uložit pravidla</button>
      <span class="muted" id="rules-version"></span>
    </div>
  </section>

  <section class="panel" id="panel-mcp">
    <div class="section-title">Přístup pro AI agenta</div>
    <p style="margin:0 0 10px">Připojte Claude Desktop, Cursor nebo jiného MCP klienta a spravujte hladiny a ceny přirozeným jazykem.</p>
    <table class="grid">
      <thead><tr><th>Token</th><th>Vytvořen</th><th>Oprávnění</th></tr></thead>
      <tbody id="tokens-body"></tbody>
    </table>
    <div class="actions">
      <button class="btn btn-blue" id="token-new">Vygenerovat nový token</button>
      <span class="muted">Vygenerováním se všechny dosavadní tokeny zneplatní.</span>
    </div>
    <div id="token-result"></div>
    <div class="section-title">Konfigurace klienta</div>
    <p style="margin:0">Vložte do <code>claude_desktop_config.json</code> (Mac: <code>~/Library/Application Support/Claude/</code>, Windows: <code>%APPDATA%\\Claude\\</code>):</p>
    <pre class="snippet" id="mcp-snippet"></pre>
  </section>

<script nonce="${nonce}">
(() => {
  const BOOT = ${boot};
  const $ = id => document.getElementById(id);
  let state = null;

  function resize() {
    window.parent.postMessage({ action: 'shoptet.resize', height: document.documentElement.scrollHeight }, '*');
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
    if (res.status === 401) throw new Error('Platnost přihlášení vypršela. Otevřete doplněk znovu z administrace Shoptetu.');
    if (!res.ok) throw new Error(data.error || ('Chyba serveru (' + res.status + ').'));
    return data;
  }

  const fmtDate = s => {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const stateLabel = { active: 'Aktivní', pending: 'Čeká na aktivaci', suspended: 'Pozastaveno', uninstalled: 'Odinstalováno' };

  /* tabs */
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + btn.dataset.tab));
    resize();
  }));

  /* overview */
  function renderOverview() {
    const i = state.installation || {};
    $('ov-shop').textContent = state.shopId;
    $('ov-url').textContent = i.eshop_url || '—';
    const st = document.createElement('span');
    st.className = 'pill' + (i.state === 'active' ? '' : ' grey');
    st.textContent = stateLabel[i.state] || i.state || 'Neznámý';
    $('ov-state').replaceChildren(st);
    $('ov-created').textContent = fmtDate(i.created_at);
    $('ov-updated').textContent = fmtDate(i.updated_at);
    $('ov-email').textContent = i.contact_email || '—';
    $('ov-tiers').textContent = state.tiers.length ? state.tiers.length + ' hladin (verze ' + state.version + ')' : 'Zatím nenastaveny';
    const r = state.rules || {};
    $('ov-rules').textContent = 'Strop max ' + (r.circuitBreakerMaxPercent ?? 30) + ' %, kupónový zámek ' + (r.couponLockAbovePercent ?? 20) + ' %';
    $('ov-tokens').textContent = String(state.mcpTokens.length);
  }

  /* rules */
  function renderRules() {
    const r = state.rules || {};
    $('rule-circuit-breaker').value = r.circuitBreakerMaxPercent ?? 30;
    $('rule-coupon-lock').value = r.couponLockAbovePercent ?? 20;
    $('rule-self-healing').checked = r.selfHealingBatch !== false;
    $('rule-vip-cart').checked = r.vipCartDynamic !== false;
    $('rules-version').textContent = state.version ? 'Verze nastavení: ' + state.version : '';
  }
  $('rules-save').addEventListener('click', async () => {
    const rules = {
      circuitBreakerMaxPercent: Number($('rule-circuit-breaker').value),
      couponLockAbovePercent: Number($('rule-coupon-lock').value),
      selfHealingBatch: $('rule-self-healing').checked,
      vipCartDynamic: $('rule-vip-cart').checked
    };
    const btn = $('rules-save');
    btn.disabled = true;
    try {
      const res = await api('/rules', { method: 'PUT', body: JSON.stringify({ rules, version: state.version }) });
      state.rules = res.rules; state.version = res.version;
      renderRules(); renderOverview();
      flash('Pravidla a ochrana marže byly uloženy.');
    } catch (e) { flash(e.message, 'error'); }
    finally { btn.disabled = false; resize(); }
  });

  /* tiers */
  function tierRow(t = { name: '', percent: '', minTurnover: '' }) {
    const tr = document.createElement('tr');
    const mk = (cls, val, type, unit, attrs = {}) => {
      const td = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'cell-inline';
      const inp = document.createElement('input');
      inp.type = type; inp.className = cls; inp.value = val;
      Object.entries(attrs).forEach(([k, v]) => inp.setAttribute(k, v));
      wrap.append(inp);
      if (unit) { const u = document.createElement('span'); u.className = 'unit'; u.textContent = unit; wrap.append(u); }
      td.append(wrap);
      return td;
    };
    tr.append(
      mk('name', t.name, 'text', '', { maxlength: '60', placeholder: 'např. VIP Zlato' }),
      mk('num percent', t.percent, 'number', '%', { min: '0.01', max: '100', step: '0.01' }),
      mk('num turnover', t.minTurnover, 'number', 'Kč', { min: '0', step: '1' })
    );
    const td = document.createElement('td');
    const rm = document.createElement('button');
    rm.className = 'remove'; rm.title = 'Odebrat'; rm.textContent = '×';
    rm.addEventListener('click', () => { tr.remove(); if (!$('tiers-body').children.length) emptyTiers(); resize(); });
    td.append(rm);
    tr.append(td);
    return tr;
  }
  function emptyTiers() {
    const tr = document.createElement('tr'); tr.className = 'empty-row';
    const td = document.createElement('td'); td.colSpan = 4; td.className = 'empty';
    td.textContent = 'Zatím žádné hladiny. Klikněte na „Přidat hladinu“.';
    tr.append(td); $('tiers-body').append(tr);
  }
  function renderTiers() {
    const body = $('tiers-body');
    body.textContent = '';
    if (!state.tiers.length) emptyTiers();
    state.tiers.forEach(t => body.append(tierRow(t)));
    $('tiers-version').textContent = state.version ? 'Verze nastavení: ' + state.version : '';
  }
  $('tiers-add').addEventListener('click', () => {
    const body = $('tiers-body');
    body.querySelector('.empty-row')?.remove();
    if (body.children.length >= 10) return flash('Maximálně 10 hladin.', 'warn');
    const row = tierRow();
    body.append(row);
    row.querySelector('input').focus();
    resize();
  });
  $('tiers-save').addEventListener('click', async () => {
    const rows = [...$('tiers-body').querySelectorAll('tr:not(.empty-row)')];
    const tiers = rows.map(r => ({
      name: r.querySelector('.name').value,
      percent: r.querySelector('.percent').value === '' ? NaN : Number(r.querySelector('.percent').value),
      minTurnover: r.querySelector('.turnover').value === '' ? NaN : Number(r.querySelector('.turnover').value)
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

  /* mcp */
  function snippet(token) {
    return JSON.stringify({ mcpServers: { 'shoptet-pricing': { command: 'npx', args: ['-y', 'mcp-remote', state.mcpEndpoint, '--header', 'Authorization: Bearer ' + (token || '<VÁŠ_TOKEN>')] } } }, null, 2);
  }
  function renderTokens() {
    const body = $('tokens-body');
    body.textContent = '';
    if (!state.mcpTokens.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td');
      td.colSpan = 3; td.className = 'empty'; td.textContent = 'Žádný aktivní token.';
      tr.append(td); body.append(tr);
    }
    state.mcpTokens.forEach(t => {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.innerHTML = '<code></code>'; a.firstChild.textContent = 'lcode_mcp_…  (' + t.fingerprint + ')';
      const b = document.createElement('td'); b.textContent = fmtDate(t.createdAt);
      const c = document.createElement('td');
      (t.scopes || []).forEach(s => { const p = document.createElement('span'); p.className = 'pill'; p.textContent = s; c.append(p); });
      tr.append(a, b, c); body.append(tr);
    });
    $('mcp-snippet').textContent = snippet(null);
  }
  $('token-new').addEventListener('click', async () => {
    if (state.mcpTokens.length && !confirm('Vygenerovat nový token? Všechny dosavadní tokeny přestanou fungovat.')) return;
    const btn = $('token-new'); btn.disabled = true;
    try {
      const res = await api('/mcp-token', { method: 'POST', body: '{}' });
      const fresh = await api('/state');
      state = fresh; renderTokens(); renderOverview();
      const box = $('token-result'); box.textContent = '';
      const al = document.createElement('div'); al.className = 'alert'; al.style.marginTop = '14px';
      const icon = document.createElement('span'); icon.className = 'alert-icon'; icon.textContent = '✓';
      const inner = document.createElement('div'); inner.style.flex = '1';
      inner.append('Token byl vytvořen. Zkopírujte si ho hned – znovu už zobrazit nepůjde.');
      const tb = document.createElement('div'); tb.className = 'token-box';
      const inp = document.createElement('input'); inp.readOnly = true; inp.value = res.token;
      const cp = document.createElement('button'); cp.className = 'btn btn-green'; cp.textContent = 'Kopírovat';
      cp.addEventListener('click', () => { inp.select(); navigator.clipboard?.writeText(res.token).then(() => { cp.textContent = 'Zkopírováno'; }).catch(() => document.execCommand('copy')); });
      tb.append(inp, cp); inner.append(tb);
      al.append(icon, inner); box.append(al);
      $('mcp-snippet').textContent = snippet(res.token);
    } catch (e) { flash(e.message, 'error'); }
    finally { btn.disabled = false; resize(); }
  });

  /* boot */
  (async () => {
    try {
      state = await api('/state');
      $('loading').remove();
      $('panel-overview').classList.add('active');
      renderOverview(); renderTiers(); renderRules(); renderTokens();
      if (BOOT.mode === 'preview') flash('Náhledový režim (bez přihlášení přes Shoptet).', 'warn');
    } catch (e) {
      $('loading').textContent = '';
      flash(e.message, 'error');
    }
    resize();
  })();
})();
</script>
</body>
</html>`, { status: 200, headers: htmlHeaders(nonce) });
}

export async function handleAdminSettingsIframe(request, env) {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  if (!env.DB) return renderErrorPage('db_not_bound', 503);
  const auth = await authorizeSettingsPage(request, env);
  if (auth.error) return renderErrorPage(auth.error, auth.status);
  return renderApp(auth);
}
