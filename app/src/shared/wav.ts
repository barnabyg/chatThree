// WAV files: the format the engine speaks in and clones voices from.

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** Encode mono samples in the range -1..1 as a 16-bit PCM WAV file. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const file = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(file.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // size of the format chunk
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // bytes per second
  view.setUint16(32, BYTES_PER_SAMPLE, true); // bytes per frame
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      HEADER_BYTES + index * BYTES_PER_SAMPLE,
      Math.round(clamped * 0x7fff),
      true,
    );
  });
  return file;
}
