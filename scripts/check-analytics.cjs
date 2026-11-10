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
