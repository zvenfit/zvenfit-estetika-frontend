// Runtime unit tests: evaluate the shipped scripts with a minimal DOM and a fake API.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const KINDS = ['lead', 'newsletter'];
const ID_KEY = 'submission_id';
const runtimeFiles = kind => ['analytics.js', 'form-client.js', `${kind}-form.js`];

function response(status = 202, data = { ok: true, [ID_KEY]: 'saved-submission' }) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function mount(kind, fetchResult = async () => response(), dataLayer) {
  const listeners = {};
  const ready = [];
  const calls = [];
  const attributes = {};
  const node = (value = '') => ({
    value, style: {}, focus() {}, setAttribute() {}, addEventListener() {},
  });
  const fields = Object.fromEntries(['name', 'phone', 'service', 'telegram_username', 'website', 'company_website']
    .map(name => [`[name="${name}"]`, node(['website', 'company_website'].includes(name) ? '' : name === 'service' ? 'Phone' : 'synthetic-test-value')]));
  const button = node('Отправить');
  const buttonListeners = {};
  button.addEventListener = (event, callback) => { buttonListeners[event] = callback; };
  const click = () => buttonListeners.click();
  const success = node();
  const error = node();
  error.firstElementChild = node();
  error.querySelector = () => error.firstElementChild;
  const form = {
    style: {}, dataset: { consentVersion: 'test', consentMode: 'submit' },
    querySelector: selector => selector === '[type="submit"]' ? button : fields[selector] || null,
    addEventListener: (event, callback) => { listeners[event] = callback; },
    setAttribute: (key, value) => { attributes[key] = value; },
    reset() {},
  };
  const root = { querySelector: selector => selector === '.success-message' ? success : error };
  let serial = 0;
  const createId = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const window = {
    ZVENFIT_LEAD_API: 'https://example.invalid/lead', dataLayer,
    crypto: { randomUUID: createId }, __ZVENFIT_CREATE_SUBMISSION_ID: createId,
  };
  const document = {
    addEventListener: (event, callback) => { if (event === 'DOMContentLoaded') ready.push(callback); },
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === (kind === 'lead' ? '#wf-form-tg-send' : '#wf-form-Form')) return form;
      if (selector === (kind === 'lead' ? '#tg-send' : '#newsletter-send')) return root;
      return null;
    },
  };
  const context = vm.createContext({
    window, document, AbortController,
    fetch: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return fetchResult(calls.length);
    },
    setTimeout(callback, delay) {
      // Retry backoffs run immediately; request and success-display timeouts stay pending.
      if (delay < 2000) queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {},
  });
  for (const file of runtimeFiles(kind)) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js', file), 'utf8'), context);
  }
  ready.forEach(callback => callback());
  return {
    calls, window, fields, success, error, button, attributes,
    click,
    events: () => Array.from(window.dataLayer || [], event => ({ ...event })),
    conversions: () => Array.from(window.dataLayer || [], event => ({ ...event })).filter(event => event.event === 'form_submitted'),
    submit: () => {
      click();
      return listeners.submit({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    },
  };
}

for (const kind of KINDS) {
  test(`${kind}: each button activation emits an attempt before validation, without form data`, () => {
    const app = mount(kind);
    app.click();
    app.click();
    assert.equal(app.calls.length, 0);
    assert.deepEqual(app.events(), [
      { event: 'form_submit_attempt', form_type: kind },
      { event: 'form_submit_attempt', form_type: kind },
    ]);
  });

  test(`${kind}: a disabled submit button cannot emit an attempt`, () => {
    const app = mount(kind);
    app.button.disabled = true;
    app.click();
    assert.deepEqual(app.events(), []);
  });

  test(`${kind}: publishes only after API acceptance, preserves the queue and excludes form data`, async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const queue = [{ event: 'gtm.js' }];
    const app = mount(kind, () => pending, queue);
    const sending = app.submit();
    assert.deepEqual(app.events(), [{ event: 'gtm.js' }, { event: 'form_submit_attempt', form_type: kind }]);
    assert.equal(app.button.disabled, true);
    resolve(response());
    await sending;
    assert.equal(app.window.dataLayer, queue);
    assert.deepEqual(app.events(), [
      { event: 'gtm.js' },
      { event: 'form_submit_attempt', form_type: kind },
      { event: 'form_submitted', form_type: kind },
    ]);
    assert.equal(app.success.style.display, 'block');
    assert.equal(app.attributes['aria-busy'], 'false');
  });

  test(`${kind}: creates a queue before GTM loads and counts each new accepted submission`, async () => {
    const app = mount(kind, async () => response(200));
    await app.submit();
    await app.submit();
    assert.deepEqual(app.events(), [
      { event: 'form_submit_attempt', form_type: kind },
      { event: 'form_submitted', form_type: kind },
      { event: 'form_submit_attempt', form_type: kind },
      { event: 'form_submitted', form_type: kind },
    ]);
    assert.notEqual(app.calls[0].submission_id, app.calls[1].submission_id);
  });

  test(`${kind}: ignores a second submit while the first request is pending`, async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const app = mount(kind, () => pending);
    const sending = app.submit();
    await app.submit();
    assert.equal(app.calls.length, 1);
    assert.deepEqual(app.events(), [{ event: 'form_submit_attempt', form_type: kind }]);
    resolve(response());
    await sending;
    assert.equal(app.conversions().length, 1);
  });

  for (const [label, reply] of [
    ['HTTP 400', response(400)], ['HTTP 429', response(429)], ['HTTP 503', response(503)],
    ['API rejection', response(200, { ok: false, [ID_KEY]: 'not-saved' })],
    ['malformed JSON', { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }],
  ]) {
    test(`${kind}: ${label} emits no conversion and allows retry`, async () => {
      const app = mount(kind, async call => call === 1 ? reply : response());
      await app.submit();
      assert.deepEqual(app.conversions(), []);
      assert.equal(app.error.style.display, 'block');
      assert.equal(app.button.disabled, false);
      await app.submit();
      assert.equal(app.conversions().length, 1);
      assert.equal(app.calls[0].submission_id, app.calls[1].submission_id);
    });
  }

  for (const data of [{ ok: true }, { ok: true, [ID_KEY]: '' }, { ok: true, [ID_KEY]: ' ' }, { ok: true, [ID_KEY]: 123 }, { ok: 'true', [ID_KEY]: 'id' }]) {
    test(`${kind}: requires a real persistence acknowledgement ${JSON.stringify(data)}`, async () => {
      const app = mount(kind, async () => response(200, data));
      await app.submit();
      assert.deepEqual(app.conversions(), []);
    });
  }

  test(`${kind}: network failure emits no conversion, retry uses the same submission ID`, async () => {
    let fail = true;
    const app = mount(kind, async () => {
      if (fail) throw new TypeError('network unavailable');
      return response();
    });
    await app.submit();
    assert.deepEqual(app.conversions(), []);
    assert.equal(app.error.style.display, 'block');
    fail = false;
    await app.submit();
    assert.equal(app.conversions().length, 1);
    assert.equal(new Set(app.calls.map(call => call.submission_id)).size, 1);
  });

  test(`${kind}: an analytics exception cannot turn acceptance into an error`, async () => {
    const app = mount(kind, async () => response(), { push() { throw new Error('tag failure'); } });
    await app.submit();
    assert.equal(app.success.style.display, 'block');
    assert.equal(app.error.style.display, 'none');
    assert.equal(app.button.disabled, false);
  });

  test(`${kind}: missing API configuration cannot emit a conversion`, async () => {
    const app = mount(kind);
    app.window.ZVENFIT_LEAD_API = '';
    await app.submit();
    assert.equal(app.calls.length, 0);
    assert.deepEqual(app.conversions(), []);
  });
}
test('lead: failed contact-method validation sends neither request nor conversion', async () => {
  const app = mount('lead');
  app.fields['[name="service"]'].value = '';
  await app.submit();
  assert.equal(app.calls.length, 0);
  assert.deepEqual(app.conversions(), []);
});
