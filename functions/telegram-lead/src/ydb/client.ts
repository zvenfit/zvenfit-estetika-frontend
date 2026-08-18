import { normalizeConnectionString, queryTimeoutMs, sessionPoolSize } from './config';

import type { YdbClient, YdbSql, YdbValueConstructor } from '../types';
import type { CredentialsProvider } from '@ydbjs/auth' with { 'resolution-mode': 'import' };

interface ReadyDriver {
  close(): void;
  ready(signal: AbortSignal): Promise<void>;
}

interface DriverInitializationOptions {
  attempts?: number;
  delay?: (attempt: number) => Promise<void>;
}

const DEFAULT_INITIALIZATION_ATTEMPTS = 2;
const INITIALIZATION_RETRY_DELAY_MS = 100;
const TRANSIENT_GRPC_CODES = new Set([4, 8, 10, 13, 14]);
const TRANSIENT_ERROR_PATTERN =
  /ABORTED|DEADLINE_EXCEEDED|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|INTERNAL|RESOURCE_EXHAUSTED|TIMEOUT|UNAVAILABLE/i;

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;

  while (current && typeof current === 'object' && !visited.has(current) && chain.length < 4) {
    chain.push(current);
    visited.add(current);
    current = (current as Record<string, unknown>).cause;
  }

  return chain;
}

function isTransientInitializationError(error: unknown): boolean {
  return errorChain(error).some(item => {
    const record = item as Record<string, unknown>;
    if (typeof record.code === 'number' && TRANSIENT_GRPC_CODES.has(record.code)) {
      return true;
    }

    const description = [record.name, record.code, record.message, record.details]
      .filter(value => typeof value === 'string')
      .join(' ');

    return TRANSIENT_ERROR_PATTERN.test(description);
  });
}

function retryDelay(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, INITIALIZATION_RETRY_DELAY_MS * attempt));
}

async function initializeDriver<T extends ReadyDriver>(
  createDriver: () => T,
  timeoutMs: number,
  options: DriverInitializationOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_INITIALIZATION_ATTEMPTS);
  const delay = options.delay ?? retryDelay;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const driver = createDriver();

    try {
      await driver.ready(AbortSignal.timeout(timeoutMs));

      return driver;
    } catch (error) {
      driver.close();

      if (attempt === attempts || !isTransientInitializationError(error)) {
        throw error;
      }

      await delay(attempt);
    }
  }

  throw new Error('ydb_driver_initialization_failed');
}

export async function createYdbClient(): Promise<YdbClient> {
  const [{ Driver }, { query }, { MetadataCredentialsProvider }, { Timestamp, Uint32 }] =
    await Promise.all([
      import('@ydbjs/core'),
      import('@ydbjs/query'),
      import('@ydbjs/auth/metadata'),
      import('@ydbjs/value/primitive'),
    ]);
  const connectionString = normalizeConnectionString(process.env.YDB_CONNECTION_STRING);
  let credentialsProvider: CredentialsProvider = new MetadataCredentialsProvider();

  if (process.env.YDB_ACCESS_TOKEN_CREDENTIALS) {
    const { EnvironCredentialsProvider } = await import('@ydbjs/auth/environ');
    credentialsProvider = new EnvironCredentialsProvider(connectionString);
  }

  const driver = await initializeDriver(
    () => new Driver(connectionString, { credentialsProvider }),
    queryTimeoutMs(),
  );

  const sql = query(driver, {
    poolOptions: { maxSize: sessionPoolSize() },
  }) as unknown as YdbSql;

  return {
    driver,
    sql,
    types: {
      Timestamp: Timestamp as unknown as YdbValueConstructor<Date>,
      Uint32: Uint32 as unknown as YdbValueConstructor<number>,
    },
    async close() {
      await sql[Symbol.asyncDispose]?.();
      driver.close();
    },
  };
}

export const _private = { errorChain, initializeDriver, isTransientInitializationError };
