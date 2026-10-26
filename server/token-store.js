'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** AES-256-GCM encrypted token file. Tokens never leave the server process. */
function createTokenStore({ dir, key }) {
  const validKey = /^[0-9a-fA-F]{64}$/.test(key || '');
  const keyBuf = validKey ? Buffer.from(key, 'hex') : null;
  // Fail on use, not on startup, so the app can still run and explain what is missing.
  const requireKey = () => {
    if (validKey) return;
    const err = new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    err.code = 'NO_ENCRYPTION_KEY';
    throw err;
  };
  const file = path.join(dir, 'ebay-tokens.enc.json');

  function readAll() {
    requireKey();
    if (!fs.existsSync(file)) return {};
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  function writeAll(all) {
    requireKey();
    fs.mkdirSync(dir, { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(all), 'utf8'), cipher.final()]);
    const blob = { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return {
    get(env) {
      try { return readAll()[env] || null; }
      catch { const e = new Error('Stored eBay tokens could not be decrypted (wrong TOKEN_ENCRYPTION_KEY?). Disconnect and reconnect eBay.'); e.code = 'TOKEN_DECRYPT_FAILED'; throw e; }
    },
    set(env, tokens) {
      let all = {};
      try { all = readAll(); } catch { all = {}; }
      all[env] = tokens;
      writeAll(all);
    },
    clear(env) {
      let all = {};
      try { all = readAll(); } catch { all = {}; }
      delete all[env];
      writeAll(all);
    }
  };
}

module.exports = { createTokenStore };
