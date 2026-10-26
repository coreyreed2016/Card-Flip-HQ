'use strict';
const { MARKETPLACES } = require('./config');
const { buildDraft, buildPayloads, fingerprint, CCG_CATEGORY } = require('./listing');
const { EbayError } = require('./ebay-client');

class AppError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400, details) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const INV = '/sell/inventory/v1';

function createService({ config, client, ledger, photos, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const env = config.ebayEnv;
  const aspectCache = new Map();

  const marketplace = id => {
    const m = MARKETPLACES[id || 'EBAY_US'];
    if (!m) throw new AppError(`Unsupported marketplace "${id}". Choose one of: ${Object.keys(MARKETPLACES).join(', ')}.`);
    return { id: id || 'EBAY_US', ...m };
  };
  const lang = mp => ({ 'Content-Language': mp.language });
  const itemUrl = listingId => `${config.hosts.itemUrl}${listingId}`;

  function checkItem(item) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id) throw new AppError('An inventory item with an ID is required.');
    return item;
  }

  async function aspectMeta(categoryId, mp) {
    const key = `${mp.id}:${categoryId}`;
    const hit = aspectCache.get(key);
    if (hit && Date.now() - hit.at < 12 * 3600 * 1000) return hit.meta;
    try {
      const { data } = await client.request({ host: 'api', auth: 'app', path: `/commerce/taxonomy/v1/category_tree/${mp.treeId}/get_item_aspects_for_category`, query: { category_id: categoryId } });
      const aspects = {};
      for (const a of data?.aspects || []) {
        aspects[a.localizedAspectName] = {
          required: !!a.aspectConstraint?.aspectRequired,
          selectionOnly: a.aspectConstraint?.aspectMode === 'SELECTION_ONLY',
          values: (a.aspectValues || []).map(v => v.localizedValue)
        };
      }
      const meta = { aspects };
      aspectCache.set(key, { at: Date.now(), meta });
      return meta;
    } catch { return null; }
  }

  async function prepare({ item, prefs = {}, overrides = {}, marketplaceId }) {
    checkItem(item);
    const mp = marketplace(marketplaceId);
    const productType = ['sealed', 'other'].includes(item.productType) ? item.productType : 'card';
    const categoryId = String(overrides.categoryId || (productType === 'card' ? CCG_CATEGORY : '')).trim();
    const meta = /^\d+$/.test(categoryId) && config.clientId ? await aspectMeta(categoryId, mp) : null;
    const draft = buildDraft({ item, prefs, overrides, photoLookup: id => photos.get(id), aspectMeta: meta, marketplace: mp });
    draft.categoryChecked = !!meta;
    draft.ledger = ledger.get(env, mp.id, draft.sku);
    draft.approvalToken = fingerprint(draft);
    draft.environment = env;
    return draft;
  }

  async function categorySuggestions(q, marketplaceId) {
    const mp = marketplace(marketplaceId);
    if (!q || String(q).trim().length < 2) throw new AppError('Enter at least 2 characters to search categories.');
    const { data } = await client.request({ host: 'api', auth: 'app', path: `/commerce/taxonomy/v1/category_tree/${mp.treeId}/get_category_suggestions`, query: { q: String(q).trim().slice(0, 100) } });
    return (data?.categorySuggestions || []).slice(0, 10).map(s => ({
      categoryId: s.category.categoryId, name: s.category.categoryName,
      path: (s.categoryTreeNodeAncestors || []).map(a => a.categoryName).reverse().concat(s.category.categoryName).join(' > ')
    }));
  }

  async function findOffer(sku, mp) {
    try {
      const { data } = await client.request({ path: `${INV}/offer`, query: { sku, marketplace_id: mp.id, format: 'FIXED_PRICE' } });
      const offers = (data?.offers || []).filter(o => o.marketplaceId === mp.id);
      return offers.find(o => o.status === 'PUBLISHED') || offers[0] || null;
    } catch (e) {
      if (e instanceof EbayError && e.status === 404) return null;
      throw e;
    }
  }

  async function uploadPhotos(list) {
    const urls = [];
    for (const p of list) {
      const rec = photos.get(p.id);
      const cached = rec?.ebay?.[env];
      if (cached && Date.parse(cached.expirationDate || 0) - Date.now() > 2 * 86400000) { urls.push(cached.imageUrl); continue; }
      const file = photos.read(p.id);
      if (!file) throw new AppError(`Photo ${p.id} is missing on the server.`, 'PHOTO_MISSING');
      const form = new FormData();
      form.append('image', new Blob([file.buffer], { type: file.rec.mime }), `photo.${file.rec.ext}`);
      const { data } = await client.request({ method: 'POST', host: 'apim', path: '/commerce/media/v1_beta/image/create_image_from_file', form });
      if (!data?.imageUrl) throw new AppError('eBay did not return a hosted image URL for an uploaded photo.', 'PHOTO_UPLOAD_FAILED', 502);
      photos.setEbay(p.id, env, { imageUrl: data.imageUrl, expirationDate: data.expirationDate });
      urls.push(data.imageUrl);
    }
    return urls;
  }

  const draftSummary = d => ({ title: d.title, priceCents: d.priceCents, quantity: d.quantity, categoryId: d.categoryId });

  /** Creates (or updates) the inventory item and an UNPUBLISHED offer. Nothing is live until publish() is approved. */
  async function stage(input) {
    const draft = await prepare(input);
    const mp = marketplace(input.marketplaceId);
    if (draft.errors.length) {
      ledger.upsert(env, mp.id, draft.sku, { status: 'Validation Failed', lastError: draft.errors.join(' | ') });
      return { ok: false, status: 'Validation Failed', draft };
    }
    return ledger.withLock(env, mp.id, draft.sku, async () => {
      const existing = await findOffer(draft.sku, mp);
      if (existing?.status === 'PUBLISHED') {
        const listingId = existing.listing?.listingId || null;
        ledger.upsert(env, mp.id, draft.sku, { status: 'Active on eBay', offerId: existing.offerId, listingId });
        return { ok: false, duplicate: true, status: 'Active on eBay', offerId: existing.offerId, listingId, listingUrl: listingId ? itemUrl(listingId) : null, draft,
          message: 'This SKU already has an active eBay listing. No duplicate was created.' };
      }
      const imageUrls = await uploadPhotos(draft.photos);
      const { inventoryItem, offer } = buildPayloads(draft, imageUrls);
      await client.request({ method: 'PUT', path: `${INV}/inventory_item/${encodeURIComponent(draft.sku)}`, json: inventoryItem, headers: lang(mp) });

      let offerId = existing?.offerId;
      if (offerId) {
        await client.request({ method: 'PUT', path: `${INV}/offer/${offerId}`, json: offer, headers: lang(mp) });
      } else {
        try {
          const { data } = await client.request({ method: 'POST', path: `${INV}/offer`, json: offer, headers: lang(mp) });
          offerId = data?.offerId;
        } catch (e) {
          if (!(e instanceof EbayError) || !e.ambiguous) throw e;
          const found = await findOffer(draft.sku, mp); // timed out: reconcile instead of retrying the write
          if (!found) throw new AppError('eBay did not confirm the offer was created. Nothing was published; try again.', 'AMBIGUOUS', 504);
          offerId = found.offerId;
        }
      }
      if (!offerId) throw new AppError('eBay did not return an offer ID.', 'EBAY_ERROR', 502);
      const rec = ledger.upsert(env, mp.id, draft.sku, { status: 'Offer Created', offerId, fingerprint: draft.approvalToken, warningCount: draft.warnings.length, lastError: null, ...draftSummary(draft) });
      return { ok: true, status: 'Offer Created', offerId, sku: draft.sku, approvalToken: draft.approvalToken, draft, ledger: rec, imageUrls };
    });
  }

  async function confirmPublished(offerId) {
    const { data } = await client.request({ path: `${INV}/offer/${offerId}` });
    return data?.status === 'PUBLISHED' && data?.listing?.listingId ? data : null;
  }

  async function publish({ sku, offerId, marketplaceId, approvalToken, approved, acknowledgeWarnings }) {
    if (approved !== true) throw new AppError('Publishing requires your explicit approval.', 'APPROVAL_REQUIRED', 400);
    const mp = marketplace(marketplaceId);
    if (!sku || !offerId) throw new AppError('SKU and offer ID are required.');
    return ledger.withLock(env, mp.id, sku, async () => {
      const rec = ledger.get(env, mp.id, sku);
      if (!rec || rec.offerId !== offerId) throw new AppError('No eBay draft offer exists for this SKU. Create the draft and review it first.', 'NO_DRAFT', 409);
      if (rec.status === 'Active on eBay' && rec.listingId) {
        return { ok: true, alreadyPublished: true, status: rec.status, sku, offerId, listingId: rec.listingId, listingUrl: itemUrl(rec.listingId) };
      }
      if (rec.fingerprint !== approvalToken) throw new AppError('The listing changed after it was previewed. Review it again before publishing.', 'STALE_APPROVAL', 409);
      if (rec.warningCount > 0 && acknowledgeWarnings !== true) throw new AppError('This listing has warnings you must acknowledge before publishing.', 'WARNINGS_NOT_ACKNOWLEDGED', 400);

      let published = null;
      try {
        const { data } = await client.request({ method: 'POST', path: `${INV}/offer/${offerId}/publish` });
        if (data?.listingId) published = data;
      } catch (e) {
        if (e instanceof EbayError && (e.ambiguous || e.code === 'NETWORK' || e.status >= 500)) {
          const live = await confirmPublished(offerId).catch(() => null); // outcome unknown: ask eBay
          if (!live) {
            ledger.upsert(env, mp.id, sku, { lastError: e.message });
            throw new AppError('eBay did not confirm publication. The listing is NOT confirmed live; check status with Sync before retrying.', 'AMBIGUOUS', 504);
          }
          published = { listingId: live.listing.listingId };
        } else {
          ledger.upsert(env, mp.id, sku, { status: e instanceof EbayError && e.status === 400 ? 'Validation Failed' : rec.status, lastError: e.message });
          throw e;
        }
      }
      const live = await confirmPublished(offerId).catch(() => null);
      if (!live) {
        ledger.upsert(env, mp.id, sku, { status: 'Sync Error', lastError: 'eBay returned a listing ID but did not confirm the offer is published. Run Sync.' });
        throw new AppError('eBay returned a listing ID but status could not be confirmed. Run Sync to verify before assuming it is live.', 'UNCONFIRMED', 502);
      }
      const listingId = live.listing.listingId;
      const out = ledger.upsert(env, mp.id, sku, { status: 'Active on eBay', listingId, listingUrl: itemUrl(listingId), publishedAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastError: null });
      return { ok: true, status: 'Active on eBay', sku, offerId, listingId, listingUrl: out.listingUrl };
    });
  }

  function mapOffer(offer) {
    if (!offer) return { status: 'Sync Error', message: 'No offer was found on eBay for this SKU.' };
    if (offer.status !== 'PUBLISHED') return { status: 'Offer Created' };
    const ls = offer.listing?.listingStatus;
    const sold = Number(offer.listing?.soldQuantity) || 0;
    if (ls === 'ACTIVE') return { status: 'Active on eBay', soldQuantity: sold };
    if (sold > 0) return { status: 'Sold', soldQuantity: sold };
    return { status: 'Ended' };
  }

  async function fetchOrders(since) {
    const orders = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const { data } = await client.request({ path: '/sell/fulfillment/v1/order', query: { filter: `creationdate:[${since}..]`, limit: 200, offset } });
      orders.push(...(data?.orders || []));
      if (!data?.next || orders.length >= (data.total || 0)) break;
      offset += 200;
    }
    return orders;
  }

  /** User-initiated status refresh (no background polling). Never changes the app's own sold/inventory status. */
  async function sync({ items, marketplaceId }) {
    const mp = marketplace(marketplaceId);
    if (!Array.isArray(items) || !items.length) throw new AppError('Select at least one item to sync.');
    if (items.length > 100) throw new AppError('Sync at most 100 items at a time.');
    const results = [];
    for (const it of items) {
      try {
        const offer = await findOffer(it.sku, mp);
        const mapped = mapOffer(offer);
        const listingId = offer?.listing?.listingId || it.listingId || null;
        const r = { sku: it.sku, ...mapped, offerId: offer?.offerId || it.offerId || null, listingId, listingUrl: listingId ? itemUrl(listingId) : null, lastSyncAt: new Date().toISOString() };
        if (offer) ledger.upsert(env, mp.id, it.sku, { status: r.status, offerId: r.offerId, listingId, lastSyncAt: r.lastSyncAt, lastError: null });
        results.push(r);
      } catch (e) {
        results.push({ sku: it.sku, status: 'Sync Error', message: e.message, code: e.code });
        if (e.code === 'AUTH_EXPIRED' || e.code === 'NOT_CONNECTED') break;
      }
    }
    const sold = results.filter(r => r.status === 'Sold');
    if (sold.length) {
      try {
        const since = new Date(Date.now() - 89 * 86400000).toISOString();
        const orders = (await fetchOrders(since)).filter(o => o.cancelStatus?.cancelState !== 'CANCELED');
        for (const r of sold) {
          for (const o of orders) {
            const li = (o.lineItems || []).find(l => l.sku === r.sku);
            if (li) {
              r.sale = {
                orderId: o.orderId, date: (o.creationDate || '').slice(0, 10),
                priceCents: Math.round(Number(li.lineItemCost?.value || 0) * 100),
                marketplaceFeeCents: o.totalMarketplaceFee?.value ? Math.round(Number(o.totalMarketplaceFee.value) * 100) : null
              };
              break;
            }
          }
        }
      } catch (e) { sold.forEach(r => { r.saleLookupError = e.message; }); }
    }
    return results;
  }

  async function discard({ sku, offerId, marketplaceId }) {
    const mp = marketplace(marketplaceId);
    return ledger.withLock(env, mp.id, sku, async () => {
      const { data } = await client.request({ path: `${INV}/offer/${offerId}` });
      if (data?.status !== 'UNPUBLISHED') throw new AppError('Only unpublished draft offers can be discarded here. End live listings on eBay.', 'NOT_DRAFT', 409);
      await client.request({ method: 'DELETE', path: `${INV}/offer/${offerId}` });
      ledger.upsert(env, mp.id, sku, { status: 'Not Listed', offerId: null, fingerprint: null });
      return { ok: true, status: 'Not Listed' };
    });
  }

  async function testConnection() {
    const out = { ok: true, environment: env };
    const priv = (await client.request({ path: '/sell/account/v1/privilege' })).data || {};
    out.sellerRegistrationCompleted = priv.sellerRegistrationCompleted ?? null;
    out.sellingLimit = priv.sellingLimit || null;
    try {
      const u = (await client.request({ host: 'apiz', path: '/commerce/identity/v1/user/' })).data || {};
      out.account = { username: u.username || null, userId: u.userId || null, accountType: u.accountType || null, registrationMarketplaceId: u.registrationMarketplaceId || null };
    } catch (e) { out.accountNote = `Account name unavailable (${e.message}).`; }
    return out;
  }

  async function setup(marketplaceId) {
    const mp = marketplace(marketplaceId);
    const out = { marketplaceId: mp.id, missing: [], fulfillmentPolicies: [], paymentPolicies: [], returnPolicies: [], locations: [] };
    const q = { marketplace_id: mp.id };
    try {
      const { data } = await client.request({ path: '/sell/account/v1/program/get_opted_in_programs' });
      out.optedIn = (data?.programs || []).some(p => p.programType === 'SELLING_POLICY_MANAGEMENT');
      if (!out.optedIn) out.missing.push('Opt in to Business Policies: in Seller Hub open Account → Business policies and accept the opt-in, then press "Load my eBay setup" again.');
    } catch (e) { out.optedIn = null; out.missing.push(`Could not check Business Policy opt-in: ${e.message}`); }

    const grab = async (path, key, map) => {
      try {
        const { data } = await client.request({ path, query: q });
        out[key] = (data?.[key] || []).map(map);
      } catch (e) { out.missing.push(`Could not load ${key}: ${e.message}`); }
    };
    await grab('/sell/account/v1/fulfillment_policy', 'fulfillmentPolicies', p => {
      const svc = p.shippingOptions?.find(o => o.optionType === 'DOMESTIC')?.shippingServices?.[0];
      return { id: p.fulfillmentPolicyId, name: p.name, handlingDays: p.handlingTime?.unit === 'DAY' ? Number(p.handlingTime.value) : null,
        shippingCostCents: svc?.shippingCost?.value !== undefined ? Math.round(Number(svc.shippingCost.value) * 100) : null, freeShipping: !!svc?.freeShipping };
    });
    await grab('/sell/account/v1/payment_policy', 'paymentPolicies', p => ({ id: p.paymentPolicyId, name: p.name }));
    await grab('/sell/account/v1/return_policy', 'returnPolicies', p => ({ id: p.returnPolicyId, name: p.name, returnsAccepted: !!p.returnsAccepted, periodDays: p.returnPeriod?.value ?? null }));
    try {
      const { data } = await client.request({ path: `${INV}/location`, query: { limit: 100 } });
      out.locations = (data?.locations || []).map(l => ({ key: l.merchantLocationKey, name: l.name || l.merchantLocationKey, status: l.merchantLocationStatus,
        address: [l.location?.address?.city, l.location?.address?.stateOrProvince, l.location?.address?.postalCode, l.location?.address?.country].filter(Boolean).join(', ') }));
    } catch (e) { out.missing.push(`Could not load inventory locations: ${e.message}`); }

    if (!out.fulfillmentPolicies.length && out.optedIn !== false) out.missing.push(`Create a shipping (fulfillment) policy for ${mp.id} in Seller Hub → Account → Business policies.`);
    if (!out.paymentPolicies.length && out.optedIn !== false) out.missing.push(`Create a payment policy for ${mp.id} in Seller Hub → Account → Business policies.`);
    if (!out.returnPolicies.length && out.optedIn !== false) out.missing.push(`Create a return policy for ${mp.id} in Seller Hub → Account → Business policies.`);
    if (!out.locations.length) out.missing.push('Create an inventory location (the ship-from address) using the form below.');
    return out;
  }

  async function createLocation({ key, name, city, stateOrProvince, postalCode, country }) {
    const clean = v => String(v ?? '').trim();
    key = clean(key);
    if (!/^[A-Za-z0-9_-]{1,36}$/.test(key)) throw new AppError('Location key must be 1–36 letters, numbers, hyphens or underscores.');
    country = clean(country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new AppError('Country must be a 2-letter code such as US.');
    postalCode = clean(postalCode); city = clean(city); stateOrProvince = clean(stateOrProvince);
    if (!postalCode && !(city && stateOrProvince)) throw new AppError('Enter a postal code, or both city and state/province.');
    const address = { country };
    if (postalCode) address.postalCode = postalCode;
    if (city) address.city = city;
    if (stateOrProvince) address.stateOrProvince = stateOrProvince;
    try {
      await client.request({ method: 'POST', path: `${INV}/location/${encodeURIComponent(key)}`, json: { location: { address }, name: clean(name).slice(0, 1000) || key, merchantLocationStatus: 'ENABLED', locationTypes: ['WAREHOUSE'] }, headers: { 'Content-Language': 'en-US' } });
    } catch (e) {
      if (e instanceof EbayError && e.status === 409) throw new AppError(`An inventory location with key "${key}" already exists. Select it instead.`, 'CONFLICT', 409);
      throw e;
    }
    return { ok: true, key };
  }

  return { prepare, stage, publish, sync, discard, testConnection, setup, createLocation, categorySuggestions, marketplace, findOffer, AppError };
}

module.exports = { createService, AppError };
