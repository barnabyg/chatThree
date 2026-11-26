// How much of a conversation is sent: its window.
//
// With OpenAI, the newest messages that fit the Conversation budget setting,
// counted at about four characters per token (trim.ts).
//
// With KoboldCpp, the window follows the loaded model's context length: what
// is left of it after the reply (`maxReplyTokens`), the instructions and a
// safety margin. Texts are counted by KoboldCpp's own tokeniser
// (`/api/extra/tokencount`, about 40 ms for 15,000 tokens, #33), each once.
// A text not yet counted, or a KoboldCpp that cannot count, is estimated at a
// cautious three characters per token. KoboldCpp reads the whole prompt again
// whenever the oldest message sent changes, which costs seconds on a long
// chat, so the window's start moves a block at a time (`notSentInBlocks`).

import type { TextBackend } from '../../shared/api.ts';
import type { KoboldCppProvider, LoadedModel } from './koboldcpp.ts';
import { countNotSent, notSentInBlocks } from './trim.ts';

/** Tokens a message costs beyond its text, for its role and the template's marks. */
export const MESSAGE_FRAMING_TOKENS = 10;
/** Tokens kept free for what the counts miss, such as the template's own text. */
export const SAFETY_MARGIN_TOKENS = 64;
/** The cautious estimate for a text KoboldCpp has not counted. */
const CAUTIOUS_CHARACTERS_PER_TOKEN = 3;
/** The start of the window moves at least this share of the budget at a time. */
const BLOCK_SHARE = 0.25;
/** Texts counted at once. */
const COUNTING_AT_ONCE = 4;
/** The most counts kept: beyond this, the oldest are forgotten. */
const MOST_COUNTS = 20_000;

export interface ConversationWindow {
  /**
   * How many messages, from the oldest, are left out of a request with
   * `instructions`, from what is known now: it never waits.
   */
  notSent(
    instructions: string,
    conversation: readonly { content: string }[],
  ): number;
  /**
   * Find out what `notSent` needs to be exact: with KoboldCpp, the loaded
   * model and the token count of each text not counted yet. Never throws: a
   * count that cannot be had is estimated.
   */
  prepare(
    instructions: string,
    conversation: readonly { content: string }[],
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WindowOptions {
  backend: () => TextBackend;
  /** The Conversation budget setting, for OpenAI. */
  budget: () => number;
  koboldcpp: Pick<
    KoboldCppProvider,
    'knownModel' | 'loadedModel' | 'profileOf' | 'countTokens'
  >;
}

export function conversationWindow(options: WindowOptions): ConversationWindow {
  /** Token counts by text, for the model `countsFor`. */
  let counts = new Map<string, number>();
  let countsFor: string | undefined;
  /**
   * The model last known to be loaded. KoboldCpp's provider forgets it after
   * a failed request, until it is found out again; the window goes on as if
   * it were still loaded meanwhile.
   */
  let lastKnown: LoadedModel | undefined;

  const forModel = (id: string): void => {
    if (countsFor === id) return;
    counts = new Map();
    countsFor = id;
  };

  const tokens = (text: string): number =>
    counts.get(text) ?? Math.ceil(text.length / CAUTIOUS_CHARACTERS_PER_TOKEN);

  return {
    notSent(instructions, conversation) {
      if (options.backend() === 'koboldcpp') {
        lastKnown = options.koboldcpp.knownModel() ?? lastKnown;
      }
      const model = options.backend() === 'koboldcpp' ? lastKnown : undefined;
      if (model === undefined) {
        return countNotSent(conversation, options.budget());
      }
      forModel(model.id);
      const profile = options.koboldcpp.profileOf(model.id);
      const budget = Math.max(
        0,
        (profile.contextLength ?? model.contextLength) -
          profile.maxReplyTokens -
          tokens(instructions) -
          MESSAGE_FRAMING_TOKENS -
          SAFETY_MARGIN_TOKENS,
      );
      return notSentInBlocks(
        conversation.map(
          ({ content }) => tokens(content) + MESSAGE_FRAMING_TOKENS,
        ),
        budget,
        Math.floor(budget * BLOCK_SHARE),
      );
    },

    async prepare(instructions, conversation, signal) {
      if (options.backend() !== 'koboldcpp') return;
      let model;
      try {
        model = await options.koboldcpp.loadedModel();
      } catch {
        // The request itself will say what is wrong.
        return;
      }
      lastKnown = model;
      forModel(model.id);
      const waiting = [
        ...new Set([instructions, ...conversation.map((m) => m.content)]),
      ].filter((text) => !counts.has(text));
      /** Whether counting has failed: it is not tried again this time. */
      let cannotCount = false;
      const next = async (): Promise<void> => {
        for (;;) {
          const text = waiting.shift();
          if (text === undefined || cannotCount || signal?.aborted === true) {
            return;
          }
          try {
            const count = await options.koboldcpp.countTokens(text, signal);
            if (countsFor !== model.id) return;
            counts.set(text, count);
            if (counts.size > MOST_COUNTS) {
              const oldest = counts.keys().next().value;
              if (oldest !== undefined) counts.delete(oldest);
            }
          } catch {
            cannotCount = true;
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: COUNTING_AT_ONCE }, () => next()));
    },
  };
}
