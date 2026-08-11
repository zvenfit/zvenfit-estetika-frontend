'use strict';

const DEFAULT_TABLE_NAME = 'submissions';
const DEFAULT_RETENTION_DAYS = 1096;

let sqlPromise = null;
let ydbValueTypes = null;
let driverInstance = null;
let queryClientInstance = null;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tableName() {
  const value = (process.env.YDB_SUBMISSIONS_TABLE || DEFAULT_TABLE_NAME).trim();

  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(value)) {
    throw new Error('invalid_ydb_table_name');
  }

  return value;
}

function normalizeConnectionString(value) {
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

async function createSqlClient() {
  const [{ Driver }, { query }, { MetadataCredentialsProvider }, { Timestamp, Uint32 }] =
    await Promise.all([
      import('@ydbjs/core'),
      import('@ydbjs/query'),
      import('@ydbjs/auth/metadata'),
      import('@ydbjs/value/primitive'),
    ]);
  const connectionString = normalizeConnectionString(process.env.YDB_CONNECTION_STRING);
  let credentialsProvider = new MetadataCredentialsProvider();

  if (process.env.YDB_ACCESS_TOKEN_CREDENTIALS) {
    const { EnvironCredentialsProvider } = await import('@ydbjs/auth/environ');
    credentialsProvider = new EnvironCredentialsProvider(connectionString);
  }

  const driver = new Driver(connectionString, { credentialsProvider });

  await driver.ready();
  driverInstance = driver;
  ydbValueTypes = { Timestamp, Uint32 };

  const sql = query(driver);
  queryClientInstance = sql;
  const submissionsTable = sql.identifier(tableName());

  await sql`
    CREATE TABLE IF NOT EXISTS ${submissionsTable} (
      submission_id Utf8 NOT NULL,
      form_type Utf8 NOT NULL,
      created_at Timestamp NOT NULL,
      expires_at Timestamp NOT NULL,
      name Utf8 NOT NULL,
      phone Utf8 NOT NULL,
      service Utf8 NOT NULL,
      telegram_username Utf8 NOT NULL,
      utm_json Utf8 NOT NULL,
      telegram_status Utf8 NOT NULL,
      telegram_attempts Uint32 NOT NULL,
      telegram_next_attempt_at Timestamp NOT NULL,
      telegram_lease_until Timestamp NOT NULL,
      telegram_delivery_token Utf8 NOT NULL,
      telegram_last_error Utf8 NOT NULL,
      telegram_notified_at Timestamp,
      PRIMARY KEY (submission_id)
    )
    WITH (
      TTL = Interval("PT0S") ON expires_at
    );
  `;

  return sql;
}

function getSql() {
  if (!sqlPromise) {
    sqlPromise = createSqlClient().catch(error => {
      sqlPromise = null;
      throw error;
    });
  }

  return sqlPromise;
}

function firstResultSet(resultSets) {
  return Array.isArray(resultSets?.[0]) ? resultSets[0] : [];
}

async function close() {
  await queryClientInstance?.[Symbol.asyncDispose]?.();
  driverInstance?.close();
  queryClientInstance = null;
  driverInstance = null;
  sqlPromise = null;
  ydbValueTypes = null;
}

function ydbTimestamp(value) {
  return new ydbValueTypes.Timestamp(value);
}

function ydbUint32(value) {
  return new ydbValueTypes.Uint32(value);
}

function retentionDays() {
  return parsePositiveInt(process.env.SUBMISSION_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
}

function expiresAt(createdAt) {
  return new Date(createdAt.getTime() + retentionDays() * 24 * 60 * 60 * 1000);
}

function rowToSubmission(row) {
  return {
    submissionId: row.submission_id,
    formType: row.form_type,
    createdAt: row.created_at,
    name: row.name,
    phone: row.phone,
    service: row.service,
    telegramUsername: row.telegram_username,
    utm: JSON.parse(row.utm_json || '{}'),
    telegramAttempts: Number(row.telegram_attempts || 0),
  };
}

function toEpoch(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

async function saveSubmission(submission) {
  const sql = await getSql();
  const submissionsTable = sql.identifier(tableName());

  return sql.begin({ idempotent: true }, async tx => {
    const existing = firstResultSet(
      await tx`
        SELECT telegram_status
        FROM ${submissionsTable}
        WHERE submission_id = ${submission.submissionId};
      `,
    );

    if (existing.length > 0) {
      return { created: false, telegramStatus: existing[0].telegram_status };
    }

    const createdAtValue = ydbTimestamp(submission.createdAt);

    await tx`
      INSERT INTO ${submissionsTable} (
        submission_id,
        form_type,
        created_at,
        expires_at,
        name,
        phone,
        service,
        telegram_username,
        utm_json,
        telegram_status,
        telegram_attempts,
        telegram_next_attempt_at,
        telegram_lease_until,
        telegram_delivery_token,
        telegram_last_error
      )
      VALUES (
        ${submission.submissionId},
        ${submission.formType},
        ${createdAtValue},
        ${ydbTimestamp(expiresAt(submission.createdAt))},
        ${submission.name},
        ${submission.phone},
        ${submission.service},
        ${submission.telegramUsername},
        ${JSON.stringify(submission.utm || {})},
        ${'pending'},
        ${ydbUint32(0)},
        ${createdAtValue},
        ${createdAtValue},
        ${''},
        ${''}
      );
    `;

    return { created: true, telegramStatus: 'pending' };
  });
}

async function claimForTelegram({ submissionId, now, leaseUntil, deliveryToken }) {
  const sql = await getSql();
  const submissionsTable = sql.identifier(tableName());

  return sql.begin({ idempotent: true }, async tx => {
    const rows = firstResultSet(
      await tx`
        SELECT
          submission_id,
          form_type,
          created_at,
          name,
          phone,
          service,
          telegram_username,
          utm_json,
          telegram_status,
          telegram_attempts,
          telegram_next_attempt_at,
          telegram_lease_until
        FROM ${submissionsTable}
        WHERE submission_id = ${submissionId};
      `,
    );

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    const pendingAndDue =
      row.telegram_status === 'pending' &&
      toEpoch(row.telegram_next_attempt_at) <= now.getTime();
    const abandonedLease =
      row.telegram_status === 'sending' && toEpoch(row.telegram_lease_until) <= now.getTime();

    if (!pendingAndDue && !abandonedLease) {
      return null;
    }

    const attempts = Number(row.telegram_attempts || 0) + 1;

    await tx`
      UPDATE ${submissionsTable}
      SET
        telegram_status = ${'sending'},
        telegram_attempts = ${ydbUint32(attempts)},
        telegram_lease_until = ${ydbTimestamp(leaseUntil)},
        telegram_delivery_token = ${deliveryToken}
      WHERE submission_id = ${submissionId};
    `;

    return { ...rowToSubmission(row), telegramAttempts: attempts };
  });
}

async function markTelegramDelivered({ submissionId, deliveryToken, notifiedAt }) {
  const sql = await getSql();
  const submissionsTable = sql.identifier(tableName());

  await sql`
    UPDATE ${submissionsTable}
    SET
      telegram_status = ${'sent'},
      telegram_delivery_token = ${''},
      telegram_last_error = ${''},
      telegram_notified_at = ${ydbTimestamp(notifiedAt)}
    WHERE
      submission_id = ${submissionId}
      AND telegram_status = ${'sending'}
      AND telegram_delivery_token = ${deliveryToken};
  `.idempotent(true);
}

async function markTelegramFailed({ submissionId, deliveryToken, failedAt, errorCode, terminal }) {
  const sql = await getSql();
  const submissionsTable = sql.identifier(tableName());
  const status = terminal ? 'failed' : 'pending';

  await sql`
    UPDATE ${submissionsTable}
    SET
      telegram_status = ${status},
      telegram_next_attempt_at = ${ydbTimestamp(failedAt)},
      telegram_delivery_token = ${''},
      telegram_last_error = ${errorCode}
    WHERE
      submission_id = ${submissionId}
      AND telegram_status = ${'sending'}
      AND telegram_delivery_token = ${deliveryToken};
  `.idempotent(true);
}

async function listTelegramCandidates({ now, limit }) {
  const sql = await getSql();
  const submissionsTable = sql.identifier(tableName());
  const safeLimit = Math.min(Math.max(Number(limit) || 1, 1), 100);

  const rows = firstResultSet(
    await sql`
      SELECT submission_id
      FROM ${submissionsTable}
      WHERE
        (telegram_status = ${'pending'} AND telegram_next_attempt_at <= ${ydbTimestamp(now)})
        OR (telegram_status = ${'sending'} AND telegram_lease_until <= ${ydbTimestamp(now)})
      ORDER BY created_at
      LIMIT ${safeLimit};
    `.idempotent(true),
  );

  return rows.map(row => row.submission_id);
}

module.exports = {
  claimForTelegram,
  close,
  listTelegramCandidates,
  markTelegramDelivered,
  markTelegramFailed,
  saveSubmission,
  _private: {
    expiresAt,
    firstResultSet,
    normalizeConnectionString,
    parsePositiveInt,
    rowToSubmission,
    tableName,
    toEpoch,
  },
};
