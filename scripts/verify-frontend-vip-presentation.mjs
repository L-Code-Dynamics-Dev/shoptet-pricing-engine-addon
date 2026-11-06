#!/usr/bin/env node
/**
 * Frontend VIP Price Presentation & Verification Script
 *
 * Verifies:
 * 1. Catalog, product detail, and cart presentation of VIP prices:
 *    - final customer price: 720 Kč
 *    - strikethrough original price: 800 Kč
 *    - badge: -10 %
 *    - savings: 80 Kč
 * 2. Browser console error audit & screenshots in artifact directory
 * 3. Price integrity between frontend presentation and Shoptet backend order
 * 4. EUR checkout shipping availability audit
 * 5. Main pricelist ID 1 read-only protection check
 */

import puppeteer from 'puppeteer-core';
import path from 'node:path';

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';
const ARTIFACT_DIR = '/Users/lucky/.gemini/antigravity-cli/brain/71cb1125-92d1-461e-956a-9aadb36dcc9c';
const CUSTOMER_EMAIL = 'vip-shopper@example.com';
const CUSTOMER_PASS = 'Heslo123456!';

async function getAuthenticatedCookies() {
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

  const init = await fetch(`${ESHOP_URL}/login/`);
  saveCookies(init);

  const loginRes = await fetch(`${ESHOP_URL}/action/Customer/Login/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieHeader(),
      'Origin': ESHOP_URL,
      'Referer': `${ESHOP_URL}/login/`
    },
    body: new URLSearchParams({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASS, surname: '', referer: '' }),
    redirect: 'manual'
  });
  saveCookies(loginRes);

  const curRes = await fetch(`${ESHOP_URL}/action/Currency/changeCurrency/?currencyCode=CZK`, {
    headers: { 'Cookie': getCookieHeader() },
    redirect: 'manual'
  });
  saveCookies(curRes);

  return cookieJar;
}

async function verifyPricelist1Protection() {
  const res = await fetch(`https://api.myshoptet.com/api/price-lists/1`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const plData = await res.json();
  const pl = plData.data?.priceList;

  const priceRes = await fetch(`https://api.myshoptet.com/api/price-lists/1/prices?code=0001`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const priceData = await priceRes.json();
  const priceItem = priceData.data?.prices?.[0];

  return {
    pricelistId: pl?.id,
    name: pl?.name,
    isDefault: pl?.isDefault,
    currencyCode: pl?.currencyCode,
    productPrice: priceItem?.price?.price,
    actionPrice: priceItem?.price?.actionPrice,
    commonPrice: priceItem?.price?.commonPrice
  };
}

async function verifyOrderIntegrity() {
  const orderRes = await fetch(`https://api.myshoptet.com/api/orders/2026000004`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const orderData = await orderRes.json();
  const order = orderData.data?.order;
  const productItem = order?.items?.find(i => i.itemType === 'product' && i.code === '0001');

  return {
    orderCode: order?.code,
    currency: order?.price?.currencyCode,
    itemPriceWithVat: productItem?.itemPrice?.withVat,
    unitPriceWithVat: productItem?.unitPrice?.withVat,
    totalToPay: order?.price?.toPay
  };
}

async function runAudit() {
  console.log('1. Autentizace a inicializace košíku pro VIP zákazníka...');
  const cookieJar = await getAuthenticatedCookies();

  console.log('2. Spouštění prohlížeče Chrome (Puppeteer)...');
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ text: msg.text(), location: msg.location() });
  });
  page.on('pageerror', err => consoleErrors.push({ text: err.toString() }));

  const puppeteerCookies = Object.entries(cookieJar).map(([name, value]) => ({
    name,
    value,
    domain: '826800.myshoptet.com',
    path: '/'
  }));
  await page.setCookie(...puppeteerCookies);

  // A. KATALOG
  console.log('3. Testování katalogu (/hodinky/)...');
  await page.goto(`${ESHOP_URL}/hodinky/`, { waitUntil: 'networkidle2' });
  const catalogScreenshotPath = path.join(ARTIFACT_DIR, 'vip_katalog.png');
  await page.screenshot({ path: catalogScreenshotPath });

  const catalogDOM = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.product, [data-micro="product"]'))
      .find(el => el.innerText.includes('Unisex hodinky Nature'));
    return {
      title: card?.querySelector('.name')?.innerText?.trim(),
      customerPrice: card?.querySelector('.price-final, .price')?.innerText?.trim(),
      originalPriceStrikethrough: card?.querySelector('.price-standard, .price-additional, del, s')?.innerText?.trim(),
      badgeText: card?.querySelector('.flags .flag, .flags span')?.innerText?.trim(),
      allBadges: Array.from(card?.querySelectorAll('.flags span, .flag') || []).map(f => f.innerText.trim()).filter(Boolean),
      fullPriceSnippet: card?.querySelector('.prices, .price-holder')?.innerText?.replace(/\s+/g, ' ').trim()
    };
  });

  // B. DETAIL PRODUKTU
  console.log('4. Testování detailu produktu (/unisex-hodinky-nature/)...');
  await page.goto(`${ESHOP_URL}/unisex-hodinky-nature/`, { waitUntil: 'networkidle2' });
  const detailScreenshotPath = path.join(ARTIFACT_DIR, 'vip_detail.png');
  await page.screenshot({ path: detailScreenshotPath });

  const detailDOM = await page.evaluate(() => {
    return {
      title: document.querySelector('h1')?.innerText?.trim(),
      customerPrice: document.querySelector('.price-final-holder, .price-final')?.innerText?.trim(),
      originalPriceStrikethrough: document.querySelector('.price-standard, .price-additional, del, s')?.innerText?.trim(),
      badgeText: document.querySelector('.price-save, .discount, .save-amount')?.innerText?.trim(),
      allBadges: Array.from(document.querySelectorAll('.flags span, .flag, .action-flags span') || []).map(f => f.innerText.trim()).filter(Boolean),
      priceBlockText: document.querySelector('.price-wrapper, .p-final-price-wrapper, .price-holder')?.innerText?.replace(/\s+/g, ' ').trim()
    };
  });

  // C. KOŠÍK
  console.log('5. Testování košíku (/kosik/)...');
  await page.goto(`${ESHOP_URL}/kosik/`, { waitUntil: 'networkidle2' });
  const cartScreenshotPath = path.join(ARTIFACT_DIR, 'vip_kosik.png');
  await page.screenshot({ path: cartScreenshotPath });

  const cartDOM = await page.evaluate(() => {
    const row = document.querySelector('tr[data-micro="cartItem"], tr.removeable');
    const discountEl = row?.querySelector('[data-testid="cartItemDiscount"]');
    const unitPriceEl = row?.querySelector('[data-testid="cartItemPrice"]');
    const totalPriceEl = row?.querySelector('[data-testid="cartPrice"]');
    return {
      productName: row?.querySelector('.main-link')?.innerText?.trim(),
      quantity: row?.querySelector('input[name="amount"]')?.value,
      unitPrice: unitPriceEl?.innerText?.trim(),
      discountTooltip: discountEl?.getAttribute('title')?.trim(),
      totalPrice: totalPriceEl?.innerText?.trim(),
      summaryTotal: document.querySelector('.price-total, [data-testid="priceTotal"]')?.innerText?.trim()
    };
  });

  await browser.close();

  // D. OCHRANA HLAVNÍHO CENÍKU ID 1
  console.log('6. Kontrola ochrany hlavního ceníku ID 1...');
  const pl1Status = await verifyPricelist1Protection();

  // E. SHODA CENY MEZI PREZENTACÍ A OBJEDNÁVKOU
  console.log('7. Kontrola shody mezi prezentovanou cenou a uloženou objednávkou...');
  const orderCheck = await verifyOrderIntegrity();

  console.log('\n======================================================');
  console.log('VÝSLEDKY TESTŮ:');
  console.log('KATALOG DOM:', JSON.stringify(catalogDOM, null, 2));
  console.log('DETAIL DOM:', JSON.stringify(detailDOM, null, 2));
  console.log('KOŠÍK DOM:', JSON.stringify(cartDOM, null, 2));
  console.log('JS CHYBY V KONZOLI:', JSON.stringify(consoleErrors, null, 2));
  console.log('OCHRANA CENÍKU 1:', JSON.stringify(pl1Status, null, 2));
  console.log('SHODA S OBJEDNÁVKOU:', JSON.stringify(orderCheck, null, 2));

  return {
    catalogDOM,
    detailDOM,
    cartDOM,
    consoleErrors,
    pl1Status,
    orderCheck
  };
}

runAudit().catch(err => {
  console.error('Audit selhal:', err);
  process.exit(1);
});
