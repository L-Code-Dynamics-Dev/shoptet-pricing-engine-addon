import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstallServices} from '../../../apps/api/src/mcp/install-services.mjs';
const db={prepare(){}};
test('installer stays disabled without SFTP factory',()=>{
 assert.equal(createInstallServices({DB:db,RELEASE_ASSETS:{get(){}}}),null);
});
test('installer stays disabled without private release bucket',()=>{
 assert.equal(createInstallServices({DB:db,SFTP_TRANSPORT_FACTORY:()=>{}}),null);
});
test('complete service wiring exposes trusted adapters',()=>{
 const result=createInstallServices({DB:db,RELEASE_ASSETS:{get(){}},SFTP_TRANSPORT_FACTORY:()=>{}});
 assert.equal(typeof result.approvalStore.claim,'function');
 assert.equal(typeof result.lock.withShopLock,'function');
 assert.equal(typeof result.assetProvider.get,'function');
 assert.equal(typeof result.transportFactory,'function');
});
