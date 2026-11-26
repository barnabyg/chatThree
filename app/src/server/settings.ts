// The user's settings, kept in a JSON file in the app's data directory:
// outside the repository, and apart from the chat database so that a copy of
// the chats never carries the API key with it.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  ILLUSTRATION_MODES,
  IMAGE_STYLES,
  type IllustrationMode,
  type ImageStyle,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type Settings,
  type SettingsUpdate,
  type SpeechScope,
  TEXT_BACKENDS,
  type TextBackend,
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
/** The bounds of a suggested reply length, in words. */
export const MIN_REPLY_LENGTH_WORDS = 10;
export const MAX_REPLY_LENGTH_WORDS = 2_000;
/** Scenes and places look like photographs unless the user asks for paint. */
export const DEFAULT_IMAGE_STYLE: ImageStyle = 'realistic';
/** Narration is skipped unless the user asks for it. */
export const DEFAULT_SPEECH_SCOPE: SpeechScope = 'dialogue';

interface Saved {
  textBackend?: TextBackend;
  koboldcppAddress?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sceneModel?: string;
  sceneReasoningEffort?: ReasoningEffort;
  illustrationMode?: IllustrationMode;
  illustrationCooldown?: number;
  imageStyle?: ImageStyle;
  contextTokenBudget?: number;
  replyLengthWords?: number;
  speechMuted?: boolean;
  speechScope?: SpeechScope;
  openaiApiKey?: string;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly unknown[]).includes(value);
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
      textBackend,
      koboldcppAddress,
      model,
      reasoningEffort,
      sceneModel,
      sceneReasoningEffort,
      illustrationMode,
      illustrationCooldown,
      imageStyle,
      contextTokenBudget,
      replyLengthWords,
      speechMuted,
      speechScope,
      openaiApiKey,
    } = saved;
    return {
      // Settings saved before there was a choice of backend load as OpenAI.
      ...((TEXT_BACKENDS as readonly unknown[]).includes(textBackend) && {
        textBackend: textBackend as TextBackend,
      }),
      ...(typeof koboldcppAddress === 'string' && { koboldcppAddress }),
      ...(typeof model === 'string' && { model }),
      ...(isReasoningEffort(reasoningEffort) && { reasoningEffort }),
      ...(typeof sceneModel === 'string' && { sceneModel }),
      ...(isReasoningEffort(sceneReasoningEffort) && { sceneReasoningEffort }),
      ...((ILLUSTRATION_MODES as readonly unknown[]).includes(
        illustrationMode,
      ) && {
        illustrationMode: illustrationMode as IllustrationMode,
      }),
      // A hand-edited cooldown outside what Settings allows is ignored.
      ...(Number.isInteger(illustrationCooldown) &&
        (illustrationCooldown as number) >= MIN_ILLUSTRATION_COOLDOWN &&
        (illustrationCooldown as number) <= MAX_ILLUSTRATION_COOLDOWN && {
          illustrationCooldown: illustrationCooldown as number,
        }),
      ...((IMAGE_STYLES as readonly unknown[]).includes(imageStyle) && {
        imageStyle: imageStyle as ImageStyle,
      }),
      ...(typeof contextTokenBudget === 'number' && { contextTokenBudget }),
      // A hand-edited length outside what Settings allows is ignored.
      ...(Number.isInteger(replyLengthWords) &&
        (replyLengthWords as number) >= MIN_REPLY_LENGTH_WORDS &&
        (replyLengthWords as number) <= MAX_REPLY_LENGTH_WORDS && {
          replyLengthWords: replyLengthWords as number,
        }),
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

  /** Who writes the replies and the scene call. */
  textBackend(): TextBackend {
    return this.#saved.textBackend ?? 'openai';
  }

  /** KoboldCpp's address, without a trailing slash, or `''` if none is saved. */
  koboldcppAddress(): string {
    return this.#saved.koboldcppAddress ?? '';
  }

  model(): string {
    return this.#saved.model ?? DEFAULT_MODEL;
  }

  /** The reply model's thinking level, or `undefined` for its own default. */
  reasoningEffort(): ReasoningEffort | undefined {
    return this.#saved.reasoningEffort;
  }

  /** The model that describes scenes for illustrations. */
  sceneModel(): string {
    return this.#saved.sceneModel ?? DEFAULT_SCENE_MODEL;
  }

  /** The scene model's thinking level, or `undefined` for its own default. */
  sceneReasoningEffort(): ReasoningEffort | undefined {
    return this.#saved.sceneReasoningEffort;
  }

  /** When replies are illustrated without being asked. */
  illustrationMode(): IllustrationMode {
    return this.#saved.illustrationMode ?? DEFAULT_ILLUSTRATION_MODE;
  }

  /** In Key moments, how many replies must pass after a picture before another. */
  illustrationCooldown(): number {
    return this.#saved.illustrationCooldown ?? DEFAULT_ILLUSTRATION_COOLDOWN;
  }

  /** How scenes and places are painted. */
  imageStyle(): ImageStyle {
    return this.#saved.imageStyle ?? DEFAULT_IMAGE_STYLE;
  }

  /** How many tokens of conversation to send each turn, at most. */
  contextTokenBudget(): number {
    return this.#saved.contextTokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  }

  /** About how many words a reply should be, or `undefined` for no suggestion. */
  replyLengthWords(): number | undefined {
    return this.#saved.replyLengthWords;
  }

  /** The key to use: the saved one if there is one, else the environment's. */
  apiKey(): string | undefined {
    return this.#saved.openaiApiKey ?? this.#environmentApiKey;
  }

  /** The settings as the browser may see them: never the key itself. */
  view(): Settings {
    return {
      textBackend: this.textBackend(),
      koboldcppAddress: this.koboldcppAddress(),
      model: this.model(),
      reasoningEffort: this.reasoningEffort() ?? null,
      sceneModel: this.sceneModel(),
      sceneReasoningEffort: this.sceneReasoningEffort() ?? null,
      illustrationMode: this.illustrationMode(),
      illustrationCooldown: this.illustrationCooldown(),
      imageStyle: this.imageStyle(),
      contextTokenBudget: this.contextTokenBudget(),
      replyLengthWords: this.replyLengthWords() ?? null,
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
    if (update.textBackend !== undefined) next.textBackend = update.textBackend;
    if (update.koboldcppAddress !== undefined) {
      next.koboldcppAddress = update.koboldcppAddress;
    }
    if (update.model !== undefined) next.model = update.model;
    if (update.reasoningEffort === null) delete next.reasoningEffort;
    else if (update.reasoningEffort !== undefined) {
      next.reasoningEffort = update.reasoningEffort;
    }
    if (update.sceneModel !== undefined) next.sceneModel = update.sceneModel;
    if (update.sceneReasoningEffort === null) delete next.sceneReasoningEffort;
    else if (update.sceneReasoningEffort !== undefined) {
      next.sceneReasoningEffort = update.sceneReasoningEffort;
    }
    if (update.illustrationMode !== undefined) {
      next.illustrationMode = update.illustrationMode;
    }
    if (update.illustrationCooldown !== undefined) {
      next.illustrationCooldown = update.illustrationCooldown;
    }
    if (update.imageStyle !== undefined) next.imageStyle = update.imageStyle;
    if (update.contextTokenBudget !== undefined) {
      next.contextTokenBudget = update.contextTokenBudget;
    }
    if (update.replyLengthWords === null) delete next.replyLengthWords;
    else if (update.replyLengthWords !== undefined) {
      next.replyLengthWords = update.replyLengthWords;
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
