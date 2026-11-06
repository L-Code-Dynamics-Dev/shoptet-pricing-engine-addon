#!/usr/bin/env node
import { createShoptetAdapter, ShoptetError } from '../packages/core/src/shoptet-adapter.mjs';

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
const token = args.token || process.env.SHOPTET_ACCESS_TOKEN;

if (!token) {
  console.log(`
POUŽITÍ:
  node scripts/verify-live-shoptet-api.mjs --token <SHOPTET_ACCESS_TOKEN>

STAV:
  Skutečné ověření přes živé Shoptet API je UNVERIFIED.
  Pro spuštění živého ověření předejte platný přístupový token Shoptetu (např. z testovacího e-shopu).
`);
  process.exit(0);
}

console.log('Spouštím ověření přes živé Shoptet API (api.myshoptet.com)...');

const adapter = createShoptetAdapter({
  getToken: async () => token,
  timeoutMs: 15000
});

async function run() {
  const results = {};
  
  // 1. Profil a měny
  try {
    process.stdout.write('1. Ověřuji /api/eshop (profil, měny, DPH)... ');
    const profile = await adapter.profile();
    results.profile = { ok: true, id: profile.id, vatPayer: profile.vatPayer, currencies: profile.currencies.map(c => c.code) };
    console.log('OK (E-shop ID: ' + profile.id + ', měny: ' + results.profile.currencies.join(', ') + ')');
  } catch (e) {
    results.profile = { ok: false, error: e.message, status: e.status };
    console.log('CHYBA: ' + e.message);
  }

  // 2. Stavy objednávek
  try {
    process.stdout.write('2. Ověřuji stavy objednávek... ');
    const statuses = await adapter.orderStatuses();
    results.orderStatuses = { ok: true, count: statuses.length };
    console.log('OK (' + statuses.length + ' stavů)');
  } catch (e) {
    results.orderStatuses = { ok: false, error: e.message };
    console.log('CHYBA: ' + e.message);
  }

  // 3. Ceníky
  try {
    process.stdout.write('3. Ověřuji /api/price-lists (ceníky)... ');
    const pricelists = await adapter.list('pricelists');
    results.pricelists = { ok: true, count: pricelists.items.length, names: pricelists.items.map(p => p.name) };
    console.log('OK (' + pricelists.items.length + ' ceníků: ' + results.pricelists.names.slice(0, 3).join(', ') + (pricelists.items.length > 3 ? '...' : '') + ')');
  } catch (e) {
    results.pricelists = { ok: false, error: e.message };
    console.log('CHYBA: ' + e.message);
  }

  // 4. Značky
  try {
    process.stdout.write('4. Ověřuji /api/brands (katalog značek)... ');
    const brands = await adapter.list('brands', { limit: 5 });
    results.brands = { ok: true, count: brands.items.length };
    console.log('OK (' + brands.items.length + ' vzorových značek)');
  } catch (e) {
    results.brands = { ok: false, error: e.message };
    console.log('CHYBA: ' + e.message);
  }

  // 5. Kategorie
  try {
    process.stdout.write('5. Ověřuji /api/categories (katalog kategorií)... ');
    const categories = await adapter.list('categories', { limit: 5 });
    results.categories = { ok: true, count: categories.items.length };
    console.log('OK (' + categories.items.length + ' vzorových kategorií)');
  } catch (e) {
    results.categories = { ok: false, error: e.message };
    console.log('CHYBA: ' + e.message);
  }

  // 6. Produkty
  try {
    process.stdout.write('6. Ověřuji /api/products (katalog produktů)... ');
    const products = await adapter.list('products', { limit: 5 });
    results.products = { ok: true, count: products.items.length };
    console.log('OK (' + products.items.length + ' vzorových produktů)');
  } catch (e) {
    results.products = { ok: false, error: e.message };
    console.log('CHYBA: ' + e.message);
  }

  // 7. Oprávnění koncových bodů
  try {
    process.stdout.write('7. Ověřuji /api/system/endpoints (schválená oprávnění)... ');
    const caps = await adapter.capabilities();
    results.capabilities = { ok: true, count: caps.endpoints.length };
    console.log('OK (' + caps.endpoints.length + ' schválených koncových bodů)');
  } catch (e) {
    results.capabilities = { ok: false, error: e.message };
    console.log('CHYBA / INFO: ' + e.message);
  }

  console.log('\nVÝSLEDEK ŽIVÉHO OVĚŘENÍ SHOPTET API:');
  const allOk = Object.values(results).every(r => r.ok);
  if (allOk) {
    console.log('Všechna volání Shoptet API proběhla v pořádku a odpovídají našim schématům.');
  } else {
    console.log('Některá volání selhala nebo vyžadují vyšší oprávnění doplňku.');
  }
}

run().catch(console.error);
