import test from 'node:test';
import assert from 'node:assert/strict';
import {assertTenantContext, safeSyncMode} from '../src/tenant.mjs';
test('authenticated shop resolves its own tenant', () => assert.equal(assertTenantContext({authenticatedShopId:'shop-a',requestedShopId:'shop-a'}),'shop-a'));
test('cross-tenant request is rejected', () => assert.throws(() => assertTenantContext({authenticatedShopId:'shop-a',requestedShopId:'shop-b'}), /Cross-tenant/));
test('missing authentication is rejected', () => assert.throws(() => assertTenantContext({requestedShopId:'shop-a'}), /Unauthenticated/));
test('live sync is fail-closed', () => assert.throws(() => safeSyncMode('off','live'), /disabled/));
test('dry-run remains allowed', () => assert.equal(safeSyncMode('off','dry-run'),'dry-run'));
