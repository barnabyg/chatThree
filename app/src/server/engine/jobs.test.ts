import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import {
  EngineFailedError,
  type EngineJobs,
  engineJobs,
  EngineRefusedError,
  EngineUnavailableError,
} from './jobs.ts';

// These tests run the client against a small HTTP server that answers as the
// engine does. Each test has its own server on its own port.

interface Received {
  path: string | undefined;
  body: unknown;
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }
});

/** An engine that answers every job with `answer`. */
async function engine(
  answer: (response: ServerResponse) => void,
): Promise<{ jobs: EngineJobs; received: Received[]; url: string }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      received.push({ path: request.url, body: JSON.parse(body) });
      answer(response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    jobs: engineJobs({ url: () => url }, { log: () => undefined }),
    received,
    url,
  };
}

test('speaking sends the text and returns the clip', async () => {
  const { jobs, received } = await engine((response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(Buffer.from([82, 73, 70, 70]));
  });

  const clip = await jobs.speak('Sit down.');

  expect([...clip]).toEqual([82, 73, 70, 70]);
  expect(received).toEqual([{ path: '/speech', body: { text: 'Sit down.' } }]);
});

test('speaking in a cloned voice names the clip to clone it from', async () => {
  const { jobs, received } = await engine((response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(Buffer.from([82]));
  });

  await jobs.speak('Sit down.', { voice: 'C:\\data\\voices\\mara.wav' });

  expect(received).toEqual([
    {
      path: '/speech',
      body: { text: 'Sit down.', voice: 'C:\\data\\voices\\mara.wav' },
    },
  ]);
});

test('preparing a voice sends its clip and waits for the engine to finish', async () => {
  const { jobs, received } = await engine((response) => {
    response.writeHead(204);
    response.end();
  });

  await jobs.prepareVoice('C:\\data\\voices\\mara.wav');

  expect(received).toEqual([
    { path: '/voice', body: { voice: 'C:\\data\\voices\\mara.wav' } },
  ]);
});

test('painting sends what to paint and returns the picture', async () => {
  const { jobs, received } = await engine((response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from([137, 80, 78, 71]));
  });
  const request = {
    prompt: 'A lighthouse.',
    width: 768,
    height: 1024,
    seed: 7,
  };

  const picture = await jobs.paint(request);

  expect([...picture]).toEqual([137, 80, 78, 71]);
  expect(received).toEqual([{ path: '/image', body: request }]);
});

test('painting logs the prompt and how it was asked for', async () => {
  const lines: string[] = [];
  const { url } = await engine((response) => {
    response.writeHead(200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from([137]));
  });
  const jobs = engineJobs(
    { url: () => url },
    { log: (line) => lines.push(line) },
  );

  await jobs.paint({
    prompt: 'A lighthouse.',
    width: 768,
    height: 1024,
    seed: 7,
    references: ['C:\\data\\mara.png'],
  });

  expect(lines).toEqual([
    '[image] 768x1024, seed 7, C:\\data\\mara.png\nA lighthouse.',
  ]);
});

test('an engine that is not ready is unavailable', async () => {
  const jobs = engineJobs({ url: () => undefined });

  await expect(jobs.speak('Sit down.')).rejects.toBeInstanceOf(
    EngineUnavailableError,
  );
});

test('an engine still loading its models is unavailable', async () => {
  const { jobs } = await engine((response) => {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: { status: 'loading' } }));
  });

  await expect(jobs.speak('Sit down.')).rejects.toBeInstanceOf(
    EngineUnavailableError,
  );
});

test('an engine that has gone is unavailable', async () => {
  const { jobs } = await engine(() => undefined);
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
  }

  await expect(jobs.speak('Sit down.')).rejects.toBeInstanceOf(
    EngineUnavailableError,
  );
});

test("a refused job carries the engine's reason", async () => {
  const { jobs } = await engine((response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ detail: 'voice clip not found: a.wav' }));
  });

  const refused = jobs.speak('Sit down.');

  await expect(refused).rejects.toBeInstanceOf(EngineRefusedError);
  await expect(refused).rejects.toThrow('voice clip not found: a.wav');
});

test('a job the engine breaks on has failed', async () => {
  const { jobs } = await engine((response) => {
    response.writeHead(500);
    response.end('Internal Server Error');
  });

  await expect(jobs.speak('Sit down.')).rejects.toBeInstanceOf(
    EngineFailedError,
  );
});

test('a job can be abandoned by whoever asked for it', async () => {
  const { jobs } = await engine(() => undefined);
  const listener = new AbortController();

  const clip = jobs.speak('Sit down.', { signal: listener.signal });
  listener.abort();

  await expect(clip).rejects.toMatchObject({ name: 'AbortError' });
});
