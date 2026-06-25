export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  isDebugEnabled: boolean;
}

const SECRET_PATTERNS = [
  /client_secret/i,
  /access_token/i,
  /authorization/i,
  /bearer/i,
  /password/i,
  /secret/i,
  /token/i,
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

function formatMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      const redacted = redactValue(k, v);
      const formatted =
        typeof redacted === 'string' ? redacted : JSON.stringify(redacted);
      return `${k}=${formatted}`;
    })
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
    const parts = [`ts=${timestamp}`, `level=${level}`, `msg=${msg}`];
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
