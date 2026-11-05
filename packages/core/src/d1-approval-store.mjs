// One-time, tenant-bound approval consumption. Approval creation must happen
// through an authenticated administrator workflow, never through MCP.
const ID = /^[A-Za-z0-9_-]{16,96}$/;
export function createD1ApprovalStore(db, now = () => Date.now()) {
  if (!db || typeof db.prepare !== 'function' || typeof now !== 'function') throw new Error('Approval store unavailable');
  return {
    async claim({shopId, approvalId}) {
      if (typeof shopId !== 'string' || !shopId || !ID.test(approvalId ?? '')) return null;
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid clock');
      // Single conditional UPDATE is atomic in SQLite/D1; only one concurrent
      // caller can transition approved -> claimed. Never SELECT then UPDATE.
      const update = await db.prepare(`UPDATE asset_install_approvals
        SET state='claimed', claimed_at_ms=?
        WHERE approval_id=? AND shop_id=? AND state='approved'
          AND expires_at_ms>?`).bind(timestamp, approvalId, shopId, timestamp).run();
      if (update?.meta?.changes !== 1) return null;
      const row = await db.prepare(`SELECT shop_id,release_id,manifest_json,expires_at_ms
        FROM asset_install_approvals WHERE approval_id=? AND shop_id=? AND state='claimed'
          AND claimed_at_ms=?`).bind(approvalId, shopId, timestamp).first();
      if (!row) throw new Error('Approval claim inconsistent');
      let manifest;
      try { manifest = JSON.parse(row.manifest_json); } catch { throw new Error('Invalid approved manifest'); }
      return {shopId:row.shop_id,status:'approved',expiresAt:row.expires_at_ms,releaseId:row.release_id,manifest};
    }
  };
}
