import crypto from 'node:crypto';
import {createTokenVault} from './token-vault.mjs';
import {digest} from './crypto.mjs';
import {
  getPricelistPolicy,
  evaluateCustomerLock,
  recordOrderToLedger,
  recordWebhookEvent
} from './loyalty-repository.mjs';

function moneyMinor(value) {
  if (typeof value !== 'string' || !/^-?\d+\.\d{2}$/.test(value)) return 0;
  return Number(BigInt(value.replace('.', '')));
}

export async function processOrderWebhook({
  db,
  tokenKeys,
  bytes,
  signature,
  adapter,
  policy,
  tiers,
  mode = 'live'
}) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{40}$/i.test(signature)) {
    throw new Error('invalid_signature');
  }

  let event;
  try {
    event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('invalid_event');
  }

  const shopId = String(event?.eshopId ?? '');
  if (!/^[1-9][0-9]{0,11}$/.test(shopId)) throw new Error('invalid_event');
  if (!['order:update', 'order:create'].includes(event?.event)) {
    return { accepted: true, ignored: true, reason: 'unsupported_event_type' };
  }
  const orderCode = String(event.eventInstance ?? '');
  if (!orderCode) throw new Error('invalid_event');

  // 1. Signature Verification with shop webhook credentials
  const record = await db.prepare('SELECT k.envelope, k.oauth_sha256, o.oauth_envelope FROM shop_webhook_credentials k JOIN shoptet_oauth o ON o.shop_id=k.shop_id WHERE k.shop_id=?').bind(shopId).first();
  if (!record || record.oauth_sha256 !== await digest(record.oauth_envelope)) {
    throw new Error('invalid_signature');
  }
  const secret = await createTokenVault(tokenKeys).open(shopId, 'webhook', record.envelope);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['verify']);
  const proof = Uint8Array.from(signature.match(/../g), s => parseInt(s, 16));
  if (!await crypto.subtle.verify('HMAC', key, proof, bytes)) {
    throw new Error('invalid_signature');
  }

  // 2. D1 Event Ledger deduplication
  const eventHash = await digest(new TextDecoder().decode(bytes));
  const webhookRecord = await recordWebhookEvent(db, shopId, {
    eventHash,
    eventType: event.event,
    orderCode,
    eventCreated: event.eventCreated || new Date().toISOString(),
    mode
  });

  if (webhookRecord.duplicate) {
    return { accepted: true, duplicate: true, eventHash };
  }

  if (mode === 'staging') {
    return { accepted: true, queuedForReconciliation: true, eventHash };
  }

  // 3. Fetch order detail from Shoptet REST API
  const order = await adapter.order(orderCode);
  if (!order.customerGuid) {
    await db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash).run();
    return { accepted: true, guestOrder: true, orderCode };
  }

  // 4. Calculate clean qualifying amount based on configured turnover policy
  const isQualifyingStatus = policy.qualifyingStatusIds.includes(order.status?.id);
  const isPaidQualifying = !policy.requirePaid || order.paid === true;
  const isOrderQualifying = isQualifyingStatus && isPaidQualifying;

  const field = policy.vat === 'inclusive' ? 'withVat' : 'withoutVat';
  let qualifyingMinor = isOrderQualifying ? moneyMinor(order.price[field]) : 0;
  if (isOrderQualifying && Array.isArray(order.items)) {
    for (const item of order.items) {
      if ((item.itemType === 'shipping' && policy.shipping === 'exclude') ||
          (item.itemType === 'billing' && policy.billing === 'exclude')) {
        qualifyingMinor -= moneyMinor(item.itemPrice[field]);
      }
    }
  }
  qualifyingMinor = Math.max(0, qualifyingMinor);

  // 5. Update D1 Order Ledger and customer summary
  const ledgerResult = await recordOrderToLedger(db, shopId, {
    orderCode,
    customerGuid: order.customerGuid,
    statusId: order.status?.id ?? -1,
    isPaid: order.paid === true,
    currency: order.price?.currencyCode ?? 'CZK',
    orderTotalMinor: moneyMinor(order.price[field]),
    qualifyingAmountMinor: qualifyingMinor,
    exclusionReason: !isOrderQualifying ? 'status_or_payment' : null,
    orderCreatedAt: order.creationTime,
    lastChangeTime: order.changeTime
  });

  // 6. Evaluate Customer Eligibility & Target Tier
  const customer = await adapter.customer(order.customerGuid);
  const pricelistPolicy = await getPricelistPolicy(db, shopId);
  const lockStatus = pricelistPolicy ? evaluateCustomerLock(customer, pricelistPolicy) : 'unlocked';

  if (lockStatus !== 'unlocked') {
    await db.prepare('UPDATE loyalty_customer_states SET lock_status = ? WHERE shop_id = ? AND customer_guid = ?').bind(lockStatus, shopId, order.customerGuid).run();
    await db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash).run();
    return { accepted: true, locked: true, lockStatus, orderCode };
  }

  const customerTurnover = BigInt(ledgerResult.customerTurnoverMinor ?? 0);
  const eligibleTier = tiers.filter(t => customerTurnover >= BigInt(t.minTurnover) * 100n).at(-1) ?? null;
  const currentPricelistId = customer.priceList?.id ?? null;
  const currentTier = tiers.find(t => t.pricelistId === currentPricelistId);
  const kept = !!(currentTier && policy.downgrades === 'keep_current' && (!eligibleTier || currentTier.minTurnover > eligibleTier.minTurnover));
  const selectedTier = kept ? currentTier : eligibleTier;

  const targetPricelistId = selectedTier?.pricelistId ?? (pricelistPolicy?.defaultPricelistId ?? currentPricelistId);

  // 7. Idempotent Customer Assignment & Readback Recovery
  if (currentPricelistId === targetPricelistId) {
    await db.prepare(`
      UPDATE loyalty_customer_states SET
        current_pricelist_id = ?,
        tier_name = ?,
        updated_at = unixepoch()
      WHERE shop_id = ? AND customer_guid = ?
    `).bind(targetPricelistId, selectedTier?.name ?? null, shopId, order.customerGuid).run();
    await db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash).run();
    return { accepted: true, changed: false, currentPricelistId, tier: selectedTier?.name ?? null };
  }

  // Planned change execution
  const patchResult = await adapter.updateCustomerPricelist(order.customerGuid, targetPricelistId);

  if (patchResult.outcome === 'accepted' && patchResult.verified) {
    await db.batch([
      db.prepare(`
        UPDATE loyalty_customer_states SET
          current_pricelist_id = ?,
          tier_name = ?,
          updated_at = unixepoch()
        WHERE shop_id = ? AND customer_guid = ?
      `).bind(targetPricelistId, selectedTier?.name ?? null, shopId, order.customerGuid),
      db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash)
    ]);
    return {
      accepted: true,
      changed: true,
      previousPricelistId: currentPricelistId,
      newPricelistId: targetPricelistId,
      tier: selectedTier?.name ?? null,
      verified: true
    };
  }

  // Outcome was unknown or failed -> perform readback recovery before failing
  const recoveryCustomer = await adapter.customer(order.customerGuid);
  if (recoveryCustomer.priceList?.id === targetPricelistId) {
    await db.batch([
      db.prepare(`
        UPDATE loyalty_customer_states SET
          current_pricelist_id = ?,
          tier_name = ?,
          updated_at = unixepoch()
        WHERE shop_id = ? AND customer_guid = ?
      `).bind(targetPricelistId, selectedTier?.name ?? null, shopId, order.customerGuid),
      db.prepare("UPDATE loyalty_webhook_events SET state='processed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash)
    ]);
    return {
      accepted: true,
      changed: true,
      newPricelistId: targetPricelistId,
      tier: selectedTier?.name ?? null,
      recoveredViaReadback: true
    };
  }

  await db.prepare("UPDATE loyalty_webhook_events SET state='failed' WHERE shop_id=? AND event_hash=?").bind(shopId, eventHash).run();
  return {
    accepted: false,
    error: patchResult.error ?? 'assignment_failed',
    customerGuid: order.customerGuid,
    targetPricelistId
  };
}
