-- Cloudflare D1 baseline. No secrets or personal customer data in this schema.
CREATE TABLE IF NOT EXISTS installations (
  shop_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','active','suspended','uninstalled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tenant_settings (
  shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
  config_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_jobs (
  job_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_shop ON sync_jobs(shop_id,created_at);
CREATE TABLE IF NOT EXISTS webhook_events (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(shop_id,event_id)
);
