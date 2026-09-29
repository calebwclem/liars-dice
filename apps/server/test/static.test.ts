import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticSite } from '../src/static.ts';

/**
 * Serving the browser client.
 *
 * Most of this is ordinary, and one part is not: a WebSocket server that also serves files is a
 * WebSocket server that can be asked for its own source. The traversal tests are the point of
 * this file.
 */
describe('The static site', () => {
  let http: Server;
  let base = '';
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'liarsdice-static-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html><title>page</title>');
    await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
    // The file a traversal would be reaching for, one level above the served root.
    await writeFile(join(root, '..', 'liarsdice-secret.txt'), 'AUTH_SECRET=hunter2');

    const site = staticSite(root);
    http = createServer((request, response) => {
      void site.serve(request, response).then((served) => {
        if (!served) response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
  });

  test('the page is served at the root', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>page</title>');
  });

  test('a fingerprinted asset is served with its real type and cached hard', async () => {
    const response = await fetch(`${base}/assets/app-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  test('the page itself is never cached', async () => {
    // Caching index.html is how a browser gets stuck on an old protocol version after a deploy
    // and reports "time to update" forever.
    const response = await fetch(`${base}/`);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  test('a missing bundle is a 404, not the page with a 200', async () => {
    // The deployment failure this is for: index.html is `no-cache` and the bundles are
    // `immutable`, so a stale tab can outlive its own JavaScript. Answering `/assets/*.js` with
    // HTML gets that tab a syntax error inside a script tag; a 404 says what happened, to the
    // browser and to the logs.
    const response = await fetch(`${base}/assets/index-DELETED.js`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<title>page</title>');
  });

  test('a missing file outside /assets/ is a 404 too, by its extension', async () => {
    for (const path of ['/favicon.ico', '/robots.txt.css', '/app.js', '/styles.css']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, `${path} was answered with something`).toBe(404);
    }
  });

  test('a deep link is still a navigation and still reaches the page', async () => {
    // The whole reason the fallback exists. Narrowing it must not cost this.
    for (const path of ['/some/deep/link', '/join/WXYZ', '/']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('<title>page</title>');
    }
  });

  test('an extension this server does not serve is not treated as a file', async () => {
    // Where the line is drawn, stated out loud: `TYPES` decides, so an unknown suffix falls
    // through to the page rather than being guessed at from the dot alone.
    const response = await fetch(`${base}/room/v1.2`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>page</title>');
  });

  test('a traversal cannot reach a file above the root', async () => {
    for (const path of [
      '/../liarsdice-secret.txt',
      '/../../liarsdice-secret.txt',
      '/assets/../../liarsdice-secret.txt',
      '/%2e%2e/liarsdice-secret.txt',
      '/%2e%2e%2fliarsdice-secret.txt',
      '/....//liarsdice-secret.txt',
    ]) {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      expect(body, `${path} leaked`).not.toContain('hunter2');
    }
  });

  test('only GET and HEAD are served', async () => {
    const response = await fetch(`${base}/`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  test('HEAD answers with the headers and no body', async () => {
    const response = await fetch(`${base}/assets/app-abc123.js`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toBe('');
  });

  test('a root that was never built serves nothing rather than crashing', async () => {
    // The iOS app needs no web client, so a server without one is a normal server.
    const site = staticSite(join(root, 'does-not-exist'));
    const server = createServer((request, response) => {
      void site.serve(request, response).then((served) => {
        if (!served) response.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(response.status).toBe(404);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});
