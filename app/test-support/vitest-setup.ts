// Runs in every unit test file before the file's own code.

import { afterAll } from 'vitest';
import { removeTemporaryDirectories } from './temporary.ts';

// Hooks that run after tests run in reverse order of registration. This one
// is registered first, so it runs last: after the file's own hooks have
// closed the databases and stopped the processes that used the directories.
afterAll(removeTemporaryDirectories);
