// Turning a reply, as it streams in, into the sentences to speak.
//
// The engine returns each clip whole, so a reply is spoken sentence by
// sentence: the first sentence can be heard while the rest is still being
// written. Which text is spoken depends on the scope:
//
//   everything  the whole reply.
//   dialogue    what the character says, without the narration. Text in
//               double quotation marks is speech. A reply that marks its
//               actions with *asterisks* and has no quotation marks is
//               written the other way round, so there everything outside
//               the asterisks is speech. A reply with neither is all speech.
//
// Formatting marks are never spoken in either scope.

import { MAX_SPEECH_CHARACTERS, type SpeechScope } from '../../shared/api.ts';

export interface SpeechSplitter {
  /** Take the next piece of the reply. Returns the sentences now ready to speak. */
  push(text: string): string[];
  /** The reply has ended. Returns whatever is left to speak. */
  end(): string[];
}

const TERMINATORS = '.!?…';
/** What may follow a sentence's last mark and still belong to the sentence. */
const CLOSERS = '"\'”’)]*_~`';
/** Titles whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'mt',
  'prof',
  'sr',
  'jr',
  'vs',
  'capt',
  'sgt',
  'lt',
  'col',
  'gen',
]);

const isSpace = (character: string | undefined): boolean =>
  character !== undefined && /\s/.test(character);

const isLowercase = (character: string | undefined): boolean =>
  character !== undefined && /\p{Ll}/u.test(character);

/** Whether the text ends with a title such as "Dr", so the stop after it is not a sentence end. */
function endsWithAbbreviation(text: string): boolean {
  const word = /\p{L}+$/u.exec(text)?.[0];
  return word !== undefined && ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Where the first sentence in `text` ends, or `undefined` if no sentence is
 * known to have ended yet. A sentence's end is only certain once the start
 * of what follows has arrived: "3.5" and "Well... if" do not end one.
 */
function sentenceEnd(text: string): number | undefined {
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === '\n') return index;
    if (!TERMINATORS.includes(character)) {
      index += 1;
      continue;
    }
    let after = index + 1;
    while (
      after < text.length &&
      (TERMINATORS.includes(text.charAt(after)) ||
        CLOSERS.includes(text.charAt(after)))
    ) {
      after += 1;
    }
    if (after >= text.length) return undefined;
    if (!isSpace(text[after])) {
      index = after;
      continue;
    }
    let next = after;
    while (next < text.length && isSpace(text[next]) && text[next] !== '\n') {
      next += 1;
    }
    if (next >= text.length) return undefined;
    const carriesOn =
      isLowercase(text[next]) ||
      (character === '.' && endsWithAbbreviation(text.slice(0, index)));
    if (text[next] === '\n' || !carriesOn) return after;
    index = next;
  }
  return undefined;
}

/**
 * Where to cut text that is too long to speak in one request: after the last
 * comma or similar in the second half of what fits, else at the last space,
 * else wherever the limit falls.
 */
function cutPoint(text: string, maxLength: number): number {
  const fits = text.slice(0, maxLength);
  const clause = Math.max(
    ...[',', ';', ':', '—', '–'].map((mark) => fits.lastIndexOf(mark)),
  );
  if (clause >= maxLength / 2) return clause + 1;
  const space = fits.lastIndexOf(' ');
  return space > 0 ? space : maxLength;
}

/** The text as it should be sent to be spoken: no formatting, no quotation marks. */
function clean(text: string): string {
  return (
    text
      // A link is spoken as its text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Headings, block quotes and list markers at the start of a line.
      .replace(/^\s*(?:#+|>+|[-+]\s)/gm, '')
      .replace(/[*_~`"“”]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const isPronounceable = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/** Collects text to speak and gives it back a sentence at a time. */
class Sentences {
  readonly #maxLength: number;
  #pending = '';
  #ready: string[] = [];

  constructor(maxLength: number) {
    this.#maxLength = maxLength;
  }

  add(text: string): void {
    this.#pending += text;
    for (;;) {
      const end = sentenceEnd(this.#pending);
      if (end === undefined) break;
      this.#finish(this.#pending.slice(0, end));
      this.#pending = this.#pending.slice(end);
      // A new line is a sentence end of its own and belongs to neither side.
      if (this.#pending.startsWith('\n'))
        this.#pending = this.#pending.slice(1);
    }
    // A sentence too long for one request is not waited for.
    while (this.#pending.length > this.#maxLength) {
      const cut = cutPoint(this.#pending, this.#maxLength);
      this.#finish(this.#pending.slice(0, cut));
      this.#pending = this.#pending.slice(cut);
    }
  }

  /** What has been added so far is a sentence, whether or not it reads as one. */
  flush(): void {
    this.#finish(this.#pending);
    this.#pending = '';
  }

  /** The sentences finished since the last call. */
  take(): string[] {
    const ready = this.#ready;
    this.#ready = [];
    return ready;
  }

  #finish(sentence: string): void {
    let text = clean(sentence);
    while (text.length > this.#maxLength) {
      const cut = cutPoint(text, this.#maxLength);
      this.#keep(text.slice(0, cut));
      text = text.slice(cut).trim();
    }
    this.#keep(text);
  }

  #keep(text: string): void {
    const trimmed = text.trim();
    if (isPronounceable(trimmed)) this.#ready.push(trimmed);
  }
}

function everything(sentences: Sentences): SpeechSplitter {
  return {
    push(text) {
      sentences.add(text);
      return sentences.take();
    },
    end() {
      sentences.flush();
      return sentences.take();
    },
  };
}

function dialogue(sentences: Sentences): SpeechSplitter {
  let inQuotes = false;
  let inAsterisks = false;
  let lastWasAsterisk = false;
  /**
   * What text outside quotation marks and asterisks is. Until the reply has
   * shown how it is written, that is not known, and such text is `held`.
   */
  let bare: 'undecided' | 'speech' | 'narration' = 'undecided';
  let held = '';

  const narration = (character: string): void => {
    // Speech is not kept waiting for more once the narration moves on: a
    // speech tag ("she said,") joins two halves of a sentence, but a
    // finished sentence of narration ends what was being said.
    if (TERMINATORS.includes(character) || character === '\n') {
      sentences.flush();
    }
  };

  const take = (character: string): void => {
    const wasAsterisk = lastWasAsterisk;
    lastWasAsterisk = character === '*';
    switch (character) {
      case '"':
      case '“':
      case '”':
        inQuotes = character === '"' ? !inQuotes : character === '“';
        // Quotation marks settle it: only what is inside them is speech.
        bare = 'narration';
        held = '';
        // Keeps two quotations apart when they join into one sentence.
        if (!inQuotes) sentences.add(' ');
        return;
      case '*':
        // A run of asterisks (bold) opens or closes once, like a single one.
        if (wasAsterisk) return;
        inAsterisks = !inAsterisks;
        if (bare === 'undecided') {
          bare = 'speech';
          sentences.add(held);
          held = '';
        }
        return;
    }
    if (inQuotes) sentences.add(character);
    else if (inAsterisks || bare === 'narration') narration(character);
    else if (bare === 'speech') sentences.add(character);
    else held += character;
  };

  return {
    push(text) {
      for (const character of text) take(character);
      return sentences.take();
    },
    end() {
      // Neither quotation marks nor asterisks: the reply was all speech.
      if (bare === 'undecided') sentences.add(held);
      sentences.flush();
      return sentences.take();
    },
  };
}

/**
 * A splitter for one reply. No sentence it returns is longer than
 * `maxLength`, the most the engine speaks in one request.
 */
export function speechSplitter(
  scope: SpeechScope,
  maxLength: number = MAX_SPEECH_CHARACTERS,
): SpeechSplitter {
  const sentences = new Sentences(maxLength);
  return scope === 'dialogue' ? dialogue(sentences) : everything(sentences);
}
