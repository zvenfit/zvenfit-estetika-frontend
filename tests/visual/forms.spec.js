'use strict';

const { test, expect } = require('@playwright/test');
const { blockNoisyRequests } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await blockNoisyRequests(page);
});

test('lead form submits once and shows the accepted state', async ({ page }) => {
  let requests = 0;
  let payload;
  await page.route('https://example.invalid/lead', async (route) => {
    requests += 1;
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, notification: 'pending' }),
    });
  });
  await page.goto('/form/');

  await page.locator('[name="name"]').fill('Анна');
  await page.locator('[name="phone"]').fill('9991234567');
  await expect(page.locator('#custom-select')).toHaveCSS('color', 'rgb(153, 153, 153)');
  await page.locator('#custom-select').click();
  await page.locator('[data-value="WhatsApp"]').click();
  await expect(page.locator('#custom-select')).toHaveCSS('color', 'rgb(22, 22, 22)');
  await page.locator('#wf-form-tg-send [type="submit"]').click();

  await expect(page.locator('#tg-send .success-message')).toBeVisible();
  expect(requests).toBe(1);
  expect(payload.consents).toEqual({
    version: '2026-08-14-v2',
    personal_data: true,
    marketing: false,
  });
});

test('newsletter explains rate limiting and moves focus to the error', async ({ page }) => {
  let payload;
  await page.route('https://example.invalid/lead', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'rate_limit_exceeded' }),
    });
  });
  await page.goto('/');

  await page.locator('#wf-form-Form [name="phone"]').fill('9991234567');
  const consentLinks = page.locator('#wf-form-Form .inst-warning.form a');
  await expect(consentLinks).toHaveCount(2);
  for (const link of await consentLinks.all()) {
    await expect(link).toHaveCSS('color', 'rgb(187, 122, 140)');
  }
  await page.locator('#wf-form-Form [type="submit"]').click();

  const error = page.locator('#newsletter-send .error-message');
  await expect(error).toContainText('Подождите 10 минут');
  await expect(error).toBeFocused();
  expect(payload.consents).toEqual({
    version: '2026-08-14-v2',
    personal_data: true,
    marketing: true,
  });
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
