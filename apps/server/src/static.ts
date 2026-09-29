/**
 * Serving the built web client from the same process that owns the socket.
 *
 * One origin for the page and the WebSocket is what makes a single tunnel — or a single deploy —
 * enough for a whole playable game. It also means the browser derives `wss://` from
 * `window.location` and there is no endpoint configuration anywhere to get wrong.
 *
 * Node builtins only. This is a few dozen lines of `readFile` rather than a dependency, and
 * CLAUDE.md is strict about what gets added for what.
 *
 * If the game ever outgrows this, the split is clean: put `apps/web/dist` behind a CDN and delete
 * this file. Nothing else knows it exists.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Everything the build emits. An unknown extension is served as a download, not as HTML. */
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticSite {
  /** True if the request was served. False means "not mine" — let the caller 404. */
  serve(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

/**
 * A site rooted at `dist`, or null if it has not been built. A server with no web client is a
 * perfectly good server — the iOS app does not need one — so a missing build is not an error.
 */
export function staticSite(root: string): StaticSite {
  const base = resolve(root);

  return {
    async serve(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return false;

      const url = new URL(request.url ?? '/', 'http://localhost');
      const file = await locate(base, decodeURIComponent(url.pathname));
      if (file === null) return false;

      const extension = file.slice(file.lastIndexOf('.'));
      const type = TYPES[extension] ?? 'application/octet-stream';
      // Vite fingerprints everything under /assets/, so those are immutable. index.html is not,
      // and caching it is how a client gets stuck on an old protocol version after a deploy.
      const cache = file.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';

      response.writeHead(200, { 'content-type': type, 'cache-control': cache });
      if (request.method === 'HEAD') {
        response.end();
        return true;
      }
      createReadStream(file).pipe(response);
      return true;
    },
  };
}

/**
 * The file this path means, or null.
 *
 * A path that is not a real file falls back to `index.html`, because the client is a single-page
 * app and a deep link has to reach it — but only if it reads as a *navigation*. A request for a
 * file the build should have emitted and did not is a 404.
 *
 * The distinction matters once this is deployed somewhere permanent. index.html is served
 * `no-cache` and the fingerprinted bundles are served `immutable`, so the failure to plan for is
 * a page that outlived its bundle: a stale tab asks for `/assets/index-OLD.js`, and answering
 * with HTML gets it a syntax error somewhere inside a script tag rather than the 404 that would
 * have told it, and told the logs, what actually happened.
 *
 * `TYPES` decides what counts as a file, so this is not a second table to keep in step with the
 * build — it is the one that was already here.
 */
async function locate(base: string, pathname: string): Promise<string | null> {
  // `normalize` collapses `..` before anything touches the filesystem, and the prefix check
  // catches whatever it leaves behind. Serving a socket server's own source over HTTP because
  // of a crafted path is not a mistake worth risking for the sake of one line.
  const candidate = resolve(join(base, normalize(pathname)));
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;

  if (await isFile(candidate)) return candidate;
  if (namesAFile(pathname)) return null;

  const index = join(base, 'index.html');
  return (await isFile(index)) ? index : null;
}

/**
 * Does this path ask for a file rather than a page?
 *
 * Two ways to say yes: it is under `/assets/`, which is the one directory Vite fills and
 * fingerprints, or it ends in an extension this server knows how to serve. An unfamiliar
 * extension still falls through to the page — `/room/v1.2` is a stranger sort of deep link than
 * this app has, but guessing "file" from a dot alone would break it, and guessing "page" only
 * serves HTML to something that was never going to parse it anyway.
 */
function namesAFile(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 && Object.hasOwn(TYPES, last.slice(dot).toLowerCase());
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
