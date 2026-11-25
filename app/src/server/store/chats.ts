import { randomUUID } from 'node:crypto';
import type { ChatSummary, Message } from '../../shared/api.ts';
import type { Db } from './database.ts';

interface MessageRow {
  id: number;
  role: Message['role'];
  content: string;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

interface ChatRow {
  id: string;
  lastActivityAt: string;
  characterId: string;
  characterName: string;
  scenarioId: string;
  scenarioTitle: string;
  playerId: string | null;
  playerName: string | null;
}

const SELECT = `
  SELECT
    chats.id,
    chats.updated_at AS lastActivityAt,
    characters.id AS characterId,
    characters.name AS characterName,
    scenarios.id AS scenarioId,
    scenarios.title AS scenarioTitle,
    players.id AS playerId,
    players.name AS playerName
  FROM chats
  JOIN characters ON characters.id = chats.character_id
  JOIN scenarios ON scenarios.id = chats.scenario_id
  LEFT JOIN players ON players.id = chats.player_id`;

function toSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    character: { id: row.characterId, name: row.characterName },
    scenario: { id: row.scenarioId, title: row.scenarioTitle },
    player:
      row.playerId === null
        ? null
        : { id: row.playerId, name: row.playerName ?? '' },
    lastActivityAt: row.lastActivityAt,
  };
}

/** Chats and their messages, saved in the database. */
export class ChatStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Start a chat that pairs a character with a scenario, played as
   * `playerId` or as no one; each given must exist. `openingMessage`, unless
   * blank, becomes the character's first message.
   */
  create(
    characterId: string,
    scenarioId: string,
    openingMessage = '',
    playerId: string | null = null,
  ): ChatSummary {
    const id = randomUUID();
    const now = new Date().toISOString();
    return this.#db.transaction(() => {
      this.#db
        .prepare(
          'INSERT INTO chats (id, character_id, scenario_id, player_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, characterId, scenarioId, playerId, now, now);
      if (openingMessage.trim() !== '') {
        this.addMessage(id, 'assistant', openingMessage);
      }
      const created = this.find(id);
      if (created === undefined) throw new Error('The new chat was not saved.');
      return created;
    })();
  }

  /** Delete a chat and its messages. Returns false if there is no such chat. */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0
    );
  }

  /** Every chat, the most recently active first. */
  list(): ChatSummary[] {
    return this.#db
      .prepare<[], ChatRow>(
        `${SELECT} ORDER BY chats.updated_at DESC, chats.rowid DESC`,
      )
      .all()
      .map(toSummary);
  }

  find(id: string): ChatSummary | undefined {
    const row = this.#db
      .prepare<[string], ChatRow>(`${SELECT} WHERE chats.id = ?`)
      .get(id);
    return row === undefined ? undefined : toSummary(row);
  }

  /** The chat's whole conversation, oldest first. */
  messages(chatId: string): Message[] {
    return this.#db
      .prepare<[string], MessageRow>(
        'SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id',
      )
      .all(chatId)
      .map(toMessage);
  }

  addMessage(chatId: string, role: Message['role'], content: string): Message {
    const now = new Date().toISOString();
    return this.#db.transaction(() => {
      const { lastInsertRowid } = this.#db
        .prepare(
          'INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(chatId, role, content, now);
      this.#db
        .prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
        .run(now, chatId);
      return { id: Number(lastInsertRowid), role, content, createdAt: now };
    })();
  }

  /** Remove the chat's last message. Returns it, or `undefined` in an empty chat. */
  deleteLastMessage(chatId: string): Message | undefined {
    const last = this.messages(chatId).at(-1);
    if (last !== undefined) {
      this.#db.prepare('DELETE FROM messages WHERE id = ?').run(last.id);
    }
    return last;
  }

  /** Put a new reply in place of `old`, in one step. */
  replaceMessage(chatId: string, old: Message, content: string): Message {
    return this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM messages WHERE id = ?').run(old.id);
      return this.addMessage(chatId, old.role, content);
    })();
  }
}
