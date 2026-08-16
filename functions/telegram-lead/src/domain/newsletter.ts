import type { RequestEvidence, Utm } from './shared';

export type NewsletterSubscriptionStatus = 'active' | 'unsubscribed';
export type NewsletterConsentEventType =
  | 'opt_in_requested'
  | 'opt_in_confirmed'
  | 'unsubscribe';

export interface NewsletterOptInRequest extends RequestEvidence {
  phone: string;
  phoneNormalized: string;
}

export interface NewsletterOptInConfirmation {
  eventId: string;
  requestEventId: string;
  occurredAt: Date;
  proofReference: string;
}

export interface NewsletterSubscription {
  phoneNormalized: string;
  phone: string;
  status: NewsletterSubscriptionStatus;
  firstSubscribedAt: Date;
  subscribedAt: Date;
  lastConfirmedAt: Date;
  unsubscribedAt: Date | null;
  updatedAt: Date;
  consentVersion: string;
  personalDataConsent: boolean;
  marketingConsent: boolean;
  lastConsentEventId: string;
  utm: Utm;
  unsubscribeReason: string;
}

export interface NewsletterUnsubscribe {
  eventId: string;
  phone: string;
  occurredAt: Date;
  reason: string;
}

export interface ConsentMutationResult {
  eventCreated: boolean;
  stateChanged: boolean;
}

export function canApplyConsentEvent(
  candidateAt: Date,
  currentUpdatedAt: Date,
  eventType: 'opt_in_confirmed' | 'unsubscribe',
): boolean {
  const difference = candidateAt.getTime() - currentUpdatedAt.getTime();

  return difference > 0 || (difference === 0 && eventType === 'unsubscribe');
}

export function normalizeSubscriberPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    digits = `7${digits}`;
  } else if (digits.length === 11 && digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  }
  if (digits.length < 11 || digits.length > 15) {
    throw new Error('invalid_subscription_phone');
  }

  return `+${digits}`;
}

export function persistedSubscriptionStatus(value: unknown): NewsletterSubscriptionStatus {
  return value === 'active' ? 'active' : 'unsubscribed';
}
