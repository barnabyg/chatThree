// Files that belong to characters: voice clips and pictures. They live in the
// app's data directory, beside the database and outside the repository. The
// database keeps each file's name; this store turns a name into a path.
//
// A file is never rewritten. Replacing one saves a new file under a new
// name: the engine remembers a voice by its clip's path, and the browser
// caches a picture by its address.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type MediaFolder = 'voices';

export class MediaStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = dataDir;
  }

  /** Save a new file and return its name, such as `voices/<id>.wav`. */
  save(folder: MediaFolder, extension: string, bytes: Uint8Array): string {
    mkdirSync(path.join(this.#root, folder), { recursive: true });
    const name = `${folder}/${randomUUID()}.${extension}`;
    writeFileSync(this.path(name), bytes);
    return name;
  }

  /** Where the file is on this computer, which is how the engine is told of it. */
  path(name: string): string {
    return path.join(this.#root, name);
  }

  /** Delete the file. One that has already gone is not an error. */
  remove(name: string): void {
    rmSync(this.path(name), { force: true });
  }
}
