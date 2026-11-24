import { encodeWav } from '../src/shared/wav.ts';

const SAMPLE_RATE = 16_000;

/**
 * A recording of the given length, as a WAV file: a steady tone. `pitch`,
 * in hertz, makes two recordings differ.
 */
export function recording(
  seconds: number,
  pitch = 220,
): Uint8Array<ArrayBuffer> {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      0.2 * Math.sin((index * 2 * Math.PI * pitch) / SAMPLE_RATE);
  }
  return encodeWav(samples, SAMPLE_RATE);
}
