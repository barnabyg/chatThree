// A stand-in for the engine process, so tests need no GPU or Python.
// It is started the way the real engine is: `<command> --port <n>`, and
// answers `GET /health` and the job requests like the engine does.
//
// FAKE_ENGINE_MODE:
//   ready     (default) reports `loading` for FAKE_ENGINE_LOADING_MS, then `ready`
//   failed    reports `failed` with an error, as when a model cannot load
//   crash     prints an error and exits straight away
//   launcher  starts a second copy of itself in `ready` mode and waits for it,
//             as `uv run` does with Python: the tree the app must end
// FAKE_ENGINE_PID_FILE: every process in the tree appends its PID here.
// FAKE_ENGINE_LOG_FILE: every job received is appended here, one JSON object
//   per line: `{ "path": "/speech", "body": { ... } }`.
// FAKE_ENGINE_CLIP_MS: how long each spoken clip lasts (default 150).
// FAKE_ENGINE_SPEECH_FAILS: text that cannot be spoken. A request to speak
//   anything containing it fails, as when the model breaks on a sentence.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { parseArgs } from 'node:util';
import { encodeWav } from '../src/shared/wav.ts';

const { values } = parseArgs({ options: { port: { type: 'string' } } });
const mode = process.env.FAKE_ENGINE_MODE ?? 'ready';
const loadingMs = Number(process.env.FAKE_ENGINE_LOADING_MS ?? '100');
const pidFile = process.env.FAKE_ENGINE_PID_FILE;
const logFile = process.env.FAKE_ENGINE_LOG_FILE;
const clipMs = Number(process.env.FAKE_ENGINE_CLIP_MS ?? '150');
const speechFails = process.env.FAKE_ENGINE_SPEECH_FAILS;

const CLIP_SAMPLE_RATE = 8_000;

if (pidFile !== undefined) appendFileSync(pidFile, `${String(process.pid)}\n`);

interface Health {
  status: 'loading' | 'ready' | 'failed';
  error: string | null;
}

function health(startedAt: number): Health {
  if (mode === 'failed') {
    return { status: 'failed', error: 'RuntimeError: CUDA out of memory' };
  }
  const loaded = Date.now() - startedAt >= loadingMs;
  return { status: loaded ? 'ready' : 'loading', error: null };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body);
}

/** A quiet tone of the configured length, as a WAV file. */
function clip(): Uint8Array {
  const samples = new Float32Array(
    Math.round((CLIP_SAMPLE_RATE * clipMs) / 1000),
  );
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      0.05 * Math.sin((index * 2 * Math.PI * 220) / CLIP_SAMPLE_RATE);
  }
  return encodeWav(samples, CLIP_SAMPLE_RATE);
}

function speech(body: Record<string, unknown>, response: ServerResponse): void {
  if (typeof body.text !== 'string' || body.text === '') {
    sendJson(response, 422, { detail: 'text is required' });
    return;
  }
  if (speechFails !== undefined && body.text.includes(speechFails)) {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end('Internal Server Error');
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'audio/wav',
    'X-Audio-Seconds': (clipMs / 1000).toFixed(2),
  });
  response.end(clip());
}

async function job(
  request: IncomingMessage,
  response: ServerResponse,
  startedAt: number,
): Promise<void> {
  const now = health(startedAt);
  // As the real engine does, jobs are refused until the models are in.
  if (now.status !== 'ready') {
    sendJson(response, 503, { detail: now });
    return;
  }
  const body = (await readJson(request)) as Record<string, unknown>;
  if (logFile !== undefined) {
    appendFileSync(logFile, `${JSON.stringify({ path: request.url, body })}\n`);
  }
  switch (request.url) {
    case '/speech':
      speech(body, response);
      return;
    default:
      response.statusCode = 404;
      response.end();
  }
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
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, health(startedAt));
    } else if (request.method === 'POST') {
      job(request, response, startedAt).catch((error: unknown) => {
        console.error(error);
        response.statusCode = 500;
        response.end();
      });
    } else {
      response.statusCode = 404;
      response.end();
    }
  }).listen(Number(values.port), '127.0.0.1');
}
