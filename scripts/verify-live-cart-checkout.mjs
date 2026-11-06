#!/usr/bin/env node
/**
 * Live Storefront Cart & Purchasing Verification Script
 * Tests live product detail, add-to-cart flow, and cart DOM pricing on the test Shoptet.
 */

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

const cookieJar = {};
function saveCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    if (!c) continue;
    const parts = c.split(';')[0].split('=');
    if (parts.length >= 2) cookieJar[parts[0].trim()] = parts.slice(1).join('=').trim();
  }
}
function getCookieHeader() {
  return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function run() {
  console.log(`=== OVĚŘENÍ NÁKUPNÍHO PROCESU A KOŠÍKU NA ${ESHOP_URL} ===\n`);

  // 1. Ověření stavu měn v Shoptet API
  console.log('1. Kontrola aktivních měn v Shoptet API...');
  let currencies = [];
  try {
    const res = await fetch('https://api.myshoptet.com/api/eshop', {
      headers: { 'Shoptet-Access-Token': TOKEN }
    });
    if (res.ok) {
      const data = await res.json();
      currencies = (data.data.currencies || []).map(c => c.code);
      console.log(`   Aktivní měny v e-shopu: ${currencies.join(', ')}`);
    }
  } catch (e) {
    console.log(`   Chyba čtení profilu: ${e.message}`);
  }

  const hasEur = currencies.includes('EUR');
  if (!hasEur) {
    console.log('   UPOZORNĚNÍ: E-shop 826800 nemá v Shoptet administraci aktivovanou měnu EUR (pouze CZK).');
    console.log('   Nákupní proces v EUR na storefrontu bude možné ověřit, jakmile administrátor přidá EUR v:');
    console.log('   Nastavení -> Základní nastavení -> Měny.');
  }

  // 2. Načtení detailu produktu (CZK)
  console.log('\n2. Načítám detail testovacího produktu /unisex-hodinky-nature/ ...');
  const prodRes = await fetch(`${ESHOP_URL}/unisex-hodinky-nature/`, { headers });
  saveCookies(prodRes);
  const prodHtml = await prodRes.text();
  const hasProd = prodHtml.includes('Unisex hodinky Nature') && prodHtml.includes('800');
  console.log(`   Dostupnost produktu (800 Kč): ${hasProd ? 'POTVRZENO' : 'CHYBA'}`);

  // 3. Vložení do košíku
  console.log('\n3. Odesílám přidání do košíku přes POST /action/Cart/addCartItem/ ...');
  const addRes = await fetch(`${ESHOP_URL}/action/Cart/addCartItem/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Cookie': getCookieHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': ESHOP_URL,
      'Referer': `${ESHOP_URL}/unisex-hodinky-nature/`
    },
    body: new URLSearchParams({
      productId: '1',
      priceId: '14',
      language: 'cs',
      amount: '1'
    }),
    redirect: 'manual'
  });
  saveCookies(addRes);
  console.log(`   Odpověď Shoptetu: HTTP ${addRes.status} (přesměrování na košík/detail)`);

  // 4. Načtení stránky košíku /kosik/
  console.log('\n4. Načítám stránku košíku /kosik/ s aktivní session...');
  const cartRes = await fetch(`${ESHOP_URL}/kosik/`, {
    headers: {
      ...headers,
      'Cookie': getCookieHeader()
    }
  });
  saveCookies(cartRes);
  const cartHtml = await cartRes.text();

  const hasCartTable = cartHtml.includes('cart-table');
  const hasCartItem = cartHtml.includes('cart-item') || cartHtml.includes('data-micro="cartItem"');
  
  // Parsování cen z košíku
  const mPrice = cartHtml.match(/<td[^>]*class="[^"]*p-price[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const mTotal = cartHtml.match(/<td[^>]*class="[^"]*p-total[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const mRecap = cartHtml.match(/<[^>]*data-testid="recapFullPrice"[^>]*>([\s\S]*?)<\/[^>]+>/i);

  const unitPrice = mPrice ? mPrice[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  const rowTotal = mTotal ? mTotal[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  const recapTotal = mRecap ? mRecap[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;

  console.log(`   Tabulka košíku (.cart-table): ${hasCartTable ? 'NALEZENA' : 'CHYBÍ'}`);
  console.log(`   Položka v košíku: ${hasCartItem ? 'NALEZENA' : 'CHYBÍ'}`);
  console.log(`   Skutečná jednotková cena v košíku: ${unitPrice || 'Neznámá'}`);
  console.log(`   Skutečná celková cena řádku: ${rowTotal || 'Neznámá'}`);
  console.log(`   Skutečná rekapitulace celkem: ${recapTotal || 'Neznámá'}`);

  const czkVerified = hasCartTable && hasCartItem && (recapTotal?.includes('800') || rowTotal?.includes('800'));

  console.log('\n=== SHRNUTÍ ŽIVÉHO TESTU KOŠÍKU ===');
  console.log(`CZK košík: ${czkVerified ? 'PLNĚ OVĚŘENO (reálná cena 800 Kč v košíku)' : 'NEPOTVRZENO'}`);
  console.log(`EUR košík: ${hasEur ? 'PŘIPRAVENO K OVĚŘENÍ' : 'UNVERIFIED — v Shoptet administraci zatím není aktivována měna EUR'}`);
}

run().catch(console.error);
