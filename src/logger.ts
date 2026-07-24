import { PROXY_NAME } from './errors.js';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  isDebugEnabled: boolean;
}

// Match credential-like keys only. Do not use a bare /token/i — that would redact
// troubleshooting metadata such as tokenEndpoint / token_endpoint (public IdP URLs).
const SECRET_PATTERNS = [
  /client_secret/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /id[_-]?token/i,
  /^token$/i,
  /authorization/i,
  /bearer/i,
  /password/i,
  /secret/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string' && isSecretKey(key) && value.length > 0) {
    return '[REDACTED]';
  }
  return value;
}

/** Format a field value as a JSON string literal (always quoted) for easy parsing. */
function formatValue(value: unknown): string {
  if (value === undefined) {
    // Present the key with an empty value (not the word "undefined").
    return '""';
  }
  if (typeof value === 'string') {
    // Quote + escape ", \, and control chars so key="..." stays parseable.
    return JSON.stringify(value);
  }
  // Numbers, booleans, null, objects, arrays: serialize then quote as one string field.
  return JSON.stringify(JSON.stringify(value));
}

function formatField(key: string, value: unknown): string {
  return `${key}=${formatValue(value)}`;
}

function formatMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .map(([k, v]) => formatField(k, redactValue(k, v)))
    .join(' ');
}

export function createLogger(debug?: boolean): Logger {
  const isDebugEnabled = debug ?? false;

  function log(
    level: string,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    const timestamp = new Date().toISOString();
    const parts = [
      formatField('ts', timestamp),
      formatField('level', level),
      formatField('component', PROXY_NAME),
      formatField('msg', msg),
    ];
    if (meta && Object.keys(meta).length > 0) {
      parts.push(formatMeta(meta));
    }
    process.stderr.write(parts.join(' ') + '\n');
  }

  return {
    isDebugEnabled,
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    debug: (msg, meta) => {
      if (isDebugEnabled) log('debug', msg, meta);
    },
  };
}
