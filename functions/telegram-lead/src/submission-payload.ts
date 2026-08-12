import type {
  FormType,
  HandlerDependencies,
  JsonObject,
  Submission,
  Utm,
  UtmKey,
} from './types';

const MAX_FIELD_LEN = 256;
const UTM_MAX_LEN = 128;
const SUBMISSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORM_TYPES = new Set<FormType>(['lead', 'newsletter']);
const SERVICES = new Set(['Позвонить', 'WhatsApp', 'Макс', 'Telegram']);

export const TRACKED_UTM_PARAMS: readonly UtmKey[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'yclid',
  'gclid',
  'fbclid',
];

export function sanitize(value: unknown, maxLen = MAX_FIELD_LEN): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLen) : '';
}

export function parseUtm(raw: unknown): Utm {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const input = raw as JsonObject;
  const utm: Utm = {};
  for (const key of TRACKED_UTM_PARAMS) {
    const value = sanitize(input[key], UTM_MAX_LEN);
    if (value) {
      utm[key] = value;
    }
  }

  return utm;
}

function formType(value: unknown): FormType | null {
  const parsed = sanitize(value, 32) || 'lead';

  return FORM_TYPES.has(parsed as FormType) ? (parsed as FormType) : null;
}

export function createSubmission(
  body: JsonObject,
  dependencies: Pick<HandlerDependencies, 'now' | 'uuid'>,
): Submission | null {
  const parsedFormType = formType(body.form_type);
  if (!parsedFormType) {
    return null;
  }

  const submission: Submission = {
    submissionId: sanitize(body.submission_id, 64) || dependencies.uuid(),
    formType: parsedFormType,
    createdAt: dependencies.now(),
    name: sanitize(body.name),
    phone: sanitize(body.phone, 32),
    service: sanitize(body.service, 64),
    telegramUsername: sanitize(body.telegram_username),
    utm: parseUtm(body.utm),
  };

  if (parsedFormType === 'newsletter') {
    submission.name = '';
    submission.service = 'Рассылка';
    submission.telegramUsername = '';
  }

  return submission;
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

export function validateSubmission(submission: Submission | null): string | null {
  if (!submission) {
    return 'validation_failed';
  }
  if (!SUBMISSION_ID_PATTERN.test(submission.submissionId)) {
    return 'invalid_submission_id';
  }
  if (!isValidPhone(submission.phone)) {
    return 'validation_failed';
  }
  if (submission.formType === 'newsletter') {
    return null;
  }
  if (!isValidName(submission.name) || !SERVICES.has(submission.service)) {
    return 'validation_failed';
  }
  if (submission.service === 'Telegram' && !isValidTelegramUsername(submission.telegramUsername)) {
    return 'telegram_username_required';
  }

  return null;
}

export function hasHoneypotValue(body: JsonObject): boolean {
  const value = body.website;

  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}
