CREATE TABLE sync_execution_plans (
 shop_id TEXT NOT NULL REFERENCES installations(shop_id),
 plan_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 settings_version INTEGER NOT NULL,
 plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
 sha256 TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(shop_id,plan_id),
 FOREIGN KEY(shop_id,revision_id) REFERENCES configuration_revisions(shop_id,revision_id)
);
CREATE TRIGGER sync_plan_immutable BEFORE UPDATE ON sync_execution_plans
BEGIN SELECT RAISE(ABORT,'immutable_sync_plan'); END;
CREATE TABLE sync_execution_approvals (
 shop_id TEXT NOT NULL,
 approval_id TEXT NOT NULL,
 plan_id TEXT NOT NULL,
 plan_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','approved','consumed')),
 expires_at INTEGER NOT NULL,
 approved_by TEXT,
 consumed_job_id TEXT,
 PRIMARY KEY(shop_id,approval_id),
 UNIQUE(shop_id,plan_id),
 FOREIGN KEY(shop_id,plan_id) REFERENCES sync_execution_plans(shop_id,plan_id)
);
CREATE TRIGGER sync_approval_immutable BEFORE UPDATE ON sync_execution_approvals
BEGIN
 SELECT CASE WHEN NEW.shop_id!=OLD.shop_id OR NEW.approval_id!=OLD.approval_id OR NEW.plan_id!=OLD.plan_id OR NEW.plan_sha256!=OLD.plan_sha256 OR NEW.expires_at!=OLD.expires_at THEN RAISE(ABORT,'immutable_sync_approval') END;
 SELECT CASE WHEN NOT ((OLD.state='pending' AND NEW.state='approved' AND NEW.approved_by IS NOT NULL AND NEW.consumed_job_id IS NULL) OR (OLD.state='approved' AND NEW.state='consumed' AND NEW.approved_by=OLD.approved_by AND NEW.consumed_job_id IS NOT NULL)) THEN RAISE(ABORT,'invalid_sync_approval_transition') END;
 SELECT CASE WHEN NEW.expires_at<=unixepoch() THEN RAISE(ABORT,'sync_approval_expired') END;
 SELECT CASE WHEN NEW.plan_sha256!=(SELECT sha256 FROM sync_execution_plans WHERE shop_id=NEW.shop_id AND plan_id=NEW.plan_id) THEN RAISE(ABORT,'sync_plan_hash_mismatch') END;
END;
ALTER TABLE sync_jobs ADD COLUMN plan_id TEXT;
ALTER TABLE sync_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'dry-run' CHECK(mode IN('dry-run','live'));
ALTER TABLE sync_jobs ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN checkpoint INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN verified_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN changed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN error_code TEXT;
ALTER TABLE sync_jobs ADD COLUMN updated_at INTEGER;
ALTER TABLE sync_jobs ADD COLUMN next_attempt_at INTEGER;
CREATE UNIQUE INDEX sync_jobs_tenant_id ON sync_jobs(shop_id,job_id);
CREATE TABLE sync_shop_fences (
 shop_id TEXT PRIMARY KEY REFERENCES installations(shop_id),
 epoch INTEGER NOT NULL DEFAULT 0,
 active_job_id TEXT
);
CREATE TABLE sync_job_items (
 shop_id TEXT NOT NULL,
 job_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','writing','verified','failed','uncertain')),
 attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 changed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(shop_id,job_id,sequence),
 FOREIGN KEY(shop_id,job_id) REFERENCES sync_jobs(shop_id,job_id)
);
