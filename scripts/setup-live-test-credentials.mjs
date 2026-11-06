import { createTokenVault } from '../packages/core/src/token-vault.mjs';
import { digest } from '../packages/core/src/crypto.mjs';
import { execSync } from 'node:child_process';

const TOKEN_KEYS = {
  active: 'v1',
  keys: {
    v1: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  }
};

const SHOP_ID = process.env.SHOPTET_SHOP_ID || '826800';
const OAUTH_TOKEN = process.env.SHOPTET_TEST_OAUTH_TOKEN || '';
const SIGNATURE_KEY = process.env.SHOPTET_TEST_SIGNATURE_KEY || '';

async function main() {
  const vault = createTokenVault(TOKEN_KEYS);
  const oauthEnvelope = await vault.seal(SHOP_ID, 'oauth', OAUTH_TOKEN);
  const webhookEnvelope = await vault.seal(SHOP_ID, 'webhook', SIGNATURE_KEY);
  const oauthSha256 = await digest(oauthEnvelope);

  console.log('Sealed envelopes successfully.');

  const configJson = JSON.stringify({
    tiers: [
      { name: 'VIP Bronz', percent: 5, minTurnover: 2000, pricelistId: 2 },
      { name: 'VIP Stříbro', percent: 10, minTurnover: 5000, pricelistId: 2 },
      { name: 'VIP Zlato', percent: 15, minTurnover: 10000, pricelistId: 2 },
      { name: 'VIP Platina', percent: 20, minTurnover: 25000, pricelistId: 2 }
    ],
    turnoverPolicy: {
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
    },
    brandCaps: {},
    categoryCaps: {},
    productCaps: {}
  });

  const sqlStatements = [
    `UPDATE shoptet_oauth SET oauth_envelope = '${oauthEnvelope}', oauth_access_token = '', cached_api_token = NULL WHERE shop_id = '${SHOP_ID}';`,
    `INSERT INTO shop_webhook_credentials (shop_id, oauth_sha256, envelope, created_at) VALUES ('${SHOP_ID}', '${oauthSha256}', '${webhookEnvelope}', unixepoch()) ON CONFLICT(shop_id) DO UPDATE SET oauth_sha256 = excluded.oauth_sha256, envelope = excluded.envelope;`,
    `INSERT INTO loyalty_pricelist_policies (shop_id, default_pricelist_id, managed_pricelists_json, protected_pricelists_json, updated_at) VALUES ('${SHOP_ID}', 1, '[2]', '[5]', unixepoch()) ON CONFLICT(shop_id) DO UPDATE SET default_pricelist_id = 1, managed_pricelists_json = '[2]', protected_pricelists_json = '[5]';`,
    `UPDATE tenant_settings SET config_json = '${configJson.replace(/'/g, "''")}' WHERE shop_id = '${SHOP_ID}';`
  ];

  for (const sql of sqlStatements) {
    console.log('Executing:', sql.slice(0, 80) + '...');
    execSync(`npx wrangler d1 execute lcode-shoptet-pricing-dev --remote --command="${sql.replace(/"/g, '\\"')}"`, {
      stdio: 'inherit'
    });
  }

  console.log('All credentials and policies configured successfully on remote D1.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
