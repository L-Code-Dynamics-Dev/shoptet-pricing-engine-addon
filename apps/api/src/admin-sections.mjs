/**
 * Tenant-scoped UI configuration schemas.
 * These settings are drafts for future Shoptet adapters; saving never runs a sync.
 */
export const UI_DEFAULTS = Object.freeze({
  settings: { enabled: false, currency: 'CZK', verifyWrites: true, rounding: 2 },
  pricelists: [],
  categories: [],
  products: [],
  brandSales: [],
  coupons: { enabled: true, mode: 'fixed-amount', maxPercent: 20, lockedTiers: [], disabledBrands: [], disabledProducts: [] },
  sync: { incremental: true, intervalMinutes: 30, dryRun: true }
});
const hasOwn = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const boolean = (v, name) => { if (typeof v !== 'boolean') throw Error(name + ': očekává se ano/ne.'); return v; };
const numeric = (v, name, min, max, integer = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v)))
    throw Error(name + ': neplatná číselná hodnota.');
  return v;
};
const word = (v, name, max = 100) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f]/.test(v))
    throw Error(name + ': neplatná hodnota.');
  return v.trim();
};
const only = (v, keys) => {
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) throw Error('Neplatná pole nastavení.');
};
const names = (v, name, maxItems = 100) => {
  if (!Array.isArray(v) || v.length > maxItems) throw Error(name + ': neplatný seznam.');
  const out = v.map(x => word(x, name));
  if (new Set(out.map(x => x.toLocaleLowerCase('cs'))).size !== out.length) throw Error(name + ': duplicitní položky.');
  return out;
};
const rows = (v, type, maxItems = 100) => {
  if (!Array.isArray(v) || v.length > maxItems) throw Error(type + ': neplatný seznam.');
  const ids = new Set();
  return v.map((x, i) => {
    const label = type + ' #' + (i + 1);
    const keys = type === 'pricelists' ? ['name', 'id', 'tierName'] : ['id', 'name', 'limit'];
    only(x, keys);
    const id = word(x.id, label + ' ID');
    if (ids.has(id.toLowerCase())) throw Error(type + ': duplicitní ID.');
    ids.add(id.toLowerCase());
    if (type === 'pricelists') return { id, name: word(x.name, label + ' název'), tierName: word(x.tierName, label + ' úroveň') };
    const limit = numeric(x.limit, label + ' sleva', 0, 100);
    return { id, name: word(x.name, label + ' název'), limit };
  });
};
export function validateUiSection(section, value) {
  try {
    switch (section) {
      case 'settings': {
        only(value, ['enabled', 'currency', 'verifyWrites', 'rounding']);
        if (!['CZK', 'EUR'].includes(value.currency)) throw Error('Neznámá měna.');
        return { value: {
          enabled: boolean(value.enabled, 'Aktivace'),
          currency: value.currency,
          verifyWrites: boolean(value.verifyWrites, 'Kontrola cen'),
          rounding: numeric(value.rounding, 'Zaokrouhlení', 0, 4, true)
        }};
      }
      case 'pricelists': return { value: rows(value, section, 30) };
      case 'categories': return { value: rows(value, section, 200) };
      case 'products': return { value: rows(value, section, 200) };
      case 'brandSales': return { value: rows(value, section, 100) };
      case 'coupons': {
        only(value, ['enabled', 'mode', 'maxPercent', 'lockedTiers', 'disabledBrands', 'disabledProducts']);
        if (!['fixed-amount', 'percentage'].includes(value.mode)) throw Error('Neznámý režim kupónů.');
        return { value: {
          enabled: boolean(value.enabled, 'Kupóny'),
          mode: value.mode,
          maxPercent: numeric(value.maxPercent, 'Maximální sleva', 0, 100),
          lockedTiers: names(value.lockedTiers, 'Úrovně', 30),
          disabledBrands: names(value.disabledBrands, 'Značky', 100),
          disabledProducts: names(value.disabledProducts, 'Produkty', 200)
        }};
      }
      case 'sync': {
        only(value, ['incremental', 'intervalMinutes', 'dryRun']);
        return { value: {
          incremental: boolean(value.incremental, 'Inkrementální synchronizace'),
          intervalMinutes: numeric(value.intervalMinutes, 'Interval', 5, 1440, true),
          dryRun: boolean(value.dryRun, 'Testovací režim')
        }};
      }
      default: return { error: 'Neznámá sekce.' };
    }
  } catch (e) { return { error: e.message }; }
}
