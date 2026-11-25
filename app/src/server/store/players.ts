import { randomUUID } from 'node:crypto';
import type { Player, PlayerInput } from '../../shared/api.ts';
import type { Db } from './database.ts';

interface PlayerRow {
  id: string;
  name: string;
  background: string;
  chatCount: number;
}

const SELECT = `
  SELECT
    players.id,
    players.name,
    players.background,
    (SELECT COUNT(*) FROM chats WHERE chats.player_id = players.id) AS chatCount
  FROM players`;

function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    name: row.name,
    background: row.background,
    chatCount: row.chatCount,
  };
}

/** The people the user can play, saved in the database. */
export class PlayerStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every player, by name. */
  list(): Player[] {
    return this.#db
      .prepare<[], PlayerRow>(
        `${SELECT} ORDER BY players.name COLLATE NOCASE, players.rowid`,
      )
      .all()
      .map(toPlayer);
  }

  find(id: string): Player | undefined {
    const row = this.#db
      .prepare<[string], PlayerRow>(`${SELECT} WHERE players.id = ?`)
      .get(id);
    return row === undefined ? undefined : toPlayer(row);
  }

  create(input: PlayerInput): Player {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO players (id, name, background, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, input.background, now, now);
    return { ...input, id, chatCount: 0 };
  }

  /** Returns the updated player, or `undefined` if there is none with `id`. */
  update(id: string, input: PlayerInput): Player | undefined {
    this.#db
      .prepare(
        'UPDATE players SET name = ?, background = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.name, input.background, new Date().toISOString(), id);
    return this.find(id);
  }

  /**
   * Delete a player and, with it, every chat played as them.
   * Returns false if there is no player with `id`.
   */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM players WHERE id = ?').run(id).changes > 0
    );
  }
}
