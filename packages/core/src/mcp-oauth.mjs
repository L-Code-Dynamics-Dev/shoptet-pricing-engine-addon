const enc=new TextEncoder();
export const MCP_SCOPES=['shop:read','catalog:read','pricing:read','pricing:configure','pricing:execute','sync:read','sync:execute','audit:read'];
export const randomSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
export const pkce=async value=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value))))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export class OAuthError extends Error {constructor(code){super(code);this.code=code;}}
export function oauthConfiguration(env) {
 let origin,clients;try{origin=new URL(env.MCP_PUBLIC_ORIGIN);clients=JSON.parse(env.MCP_OAUTH_CLIENTS);}catch{throw new OAuthError('server_not_configured');}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!Array.isArray(clients)||!clients.length)throw new OAuthError('server_not_configured');
 for(const c of clients){if(typeof c.client_id!=='string'||!c.client_id||c.client_id.length>128||typeof c.name!=='string'||c.name.length>100||!Array.isArray(c.redirect_uris)||!c.redirect_uris.length)throw new OAuthError('server_not_configured');for(const s of c.redirect_uris){let u;try{u=new URL(s);}catch{throw new OAuthError('server_not_configured');}if(u.protocol!=='https:'||u.username||u.password||u.hash)throw new OAuthError('server_not_configured');}}
 if(new Set(clients.map(c=>c.client_id)).size!==clients.length)throw new OAuthError('server_not_configured');
 return {origin:origin.origin,resource:origin.origin+'/mcp',clients};
}
export function createMcpOAuth(db,config) {
 const now=()=>Math.floor(Date.now()/1000);
 function client(id){const c=config.clients.find(c=>c.client_id===id);if(!c)throw new OAuthError('invalid_client');return c;}

 return {
  async begin(params,browserSecret) {
   const c=client(params.client_id);
   if(params.response_type!=='code'||!c.redirect_uris.includes(params.redirect_uri)||params.resource!==config.resource||params.code_challenge_method!=='S256'||!/^[-_A-Za-z0-9]{43}$/.test(params.code_challenge??'')||typeof params.state!=='string'||!params.state||params.state.length>1024)throw new OAuthError('invalid_request');
   const scopes=(params.scope||'shop:read catalog:read pricing:read').split(' ');
   if(!scopes.length||scopes.some(s=>!MCP_SCOPES.includes(s))||new Set(scopes).size!==scopes.length)throw new OAuthError('invalid_scope');
   const requestId=randomSecret();
   await db.prepare('INSERT INTO mcp_authorizations(request_id,browser_hash,client_id,redirect_uri,resource,scopes_json,challenge,client_state,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(requestId,await digest(browserSecret),c.client_id,params.redirect_uri,config.resource,JSON.stringify(scopes),params.code_challenge,params.state,now()+600).run();
   return {requestId,clientName:c.name,expiresIn:600};
  },
  async inspect(requestId){const row=await db.prepare('SELECT client_id,redirect_uri,scopes_json,expires_at FROM mcp_authorizations WHERE request_id=? AND shop_id IS NULL AND expires_at>?').bind(requestId,now()).first();if(!row)throw new OAuthError('invalid_request');return {requestId,clientName:client(row.client_id).name,redirectUri:row.redirect_uri,scopes:JSON.parse(row.scopes_json),expiresAt:row.expires_at};},
  async consent(requestId,shopId,sessionHash) {
   if(!/^[a-f0-9]{64}$/.test(sessionHash??''))throw new OAuthError('access_denied');
   const r=await db.prepare("UPDATE mcp_authorizations SET shop_id=?,approved_by=? WHERE request_id=? AND shop_id IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM installations WHERE shop_id=? AND state='active')").bind(shopId,sessionHash,requestId,now(),shopId).run();if(!r.meta?.changes)throw new OAuthError('access_denied');return {approved:true};
  },
  async finish(requestId,browserSecret) {
   const row=await db.prepare('SELECT * FROM mcp_authorizations WHERE request_id=? AND browser_hash=? AND expires_at>? AND consumed=0').bind(requestId,await digest(browserSecret),now()).first();
   if(!row)throw new OAuthError('invalid_request');if(!row.shop_id)return {pending:true};
   client(row.client_id);const code=randomSecret();
   const r=await db.prepare('UPDATE mcp_authorizations SET code_hash=?,code_expires_at=? WHERE request_id=? AND code_hash IS NULL').bind(await digest(code),now()+60,requestId).run();if(!r.meta?.changes)throw new OAuthError('invalid_request');
   const redirect=new URL(row.redirect_uri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',row.client_state);redirect.searchParams.set('iss',config.origin);return {redirect:redirect.href};
  },
  async exchange(params) {
   client(params.client_id);
   if(params.resource!==config.resource)throw new OAuthError('invalid_target');
   if(typeof params.code_verifier!=='string'||!/^[-._~A-Za-z0-9]{43,128}$/.test(params.code_verifier))throw new OAuthError('invalid_grant');
   const row=await db.prepare('SELECT * FROM mcp_authorizations WHERE code_hash=? AND client_id=? AND redirect_uri=? AND resource=? AND consumed=0 AND code_expires_at>? AND expires_at>?').bind(await digest(params.code||''),params.client_id,params.redirect_uri,config.resource,now(),now()).first();
   if(!row||row.challenge!==await pkce(params.code_verifier)||!row.shop_id)throw new OAuthError('invalid_grant');
   const access=randomSecret(),refresh=randomSecret(),grantId=crypto.randomUUID();
   // Conditional inserts only succeed if this transaction claimed this code with its unique grant ID.
   // Code claim and grant issuance are atomic via trigger-style transaction marker code_hash.
   const marker='claimed:'+grantId;
   const results=await db.batch([
    db.prepare('UPDATE mcp_authorizations SET consumed=1,code_hash=? WHERE request_id=? AND consumed=0').bind(marker,row.request_id),
    db.prepare("INSERT INTO mcp_oauth_grants(grant_id,shop_id,client_id,resource,scopes_json,refresh_hash,refresh_expires_at,created_at) SELECT ?,shop_id,client_id,resource,scopes_json,?,?,? FROM mcp_authorizations WHERE request_id=? AND code_hash=? AND EXISTS(SELECT 1 FROM installations i WHERE i.shop_id=mcp_authorizations.shop_id AND i.state='active')").bind(grantId,await digest(refresh),now()+2592000,now(),row.request_id,marker),
    db.prepare("INSERT INTO mcp_credentials(token_sha256,shop_id,scopes_json,expires_at,oauth_grant_id) SELECT ?,shop_id,scopes_json,datetime('now','+10 minutes'),grant_id FROM mcp_oauth_grants WHERE grant_id=?").bind(await digest(access),grantId)
   ]);
   if(!results[2].meta?.changes)throw new OAuthError('invalid_grant');
   return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:600,scope:JSON.parse(row.scopes_json).join(' ')};
  },
  async refresh(params) {
   client(params.client_id);if(params.resource!==config.resource)throw new OAuthError('invalid_target');
   const hash=await digest(params.refresh_token||'');
   const row=await db.prepare("SELECT g.* FROM mcp_oauth_grants g JOIN installations i ON i.shop_id=g.shop_id WHERE refresh_hash=? AND client_id=? AND resource=? AND revoked_at IS NULL AND refresh_expires_at>? AND i.state='active'").bind(hash,params.client_id,config.resource,now()).first();if(!row){
     const retired=await db.prepare('SELECT h.grant_id FROM mcp_refresh_history h JOIN mcp_oauth_grants g ON g.grant_id=h.grant_id WHERE h.refresh_hash=? AND g.client_id=? AND g.resource=?').bind(hash,params.client_id,config.resource).first();
     if(retired)await db.prepare('UPDATE mcp_oauth_grants SET revoked_at=? WHERE grant_id=?').bind(now(),retired.grant_id).run();
     throw new OAuthError('invalid_grant');
   }
   if(params.scope!==undefined && params.scope!==JSON.parse(row.scopes_json).join(' '))throw new OAuthError('invalid_scope');
   const access=randomSecret(),refresh=randomSecret(),nextHash=await digest(refresh);
   const results=await db.batch([
    db.prepare("UPDATE mcp_oauth_grants SET refresh_hash=?,generation=generation+1,last_used_at=? WHERE grant_id=? AND refresh_hash=? AND revoked_at IS NULL AND refresh_expires_at>unixepoch() AND EXISTS(SELECT 1 FROM installations i WHERE i.shop_id=mcp_oauth_grants.shop_id AND i.state='active')").bind(nextHash,now(),row.grant_id,hash),
    db.prepare("INSERT INTO mcp_credentials(token_sha256,shop_id,scopes_json,expires_at,oauth_grant_id) SELECT ?,shop_id,scopes_json,datetime('now','+10 minutes'),grant_id FROM mcp_oauth_grants WHERE grant_id=? AND refresh_hash=? AND revoked_at IS NULL").bind(await digest(access),row.grant_id,nextHash),
    db.prepare('INSERT INTO mcp_refresh_history(refresh_hash,grant_id,expires_at) SELECT ?,grant_id,refresh_expires_at FROM mcp_oauth_grants WHERE grant_id=? AND refresh_hash=?').bind(hash,row.grant_id,nextHash)
   ]);if(!results[1].meta?.changes){await db.prepare('UPDATE mcp_oauth_grants SET revoked_at=? WHERE grant_id=?').bind(now(),row.grant_id).run();throw new OAuthError('invalid_grant');}
   return {access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:600,scope:JSON.parse(row.scopes_json).join(' ')};
  },
  async revoke(params){
   client(params.client_id);if(params.resource!==undefined && params.resource!==config.resource)throw new OAuthError('invalid_target');
   const hash=await digest(params.token||'');
   await db.prepare('UPDATE mcp_oauth_grants SET revoked_at=? WHERE client_id=? AND resource=? AND (refresh_hash=? OR grant_id IN(SELECT oauth_grant_id FROM mcp_credentials WHERE token_sha256=?) OR grant_id IN(SELECT grant_id FROM mcp_refresh_history WHERE refresh_hash=?))').bind(now(),params.client_id,config.resource,hash,hash,hash).run();return {};
  },
  async disconnect(shopId,grantId){const r=await db.prepare('UPDATE mcp_oauth_grants SET revoked_at=? WHERE shop_id=? AND grant_id=? AND revoked_at IS NULL').bind(now(),shopId,grantId).run();return {revoked:!!r.meta?.changes};},
  async connections(shopId){return {connections:(await db.prepare('SELECT grant_id,client_id,scopes_json,created_at,last_used_at,last_connection_at,refresh_expires_at,revoked_at FROM mcp_oauth_grants WHERE shop_id=? ORDER BY created_at DESC LIMIT 50').bind(shopId).all()).results};}
 };
}
