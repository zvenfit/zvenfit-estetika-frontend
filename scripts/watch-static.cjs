'use strict';

const fs = require('fs');
const path = require('path');

const { runBuild } = require('./build-static.cjs');

const rootDir = path.join(__dirname, '..');
const structuredDataConfigPath = path.join(__dirname, 'structured-data.config.json');
const watchTargets = [
  path.join(rootDir, 'public'),
  path.join(__dirname, 'snippets'),
  structuredDataConfigPath,
  path.join(__dirname, 'build-static.cjs'),
];

const DEBOUNCE_MS = 200;

let debounceTimer;
let isBuilding = false;
let rebuildQueued = false;

function runBuildSafely(trigger) {
  if (isBuilding) {
    rebuildQueued = true;
    return;
  }

  isBuilding = true;
  console.log(`[watch-static] rebuild${trigger ? `: ${trigger}` : ''}`);

  try {
    runBuild();
    console.log('[watch-static] ready — refresh browser');
  } catch (error) {
    console.error('[watch-static] build failed:', error.message);
  } finally {
    isBuilding = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      scheduleRebuild('queued changes');
    }
  }
}

function scheduleRebuild(trigger) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => runBuildSafely(trigger), DEBOUNCE_MS);
}

function shouldIgnore(filename) {
  if (!filename) {
    return false;
  }

  return (
    filename.includes(`${path.sep}.`) || filename.endsWith('~') || filename.endsWith('.swp')
  );
}

function watchPath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    console.warn(`[watch-static] skip missing path: ${targetPath}`);
    return;
  }

  const isDirectory = fs.statSync(targetPath).isDirectory();
  fs.watch(targetPath, { recursive: isDirectory }, (_, filename) => {
    if (shouldIgnore(filename)) {
      return;
    }
    scheduleRebuild(filename || path.basename(targetPath));
  });
}

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

runBuildSafely('initial');

for (const targetPath of watchTargets) {
  watchPath(targetPath);
}

console.log('[watch-static] watching public/, scripts/snippets/, structured-data.config.json');
