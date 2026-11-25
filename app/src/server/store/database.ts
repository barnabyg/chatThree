// The SQLite database that holds chats. Its layout is versioned: the version
// is SQLite's `user_version`, and each entry in MIGRATIONS moves a database
// one version forward. Released migrations are never edited, only added to,
// so a database written by any earlier version of the app still opens.

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  BUILT_IN_CHARACTER,
  BUILT_IN_PLAYER,
  BUILT_IN_SCENARIO,
} from '../chat/builtin.ts';

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

  // 3: scenarios. Until now every chat was set in the built-in scenario,
  // which becomes an ordinary row that existing chats point to. Existing
  // chats are not given its opening message: their conversations are theirs.
  (db) => {
    db.exec(`
      CREATE TABLE scenarios (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        premise TEXT NOT NULL DEFAULT '',
        user_name TEXT NOT NULL DEFAULT '',
        user_description TEXT NOT NULL DEFAULT '',
        opening_message TEXT NOT NULL DEFAULT '',
        location_name TEXT NOT NULL DEFAULT '',
        location_description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const builtIn = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO scenarios
         (id, title, premise, user_name, user_description, opening_message,
          location_name, location_description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      builtIn,
      BUILT_IN_SCENARIO.title,
      BUILT_IN_SCENARIO.premise,
      BUILT_IN_PLAYER.name,
      BUILT_IN_PLAYER.background,
      BUILT_IN_SCENARIO.openingMessage,
      BUILT_IN_SCENARIO.startingLocation.name,
      BUILT_IN_SCENARIO.startingLocation.description,
      now,
      now,
    );
    // Rebuilt for the same reason as in migration 2. Deleting a scenario
    // deletes its chats.
    db.exec(`
      CREATE TABLE chats_new (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters (id) ON DELETE CASCADE,
        scenario_id TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      'INSERT INTO chats_new SELECT id, character_id, ?, created_at, updated_at FROM chats',
    ).run(builtIn);
    db.exec(`
      DROP TABLE chats;
      ALTER TABLE chats_new RENAME TO chats;
      CREATE INDEX chats_by_character ON chats (character_id);
      CREATE INDEX chats_by_scenario ON chats (scenario_id);
    `);
  },

  // 4: a voice clip per character. The column holds the name of a file in
  // the media store (store/media.ts), and is empty for the built-in voice.
  (db) => {
    db.exec('ALTER TABLE characters ADD COLUMN voice_file TEXT');
  },

  // 5: a reference picture per character, kept the same way as the voice clip.
  (db) => {
    db.exec('ALTER TABLE characters ADD COLUMN image_file TEXT');
  },

  // 6: illustrations. Each chat has places the story has been, each with a
  // reference picture once one is needed, and a current one; a chat's first
  // is recorded from its scenario's starting location when first needed.
  // An illustration is a picture of one of the character's messages. Files
  // are kept as the characters' are.
  (db) => {
    db.exec(`
      CREATE TABLE locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        image_file TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX locations_by_chat ON locations (chat_id, id);
      ALTER TABLE chats ADD COLUMN location_id INTEGER
        REFERENCES locations (id) ON DELETE SET NULL;
      CREATE TABLE illustrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
        location_id INTEGER REFERENCES locations (id) ON DELETE SET NULL,
        image_file TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX illustrations_by_message ON illustrations (message_id, id);
    `);
  },

  // 7: when a picture was last asked for in a chat, as the newest message's
  // id at the time, so that automatic pictures can wait a number of replies;
  // and the place each of the character's messages took the story to, so
  // that deleting or regenerating a message undoes the move it made.
  (db) => {
    db.exec(`
      ALTER TABLE chats ADD COLUMN illustrated_through INTEGER;
      ALTER TABLE messages ADD COLUMN location_id INTEGER
        REFERENCES locations (id) ON DELETE SET NULL;
    `);
  },

  // 8: players. Who the user plays moves out of scenarios: each scenario's
  // part (user_name, user_description), unless blank, becomes a player, one
  // per distinct part, and that scenario's chats are played as it, so their
  // prompts are unchanged. Those scenario columns are no longer used. A chat
  // need not have a player; deleting a player deletes its chats.
  (db) => {
    db.exec(`
      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        background TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE chats ADD COLUMN player_id TEXT
        REFERENCES players (id) ON DELETE CASCADE;
      CREATE INDEX chats_by_player ON chats (player_id);
    `);
    const scenarios = db
      .prepare<
        [],
        {
          id: string;
          title: string;
          user_name: string;
          user_description: string;
        }
      >(
        'SELECT id, title, user_name, user_description FROM scenarios ORDER BY rowid',
      )
      .all();
    const insert = db.prepare(
      'INSERT INTO players (id, name, background, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    const assign = db.prepare(
      'UPDATE chats SET player_id = ? WHERE scenario_id = ?',
    );
    const made = new Map<string, string>();
    const now = new Date().toISOString();
    for (const scenario of scenarios) {
      const background = scenario.user_description.trim();
      // A player needs a name; a part with only a description is named
      // after its scenario.
      const name =
        scenario.user_name.trim() ||
        (background === '' ? '' : `Player in ${scenario.title}`.slice(0, 100));
      if (name === '') continue;
      const key = JSON.stringify([name, background]);
      let id = made.get(key);
      if (id === undefined) {
        id = randomUUID();
        insert.run(id, name, background, now, now);
        made.set(key, id);
      }
      assign.run(id, scenario.id);
    }
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
