import { randomUUID } from 'node:crypto';
import type { Character, CharacterInput } from '../../shared/api.ts';
import type { Db } from './database.ts';

const SELECT = `
  SELECT
    characters.id,
    characters.name,
    characters.persona,
    characters.speaking_style AS speakingStyle,
    characters.example_dialogue AS exampleDialogue,
    characters.appearance,
    (SELECT COUNT(*) FROM chats WHERE chats.character_id = characters.id) AS chatCount
  FROM characters`;

/** The user's characters, saved in the database. */
export class CharacterStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every character, by name. */
  list(): Character[] {
    return this.#db
      .prepare<[], Character>(`${SELECT} ORDER BY name COLLATE NOCASE, rowid`)
      .all();
  }

  find(id: string): Character | undefined {
    return this.#db
      .prepare<[string], Character>(`${SELECT} WHERE id = ?`)
      .get(id);
  }

  create(input: CharacterInput): Character {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO characters
           (id, name, persona, speaking_style, example_dialogue, appearance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.persona,
        input.speakingStyle,
        input.exampleDialogue,
        input.appearance,
        now,
        now,
      );
    return { ...input, id, chatCount: 0 };
  }

  /** Returns the updated character, or `undefined` if there is none with `id`. */
  update(id: string, input: CharacterInput): Character | undefined {
    this.#db
      .prepare(
        `UPDATE characters
         SET name = ?, persona = ?, speaking_style = ?, example_dialogue = ?, appearance = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        input.persona,
        input.speakingStyle,
        input.exampleDialogue,
        input.appearance,
        new Date().toISOString(),
        id,
      );
    return this.find(id);
  }

  /**
   * Delete a character and, with it, every chat with that character.
   * Returns false if there is no character with `id`.
   */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM characters WHERE id = ?').run(id).changes >
      0
    );
  }
}
