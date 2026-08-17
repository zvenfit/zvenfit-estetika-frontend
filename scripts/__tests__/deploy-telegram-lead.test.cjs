'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '../..');
const deployScript = fs.readFileSync(path.join(ROOT, 'scripts/deploy-telegram-lead.sh'), 'utf8');
const verifyScript = fs.readFileSync(path.join(ROOT, 'scripts/verify-telegram-lead-ydb.sh'), 'utf8');
const packageScript = fs.readFileSync(path.join(ROOT, 'scripts/package-telegram-lead.sh'), 'utf8');
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/main.yml'), 'utf8');
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

test('production deploy jobs wait for quality checks', () => {
  const quality = workflow.indexOf('  quality-checks:');
  const preflight = workflow.indexOf('  deploy-preflight:');
  const verifyYdb = workflow.indexOf('  verify-ydb:');
  const functionDeploy = workflow.indexOf('  deploy-function:');
  const siteBuild = workflow.indexOf('  build-site:');
  const siteDeploy = workflow.indexOf('  deploy-site:');
  const smoke = workflow.indexOf('  smoke-production:');

  assert.equal(quality >= 0, true);
  assert.equal(preflight > quality, true);
  assert.equal(verifyYdb > preflight, true);
  assert.equal(functionDeploy > verifyYdb, true);
  assert.equal(siteBuild > functionDeploy, true);
  assert.equal(siteDeploy > siteBuild, true);
  assert.equal(smoke > siteDeploy, true);
  const functionJob = workflow.slice(functionDeploy, siteBuild);
  assert.match(functionJob, /needs: \[verify-ydb\]/);
  assert.match(functionJob, /environment: production/);
  const verifyJob = workflow.slice(verifyYdb, functionDeploy);
  assert.match(verifyJob, /needs: \[quality-checks, deploy-preflight\]/);
  assert.match(verifyJob, /timeout-minutes: 10/);
  assert.match(verifyJob, /environment: production-verify/);
  assert.match(workflow.slice(siteDeploy, smoke), /needs: \[deploy-function, build-site\]/);
});

test('pull requests run quality only and cannot enter a production environment', () => {
  const quality = workflow.slice(workflow.indexOf('  quality-checks:'), workflow.indexOf('  deploy-preflight:'));
  const preflight = workflow.slice(workflow.indexOf('  deploy-preflight:'), workflow.indexOf('  verify-ydb:'));

  assert.match(workflow, /pull_request:\s+branches:\s+- main/);
  assert.doesNotMatch(quality, /environment: production|id-token: write/);
  assert.match(preflight, /if: github\.event_name != 'pull_request'/);
});

test('deploy fails fast on missing configuration and smoke-checks production', () => {
  assert.match(workflow, /deploy-preflight:[\s\S]*node scripts\/check-deploy-config\.cjs/);
  assert.match(workflow, /Smoke production deployment[\s\S]*node scripts\/smoke-production\.cjs/);
});

test('separate YDB identity integration-tests and verifies schema before function deploy', () => {
  const integration = verifyScript.indexOf('run test:integration');
  const schemaVerification = verifyScript.indexOf('run verify:schema');

  assert.equal(integration >= 0, true);
  assert.equal(schemaVerification > integration, true);
  assert.doesNotMatch(verifyScript, /run migrate/);
  assert.match(verifyScript, /SCHEMA_VERIFY_MAX_ATTEMPTS=3/);
  assert.match(verifyScript, /schema verification failed after/);
  assert.doesNotMatch(deployScript, /test:integration|verify:schema|npm ci/);
  assert.match(workflow, /YC_DEPLOY_SERVICE_ACCOUNT_ID: \$\{\{ vars\.YC_YDB_VERIFY_SERVICE_ACCOUNT_ID \}\}/);
  assert.match(
    workflow,
    /deploy_service_account_id: \$\{\{ steps\.validate\.outputs\.deploy_service_account_id \}\}/,
  );
  assert.match(workflow, /printf 'deploy_service_account_id=%s\\n'.*YC_DEPLOY_SERVICE_ACCOUNT_ID.*GITHUB_OUTPUT/);
  assert.match(
    workflow,
    /YC_FORBIDDEN_SERVICE_ACCOUNT_ID: \$\{\{ needs\.deploy-preflight\.outputs\.deploy_service_account_id \}\}/,
  );
  assert.match(workflow, /YC_REQUIRE_FORBIDDEN_SERVICE_ACCOUNT_TEST: 'true'/);
  assert.match(
    workflow,
    /unset ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN\s+bash scripts\/verify-telegram-lead-ydb\.sh/,
  );
  assert.match(workflow, /YDB_CONNECTION_STRING: \$\{\{ needs\.verify-ydb\.outputs\.connection_string \}\}/);
});

test('deployment package contains compiled runtime modules only', () => {
  assert.match(packageScript, /\$\{FUNCTION_DIR\}\/build\/\./);
  assert.match(packageScript, /npm pkg delete devDependencies/);
  assert.match(deployScript, /FUNCTION_SOURCE_DIR/);
  assert.match(deployScript, /CI requires a prebuilt FUNCTION_SOURCE_DIR artifact/);
  assert.doesNotMatch(deployScript, /submission-store\.js/);
});

test('Telegram retry settings fit inside the Cloud Function timeout', () => {
  assert.match(deployScript, /TELEGRAM_RETRY_BATCH_SIZE="\$\{TELEGRAM_RETRY_BATCH_SIZE:-5\}"/);
  assert.match(deployScript, /TELEGRAM_TIMEOUT_MS="\$\{TELEGRAM_TIMEOUT_MS:-15000\}"/);
  assert.match(deployScript, /TIMEOUT="\$\{YC_LEAD_TIMEOUT:-120s\}"/);
  assert.match(deployScript, /--environment TELEGRAM_RETRY_BATCH_SIZE=/);
  assert.match(deployScript, /--environment TELEGRAM_TIMEOUT_MS=/);
  assert.match(workflow, /TELEGRAM_RETRY_BATCH_SIZE:.*'5'/);
  assert.match(workflow, /TELEGRAM_TIMEOUT_MS:.*'15000'/);
  assert.match(workflow, /YC_LEAD_TIMEOUT:.*'120s'/);
});

test('production runtime defaults match the proven upstream settings', () => {
  assert.match(deployScript, /YDB_QUERY_TIMEOUT_MS="\$\{YDB_QUERY_TIMEOUT_MS:-10000\}"/);
  for (const [name, fallback] of [
    ['YDB_LEADS_TABLE', 'leads'],
    ['YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE', 'newsletter_subscriptions'],
    ['YDB_NEWSLETTER_CONSENT_EVENTS_TABLE', 'newsletter_consent_events'],
    ['YDB_TELEGRAM_OUTBOX_TABLE', 'telegram_outbox'],
    ['YDB_RATE_LIMITS_TABLE', 'form_rate_limits'],
  ]) {
    assert.match(deployScript, new RegExp(`${name}="\\$\\{${name}:-${fallback}\\}"`));
    assert.match(deployScript, new RegExp(`--environment ${name}=`));
    assert.match(verifyScript, new RegExp(`${name}="\\$\\{${name}:-${fallback}\\}"`));
    assert.match(workflow, new RegExp(`${name}:.*'${fallback}'`));
  }
  assert.match(deployScript, /YDB_SLOW_OPERATION_MS="\$\{YDB_SLOW_OPERATION_MS:-3000\}"/);
  assert.match(workflow, /YDB_QUERY_TIMEOUT_MS:.*'10000'/);
  assert.match(workflow, /YDB_SLOW_OPERATION_MS:.*'3000'/);
  assert.match(workflow, /ALLOWED_ORIGINS: 'https:\/\/estetika\.zvenfit\.ru'/);
  assert.doesNotMatch(workflow, /www\.estetika\.zvenfit\.ru/);
});

test('CI deploy requires pre-provisioned infrastructure and does not grant access', () => {
  assert.doesNotMatch(deployScript, /yc ydb database create/);
  assert.doesNotMatch(deployScript, /yc serverless function create/);
  assert.doesNotMatch(deployScript, /\nyc serverless function allow-unauthenticated-invoke/);
  assert.match(deployScript, /function list-access-bindings/);
  assert.match(deployScript, /missing the one-time public functionInvoker binding/);
  assert.match(deployScript, /YDB_DATABASE_SELECTOR=\(--id=/);
  assert.match(workflow, /YDB_DATABASE_ID: \$\{\{ vars\.YDB_DATABASE_ID \}\}/);
});

test('CI deploy leaves the one-time retry trigger untouched', () => {
  assert.doesNotMatch(deployScript, /yc serverless trigger create/);
  assert.doesNotMatch(deployScript, /yc serverless trigger update/);
  assert.doesNotMatch(deployScript, /yc serverless trigger delete/);
  assert.match(deployScript, /LEAD_RETRY_TRIGGER=/);
});

test('deploy jobs use OIDC, scoped identities and bucket-scoped ephemeral credentials', () => {
  const workloadIdentityAuth = fs.readFileSync(
    path.join(ROOT, 'scripts/auth-yc-wif.sh'),
    'utf8',
  );
  const ephemeralStorageKey = fs.readFileSync(
    path.join(ROOT, 'scripts/issue-ephemeral-storage-key.sh'),
    'utf8',
  );
  const ephemeralBoundary = fs.readFileSync(
    path.join(ROOT, 'scripts/assert-ephemeral-key-boundary.sh'),
    'utf8',
  );
  const storageBoundary = fs.readFileSync(
    path.join(ROOT, 'scripts/assert-storage-boundary.sh'),
    'utf8',
  );
  const ycInstaller = fs.readFileSync(path.join(ROOT, 'scripts/install-yc-cli.sh'), 'utf8');

  assert.equal((workflow.match(/^      id-token: write$/gm) || []).length, 3);
  assert.doesNotMatch(workflow, /^  id-token: write$/m);
  assert.match(workflow, /bash scripts\/auth-yc-wif\.sh/);
  assert.match(workflow, /bash scripts\/issue-ephemeral-storage-key\.sh/);
  assert.match(workflow, /OBJECT_STORAGE_BUCKET: \$\{\{ env\.S3_BUCKET \}\}/);
  assert.match(workflow, /YC_STORAGE_SERVICE_ACCOUNT_ID: \$\{\{ vars\.YC_STORAGE_SERVICE_ACCOUNT_ID \}\}/);
  assert.match(workflow, /YC_FORBIDDEN_EPHEMERAL_SUBJECT_ID: \$\{\{ vars\.YC_LEAD_SERVICE_ACCOUNT_ID \}\}/);
  assert.doesNotMatch(workflow, /YC_SA_JSON_KEY|YC_ACCESS_KEY_ID|YC_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(workflow, /docker:\/\//);

  assert.match(workloadIdentityAuth, /requested_token_type=urn:ietf:params:oauth:token-type:access_token/);
  assert.match(workloadIdentityAuth, /YC_IAM_TOKEN/);
  assert.match(workloadIdentityAuth, /YC_FORBIDDEN_SERVICE_ACCOUNT_ID/);
  assert.match(workloadIdentityAuth, /YC_REQUIRE_FORBIDDEN_SERVICE_ACCOUNT_TEST/);
  assert.match(workloadIdentityAuth, /forbidden cross-service-account exchange rejected/);
  assert.match(workloadIdentityAuth, /FAILED; OIDC subject can target the forbidden service account/);
  assert.match(workloadIdentityAuth, /FORBIDDEN_HTTP_STATUS.*'401'/s);
  assert.match(workloadIdentityAuth, /Object\.hasOwn\(response, "access_token"\)/);
  assert.match(workloadIdentityAuth, /response\.error !== "invalid_client"/);
  assert.match(workloadIdentityAuth, /unexpected forbidden exchange response/);
  assert.doesNotMatch(workloadIdentityAuth, /config set service-account-key/);

  assert.match(ephemeralStorageKey, /duration: "3600s"/);
  assert.match(ephemeralStorageKey, /arn:aws:s3:::\$\{bucket\}\/\*/);
  assert.match(ephemeralStorageKey, /\["accessKeyId", "secret", "sessionToken"\]/);
  assert.match(ephemeralStorageKey, /AWS_SESSION_TOKEN/);
  assert.match(ephemeralStorageKey, /subjectId: process\.argv\[3\]/);
  assert.match(ephemeralStorageKey, /YC_STORAGE_SERVICE_ACCOUNT_ID/);
  assert.doesNotMatch(ephemeralStorageKey, /YC_DEPLOY_SERVICE_ACCOUNT_ID/);
  assert.match(ephemeralBoundary, /HTTP_STATUS.*== "403"/s);
  assert.match(ephemeralBoundary, /YC_FORBIDDEN_EPHEMERAL_SUBJECT_ID/);
  assert.match(storageBoundary, /FORBIDDEN_STORAGE_BUCKETS/);
  assert.match(storageBoundary, /list-objects-v2/);

  assert.match(ycInstaller, /YC_CLI_VERSION='1\.26\.0'/);
  assert.match(ycInstaller, /sha256sum --check --status/);
  assert.doesNotMatch(workflow, /install\.sh \| bash/);
});

test('untrusted dependency installation and site builds run outside OIDC jobs', () => {
  const verifyJob = workflow.slice(workflow.indexOf('  verify-ydb:'), workflow.indexOf('  deploy-function:'));
  const functionJob = workflow.slice(workflow.indexOf('  deploy-function:'), workflow.indexOf('  build-site:'));
  const siteBuildJob = workflow.slice(workflow.indexOf('  build-site:'), workflow.indexOf('  deploy-site:'));
  const siteDeployJob = workflow.slice(workflow.indexOf('  deploy-site:'), workflow.indexOf('  smoke-production:'));

  assert.match(verifyJob, /id-token: write/);
  assert.doesNotMatch(verifyJob, /npm ci/);
  assert.match(functionJob, /id-token: write/);
  assert.doesNotMatch(functionJob, /npm ci|npm run build|Set up Node\.js/);
  assert.doesNotMatch(siteBuildJob, /id-token: write/);
  assert.match(siteBuildJob, /npm ci/);
  assert.match(siteBuildJob, /npm run build/);
  assert.match(siteDeployJob, /id-token: write/);
  assert.doesNotMatch(siteDeployJob, /npm ci|npm run build|Set up Node\.js/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
});

test('production resource map cannot fall through to the main project buckets or services', () => {
  assert.match(workflow, /S3_BUCKET: 'zvenfit-estetika-frontend'/);
  assert.match(workflow, /FUNCTION_NAME: 'zvenfit-estetika-telegram-lead'/);
  assert.match(workflow, /YDB_DATABASE_NAME:.*'zvenfit-estetika-leads'/);
  assert.match(workflow, /OBJECT_STORAGE_BUCKET: \$\{\{ env\.S3_BUCKET \}\}/);
  assert.doesNotMatch(workflow, /s3:\/\/zvenfit-frontend(?:\s|$)/);
  assert.doesNotMatch(workflow, /zvenfit-telegram-lead(?:\s|$)/);
  assert.doesNotMatch(workflow, /zvenfit-leads(?:\s|$)/);
});

test('direct gauges carry the same Estetika taxonomy in runtime and selectors', () => {
  for (const [name, value] of [
    ['MONIUM_APPLICATION', 'zvenfit-estetika-frontend'],
    ['MONIUM_ENVIRONMENT', 'production'],
    ['MONIUM_COMPONENT', 'zvenfit-estetika-telegram-lead'],
    ['MONIUM_RESOURCE_ID', 'zvenfit-estetika-telegram-lead'],
  ]) {
    assert.match(workflow, new RegExp(`${name}: ${value}`));
    assert.match(deployScript, new RegExp(`--environment ${name}=`));
  }

  assert.match(workflow, /MONIUM_METRICS_TIMEOUT_MS:.*'3000'/);
  assert.match(deployScript, /MONIUM_METRICS_TIMEOUT_MS="\$\{MONIUM_METRICS_TIMEOUT_MS:-3000\}"/);
  assert.match(envExample, /^MONIUM_METRICS_TIMEOUT_MS=3000$/m);
});
