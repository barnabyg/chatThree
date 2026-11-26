import { describe, expect, test } from 'vitest';
import { ThinkingFilter, stripThinking } from './thinking.ts';

const TAGS = { mode: 'strip', open: '<think>', close: '</think>' } as const;

/** What the filter passes on for `chunks`, and whether it saw thinking. */
function run(
  chunks: string[],
  thinking: ConstructorParameters<typeof ThinkingFilter>[0] = TAGS,
): { text: string; thought: boolean } {
  const filter = new ThinkingFilter(thinking);
  let text = '';
  for (const chunk of chunks) text += filter.push(chunk);
  text += filter.end();
  return { text, thought: filter.thinking };
}

/** `text` cut into two chunks at every position. */
function everySplit(text: string): string[][] {
  return Array.from({ length: text.length + 1 }, (_, at) => [
    text.slice(0, at),
    text.slice(at),
  ]);
}

describe('a model that thinks between tags', () => {
  test('drops the thinking and the whitespace after it', () => {
    expect(
      run(['<think>The user wants tea.</think>\n\n"Sit down," she says.']),
    ).toEqual({ text: '"Sit down," she says.', thought: true });
  });

  test('drops the thinking when the tags are split across chunks at any point', () => {
    const reply = '<think>Hmm.</think>\n\nHello there.';
    for (const chunks of everySplit(reply)) {
      expect(run(chunks).text, JSON.stringify(chunks)).toBe('Hello there.');
    }
    expect(
      run(['<thi', 'nk>Hm', 'm.</th', 'ink>', '\n', '\nHello', ' there.']).text,
    ).toBe('Hello there.');
  });

  test('drops everything before the close tag when the open tag is missing', () => {
    for (const chunks of everySplit('The user wants tea.</think>\n\nHello.')) {
      expect(run(chunks), JSON.stringify(chunks)).toEqual({
        text: 'Hello.',
        thought: true,
      });
    }
  });

  test('passes on a reply with no tags at all, once it ends', () => {
    expect(run(['Hello', ' there.'])).toEqual({
      text: 'Hello there.',
      thought: true,
    });
  });

  test('treats a reply that is all thinking as empty', () => {
    expect(run(['<think>The user', ' wants tea and'])).toEqual({
      text: '',
      thought: true,
    });
  });

  test('passes on text that only looks like a tag', () => {
    expect(run(['<thinking about it> she said']).text).toBe(
      '<thinking about it> she said',
    );
    expect(run(['<thi']).text).toBe('<thi');
    expect(run(['<think>x</think>A <think> later.']).text).toBe(
      'A <think> later.',
    );
  });

  test('streams the reply as it arrives once the thinking has ended', () => {
    const filter = new ThinkingFilter(TAGS);
    expect(filter.push('<think>Hmm.')).toBe('');
    expect(filter.thinking).toBe(true);
    expect(filter.push('</think>\n\nHel')).toBe('Hel');
    expect(filter.push('lo.')).toBe('lo.');
    expect(filter.end()).toBe('');
  });

  test('streams at once after thinking that came separately, without the leading whitespace', () => {
    const filter = new ThinkingFilter(TAGS);
    filter.reasoned();
    expect(filter.thinking).toBe(true);
    expect(filter.push('\n\n')).toBe('');
    expect(filter.push('Hello')).toBe('Hello');
    expect(filter.push(' there.')).toBe(' there.');
  });
});

describe('a model that does not think', () => {
  test('streams unchanged, tags and all', () => {
    const none = { mode: 'none' } as const;
    const filter = new ThinkingFilter(none);
    expect(filter.push('<think>x</think>')).toBe('<think>x</think>');
    expect(filter.push(' Hello.')).toBe(' Hello.');
    expect(filter.thinking).toBe(false);
  });

  test('drops only the whitespace before a reply whose thinking came separately', () => {
    const filter = new ThinkingFilter({ mode: 'none' });
    filter.reasoned();
    expect(filter.push('\n\nHi')).toBe('Hi');
  });
});

test('stripThinking cleans a whole answer', () => {
  expect(stripThinking('<think>\nPlan it.</think>\n{"a":1}', TAGS)).toBe(
    '{"a":1}',
  );
  expect(stripThinking('<think>\nThe user keep', TAGS)).toBe('');
  expect(stripThinking('<think>x</think>{}', { mode: 'none' })).toBe(
    '<think>x</think>{}',
  );
});
