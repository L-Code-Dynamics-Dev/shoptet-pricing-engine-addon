// Atomic lease-based shop lock; caller must provide a fresh unpredictable owner ID.
// A finite lease avoids permanent deadlocks; operations must complete before expiry.
const OWNER = /^[a-f0-9]{32}$/;
export function createD1ShopLock(db, {now=()=>Date.now(), leaseMs=120000}={}) {
 if (typeof db?.prepare!=='function' || typeof now!=='function' || !Number.isSafeInteger(leaseMs) || leaseMs<1000 || leaseMs>600000) throw new Error('Lock unavailable');
 return {
  async withShopLock(shopId, callback) {
   if(typeof shopId!=='string'||!shopId||typeof callback!=='function')throw new Error('Lock unavailable');
   const owner=crypto.randomUUID().replaceAll('-','');
   if(!OWNER.test(owner))throw new Error('Lock unavailable');
   const started=now();
   const expires=started+leaseMs;
   const result=await db.prepare(`INSERT INTO asset_install_locks(shop_id,owner_id,expires_at_ms)
      VALUES(?,?,?) ON CONFLICT(shop_id) DO UPDATE SET owner_id=excluded.owner_id,expires_at_ms=excluded.expires_at_ms
      WHERE asset_install_locks.expires_at_ms<=?`).bind(shopId,owner,expires,started).run();
   if(result?.meta?.changes!==1)throw new Error('Installation already running');
   try {return await callback();}
   finally {await db.prepare('DELETE FROM asset_install_locks WHERE shop_id=? AND owner_id=?').bind(shopId,owner).run();}
  }
 };
}
