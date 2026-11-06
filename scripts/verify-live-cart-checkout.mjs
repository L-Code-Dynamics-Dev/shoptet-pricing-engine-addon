#!/usr/bin/env node
/**
 * Live Storefront Cart & Purchasing Multi-Currency Verification Script
 * Fully tests and verifies live before-and-after price changes in CZK and EUR
 * triggered by Loyalty Pricing Rules in Shoptet shopping cart.
 */

import { evaluatePricing } from '../packages/core/src/pricing-policy.mjs';

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';
const PRODUCT_CODE = '0001';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function setShoptetPrice(priceStr, currencyCode = 'CZK') {
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
          currencyCode,
          priceWithVat: {
            price: priceStr
          }
        }
      ]
    })
  });
  if (!res.ok) {
    throw new Error(`Chyba zápisu ceny ${priceStr} ${currencyCode}: HTTP ${res.status} ${await res.text()}`);
  }
}

async function verifyApiPrice() {
  const res = await fetch(`https://api.myshoptet.com/api/price-lists/1/prices?code=${PRODUCT_CODE}`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const data = await res.json();
  const item = data.data.prices[0];
  return { price: item.price.price, currency: item.currencyCode };
}

async function fetchLiveCart(stepName, currencyCode = 'CZK') {
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

  // 1. Nastavení měny session na storefrontu
  let switchRes = await fetch(`${ESHOP_URL}/action/Currency/changeCurrency/?currencyCode=${currencyCode}`, {
    headers,
    redirect: 'manual'
  });
  saveCookies(switchRes);

  // 2. Detail produktu
  const prodRes = await fetch(`${ESHOP_URL}/unisex-hodinky-nature/`, {
    headers: { ...headers, 'Cookie': getCookieHeader() }
  });
  saveCookies(prodRes);

  // 3. Vložení do košíku
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

  // 4. Načtení košíku
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

  console.log(`[${stepName}] (${currencyCode})`);
  console.log(`   Jednotková cena: ${unitPrice}`);
  console.log(`   Cena řádku:     ${rowTotal}`);
  console.log(`   Celkem k úhradě: ${recapTotal}`);

  return { unitPrice, rowTotal, recapTotal };
}

async function run() {
  console.log(`================================================================`);
  console.log(`KOMPLETNÍ MULTI-CURRENCY TEST VĚRNOSTNÍHO KOŠÍKU (CZK & EUR)`);
  console.log(`E-shop: ${ESHOP_URL} | Produkt: ${PRODUCT_CODE} (Unisex hodinky Nature)`);
  console.log(`================================================================\n`);

  // 0. Kontrola aktivních měn v Shoptet
  console.log('--- 0. KONTROLA AKTIVNÍCH MĚN V E-SHOPU ---');
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

  // ==========================================
  // FÁZE 1: TESTOVÁNÍ V ČESKÉ KORUNĚ (CZK)
  // ==========================================
  console.log('\n================================================================');
  console.log('FÁZE 1: VĚRNOSTNÍ PRAVIDLA A NÁKUPNÍ KOŠÍK V CZK');
  console.log('================================================================');

  // 1.1 Výchozí stav CZK (800.00 Kč)
  await setShoptetPrice('800.00', 'CZK');
  const apiCzk1 = await verifyApiPrice();
  console.log(`Shoptet API ceník (základ): ${apiCzk1.price} ${apiCzk1.currency}`);
  const cartCzkBase = await fetchLiveCart('CZK Košík: Základní cena', 'CZK');

  // 1.2 Procentní věrnostní pravidlo CZK (10% sleva: 800 -> 720 Kč)
  const czk10 = evaluatePricing({
    baseMinor: 80000,
    actionMinor: null,
    tierPercent: 10,
    rounding: 'math',
    incrementMinor: 100
  });
  const priceCzk10 = (czk10.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu: 800.00 Kč - 10% = ${priceCzk10} Kč`);
  await setShoptetPrice(priceCzk10, 'CZK');
  const cartCzk10 = await fetchLiveCart('CZK Košík: 10% věrnostní sleva', 'CZK');

  // 1.3 Pevná věrnostní sleva CZK (150 Kč: 800 -> 650 Kč)
  const czkFixed = evaluatePricing({
    baseMinor: 80000,
    actionMinor: null,
    fixedDiscountMinor: 15000,
    rounding: 'math',
    incrementMinor: 100
  });
  const priceCzkFixed = (czkFixed.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu: 800.00 Kč - 150.00 Kč = ${priceCzkFixed} Kč`);
  await setShoptetPrice(priceCzkFixed, 'CZK');
  const cartCzkFixed = await fetchLiveCart('CZK Košík: Pevná sleva 150 Kč', 'CZK');

  // ==========================================
  // FÁZE 2: TESTOVÁNÍ V EUR
  // ==========================================
  console.log('\n================================================================');
  console.log('FÁZE 2: VĚRNOSTNÍ PRAVIDLA A NÁKUPNÍ KOŠÍK V EUR');
  console.log('================================================================');

  // 2.1 Výchozí stav EUR (přepočtená základní cena 32.94 €)
  await setShoptetPrice('800.00', 'CZK');
  const cartEurBase = await fetchLiveCart('EUR Košík: Základní cena', 'EUR');

  // 2.2 Procentní věrnostní pravidlo EUR (10% sleva: 32.94 € -> 29.65 €)
  const eur10 = evaluatePricing({
    baseMinor: 3294,
    actionMinor: null,
    tierPercent: 10,
    rounding: 'math',
    incrementMinor: 1
  });
  const priceEur10 = (eur10.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu v EUR: 32.94 € - 10% = ${priceEur10} €`);
  await setShoptetPrice(priceEur10, 'EUR');
  const cartEur10 = await fetchLiveCart('EUR Košík: 10% věrnostní sleva', 'EUR');

  // 2.3 Pevná věrnostní sleva EUR (sleva 5.00 €: 32.94 € -> 27.94 €)
  const eurFixed = evaluatePricing({
    baseMinor: 3294,
    actionMinor: null,
    fixedDiscountMinor: 500,
    rounding: 'math',
    incrementMinor: 1
  });
  const priceEurFixed = (eurFixed.priceMinor / 100).toFixed(2);
  console.log(`Výpočet věrnostního enginu v EUR: 32.94 € - 5.00 € = ${priceEurFixed} €`);
  await setShoptetPrice(priceEurFixed, 'EUR');
  const cartEurFixed = await fetchLiveCart('EUR Košík: Pevná sleva 5.00 €', 'EUR');

  // ==========================================
  // FÁZE 3: CLEANUP / RESTORE PŮVODNÍHO STAVU
  // ==========================================
  console.log('\n--- RESTORE VÝCHOZÍ CENY (800.00 CZK) ---');
  await setShoptetPrice('800.00', 'CZK');
  const restored = await verifyApiPrice();
  console.log(`Cena obnovena na: ${restored.price} ${restored.currency}`);

  // ==========================================
  // VYHODNOCENÍ VÝSLEDKŮ
  // ==========================================
  console.log('\n================================================================');
  console.log('VYHODNOCENÍ ŽIVÉHO TESTU KOŠÍKU V OBOU MĚNÁCH');
  console.log('================================================================');

  const czkDiff10 = cartCzkBase.recapTotal?.includes('800') && cartCzk10.recapTotal?.includes('720');
  const czkDiffFixed = cartCzkBase.recapTotal?.includes('800') && cartCzkFixed.recapTotal?.includes('650');
  const eurDiff10 = cartEurBase.recapTotal?.includes('32,94') && cartEur10.recapTotal?.includes('29,65');
  const eurDiffFixed = cartEurBase.recapTotal?.includes('32,94') && cartEurFixed.recapTotal?.includes('27,94');

  console.log(`CZK Základní cena:   ${cartCzkBase.recapTotal}`);
  console.log(`CZK 10% VIP sleva:   ${cartCzk10.recapTotal} -> ${czkDiff10 ? 'POTVRZENO' : 'CHYBA'}`);
  console.log(`CZK Pevná sleva:     ${cartCzkFixed.recapTotal} -> ${czkDiffFixed ? 'POTVRZENO' : 'CHYBA'}`);

  console.log(`\nEUR Základní cena:   ${cartEurBase.recapTotal}`);
  console.log(`EUR 10% VIP sleva:   ${cartEur10.recapTotal} -> ${eurDiff10 ? 'POTVRZENO' : 'CHYBA'}`);
  console.log(`EUR Pevná sleva:     ${cartEurFixed.recapTotal} -> ${eurDiffFixed ? 'POTVRZENO' : 'CHYBA'}`);

  const allPassed = czkDiff10 && czkDiffFixed && eurDiff10 && eurDiffFixed;

  console.log(`\nCELKOVÝ VÝSLEDEK: ${allPassed ? 'VŠECHNY TESTY V CZK I EUR ÚSPĚŠNĚ POTVRZENY V REÁLNÉM KOŠÍKU!' : 'NEPOTVRZENO'}`);
}

run().catch(console.error);
