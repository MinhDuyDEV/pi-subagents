import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_STALE_MS = 10_000;
const DEFAULT_WAIT_MS = 5_000;
const inProcessLocks = new Map<string, Promise<void>>();

export async function withFileLock<T>(input: {
  lockPath: string;
  operation: () => Promise<T>;
  staleMs?: number;
}): Promise<T> {
  const previous = inProcessLocks.get(input.lockPath) ?? Promise.resolve();
  let releaseQueue: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const current = previous.then(() => gate);
  inProcessLocks.set(input.lockPath, current);
  await previous;

  let owner: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS;
  try {
    owner = await acquireFilesystemLockWithRetry(input.lockPath, staleMs);
    heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(input.lockPath, now, now).catch(() => undefined);
    }, Math.max(100, Math.floor(staleMs / 3)));
    heartbeat.unref();
    return await input.operation();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (owner && (await lockIsOwnedBy(input.lockPath, owner))) {
      await rm(input.lockPath, { recursive: true, force: true });
    }
    releaseQueue();
    if (inProcessLocks.get(input.lockPath) === current) {
      inProcessLocks.delete(input.lockPath);
    }
  }
}

async function acquireFilesystemLockWithRetry(
  lockPath: string,
  staleMs: number,
): Promise<string> {
  const deadline = Date.now() + DEFAULT_WAIT_MS;
  while (true) {
    try {
      return await acquireFilesystemLock(lockPath, staleMs);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("File lock is busy:") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    }
  }
}

export async function acquireFilesystemLock(
  lockPath: string,
  staleMs: number,
): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true });
  const owner = randomUUID();
  try {
    await createOwnedLock(lockPath, owner);
    return owner;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  let modifiedAt: number;
  try {
    modifiedAt = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await createOwnedLock(lockPath, owner);
      return owner;
    }
    throw error;
  }
  if (
    Date.now() - modifiedAt <= staleMs ||
    (await lockOwnerProcessIsAlive(lockPath))
  ) {
    throw new Error(`File lock is busy: ${lockPath}`);
  }

  // Re-stat before stealing so an active owner's heartbeat cannot be erased
  // based on a stale observation.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const currentModifiedAt = await stat(lockPath)
    .then((value) => value.mtimeMs)
    .catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
  if (
    currentModifiedAt !== undefined &&
    (currentModifiedAt !== modifiedAt || Date.now() - currentModifiedAt <= staleMs)
  ) {
    throw new Error(`File lock is busy: ${lockPath}`);
  }

  await rm(lockPath, { recursive: true, force: true });
  try {
    await createOwnedLock(lockPath, owner);
    return owner;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`File lock is busy: ${lockPath}`);
    }
    throw error;
  }
}

async function createOwnedLock(lockPath: string, owner: string): Promise<void> {
  await mkdir(lockPath);
  try {
    await writeFile(
      join(lockPath, "owner"),
      `${JSON.stringify({ owner, pid: process.pid })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
}

async function lockIsOwnedBy(lockPath: string, owner: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(lockPath, "owner"), "utf8"),
    );
    return isRecord(value) && value.owner === owner;
  } catch {
    return false;
  }
}

async function lockOwnerProcessIsAlive(lockPath: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(lockPath, "owner"), "utf8"),
    );
    if (!isRecord(value) || typeof value.pid !== "number") return false;
    process.kill(value.pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") return true;
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
