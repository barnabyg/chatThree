// Whether a file can be a character's picture. Checked by the server when a
// picture is uploaded, and by the browser for a new character's picture,
// which is held until the character is saved.

export const MAX_PICTURE_BYTES = 15 * 1024 * 1024;

/** The kind of picture these bytes are, as a file extension, if it is one the app keeps. */
export function pictureKind(bytes: Uint8Array): string | undefined {
  /** Whether the file begins with these bytes. `undefined` matches any byte. */
  const starts = (...head: (number | undefined)[]): boolean =>
    head.every((byte, index) => byte === undefined || bytes[index] === byte);
  const ascii = (offset: number, word: string): boolean =>
    starts(
      ...Array<undefined>(offset),
      ...Array.from(word, (letter) => letter.charCodeAt(0)),
    );
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  return undefined;
}

export const NOT_A_PICTURE = 'A picture must be a PNG, JPEG or WebP image.';
export const PICTURE_TOO_LARGE = 'That picture is too large to use.';

/**
 * Why a file of `size` bytes, beginning with `head` (its first 16 bytes are
 * enough), cannot be a character's picture, or `undefined` if it can.
 */
export function pictureProblem(
  size: number,
  head: Uint8Array,
): string | undefined {
  if (size > MAX_PICTURE_BYTES) return PICTURE_TOO_LARGE;
  if (pictureKind(head) === undefined) return NOT_A_PICTURE;
  return undefined;
}
