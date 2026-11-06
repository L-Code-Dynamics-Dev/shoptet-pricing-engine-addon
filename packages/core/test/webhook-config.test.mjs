import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveOrderWebhookConfiguration} from '../../../apps/api/src/shoptet-webhooks.mjs';

test('order webhooks load tiers and turnover rules from saved loyaltyProposal', () => {
  const rules = {
    period: {from:'2026-01-01T00:00:00Z',to:'2027-01-01T00:00:00Z'},
    qualifyingStatusIds:[-3], requirePaid:true
  };
  const tiers = [{name:'VIP Gold',minTurnover:10000,pricelistId:23}];
  const config = {loyaltyProposal:{currency:'EUR',tiers,turnoverPolicy:rules}};
  const resolved = resolveOrderWebhookConfiguration(config);
  assert.deepEqual(resolved.tiers, tiers);
  assert.deepEqual(resolved.policy, rules);
});

test('legacy root-level webhook configuration remains compatible', () => {
  const config = {tiers:[{name:'VIP',minTurnover:0,pricelistId:2}]};
  const resolved = resolveOrderWebhookConfiguration(config);
  assert.deepEqual(resolved.tiers, config.tiers);
  assert.equal(resolved.policy.downgrades,'keep_current');
});

test('invalid tiers fail closed instead of silently selecting base pricelist', () => {
  assert.throws(() => resolveOrderWebhookConfiguration({
    loyaltyProposal:{tiers:{name:'not an array'}}
  }), /invalid_loyalty_tiers/);
});
