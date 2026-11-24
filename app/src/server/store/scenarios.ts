import { randomUUID } from 'node:crypto';
import type { Scenario, ScenarioInput } from '../../shared/api.ts';
import type { Db } from './database.ts';

interface ScenarioRow {
  id: string;
  title: string;
  premise: string;
  user_name: string;
  user_description: string;
  opening_message: string;
  location_name: string;
  location_description: string;
  chatCount: number;
}

const SELECT = `
  SELECT
    scenarios.*,
    (SELECT COUNT(*) FROM chats WHERE chats.scenario_id = scenarios.id) AS chatCount
  FROM scenarios`;

function toScenario(row: ScenarioRow): Scenario {
  return {
    id: row.id,
    title: row.title,
    premise: row.premise,
    userPersona: { name: row.user_name, description: row.user_description },
    openingMessage: row.opening_message,
    startingLocation: {
      name: row.location_name,
      description: row.location_description,
    },
    chatCount: row.chatCount,
  };
}

/** The columns of `input`, in the order the statements below name them. */
function columns(input: ScenarioInput): string[] {
  return [
    input.title,
    input.premise,
    input.userPersona.name,
    input.userPersona.description,
    input.openingMessage,
    input.startingLocation.name,
    input.startingLocation.description,
  ];
}

/** The user's scenarios, saved in the database. */
export class ScenarioStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Every scenario, by title. */
  list(): Scenario[] {
    return this.#db
      .prepare<[], ScenarioRow>(
        `${SELECT} ORDER BY title COLLATE NOCASE, rowid`,
      )
      .all()
      .map(toScenario);
  }

  find(id: string): Scenario | undefined {
    const row = this.#db
      .prepare<[string], ScenarioRow>(`${SELECT} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : toScenario(row);
  }

  create(input: ScenarioInput): Scenario {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO scenarios
           (title, premise, user_name, user_description, opening_message,
            location_name, location_description, id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...columns(input), id, now, now);
    return { ...input, id, chatCount: 0 };
  }

  /** Returns the updated scenario, or `undefined` if there is none with `id`. */
  update(id: string, input: ScenarioInput): Scenario | undefined {
    this.#db
      .prepare(
        `UPDATE scenarios
         SET title = ?, premise = ?, user_name = ?, user_description = ?,
             opening_message = ?, location_name = ?, location_description = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(...columns(input), new Date().toISOString(), id);
    return this.find(id);
  }

  /**
   * Delete a scenario and, with it, every chat set in that scenario.
   * Returns false if there is no scenario with `id`.
   */
  delete(id: string): boolean {
    return (
      this.#db.prepare('DELETE FROM scenarios WHERE id = ?').run(id).changes > 0
    );
  }
}
