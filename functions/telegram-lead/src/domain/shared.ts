export type FormKind = 'lead' | 'newsletter';

export type UtmKey =
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'utm_term'
  | 'utm_content'
  | 'yclid'
  | 'gclid'
  | 'fbclid';

export type Utm = Partial<Record<UtmKey, string>>;

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

export interface ConsentEvidence {
  version: string;
  personalData: boolean;
  marketing: boolean;
}

export interface RequestEvidence {
  requestId: string;
  occurredAt: Date;
  utm: Utm;
  consents: ConsentEvidence;
}
