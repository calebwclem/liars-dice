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

  test('an unknown path falls back to the page, because the client routes itself', async () => {
    const response = await fetch(`${base}/some/deep/link`);
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
