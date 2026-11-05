// Pure pricing primitives. Monetary inputs are integer minor units (cents/halere).
// This is a Marketplace reference implementation, not yet verified for parity with OKfish.
export function calculateTierPrice({ baseMinor, actionMinor = null, tierPercent, capPercent = null }) {
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) throw new TypeError('Invalid baseMinor');
  if (actionMinor !== null && (!Number.isSafeInteger(actionMinor) || actionMinor < 0)) throw new TypeError('Invalid actionMinor');
  for (const [key, value] of Object.entries({tierPercent, capPercent})) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw new TypeError(`Invalid ${key}`);
  }
  const effectiveTier = Math.min(tierPercent, capPercent ?? 100);
  const loyaltyMinor = Math.round(baseMinor * (1 - effectiveTier / 100));
  // Existing action price is independently authoritative; choose lower price.
  return Math.min(loyaltyMinor, actionMinor ?? baseMinor);
}

export function resolveDiscountCap({ productCap = null, brandCap = null, categoryCap = null }) {
  const caps = [productCap, categoryCap, brandCap].filter(value => value !== null);
  if (caps.some(value => !Number.isFinite(value) || value < 0 || value > 100)) throw new TypeError('Invalid discount cap');
  return caps.length ? Math.min(...caps) : null;
}

export function createPricelistPricePatch({ code, priceMinor, vatRate, includingVat = true }) {
  if (typeof code !== 'string' || !code.trim()) throw new TypeError('Missing product code');
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) throw new TypeError('Invalid price');
  if (typeof vatRate !== 'string' || !/^\d{1,2}\.\d{2}$/.test(vatRate)) throw new TypeError('Explicit VAT rate required');
  if (includingVat !== true) throw new TypeError('VAT-inclusive price required');
  return { code, price: (priceMinor / 100).toFixed(2), includingVat: true, vatRate };
}
