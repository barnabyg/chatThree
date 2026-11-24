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

const fromRow = ({ imageFile, ...row }: LocationRow): StoredLocation => ({
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
      .map(fromRow);
  }

  /** One of the chat's places, if it has one with `id`. */
  location(chatId: string, id: number): StoredLocation | undefined {
    const row = this.#db
      .prepare<[string, number], LocationRow>(
        `${LOCATION} WHERE chat_id = ? AND id = ?`,
      )
      .get(chatId, id);
    return row === undefined ? undefined : fromRow(row);
  }

  /**
   * Where the chat's story is now: where the newest message that moved it
   * took it, or else where it began. A chat that has not recorded where it
   * began has `start` recorded as its first place.
   */
  currentLocation(
    chatId: string,
    start: { name: string; description: string },
  ): StoredLocation {
    return this.#db.transaction(() => {
      const row = this.#db
        .prepare<[string, string], LocationRow>(
          `${LOCATION} WHERE id = COALESCE(
             (SELECT location_id FROM messages
              WHERE chat_id = ? AND location_id IS NOT NULL
              ORDER BY id DESC LIMIT 1),
             (SELECT location_id FROM chats WHERE id = ?))`,
        )
        .get(chatId, chatId);
      if (row !== undefined) return fromRow(row);
      const first = this.addLocation(chatId, start);
      this.#db
        .prepare('UPDATE chats SET location_id = ? WHERE id = ?')
        .run(first.id, chatId);
      return first;
    })();
  }

  /** Add a place to the chat's story. It is not where the story is until a message moves there. */
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

  /**
   * Record that the chat's message `messageId` took its story to
   * `locationId`, one of its places. Deleting the message undoes the move.
   */
  moveTo(chatId: string, messageId: number, locationId: number): void {
    this.#db
      .prepare(
        `UPDATE messages SET location_id = ?
         WHERE id = ? AND chat_id = ?
           AND EXISTS (SELECT 1 FROM locations WHERE id = ? AND chat_id = ?)`,
      )
      .run(locationId, messageId, chatId, locationId, chatId);
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

  /** Record that a picture has just been asked for in the chat. */
  markIllustrated(chatId: string): void {
    this.#db
      .prepare(
        `UPDATE chats SET illustrated_through =
           (SELECT COALESCE(MAX(id), 0) FROM messages WHERE chat_id = ?)
         WHERE id = ?`,
      )
      .run(chatId, chatId);
  }

  /**
   * How many of the character's messages have been added since a picture
   * was last asked for in the chat, or `undefined` if none ever was.
   */
  repliesSinceIllustration(chatId: string): number | undefined {
    const row = this.#db
      .prepare<[string], { mark: number | null; replies: number }>(
        `SELECT illustrated_through AS mark,
           (SELECT COUNT(*) FROM messages
            WHERE messages.chat_id = chats.id AND messages.role = 'assistant'
              AND messages.id > COALESCE(chats.illustrated_through, 0)) AS replies
         FROM chats WHERE id = ?`,
      )
      .get(chatId);
    return row?.mark === null || row === undefined ? undefined : row.replies;
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
