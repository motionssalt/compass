// Tiny structured logger that writes to `console` (Cloudflare tail /
// Logpush picks it up). Kept intentionally minimal.

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  };
  const fn =
    level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : console.log;
  fn(JSON.stringify(line));
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info:  (msg: string, extra?: Record<string, unknown>) => emit('info',  msg, extra),
  warn:  (msg: string, extra?: Record<string, unknown>) => emit('warn',  msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
