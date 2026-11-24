// Turning a reply, as it streams in, into the sentences to speak.
//
// The engine returns each clip whole, so a reply is spoken sentence by
// sentence: the first sentence can be heard while the rest is still being
// written. Which text is spoken depends on the scope:
//
//   everything  the whole reply.
//   dialogue    what the character says, without the narration.
//
// Telling speech from narration depends on how the reply is written, and
// characters are written in two ways:
//
//   She nods. "Come in," she says.      speech is in double quotation marks
//   *She nods.* Come in.                actions are between asterisks, and
//                                       everything else is speech
//
// So a line of dialogue in quotation marks is always speech, an action
// between asterisks never is, and what the rest is depends on which of the
// two the reply uses. That is settled by the first line of dialogue (the
// rest is narration) or the first action (the rest is speech). A title or a
// single word in quotation marks is not a line of dialogue: it reads as part
// of the text around it. What tells them apart is that dialogue ends in
// punctuation inside its quotation marks, or runs to more than a phrase. Until then the rest is held back,
// unless the character's previous message had no quotation marks, in which
// case it is taken for speech at once. A reply with neither marks nor a
// previous message to go by is all speech, and is spoken when it ends.
//
// The text arrives a piece at a time and what has been sent to be spoken
// cannot be taken back, so a reply that changes its ways part-way can have
// a sentence of narration spoken before its first line of dialogue.
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

  /** Forget what has been added since the last sentence ended. */
  discardUnfinished(): void {
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

/** A quotation longer than this is dialogue, whatever it ends with. */
const MAX_QUOTED_PHRASE = 80;

const hasQuotationMarks = (text: string): boolean => /["“”]/.test(text);

function dialogue(
  sentences: Sentences,
  previous: string | undefined,
): SpeechSplitter {
  /**
   * Whether a quotation is being read. One just opened is `unsettled` until
   * it shows itself to be a line of dialogue or only a quoted phrase.
   */
  let quotation: 'none' | 'unsettled' | 'dialogue' = 'none';
  /** The text of an unsettled quotation so far. */
  let quoted = '';
  /**
   * What text outside dialogue and actions is. Until that is known
   * (see the top of this file) such text is `held`.
   */
  let bare: 'undecided' | 'speech' | 'narration' =
    previous !== undefined && !hasQuotationMarks(previous)
      ? 'speech'
      : 'undecided';
  let held = '';
  /** The last character of such text that was not a space, on this line. */
  let lastBare = '';
  /** Asterisks just read, whose meaning depends on what follows them. */
  let asterisks = 0;
  /** The text between asterisks being read, if any. `bold` is two asterisks. */
  let span: { text: string; bold: boolean } | null = null;

  const narration = (text: string): void => {
    // Speech is not kept waiting for more once the narration moves on: a
    // speech tag ("she said,") joins two halves of a sentence, but a
    // finished sentence of narration ends what was being said.
    if (/[.!?…\n]/.test(text)) sentences.flush();
  };

  /** Take text that is neither in quotation marks nor an action. */
  const takeBare = (text: string): void => {
    lastBare = text.trim().at(-1) ?? lastBare;
    if (bare === 'speech') sentences.add(text);
    else if (bare === 'narration') narration(text);
    else held += text;
  };

  /**
   * The text between asterisks has ended. It is an action, unless it is
   * stress on a word: bold, or one word in the middle of a sentence.
   */
  const endSpan = (cutShort = false): void => {
    if (span === null) return;
    const { text, bold } = span;
    span = null;
    const oneWord = !/\s/.test(text) && /[\p{L}\p{N}]/u.test(lastBare);
    if (!cutShort && (bold || oneWord)) {
      takeBare(text);
      return;
    }
    // An action shows how the reply is written: the rest is speech.
    if (bare === 'undecided') {
      bare = 'speech';
      sentences.add(held);
      held = '';
    }
    narration(text);
    lastBare = '';
  };

  /** Settle what the asterisks just read meant, now that `next` follows them. */
  const settleAsterisks = (next: string | undefined): void => {
    const bold = asterisks > 1;
    asterisks = 0;
    if (span !== null) endSpan();
    // Asterisks before a space open nothing: a list marker, or a stray mark.
    else if (next !== undefined && !isSpace(next)) span = { text: '', bold };
  };

  /** Take text that is not dialogue: part of an action, if one is open. */
  const takeUnquoted = (text: string): void => {
    if (span === null) takeBare(text);
    else span.text += text;
  };

  /** The quotation being read is a line of dialogue: speak it. */
  const settleAsDialogue = (): void => {
    if (bare !== 'narration') {
      // Dialogue settles it: only what is inside quotation marks is speech.
      // What led up to the first line of it was narration, held or half-said.
      if (bare === 'speech') sentences.discardUnfinished();
      bare = 'narration';
      held = '';
    }
    sentences.add(quoted);
    quoted = '';
    quotation = 'dialogue';
  };

  /**
   * The quotation being read has ended: at its closing mark, or `cutShort`
   * by the end of its line or of the reply.
   */
  const endQuotation = (cutShort = false): void => {
    if (quotation === 'unsettled') {
      if (!cutShort && !/[,.!?…—–-]$/.test(quoted.trimEnd())) {
        // A title or a word in quotation marks, read as the text around it.
        const phrase = quoted;
        quoted = '';
        quotation = 'none';
        takeUnquoted(phrase);
        return;
      }
      settleAsDialogue();
    }
    quotation = 'none';
    // Keeps two quotations apart when they join into one sentence.
    sentences.add(' ');
    if (cutShort) sentences.flush();
  };

  const quotationMark = (mark: string): void => {
    if (quotation !== 'none') {
      // An opening mark inside a quotation opens nothing new.
      if (mark !== '“') endQuotation();
    } else if (mark !== '”') {
      quotation = 'unsettled';
    }
  };

  const take = (character: string): void => {
    // Inside quotation marks, asterisks are only stress on a word.
    if (character === '*') {
      if (quotation === 'none') asterisks += 1;
      return;
    }
    if (asterisks > 0) settleAsterisks(character);
    if (character === '\n') {
      // Neither an action nor a quotation runs on past the end of its line:
      // one left open by mistake must not swallow the rest of the reply.
      if (quotation !== 'none') endQuotation(true);
      endSpan(true);
      lastBare = '';
    }
    if (character === '"' || character === '“' || character === '”') {
      quotationMark(character);
    } else if (quotation === 'dialogue') {
      sentences.add(character);
    } else if (quotation === 'unsettled') {
      quoted += character;
      // More than a phrase: a sentence that carries on, or simply long.
      if (/[,.!?…]\s$/.test(quoted) || quoted.length > MAX_QUOTED_PHRASE) {
        settleAsDialogue();
      }
    } else takeUnquoted(character);
  };

  return {
    push(text) {
      for (const character of text) take(character);
      return sentences.take();
    },
    end() {
      if (asterisks > 0) settleAsterisks(undefined);
      if (quotation !== 'none') endQuotation(true);
      endSpan(true);
      // Neither dialogue nor an action: the reply was all speech.
      if (bare === 'undecided') sentences.add(held);
      sentences.flush();
      return sentences.take();
    },
  };
}

export interface SpeechSplitterOptions {
  /**
   * The most the engine speaks in one request. No sentence returned is
   * longer.
   */
  maxLength?: number | undefined;
  /**
   * The character's message before this reply, if there was one. It shows
   * how the character writes, which is a head start on telling speech from
   * narration in the `dialogue` scope.
   */
  previous?: string | undefined;
}

/** A splitter for one reply. */
export function speechSplitter(
  scope: SpeechScope,
  options: SpeechSplitterOptions = {},
): SpeechSplitter {
  const sentences = new Sentences(options.maxLength ?? MAX_SPEECH_CHARACTERS);
  return scope === 'dialogue'
    ? dialogue(sentences, options.previous)
    : everything(sentences);
}
