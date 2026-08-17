import { ExportResultCode } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import type { Meter, MetricAttributes } from '@opentelemetry/api';

const METER_NAME = 'zvenfit-estetika-telegram-lead';
const METER_VERSION = '1';

export interface MetricsTransport {
  recordGauge(name: string, value: number, attributes?: MetricAttributes): void;
  flush(): Promise<void>;
}

export interface MetricsTransportOptions {
  endpoint: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

type MetricsExporterFactory = (options: MetricsTransportOptions) => PushMetricExporter;

class OneShotMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

class OtelMetricsTransport implements MetricsTransport {
  private readonly gauges = new Map<string, ReturnType<Meter['createGauge']>>();

  public constructor(
    private readonly provider: MeterProvider,
    private readonly reader: MetricReader,
    private readonly exporter: PushMetricExporter,
    private readonly meter: Meter,
    private readonly timeoutMs: number,
  ) {}

  public recordGauge(name: string, value: number, attributes?: MetricAttributes): void {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = this.meter.createGauge(name);
      this.gauges.set(name, gauge);
    }
    gauge.record(value, attributes);
  }

  public async flush(): Promise<void> {
    await withTimeout(
      this.flushAndShutdown(),
      this.timeoutMs,
      'metrics_flush_timeout',
    );
  }

  private async flushAndShutdown(): Promise<void> {
    let exportFailure: unknown;
    try {
      const { resourceMetrics, errors } = await this.reader.collect({ timeoutMillis: this.timeoutMs });
      if (errors.length) throw normalizeMetricError(errors[0], 'metrics_collection_failed');
      if (resourceMetrics.scopeMetrics.length) {
        await exportCollectedMetrics(this.exporter, resourceMetrics, this.timeoutMs);
      }
      await this.exporter.forceFlush();
    } catch (error) {
      exportFailure = normalizeMetricError(error, 'metrics_export_failed');
    }

    const [providerShutdown, exporterShutdown] = await Promise.all([
      settle(this.provider.shutdown({ timeoutMillis: this.timeoutMs })),
      settle(this.exporter.shutdown()),
    ]);
    if (exportFailure !== undefined) throw exportFailure;
    if (providerShutdown.status === 'rejected') throw providerShutdown.reason;
    if (exporterShutdown.status === 'rejected') throw exporterShutdown.reason;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('Metrics flush timed out'), { code }));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    value => ({ status: 'fulfilled', value }),
    reason => ({ status: 'rejected', reason }),
  );
}

function normalizeMetricError(error: unknown, code: string): Error {
  return error instanceof Error ? error : Object.assign(new Error(code), { code });
}

function exportCollectedMetrics(
  exporter: PushMetricExporter,
  resourceMetrics: ResourceMetrics,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let completed = false;
    const timer = setTimeout(() => {
      if (!completed) reject(Object.assign(new Error('Metric export timed out'), { code: 'metrics_export_timeout' }));
      completed = true;
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    try {
      exporter.export(resourceMetrics, result => {
        finish(
          result.code === ExportResultCode.SUCCESS
            ? undefined
            : (result.error ?? Object.assign(new Error('Metric export failed'), { code: 'metrics_export_failed' })),
        );
      });
    } catch (error) {
      finish(normalizeMetricError(error, 'metrics_export_failed'));
    }
  });
}

function createOtelExporter(options: MetricsTransportOptions): PushMetricExporter {
  return new OTLPMetricExporter({
    url: options.endpoint,
    headers: options.headers,
    timeoutMillis: options.timeoutMs,
    temporalityPreference: AggregationTemporality.CUMULATIVE,
  });
}

export function createOtelTransport(
  options: MetricsTransportOptions,
  exporterFactory: MetricsExporterFactory = createOtelExporter,
): MetricsTransport {
  const exporter = exporterFactory(options);
  const reader = new OneShotMetricReader({
    // An explicit zero is a real queue-health sample, not missing telemetry.
    aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
  });
  const provider = new MeterProvider({ readers: [reader] });

  return new OtelMetricsTransport(
    provider,
    reader,
    exporter,
    provider.getMeter(METER_NAME, METER_VERSION),
    options.timeoutMs,
  );
}
