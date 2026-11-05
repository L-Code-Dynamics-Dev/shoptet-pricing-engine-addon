-- Provision only by a trusted operator/admin workflow after authenticating the shop.
-- Store SHA-256 of a cryptographically random >=32-byte bearer token; never plaintext.
CREATE TABLE IF NOT EXISTS mcp_credentials (
  token_sha256 TEXT PRIMARY KEY CHECK(length(token_sha256)=64),
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_shop ON mcp_credentials(shop_id);
