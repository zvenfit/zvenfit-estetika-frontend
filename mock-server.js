const http = require('http');
const fs = require('fs');
const path = require('path');

const leadHandler = require('./functions/telegram-lead/build/index.js');

const PORT = 3000;
const rootDir = __dirname;

function loadEnvFile(filename) {
  const filepath = path.join(rootDir, filename);
  if (!fs.existsSync(filepath)) {
    return;
  }

  const content = fs.readFileSync(filepath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile('.env.development');

function sendHandlerResponse(res, result) {
  res.writeHead(result.statusCode, {
    'Content-Type': result.headers['Content-Type'] || 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(result.body);
}

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();

      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          payload = {};
        }
        console.log('\n📩 Form request:');
        console.log({
          submission_id: payload.submission_id || 'missing',
          form_type: payload.form_type || 'lead',
          service: payload.service || 'missing',
          has_name: Boolean(payload.name),
          has_phone: Boolean(payload.phone),
          has_utm: Boolean(payload.utm && Object.keys(payload.utm).length > 0),
        });
        console.log('---');

        if (
          process.env.TELEGRAM_BOT_TOKEN &&
          process.env.TELEGRAM_CHAT_ID &&
          process.env.YDB_CONNECTION_STRING
        ) {
          try {
            const result = await leadHandler.handler({
              httpMethod: 'POST',
              headers: {
                origin: req.headers.origin || 'http://localhost:4173',
                'content-type': req.headers['content-type'] || 'application/json',
              },
              requestContext: { identity: { sourceIp: req.socket.remoteAddress || '' } },
              body,
            });
            sendHandlerResponse(res, result);

            return;
          } catch (error) {
            console.error('Lead handler failed:', error.message);
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(
          JSON.stringify({
            ok: true,
            submission_id: payload.submission_id || null,
            notification: 'mock',
            ...(payload.form_type === 'newsletter' ? { confirmation_required: true } : {}),
          }),
        );
      });

      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  })
  .listen(PORT, () => {
    console.log(`🚀 Mock API: http://localhost:${PORT}`);
    if (
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID &&
      process.env.YDB_CONNECTION_STRING
    ) {
      console.log('   POST / — live YDB + Telegram');
    } else {
      console.log('   POST / — stub ok:true (set TELEGRAM_* + YDB_CONNECTION_STRING for live)');
    }
    console.log('');
  });
