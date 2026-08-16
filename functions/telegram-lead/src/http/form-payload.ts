import type { FormCommand } from '../application/form-command';
import type { ContactMethod } from '../domain/lead';
import { normalizeSubscriberPhone } from '../domain/newsletter';
import { TRACKED_UTM_PARAMS, type ConsentEvidence, type FormKind, type Utm } from '../domain/shared';
import type { JsonObject } from '../types';

const MAX_FIELD_LENGTH = 256;
const UTM_MAX_LENGTH = 128;
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORM_KINDS = new Set<FormKind>(['lead', 'newsletter']);
const CONTACT_METHODS = new Set<ContactMethod>(['Позвонить', 'WhatsApp', 'Макс', 'Telegram']);
export const CONSENT_VERSION = '2026-08-14-v2';

export type FormCommandResult =
  | { command: FormCommand; error: null }
  | { command: null; error: string };

export function sanitizeText(value: unknown, maxLength = MAX_FIELD_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function parseUtm(raw: unknown): Utm {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const input = raw as JsonObject;
  const utm: Utm = {};
  for (const key of TRACKED_UTM_PARAMS) {
    const value = sanitizeText(input[key], UTM_MAX_LENGTH);
    if (value) {
      utm[key] = value;
    }
  }

  return utm;
}

function parseConsents(raw: unknown): ConsentEvidence {
  const input = raw && typeof raw === 'object' ? (raw as JsonObject) : {};

  return {
    version: sanitizeText(input.version, 32),
    personalData: input.personal_data === true,
    marketing: input.marketing === true,
  };
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');

  return digits.length >= 10 && digits.length <= 15;
}

function isValidName(name: string): boolean {
  return /^[\p{L}\s'-]{2,100}$/u.test(name);
}

function isValidTelegramUsername(username: string): boolean {
  return /^@?[A-Za-z0-9_]{5,32}$/.test(username);
}

export function parseFormCommand(
  body: JsonObject,
  dependencies: { now(): Date; uuid(): string },
): FormCommandResult {
  const kind = sanitizeText(body.form_type, 32) || 'lead';
  if (!FORM_KINDS.has(kind as FormKind)) {
    return { command: null, error: 'validation_failed' };
  }

  const requestId = sanitizeText(body.submission_id, 64) || dependencies.uuid();
  const phone = sanitizeText(body.phone, 32);
  const consents = parseConsents(body.consents);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    return { command: null, error: 'invalid_submission_id' };
  }
  if (!isValidPhone(phone)) {
    return { command: null, error: 'validation_failed' };
  }
  if (!consents.personalData || consents.version !== CONSENT_VERSION) {
    return { command: null, error: 'personal_data_consent_required' };
  }

  const occurredAt = dependencies.now();
  const evidence = { requestId, occurredAt, utm: parseUtm(body.utm), consents };
  if (kind === 'newsletter') {
    if (!consents.marketing) {
      return { command: null, error: 'marketing_consent_required' };
    }

    return {
      command: {
        kind: 'newsletter',
        optIn: { ...evidence, phone, phoneNormalized: normalizeSubscriberPhone(phone) },
      },
      error: null,
    };
  }

  const name = sanitizeText(body.name);
  const contactMethod = sanitizeText(body.service, 64) as ContactMethod;
  const telegramUsername = sanitizeText(body.telegram_username);
  if (!isValidName(name) || !CONTACT_METHODS.has(contactMethod)) {
    return { command: null, error: 'validation_failed' };
  }
  if (contactMethod === 'Telegram' && !isValidTelegramUsername(telegramUsername)) {
    return { command: null, error: 'telegram_username_required' };
  }

  return {
    command: {
      kind: 'lead',
      lead: { ...evidence, name, phone, contactMethod, telegramUsername },
    },
    error: null,
  };
}

export function hasHoneypotValue(body: JsonObject): boolean {
  const value = body.website;

  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

export const _private = { parseConsents, parseUtm };
