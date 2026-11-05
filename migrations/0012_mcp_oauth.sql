CREATE TABLE mcp_authorizations (
 request_id TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 client_id TEXT NOT NULL,
 redirect_uri TEXT NOT NULL,
 resource TEXT NOT NULL,
 scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
 challenge TEXT NOT NULL,
 client_state TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 shop_id TEXT REFERENCES installations(shop_id),
 approved_by TEXT,
 code_hash TEXT UNIQUE,
 code_expires_at INTEGER,
 consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN(0,1))
);
CREATE TABLE mcp_oauth_grants (
 grant_id TEXT PRIMARY KEY,
 shop_id TEXT NOT NULL REFERENCES installations(shop_id),
 client_id TEXT NOT NULL,
 resource TEXT NOT NULL,
 scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
 refresh_hash TEXT NOT NULL UNIQUE,
 refresh_expires_at INTEGER NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0,
 revoked_at INTEGER,
 created_at INTEGER NOT NULL,
 last_connection_at INTEGER,
 last_used_at INTEGER
);
CREATE INDEX mcp_oauth_grants_shop ON mcp_oauth_grants(shop_id);
ALTER TABLE mcp_credentials ADD COLUMN oauth_grant_id TEXT REFERENCES mcp_oauth_grants(grant_id);
-- A generation change or revocation immediately invalidates issued access tokens.
CREATE TRIGGER mcp_oauth_rotate AFTER UPDATE OF generation,revoked_at ON mcp_oauth_grants
BEGIN UPDATE mcp_credentials SET revoked_at=CURRENT_TIMESTAMP WHERE oauth_grant_id=NEW.grant_id AND revoked_at IS NULL; END;
CREATE TABLE mcp_refresh_history (
 refresh_hash TEXT PRIMARY KEY,
 grant_id TEXT NOT NULL REFERENCES mcp_oauth_grants(grant_id),
 expires_at INTEGER NOT NULL
);
CREATE TABLE mcp_oauth_rate_limits (
 bucket TEXT NOT NULL,
 window INTEGER NOT NULL,
 requests INTEGER NOT NULL,
 PRIMARY KEY(bucket,window)
);
