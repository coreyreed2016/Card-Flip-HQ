'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, missingConfig, MARKETPLACES } = require('./config');
const { createTokenStore } = require('./token-store');
const { createEbayClient, EbayError } = require('./ebay-client');
const { createLedger } = require('./ledger');
const { createPhotoStore } = require('./photos');
const { createService, AppError } = require('./listing-service');

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ebay-ui.js': ['ebay-ui.js', 'text/javascript; charset=utf-8'],
  '/ebay.css': ['ebay.css', 'text/css; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/storage.js': ['storage.js', 'text/javascript; charset=utf-8'],
  '/calculations.js': ['calculations.js', 'text/javascript; charset=utf-8']
};

function createApp({ config, fetchImpl, sleep, minIntervalMs, env = process.env } = {}) {
  config = config || loadConfig(env);
  const tokenStore = createTokenStore({ dir: config.dataDir, key: config.tokenKey });
  const client = createEbayClient({ config, tokenStore, fetchImpl, sleep, minIntervalMs });
  const ledger = createLedger({ dir: config.dataDir });
  const photos = createPhotoStore({ dir: config.dataDir });
  const service = createService({ config, client, ledger, photos });
  const pendingStates = new Map();

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...headers });
    res.end(isBuf ? body : JSON.stringify(body));
  };

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', c => {
        n += c.length;
        if (n > limit) { reject(new AppError('Request body is too large.', 'TOO_LARGE', 413)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    const buf = await readBody(req, 1024 * 1024);
    if (!buf.length) return {};
    try { const v = JSON.parse(buf.toString('utf8')); if (v && typeof v === 'object') return v; } catch { /* fall through */ }
    throw new AppError('Request body must be valid JSON.');
  }

  function hostOk(req) {
    const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return ['localhost', '127.0.0.1', '[::1]'].includes(h);
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { const u = new URL(o); return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && u.host === req.headers.host; } catch { return false; }
  }

  function status() {
    const missing = missingConfig(config);
    let tokens = null, tokenProblem = null;
    if (!missing.length) { try { tokens = tokenStore.get(config.ebayEnv); } catch (e) { tokenProblem = e.message; } }
    const now = Date.now();
    return {
      environment: config.ebayEnv, configured: !missing.length, missingConfig: missing,
      connected: !!tokens, tokenProblem,
      connectedAt: tokens?.connectedAt || null,
      authorizationExpired: !!(tokens && tokens.refreshExpiresAt && tokens.refreshExpiresAt < now),
      authorizationExpiresAt: tokens?.refreshExpiresAt ? new Date(tokens.refreshExpiresAt).toISOString() : null,
      marketplaces: Object.entries(MARKETPLACES).map(([id, m]) => ({ id, label: m.label, currency: m.currency })),
      callbackUrl: `http://localhost:${config.port}/api/ebay/callback`
    };
  }

  function errorPayload(e) {
    if (e instanceof AppError) return [e.status, { error: e.message, code: e.code, details: e.details }];
    if (e instanceof EbayError) {
      const st = e.code === 'RATE_LIMITED' ? 429 : ['NOT_CONNECTED', 'AUTH_EXPIRED', 'AUTH_FAILED'].includes(e.code) ? 401 : e.ambiguous ? 504 : 502;
      return [st, { error: e.message, code: e.code, ebayStatus: e.status, retryAfter: e.retryAfter }];
    }
    if (e && e.code === 'IN_PROGRESS') return [409, { error: e.message, code: 'IN_PROGRESS' }];
    if (e && ['NO_ENCRYPTION_KEY', 'TOKEN_DECRYPT_FAILED'].includes(e.code)) return [500, { error: e.message, code: e.code }];
    if (e && ['BAD_REQUEST', 'TOO_LARGE', 'BAD_IMAGE'].includes(e.code)) return [e.code === 'TOO_LARGE' ? 413 : 400, { error: e.message, code: e.code }];
    console.error('Unexpected error:', e && e.message);
    return [500, { error: 'Unexpected server error.', code: 'INTERNAL' }];
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (m !== 'GET' && m !== 'HEAD' && req.headers['x-aura-client'] !== '1') throw new AppError('Missing client header.', 'FORBIDDEN', 403);
    const mpId = url.searchParams.get('marketplace') || undefined;

    if (p === '/api/ebay/status' && m === 'GET') return send(res, 200, status());

    if (p === '/api/ebay/connect' && m === 'POST') {
      const miss = missingConfig(config);
      if (miss.length) throw new AppError(`Server is not configured. Set in .env: ${miss.join(', ')}.`, 'NOT_CONFIGURED', 503);
      const state = client.newState();
      pendingStates.set(state, Date.now() + 10 * 60 * 1000);
      for (const [k, v] of pendingStates) if (v < Date.now()) pendingStates.delete(k);
      return send(res, 200, { url: client.authorizeUrl(state) });
    }
    if (p === '/api/ebay/callback' && m === 'GET') {
      const state = url.searchParams.get('state') || '';
      const exp = pendingStates.get(state);
      pendingStates.delete(state);
      const back = r => send(res, 302, '', { Location: `/?ebay=${r}#settings` });
      if (url.searchParams.get('error')) return back('declined');
      if (!exp || exp < Date.now()) return back('badstate');
      try { await client.exchangeCode(url.searchParams.get('code') || ''); return back('connected'); }
      catch (e) { console.error('OAuth exchange failed:', e.code); return back('failed'); }
    }
    if (p === '/api/ebay/disconnect' && m === 'POST') { tokenStore.clear(config.ebayEnv); return send(res, 200, { ok: true }); }
    if (p === '/api/ebay/test' && m === 'POST') return send(res, 200, await service.testConnection());
    if (p === '/api/ebay/setup' && m === 'GET') return send(res, 200, await service.setup(mpId));
    if (p === '/api/ebay/location' && m === 'POST') return send(res, 200, await service.createLocation(await readJson(req)));
    if (p === '/api/ebay/categories' && m === 'GET') return send(res, 200, { suggestions: await service.categorySuggestions(url.searchParams.get('q'), mpId) });

    if (p === '/api/ebay/prepare' && m === 'POST') return send(res, 200, await service.prepare(await readJson(req)));
    if (p === '/api/ebay/stage' && m === 'POST') return send(res, 200, await service.stage(await readJson(req)));
    if (p === '/api/ebay/publish' && m === 'POST') return send(res, 200, await service.publish(await readJson(req)));
    if (p === '/api/ebay/discard' && m === 'POST') return send(res, 200, await service.discard(await readJson(req)));
    if (p === '/api/ebay/sync' && m === 'POST') return send(res, 200, { results: await service.sync(await readJson(req)) });

    if (p === '/api/ebay/bulk/stage' && m === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { results: await bulk(body, it => service.stage({ ...it, marketplaceId: body.marketplaceId, prefs: body.prefs })) });
    }
    if (p === '/api/ebay/bulk/publish' && m === 'POST') {
      const body = await readJson(req);
      if (body.approved !== true) throw new AppError('Bulk publishing requires explicit approval of the selected batch.', 'APPROVAL_REQUIRED');
      return send(res, 200, { results: await bulk(body, it => service.publish({ ...it, marketplaceId: body.marketplaceId, approved: true, acknowledgeWarnings: body.acknowledgeWarnings === true })) });
    }

    if (p === '/api/photos' && m === 'POST') {
      const buf = await readBody(req, 12 * 1024 * 1024 + 1);
      const rec = photos.save(buf, { inventoryId: url.searchParams.get('inventoryId'), role: url.searchParams.get('role'), name: url.searchParams.get('name') });
      return send(res, 201, { id: rec.id, role: rec.role, name: rec.name });
    }
    const pm = p.match(/^\/api\/photos\/([a-f0-9]{24})$/);
    if (pm && m === 'GET') {
      const f = photos.read(pm[1]);
      if (!f) throw new AppError('Photo not found.', 'NOT_FOUND', 404);
      return send(res, 200, f.buffer, { 'Content-Type': f.rec.mime });
    }
    if (pm && m === 'DELETE') { photos.remove(pm[1]); return send(res, 200, { ok: true }); }
    throw new AppError('Unknown API route.', 'NOT_FOUND', 404);
  }

  /** Sequential processing keeps within eBay rate limits; one failure never aborts the others. */
  async function bulk(body, fn) {
    const items = body.items;
    if (!Array.isArray(items) || !items.length) throw new AppError('Select at least one item.');
    if (items.length > 50) throw new AppError('Bulk operations are limited to 50 items at a time.');
    const results = [];
    let halted = null;
    for (const it of items) {
      const key = it.sku || it.item?.id || null;
      if (halted) { results.push({ key, ok: false, notAttempted: true, error: halted }); continue; }
      try { results.push({ key, ...(await fn(it)) }); }
      catch (e) {
        const [, payload] = errorPayload(e);
        results.push({ key, ok: false, error: payload.error, code: payload.code });
        if (['RATE_LIMITED', 'AUTH_EXPIRED', 'NOT_CONNECTED', 'AUTH_FAILED'].includes(payload.code)) halted = `Stopped because: ${payload.error}`;
      }
    }
    return results;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'Forbidden host.' });
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (!originOk(req)) return send(res, 403, { error: 'Cross-origin requests are not allowed.' });
        return await api(req, res, url);
      }
      const s = STATIC[url.pathname];
      if (!s || (req.method !== 'GET' && req.method !== 'HEAD')) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      const buf = fs.readFileSync(path.join(config.root, s[0]));
      return send(res, 200, buf, { 'Content-Type': s[1] });
    } catch (e) {
      if (res.headersSent) return res.end();
      const [st, payload] = errorPayload(e);
      send(res, st, payload, payload.retryAfter ? { 'Retry-After': String(payload.retryAfter) } : {});
    }
  });
  return { server, service, ledger, photos, tokenStore, client, config };
}

if (require.main === module) {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* no .env yet */ }
  const app = createApp();
  const miss = missingConfig(app.config);
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`Aura Exchange running at http://localhost:${app.config.port}  (eBay ${app.config.ebayEnv.toUpperCase()})`);
    if (miss.length) console.log(`eBay not configured yet. Missing in .env: ${miss.join(', ')}`);
  });
}

module.exports = { createApp };
