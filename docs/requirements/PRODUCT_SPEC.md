# PRODUCT_SPEC — L-Code Loyalty Pricing Engine (Marketplace B2C)
Status: REQUIREMENT, not proof of implementation. Canonical scope: multi-merchant Shoptet Marketplace B2C addon; independent pure pricing core, authenticated Shoptet adapter, embedded merchant administration, storefront integration, optional tightly scoped merchant AI/MCP interface.
## Invariants
- Each shop owns independent policies, customers, currencies, tier mappings, audit history and jobs. No OKfish identifiers, SKU exceptions, brand promotions, turnover thresholds or tokens as global defaults.
- Real native Shoptet managed tier pricelists determine customer checkout prices; storefront must not pretend an unsupported discount.
- Protect merchant-owned main pricelist and unmanaged lists. Separate special brand-action write capability requires explicit approval.
- The same versioned approved per-shop policy drives core, coupon calculations, admin, customer-facing UI and jobs.
- No installation-time live writes. Lifecycle: install/authenticate -> discover -> configure -> complete read-only preview -> explicit merchant approval -> bounded execution -> readback -> ongoing monitoring.
- Merchant-facing Czech copy, understandable without technical vocabulary, coherent navigation and real functional controls.
## Domains and source documents
PRICE: PRICING_RULES.md; COUPON: COUPON_RULES.md; IFRAME: ONBOARDING_IFRAME.md; SYNC: SYNC_AND_SECURITY.md; proof tracking: ACCEPTANCE_MATRIX.md.
## AI/MCP scope
Merchant agent may inspect authorized shop business data, draft policies, request preview and propose approved operations. No access to repositories, source, arbitrary SQL/shell, secrets, developer infrastructure or another shop. Installation assistance cannot bypass authorization or merchant approval.
## Product boundary
B2C only; B2B, NEXUS and client-specific OKfish production behavior are out of scope. Other commerce platforms are a portability objective, not delivered integrations.
## Status semantics
REQUIREMENT / IMPLEMENTED / TESTED / BLOCKED / NOT_VERIFIED are distinct. No statement of production readiness without actual current-code and test evidence.
