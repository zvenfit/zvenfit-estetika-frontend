'use strict';

// Cloud Function implementation; index.js is the public entrypoint only.

const { randomUUID } = require('node:crypto');

const submissionStore = require('./submission-store');

const MAX_FIELD_LEN = 256;
const UTM_MAX_LEN = 128;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const TELEGRAM_TIMEOUT_MS = 5000;
const TELEGRAM_LEASE_MS = 2 * 60 * 1000;
const RETRY_BATCH_SIZE = 25;
const DEFAULT_MAX_TELEGRAM_ATTEMPTS = 12;
const TIMER_EVENT_TYPE = 'yandex.cloud.events.serverless.triggers.TimerMessage';

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

function isValidSubmissionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function getRequestIp(event) {
  const trustedIp =
    event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp || '';
  if (trustedIp) {
    return trustedIp;
  }

  const forwarded = event.headers?.['X-Forwarded-For'] || event.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return '';
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

function buildMessage(submission) {
  const lines =
    submission.formType === 'newsletter'
      ? [
          'Подписка на рассылку (Косметология)',
          `ID: ${submission.submissionId}`,
          `Телефон: ${submission.phone}`,
        ]
      : [
          'Новая заявка (Косметология)',
          `ID: ${submission.submissionId}`,
          `Имя: ${submission.name}`,
          `Телефон: ${submission.phone}`,
          `Способ связи: ${submission.service}`,
        ];

  if (submission.telegramUsername) {
    lines.push(`Телеграм: ${submission.telegramUsername}`);
  }

  appendUtmLines(lines, submission.utm || {});

  return lines.join('\n');
}

function errorCode(error, fallback = 'internal_error') {
  if (error && typeof error.code === 'string') {
    return sanitize(error.code, 64) || fallback;
  }

  return fallback;
}

function logDeliveryFailure(event, submissionId, code, attempts) {
  console.error(
    JSON.stringify({
      event,
      submission_id: submissionId,
      error_code: code,
      attempts,
    }),
  );
}

function maxTelegramAttempts() {
  const value = Number.parseInt(process.env.MAX_TELEGRAM_ATTEMPTS, 10);

  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TELEGRAM_ATTEMPTS;
}

function nextRetryAt(now, attempts) {
  const delayMinutes = [1, 5, 15, 60, 6 * 60][Math.min(Math.max(attempts - 1, 0), 4)];

  return new Date(now.getTime() + delayMinutes * 60 * 1000);
}

function isTimerEvent(event) {
  return Array.isArray(event?.messages)
    ? event.messages.some(message => message?.event_metadata?.event_type === TIMER_EVENT_TYPE)
    : false;
}

async function sendTelegram(submission) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    const error = new Error('Telegram is not configured');
    error.code = 'telegram_misconfigured';
    throw error;
  }

  let telegramResponse;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      body: JSON.stringify({
        chat_id: chatId,
        text: buildMessage(submission),
      }),
    });
  } catch {
    const error = new Error('Telegram is unreachable');
    error.code = 'telegram_unreachable';
    throw error;
  }

  let telegramPayload = null;
  try {
    telegramPayload = await telegramResponse.json();
  } catch {
    telegramPayload = null;
  }

  if (!telegramResponse.ok || !telegramPayload?.ok) {
    const error = new Error('Telegram returned an error');
    error.code = 'telegram_error';
    throw error;
  }
}

async function deliverSubmission(submissionId, dependencies) {
  const now = dependencies.now();
  const deliveryToken = dependencies.uuid();
  const claimedSubmission = await dependencies.store.claimForTelegram({
    submissionId,
    now,
    leaseUntil: new Date(now.getTime() + TELEGRAM_LEASE_MS),
    deliveryToken,
  });

  if (!claimedSubmission) {
    return 'skipped';
  }

  try {
    await dependencies.telegramSender(claimedSubmission);
    await dependencies.store.markTelegramDelivered({
      submissionId,
      deliveryToken,
      notifiedAt: dependencies.now(),
    });

    return 'sent';
  } catch (error) {
    const code = errorCode(error, 'telegram_error');
    const terminal = claimedSubmission.telegramAttempts >= dependencies.maxAttempts();

    await dependencies.store.markTelegramFailed({
      submissionId,
      deliveryToken,
      failedAt: terminal
        ? dependencies.now()
        : nextRetryAt(dependencies.now(), claimedSubmission.telegramAttempts),
      errorCode: code,
      terminal,
    });
    logDeliveryFailure(
      terminal ? 'telegram_delivery_failed_permanently' : 'telegram_delivery_retry_scheduled',
      submissionId,
      code,
      claimedSubmission.telegramAttempts,
    );

    return terminal ? 'failed' : 'pending';
  }
}

async function retryPendingSubmissions(dependencies) {
  const submissionIds = await dependencies.store.listTelegramCandidates({
    now: dependencies.now(),
    limit: RETRY_BATCH_SIZE,
  });
  const summary = {
    processed: submissionIds.length,
    sent: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
  };

  for (const submissionId of submissionIds) {
    try {
      const result = await deliverSubmission(submissionId, dependencies);
      summary[result] += 1;
    } catch (error) {
      summary.pending += 1;
      logDeliveryFailure(
        'telegram_delivery_retry_error',
        submissionId,
        errorCode(error, 'storage_error'),
        0,
      );
    }
  }

  return summary;
}

function validateSubmission(body, dependencies) {
  const requestedId = sanitize(body.submission_id, 64);
  if (requestedId && !isValidSubmissionId(requestedId)) {
    return { error: 'invalid_submission_id' };
  }

  const formType = sanitize(body.form_type, 32) || 'lead';
  if (!ALLOWED_FORM_TYPES.has(formType)) {
    return { error: 'validation_failed' };
  }

  const submission = {
    submissionId: requestedId || dependencies.uuid(),
    formType,
    createdAt: dependencies.now(),
    name: sanitize(body.name),
    phone: sanitize(body.phone, 32),
    service: sanitize(body.service, 64),
    telegramUsername: sanitize(body.telegram_username),
    utm: parseUtm(body.utm),
  };

  if (!isValidPhone(submission.phone)) {
    return { error: 'validation_failed' };
  }

  if (formType === 'newsletter') {
    submission.name = '';
    submission.service = 'Рассылка';
    submission.telegramUsername = '';

    return { submission };
  }

  if (!isValidName(submission.name) || !ALLOWED_SERVICES.has(submission.service)) {
    return { error: 'validation_failed' };
  }

  if (
    submission.service === 'Telegram' &&
    !isValidTelegramUsername(submission.telegramUsername)
  ) {
    return { error: 'telegram_username_required' };
  }

  return { submission };
}

function createHandler(overrides = {}) {
  const dependencies = {
    maxAttempts: maxTelegramAttempts,
    now: () => new Date(),
    store: submissionStore,
    telegramSender: sendTelegram,
    uuid: randomUUID,
    ...overrides,
  };

  return async event => {
    if (isTimerEvent(event)) {
      return retryPendingSubmissions(dependencies);
    }

    const allowedOrigins = parseAllowedOrigins();
    const origin = event.headers?.Origin || event.headers?.origin || '';
    const method = (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();

    if (!isAllowedOrigin(origin, allowedOrigins)) {
      return jsonResponse(403, { ok: false, error: 'origin_not_allowed' }, { Vary: 'Origin' });
    }

    const headers = corsHeaders(origin, allowedOrigins);

    if (method === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
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
      return jsonResponse(
        429,
        { ok: false, error: 'rate_limited' },
        { ...headers, 'Retry-After': String(rateLimit.retryAfterSeconds) },
      );
    }

    let body;
    try {
      body = readBody(event);
    } catch (error) {
      const code = error?.code === 'payload_too_large' ? 'payload_too_large' : 'invalid_json';
      const statusCode = code === 'payload_too_large' ? 413 : 400;

      return jsonResponse(statusCode, { ok: false, error: code }, headers);
    }

    if (sanitize(body.website, 64)) {
      return jsonResponse(200, { ok: true }, headers);
    }

    const validated = validateSubmission(body, dependencies);
    if (validated.error) {
      return jsonResponse(400, { ok: false, error: validated.error }, headers);
    }

    const submission = validated.submission;
    let savedStatus = 'pending';
    try {
      const saved = await dependencies.store.saveSubmission(submission);
      savedStatus = saved.telegramStatus;

      if (saved.telegramStatus === 'sent') {
        return jsonResponse(
          200,
          { ok: true, submission_id: submission.submissionId, notification: 'sent' },
          headers,
        );
      }
    } catch (error) {
      logDeliveryFailure(
        'submission_storage_error',
        submission.submissionId,
        errorCode(error, 'storage_error'),
        0,
      );

      return jsonResponse(503, { ok: false, error: 'storage_unavailable' }, headers);
    }

    let notification = 'pending';
    try {
      notification = await deliverSubmission(submission.submissionId, dependencies);
      if (notification === 'skipped') {
        notification = savedStatus === 'failed' ? 'failed' : 'pending';
      }
    } catch (error) {
      logDeliveryFailure(
        'telegram_delivery_state_error',
        submission.submissionId,
        errorCode(error, 'storage_error'),
        0,
      );
    }

    return jsonResponse(
      200,
      { ok: true, submission_id: submission.submissionId, notification },
      headers,
    );
  };
}

module.exports.handler = createHandler();
module.exports._resetRateLimitForTests = () => rateLimitBuckets.clear();
module.exports._private = {
  buildMessage,
  checkRateLimit,
  createHandler,
  deliverSubmission,
  getRequestIp,
  isTimerEvent,
  nextRetryAt,
  parseUtm,
  retryPendingSubmissions,
  sanitize,
  validateSubmission,
};
