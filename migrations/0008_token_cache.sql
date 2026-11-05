ALTER TABLE shoptet_oauth ADD COLUMN cached_api_token TEXT;
ALTER TABLE shoptet_oauth ADD COLUMN api_token_expires_at INTEGER;
