// Model profiles: the settings that belong to one local model, so that the
// app works with whichever GGUF the user loads into KoboldCpp.
//
// A profile is a preset plus the user's overrides. Presets ship with the app,
// each matched to model ids by a pattern; the first match wins, and Generic,
// last, matches everything. Overrides are only the fields the user changed,
// kept per model id in `local-models.json` in the data directory, so that a
// better preset in a later version still reaches every field the user has not
// changed. See docs/adr/0002-model-profiles.md.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  type ModelProfile,
  type ProfileField,
  PROFILE_NUMBERS,
  type ProfileNumberField,
  type Thinking,
} from '../../shared/api.ts';

export type { ModelProfile, ProfileField, Thinking };

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
 * DeepSeek R1 comes first, so that a distill named after its base model
 * (`DeepSeek-R1-Distill-Qwen-…`) gets the DeepSeek preset.
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

/** The number `field`, in its range. */
function number(field: ProfileNumberField): z.ZodNumber {
  const { min, max, whole } = PROFILE_NUMBERS[field];
  const shown = (value: number): string => value.toLocaleString('en');
  return (
    whole
      ? z.int({ error: 'must be a whole number' })
      : z.number({ error: 'must be a number' })
  )
    .min(min, `must be ${shown(min)} or more`)
    .max(max, `must be ${shown(max)} or less`);
}

/** Each field of an override, checked alone so that one bad field costs only itself. */
const FIELDS: { [K in ProfileField]: z.ZodType<ModelProfile[K]> } = {
  contextLength: number('contextLength').nullable(),
  maxReplyTokens: number('maxReplyTokens'),
  temperature: number('temperature'),
  top_p: number('top_p'),
  top_k: number('top_k'),
  min_p: number('min_p'),
  rep_pen: number('rep_pen'),
  rep_pen_range: number('rep_pen_range'),
  sceneTemperature: number('sceneTemperature'),
  stop: z.array(z.string({ error: 'must be text' }).min(1, 'cannot be empty'), {
    error: 'must be a list of text',
  }),
  systemRole: z.enum(['system', 'merge-into-first-user'], {
    error: 'must be system or merge-into-first-user',
  }),
  thinking: z.discriminatedUnion(
    'mode',
    [
      z.strictObject({ mode: z.literal('none') }),
      z.strictObject({
        mode: z.literal('strip'),
        open: z.string().min(1, 'needs an open tag'),
        close: z.string().min(1, 'needs a close tag'),
      }),
    ],
    { error: 'must be none, or strip with an open and a close tag' },
  ),
  extraBody: z.record(z.string(), z.unknown(), {
    error: 'must be a JSON object',
  }),
};

/** The name of the preset the user chose by hand, saved among a model's overrides. */
const PRESET_FIELD = 'preset';

/** A profiles file that is not fit to be changed: it is left as it is. */
export class ProfileFileError extends Error {}

/** An edit to a profile that is refused, naming the field at fault. */
export class ProfileError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** The profile of a model as the editor shows it. */
export interface ProfileView {
  preset: string;
  matchedPreset: string;
  presetChosen: boolean;
  profile: ModelProfile;
  overridden: ProfileField[];
}

type Overrides = Partial<ModelProfile> & { preset?: string };

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
      if (field === PRESET_FIELD) {
        if (PRESETS.some(({ name }) => name === value)) model[field] = value;
        else
          warn(`Ignoring ${id}.${field} in ${file}: there is no such preset.`);
        continue;
      }
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
    return this.view(id).profile;
  }

  /** The profile of model `id`, with where its values come from. */
  view(id: string): ProfileView {
    const { preset: chosen, ...fields } = this.#overrides().get(id) ?? {};
    const matched = presetFor(id);
    const preset = PRESETS.find(({ name }) => name === chosen) ?? matched;
    return {
      preset: preset.name,
      matchedPreset: matched.name,
      presetChosen: chosen !== undefined,
      profile: { ...preset.profile, ...fields },
      overridden: Object.keys(fields) as ProfileField[],
    };
  }

  /**
   * Replace model `id`'s overrides with `overrides`, and the preset chosen
   * by hand with `preset` (`null` for the one matched). Other models' entries
   * in the file are kept as they are. Throws `ProfileError` for a value
   * that is not valid, and an `Error` when the file cannot be read or
   * written.
   */
  save(
    id: string,
    { preset, overrides }: { preset: string | null; overrides: object },
  ): void {
    const model: Record<string, unknown> = {};
    if (preset !== null) {
      if (!PRESETS.some(({ name }) => name === preset)) {
        throw new ProfileError(PRESET_FIELD, `There is no preset ${preset}.`);
      }
      model[PRESET_FIELD] = preset;
    }
    for (const [field, value] of Object.entries(overrides)) {
      const schema = (FIELDS as Record<string, z.ZodType | undefined>)[field];
      if (schema === undefined) {
        throw new ProfileError(field, `There is no field ${field}.`);
      }
      const checked = schema.safeParse(value);
      if (!checked.success) {
        throw new ProfileError(
          field,
          `${field} ${checked.error.issues[0]?.message ?? 'is not valid'}.`,
        );
      }
      model[field] = checked.data;
    }
    this.#write(id, Object.keys(model).length === 0 ? undefined : model);
  }

  /** Clear every override for model `id`. */
  reset(id: string): void {
    this.#write(id, undefined);
  }

  /** Put `model` in the file as `id`'s overrides, or take them out. */
  #write(id: string, model: Record<string, unknown> | undefined): void {
    let saved: Record<string, unknown> = {};
    if (existsSync(this.#file)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(this.#file, 'utf8'));
      } catch {
        throw new ProfileFileError(
          `${this.#file} is not valid JSON, so it was not changed. Fix or remove it, then try again.`,
        );
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new ProfileFileError(
          `${this.#file} is not an object of model ids, so it was not changed. Fix or remove it, then try again.`,
        );
      }
      saved = parsed as Record<string, unknown>;
    }
    if (model === undefined) {
      if (!(id in saved)) return;
      Reflect.deleteProperty(saved, id);
    } else saved[id] = model;
    mkdirSync(path.dirname(this.#file), { recursive: true });
    writeFileSync(this.#file, `${JSON.stringify(saved, null, 2)}\n`);
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
