'use strict';

const MAX_FIELD_LEN = 256;
const UTM_MAX_LEN = 128;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

const ALLOWED_FORM_TYPES = new Set(['lead', 'newsletter']);
const ALLOWED_SERVICES = new Set(['Позвонить', 'WhatsApp', 'Макс', 'Telegram']);
const rateLimitBuckets = new Map();

const TRACKED_UTM_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'yclid',
  'gclid',
  'fbclid',
];

const UTM_LABELS = {
  utm_source: 'source',
  utm_medium: 'medium',
  utm_campaign: 'campaign',
  utm_term: 'term',
  utm_content: 'content',
  yclid: 'yclid',
  gclid: 'gclid',
  fbclid: 'fbclid',
};

function parseAllowedOrigins() {
  const raw =
    process.env.ALLOWED_ORIGINS || 'https://estetika.zvenfit.ru,https://www.estetika.zvenfit.ru';

  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function resolveOrigin(requestOrigin, allowedOrigins) {
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return allowedOrigins[0] || 'https://estetika.zvenfit.ru';
}

function isAllowedOrigin(requestOrigin, allowedOrigins) {
  return Boolean(requestOrigin && allowedOrigins.includes(requestOrigin));
}

function corsHeaders(origin, allowedOrigins) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(origin, allowedOrigins),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function jsonResponse(statusCode, payload, headers) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

function readBody(event) {
  if (!event.body) {
    return {};
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    const error = new Error('payload_too_large');
    error.code = 'payload_too_large';
    throw error;
  }

  return JSON.parse(raw);
}

function sanitize(value, maxLen = MAX_FIELD_LEN) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLen);
}

function parseUtm(raw) {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const utm = {};
  for (const key of TRACKED_UTM_PARAMS) {
    const value = sanitize(raw[key], UTM_MAX_LEN);
    if (value) {
      utm[key] = value;
    }
  }

  return utm;
}

function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function isValidName(name) {
  return /^[\p{L}\s'-]{2,100}$/u.test(name);
}

function isValidTelegramUsername(username) {
  return /^@?[A-Za-z0-9_]{5,32}$/.test(username);
}

function getRequestIp(event) {
  const forwarded = event.headers?.['X-Forwarded-For'] || event.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp || '';
}

function checkRateLimit(key, now = Date.now()) {
  if (!key) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateLimitBuckets.get(key) || []).filter(timestamp => timestamp > cutoff);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = Math.max(1000, recent[0] + RATE_LIMIT_WINDOW_MS - now);
    rateLimitBuckets.set(key, recent);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
  }

  recent.push(now);
  rateLimitBuckets.set(key, recent);

  if (rateLimitBuckets.size > 1000) {
    for (const [bucketKey, timestamps] of rateLimitBuckets) {
      if (timestamps.every(timestamp => timestamp <= cutoff)) {
        rateLimitBuckets.delete(bucketKey);
      }
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

function appendUtmLines(lines, utm) {
  if (Object.keys(utm).length === 0) {
    return;
  }

  lines.push('---', 'Маркировка:');
  for (const key of TRACKED_UTM_PARAMS) {
    const value = utm[key];
    if (value) {
      lines.push(`${UTM_LABELS[key]}: ${value}`);
    }
  }
}

function buildLeadMessage(payload) {
  const lines = [
    'Новая заявка (Косметология)',
    `Имя: ${payload.name}`,
    `Телефон: ${payload.phone}`,
    `Способ связи: ${payload.service}`,
  ];

  if (payload.telegram_username) {
    lines.push(`Телеграм: ${payload.telegram_username}`);
  }

  appendUtmLines(lines, payload.utm || {});

  return lines.join('\n');
}

function buildNewsletterMessage(payload) {
  const lines = ['Подписка на рассылку (Косметология)', `Телефон: ${payload.phone}`];
  appendUtmLines(lines, payload.utm || {});

  return lines.join('\n');
}

module.exports.handler = async event => {
  const allowedOrigins = parseAllowedOrigins();
  const origin = event.headers?.Origin || event.headers?.origin || '';
  const method = (event.httpMethod || 'GET').toUpperCase();

  if (!isAllowedOrigin(origin, allowedOrigins)) {
    return jsonResponse(403, { ok: false, error: 'origin_not_allowed' }, { Vary: 'Origin' });
  }

  const headers = corsHeaders(origin, allowedOrigins);

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: '',
    };
  }

  if (method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'method_not_allowed' }, headers);
  }

  const contentType = event.headers?.['Content-Type'] || event.headers?.['content-type'] || '';
  if (contentType && !contentType.toLowerCase().startsWith('application/json')) {
    return jsonResponse(415, { ok: false, error: 'unsupported_media_type' }, headers);
  }

  const rateLimit = checkRateLimit(getRequestIp(event));
  if (!rateLimit.allowed) {
    return jsonResponse(429, { ok: false, error: 'rate_limited' }, {
      ...headers,
      'Retry-After': String(rateLimit.retryAfterSeconds),
    });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return jsonResponse(500, { ok: false, error: 'server_misconfigured' }, headers);
  }

  let body;
  try {
    body = readBody(event);
  } catch (error) {
    if (error?.code === 'payload_too_large') {
      return jsonResponse(413, { ok: false, error: 'payload_too_large' }, headers);
    }
    return jsonResponse(400, { ok: false, error: 'invalid_json' }, headers);
  }

  if (sanitize(body.website, 64)) {
    return jsonResponse(200, { ok: true }, headers);
  }

  const utm = parseUtm(body.utm);
  const formType = sanitize(body.form_type, 32) || 'lead';
  if (!ALLOWED_FORM_TYPES.has(formType)) {
    return jsonResponse(400, { ok: false, error: 'validation_failed' }, headers);
  }
  let text;

  if (formType === 'newsletter') {
    const phone = sanitize(body.phone, 32);
    if (!phone || !isValidPhone(phone)) {
      return jsonResponse(400, { ok: false, error: 'validation_failed' }, headers);
    }
    text = buildNewsletterMessage({ phone, utm });
  } else {
    const payload = {
      name: sanitize(body.name),
      phone: sanitize(body.phone, 32),
      service: sanitize(body.service, 64),
      telegram_username: sanitize(body.telegram_username),
      utm,
    };

    if (
      !isValidName(payload.name) ||
      !isValidPhone(payload.phone) ||
      !ALLOWED_SERVICES.has(payload.service)
    ) {
      return jsonResponse(400, { ok: false, error: 'validation_failed' }, headers);
    }

    if (
      payload.service === 'Telegram' &&
      !isValidTelegramUsername(payload.telegram_username)
    ) {
      return jsonResponse(400, { ok: false, error: 'telegram_username_required' }, headers);
    }

    text = buildLeadMessage(payload);
  }

  let telegramResponse;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });
  } catch {
    return jsonResponse(502, { ok: false, error: 'telegram_unreachable' }, headers);
  }

  let telegramPayload = null;
  try {
    telegramPayload = await telegramResponse.json();
  } catch {
    telegramPayload = null;
  }

  if (!telegramResponse.ok || !telegramPayload?.ok) {
    return jsonResponse(502, { ok: false, error: 'telegram_error' }, headers);
  }

  return jsonResponse(200, { ok: true }, headers);
};

module.exports._resetRateLimitForTests = () => {
  rateLimitBuckets.clear();
};
