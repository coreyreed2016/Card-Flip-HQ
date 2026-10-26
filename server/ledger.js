'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Server-side record of inventory item <-> eBay listing links. It protects against duplicates even if the
 * browser's localStorage is cleared, and serializes work per SKU so double-clicks/retries cannot overlap.
 */
function createLedger({ dir }) {
  const file = path.join(dir, 'ebay-listings.json');
  const locks = new Set();
  let cache = null;

  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cache = { records: {} }; }
    if (!cache.records) cache.records = {};
    return cache;
  }
  function persist() {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  }
  const k = (env, marketplaceId, sku) => `${env}:${marketplaceId}:${sku}`;

  return {
    get: (env, marketplaceId, sku) => load().records[k(env, marketplaceId, sku)] || null,
    upsert(env, marketplaceId, sku, patch) {
      const all = load();
      const key = k(env, marketplaceId, sku);
      all.records[key] = { ...(all.records[key] || {}), ...patch, sku, env, marketplaceId, updatedAt: new Date().toISOString() };
      persist();
      return all.records[key];
    },
    async withLock(env, marketplaceId, sku, fn) {
      const key = k(env, marketplaceId, sku);
      if (locks.has(key)) {
        const e = new Error(`A request for SKU ${sku} is already in progress. Wait for it to finish; this prevents duplicate listings.`);
        e.code = 'IN_PROGRESS';
        throw e;
      }
      locks.add(key);
      try { return await fn(); } finally { locks.delete(key); }
    }
  };
}

module.exports = { createLedger };
