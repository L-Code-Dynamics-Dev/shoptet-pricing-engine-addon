import {createMcpOAuth,oauthConfiguration,OAuthError,MCP_SCOPES,randomSecret,digest} from '../../../../packages/core/src/mcp-oauth.mjs';
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store',pragma:'no-cache',...headers}});
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function unique(params){const keys=[...params.keys()];if(new Set(keys).size!==keys.length)throw new OAuthError('invalid_request');return Object.fromEntries(params);}
async function form(request){if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new OAuthError('invalid_request');const body=await request.text();if(body.length>8192)throw new OAuthError('invalid_request');return unique(new URLSearchParams(body));}
export async function handleOAuth(request,env) {
 let config,headers={};
 try{
  config=oauthConfiguration(env);const url=new URL(request.url);
  if(url.origin!==config.origin)throw new OAuthError('invalid_request');
  const metadata={issuer:config.origin,authorization_endpoint:config.origin+'/oauth/authorize',token_endpoint:config.origin+'/oauth/token',revocation_endpoint:config.origin+'/oauth/revoke',revocation_endpoint_auth_methods_supported:['none'],response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:MCP_SCOPES};
  if(request.method==='GET' && url.pathname==='/.well-known/oauth-authorization-server')return json(metadata);
  if(request.method==='GET' && ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(url.pathname))return json({resource:config.resource,authorization_servers:[config.origin],scopes_supported:MCP_SCOPES,bearer_methods_supported:['header']});
  const origin=request.headers.get('origin');
  if(origin){if(origin!==config.origin&&!config.clients.some(c=>c.redirect_uris.some(u=>new URL(u).origin===origin)))return json({error:'origin_denied'},403);headers={'access-control-allow-origin':origin,vary:'Origin'};}
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'access-control-allow-methods':'POST','access-control-allow-headers':'Content-Type'}});
  const bucket=await digest(url.pathname+':'+(request.headers.get('cf-connecting-ip')||'unknown'));
  const window=Math.floor(Date.now()/60000);
  const rate=await env.DB.prepare('INSERT INTO mcp_oauth_rate_limits(bucket,window,requests) VALUES(?,?,1) ON CONFLICT(bucket,window) DO UPDATE SET requests=requests+1 RETURNING requests').bind(bucket,window).first();
  if(rate.requests>120)return json({error:'rate_limited'},429,{...headers,'retry-after':'60'});
  await env.DB.prepare('DELETE FROM mcp_oauth_rate_limits WHERE window<?').bind(window-60).run();
  const service=createMcpOAuth(env.DB,config);
  if(url.pathname==='/oauth/authorize' && request.method==='GET'){
   await env.DB.prepare('DELETE FROM mcp_authorizations WHERE request_id IN(SELECT request_id FROM mcp_authorizations WHERE expires_at<unixepoch() LIMIT 200)').bind().run();
   const browser=randomSecret();const started=await service.begin(unique(url.searchParams),browser);
   const nonce=randomSecret();
   const html=`<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Připojení AI asistenta</title><style>body{font:16px system-ui;max-width:650px;margin:8vh auto;padding:24px}code{display:block;overflow-wrap:anywhere;padding:16px;background:#f1f3f5}p{line-height:1.6}</style><h1>Připojit ${escape(started.clientName)}</h1><p>V administraci svého Shoptetu otevřete doplněk → AI asistent. Vložte tento jednorázový připojovací kód, zkontrolujte klienta a oprávnění a potvrďte připojení.</p><code>${started.requestId}</code><p id="status">Čekám na vaše potvrzení. Kód platí 10 minut. Toto okno nechte otevřené.</p><script nonce="${nonce}">let attempts=0;async function poll(){try{const r=await fetch('/oauth/finish',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request_id:'${started.requestId}'})});const data=await r.json();if(data.redirect){location.assign(data.redirect);return}if(!r.ok)throw Error();if(++attempts<300)setTimeout(poll,2000);else throw Error();}catch{document.getElementById('status').textContent='Připojení vypršelo nebo selhalo. Spusťte nové připojení v AI klientovi.'}}poll();</script></html>`;
   return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,'set-cookie':`oauth_${started.requestId}=${browser}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Strict`}});
  }
  if(url.pathname==='/oauth/finish' && request.method==='POST'){
   if(request.headers.get('origin')!==config.origin)throw new OAuthError('invalid_request');
   const params=await form(request);if(!/^[a-f0-9]{64}$/.test(params.request_id??''))throw new OAuthError('invalid_request');
   const browser=request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('oauth_'+params.request_id+'='))?.split('=')[1];
   if(!/^[a-f0-9]{64}$/.test(browser??''))throw new OAuthError('invalid_request');
   return json(await service.finish(params.request_id,browser));
  }
  if(url.pathname==='/oauth/revoke' && request.method==='POST')return json(await service.revoke(await form(request)),200,headers);
  if(url.pathname==='/oauth/token' && request.method==='POST'){
   const params=await form(request);
   if(params.grant_type==='authorization_code')return json(await service.exchange(params),200,headers);
   if(params.grant_type==='refresh_token')return json(await service.refresh(params),200,headers);
   throw new OAuthError('unsupported_grant_type');
  }
  return json({error:'invalid_request'},400,headers);
 }catch(e){return json({error:e instanceof OAuthError?e.code:'server_error'},e?.code==='server_not_configured'?503:400,headers);}
}
