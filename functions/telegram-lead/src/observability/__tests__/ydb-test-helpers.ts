import assert from 'node:assert/strict';
import { tracingChannel } from 'node:diagnostics_channel';

import type { JsonObject, LoggerLike } from '../../types';

interface LogRecord extends JsonObject {
  level: string;
  event?: string;
  retry_attempts?: number;
  error_code?: string;
}

export type TestPhase = 'query.execute' | 'query.session.acquire' | 'query.session.create';

export function memoryLogger(): LoggerLike & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const write = (level: string) => (fields: JsonObject) => records.push({ level, ...fields });

  return {
    records,
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

export function recordByEvent(records: LogRecord[], event: string): LogRecord {
  const record = records.find(candidate => candidate.event === event);
  assert.ok(record);

  return record;
}

export function namedError(name: string, code?: string | number): Error {
  const error = new Error(`${name} details must not be logged`);
  error.name = name;

  return Object.assign(error, code === undefined ? {} : { code });
}

export async function tracePhase<T>(phase: TestPhase, callback: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await Promise.resolve(
    tracingChannel(`tracing:ydb:${phase}`).tracePromise(async () => {
      result = await callback();
    }, {}),
  );

  return result as T;
}
