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

/**
 * Classifies whether a confirmed reconciliation drift item is eligible for AUTO, REVIEW, or BLOCK.
 * Fail-closed invariant: AUTO is strictly disabled by default (autoEnabled = false).
 */
export function classifyRemediationEligibility({
  item,
  selfCheckPassed = false,
  autoEnabled = false,
  hasConcurrentWriter = false,
  isProtectedPricelist = false,
  hasManualSaleConflict = false,
  hasMissingCostOrVat = false,
  policyVersionMismatch = false,
  circuitBreakerOpen = false
}) {
  if (!item || typeof item !== 'object') {
    throw new TypeError('Invalid drift item');
  }

  // 1. BLOCK conditions (hard safety violations)
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

  // 2. REVIEW conditions (requires manual merchant inspection / approval)
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

  // 3. AUTO OFF by default (safety invariant)
  if (!autoEnabled) {
    return {
      decision: 'REVIEW',
      reason: 'auto_remediation_disabled_by_default',
      canAutoRemediate: false
    };
  }

  // 4. AUTO eligible (strictly bounded managed tier or coupon lock repair)
  return {
    decision: 'AUTO',
    reason: 'eligible_for_safe_automated_remediation',
    canAutoRemediate: true
  };
}

/**
 * State machine transition function for remediation lifecycle.
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
    verified = false
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
        if (!approvalId || typeof approvalId !== 'string') {
          return { state: 'BLOCKED', reason: 'missing_valid_merchant_approval' };
        }
        return { state: 'AUTHORIZED', approvalId };
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
      if (event === 'VERIFY_SUCCESS') {
        if (!verified) {
          return { state: 'BLOCKED', reason: 'readback_verification_missing' };
        }
        return { state: 'RESOLVED', verified: true };
      }
      if (event === 'VERIFY_FAIL') {
        if (attempts + 1 < maxRetries) {
          return { state: 'RETRYABLE', attempts: attempts + 1, error };
        }
        return { state: 'ESCALATED', attempts: attempts + 1, error: error || 'max_retries_exceeded' };
      }
      break;

    case 'RETRYABLE':
      if (event === 'RETRY') return { state: 'WRITING' };
      break;

    case 'UNCERTAIN':
      // From UNCERTAIN, only an explicit external read-back verification can move state
      if (event === 'READBACK_CONFIRMED_MATCH') return { state: 'RESOLVED', verified: true };
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
  if (!shopId || !variantCode || !pricelistId || !field || !state || !decision) {
    throw new TypeError('Missing required audit evidence fields');
  }

  return Object.freeze({
    auditId: auditId || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    shopId: String(shopId),
    variantCode: String(variantCode),
    pricelistId: Number(pricelistId),
    field: String(field),
    expected: String(expected),
    actual: String(actual),
    policyVersion: String(policyVersion),
    approvalId: approvalId ? String(approvalId) : null,
    state: String(state),
    attempts: Number(attempts),
    readbackProof: readbackProof ? Object.freeze({ ...readbackProof }) : null,
    decision: String(decision),
    reason: String(reason)
  });
}
