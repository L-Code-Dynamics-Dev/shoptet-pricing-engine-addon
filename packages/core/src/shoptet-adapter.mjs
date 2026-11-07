import { z } from 'zod';
const REDIRECT_MODE = typeof WebSocketPair !== 'undefined' ? 'manual' : 'error';
// Fixed-origin read adapter. Callers cannot provide URLs, HTTP methods or credentials.
export class ShoptetError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const collections = { brands: 'brands', products: 'products', categories: 'categories', pricelists: 'pricelists', customers: 'customers' };
export function createShoptetAdapter({ getToken, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 10000, authorizeWrite = null }) {
  async function read(path, params = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await getToken();
      const url = new URL(path, 'https://api.myshoptet.com');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      let res;
      try { res = await fetchImpl(url.href, { redirect: REDIRECT_MODE, signal: AbortSignal.timeout(timeoutMs), headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' } }); }
      catch { throw new ShoptetError('upstream_unavailable'); }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retryHeader = res.headers.get('retry-after');
        const retry = retryHeader === null ? NaN : Number(retryHeader);
        await sleep(Math.min(5000, Math.max(0, Number.isFinite(retry) ? retry * 1000 : 250 * 2 ** attempt) + Math.random() * 100));
        continue;
      }
      if (!res.ok) throw new ShoptetError(({401:'oauth_expired',403:'permission_missing',404:'not_found',429:'rate_limited'})[res.status] || 'upstream_error', res.status);
      let body; try { body = await res.json(); } catch { throw new ShoptetError('invalid_upstream_json'); }
      if (!body || typeof body.data !== 'object' || body.data === null || body.errors?.length) throw new ShoptetError('invalid_upstream_data');
      return body.data;
    }
  }
  const compact = item => Object.fromEntries(['guid','id','code','name','indexName','price','currency','active','variants','customerGroup','priceList','priceRatio'].filter(k=>item[k]!==undefined).map(k=>[k, k==='variants' && Array.isArray(item[k]) ? item[k].slice(0,50).map(v=>Object.fromEntries(['code','guid','name','price','active'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))) : item[k]]));
  const adapter = {
    async customerGroups(){const data=await read('/api/customers/groups');return z.array(z.object({id:z.number().int().safe(),name:z.string(),customerGroupCode:z.string().nullable(),defaultPricelistId:positiveId.nullable()})).max(1000).parse(data.customerGroups);},
    async orderStatuses(){const data=await read('/api/eshop',{include:'orderStatuses'});return z.array(z.object({id:z.number().int().safe(),name:z.string()})).max(200).parse(data.orderStatuses?.statuses);},
    async customer(guid){uuidSchema.parse(guid);const data=await read('/api/customers/'+guid);const customer=customerSchema.parse(data.customer);if(customer.guid!==guid)throw new ShoptetError('customer_reference_mismatch');return customer;},
    async customerOrders(guid,{page=1,from,to}={}){uuidSchema.parse(guid);positiveId.parse(page);instantSchema.parse(from);instantSchema.parse(to);const data=await read('/api/orders',{customerGuid:guid,creationTimeFrom:from,creationTimeTo:to,page,itemsPerPage:50});return {items:z.array(z.object({code:documentCode,changeTime:instantSchema})).max(50).parse(data.orders),pagination:paginatorSchema.parse(data.paginator)};},
    async order(code){documentCode.parse(code);const data=await read('/api/orders/'+encodeURIComponent(code));const order=orderSchema.parse(data.order);if(order.code!==code)throw new ShoptetError('order_reference_mismatch');return order;},
    async creditNotes({page=1}={}){positiveId.parse(page);const data=await read('/api/credit-notes',{page,itemsPerPage:50});return {items:z.array(z.object({code:documentCode})).max(50).parse(data.creditNotes),pagination:paginatorSchema.parse(data.paginator)};},
    async creditNote(code){documentCode.parse(code);const data=await read('/api/credit-notes/'+encodeURIComponent(code));const note=z.object({code:documentCode,isValid:z.boolean(),orderCode:documentCode.nullable(),customer:z.object({guid:uuidSchema.nullable()}),creationTime:instantSchema}).parse(data.creditNote);if(note.code!==code)throw new ShoptetError('credit_note_reference_mismatch');return note;},
    async verifyBrand(id) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new ShoptetError('invalid_brand_id',400);
      const data=await read('/api/brands/'+encodeURIComponent(id));
      return data.guid === id;
    },
    async brand(id) {
      if(typeof id!=='string'||!id||id.length>128)throw new ShoptetError('invalid_brand_id',400);
      const data=await read('/api/brands/'+encodeURIComponent(id));
      return brandSchema.parse(data);
    },
    async product(id) {
      uuidSchema.parse(id);
      const data=await read('/api/products/'+encodeURIComponent(id),{include:'allCategories'});
      if(data.guid!==id)throw new ShoptetError('product_reference_mismatch');
      return productSchema.parse(data);
    },
    async category(id) {uuidSchema.parse(id);const data=await read('/api/categories/'+encodeURIComponent(id));const parsed=z.object({guid:uuidSchema,name:z.string(),visible:z.boolean()}).parse(data);if(parsed.guid!==id)throw new ShoptetError('category_reference_mismatch');return parsed;},
    async pricelist(id) {
      positiveId.parse(id);
      const data=await read('/api/price-lists/'+id);
      const parsed=pricelistSchema.parse(data.priceList);if(parsed.id!==id)throw new ShoptetError('pricelist_reference_mismatch');return parsed;
    },
    async prices(id,{page=1,limit=50,code}={}) {
      positiveId.parse(id);positiveId.parse(page);z.number().int().min(1).max(100).parse(limit);
      if(code!==undefined)z.string().min(1).max(128).parse(code);
      const data=await read('/api/price-lists/'+id+'/prices',{page,itemsPerPage:limit,...(code!==undefined?{code}:{})});
      const rows=z.array(priceRowSchema).max(100).parse(data.prices);
      return {items:rows,pagination:paginatorSchema.parse(data.paginator)};
    },
    async capabilities() {
      const data=await read('/api/system/endpoints',{status:'approved'});
      return {source:'shoptet_approved_endpoints',endpoints:z.array(z.object({endpoint:z.string().max(128),access:z.enum(['read','write','both']),action:z.literal(null)})).max(1000).parse(data.endpoints)};
    },
    async writePrices(id,rows) {
      positiveId.parse(id);const items=z.array(pricePatchSchema).min(1).max(100).parse(rows);
      if(!authorizeWrite)throw new ShoptetError('write_not_authorized',403);
      const token=await getToken();
      await authorizeWrite({pricelistId:id,items});let response;
      // Mutations are never automatically retried: a timeout may mean the server applied them.
      try{response=await fetchImpl('https://api.myshoptet.com/api/price-lists/'+id+'/prices',{method:'PATCH',redirect:REDIRECT_MODE,signal:AbortSignal.timeout(timeoutMs),headers:{'Shoptet-Access-Token':token,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({data:items})});}
      catch{return {outcome:'unknown',error:'write_outcome_unknown',requiresReadback:true};}
      let body;try{body=await response.json();}catch{return {outcome:'unknown',error:'invalid_write_response',requiresReadback:true};}
      if(!response.ok && response.status>=500)return {outcome:'unknown',error:'write_outcome_unknown',requiresReadback:true};
      if(!body||typeof body!=='object'||!Object.hasOwn(body,'data')||!Object.hasOwn(body,'errors')||(body.data!==null&&typeof body.data!=='object'))return {outcome:'unknown',error:'invalid_write_response',requiresReadback:true};
      const errors=z.array(z.object({errorCode:z.string().max(128),instance:z.string().max(128)})).safeParse(body.errors??[]);
      if(!errors.success)return {outcome:'unknown',error:'invalid_write_response',requiresReadback:true};
      if(!response.ok || errors.data.length)return {outcome:response.ok?'partial':'failed',errors:errors.data,status:response.status,requiresReadback:true};
      return {outcome:'accepted',requiresReadback:true};
    },
    async list(kind, {page=1, limit=30, query=''} = {}) {
      if (!collections[kind] || !Number.isSafeInteger(page) || page<1 || page>10000 || !Number.isSafeInteger(limit) || limit<1 || limit>50 || typeof query!=='string' || query.length>100) throw new ShoptetError('invalid_parameters',400);
      const data = await read('/api/'+collections[kind], kind==='pricelists'?{}:{page,itemsPerPage:limit});
      if (!Array.isArray(data[collections[kind]])) throw new ShoptetError('invalid_collection');
      const items = data[collections[kind]].slice(0, kind==='pricelists'?500:limit).map(compact);
      return { items: items.filter(x=>!query || [x.name,x.code,x.guid].some(v=>String(v??'').toLocaleLowerCase('cs').includes(query.toLocaleLowerCase('cs')))), page, limit, searchScope:'returned_page_only', pagination: data.paginator || null };
    },
    async profile() { const data=await read('/api/eshop'); return profileSchema.parse({id:data.contactInformation?.eshopId,name:data.contactInformation?.eshopName,vatPayer:data.settings?.vatPayer,defaultPricelistId:data.settings?.defaultPricelist?.id,timezone:data.settings?.timezone,currencies:data.currencies}); },
    async updateCustomerPricelist(guid, pricelistId) {
      uuidSchema.parse(guid);
      positiveId.parse(pricelistId);
      if (!authorizeWrite) throw new ShoptetError('write_not_authorized', 403);
      await authorizeWrite({ customerGuid: guid, pricelistId });
      const current = await adapter.customer(guid);
      if (current.priceRatio !== '1.0000') {
        return { outcome: 'blocked', reason: 'price_ratio_locked', priceRatio: current.priceRatio, requiresReadback: false };
      }
      if (current.priceList?.id === pricelistId) {
        return { outcome: 'no_change', currentPricelistId: pricelistId, requiresReadback: false };
      }
      await adapter.pricelist(pricelistId);
      const token = await getToken();
      let response;
      try {
        response = await fetchImpl('https://api.myshoptet.com/api/customers/' + guid, {
          method: 'PATCH',
          redirect: REDIRECT_MODE,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data: { pricelistId } })
        });
      } catch {
        return { outcome: 'unknown', error: 'write_outcome_unknown', requiresReadback: true };
      }
      let body;
      try { body = await response.json(); } catch { return { outcome: 'unknown', error: 'invalid_write_response', requiresReadback: true }; }
      if (!response.ok && response.status >= 500) return { outcome: 'unknown', error: 'write_outcome_unknown', requiresReadback: true };
      if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'data')) return { outcome: 'unknown', error: 'invalid_write_response', requiresReadback: true };
      const errors = z.array(z.object({ errorCode: z.string().max(128), instance: z.string().optional(), message: z.string().optional() })).safeParse(body.errors ?? []);
      if (!errors.success) return { outcome: 'unknown', error: 'invalid_write_response', requiresReadback: true };
      if (!response.ok || errors.data.length) return { outcome: 'failed', errors: errors.data, status: response.status, requiresReadback: true };
      const verified = await adapter.customer(guid);
      if (verified.priceList?.id !== pricelistId) {
        return { outcome: 'failed', error: 'readback_mismatch', expectedPricelistId: pricelistId, actualPricelistId: verified.priceList?.id ?? null, requiresReadback: true };
      }
      return { outcome: 'accepted', customerGuid: guid, previousPricelistId: current.priceList?.id ?? null, pricelistId, verified: true, requiresReadback: false };
    },
    async createPricelist({ name }) {
      z.string().min(1).max(128).parse(name);
      if (!authorizeWrite) throw new ShoptetError('write_not_authorized', 403);
      await authorizeWrite({ action: 'createPricelist', name });
      const token = await getToken();
      let response;
      try {
        response = await fetchImpl('https://api.myshoptet.com/api/pricelists', {
          method: 'POST',
          redirect: REDIRECT_MODE,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data: { name } })
        });
      } catch {
        return { outcome: 'unknown', error: 'write_outcome_unknown' };
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'failed', error: response.status === 401 ? 'oauth_expired' : 'permission_missing', status: response.status };
      }
      let body;
      try { body = await response.json(); } catch { return { outcome: 'unknown', error: 'invalid_write_response' }; }
      if (!response.ok || !body?.data) {
        return { outcome: 'failed', error: 'create_pricelist_failed', status: response.status, errors: body?.errors ?? [] };
      }
      return { outcome: 'accepted', pricelist: { id: body.data.id, name: body.data.name } };
    },
    async createCustomerGroup({ name, defaultPricelistId = null }) {
      z.string().min(1).max(128).parse(name);
      if (defaultPricelistId !== null && defaultPricelistId !== undefined) positiveId.parse(defaultPricelistId);
      if (!authorizeWrite) throw new ShoptetError('write_not_authorized', 403);
      await authorizeWrite({ action: 'createCustomerGroup', name, defaultPricelistId });
      const token = await getToken();
      let response;
      try {
        response = await fetchImpl('https://api.myshoptet.com/api/customers/groups', {
          method: 'POST',
          redirect: REDIRECT_MODE,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data: { name, ...(defaultPricelistId ? { defaultPricelistId } : {}) } })
        });
      } catch {
        return { outcome: 'unknown', error: 'write_outcome_unknown' };
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'failed', error: response.status === 401 ? 'oauth_expired' : 'permission_missing', status: response.status };
      }
      let body;
      try { body = await response.json(); } catch { return { outcome: 'unknown', error: 'invalid_write_response' }; }
      if (!response.ok || !body?.data) {
        return { outcome: 'failed', error: 'create_customer_group_failed', status: response.status, errors: body?.errors ?? [] };
      }
      return { outcome: 'accepted', customerGroup: { id: body.data.id, name: body.data.name, defaultPricelistId: body.data.defaultPricelistId ?? defaultPricelistId ?? null } };
    },
    async updateCustomerGroup(id, { defaultPricelistId }) {
      positiveId.parse(id);
      positiveId.parse(defaultPricelistId);
      if (!authorizeWrite) throw new ShoptetError('write_not_authorized', 403);
      await authorizeWrite({ action: 'updateCustomerGroup', id, defaultPricelistId });
      const token = await getToken();
      let response;
      try {
        response = await fetchImpl('https://api.myshoptet.com/api/customers/groups/' + id, {
          method: 'PATCH',
          redirect: REDIRECT_MODE,
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data: { defaultPricelistId } })
        });
      } catch {
        return { outcome: 'unknown', error: 'write_outcome_unknown' };
      }
      if (response.status === 401 || response.status === 403) {
        return { outcome: 'failed', error: response.status === 401 ? 'oauth_expired' : 'permission_missing', status: response.status };
      }
      let body;
      try { body = await response.json(); } catch { return { outcome: 'unknown', error: 'invalid_write_response' }; }
      if (!response.ok || !body?.data) {
        return { outcome: 'failed', error: 'update_customer_group_failed', status: response.status, errors: body?.errors ?? [] };
      }
      return { outcome: 'accepted', id, defaultPricelistId };
    }
  };
  return adapter;
}

const positiveId=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uuidSchema=z.string().uuid();
const decimal=z.string().regex(/^\d+\.\d{2}$/).max(24);
const actionSchema=z.object({price:decimal,fromDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),toDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()}).nullable();
const purchaseCostSchema=z.object({price:decimal.nullable(),vatRate:decimal,includingVat:z.boolean()});
export const priceRowSchema=z.object({code:z.string().min(1).max(128),currencyCode:z.string().regex(/^[A-Z]{3}$/),includingVat:z.boolean(),vatRate:decimal,price:z.object({price:decimal.nullable(),commonPrice:decimal.nullable().optional(),priceRatio:z.string().regex(/^\d+\.\d{3}$/),actionPrice:actionSchema}),sales:z.object({discountCoupon:z.boolean()}),prices:z.object({purchasePrice:purchaseCostSchema.nullable().optional()}).optional()});
const pricePatchSchema=z.object({code:z.string().min(1).max(128),priceWithVat:z.object({price:decimal.refine(v=>BigInt(v.replace('.',''))>0n,'Zero price requires a verified shop capability'),commonPrice:decimal.optional()}).strict(),sales:z.object({discountCoupon:z.boolean()}).strict().optional()}).strict();
const brandSchema=z.object({guid:uuidSchema,name:z.string().max(500),indexName:z.string().max(500)});
const productSchema=z.object({guid:uuidSchema,name:z.string().nullable(),visibility:z.string(),brand:z.object({code:z.string(),name:z.string()}).nullable(),categories:z.array(z.object({guid:uuidSchema.nullable()})).optional(),defaultCategory:z.object({guid:uuidSchema.nullable()}),variants:z.array(z.object({code:z.string(),visible:z.boolean()}))});
const pricelistSchema=z.object({id:positiveId,name:z.string(),currency:z.string().nullable(),isDefault:z.boolean()});
const paginatorSchema=z.object({page:z.number().int().nonnegative(),pageCount:z.number().int().nonnegative(),totalCount:z.number().int().nonnegative()});
const profileSchema=z.object({id:positiveId,name:z.string(),vatPayer:z.boolean(),defaultPricelistId:positiveId,timezone:z.string(),currencies:z.array(z.object({code:z.string(),priceDecimalPlaces:z.number().int().min(0).max(4),rounding:z.enum(['none','up','down','math'])})).max(100)});
const instantSchema=z.string().min(1).max(64).refine(v=>Number.isFinite(Date.parse(v)));
const documentCode=z.string().min(1).max(128).refine(v=>v!=='.'&&v!=='..');
const signedMoney=z.string().regex(/^-?\d+\.\d{2}$/).max(24).nullable();
const customerSchema=z.object({guid:uuidSchema,customerGroup:z.object({id:z.number().int().safe(),name:z.string()}).nullable(),priceList:z.object({id:positiveId,name:z.string()}).nullable(),priceRatio:z.string().regex(/^\d+\.\d{4}$/)});
const orderSchema=z.object({code:documentCode,creationTime:instantSchema,changeTime:instantSchema,customerGuid:uuidSchema.nullable(),status:z.object({id:z.number().int().safe()}).nullable(),paid:z.boolean().nullable(),price:z.object({currencyCode:z.string().regex(/^[A-Z]{3}$/),withVat:signedMoney,withoutVat:signedMoney}),items:z.array(z.object({itemType:z.enum(['product','bazar','service','shipping','billing','discount-coupon','volume-discount','gift','gift-certificate','generic-item','product-set','product-set-item','deposit']),status:z.object({id:z.number().int().safe()}),itemPrice:z.object({withVat:signedMoney,withoutVat:signedMoney})})).max(1000)});
