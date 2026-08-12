'use strict';

const DEFAULT_SITE_URL = 'https://estetika.zvenfit.ru';
const ATTEMPTS = 6;
const RETRY_MS = 5000;
const TIMEOUT_MS = 15000;

function normalizeSiteUrl(value) {
  const url = new URL(value || DEFAULT_SITE_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('smoke-production: SITE_URL must use HTTPS');
  }

  return url.origin;
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(
  url,
  options = {},
  expectedStatuses = [200],
  { fetchImpl = globalThis.fetch, waitImpl = wait } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (expectedStatuses.includes(response.status)) return response;
      lastError = new Error(`${url} returned ${response.status}, expected ${expectedStatuses.join('/')}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < ATTEMPTS) await waitImpl(RETRY_MS);
  }
  throw lastError;
}

async function runSmoke({
  siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL,
  leadApiUrl = process.env.LEAD_API_URL || '',
  fetchImpl = globalThis.fetch,
  waitImpl = wait,
  log = console.log,
  warn = console.warn,
} = {}) {
  const origin = normalizeSiteUrl(siteUrl);
  const apiUrl = String(leadApiUrl).trim();
  if (!apiUrl) throw new Error('smoke-production: LEAD_API_URL is required');

  const fetchChecked = (url, options, statuses) =>
    fetchWithRetry(url, options, statuses, { fetchImpl, waitImpl });
  const assertPage = async (pathname, pattern) => {
    const response = await fetchChecked(`${origin}${pathname}`);
    const body = await response.text();
    if (!pattern.test(body)) throw new Error(`${pathname} does not contain the expected page marker`);
    return response;
  };

  const home = await assertPage('/', /<main[\s>]/i);
  await assertPage('/form/', /id=["']wf-form-tg-send["']/i);
  await assertPage('/documents/privacy-policy.html', /<html/i);
  await assertPage('/documents/personal-data-processing.html', /<html/i);
  await fetchChecked(`${origin}/codex-production-smoke-not-found`, {}, [404]);

  const robots = await fetchChecked(`${origin}/robots.txt`);
  if (!/Sitemap:/i.test(await robots.text())) throw new Error('robots.txt has no Sitemap directive');

  const config = await fetchChecked(`${origin}/js/lead-config.js`);
  if (!(await config.text()).includes(apiUrl)) {
    throw new Error('production lead-config.js does not contain the deployed function URL');
  }

  const preflight = await fetchChecked(
    apiUrl,
    {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    },
    [204],
  );
  const allowedOrigin = preflight.headers.get('access-control-allow-origin');
  if (allowedOrigin !== origin && allowedOrigin !== '*') {
    throw new Error(`smoke-production: lead API CORS allows ${allowedOrigin || 'nothing'} instead of ${origin}`);
  }

  const recommendedHeaders = [
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
  ];
  const missingHeaders = recommendedHeaders.filter(name => !home.headers.get(name));
  if (missingHeaders.length) {
    warn(`smoke-production: CDN security headers not configured: ${missingHeaders.join(', ')}`);
  }

  log('smoke-production: OK');
  return { origin, leadApiUrl: apiUrl };
}

if (require.main === module) {
  runSmoke().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { fetchWithRetry, normalizeSiteUrl, runSmoke };
