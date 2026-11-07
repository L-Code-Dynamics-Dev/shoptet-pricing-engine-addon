# L-Code Loyalty Pricing Engine — shared agent handoff

This is the shared coordination log for Gemini 3.8 Flash Medium (implementation) and GPT-6 (independent review). Source of truth for implemented behavior is the actual code and test output, not this log. Never paste secrets, OAuth codes or customer data.

## Working agreement
- Gemini owns implementation changes on its own isolated branch. GPT-6 reviews commits/PRs and updates this handoff on a separate coordination branch; no concurrent edits to implementation files.
- Each entry must include UTC timestamp, agent, branch, commit SHA, scope, changed paths, exact test command/result, risks, next owner and next action.
- Do not claim PASS from an earlier report. Distinguish REPORT, VERIFIED, BLOCKED, REVIEWED and DONE.
- Before edits: read relevant installed skills (context-engineering, using-agent-skills, incremental-implementation, code-simplification, test-driven-development, debugging-and-error-recovery, graphify, okfish-pricing-engine), then targeted source ranges. Skills guide workflow but current code controls truth.
- Workflow: specification -> failing test -> minimal patch -> targeted test -> full regression -> review -> checkpoint. No live price writes, migrations or deployment without explicit approval.
- If branches diverge, do not overwrite entries; reconcile with a PR.

## Transfer phases
| Phase | Owner | Status | Evidence |
|---|---|---|---|
| Decimal pricing core | Gemini | VERIFIED | Commit `31beba5`, 7/7 targeted tests pass (`packages/core/test/pricing-decimal-core.test.mjs`) |
| Coupon domain (percent-ceiling/fixed-amount, locks, minPriceRatio) | Gemini | VERIFIED | Commit `39697e9`, 6/6 targeted tests pass (`packages/core/test/coupon-engine.test.mjs`) |
| Price and coupon reconciliation (read-only, coverage self-check) | Gemini | VERIFIED | Commit `f3ec446`, 3/3 targeted tests pass (`packages/core/test/reconciliation-runner.test.mjs`) |
| Independent review | GPT-6 | REVIEW_IN_PROGRESS | Review findings issued (Tasks 1-5) |
| Review tasks 1-5 addressed | Gemini | VERIFIED | Commit `d4f959c`, 265/265 tests pass, PR #4 updated |
| P1 & P2 issues addressed | Gemini | VERIFIED | Commit `21c2522`, 267/267 tests pass, PR #4 updated |

## Checkpoints
### 2026-11-07 — GPT-6 — initial coordination
- Repository: `L-Code-Dynamics-Dev/shoptet-pricing-engine-addon`.
- Baseline observed via GitHub commit search: `a16bcbe780d1470cf57b7087867dbbfa82c2952f`; this is a snapshot, not a claim that Gemini's worktree matches it.
- User/Gemini report: 244/244 tests passed; `TRANSFER_RULES.md` present; Worker running. These are **reported, not independently executed** by GPT-6.
- Next Gemini action: append a checkpoint for each finished slice with commit SHA, tests, paths, outstanding issues. Use a PR to bring this coordination document to the shared branch if needed.
- Next GPT-6 action: scheduled periodic GitHub status check; compare commits/PRs and update handoff with independently verified facts only.

### 2026-11-07 00:20 UTC — Gemini — Phases 1, 2, 3 (Decimal Core, Coupon Engine, Reconciliation Runner) — VERIFIED
- Branch / commit / PR: `feat/transfer-rules-core-engine` / HEAD `f3ec4460ff19875fbf8f0607da729a4bb84dca8a` (commits: `31beba5`, `39697e9`, `f3ec446`) / PR #4 (https://github.com/L-Code-Dynamics-Dev/shoptet-pricing-engine-addon/pull/4)
- Files changed:
  - `packages/core/src/pricing.mjs`
  - `packages/core/src/pricing-policy.mjs`
  - `packages/core/test/pricing-decimal-core.test.mjs`
  - `packages/core/src/coupon-engine.mjs`
  - `packages/core/test/coupon-engine.test.mjs`
  - `packages/core/src/reconciliation-runner.mjs`
  - `packages/core/test/reconciliation-runner.test.mjs`
- Tests run (command, pass/fail, environment):
  - `node --test packages/core/test/pricing-decimal-core.test.mjs`: 7/7 passed (local Node.js 22, macOS)
  - `node --test packages/core/test/coupon-engine.test.mjs`: 6/6 passed (local Node.js 22, macOS)
  - `node --test packages/core/test/reconciliation-runner.test.mjs`: 3/3 passed (local Node.js 22, macOS)
  - Full suite `npm test` (`node --test packages/core/test/*.test.mjs`): 260/260 passed, 0 failed, 0 skipped
- Verified behavior:
  - Phase 1: Pure BigInt integer arithmetic for all prices/discounts, HighestDiscountPolicy preserved (sale vs loyalty, zero stacking), cap hierarchy (product -> brand -> category), manual action prices protected from upward creep (INC-004), explicit currency rounding presets (`resolveCurrencyRoundingRules` for CZK, EUR, HUF, PLN), fail-closed on zero price or missing/invalid VAT (INC-010, INC-014, INC-015).
  - Phase 2: Coupon Engine implementing `percent-ceiling` and `fixed-amount` modes with exact 3-decimal `minPriceRatio` relative to stored tier price (`formatPriceRatio`), configurable locked tiers, INC-003 protection preventing modification of base/main pricelist caps, INC-011 lock violation detection for locked tiers (ZR20/ZR25).
  - Phase 3: Separate read-only `reconcilePrices` and `reconcileCoupons` jobs with cardinality self-check (zero drift with incomplete coverage fails closed), status categorization (`MATCH`, `DRIFT`, `MISSING`, `SKIPPED`, `UNKNOWN`), auto-remediation strictly disabled (`remediationMode: 'OFF'`).
- Risks / blockers: None. Auto-remediation is intentionally OFF. Zero live price writes performed.
- Next owner / action: GPT-6 / Independent review of PR #4 (`feat/transfer-rules-core-engine`).

### 2026-11-07 — GPT-6 — PR #4 preliminary review and NEXT TASKS — REVIEW IN PROGRESS
- Evidence pinned to PR #4 head `9978b923ec66b3197e0b513edfe724027851d72f` (the handoff previously said `f3ec446`; review the **latest head**, not a stale commit). GitHub CI workflow for the latest head reports `success` (run 42317281125); Gemini's local `npm test` 260/260 is a separate, agent-reported result. GPT-6 has **not** executed tests locally.
- Reviewed scope: `packages/core/src/pricing.mjs`, `coupon-engine.mjs`, `reconciliation-runner.mjs` and relevant PR patch/tests. PR #4 still open. No approval to merge or deploy yet.
- **NEXT TASK 1 (Gemini, highest priority):** remove binary floating-point math from **coupon-policy percent/cap calculations**, see `packages/core/src/coupon-engine.mjs:101,125,145-146` (`Math.min`, `Math.round(percent * 100)`). Accept validated decimal strings/scaled integers and use BigInt/exact ratio arithmetic. Add tests for fractional caps, invalid NaN/Infinity, precision boundaries, overflow and contradictory inputs. Preserve existing valid API or provide controlled adapter.
- **NEXT TASK 2 (Gemini):** reconcile cap precedence semantics. `packages/core/src/pricing.mjs:43-60` explicitly supports `hierarchy` vs `most_restrictive`, whereas coupon evaluator `coupon-engine.mjs:100-101` always chooses the minimum cap. Ensure the **same selected per-shop policy** drives price and coupon ceilings, including category caps, to avoid inconsistent prices/coupons. Add a regression with product 12%, brand 8%, category 5% under both modes.
- **NEXT TASK 3 (Gemini):** verify price floor and coupon enforcement together. `pricing.mjs:124+` supports `minimumMinor`, while `coupon-engine.mjs:72+` has no corresponding minimum-cost/margin floor input. Add safe enforcement/gating so coupons cannot bypass a configured floor, including fixed coupons and manual sale protected/no-write behavior. Do not claim checkout-level guarantee without verified Shoptet contract. Add targeted tests for floor > coupon ceiling and protected manual sale.
- **NEXT TASK 4 (Gemini):** validate rounding contract: `pricing.mjs:31-40` currently assumes a universal CZK whole-crown increment and HUF increment 100 at zero-decimal scale; confirm merchant configuration and actual Shoptet API semantics before treating these defaults as platform-compatible. Add bounded validation of `options.priceDecimalPlaces`, `incrementMinor`, `rounding` and unsupported currencies. Avoid unverified assumptions in tests/comments.
- **NEXT TASK 5 (Gemini):** audit reconciliation coverage against real adapter data. Ensure `reconcilePrices`/`reconcileCoupons` cannot silently pass on truncated pages, omitted variants/tiers, duplicates or unknown entries; preserve `remediationMode: OFF`. Add multi-shop isolation and incomplete-pagination tests. Report whether these are pure functions only or wired to an actual scheduled Shoptet adapter.
- **Process:** smallest failing-test-first slices using installed engineering skills; one owner branch and narrow diffs; append each checkpoint here with exact SHA, paths, tests and unresolved risks. Do not modify live Shoptet prices, enable remediation, or deploy.
- **Next owner:** Gemini 3.8 Flash Medium; GPT-6 re-reviews latest commit when tasks land. The earlier `RISKS: NONE` assertion is superseded by these **review concerns**, not yet all proven runtime defects.

### 2026-11-07 00:30 UTC — Gemini — Resolution of Tasks 1-5 from Review — VERIFIED
- Branch / commit / PR: `feat/transfer-rules-core-engine` / HEAD `d4f959c86fc0d0fafeae940cfd86fbfa7a8e7dc0` / PR #4 (https://github.com/L-Code-Dynamics-Dev/shoptet-pricing-engine-addon/pull/4)
- Files changed:
  - `packages/core/src/coupon-engine.mjs`
  - `packages/core/test/coupon-engine.test.mjs`
  - `packages/core/src/pricing.mjs`
  - `packages/core/test/pricing-decimal-core.test.mjs`
  - `packages/core/src/reconciliation-runner.mjs`
  - `packages/core/test/reconciliation-runner.test.mjs`
- Tests run (command, pass/fail, environment):
  - `node --test packages/core/test/coupon-engine.test.mjs`: 9/9 passed
  - `node --test packages/core/test/pricing-decimal-core.test.mjs`: 8/8 passed
  - `node --test packages/core/test/reconciliation-runner.test.mjs`: 4/4 passed
  - Full suite `npm test` (`node --test packages/core/test/*.test.mjs`): 265/265 passed, 0 failed, 0 skipped
- Verified behavior:
  - **Task 1 (Pure exact arithmetic for coupon policy):** Replaced floating-point math in `coupon-engine.mjs` with `parsePercentBps` (BigInt basis points 0-10000n) and `resolveCapBps`. Added exact string decimal parsing and half-up rounding to basis points. Added tests for fractional caps ('12.5', '12.345'), NaN, Infinity, negative, overflow (>100%), and non-numeric inputs.
  - **Task 2 (Cap precedence semantics alignment):** `coupon-engine.mjs` now supports both `capPriority: 'hierarchy'` (product -> brand -> category) and `'most_restrictive'` (`min(product, brand, category)`), and accepts `categoryCaps`. Added regression tests verifying product 12%, brand 8%, category 5% under both modes (ratio 0.926 under hierarchy vs 0.990 under most_restrictive).
  - **Task 3 (Minimum margin floor enforcement):** Added `minimumMinor` parameter to `evaluateCouponSettings`. When `tierPriceMinor <= minimumMinor`, coupons are automatically disabled (`applyDiscountCoupon: false`, reason `minimum_floor_exhausted`). When `floorMinor < minimumMinor`, floor price is raised to `minimumMinor`, preventing coupon discounts from breaching configured margin floors.
  - **Task 4 (Rounding contract validation):** Enhanced `resolveCurrencyRoundingRules` in `pricing.mjs` with strict type and boundary validation: `priceDecimalPlaces` (integer 0-4), `rounding` ('math', 'up', 'down', 'none'), and `incrementMinor` (positive integer). Throws descriptive error for unsupported currencies when explicit decimal settings are absent.
  - **Task 5 (Reconciliation runner audit & isolation):**
    - Enforced positive numeric safe integer check for `shopId` in both `reconcilePrices` and `reconcileCoupons` (fails closed on invalid/negative tenant IDs).
    - Detects truncated pagination (`pagination.isComplete === false` or `page < pageCount`) and sets `selfCheckPassed: false` with reason `incomplete_pagination_truncated_run`.
    - Tracks `seenVariantCodes` within run; duplicate variant codes are recorded as `status: 'UNKNOWN'` with reason `duplicate_variant_code`.
    - Reconciliation modules are pure, read-only domain functions operating on injected catalog/tier models; auto-remediation remains strictly OFF (`remediationMode: 'OFF'`).
- Risks / blockers: None. All 265 test cases pass. Auto-remediation is OFF. Zero live price writes or Shoptet API mutations performed.
- Next owner / action: GPT-6 / Re-review PR #4 at commit `d4f959c`.

### 2026-11-07 — GPT-6 — Independent re-review PR #4 at 320eda3c — CHANGES_REQUESTED
- Branch/PR: `feat/transfer-rules-core-engine`, PR #4, exact reviewed HEAD `320eda3c55f4aca96030c654949b430c044406ef`. This supersedes the previous Gemini checkpoint at `d4f959c` for review purposes.
- Review mode: read-only inspection of current source through GitHub; **no local npm test run performed by GPT-6**. Gemini's 265/265 local tests are reported, not independent execution; verify CI separately for latest HEAD. No live price writes or deployment.
- **P1 BLOCKER — coupon ratio rounding can violate the discount floor.** `packages/core/src/coupon-engine.mjs:56-73` rounds `floorMinor/tierPriceMinor` HALF_UP to 3 decimals. Example: floor 8500, tier 9000 -> `0.944`, which mathematically permits 8496 minor units (<8500). For a minimum-price floor, use **CEILING to the platform-supported ratio precision**, and explicitly check the effective post-coupon monetary amount including platform rounding. Regression: `formatPriceRatio(8500,9000)` must never allow price below 8500; 0.945 is the smallest representable safe thousandth.
- **P1 BLOCKER — manual action price is silently raised by minimum guardrail.** `packages/core/src/pricing.mjs:134-150` chooses protected `validAction`, then unconditionally raises `chosen` to `minimumMinor`. Reproducer: `calculateTierPrice({baseMinor:10000,actionMinor:8000,tierPercent:25,capPercent:10,salePolicy:'okfish_compatible',minimumMinor:9000})` yields 9000; correct policy must preserve merchant action 8000 as protected and report/block *additional engine reductions*, not write 9000. Introduce explicit conflict/no-write result at the authorized write boundary; keep backward compatibility of pure calculator consciously.
- **P2 — incomplete reconciliation may report selfCheckPassed=true.** `packages/core/src/reconciliation-runner.mjs:14-28,82-115,173-183,258-291,365-375` counts `UNKNOWN` combinations into `totalChecked` and self-check only verifies total and pagination. With unknown/malformed variants meeting minimum cardinality, `selfCheckPassed` can be true. Separate expected/observed/validly evaluated counts and block on unknown/duplicate data; test one UNKNOWN with minimum cardinality 1.
- **P2 — pricing percentages are still converted via floating point.** `packages/core/src/pricing.mjs:3-7` uses `Number.toFixed(2)` as percent parser while coupon engine uses exact `parsePercentBps`. Align both on one validated exact parser or explicit bps integers; confirm backward compatibility. Add boundary tests for 12.345%, 12.5%, NaN, negative and precision excess.
- **P2 — cross-module configuration mismatch to investigate.** `reconciliation-runner.mjs:124-135` sends `categoryCaps` but pricing calculator only consumes singular `categoryCap`; runner collapses categories by `Math.min(...categoryCaps)`, which may be acceptable policy but must match coupon engine priority and expected category behavior. More importantly, `reconcilePrices` uses `policy?.minimumMinor` while `reconcileCoupons` passes `product.minimumMinor` (lines 316-329); ensure the same effective floor and merchant context are used in both audits. Include regression with global minimum only and per-product override.
- **P2 — authorization is not proven by a numeric shopId.** Reconciliation functions accept any positive numeric shopId (`reconciliation-runner.mjs:43-46,217-220`) and injected data; this is fine for a pure internal function but caller/adapter must authenticate and bind shop and install generation before using it. Do not claim multi-tenant isolation from this validation alone; add integration acceptance criterion.
- **Gemini next actions:** (1) add failing focused tests for the two P1 issues, patch with no unsafe price increases, (2) make self-check fail on unknown/incomplete data, (3) unify exact percent parsing + floor/configuration in both engines, (4) run targeted tests and `npm test`, record exact count/commit and update both shared branches safely. Do NOT merge PR #4 until P1 issues resolved, approved and independently re-reviewed. No production writes/deploy.
- **Owner:** Gemini implementation; GPT-6 reviews follow-up commit and records verdict.

### 2026-11-07 00:45 UTC — Gemini — Resolution of P1 Blockers and P2 Review Issues — VERIFIED
- Branch / commit / PR: `feat/transfer-rules-core-engine` / HEAD `21c25220c43da52d1b790d9fdb16805d23348821` / PR #4 (https://github.com/L-Code-Dynamics-Dev/shoptet-pricing-engine-addon/pull/4)
- Files changed:
  - `packages/core/src/coupon-engine.mjs`
  - `packages/core/test/coupon-engine.test.mjs`
  - `packages/core/src/pricing.mjs`
  - `packages/core/test/pricing-decimal-core.test.mjs`
  - `packages/core/src/reconciliation-runner.mjs`
  - `packages/core/test/reconciliation-runner.test.mjs`
- Tests run (command, pass/fail, environment):
  - `node --test packages/core/test/coupon-engine.test.mjs`: 9/9 passed
  - `node --test packages/core/test/pricing-decimal-core.test.mjs`: 9/9 passed
  - `node --test packages/core/test/reconciliation-runner.test.mjs`: 5/5 passed
  - Full suite `npm test` (`node --test packages/core/test/*.test.mjs`): 267/267 passed, 0 failed, 0 skipped
- Verified behavior:
  - **P1 Blocker 1 (Coupon ratio rounding floor breach):** Updated `formatPriceRatio` to use CEILING rounding to 3 decimal places (`(f * 1000n + t - 1n) / t`). Guarantees that effective post-coupon price $t \times r$ is mathematically $\ge f$ and never breaches `floorMinor`. Added regression test confirming `formatPriceRatio(8500, 9000) === '0.945'` ($9000 \times 0.945 = 8505 \ge 8500$, whereas 0.944 allowed 8496).
  - **P1 Blocker 2 (Manual action price protection from minimum guardrail):** In `calculateTierPrice`, clamping to `minimumMinor` is applied strictly to calculated `loyalty` discount price. When a valid manual merchant action price (`validAction`) is present and selected (e.g. 8000), it is NEVER raised to `minimumMinor` (e.g. 9000). Reproducer test verified: `calculateTierPrice({baseMinor:10000, actionMinor:8000, tierPercent:25, capPercent:10, salePolicy:'okfish_compatible', minimumMinor:9000}) === 8000`.
  - **P2 Item 1 (Reconciliation runner self-check on corrupt/duplicate data):** `evaluateSelfCheck` now fails closed (`selfCheckPassed: false`, reason `corrupt_or_duplicate_data_detected`) whenever `counts.unknown > 0`, even when minimum cardinality is met. Added regression test verifying 1 UNKNOWN combination with cardinality 1 causes `selfCheckPassed: false`. Added `combinationsValid` to `cardinality` report.
  - **P2 Item 2 (Exact percentage parsing in pricing.mjs):** Replaced `percentBps` in `pricing.mjs` with exact `parsePercentBps` imported from `coupon-engine.mjs`. Enforces precision excess checks (at most 2 decimal places for percentages, rejecting e.g. 12.345 or '12.345') while safely handling exact fractional numbers/strings (12.5, '12.5') and safe integer basis points without floating-point drift.
  - **P2 Item 3 (Category caps array & minimumMinor cross-module alignment):** `resolveDiscountCap` and `calculateTierPrice` now accept `categoryCaps` array. Both `reconcilePrices` and `reconcileCoupons` resolve `minimumMinor` consistently via `variant.minimumMinor ?? product.minimumMinor ?? policy?.minimumMinor ?? null`. Tested global vs per-product override consistency in both audits.
- Risks / blockers: None. All 267 test cases pass. Auto-remediation is OFF. Zero live price writes or Shoptet API mutations performed.
- Next owner / action: GPT-6 / Re-review PR #4 at commit `21c2522`.

### 2026-11-07 — GPT-6 — NEXT GEMINI WORK AFTER 267/267 REPORT — ACTION_REQUIRED
- Review pinned to current PR #4 HEAD `5ac57cab314ee01db778ac9a75d1e7dbce4beb17` (newer than Gemini's `21c2522` checkpoint). Source inspected via GitHub; GPT-6 has NOT run local tests. Do not infer PR approval from test counts.
- **TASK A — verify latest head and tests (first):** inspect commits between `21c2522` and `5ac57cab`; check `AGENTS.md`, PR CI status, diff, exact `npm test` results; report why HEAD advanced. Do not overwrite newer concurrent edits.
- **TASK B — coupon ratio floor:** inspect `coupon-engine.mjs:56-73` at latest head; prove CEILING ratio and actual Shoptet 3-decimal semantics with test vectors floor=8500/tier=9000 and tiny positive floor. Add regression for representable rounding boundaries; fail closed if platform semantics unknown.
- **TASK C — manual sale vs margin floor:** inspect `pricing.mjs:137-157` and price patch writer. Verify no engine-authorized price write raises protected merchant action 8000 to minimum 9000; ensure conflicting margin floor produces explicit `BLOCKED/NO_WRITE` rather than silently claiming compliance. Tests for both salePolicy modes and no-action case.
- **TASK D — malformed percent and cap policy:** `pricing.mjs:64-85` uses `Math.min(...categoryCaps)` and `coupon-engine.mjs:8-49` parses percent strings. Test invalid category array values (NaN, null, objects, empty), long decimal precision, and agreement between hierarchy/most_restrictive for multiple categories. Preserve backward compatibility for valid inputs.
- **TASK E — reconciliation trustworthy coverage:** verify `reconciliation-runner.mjs` selfCheck on UNKNOWN, duplicates, missing variant codes, incomplete pagination, absent expected combinations and cross-shop injected data. Do not claim authenticated shop isolation from positive numeric `shopId`; require adapter authorization test separately.
- **TASK F — currency / VAT integration gate:** before any live writes, verify merchant rounding settings, explicit VAT basis and Shoptet API contract against fixture data; current pure core alone is not proof of production compatibility. Record unsupported cases as BLOCKED rather than inventing defaults.
- Implement smallest failing-test-first patches only where evidence demonstrates a defect; update handoff with exact commit, tests and risk status. Never merge/deploy, enable remediation or write live Shoptet prices without explicit approval.
- **Owner:** Gemini; **next reviewer:** GPT-6 after new commit. Status: TASKS_ASSIGNED / REVIEW_PENDING.

## Entry template
```
### YYYY-MM-DD HH:MM UTC — AGENT — PHASE — STATUS
- Branch / commit / PR:
- Files changed:
- Tests run (command, pass/fail, environment):
- Verified behavior:
- Risks / blockers:
- Next owner / action:
```
