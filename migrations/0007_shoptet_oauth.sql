CREATE TABLE IF NOT EXISTS shoptet_oauth (
  shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
  oauth_access_token TEXT NOT NULL,
  eshop_url TEXT,
  contact_email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
