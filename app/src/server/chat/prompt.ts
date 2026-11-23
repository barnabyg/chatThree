// How a chat becomes a request to the provider.
//
// The instructions are the character, then the scenario, and depend on
// nothing else: the same chat sends the same text on every turn. Providers
// cache a prompt by its leading text, so a fixed prefix is what makes every
// turn after the first cheaper and faster. A long conversation is cut to a
// token budget from its oldest end (trim.ts); the prefix is never cut.

import type { CharacterInput, Message } from '../../shared/api.ts';
import type { PromptMessage } from './provider.ts';
import { countNotSent } from './trim.ts';

export type PromptCharacter = Pick<
  CharacterInput,
  'name' | 'persona' | 'speakingStyle' | 'exampleDialogue'
>;

export interface PromptScenario {
  title: string;
  premise: string;
}

export interface Prompt {
  instructions: string;
  /** The newest part of the conversation that fits the token budget. */
  messages: PromptMessage[];
}

/** A headed section, or nothing when the user left that part blank. */
function section(heading: string, text: string): string[] {
  return text.trim() === '' ? [] : [`${heading}\n${text.trim()}`];
}

/** The fixed prefix: the character first, then the scenario. */
export function buildInstructions(
  character: PromptCharacter,
  scenario: PromptScenario,
): string {
  return [
    `# Character: ${character.name}`,
    `You are ${character.name}, a character in an interactive story. The user plays the other part.`,
    ...section('## Persona', character.persona),
    ...section('## Speaking style', character.speakingStyle),
    ...section('## Example dialogue', character.exampleDialogue),
    `# Scenario: ${scenario.title}`,
    scenario.premise,
    '# How to reply',
    `Reply only as ${character.name}, in character, with what ${character.name} says and does next. Never speak or act for the user, and never step outside the story.`,
  ].join('\n\n');
}

export function buildPrompt(
  character: PromptCharacter,
  scenario: PromptScenario,
  conversation: readonly Message[],
  tokenBudget: number,
): Prompt {
  return {
    instructions: buildInstructions(character, scenario),
    messages: conversation
      .slice(countNotSent(conversation, tokenBudget))
      .map(({ role, content }) => ({ role, content })),
  };
}
