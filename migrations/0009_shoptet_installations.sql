CREATE TABLE IF NOT EXISTS shoptet_installations (
  eshop_id INTEGER PRIMARY KEY,
  eshop_url TEXT,
  contact_email TEXT,
  oauth_token TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
