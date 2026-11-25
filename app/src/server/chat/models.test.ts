import path from 'node:path';
import { expect, test } from 'vitest';
import { temporaryDirectory } from '../../../test-support/temporary.ts';
import { scriptedProvider } from '../testing.ts';
import { ModelCatalog, REASONING_CACHE_MAX_AGE_MS } from './models.ts';

function catalog(now = () => 0) {
  const file = path.join(temporaryDirectory('models'), 'levels.json');
  const provider = scriptedProvider();
  return {
    file,
    provider,
    catalog: new ModelCatalog(file, provider, now),
  };
}

test("a model's levels are found out once, and kept across restarts", async () => {
  const { file, provider, catalog: first } = catalog();

  expect(await first.reasoningEfforts('gpt-5.5')).toEqual([
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  await first.reasoningEfforts('gpt-5.5');
  const restarted = new ModelCatalog(file, provider, () => 0);
  await restarted.reasoningEfforts('gpt-5.5');

  expect(provider.effortChecks).toEqual(['gpt-5.5']);
});

test('two asks at once make one check', async () => {
  const { provider, catalog: models } = catalog();

  await Promise.all([
    models.reasoningEfforts('gpt-4.1'),
    models.reasoningEfforts('gpt-4.1'),
  ]);

  expect(provider.effortChecks).toEqual(['gpt-4.1']);
});

test('levels are found out again once they are a month old', async () => {
  let now = 0;
  const { provider, catalog: models } = catalog(() => now);

  await models.reasoningEfforts('gpt-5.5');
  now = REASONING_CACHE_MAX_AGE_MS + 1;
  await models.reasoningEfforts('gpt-5.5');

  expect(provider.effortChecks).toEqual(['gpt-5.5', 'gpt-5.5']);
});

test('a failed check is not kept', async () => {
  const { provider, catalog: models } = catalog();

  await expect(models.reasoningEfforts('no-such-model')).rejects.toThrow(
    'No model called no-such-model.',
  );
  provider.efforts.set('no-such-model', ['low']);

  expect(await models.reasoningEfforts('no-such-model')).toEqual(['low']);
});
