'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../server/config');
const { createApp } = require('../server/server');

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

/** In-memory fake of the eBay REST endpoints this app uses. It is NOT eBay Sandbox. */
function mockEbay(opts = {}) {
  const state = { offers: {}, items: {}, calls: [], nextOffer: 1000, fail: {}, tokenCalls: 0, images: 0 };
  const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const key = `${method} ${u.pathname}`;
    state.calls.push(key);
    if (state.fail[key]) { const f = state.fail[key]; if (f.times === undefined || f.times-- > 0) { if (f.throw) throw new Error(f.throw); return json(f.status, f.body || {}); } }
    if (u.pathname === '/identity/v1/oauth2/token') {
      state.tokenCalls++;
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'refresh_token' && opts.refreshFails) return json(400, { error: 'invalid_grant', error_description: 'refresh token expired' });
      return json(200, { access_token: 'AT' + state.tokenCalls, expires_in: 7200, refresh_token: 'RT', refresh_token_expires_in: 47304000 });
    }
    if (u.pathname === '/commerce/media/v1_beta/image/create_image_from_file') { state.images++; return json(201, { imageUrl: `https://i.ebayimg.com/img${state.images}.jpg`, expirationDate: new Date(Date.now() + 30 * 86400000).toISOString() }); }
    if (u.pathname.startsWith('/commerce/taxonomy/')) return json(200, { aspects: [] });
    let m;
    if ((m = u.pathname.match(/^\/sell\/inventory\/v1\/inventory_item\/(.+)$/)) && method === 'PUT') { state.items[decodeURIComponent(m[1])] = JSON.parse(init.body); return new Response(null, { status: 204 }); }
    if (u.pathname === '/sell/inventory/v1/offer' && method === 'GET') {
      const sku = u.searchParams.get('sku');
      const offers = Object.values(state.offers).filter(o => o.sku === sku);
      return offers.length ? json(200, { offers }) : json(404, { errors: [{ errorId: 25713, message: 'No offer found' }] });
    }
    if (u.pathname === '/sell/inventory/v1/offer' && method === 'POST') {
      const b = JSON.parse(init.body);
      const offerId = String(state.nextOffer++);
      state.offers[offerId] = { ...b, offerId, status: 'UNPUBLISHED' };
      return json(201, { offerId });
    }
    if ((m = u.pathname.match(/^\/sell\/inventory\/v1\/offer\/(\d+)\/publish$/)) && method === 'POST') {
      const o = state.offers[m[1]];
      o.status = 'PUBLISHED'; o.listing = { listingId: '2900' + m[1], listingStatus: 'ACTIVE', soldQuantity: 0 };
      return json(200, { listingId: o.listing.listingId });
    }
    if ((m = u.pathname.match(/^\/sell\/inventory\/v1\/offer\/(\d+)$/))) {
      const o = state.offers[m[1]];
      if (!o) return json(404, { errors: [{ message: 'not found' }] });
      if (method === 'GET') return json(200, o);
      if (method === 'PUT') { state.offers[m[1]] = { ...o, ...JSON.parse(init.body) }; return new Response(null, { status: 204 }); }
      if (method === 'DELETE') { delete state.offers[m[1]]; return new Response(null, { status: 204 }); }
    }
    if (u.pathname === '/sell/account/v1/privilege') return json(200, { sellerRegistrationCompleted: true });
    if (u.pathname === '/commerce/identity/v1/user/') return json(200, { username: 'testuser', userId: 'u1' });
    if (u.pathname === '/sell/fulfillment/v1/order') return json(200, { total: 0, orders: state.orders || [] });
    return json(404, { errors: [{ message: 'mock: unhandled ' + key }] });
  }
  return { fetchImpl, state };
}

function makeApp(mock = mockEbay(), extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
  const env = { EBAY_ENV: 'sandbox', EBAY_CLIENT_ID: 'cid', EBAY_CLIENT_SECRET: 'sec', EBAY_RUNAME: 'ru', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), AURA_DATA_DIR: dir, PORT: '0', ...extraEnv };
  const config = loadConfig(env);
  const app = createApp({ config, fetchImpl: mock.fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
  return { ...app, mock, dir };
}

function connect(app) {
  app.tokenStore.set('sandbox', { accessToken: 'AT0', accessExpiresAt: Date.now() + 3600e3, refreshToken: 'RT', refreshExpiresAt: Date.now() + 1e10, connectedAt: new Date().toISOString() });
}

const prefs = { merchantLocationKey: 'home', fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1', shippingCharged: 0, shippingCost: 450, packagingCost: 100, feePercent: 13.25, perOrderFee: 40, minProfit: 500 };

function sampleItem(app, over = {}) {
  const id = over.id || 'inv_test1';
  const front = app.photos.save(JPG, { inventoryId: id, role: 'front', name: 'f.jpg' });
  const back = app.photos.save(JPG, { inventoryId: id, role: 'back', name: 'b.jpg' });
  return {
    id, cardName: 'Charizard', pokemon: 'Charizard', set: 'Base Set', cardNumber: '4/102', releaseYear: '1999', language: 'English',
    variant: 'Rare Holo', condition: 'Near Mint (NM)', gradingStatus: 'Raw / Ungraded', quantity: 1, acquisitionCost: 5000, targetSalePrice: 20000,
    sku: 'AUR-TEST-1', photos: [{ id: front.id, role: 'front' }, { id: back.id, role: 'back' }], ...over
  };
}

module.exports = { mockEbay, makeApp, connect, prefs, sampleItem, JPG };
