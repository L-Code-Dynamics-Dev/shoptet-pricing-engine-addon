-- Apply after 0001. Approvals are issued only by authenticated admin service.
CREATE TABLE IF NOT EXISTS asset_install_approvals (
  approval_id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  release_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('approved','claimed','revoked')),
  expires_at_ms INTEGER NOT NULL,
  claimed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  CHECK((state='claimed' AND claimed_at_ms IS NOT NULL) OR (state!='claimed' AND claimed_at_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_asset_approvals_shop ON asset_install_approvals(shop_id,state,expires_at_ms);
