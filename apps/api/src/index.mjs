import { handleMcp } from './mcp/server.mjs';
import { handleAdmin } from './admin.mjs';
// Security-first Cloudflare Worker scaffold. No live Shoptet operations are enabled.
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/mcp') return handleMcp(request, env);
    if (url.pathname === '/admin/asset-approvals') return handleAdmin(request, env);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({status:'ok', mode:'scaffold', liveWrites:false});
    }
    if (url.pathname === '/shoptet/install' || url.pathname === '/shoptet/uninstall') {
      // Installation cannot be implemented securely until the exact approved
      // Shoptet partner callback contract and signature scheme are verified.
      return json({error:'integration_not_configured'}, 503);
    }
    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/sync/')) {
      // Never accept a global shared token or an unverified shop ID.
      return json({error:'authentication_not_configured'}, 403);
    }
    return json({error:'not_found'}, 404);
  }
};
