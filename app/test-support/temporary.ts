// Temporary directories for unit tests. Every directory made here is removed
// when the test file that made it has finished (see vitest-setup.ts), so a
// test run leaves nothing behind in the system's temporary folder.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** A new, empty directory of the caller's own. `name` says what it is for. */
export function temporaryDirectory(name: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), `chatthree-${name}-`));
  created.push(directory);
  return directory;
}

/**
 * Remove every directory `temporaryDirectory` has made. Anything still using
 * one (an open database, a running process) must be closed or stopped first:
 * on Windows a file in use cannot be removed, and this then throws.
 */
export function removeTemporaryDirectories(): void {
  for (const directory of created.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      // A process that has just been ended can hold its files a moment longer.
      maxRetries: 10,
      retryDelay: 50,
    });
  }
}
