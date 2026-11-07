# COUPON_RULES — independent coupon policy and reconciliation
Status: REQUIREMENT.
- COUPON-001: Two explicit modes: percent-ceiling and fixed-amount. Never silently convert one to the other.
- COUPON-002: Merchant-configured tier locks, product/brand disables and guest behavior; OKfish ZR20/ZR25 locks are historical examples, not defaults.
- COUPON-003: Coupon decision and price engine must use the same cap priority (product -> brand -> category, or explicitly merchant-approved alternate mode), no contradictory discount ceilings.
- COUPON-004: Respect existing sale/clearance/brand action, no-discount and product caps. Fixed-value coupon must not bypass minimum margin, floor or approved maximum discount.
- COUPON-005: Distinguish coupon disabled from enabled with zero remaining headroom; applyDiscountCoupon=false differs from true with minPriceRatio=1.
- COUPON-006: minPriceRatio applies to the stored price of that tier pricelist, not automatically to base. Preserve missing vs null vs explicit ratio. Validate platform-compatible rounding (OKfish observed 3 decimal HALF_UP; verify Marketplace).
- COUPON-007: Coupon maintenance never rewrites merchant main-list product caps (INC-003).
- COUPON-008: Independently reconcile actual discountCoupon and minPriceRatio per item/tier; count MATCH/DRIFT/MISSING/SKIPPED/UNKNOWN with full coverage self-check. Zero drift with incomplete data is not success.
- COUPON-009: Do not claim checkout-level coupon floor enforcement unless verified against actual Shoptet behavior; unsupported paths must be blocked or explicitly documented.
Acceptance: fixed/percent fixtures, guest, locked tiers, sale/cap/floor precedence, null semantics, no main-list writes, incomplete coverage, real checkout compatibility gate.
