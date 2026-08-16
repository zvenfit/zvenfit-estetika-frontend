import type { Lead } from '../domain/lead';
import type { NewsletterOptInRequest } from '../domain/newsletter';

export type FormCommand =
  | { kind: 'lead'; lead: Lead }
  | { kind: 'newsletter'; optInRequest: NewsletterOptInRequest };
