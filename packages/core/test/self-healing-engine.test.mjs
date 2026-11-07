import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRemediationEligibility,
  transitionRemediationState,
  evaluateCircuitBreaker,
  createRemediationAuditRecord,
  REMEDIATION_STATES
} from '../src/self-healing-engine.mjs';

test('TASK J: classifyRemediationEligibility - safety gates and AUTO OFF default', () => {
  const sampleItem = {
    type: 'coupon',
    shopId: '826800',
    pricelistId: 26,
    variantCode: 'SKU-001',
    expected: '0.945',
    actual: '0.944'
  };

  // 1. Invariant: AUTO is OFF by default -> REVIEW
  const defaultEligibility = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: false
  });
  assert.equal(defaultEligibility.decision, 'REVIEW');
  assert.equal(defaultEligibility.canAutoRemediate, false);
  assert.equal(defaultEligibility.reason, 'auto_remediation_disabled_by_default');

  // 2. Failed self-check immediately BLOCKS remediation (INC-011 / INC-012)
  const failedSelfCheck = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: false,
    autoEnabled: true
  });
  assert.equal(failedSelfCheck.decision, 'BLOCK');
  assert.equal(failedSelfCheck.canAutoRemediate, false);
  assert.equal(failedSelfCheck.reason, 'reconciliation_self_check_failed');

  // 3. Concurrent writer or circuit breaker open BLOCKS remediation
  const concurrent = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    hasConcurrentWriter: true
  });
  assert.equal(concurrent.decision, 'BLOCK');
  assert.equal(concurrent.reason, 'concurrent_writer_detected');

  const tripped = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    circuitBreakerOpen: true
  });
  assert.equal(tripped.decision, 'BLOCK');
  assert.equal(tripped.reason, 'circuit_breaker_tripped');

  // 4. Protected pricelist mutation (INC-003) BLOCKS remediation
  const protectedPricelist = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    isProtectedPricelist: true
  });
  assert.equal(protectedPricelist.decision, 'BLOCK');
  assert.equal(protectedPricelist.reason, 'protected_pricelist_mutation_forbidden');

  // 5. Policy version mismatch BLOCKS remediation
  const policyMismatch = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    policyVersionMismatch: true
  });
  assert.equal(policyMismatch.decision, 'BLOCK');
  assert.equal(policyMismatch.reason, 'policy_version_mismatch');

  // 6. Manual sale conflict (INC-004) or missing cost/VAT (INC-014/INC-015) escalates to REVIEW
  const saleConflict = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    hasManualSaleConflict: true
  });
  assert.equal(saleConflict.decision, 'REVIEW');
  assert.equal(saleConflict.reason, 'manual_sale_conflict_requires_merchant_review');

  const missingCost = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true,
    hasMissingCostOrVat: true
  });
  assert.equal(missingCost.decision, 'REVIEW');
  assert.equal(missingCost.reason, 'missing_cost_or_vat_requires_merchant_review');

  // 7. Strictly verified managed drift with explicit autoEnabled -> AUTO
  const autoApproved = classifyRemediationEligibility({
    item: sampleItem,
    selfCheckPassed: true,
    autoEnabled: true
  });
  assert.equal(autoApproved.decision, 'AUTO');
  assert.equal(autoApproved.canAutoRemediate, true);
  assert.equal(autoApproved.reason, 'eligible_for_safe_automated_remediation');
});

test('TASK J: transitionRemediationState - state machine and quarantine transitions', () => {
  // Linear happy path: DETECTED -> CONFIRMED -> PLANNED -> AUTHORIZED -> WRITING -> RESOLVED
  let current = transitionRemediationState('DETECTED', 'CONFIRM');
  assert.equal(current.state, 'CONFIRMED');

  current = transitionRemediationState('CONFIRMED', 'PLAN');
  assert.equal(current.state, 'PLANNED');

  // Attempt to authorize without approvalId fails closed to BLOCKED
  const unapproved = transitionRemediationState('PLANNED', 'AUTHORIZE', { approvalId: null });
  assert.equal(unapproved.state, 'BLOCKED');

  current = transitionRemediationState('PLANNED', 'AUTHORIZE', { approvalId: 'appr_valid_123' });
  assert.equal(current.state, 'AUTHORIZED');
  assert.equal(current.approvalId, 'appr_valid_123');

  current = transitionRemediationState('AUTHORIZED', 'START_WRITE');
  assert.equal(current.state, 'WRITING');

  // Success with verified read-back
  current = transitionRemediationState('WRITING', 'VERIFY_SUCCESS', { verified: true });
  assert.equal(current.state, 'RESOLVED');

  // Write timeout / network error transitions to UNCERTAIN and quarantines
  const timeoutState = transitionRemediationState('WRITING', 'TIMEOUT');
  assert.equal(timeoutState.state, 'UNCERTAIN');
  assert.equal(timeoutState.requiresReadback, true);

  // Retry logic on verification failure: retryable until maxRetries reached
  const retry1 = transitionRemediationState('WRITING', 'VERIFY_FAIL', { attempts: 0, maxRetries: 2, error: 'readback_mismatch' });
  assert.equal(retry1.state, 'RETRYABLE');
  assert.equal(retry1.attempts, 1);

  const escalated = transitionRemediationState('WRITING', 'VERIFY_FAIL', { attempts: 1, maxRetries: 2, error: 'readback_mismatch' });
  assert.equal(escalated.state, 'ESCALATED');

  // Universal policy changed invalidates stale plan to BLOCKED
  const policyChanged = transitionRemediationState('PLANNED', 'POLICY_CHANGED');
  assert.equal(policyChanged.state, 'BLOCKED');
});

test('TASK J: evaluateCircuitBreaker - trips on consecutive failures and respects cooldown', () => {
  const baseTime = 1000000;
  // Closed under failure threshold
  const closed = evaluateCircuitBreaker({ consecutiveFailures: 1, maxFailures: 3, lastFailureTimestamp: baseTime, now: baseTime + 1000 });
  assert.equal(closed.isOpen, false);
  assert.equal(closed.state, 'CLOSED');

  // Trips to OPEN on 3 failures within cooldown
  const open = evaluateCircuitBreaker({ consecutiveFailures: 3, maxFailures: 3, lastFailureTimestamp: baseTime, cooldownMs: 300000, now: baseTime + 100000 });
  assert.equal(open.isOpen, true);
  assert.equal(open.state, 'OPEN');
  assert.equal(open.remainingCooldownMs, 200000);

  // Transitions to HALF_OPEN after cooldown elapsed
  const halfOpen = evaluateCircuitBreaker({ consecutiveFailures: 3, maxFailures: 3, lastFailureTimestamp: baseTime, cooldownMs: 300000, now: baseTime + 350000 });
  assert.equal(halfOpen.isOpen, false);
  assert.equal(halfOpen.state, 'HALF_OPEN');
});

test('TASK J: createRemediationAuditRecord - produces immutable audit trail', () => {
  const record = createRemediationAuditRecord({
    shopId: '826800',
    variantCode: 'SKU-001',
    pricelistId: 26,
    field: 'minPriceRatio',
    expected: '0.945',
    actual: '0.944',
    policyVersion: 'v1.2.0',
    approvalId: 'appr_789',
    state: 'RESOLVED',
    attempts: 1,
    readbackProof: { verifiedAt: '2026-11-07T02:00:00Z', confirmedValue: '0.945' },
    decision: 'AUTO',
    reason: 'eligible_for_safe_automated_remediation'
  });

  assert.ok(record.auditId);
  assert.equal(record.shopId, '826800');
  assert.equal(record.decision, 'AUTO');
  assert.equal(record.state, 'RESOLVED');
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.readbackProof));

  // Immutable: attempting modification throws in strict mode
  assert.throws(() => { record.state = 'MUTATED'; }, TypeError);
});
