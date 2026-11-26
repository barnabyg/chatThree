import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { temporaryDirectory } from '../../../test-support/temporary.ts';
import { ModelProfiles, modelName, PRESETS, presetFor } from './profiles.ts';

test.each([
  // The two models of the KoboldCpp check (#33).
  ['koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M', 'Qwen3'],
  ['koboldcpp/gemma-4-31B-it-Q4_K_S', 'Gemma'],
  // Others of each family, as KoboldCpp would name them.
  ['koboldcpp/Qwen3-14B-Q5_K_M', 'Qwen3'],
  ['koboldcpp/qwen3-30b-a3b-instruct-2507.IQ4_XS', 'Qwen3'],
  ['koboldcpp/DeepSeek-R1-Distill-Qwen-14B-Q4_K_M', 'DeepSeek R1 distill'],
  ['koboldcpp/DeepSeek-R1-Distill-Llama-8B-Q8_0', 'DeepSeek R1 distill'],
  ['koboldcpp/Mistral-Nemo-Instruct-2407-Q6_K', 'Mistral'],
  ['koboldcpp/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M', 'Mistral'],
  ['koboldcpp/MN-12B-Mag-Mell-R1.Q6_K', 'Generic'],
  ['koboldcpp/gemma-3-27b-it-q4_0', 'Gemma'],
  ['koboldcpp/Meta-Llama-3.1-8B-Instruct-Q4_K_M', 'Llama 3'],
  ['koboldcpp/Llama-3.3-70B-Instruct-IQ3_XS', 'Llama 3'],
  ['koboldcpp/Phi-4-mini-instruct-F16', 'Generic'],
  ['koboldcpp/some-merge-of-everything', 'Generic'],
])('%s gets the %s preset', (id, preset) => {
  expect(presetFor(id).name).toBe(preset);
});

test('Generic is last, and matches anything', () => {
  expect(PRESETS.at(-1)?.name).toBe('Generic');
  expect(presetFor('').name).toBe('Generic');
  expect(presetFor('koboldcpp/????').name).toBe('Generic');
});

test.each([
  ['koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M', 'Qwen3.8-27B-Uncensored'],
  ['koboldcpp/gemma-4-31B-it-Q4_K_S', 'gemma-4-31B-it'],
  ['koboldcpp/model.IQ3_XS', 'model'],
  ['koboldcpp/model-f16', 'model'],
  ['koboldcpp/model-BF16', 'model'],
  ['model-Q8_0', 'model'],
])('matches %s by the name %s', (id, name) => {
  expect(modelName(id)).toBe(name);
});

test('every preset has a value for every field', () => {
  const fields = Object.keys(PRESETS.at(-1)?.profile ?? {}).sort();
  expect(fields).toHaveLength(13);
  for (const { profile } of PRESETS) {
    expect(Object.keys(profile).sort()).toEqual(fields);
  }
});

function profilesWith(content: string | undefined): {
  profiles: ModelProfiles;
  file: string;
  warnings: string[];
} {
  const file = path.join(temporaryDirectory('profiles'), 'local-models.json');
  if (content !== undefined) writeFileSync(file, content);
  const warnings: string[] = [];
  return {
    profiles: new ModelProfiles(file, (message) => warnings.push(message)),
    file,
    warnings,
  };
}

const QWEN = 'koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M';

test('with no overrides file, a model gets its preset', () => {
  const { profiles, warnings } = profilesWith(undefined);

  expect(profiles.profile(QWEN)).toEqual(presetFor(QWEN).profile);
  expect(warnings).toEqual([]);
});

test('overrides take precedence over the preset, field by field, for their model only', () => {
  const { profiles } = profilesWith(
    JSON.stringify({
      [QWEN]: { temperature: 1.1, stop: ['\n###'], extraBody: { top_a: 0.1 } },
    }),
  );

  expect(profiles.profile(QWEN)).toEqual({
    ...presetFor(QWEN).profile,
    temperature: 1.1,
    stop: ['\n###'],
    extraBody: { top_a: 0.1 },
  });
  expect(profiles.profile('koboldcpp/gemma-4-31B-it-Q4_K_S')).toEqual(
    presetFor('koboldcpp/gemma-4-31B-it-Q4_K_S').profile,
  );
});

test('an edit to the file takes effect on the next look', () => {
  const { profiles, file } = profilesWith(
    JSON.stringify({ [QWEN]: { temperature: 1.1 } }),
  );
  expect(profiles.profile(QWEN).temperature).toBe(1.1);

  writeFileSync(file, JSON.stringify({ [QWEN]: { temperature: 0.35 } }));

  expect(profiles.profile(QWEN).temperature).toBe(0.35);
});

test('an unreadable file is ignored with a warning', () => {
  const { profiles, file, warnings } = profilesWith('{"koboldcpp/x": {');

  expect(profiles.profile(QWEN)).toEqual(presetFor(QWEN).profile);
  expect(warnings).toEqual([`Ignoring ${file}: it is not valid JSON.`]);
});

test('a field that is not valid, or not a field, is ignored with a warning, and the rest are kept', () => {
  const { profiles, file, warnings } = profilesWith(
    JSON.stringify({
      [QWEN]: {
        temperature: 'hot',
        top_k: 30,
        systemRole: 'narrator',
        thinking: { mode: 'strip', open: '<reasoning>', close: '</reasoning>' },
        colour: 'blue',
      },
    }),
  );

  expect(profiles.profile(QWEN)).toEqual({
    ...presetFor(QWEN).profile,
    top_k: 30,
    thinking: { mode: 'strip', open: '<reasoning>', close: '</reasoning>' },
  });
  expect(warnings).toEqual([
    expect.stringMatching(new RegExp(`^Ignoring ${QWEN}[.]temperature in `)),
    expect.stringMatching(new RegExp(`^Ignoring ${QWEN}[.]systemRole in `)),
    `Ignoring ${QWEN}.colour in ${file}: there is no such field.`,
  ]);
});

describe('editing a profile', () => {
  const GEMMA = 'koboldcpp/gemma-4-31B-it-Q4_K_S';

  test('a view gives the preset, the values in use and which fields are changed', () => {
    const { profiles } = profilesWith(
      JSON.stringify({ [QWEN]: { temperature: 1.1 } }),
    );

    expect(profiles.view(QWEN)).toEqual({
      preset: 'Qwen3',
      matchedPreset: 'Qwen3',
      presetChosen: false,
      profile: { ...presetFor(QWEN).profile, temperature: 1.1 },
      overridden: ['temperature'],
    });
  });

  test("saving replaces the model's overrides and leaves other models' untouched", () => {
    const other = { 'koboldcpp/x': { temperature: 'hot', mine: true } };
    const { profiles, file } = profilesWith(
      JSON.stringify({ ...other, [QWEN]: { temperature: 1.1 } }),
    );

    profiles.save(QWEN, { preset: null, overrides: { top_k: 50 } });

    expect(profiles.profile(QWEN)).toEqual({
      ...presetFor(QWEN).profile,
      top_k: 50,
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      ...other,
      [QWEN]: { top_k: 50 },
    });
  });

  test('a preset chosen by hand is used in place of the one matched, and saved as an override', () => {
    const { profiles, file } = profilesWith(undefined);

    profiles.save(GEMMA, { preset: 'Qwen3', overrides: { top_k: 50 } });

    expect(profiles.view(GEMMA)).toMatchObject({
      preset: 'Qwen3',
      matchedPreset: 'Gemma',
      presetChosen: true,
      profile: { ...presetFor(QWEN).profile, top_k: 50 },
      overridden: ['top_k'],
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      [GEMMA]: { preset: 'Qwen3', top_k: 50 },
    });
  });

  test('resetting clears every override for the model only', () => {
    const { profiles, file } = profilesWith(
      JSON.stringify({
        [QWEN]: { temperature: 1.1, preset: 'Gemma' },
        [GEMMA]: { top_k: 3 },
      }),
    );

    profiles.reset(QWEN);

    expect(profiles.profile(QWEN)).toEqual(presetFor(QWEN).profile);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      [GEMMA]: { top_k: 3 },
    });
  });

  test.each([
    [{ temperature: -1 }, 'temperature'],
    [{ top_p: 1.5 }, 'top_p'],
    [{ maxReplyTokens: 0 }, 'maxReplyTokens'],
    [{ top_k: 2.5 }, 'top_k'],
    [{ stop: [''] }, 'stop'],
    [{ thinking: { mode: 'strip', open: '', close: '</think>' } }, 'thinking'],
    [{ colour: 'blue' }, 'colour'],
  ])('%j is refused, naming the field', (overrides, field) => {
    const { profiles, file } = profilesWith(undefined);

    expect(() => {
      profiles.save(QWEN, {
        preset: null,
        overrides: overrides,
      });
    }).toThrow(expect.objectContaining({ field }) as Error);
    expect(existsSync(file)).toBe(false);
  });

  test('a preset that does not exist is refused', () => {
    const { profiles } = profilesWith(undefined);

    expect(() => {
      profiles.save(QWEN, { preset: 'Nonesuch', overrides: {} });
    }).toThrow(expect.objectContaining({ field: 'preset' }) as Error);
  });

  test('a file that is not valid JSON is not overwritten', () => {
    const { profiles, file } = profilesWith('{"koboldcpp/x": {');

    expect(() => {
      profiles.save(QWEN, { preset: null, overrides: { top_k: 50 } });
    }).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{"koboldcpp/x": {');
  });
});
