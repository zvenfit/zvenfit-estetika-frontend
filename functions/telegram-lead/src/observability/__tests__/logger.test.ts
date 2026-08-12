import assert from 'node:assert/strict';
import test from 'node:test';

import { createInvocationLogger } from '../logger';

test('writes Yandex Cloud structured JSON and redacts submission PII and secrets', () => {
  const lines: Array<Record<string, unknown>> = [];
  const stream = { write(line: string) { lines.push(JSON.parse(line) as Record<string, unknown>); } };
  const logger = createInvocationLogger({ requestId: 'request-id' }, stream);

  logger.error(
    {
      event: 'test_event',
      name: 'Анна',
      phone: '+79990000000',
      source_ip: '198.51.100.10',
      utm: { utm_source: 'secret-campaign' },
      token: 'bot-token',
      error_code: 'safe_code',
    },
    'test_event',
  );

  const record = lines[0] || {};
  assert.equal(record.application, 'zvenfit-estetika-frontend');
  assert.equal(record.service, 'zvenfit-estetika-telegram-lead');
  assert.equal(record.level, 'ERROR');
  assert.equal(record.error_code, 'safe_code');
  assert.equal(record.name, '[REDACTED]');
  assert.equal(record.phone, '[REDACTED]');
  assert.equal(record.source_ip, '[REDACTED]');
  assert.equal(record.utm, '[REDACTED]');
  assert.equal(record.token, '[REDACTED]');
  assert.equal(record.request_id, 'request-id');
  assert.doesNotMatch(
    JSON.stringify(lines),
    /Анна|79990000000|198\.51\.100\.10|secret-campaign|bot-token/,
  );
});
