import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = typeof import.meta.url === 'string' && import.meta.url ? fileURLToPath(import.meta.url) : '';
const __dirname = __filename ? dirname(__filename) : '';

export const STOREFRONT_FILE_NAMES = [
  'vip_catalog.js',
  'vip_detail.js',
  'vip_prices.js',
  'vip_cart.js',
  'vip_cart_coupon_lock.js'
];

export function getStorefrontAssets() {
  const assets = {};
  if (!__dirname) return assets;
  for (const name of STOREFRONT_FILE_NAMES) {
    try {
      assets[name] = readFileSync(join(__dirname, name), 'utf-8');
    } catch {
      assets[name] = '';
    }
  }
  return assets;
}
