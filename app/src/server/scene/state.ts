// How a chat's scene changes as the story goes on. Pure, so that each rule
// can be tested on its own.

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
