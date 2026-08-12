'use strict';

const { test, expect } = require('@playwright/test');
const { blockNoisyRequests } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await blockNoisyRequests(page);
});

test('lead form submits once and shows the accepted state', async ({ page }) => {
  let requests = 0;
  await page.route('https://example.invalid/lead', async (route) => {
    requests += 1;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, notification: 'pending' }),
    });
  });
  await page.goto('/form/');

  await page.locator('[name="name"]').fill('Анна');
  await page.locator('[name="phone"]').fill('9991234567');
  await page.locator('#custom-select').click();
  await page.locator('[data-value="WhatsApp"]').click();
  await page.locator('#wf-form-tg-send [type="submit"]').click();

  await expect(page.locator('#tg-send .success-message')).toBeVisible();
  expect(requests).toBe(1);
});

test('newsletter explains rate limiting and moves focus to the error', async ({ page }) => {
  await page.route('https://example.invalid/lead', async (route) => {
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'rate_limit_exceeded' }),
    });
  });
  await page.goto('/');

  await page.locator('#wf-form-Form [name="phone"]').fill('9991234567');
  await page.locator('#wf-form-Form [type="submit"]').click();

  const error = page.locator('#newsletter-send .error-message');
  await expect(error).toContainText('Подождите 10 минут');
  await expect(error).toBeFocused();
});

test('forms have a safe fallback when JavaScript is disabled', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/form/`);

  await expect(page.locator('.form-noscript')).toBeVisible();
  await expect(page.locator('#wf-form-tg-send')).toBeHidden();
  await expect(page.locator('.form-noscript a')).toHaveAttribute('href', 'tel:+79688440088');

  await context.close();
});
