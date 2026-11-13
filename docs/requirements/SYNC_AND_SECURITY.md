# SYNC_AND_SECURITY — operational safety and incident contract
Status: REQUIREMENT.
- SYNC-001: Signed authenticated Shoptet callbacks; validate bounded raw body before processing; durable event acceptance before success acknowledgment; scoped shop/installation identity.
- SYNC-002: Full catalog and order pagination proof incl. variants/tiers/credit notes and minimum cardinality. Missing source, VAT, base price, relevant manufacturer or cost must fail closed for affected writes.
- SYNC-003: Incremental changes and full sync converge; no duplicate effects; do not discard later order corrections; policy fingerprint invalidates affected calculations.
- SYNC-004: Explicit protected main list, managed-list allowlist, VAT metadata (price, includingVat, vatRate) on new entries; first-write readback.
- SYNC-005: Parse each bulk result even when HTTP 200; unknown timeout/5xx write outcome -> reconcile before retry; do not advance lastSync or poison cache on unverified writes.
- SYNC-006: Durable per-shop job ownership/lease, per-item idempotency, bounded rate limit/concurrency, 429 backoff, no unsafe KV get-then-put lock.
- SYNC-007: Separate read-only price reconciliation and coupon reconciliation; count full coverage and distinguish mismatch, missing, skipped, unknown; remediation is separately authorized.
- SYNC-008: Five stages: config/input validation; pre-write preview/fuse; regression/negative tests; truthful sync commit; independent complete reconciliation.
- SYNC-009: Proposed self-healing classification AUTO/REVIEW/BLOCK; AUTO OFF by default, require per-shop authorization and independent readback. Unknown source, manual conflict, VAT ambiguity, stale policy, uninstall => BLOCK.
- SYNC-010: Authenticated shop isolation in DB/queues/cache, scoped tokens and permissions, secure iframe session/origin/CSRF, no secrets or repository/source access to merchant agent.
- SYNC-011: Suspend/uninstall stops queued writes; revocation and stale approvals checked at consumption. No promise of restoring prices after revoked Shoptet token.
- SYNC-012: Incident regression matrix INC-001..INC-016: malformed API data, customer cache, protected caps/actions, retry and dry-run, silent no-op, new variants, coupon drift, pagination, truthful monitoring, VAT metadata, zero-price fallback, per-item HTTP 200 errors.
- SYNC-013: No live Shoptet write, migration, deployment or merge without named approval. Tests use isolated fixtures and report observed commands/results.
Acceptance: multi-shop collision/forged tenant tests; webhook duplicate/reorder; crash between durable inbox and dispatch; 429/timeout/partial HTTP200; full coverage, first-entry readback, uninstall and 50k-product bounded paging simulation.
