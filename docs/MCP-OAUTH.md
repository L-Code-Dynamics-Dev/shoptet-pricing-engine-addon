# MCP authorization code + PKCE

## Implemented surface

The addon is both the MCP resource server and its OAuth authorization server.
It supports **pre-registered public clients** using authorization code + S256 PKCE,
resource indicators, short-lived opaque access tokens and rotating refresh tokens.
This is implemented and tested through HTTP with real SQLite, not yet verified
with a deployed D1 instance or a named third-party AI client.

Endpoints:

- `GET /.well-known/oauth-protected-resource/mcp` (also root metadata URI).
- `GET /.well-known/oauth-authorization-server`.
- `GET /oauth/authorize`.
- `POST /oauth/token` (`application/x-www-form-urlencoded`).
- `POST /oauth/revoke` (registered public client ID and token; invalid tokens return success).
- `POST /oauth/finish` (internal same-origin browser polling, HttpOnly transaction proof).
- Signed-admin APIs `/admin/settings/api/oauth/inspect`, `/consent`, `/connections`, `/disconnect`.

The unauthenticated MCP challenge links to protected-resource metadata when OAuth
configuration is valid. OAuth is disabled with a 503 when configuration is missing.
Dynamic registration and remote client-metadata fetching are not implemented.
No arbitrary client-provided URL is fetched. Implicit grant, plain PKCE, wildcard
redirects and password/client-credentials grants are not supported.

## Required configuration

`MCP_PUBLIC_ORIGIN`: exact canonical HTTPS origin serving this Worker.

`MCP_OAUTH_CLIENTS`: JSON array of operator-approved public clients, for example:

```json
[{"client_id":"<registered-client-id>","name":"<display-name>","redirect_uris":["https://<client-host>/<exact-callback>"]}]
```

These are deployment settings, not merchant data or secret client passwords.
Public clients authenticate with PKCE rather than a shared secret. Callback URIs
must match exactly; no suffix/prefix matching, fragments, URL credentials or HTTP.
Obtain the actual callback URI from the chosen client's official documentation.
Do not claim compatibility merely from the application name. Browser JavaScript
clients that send Origin on MCP requests are currently rejected by the MCP gateway;
use a compatible server/native remote-MCP client. Token endpoint CORS only permits
pre-registered callback origins and the canonical addon origin.

Existing `ADMIN_SESSION_SECRET` and verified Shoptet admin session flow protect
consent. Existing Shoptet vault secrets are separate; OAuth client configuration
never contains Shoptet credentials. MCP scopes remain domain-restricted and
server-enforced, including separate proposal creation and approved-save scopes.

## Merchant connection flow

1. A compatible pre-registered MCP client discovers metadata and opens
   `/oauth/authorize` with its redirect URI, resource, opaque state, scopes and
   S256 challenge. The access resource is exactly `<MCP_PUBLIC_ORIGIN>/mcp`.
2. The authorization browser window displays a random one-time **connection code**.
   It is not an API/access/refresh token. The merchant opens the installed addon,
   selects **AI asistent** and enters this code. No API token is copied.
3. The authenticated administration displays the client name, exact callback and
   requested scopes. The merchant explicitly confirms these permissions. Tenant
   identity comes exclusively from the signed admin session, never a model's shop ID.
4. The original browser window holds an independent HttpOnly/Secure/SameSite=Strict
   transaction cookie. Only this browser can complete the request and receive the
   redirect with a 60-second authorization code and original client state.
5. The client exchanges the code with its verifier and exact resource/redirect.
   The code is claimed transactionally once; no code, verifier or refresh token is
   stored in plaintext. Authorization requests expire after 10 minutes.
6. Access tokens expire after 10 minutes. Refresh grants expire after 30 days and
   rotate on every successful refresh. Rotation revokes prior access tokens.
   Detected retired-refresh reuse, including competing refresh claims, revokes
   the entire grant family. Clients must serialize refresh and restart connection
   after an ambiguous refresh result rather than retry an old refresh token.
7. The administration lists client grants, granted scopes, timestamps and revoke
   controls. Revocation is tenant-scoped and immediately denies current access
   tokens and future refreshes. The last authenticated MCP connection is recorded;
   it is not evidence that any pricing mutation succeeded.

The connection-code handoff is an explicit UX choice for Shoptet iframe login,
where the OAuth authorization browser cannot assume access to an admin session.
No admin-session bearer is passed in URLs or copied to the AI application.
A failed/reloaded browser completion may require restarting the connection; an
issued authorization code is deliberately not redisplayed from stored state.

## Security, storage and limits

Migration `0012_mcp_oauth.sql` adds authorization requests, grant metadata, retired
refresh hashes and rate counters; credentials link to a grant. Every issued MCP
access token is SHA-256 hashed and joins an active installation and unrevoked,
correct-audience tenant grant on each request. Revocation/rotation triggers revoke
associated access credentials. OAuth consent does not approve pricing revisions:
that remains a separate trusted, one-time approval action.

Authorization and token requests reject duplicate fields, foreign Origins,
unregistered clients/redirects, unsupported scopes, incorrect verifier/resource,
expired codes, replay and missing browser proof. Public OAuth mutation endpoints
have fixed-window D1 rate counters (120 requests/path/IP/minute); hashed IP buckets
expire after one hour. CF-Connecting-IP is trusted only behind the Cloudflare
Worker ingress. Authorization-request cleanup is bounded to 200 expired records
per new authorization. Operational retention and monitoring for grant/history
metadata remain release work.

Migration and tests were executed locally only. Before deployment, apply forward
migrations to isolated D1, provision clients and canonical origin, validate the
real Shoptet administrator authentication flow and test the actual chosen MCP
client. Then test code/refresh replay, disconnect, CORS, callback cookies and
concurrent requests on Cloudflare. No production deployment is authorized here.
Do not roll back to a resource-server version that lacks audience checks while
OAuth grants are enabled; revoke grants first and retain a vault-aware runtime.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 9728 protected resources](https://www.rfc-editor.org/rfc/rfc9728.html),
[RFC 7009 revocation](https://www.rfc-editor.org/rfc/rfc7009.html).
