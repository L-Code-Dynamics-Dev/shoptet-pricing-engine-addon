const API_BASE = 'https://api.myshoptet.com';
const API_TOKEN = process.env.SHOPTET_API_TOKEN || '';
const CUSTOMER_GUID = process.env.SHOPTET_TEST_CUSTOMER_GUID || '1f676f66-d9ea-11f1-a35a-bc241195dd28';
const WORKER_WEBHOOK_URL = process.env.WORKER_WEBHOOK_URL || 'https://lcode-shoptet-pricing-dev.hlancaric.workers.dev/shoptet/webhook';

let apiCallsCount = 0;
const MAX_API_BUDGET = 25;

async function apiRequest(path, options = {}) {
  if (apiCallsCount >= MAX_API_BUDGET) {
    throw new Error(`API budget exceeded! Reached ${apiCallsCount} calls.`);
  }

  // Pacing: 1000ms delay before each request
  await new Promise(r => setTimeout(r, 1000));
  apiCallsCount++;

  const url = `${API_BASE}${path}`;
  const headers = {
    'Shoptet-Access-Token': API_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  console.log(`[API #${apiCallsCount}] ${options.method || 'GET'} ${path} -> Status: ${response.status}`);
  return { status: response.status, ok: response.ok, data: json?.data, errors: json?.errors, raw: text };
}

async function run() {
  console.log('--- STARTING CONTROLLED LIVE INTEGRATION TEST (VARIANT A) ---');
  let webhookId = null;
  let orderCode = null;
  let initialPricelistId = null;

  try {
    // 1. Initial Customer Snapshot
    console.log('\n[Step 1] Fetching customer snapshot...');
    const custRes1 = await apiRequest(`/api/customers/${CUSTOMER_GUID}`);
    if (!custRes1.ok || !custRes1.data?.customer) {
      throw new Error(`Failed to fetch customer: ${custRes1.raw}`);
    }
    initialPricelistId = custRes1.data.customer.priceList?.id;
    console.log(`Initial Customer: ${custRes1.data.customer.billingAddress?.fullName}, Pricelist ID: ${initialPricelistId} (${custRes1.data.customer.priceList?.name})`);

    // Ensure customer is on Pricelist 1 ("Hlavní ceník") so we can test promotion to 2 ("VIP")
    if (initialPricelistId !== 1) {
      console.log('Setting customer to baseline Pricelist 1...');
      const patchCust = await apiRequest(`/api/customers/${CUSTOMER_GUID}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            pricelistId: 1
          }
        })
      });
      if (!patchCust.ok) throw new Error(`Failed to reset customer pricelist: ${patchCust.raw}`);

      const verifyCust = await apiRequest(`/api/customers/${CUSTOMER_GUID}`);
      console.log(`Baseline verified. Customer now on Pricelist ID: ${verifyCust.data.customer.priceList?.id}`);
    }

    // 2. Register Webhook
    console.log('\n[Step 2] Registering webhook order:update...');
    const webhookRes = await apiRequest('/api/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        data: [
          {
            event: 'order:update',
            url: WORKER_WEBHOOK_URL
          }
        ]
      })
    });

    if (!webhookRes.ok || !webhookRes.data?.webhooks?.[0]?.id) {
      throw new Error(`Failed to register webhook: ${webhookRes.raw}`);
    }
    webhookId = webhookRes.data.webhooks[0].id;
    console.log(`Webhook registered successfully. ID: ${webhookId}`);

    // 3. Create Test Order with non-stock movements suppressed
    console.log('\n[Step 3] Creating isolated test order...');
    const externalCode = 'TEST-VIP-' + Date.now();
    const createOrderRes = await apiRequest('/api/orders?suppressEmailSending=true&suppressDocumentGeneration=true&suppressStockMovements=true', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          email: 'vip-shopper@example.com',
          phone: '+420777888999',
          externalCode,
          billingAddress: {
            fullName: 'VIP Zakaznik',
            street: 'Testovaci 10',
            city: 'Praha',
            zip: '11000',
            countryCode: 'CZ'
          },
          currency: {
            code: 'CZK'
          },
          items: [
            {
              itemType: 'product',
              code: '0001',
              name: 'Unisex hodinky Nature',
              amount: '7.000',
              vatRate: '0.00',
              itemPriceWithVat: '5600.00'
            }
          ]
        }
      })
    });

    if (!createOrderRes.ok || !createOrderRes.data?.order?.code) {
      throw new Error(`Failed to create test order: ${createOrderRes.raw}`);
    }
    orderCode = createOrderRes.data.order.code;
    console.log(`Test order created successfully! Code: ${orderCode}, ExternalCode: ${externalCode}`);

    // 4. Transition Order Status to -3 (Vyřízená)
    console.log(`\n[Step 4] Updating order ${orderCode} status to -3 (Vyřízená)...`);
    const statusUpdateRes = await apiRequest(`/api/orders/${orderCode}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          statusId: -3
        }
      })
    });

    if (!statusUpdateRes.ok) {
      throw new Error(`Failed to update order status: ${statusUpdateRes.raw}`);
    }
    console.log('Order transitioned to status -3 (Vyřízená). Webhook fired.');

    // 5. Wait for Webhook Processing
    console.log('\n[Step 5] Waiting 7 seconds for webhook delivery & worker execution...');
    await new Promise(r => setTimeout(r, 7000));

    // 6. Readback Customer State to verify promotion
    console.log('\n[Step 6] Verifying customer state readback...');
    const verifyPromoRes = await apiRequest(`/api/customers/${CUSTOMER_GUID}`);
    const finalPricelistId = verifyPromoRes.data?.customer?.priceList?.id;
    const finalPricelistName = verifyPromoRes.data?.customer?.priceList?.name;
    console.log(`Customer after webhook: Pricelist ID = ${finalPricelistId} (${finalPricelistName})`);

    const promotionSuccess = finalPricelistId === 2;
    console.log(`PROMOTION RESULT: ${promotionSuccess ? 'SUCCESS (Promoted to Pricelist 2)' : 'FAILED'}`);

    return {
      success: promotionSuccess,
      orderCode,
      webhookId,
      initialPricelistId,
      finalPricelistId,
      apiCallsCount
    };
  } finally {
    // 7. Controlled Clean Rollback
    console.log('\n--- CLEAN ROLLBACK SEQUENCE ---');
    if (orderCode) {
      console.log(`[Rollback 1] Transitioning order ${orderCode} to -4 (Stornována)...`);
      try {
        await apiRequest(`/api/orders/${orderCode}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ data: { statusId: -4 } })
        });
      } catch (err) {
        console.warn('Warning: Could not cancel order:', err.message);
      }

      console.log(`[Rollback 2] Deleting order ${orderCode}...`);
      try {
        const delOrderRes = await apiRequest(`/api/orders/${orderCode}`, {
          method: 'DELETE'
        });
        console.log(`Order delete response status: ${delOrderRes.status}`);
      } catch (err) {
        console.warn('Warning: Could not delete order:', err.message);
      }
    }

    if (webhookId) {
      console.log(`[Rollback 3] Deleting webhook ${webhookId}...`);
      try {
        const delWebhookRes = await apiRequest(`/api/webhooks/${webhookId}`, {
          method: 'DELETE'
        });
        console.log(`Webhook delete response status: ${delWebhookRes.status}`);
      } catch (err) {
        console.warn('Warning: Could not delete webhook:', err.message);
      }
    }

    // Restore customer to desired VIP state (Ceník 2) as configured originally
    console.log('[Rollback 4] Restoring customer to target VIP Pricelist 2...');
    try {
      await apiRequest(`/api/customers/${CUSTOMER_GUID}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { pricelistId: 2 } })
      });
      console.log('Customer state restored cleanly.');
    } catch (err) {
      console.warn('Warning: Could not restore customer pricelist:', err.message);
    }

    console.log(`\nTOTAL API CALLS USED: ${apiCallsCount} / ${MAX_API_BUDGET}`);
  }
}

run().then(res => {
  console.log('\n=== TEST FINISHED ===');
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.success ? 0 : 1);
}).catch(err => {
  console.error('\n=== TEST TERMINATED WITH ERROR ===', err);
  process.exit(1);
});
