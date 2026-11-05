CREATE TABLE IF NOT EXISTS asset_install_locks (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 owner_id TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_asset_install_locks_expiry ON asset_install_locks(expires_at_ms);
