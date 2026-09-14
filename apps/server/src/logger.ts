/**
 * Structured JSON logging. PLAN.md asks for a `matchId` on every line so any reported bug
 * can be reconstructed from the logs, which is what `child()` is for.
 *
 * Deliberately tiny rather than a dependency: one line per event, stdout only, and the
 * host collects it.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(
  level: Level,
  context: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
): Logger {
  const at =
    (entryLevel: Level) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      if (RANK[entryLevel] < RANK[level]) return;
      sink(
        JSON.stringify({
          t: new Date().toISOString(),
          level: entryLevel,
          event,
          ...context,
          ...fields,
        }),
      );
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (extra) => createLogger(level, { ...context, ...extra }, sink),
  };
}

export const silentLogger = (): Logger => createLogger('silent');
