import { expect, test } from 'vitest';
import { encodeWav } from './wav.ts';

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
