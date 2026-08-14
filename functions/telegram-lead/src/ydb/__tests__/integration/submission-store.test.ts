import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createYdbClient } from '../../client';
import { queryTimeoutMs, rateLimitsTableName } from '../../config';
import { consumeSubmissionRateLimit } from '../../rate-limit';
import { bootstrapSchema } from '../../schema';
import * as submissionStore from '../../submission-store';

import type { ClaimedSubmission, Submission, YdbSql } from '../../../types';

const TEST_CONNECTION_STRING = process.env.YDB_TEST_CONNECTION_STRING;

function submission(submissionId: string, createdAt: Date): Submission {
  return {
    submissionId,
    formType: 'newsletter',
    createdAt,
    name: '',
    phone: '+7 000 000-00-00',
    service: 'Рассылка',
    telegramUsername: '',
    utm: { utm_source: 'integration' },
    consents: { version: '2026-08-14-v2', personalData: true, marketing: true },
  };
}

async function dropTable(sql: YdbSql, name: string): Promise<void> {
  try {
    await sql`DROP TABLE ${sql.identifier(name)};`.timeout(queryTimeoutMs());
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!message.includes('NOT_FOUND')) {
      throw error;
    }
  }
}

test(
  'bootstrapped YDB schema, rate limit, idempotency, indexed queue, lease and delivery token work together',
  { skip: !TEST_CONNECTION_STRING },
  async () => {
    if (!TEST_CONNECTION_STRING) {
      return;
    }

    const previous = {
      connectionString: process.env.YDB_CONNECTION_STRING,
      table: process.env.YDB_SUBMISSIONS_TABLE,
      rateLimitsTable: process.env.YDB_RATE_LIMITS_TABLE,
      rateLimitSecret: process.env.LEAD_RATE_LIMIT_SECRET,
    };
    const table = `submissions_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const rateLimitsTable = `limits_it_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    process.env.YDB_CONNECTION_STRING = TEST_CONNECTION_STRING;
    process.env.YDB_SUBMISSIONS_TABLE = table;
    process.env.YDB_RATE_LIMITS_TABLE = rateLimitsTable;
    process.env.LEAD_RATE_LIMIT_SECRET = 'integration-test-secret-not-production-32';

    try {
      await bootstrapSchema();
      await bootstrapSchema();

      // Keep the fixture inside the active TTL window. A historical timestamp
      // makes YDB eligible to delete occupied slots while this test is running.
      const rateLimitNow = new Date();
      for (let round = 0; round < 5; round += 1) {
        const rateLimitResults = await Promise.all(
          Array.from({ length: 10 }, () =>
            consumeSubmissionRateLimit({
              sourceIp: `203.0.113.${10 + round}`,
              now: rateLimitNow,
            }),
          ),
        );
        assert.equal(rateLimitResults.filter(Boolean).length, 5);
        assert.equal(rateLimitResults.filter(result => !result).length, 5);
      }

      const now = new Date();
      const submissionId = randomUUID();
      const saved = await Promise.all([
        submissionStore.saveSubmission(submission(submissionId, now)),
        submissionStore.saveSubmission(submission(submissionId, now)),
      ]);
      assert.deepEqual(saved.map(result => result.created).sort(), [false, true]);
      const queueHealth = await submissionStore.getTelegramQueueHealth({
        now: new Date(now.getTime() + 5000),
      });
      assert.equal(queueHealth.pendingCount, 1);
      assert.equal(queueHealth.oldestPendingAgeSeconds, 5);
      assert.deepEqual(await submissionStore.listTelegramCandidates({ now, limit: 10 }), [submissionId]);

      const leaseUntil = new Date(now.getTime() + 60_000);
      const claims = await Promise.all([
        submissionStore.claimForTelegram({ submissionId, now, leaseUntil, deliveryToken: randomUUID() }),
        submissionStore.claimForTelegram({ submissionId, now, leaseUntil, deliveryToken: randomUUID() }),
      ]);
      const claimed = claims.filter((item): item is ClaimedSubmission => item !== null);
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]?.telegramAttempts, 1);
      assert.deepEqual(await submissionStore.listTelegramCandidates({ now, limit: 10 }), []);

      await submissionStore.markTelegramDelivered({
        submissionId,
        deliveryToken: 'wrong-token',
        notifiedAt: now,
      });
      const afterLease = new Date(leaseUntil.getTime() + 1000);
      assert.deepEqual(
        await submissionStore.listTelegramCandidates({ now: afterLease, limit: 10 }),
        [submissionId],
      );

      const secondToken = randomUUID();
      const reclaimed = await submissionStore.claimForTelegram({
        submissionId,
        now: afterLease,
        leaseUntil: new Date(afterLease.getTime() + 60_000),
        deliveryToken: secondToken,
      });
      assert.ok(reclaimed);
      assert.equal(reclaimed.telegramAttempts, 2);
      await submissionStore.markTelegramFailed({
        submissionId,
        deliveryToken: secondToken,
        failedAt: afterLease,
        errorCode: 'integration_terminal',
        terminal: true,
      });
      assert.deepEqual(
        await submissionStore.listTelegramCandidates({
          now: new Date(afterLease.getTime() + 120_000),
          limit: 10,
        }),
        [],
      );
      assert.deepEqual(await submissionStore.getTelegramQueueHealth({ now: afterLease }), {
        pendingCount: 0,
        oldestPendingAgeSeconds: 0,
      });
    } finally {
      await submissionStore.close();
      const client = await createYdbClient();
      await dropTable(client.sql, table);
      await dropTable(client.sql, rateLimitsTableName());
      await client.close();

      for (const [name, value] of Object.entries({
        YDB_CONNECTION_STRING: previous.connectionString,
        YDB_SUBMISSIONS_TABLE: previous.table,
        YDB_RATE_LIMITS_TABLE: previous.rateLimitsTable,
        LEAD_RATE_LIMIT_SECRET: previous.rateLimitSecret,
      })) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  },
);
