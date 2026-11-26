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

/** Someone the user can play. Only the name is required. */
export interface PlayerInput {
  name: string;
  /** Who they are: history, personality, what they want. */
  background: string;
}

export interface Player extends PlayerInput {
  id: string;
  /** How many chats this player is in. Deleting it deletes them too. */
  chatCount: number;
}

/**
 * What a chat's character is told about how to reply: the instructions'
 * last section. See replyPrompt.ts for the placeholders and the default.
 */
export interface ReplyPromptInput {
  name: string;
  prompt: string;
}

export interface ReplyPrompt extends ReplyPromptInput {
  id: string;
  /** How many chats use it. Deleting it puts them back on the default. */
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
  /** Who the user plays, or `null` when the chat has no player. */
  player: { id: string; name: string } | null;
  /** How the character is told to reply, or `null` for the default. */
  replyPrompt: { id: string; name: string } | null;
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
  /** Who the user plays, or `null` when the chat has no player. */
  player: { id: string; name: string } | null;
  /** How the character is told to reply, or `null` for the default. */
  replyPrompt: { id: string; name: string } | null;
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
  /**
   * The model has begun to think before it replies. Its thinking is never
   * sent; the reply's text follows.
   */
  | { type: 'thinking' }
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
export const ILLUSTRATION_MODES = [
  'off',
  'scene-changes',
  'key-moments',
  'every-reply',
] as const;
export type IllustrationMode = (typeof ILLUSTRATION_MODES)[number];

/** How pictures of scenes and places look: like photographs, or painted. */
export const IMAGE_STYLES = ['realistic', 'illustration'] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

/**
 * How hard a model thinks before it answers, least first. Each model supports
 * only some of these; `GET /api/models/:model/reasoning` says which.
 */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * The service that writes all of the app's text: the replies and the scene
 * call. OpenAI, or a local model served by KoboldCpp.
 */
export const TEXT_BACKENDS = ['openai', 'koboldcpp'] as const;
export type TextBackend = (typeof TEXT_BACKENDS)[number];

/** How a local model's thinking is handled. */
export type Thinking =
  | { mode: 'none' }
  /** Thinking between `open` and `close` is not part of the answer. */
  | { mode: 'strip'; open: string; close: string };

/**
 * The settings that belong to one local model, so that the app works with
 * whichever GGUF the user loads into KoboldCpp. See docs/adr/0002.
 */
export interface ModelProfile {
  /** The context length to plan for, in tokens; `null` for what KoboldCpp reports. */
  contextLength: number | null;
  /** `max_tokens` on replies. */
  maxReplyTokens: number;
  /** Samplers on replies, by KoboldCpp's names. */
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  rep_pen: number;
  rep_pen_range: number;
  /** The temperature of the scene call: low, so it keeps to the facts. */
  sceneTemperature: number;
  /** Stop sequences on replies. `{user}` and `{character}` are filled in. */
  stop: string[];
  /**
   * `system` sends the instructions as a system message.
   * `merge-into-first-user` puts them before the first user message's text,
   * for chat templates that have no system role.
   */
  systemRole: 'system' | 'merge-into-first-user';
  thinking: Thinking;
  /** Merged into every request body, for KoboldCpp fields the app does not know. */
  extraBody: Record<string, unknown>;
}

export type ProfileField = keyof ModelProfile;

/** The fields of a profile that are numbers. */
export type ProfileNumberField =
  | 'contextLength'
  | 'maxReplyTokens'
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'rep_pen'
  | 'rep_pen_range'
  | 'sceneTemperature';

/** The range of each number in a profile, checked by the browser and the server. */
export const PROFILE_NUMBERS: Record<
  ProfileNumberField,
  { min: number; max: number; whole: boolean }
> = {
  contextLength: { min: 256, max: 1_048_576, whole: true },
  maxReplyTokens: { min: 1, max: 131_072, whole: true },
  temperature: { min: 0, max: 5, whole: false },
  top_p: { min: 0, max: 1, whole: false },
  top_k: { min: 0, max: 1000, whole: true },
  min_p: { min: 0, max: 1, whole: false },
  rep_pen: { min: 0, max: 10, whole: false },
  rep_pen_range: { min: 0, max: 1_048_576, whole: true },
  sceneTemperature: { min: 0, max: 5, whole: false },
};

/** The profile of the model KoboldCpp has loaded, for the profile editor. */
export interface LoadedModelProfile {
  /** The model's id, such as `koboldcpp/gemma-4-31B-it-Q4_K_S`. */
  model: string;
  /** The context length KoboldCpp was started with, in tokens. */
  contextLength: number;
  /** The preset in use. */
  preset: string;
  /** The preset the model's id matches. */
  matchedPreset: string;
  /** Whether the preset was chosen by hand, in place of the one matched. */
  presetChosen: boolean;
  /** Every preset, first match first, with its values. */
  presets: { name: string; profile: ModelProfile }[];
  /** The values in use: the preset's, with the overrides on top. */
  profile: ModelProfile;
  /** The fields the user has changed from the preset. */
  overridden: ProfileField[];
}

/** A new set of overrides for the loaded model, in place of the old. */
export interface LoadedModelProfileUpdate {
  /** A preset chosen by hand, or `null` for the one matched. */
  preset: string | null;
  /** Only the fields that differ from the preset. */
  overrides: Partial<ModelProfile>;
}

/** The model KoboldCpp has loaded, as a connection test finds it. */
export interface KoboldCppStatus {
  /** The model's id, such as `koboldcpp/gemma-4-31B-it-Q4_K_S`. */
  model: string;
  /** The context length KoboldCpp was started with, in tokens. */
  contextLength: number;
}

/** The models that can write replies, newest first. */
export interface ModelList {
  models: string[];
}

/** The thinking levels a model supports. Empty when it has none to choose. */
export interface ModelReasoning {
  efforts: ReasoningEffort[];
}

export interface Settings {
  /** Who writes the replies and the scene call. */
  textBackend: TextBackend;
  /**
   * KoboldCpp's address, such as `http://192.168.1.50:5001`, or `''` when
   * none has been saved.
   */
  koboldcppAddress: string;
  model: string;
  /** The reply model's thinking level, or `null` for the model's own default. */
  reasoningEffort: ReasoningEffort | null;
  /** The OpenAI model that describes scenes for illustration: a cheap one will do. */
  sceneModel: string;
  /** The scene model's thinking level, or `null` for the model's own default. */
  sceneReasoningEffort: ReasoningEffort | null;
  illustrationMode: IllustrationMode;
  /**
   * In Key moments, how many replies must pass after a picture before a
   * moment worth one is illustrated again.
   */
  illustrationCooldown: number;
  /** How scenes and places are painted. */
  imageStyle: ImageStyle;
  /** How many tokens of conversation are sent to the model each turn, at most. */
  contextTokenBudget: number;
  /**
   * About how many words a reply should be, told to the model as a
   * suggestion, or `null` for no suggestion.
   */
  replyLengthWords: number | null;
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
  textBackend?: TextBackend;
  koboldcppAddress?: string;
  model?: string;
  /** `null` goes back to the model's own default. */
  reasoningEffort?: ReasoningEffort | null;
  sceneModel?: string;
  sceneReasoningEffort?: ReasoningEffort | null;
  illustrationMode?: IllustrationMode;
  illustrationCooldown?: number;
  imageStyle?: ImageStyle;
  contextTokenBudget?: number;
  /** `null` stops suggesting a reply length. */
  replyLengthWords?: number | null;
  speechMuted?: boolean;
  speechScope?: SpeechScope;
  /** A new key to save, or `null` to forget the saved one. */
  apiKey?: string | null;
}
