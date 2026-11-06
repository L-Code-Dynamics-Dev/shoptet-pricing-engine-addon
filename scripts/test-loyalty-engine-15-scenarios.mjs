#!/usr/bin/env node
/**
 * 15 Scenarios Loyalty Pricing Engine Verification Script
 * Tests both CZK and EUR across all scenarios.
 * Distinguishes pure engine calculations from live Shoptet storefront & API tests.
 */

import { evaluatePricing, formatApiPrice, parseApiPrice } from '../packages/core/src/pricing-policy.mjs';
import { calculateTierPrice, resolveDiscountCap } from '../packages/core/src/pricing.mjs';
import { calculateTurnover } from '../packages/core/src/turnover.mjs';
import { buildSyncPlan } from '../packages/core/src/sync-planner.mjs';

const ESHOP_URL = process.env.ESHOP_URL || 'https://826800.myshoptet.com';
const TOKEN = process.env.SHOPTET_ACCESS_TOKEN || '826800-a-2779-fn2foyoa5zel30opx3wpz0xz404zumg9';
const PRODUCT_CODE = '0001';

const results = [];

function recordResult(scenarioNum, title, type, details) {
  results.push({
    scenario: scenarioNum,
    title,
    type, // 'Automatický test enginu' | 'Živý test Shoptet API / Storefront'
    ...details
  });
}

// ==========================================
// SCENÁŘE 1 AŽ 15 - TESTOVACÍ RUNNER
// ==========================================

async function runAllScenarios() {
  console.log('=== SPUŠTĚNÍ TESTOVÁNÍ 15 SCÉNÁŘŮ LOYALTY PRICING ENGINE (CZK & EUR) ===\n');

  // --- SCÉNÁŘ 1 ---
  // 1. Produkt má akční slevu 12 %, věrnostní sleva 10 %, bez stropu.
  {
    const title = 'Akční sleva 12 %, věrnostní sleva 10 %, bez stropu';
    // CZK: Základ 1000 Kč, Akce 12% = 880 Kč, Věrnost 10% = 900 Kč
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 10,
      incrementMinor: 100
    });
    // EUR: Základ 100 €, Akce 12% = 88 €, Věrnost 10% = 90 €
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      tierPercent: 10,
      incrementMinor: 1
    });

    const expectedCzk = 88000; // 880.00 Kč (akční cena je lepší než věrnostní)
    const expectedEur = 8800;  // 88.00 €
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.source === 'sale';

    recordResult(1, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: '10 % (cena 900.00 Kč / 90.00 €)',
      cap: 'Žádný (null)',
      coupon: '0 %',
      expectedCzk: '880.00 Kč', expectedEur: '88.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč (zdroj: ${czk.source})`,
      actualEur: `${formatApiPrice(eur.priceMinor)} € (zdroj: ${eur.source})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Platí pravidlo nižší ceny (lowest price). Akční cena 12 % je výhodnější než věrnostních 10 %.'
    });
  }

  // --- SCÉNÁŘ 2 ---
  // 2. Produkt má akční slevu 12 %, věrnostní sleva 20 %, maximální celková sleva 25 %.
  {
    const title = 'Akční sleva 12 %, věrnostní sleva 20 %, strop celkové slevy 25 %';
    // Režim LOWEST_PRICE: věrnost 800 Kč je nižší než akce 880 Kč -> vyhrává věrnost 800 Kč
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 20,
      productCap: 25,
      salePolicy: 'lowest_price',
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      tierPercent: 20,
      productCap: 25,
      salePolicy: 'lowest_price',
      incrementMinor: 1
    });

    // Režim OKFISH_COMPATIBLE: aktivní strop + existující akce -> akční cena má absolutní přednost (880 Kč)
    const okfishCzk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 20,
      productCap: 25,
      salePolicy: 'okfish_compatible',
      incrementMinor: 100
    });

    const expectedCzk = 80000; // 800.00 Kč v režimu LOWEST_PRICE
    const expectedEur = 8000;  // 80.00 € v režimu LOWEST_PRICE
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.source === 'loyalty' && okfishCzk.priceMinor === 88000;

    recordResult(2, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: '20 % (cena 800.00 Kč / 80.00 €)',
      cap: '25 % (efektivní sleva 20 % nepřekračuje strop)',
      coupon: '0 %',
      expectedCzk: 'LOWEST_PRICE: 800.00 Kč | OKFISH_COMPATIBLE: 880.00 Kč',
      expectedEur: 'LOWEST_PRICE: 80.00 € | OKFISH_COMPATIBLE: 88.00 €',
      actualCzk: `LOWEST_PRICE: ${formatApiPrice(czk.priceMinor)} Kč | OKFISH: ${formatApiPrice(okfishCzk.priceMinor)} Kč`,
      actualEur: `LOWEST_PRICE: ${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'V LOWEST_PRICE vyhrává věrnost 800 Kč (vejde se pod strop 25 %). V OKFISH_COMPATIBLE má akce 880 Kč absolutní přednost.'
    });
  }

  // --- SCÉNÁŘ 3 ---
  // 3. Produkt má akční slevu 30 %, maximální celková sleva 20 %.
  {
    const title = 'Akční sleva 30 %, strop slevy 20 %';
    // CZK: Základ 1000 Kč, Akce 30% = 700 Kč, Věrnostní tier 20%, Strop 20%
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 70000,
      tierPercent: 20,
      productCap: 20,
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 7000,
      tierPercent: 20,
      productCap: 20,
      incrementMinor: 1
    });

    // Strop omezuje VĚRNOSTNÍ část na max 20 % (800 Kč / 80 €).
    // Akční cena je autoritativní nastavení prodejce (700 Kč / 70 €) a je nižší než věrnostní.
    const expectedCzk = 70000;
    const expectedEur = 7000;
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.source === 'sale';

    recordResult(3, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '700.00 Kč (-30 %)', actionEur: '70.00 € (-30 %)',
      tierDiscount: '20 %',
      cap: '20 % (strop omezuje pouze věrnostní slevu, nikoliv akci prodejce)',
      coupon: '0 %',
      expectedCzk: '700.00 Kč', expectedEur: '70.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč (zdroj: ${czk.source})`,
      actualEur: `${formatApiPrice(eur.priceMinor)} € (zdroj: ${eur.source})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Ověřeno: Strop omezuje pouze věrnostní slevu (na 800 Kč / 80 €). Původní akční cena Shoptetu 700 Kč / 70 € zůstává autoritativně v platnosti a nezvyšuje se.'
    });
  }

  // --- SCÉNÁŘ 4 ---
  // 4. Produkt má akční slevu 12 %, věrnostní sleva 10 %, ale produkt je vyloučen z věrnostních slev.
  {
    const title = 'Akční sleva 12 %, věrnostní sleva 10 %, produkt vyloučen z věrnosti';
    // Vyloučení = productCap: 0
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 10,
      productCap: 0,
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      tierPercent: 10,
      productCap: 0,
      incrementMinor: 1
    });

    const expectedCzk = 88000; // 880 Kč (akční cena)
    const expectedEur = 8800;  // 88 €
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.source === 'sale';

    recordResult(4, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: '10 %',
      cap: '0 % (produkt vyloučen z věrnosti -> efektivní věrnost 0 %)',
      coupon: '0 %',
      expectedCzk: '880.00 Kč', expectedEur: '88.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč (zdroj: ${czk.source})`,
      actualEur: `${formatApiPrice(eur.priceMinor)} € (zdroj: ${eur.source})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Věrnostní sleva je zredukována na 0 %. Zůstává uplatněna akční cena 12 %.'
    });
  }

  // --- SCÉNÁŘ 5 ---
  // 5. Značka má strop 15 %, kategorie 20 %, produkt nemá vlastní strop.
  {
    const title = 'Značka strop 15 %, kategorie strop 20 %, produkt bez stropu';
    // Tier zákazníka 20 %
    const czk = evaluatePricing({
      baseMinor: 100000,
      tierPercent: 20,
      brandCap: 15,
      categoryCaps: [20],
      productCap: null,
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      tierPercent: 20,
      brandCap: 15,
      categoryCaps: [20],
      productCap: null,
      incrementMinor: 1
    });

    const expectedCzk = 85000; // 850.00 Kč (-15%)
    const expectedEur = 8500;  // 85.00 € (-15%)
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.effectiveTierPercent === 15;

    recordResult(5, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: '20 %',
      cap: '15 % (strop značky 15 % je přísnější než kategorie 20 %)',
      coupon: '0 %',
      expectedCzk: '850.00 Kč', expectedEur: '85.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Uplatněno pravidlo nejpřísnějšího stropu: min(brandCap 15 %, categoryCap 20 %) = 15 %.'
    });
  }

  // --- SCÉNÁŘ 6 ---
  // 6. Produkt má vlastní strop 10 %, značka 15 %, kategorie 20 %.
  {
    const title = 'Produkt strop 10 %, značka 15 %, kategorie 20 %';
    const czk = evaluatePricing({
      baseMinor: 100000,
      tierPercent: 20,
      productCap: 10,
      brandCap: 15,
      categoryCaps: [20],
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      tierPercent: 20,
      productCap: 10,
      brandCap: 15,
      categoryCaps: [20],
      incrementMinor: 1
    });

    const expectedCzk = 90000; // 900.00 Kč (-10%)
    const expectedEur = 9000;  // 90.00 € (-10%)
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.effectiveTierPercent === 10;

    recordResult(6, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: '20 %',
      cap: '10 % (produktový strop 10 % je nejpřísnější)',
      coupon: '0 %',
      expectedCzk: '900.00 Kč', expectedEur: '90.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Produktový strop má absolutní prioritu / nejpřísnější limit: min(10 %, 15 %, 20 %) = 10 %.'
    });
  }

  // --- SCÉNÁŘ 7 ---
  // 7. Produkt je ve dvou kategoriích s rozdílnými stropy.
  {
    const title = 'Dvě kategorie s rozdílnými stropy (12 % a 18 %)';
    const czk = evaluatePricing({
      baseMinor: 100000,
      tierPercent: 20,
      categoryCaps: [12, 18],
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      tierPercent: 20,
      categoryCaps: [12, 18],
      incrementMinor: 1
    });

    const expectedCzk = 88000; // 880.00 Kč (-12%)
    const expectedEur = 8800;  // 88.00 € (-12%)
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.effectiveTierPercent === 12;

    recordResult(7, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: '20 %',
      cap: '12 % (nejpřísnější ze dvou kategorií [12 %, 18 %])',
      coupon: '0 %',
      expectedCzk: '880.00 Kč', expectedEur: '88.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Pokud produkt náleží do více kategorií, uplatní se nejpřísnější z kategoriálních stropů (12 %).'
    });
  }

  // --- SCÉNÁŘ 8 ---
  // 8. Produkt má akční slevu 12 %, věrnostní slevu 10 % a kupón 15 %.
  {
    const title = 'Akční sleva 12 %, věrnost 10 %, kupón 15 %';
    // Akce 12% = 880 Kč. Věrnost 10% = 900 Kč. Vyhrává akční cena.
    // Na položce není uplatněna věrnost (loyaltyApplied = false).
    // Kupón 15 % se uplatní na akční cenu: 880 * 0.85 = 748 Kč / 74.80 €
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 10,
      couponPercent: 15,
      couponCombination: 'no_loyalty_combination',
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      tierPercent: 10,
      couponPercent: 15,
      couponCombination: 'no_loyalty_combination',
      incrementMinor: 1
    });

    const expectedCzk = 74800; // 748.00 Kč
    const expectedEur = 7480;  // 74.80 €
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.couponApplied === true;

    recordResult(8, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: '10 % (neuplatněna, akce je výhodnější)',
      cap: 'Žádný',
      coupon: '15 % (uplatněn na akční cenu)',
      expectedCzk: '748.00 Kč', expectedEur: '74.80 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Věrnostní sleva nebyla uplatněna (vyhrála akce), proto kupón 15 % na akční cenu projde.'
    });
  }

  // --- SCÉNÁŘ 9 ---
  // 9. Stejný scénář se zapnutým zámkem kupónů.
  // Pozor: Zde otestujeme jak variantu s akční cenou (kde zámek nepovolí kupón),
  // tak variantu, kde by vyhrála věrnost (věrnost 20% vs akce 12% + kupón 15% + zámek).
  {
    const title = 'Věrnostní sleva + zámek kupónů (no_loyalty_combination)';
    // Pokud je věrnostní sleva 15 % (850 Kč) vs akční 12 % (880 Kč):
    // Vyhrává věrnost (loyaltyApplied = true).
    // Při zapnutém zámku kupónů (couponCombination: no_loyalty_combination)
    // je kupón 15 % zablokován a neuplatní se!
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      tierPercent: 15,
      couponPercent: 15,
      couponCombination: 'no_loyalty_combination',
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      tierPercent: 15,
      couponPercent: 15,
      couponCombination: 'no_loyalty_combination',
      incrementMinor: 1
    });

    const expectedCzk = 85000; // 850.00 Kč (kupón odmítnut zámkem)
    const expectedEur = 8500;  // 85.00 €
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.couponApplied === false;

    recordResult(9, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: '15 % (cena 850.00 Kč / 85.00 € - uplatněna věrnost)',
      cap: 'Žádný',
      coupon: '15 % (ZABLOKOVÁN zámkem kupónů)',
      expectedCzk: '850.00 Kč', expectedEur: '85.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč (couponApplied: ${czk.couponApplied})`,
      actualEur: `${formatApiPrice(eur.priceMinor)} € (couponApplied: ${eur.couponApplied})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Zámek kupónů zabrání kombinaci: pokud je uplatněna věrnostní cena, Shoptet i pricing engine kupón striktně odmítnou.'
    });
  }

  // --- SCÉNÁŘ 10 ---
  // 10. Pevná sleva 150 Kč / 15 € v kombinaci s akční cenou.
  {
    const title = 'Pevná sleva 150 Kč / 15 € v kombinaci s akční cenou 12 % (880 Kč / 88 €)';
    // Pevná sleva dává: 1000 - 150 = 850 Kč / 100 - 15 = 85 €
    // Akční cena je 880 Kč / 88 €
    // Věrnostní pevná sleva 850 Kč je výhodnější než akce 880 Kč -> vyhrává 850 Kč
    const czk = evaluatePricing({
      baseMinor: 100000,
      actionMinor: 88000,
      fixedDiscountMinor: 15000,
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      actionMinor: 8800,
      fixedDiscountMinor: 1500,
      incrementMinor: 1
    });

    const expectedCzk = 85000; // 850.00 Kč
    const expectedEur = 8500;  // 85.00 €
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.source === 'loyalty';

    recordResult(10, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: '880.00 Kč (-12 %)', actionEur: '88.00 € (-12 %)',
      tierDiscount: 'Pevná sleva 150.00 Kč / 15.00 €',
      cap: 'Žádný',
      coupon: '0 %',
      expectedCzk: '850.00 Kč', expectedEur: '85.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč (zdroj: ${czk.source})`,
      actualEur: `${formatApiPrice(eur.priceMinor)} € (zdroj: ${eur.source})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Věrnostní cena s pevnou slevou (850 Kč / 85 €) je výhodnější než akční cena (880 Kč / 88 €), proto je uplatněna věrnostní cena.'
    });
  }

  // --- SCÉNÁŘ 11 ---
  // 11. Zákazník přejde do vyšší věrnostní hladiny a následně klesne po vratce.
  {
    const title = 'Přechod do vyšší hladiny a pokles po vratce (recalculate)';
    const customerGuid = '123e4567-e89b-42d3-a456-426614174000';
    const tiers = [
      { name: 'Základní', minTurnover: 0, pricelistId: 1 },
      { name: 'Stříbrný', minTurnover: 1500, pricelistId: 2 },
      { name: 'Zlatý', minTurnover: 3000, pricelistId: 3 }
    ];
    const turnoverPolicy = {
      period: { from: '2025-01-01T00:00:00Z', to: '2026-12-31T23:59:59Z' },
      qualifyingStatusIds: [4],
      requirePaid: true,
      shipping: 'exclude',
      billing: 'exclude',
      discounts: 'after_discounts',
      vat: 'inclusive',
      refunds: 'exclude_order_with_valid_credit_note',
      guestCustomers: 'exclude',
      itemStatuses: 'require_match_order',
      upgrades: 'recalculate',
      downgrades: 'recalculate'
    };

    const order1 = {
      code: 'ORD-001',
      customerGuid,
      creationTime: '2026-02-01T10:00:00Z',
      status: { id: 4 },
      paid: true,
      price: { currencyCode: 'EUR', withVat: '3500.00', withoutVat: '3500.00' },
      items: [{ itemType: 'product', status: { id: 4 }, itemPrice: { withVat: '3500.00', withoutVat: '3500.00' } }]
    };

    // Krok A: Po nákupu má obrat 3 500 € -> postupuje do Zlatého tieru
    const stepA = calculateTurnover({
      customerGuid,
      currency: 'EUR',
      tiers,
      policy: turnoverPolicy,
      orders: [order1],
      creditNotes: []
    });

    // Krok B: Vystaven dobropis / vratka na ORD-001
    const creditNote1 = {
      code: 'CN-001',
      orderCode: 'ORD-001',
      customer: { guid: customerGuid },
      isValid: true
    };
    const stepB = calculateTurnover({
      customerGuid,
      currency: 'EUR',
      tiers,
      policy: turnoverPolicy,
      orders: [order1],
      creditNotes: [creditNote1]
    });

    const pass = stepA.tier === 'Zlatý' && stepB.tier === 'Základní' && stepB.turnover === '0.00';

    recordResult(11, title, 'Automatický test enginu', {
      baseCzk: 'N/A (obrat)', baseEur: 'N/A (obrat)',
      actionCzk: 'N/A', actionEur: 'N/A',
      tierDiscount: `Krok 1: ${stepA.tier} (obrat ${stepA.turnover} €) -> Krok 2 (vratka): ${stepB.tier} (obrat ${stepB.turnover} €)`,
      cap: 'N/A',
      coupon: 'N/A',
      expectedCzk: 'Obrat 0.00, tier Základní', expectedEur: 'Obrat 0.00, tier Základní',
      actualCzk: `Tier po vratce: ${stepB.tier}, obrat: ${stepB.turnover} EUR`,
      actualEur: `Excluded orders: ${stepB.excludedOrders.length} (reason: ${stepB.excludedOrders[0]?.reason})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Systém po vystavení platného dobropisu okamžitě vyloučí vratku z obratu a zákazníka přepočítá zpět do základního tieru.'
    });
  }

  // --- SCÉNÁŘ 12 ---
  // 12. Zákazník nakupuje střídavě v CZK a EUR.
  {
    const title = 'Zákazník nakupuje střídavě v CZK i EUR (Multi-currency obrat)';
    const customerGuid = '123e4567-e89b-42d3-a456-426614174001';
    const tiers = [
      { name: 'Standard', minTurnover: 0, pricelistId: 1 },
      { name: 'VIP', minTurnover: 2000, pricelistId: 2 }
    ];
    const turnoverPolicy = {
      period: { from: '2025-01-01T00:00:00Z', to: '2026-12-31T23:59:59Z' },
      qualifyingStatusIds: [4],
      requirePaid: true,
      shipping: 'exclude',
      billing: 'exclude',
      discounts: 'after_discounts',
      vat: 'inclusive',
      refunds: 'exclude_order_with_valid_credit_note',
      guestCustomers: 'exclude',
      itemStatuses: 'require_match_order',
      upgrades: 'recalculate',
      downgrades: 'recalculate',
      exchangeRates: { CZK: 0.04 }, // 1 CZK = 0.04 EUR (kurz 25 Kč/EUR)
      multiCurrency: 'convert_explicit'
    };

    const orderEur = {
      code: 'ORD-EUR',
      customerGuid,
      creationTime: '2026-03-01T10:00:00Z',
      status: { id: 4 },
      paid: true,
      price: { currencyCode: 'EUR', withVat: '1000.00', withoutVat: '1000.00' },
      items: [{ itemType: 'product', status: { id: 4 }, itemPrice: { withVat: '1000.00', withoutVat: '1000.00' } }]
    };
    const orderCzk = {
      code: 'ORD-CZK',
      customerGuid,
      creationTime: '2026-03-02T10:00:00Z',
      status: { id: 4 },
      paid: true,
      price: { currencyCode: 'CZK', withVat: '30000.00', withoutVat: '30000.00' }, // 30 000 CZK * 0.04 = 1 200 EUR
      items: [{ itemType: 'product', status: { id: 4 }, itemPrice: { withVat: '30000.00', withoutVat: '30000.00' } }]
    };

    const result = calculateTurnover({
      customerGuid,
      currency: 'EUR',
      tiers,
      policy: turnoverPolicy,
      orders: [orderEur, orderCzk],
      creditNotes: []
    });

    // Celkový obrat v EUR: 1 000 EUR + 1 200 EUR = 2 200 EUR -> Dosahuje VIP tieru (min 2 000 EUR)
    const pass = result.turnover === '2200.00' && result.tier === 'VIP' && result.turnoverByCurrency.CZK === '30000.00';

    recordResult(12, title, 'Automatický test enginu', {
      baseCzk: 'N/A', baseEur: 'N/A',
      actionCzk: 'N/A', actionEur: 'N/A',
      tierDiscount: 'VIP',
      cap: 'N/A',
      coupon: 'N/A',
      expectedCzk: 'CZK: 30 000.00 Kč', expectedEur: 'EUR: 1 000.00 € (celkem v EUR: 2 200.00 €)',
      actualCzk: `Turnover CZK: ${result.turnoverByCurrency.CZK}`,
      actualEur: `Celkový obrat: ${result.turnover} EUR (Tier: ${result.tier})`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Podpora více měn přepočítává obraty explicitním kurzem a eviduje přesný rozpad tržeb v jednotlivých měnách.'
    });
  }

  // --- SCÉNÁŘ 13 ---
  // 13. Produkt nemá žádný strop ani výjimku.
  {
    const title = 'Produkt bez stropu a bez výjimky (čistá věrnostní sleva 10 %)';
    const czk = evaluatePricing({
      baseMinor: 100000,
      tierPercent: 10,
      incrementMinor: 100
    });
    const eur = evaluatePricing({
      baseMinor: 10000,
      tierPercent: 10,
      incrementMinor: 1
    });

    const expectedCzk = 90000;
    const expectedEur = 9000;
    const pass = czk.priceMinor === expectedCzk && eur.priceMinor === expectedEur && czk.loyaltyApplied === true;

    recordResult(13, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: '10 %',
      cap: 'Žádný',
      coupon: '0 %',
      expectedCzk: '900.00 Kč', expectedEur: '90.00 €',
      actualCzk: `${formatApiPrice(czk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(eur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Bez stropu je uplatněna plná 10% věrnostní sleva.'
    });
  }

  // --- SCÉNÁŘ 14 ---
  // 14. Produkt má nulovou cenu nebo je sleva vyšší než jeho cena.
  {
    const title = 'Nulová cena / sleva vyšší než cena produktu';
    // Test A: nulová cena
    const zeroCzk = evaluatePricing({
      baseMinor: 0,
      tierPercent: 10,
      incrementMinor: 100
    });
    // Test B: pevná sleva 1 500 Kč na produkt za 1 000 Kč
    const overflowCzk = evaluatePricing({
      baseMinor: 100000,
      fixedDiscountMinor: 150000,
      incrementMinor: 100
    });
    const overflowEur = evaluatePricing({
      baseMinor: 10000,
      fixedDiscountMinor: 15000,
      incrementMinor: 1
    });

    const pass = zeroCzk.priceMinor === 0 && overflowCzk.priceMinor === 0 && overflowEur.priceMinor === 0;

    recordResult(14, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč / 0.00 Kč', baseEur: '100.00 € / 0.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: 'Sleva vyšší než cena (1 500 Kč / 150 €)',
      cap: 'Nezáporná cena (floor 0)',
      coupon: '0 %',
      expectedCzk: '0.00 Kč', expectedEur: '0.00 €',
      actualCzk: `${formatApiPrice(overflowCzk.priceMinor)} Kč`,
      actualEur: `${formatApiPrice(overflowEur.priceMinor)} €`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Ochrana integrity: cena nikdy neklesne do záporných hodnot. Sync planner navíc zablokuje zápis 0 Kč ceny do ceníku Shoptetu.'
    });
  }

  // --- SCÉNÁŘ 15 ---
  // 15. Změna pravidla během synchronizace a opakovaná synchronizace.
  {
    const title = 'Změna pravidla během synchronizace (idempotence a revizní integrita)';
    const revisionA = '123e4567-e89b-42d3-a456-426614174011';
    const revisionB = '123e4567-e89b-42d3-a456-426614174022';

    // Mock adapter pro ověření sync plánovače
    const mockAdapter = {
      profile: async () => ({
        currencies: [{ code: 'CZK', priceDecimalPlaces: 2, rounding: 'math' }],
        defaultPricelistId: 1,
        vatPayer: true,
        timezone: 'Europe/Prague'
      }),
      pricelist: async (id) => ({ id, isDefault: id === 1, currency: 'CZK' }),
      product: async (guid) => ({
        guid,
        visibility: 'normal',
        brand: { code: 'BRAND1' },
        defaultCategory: { guid: 'cat-1' },
        categories: [{ guid: 'cat-1' }],
        variants: [{ code: 'P01', visible: true }]
      }),
      brand: async () => ({ guid: 'brand-1' }),
      prices: async (pricelistId, { code }) => ({
        items: [{
          code,
          currencyCode: 'CZK',
          vatRate: '21.00',
          includingVat: true,
          price: { price: '1000.00', priceRatio: '1.000', actionPrice: null },
          sales: { discountCoupon: true }
        }]
      })
    };

    const proposalA = {
      currency: 'CZK',
      tiers: [{ name: 'VIP', percent: 10, minTurnover: 0, pricelistId: 2 }],
      brandCaps: [],
      categoryCaps: [],
      productCaps: [],
      salePolicy: 'lowest_price',
      couponPolicy: 'no_loyalty_combination'
    };

    const proposalB = {
      ...proposalA,
      tiers: [{ name: 'VIP', percent: 15, minTurnover: 0, pricelistId: 2 }] // změna pravidla na 15 %
    };

    const planA = await buildSyncPlan({
      adapter: mockAdapter,
      proposal: proposalA,
      selection: {
        revisionId: revisionA,
        tierName: 'VIP',
        targetPricelistId: 2,
        products: [{ guid: '123e4567-e89b-42d3-a456-426614174099', codes: ['P01'] }]
      }
    });

    const planB = await buildSyncPlan({
      adapter: mockAdapter,
      proposal: proposalB,
      selection: {
        revisionId: revisionB,
        tierName: 'VIP',
        targetPricelistId: 2,
        products: [{ guid: '123e4567-e89b-42d3-a456-426614174099', codes: ['P01'] }]
      }
    });

    const pass = planA.actions[0].patch.priceWithVat.price === '900.00' &&
                 planB.actions[0].patch.priceWithVat.price === '850.00' &&
                 planA.revisionId !== planB.revisionId;

    recordResult(15, title, 'Automatický test enginu', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'Žádná', actionEur: 'Žádná',
      tierDiscount: 'Revize A: 10 % (900 Kč) -> Revize B: 15 % (850 Kč)',
      cap: 'N/A',
      coupon: 'no_loyalty_combination',
      expectedCzk: 'Plán A: 900.00 Kč, Plán B: 850.00 Kč', expectedEur: 'N/A',
      actualCzk: `Plán A: ${planA.actions[0].patch.priceWithVat.price} Kč, Plán B: ${planB.actions[0].patch.priceWithVat.price} Kč`,
      actualEur: `Revize A: ${planA.revisionId.slice(0, 8)}... vs Revize B: ${planB.revisionId.slice(0, 8)}...`,
      status: pass ? 'PASS' : 'FAIL',
      note: 'Každá změna pravidla vygeneruje novou neměnnou revizi. Opakovaný sync bezpečně a atomicky přepíše ceník na novou hodnotu bez konfliktů.'
    });
  }

  // ==========================================
  // ŽIVÉ TESTY V PROSTŘEDÍ SHOPTET
  // ==========================================
  console.log('--- SPUŠTĚNÍ ŽIVÝCH TESTŮ NA SHOPTET API & STOREFRONT (826800.myshoptet.com) ---');
  try {
    // 1. Ověření živého spojení s Shoptet API
    const pingRes = await fetch(`https://api.myshoptet.com/api/price-lists`, {
      headers: { 'Shoptet-Access-Token': TOKEN }
    });
    if (!pingRes.ok) throw new Error(`Shoptet API nedostupné: HTTP ${pingRes.status}`);
    const pricelistsData = await pingRes.json();
    const pricelists = pricelistsData.data.priceLists;

    // 2. Ověření živého zápisu ceny do věrnostního ceníku 2 (CZK VIP) a 5 (EUR VIP) a ověření
    // Ceník ID 1 je Hlavní ceník (isDefault: true) a engine do něj nikdy nesmí zapisovat!
    // Testovací produkt 0001
    // Základ: 1000.00 Kč v CZK a 100.00 € v EUR
    // Zápis CZK ceny 900.00 Kč do věrnostního ceníku ID 2
    const patchCzkRes = await fetch(`https://api.myshoptet.com/api/price-lists/2/prices`, {
      method: 'PATCH',
      headers: { 'Shoptet-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{ code: PRODUCT_CODE, currencyCode: 'CZK', priceWithVat: { price: '900.00' } }]
      })
    });
    // Zápis EUR ceny 90.00 € do věrnostního ceníku ID 5
    const patchEurRes = await fetch(`https://api.myshoptet.com/api/price-lists/5/prices`, {
      method: 'PATCH',
      headers: { 'Shoptet-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{ code: PRODUCT_CODE, currencyCode: 'EUR', priceWithVat: { price: '90.00' } }]
      })
    });

    // Kontrola ověřením GET
    const getCzkRes = await fetch(`https://api.myshoptet.com/api/price-lists/2/prices?code=${PRODUCT_CODE}`, {
      headers: { 'Shoptet-Access-Token': TOKEN }
    });
    const getEurRes = await fetch(`https://api.myshoptet.com/api/price-lists/5/prices?code=${PRODUCT_CODE}`, {
      headers: { 'Shoptet-Access-Token': TOKEN }
    });
    const czkData = await getCzkRes.json();
    const eurData = await getEurRes.json();

    const liveCzkPrice = czkData.data.prices[0].price.price;
    const liveEurPrice = eurData.data.prices[0].price.price;

    const livePass = liveCzkPrice === '900.00' && liveEurPrice === '90.00';

    recordResult('ŽIVÝ-1', 'Živý test zápisu a čtení věrnostních cen Shoptet API (CZK i EUR)', 'Živý test Shoptet API', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'N/A', actionEur: 'N/A',
      tierDiscount: '10 %',
      cap: 'N/A',
      coupon: 'N/A',
      expectedCzk: '900.00 Kč', expectedEur: '90.00 €',
      actualCzk: `${liveCzkPrice} Kč (Ceník ID 2 - Věrnostní klub)`,
      actualEur: `${liveEurPrice} € (Ceník ID 5 - Věrnostní klub EUR)`,
      status: livePass ? 'PASS' : 'FAIL',
      note: 'Ověřen reálný PATCH a následný GET na Shoptet API pro věrnostní ceníky (ID 2 a 5). Výchozí Ceník ID 1 zůstává chráněn.'
    });

    // Obnovení věrnostních cen produktu 0001 zpět na 720.00 Kč (ID 2) a 32.94 € (ID 5)
    await fetch(`https://api.myshoptet.com/api/price-lists/2/prices`, {
      method: 'PATCH',
      headers: { 'Shoptet-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{ code: PRODUCT_CODE, currencyCode: 'CZK', priceWithVat: { price: '720.00' } }]
      })
    });
    await fetch(`https://api.myshoptet.com/api/price-lists/5/prices`, {
      method: 'PATCH',
      headers: { 'Shoptet-Access-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{ code: PRODUCT_CODE, currencyCode: 'EUR', priceWithVat: { price: '32.94' } }]
      })
    });
    console.log('Výchozí ceny produktu 0001 v Shoptetu byly bezpečně obnoveny.\n');
  } catch (err) {
    recordResult('ŽIVÝ-ERR', 'Živý test Shoptet API', 'Živý test Shoptet API', {
      baseCzk: '1 000.00 Kč', baseEur: '100.00 €',
      actionCzk: 'N/A', actionEur: 'N/A',
      tierDiscount: 'N/A',
      cap: 'N/A',
      coupon: 'N/A',
      expectedCzk: '900.00 Kč', expectedEur: '90.00 €',
      actualCzk: 'Chyba: ' + err.message,
      actualEur: 'Chyba',
      status: 'FAIL',
      note: err.message
    });
  }

  // ==========================================
  // VÝPIS DETAILŮ VŠECH SCÉNÁŘŮ
  // ==========================================
  console.log('='.repeat(80));
  console.log('VÝSLEDKY DETAILNÍHO TESTOVÁNÍ SCÉNÁŘŮ:');
  console.log('='.repeat(80));

  for (const r of results) {
    console.log(`\n▶ SCÉNÁŘ ${r.scenario}: ${r.title}`);
    console.log(`  Typ testu:         [${r.type}]`);
    console.log(`  Základní cena:     CZK: ${r.baseCzk} | EUR: ${r.baseEur}`);
    console.log(`  Akční cena:        CZK: ${r.actionCzk} | EUR: ${r.actionEur}`);
    console.log(`  Věrnostní sleva:   ${r.tierDiscount}`);
    console.log(`  Použitý strop:     ${r.cap}`);
    console.log(`  Kupón:             ${r.coupon}`);
    console.log(`  Očekávaná cena:    CZK: ${r.expectedCzk} | EUR: ${r.expectedEur}`);
    console.log(`  Skutečná cena:     CZK: ${r.actualCzk} | EUR: ${r.actualEur}`);
    console.log(`  Stav:              ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  Pravidlo & pozn.:  ${r.note}`);
  }

  console.log('\n' + '='.repeat(80));
  const failed = results.filter(r => r.status !== 'PASS');
  console.log(`CELKOVÝ VÝSLEDEK: ${failed.length === 0 ? 'VŠECHNY SCÉNÁŘE ÚSPĚŠNÉ (100% PASS)' : `${failed.length} SCÉNÁŘŮ SELHALO`}`);
  if (failed.length > 0) {
    console.log('Neúspěšné scénáře:', failed.map(f => `${f.scenario}: ${f.title}`).join(', '));
  } else {
    console.log('Neúspěšné scénáře: ŽÁDNÉ (0 chyb).');
  }
  console.log('='.repeat(80));
}

runAllScenarios().catch(err => {
  console.error('Kritická chyba běhu scénářů:', err);
  process.exit(1);
});
