// Keeping a local model's thinking out of its reply.
//
// KoboldCpp sends a thinking model's thoughts in `reasoning_content`, apart
// from the reply (#33), so a stream's content is usually only the reply. A
// model whose profile strips thinking may still put it in the content,
// between tags: another KoboldCpp or template, or an answer that did not
// stream and was cut off while thinking. This filter drops it there.
//
// It runs on the server, on the stream, because the browser speaks the reply
// a sentence at a time as it arrives.

import type { Thinking } from './profiles.ts';

type State =
  /** Nothing decided yet: the reply may still open with the open tag. */
  | 'start'
  /** Between the tags: dropped. */
  | 'inside'
  /**
   * No open tag at the start, but a close tag may still come, and everything
   * before it would be thinking: held back until the close tag, the end, or
   * `UNSURE_LIMIT` characters, past which it is taken as the reply.
   */
  | 'unsure'
  /** The reply proper: passed on. */
  | 'reply';

/**
 * How much of a reply without an open tag is held back in case a close tag
 * follows (a template that opens the thinking in the prompt). Beyond it, the
 * reply is taken as one without thinking, so that a model whose profile
 * strips thinking but which does not think still streams, and is spoken, as
 * it arrives, after a short wait.
 */
export const UNSURE_LIMIT = 1500;

/** The longest end of `text` that `tag` begins with: a tag that may be split. */
function partialTag(text: string, tag: string): number {
  for (
    let length = Math.min(tag.length - 1, text.length);
    length > 0;
    length--
  ) {
    if (tag.startsWith(text.slice(-length))) return length;
  }
  return 0;
}

/**
 * Passes on a streamed reply without its thinking, holding back only what
 * could still turn out to be thinking or part of a tag.
 */
export class ThinkingFilter {
  readonly #thinking: Thinking;
  #state: State = 'start';
  #held = '';
  /** Whether the whitespace before the reply is still to be dropped. */
  #dropLead = false;
  #thought = false;

  constructor(thinking: Thinking) {
    this.#thinking = thinking;
    if (thinking.mode === 'none') this.#state = 'reply';
  }

  /** Whether the model has been seen to think, or may be thinking. */
  get thinking(): boolean {
    return this.#thought;
  }

  /**
   * The model's thinking came apart from the reply: the content is the reply,
   * without the whitespace that starts it.
   */
  reasoned(): void {
    this.#thought = true;
    this.#dropLead = true;
  }

  /** The part of the reply that can be passed on after `chunk`. */
  push(chunk: string): string {
    this.#held += chunk;
    return this.#advance();
  }

  /** What is left to pass on once the stream has ended. */
  end(): string {
    const left = this.#state === 'inside' ? '' : this.#held;
    this.#held = '';
    this.#state = 'reply';
    return this.#lead(left);
  }

  #advance(): string {
    const thinking = this.#thinking;
    if (thinking.mode === 'none') return this.#pass();
    for (;;) {
      if (this.#state === 'start') {
        const text = this.#held.trimStart();
        if (text.startsWith(thinking.open)) {
          this.#held = text.slice(thinking.open.length);
          this.#state = 'inside';
          this.#thought = true;
          continue;
        }
        if (text === '' || thinking.open.startsWith(text)) return '';
        // Thinking that came apart is over: what remains is the reply.
        this.#state = this.#dropLead ? 'reply' : 'unsure';
        continue;
      }
      if (this.#state === 'inside' || this.#state === 'unsure') {
        const close = this.#held.indexOf(thinking.close);
        if (close === -1) {
          if (this.#state === 'inside') {
            this.#held = this.#held.slice(
              this.#held.length - partialTag(this.#held, thinking.close),
            );
          } else if (this.#held.length > UNSURE_LIMIT) {
            this.#state = 'reply';
            continue;
          }
          return '';
        }
        this.#thought = true;
        this.#held = this.#held.slice(close + thinking.close.length);
        this.#state = 'reply';
        this.#dropLead = true;
        continue;
      }
      return this.#pass();
    }
  }

  /** Pass on what is held, as the reply. */
  #pass(): string {
    const text = this.#lead(this.#held);
    this.#held = '';
    return text;
  }

  /** `text` without the whitespace that starts the reply, if it is still to go. */
  #lead(text: string): string {
    if (!this.#dropLead) return text;
    const trimmed = text.trimStart();
    if (trimmed !== '') this.#dropLead = false;
    return trimmed;
  }
}

/** A whole answer without its thinking. */
export function stripThinking(text: string, thinking: Thinking): string {
  const filter = new ThinkingFilter(thinking);
  return filter.push(text) + filter.end();
}
