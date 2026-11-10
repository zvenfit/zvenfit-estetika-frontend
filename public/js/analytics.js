(function () {
  'use strict';
  if (window.__ZVENFIT_ANALYTICS) {
    return;
  }

  const settings = document.currentScript?.dataset || {};
  const schemas = {
    form_submit_attempt: { form_type: ['lead', 'newsletter'] },
    form_submitted: { form_type: ['lead', 'newsletter'] },
    lead_form_click: { form_type: ['lead'] },
    contact_click: { contact_method: ['phone', 'email', 'telegram', 'whatsapp', 'max', 'vk'] },
    map_open: { map_provider: ['yandex', 'google', '2gis'] },
    app_download_click: { app_platform: ['app_store', 'rustore', 'android_apk'] },
    schedule_loaded: {},
    schedule_event_open: {},
    engagement_30s: {},
    scroll_depth: { scroll_percent: [50] },
  };

  // Only documented fields and values can reach GTM. Never forward a form,
  // link URL, text, query string, phone number or arbitrary caller properties.
  function track(event, parameters = {}, onHandled) {
    try {
      if (typeof event !== 'string' || !Object.hasOwn(schemas, event)) {
        return false;
      }
      const payload = { event };
      for (const [key, values] of Object.entries(schemas[event])) {
        if (!values.includes(parameters[key])) {
          return false;
        }
        payload[key] = parameters[key];
      }
      if (typeof onHandled === 'function') {
        payload.eventCallback = onHandled;
        payload.eventTimeout = 800;
      }
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(payload);

      return true;
    } catch {
      // A blocked or broken analytics tag must not affect the site.
      return false;
    }
  }

  function linkEvent(link) {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#')) {
      return null;
    }
    let url;
    try {
      url = new URL(href, window.location.href);
    } catch {
      return null;
    }
    if (url.protocol === 'tel:' || url.protocol === 'mailto:') {
      return ['contact_click', { contact_method: url.protocol === 'tel:' ? 'phone' : 'email' }];
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (url.origin === window.location.origin && ['/form', '/forma-dlya-zayavki'].includes(pathname)) {
      return ['lead_form_click', { form_type: 'lead' }];
    }
    const contacts = {
      't.me': 'telegram',
      'telegram.me': 'telegram',
      'wa.me': 'whatsapp',
      'api.whatsapp.com': 'whatsapp',
      'whatsapp.com': 'whatsapp',
      'max.ru': 'max',
      'vk.com': 'vk',
    };
    if (Object.hasOwn(contacts, host)) {
      return ['contact_click', { contact_method: contacts[host] }];
    }
    if (
      ['yandex.ru', 'yandex.com', 'yandex.kz'].includes(host) &&
      (pathname === '/maps' || pathname.startsWith('/maps/'))
    ) {
      return ['map_open', { map_provider: 'yandex' }];
    }
    if (
      host === 'maps.app.goo.gl' ||
      host === 'maps.google.com' ||
      (['google.com', 'google.ru'].includes(host) && (pathname === '/maps' || pathname.startsWith('/maps/')))
    ) {
      return ['map_open', { map_provider: 'google' }];
    }
    if (['2gis.ru', 'go.2gis.com'].includes(host)) {
      return ['map_open', { map_provider: '2gis' }];
    }
    if (host === 'apps.apple.com' && /\/id6748636800$/.test(pathname)) {
      return ['app_download_click', { app_platform: 'app_store' }];
    }
    if (host === 'rustore.ru' && pathname === '/catalog/app/io.fitbase.zvenfit') {
      return ['app_download_click', { app_platform: 'rustore' }];
    }
    if (host === 'mobile.fitbase.io' && pathname === '/public/android-build/zvenfit/app-release.apk') {
      return ['app_download_click', { app_platform: 'android_apk' }];
    }

    return null;
  }

  function onLinkActivation(event) {
    if (event.defaultPrevented || (event.type === 'auxclick' ? event.button !== 1 : event.button !== 0)) {
      return;
    }
    const link = event.target?.closest?.('a[href]');
    if (!link || link.closest('[data-analytics-ignore], [aria-disabled="true"]')) {
      return;
    }
    const descriptor = linkEvent(link);
    if (!descriptor) {
      return;
    }
    const gtmStarted =
      window.google_tag_manager ||
      (Array.isArray(window.dataLayer) && window.dataLayer.some(item => item?.event === 'gtm.js'));
    const target = link.getAttribute('target');
    const destination = new URL(link.getAttribute('href'), window.location.href);
    const leavesPage =
      gtmStarted &&
      ['http:', 'https:'].includes(destination.protocol) &&
      event.type === 'click' &&
      event.cancelable &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      (!target || target === '_self') &&
      !link.hasAttribute('download');
    if (!leavesPage) {
      track(...descriptor);

      return;
    }
    event.preventDefault();
    let resumed = false;
    let timer;
    function resume() {
      if (resumed) {
        return;
      }
      resumed = true;
      clearTimeout(timer);
      // Leave after the current click handlers, even if GTM calls back inline.
      setTimeout(() => window.location.assign(destination.href), 0);
    }
    timer = setTimeout(resume, 800);
    if (!track(...descriptor, resume)) {
      resume();
    }
  }

  // Capture also sees dynamic map/schedule links and nested SVG/text targets,
  // even when a widget stops bubbling. Same-tab links allow GTM up to 800 ms;
  // modified clicks, new tabs and downloads retain native navigation.
  document.addEventListener('click', onLinkActivation, true);
  document.addEventListener('auxclick', onLinkActivation, true);
  window.__ZVENFIT_ANALYTICS = Object.freeze({ track });

  function ready() {
    if (settings.analyticsTimer === 'true') {
      setTimeout(() => track('engagement_30s'), 30000);
    }
    if (settings.analyticsScroll !== 'true') {
      return;
    }
    let scrollTracked = false;
    function checkScroll() {
      if (scrollTracked) {
        return;
      }
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      if (height > 0 && (window.scrollY + window.innerHeight) / height >= 0.5) {
        scrollTracked = true;
        track('scroll_depth', { scroll_percent: 50 });
        window.removeEventListener('scroll', checkScroll);
        window.removeEventListener('resize', checkScroll);
      }
    }
    window.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    if (document.readyState === 'complete') {
      checkScroll();
    } else {
      window.addEventListener('load', checkScroll, { once: true });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();
