# Signed installation lifecycle

Migration 0015 adds tenant-specific encrypted webhook credentials, key-creation
claims, hashed event receipts and ordered lifecycle state. No remote migration or
partner application setting has been changed by this implementation.

## Setup and authorization

An authenticated administrator explicitly confirms creation of an installation's
signing key in the existing iframe overview. The server calls the native
`POST /api/webhooks/renew-signature-key` once and encrypts its result with the
existing `SHOPTET_TOKEN_KEYS` vault, using the distinct `webhook` purpose. No key
is returned to the browser or MCP client. Repeated setup returns existing state.
An interrupted/ambiguous key mutation is quarantined rather than blindly retried;
operator reconciliation is required because renewing again invalidates the
previous native key. Setup is fenced to the current OAuth installation generation.

For OAuth-installed shops, MCP consent and manual MCP credential issuance require
this local signing-key setup. `ready` means the credential was stored, not that
Shoptet has delivered an independently verified notification. Configure the
application's lifecycle URLs in the trusted Shoptet partner administration:

* `/shoptet/uninstall` accepts only `addon:uninstall`.
* `/shoptet/lifecycle` accepts `addon:suspend`, `addon:approve`, and uninstall.

These are fixed application routes, not URLs supplied by an AI client. Actual
approved API access and partner callback delivery must be verified in staging.

## Receipt processing

The server verifies `Shoptet-Webhook-Signature` as HMAC-SHA1 over the exact raw
request bytes using the native key, as specified by Shoptet. Unsigned or modified
payloads are denied. JSON bodies are streamed with a 16 KiB bound. Shop identity,
event instance, recognized event type, installation generation and timestamp
(one hour past / five minutes future) must match. Receipt storage excludes the
raw body and keeps hashes and lifecycle metadata only.

Atomic D1 batches make duplicate events idempotent. Older events cannot overwrite
newer state; equal timestamps prioritize uninstall over suspend over approve.
Uninstall is terminal within its installation generation. Commit-time generation
checks prevent an event verified before reinstall from disabling a new install.

Suspension cancels queued/running sync work and denies tenant API authentication.
Uninstall additionally revokes MCP/admin credentials, OAuth grants and asset
approvals. Both invalidate configuration versions. An approval/resumption event
sets the installation to pending and schedules the existing independent identity
verification; it does not directly activate native pricing or access.

Administrator sessions for OAuth-installed shops are bound to the current OAuth
generation. Reinstallation invalidates old sessions, tokens and pending plans.
Vault key rotation preserves the webhook generation and terminal lifecycle state;
it must not turn a previously uninstalled installation into a fresh generation.

## Verification and limits

SQLite/HTTP-fixture tests cover setup, tampering, tenant mismatch, expiry, ordering,
duplicate delivery, terminal uninstall, reinstall races, admin generation binding,
unknown key mutations, consent gating and cryptographic key rotation. Real D1
latency under the native callback deadline, partner configuration and delivery
remain unverified. No production activation is claimed. Operator reconciliation
for uncertain native signature-key mutations is not exposed as an automatic UI
retry.

Authoritative contracts:
[webhook signing](https://developers.shoptet.com/api/documentation/webhooks/),
[uninstall](https://developers.shoptet.com/api/documentation/uninstalling-the-addon/),
[suspend and approve](https://developers.shoptet.com/api/documentation/pausing-and-resuming-addon/).
