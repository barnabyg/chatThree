// Runs the engine as a child process for as long as the app runs.

import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { EngineStatus } from '../../shared/api.ts';
import { LOOPBACK } from '../loopback.ts';
import { killOrphans, killTree, TREE_SPAWN_OPTIONS } from './processTree.ts';

const HEALTH_TIMEOUT_MS = 2_000;
const OUTPUT_LINES_KEPT = 5;
const OUTPUT_FLUSH_MS = 250;

export interface EngineOptions {
  /** The engine's command line. The app adds `--port <n>`. */
  command: string[];
  cwd: string;
  /** Added to the app's own environment for the engine. */
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  /** Receives each line the engine prints. */
  log?: (line: string) => void;
}

/** What the HTTP API needs from the supervisor. */
export interface EngineControl {
  status(): EngineStatus;
  /** Call `listener` on every status change. Returns the unsubscribe function. */
  subscribe(listener: (status: EngineStatus) => void): () => void;
  restart(): Promise<void>;
}

interface Run {
  child: ChildProcess;
  startedAt: Date;
  /** Set once the app itself is ending this run, so its exit is expected. */
  stopping: boolean;
  /** Resolves when the process has gone and its leftovers are cleaned up. */
  ended: Promise<void>;
  recentOutput: string[];
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

async function readHealth(port: number): Promise<EngineStatus | undefined> {
  try {
    const response = await fetch(`http://${LOOPBACK}:${String(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const health = (await response.json()) as {
      status?: unknown;
      error?: unknown;
    };
    if (health.status === 'ready') return { state: 'ready' };
    if (health.status === 'failed') {
      return {
        state: 'failed',
        error:
          typeof health.error === 'string'
            ? health.error
            : 'The engine reported a failure without a message.',
      };
    }
    return { state: 'loading' };
  } catch {
    // Not listening yet: still starting up.
    return undefined;
  }
}

export class EngineSupervisor implements EngineControl {
  readonly #options: EngineOptions;
  readonly #listeners = new Set<(status: EngineStatus) => void>();
  #status: EngineStatus = { state: 'loading' };
  #run: Run | undefined;
  /** Starts and stops run one at a time, in the order they were asked for. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: EngineOptions) {
    this.#options = options;
  }

  status(): EngineStatus {
    return this.#status;
  }

  subscribe(listener: (status: EngineStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Launch the engine. Resolves once it is launched, not once it is ready. */
  start(): Promise<void> {
    return this.#enqueue(() => this.#launch());
  }

  /** End the engine's whole process tree. */
  stop(): Promise<void> {
    return this.#enqueue(() => this.#end());
  }

  restart(): Promise<void> {
    return this.#enqueue(async () => {
      await this.#end();
      await this.#launch();
    });
  }

  #enqueue(step: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(step);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #setStatus(status: EngineStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  async #launch(): Promise<void> {
    if (this.#run !== undefined) return;
    this.#setStatus({ state: 'loading' });

    const { command, cwd, env } = this.#options;
    const [tool, ...args] = command;
    if (tool === undefined) {
      this.#setStatus({ state: 'failed', error: 'No engine command is set.' });
      return;
    }
    if (!existsSync(cwd)) {
      this.#setStatus({
        state: 'failed',
        error: `The engine could not be started because its directory is missing: ${cwd}`,
      });
      return;
    }

    const port = await freePort();
    const startedAt = new Date();
    const child = spawn(tool, [...args, '--port', String(port)], {
      ...TREE_SPAWN_OPTIONS,
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const recentOutput: string[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        recentOutput.push(line);
        if (recentOutput.length > OUTPUT_LINES_KEPT) recentOutput.shift();
        (this.#options.log ?? console.log)(`[engine] ${line}`);
      });
    }

    const run: Run = {
      child,
      startedAt,
      stopping: false,
      recentOutput,
      ended: new Promise((resolve) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          this.#failed(
            run,
            error.code === 'ENOENT'
              ? `The engine could not be started because "${tool}" was not found. Install ${tool}, or add it to PATH, then restart the engine.`
              : `The engine could not be started: ${error.message}`,
          );
          resolve();
        });
        child.once('exit', (code, signal) => {
          void this.#exited(run, code, signal).then(resolve);
        });
      }),
    };
    this.#run = run;
    void this.#pollUntilSettled(run, port);
  }

  async #pollUntilSettled(run: Run, port: number): Promise<void> {
    while (this.#run === run) {
      const health = await readHealth(port);
      if (this.#run !== run) return;
      if (health !== undefined && health.state !== 'loading') {
        this.#setStatus(health);
        return;
      }
      await delay(this.#options.pollIntervalMs ?? 500);
    }
  }

  /** Record that `run` is over, unless the app ended it on purpose. */
  #failed(run: Run, error: string): void {
    if (this.#run !== run || run.stopping) return;
    this.#run = undefined;
    this.#setStatus({ state: 'failed', error });
  }

  async #exited(
    run: Run,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (run.stopping) return;
    // The last lines the engine printed, usually the reason it died, can
    // still be on their way. Its output closes once every process holding
    // it has gone, which a process the launcher left behind may never do,
    // so the wait is short.
    await Promise.race([once(run.child, 'close'), delay(OUTPUT_FLUSH_MS)]);
    const how =
      code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`;
    const output =
      run.recentOutput.length > 0
        ? ` Its last output was:\n${run.recentOutput.join('\n')}`
        : '';
    this.#failed(run, `The engine stopped unexpectedly (${how}).${output}`);
    // The launcher has gone, but the engine it started may still be running
    // and holding the GPU.
    if (run.child.pid !== undefined) {
      await killOrphans(run.child.pid, run.startedAt);
    }
  }

  async #end(): Promise<void> {
    const run = this.#run;
    if (run === undefined) return;
    run.stopping = true;
    this.#run = undefined;
    if (run.child.pid !== undefined && run.child.exitCode === null) {
      await killTree(run.child.pid);
    }
    await run.ended;
  }
}
