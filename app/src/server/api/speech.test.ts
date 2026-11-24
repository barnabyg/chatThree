import { expect, test } from 'vitest';
import {
  EngineFailedError,
  EngineRefusedError,
  EngineUnavailableError,
} from '../engine/jobs.ts';
import { testApp } from '../testing.ts';

test('a sentence comes back as a clip the browser can play', async () => {
  const app = testApp();

  const response = await app.call('POST', '/api/speech', {
    text: ' Sit down. ',
  });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('audio/wav');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(app.jobs.clip);
  expect(app.jobs.requests).toEqual([{ job: 'speak', text: 'Sit down.' }]);
});

test('text longer than the engine takes in one request is refused', async () => {
  const app = testApp();

  const response = await app.call('POST', '/api/speech', {
    text: 'a'.repeat(601),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'At most 600 characters can be spoken at a time.',
  });
  expect(app.jobs.requests).toEqual([]);
});

test('a request with nothing to say is refused', async () => {
  const response = await testApp().call('POST', '/api/speech', { text: '  ' });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'There is no text to speak.',
  });
});

test.each<{ name: string; failure: Error; status: number; error: string }>([
  {
    name: 'an engine that is not ready',
    failure: new EngineUnavailableError(),
    status: 503,
    error: 'Speech is unavailable because the engine is not ready.',
  },
  {
    name: 'a sentence the engine refuses',
    failure: new EngineRefusedError('voice clip not found: a.wav'),
    status: 400,
    error: 'Speech is unavailable: voice clip not found: a.wav',
  },
  {
    name: 'a sentence the engine breaks on',
    failure: new EngineFailedError('The engine failed (500).'),
    status: 502,
    error: 'Speech is unavailable: the engine could not speak that.',
  },
])('$name says that speech is unavailable', async (scenario) => {
  const app = testApp();
  app.jobs.failWith(scenario.failure);

  const response = await app.call('POST', '/api/speech', { text: 'Sit down.' });

  expect(response.status).toBe(scenario.status);
  expect(await response.json()).toEqual({ error: scenario.error });
});
