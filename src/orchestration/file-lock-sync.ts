/**
 * Synchronous twin of {@link ./file-lock.js}, speaking the SAME on-disk
 * protocol: a lock directory containing an `owner` file with `{owner, pid}`.
 *
 * Two protocols on one file is not locking. `task-state.ts` writes
 * `task-registry.json` and `task-session-history.json` asynchronously while
 * `conversation.ts` writes the same two files synchronously, so a lock that
 * only one of them could take would leave them free to clobber each other. The
 * async lock cannot be awaited from `conversation.ts` — its whole call graph is
 * synchronous, up through the tool handlers — so the protocol is implemented
 * twice rather than the file being guarded once. Both implementations must keep
 * agreeing about the directory name, the owner file, and staleness, or the
 * guarantee quietly evaporates; the shared constants below are the seam.
 */
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Shared with the async lock. A lock older than this with a dead owner is stealable. */
export const LOCK_STALE_MS = 10_000;
/** Shared with the async lock. How long to spin before giving up. */
export const LOCK_WAIT_MS = 5_000;

export function withFileLockSync<T>(input: {
  lockPath: string;
  operation: () => T;
  staleMs?: number;
}): T {
  const staleMs = input.staleMs ?? LOCK_STALE_MS;
  const owner = acquireFilesystemLockSyncWithRetry(input.lockPath, staleMs);
  try {
    return input.operation();
  } finally {
    if (lockIsOwnedBySync(input.lockPath, owner)) {
      rmSync(input.lockPath, { recursive: true, force: true });
    }
  }
}

function acquireFilesystemLockSyncWithRetry(
  lockPath: string,
  staleMs: number,
): string {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      return acquireFilesystemLockSync(lockPath, staleMs);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("File lock is busy:") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      // There is no sync sleep in Node that does not burn a core; a short busy
      // wait is acceptable here because these writes are small and rare, and
      // the alternative is making the whole registry API async.
      sleepSync(25 + Math.random() * 25);
    }
  }
}

function acquireFilesystemLockSync(lockPath: string, staleMs: number): string {
  mkdirSync(dirname(lockPath), { recursive: true });
  const owner = randomUUID();
  try {
    createOwnedLockSync(lockPath, owner);
    return owner;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  let modifiedAt: number;
  try {
    modifiedAt = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      createOwnedLockSync(lockPath, owner);
      return owner;
    }
    throw error;
  }
  if (
    Date.now() - modifiedAt <= staleMs ||
    lockOwnerProcessIsAliveSync(lockPath)
  ) {
    throw new Error(`File lock is busy: ${lockPath}`);
  }

  // Re-stat before stealing so an active owner's heartbeat cannot be erased on
  // the strength of a stale observation.
  sleepSync(25);
  let currentModifiedAt: number | undefined;
  try {
    currentModifiedAt = statSync(lockPath).mtimeMs;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  if (
    currentModifiedAt !== undefined &&
    (currentModifiedAt !== modifiedAt || Date.now() - currentModifiedAt <= staleMs)
  ) {
    throw new Error(`File lock is busy: ${lockPath}`);
  }

  rmSync(lockPath, { recursive: true, force: true });
  try {
    createOwnedLockSync(lockPath, owner);
    return owner;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`File lock is busy: ${lockPath}`);
    }
    throw error;
  }
}

/** Refresh the lock's mtime so a long operation is not mistaken for a stale lock. */
export function touchLockSync(lockPath: string): void {
  const now = new Date();
  try {
    utimesSync(lockPath, now, now);
  } catch {
    // The lock is gone or unreadable; the release path handles that.
  }
}

function createOwnedLockSync(lockPath: string, owner: string): void {
  mkdirSync(lockPath);
  try {
    writeFileSync(
      join(lockPath, "owner"),
      `${JSON.stringify({ owner, pid: process.pid })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function lockIsOwnedBySync(lockPath: string, owner: string): boolean {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(lockPath, "owner"), "utf8"),
    );
    return isRecord(value) && value.owner === owner;
  } catch {
    return false;
  }
}

function lockOwnerProcessIsAliveSync(lockPath: string): boolean {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(lockPath, "owner"), "utf8"),
    );
    if (!isRecord(value) || typeof value.pid !== "number") return false;
    process.kill(value.pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") return true;
    return false;
  }
}

function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Intentionally empty.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
