// WAV files: the format the engine speaks in and clones voices from.

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** The four characters at `offset`, which is how a WAV file names its parts. */
function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/**
 * How long the recording in a WAV file lasts, in seconds, or `undefined` if
 * the bytes are not a WAV file.
 */
export function wavSeconds(bytes: Uint8Array): number | undefined {
  if (
    bytes.length < 12 ||
    tag(bytes, 0) !== 'RIFF' ||
    tag(bytes, 8) !== 'WAVE'
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let bytesPerSecond: number | undefined;
  // The file is a list of parts, each a name, a size and that many bytes.
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (name === 'fmt ' && start + 12 <= bytes.length) {
      bytesPerSecond = view.getUint32(start + 8, true);
    } else if (name === 'data') {
      if (bytesPerSecond === undefined || bytesPerSecond === 0)
        return undefined;
      // A recorder that could not go back to fill in the size leaves it wrong.
      return Math.min(size, bytes.length - start) / bytesPerSecond;
    }
    // Parts are padded to an even length.
    offset = start + size + (size % 2);
  }
  return undefined;
}

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
