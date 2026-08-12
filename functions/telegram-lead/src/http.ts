import type { Headers, HttpEvent, HttpResponse, JsonObject } from './types';

export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export function allowedOrigins(): string[] {
  const raw =
    process.env.ALLOWED_ORIGINS || 'https://estetika.zvenfit.ru';

  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(requestOrigin: string, origins: string[]): boolean {
  return Boolean(requestOrigin && origins.includes(requestOrigin));
}

export function corsHeaders(origin: string): Headers {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export function jsonResponse(statusCode: number, payload: JsonObject, headers: Headers): HttpResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

export function requestBodyBytes(event: HttpEvent): number {
  if (!event.body) {
    return 0;
  }

  return event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').byteLength
    : Buffer.byteLength(event.body, 'utf8');
}

export function readBody(event: HttpEvent): JsonObject {
  if (!event.body) {
    return {};
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  const parsed: unknown = JSON.parse(raw);

  return typeof parsed === 'object' && parsed !== null ? (parsed as JsonObject) : {};
}
