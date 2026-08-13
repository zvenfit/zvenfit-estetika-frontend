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

  test('320px mobile layout fits and primary controls are touch-sized', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');

    await expect(page.locator('.tab-link-tab-1')).toHaveCSS('min-height', '44px');
    await expect(page.locator('.equipment-mobile .left-arrow')).toHaveCSS('min-height', '44px');

    const layout = await page.evaluate(() => {
      const socialLinks = document.querySelector('.socials').getBoundingClientRect();
      const phoneLink = document.querySelector('.footer .link-2').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        socialsRight: Math.round(socialLinks.right),
        phoneHeight: Math.round(phoneLink.height),
      };
    });

    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.socialsRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.phoneHeight).toBeGreaterThanOrEqual(44);

    const booking = page.locator('.mobile-booking-cta');
    await expect(booking).toHaveAttribute('aria-hidden', 'true');
    await page.locator('.why').scrollIntoViewIfNeeded();
    await expect(booking).toHaveAttribute('aria-hidden', 'false');
    await booking.click();
    await expect(page).toHaveURL(/\/form\/$/);
  });

  test('mobile menu and FAQ remain tappable', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');

    const menuToggle = page.locator('.menu_mobile .dropdown-toggle');
    await menuToggle.click();
    await expect(menuToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.menu_mobile .dropdown-link')).toBeVisible();

    await page.locator('.menu_mobile .dropdown-link').click();
    await expect(page).toHaveURL(/#services$/);
    await expect(page.locator('#services')).toBeVisible();

    const question = page.locator('.qa-mobile .qa-toggle').first();
    await question.scrollIntoViewIfNeeded();
    await question.click();
    await expect(question).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.qa-mobile .qa-dropdown').first()).toBeVisible();
  });

  test('page remains fluid through responsive breakpoints', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome');

    for (const width of [280, 320, 390, 479, 480, 640, 767, 768, 991, 992, 1024, 1200, 1399, 1400]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');

      const pageWidth = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        heroButtonHeight: Math.round(
          document.querySelector('.home-hero .button').getBoundingClientRect().height,
        ),
      }));

      expect(pageWidth.document, `home page overflow at ${width}px`).toBe(pageWidth.viewport);
      if (width <= 479) {
        expect(pageWidth.heroButtonHeight, `hero CTA wraps at ${width}px`).toBeLessThanOrEqual(48);
      }
    }
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

  test('320px form keeps usable side gutters', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome');
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/form/');

    const layout = await page.evaluate(() => {
      const form = document.querySelector('.form-wrap-block').getBoundingClientRect();
      const input = document.querySelector('input[name="name"]').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        formLeft: Math.round(form.left),
        formRight: Math.round(form.right),
        inputLeft: Math.round(input.left),
        inputRight: Math.round(input.right),
      };
    });

    expect(layout.documentWidth).toBe(layout.viewportWidth);
    expect(layout.formLeft).toBeGreaterThanOrEqual(0);
    expect(layout.formRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.inputLeft).toBeGreaterThan(layout.formLeft);
    expect(layout.inputRight).toBeLessThan(layout.formRight);
    await expect(page.locator('.mobile-back-link')).toBeVisible();

    const contactMethod = page.locator('#custom-select');
    await expect(contactMethod).toHaveText('Выберите способ связи');
    await expect(contactMethod).toHaveCSS('height', '50px');
    await contactMethod.click();
    await expect(contactMethod).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#contact-method-options [role="option"]')).toHaveCount(4);
    await expect(page.locator('#contact-method-options [role="option"]').first()).toHaveCSS(
      'min-height',
      '44px',
    );
  });

  test('form remains fluid through responsive breakpoints', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome');

    for (const width of [280, 320, 390, 479, 480, 640, 767, 768, 991, 992, 1024, 1200, 1399, 1400]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/form/');

      const pageWidth = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
      }));

      expect(pageWidth.document, `form page overflow at ${width}px`).toBe(pageWidth.viewport);
    }
  });
});
