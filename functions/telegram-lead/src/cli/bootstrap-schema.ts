import { bootstrapSchema } from '../ydb/schema';

void bootstrapSchema()
  .then(() => {
    console.info('YDB schema bootstrap complete');
  })
  .catch((error: unknown) => {
    const code = error instanceof Error ? (error as Error & { code?: string }).code || error.name : 'unknown_error';
    console.error(`YDB schema bootstrap failed: ${code}`);
    process.exitCode = 1;
  });
