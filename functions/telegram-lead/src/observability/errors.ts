import { createHash } from 'node:crypto';

import type { JsonObject } from '../types';

interface SafeErrorFieldOptions {
  fallbackCode: string;
  retriable?: boolean;
}

const RETRIABLE_CODE =
  /(abort|deadline_exceeded|timeout|unavailable|resource_exhausted|overload|connection|econn|etimedout|eai_again|rate_limit|internal)/i;
const SAFE_MESSAGE_CODES = [
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'ABORTED',
  'INTERNAL',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
] as const;
const GRPC_CODE_NAMES = new Map<number, string>([
  [4, 'DEADLINE_EXCEEDED'],
  [8, 'RESOURCE_EXHAUSTED'],
  [10, 'ABORTED'],
  [13, 'INTERNAL'],
  [14, 'UNAVAILABLE'],
]);
const GENERIC_ERROR_NAMES = new Set(['ClientError', 'TransportError']);

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current) && chain.length < 4) {
    chain.push(current);
    visited.add(current);
    current = errorRecord(current)?.cause;
  }

  return chain;
}

function allowlistedMessageCode(error: unknown): string | undefined {
  for (const item of errorChain(error)) {
    const record = errorRecord(item);
    const description = [
      record?.name,
      item instanceof Error ? item.constructor?.name : undefined,
      record?.details,
      record?.message,
    ]
      .filter(value => typeof value === 'string')
      .join(' ');

    const match = SAFE_MESSAGE_CODES.find(code =>
      new RegExp(`(?:^|[^A-Z0-9_])${code}(?:$|[^A-Z0-9_])`, 'i').test(description),
    );
    if (match) {
      return match;
    }
  }

  return undefined;
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
  const chain = errorChain(error);
  const explicitCode = chain
    .map(item => errorRecord(item)?.code)
    .find(value => typeof value === 'string' && value.trim());
  const numericCode = chain
    .map(item => errorRecord(item)?.code)
    .find(value => typeof value === 'number' && GRPC_CODE_NAMES.has(value));
  const namedError = error instanceof Error && error.name !== 'Error' ? error.name : undefined;
  const specificNamedError =
    namedError && !GENERIC_ERROR_NAMES.has(namedError) ? namedError : undefined;

  return normalizeIdentifier(
    explicitCode ??
      (typeof numericCode === 'number' ? GRPC_CODE_NAMES.get(numericCode) : undefined) ??
      specificNamedError ??
      allowlistedMessageCode(error) ??
      namedError,
    fallback,
  );
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
  allowlistedMessageCode,
  errorChain,
  errorCode,
  errorType,
  inferRetriable,
  normalizeIdentifier,
  stackFingerprint,
  upstreamStatus,
};
