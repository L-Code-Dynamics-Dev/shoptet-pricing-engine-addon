import {retryInstallations} from '../../../packages/core/src/installation-verification.mjs';
import {handleOAuth} from './oauth/routes.mjs';
import { handleMerchantMcp } from './mcp/gateway.mjs';
import { handleMcp, handleMcpSse, handleMcpMessage } from './mcp/server.mjs';
import { handleAdmin } from './admin.mjs';
import { handleAdminSettingsIframe, handleAdminSettingsApi } from './iframe-settings.mjs';
import { handleShoptetInstall, handleShoptetUninstall, handleShoptetStatus, handleShoptetApiTest } from './shoptet-routes.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default {
  async scheduled(controller,env){await retryInstallations(env);},
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/oauth-')) return handleOAuth(request,env);

    if (url.pathname === '/mcp') return handleMerchantMcp(request, env);
    if (url.pathname.startsWith('/mcp/')) return json({ error: 'legacy_transport_removed', endpoint: '/mcp' }, 410);

    // Admin asset approvals
    if (url.pathname === '/admin/asset-approvals') {
      return handleAdmin(request, env);
    }

    // Shoptet Admin iFrame Settings UI
    if (url.pathname === '/admin/settings') {
      return handleAdminSettingsIframe(request, env);
    }
    if (url.pathname.startsWith('/admin/settings/api/')) {
      return handleAdminSettingsApi(request, env, ctx);
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        addon: 'L-Code Loyalty Pricing Engine',
        version: '0.1.0',
        status: 'ok',
        liveWrites: false
      });
    }

    // Shoptet OAuth installation endpoint (redirect_uri)
    if (url.pathname === '/shoptet/install') {
      return handleShoptetInstall(request, env, fetch, ctx);
    }

    // Unauthenticated legacy shop-ID endpoints cannot manage or inspect tenants.
    if (['/shoptet/uninstall','/shoptet/status','/shoptet/api-test'].includes(url.pathname)) return json({ error: 'trusted_lifecycle_authentication_required' }, 403);

    if (url.pathname.startsWith('/admin/') || url.pathname.startsWith('/sync/')) {
      return json({ error: 'authentication_not_configured' }, 403);
    }

    return json({ error: 'not_found' }, 404);
  }
};
