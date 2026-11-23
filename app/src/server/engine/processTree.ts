// Ending a process together with everything it started.
//
// The engine is started through a launcher (`uv run`), which starts Python.
// Killing only the launcher leaves Python running and holding the GPU, so the
// app always ends the whole tree.

import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const COMMAND_TIMEOUT_MS = 20_000;
const GRACE_MS = 5_000;

/** How a tree must be spawned for `killTree` to reach all of it. */
export const TREE_SPAWN_OPTIONS = {
  // POSIX: the process leads its own group, so the group can be signalled.
  // Windows finds the tree by parent process IDs and needs nothing here.
  detached: process.platform !== 'win32',
  windowsHide: true,
} as const;

function groupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killGroup(pid: number, graceMs: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // The group has already gone.
  }
  const deadline = Date.now() + graceMs;
  while (groupIsAlive(pid) && Date.now() < deadline) await delay(50);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // It ended within the grace period.
  }
}

/** End the process `pid` and every process descended from it. */
export async function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    await killGroup(pid, GRACE_MS);
    return;
  }
  try {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // taskkill fails when the process has already exited, which is the goal.
  }
}

// Windows keeps no link from a dead process to its children except the parent
// ID each child recorded. A recorded ID only counts if the child was created
// after the root was started: before that, the ID belonged to something else.
const KILL_ORPHANS_SCRIPT = `
$since = [DateTimeOffset]::FromUnixTimeMilliseconds($env:CHATTHREE_SINCE_MS).LocalDateTime
$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate
$parents = @([int]$env:CHATTHREE_ROOT_PID)
while ($parents.Count -gt 0) {
  $children = @($all | Where-Object { $parents -contains $_.ParentProcessId -and $_.CreationDate -ge $since })
  $children | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $parents = @($children | ForEach-Object { [int]$_.ProcessId })
}
`;

/**
 * End every process descended from `rootPid` after the root itself has died.
 * `startedAt` is when the root was started.
 */
export async function killOrphans(
  rootPid: number,
  startedAt: Date,
): Promise<void> {
  if (process.platform !== 'win32') {
    // The process group outlives its leader.
    await killGroup(rootPid, 0);
    return;
  }
  try {
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', KILL_ORPHANS_SCRIPT],
      {
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          CHATTHREE_ROOT_PID: String(rootPid),
          CHATTHREE_SINCE_MS: String(startedAt.getTime()),
        },
      },
    );
  } catch {
    // Best effort: there is nothing further to try, and the caller is already
    // reporting the engine as failed.
  }
}
