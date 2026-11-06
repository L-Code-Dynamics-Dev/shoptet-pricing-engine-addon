# OKfish -> L-Code Marketplace B2C: transfer contract

Source repository: `L-Code-Dynamics-Dev/okfish-pricing-engine`, pinned revision `e3776ef1aaf7059fc4bba1556d1eadd2948eff0a` (2026-11-06). Source records: `INCIDENTS.md`, `docs/CORE_LOGIC_AND_VALIDATION.md`, `docs/PROGRESS_LOG.md`; actual code is authoritative for implemented behavior. **This document transfers requirements and evidence; it does not assert implementation in Marketplace.**

## Separation and ownership

- Reuse pricing policies, reconciliation methodology and incident regression tests; do not copy OKfish client-specific customer data, token, SFTP credentials, hardcoded price-list IDs, thresholds, product exceptions or brand promotions into a multi-tenant default.
- Keep pure pricing engine independent from Shoptet adapter. Authenticated shop config defines currencies, tiers, turnover policy, mapped native price lists, cap policies, brand actions, product exceptions, coupon mode and feature flags. Immutable policy version and shop ID must accompany each calculation and queued write.
- Base/main price list is authoritative for product pricing input and must not be overwritten by loyalty-price recalculation. Existing merchant action prices are protected. Any brand-sale write to base price list requires an explicit separately approved capability and ownership contract, not a generic loyalty sync.
- Enumerate managed tier price lists explicitly; never iterate every shop price list with an unchecked `as CustomerTier` cast. Unmanaged lists are immutable to this engine.

## Price rules (implemented in OKfish)

1. Tier discounts in `src/config/policies/policy-v1.json`: ZR4=4%, ZR6=6%, ZR8=8%, ZR10=10%, ZR12=12%, ZR14=14%, ZR16=16%, ZR18=18%, ZR20=20%, ZR25=25%. There are TEN ZR tiers plus one base list, not eleven ZR tiers.
2. `HighestDiscountPolicy`: choose lower of valid sale price and loyalty price; no stacking of sale and loyalty discounts.
3. `DiscountLimitPolicy`: precedence product cap -> brand cap -> category cap -> no cap. If an active cap and a valid action price coexist, the action price is authoritative and must not be raised by cap or replaced by a deeper loyalty price. If no action price, clamp discount against the cap.
4. A stale action price >= base is not a valid action price. Product-level zero-discount rule prevents loyalty discount, subject to explicitly defined merchant sale-price handling.
5. Brand-wide sale discount and brand discount cap are **different** policies. In the OKfish policy JSON MIVARDI has both; don't conflate them. Product/brand exceptions and clearance windows are shop-owned and versioned.
6. Clearance is an action price, **not** automatically a product discount cap: source `cloudflare-worker/src/engine/config.ts` records the 2026-09-24 correction. Compare sale vs loyalty normally unless a separate explicit cap applies. Do not carry forward older incident commentary describing clearance as a cap without noting the superseding rule.
7. Use exact Decimal or fixed-point for every money operation; source `pricing-bridge.ts` currently synthesizes brand action price with `Number`/`Math.round`, so this is a **migration gap**, not a pattern to copy. Explicit rounding, currency and tax basis are required.
8. Customer tier threshold values in the old SKILL.md conflict with current `cloudflare-worker/src/shoptet-api/customer-adapter.ts` (100/300/500/700/1000/2000/5000/7000/10000). Do not transplant either threshold set as a Marketplace default; require merchant-approved per-shop mapping and verify the production source before changing OKfish.
9. Customer turnover: count paid or completed orders, plus the OKfish-specific manual `Navýšenie bodov` exception; exclude cancelled orders. That manual exception is **OKfish-only**, never universal. Recompute affected customer's full eligible order history on incremental change, including corrections/refunds as defined by shop policy.

## Coupons: independent business and reconciliation domain

- `src/coupon/CouponPolicy.ts` is independent of the pricing pipeline. Coupon configuration comes from `src/config/policies/coupon-policy.json`, not hardcoded global defaults.
- There are two modes: `percent-ceiling` (historical standard cap, default 20%) and `fixed-amount` (OKfish policy switched on 2026-09-24 to ambassador fixed-value coupons). Never silently convert fixed-value coupon rules into percentage rules.
- ZR20/ZR25 are historically locked from coupons; for Marketplace locked tiers are configurable. Guest is separate and not subject to ZR20/ZR25 tier lock.
- For `fixed-amount`: lock => coupon OFF; product/brand manual disable => OFF; explicit zero cap => coupon ON with zero remaining room; sale/clearance/brand action => ON with zero remaining room; capped product => remaining cap after tier discount; unrestricted => no additional ratio floor. This distinction is essential: `applyDiscountCoupon=true` with `minPriceRatio=1` is NOT equivalent to `false`.
- For `percent-ceiling`: enforce tier lock, no-discount, product cap, existing sale, and remaining headroom against the standard ceiling in policy priority order.
- Shoptet `sales.minPriceRatio` for tier price list applies to **that tier's own stored price**, not directly to base price. `compute-coupon-writes.ts` rounds to 3 decimal places, ROUND_HALF_UP, based on observed Shoptet behavior; verify compatibility before porting.
- Coupon reconciling reads actual `discountCoupon` and `minPriceRatio`, computes expected values independently, counts coverage and distinguishes mismatch, missing, skipped and unknown. Never infer coupon correctness from price reconciliation.
- Coupon maintenance must never rewrite merchant-owned main-list product caps (INC-003).

## Sync/write contracts and incident gates

- Validate policy inputs and cross-file conflicts before any writes; explicit source precedence, no silent overwrites. Incomplete product feed / missing base price / unknown VAT / unknown manufacturer when cap matters => block affected writes, never replace with zero or silently bypass cap.
- Shoptet price-list PATCH must carry `price`, `includingVat`, and verified `vatRate` explicitly for new entries (INC-014). Do not reuse OKfish's hardcoded fallback VAT 23.00 for other shops.
- Parse per-item errors even when batch HTTP status is 200 (INC-016). Unknown write outcome after timeout => reconcile before retry. Do not advance lastSync or poison cache for unverified writes.
- Read back first-time price-list entries; handle silent Shoptet no-op (INC-010). Record successfulDiffs only for individually verified or contractually confirmed writes; maintain retryable states.
- Use durable per-shop job ownership/lease and per-item idempotency, not non-atomic KV get-then-put locks. Use bounded concurrency and documented Shoptet rate limits; never assume old constants apply universally.
- Fingerprint policy changes and invalidate/recalculate affected products. Reconcile independently of webhook delivery, with full-coverage self-check and a declared minimum expected cardinality.
- Price reconciliation and coupon reconciliation are separate read-only jobs. Remediation is a third, explicitly authorized action, never an accidental side effect of reading.
- Use full dry-run -> merchant approval -> bounded execution for initial Marketplace activation. No production write, migration or deployment without explicit target and approval.

## Validation stages and self-healing

Five-stage control: (1) policy/config/input validation, (2) pre-write calculation and safety fuse, (3) regression and negative tests, (4) fail-closed sync result/commit state, (5) independent price and coupon reconciliation, each with coverage self-check. Consult original `docs/CORE_LOGIC_AND_VALIDATION.md` for exact historical labels; this is an operational transfer mapping, not a verbatim reproduction.

Sixth proposed layer: self-healing consumes *confirmed* drift only. It classifies as AUTO / REVIEW / BLOCK, re-fetches authoritative data and current policy, checks shop ownership and write permissions, computes a minimal diff, applies a bounded idempotent write, independently reads back, and logs immutable evidence. Unknown input, manual sale conflicts, VAT ambiguity, stale policy, repeated failed repair, uninstall and missing coverage => BLOCK. AUTO mode must be feature-flagged and approved per shop; not currently proven implemented.

## Known migration gaps requiring code work

- `customer-adapter.ts` contains fixed OKfish turnover thresholds and converts Decimal spend to Number.
- `pricing-bridge.ts` uses Number and Math.round for synthetic brand sales and passes every pricelist name as `CustomerTier` without an explicit allowlist.
- `sync-orchestrator.ts` permits a missing/partial manufacturer feed to disable brand caps, and chooses a fallback base pricelist if `Maloobchodný` is absent.
- `pricelist-writer.ts` has fallback VAT 23.00 and a corrective first-time PATCH missing VAT fields. Verify per-item errors at the API client boundary.
- `engine/config.ts` and `coupon-config.ts` evaluate time-window configuration once at module import, which can go stale in long-lived Worker isolates.
- Distinguish documented historic fixes from present code and run tests before any claim of parity.

## Incident-driven acceptance matrix

| Incident | Required regression |
|---|---|
| INC-001 | Correct Shoptet price object parsing in incremental change; malformed response fails closed |
| INC-002 | Full sync preserves/rebuilds cache entries for unchanged customers |
| INC-003 | Coupon cron never overwrites main-list merchant/product discount cap |
| INC-004 | Manual action price never increased by cap or replaced by loyalty when cap applies |
| INC-005–009 | Network failures, truthful sync status, bounded cache writes, dry-run no-write safety |
| INC-010 | New products, missing prices, variants, silent no-op PATCH, no false SUCCESS |
| INC-011 | Coupon lock and value reconciliation, complete self-check, no false zero-drift |
| INC-012 | Reconciliation pagination and stable coverage; distinguish disproven hypotheses from root cause |
| INC-013 | Monitoring accurately reports phase and statistics |
| INC-014 | VAT metadata explicitly written and read-back verified |
| INC-015 | No synthetic zero base prices from incomplete API data; safe backfill |
| INC-016 | HTTP 200 with per-item errors is a failed partial batch, not success |

## Definition of done

1. Marketplace repo/revision identified, clean isolated worktree, AGENTS read.
2. Policy and tenant config schemas implemented, explicit mapping and compatibility tests.
3. Pure price and coupon parity fixtures run with exact money; both historical coupon modes.
4. Independent price and coupon reconciliation, self-check and drift classification tested.
5. Safe repair state machine implemented and proven with fault injection; AUTO off by default.
6. Durable webhooks, shop isolation, API failure handling and rollback tests executed.
7. No writes to OKfish or live Marketplace shops without named approval. Capture command/test output and limitations.
