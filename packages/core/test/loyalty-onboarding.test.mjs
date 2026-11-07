import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_PERIODS,
  RETENTION_POLICIES,
  validateOnboardingConfig,
  computeRollingPeriodWindow,
  evaluateTierRetention,
  setupLoyaltyEntities,
  generateManualSetupGuide,
  inspectStoreOnboardingData
} from '../src/loyalty-onboarding.mjs';

test('validateOnboardingConfig accepts valid configuration with Czech human names and sorted turnovers', () => {
  const valid = {
    period: '3_months',
    retentionPolicy: 'inactivity_drop_one',
    inactivityDays: 90,
    warningDays: 14,
    tiers: [
      { name: 'Stříbrná', percent: 5, minTurnover: 0 },
      { name: 'Zlatá', percent: 10, minTurnover: 5000 },
      { name: 'Platinová', percent: 15, minTurnover: 15000 }
    ]
  };

  const parsed = validateOnboardingConfig(valid);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.config.tiers.length, 3);
  assert.equal(parsed.config.period, '3_months');
  assert.equal(parsed.config.retentionPolicy, 'inactivity_drop_one');
});

test('validateOnboardingConfig rejects non-ascending turnovers, duplicate names, and invalid discounts', () => {
  // Non-ascending turnover
  const nonAsc = validateOnboardingConfig({
    period: '1_month',
    retentionPolicy: 'permanent',
    tiers: [
      { name: 'Stříbrná', percent: 5, minTurnover: 5000 },
      { name: 'Zlatá', percent: 10, minTurnover: 3000 }
    ]
  });
  assert.equal(nonAsc.valid, false);
  assert.match(nonAsc.error, /obrat.*vyšší/i);

  // Duplicate name
  const dup = validateOnboardingConfig({
    period: '1_month',
    retentionPolicy: 'permanent',
    tiers: [
      { name: 'VIP', percent: 5, minTurnover: 0 },
      { name: 'vip', percent: 10, minTurnover: 5000 }
    ]
  });
  assert.equal(dup.valid, false);
  assert.match(dup.error, /duplicitní název/i);

  // Invalid discount (> 100 or > 2 decimal places)
  const badDiscount = validateOnboardingConfig({
    period: '1_month',
    retentionPolicy: 'permanent',
    tiers: [
      { name: 'VIP', percent: 105, minTurnover: 0 }
    ]
  });
  assert.equal(badDiscount.valid, false);
  assert.match(badDiscount.error, /sleva/i);

  // Missing inactivityDays for inactivity_drop_one
  const missingInactivity = validateOnboardingConfig({
    period: '6_months',
    retentionPolicy: 'inactivity_drop_one',
    tiers: [{ name: 'VIP', percent: 5, minTurnover: 0 }]
  });
  assert.equal(missingInactivity.valid, false);
  assert.match(missingInactivity.error, /neaktivit/i);

  // warningDays >= inactivityDays
  const badWarning = validateOnboardingConfig({
    period: '6_months',
    retentionPolicy: 'inactivity_drop_one',
    inactivityDays: 30,
    warningDays: 35,
    tiers: [{ name: 'VIP', percent: 5, minTurnover: 0 }]
  });
  assert.equal(badWarning.valid, false);
  assert.match(badWarning.error, /upozornění.*menší než doba neaktivity/i);
});

test('computeRollingPeriodWindow computes exact ISO windows for all 6 periods', () => {
  const fixedNow = new Date('2026-11-07T12:00:00.000Z');

  // 1. 7_days
  const w7 = computeRollingPeriodWindow({ period: '7_days', now: fixedNow });
  assert.equal(w7.to, '2026-11-07T12:00:00.000Z');
  assert.equal(w7.from, '2026-10-31T12:00:00.000Z');

  // 2. 1_month (30 days)
  const w30 = computeRollingPeriodWindow({ period: '1_month', now: fixedNow });
  assert.equal(w30.from, '2026-10-08T12:00:00.000Z');

  // 3. 3_months (90 days)
  const w90 = computeRollingPeriodWindow({ period: '3_months', now: fixedNow });
  assert.equal(w90.from, '2026-08-09T12:00:00.000Z');

  // 4. 6_months (180 days)
  const w180 = computeRollingPeriodWindow({ period: '6_months', now: fixedNow });
  assert.equal(w180.from, '2026-05-11T12:00:00.000Z');

  // 5. 12_months (365 days)
  const w365 = computeRollingPeriodWindow({ period: '12_months', now: fixedNow });
  assert.equal(w365.from, '2025-11-07T12:00:00.000Z');

  // 6. all_time
  const wAll = computeRollingPeriodWindow({ period: 'all_time', now: fixedNow });
  assert.equal(wAll.from, '1970-01-01T00:00:00.000Z');
  assert.equal(wAll.to, '2026-11-07T12:00:00.000Z');
});

test('evaluateTierRetention: permanent policy retains higher tier even with zero turnover', () => {
  const tiers = [
    { name: 'Bronzová', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 },
    { name: 'Stříbrná', percent: 10, minTurnover: 5000, pricelistId: 11, customerGroupId: 101 },
    { name: 'Zlatá', percent: 15, minTurnover: 15000, pricelistId: 12, customerGroupId: 102 }
  ];
  const config = {
    period: '3_months',
    retentionPolicy: 'permanent',
    tiers
  };

  // Customer is currently Zlatá (pricelistId 12), has 0 turnover in last 3 months
  const decision = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Zlatá',
    currentPricelistId: 12,
    currentGroupId: 102,
    orders: [],
    creditNotes: [],
    tiers,
    config,
    now: new Date('2026-11-07T12:00:00Z')
  });

  assert.equal(decision.action, 'RETAIN');
  assert.equal(decision.targetTier.name, 'Zlatá');
  assert.equal(decision.kept, true);
  assert.equal(decision.reason, 'permanent_retention');
});

test('evaluateTierRetention: rolling_turnover recalculates strictly according to rolling turnover', () => {
  const tiers = [
    { name: 'Bronzová', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 },
    { name: 'Stříbrná', percent: 10, minTurnover: 5000, pricelistId: 11, customerGroupId: 101 },
    { name: 'Zlatá', percent: 15, minTurnover: 15000, pricelistId: 12, customerGroupId: 102 }
  ];
  const config = {
    period: '1_month',
    retentionPolicy: 'rolling_turnover',
    tiers
  };

  // Customer was Zlatá, but in last month had only 6000 turnover -> drops to Stříbrná
  const orderDate = new Date('2026-11-01T10:00:00Z').toISOString();
  const orders = [
    {
      code: 'ORD-1',
      customerGuid: 'c1',
      creationTime: orderDate,
      status: { id: 1 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '6000.00', withoutVat: '4958.68' },
      items: [{ itemType: 'product', status: { id: 1 }, itemPrice: { withVat: '6000.00', withoutVat: '4958.68' } }]
    }
  ];

  const decision = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Zlatá',
    currentPricelistId: 12,
    currentGroupId: 102,
    orders,
    creditNotes: [],
    tiers,
    config,
    now: new Date('2026-11-07T12:00:00Z')
  });

  assert.equal(decision.action, 'DOWNGRADE');
  assert.equal(decision.targetTier.name, 'Stříbrná');
  assert.equal(decision.turnover, '6000.00');
});

test('evaluateTierRetention: inactivity_drop_one drops by exactly 1 tier after inactivity threshold', () => {
  const tiers = [
    { name: 'Bronzová', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 },
    { name: 'Stříbrná', percent: 10, minTurnover: 5000, pricelistId: 11, customerGroupId: 101 },
    { name: 'Zlatá', percent: 15, minTurnover: 15000, pricelistId: 12, customerGroupId: 102 }
  ];
  const config = {
    period: 'all_time',
    retentionPolicy: 'inactivity_drop_one',
    inactivityDays: 60,
    warningDays: 14,
    tiers
  };

  // Customer was Zlatá, last purchase was 80 days ago
  const oldOrderDate = new Date('2026-08-15T10:00:00Z').toISOString();
  const orders = [
    {
      code: 'ORD-OLD',
      customerGuid: 'c1',
      creationTime: oldOrderDate,
      status: { id: 1 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '20000.00', withoutVat: '16528.93' },
      items: [{ itemType: 'product', status: { id: 1 }, itemPrice: { withVat: '20000.00', withoutVat: '16528.93' } }]
    }
  ];

  const decision = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Zlatá',
    currentPricelistId: 12,
    currentGroupId: 102,
    orders,
    creditNotes: [],
    tiers,
    config,
    now: new Date('2026-11-07T12:00:00Z')
  });

  assert.equal(decision.action, 'DOWNGRADE');
  assert.equal(decision.targetTier.name, 'Stříbrná');
  assert.equal(decision.reason, 'inactivity_threshold_exceeded');
  assert.ok(decision.degradedAt);
});

test('evaluateTierRetention: anti-oscillation guard prevents immediate re-promotion after inactivity degradation under all_time', () => {
  const tiers = [
    { name: 'Bronzová', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 },
    { name: 'Stříbrná', percent: 10, minTurnover: 5000, pricelistId: 11, customerGroupId: 101 },
    { name: 'Zlatá', percent: 15, minTurnover: 15000, pricelistId: 12, customerGroupId: 102 }
  ];
  const config = {
    period: 'all_time',
    retentionPolicy: 'inactivity_drop_one',
    inactivityDays: 60,
    tiers
  };

  const oldOrderDate = new Date('2026-08-15T10:00:00Z').toISOString();
  const orders = [
    {
      code: 'ORD-OLD',
      customerGuid: 'c1',
      creationTime: oldOrderDate,
      status: { id: 1 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '20000.00', withoutVat: '16528.93' },
      items: [{ itemType: 'product', status: { id: 1 }, itemPrice: { withVat: '20000.00', withoutVat: '16528.93' } }]
    }
  ];

  // Customer was degraded on Nov 6th from Zlatá to Stříbrná.
  // When running today (Nov 7th) with NO new order:
  const decision = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Stříbrná',
    currentPricelistId: 11,
    currentGroupId: 101,
    orders,
    creditNotes: [],
    tiers,
    config,
    customerState: {
      lastDegradedAt: '2026-11-06T10:00:00.000Z',
      degradedFromTier: 'Zlatá'
    },
    now: new Date('2026-11-07T12:00:00Z')
  });

  // Anti-oscillation guard MUST hold: no re-promotion back to Zlatá on the old order!
  assert.notEqual(decision.action, 'UPGRADE');
  assert.equal(decision.targetTier.name, 'Stříbrná');

  // But if a NEW qualifying order arrives after degradation date:
  const newOrderDate = new Date('2026-11-06T15:00:00Z').toISOString();
  const ordersWithNew = [
    ...orders,
    {
      code: 'ORD-NEW',
      customerGuid: 'c1',
      creationTime: newOrderDate,
      status: { id: 1 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '1000.00', withoutVat: '826.45' },
      items: [{ itemType: 'product', status: { id: 1 }, itemPrice: { withVat: '1000.00', withoutVat: '826.45' } }]
    }
  ];

  const decisionNew = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Stříbrná',
    currentPricelistId: 11,
    currentGroupId: 101,
    orders: ordersWithNew,
    creditNotes: [],
    tiers,
    config,
    customerState: {
      lastDegradedAt: '2026-11-06T10:00:00.000Z',
      degradedFromTier: 'Zlatá'
    },
    now: new Date('2026-11-07T12:00:00Z')
  });

  // Now with a new qualifying order after degradation, re-promotion is allowed
  assert.equal(decisionNew.action, 'UPGRADE');
  assert.equal(decisionNew.targetTier.name, 'Zlatá');
});

test('evaluateTierRetention: warning before expiration reports days remaining', () => {
  const tiers = [
    { name: 'Stříbrná', percent: 5, minTurnover: 0, pricelistId: 10, customerGroupId: 100 },
    { name: 'Zlatá', percent: 10, minTurnover: 5000, pricelistId: 11, customerGroupId: 101 }
  ];
  const config = {
    period: '3_months',
    retentionPolicy: 'inactivity_drop_one',
    inactivityDays: 60,
    warningDays: 14,
    tiers
  };

  // Last order was 50 days ago (10 days until inactivity drop)
  const orderDate = new Date('2026-09-18T12:00:00Z').toISOString();
  const orders = [
    {
      code: 'ORD-1',
      customerGuid: 'c1',
      creationTime: orderDate,
      status: { id: 1 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '8000.00', withoutVat: '6611.57' },
      items: [{ itemType: 'product', status: { id: 1 }, itemPrice: { withVat: '8000.00', withoutVat: '6611.57' } }]
    }
  ];

  const decision = evaluateTierRetention({
    customerGuid: 'c1',
    currentTierName: 'Zlatá',
    currentPricelistId: 11,
    currentGroupId: 101,
    orders,
    creditNotes: [],
    tiers,
    config,
    now: new Date('2026-11-07T12:00:00Z')
  });

  assert.equal(decision.action, 'RETAIN');
  assert.equal(decision.warningExpiring, true);
  assert.equal(decision.daysRemaining, 10);
});

test('setupLoyaltyEntities: idempotently matches existing pricelists and groups without duplicates', async () => {
  const tiers = [
    { name: 'Stříbrná', percent: 5, minTurnover: 0 },
    { name: 'Zlatá', percent: 10, minTurnover: 5000 }
  ];

  const existingPricelists = [
    { id: 1, name: 'Základní ceník', isDefault: true },
    { id: 10, name: 'Věrnostní ceník: Stříbrná', isDefault: false },
    { id: 11, name: 'Věrnostní ceník: Zlatá', isDefault: false }
  ];

  const existingGroups = [
    { id: 100, name: 'Věrnostní skupina: Stříbrná', defaultPricelistId: 10 },
    { id: 101, name: 'Věrnostní skupina: Zlatá', defaultPricelistId: 11 }
  ];

  const result = await setupLoyaltyEntities({
    adapter: {},
    shopId: '826800',
    tiers,
    autoCreate: false,
    existingPricelists,
    existingGroups
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.autoCreated, false);
  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[0].pricelistId, 10);
  assert.equal(result.entities[0].customerGroupId, 100);
  assert.equal(result.entities[1].pricelistId, 11);
  assert.equal(result.entities[1].customerGroupId, 101);
});

test('setupLoyaltyEntities: creates 1 pricelist + 1 customer group per tier and links them when API allows', async () => {
  const tiers = [
    { name: 'Bronz', percent: 5, minTurnover: 0 }
  ];

  let createdPricelists = 0;
  let createdGroups = 0;

  const mockAdapter = {
    async createPricelist({ name }) {
      createdPricelists++;
      return { outcome: 'accepted', pricelist: { id: 20, name } };
    },
    async createCustomerGroup({ name, defaultPricelistId }) {
      createdGroups++;
      return { outcome: 'accepted', customerGroup: { id: 200, name, defaultPricelistId } };
    }
  };

  const result = await setupLoyaltyEntities({
    adapter: mockAdapter,
    shopId: '826800',
    tiers,
    autoCreate: true,
    existingPricelists: [],
    existingGroups: []
  });

  assert.equal(result.status, 'READY');
  assert.equal(result.autoCreated, true);
  assert.equal(createdPricelists, 1);
  assert.equal(createdGroups, 1);
  assert.equal(result.entities[0].pricelistId, 20);
  assert.equal(result.entities[0].customerGroupId, 200);
});

test('setupLoyaltyEntities: fails closed on 403 Forbidden without faking success and provides Czech manual guide', async () => {
  const tiers = [
    { name: 'Bronz', percent: 5, minTurnover: 0 },
    { name: 'Stříbro', percent: 10, minTurnover: 5000 }
  ];

  const mockAdapter = {
    async createPricelist() {
      return { outcome: 'failed', error: 'permission_missing', status: 403 };
    }
  };

  const result = await setupLoyaltyEntities({
    adapter: mockAdapter,
    shopId: '826800',
    tiers,
    autoCreate: true,
    existingPricelists: [],
    existingGroups: []
  });

  assert.equal(result.status, 'MANUAL_SETUP_REQUIRED');
  assert.equal(result.reason, 'pricelists_permission_missing');
  assert.ok(result.manualInstructions);
  assert.match(result.manualInstructions, /Nastavení > Ceníky/);
  assert.match(result.manualInstructions, /Zákazníci > Skupiny zákazníků/);
});

test('inspectStoreOnboardingData: reads real shop entities without writing anything', async () => {
  const mockAdapter = {
    async profile() {
      return { id: 826800, name: 'Můj e-shop', vatPayer: true, defaultPricelistId: 1, timezone: 'Europe/Prague', currencies: [{ code: 'CZK', priceDecimalPlaces: 2, rounding: 'math' }] };
    },
    async list(kind) {
      if (kind === 'products') return { items: [{ id: 'p1' }, { id: 'p2' }], pagination: { totalCount: 42 } };
      if (kind === 'categories') return { items: [{ id: 'c1' }], pagination: { totalCount: 8 } };
      if (kind === 'brands') return { items: [{ id: 'b1' }], pagination: { totalCount: 5 } };
      if (kind === 'pricelists') return { items: [{ id: 1, name: 'Základní' }] };
      if (kind === 'customers') return { items: [{ id: 'cust1' }], pagination: { totalCount: 150 } };
      return { items: [] };
    },
    async customerGroups() {
      return [{ id: 1, name: 'Koncoví zákazníci', defaultPricelistId: 1, customerGroupCode: null }];
    }
  };

  const data = await inspectStoreOnboardingData({ adapter: mockAdapter });
  assert.equal(data.shopId, 826800);
  assert.equal(data.productsCount, 42);
  assert.equal(data.categoriesCount, 8);
  assert.equal(data.brandsCount, 5);
  assert.equal(data.customersCount, 150);
  assert.equal(data.pricelists.length, 1);
  assert.equal(data.customerGroups.length, 1);
  assert.equal(data.readOnly, true);
});
