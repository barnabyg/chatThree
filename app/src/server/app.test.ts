import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { createApp } from './app.ts';

let uiDir: string;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chatthree-app-test-'));
  uiDir = path.join(root, 'ui');
  await mkdir(path.join(uiDir, 'assets'), { recursive: true });
  await writeFile(path.join(uiDir, 'index.html'), '<html>the ui</html>');
  await writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(path.join(root, 'secret.txt'), 'outside the ui directory');
});

const local = { headers: { host: '127.0.0.1:3210' } };

describe('serving the UI', () => {
  test('serves a built file with its content type', async () => {
    const response = await createApp({ uiDir }).request(
      '/assets/app.js',
      local,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(await response.text()).toBe('console.log(1)');
  });

  test('serves the UI for any path that is not a file, so the UI owns its routes', async () => {
    const response = await createApp({ uiDir }).request('/chats/42', local);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<html>the ui</html>');
  });

  test('does not serve files outside the UI directory', async () => {
    const response = await createApp({ uiDir }).request(
      '/..%2Fsecret.txt',
      local,
    );

    expect(await response.text()).toBe('<html>the ui</html>');
  });

  test('says how to build the UI when it has not been built', async () => {
    const response = await createApp({
      uiDir: path.join(uiDir, 'missing'),
    }).request('/', local);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('start.ps1');
  });
});

describe('the API', () => {
  test('reports health', async () => {
    const response = await createApp({ uiDir }).request('/api/health', local);

    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('answers unknown API paths with a JSON 404, not the UI', async () => {
    const response = await createApp({ uiDir }).request('/api/nope', local);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

describe('requests from other sites', () => {
  test('refuses a request addressed to another host name (DNS rebinding)', async () => {
    const response = await createApp({ uiDir }).request('/api/health', {
      headers: { host: 'evil.example:3210' },
    });

    expect(response.status).toBe(403);
  });

  test('refuses a request sent by a page on another origin', async () => {
    const response = await createApp({ uiDir }).request('/api/health', {
      method: 'POST',
      headers: { host: '127.0.0.1:3210', origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
  });

  test('accepts a request from its own UI', async () => {
    const response = await createApp({ uiDir }).request('/api/health', {
      headers: { host: 'localhost:3210', origin: 'http://localhost:3210' },
    });

    expect(response.status).toBe(200);
  });
});
