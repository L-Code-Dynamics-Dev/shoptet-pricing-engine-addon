// Scheduled promotions and clearance sales with date windows (from-to).
// Implements exact BigInt minor-unit arithmetic, time-window evaluation, and HighestDiscountPolicy compliance.

const money = (n, label) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`Invalid ${label}`);
  return BigInt(n);
};

const percentBps = (p, label) => {
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p >= 100) {
    throw new TypeError(`Sleva musí být číslo větší než 0 a menší než 100 % (${label})`);
  }
  const rounded = Number(p.toFixed(2));
  if (Math.abs(rounded - p) > 1e-9) {
    throw new TypeError(`Sleva může mít maximálně 2 desetinná místa (${label})`);
  }
  return BigInt(Math.round(p * 100));
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates whether a date string is YYYY-MM-DD.
 */
export function isValidDateString(str) {
  if (typeof str !== 'string' || !DATE_REGEX.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

/**
 * Checks whether a promotion with optional validFrom and validTo is currently active.
 * - validFrom: start date (inclusive, 00:00:00.000Z)
 * - validTo: end date (inclusive, 23:59:59.999Z)
 * - now: reference timestamp (Date object or ISO string, defaults to current time)
 */
export function isPromotionActive({ validFrom = null, validTo = null, now = new Date() }) {
  const currentDate = typeof now === 'string' ? new Date(now) : now;
  if (isNaN(currentDate.getTime())) throw new TypeError('Neplatný referenční čas');

  const hasFrom = validFrom !== null && validFrom !== undefined && validFrom !== '';
  const hasTo = validTo !== null && validTo !== undefined && validTo !== '';

  if (hasFrom && !isValidDateString(validFrom)) {
    throw new TypeError(`Neplatné datum začátku akce (očekáván formát RRRR-MM-DD): ${validFrom}`);
  }
  if (hasTo && !isValidDateString(validTo)) {
    throw new TypeError(`Neplatné datum konce akce (očekáván formát RRRR-MM-DD): ${validTo}`);
  }
  if (hasFrom && hasTo && validFrom > validTo) {
    throw new TypeError(`Datum začátku akce (${validFrom}) nesmí být po datu konce (${validTo})`);
  }

  if (hasFrom) {
    const fromDate = new Date(validFrom + 'T00:00:00.000Z');
    if (currentDate < fromDate) return false;
  }

  if (hasTo) {
    const toDate = new Date(validTo + 'T23:59:59.999Z');
    if (currentDate > toDate) return false;
  }

  return true;
}

/**
 * Validates a single product promotion / clearance entry.
 */
export function validateProductPromotion(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { error: 'Neplatná položka výprodeje' };
  }
  const code = typeof item.code === 'string' ? item.code.trim() : '';
  if (!code || code.length > 64) {
    return { error: 'Kód produktu musí mít 1–64 znaků' };
  }
  const discountPercent = Number(item.discountPercent);
  if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent >= 100) {
    return { error: `Sleva pro produkt "${code}" musí být v rozmezí 0,01–99,99 %` };
  }
  if (Math.abs(Math.round(discountPercent * 100) - discountPercent * 100) > 1e-9) {
    return { error: `Sleva pro produkt "${code}" může mít maximálně 2 desetinná místa` };
  }
  const validFrom = item.validFrom ? String(item.validFrom).trim() : null;
  const validTo = item.validTo ? String(item.validTo).trim() : null;

  if (validFrom && !isValidDateString(validFrom)) {
    return { error: `Datum začátku akce pro produkt "${code}" musí být ve formátu RRRR-MM-DD` };
  }
  if (validTo && !isValidDateString(validTo)) {
    return { error: `Datum konce akce pro produkt "${code}" musí být ve formátu RRRR-MM-DD` };
  }
  if (validFrom && validTo && validFrom > validTo) {
    return { error: `Datum začátku (${validFrom}) nesmí být po datu konce (${validTo}) pro produkt "${code}"` };
  }

  return {
    item: {
      code,
      discountPercent,
      ...(validFrom ? { validFrom } : {}),
      ...(validTo ? { validTo } : {}),
      ...(item.note ? { note: String(item.note).trim().slice(0, 200) } : {})
    }
  };
}

/**
 * Validates a single brand-wide promotion entry.
 */
export function validateBrandPromotion(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { error: 'Neplatná položka akce na značku' };
  }
  const brand = typeof item.brand === 'string' ? item.brand.trim() : '';
  if (!brand || brand.length > 100) {
    return { error: 'Název značky musí mít 1–100 znaků' };
  }
  const discountPercent = Number(item.discountPercent);
  if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent >= 100) {
    return { error: `Akční sleva pro značku "${brand}" musí být v rozmezí 0,01–99,99 %` };
  }
  if (Math.abs(Math.round(discountPercent * 100) - discountPercent * 100) > 1e-9) {
    return { error: `Akční sleva pro značku "${brand}" může mít maximálně 2 desetinná místa` };
  }
  const validFrom = item.validFrom ? String(item.validFrom).trim() : null;
  const validTo = item.validTo ? String(item.validTo).trim() : null;

  if (validFrom && !isValidDateString(validFrom)) {
    return { error: `Datum začátku akce pro značku "${brand}" musí být ve formátu RRRR-MM-DD` };
  }
  if (validTo && !isValidDateString(validTo)) {
    return { error: `Datum konce akce pro značku "${brand}" musí být ve formátu RRRR-MM-DD` };
  }
  if (validFrom && validTo && validFrom > validTo) {
    return { error: `Datum začátku (${validFrom}) nesmí být po datu konce (${validTo}) pro značku "${brand}"` };
  }

  return {
    item: {
      brand,
      discountPercent,
      ...(validFrom ? { validFrom } : {}),
      ...(validTo ? { validTo } : {}),
      ...(item.note ? { note: String(item.note).trim().slice(0, 200) } : {})
    }
  };
}

/**
 * Resolves active promotion/clearance action price for a given variant and base price.
 * HighestDiscountPolicy: returns synthesized action price in minor units or null if no promotion active.
 */
export function resolveScheduledPromotionActionMinor({
  baseMinor,
  code,
  brand = null,
  productPromotions = [],
  brandPromotions = [],
  now = new Date()
}) {
  const base = money(baseMinor, 'baseMinor');
  if (base === 0n) return null;

  let activeDiscountPercent = null;

  // 1. Direct product-level promotion / clearance (highest priority)
  if (Array.isArray(productPromotions) && typeof code === 'string' && code.trim()) {
    const cleanCode = code.trim().toLowerCase();
    const productPromo = productPromotions.find(p => p.code && p.code.trim().toLowerCase() === cleanCode);
    if (productPromo && isPromotionActive({ validFrom: productPromo.validFrom, validTo: productPromo.validTo, now })) {
      activeDiscountPercent = productPromo.discountPercent;
    }
  }

  // 2. Brand-level promotion (fallback if no direct product promo)
  if (activeDiscountPercent === null && Array.isArray(brandPromotions) && typeof brand === 'string' && brand.trim()) {
    const cleanBrand = brand.trim().toLowerCase();
    const brandPromo = brandPromotions.find(b => b.brand && b.brand.trim().toLowerCase() === cleanBrand);
    if (brandPromo && isPromotionActive({ validFrom: brandPromo.validFrom, validTo: brandPromo.validTo, now })) {
      activeDiscountPercent = brandPromo.discountPercent;
    }
  }

  if (activeDiscountPercent === null) return null;

  const bps = percentBps(activeDiscountPercent, 'activeDiscountPercent');
  const promoActionMinor = (base * (10000n - bps) + 5000n) / 10000n;

  if (promoActionMinor >= base) return null;
  return Number(promoActionMinor);
}
