import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test } from 'vitest';
import { temporaryDirectory } from '../../../test-support/temporary.ts';
import { CharacterStore } from './characters.ts';
import { ChatStore } from './chats.ts';
import type { ChatSummary } from '../../shared/api.ts';
import { type Db, openDatabase, SCHEMA_VERSION } from './database.ts';
import { ScenarioStore } from './scenarios.ts';

function databaseFile(): string {
  return path.join(temporaryDirectory('store'), 'chatthree.db');
}

// Databases opened from files are closed after each test: an open database
// cannot be removed on Windows, and its file would be left behind.
const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function openFile(file: string): Db {
  const db = openDatabase(file);
  opened.push(db);
  return db;
}

/**
 * A chat store whose `create()` pairs the seeded character and scenario,
 * with no opening message.
 */
function open(db: Db = openDatabase(':memory:')): {
  chats: ChatStore & { start(): ChatSummary };
  characterId: string;
  scenarioId: string;
} {
  const [character] = new CharacterStore(db).list();
  const [scenario] = new ScenarioStore(db).list();
  if (character === undefined || scenario === undefined) {
    throw new Error('expected a seeded character and scenario');
  }
  const chats = new ChatStore(db);
  return {
    chats: Object.assign(chats, {
      start: () => chats.create(character.id, scenario.id),
    }),
    characterId: character.id,
    scenarioId: scenario.id,
  };
}

test('a conversation is read back in the order it was written', () => {
  const { chats } = open();
  const chat = chats.start();

  chats.addMessage(chat.id, 'user', 'Hello?');
  chats.addMessage(chat.id, 'assistant', 'Who goes there?');

  expect(
    chats.messages(chat.id).map(({ role, content }) => ({ role, content })),
  ).toEqual([
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Who goes there?' },
  ]);
});

test('a conversation is still there after the database is closed and reopened', () => {
  const file = databaseFile();
  const first = openDatabase(file);
  const { chats } = open(first);
  const chat = chats.start();
  chats.addMessage(chat.id, 'user', 'Remember me.');
  first.close();

  const reopened = open(openFile(file)).chats;

  expect(reopened.list().map(({ id }) => id)).toEqual([chat.id]);
  expect(reopened.messages(chat.id)[0]?.content).toBe('Remember me.');
});

test('messages belong to their own chat', () => {
  const { chats } = open();
  const one = chats.start();
  const two = chats.start();

  chats.addMessage(one.id, 'user', 'In chat one.');

  expect(chats.messages(two.id)).toEqual([]);
});

test('the chat with the latest message is listed first', async () => {
  const { chats } = open();
  const older = chats.start();
  const newer = chats.start();
  await new Promise((resolve) => setTimeout(resolve, 5));

  chats.addMessage(older.id, 'user', 'Back to this one.');

  expect(chats.list().map(({ id }) => id)).toEqual([older.id, newer.id]);
});

test('a chat knows its character and its scenario', () => {
  const { chats, characterId, scenarioId } = open();

  const chat = chats.start();

  expect(chat.character).toEqual({ id: characterId, name: 'Mara Quill' });
  expect(chat.scenario).toEqual({
    id: scenarioId,
    title: 'The Storm at Gull Point',
  });
});

test('an opening message is saved as the first message, from the character', () => {
  const { chats, characterId, scenarioId } = open();

  const chat = chats.create(characterId, scenarioId, 'You are late.');

  expect(
    chats.messages(chat.id).map(({ role, content }) => ({ role, content })),
  ).toEqual([{ role: 'assistant', content: 'You are late.' }]);
});

test('deleting a chat deletes its messages', () => {
  const { chats } = open();
  const chat = chats.start();
  chats.addMessage(chat.id, 'user', 'Hello?');

  expect(chats.delete(chat.id)).toBe(true);

  expect(chats.find(chat.id)).toBeUndefined();
  expect(chats.messages(chat.id)).toEqual([]);
});

test('an unknown chat is not found', () => {
  expect(open().chats.find('no-such-chat')).toBeUndefined();
});

test('the database records its schema version', () => {
  const file = databaseFile();
  openDatabase(file).close();

  const raw = new Database(file);
  expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  raw.close();
});

test('a database from a newer version of the app is refused, not damaged', () => {
  const file = databaseFile();
  const raw = new Database(file);
  raw.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
  raw.close();

  expect(() => openDatabase(file)).toThrow(/newer version of chatThree/);
});

test('a chat saved before scenarios existed keeps its own character and conversation, in the built-in scenario', () => {
  // The database exactly as schema version 2 wrote it.
  const file = databaseFile();
  const old = new Database(file);
  old.exec(`
    CREATE TABLE characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      persona TEXT NOT NULL DEFAULT '',
      speaking_style TEXT NOT NULL DEFAULT '',
      example_dialogue TEXT NOT NULL DEFAULT '',
      appearance TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX chats_by_character ON chats (character_id);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX messages_by_chat ON messages (chat_id, id);
    INSERT INTO characters (id, name, persona, created_at, updated_at) VALUES
      ('tomas', 'Tomas Reed', 'A ferryman.', '2026-02-01T09:00:00.000Z', '2026-02-01T09:00:00.000Z');
    INSERT INTO chats VALUES
      ('ferry-chat', 'tomas', '2026-02-01T10:00:00.000Z', '2026-02-01T10:05:00.000Z');
    INSERT INTO messages (chat_id, role, content, created_at) VALUES
      ('ferry-chat', 'user', 'Take me across.', '2026-02-01T10:00:00.000Z'),
      ('ferry-chat', 'assistant', 'In time.', '2026-02-01T10:05:00.000Z');
    PRAGMA user_version = 2;
  `);
  old.close();

  const chats = new ChatStore(openFile(file));

  expect(chats.list()).toEqual([
    {
      id: 'ferry-chat',
      character: { id: 'tomas', name: 'Tomas Reed' },
      scenario: {
        id: expect.any(String) as string,
        title: 'The Storm at Gull Point',
      },
      lastActivityAt: '2026-02-01T10:05:00.000Z',
    },
  ]);
  // The old conversation is untouched: no opening message is added to it.
  expect(chats.messages('ferry-chat').map(({ content }) => content)).toEqual([
    'Take me across.',
    'In time.',
  ]);
});

test('a chat saved before characters existed is still readable, with the built-in character', () => {
  // The database exactly as schema version 1 wrote it.
  const file = databaseFile();
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

  const db = openFile(file);
  const { chats } = open(db);

  expect(chats.list()).toEqual([
    {
      id: 'old-chat',
      character: { id: expect.any(String) as string, name: 'Mara Quill' },
      scenario: {
        id: expect.any(String) as string,
        title: 'The Storm at Gull Point',
      },
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
