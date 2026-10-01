// Structured JSON logs on stderr. Cloud Run/Cloud Logging parses the `severity` field,
// and stderr keeps stdout clean for the stdio transport.

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SEVERITY: Record<Level, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARNING', error: 'ERROR' };

let minLevel: Level = parseLevel(process.env.LOG_LEVEL);

function parseLevel(value: string | undefined): Level {
  const v = (value ?? '').toLowerCase();
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

export function setLogLevel(level: string | undefined): void {
  minLevel = parseLevel(level);
}

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const entry = { severity: SEVERITY[level], message, time: new Date().toISOString(), ...fields };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
