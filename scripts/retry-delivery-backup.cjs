'use strict';

// No CLI, long-lived credentials, Telegram payloads or customer data leave the function.
const COUNTERS = ['processed', 'sent', 'pending', 'failed', 'skipped', 'queue_pending', 'oldest_pending_age_seconds'];
const TIMER_EVENT = { messages: [{ event_metadata: { event_type: 'yandex.cloud.events.serverless.triggers.TimerMessage' }, details: { payload: 'retry-telegram' } }] };

async function requestJson(fetchImpl, url, options, timeoutMs, stage) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`${stage}_http_${response.status}`);
    const body = await response.text();
    if (body.length > 65536) throw new Error(`${stage}_response_too_large`);
    return JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error && new RegExp(`^${stage}_[a-z0-9_]+$`).test(error.message)
      ? error.message : `${stage}_unavailable`;
    throw new Error(message);
  }
}

function summarize(result) {
  if (result?.deferred === true) throw new Error('worker_deferred');
  if (!result || COUNTERS.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0)) {
    throw new Error('worker_invalid_result');
  }
  if (result.processed !== result.sent + result.pending + result.failed + result.skipped) {
    throw new Error('worker_invalid_counts');
  }
  return Object.fromEntries(COUNTERS.map(key => [key, result[key]]));
}

async function run(env = process.env, fetchImpl = fetch, log = console.log) {
  for (const name of ['YC_DEPLOY_SERVICE_ACCOUNT_ID', 'LEAD_FUNCTION_ID', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
    if (!env[name]) throw new Error('missing_configuration');
  }
  if (![env.YC_DEPLOY_SERVICE_ACCOUNT_ID, env.LEAD_FUNCTION_ID].every(value => /^[a-z0-9]{20}$/.test(value))) {
    throw new Error('invalid_resource_id');
  }
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (oidcUrl.protocol !== 'https:' || !/(^|\.)actions\.githubusercontent\.com$/.test(oidcUrl.hostname)) {
    throw new Error('invalid_oidc_endpoint');
  }
  oidcUrl.searchParams.set('audience', 'https://github.com/zvenfit');
  const oidc = await requestJson(fetchImpl, oidcUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  }, 15000, 'oidc');
  if (typeof oidc.value !== 'string' || !oidc.value) throw new Error('oidc_invalid_result');
  const credentials = await requestJson(fetchImpl, 'https://auth.yandex.cloud/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: env.YC_DEPLOY_SERVICE_ACCOUNT_ID,
      subject_token: oidc.value,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    }).toString(),
  }, 20000, 'iam');
  if (typeof credentials.access_token !== 'string' || !credentials.access_token) throw new Error('iam_invalid_result');
  // One invocation only. On a timeout its outcome is unknown; the next scheduled
  // run resumes the durable queue after its lease/backoff, without a blind POST retry.
  const result = await requestJson(fetchImpl, `https://functions.yandexcloud.net/${env.LEAD_FUNCTION_ID}?integration=raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${credentials.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(TIMER_EVENT),
  }, 130000, 'worker');
  const summary = summarize(result);
  log(JSON.stringify({ event: 'backup_delivery_completed', ...summary }));
  if (summary.failed > 0 || summary.pending > 0 || summary.oldest_pending_age_seconds > 900) {
    throw new Error('delivery_needs_attention');
  }
  return summary;
}

module.exports = { run, summarize };
if (require.main === module) {
  run().catch(error => {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'backup_failed';
    console.error(`::error::Telegram delivery backup: ${code}`);
    process.exitCode = 1;
  });
}
