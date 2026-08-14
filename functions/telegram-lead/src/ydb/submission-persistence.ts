import { tableName } from './config';
import {
  firstResultSet,
  getSql,
  observed,
  telegramStatus,
  transactionOptions,
  ydbTimestamp,
  ydbUint32,
} from './context';

import type { LoggerLike, Submission, TelegramStatus } from '../types';

export async function saveSubmission(
  submission: Submission,
  { logger }: { logger?: LoggerLike } = {},
): Promise<{ created: boolean; telegramStatus: TelegramStatus }> {
  return observed('save_submission', logger, async () => {
    const sql = await getSql();
    const submissionsTable = sql.identifier(tableName());

    return sql.begin(transactionOptions(), async transaction => {
      const existing = firstResultSet(
        await transaction`
          SELECT telegram_status
          FROM ${submissionsTable}
          WHERE submission_id = ${submission.submissionId};
        `,
      );
      if (existing.length > 0) {
        return { created: false, telegramStatus: telegramStatus(existing[0]?.telegram_status) };
      }

      const createdAt = ydbTimestamp(submission.createdAt);
      await transaction`
        INSERT INTO ${submissionsTable} (
          submission_id,
          form_type,
          created_at,
          name,
          phone,
          service,
          telegram_username,
          utm_json,
          consent_json,
          telegram_status,
          telegram_attempts,
          telegram_due_at
        )
        VALUES (
          ${submission.submissionId},
          ${submission.formType},
          ${createdAt},
          ${submission.name},
          ${submission.phone},
          ${submission.service},
          ${submission.telegramUsername},
          ${JSON.stringify(submission.utm)},
          ${JSON.stringify({
            version: submission.consents.version,
            personal_data: submission.consents.personalData,
            marketing: submission.consents.marketing,
          })},
          ${'pending'},
          ${ydbUint32(0)},
          ${createdAt}
        );
      `;

      return { created: true, telegramStatus: 'pending' };
    });
  });
}
