import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeAuthorizationCode, saveShoptetInstallation, getShoptetApiAccessToken } from '../src/shoptet-oauth.mjs';

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

test('saveShoptetInstallation saves shop record in D1 tables', async () => {
  const executed = [];
  const fakeDb = {
    prepare: (query) => ({
      bind: (...args) => ({
        run: async () => {
          executed.push({ query, args });
          return { success: true };
        }
      })
    })
  };

  const res = await saveShoptetInstallation({
    db: fakeDb,
    shopId: '826800',
    accessToken: 'perm-token-999',
    eshopUrl: 'https://826800.myshoptet.com',
    contactEmail: 'admin@myshoptet.com'
  });

  assert.equal(res.success, true);
  assert.equal(res.shopId, '826800');
  assert.equal(executed.length, 3);
  assert.match(executed[0].query, /INSERT INTO installations/);
  assert.match(executed[1].query, /INSERT INTO shoptet_oauth/);
  assert.match(executed[2].query, /INSERT INTO shoptet_installations/);
});

test('getShoptetApiAccessToken requests short-term api access token and caches it', async () => {
  const updates = [];
  const fakeDb = {
    prepare: (query) => ({
      bind: (...args) => ({
        first: async () => ({
          oauth_access_token: 'perm-token-999',
          eshop_url: 'https://826800.myshoptet.com'
        }),
        run: async () => {
          updates.push({ query, args });
          return { success: true };
        }
      })
    })
  };

  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://826800.myshoptet.com/action/ApiOAuthServer/getAccessToken');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['Authorization'], 'Bearer perm-token-999');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'api-short-term-token-abc',
        expires_in: 1800
      })
    };
  };

  const result = await getShoptetApiAccessToken({
    db: fakeDb,
    shopId: '826800',
    fetchImpl: fakeFetch
  });

  assert.equal(result.apiAccessToken, 'api-short-term-token-abc');
  assert.equal(result.expiresIn, 1800);
  assert.equal(updates.length, 1);
  assert.match(updates[0].query, /UPDATE shoptet_oauth/);
});

test('getShoptetApiAccessToken returns cached token when still valid', async () => {
  const futureSec = Math.floor(Date.now() / 1000) + 1200;
  const fakeDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          oauth_access_token: 'perm-token-999',
          eshop_url: 'https://826800.myshoptet.com',
          cached_api_token: 'cached-token-123',
          api_token_expires_at: futureSec
        })
      })
    })
  };

  const fetchCalls = [];
  const result = await getShoptetApiAccessToken({
    db: fakeDb,
    shopId: '826800',
    fetchImpl: async (...args) => { fetchCalls.push(args); }
  });

  assert.equal(result.apiAccessToken, 'cached-token-123');
  assert.equal(fetchCalls.length, 0); // No network call made
});

test('OAuth refuses SSRF targets before transmitting client secret',async()=>{
  for (const eshopUrl of ['http://127.0.0.1','https://evil.example','https://826800.myshoptet.com.evil.example','https://user:pass@826800.myshoptet.com','https://826800.myshoptet.com/path']) {
    await assert.rejects(exchangeAuthorizationCode({code:'code',eshopUrl,redirectUri:'https://addon.example/install',clientId:'client',clientSecret:'secret',fetchImpl:async()=>{assert.fail('must not fetch');}}),/Trusted shop URL/);
  }
});
