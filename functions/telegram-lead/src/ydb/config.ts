const DEFAULT_TABLE_NAME = 'submissions';
const DEFAULT_RATE_LIMITS_TABLE_NAME = 'submission_rate_limits';
const DEFAULT_QUERY_TIMEOUT_MS = 5000;
const DEFAULT_SLOW_OPERATION_MS = 1000;
const DEFAULT_SESSION_POOL_SIZE = 5;

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateIdentifier(value: string, errorCode: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(errorCode);
  }

  return value;
}

export function tableName(): string {
  return validateIdentifier(
    (process.env.YDB_SUBMISSIONS_TABLE || DEFAULT_TABLE_NAME).trim(),
    'invalid_ydb_table_name',
  );
}

export function rateLimitsTableName(): string {
  return validateIdentifier(
    (process.env.YDB_RATE_LIMITS_TABLE || DEFAULT_RATE_LIMITS_TABLE_NAME).trim(),
    'invalid_ydb_rate_limits_table_name',
  );
}

export function dueIndexName(): string {
  return 'idx_telegram_due';
}

export function queueHealthIndexName(): string {
  return 'idx_telegram_status_created';
}

export function normalizeConnectionString(value: string | undefined): string {
  const connectionString = (value || '').trim();
  if (!connectionString) {
    throw new Error('ydb_connection_string_missing');
  }

  const parsed = new URL(connectionString);
  const database = parsed.searchParams.get('database');
  if (!database) {
    return connectionString;
  }

  const databasePath = database.startsWith('/') ? database : `/${database}`;

  return `${parsed.protocol}//${parsed.host}${databasePath}`;
}

export function queryTimeoutMs(): number {
  return parsePositiveInt(process.env.YDB_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS);
}

export function slowOperationMs(): number {
  return parsePositiveInt(process.env.YDB_SLOW_OPERATION_MS, DEFAULT_SLOW_OPERATION_MS);
}

export function sessionPoolSize(): number {
  return Math.min(parsePositiveInt(process.env.YDB_SESSION_POOL_SIZE, DEFAULT_SESSION_POOL_SIZE), 50);
}
