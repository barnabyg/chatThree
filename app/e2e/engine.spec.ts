import { expect, test } from './fixtures.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.describe('an engine that takes a moment to load', () => {
  test.use({ appEnv: { FAKE_ENGINE_LOADING_MS: '1500' } });

  test('is shown as loading, then ready, without a reload', async ({
    page,
  }) => {
    await page.goto('/');
    const status = page.getByRole('region', { name: 'Engine' });

    await expect(status).toContainText('Engine loading');
    await expect(status).toContainText('Engine ready');
  });
});

test.describe('an engine that fails to load', () => {
  test.use({ appEnv: { FAKE_ENGINE_MODE: 'failed' } });

  test("is shown as failed with the engine's own error", async ({ page }) => {
    await page.goto('/');
    const status = page.getByRole('region', { name: 'Engine' });

    await expect(status).toContainText('Engine failed');
    await expect(status).toContainText('RuntimeError: CUDA out of memory');
  });
});

test.describe('an engine whose tooling is not installed', () => {
  test.use({
    appEnv: { CHATTHREE_ENGINE_COMMAND: '["chatthree-no-such-tool"]' },
  });

  test('is shown as failed, naming what is missing', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('region', { name: 'Engine' })).toContainText(
      '"chatthree-no-such-tool" was not found',
    );
  });
});

test('an engine that dies is shown as failed and can be restarted', async ({
  page,
  app,
}) => {
  await page.goto('/');
  const status = page.getByRole('region', { name: 'Engine' });
  await expect(status).toContainText('Engine ready');
  const [engine] = await app.enginePids();
  if (engine === undefined) throw new Error('expected an engine process');

  process.kill(engine, 'SIGKILL');
  await expect(status).toContainText('Engine failed');
  await expect(status).toContainText('stopped unexpectedly');

  await status.getByRole('button', { name: 'Restart engine' }).click();
  await expect(status).toContainText('Engine ready');
});

test.describe('an engine started through a launcher', () => {
  test.use({ appEnv: { FAKE_ENGINE_MODE: 'launcher' } });

  test('stopping the app ends every engine process', async ({ page, app }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Engine' })).toContainText(
      'Engine ready',
    );
    const tree = await app.enginePids();
    expect(tree).toHaveLength(2);

    await app.stop();

    await expect.poll(() => tree.filter(isAlive)).toEqual([]);
  });
});
