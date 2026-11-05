# Shoptet OAuth token vault

The runtime requires `SHOPTET_TOKEN_KEYS`, a Worker secret containing JSON:
`{"active":"v1","keys":{"v1":"<64 hexadecimal characters: 256 random bits>"}}`.
Never commit key values, log this secret or expose it through admin/MCP output.
The key ID is public metadata; the keys are not.

Permanent OAuth tokens and cached short-term API tokens use AES-256-GCM with a
fresh random 96-bit nonce. Associated authenticated data binds envelope version,
tenant, token purpose and key ID. Cross-shop/purpose substitution and tampering
fail authentication. No runtime plaintext fallback is available.

Migration 0011 is additive and creates database guards preventing new plaintext
writes. It does not convert existing credentials or contact any merchant. Existing
rows require a separately authorized conversion before the new runtime can read
them. Installation uses one transactional D1 batch and clears the compatibility
copy of the secret. API cache renewal uses a compare-and-swap against the permanent
envelope plus active installation state; a reinstall or suspension prevents stale
cache publication. API errors never include upstream response bodies.

## Staging migration and recovery

1. Back up the database into encrypted operator-controlled storage. A backup taken
   before conversion contains legacy plaintext secrets; restrict and retire it.
2. Provision a random keyring as a Worker secret. Keep recovery copies in an
   approved secret manager. Neither SQL nor repository files contain key material.
3. Apply forward migration 0011 to an isolated staging database after previous
   migrations. Application and migration deployment must be coordinated because
   the previous runtime writes plaintext and will be rejected by new guards.
4. Invoke server-only `migrateShopTokens({db,shopId,tokenKeys})` through a separately
   authorized operator workflow per shop. This utility is deliberately not an MCP
   tool, public endpoint or automatically executing deployment script.
5. Verify decryption, cache renewal and that both legacy secret columns are empty.
   The conversion uses optimistic concurrency; retry only after inspecting a
   concurrent-installation change. No credentials are returned by the utility.
6. Deploy the vault-aware runtime after all required shops have been converted.

For key rotation, add a new key alongside the old key and set `active` to the new
ID. Convert/re-encrypt each shop with the utility. Retain old keys until every
permanent/cache envelope and recovery backup has an understood recovery path.
Dropping a key early intentionally makes its envelopes unreadable.

Recovery after conversion must use a vault-aware runtime or encrypted backup with
the matching keyring. Reverting to the old plaintext-writing runtime is not a safe
recovery strategy. Do not remove the SQL guards or copy secrets back into legacy
columns. There is no approved production migration or deployment in this branch.

Tests use real SQLite with every forward migration, plus AEAD substitution,
tampering, missing-key, explicit conversion, key rotation, cache renewal/reuse and
reinstall-during-renewal cases. D1 staging and real Shoptet token renewal still
require verification before release. Concurrent token minting across requests is
not serialized by this change; a fenced per-shop renewal coordinator remains an
operational integration requirement.
