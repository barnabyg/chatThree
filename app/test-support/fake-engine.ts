// A stand-in for the engine process, so tests need no GPU or Python.
// It is started the way the real engine is: `<command> --port <n>`, and
// answers `GET /health` like the engine does.
//
// FAKE_ENGINE_MODE:
//   ready     (default) reports `loading` for FAKE_ENGINE_LOADING_MS, then `ready`
//   failed    reports `failed` with an error, as when a model cannot load
//   crash     prints an error and exits straight away
//   launcher  starts a second copy of itself in `ready` mode and waits for it,
//             as `uv run` does with Python: the tree the app must end
// FAKE_ENGINE_PID_FILE: every process in the tree appends its PID here.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const mode = process.env.FAKE_ENGINE_MODE ?? 'ready';
const loadingMs = Number(process.env.FAKE_ENGINE_LOADING_MS ?? '100');
const pidFile = process.env.FAKE_ENGINE_PID_FILE;

if (pidFile !== undefined) appendFileSync(pidFile, `${String(process.pid)}\n`);

function health(startedAt: number): object {
  if (mode === 'failed') {
    return { status: 'failed', error: 'RuntimeError: CUDA out of memory' };
  }
  const loaded = Date.now() - startedAt >= loadingMs;
  return { status: loaded ? 'ready' : 'loading', error: null };
}

if (mode === 'crash') {
  console.error('ModuleNotFoundError: No module named chatthree_engine');
  process.exit(3);
} else if (mode === 'launcher') {
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, FAKE_ENGINE_MODE: 'ready' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  const startedAt = Date.now();
  createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(health(startedAt)));
    } else {
      response.statusCode = 404;
      response.end();
    }
  }).listen(Number(values.port), '127.0.0.1');
}
