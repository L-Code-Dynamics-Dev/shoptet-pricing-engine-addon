/**
 * L-Code B2C cart savings. Never infer a baseline from the customer's tier percentage.
 * References are either native cart markup, a verified same-variant product page, or an
 * explicitly provisioned reference-price snapshot. No changes to checkout prices.
 */
(() => {
  'use strict';
  if (window.__shoptetPricingCartLoaded) return;
  window.__shoptetPricingCartLoaded = true;

  const rowsSelector = "tr[data-micro='cartItem'], .cart-table tbody tr, .cart-table tr.cart-item";
  const skuSelector = "[data-micro='sku'], [itemprop='sku'], [data-testid='productCardSku'], .p-code";
  const originalSelector = '.price-standard, .price-additional, .cart-item-original-price, s';
  const pageCache = new Map();
  let generation = 0;
  let lastSignature = '';

  function lang() {
    const value = (window.shoptet?.config?.language || document.documentElement.lang || 'cs').toLowerCase();
    return value.startsWith('sk') ? 'sk' : value.startsWith('en') ? 'en' : 'cs';
  }
  const labels = {
    cs: 'Úspora oproti původní ceně:',
    sk: 'Úspora oproti pôvodnej cene:',
    en: 'Savings compared with original price:'
  };

  // Monetary arithmetic uses safe integer minor units. The locale parser is deliberately
  // strict: ambiguous or unsupported price formats result in no badge.
  function minor(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/[\u00a0\u202f\s]/g, '');
    const match = cleaned.match(/\d[\d.,]*/);
    if (!match) return null;
    let number = match[0].replace(/[.,]$/, '');
    const comma = number.lastIndexOf(',');
    const dot = number.lastIndexOf('.');
    const last = Math.max(comma, dot);
    let decimals = '';
    if (last !== -1) {
      const tail = number.slice(last + 1);
      const prefix = number.slice(0, last);
      if (/^\d{1,2}$/.test(tail)) {
        decimals = tail;
        number = prefix;
      } else if (/^\d{3}$/.test(tail)) {
        number = prefix + tail;
      } else {
        return null;
      }
    }
    if (!/^\d[\d.,]*$/.test(number)) return null;
    const units = number.replace(/[.,]/g, '');
    if (!/^\d+$/.test(units)) return null;
    const cents = BigInt(units) * 100n + BigInt((decimals + '00').slice(0, 2));
    return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? cents : null;
  }

  function formatted(cents) {
    const value = Number(cents) / 100; // Presentation only; never used in arithmetic.
    if (typeof window.shoptet?.helpers?.formatPrice === 'function') {
      try { return window.shoptet.helpers.formatPrice(value); } catch {}
    }
    const currency = window.shoptet?.currency || {};
    const symbol = currency.symbol || 'Kč';
    const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, currency.thousandSeparator || ' ');
    const decimal = (cents % 100n).toString().padStart(2, '0');
    const text = whole + (currency.decimalSeparator || ',') + decimal;
    return currency.symbolPosition === 'left' ? symbol + ' ' + text : text + ' ' + symbol;
  }

  function rowSku(row) {
    const element = row.querySelector(skuSelector);
    return (row.dataset.productCode || element?.getAttribute('content') || element?.textContent || '').trim();
  }

  function quantity(row) {
    const input = row.querySelector("input[name='amount'], input[name^='amount'], [data-testid='cartItemQuantity']");
    const count = Number(input?.value ?? '1');
    return Number.isSafeInteger(count) && count > 0 && count <= 100000 ? BigInt(count) : null;
  }

  function currentTotal(row) {
    const cell = row.querySelector('td.p-total, [data-testid="cartItemTotal"]');
    if (!cell) return null;
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.vip-cart-percent, .vip-discount-badge').forEach(e => e.remove());
    return minor(clone.textContent);
  }

  function nativeOriginal(row) {
    const el = row.querySelector(originalSelector);
    return el ? minor(el.textContent) : null;
  }

  function tierPresent() {
    return !!(window.shoptetPricingEngine?.customerTier || window.shoptet?.customer?.priceListId);
  }

  function productLink(row) {
    const a = row.querySelector('a.p-name, a[href][data-testid="cartItemName"], .p-name a, a.p-main-image');
    if (!a) return null;
    try {
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) return null;
      url.hash = '';
      return url.href;
    } catch { return null; }
  }

  async function pageOriginal(url, sku) {
    const key = url + '|' + sku;
    if (!pageCache.has(key)) {
      pageCache.set(key, (async () => {
        try {
          const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' });
          if (!response.ok || new URL(response.url).origin !== location.origin) return null;
          if (!(response.headers.get('content-type') || '').includes('text/html')) return null;
          const html = await response.text();
          if (html.length > 1000000) return null;
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const skuElements = [...doc.querySelectorAll(skuSelector)];
          // A product page may list several variants while showing the first one's price.
          // Only use the price if every visible SKU reference is the cart variant.
          const codes = new Set(skuElements.map(el => (el.getAttribute('content') || el.textContent || '').trim()).filter(Boolean));
          if (codes.size !== 1 || !codes.has(sku)) return null;
          const original = doc.querySelector(originalSelector);
          return original ? minor(original.textContent) : null;
        } catch { return null; }
      })());
    }
    return pageCache.get(key);
  }

  async function originalUnit(row, sku) {
    const native = nativeOriginal(row);
    if (native !== null) return native;
    if (!sku || !tierPresent()) return null;
    // Optional merchant-provisioned reference data. Never trust a percentage/cookie.
    const snapshot = window.shoptetPricingEngine?.cartReferencePrices?.[sku];
    if (snapshot && snapshot.verified === true && snapshot.vipEligible === true &&
        typeof snapshot.standardPrice === 'string' &&
        (!snapshot.currency || snapshot.currency === window.shoptet?.currency?.code)) {
      const parsed = minor(snapshot.standardPrice);
      if (parsed !== null) return parsed;
    }
    const url = productLink(row);
    return url ? pageOriginal(url, sku) : null;
  }

  function badge(cell, percent) {
    let element = cell.querySelector(':scope > .vip-cart-percent');
    if (percent === null) {
      element?.remove();
      return;
    }
    if (!element) {
      element = document.createElement('span');
      element.className = 'vip-cart-percent';
      element.style.cssText = 'color:#198754;font-weight:700;margin-left:8px;font-size:.9em;white-space:nowrap';
      cell.appendChild(element);
    }
    const value = '-' + percent + '%';
    if (element.textContent !== value) element.textContent = value;
  }

  function banner(total) {
    document.querySelectorAll('.vip-cart-total-savings').forEach(e => e.remove());
    if (total <= 0n) return;
    const anchor = document.querySelector("[data-testid='recapFullPrice']")?.closest('tr, div, .cart-total') ||
      document.querySelector('.cart-total, .recap-price, .cart-table');
    if (!anchor?.parentElement) return;
    const box = document.createElement(anchor.tagName === 'TR' ? 'tr' : 'div');
    box.className = 'vip-cart-total-savings';
    const content = document.createElement(anchor.tagName === 'TR' ? 'td' : 'div');
    if (box.tagName === 'TR') content.colSpan = 10;
    content.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:6px;padding:10px 14px;margin:12px 0;font-weight:600';
    content.textContent = labels[lang()] + ' ' + formatted(total);
    box.appendChild(content);
    anchor.parentElement.insertBefore(box, anchor);
  }

  async function render() {
    const run = ++generation;
    const rows = [...document.querySelectorAll(rowsSelector)].filter(row => row.querySelector('td.p-total, [data-testid="cartItemTotal"]'));
    if (!rows.length) { banner(0n); return; }
    const results = await Promise.all(rows.slice(0, 100).map(async row => {
      const qty = quantity(row);
      const total = currentTotal(row);
      if (qty === null || total === null) return { row, saved: 0n, percent: null };
      const orig = await originalUnit(row, rowSku(row));
      if (orig === null || orig <= 0n) return { row, saved: 0n, percent: null };
      const standardTotal = orig * qty;
      if (standardTotal <= total) return { row, saved: 0n, percent: null };
      const saved = standardTotal - total;
      const pct = (saved * 100n + standardTotal / 2n) / standardTotal;
      return { row, saved, percent: Number(pct) };
    }));
    if (run !== generation) return;
    const applied = new Set(results.map(x => x.row));
    let sum = 0n;
    for (const result of results) {
      const cell = result.row.querySelector('td.p-total, [data-testid="cartItemTotal"]');
      if (!cell) continue;
      badge(cell, result.percent && result.percent > 0 ? result.percent : null);
      sum += result.saved;
    }
    for (const row of rows) {
      if (!applied.has(row)) badge(row.querySelector('td.p-total, [data-testid="cartItemTotal"]'), null);
    }
    banner(sum);
  }

  function signature() {
    return [...document.querySelectorAll(rowsSelector)].map(row => [
      rowSku(row), quantity(row)?.toString() ?? '',
      currentTotal(row)?.toString() ?? '',
      nativeOriginal(row)?.toString() ?? '',
      productLink(row) ?? ''
    ].join('|')).join(';');
  }

  function init() {
    let timer;
    const schedule = (force = false) => {
      const next = signature();
      if (!force && next === lastSignature) return;
      lastSignature = next;
      clearTimeout(timer);
      timer = setTimeout(() => { void render(); }, 120);
    };
    schedule(true);
    const target = document.querySelector('.cart-table, .cart-content, #content') || document.body;
    new MutationObserver(() => schedule()).observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['value'] });
    window.addEventListener('vipReady', () => schedule(true));
    document.addEventListener('shoptet.cart-updated', () => schedule(true));
    document.addEventListener('change', () => schedule(), true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
