(function () {
  const TRACKED_PARAMS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'yclid',
    'gclid',
    'fbclid',
  ];

  const STORAGE_KEY = 'zvenfit_attribution';
  const COOKIE_NAME = 'zvenfit_attr';
  const ATTR_TTL_DAYS = 7;
  const ATTR_TTL_MS = ATTR_TTL_DAYS * 24 * 60 * 60 * 1000;
  const COOKIE_MAX_AGE = ATTR_TTL_DAYS * 24 * 60 * 60;

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
  }

  function readUrl() {
    const params = {};
    const search = new URLSearchParams(window.location.search);

    for (const key of TRACKED_PARAMS) {
      const value = search.get(key);
      if (isNonEmptyString(value)) {
        params[key] = value.trim();
      }
    }

    return params;
  }

  function parseRecord(raw) {
    if (!raw) {
      return null;
    }

    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !data.params || typeof data.params !== 'object') {
        return null;
      }

      const capturedAt = Number(data.capturedAt);
      if (!capturedAt || Date.now() - capturedAt > ATTR_TTL_MS) {
        return null;
      }

      const params = {};
      for (const key of TRACKED_PARAMS) {
        const value = data.params[key];
        if (isNonEmptyString(value)) {
          params[key] = value.trim();
        }
      }

      return { capturedAt, params };
    } catch {
      return null;
    }
  }

  function serializeRecord(params) {
    return JSON.stringify({
      capturedAt: Date.now(),
      params,
    });
  }

  function readFromStorage(storage) {
    if (!storage) {
      return null;
    }

    try {
      return parseRecord(storage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function writeToStorage(storage, params) {
    if (!storage) {
      return false;
    }

    try {
      storage.setItem(STORAGE_KEY, serializeRecord(params));

      return true;
    } catch {
      return false;
    }
  }

  function readCookie() {
    try {
      const prefix = COOKIE_NAME + '=';
      const match = document.cookie
        .split(';')
        .map(function (part) {
          return part.trim();
        })
        .find(function (part) {
          return part.startsWith(prefix);
        });
      if (!match) {
        return null;
      }

      const raw = decodeURIComponent(match.slice(prefix.length));

      return parseRecord(raw);
    } catch {
      return null;
    }
  }

  function writeCookie(params) {
    try {
      const encoded = encodeURIComponent(serializeRecord(params));
      const secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie =
        COOKIE_NAME + '=' + encoded + '; path=/; max-age=' + COOKIE_MAX_AGE + '; SameSite=Lax' + secure;

      return true;
    } catch {
      return false;
    }
  }

  function readStoredParams() {
    const readers = [
      function () {
        return readFromStorage(window.localStorage);
      },
      function () {
        return readFromStorage(window.sessionStorage);
      },
      function () {
        return readCookie();
      },
    ];

    for (let i = 0; i < readers.length; i += 1) {
      const record = readers[i]();
      if (record && Object.keys(record.params).length > 0) {
        return Object.assign({}, record.params);
      }
    }

    return {};
  }

  function persist(params) {
    if (Object.keys(params).length === 0) {
      return;
    }

    writeToStorage(window.localStorage, params);
    writeToStorage(window.sessionStorage, params);
    writeCookie(params);
  }

  function isUtmKey(key) {
    return key.indexOf('utm_') === 0;
  }

  function mergeAttribution(stored, fromUrl) {
    const base = Object.assign({}, stored);

    if (
      isNonEmptyString(fromUrl.utm_source) &&
      isNonEmptyString(base.utm_source) &&
      fromUrl.utm_source !== base.utm_source
    ) {
      for (const key of Object.keys(base)) {
        if (isUtmKey(key)) {
          delete base[key];
        }
      }
    }

    for (let i = 0; i < TRACKED_PARAMS.length; i += 1) {
      const key = TRACKED_PARAMS[i];
      if (isNonEmptyString(fromUrl[key])) {
        base[key] = fromUrl[key];
      }
    }

    return base;
  }

  function sync() {
    const fromUrl = readUrl();
    const stored = readStoredParams();
    const merged = mergeAttribution(stored, fromUrl);

    if (Object.keys(merged).length > 0) {
      persist(merged);
    }

    return merged;
  }

  function get() {
    const fromUrl = readUrl();
    const stored = readStoredParams();

    return mergeAttribution(stored, fromUrl);
  }

  function init() {
    sync();
  }

  window.__ZVENFIT_ATTRIBUTION = {
    get,
    sync,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
