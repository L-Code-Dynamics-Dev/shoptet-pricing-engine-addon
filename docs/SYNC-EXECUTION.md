# Native price plan and execution pipeline

## Implemented behavior

`sync_preview` reads a tenant-owned configuration revision and actual Shoptet
profile, price lists, product details (including all categories), brand GUIDs and
variant price rows. It calculates an explicit bounded selection; it never claims
that a selection of products represents the entire catalog.

`sync_plan` requires an already saved immutable configuration revision. It stores
an immutable JSON snapshot and SHA-256, exact configuration version, before/after
values, source prices, product/category/brand identities, coupon changes and
15-minute expiry. Its approval is distinct from approval to save configuration.
The existing authenticated addon administration shows the full plan for explicit
confirmation. The model cannot approve it. Every approval is tenant-bound,
version-bound, hash-bound, expires and is consumed once.

`sync_execute` creates a durable job using the existing `sync_jobs` table and a
per-plan/mode idempotency key. Dry-run checks input snapshots only. Native mode
requires `sync:execute`, `pricing:execute`, trusted admin approval, an activated
release and verified approved Shoptet endpoint access. Responses distinguish
calculation/checking, saved configuration, verified native writes, partial changes
and storefront behavior. No storefront or customer-assignment success is claimed.

Other tools: `sync_get_progress`, `sync_get_status`, `sync_get_history`,
`sync_cancel`, `sync_retry_failed`, `sync_verify`. The progress is durable and
polled independently of the initiating HTTP request. Failed native executions do
not automatically retry writes. Eligible dry-run errors may be retried before
plan expiry. Cancellation stops before the next item; it does not undo completed
changes. A new compensation plan requires a new preview and approval.

## Exact supported price subset

- Money uses integral API hundredths and BigInt rational calculations. No binary
  floating-point arithmetic is used after validating percentages.
- Tier, product/variant, every matching category and verified brand cap use the
  strictest restriction. Zero caps exclude loyalty discounts. Multiple categories
  are loaded using Shoptet `include=allCategories`.
- Current sale prices win if lower. Dates use the actual shop timezone. Source
  net prices and price ratios are explicitly normalized before pricing.
- The plan targets a non-default price list and never performs currency conversion.
  Source/target row currencies and VAT rates must match the configured currency.
- Patches use `priceWithVat.price` and optionally `sales.discountCoupon`; they do
  not overwrite VAT/currency metadata. Native non-VAT-payer behavior is respected
  by omitting forbidden VAT fields.
- Coupon policy disables native discount coupons on target rows where loyalty
  really lowers the price. Existing restrictions are otherwise preserved; coupon
  restrictions on customer assignments or the entire checkout are not inferred.
- Currency rounding modes are explicit. Unsupported precision above the API's
  documented two decimals is rejected. Zero-price writes are rejected because
  the native zero-price feature is not verified. Target price ratios and active
  target promotions require a separately designed plan and are rejected here.
- Minimum-price evaluation is tested in the pure evaluator; reliable purchase-cost
  discovery and configurable native margin protection are not yet integrated.

## Native API contract

Authoritative documentation was retrieved on 2026-11-06, including its downloadable
OpenAPI schema. The current endpoint is
`PATCH /api/price-lists/{id}/prices` with `{data: [patch, ...]}`.
HTTP 200 can contain per-row errors. The adapter reports partial failures, never
blindly retries a mutation and always requires read-back. Network timeouts and
invalid/5xx responses are uncertain, even if a first read appears to match.

Read endpoints include `/api/price-lists/{id}/prices`, `/api/products/{guid}`,
`/api/brands/{code}`, `/api/categories/{categoryGuid}`, `/api/price-lists/{id}`,
`/api/system/endpoints?status=approved` and `/api/eshop`. The brand detail is the
object directly in `data`, not `data.brand`. The shop's VAT/rounding/default-list
settings come from the documented nested settings/currencies fields. Contact and
bank data are stripped. References are real shop identifiers.

References: [price writes](https://api.docs.shoptet.com/shoptet-api/openapi/price-list-prices/updatepricelistprices),
[price reads](https://api.docs.shoptet.com/shoptet-api/openapi/price-list-prices/getpricelistprices),
[downloadable OpenAPI](https://api.docs.shoptet.com/_bundle/Shoptet%20API/openapi.json?download).

## Concurrency and recovery

A dedicated `ShopSyncCoordinator` Durable Object is addressed per tenant. It
persists its owner and bounded job queue in SQLite. Alarms process one item at a
time and persist a recovery wakeup before network I/O. No lease timeout permits
another shop job to overwrite a still-running plan.

D1's per-shop monotonic epoch fences all progress/checkpoint commits. A stale
reader cannot mark an item for writing after a newer worker claims the epoch.
The write adapter checks the exact immutable action, cancellation, installation,
configuration version, expiry, permissions and current fence immediately before
issuing a native patch. A persisted `writing` marker survives a crash.

Shoptet does not expose a fencing-token parameter in this API. Therefore an
interrupted/uncertain external write **quarantines the shop**: no conflicting plan
can acquire it and no automatic retry clears the marker. A stopped old request
might still reach Shoptet; the implementation does not pretend that a D1 epoch
can cancel that request. Operator reconciliation is required; an automatic
unlock/reconciliation UI is intentionally not provided. Existing Shoptet/manual
writers are not fenced by this addon; native activation requires operational
coordination and independent release review. Read-back protects against observed
mismatches but cannot guarantee exclusion of another external writer.

Read failures use bounded retry checkpoints and backoff. Uncertain native writes
remain recorded for attention rather than being reported as success. Known
rejections and mismatched verification fail the job. Progress reports possible
partial changes and quarantine explicitly. Verified completed actions are not
written again by repeated alarms or idempotent execute calls.

## Configuration and release gates

`wrangler.jsonc` binds `SYNC_COORDINATOR` to the separate development Worker in
`ops/sync.wrangler.jsonc`. The coordinator exposes no public HTTP application.
Both configurations keep `SYNC_MODE=off`. No resources were provisioned or deployed.

Apply migration 0013 only in separately approved isolated D1 staging, after the
preceding migrations. Deploy/test the coordinator and its binding there. Both
Workers require the vault keyring `SHOPTET_TOKEN_KEYS`; never pass keys via tools.

Native activation additionally requires `SYNC_MODE=live`,
`PRICING_PARITY_APPROVAL=native-price-policy-v1` **after independent release/parity
review**, and `SHOPTET_PRICE_WRITE_ENDPOINT` set to the exact native approved
endpoint identifier verified for the partner application. That identifier is not
guessed from a description; runtime checks `/api/system/endpoints` under the
shop's own OAuth token. A deployment variable is an operator release gate, not
proof that review happened. These gates are not configured by this branch.

Local Node/SQLite integration tests cover plan immutability, tenant isolation,
approval, execution through a contract-based mock, repeated execution, read-back,
configuration/source changes, cancellation, stale workers and crash quarantine.
Both API/coordinator bundles pass Wrangler dry-run. Cloudflare alarm/RPC behavior,
D1 runtime compatibility, real Shoptet pricing parity and actual storefront behavior
still require staging verification. Packaging alone does not prove these things.

## Admin catalog selection

The existing brand-limit form now loads actual authenticated-shop brands in a
searchable five-row scrollable picker, supports explicit pagination, prevents
duplicates and preserves GUIDs. Search is honestly page-local. Existing textual or
missing references are shown as unavailable and must be resolved or removed;
they are never silently replaced by invented brands. Save revalidates every GUID
against the shop. The displayed MCP endpoint is `/mcp`, not removed legacy SSE.
