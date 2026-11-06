import {z} from 'zod';
import {digest} from './crypto.mjs';

const positiveId = z.number().int().positive();
const uuidSchema = z.string().uuid();
const idList = z.array(positiveId).default([]);

export const pricelistPolicySchema = z.object({
  defaultPricelistId: positiveId,
  managedPricelistIds: idList,
  protectedPricelistIds: idList,
  engineMode: z.enum(['installation', 'dry_run_ready', 'approved', 'syncing', 'active']).default('installation')
}).strict().superRefine((data, ctx) => {
  const all = [data.defaultPricelistId, ...data.managedPricelistIds, ...data.protectedPricelistIds];
  if (new Set(all).size !== all.length) {
    ctx.addIssue({ code: 'custom', message: 'Pricelist IDs must be unique across default, managed and protected categories' });
  }
});

export function classifyPricelist(policy, pricelistId) {
  if (pricelistId === null || pricelistId === undefined) return 'default';
  if (pricelistId === policy.defaultPricelistId) return 'default';
  if (policy.managedPricelistIds.includes(pricelistId)) return 'managed';
  return 'protected'; // Fail-closed: unknown or protected is strictly protected
}

export function evaluateCustomerLock(customer, policy) {
  if (customer.priceRatio && customer.priceRatio !== '1.0000') {
    return 'price_ratio_locked';
  }
  const currentId = customer.priceList?.id ?? null;
  const classification = classifyPricelist(policy, currentId);
  if (classification === 'protected') {
    return 'b2b_locked';
  }
  return 'unlocked';
}

export async function savePricelistPolicy(db, shopId, policyData) {
  const p = pricelistPolicySchema.parse(policyData);
  await db.prepare(`
    INSERT INTO loyalty_pricelist_policies (shop_id, default_pricelist_id, managed_pricelists_json, protected_pricelists_json, engine_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(shop_id) DO UPDATE SET
      default_pricelist_id = excluded.default_pricelist_id,
      managed_pricelists_json = excluded.managed_pricelists_json,
      protected_pricelists_json = excluded.protected_pricelists_json,
      engine_mode = excluded.engine_mode,
      updated_at = unixepoch()
  `).bind(
    shopId,
    p.defaultPricelistId,
    JSON.stringify(p.managedPricelistIds),
    JSON.stringify(p.protectedPricelistIds),
    p.engineMode
  ).run();
  return p;
}

export async function getPricelistPolicy(db, shopId) {
  const row = await db.prepare('SELECT default_pricelist_id, managed_pricelists_json, protected_pricelists_json, engine_mode FROM loyalty_pricelist_policies WHERE shop_id = ?').bind(shopId).first();
  if (!row) return null;
  return {
    defaultPricelistId: row.default_pricelist_id,
    managedPricelistIds: JSON.parse(row.managed_pricelists_json),
    protectedPricelistIds: JSON.parse(row.protected_pricelists_json),
    engineMode: row.engine_mode || 'installation'
  };
}

export async function recordOrderToLedger(db, shopId, order) {
  const existing = await db.prepare('SELECT last_change_time, contributed_turnover_minor FROM loyalty_order_ledger WHERE shop_id = ? AND order_code = ?').bind(shopId, order.orderCode).first();
  if (existing) {
    const existingTime = Date.parse(existing.last_change_time);
    const incomingTime = Date.parse(order.lastChangeTime);
    if (Number.isFinite(existingTime) && Number.isFinite(incomingTime) && incomingTime <= existingTime) {
      return { applied: false, reason: 'stale_or_duplicate', contributedTurnoverMinor: existing.contributed_turnover_minor };
    }
  }

  const isPaid = order.isPaid ? 1 : 0;
  const qualifyingMinor = order.qualifyingAmountMinor ?? 0;
  const refundedMinor = order.refundedAmountMinor ?? 0;
  const contributedMinor = Math.max(0, qualifyingMinor - refundedMinor);

  await db.batch([
    db.prepare(`
      INSERT INTO loyalty_order_ledger (
        shop_id, order_code, customer_guid, status_id, is_paid, currency,
        order_total_minor, qualifying_amount_minor, refunded_amount_minor, contributed_turnover_minor,
        exclusion_reason, order_created_at, last_change_time, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(shop_id, order_code) DO UPDATE SET
        customer_guid = excluded.customer_guid,
        status_id = excluded.status_id,
        is_paid = excluded.is_paid,
        currency = excluded.currency,
        order_total_minor = excluded.order_total_minor,
        qualifying_amount_minor = excluded.qualifying_amount_minor,
        refunded_amount_minor = excluded.refunded_amount_minor,
        contributed_turnover_minor = excluded.contributed_turnover_minor,
        exclusion_reason = excluded.exclusion_reason,
        last_change_time = excluded.last_change_time,
        updated_at = unixepoch()
    `).bind(
      shopId,
      order.orderCode,
      order.customerGuid,
      order.statusId,
      isPaid,
      order.currency ?? 'CZK',
      order.orderTotalMinor ?? 0,
      qualifyingMinor,
      refundedMinor,
      contributedMinor,
      order.exclusionReason ?? null,
      order.orderCreatedAt,
      order.lastChangeTime
    ),
    // Atomically recalculate customer turnover summary
    db.prepare(`
      INSERT INTO loyalty_customer_states (
        shop_id, customer_guid, calculated_turnover_minor, currency, qualifying_orders_count,
        last_order_code, last_order_change_at, updated_at
      )
      SELECT
        ?,
        ?,
        COALESCE(SUM(contributed_turnover_minor), 0),
        ?,
        COALESCE(COUNT(CASE WHEN contributed_turnover_minor > 0 THEN 1 END), 0),
        ?,
        ?,
        unixepoch()
      FROM loyalty_order_ledger
      WHERE shop_id = ? AND customer_guid = ?
      ON CONFLICT(shop_id, customer_guid) DO UPDATE SET
        calculated_turnover_minor = (SELECT COALESCE(SUM(contributed_turnover_minor), 0) FROM loyalty_order_ledger WHERE shop_id = excluded.shop_id AND customer_guid = excluded.customer_guid),
        qualifying_orders_count = (SELECT COALESCE(COUNT(CASE WHEN contributed_turnover_minor > 0 THEN 1 END), 0) FROM loyalty_order_ledger WHERE shop_id = excluded.shop_id AND customer_guid = excluded.customer_guid),
        last_order_code = excluded.last_order_code,
        last_order_change_at = excluded.last_order_change_at,
        updated_at = unixepoch()
    `).bind(
      shopId,
      order.customerGuid,
      order.currency ?? 'CZK',
      order.orderCode,
      order.lastChangeTime,
      shopId,
      order.customerGuid
    )
  ]);

  const summary = await db.prepare('SELECT calculated_turnover_minor, qualifying_orders_count FROM loyalty_customer_states WHERE shop_id = ? AND customer_guid = ?').bind(shopId, order.customerGuid).first();

  return {
    applied: true,
    orderCode: order.orderCode,
    contributedTurnoverMinor: contributedMinor,
    customerTurnoverMinor: summary?.calculated_turnover_minor ?? 0,
    qualifyingOrdersCount: summary?.qualifying_orders_count ?? 0
  };
}

export async function recordRefundToLedger(db, shopId, { orderCode, refundedAmountMinor, changeTime }) {
  const order = await db.prepare('SELECT qualifying_amount_minor, refunded_amount_minor, customer_guid, currency, last_change_time FROM loyalty_order_ledger WHERE shop_id = ? AND order_code = ?').bind(shopId, orderCode).first();
  if (!order) {
    return { applied: false, reason: 'order_not_found' };
  }

  const newRefunded = Math.min(order.qualifying_amount_minor, order.refunded_amount_minor + refundedAmountMinor);
  const newContributed = Math.max(0, order.qualifying_amount_minor - newRefunded);
  const exclusionReason = newContributed === 0 ? 'fully_refunded' : null;

  await db.batch([
    db.prepare(`
      UPDATE loyalty_order_ledger SET
        refunded_amount_minor = ?,
        contributed_turnover_minor = ?,
        exclusion_reason = COALESCE(?, exclusion_reason),
        last_change_time = ?,
        updated_at = unixepoch()
      WHERE shop_id = ? AND order_code = ?
    `).bind(newRefunded, newContributed, exclusionReason, changeTime, shopId, orderCode),
    db.prepare(`
      UPDATE loyalty_customer_states SET
        calculated_turnover_minor = (SELECT COALESCE(SUM(contributed_turnover_minor), 0) FROM loyalty_order_ledger WHERE shop_id = ? AND customer_guid = ?),
        qualifying_orders_count = (SELECT COALESCE(COUNT(CASE WHEN contributed_turnover_minor > 0 THEN 1 END), 0) FROM loyalty_order_ledger WHERE shop_id = ? AND customer_guid = ?),
        updated_at = unixepoch()
      WHERE shop_id = ? AND customer_guid = ?
    `).bind(shopId, order.customer_guid, shopId, order.customer_guid, shopId, order.customer_guid)
  ]);

  const summary = await db.prepare('SELECT calculated_turnover_minor, qualifying_orders_count FROM loyalty_customer_states WHERE shop_id = ? AND customer_guid = ?').bind(shopId, order.customer_guid).first();

  return {
    applied: true,
    orderCode,
    customerGuid: order.customer_guid,
    refundedAmountMinor: newRefunded,
    contributedTurnoverMinor: newContributed,
    customerTurnoverMinor: summary?.calculated_turnover_minor ?? 0,
    qualifyingOrdersCount: summary?.qualifying_orders_count ?? 0
  };
}

export async function createRecalculationPlan(db, shopId, {
  planId,
  revisionId,
  planJson,
  planSha256,
  items,
  totalCustomers,
  changesNeeded,
  b2bSkipped,
  expiresAt
}) {
  const statements = [
    db.prepare(`
      INSERT INTO loyalty_recalculation_plans (
        shop_id, plan_id, revision_id, plan_json, plan_sha256,
        total_customers, changes_needed, b2b_skipped, state, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, unixepoch())
    `).bind(shopId, planId, revisionId, planJson, planSha256, totalCustomers, changesNeeded, b2bSkipped, expiresAt)
  ];

  for (const item of items) {
    statements.push(
      db.prepare(`
        INSERT INTO loyalty_recalculation_items (
          shop_id, plan_id, customer_guid, customer_name, customer_email, current_pricelist_id, target_pricelist_id,
          calculated_turnover_minor, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).bind(
        shopId,
        planId,
        item.customerGuid,
        item.customerName ?? null,
        item.customerEmail ?? null,
        item.currentPricelistId ?? null,
        item.targetPricelistId ?? null,
        item.calculatedTurnoverMinor ?? 0,
        item.status
      )
    );
  }

  await db.batch(statements);
  return { planId, shopId, totalCustomers, changesNeeded, b2bSkipped };
}

export async function getEngineMode(db, shopId) {
  const row = await db.prepare('SELECT engine_mode FROM loyalty_pricelist_policies WHERE shop_id = ?').bind(shopId).first();
  return row?.engine_mode || 'installation';
}

export async function setEngineMode(db, shopId, mode) {
  if (!['installation', 'dry_run_ready', 'approved', 'syncing', 'active'].includes(mode)) {
    throw new Error('invalid_engine_mode');
  }
  await db.prepare('UPDATE loyalty_pricelist_policies SET engine_mode = ?, updated_at = unixepoch() WHERE shop_id = ?').bind(mode, shopId).run();
  return { shopId, engineMode: mode };
}

export async function getLatestRecalculationPlan(db, shopId) {
  return await db.prepare(`
    SELECT plan_id, revision_id, plan_sha256, total_customers, changes_needed, b2b_skipped, state, expires_at, created_at
    FROM loyalty_recalculation_plans
    WHERE shop_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(shopId).first();
}

export async function getRecalculationPlanDetails(db, shopId, planId) {
  const plan = await db.prepare(`
    SELECT plan_id, revision_id, plan_sha256, total_customers, changes_needed, b2b_skipped, state, expires_at, created_at, plan_json
    FROM loyalty_recalculation_plans
    WHERE shop_id = ? AND plan_id = ?
  `).bind(shopId, planId).first();
  if (!plan) return null;

  const items = (await db.prepare(`
    SELECT customer_guid, customer_name, customer_email, current_pricelist_id, target_pricelist_id, calculated_turnover_minor, status, error_code, updated_at
    FROM loyalty_recalculation_items
    WHERE shop_id = ? AND plan_id = ?
    ORDER BY CASE status
      WHEN 'ready_to_patch' THEN 1
      WHEN 'patching' THEN 2
      WHEN 'verified' THEN 3
      WHEN 'failed' THEN 4
      WHEN 'b2b_locked' THEN 5
      ELSE 6 END, calculated_turnover_minor DESC
    LIMIT 200
  `).bind(shopId, planId).all()).results;

  return { plan, items };
}

export async function approveRecalculationPlan(db, shopId, planId) {
  const plan = await db.prepare('SELECT state, plan_json, revision_id, expires_at FROM loyalty_recalculation_plans WHERE shop_id = ? AND plan_id = ?').bind(shopId, planId).first();
  if (!plan) throw new Error('plan_not_found');
  if (plan.state !== 'draft') throw new Error('plan_already_processed');
  if (plan.expires_at < Math.floor(Date.now() / 1000)) throw new Error('plan_expired');

  // Verify plan is not stale against active configuration
  const currentSettings = await db.prepare('SELECT version, config_json FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
  const currentVersion = currentSettings?.version ?? 0;
  let planMeta = {};
  try { planMeta = JSON.parse(plan.plan_json); } catch {}
  if (planMeta.configVersion !== undefined && planMeta.configVersion !== currentVersion) {
    throw new Error('plan_stale_configuration_changed');
  }
  if (planMeta.configSha256 && currentSettings?.config_json) {
    const currentSha256 = await digest(currentSettings.config_json);
    if (planMeta.configSha256 !== currentSha256) {
      throw new Error('plan_stale_configuration_changed');
    }
  }

  await db.batch([
    db.prepare("UPDATE loyalty_recalculation_plans SET state = 'approved' WHERE shop_id = ? AND plan_id = ?").bind(shopId, planId),
    db.prepare("UPDATE loyalty_pricelist_policies SET engine_mode = 'approved', updated_at = unixepoch() WHERE shop_id = ?").bind(shopId)
  ]);
  return { planId, state: 'approved' };
}

export async function getPendingRecalculationItems(db, shopId, planId, limit = 50) {
  const result = await db.prepare(`
    SELECT customer_guid, current_pricelist_id, target_pricelist_id, calculated_turnover_minor, status, attempts
    FROM loyalty_recalculation_items
    WHERE shop_id = ? AND plan_id = ? AND status IN ('ready_to_patch', 'uncertain')
    ORDER BY customer_guid ASC
    LIMIT ?
  `).bind(shopId, planId, limit).all();
  return result.results;
}

export async function updateRecalculationItemStatus(db, shopId, planId, customerGuid, {
  status,
  attempts = 1,
  errorCode = null
}) {
  await db.prepare(`
    UPDATE loyalty_recalculation_items SET
      status = ?,
      attempts = attempts + ?,
      error_code = ?,
      updated_at = unixepoch()
    WHERE shop_id = ? AND plan_id = ? AND customer_guid = ?
  `).bind(status, attempts, errorCode, shopId, planId, customerGuid).run();
}

export async function recordWebhookEvent(db, shopId, {
  eventHash,
  eventType,
  orderCode,
  eventCreated,
  mode = 'staging'
}) {
  const existing = await db.prepare('SELECT event_hash, state FROM loyalty_webhook_events WHERE shop_id = ? AND event_hash = ?').bind(shopId, eventHash).first();
  if (existing) {
    // Failed deliveries can be retried; abandoned pending work may be reclaimed
    // after a conservative lease. Claiming is conditional, preventing two workers
    // from concurrently processing the same event hash.
    if (mode === 'live' && (existing.state === 'failed' || existing.state === 'pending')) {
      const claimed = await db.prepare(`
        UPDATE loyalty_webhook_events
        SET state='pending', attempts=attempts+1, received_at=unixepoch()
        WHERE shop_id=? AND event_hash=?
          AND (state='failed' OR (state='pending' AND received_at < unixepoch()-300))
        RETURNING event_hash
      `).bind(shopId, eventHash).first();
      if (claimed) return { duplicate: false, resumed: true, eventHash, state: 'pending' };
    }
    return { duplicate: true, eventHash, state: existing.state };
  }

  const initialStatus = mode === 'staging' ? 'queued_for_reconciliation' : 'pending';
  await db.prepare(`
    INSERT INTO loyalty_webhook_events (
      shop_id, event_hash, event_type, order_code, event_created, mode, state, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
  `).bind(shopId, eventHash, eventType, orderCode, eventCreated, mode, initialStatus).run();

  return { duplicate: false, eventHash, state: initialStatus };
}

export async function getQueuedWebhookReconciliationEvents(db, shopId, limit = 100) {
  const result = await db.prepare(`
    SELECT event_hash, event_type, order_code, event_created, attempts
    FROM loyalty_webhook_events
    WHERE shop_id = ? AND state = 'queued_for_reconciliation'
    ORDER BY event_created ASC
    LIMIT ?
  `).bind(shopId, limit).all();
  return result.results;
}
