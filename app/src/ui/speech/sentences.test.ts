import { describe, expect, test } from 'vitest';
import type { SpeechScope } from '../../shared/api.ts';
import { speechSplitter } from './sentences.ts';

/** Everything a reply yields to speak, when it arrives in the given pieces. */
function spoken(
  scope: SpeechScope,
  pieces: string[],
  maxLength?: number,
): string[] {
  const splitter = speechSplitter(scope, maxLength);
  return [
    ...pieces.flatMap((piece) => splitter.push(piece)),
    ...splitter.end(),
  ];
}

/** The same reply, arriving one character at a time. */
function characters(reply: string): string[] {
  return Array.from(reply);
}

describe('splitting a reply into sentences', () => {
  test('each sentence is spoken on its own', () => {
    expect(
      spoken('everything', ['Come in. Sit down! Are you cold? I am.']),
    ).toEqual(['Come in.', 'Sit down!', 'Are you cold?', 'I am.']);
  });

  test('a sentence is ready as soon as the next one starts, before the reply ends', () => {
    const splitter = speechSplitter('everything');

    expect(splitter.push('Come in. Si')).toEqual(['Come in.']);
    expect(splitter.push('t down.')).toEqual([]);
    expect(splitter.end()).toEqual(['Sit down.']);
  });

  test('the sentences are the same however the reply is cut into pieces', () => {
    const reply = 'The lamp is lit. The door is barred... and yet. Who knocks?';

    expect(spoken('everything', characters(reply))).toEqual(
      spoken('everything', [reply]),
    );
  });

  test('a full stop inside a number or after a title does not end a sentence', () => {
    expect(
      spoken('everything', ['Dr. Hale paid 3.50 for it. Mrs. Pike saw.']),
    ).toEqual(['Dr. Hale paid 3.50 for it.', 'Mrs. Pike saw.']);
  });

  test('a pause that the sentence carries on from does not end it', () => {
    expect(spoken('everything', ['Well... if you must. Go on.'])).toEqual([
      'Well... if you must.',
      'Go on.',
    ]);
  });

  test('a new line ends a sentence', () => {
    expect(spoken('everything', ['The first line\nThe second line'])).toEqual([
      'The first line',
      'The second line',
    ]);
  });

  test('formatting marks are never spoken', () => {
    expect(
      spoken('everything', [
        '*She nods.* **Fine.** _Go_ on, `now`. ~Never~ mind.\n# The end',
      ]),
    ).toEqual(['She nods.', 'Fine.', 'Go on, now.', 'Never mind.', 'The end']);
  });

  test('quotation marks are not sent to be spoken', () => {
    expect(spoken('everything', ['"Come in," she said. “Sit down.”'])).toEqual([
      'Come in, she said.',
      'Sit down.',
    ]);
  });

  test('text with nothing to pronounce is not spoken', () => {
    expect(spoken('everything', ['... *—* !!! Hello.'])).toEqual(['Hello.']);
  });
});

describe('text longer than the engine takes in one request', () => {
  const long =
    'The road ran on past the mill, over the bridge, through the wood where nobody walks after dark, and down at last to the harbour.';

  test('is split into pieces that each fit', () => {
    const pieces = spoken('everything', [long], 50);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(50);
    expect(pieces.join(' ')).toBe(long);
  });

  test('is split at a comma where there is one', () => {
    expect(spoken('everything', [long], 50)[0]).toBe(
      'The road ran on past the mill, over the bridge,',
    );
  });

  test('is split even when it has no spaces', () => {
    const pieces = spoken('everything', ['a'.repeat(120)], 50);

    expect(pieces.map((piece) => piece.length)).toEqual([50, 50, 20]);
  });

  test('is split while it is still arriving', () => {
    const splitter = speechSplitter('everything', 50);

    expect(splitter.push(long.slice(0, 80))).toEqual([
      'The road ran on past the mill, over the bridge,',
    ]);
  });
});

describe('speaking only dialogue', () => {
  test('quoted speech is spoken and the narration around it is not', () => {
    expect(
      spoken('dialogue', [
        'She looked you over. "Come in." The door closed behind you. "Sit by the stove."',
      ]),
    ).toEqual(['Come in.', 'Sit by the stove.']);
  });

  test('speech broken by a speech tag is spoken as one sentence', () => {
    expect(
      spoken('dialogue', ['"Come in," she said, "and sit down."']),
    ).toEqual(['Come in, and sit down.']);
  });

  test('speech is not held back by the narration that follows it', () => {
    const splitter = speechSplitter('dialogue');

    expect(splitter.push('"Wait," she said. She left the room')).toEqual([
      'Wait,',
    ]);
  });

  test('curly quotation marks work as straight ones do', () => {
    expect(
      spoken('dialogue', ['She smiled. “Tea is in the tin.” She left.']),
    ).toEqual(['Tea is in the tin.']);
  });

  test('speech is found when the reply arrives a character at a time', () => {
    expect(
      spoken(
        'dialogue',
        characters('He frowned. "Who are you? Speak." Silence.'),
      ),
    ).toEqual(['Who are you?', 'Speak.']);
  });

  test('speech still open when the reply ends is spoken', () => {
    expect(spoken('dialogue', ['She whispered, "Do not go'])).toEqual([
      'Do not go',
    ]);
  });

  test('actions between asterisks are not spoken', () => {
    expect(
      spoken('dialogue', ['*She pours the tea.* "Drink." *She waits.*']),
    ).toEqual(['Drink.']);
  });

  test('emphasis inside speech is spoken without its marks', () => {
    expect(spoken('dialogue', ['"I *never* said that."'])).toEqual([
      'I never said that.',
    ]);
  });

  describe('in a reply that marks actions with asterisks and uses no quotation marks', () => {
    test('everything outside the asterisks is speech', () => {
      expect(
        spoken('dialogue', [
          '*The door swings inward.* In, quick, before the wind takes the hinges. *She bolts it.* Sit by the stove.',
        ]),
      ).toEqual([
        'In, quick, before the wind takes the hinges.',
        'Sit by the stove.',
      ]);
    });

    test('speech before the first action is spoken once that action shows the style', () => {
      const splitter = speechSplitter('dialogue');

      expect(splitter.push('Sit down. Mind the nets. ')).toEqual([]);
      expect(splitter.push('*She turns back to the stove.* Tea')).toEqual([
        'Sit down.',
        'Mind the nets.',
      ]);
      expect(splitter.end()).toEqual(['Tea']);
    });
  });

  test('a reply with no quotation marks or asterisks at all is spoken whole, once it ends', () => {
    const splitter = speechSplitter('dialogue');

    expect(splitter.push('This is the sea clearing its throat. Sit')).toEqual(
      [],
    );
    expect(splitter.push(' down.')).toEqual([]);
    expect(splitter.end()).toEqual([
      'This is the sea clearing its throat.',
      'Sit down.',
    ]);
  });

  test('a reply that is all narration says nothing', () => {
    expect(spoken('dialogue', ['*She shrugs and looks away.*'])).toEqual([]);
  });
});
