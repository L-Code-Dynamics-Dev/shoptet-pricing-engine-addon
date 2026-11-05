import {testD1} from './helpers/d1.mjs';
import {createTokenVault} from '../src/token-vault.mjs';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeAuthorizationCode, saveShoptetInstallation, getShoptetApiAccessToken, migrateShopTokens } from '../src/shoptet-oauth.mjs';

test('exchangeAuthorizationCode successfully exchanges code for permanent oauth token', async () => {
  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://826800.myshoptet.com/action/ApiOAuthServer/token');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.code, 'auth-code-123');
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.client_id, 'client-id-xyz');
    assert.equal(body.client_secret, 'secret-xyz');
    assert.equal(body.redirect_uri, 'https://example.com/install');

    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'perm-token-999',
        eshopId: 826800,
        eshopUrl: 'https://826800.myshoptet.com',
        contactEmail: 'admin@myshoptet.com'
      })
    };
  };

  const result = await exchangeAuthorizationCode({
    code: 'auth-code-123',
    eshopUrl: 'https://826800.myshoptet.com',
    redirectUri: 'https://example.com/install',
    clientId: 'client-id-xyz',
    clientSecret: 'secret-xyz',
    fetchImpl: fakeFetch
  });

  assert.equal(result.accessToken, 'perm-token-999');
  assert.equal(result.eshopId, '826800');
  assert.equal(result.eshopUrl, 'https://826800.myshoptet.com');
  assert.equal(result.contactEmail, 'admin@myshoptet.com');
});

test('exchangeAuthorizationCode rejects missing code or credentials', async () => {
  await assert.rejects(
    () => exchangeAuthorizationCode({ code: '', redirectUri: 'x', clientId: 'c', clientSecret: 's' }),
    /Missing authorization code/
  );
  await assert.rejects(
    () => exchangeAuthorizationCode({ code: 'c', redirectUri: '', clientId: 'c', clientSecret: 's' }),
    /Missing redirectUri/
  );
  await assert.rejects(
    () => exchangeAuthorizationCode({ code: 'c', redirectUri: 'x', clientId: '', clientSecret: 's' }),
    /Missing client credentials/
  );
});

test('OAuth refuses SSRF targets before transmitting client secret',async()=>{
  for (const eshopUrl of ['http://127.0.0.1','https://evil.example','https://826800.myshoptet.com.evil.example','https://user:pass@826800.myshoptet.com','https://826800.myshoptet.com/path']) {
    await assert.rejects(exchangeAuthorizationCode({code:'code',eshopUrl,redirectUri:'https://addon.example/install',clientId:'client',clientSecret:'secret',fetchImpl:async()=>{assert.fail('must not fetch');}}),/Trusted shop URL/);
  }
});
const keys={active:'v1',keys:{v1:'a'.repeat(64)}};
const installation={shopId:'123',accessToken:'permanent-secret',eshopUrl:'https://123.myshoptet.com',contactEmail:null,tokenKeys:keys};
test('installation stores only encrypted tokens and clears compatibility copy',async()=>{
 const db=testD1();try{await saveShoptetInstallation({db,...installation});const row=db.sql.prepare('SELECT * FROM shoptet_oauth').get();assert.equal(row.oauth_access_token,'');assert.doesNotMatch(JSON.stringify(row),/permanent-secret/);assert.equal(await createTokenVault(keys).open('123','oauth',row.oauth_envelope),'permanent-secret');assert.equal(db.sql.prepare('SELECT oauth_token FROM shoptet_installations').get().oauth_token,'');}finally{db.sql.close();}
});
test('API renewal encrypts cache and reuses valid encrypted cache without a network call',async()=>{
 const db=testD1();try{await saveShoptetInstallation({db,...installation});let calls=0;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer permanent-secret');return new Response(JSON.stringify({access_token:'temporary-secret',expires_in:1200}));};
 const first=await getShoptetApiAccessToken({db,shopId:'123',tokenKeys:keys,fetchImpl});assert.equal(first.apiAccessToken,'temporary-secret');
 assert.equal((await getShoptetApiAccessToken({db,shopId:'123',tokenKeys:keys,fetchImpl})).apiAccessToken,'temporary-secret');assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(db.sql.prepare('SELECT * FROM shoptet_oauth').get()),/temporary-secret|permanent-secret/);
 }finally{db.sql.close();}
});
test('token vault binds tenant and purpose; tampering and unknown key fail closed',async()=>{
 const vault=createTokenVault(keys),envelope=await vault.seal('123','oauth','secret');
 await assert.rejects(vault.open('456','oauth',envelope),/Token unavailable/);
 await assert.rejects(vault.open('123','api',envelope),/Token unavailable/);
 const bad=JSON.parse(envelope);bad.data=bad.data.slice(0,-4)+'AAAA';await assert.rejects(vault.open('123','oauth',JSON.stringify(bad)),/Token unavailable/);
 await assert.rejects(createTokenVault({active:'v2',keys:{v2:'b'.repeat(64)}}).open('123','oauth',envelope),/Token unavailable/);
});
test('missing key prevents any installation persistence',async()=>{
 const db=testD1();try{await assert.rejects(saveShoptetInstallation({db,...installation,tokenKeys:undefined}),/vault unavailable/);assert.equal(db.sql.prepare('SELECT count(*) n FROM installations').get().n,0);}finally{db.sql.close();}
});
test('explicit migration clears both plaintext copies; key rotation retains readability',async()=>{
 const db=testD1({through:'0010_configuration_revisions.sql'});try{
 db.sql.exec("INSERT INTO installations(shop_id,state) VALUES('123','active'); INSERT INTO shoptet_oauth(shop_id,oauth_access_token,eshop_url,cached_api_token) VALUES('123','legacy-secret','https://123.myshoptet.com','legacy-api'); INSERT INTO shoptet_installations(eshop_id,oauth_token) VALUES(123,'legacy-secret')");
 db.sql.exec(readFileSync(new URL('../../../migrations/0011_encrypted_shoptet_tokens.sql',import.meta.url),'utf8'));
 await assert.rejects(getShoptetApiAccessToken({db,shopId:'123',tokenKeys:keys}),/migration required/);
 await migrateShopTokens({db,shopId:'123',tokenKeys:keys});
 let row=db.sql.prepare('SELECT * FROM shoptet_oauth').get();assert.equal(row.oauth_access_token,'');assert.equal(row.cached_api_token,null);
 assert.equal(db.sql.prepare('SELECT oauth_token FROM shoptet_installations').get().oauth_token,'');
 const next={active:'v2',keys:{...keys.keys,v2:'b'.repeat(64)}};await migrateShopTokens({db,shopId:'123',tokenKeys:next});row=db.sql.prepare('SELECT * FROM shoptet_oauth').get();assert.equal(JSON.parse(row.oauth_envelope).kid,'v2');assert.equal(await createTokenVault(next).open('123','oauth',row.oauth_envelope),'legacy-secret');
 }finally{db.sql.close();}
});
test('reinstall during renewal prevents stale API-token publication',async()=>{
 const db=testD1();try{await saveShoptetInstallation({db,...installation});await assert.rejects(getShoptetApiAccessToken({db,shopId:'123',tokenKeys:keys,fetchImpl:async()=>{await saveShoptetInstallation({db,...installation,accessToken:'new-token'});return new Response(JSON.stringify({access_token:'stale-api',expires_in:1200}));}}),/Installation changed/);assert.equal(db.sql.prepare('SELECT api_envelope FROM shoptet_oauth').get().api_envelope,null);}finally{db.sql.close();}
});
