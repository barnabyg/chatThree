import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MiddlewareHandler } from 'hono';

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

function decoded(urlPath: string): string | undefined {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
}

/**
 * Serve the built UI from `uiDir`. Any path that is not a file gets
 * `index.html`, so the UI can own its routes.
 */
export function staticFiles(uiDir: string): MiddlewareHandler {
  const root = path.resolve(uiDir);
  return async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.notFound();
    }
    const urlPath = decoded(c.req.path);
    const requested =
      urlPath === undefined ? root : path.resolve(root, `.${urlPath}`);
    const insideRoot = requested.startsWith(root + path.sep);
    const asset = insideRoot ? await readIfPresent(requested) : undefined;
    if (asset !== undefined) {
      const type =
        CONTENT_TYPES[path.extname(requested)] ?? 'application/octet-stream';
      return c.body(new Uint8Array(asset), 200, { 'Content-Type': type });
    }
    const index = await readIfPresent(path.join(root, 'index.html'));
    if (index === undefined) {
      return c.text(
        'The UI has not been built. Start chatThree with start.ps1.',
        503,
      );
    }
    return c.body(new Uint8Array(index), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  };
}
