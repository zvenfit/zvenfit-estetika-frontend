import type { Utm } from './shared';

export type TelegramNotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type TelegramNotificationKind = 'lead_created' | 'newsletter_opted_in';

interface TelegramNotificationBase {
  notificationId: string;
  kind: TelegramNotificationKind;
  aggregateId: string;
  createdAt: Date;
  phone: string;
  utm: Utm;
}

export interface LeadTelegramNotification extends TelegramNotificationBase {
  kind: 'lead_created';
  name: string;
  contactMethod: string;
  telegramUsername: string;
}

export interface NewsletterTelegramNotification extends TelegramNotificationBase {
  kind: 'newsletter_opted_in';
}

export type TelegramNotification =
  | LeadTelegramNotification
  | NewsletterTelegramNotification;

export type ClaimedTelegramNotification = TelegramNotification & { attempts: number };

export interface TelegramQueueHealth {
  pendingCount: number;
  oldestPendingAgeSeconds: number;
}

export function persistedTelegramStatus(value: unknown): TelegramNotificationStatus {
  return value === 'sending' || value === 'sent' || value === 'failed' ? value : 'pending';
}
