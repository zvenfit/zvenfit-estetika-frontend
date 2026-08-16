import type { RequestEvidence } from './shared';

export type ContactMethod = 'Позвонить' | 'WhatsApp' | 'Макс' | 'Telegram';

export interface Lead extends RequestEvidence {
  name: string;
  phone: string;
  contactMethod: ContactMethod;
  telegramUsername: string;
}
