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
  /**
   * Whether the character has a voice clip. Its replies are spoken in the
   * voice cloned from that clip, or in the engine's built-in voice without.
   */
  hasVoice: boolean;
  /**
   * Where the character's reference picture is served from, or `null` if it
   * has none. The address changes whenever the picture does.
   */
  imageUrl: string | null;
}

/**
 * A voice clip must be longer than this many seconds to clone a voice from
 * (MIN_VOICE_SECONDS in the engine's audio.py).
 */
export const MIN_VOICE_SECONDS = 5;

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

/** A place a chat's story has been. */
export interface Location {
  id: number;
  name: string;
  /** How it looks, which is what its reference picture is made from. */
  description: string;
  /**
   * Where its reference picture is served from, or `null` until one is
   * needed. The address changes whenever the picture does.
   */
  imageUrl: string | null;
}

/** A picture of a moment in a chat, made from one of the character's messages. */
export interface Illustration {
  id: number;
  /** The character's message it illustrates. */
  messageId: number;
  /** Where the picture is served from. It never changes. */
  imageUrl: string;
}

/**
 * How far an illustration of a message has got, while it is being made or
 * once it has failed. A finished one is an `Illustration`.
 */
export interface IllustrationProgress {
  messageId: number;
  state:
    | 'describing' // the scene call is writing the picture's description
    | 'waiting' // waiting for the engine to finish other pictures
    | 'painting-location' // the engine is painting the location's reference picture
    | 'painting' // the engine is painting the scene
    | 'failed';
  /** Why it failed, in words for the user. Only when `failed`. */
  error?: string;
}

export interface Chat {
  id: string;
  character: {
    id: string;
    name: string;
    /** The character's reference picture, which illustrations need. */
    imageUrl: string | null;
  };
  scenario: { id: string; title: string };
  /** The whole conversation, oldest first. */
  messages: Message[];
  /** Where the story is now. */
  location: Location;
  /** Every place the story has been, in the order it reached them. */
  locations: Location[];
  /** Pictures of the conversation's moments, oldest first. */
  illustrations: Illustration[];
  /** Illustrations being made, or that failed, one per message at most. */
  illustrating: IllustrationProgress[];
  /**
   * True while the scene call reads the latest reply, after which the
   * chat's place may change and an illustration may start.
   */
  followingScene: boolean;
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

/**
 * The most text the engine speaks in one request (MAX_SPEECH_CHARACTERS in
 * the engine's server.py). Longer text is split before it is sent.
 */
export const MAX_SPEECH_CHARACTERS = 600;

/**
 * How much of a reply is spoken: only what the character says, or the
 * narration as well. See ui/speech/sentences.ts for how speech is told apart.
 */
export type SpeechScope = 'dialogue' | 'everything';

/** One piece of text to speak. The answer is the clip, as `audio/wav`. */
export interface SpeechRequest {
  text: string;
  /** Speak in this character's voice. Without it, the built-in voice. */
  characterId?: string;
}

/**
 * When replies are illustrated without being asked: never, when the story
 * moves somewhere new, at moments worth it as well (with a cooldown), or
 * every reply.
 */
export type IllustrationMode =
  'off' | 'scene-changes' | 'key-moments' | 'every-reply';

export interface Settings {
  model: string;
  /** The OpenAI model that describes scenes for illustration: a cheap one will do. */
  sceneModel: string;
  illustrationMode: IllustrationMode;
  /**
   * In Key moments, how many replies must pass after a picture before a
   * moment worth one is illustrated again.
   */
  illustrationCooldown: number;
  /** How many tokens of conversation are sent to the model each turn, at most. */
  contextTokenBudget: number;
  /** When true, replies are not spoken aloud. */
  speechMuted: boolean;
  speechScope: SpeechScope;
  /**
   * Where the OpenAI API key in use comes from. The key itself never leaves
   * the server.
   */
  apiKey: 'saved' | 'environment' | 'missing';
}

export interface SettingsUpdate {
  model?: string;
  sceneModel?: string;
  illustrationMode?: IllustrationMode;
  illustrationCooldown?: number;
  contextTokenBudget?: number;
  speechMuted?: boolean;
  speechScope?: SpeechScope;
  /** A new key to save, or `null` to forget the saved one. */
  apiKey?: string | null;
}
