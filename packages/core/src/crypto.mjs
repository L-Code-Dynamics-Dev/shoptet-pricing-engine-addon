const enc=new TextEncoder();
export const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
export const pkce=async value=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
