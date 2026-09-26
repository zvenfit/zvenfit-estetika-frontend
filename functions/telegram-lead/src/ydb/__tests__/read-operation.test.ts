import assert from 'node:assert/strict';
import test from 'node:test';

import { runReadOnlyYdbOperation } from '../read-operation';
import { sdkTestDriver, waitForAbort } from './sdk-test-driver';
import { memoryLogger, recordByEvent } from '../../observability/__tests__/ydb-test-helpers';

for (const recover of [true, false]) {
  test(`real SDK read ${recover ? 'recovers after three session failures' : 'cancels'} alongside a domain/outbox transaction`, async context => {
    context.mock.method(Math, 'random', () => 0);
    let openWrite!: () => void;
    let finishWrite!: () => void;
    const writeOpened = new Promise<void>(resolve => { openWrite = resolve; });
    const writeGate = new Promise<void>(resolve => { finishWrite = resolve; });
    const writes: string[] = [];
    let creates = 0;
    const fixture = await sdkTestDriver(async (sql, signal) => {
      if (sql.includes('INSERT')) {
        openWrite();
        await writeGate;
        signal.throwIfAborted();
        writes.push(sql.includes('synthetic_domain') ? 'domain' : 'outbox');
      }
    }, 2, async signal => {
      creates += 1;
      if (creates === 1) return; // The independent write holds the first session.
      if (!recover) return waitForAbort(signal!);
      if (creates <= 4) throw Object.assign(new Error('private session details'), { name: 'ClientError', code: 4 });
    });
    const logger = memoryLogger();
    const writeController = new AbortController();
    const write = fixture.sql.begin({ signal: writeController.signal, idempotent: true }, async tx => {
      await tx`INSERT INTO synthetic_domain VALUES (1);`;
      await tx`INSERT INTO synthetic_outbox VALUES (1);`;
    });
    try {
      await writeOpened;
      const read = runReadOnlyYdbOperation('list_telegram_candidates', logger, async () => {},
        async signal => fixture.sql`SELECT 1;`.idempotent(true).signal(signal).timeout(10_000),
        recover ? 6_000 : 50,
      );
      if (recover) {
        assert.deepEqual(await read, []);
        assert.equal(creates, 5);
        const retry = recordByEvent(logger.records, 'ydb_retry');
        assert.equal(retry.retry_attempts, 3);
        assert.equal(retry.phase, 'session_create');
        assert.equal(logger.records.some(record => record.event === 'ydb_operation_failed'), false);
      } else {
        await assert.rejects(read, { code: 'ydb_read_budget_exhausted' });
        assert.equal(recordByEvent(logger.records, 'ydb_operation_failed').phase, 'session_create');
      }
      assert.equal(writeController.signal.aborted, false);
      finishWrite();
      await write;
      assert.deepEqual(writes, ['domain', 'outbox']);
      assert.equal(fixture.counts.committed, 1);
      assert.equal(fixture.counts.rolledBack, 0);
      // The committed transaction's session remains usable after read cancellation.
      await fixture.sql`SELECT 1;`.idempotent(true).timeout(1_000);
      assert.doesNotMatch(JSON.stringify(logger.records), /private|INSERT|synthetic_domain|synthetic_outbox/);
    } finally {
      finishWrite();
      await write.catch(() => {});
      await fixture.close();
    }
  });
}
