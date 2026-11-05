# Merchant MCP implementation audit — 2026-11-05

## Evidence and branch state

Default branch `master`, clean initial HEAD `e0c9b08`; one worktree and no initial unrelated changes.
Open PR #1 (`feat/complete-admin-tabs-20261105`, HEAD `3f2f82d`) is a draft UI-only extension.
It saves UI proposals, explicitly does not implement catalog lookup, execution or MCP authentication.
This branch is based on master and does not silently merge or replace PR #1.

## Actual implementation map

| Component | Initial finding | This branch | Remaining release gate |
| --- | --- | --- | --- |
| MCP | Handwritten 2025-03-26 JSON-RPC; query bearer tokens; unsafe direct writes | Official SDK 1.32.2 Web Standard Streamable HTTP, stateless request-local server, strict Zod inputs, scoped tools/resources/prompts; header auth only | OAuth AS/PKCE, grant rotation, client permissions, connection/session audit, rate limiting |
| Tenant identity | Hashed MCP credentials joined to active installations | Retained, identity never comes from tool arguments | Real D1 isolation and expiry/revocation integration coverage |
| Shoptet reads | Direct fetch, unsafe error propagation, missing bounded retry | Fixed-origin read adapter, timeout, redirect rejection, bounded jitter retries, page-local search, minimized results | Verify partner-approved grants and real sandbox response contracts; complete detail/customer/order adapters |
| Admin | Preview backdoor default; example merchant brands/tiers; write-scoped tokens | Removed default preview credential and seeded brands/tiers; read-only seven-day tokens, scoped revoke endpoint; AI asistent label | All eleven requested sections, compact real-brand dropdown, trusted confirmation UX, connection test/history |
| Installation | Shop-specific default, plaintext permanent/cached OAuth tokens | Removed shop default; numeric myshoptet origin allowlist, redirect rejection, timeout, redacted exchange errors | Verified partner token endpoint/callback contract and trusted shop identity, replay/state controls, encrypted OAuth vault and recovery migration; custom-domain support must be verified |
| Pricing | Simplified subset, first matching cap | Minimum applicable cap enforced; golden regression | Full currency/VAT/rounding/coupon/margin/turnover parity, verified independent oracle before writes |
| Synchronization | Minimal job table, unfenced asset lease | MCP live writes disabled | Immutable plans, approvals, fencing, queue/checkpoint worker, verification, compensation/cancel/retry |
| SFTP/assets | Tenant encrypted vault, pinned host keys, release snapshots and rollback primitives | No new live execution path | Fence-aware transport and executor, staging E2E, release approval and operational recovery |
| Public lifecycle | Arbitrary shopId inspection/uninstall/API-test endpoints | Denied before DB access | Authenticated verified lifecycle events and tenant-data deletion policy |

## Official documentation inspected

- [Shoptet API and OAuth](https://api.docs.shoptet.com/shoptet-api/openapi)
- [Shoptet Marketplace access](https://developers.shoptet.com/api/documentation/basic-information-about-api/)
- [Brands](https://api.docs.shoptet.com/shoptet-api/openapi/brands): GUID is the stable preferred identifier; deprecated text index names must not stand in for verified GUIDs.
- [Price lists](https://api.docs.shoptet.com/shoptet-api/openapi/price-lists): native reads/create/update/delete exist; API documentation is not evidence of this application's granted permissions.
- [Price-list prices](https://api.docs.shoptet.com/shoptet-api/openapi/price-list-prices/getpricelistprices)
- [Categories](https://api.docs.shoptet.com/shoptet-api/openapi/categories)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Marketplace-approved application scope configuration is **not present in the repository** and cannot be inferred from the public endpoint catalog. Do not claim verified write access. The existing API pricing PATCH payload has not been independently validated and is not enabled. Native coupon checkout precedence, storefront behavior and customer assignments are not verified. Public documentation confirms the existence of APIs, not parity or permission for this addon.

## Exposed MCP surface

Tools: `shop_get_status`, `shop_get_capabilities`, `shop_get_profile`, `shop_get_configuration`,
`brands_list`, `brands_search`, `products_list`, `products_search`, `categories_list`,
`categories_search`, `pricelists_list`.

Resources: `lcode://shop/profile`, `lcode://shop/capabilities`,
`lcode://pricing/configuration`, `lcode://setup/guide`.

Prompts: `loyalty_setup_wizard`, `setup_loyalty_program`, `configure_brand_limits`,
`configure_coupon_policy`, `audit_pricing_configuration`, `explain_customer_price`,
`diagnose_sync_failure`, `review_pending_changes`.

`shop:read` permits shop metadata, capabilities and setup prompts;
`catalog:read` permits catalog reads; `pricing:read` permits configuration reads.
Every surface is registered only for the credential's scopes. Calls use its authenticated shop ID.
Search is explicitly page-local: callers must paginate; empty matches are not evidence of absence.
No configuration proposal, approval, execution, customer recalculation or sync tools are advertised.

## Validation and deployment

Run `npm ci && npm run check` (CI Node 22; local Node 24.14.0).
`npm audit --omit=dev --audit-level=high` reports zero vulnerabilities.
New tests cover SDK initialization, tools/resources/prompts, strict cross-tenant input rejection,
credential rejection, Origin/query rejection, public lifecycle guards, upstream pagination,
rate limits, invalid schema, network failures, OAuth SSRF rejection and minimum-cap precedence.
Existing fixtures are test-only; there are no live merchant reads/writes in automated tests.

This is an **incomplete foundation**, not the complete merchant onboarding product.
No live deployment, remote migration, merchant configuration modification or price write was performed.
No new schema is needed for these read-only changes. Existing migrations remain unchanged.

Bindings: `DB`; existing installation and tenant tables, migrations 0001–0009.
Secrets used by existing paths: `ADMIN_SESSION_SECRET`, `SHOPTET_CLIENT_ID`,
`SHOPTET_CLIENT_SECRET`; optional explicit `ADMIN_PREVIEW_KEY` is development-only.
SFTP vault additionally uses `VAULT_MASTER_KEY` in its existing format; it does not encrypt OAuth tokens.
Keep `SYNC_MODE=off`. Never consider these environment variables evidence that the integration is release-ready.

Before release, finish all remaining implementation gates above and phases 2–5 of the master task,
obtain verified partner application configuration, run isolated Shoptet staging integration tests,
and approve the exact release. Existing plaintext OAuth records require a separately reviewed,
tested encryption migration and recovery plan. Do not migrate production on this branch.
