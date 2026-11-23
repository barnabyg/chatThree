import { expect, test } from 'vitest';
import { countNotSent, estimateTokens } from './trim.ts';

// A message of 36 characters is estimated at 36 / 4 + 4 = 13 tokens.
const message = (label: string) => ({ content: label.padEnd(36, '.') });
const MESSAGE_TOKENS = 13;

test('a message is estimated at a token per four characters, plus four for its framing', () => {
  expect(estimateTokens('')).toBe(4);
  expect(estimateTokens('abcd')).toBe(5);
  expect(estimateTokens('abcde')).toBe(6);
  expect(estimateTokens(message('a').content)).toBe(MESSAGE_TOKENS);
});

test('a conversation that fits the budget is sent whole', () => {
  const conversation = [message('one'), message('two'), message('three')];

  expect(countNotSent(conversation, 3 * MESSAGE_TOKENS)).toBe(0);
  expect(countNotSent(conversation, 10_000)).toBe(0);
});

test('a conversation one token over the budget loses its oldest message', () => {
  const conversation = [message('one'), message('two'), message('three')];

  expect(countNotSent(conversation, 3 * MESSAGE_TOKENS - 1)).toBe(1);
});

test('the oldest messages are left out first, as many as it takes', () => {
  const conversation = [
    message('one'),
    message('two'),
    message('three'),
    message('four'),
    message('five'),
  ];

  expect(countNotSent(conversation, 2 * MESSAGE_TOKENS)).toBe(3);
  expect(countNotSent(conversation, 2 * MESSAGE_TOKENS + 5)).toBe(3);
});

test('a long old message is left out even though newer short ones fit', () => {
  const conversation = [
    { content: 'x'.repeat(4_000) },
    message('two'),
    message('three'),
  ];

  expect(countNotSent(conversation, 100)).toBe(1);
});

test('nothing older is sent once a message does not fit, even if an older one would', () => {
  const conversation = [
    message('one'),
    { content: 'x'.repeat(4_000) },
    message('three'),
  ];

  expect(countNotSent(conversation, 2 * MESSAGE_TOKENS)).toBe(2);
});

test('the newest message is always sent, even when it alone is over the budget', () => {
  const conversation = [message('one'), { content: 'x'.repeat(4_000) }];

  expect(countNotSent(conversation, 10)).toBe(1);
});

test('an empty conversation leaves nothing out', () => {
  expect(countNotSent([], 100)).toBe(0);
});
