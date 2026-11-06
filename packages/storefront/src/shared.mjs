/**
 * Universal Storefront Shared Utilities
 * Used by all storefront scripts to handle multi-currency, translations,
 * and DOM navigation across any Shoptet store and template.
 */

export const I18N = {
  cs: {
    save: 'Ušetříte',
    savePercent: (pct) => `-${pct}%`,
    totalSave: 'Celkem ušetříte díky věrnostnímu programu:',
    standardPrice: 'Běžná cena:',
    loyaltyPrice: 'Věrnostní cena:',
    couponLocked: 'Váš nákup již obsahuje věrnostní slevu. Kombinace se slevovým kupónem není povolena.'
  },
  sk: {
    save: 'Ušetríte',
    savePercent: (pct) => `-${pct}%`,
    totalSave: 'Celkovo ušetríte vďaka vernostnému programu:',
    standardPrice: 'Bežná cena:',
    loyaltyPrice: 'Vernostná cena:',
    couponLocked: 'Váš nákup už obsahuje vernostnú zľavu. Kombinácia so zľavovým kupónom nie je povolená.'
  },
  en: {
    save: 'Save',
    savePercent: (pct) => `-${pct}%`,
    totalSave: 'Total savings with loyalty program:',
    standardPrice: 'Standard price:',
    loyaltyPrice: 'Loyalty price:',
    couponLocked: 'Your order already includes a loyalty discount. Discount coupon cannot be applied.'
  }
};

export function getLang(shoptetObj, docElem) {
  const lang = (shoptetObj?.config?.language || docElem?.lang || 'cs').toLowerCase();
  if (lang.startsWith('sk')) return 'sk';
  if (lang.startsWith('en')) return 'en';
  return 'cs';
}

export function translate(key, shoptetObj, docElem) {
  const l = getLang(shoptetObj, docElem);
  const dict = I18N[l] || I18N.cs;
  return dict[key] ?? I18N.cs[key] ?? '';
}

export function formatPrice(amount, shoptetObj) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  if (typeof shoptetObj?.helpers?.formatPrice === 'function') {
    try {
      return shoptetObj.helpers.formatPrice(amount);
    } catch {}
  }
  const curr = shoptetObj?.currency || {};
  const symbol = curr.symbol || 'Kč';
  const decimals = typeof curr.decimalPlaces === 'number' ? curr.decimalPlaces : 2;
  const decSep = curr.decimalSeparator || ',';
  const thouSep = curr.thousandSeparator || ' ';

  const parts = amount.toFixed(decimals).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thouSep);
  const formatted = parts.join(decSep);

  return curr.symbolPosition === 'left' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;
}

export function parsePrice(text) {
  if (!text || typeof text !== 'string') return NaN;
  const clean = text.replace(/[\s\u00A0]/g, '');
  const m = clean.match(/(\d+(?:[.,]\d+)*)/);
  if (!m) return NaN;
  let numStr = m[1];
  // If both thousand and decimal separators exist
  if (numStr.includes(',') && numStr.includes('.')) {
    if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
      // European format: 1.250,75 -> 1250.75
      numStr = numStr.replace(/\./g, '').replace(',', '.');
    } else {
      // US format: 1,250.75 -> 1250.75
      numStr = numStr.replace(/,/g, '');
    }
  } else if (numStr.includes(',')) {
    // Single comma: in CZK/EUR typically decimal separator (e.g. 12,99 or 1234,50)
    numStr = numStr.replace(',', '.');
  }
  const val = parseFloat(numStr);
  return Number.isFinite(val) ? val : NaN;
}

export function isCouponLocked({ tier, discountPct, config }) {
  if (!config) return false;
  if (!tier && (typeof discountPct !== 'number' || discountPct <= 0)) return false;

  // 1. Explicitly locked tiers
  if (Array.isArray(config.lockedTiers) && tier && config.lockedTiers.includes(tier)) {
    return true;
  }

  // 2. Minimum percentage threshold
  if (typeof config.minPercent === 'number' && config.minPercent > 0) {
    if (typeof discountPct === 'number' && discountPct >= config.minPercent) {
      return true;
    }
  }

  // 3. Top tiers lock
  if (config.topTiers && Array.isArray(config.allTiers) && config.allTiers.length > 0 && tier) {
    // If topTiers is true, top tier (or top 25% of tiers) are locked
    const topTierNames = config.allTiers
      .slice()
      .sort((a, b) => (b.percent || 0) - (a.percent || 0))
      .slice(0, Math.max(1, Math.ceil(config.allTiers.length * 0.25)))
      .map(t => t.name);
    if (topTierNames.includes(tier)) {
      return true;
    }
  }

  return false;
}
