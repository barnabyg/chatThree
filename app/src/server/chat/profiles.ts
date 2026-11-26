// Model profiles: the settings that belong to one local model, so that the
// app works with whichever GGUF the user loads into KoboldCpp.
//
// A profile is a preset plus the user's overrides. Presets ship with the app,
// each matched to model ids by a pattern; the first match wins, and Generic,
// last, matches everything. Overrides are only the fields the user changed,
// kept per model id in `local-models.json` in the data directory, so that a
// better preset in a later version still reaches every field the user has not
// changed. See docs/adr/0002-model-profiles.md.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

/** How a model's thinking is handled. */
export type Thinking =
  | { mode: 'none' }
  /** Thinking between `open` and `close` is not part of the answer. */
  | { mode: 'strip'; open: string; close: string };

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

export interface Preset {
  name: string;
  /** Tested, ignoring case, against the model's name: see `modelName`. */
  matches: RegExp;
  profile: ModelProfile;
}

const THINK_TAGS: Thinking = {
  mode: 'strip',
  open: '<think>',
  close: '</think>',
};

/** Stop where the model starts to write the user's next line. */
const STOP_AT_USER = ['\n{user}:'];

const GENERIC: ModelProfile = {
  contextLength: null,
  maxReplyTokens: 512,
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  min_p: 0.05,
  rep_pen: 1.07,
  rep_pen_range: 1024,
  sceneTemperature: 0.2,
  stop: STOP_AT_USER,
  systemRole: 'system',
  thinking: { mode: 'none' },
  extraBody: {},
};

const GENERIC_PRESET: Preset = {
  name: 'Generic',
  matches: /.*/,
  profile: GENERIC,
};

/**
 * The presets, first match first. Values follow each family's published
 * recommendations, leaning towards roleplay where they leave room. A thinking
 * model gets more reply tokens, because its thinking counts against them.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: 'DeepSeek R1 distill',
    matches: /deepseek[-_. ]?r1/i,
    profile: {
      ...GENERIC,
      maxReplyTokens: 2048,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 40,
      min_p: 0,
      rep_pen: 1,
      // DeepSeek advise against a system prompt for R1.
      systemRole: 'merge-into-first-user',
      thinking: THINK_TAGS,
    },
  },
  {
    name: 'Qwen3',
    matches: /(^|[^a-z])qwen-?3/i,
    profile: {
      ...GENERIC,
      maxReplyTokens: 2048,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      rep_pen: 1.05,
      thinking: THINK_TAGS,
    },
  },
  {
    name: 'Mistral',
    matches: /mistral|nemo/i,
    profile: {
      ...GENERIC,
      temperature: 0.7,
      top_p: 0.95,
      top_k: 40,
      min_p: 0.05,
      rep_pen: 1.05,
    },
  },
  {
    name: 'Gemma',
    matches: /gemma/i,
    profile: {
      ...GENERIC,
      temperature: 1,
      top_p: 0.95,
      top_k: 64,
      min_p: 0,
      rep_pen: 1,
      // Gemma's template has no system role, but KoboldCpp's honours one (#33).
      systemRole: 'system',
    },
  },
  {
    name: 'Llama 3',
    matches: /llama[-_. ]?3/i,
    profile: {
      ...GENERIC,
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      rep_pen: 1.05,
    },
  },
  GENERIC_PRESET,
];

/**
 * The part of a model id that presets match: without KoboldCpp's
 * `koboldcpp/` and the file's quantisation (`-Q4_K_M`, `.IQ3_XS`, `-F16`...).
 */
export function modelName(id: string): string {
  return id
    .replace(/^koboldcpp\//i, '')
    .replace(/[-_.](i?q\d[a-z\d_]*|[bf]f?16|f32)$/i, '');
}

/** The preset for model `id`: the first that matches it. */
export function presetFor(id: string): Preset {
  const name = modelName(id);
  return PRESETS.find((preset) => preset.matches.test(name)) ?? GENERIC_PRESET;
}

/** Each field of an override, checked alone so that one bad field costs only itself. */
const FIELDS: { [K in ProfileField]: z.ZodType<ModelProfile[K]> } = {
  contextLength: z.int().positive().nullable(),
  maxReplyTokens: z.int().positive(),
  temperature: z.number().min(0),
  top_p: z.number().min(0).max(1),
  top_k: z.int().min(0),
  min_p: z.number().min(0).max(1),
  rep_pen: z.number().min(0),
  rep_pen_range: z.int().min(0),
  sceneTemperature: z.number().min(0),
  stop: z.array(z.string().min(1)),
  systemRole: z.enum(['system', 'merge-into-first-user']),
  thinking: z.union([
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({
      mode: z.literal('strip'),
      open: z.string().min(1),
      close: z.string().min(1),
    }),
  ]),
  extraBody: z.record(z.string(), z.unknown()),
};

type Overrides = Partial<ModelProfile>;

/** The overrides for each model id in `file`'s content, warning of what is ignored. */
function readOverrides(
  file: string,
  text: string,
  warn: (message: string) => void,
): Map<string, Overrides> {
  const overrides = new Map<string, Overrides>();
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    warn(`Ignoring ${file}: it is not valid JSON.`);
    return overrides;
  }
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
    warn(`Ignoring ${file}: it should be an object of model ids.`);
    return overrides;
  }
  for (const [id, fields] of Object.entries(saved as Record<string, unknown>)) {
    if (
      typeof fields !== 'object' ||
      fields === null ||
      Array.isArray(fields)
    ) {
      warn(`Ignoring ${id} in ${file}: its overrides should be an object.`);
      continue;
    }
    const model: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(fields)) {
      const schema = (FIELDS as Record<string, z.ZodType | undefined>)[field];
      if (schema === undefined) {
        warn(`Ignoring ${id}.${field} in ${file}: there is no such field.`);
        continue;
      }
      const checked = schema.safeParse(value);
      if (checked.success) model[field] = checked.data;
      else {
        warn(
          `Ignoring ${id}.${field} in ${file}: ${checked.error.issues[0]?.message ?? 'not a valid value'}.`,
        );
      }
    }
    overrides.set(id, model);
  }
  return overrides;
}

/**
 * The profiles of local models: each one's preset, with the overrides in
 * `local-models.json` on top. The file is read again whenever it changes, so
 * a hand edit takes effect on the next request. A missing file means no
 * overrides; an unreadable one is ignored with a warning in the console.
 */
export class ModelProfiles {
  readonly #file: string;
  readonly #warn: (message: string) => void;
  #read: { version: string; overrides: Map<string, Overrides> } | undefined;

  constructor(
    file: string,
    warn: (message: string) => void = (message) => {
      console.warn(message);
    },
  ) {
    this.#file = file;
    this.#warn = warn;
  }

  /** The profile of model `id`: its preset, with its overrides field by field. */
  profile(id: string): ModelProfile {
    return { ...presetFor(id).profile, ...this.#overrides().get(id) };
  }

  #overrides(): Map<string, Overrides> {
    if (!existsSync(this.#file)) {
      this.#read = undefined;
      return new Map();
    }
    try {
      // A change of time or size is a change: a time alone can be too coarse.
      const { mtimeMs, size } = statSync(this.#file);
      const version = `${String(mtimeMs)}:${String(size)}`;
      if (this.#read?.version !== version) {
        this.#read = {
          version,
          overrides: readOverrides(
            this.#file,
            readFileSync(this.#file, 'utf8'),
            this.#warn,
          ),
        };
      }
      return this.#read.overrides;
    } catch (error) {
      this.#warn(
        `Ignoring ${this.#file}: it could not be read (${error instanceof Error ? error.message : String(error)}).`,
      );
      return new Map();
    }
  }
}
