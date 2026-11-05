# Configuration proposals and trusted approval

Migration `0010_configuration_revisions.sql` adds immutable tenant-scoped proposal snapshots,
one-time expiring approvals and configuration history. No remote migration has been performed.

## Workflow

1. An administrator explicitly grants `pricing:configure` to a new MCP fallback credential using the AI asistent checkboxes. Existing read-only credentials do not gain permissions automatically.
2. `configuration_create_draft` accepts `expectedVersion` and a strict domain `proposal`. No arbitrary patches or shop IDs. Brands must have verified real GUIDs. All proposals are immutable.
3. `configuration_update_draft` creates a different revision. Prior approvals remain bound exclusively to their original revision.
4. `configuration_validate` checks references, tier ordering, unique names, ranges and current version. `configuration_preview` displays the exact before/after snapshots and limited effect.
5. `configuration_request_approval` issues a pending, 15-minute approval bound to the tenant, revision and action `save_configuration`.
6. In the existing admin's Přehled panel, the administrator reviews the complete snapshots and explicitly selects **Schválit uložení této revize**. A model's approval text or MCP bearer cannot authorize this action. The browser API requires the signed admin-session bearer, rejects foreign Origins, checks active installation and records a hash of the authorizing session, not its secret.
7. `configuration_apply` requires separately granted `pricing:execute`. It only accepts an opaque approval ID. A SQLite trigger atomically checks the base version, consumes the approval, saves the exact snapshot and inserts history. Version conflicts roll back the entire transaction. Replays and cross-tenant claims fail.
8. `configuration_verify` compares the current saved snapshot and expected version. `configuration_get_history` lists revisions. `configuration_rollback` creates a new proposal for a historical version, requiring a new approval before application.

## Exact semantics

Configuration is saved under `tenant_settings.config_json.loyaltyProposal`. Existing settings are preserved.
This is a **proposed configuration**, not activation of any pricing, coupon, storefront or customer-assignment behavior.
Tool results explicitly report `shoptetApplied: false` and `storefrontVerified: false`.
No price-write adapter or synchronization runner consumes this proposal yet.

Proposal schema: currency (three-letter uppercase code), ordered tiers (name, percent,
`minTurnover` in whole major currency units, matching the existing administration convention),
brand caps (verified GUID and percent), `salePolicy: lowest_price`, and coupon policy
`no_loyalty_combination` or `unchanged`. These are validated proposal options, not claims of native checkout support.
No synthetic currencies, brands or tiers are inserted.

## Deployment and recovery

Before using these routes, apply migration 0010 to an isolated test database after migrations
0001–0009 and test the current Worker there. The test suite applies all forward migrations to
fresh SQLite and exercises the full MCP → admin confirmation → apply → verify path on real SQL.
It also checks scope/tenant isolation, modified revision rejection, replay/expiry rejection and
competing revisions. Cloudflare D1 staging compatibility and actual browser UI remain separate checks.

Do not drop history or approval tables to recover after use. The previous Worker ignores the new
`loyaltyProposal` field; reverting the Worker leaves existing live pricing settings unchanged.
To restore a saved proposal, create a rollback proposal, preview and approve it. A stale approved
proposal cannot execute after another configuration version is saved; create a fresh proposal.
No automatic rollback or production schema changes are authorized by this feature.
