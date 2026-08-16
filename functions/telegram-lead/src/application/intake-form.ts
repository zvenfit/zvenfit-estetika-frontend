import type { LoggerLike } from '../types';
import type { FormCommand } from './form-command';
import type { IntakeResult, LeadIntakeRepository, NewsletterRepository } from './ports';

export interface FormIntakeResult extends IntakeResult {
  requestId: string;
  kind: FormCommand['kind'];
}

export async function intakeForm(
  command: FormCommand,
  dependencies: {
    leadRepository: LeadIntakeRepository;
    newsletterRepository: NewsletterRepository;
  },
  logger?: LoggerLike,
): Promise<FormIntakeResult> {
  if (command.kind === 'lead') {
    const { lead } = command;
    const result = await dependencies.leadRepository.recordLead(
      lead,
      {
        notificationId: lead.requestId,
        kind: 'lead_created',
        aggregateId: lead.requestId,
        createdAt: lead.occurredAt,
        name: lead.name,
        phone: lead.phone,
        contactMethod: lead.contactMethod,
        telegramUsername: lead.telegramUsername,
        utm: lead.utm,
      },
      { logger },
    );

    return { ...result, requestId: lead.requestId, kind: command.kind };
  }

  const { optIn } = command;
  const result = await dependencies.newsletterRepository.recordOptIn(
    optIn,
    {
      notificationId: optIn.requestId,
      kind: 'newsletter_opted_in',
      aggregateId: optIn.phoneNormalized,
      createdAt: optIn.occurredAt,
      phone: optIn.phone,
      utm: optIn.utm,
    },
    { logger },
  );

  return { ...result, requestId: optIn.requestId, kind: command.kind };
}
