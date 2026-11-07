// Pure coupon policy engine for Shoptet Marketplace B2C.
// Implements both 'percent-ceiling' and 'fixed-amount' modes with exact integer math.
// Follows TRANSFER_RULES.md, INC-003, and INC-011.

/**
 * Validates and converts a percentage (number, string, or BigInt bps) to exact integer basis points (0-10000).
 */
export function parsePercentBps(val, label = 'percent') {
  if (val === null || val === undefined) return null;
  if (typeof val === 'bigint') {
    if (val < 0n || val > 10000n) throw new TypeError(`Invalid ${label}: BigInt bps must be between 0 and 10000`);
    return val;
  }
  let str = null;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 0 || val > 100) {
      throw new TypeError(`Invalid ${label}: expected finite number 0-100`);
    }
    str = val.toString();
  } else if (typeof val === 'string') {
    str = val.trim();
  } else {
    throw new TypeError(`Invalid ${label}: unexpected type`);
  }

  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new TypeError(`Invalid ${label}: must be a non-negative decimal string`);
  }
  const parts = str.split('.');
  const intPart = BigInt(parts[0]);
  if (intPart > 100n || (intPart === 100n && parts[1] && /^0+$/.test(parts[1]) === false)) {
    throw new RangeError(`Invalid ${label}: out of range 0-100`);
  }
  if (intPart === 100n) return 10000n;

  const decPart = (parts[1] || '').slice(0, 4);
  const d0 = BigInt(decPart[0] || '0');
  const d1 = BigInt(decPart[1] || '0');
  const d2 = BigInt(decPart[2] || '0');

  let bps = intPart * 100n + d0 * 10n + d1;
  if (d2 >= 5n) {
    bps += 1n;
  }
  if (bps > 10000n) {
    throw new RangeError(`Invalid ${label}: out of range 0-100`);
  }
  return bps;
}

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
 * Resolves discount cap basis points adhering to capPriority ('hierarchy' vs 'most_restrictive').
 */
export function resolveCapBps({
  productCap = null,
  brandCap = null,
  categoryCaps = [],
  priority = 'most_restrictive'
}) {
  if (!['hierarchy', 'most_restrictive'].includes(priority)) {
    throw new TypeError(`Invalid capPriority: ${priority}`);
  }
  const pBps = parsePercentBps(productCap, 'productCap');
  const bBps = parsePercentBps(brandCap, 'brandCap');
  const catBpsList = (Array.isArray(categoryCaps) ? categoryCaps : [categoryCaps])
    .filter(c => c !== null && c !== undefined)
    .map(c => parsePercentBps(c, 'categoryCap'));

  if (priority === 'hierarchy') {
    if (pBps !== null) return pBps;
    if (bBps !== null) return bBps;
    if (catBpsList.length > 0) {
      return catBpsList.reduce((min, cur) => cur < min ? cur : min, catBpsList[0]);
    }
    return null;
  }

  const all = [pBps, bBps, ...catBpsList].filter(x => x !== null);
  return all.length ? all.reduce((min, cur) => cur < min ? cur : min, all[0]) : null;
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
  const ceilingBps = parsePercentBps(ceilingPercent, 'ceilingPercent');

  const lockedPricelistIds = new Set((config.lockedPricelistIds || []).map(Number));
  const lockedTierNames = new Set(config.lockedTierNames || []);
  const capPriority = config.capPriority || 'most_restrictive';
  if (!['hierarchy', 'most_restrictive'].includes(capPriority)) {
    throw new TypeError(`Invalid capPriority: ${capPriority}`);
  }

  return {
    mode,
    ceilingPercent,
    ceilingBps,
    lockedPricelistIds,
    lockedTierNames,
    capPriority,
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
  categoryCaps = [],
  capPriority = 'most_restrictive',
  hasActiveSale = false,
  manualCouponDisabled = false,
  minimumMinor = null
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
  if (minimumMinor !== null && (!Number.isSafeInteger(minimumMinor) || minimumMinor < 0)) {
    throw new TypeError('Invalid minimumMinor');
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

  // 3. Minimum price / margin floor protection
  // If tier price is already at or below the minimum margin floor, no further coupon discount can be allowed
  if (minimumMinor !== null && tierPriceMinor <= minimumMinor) {
    return {
      applyDiscountCoupon: false,
      minPriceRatio: null,
      reason: 'minimum_floor_exhausted'
    };
  }

  // Resolve active caps using shared priority (hierarchy vs most_restrictive)
  const allCatCaps = categoryCap !== null && categoryCap !== undefined ? [categoryCap, ...categoryCaps] : categoryCaps;
  const capBps = resolveCapBps({
    productCap,
    brandCap,
    categoryCaps: allCatCaps,
    priority: capPriority
  });

  // 4. Fixed-amount mode logic (ambassador / fixed coupons)
  if (mode === 'fixed-amount') {
    // Explicit zero cap: coupon ON with zero remaining room (ratio 1.000)
    if (capBps === 0n) {
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

    // Capped product or minimum price floor
    if (capBps !== null || minimumMinor !== null) {
      let floorBigInt = 0n;
      if (capBps !== null) {
        floorBigInt = (BigInt(baseMinor) * (10000n - capBps) + 9999n) / 10000n;
      }
      if (minimumMinor !== null && BigInt(minimumMinor) > floorBigInt) {
        floorBigInt = BigInt(minimumMinor);
      }
      const floorMinor = Number(floorBigInt);
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

  // 5. Percent-ceiling mode logic (standard percentage cap)
  const ceilingBps = parsePercentBps(ceilingPercent, 'ceilingPercent');
  const effectiveCeilingBps = capBps !== null ? (ceilingBps < capBps ? ceilingBps : capBps) : ceilingBps;

  // Minimum floor price allowed under ceiling
  let floorBigInt = (BigInt(baseMinor) * (10000n - effectiveCeilingBps) + 9999n) / 10000n;
  if (minimumMinor !== null && BigInt(minimumMinor) > floorBigInt) {
    floorBigInt = BigInt(minimumMinor);
  }
  const floorMinor = Number(floorBigInt);

  // If tier price is already at or below floor:
  if (tierPriceMinor <= floorMinor) {
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

