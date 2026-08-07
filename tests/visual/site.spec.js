'use strict';

const { test, expect } = require('@playwright/test');
const { blockNoisyRequests, waitForVisualStable, revealForScreenshot } = require('./helpers');

function isDesktop(testInfo) {
  return testInfo.project.name === 'desktop-chrome';
}

test.beforeEach(async ({ page }) => {
  await blockNoisyRequests(page);
});

test.describe('home', () => {
  test('hero block', async ({ page }, testInfo) => {
    await page.goto('/');
    await waitForVisualStable(page);
    await revealForScreenshot(page, '.w-layout-blockcontainer.main');

    const hero = page.locator(
      isDesktop(testInfo) ? '.w-layout-blockcontainer.main' : '.main-block',
    );
    await expect(hero).toHaveScreenshot('home-hero.png');
  });

  test('services — face tab', async ({ page }) => {
    await page.goto('/#services');
    await waitForVisualStable(page);

    const services = page.locator('#services');
    await expect(services).toBeVisible();
    await expect(services).toHaveScreenshot('home-services-face.png');
  });

  test('services — body tab', async ({ page }) => {
    await page.goto('/#services');
    await waitForVisualStable(page);

    await page.locator('.tab-link-tab-2').click();
    await page.locator('[data-w-tab="Tab 2"].w-tab-pane').waitFor({ state: 'visible' });
    await waitForVisualStable(page);

    const services = page.locator('#services');
    await expect(services).toHaveScreenshot('home-services-body.png');
  });

  test('apparatus section', async ({ page }, testInfo) => {
    await page.goto('/#about');

    if (isDesktop(testInfo)) {
      const equipment = page.locator('.equipment');
      await equipment.scrollIntoViewIfNeeded();
      await waitForVisualStable(page);
      await expect(equipment).toBeVisible();
      await expect(equipment).toHaveScreenshot('home-equipment.png');
      return;
    }

    const equipmentMobile = page.locator('.equipment-mobile');
    await equipmentMobile.scrollIntoViewIfNeeded();
    await waitForVisualStable(page);
    await expect(equipmentMobile).toBeVisible();
    await expect(equipmentMobile).toHaveScreenshot('home-equipment-mobile.png');
  });
});

test.describe('form page', () => {
  test('hero + form layout', async ({ page }) => {
    await page.goto('/form/');
    await waitForVisualStable(page);

    const layout = page.locator('.main .main-wrap');
    await expect(layout).toBeVisible();
    await expect(layout).toHaveScreenshot('form-main.png');
  });
});
