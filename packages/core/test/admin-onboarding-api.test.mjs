import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession } from '../../../apps/api/src/admin-session.mjs';
import { handleAdminSettingsApi } from '../../../apps/api/src/iframe-settings.mjs';

const SECRET = 's'.repeat(48);

function fakeEnv({ shopId = '826800', installed = true, config = null, version = 1, adapterData = {} } = {}) {
  const db = {
    config,
    version,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql,
            args,
            async first() {
              if (sql.includes('FROM installations i') && sql.includes('LEFT JOIN shoptet_oauth')) {
                if (!installed || args[0] !== shopId) return null;
                return {
                  shop_id: shopId,
                  state: 'active',
                  eshop_url: `https://${shopId}.myshoptet.com/`,
                  created_at: '2026-11-05 15:38:10',
                  updated_at: '2026-11-05 16:54:45',
                  contact_email: 'admin@shop.cz'
                };
              }
              if (sql.includes('SELECT state FROM installations')) {
                if (!installed || args[0] !== shopId) return null;
                return { state: 'active' };
              }
              if (sql.includes('FROM tenant_settings')) {
                return db.config ? { config_json: JSON.stringify(db.config), version: db.version } : null;
              }
              if (sql.includes('FROM encrypted_shoptet_tokens')) {
                return { access_token: 'fake-access-token' };
              }
              return null;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO tenant_settings')) {
                db.config = JSON.parse(args[1]);
                db.version += 1;
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };

  return {
    ADMIN_SESSION_SECRET: SECRET,
    DB: db,
    SHOPTET_TOKEN_KEYS: 'k'.repeat(64)
  };
}

async function authReq(path, { method = 'GET', body = null, token = null } = {}) {
  const sessionToken = token || (await issueSession('826800', SECRET));
  const headers = {
    Authorization: 'Bearer ' + sessionToken,
    Origin: 'https://admin.example.com',
    'Content-Type': 'application/json'
  };
  return new Request('https://admin.example.com/admin/settings/api' + path, {
    method,
    headers,
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {})
  });
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

test('GET /onboarding/periods returns all 6 rolling periods', async () => {
  const env = fakeEnv();
  const req = await authReq('/onboarding/periods');
  const res = await handleAdminSettingsApi(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.periods.length, 6);
  assert.ok(data.periods.some(p => p.id === '7_days'));
  assert.ok(data.periods.some(p => p.id === '1_month'));
  assert.ok(data.periods.some(p => p.id === '3_months'));
  assert.ok(data.periods.some(p => p.id === '6_months'));
  assert.ok(data.periods.some(p => p.id === '12_months'));
  assert.ok(data.periods.some(p => p.id === 'all_time'));
});

test('GET /onboarding/retention-policies returns 4 retention policies', async () => {
  const env = fakeEnv();
  const req = await authReq('/onboarding/retention-policies');
  const res = await handleAdminSettingsApi(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.policies.length, 4);
  assert.ok(data.policies.some(p => p.id === 'permanent'));
  assert.ok(data.policies.some(p => p.id === 'rolling_turnover'));
  assert.ok(data.policies.some(p => p.id === 'inactivity_drop_one'));
  assert.ok(data.policies.some(p => p.id === 'inactivity_drop_base'));
});

test('POST /onboarding/validate validates onboarding configuration', async () => {
  const env = fakeEnv();
  
  // Valid
  const validReq = await authReq('/onboarding/validate', {
    method: 'POST',
    body: {
      period: '6_months',
      retentionPolicy: 'permanent',
      tiers: [
        { name: 'Úroveň 1', percent: 5, minTurnover: 0 },
        { name: 'Úroveň 2', percent: 10, minTurnover: 10000 }
      ]
    }
  });
  const validRes = await handleAdminSettingsApi(validReq, env);
  assert.equal(validRes.status, 200);
  const validData = await validRes.json();
  assert.equal(validData.valid, true);

  // Invalid (missing inactivityDays for inactivity_drop_one)
  const invalidReq = await authReq('/onboarding/validate', {
    method: 'POST',
    body: {
      period: '6_months',
      retentionPolicy: 'inactivity_drop_one',
      tiers: [{ name: 'VIP', percent: 5, minTurnover: 0 }]
    }
  });
  const invalidRes = await handleAdminSettingsApi(invalidReq, env);
  assert.equal(invalidRes.status, 400);
  const invalidData = await invalidRes.json();
  assert.equal(invalidData.error, 'validation_failed');
});

test('GET /state includes onboarding config and periods', async () => {
  const env = fakeEnv({
    config: {
      tiers: [{ name: 'Stříbrná', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 }],
      onboarding: {
        completedAt: '2026-11-07T10:00:00.000Z',
        period: '3_months',
        retentionPolicy: 'inactivity_drop_one',
        inactivityDays: 90,
        warningDays: 14
      }
    }
  });

  const req = await authReq('/state');
  const res = await handleAdminSettingsApi(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.tiers.length, 1);
  assert.equal(data.tiers[0].customerGroupId, 100);
  assert.equal(data.onboarding.period, '3_months');
  assert.equal(data.onboarding.retentionPolicy, 'inactivity_drop_one');
  assert.equal(data.periods.length, 6);
  assert.equal(data.retentionPolicies.length, 4);
});
