/* eBay integration UI. Loaded before app.js; uses app globals (data, persist, render, note, esc, $, currency) only at call time. */
(function () {
  'use strict';
  const H = { 'X-Aura-Client': '1' };
  const DEFAULTS = { marketplaceId: 'EBAY_US', merchantLocationKey: '', fulfillmentPolicyId: '', paymentPolicyId: '', returnPolicyId: '', handlingDays: '', shippingCharged: 0, shippingCost: 0, packagingCost: 0, feePercent: 13.25, perOrderFee: 40, adRatePercent: 0, minProfit: 500, descriptionFooter: '' };
  const DONE = new Set(['Sold', 'Written off']);
  let serverStatus = null, setupInfo = null, L = null, B = null, settingsMsg = '';

  const prefs = () => ({ ...DEFAULTS, ...((data.settings || {}).ebay || {}) });
  const dollars = c => (c === '' || c == null ? '' : (Number(c) / 100).toFixed(2));
  const toCents = v => { const n = parseFloat(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const findItem = id => data.inventory.find(i => i.id === id);
  const skuFor = item => item.sku || ('AUR-' + String(item.id).replace(/^inv_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24).toUpperCase());
  const envLabel = () => (serverStatus?.environment || '').toUpperCase();

  async function api(path, opts = {}) {
    if (location.protocol === 'file:') throw new Error('The eBay features need the Aura Exchange server. Run "npm start" and open http://localhost:3000 instead of opening the file directly.');
    let res;
    try {
      res = await fetch(path, { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: opts.raw ? H : { ...H, 'Content-Type': 'application/json' }, body: opts.raw ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch { throw new Error('Cannot reach the Aura Exchange server. Start it with "npm start" and open http://localhost:3000.'); }
    let json = {};
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) { const e = new Error(json.error || `Request failed (${res.status}).`); e.code = json.code; throw e; }
    return json;
  }

  const getStatus = async () => (serverStatus = await api('/api/ebay/status'));

  function openModal(html, wide) {
    const dlg = $('#modal');
    $('#modal-content').innerHTML = html;
    dlg.classList.toggle('ebay-wide', !!wide);
    if (!dlg.open) dlg.showModal();
  }
  document.addEventListener('close', e => { if (e.target && e.target.id === 'modal') { e.target.classList.remove('ebay-wide'); L = null; B = null; } }, true);

  // ---------- inventory hooks ----------
  function extraFields(item) {
    const sel = (name, label, opts, val) => `<label>${label}<select name="${name}">${opts.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(val || '') === v ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`;
    const inp = (name, label, val, ph = '') => `<label>${label}<input name="${name}" value="${esc(val || '')}" placeholder="${esc(ph)}"></label>`;
    return `<div class="span3 ebay-fields"><h3>eBay listing details</h3><p class="muted">Only fill in what you know. Anything blank is flagged for review and never invented.</p><div class="ebay-grid">
      ${inp('sku', 'SKU', item.sku, 'Auto-generated if blank')}
      ${inp('storageLocation', 'Storage location', item.storageLocation, 'Binder / box / slot')}
      ${sel('productType', 'Product type', [['', 'Single card (default)'], ['sealed', 'Sealed product'], ['other', 'Other']], item.productType)}
      ${sel('finish', 'Finish', [['', 'Not recorded'], 'Holo', 'Reverse Holo', 'Non-Holo', 'Promo', 'Other'], item.finish)}
      ${inp('edition', 'Edition / stamp', item.edition, '1st Edition, Shadowless, Prerelease…')}
      ${sel('gradeVerified', 'Grade verified against slab/cert?', [['', 'No / not applicable'], ['Yes', 'Yes, verified']], item.gradeVerified)}
      <label class="ebay-wide-field">Wear / defects (shown to buyers)<textarea name="defects" placeholder="e.g. light whitening on back edges, small scratch on holo">${esc(item.defects || '')}</textarea></label></div></div>`;
  }

  function rowButton(item) {
    if (DONE.has(item.status)) return '';
    const s = item.ebay?.status;
    const label = s && s !== 'Not Listed' ? 'eBay' : 'Add to eBay';
    return `<button class="row-btn ebay-btn" data-ebay-list="${esc(item.id)}">${label}</button>`;
  }
  function badge(item) {
    const e = item.ebay;
    if (!e || !e.status || e.status === 'Not Listed') return '';
    const box = e.environment === 'sandbox' ? ' <span class="ebay-sandbox">SANDBOX</span>' : '';
    return `<div class="ebay-badge-wrap"><span class="ebay-badge ebay-s-${slug(e.status)}" title="${esc(e.lastError || '')}">eBay: ${esc(e.status)}</span>${box}</div>`;
  }
  const bulkButtons = () => '<button type="button" class="secondary ebay-btn" data-ebay-bulk>Prepare eBay listings</button><button type="button" class="secondary" data-ebay-sync-selected>Sync eBay status</button>';

  function onRender(page) {
    if (page === 'settings') mountSettings();
    if (new URLSearchParams(location.search).has('ebay') && page !== 'settings') {
      const r = new URLSearchParams(location.search).get('ebay');
      history.replaceState(null, '', location.pathname);
      settingsMsg = { connected: 'eBay account connected.', declined: 'eBay authorization was declined.', badstate: 'The eBay response could not be verified. Try connecting again.', failed: 'eBay connection failed. Check your keys and RuName, then try again.' }[r] || '';
      const btn = document.querySelector('#nav [data-page="settings"]');
      if (btn) btn.click();
    }
  }

  // ---------- settings ----------
  async function mountSettings() {
    const host = $('#settings');
    if (!host || host.querySelector('#ebay-settings')) return;
    const panel = document.createElement('div');
    panel.className = 'panel ebay-panel';
    panel.id = 'ebay-settings';
    host.appendChild(panel);
    paintSettings('Loading…');
    try { await getStatus(); paintSettings(); } catch (e) { paintSettings(null, e.message); }
  }

  function paintSettings(loading, err) {
    const el = $('#ebay-settings'); if (!el) return;
    const s = serverStatus, p = prefs();
    const sandbox = s?.environment === 'sandbox';
    let status = '';
    if (loading) status = `<p class="muted">${esc(loading)}</p>`;
    else if (err) status = `<p class="ebay-msg bad">${esc(err)}</p>`;
    else if (!s.configured) status = `<p class="ebay-msg bad">Server not configured. Add these to your <code>.env</code> file and restart: <b>${s.missingConfig.map(esc).join(', ')}</b>. See the setup guide below.</p>`;
    else status = `<div class="ebay-status"><span class="ebay-badge ${s.connected ? 'ebay-s-active-on-ebay' : 'ebay-s-not-listed'}">${s.connected ? (s.authorizationExpired ? 'Authorization expired' : 'Connected') : 'Not connected'}</span> <span class="ebay-env ${sandbox ? 'sb' : 'prod'}">${sandbox ? 'SANDBOX (test)' : 'PRODUCTION (real listings)'}</span>
      ${s.connectedAt ? `<span class="muted">Connected ${esc(new Date(s.connectedAt).toLocaleString())}</span>` : ''}${s.tokenProblem ? `<p class="ebay-msg bad">${esc(s.tokenProblem)}</p>` : ''}
      ${s.authorizationExpired ? '<p class="ebay-msg bad">Your eBay authorization expired. Press Connect to renew it.</p>' : ''}
      ${s.authorizationExpiresAt ? `<div class="muted">Authorization valid until ${esc(new Date(s.authorizationExpiresAt).toLocaleDateString())}</div>` : ''}</div>
      <div class="actions ebay-actions"><button type="button" data-ebay-connect>${s.connected ? 'Reconnect eBay Account' : 'Connect eBay Account'}</button>
      <button type="button" class="secondary" data-ebay-test ${s.connected ? '' : 'disabled'}>Test Connection</button>
      <button type="button" class="danger" data-ebay-disconnect ${s.connected ? '' : 'disabled'}>Disconnect eBay</button></div>`;
    const mkts = (s?.marketplaces || [{ id: 'EBAY_US', label: 'United States (EBAY_US)' }]).map(m => `<option value="${m.id}" ${p.marketplaceId === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    const opts = (list, val, idKey = 'id') => (list || []).map(o => `<option value="${esc(o[idKey])}" ${val === o[idKey] ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    const keep = (list, val, idKey = 'id') => (val && !(list || []).some(o => o[idKey] === val) ? `<option value="${esc(val)}" selected>${esc(val)} (saved)</option>` : '');
    const su = setupInfo;
    el.innerHTML = `<h2>eBay Integration</h2>
      <p class="muted">Lists your inventory through eBay's official Sell APIs. You sign in on eBay's own site; Aura Exchange never sees your eBay password, and keys/tokens stay on the server.</p>
      ${settingsMsg ? `<p class="ebay-msg">${esc(settingsMsg)}</p>` : ''}${status}
      <details class="ebay-help"><summary>How to connect my existing eBay seller account</summary><ol>
        <li>Create a free eBay developer account at developer.ebay.com and create a keyset (start with <b>Sandbox</b>).</li>
        <li>In <b>User Tokens</b>, create a RuName. Set the accept URL to <code>${esc(s?.callbackUrl || 'http://localhost:3000/api/ebay/callback')}</code> (or an https tunnel URL if eBay rejects http).</li>
        <li>Put the App ID, Cert ID, RuName and a random encryption key in <code>.env</code> (see <code>.env.example</code>), then restart <code>npm start</code>.</li>
        <li>Press <b>Connect eBay Account</b>, sign in on eBay's page and approve. Use a Sandbox test user while EBAY_ENV=sandbox.</li>
        <li>In Seller Hub opt in to Business Policies and create shipping, payment and return policies, then press <b>Load my eBay setup</b> below and pick them.</li>
        <li>Create an inventory location (ship-from address) here if none exists. For real listings set EBAY_ENV=production with production keys and reconnect.</li></ol></details>
      <h3>Marketplace &amp; seller setup</h3>
      <div class="ebay-grid"><label>Marketplace<select id="ebay-mkt">${mkts}</select></label>
        <div class="ebay-actions"><button type="button" class="secondary" data-ebay-setup ${s?.connected ? '' : 'disabled'}>Load my eBay setup</button></div></div>
      ${su ? `<div class="ebay-msg ${su.missing.length ? 'warn' : ''}">${su.missing.length ? '<b>Still to do on eBay:</b><ul>' + su.missing.map(m => `<li>${esc(m)}</li>`).join('') + '</ul>' : 'Policies and inventory location found.'}</div>` : ''}
      ${su && !su.locations.length ? `<details class="ebay-help" open><summary>Create inventory location</summary><div class="ebay-grid" id="ebay-loc">
        <label>Location key<input name="key" value="home" maxlength="36"></label><label>Name<input name="name" placeholder="Home office"></label>
        <label>Country<input name="country" value="US" maxlength="2"></label><label>Postal code<input name="postalCode"></label>
        <label>City<input name="city"></label><label>State / province<input name="stateOrProvince"></label></div>
        <button type="button" class="secondary" data-ebay-loc>Create location</button></details>` : ''}
      <h3>Listing defaults</h3>
      <div class="ebay-grid" id="ebay-prefs">
        <label>Shipping policy<select name="fulfillmentPolicyId"><option value="">Select…</option>${opts(su?.fulfillmentPolicies, p.fulfillmentPolicyId)}${keep(su?.fulfillmentPolicies, p.fulfillmentPolicyId)}</select></label>
        <label>Payment policy<select name="paymentPolicyId"><option value="">Select…</option>${opts(su?.paymentPolicies, p.paymentPolicyId)}${keep(su?.paymentPolicies, p.paymentPolicyId)}</select></label>
        <label>Return policy<select name="returnPolicyId"><option value="">Select…</option>${opts(su?.returnPolicies, p.returnPolicyId)}${keep(su?.returnPolicies, p.returnPolicyId)}</select></label>
        <label>Inventory location<select name="merchantLocationKey"><option value="">Select…</option>${opts((su?.locations || []).map(l => ({ id: l.key, name: l.name + (l.address ? ' – ' + l.address : '') })), p.merchantLocationKey)}${keep((su?.locations || []).map(l => ({ id: l.key })), p.merchantLocationKey)}</select></label>
        <label>Handling time (days, display only)<input name="handlingDays" inputmode="numeric" value="${esc(p.handlingDays)}" placeholder="Set in the shipping policy"></label>
        <label>Shipping charged to buyer ($)<input name="shippingCharged" inputmode="decimal" value="${dollars(p.shippingCharged)}"></label>
        <label>Est. shipping cost to you ($)<input name="shippingCost" inputmode="decimal" value="${dollars(p.shippingCost)}"></label>
        <label>Est. packaging cost ($)<input name="packagingCost" inputmode="decimal" value="${dollars(p.packagingCost)}"></label>
        <label>Est. eBay fee (% of total)<input name="feePercent" inputmode="decimal" value="${esc(p.feePercent)}"></label>
        <label>Est. per-order fee ($)<input name="perOrderFee" inputmode="decimal" value="${dollars(p.perOrderFee)}"></label>
        <label>Promoted listing rate (%)<input name="adRatePercent" inputmode="decimal" value="${esc(p.adRatePercent)}"></label>
        <label>Minimum acceptable profit ($)<input name="minProfit" inputmode="decimal" value="${dollars(p.minProfit)}"></label>
        <label class="ebay-wide-field">Description footer (optional)<textarea name="descriptionFooter" placeholder="e.g. Ships in a toploader within 1 business day.">${esc(p.descriptionFooter)}</textarea></label></div>
      <p class="muted">Fees are <b>estimates</b> you control; eBay's real fees vary by category, seller level and promotions. Handling time and return terms come from the policies you select.</p>
      <div class="actions"><button type="button" data-ebay-save>Save eBay settings</button></div>`;
  }

  function readPrefs() {
    const g = n => document.querySelector(`#ebay-prefs [name="${n}"]`)?.value ?? '';
    const money = (n, d) => { const v = g(n).trim(); if (v === '') return d; const c = toCents(v); if (c === null || c < 0) throw new Error(`Enter a valid non-negative amount for ${n}.`); return c; };
    const pct = (n, d) => { const v = g(n).trim(); if (v === '') return d; const x = Number(v); if (!Number.isFinite(x) || x < 0 || x > 100) throw new Error(`${n} must be between 0 and 100.`); return x; };
    return { marketplaceId: $('#ebay-mkt').value, fulfillmentPolicyId: g('fulfillmentPolicyId'), paymentPolicyId: g('paymentPolicyId'), returnPolicyId: g('returnPolicyId'), merchantLocationKey: g('merchantLocationKey'),
      handlingDays: g('handlingDays').trim(), shippingCharged: money('shippingCharged', 0), shippingCost: money('shippingCost', 0), packagingCost: money('packagingCost', 0),
      feePercent: pct('feePercent', 13.25), perOrderFee: money('perOrderFee', 40), adRatePercent: pct('adRatePercent', 0), minProfit: money('minProfit', 0), descriptionFooter: g('descriptionFooter').trim().slice(0, 500) };
  }
  function savePrefs() { data.settings.ebay = readPrefs(); if (persist()) note('eBay settings saved.'); }

  // ---------- photos ----------
  async function uploadPhotos(item, files, role) {
    item.photos = Array.isArray(item.photos) ? item.photos : [];
    for (const f of files) {
      const r = await api(`/api/photos?inventoryId=${encodeURIComponent(item.id)}&role=${role}&name=${encodeURIComponent(f.name)}`, { raw: true, method: 'POST', body: f });
      item.photos.push({ id: r.id, role: r.role, name: r.name });
    }
    persist();
  }

  // ---------- single listing ----------
  const itemForServer = item => { const { notes, imageReference, ...rest } = item; return { ...rest, sku: skuFor(item) }; };

  async function openListing(id) {
    const item = findItem(id); if (!item) return;
    L = { id, overrides: {}, busy: false, msg: '', ack: false, approve: false, draft: null };
    openModal('<h2>Add to eBay</h2><p class="muted">Loading…</p>', true);
    try { await getStatus(); } catch (e) { L.msg = e.message; }
    await refresh();
  }

  async function refresh() {
    const item = findItem(L.id);
    try {
      L.draft = await api('/api/ebay/prepare', { body: { item: itemForServer(item), prefs: prefs(), overrides: L.overrides, marketplaceId: prefs().marketplaceId } });
      const lg = L.draft.ledger;
      L.staged = lg && lg.status === 'Offer Created' && lg.fingerprint === L.draft.approvalToken ? { offerId: lg.offerId, approvalToken: lg.fingerprint } : null;
      L.approve = L.approve && !!L.staged;
    } catch (e) { L.draft = null; L.msg = e.message; }
    paintListing();
  }

  const list = (arr, cls) => arr && arr.length ? `<ul class="ebay-list ${cls}">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const rowKV = (k, v, cls = '') => `<tr class="${cls}"><th>${esc(k)}</th><td>${v}</td></tr>`;

  function profitTable(pr) {
    if (!pr) return '';
    const neg = pr.estimatedProfit < 0;
    return `<table class="ebay-kv ebay-profit"><caption>Profit breakdown <span class="muted">(estimates, not eBay's final charges)</span></caption>
      ${rowKV('Purchase cost', currency(pr.purchaseCost))}${rowKV('Listing price', currency(pr.listingPrice))}
      ${rowKV('Shipping charged to buyer', currency(pr.shippingCharged || 0))}
      ${rowKV(`Est. eBay fees (${pr.assumptions.feePercent}% + ${currency(pr.assumptions.perOrderFee)}${pr.assumptions.adRatePercent ? ' + ' + pr.assumptions.adRatePercent + '% ads' : ''})`, currency(pr.estimatedFees))}
      ${rowKV('Est. shipping cost', currency(pr.estimatedShippingCost || 0))}${rowKV('Est. packaging cost', currency(pr.estimatedPackagingCost || 0))}
      ${rowKV('Est. net proceeds', currency(pr.estimatedNet))}${rowKV('Est. profit', `<b class="${neg ? 'loss' : 'gain'}">${currency(pr.estimatedProfit)}</b>`)}
      ${rowKV('Est. margin', `${(pr.estimatedMargin * 100).toFixed(1)}%`)}</table>`;
  }

  function paintListing() {
    const item = findItem(L.id), d = L.draft, e = item.ebay || {};
    const live = ['Active on eBay', 'Sold'].includes(e.status);
    const sb = serverStatus?.environment === 'sandbox';
    const photoHtml = (item.photos || []).map(p => `<figure class="ebay-photo"><img src="/api/photos/${esc(p.id)}" alt="${esc(p.role)} photo"><figcaption><select data-ebay-photo-role="${esc(p.id)}">${['front', 'back', 'defect', 'other'].map(r => `<option ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select><button type="button" class="row-btn row-btn-danger" data-ebay-photo-del="${esc(p.id)}">Remove</button></figcaption></figure>`).join('');
    const ov = L.overrides;
    let body = '';
    if (d) {
      const specifics = Object.entries(d.aspects || {}).map(([k, v]) => rowKV(k, esc(Array.isArray(v) ? v.join(', ') : v))).join('');
      const cond = d.condition?.enum === 'LIKE_NEW' ? 'Graded' : 'Used (Ungraded)';
      body = `${list(d.errors, 'err')}${list(d.warnings, 'warn')}${list(d.notes, 'note')}
        <div class="ebay-preview"><h3>Listing preview</h3>
          <div class="ebay-prev-photos">${(d.photos || []).map(p => `<img src="/api/photos/${esc(p.id)}" alt="${esc(p.role)}">`).join('') || '<span class="muted">No photos</span>'}</div>
          <h4>${esc(d.title)}</h4><div class="ebay-price">${currency(d.priceCents)} <span class="muted">· Qty ${esc(d.quantity)} · ${esc(cond)} · Category ${esc(d.categoryId)}${d.categoryChecked ? '' : ' (not verified yet)'}</span></div>
          <pre class="ebay-desc">${esc(d.description)}</pre><table class="ebay-kv"><caption>Item specifics</caption>${specifics}</table></div>
        ${profitTable(d.profit)}`;
    }
    const canStage = d && !d.errors.length && !live && !L.busy;
    const needAck = d && d.warnings.length;
    const publishBox = L.staged && !live ? `<div class="ebay-approve ${sb ? '' : 'prod'}"><h3>Ready to publish</h3>
        <p>An unpublished offer exists on eBay (${esc(L.staged.offerId)}). It is <b>not live</b> and not visible in Seller Hub Drafts. Review the preview above, then approve.</p>
        ${needAck ? `<label class="ebay-check"><input type="checkbox" data-ebay-ack ${L.ack ? 'checked' : ''}> I have read the warnings above</label>` : ''}
        <label class="ebay-check"><input type="checkbox" data-ebay-approve ${L.approve ? 'checked' : ''}> I approve publishing this listing to eBay ${sb ? '(SANDBOX)' : '(PRODUCTION – a real, live listing)'}</label>
        <div class="actions"><button type="button" data-ebay-publish ${L.approve && (!needAck || L.ack) && !L.busy ? '' : 'disabled'}>Publish to eBay</button><button type="button" class="secondary" data-ebay-discard ${L.busy ? 'disabled' : ''}>Discard draft offer</button></div></div>` : '';
    const liveBox = e.status && e.status !== 'Not Listed' ? `<div class="ebay-msg ${e.status === 'Sync Error' || e.status === 'Validation Failed' ? 'bad' : ''}"><b>eBay status: ${esc(e.status)}</b>${e.environment === 'sandbox' ? ' (sandbox)' : ''}
        ${e.listingUrl ? ` · <a href="${esc(e.listingUrl)}" target="_blank" rel="noopener">View listing</a>` : ''}${e.listingId ? ` · Listing ${esc(e.listingId)}` : ''}${e.offerId ? ` · Offer ${esc(e.offerId)}` : ''}
        ${e.lastSync ? `<div class="muted">Last sync ${esc(new Date(e.lastSync).toLocaleString())}</div>` : ''}${e.lastError ? `<div>${esc(e.lastError)}</div>` : ''}
        <div class="actions"><button type="button" class="secondary" data-ebay-sync-one>Sync status</button>${e.status === 'Sold' ? '<button type="button" data-ebay-record-sale>Record sale…</button>' : ''}</div></div>` : '';
    openModal(`<div class="ebay-modal"><h2>Add to eBay <span class="ebay-env ${sb ? 'sb' : 'prod'}">${esc(envLabel() || '…')}</span></h2>
      <p class="muted">${esc(item.cardName || '')} · ${esc(item.set || '')} ${item.cardNumber ? '#' + esc(item.cardNumber) : ''} · SKU ${esc(skuFor(item))}</p>
      ${L.msg ? `<p class="ebay-msg bad">${esc(L.msg)}</p>` : ''}${serverStatus && !serverStatus.connected ? '<p class="ebay-msg bad">eBay is not connected. Go to Settings → eBay Integration.</p>' : ''}
      ${liveBox}
      <h3>Photos of the actual item</h3><p class="muted">Front and back photos are required. Add close-ups of any wear. Do not use stock images.</p>
      <div class="ebay-photos">${photoHtml || '<span class="muted">No photos yet.</span>'}</div>
      <div class="ebay-upload"><select id="ebay-role"><option value="front">Front</option><option value="back">Back</option><option value="defect">Defect close-up</option><option value="other">Other</option></select>
        <input type="file" id="ebay-files" accept="image/jpeg,image/png,image/webp,image/gif" multiple><button type="button" class="secondary" data-ebay-upload>Upload photos</button></div>
      <h3>Listing details</h3><div class="ebay-grid" id="ebay-ov">
        <label class="ebay-wide-field">Title (max 80)<input name="title" maxlength="80" value="${esc(ov.title !== undefined ? ov.title : '')}" placeholder="${esc(d ? d.title : 'Auto-generated')}"></label>
        <label>Listing price ($)<input name="price" inputmode="decimal" value="${ov.price !== undefined ? dollars(ov.price) : dollars(d ? d.priceCents : item.targetSalePrice)}"></label>
        <label>Quantity to list<input name="quantity" inputmode="numeric" value="${ov.quantity !== undefined ? esc(ov.quantity) : 1}"></label>
        <label>eBay category ID<input name="categoryId" value="${esc(ov.categoryId || (d ? d.categoryId : ''))}"></label>
        <label>Shipping charged ($)<input name="shippingCharged" inputmode="decimal" value="${dollars(ov.shippingCharged !== undefined ? ov.shippingCharged : prefs().shippingCharged)}"></label>
        <label>Est. shipping cost ($)<input name="shippingCost" inputmode="decimal" value="${dollars(ov.shippingCost !== undefined ? ov.shippingCost : prefs().shippingCost)}"></label>
        <label>Est. packaging ($)<input name="packagingCost" inputmode="decimal" value="${dollars(ov.packagingCost !== undefined ? ov.packagingCost : prefs().packagingCost)}"></label>
        <label class="ebay-wide-field">Description (leave blank for auto)<textarea name="description" rows="3">${esc(ov.description || '')}</textarea></label>
        <label>Wear / defects<input name="defects" value="${esc(item.defects || '')}"></label>
        <label>Finish<input name="finish" value="${esc(item.finish || '')}" placeholder="Holo, Reverse Holo…"></label>
        <label>Edition / stamp<input name="edition" value="${esc(item.edition || '')}"></label>
        <label>Grade verified?<select name="gradeVerified"><option value="">No / n/a</option><option value="Yes" ${item.gradeVerified === 'Yes' ? 'selected' : ''}>Yes, verified</option></select></label></div>
      <p class="muted">Price changes here apply to this listing only and never overwrite your saved sale price.</p>
      <div class="actions"><button type="button" class="secondary" data-ebay-refresh ${L.busy ? 'disabled' : ''}>Refresh preview</button>
        <button type="button" data-ebay-stage ${canStage ? '' : 'disabled'}>${L.staged ? 'Update eBay draft offer' : 'Create eBay draft offer'}</button></div>
      ${d ? '' : '<p class="muted">Preview unavailable.</p>'}${body}${publishBox}</div>`, true);
  }

  function readOverrides() {
    const g = n => document.querySelector(`#ebay-ov [name="${n}"]`)?.value ?? '';
    const ov = {};
    const t = g('title').trim(); if (t) ov.title = t;
    const d = g('description').trim(); if (d) ov.description = d;
    const c = g('categoryId').trim(); if (c) ov.categoryId = c;
    for (const k of ['price', 'shippingCharged', 'shippingCost', 'packagingCost']) { const v = g(k).trim(); if (v !== '') { const n = toCents(v); if (n === null || n < 0) throw new Error(`Enter a valid amount for ${k}.`); ov[k] = n; } }
    const q = g('quantity').trim(); if (q !== '') { if (!/^\d+$/.test(q) || +q < 1) throw new Error('Quantity must be a whole number of at least 1.'); ov.quantity = +q; }
    const item = findItem(L.id);
    for (const k of ['defects', 'finish', 'edition', 'gradeVerified']) item[k] = g(k).trim();
    persist();
    return ov;
  }

  async function run(fn) {
    if (L.busy) return;
    L.busy = true; L.msg = ''; paintListing();
    try { await fn(); } catch (e) { if (L) L.msg = e.message; }
    if (!L) return;
    L.busy = false;
    paintListing();
  }

  function saveEbay(item, patch) {
    item.ebay = { ...(item.ebay || {}), ...patch, environment: serverStatus?.environment || item.ebay?.environment, marketplaceId: prefs().marketplaceId };
    persist();
  }

  async function doStage() {
    L.overrides = readOverrides();
    const item = findItem(L.id);
    const r = await api('/api/ebay/stage', { body: { item: itemForServer(item), prefs: prefs(), overrides: L.overrides, marketplaceId: prefs().marketplaceId } });
    L.draft = r.draft;
    if (r.duplicate) { saveEbay(item, { sku: r.draft.sku, status: 'Active on eBay', offerId: r.offerId, listingId: r.listingId, listingUrl: r.listingUrl, lastSync: new Date().toISOString() }); L.msg = r.message; return; }
    if (!r.ok) { saveEbay(item, { sku: r.draft.sku, status: 'Validation Failed', lastError: r.draft.errors.join(' | ') }); return; }
    item.sku = item.sku || r.sku;
    saveEbay(item, { sku: r.sku, status: 'Offer Created', offerId: r.offerId, lastError: '', price: r.draft.priceCents, qty: r.draft.quantity });
    L.staged = { offerId: r.offerId, approvalToken: r.approvalToken };
    L.msg = '';
    L.draft.ledger = { status: 'Offer Created', offerId: r.offerId, fingerprint: r.approvalToken };
  }

  async function doPublish() {
    const item = findItem(L.id), st = L.staged;
    const r = await api('/api/ebay/publish', { body: { sku: skuFor(item), offerId: st.offerId, approvalToken: st.approvalToken, approved: true, acknowledgeWarnings: L.ack, marketplaceId: prefs().marketplaceId } });
    applyPublished(item, r);
    L.staged = null; L.approve = false;
    L.msg = '';
  }

  function applyPublished(item, r) {
    saveEbay(item, { sku: r.sku, status: 'Active on eBay', offerId: r.offerId, listingId: r.listingId, listingUrl: r.listingUrl, lastSync: new Date().toISOString(), lastError: '' });
    // Only a real (production) listing changes the main inventory fields; sandbox listings are test data.
    if (serverStatus?.environment === 'production') {
      if (item.status !== 'Sold') item.status = 'Listed';
      item.platform = 'eBay'; item.listingUrl = r.listingUrl;
      item.listingDate = item.listingDate || new Date().toISOString().slice(0, 10);
      persist();
    }
  }

  async function syncItems(items) {
    const payload = items.filter(i => i.ebay?.sku || i.sku).map(i => ({ sku: i.ebay?.sku || skuFor(i), offerId: i.ebay?.offerId, listingId: i.ebay?.listingId }));
    if (!payload.length) throw new Error('None of the selected items have been sent to eBay yet.');
    const { results } = await api('/api/ebay/sync', { body: { items: payload, marketplaceId: prefs().marketplaceId } });
    let sold = 0;
    for (const r of results) {
      const it = items.find(i => (i.ebay?.sku || skuFor(i)) === r.sku); if (!it) continue;
      const patch = { status: r.status, lastSync: r.lastSyncAt || new Date().toISOString(), lastError: r.status === 'Sync Error' ? r.message : '' };
      if (r.offerId) patch.offerId = r.offerId;
      if (r.listingId) { patch.listingId = r.listingId; patch.listingUrl = r.listingUrl; }
      if (r.sale) patch.sale = r.sale;
      if (r.status === 'Sold') sold++;
      saveEbay(it, patch);
    }
    return { results, sold };
  }

  function recordSale(item) {
    const s = item.ebay?.sale || {};
    $('#modal').close();
    showModal(inventoryForm({ ...item, status: 'Sold', platform: 'eBay', saleDate: s.date || date(), actualSalePrice: s.priceCents || item.targetSalePrice, sellingFees: s.marketplaceFeeCents || item.sellingFees || 0, listingUrl: item.ebay?.listingUrl || item.listingUrl }));
    note('Review the sale details and press Save to record the sale. Nothing was changed yet.');
  }

  // ---------- bulk ----------
  async function openBulk() {
    const ids = [...document.querySelectorAll('.row-select:checked')].map(c => c.dataset.selectId);
    const items = ids.map(findItem).filter(i => i && !DONE.has(i.status));
    if (!items.length) { note('Select at least one eligible inventory item first.', true); return; }
    if (items.length > 50) { note('Select 50 items or fewer for one batch.', true); return; }
    B = { rows: items.map(i => ({ id: i.id, include: true, price: undefined, draft: null, result: null })), busy: false, msg: '', approve: false, ack: false, stage: 'review' };
    openModal('<h2>Prepare eBay listings</h2><p class="muted">Validating…</p>', true);
    try { await getStatus(); } catch (e) { B.msg = e.message; }
    await validateAll();
  }

  async function validateAll() {
    B.busy = true; paintBulk();
    for (const row of B.rows) {
      if (row.result?.ok) continue;
      try {
        const item = findItem(row.id);
        row.draft = await api('/api/ebay/prepare', { body: { item: itemForServer(item), prefs: prefs(), overrides: row.price !== undefined ? { price: row.price } : {}, marketplaceId: prefs().marketplaceId } });
        row.error = '';
      } catch (e) { row.draft = null; row.error = e.message; }
    }
    B.busy = false; paintBulk();
  }

  const rowState = r => r.result ? (r.result.ok ? (r.result.published ? 'Active on eBay' : 'Offer Created') : (r.result.notAttempted ? 'Not attempted' : 'Failed')) : (r.error ? 'Error' : !r.draft ? '…' : r.draft.errors.length ? 'Invalid' : r.draft.warnings.length ? 'Warnings' : 'Ready');

  function paintBulk() {
    const sb = serverStatus?.environment === 'sandbox';
    const rows = B.rows.map((r, i) => {
      const item = findItem(r.id), d = r.draft;
      const photos = d ? d.photos.length : (item.photos || []).length;
      const hasFB = ['front', 'back'].every(role => (item.photos || []).some(p => p.role === role));
      const st = rowState(r);
      const detail = r.result && !r.result.ok ? (r.result.error || (r.result.draft?.errors || []).join(' | ')) : r.error || (d && (d.errors.length ? d.errors.join(' | ') : d.warnings.join(' | '))) || '';
      const locked = r.result?.ok;
      return `<tr class="ebay-row-${slug(st)}"><td><input type="checkbox" data-ebay-brow="${i}" ${r.include ? 'checked' : ''} ${locked && r.result.published ? 'disabled' : ''} aria-label="Include"></td>
        <td>${esc(item.cardName)}<div class="muted">${esc(item.set || '')} ${item.cardNumber ? '#' + esc(item.cardNumber) : ''}</div></td><td>${esc(skuFor(item))}</td><td>${esc(item.condition || '—')}</td>
        <td>${photos} ${hasFB ? '' : '<span class="ebay-flag">needs front+back</span>'}</td>
        <td><input class="ebay-price-in" data-ebay-bprice="${i}" inputmode="decimal" value="${dollars(r.price !== undefined ? r.price : d ? d.priceCents : item.targetSalePrice)}" ${locked ? 'disabled' : ''}></td>
        <td class="${d && d.profit.estimatedProfit < 0 ? 'loss' : ''}">${d ? currency(d.profit.estimatedProfit) : '—'}</td>
        <td><span class="ebay-badge ebay-b-${slug(st)}">${esc(st)}</span><div class="muted ebay-detail">${esc(detail)}</div></td>
        <td><button type="button" class="row-btn" data-ebay-bedit="${i}">Edit</button></td></tr>`;
    }).join('');
    const inc = B.rows.filter(r => r.include && !r.result?.published);
    const stageable = inc.filter(r => r.draft && !r.draft.errors.length && !r.result?.ok);
    const staged = B.rows.filter(r => r.include && r.result?.ok && !r.result.published);
    const warn = [...stageable, ...staged].some(r => r.draft && r.draft.warnings.length);
    openModal(`<div class="ebay-modal"><h2>Prepare eBay listings <span class="ebay-env ${sb ? 'sb' : 'prod'}">${esc(envLabel())}</span></h2>
      ${B.msg ? `<p class="ebay-msg bad">${esc(B.msg)}</p>` : ''}${serverStatus && !serverStatus.connected ? '<p class="ebay-msg bad">eBay is not connected. Go to Settings → eBay Integration.</p>' : ''}
      <p class="muted">Step 1: review and fix. Step 2: create draft offers (not live). Step 3: approve the batch and publish. Invalid items are skipped automatically. Up to 50 items per batch.</p>
      <div class="table-wrap"><table class="ebay-bulk"><thead><tr><th></th><th>Card</th><th>SKU</th><th>Condition</th><th>Photos</th><th>Price ($)</th><th>Est. profit</th><th>Validation</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="actions"><button type="button" class="secondary" data-ebay-brevalidate ${B.busy ? 'disabled' : ''}>Re-validate</button>
        <button type="button" data-ebay-bstage ${stageable.length && !B.busy ? '' : 'disabled'}>Create ${stageable.length} draft offer${stageable.length === 1 ? '' : 's'}</button></div>
      ${staged.length ? `<div class="ebay-approve ${sb ? '' : 'prod'}"><h3>Approve batch</h3><p>${staged.length} listing${staged.length === 1 ? '' : 's'} ready. These are not live until you publish.</p>
        ${warn ? `<label class="ebay-check"><input type="checkbox" data-ebay-backn ${B.ack ? 'checked' : ''}> I have reviewed the warnings on these listings</label>` : ''}
        <label class="ebay-check"><input type="checkbox" data-ebay-bapprove ${B.approve ? 'checked' : ''}> I approve publishing these ${staged.length} selected listings to eBay ${sb ? '(SANDBOX)' : '(PRODUCTION – real, live listings)'}</label>
        <div class="actions"><button type="button" data-ebay-bpublish ${B.approve && (!warn || B.ack) && !B.busy ? '' : 'disabled'}>Publish ${staged.length} approved listing${staged.length === 1 ? '' : 's'}</button></div></div>` : ''}</div>`, true);
  }

  async function bulkStage() {
    const rows = B.rows.filter(r => r.include && r.draft && !r.draft.errors.length && !r.result?.ok);
    B.busy = true; B.msg = ''; B.approve = false; paintBulk();
    try {
      const { results } = await api('/api/ebay/bulk/stage', { body: { items: rows.map(r => ({ item: itemForServer(findItem(r.id)), overrides: r.price !== undefined ? { price: r.price } : {} })), prefs: prefs(), marketplaceId: prefs().marketplaceId } });
      results.forEach((res, i) => {
        const row = rows[i], item = findItem(row.id);
        row.result = res;
        if (res.ok) { row.draft = res.draft; saveEbay(item, { sku: res.sku, status: 'Offer Created', offerId: res.offerId, lastError: '', price: res.draft.priceCents, qty: res.draft.quantity }); }
        else if (res.duplicate) saveEbay(item, { sku: skuFor(item), status: 'Active on eBay', offerId: res.offerId, listingId: res.listingId, listingUrl: res.listingUrl });
        else saveEbay(item, { sku: skuFor(item), status: res.status === 'Validation Failed' ? 'Validation Failed' : item.ebay?.status || 'Sync Error', lastError: res.error || (res.draft?.errors || []).join(' | ') });
      });
    } catch (e) { B.msg = e.message; }
    B.busy = false; paintBulk();
  }

  async function bulkPublish() {
    const rows = B.rows.filter(r => r.include && r.result?.ok && !r.result.published);
    B.busy = true; B.msg = ''; paintBulk();
    try {
      const { results } = await api('/api/ebay/bulk/publish', { body: { approved: true, acknowledgeWarnings: B.ack, marketplaceId: prefs().marketplaceId, items: rows.map(r => ({ sku: r.result.sku, offerId: r.result.offerId, approvalToken: r.result.approvalToken })) } });
      results.forEach((res, i) => {
        const row = rows[i], item = findItem(row.id);
        if (res.ok) { applyPublished(item, res); row.result = { ...row.result, published: true }; }
        else { row.result = { ...row.result, ok: row.result.ok, publishError: res.error }; row.error = res.error; saveEbay(item, { lastError: res.error }); }
      });
      const okN = results.filter(r => r.ok).length;
      B.msg = `${okN} of ${results.length} published. ${results.length - okN ? 'Failed items are listed below with the reason.' : ''}`;
    } catch (e) { B.msg = e.message; }
    B.busy = false; B.approve = false; paintBulk(); render();
  }

  // ---------- events ----------
  document.addEventListener('click', async ev => {
    const t = ev.target.closest('button'); if (!t) return;
    const has = a => t.hasAttribute(a);
    try {
      if (has('data-ebay-list')) return void openListing(t.dataset.ebayList);
      if (has('data-ebay-bulk')) return void openBulk();
      if (has('data-ebay-sync-selected')) {
        const items = [...document.querySelectorAll('.row-select:checked')].map(c => findItem(c.dataset.selectId)).filter(Boolean);
        if (!items.length) return note('Select items to sync first.', true);
        const { results, sold } = await syncItems(items); render();
        return note(`Synced ${results.length} item(s).${sold ? ` ${sold} sold on eBay. Open the item and press "Record sale…" to confirm.` : ''}`);
      }
      if (has('data-ebay-connect')) { const r = await api('/api/ebay/connect', { method: 'POST', body: {} }); location.href = r.url; return; }
      if (has('data-ebay-disconnect')) { if (!confirm('Disconnect eBay? Existing listings stay on eBay.')) return; await api('/api/ebay/disconnect', { method: 'POST', body: {} }); setupInfo = null; settingsMsg = 'Disconnected.'; await getStatus(); return paintSettings(); }
      if (has('data-ebay-test')) { settingsMsg = 'Testing…'; paintSettings(); try { const r = await api('/api/ebay/test', { method: 'POST', body: {} }); settingsMsg = `Connection OK${r.account?.username ? ' as ' + r.account.username : ''} (${r.environment}).${r.sellerRegistrationCompleted === false ? ' Seller registration is incomplete on eBay.' : ''}${r.accountNote ? ' ' + r.accountNote : ''}`; } catch (e) { settingsMsg = 'Test failed: ' + e.message; } return paintSettings(); }
      if (has('data-ebay-setup')) { settingsMsg = ''; try { setupInfo = await api('/api/ebay/setup?marketplace=' + encodeURIComponent($('#ebay-mkt').value)); } catch (e) { settingsMsg = e.message; } return paintSettings(); }
      if (has('data-ebay-loc')) {
        const body = {}; document.querySelectorAll('#ebay-loc input').forEach(i => { body[i.name] = i.value; });
        try { await api('/api/ebay/location', { body }); settingsMsg = 'Location created.'; setupInfo = await api('/api/ebay/setup?marketplace=' + encodeURIComponent($('#ebay-mkt').value)); } catch (e) { settingsMsg = e.message; }
        return paintSettings();
      }
      if (has('data-ebay-save')) { try { savePrefs(); } catch (e) { note(e.message, true); } return; }
    } catch (e) { note(e.message, true); return; }

    if (L) {
      if (has('data-ebay-refresh')) return void run(async () => { L.overrides = readOverrides(); await refresh(); });
      if (has('data-ebay-stage')) return void run(doStage);
      if (has('data-ebay-publish')) return void run(doPublish);
      if (has('data-ebay-discard')) return void run(async () => { const item = findItem(L.id); await api('/api/ebay/discard', { body: { sku: skuFor(item), offerId: L.staged.offerId, marketplaceId: prefs().marketplaceId } }); saveEbay(item, { status: 'Not Listed', offerId: '' }); L.staged = null; await refresh(); });
      if (has('data-ebay-sync-one')) return void run(async () => { const item = findItem(L.id); await syncItems([item]); await refresh(); });
      if (has('data-ebay-record-sale')) return recordSale(findItem(L.id));
      if (has('data-ebay-upload')) {
        const files = [...$('#ebay-files').files]; if (!files.length) { L.msg = 'Choose one or more photos first.'; return paintListing(); }
        const role = $('#ebay-role').value;
        return void run(async () => { L.overrides = readOverrides(); await uploadPhotos(findItem(L.id), files, role); await refresh(); });
      }
      if (has('data-ebay-photo-del')) return void run(async () => { const item = findItem(L.id); const id = t.dataset.ebayPhotoDel; try { await api('/api/photos/' + id, { method: 'DELETE', body: {} }); } catch { /* keep going */ } item.photos = item.photos.filter(p => p.id !== id); persist(); L.overrides = readOverrides(); await refresh(); });
    }
    if (B) {
      if (has('data-ebay-brevalidate')) return void validateAll();
      if (has('data-ebay-bstage')) return void bulkStage();
      if (has('data-ebay-bpublish')) return void bulkPublish();
      if (has('data-ebay-bedit')) { const id = B.rows[+t.dataset.ebayBedit].id; B = null; return void openListing(id); }
    }
  });

  document.addEventListener('change', ev => {
    const t = ev.target;
    if (L && t.matches('[data-ebay-approve]')) { L.approve = t.checked; paintListing(); }
    else if (L && t.matches('[data-ebay-ack]')) { L.ack = t.checked; paintListing(); }
    else if (L && t.matches('[data-ebay-photo-role]')) { const p = findItem(L.id).photos.find(x => x.id === t.dataset.ebayPhotoRole); if (p) { p.role = t.value; persist(); refresh(); } }
    else if (B && t.matches('[data-ebay-brow]')) { B.rows[+t.dataset.ebayBrow].include = t.checked; paintBulk(); }
    else if (B && t.matches('[data-ebay-bprice]')) {
      const row = B.rows[+t.dataset.ebayBprice], c = toCents(t.value);
      if (c === null || c < 0) { B.msg = 'Enter a valid price.'; return paintBulk(); }
      row.price = c; row.result = null; B.approve = false; validateAll();
    } else if (B && t.matches('[data-ebay-bapprove]')) { B.approve = t.checked; paintBulk(); }
    else if (B && t.matches('[data-ebay-backn]')) { B.ack = t.checked; paintBulk(); }
    else if (t.id === 'ebay-mkt') { setupInfo = null; }
  });

  window.ebayUI = { extraFields, rowButton, badge, bulkButtons, onRender };
})();
