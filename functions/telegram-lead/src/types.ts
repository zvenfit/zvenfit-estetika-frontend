export type JsonObject = Record<string, unknown>;
export type Headers = Record<string, string>;

export interface FunctionContext {
  requestId?: string;
}

export interface HttpEvent {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  messages?: Array<{ event_metadata?: { event_type?: string } }>;
  requestContext?: {
    identity?: { sourceIp?: string };
    http?: { method?: string; sourceIp?: string };
  };
}

export interface HttpResponse {
  statusCode: number;
  headers: Headers;
  body: string;
}

export interface LoggerLike {
  error(fields: JsonObject, message?: string): void;
  info?(fields: JsonObject, message?: string): void;
  warn?(fields: JsonObject, message?: string): void;
}

export interface ApplicationMetrics {
  addCounter(
    name: string,
    value?: number,
    attributes?: Record<string, string | number | boolean>,
  ): void;
  recordGauge(
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>,
  ): void;
  flush(): Promise<void>;
}

export type FormType = 'lead' | 'newsletter';
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
export type TelegramStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface Submission {
  submissionId: string;
  formType: FormType;
  createdAt: Date;
  name: string;
  phone: string;
  service: string;
  telegramUsername: string;
  utm: Utm;
}

export interface ClaimedSubmission extends Submission {
  telegramAttempts: number;
}

export interface StoreOptions {
  logger?: LoggerLike;
}

export interface TelegramQueueHealth {
  pendingCount: number;
  oldestPendingAgeSeconds: number;
}

export interface SubmissionStore {
  saveSubmission(
    submission: Submission,
    options?: StoreOptions,
  ): Promise<{ created: boolean; telegramStatus: TelegramStatus }>;
  claimForTelegram(args: {
    submissionId: string;
    now: Date;
    leaseUntil: Date;
    deliveryToken: string;
    logger?: LoggerLike;
  }): Promise<ClaimedSubmission | null>;
  markTelegramDelivered(args: {
    submissionId: string;
    deliveryToken: string;
    notifiedAt: Date;
    logger?: LoggerLike;
  }): Promise<void>;
  markTelegramFailed(args: {
    submissionId: string;
    deliveryToken: string;
    failedAt: Date;
    errorCode: string;
    terminal: boolean;
    logger?: LoggerLike;
  }): Promise<void>;
  listTelegramCandidates(args: {
    now: Date;
    limit: number;
    logger?: LoggerLike;
  }): Promise<string[]>;
  getTelegramQueueHealth(args: { now: Date; logger?: LoggerLike }): Promise<TelegramQueueHealth>;
}

export interface HandlerDependencies {
  loggerFactory(context?: FunctionContext): LoggerLike;
  maxAttempts(): number;
  metricsFactory(context: FunctionContext | undefined, logger: LoggerLike): ApplicationMetrics;
  now(): Date;
  rateLimiter(args: { sourceIp: string; now: Date; logger?: LoggerLike }): Promise<boolean>;
  store: SubmissionStore;
  telegramSender(submission: ClaimedSubmission): Promise<void>;
  uuid(): string;
}

export type SqlRow = Record<string, unknown>;
export type ResultSets = SqlRow[][];

export interface YdbQuery<T = ResultSets> extends PromiseLike<T> {
  timeout(milliseconds: number): YdbQuery<T>;
  idempotent(value: boolean): YdbQuery<T>;
  isolation(level: string): YdbQuery<T>;
}

export interface TransactionSql {
  (strings: TemplateStringsArray, ...values: unknown[]): YdbQuery;
}

export interface YdbSql extends TransactionSql {
  begin<T>(
    options: { idempotent: boolean; signal: AbortSignal },
    callback: (transaction: TransactionSql) => Promise<T>,
  ): Promise<T>;
  fragment(strings: TemplateStringsArray, ...values: unknown[]): unknown;
  identifier(value: string): unknown;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface YdbValue<T> {
  readonly value: T;
}

export interface YdbValueConstructor<T> {
  new (value: T): YdbValue<T>;
}

export interface YdbClient {
  driver: { close(): void };
  sql: YdbSql;
  types: {
    Timestamp: YdbValueConstructor<Date>;
    Uint32: YdbValueConstructor<number>;
  };
  close(): Promise<void>;
}
