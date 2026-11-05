import { handleMcp, handleMcpSse, handleMcpMessage } from './mcp/server.mjs';
import { handleAdmin } from './admin.mjs';
import { handleAdminSettingsIframe } from './iframe-settings.mjs';
import { handleShoptetInstall, handleShoptetUninstall, handleShoptetStatus, handleShoptetApiTest } from './shoptet-routes.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // MCP server endpoints (Universal /mcp + explicit /mcp/sse and /mcp/message)
    if (url.pathname === '/mcp') {
      if (request.method === 'GET' && request.headers.get('accept')?.includes('text/event-stream')) {
        return handleMcpSse(request, env);
      }
      return handleMcp(request, env);
    }
    if (url.pathname === '/mcp/sse') {
      return handleMcpSse(request, env);
    }
    if (url.pathname === '/mcp/message') {
      return handleMcpMessage(request, env);
    }

    // Admin asset approvals
    if (url.pathname === '/admin/asset-approvals') {
      return handleAdmin(request, env);
    }

    // Shoptet Admin iFrame Settings UI
    if (url.pathname === '/admin/settings') {
      return handleAdminSettingsIframe(request, env);
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        addon: 'L-Code Loyalty Pricing Engine',
        version: '0.1.0',
        status: 'ok',
        partner_shop: '826800.myshoptet.com'
      });
    }

    // Shoptet OAuth installation endpoint (redirect_uri)
    if (url.pathname === '/shoptet/install') {
      return handleShoptetInstall(request, env);
    }

    // Shoptet uninstallation webhook
    if (url.pathname === '/shoptet/uninstall') {
      return handleShoptetUninstall(request, env);
    }

    // Shop installation status inquiry
    if (url.pathname === '/shoptet/status') {
      return handleShoptetStatus(request, env);
    }

    // Shoptet live API test
    if (url.pathname === '/shoptet/api-test') {
      return handleShoptetApiTest(request, env);
    }

    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/sync/')) {
      return json({ error: 'authentication_not_configured' }, 403);
    }

    return json({ error: 'not_found' }, 404);
  }
};
