'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

function read(rel) {
  const file = path.join(distDir, rel);
  if (!fs.existsSync(file)) {
    throw new Error(`check-build: missing ${rel}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(path.relative(distDir, full));
  }
  return files;
}

if (!fs.existsSync(distDir)) throw new Error('check-build: dist/ is missing');

for (const rel of [
  'index.html',
  'form/index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  'documents/privacy-policy.html',
  'documents/personal-data-processing.html',
  'css/zvenfit-kosmetologiya.webflow.min.css',
]) read(rel);

const files = walk(distDir);
for (const forbidden of [
  /^images\//,
  /^fonts\//,
  /\.DS_Store$/,
  /^css\/(normalize|webflow)\.css$/,
  /^css\/zvenfit-kosmetologiya\.webflow\.css$/,
  /^js\/webflow\.js$/,
]) {
  const found = files.filter(file => forbidden.test(file));
  if (found.length) throw new Error(`check-build: forbidden files: ${found.join(', ')}`);
}

const css = read('css/zvenfit-kosmetologiya.webflow.min.css');
if (css.includes('../images/') || css.includes('../fonts/')) {
  throw new Error('check-build: CSS contains local image/font URLs');
}

for (const rel of ['index.html', 'form/index.html']) {
  const html = read(rel);
  if (html.includes('__LEAD_API_URL__') || html.includes('__ASSET_VERSION__')) {
    throw new Error(`check-build: unresolved placeholders in ${rel}`);
  }
}

const legal = read('documents/privacy-policy.html');
if (legal.includes('ZvenFit Estetika: analytics') || legal.includes('application/ld+json')) {
  throw new Error('check-build: legal document received landing-page injections');
}

const notFound = read('404.html');
if (!/<meta\s+name=["']robots["'][^>]*noindex/i.test(notFound)) {
  throw new Error('check-build: 404 must be noindex');
}
if (notFound.includes('ZvenFit Estetika: analytics') || notFound.includes('application/ld+json')) {
  throw new Error('check-build: 404 received analytics or structured data');
}

console.log(`check-build: OK (${files.length} dist files)`);
