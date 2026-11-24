import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { solidPng } from '../../../test-support/png.ts';
import type { Chat, Message, ScenarioInput } from '../../shared/api.ts';
import type { PaintRequest } from '../engine/jobs.ts';
import {
  BLANK_SCENARIO,
  builtInCharacter,
  PLAIN_SCENE,
  replyEvents,
  type TestApp,
  testApp,
} from '../testing.ts';

const LIGHTHOUSE: ScenarioInput = {
  ...BLANK_SCENARIO,
  title: 'The Storm at Gull Point',
  openingMessage: 'You are soaked through. Come in.',
  startingLocation: {
    name: 'The kitchen',
    description: 'A low room with an iron stove.',
  },
};

/** A scene call answer that puts the moment in the place named. */
function sceneAt(moved: boolean, name: string, description = '') {
  return { value: { ...PLAIN_SCENE, moved, location: { name, description } } };
}

async function lighthouseChat(): Promise<{ app: TestApp; chat: Chat }> {
  const app = testApp();
  const character = await builtInCharacter(app);
  await app.upload(
    'PUT',
    `/api/characters/${character.id}/image`,
    solidPng(8, 8, [10, 20, 30]),
  );
  const chat = await app.startChat({
    scenarioId: app.scenarios.create(LIGHTHOUSE).id,
  });
  return { app, chat };
}

async function readChat(app: TestApp, id: string): Promise<Chat> {
  return (await (await app.call('GET', `/api/chats/${id}`)).json()) as Chat;
}

/** Send a message and return the character's reply to it. */
async function exchange(app: TestApp, chat: Chat): Promise<Message> {
  await replyEvents(
    await app.call('POST', `/api/chats/${chat.id}/messages`, {
      content: 'Go on.',
    }),
  );
  const reply = (await readChat(app, chat.id)).messages.at(-1);
  if (reply === undefined) throw new Error('expected a reply');
  return reply;
}

/** Illustrate a message and return the chat once it is done. */
async function illustrated(
  app: TestApp,
  chat: Chat,
  message: Message | undefined,
): Promise<Chat> {
  await app.call(
    'POST',
    `/api/chats/${chat.id}/messages/${String(message?.id)}/illustrate`,
  );
  await expect
    .poll(async () => (await readChat(app, chat.id)).illustrating)
    .toEqual([]);
  return readChat(app, chat.id);
}

function painted(app: TestApp): PaintRequest[] {
  return app.jobs.requests.flatMap((request) =>
    request.job === 'paint' ? [request] : [],
  );
}

/** The place picture a scene was painted from: its second reference. */
function placeReference(request: PaintRequest | undefined): string {
  return path.basename(request?.references?.[1] ?? '');
}

/** The file a place's picture address serves, by the version in it. */
function fileOf(imageUrl: string | null | undefined): string {
  return `${new URL(imageUrl ?? '', 'http://x').searchParams.get('v') ?? ''}.png`;
}

describe("following the story's places", () => {
  test("a chat begins at its scenario's starting location, with no picture yet", async () => {
    const { app, chat } = await lighthouseChat();

    expect(chat.location).toMatchObject({
      name: 'The kitchen',
      description: 'A low room with an iron stove.',
      imageUrl: null,
    });
    expect(chat.locations).toEqual([chat.location]);
    expect((await readChat(app, chat.id)).location.id).toBe(chat.location.id);
  });

  test('a scenario with no starting location begins at its premise', async () => {
    const app = testApp();

    const chat = await app.startChat({
      scenarioId: app.scenarios.create({
        ...BLANK_SCENARIO,
        premise: 'A night ferry crossing.',
      }).id,
    });

    expect(chat.location).toMatchObject({
      name: 'Where the story begins',
      description: 'A night ferry crossing.',
    });
  });

  test('the scene call is told the places the story has been', async () => {
    const { app, chat } = await lighthouseChat();

    await illustrated(app, chat, chat.messages[0]);

    expect(app.provider.structuredRequests[0]?.instructions).toContain(
      '- The kitchen',
    );
  });

  test('staying put keeps the place and its picture', async () => {
    const { app, chat } = await lighthouseChat();
    await illustrated(app, chat, chat.messages[0]);
    const reply = await exchange(app, chat);
    app.provider.scriptStructured(sceneAt(false, 'The kitchen'));

    const done = await illustrated(app, chat, reply);

    expect(done.locations).toHaveLength(1);
    expect(done.location.name).toBe('The kitchen');
    expect(painted(app)).toHaveLength(3);
  });

  test('moving somewhere new adds a place, with its own picture, and illustrates it there', async () => {
    const { app, chat } = await lighthouseChat();
    await illustrated(app, chat, chat.messages[0]);
    const reply = await exchange(app, chat);
    app.provider.scriptStructured(
      sceneAt(true, 'The lamp room', 'A glass room at the top of the tower.'),
    );

    const done = await illustrated(app, chat, reply);

    expect(done.location).toMatchObject({
      name: 'The lamp room',
      description: 'A glass room at the top of the tower.',
    });
    expect(done.locations.map(({ name }) => name)).toEqual([
      'The kitchen',
      'The lamp room',
    ]);
    const [, kitchenScene, lampRoom, lampRoomScene] = painted(app);
    expect(lampRoom?.prompt).toContain('A glass room at the top of the tower.');
    expect(placeReference(lampRoomScene)).toBe(fileOf(done.location.imageUrl));
    expect(placeReference(lampRoomScene)).not.toBe(
      placeReference(kitchenScene),
    );
  });

  test('returning to an earlier place reuses its picture', async () => {
    const { app, chat } = await lighthouseChat();
    await illustrated(app, chat, chat.messages[0]);
    app.provider.scriptStructured(sceneAt(true, 'The lamp room', 'Glass.'));
    await illustrated(app, chat, await exchange(app, chat));
    app.provider.scriptStructured(sceneAt(true, 'the kitchen'));

    const done = await illustrated(app, chat, await exchange(app, chat));

    expect(done.location.name).toBe('The kitchen');
    expect(done.locations).toHaveLength(2);
    const paints = painted(app);
    // Kitchen, scene, lamp room, scene, scene: the kitchen is not painted again.
    expect(paints).toHaveLength(5);
    expect(placeReference(paints[4])).toBe(placeReference(paints[1]));
  });

  test("an earlier message is pictured where it took place, without moving the chat's story", async () => {
    const { app, chat } = await lighthouseChat();
    await exchange(app, chat);
    app.provider.scriptStructured(sceneAt(true, 'The jetty', 'Wet planks.'));

    const done = await illustrated(app, chat, chat.messages[0]);

    expect(done.location.name).toBe('The kitchen');
    expect(done.locations.map(({ name }) => name)).toEqual([
      'The kitchen',
      'The jetty',
    ]);
  });

  test("a place's picture can be painted again, and the new one is used", async () => {
    const { app, chat } = await lighthouseChat();
    const first = (await illustrated(app, chat, chat.messages[0])).location;

    const response = await app.call(
      'POST',
      `/api/chats/${chat.id}/locations/${String(first.id)}/image/generate`,
    );

    expect(response.status).toBe(200);
    const { location } = (await response.json()) as Chat;
    expect(location.imageUrl).not.toBe(first.imageUrl);
    const served = await app.call('GET', location.imageUrl ?? '');
    expect(served.headers.get('Content-Type')).toBe('image/png');
    expect((await app.call('GET', first.imageUrl ?? '')).status).toBe(404);
    const folder = path.join(app.dataDir, 'locations');
    expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([
      fileOf(location.imageUrl),
    ]);

    await illustrated(app, chat, chat.messages[0]);
    expect(placeReference(painted(app).at(-1))).toBe(fileOf(location.imageUrl));
  });

  test("a place's picture can be painted before any illustration", async () => {
    const { app, chat } = await lighthouseChat();

    const response = await app.call(
      'POST',
      `/api/chats/${chat.id}/locations/${String(chat.location.id)}/image/generate`,
    );

    expect(((await response.json()) as Chat).location.imageUrl).not.toBeNull();
  });

  test('a place that is not in the chat cannot be painted', async () => {
    const { app, chat } = await lighthouseChat();
    const other = await app.startChat();

    const response = await app.call(
      'POST',
      `/api/chats/${chat.id}/locations/${String(other.location.id)}/image/generate`,
    );

    expect(response.status).toBe(404);
  });
});
