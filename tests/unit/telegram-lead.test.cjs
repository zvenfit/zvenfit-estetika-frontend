'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handler, _resetRateLimitForTests } = require('../../functions/telegram-lead/index.js');

const origin = 'https://estetika.zvenfit.ru';

function request(body, ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`) {
  return {
    httpMethod: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    requestContext: { identity: { sourceIp: ip } },
    body: JSON.stringify(body),
  };
}

test.beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  process.env.ALLOWED_ORIGINS = origin;
  _resetRateLimitForTests();
  global.fetch = async (_url, options) => ({
    ok: true,
    json: async () => ({ ok: true, text: JSON.parse(options.body).text }),
  });
});

test('rejects an origin outside the allowlist', async () => {
  const response = await handler({ httpMethod: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(response.statusCode, 403);
});

test('accepts a valid lead and forwards only expected fields', async () => {
  let sent;
  global.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ ok: true }) };
  };

  const response = await handler(request({
    form_type: 'lead',
    name: 'Анна Смирнова',
    phone: '+7 (968) 844-00-88',
    service: 'WhatsApp',
    utm: { utm_source: 'test', ignored: 'drop' },
    extra: 'drop',
  }, '198.51.100.10'));

  assert.equal(response.statusCode, 200);
  assert.match(sent.text, /Анна Смирнова/);
  assert.match(sent.text, /source: test/);
  assert.doesNotMatch(sent.text, /ignored|drop/);
});

test('rejects an unknown service', async () => {
  const response = await handler(request({
    name: 'Анна', phone: '+79688440088', service: 'Unknown',
  }));
  assert.equal(response.statusCode, 400);
});

test('honeypot returns success without contacting Telegram', async () => {
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({ ok: true }) }; };
  const response = await handler(request({ website: 'bot', phone: '+79688440088' }));
  assert.equal(response.statusCode, 200);
  assert.equal(called, false);
});

test('rejects an oversized payload', async () => {
  const response = await handler(request({ website: 'x'.repeat(20_000) }));
  assert.equal(response.statusCode, 413);
});

test('rate limits repeated requests from one IP', async () => {
  const body = { form_type: 'newsletter', phone: '+79688440088' };
  let last;
  for (let index = 0; index < 11; index += 1) {
    last = await handler(request(body, '198.51.100.77'));
  }
  assert.equal(last.statusCode, 429);
});
