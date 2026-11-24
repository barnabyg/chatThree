import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test as base } from '@playwright/test';
import {
  FAKE_API_KEY,
  type FakeOpenAI,
  startFakeOpenAI,
} from '../test-support/fake-openai.ts';

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;

// The app runs this in place of the real engine, so no GPU is needed.
// FAKE_ENGINE_MODE selects how it behaves: see test-support/fake-engine.ts.
const FAKE_ENGINE_COMMAND = JSON.stringify([
  process.execPath,
  path.join(APP_ROOT, 'test-support', 'fake-engine.ts'),
]);

/** One job the fake engine received. */
export interface EngineJob {
  /** The engine endpoint, such as `/speech`. */
  path: string;
  body: Record<string, unknown>;
}

export interface RunningApp {
  url: string;
  stop(): Promise<void>;
  /** PIDs of the engine processes the app has started, oldest first. */
  enginePids(): Promise<number[]>;
  /** The jobs the engine has been sent, oldest first. */
  engineJobs(): Promise<EngineJob[]>;
  /** The text of every sentence the engine has been asked to speak, in order. */
  spoken(): Promise<string[]>;
}

/** The lines of a file some other process appends to, or none if it is not there yet. */
async function lines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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
  const jobFile = path.join(directory, 'engine-jobs.jsonl');
  const dataDir = path.join(directory, 'data');
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
        FAKE_ENGINE_LOG_FILE: jobFile,
        // Chats and settings go to a directory of the test's own.
        CHATTHREE_DATA_DIR: dataDir,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  try {
    const url = await listeningUrl(child);
    const engineJobs = async (): Promise<EngineJob[]> =>
      (await lines(jobFile)).map((line) => JSON.parse(line) as EngineJob);
    return {
      url,
      stop: () => stop(child),
      enginePids: async () =>
        (await readFile(pidFile, 'utf8')).trim().split(/\s+/).map(Number),
      engineJobs,
      spoken: async () =>
        (await engineJobs())
          .filter((job) => job.path === '/speech')
          .map((job) => String(job.body.text)),
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

interface Fixtures {
  /** Extra environment for this test's app: set with `test.use({ appEnv })`. */
  appEnv: NodeJS.ProcessEnv;
  /** The fake OpenAI server this test's app talks to. */
  openai: FakeOpenAI;
  app: RunningApp;
}

/**
 * Every test gets its own app process, so tests share nothing and can run in
 * parallel. `page.goto('/')` goes to that app.
 */
export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a fixture to destructure its dependencies, even when it has none. Remove if Playwright comes to accept a plain parameter.
  openai: async ({}, use) => {
    const openai = await startFakeOpenAI();
    await use(openai);
    await openai.close();
  },
  app: async ({ appEnv, openai }, use, testInfo) => {
    const app = await startApp(testInfo.outputPath(), {
      OPENAI_BASE_URL: openai.baseUrl,
      OPENAI_API_KEY: FAKE_API_KEY,
      ...appEnv,
    });
    await use(app);
    await app.stop();
  },
  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});

export { expect } from '@playwright/test';
