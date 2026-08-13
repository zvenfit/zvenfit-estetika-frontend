'use strict';

/** Block analytics and third-party scripts that add noise to screenshots. */
async function blockNoisyRequests(page) {
  const blocked = [
    '**/mc.yandex.ru/**',
    '**/metrika/**',
    '**/google-analytics.com/**',
    '**/googletagmanager.com/**',
  ];

  for (const pattern of blocked) {
    await page.route(pattern, (route) => route.abort());
  }
}

/** Wait until fonts and visible media are ready before screenshots. */
async function waitForVisualStable(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });

  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img:not([loading="lazy"])')];
    if (images.length === 0) {
      return true;
    }
    return images.every((img) => img.complete);
  });

  // CSS background-image loads are not observable; short settle for CDN assets.
  await page.waitForTimeout(500);
}

module.exports = { blockNoisyRequests, waitForVisualStable };
