// AES-GCM per-shop credentials. Master key is a Worker secret, never a database value.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = bytes => btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
const unb64 = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
function assertShop(shopId) {
  if (typeof shopId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(shopId)) throw new Error('Invalid shop');
}
async function importKey(secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) throw new Error('Vault unavailable');
  return crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), h => parseInt(h,16)), 'AES-GCM', false, ['encrypt','decrypt']);
}
export function createSftpCredentialVault({db, masterKeyHex}) {
  if (typeof db?.prepare !== 'function') throw new Error('Vault unavailable');
  return {
    async save(shopId, credentials) {
      assertShop(shopId);
      if (!credentials || typeof credentials.host !== 'string' || typeof credentials.username !== 'string' || typeof credentials.password !== 'string' || typeof credentials.hostKeySha256 !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(credentials.hostKeySha256)) throw new Error('Invalid credentials');
      const key=await importKey(masterKeyHex);
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(shopId)},key,encoder.encode(JSON.stringify({...credentials,port:22})));
      await db.prepare('INSERT INTO shop_sftp_credentials(shop_id,iv_b64,ciphertext_b64) VALUES(?,?,?) ON CONFLICT(shop_id) DO UPDATE SET iv_b64=excluded.iv_b64,ciphertext_b64=excluded.ciphertext_b64').bind(shopId,b64(iv),b64(new Uint8Array(ciphertext))).run();
    },
    async resolve(shopId) {
      assertShop(shopId);
      const row=await db.prepare('SELECT iv_b64,ciphertext_b64 FROM shop_sftp_credentials WHERE shop_id=?').bind(shopId).first();
      if (!row) throw new Error('SFTP credentials unavailable');
      const key=await importKey(masterKeyHex);
      try {
        const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(row.iv_b64),additionalData:encoder.encode(shopId)},key,unb64(row.ciphertext_b64));
        return JSON.parse(decoder.decode(plain));
      } catch {throw new Error('SFTP credentials unavailable');}
    }
  };
}
