'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const HOSTS = {
  production: {
    auth: 'https://auth.ebay.com/oauth2/authorize',
    api: 'https://api.ebay.com',
    apiz: 'https://apiz.ebay.com',
    apim: 'https://apim.ebay.com',
    itemUrl: 'https://www.ebay.com/itm/'
  },
  sandbox: {
    auth: 'https://auth.sandbox.ebay.com/oauth2/authorize',
    api: 'https://api.sandbox.ebay.com',
    apiz: 'https://apiz.sandbox.ebay.com',
    apim: 'https://apim.sandbox.ebay.com',
    itemUrl: 'https://www.sandbox.ebay.com/itm/'
  }
};

const DEFAULT_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly'
];

// Content-Language and category tree per marketplace (Taxonomy API tree IDs).
const MARKETPLACES = {
  EBAY_US: { label: 'United States (EBAY_US)', currency: 'USD', language: 'en-US', treeId: '0' },
  EBAY_CA: { label: 'Canada (EBAY_CA)', currency: 'CAD', language: 'en-CA', treeId: '2' },
  EBAY_GB: { label: 'United Kingdom (EBAY_GB)', currency: 'GBP', language: 'en-GB', treeId: '3' },
  EBAY_AU: { label: 'Australia (EBAY_AU)', currency: 'AUD', language: 'en-AU', treeId: '15' }
};

function loadConfig(env = process.env, hostOverride = null) {
  const ebayEnv = (env.EBAY_ENV || 'sandbox').toLowerCase();
  if (!HOSTS[ebayEnv]) throw new Error('EBAY_ENV must be "sandbox" or "production".');
  return {
    root: ROOT,
    dataDir: env.AURA_DATA_DIR ? path.resolve(env.AURA_DATA_DIR) : path.join(ROOT, 'server-data'),
    port: env.PORT === undefined ? 3000 : Number(env.PORT),
    host: env.HOST || '127.0.0.1',
    ebayEnv,
    hosts: hostOverride || HOSTS[ebayEnv],
    clientId: env.EBAY_CLIENT_ID || '',
    clientSecret: env.EBAY_CLIENT_SECRET || '',
    ruName: env.EBAY_RUNAME || '',
    tokenKey: env.TOKEN_ENCRYPTION_KEY || '',
    scopes: env.EBAY_SCOPES ? env.EBAY_SCOPES.split(/\s+/).filter(Boolean) : DEFAULT_SCOPES
  };
}

function missingConfig(config) {
  const missing = [];
  if (!config.clientId) missing.push('EBAY_CLIENT_ID');
  if (!config.clientSecret) missing.push('EBAY_CLIENT_SECRET');
  if (!config.ruName) missing.push('EBAY_RUNAME');
  if (!/^[0-9a-fA-F]{64}$/.test(config.tokenKey)) missing.push('TOKEN_ENCRYPTION_KEY (64 hex characters)');
  return missing;
}

module.exports = { loadConfig, missingConfig, HOSTS, MARKETPLACES, DEFAULT_SCOPES, ROOT };
