import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.replace(/:\d+$/, '').toLowerCase());
}

/**
 * Refuse requests that a web page on another site could make the browser send.
 *
 * Listening on the loopback address keeps other machines out, but not other
 * web pages: a page can point its own domain at 127.0.0.1 (DNS rebinding) or
 * post a form here. Such requests carry the page's host name or origin, so
 * requiring loopback names rejects them.
 */
export const localOnly: MiddlewareHandler = async (c, next) => {
  const host = c.req.header('host');
  if (host === undefined || !isLoopback(host)) {
    return c.text(
      'chatThree only answers requests to its loopback address.',
      403,
    );
  }
  const origin = c.req.header('origin');
  if (
    origin !== undefined &&
    !(URL.canParse(origin) && isLoopback(new URL(origin).host))
  ) {
    return c.text('chatThree only answers requests from its own UI.', 403);
  }
  await next();
  return undefined;
};
