import test from 'node:test';
import assert from 'node:assert/strict';
import { UI_DEFAULTS, validateUiSection } from '../../apps/api/src/admin-sections.mjs';
import { renderAdminHtml } from '../../apps/api/src/iframe-settings.mjs';

test('each UI draft section accepts its default', () => {
  for (const [key, value] of Object.entries(UI_DEFAULTS)) {
    assert.deepEqual(validateUiSection(key, value), { value }, key);
  }
});

test('invalid settings and unknown fields fail closed', () => {
  assert.ok(validateUiSection('settings', { ...UI_DEFAULTS.settings, currency: 'USD' }).error);
  assert.ok(validateUiSection('settings', { ...UI_DEFAULTS.settings, shopId: 'other' }).error);
  assert.ok(validateUiSection('sync', { ...UI_DEFAULTS.sync, intervalMinutes: 0 }).error);
  assert.ok(validateUiSection('coupons', { ...UI_DEFAULTS.coupons, lockedTiers: ['A', 'a'] }).error);
  assert.ok(validateUiSection('unknown', {}).error);
});

test('rows require distinct identifiers and bounded discount', () => {
  assert.ok(validateUiSection('products', [{ id: 'SKU', name: 'Product', limit: 101 }]).error);
  assert.ok(validateUiSection('categories', [{ id: 'X', name: 'X', limit: 10 }, { id: 'x', name: 'Y', limit: 5 }]).error);
  assert.deepEqual(validateUiSection('pricelists', [{ id: '10', name: 'VIP', tierName: 'Gold' }]).value[0].id, '10');
});

test('existing iframe contains all draft configuration tabs and safe actions', () => {
  const html = renderAdminHtml('826800', { session: 'test-session', mode: 'preview' });
  for (const key of Object.keys(UI_DEFAULTS)) {
    assert.match(html, new RegExp('id="panel-' + key + '"'));
    assert.match(html, new RegExp('data-tab="' + key + '"'));
  }
  assert.match(html, /saveSection/);
  assert.match(html, /\/section/);
});
