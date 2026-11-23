import { expect, test } from 'vitest';
import type { Message } from '../../shared/api.ts';
import { buildPrompt } from './prompt.ts';

const character = { name: 'Mara', persona: 'Keeper of the lighthouse.' };
const scenario = { title: 'The Storm', premise: 'A stranger knocks.' };

function conversation(...turns: [Message['role'], string][]): Message[] {
  return turns.map(([role, content], index) => ({
    id: index + 1,
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
}

test('the instructions put the character first, then the scenario', () => {
  const { instructions } = buildPrompt(character, scenario, []);

  const persona = instructions.indexOf('Keeper of the lighthouse.');
  const premise = instructions.indexOf('A stranger knocks.');
  expect(instructions.startsWith('# Character: Mara')).toBe(true);
  expect(persona).toBeGreaterThan(0);
  expect(instructions.indexOf('# Scenario: The Storm')).toBeGreaterThan(
    persona,
  );
  expect(premise).toBeGreaterThan(instructions.indexOf('# Scenario'));
});

test('the instructions are the same on every turn of a chat', () => {
  const first = buildPrompt(
    character,
    scenario,
    conversation(['user', 'Hello?']),
  );
  const later = buildPrompt(
    character,
    scenario,
    conversation(
      ['user', 'Hello?'],
      ['assistant', 'Who goes there?'],
      ['user', 'A traveller.'],
    ),
  );

  expect(later.instructions).toBe(first.instructions);
});

test('the conversation follows, oldest first, with only roles and text', () => {
  const { messages } = buildPrompt(
    character,
    scenario,
    conversation(['user', 'Hello?'], ['assistant', 'Who goes there?']),
  );

  expect(messages).toEqual([
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Who goes there?' },
  ]);
});
