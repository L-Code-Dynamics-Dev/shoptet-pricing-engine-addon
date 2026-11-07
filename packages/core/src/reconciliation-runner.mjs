// Independent Read-Only Price and Coupon Reconciliation Runner for Shoptet Marketplace B2C.
// Adheres strictly to TRANSFER_RULES.md, INC-010, INC-011, and INC-012:
// - Separate price and coupon reconciliation jobs
// - Full-coverage self-check (zero drift on incomplete coverage != success)
// - Distinguishes MATCH, DRIFT, MISSING, SKIPPED, UNKNOWN
// - Auto-remediation strictly OFF by default

import { calculateTierPrice } from './pricing.mjs';
import { evaluateCouponSettings, normalizeCouponPolicy } from './coupon-engine.mjs';

/**
 * Validates self-check coverage against minimum expected cardinality.
 * Fails closed if unknown/duplicate data is encountered or valid coverage is insufficient.
 */
function evaluateSelfCheck({ totalChecked, validlyEvaluated, unknownCount = 0, minExpectedCombinations }) {
  if (unknownCount > 0) {
    return {
      passed: false,
      reason: `corrupt_or_duplicate_data_detected: ${unknownCount} unknown combinations encountered`
    };
  }
  if (minExpectedCombinations > 0 && validlyEvaluated < minExpectedCombinations) {
    return {
      passed: false,
      reason: `insufficient_coverage: evaluated ${validlyEvaluated} valid combinations, expected minimum ${minExpectedCombinations}`
    };
  }
  if (validlyEvaluated === 0 && minExpectedCombinations > 0) {
    return {
      passed: false,
      reason: 'zero_items_checked_when_cardinality_required'
    };
  }
  return { passed: true, reason: null };
}

/**
 * Read-only Price Reconciliation.
 * Reads actual stored prices, computes expected prices, and audits drift without writing.
 */
export async function reconcilePrices({
  adapter,
  shopId,
  policy,
  tiers = [],
  catalogProducts = [],
  pagination = null,
  minExpectedCombinations = 1
}) {
  const numShopId = Number(shopId);
  if (!Number.isSafeInteger(numShopId) || numShopId <= 0 || (typeof shopId !== 'number' && typeof shopId !== 'string') || (typeof shopId === 'string' && !/^\d+$/.test(shopId.trim()))) {
    throw new TypeError('Invalid shopId: must be positive numeric tenant ID');
  }
  if (!Array.isArray(tiers) || tiers.length === 0) throw new TypeError('Tiers must be non-empty array');

  // Verify pagination completeness (INC-012)
  const isTruncated = Boolean(
    pagination && (
      pagination.isComplete === false ||
      (pagination.pageCount > 1 && pagination.page !== undefined && pagination.page < pagination.pageCount)
    )
  );

  const counts = { total: 0, match: 0, drift: 0, missing: 0, skipped: 0, unknown: 0 };
  const drifts = [];
  const checkedProducts = new Set();
  const checkedPricelists = new Set();
  const seenVariantCodes = new Set();

  for (const product of catalogProducts) {
    checkedProducts.add(product.guid);

    if (product.visibility !== 'normal' && product.visibility !== undefined) {
      counts.skipped += (product.variants?.length || 1) * tiers.length;
      continue;
    }

    const brandCap = policy?.brandCaps?.find(b => b.id === product.brandId)?.percent ?? null;
    const categoryCaps = policy?.categoryCaps?.filter(c => (product.categoryIds || []).includes(c.id)).map(c => c.percent) || [];
    const productCap = policy?.productCaps?.find(p => p.id === product.guid)?.percent ?? null;

    for (const variant of (product.variants || [])) {
      const code = variant.code;
      if (!variant.visible && variant.visible !== undefined) {
        counts.skipped += tiers.length;
        continue;
      }

      // Duplicate variant detection (INC-010)
      if (seenVariantCodes.has(code)) {
        for (const tier of tiers) {
          counts.total++;
          counts.unknown++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            status: 'UNKNOWN',
            reason: 'duplicate_variant_code',
            expected: null,
            actual: null
          });
        }
        continue;
      }
      seenVariantCodes.add(code);

      // Read base price from default pricelist
      const baseMinor = variant.basePriceMinor;
      if (!Number.isSafeInteger(baseMinor) || baseMinor <= 0) {
        for (const tier of tiers) {
          counts.total++;
          counts.unknown++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            status: 'UNKNOWN',
            reason: 'missing_or_invalid_base_price',
            expected: null,
            actual: null
          });
        }
        continue;
      }

      const actionMinor = variant.actionPriceMinor ?? null;

      for (const tier of tiers) {
        counts.total++;
        checkedPricelists.add(tier.pricelistId);

        const expectedMinor = calculateTierPrice({
          baseMinor,
          actionMinor,
          tierPercent: tier.percent,
          productCap,
          brandCap,
          categoryCaps,
          categoryCap: categoryCaps.length ? Math.min(...categoryCaps) : null,
          capPriority: policy?.capPriority ?? 'most_restrictive',
          salePolicy: policy?.salePolicy ?? 'okfish_compatible',
          minimumMinor: variant.minimumMinor ?? product.minimumMinor ?? policy?.minimumMinor ?? null
        });

        // Actual price in target pricelist
        const actualEntry = variant.perPricelistPrices?.[tier.pricelistId];
        if (actualEntry === undefined || actualEntry === null) {
          counts.missing++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            tierName: tier.name,
            status: 'MISSING',
            reason: 'tier_price_missing_in_shoptet',
            expected: expectedMinor,
            actual: null
          });
          continue;
        }

        const actualMinor = actualEntry.priceMinor;
        if (actualMinor === expectedMinor) {
          counts.match++;
        } else {
          counts.drift++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            tierName: tier.name,
            status: 'DRIFT',
            reason: 'price_mismatch',
            expected: expectedMinor,
            actual: actualMinor,
            deltaMinor: actualMinor - expectedMinor
          });
        }
      }
    }
  }

  let selfCheck = evaluateSelfCheck({
    totalChecked: counts.total,
    validlyEvaluated: counts.match + counts.drift + counts.missing,
    unknownCount: counts.unknown,
    minExpectedCombinations
  });

  if (isTruncated) {
    selfCheck = {
      passed: false,
      reason: 'incomplete_pagination_truncated_run'
    };
  }

  return {
    shopId,
    type: 'price',
    timestamp: new Date().toISOString(),
    policyVersion: policy?.version ?? 1,
    counts,
    selfCheckPassed: selfCheck.passed,
    selfCheckReason: selfCheck.reason,
    cardinality: {
      productsChecked: checkedProducts.size,
      pricelistsChecked: checkedPricelists.size,
      combinationsChecked: counts.total,
      combinationsValid: counts.match + counts.drift + counts.missing,
      minExpected: minExpectedCombinations
    },
    remediationMode: 'OFF',
    drifts
  };
}

/**
 * Read-only Coupon Reconciliation.
 * Reads actual discountCoupon and minPriceRatio, computes expected values, and audits drift without writing.
 */
export async function reconcileCoupons({
  adapter,
  shopId,
  couponConfig = {},
  tiers = [],
  catalogProducts = [],
  pagination = null,
  minExpectedCombinations = 1
}) {
  const numShopId = Number(shopId);
  if (!Number.isSafeInteger(numShopId) || numShopId <= 0 || (typeof shopId !== 'number' && typeof shopId !== 'string') || (typeof shopId === 'string' && !/^\d+$/.test(shopId.trim()))) {
    throw new TypeError('Invalid shopId: must be positive numeric tenant ID');
  }
  if (!Array.isArray(tiers) || tiers.length === 0) throw new TypeError('Tiers must be non-empty array');

  // Verify pagination completeness (INC-012)
  const isTruncated = Boolean(
    pagination && (
      pagination.isComplete === false ||
      (pagination.pageCount > 1 && pagination.page !== undefined && pagination.page < pagination.pageCount)
    )
  );

  const couponPolicy = normalizeCouponPolicy(couponConfig);
  const counts = { total: 0, match: 0, drift: 0, missing: 0, skipped: 0, unknown: 0 };
  const drifts = [];
  const checkedProducts = new Set();
  const checkedPricelists = new Set();
  const seenVariantCodes = new Set();

  for (const product of catalogProducts) {
    checkedProducts.add(product.guid);

    if (product.visibility !== 'normal' && product.visibility !== undefined) {
      counts.skipped += (product.variants?.length || 1) * tiers.length;
      continue;
    }

    const productCap = product.productCap ?? null;
    const brandCap = product.brandCap ?? null;
    const categoryCaps = product.categoryCaps ?? [];
    const manualCouponDisabled = product.manualCouponDisabled === true;

    for (const variant of (product.variants || [])) {
      const code = variant.code;
      if (!variant.visible && variant.visible !== undefined) {
        counts.skipped += tiers.length;
        continue;
      }

      // Duplicate variant detection (INC-010)
      if (seenVariantCodes.has(code)) {
        for (const tier of tiers) {
          counts.total++;
          counts.unknown++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            status: 'UNKNOWN',
            reason: 'duplicate_variant_code',
            expected: null,
            actual: null
          });
        }
        continue;
      }
      seenVariantCodes.add(code);

      const baseMinor = variant.basePriceMinor;
      if (!Number.isSafeInteger(baseMinor) || baseMinor <= 0) {
        for (const tier of tiers) {
          counts.total++;
          counts.unknown++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            status: 'UNKNOWN',
            reason: 'missing_base_price',
            expected: null,
            actual: null
          });
        }
        continue;
      }

      for (const tier of tiers) {
        counts.total++;
        checkedPricelists.add(tier.pricelistId);

        const isLocked = couponPolicy.lockedPricelistIds.has(tier.pricelistId) ||
                         couponPolicy.lockedTierNames.has(tier.name);

        const actualEntry = variant.perPricelistPrices?.[tier.pricelistId];
        if (!actualEntry) {
          counts.missing++;
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            tierName: tier.name,
            status: 'MISSING',
            reason: 'tier_entry_missing',
            expected: null,
            actual: null
          });
          continue;
        }

        const tierPriceMinor = actualEntry.priceMinor;
        const expected = evaluateCouponSettings({
          mode: couponPolicy.mode,
          ceilingPercent: couponPolicy.ceilingPercent,
          isLocked,
          baseMinor,
          tierPriceMinor,
          productCap,
          brandCap,
          categoryCaps,
          capPriority: couponPolicy.capPriority,
          hasActiveSale: Boolean(variant.actionPriceMinor),
          manualCouponDisabled,
          minimumMinor: variant.minimumMinor ?? product.minimumMinor ?? couponPolicy.minimumMinor ?? null
        });

        const actualCoupon = actualEntry.sales?.discountCoupon ?? true;
        const actualRatio = actualEntry.sales?.minPriceRatio ?? null;

        const couponMatches = actualCoupon === expected.applyDiscountCoupon;
        const ratioMatches = actualRatio === expected.minPriceRatio;

        if (couponMatches && ratioMatches) {
          counts.match++;
        } else {
          counts.drift++;
          let driftType = 'coupon_config_drift';
          if (isLocked && actualCoupon === true) {
            driftType = 'INC-011_lock_violation';
          }
          drifts.push({
            code,
            targetPricelistId: tier.pricelistId,
            tierName: tier.name,
            status: 'DRIFT',
            reason: driftType,
            expected: {
              discountCoupon: expected.applyDiscountCoupon,
              minPriceRatio: expected.minPriceRatio
            },
            actual: {
              discountCoupon: actualCoupon,
              minPriceRatio: actualRatio
            }
          });
        }
      }
    }
  }

  let selfCheck = evaluateSelfCheck({
    totalChecked: counts.total,
    validlyEvaluated: counts.match + counts.drift + counts.missing,
    unknownCount: counts.unknown,
    minExpectedCombinations
  });

  if (isTruncated) {
    selfCheck = {
      passed: false,
      reason: 'incomplete_pagination_truncated_run'
    };
  }

  return {
    shopId,
    type: 'coupon',
    timestamp: new Date().toISOString(),
    policyMode: couponPolicy.mode,
    counts,
    selfCheckPassed: selfCheck.passed,
    selfCheckReason: selfCheck.reason,
    cardinality: {
      productsChecked: checkedProducts.size,
      pricelistsChecked: checkedPricelists.size,
      combinationsChecked: counts.total,
      combinationsValid: counts.match + counts.drift + counts.missing,
      minExpected: minExpectedCombinations
    },
    remediationMode: 'OFF',
    drifts
  };
}
