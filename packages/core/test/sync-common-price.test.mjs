import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPlan } from '../src/sync-planner.mjs';
import { matchesExpectedPrice } from '../src/sync-runner.mjs';

function createMockAdapter({
  sourcePricelistId = 1,
  targetPricelistId = 2,
  basePrice = '800.00',
  currency = 'CZK',
  targetPrice = '800.00',
  targetCommonPrice = null
} = {}) {
  const profile = {
    id: 101,
    name: 'Test E-shop',
    vatPayer: false,
    defaultPricelistId: 1,
    timezone: 'Europe/Prague',
    currencies: [{ code: currency, priceDecimalPlaces: 2, rounding: 'math' }]
  };

  const product = {
    guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed',
    name: 'Unisex hodinky Nature',
    visibility: 'normal',
    brand: null,
    defaultCategory: { guid: 'd5012051-d7ca-11e0-9a5c-feab5ed617ed' },
    categories: [{ guid: 'd5012051-d7ca-11e0-9a5c-feab5ed617ed' }],
    variants: [{ code: '0001', visible: true }]
  };

  const pricelists = [
    { id: sourcePricelistId, name: 'Hlavní ceník', currency, isDefault: sourcePricelistId === 1 },
    { id: targetPricelistId, name: 'Věrnostní klub (VIP)', currency, isDefault: false }
  ];

  return {
    profile: async () => profile,
    product: async () => product,
    brand: async () => null,
    pricelist: async id => {
      const pl = pricelists.find(p => p.id === id);
      if (!pl) throw new Error('Pricelist not found: ' + id);
      return pl;
    },
    prices: async (pricelistId, { code }) => {
      const isSource = pricelistId === sourcePricelistId;
      return {
        items: [{
          code,
          currencyCode: currency,
          includingVat: true,
          vatRate: '0.00',
          price: {
            price: isSource ? basePrice : targetPrice,
            commonPrice: isSource ? null : targetCommonPrice,
            priceRatio: '1.000',
            actionPrice: null
          },
          sales: { discountCoupon: true }
        }],
        pagination: { page: 1, pageCount: 1, totalCount: 1 }
      };
    }
  };
}

test('Rule 1-4: commonPrice in VIP plan dynamically inherits base MOC from main pricelist ID 1', async () => {
  const adapter = createMockAdapter({
    sourcePricelistId: 1,
    targetPricelistId: 2,
    basePrice: '800.00',
    currency: 'CZK'
  });

  const proposal = {
    currency: 'CZK',
    tiers: [{ name: 'VIP', percent: 10, minTurnover: 0, pricelistId: 2 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'okfish_compatible',
    couponPolicy: 'unchanged'
  };

  const plan = await buildSyncPlan({
    adapter,
    proposal,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP',
      targetPricelistId: 2,
      products: [{ guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', codes: ['0001'] }]
    }
  });

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];

  // 1. VIP price is calculated by Pricing Engine: 800 - 10% = 720.00
  assert.equal(action.patch.priceWithVat.price, '720.00');
  assert.equal(action.expected.price, '720.00');

  // 2. commonPrice dynamically inherits base MOC (800.00) from main pricelist ID 1
  assert.equal(action.patch.priceWithVat.commonPrice, '800.00');
  assert.equal(action.expected.commonPrice, '800.00');
});

test('Rule 5: When MOC in main pricelist changes from 800 to 900, sync plan updates both price and commonPrice', async () => {
  const adapterUpdatedMoc = createMockAdapter({
    sourcePricelistId: 1,
    targetPricelistId: 2,
    basePrice: '900.00', // MOC changed from 800 to 900
    currency: 'CZK'
  });

  const proposal = {
    currency: 'CZK',
    tiers: [{ name: 'VIP', percent: 10, minTurnover: 0, pricelistId: 2 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'okfish_compatible',
    couponPolicy: 'unchanged'
  };

  const plan = await buildSyncPlan({
    adapter: adapterUpdatedMoc,
    proposal,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP',
      targetPricelistId: 2,
      products: [{ guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', codes: ['0001'] }]
    }
  });

  const action = plan.actions[0];
  // 900 - 10% = 810.00 Kč
  assert.equal(action.patch.priceWithVat.price, '810.00');
  assert.equal(action.expected.price, '810.00');

  // commonPrice dynamically inherits new MOC 900.00
  assert.equal(action.patch.priceWithVat.commonPrice, '900.00');
  assert.equal(action.expected.commonPrice, '900.00');
});

test('Rule 5: matchesExpectedPrice detects discrepancy when target commonPrice is out of sync', () => {
  const action = {
    code: '0001',
    expected: {
      price: '720.00',
      commonPrice: '800.00',
      discountCoupon: true
    }
  };
  const planContext = {
    currency: 'CZK',
    vatPayer: false,
    date: '2026-11-06'
  };

  const matchingRow = {
    code: '0001',
    currencyCode: 'CZK',
    includingVat: true,
    vatRate: '0.00',
    price: {
      price: '720.00',
      commonPrice: '800.00',
      priceRatio: '1.000',
      actionPrice: null
    },
    sales: { discountCoupon: true }
  };

  const desyncedCommonPriceRow = {
    ...matchingRow,
    price: {
      ...matchingRow.price,
      commonPrice: null // commonPrice is missing or stale
    }
  };

  const desyncedPriceRow = {
    ...matchingRow,
    price: {
      ...matchingRow.price,
      price: '800.00' // price itself is wrong
    }
  };

  // 1. Both price and commonPrice match -> true
  assert.equal(matchesExpectedPrice(matchingRow, action, planContext), true);

  // 2. commonPrice differs (null vs 800.00) -> false (sync is required!)
  assert.equal(matchesExpectedPrice(desyncedCommonPriceRow, action, planContext), false);

  // 3. price differs -> false
  assert.equal(matchesExpectedPrice(desyncedPriceRow, action, planContext), false);
});

test('Rule 6: EUR currency plan dynamically binds commonPrice and calculates VIP price in EUR', async () => {
  const adapterEur = createMockAdapter({
    sourcePricelistId: 10,
    targetPricelistId: 5,
    basePrice: '32.94', // Base EUR price
    currency: 'EUR'
  });

  const proposalEur = {
    currency: 'EUR',
    tiers: [{ name: 'VIP EUR', percent: 10, minTurnover: 0, pricelistId: 5 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'okfish_compatible',
    couponPolicy: 'unchanged'
  };

  const planEur = await buildSyncPlan({
    adapter: adapterEur,
    proposal: proposalEur,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP EUR',
      targetPricelistId: 5,
      sourcePricelistId: 10,
      products: [{ guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', codes: ['0001'] }]
    }
  });

  const action = planEur.actions[0];
  // 32.94 - 10% = 29.65 EUR
  assert.equal(action.patch.priceWithVat.price, '29.65');
  assert.equal(action.expected.price, '29.65');

  // commonPrice dynamically inherits base EUR MOC 32.94
  assert.equal(action.patch.priceWithVat.commonPrice, '32.94');
  assert.equal(action.expected.commonPrice, '32.94');
});

test('Rule 2: Main pricelist ID 1 is strictly read-only and cannot be a target pricelist', async () => {
  const adapter = createMockAdapter({
    sourcePricelistId: 1,
    targetPricelistId: 1,
    basePrice: '800.00',
    currency: 'CZK'
  });

  const proposal = {
    currency: 'CZK',
    tiers: [{ name: 'VIP', percent: 10, minTurnover: 0, pricelistId: 1 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'okfish_compatible',
    couponPolicy: 'unchanged'
  };

  await assert.rejects(
    buildSyncPlan({
      adapter,
      proposal,
      selection: {
        revisionId: '123e4567-e89b-42d3-a456-426614174000',
        tierName: 'VIP',
        targetPricelistId: 1, // Main pricelist cannot be target!
        products: [{ guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', codes: ['0001'] }]
      }
    }),
    /default_pricelist_write_forbidden/
  );
});

test('Rule 6: commonPrice preserves base MOC even when loyalty discount is capped by product/brand/category cap', async () => {
  const adapter = createMockAdapter({
    sourcePricelistId: 1,
    targetPricelistId: 2,
    basePrice: '800.00',
    currency: 'CZK'
  });

  // VIP tier is 20%, but product cap is 5%
  const proposal = {
    currency: 'CZK',
    tiers: [{ name: 'VIP', percent: 20, minTurnover: 0, pricelistId: 2 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [{ id: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', variantCode: '0001', percent: 5 }],
    salePolicy: 'okfish_compatible',
    capPriority: 'most_restrictive',
    couponPolicy: 'unchanged'
  };

  const plan = await buildSyncPlan({
    adapter,
    proposal,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP',
      targetPricelistId: 2,
      products: [{ guid: 'c5012051-d7ca-11e0-9a5c-feab5ed617ed', codes: ['0001'] }]
    }
  });

  const action = plan.actions[0];
  // 800 - 5% cap = 760.00 Kč
  assert.equal(action.patch.priceWithVat.price, '760.00');

  // commonPrice remains original MOC 800.00 Kč
  assert.equal(action.patch.priceWithVat.commonPrice, '800.00');
});
