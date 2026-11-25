import { expect, test } from 'vitest';
import type { Message } from '../../shared/api.ts';
import { DEFAULT_REPLY_PROMPT } from '../../shared/replyPrompt.ts';
import { buildPrompt } from './prompt.ts';

const character = {
  name: 'Mara',
  persona: 'Keeper of the lighthouse.',
  speakingStyle: 'Plain and dry.',
  exampleDialogue: 'User: Rough night?\nMara: I have seen worse.',
};
const scenario = {
  title: 'The Storm',
  premise: 'A stranger knocks.',
  startingLocation: {
    name: 'The lighthouse kitchen',
    description: 'Warm, low-beamed, smelling of tar.',
  },
};
const player = { name: 'Wren', background: 'A courier with a secret.' };
/** Far more than any conversation in these tests. */
const BUDGET = 10_000;

function conversation(...turns: [Message['role'], string][]): Message[] {
  return turns.map(([role, content], index) => ({
    id: index + 1,
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

test('the instructions put the character first, then the scenario', () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  const persona = instructions.indexOf('Keeper of the lighthouse.');
  const premise = instructions.indexOf('A stranger knocks.');
  expect(instructions.startsWith('# Character: Mara')).toBe(true);
  expect(persona).toBeGreaterThan(0);
  expect(instructions.indexOf('# Scenario: The Storm')).toBeGreaterThan(
    persona,
  );
  expect(premise).toBeGreaterThan(instructions.indexOf('# Scenario'));
});

test("the character's persona, speaking style and example dialogue come before the scenario, in that order", () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  const positions = [
    'Keeper of the lighthouse.',
    'Plain and dry.',
    'Mara: I have seen worse.',
    '# Scenario: The Storm',
  ].map((part) => instructions.indexOf(part));
  expect(positions).not.toContain(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test('a part of the character left blank has no heading in the instructions', () => {
  const { instructions } = buildPrompt(
    { ...character, speakingStyle: '  ' },
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  expect(instructions).toContain('## Persona');
  expect(instructions).toContain('## Example dialogue');
  expect(instructions).not.toContain('## Speaking style');
});

test("the scenario's premise, the player's part and the starting location follow the character", () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  const positions = [
    '# Character: Mara',
    '# Scenario: The Storm',
    'A stranger knocks.',
    'Wren',
    'A courier with a secret.',
    'The lighthouse kitchen',
    'Warm, low-beamed, smelling of tar.',
  ].map((part) => instructions.indexOf(part));
  expect(positions).not.toContain(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test('a part of the scenario left blank has no heading in the instructions', () => {
  const { instructions } = buildPrompt(
    character,
    {
      ...scenario,
      startingLocation: { name: 'The quay', description: '' },
    },
    { name: '', background: ' ' },
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  expect(instructions).not.toContain('## The part the user plays');
  expect(instructions).toContain('## Where the story begins\nThe quay');
});

test('the instructions are the same on every turn of a chat', () => {
  const first = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    conversation(['user', 'Hello?']),
    BUDGET,
  );
  const later = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    conversation(
      ['user', 'Hello?'],
      ['assistant', 'Who goes there?'],
      ['user', 'A traveller.'],
    ),
    BUDGET,
  );

  expect(later.instructions).toBe(first.instructions);
});

test('the conversation follows, oldest first, with only roles and text', () => {
  const { messages } = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    conversation(['user', 'Hello?'], ['assistant', 'Who goes there?']),
    BUDGET,
  );

  expect(messages).toEqual([
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Who goes there?' },
  ]);
});

test('a conversation over the token budget loses its oldest messages, and nothing else changes', () => {
  // Each message is estimated at 13 tokens (36 characters / 4, plus 4).
  const long = conversation(
    ['user', 'one'.padEnd(36, '.')],
    ['assistant', 'two'.padEnd(36, '.')],
    ['user', 'three'.padEnd(36, '.')],
  );

  const whole = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    long,
    BUDGET,
  );
  const trimmed = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    long,
    26,
  );

  expect(trimmed.messages).toEqual(whole.messages.slice(1));
  expect(trimmed.instructions).toBe(whole.instructions);
});

test('a chat with no player has no part for the user in the instructions', () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    undefined,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  expect(instructions).not.toContain('## The part the user plays');
  expect(instructions).toContain('# Scenario: The Storm');
});

test('the default reply prompt tells the character to reply only as themself', () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    player,
    DEFAULT_REPLY_PROMPT,
    [],
    BUDGET,
  );

  expect(
    instructions.endsWith(
      '# How to reply\n\nReply only as Mara, in character, with what Mara says and does next. Never speak or act for the user, and never step outside the story.',
    ),
  ).toBe(true);
});

test("a chat's own reply prompt takes the default's place, with the character and player named in it", () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    player,
    'Write as {character}, in the third person, and let {user} decide what {user} does.',
    [],
    BUDGET,
  );

  expect(instructions).toContain(
    '# How to reply\n\nWrite as Mara, in the third person, and let Wren decide what Wren does.',
  );
  expect(instructions).not.toContain('Reply only as');
});

test('a reply prompt names the user as "the user" in a chat with no player', () => {
  const { instructions } = buildPrompt(
    character,
    scenario,
    undefined,
    'Let {user} speak for themself.',
    [],
    BUDGET,
  );

  expect(instructions).toContain('Let the user speak for themself.');
});
