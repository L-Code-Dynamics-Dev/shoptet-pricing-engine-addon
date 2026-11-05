-- Additive migration. Existing plaintext rows require explicit per-shop vault conversion.
-- New runtime refuses plaintext fallback. Take encrypted backups before conversion.
ALTER TABLE shoptet_oauth ADD COLUMN oauth_envelope TEXT;
ALTER TABLE shoptet_oauth ADD COLUMN api_envelope TEXT;
CREATE TRIGGER oauth_no_plaintext_insert BEFORE INSERT ON shoptet_oauth
WHEN NEW.oauth_access_token!='' OR NEW.cached_api_token IS NOT NULL
BEGIN SELECT RAISE(ABORT,'plaintext_tokens_forbidden'); END;
CREATE TRIGGER oauth_no_plaintext_update BEFORE UPDATE ON shoptet_oauth
WHEN NEW.oauth_access_token!='' OR NEW.cached_api_token IS NOT NULL
BEGIN SELECT RAISE(ABORT,'plaintext_tokens_forbidden'); END;
CREATE TRIGGER installation_no_plaintext_insert BEFORE INSERT ON shoptet_installations
WHEN NEW.oauth_token!=''
BEGIN SELECT RAISE(ABORT,'plaintext_tokens_forbidden'); END;
CREATE TRIGGER installation_no_plaintext_update BEFORE UPDATE ON shoptet_installations
WHEN NEW.oauth_token!=''
BEGIN SELECT RAISE(ABORT,'plaintext_tokens_forbidden'); END;
