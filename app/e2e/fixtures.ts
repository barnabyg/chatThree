import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base } from '@playwright/test';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

// The app runs this in place of the real engine, so no GPU is needed.
// FAKE_ENGINE_MODE selects how it behaves: see test-support/fake-engine.ts.
const FAKE_ENGINE_COMMAND = JSON.stringify([
  process.execPath,
  path.join(APP_ROOT, 'test-support', 'fake-engine.ts'),
]);

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
  /** PIDs of the engine processes the app has started, oldest first. */
  enginePids(): Promise<number[]>;
}

function listeningUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`The app did not start in time. Output:\n${output}`));
    }, START_TIMEOUT_MS);
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /running at (http:\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `The app exited with code ${String(code)}. Output:\n${output}`,
        ),
      );
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill(), STOP_TIMEOUT_MS);
  // Windows has no signal for a clean stop, so the app takes the request over IPC.
  child.send('shutdown');
  await exited;
  clearTimeout(timer);
}

/**
 * Start the real app on a free port, with `env` added to its environment.
 * `directory` is a directory of the caller's own for the app's files.
 */
export async function startApp(
  directory: string,
  env: NodeJS.ProcessEnv = {},
): Promise<RunningApp> {
  await mkdir(directory, { recursive: true });
  const pidFile = path.join(directory, 'engine-pids.txt');
  const child = spawn(
    process.execPath,
    ['src/server/main.ts', '--port', '0', '--no-open'],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        CHATTHREE_ENGINE_COMMAND: FAKE_ENGINE_COMMAND,
        CHATTHREE_ENGINE_DIR: APP_ROOT,
        FAKE_ENGINE_PID_FILE: pidFile,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  try {
    const url = await listeningUrl(child);
    return {
      url,
      stop: () => stop(child),
      enginePids: async () =>
        (await readFile(pidFile, 'utf8')).trim().split(/\s+/).map(Number),
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

interface Fixtures {
  /** Extra environment for this test's app: set with `test.use({ appEnv })`. */
  appEnv: NodeJS.ProcessEnv;
  app: RunningApp;
}

/**
 * Every test gets its own app process, so tests share nothing and can run in
 * parallel. `page.goto('/')` goes to that app.
 */
export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],
  app: async ({ appEnv }, use, testInfo) => {
    const app = await startApp(testInfo.outputPath(), appEnv);
    await use(app);
    await app.stop();
  },
  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});

export { expect } from '@playwright/test';
