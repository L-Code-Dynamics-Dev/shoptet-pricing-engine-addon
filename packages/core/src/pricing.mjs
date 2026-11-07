// Pure pricing primitives. Monetary inputs are integer minor units (cents/halere).
// Aligned with OKfish decision logic supporting both okfish_compatible and lowest_price modes.
const percentBps = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 ||
      Number(value.toFixed(2)) !== value) throw new TypeError('Invalid ' + label);
  return BigInt(value.toFixed(2).replace('.', ''));
};
const checkedMinor = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid ' + label);
  return BigInt(value);
};
const safeResult = value => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Price overflow');
  return Number(value);
};
const divideWithRounding = (n, d, mode = 'math') => {
  const q = n / d;
  const r = n % d;
  if (mode === 'up') return q + (r > 0n ? 1n : 0n);
  if (mode === 'down') return q;
  if (mode === 'none') return q;
  // 'math' (round half up)
  return q + (r * 2n >= d ? 1n : 0n);
};

export function resolveCurrencyRoundingRules(currencyCode, options = {}) {
  if (typeof currencyCode !== 'string' || !/^[A-Z]{3}$/.test(currencyCode)) {
    throw new TypeError('Invalid currencyCode: expected 3 uppercase letters');
  }
  const defaults = {
    CZK: { decimals: 2, rounding: 'math', incrementMinor: 100 },
    EUR: { decimals: 2, rounding: 'math', incrementMinor: 1 },
    HUF: { decimals: 0, rounding: 'math', incrementMinor: 100 },
    PLN: { decimals: 2, rounding: 'math', incrementMinor: 1 }
  };
  const standard = defaults[currencyCode] || { decimals: 2, rounding: 'math', incrementMinor: 1 };
  const decimals = options.priceDecimalPlaces ?? standard.decimals;
  const rounding = options.rounding ?? standard.rounding;
  const incrementMinor = options.incrementMinor ?? (decimals === 0 ? 100 : (options.priceDecimalPlaces !== undefined ? 10 ** (2 - options.priceDecimalPlaces) : standard.incrementMinor));
  return { currencyCode, decimals, rounding, incrementMinor };
}

export function resolveDiscountCap({ productCap = null, brandCap = null, categoryCap = null, priority = 'most_restrictive' }) {
  for (const [key, value] of Object.entries({ productCap, brandCap, categoryCap })) {
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
      throw new TypeError(`Invalid ${key}`);
    }
  }
  const normProduct = (productCap !== undefined && productCap !== null) ? productCap : null;
  const normBrand = (brandCap !== undefined && brandCap !== null) ? brandCap : null;
  const normCategory = (categoryCap !== undefined && categoryCap !== null) ? categoryCap : null;

  if (priority === 'hierarchy') {
    if (normProduct !== null) return normProduct;
    if (normBrand !== null) return normBrand;
    if (normCategory !== null) return normCategory;
    return null;
  }
  const caps = [normProduct, normCategory, normBrand].filter(value => value !== null);
  return caps.length ? caps.reduce((min, cur) => cur < min ? cur : min, caps[0]) : null;
}

export function calculateTierPrice({
  baseMinor,
  actionMinor = null,
  tierPercent = 0,
  fixedDiscountMinor = null,
  capPercent = null,
  productCap = null,
  brandCap = null,
  categoryCap = null,
  capPriority = 'most_restrictive',
  salePolicy = 'okfish_compatible',
  allowLoyaltyDiscount = true,
  rounding = 'math',
  incrementMinor = 1,
  minimumMinor = null
}) {
  const base = checkedMinor(baseMinor, 'baseMinor');
  const action = actionMinor === null ? null : checkedMinor(actionMinor, 'actionMinor');
  const fixed = fixedDiscountMinor === null ? null : checkedMinor(fixedDiscountMinor, 'fixedDiscountMinor');
  const tier = percentBps(tierPercent, 'tierPercent');

  let resolvedCap = capPercent;
  if (resolvedCap === null && (productCap !== null || brandCap !== null || categoryCap !== null)) {
    resolvedCap = resolveDiscountCap({ productCap, brandCap, categoryCap, priority: capPriority });
  }
  const cap = resolvedCap === null ? null : percentBps(resolvedCap, 'capPercent');

  if (!['okfish_compatible', 'lowest_price'].includes(salePolicy)) throw new TypeError('Invalid salePolicy');
  if (!['math', 'up', 'down', 'none'].includes(rounding)) throw new TypeError('Invalid rounding');
  const requestedStep = checkedMinor(incrementMinor, 'incrementMinor');
  const step = rounding === 'none' ? 1n : requestedStep;
  if (requestedStep < 1n) throw new TypeError('Invalid incrementMinor');

  const effectiveTier = allowLoyaltyDiscount ? (cap !== null && cap < tier ? cap : tier) : 0n;
  let loyalty = divideWithRounding(base * (10000n - effectiveTier), 10000n * step, rounding === 'none' ? 'math' : rounding) * step;

  if (fixed !== null && allowLoyaltyDiscount) {
    let fixedPrice = base > fixed ? base - fixed : 0n;
    fixedPrice = divideWithRounding(fixedPrice, step, rounding === 'none' ? 'math' : rounding) * step;
    loyalty = tier > 0n ? (loyalty < fixedPrice ? loyalty : fixedPrice) : fixedPrice;
    // Fixed discounts are subject to the same maximum discount cap as tier percentages.
    if (cap !== null) {
      const minimumFromCap = divideWithRounding(base * (10000n - cap), 10000n * step, 'up') * step;
      if (loyalty < minimumFromCap) loyalty = minimumFromCap;
    }
  }
  if (loyalty > base) loyalty = base;

  const validAction = action !== null && action < base ? action : null;
  let chosen = loyalty;

  if (salePolicy === 'okfish_compatible') {
    if (cap !== null && validAction !== null) {
      chosen = validAction;
    } else if (validAction !== null) {
      chosen = validAction < loyalty ? validAction : loyalty;
    }
  } else {
    chosen = (validAction !== null && validAction < loyalty) ? validAction : loyalty;
  }

  if (minimumMinor !== null) {
    const minFloor = checkedMinor(minimumMinor, 'minimumMinor');
    if (chosen < minFloor) chosen = minFloor;
  }

  return safeResult(chosen);
}

export function createPricelistPricePatch({ code, priceMinor, vatRate, includingVat = true, allowZeroPrice = false }) {
  if (typeof code !== 'string' || !code.trim()) throw new TypeError('Missing product code');
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new TypeError('Invalid price');
  if (priceMinor === 0 && !allowZeroPrice) throw new TypeError('Zero price requires explicit approval');
  if (typeof vatRate !== 'string' || !/^\d{1,2}\.\d{2}$/.test(vatRate)) throw new TypeError('Explicit VAT rate required');
  if (includingVat !== true) throw new TypeError('VAT-inclusive price required');
  const minor = BigInt(priceMinor);
  return { code, price: (minor / 100n).toString() + '.' + (minor % 100n).toString().padStart(2, '0'), includingVat: true, vatRate };
}
