import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRemediationEligibility,
  transitionRemediationState,
  evaluateCircuitBreaker,
  createRemediationAuditRecord,
  REMEDIATION_STATES,
  VALID_DRIFT_TYPES,
  MANAGED_FIELDS
} from '../src/self-healing-engine.mjs';

test('TASK J & K1: classifyRemediationEligibility - strict allowlist, tenant binding and evidence validation', () => {
  const validItem = {
    shopId: '826800',
    pricelistId: 26,
    variantCode: 'SKU-001',
    field: 'minPriceRatio',
    driftType: 'coupon_drift',
    expected: '0.945',
    actual: '0.944'
  };

  const baseConfig = {
    item: validItem,
    selfCheckPassed: true,
    verifiedTenantShopId: '826800',
    managedPricelistIds: [26, 29],
    activeInstallGeneration: 'gen_1',
    installGeneration: 'gen_1',
    approvalId: 'appr_valid_123',
    autoEnabled: false
  };

  // 1. Invariant: AUTO is OFF by default -> REVIEW
  const defaultEligibility = classifyRemediationEligibility(baseConfig);
  assert.equal(defaultEligibility.decision, 'REVIEW');
  assert.equal(defaultEligibility.canAutoRemediate, false);
  assert.equal(defaultEligibility.reason, 'auto_remediation_disabled_by_default');

  // 2. Missing or arbitrary item without shopId fails closed -> BLOCK (K1)
  const missingShop = classifyRemediationEligibility({
    ...baseConfig,
    item: { ...validItem, shopId: '' }
  });
  assert.equal(missingShop.decision, 'BLOCK');
  assert.equal(missingShop.reason, 'missing_or_invalid_item_shop_id');

  // 3. Mismatched tenant shop ID fails closed -> BLOCK (K1)
  const wrongShop = classifyRemediationEligibility({
    ...baseConfig,
    verifiedTenantShopId: '999999'
  });
  assert.equal(wrongShop.decision, 'BLOCK');
  assert.equal(wrongShop.reason, 'tenant_shop_id_mismatch');

  // 4. Missing variantCode fails closed -> BLOCK (K1)
  const missingVariant = classifyRemediationEligibility({
    ...baseConfig,
    item: { ...validItem, variantCode: ' ' }
  });
  assert.equal(missingVariant.decision, 'BLOCK');
  assert.equal(missingVariant.reason, 'missing_variant_code');

  // 5. Unmanaged pricelist fails closed -> BLOCK (K1)
  const unmanagedPricelist = classifyRemediationEligibility({
    ...baseConfig,
    item: { ...validItem, pricelistId: 999 }
  });
  assert.equal(unmanagedPricelist.decision, 'BLOCK');
  assert.equal(unmanagedPricelist.reason, 'unmanaged_pricelist_id');

  // 6. Unmanaged field fails closed -> BLOCK (K1)
  const unmanagedField = classifyRemediationEligibility({
    ...baseConfig,
    item: { ...validItem, field: 'unsupportedCustomField' }
  });
  assert.equal(unmanagedField.decision, 'BLOCK');
  assert.equal(unmanagedField.reason, 'unmanaged_field');

  // 7. Unknown drift type fails closed -> BLOCK (K1)
  const unknownDrift = classifyRemediationEligibility({
    ...baseConfig,
    item: { ...validItem, driftType: 'hallucinated_drift' }
  });
  assert.equal(unknownDrift.decision, 'BLOCK');
  assert.equal(unknownDrift.reason, 'unknown_drift_type');

  // 8. Stale install generation fails closed -> BLOCK (K1)
  const staleGen = classifyRemediationEligibility({
    ...baseConfig,
    activeInstallGeneration: 'gen_2',
    installGeneration: 'gen_1'
  });
  assert.equal(staleGen.decision, 'BLOCK');
  assert.equal(staleGen.reason, 'stale_install_generation');

  // 9. Missing merchant approval token escalates to REVIEW (K1)
  const noApproval = classifyRemediationEligibility({
    ...baseConfig,
    approvalId: null,
    autoEnabled: true
  });
  assert.equal(noApproval.decision, 'REVIEW');
  assert.equal(noApproval.reason, 'missing_merchant_approval_token');

  // 10. Failed self-check immediately BLOCKS remediation (INC-011 / INC-012)
  const failedSelfCheck = classifyRemediationEligibility({
    ...baseConfig,
    selfCheckPassed: false,
    autoEnabled: true
  });
  assert.equal(failedSelfCheck.decision, 'BLOCK');
  assert.equal(failedSelfCheck.reason, 'reconciliation_self_check_failed');

  // 11. Fully verified managed item with valid approval and explicit autoEnabled -> AUTO
  const autoApproved = classifyRemediationEligibility({
    ...baseConfig,
    autoEnabled: true
  });
  assert.equal(autoApproved.decision, 'AUTO');
  assert.equal(autoApproved.canAutoRemediate, true);
  assert.equal(autoApproved.reason, 'eligible_for_safe_automated_remediation');
});

test('TASK J & K2: transitionRemediationState - strict progression through VERIFYING and replay safety', () => {
  // Linear happy path: DETECTED -> CONFIRMED -> PLANNED -> AUTHORIZED -> WRITING -> VERIFYING -> RESOLVED
  let current = transitionRemediationState('DETECTED', 'CONFIRM');
  assert.equal(current.state, 'CONFIRMED');

  current = transitionRemediationState('CONFIRMED', 'PLAN');
  assert.equal(current.state, 'PLANNED');

  // Authorize with valid approval token
  current = transitionRemediationState('PLANNED', 'AUTHORIZE', { approvalId: 'appr_valid_123' });
  assert.equal(current.state, 'AUTHORIZED');
  assert.equal(current.approvalId, 'appr_valid_123');

  current = transitionRemediationState('AUTHORIZED', 'START_WRITE');
  assert.equal(current.state, 'WRITING');

  // K2 invariant: Direct transition from WRITING with VERIFY_SUCCESS is invalid without VERIFYING
  assert.throws(
    () => transitionRemediationState('WRITING', 'VERIFY_SUCCESS'),
    /Invalid state transition/
  );

  // WRITING moves to VERIFYING upon write confirmation
  current = transitionRemediationState('WRITING', 'WRITE_CONFIRMED', { writeTimestamp: 1234567 });
  assert.equal(current.state, 'VERIFYING');

  // Missing readback proof in VERIFYING fails closed to BLOCKED
  const missingProof = transitionRemediationState('VERIFYING', 'READBACK_CONFIRMED_MATCH', { verified: true, readbackProof: null });
  assert.equal(missingProof.state, 'BLOCKED');
  assert.equal(missingProof.reason, 'readback_verification_proof_missing');

  // VERIFYING completes to RESOLVED with verified proof
  const readbackProof = { verifiedAt: '2026-11-07T03:00:00Z', confirmedValue: '0.945' };
  current = transitionRemediationState('VERIFYING', 'READBACK_CONFIRMED_MATCH', { verified: true, readbackProof });
  assert.equal(current.state, 'RESOLVED');
  assert.equal(current.verified, true);

  // Timeouts during WRITING or VERIFYING transition to UNCERTAIN (quarantine required)
  const writingTimeout = transitionRemediationState('WRITING', 'TIMEOUT');
  assert.equal(writingTimeout.state, 'UNCERTAIN');
  assert.equal(writingTimeout.requiresReadback, true);

  const verifyingTimeout = transitionRemediationState('VERIFYING', 'TIMEOUT');
  assert.equal(verifyingTimeout.state, 'UNCERTAIN');
  assert.equal(verifyingTimeout.requiresReadback, true);

  // Retry logic on verification failure: retryable until maxRetries reached
  const retry1 = transitionRemediationState('VERIFYING', 'READBACK_MISMATCH', { attempts: 0, maxRetries: 2, error: 'readback_mismatch' });
  assert.equal(retry1.state, 'RETRYABLE');
  assert.equal(retry1.attempts, 1);

  const escalated = transitionRemediationState('VERIFYING', 'READBACK_MISMATCH', { attempts: 1, maxRetries: 2, error: 'readback_mismatch' });
  assert.equal(escalated.state, 'ESCALATED');

  // Universal policy changed invalidates stale plan to BLOCKED
  const policyChanged = transitionRemediationState('PLANNED', 'POLICY_CHANGED');
  assert.equal(policyChanged.state, 'BLOCKED');
});

test('TASK J & K3: createRemediationAuditRecord - deep recursive freeze and strict policyVersion validation', () => {
  const validProof = {
    verifiedAt: '2026-11-07T03:00:00Z',
    confirmedValue: '0.945',
    nestedCheck: {
      source: 'shoptet_api',
      matched: true
    }
  };

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
    readbackProof: validProof,
    decision: 'AUTO',
    reason: 'eligible_for_safe_automated_remediation'
  });

  assert.ok(record.auditId);
  assert.equal(record.contract, 'in_memory_frozen_audit_record_requires_durable_persistence');
  assert.equal(record.shopId, '826800');
  assert.equal(record.decision, 'AUTO');
  assert.equal(record.state, 'RESOLVED');

  // Deep immutability: outer, middle and nested objects are all frozen
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.readbackProof));
  assert.ok(Object.isFrozen(record.readbackProof.nestedCheck));

  // Modifying nested property throws in strict mode (K3)
  assert.throws(() => { record.readbackProof.nestedCheck.matched = false; }, TypeError);

  // PolicyVersion cannot be undefined, null, or string 'undefined' (K3)
  assert.throws(
    () => createRemediationAuditRecord({
      shopId: '826800', variantCode: 'SKU-001', pricelistId: 26, field: 'minPriceRatio',
      expected: '1', actual: '0', policyVersion: 'undefined', state: 'RESOLVED', decision: 'AUTO'
    }),
    /Invalid policyVersion/
  );

  assert.throws(
    () => createRemediationAuditRecord({
      shopId: '826800', variantCode: 'SKU-001', pricelistId: 26, field: 'minPriceRatio',
      expected: '1', actual: '0', policyVersion: '', state: 'RESOLVED', decision: 'AUTO'
    }),
    /Invalid policyVersion/
  );

  // Invalid shopId or pricelistId throws TypeError
  assert.throws(
    () => createRemediationAuditRecord({
      shopId: '', variantCode: 'SKU-001', pricelistId: 26, field: 'minPriceRatio',
      expected: '1', actual: '0', policyVersion: 'v1', state: 'RESOLVED', decision: 'AUTO'
    }),
    /Invalid or missing shopId/
  );

  assert.throws(
    () => createRemediationAuditRecord({
      shopId: '826800', variantCode: 'SKU-001', pricelistId: -1, field: 'minPriceRatio',
      expected: '1', actual: '0', policyVersion: 'v1', state: 'RESOLVED', decision: 'AUTO'
    }),
    /Invalid or missing pricelistId/
  );
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
