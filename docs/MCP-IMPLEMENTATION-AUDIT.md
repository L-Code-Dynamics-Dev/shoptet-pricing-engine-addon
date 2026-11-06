# Update: bounded customer turnover preview

[CUSTOMER-TURNOVER.md](CUSTOMER-TURNOVER.md) documents actual customer/group/order/credit-note reads, a separate opt-in `customers:read` scope, immutable turnover-policy proposals and exact turnover/tier previews. Unlinked refunds, mixed item statuses, missing references and incomplete pagination fail closed. Native assignments and event automation remain unimplemented and are explicitly reported as blocked by the missing executor. The local suite passes 183 tests; no remote writes occurred.

# Update: signed lifecycle and installation-generation boundaries

[SIGNED-LIFECYCLE.md](SIGNED-LIFECYCLE.md) documents tenant-encrypted signing keys, explicit trusted-admin setup, bounded raw-body HMAC verification, ordered idempotent receipts, suspend/uninstall revocation, independently verified resumption, reinstall fencing and vault-rotation preservation. Migration 0015 and local security tests are implemented. The complete local suite passes 173 tests at this checkpoint. Partner callback settings, actual delivery and Cloudflare runtime verification remain release gates; no deployment occurred. Earlier missing-lifecycle findings below are superseded only for this implementation.

# Update: durable installation verification

[INSTALLATION-ONBOARDING.md](INSTALLATION-ONBOARDING.md) documents callback capture within Shoptet's short timeout, operator-configured partner OAuth origin, encrypted pending tenants, asynchronous identity/permission verification, bounded scheduled recovery and reinstall-generation fencing. Migration 0014 was added and tested locally. Real partner settings, callback latency and sandbox installation remain unverified; unsigned uninstall is still denied pending the signed lifecycle integration.

# Update: typed domain operations and diagnostics

[DOMAIN-TOOLS.md](DOMAIN-TOOLS.md) documents the added tier/cap/policy/mapping tools, three additional scoped resources, real permission discovery and tenant diagnostics. These are proposal operations, not implicit native activation or customer assignment. The admin tier renderer no longer interpolates saved names into HTML.

# Update: native sync plans, fenced jobs and catalog selection

[SYNC-EXECUTION.md](SYNC-EXECUTION.md) describes nine sync tools, immutable native-price plans, separate admin approval, durable checkpoints, tenant fencing, uncertain-write quarantine and a SQLite Durable Object coordinator. Product/variant/category caps and the real-brand picker are implemented. Native activation remains off and staging/parity/capability evidence remains required. Previous missing-executor/brand-picker findings below are superseded for this bounded subset, not for customer automation or full checkout behavior.

# Update: MCP OAuth/PKCE

[MCP-OAUTH.md](MCP-OAUTH.md) describes the implemented pre-registered public-client authorization flow, signed-admin pairing/consent, PKCE, metadata, resource binding, access/refresh lifecycle, replay-family revocation and client disconnect. Migration 0012 and HTTP/SQLite integration/security tests were added. The original missing-OAuth findings below are superseded for this supported subset. Real-client compatibility, Cloudflare D1/browser staging, dynamic client registration and operational audit/retention remain unverified or unimplemented; no deployment occurred.

# Update: encrypted Shoptet credentials

[TOKEN-VAULT.md](TOKEN-VAULT.md) documents the implemented per-shop AES-GCM vault, key rotation, transactional installation writes and encrypted API-token cache. Migration 0011 and explicit server-only legacy conversion are provided and tested locally; no remote migration or secret provisioning occurred. The previous plaintext-storage finding below is superseded for the new runtime. Trusted installation callback verification, MCP OAuth/PKCE and production staging verification remain outstanding.

# Update: configuration approval foundation

The revision workflow described in [CONFIGURATION-APPROVALS.md](CONFIGURATION-APPROVALS.md) now supersedes the read-only configuration limitations in the original audit below. Nine additional tools implement draft creation/replacement, validation, preview, trusted approval request, approved proposal saving, verification, history and rollback proposal creation. These store proposals only; live Shoptet execution remains disabled. The admin can explicitly grant proposal permissions or revoke credentials. Migration 0010 and real SQLite integration tests were added; no remote migration was run.

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
