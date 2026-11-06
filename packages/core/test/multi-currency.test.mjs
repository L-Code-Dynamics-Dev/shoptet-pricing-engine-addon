import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePricing } from '../src/pricing-policy.mjs';
import { calculateTierPrice } from '../src/pricing.mjs';
import { calculateTurnover } from '../src/turnover.mjs';
import { buildSyncPlan } from '../src/sync-planner.mjs';

const customer = '123e4567-e89b-42d3-a456-426614174001';
const basePolicy = {
  period: { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  qualifyingStatusIds: [4],
  requirePaid: true,
  shipping: 'exclude',
  billing: 'exclude',
  discounts: 'after_discounts',
  vat: 'inclusive',
  refunds: 'exclude_order_with_valid_credit_note',
  guestCustomers: 'exclude',
  itemStatuses: 'require_match_order',
  upgrades: 'recalculate',
  downgrades: 'recalculate'
};

const line = (itemType, withVat, withoutVat = withVat) => ({
  itemType,
  status: { id: 4 },
  itemPrice: { withVat, withoutVat },
  amount: '1',
  priceRatio: '1.0000'
});

const makeOrder = (code, currencyCode, total, extra = {}) => ({
  code,
  customerGuid: customer,
  creationTime: '2025-06-01T10:00:00+0200',
  changeTime: '2025-06-01T10:00:00+0200',
  status: { id: 4 },
  paid: true,
  price: { currencyCode, withVat: total, withoutVat: total },
  items: [line('product', total)],
  ...extra
});

test('multi-currency: percentage and fixed discount calculations for CZK and EUR', () => {
  // CZK: 10% discount off 1,000.00 Kč = 900.00 Kč
  const czkPercent = evaluatePricing({
    baseMinor: 100000,
    tierPercent: 10,
    incrementMinor: 100 // whole crowns
  });
  assert.equal(czkPercent.priceMinor, 90000);
  assert.equal(czkPercent.loyaltyApplied, true);

  // CZK: Fixed discount 150.00 Kč off 1,000.00 Kč = 850.00 Kč
  const czkFixed = evaluatePricing({
    baseMinor: 100000,
    fixedDiscountMinor: 15000,
    incrementMinor: 100
  });
  assert.equal(czkFixed.priceMinor, 85000);
  assert.equal(czkFixed.loyaltyApplied, true);

  // EUR: 15% discount off 49.99 € = 42.49 € (math rounding to cents)
  const eurPercent = evaluatePricing({
    baseMinor: 4999,
    tierPercent: 15,
    incrementMinor: 1
  });
  assert.equal(eurPercent.priceMinor, 4249);

  // EUR: Fixed discount 5.00 € off 49.99 € = 44.99 €
  const eurFixed = evaluatePricing({
    baseMinor: 4999,
    fixedDiscountMinor: 500,
    incrementMinor: 1
  });
  assert.equal(eurFixed.priceMinor, 4499);

  // Pure pricing helper calculateTierPrice with fixed discount
  assert.equal(calculateTierPrice({ baseMinor: 50000, fixedDiscountMinor: 5000 }), 45000);
  assert.equal(calculateTierPrice({ baseMinor: 50000, tierPercent: 5, fixedDiscountMinor: 5000 }), 45000);
});

test('multi-currency: currency-correct rounding and minimum price limits', () => {
  // CZK whole-crown rounding: math, up, down on discounted price (10% off 149.60 Kč = 134.64 Kč)
  const base = 14960; // 149.60 Kč
  const mathRound = evaluatePricing({ baseMinor: base, tierPercent: 10, rounding: 'math', incrementMinor: 100 });
  const upRound = evaluatePricing({ baseMinor: base, tierPercent: 10, rounding: 'up', incrementMinor: 100 });
  const downRound = evaluatePricing({ baseMinor: base, tierPercent: 10, rounding: 'down', incrementMinor: 100 });

  assert.equal(mathRound.priceMinor, 13500); // 135.00 Kč (math rounded from 134.64)
  assert.equal(upRound.priceMinor, 13500);   // 135.00 Kč (ceiling)
  assert.equal(downRound.priceMinor, 13400); // 134.00 Kč (floor)

  // Minimum price enforcement in CZK and EUR
  const czkUnderMin = evaluatePricing({
    baseMinor: 10000,
    tierPercent: 50,
    minimumMinor: 8000 // 80 Kč minimum floor
  });
  assert.equal(czkUnderMin.priceMinor, 5000);
  assert.equal(czkUnderMin.valid, false);
  assert.equal(czkUnderMin.blockedReason, 'minimum_price_violation');

  const eurUnderMin = evaluatePricing({
    baseMinor: 1000,
    tierPercent: 50,
    minimumMinor: 800 // 8.00 € minimum floor
  });
  assert.equal(eurUnderMin.valid, false);
  assert.equal(eurUnderMin.blockedReason, 'minimum_price_violation');
});

test('multi-currency: turnover calculation across CZK and EUR without double counting', () => {
  const czkTiers = [
    { name: 'Stříbrný', minTurnover: 5000, percent: 5, pricelistId: 2 },
    { name: 'Zlatý', minTurnover: 10000, percent: 10, pricelistId: 3 }
  ];

  const orderA = makeOrder('ORD-CZK-1', 'CZK', '3000.00'); // 3,000 Kč
  const orderB = makeOrder('ORD-EUR-1', 'EUR', '100.00');  // 100 € (explicit rate 25.0 -> 2,500 Kč)
  const orderC = makeOrder('ORD-CZK-2', 'CZK', '4500.00'); // 4,500 Kč

  // 1. With explicit exchange rate: EUR 100 * 25 = 2,500 Kč
  // Total = 3,000 + 2,500 + 4,500 = 10,000 Kč -> Qualifies for Zlatý!
  const policyWithRates = {
    ...basePolicy,
    exchangeRates: { EUR: 25.0 }
  };

  const res = calculateTurnover({
    customerGuid: customer,
    currency: 'CZK',
    policy: policyWithRates,
    tiers: czkTiers,
    orders: [orderA, orderB, orderC],
    creditNotes: []
  });

  assert.equal(res.turnover, '10000.00');
  assert.equal(res.tier, 'Zlatý');
  assert.equal(res.qualifyingOrders, 3);
  assert.equal(res.turnoverByCurrency.CZK, '7500.00');
  assert.equal(res.turnoverByCurrency.EUR, '100.00');

  // Verify zero double counting: repeated order code fails immediately
  assert.throws(() => calculateTurnover({
    customerGuid: customer,
    currency: 'CZK',
    policy: policyWithRates,
    tiers: czkTiers,
    orders: [orderA, orderB, orderA],
    creditNotes: []
  }), /duplicate_order/);

  // 2. Without explicit exchange rate: "Žádné automatické převody kurzem, pokud nejsou výslovně nastavené"
  // Accumulates separately per currency without auto-converting
  const policySeparate = {
    ...basePolicy,
    multiCurrency: 'accumulate_separate'
  };

  const resSeparate = calculateTurnover({
    customerGuid: customer,
    currency: 'CZK',
    policy: policySeparate,
    tiers: czkTiers,
    orders: [orderA, orderB, orderC],
    creditNotes: []
  });

  // CZK total = 3,000 + 4,500 = 7,500 Kč -> Qualifies for Stříbrný (>= 5,000 Kč, < 10,000 Kč)
  assert.equal(resSeparate.turnover, '7500.00');
  assert.equal(resSeparate.tier, 'Stříbrný');
  assert.equal(resSeparate.turnoverByCurrency.CZK, '7500.00');
  assert.equal(resSeparate.turnoverByCurrency.EUR, '100.00');
  assert.equal(resSeparate.qualifyingOrders, 3);

  // 3. Credit note / refund for EUR order excludes only the EUR order
  const noteEur = {
    code: 'CN-EUR-1',
    orderCode: 'ORD-EUR-1',
    isValid: true,
    customer: { guid: customer },
    creationTime: '2025-08-01T00:00:00Z'
  };

  const resRefund = calculateTurnover({
    customerGuid: customer,
    currency: 'CZK',
    policy: policyWithRates,
    tiers: czkTiers,
    orders: [orderA, orderB, orderC],
    creditNotes: [noteEur]
  });

  // Total should be 7,500 Kč (EUR order refunded)
  assert.equal(resRefund.turnover, '7500.00');
  assert.equal(resRefund.tier, 'Stříbrný');
  assert.equal(resRefund.excludedOrders.length, 1);
  assert.equal(resRefund.excludedOrders[0].code, 'ORD-EUR-1');
});

test('multi-currency: buildSyncPlan creates independent plans for CZK and EUR with matching source pricelists', async () => {
  const mockAdapter = (currencyCode, sourcePricelistId, targetPricelistId) => ({
    profile: async () => ({
      defaultPricelistId: 1,
      vatPayer: true,
      timezone: 'Europe/Prague',
      currencies: [
        { code: 'CZK', priceDecimalPlaces: 2, rounding: 'math' },
        { code: 'EUR', priceDecimalPlaces: 2, rounding: 'math' }
      ]
    }),
    pricelist: async (id) => ({
      id,
      name: id === 1 ? 'Hlavní ceník CZK' : id === 2 ? 'VIP CZK' : id === 10 ? 'Základní EUR' : 'VIP EUR',
      currency: [1, 2].includes(id) ? 'CZK' : 'EUR',
      isDefault: id === 1
    }),
    pricelists: async () => ({
      items: [
        { id: 1, name: 'Hlavní ceník CZK', currency: 'CZK' },
        { id: 2, name: 'VIP CZK', currency: 'CZK' },
        { id: 10, name: 'Základní EUR', currency: 'EUR' },
        { id: 11, name: 'VIP EUR', currency: 'EUR' }
      ]
    }),
    product: async (guid) => ({
      guid,
      visibility: 'normal',
      defaultCategory: { guid: 'cat-1' },
      categories: [{ guid: 'cat-1' }],
      variants: [{ code: 'SKU-1', visible: true }]
    }),
    prices: async (pricelistId, { code }) => ({
      items: [{
        code,
        currencyCode,
        vatRate: '21.00',
        includingVat: true,
        price: {
          price: currencyCode === 'CZK' ? '1000.00' : '40.00',
          priceRatio: '1.000',
          actionPrice: null
        },
        sales: { discountCoupon: true }
      }]
    })
  });

  // 1. CZK Plan
  const proposalCzk = {
    currency: 'CZK',
    tiers: [{ name: 'VIP', percent: 10, minTurnover: 5000, pricelistId: 2 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'lowest_price',
    couponPolicy: 'unchanged'
  };

  const planCzk = await buildSyncPlan({
    adapter: mockAdapter('CZK', 1, 2),
    proposal: proposalCzk,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP',
      targetPricelistId: 2,
      products: [{ guid: '123e4567-e89b-42d3-a456-426614174001', codes: ['SKU-1'] }]
    }
  });

  assert.equal(planCzk.currency, 'CZK');
  assert.equal(planCzk.actions[0].expected.price, '900.00'); // 1000 - 10% = 900 Kč

  // 2. EUR Plan (uses EUR source pricelist id 10, target id 11)
  const proposalEur = {
    currency: 'EUR',
    tiers: [{ name: 'VIP', percent: 10, minTurnover: 200, pricelistId: 11 }],
    brandCaps: [],
    categoryCaps: [],
    productCaps: [],
    salePolicy: 'lowest_price',
    couponPolicy: 'unchanged'
  };

  const planEur = await buildSyncPlan({
    adapter: mockAdapter('EUR', 10, 11),
    proposal: proposalEur,
    selection: {
      revisionId: '123e4567-e89b-42d3-a456-426614174000',
      tierName: 'VIP',
      targetPricelistId: 11,
      sourcePricelistId: 10,
      products: [{ guid: '123e4567-e89b-42d3-a456-426614174001', codes: ['SKU-1'] }]
    }
  });

  assert.equal(planEur.currency, 'EUR');
  assert.equal(planEur.actions[0].expected.price, '36.00'); // 40 - 10% = 36.00 €
});

test('configured minimum margin uses Shoptet purchase cost and fails closed on missing cost', async () => {
  const sku='MARGIN-001';
  let purchasePrice='600.00';
  const adapter={
    async profile() {return {defaultPricelistId:1,vatPayer:true,timezone:'Europe/Prague',
      currencies:[{code:'CZK',priceDecimalPlaces:2,rounding:'math'}]};},
    async pricelist(id) {return {id,name:'Pricelist '+id,currency:'CZK',isDefault:id===1};},
    async product(guid) {return {guid,visibility:'normal',brand:null,
      defaultCategory:{guid:'123e4567-e89b-42d3-a456-426614174011'},categories:[],
      variants:[{code:sku,visible:true}]};},
    async prices(id) {return {items:[{
      code:sku,currencyCode:'CZK',vatRate:'21.00',includingVat:true,
      price:{price:'1000.00',priceRatio:'1.000',actionPrice:null},
      prices:purchasePrice===null?{}:{purchasePrice:{price:purchasePrice,vatRate:'21.00',includingVat:true}},
      sales:{discountCoupon:true}
    }]};}
  };
  const proposal={currency:'CZK',minMarginBps:2000,
    tiers:[{name:'VIP',percent:10,minTurnover:0,pricelistId:2}],
    brandCaps:[],categoryCaps:[],productCaps:[],couponPolicy:'unchanged'};
  const selection={revisionId:'123e4567-e89b-42d3-a456-426614174000',
    tierName:'VIP',targetPricelistId:2,
    products:[{guid:'123e4567-e89b-42d3-a456-426614174001',codes:[sku]}]};
  const safe=await buildSyncPlan({adapter,proposal,selection});
  assert.equal(safe.actions[0].expected.price,'900.00');
  purchasePrice='900.00';
  await assert.rejects(buildSyncPlan({adapter,proposal,selection}),/minimum_margin_violation/);
  purchasePrice=null;
  await assert.rejects(buildSyncPlan({adapter,proposal,selection}),/purchase_cost_unavailable/);
});
