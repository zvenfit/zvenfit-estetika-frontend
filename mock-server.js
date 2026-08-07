const http = require('http');
const fs = require('fs');
const path = require('path');

const leadHandler = require('./functions/telegram-lead/index.js');

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
        console.log('\n📩 Lead request:');
        try {
          console.log(JSON.parse(body));
        } catch {
          console.log(body);
        }
        console.log('---');

        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
          try {
            const result = await leadHandler.handler({
              httpMethod: 'POST',
              headers: {
                origin: req.headers.origin || 'http://localhost:4173',
              },
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
        res.end(JSON.stringify({ ok: true }));
      });

      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  })
  .listen(PORT, () => {
    console.log(`🚀 Mock API: http://localhost:${PORT}`);
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      console.log('   POST / — live Telegram (TELEGRAM_* env set)');
    } else {
      console.log('   POST / — stub ok:true (set TELEGRAM_* in .env.development for live)');
    }
    console.log('');
  });
