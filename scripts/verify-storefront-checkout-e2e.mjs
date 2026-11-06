#!/usr/bin/env node
/**
 * Storefront Acceptance E2E Testing Script
 *
 * Verifies real end-to-end purchasing via Shoptet storefront checkout:
 * 1. Log in VIP test customer.
 * 2. Add product 0001 (amount = 1) to cart.
 * 3. Verify price in cart (CZK: 720 Kč, EUR: 29,65 €).
 * 4. Complete Step 1 (shipping & payment via safe Bank transfer / PPL 0 Kč).
 * 5. Complete Step 2 (recapitulation & order submission).
 * 6. Confirm order on /objednavka/dekujeme/.
 * 7. Query Shoptet REST API to verify final order lines and total.
 * 8. Verify Ceník 1 (Hlavní ceník) was untouched and remains 800.00 CZK.
 */

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';
const CUSTOMER_GUID = '1f676f66-d9ea-11f1-a35a-bc241195dd28';
const CUSTOMER_EMAIL = 'vip-shopper@example.com';
const CUSTOMER_PASS = 'Heslo123456!';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

async function setCustomerPricelist(pricelistId) {
  const res = await fetch(`https://api.myshoptet.com/api/customers/${CUSTOMER_GUID}`, {
    method: 'PATCH',
    headers: {
      'Shoptet-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ data: { pricelistId } })
  });
  if (!res.ok) {
    throw new Error(`Failed to update customer pricelist to ${pricelistId}: HTTP ${res.status}`);
  }
}

async function verifyMainPricelistUntouched() {
  const res = await fetch(`https://api.myshoptet.com/api/price-lists/1/prices?code=0001`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const data = await res.json();
  const price = data.data?.prices?.[0]?.price?.price;
  if (price !== '800.00') {
    throw new Error(`CRITICAL: Ceník 1 was modified! Current price: ${price}, expected 800.00`);
  }
  return price;
}

async function executeStorefrontCheckout({ currencyCode, expectedProductPrice, pricelistId, expectedUnitFormatted }) {
  console.log(`\n======================================================`);
  console.log(`Spouštím E2E Storefront Checkout pro měnu ${currencyCode}`);
  console.log(`Cílová cena: ${expectedProductPrice} ${currencyCode} (${expectedUnitFormatted})`);
  console.log(`Přiřazuji zákazníka k ceníku ID ${pricelistId}...`);

  await setCustomerPricelist(pricelistId);

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

  // 1. Initial hit & Login
  const init = await fetch(`${ESHOP_URL}/login/`, { headers });
  saveCookies(init);

  const loginRes = await fetch(`${ESHOP_URL}/action/Customer/Login/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieHeader(),
      'Origin': ESHOP_URL,
      'Referer': `${ESHOP_URL}/login/`
    },
    body: new URLSearchParams({
      email: CUSTOMER_EMAIL,
      password: CUSTOMER_PASS,
      surname: '',
      referer: ''
    }),
    redirect: 'manual'
  });
  saveCookies(loginRes);

  if (loginRes.status !== 302) {
    throw new Error(`Login failed with status ${loginRes.status}`);
  }
  console.log(`✓ VIP zákazník ${CUSTOMER_EMAIL} úspěšně přihlášen`);

  // 2. Set currency
  const curRes = await fetch(`${ESHOP_URL}/action/Currency/changeCurrency/?currencyCode=${currencyCode}`, {
    headers: { ...headers, 'Cookie': getCookieHeader() },
    redirect: 'manual'
  });
  saveCookies(curRes);
  console.log(`✓ Měna session nastavena na ${currencyCode}`);

  // 3. Clear cart if any existing items exist
  const cartPageRes = await fetch(`${ESHOP_URL}/kosik/`, {
    headers: { ...headers, 'Cookie': getCookieHeader() }
  });
  saveCookies(cartPageRes);
  const initialCartHtml = await cartPageRes.text();
  const deleteLinks = [...initialCartHtml.matchAll(/href="(\/action\/Cart\/deleteCartItem\/[^"]+)"/g)].map(m => m[1]);
  for (const delUrl of deleteLinks) {
    const delRes = await fetch(`${ESHOP_URL}${delUrl}`, {
      headers: { ...headers, 'Cookie': getCookieHeader() },
      redirect: 'manual'
    });
    saveCookies(delRes);
  }

  // 4. Add product 0001 (amount = 1)
  const addRes = await fetch(`${ESHOP_URL}/action/Cart/addCartItem/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieHeader(),
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
  if (addRes.status !== 302) {
    throw new Error(`Vložení do košíku selhalo: HTTP ${addRes.status}`);
  }
  console.log(`✓ Produkt 0001 (Unisex hodinky Nature) vložen do košíku`);

  // 5. Verify price in cart (/kosik/)
  const verifyCartRes = await fetch(`${ESHOP_URL}/kosik/`, {
    headers: { ...headers, 'Cookie': getCookieHeader() }
  });
  saveCookies(verifyCartRes);
  const cartHtml = await verifyCartRes.text();

  if (!cartHtml.includes(expectedUnitFormatted)) {
    throw new Error(`Košík neobsahuje očekávanou cenu "${expectedUnitFormatted}"!`);
  }
  console.log(`✓ V košíku ověřena správná VIP cena: ${expectedUnitFormatted}`);

  // 6. Step 1: Shipping & Payment
  const s1Val = await fetch(`${ESHOP_URL}/action/orderingProcess/Step1Validate/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieHeader(),
      'Origin': ESHOP_URL,
      'Referer': `${ESHOP_URL}/objednavka/krok-1/`
    },
    body: new URLSearchParams({
      language: 'cs',
      shippingId: '65', // PPL Parcel CZ Private (0 Kč)
      billingId: '5'     // Převodem / Bank transfer (0 Kč)
    }),
    redirect: 'manual'
  });
  saveCookies(s1Val);
  if (s1Val.status !== 302 || !s1Val.headers.get('location')?.includes('/objednavka/krok-2/')) {
    throw new Error(`Krok 1 selhal: redirect=${s1Val.headers.get('location')}`);
  }
  console.log(`✓ Krok 1 (Doprava a platba) dokončen (PPL + Bank transfer)`);

  // 7. Step 2: Customer Address, Consent, Submit Order
  const s2Body = new URLSearchParams({
    language: 'cs',
    surname: '',
    billFullName: 'VIP Zakaznik',
    email: CUSTOMER_EMAIL,
    phoneCode: JSON.stringify({ phoneCode: '+420', countryCode: 'CZ', countryId: '43' }),
    phone: '777888999',
    billStreet: 'Testovaci 10',
    billCity: 'Praha',
    billZip: '11000',
    billCountryId: '43',
    'consents[]': '4'
  });

  const s2Val = await fetch(`${ESHOP_URL}/action/orderingProcess/Step2Validate/`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': getCookieHeader(),
      'Origin': ESHOP_URL,
      'Referer': `${ESHOP_URL}/objednavka/krok-2/`
    },
    body: s2Body,
    redirect: 'manual'
  });
  saveCookies(s2Val);

  const loc = s2Val.headers.get('location') || '';
  if (s2Val.status !== 302 || !loc.includes('/objednavka/dekujeme/')) {
    throw new Error(`Odeslání objednávky v Kroku 2 selhalo: redirect=${loc}`);
  }
  console.log(`✓ Krok 2 úspěšně odeslán -> přesměrování na /objednavka/dekujeme/`);

  // 8. Thank you page & Order Code
  const thanksRes = await fetch(loc.startsWith('http') ? loc : `${ESHOP_URL}${loc}`, {
    headers: { ...headers, 'Cookie': getCookieHeader() }
  });
  const thanksHtml = await thanksRes.text();
  const orderCodeMatch = thanksHtml.match(/číslo\s*objednávky[\s\S]*?<strong>\s*([0-9]+)\s*<\/strong>/i)
    || thanksHtml.match(/objednávk[ay]\s*(?:č\.|číslo)?\s*<strong>\s*([0-9]+)\s*<\/strong>/i)
    || thanksHtml.match(/číslo\s*vaší\s*objednávky\s*je\s*<strong>\s*([0-9]+)\s*<\/strong>/i)
    || thanksHtml.match(/objednávka:\s*([0-9]+)/i);

  let orderCode = orderCodeMatch ? orderCodeMatch[1] : null;

  // 9. Query Shoptet REST API for latest orders if not extracted from HTML
  const ordersRes = await fetch(`https://api.myshoptet.com/api/orders?page=1&itemsPerPage=3`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const ordersData = await ordersRes.json();
  const latestOrderSummary = ordersData.data?.orders?.[0];

  if (!orderCode && latestOrderSummary) {
    orderCode = latestOrderSummary.code;
  }

  console.log(`✓ Identifikován kód objednávky: ${orderCode}`);

  // 10. Fetch order detail from Shoptet API
  const orderDetailRes = await fetch(`https://api.myshoptet.com/api/orders/${orderCode}`, {
    headers: { 'Shoptet-Access-Token': TOKEN }
  });
  const orderDetail = await orderDetailRes.json();
  const order = orderDetail.data?.order;

  const productItem = order.items.find(i => i.itemType === 'product' && i.name.includes('Unisex hodinky'));
  const shippingItem = order.items.find(i => i.itemType === 'shipping');
  const billingItem = order.items.find(i => i.itemType === 'billing');

  console.log(`\n--- Rekapitulace z administrace Shoptetu (Kód: ${orderCode}) ---`);
  console.log(`Měna objednávky: ${order.price.currencyCode}`);
  console.log(`Položka produktu: ${productItem?.name}`);
  console.log(`Cena produktu s DPH: ${productItem?.itemPrice?.withVat} ${order.price.currencyCode}`);
  console.log(`Doprava (${shippingItem?.name || 'neuvedena'}): ${shippingItem?.itemPrice?.withVat || '0.00'} ${order.price.currencyCode}`);
  console.log(`Platba (${billingItem?.name || 'neuvedena'}): ${billingItem?.itemPrice?.withVat || '0.00'} ${order.price.currencyCode}`);
  console.log(`Celková částka k úhradě: ${order.price.toPay} ${order.price.currencyCode}`);
  console.log(`Admin URL: https://826800.myshoptet.com/admin/objednavky-detail?id=${order.orderId || orderCode}`);

  // Assertions
  if (productItem?.itemPrice?.withVat !== expectedProductPrice) {
    throw new Error(`Cena položky v objednávce ${productItem?.itemPrice?.withVat} neodpovídá očekávané ${expectedProductPrice}!`);
  }
  if (order.price.toPay !== expectedProductPrice) {
    throw new Error(`Celková cena objednávky ${order.price.toPay} neodpovídá očekávané ${expectedProductPrice}!`);
  }

  console.log(`✓ Objednávka ${orderCode} plně vyhovuje všem kritériím!`);
  return {
    orderCode,
    currency: order.price.currencyCode,
    productPrice: productItem?.itemPrice?.withVat,
    shippingFee: shippingItem?.itemPrice?.withVat || '0.00',
    billingFee: billingItem?.itemPrice?.withVat || '0.00',
    totalToPay: order.price.toPay,
    adminUrl: `https://826800.myshoptet.com/admin/objednavky-detail?id=${order.orderId || orderCode}`
  };
}

async function run() {
  console.log(`Zahajuji finální akceptační E2E test pro CZK a EUR...`);

  // Kontrola ceníku 1 před testem
  const initialMainPrice = await verifyMainPricelistUntouched();
  console.log(`✓ Ověřeno: Ceník 1 (Hlavní ceník) má základní cenu ${initialMainPrice} CZK (netknuto)`);

  // 1. Test CZK
  const czkResult = await executeStorefrontCheckout({
    currencyCode: 'CZK',
    expectedProductPrice: '720.00',
    pricelistId: 2,
    expectedUnitFormatted: '720 Kč'
  });

  // 2. Test EUR
  const eurResult = await executeStorefrontCheckout({
    currencyCode: 'EUR',
    expectedProductPrice: '29.65',
    pricelistId: 5,
    expectedUnitFormatted: '29,65 €'
  });

  // Kontrola ceníku 1 po testu
  const finalMainPrice = await verifyMainPricelistUntouched();
  console.log(`\n✓ Ověřeno po testech: Ceník 1 má stále přesně ${finalMainPrice} CZK (absolutně netknuto)`);

  console.log(`\n======================================================`);
  console.log(`VÝSLEDEK FINÁLNÍHO AKCEPTAČNÍHO TESTU: ÚSPĚCH`);
  console.log(`CZK Objednávka: ${czkResult.orderCode} | Cena: ${czkResult.productPrice} CZK | Celkem: ${czkResult.totalToPay} CZK`);
  console.log(`EUR Objednávka: ${eurResult.orderCode} | Cena: ${eurResult.productPrice} EUR | Celkem: ${eurResult.totalToPay} EUR`);
}

run().catch(err => {
  console.error('\n❌ Test selhal:', err);
  process.exit(1);
});
