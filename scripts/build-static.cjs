'use strict';

const fs = require('fs');
const path = require('path');
const CleanCSS = require('clean-css');

const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const distDir = path.join(rootDir, 'dist');
const structuredDataConfigPath = path.join(__dirname, 'structured-data.config.json');
const analyticsMarker = '<!-- ZvenFit Estetika: analytics -->';
const analyticsSnippetPath = path.join(__dirname, 'snippets', 'analytics-head.html');
const utmMarker = '<!-- ZvenFit Estetika: UTM attribution -->';
const utmSnippetPath = path.join(__dirname, 'snippets', 'utm-head.html');
const openGraphMarker = '<!-- ZvenFit Estetika: open-graph -->';
const structuredDataMarker = '<!-- ZvenFit Estetika: structured-data -->';
const SITE_CSS_SOURCE = 'zvenfit-kosmetologiya.webflow.css';
const SITE_CSS_MIN = 'zvenfit-kosmetologiya.webflow.min.css';
const CDN_VENDOR_JS = [
  'jquery-3.5.1.min.js',
  'imask-7.6.1.min.js',
  'webflow.js',
];
const CACHE_BUST_SCRIPTS = [
  'utm-attribution.js',
  'lead-config.js',
  'submission-id.js',
  'form-client.js',
  'lead-form.js',
  'newsletter-form.js',
  'phone-mask.js',
  'lazy-tab-images.js',
  'name-input.js',
  'custom-select.js',
  'back-button.js',
  'social-links.js',
  'ui-polish.js',
];

function loadEnvFile(filename) {
  const filepath = path.join(rootDir, filename);
  if (!fs.existsSync(filepath)) {
    return;
  }

  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getAssetsCdnBase(config) {
  return (config.assetsCdnBase || '').replace(/\/$/, '');
}

function walkHtmlFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHtmlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }
  return files;
}

function getPagePath(htmlPath, baseDir) {
  const rel = path.relative(baseDir, htmlPath);
  if (rel === 'index.html') {
    return '/';
  }

  return `/${rel.replace(/index\.html$/, '').replace(/\\/g, '/')}`;
}

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function resolveSiteUrl(pathOrUrl, siteUrl) {
  if (!pathOrUrl) {
    return undefined;
  }
  if (pathOrUrl.startsWith('http')) {
    return pathOrUrl;
  }
  return `${siteUrl.replace(/\/$/, '')}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
}

function normalizeRootRelativePaths(html) {
  return html
    .replace(/href=["']form\.html["']/g, 'href="/form/"')
    .replace(/href=["']index\.html["']/g, 'href="/"');
}

function stripWebflowGenerator(html) {
  return html.replace(/\s*<meta content="Webflow" name="generator">\n?/g, '\n');
}

function minifySiteCss() {
  const sourcePath = path.join(publicDir, 'css', SITE_CSS_SOURCE);
  const distMinPath = path.join(distDir, 'css', SITE_CSS_MIN);
  const distSourcePath = path.join(distDir, 'css', SITE_CSS_SOURCE);

  if (!fs.existsSync(sourcePath)) {
    console.warn(`build-static: missing public/css/${SITE_CSS_SOURCE}`);
    return;
  }

  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = new CleanCSS({ level: 2 }).minify(source);

  if (result.errors.length > 0) {
    throw new Error(`CSS minify failed: ${result.errors.join(', ')}`);
  }

  fs.mkdirSync(path.dirname(distMinPath), { recursive: true });
  fs.writeFileSync(distMinPath, result.styles, 'utf8');

  if (fs.existsSync(distSourcePath)) {
    fs.unlinkSync(distSourcePath);
  }

  console.log(
    `build-static: css/${SITE_CSS_SOURCE} -> css/${SITE_CSS_MIN} (${source.length} -> ${result.styles.length} bytes)`,
  );
}

function bustAssetUrls(html, assetVersion, assetsCdnBase) {
  let nextHtml = html;

  for (const scriptName of CACHE_BUST_SCRIPTS) {
    const pattern = new RegExp(`(/js/${scriptName})(?:\\?v=[^"']*)?`, 'g');
    nextHtml = nextHtml.replace(pattern, `$1?v=${assetVersion}`);
  }

  const cssMinLocal = `/css/${SITE_CSS_MIN}`;
  const cssMinLocalEscaped = cssMinLocal.replace(/\//g, '\\/');
  nextHtml = nextHtml.replace(
    new RegExp(`(${cssMinLocalEscaped}|/css/${SITE_CSS_SOURCE.replace('.', '\\.')})(?:\\?v=[^"']*)?`, 'g'),
    `${cssMinLocal}?v=${assetVersion}`,
  );

  for (const scriptName of CDN_VENDOR_JS) {
    const cdnBase = `${assetsCdnBase}/js/${scriptName}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    nextHtml = nextHtml.replace(
      new RegExp(`(${cdnBase})(?:\\?v=[^"']*)?`, 'g'),
      `$1?v=${assetVersion}`,
    );
  }

  return nextHtml;
}

function pruneDistStaticAssets() {
  for (const folder of ['images', 'fonts']) {
    const folderPath = path.join(distDir, folder);
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  }

  const cssDir = path.join(distDir, 'css');
  for (const fileName of ['normalize.css', 'webflow.css', SITE_CSS_SOURCE]) {
    const filePath = path.join(cssDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  for (const scriptName of CDN_VENDOR_JS) {
    const scriptPath = path.join(distDir, 'js', scriptName);
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  }

  for (const filePath of walkFiles(distDir)) {
    if (path.basename(filePath) === '.DS_Store') {
      fs.unlinkSync(filePath);
    }
  }
}

function walkFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, files);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function injectHeadSnippets(html, assetVersion, metrikaId) {
  if (!html.includes('</head>')) {
    return html;
  }

  let nextHtml = html;

  if (metrikaId && !nextHtml.includes(analyticsMarker)) {
    const analyticsSnippet = fs
      .readFileSync(analyticsSnippetPath, 'utf8')
      .replaceAll('__YANDEX_METRIKA_ID__', metrikaId);
    nextHtml = nextHtml.replace('</head>', `${analyticsMarker}\n${analyticsSnippet}\n</head>`);
  }

  if (!nextHtml.includes(utmMarker)) {
    const utmSnippet = fs
      .readFileSync(utmSnippetPath, 'utf8')
      .replaceAll('__ASSET_VERSION__', assetVersion);
    nextHtml = nextHtml.replace('</head>', `${utmMarker}\n${utmSnippet}\n</head>`);
  }

  return nextHtml;
}

function injectOpenGraphHead(html, pagePath, config, pageMeta) {
  if (html.includes(openGraphMarker) || !html.includes('</head>')) {
    return html;
  }

  const siteUrl = (process.env.SITE_URL || config.siteUrl).replace(/\/$/, '');
  const pageUrl = pagePath === '/' ? `${siteUrl}/` : `${siteUrl}${pagePath}`;
  const ogImage = resolveSiteUrl(config.openGraph?.image || config.organization.logo, siteUrl);
  const tags = [];

  if (pageMeta.noindex && !/<meta\s+name=["']robots["'][^>]*noindex/i.test(html)) {
    tags.push('<meta name="robots" content="noindex, follow">');
  }

  tags.push(
    `<link rel="canonical" href="${escapeHtmlAttr(pageUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtmlAttr(pageUrl)}">`,
    `<meta property="og:title" content="${escapeHtmlAttr(pageMeta.title)}">`,
    `<meta property="og:description" content="${escapeHtmlAttr(pageMeta.description)}">`,
    `<meta property="og:site_name" content="${escapeHtmlAttr(config.openGraph?.siteName || config.organization.name)}">`,
    `<meta property="og:image" content="${escapeHtmlAttr(ogImage)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  );

  return html.replace('</head>', `${openGraphMarker}\n  ${tags.join('\n  ')}\n</head>`);
}

function injectStructuredData(html, pagePath, config, pageMeta) {
  if (html.includes(structuredDataMarker) || !html.includes('</head>') || pagePath === '/404.html') {
    return html;
  }

  const siteUrl = (process.env.SITE_URL || config.siteUrl).replace(/\/$/, '');
  const org = config.organization;
  const structured = {
    '@context': 'https://schema.org',
    '@type': org['@type'] || 'BeautySalon',
    name: org.name,
    description: pageMeta.description || org.description,
    url: pagePath === '/' ? `${siteUrl}/` : `${siteUrl}${pagePath}`,
    telephone: org.telephone,
    image: resolveSiteUrl(org.logo, siteUrl),
    address: org.address,
    openingHours: org.openingHours,
    sameAs: org.sameAs || [],
  };

  const script = `<script type="application/ld+json">${JSON.stringify(structured)}</script>`;

  return html.replace('</head>', `${structuredDataMarker}\n${script}\n</head>`);
}

function applyPageMeta(html, pageMeta) {
  let nextHtml = html;

  if (pageMeta.title) {
    nextHtml = nextHtml.replace(/<title>[^<]*<\/title>/i, `<title>${pageMeta.title}</title>`);
  }

  if (pageMeta.description && !nextHtml.includes('name="description"')) {
    nextHtml = nextHtml.replace(
      '<meta content="width=device-width',
      `<meta name="description" content="${escapeHtmlAttr(pageMeta.description)}">\n  <meta content="width=device-width`,
    );
  }

  return nextHtml;
}

function runBuild() {
  if (!fs.existsSync(publicDir)) {
    console.error('build-static: missing directory public/');
    process.exit(1);
  }

  const nodeEnv = process.env.NODE_ENV || 'production';
  if (nodeEnv === 'development') {
    loadEnvFile('.env.development');
  }

  const isDev = nodeEnv === 'development';
  const leadApiUrl = process.env.LEAD_API_URL || (isDev ? 'http://localhost:3000' : '');
  const assetVersion = process.env.ASSET_VERSION || '1';
  const metrikaId = process.env.YANDEX_METRIKA_ID || '';
  const config = JSON.parse(fs.readFileSync(structuredDataConfigPath, 'utf8'));
  const assetsCdnBase = getAssetsCdnBase(config);

  if (!assetsCdnBase && !isDev) {
    console.warn('build-static: assetsCdnBase is empty in structured-data.config.json');
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.cpSync(publicDir, distDir, { recursive: true });
  minifySiteCss();
  pruneDistStaticAssets();

  let headSnippetsInjected = 0;
  let openGraphInjected = 0;
  let structuredDataInjected = 0;
  const pagePaths = [];

  for (const htmlPath of walkHtmlFiles(distDir)) {
    const pagePath = getPagePath(htmlPath, distDir);
    pagePaths.push(pagePath);

    // Legal documents are standalone converted HTML files. Publish them with
    // the site, but do not inject landing-page analytics, OG or JSON-LD.
    if (pagePath.startsWith('/documents/')) {
      continue;
    }

    const pageMeta = config.pages?.[pagePath] || {};
    let html = fs.readFileSync(htmlPath, 'utf8');
    const isNotFoundPage = pagePath === '/404.html';

    html = normalizeRootRelativePaths(html);
    html = stripWebflowGenerator(html);
    html = applyPageMeta(html, pageMeta);
    const beforeSnippets = html;
    const withHeadSnippets = isNotFoundPage
      ? html
      : injectHeadSnippets(html, assetVersion, metrikaId);
    const withOpenGraph = isNotFoundPage
      ? withHeadSnippets
      : injectOpenGraphHead(withHeadSnippets, pagePath, config, pageMeta);
    const withStructuredData = injectStructuredData(withOpenGraph, pagePath, config, pageMeta);
    html = bustAssetUrls(withStructuredData, assetVersion, assetsCdnBase);

    if (withHeadSnippets !== beforeSnippets) {
      headSnippetsInjected += 1;
    }
    if (withOpenGraph !== withHeadSnippets) {
      openGraphInjected += 1;
    }
    if (withStructuredData !== withOpenGraph) {
      structuredDataInjected += 1;
    }

    fs.writeFileSync(htmlPath, html, 'utf8');
  }

  const leadConfigPath = path.join(distDir, 'js', 'lead-config.js');
  if (fs.existsSync(leadConfigPath)) {
    fs.writeFileSync(
      leadConfigPath,
      fs.readFileSync(leadConfigPath, 'utf8').replaceAll('__LEAD_API_URL__', leadApiUrl),
      'utf8',
    );
  }

  if (headSnippetsInjected > 0) {
    console.log(`build-static: injected analytics + UTM into ${headSnippetsInjected} HTML file(s)`);
  }
  if (openGraphInjected > 0) {
    console.log(`build-static: injected Open Graph into ${openGraphInjected} HTML file(s)`);
  }
  if (structuredDataInjected > 0) {
    console.log(`build-static: injected structured data into ${structuredDataInjected} HTML file(s)`);
  }

  if (!metrikaId) {
    console.warn('build-static: YANDEX_METRIKA_ID is empty — analytics not injected');
  }

  if (!leadApiUrl) {
    console.warn('build-static: LEAD_API_URL is empty — forms will fail until it is set');
  } else {
    console.log(`build-static: LEAD_API_URL=${leadApiUrl} (NODE_ENV=${nodeEnv})`);
  }

  console.log(`build-static: ASSET_VERSION=${assetVersion}`);
  if (assetsCdnBase) {
    console.log(`build-static: assets CDN (source HTML): ${assetsCdnBase}`);
  }
  console.log(`build-static: pages=${pagePaths.join(', ')}`);
  console.log('build-static: copied public/ -> dist/ (site assets only in dist/)');
}

module.exports = { runBuild };

if (require.main === module) {
  runBuild();
}
