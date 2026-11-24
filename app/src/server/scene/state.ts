// How a chat's scene changes as the story goes on, and when a reply is
// illustrated by itself. Pure, so that each rule can be tested on its own.

import type { IllustrationMode } from '../../shared/api.ts';

/** A place the chat's story has been, as far as these rules need it. */
export interface KnownPlace {
  id: number;
  name: string;
}

/** What the scene call says about where the scene is. */
export interface PlaceReport {
  /** Whether the scene is somewhere other than the current place. */
  moved: boolean;
  /** Where it is: one of the known places by name, or a new one. */
  name: string;
  description: string;
}

/** Where the scene is after a report: where it was, an earlier place, or a new one. */
export type NextPlace =
  | { kind: 'stay'; id: number }
  | { kind: 'return'; id: number }
  | { kind: 'new'; name: string; description: string };

/** Names are compared without regard to case or surrounding space. */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Where the scene is now, given where it was (`current`, one of `known`)
 * and the scene call's report. A place is recognised by its name, so a
 * story that goes back somewhere finds the place it already has.
 */
export function nextPlace(
  current: KnownPlace,
  known: readonly KnownPlace[],
  report: PlaceReport,
): NextPlace {
  const name = report.name.trim();
  if (!report.moved || name === '' || sameName(name, current.name)) {
    return { kind: 'stay', id: current.id };
  }
  const earlier = known.find((place) => sameName(place.name, name));
  if (earlier !== undefined) return { kind: 'return', id: earlier.id };
  return { kind: 'new', name, description: report.description.trim() };
}

/** What the app knows about a reply when it decides whether to illustrate it. */
export interface ReplyMoment {
  /** Whether the reply took the story somewhere else. */
  moved: boolean;
  /** Whether the scene call said the moment is worth a picture. */
  worthIt: boolean;
  /**
   * How many of the character's replies there have been since a picture was
   * last asked for in the chat, counting this one; `undefined` if none ever was.
   */
  repliesSinceImage: number | undefined;
}

/**
 * Whether a reply is illustrated without being asked. A move always is,
 * except when Off; in Key moments, a moment worth it is too, once
 * `cooldown` replies have passed since the last picture.
 */
export function shouldIllustrate(
  mode: IllustrationMode,
  cooldown: number,
  { moved, worthIt, repliesSinceImage }: ReplyMoment,
): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'every-reply':
      return true;
    case 'scene-changes':
      return moved;
    case 'key-moments':
      return (
        moved ||
        (worthIt &&
          (repliesSinceImage === undefined || repliesSinceImage >= cooldown))
      );
  }
}
