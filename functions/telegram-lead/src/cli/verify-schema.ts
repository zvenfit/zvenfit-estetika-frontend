import { verifySchema } from '../ydb/schema';

void verifySchema()
  .then(() => {
    console.info('YDB schema verification complete');
  })
  .catch((error: unknown) => {
    const code = error instanceof Error ? (error as Error & { code?: string }).code || error.name : 'unknown_error';
    console.error(`YDB schema verification failed: ${code}`);
    process.exitCode = 1;
  });
