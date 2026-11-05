# Current implementation status

See [the 2026-11-05 implementation audit](docs/MCP-IMPLEMENTATION-AUDIT.md) for the authoritative implemented surface and release blockers. Historical notes below describe earlier states and are not release evidence. The complete onboarding task is not yet implemented.

# L-Code Loyalty Pricing Engine — Shoptet Marketplace

**Status: secure foundation / NOT MARKETPLACE READY.** Private repository candidate.

This package is a safe, non-deployed starter for a separate multi-tenant Shoptet add-on. It intentionally does **not** copy OKfish customer records, proprietary pricing policies or credentials. No live API writes, installation, OAuth, billing or webhook handlers are active.

## Verified source
L-Code-Dynamics-Dev/okfish-pricing-engine `main` at `f9fb270d916ec9577d3a4472c8d37faac94d28b3`.

## Local validation
`npm run check` (Node.js 22+; no dependencies required).

## Implementation gates
1. Verify signed final Shoptet agreement and exact approved partner application configuration, callbacks, scopes and lifecycle events.
2. Implement OAuth token exchange and encrypted per-shop token storage. Validate all installation callbacks, prevent replay, and handle uninstall/revoke.
3. Implement shop-derived auth sessions; no caller-supplied tenant trust. All database queries tenant-scoped.
4. Port pricing policy behind a versioned adapter, compare real golden datasets with original engine. No production OKfish config copying.
5. Build Shoptet API adapter with rate limiting, bounded retries, backoff and idempotency.
6. Implement Durable Object or transactional per-shop sync leases, checkpoints and dead-letter queue.
7. Implement admin UX, onboarding, tier/coupon policy settings and audit trail.
8. Complete DPA requirements, retention/deletion, operational runbooks, monitoring and review evidence.
9. Validate staging end-to-end with Shoptet sandbox; production deployment requires separate approval.

## Safety
`SYNC_MODE=off`, `workers_dev=false`, placeholder D1 ID. The API intentionally returns 503 for install/uninstall and 403 for admin/sync until full authentication exists. Never publish the proprietary engine source without approval.

## Pricing skill alignment (2026-11-03)

The pure pricing module `packages/core/src/pricing.mjs` implements a small, testable
subset of the supplied `okfish-pricing-engine` skill: best-price selection,
product/brand/category cap precedence and VAT-explicit price PATCH payloads.
It performs **no network calls** and does not contain credentials. This is **not**
validated parity with the original OKfish pricing policies. Tier assignments,
loyalty turnover, coupons, rounding and Shoptet installation remain outstanding.
Never copy OKfish-specific SFTP access credentials into this repository.

## MCP agent control (read/plan phase)

A dedicated authenticated MCP endpoint is implemented at `POST /mcp`. It exposes
`installation_status` and `pricing_preview` with per-shop scoped credentials and
no live writes. See [docs/MCP.md](docs/MCP.md). The credential issuance workflow,
OAuth installation, production gateway controls and execute tools remain disabled.

### Frontend deployment hardening (development)

The tenant-scoped asset executor snapshots all target files before any write,
stages assets under per-run filenames, and restores existing files or removes
new files when publication fails. It requires a trusted approval object and a
unique hexadecimal run ID. The service integrating this executor must enforce
a per-shop distributed lock and validate/consume one-time approvals atomically.
Remote rollback is best effort and incomplete rollback is reported as an error.
There is **no live SFTP adapter, no execute MCP tool and no Shoptet deployment**.

### SFTP transport adapter (development)

`packages/core/src/sftp-transport.mjs` provides a tenant-bound SFTP transport
for the approved asset executor. The trusted server must inject an SFTP client
(e.g. a separately installed `ssh2-sftp-client` adapter) and retrieve credentials
from a per-shop secrets store. MCP arguments must never contain SFTP secrets.
Only the five known frontend assets and their staging names are writable.
The adapter is tested with an in-memory SFTP client; it is **not** wired to
production credentials, a live SFTP library, or an execute MCP endpoint.
A production implementation must add host-key pinning, atomic one-time approval
consumption, distributed per-shop locking and operational backup retention.

### MCP approved installer (development, 2026-11-03)

`frontend_assets_install` is now available only to MCP tokens with `assets:install`.
The tool accepts **only** an opaque `approvalId`; it derives the shop from
MCP authentication and resolves the approved release manifest server-side.
`packages/core/src/approved-install.mjs` requires trusted injected services:
`approvalStore.claim` (atomic one-time approval consumption),
`assetProvider.get` (immutable trusted release assets),
`transportFactory` (shop-scoped SFTP transport), and
`lock.withShopLock` (distributed per-shop exclusion). The tool is **disabled**
when these services are not configured. These service implementations are NOT
included; no live SFTP upload, host-key verification, production secret store,
or actual Shoptet installation is claimed. Tests use fakes.

### Durable one-time installation approvals (development)

`migrations/0003_asset_approvals.sql` adds tenant-bound one-time approvals. `packages/core/src/d1-approval-store.mjs` consumes an approval with a single conditional D1 UPDATE (prevents replay and concurrent duplicate claims). It returns the immutable server-side release/manifest to the installer; MCP arguments cannot supply assets, secrets or shop IDs. An approval is consumed even if a subsequent upload fails; retry requires a fresh administrator approval. Approval issuance, distributed shop locking, host-key-pinned SFTP, encrypted credential storage, release distribution and real end-to-end tests are still required. **Do not enable live installs yet.**

## Installation services (development integration)

MCP `frontend_assets_install` is wired to D1 one-time approvals, a per-shop D1
lease lock and private R2 release assets. The tool remains **fail closed** until
an operator supplies `SFTP_TRANSPORT_FACTORY` with a tenant-bound, host-key-
verified SFTP transport. Never expose credentials or this factory to the MCP
client. The R2 binding `RELEASE_ASSETS` must reference a private bucket and
release objects must be stored under `releases/{shopId}/{releaseId}/{filename}`.

Apply `migrations/0004_install_locks.sql` after the previous migrations. An
authenticated admin backend must call `issueAssetApproval` only after verifying
shop ownership and displaying the exact manifest. The approval ID is then
supplied to the MCP tool. **Do not enable live writes** before host-key pinning,
SFTP credential vault integration, admin authentication and staging E2E tests.

Known limitation: a time-based D1 lease is not a fencing token. If an install
runs longer than the lease, another process can acquire the lock. Keep live
writes disabled until lease renewal/fencing and deployment timeouts are added.

### SFTP credential vault and pinned host identity (development)

`packages/core/src/sftp-credential-vault.mjs` encrypts each shop's SFTP settings using AES-256-GCM with shop ID as authenticated additional data. Set a **random 32-byte hex** master key as a Worker secret (never in source control). Apply `migrations/0005_sftp_vault.sql` to the isolated staging D1 before provisioning credentials. Never send credentials to an MCP tool or an AI model.

`packages/core/src/sftp-transport.mjs` now rejects a transport that cannot return the pinned SHA-256 server host-key fingerprint via `verifiedHostKey()`, and refuses a mismatch. A production transport adapter must implement this interface using the underlying SSH client's verified server public key, not a value supplied by the remote server or agent without cryptographic verification. This project still has **no deployed, audited network SFTP driver**, no administrator provisioning UI, and no Shoptet marketplace OAuth installation. The Worker env `SFTP_TRANSPORT_FACTORY` remains a deliberately nonconfigured integration seam; Workers bindings cannot be configured as arbitrary JavaScript functions through Wrangler vars. Do not enable live installs until an actual compatible transport service and secret provisioning flow are implemented and end-to-end tested.

## Administrator-issued asset installation approvals (development)

The server exposes `POST /admin/asset-approvals` with JSON `{ "releaseId": "release-1", "manifest": [{"name":"vip_cart.js","sha256":"<64 lowercase hex>"}] }`.

This route requires a **separate** bearer token provisioned into `admin_credentials` after verifying shop ownership. Tokens must be generated with a CSPRNG and only SHA-256 token hashes stored. The authenticated token determines the shop; clients cannot supply a shop ID. The route creates a five-minute, single-use, tenant-bound approval. The MCP agent may then call `frontend_assets_install` with the opaque approval ID. The release content must already exist in the private R2 bucket and pass integrity checks.

**Not yet production ready:** No verified Shoptet Marketplace OAuth/install/uninstall callback, no customer-facing authenticated admin UI, no real SFTP transport wired into Cloudflare Worker, no verified Shoptet API scopes, and no end-to-end tests against a sandbox shop. The current `SFTP_TRANSPORT_FACTORY` injection is deliberately disabled unless supplied by trusted server code. Do not store passwords in MCP messages, frontend code, source control, or unencrypted D1 fields. An external Node.js SFTP execution service may be necessary because Cloudflare Worker runtime is not assumed to support raw SSH sockets. Validate the transport and host key on the actual target before enabling uploads.

Apply migration `0006_admin_credentials.sql` after previous migrations. Deploy only to a dedicated staging environment after security review; do not reuse OKfish production credentials.
