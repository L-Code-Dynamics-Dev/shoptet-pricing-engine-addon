/**
 * Shoptet Pricing Engine — Catalog Module
 * Universal loyalty discount badge & standard price decorator for catalog cards.
 * Compatible with all Shoptet themes (Classic, Step, Disco, Waltz, Tango, Samba, Techno).
 */
(() => {
  'use strict';

  if (window.__shoptetPricingCatalogLoaded) return;
  window.__shoptetPricingCatalogLoaded = true;

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

  const standardPriceCache = new Map();

  async function fetchProductDiscount(code, tier) {
    const key = `${code}:${tier}`;
    if (standardPriceCache.has(key)) return standardPriceCache.get(key);
    try {
      const shopId = getShopId();
      const shopParam = shopId ? `?shopId=${encodeURIComponent(shopId)}` : '';
      const url = `${getApiUrl()}/v1/product-discount/${encodeURIComponent(code)}/${encodeURIComponent(tier)}${shopParam}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      standardPriceCache.set(key, data);
      return data;
    } catch {
      return null;
    }
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

  async function renderCard(card) {
    if (card.dataset.vipCatalogDone) return;

    // Detect product code / SKU across Shoptet card variations
    const skuEl = card.querySelector("[data-micro='sku'], [itemprop='sku'], [data-testid='productCardSku'], .p-code");
    const code = skuEl?.getAttribute('content') || skuEl?.textContent?.trim();

    // Detect price elements
    const priceEl = card.querySelector(".price.price-final[data-testid='productCardPrice'], .price-final, [data-testid='productCardPrice'], .p-bottom .price");
    if (!priceEl) return;

    // If Shoptet already rendered native standard price / save badge, don't duplicate
    const nativeStandard = card.querySelector('.price-standard, .price-save, .price-additional');
    if (nativeStandard && nativeStandard.textContent.trim()) {
      card.dataset.vipCatalogDone = '1';
      return;
    }

    const tier = getCustomerTier();
    let standardPrice = null;
    let finalPrice = parsePrice(priceEl.textContent);

    if (tier && code) {
      const data = await fetchProductDiscount(code, tier);
      if (data && typeof data.standardPrice === 'number' && typeof data.price === 'number') {
        standardPrice = data.standardPrice;
        finalPrice = data.price;
      }
    }

    if (standardPrice && finalPrice && standardPrice > finalPrice) {
      const discountPct = Math.round((1 - finalPrice / standardPrice) * 100);
      if (discountPct > 0) {
        card.dataset.vipCatalogDone = '1';

        // Strikethrough standard price
        let origBox = card.querySelector('.vip-catalog-original');
        if (!origBox) {
          origBox = document.createElement('div');
          origBox.className = 'vip-catalog-original';
          origBox.style.cssText = 'font-size:0.85em;color:#6c757d;text-decoration:line-through;margin-top:2px;';
          priceEl.insertAdjacentElement('afterend', origBox);
        }
        origBox.textContent = formatPrice(standardPrice);

        // Savings badge
        let badge = card.querySelector('.vip-catalog-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'vip-catalog-badge';
          badge.style.cssText = 'display:inline-block;background:#e8f5e9;color:#198754;border:1px solid rgba(25,135,84,0.25);padding:1px 6px;border-radius:4px;font-weight:700;font-size:0.8em;margin-left:6px;vertical-align:middle;';
          priceEl.appendChild(badge);
        }
        badge.textContent = `-${discountPct}%`;
      }
    }
  }

  function renderCatalog() {
    const cards = document.querySelectorAll('.product, .p, [data-micro="product"], .product-item');
    for (const card of cards) {
      renderCard(card);
    }
  }

  function init() {
    renderCatalog();
    let timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(renderCatalog, 150);
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('vipReady', renderCatalog);
  document.addEventListener('shoptet.products-list-updated', () => setTimeout(renderCatalog, 150));
})();
