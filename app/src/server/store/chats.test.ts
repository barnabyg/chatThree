import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { ChatStore } from './chats.ts';
import { openDatabase, SCHEMA_VERSION } from './database.ts';

async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatthree-store-'));
  return path.join(directory, 'chatthree.db');
}

test('a conversation is read back in the order it was written', () => {
  const chats = new ChatStore(openDatabase(':memory:'));
  const chat = chats.create();

  chats.addMessage(chat.id, 'user', 'Hello?');
  chats.addMessage(chat.id, 'assistant', 'Who goes there?');

  expect(
    chats.messages(chat.id).map(({ role, content }) => ({ role, content })),
  ).toEqual([
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Who goes there?' },
  ]);
});

test('a conversation is still there after the database is closed and reopened', async () => {
  const file = await databaseFile();
  const first = openDatabase(file);
  const chat = new ChatStore(first).create();
  new ChatStore(first).addMessage(chat.id, 'user', 'Remember me.');
  first.close();

  const reopened = new ChatStore(openDatabase(file));

  expect(reopened.list().map(({ id }) => id)).toEqual([chat.id]);
  expect(reopened.messages(chat.id)[0]?.content).toBe('Remember me.');
});

test('messages belong to their own chat', () => {
  const chats = new ChatStore(openDatabase(':memory:'));
  const one = chats.create();
  const two = chats.create();

  chats.addMessage(one.id, 'user', 'In chat one.');

  expect(chats.messages(two.id)).toEqual([]);
});

test('the chat with the latest message is listed first', async () => {
  const chats = new ChatStore(openDatabase(':memory:'));
  const older = chats.create();
  const newer = chats.create();
  await new Promise((resolve) => setTimeout(resolve, 5));

  chats.addMessage(older.id, 'user', 'Back to this one.');

  expect(chats.list().map(({ id }) => id)).toEqual([older.id, newer.id]);
});

test('an unknown chat is not found', () => {
  const chats = new ChatStore(openDatabase(':memory:'));

  expect(chats.find('no-such-chat')).toBeUndefined();
});

test('the database records its schema version', async () => {
  const file = await databaseFile();
  openDatabase(file).close();

  const raw = new Database(file);
  expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  raw.close();
});

test('a database from a newer version of the app is refused, not damaged', async () => {
  const file = await databaseFile();
  const raw = new Database(file);
  raw.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
  raw.close();

  expect(() => openDatabase(file)).toThrow(/newer version of chatThree/);
});
