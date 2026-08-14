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
  'css/legal-documents.min.css',
]) read(rel);

const files = walk(distDir);
const publicEmail = 'zvenfit.estetika@yandex.ru';
for (const rel of files.filter(file => file.endsWith('.html'))) {
  const emailAddresses = read(rel).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const unexpectedEmails = emailAddresses.filter(email => email.toLowerCase() !== publicEmail);
  if (unexpectedEmails.length) {
    throw new Error(
      `check-build: unexpected public email in ${rel}: ${[...new Set(unexpectedEmails)].join(', ')}`,
    );
  }
}

for (const forbidden of [
  /^images\//,
  /^fonts\//,
  /\.DS_Store$/,
  /^css\/(normalize|webflow)\.css$/,
  /^css\/zvenfit-kosmetologiya\.webflow\.css$/,
  /^js\/webflow\.js$/,
  /^js\/(?:gsap-[^/]+|ScrollTrigger-[^/]+)\.js$/,
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

  if (html.includes('unpkg.com/imask')) {
    throw new Error(`check-build: ${rel} loads IMask from unpkg`);
  }

  if (/<form[^>]*method=["']get["']/i.test(html)) {
    throw new Error(`check-build: ${rel} contains a GET form that could expose personal data in URL`);
  }
  if (!html.includes('<noscript>') || !html.includes('tel:+79688440088')) {
    throw new Error(`check-build: ${rel} has no safe no-JS fallback`);
  }
  if (
    !html.includes('data-consent-version="2026-08-14"') ||
    !/<input[^>]*name=["']personal_data_consent["'][^>]*type=["']checkbox["'][^>]*required/i.test(html)
  ) {
    throw new Error(`check-build: ${rel} has no required versioned personal-data consent`);
  }
  if (/<input[^>]*name=["'](?:personal_data_consent|marketing_consent)["'][^>]*checked/i.test(html)) {
    throw new Error(`check-build: ${rel} preselects a consent checkbox`);
  }

  if (
    !html.includes(
      'https://storage.yandexcloud.net/zvenfit-estetika/js/imask-7.6.1.min.js?v=',
    ) ||
    !html.includes('integrity="sha384-UO8YwPv//GjwHj93ZlwXcDNjv3BSxdBFUB2jtiOuL3d/a0kS9E8sYvHjTBkQI8u8"')
  ) {
    throw new Error(`check-build: ${rel} does not load the pinned IMask CDN asset with SRI`);
  }
}

for (const rel of ['index.html', 'form/index.html', '404.html']) {
  const html = read(rel);
  if (!html.includes('<main')) {
    throw new Error(`check-build: missing main landmark in ${rel}`);
  }

  const phoneInputs = html.match(/<input[^>]*type=["']tel["'][^>]*>/gi) || [];
  if (phoneInputs.some(input => !/autocomplete=["']tel["']/i.test(input))) {
    throw new Error(`check-build: tel input without autocomplete=tel in ${rel}`);
  }

  if (/<img[^>]*\/logo-(?:full|mark)\.svg[^>]*alt=["']["'][^>]*>/i.test(html)) {
    throw new Error(`check-build: linked logo has an empty alt in ${rel}`);
  }
}

for (const rel of ['index.html', 'form/index.html']) {
  if (!read(rel).includes('<footer')) {
    throw new Error(`check-build: missing footer landmark in ${rel}`);
  }
}

const formPage = read('form/index.html');
for (const attribute of [
  'aria-labelledby="contact-method-label"',
  'aria-describedby="contact-method-error"',
  'aria-required="true"',
  'aria-invalid="false"',
]) {
  if (!formPage.includes(attribute)) {
    throw new Error(`check-build: contact method combobox is missing ${attribute}`);
  }
}
if (!formPage.includes('id="contact-method-error"')) {
  throw new Error('check-build: contact method field error is missing');
}
if (!formPage.includes('Выберите способ связи')) {
  throw new Error('check-build: concise contact method prompt is missing');
}

const homePage = read('index.html');
if (!homePage.includes('<label class="visually-hidden" for="phone">Номер телефона</label>')) {
  throw new Error('check-build: newsletter phone input has no accessible label');
}
if (/gsap|ScrollTrigger/i.test(homePage)) {
  throw new Error('check-build: home page still loads the removed motion libraries');
}
if (!/<input[^>]*name=["']marketing_consent["'][^>]*type=["']checkbox["'][^>]*required/i.test(homePage)) {
  throw new Error('check-build: newsletter has no separate required marketing consent');
}
for (const motionHook of [
  '61539419-ce88-ac6e-2be5-a18971d536e7',
  '61539419-ce88-ac6e-2be5-a18971d536e2',
]) {
  if (homePage.includes(motionHook)) {
    throw new Error(`check-build: legacy card motion hook remains: ${motionHook}`);
  }
}
if (!homePage.includes('w-layout-blockcontainer home-hero w-container')) {
  throw new Error('check-build: static home hero class is missing');
}
if (!homePage.includes('w-layout-blockcontainer studio-about w-container')) {
  throw new Error('check-build: static about class is missing');
}
if (!homePage.includes('/js/ui-polish.js?v=')) {
  throw new Error('check-build: UI polish script is missing or has no cache version');
}
if (!homePage.includes('class="mobile-booking-cta"')) {
  throw new Error('check-build: mobile booking CTA is missing');
}

const legal = read('documents/privacy-policy.html');
if (legal.includes('ZvenFit Estetika: analytics') || legal.includes('application/ld+json')) {
  throw new Error('check-build: legal document received landing-page injections');
}
if (
  !legal.includes('/css/zvenfit-kosmetologiya.webflow.min.css?v=') ||
  !legal.includes('/css/legal-documents.min.css?v=')
) {
  throw new Error('check-build: legal document CSS is missing or has no cache version');
}
if (!legal.includes('<span>ЗВЕНФИТ ЭСТЕТИКА</span>')) {
  throw new Error('check-build: legal footer has an incorrect brand name');
}
if (/<meta name="(?:Author|LastAuthor|Generator)"|<style type="text\/css">/i.test(legal)) {
  throw new Error('check-build: office metadata or inline export styles remain in legal output');
}

const notFound = read('404.html');
if (!/<meta\s+name=["']robots["'][^>]*noindex/i.test(notFound)) {
  throw new Error('check-build: 404 must be noindex');
}
if (notFound.includes('ZvenFit Estetika: analytics') || notFound.includes('application/ld+json')) {
  throw new Error('check-build: 404 received analytics or structured data');
}

console.log(`check-build: OK (${files.length} dist files)`);
