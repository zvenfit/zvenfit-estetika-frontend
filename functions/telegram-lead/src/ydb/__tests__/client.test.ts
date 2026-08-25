import assert from 'node:assert/strict';
import test from 'node:test';

import { _private } from '../client';
import { initializationAttempts } from '../initialization-attempts';

interface FakeDriver {
  close(): void;
  ready(signal: AbortSignal): Promise<void>;
}

function transientError(): Error & { code: string } {
  return Object.assign(
    new Error('/Ydb.Discovery.V1.DiscoveryService/ListEndpoints DEADLINE_EXCEEDED'),
    { code: 'DEADLINE_EXCEEDED' },
  );
}

test('recreates the YDB driver after a transient discovery failure', async () => {
  let created = 0;
  let closed = 0;
  const delays: number[] = [];
  const recoveredDriver: FakeDriver = {
    close() {
      closed += 1;
    },
    async ready() {},
  };

  const result = await _private.initializeDriver(
    () => {
      created += 1;

      if (created === 1) {
        return {
          close() {
            closed += 1;
          },
          async ready() {
            throw transientError();
          },
        };
      }

      return recoveredDriver;
    },
    5_000,
    {
      delay: async attempt => {
        delays.push(attempt);
      },
    },
  );

  assert.equal(result, recoveredDriver);
  assert.equal(created, 2);
  assert.equal(closed, 1);
  assert.deepEqual(delays, [1]);
});

test('recovers on the third YDB driver initialization attempt', async () => {
  let created = 0;
  let closed = 0;
  const delays: number[] = [];
  const recoveredDriver: FakeDriver = {
    close() {
      closed += 1;
    },
    async ready() {},
  };

  const result = await _private.initializeDriver(
    () => {
      created += 1;

      if (created < 3) {
        return {
          close() {
            closed += 1;
          },
          async ready() {
            throw transientError();
          },
        };
      }

      return recoveredDriver;
    },
    5_000,
    {
      delay: async attempt => {
        delays.push(attempt);
      },
    },
  );

  assert.equal(result, recoveredDriver);
  assert.equal(created, 3);
  assert.equal(closed, 2);
  assert.deepEqual(delays, [1, 2]);
});

test('backs off exponentially between YDB driver initialization attempts', () => {
  assert.deepEqual([1, 2].map(_private.initializationRetryDelayMs), [250, 500]);
});

test('does not retry a permanent YDB initialization failure', async () => {
  let created = 0;
  let closed = 0;
  const error = Object.assign(new Error('Permission denied'), { code: 'PERMISSION_DENIED' });

  await assert.rejects(async () => {
    try {
      await _private.initializeDriver(
        () => {
          created += 1;

          return {
            close() {
              closed += 1;
            },
            async ready() {
              throw error;
            },
          };
        },
        5_000,
        { delay: async () => assert.fail('permanent failures must not be retried') },
      );
    } catch (caught) {
      assert.equal(initializationAttempts(caught), 1);
      throw caught;
    }
  }, error);

  assert.equal(created, 1);
  assert.equal(closed, 1);
});

test('stops after two retries when YDB discovery remains unavailable', async () => {
  let created = 0;
  let closed = 0;

  await assert.rejects(
    async () => {
      try {
        await _private.initializeDriver(
          () => {
            created += 1;

            return {
              close() {
                closed += 1;
              },
              async ready() {
                throw transientError();
              },
            };
          },
          5_000,
          { delay: async () => {} },
        );
      } catch (error) {
        assert.equal(initializationAttempts(error), 3);
        throw error;
      }
    },
    { code: 'DEADLINE_EXCEEDED' },
  );

  assert.equal(created, 3);
  assert.equal(closed, 3);
});

test('recognizes transient gRPC codes in nested causes', () => {
  assert.equal(
    _private.isTransientInitializationError(
      Object.assign(new Error('driver init failed'), {
        cause: Object.assign(new Error('transport failed'), { code: 14 }),
      }),
    ),
    true,
  );
  assert.equal(
    _private.isTransientInitializationError(
      Object.assign(new Error('invalid database'), { code: 3 }),
    ),
    false,
  );
});
