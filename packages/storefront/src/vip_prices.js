/**
 * Shoptet Pricing Engine — Variant Prices Module
 * Synchronizes variant table rows and price lists across product variations.
 * Compatible with all Shoptet themes (Classic, Step, Disco, Waltz, Tango, Samba, Techno).
 */
(() => {
  'use strict';

  if (window.__shoptetPricingPricesLoaded) return;
  window.__shoptetPricingPricesLoaded = true;

  function getLang() {
    const l = (window.shoptet?.config?.language || document.documentElement.lang || 'cs').toLowerCase();
    if (l.startsWith('sk')) return 'sk';
    if (l.startsWith('en')) return 'en';
    return 'cs';
  }

  const I18N = {
    cs: { save: 'Ušetříte' },
    sk: { save: 'Ušetríte' },
    en: { save: 'Save' }
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

  function getVariantCode(row) {
    const sku = row.querySelector("[data-micro='sku'], [itemprop='sku'], [data-testid='variantSku']");
    if (sku) return sku.getAttribute('content') || sku.textContent?.trim();
    return row.querySelector('.variant-name-wrapper, .variant-name')?.textContent?.match(/\|\s*([^\s|]+)/)?.[1] || null;
  }

  function updateVariantBadges() {
    const rows = document.querySelectorAll('.variant-table .table-row, .variant-list tr, [data-testid="variantRow"]');
    for (const row of rows) {
      const priceEl = row.querySelector('.variant-price-wrap .price-final, .price-final, [data-testid="variantPrice"]');
      const standardEl = row.querySelector('.standard-price-wrap .price-standard, .price-standard');

      const finalPrice = priceEl ? parsePrice(priceEl.textContent) : null;
      const standardPrice = standardEl ? parsePrice(standardEl.textContent) : null;

      let badge = row.querySelector('.vip-variant-discount');
      let original = row.querySelector('.vip-variant-original');

      if (standardPrice && finalPrice && standardPrice > finalPrice) {
        const percent = Math.round((1 - finalPrice / standardPrice) * 100);
        if (percent > 0) {
          if (!standardEl || standardEl.getClientRects().length === 0) {
            if (!original) {
              original = document.createElement('s');
              original.className = 'vip-variant-original';
              original.style.cssText = 'display:block;color:#6c757d;font-size:12px;line-height:1.4;text-decoration:line-through;';
              priceEl.before(original);
            }
            const label = formatPrice(standardPrice);
            if (original.textContent !== label) original.textContent = label;
          } else if (original) {
            original.remove();
          }

          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'vip-variant-discount';
            badge.style.cssText = 'display:inline-block;margin-top:2px;padding:1px 6px;background:#e8f5e9;color:#198754;border:1px solid rgba(25,135,84,0.25);font-size:11px;font-weight:700;line-height:1.4;border-radius:4px;white-space:nowrap;';
            priceEl.parentElement.appendChild(badge);
          }
          const label = `${t('save')} ${percent}%`;
          if (badge.textContent !== label) badge.textContent = label;
          continue;
        }
      }

      // If no discount, clean up
      if (badge) badge.remove();
      if (original) original.remove();
    }
  }

  function init() {
    updateVariantBadges();
    let timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(updateVariantBadges, 150);
    });
    const target = document.querySelector('.variant-table, .variant-list, .p-detail-inner') || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('vipReady', updateVariantBadges);
  document.addEventListener('shoptet.product-changed', () => setTimeout(updateVariantBadges, 150));
})();
