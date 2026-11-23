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

/** Chats and their messages, saved in the database. */
export class ChatStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(): ChatSummary {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO chats (id, created_at, updated_at) VALUES (?, ?, ?)',
      )
      .run(id, now, now);
    return { id, lastActivityAt: now };
  }

  /** Every chat, the most recently active first. */
  list(): ChatSummary[] {
    return this.#db
      .prepare<[], ChatSummary>(
        'SELECT id, updated_at AS lastActivityAt FROM chats ORDER BY updated_at DESC, rowid DESC',
      )
      .all();
  }

  find(id: string): ChatSummary | undefined {
    return this.#db
      .prepare<[string], ChatSummary>(
        'SELECT id, updated_at AS lastActivityAt FROM chats WHERE id = ?',
      )
      .get(id);
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
