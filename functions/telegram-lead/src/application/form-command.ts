import type { Lead } from '../domain/lead';
import type { NewsletterOptIn } from '../domain/newsletter';

export type FormCommand =
  | { kind: 'lead'; lead: Lead }
  | { kind: 'newsletter'; optIn: NewsletterOptIn };
