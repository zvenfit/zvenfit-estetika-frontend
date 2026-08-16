import { leadsTableName, telegramOutboxTableName } from './config';
import { firstResultSet, getSql, observed, transactionOptions, ydbTimestamp } from './context';
import {
  enqueueNotificationInTransaction,
  notificationStatusInTransaction,
} from './telegram-outbox';

import type { IntakeResult, LeadIntakeRepository } from '../application/ports';
import type { Lead } from '../domain/lead';
import type { LeadTelegramNotification } from '../domain/telegram-notification';
import type { LoggerLike } from '../types';

export const leadRepository: LeadIntakeRepository = {
  async recordLead(
    lead: Lead,
    notification: LeadTelegramNotification,
    { logger }: { logger?: LoggerLike } = {},
  ): Promise<IntakeResult> {
    return observed('record_lead', logger, async () => {
      const sql = await getSql();
      const leadsTable = sql.identifier(leadsTableName());
      const outboxTable = sql.identifier(telegramOutboxTableName());

      return sql.begin(transactionOptions(), async transaction => {
        const existing = firstResultSet(
          await transaction`
            SELECT lead_id
            FROM ${leadsTable}
            WHERE lead_id = ${lead.requestId};
          `,
        );
        if (existing.length > 0) {
          return {
            created: false,
            notificationStatus: await notificationStatusInTransaction({
              transaction,
              outboxTable,
              notificationId: notification.notificationId,
            }),
          };
        }

        await transaction`
          INSERT INTO ${leadsTable} (
            lead_id,
            created_at,
            name,
            phone,
            contact_method,
            telegram_username,
            utm_json,
            consent_version,
            personal_data_consent,
            marketing_consent
          ) VALUES (
            ${lead.requestId},
            ${ydbTimestamp(lead.occurredAt)},
            ${lead.name},
            ${lead.phone},
            ${lead.contactMethod},
            ${lead.telegramUsername},
            ${JSON.stringify(lead.utm)},
            ${lead.consents.version},
            ${lead.consents.personalData},
            ${lead.consents.marketing}
          );
        `;
        await enqueueNotificationInTransaction({ transaction, outboxTable, notification });

        return { created: true, notificationStatus: 'pending' };
      });
    });
  },
};
