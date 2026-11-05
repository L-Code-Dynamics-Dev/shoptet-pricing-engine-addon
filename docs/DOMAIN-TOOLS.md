# Domain tools and diagnostics

The MCP gateway now exposes typed proposal operations in addition to complete
proposal replacement. These operations create **new immutable draft revisions**;
none implicitly activates Shoptet or inherits an earlier revision's approval.

- `brand_get`, `product_get`, `pricelist_get`: real sanitized catalog details.
- `brand_set_discount_limit`, `brand_remove_discount_limit`.
- `category_set_discount_limit`, `category_exclude_from_loyalty`.
- `product_set_discount_limit`, `product_exclude_from_loyalty`,
  `product_include_in_loyalty`: product-wide or an explicit actual variant code.
- `loyalty_tiers_list`, `loyalty_tier_create`, `loyalty_tier_update`,
  `loyalty_tier_delete`, `loyalty_tiers_replace`.
- `pricelist_assign_tier`: validates the real native list and stores a proposed
  mapping. Sync selection must match this mapping if one is present.
- `pricing_rules_get`, `pricing_best_price_policy_set`, `pricing_vat_policy_get`.
- `coupons_get_policy`, `coupons_set_combination_rules`.

Brand, category, product/variant and price-list references are revalidated on
proposal creation and validation. Product-wide and variant caps both apply, as do
all matching category restrictions; the strictest cap wins. Removing a product
restriction only removes the exact requested product/variant entry, leaving other
caps intact. Percentages, turnover ordering, duplicate references/names and fields
are server-validated. Unrelated JSON patches or model approval strings cannot pass.

`shop_get_capabilities` now attempts actual approved-endpoint discovery from
Shoptet and clearly marks it unverified if unavailable. It does not guess native
permissions from names or documentation alone.

Diagnostics tools:

- `diagnostics_run`: actual profile/permission reads, proposal schema and local
  vault/OAuth/coordinator prerequisites. Requires shop and pricing read scopes.
- `diagnostics_get_errors`: recent failed sync jobs; requires sync + audit read.
- `diagnostics_get_audit`: configuration, sync and OAuth lifecycle metadata for the
  current tenant. This does not claim a complete append-only per-tool audit log.
- `diagnostics_export_report`: structured checks/history without credentials or
  customer personal data; requires all relevant read scopes.

New resources: `lcode://pricing/rules`, `lcode://loyalty/tiers`, `lcode://sync/status`.
They enforce the same scopes as their corresponding tools. The admin can explicitly
grant `audit:read`; existing tokens do not acquire new scopes automatically.

The existing tier renderer now assigns names via DOM input values instead of
injecting saved text into HTML. Overview counts describe saved proposals rather
than claiming native price lists are active; no merchant email or currency is
invented when absent. A complete browser-level admin review and full canonical
proposal editor integration remain release work.
