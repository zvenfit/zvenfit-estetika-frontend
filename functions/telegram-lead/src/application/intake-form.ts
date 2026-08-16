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

  const { optInRequest } = command;
  const result = await dependencies.newsletterRepository.recordOptInRequest(
    optInRequest,
    {
      notificationId: optInRequest.requestId,
      kind: 'newsletter_subscription_requested',
      aggregateId: optInRequest.requestId,
      createdAt: optInRequest.occurredAt,
      phone: optInRequest.phone,
      utm: optInRequest.utm,
    },
    { logger },
  );

  return { ...result, requestId: optInRequest.requestId, kind: command.kind };
}
