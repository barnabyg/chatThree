// How a chat becomes a request to the provider.
//
// The instructions are the character, then the scenario, and depend on
// nothing else: the same chat sends the same text on every turn. Providers
// cache a prompt by its leading text, so a fixed prefix is what makes every
// turn after the first cheaper and faster.

import type { Message } from '../../shared/api.ts';
import type { PromptMessage } from './provider.ts';

export interface PromptCharacter {
  name: string;
  persona: string;
}

export interface PromptScenario {
  title: string;
  premise: string;
}

export interface Prompt {
  instructions: string;
  messages: PromptMessage[];
}

/** The fixed prefix: the character first, then the scenario. */
export function buildInstructions(
  character: PromptCharacter,
  scenario: PromptScenario,
): string {
  return [
    `# Character: ${character.name}`,
    `You are ${character.name}, a character in an interactive story. The user plays the other part.`,
    character.persona,
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
): Prompt {
  return {
    instructions: buildInstructions(character, scenario),
    messages: conversation.map(({ role, content }) => ({ role, content })),
  };
}
