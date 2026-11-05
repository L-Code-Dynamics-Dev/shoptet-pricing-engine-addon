// Versioned AES-GCM envelopes. Keys are Worker secrets; AAD binds shop and token purpose.
const enc=new TextEncoder(),dec=new TextDecoder();
const b64=bytes=>btoa(Array.from(new Uint8Array(bytes),b=>String.fromCharCode(b)).join(''));
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export function parseTokenKeys(value) {
  let keys;try{keys=typeof value==='string'?JSON.parse(value):value;}catch{throw Error('Token vault unavailable');}
  if(!keys||!/^[-a-zA-Z0-9_]{1,32}$/.test(keys.active??'')||!keys.keys||!Object.hasOwn(keys.keys,keys.active)||Object.entries(keys.keys).some(([id,key])=>!/^[-a-zA-Z0-9_]{1,32}$/.test(id)||typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key)))throw Error('Token vault unavailable');
  return keys;
}
export function createTokenVault(configuration) {
  const config=parseTokenKeys(configuration);
  function context(shop,purpose,id){if(typeof shop!=='string'||!shop||shop.length>128||!['oauth','api'].includes(purpose))throw Error('Invalid token context');return enc.encode(JSON.stringify([1,shop,purpose,id]));}
  async function key(id){if(!Object.hasOwn(config.keys,id))throw Error('Token unavailable');return crypto.subtle.importKey('raw',Uint8Array.from(config.keys[id].match(/../g),h=>parseInt(h,16)),'AES-GCM',false,['encrypt','decrypt']);}
  return {
    async seal(shop,purpose,token) {
      if(typeof token!=='string'||!token||token.length>8192)throw Error('Invalid token');
      const id=config.active,iv=crypto.getRandomValues(new Uint8Array(12));
      const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:context(shop,purpose,id)},await key(id),enc.encode(token));
      return JSON.stringify({v:1,kid:id,iv:b64(iv),data:b64(data)});
    },
    async open(shop,purpose,envelope) {
      try {const e=JSON.parse(envelope);if(e.v!==1||typeof e.kid!=='string'||typeof e.iv!=='string'||typeof e.data!=='string'||e.data.length>12000||unb64(e.iv).length!==12)throw Error();return dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(e.iv),additionalData:context(shop,purpose,e.kid)},await key(e.kid),unb64(e.data)));}
      catch{throw Error('Token unavailable');}
    }
  };
}
