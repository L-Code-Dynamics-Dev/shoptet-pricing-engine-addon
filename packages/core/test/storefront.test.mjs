import test from 'node:test';
import assert from 'node:assert/strict';
import { STOREFRONT_FILE_NAMES, getStorefrontAssets } from '../../storefront/src/index.mjs';
import { formatPrice, parsePrice, getLang, translate, isCouponLocked } from '../../storefront/src/shared.mjs';
import { handleStorefrontRoutes } from '../../../apps/api/src/storefront-routes.mjs';

test('storefront assets exist and have no shop-specific hardcoding', () => {
  const assets = getStorefrontAssets();
  assert.equal(Object.keys(assets).length, 5);

  for (const name of STOREFRONT_FILE_NAMES) {
    const code = assets[name];
    assert.ok(code && typeof code === 'string', `${name} should be a non-empty string`);

    // Must be completely free of Okfish branding or hardcoded store logic
    assert.doesNotMatch(code, /okfish/i, `${name} contains "okfish"`);
    assert.doesNotMatch(code, /ryb[aá]rsk[aá]\s+str[aá][zž]/i, `${name} contains "rybárska stráž"`);
    assert.doesNotMatch(code, /logo-fish/i, `${name} contains "logo-fish"`);
    assert.doesNotMatch(code, /88BA15/i, `${name} contains Okfish green hex "#88BA15"`);
    assert.doesNotMatch(code, /\+\s*['"]\s*€['"]/, `${name} contains hardcoded ' €' string concatenation`);
  }
});

test('formatPrice handles various currencies, separators and positions', () => {
  // 1. Shoptet native helper
  const shoptetNative = {
    helpers: {
      formatPrice: (val) => `${val.toFixed(2)} NATIVE`
    }
  };
  assert.equal(formatPrice(1234.56, shoptetNative), '1234.56 NATIVE');

  // 2. Default CZK (Czech)
  const shoptetCzk = {
    currency: {
      symbol: 'Kč',
      decimalPlaces: 2,
      decimalSeparator: ',',
      thousandSeparator: ' ',
      symbolPosition: 'right'
    }
  };
  assert.equal(formatPrice(1234.5, shoptetCzk), '1 234,50 Kč');
  assert.equal(formatPrice(99, shoptetCzk), '99,00 Kč');

  // 3. EUR with left symbol
  const shoptetEurLeft = {
    currency: {
      symbol: '€',
      decimalPlaces: 2,
      decimalSeparator: ',',
      thousandSeparator: '.',
      symbolPosition: 'left'
    }
  };
  assert.equal(formatPrice(5432.1, shoptetEurLeft), '€ 5.432,10');

  // 4. Zero decimal places (e.g. HUF or rounded CZK)
  const shoptetZeroDec = {
    currency: {
      symbol: 'Kč',
      decimalPlaces: 0,
      decimalSeparator: ',',
      thousandSeparator: ' ',
      symbolPosition: 'right'
    }
  };
  assert.equal(formatPrice(1500, shoptetZeroDec), '1 500 Kč');

  // 5. Invalid values
  assert.equal(formatPrice(null, shoptetCzk), '');
  assert.equal(formatPrice(NaN, shoptetCzk), '');
});

test('parsePrice correctly parses mixed prices and currency labels', () => {
  assert.equal(parsePrice('1 234,50 Kč'), 1234.5);
  assert.equal(parsePrice('99,00 €'), 99.0);
  assert.equal(parsePrice('$ 1,250.75'), 1250.75);
  assert.equal(parsePrice('Súčet: 45,90 €'), 45.9);
  assert.equal(parsePrice('Cena celkem: 1 500 Kč'), 1500);
  assert.equal(parsePrice('12.99'), 12.99);
  assert.ok(Number.isNaN(parsePrice('')));
  assert.ok(Number.isNaN(parsePrice('Žádná cena')));
});

test('i18n and translations match Czech, Slovak, and English', () => {
  assert.equal(getLang({ config: { language: 'cs' } }), 'cs');
  assert.equal(getLang({ config: { language: 'sk' } }), 'sk');
  assert.equal(getLang({ config: { language: 'en' } }), 'en');
  assert.equal(getLang(null, { lang: 'sk' }), 'sk');

  assert.equal(translate('save', { config: { language: 'cs' } }), 'Ušetříte');
  assert.equal(translate('save', { config: { language: 'sk' } }), 'Ušetríte');
  assert.equal(translate('save', { config: { language: 'en' } }), 'Save');

  assert.match(translate('couponLocked', { config: { language: 'cs' } }), /věrnostní slevu/);
  assert.match(translate('couponLocked', { config: { language: 'sk' } }), /vernostnú zľavu/);
});

test('isCouponLocked evaluates rules accurately', () => {
  const config = {
    topTiers: true,
    minPercent: 15,
    lockedTiers: ['VIP20', 'VIP25'],
    allTiers: [
      { name: 'VIP5', percent: 5 },
      { name: 'VIP10', percent: 10 },
      { name: 'VIP15', percent: 15 },
      { name: 'VIP20', percent: 20 },
      { name: 'VIP25', percent: 25 }
    ]
  };

  // Locked explicitly by name
  assert.equal(isCouponLocked({ tier: 'VIP20', discountPct: 20, config }), true);
  assert.equal(isCouponLocked({ tier: 'VIP25', discountPct: 25, config }), true);

  // Locked by minPercent (15%)
  assert.equal(isCouponLocked({ tier: 'VIP15', discountPct: 15, config }), true);
  assert.equal(isCouponLocked({ tier: 'CustomTier', discountPct: 16, config }), true);

  // Not locked (below 15% and not top tier)
  assert.equal(isCouponLocked({ tier: 'VIP5', discountPct: 5, config }), false);
  assert.equal(isCouponLocked({ tier: 'VIP10', discountPct: 10, config }), false);

  // Guest / unauthenticated (no tier and 0 discount)
  assert.equal(isCouponLocked({ tier: null, discountPct: 0, config }), false);
});

test('storefront API routes serve assets and coupon config', async () => {
  // Test DB mock
  const mockDb = {
    prepare(query) {
      return {
        bind(shopId) {
          return {
            async first() {
              if (shopId === 'shop-test') {
                return {
                  config_json: JSON.stringify({
                    tiers: [
                      { name: 'Bronz', percent: 5, minTurnover: 1000 },
                      { name: 'Stříbro', percent: 10, minTurnover: 5000 },
                      { name: 'Zlato', percent: 20, minTurnover: 15000 }
                    ],
                    rules: {
                      couponLockTopTiers: true,
                      couponLockMinPercent: 15
                    }
                  })
                };
              }
              return null;
            }
          };
        }
      };
    }
  };

  const env = { DB: mockDb };

  // 1. Serving asset vip_cart.js
  const reqAsset = new Request('https://test.workers.dev/storefront/assets/vip_cart.js');
  const resAsset = await handleStorefrontRoutes(reqAsset, env);
  assert.equal(resAsset.status, 200);
  assert.equal(resAsset.headers.get('content-type'), 'application/javascript; charset=utf-8');
  const assetBody = await resAsset.text();
  assert.ok(assetBody.includes('vip-cart-total-savings'));

  // 2. Non-existent asset
  const reqBadAsset = new Request('https://test.workers.dev/storefront/assets/unknown.js');
  const resBadAsset = await handleStorefrontRoutes(reqBadAsset, env);
  assert.equal(resBadAsset.status, 404);

  // 3. Coupon config with shop-test
  const reqConfig = new Request('https://test.workers.dev/v1/coupon-config?shopId=shop-test');
  const resConfig = await handleStorefrontRoutes(reqConfig, env);
  assert.equal(resConfig.status, 200);
  const configBody = await resConfig.json();
  assert.equal(configBody.shopId, 'shop-test');
  assert.equal(configBody.minPercent, 15);
  assert.equal(configBody.topTiers, true);
  // Zlato has 20% (>= 15% and top tier), so it must be locked
  assert.ok(configBody.lockedTiers.includes('Zlato'));
});
