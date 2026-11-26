// How a chat becomes a request to the provider.
//
// The instructions are the character, then the scenario with the user's
// part in it (the chat's player), then how to reply (the chat's reply
// prompt), and depend on nothing else: the same chat sends the same text on
// every turn. Providers
// cache a prompt by its leading text, so a fixed prefix is what makes every
// turn after the first cheaper and faster. A long conversation is cut to a
// token budget from its oldest end (trim.ts); the prefix is never cut.

import type {
  CharacterInput,
  Message,
  PlayerInput,
  ScenarioInput,
} from '../../shared/api.ts';
import {
  DEFAULT_REPLY_PROMPT,
  fillReplyPrompt,
} from '../../shared/replyPrompt.ts';
import type { PromptMessage } from './provider.ts';
import { countNotSent } from './trim.ts';
import type { ConversationWindow } from './window.ts';

export type PromptCharacter = Pick<
  CharacterInput,
  'name' | 'persona' | 'speakingStyle' | 'exampleDialogue'
>;

export type PromptScenario = Pick<
  ScenarioInput,
  'title' | 'premise' | 'startingLocation'
>;

/** Who the user plays, or `undefined` for a chat with no player. */
export type PromptPlayer = PlayerInput | undefined;

/** How the character is told to reply, before its placeholders are filled. */
export type PromptReply = string;

export interface Prompt {
  instructions: string;
  /** The newest part of the conversation that fits the token budget. */
  messages: PromptMessage[];
}

/** A headed section, or nothing when the user left every part of it blank. */
function section(heading: string, ...parts: string[]): string[] {
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('\n');
  return text === '' ? [] : [`${heading}\n${text}`];
}

/** The fixed prefix: the character first, then the scenario, then how to reply. */
export function buildInstructions(
  character: PromptCharacter,
  scenario: PromptScenario,
  player: PromptPlayer,
  replyPrompt: PromptReply = DEFAULT_REPLY_PROMPT,
): string {
  return [
    `# Character: ${character.name}`,
    `You are ${character.name}, a character in an interactive story. The user plays the other part.`,
    ...section('## Persona', character.persona),
    ...section('## Speaking style', character.speakingStyle),
    ...section('## Example dialogue', character.exampleDialogue),
    `# Scenario: ${scenario.title}`,
    ...section('## Premise', scenario.premise),
    ...section(
      '## The part the user plays',
      player?.name ?? '',
      player?.background ?? '',
    ),
    ...section(
      '## Where the story begins',
      scenario.startingLocation.name,
      scenario.startingLocation.description,
    ),
    '# How to reply',
    fillReplyPrompt(replyPrompt, character.name, player?.name).trim(),
  ].join('\n\n');
}

export function buildPrompt(
  character: PromptCharacter,
  scenario: PromptScenario,
  player: PromptPlayer,
  replyPrompt: PromptReply,
  conversation: readonly Message[],
  /** A token budget, or the window that says how much is sent. */
  window: number | Pick<ConversationWindow, 'notSent'>,
): Prompt {
  const instructions = buildInstructions(
    character,
    scenario,
    player,
    replyPrompt,
  );
  const notSent =
    typeof window === 'number'
      ? countNotSent(conversation, window)
      : window.notSent(instructions, conversation);
  return {
    instructions,
    messages: conversation
      .slice(notSent)
      .map(({ role, content }) => ({ role, content })),
  };
}
