import { randomUUID } from 'node:crypto';
import type { ReplyPrompt, ReplyPromptInput } from '../../shared/api.ts';
import type { Db } from './database.ts';

interface ReplyPromptRow {
  id: string;
  name: string;
  prompt: string;
  chatCount: number;
}

const SELECT = `
  SELECT
    reply_prompts.id,
    reply_prompts.name,
    reply_prompts.prompt,
    (SELECT COUNT(*) FROM chats
      WHERE chats.reply_prompt_id = reply_prompts.id) AS chatCount
  FROM reply_prompts`;

function toReplyPrompt(row: ReplyPromptRow): ReplyPrompt {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    chatCount: row.chatCount,
  };
}

/** The user's own reply prompts, saved in the database. */
export class ReplyPromptStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every reply prompt, by name. */
  list(): ReplyPrompt[] {
    return this.#db
      .prepare<[], ReplyPromptRow>(
        `${SELECT} ORDER BY reply_prompts.name COLLATE NOCASE, reply_prompts.rowid`,
      )
      .all()
      .map(toReplyPrompt);
  }

  find(id: string): ReplyPrompt | undefined {
    const row = this.#db
      .prepare<[string], ReplyPromptRow>(`${SELECT} WHERE reply_prompts.id = ?`)
      .get(id);
    return row === undefined ? undefined : toReplyPrompt(row);
  }

  create(input: ReplyPromptInput): ReplyPrompt {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO reply_prompts (id, name, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, input.name, input.prompt, now, now);
    return { ...input, id, chatCount: 0 };
  }

  /** Returns the updated reply prompt, or `undefined` if there is none with `id`. */
  update(id: string, input: ReplyPromptInput): ReplyPrompt | undefined {
    this.#db
      .prepare(
        'UPDATE reply_prompts SET name = ?, prompt = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.name, input.prompt, new Date().toISOString(), id);
    return this.find(id);
  }

  /**
   * Delete a reply prompt. The chats that used it use the default from now
   * on. Returns false if there is no reply prompt with `id`.
   */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM reply_prompts WHERE id = ?').run(id)
        .changes > 0
    );
  }
}
