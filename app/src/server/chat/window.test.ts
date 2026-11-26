import { describe, expect, test } from 'vitest';
import type { TextBackend } from '../../shared/api.ts';
import type { LoadedModel } from './koboldcpp.ts';
import { type ModelProfile, presetFor } from './profiles.ts';
import { estimateTokens } from './trim.ts';
import {
  conversationWindow,
  MESSAGE_FRAMING_TOKENS,
  SAFETY_MARGIN_TOKENS,
} from './window.ts';

const MODEL: LoadedModel = {
  id: 'koboldcpp/gemma-4-31B-it-Q4_K_S',
  contextLength: 2000,
};

/** A message whose text KoboldCpp counts as `tokens` tokens: one per word. */
const words = (tokens: number): { content: string } => ({
  content: Array<string>(tokens).fill('word').join(' '),
});

function setUp(
  options: {
    backend?: TextBackend;
    model?: LoadedModel | undefined;
    profile?: Partial<ModelProfile>;
    counting?: boolean;
  } = {},
) {
  let model = 'model' in options ? options.model : MODEL;
  const counted: string[] = [];
  const window = conversationWindow({
    backend: () => options.backend ?? 'koboldcpp',
    budget: () => 300,
    koboldcpp: {
      knownModel: () => model,
      loadedModel: () =>
        model === undefined
          ? Promise.reject(new Error('none'))
          : Promise.resolve(model),
      profileOf: (id) => ({
        ...presetFor(id).profile,
        maxReplyTokens: 500,
        ...options.profile,
      }),
      countTokens: (text) => {
        if (options.counting === false) {
          return Promise.reject(new Error('no tokencount'));
        }
        counted.push(text);
        return Promise.resolve(text === '' ? 0 : text.split(' ').length);
      },
    },
  });
  return {
    window,
    counted,
    load(next: LoadedModel) {
      model = next;
    },
  };
}

/** The tokens a conversation of `counts` leaves for itself: what is sent fits this. */
function room(contextLength: number, instructions: number): number {
  return (
    contextLength -
    500 -
    instructions -
    MESSAGE_FRAMING_TOKENS -
    SAFETY_MARGIN_TOKENS
  );
}

describe('with OpenAI', () => {
  test('the conversation budget setting applies, with estimated tokens', () => {
    const { window } = setUp({ backend: 'openai' });
    const message = { content: 'x'.repeat(400) };
    const conversation = [message, message, message, message];

    // Each message is estimated at 104 tokens; 300 fits two.
    expect(estimateTokens(message.content)).toBe(104);
    expect(window.notSent('Be Mara.', conversation)).toBe(2);
  });
});

describe('with KoboldCpp', () => {
  test("what is sent fits the model's context length, less the reply and the instructions", async () => {
    const { window } = setUp();
    const instructions = words(100).content;
    const message = words(200);
    const conversation = Array.from({ length: 12 }, () => message);
    await window.prepare(instructions, conversation);

    const notSent = window.notSent(instructions, conversation);

    const sent = conversation.length - notSent;
    expect(sent * (200 + MESSAGE_FRAMING_TOKENS)).toBeLessThanOrEqual(
      room(2000, 100),
    );
    expect(sent).toBeGreaterThan(0);
  });

  test("the profile's context length is used in place of KoboldCpp's", async () => {
    const { window } = setUp({ profile: { contextLength: 1200 } });
    const conversation = Array.from({ length: 10 }, () => words(100));
    await window.prepare('', conversation);

    const sent = conversation.length - window.notSent('', conversation);

    expect(sent * (100 + MESSAGE_FRAMING_TOKENS)).toBeLessThanOrEqual(
      room(1200, 0),
    );
  });

  test('each text is counted once, and again only for another model', async () => {
    const setup = setUp();
    const { window, counted } = setup;
    const conversation = [words(3), words(4)];

    await window.prepare('Be Mara.', conversation);
    await window.prepare('Be Mara.', [...conversation, words(5)]);
    expect(counted).toHaveLength(4);

    setup.load({ id: 'koboldcpp/Qwen3-8B-Q4_K_M', contextLength: 4096 });
    await window.prepare('Be Mara.', conversation);
    expect(counted).toHaveLength(7);
  });

  test('without token counting, a cautious estimate keeps what is sent within the context', async () => {
    const { window } = setUp({ counting: false });
    // 1,000 characters: KoboldCpp would count about 250 tokens.
    const message = { content: 'abcd'.repeat(250) };
    const conversation = Array.from({ length: 10 }, () => message);
    await window.prepare('', conversation);

    const sent = conversation.length - window.notSent('', conversation);

    expect(sent * (334 + MESSAGE_FRAMING_TOKENS)).toBeLessThanOrEqual(
      room(2000, 0),
    );
    expect(sent).toBeGreaterThan(0);
  });

  test('before the loaded model is known, the conversation budget setting applies', () => {
    const { window } = setUp({ model: undefined });
    const message = { content: 'x'.repeat(400) };

    expect(window.notSent('', [message, message, message, message])).toBe(2);
  });

  test('once the conversation is too long, the start moves a block at a time', async () => {
    const { window } = setUp();
    const starts: number[] = [];
    const conversation: { content: string }[] = [];
    for (let turn = 0; turn < 40; turn++) {
      conversation.push(words(50));
      await window.prepare('', conversation);
      starts.push(window.notSent('', conversation));
    }

    const moves = starts.filter((start, turn) => start !== starts[turn - 1]);
    // It moves, but far less often than once a turn after it first moves.
    const firstMove = starts.findIndex((start) => start > 0);
    expect(firstMove).toBeGreaterThan(0);
    expect(moves.length).toBeGreaterThan(2);
    expect(moves.length).toBeLessThan((40 - firstMove) / 3);
  });
});
