-- Administrator sessions are provisioned only after verified Shoptet ownership.
-- These credentials are distinct from agent MCP credentials.
CREATE TABLE IF NOT EXISTS admin_credentials (
 token_sha256 TEXT PRIMARY KEY CHECK(length(token_sha256)=64),
 shop_id TEXT NOT NULL REFERENCES installations(shop_id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT,
 revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_credentials_shop ON admin_credentials(shop_id);
