'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  expectedSecurityHeaders,
  fetchWithRetry,
  hstsProblems,
  normalizeSiteUrl,
  runHeaderChecks,
  runSmoke,
  securityHeaderProblems,
} = require('../smoke-production.cjs');
const securityConfig = require('../cdn-security-headers.json');

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function response(status, body, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null;
      },
    },
    async text() {
      return body;
    },
  };
}

test('production smoke rejects insecure non-local site URLs', () => {
  assert.throws(() => normalizeSiteUrl('http://example.com'), /must use HTTPS/);
  assert.equal(normalizeSiteUrl('http://localhost:4173/path'), 'http://localhost:4173');
});

function productionRoutes(headers = SECURITY_HEADERS) {
  return new Map([
    ['https://estetika.zvenfit.ru/', response(200, '<main>home</main>', headers)],
    ['https://estetika.zvenfit.ru/form/', response(200, '<form id="wf-form-tg-send"></form>', headers)],
    ['https://estetika.zvenfit.ru/privacy/', response(200, '<html></html>', headers)],
    ['https://estetika.zvenfit.ru/personal-data-processing/', response(200, '<html></html>', headers)],
    ['https://estetika.zvenfit.ru/404.html', response(200, '<html></html>', headers)],
    [
      'https://estetika.zvenfit.ru/documents/privacy-policy.html',
      response(301, '', { location: '/privacy/' }),
    ],
    [
      'https://estetika.zvenfit.ru/documents/personal-data-processing.html',
      response(301, '', { location: '/personal-data-processing/' }),
    ],
    ['https://estetika.zvenfit.ru/codex-production-smoke-not-found', response(404, 'not found', headers)],
    ['https://estetika.zvenfit.ru/robots.txt', response(200, 'Sitemap: https://estetika.zvenfit.ru/sitemap.xml')],
    [
      'https://estetika.zvenfit.ru/js/lead-config.js',
      response(200, "window.ZVENFIT_LEAD_API = 'https://lead.example.test/';"),
    ],
    [
      'https://lead.example.test/',
      response(204, '', { 'access-control-allow-origin': 'https://estetika.zvenfit.ru' }),
    ],
  ]);
}

test('production smoke uses only read-only GET and OPTIONS requests', async () => {
  const requests = [];
  const routes = productionRoutes();

  const result = await runSmoke({
    leadApiUrl: 'https://lead.example.test/',
    fetchImpl: async (url, options = {}) => {
      requests.push({ method: options.method || 'GET', redirect: options.redirect, url });
      const route = routes.get(url);
      assert.ok(route, `unexpected request: ${options.method || 'GET'} ${url}`);
      return route;
    },
    waitImpl: async () => {},
    log() {},
    warn() {},
  });

  assert.equal(result.origin, 'https://estetika.zvenfit.ru');
  assert.deepEqual(
    requests.map(item => item.method),
    ['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'OPTIONS'],
  );
  assert.ok(requests.every(item => item.method !== 'POST'));
  assert.deepEqual(
    requests.filter(item => item.redirect === 'manual').map(item => item.url),
    [
      'https://estetika.zvenfit.ru/documents/privacy-policy.html',
      'https://estetika.zvenfit.ru/documents/personal-data-processing.html',
    ],
  );
});

test('production smoke fails when the CDN omits or alters security headers', async () => {
  const { 'x-frame-options': _omitted, ...withoutFrameOptions } = SECURITY_HEADERS;
  const routes = productionRoutes({ ...withoutFrameOptions, 'referrer-policy': 'no-referrer' });

  await assert.rejects(
    runSmoke({
      leadApiUrl: 'https://lead.example.test/',
      fetchImpl: async url => routes.get(url),
      waitImpl: async () => {},
      log() {},
      warn() {},
    }),
    /CDN security headers mismatch[\s\S]*missing X-Frame-Options[\s\S]*Referrer-Policy is "no-referrer"/,
  );
});

test('header checks sample only the five public pages and the real 404 without a lead API', async () => {
  const routes = productionRoutes();
  const counts = new Map();
  await runHeaderChecks({
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'HEAD');
      assert.equal(options.redirect, 'manual');
      const { pathname } = new URL(url);
      counts.set(pathname, (counts.get(pathname) || 0) + 1);
      return routes.get(url);
    },
    waitImpl: async () => {},
    log() {},
  });
  assert.deepEqual(Object.fromEntries(counts), {
    '/': 3, '/form/': 3, '/privacy/': 3, '/personal-data-processing/': 3,
    '/404.html': 3, '/codex-production-smoke-not-found': 3,
  });
});

test('a single bad header sample on the 404 is reported even if the next would pass', async () => {
  const routes = productionRoutes();
  let notFoundSamples = 0;
  await assert.rejects(runHeaderChecks({
    fetchImpl: async url => {
      if (url.endsWith('/codex-production-smoke-not-found') && ++notFoundSamples === 2) {
        return response(404, '', { ...SECURITY_HEADERS, 'x-frame-options': 'SAMEORIGIN' });
      }
      return routes.get(url);
    },
    waitImpl: async () => {},
    log() {},
  }), /sample 2[\s\S]*not-found: X-Frame-Options is "SAMEORIGIN"/);
});

test('a branded error page served with HTTP 200 fails the headers-only check', async () => {
  const routes = productionRoutes();
  await assert.rejects(runHeaderChecks({
    fetchImpl: async url => url.endsWith('/codex-production-smoke-not-found')
      ? response(200, '', SECURITY_HEADERS) : routes.get(url),
    waitImpl: async () => {},
    log() {},
  }), /not-found returned 200, expected 404/);
});

test('HSTS is checked as a rule only when it is enabled in the config', () => {
  const config = enabled => ({ ...securityConfig, hsts: { ...securityConfig.hsts, enabled } });
  const withHsts = value => response(200, '', { 'strict-transport-security': value });

  assert.equal(expectedSecurityHeaders(config(true))['Strict-Transport-Security'], undefined);
  assert.deepEqual(hstsProblems('/', withHsts('max-age=1'), config(false)), []);
  assert.deepEqual(hstsProblems('/', withHsts('max-age=31536000'), config(true)), []);
  assert.deepEqual(hstsProblems('/', withHsts('max-age=99999999'), config(true)), []);
  assert.deepEqual(hstsProblems('/', response(200, ''), config(true)), ['/: missing Strict-Transport-Security']);
  assert.match(hstsProblems('/', withHsts('max-age=300'), config(true))[0], /below 31536000/);
  assert.match(hstsProblems('/', withHsts('max-age=31536000; includeSubDomains'), config(true))[0], /must not include/);
  assert.match(hstsProblems('/', withHsts('max-age=31536000; preload'), config(true))[0], /must not include/);
  assert.match(hstsProblems('/', withHsts('includeSubDomains'), config(true))[0], /has no max-age/);
});

test('a header mismatch is retried and only a consistent response passes', async () => {
  const bad = response(200, '', {});
  const good = response(200, '', SECURITY_HEADERS);
  const sequence = [bad, bad, good];
  const waits = [];
  const found = await fetchWithRetry('https://estetika.zvenfit.ru/', {}, [200], {
    fetchImpl: async () => sequence.shift(),
    waitImpl: async ms => waits.push(ms),
    validate: res => securityHeaderProblems('/', res),
  });

  assert.equal(found, good);
  assert.equal(waits.length, 2);

  await assert.rejects(
    fetchWithRetry('https://estetika.zvenfit.ru/', {}, [200], {
      fetchImpl: async () => bad,
      waitImpl: async () => {},
      validate: res => securityHeaderProblems('/', res),
    }),
    /CDN security headers mismatch[\s\S]*missing X-Content-Type-Options/,
  );
});
