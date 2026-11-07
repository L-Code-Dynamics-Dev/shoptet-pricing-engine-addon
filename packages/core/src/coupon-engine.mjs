// Pure coupon policy engine for Shoptet Marketplace B2C.
// Implements both 'percent-ceiling' and 'fixed-amount' modes with exact integer math.
// Follows TRANSFER_RULES.md, INC-003, and INC-011.

/**
 * Exact 3-decimal place ratio calculation relative to stored tier price:
 * ratio = floorPrice / tierPrice (rounded half up).
 * Clamped between 0.000 and 1.000.
 */
export function formatPriceRatio(floorMinor, tierPriceMinor) {
  if (!Number.isSafeInteger(floorMinor) || floorMinor < 0) throw new TypeError('Invalid floorMinor');
  if (!Number.isSafeInteger(tierPriceMinor) || tierPriceMinor <= 0) throw new TypeError('Invalid tierPriceMinor');

  const f = BigInt(floorMinor);
  const t = BigInt(tierPriceMinor);

  if (f >= t) return '1.000';
  if (f === 0n) return '0.000';

  // ROUND_HALF_UP to 3 decimal places:
  // (f * 2000n + t) / (2n * t) gives thousandths
  const thousandths = (f * 2000n + t) / (2n * t);
  const clamped = thousandths > 1000n ? 1000n : thousandths;

  const intPart = clamped / 1000n;
  const decPart = clamped % 1000n;
  return `${intPart}.${String(decPart).padStart(3, '0')}`;
}

/**
 * Validates and normalizes coupon policy configuration.
 */
export function normalizeCouponPolicy(config = {}) {
  const mode = config.mode || 'percent-ceiling';
  if (!['percent-ceiling', 'fixed-amount'].includes(mode)) {
    throw new TypeError(`Invalid coupon mode: ${mode}`);
  }

  const ceilingPercent = config.ceilingPercent ?? 20;
  if (typeof ceilingPercent !== 'number' || ceilingPercent < 0 || ceilingPercent > 100) {
    throw new TypeError('Invalid ceilingPercent: expected 0-100');
  }

  const lockedPricelistIds = new Set((config.lockedPricelistIds || []).map(Number));
  const lockedTierNames = new Set(config.lockedTierNames || []);

  return {
    mode,
    ceilingPercent,
    lockedPricelistIds,
    lockedTierNames,
    defaultPricelistId: config.defaultPricelistId ?? 1
  };
}

/**
 * Evaluates coupon state and minPriceRatio for a variant on a specific pricelist tier.
 */
export function evaluateCouponSettings({
  mode = 'percent-ceiling',
  ceilingPercent = 20,
  isLocked = false,
  baseMinor,
  tierPriceMinor,
  productCap = null,
  brandCap = null,
  categoryCap = null,
  hasActiveSale = false,
  manualCouponDisabled = false
}) {
  if (!['percent-ceiling', 'fixed-amount'].includes(mode)) {
    throw new TypeError(`Invalid coupon mode: ${mode}`);
  }
  if (!Number.isSafeInteger(baseMinor) || baseMinor <= 0) {
    throw new TypeError('Invalid baseMinor');
  }
  if (!Number.isSafeInteger(tierPriceMinor) || tierPriceMinor <= 0) {
    throw new TypeError('Invalid tierPriceMinor');
  }

  // 1. Tier lock rule: locked tiers NEVER get coupons
  if (isLocked) {
    return {
      applyDiscountCoupon: false,
      minPriceRatio: null,
      reason: 'tier_locked'
    };
  }

  // 2. Manual disable rule (product or brand manual coupon disable)
  if (manualCouponDisabled) {
    return {
      applyDiscountCoupon: false,
      minPriceRatio: null,
      reason: 'manual_disabled'
    };
  }

  // Resolve active caps (precedence: product -> brand -> category)
  const activeCaps = [productCap, brandCap, categoryCap].filter(c => c !== null && c !== undefined);
  const minCap = activeCaps.length ? Math.min(...activeCaps) : null;

  // 3. Fixed-amount mode logic (ambassador / fixed coupons)
  if (mode === 'fixed-amount') {
    // Explicit zero cap: coupon ON with zero remaining room (ratio 1.000)
    if (minCap === 0) {
      return {
        applyDiscountCoupon: true,
        minPriceRatio: '1.000',
        reason: 'explicit_zero_cap'
      };
    }

    // Existing sale or action price: coupon ON with zero remaining room (ratio 1.000)
    if (hasActiveSale) {
      return {
        applyDiscountCoupon: true,
        minPriceRatio: '1.000',
        reason: 'sale_action_floor'
      };
    }

    // Capped product: floor price is determined by the cap on base price
    if (minCap !== null) {
      const capBps = BigInt(Math.round(minCap * 100));
      const floorMinor = Number((BigInt(baseMinor) * (10000n - capBps) + 9999n) / 10000n);
      const ratio = formatPriceRatio(floorMinor, tierPriceMinor);
      return {
        applyDiscountCoupon: true,
        minPriceRatio: ratio,
        reason: 'cap_constrained'
      };
    }

    // Unrestricted: coupon ON, no additional ratio floor
    return {
      applyDiscountCoupon: true,
      minPriceRatio: null,
      reason: 'unrestricted'
    };
  }

  // 4. Percent-ceiling mode logic (standard percentage cap)
  // Max total discount cannot exceed ceilingPercent or minCap
  const effectiveCeiling = minCap !== null ? Math.min(ceilingPercent, minCap) : ceilingPercent;
  const ceilingBps = BigInt(Math.round(effectiveCeiling * 100));

  // Minimum floor price allowed under ceiling
  const floorMinor = Number((BigInt(baseMinor) * (10000n - ceilingBps) + 9999n) / 10000n);

  // If tier price is already at or below floor:
  if (tierPriceMinor <= floorMinor) {
    // Zero headroom remaining under ceiling
    return {
      applyDiscountCoupon: false,
      minPriceRatio: null,
      reason: 'ceiling_exhausted_by_tier'
    };
  }

  // If sale/action already exists:
  if (hasActiveSale) {
    return {
      applyDiscountCoupon: true,
      minPriceRatio: '1.000',
      reason: 'sale_action_floor'
    };
  }

  // Remaining headroom: ratio relative to stored tier price
  const ratio = formatPriceRatio(floorMinor, tierPriceMinor);
  return {
    applyDiscountCoupon: true,
    minPriceRatio: ratio,
    reason: 'ceiling_headroom'
  };
}

/**
 * Creates Shoptet price patch for coupon settings.
 * INC-003: Strictly forbids modifying base / main pricelist!
 */
export function createPricelistCouponPatch({
  targetPricelistId,
  defaultPricelistId = 1,
  code,
  applyDiscountCoupon,
  minPriceRatio = null
}) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new TypeError('Missing variant code');
  }
  if (!Number.isSafeInteger(targetPricelistId) || targetPricelistId <= 0) {
    throw new TypeError('Invalid targetPricelistId');
  }
  if (targetPricelistId === defaultPricelistId) {
    // INC-003 invariant: Main pricelist product discount caps must NEVER be overwritten by coupon sync!
    throw new Error('main_pricelist_coupon_write_forbidden');
  }
  if (typeof applyDiscountCoupon !== 'boolean') {
    throw new TypeError('applyDiscountCoupon must be boolean');
  }
  if (minPriceRatio !== null && (typeof minPriceRatio !== 'string' || !/^\d\.\d{3}$/.test(minPriceRatio))) {
    throw new TypeError('Invalid minPriceRatio: expected string with 3 decimal places (e.g. 0.889) or null');
  }

  return {
    code,
    sales: {
      discountCoupon: applyDiscountCoupon,
      ...(minPriceRatio !== null ? { minPriceRatio } : {})
    }
  };
}
