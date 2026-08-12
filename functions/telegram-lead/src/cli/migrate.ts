import { runMigrations } from '../ydb/migrations';

void runMigrations()
  .then(completed => {
    console.info(`YDB migrations complete; applied: ${completed.join(', ') || 'none'}`);
  })
  .catch((error: unknown) => {
    const code = error instanceof Error ? (error as Error & { code?: string }).code || error.name : 'unknown_error';
    console.error(`YDB migrations failed: ${code}`);
    process.exitCode = 1;
  });
