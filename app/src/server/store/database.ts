// The SQLite database that holds chats. Its layout is versioned: the version
// is SQLite's `user_version`, and each entry in MIGRATIONS moves a database
// one version forward. Released migrations are never edited, only added to,
// so a database written by any earlier version of the app still opens.

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { BUILT_IN_CHARACTER } from '../chat/builtin.ts';

export type Db = Database.Database;

const MIGRATIONS: readonly ((db: Db) => void)[] = [
  // 1: chats and their messages.
  (db) => {
    db.exec(`
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
    `);
  },

  // 2: characters. Until now every chat was with the built-in character,
  // which becomes an ordinary row that existing chats point to.
  (db) => {
    db.exec(`
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
    `);
    const builtIn = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO characters
         (id, name, persona, speaking_style, example_dialogue, appearance, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      builtIn,
      BUILT_IN_CHARACTER.name,
      BUILT_IN_CHARACTER.persona,
      BUILT_IN_CHARACTER.speakingStyle,
      BUILT_IN_CHARACTER.exampleDialogue,
      BUILT_IN_CHARACTER.appearance,
      now,
      now,
    );
    // SQLite cannot add a NOT NULL reference to a table that has rows, so
    // the table is rebuilt. Deleting a character deletes its chats.
    db.exec(`
      CREATE TABLE chats_new (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO chats_new SELECT id, ?, created_at, updated_at FROM chats',
    ).run(builtIn);
    db.exec(`
      DROP TABLE chats;
      ALTER TABLE chats_new RENAME TO chats;
      CREATE INDEX chats_by_character ON chats (character_id);
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `The chat database was written by a newer version of chatThree (schema version ${String(version)}; this version reads up to ${String(SCHEMA_VERSION)}). Update chatThree to open it.`,
    );
  }
  // Rebuilding a table breaks references to it until the migration ends, so
  // references are checked once per migration instead of per statement.
  db.pragma('foreign_keys = OFF');
  MIGRATIONS.slice(version).forEach((step, index) => {
    db.transaction(() => {
      step(db);
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length > 0) {
        throw new Error(
          `Migrating the chat database to schema version ${String(version + index + 1)} left ${String(broken.length)} broken references.`,
        );
      }
      db.pragma(`user_version = ${String(version + index + 1)}`);
    })();
  });
  db.pragma('foreign_keys = ON');
}

/** Open the database at `file`, creating or upgrading it as needed. */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
