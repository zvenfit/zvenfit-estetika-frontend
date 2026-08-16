import type { Lead } from '../domain/lead';
import type {
  NewsletterOptIn,
  NewsletterSubscription,
  NewsletterUnsubscribe,
  SubscriptionMutationResult,
} from '../domain/newsletter';
import type {
  ClaimedTelegramNotification,
  LeadTelegramNotification,
  NewsletterTelegramNotification,
  TelegramNotificationStatus,
  TelegramQueueHealth,
} from '../domain/telegram-notification';
import type { LoggerLike } from '../types';

export interface IntakeResult {
  created: boolean;
  notificationStatus: TelegramNotificationStatus;
}

export interface LeadIntakeRepository {
  recordLead(
    lead: Lead,
    notification: LeadTelegramNotification,
    options?: { logger?: LoggerLike },
  ): Promise<IntakeResult>;
}

export interface NewsletterRepository {
  recordOptIn(
    optIn: NewsletterOptIn,
    notification: NewsletterTelegramNotification,
    options?: { logger?: LoggerLike },
  ): Promise<IntakeResult>;
  getSubscription(args: {
    phone: string;
    logger?: LoggerLike;
  }): Promise<NewsletterSubscription | null>;
  unsubscribe(args: NewsletterUnsubscribe & { logger?: LoggerLike }): Promise<SubscriptionMutationResult>;
  isSuppressed(args: { phone: string; logger?: LoggerLike }): Promise<boolean>;
}

export interface TelegramOutbox {
  claim(args: {
    notificationId: string;
    now: Date;
    leaseUntil: Date;
    deliveryToken: string;
    logger?: LoggerLike;
  }): Promise<ClaimedTelegramNotification | null>;
  markDelivered(args: {
    notificationId: string;
    deliveryToken: string;
    deliveredAt: Date;
    logger?: LoggerLike;
  }): Promise<void>;
  markFailed(args: {
    notificationId: string;
    deliveryToken: string;
    failedAt: Date;
    errorCode: string;
    terminal: boolean;
    logger?: LoggerLike;
  }): Promise<void>;
  listCandidates(args: { now: Date; limit: number; logger?: LoggerLike }): Promise<string[]>;
  getQueueHealth(args: { now: Date; logger?: LoggerLike }): Promise<TelegramQueueHealth>;
}

export interface NotificationDeliveryDependencies {
  outbox: TelegramOutbox;
  maxAttempts(): number;
  now(): Date;
  retryBatchSize(): number;
  reportDeliveryFailure(
    logger: LoggerLike,
    event: string,
    notificationId: string,
    error: unknown,
    options: { attempts: number; fallbackCode: string; retriable: boolean },
  ): void;
  telegramSender(notification: ClaimedTelegramNotification): Promise<void>;
  uuid(): string;
}
