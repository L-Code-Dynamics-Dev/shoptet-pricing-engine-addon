#!/usr/bin/env node
import { exchangeAuthorizationCode } from '../packages/core/src/shoptet-oauth.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      params[key] = val;
    }
  }
  return params;
}

const args = parseArgs();
const code = args.code;
const redirectUri = args.redirectUri || 'https://localhost/shoptet/install';

const CLIENT_ID = args.clientId || 'dmsxf2kq7mkl76l9';
const CLIENT_SECRET = args.clientSecret || 'shoasecret_0f082b1dbef899b973a212b4733f38c4ec2cac57b21868787b7b3d78fcb194ba';
const ESHOP_URL = args.eshopUrl || 'https://826800.myshoptet.com';

if (!code) {
  console.log(`
POUŽITÍ:
  node scripts/exchange-token.mjs --code <AUTHORIZATION_CODE> [--redirectUri <URL>]

Tento skript vymění jednorázový instalační kód za trvalý OAuth token a získá aktuální API token pro ověření.
`);
  process.exit(0);
}

async function main() {
  console.log(`Vyměňuji autorizační kód pro e-shop ${ESHOP_URL}...`);
  try {
    const token = await exchangeAuthorizationCode({
      code,
      eshopUrl: ESHOP_URL,
      redirectUri,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET
    });

    console.log('\nÚspěšně získán trvalý OAuth token!');
    console.log('E-shop ID:', token.eshopId);
    console.log('OAuth Token (zkráceně):', token.accessToken.slice(0, 10) + '...' + token.accessToken.slice(-6));

    // Získání krátkodobého API tokenu
    console.log('\nZískávám krátkodobý Shoptet-Access-Token přes getAccessToken...');
    const apiRes = await fetch(`${ESHOP_URL}/action/ApiOAuthServer/getAccessToken`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        Accept: 'application/json'
      }
    });

    if (!apiRes.ok) {
      throw new Error(`getAccessToken selhal se statusem ${apiRes.status}`);
    }

    const apiData = await apiRes.json();
    console.log('API Access Token úspěšně získán (platnost: ' + apiData.expires_in + ' s)!');

    // Spuštění ověření přes živé API
    console.log('\nSpouštím ověření přes scripts/verify-live-shoptet-api.mjs...');
    const { execFileSync } = await import('node:child_process');
    execFileSync('node', ['scripts/verify-live-shoptet-api.mjs', '--token', apiData.access_token], { stdio: 'inherit' });

  } catch (err) {
    console.error('Chyba při výměně tokenu:', err.message);
  }
}

main().catch(console.error);
