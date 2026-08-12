import { ExportResultCode } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  MetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';

import type { Meter, MetricAttributes } from '@opentelemetry/api';

const METER_NAME = 'zvenfit-estetika-telegram-lead';
const METER_VERSION = '1';

export interface MetricsTransport {
  addCounter(name: string, value: number, attributes?: MetricAttributes): void;
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
  private readonly counters = new Map<string, ReturnType<Meter['createCounter']>>();
  private readonly gauges = new Map<string, ReturnType<Meter['createGauge']>>();

  public constructor(
    private readonly provider: MeterProvider,
    private readonly reader: MetricReader,
    private readonly exporter: PushMetricExporter,
    private readonly meter: Meter,
    private readonly timeoutMs: number,
  ) {}

  public addCounter(name: string, value: number, attributes?: MetricAttributes): void {
    let counter = this.counters.get(name);
    if (!counter) {
      counter = this.meter.createCounter(name);
      this.counters.set(name, counter);
    }
    counter.add(value, attributes);
  }

  public recordGauge(name: string, value: number, attributes?: MetricAttributes): void {
    let gauge = this.gauges.get(name);
    if (!gauge) {
      gauge = this.meter.createGauge(name);
      this.gauges.set(name, gauge);
    }
    gauge.record(value, attributes);
  }

  public async flush(): Promise<void> {
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

    const results = await Promise.allSettled([
      this.provider.shutdown({ timeoutMillis: this.timeoutMs }),
      this.exporter.shutdown(),
    ]);
    if (exportFailure !== undefined) throw exportFailure;
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
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
    temporalityPreference: AggregationTemporality.DELTA,
  });
}

function selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
  switch (instrumentType) {
    case InstrumentType.COUNTER:
    case InstrumentType.OBSERVABLE_COUNTER:
    case InstrumentType.HISTOGRAM:
      return AggregationTemporality.DELTA;
    default:
      return AggregationTemporality.CUMULATIVE;
  }
}

export function createOtelTransport(
  options: MetricsTransportOptions,
  exporterFactory: MetricsExporterFactory = createOtelExporter,
): MetricsTransport {
  const exporter = exporterFactory(options);
  const reader = new OneShotMetricReader({
    // Counters describe one invocation. Gauges stay cumulative so zero is exported as a real sample.
    aggregationTemporalitySelector: selectAggregationTemporality,
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
