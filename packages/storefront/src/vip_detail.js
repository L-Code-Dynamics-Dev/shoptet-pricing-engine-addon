/**
 * Shoptet Pricing Engine — Product Detail Module
 * Universal loyalty discount badge & standard price decorator for product detail pages.
 * Compatible with all Shoptet themes (Classic, Step, Disco, Waltz, Tango, Samba, Techno).
 */
(() => {
  'use strict';

  if (window.__shoptetPricingDetailLoaded) return;
  window.__shoptetPricingDetailLoaded = true;

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

  function getApiUrl() {
    if (window.shoptetPricingEngine?.apiUrl) return window.shoptetPricingEngine.apiUrl;
    const script = document.querySelector('script[data-pricing-api]');
    if (script?.dataset?.pricingApi) return script.dataset.pricingApi;
    return 'https://lcode-shoptet-pricing-dev.hlancaric.workers.dev';
  }

  function getShopId() {
    if (window.shoptetPricingEngine?.shopId) return String(window.shoptetPricingEngine.shopId);
    if (window.shoptet?.projectId) return String(window.shoptet.projectId);
    if (window.shoptet?.config?.projectId) return String(window.shoptet.config.projectId);
    const meta = document.querySelector('meta[name="project-id"], meta[name="shoptet-project-id"]');
    if (meta?.content) return meta.content.trim();
    return null;
  }

  function getSku() {
    const el = document.querySelector("[itemprop='sku'], .p-code span, span[data-micro='sku'], [data-micro='sku']");
    return el?.getAttribute('content') || el?.textContent?.trim() || null;
  }

  function getCustomerTier() {
    if (window.shoptetPricingEngine?.customerTier) return String(window.shoptetPricingEngine.customerTier);
    const email = (window.shoptet?.customer?.email || '').trim().toLowerCase();
    if (email && window.vipDiscounts?.[email]) {
      const d = window.vipDiscounts[email];
      return typeof d === 'number' ? `ZR${d}` : String(d);
    }
    if (window.shoptet?.customer?.priceListId) {
      return `PL${window.shoptet.customer.priceListId}`;
    }
    return null;
  }

  async function fetchProductDiscount(code, tier) {
    try {
      const shopId = getShopId();
      const shopParam = shopId ? `?shopId=${encodeURIComponent(shopId)}` : '';
      const url = `${getApiUrl()}/v1/product-discount/${encodeURIComponent(code)}/${encodeURIComponent(tier)}${shopParam}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async function renderDetail() {
    const wrapper = document.querySelector('.p-final-price-wrapper, .price-final-holder, [data-testid="detailPrice"]');
    if (!wrapper) return;

    // Check if Shoptet native save/standard price already rendered and visible
    const nativeStandardEl = wrapper.querySelector('.price-standard, .price-save, .price-additional');
    const finalPriceEl = wrapper.querySelector('.price-final, [data-testid="priceFinal"], strong') || wrapper;
    const finalPrice = parsePrice(finalPriceEl?.textContent);

    let standardPrice = nativeStandardEl ? parsePrice(nativeStandardEl.textContent) : null;

    if (!standardPrice || isNaN(standardPrice)) {
      const tier = getCustomerTier();
      const code = getSku();
      if (tier && code) {
        const data = await fetchProductDiscount(code, tier);
        if (data && typeof data.standardPrice === 'number') {
          standardPrice = data.standardPrice;
        }
      }
    }

    if (standardPrice && finalPrice && standardPrice > finalPrice) {
      const discountPct = Math.round((1 - finalPrice / standardPrice) * 100);
      if (discountPct > 0) {
        let box = wrapper.querySelector('.vip-detail-price-box');
        if (!box) {
          box = document.createElement('div');
          box.className = 'vip-detail-price-box';
          box.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap;';
          wrapper.prepend(box);
        }

        box.innerHTML = `
          <span style="font-size:0.95em;color:#6c757d;text-decoration:line-through;">${formatPrice(standardPrice)}</span>
          <span style="display:inline-block;padding:2px 8px;background:#e8f5e9;color:#198754;border:1px solid rgba(25,135,84,0.25);font-size:0.85em;font-weight:700;border-radius:4px;">${t('save')} ${discountPct}%</span>
        `;
      }
    }
  }

  function init() {
    renderDetail();
    let timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(renderDetail, 150);
    });
    const target = document.querySelector('.p-final-price-wrapper, .product-detail, #content') || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('vipReady', renderDetail);
  document.addEventListener('shoptet.product-changed', () => setTimeout(renderDetail, 150));
})();
