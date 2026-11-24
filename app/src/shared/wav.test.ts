import { expect, test } from 'vitest';
import { encodeWav, wavSeconds } from './wav.ts';

test('samples are written as a 16-bit mono WAV file', () => {
  const file = encodeWav(new Float32Array([0, 1, -1, 0.5]), 8_000);

  const view = new DataView(file.buffer);
  const text = (offset: number): string =>
    String.fromCharCode(...file.subarray(offset, offset + 4));
  expect(file.length).toBe(44 + 8);
  expect([text(0), text(8), text(12), text(36)]).toEqual([
    'RIFF',
    'WAVE',
    'fmt ',
    'data',
  ]);
  expect(view.getUint32(4, true)).toBe(file.length - 8);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(8_000);
  expect(view.getUint16(34, true)).toBe(16);
  expect(view.getUint32(40, true)).toBe(8);
  expect([0, 1, 2, 3].map((n) => view.getInt16(44 + n * 2, true))).toEqual([
    0, 32_767, -32_767, 16_384,
  ]);
});

test('samples outside the range are clipped, not wrapped', () => {
  const file = encodeWav(new Float32Array([2, -3]), 8_000);

  const view = new DataView(file.buffer);
  expect([view.getInt16(44, true), view.getInt16(46, true)]).toEqual([
    32_767, -32_767,
  ]);
});

test('the length of a recording is read from its WAV file', () => {
  expect(wavSeconds(encodeWav(new Float32Array(12_000), 8_000))).toBe(1.5);
});

test('parts of the file that are not sound are skipped over', () => {
  const plain = encodeWav(new Float32Array(8_000), 8_000);
  // A "LIST" part of five bytes, padded to six, between the format and the sound.
  const note = [76, 73, 83, 84, 5, 0, 0, 0, 1, 2, 3, 4, 5, 0];
  const file = new Uint8Array([
    ...plain.subarray(0, 36),
    ...note,
    ...plain.subarray(36),
  ]);

  expect(wavSeconds(file)).toBe(1);
});

test('a file cut short is as long as the sound it still holds', () => {
  const whole = encodeWav(new Float32Array(16_000), 8_000);

  expect(wavSeconds(whole.subarray(0, 44 + 16_000))).toBe(1);
});

test('bytes that are not a WAV file have no length', () => {
  expect(wavSeconds(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  expect(wavSeconds(new TextEncoder().encode('RIFF....WAVE'))).toBeUndefined();
  expect(wavSeconds(new Uint8Array(64))).toBeUndefined();
});
