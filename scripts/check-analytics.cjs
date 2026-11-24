'use strict';
const fs = require('node:fs');
const path = require('node:path');
function checkAnalytics(distDir, excludedPages) {
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!file.endsWith('.html')) continue;
      const route = path.relative(distDir, file).replaceAll(path.sep, '/');
      const html = fs.readFileSync(file, 'utf8');
      const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]*\/analytics\.js(?:\?[^"]*)?)"[^>]*>/g)];
      const expected = excludedPages.includes(route) ? 0 : 1;
      const counterId = process.env.YANDEX_METRIKA_ID;
      if (expected && counterId) {
        const init = html.match(/\bym\(\s*(\d+)\s*,\s*['"]init['"]\s*,\s*\{([^}]*)\}/);
        if (!init || init[1] !== counterId || !/(?:^|,)\s*webvisor\s*:\s*true\s*(?:,|$)/.test(init[2])) {
          throw new Error('scroll map requires Webvisor on the configured counter: ' + route);
        }
        for (const [form] of html.matchAll(/<form\b[^>]*>/gi)) {
          if (!/\sdata-consent-version\s*=/i.test(form)) continue;
          const classes = form.match(/\sclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) || [];
          if (!classes.includes('ym-hide-content')) {
            throw new Error('unmasked Webvisor form collecting personal data: ' + route);
          }
        }
      }
      if (scripts.length !== expected) throw new Error('analytics loader count: ' + route);
      if (expected && (!/\?v=[^"\s]+/.test(scripts[0][1]) || !/\bdefer\b/.test(scripts[0][0]))) {
        throw new Error('analytics loader must be versioned and deferred: ' + route);
      }
      if (expected && scripts[0].index > html.indexOf('</head>'))
        throw new Error('analytics must load before form scripts: ' + route);
    }
  }
  walk(distDir);
  if (!fs.existsSync(path.join(distDir, 'js/analytics.js'))) throw new Error('analytics runtime missing');
}
module.exports = { checkAnalytics };
