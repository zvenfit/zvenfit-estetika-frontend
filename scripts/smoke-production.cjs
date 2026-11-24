'use strict';

const securityHeadersConfig = require('./cdn-security-headers.json');

const DEFAULT_SITE_URL = `https://${securityHeadersConfig.cname}`;
const PUBLIC_PAGES = [
  ['/', /<main[\s>]/i],
  ['/form/', /id=["']wf-form-tg-send["']/i],
  ['/privacy/', /<html/i],
  ['/personal-data-processing/', /<html/i],
  ['/404.html', /<html/i],
];
const NOT_FOUND_PATH = '/codex-production-smoke-not-found';
const HEADER_SAMPLES = 3;
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

async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The discarded response is already unusable; nothing to clean up.
  }
}

async function fetchWithRetry(
  url,
  options = {},
  expectedStatuses = [200],
  { fetchImpl = globalThis.fetch, waitImpl = wait, validate = null } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (expectedStatuses.includes(response.status)) {
        // Edge nodes pick up CDN option changes at different times, so a header
        // mismatch is retried like a bad status; only the last attempt's problems are kept.
        const problems = validate ? validate(response) : [];
        if (!problems.length) return response;
        lastError = new Error(`smoke-production: CDN security headers mismatch:\n  ${problems.join('\n  ')}`);
      } else {
        lastError = new Error(`${url} returned ${response.status}, expected ${expectedStatuses.join('/')}`);
      }
      await discardBody(response);
    } catch (error) {
      lastError = error;
    }
    if (attempt < ATTEMPTS) await waitImpl(RETRY_MS);
  }
  throw lastError;
}

function expectedSecurityHeaders(config = securityHeadersConfig) {
  return { ...config.headers };
}

// Compares response headers with the CDN contract; returns human-readable problems.
function securityHeaderProblems(pathname, response, expected = expectedSecurityHeaders()) {
  const problems = [];
  for (const [name, value] of Object.entries(expected)) {
    const headerName = name.toLowerCase();
    const actual = response.headers.get(headerName);
    if (!actual) {
      problems.push(`${pathname}: missing ${name}`);
      continue;
    }
    // HTTP field padding is space or tab. Other whitespace can change the CSP value.
    const matches = headerName === 'content-security-policy'
      ? actual.replace(/^[ \t]+|[ \t]+$/g, '') === value
      : actual.trim().toLowerCase() === value.toLowerCase();
    if (!matches) {
      problems.push(`${pathname}: ${name} is "${actual}", expected "${value}"`);
    }
  }
  return problems;
}

// HSTS is a rule, not an exact match, so a staged max-age ramp or a max-age=0 rollback
// only needs the config value changed. includeSubDomains/preload are never accepted.
function hstsProblems(pathname, response, config = securityHeadersConfig) {
  const hsts = config.hsts;
  if (!hsts || !hsts.enabled) return [];
  const actual = response.headers.get(hsts.header.toLowerCase());
  if (!actual) return [`${pathname}: missing ${hsts.header}`];

  const problems = [];
  const minimum = Number((/max-age=(\d+)/i.exec(hsts.value) || [])[1]);
  const seen = (/max-age=(\d+)/i.exec(actual) || [])[1];
  if (seen === undefined) problems.push(`${pathname}: ${hsts.header} "${actual}" has no max-age`);
  else if (Number(seen) < minimum) {
    problems.push(`${pathname}: ${hsts.header} max-age ${seen} is below ${minimum}`);
  }
  if (/includesubdomains|preload/i.test(actual)) {
    problems.push(`${pathname}: ${hsts.header} "${actual}" must not include includeSubDomains or preload`);
  }
  return problems;
}

function cdnHeaderProblems(pathname, response, expected) {
  return [
    ...securityHeaderProblems(pathname, response, expected),
    ...hstsProblems(pathname, response),
  ];
}

async function runHeaderChecks({
  siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL,
  fetchImpl = globalThis.fetch,
  waitImpl = wait,
  log = console.log,
} = {}) {
  const origin = normalizeSiteUrl(siteUrl);
  const routes = [...PUBLIC_PAGES.map(([path]) => [path, 200]), [NOT_FOUND_PATH, 404]];
  const expected = expectedSecurityHeaders();
  for (let sample = 1; sample <= HEADER_SAMPLES; sample += 1) {
    for (const [path, status] of routes) {
      const response = await fetchWithRetry(`${origin}${path}`, { method: 'HEAD', redirect: 'manual' }, [status], {
        fetchImpl, waitImpl,
      });
      // The daily monitor must report a bad edge even if the next response matches.
      const problems = cdnHeaderProblems(path, response, expected);
      if (problems.length) throw new Error(`CDN headers (sample ${sample}):\n  ${problems.join('\n  ')}`);
    }
  }
  log(`CDN headers OK: ${routes.length} routes, ${HEADER_SAMPLES} samples each at ${origin}`);
}

async function runSmoke({
  siteUrl = process.env.SITE_URL || DEFAULT_SITE_URL,
  leadApiUrl = process.env.LEAD_API_URL || '',
  fetchImpl = globalThis.fetch,
  waitImpl = wait,
  log = console.log,
  warn = console.warn,
  securityHeaders = expectedSecurityHeaders(),
} = {}) {
  const origin = normalizeSiteUrl(siteUrl);
  const apiUrl = String(leadApiUrl).trim();
  if (!apiUrl) throw new Error('smoke-production: LEAD_API_URL is required');

  const fetchChecked = (url, options, statuses, validate) =>
    fetchWithRetry(url, options, statuses, { fetchImpl, waitImpl, validate });
  const withSecurityHeaders = label => response => cdnHeaderProblems(label, response, securityHeaders);
  const assertPage = async (pathname, pattern) => {
    const response = await fetchChecked(`${origin}${pathname}`, {}, [200], withSecurityHeaders(pathname));
    const body = await response.text();
    if (!pattern.test(body)) throw new Error(`${pathname} does not contain the expected page marker`);
    return response;
  };
  const assertRedirect = async (pathname, targetPathname) => {
    const response = await fetchChecked(`${origin}${pathname}`, { redirect: 'manual' }, [301]);
    const location = response.headers.get('location');
    if (!location || new URL(location, origin).href !== `${origin}${targetPathname}`) {
      throw new Error(`${pathname} redirects to ${location || 'nothing'} instead of ${targetPathname}`);
    }
  };

  for (const [pathname, marker] of PUBLIC_PAGES) await assertPage(pathname, marker);
  await assertRedirect('/documents/privacy-policy.html', '/privacy/');
  await assertRedirect('/documents/personal-data-processing.html', '/personal-data-processing/');
  await fetchChecked(`${origin}${NOT_FOUND_PATH}`, {}, [404], withSecurityHeaders(`${NOT_FOUND_PATH} (404)`));

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

  if (!securityHeadersConfig.hsts.enabled) {
    warn('smoke-production: HSTS is not enabled yet (hsts.enabled=false in scripts/cdn-security-headers.json)');
  }

  log('smoke-production: OK');
  return { origin, leadApiUrl: apiUrl };
}

if (require.main === module) {
  const check = process.argv[2] === '--headers-only' ? runHeaderChecks : runSmoke;
  check().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  expectedSecurityHeaders,
  fetchWithRetry,
  hstsProblems,
  normalizeSiteUrl,
  runHeaderChecks,
  runSmoke,
  securityHeaderProblems,
};
