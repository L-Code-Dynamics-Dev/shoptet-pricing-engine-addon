# ACCEPTANCE_MATRIX — requirements vs current evidence
This is an initial requirements index, NOT a completed audit. Each row requires current commit SHA, code path:lines, executable test command/result and integration proof before marking TESTED. Do not turn a requirement into an implementation claim.
Statuses: NOT_VERIFIED | IMPLEMENTED | TESTED | BLOCKED | NOT_APPLICABLE.
| IDs | Domain | Status | Evidence / next check |
|---|---|---|---|
| PRICE-001..012 | Tiers, turnover, price priority, floor, exact money, lists | NOT_VERIFIED | Inspect current core + Shoptet adapter; test fixtures and first write |
| COUPON-001..009 | Percent/fixed coupons, locks, caps, ratio, reconciliation | NOT_VERIFIED | Inspect coupon engine + adapter and actual checkout constraints |
| IFRAME-001..012 | Install-to-management, UX, backend controls, storefront | NOT_VERIFIED | Inspect all UI/onboarding branches, routes, integration and E2E tests |
| SYNC-001..013 | Durable sync, isolation, incident gates, reconciliation | NOT_VERIFIED | Inspect worker/API/job state and run isolated failure tests |
## Agent update protocol
Edit only rows within your assigned scope. Split ID ranges into individual rows as tests are verified. Include commit SHA, path:line, exact test command and observed pass/fail. Unknown or not-run => NOT_VERIFIED. Never invent evidence or use prior-agent claims as executed tests.
## Priority acceptance flow
1. Install with no price writes. 2. Configure all required merchant rules. 3. Complete preview and approval. 4. Bounded execution and verified readback. 5. Truthful daily operations. 6. Coupon/price independent reconciliation. 7. Failure and cross-shop isolation tests.
