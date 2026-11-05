CREATE TABLE shoptet_install_callbacks (
 code_sha256 TEXT PRIMARY KEY CHECK(length(code_sha256)=64),
 state TEXT NOT NULL CHECK(state IN('processing','succeeded','failed')),
 shop_id TEXT REFERENCES installations(shop_id),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 completed_at INTEGER
);
CREATE TABLE tenant_capability_snapshots (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 verified INTEGER NOT NULL CHECK(verified IN(0,1)),
 capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
 checked_at INTEGER NOT NULL
);
CREATE TABLE installation_verification_jobs (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 oauth_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','running','succeeded','failed')),
 run_id TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER,
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
