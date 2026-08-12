import { normalizeConnectionString, queryTimeoutMs, sessionPoolSize } from './config';

import type { YdbClient, YdbSql, YdbValueConstructor } from '../types';
import type { CredentialsProvider } from '@ydbjs/auth' with { 'resolution-mode': 'import' };

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

  const driver = new Driver(connectionString, { credentialsProvider });
  await driver.ready(AbortSignal.timeout(queryTimeoutMs()));

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
