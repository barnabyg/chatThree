import { describe, expect, test } from 'vitest';
import { nextPlace } from './state.ts';

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
