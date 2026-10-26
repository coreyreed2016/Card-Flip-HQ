'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 12 * 1024 * 1024;
const ROLES = ['front', 'back', 'defect', 'other'];

function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** Stores the seller's real item photos on disk (never in localStorage) so they can be uploaded to eBay Picture Services. */
function createPhotoStore({ dir }) {
  const imgDir = path.join(dir, 'photos');
  const indexFile = path.join(dir, 'photos.json');
  let index = null;
  const load = () => {
    if (index) return index;
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { index = { photos: {} }; }
    return index;
  };
  const persist = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
    fs.renameSync(tmp, indexFile);
  };

  return {
    save(buf, { inventoryId, role, name }) {
      if (!inventoryId || typeof inventoryId !== 'string' || inventoryId.length > 80) throw Object.assign(new Error('A valid inventory ID is required for photo upload.'), { code: 'BAD_REQUEST' });
      if (!ROLES.includes(role)) throw Object.assign(new Error(`Photo role must be one of: ${ROLES.join(', ')}.`), { code: 'BAD_REQUEST' });
      if (!buf.length) throw Object.assign(new Error('The uploaded photo is empty.'), { code: 'BAD_REQUEST' });
      if (buf.length > MAX_BYTES) throw Object.assign(new Error('Photo is larger than 12 MB. Resize it and try again.'), { code: 'TOO_LARGE' });
      const type = sniff(buf);
      if (!type) throw Object.assign(new Error('Unsupported image. Upload a JPG, PNG, GIF or WEBP photo.'), { code: 'BAD_IMAGE' });
      const id = crypto.randomBytes(12).toString('hex');
      fs.mkdirSync(imgDir, { recursive: true });
      fs.writeFileSync(path.join(imgDir, `${id}.${type.ext}`), buf);
      const rec = { id, inventoryId, role, name: String(name || 'photo').replace(/[^\w. -]/g, '_').slice(0, 80), mime: type.mime, ext: type.ext, size: buf.length, createdAt: new Date().toISOString(), ebay: {} };
      load().photos[id] = rec;
      persist();
      return rec;
    },
    get: id => (/^[a-f0-9]{24}$/.test(id) ? load().photos[id] || null : null),
    read(id) {
      const rec = this.get(id);
      if (!rec) return null;
      try { return { rec, buffer: fs.readFileSync(path.join(imgDir, `${rec.id}.${rec.ext}`)) }; } catch { return null; }
    },
    setEbay(id, env, info) {
      const rec = this.get(id);
      if (!rec) return;
      rec.ebay[env] = info;
      persist();
    },
    remove(id) {
      const rec = this.get(id);
      if (!rec) return false;
      try { fs.unlinkSync(path.join(imgDir, `${rec.id}.${rec.ext}`)); } catch { /* already gone */ }
      delete load().photos[id];
      persist();
      return true;
    }
  };
}

module.exports = { createPhotoStore, sniff, ROLES, MAX_BYTES };
