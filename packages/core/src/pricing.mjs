// Pure pricing primitives. Monetary inputs are integer minor units (cents/halere).
// Aligned with OKfish decision logic supporting both okfish_compatible and lowest_price modes.
export function calculateTierPrice({ baseMinor, actionMinor = null, tierPercent = 0, fixedDiscountMinor = null, capPercent = null, salePolicy = 'okfish_compatible', allowLoyaltyDiscount = true }) {
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) throw new TypeError('Invalid baseMinor');
  if (actionMinor !== null && (!Number.isSafeInteger(actionMinor) || actionMinor < 0)) throw new TypeError('Invalid actionMinor');
  if (fixedDiscountMinor !== null && (!Number.isSafeInteger(fixedDiscountMinor) || fixedDiscountMinor < 0)) throw new TypeError('Invalid fixedDiscountMinor');
  for (const [key, value] of Object.entries({tierPercent, capPercent})) {
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) throw new TypeError(`Invalid ${key}`);
  }
  const effectiveTier = allowLoyaltyDiscount ? Math.min(tierPercent, capPercent ?? 100) : 0;
  let loyaltyMinor = Math.round(baseMinor * (1 - effectiveTier / 100));
  if (fixedDiscountMinor !== null && allowLoyaltyDiscount) {
    const fixedLoyalty = Math.max(0, baseMinor - fixedDiscountMinor);
    loyaltyMinor = tierPercent > 0 ? Math.min(loyaltyMinor, fixedLoyalty) : fixedLoyalty;
  }

  // Non-discount action price (action >= base) is ignored as a no-op leftover per OKfish
  const validAction = actionMinor !== null && actionMinor < baseMinor ? actionMinor : null;

  if (salePolicy === 'okfish_compatible') {
    // Režim OKFISH_COMPATIBLE: při aktivním stropu a akční ceně má akční cena absolutní přednost
    if (capPercent !== null && validAction !== null) {
      return validAction;
    }
  }

  // Existing action price is independently authoritative in lowest_price mode; choose lower price
  return Math.min(loyaltyMinor, validAction ?? baseMinor);
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
  return { code, price: (priceMinor / 100).toFixed(2), includingVat: true, vatRate };
}
