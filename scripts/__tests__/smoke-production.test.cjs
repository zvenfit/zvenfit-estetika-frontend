'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  expectedSecurityHeaders,
  normalizeSiteUrl,
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

test('security header expectations include HSTS only when it is enabled in the config', () => {
  const disabled = { ...securityConfig, hsts: { ...securityConfig.hsts, enabled: false } };
  const enabled = { ...securityConfig, hsts: { ...securityConfig.hsts, enabled: true } };

  assert.equal(expectedSecurityHeaders(disabled)['Strict-Transport-Security'], undefined);
  assert.equal(expectedSecurityHeaders(enabled)['Strict-Transport-Security'], 'max-age=31536000');
  assert.deepEqual(securityHeaderProblems('/', response(200, '', SECURITY_HEADERS), expectedSecurityHeaders(disabled)), []);
  assert.deepEqual(securityHeaderProblems('/', response(200, '', SECURITY_HEADERS), expectedSecurityHeaders(enabled)), [
    '/: missing Strict-Transport-Security',
  ]);
});
