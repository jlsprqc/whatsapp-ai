function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
function portValue(): number {
  const value = positiveInt('PORT', 3000);
  if (value > 65535) throw new Error('Invalid PORT');
  return value;
}

import { normalizeNumber } from './util.js';

function numbers(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map(normalizeNumber).filter(Boolean));
}

export const config = {
  port: portValue(),
  difyBaseUrl: (() => { const value = required('DIFY_API_BASE_URL').replace(/\/$/, ''); const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid DIFY_API_BASE_URL'); return value; })(),
  difyApiKey: required('DIFY_API_KEY'),
  graphApiVersion: required('META_GRAPH_API_VERSION'),
  metaAccessToken: required('META_ACCESS_TOKEN'),
  phoneNumberId: required('META_PHONE_NUMBER_ID'),
  verifyToken: required('META_VERIFY_TOKEN'),
  appSecret: required('META_APP_SECRET'),
  dbPath: process.env.DB_PATH?.trim() || './data/bot.db',
  sessionTimeoutMs: positiveInt('SESSION_TIMEOUT_MINUTES', 60) * 60_000,
  allowedNumbers: numbers(process.env.ALLOWED_NUMBERS),
};
