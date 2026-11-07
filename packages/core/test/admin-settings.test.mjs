import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, verifySession, verifyShoptetAdmin, authorizeSettingsPage, timingSafeEqual } from '../../../apps/api/src/admin-session.mjs';
import { validateTiers, validateRules, handleAdminSettingsApi, handleAdminSettingsIframe } from '../../../apps/api/src/iframe-settings.mjs';

const SECRET = 's'.repeat(48);

function fakeDb({ installed = true, config = null, version = 1 } = {}) {
  const calls = [];
  const db = {
    calls,
    config, version,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            async first() {
              calls.push({ sql, args });
              if (sql.includes('FROM installations i') && sql.includes('LEFT JOIN shoptet_oauth')) {
                if (!installed || args[0] !== '826800') return null;
                return { shop_id: '826800', state: 'active', eshop_url: 'https://826800.myshoptet.com/', created_at: '2026-11-05 15:38:10', updated_at: '2026-11-05 16:54:45', contact_email: 'a@b.cz' };
              }
              if (sql.includes('FROM tenant_settings')) return db.config ? { config_json: JSON.stringify(db.config), version: db.version } : null;
              return null;
            },
            async all() { calls.push({ sql, args }); return { results: [] }; },
            async run() {
              calls.push({ sql, args });
              if (sql.startsWith('UPDATE tenant_settings')) {
                if (args[2] !== db.version) return { meta: { changes: 0 } };
                db.config = JSON.parse(args[0]); db.version += 1;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    },
    async batch(stmts) { stmts.forEach(s => calls.push({ sql: s.sql, args: s.args })); return []; }
  };
  return db;
}

test('session round-trip and tamper/expiry rejection', async () => {
  const now = 1_800_000_000;
  const t = await issueSession('826800', SECRET, now);
  assert.deepEqual((await verifySession(t, SECRET, now + 10)).shopId, '826800');
  assert.equal(await verifySession(t, SECRET, now + 3 * 3600), null);
  assert.equal(await verifySession(t, 'x'.repeat(48), now), null);
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ s: '999', e: now + 999 })).toString('base64url');
  assert.equal(await verifySession(`${forged}.${s}`, SECRET, now), null);
  assert.equal(await verifySession(p, SECRET, now), null);
});

test('session requires strong secret', async () => {
  await assert.rejects(() => issueSession('826800', 'short'));
});

test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('admin verification exchanges code and requires matching project id', async () => {
  const env = { DB: fakeDb(), SHOPTET_CLIENT_ID: 'cid', SHOPTET_CLIENT_SECRET: 'sec' };
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, opts });
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    return new Response(JSON.stringify({ data: { project: { id: 826800 } } }), { status: 200 });
  };
  const ok = await verifyShoptetAdmin({ code: 'abcdefgh123', shopId: '826800', env, redirectUri: 'https://w.dev/admin/settings', fetchImpl });
  assert.deepEqual(ok, { ok: true });
  assert.equal(seen[0].url, 'https://826800.myshoptet.com/action/OAuthServer/token');
  const body = new URLSearchParams(seen[0].opts.body);
  assert.equal(body.get('scope'), 'basic_eshop');
  assert.equal(body.get('redirect_uri'), 'https://w.dev/admin/settings');
  assert.equal(seen[1].opts.headers.Authorization, 'Bearer tok');

  const mismatch = async url => url.endsWith('/token')
    ? new Response(JSON.stringify({ access_token: 'tok' }))
    : new Response(JSON.stringify({ data: { project: { id: 111 } } }));
  assert.equal((await verifyShoptetAdmin({ code: 'abcdefgh123', shopId: '826800', env, redirectUri: 'x', fetchImpl: mismatch })).reason, 'shop_mismatch');
});

test('admin verification fails closed', async () => {
  const env = { DB: fakeDb(), SHOPTET_CLIENT_ID: 'cid', SHOPTET_CLIENT_SECRET: 'sec' };
  const never = async () => { throw new Error('should not fetch'); };
  assert.equal((await verifyShoptetAdmin({ code: null, shopId: '826800', env, redirectUri: 'x', fetchImpl: never })).reason, 'missing_code');
  assert.equal((await verifyShoptetAdmin({ code: 'abcdefgh123', shopId: '1', env, redirectUri: 'x', fetchImpl: never })).reason, 'not_installed');
  const denied = async () => new Response('no', { status: 400 });
  assert.equal((await verifyShoptetAdmin({ code: 'abcdefgh123', shopId: '826800', env, redirectUri: 'x', fetchImpl: denied })).reason, 'token_exchange_400');
});

test('settings page without code is denied and leaks no token', async () => {
  const env = { DB: fakeDb(), ADMIN_SESSION_SECRET: SECRET, SHOPTET_CLIENT_ID: 'c', SHOPTET_CLIENT_SECRET: 's' };
  const res = await handleAdminSettingsIframe(new Request('https://w.dev/admin/settings?eshopId=826800'), env);
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.doesNotMatch(html, /lcode_mcp_|session/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors[^;]*myshoptet\.com/);
});

test('preview key grants session only with correct key', async () => {
  const env = { DB: fakeDb(), ADMIN_SESSION_SECRET: SECRET, ADMIN_PREVIEW_KEY: 'p'.repeat(40) };
  const bad = await authorizeSettingsPage(new Request('https://w.dev/admin/settings?eshopId=826800&preview=wrong'), env);
  assert.equal(bad.status, 403);
  const good = await authorizeSettingsPage(new Request(`https://w.dev/admin/settings?eshopId=826800&preview=${'p'.repeat(40)}`), env);
  assert.equal(good.shopId, '826800');
  assert.ok(await verifySession(good.session, SECRET));
});

test('tier validation', () => {
  const ok = validateTiers([{ name: 'Bronz', percent: 5, minTurnover: 2000, pricelistId: 2 }, { name: 'Zlato', percent: 0.29, minTurnover: 10000 }]);
  assert.ok(ok.tiers);
  assert.equal(ok.tiers[0].pricelistId, 2);
  assert.equal(ok.tiers[1].pricelistId, undefined);
  assert.match(validateTiers([]).error, /alespoň/);
  assert.match(validateTiers([{ name: 'A', percent: 5, minTurnover: 100 }, { name: 'B', percent: 6, minTurnover: 100 }]).error, /vyšší/);
  assert.match(validateTiers([{ name: 'A', percent: 0, minTurnover: 0 }]).error, /sleva/);
  assert.match(validateTiers([{ name: 'A', percent: 5, minTurnover: 1.5 }]).error, /obrat/);
  assert.match(validateTiers([{ name: 'A', percent: 5, minTurnover: 0 }, { name: 'a', percent: 6, minTurnover: 10 }]).error, /duplicit/);
  assert.match(validateTiers([{ name: 'A', percent: 5, minTurnover: 0, shopId: 'x' }]).error, /neznámá/);
  assert.match(validateTiers([{ name: 'A', percent: 5, minTurnover: 0, pricelistId: -5 }]).error, /ceník/);
});

test('rule validation', () => {
  const v = validateRules({
    couponLockTopTiers: true,
    couponLockMinPercent: 15,
    couponLockMaxRemaining: true,
    highestDiscountWins: true,
    postWriteVerify: true,
    brandLimits: { '123e4567-e89b-42d3-a456-426614174001': 10 },
    categoryLimits: { '123e4567-e89b-42d3-a456-426614174003': 5 },
    productLimits: { '123e4567-e89b-42d3-a456-426614174002': 0 }
  });
  assert.equal(v.rules.couponLockTopTiers, true);
  assert.equal(v.rules.couponLockMinPercent, 15);
  assert.equal(v.rules.highestDiscountWins, true);
  assert.deepEqual(v.rules.brandLimits, { '123e4567-e89b-42d3-a456-426614174001': 10 });
  assert.deepEqual(v.rules.categoryLimits, { '123e4567-e89b-42d3-a456-426614174003': 5 });
  assert.deepEqual(v.rules.productLimits, { '123e4567-e89b-42d3-a456-426614174002': 0 });

  const invalidPercent = validateRules({ couponLockMinPercent: 150 });
  assert.match(invalidPercent.error, /Hranice slevy/);

  const invalidCategory = validateRules({ categoryLimits: { 'bad-guid': 10 } });
  assert.match(invalidCategory.error, /Kategorii vyberte/);

  const invalidProduct = validateRules({ productLimits: { 'bad-guid': 10 } });
  assert.match(invalidProduct.error, /Produkt vyberte/);

  const invalidCouponMode = validateRules({ couponMode: 'invalid-mode' });
  assert.match(invalidCouponMode.error, /Neznámý režim kupónů/);

  const invalidCapPriority = validateRules({ capPriority: 'invalid-priority' });
  assert.match(invalidCapPriority.error, /Neznámá priorita stropů/);

  const invalidMargin = validateRules({ minMarginPercent: 100 });
  assert.match(invalidMargin.error, /Minimální marže musí být 0–99,99 %/);

  const validExtended = validateRules({
    couponMode: 'percent-ceiling',
    capPriority: 'most_restrictive',
    minMarginPercent: 20,
    scheduledPromotions: [{ code: 'SKU-1', discountPercent: 15, validFrom: '2026-11-01', validTo: '2026-11-30' }],
    brandPromotions: [{ brand: 'Delphin', discountPercent: 10, validFrom: '2026-11-01', validTo: '2026-11-30' }]
  });
  assert.equal(validExtended.rules.couponMode, 'percent-ceiling');
  assert.equal(validExtended.rules.capPriority, 'most_restrictive');
  assert.equal(validExtended.rules.minMarginPercent, 20);
  assert.equal(validExtended.rules.scheduledPromotions.length, 1);
  assert.equal(validExtended.rules.brandPromotions.length, 1);
});

async function apiReq(path, { method = 'GET', body, session, origin } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session}`;
  if (origin) headers.origin = origin;
  return new Request(`https://w.dev/admin/settings/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

test('api requires session and same origin', async () => {
  const env = { DB: fakeDb(), ADMIN_SESSION_SECRET: SECRET };
  assert.equal((await handleAdminSettingsApi(await apiReq('/state'), env)).status, 401);
  const session = await issueSession('826800', SECRET);
  assert.equal((await handleAdminSettingsApi(await apiReq('/state', { session, origin: 'https://evil.example' }), env)).status, 403);
  const ok = await handleAdminSettingsApi(await apiReq('/state', { session }), env);
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.shopId, '826800');
  assert.doesNotMatch(JSON.stringify(data), /oauth_access_token|token_sha256/);
});

test('tier save enforces optimistic version and keeps other config', async () => {
  const db = fakeDb({ config: { tiers: [], brandCaps: { X: 10 } }, version: 3 });
  const env = { DB: db, ADMIN_SESSION_SECRET: SECRET };
  const session = await issueSession('826800', SECRET);
  const tiers = [{ name: 'Bronz', percent: 5, minTurnover: 0 }];
  const stale = await handleAdminSettingsApi(await apiReq('/tiers', { method: 'PUT', session, body: { tiers, version: 2 } }), env);
  assert.equal(stale.status, 409);
  const ok = await handleAdminSettingsApi(await apiReq('/tiers', { method: 'PUT', session, body: { tiers, version: 3 } }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).version, 4);
  assert.deepEqual(db.config.brandCaps, { X: 10 });
  const invalid = await handleAdminSettingsApi(await apiReq('/tiers', { method: 'PUT', session, body: { tiers: [{ name: '', percent: 5, minTurnover: 0 }], version: 4 } }), env);
  assert.equal(invalid.status, 422);
});

test('rule save updates config and increments version', async () => {
  const db = fakeDb({ config: { tiers: [], rules: { couponLockTopTiers: true } }, version: 1 });
  const env = { DB: db, ADMIN_SESSION_SECRET: SECRET };
  const session = await issueSession('826800', SECRET);
  const rules = { couponLockTopTiers: true, couponLockMaxRemaining: true, highestDiscountWins: true, postWriteVerify: true, brandLimits: {} };
  const ok = await handleAdminSettingsApi(await apiReq('/rules', { method: 'PUT', session, body: { rules, version: 1 } }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).version, 2);
  assert.equal(db.config.rules.couponLockTopTiers, true);
  assert.deepEqual(db.config.rules.brandLimits, {});
});

test('mcp token is returned once, stored hashed and revokes previous', async () => {
  const db = fakeDb();
  const env = { DB: db, ADMIN_SESSION_SECRET: SECRET };
  const session = await issueSession('826800', SECRET);
  const res = await handleAdminSettingsApi(await apiReq('/mcp-token', { method: 'POST', session, body: {} }), env);
  const data = await res.json();
  assert.match(data.token, /^lcode_mcp_[a-f0-9]{48}$/);
  const insert = db.calls.find(c => c.sql.startsWith('INSERT INTO mcp_credentials'));
  assert.notEqual(insert.args[0], data.token);
  assert.match(insert.args[0], /^[a-f0-9]{64}$/);
  assert.equal(insert.args[1], '826800');
  assert.ok(!JSON.parse(insert.args[2]).includes('assets:install'));
  assert.ok(db.calls.some(c => c.sql.startsWith('UPDATE mcp_credentials SET revoked_at')));
});

test('reconciliation status and run endpoints execute separate price and coupon audits with AUTO OFF', async () => {
  const db = fakeDb({
    config: {
      tiers: [{ name: 'Bronz', percent: 10, minTurnover: 1000, pricelistId: 2 }],
      rules: { couponMode: 'fixed-amount', capPriority: 'hierarchy', couponLockTopTiers: false }
    },
    version: 1
  });
  const env = { DB: db, ADMIN_SESSION_SECRET: SECRET };
  const session = await issueSession('826800', SECRET);

  const statusBefore = await (await handleAdminSettingsApi(await apiReq('/reconciliation/status', { session }), env)).json();
  assert.equal(statusBefore.status, 'idle');
  assert.equal(statusBefore.remediationMode, 'OFF');
  assert.equal(statusBefore.autoRemediationEnabled, false);

  const runRes = await handleAdminSettingsApi(await apiReq('/reconciliation/run', {
    method: 'POST',
    session,
    body: {
      defaultPricelistId: 1,
      fullCatalogVerified: true,
      pagination: { isComplete: true, page: 1, pageCount: 1 },
      catalogProducts: [
        {
          guid: '123e4567-e89b-42d3-a456-426614174010',
          visibility: 'normal',
          variants: [
            {
              code: 'SKU-REC-1',
              visible: true,
              basePriceMinor: 100000,
              perPricelistPrices: {
                2: {
                  priceMinor: 90000,
                  sales: { discountCoupon: true, minPriceRatio: null }
                }
              }
            }
          ]
        }
      ]
    }
  }), env);

  assert.equal(runRes.status, 200);
  const runData = await runRes.json();
  assert.equal(runData.status, 'completed');
  assert.equal(runData.remediationMode, 'OFF');
  assert.equal(runData.autoRemediationEnabled, false);
  assert.equal(runData.lastReconciliation.priceReport.selfCheckPassed, true);
  assert.equal(runData.lastReconciliation.priceReport.counts.match, 1);
  assert.equal(runData.lastReconciliation.couponReport.selfCheckPassed, true);
  assert.equal(runData.lastReconciliation.couponReport.counts.match, 1);
});
