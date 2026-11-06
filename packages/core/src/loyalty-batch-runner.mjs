import crypto from 'node:crypto';
import {digest} from './crypto.mjs';
import {calculateTurnover} from './turnover.mjs';
import {
  getPricelistPolicy,
  evaluateCustomerLock,
  createRecalculationPlan,
  getPendingRecalculationItems,
  updateRecalculationItemStatus,
  getQueuedWebhookReconciliationEvents,
  setEngineMode,
  getEngineMode
} from './loyalty-repository.mjs';

export async function generateCustomerRecalculationPlan({
  db,
  shopId,
  adapter,
  policy,
  tiers,
  revisionId = 'initial-recalculation',
  rateLimiter = null
}) {
  const pricelistPolicy = await getPricelistPolicy(db, shopId);
  if (!pricelistPolicy) throw new Error('pricelist_policy_required');
  const currencyRow = await db.prepare('SELECT config_json FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
  let configuredCurrency = null;
  if (currencyRow?.config_json) {
    const settings = JSON.parse(currencyRow.config_json);
    configuredCurrency = settings.loyaltyProposal?.currency ?? settings.currency ?? null;
    if (configuredCurrency !== null && !/^[A-Z]{3}$/.test(configuredCurrency)) {
      throw new Error('turnover_currency_invalid');
    }
  }
  let planCurrency = configuredCurrency;

  // 0. Prefetch store credit notes across all pages
  const allCreditNotes = [];
  if (typeof adapter.creditNotes === 'function' && typeof adapter.creditNote === 'function') {
    for (let cnPage = 1; ; cnPage++) {
      if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
      const cnRes = await adapter.creditNotes({ page: cnPage });
      const batch = cnRes.items || [];
      if (!batch.length) break;
      for (const cn of batch) {
        if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
        const detail = await adapter.creditNote(cn.code);
        allCreditNotes.push(detail);
      }
      if (cnRes.pagination) {
        if (cnPage >= (cnRes.pagination.pageCount || 1)) break;
      } else if (batch.length < 50) {
        break;
      }
    }
  }

  const items = [];
  let totalCustomers = 0;
  let changesNeeded = 0;
  let b2bSkipped = 0;
  let priceRatioSkipped = 0;
  let noChangeCount = 0;

  // 1. Paginate through all customers
  for (let page = 1; ; page++) {
    if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
    const result = await adapter.list('customers', { page, limit: 50 });
    const batch = result.items || [];
    if (!batch.length) break;

    for (const entry of batch) {
      totalCustomers++;
      let customer = entry;
      if (customer.priceList === undefined && typeof adapter.customer === 'function') {
        if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
        customer = await adapter.customer(entry.guid);
      }
      const customerName = customer.billingAddress?.fullName || customer.billFullName || customer.name || 'Zákazník';
      const customerEmail = customer.accounts?.[0]?.email || customer.email || '';
      const currentPricelistId = customer.priceList?.id ?? null;
      const lockStatus = evaluateCustomerLock(customer, pricelistPolicy);

      if (lockStatus === 'b2b_locked') {
        b2bSkipped++;
        items.push({
          customerGuid: customer.guid,
          customerName,
          customerEmail,
          currentPricelistId,
          targetPricelistId: currentPricelistId,
          calculatedTurnoverMinor: 0,
          status: 'b2b_locked'
        });
        continue;
      }

      if (lockStatus === 'price_ratio_locked') {
        priceRatioSkipped++;
        items.push({
          customerGuid: customer.guid,
          customerName,
          customerEmail,
          currentPricelistId,
          targetPricelistId: currentPricelistId,
          calculatedTurnoverMinor: 0,
          status: 'b2b_locked'
        });
        continue;
      }

      // Fetch customer orders across all pages
      const orderList = [];
      const orderCodes = new Set();
      for (let orderPage = 1; ; orderPage++) {
        if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
        const ordersRes = await adapter.customerOrders(customer.guid, {
          from: policy.period.from,
          to: policy.period.to,
          page: orderPage
        });
        const batch = ordersRes.items || [];
        if (!batch.length) break;
        for (const o of batch) {
          if (rateLimiter) await rateLimiter.waitBeforeNextRequest();
          const detail = await adapter.order(o.code);
          orderList.push(detail);
          orderCodes.add(detail.code);
        }
        if (ordersRes.pagination) {
          if (orderPage >= (ordersRes.pagination.pageCount || 1)) break;
        } else if (batch.length < 50) {
          break;
        }
      }

      // Filter relevant credit notes for this customer or their orders
      const relevantCreditNotes = allCreditNotes.filter(
        cn => cn.customer?.guid === customer.guid || orderCodes.has(cn.orderCode)
      );

      // Never silently value EUR orders as CZK. Without a configured base
      // currency, a single unambiguous order currency is required across the plan.
      const orderCurrencies = new Set(orderList.map(order => order.price.currencyCode));
      if (planCurrency === null) {
        if (orderCurrencies.size !== 1) throw new Error('turnover_currency_not_configured');
        planCurrency = [...orderCurrencies][0];
      }
      const turnoverResult = calculateTurnover({
        customerGuid: customer.guid,
        currency: planCurrency,
        tiers,
        policy,
        orders: orderList,
        creditNotes: relevantCreditNotes,
        currentPricelistId
      });

      const turnoverValue = BigInt(turnoverResult.turnover.replace('.', ''));
      if (turnoverValue > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('turnover_overflow');
      const turnoverMinor = Number(turnoverValue);
      const targetPricelistId = turnoverResult.pricelistId ?? pricelistPolicy.defaultPricelistId;

      if (currentPricelistId === targetPricelistId) {
        noChangeCount++;
        items.push({
          customerGuid: customer.guid,
          customerName,
          customerEmail,
          currentPricelistId,
          targetPricelistId,
          calculatedTurnoverMinor: turnoverMinor,
          status: 'no_change'
        });
      } else {
        changesNeeded++;
        items.push({
          customerGuid: customer.guid,
          customerName,
          customerEmail,
          currentPricelistId,
          targetPricelistId,
          calculatedTurnoverMinor: turnoverMinor,
          status: 'ready_to_patch'
        });
      }
    }

    if (result.pagination) {
      if (page >= (result.pagination.pageCount || 1)) break;
    } else if (batch.length < 50) {
      break;
    }
  }

  const settingsRow = await db.prepare('SELECT version, config_json FROM tenant_settings WHERE shop_id = ?').bind(shopId).first();
  const configVersion = settingsRow?.version ?? 0;
  const configSha256 = settingsRow?.config_json ? await digest(settingsRow.config_json) : '';

  const planId = 'plan-' + crypto.randomUUID();
  const planJson = JSON.stringify({
    shopId,
    revisionId,
    configVersion,
    configSha256,
    totalCustomers,
    changesNeeded,
    b2bSkipped,
    priceRatioSkipped,
    noChangeCount,
    policy,
    tiers,
    items
  });
  const planSha256 = await digest(planJson);

  await createRecalculationPlan(db, shopId, {
    planId,
    revisionId,
    planJson,
    planSha256,
    items,
    totalCustomers,
    changesNeeded,
    b2bSkipped: b2bSkipped + priceRatioSkipped,
    expiresAt: Math.floor(Date.now() / 1000) + 86400
  });

  await setEngineMode(db, shopId, 'dry_run_ready');

  return {
    planId,
    planSha256,
    totalCustomers,
    changesNeeded,
    b2bSkipped,
    priceRatioSkipped,
    noChangeCount,
    state: 'draft'
  };
}

export async function executeCustomerRecalculationBatch({
  db,
  shopId,
  planId,
  adapter,
  rateLimiter = null,
  batchSize = 25
}) {
  const plan = await db.prepare('SELECT state FROM loyalty_recalculation_plans WHERE shop_id = ? AND plan_id = ?').bind(shopId, planId).first();
  if (!plan) throw new Error('plan_not_found');
  if (plan.state !== 'approved') throw new Error('plan_not_approved');

  await setEngineMode(db, shopId, 'syncing');

  const pending = await getPendingRecalculationItems(db, shopId, planId, batchSize);
  let completedInThisBatch = 0;

  for (const item of pending) {
    if (rateLimiter) await rateLimiter.waitBeforeNextRequest();

    // Reconcile before retrying an uncertain external write. A concurrent
    // merchant edit must never be overwritten by a stale recalculation plan.
    const beforeWrite = await adapter.customer(item.customer_guid);
    const actualPricelistId = beforeWrite.priceList?.id ?? null;
    if (beforeWrite.priceRatio !== '1.0000' ||
        (actualPricelistId !== (item.current_pricelist_id ?? null) &&
         actualPricelistId !== item.target_pricelist_id)) {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, {
        status: 'failed',
        errorCode: 'customer_pricelist_changed_since_plan'
      });
      continue;
    }
    if (actualPricelistId === item.target_pricelist_id) {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, { status: 'verified' });
      completedInThisBatch++;
      continue;
    }

    const patchResult = await adapter.updateCustomerPricelist(item.customer_guid, item.target_pricelist_id);
    if (rateLimiter) rateLimiter.observeResponse(patchResult);

    if (patchResult.outcome === 'accepted' && patchResult.verified) {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, { status: 'verified' });
      await db.prepare(`
        INSERT INTO loyalty_customer_states (shop_id, customer_guid, current_pricelist_id, calculated_turnover_minor, updated_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(shop_id, customer_guid) DO UPDATE SET
          current_pricelist_id = excluded.current_pricelist_id,
          calculated_turnover_minor = excluded.calculated_turnover_minor,
          updated_at = unixepoch()
      `).bind(shopId, item.customer_guid, item.target_pricelist_id, item.calculated_turnover_minor).run();
      completedInThisBatch++;
      continue;
    }

    if (patchResult.outcome === 'no_change') {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, { status: 'verified' });
      completedInThisBatch++;
      continue;
    }

    // Readback recovery on unknown outcome or failure
    const check = await adapter.customer(item.customer_guid);
    if (check.priceList?.id === item.target_pricelist_id) {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, { status: 'verified' });
      completedInThisBatch++;
    } else {
      await updateRecalculationItemStatus(db, shopId, planId, item.customer_guid, {
        status: patchResult.outcome === 'unknown' ? 'uncertain' : 'failed',
        errorCode: patchResult.error ?? 'assignment_failed'
      });
    }
  }

  // Check remaining items
  const remaining = await getPendingRecalculationItems(db, shopId, planId, 1);
  let reconciledCount = 0;

  if (remaining.length === 0) {
    // Process queued reconciliation webhook events
    const queuedEvents = await getQueuedWebhookReconciliationEvents(db, shopId);
    for (const ev of queuedEvents) {
      await db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, ev.event_hash).run();
      reconciledCount++;
    }
    await db.prepare("UPDATE loyalty_recalculation_plans SET state='consumed' WHERE shop_id=? AND plan_id=?").bind(shopId, planId).run();
    await setEngineMode(db, shopId, 'active');
  }

  return {
    completedInThisBatch,
    remainingCount: remaining.length,
    planCompleted: remaining.length === 0,
    reconciledCount
  };
}
