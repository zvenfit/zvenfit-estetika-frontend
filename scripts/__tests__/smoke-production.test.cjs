'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeSiteUrl, runSmoke } = require('../smoke-production.cjs');

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

test('production smoke uses only read-only GET and OPTIONS requests', async () => {
  const requests = [];
  const routes = new Map([
    ['https://estetika.zvenfit.ru/', response(200, '<main>home</main>')],
    ['https://estetika.zvenfit.ru/form/', response(200, '<form id="wf-form-tg-send"></form>')],
    ['https://estetika.zvenfit.ru/documents/privacy-policy.html', response(200, '<html></html>')],
    [
      'https://estetika.zvenfit.ru/documents/personal-data-processing.html',
      response(200, '<html></html>'),
    ],
    ['https://estetika.zvenfit.ru/codex-production-smoke-not-found', response(404, 'not found')],
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

  const result = await runSmoke({
    leadApiUrl: 'https://lead.example.test/',
    fetchImpl: async (url, options = {}) => {
      requests.push({ method: options.method || 'GET', url });
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
    ['GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'GET', 'OPTIONS'],
  );
  assert.ok(requests.every(item => item.method !== 'POST'));
});
