'use strict';

const fs = require('fs');
const path = require('path');
const CleanCSS = require('clean-css');

const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const uploadDir = path.join(rootDir, 'upload', 'zvenfit-kosmetologiya.webflow');
const outDir = path.join(rootDir, '.cdn-upload');

const VENDOR_CSS = [
  { source: 'normalize.css', target: 'normalize.min.css' },
  { source: 'webflow.css', target: 'webflow.min.css' },
];

function minifyVendorCss() {
  const cleaner = new CleanCSS({ level: 2 });
  fs.mkdirSync(path.join(outDir, 'css'), { recursive: true });

  for (const { source, target } of VENDOR_CSS) {
    const sourcePath = path.join(uploadDir, 'css', source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`prepare-cdn-assets: missing upload/.../css/${source}`);
    }

    const input = fs.readFileSync(sourcePath, 'utf8');
    const result = cleaner.minify(input);
    if (result.errors.length > 0) {
      throw new Error(`CSS minify failed for ${source}: ${result.errors.join(', ')}`);
    }

    fs.writeFileSync(path.join(outDir, 'css', target), result.styles, 'utf8');
    console.log(`prepare-cdn-assets: css/${source} -> css/${target}`);
  }
}

function run() {
  if (!fs.existsSync(publicDir)) {
    console.error('prepare-cdn-assets: missing public/');
    process.exit(1);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  minifyVendorCss();

  const webflowJs = path.join(publicDir, 'js', 'webflow.js');
  if (fs.existsSync(webflowJs)) {
    fs.mkdirSync(path.join(outDir, 'js'), { recursive: true });
    fs.copyFileSync(webflowJs, path.join(outDir, 'js', 'webflow.js'));
    console.log('prepare-cdn-assets: copied js/webflow.js');
  }

  console.log(`prepare-cdn-assets: ready at ${outDir}`);
}

run();
