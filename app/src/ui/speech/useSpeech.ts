// Speaking replies aloud on the chat page.

import { useEffect, useState } from 'react';
import type { SpeechScope } from '../../shared/api.ts';
import { api } from '../api.ts';
import { speechQueue } from './queue.ts';
import { speechSplitter } from './sentences.ts';

/** Play one clip to its end, or until `signal` aborts. */
function playClip(clip: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(clip);
    const audio = new Audio(url);
    let over = false;
    const finish = (failure?: Error): void => {
      if (over) return;
      over = true;
      signal.removeEventListener('abort', halt);
      URL.revokeObjectURL(url);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const halt = (): void => {
      audio.pause();
      finish();
    };
    signal.addEventListener('abort', halt, { once: true });
    audio.addEventListener('ended', () => {
      finish();
    });
    audio.addEventListener('error', () => {
      finish(
        new Error('Speech is unavailable: the browser could not play it.'),
      );
    });
    audio.play().catch(() => {
      finish(
        new Error(
          'Speech is unavailable: the browser did not allow sound to play.',
        ),
      );
    });
  });
}

/** Takes a reply's text as it arrives and has it spoken. */
export interface ReplySpeech {
  push(text: string): void;
  /** The reply is complete: speak what is left of it. */
  end(): void;
}

export interface Speech {
  /** True from the first sentence said until the last has been played. */
  speaking: boolean;
  /** Why the last reply could not be spoken, in words for the user. */
  problem: string | null;
  /** Start speaking a new reply, in place of whatever was being spoken. */
  begin: (scope: SpeechScope) => ReplySpeech;
  /** Halt playback and drop what has not been played. */
  stop: () => void;
}

export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [control] = useState(() => {
    const queue = speechQueue<Blob>({
      synthesise: (text, signal) => api.speak({ text }, signal),
      play: playClip,
      onSpeakingChange: setSpeaking,
      onFailure: setProblem,
    });
    /** The reply being spoken. A reply that was stopped has nothing more to say. */
    let current: object | null = null;
    return {
      begin: (scope: SpeechScope): ReplySpeech => {
        queue.stop();
        setProblem(null);
        const reply = {};
        current = reply;
        const splitter = speechSplitter(scope);
        const say = (sentences: string[]): void => {
          if (current !== reply) return;
          for (const sentence of sentences) queue.say(sentence);
        };
        return {
          push(text) {
            say(splitter.push(text));
          },
          end() {
            say(splitter.end());
          },
        };
      },
      stop: (): void => {
        current = null;
        queue.stop();
      },
    };
  });

  // Leaving the page ends what it was saying.
  useEffect(() => control.stop, [control]);

  return { speaking, problem, begin: control.begin, stop: control.stop };
}
