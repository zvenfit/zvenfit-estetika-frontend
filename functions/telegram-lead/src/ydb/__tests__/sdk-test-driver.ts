import { channel } from 'node:diagnostics_channel';

export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// Exercise the installed SDK's query/session/transaction lifecycle without a database.
export async function sdkTestDriver(
  execute: (text: string, signal: AbortSignal) => Promise<void>,
  maxSize = 1,
  createSession: (signal?: AbortSignal) => Promise<void> = async () => {},
) {
  const { query } = await import('@ydbjs/query');
  const success = 400000;
  const counts = { created: 0, acquired: 0, released: 0, committed: 0, rolledBack: 0 };
  const driver = {
    identity: {},
    async ready() {},
    createClient() {
      return {
        async createSession(_request: unknown, options?: { signal?: AbortSignal }) {
          await createSession(options?.signal);
          return { status: success, sessionId: `synthetic-${++counts.created}`, nodeId: 1 };
        },
        async *attachSession(_request: unknown, { signal }: { signal: AbortSignal }) {
          yield { status: success };
          await waitForAbort(signal);
        },
        async *executeQuery(
          request: { query: { value: { text: string } } },
          { signal }: { signal: AbortSignal },
        ) {
          await execute(request.query.value.text, signal);
          yield { status: success };
        },
        async beginTransaction() {
          return { status: success, txMeta: { id: 'synthetic-transaction' } };
        },
        async commitTransaction(_request: unknown, { signal }: { signal: AbortSignal }) {
          signal.throwIfAborted();
          counts.committed += 1;
          return { status: success };
        },
        async rollbackTransaction() {
          counts.rolledBack += 1;
          return { status: success };
        },
        async deleteSession() { return { status: success }; },
      };
    },
  };
  const acquired = channel('ydb:query.session.acquired');
  const released = channel('ydb:query.session.released');
  const belongsToDriver = (event: unknown) =>
    typeof event === 'object' && event !== null && 'driver' in event && event.driver === driver.identity;
  const onAcquire = (event: unknown) => { if (belongsToDriver(event)) counts.acquired += 1; };
  const onRelease = (event: unknown) => { if (belongsToDriver(event)) counts.released += 1; };
  acquired.subscribe(onAcquire);
  released.subscribe(onRelease);
  const sql = query(driver as unknown as Parameters<typeof query>[0], { poolOptions: { maxSize } });
  return {
    sql,
    counts,
    async close() {
      try {
        await sql[Symbol.asyncDispose]();
      } finally {
        acquired.unsubscribe(onAcquire);
        released.unsubscribe(onRelease);
      }
    },
  };
}
