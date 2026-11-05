export function assertTenantContext(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new Error('Missing tenant context');
  const { authenticatedShopId, requestedShopId } = ctx;
  if (!authenticatedShopId || typeof authenticatedShopId !== 'string') throw new Error('Unauthenticated shop');
  if (requestedShopId !== undefined && requestedShopId !== authenticatedShopId) {
    throw new Error('Cross-tenant access denied');
  }
  return authenticatedShopId;
}

export function safeSyncMode(configured, requested) {
  if (requested !== 'dry-run' && requested !== 'live') throw new Error('Invalid sync mode');
  if (requested === 'live' && configured !== 'live') throw new Error('Live writes disabled');
  return requested;
}
