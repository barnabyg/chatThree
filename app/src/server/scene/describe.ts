// The scene call: a second, cheap request to OpenAI that reads the latest
// messages of a chat and describes the moment as a picture. Its answer is
// structured (SCENE_SCHEMA), and the image prompts are put together from it
// here, so that what the engine is asked for stays in one shape.

import { z } from 'zod';
import type {
  Character,
  ImageStyle,
  Message,
  Scenario,
} from '../../shared/api.ts';
import type { StructuredRequest } from '../chat/provider.ts';
import type { PlaceReport } from './state.ts';

/** How many messages, up to the one illustrated, the scene call reads. */
export const SCENE_MESSAGES = 8;

/** What the scene call says the picture should show. */
export interface ScenePicture {
  /** What the character is doing, and where in the place. */
  action: string;
  /** The character's expression and mood. */
  expression: string;
  /** How the picture is framed: close-up, medium shot, wide shot... */
  framing: string;
  /** The light and the weather. */
  lighting: string;
}

/** Everything the scene call says about a moment. */
export interface Scene {
  picture: ScenePicture;
  place: PlaceReport;
  /** Whether the moment is worth a picture without being asked. */
  worthIt: boolean;
}

const sceneAnswer = z.object({
  action: z.string().trim().min(1),
  expression: z.string().trim(),
  framing: z.string().trim(),
  lighting: z.string().trim(),
  moved: z.boolean(),
  location: z.object({ name: z.string(), description: z.string() }),
  worthIllustrating: z.boolean(),
});

export const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        'What the character is doing at this moment, and where in the place, in one or two plain sentences a painter can follow.',
    },
    expression: {
      type: 'string',
      description: "The character's expression and mood.",
    },
    framing: {
      type: 'string',
      description: 'How the picture is framed, such as "medium shot".',
    },
    lighting: {
      type: 'string',
      description: 'The light, time of day and weather.',
    },
    moved: {
      type: 'boolean',
      description:
        'Whether the moment takes place somewhere other than the current place.',
    },
    location: {
      type: 'object',
      description:
        'Where the moment takes place. One of the known places by its exact name, or a new place with a short name and a description of how it looks.',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    worthIllustrating: {
      type: 'boolean',
      description:
        'Whether this moment is a key moment of the story, worth a picture by itself: an arrival, a revelation, a turn in the action or the mood. Most moments are not.',
    },
  },
  required: [
    'action',
    'expression',
    'framing',
    'lighting',
    'moved',
    'location',
    'worthIllustrating',
  ],
  additionalProperties: false,
} as const;

/** A scene call answer that does not follow the schema. */
export class SceneAnswerError extends Error {
  constructor() {
    super(
      'The description of the scene came back in a form chatThree could not use. Try again.',
    );
  }
}

/** A place, as the scene call and the image prompts see it. */
export interface Place {
  name: string;
  description: string;
}

/**
 * Where a chat begins: the scenario's starting location, or, when that was
 * left blank, the scenario itself.
 */
export function startingPlace(scenario: Scenario): Place {
  const { name, description } = scenario.startingLocation;
  return {
    name: name.trim() === '' ? 'Where the story begins' : name.trim(),
    description:
      description.trim() === '' ? scenario.premise.trim() : description.trim(),
  };
}

export interface SceneContext {
  character: Character;
  scenario: Scenario;
  /** The name of who the user plays, or `undefined` for no one in particular. */
  playerName: string | undefined;
  /** The conversation up to and including the message to illustrate. */
  messages: readonly Message[];
  /** Where the story is. */
  place: Place;
  /** Every place the story has been, including `place`. */
  places: readonly Place[];
}

/** The scene call for a moment, without the model. */
export function sceneRequest({
  character,
  scenario,
  playerName,
  messages,
  place,
  places,
}: SceneContext): Omit<StructuredRequest, 'model' | 'signal'> {
  const userName = (playerName ?? '').trim() || 'The user';
  const instructions = [
    `You describe moments of an illustrated roleplay story as pictures. The story is between ${character.name} and ${userName}.`,
    'Read the latest messages and describe the moment of the last one as a single picture of the character, for a painter who has a reference picture of the character and one of the place.',
    "Describe only what can be seen. Do not describe the character's face, body or clothes beyond what the moment changes: the reference picture shows them.",
    `The story: ${scenario.premise.trim() || scenario.title}`,
    `The current place: ${place.name}. ${place.description}`,
    [
      'The places the story has been:',
      ...places.map(({ name }) => `- ${name}`),
    ].join('\n'),
    'Say where the moment takes place. If it is still the current place, set moved to false and repeat its name. If it has moved to one of the places the story has been, use that exact name. If it has moved somewhere new, give the new place a short name and describe how it looks, without any people in it.',
  ].join('\n\n');
  const input = messages
    .slice(-SCENE_MESSAGES)
    .map(
      ({ role, content }) =>
        `${role === 'assistant' ? character.name : userName}: ${content}`,
    )
    .join('\n\n');
  return { instructions, input, schemaName: 'scene', schema: SCENE_SCHEMA };
}

/** The scene call's answer, checked. Throws `SceneAnswerError`. */
export function readScene(answer: unknown): Scene {
  const result = sceneAnswer.safeParse(answer);
  if (!result.success) throw new SceneAnswerError();
  const { moved, location, worthIllustrating, ...picture } = result.data;
  return {
    picture,
    place: { moved, ...location },
    worthIt: worthIllustrating,
  };
}

/** The words that set the look of a picture, per image style. */
const STYLE_WORDS: Record<
  ImageStyle,
  { place: string; placeLook: string; scene: string; sceneLook: string }
> = {
  realistic: {
    place: 'A photorealistic establishing shot of a place',
    placeLook: 'Realistic photograph, natural lighting, rich detail.',
    scene: 'A photorealistic still of a moment, like a frame from a film.',
    sceneLook: 'Realistic photograph, not a drawing or painting.',
  },
  illustration: {
    place: 'An establishing view of a place in an illustrated story',
    placeLook: 'Painterly illustration, rich detail.',
    scene: 'An illustration from a story.',
    sceneLook: 'Painterly illustration.',
  },
};

/** What the engine is asked to paint for a place's reference picture. */
export function placePrompt(
  { name, description }: Place,
  style: ImageStyle,
): string {
  const words = STYLE_WORDS[style];
  return [
    `${words.place}: ${name}.`,
    description,
    `Wide shot, with no people in it. ${words.placeLook} No text.`,
  ].join(' ');
}

/**
 * What the engine is asked to paint for a moment. The references go with it
 * in this order: the character's picture, then the place's.
 */
export function scenePrompt(
  characterName: string,
  place: Place,
  picture: ScenePicture,
  style: ImageStyle,
): string {
  const words = STYLE_WORDS[style];
  return [
    `${words.scene} The first reference image shows ${characterName}; the second shows the place, ${place.name}.`,
    `Show ${characterName}, looking exactly as in the first image, in the place from the second image.`,
    picture.action,
    picture.expression === '' ? '' : `Expression: ${picture.expression}.`,
    picture.framing === '' ? '' : `Framing: ${picture.framing}.`,
    picture.lighting === '' ? '' : `Lighting: ${picture.lighting}.`,
    `${words.sceneLook} No text.`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}
