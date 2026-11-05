# Marketplace installation capture and verified onboarding

The installation callback now accepts only a Shoptet authorization code. It does
not ask the merchant for an API token, shop ID or technical OAuth URL. The partner
OAuth origin is trusted deployment configuration, not a callback query parameter.

Required operator configuration:

- `SHOPTET_CLIENT_ID`, `SHOPTET_CLIENT_SECRET`: the approved partner application.
- `SHOPTET_OAUTH_ORIGIN`: the canonical numeric `https://<partner-shop-id>.myshoptet.com`
  origin specified by that application, without path/query/credentials. No default
  partner shop is embedded in the code.
- `ADDON_PUBLIC_ORIGIN` (or `MCP_PUBLIC_ORIGIN`): canonical HTTPS addon origin;
  registered callback is `<origin>/shoptet/install`.
- `SHOPTET_TOKEN_KEYS`: vault keyring Worker secret.

## Capture

Shoptet's installation timeout is five seconds. The callback therefore performs
only its permanent-token exchange (four-second network timeout) and transactional
encrypted persistence. It initializes an empty tenant configuration at version 0,
marks installation `pending`, records a hashed one-time callback claim and creates
a durable verification job. It returns Shoptet's required `200 OK` only after this
capture is stored. End-to-end real callback latency still requires staging checks.

The token response's shop ID is validated against its documented format. The
stored API origin is constructed from this ID under Shoptet's own domain. Contact
email is not invented or copied unnecessarily. New requests cannot choose an
outbound OAuth URL. Duplicate successfully captured callbacks return OK without
exchanging the authorization code again; in-flight/failed claims are not replayed.

## Verification and recovery

`waitUntil` starts verification after capture; the durable job is the source of
truth. A five-minute scheduled handler retries at most ten due jobs per invocation.
Each job has a bounded three-attempt lifecycle and a unique current run ID. It:

1. Decrypts the pending installation's tenant-bound OAuth token.
2. Obtains a temporary API token using Shoptet's fixed shop origin.
3. Calls native E-shop info and compares `data.contactInformation.eshopId` with
   the token response's shop identity.
4. Attempts actual approved-endpoint discovery. Missing permission is recorded as
   unverified, never replaced by an invented capability set.
5. Atomically activates the installation and records the capability snapshot only
   if the exact credential envelope and verification run still match.

Reinstallation replaces the credential generation, clears the API cache and
resets verification. An older in-flight verifier cannot activate or overwrite the
new installation. Identity mismatch fails without granting active MCP access.
The current MCP authentication join denies all pending/suspended/uninstalled shops.

A logged-in Shoptet administrator can open the iframe while verification is
pending using the independent `basic_eshop` login proof. The overview shows actual
state/errors and offers a bounded retry. The browser cannot substitute its own
shop ID or token. Administrator OAuth uses the fixed canonical Shoptet origin,
rejects redirects and has request timeouts.

Migration 0014 adds callback claims, capability snapshots and durable verification
jobs. All tests use isolated SQLite and contract-based HTTP fixtures. No migration,
cron trigger, secret or Worker has been changed remotely.

## Current limits

Actual partner application callbacks, approved scopes and real Shoptet staging
installation still need verification. The webhook lifecycle handler is not yet
complete in this checkpoint; unauthenticated uninstall remains denied. The code
capture is not represented as verified native pricing activation.

References:
[installation](https://developers.shoptet.com/api/documentation/installing-the-addon/),
[token response identity fields](https://developers.shoptet.com/vice-informaci-pri-instalaci-doplnku/),
[administrator OAuth](https://developers.shoptet.com/api/documentation/eshop-verification-using-oauth/).
