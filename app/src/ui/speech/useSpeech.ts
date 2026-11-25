// Speaking replies aloud on the chat page.

import { useEffect, useState } from 'react';
import type { SpeechScope } from '../../shared/api.ts';
import { api } from '../api.ts';
import { playClip } from './playClip.ts';
import { speechQueue } from './queue.ts';
import { speechSplitter } from './sentences.ts';

/** What is needed to speak one reply. */
export interface ReplyToSpeak {
  scope: SpeechScope;
  /** Whose reply it is: it is spoken in that character's voice. */
  characterId: string;
  /** The character's message before this one, if there was one. */
  previous: string | undefined;
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
  begin: (reply: ReplyToSpeak) => ReplySpeech;
  /** Speak a whole message again, in place of whatever was being spoken. */
  replay: (reply: ReplyToSpeak, text: string) => void;
  /** Halt playback and drop what has not been played. */
  stop: () => void;
}

export function useSpeech(): Speech {
  const [speaking, setSpeaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [control] = useState(() => {
    /** The reply being spoken. A reply that was stopped has nothing more to say. */
    let current: object | null = null;
    /** Whose voice the reply being spoken is in. */
    let speaker: string | undefined;
    const queue = speechQueue<Blob>({
      synthesise: (text, signal) =>
        api.speak(
          { text, ...(speaker !== undefined && { characterId: speaker }) },
          signal,
        ),
      play: playClip,
      onSpeakingChange: setSpeaking,
      onFailure: (message) => {
        // What is left of the reply is not spoken either.
        current = null;
        setProblem(message);
      },
    });
    return {
      begin: ({ scope, characterId, previous }: ReplyToSpeak): ReplySpeech => {
        queue.stop();
        speaker = characterId;
        setProblem(null);
        const reply = {};
        current = reply;
        const splitter = speechSplitter(scope, { previous });
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

  const replay = (reply: ReplyToSpeak, text: string): void => {
    const spoken = control.begin(reply);
    spoken.push(text);
    spoken.end();
  };

  return {
    speaking,
    problem,
    begin: control.begin,
    replay,
    stop: control.stop,
  };
}
