-- Immutable, tenant-bound configuration proposals. No Shoptet writes.
CREATE TABLE configuration_revisions (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  revision_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK(base_version >= 0),
  base_json TEXT NOT NULL CHECK(json_valid(base_json)),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(shop_id, revision_id)
);
CREATE TRIGGER configuration_revision_immutable BEFORE UPDATE ON configuration_revisions
BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
CREATE TABLE configuration_approvals (
  shop_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action='save_configuration'),
  state TEXT NOT NULL CHECK(state IN ('pending','approved','consumed')),
  expires_at INTEGER NOT NULL,
  approved_by TEXT,
  PRIMARY KEY(shop_id,approval_id),
  UNIQUE(shop_id,revision_id),
  FOREIGN KEY(shop_id,revision_id) REFERENCES configuration_revisions(shop_id,revision_id)
);
CREATE TABLE configuration_history (
  shop_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  revision_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY(shop_id,version),
  FOREIGN KEY(shop_id,revision_id) REFERENCES configuration_revisions(shop_id,revision_id)
);
CREATE TRIGGER configuration_approval_guard BEFORE UPDATE ON configuration_approvals
BEGIN
 SELECT CASE WHEN NEW.shop_id!=OLD.shop_id OR NEW.approval_id!=OLD.approval_id OR NEW.revision_id!=OLD.revision_id OR NEW.action!=OLD.action OR NEW.expires_at!=OLD.expires_at THEN RAISE(ABORT,'immutable_approval') END;
 SELECT CASE WHEN NOT ((OLD.state='pending' AND NEW.state='approved' AND NEW.approved_by IS NOT NULL) OR (OLD.state='approved' AND NEW.state='consumed' AND NEW.approved_by=OLD.approved_by)) THEN RAISE(ABORT,'invalid_approval_transition') END;
 SELECT CASE WHEN NEW.expires_at<=unixepoch() THEN RAISE(ABORT,'approval_expired') END;
END;
-- The claim, version check, configuration update and history insert are ONE transaction.
CREATE TRIGGER configuration_apply AFTER UPDATE OF state ON configuration_approvals WHEN NEW.state='consumed'
BEGIN
 SELECT CASE WHEN COALESCE((SELECT version FROM tenant_settings WHERE shop_id=NEW.shop_id),0)!=(SELECT base_version FROM configuration_revisions WHERE shop_id=NEW.shop_id AND revision_id=NEW.revision_id) THEN RAISE(ABORT,'version_conflict') END;
 INSERT INTO tenant_settings(shop_id,config_json,version)
 SELECT shop_id,config_json,base_version+1 FROM configuration_revisions WHERE shop_id=NEW.shop_id AND revision_id=NEW.revision_id
 ON CONFLICT(shop_id) DO UPDATE SET config_json=excluded.config_json,version=excluded.version;
 INSERT INTO configuration_history(shop_id,version,revision_id,before_json,after_json,applied_at)
 SELECT shop_id,base_version+1,revision_id,base_json,config_json,unixepoch() FROM configuration_revisions WHERE shop_id=NEW.shop_id AND revision_id=NEW.revision_id;
END;
