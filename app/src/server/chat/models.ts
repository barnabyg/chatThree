// Which models can write replies, and which thinking levels each one takes.
//
// The levels cost a few small requests to find out (see `reasoningEfforts` in
// openai.ts), so they are kept in a file in the data directory and found out
// again only once they are a month old. The file is only a cache: if it is
// missing or unreadable the levels are found out again.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../shared/api.ts';
import type { ChatProvider } from './provider.ts';

/** How long a model's levels are trusted before they are found out again. */
export const REASONING_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Cached {
  efforts: ReasoningEffort[];
  /** When the levels were found out, in milliseconds since the epoch. */
  checkedAt: number;
}

function load(file: string): Map<string, Cached> {
  const cache = new Map<string, Cached>();
  if (!existsSync(file)) return cache;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof saved !== 'object' || saved === null) return cache;
    for (const [model, entry] of Object.entries(saved)) {
      const { efforts, checkedAt } = (entry ?? {}) as Partial<Cached>;
      if (
        Array.isArray(efforts) &&
        efforts.every((effort) => REASONING_EFFORTS.includes(effort)) &&
        typeof checkedAt === 'number'
      ) {
        cache.set(model, { efforts, checkedAt });
      }
    }
  } catch {
    // An unreadable cache is the same as none.
  }
  return cache;
}

export class ModelCatalog {
  readonly #file: string;
  readonly #provider: ChatProvider;
  readonly #now: () => number;
  readonly #cache: Map<string, Cached>;
  /** Levels being found out now, so that two asks make one set of requests. */
  readonly #pending = new Map<string, Promise<ReasoningEffort[]>>();

  constructor(file: string, provider: ChatProvider, now = Date.now) {
    this.#file = file;
    this.#provider = provider;
    this.#now = now;
    this.#cache = load(file);
  }

  /** The models that can write replies, newest first. */
  models(): Promise<string[]> {
    return this.#provider.models();
  }

  /** The thinking levels `model` takes, least first: empty if it has none to choose. */
  async reasoningEfforts(model: string): Promise<ReasoningEffort[]> {
    const cached = this.#cache.get(model);
    if (
      cached !== undefined &&
      this.#now() - cached.checkedAt < REASONING_CACHE_MAX_AGE_MS
    ) {
      return cached.efforts;
    }
    let pending = this.#pending.get(model);
    if (pending === undefined) {
      pending = this.#provider
        .reasoningEfforts(model)
        .then((efforts) => {
          this.#cache.set(model, { efforts, checkedAt: this.#now() });
          this.#save();
          return efforts;
        })
        .finally(() => {
          this.#pending.delete(model);
        });
      this.#pending.set(model, pending);
    }
    return pending;
  }

  #save(): void {
    // Write beside the file, then swap, so a crash cannot leave half a file.
    const temporary = `${this.#file}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(Object.fromEntries(this.#cache), null, 2)}\n`,
    );
    renameSync(temporary, this.#file);
  }
}
