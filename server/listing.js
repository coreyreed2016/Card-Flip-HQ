'use strict';
const crypto = require('crypto');

/* eBay condition-descriptor IDs for trading cards (categories 183050 / 183454 / 261328).
   Source: developer.ebay.com MIP user guide "Condition Descriptor IDs for Trading Cards". */
const CCG_CATEGORY = '183454';
const UNGRADED_CARD_CONDITION = {
  nm: { id: '400010', label: 'Near Mint or Better' },
  lp: { id: '400015', label: 'Lightly Played (Excellent)' },
  mp: { id: '400016', label: 'Moderately Played (Very Good)' },
  hp: { id: '400017', label: 'Heavily Played (Poor)' }
};
const GRADERS = {
  psa: ['275010', 'PSA'], bccg: ['275011', 'BCCG'], bvg: ['275012', 'BVG'], bgs: ['275013', 'BGS'], beckett: ['275013', 'BGS'],
  cgc: ['275015', 'CGC'], sgc: ['275016', 'SGC'], ksa: ['275017', 'KSA'], gma: ['275018', 'GMA'], hga: ['275019', 'HGA'],
  isa: ['2750110', 'ISA'], gsg: ['2750112', 'GSG'], pgs: ['2750113', 'PGS'], mnt: ['2750114', 'MNT'], tag: ['2750115', 'TAG'],
  rcg: ['2750117', 'RCG'], ace: ['2750119', 'ACE'], cga: ['2750120', 'CGA']
};
const OTHER_GRADER = '2750123';
const GRADE_IDS = {
  '10': '275020', '9.5': '275021', '9': '275022', '8.5': '275023', '8': '275024', '7.5': '275025', '7': '275026', '6.5': '275027',
  '6': '275028', '5.5': '275029', '5': '2750210', '4.5': '2750211', '4': '2750212', '3.5': '2750213', '3': '2750214',
  '2.5': '2750215', '2': '2750216', '1.5': '2750217', '1': '2750218', authentic: '2750219'
};

const esc = v => String(v ?? '');
const clean = v => esc(v).replace(/\s+/g, ' ').trim();
const SKU_RE = /^[A-Za-z0-9_-]{1,50}$/;
const centsToValue = c => (Math.round(c) / 100).toFixed(2);
const asCents = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

function conditionCode(label) {
  const s = esc(label).toLowerCase();
  if (/near mint|\bnm\b/.test(s)) return 'nm';
  if (/lightly|\blp\b/.test(s)) return 'lp';
  if (/moderately|\bmp\b/.test(s)) return 'mp';
  if (/heavily|\bhp\b/.test(s)) return 'hp';
  if (/damaged|\bdmg\b/.test(s)) return 'dmg';
  return null;
}

function parseGrade(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  if (/authentic/.test(s)) return 'authentic';
  const m = s.match(/(\d{1,2}(?:\.\d)?)\s*$/) || s.match(/(\d{1,2}(?:\.\d)?)/);
  if (!m) return null;
  const n = String(Number(m[1]));
  return GRADE_IDS[n] ? n : null;
}

function resolveGrader(item) {
  const name = clean(item.gradingCompany || String(item.gradingStatus || '').replace(/ graded$/i, '').replace(/^beckett \/ /i, ''));
  const key = name.toLowerCase().split(/[^a-z]+/).find(t => GRADERS[t]);
  if (key) return { id: GRADERS[key][0], short: GRADERS[key][1], other: false };
  return { id: OTHER_GRADER, short: name || 'Graded', other: true };
}

function isGraded(item) { return !!item.gradingStatus && item.gradingStatus !== 'Raw / Ungraded'; }

function rarityFromVariant(variant) {
  const first = clean(String(variant || '').split('·')[0]);
  return first && first.length <= 60 ? first : '';
}

function buildTitle(item, { graded, grader, gradeText }) {
  const lang = clean(item.language);
  const code = conditionCode(item.condition);
  const parts = [
    { t: item.game ? clean(item.game) : 'Pokémon', p: 5 },
    { t: clean(item.cardName), p: 10 },
    { t: item.cardNumber ? `#${clean(item.cardNumber).replace(/^#/, '')}` : '', p: 9 },
    { t: clean(item.set), p: 7 },
    { t: clean(item.releaseYear), p: 2 },
    { t: rarityFromVariant(item.variant), p: 4 },
    { t: clean(item.finish), p: 5 },
    { t: clean(item.edition), p: 6 },
    { t: lang && !/^english$/i.test(lang) ? lang : '', p: 3 },
    { t: graded ? [grader, gradeText].filter(Boolean).join(' ') : (code && code !== 'dmg' ? code.toUpperCase() : code === 'dmg' ? 'Damaged' : ''), p: 10 }
  ].filter(x => x.t);
  // Drop repeated words already present earlier in the title (e.g. set name inside card name).
  const seen = [];
  const kept = parts.filter(x => { const dup = seen.some(s => s.toLowerCase().includes(x.t.toLowerCase())); if (!dup) seen.push(x.t); return !dup; });
  const join = list => list.map(x => x.t).join(' ');
  let list = kept.slice();
  while (join(list).length > 80 && list.length > 1) {
    const lowest = Math.min(...list.map(x => x.p));
    if (lowest >= 9) break;
    list.splice(list.findIndex(x => x.p === lowest), 1);
  }
  let title = join(list);
  if (title.length > 80) title = title.slice(0, 80).replace(/\s+\S*$/, '');
  return title;
}

function buildDescription(item, { graded, grader, gradeText, gradeVerified, prefs, qty }) {
  const lines = [];
  const add = (label, value) => { if (clean(value)) lines.push(`${label}: ${clean(value)}`); };
  lines.push('CARD DETAILS');
  add('Card', item.cardName); add('Pokémon / character', item.pokemon); add('Set', item.set); add('Card number', item.cardNumber);
  add('Year', item.releaseYear); add('Language', item.language); add('Rarity / variant', item.variant); add('Finish', item.finish); add('Edition / stamp', item.edition);
  lines.push('', 'CONDITION');
  if (graded && gradeVerified) {
    lines.push(`Professionally graded: ${grader} ${gradeText}.`);
    if (clean(item.certificationNumber)) lines.push(`Certification number: ${clean(item.certificationNumber)}`);
  } else {
    lines.push(`Condition (seller assessment): ${clean(item.condition) || 'Not specified'}.`);
  }
  if (clean(item.defects)) lines.push(`Wear / defects noted by seller: ${clean(item.defects)}`);
  lines.push('Please review all photos. They show the actual item you will receive.');
  const acc = (Array.isArray(item.accessoriesIncluded) ? item.accessoriesIncluded : []).filter(a => a && a !== 'None').map(a => (a === 'Other' ? clean(item.otherAccessoryDescription) : a)).filter(Boolean);
  if (acc.length) lines.push('', `INCLUDED: ${acc.join(', ')}`);
  if (qty > 1) lines.push('', `Quantity available: ${qty}`);
  if (prefs.handlingDays) lines.push('', `Ships within ${prefs.handlingDays} business day${prefs.handlingDays === 1 ? '' : 's'} of cleared payment.`);
  if (clean(prefs.descriptionFooter)) lines.push('', String(prefs.descriptionFooter).trim());
  return lines.join('\n');
}

/** Plain text -> safe HTML for eBay (all user text is escaped; no user HTML is ever passed through). */
function descriptionToHtml(text) {
  const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return String(text).split(/\n{2,}/).map(block => `<p>${e(block).replace(/\n/g, '<br>')}</p>`).join('');
}

function computeProfit({ priceCents, qty, shippingCharged, shippingCost, packagingCost, acquisitionCost, feePercent, perOrderFee, adRatePercent }) {
  const itemTotal = priceCents * qty;
  const revenue = itemTotal + shippingCharged;
  const ebayFees = Math.round(revenue * feePercent / 100) + perOrderFee;
  const adFees = Math.round(itemTotal * adRatePercent / 100);
  const fees = ebayFees + adFees;
  const net = revenue - fees;
  const cost = acquisitionCost * qty;
  const profit = net - cost - shippingCost - packagingCost;
  return { purchaseCost: cost, listingPrice: itemTotal, shippingCharged, estimatedFees: fees, estimatedShippingCost: shippingCost, estimatedPackagingCost: packagingCost,
    estimatedNet: net, estimatedProfit: profit, estimatedMargin: revenue > 0 ? profit / revenue : 0, assumptions: { feePercent, perOrderFee, adRatePercent } };
}

/**
 * Builds a listing draft from an inventory record. Nothing is invented: missing data becomes an error or warning.
 * errors  = block staging/publishing; warnings = must be acknowledged by the seller; notes = informational.
 */
function buildDraft({ item, prefs = {}, overrides = {}, photoLookup = () => null, aspectMeta = null, marketplace }) {
  const errors = [], warnings = [], notes = [];
  const productType = ['card', 'sealed', 'other'].includes(item.productType) ? item.productType : 'card';
  const graded = productType === 'card' && isGraded(item);
  const sku = clean(overrides.sku || item.sku || item.id);
  if (!SKU_RE.test(sku)) errors.push('SKU may only contain letters, numbers, hyphens and underscores (max 50 characters).');

  // Quantity: one-of-a-kind cards default to 1, never to the owned quantity.
  const qty = overrides.quantity !== undefined ? Number(overrides.quantity) : 1;
  if (!Number.isInteger(qty) || qty < 1) errors.push('Quantity must be a whole number of at least 1.');
  const owned = Math.max(1, parseInt(item.quantity, 10) || 1);
  if (Number.isInteger(qty) && qty > owned) errors.push(`Listing quantity (${qty}) exceeds the quantity you own (${owned}).`);
  const listQty = Number.isInteger(qty) && qty > 0 ? qty : 1;

  // Condition
  let condition = null;
  let gradeText = '', grader = '', gradeVerified = false;
  if (productType === 'card') {
    if (graded) {
      const g = resolveGrader(item);
      const gradeKey = parseGrade(item.grade);
      grader = g.short;
      gradeText = gradeKey ? (gradeKey === 'authentic' ? 'Authentic' : gradeKey) : '';
      gradeVerified = item.gradeVerified === 'Yes';
      if (!clean(item.gradingCompany) && !clean(item.gradingStatus)) errors.push('Graded card is missing the grading company.');
      if (!gradeKey) errors.push(`Grade "${clean(item.grade)}" is missing or not a grade eBay supports (10, 9.5, … 1, Authentic).`);
      if (!gradeVerified) errors.push('Graded cards require you to confirm the grade was verified against the slab/label ("Grade verified" = Yes). Grading details are never listed unverified.');
      if (g.other) warnings.push(`Grading company "${clean(item.gradingCompany) || item.gradingStatus}" is not in eBay's grader list; it will be sent as "Other".`);
      const cert = clean(item.certificationNumber);
      if (cert.length > 30) errors.push('Certification number is longer than eBay\'s 30-character limit.');
      if (gradeKey && gradeVerified) {
        const descriptors = [{ name: '27501', values: [g.id] }, { name: '27502', values: [GRADE_IDS[gradeKey]] }];
        if (cert) descriptors.push({ name: '27503', additionalInfo: cert });
        condition = { enum: 'LIKE_NEW', descriptors, description: '' };
      }
    } else {
      const code = conditionCode(item.condition);
      if (!code) errors.push('Card condition is missing or not recognised. Choose Near Mint, Lightly Played, Moderately Played, Heavily Played or Damaged.');
      else {
        const mapped = UNGRADED_CARD_CONDITION[code === 'dmg' ? 'hp' : code];
        if (code === 'dmg') warnings.push('eBay has no "Damaged" card condition. It will be listed as Heavily Played (Poor); describe the damage in "Wear / defects".');
        if (code !== 'nm' && !clean(item.defects)) warnings.push('Condition is below Near Mint but no wear/defects are described. Add a description of the wear.');
        condition = { enum: 'USED_VERY_GOOD', descriptors: [{ name: '40001', values: [mapped.id] }], description: clean(item.defects).slice(0, 1000) };
      }
    }
  } else if (productType === 'sealed') {
    condition = { enum: 'NEW', descriptors: [], description: '' };
    notes.push('Sealed product: condition set to New. Only list factory-sealed product this way.');
  } else {
    errors.push('This product type has no condition mapping yet. Choose "Single card" or "Sealed product".');
  }

  // Price (editable listing price; never overwrites the inventory selling price)
  const priceCents = asCents(overrides.price !== undefined ? overrides.price : item.targetSalePrice);
  if (!priceCents) errors.push(`Enter a selling price greater than $0.00${+item.estimatedValue > 0 ? ` (estimated market value on record: $${centsToValue(+item.estimatedValue)}; it is not used automatically).` : '.'}`);
  const num = (key, fallback) => { const v = asCents(overrides[key] !== undefined ? overrides[key] : (prefs[key] ?? fallback)); return v === null ? 0 : v; };
  const shippingCharged = num('shippingCharged', 0), shippingCost = num('shippingCost', 0), packagingCost = num('packagingCost', 0);
  for (const key of ['shippingCharged', 'shippingCost', 'packagingCost']) {
    const raw = overrides[key] !== undefined ? overrides[key] : prefs[key];
    if (raw !== undefined && raw !== null && raw !== '' && asCents(raw) === null) errors.push(`${key} must be a non-negative amount.`);
  }
  if (!shippingCost) warnings.push('Estimated shipping cost is $0.00, so profit may be overstated.');

  // Photos
  const photos = (Array.isArray(item.photos) ? item.photos : []).map(p => ({ id: p.id, role: p.role })).filter(p => p.id);
  const resolved = photos.map(p => ({ ...p, rec: photoLookup(p.id) }));
  const missingFiles = resolved.filter(p => !p.rec || p.rec.inventoryId !== item.id);
  if (missingFiles.length) errors.push(`${missingFiles.length} photo file(s) are missing on the server. Remove and re-upload them.`);
  const ok = resolved.filter(p => p.rec && p.rec.inventoryId === item.id);
  if (!ok.some(p => p.role === 'front')) errors.push('A front photo of the actual item is required.');
  if (!ok.some(p => p.role === 'back')) errors.push('A back photo of the actual item is required.');
  if (ok.length > 24) errors.push('eBay allows at most 24 photos per listing.');
  if (productType === 'card' && !graded && ['lp', 'mp', 'hp', 'dmg'].includes(conditionCode(item.condition)) && !ok.some(p => p.role === 'defect')) {
    warnings.push('No close-up photos of wear/defects. Buyers expect close-ups when a card is not Near Mint.');
  }

  // Category
  const categoryId = clean(overrides.categoryId || (productType === 'card' ? CCG_CATEGORY : ''));
  if (!/^\d{1,12}$/.test(categoryId)) errors.push('Choose an eBay category (search suggestions in the preview).');
  if (productType === 'card' && categoryId === CCG_CATEGORY && marketplace?.id && marketplace.id !== 'EBAY_US') notes.push(`Default category ${CCG_CATEGORY} is the US "CCG Individual Cards" category; confirm it exists on ${marketplace.id}.`);

  // Policies / location
  if (!prefs.fulfillmentPolicyId) errors.push('Select a shipping (fulfillment) policy in Settings → eBay Integration.');
  if (!prefs.paymentPolicyId) errors.push('Select a payment policy in Settings → eBay Integration.');
  if (!prefs.returnPolicyId) errors.push('Select a return policy in Settings → eBay Integration.');
  if (!prefs.merchantLocationKey) errors.push('Select or create an inventory location in Settings → eBay Integration.');

  // Card data completeness (never invented; flagged for review)
  if (!clean(item.cardName)) errors.push('Card name is required.');
  if (productType === 'card') {
    if (!clean(item.set)) warnings.push('Set name is missing.');
    if (!clean(item.cardNumber)) warnings.push('Card number is missing.');
    if (!clean(item.language)) warnings.push('Language is missing.');
    if (!clean(item.finish)) warnings.push('Finish (holo / reverse holo / non-holo) is not recorded; it will not appear in the listing.');
    if (!rarityFromVariant(item.variant)) warnings.push('Rarity is not recorded; it will not appear in the listing.');
    else notes.push('Rarity is taken from the first part of "Variant / rarity". Confirm it in the item specifics.');
  }
  if (!+item.acquisitionCost) warnings.push('Purchase cost is $0.00 or missing, so profit is overstated.');

  // Title and description
  const autoTitle = buildTitle(item, { graded: graded && gradeVerified, grader, gradeText });
  const title = clean(overrides.title !== undefined && overrides.title !== '' ? overrides.title : autoTitle);
  if (!title) errors.push('Listing title is empty.');
  if (title.length > 80) errors.push(`Title is ${title.length} characters; eBay allows 80.`);
  const autoDescription = buildDescription(item, { graded, grader, gradeText, gradeVerified, prefs, qty: listQty });
  const description = overrides.description !== undefined && overrides.description !== '' ? String(overrides.description) : autoDescription;
  if (description.length > 4000) warnings.push('Description is unusually long; check it before publishing.');

  // Item specifics
  const aspects = {};
  const setAspect = (k, v) => { const s = clean(v); if (s) aspects[k] = s; };
  if (productType === 'card' || productType === 'sealed') {
    setAspect('Game', item.game || 'Pokémon TCG');
    setAspect('Set', item.set);
    setAspect('Language', item.language);
    setAspect('Year Manufactured', item.releaseYear);
  }
  if (productType === 'card') {
    setAspect('Character', item.pokemon);
    setAspect('Card Name', item.cardName);
    setAspect('Card Number', item.cardNumber);
    setAspect('Rarity', rarityFromVariant(item.variant));
    setAspect('Finish', item.finish);
    setAspect('Features', item.edition);
  }
  let finalAspects = { ...aspects, ...(overrides.aspects || {}) };
  Object.keys(finalAspects).forEach(k => { if (!clean(finalAspects[k])) delete finalAspects[k]; });
  if (aspectMeta) {
    const byLower = new Map(Object.keys(aspectMeta.aspects).map(n => [n.toLowerCase(), n]));
    const mapped = {};
    for (const [k, v] of Object.entries(finalAspects)) {
      const canonical = byLower.get(k.toLowerCase());
      if (!canonical) { notes.push(`Item specific "${k}" is not offered by this category and was left out.`); continue; }
      mapped[canonical] = v;
      const meta = aspectMeta.aspects[canonical];
      if (meta.selectionOnly && meta.values.length && !meta.values.some(x => x.toLowerCase() === clean(v).toLowerCase())) warnings.push(`"${v}" is not one of eBay's accepted values for ${canonical}.`);
    }
    finalAspects = mapped;
    for (const [name, meta] of Object.entries(aspectMeta.aspects)) if (meta.required && !clean(finalAspects[name])) errors.push(`Required item specific "${name}" is missing.`);
  } else {
    notes.push('Item specifics could not be checked against eBay\'s category requirements (not connected). Required specifics are verified when you create the draft.');
  }

  const feePercent = Number.isFinite(Number(prefs.feePercent)) ? Number(prefs.feePercent) : 13.25;
  const profit = computeProfit({
    priceCents: priceCents || 0, qty: listQty, shippingCharged, shippingCost, packagingCost,
    acquisitionCost: Math.max(0, Math.round(+item.acquisitionCost || 0)), feePercent,
    perOrderFee: asCents(prefs.perOrderFee) ?? 40, adRatePercent: Number(prefs.adRatePercent) || 0
  });
  if (priceCents) {
    const minProfit = asCents(prefs.minProfit) ?? 0;
    if (profit.estimatedProfit < 0) warnings.push(`LOSS: this listing is estimated to lose $${centsToValue(-profit.estimatedProfit)}.`);
    else if (profit.estimatedProfit < minProfit) warnings.push(`Estimated profit $${centsToValue(profit.estimatedProfit)} is below your minimum of $${centsToValue(minProfit)}.`);
  }

  return {
    sku, productType, title, autoTitle, description, autoDescription, categoryId, quantity: listQty, priceCents: priceCents || 0,
    currency: marketplace?.currency || 'USD', shippingCharged, shippingCost, packagingCost, condition, aspects: finalAspects,
    photos: ok.map(p => ({ id: p.id, role: p.role })), profit, errors, warnings, notes,
    policies: { fulfillmentPolicyId: prefs.fulfillmentPolicyId || '', paymentPolicyId: prefs.paymentPolicyId || '', returnPolicyId: prefs.returnPolicyId || '' },
    merchantLocationKey: prefs.merchantLocationKey || '', marketplaceId: marketplace?.id || 'EBAY_US'
  };
}

const fingerprint = d => crypto.createHash('sha256').update(JSON.stringify([
  d.sku, d.title, d.description, d.categoryId, d.priceCents, d.quantity, d.currency, d.condition, d.aspects, d.photos, d.policies, d.merchantLocationKey, d.marketplaceId
])).digest('hex');

function buildPayloads(draft, imageUrls) {
  const aspects = {};
  Object.entries(draft.aspects).forEach(([k, v]) => { aspects[k] = [String(v)]; });
  const inventoryItem = {
    availability: { shipToLocationAvailability: { quantity: draft.quantity } },
    condition: draft.condition.enum,
    product: { title: draft.title, description: descriptionToHtml(draft.description), aspects, imageUrls }
  };
  if (draft.condition.descriptors.length) inventoryItem.conditionDescriptors = draft.condition.descriptors;
  if (draft.condition.description) inventoryItem.conditionDescription = draft.condition.description;
  const offer = {
    sku: draft.sku,
    marketplaceId: draft.marketplaceId,
    format: 'FIXED_PRICE',
    availableQuantity: draft.quantity,
    categoryId: draft.categoryId,
    listingDescription: descriptionToHtml(draft.description),
    listingDuration: 'GTC',
    includeCatalogProductDetails: false,
    listingPolicies: draft.policies,
    merchantLocationKey: draft.merchantLocationKey,
    pricingSummary: { price: { value: centsToValue(draft.priceCents), currency: draft.currency } }
  };
  return { inventoryItem, offer };
}

module.exports = { buildDraft, buildPayloads, fingerprint, computeProfit, descriptionToHtml, buildTitle, conditionCode, parseGrade, CCG_CATEGORY, SKU_RE };
