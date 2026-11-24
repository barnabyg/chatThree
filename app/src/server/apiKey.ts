/**
 * Whether `key` could be an API key at all: visible ASCII with no spaces.
 *
 * Anything else cannot go in an HTTP header. It is refused before a request
 * is built, because the HTTP client's own error for a bad header quotes the
 * header, and with it the key.
 */
export function isWellFormedApiKey(key: string): boolean {
  return /^[\x21-\x7E]+$/.test(key);
}
