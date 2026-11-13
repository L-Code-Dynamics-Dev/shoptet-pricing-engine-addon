import { z } from 'zod';

export const SUPPORTED_PERIODS = Object.freeze({
  '7_days': { id: '7_days', label: 'Posledních 7 dní', days: 7, description: 'Klouzavé období posledních 7 dní' },
  '1_month': { id: '1_month', label: 'Poslední měsíc (30 dní)', days: 30, description: 'Klouzavé období 30 dní' },
  '3_months': { id: '3_months', label: 'Poslední 3 měsíce (90 dní)', days: 90, description: 'Klouzavé období 90 dní' },
  '6_months': { id: '6_months', label: 'Posledních 6 měsíců (180 dní)', days: 180, description: 'Klouzavé období 180 dní' },
  '12_months': { id: '12_months', label: 'Posledních 12 měsíců (365 dní)', days: 365, description: 'Klouzavé období 365 dní' },
  'all_time': { id: 'all_time', label: 'Za celou dobu', days: null, description: 'Celá dostupná historie objednávek zákazníka' }
});

export const RETENTION_POLICIES = Object.freeze({
  'permanent': { id: 'permanent', label: 'Úroveň zůstává natrvalo', description: 'Jednou dosažená věrnostní úroveň se nikdy nesnižuje.' },
  'rolling_turnover': { id: 'rolling_turnover', label: 'Průběžně přepočítávat podle obratu', description: 'Úroveň se v každém období přesně přizpůsobuje aktuálnímu nákupnímu obratu.' },
  'inactivity_drop_one': { id: 'inactivity_drop_one', label: 'Po době neaktivity pokles o jednu úroveň', description: 'Pokud zákazník nenakoupí po zvolený počet dní, klesne o jednu věrnostní úroveň.' },
  'inactivity_drop_base': { id: 'inactivity_drop_base', label: 'Po době neaktivity návrat na základní úroveň', description: 'Pokud zákazník nenakoupí po zvolený počet dní, vrátí se na základní úroveň bez věrnostní slevy.' }
});

const MAX_TIERS = 10;

export function validateOnboardingConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Neplatná konfigurace průvodce.' };
  }

  const { period, retentionPolicy, inactivityDays, warningDays, tiers } = input;

  if (!period || !Object.hasOwn(SUPPORTED_PERIODS, period)) {
    return { valid: false, error: 'Zvolte platné období pro výpočet obratu.' };
  }

  if (!retentionPolicy || !Object.hasOwn(RETENTION_POLICIES, retentionPolicy)) {
    return { valid: false, error: 'Zvolte platné pravidlo pro udržení úrovně.' };
  }

  if (['inactivity_drop_one', 'inactivity_drop_base'].includes(retentionPolicy)) {
    if (inactivityDays === undefined || inactivityDays === null || !Number.isSafeInteger(Number(inactivityDays)) || Number(inactivityDays) < 1) {
      return { valid: false, error: 'Zadejte platnou dobu neaktivity ve dnech (kladné celé číslo).' };
    }
    if (warningDays !== undefined && warningDays !== null && warningDays !== '') {
      const wDays = Number(warningDays);
      if (!Number.isSafeInteger(wDays) || wDays < 1) {
        return { valid: false, error: 'Doba pro upozornění předem musí být kladné celé číslo.' };
      }
      if (wDays >= Number(inactivityDays)) {
        return { valid: false, error: 'Upozornění předem musí být menší než doba neaktivity.' };
      }
    }
  }

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { valid: false, error: 'Zadejte alespoň jednu věrnostní úroveň.' };
  }

  if (tiers.length > MAX_TIERS) {
    return { valid: false, error: `Lze nastavit maximálně ${MAX_TIERS} věrnostních úrovní.` };
  }

  const parsedTiers = [];
  const names = new Set();

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const row = `Úroveň ${i + 1}: `;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return { valid: false, error: row + 'neplatná data.' };
    }

    const name = typeof t.name === 'string' ? t.name.trim() : '';
    if (name.length < 1 || name.length > 60) {
      return { valid: false, error: row + 'název úrovně musí mít 1–60 znaků.' };
    }
    const lower = name.toLocaleLowerCase('cs');
    if (names.has(lower)) {
      return { valid: false, error: row + 'duplicitní název úrovně.' };
    }
    names.add(lower);

    const percent = Number(t.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100 || Math.abs(Math.round(percent * 100) - percent * 100) > 1e-9) {
      return { valid: false, error: row + 'sleva musí být číslo 0,01–100 % (max. 2 desetinná místa).' };
    }

    const minTurnover = Number(t.minTurnover);
    if (!Number.isSafeInteger(minTurnover) || minTurnover < 0) {
      return { valid: false, error: row + 'obrat musí být celé číslo ≥ 0.' };
    }

    if (parsedTiers.length > 0 && minTurnover <= parsedTiers[parsedTiers.length - 1].minTurnover) {
      return { valid: false, error: row + 'obrat musí být vyšší než u předchozí úrovně.' };
    }

    let pricelistId = null;
    if (t.pricelistId !== undefined && t.pricelistId !== null && t.pricelistId !== '') {
      pricelistId = Number(t.pricelistId);
      if (!Number.isSafeInteger(pricelistId) || pricelistId <= 0) {
        return { valid: false, error: row + 'neplatné ID ceníku.' };
      }
    }

    let customerGroupId = null;
    if (t.customerGroupId !== undefined && t.customerGroupId !== null && t.customerGroupId !== '') {
      customerGroupId = Number(t.customerGroupId);
      if (!Number.isSafeInteger(customerGroupId) || customerGroupId <= 0) {
        return { valid: false, error: row + 'neplatné ID zákaznické skupiny.' };
      }
    }

    parsedTiers.push({
      name,
      percent,
      minTurnover,
      ...(pricelistId ? { pricelistId } : {}),
      ...(customerGroupId ? { customerGroupId } : {})
    });
  }

  return {
    valid: true,
    config: {
      period,
      retentionPolicy,
      ...(inactivityDays ? { inactivityDays: Number(inactivityDays) } : {}),
      ...(warningDays ? { warningDays: Number(warningDays) } : {}),
      tiers: parsedTiers
    }
  };
}

export function computeRollingPeriodWindow({ period, now = new Date() }) {
  const p = SUPPORTED_PERIODS[period];
  if (!p) throw new Error('invalid_period');

  const to = now.toISOString();
  if (p.days === null) {
    return { from: '1970-01-01T00:00:00.000Z', to };
  }

  const fromDate = new Date(now.getTime() - p.days * 86400000);
  return { from: fromDate.toISOString(), to };
}

const money = value => {
  if (typeof value !== 'string' || !/^-?\d+\.\d{2}$/.test(value)) return 0n;
  return BigInt(value.replace('.', ''));
};

const amount = n => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 100n}.${String((n < 0n ? -n : n) % 100n).padStart(2, '0')}`;

export function evaluateTierRetention({
  customerGuid,
  currentTierName = null,
  currentPricelistId = null,
  currentGroupId = null,
  orders = [],
  creditNotes = [],
  tiers = [],
  config,
  customerState = null,
  now = new Date()
}) {
  const window = computeRollingPeriodWindow({ period: config.period, now });
  const start = Date.parse(window.from);
  const end = Date.parse(window.to);

  // 1. Process credit notes to identify refunded orders
  const refundedOrders = new Set();
  for (const cn of creditNotes) {
    if (cn.isValid && cn.orderCode) {
      if (cn.customer?.guid === null || cn.customer?.guid === customerGuid) {
        refundedOrders.add(cn.orderCode);
      }
    }
  }

  // 2. Tally qualifying orders
  let turnoverCents = 0n;
  let qualifyingOrdersCount = 0;
  let latestOrderTime = 0;

  for (const o of orders) {
    if (o.customerGuid !== customerGuid) continue;
    if (refundedOrders.has(o.code)) continue;

    const orderTime = Date.parse(o.creationTime);
    if (!Number.isFinite(orderTime)) continue;

    // Track latest order across all time for inactivity check
    if (orderTime > latestOrderTime && o.paid === true) {
      latestOrderTime = orderTime;
    }

    // Window check for turnover accumulation
    if (orderTime >= start && orderTime <= end) {
      if (o.paid === true) {
        const val = money(o.price?.withVat || '0.00');
        if (val > 0n) {
          turnoverCents += val;
          qualifyingOrdersCount++;
        }
      }
    }
  }

  // Find turnover-eligible tier
  let eligibleTier = null;
  let eligibleIndex = -1;
  for (let i = 0; i < tiers.length; i++) {
    if (turnoverCents >= BigInt(tiers[i].minTurnover) * 100n) {
      eligibleTier = tiers[i];
      eligibleIndex = i;
    }
  }

  // Find current tier rank
  let currentIndex = -1;
  if (currentTierName) {
    currentIndex = tiers.findIndex(t => t.name.toLowerCase() === currentTierName.toLowerCase());
  } else if (currentPricelistId) {
    currentIndex = tiers.findIndex(t => t.pricelistId === currentPricelistId);
  }

  const currentTier = currentIndex >= 0 ? tiers[currentIndex] : null;

  // 3. Evaluate according to retentionPolicy
  const policy = config.retentionPolicy;

  // Check inactivity threshold
  let inactivityExceeded = false;
  const degradationBaseline = customerState?.lastDegradedAt ? Date.parse(customerState.lastDegradedAt) : 0;
  const inactivityTimerOrigin = Math.max(latestOrderTime, degradationBaseline);

  if (['inactivity_drop_one', 'inactivity_drop_base'].includes(policy) && config.inactivityDays) {
    if (inactivityTimerOrigin === 0) {
      inactivityExceeded = true;
    } else {
      const daysSinceInactiveBaseline = (now.getTime() - inactivityTimerOrigin) / 86400000;
      if (daysSinceInactiveBaseline >= config.inactivityDays) {
        inactivityExceeded = true;
      }
    }
  }

  // Warning check
  let warningExpiring = false;
  let daysRemaining = null;

  if (['inactivity_drop_one', 'inactivity_drop_base'].includes(policy) && config.inactivityDays && inactivityTimerOrigin > 0) {
    const daysSinceInactiveBaseline = (now.getTime() - inactivityTimerOrigin) / 86400000;
    if (config.warningDays && daysSinceInactiveBaseline >= (config.inactivityDays - config.warningDays) && daysSinceInactiveBaseline < config.inactivityDays) {
      warningExpiring = true;
      daysRemaining = Math.max(1, Math.ceil(config.inactivityDays - daysSinceInactiveBaseline));
    }
  }

  // ANTI-OSCILLATION GUARD:
  // If customer was degraded for inactivity and period is all_time,
  // ensure past orders prior to degradation do NOT re-promote customer!
  let antiOscillationBlocked = false;
  if (customerState?.lastDegradedAt && config.period === 'all_time') {
    const degradedTimestamp = Date.parse(customerState.lastDegradedAt);
    const hasOrderAfterDegrade = orders.some(o => {
      const t = Date.parse(o.creationTime);
      return Number.isFinite(t) && t > degradedTimestamp && o.paid === true && !refundedOrders.has(o.code);
    });

    if (!hasOrderAfterDegrade && eligibleIndex > currentIndex) {
      antiOscillationBlocked = true;
    }
  }

  let action = 'RETAIN';
  let targetTier = currentTier;
  let kept = false;
  let reason = 'turnover_match';
  let degradedAt = null;

  if (inactivityExceeded && currentTier) {
    action = 'DOWNGRADE';
    reason = 'inactivity_threshold_exceeded';
    degradedAt = now.toISOString();

    if (policy === 'inactivity_drop_one') {
      targetTier = currentIndex > 0 ? tiers[currentIndex - 1] : null;
    } else {
      // inactivity_drop_base
      targetTier = null;
    }
  } else if (antiOscillationBlocked) {
    action = 'RETAIN';
    targetTier = currentTier;
    reason = 'anti_oscillation_awaiting_new_purchase';
  } else if (policy === 'permanent') {
    if (currentTier && currentIndex > eligibleIndex) {
      action = 'RETAIN';
      targetTier = currentTier;
      kept = true;
      reason = 'permanent_retention';
    } else if (eligibleIndex > currentIndex) {
      action = 'UPGRADE';
      targetTier = eligibleTier;
      reason = 'turnover_qualification';
    } else {
      action = 'RETAIN';
      targetTier = currentTier || eligibleTier;
    }
  } else if (policy === 'rolling_turnover') {
    if (eligibleIndex > currentIndex) {
      action = 'UPGRADE';
      targetTier = eligibleTier;
      reason = 'turnover_qualification';
    } else if (eligibleIndex < currentIndex) {
      action = 'DOWNGRADE';
      targetTier = eligibleTier;
      reason = 'rolling_turnover_lower';
    } else {
      action = 'RETAIN';
      targetTier = eligibleTier;
    }
  } else {
    // Normal inactivity policy where threshold is not exceeded
    if (eligibleIndex > currentIndex) {
      action = 'UPGRADE';
      targetTier = eligibleTier;
      reason = 'turnover_qualification';
    } else {
      action = 'RETAIN';
      targetTier = currentTier || eligibleTier;
    }
  }

  return {
    customerGuid,
    currentTier: currentTier ? { name: currentTier.name, pricelistId: currentTier.pricelistId } : null,
    targetTier: targetTier ? { name: targetTier.name, pricelistId: targetTier.pricelistId, customerGroupId: targetTier.customerGroupId } : null,
    action,
    reason,
    turnover: amount(turnoverCents),
    qualifyingOrders: qualifyingOrdersCount,
    kept,
    warningExpiring,
    ...(daysRemaining !== null ? { daysRemaining } : {}),
    ...(degradedAt ? { degradedAt } : {})
  };
}

export async function setupLoyaltyEntities({
  adapter,
  shopId,
  tiers,
  autoCreate = false,
  existingPricelists = [],
  existingGroups = []
}) {
  const matched = [];
  const missingPricelists = [];
  const missingGroups = [];

  for (const tier of tiers) {
    const plName = tier.name;
    const groupName = tier.name;

    // Match pricelist
    let pl = null;
    if (tier.pricelistId) {
      pl = existingPricelists.find(p => p.id === tier.pricelistId);
    }
    if (!pl) {
      pl = existingPricelists.find(p => p.name.trim().toLowerCase() === plName.trim().toLowerCase() || p.name.trim().toLowerCase() === `věrnostní ceník: ${plName}`.toLowerCase());
    }

    // Match customer group
    let grp = null;
    if (tier.customerGroupId) {
      grp = existingGroups.find(g => g.id === tier.customerGroupId);
    }
    if (!grp) {
      grp = existingGroups.find(g => g.name.trim().toLowerCase() === groupName.trim().toLowerCase() || g.name.trim().toLowerCase() === `věrnostní skupina: ${groupName}`.toLowerCase());
    }

    if (pl && grp) {
      matched.push({
        name: tier.name,
        percent: tier.percent,
        minTurnover: tier.minTurnover,
        pricelistId: pl.id,
        customerGroupId: grp.id
      });
    } else {
      if (!pl) missingPricelists.push({ name: `Věrnostní ceník: ${tier.name}`, tierName: tier.name });
      if (!grp) missingGroups.push({ name: `Věrnostní skupina: ${tier.name}`, tierName: tier.name });
    }
  }

  if (missingPricelists.length === 0 && missingGroups.length === 0) {
    return {
      status: 'READY',
      autoCreated: false,
      entities: matched
    };
  }

  if (!autoCreate) {
    return {
      status: 'CONFIRMATION_REQUIRED',
      missingPricelists,
      missingGroups,
      preview: {
        matchedCount: matched.length,
        missingPricelistsCount: missingPricelists.length,
        missingGroupsCount: missingGroups.length
      }
    };
  }

  // Attempt creation via Shoptet API
  const createdEntities = [...matched];

  for (const tier of tiers) {
    const isAlreadyMatched = matched.some(m => m.name === tier.name);
    if (isAlreadyMatched) continue;

    const plName = `Věrnostní ceník: ${tier.name}`;
    const groupName = `Věrnostní skupina: ${tier.name}`;

    // 1. Create Pricelist
    let plRes;
    try {
      plRes = await adapter.createPricelist({ name: plName });
    } catch {
      return {
        status: 'MANUAL_SETUP_REQUIRED',
        reason: 'pricelists_permission_missing',
        manualInstructions: generateManualSetupGuide({ missingPricelists, missingGroups })
      };
    }

    if (!plRes || plRes.outcome !== 'accepted' || !plRes.pricelist?.id) {
      return {
        status: 'MANUAL_SETUP_REQUIRED',
        reason: 'pricelists_permission_missing',
        manualInstructions: generateManualSetupGuide({ missingPricelists, missingGroups })
      };
    }

    const pricelistId = plRes.pricelist.id;

    // 2. Create Customer Group linked to the pricelist
    let grpRes;
    try {
      grpRes = await adapter.createCustomerGroup({ name: groupName, defaultPricelistId: pricelistId });
    } catch {
      return {
        status: 'MANUAL_SETUP_REQUIRED',
        reason: 'customers_permission_missing',
        manualInstructions: generateManualSetupGuide({ missingPricelists, missingGroups })
      };
    }

    if (!grpRes || grpRes.outcome !== 'accepted' || !grpRes.customerGroup?.id) {
      return {
        status: 'MANUAL_SETUP_REQUIRED',
        reason: 'customers_permission_missing',
        manualInstructions: generateManualSetupGuide({ missingPricelists, missingGroups })
      };
    }

    const customerGroupId = grpRes.customerGroup.id;

    createdEntities.push({
      name: tier.name,
      percent: tier.percent,
      minTurnover: tier.minTurnover,
      pricelistId,
      customerGroupId
    });
  }

  return {
    status: 'READY',
    autoCreated: true,
    entities: createdEntities
  };
}

export function generateManualSetupGuide({ missingPricelists = [], missingGroups = [] }) {
  const lines = [
    '### Návod na ruční vytvoření ceníků a zákaznických skupin v Shoptetu',
    '',
    'Aplikace nemá v Shoptetu automatické oprávnění pro zakládání ceníků nebo skupin.',
    'Vše můžete jednoduše nastavit přímo v administraci Shoptetu během několika minut:',
    ''
  ];

  if (missingPricelists.length > 0) {
    lines.push('#### 1. Vytvoření ceníků:');
    lines.push('1. V hlavním menu Shoptetu otevřete **Nastavení > Ceníky**.');
    lines.push('2. Klikněte na tlačítko **Přidat ceník**.');
    lines.push('3. Vytvořte následující ceníky s výchozí měnou vašeho e-shopu:');
    for (const p of missingPricelists) {
      lines.push(`   - **${p.name}** (pro úroveň ${p.tierName})`);
    }
    lines.push('');
  }

  if (missingGroups.length > 0) {
    lines.push('#### 2. Vytvoření zákaznických skupin:');
    lines.push('1. V menu Shoptetu otevřete **Zákazníci > Skupiny zákazníků**.');
    lines.push('2. Klikněte na tlačítko **Přidat skupinu**.');
    lines.push('3. Založte skupiny a u každé nastavte odpovídající výchozí ceník:');
    for (const g of missingGroups) {
      lines.push(`   - **${g.name}** → vyberte jako výchozí ceník stejnojmenný ceník`);
    }
    lines.push('');
  }

  lines.push('#### 3. Dokončení propojení:');
  lines.push('Po vytvoření se vraťte do této záložky a klikněte na tlačítko **Zkontrolovat propojení**.');
  lines.push('Doplněk existující ceníky a skupiny automaticky rozpozná a propojí s věrnostními úrovněmi.');

  return lines.join('\n');
}

export async function inspectStoreOnboardingData({ adapter }) {
  const [profile, products, categories, brands, pricelistsRes, customerGroups] = await Promise.all([
    adapter.profile(),
    adapter.list('products', { limit: 1 }),
    adapter.list('categories', { limit: 1 }),
    adapter.list('brands', { limit: 1 }),
    adapter.list('pricelists'),
    adapter.customerGroups()
  ]);

  let customersCount = 0;
  try {
    const custRes = await adapter.list('customers', { limit: 1 });
    customersCount = custRes.pagination?.totalCount ?? custRes.items.length;
  } catch {}

  return {
    shopId: profile.id,
    shopName: profile.name,
    vatPayer: profile.vatPayer,
    currency: profile.currencies?.[0]?.code ?? 'CZK',
    productsCount: products.pagination?.totalCount ?? products.items.length,
    categoriesCount: categories.pagination?.totalCount ?? categories.items.length,
    brandsCount: brands.pagination?.totalCount ?? brands.items.length,
    customersCount,
    pricelists: pricelistsRes.items || [],
    customerGroups: customerGroups || [],
    readOnly: true
  };
}
