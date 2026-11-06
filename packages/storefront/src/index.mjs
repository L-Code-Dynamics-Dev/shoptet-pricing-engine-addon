import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const STOREFRONT_FILE_NAMES = [
  'vip_catalog.js',
  'vip_detail.js',
  'vip_prices.js',
  'vip_cart.js',
  'vip_cart_coupon_lock.js'
];

export function getStorefrontAssets() {
  const assets = {};
  for (const name of STOREFRONT_FILE_NAMES) {
    assets[name] = readFileSync(join(__dirname, name), 'utf-8');
  }
  return assets;
}
