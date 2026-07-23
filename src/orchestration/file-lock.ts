import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_STALE_MS = 10_000;
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

  let acquired = false;
  try {
    await acquireFilesystemLock(input.lockPath, input.staleMs ?? DEFAULT_STALE_MS);
    acquired = true;
    return await input.operation();
  } finally {
    if (acquired) {
      await rm(input.lockPath, { recursive: true, force: true });
    }
    releaseQueue();
    if (inProcessLocks.get(input.lockPath) === current) {
      inProcessLocks.delete(input.lockPath);
    }
  }
}

async function acquireFilesystemLock(
  lockPath: string,
  staleMs: number,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
    return;
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
      await mkdir(lockPath);
      return;
    }
    throw error;
  }
  if (Date.now() - modifiedAt <= staleMs) {
    throw new Error(`File lock is busy: ${lockPath}`);
  }

  await rm(lockPath, { recursive: true, force: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`File lock is busy: ${lockPath}`);
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
