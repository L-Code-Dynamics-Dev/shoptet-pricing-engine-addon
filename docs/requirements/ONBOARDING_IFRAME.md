# ONBOARDING_IFRAME — complete merchant-language journey
Status: REQUIREMENT; not a claim that routes/screens are implemented.
- IFRAME-001: Marketplace installation, OAuth/verified shop identity, permissions and embedded iframe session; explain blocked/expired permissions.
- IFRAME-002: Welcome wizard with persistent per-shop drafts, back/forward/reload continuity, clear step completion and actionable errors; no automatic live prices.
- IFRAME-003: Discover actual catalog/variants/brands/categories, currency, VAT, customer/order completeness, native pricelists and mappings. Never fabricate counts or success.
- IFRAME-004: Wizard configures tiers/turnover periods, customer grouping, discount caps/exclusions, actions/clearance, coupon modes and locks, minimum margin/floor, rounding and sync options.
- IFRAME-005: Full read-only preview with examples and total coverage; explain skipped/blocked items; require explicit approval of versioned snapshot; reject stale approvals.
- IFRAME-006: Initial bounded execution displays real progress, failures, pause/retry where supported, readback and truthful final status.
- IFRAME-007: Daily dashboard: last VERIFIED sync, changed/skipped/blocked counts, active policy version, price/coupon discrepancies, audit history, settings and support.
- IFRAME-008: Settings edits create new draft -> preview -> approval, never silently rewrite active prices. Include suspension and uninstall consequences.
- IFRAME-009: All copy natural Czech for e-shop owner: 'Věrnostní slevy', 'Základní ceník', 'Maximální sleva', 'Náhled změn', 'Spustit přepočet', 'Co se změní'. Never expose tenant/reconcile/lease/minPriceRatio in merchant copy.
- IFRAME-010: Every visible button and statistic must have real authenticated backend contract; no dead controls, invented endpoints or placeholder success. Responsive, accessible iframe, loading/empty/error/permission states, no secrets in browser.
- IFRAME-011: Customer storefront shows truthful tier price, badge, catalog/detail/cart and coupon restriction; only where platform checkout actually enforces it.
- IFRAME-012: Optional merchant AI assistance follows same preview/approval permissions; no developer/source access.
Acceptance: first-install-to-daily-management end-to-end tests, route-to-real-endpoint matrix, draft persistence, authorization failures, reload, stale approval, no live writes without explicit authorization.
