import { expect, test } from 'vitest';
import { mixToMono } from './recording.ts';

test('a stereo recording becomes one channel, the average of the two', () => {
  const left = new Float32Array([1, 0.5, -1]);
  const right = new Float32Array([0, 0.5, -0.5]);

  expect([...mixToMono([left, right], 100)]).toEqual([0.5, 0.5, -0.75]);
});

test('a mono recording is kept as it is', () => {
  const only = new Float32Array([0.25, -0.5]);

  expect([...mixToMono([only], 100)]).toEqual([0.25, -0.5]);
});

test('a recording longer than is kept is cut at the limit', () => {
  const long = new Float32Array([0.5, 0.25, 0.125, 1]);

  expect([...mixToMono([long], 2)]).toEqual([0.5, 0.25]);
});
