/**
 * Boot. The only file that reads the real environment, opens a real port, and uses the real
 * clock — everything below it takes those as arguments, which is why the tests can drive the
 * whole server with a fake clock and no network.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createAuth } from './auth.ts';
import { systemClock } from './clock.ts';
import { loadConfig } from './env.ts';
import { Gateway } from './gateway.ts';
import { createLogger } from './logger.ts';
import { cryptoRng } from './rng.ts';
import { staticSite } from './static.ts';

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

const gateway = new Gateway({
  config,
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

const shutdown = (signal: string): void => {
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
