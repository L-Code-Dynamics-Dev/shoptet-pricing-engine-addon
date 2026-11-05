CREATE TABLE shop_webhook_credentials (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 oauth_sha256 TEXT NOT NULL,
 envelope TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE webhook_key_operations (
 shop_id TEXT NOT NULL REFERENCES installations(shop_id),
 oauth_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('processing','ready','uncertain')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(shop_id,oauth_sha256)
);
CREATE TABLE shop_lifecycle_events (
 shop_id TEXT NOT NULL REFERENCES installations(shop_id),
 event_hash TEXT NOT NULL,
 event_type TEXT NOT NULL,
 event_at INTEGER NOT NULL,
 delivery_id TEXT NOT NULL,
 received_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(shop_id,event_hash)
);
CREATE TABLE shop_lifecycle_state (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 oauth_sha256 TEXT NOT NULL,
 event_hash TEXT NOT NULL,
 event_at INTEGER NOT NULL,
 event_rank INTEGER NOT NULL,
 event_type TEXT NOT NULL,
 delivery_id TEXT NOT NULL
);
CREATE UNIQUE INDEX webhook_key_single_mutation ON webhook_key_operations(shop_id) WHERE state IN('processing','uncertain');
