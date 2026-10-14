const assert = require('node:assert/strict');
const test = require('node:test');
const { run, summarize } = require('../retry-delivery-backup.cjs');
const clean = { processed: 1, sent: 1, pending: 0, failed: 0, skipped: 0, queue_pending: 0, oldest_pending_age_seconds: 0 };
const env = { YC_DEPLOY_SERVICE_ACCOUNT_ID: 'a'.repeat(20), LEAD_FUNCTION_ID: 'b'.repeat(20), ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.actions.githubusercontent.com/token?api-version=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-github-token' };
function fixture(worker = clean) {
  const calls = [], logs = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 3 && worker instanceof Error) throw worker;
    const body = calls.length === 1 ? { value: 'synthetic-oidc' } : calls.length === 2 ? { access_token: 'synthetic-iam' } : worker;
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  return { calls, logs, fetchImpl };
}
test('OIDC authenticates one raw invocation and emits counters without secrets or payloads', async () => {
  const f = fixture({ ...clean, private_payload: 'do-not-log' });
  assert.deepEqual(await run(env, f.fetchImpl, line => f.logs.push(line)), clean);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].url, 'https://auth.yandex.cloud/oauth/token');
  assert.equal(f.calls[2].options.headers.Authorization, 'Bearer synthetic-iam');
  assert.match(f.calls[2].url, /\?integration=raw$/);
  assert.equal(JSON.parse(f.calls[2].options.body).messages[0].details.payload, 'retry-telegram');
  assert.doesNotMatch(f.logs.join(''), /synthetic|do-not-log|phone/);
  assert.equal(f.calls.every(c => c.options.redirect === 'error' && c.options.signal instanceof AbortSignal), true);
});
test('unknown invocation outcomes are not retried or printed', async () => {
  const f = fixture(new Error('synthetic-iam upstream detail'));
  await assert.rejects(run(env, f.fetchImpl), { message: 'worker_unavailable' });
  assert.equal(f.calls.length, 3);
});
test('deferred, invalid, terminal, transient and stale queues are actionable failures', async () => {
  assert.throws(() => summarize({ deferred: true }), /worker_deferred/);
  assert.throws(() => summarize({}), /worker_invalid_result/);
  assert.throws(() => summarize({ ...clean, processed: 2 }), /worker_invalid_counts/);
  for (const result of [
    { ...clean, sent: 0, pending: 1 },
    { ...clean, sent: 0, failed: 1 },
    { ...clean, queue_pending: 1, oldest_pending_age_seconds: 901 },
  ]) {
    const f = fixture(result);
    await assert.rejects(run(env, f.fetchImpl, () => {}), /delivery_needs_attention/);
  }
});
test('configuration fails closed before transmitting credentials', async () => {
  const f = fixture();
  await assert.rejects(run({ ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://untrusted.example/token' }, f.fetchImpl), /invalid_oidc_endpoint/);
  await assert.rejects(run({ ...env, LEAD_FUNCTION_ID: '' }, f.fetchImpl), /missing_configuration/);
  assert.equal(f.calls.length, 0);
});
