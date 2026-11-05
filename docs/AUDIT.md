# Source audit: OKfish pricing engine

Source: private L-Code-Dynamics-Dev/okfish-pricing-engine, main f9fb270d916ec9577d3a4472c8d37faac94d28b3 (2026-11-03).
Read-only review; no source tests executed. Not a completed full-repository audit.

| Severity | Evidence | Observed risk | Remediation |
|---|---|---|---|
| High, conditional | cloudflare-worker/src/index.ts:38-43,100-104 | Hardcoded legacy admin token is used when API_AUTH_TOKEN is unset. Deployment exposure unverified. | Remove fallback, fail closed, rotate old credential. |
| High, future multi-tenant | cloudflare-worker/src/clearance/clearance-handler.ts:88-105 | Desktop requests authenticate using a single Shoptet private API token. | Per-installation OAuth, separate admin sessions and shop authorization. |
| Medium, concurrency | cloudflare-worker/src/sync/worker-sync.ts:169-176 | KV read-then-write lock is explicitly non-atomic. | Per-tenant transactional lease or Durable Object lock. |
| Medium, reliability | cloudflare-worker/src/sync/worker-sync.ts:1-23,204-227 | Full resync exceeds Worker limits; CLI/GitHub fallback required. | Durable queue and resumable per-tenant checkpoints. |
| Medium, data correctness | cloudflare-worker/src/engine/config.ts:1-17,65-78 | Pricing policies and some date windows are bundled at build/import time. | Tenant-scoped versioned config; evaluate time windows at run time. |
| Operational | cloudflare-worker/src/coupon/coupon-sales-writer.ts:28-48 | Guest coupon-field writes have a documented circular-dependency history. | Golden tests for guest, tier, sale, cap and coupon combinations. |

## Not yet verified
- Current GitHub Actions run status and complete integration test results.
- Production secrets, live Worker configuration and Shoptet partner app registration.
- Complete endpoint authorization, signature/replay protection, price parity, 48 skipped SKUs regression.
- Full dependency and supply-chain vulnerability scan.
