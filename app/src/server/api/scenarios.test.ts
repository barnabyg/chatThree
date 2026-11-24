import { describe, expect, test } from 'vitest';
import type { Scenario } from '../../shared/api.ts';
import { readReply, replyEvents, type TestApp, testApp } from '../testing.ts';

const FERRY = {
  title: 'The Night Ferry',
  premise: 'The last ferry of the night is leaving, and it is not empty.',
  userPersona: { name: 'Wren', description: 'A courier with a sealed letter.' },
  openingMessage: 'You are late. Get aboard.',
  startingLocation: {
    name: 'The river quay',
    description: 'Fog, lantern light and black water.',
  },
};

async function list(app: TestApp): Promise<Scenario[]> {
  return (await (await app.call('GET', '/api/scenarios')).json()) as Scenario[];
}

async function create(app: TestApp, input: object = FERRY): Promise<Scenario> {
  const response = await app.call('POST', '/api/scenarios', input);
  expect(response.status).toBe(201);
  return (await response.json()) as Scenario;
}

test('the built-in scenario is there to begin with, as an ordinary scenario', async () => {
  const app = testApp();

  const [builtIn, ...others] = await list(app);

  expect(others).toEqual([]);
  expect(builtIn).toMatchObject({
    title: 'The Storm at Gull Point',
    chatCount: 0,
  });
  expect(builtIn?.openingMessage).not.toBe('');

  const edited = await app.call('PUT', `/api/scenarios/${builtIn?.id ?? ''}`, {
    ...FERRY,
    title: 'The Storm, Retold',
  });
  expect(edited.status).toBe(200);
  expect((await list(app)).map(({ title }) => title)).toEqual([
    'The Storm, Retold',
  ]);
});

describe('creating a scenario', () => {
  test('saves every field', async () => {
    const app = testApp();

    const created = await create(app);

    const read = await app.call('GET', `/api/scenarios/${created.id}`);
    expect(await read.json()).toEqual({
      ...FERRY,
      id: created.id,
      chatCount: 0,
    });
  });

  test('needs only a title', async () => {
    const app = testApp();

    const created = await create(app, { title: 'A blank page' });

    expect(created).toMatchObject({
      title: 'A blank page',
      premise: '',
      userPersona: { name: '', description: '' },
      openingMessage: '',
      startingLocation: { name: '', description: '' },
    });
  });

  test('is refused without a title', async () => {
    const app = testApp();

    const response = await app.call('POST', '/api/scenarios', {
      ...FERRY,
      title: ' ',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'A scenario needs a title.',
    });
    expect(await list(app)).toHaveLength(1);
  });
});

test('editing a scenario changes it', async () => {
  const app = testApp();
  const created = await create(app);

  const response = await app.call('PUT', `/api/scenarios/${created.id}`, {
    ...FERRY,
    userPersona: { name: 'Wren', description: 'A smuggler, in truth.' },
  });

  expect(await response.json()).toMatchObject({
    id: created.id,
    userPersona: { name: 'Wren', description: 'A smuggler, in truth.' },
  });
});

test('an unknown scenario is a 404', async () => {
  const response = await testApp().call('GET', '/api/scenarios/no-such-id');

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: 'That scenario does not exist.',
  });
});

test("a chat's prompt carries its scenario's premise, the user's part and the starting location, after the character", async () => {
  const app = testApp();
  const chat = await app.startChat({ scenarioId: (await create(app)).id });

  await replyEvents(
    await app.call('POST', `/api/chats/${chat.id}/messages`, {
      content: 'Wait for me!',
    }),
  );

  const instructions = app.provider.requests[0]?.instructions ?? '';
  const positions = [
    '# Character: Mara Quill',
    '# Scenario: The Night Ferry',
    FERRY.premise,
    'Wren',
    FERRY.userPersona.description,
    'The river quay',
    FERRY.startingLocation.description,
  ].map((part) => instructions.indexOf(part));
  expect(positions).not.toContain(-1);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  // The opening message is part of the conversation, not of the prefix.
  expect(instructions).not.toContain(FERRY.openingMessage);
});

describe('deleting a scenario', () => {
  test('removes it', async () => {
    const app = testApp();
    const ferry = await create(app);

    const response = await app.call('DELETE', `/api/scenarios/${ferry.id}`);

    expect(response.status).toBe(204);
    expect((await list(app)).map(({ title }) => title)).toEqual([
      'The Storm at Gull Point',
    ]);
  });

  test('counts its chats, deletes them with it, and leaves other chats alone', async () => {
    const app = testApp();
    const ferry = await create(app);
    const kept = await app.startChat();
    const lost = await app.startChat({ scenarioId: ferry.id });
    expect((await list(app)).find(({ id }) => id === ferry.id)?.chatCount).toBe(
      1,
    );

    await app.call('DELETE', `/api/scenarios/${ferry.id}`);

    expect((await app.call('GET', `/api/chats/${lost.id}`)).status).toBe(404);
    expect((await app.call('GET', `/api/chats/${kept.id}`)).status).toBe(200);
  });

  test('is refused while a reply is being written in one of its chats', async () => {
    const app = testApp();
    app.provider.script({ pieces: ['In'], thenWait: true });
    const ferry = await create(app);
    const chat = await app.startChat({ scenarioId: ferry.id });
    const reply = readReply(
      await app.call('POST', `/api/chats/${chat.id}/messages`, {
        content: 'Hello?',
      }),
    );
    await reply.next();

    const response = await app.call('DELETE', `/api/scenarios/${ferry.id}`);

    expect(response.status).toBe(409);
    await app.call('POST', `/api/chats/${chat.id}/stop`);
    await reply.next();
    await reply.next();
  });
});
