// The user's settings, kept in a JSON file in the app's data directory:
// outside the repository, and apart from the chat database so that a copy of
// the chats never carries the API key with it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type {
  IllustrationMode,
  Settings,
  SettingsUpdate,
  SpeechScope,
} from '../shared/api.ts';

export const DEFAULT_MODEL = 'gpt-5.5';
/** Describing a scene is a small, structured job: a small model does it. */
export const DEFAULT_SCENE_MODEL = 'gpt-5-mini';
/** Roughly 60,000 characters of conversation per turn. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 16_000;
/** Pictures arrive at moves and moments worth them, not on every reply. */
export const DEFAULT_ILLUSTRATION_MODE: IllustrationMode = 'key-moments';
/** Replies that pass after a picture before a key moment is illustrated again. */
export const DEFAULT_ILLUSTRATION_COOLDOWN = 3;
export const MIN_ILLUSTRATION_COOLDOWN = 1;
export const MAX_ILLUSTRATION_COOLDOWN = 100;
const ILLUSTRATION_MODES: readonly unknown[] = [
  'off',
  'scene-changes',
  'key-moments',
  'every-reply',
] satisfies IllustrationMode[];
/** Narration is skipped unless the user asks for it. */
export const DEFAULT_SPEECH_SCOPE: SpeechScope = 'dialogue';

interface Saved {
  model?: string;
  sceneModel?: string;
  illustrationMode?: IllustrationMode;
  illustrationCooldown?: number;
  contextTokenBudget?: number;
  speechMuted?: boolean;
  speechScope?: SpeechScope;
  openaiApiKey?: string;
}

function load(file: string): Saved {
  if (!existsSync(file)) return {};
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    > | null;
    if (typeof saved !== 'object' || saved === null) throw new Error();
    const {
      model,
      sceneModel,
      illustrationMode,
      illustrationCooldown,
      contextTokenBudget,
      speechMuted,
      speechScope,
      openaiApiKey,
    } = saved;
    return {
      ...(typeof model === 'string' && { model }),
      ...(typeof sceneModel === 'string' && { sceneModel }),
      ...(ILLUSTRATION_MODES.includes(illustrationMode) && {
        illustrationMode: illustrationMode as IllustrationMode,
      }),
      // A hand-edited cooldown outside what Settings allows is ignored.
      ...(Number.isInteger(illustrationCooldown) &&
        (illustrationCooldown as number) >= MIN_ILLUSTRATION_COOLDOWN &&
        (illustrationCooldown as number) <= MAX_ILLUSTRATION_COOLDOWN && {
          illustrationCooldown: illustrationCooldown as number,
        }),
      ...(typeof contextTokenBudget === 'number' && { contextTokenBudget }),
      ...(typeof speechMuted === 'boolean' && { speechMuted }),
      ...((speechScope === 'dialogue' || speechScope === 'everything') && {
        speechScope,
      }),
      ...(typeof openaiApiKey === 'string' && { openaiApiKey }),
    };
  } catch {
    // The content is not echoed: it may hold the API key.
    throw new Error(
      `The settings file is not valid JSON: ${file}. Fix it, or delete it to start with default settings.`,
    );
  }
}

export class SettingsStore {
  readonly #file: string;
  readonly #environmentApiKey: string | undefined;
  #saved: Saved;

  /** `environmentApiKey` is the value of OPENAI_API_KEY, if set. */
  constructor(file: string, environmentApiKey: string | undefined) {
    this.#file = file;
    this.#environmentApiKey =
      environmentApiKey === '' ? undefined : environmentApiKey;
    this.#saved = load(file);
  }

  model(): string {
    return this.#saved.model ?? DEFAULT_MODEL;
  }

  sceneModel(): string {
    return this.#saved.sceneModel ?? DEFAULT_SCENE_MODEL;
  }

  illustrationMode(): IllustrationMode {
    return this.#saved.illustrationMode ?? DEFAULT_ILLUSTRATION_MODE;
  }

  illustrationCooldown(): number {
    return this.#saved.illustrationCooldown ?? DEFAULT_ILLUSTRATION_COOLDOWN;
  }

  /** How many tokens of conversation to send each turn, at most. */
  contextTokenBudget(): number {
    return this.#saved.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  }

  /** The key to use: the saved one if there is one, else the environment's. */
  apiKey(): string | undefined {
    return this.#saved.openaiApiKey ?? this.#environmentApiKey;
  }

  /** The settings as the browser may see them: never the key itself. */
  view(): Settings {
    return {
      model: this.model(),
      sceneModel: this.sceneModel(),
      illustrationMode: this.illustrationMode(),
      illustrationCooldown: this.illustrationCooldown(),
      contextTokenBudget: this.contextTokenBudget(),
      speechMuted: this.#saved.speechMuted ?? false,
      speechScope: this.#saved.speechScope ?? DEFAULT_SPEECH_SCOPE,
      apiKey:
        this.#saved.openaiApiKey !== undefined
          ? 'saved'
          : this.#environmentApiKey !== undefined
            ? 'environment'
            : 'missing',
    };
  }

  update(update: SettingsUpdate): Settings {
    const next: Saved = { ...this.#saved };
    if (update.model !== undefined) next.model = update.model;
    if (update.sceneModel !== undefined) next.sceneModel = update.sceneModel;
    if (update.illustrationMode !== undefined) {
      next.illustrationMode = update.illustrationMode;
    }
    if (update.illustrationCooldown !== undefined) {
      next.illustrationCooldown = update.illustrationCooldown;
    }
    if (update.contextTokenBudget !== undefined) {
      next.contextTokenBudget = update.contextTokenBudget;
    }
    if (update.speechMuted !== undefined) next.speechMuted = update.speechMuted;
    if (update.speechScope !== undefined) next.speechScope = update.speechScope;
    if (update.apiKey === null) delete next.openaiApiKey;
    else if (update.apiKey !== undefined) next.openaiApiKey = update.apiKey;

    // Write beside the file, then swap, so a crash cannot leave half a file.
    const temporary = `${this.#file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.#file);
    this.#saved = next;
    return this.view();
  }
}
