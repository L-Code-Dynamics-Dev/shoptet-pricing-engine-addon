/**
 * Shoptet Pricing Engine — Cart Coupon Lock Module
 * Enforces loyalty coupon lock according to merchant rules.
 * Disables coupon combination when loyalty discount or locked tiers apply.
 * Compatible with all Shoptet themes (Classic, Step, Disco, Waltz, Tango, Samba, Techno).
 */
(() => {
  'use strict';

  if (window.__shoptetPricingCouponLockLoaded) return;
  window.__shoptetPricingCouponLockLoaded = true;

  function getLang() {
    const l = (window.shoptet?.config?.language || document.documentElement.lang || 'cs').toLowerCase();
    if (l.startsWith('sk')) return 'sk';
    if (l.startsWith('en')) return 'en';
    return 'cs';
  }

  const I18N = {
    cs: {
      title: 'Věrnostní sleva',
      message: 'Váš nákup již obsahuje věrnostní slevu. Kombinace se slevovým kupónem není povolena.'
    },
    sk: {
      title: 'Vernostná zľava',
      message: 'Váš nákup už obsahuje vernostnú zľavu. Kombinácia so zľavovým kupónom nie je povolená.'
    },
    en: {
      title: 'Loyalty discount',
      message: 'Your order already includes a loyalty discount. Discount coupon cannot be applied.'
    }
  };

  function t(k) {
    const l = getLang();
    return I18N[l]?.[k] || I18N.cs[k] || '';
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

  function getCustomerDiscountPercent() {
    if (typeof window.shoptetPricingEngine?.customerDiscount === 'number') {
      return window.shoptetPricingEngine.customerDiscount;
    }
    const email = (window.shoptet?.customer?.email || '').trim().toLowerCase();
    if (email && typeof window.vipDiscounts?.[email] === 'number') {
      return window.vipDiscounts[email];
    }
    return null;
  }

  const CONFIG_CACHE_KEY = 'shoptetPricingCouponConfig';
  const CONFIG_TTL_MS = 5 * 60 * 1000;
  let cachedConfig = null;

  async function loadConfig() {
    if (window.shoptetPricingEngine?.couponConfig) {
      return window.shoptetPricingEngine.couponConfig;
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(CONFIG_CACHE_KEY) || 'null');
      if (stored && Date.now() - stored.at < CONFIG_TTL_MS && stored.config) {
        cachedConfig = stored.config;
        return cachedConfig;
      }
    } catch {}

    try {
      const shopId = getShopId();
      const shopParam = shopId ? `?shopId=${encodeURIComponent(shopId)}` : '';
      const res = await fetch(`${getApiUrl()}/v1/coupon-config${shopParam}`, { cache: 'no-store' });
      if (res.ok) {
        const d = await res.json();
        cachedConfig = d;
        try {
          sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ config: d, at: Date.now() }));
        } catch {}
        return cachedConfig;
      }
    } catch {}

    return null;
  }

  function isLockActive(config) {
    if (!config) return false;
    const tier = getCustomerTier();
    const discountPct = getCustomerDiscountPercent();

    // 1. Explicitly locked tiers list
    if (Array.isArray(config.lockedTiers) && tier && config.lockedTiers.includes(tier)) {
      return true;
    }

    // 2. Minimum discount threshold
    if (typeof config.minPercent === 'number' && config.minPercent > 0) {
      if (typeof discountPct === 'number' && discountPct >= config.minPercent) {
        return true;
      }
    }

    // 3. Top tiers enabled
    if (config.topTiers && tier && Array.isArray(config.allTiers) && config.allTiers.length > 0) {
      const topTiers = config.allTiers
        .slice()
        .sort((a, b) => (b.percent || 0) - (a.percent || 0))
        .slice(0, Math.max(1, Math.ceil(config.allTiers.length * 0.25)))
        .map(t => t.name);
      if (topTiers.includes(tier)) {
        return true;
      }
    }

    return false;
  }

  function findCouponForm() {
    return document.querySelector("[data-testid='formDiscountCoupon'], .discount-coupon, form.discount-coupon");
  }

  function findCouponInput(form) {
    return form?.querySelector("#discountCouponCode, [data-testid='inputDiscountCoupon'], input[name='discountCouponCode']") || null;
  }

  function findCouponSubmit(form) {
    return form?.querySelector("[data-testid='buttonSubmitDiscountCoupon'], button[type='submit'], input[type='submit']") || null;
  }

  function findCouponToggle() {
    return document.querySelector("[data-testid='buttonShowCouponInput'], .toggle-discount-coupon");
  }

  function findLockTarget() {
    const form = findCouponForm();
    const badge = document.querySelector('.discount-coupon-badge, .discount-coupon');
    if (!form) return badge?.closest('div') || null;
    if (!badge) return form;

    let el = form;
    while (el && !el.contains(badge) && el !== document.body) {
      el = el.parentElement;
    }
    return el || form;
  }

  function lockCoupon() {
    const form = findCouponForm();
    const input = findCouponInput(form);
    const submit = findCouponSubmit(form);
    const toggle = findCouponToggle();
    const target = findLockTarget();

    if (input) input.disabled = true;
    if (submit) submit.disabled = true;
    if (toggle) toggle.disabled = true;

    if (target && !target.querySelector(':scope > .vip-coupon-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'vip-coupon-overlay';
      overlay.style.cssText = 'position:relative;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px;margin:8px 0;color:#475569;font-size:13px;line-height:1.4;display:flex;align-items:flex-start;gap:10px;';
      overlay.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px;">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <div>
          <div style="font-weight:600;color:#1e293b;margin-bottom:2px;">${t('title')}</div>
          <div>${t('message')}</div>
        </div>
      `;
      target.prepend(overlay);
    }
  }

  async function checkAndApply() {
    const config = await loadConfig();
    if (!config) return;
    if (isLockActive(config)) {
      lockCoupon();
    }
  }

  function init() {
    checkAndApply();
    let timeout;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(checkAndApply, 150);
    });
    const target = document.querySelector('.cart-content, .cart-table, #content') || document.body;
    if (target) {
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.addEventListener('vipReady', checkAndApply);
  document.addEventListener('shoptet.cart-updated', () => setTimeout(checkAndApply, 150));
})();
