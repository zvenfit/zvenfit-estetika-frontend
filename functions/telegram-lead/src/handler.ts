import { randomUUID } from 'node:crypto';

import {
  allowedOrigins,
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
  MAX_REQUEST_BODY_BYTES,
  readBody,
  requestBodyBytes,
} from './http';
import { createInvocationLogger } from './observability/logger';
import { createInvocationMetrics } from './observability/metrics';
import { createSubmission, hasHoneypotValue, validateSubmission } from './submission-payload';
import {
  logDeliveryFailure,
  maxTelegramAttempts,
  retryPendingSubmissions,
  sendTelegram,
  type RetrySummary,
} from './telegram/delivery';
import { consumeSubmissionRateLimit } from './ydb/rate-limit';
import * as submissionStore from './ydb/submission-store';

import type {
  FunctionContext,
  HandlerDependencies,
  HttpEvent,
  HttpResponse,
  JsonObject,
  LoggerLike,
} from './types';

const TIMER_EVENT_TYPE = 'yandex.cloud.events.serverless.triggers.TimerMessage';

type HandlerResult = HttpResponse | RetrySummary;
type CloudHandler = (event: HttpEvent, context?: FunctionContext) => Promise<HandlerResult>;

function isTimerEvent(event: HttpEvent): boolean {
  return Array.isArray(event.messages)
    ? event.messages.some(message => message.event_metadata?.event_type === TIMER_EVENT_TYPE)
    : false;
}

function logBlockedSubmission(logger: LoggerLike, reason: string): void {
  const event = 'submission_blocked';
  logger.warn?.({ event, reason }, event);
}

function createDependencies(overrides: Partial<HandlerDependencies>): HandlerDependencies {
  return {
    loggerFactory: createInvocationLogger,
    maxAttempts: maxTelegramAttempts,
    metricsFactory: createInvocationMetrics,
    now: () => new Date(),
    rateLimiter: consumeSubmissionRateLimit,
    store: submissionStore,
    telegramSender: sendTelegram,
    uuid: randomUUID,
    ...overrides,
  };
}

function requestIp(event: HttpEvent): string {
  return (
    event.requestContext?.identity?.sourceIp?.trim() ||
    event.requestContext?.http?.sourceIp?.trim() ||
    ''
  );
}

async function persistSubmission(
  body: JsonObject,
  dependencies: HandlerDependencies,
  logger: LoggerLike,
  headers: Record<string, string>,
  sourceIp: string,
): Promise<HttpResponse> {
  const submission = createSubmission(body, dependencies);
  const validationError = validateSubmission(submission);
  if (validationError || !submission) {
    return jsonResponse(400, { ok: false, error: validationError || 'validation_failed' }, headers);
  }

  if (sourceIp) {
    try {
      const allowed = await dependencies.rateLimiter({ sourceIp, now: dependencies.now(), logger });
      if (!allowed) {
        logBlockedSubmission(logger, 'rate_limit');

        return jsonResponse(429, { ok: false, error: 'rate_limit_exceeded' }, headers);
      }
    } catch {
      const event = 'submission_rate_limit_error';
      logger.error({ event, error_code: 'rate_limit_unavailable' }, event);
    }
  }

  try {
    const saved = await dependencies.store.saveSubmission(submission, { logger });
    if (saved.created) {
      const event = 'submission_persisted';
      logger.info?.({ event, form_type: submission.formType }, event);
    }
    if (saved.telegramStatus === 'sent') {
      return jsonResponse(
        200,
        { ok: true, submission_id: submission.submissionId, notification: 'sent' },
        headers,
      );
    }

    return jsonResponse(
      202,
      {
        ok: true,
        submission_id: submission.submissionId,
        notification: saved.telegramStatus,
      },
      headers,
    );
  } catch (error) {
    logDeliveryFailure(logger, 'submission_storage_error', submission.submissionId, error, {
      attempts: 0,
      fallbackCode: 'storage_error',
      retriable: true,
    });

    return jsonResponse(503, { ok: false, error: 'storage_unavailable' }, headers);
  }
}

function createHandler(overrides: Partial<HandlerDependencies> = {}): CloudHandler {
  const dependencies = createDependencies(overrides);

  return async (event, context) => {
    const baseLogger = dependencies.loggerFactory(context);
    const metrics = dependencies.metricsFactory(context, baseLogger);
    const logger = baseLogger;

    try {
      if (isTimerEvent(event)) {
        const retrySummary = await retryPendingSubmissions(dependencies, logger);
        const queueHealth = await dependencies.store.getTelegramQueueHealth({
          now: dependencies.now(),
          logger,
        });
        metrics.recordGauge(
          'zvenfit_estetika_telegram_pending_submissions',
          queueHealth.pendingCount,
        );
        metrics.recordGauge(
          'zvenfit_estetika_telegram_oldest_pending_age_seconds',
          queueHealth.oldestPendingAgeSeconds,
        );
        metrics.recordGauge('zvenfit_estetika_retry_worker_heartbeat', 1);
        const heartbeatEvent = 'retry_worker_completed';
        logger.info?.(
          {
            event: heartbeatEvent,
            ...retrySummary,
            queue_pending: queueHealth.pendingCount,
            oldest_pending_age_seconds: queueHealth.oldestPendingAgeSeconds,
          },
          heartbeatEvent,
        );

        return retrySummary;
      }

      const origins = allowedOrigins();
      const origin = event.headers?.Origin || event.headers?.origin || '';
      if (!isAllowedOrigin(origin, origins)) {
        logBlockedSubmission(logger, 'origin');

        return jsonResponse(403, { ok: false, error: 'origin_not_allowed' }, { Vary: 'Origin' });
      }

      const headers = corsHeaders(origin);
      const method = (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
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
      if (requestBodyBytes(event) > MAX_REQUEST_BODY_BYTES) {
        logBlockedSubmission(logger, 'payload_too_large');

        return jsonResponse(413, { ok: false, error: 'payload_too_large' }, headers);
      }

      let body: JsonObject;
      try {
        body = readBody(event);
      } catch {
        return jsonResponse(400, { ok: false, error: 'invalid_json' }, headers);
      }
      if (hasHoneypotValue(body)) {
        logBlockedSubmission(logger, 'honeypot');

        return jsonResponse(200, { ok: true }, headers);
      }

      return persistSubmission(body, dependencies, logger, headers, requestIp(event));
    } finally {
      await metrics.flush();
    }
  };
}

export const handler = createHandler();
export const _private = { createHandler, isTimerEvent, requestBodyBytes, requestIp };
