import { expect, test } from 'vitest';
import { speechQueue } from './queue.ts';

/** A step the test finishes by hand: a clip being made, or being played. */
interface Step {
  text: string;
  signal: AbortSignal;
  finish(): void;
  fail(error: Error): void;
}

/** Let everything that is ready to happen, happen. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function harness() {
  const requested: Step[] = [];
  const playing: Step[] = [];
  const log: string[] = [];
  const step = (list: Step[], text: string, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      list.push({
        text,
        signal,
        finish() {
          resolve(text);
        },
        fail: reject,
      });
    });
  const queue = speechQueue<string>({
    synthesise(text, signal) {
      log.push(`request ${text}`);
      return step(requested, text, signal);
    },
    async play(clip, signal) {
      log.push(`play ${clip}`);
      await step(playing, clip, signal);
      if (!signal.aborted) log.push(`played ${clip}`);
    },
    onSpeakingChange(speaking) {
      log.push(speaking ? 'speaking' : 'silent');
    },
    onFailure(message) {
      log.push(`failure: ${message}`);
    },
  });
  return { queue, requested, playing, log };
}

test('sentences are requested one at a time and played in the order they were said', async () => {
  const { queue, requested, playing, log } = harness();

  queue.say('One.');
  queue.say('Two.');
  await settle();
  expect(log).toEqual(['speaking', 'request One.']);

  requested[0]?.finish();
  await settle();
  playing[0]?.finish();
  await settle();
  requested[1]?.finish();
  await settle();
  playing[1]?.finish();
  await settle();

  const of = (kind: string): string[] =>
    log.filter((entry) => entry.startsWith(kind));
  expect(of('request')).toEqual(['request One.', 'request Two.']);
  expect(of('play')).toEqual([
    'play One.',
    'played One.',
    'play Two.',
    'played Two.',
  ]);
  expect([log.at(0), log.at(-1)]).toEqual(['speaking', 'silent']);
});

test('the next clip is made while the one before it plays, so there is no gap to wait through', async () => {
  const { queue, requested, playing } = harness();
  queue.say('One.');
  queue.say('Two.');
  await settle();
  requested[0]?.finish();
  await settle();

  expect(playing.map(({ text }) => text)).toEqual(['One.']);
  expect(requested.map(({ text }) => text)).toEqual(['One.', 'Two.']);
});

test('a clip that is ready early waits for the one before it to finish playing', async () => {
  const { queue, requested, playing } = harness();
  queue.say('One.');
  queue.say('Two.');
  await settle();
  requested[0]?.finish();
  await settle();
  requested[1]?.finish();
  await settle();

  expect(playing.map(({ text }) => text)).toEqual(['One.']);

  playing[0]?.finish();
  await settle();
  expect(playing.map(({ text }) => text)).toEqual(['One.', 'Two.']);
});

test('stopping halts what is playing and drops what has not been played', async () => {
  const { queue, requested, playing, log } = harness();
  queue.say('One.');
  queue.say('Two.');
  queue.say('Three.');
  await settle();
  requested[0]?.finish();
  await settle();

  queue.stop();
  await settle();

  expect(playing[0]?.signal.aborted).toBe(true);
  expect(requested[1]?.signal.aborted).toBe(true);
  expect(log.at(-1)).toBe('silent');

  // Whatever was in flight finishes into nothing.
  playing[0]?.finish();
  requested[1]?.finish();
  await settle();
  expect(requested.map(({ text }) => text)).toEqual(['One.', 'Two.']);
  expect(playing.map(({ text }) => text)).toEqual(['One.']);
  expect(log.at(-1)).toBe('silent');
});

test('speaking can start again after a stop', async () => {
  const { queue, requested, playing, log } = harness();
  queue.say('One.');
  await settle();
  queue.stop();

  queue.say('Again.');
  await settle();
  requested[1]?.finish();
  await settle();
  playing[0]?.finish();
  await settle();

  expect(log.slice(-5)).toEqual([
    'speaking',
    'request Again.',
    'play Again.',
    'played Again.',
    'silent',
  ]);
});

test('a clip that cannot be made is reported once, after what came before it has played, and ends the speaking', async () => {
  const { queue, requested, playing, log } = harness();
  queue.say('One.');
  queue.say('Two.');
  queue.say('Three.');
  await settle();
  requested[0]?.finish();
  await settle();
  requested[1]?.fail(new Error('Speech is unavailable.'));
  await settle();
  expect(log).not.toContain('failure: Speech is unavailable.');

  playing[0]?.finish();
  await settle();

  expect(log.slice(-3)).toEqual([
    'played One.',
    'failure: Speech is unavailable.',
    'silent',
  ]);
  expect(requested.map(({ text }) => text)).toEqual(['One.', 'Two.']);
});

test('a clip that cannot be played is reported too', async () => {
  const { queue, requested, playing, log } = harness();
  queue.say('One.');
  await settle();
  requested[0]?.finish();
  await settle();

  playing[0]?.fail(new Error('The browser did not allow sound to play.'));
  await settle();

  expect(log.slice(-2)).toEqual([
    'failure: The browser did not allow sound to play.',
    'silent',
  ]);
});
