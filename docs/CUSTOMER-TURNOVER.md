# Customer turnover preview

This checkpoint adds actual customer/group/order/credit-note reads and a pure,
integer-arithmetic turnover calculation. It does **not** implement native customer
assignment execution or order-event automation. No customer or price is modified.

## MCP and permission boundary

`customers:read` is a separate opt-in scope in MCP OAuth and manual credentials.
It is not part of default shop/catalog permissions. The tools are:

* `customer_groups_list`: native group IDs, codes and default price-list mappings.
* `shop_get_order_statuses`: real shop status IDs and names.
* `loyalty_turnover_policy_get`: saved proposal policy, under `pricing:read`.
* `loyalty_turnover_policy_set`: new immutable draft revision, requiring both
  `pricing:configure` and `customers:read`.
* `loyalty_recalculate_preview`: a specific authorized tenant revision and at most
  five customer GUIDs, requiring `pricing:read` and `customers:read`.

The authenticated shop comes exclusively from MCP authorization. Customer GUIDs
are resolved through that shop's credentials; another tenant's draft cannot be
read. Adapter results omit names, email, addresses, notes and document remarks.
Returned customer/order identifiers are still merchant data and require the
explicit customer permission. The preview is not retained in a new PII table.

## Supported policy

Policies are optional `loyaltyProposal.turnoverPolicy` fields. Existing proposals
remain compatible. Domain validation verifies status IDs against the actual shop
before creating a draft. Changes use existing immutable approval/save/history
semantics; a model's statement of approval is never accepted.

The supported period is an explicit offset-aware timestamp interval, inclusive
at `from` and exclusive at `to`, based on **order creation time**. A future upper
bound is rejected for preview. Qualifying status IDs and the paid requirement are
explicit. Guest orders are excluded. Money remains exact hundredths; currencies
are never converted or mixed. VAT-inclusive/exclusive totals and inclusion of
shipping and billing fees are explicit choices. Native totals are already after
discounts and quantities; multiplying them again would be incorrect.

Refund policy `exclude_order_with_valid_credit_note` excludes the entire original
qualifying order whenever a currently valid native credit note references it,
including partial credit notes. It does not prorate refunds or treat credit-note
amount signs as an undocumented contract. Credit notes outside the purchase
period still exclude their referenced qualifying order. A customer's valid
unlinked credit note, conflicting customer reference or duplicated document
blocks the preview. Supporting proportional refunds needs a separately verified
accounting policy and fixtures.

The currently supported item-status rule requires every item's status to match
its order status. Mixed-status orders are rejected for review. They are not
silently counted in full. This conservative limitation needs expansion before
broad merchant automation. Upgrades recalculate from exact thresholds; downgrades
either recalculate or retain a higher unambiguously mapped current tier.

## Completeness and remaining execution work

Preview bounds: five customers, 25 orders total and 50 credit notes across the
shop. Every collection must finish pagination with matching counts, no duplicate
codes, and consistent page metadata. Larger or incomplete datasets fail; there is
no sampling presented as complete turnover. Orders are re-read individually and
their change times compared with listing results. Current mapped price lists and
their currencies are rechecked. Independent customer price ratios are reported
as an assignment blocker. Source reads are a preview snapshot, not an atomic
Shoptet transaction or execution approval.

Each result explicitly reports `applied: false`, `assignmentSupported: false` and
`customer_assignment_executor_not_implemented`. A mapped price list is not proof
of a native assignment. Missing mappings and no qualifying tier remain visible.
The native API has a customer PATCH contract, but its approved scope, immutable
assignment plans, trusted approvals, fenced durable executor, independent
readback and order/refund event triggers still need implementation/verification.
The existing native-price sync runner is not silently reused for customer writes.

Tests cover exact thresholds, VAT, fees, post-discount quantities, valid/invalid
refunds, cancellations, unpaid/guest orders, mixed statuses, currency conflicts,
missing money, duplicate documents, downgrade policy, pagination limits, changed
orders, missing references, independent discounts, tenant isolation, per-tool
scopes and native response minimization. All use isolated SQLite/HTTP fixtures.

Contracts were checked against the official
[Shoptet OpenAPI](https://api.docs.shoptet.com/_bundle/Shoptet%20API/openapi.json?download):
`GET /api/customers/groups`, `GET /api/customers/{guid}`, `GET /api/orders`,
`GET /api/orders/{code}`, `GET /api/credit-notes`,
`GET /api/credit-notes/{code}` and `GET /api/eshop?include=orderStatuses`.
