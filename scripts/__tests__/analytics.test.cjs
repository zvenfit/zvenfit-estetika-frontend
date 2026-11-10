'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/analytics.js'), 'utf8');
function mount(settings = {}, queue) {
  const handlers = {};
  const timers = [];
  const navigations = [];
  const document = {
    currentScript: { dataset: settings },
    readyState: 'loading',
    documentElement: { scrollHeight: 2000 },
    body: { scrollHeight: 2000 },
    addEventListener(type, fn) {
      (handlers[type] ||= []).push(fn);
    },
  };
  const window = {
    location: {
      href: 'https://zvenfit.ru/services/',
      origin: 'https://zvenfit.ru',
      assign: href => navigations.push(href),
    },
    dataLayer: queue,
    scrollY: 0,
    innerHeight: 800,
    addEventListener(type, fn) {
      (handlers[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      handlers[type] = handlers[type].filter(item => item !== fn);
    },
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    setTimeout(fn, ms) {
      const timer = { fn, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.active = false;
    },
  });
  vm.runInContext(source, context);
  const emit = (type, event = {}) => [...(handlers[type] || [])].forEach(fn => fn({ type, ...event }));
  emit('DOMContentLoaded');
  return {
    window,
    document,
    timers,
    navigations,
    runTimers(ms) {
      for (const timer of [...timers])
        if (timer.ms === ms && timer.active) {
          timer.active = false;
          timer.fn();
        }
    },
    emit,
    handlers,
    again: () => vm.runInContext(source, context),
    track: window.__ZVENFIT_ANALYTICS.track,
    events: () => JSON.parse(JSON.stringify(window.dataLayer || [])),
    activate(href, options = {}) {
      const link = {
        getAttribute: name => (name === 'href' ? href : options.target || null),
        hasAttribute: name => name === 'download' && options.download,
        closest: () => options.ignored || options.disabled || null,
      };
      let prevented = false;
      emit(options.type || 'click', {
        button: options.button ?? 0,
        cancelable: true,
        ctrlKey: options.ctrlKey,
        metaKey: options.metaKey,
        altKey: options.altKey,
        shiftKey: options.shiftKey,
        defaultPrevented: options.cancelled || false,
        target: { closest: () => link },
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          throw new Error('analytics must not stop propagation');
        },
      });
      return prevented;
    },
  };
}

test('only the documented event schema is forwarded; user data and unknown events are rejected', () => {
  const app = mount();
  assert.equal(app.track('form_submitted', { form_type: 'lead', phone: 'secret', url: 'secret' }), true);
  assert.equal(app.track('unknown', { form_type: 'lead' }), false);
  assert.equal(app.track('__proto__'), false);
  assert.equal(
    app.track(Object.assign(new String('form_submitted'), { phone: 'secret' }), { form_type: 'lead' }),
    false,
  );
  assert.equal(app.track('contact_click', { contact_method: 'secret' }), false);
  assert.equal(app.track('form_submitted', null), false);
  assert.deepEqual(app.events(), [{ event: 'form_submitted', form_type: 'lead' }]);
});

test('preserves the GTM queue and isolates tag exceptions', () => {
  const queue = [{ event: 'gtm.js' }];
  const app = mount({}, queue);
  app.track('engagement_30s');
  assert.equal(app.window.dataLayer, queue);
  queue.push = () => {
    throw new Error('tag failed');
  };
  assert.equal(app.track('engagement_30s'), false);
  assert.equal(queue.length, 2);
});

for (const [href, event, params] of [
  ['/forma-dlya-zayavki/?utm_source=secret', 'lead_form_click', { form_type: 'lead' }],
  ['/form/#contact', 'lead_form_click', { form_type: 'lead' }],
  ['tel:+79990000000', 'contact_click', { contact_method: 'phone' }],
  ['mailto:test@example.invalid?body=secret', 'contact_click', { contact_method: 'email' }],
  ['https://t.me/zvenfit', 'contact_click', { contact_method: 'telegram' }],
  ['https://wa.me/123', 'contact_click', { contact_method: 'whatsapp' }],
  ['https://max.ru/example', 'contact_click', { contact_method: 'max' }],
  ['https://vk.com/zvenfit', 'contact_click', { contact_method: 'vk' }],
  ['https://yandex.kz/maps/-/abc?ll=secret', 'map_open', { map_provider: 'yandex' }],
  ['https://maps.app.goo.gl/example', 'map_open', { map_provider: 'google' }],
  ['https://go.2gis.com/example', 'map_open', { map_provider: '2gis' }],
  ['https://apps.apple.com/ru/app/id6748636800', 'app_download_click', { app_platform: 'app_store' }],
  ['https://www.rustore.ru/catalog/app/io.fitbase.zvenfit', 'app_download_click', { app_platform: 'rustore' }],
  [
    'https://mobile.fitbase.io/public/android-build/zvenfit/app-release.apk',
    'app_download_click',
    { app_platform: 'android_apk' },
  ],
]) {
  test('link intent: ' + href.split('?')[0], () => {
    const app = mount();
    app.activate(href);
    assert.deepEqual(app.events(), [{ event, ...params }]);
  });
}

test('unrelated, lookalike, placeholder, disabled, ignored and cancelled links are not goals', () => {
  const app = mount();
  for (const href of [
    '#',
    '#contact',
    '',
    'javascript:void(0)',
    'https://vk.com.evil.test/a',
    'https://example.invalid/form/',
    'https://yandex.ru/mapstuff',
    'https://www.rustore.ru/',
    '/privacy/',
    'https://apps.apple.com/ru/app/id123',
  ])
    app.activate(href);
  for (const option of [{ ignored: true }, { disabled: true }, { cancelled: true }]) {
    app.activate('mailto:test@example.invalid', option);
  }
  assert.deepEqual(app.events(), []);
});

test('keyboard click and middle click each count once; right click does not count', () => {
  const app = mount();
  app.activate('tel:1');
  app.activate('tel:1', { button: 1 });
  app.activate('tel:1', { type: 'auxclick', button: 1 });
  app.activate('tel:1', { type: 'auxclick', button: 2 });
  assert.equal(app.events().length, 2);
});

test('repeated initialization does not duplicate listeners or timers', () => {
  const app = mount({ analyticsTimer: 'true' });
  app.again();
  app.activate('tel:1');
  assert.equal(app.events().length, 1);
  assert.equal(app.timers.length, 1);
  assert.equal(app.timers[0].ms, 30000);
  app.timers[0].fn();
  assert.equal(app.events()[1].event, 'engagement_30s');
});

test('50% is emitted once even when scroll precedes load or resize', () => {
  const app = mount({ analyticsScroll: 'true' });
  app.emit('scroll');
  assert.deepEqual(app.events(), []);
  app.window.scrollY = 200;
  app.emit('scroll');
  app.emit('load');
  app.emit('resize');
  assert.deepEqual(app.events(), [{ event: 'scroll_depth', scroll_percent: 50 }]);
});

test('engagement is opt-in per page', () => {
  const app = mount();
  assert.equal(app.timers.length, 0);
  app.window.scrollY = 1000;
  app.emit('scroll');
  app.emit('load');
  assert.deepEqual(app.events(), []);
});

test('same-tab navigation waits for GTM once, including a synchronous callback', () => {
  const queue = [{ event: 'gtm.js' }];
  const app = mount({}, queue);
  queue.push = event => {
    Array.prototype.push.call(queue, event);
    event.eventCallback();
    event.eventCallback();
  };
  assert.equal(app.activate('/forma-dlya-zayavki/?utm_source=test'), true);
  assert.deepEqual(app.navigations, []);
  app.runTimers(0);
  app.runTimers(800);
  app.runTimers(0);
  assert.deepEqual(app.navigations, ['https://zvenfit.ru/forma-dlya-zayavki/?utm_source=test']);
  assert.equal(queue[1].eventTimeout, 800);
});

test('blocked/loading GTM cannot hold a navigation beyond the fallback timeout', () => {
  const app = mount({}, [{ event: 'gtm.js' }]);
  assert.equal(app.activate('/form/'), true);
  app.runTimers(800);
  app.window.dataLayer[1].eventCallback();
  app.runTimers(0);
  assert.deepEqual(app.navigations, ['https://zvenfit.ru/form/']);
});

test('an analytics exception releases navigation immediately', () => {
  const app = mount({}, [{ event: 'gtm.js' }]);
  app.window.dataLayer.push = () => {
    throw new Error('tag failed');
  };
  assert.equal(app.activate('/form/'), true);
  app.runTimers(0);
  assert.deepEqual(app.navigations, ['https://zvenfit.ru/form/']);
});

test('new tabs, modified clicks, downloads and no-GTM pages retain native navigation', () => {
  const app = mount({}, [{ event: 'gtm.js' }]);
  for (const options of [
    { target: '_blank' },
    { target: '_parent' },
    { download: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { type: 'auxclick', button: 1 },
  ]) {
    assert.equal(app.activate('/form/', options), false);
  }
  assert.equal(app.timers.length, 0);
  assert.equal(app.activate('tel:123'), false);
  assert.equal(app.activate('mailto:test@example.invalid'), false);
  assert.equal(mount().activate('/form/'), false);
});
