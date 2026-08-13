'use strict';

const { test, expect } = require('@playwright/test');
const { blockNoisyRequests, waitForVisualStable } = require('./helpers');

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

    const hero = page.locator(
      isDesktop(testInfo) ? '.w-layout-blockcontainer.home-hero' : '.main-block',
    );
    await expect(hero).toHaveScreenshot('home-hero.png');
  });

  test('hero CTA is topmost and navigates', async ({ page }) => {
    await page.goto('/');

    const cta = page.locator('.home-hero .button');
    await expect(cta).toBeVisible();
    const receivesPointer = await cta.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return target === element || element.contains(target);
    });
    expect(receivesPointer).toBe(true);

    await cta.click();
    await expect(page).toHaveURL(/\/form\/$/);
  });

  test('why-us cards stay in document flow while scrolling', async ({ page }) => {
    await page.goto('/');

    await page.locator('.why').scrollIntoViewIfNeeded();
    const motionState = await page.locator('.why .why-card').evaluateAll((cards) => (
      cards.slice(0, 3).map((card) => {
        const style = getComputedStyle(card);
        return { opacity: style.opacity, transform: style.transform };
      })
    ));

    expect(motionState).toEqual([
      { opacity: '1', transform: 'none' },
      { opacity: '1', transform: 'none' },
      { opacity: '1', transform: 'none' },
    ]);
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
  test('phone mask loads from CDN and formats input', async ({ page }) => {
    await page.goto('/form/');

    const phone = page.locator('input[name="phone"]');
    await phone.fill('9991234567');

    await expect(phone).toHaveValue('+7 (999) 123-45-67');
  });

  test('hero + form layout', async ({ page }) => {
    await page.goto('/form/');
    await waitForVisualStable(page);

    const layout = page.locator('.main .main-wrap');
    await expect(layout).toBeVisible();
    await expect(layout).toHaveScreenshot('form-main.png');
  });
});
