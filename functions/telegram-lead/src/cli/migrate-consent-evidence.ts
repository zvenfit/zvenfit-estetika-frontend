import { migrateConsentEvidenceSchema } from '../ydb/schema';

void migrateConsentEvidenceSchema()
  .then(() => {
    console.info('YDB consent evidence migration complete');
  })
  .catch((error: unknown) => {
    const code = error instanceof Error ? (error as Error & { code?: string }).code || error.name : 'unknown_error';
    console.error(`YDB consent evidence migration failed: ${code}`);
    process.exitCode = 1;
  });
