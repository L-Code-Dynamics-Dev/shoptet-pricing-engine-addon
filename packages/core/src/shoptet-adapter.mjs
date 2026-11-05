// Fixed-origin read adapter. Callers cannot provide URLs, HTTP methods or credentials.
export class ShoptetError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
const collections = { brands: 'brands', products: 'products', categories: 'categories', pricelists: 'pricelists' };
export function createShoptetAdapter({ getToken, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), timeoutMs = 10000 }) {
  async function read(path, params = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await getToken();
      const url = new URL(path, 'https://api.myshoptet.com');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      let res;
      try { res = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Shoptet-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' } }); }
      catch { throw new ShoptetError('upstream_unavailable'); }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        const retry = Number(res.headers.get('retry-after'));
        await sleep(Math.min(5000, Math.max(0, Number.isFinite(retry) ? retry * 1000 : 250 * 2 ** attempt) + Math.random() * 100));
        continue;
      }
      if (!res.ok) throw new ShoptetError(({401:'oauth_expired',403:'permission_missing',404:'not_found',429:'rate_limited'})[res.status] || 'upstream_error', res.status);
      let body; try { body = await res.json(); } catch { throw new ShoptetError('invalid_upstream_json'); }
      if (!body || typeof body.data !== 'object' || body.data === null || body.errors?.length) throw new ShoptetError('invalid_upstream_data');
      return body.data;
    }
  }
  const compact = item => Object.fromEntries(['guid','id','code','name','indexName','price','currency','active','variants'].filter(k=>item[k]!==undefined).map(k=>[k, k==='variants' && Array.isArray(item[k]) ? item[k].slice(0,50).map(v=>Object.fromEntries(['code','guid','name','price','active'].filter(k=>v[k]!==undefined).map(k=>[k,v[k]]))) : item[k]]));
  return {
    async verifyBrand(id) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new ShoptetError('invalid_brand_id',400);
      const data=await read('/api/brands/'+encodeURIComponent(id));
      return data.brand?.guid === id;
    },
    async list(kind, {page=1, limit=30, query=''} = {}) {
      if (!collections[kind] || !Number.isSafeInteger(page) || page<1 || page>10000 || !Number.isSafeInteger(limit) || limit<1 || limit>50 || typeof query!=='string' || query.length>100) throw new ShoptetError('invalid_parameters',400);
      const data = await read('/api/'+collections[kind], kind==='pricelists'?{}:{page,itemsPerPage:limit});
      if (!Array.isArray(data[collections[kind]])) throw new ShoptetError('invalid_collection');
      const items = data[collections[kind]].slice(0, kind==='pricelists'?500:limit).map(compact);
      return { items: items.filter(x=>!query || [x.name,x.code,x.guid].some(v=>String(v??'').toLocaleLowerCase('cs').includes(query.toLocaleLowerCase('cs')))), page, limit, searchScope:'returned_page_only', pagination: data.paginator || null };
    },
    async profile() { const data=await read('/api/eshop'); const e=data.eshop || data; return Object.fromEntries(['id','name','currency','currencies','vatPayer'].filter(k=>e[k]!==undefined).map(k=>[k,e[k]])); }
  };
}
