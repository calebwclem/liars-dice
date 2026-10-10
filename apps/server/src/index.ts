/**
 * Boot. The only file that reads the real environment, opens a real port, and uses the real
 * clock — everything below it takes those as arguments, which is why the tests can drive the
 * whole server with a fake clock and no network.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { fileArchive, noArchive } from './archive.ts';
import { createAuth } from './auth.ts';
import { systemClock } from './clock.ts';
import { loadConfig, loadEnvFile } from './env.ts';
import { Gateway } from './gateway.ts';
import { createLogger } from './logger.ts';
import { cryptoRng } from './rng.ts';
import { staticSite } from './static.ts';

// Before `loadConfig`, which reads `process.env` and validates it. See env.ts for why this is
// here rather than a `--env-file-if-exists` flag on the dev script.
loadEnvFile();
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, { service: 'liars-dice-server' });
const clock = systemClock();

// The browser client, when it has been built (`pnpm build:web`). Serving it from here means the
// page and the socket share an origin, so one tunnel or one deploy covers a playable game and the
// client derives `wss://` from `location` rather than being configured.
const web = staticSite(join(import.meta.dirname, '..', '..', 'web', 'dist'));

const http = createServer((request, response) => {
  // A health endpoint, because Fly.io wants one and because "is it up?" should not require
  // opening a WebSocket.
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  void web.serve(request, response).then((served) => {
    if (!served) response.writeHead(404).end();
  });
});

// PLAN.md's deterministic replay: a finished match is written down when a directory is
// configured for it, and not otherwise. See archive.ts for what goes in the file and why that
// cannot include a die nobody was shown.
const archive =
  config.MATCH_ARCHIVE_DIR === undefined ? noArchive() : fileArchive(config.MATCH_ARCHIVE_DIR, log);

const gateway = new Gateway({
  config,
  archive,
  clock,
  auth: createAuth({ secret: config.AUTH_SECRET, ttlMs: config.TOKEN_TTL_MS, clock }),
  rng: cryptoRng(), // R-20
  log,
  server: new WebSocketServer({ server: http, maxPayload: 16 * 1024 }),
});

http.listen(config.PORT, config.HOST, () => {
  log.info('server.listening', {
    host: config.HOST,
    port: config.PORT,
    matchSize: config.MATCH_SIZE,
  });
});

/**
 * Shut down once, however many times we are asked.
 *
 * A signal sent to the process group reaches this process directly *and* by way of whatever
 * supervises it, and an impatient second Ctrl-C arrives as another SIGINT on top. Without the
 * guard each of those starts its own teardown: `gateway.close()` runs again over a closed
 * server, and the log reports a shutdown per signal, which reads like several servers stopping.
 */
let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  log.info('server.shuttingDown', { signal });
  void gateway.close().then(() => {
    http.close(() => {
      process.exit(0);
    });
  });
};

process.on('SIGINT', () => {
  shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
