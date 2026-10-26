'use strict';
const crypto = require('crypto');

class EbayError extends Error {
  constructor(message, { status = 0, code = 'EBAY_ERROR', errors = [], ambiguous = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'EbayError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.ambiguous = ambiguous;
    this.retryAfter = retryAfter;
  }
}

const sleepReal = ms => new Promise(r => setTimeout(r, ms));

function describeErrors(body) {
  const list = Array.isArray(body?.errors) ? body.errors : [];
  return list.map(e => ({
    errorId: e.errorId,
    message: e.longMessage || e.message || 'Unknown eBay error',
    parameters: (e.parameters || []).map(p => `${p.name}=${p.value}`)
  }));
}

function createEbayClient({ config, tokenStore, fetchImpl = fetch, sleep = sleepReal, minIntervalMs = 120, timeoutMs = 30000, maxRetries = 3 }) {
  let refreshing = null;
  let appToken = null;
  let lastStart = 0;

  const basic = () => 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  async function gate() {
    const wait = lastStart + minIntervalMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + minIntervalMs);
    if (wait > 0) await sleep(wait);
  }

  async function tokenRequest(params) {
    let res;
    try {
      res = await fetchImpl(`${config.hosts.api}/identity/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new EbayError('Could not reach eBay to authorize. Check your internet connection and try again.', { code: 'NETWORK' });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const invalid = body.error === 'invalid_grant';
      throw new EbayError(invalid ? 'eBay authorization has expired or was revoked. Reconnect your eBay account.' : `eBay rejected the authorization request: ${body.error_description || body.error || res.status}`,
        { status: res.status, code: invalid ? 'AUTH_EXPIRED' : 'AUTH_FAILED' });
    }
    return body;
  }

  function authorizeUrl(state) {
    const u = new URL(config.hosts.auth);
    u.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', redirect_uri: config.ruName, scope: config.scopes.join(' '), state }).toString();
    return u.toString();
  }

  async function exchangeCode(code) {
    const body = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.ruName });
    const now = Date.now();
    const tokens = {
      accessToken: body.access_token,
      accessExpiresAt: now + (body.expires_in || 7200) * 1000,
      refreshToken: body.refresh_token,
      refreshExpiresAt: now + (body.refresh_token_expires_in || 47304000) * 1000,
      scope: config.scopes.join(' '),
      connectedAt: new Date(now).toISOString()
    };
    tokenStore.set(config.ebayEnv, tokens);
    return tokens;
  }

  async function getUserToken(forceRefresh = false) {
    const tokens = tokenStore.get(config.ebayEnv);
    if (!tokens) throw new EbayError('eBay is not connected. Connect your eBay account in Settings.', { status: 401, code: 'NOT_CONNECTED' });
    if (!forceRefresh && tokens.accessToken && tokens.accessExpiresAt - Date.now() > 5 * 60 * 1000) return tokens.accessToken;
    if (tokens.refreshExpiresAt && tokens.refreshExpiresAt < Date.now()) {
      throw new EbayError('Your eBay authorization expired. Reconnect your eBay account.', { status: 401, code: 'AUTH_EXPIRED' });
    }
    if (!refreshing) {
      refreshing = (async () => {
        const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, scope: config.scopes.join(' ') });
        const updated = { ...tokens, accessToken: body.access_token, accessExpiresAt: Date.now() + (body.expires_in || 7200) * 1000 };
        tokenStore.set(config.ebayEnv, updated);
        return updated.accessToken;
      })().finally(() => { refreshing = null; });
    }
    try { return await refreshing; }
    catch (e) { if (e.code === 'AUTH_EXPIRED') e.status = 401; throw e; }
  }

  async function getAppToken() {
    if (appToken && appToken.expiresAt - Date.now() > 60000) return appToken.value;
    const body = await tokenRequest({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' });
    appToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 7200) * 1000 };
    return appToken.value;
  }

  /**
   * Calls an eBay REST API. Idempotent methods (GET/PUT/DELETE) are retried on 429/5xx/network errors;
   * POST is retried only on 429 (the request was not processed). A POST that times out is reported as
   * `ambiguous` so callers reconcile with a read instead of blindly repeating the write.
   */
  async function request({ method = 'GET', host = 'api', path, query, json, form, headers = {}, auth = 'user' }) {
    const url = new URL(config.hosts[host] + path);
    if (query) Object.entries(query).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
    const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    let refreshedOnce = false;
    for (let attempt = 0; ; attempt++) {
      const token = auth === 'app' ? await getAppToken() : await getUserToken();
      const h = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers };
      let body;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      else if (form) body = form;
      await gate();
      let res;
      try {
        res = await fetchImpl(url, { method, headers: h, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (idempotent && attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw new EbayError(idempotent ? 'Could not reach eBay (network error). Try again.' : 'The eBay request timed out; its outcome is unknown and will be verified before retrying.',
          { code: idempotent ? 'NETWORK' : 'TIMEOUT', ambiguous: !idempotent });
      }
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; } }
      if (res.ok) return { status: res.status, data, headers: res.headers };

      if (res.status === 401 && auth === 'user' && !refreshedOnce) {
        refreshedOnce = true;
        await getUserToken(true);
        continue;
      }
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const rateLimited = res.status === 429 || (data?.errors || []).some(e => e.errorId === 2001 || (e.errorId === 10001 && /limit/i.test(e.message || '')));
      if ((rateLimited || (idempotent && res.status >= 500)) && attempt < maxRetries) {
        await sleep(Math.max(retryAfter * 1000, 1000 * 2 ** attempt));
        continue;
      }
      const errors = describeErrors(data);
      const detail = errors.map(e => e.message).join(' | ') || `HTTP ${res.status}`;
      const code = res.status === 401 ? 'AUTH_EXPIRED' : rateLimited ? 'RATE_LIMITED' : res.status === 404 ? 'NOT_FOUND' : res.status >= 500 ? 'EBAY_UNAVAILABLE' : 'EBAY_REJECTED';
      throw new EbayError(res.status === 401 ? 'eBay rejected the stored authorization. Reconnect your eBay account.' : detail, { status: res.status, code, errors, retryAfter });
    }
  }

  return {
    authorizeUrl, exchangeCode, request, getUserToken, getAppToken,
    newState: () => crypto.randomBytes(16).toString('hex')
  };
}

module.exports = { createEbayClient, EbayError, describeErrors };
