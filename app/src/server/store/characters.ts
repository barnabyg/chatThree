import { randomUUID } from 'node:crypto';
import type { Character, CharacterInput } from '../../shared/api.ts';
import type { Db } from './database.ts';

interface CharacterRow extends CharacterInput {
  id: string;
  chatCount: number;
  voiceFile: string | null;
}

const SELECT = `
  SELECT
    characters.id,
    characters.name,
    characters.persona,
    characters.speaking_style AS speakingStyle,
    characters.example_dialogue AS exampleDialogue,
    characters.appearance,
    characters.voice_file AS voiceFile,
    (SELECT COUNT(*) FROM chats WHERE chats.character_id = characters.id) AS chatCount
  FROM characters`;

function toCharacter({ voiceFile, ...row }: CharacterRow): Character {
  return { ...row, hasVoice: voiceFile !== null };
}

/** The user's characters, saved in the database. */
export class CharacterStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every character, by name. */
  list(): Character[] {
    return this.#db
      .prepare<[], CharacterRow>(
        `${SELECT} ORDER BY name COLLATE NOCASE, rowid`,
      )
      .all()
      .map(toCharacter);
  }

  find(id: string): Character | undefined {
    const row = this.#row(id);
    return row === undefined ? undefined : toCharacter(row);
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
    return { ...input, id, chatCount: 0, hasVoice: false };
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
   * The character's voice clip, as the name of a file in the media store
   * (store/media.ts), or `undefined` if the character has none.
   */
  voiceFile(id: string): string | undefined {
    return this.#row(id)?.voiceFile ?? undefined;
  }

  /** Give the character a voice clip, or take it away with `null`. */
  setVoiceFile(id: string, file: string | null): void {
    this.#db
      .prepare(
        'UPDATE characters SET voice_file = ?, updated_at = ? WHERE id = ?',
      )
      .run(file, new Date().toISOString(), id);
  }

  /**
   * Delete a character and, with it, every chat with that character.
   * Returns false if there is no character with `id`. The character's files
   * in the media store are the caller's to remove.
   */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM characters WHERE id = ?').run(id).changes >
      0
    );
  }

  #row(id: string): CharacterRow | undefined {
    return this.#db
      .prepare<[string], CharacterRow>(`${SELECT} WHERE id = ?`)
      .get(id);
  }
}
