// Turning a recording the user picks into the clip a voice is cloned from.
//
// The browser reads whatever formats it can play (WAV, MP3, M4A and others)
// and the clip is sent on as a short mono WAV file, which is the one format
// the server and the engine then have to understand.

import { encodeWav } from '../../shared/wav.ts';

/** The engine clones a voice from the start of a clip, so no more is kept. */
export const MAX_VOICE_SECONDS = 30;
/** The rate the engine's speech model works at; more would be thrown away. */
const VOICE_SAMPLE_RATE = 24_000;

/** One channel that is the average of `channels`, cut to `maxSamples`. */
export function mixToMono(
  channels: readonly Float32Array[],
  maxSamples: number,
): Float32Array {
  const length = Math.min(maxSamples, channels[0]?.length ?? 0);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) {
      mono[index] =
        (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length;
    }
  }
  return mono;
}

/** The recording in `file` as a voice clip: a mono WAV file of half a minute at most. */
export async function voiceClip(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  // Decoding needs no sound device, and resamples to the rate asked for.
  const decoder = new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE);
  let audio: AudioBuffer;
  try {
    audio = await decoder.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error(
      'That file is not a recording this browser can read. Try a WAV, MP3 or M4A file.',
    );
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
    audio.getChannelData(index),
  );
  return encodeWav(
    mixToMono(channels, MAX_VOICE_SECONDS * audio.sampleRate),
    audio.sampleRate,
  );
}
