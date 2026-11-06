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
const roundedRatio = (numerator, denominator) => (numerator + denominator / 2n) / denominator;

export function calculateTierPrice({ baseMinor, actionMinor = null, tierPercent = 0, fixedDiscountMinor = null, capPercent = null, salePolicy = 'okfish_compatible', allowLoyaltyDiscount = true }) {
  const base = checkedMinor(baseMinor, 'baseMinor');
  const action = actionMinor === null ? null : checkedMinor(actionMinor, 'actionMinor');
  const fixed = fixedDiscountMinor === null ? null : checkedMinor(fixedDiscountMinor, 'fixedDiscountMinor');
  const tier = percentBps(tierPercent, 'tierPercent');
  const cap = capPercent === null ? null : percentBps(capPercent, 'capPercent');
  if (!['okfish_compatible', 'lowest_price'].includes(salePolicy)) throw new TypeError('Invalid salePolicy');
  const effectiveTier = allowLoyaltyDiscount ? (cap !== null && cap < tier ? cap : tier) : 0n;
  let loyalty = roundedRatio(base * (10000n - effectiveTier), 10000n);
  if (fixed !== null && allowLoyaltyDiscount) {
    const fixedPrice = base > fixed ? base - fixed : 0n;
    loyalty = tier > 0n ? (loyalty < fixedPrice ? loyalty : fixedPrice) : fixedPrice;
    // Fixed discounts are subject to the same maximum discount as tier percentages.
    if (cap !== null) {
      const minimumFromCap = (base * (10000n - cap) + 9999n) / 10000n;
      if (loyalty < minimumFromCap) loyalty = minimumFromCap;
    }
  }
  const validAction = action !== null && action < base ? action : null;
  if (salePolicy === 'okfish_compatible' && cap !== null && validAction !== null) {
    return safeResult(validAction);
  }
  return safeResult(validAction !== null && validAction < loyalty ? validAction : loyalty);
}

export function resolveDiscountCap({ productCap = null, brandCap = null, categoryCap = null, priority = 'most_restrictive' }) {
  for (const [key, value] of Object.entries({productCap, brandCap, categoryCap})) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw new TypeError(`Invalid ${key}`);
  }
  if (priority === 'hierarchy') {
    if (productCap !== null) return productCap;
    if (brandCap !== null) return brandCap;
    if (categoryCap !== null) return categoryCap;
    return null;
  }
  const caps = [productCap, categoryCap, brandCap].filter(value => value !== null);
  return caps.length ? Math.min(...caps) : null;
}

export function createPricelistPricePatch({ code, priceMinor, vatRate, includingVat = true }) {
  if (typeof code !== 'string' || !code.trim()) throw new TypeError('Missing product code');
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new TypeError('Invalid price');
  if (typeof vatRate !== 'string' || !/^\d{1,2}\.\d{2}$/.test(vatRate)) throw new TypeError('Explicit VAT rate required');
  if (includingVat !== true) throw new TypeError('VAT-inclusive price required');
  const minor = BigInt(priceMinor);
  return { code, price: (minor / 100n).toString() + '.' + (minor % 100n).toString().padStart(2, '0'), includingVat: true, vatRate };
}
