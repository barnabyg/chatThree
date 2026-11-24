// What a chat's illustrations need: the places its story has been, which one
// it is in now, and the pictures made of its moments.

import type { Illustration } from '../../shared/api.ts';
import type { Db } from './database.ts';

/** A place in one chat's story. */
export interface StoredLocation {
  id: number;
  name: string;
  description: string;
  /** The name of its reference picture in the media store, if it has one. */
  imageFile: string | undefined;
}

interface LocationRow {
  id: number;
  name: string;
  description: string;
  imageFile: string | null;
}

const toLocation = ({ imageFile, ...row }: LocationRow): StoredLocation => ({
  ...row,
  imageFile: imageFile ?? undefined,
});

const LOCATION =
  'SELECT id, name, description, image_file AS imageFile FROM locations';

/** Where an illustration is served from (api/chats.ts). */
function illustrationUrl(chatId: string, id: number): string {
  return `/api/chats/${chatId}/illustrations/${String(id)}/image`;
}

export class SceneStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every place in the chat's story, in the order the story reached them. */
  locations(chatId: string): StoredLocation[] {
    return this.#db
      .prepare<[string], LocationRow>(
        `${LOCATION} WHERE chat_id = ? ORDER BY id`,
      )
      .all(chatId)
      .map(toLocation);
  }

  location(chatId: string, id: number): StoredLocation | undefined {
    const row = this.#db
      .prepare<[string, number], LocationRow>(
        `${LOCATION} WHERE chat_id = ? AND id = ?`,
      )
      .get(chatId, id);
    return row === undefined ? undefined : toLocation(row);
  }

  /**
   * Where the chat's story is now. A chat that has not recorded one yet is
   * where it began: `start` is recorded as its first place and returned.
   */
  currentLocation(
    chatId: string,
    start: { name: string; description: string },
  ): StoredLocation {
    return this.#db.transaction(() => {
      const row = this.#db
        .prepare<[string], LocationRow>(
          `${LOCATION} WHERE id = (SELECT location_id FROM chats WHERE id = ?)`,
        )
        .get(chatId);
      if (row !== undefined) return toLocation(row);
      const first = this.addLocation(chatId, start);
      this.moveTo(chatId, first.id);
      return first;
    })();
  }

  addLocation(
    chatId: string,
    { name, description }: { name: string; description: string },
  ): StoredLocation {
    const { lastInsertRowid } = this.#db
      .prepare(
        'INSERT INTO locations (chat_id, name, description, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(chatId, name, description, new Date().toISOString());
    return {
      id: Number(lastInsertRowid),
      name,
      description,
      imageFile: undefined,
    };
  }

  /** Make `locationId`, one of the chat's places, where its story is now. */
  moveTo(chatId: string, locationId: number): void {
    this.#db
      .prepare(
        `UPDATE chats SET location_id = ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM locations WHERE id = ? AND chat_id = ?)`,
      )
      .run(locationId, chatId, locationId, chatId);
  }

  /**
   * Record the place's reference picture. Returns the file it replaces, or
   * `undefined` if it had none; `false` if the place has gone.
   */
  setLocationImage(
    locationId: number,
    file: string,
  ): string | undefined | false {
    return this.#db.transaction(() => {
      const old = this.#db
        .prepare<[number], { imageFile: string | null }>(
          'SELECT image_file AS imageFile FROM locations WHERE id = ?',
        )
        .get(locationId);
      if (old === undefined) return false;
      this.#db
        .prepare('UPDATE locations SET image_file = ? WHERE id = ?')
        .run(file, locationId);
      return old.imageFile ?? undefined;
    })();
  }

  /**
   * Record a picture of a message, made in `locationId`. Returns `undefined`,
   * recording nothing, if the message is no longer in the chat.
   */
  addIllustration(
    chatId: string,
    messageId: number,
    locationId: number,
    file: string,
  ): Illustration | undefined {
    const message = this.#db
      .prepare<[number, string], { id: number }>(
        'SELECT id FROM messages WHERE id = ? AND chat_id = ?',
      )
      .get(messageId, chatId);
    if (message === undefined) return undefined;
    const { lastInsertRowid } = this.#db
      .prepare(
        `INSERT INTO illustrations (message_id, location_id, image_file, created_at)
         VALUES (?, (SELECT id FROM locations WHERE id = ?), ?, ?)`,
      )
      .run(messageId, locationId, file, new Date().toISOString());
    const id = Number(lastInsertRowid);
    return { id, messageId, imageUrl: illustrationUrl(chatId, id) };
  }

  /** The chat's illustrations, oldest first. */
  illustrations(chatId: string): Illustration[] {
    return this.#db
      .prepare<[string], { id: number; messageId: number }>(
        `SELECT illustrations.id, illustrations.message_id AS messageId
         FROM illustrations JOIN messages ON messages.id = illustrations.message_id
         WHERE messages.chat_id = ? ORDER BY illustrations.id`,
      )
      .all(chatId)
      .map(({ id, messageId }) => ({
        id,
        messageId,
        imageUrl: illustrationUrl(chatId, id),
      }));
  }

  /** The name of an illustration's file, if the chat has that illustration. */
  illustrationFile(chatId: string, id: number): string | undefined {
    return this.#db
      .prepare<[number, string], { file: string }>(
        `SELECT illustrations.image_file AS file
         FROM illustrations JOIN messages ON messages.id = illustrations.message_id
         WHERE illustrations.id = ? AND messages.chat_id = ?`,
      )
      .get(id, chatId)?.file;
  }

  /** Every file the chats' pictures are kept in. */
  files(): Set<string> {
    const rows = this.#db
      .prepare<[], { file: string }>(
        `SELECT image_file AS file FROM illustrations
         UNION SELECT image_file FROM locations WHERE image_file IS NOT NULL`,
      )
      .all();
    return new Set(rows.map(({ file }) => file));
  }
}
