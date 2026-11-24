// The user's settings, kept in a JSON file in the app's data directory:
// outside the repository, and apart from the chat database so that a copy of
// the chats never carries the API key with it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Settings, SettingsUpdate, SpeechScope } from '../shared/api.ts';

export const DEFAULT_MODEL = 'gpt-5.5';
/** Roughly 60,000 characters of conversation per turn. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 16_000;
/** Narration is skipped unless the user asks for it. */
export const DEFAULT_SPEECH_SCOPE: SpeechScope = 'dialogue';

interface Saved {
  model?: string;
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
      contextTokenBudget,
      speechMuted,
      speechScope,
      openaiApiKey,
    } = saved;
    return {
      ...(typeof model === 'string' && { model }),
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
