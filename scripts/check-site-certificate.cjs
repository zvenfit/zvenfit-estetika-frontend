'use strict';

const tls = require('node:tls');
const { cname } = require('./cdn-security-headers.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_DAYS = 21;

function checkExpiry(validTo, now = Date.now()) {
  if (!(validTo instanceof Date) || !Number.isFinite(validTo.getTime())) {
    throw new Error('TLS peer did not provide a valid certificate expiry date');
  }
  const remaining = validTo.getTime() - now;
  const summary = `${cname}: TLS certificate expires ${validTo.toISOString()} (${Math.floor(remaining / DAY_MS)} full days left)`;
  if (remaining < MIN_DAYS * DAY_MS) throw new Error(`${summary}, minimum is ${MIN_DAYS} days`);
  return summary;
}

function readExpiry() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: cname, port: 443, servername: cname, rejectUnauthorized: true });
    const deadline = setTimeout(() => socket.destroy(new Error(`TLS handshake timed out for ${cname}`)), 15000);
    socket.once('close', () => clearTimeout(deadline));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const validTo = socket.getPeerX509Certificate()?.validToDate;
      socket.destroy();
      resolve(validTo);
    });
  });
}

if (require.main === module) {
  readExpiry().then(validTo => console.log(checkExpiry(validTo))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { checkExpiry };
