-- Only encrypted ciphertext is stored. Master key is a separate Worker secret.
CREATE TABLE IF NOT EXISTS shop_sftp_credentials (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 iv_b64 TEXT NOT NULL,
 ciphertext_b64 TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
