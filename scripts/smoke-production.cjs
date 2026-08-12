'use strict';

const SITE_URL = String(process.env.SITE_URL || 'https://estetika.zvenfit.ru').replace(/\/$/, '');
const LEAD_API_URL = String(process.env.LEAD_API_URL || '').trim();
const ATTEMPTS = 6;
const RETRY_MS = 5000;

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, options = {}, expectedStatuses = [200]) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
      if (expectedStatuses.includes(response.status)) return response;
      lastError = new Error(`${url} returned ${response.status}, expected ${expectedStatuses.join('/')}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < ATTEMPTS) await wait(RETRY_MS);
  }
  throw lastError;
}

async function assertPage(pathname, pattern) {
  const response = await fetchWithRetry(`${SITE_URL}${pathname}`);
  const body = await response.text();
  if (!pattern.test(body)) throw new Error(`${pathname} does not contain the expected page marker`);

  return response;
}

async function main() {
  if (!LEAD_API_URL) throw new Error('smoke-production: LEAD_API_URL is required');

  const home = await assertPage('/', /<main[\s>]/i);
  await assertPage('/form/', /id=["']wf-form-tg-send["']/i);
  await assertPage('/documents/privacy-policy.html', /<html/i);
  await assertPage('/documents/personal-data-processing.html', /<html/i);
  await fetchWithRetry(`${SITE_URL}/codex-production-smoke-not-found`, {}, [404]);

  const robots = await fetchWithRetry(`${SITE_URL}/robots.txt`);
  if (!/Sitemap:/i.test(await robots.text())) throw new Error('robots.txt has no Sitemap directive');

  const config = await fetchWithRetry(`${SITE_URL}/js/lead-config.js`);
  if (!(await config.text()).includes(LEAD_API_URL)) {
    throw new Error('production lead-config.js does not contain the deployed function URL');
  }

  await fetchWithRetry(
    LEAD_API_URL,
    {
      method: 'OPTIONS',
      headers: { Origin: SITE_URL, 'Access-Control-Request-Method': 'POST' },
    },
    [204],
  );
  await fetchWithRetry(
    LEAD_API_URL,
    {
      method: 'POST',
      headers: { Origin: SITE_URL, 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission_id: 'invalid-smoke-id' }),
    },
    [400],
  );

  const recommendedHeaders = [
    'x-content-type-options',
    'x-frame-options',
    'referrer-policy',
    'permissions-policy',
  ];
  const missingHeaders = recommendedHeaders.filter(name => !home.headers.get(name));
  if (missingHeaders.length) {
    console.warn(`smoke-production: CDN security headers not configured: ${missingHeaders.join(', ')}`);
  }

  console.log('smoke-production: OK');
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { fetchWithRetry, main };
