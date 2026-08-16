import { createHash } from 'node:crypto';

import type { JsonObject } from '../types';

interface SafeErrorFieldOptions {
  fallbackCode: string;
  retriable?: boolean;
}

const RETRIABLE_CODE = /(abort|timeout|unavailable|overload|connection|econn|etimedout|rate_limit)/i;

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
}

function normalizeIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64);

  return normalized || fallback;
}

function upstreamStatus(error: unknown): number | null {
  const record = errorRecord(error);
  const cause = errorRecord(record?.cause);
  const candidate = record?.status ?? cause?.status;

  return Number.isInteger(candidate) && Number(candidate) >= 100 && Number(candidate) <= 599
    ? Number(candidate)
    : null;
}

function errorCode(error: unknown, fallback: string): string {
  const record = errorRecord(error);
  const cause = errorRecord(record?.cause);
  const namedError = error instanceof Error && error.name !== 'Error' ? error.name : undefined;

  return normalizeIdentifier(record?.code ?? cause?.code ?? namedError, fallback);
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UnknownError';
  }

  return normalizeIdentifier(error.name || error.constructor?.name, 'Error');
}

function stackFingerprint(error: unknown): string | null {
  if (!(error instanceof Error) || !error.stack) {
    return null;
  }

  const stackFrames = error.stack.split('\n').slice(1).join('\n') || error.name;

  return createHash('sha256').update(stackFrames).digest('hex').slice(0, 16);
}

function inferRetriable(error: unknown, status: number | null, code: string): boolean {
  const record = errorRecord(error);
  if (typeof record?.retriable === 'boolean') {
    return record.retriable;
  }

  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500) ||
    RETRIABLE_CODE.test(code)
  );
}

export function safeErrorFields(error: unknown, options: SafeErrorFieldOptions): JsonObject {
  const code = errorCode(error, options.fallbackCode);
  const status = upstreamStatus(error);

  return {
    error_type: errorType(error),
    error_code: code,
    retriable: options.retriable ?? inferRetriable(error, status, code),
    upstream_status: status,
    stack_fingerprint: stackFingerprint(error),
  };
}

export const _private = {
  errorCode,
  errorType,
  inferRetriable,
  normalizeIdentifier,
  stackFingerprint,
  upstreamStatus,
};
