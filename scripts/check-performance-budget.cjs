'use strict';

const fs = require('fs');
const path = require('path');
const budget = require('./performance-budget.json');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const failures = [];

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(file, files);
    } else {
      files.push(file);
    }
  }
  return files;
}

function read(relativePath) {
  const file = path.join(distDir, relativePath);
  if (!fs.existsSync(file)) {
    throw new Error(`performance-budget: missing ${relativePath}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function bytes(relativePath) {
  return fs.statSync(path.join(distDir, relativePath)).size;
}

function within(label, actual, maximum) {
  if (actual > maximum) {
    failures.push(`${label}: ${actual} B > ${maximum} B`);
  }
}

if (!fs.existsSync(distDir)) {
  throw new Error('performance-budget: dist/ is missing; run npm run build first');
}

const files = walk(distDir);
const indexHtml = read('index.html');
const formHtml = read('form/index.html');
const css = read('css/zvenfit-kosmetologiya.webflow.min.css');
const distBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const jsBytes = files
  .filter(file => file.endsWith('.js'))
  .reduce((sum, file) => sum + fs.statSync(file).size, 0);

within('dist total', distBytes, budget.distBytes);
within('index.html', bytes('index.html'), budget.indexHtmlBytes);
within('form/index.html', bytes('form/index.html'), budget.formHtmlBytes);
within('site CSS', bytes('css/zvenfit-kosmetologiya.webflow.min.css'), budget.siteCssBytes);
within('local JavaScript', jsBytes, budget.localJavaScriptBytes);

const fontFaces = (css.match(/@font-face/g) || []).length;
if (fontFaces > budget.fontFaces) {
  failures.push(`font faces: ${fontFaces} > ${budget.fontFaces}`);
}
const fontSources = css.match(/@font-face\{[^}]+\}/g) || [];
if (fontSources.some(face => !face.includes(`.${budget.fontFormat}`))) {
  failures.push(`every font face must use ${budget.fontFormat}`);
}
if (/\.ttf(?:[)'"?])/i.test(css)) {
  failures.push('TTF font source remains in CSS');
}

const serviceImages = indexHtml.match(/<img\b[^>]*\bclass=["'][^"']*\bservices-photo\b[^"']*["'][^>]*>/gi) || [];
const initialServiceImages = serviceImages.filter(image => /\ssrc=["']/i.test(image));
const deferredServiceImages = serviceImages.filter(image => /\bdata-src=["']/i.test(image));
if (serviceImages.length !== budget.serviceImages) {
  failures.push(`service images: ${serviceImages.length} != ${budget.serviceImages}`);
}
if (initialServiceImages.length > budget.initialServiceImages) {
  failures.push(`initial service images: ${initialServiceImages.length} > ${budget.initialServiceImages}`);
}
if (initialServiceImages.length + deferredServiceImages.length !== serviceImages.length) {
  failures.push('service images must have exactly one of src or data-src');
}
if (!indexHtml.includes('/js/lazy-tab-images.js')) {
  failures.push('lazy tab image loader is missing from index.html');
}

const lazyContentImages = indexHtml.match(/<img\b[^>]*\bclass=["'][^"']*(?:services-photo|image-2|photo-eqiup|image-3)[^"']*["'][^>]*>/gi) || [];
if (lazyContentImages.some(image => !/\bloading=["']lazy["']/i.test(image))) {
  failures.push('a below-the-fold content image is missing loading="lazy"');
}

for (const contentBackground of [
  '/images/hero/home-photo.webp',
  '/images/hero/form-photo.webp',
  '/images/services/',
  '/images/about/team-photo.webp',
  '/images/apparatus/',
  '/images/cross-promo/',
]) {
  if (css.includes(contentBackground)) {
    failures.push(`content image remains in CSS: ${contentBackground}`);
  }
}

for (const [relativePath, html] of [
  ['index.html', indexHtml],
  ['form/index.html', formHtml],
  ['404.html', read('404.html')],
]) {
  const preconnect = html.indexOf('<link rel="preconnect" href="https://storage.yandexcloud.net" crossorigin>');
  const firstCdnStylesheetTag = (html.match(/<link\b[^>]*>/gi) || []).find(tag => (
    /\brel=["']stylesheet["']/i.test(tag)
      && /\bhref=["']https:\/\/storage\.yandexcloud\.net\//i.test(tag)
  ));
  const firstCdnStylesheet = firstCdnStylesheetTag ? html.indexOf(firstCdnStylesheetTag) : -1;
  if (preconnect === -1 || firstCdnStylesheet === -1 || preconnect > firstCdnStylesheet) {
    failures.push(`${relativePath}: CDN preconnect must precede the first CDN link`);
  }
}

if (failures.length) {
  throw new Error(`performance-budget failed:\n- ${failures.join('\n- ')}`);
}

// eslint-disable-next-line no-console
console.log(
  `performance-budget: OK (dist ${distBytes}/${budget.distBytes} B, CSS ${bytes('css/zvenfit-kosmetologiya.webflow.min.css')}/${budget.siteCssBytes} B, JS ${jsBytes}/${budget.localJavaScriptBytes} B, ${initialServiceImages.length} initial service images)`,
);
