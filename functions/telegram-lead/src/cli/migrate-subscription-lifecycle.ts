import { migrateSubscriptionLifecycleSchema } from '../ydb/schema';

void migrateSubscriptionLifecycleSchema()
  .then(result => {
    console.info(
      `YDB subscription lifecycle migration complete: inserted=${result.inserted}, skipped_existing=${result.skippedExisting}, skipped_invalid=${result.skippedInvalid}, deduplicated=${result.deduplicated}`,
    );
  })
  .catch((error: unknown) => {
    const code =
      error instanceof Error ? (error as Error & { code?: string }).code || error.name : 'unknown_error';
    console.error(`YDB subscription lifecycle migration failed: ${code}`);
    process.exitCode = 1;
  });
