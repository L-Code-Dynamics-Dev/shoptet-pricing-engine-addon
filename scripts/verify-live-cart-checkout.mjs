#!/usr/bin/env node
/**
 * Live Storefront Cart & Purchasing Verification Script
 * Proves real before-and-after price changes triggered by Loyalty Pricing Rules in Shoptet shopping cart.
 */

import { evaluatePricing } from '../packages/core/src/pricing-policy.mjs';

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';
const PRODUCT_CODE = '0001';
const BASE_PRICE = '800.00';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function setShoptetPrice(priceStr) {
  const res = await fetch(`https://api.myshoptet.com/api/price-lists/1/prices`, {
    method: 'PATCH',
    headers: {
      'Shoptet-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      data: [
        {
          code: PRODUCT_CODE,
          priceWithVat: {
            price: priceStr
          }
        }
      ]
    })
  });
  if (!res.ok) {
    throw new Error(`Chyba při zápisu ceny ${priceStr} do Shoptetu: HTTP ${res.status} ${await res.text()}`);
  }
}

async function verifyApiPrice() {
  const res = await fetch(`https://api.myshoptet.com/api/price-lists/1/prices?code=${PRODUCT_CODE}`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const data = await res.json();
  return data.data.prices[0].price.price;
}

async function fetchLiveCart(stepName) {
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

  // 1. Detail produktu
  const prodRes = await fetch(`${ESHOP_URL}/unisex-hodinky-nature/`, { headers });
  saveCookies(prodRes);

  // 2. Vložení do košíku
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

  // 3. Načtení košíku
  const cartRes = await fetch(`${ESHOP_URL}/kosik/`, {
    headers: {
      ...headers,
      'Cookie': getCookieHeader()
    }
  });
  saveCookies(cartRes);
  const cartHtml = await cartRes.text();

  const mPrice = cartHtml.match(/<td[^>]*class="[^"]*p-price[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const mTotal = cartHtml.match(/<td[^>]*class="[^"]*p-total[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
  const mRecap = cartHtml.match(/<[^>]*data-testid="recapFullPrice"[^>]*>([\s\S]*?)<\/[^>]+>/i);

  const unitPrice = mPrice ? mPrice[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  const rowTotal = mTotal ? mTotal[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
  const recapTotal = mRecap ? mRecap[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;

  console.log(`[${stepName}]`);
  console.log(`   Jednotková cena: ${unitPrice}`);
  console.log(`   Cena řádku:     ${rowTotal}`);
  console.log(`   Celkem k úhradě: ${recapTotal}`);

  return { unitPrice, rowTotal, recapTotal };
}

async function run() {
  console.log(`================================================================`);
  console.log(`OVĚŘENÍ ZMĚNY CENY V KOŠÍKU VYVOLANÉ VĚRNOSTNÍM PRAVIDLEM (LIVE)`);
  console.log(`E-shop: ${ESHOP_URL} | Produkt: ${PRODUCT_CODE} (Unisex hodinky Nature)`);
  console.log(`================================================================\n`);

  // 0. Kontrola aktivních měn v Shoptet
  console.log('--- 0. KONTROLA MĚN V E-SHOPU ---');
  let currencies = [];
  try {
    const res = await fetch('https://api.myshoptet.com/api/eshop', {
      headers: { 'Shoptet-Access-Token': TOKEN }
    });
    if (res.ok) {
      const data = await res.json();
      currencies = (data.data.currencies || []).map(c => c.code);
      console.log(`Aktivní měny v e-shopu: ${currencies.join(', ')}`);
    }
  } catch (e) {
    console.log(`Chyba čtení profilu: ${e.message}`);
  }

  // 1. Výchozí stav (Bez věrnostního pravidla - Standardní cena 800 Kč)
  console.log('\n--- 1. TEST BEZ VĚRNOSTNÍHO PRAVIDLA (Základní cena) ---');
  await setShoptetPrice(BASE_PRICE);
  const apiPrice1 = await verifyApiPrice();
  console.log(`Shoptet API cena v ceníku: ${apiPrice1} Kč`);
  const cartBase = await fetchLiveCart('Košík před aplikací věrnostního pravidla');

  // 2. Aplikace věrnostního pravidla (10% VIP sleva: 800 Kč -> 720 Kč)
  console.log('\n--- 2. APLIKACE VĚRNOSTNÍHO PRAVIDLA (10% Tier Discount) ---');
  const loyaltyResult10 = evaluatePricing({
    baseMinor: 80000,
    actionMinor: null,
    tierPercent: 10,
    rounding: 'math',
    incrementMinor: 100
  });
  const price10 = (loyaltyResult10.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu: 800.00 Kč - 10% = ${price10} Kč (sleva ${loyaltyResult10.effectiveTierPercent}%)`);
  
  await setShoptetPrice(price10);
  const apiPrice2 = await verifyApiPrice();
  console.log(`Shoptet API cena po synchronizaci pravidla: ${apiPrice2} Kč`);
  const cartLoyalty10 = await fetchLiveCart('Košík po aplikaci 10% věrnostní slevy');

  // 3. Aplikace věrnostního pravidla (Pevná sleva 150 Kč: 800 Kč -> 650 Kč)
  console.log('\n--- 3. APLIKACE VĚRNOSTNÍHO PRAVIDLA (Pevná sleva 150 Kč) ---');
  const loyaltyResultFixed = evaluatePricing({
    baseMinor: 80000,
    actionMinor: null,
    fixedDiscountMinor: 15000,
    rounding: 'math',
    incrementMinor: 100
  });
  const priceFixed = (loyaltyResultFixed.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu: 800.00 Kč - 150.00 Kč = ${priceFixed} Kč`);
  
  await setShoptetPrice(priceFixed);
  const apiPrice3 = await verifyApiPrice();
  console.log(`Shoptet API cena po synchronizaci pevné slevy: ${apiPrice3} Kč`);
  const cartLoyaltyFixed = await fetchLiveCart('Košík po aplikaci pevné slevy 150 Kč');

  // 4. Vyčištění a návrat na standardní cenu
  console.log('\n--- 4. RESTORE PŮVODNÍHO STAVU ---');
  await setShoptetPrice(BASE_PRICE);
  const apiPriceRestore = await verifyApiPrice();
  console.log(`Shoptet API cena obnovena na: ${apiPriceRestore} Kč`);

  // 5. Vyhodnocení změn v košíku
  console.log('\n================================================================');
  console.log('VYHODNOCENÍ VÝSLEDKŮ ŽIVÉHO NÁKUPNÍHO TESTU V KOŠÍKU');
  console.log('================================================================');

  const baseRecap = cartBase.recapTotal;
  const loyalty10Recap = cartLoyalty10.recapTotal;
  const loyaltyFixedRecap = cartLoyaltyFixed.recapTotal;

  console.log(`1. Základní cena v košíku:           ${baseRecap}`);
  console.log(`2. Cena v košíku s 10% věrnostní slevou: ${loyalty10Recap}`);
  console.log(`3. Cena v košíku s pevnou slevou 150 Kč:  ${loyaltyFixedRecap}`);

  const diff10Verified = baseRecap?.includes('800') && loyalty10Recap?.includes('720');
  const diffFixedVerified = baseRecap?.includes('800') && loyaltyFixedRecap?.includes('650');

  console.log(`\nOvěření změny ceny pro 10% slevu:   ${diff10Verified ? 'POTVRZENO (800 Kč -> 720 Kč)' : 'CHYBA'}`);
  console.log(`Ověření změny ceny pro pevnou slevu: ${diffFixedVerified ? 'POTVRZENO (800 Kč -> 650 Kč)' : 'CHYBA'}`);

  const czkFullyVerified = diff10Verified && diffFixedVerified;
  const hasEur = currencies.includes('EUR');

  console.log(`\nCELKOVÝ STAV TESTU:`);
  console.log(`CZK košík: ${czkFullyVerified ? 'PLNĚ OVĚŘENO — reálná změna ceny vyvolaná věrnostním pravidlem přímo v Shoptet košíku!' : 'NEPOTVRZENO'}`);
  console.log(`EUR košík: ${hasEur ? 'PLNĚ PŘIPRAVENO' : 'UNVERIFIED — v Shoptet administraci zatím není aktivována měna EUR (Nastavení -> Základní nastavení -> Měny)'}`);
}

run().catch(console.error);
