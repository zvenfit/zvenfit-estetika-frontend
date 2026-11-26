import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { AggregationTemporality } from '@opentelemetry/sdk-metrics';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type RequestListener, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createInvocationMetrics } from '../../metrics';
import { createMetricsAgent } from '../../metrics-agent';
import { createOtelTransport, type MetricsTransportOptions } from '../../otel-transport';

import type { JsonObject, LoggerLike } from '../../../types';

const TIMEOUT_MS = 500;
const WATCHDOG_MS = 4000;
type Protocol = 'http' | 'https';
type ExporterFactory = (options: MetricsTransportOptions, signal: AbortSignal) => OTLPMetricExporter;
let certificates: { key: Buffer; cert: Buffer };
let certificateDirectory: string;

before(() => {
  // Ephemeral test-only key; no committed certificate or disabled TLS checks.
  certificateDirectory = mkdtempSync(join(tmpdir(), 'zvenfit-metrics-tls-'));
  const key = join(certificateDirectory, 'key.pem');
  const cert = join(certificateDirectory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 },
  );
  certificates = { key: readFileSync(key), cert: readFileSync(cert) };
});
after(() => {
  if (certificateDirectory) {
    rmSync(certificateDirectory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });

  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let watchdog: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('local probe watchdog expired')), WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

async function collector(t: TestContext, protocol: Protocol, mode: 'silent' | 'stream' | 'success' | 'retry') {
  const received = deferred();
  const disconnected = deferred();
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  const intervals = new Set<NodeJS.Timeout>();
  const requests: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  let currentMode = mode;
  const listener: RequestListener = (request, response) => {
    const record = { headers: request.headers, body: Buffer.alloc(0) };
    requests.push(record);
    request.on('data', chunk => {
      record.body = Buffer.concat([record.body, chunk]);
    });
    responses.add(response);
    response.once('close', () => responses.delete(response));
    received.resolve();
    if (currentMode === 'retry') {
      currentMode = 'success';
      response.writeHead(503, { 'retry-after': '1' });
      response.end();
    } else if (currentMode === 'success') {
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      response.end();
    } else if (currentMode === 'stream') {
      response.writeHead(200, { 'content-type': 'application/x-protobuf' });
      // Valid empty protobuf fields keep the socket active indefinitely.
      const chunk = Buffer.from([0x0a, 0x00]);
      response.write(chunk);
      const interval = setInterval(() => response.write(chunk), 25);
      intervals.add(interval);
      response.once('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    }
  };
  const server = protocol === 'https' ? createHttpsServer(certificates, listener) : createServer(listener);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      disconnected.resolve();
    });
  });
  t.after(async () => {
    for (const interval of intervals) {
      clearInterval(interval);
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  return {
    url: `${protocol}://127.0.0.1:${address.port}/v1/metrics`,
    received: received.promise,
    disconnected: disconnected.promise,
    sockets,
    requests,
    release() {
      currentMode = 'success';
      for (const interval of intervals) {
        clearInterval(interval);
      }
      intervals.clear();
      for (const response of responses) {
        response.end();
      }
    },
  };
}

function testExporter(options: MetricsTransportOptions, signal: AbortSignal) {
  return new OTLPMetricExporter({
    url: options.endpoint,
    headers: options.headers,
    timeoutMillis: options.timeoutMs,
    temporalityPreference: AggregationTemporality.CUMULATIVE,
    httpAgentOptions: protocol => createMetricsAgent(protocol, signal, { ca: certificates.cert }),
  });
}

function metrics(url: string, exporterFactory?: ExporterFactory) {
  const logs: JsonObject[] = [];
  const logger: LoggerLike = {
    error: fields => logs.push(fields),
    warn: fields => logs.push(fields),
    info: fields => logs.push(fields),
  };
  const invocationMetrics = createInvocationMetrics(undefined, logger, {
    env: {
      MONIUM_METRICS_ENABLED: 'true',
      MONIUM_PROJECT: 'local-test',
      MONIUM_API_KEY: 'test-only',
      MONIUM_METRICS_ENDPOINT: url,
      MONIUM_METRICS_TIMEOUT_MS: String(TIMEOUT_MS),
    },
    transportFactory: options => createOtelTransport(options, exporterFactory),
  });
  invocationMetrics.recordGauge('local_probe', 1);

  return { metrics: invocationMetrics, logs };
}

function assertTimeout(logs: JsonObject[]) {
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.event, 'monium_metrics_export_error');
  assert.equal(logs[0]?.error_code, 'metrics_export_timeout');
  assert.equal(logs[0]?.phase, 'export');
  // Allow scheduler noise; the exact 5s boundary is covered by virtual clocks.
  assert.ok(Number(logs[0]?.duration_ms) >= TIMEOUT_MS - 10);
  assert.ok(Number(logs[0]?.duration_ms) < TIMEOUT_MS + 750);
}

for (const protocol of ['http', 'https'] as const) {
  // HTTP covers the default production factory. HTTPS uses that same SDK and
  // production agent with a CA trusted only by this collector's client.
  const factory = protocol === 'https' ? testExporter : undefined;
  for (const mode of ['silent', 'stream'] as const) {
    test(
      `${protocol}: ${mode} response is cancelled within the shared budget; next invocation succeeds`,
      { timeout: 8000 },
      async t => {
        const server = await collector(t, protocol, mode);
        const f = metrics(server.url, factory);
        await bounded(f.metrics.flush());
        assertTimeout(f.logs);
        await bounded(server.disconnected);
        assert.equal(server.sockets.size, 0);
        assert.equal(server.requests.length, 1);
        await f.metrics.flush();
        server.release();
        const next = metrics(server.url, factory);
        await bounded(next.metrics.flush());
        assert.equal(next.logs.length, 1);
        assert.equal(next.logs[0]?.event, 'monium_metrics_export_completed');
        assert.equal(server.requests.length, 2);
        assert.equal(f.logs.length, 1, 'late callbacks must not add another outcome');
        const request = server.requests[1];
        assert.equal(request?.headers.authorization, 'Api-Key test-only');
        assert.equal(request?.headers['x-monium-project'], 'local-test');
        assert.equal(request?.headers['content-type'], 'application/x-protobuf');
        assert.ok(request?.body.includes(Buffer.from('local_probe')));
      },
    );
  }

  test(`${protocol}: initialization released after timeout cannot create a connection`, { timeout: 8000 }, async t => {
    const server = await collector(t, protocol, 'success');
    const entered = deferred();
    const gate = deferred();
    let exporter: OTLPMetricExporter | undefined;
    const f = metrics(server.url, (options, signal) => {
      exporter = new OTLPMetricExporter({
        url: options.endpoint,
        timeoutMillis: options.timeoutMs,
        httpAgentOptions: async scheme => {
          entered.resolve();
          await gate.promise;

          return createMetricsAgent(scheme, signal, { ca: certificates.cert });
        },
      });

      return exporter;
    });
    const flush = f.metrics.flush();
    await bounded(entered.promise);
    await bounded(flush);
    assertTimeout(f.logs);
    gate.resolve();
    assert.ok(exporter);
    await bounded(exporter.forceFlush());
    await delay(25);
    assert.equal(server.requests.length, 0);
    assert.equal(server.sockets.size, 0);
    assert.equal(f.logs.length, 1);
  });

  test(
    `${protocol}: an SDK retry waking after cancellation cannot reuse its cached agent`,
    { timeout: 8000 },
    async t => {
      const server = await collector(t, protocol, 'retry');
      let exporter: OTLPMetricExporter | undefined;
      let factoryCalls = 0;
      const f = metrics(server.url, (options, signal) => {
        exporter = new OTLPMetricExporter({
          url: options.endpoint,
          // Fault injection: let the SDK schedule beyond our caller's budget.
          // Production receives only the remaining budget, but must also guard
          // late retries independently of the SDK's own deadline calculation.
          timeoutMillis: 2000,
          httpAgentOptions: scheme => {
            factoryCalls += 1;

            return createMetricsAgent(scheme, signal, { ca: certificates.cert });
          },
        });

        return exporter;
      });
      await bounded(f.metrics.flush());
      assertTimeout(f.logs);
      assert.ok(exporter);
      await bounded(exporter.forceFlush());
      assert.equal(factoryCalls, 1);
      assert.equal(server.requests.length, 1);
      assert.equal(server.sockets.size, 0);
      assert.equal(f.logs.length, 1);
    },
  );
}

test('HTTPS verification rejects a collector without a trusted CA', { timeout: 8000 }, async t => {
  const server = await collector(t, 'https', 'success');
  const f = metrics(server.url);
  await bounded(f.metrics.flush());
  assert.equal(server.requests.length, 0);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0]?.event, 'monium_metrics_export_error');
  assert.equal(f.logs[0]?.error_code, 'DEPTH_ZERO_SELF_SIGNED_CERT');
});

// The stock SDK also bounds a stalled handshake through its idle timeout once TCP
// connects; this case guards that the shared deadline still closes the socket.
test('HTTPS handshake stalled before a response is also cancelled', { timeout: 8000 }, async t => {
  const disconnected = deferred();
  const sockets = new Set<Socket>();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.resume();
    socket.once('close', () => {
      sockets.delete(socket);
      disconnected.resolve();
    });
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const f = metrics(`https://127.0.0.1:${address.port}/v1/metrics`);
  await bounded(f.metrics.flush());
  assertTimeout(f.logs);
  await bounded(disconnected.promise);
  assert.equal(sockets.size, 0);
});
