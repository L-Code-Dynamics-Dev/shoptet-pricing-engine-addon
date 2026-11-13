# PRICING_RULES — merchant-configurable prices, tiers and margin
Status: REQUIREMENT. Rule IDs stable for acceptance tracking.
- PRICE-001: Per-shop loyalty tiers configure names, percentages, turnover thresholds, evaluation period and explicit native Shoptet tier-pricelist mapping. No hardcoded ZR4–ZR25 or OKfish threshold defaults.
- PRICE-002: Eligible turnover from merchant-policy paid/completed orders; exclude cancelled, account for refunds/credit notes/corrections and full affected history; verify order pagination and currency. OKfish manual bonus exception is not a Marketplace default.
- PRICE-003: No stacking: choose valid action price vs loyalty price under configured protections. A stale action price >= base is invalid.
- PRICE-004: Discount-cap hierarchy product -> brand -> category -> none/general configured rule; explicit zero cap is valid. If a cap exists, protected merchant action price cannot be raised or overridden by deeper loyalty price (INC-004).
- PRICE-005: Brand sale action and brand discount cap are separate policies. Clearance is an action price, not automatically a cap. Version exceptions and time windows.
- PRICE-006: Product exclusions, no-discount rules and manufacturer/category unknowns fail closed where necessary; show winning rule and reason.
- PRICE-007: Main/base pricelist is read-only for ordinary loyalty writes; explicitly allowlist managed tier pricelists, derive real IDs from authenticated shop configuration (never assume ID 1).
- PRICE-008: All monetary operations exact BigInt/fixed point or verified decimal; no float money calculations. Currency, scale, VAT basis and rounding stage explicit; verify Shoptet compatibility for CZK/EUR and any additional currencies.
- PRICE-009: Final minimum-price/margin guard after all authorized discounts, conversion, VAT and rounding. Selling-price margin m=(price-cost)/price, not markup; normalize tax and currency basis. Missing/invalid costs block reductions when floor required; no zero fallback.
- PRICE-010: Do not automatically increase protected manual action prices; below-margin manual sale => conflict, block additional engine discount, merchant review.
- PRICE-011: FX conversion only with approved, versioned rate snapshot and direction; otherwise separate currency lists, no unsupported cross-currency assumptions.
- PRICE-012: Preview shows before/after by product/variant/tier, winning rule, coverage, blocked reasons and count before any approval.
Acceptance: exact arithmetic boundary tests, action/cap precedence, margin 600/20%=750 net, 600/30%=857.15 net upward rounding, missing VAT/cost, multi-currency and main-list no-write.
Source of behavior to verify: OKfish docs/CORE_LOGIC_AND_VALIDATION.md and current source; marketplace-transfer contract is requirements, not implementation evidence.
