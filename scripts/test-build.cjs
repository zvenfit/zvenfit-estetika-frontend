'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

process.env.LEAD_API_URL ||= 'https://example.invalid/lead';
process.env.YANDEX_METRIKA_ID ||= '123456';
process.env.ASSET_VERSION ||= 'test';
process.env.SITE_URL ||= 'https://estetika.zvenfit.ru';

const rootDir = path.join(__dirname, '..');
const verifyBuild = "require('./scripts/build-static.cjs').runBuild(); require('./scripts/check-build.cjs'); require('./scripts/check-performance-budget.cjs');";

// Check that local and staging builds remove both GTM blocks. Leave the final
// production build in dist/ for artifact checks.
for (const mode of ['development', 'staging', 'production']) {
  execFileSync(process.execPath, ['-e', verifyBuild], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: mode },
    stdio: 'inherit',
  });
}
