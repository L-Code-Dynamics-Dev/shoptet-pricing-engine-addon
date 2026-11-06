/**
 * Shoptet Pricing Engine — Cart Savings Module
 * Universal row discount badges and total savings banner for the shopping cart.
 * Compatible with all Shoptet themes (Classic, Step, Disco, Waltz, Tango, Samba, Techno).
 */
(() => {
  'use strict';

  if (window.__shoptetPricingCartLoaded) return;
  window.__shoptetPricingCartLoaded = true;

  function getLang() {
    const l = (window.shoptet?.config?.language || document.documentElement.lang || 'cs').toLowerCase();
    if (l.startsWith('sk')) return 'sk';
    if (l.startsWith('en')) return 'en';
    return 'cs';
  }

  const I18N = {
    cs: {
      totalSave: 'Celkem ušetříte díky věrnostnímu programu:'
    },
    sk: {
      totalSave: 'Celkovo ušetríte vďaka vernostnému programu:'
    },
    en: {
      totalSave: 'Total savings with loyalty program:'
    }
  };

  function t(k) {
    const l = getLang();
    return I18N[l]?.[k] || I18N.cs[k] || '';
  }

  function formatPrice(amount) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
    if (typeof window.shoptet?.helpers?.formatPrice === 'function') {
      try {
        return window.shoptet.helpers.formatPrice(amount);
      } catch {}
    }
    const curr = window.shoptet?.currency || {};
    const symbol = curr.symbol || 'Kč';
    const decimals = typeof curr.decimalPlaces === 'number' ? curr.decimalPlaces : 2;
    const decSep = curr.decimalSeparator || ',';
    const thouSep = curr.thousandSeparator || ' ';

    const parts = amount.toFixed(decimals).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thouSep);
    const formatted = parts.join(decSep);

    return curr.symbolPosition === 'left' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;
  }

  function parsePrice(text) {
    if (!text || typeof text !== 'string') return NaN;
    const clean = text.replace(/[\s\u00A0]/g, '');
    const m = clean.match(/(\d+(?:[.,]\d+)*)/);
    if (!m) return NaN;
    let numStr = m[1];
    if (numStr.includes(',') && numStr.includes('.')) {
      if (numStr.lastIndexOf(',') > numStr.lastIndexOf('.')) {
        numStr = numStr.replace(/\./g, '').replace(',', '.');
      } else {
        numStr = numStr.replace(/,/g, '');
      }
    } else if (numStr.includes(',')) {
      numStr = numStr.replace(',', '.');
    }
    const val = parseFloat(numStr);
    return Number.isFinite(val) ? val : NaN;
  }

  function parsePriceExcludingBadge(cell) {
    if (!cell) return NaN;
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.vip-cart-percent, .vip-discount-badge').forEach(el => el.remove());
    return parsePrice(clone.textContent);
  }

  function getRowQuantity(row) {
    const input = row.querySelector("input[name='amount'], [data-testid='cartItemQuantity']");
    const n = input ? parseInt(input.value, 10) : 1;
    return isNaN(n) || n <= 0 ? 1 : n;
  }

  function setBadge(totalCell, pct) {
    let badge = totalCell.querySelector(':scope > .vip-cart-percent');
    if (pct === null || pct <= 0) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'vip-cart-percent';
      badge.style.cssText = 'color:#198754;font-weight:700;margin-left:8px;font-size:0.9em;white-space:nowrap;';
      totalCell.appendChild(badge);
    }
    const pctText = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1).replace('.', ',');
    badge.textContent = `-${pctText}%`;
  }

  function renderTotalSavings(totalSaved) {
    document.querySelectorAll('.vip-cart-total-savings').forEach(el => el.remove());
    if (totalSaved <= 0) return;

    const anchor = document.querySelector("[data-testid='recapFullPrice']")?.closest('tr, div, .cart-total')
      || document.querySelector('.cart-total')
      || document.querySelector('.recap-price')
      || document.querySelector('.cart-table')?.parentElement;

    if (!anchor) return;

    const box = document.createElement('div');
    box.className = 'vip-cart-total-savings';
    box.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:6px;padding:10px 14px;margin:12px 0;font-size:0.95em;font-weight:600;display:flex;align-items:center;gap:8px;';
    box.innerHTML = `
      <span style="font-size:1.1em;line-height:1;">✓</span>
      <span>${t('totalSave')} <strong>${formatPrice(totalSaved)}</strong></span>
    `;

    if (anchor.tagName === 'TR') {
      const tr = document.createElement('tr');
      tr.className = 'vip-cart-total-savings';
      const td = document.createElement('td');
      td.colSpan = 10;
      td.style.padding = '4px 0';
      td.appendChild(box);
      tr.appendChild(td);
      anchor.parentElement.insertBefore(tr, anchor);
    } else {
      anchor.parentElement.insertBefore(box, anchor);
    }
  }

  function renderCart() {
    const rows = document.querySelectorAll("tr[data-micro='cartItem'], .cart-table tbody tr, .cart-table tr.cart-item");
    if (!rows.length) return;

    let totalSaved = 0;

    for (const row of rows) {
      const totalCell = row.querySelector('td.p-total, [data-testid="cartItemTotal"]');
      const unitCell = row.querySelector('td.p-price, [data-testid="cartItemPrice"]');
      if (!totalCell) continue;

      const currentTotal = parsePriceExcludingBadge(totalCell);
      const qty = getRowQuantity(row);

      // Check if standard price or original price exists in row
      const origPriceEl = row.querySelector('.price-standard, .price-additional, s, .cart-item-original-price');
      let standardUnit = origPriceEl ? parsePrice(origPriceEl.textContent) : null;

      if (standardUnit && currentTotal && Number.isFinite(standardUnit)) {
        const standardTotal = standardUnit * qty;
        if (standardTotal > currentTotal) {
          const savedOnRow = standardTotal - currentTotal;
          const pct = Math.round((savedOnRow / standardTotal) * 100);
          setBadge(totalCell, pct);
          totalSaved += savedOnRow;
          continue;
        }
      }

      // If Shoptet already provided discount on row via native discount attribute
      const nativeDiscountEl = row.querySelector('[data-testid="cartItemDiscount"]');
      if (nativeDiscountEl) {
        const discountText = nativeDiscountEl.textContent;
        const discountPctMatch = discountText.match(/(\d+)%/);
        if (discountPctMatch) {
          const pct = parseInt(discountPctMatch[1], 10);
          if (pct > 0) {
            setBadge(totalCell, pct);
            const origTotal = currentTotal / (1 - pct / 100);
            totalSaved += (origTotal - currentTotal);
          }
        }
      }
    }

    renderTotalSavings(totalSaved);
  }

  function init() {
    renderCart();
    let timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(renderCart, 150);
    });
    const target = document.querySelector('.cart-table, .cart-content, #content') || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('vipReady', renderCart);
  document.addEventListener('shoptet.cart-updated', () => setTimeout(renderCart, 150));
})();
