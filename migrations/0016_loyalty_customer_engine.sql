-- Loyalty Customer Engine: Order ledger, customer states, pricelist policies, and checkpointing.
CREATE TABLE loyalty_pricelist_policies (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  default_pricelist_id INTEGER NOT NULL,
  managed_pricelists_json TEXT NOT NULL CHECK(json_valid(managed_pricelists_json)),
  protected_pricelists_json TEXT NOT NULL CHECK(json_valid(protected_pricelists_json)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id)
);

CREATE TABLE loyalty_customer_states (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  customer_guid TEXT NOT NULL,
  current_pricelist_id INTEGER,
  calculated_turnover_minor INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CZK',
  tier_name TEXT,
  lock_status TEXT NOT NULL DEFAULT 'unlocked' CHECK(lock_status IN('unlocked','b2b_locked','price_ratio_locked','group_locked')),
  qualifying_orders_count INTEGER NOT NULL DEFAULT 0,
  last_order_code TEXT,
  last_order_change_at TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id, customer_guid)
);
CREATE INDEX idx_customer_states_shop_guid ON loyalty_customer_states(shop_id, customer_guid);

CREATE TABLE loyalty_order_ledger (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  order_code TEXT NOT NULL,
  customer_guid TEXT NOT NULL,
  status_id INTEGER NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CZK',
  order_total_minor INTEGER NOT NULL,
  qualifying_amount_minor INTEGER NOT NULL,
  refunded_amount_minor INTEGER NOT NULL DEFAULT 0,
  contributed_turnover_minor INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  order_created_at TEXT NOT NULL,
  last_change_time TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id, order_code)
);
CREATE INDEX idx_loyalty_ledger_customer ON loyalty_order_ledger(shop_id, customer_guid);

CREATE TABLE loyalty_recalculation_plans (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  plan_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  plan_sha256 TEXT NOT NULL,
  total_customers INTEGER NOT NULL,
  changes_needed INTEGER NOT NULL,
  b2b_skipped INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN('draft','approved','consumed','cancelled')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id, plan_id)
);

CREATE TABLE loyalty_recalculation_items (
  shop_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  customer_guid TEXT NOT NULL,
  current_pricelist_id INTEGER,
  target_pricelist_id INTEGER,
  calculated_turnover_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN('pending','calculated','b2b_locked','no_change','ready_to_patch','patching','verified','uncertain','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id, plan_id, customer_guid),
  FOREIGN KEY(shop_id, plan_id) REFERENCES loyalty_recalculation_plans(shop_id, plan_id)
);
CREATE INDEX idx_loyalty_recalc_pending ON loyalty_recalculation_items(shop_id, plan_id, status);

CREATE TABLE loyalty_webhook_events (
  shop_id TEXT NOT NULL REFERENCES installations(shop_id),
  event_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_code TEXT NOT NULL,
  event_created TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN('staging','live')),
  state TEXT NOT NULL CHECK(state IN('queued_for_reconciliation','pending','processed','duplicate','ignored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(shop_id, event_hash)
);
CREATE INDEX idx_loyalty_webhook_queue ON loyalty_webhook_events(shop_id, state);
