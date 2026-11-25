// Whether a voice can be cloned from a clip. Checked by the server when a
// clip is uploaded, and by the browser for a new character's clip, which is
// held until the character is saved.

import { MIN_VOICE_SECONDS } from './api.ts';
import { wavSeconds } from './wav.ts';

/** Why a voice cannot be cloned from `clip`, or `undefined` if it can. */
export function voiceClipProblem(clip: Uint8Array): string | undefined {
  const seconds = wavSeconds(clip);
  if (seconds === undefined) return 'A voice clip must be a WAV recording.';
  if (seconds <= MIN_VOICE_SECONDS) {
    return `That recording is ${seconds.toFixed(1)} seconds long. A voice clip must be longer than ${String(MIN_VOICE_SECONDS)} seconds.`;
  }
  return undefined;
}
