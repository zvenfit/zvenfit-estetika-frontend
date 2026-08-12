import { createOtelTransport, type MetricsTransport, type MetricsTransportOptions } from './otel-transport';

import type { ApplicationMetrics, FunctionContext, LoggerLike } from '../types';

const DEFAULT_ENDPOINT = 'https://ingest.monium.yandex.cloud/otlp/v1/metrics';
const DEFAULT_CLUSTER = 'default';
const DEFAULT_SERVICE = 'zvenfit-estetika-frontend';
const DEFAULT_TIMEOUT_MS = 1000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5000;

type MetricsTransportFactory = (options: MetricsTransportOptions) => MetricsTransport;

interface CreateInvocationMetricsOptions {
  env?: NodeJS.ProcessEnv;
  transportFactory?: MetricsTransportFactory;
}

class LazyInvocationMetrics implements ApplicationMetrics {
  private transport?: MetricsTransport;
  private initializationFailed = false;
  private flushed = false;

  public constructor(
    private readonly transportOptions: MetricsTransportOptions,
    private readonly transportFactory: MetricsTransportFactory,
    private readonly logger: LoggerLike,
  ) {}

  public addCounter(name: string, value = 1, attributes?: Record<string, string | number | boolean>): void {
    this.record(transport => transport.addCounter(name, value, attributes));
  }

  public recordGauge(name: string, value: number, attributes?: Record<string, string | number | boolean>): void {
    this.record(transport => transport.recordGauge(name, value, attributes));
  }

  public async flush(): Promise<void> {
    if (this.flushed || !this.transport) return;
    this.flushed = true;
    try {
      await this.transport.flush();
    } catch (error) {
      logMetricError(this.logger, 'monium_metrics_export_error', error);
    }
  }

  private record(callback: (transport: MetricsTransport) => void): void {
    if (this.flushed || this.initializationFailed) return;
    try {
      this.transport ??= this.transportFactory(this.transportOptions);
      callback(this.transport);
    } catch (error) {
      this.initializationFailed = true;
      logMetricError(this.logger, 'monium_metrics_init_error', error);
    }
  }
}

const NOOP_METRICS: ApplicationMetrics = {
  addCounter() {},
  recordGauge() {},
  async flush() {},
};

function metricErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'metrics_error';
  const coded = error as Error & { code?: unknown; cause?: { code?: unknown } };

  return String(coded.code || coded.cause?.code || error.name || 'metrics_error').slice(0, 64);
}

function logMetricError(logger: LoggerLike, event: string, error: unknown): void {
  logger.error({ event, error_code: metricErrorCode(error) }, event);
}

function metricsEnabled(env: NodeJS.ProcessEnv): boolean {
  return ['1', 'true'].includes(env.MONIUM_METRICS_ENABLED?.trim().toLowerCase() ?? '');
}

function metricsTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = Number.parseInt(env.MONIUM_METRICS_TIMEOUT_MS ?? '', 10);
  if (!Number.isInteger(configured)) return DEFAULT_TIMEOUT_MS;

  return Math.min(Math.max(configured, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

export function createInvocationMetrics(
  _context: FunctionContext | undefined,
  logger: LoggerLike,
  options: CreateInvocationMetricsOptions = {},
): ApplicationMetrics {
  const env = options.env ?? process.env;
  if (!metricsEnabled(env)) return NOOP_METRICS;

  const project = env.MONIUM_PROJECT?.trim();
  const apiKey = env.MONIUM_API_KEY?.trim();
  if (!project || !apiKey) {
    logger.warn?.(
      { event: 'monium_metrics_misconfigured', reason: project ? 'missing_api_key' : 'missing_project' },
      'monium_metrics_misconfigured',
    );

    return NOOP_METRICS;
  }

  return new LazyInvocationMetrics(
    {
      endpoint: env.MONIUM_METRICS_ENDPOINT?.trim() || DEFAULT_ENDPOINT,
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'x-monium-project': project,
        'x-monium-cluster': env.MONIUM_CLUSTER?.trim() || DEFAULT_CLUSTER,
        'x-monium-service': env.MONIUM_SERVICE?.trim() || DEFAULT_SERVICE,
      },
      timeoutMs: metricsTimeoutMs(env),
    },
    options.transportFactory ?? createOtelTransport,
    logger,
  );
}

export const _private = { metricsEnabled, metricsTimeoutMs };
