'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, mockEbay, connect, prefs, sampleItem } = require('./helpers');
const { buildDraft, computeProfit } = require('../server/listing');
const fs = require('fs');
const path = require('path');

test('token store encrypts tokens at rest', () => {
  const app = makeApp(); connect(app);
  const raw = fs.readFileSync(path.join(app.dir, 'ebay-tokens.enc.json'), 'utf8');
  assert.ok(!raw.includes('AT0') && !raw.includes('RT'));
  assert.equal(app.tokenStore.get('sandbox').accessToken, 'AT0');
  app.tokenStore.clear('sandbox');
  assert.equal(app.tokenStore.get('sandbox'), null);
});

test('OAuth code exchange stores tokens; refresh works when access expired', async () => {
  const mock = mockEbay(); const app = makeApp(mock);
  await app.client.exchangeCode('code');
  assert.ok(app.tokenStore.get('sandbox').refreshToken);
  const t = app.tokenStore.get('sandbox'); t.accessExpiresAt = 0; app.tokenStore.set('sandbox', t);
  const r = await app.service.testConnection();
  assert.equal(r.ok, true); assert.equal(r.account.username, 'testuser');
});

test('expired refresh authorization produces a clear error', async () => {
  const app = makeApp(mockEbay({ refreshFails: true }));
  app.tokenStore.set('sandbox', { accessToken: 'x', accessExpiresAt: 0, refreshToken: 'RT', refreshExpiresAt: Date.now() + 1e10 });
  await assert.rejects(() => app.service.testConnection(), e => /authoriz|reconnect/i.test(e.message));
});

test('not connected is reported', async () => {
  const app = makeApp();
  await assert.rejects(() => app.service.testConnection(), e => e.code === 'NOT_CONNECTED');
});

test('validation: missing photos, price, condition, location', () => {
  const app = makeApp();
  const base = sampleItem(app);
  const d1 = buildDraft({ item: { ...base, photos: [] }, prefs, photoLookup: id => app.photos.get(id) });
  assert.ok(d1.errors.some(e => /photo/i.test(e)));
  const d2 = buildDraft({ item: { ...base, targetSalePrice: 0 }, prefs, photoLookup: id => app.photos.get(id) });
  assert.ok(d2.errors.some(e => /price/i.test(e)));
  const d3 = buildDraft({ item: { ...base, condition: '' }, prefs, photoLookup: id => app.photos.get(id) });
  assert.ok(d3.errors.some(e => /condition/i.test(e)));
  const d4 = buildDraft({ item: base, prefs: { ...prefs, merchantLocationKey: '' }, photoLookup: id => app.photos.get(id) });
  assert.ok(d4.errors.some(e => /location/i.test(e)));
  const d5 = buildDraft({ item: { ...base, gradingStatus: 'PSA Graded', gradingCompany: 'PSA', grade: '10' }, prefs, photoLookup: id => app.photos.get(id) });
  assert.ok(d5.errors.some(e => /verif/i.test(e)), 'unverified grade blocks');
  const ok = buildDraft({ item: base, prefs, photoLookup: id => app.photos.get(id) });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.quantity, 1);
  assert.equal(ok.priceCents, 20000);
});

test('listing quantity is 1 even when owning several', () => {
  const app = makeApp();
  const d = buildDraft({ item: sampleItem(app, { quantity: 5 }), prefs, photoLookup: id => app.photos.get(id) });
  assert.equal(d.quantity, 1);
});

test('profit math and loss warning', () => {
  const p = computeProfit({ priceCents: 10000, qty: 1, shippingCharged: 0, shippingCost: 450, packagingCost: 100, acquisitionCost: 9000, feePercent: 13.25, perOrderFee: 40, adRatePercent: 0 });
  assert.ok(p.estimatedProfit < 0);
  const app = makeApp();
  const d = buildDraft({ item: sampleItem(app, { acquisitionCost: 19900 }), prefs, photoLookup: id => app.photos.get(id) });
  assert.ok(d.warnings.some(w => /loss|below|minimum/i.test(w)));
});

test('stage creates unpublished offer; publish needs approval, then is confirmed', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const item = sampleItem(app);
  const s = await app.service.stage({ item, prefs });
  assert.equal(s.ok, true, JSON.stringify(s.draft?.errors));
  assert.equal(s.status, 'Offer Created');
  assert.equal(mock.state.images, 2);
  assert.ok(mock.state.items['AUR-TEST-1'].product.imageUrls[0].startsWith('https://i.ebayimg.com/'));
  assert.equal(Object.values(mock.state.offers)[0].status, 'UNPUBLISHED');
  assert.ok(!mock.state.calls.some(c => c.endsWith('/publish')), 'nothing published at stage');
  const args = { sku: s.sku, offerId: s.offerId, approvalToken: s.approvalToken };
  await assert.rejects(() => app.service.publish(args), e => e.code === 'APPROVAL_REQUIRED');
  await assert.rejects(() => app.service.publish({ ...args, approved: true, approvalToken: 'bad' }), e => e.code === 'STALE_APPROVAL');
  const pub = await app.service.publish({ ...args, approved: true, acknowledgeWarnings: true });
  assert.equal(pub.status, 'Active on eBay');
  assert.match(pub.listingUrl, /sandbox\.ebay\.com\/itm\/2900/);
  const rec = app.ledger.get('sandbox', 'EBAY_US', 'AUR-TEST-1');
  assert.equal(rec.listingId, pub.listingId); assert.equal(rec.status, 'Active on eBay');
});

test('duplicate prevention: staging an already-published SKU creates nothing new', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const item = sampleItem(app);
  const s = await app.service.stage({ item, prefs });
  await app.service.publish({ sku: s.sku, offerId: s.offerId, approvalToken: s.approvalToken, approved: true, acknowledgeWarnings: true });
  const again = await app.service.stage({ item, prefs });
  assert.equal(again.duplicate, true);
  assert.equal(Object.keys(mock.state.offers).length, 1);
  // publishing again returns the existing listing without a second publish call
  const before = mock.state.calls.filter(c => c.endsWith('/publish')).length;
  const p2 = await app.service.publish({ sku: s.sku, offerId: s.offerId, approvalToken: s.approvalToken, approved: true });
  assert.equal(p2.alreadyPublished, true);
  assert.equal(mock.state.calls.filter(c => c.endsWith('/publish')).length, before);
});

test('restaging reuses the existing unpublished offer (no duplicate offers)', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const item = sampleItem(app);
  await app.service.stage({ item, prefs });
  await app.service.stage({ item, prefs, overrides: { priceCents: 21000 } });
  assert.equal(Object.keys(mock.state.offers).length, 1);
});

test('timed-out offer creation is reconciled, not retried blindly', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const orig = mock.fetchImpl; let first = true;
  const wrapped = async (url, init) => {
    const r = await orig(url, init);
    if (first && init?.method === 'POST' && new URL(url).pathname === '/sell/inventory/v1/offer') { first = false; throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }
    return r;
  };
  const app2 = require('../server/server').createApp({ config: app.config, fetchImpl: wrapped, sleep: async () => {}, minIntervalMs: 0 });
  const s = await app2.service.stage({ item: sampleItem(app2), prefs });
  assert.equal(s.ok, true);
  assert.equal(Object.keys(mock.state.offers).length, 1, 'only one offer exists');
});

test('publish timeout that did not publish is reported as unconfirmed', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const s = await app.service.stage({ item: sampleItem(app), prefs });
  mock.state.fail[`POST /sell/inventory/v1/offer/${s.offerId}/publish`] = { throw: 'network down' };
  await assert.rejects(() => app.service.publish({ sku: s.sku, offerId: s.offerId, approvalToken: s.approvalToken, approved: true, acknowledgeWarnings: true }), e => !/is live/.test(e.message));
  assert.notEqual(app.ledger.get('sandbox', 'EBAY_US', s.sku).status, 'Active on eBay');
});

test('concurrent stage for same SKU is rejected', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const item = sampleItem(app);
  const r = await Promise.allSettled([app.service.stage({ item, prefs }), app.service.stage({ item, prefs })]);
  assert.ok(r.some(x => x.status === 'rejected' && x.reason.code === 'IN_PROGRESS') || Object.keys(mock.state.offers).length === 1);
  assert.equal(Object.keys(mock.state.offers).length, 1);
});

test('sync reports sold without touching anything else', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  const s = await app.service.stage({ item: sampleItem(app), prefs });
  await app.service.publish({ sku: s.sku, offerId: s.offerId, approvalToken: s.approvalToken, approved: true, acknowledgeWarnings: true });
  mock.state.offers[s.offerId].listing = { listingId: '2900' + s.offerId, listingStatus: 'ENDED', soldQuantity: 1 };
  const [r] = await app.service.sync({ items: [{ sku: s.sku }] });
  assert.equal(r.status, 'Sold');
});

test('API error from eBay surfaces a readable message', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  mock.state.fail['PUT /sell/inventory/v1/inventory_item/AUR-TEST-1'] = { status: 400, body: { errors: [{ errorId: 25002, message: 'Bad category' }] } };
  await assert.rejects(() => app.service.stage({ item: sampleItem(app), prefs }), e => /Bad category|eBay/.test(e.message));
});

test('rate limiting on offer lookup is retried then succeeds', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  mock.state.fail['GET /sell/inventory/v1/offer'] = { status: 429, times: 1 };
  const s = await app.service.stage({ item: sampleItem(app), prefs });
  assert.equal(s.ok, true);
});

test('HTTP: bulk partial failure, approval gate, and security checks', async () => {
  const mock = mockEbay(); const app = makeApp(mock); connect(app);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = (p, body, headers = {}) => fetch(`http://localhost:${port}${p}`, { method: body ? 'POST' : 'GET', headers: { 'X-Aura-Client': '1', 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  try {
    const good = sampleItem(app, { id: 'inv_a', sku: 'AUR-A' });
    const bad = sampleItem(app, { id: 'inv_b', sku: 'AUR-B', photos: [] });
    const r = await (await call('/api/ebay/bulk/stage', { items: [{ item: good }, { item: bad }], prefs })).json();
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].ok, true); assert.equal(r.results[1].ok, false);
    const noApprove = await call('/api/ebay/bulk/publish', { items: [{ sku: 'AUR-A', offerId: r.results[0].offerId, approvalToken: r.results[0].approvalToken }] });
    assert.equal(noApprove.status, 400);
    const pub = await (await call('/api/ebay/bulk/publish', { approved: true, acknowledgeWarnings: true, items: [{ sku: 'AUR-A', offerId: r.results[0].offerId, approvalToken: r.results[0].approvalToken }] })).json();
    assert.equal(pub.results[0].status, 'Active on eBay');
    // security
    assert.equal((await fetch(`http://localhost:${port}/api/ebay/disconnect`, { method: 'POST' })).status, 403, 'needs client header');
    assert.equal((await call('/api/ebay/disconnect', {}, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/.env`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/server/config.js`)).status, 404);
    const st = await (await call('/api/ebay/status')).json();
    assert.equal(st.connected, true);
    assert.ok(!JSON.stringify(st).includes('AT0'));
    const dis = await call('/api/ebay/disconnect', {});
    assert.equal(dis.status, 200);
    assert.equal((await (await call('/api/ebay/status')).json()).connected, false);
  } finally { app.server.close(); }
});

test('photo upload rejects non-images and serves stored photos', async () => {
  const app = makeApp();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    const bad = await fetch(`http://localhost:${port}/api/photos?inventoryId=inv_x&role=front`, { method: 'POST', headers: { 'X-Aura-Client': '1' }, body: Buffer.from('not an image at all, plain text') });
    assert.equal(bad.status, 400);
    const { JPG } = require('./helpers');
    const ok = await fetch(`http://localhost:${port}/api/photos?inventoryId=inv_x&role=front&name=a.jpg`, { method: 'POST', headers: { 'X-Aura-Client': '1' }, body: JPG });
    assert.equal(ok.status, 201);
    const { id } = await ok.json();
    const got = await fetch(`http://localhost:${port}/api/photos/${id}`);
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
  } finally { app.server.close(); }
});
