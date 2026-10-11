'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('auth.js handleAuthCallback handles signup correctly', async (t) => {
  const authJs = fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8');

  // Mock environment
  const mockStorage = new Map();
  const globals = {
    window: {
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'test-key',
    },
    sessionStorage: {
      getItem: (key) => mockStorage.get(key) || null,
      setItem: (key, val) => mockStorage.set(key, val),
      removeItem: (key) => mockStorage.delete(key),
    },
    location: {
      search: '',
      hash: '',
      origin: 'https://ecufileservice.in',
      pathname: '/',
    },
    history: {
      replaceState: () => {},
    },
    document: {
      querySelector: (selector) => {
        return {
          textContent: '',
          hidden: false,
          addEventListener: () => {},
          classList: { toggle: () => {}, add: () => {}, remove: () => {} },
          querySelectorAll: () => [],
          focus: () => {},
          appendChild: () => {},
          showModal: () => {},
          close: () => {},
        };
      },
      querySelectorAll: () => [],
      createElement: () => ({ addEventListener: () => {}, style: {} }),
      body: { appendChild: () => {} },
    },
    URLSearchParams: class {
      constructor(str) {
        this.params = new Map();
        if (str) {
          const pairs = str.replace(/^\?/, '').replace(/^#/, '').split('&');
          for (const pair of pairs) {
            const [k, v] = pair.split('=');
            this.params.set(k, v);
          }
        }
      }
      get(name) { return this.params.get(name) || null; }
    },
    fetch: async (url, options) => {
      if (url.includes('/auth/v1/verify')) {
        const body = JSON.parse(options.body);
        if (body.type === 'recovery' && body.token_hash === 'good_recovery_hash') {
          return { ok: true, text: async () => JSON.stringify({ access_token: 'new_access_token', user: { id: 'user1', email: 'test@example.com' } }) };
        }
        if (body.type === 'signup' && body.token_hash === 'good_signup_hash') {
          return { ok: true, text: async () => JSON.stringify({ access_token: 'new_access_token', user: { id: 'user1', email: 'test@example.com' } }) };
        }
        return { ok: false, status: 400, text: async () => JSON.stringify({ error: 'invalid_token' }) };
      }
      if (url.includes('/auth/v1/user')) {
        return { ok: true, text: async () => JSON.stringify({ id: 'user1', email: 'test@example.com' }) };
      }
      if (url.includes('/api/health')) {
        return { ok: true, json: async () => ({ configured: true }) };
      }
      return { ok: true, text: async () => '' };
    },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Intl: global.Intl,
    JSON: global.JSON,
    Error: global.Error,
    Math: global.Math,
    Date: global.Date,
    String: global.String,
    Number: global.Number,
    Boolean: global.Boolean,
    Array: global.Array,
    Object: global.Object,
    URL: global.URL,
    setTimeout: global.setTimeout,
  };

  globals.window.supabase = {
    createClient: () => ({
      channel: () => ({ on: () => ({ subscribe: () => {} }) }),
      realtime: { setAuth: () => {} }
    })
  };

  // Run the script in the mocked global context
  const run = (search, hash) => {
    globals.location.search = search;
    globals.location.hash = hash;
    const fn = new Function(...Object.keys(globals), authJs);
    fn(...Object.values(globals));
  };

  await t.test('handles signup with access_token in hash', () => {
    mockStorage.clear();
    run('', '#type=signup&access_token=test_token&expires_in=3600');
    
    const session = JSON.parse(mockStorage.get('efsi-auth-session'));
    assert.ok(session, 'Session should be saved');
    assert.equal(session.access_token, 'test_token');
    // Note: The second saveSession with user data is async (api.auth.getUser), 
    // so we might need a small delay or mock it differently if we want to check it.
  });

  await t.test('handles signup with token_hash in query (detecting type issue)', async () => {
    mockStorage.clear();
    let capturedBody = null;
    const originalFetch = globals.fetch;
    globals.fetch = async (url, options) => {
      if (url.includes('/auth/v1/verify')) {
        capturedBody = JSON.parse(options.body);
      }
      return originalFetch(url, options);
    };

    run('?type=signup&token_hash=good_signup_hash', '');
    
    // We need to wait for the async handleAuthCallback to complete its internal fetch
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(capturedBody, 'Should have called verify');
    // This is where we expect it to be 'signup' but currently it might be 'recovery'
    assert.equal(capturedBody.type, 'signup', 'Verification type should be signup for signup links');
    
    globals.fetch = originalFetch;
  });
});
