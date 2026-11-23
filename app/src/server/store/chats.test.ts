import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { CharacterStore } from './characters.ts';
import { ChatStore } from './chats.ts';
import { type Db, openDatabase, SCHEMA_VERSION } from './database.ts';

async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'chatthree-store-'));
  return path.join(directory, 'chatthree.db');
}

/** A chat store, and the ID of a character to start chats with. */
function open(db: Db = openDatabase(':memory:')): {
  chats: ChatStore;
  characterId: string;
} {
  const [character] = new CharacterStore(db).list();
  if (character === undefined) throw new Error('expected a seeded character');
  return { chats: new ChatStore(db), characterId: character.id };
}

test('a conversation is read back in the order it was written', () => {
  const { chats, characterId } = open();
  const chat = chats.create(characterId);

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
  const { chats, characterId } = open(first);
  const chat = chats.create(characterId);
  chats.addMessage(chat.id, 'user', 'Remember me.');
  first.close();

  const reopened = open(openDatabase(file)).chats;

  expect(reopened.list().map(({ id }) => id)).toEqual([chat.id]);
  expect(reopened.messages(chat.id)[0]?.content).toBe('Remember me.');
});

test('messages belong to their own chat', () => {
  const { chats, characterId } = open();
  const one = chats.create(characterId);
  const two = chats.create(characterId);

  chats.addMessage(one.id, 'user', 'In chat one.');

  expect(chats.messages(two.id)).toEqual([]);
});

test('the chat with the latest message is listed first', async () => {
  const { chats, characterId } = open();
  const older = chats.create(characterId);
  const newer = chats.create(characterId);
  await new Promise((resolve) => setTimeout(resolve, 5));

  chats.addMessage(older.id, 'user', 'Back to this one.');

  expect(chats.list().map(({ id }) => id)).toEqual([older.id, newer.id]);
});

test('a chat knows which character it is with', () => {
  const { chats, characterId } = open();

  const chat = chats.create(characterId);

  expect(chat.character).toEqual({ id: characterId, name: 'Mara Quill' });
});

test('an unknown chat is not found', () => {
  expect(open().chats.find('no-such-chat')).toBeUndefined();
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

test('a chat saved before characters existed is still readable, with the built-in character', async () => {
  // The database exactly as schema version 1 wrote it.
  const file = await databaseFile();
  const old = new Database(file);
  old.exec(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX messages_by_chat ON messages (chat_id, id);
    INSERT INTO chats VALUES ('old-chat', '2026-01-01T10:00:00.000Z', '2026-01-01T10:05:00.000Z');
    INSERT INTO messages (chat_id, role, content, created_at) VALUES
      ('old-chat', 'user', 'Hello from the past.', '2026-01-01T10:00:00.000Z'),
      ('old-chat', 'assistant', 'And hello to you.', '2026-01-01T10:05:00.000Z');
    PRAGMA user_version = 1;
  `);
  old.close();

  const db = openDatabase(file);
  const { chats } = open(db);

  expect(chats.list()).toEqual([
    {
      id: 'old-chat',
      character: { id: expect.any(String) as string, name: 'Mara Quill' },
      lastActivityAt: '2026-01-01T10:05:00.000Z',
    },
  ]);
  expect(chats.messages('old-chat').map(({ content }) => content)).toEqual([
    'Hello from the past.',
    'And hello to you.',
  ]);
  // Its messages still belong to it: deleting the chat's character removes both.
  new CharacterStore(db).delete(chats.list()[0]?.character.id ?? '');
  expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({
    n: 0,
  });
});
