// Server-side adapter for an injected SFTP client. Credentials must be resolved
// by a trusted per-shop secret provider, never from MCP tool arguments.
const ROOT = 'upload/CSSJS/';
const ALLOWED = /^(vip_detail|vip_prices|vip_catalog|vip_cart|vip_cart_coupon_lock)\.js(?:\.[a-f0-9]{32}\.stage)?$/;
function safePath(path) {
  if (typeof path !== 'string' || !path.startsWith(ROOT) || !ALLOWED.test(path.slice(ROOT.length))) throw new Error('Invalid asset path');
  return path;
}
function safeConnection(settings) {
  if (!settings || typeof settings !== 'object' || typeof settings.host !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(settings.host) || !Number.isInteger(settings.port) || settings.port !== 22 || typeof settings.username !== 'string' || !settings.username || typeof settings.password !== 'string' || !settings.password) throw new Error('Invalid SFTP configuration');
  if (typeof settings.hostKeySha256 !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(settings.hostKeySha256)) throw new Error('Pinned host key required');
  return {host:settings.host,port:settings.port,username:settings.username,password:settings.password,hostKeySha256:settings.hostKeySha256};
}
export function createSftpTransport({clientFactory, resolveCredentials, expectedShopId}) {
  if (typeof clientFactory !== 'function' || typeof resolveCredentials !== 'function' || typeof expectedShopId !== 'string' || !expectedShopId) throw new Error('Invalid SFTP adapter');
  let client=null;
  return {
    async connect(shopId) {
      if (client || shopId !== expectedShopId) throw new Error('SFTP connection denied');
      const credentials=safeConnection(await resolveCredentials(expectedShopId));
      const instance=clientFactory();
      if (!instance || typeof instance.connect !== 'function') throw new Error('Invalid SFTP client');
      try { await instance.connect(credentials); if (typeof instance.verifiedHostKey !== 'function' || await instance.verifiedHostKey() !== credentials.hostKeySha256) throw new Error('Host key mismatch'); client=instance; }
      catch { try { await instance.end?.(); } catch {} throw new Error('SFTP connection failed'); }
    },
    async read(path) {
      if (!client) throw new Error('SFTP not connected');
      const name=safePath(path);
      const exists=await client.exists(name);
      if (exists===false) return null;
      if (exists!=='-' && exists!==true) throw new Error('SFTP path is not a regular file');
      const result=await client.get(name);
      if (!(result instanceof Uint8Array)) throw new Error('Invalid SFTP response');
      return new Uint8Array(result);
    },
    async write(path,bytes) {
      if (!client) throw new Error('SFTP not connected');
      safePath(path);
      if (!(bytes instanceof Uint8Array)) throw new Error('Invalid asset bytes');
      await client.put(bytes,path);
    },
    async rename(from,to) {
      if (!client) throw new Error('SFTP not connected');
      safePath(from);safePath(to);
      if (!from.endsWith('.stage') || to.endsWith('.stage')) throw new Error('Invalid publication');
      await client.rename(from,to);
    },
    async remove(path) {
      if (!client) throw new Error('SFTP not connected');
      safePath(path);
      const exists=await client.exists(path);
      if (exists===false) return;
      if (exists!=='-' && exists!==true) throw new Error('SFTP path is not a regular file');
      await client.delete(path);
    },
    async close() { const active=client;client=null;if(active)await active.end(); }
  };
}
