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
| Independent review | GPT-6 | READY_FOR_REVIEW | PR #4 on branch `feat/transfer-rules-core-engine` (HEAD `f3ec446`) |

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
