// Shapes that cross the HTTP API between the server and the UI.

/** Whether the engine can take jobs. `failed` carries the reason. */
export type EngineStatus =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'failed'; error: string };

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

/** What the user writes about a character. Only the name is required. */
export interface CharacterInput {
  name: string;
  /** Who the character is: history, personality, what they want. */
  persona: string;
  /** How the character talks. */
  speakingStyle: string;
  /** Sample exchanges that show the character's voice. */
  exampleDialogue: string;
  /** What the character looks like. For pictures; not part of the chat prompt. */
  appearance: string;
}

export interface Character extends CharacterInput {
  id: string;
  /** How many chats are with this character. Deleting it deletes them too. */
  chatCount: number;
}

/** What the user writes about a scenario. Only the title is required. */
export interface ScenarioInput {
  title: string;
  /** The situation the story starts from. */
  premise: string;
  /** The part the user plays. */
  userPersona: { name: string; description: string };
  /** The character's first message in a new chat. Blank for none. */
  openingMessage: string;
  /** Where the story begins. */
  startingLocation: { name: string; description: string };
}

export interface Scenario extends ScenarioInput {
  id: string;
  /** How many chats are set in this scenario. Deleting it deletes them too. */
  chatCount: number;
}

export interface Chat {
  id: string;
  character: { id: string; name: string };
  scenario: { id: string; title: string };
  /** The whole conversation, oldest first. */
  messages: Message[];
  /**
   * How many messages, counted from the oldest, are no longer sent to the
   * model because the conversation has outgrown its token budget.
   */
  notSent: number;
  /** True while the server is still writing a reply in this chat. */
  replying: boolean;
}

export interface ChatSummary {
  id: string;
  character: { id: string; name: string };
  scenario: { id: string; title: string };
  /** When a message was last added. */
  lastActivityAt: string;
}

/**
 * What the server sends, one JSON object per line, while it answers a
 * message. A reply ends with exactly one `done` or `error`.
 */
export type ReplyEvent =
  /** The user's message has been saved. */
  | { type: 'user-message'; message: Message }
  /** The next piece of the reply's text. */
  | { type: 'delta'; text: string }
  /** The reply is finished and saved. `null` if it was stopped before any text arrived. */
  | { type: 'done'; message: Message | null }
  /** No reply could be produced. The user's message is still saved. */
  | { type: 'error'; message: string };

export interface Settings {
  model: string;
  /** How many tokens of conversation are sent to the model each turn, at most. */
  contextTokenBudget: number;
  /**
   * Where the OpenAI API key in use comes from. The key itself never leaves
   * the server.
   */
  apiKey: 'saved' | 'environment' | 'missing';
}

export interface SettingsUpdate {
  model?: string;
  contextTokenBudget?: number;
  /** A new key to save, or `null` to forget the saved one. */
  apiKey?: string | null;
}
