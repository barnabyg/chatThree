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
}

const SELECT = `
  SELECT
    chats.id,
    chats.updated_at AS lastActivityAt,
    characters.id AS characterId,
    characters.name AS characterName
  FROM chats
  JOIN characters ON characters.id = chats.character_id`;

function toSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    character: { id: row.characterId, name: row.characterName },
    lastActivityAt: row.lastActivityAt,
  };
}

/** Chats and their messages, saved in the database. */
export class ChatStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Start a chat with the character `characterId`, which must exist. */
  create(characterId: string): ChatSummary {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO chats (id, character_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, characterId, now, now);
    const created = this.find(id);
    if (created === undefined) throw new Error('The new chat was not saved.');
    return created;
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
