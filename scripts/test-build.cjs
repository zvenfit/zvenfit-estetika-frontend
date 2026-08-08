'use strict';

process.env.LEAD_API_URL ||= 'https://example.invalid/lead';
process.env.YANDEX_METRIKA_ID ||= 'test-counter';
process.env.ASSET_VERSION ||= 'test';
process.env.SITE_URL ||= 'https://estetika.zvenfit.ru';

require('./build-static.cjs').runBuild();
require('./check-build.cjs');
require('./check-performance-budget.cjs');
