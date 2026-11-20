// ============================================================================
// STRUCTURED LOGGER WITH AUTOMATIC CREDENTIAL & SECRET REDACTION
// ============================================================================

const SENSITIVE_KEY_PATTERN =
  /(secret|token|mnemonic|private|password|passwd|authorization|apikey|api_key|signature|cookie|credential|database_url|db_url|initdata|x-admin-token|x-webhook-secret)/i;

function redactStringValue(input: string): string {
  return input
    .replace(/postgres(?:ql)?:\/\/([^:\s/]+):([^@\s]+)@/gi, 'postgresql://***:***@')
    .replace(/(Bearer|Key)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]')
    .replace(/(WEBHOOK_SECRET|ADMIN_API_TOKEN|TELEGRAM_BOT_TOKEN|TON_PAYOUT_MNEMONIC|SOL_PAYOUT_SECRET_KEY)=([^\s]+)/gi, '$1=[REDACTED]');
}

export function sanitizeLogMeta(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactStringValue(value.message || ''),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogMeta(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogMeta(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function emit(level: 'INFO' | 'WARN' | 'ERROR', scope: string, message: string, meta?: Record<string, unknown>) {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: redactStringValue(message),
  };
  if (meta && Object.keys(meta).length > 0) {
    payload.meta = sanitizeLogMeta(meta);
  }
  const line = JSON.stringify(payload);
  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export const logger = {
  info: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('INFO', scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('WARN', scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) =>
    emit('ERROR', scope, message, meta),
};
