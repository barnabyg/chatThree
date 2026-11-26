import { expect, test } from 'vitest';
import { SCENE_SCHEMA } from '../scene/describe.ts';
import { describeSchema, findJson, schemaErrors } from './json.ts';

const SCENE = {
  action: 'Mara trims the wick.',
  expression: 'intent',
  framing: 'medium shot',
  lighting: 'lamplight',
  moved: false,
  location: { name: 'The lamp room', description: 'Glass all round.' },
  worthIllustrating: true,
};

test('an answer that follows the schema has no errors', () => {
  expect(schemaErrors(SCENE, SCENE_SCHEMA)).toEqual([]);
});

test('says which fields are missing, of the wrong type or not asked for', () => {
  const withoutMoved: Partial<typeof SCENE> = { ...SCENE };
  delete withoutMoved.moved;

  expect(
    schemaErrors(
      {
        ...withoutMoved,
        worthIllustrating: 'yes',
        location: { name: 3, description: 'Glass all round.' },
        mood: 'grim',
      },
      SCENE_SCHEMA,
    ),
  ).toEqual([
    'moved is missing',
    'location.name should be a string, not a number',
    'worthIllustrating should be a boolean, not a string',
    'mood is not one of the fields',
  ]);
});

test('an answer that is not an object is said to be one', () => {
  expect(schemaErrors(['a'], SCENE_SCHEMA)).toEqual([
    'the answer should be an object, not an array',
  ]);
});

const BRACED = { ...SCENE, action: 'She draws "}" and "{" on the glass.' };

test.each([
  ['bare', JSON.stringify(SCENE), SCENE],
  [
    'in prose',
    `Here is the scene:
${JSON.stringify(SCENE)}
I hope it helps.`,
    SCENE,
  ],
  [
    'in a code fence',
    `\`\`\`json
${JSON.stringify(SCENE, null, 2)}
\`\`\``,
    SCENE,
  ],
  [
    'after a thinking block',
    `<think>
The user wants {a scene}. Let me think.
</think>

${JSON.stringify(SCENE)}`,
    SCENE,
  ],
  [
    'with braces inside its strings, in prose',
    `Sure: ${JSON.stringify(BRACED)} Done.`,
    BRACED,
  ],
])('finds the JSON %s', (_where, text, value) => {
  expect(findJson(text)).toEqual({ value });
});

test.each([
  ['prose alone', 'The keeper stands by the window.'],
  ['a thinking block cut off before the answer', '<think>\nThe user keeps {'],
  ['broken JSON', '{"action": "Mara", '],
])('finds no JSON in %s', (_what, text) => {
  expect(findJson(text)).toBeUndefined();
});

test("describes each field from the schema's descriptions", () => {
  const description = describeSchema(SCENE_SCHEMA);

  expect(description).toContain(
    '- action (text): What the character is doing at this moment',
  );
  expect(description).toContain('- moved (true or false): Whether the moment');
  expect(description).toContain('- location.name (text)');
  expect(description).toContain('"worthIllustrating": false');
});
