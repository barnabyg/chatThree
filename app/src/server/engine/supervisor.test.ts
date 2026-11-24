import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { isAlive } from '../../../test-support/processes.ts';
import type { EngineStatus } from '../../shared/api.ts';
import { EngineSupervisor } from './supervisor.ts';

// These tests start real processes: a fake engine that answers /health like
// the real one. Each test has its own processes, port and temporary directory.

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FAKE_ENGINE = [process.execPath, 'test-support/fake-engine.ts'];
const WAIT_MS = 20_000;

const running: EngineSupervisor[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((supervisor) => supervisor.stop()));
});

async function supervise(
  mode: string,
  command: string[] = FAKE_ENGINE,
): Promise<{ supervisor: EngineSupervisor; pids: () => Promise<number[]> }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatthree-engine-'));
  const pidFile = path.join(directory, 'pids.txt');
  const supervisor = new EngineSupervisor({
    command,
    cwd: APP_ROOT,
    env: { FAKE_ENGINE_MODE: mode, FAKE_ENGINE_PID_FILE: pidFile },
    pollIntervalMs: 20,
    log: () => undefined,
  });
  running.push(supervisor);
  return {
    supervisor,
    pids: async () =>
      (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number),
  };
}

function reaches(
  supervisor: EngineSupervisor,
  state: EngineStatus['state'],
): Promise<EngineStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Engine never became ${state}: ${JSON.stringify(supervisor.status())}`,
        ),
      );
    }, WAIT_MS);
    const check = (status: EngineStatus): void => {
      if (status.state !== state) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(status);
    };
    const unsubscribe = supervisor.subscribe(check);
    check(supervisor.status());
  });
}

async function failure(supervisor: EngineSupervisor): Promise<string> {
  const status = await reaches(supervisor, 'failed');
  return status.state === 'failed' ? status.error : '';
}

async function allGone(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + WAIT_MS;
  while (pids.some(isAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pids.some(isAlive);
}

test('reports loading while the engine loads, then ready', async () => {
  const { supervisor } = await supervise('ready');
  const seen: string[] = [];
  supervisor.subscribe((status) => seen.push(status.state));

  await supervisor.start();
  await reaches(supervisor, 'ready');

  expect(seen).toEqual(['loading', 'ready']);
});

test("reports the engine's own error when it fails to load", async () => {
  const { supervisor } = await supervise('failed');

  await supervisor.start();

  expect(await reaches(supervisor, 'failed')).toEqual({
    state: 'failed',
    error: 'RuntimeError: CUDA out of memory',
  });
});

test('says what is missing when the engine cannot be launched', async () => {
  const { supervisor } = await supervise('ready', ['chatthree-no-such-tool']);

  await supervisor.start();

  expect(await failure(supervisor)).toContain(
    '"chatthree-no-such-tool" was not found',
  );
});

test('reports failed, with its last output, when the engine exits by itself', async () => {
  const { supervisor } = await supervise('crash');

  await supervisor.start();

  expect(await failure(supervisor)).toMatch(
    /stopped unexpectedly \(exit code 3\).*No module named chatthree_engine/s,
  );
});

test('stopping ends the whole process tree, not just the launcher', async () => {
  const { supervisor, pids } = await supervise('launcher');
  await supervisor.start();
  await reaches(supervisor, 'ready');
  const tree = await pids();
  expect(tree).toHaveLength(2);

  await supervisor.stop();

  expect(await allGone(tree)).toBe(true);
});

test('when the launcher dies, the engine it left behind is ended and reported failed', async () => {
  const { supervisor, pids } = await supervise('launcher');
  await supervisor.start();
  await reaches(supervisor, 'ready');
  const [launcher, engine] = await pids();
  if (launcher === undefined || engine === undefined) {
    throw new Error('expected a launcher and an engine');
  }

  process.kill(launcher, 'SIGKILL');

  await reaches(supervisor, 'failed');
  expect(await allGone([engine])).toBe(true);
});

test('restart replaces a failed engine with a working one', async () => {
  const { supervisor, pids } = await supervise('ready');
  await supervisor.start();
  await reaches(supervisor, 'ready');
  const [first] = await pids();
  if (first === undefined) throw new Error('expected an engine');
  process.kill(first, 'SIGKILL');
  await reaches(supervisor, 'failed');

  await supervisor.restart();

  await reaches(supervisor, 'ready');
  expect(await pids()).toHaveLength(2);
});
