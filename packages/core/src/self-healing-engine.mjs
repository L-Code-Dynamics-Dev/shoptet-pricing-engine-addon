// Self-healing safety state machine and eligibility contract for Shoptet Marketplace B2C.
// References: references/self-healing-design.md, INC-003, INC-004, INC-008, INC-011, INC-016.
// STRICT INVARIANT: AUTO remediation is OFF by default. No live production writes without merchant authorization.

export const REMEDIATION_STATES = Object.freeze([
  'DETECTED',
  'CONFIRMED',
  'PLANNED',
  'AUTHORIZED',
  'WRITING',
  'VERIFYING',
  'RESOLVED',
  'UNCERTAIN',
  'RETRYABLE',
  'ESCALATED',
  'BLOCKED'
]);

export const VALID_DRIFT_TYPES = Object.freeze([
  'price_drift',
  'coupon_drift',
  'locked_tier_violation'
]);

export const MANAGED_FIELDS = Object.freeze([
  'price',
  'commonPrice',
  'discountCoupon',
  'minPriceRatio'
]);

/**
 * Deep freezes an object and all nested properties recursively.
 */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = obj[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Classifies whether a confirmed reconciliation drift item is eligible for AUTO, REVIEW, or BLOCK.
 * Fail-closed invariant: AUTO is strictly disabled by default (autoEnabled = false).
 * Enforces strict allowlist and evidence validation (K1).
 */
export function classifyRemediationEligibility({
  item,
  selfCheckPassed = false,
  autoEnabled = false,
  verifiedTenantShopId = null,
  managedPricelistIds = null,
  activeInstallGeneration = null,
  installGeneration = null,
  approvalId = null,
  hasConcurrentWriter = false,
  isProtectedPricelist = false,
  hasManualSaleConflict = false,
  hasMissingCostOrVat = false,
  policyVersionMismatch = false,
  circuitBreakerOpen = false
}) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('Invalid drift item: must be an object');
  }

  // 1. Strict Item Evidence & Allowlist Validation (K1)
  const shopIdStr = item.shopId !== undefined && item.shopId !== null ? String(item.shopId).trim() : '';
  if (!shopIdStr || !/^\d+$/.test(shopIdStr)) {
    return {
      decision: 'BLOCK',
      reason: 'missing_or_invalid_item_shop_id',
      canAutoRemediate: false
    };
  }

  if (verifiedTenantShopId !== null && String(verifiedTenantShopId).trim() !== shopIdStr) {
    return {
      decision: 'BLOCK',
      reason: 'tenant_shop_id_mismatch',
      canAutoRemediate: false
    };
  }

  if (typeof item.variantCode !== 'string' || !item.variantCode.trim()) {
    return {
      decision: 'BLOCK',
      reason: 'missing_variant_code',
      canAutoRemediate: false
    };
  }

  if (!Number.isSafeInteger(item.pricelistId) || item.pricelistId <= 0) {
    return {
      decision: 'BLOCK',
      reason: 'missing_or_invalid_pricelist_id',
      canAutoRemediate: false
    };
  }

  if (managedPricelistIds !== null) {
    const idSet = managedPricelistIds instanceof Set ? managedPricelistIds : new Set(managedPricelistIds);
    if (!idSet.has(item.pricelistId)) {
      return {
        decision: 'BLOCK',
        reason: 'unmanaged_pricelist_id',
        canAutoRemediate: false
      };
    }
  }

  if (!MANAGED_FIELDS.includes(item.field)) {
    return {
      decision: 'BLOCK',
      reason: 'unmanaged_field',
      canAutoRemediate: false
    };
  }

  if (item.driftType !== undefined && !VALID_DRIFT_TYPES.includes(item.driftType)) {
    return {
      decision: 'BLOCK',
      reason: 'unknown_drift_type',
      canAutoRemediate: false
    };
  }

  if (activeInstallGeneration !== null && installGeneration !== null && activeInstallGeneration !== installGeneration) {
    return {
      decision: 'BLOCK',
      reason: 'stale_install_generation',
      canAutoRemediate: false
    };
  }

  // 2. BLOCK conditions (hard safety violations)
  if (!selfCheckPassed) {
    return {
      decision: 'BLOCK',
      reason: 'reconciliation_self_check_failed',
      canAutoRemediate: false
    };
  }

  if (circuitBreakerOpen) {
    return {
      decision: 'BLOCK',
      reason: 'circuit_breaker_tripped',
      canAutoRemediate: false
    };
  }

  if (hasConcurrentWriter) {
    return {
      decision: 'BLOCK',
      reason: 'concurrent_writer_detected',
      canAutoRemediate: false
    };
  }

  if (policyVersionMismatch) {
    return {
      decision: 'BLOCK',
      reason: 'policy_version_mismatch',
      canAutoRemediate: false
    };
  }

  if (isProtectedPricelist) {
    return {
      decision: 'BLOCK',
      reason: 'protected_pricelist_mutation_forbidden',
      canAutoRemediate: false
    };
  }

  // 3. REVIEW conditions (requires manual merchant inspection / approval)
  if (hasMissingCostOrVat) {
    return {
      decision: 'REVIEW',
      reason: 'missing_cost_or_vat_requires_merchant_review',
      canAutoRemediate: false
    };
  }

  if (hasManualSaleConflict) {
    return {
      decision: 'REVIEW',
      reason: 'manual_sale_conflict_requires_merchant_review',
      canAutoRemediate: false
    };
  }

  if (!approvalId || typeof approvalId !== 'string' || !approvalId.trim()) {
    return {
      decision: 'REVIEW',
      reason: 'missing_merchant_approval_token',
      canAutoRemediate: false
    };
  }

  // 4. AUTO OFF by default (safety invariant)
  if (!autoEnabled) {
    return {
      decision: 'REVIEW',
      reason: 'auto_remediation_disabled_by_default',
      canAutoRemediate: false
    };
  }

  // 5. AUTO eligible (strictly bounded managed tier or coupon lock repair)
  return {
    decision: 'AUTO',
    reason: 'eligible_for_safe_automated_remediation',
    canAutoRemediate: true
  };
}

/**
 * State machine transition function for remediation lifecycle.
 * Follows strict progression: DETECTED -> CONFIRMED -> PLANNED -> AUTHORIZED -> WRITING -> VERIFYING -> RESOLVED (K2).
 */
export function transitionRemediationState(currentState, event, context = {}) {
  if (!REMEDIATION_STATES.includes(currentState)) {
    throw new TypeError(`Invalid currentState: ${currentState}`);
  }

  const {
    approvalId = null,
    attempts = 0,
    maxRetries = 3,
    error = null,
    verified = false,
    readbackProof = null
  } = context;

  // Immediate universal abort events
  if (event === 'BLOCK') {
    return { state: 'BLOCKED', reason: context.reason || 'manual_or_policy_block' };
  }
  if (event === 'POLICY_CHANGED') {
    return { state: 'BLOCKED', reason: 'policy_version_invalidated_stale_plan' };
  }

  switch (currentState) {
    case 'DETECTED':
      if (event === 'CONFIRM') return { state: 'CONFIRMED' };
      break;

    case 'CONFIRMED':
      if (event === 'PLAN') return { state: 'PLANNED' };
      break;

    case 'PLANNED':
      if (event === 'AUTHORIZE') {
        if (!approvalId || typeof approvalId !== 'string' || !approvalId.trim()) {
          return { state: 'BLOCKED', reason: 'missing_valid_merchant_approval' };
        }
        return { state: 'AUTHORIZED', approvalId: approvalId.trim() };
      }
      break;

    case 'AUTHORIZED':
      if (event === 'START_WRITE') return { state: 'WRITING' };
      break;

    case 'WRITING':
      if (event === 'TIMEOUT' || event === 'NETWORK_UNCERTAIN') {
        return {
          state: 'UNCERTAIN',
          reason: 'write_outcome_uncertain_quarantine_required',
          requiresReadback: true
        };
      }
      // Strict progression (K2): WRITING moves to VERIFYING upon write confirmation, not directly to RESOLVED!
      if (event === 'WRITE_CONFIRMED') {
        return { state: 'VERIFYING', writeTimestamp: context.writeTimestamp || Date.now() };
      }
      break;

    case 'VERIFYING':
      if (event === 'READBACK_CONFIRMED_MATCH') {
        if (!verified || !readbackProof) {
          return { state: 'BLOCKED', reason: 'readback_verification_proof_missing' };
        }
        return { state: 'RESOLVED', verified: true, readbackProof };
      }
      if (event === 'READBACK_MISMATCH' || event === 'VERIFY_FAIL') {
        if (attempts + 1 < maxRetries) {
          return { state: 'RETRYABLE', attempts: attempts + 1, error: error || 'readback_mismatch' };
        }
        return { state: 'ESCALATED', attempts: attempts + 1, error: error || 'max_retries_exceeded' };
      }
      if (event === 'TIMEOUT' || event === 'NETWORK_UNCERTAIN') {
        return {
          state: 'UNCERTAIN',
          reason: 'verifying_timeout_quarantine_required',
          requiresReadback: true
        };
      }
      break;

    case 'RETRYABLE':
      if (event === 'RETRY') return { state: 'WRITING' };
      break;

    case 'UNCERTAIN':
      // From UNCERTAIN, only an explicit external read-back verification can move state
      if (event === 'READBACK_CONFIRMED_MATCH') {
        if (!verified || !readbackProof) {
          return { state: 'BLOCKED', reason: 'readback_verification_proof_missing' };
        }
        return { state: 'RESOLVED', verified: true, readbackProof };
      }
      if (event === 'READBACK_CONFIRMED_UNWRITTEN') return { state: 'RETRYABLE', attempts };
      if (event === 'READBACK_FAILED') return { state: 'ESCALATED', error: 'readback_failed' };
      break;

    default:
      break;
  }

  throw new Error(`Invalid state transition: ${currentState} -> ${event}`);
}

/**
 * Circuit breaker logic to protect against cascading Shoptet API failures.
 */
export function evaluateCircuitBreaker({
  consecutiveFailures = 0,
  maxFailures = 3,
  lastFailureTimestamp = 0,
  cooldownMs = 300000, // 5 minutes default
  now = Date.now()
}) {
  if (consecutiveFailures >= maxFailures) {
    const elapsed = now - lastFailureTimestamp;
    if (elapsed < cooldownMs) {
      return {
        isOpen: true,
        state: 'OPEN',
        remainingCooldownMs: cooldownMs - elapsed
      };
    }
    return {
      isOpen: false,
      state: 'HALF_OPEN',
      remainingCooldownMs: 0
    };
  }

  return {
    isOpen: false,
    state: 'CLOSED',
    remainingCooldownMs: 0
  };
}

/**
 * Generates an immutable audit evidence record for remediation decisions and operations.
 * Recursively deep-freezes record and validates all required fields (K3).
 */
export function createRemediationAuditRecord({
  auditId,
  shopId,
  variantCode,
  pricelistId,
  field,
  expected,
  actual,
  policyVersion,
  approvalId = null,
  state,
  attempts = 0,
  readbackProof = null,
  decision,
  reason
}) {
  const shopIdStr = shopId !== undefined && shopId !== null ? String(shopId).trim() : '';
  if (!shopIdStr || !/^\d+$/.test(shopIdStr)) {
    throw new TypeError('Invalid or missing shopId: must be non-empty numeric string');
  }

  if (typeof variantCode !== 'string' || !variantCode.trim()) {
    throw new TypeError('Invalid or missing variantCode: must be non-empty string');
  }

  if (!Number.isSafeInteger(pricelistId) || pricelistId <= 0) {
    throw new TypeError('Invalid or missing pricelistId: must be positive safe integer');
  }

  if (typeof field !== 'string' || !field.trim() || !MANAGED_FIELDS.includes(field)) {
    throw new TypeError(`Invalid field: must be one of ${MANAGED_FIELDS.join(', ')}`);
  }

  if (typeof policyVersion !== 'string' || !policyVersion.trim() || policyVersion === 'undefined' || policyVersion === 'null') {
    throw new TypeError('Invalid policyVersion: must be a defined non-empty string');
  }

  if (!state || !REMEDIATION_STATES.includes(state)) {
    throw new TypeError(`Invalid state: must be one of ${REMEDIATION_STATES.join(', ')}`);
  }

  if (!['AUTO', 'REVIEW', 'BLOCK'].includes(decision)) {
    throw new TypeError("Invalid decision: must be 'AUTO', 'REVIEW', or 'BLOCK'");
  }

  if (expected === undefined || expected === null || actual === undefined || actual === null) {
    throw new TypeError('expected and actual values must be defined');
  }

  const record = {
    contract: 'in_memory_frozen_audit_record_requires_durable_persistence',
    auditId: auditId || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    shopId: shopIdStr,
    variantCode: variantCode.trim(),
    pricelistId: Number(pricelistId),
    field: field.trim(),
    expected: String(expected),
    actual: String(actual),
    policyVersion: policyVersion.trim(),
    approvalId: approvalId ? String(approvalId).trim() : null,
    state: String(state),
    attempts: Number(attempts),
    readbackProof: readbackProof ? JSON.parse(JSON.stringify(readbackProof)) : null,
    decision: String(decision),
    reason: String(reason || '')
  };

  return deepFreeze(record);
}
