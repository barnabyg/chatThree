import { describe, expect, test } from 'vitest';
import { nextPlace, shouldIllustrate } from './state.ts';

const KITCHEN = { id: 1, name: 'The lighthouse kitchen' };
const LAMP_ROOM = { id: 2, name: 'The lamp room' };

describe('where the scene goes next', () => {
  test('a scene that has not moved stays put', () => {
    expect(
      nextPlace(KITCHEN, [KITCHEN, LAMP_ROOM], {
        moved: false,
        name: 'The beach',
        description: 'Wet sand.',
      }),
    ).toEqual({ kind: 'stay', id: 1 });
  });

  test('a scene that says it moved to where it already is stays put', () => {
    expect(
      nextPlace(KITCHEN, [KITCHEN], {
        moved: true,
        name: 'the Lighthouse Kitchen ',
        description: '',
      }),
    ).toEqual({ kind: 'stay', id: 1 });
  });

  test('a scene that moves somewhere new adds a place', () => {
    expect(
      nextPlace(KITCHEN, [KITCHEN], {
        moved: true,
        name: ' The lamp room ',
        description: ' A glass room at the top of the tower. ',
      }),
    ).toEqual({
      kind: 'new',
      name: 'The lamp room',
      description: 'A glass room at the top of the tower.',
    });
  });

  test('a scene that moves back to an earlier place returns to it, by its name', () => {
    expect(
      nextPlace(LAMP_ROOM, [KITCHEN, LAMP_ROOM], {
        moved: true,
        name: 'THE LIGHTHOUSE KITCHEN',
        description: 'Somewhere else entirely.',
      }),
    ).toEqual({ kind: 'return', id: 1 });
  });

  test('a move to a place with no name stays put', () => {
    expect(
      nextPlace(KITCHEN, [KITCHEN], {
        moved: true,
        name: '  ',
        description: 'Somewhere.',
      }),
    ).toEqual({ kind: 'stay', id: 1 });
  });
});

describe('whether a reply is illustrated by itself', () => {
  const quiet = { moved: false, worthIt: false, repliesSinceImage: 10 };

  test('Off never illustrates', () => {
    expect(
      shouldIllustrate('off', 3, {
        moved: true,
        worthIt: true,
        repliesSinceImage: undefined,
      }),
    ).toBe(false);
  });

  test('Every reply always illustrates', () => {
    expect(
      shouldIllustrate('every-reply', 3, { ...quiet, repliesSinceImage: 0 }),
    ).toBe(true);
  });

  test('Scene changes only illustrates a move, whatever the cooldown', () => {
    expect(
      shouldIllustrate('scene-changes', 3, { ...quiet, worthIt: true }),
    ).toBe(false);
    expect(
      shouldIllustrate('scene-changes', 3, {
        ...quiet,
        moved: true,
        repliesSinceImage: 0,
      }),
    ).toBe(true);
  });

  test('Key moments illustrates a move, whatever the cooldown', () => {
    expect(
      shouldIllustrate('key-moments', 3, {
        ...quiet,
        moved: true,
        repliesSinceImage: 0,
      }),
    ).toBe(true);
  });

  test('Key moments illustrates a moment worth it once the cooldown has passed', () => {
    const worth = { ...quiet, worthIt: true };
    expect(
      shouldIllustrate('key-moments', 3, { ...worth, repliesSinceImage: 2 }),
    ).toBe(false);
    expect(
      shouldIllustrate('key-moments', 3, { ...worth, repliesSinceImage: 3 }),
    ).toBe(true);
    expect(
      shouldIllustrate('key-moments', 1, { ...worth, repliesSinceImage: 1 }),
    ).toBe(true);
  });

  test('Key moments illustrates a moment worth it in a chat with no picture yet', () => {
    expect(
      shouldIllustrate('key-moments', 3, {
        ...quiet,
        worthIt: true,
        repliesSinceImage: undefined,
      }),
    ).toBe(true);
  });

  test('Key moments leaves an ordinary moment alone', () => {
    expect(shouldIllustrate('key-moments', 3, quiet)).toBe(false);
  });
});
