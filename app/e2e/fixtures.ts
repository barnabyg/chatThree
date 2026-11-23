import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test as base } from '@playwright/test';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
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

/** Start the real app on a free port, with `env` added to its environment. */
export async function startApp(
  env: NodeJS.ProcessEnv = {},
): Promise<RunningApp> {
  const child = spawn(
    process.execPath,
    ['src/server/main.ts', '--port', '0', '--no-open'],
    {
      cwd: APP_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  try {
    const url = await listeningUrl(child);
    return { url, stop: () => stop(child) };
  } catch (error) {
    child.kill();
    throw error;
  }
}

/**
 * Every test gets its own app process, so tests share nothing and can run in
 * parallel. `page.goto('/')` goes to that app.
 */
export const test = base.extend<{ app: RunningApp }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires fixtures to destructure their dependencies.
  app: async ({}, use) => {
    const app = await startApp();
    await use(app);
    await app.stop();
  },
  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});

export { expect } from '@playwright/test';
